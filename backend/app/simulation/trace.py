"""Tracing: where a node draws service from, what it serves, and cross-system links.

* **power** – upstream = the baseline energisation tree towards the transmission
  source; downstream = the subtree it energises.
* **water** – upstream / downstream follow the baseline max-flow directions (towards
  supplies / towards zones); if no flow passes the node, the shortest pipe path to the
  nearest supply is used.
* **telecom** – upstream = the primary route to the nearest core; downstream = nodes
  whose primary route passes through it.
* **transport** – upstream = the fastest route to the nearest gateway; downstream =
  nodes whose fastest gateway route passes through it (plus rail neighbours of stations).
* **underground** – downstream = corridor-connected vaults (≤ 2 hops); dependants = the
  endpoints of every edge routed through the vault.
* **dependencies** – providers of this node (dependency edges into it) and, one level up,
  of its providers. **dependents** – consumers of this node and of every downstream
  element (e.g. a substation's dependants are the consumers of all vaults it feeds).
"""

from __future__ import annotations

from collections import deque
from typing import TYPE_CHECKING

import networkx as nx

from app.models.schemas import PathResult, TraceHop, TraceResult
from app.simulation.common import join_names, plural

if TYPE_CHECKING:
    from app.simulation.cascade import CascadeEngine

MAX_SOURCE_PATHS = 6


