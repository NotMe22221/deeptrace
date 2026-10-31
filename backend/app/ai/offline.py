"""Deterministic offline analyst (no LLM).

Used when no LLM is configured/reachable, or when the user forces offline mode. It routes
the question to an intent with transparent keyword rules, calls the same controlled tools
as the LLM analyst (so the 3D world reacts identically), and composes a templated answer
strictly from tool outputs. Mitigation suggestions are rule-based and *quantified* by
re-running the scenario through ``evaluate_mitigation``.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from typing import Any

from app.ai.tools import (
    SEVERITY_ORDER,
    ToolContext,
    ToolOutput,
    _indices,
    execute_tool,
)
from app.models.schemas import AnalystRequest, ScenarioInput, SimulationResult

SYSTEM_LABEL = {
    "power": "Electricity",
    "water": "Water",
    "telecom": "Internet",
    "transport": "Transportation",
    "underground": "Underground corridors",
    "facility": "Critical facilities",
}


class _Session:
    def __init__(self, req: AnalystRequest, engine) -> None:
        self.req = req
        self.ctx = ToolContext(engine=engine, context=req.context)
        self.events: list[dict[str, Any]] = []
        self.calls = 0

    @property
    def net(self):
        return self.ctx.network

    def call(self, name: str, args: dict[str, Any]) -> tuple[bool, ToolOutput]:
        self.calls += 1
        tid = f"offline-{self.calls}"
        self.events.append({"type": "tool_call", "id": tid, "name": name, "input": args})
        ok, out = execute_tool(self.ctx, name, args)
        self.events.append({"type": "tool_result", "id": tid, "name": name, "ok": ok, "summary": out.summary})
        for a in out.ui_actions:
            self.events.append({"type": "ui_action", "action": a.model_dump(mode="json")})
        return ok, out

    def name(self, node_id: str) -> str:
        nodes, _ = _indices(self.net)
        n = nodes.get(node_id)
        return n.name if n else node_id


# ---------------------------------------------------------------------------
# Target resolution & intent routing
# ---------------------------------------------------------------------------

_STOP = {
    "what", "which", "happens", "happen", "if", "the", "this", "that", "fails", "fail", "failed", "failure",
    "depends", "depend", "on", "is", "are", "a", "an", "of", "to", "and", "or", "why", "did", "does", "do",
    "would", "could", "we", "can", "how", "most", "important", "component", "components", "network", "in",
    "explain", "consequences", "consequence", "alternative", "routes", "route", "paths", "path", "exist",
    "mitigation", "strategy", "recommend", "you", "me", "show", "tell", "about", "it", "its", "when", "for",
    "differently", "affected", "be", "connection", "connections", "infrastructure", "these", "those", "with",
    "there", "any", "from", "has", "have", "here", "out", "goes", "down", "lose", "loses", "lost",
}


def resolve_target(s: _Session) -> str | None:
    msg = s.req.message
    nodes, _ = _indices(s.net)
    # 1) explicit id in the message
    for tok in re.findall(r"[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+", msg):
        if tok in nodes:
            return tok
    # 2) name match (longest name contained in message, case-insensitive)
    low = msg.lower()
    best = None
    for n in s.net.nodes:
        core = re.sub(r"\(.*?\)", "", n.name).strip().lower()
        if len(core) >= 5 and core in low and (best is None or len(core) > len(best[1])):
            best = (n.id, core)
    if best:
        return best[0]
    # 3) selected component (when the message refers to "this"/"it" or names nothing)
    if s.req.context.selected_node_id and s.req.context.selected_node_id in nodes:
        return s.req.context.selected_node_id
    # 4) keyword search as a last resort
    words = [w for w in re.findall(r"[a-z0-9]+", low) if w not in _STOP and len(w) > 2]
    if words:
        ok, out = execute_tool(s.ctx, "search_components", {"query": " ".join(words), "limit": 1})
        if ok and out.payload.get("matches"):
            return out.payload["matches"][0]["id"]
    return None


def classify(msg: str, has_scenario: bool) -> str:
    m = msg.lower()
    if re.search(r"\bcompar|\bversus\b|\bvs\.?\b|scenario a.*scenario b", m):
        return "compare"
    if re.search(r"provenance|\breal\b(?!-time)|verified|accurate|data source|where does the data|simulated data|made up|fake|trust", m):
        return "provenance"
    if re.search(r"differently|mitigat|prevent|recommend|reduce the impact|improve|resilien|harden", m):
        return "explain_mitigate"
    if re.search(r"\bwhy\b|explain|how did|cause", m) and has_scenario:
        return "explain_mitigate"
    if re.search(r"alternative|reroute|re-route|redundan|backup route|other route|detour", m):
        return "alternatives"
    if re.search(r"most important|most critical|single point|weakest|vulnerab|bottleneck|critical component", m):
        return "metrics"
    if re.search(r"what happens|if .* fail|simulate|consequence|impact of|knock|goes down|outage", m):
        return "simulate"
    if re.search(r"depend|rely|relies|served by|feeds|supplied", m):
        return "dependents"
    if re.search(r"affected", m) and has_scenario:
        return "affected"
    if re.search(r"connect|trace|upstream|downstream|linked", m):
        return "trace"
    if re.search(r"what is|tell me about|details|describe", m):
        return "details"
    return "explain_mitigate" if has_scenario else "details"


# ---------------------------------------------------------------------------
# Answer builders
# ---------------------------------------------------------------------------


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items)


def _sim_overview(s: _Session, p: dict[str, Any]) -> list[str]:
    m = p["metrics"]
    out = [
        f"Severity index **{m['severity_index']:.0f}/100**; **{m['total_nodes_affected']}** components affected "
        f"over **{len(p['cascade_steps'])}** cascade steps (assessed {p['horizon_hours']:g} h after onset)."
    ]
    if m["power_load_unserved_mw"] > 0:
        out.append(f"Electricity: **{m['power_load_unserved_mw']:.1f} MW** of load unserved.")
    if m["water_demand_unserved_lps"] > 0:
        out.append(f"Water: **{m['water_demand_unserved_lps']:.0f} L/s** of demand unserved.")
    if m["telecom_nodes_disconnected"]:
        out.append(f"Internet: **{m['telecom_nodes_disconnected']}** endpoints disconnected from the core.")
    if m["transport_travel_time_increase_pct"] > 0.5:
        out.append(f"Transport: average modelled travel time **+{m['transport_travel_time_increase_pct']:.0f}%**.")
    if m["transit_stations_closed"]:
        out.append(f"Transit: **{m['transit_stations_closed']}** rail station(s) closed.")
    crit = m["critical_facilities_affected"]
    if crit:
        out.append(
            "Critical facilities affected: "
            + ", ".join(f"{c['name']} (`{c['id']}`, {str(c['state']).replace('_', ' ')})" for c in crit[:5])
            + "."
        )
    return out


def _caveat(p: dict[str, Any] | None = None) -> str:
    base = (
        "**Data caveats** — Results come from DEEPTRACE's simplified deterministic model (no AC power flow, "
        "max-flow hydraulics surrogate), not a validated engineering prediction."
    )
    if p is not None:
        prov = p.get("affected_provenance_counts", {})
        if prov:
            parts = ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in sorted(prov.items()))
            base += f" Affected elements by provenance: {parts}; simulated assets are illustrative, not real utility records."
    return base


def _binding_chain(s: _Session, scenario: ScenarioInput, tie_label: str, targets: list[str]) -> list[str]:
    """Iteratively add the next binding element the engine reports for a restoration path.

    Upgrading one bottleneck usually exposes the next one upstream (e.g. the supplying
    feeder's first section), so ask the engine repeatedly until the path is no longer
    capacity-limited or 5 elements are selected.
    """
    from app.ai.tools import _apply_modifications
    from app.simulation.engine import SimulationEngine

    _, edges = _indices(s.net)
    chain = list(targets)
    for _ in range(4):
        mods = [{"kind": "capacity_upgrade", "target_id": t, "factor": 2.0} for t in chain if t in edges and edges[t].capacity]
        if not mods:
            break
        try:
            net, *_rest = _apply_modifications(s.ctx, mods[:5])
            rr = SimulationEngine(net).simulate(scenario)
        except Exception:  # noqa: BLE001 — fall back to what we have
            break
        alt = next((p for p in rr.alternative_paths if tie_label in p.node_ids or tie_label in p.edge_ids), None)
        if alt is None or alt.capacity_ok or "limited by" not in alt.description:
            break
        new = [
            t for t in re.findall(r"[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+", alt.description.split("limited by", 1)[1])
            if t in edges and t not in chain
        ]
        if not new or len(chain) + len(new) > 5:
            break
        chain += new
    return chain


def _mitigation_candidates(s: _Session, r: SimulationResult) -> list[tuple[str, list[dict[str, Any]]]]:
    """Rule-based mitigation candidates derived from structured simulation output.

    Each candidate is (description, modifications) and is later quantified by re-running
    the scenario with ``evaluate_mitigation``.
    """
    nodes, edges = _indices(s.net)
    cands: list[tuple[str, list[dict[str, Any]]]] = []
    seen: set[str] = set()

    def is_power(i: str) -> bool:
        return (i in nodes and nodes[i].system.value == "power") or (
            i in edges and edges[i].infrastructure_type.value == "power"
        )

    hours = max(8.0, r.scenario.horizon_hours * 2)

    # (b) capacity-limited restoration: upgrade the tie unit AND the binding element the
    #     engine names in the alternative path ("limited by ... feeder cable PWR-FDR-0006")
    for p in r.alternative_paths:
        if p.system.value != "power" or p.capacity_ok:
            continue
        tie_edges = [e for e in p.edge_ids if e in edges and edges[e].connection_type == "tie_line"]
        tie_switches = [
            n for n in p.node_ids
            if n in nodes and nodes[n].type == "switch" and nodes[n].properties.get("normally_open")
        ]
        limit_text = p.description.split("limited by", 1)[1] if "limited by" in p.description else ""
        binding = [t for t in re.findall(r"[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+", limit_text) if t in edges or t in nodes]
        targets = list(dict.fromkeys(tie_edges + binding))
        key = "|".join(sorted(targets))
        if not targets or key in seen:
            continue
        seen.add(key)
        mods = [{"kind": "capacity_upgrade", "target_id": t, "factor": 2.0} for t in targets
                if (t in edges and edges[t].capacity) or (t in nodes and nodes[t].capacity)]
        if not mods:
            continue
        label = tie_switches[0] if tie_switches else targets[0]
        targets = _binding_chain(s, r.scenario, label, targets)
        mods = [{"kind": "capacity_upgrade", "target_id": t, "factor": 2.0} for t in targets
                if (t in edges and edges[t].capacity) or (t in nodes and nodes[t].capacity)]
        what = ", ".join(f"`{t}`" for t in targets[:5])
        cands.append(
            (
                f"Reinforce the restoration path through tie `{label}` (double the rating of {what}); automatic restoration was capacity-limited there.",
                mods[:5],
            )
        )
        if sum(1 for c in cands if c[1][0]["kind"] == "capacity_upgrade") >= 3:
            break

    # (b2) elements that tripped on overload (a genuine cascade): uprate them
    tripped = [ie.edge_id for ie in r.interrupted_edges if ie.state == "failed" and ie.step > 0 and "trip" in ie.reason.lower()]
    tripped += [a.node_id for a in r.affected_nodes if a.state == "failed" and a.step > 0 and "trip" in a.cause.lower()]
    for t in tripped[:2]:
        if t in seen:
            continue
        seen.add(t)
        nm = edges[t].name if t in edges and edges[t].name else s.name(t)
        cands.append(
            (
                f"Uprate `{t}` ({nm}) so it can carry the transferred load: it tripped on overload and turned a supply loss into a blackout.",
                [{"kind": "capacity_upgrade", "target_id": t, "factor": 1.5}],
            )
        )

    # (a) consumers that lost their function because they lost power and lack backup
    priority = {"hospital": 0, "pump_station": 0, "internet_exchange": 1, "data_center": 1, "central_office": 2,
                "transit_station": 3, "cell_site": 4, "access_node": 5}
    power_victims = [
        a for a in r.affected_nodes
        if a.system.value not in ("power", "underground")
        and a.state in ("failed", "outage", "closed")
        and a.node_id in nodes
        and nodes[a.node_id].type in priority
        and (any(is_power(c) for c in a.caused_by) or "power" in a.cause.lower())
    ]
    power_victims.sort(key=lambda a: (priority.get(nodes[a.node_id].type, 9), SEVERITY_ORDER[a.severity], a.node_id))
    for a in power_victims[:3]:
        if a.node_id in seen:
            continue
        seen.add(a.node_id)
        cands.append(
            (
                f"Add {hours:g} h of backup power at {s.name(a.node_id)} (`{a.node_id}`), which goes dark because its backup does not cover the {r.scenario.horizon_hours:g} h horizon.",
                [{"kind": "backup_power", "target_id": a.node_id, "hours": hours}],
            )
        )

    # (c) common-cause corridor failure hitting telecom
    corridor_edges = [e for e in r.scenario.failed_edges if e in edges and edges[e].infrastructure_type.value == "underground"]
    for cid in corridor_edges:
        hosted = [h for h in edges[cid].properties.get("hosted_edge_ids", []) if h in edges]
        fibre = [h for h in hosted if edges[h].infrastructure_type.value == "telecom"]
        if fibre and cid not in seen:
            seen.add(cid)
            cands.append(
                (
                    f"Route the fibre in duct bank `{cid}` ({', '.join(f'`{f}`' for f in fibre[:3])}) along a physically diverse path, since one excavation strike currently cuts power and internet together.",
                    [{"kind": "separate_corridor", "target_id": f} for f in fibre[:5]],
                )
            )
    # (d) telecom endpoints disconnected from every core: dual-home them to the nearest other hub
    disconnected = [a.node_id for a in r.affected_nodes if a.system.value == "telecom" and a.state == "disconnected"]
    if disconnected:
        import math

        neighbours: dict[str, set[str]] = {}
        for e in s.net.edges:
            if e.relation.value == "physical":
                neighbours.setdefault(e.source_node, set()).add(e.target_node)
                neighbours.setdefault(e.target_node, set()).add(e.source_node)
        failed = set(r.scenario.failed_nodes)
        hubs = [n for n in s.net.nodes if n.type == "fiber_hub" and n.id not in failed]
        mods = []
        for nid in disconnected[:3]:
            a = nodes[nid]
            options = [h for h in hubs if h.id not in neighbours.get(nid, set())]
            if not options:
                continue
            best = min(options, key=lambda h: math.hypot(h.latitude - a.latitude, (h.longitude - a.longitude) * 0.83))
            mods.append({"kind": "add_connection", "target_id": nid, "to_node_id": best.id})
        if mods:
            names = ", ".join(f"{s.name(m['target_id'])} → {s.name(m['to_node_id'])}" for m in mods)
            cands.append(
                (f"Dual-home the single-homed sites with a second fibre lateral ({names}), so losing one hub or core no longer disconnects them.", mods)
            )
    return cands


def _qualitative_mitigations(r: SimulationResult) -> list[str]:
    tips: list[str] = []
    states = {a.state for a in r.affected_nodes}
    causes = " ".join(a.cause.lower() for a in r.affected_nodes)
    if "isolated" in states:
        tips.append("Add isolation valves on long main segments so a rupture isolates fewer service zones.")
    if "manual" in causes or "scada" in causes:
        tips.append("Give switch SCADA links independent backup communications so automatic restoration does not wait for crews.")
    if "disconnected" in states:
        tips.append("Dual-home single-homed fibre spurs to a second hub to remove single points of failure.")
    if "delayed" in states or "inaccessible" in states:
        tips.append("Pre-plan signal battery backups and detour timing on emergency access corridors.")
    return tips


def answer_simulation(s: _Session, target: str | None, scenario: ScenarioInput | None) -> str:
    if scenario is None:
        if not target:
            return "I couldn't tell which component to fail. Select a component or name it (e.g. a substation id) and ask again."
        scenario = ScenarioInput(name=f"Failure of {s.name(target)}", failed_nodes=[target])
    ok, out = s.call(
        "run_failure_simulation",
        {
            "failed_nodes": scenario.failed_nodes,
            "failed_edges": scenario.failed_edges,
            "horizon_hours": scenario.horizon_hours,
            "enable_restoration": scenario.enable_restoration,
            "name": scenario.name or None,
        },
    )
    if not ok:
        return f"The simulation could not run: {out.payload.get('error')}"
    p = out.payload
    failed = ", ".join(f"{f['name']} (`{f['id']}`)" for f in p["failed_nodes"]) or ", ".join(f"`{e}`" for e in p["failed_edges"])
    steps = [f"**Step {c['step']}**: {_short(c['label'], 200)}" for c in p["cascade_steps"][:6]]
    alts = [_short(a["description"], 200) + ("" if a["capacity_ok"] else " _(capacity-limited)_") for a in p["alternative_paths"][:4]]
    parts = [
        f"If {failed} fails, the modelled cascade spreads across "
        f"{len({c['system'] for c in p['affected_components']})} system(s).",
        "**What the simulation shows**\n" + _bullets(_sim_overview(s, p)),
        "**How it cascades**\n" + _bullets(steps),
    ]
    if alts:
        parts.append("**Alternatives & redundancy**\n" + _bullets(alts))
    parts.append(_caveat(p))
    return "\n\n".join(parts)


def _short(text: str, limit: int = 170) -> str:
    """First clause of an engine sentence, bounded in length."""
    t = text.split("; ")[0].strip()
    return t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0] + "…"


def _consequence_lines(s: _Session, r: SimulationResult) -> list[str]:
    """Group the most serious consequences by system instead of listing every element."""
    nodes, _ = _indices(s.net)
    lines: list[str] = []
    initiating = set(r.failed_nodes)
    power_out = [a for a in r.affected_nodes if a.system.value == "power" and a.state in ("de_energized", "failed") and a.node_id not in initiating]
    restored = [a for a in r.affected_nodes if a.state == "restored"]
    if power_out or restored:
        lines.append(
            f"Electricity: {len(power_out)} element(s) remain de-energised"
            + (f", {len(restored)} restored by automatic tie switching" if restored else "")
            + f" ({r.impact_metrics.power_load_unserved_mw:.1f} MW unserved)."
        )
    order = ("facility", "water", "telecom", "transport")
    for sysname in order:
        rows = [
            a for a in r.affected_nodes
            if a.system.value == sysname and a.state not in ("restored", "rerouted", "operational") and a.node_id not in initiating
        ]
        if not rows:
            continue
        rows.sort(key=lambda a: (SEVERITY_ORDER[a.severity], a.step, a.node_id))
        by_state: dict[str, list[str]] = {}
        for a in rows:
            by_state.setdefault(a.state.replace("_", " "), []).append(s.name(a.node_id))
        parts = []
        for state, names in by_state.items():
            shown = ", ".join(names[:3]) + (f" +{len(names) - 3} more" if len(names) > 3 else "")
            parts.append(f"{state}: {shown}")
        lines.append(f"{SYSTEM_LABEL[sysname]}: " + "; ".join(parts) + ".")
    return lines


def _initiating(s: _Session, scenario: ScenarioInput) -> str:
    """Name the scenario's own failed elements (not the engine-expanded hosted edges)."""
    _, edges = _indices(s.net)
    parts = [f"{s.name(n)} (`{n}`)" for n in scenario.failed_nodes]
    parts += [f"{edges[e].name or e} (`{e}`)" if e in edges else f"`{e}`" for e in scenario.failed_edges]
    return ", ".join(parts) or "the selected elements"


def answer_explain_mitigate(s: _Session, target: str | None) -> str:
    scenario = s.req.context.active_scenario
    if scenario is None:
        if not target:
            return (
                "There is no scenario loaded to explain. Run a failure simulation (or ask “what happens if … fails?”) "
                "and I'll explain the cascade and recommend mitigations."
            )
        scenario = ScenarioInput(name=f"Failure of {s.name(target)}", failed_nodes=[target])
    scen_args = {
        "failed_nodes": scenario.failed_nodes,
        "failed_edges": scenario.failed_edges,
        "horizon_hours": scenario.horizon_hours,
        "enable_restoration": scenario.enable_restoration,
    }
    ok, out = s.call("get_affected_components", {**scen_args, "min_severity": "minor"})
    if not ok:
        return f"I couldn't analyse the scenario: {out.payload.get('error')}"
    result = s.ctx.results[out.payload["scenario_id"]]
    from app.ai.tools import summarize_result

    p = summarize_result(s.ctx, result)
    initiating = _initiating(s, scenario)
    why = [f"**Step {c['step']}**: {_short(c['label'], 200)}" for c in p["cascade_steps"][:6]]

    # Quantify every candidate with the engine, then rank by modelled severity reduction.
    ranked: list[tuple[float, str]] = []
    no_effect: list[str] = []
    for text, mods in _mitigation_candidates(s, result)[:7]:
        ok2, out2 = s.call("evaluate_mitigation", {"scenario": scen_args, "modifications": mods})
        if not ok2:
            continue
        ch = {c["metric"]: c for c in out2.payload["metric_changes"]}
        sev, aff = ch["Severity index"], ch["Components affected"]
        gain = sev["before"] - sev["after"]
        saved = out2.payload["critical_facilities_no_longer_affected"]
        effect = f"severity {sev['before']:.0f} → {sev['after']:.0f}, affected components {aff['before']:.0f} → {aff['after']:.0f}"
        if ch["Power unserved"]["change"] < -0.05:
            effect += f", unserved power {ch['Power unserved']['before']:.1f} → {ch['Power unserved']['after']:.1f} MW"
        if saved:
            effect += "; protects " + ", ".join(x["name"] for x in saved[:3])
        if gain > 0.05 or saved:
            ranked.append((gain, f"{text} **Modelled effect:** {effect}."))
        else:
            title = text.split(",")[0].split(" (")[0].strip()
            if title:
                no_effect.append(title)
    ranked.sort(key=lambda x: -x[0])
    mit = [t for _, t in ranked[:3]]
    if no_effect:
        mit.append(
            "Tested with no modelled improvement (another limit binds): " + "; ".join(no_effect[:2]) + "."
        )
    quantified_text = " ".join(mit)
    mit += [
        tip for tip in _qualitative_mitigations(result)
        if not (tip.startswith("Dual-home") and "Dual-home" in quantified_text)
    ]

    lead = (
        f"The cascade starts at {initiating}. It spreads because the affected section has no alternative supply with "
        f"enough spare capacity, and other systems depend on it without enough backup for the "
        f"{scenario.horizon_hours:g} h horizon."
    )
    parts = [
        lead,
        "**What the simulation shows**\n" + _bullets(_sim_overview(s, p)),
        "**Why it cascades**\n" + _bullets(why),
    ]
    cons = _consequence_lines(s, result)
    if cons:
        parts.append("**Consequences by system**\n" + _bullets(cons))
    if p["alternative_paths"]:
        parts.append(
            "**What already helped**\n"
            + _bullets([_short(a["description"], 200) + ("" if a["capacity_ok"] else " _(capacity-limited)_") for a in p["alternative_paths"][:3]])
        )
    if mit:
        parts.append("**What we could do differently**\n" + _bullets(mit))
    parts.append(_caveat(p))
    return "\n\n".join(parts)


def answer_dependents(s: _Session, target: str | None) -> str:
    if not target:
        return "Select a component (or name it) and I'll list what depends on it."
    ok, out = s.call("trace_network_path", {"node_id": target})
    if not ok:
        return f"Trace failed: {out.payload.get('error')}"
    p = out.payload
    ok2, det = s.call("get_component_details", {"node_id": target})
    by_sys: dict[str, list[str]] = {}
    for h in p["dependents (cross-system consumers)"]:
        by_sys.setdefault(h["system"], []).append(f"{h['name']} (`{h['id']}`)")
    lines = [f"**{SYSTEM_LABEL.get(k, k)}** ({len(v)}): " + ", ".join(v[:8]) + (" …" if len(v) > 8 else "") for k, v in sorted(by_sys.items())]
    d = det.payload if ok2 else {}
    crit = ""
    if d.get("criticality_rank_n_minus_1"):
        crit = (
            f" In single-failure (N-1) analysis it ranks **#{d['criticality_rank_n_minus_1']}**"
            f" ({d.get('nodes_affected_by_single_failure')} components affected if it fails)"
            + (" and is a **single point of failure**." if d.get("is_single_point_of_failure") else ".")
        )
    parts = [
        f"{s.name(target)} (`{target}`) serves **{p['downstream_total']}** downstream elements in its own network and "
        f"**{p['dependents_total']}** components in other systems depend on it.{crit}",
        "**Cross-system dependents**\n" + (_bullets(lines) if lines else "- none modelled"),
        "**Upstream supply**: " + (" → ".join(p["source_paths"][0]) if p["source_paths"] else "it is a source / core node."),
        _caveat(),
    ]
    return "\n\n".join(parts)


def answer_alternatives(s: _Session, target: str | None) -> str:
    scenario = s.req.context.active_scenario
    if scenario is None and target:
        scenario = ScenarioInput(name=f"Failure of {s.name(target)}", failed_nodes=[target])
    if scenario is None:
        return "Load or run a scenario (or select a component) and I'll list the alternative paths the model finds."
    ok, out = s.call(
        "run_failure_simulation",
        {
            "failed_nodes": scenario.failed_nodes,
            "failed_edges": scenario.failed_edges,
            "horizon_hours": scenario.horizon_hours,
            "enable_restoration": scenario.enable_restoration,
            "name": scenario.name,
        },
    )
    if not ok:
        return f"The simulation could not run: {out.payload.get('error')}"
    alts = out.payload["alternative_paths"]
    if not alts:
        return "The model finds **no alternative paths** for this scenario — affected elements have no redundant supply.\n\n" + _caveat(out.payload)
    lines = [f"**{a['system']} · {a['purpose']}** — {a['description']}" + ("" if a["capacity_ok"] else " _(capacity-limited)_") for a in alts]
    return (
        f"The engine found **{len(alts)}** alternative path(s); they are illuminated in green in the 3D view.\n\n"
        + _bullets(lines)
        + f"\n\nRedundancy score: **{out.payload['metrics']['redundancy_score']:.0%}** of initially lost demand recovered.\n\n"
        + _caveat(out.payload)
    )


def answer_metrics(s: _Session) -> str:
    ok, out = s.call("get_network_metrics", {"top_n": 8})
    if not ok:
        return f"Metrics unavailable: {out.payload.get('error')}"
    p = out.payload
    rank = [
        f"#{c['rank']} {c['name']} (`{c['id']}`, {c['system']}) — severity {c['severity_index']:.0f}, "
        f"{c['nodes_affected']} components affected"
        for c in p["criticality_ranking_n_minus_1"][:6]
    ]
    spof = []
    for sysm in p["systems"]:
        if sysm["articulation_points_total"]:
            spof.append(
                f"{SYSTEM_LABEL.get(sysm['system'], sysm['system'])}: {sysm['articulation_points_total']} articulation points, "
                f"redundancy {sysm['redundancy_fraction']:.0%}"
            )
    top = p["criticality_ranking_n_minus_1"][0] if p["criticality_ranking_n_minus_1"] else None
    lead = (
        f"The most important component is **{top['name']}** (`{top['id']}`): failing it alone produces the highest modelled severity ({top['severity_index']:.0f}/100)."
        if top
        else "No ranking available."
    )
    return "\n\n".join(
        [
            lead,
            "**N-1 criticality ranking** (each component failed on its own)\n" + _bullets(rank),
            "**Structural weak points**\n" + _bullets(spof or ["none"]),
            "_Method: deterministic single-failure simulation of each component, ranked by severity index._",
            _caveat(),
        ]
    )


def answer_compare(s: _Session) -> str:
    ok, out = s.call("compare_scenarios", {})
    if not ok:
        return (
            "To compare, store two scenarios first (run one as **A** and another as **B** in the Simulation Center), then ask again.\n\n"
            f"_({out.payload.get('error')})_"
        )
    p = out.payload
    rows = [
        f"{m['label']}: A **{m['a']:.1f}** vs B **{m['b']:.1f}** {m['unit']}".rstrip()
        + ("" if m["worse"] == "equal" else f" — worse in **{m['worse'].upper()}**")
        for m in p["metrics"]
    ]
    return "\n\n".join(
        [
            p["verdict"],
            "**Side by side**\n" + _bullets(rows),
            f"Only in A: **{p['only_in_a_count']}** · only in B: **{p['only_in_b_count']}** · both: **{p['in_both_count']}** affected components (diff shown on the map).",
            _caveat(),
        ]
    )


def answer_provenance(s: _Session, target: str | None) -> str:
    if target and re.search(r"this|it|component|selected", s.req.message.lower()):
        ok, out = s.call("get_data_provenance", {"node_id": target})
        if ok:
            pv = out.payload["provenance"]
            return (
                f"{s.name(target)} (`{target}`) is **{pv['category'].replace('_', ' ').upper()}** "
                f"(confidence {pv['confidence']:.0%}). Source: {pv['source']}."
                + (f"\n\n{pv['notes']}" if pv.get("notes") else "")
            )
    ok, out = s.call("get_data_provenance", {})
    p = out.payload
    lines = [
        f"**{SYSTEM_LABEL.get(k, k)}**: " + ", ".join(f"{n} {c.replace('_', ' ')}" for c, n in sorted(v.items()))
        for k, v in sorted(p["counts_by_system"].items())
    ]
    ds = [f"{d['name']} — {d['category'].replace('_', ' ')}{' (not present in this build)' if not d['feature_count'] else ''}" for d in p["datasets"]]
    return "\n\n".join(
        [
            "DEEPTRACE labels every element as verified, publicly mapped, estimated or simulated. "
            "In this build the utility topology is **simulated** (illustrative), and named public places have **estimated** locations.",
            "**Elements by provenance**\n" + _bullets(lines),
            "**Datasets**\n" + _bullets(ds),
        ]
    )


def answer_trace(s: _Session, target: str | None) -> str:
    if not target:
        return "Select a component (or name it) to trace its connections."
    ok, out = s.call("trace_network_path", {"node_id": target})
    if not ok:
        return f"Trace failed: {out.payload.get('error')}"
    p = out.payload
    return "\n\n".join(
        [
            p["summary"],
            f"- Upstream elements: **{p['upstream_total']}**\n- Downstream elements: **{p['downstream_total']}**\n"
            f"- Cross-system providers: **{len(p['dependencies (cross-system providers)'])}**\n"
            f"- Cross-system dependents: **{p['dependents_total']}**",
            "**Supply path**: " + (" → ".join(p["source_paths"][0]) if p["source_paths"] else "source/core node"),
            "The trace is drawn in 3D: solid lines are physical connections, dashed arcs are logical dependencies.",
        ]
    )


def answer_details(s: _Session, target: str | None) -> str:
    if not target:
        return (
            "I can answer questions about the loaded network using the simulation engine, for example:\n"
            "- “What depends on this component?” (select one first)\n"
            "- “What happens if the Five Points substation fails?”\n"
            "- “Why did this happen, and what could we do differently?” (after a simulation)\n"
            "- “Which component is the most important in this network?”\n"
            "- “What alternative routes exist?” · “Compare scenario A and B” · “Is this data real?”"
        )
    ok, out = s.call("get_component_details", {"node_id": target})
    if not ok:
        return f"Lookup failed: {out.payload.get('error')}"
    d = out.payload
    pv = d["provenance"]
    lines = [
        f"Type: {d['type'].replace('_', ' ')} ({d['system']})",
        f"Position: {d['latitude']:.5f}, {d['longitude']:.5f} ({d['elevation_m_relative_to_ground']:+.0f} m relative to ground)",
    ]
    if d.get("capacity") is not None:
        lines.append(f"Capacity: {d['capacity']} {d.get('capacity_unit') or ''}")
    if d.get("demand") is not None:
        lines.append(f"Modelled demand: {d['demand']} {d.get('capacity_unit') or ''}")
    lines.append(f"Provenance: **{pv['category'].replace('_', ' ')}** ({pv['confidence']:.0%}) — {pv['source']}")
    if d.get("criticality_rank_n_minus_1"):
        lines.append(f"N-1 criticality rank: #{d['criticality_rank_n_minus_1']}")
    lines.append(f"Providers: {len(d['dependencies (providers)'])} · dependents: {d['dependents_total']}")
    return f"**{d['name']}** (`{d['id']}`)\n\n" + _bullets(lines)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _plan_and_answer(req: AnalystRequest, engine) -> tuple[list[dict[str, Any]], str, int]:
    s = _Session(req, engine)
    has_scenario = req.context.active_scenario is not None
    intent = classify(req.message, has_scenario)
    target = resolve_target(s) if intent not in ("metrics", "compare") else None
    if intent == "simulate":
        text = answer_simulation(s, target, None if target else req.context.active_scenario)
    elif intent == "explain_mitigate":
        text = answer_explain_mitigate(s, target)
    elif intent == "dependents":
        text = answer_dependents(s, target)
    elif intent == "alternatives":
        text = answer_alternatives(s, target)
    elif intent == "metrics":
        text = answer_metrics(s)
    elif intent == "compare":
        text = answer_compare(s)
    elif intent == "provenance":
        text = answer_provenance(s, target)
    elif intent == "trace":
        text = answer_trace(s, target)
    elif intent == "affected":
        text = answer_explain_mitigate(s, target)
    else:
        text = answer_details(s, target)
    return s.events, text, s.calls


async def run_offline(req: AnalystRequest, engine, note: str | None = None) -> AsyncIterator[dict[str, Any]]:
    yield {"type": "status", "mode": "offline", "model": None, "note": note}
    try:
        events, text, calls = await asyncio.to_thread(_plan_and_answer, req, engine)
    except Exception as exc:  # noqa: BLE001
        yield {"type": "error", "message": f"Offline analyst failed: {type(exc).__name__}: {exc}"}
        yield {"type": "done", "tool_calls": 0, "mode": "offline"}
        return
    for ev in events:
        yield ev
        if ev["type"] == "tool_result":
            await asyncio.sleep(0.12)  # let the UI show tool progress
    footer = "\n\n_Offline analyst — deterministic rules over DEEPTRACE tool outputs (no LLM)._"
    yield {"type": "message", "text": text + footer}
    yield {"type": "done", "tool_calls": calls, "mode": "offline"}
