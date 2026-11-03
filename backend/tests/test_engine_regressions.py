"""Regression tests for issues found in the adversarial engine review (findings 0–9, 23, 24)."""

from __future__ import annotations

import re
import time

import pytest

from app.models.schemas import ScenarioInput, SimulationResult
from app.simulation import SimulationEngine
from app.simulation.compare import compare_results

VOLATILE = {"timestamp", "computation_ms", "scenario", "scenario_id", "assumptions", "summary"}


def run(engine: SimulationEngine, **kw) -> SimulationResult:
    return engine.simulate(ScenarioInput(**kw))


def aff(r: SimulationResult, nid: str):
    return next(a for a in r.affected_nodes if a.node_id == nid)


# 0 ---------------------------------------------------------------------------------------


def test_directly_failed_demand_counts_as_unrecovered(mini_engine: SimulationEngine) -> None:
    zone = run(mini_engine, failed_nodes=["WTR-SZ-L2"])
    assert zone.impact_metrics.water_demand_unserved_lps == 20
    assert zone.impact_metrics.redundancy_score == 0.0
    vault = run(mini_engine, failed_nodes=["PWR-NV-A3"], enable_restoration=False)
    assert vault.impact_metrics.redundancy_score == 0.0
    cell = run(mini_engine, failed_nodes=["TEL-CS-1"])
    assert cell.impact_metrics.redundancy_score == 0.0
    # same loss entered one element upstream gives the same score
    upstream = run(mini_engine, failed_nodes=["WTR-V-3"])
    assert upstream.impact_metrics.water_demand_unserved_lps == 20
    assert upstream.impact_metrics.redundancy_score == zone.impact_metrics.redundancy_score
    assert "recovered 0%" in zone.summary


def test_redundancy_sentence_only_when_something_was_cut(mini_engine: SimulationEngine) -> None:
    nothing_cut = run(mini_engine, failed_nodes=["FAC-VEN-1"])
    assert nothing_cut.impact_metrics.redundancy_score == 1.0
    assert "Redundancy" not in nothing_cut.summary
    cut = run(mini_engine, failed_edges=["PWR-FC-A3"])
    assert "recovered 100% of the service initially cut" in cut.summary


# 1 ---------------------------------------------------------------------------------------


def test_idle_normally_open_elements_are_not_cascade_changes(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["FAC-VEN-1"])
    assert [s.step for s in r.cascade_steps] == [0]
    assert "no further propagation" in r.summary
    road = run(mini_engine, failed_edges=["TRN-R-2"])
    for step in road.cascade_steps[1:]:
        assert not any(e.startswith(("PWR-TIE", "WTR-DM-8", "WTR-DM-9")) for e in step.edge_ids)
        assert "power" not in step.systems and "water" not in step.systems
    # a tie that really closes is still listed
    tie = run(mini_engine, failed_edges=["PWR-FC-A3"])
    assert "PWR-TIE-1A" in tie.cascade_steps[1].edge_ids


# 2 ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario",
    [
        {"failed_nodes": ["PWR-NV-A1"], "enable_restoration": False},
        {"failed_nodes": ["PWR-DS-C"], "enable_restoration": False, "horizon_hours": 6},
        {"failed_nodes": ["PWR-DS-A"]},
    ],
)
def test_truncated_flag_means_the_result_would_differ(mini_engine: SimulationEngine, scenario: dict) -> None:
    full = run(mini_engine, **scenario)
    for k in range(1, 5):
        capped = run(mini_engine, max_cascade_rounds=k, **scenario)
        differs = capped.model_dump(exclude=VOLATILE) != full.model_dump(exclude=VOLATILE)
        flagged = any("truncated" in a for a in capped.assumptions)
        assert flagged == differs, (scenario, k)


# 3 ---------------------------------------------------------------------------------------


def test_no_reroute_wording_when_a_path_exists(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_edges=["TEL-FL-3"], enable_restoration=False)
    a = aff(r, "TEL-AN-1")
    assert a.state == "disconnected"
    assert "alternative fibre path to TEL-DC-1" in a.cause and "rerouting is disabled" in a.cause
    assert "no operational fibre path" not in a.cause
    real = run(mini_engine, failed_nodes=["TEL-FH-1"])
    assert "no operational fibre path" in aff(real, "TEL-AN-2").cause


# 4 + 9 -----------------------------------------------------------------------------------


def test_restoration_actions_grow_with_damage_and_are_not_verdict_reasons(mini_engine: SimulationEngine) -> None:
    a = run(mini_engine, failed_nodes=["PWR-DS-A"])
    b = run(mini_engine, failed_nodes=["PWR-DS-A"], failed_edges=["TEL-FL-3"])
    cmp = compare_results(a, b)
    m = next(x for x in cmp.metrics if x.key == "alternative_paths")
    assert m.higher_is_worse and m.b > m.a and m.worse == "b"
    assert "reroute actions" not in cmp.verdict.lower()


