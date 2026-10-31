"""Engine facade: determinism, ids, validation, comparison, tracing, details, paths."""

from __future__ import annotations

import re

import pytest

from app.models.schemas import ScenarioInput
from app.simulation import ENGINE_VERSION, SimulationEngine, scenario_hash
from tests.fixtures.mini_network import build_mini_network

VOLATILE = {"timestamp", "computation_ms"}


def test_simulation_is_deterministic(mini_engine: SimulationEngine) -> None:
    sc = ScenarioInput(failed_nodes=["PWR-TS-1", "WTR-J-2"], failed_edges=["TRN-R-2", "UG-DB-1"], horizon_hours=3)
    a = mini_engine.simulate(sc).model_dump(exclude=VOLATILE)
    b = mini_engine.simulate(sc).model_dump(exclude=VOLATILE)
    c = SimulationEngine(build_mini_network()).simulate(sc).model_dump(exclude=VOLATILE)
    assert a == b == c
    # input order does not matter
    sc2 = ScenarioInput(failed_nodes=["WTR-J-2", "PWR-TS-1"], failed_edges=["UG-DB-1", "TRN-R-2"], horizon_hours=3)
    d = mini_engine.simulate(sc2).model_dump(exclude=VOLATILE | {"scenario"})
    a.pop("scenario")
    assert a == d


def test_result_metadata(mini_engine: SimulationEngine) -> None:
    r = mini_engine.simulate(ScenarioInput(failed_nodes=["PWR-DS-A"]))
    assert re.fullmatch(r"scn-[0-9a-f]{10}", r.scenario_id)
    assert r.scenario_id == scenario_hash(ScenarioInput(failed_nodes=["PWR-DS-A"]))
    assert r.scenario_id != scenario_hash(ScenarioInput(failed_nodes=["PWR-DS-A"], horizon_hours=8))
    assert mini_engine.simulate(ScenarioInput(scenario_id="mine", failed_nodes=["PWR-DS-A"])).scenario_id == "mine"
    assert r.engine_version == ENGINE_VERSION == "1.0.0"
    assert r.network_id == "mini-network" and r.timestamp.endswith("Z") and r.computation_ms >= 0
    assert mini_engine.baseline() is mini_engine.baseline()


def test_unknown_ids_raise_helpful_errors(mini_engine: SimulationEngine) -> None:
    with pytest.raises(ValueError, match=r"unknown node id 'PWR-DS-X'.*did you mean"):
        mini_engine.simulate(ScenarioInput(failed_nodes=["PWR-DS-X"]))
    with pytest.raises(ValueError, match="list it under failed_edges"):
        mini_engine.simulate(ScenarioInput(failed_nodes=["PWR-FC-A1"]))
    with pytest.raises(ValueError, match="unknown edge id"):
        mini_engine.validate_scenario(ScenarioInput(failed_edges=["NOPE"]))
    with pytest.raises(ValueError):
        mini_engine.trace("NOPE")


def test_compare(mini_engine: SimulationEngine) -> None:
    a = ScenarioInput(name="Substation", failed_nodes=["PWR-DS-A"], enable_restoration=False)
    b = ScenarioInput(name="Fibre cut", failed_edges=["TEL-FL-3"])
    cmp = mini_engine.compare(a, b)
    keys = [m.key for m in cmp.metrics]
    assert keys[0] == "severity_index" and "redundancy_score" in keys and "alternative_paths" in keys
    assert next(m for m in cmp.metrics if m.key == "alternative_paths").higher_is_worse is False
    sev = cmp.metrics[0]
    assert sev.a > sev.b and sev.worse == "a" and sev.delta == round(sev.b - sev.a, 4)
    red = next(m for m in cmp.metrics if m.key == "redundancy_score")
    assert red.higher_is_worse is False and red.worse == "a"
    assert cmp.verdict.startswith("Scenario A is more severe than Scenario B")
    assert "PWR-NV-A1" in cmp.only_in_a and not cmp.only_in_b and not cmp.in_both
    assert "TEL-AN-1" not in cmp.only_in_b  # rerouted = info severity, excluded
    assert cmp.summary.endswith(cmp.verdict)
    same = mini_engine.compare(a, a)
    assert same.verdict.startswith("Scenarios A") and all(m.worse == "equal" for m in same.metrics)


