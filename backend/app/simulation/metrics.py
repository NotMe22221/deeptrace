"""Network-level metrics: topology per system and the N-1 criticality ranking.

* ``connected_components`` / ``average_degree`` (2·E/N, parallel edges counted) /
  ``articulation_points`` / ``top_betweenness`` (top 5, unweighted) on each system's
  physical graph.
* ``redundancy_fraction`` = share of demand nodes with ≥ 2 edge-disjoint paths to a
  source (normally-open ties and boundary valves count, because they can be switched):
  power vaults → transmission sources; water zones (leaf zones at their attachment
  junction) → supplies/tanks; telecom endpoints
  → cores; transport destinations → gateways; underground: vaults lying on a cycle;
  facilities: share with ≥ 2 power providers.
* ``criticality_ranking`` – single failure of every non-facility node (restoration on,
  4 h horizon), ranked by severity index, then affected-node count.
* A node is a *single point of failure* when it is an articulation point that separates
  demand from every source of its system, or when its single failure affects ≥ 5 nodes.
"""

from __future__ import annotations

from collections import Counter
from typing import TYPE_CHECKING

import networkx as nx

from app.models.schemas import CriticalityEntry, NetworkMetrics, ScenarioInput, SystemMetrics
from app.simulation.graph import SYSTEMS, sval

if TYPE_CHECKING:
    from app.simulation.cascade import CascadeEngine
    from app.simulation.report import Report

SPOF_AFFECTED_THRESHOLD = 5
N1_SYSTEMS = ("power", "water", "telecom", "transport", "underground")


