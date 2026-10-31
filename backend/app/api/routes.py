"""HTTP API for DEEPTRACE (mounted under /api)."""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Callable
from typing import Any, TypeVar

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.ai.analyst import stream_analyst
from app.config import get_settings
from app.models.schemas import (
    AnalystRequest,
    DemoScript,
    HealthStatus,
    InfrastructureNetwork,
    NetworkMetrics,
    NodeDetails,
    PathResult,
    RegionInfo,
    ScenarioComparison,
    ScenarioInput,
    ScenarioPreset,
    SimulationResult,
    TraceResult,
)
from app.networks.loader import load_demo_script, load_presets
from app.simulation import get_engine
from app.simulation.engine import ENGINE_VERSION

router = APIRouter(prefix="/api")

T = TypeVar("T")

# The engine is deterministic and fast, but its caches are not designed for concurrent
# mutation; serialise access (simulations take milliseconds).
_engine_lock = threading.RLock()


def _with_engine(fn: Callable[[Any], T]) -> T:
    with _engine_lock:
        return fn(get_engine())


def _guard(fn: Callable[[], T]) -> T:
    try:
        return fn()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown id: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class CompareRequest(BaseModel):
    scenario_a: ScenarioInput
    scenario_b: ScenarioInput


@router.get("/health", response_model=HealthStatus)
def health() -> HealthStatus:
    s = get_settings()
    net = get_engine().network
    return HealthStatus(
        status="ok",
        version=ENGINE_VERSION,
        network_id=net.id,
        region_id=net.region.id,
        node_count=len(net.nodes),
        edge_count=len(net.edges),
        llm_available=s.llm_available,
        llm_provider=s.llm_provider if s.llm_available else None,
        llm_model=s.llm_model if s.llm_available else None,
    )


@router.get("/region", response_model=RegionInfo)
def region() -> RegionInfo:
    return get_engine().network.region


@router.get("/network", response_model=InfrastructureNetwork)
def network() -> InfrastructureNetwork:
    return get_engine().network


@router.get("/baseline", response_model=SimulationResult)
def baseline() -> SimulationResult:
    return _with_engine(lambda e: e.baseline())


@router.get("/network/metrics", response_model=NetworkMetrics)
def metrics() -> NetworkMetrics:
    return _with_engine(lambda e: e.metrics())


@router.get("/nodes/{node_id}", response_model=NodeDetails)
def node_details(node_id: str) -> NodeDetails:
    return _guard(lambda: _with_engine(lambda e: e.node_details(node_id)))


@router.get("/trace/{node_id}", response_model=TraceResult)
def trace(node_id: str, max_depth: int = Query(8, ge=1, le=30)) -> TraceResult:
    return _guard(lambda: _with_engine(lambda e: e.trace(node_id, max_depth)))


@router.get("/path", response_model=PathResult)
def path(from_node: str, to_node: str) -> PathResult:
    return _guard(lambda: _with_engine(lambda e: e.find_path(from_node, to_node)))


@router.post("/simulate", response_model=SimulationResult)
def simulate(scenario: ScenarioInput) -> SimulationResult:
    if not scenario.failed_nodes and not scenario.failed_edges:
        raise HTTPException(status_code=422, detail="Specify at least one failed node or edge")
    return _guard(lambda: _with_engine(lambda e: e.simulate(scenario)))


@router.post("/compare", response_model=ScenarioComparison)
def compare(req: CompareRequest) -> ScenarioComparison:
    for s in (req.scenario_a, req.scenario_b):
        if not s.failed_nodes and not s.failed_edges:
            raise HTTPException(status_code=422, detail="Each scenario needs at least one failed node or edge")
    return _guard(lambda: _with_engine(lambda e: e.compare(req.scenario_a, req.scenario_b)))


@router.get("/scenarios/presets", response_model=list[ScenarioPreset])
def presets() -> list[ScenarioPreset]:
    return load_presets(get_engine().network.region.id)


@router.get("/demo/script", response_model=DemoScript)
def demo_script() -> DemoScript:
    script = load_demo_script(get_engine().network.region.id)
    if script is None:
        raise HTTPException(status_code=404, detail="No demo script for this region")
    return script


@router.get("/provenance")
def provenance() -> dict[str, Any]:
    net = get_engine().network
    counts: dict[str, dict[str, int]] = {}
    for item in [*net.nodes, *net.edges]:
        system = item.system.value if hasattr(item, "system") else item.infrastructure_type.value
        cat = item.provenance.category.value
        counts.setdefault(system, {}).setdefault(cat, 0)
        counts[system][cat] += 1
    return {
        "datasets": [d.model_dump(mode="json") for d in net.datasets],
        "counts": counts,
        "assumptions": net.assumptions,
    }


async def _sse(events: AsyncIterator[dict[str, Any]]) -> AsyncIterator[bytes]:
    try:
        async for ev in events:
            yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n".encode()
    except asyncio.CancelledError:  # client disconnected
        raise
    except Exception as exc:  # noqa: BLE001 — surface errors to the client instead of a broken stream
        err = {"type": "error", "message": f"Analyst error: {type(exc).__name__}: {exc}"}
        yield f"data: {json.dumps(err)}\n\n".encode()
        yield f"data: {json.dumps({'type': 'done', 'tool_calls': 0, 'mode': 'llm'})}\n\n".encode()


class _LockedEngine:
    """Engine proxy used by the analyst: every call takes the engine lock."""

    def __init__(self, engine: Any) -> None:
        self._engine = engine

    @property
    def network(self) -> InfrastructureNetwork:
        return self._engine.network

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._engine, name)
        if not callable(attr):
            return attr

        def locked(*a: Any, **kw: Any) -> Any:
            with _engine_lock:
                return attr(*a, **kw)

        return locked


@router.post("/analyst/chat")
async def analyst_chat(req: AnalystRequest) -> StreamingResponse:
    engine = _LockedEngine(get_engine())
    return StreamingResponse(
        _sse(stream_analyst(req, engine)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


def warm_up() -> None:
    """Precompute baseline + N-1 metrics so the first interactions are instant."""
    with _engine_lock:
        engine = get_engine()
        engine.baseline()
        engine.metrics()
