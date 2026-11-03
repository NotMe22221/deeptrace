"""Cross-system cascade behaviour: common-cause failures, dependency rounds, facilities."""

from __future__ import annotations

from app.models.schemas import ScenarioInput, SimulationResult
from app.simulation import SimulationEngine
from tests.fixtures.mini_network import node


def run(engine: SimulationEngine, **kw) -> SimulationResult:
    return engine.simulate(ScenarioInput(**kw))


def aff(r: SimulationResult, nid: str):
    found = [a for a in r.affected_nodes if a.node_id == nid]
    assert found, f"{nid} not affected; affected = {[a.node_id for a in r.affected_nodes]}"
    return found[0]


def test_corridor_strike_is_common_cause_for_power_and_fibre(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, name="Duct bank strike", scenario_type="corridor_strike", failed_edges=["UG-DB-1"])
    assert set(r.failed_edges) == {"UG-DB-1", "PWR-FC-B1", "TEL-FL-2"}
    reasons = {e.edge_id: e for e in r.interrupted_edges}
    for hosted in ("PWR-FC-B1", "TEL-FL-2"):
        assert reasons[hosted].state == "failed" and reasons[hosted].step == 0
        assert "Common-cause" in reasons[hosted].reason and "UG-DB-1" in reasons[hosted].reason
    step0 = r.cascade_steps[0]
    assert step0.step == 0 and set(step0.systems) >= {"power", "telecom", "underground"}
    assert "PWR-FC-B1" in step0.description and "TEL-FL-2" in step0.description
    # power is restored through a tie, fibre traffic reroutes — both name the corridor
    b1 = aff(r, "PWR-NV-B1")
    assert b1.state == "restored" and "corridor UG-DB-1" in b1.cause
    an1 = aff(r, "TEL-AN-1")
    assert "corridor UG-DB-1" in an1.cause
    assert "common-cause" in r.summary


def test_utility_vault_failure_fails_every_routed_edge(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["UG-V-2"])
    assert {"PWR-FC-B1", "TEL-FL-2", "TEL-FL-6"} <= set(r.failed_edges)
    assert aff(r, "UG-V-2").state == "failed" and "3 edges" in aff(r, "UG-V-2").cause
    for n in ("TEL-AN-1", "TEL-AN-2", "TEL-CS-1"):
        a = aff(r, n)
        assert a.state == "disconnected" and "utility vault UG-V-2" in a.cause
    # the hospital keeps power and water but loses its telecom link
    hosp = aff(r, "FAC-HOSP-1")
    assert hosp.state == "degraded" and "TEL-AN-1" in hosp.caused_by


def test_dependency_chain_over_several_rounds(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, name="DS Charlie loss", failed_nodes=["PWR-DS-C"], enable_restoration=False, horizon_hours=6)
    assert aff(r, "PWR-NV-C2").step == 1
    ps = aff(r, "WTR-PS-1")
    assert ps.step == 2 and ps.state == "outage" and ps.caused_by == ["PWR-NV-C2"]
    zone = aff(r, "WTR-SZ-H1")
    assert zone.step == 2 and zone.state == "outage" and "WTR-PS-1" in zone.caused_by
    gov = aff(r, "FAC-GOV-1")
    assert gov.step == 3 and gov.state == "outage" and gov.severity == "critical"
    assert "WTR-SZ-H1" in gov.cause and gov.caused_by == ["WTR-SZ-H1"]
    steps = r.cascade_steps
    assert [s.step for s in steps] == list(range(len(steps))) and len(steps) == 4
    assert steps[1].label.startswith("Direct impact")
    assert steps[2].label.startswith("Dependency: Booster PS-1 lost power → Water: Zone High 1")
    assert steps[3].label.startswith("Dependency: City Hall lost water supply")
    assert set(steps[2].systems) >= {"water", "facility"}
    assert r.edge_states["DEP-PS1-PWR"] == "interrupted"
    assert r.edge_states["DEP-GOV-WTR"] == "interrupted"
    assert "FAC-GOV-1" in r.impact_metrics.critical_facilities_affected
    assert "3 cascade steps" in r.summary