def test_verdict_never_cites_values_that_print_identically(mini_engine: SimulationEngine) -> None:
    scenarios = [
        {"failed_nodes": ["FAC-VEN-1"]},
        {"failed_nodes": ["PWR-NV-A1"], "enable_restoration": False},
        {"failed_edges": ["TRN-R-2"]},
        {"failed_edges": ["WTR-WM-3"]},
        {"failed_nodes": ["TEL-FH-1"]},
        {"failed_nodes": ["PWR-NV-C1"], "enable_restoration": False},
    ]
    results = [run(mini_engine, **s) for s in scenarios]
    for ra in results:
        for rb in results:
            verdict = compare_results(ra, rb).verdict
            for hi, lo in re.findall(r"(\S+) vs (\S+?)(?:/100)?(?:;|\.$)", verdict):
                assert hi != lo, verdict


# 5 + 23 ----------------------------------------------------------------------------------


def test_water_trace_avoids_normally_closed_valves(mini_engine: SimulationEngine) -> None:
    water = mini_engine.cascade.water
    for n in water.nodes:
        if n in water.nc_valves:
            continue
        t = mini_engine.trace(n)
        for p in t.source_paths:
            assert not set(p) & water.nc_valves, (n, p)
        assert not {h.node_id for h in t.upstream} & water.nc_valves, n


def test_sources_have_no_supply_path(mini_engine: SimulationEngine) -> None:
    for n in ("PWR-TS-1", "WTR-SRC-1", "TEL-IX-1", "TEL-DC-1", "TRN-GW-N"):
        t = mini_engine.trace(n)
        assert t.source_paths == [] and t.upstream == [], n
        assert "source" in t.summary or "gateway" in t.summary, t.summary
    # non-sources still get their paths
    assert mini_engine.trace("PWR-DS-A").source_paths[0] == ["PWR-DS-A", "PWR-TS-1"]


# 6 ---------------------------------------------------------------------------------------


def test_cli_rejects_invalid_overrides(capsys) -> None:
    from app.networks.loader import network_path
    from app.simulation.cli import main

    if not network_path().exists():
        pytest.skip("network.json not generated")
    assert main(["--fail", "PWR-DS-FIVEPOINTS", "--rounds", "0"]) == 2
    assert main(["--fail", "PWR-DS-FIVEPOINTS", "--horizon", "-5"]) == 2
    assert "invalid scenario override" in capsys.readouterr().err


def test_engine_rejects_unvalidated_out_of_range_inputs(mini_engine: SimulationEngine) -> None:
    bad = ScenarioInput(failed_nodes=["PWR-DS-A"]).model_copy(update={"max_cascade_rounds": 0, "horizon_hours": -5})
    with pytest.raises(ValueError, match="max_cascade_rounds.*horizon_hours"):
        mini_engine.simulate(bad)


# 7 ---------------------------------------------------------------------------------------


def test_cut_control_link_does_not_blame_the_provider(mini_engine: SimulationEngine) -> None:
    r = run(mini_engine, failed_nodes=["PWR-DS-A"], failed_edges=["DEP-T1-SCADA"], horizon_hours=2)
    assert r.node_states["TEL-FH-2"] == "operational"
    a2 = aff(r, "PWR-NV-A2")
    assert "SCADA control link from TEL-FH-2" in a2.cause and "is lost" in a2.cause
    assert "is down" not in a2.cause
    restored = run(mini_engine, failed_nodes=["PWR-DS-A"], failed_edges=["DEP-T1-SCADA"], horizon_hours=4)
    assert "SCADA control link from TEL-FH-2" in aff(restored, "PWR-NV-A2").cause


# 8 ---------------------------------------------------------------------------------------


def test_travel_time_is_rounded_once(mini_engine: SimulationEngine) -> None:
    for kw in ({"failed_edges": ["TRN-R-2"]}, {"failed_nodes": ["PWR-NV-A1"], "enable_restoration": False}):
        r = run(mini_engine, **kw)
        note = next(s for s in r.impact_metrics.per_system if s.system == "transport").notes[0]
        pct = re.search(r"O-D travel time ([+-]\d+\.\d)%", note).group(1)  # type: ignore[union-attr]
        assert f"O-D travel time {pct}%" in r.summary
        assert f"{r.impact_metrics.transport_travel_time_increase_pct:+.1f}" == pct


# 24 --------------------------------------------------------------------------------------


def test_validation_cost_is_bounded_for_huge_inputs(mini_engine: SimulationEngine) -> None:
    ids = [f"PWR-FC-{i:05d}" for i in range(3000)]
    sc = ScenarioInput.model_construct(
        scenario_id=None,
        name=None,
        scenario_type="custom",
        failed_nodes=["PWR-FC-A1", *ids],
        failed_edges=ids,
        horizon_hours=4.0,
        enable_restoration=True,
        max_cascade_rounds=8,
    )
    t0 = time.perf_counter()
    with pytest.raises(ValueError) as exc:
        mini_engine.validate_scenario(sc)
    assert time.perf_counter() - t0 < 1.0
    msg = str(exc.value)
    assert len(msg) < 3000
    assert "did you mean" in msg and "more unknown node ids" in msg and "more unknown edge ids" in msg
    assert "list it under failed_edges" in msg
