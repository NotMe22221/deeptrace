"""HTTP API for DEEPTRACE (mounted under /api)."""

from __future__ import annotations

import asyncio
import collections
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


SSE_HEARTBEAT_S = 15.0
_STREAM_END = object()


def _sse_data(ev: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n".encode()


def _is_snapshot(item: Any) -> bool:
    """`message` events carry the whole answer so far (each one replaces the previous one)."""
    return isinstance(item, dict) and item.get("type") == "message"


async def _sse(events: AsyncIterator[dict[str, Any]], heartbeat_s: float = SSE_HEARTBEAT_S) -> AsyncIterator[bytes]:
    """Serialise analyst events as SSE, with a `: ping` comment whenever nothing was sent for
    `heartbeat_s` (e.g. while the model is thinking) so clients and proxies can tell a slow answer
    from a stalled connection.

    The event generator runs in a single pump task, so async context managers inside it (the
    Anthropic stream) are entered and exited in the same task. The pump awaits nothing but the
    generator, so a cancel (client gone) always lands inside it and closes it there. A `message`
    snapshot the client has not taken yet is replaced by the next one instead of queued, so a client
    that stops reading costs one snapshot of memory (plus the tool events, bounded by the tool
    rounds), not every snapshot of the run."""
    pending: collections.deque[Any] = collections.deque()
    ready = asyncio.Event()

    def push(item: Any) -> None:
        if _is_snapshot(item) and pending and _is_snapshot(pending[-1]):
            pending[-1] = item
        else:
            pending.append(item)
        ready.set()

    async def pump() -> None:
        try:
            async for ev in events:
                push(ev)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — surfaced to the client below
            push(exc)
        finally:
            push(_STREAM_END)

    task = asyncio.create_task(pump())
    try:
        while True:
            if not pending:
                ready.clear()
                try:
                    await asyncio.wait_for(ready.wait(), timeout=heartbeat_s)
                except asyncio.TimeoutError:
                    yield b": ping\n\n"
                    continue
            item = pending.popleft()
            if item is _STREAM_END:
                break
            if isinstance(item, Exception):
                yield _sse_data({"type": "error", "message": f"Analyst error: {type(item).__name__}: {item}"})
                yield _sse_data({"type": "done", "tool_calls": 0, "mode": "llm"})
                break
            yield _sse_data(item)
    finally:  # client disconnected or stream finished: stop the producer
        if not task.done():
            task.cancel()
        task.add_done_callback(lambda t: t.cancelled() or t.exception())


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
