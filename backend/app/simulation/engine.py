"""Public facade of the DEEPTRACE simulation engine.

Usage::

    engine = SimulationEngine(network)
    result = engine.simulate(ScenarioInput(failed_nodes=["PWR-DS-02"]))
    engine.compare(a, b); engine.trace("PWR-NV-014"); engine.metrics()

Everything except ``SimulationResult.timestamp`` and ``computation_ms`` is
deterministic: identical inputs give identical outputs (all collections are sorted).
"""

from __future__ import annotations

import difflib
import hashlib
import json
import threading
import time
from datetime import datetime, timezone

from app.models.schemas import (
    InfrastructureNetwork,
    NetworkMetrics,
    NodeDetails,
    PathResult,
    ScenarioComparison,
    ScenarioInput,
    SimulationResult,
    TraceResult,
)
from app.simulation.cascade import CascadeEngine
from app.simulation.compare import compare_results
from app.simulation.graph import NetworkGraphs
from app.simulation.metrics import SPOF_AFFECTED_THRESHOLD, MetricsCalculator
from app.simulation.report import Report
from app.simulation.trace import Tracer

ENGINE_VERSION = "1.0.0"
MAX_ID_SUGGESTIONS = 5  # fuzzy "did you mean" suggestions are computed for this many unknown ids only