class MetricsCalculator:
    def __init__(self, ce: CascadeEngine, report: Report) -> None:
        self.ce = ce
        self.report = report
        self._crit: list[CriticalityEntry] | None = None
        self.spof_articulation: set[str] = set()

    def _sources_and_demand(self, system: str) -> tuple[list[str], list[list[str]]]:
        ce, g = self.ce, self.ce.g
        if system == "power":
            return ce.power.sources, [[n] for n in sorted(ce.power.demand)]
        if system == "water":
            # a zone hanging off a single service main is assessed at its attachment junction
            # (the zone node aggregates a district; its service connection is not network redundancy)
            groups = []
            for z in ce.water.zones:
                nbrs = {g.other_end(e, z) for e in ce.water.inc.get(z, [])}
                groups.append(sorted(nbrs) if len(ce.water.inc.get(z, [])) == 1 else [z])
            return ce.water.supplies + ce.water.tanks, groups
        if system == "telecom":
            return ce.telecom.cores, [[n] for n in ce.telecom.endpoints]
        if system == "transport":
            return ce.transport.gateways, [list(d.access) for d in ce.transport.dests if d.kind != "gateway"]
        return [], []

    def _system_metrics(self, system: str) -> SystemMetrics:
        ce, g = self.ce, self.ce.g
        nodes = g.nodes_by_system.get(system, [])
        edges = g.physical_edges_by_system.get(system, [])
        M = g.physical[system]
        S = nx.Graph()
        S.add_nodes_from(nodes)
        mult: Counter[tuple[str, str]] = Counter()
        for e in edges:
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if u == v or u not in S or v not in S:
                continue
            S.add_edge(u, v)
            mult[(min(u, v), max(u, v))] += 1
        n = len(nodes)
        comps = nx.number_connected_components(S) if n else 0
        aps = sorted(nx.articulation_points(S)) if n else []
        bc = nx.betweenness_centrality(S) if S.number_of_edges() else {}
        top = sorted(((k, round(v, 4)) for k, v in bc.items()), key=lambda x: (-x[1], x[0]))[:5]

        sources, demand = self._sources_and_demand(system)
        redundancy = 0.0
        if system == "facility":
            fac = nodes
            red = sum(
                1 for f in fac if len({lk.provider for lk in g.providers.get(f, []) if lk.ctype == "power_supply"}) >= 2
            )
            redundancy = red / len(fac) if fac else 0.0
        elif system == "underground":
            vaults = [x for x in nodes if g.node_type[x] == "utility_vault"]
            bridges = {frozenset(b) for b in nx.bridges(S)} if S.number_of_edges() else set()
            red = 0
            for vtx in vaults:
                inc = [frozenset((vtx, w)) for w in S.neighbors(vtx)]
                if any(e not in bridges or mult[tuple(sorted(e))] > 1 for e in inc):  # type: ignore[index]
                    red += 1
            redundancy = red / len(vaults) if vaults else 0.0
        elif sources and demand:
            H = nx.DiGraph()
            no_transit = ce.telecom.endpoint_set if system == "telecom" else frozenset()
            for (u, v), k in mult.items():
                if u not in no_transit:
                    H.add_edge(u, v, capacity=k)
                if v not in no_transit:
                    H.add_edge(v, u, capacity=k)
            for s in sources:
                if s in H:
                    H.add_edge("__SRC__", s, capacity=10)
            red = 0
            for group in demand:
                ok = False
                for d in group:
                    if d in sources:
                        ok = True
                        break
                    if d in H and "__SRC__" in H and nx.maximum_flow_value(H, "__SRC__", d) >= 2:
                        ok = True
                        break
                red += 1 if ok else 0
            redundancy = red / len(demand)
            # articulation points that separate demand from every source
            src_set = set(sources)
            dem_nodes = {d for grp in demand for d in grp}
            for ap in aps:
                if ap in src_set and len(src_set) == 1:
                    self.spof_articulation.add(ap)
                    continue
                T = S.copy()
                T.remove_node(ap)
                reach: set[str] = set()
                for comp in nx.connected_components(T):
                    if comp & src_set:
                        reach |= comp
                base_reach: set[str] = set()
                for comp in nx.connected_components(S):
                    if comp & src_set:
                        base_reach |= comp
                if any(d in base_reach and d not in reach and d != ap for d in dem_nodes):
                    self.spof_articulation.add(ap)
        return SystemMetrics(
            system=system,  # type: ignore[arg-type]
            node_count=n,
            edge_count=len(edges),
            connected_components=comps,
            average_degree=round(2.0 * M.number_of_edges() / n, 4) if n else 0.0,
            articulation_points=aps,
            top_betweenness=top,
            redundancy_fraction=round(redundancy, 4),
        )

    def criticality(self) -> list[CriticalityEntry]:
        if self._crit is not None:
            return self._crit
        ce, g = self.ce, self.ce.g
        entries: list[CriticalityEntry] = []
        for system in N1_SYSTEMS:
            for n in g.nodes_by_system.get(system, []):
                oc = ce.run(ScenarioInput(failed_nodes=[n]))
                im = self.report.impact(oc)
                entries.append(
                    CriticalityEntry(
                        node_id=n,
                        system=system,  # type: ignore[arg-type]
                        affected_count=im.total_nodes_affected,
                        critical_facilities_affected=len(im.critical_facilities_affected),
                        severity_index=im.severity_index,
                    )
                )
        entries.sort(key=lambda x: (-x.severity_index, -x.affected_count, x.node_id))
        self._crit = entries
        return entries

    def compute(self) -> NetworkMetrics:
        g = self.ce.g
        systems = [self._system_metrics(s) for s in SYSTEMS]
        crit = self.criticality()
        cross = sum(1 for lk in g.dep_links.values() if g.node_sys[lk.provider] != g.node_sys[lk.consumer])
        prov: dict[str, dict[str, int]] = {s: {} for s in SYSTEMS}
        for nid, node in g.nodes.items():
            c = prov.setdefault(g.node_sys[nid], {})
            cat = sval(node.provenance.category)
            c[cat] = c.get(cat, 0) + 1
        for eid, edge in g.edges.items():
            c = prov.setdefault(g.edge_sys[eid], {})
            cat = sval(edge.provenance.category)
            c[cat] = c.get(cat, 0) + 1
        prov = {s: dict(sorted(v.items())) for s, v in sorted(prov.items())}
        return NetworkMetrics(
            network_id=g.network.id,
            systems=systems,
            criticality_ranking=crit,
            cross_system_dependencies=cross,
            provenance_counts=prov,
        )
