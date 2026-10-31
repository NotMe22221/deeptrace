"""Telecom (fibre) model: connectivity to cores, rerouting and link utilisation.

* **Cores** are operating ``internet_exchange`` and ``data_center`` nodes. A node is
  *connected* when a path over operational fibre exists to any core.
* **Routing** – shortest path (weight = ``properties.latency_ms`` converted to fibre
  metres at 200 km/ms, else ``length_m``) to the nearest core. In the baseline that is
  the node's *primary route*. After failures a node keeps its primary route if it is
  intact; otherwise it is *rerouted* onto the new shortest path (when
  ``enable_restoration``) or *disconnected*.
* **Capacity** – each endpoint (``access_node``, ``cell_site`` or any node with
  ``demand``) pushes its demand (Gbps) along its route; per-link load / capacity > 1 is
  ``overloaded`` and endpoints routed over it are ``degraded`` (service = capacity/load).
* **Power** – nodes whose power provider is lost without adequate backup are taken out
  of service (``outage``) and stop forwarding traffic; nodes running on battery /
  generator for the whole horizon stay in service as ``on_backup``.
"""

from __future__ import annotations

from dataclasses import dataclass

import networkx as nx

from app.models.schemas import AlternativePath
from app.simulation.common import EPS, EdgeOutcome, FlowRec, NodeOutcome, fmt_num, join_names
from app.simulation.graph import NetworkGraphs, as_float

CORE_TYPES = frozenset({"internet_exchange", "data_center"})
ENDPOINT_TYPES = frozenset({"access_node", "cell_site"})
METRES_PER_MS = 200_000.0  # light in fibre ≈ 200 km per millisecond


@dataclass(frozen=True)
class TelecomInputs:
    failed_nodes: frozenset[str]
    failed_edges: frozenset[str]
    unpowered: frozenset[str] = frozenset()
    backup: frozenset[str] = frozenset()
    common_cause: frozenset[tuple[str, str]] = frozenset()
    reroute: bool = True


@dataclass
class TelecomResult:
    connected: frozenset[str]
    routes: dict[str, list[str]]
    route_edges: dict[str, list[str]]
    rerouted: frozenset[str]
    disconnected: frozenset[str]
    outage: frozenset[str]
    node_out: dict[str, NodeOutcome]
    edge_out: dict[str, EdgeOutcome]
    flows: dict[str, FlowRec]
    edge_load: dict[str, float]
    endpoints_total: int
    endpoints_connected: int
    initially_lost: float
    recovered: float
    alternatives: list[AlternativePath]


