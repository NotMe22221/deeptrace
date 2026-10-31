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
    if re.search(r"provenance|is (this|it) real|verified|accurate|data source|where does the data|real data|simulated data", m):
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


def _mitigation_candidates(s: _Session, r: SimulationResult) -> list[tuple[str, dict[str, Any]]]:
    """Rule-based mitigation candidates derived from structured simulation output."""
    nodes, edges = _indices(s.net)
    cands: list[tuple[str, dict[str, Any]]] = []
    seen: set[str] = set()

    def is_power(i: str) -> bool:
        return (i in nodes and nodes[i].system.value == "power") or (
            i in edges and edges[i].infrastructure_type.value == "power"
        )

    # (a) consumers that lost function because they lost power and lack backup
    priority = {"pump_station": 0, "internet_exchange": 1, "data_center": 1, "central_office": 2, "hospital": 0,
                "transit_station": 3, "cell_site": 4}
    power_victims = [
        a for a in r.affected_nodes
        if a.system.value not in ("power", "underground")
        and a.state in ("failed", "outage", "closed")
        and a.node_id in nodes
        and nodes[a.node_id].type in priority
        and (any(is_power(c) for c in a.caused_by) or "power" in a.cause.lower())
    ]
    power_victims.sort(key=lambda a: (priority.get(nodes[a.node_id].type, 9), SEVERITY_ORDER[a.severity], a.node_id))
    for a in power_victims[:2]:
        if a.node_id in seen:
            continue
        seen.add(a.node_id)
        hours = max(8.0, r.scenario.horizon_hours * 2)
        cands.append(
            (
                f"Add {hours:g} h of backup generation/batteries at {s.name(a.node_id)} (`{a.node_id}`) — it fails because it has no backup for the outage horizon.",
                {"kind": "backup_power", "target_id": a.node_id, "hours": hours},
            )
        )

    # (b) capacity-limited restoration through tie lines
    for p in r.alternative_paths:
        if p.system.value == "power" and not p.capacity_ok:
            tie = next((e for e in p.edge_ids if e in edges and edges[e].connection_type == "tie_line"), None)
            if tie and tie not in seen:
                seen.add(tie)
                cands.append(
                    (
                        f"Increase the rating of tie `{tie}` (or add a second tie) — automatic restoration was capacity-limited.",
                        {"kind": "capacity_upgrade", "target_id": tie, "factor": 2.0},
                    )
                )
                break

    # (c) common-cause corridor failure hitting telecom
    corridor_edges = [e for e in r.scenario.failed_edges if e in edges and edges[e].infrastructure_type.value == "underground"]
    for cid in corridor_edges:
        hosted = [h for h in edges[cid].properties.get("hosted_edge_ids", []) if h in edges]
        fibre = next((h for h in hosted if edges[h].infrastructure_type.value == "telecom"), None)
        if fibre and fibre not in seen:
            seen.add(fibre)
            cands.append(
                (
                    f"Route fibre `{fibre}` through a physically diverse path instead of shared duct bank `{cid}` — one excavation strike currently cuts power and internet together.",
                    {"kind": "separate_corridor", "target_id": fibre},
                )
            )

    # (d) unbacked telecom sites
    for a in r.affected_nodes:
        if a.system.value == "telecom" and a.state in ("failed", "outage") and a.node_id not in seen and len(cands) < 4:
            if any(is_power(c) for c in a.caused_by):
                seen.add(a.node_id)
                cands.append(
                    (
                        f"Extend battery backup at {s.name(a.node_id)} (`{a.node_id}`) beyond the {r.scenario.horizon_hours:g} h horizon.",
                        {"kind": "backup_power", "target_id": a.node_id, "hours": max(8.0, r.scenario.horizon_hours * 2)},
                    )
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
    steps = [f"**Step {c['step']} — {c['label']}**: {c['description']}" for c in p["cascade_steps"][:6]]
    alts = [f"{a['description']}" + ("" if a["capacity_ok"] else " _(capacity-limited)_") for a in p["alternative_paths"][:4]]
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


def answer_explain_mitigate(s: _Session, target: str | None) -> str:
    scenario = s.req.context.active_scenario
    if scenario is None:
        if not target:
            return (
                "There is no scenario loaded to explain. Run a failure simulation (or ask “what happens if … fails?”) "
                "and I'll explain the cascade and recommend mitigations."
            )
        scenario = ScenarioInput(name=f"Failure of {s.name(target)}", failed_nodes=[target])
    ok, out = s.call(
        "get_affected_components",
        {
            "failed_nodes": scenario.failed_nodes,
            "failed_edges": scenario.failed_edges,
            "horizon_hours": scenario.horizon_hours,
            "enable_restoration": scenario.enable_restoration,
            "min_severity": "minor",
        },
    )
    if not ok:
        return f"I couldn't analyse the scenario: {out.payload.get('error')}"
    result = next(iter(s.ctx.results.values()))
    from app.ai.tools import summarize_result

    p = summarize_result(s.ctx, result)
    initiating = ", ".join(f"{f['name']} (`{f['id']}`)" for f in p["failed_nodes"]) or ", ".join(
        f"`{e}`" for e in p["failed_edges"]
    )
    why = [f"**Step {c['step']} — {c['label']}**: {c['description']}" for c in p["cascade_steps"][:7]]
    worst = [
        f"{c['name']} (`{c['id']}`) — {c['state'].replace('_', ' ')}: {c['cause']}"
        for c in p["affected_components"]
        if c["severity"] in ("critical", "major")
    ][:5]

    cands = _mitigation_candidates(s, result)
    quantified: list[str] = []
    for text, mod in cands[:3]:
        ok2, out2 = s.call(
            "evaluate_mitigation",
            {
                "scenario": {
                    "failed_nodes": scenario.failed_nodes,
                    "failed_edges": scenario.failed_edges,
                    "horizon_hours": scenario.horizon_hours,
                    "enable_restoration": scenario.enable_restoration,
                },
                "modifications": [mod],
            },
        )
        if ok2:
            ch = {c["metric"]: c for c in out2.payload["metric_changes"]}
            sev = ch["Severity index"]
            aff = ch["Components affected"]
            saved = out2.payload["critical_facilities_no_longer_affected"]
            effect = (
                f"severity {sev['before']:.0f} → {sev['after']:.0f}, components affected {aff['before']:.0f} → {aff['after']:.0f}"
            )
            if saved:
                effect += "; protects " + ", ".join(x["name"] for x in saved[:3])
            quantified.append(f"{text} **Modelled effect:** {effect}.")
        else:
            quantified.append(text)
    qual = _qualitative_mitigations(result)

    lead = (
        f"The cascade starts at {initiating} and propagates because downstream components have no alternative supply "
        f"with enough capacity, and other systems depend on them without sufficient backup."
    )
    parts = [lead, "**What the simulation shows**\n" + _bullets(_sim_overview(s, p)), "**Why it cascades**\n" + _bullets(why)]
    if worst:
        parts.append("**Most serious consequences**\n" + _bullets(worst))
    if p["alternative_paths"]:
        parts.append(
            "**What already helped**\n"
            + _bullets(
                [a["description"] + ("" if a["capacity_ok"] else " _(capacity-limited)_") for a in p["alternative_paths"][:4]]
            )
        )
    mit = quantified + qual
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
