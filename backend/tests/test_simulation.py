"""System-model behaviour on the hand-crafted mini network (tests/fixtures/mini_network.py)."""

from __future__ import annotations

from app.models.schemas import AffectedNode, ScenarioInput, SimulationResult
from app.simulation import SimulationEngine
from tests.fixtures.mini_network import edge, node


def run(engine: SimulationEngine, **kw) -> SimulationResult:
    return engine.simulate(ScenarioInput(**kw))


def aff(r: SimulationResult, nid: str) -> AffectedNode:
    found = [a for a in r.affected_nodes if a.node_id == nid]
    assert found, f"{nid} not affected; affected = {[a.node_id for a in r.affected_nodes]}"
    return found[0]


def alt(r: SimulationResult, aid: str):
    found = [a for a in r.alternative_paths if a.id == aid]
    assert found, f"{aid} missing; have {[a.id for a in r.alternative_paths]}"
    return found[0]


# --------------------------------------------------------------------------- baseline


def test_baseline_is_nominal(mini_engine: SimulationEngine) -> None:
    b = mini_engine.baseline()
    assert b.affected_nodes == [] and b.interrupted_edges == [] and b.cascade_steps == []
    assert set(b.node_states.values()) == {"operational"}
    assert set(b.edge_states.values()) <= {"operational", "normally_open"}
    assert {e for e, s in b.edge_states.items() if s == "normally_open"} == {
        "PWR-TIE-1A", "PWR-TIE-1B", "PWR-TIE-2A", "PWR-TIE-2B", "WTR-DM-8", "WTR-DM-9",
    }
    im = b.impact_metrics
    assert im.severity_index == 0 and im.total_nodes_affected == 0 and im.redundancy_score == 1.0
    assert len(b.reachable_nodes) == len(b.node_states)
    # every node / edge has a state; every non-corridor physical edge has a flow
    net = mini_engine.network
    assert set(b.node_states) == {n.id for n in net.nodes}
    assert set(b.edge_states) == {e.id for e in net.edges}
    physical = {e.id for e in net.edges if e.relation == "physical" and e.infrastructure_type != "underground"}
    assert set(b.edge_flows) == physical
    # power flows radiate from the source: TS-1 -> DS-A carries feeder A's 9 MW
    assert b.edge_flows["PWR-TL-1"].direction == 1 and abs(b.edge_flows["PWR-TL-1"].flow - 9.0) < 1e-6
    assert abs(b.edge_flows["PWR-FC-A4"].flow - 2.0) < 1e-6
    # water flows from the supply towards the zones; the tank is idle in the baseline
    assert b.edge_flows["WTR-WM-1"].direction == 1 and abs(b.edge_flows["WTR-WM-1"].flow - 110.0) < 1e-6
    assert b.edge_flows["WTR-DM-5"].flow == 0
    # telecom demand towards the cores, transport O-D index
    assert b.edge_flows["TEL-FL-1"].flow > 0 and b.edge_flows["TRN-R-1"].utilization > 0
    assert b.summary.startswith("Baseline")


# --------------------------------------------------------------------------- power


