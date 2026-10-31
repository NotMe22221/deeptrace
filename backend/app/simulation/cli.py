"""Command-line runner for debugging scenarios.

Examples (from ``backend/``)::

    python -m app.simulation.cli --list
    python -m app.simulation.cli --preset <preset-id>
    python -m app.simulation.cli --all-presets
    python -m app.simulation.cli --fail PWR-DS-02 PWR-FC-0007 --horizon 2
    python -m app.simulation.cli --trace PWR-NV-014
    python -m app.simulation.cli --metrics
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from app.models.schemas import ScenarioInput, SimulationResult


def _print_result(r: SimulationResult, verbose: bool) -> None:
    im = r.impact_metrics
    print(f"\n=== {r.scenario.name or r.scenario_id} [{r.scenario_id}] ({r.computation_ms:.1f} ms)")
    print(r.summary)
    print(
        f"severity {im.severity_index:.1f} | affected {im.total_nodes_affected} | critical {im.critical_facilities_affected} "
        f"| pop {im.population_affected_estimate:,} | MW {im.power_load_unserved_mw:.2f} | L/s "
        f"{im.water_demand_unserved_lps:.2f} | tel {im.telecom_nodes_disconnected} | tt {im.transport_travel_time_increase_pct:+.1f}% "
        f"| stations {im.transit_stations_closed} | redundancy {im.redundancy_score:.2f}"
    )
    for s in im.per_system:
        print(
            f"  {getattr(s.system, 'value', s.system):<11} {s.metric_name:<26} {s.remaining_value:>9.1f}/{s.baseline_value:<9.1f} {s.unit:<12} "
            f"affected {s.nodes_affected:>3}/{s.nodes_total:<3} {('; '.join(s.notes))[:140]}"
        )
    print("Cascade:")
    for st in r.cascade_steps:
        print(f"  [{st.step}] {st.label}")
        if verbose:
            print(f"      {st.description}")
    if verbose:
        print("Affected nodes:")
        for a in r.affected_nodes:
            print(f"  s{a.step} {a.severity:<8} {a.state:<13} {a.node_id}: {a.cause}")
        print("Alternative paths:")
        for p in r.alternative_paths:
            print(f"  {p.id}: {p.description}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="DEEPTRACE simulation engine CLI")
    ap.add_argument("--region", default=None)
    ap.add_argument("--preset", help="run a preset from scenarios.json")
    ap.add_argument("--all-presets", action="store_true", help="run every preset")
    ap.add_argument("--list", action="store_true", help="list presets")
    ap.add_argument("--fail", nargs="+", default=[], help="node or edge ids to fail")
    ap.add_argument("--horizon", type=float, default=None)
    ap.add_argument("--no-restoration", action="store_true")
    ap.add_argument("--rounds", type=int, default=None)
    ap.add_argument("--trace", help="trace a node")
    ap.add_argument("--metrics", action="store_true", help="network metrics + N-1 ranking")
    ap.add_argument("--json", action="store_true", help="print the raw JSON result")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    from app.networks.loader import load_presets
    from app.simulation import get_engine

    t0 = time.perf_counter()
    engine = get_engine(args.region)
    print(f"engine ready in {(time.perf_counter() - t0) * 1000:.0f} ms — {engine.network.id}: "
          f"{len(engine.network.nodes)} nodes, {len(engine.network.edges)} edges", file=sys.stderr)
    for w in engine.warnings:
        print(f"  data warning: {w}", file=sys.stderr)
    presets = {p.id: p for p in load_presets(args.region)}

    if args.list:
        for p in presets.values():
            print(f"{p.id:<32} {p.scenario_type:<16} {p.name}")
        return 0
    if args.metrics:
        t1 = time.perf_counter()
        m = engine.metrics()
        print(f"metrics in {(time.perf_counter() - t1) * 1000:.0f} ms")
        for s in m.systems:
            print(
                f"  {getattr(s.system, 'value', s.system):<11} n={s.node_count:<4} e={s.edge_count:<4} comps={s.connected_components:<3} "
                f"deg={s.average_degree:.2f} aps={len(s.articulation_points):<3} redundancy={s.redundancy_fraction:.2f} "
                f"top={s.top_betweenness[:2]}"
            )
        print(f"  cross-system dependencies: {m.cross_system_dependencies}")
        for e in m.criticality_ranking[:15]:
            print(f"  {e.severity_index:6.1f} {e.affected_count:4d} crit={e.critical_facilities_affected} {e.node_id}")
        return 0
    if args.trace:
        tr = engine.trace(args.trace)
        print(json.dumps(tr.model_dump(), indent=1) if args.json else tr.summary)
        return 0

    scenarios: list[ScenarioInput] = []
    if args.all_presets:
        scenarios = [p.scenario for p in presets.values()]
    elif args.preset:
        if args.preset not in presets:
            print(f"unknown preset {args.preset}; available: {', '.join(presets)}", file=sys.stderr)
            return 2
        scenarios = [presets[args.preset].scenario]
    elif args.fail:
        nodes = [x for x in args.fail if x in engine.graphs.nodes]
        edges = [x for x in args.fail if x not in engine.graphs.nodes]
        scenarios = [ScenarioInput(name="CLI scenario", failed_nodes=nodes, failed_edges=edges)]
    else:
        scenarios = [ScenarioInput(name="Baseline")]
    for sc in scenarios:
        upd = {}
        if args.horizon is not None:
            upd["horizon_hours"] = args.horizon
        if args.no_restoration:
            upd["enable_restoration"] = False
        if args.rounds is not None:
            upd["max_cascade_rounds"] = args.rounds
        if upd:
            sc = sc.model_copy(update=upd)
        r = engine.simulate(sc)
        if args.json:
            print(r.model_dump_json(indent=1))
        else:
            _print_result(r, args.verbose)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