def test_trace_power_substation(mini_engine: SimulationEngine) -> None:
    t = mini_engine.trace("PWR-DS-A")
    assert [h.node_id for h in t.upstream] == ["PWR-TS-1"]
    assert [h.node_id for h in t.downstream] == ["PWR-SW-A1", "PWR-NV-A1", "PWR-NV-A2", "PWR-NV-A3"]
    dependents = {h.node_id for h in t.dependents}
    assert {"FAC-HOSP-1", "FAC-GOV-1", "TEL-FH-1", "TEL-CS-1", "TRN-ST-1", "TRN-I-2"} <= dependents
    assert all(h.relation == "dependency" for h in t.dependents)
    assert "PWR-TL-1" in t.physical_edge_ids and "PWR-FC-A4" in t.physical_edge_ids
    assert "DEP-HOSP-PWR-A" in t.dependency_edge_ids
    assert t.source_paths[0] == ["PWR-DS-A", "PWR-TS-1"]
    assert "PWR-DS-A" in t.summary and "critical" in t.summary


def test_trace_consumers_and_other_systems(mini_engine: SimulationEngine) -> None:
    hosp = mini_engine.trace("FAC-HOSP-1")
    deps = {h.node_id: h.depth for h in hosp.dependencies}
    assert {"PWR-NV-A1", "PWR-NV-B1", "WTR-SZ-L1", "TEL-AN-1", "TRN-I-2"} <= set(deps)
    assert all(deps[n] == 1 for n in ("PWR-NV-A1", "WTR-SZ-L1"))
    assert hosp.upstream == [] and hosp.downstream == []

    zone = mini_engine.trace("WTR-SZ-H1")
    assert "WTR-PS-1" in [h.node_id for h in zone.upstream]
    assert zone.source_paths and zone.source_paths[0][-1] in ("WTR-SRC-1", "WTR-TNK-1")
    assert "FAC-GOV-1" in [h.node_id for h in zone.dependents]
    pump = mini_engine.trace("WTR-PS-1")
    assert [h.node_id for h in pump.dependencies] == ["PWR-NV-C2", "PWR-DS-C"] or "PWR-NV-C2" in [
        h.node_id for h in pump.dependencies
    ]
    assert "WTR-SZ-H1" in [h.node_id for h in pump.downstream]

    an1 = mini_engine.trace("TEL-AN-1")
    assert [h.node_id for h in an1.upstream] == ["TEL-FH-1", "TEL-CO-1", "TEL-IX-1"]
    fh1 = mini_engine.trace("TEL-FH-1")
    assert {"TEL-AN-1", "TEL-AN-2", "TEL-CS-1"} <= {h.node_id for h in fh1.downstream}
    assert "FAC-HOSP-1" in {h.node_id for h in fh1.dependents}

    i2 = mini_engine.trace("TRN-I-2")
    assert i2.source_paths and i2.source_paths[0][-1] == "TRN-GW-S"
    assert "FAC-HOSP-1" in {h.node_id for h in i2.dependents}

    vault = mini_engine.trace("UG-V-2")
    assert {"PWR-FC-B1", "TEL-FL-2", "TEL-FL-6"} <= set(vault.physical_edge_ids)
    assert {"PWR-DS-B", "PWR-NV-B1", "TEL-CO-1"} <= {h.node_id for h in vault.dependents}

    tie = mini_engine.trace("PWR-SW-T1")
    assert {h.node_id for h in tie.upstream} == {"PWR-NV-A3", "PWR-NV-B2"}
    assert [h.node_id for h in tie.dependencies] == ["TEL-FH-2"]


def test_node_details_and_paths(mini_engine: SimulationEngine) -> None:
    d = mini_engine.node_details("PWR-DS-A")
    assert d.node.id == "PWR-DS-A" and d.baseline_state == "operational"
    assert d.connected_node_ids == ["PWR-SW-A1", "PWR-TS-1"]
    assert d.upstream_ids == ["PWR-TS-1"] and "PWR-NV-A3" in d.downstream_ids
    assert isinstance(d.criticality_rank, int) and d.criticality_score and d.criticality_score >= 5
    assert d.is_single_point_of_failure
    leaf = mini_engine.node_details("TEL-AN-2")
    assert leaf.dependent_ids == ["FAC-GOV-1"]

    p = mini_engine.find_path("FAC-HOSP-1", "PWR-TS-1")
    assert p.found and p.node_ids[0] == "FAC-HOSP-1" and p.node_ids[-1] == "PWR-TS-1"
    assert len(p.edge_ids) == len(p.node_ids) - 1 and p.length_m > 0
    assert p.systems[0] == "facility" and "power" in p.systems and "dependency link" in p.description
    p2 = mini_engine.find_path("TRN-GW-N", "TRN-GW-S")
    assert p2.found and set(p2.systems) == {"transport"}


def test_get_engine_and_reset() -> None:
    from app.networks.loader import network_path
    from app.simulation import get_engine, reset_engine

    if not network_path().exists():
        pytest.skip("network.json not generated")
    reset_engine()
    e1 = get_engine()
    assert get_engine() is e1
    reset_engine()
    assert get_engine() is not e1
