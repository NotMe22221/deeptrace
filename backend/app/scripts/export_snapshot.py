"""Export an offline snapshot of engine outputs for the frontend.

    cd backend && .venv/bin/python -m app.scripts.export_snapshot

Writes ``public/demo/snapshot.json`` (DemoSnapshot) and refreshes ``public/demo/network.json``.
Everything in the snapshot is produced by the same deterministic engine the live API uses;
the frontend labels it "OFFLINE SNAPSHOT" and only serves scenarios that were precomputed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from datetime import datetime, timezone

from app.config import PUBLIC_DEMO_DIR
from app.ai.offline import run_offline
from app.models.schemas import AnalystContext, AnalystRequest, DemoSnapshot, ScenarioInput
from app.networks.loader import load_demo_script, load_presets
from app.simulation import get_engine
from app.simulation.engine import ENGINE_VERSION

# Node types whose single failure is precomputed for offline "Simulate failure" clicks.
SINGLE_FAILURE_TYPES = {
    "transmission_substation",
    "distribution_substation",
    "network_vault",
    "switch",
    "supply_source",
    "pump_station",
    "storage_tank",
    "internet_exchange",
    "data_center",
    "central_office",
    "fiber_hub",
    "transit_station",
    "gateway",
    "utility_vault",
}


def build_snapshot(single_failures: bool = True) -> DemoSnapshot:
    engine = get_engine()
    net = engine.network
    presets = load_presets(net.region.id)
    demo = load_demo_script(net.region.id)
    if demo is None:
        raise SystemExit("No demo.json for this region — run `python -m app.networks.generate` first")

    t0 = time.perf_counter()
    baseline = engine.baseline()
    metrics = engine.metrics()
    preset_results = {p.id: engine.simulate(p.scenario) for p in presets}

    by_id = {p.id: p for p in presets}
    comparisons = {}
    pa, pb = by_id.get(demo.scenario_a_preset), by_id.get(demo.scenario_b_preset)
    if pa and pb:
        comparisons[f"{pa.id}__{pb.id}"] = engine.compare(pa.scenario, pb.scenario)

    trace_ids = {demo.focus_node_id}
    trace_ids |= {p.focus_node_id for p in presets if p.focus_node_id}
    trace_ids |= {n.id for n in net.nodes if n.type in SINGLE_FAILURE_TYPES or n.system.value == "facility"}
    traces = {nid: engine.trace(nid) for nid in sorted(trace_ids) if any(n.id == nid for n in net.nodes)}

    singles = None
    if single_failures:
        singles = {}
        for n in net.nodes:
            if n.type in SINGLE_FAILURE_TYPES:
                singles[n.id] = engine.simulate(ScenarioInput(name=f"Failure of {n.name}", failed_nodes=[n.id]))

    # Record the offline analyst's answer to the demo question so demo mode can replay it
    # (clearly labelled) if the backend is unavailable during a presentation.
    replays: dict[str, list[dict]] = {}
    ask = next((s for s in demo.steps if s.action == "ask_ai" and s.question), None)
    if ask and pa:
        req = AnalystRequest(
            message=ask.question,
            context=AnalystContext(
                selected_node_id=demo.focus_node_id, active_scenario=pa.scenario, scenario_a=pa.scenario
            ),
        )

        async def _collect() -> list[dict]:
            return [ev async for ev in run_offline(req, engine, note="Replayed from offline snapshot")]

        replays[ask.question] = asyncio.run(_collect())

    snap = DemoSnapshot(
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        engine_version=ENGINE_VERSION,
        network_id=net.id,
        baseline=baseline,
        metrics=metrics,
        presets=presets,
        preset_results=preset_results,
        comparisons=comparisons,
        traces=traces,
        single_failures=singles,
        demo=demo,
        analyst_replays=replays or None,
    )
    print(
        f"snapshot: {len(preset_results)} presets, {len(comparisons)} comparisons, {len(traces)} traces, "
        f"{len(singles or {})} single failures in {time.perf_counter() - t0:.1f}s"
    )
    return snap


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-single-failures", action="store_true", help="skip per-node failure precomputation")
    args = ap.parse_args()
    snap = build_snapshot(single_failures=not args.no_single_failures)
    PUBLIC_DEMO_DIR.mkdir(parents=True, exist_ok=True)
    out = PUBLIC_DEMO_DIR / "snapshot.json"
    out.write_text(json.dumps(snap.model_dump(mode="json"), separators=(",", ":")))
    (PUBLIC_DEMO_DIR / "network.json").write_text(
        json.dumps(get_engine().network.model_dump(mode="json"), separators=(",", ":"))
    )
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