class TelecomModel:
    def __init__(self, g: NetworkGraphs) -> None:
        self.g = g
        self.nodes: list[str] = list(g.nodes_by_system.get("telecom", []))
        self.node_set = set(self.nodes)
        t = g.node_type
        self.cores = [n for n in self.nodes if t[n] in CORE_TYPES]
        self.demand = {
            n: max(0.0, as_float(g.nodes[n].demand, 0.0) or 0.0) for n in self.nodes if n not in self.cores
        }
        self.endpoints = [n for n in self.nodes if t[n] in ENDPOINT_TYPES or (self.demand.get(n, 0.0) > 0)]
        self.edges: list[str] = [
            e
            for e in g.physical_edges_by_system.get("telecom", [])
            if g.edges[e].source_node in self.node_set and g.edges[e].target_node in self.node_set
        ]
        self.cap = {e: as_float(g.edges[e].capacity) for e in self.edges}
        self.weight: dict[str, float] = {}
        for e in self.edges:
            lat = as_float(g.edges[e].properties.get("latency_ms"))
            self.weight[e] = lat * METRES_PER_MS if lat and lat > 0 else g.edge_length(e)
        self.length = {e: g.edge_length(e) for e in self.edges}
        self.baseline = self.evaluate(TelecomInputs(frozenset(), frozenset()))

    def _route_len(self, edges: list[str]) -> float:
        return sum(self.length[e] for e in edges)

    def evaluate(self, inp: TelecomInputs) -> TelecomResult:
        g = self.g
        fn = frozenset(n for n in inp.failed_nodes if n in self.node_set)
        unpowered = frozenset(n for n in inp.unpowered if n in self.node_set and n not in fn)
        removed = fn | unpowered
        fe = inp.failed_edges
        H = nx.Graph()
        H.add_nodes_from(n for n in self.nodes if n not in removed)
        for e in self.edges:
            if e in fe:
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if u in removed or v in removed or u == v:
                continue
            w = self.weight[e]
            if not H.has_edge(u, v) or H[u][v]["w"] > w:
                H.add_edge(u, v, w=w, eid=e)
        alive_cores = [c for c in self.cores if c in H]
        paths: dict[str, list[str]] = {}
        if alive_cores:
            _, paths = nx.multi_source_dijkstra(H, alive_cores, weight="w")

        base = getattr(self, "baseline", None)
        routes: dict[str, list[str]] = {}
        route_edges: dict[str, list[str]] = {}
        rerouted: set[str] = set()
        disconnected: set[str] = set()
        broken_at: dict[str, str] = {}

        def first_broken(path: list[str], epath: list[str]) -> str | None:
            for a, e in zip(path[1:], epath):
                if e in fe:
                    return e
                if a in removed:
                    return a
            return None

        for n in self.nodes:
            if n in removed:
                continue
            if n in self.cores:
                routes[n] = [n]
                route_edges[n] = []
                continue
            bp = base.routes.get(n) if base else None
            be = base.route_edges.get(n) if base else None
            if bp is not None and be is not None:
                br = first_broken(bp, be)
                if br is None:
                    routes[n], route_edges[n] = bp, be
                    continue
                broken_at[n] = br
            if n in paths and (inp.reroute or bp is None):
                p = list(reversed(paths[n]))
                routes[n] = p
                route_edges[n] = [H[a][b]["eid"] for a, b in zip(p, p[1:])]
                if bp is not None:
                    rerouted.add(n)
            else:
                disconnected.add(n)

        # ---- capacity
        load: dict[str, float] = {e: 0.0 for e in self.edges}
        signed: dict[str, float] = {e: 0.0 for e in self.edges}
        for n in self.endpoints:
            d = self.demand.get(n, 0.0)
            if d <= 0 or n not in routes:
                continue
            p, ep = routes[n], route_edges[n]
            for a, e in zip(p, ep):
                load[e] += d
                signed[e] += d if g.edges[e].source_node == a else -d
        flows: dict[str, FlowRec] = {}
        overloaded: dict[str, float] = {}
        for e in self.edges:
            cap = self.cap.get(e)
            util = load[e] / cap if cap else 0.0
            flows[e] = FlowRec(
                (1 if signed[e] > 0 else -1) if load[e] > EPS else 0, round(load[e], 4), round(util, 4), "Gbps"
            )
            if cap and util > 1.0 + 1e-6:
                overloaded[e] = util

        cc = dict(inp.common_cause)

        def broken_text(x: str) -> str:
            if x in g.edges:
                return f"fibre {g.label(x)} cut" + (f" (corridor {g.label(cc[x])})" if x in cc else "")
            if x in unpowered:
                return f"{g.label(x)} out of service (no power)"
            return f"{g.label(x)} failed"

        node_out: dict[str, NodeOutcome] = {}
        alternatives: list[AlternativePath] = []
        for n in self.nodes:
            if n in fn:
                continue
            if n in unpowered:
                node_out[n] = NodeOutcome(
                    "outage", "Out of service without power; stops forwarding traffic.", (), 0.0, dep="power_supply"
                )
                continue
            if n in disconnected:
                br = broken_at.get(n)
                why = f"; its primary route was broken where {broken_text(br)}" if br else ""
                if br and not inp.reroute and n in paths:
                    why += " and automatic rerouting is disabled for this scenario"
                node_out[n] = NodeOutcome(
                    "disconnected",
                    f"{g.label(n)} disconnected: no operational fibre path to any core "
                    f"(internet exchange / data centre){why}.",
                    (br,) if br else (),
                    0.0,
                )
                continue
            out: NodeOutcome | None = None
            if n in inp.backup:
                out = NodeOutcome("on_backup", "Running on backup power (battery/generator).", (), 1.0, dep="power_supply")
            over = [e for e in route_edges.get(n, []) if e in overloaded]
            if over and self.demand.get(n, 0.0) > 0:
                worst = max(over, key=lambda e: (overloaded[e], e))
                out = NodeOutcome(
                    "degraded",
                    f"{g.label(n)} congested: its route uses fibre {g.label(worst)} at "
                    f"{overloaded[worst] * 100:.0f}% of capacity.",
                    (worst,),
                    round(min(1.0, 1.0 / overloaded[worst]), 4),
                )
            if n in rerouted:
                br = broken_at[n]
                p = routes[n]
                new_len = self._route_len(route_edges[n])
                old_len = self._route_len(base.route_edges[n]) if base else new_len
                via = [x for x in p[1:-1]]
                txt = (
                    f"{g.label(n)} rerouted after {broken_text(br)}: now reaches {g.label(p[-1])}"
                    + (f" via {join_names([g.label(x) for x in via], 3)}" if via else " directly")
                    + f" ({'+' if new_len >= old_len else ''}{fmt_num(new_len - old_len, 0)} m route length)."
                )
                reroute_out = NodeOutcome("operational", txt, (br,), 1.0, info=True)
                if out is None:
                    out = reroute_out
                else:
                    out = NodeOutcome(out.state, f"{out.cause} {txt}", out.caused_by + (br,), out.service_level, dep=out.dep)
                if n in self.endpoints:
                    alternatives.append(
                        AlternativePath(
                            id=f"alt-telecom-{n}",
                            system="telecom",
                            purpose="fibre reroute",
                            from_node=n,
                            to_node=p[-1],
                            node_ids=p,
                            edge_ids=route_edges[n],
                            description=txt,
                            capacity_ok=not over,
                            added_length_m=round(new_len - old_len, 1),
                        )
                    )
            if out is not None:
                node_out[n] = out

        # ---- edges
        edge_out: dict[str, EdgeOutcome] = {}
        new_route_edges: set[str] = set()
        for n in rerouted:
            old = set(base.route_edges.get(n, [])) if base else set()
            new_route_edges |= {e for e in route_edges[n] if e not in old}
        for e in self.edges:
            if e in fe:
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            bad = [x for x in (u, v) if x in removed]
            if bad:
                why = "no power" if bad[0] in unpowered else "failed"
                edge_out[e] = EdgeOutcome("interrupted", f"No service: endpoint {g.label(bad[0])} out of service ({why})")
            elif u in disconnected and v in disconnected:
                edge_out[e] = EdgeOutcome("interrupted", "No service: fibre section cut off from every core")
            elif e in overloaded:
                edge_out[e] = EdgeOutcome(
                    "overloaded", f"Carries {fmt_num(load[e], 2)} Gbps = {overloaded[e] * 100:.0f}% of capacity"
                )
            elif e in new_route_edges:
                edge_out[e] = EdgeOutcome("rerouted", f"Carries rerouted traffic ({fmt_num(load[e], 2)} Gbps)")

        connected = frozenset(n for n in routes if n not in removed)
        ep_connected = sum(1 for n in self.endpoints if n in connected)
        initially_lost = sum(1 for n in self.endpoints if n in broken_at)
        recovered = sum(1 for n in self.endpoints if n in broken_at and n in connected)
        alternatives.sort(key=lambda a: a.id)
        return TelecomResult(
            connected=connected,
            routes=routes,
            route_edges=route_edges,
            rerouted=frozenset(rerouted),
            disconnected=frozenset(disconnected),
            outage=unpowered,
            node_out=node_out,
            edge_out=edge_out,
            flows=flows,
            edge_load=load,
            endpoints_total=len(self.endpoints),
            endpoints_connected=ep_connected,
            initially_lost=float(initially_lost),
            recovered=float(recovered),
            alternatives=alternatives,
        )