def test_power_deenergisation_without_restoration(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-DS-A"], enable_restoration=False)
    for n in ("PWR-SW-A1", "PWR-NV-A1", "PWR-NV-A2", "PWR-NV-A3"):
        a = aff(r, n)
        assert a.state == "de_energized" and a.step == 1 and a.severity == "major"
        assert "PWR-DS-A" in a.cause and "FDR-A" in a.cause and "PWR-DS-A" in a.caused_by
        assert a.service_level == 0
    assert r.node_states["PWR-NV-B1"] == "operational"
    assert abs(r.impact_metrics.power_load_unserved_mw - 9.0) < 1e-6
    assert r.edge_states["PWR-FC-A2"] == "interrupted"
    assert r.edge_states["PWR-TIE-1A"] == "normally_open"
    assert aff(r, "PWR-DS-A").step == 0 and aff(r, "PWR-DS-A").state == "failed"
    power = next(s for s in r.impact_metrics.per_system if s.system == "power")
    assert power.metric_name == "Load served" and power.baseline_value == 21 and power.remaining_value == 12


def test_full_tie_restoration(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["PWR-FC-A3"])
    for n in ("PWR-NV-A2", "PWR-NV-A3"):
        a = aff(r, n)
        assert a.state == "restored" and a.severity == "info" and a.service_level == 1
        assert "PWR-SW-T1" in a.cause and "6.0 of 6.0 MW" in a.cause
    assert r.node_states["PWR-NV-A1"] == "operational"
    assert r.edge_states["PWR-TIE-1A"] == "activated" and r.edge_states["PWR-TIE-1B"] == "activated"
    assert r.impact_metrics.power_load_unserved_mw == 0
    assert r.impact_metrics.redundancy_score == 1.0
    p = alt(r, "alt-power-tie-PWR-SW-T1")
    assert p.capacity_ok and p.purpose == "tie-switch restoration" and p.node_ids[0] == "PWR-NV-B2"
    # restored load flows through the tie from B2 towards A3
    assert r.edge_flows["PWR-TIE-1B"].flow == 6.0 and r.edge_flows["PWR-FC-B2"].flow == 9.0


def test_partial_tie_restoration_is_capacity_limited(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-DS-A"])
    assert aff(r, "PWR-NV-A2").state == "restored" and aff(r, "PWR-NV-A3").state == "restored"
    left = aff(r, "PWR-NV-A1")
    assert left.state == "de_energized"
    assert "6.0 of 9.0 MW" in left.cause and "tie capacity" in left.cause and "PWR-SW-T1" in left.caused_by
    assert abs(r.impact_metrics.power_load_unserved_mw - 3.0) < 1e-6
    p = alt(r, "alt-power-tie-PWR-SW-T1")
    assert not p.capacity_ok and "6.0 of 9.0 MW" in p.description
    # redundancy: 6 of the 9 MW initially cut were recovered
    assert abs(r.impact_metrics.redundancy_score - 6 / 9) < 1e-3


def test_restoration_respects_substation_spare_capacity(mini_network) -> None:
    node(mini_network, "PWR-DS-B").capacity = 8.0  # 6 MW served -> 2 MW spare
    eng = SimulationEngine(mini_network)
    r = run(eng, failed_nodes=["PWR-DS-A"])
    a3 = aff(r, "PWR-NV-A3")
    assert a3.state == "restored" and "spare capacity of PWR-DS-B" in a3.cause
    assert r.node_states["PWR-NV-A2"] == "de_energized"
    assert abs(r.impact_metrics.power_load_unserved_mw - 7.0) < 1e-6


def test_scada_down_requires_manual_switching_within_horizon(mini_engine: SimulationEngine) -> None:
    short = run(mini_engine, failed_nodes=["PWR-DS-A", "TEL-FH-2"], horizon_hours=2)
    a2 = aff(short, "PWR-NV-A2")
    assert a2.state == "de_energized"
    assert "SCADA" in a2.cause and "TEL-FH-2" in a2.cause and "3.0 h" in a2.cause
    assert aff(short, "PWR-SW-T1").state == "degraded"
    assert short.edge_states["PWR-TIE-1A"] == "normally_open"
    assert any("could not be closed" in n for s in short.impact_metrics.per_system for n in s.notes)

    long = run(mini_engine, failed_nodes=["PWR-DS-A", "TEL-FH-2"], horizon_hours=4)
    a2 = aff(long, "PWR-NV-A2")
    assert a2.state == "restored" and "manual switching after 3.0 h" in a2.cause and "SCADA" in a2.cause
    assert "manual" in alt(long, "alt-power-tie-PWR-SW-T1").description


def test_overload_is_flagged_below_emergency_limit(mini_network) -> None:
    node(mini_network, "PWR-TS-2").capacity = 11.0
    r = run(SimulationEngine(mini_network), failed_nodes=["PWR-TS-1"])
    ts2 = aff(r, "PWR-TS-2")
    assert ts2.state == "overloaded" and "109%" in ts2.cause and "within the 120%" in ts2.cause
    assert r.node_states["PWR-DS-C"] == "operational"


def test_overload_trip_cascades_in_next_round(mini_network) -> None:
    node(mini_network, "PWR-TS-2").capacity = 9.0
    r = run(SimulationEngine(mini_network), failed_nodes=["PWR-TS-1"])
    ts2 = aff(r, "PWR-TS-2")
    assert ts2.state == "failed" and "tripped" in ts2.cause and "133%" in ts2.cause
    assert "PWR-TS-2" in r.failed_nodes
    ds_c = aff(r, "PWR-DS-C")
    assert ds_c.state == "de_energized" and "PWR-TS-2" in ds_c.caused_by and ds_c.step == 2
    ds_b = aff(r, "PWR-DS-B")
    assert "alternative supply through PWR-TS-2" in ds_b.cause
    labels = [s.label for s in r.cascade_steps]
    assert any(lbl.startswith("Protective trip: TS South") for lbl in labels)
    assert r.impact_metrics.power_load_unserved_mw == 21.0


def test_alternate_transmission_line_carries_load_only_when_needed_and_can_trip(mini_network) -> None:
    edge(mini_network, "PWR-TL-3").properties["role"] = "alternate"
    edge(mini_network, "PWR-TL-3").capacity = 4.0
    eng = SimulationEngine(mini_network)
    b = eng.baseline()
    assert b.edge_flows["PWR-TL-3"].flow == 0 and b.edge_flows["PWR-TL-2"].flow == 6.0
    r = run(eng, failed_nodes=["PWR-TS-1"])
    assert r.edge_states["PWR-TL-3"] == "failed"
    reason = next(e for e in r.interrupted_edges if e.edge_id == "PWR-TL-3").reason
    assert "Tripped" in reason and "150%" in reason
    assert "PWR-TL-3" in r.failed_edges
    # DS-B loses its last supply; its feeder is then picked up through tie T2 from DS-C
    ds_b = aff(r, "PWR-DS-B")
    assert ds_b.state == "de_energized" and "PWR-TL-3" in ds_b.caused_by
    assert "not back-fed" in ds_b.cause
    b1 = aff(r, "PWR-NV-B1")
    assert b1.state == "restored" and "PWR-SW-T2" in b1.cause


# --------------------------------------------------------------------------- water


def test_pipe_rupture_isolation_segment(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["WTR-WM-3"], horizon_hours=2)
    assert r.edge_states["WTR-WM-3"] == "failed"
    assert r.edge_states["WTR-DM-1"] == "isolated" and r.edge_states["WTR-DM-2"] == "isolated"
    assert r.node_states["WTR-J-2"] == "isolated"
    j2 = aff(r, "WTR-J-2")
    assert "WTR-V-1" in j2.cause and "WTR-V-2" in j2.cause and "WTR-WM-3" in j2.cause
    # valves themselves stay healthy (closed), the rest of the network is untouched
    assert r.node_states["WTR-V-1"] == "operational" and r.node_states["WTR-SZ-L2"] == "operational"
    sz = aff(r, "WTR-SZ-L1")
    assert sz.state == "outage" and sz.service_level == 0 and "WTR-WM-3" in sz.cause
    iso = [e for e in r.interrupted_edges if e.state == "isolated"]
    assert all("WTR-WM-3" in e.reason for e in iso)


def test_tank_buffers_high_zone_within_horizon(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["WTR-WM-3"], horizon_hours=2)
    h1 = aff(r, "WTR-SZ-H1")
    assert h1.state == "on_backup" and h1.severity == "minor"
    assert "WTR-TNK-1" in h1.cause and "3.5 h" in h1.cause
    assert aff(r, "WTR-TNK-1").state == "on_backup"
    assert abs(r.impact_metrics.water_demand_unserved_lps - 50.0) < 1e-6
    assert r.edge_flows["WTR-DM-5"].flow == 40.0 and r.edge_flows["WTR-DM-5"].direction == 1


def test_tank_depletes_beyond_horizon(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["WTR-WM-3"], horizon_hours=4)
    h1 = aff(r, "WTR-SZ-H1")
    assert h1.state == "outage" and "drained after 3.5 h" in h1.cause
    assert abs(r.impact_metrics.water_demand_unserved_lps - 90.0) < 1e-6


def test_normally_closed_valve_is_offered_as_alternative(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["WTR-WM-3"], horizon_hours=2)
    p = alt(r, "alt-water-valve-WTR-V-NC")
    assert p.system == "water" and p.capacity_ok and p.to_node == "WTR-SZ-L1"
    assert "50.0 L/s" in p.description and p.node_ids[0] == "WTR-V-NC"
    # not applied automatically
    assert r.node_states["WTR-SZ-L1"] == "outage"


def test_pump_power_loss_takes_out_high_zone(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-NV-C2"], enable_restoration=False, horizon_hours=6)
    ps = aff(r, "WTR-PS-1")
    assert ps.state == "outage" and "PWR-NV-C2" in ps.cause and "PWR-NV-C2" in ps.caused_by
    h1 = aff(r, "WTR-SZ-H1")
    assert h1.state == "outage" and "WTR-PS-1" in h1.cause and "high pressure" in h1.cause
    assert r.node_states["WTR-SZ-L1"] == "operational" and r.node_states["WTR-SZ-L2"] == "operational"
    assert r.edge_states["DEP-PS1-PWR"] == "failed" or r.edge_states["DEP-PS1-PWR"] == "interrupted"


def test_pump_with_backup_power_keeps_high_zone(mini_network) -> None:
    node(mini_network, "WTR-PS-1").properties["backup_power_hours"] = 12
    r = run(SimulationEngine(mini_network), failed_nodes=["PWR-NV-C2"], enable_restoration=False, horizon_hours=6)
    assert aff(r, "WTR-PS-1").state == "on_backup"
    assert r.node_states["WTR-SZ-H1"] == "operational"


# --------------------------------------------------------------------------- telecom


def test_fibre_cut_reroutes_dual_homed_nodes(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["TEL-FL-2"])
    an1 = aff(r, "TEL-AN-1")
    assert an1.state == "operational" and an1.severity == "info" and "rerouted" in an1.cause
    assert r.impact_metrics.telecom_nodes_disconnected == 0
    p = alt(r, "alt-telecom-TEL-AN-1")
    assert p.purpose == "fibre reroute" and p.node_ids == ["TEL-AN-1", "TEL-FH-2", "TEL-DC-1"]
    assert p.edge_ids == ["TEL-FL-6", "TEL-FL-5"] and p.added_length_m == 300
    assert r.edge_states["TEL-FL-6"] == "rerouted"
    assert r.impact_metrics.total_nodes_affected == 0 and r.impact_metrics.severity_index == 0


def test_single_homed_nodes_disconnect(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["TEL-FH-1"])
    for n in ("TEL-AN-2", "TEL-CS-1"):
        a = aff(r, n)
        assert a.state == "disconnected" and "TEL-FH-1" in a.cause
    assert aff(r, "TEL-AN-1").severity == "info"
    assert r.impact_metrics.telecom_nodes_disconnected == 3  # FH-1 itself + two endpoints
    assert aff(r, "FAC-GOV-1").state == "degraded"


def test_battery_backup_covers_only_short_horizons(mini_engine: SimulationEngine) -> None:
    # NV-A3 feeds only the cell site (2 h battery); the fibre hub stays powered
    short = run(mini_engine, failed_nodes=["PWR-NV-A3"], enable_restoration=False, horizon_hours=1)
    cs = aff(short, "TEL-CS-1")
    assert cs.state == "on_backup" and "running on backup" in cs.cause and cs.severity == "minor"
    assert cs.service_level == 1
    long = run(mini_engine, failed_nodes=["PWR-NV-A3"], enable_restoration=False, horizon_hours=4)
    cs = aff(long, "TEL-CS-1")
    assert cs.state == "outage" and "2.0 h does not cover the 4.0 h horizon" in cs.cause
    assert cs.caused_by == ["PWR-NV-A3"]
    # a wider outage: the central office rides through on its 8 h battery, the hub has none
    wide = run(mini_engine, failed_nodes=["PWR-DS-A"], enable_restoration=False, horizon_hours=4)
    assert aff(wide, "TEL-CO-1").state == "on_backup"
    assert aff(wide, "TEL-FH-1").state == "outage"


def test_rerouted_traffic_can_congest_links(mini_network) -> None:
    edge(mini_network, "TEL-FL-6").capacity = 2.5
    r = run(SimulationEngine(mini_network), failed_edges=["TEL-FL-2"])
    assert r.edge_states["TEL-FL-6"] == "overloaded"
    a = aff(r, "TEL-AN-1")
    assert a.state == "degraded" and "TEL-FL-6" in a.cause and 0 < a.service_level < 1
    assert r.edge_flows["TEL-FL-6"].utilization > 1


# --------------------------------------------------------------------------- transport


def test_road_closure_detour(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["TRN-R-2"])
    hosp = aff(r, "FAC-HOSP-1")
    assert hosp.state == "delayed" and "+61%" in hosp.cause and "TRN-R-2" in hosp.cause
    assert r.impact_metrics.transport_travel_time_increase_pct > 25
    d = alt(r, "alt-transport-TRN-GW-N-FAC-HOSP-1")
    assert d.purpose == "traffic detour" and d.added_time_s == 110
    assert d.node_ids == ["TRN-GW-N", "TRN-I-1", "TRN-I-3", "TRN-I-4", "TRN-I-2", "FAC-HOSP-1"]
    for e in ("TRN-R-4", "TRN-R-5", "TRN-R-6", "TRN-R-7"):
        assert r.edge_states[e] == "rerouted"
    assert r.edge_states["TRN-R-1"] == "operational"
    assert r.impact_metrics.redundancy_score == 1.0


def test_signal_outage_adds_delay(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-NV-A1"], enable_restoration=False)
    sig = aff(r, "TRN-I-2")
    assert sig.state == "degraded" and "+25 s" in sig.cause and "PWR-NV-A1" in sig.cause
    assert r.impact_metrics.transport_travel_time_increase_pct > 0
    assert "TRN-I-2" in aff(r, "FAC-HOSP-1").cause


def test_signal_battery_backup_prevents_delay(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-NV-C1"], enable_restoration=False, horizon_hours=4)
    assert aff(r, "TRN-I-4").state == "on_backup"  # 6 h battery
    assert r.impact_metrics.transport_travel_time_increase_pct == 0


def test_station_closes_without_traction_power(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-DS-A"], enable_restoration=False)
    st = aff(r, "TRN-ST-1")
    assert st.state == "closed" and "PWR-NV-A2" in st.cause
    assert r.edge_states["TRN-RL-1"] == "interrupted"
    assert r.node_states["TRN-ST-2"] == "operational" and r.node_states["TRN-ST-3"] == "operational"
    assert r.impact_metrics.transit_stations_closed == 1


def test_severed_rail_line_closes_stranded_station(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["TRN-RL-2"])
    st = aff(r, "TRN-ST-3")
    assert st.state == "closed" and "severed" in st.cause
    assert r.node_states["TRN-ST-1"] == "operational"


def test_cut_off_destination_is_inaccessible(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["TRN-I-2"])
    hosp = aff(r, "FAC-HOSP-1")
    assert hosp.state == "inaccessible" and hosp.severity == "critical"
    assert "FAC-HOSP-1" in r.impact_metrics.critical_facilities_affected
