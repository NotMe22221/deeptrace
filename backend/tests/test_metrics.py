"""Network metrics, N-1 criticality and the severity index formula."""

from __future__ import annotations

import math

from app.models.schemas import ScenarioInput
from app.simulation import SimulationEngine
from app.simulation.report import SEVERITY_FORMULA, SEVERITY_WEIGHTS


def test_network_metrics(mini_engine: SimulationEngine) -> None:
    m = mini_engine.metrics()
    assert m is mini_engine.metrics()  # cached
    systems = {s.system: s for s in m.systems}
    assert set(systems) == {"power", "water", "telecom", "transport", "underground", "facility"}
    pw = systems["power"]
    assert pw.node_count == 15 and pw.edge_count == 16 and pw.connected_components == 1
    assert pw.redundancy_fraction == 1.0  # every vault has a tie-switchable second path
    tel = systems["telecom"]
    assert tel.articulation_points == ["TEL-FH-1"] and tel.top_betweenness[0][0] == "TEL-FH-1"
    assert abs(tel.redundancy_fraction - 1 / 3) < 1e-3  # only AN-1 is dual-homed
    wat = systems["water"]
    assert "WTR-PS-1" in wat.articulation_points
    assert 0 < wat.redundancy_fraction < 1
    assert systems["facility"].redundancy_fraction == round(1 / 3, 4)  # hospital has two feeds
    assert m.cross_system_dependencies == 22
    assert m.provenance_counts["power"] == {"simulated": 15 + 16 + 14}
    assert sum(sum(v.values()) for v in m.provenance_counts.values()) == len(mini_engine.network.nodes) + len(
        mini_engine.network.edges
    )


def test_criticality_ranking(mini_engine: SimulationEngine) -> None:
    ranking = mini_engine.metrics().criticality_ranking
    net = mini_engine.network
    assert len(ranking) == sum(1 for n in net.nodes if n.system != "facility")
    keys = [(-e.severity_index, -e.affected_count, e.node_id) for e in ranking]
    assert keys == sorted(keys)
    by = {e.node_id: e for e in ranking}
    # a single failure always affects at least the node itself
    assert all(e.affected_count >= 1 for e in ranking)
    # the supply source matters more than a leaf valve, the hub more than a dual-homed access node
    assert by["WTR-SRC-1"].severity_index > by["WTR-V-NC"].severity_index
    assert by["TEL-FH-1"].affected_count > by["TEL-AN-1"].affected_count
    # consistency with a direct simulation
    r = mini_engine.simulate(ScenarioInput(failed_nodes=["PWR-DS-B"]))
    assert by["PWR-DS-B"].severity_index == r.impact_metrics.severity_index
    assert by["PWR-DS-B"].affected_count == r.impact_metrics.total_nodes_affected


def test_severity_formula_is_documented_and_bounded(mini_engine: SimulationEngine) -> None:
    assert abs(sum(SEVERITY_WEIGHTS.values()) - 1.0) < 1e-9
    r = mini_engine.simulate(ScenarioInput(failed_edges=["WTR-WM-3"], horizon_hours=4))
    assert SEVERITY_FORMULA in r.assumptions
    im = r.impact_metrics
    # water-only + facilities: recompute the power-free terms by hand
    x_water = im.water_demand_unserved_lps / 110.0
    expected_min = 100 * SEVERITY_WEIGHTS["water"] * math.sqrt(x_water)
    assert im.severity_index >= expected_min - 0.05
    assert 0 < im.severity_index <= 100
    # monotone on nested scenarios
    bigger = mini_engine.simulate(ScenarioInput(failed_edges=["WTR-WM-3"], failed_nodes=["PWR-DS-A"], horizon_hours=4))
    assert bigger.impact_metrics.severity_index >= im.severity_index


def test_population_estimate_avoids_double_counting(mini_engine: SimulationEngine) -> None:
    r = mini_engine.simulate(ScenarioInput(failed_nodes=["PWR-DS-C"], enable_restoration=False, horizon_hours=6))
    # power: C1 900 + C2 1600 = 2500; water: zone H1 3000; facilities in outage: arena 5000 + city hall 300
    assert r.impact_metrics.population_affected_estimate == 3000 + 5000 + 300
