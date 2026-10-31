"""Controlled tool surface for the AI Infrastructure Analyst.

The analyst (LLM or deterministic offline mode) can only learn about the network and
simulations through these functions. Each tool:

* validates every id against the loaded network (unknown ids -> error with suggestions),
* calls the real :class:`~app.simulation.engine.SimulationEngine`,
* returns a compact JSON payload for the model (token-efficient, provenance-aware),
* returns a one-line human summary (streamed to the UI as tool activity),
* returns :class:`UIAction` instructions derived *from the tool result* so the 3D world
  reacts to what the analyst actually computed (never to free-form model text).
"""

from __future__ import annotations

import copy
import difflib
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from app.models.schemas import (
    AnalystContext,
    InfrastructureEdge,
    InfrastructureNetwork,
    InfrastructureNode,
    ScenarioInput,
    SimulationResult,
    UIAction,
)

SEVERITY_ORDER = {"critical": 0, "major": 1, "minor": 2, "info": 3}
SYSTEMS = ["power", "water", "telecom", "transport", "underground", "facility"]


class ToolError(Exception):
    """Raised for invalid tool input; surfaced to the model as an is_error tool_result."""


@dataclass
class ToolOutput:
    payload: dict[str, Any]
    summary: str
    ui_actions: list[UIAction] = field(default_factory=list)


@dataclass
class ToolContext:
    engine: Any  # SimulationEngine (typed loosely to avoid an import cycle at module load)
    context: AnalystContext
    #: results produced during this conversation turn, keyed by scenario_id
    results: dict[str, SimulationResult] = field(default_factory=dict)

    @property
    def network(self) -> InfrastructureNetwork:
        return self.engine.network


# ---------------------------------------------------------------------------
# Lookups & validation
# ---------------------------------------------------------------------------


_INDEX_CACHE: dict[int, tuple[InfrastructureNetwork, dict[str, InfrastructureNode], dict[str, InfrastructureEdge]]] = {}


def _indices(net: InfrastructureNetwork) -> tuple[dict[str, InfrastructureNode], dict[str, InfrastructureEdge]]:
    """id -> node / edge maps, cached per network object identity."""
    hit = _INDEX_CACHE.get(id(net))
    if hit is None or hit[0] is not net:
        if len(_INDEX_CACHE) > 8:
            _INDEX_CACHE.clear()
        hit = (net, {n.id: n for n in net.nodes}, {e.id: e for e in net.edges})
        _INDEX_CACHE[id(net)] = hit
    return hit[1], hit[2]


def _suggest(ident: str, pool: list[str]) -> list[str]:
    return difflib.get_close_matches(ident, pool, n=5, cutoff=0.45)


def require_node(ctx: ToolContext, node_id: str) -> InfrastructureNode:
    nodes, _ = _indices(ctx.network)
    node = nodes.get(node_id)
    if node is None:
        hint = _suggest(node_id, list(nodes))
        raise ToolError(
            f"Unknown node id '{node_id}'. Use search_components to find ids."
            + (f" Close matches: {', '.join(hint)}" if hint else "")
        )
    return node


def require_edge(ctx: ToolContext, edge_id: str) -> InfrastructureEdge:
    _, edges = _indices(ctx.network)
    edge = edges.get(edge_id)
    if edge is None:
        hint = _suggest(edge_id, list(edges))
        raise ToolError(f"Unknown edge id '{edge_id}'." + (f" Close matches: {', '.join(hint)}" if hint else ""))
    return edge


def node_ref(node: InfrastructureNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "name": node.name,
        "system": node.system.value,
        "type": node.type,
        "provenance": node.provenance.category.value,
    }


def _name(ctx: ToolContext, node_id: str) -> str:
    nodes, _ = _indices(ctx.network)
    n = nodes.get(node_id)
    return n.name if n else node_id


def _prov(p) -> dict[str, Any]:
    return {
        "category": p.category.value,
        "source": p.source,
        "confidence": p.confidence,
        "notes": p.notes,
        "license": p.license,
        "retrieved_at": p.retrieved_at,
    }


def _scenario_from_args(ctx: ToolContext, args: dict[str, Any], fallback: ScenarioInput | None) -> ScenarioInput:
    failed_nodes = list(dict.fromkeys(args.get("failed_nodes") or []))
    failed_edges = list(dict.fromkeys(args.get("failed_edges") or []))
    if not failed_nodes and not failed_edges:
        if fallback is None:
            raise ToolError(
                "No failure specified. Provide failed_nodes and/or failed_edges (ids), "
                "or ask about the scenario currently shown in the app."
            )
        return fallback
    for n in failed_nodes:
        require_node(ctx, n)
    for e in failed_edges:
        require_edge(ctx, e)
    stype = args.get("scenario_type") or _infer_scenario_type(ctx, failed_nodes, failed_edges)
    return ScenarioInput(
        name=args.get("name"),
        scenario_type=stype,
        failed_nodes=failed_nodes,
        failed_edges=failed_edges,
        horizon_hours=float(args.get("horizon_hours", fallback.horizon_hours if fallback else 4.0)),
        enable_restoration=bool(args.get("enable_restoration", True)),
    )