class Tracer:
    def __init__(self, ce: CascadeEngine) -> None:
        self.ce = ce
        g = ce.g
        # power: closed graph (ties excluded) for source paths
        self.power_graph = nx.Graph()
        for n, lst in ce.power.adj.items():
            self.power_graph.add_node(n)
            for v, e in lst:
                self.power_graph.add_edge(n, v, eid=e, w=g.edge_length(e))
        self.power_children: dict[str, list[tuple[str, str]]] = {}
        for n, (p, e) in ce.power.baseline.parent.items():
            if p is not None and e is not None:
                self.power_children.setdefault(p, []).append((n, e))
        # water: baseline flow arcs
        self.water_in: dict[str, list[tuple[str, str]]] = {}
        self.water_out: dict[str, list[tuple[str, str]]] = {}
        for e, f in ce.water.base_solve.net.items():
            if abs(f) <= 1e-6:
                continue
            ed = g.edges[e]
            a, b = (ed.source_node, ed.target_node) if f > 0 else (ed.target_node, ed.source_node)
            self.water_out.setdefault(a, []).append((b, e))
            self.water_in.setdefault(b, []).append((a, e))
        self.water_graph = nx.Graph()
        for e in ce.water.pipes:
            ed = g.edges[e]
            w = g.edge_length(e)
            if (
                not self.water_graph.has_edge(ed.source_node, ed.target_node)
                or self.water_graph[ed.source_node][ed.target_node]["w"] > w
            ):
                self.water_graph.add_edge(ed.source_node, ed.target_node, eid=e, w=w)
        # telecom: baseline routes
        self.tel_graph = nx.Graph()
        for e in ce.telecom.edges:
            ed = g.edges[e]
            w = ce.telecom.weight[e]
            if (
                not self.tel_graph.has_edge(ed.source_node, ed.target_node)
                or self.tel_graph[ed.source_node][ed.target_node]["w"] > w
            ):
                self.tel_graph.add_edge(ed.source_node, ed.target_node, eid=e, w=w)
        # transport: gateway shortest-path tree on the road graph (undirected view)
        tr = ce.transport
        self.road_graph = nx.Graph()
        for e in tr.road_edges:
            ed = g.edges[e]
            w = tr.tt[e]
            if (
                not self.road_graph.has_edge(ed.source_node, ed.target_node)
                or self.road_graph[ed.source_node][ed.target_node]["w"] > w
            ):
                self.road_graph.add_edge(ed.source_node, ed.target_node, eid=e, w=w)
        self.road_paths: dict[str, list[str]] = {}
        gws = [x for x in tr.gateways if x in self.road_graph]
        if gws:
            _, paths = nx.multi_source_dijkstra(self.road_graph, gws, weight="w")
            self.road_paths = {n: list(reversed(p)) for n, p in paths.items()}  # node -> ... -> gateway
        # combined graph for find_path (parallel edges collapsed to the shortest)
        self.combined = nx.Graph()
        self.combined.add_nodes_from(g.node_ids)
        for u, v, k, d in g.combined.edges(keys=True, data=True):
            if u == v:
                continue
            w = d["weight"] + (0.0 if not d["dependency"] else 1.0)
            if (
                not self.combined.has_edge(u, v)
                or self.combined[u][v]["w"] > w
                or (self.combined[u][v]["w"] == w and k < self.combined[u][v]["eid"])
            ):
                self.combined.add_edge(u, v, eid=k, w=w, dep=d["dependency"])

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _add(hops: dict[str, TraceHop], hop: TraceHop) -> None:
        cur = hops.get(hop.node_id)
        if cur is None or hop.depth < cur.depth:
            hops[hop.node_id] = hop

    def _paths_to(self, G: nx.Graph, n: str, targets: list[str]) -> tuple[list[list[str]], set[str]]:
        out: list[list[str]] = []
        edges: set[str] = set()
        if n not in G:
            return out, edges
        try:
            dist, paths = nx.single_source_dijkstra(G, n, weight="w")
        except nx.NodeNotFound:
            return out, edges
        reach = sorted((dist[t], t) for t in targets if t in paths and t != n)
        for _d, t in reach[:MAX_SOURCE_PATHS]:
            p = paths[t]
            out.append(p)
            edges |= {G[a][b]["eid"] for a, b in zip(p, p[1:])}
        return out, edges

    # ------------------------------------------------------------------ trace
    def trace(self, n: str, max_depth: int = 8) -> TraceResult:
        ce, g = self.ce, self.ce.g
        system = g.node_sys[n]
        up: dict[str, TraceHop] = {}
        down: dict[str, TraceHop] = {}
        phys: set[str] = set()
        source_paths: list[list[str]] = []
        max_depth = max(1, int(max_depth))

        if system == "power":
            par = ce.power.baseline.parent
            cur, d = n, 0
            while cur in par and par[cur][0] is not None and d < max_depth:
                p, e = par[cur]
                d += 1
                self._add(up, TraceHop(node_id=p, via_edge_id=e, depth=d, relation="physical", system="power"))  # type: ignore[arg-type]
                if e:
                    phys.add(e)
                cur = p  # type: ignore[assignment]
            if n not in par:  # e.g. an open tie switch: show both feeders it joins
                unit_i = ce.power.unit_of_switch.get(n)
                if unit_i is not None:
                    unit = ce.power.units[unit_i]
                    for tnode in unit.terminals:
                        via = next(
                            (e for e in unit.edges if tnode in (g.edges[e].source_node, g.edges[e].target_node)), None
                        )
                        self._add(
                            up, TraceHop(node_id=tnode, via_edge_id=via, depth=1, relation="physical", system="power")
                        )  # type: ignore[arg-type]
                        if via:
                            phys.add(via)
            q = deque([(n, 0)])
            while q:
                u, d = q.popleft()
                if d >= max_depth:
                    continue
                for c, e in sorted(self.power_children.get(u, [])):
                    self._add(
                        down, TraceHop(node_id=c, via_edge_id=e, depth=d + 1, relation="physical", system="power")
                    )  # type: ignore[arg-type]
                    phys.add(e)
                    q.append((c, d + 1))
            source_paths, pe = self._paths_to(self.power_graph, n, ce.power.sources)
            phys |= pe
        elif system == "water":
            for arcs, store in ((self.water_in, up), (self.water_out, down)):
                q = deque([(n, 0)])
                seen = {n}
                while q:
                    u, d = q.popleft()
                    if d >= max_depth:
                        continue
                    for v, e in sorted(arcs.get(u, [])):
                        phys.add(e)
                        if v in seen:
                            continue
                        seen.add(v)
                        self._add(
                            store,
                            TraceHop(node_id=v, via_edge_id=e, depth=d + 1, relation="physical", system=g.node_sys[v]),
                        )  # type: ignore[arg-type]
                        q.append((v, d + 1))
            source_paths, pe = self._paths_to(self.water_graph, n, ce.water.supplies + ce.water.tanks)
            phys |= pe
            if not up and source_paths:
                p = source_paths[0]
                for i, (a, b) in enumerate(zip(p, p[1:]), start=1):
                    if i > max_depth:
                        break
                    e = self.water_graph[a][b]["eid"]
                    self._add(
                        up, TraceHop(node_id=b, via_edge_id=e, depth=i, relation="physical", system=g.node_sys[b])
                    )  # type: ignore[arg-type]
        elif system == "telecom":
            base = ce.telecom.baseline
            route, redges = base.routes.get(n), base.route_edges.get(n)
            if route and redges:
                for i, (b, e) in enumerate(zip(route[1:], redges), start=1):
                    if i > max_depth:
                        break
                    self._add(up, TraceHop(node_id=b, via_edge_id=e, depth=i, relation="physical", system="telecom"))  # type: ignore[arg-type]
                    phys.add(e)
            for m, r in base.routes.items():
                if m == n or n not in r:
                    continue
                i = r.index(n)
                if i > max_depth:
                    continue
                self._add(
                    down,
                    TraceHop(
                        node_id=m,
                        via_edge_id=base.route_edges[m][i - 1] if i >= 1 else None,
                        depth=i,
                        relation="physical",
                        system="telecom",
                    ),  # type: ignore[arg-type]
                )
                phys |= set(base.route_edges[m][:i])
            no_transit = self.tel_graph.subgraph(
                [x for x in self.tel_graph if x not in ce.telecom.endpoint_set or x == n]
            )
            source_paths, pe = self._paths_to(no_transit, n, ce.telecom.cores)
            phys |= pe
        elif system == "transport":
            p = self.road_paths.get(n)
            if p:
                for i, (a, b) in enumerate(zip(p, p[1:]), start=1):
                    if i > max_depth:
                        break
                    e = self.road_graph[a][b]["eid"]
                    self._add(up, TraceHop(node_id=b, via_edge_id=e, depth=i, relation="physical", system="transport"))  # type: ignore[arg-type]
                    phys.add(e)
            for m, r in self.road_paths.items():
                if m == n or n not in r:
                    continue
                i = r.index(n)
                if 0 < i <= max_depth:
                    self._add(
                        down,
                        TraceHop(
                            node_id=m,
                            via_edge_id=self.road_graph[r[i - 1]][r[i]]["eid"],
                            depth=i,
                            relation="physical",
                            system="transport",
                        ),  # type: ignore[arg-type]
                    )
                    phys.add(self.road_graph[r[i - 1]][r[i]]["eid"])
            for e in g.incident[n]:
                if e in ce.transport.rail_edges:
                    m = g.other_end(e, n)
                    self._add(
                        down, TraceHop(node_id=m, via_edge_id=e, depth=1, relation="physical", system="transport")
                    )  # type: ignore[arg-type]
                    phys.add(e)
            source_paths, pe = self._paths_to(self.road_graph, n, ce.transport.gateways)
            phys |= pe
        elif system == "underground":
            q = deque([(n, 0)])
            seen = {n}
            lim = min(max_depth, 2)
            while q:
                u, d = q.popleft()
                if d >= lim:
                    continue
                for e in sorted(g.incident[u]):
                    if e not in g.corridor_hosted:
                        continue
                    phys.add(e)
                    v = g.other_end(e, u)
                    if v in seen:
                        continue
                    seen.add(v)
                    self._add(
                        down, TraceHop(node_id=v, via_edge_id=e, depth=d + 1, relation="physical", system=g.node_sys[v])
                    )  # type: ignore[arg-type]
                    q.append((v, d + 1))

        # ---- dependencies (into this node, then one level into its providers)
        deps: dict[str, TraceHop] = {}
        dep_edges: set[str] = set()
        for link in sorted(g.providers.get(n, [])):
            self._add(
                deps,
                TraceHop(
                    node_id=link.provider,
                    via_edge_id=link.edge_id,
                    depth=1,
                    relation="dependency",
                    system=g.node_sys[link.provider],
                ),
            )  # type: ignore[arg-type]
            dep_edges.add(link.edge_id)
        for p in list(deps):
            for link in sorted(g.providers.get(p, [])):
                if link.provider == n:
                    continue
                self._add(
                    deps,
                    TraceHop(
                        node_id=link.provider,
                        via_edge_id=link.edge_id,
                        depth=2,
                        relation="dependency",
                        system=g.node_sys[link.provider],
                    ),
                )  # type: ignore[arg-type]
                dep_edges.add(link.edge_id)
        # ---- dependents (of this node and of everything downstream)
        dependents: dict[str, TraceHop] = {}
        sources = [(n, 0)] + [(h.node_id, h.depth) for h in down.values()]
        for src, d in sources:
            for link in sorted(g.consumers.get(src, [])):
                if link.consumer == n:
                    continue
                self._add(
                    dependents,
                    TraceHop(
                        node_id=link.consumer,
                        via_edge_id=link.edge_id,
                        depth=d + 1,
                        relation="dependency",
                        system=g.node_sys[link.consumer],
                    ),
                )  # type: ignore[arg-type]
                dep_edges.add(link.edge_id)
        if system == "underground":
            for h in g.vault_hosted.get(n, []):
                phys.add(h)
                for end in (g.edges[h].source_node, g.edges[h].target_node):
                    self._add(
                        dependents,
                        TraceHop(node_id=end, via_edge_id=h, depth=1, relation="physical", system=g.node_sys[end]),
                    )  # type: ignore[arg-type]

        def ordered(hops: dict[str, TraceHop]) -> list[TraceHop]:
            return sorted((h for h in hops.values() if h.node_id != n), key=lambda h: (h.depth, h.node_id))

        upl, downl, depl, dentl = ordered(up), ordered(down), ordered(deps), ordered(dependents)
        crit = [h.node_id for h in dentl if g.nodes[h.node_id].critical]
        if system == "facility":
            by_res: dict[str, list[str]] = {}
            for link in sorted(g.providers.get(n, [])):
                by_res.setdefault(link.ctype, []).append(g.label(link.provider))
            words = {
                "power_supply": "power from",
                "water_supply": "water from",
                "telecom_link": "telecom via",
                "control_link": "control via",
                "road_access": "road access via",
            }
            parts = [f"{words.get(ct, ct)} {join_names(ps, 3)}" for ct, ps in by_res.items()]
            node = g.nodes[n]
            summary = (
                f"{g.label(n)} ({node.type.replace('_', ' ')}{', critical' if node.critical else ''}) depends on "
                + ("; ".join(parts) if parts else "no modelled providers")
                + f" ({plural(len(by_res.get('power_supply', [])), 'power feed')}"
                + f", backup power {g.power_backup_hours(n):g} h, water storage {g.water_backup_hours(n):g} h)."
            )
            return TraceResult(
                node_id=n,
                upstream=upl,
                downstream=downl,
                dependencies=depl,
                dependents=dentl,
                physical_edge_ids=sorted(phys),
                dependency_edge_ids=sorted(dep_edges),
                source_paths=source_paths,
                summary=summary,
            )
        bits = [f"{g.label(n)} ({system} {g.node_type[n].replace('_', ' ')})"]
        if source_paths:
            bits.append(
                f"draws service through {plural(len(upl), 'upstream element')}; nearest source "
                f"{g.label(source_paths[0][-1])}"
            )
        elif upl:
            bits.append(f"has {plural(len(upl), 'upstream element')}")
        else:
            bits.append("has no upstream supply path in its system")
        bits.append(f"serves {plural(len(downl), 'downstream element')}")
        if depl:
            bits.append(f"depends on {join_names([g.label(h.node_id) for h in depl if h.depth == 1], 3) or 'n/a'}")
        if dentl:
            bits.append(
                f"{plural(len(dentl), 'cross-system dependant')}"
                + (f" including critical {join_names([g.name(c) for c in crit], 3)}" if crit else "")
            )
        summary = "; ".join(bits[:1] + bits[1:2]) + ("; " + "; ".join(bits[2:]) if len(bits) > 2 else "") + "."
        return TraceResult(
            node_id=n,
            upstream=upl,
            downstream=downl,
            dependencies=depl,
            dependents=dentl,
            physical_edge_ids=sorted(phys),
            dependency_edge_ids=sorted(dep_edges),
            source_paths=source_paths,
            summary=summary,
        )

    # ------------------------------------------------------------------ paths
    def find_path(self, a: str, b: str) -> PathResult:
        g = self.ce.g
        try:
            p = nx.shortest_path(self.combined, a, b, weight="w")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return PathResult(
                from_node=a,
                to_node=b,
                found=False,
                node_ids=[],
                edge_ids=[],
                length_m=0.0,
                systems=[],
                description=f"No physical or dependency path connects {g.label(a)} and {g.label(b)}.",
            )
        eids = [self.combined[x][y]["eid"] for x, y in zip(p, p[1:])]
        deps = sum(1 for x, y in zip(p, p[1:]) if self.combined[x][y]["dep"])
        length = sum(g.edge_length(e) if e in g.edges and g.edges[e].relation == "physical" else 0.0 for e in eids)
        systems: list[str] = []
        for x in p:
            s = g.node_sys[x]
            if s not in systems:
                systems.append(s)
        desc = (
            f"Shortest path from {g.label(a)} to {g.label(b)}: {plural(len(eids), 'hop')}, "
            f"{length:,.0f} m of physical conduit through {', '.join(systems)}"
            + (f", crossing {plural(deps, 'dependency link')}" if deps else "")
            + "."
        )
        return PathResult(
            from_node=a,
            to_node=b,
            found=True,
            node_ids=p,
            edge_ids=eids,
            length_m=round(length, 1),
            systems=systems,  # type: ignore[arg-type]
            description=desc,
        )