def scenario_hash(sc: ScenarioInput) -> str:
    """Deterministic id: ``scn-`` + 10 hex chars of SHA-1 over the canonical scenario."""
    canon = json.dumps(
        {
            "failed_nodes": sorted(set(sc.failed_nodes)),
            "failed_edges": sorted(set(sc.failed_edges)),
            "horizon_hours": float(sc.horizon_hours),
            "enable_restoration": bool(sc.enable_restoration),
            "max_cascade_rounds": int(sc.max_cascade_rounds),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return "scn-" + hashlib.sha1(canon.encode()).hexdigest()[:10]


class SimulationEngine:
    def __init__(self, network: InfrastructureNetwork) -> None:
        self.network = network
        self.graphs = NetworkGraphs(network)
        self.cascade = CascadeEngine(self.graphs)
        self.report = Report(self.cascade)
        self.tracer = Tracer(self.cascade)
        self._metrics_calc = MetricsCalculator(self.cascade, self.report)
        self._baseline: SimulationResult | None = None
        self._metrics: NetworkMetrics | None = None
        self._lock = threading.RLock()

    @property
    def warnings(self) -> list[str]:
        """Data-contract problems detected while building the graphs (never fatal)."""
        return list(dict.fromkeys(self.graphs.warnings))

    # ------------------------------------------------------------- validation
    def _unknown(self, ids: list[str], pool: dict, kind: str, other: dict, other_kind: str) -> list[str]:
        """Messages for ids not in ``pool``. Cost stays bounded for huge inputs: membership
        checks are O(1) and the (slow) fuzzy suggestions run for the first few ids only."""
        msgs: list[str] = []
        unknown = wrong_kind = 0
        for x in dict.fromkeys(ids):
            if x in pool:
                continue
            if x in other:
                wrong_kind += 1
                if wrong_kind <= MAX_ID_SUGGESTIONS:
                    msgs.append(f"'{x}' is an {other_kind} id — list it under failed_{other_kind}s")
                continue
            unknown += 1
            if unknown <= MAX_ID_SUGGESTIONS:
                close = difflib.get_close_matches(str(x)[:128], pool.keys(), n=3, cutoff=0.6)
                msgs.append(
                    f"unknown {kind} id '{str(x)[:128]}'" + (f" (did you mean {', '.join(close)}?)" if close else "")
                )
        if unknown > MAX_ID_SUGGESTIONS:
            msgs.append(f"… and {unknown - MAX_ID_SUGGESTIONS} more unknown {kind} ids")
        if wrong_kind > MAX_ID_SUGGESTIONS:
            msgs.append(f"… and {wrong_kind - MAX_ID_SUGGESTIONS} more {other_kind} ids listed as {kind}s")
        return msgs

    def validate_scenario(self, scenario: ScenarioInput) -> None:
        g = self.graphs
        errs = self._unknown(list(scenario.failed_nodes), g.nodes, "node", g.edges, "edge")
        errs += self._unknown(list(scenario.failed_edges), g.edges, "edge", g.nodes, "node")
        # guard against inputs that bypassed pydantic validation (e.g. model_copy)
        if scenario.max_cascade_rounds < 1:
            errs.append("max_cascade_rounds must be at least 1")
        if not 0 <= scenario.horizon_hours <= 168:
            errs.append("horizon_hours must be between 0 and 168")
        if errs:
            raise ValueError(f"Invalid scenario for network {self.network.id}: " + "; ".join(errs))

    def _check_node(self, node_id: str) -> None:
        if node_id not in self.graphs.nodes:
            close = difflib.get_close_matches(node_id, list(self.graphs.nodes), n=3, cutoff=0.6)
            raise ValueError(f"unknown node id '{node_id}'" + (f" (did you mean {', '.join(close)}?)" if close else ""))

    # ------------------------------------------------------------- simulation
    def simulate(self, scenario: ScenarioInput) -> SimulationResult:
        self.validate_scenario(scenario)
        t0 = time.perf_counter()
        with self._lock:
            oc = self.cascade.run(scenario)
            sid = scenario.scenario_id or scenario_hash(scenario)
            result = self.report.build(
                oc,
                scenario_id=sid,
                network_id=self.network.id,
                timestamp=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                engine_version=ENGINE_VERSION,
                computation_ms=0.0,
            )
        result.computation_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        return result

    def baseline(self) -> SimulationResult:
        with self._lock:
            if self._baseline is None:
                self._baseline = self.simulate(ScenarioInput(scenario_id="baseline", name="Baseline"))
            return self._baseline

    def compare(self, a: ScenarioInput, b: ScenarioInput) -> ScenarioComparison:
        return compare_results(self.simulate(a), self.simulate(b))

    def compare_results(self, a: SimulationResult, b: SimulationResult) -> ScenarioComparison:
        return compare_results(a, b)

    # ------------------------------------------------------------- inspection
    def trace(self, node_id: str, max_depth: int = 8) -> TraceResult:
        self._check_node(node_id)
        return self.tracer.trace(node_id, max_depth)

    def metrics(self) -> NetworkMetrics:
        with self._lock:
            if self._metrics is None:
                self._metrics = self._metrics_calc.compute()
            return self._metrics

    def node_details(self, node_id: str) -> NodeDetails:
        self._check_node(node_id)
        g = self.graphs
        tr = self.trace(node_id)
        m = self.metrics()
        rank = score = None
        affected = 0
        for i, entry in enumerate(m.criticality_ranking, start=1):
            if entry.node_id == node_id:
                rank, score, affected = i, float(entry.affected_count), entry.affected_count
                break
        neighbours = sorted({g.other_end(e, node_id) for e in g.incident[node_id]} - {node_id})
        spof = node_id in self._metrics_calc.spof_articulation or affected >= SPOF_AFFECTED_THRESHOLD
        return NodeDetails(
            node=g.nodes[node_id],
            connected_node_ids=neighbours,
            connected_edge_ids=sorted(g.incident[node_id]),
            upstream_ids=[h.node_id for h in tr.upstream],
            downstream_ids=[h.node_id for h in tr.downstream],
            dependency_ids=[h.node_id for h in tr.dependencies],
            dependent_ids=[h.node_id for h in tr.dependents],
            criticality_rank=rank,
            criticality_score=score,
            is_single_point_of_failure=spof,
            baseline_state=self.baseline().node_states.get(node_id, "operational"),
        )

    def find_path(self, from_node: str, to_node: str) -> PathResult:
        self._check_node(from_node)
        self._check_node(to_node)
        return self.tracer.find_path(from_node, to_node)
