"""Side-by-side comparison of two simulation results."""

from __future__ import annotations

from collections.abc import Callable

from app.models.schemas import ComparisonMetric, ScenarioComparison, SimulationResult

# key, label, unit, extractor, higher_is_worse
METRICS: list[tuple[str, str, str, Callable[[SimulationResult], float], bool]] = [
    ("severity_index", "Severity index", "/100", lambda r: r.impact_metrics.severity_index, True),
    ("nodes_affected", "Nodes affected", "nodes", lambda r: r.impact_metrics.total_nodes_affected, True),
    (
        "critical_facilities_affected",
        "Critical facilities affected",
        "facilities",
        lambda r: len(r.impact_metrics.critical_facilities_affected),
        True,
    ),
    ("population_affected", "Population affected", "people", lambda r: r.impact_metrics.population_affected_estimate, True),
    ("power_unserved_mw", "Power load unserved", "MW", lambda r: r.impact_metrics.power_load_unserved_mw, True),
    ("water_unserved_lps", "Water demand unserved", "L/s", lambda r: r.impact_metrics.water_demand_unserved_lps, True),
    (
        "telecom_disconnected",
        "Telecom nodes disconnected",
        "nodes",
        lambda r: r.impact_metrics.telecom_nodes_disconnected,
        True,
    ),
    (
        "travel_time_increase_pct",
        "O-D travel time increase",
        "%",
        lambda r: r.impact_metrics.transport_travel_time_increase_pct,
        True,
    ),
    ("stations_closed", "Transit stations closed", "stations", lambda r: r.impact_metrics.transit_stations_closed, True),
    ("redundancy_score", "Redundancy score", "share", lambda r: r.impact_metrics.redundancy_score, False),
    ("alternative_paths", "Alternative paths used", "paths", lambda r: len(r.alternative_paths), True),
]


def _fmt(v: float, unit: str) -> str:
    if unit in ("nodes", "facilities", "people", "stations", "paths"):
        return f"{int(round(v)):,}"
    if unit == "share":
        return f"{v * 100:.0f}%"
    if unit == "%":
        return f"{v:+.1f}%"
    return f"{v:,.1f}"


def compare_results(a: SimulationResult, b: SimulationResult) -> ScenarioComparison:
    metrics: list[ComparisonMetric] = []
    for key, label, unit, fn, hiw in METRICS:
        va, vb = float(fn(a)), float(fn(b))
        if abs(va - vb) < 1e-9:
            worse = "equal"
        elif hiw:
            worse = "a" if va > vb else "b"
        else:
            worse = "a" if va < vb else "b"
        metrics.append(
            ComparisonMetric(
                key=key,
                label=label,
                unit=unit,
                a=round(va, 4),
                b=round(vb, 4),
                delta=round(vb - va, 4),
                higher_is_worse=hiw,
                worse=worse,  # type: ignore[arg-type]
            )
        )

    def real(r: SimulationResult) -> set[str]:
        return {x.node_id for x in r.affected_nodes if x.severity != "info"}

    ra, rb = real(a), real(b)
    only_a, only_b, both = sorted(ra - rb), sorted(rb - ra), sorted(ra & rb)

    name_a = a.scenario.name or a.scenario_id
    name_b = b.scenario.name or b.scenario_id
    by_key = {m.key: m for m in metrics}
    sev = by_key["severity_index"]
    if sev.worse == "equal" or abs(sev.a - sev.b) < 0.05:
        n = by_key["nodes_affected"]
        if n.worse == "equal":
            verdict = (
                f"Scenarios A ({name_a}) and B ({name_b}) are equally severe: severity {sev.a:.1f}/100 and "
                f"{n.a:.0f} affected nodes each."
            )
        else:
            w = "A" if n.worse == "a" else "B"
            verdict = (
                f"Scenario {w} is slightly more severe: same severity index ({sev.a:.1f}/100) but "
                f"{_fmt(max(n.a, n.b), 'nodes')} vs {_fmt(min(n.a, n.b), 'nodes')} affected nodes."
            )
    else:
        w = "a" if sev.worse == "a" else "b"
        W, L = ("A", "B") if w == "a" else ("B", "A")
        reasons: list[str] = [f"severity {max(sev.a, sev.b):.1f} vs {min(sev.a, sev.b):.1f}/100"]
        ranked = []
        for m in metrics:
            if m.key == "severity_index" or m.worse != w:
                continue
            hi, lo = (m.a, m.b) if w == "a" else (m.b, m.a)
            rel = abs(hi - lo) / max(abs(hi), abs(lo), 1e-9)
            ranked.append((rel, m.key, m, hi, lo))
        ranked.sort(key=lambda x: (-x[0], x[1]))
        for _rel, _k, m, hi, lo in ranked[:3]:
            reasons.append(f"{m.label.lower()} {_fmt(hi, m.unit)} vs {_fmt(lo, m.unit)}")
        verdict = f"Scenario {W} is more severe than Scenario {L}: " + "; ".join(reasons) + "."
    red = by_key["redundancy_score"]
    summary = (
        f"A = {name_a} ({len(a.failed_nodes) + len(a.failed_edges)} failed elements, severity {sev.a:.1f}); "
        f"B = {name_b} ({len(b.failed_nodes) + len(b.failed_edges)} failed elements, severity {sev.b:.1f}). "
        f"{len(both)} affected nodes are common to both, {len(only_a)} only in A and {len(only_b)} only in B. "
        f"Redundancy recovered {red.a * 100:.0f}% of the cut service in A and {red.b * 100:.0f}% in B. {verdict}"
    )
    return ScenarioComparison(
        scenario_a=a,
        scenario_b=b,
        metrics=metrics,
        only_in_a=only_a,
        only_in_b=only_b,
        in_both=both,
        verdict=verdict,
        summary=summary,
    )