def _infer_scenario_type(ctx: ToolContext, nodes: list[str], edges: list[str]) -> str:
    nmap, emap = _indices(ctx.network)
    systems = [nmap[n].system.value for n in nodes if n in nmap] + [
        emap[e].infrastructure_type.value for e in edges if e in emap
    ]
    if "underground" in systems:
        return "corridor_strike"
    mapping = {"power": "power_failure", "water": "water_rupture", "telecom": "telecom_outage", "transport": "road_disruption"}
    kinds = {mapping.get(s, "custom") for s in systems}
    return kinds.pop() if len(kinds) == 1 else "custom"


def _run(ctx: ToolContext, scenario: ScenarioInput) -> SimulationResult:
    try:
        result = ctx.engine.simulate(scenario)
    except ValueError as exc:  # engine validation error (unknown ids etc.)
        raise ToolError(str(exc)) from exc
    ctx.results[result.scenario_id] = result
    return result


# ---------------------------------------------------------------------------
# Result summarisation (compact, model-facing)
# ---------------------------------------------------------------------------


def summarize_result(ctx: ToolContext, r: SimulationResult, max_affected: int = 30) -> dict[str, Any]:
    nodes, _ = _indices(ctx.network)
    m = r.impact_metrics
    affected = sorted(r.affected_nodes, key=lambda a: (SEVERITY_ORDER[a.severity], a.step, a.node_id))
    by_system: dict[str, dict[str, int]] = {}
    prov_counts: dict[str, int] = {}
    for a in r.affected_nodes:
        by_system.setdefault(a.system.value, {}).setdefault(a.state, 0)
        by_system[a.system.value][a.state] += 1
        n = nodes.get(a.node_id)
        if n is not None:
            prov_counts[n.provenance.category.value] = prov_counts.get(n.provenance.category.value, 0) + 1
    return {
        "scenario_id": r.scenario_id,
        "name": r.scenario.name,
        "scenario_type": r.scenario.scenario_type,
        "failed_nodes": [{"id": i, "name": _name(ctx, i)} for i in r.failed_nodes],
        "failed_edges": r.failed_edges,
        "horizon_hours": r.scenario.horizon_hours,
        "restoration_enabled": r.scenario.enable_restoration,
        "summary": r.summary,
        "metrics": {
            "severity_index": round(m.severity_index, 1),
            "total_nodes_affected": m.total_nodes_affected,
            "critical_facilities_affected": [
                {"id": i, "name": _name(ctx, i), "state": r.node_states.get(i)} for i in m.critical_facilities_affected
            ],
            "population_affected_estimate_modelled": m.population_affected_estimate,
            "power_load_unserved_mw": round(m.power_load_unserved_mw, 2),
            "water_demand_unserved_lps": round(m.water_demand_unserved_lps, 1),
            "telecom_nodes_disconnected": m.telecom_nodes_disconnected,
            "transport_travel_time_increase_pct": round(m.transport_travel_time_increase_pct, 1),
            "transit_stations_closed": m.transit_stations_closed,
            "redundancy_score": round(m.redundancy_score, 3),
            "per_system": [
                {
                    "system": s.system.value,
                    "metric": s.metric_name,
                    "baseline": round(s.baseline_value, 2),
                    "remaining": round(s.remaining_value, 2),
                    "unit": s.unit,
                    "percent_served": round(s.percent_served, 1),
                    "nodes_affected": s.nodes_affected,
                }
                for s in m.per_system
            ],
        },
        "cascade_steps": [
            {"step": s.step, "label": s.label, "description": s.description, "systems": [x.value for x in s.systems]}
            for s in r.cascade_steps
        ],
        "affected_counts_by_system_and_state": by_system,
        "affected_components": [
            {
                "id": a.node_id,
                "name": _name(ctx, a.node_id),
                "system": a.system.value,
                "state": a.state,
                "severity": a.severity,
                "step": a.step,
                "cause": a.cause,
                "caused_by": a.caused_by[:4],
                "service_level": round(a.service_level, 2),
            }
            for a in affected[:max_affected]
        ],
        "affected_components_truncated": max(0, len(affected) - max_affected),
        "alternative_paths": [
            {
                "id": p.id,
                "system": p.system.value,
                "purpose": p.purpose,
                "from": p.from_node,
                "to": p.to_node,
                "description": p.description,
                "capacity_ok": p.capacity_ok,
            }
            for p in r.alternative_paths[:12]
        ],
        "interrupted_edges_count": len(r.interrupted_edges),
        "affected_provenance_counts": prov_counts,
        "assumptions": r.assumptions[:8],
        "engine_version": r.engine_version,
    }


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def t_search_components(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    query = str(args.get("query", "")).strip().lower()
    system = args.get("system")
    ntype = args.get("type")
    limit = int(args.get("limit", 10))
    tokens = [t for t in re.split(r"[\s,/]+", query) if t]
    scored: list[tuple[float, InfrastructureNode]] = []
    for n in ctx.network.nodes:
        if system and n.system.value != system:
            continue
        if ntype and n.type != ntype:
            continue
        hay = f"{n.id} {n.name} {n.type} {n.system.value} {n.description or ''}".lower()
        if not tokens:
            score = 1.0
        else:
            hits = sum(1 for t in tokens if t in hay)
            if hits == 0:
                continue
            score = hits / len(tokens) + (0.5 if query in n.name.lower() else 0) + (1.0 if query == n.id.lower() else 0)
        scored.append((score, n))
    scored.sort(key=lambda x: (-x[0], x[1].id))
    found = [node_ref(n) | {"critical": n.critical} for _, n in scored[:limit]]
    return ToolOutput(
        payload={"query": query, "matches": found, "total_matches": len(scored)},
        summary=f"{len(scored)} match(es) for “{query}”" + (f" — top: {found[0]['name']}" if found else ""),
    )


def t_get_component_details(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    node = require_node(ctx, str(args.get("node_id", "")))
    d = ctx.engine.node_details(node.id)
    nodes, _ = _indices(ctx.network)
    payload = {
        "id": node.id,
        "name": node.name,
        "system": node.system.value,
        "type": node.type,
        "latitude": round(node.latitude, 6),
        "longitude": round(node.longitude, 6),
        "elevation_m_relative_to_ground": node.elevation,
        "capacity": node.capacity,
        "capacity_unit": node.capacity_unit,
        "demand": node.demand,
        "critical": node.critical,
        "description": node.description,
        "properties_modelled": node.properties,
        "provenance": _prov(node.provenance),
        "baseline_state": d.baseline_state,
        "criticality_rank_n_minus_1": d.criticality_rank,
        "nodes_affected_by_single_failure": d.criticality_score,
        "is_single_point_of_failure": d.is_single_point_of_failure,
        "connected": [node_ref(nodes[i]) for i in d.connected_node_ids[:20] if i in nodes],
        "upstream_count": len(d.upstream_ids),
        "downstream_count": len(d.downstream_ids),
        "dependencies (providers)": [node_ref(nodes[i]) for i in d.dependency_ids[:15] if i in nodes],
        "dependents (consumers)": [node_ref(nodes[i]) for i in d.dependent_ids[:20] if i in nodes],
        "dependents_total": len(d.dependent_ids),
    }
    return ToolOutput(
        payload=payload,
        summary=f"{node.name} · {node.type.replace('_', ' ')} · {node.provenance.category.value}",
        ui_actions=[UIAction(kind="select_node", node_id=node.id)],
    )


def t_get_connected_nodes(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    node = require_node(ctx, str(args.get("node_id", "")))
    relation = args.get("relation", "all")
    nodes, _ = _indices(ctx.network)
    out = []
    for e in ctx.network.edges:
        if node.id not in (e.source_node, e.target_node):
            continue
        if relation != "all" and e.relation.value != relation:
            continue
        other = e.target_node if e.source_node == node.id else e.source_node
        direction = None
        if e.relation.value == "dependency":
            direction = "provides_to_this_node" if e.target_node == node.id else "depends_on_this_node"
        out.append(
            {
                "edge_id": e.id,
                "connection_type": e.connection_type,
                "relation": e.relation.value,
                "dependency_direction": direction,
                "capacity": e.capacity,
                "capacity_unit": e.capacity_unit,
                "status": e.status,
                "corridor_id": e.corridor_id,
                "edge_provenance": e.provenance.category.value,
                "other": node_ref(nodes[other]) if other in nodes else {"id": other},
            }
        )
    out.sort(key=lambda x: (x["relation"], x["edge_id"]))
    return ToolOutput(
        payload={"node": node_ref(node), "connections": out[:60], "total": len(out)},
        summary=f"{len(out)} {relation if relation != 'all' else ''} connection(s) of {node.name}".replace("  ", " "),
        ui_actions=[
            UIAction(
                kind="highlight",
                node_ids=[node.id] + [c["other"]["id"] for c in out[:60]],
                edge_ids=[c["edge_id"] for c in out[:60]],
                label=f"Connections of {node.name}",
                tone="info",
            )
        ],
    )


def t_trace_network_path(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    node = require_node(ctx, str(args.get("node_id", "")))
    to_id = args.get("to_node_id")
    if to_id:
        target = require_node(ctx, str(to_id))
        p = ctx.engine.find_path(node.id, target.id)
        return ToolOutput(
            payload=p.model_dump(mode="json"),
            summary=(f"Path {node.name} → {target.name}: {len(p.node_ids)} nodes" if p.found else "No path found"),
            ui_actions=[
                UIAction(
                    kind="highlight",
                    node_ids=p.node_ids,
                    edge_ids=p.edge_ids,
                    label=f"Path {node.name} → {target.name}",
                    tone="info",
                )
            ]
            if p.found
            else [],
        )
    tr = ctx.engine.trace(node.id, int(args.get("max_depth", 8)))
    nodes, _ = _indices(ctx.network)

    def hops(hs, limit=25):
        return [
            {"id": h.node_id, "name": _name(ctx, h.node_id), "system": h.system.value, "depth": h.depth, "via": h.via_edge_id}
            for h in hs[:limit]
        ]

    payload = {
        "node": node_ref(node),
        "summary": tr.summary,
        "upstream": hops(tr.upstream),
        "upstream_total": len(tr.upstream),
        "downstream": hops(tr.downstream),
        "downstream_total": len(tr.downstream),
        "dependencies (cross-system providers)": hops(tr.dependencies),
        "dependents (cross-system consumers)": hops(tr.dependents, 40),
        "dependents_total": len(tr.dependents),
        "source_paths": [[_name(ctx, i) for i in path] for path in tr.source_paths[:4]],
        "physical_edges": len(tr.physical_edge_ids),
        "dependency_edges": len(tr.dependency_edge_ids),
    }
    return ToolOutput(
        payload=payload,
        summary=f"Traced {node.name}: {len(tr.upstream)} upstream · {len(tr.downstream)} downstream · {len(tr.dependents)} dependents",
        ui_actions=[UIAction(kind="select_node", node_id=node.id), UIAction(kind="show_trace", trace=tr)],
    )


def t_run_failure_simulation(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    scenario = _scenario_from_args(ctx, args, None)
    result = _run(ctx, scenario)
    slot = args.get("slot") or "active"
    m = result.impact_metrics
    return ToolOutput(
        payload=summarize_result(ctx, result),
        summary=(
            f"Severity {m.severity_index:.0f}/100 · {m.total_nodes_affected} components affected · "
            f"{len(result.cascade_steps)} cascade steps"
        ),
        ui_actions=[UIAction(kind="show_simulation", result=result, slot=slot)],
    )


def t_get_affected_components(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    scenario = _scenario_from_args(ctx, args, ctx.context.active_scenario)
    result = _run(ctx, scenario)
    system = args.get("system")
    min_sev = args.get("min_severity", "info")
    limit = int(args.get("limit", 40))
    rows = [
        a
        for a in result.affected_nodes
        if (not system or a.system.value == system) and SEVERITY_ORDER[a.severity] <= SEVERITY_ORDER.get(min_sev, 3)
    ]
    rows.sort(key=lambda a: (SEVERITY_ORDER[a.severity], a.step, a.node_id))
    payload = {
        "scenario_id": result.scenario_id,
        "failed_nodes": result.failed_nodes,
        "failed_edges": result.failed_edges,
        "filter": {"system": system, "min_severity": min_sev},
        "count": len(rows),
        "components": [
            {
                "id": a.node_id,
                "name": _name(ctx, a.node_id),
                "system": a.system.value,
                "state": a.state,
                "severity": a.severity,
                "step": a.step,
                "cause": a.cause,
                "caused_by": a.caused_by[:4],
            }
            for a in rows[:limit]
        ],
    }
    return ToolOutput(
        payload=payload,
        summary=f"{len(rows)} affected component(s)" + (f" in {system}" if system else ""),
        ui_actions=[
            UIAction(
                kind="highlight",
                node_ids=[a.node_id for a in rows[:limit]],
                label="Affected components",
                tone="critical" if any(a.severity == "critical" for a in rows) else "warning",
            )
        ],
    )


def _scenario_arg(ctx: ToolContext, raw: Any, fallback: ScenarioInput | None, label: str) -> ScenarioInput:
    if raw:
        if not isinstance(raw, dict):
            raise ToolError(f"{label} must be an object with failed_nodes/failed_edges")
        return _scenario_from_args(ctx, raw, None)
    if fallback is None:
        raise ToolError(f"{label} not provided and no {label} is loaded in the app")
    return fallback


def t_compare_scenarios(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    a = _scenario_arg(ctx, args.get("scenario_a"), ctx.context.scenario_a, "scenario_a")
    b = _scenario_arg(ctx, args.get("scenario_b"), ctx.context.scenario_b, "scenario_b")
    cmp = ctx.engine.compare(a, b)
    ctx.results[cmp.scenario_a.scenario_id] = cmp.scenario_a
    ctx.results[cmp.scenario_b.scenario_id] = cmp.scenario_b
    payload = {
        "verdict": cmp.verdict,
        "summary": cmp.summary,
        "scenario_a": {"id": cmp.scenario_a.scenario_id, "name": a.name, "failed": a.failed_nodes + a.failed_edges},
        "scenario_b": {"id": cmp.scenario_b.scenario_id, "name": b.name, "failed": b.failed_nodes + b.failed_edges},
        "metrics": [m.model_dump(mode="json") for m in cmp.metrics],
        "only_in_a_count": len(cmp.only_in_a),
        "only_in_b_count": len(cmp.only_in_b),
        "in_both_count": len(cmp.in_both),
        "only_in_a": [{"id": i, "name": _name(ctx, i)} for i in cmp.only_in_a[:15]],
        "only_in_b": [{"id": i, "name": _name(ctx, i)} for i in cmp.only_in_b[:15]],
    }
    return ToolOutput(
        payload=payload,
        summary=cmp.verdict[:140],
        ui_actions=[UIAction(kind="show_comparison", comparison=cmp)],
    )


def t_get_network_metrics(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    system = args.get("system")
    top_n = int(args.get("top_n", 10))
    m = ctx.engine.metrics()
    ranking = [c for c in m.criticality_ranking if not system or c.system.value == system][:top_n]
    systems = [s for s in m.systems if not system or s.system.value == system]
    payload = {
        "criticality_ranking_n_minus_1": [
            {
                "rank": i + 1,
                "id": c.node_id,
                "name": _name(ctx, c.node_id),
                "system": c.system.value,
                "nodes_affected": c.affected_count,
                "critical_facilities_affected": c.critical_facilities_affected,
                "severity_index": round(c.severity_index, 1),
            }
            for i, c in enumerate(ranking)
        ],
        "systems": [
            {
                "system": s.system.value,
                "nodes": s.node_count,
                "edges": s.edge_count,
                "components": s.connected_components,
                "average_degree": round(s.average_degree, 2),
                "articulation_points": [{"id": i, "name": _name(ctx, i)} for i in s.articulation_points[:12]],
                "articulation_points_total": len(s.articulation_points),
                "top_betweenness": [{"id": i, "name": _name(ctx, i), "score": round(v, 4)} for i, v in s.top_betweenness],
                "redundancy_fraction": round(s.redundancy_fraction, 3),
            }
            for s in systems
        ],
        "cross_system_dependencies": m.cross_system_dependencies,
        "method": "Criticality = deterministic single-failure (N-1) simulation of each component, ranked by severity index.",
    }
    top = ranking[0] if ranking else None
    return ToolOutput(
        payload=payload,
        summary=(f"Most critical: {_name(ctx, top.node_id)} (severity {top.severity_index:.0f})" if top else "Metrics computed"),
        ui_actions=[
            UIAction(
                kind="highlight",
                node_ids=[c.node_id for c in ranking[:5]],
                label="Most critical components (N-1)",
                tone="warning",
            )
        ]
        if ranking
        else [],
    )


def t_get_data_provenance(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    net = ctx.network
    if args.get("node_id"):
        n = require_node(ctx, str(args["node_id"]))
        return ToolOutput(
            payload={"node": node_ref(n), "provenance": _prov(n.provenance)},
            summary=f"{n.name}: {n.provenance.category.value} ({n.provenance.confidence:.0%} confidence)",
        )
    if args.get("edge_id"):
        e = require_edge(ctx, str(args["edge_id"]))
        return ToolOutput(
            payload={"edge_id": e.id, "connection_type": e.connection_type, "provenance": _prov(e.provenance)},
            summary=f"{e.id}: {e.provenance.category.value}",
        )
    counts: dict[str, dict[str, int]] = {}
    for item in [*net.nodes, *net.edges]:
        sys_ = item.system.value if isinstance(item, InfrastructureNode) else item.infrastructure_type.value
        counts.setdefault(sys_, {}).setdefault(item.provenance.category.value, 0)
        counts[sys_][item.provenance.category.value] += 1
    payload = {
        "categories": {
            "verified": "authoritative source, inspected",
            "publicly_mapped": "present in a public map dataset such as OpenStreetMap",
            "estimated": "approximate value/location from general public knowledge",
            "simulated": "illustrative asset/connection generated for modelling; not real infrastructure",
        },
        "counts_by_system": counts,
        "datasets": [d.model_dump(mode="json") for d in net.datasets],
        "network_assumptions": net.assumptions,
    }
    total = sum(sum(v.values()) for v in counts.values())
    sim = sum(v.get("simulated", 0) for v in counts.values())
    return ToolOutput(payload=payload, summary=f"{sim}/{total} elements are simulated; {len(net.datasets)} datasets")


# ---- mitigation evaluation -------------------------------------------------


def _apply_modifications(
    ctx: ToolContext, mods: list[dict[str, Any]]
) -> tuple[InfrastructureNetwork, list[str], list[str], list[str]]:
    """Return a modified deep copy of the network plus a description of each change."""
    net = ctx.network.model_copy(deep=True)
    nodes = {n.id: n for n in net.nodes}
    edges = {e.id: e for e in net.edges}
    described: list[str] = []
    touched_nodes: list[str] = []
    touched_edges: list[str] = []
    if not mods:
        raise ToolError("Provide at least one modification")
    for i, mod in enumerate(mods[:5]):
        kind = mod.get("kind")
        target = mod.get("target_id")
        if kind == "backup_power":
            n = nodes.get(str(target))
            if n is None:
                raise ToolError(f"Unknown node '{target}' for backup_power")
            hours = float(mod.get("hours", 24))
            n.properties["backup_hours"] = hours
            n.properties["backup_power_hours"] = hours
            described.append(f"Add {hours:g} h of backup power at {n.name} ({n.id})")
            touched_nodes.append(n.id)
        elif kind == "water_storage":
            n = nodes.get(str(target))
            if n is None:
                raise ToolError(f"Unknown node '{target}' for water_storage")
            hours = float(mod.get("hours", 24))
            n.properties["water_storage_hours"] = hours
            described.append(f"Provide {hours:g} h of on-site water storage at {n.name} ({n.id})")
            touched_nodes.append(n.id)
        elif kind == "capacity_upgrade":
            factor = float(mod.get("factor", 2.0))
            if not 1.0 < factor <= 5.0:
                raise ToolError("capacity_upgrade factor must be in (1, 5]")
            if target in edges:
                e = edges[target]
                if e.capacity is None:
                    raise ToolError(f"Edge {target} has no modelled capacity")
                e.capacity *= factor
                described.append(f"Upgrade capacity of {e.id} ({e.connection_type}) ×{factor:g}")
                touched_edges.append(e.id)
            elif target in nodes:
                n = nodes[target]
                if n.capacity is None:
                    raise ToolError(f"Node {target} has no modelled capacity")
                n.capacity *= factor
                described.append(f"Upgrade capacity of {n.name} ({n.id}) ×{factor:g}")
                touched_nodes.append(n.id)
            else:
                raise ToolError(f"Unknown element '{target}' for capacity_upgrade")
        elif kind == "add_connection":
            a = nodes.get(str(target))
            b = nodes.get(str(mod.get("to_node_id")))
            if a is None or b is None:
                raise ToolError("add_connection needs valid target_id and to_node_id")
            if a.system != b.system:
                raise ToolError("add_connection must join two nodes of the same system")
            template = next(
                (e for e in net.edges if e.infrastructure_type == a.system and e.relation.value == "physical"), None
            )
            if template is None:
                raise ToolError(f"No physical edge template for system {a.system.value}")
            new = template.model_copy(deep=True)
            new.id = f"MIT-{a.system.value[:3].upper()}-{i + 1:02d}"
            new.source_node, new.target_node = a.id, b.id
            new.geometry = [(a.longitude, a.latitude), (b.longitude, b.latitude)]
            new.status = "operational"
            new.corridor_id = None
            new.name = f"Proposed {template.connection_type.replace('_', ' ')} (mitigation)"
            if mod.get("capacity") is not None:
                new.capacity = float(mod["capacity"])
            new.properties = {"proposed": True}
            new.provenance = new.provenance.model_copy(
                update={"notes": "Hypothetical connection added by mitigation analysis"}
            )
            net.edges.append(new)
            described.append(f"Add a new {template.connection_type.replace('_', ' ')} between {a.name} and {b.name}")
            touched_nodes += [a.id, b.id]
        elif kind == "separate_corridor":
            e = edges.get(str(target))
            if e is None or not e.corridor_id:
                raise ToolError(f"'{target}' is not an edge hosted in an underground corridor")
            corridor = edges.get(e.corridor_id)
            if corridor is not None:
                hosted = list(corridor.properties.get("hosted_edge_ids", []))
                corridor.properties["hosted_edge_ids"] = [x for x in hosted if x != e.id]
            described.append(f"Re-route {e.id} out of shared corridor {e.corridor_id} (diverse path)")
            e.corridor_id = None
            touched_edges.append(e.id)
        else:
            raise ToolError(
                f"Unknown modification kind '{kind}'. Use backup_power, water_storage, capacity_upgrade, add_connection or separate_corridor."
            )
    return net, described, touched_nodes, touched_edges


def t_evaluate_mitigation(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    from app.simulation.engine import SimulationEngine  # local import: engine module owns graph building

    scenario = _scenario_arg(ctx, args.get("scenario"), ctx.context.active_scenario, "scenario")
    before = _run(ctx, scenario)
    net, described, touched_nodes, touched_edges = _apply_modifications(ctx, list(args.get("modifications") or []))
    try:
        after = SimulationEngine(net).simulate(scenario)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    mb, ma = before.impact_metrics, after.impact_metrics
    keys = [
        ("severity_index", "Severity index", "", True),
        ("total_nodes_affected", "Components affected", "", True),
        ("population_affected_estimate", "Population affected (modelled)", "people", True),
        ("power_load_unserved_mw", "Power unserved", "MW", True),
        ("water_demand_unserved_lps", "Water unserved", "L/s", True),
        ("telecom_nodes_disconnected", "Telecom endpoints disconnected", "", True),
        ("transport_travel_time_increase_pct", "Travel time increase", "%", True),
        ("transit_stations_closed", "Transit stations closed", "", True),
    ]
    deltas = []
    for key, label, unit, _ in keys:
        b, a = float(getattr(mb, key)), float(getattr(ma, key))
        deltas.append({"metric": label, "unit": unit, "before": round(b, 2), "after": round(a, 2), "change": round(a - b, 2)})
    crit_before = set(mb.critical_facilities_affected)
    crit_after = set(ma.critical_facilities_affected)
    payload = {
        "scenario_id": before.scenario_id,
        "modifications": described,
        "metric_changes": deltas,
        "critical_facilities_no_longer_affected": [{"id": i, "name": _name(ctx, i)} for i in sorted(crit_before - crit_after)],
        "newly_affected_critical_facilities": [{"id": i, "name": _name(ctx, i)} for i in sorted(crit_after - crit_before)],
        "method": "Re-ran the same deterministic scenario on a modified copy of the network; the live network is unchanged.",
        "caveat": "Mitigation effect is computed under the same simplified, illustrative model assumptions.",
    }
    improvement = mb.severity_index - ma.severity_index
    return ToolOutput(
        payload=payload,
        summary=f"Mitigation changes severity {mb.severity_index:.0f} → {ma.severity_index:.0f} ({-improvement:+.0f})",
        ui_actions=[
            UIAction(
                kind="highlight",
                node_ids=touched_nodes,
                edge_ids=touched_edges,
                label="Mitigation targets",
                tone="success",
            )
        ]
        if (touched_nodes or touched_edges)
        else [],
    )


def t_highlight_components(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    node_ids = [str(i) for i in (args.get("node_ids") or [])][:80]
    edge_ids = [str(i) for i in (args.get("edge_ids") or [])][:160]
    for i in node_ids:
        require_node(ctx, i)
    for i in edge_ids:
        require_edge(ctx, i)
    if not node_ids and not edge_ids:
        return ToolOutput(payload={"cleared": True}, summary="Cleared highlights", ui_actions=[UIAction(kind="clear_highlights")])
    tone = args.get("tone") if args.get("tone") in ("info", "warning", "critical", "success") else "info"
    label = str(args.get("label") or "Highlighted by analyst")[:80]
    return ToolOutput(
        payload={"highlighted_nodes": len(node_ids), "highlighted_edges": len(edge_ids), "label": label},
        summary=f"Highlighted {len(node_ids)} component(s)" + (f" and {len(edge_ids)} connection(s)" if edge_ids else ""),
        ui_actions=[UIAction(kind="highlight", node_ids=node_ids, edge_ids=edge_ids, label=label, tone=tone)],
    )


def t_focus_camera(ctx: ToolContext, args: dict[str, Any]) -> ToolOutput:
    node = require_node(ctx, str(args.get("node_id", "")))
    return ToolOutput(
        payload={"focused": node.id},
        summary=f"Camera → {node.name}",
        ui_actions=[UIAction(kind="select_node", node_id=node.id), UIAction(kind="fly_to", node_id=node.id)],
    )


# ---------------------------------------------------------------------------
# Registry & Anthropic tool definitions
# ---------------------------------------------------------------------------

_SCENARIO_PROPS: dict[str, Any] = {
    "failed_nodes": {"type": "array", "items": {"type": "string"}, "description": "Node ids to fail"},
    "failed_edges": {"type": "array", "items": {"type": "string"}, "description": "Edge ids to fail (cables, pipes, roads, duct banks)"},
    "horizon_hours": {
        "type": "number",
        "minimum": 0,
        "maximum": 168,
        "description": "Hours after onset at which impacts are assessed (backup batteries/generators deplete). Default 4.",
    },
    "enable_restoration": {"type": "boolean", "description": "Allow automatic switching/rerouting. Default true."},
    "name": {"type": "string", "description": "Short human-readable scenario name"},
}

_SCENARIO_OBJ: dict[str, Any] = {"type": "object", "properties": _SCENARIO_PROPS, "additionalProperties": False}

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "search_components",
        "description": "Find infrastructure components (nodes) by name, id fragment, type or system. Use this first to resolve any component the user mentions by name to its exact id.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Free text, e.g. 'Five Points substation' or 'pump'"},
                "system": {"type": "string", "enum": SYSTEMS},
                "type": {"type": "string", "description": "Node type, e.g. distribution_substation, pump_station, cell_site"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_component_details",
        "description": "Get a component's attributes, provenance, criticality (N-1 rank) and its direct connections, providers and dependents. Also selects it in the 3D view.",
        "input_schema": {
            "type": "object",
            "properties": {"node_id": {"type": "string"}},
            "required": ["node_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_connected_nodes",
        "description": "List the edges incident to a component and the components at the other end, distinguishing physical connections from logical dependencies.",
        "input_schema": {
            "type": "object",
            "properties": {
                "node_id": {"type": "string"},
                "relation": {"type": "string", "enum": ["physical", "dependency", "all"]},
            },
            "required": ["node_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "trace_network_path",
        "description": "Trace a component's network: upstream supply path to sources, downstream elements it serves, cross-system providers and dependents. With to_node_id, return the shortest physical path between two components instead. Displays the trace in 3D.",
        "input_schema": {
            "type": "object",
            "properties": {
                "node_id": {"type": "string"},
                "to_node_id": {"type": "string"},
                "max_depth": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            "required": ["node_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run_failure_simulation",
        "description": "Run the deterministic cascade simulation for failed components/connections and display the animated cascade in 3D. Returns severity, affected components with causes, cascade steps, alternative paths and assumptions. Use slot 'A' or 'B' when building a comparison.",
        "input_schema": {
            "type": "object",
            "properties": {
                **_SCENARIO_PROPS,
                "slot": {"type": "string", "enum": ["active", "A", "B"]},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_affected_components",
        "description": "List affected components (with state, severity, cascade step and cause) for a scenario. If no failure is given, uses the scenario currently shown in the app.",
        "input_schema": {
            "type": "object",
            "properties": {
                **_SCENARIO_PROPS,
                "system": {"type": "string", "enum": SYSTEMS},
                "min_severity": {"type": "string", "enum": ["critical", "major", "minor", "info"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "compare_scenarios",
        "description": "Compare two failure scenarios side by side (severity, affected components, unserved demand, redundancy...) and show the difference in 3D. If a scenario is omitted, the app's stored scenario A/B is used.",
        "input_schema": {
            "type": "object",
            "properties": {"scenario_a": _SCENARIO_OBJ, "scenario_b": _SCENARIO_OBJ},
            "additionalProperties": False,
        },
    },
    {
        "name": "get_network_metrics",
        "description": "Network-wide structure metrics: N-1 criticality ranking (most important components), articulation points (single points of failure), betweenness, redundancy per system.",
        "input_schema": {
            "type": "object",
            "properties": {
                "system": {"type": "string", "enum": SYSTEMS},
                "top_n": {"type": "integer", "minimum": 1, "maximum": 30},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_data_provenance",
        "description": "Data provenance: whether a component/connection (or the whole dataset) is verified, publicly mapped, estimated or simulated, with sources, licenses and modelling assumptions. Call this before making claims about whether something is real.",
        "input_schema": {
            "type": "object",
            "properties": {"node_id": {"type": "string"}, "edge_id": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "evaluate_mitigation",
        "description": "Quantify a mitigation: re-run the same scenario on a modified copy of the network and report metric changes. Modification kinds: backup_power (target_id node, hours), water_storage (target_id facility, hours), capacity_upgrade (target_id edge or node, factor 1-5), add_connection (target_id and to_node_id in the same system, optional capacity), separate_corridor (target_id = edge hosted in a shared duct bank). If scenario is omitted, uses the scenario shown in the app.",
        "input_schema": {
            "type": "object",
            "properties": {
                "scenario": _SCENARIO_OBJ,
                "modifications": {
                    "type": "array",
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "enum": ["backup_power", "water_storage", "capacity_upgrade", "add_connection", "separate_corridor"],
                            },
                            "target_id": {"type": "string"},
                            "to_node_id": {"type": "string"},
                            "hours": {"type": "number", "minimum": 0, "maximum": 168},
                            "factor": {"type": "number"},
                            "capacity": {"type": "number"},
                        },
                        "required": ["kind", "target_id"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["modifications"],
            "additionalProperties": False,
        },
    },
    {
        "name": "highlight_components",
        "description": "Highlight specific components/connections in the 3D view to point the user at them (ids must exist). Call with empty lists to clear.",
        "input_schema": {
            "type": "object",
            "properties": {
                "node_ids": {"type": "array", "items": {"type": "string"}},
                "edge_ids": {"type": "array", "items": {"type": "string"}},
                "label": {"type": "string"},
                "tone": {"type": "string", "enum": ["info", "warning", "critical", "success"]},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "focus_camera",
        "description": "Select a component and fly the 3D camera to it.",
        "input_schema": {
            "type": "object",
            "properties": {"node_id": {"type": "string"}},
            "required": ["node_id"],
            "additionalProperties": False,
        },
    },
]

TOOL_IMPLS: dict[str, Callable[[ToolContext, dict[str, Any]], ToolOutput]] = {
    "search_components": t_search_components,
    "get_component_details": t_get_component_details,
    "get_connected_nodes": t_get_connected_nodes,
    "trace_network_path": t_trace_network_path,
    "run_failure_simulation": t_run_failure_simulation,
    "get_affected_components": t_get_affected_components,
    "compare_scenarios": t_compare_scenarios,
    "get_network_metrics": t_get_network_metrics,
    "get_data_provenance": t_get_data_provenance,
    "evaluate_mitigation": t_evaluate_mitigation,
    "highlight_components": t_highlight_components,
    "focus_camera": t_focus_camera,
}


def execute_tool(ctx: ToolContext, name: str, args: dict[str, Any]) -> tuple[bool, ToolOutput]:
    """Run a tool. Returns (ok, output); invalid input yields ok=False with an explanatory payload."""
    impl = TOOL_IMPLS.get(name)
    if impl is None:
        return False, ToolOutput(payload={"error": f"Unknown tool '{name}'"}, summary=f"Unknown tool {name}")
    try:
        return True, impl(ctx, dict(args or {}))
    except ToolError as exc:
        return False, ToolOutput(payload={"error": str(exc)}, summary=str(exc)[:160])
    except Exception as exc:  # noqa: BLE001 — never crash the analyst loop on a tool bug
        return False, ToolOutput(payload={"error": f"Tool failed: {type(exc).__name__}: {exc}"}, summary="Tool error")


def network_brief(net: InfrastructureNetwork) -> str:
    """Static description of the loaded network for the system prompt (cache-stable)."""
    counts: dict[str, int] = {}
    for n in net.nodes:
        counts[n.system.value] = counts.get(n.system.value, 0) + 1
    prov: dict[str, int] = {}
    for item in [*net.nodes, *net.edges]:
        prov[item.provenance.category.value] = prov.get(item.provenance.category.value, 0) + 1
    key_nodes = [
        n
        for n in net.nodes
        if n.type
        in (
            "transmission_substation",
            "distribution_substation",
            "internet_exchange",
            "data_center",
            "central_office",
            "pump_station",
            "storage_tank",
            "supply_source",
            "transit_station",
            "hospital",
            "government",
            "emergency_services",
            "venue",
            "university",
        )
    ]
    lines = [f"- `{n.id}` — {n.name} ({n.system.value}/{n.type}, {n.provenance.category.value})" for n in key_nodes[:70]]
    return (
        f"Network `{net.id}` — {net.name} (v{net.version}), region {net.region.name}.\n"
        f"Nodes per system: {counts}. Edges: {len(net.edges)}. Provenance mix (nodes+edges): {prov}.\n"
        "Key components:\n" + "\n".join(lines)
    )


def deep_copy_context(ctx: AnalystContext) -> AnalystContext:
    return copy.deepcopy(ctx)