def test_max_cascade_rounds_truncates(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-DS-C"], enable_restoration=False, horizon_hours=6, max_cascade_rounds=1)
    assert r.node_states["WTR-SZ-H1"] == "operational"  # second hop never evaluated
    assert any("truncated" in a for a in r.assumptions) and "truncated" in r.summary


def test_redundant_power_feed_keeps_facility_supplied(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-NV-A1"], enable_restoration=False)
    hosp = aff(r, "FAC-HOSP-1")
    assert hosp.state == "degraded" and hosp.severity == "minor"
    assert "redundant power feed" in hosp.cause and "still supplied by PWR-NV-B1" in hosp.cause


def test_facility_rides_through_on_backup_until_horizon(mini_network) -> None:
    eng = SimulationEngine(mini_network)
    r = run(eng, failed_nodes=["PWR-NV-A1", "PWR-NV-B1"], enable_restoration=False, horizon_hours=24)
    hosp = aff(r, "FAC-HOSP-1")
    assert hosp.state == "on_backup" and "48.0 h ≥ 24.0 h" in hosp.cause
    r = run(eng, failed_nodes=["PWR-NV-A1", "PWR-NV-B1"], enable_restoration=False, horizon_hours=72)
    hosp = aff(r, "FAC-HOSP-1")
    assert hosp.state == "outage" and hosp.severity == "critical" and "does not cover" in hosp.cause


def test_scada_lost_through_power_dependency(mini_network) -> None:
    """The SCADA hub itself loses power (no battery) → the tie cannot be closed remotely."""
    nets = mini_network
    from app.models.schemas import InfrastructureEdge, Provenance

    nets.edges.append(
        InfrastructureEdge(
            id="DEP-FH2-PWR",
            source_node="PWR-NV-A1",
            target_node="TEL-FH-2",
            infrastructure_type="power",
            connection_type="power_supply",
            relation="dependency",
            directed=True,
            provenance=Provenance(category="simulated", source="test", confidence=1.0),
        )
    )
    eng = SimulationEngine(nets)
    r = run(eng, failed_nodes=["PWR-DS-A"], horizon_hours=2)
    a2 = aff(r, "PWR-NV-A2")
    # restored automatically in step 1; the SCADA hub goes dark in step 2 (its vault A1 is
    # not restored) so in step 3 the tie can no longer be held closed -> A2/A3 lost again
    assert a2.state == "de_energized" and a2.step == 1 and "SCADA" in a2.cause
    assert aff(r, "TEL-FH-2").state == "outage" and aff(r, "TEL-FH-2").step == 2
    step3 = r.cascade_steps[3]
    assert "PWR-NV-A2" in step3.node_ids and step3.label.startswith("Dependency: Tie switch T1 lost SCADA")
    # ... which then takes down the fibre hub fed by A2 (step 4)
    assert aff(r, "TEL-FH-1").step == 4


def test_every_state_and_severity_is_consistent(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-TS-1", "WTR-J-2"], failed_edges=["TRN-R-2", "UG-DB-2"])
    states = r.node_states
    by_id = {a.node_id: a for a in r.affected_nodes}
    for nid, st in states.items():
        if st != "operational":
            assert nid in by_id, f"{nid} in state {st} but not reported as affected"
            assert by_id[nid].state == st
    for a in r.affected_nodes:
        assert a.cause and a.node_id not in a.caused_by
        assert 0 <= a.service_level <= 1
        assert a.step <= max(s.step for s in r.cascade_steps)
        if a.state in ("restored",) or (a.state == "operational"):
            assert a.severity == "info"
    for e in r.interrupted_edges:
        assert r.edge_states[e.edge_id] == e.state and e.reason
    im = r.impact_metrics
    assert 0 <= im.severity_index <= 100 and 0 <= im.redundancy_score <= 1
    assert im.total_nodes_affected == sum(1 for a in r.affected_nodes if a.severity != "info")
    assert {s.system for s in im.per_system} == {"power", "water", "telecom", "transport", "underground", "facility"}
    assert r.summary and r.assumptions


def test_critical_facility_without_backup_is_critical_severity(mini_network) -> None:
    node(mini_network, "FAC-HOSP-1").properties["backup_power_hours"] = 0
    r = run(SimulationEngine(mini_network), failed_nodes=["PWR-NV-A1", "PWR-NV-B1"], enable_restoration=False)
    hosp = aff(r, "FAC-HOSP-1")
    assert hosp.state == "outage" and hosp.severity == "critical" and "no backup" in hosp.cause
    assert hosp.service_level == 0
