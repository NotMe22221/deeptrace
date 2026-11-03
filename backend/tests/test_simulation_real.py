"""Engine against the generated Atlanta dataset (skipped until network.json exists).

Checks that every preset runs cleanly, that results satisfy the contract invariants,
that the baseline is nominal and the performance budget holds (simulate < 250 ms,
metrics < 10 s).
"""

from __future__ import annotations

import time

import pytest

from app.models.schemas import ScenarioInput
from app.networks.loader import load_network, load_presets, network_path

pytestmark = pytest.mark.skipif(not network_path().exists(), reason="network.json not generated")

VOLATILE = {"timestamp", "computation_ms"}


@pytest.fixture(scope="module")
def engine():
    from app.simulation import SimulationEngine

    load_network.cache_clear()
    return SimulationEngine(load_network())


@pytest.fixture(scope="module")
def presets():
    return load_presets()


def test_dataset_has_no_contract_warnings(engine) -> None:
    assert engine.warnings == []


def test_baseline_is_nominal(engine) -> None:
    b = engine.baseline()
    assert b.affected_nodes == [] and b.interrupted_edges == []
    assert set(b.node_states.values()) == {"operational"}
    assert set(b.edge_states.values()) <= {"operational", "normally_open"}
    assert all(f.utilization <= 1.0 + 1e-6 for f in b.edge_flows.values()), "baseline overloads"
    im = b.impact_metrics
    assert im.severity_index == 0 and im.power_load_unserved_mw == 0 and im.water_demand_unserved_lps == 0
    power = next(s for s in im.per_system if s.system == "power")
    assert power.baseline_value > 50


def test_every_preset_runs_fast_and_consistently(engine, presets) -> None:
    assert presets, "scenarios.json has no presets"
    for p in presets:
        engine.simulate(p.scenario)  # warm memo caches of shared systems
        t0 = time.perf_counter()
        r = engine.simulate(p.scenario)
        ms = (time.perf_counter() - t0) * 1000
        assert ms < 250, f"{p.id} took {ms:.0f} ms"
        assert r.scenario_id == p.scenario.scenario_id or r.scenario_id.startswith("scn-")
        assert set(r.node_states) == {n.id for n in engine.network.nodes}
        assert set(r.edge_states) == {e.id for e in engine.network.edges}
        assert r.cascade_steps and r.cascade_steps[0].step == 0
        assert [s.step for s in r.cascade_steps] == list(range(len(r.cascade_steps)))
        by_id = {a.node_id: a for a in r.affected_nodes}
        for nid, st in r.node_states.items():
            if st != "operational":
                assert nid in by_id and by_id[nid].state == st, (p.id, nid, st)
        for a in r.affected_nodes:
            assert a.cause and 0 <= a.service_level <= 1
        assert 0 <= r.impact_metrics.severity_index <= 100
        assert r.summary and r.assumptions
        # deterministic
        again = engine.simulate(p.scenario)
        assert again.model_dump(exclude=VOLATILE) == r.model_dump(exclude=VOLATILE)


def test_cold_simulation_is_fast(presets) -> None:
    from app.simulation import SimulationEngine

    eng = SimulationEngine(load_network())
    for p in presets:
        t0 = time.perf_counter()
        eng.simulate(p.scenario)
        assert (time.perf_counter() - t0) * 1000 < 250, p.id


def test_metrics_within_budget(presets) -> None:
    from app.simulation import SimulationEngine

    eng = SimulationEngine(load_network())
    t0 = time.perf_counter()
    m = eng.metrics()
    assert time.perf_counter() - t0 < 10
    assert len(m.criticality_ranking) > 100
    assert m.cross_system_dependencies > 50
    ranks = [(-e.severity_index, -e.affected_count, e.node_id) for e in m.criticality_ranking]
    assert ranks == sorted(ranks)


def test_corridor_preset_is_common_cause(engine, presets) -> None:
    corridor = [p for p in presets if p.scenario_type == "corridor_strike"]
    if not corridor:
        pytest.skip("no corridor preset")
    r = engine.simulate(corridor[0].scenario)
    hosted = [e for e in r.interrupted_edges if "Common-cause" in e.reason]
    assert len({engine.graphs.edge_sys[e.edge_id] for e in hosted}) >= 2


def test_trace_and_details_on_focus_nodes(engine, presets) -> None:
    for p in presets:
        if p.focus_node_id and p.focus_node_id in engine.graphs.nodes:
            t = engine.trace(p.focus_node_id)
            assert t.summary
            d = engine.node_details(p.focus_node_id)
            assert d.node.id == p.focus_node_id


def test_single_failures_never_crash(engine) -> None:
    """A light N-1 sweep on every node with restoration off and a long horizon."""
    for n in engine.network.nodes:
        r = engine.simulate(ScenarioInput(failed_nodes=[n.id], enable_restoration=False, horizon_hours=24))
        assert r.failed_nodes and r.impact_metrics.total_nodes_affected >= 1
