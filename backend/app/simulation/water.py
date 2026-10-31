"""Water distribution model: valve isolation + max-flow hydraulic surrogate.

*Hydraulics are approximated by maximum flow* — there are no pressures, head losses or
extended-period simulation. The model is:

1. **Rupture isolation** – a failed pipe (or junction) forces the nearest isolation
   valves to close: BFS over pipes from the rupture through non-boundary nodes. Every
   pipe reached is ``isolated`` and every interior node is ``isolated``. Boundary nodes
   stop the search: ``valve`` nodes (they close and are taken out of service) and
   stations that carry their own isolation valves (``supply_source``, ``pump_station``,
   ``storage_tank``, ``service_zone``).
2. **Two-layer max-flow** – every node exists twice: ``@L`` (gravity / low head) and
   ``@H`` (boosted / high head); water can always drop from H to L at any node. Supply
   sources inject into L (capacity L/s), a *powered* ``pump_station`` lifts L→H up to its
   capacity, an unpowered pump is bypassed (pass-through in L only). Low pressure zones
   draw from L (hence also from H); high pressure zones (``properties.pressure_zone``
   containing "high"/"upper"/"boost"/"pump") only from H. Pipes carry ≤ capacity L/s in
   each direction (``directed`` pipes one way). ``normally_closed`` valves are closed.
3. **Storage tanks** – used only for demand the supply network cannot meet: after the
   supply max-flow, tanks inject into H on the *residual* network (augmenting paths), so
   supply-served demand is never displaced. Tank duration = storage_m3·1000 / outflow /
   3600 h. Zones carried by a tank that lasts the horizon are ``on_backup``; tanks that
   would drain before the horizon are dropped and the max-flow re-run (zones lose that
   share: ``outage``/``degraded`` after depletion).
4. **Service level** = served / reference demand (the demand, or the baseline served
   amount if the baseline already cannot meet it): ≥ 0.98 operational, ≥ 0.5 degraded
   (low pressure), < 0.5 outage.

Capacities are converted to integer mL/s for numerically exact NetworkX max-flow.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import networkx as nx

from app.models.schemas import AlternativePath
from app.simulation.common import EPS, EdgeOutcome, FlowRec, NodeOutcome, fmt_num, join_names
from app.simulation.graph import NetworkGraphs, as_bool, as_float

SCALE = 1000  # L/s -> integer mL/s
BIG = 10**13
OPERATIONAL_LEVEL = 0.98
OUTAGE_LEVEL = 0.5
BOUNDARY_TYPES = frozenset({"valve", "supply_source", "pump_station", "storage_tank", "service_zone"})
HIGH_ZONE_KEYWORDS = ("high", "upper", "boost", "pump")


@dataclass(frozen=True)
class WaterInputs:
    failed_nodes: frozenset[str]
    failed_edges: frozenset[str]
    unpowered_pumps: frozenset[str] = frozenset()
    backup_pumps: frozenset[str] = frozenset()
    common_cause: frozenset[tuple[str, str]] = frozenset()
    horizon: float = 4.0
    opened_valves: frozenset[str] = frozenset()


@dataclass
class _Solve:
    s1: dict[str, float]  # zone -> L/s from supply
    s2: dict[str, float]  # zone -> L/s from sustained tanks
    tank_out: dict[str, float]
    tank_hours: dict[str, float]
    depleted: dict[str, float]  # tank -> hours it would last
    zone_tanks: dict[str, tuple[str, ...]]  # zone -> tanks that (would) carry it
    net: dict[str, float]  # pipe -> net L/s source->target
    reach: set[str]  # water nodes with a hydraulic path from a supply / sustained tank


@dataclass
class WaterResult:
    zone_served: dict[str, float]
    zone_level: dict[str, float]
    node_level: dict[str, float]
    node_out: dict[str, NodeOutcome]
    edge_out: dict[str, EdgeOutcome]
    flows: dict[str, FlowRec]
    isolated_nodes: frozenset[str]
    isolated_edges: frozenset[str]
    closing_valves: frozenset[str]
    tank_outflow: dict[str, float]
    tank_hours: dict[str, float]
    depleted: dict[str, float]
    served_total: float
    demand_total: float
    initially_lost: float
    recovered: float
    inputs: WaterInputs
    removed_nodes: frozenset[str] = field(default_factory=frozenset)


def _is_high(value: object) -> bool:
    return isinstance(value, str) and any(k in value.lower() for k in HIGH_ZONE_KEYWORDS)


class WaterModel:
    def __init__(self, g: NetworkGraphs) -> None:
        self.g = g
        self.nodes: list[str] = list(g.nodes_by_system.get("water", []))
        self.node_set = set(self.nodes)
        t = g.node_type
        self.supplies = [n for n in self.nodes if t[n] == "supply_source"]
        self.pumps = [n for n in self.nodes if t[n] == "pump_station"]
        self.tanks = [n for n in self.nodes if t[n] == "storage_tank"]
        self.valves = [n for n in self.nodes if t[n] == "valve"]
        self.zones = [n for n in self.nodes if t[n] == "service_zone"]
        self.nc_valves = {v for v in self.valves if as_bool(g.nodes[v].properties.get("normally_closed", False))}
        self.pipes: list[str] = [
            e
            for e in g.physical_edges_by_system.get("water", [])
            if g.edges[e].source_node in self.node_set and g.edges[e].target_node in self.node_set
        ]
        self.pipe_cap = {e: as_float(g.edges[e].capacity) for e in self.pipes}
        # valves modelled on the pipe itself (``properties.valve``) and closed pipes
        self.pipe_valve = {
            e
            for e in self.pipes
            if any(as_bool(g.edges[e].properties.get(k, False)) for k in ("valve", "has_valve", "isolation_valve"))
        }
        self.nc_pipes = {e for e in self.pipes if as_bool(g.edges[e].properties.get("normally_closed", False))}
        self.inc: dict[str, list[str]] = {n: [] for n in self.nodes}
        for e in self.pipes:
            ed = g.edges[e]
            self.inc[ed.source_node].append(e)
            if ed.target_node != ed.source_node:
                self.inc[ed.target_node].append(e)
        self.demand = {z: max(0.0, as_float(g.nodes[z].demand, 0.0) or 0.0) for z in self.zones}
        self.demand_total = sum(self.demand.values())
        self.high = {z: _is_high(g.nodes[z].properties.get("pressure_zone")) for z in self.zones}
        self.supply_high = {s: _is_high(g.nodes[s].properties.get("pressure_zone")) for s in self.supplies}
        self.storage_m3: dict[str, float | None] = {}
        self.tank_rate: dict[str, float | None] = {}
        for tk in self.tanks:
            node = g.nodes[tk]
            st = as_float(node.properties.get("storage_m3"))
            unit = (node.capacity_unit or "").lower()
            if st is None and node.capacity and ("m3" in unit or "m³" in unit):
                st = as_float(node.capacity)
            self.storage_m3[tk] = st
            rate = as_float(node.properties.get("max_outflow_lps"))
            if rate is None and node.capacity and ("l/s" in unit or "lps" in unit):
                rate = as_float(node.capacity)
            self.tank_rate[tk] = rate
            if st is None:
                g.warnings.append(f"storage tank {tk} has no properties.storage_m3; it is not used as a backup source")
        self.warnings: list[str] = []

        # ---- baseline + data sanity
        base_inp = WaterInputs(frozenset(), frozenset())
        sol = self._solve(set(), set(), frozenset(), frozenset(), base_inp.horizon)
        fallback = [z for z in self.zones if self.high[z] and sol.s1.get(z, 0.0) < self.demand[z] * OPERATIONAL_LEVEL]
        if fallback:
            for z in fallback:
                self.high[z] = False
            sol2 = self._solve(set(), set(), frozenset(), frozenset(), base_inp.horizon)
            for z in fallback:
                if sol2.s1.get(z, 0.0) > sol.s1.get(z, 0.0) + EPS:
                    g.warnings.append(
                        f"high pressure zone {z} cannot be served through a booster pump in the baseline; "
                        "treated as gravity-fed"
                    )
                else:
                    self.high[z] = True
            sol = self._solve(set(), set(), frozenset(), frozenset(), base_inp.horizon)
        self.base_solve = sol
        self.ref: dict[str, float] = {}
        for z in self.zones:
            d = self.demand[z]
            served = sol.s1.get(z, 0.0)
            if d > 0 and served < d * OPERATIONAL_LEVEL:
                g.warnings.append(
                    f"service zone {z} receives only {served:.1f} of {d:.1f} L/s in the baseline; "
                    "its service level is measured against the baseline supply"
                )
                self.ref[z] = served if served > EPS else d
            else:
                self.ref[z] = d
        # baseline upstream regions (for explanations) and primary paths (redundancy)
        self.base_up: dict[str, list[str]] = {}
        self._build_upstream(sol)
        self.base_primary = self._primary_paths()
        self.baseline = self.evaluate(base_inp)

    # ------------------------------------------------------------- baseline aux
    def _build_upstream(self, sol: _Solve) -> None:
        """Backward BFS along baseline flow from each zone: ordered upstream elements."""
        g = self.g
        into: dict[str, list[tuple[str, str]]] = {n: [] for n in self.nodes}  # node -> (upstream node, pipe)
        for e, f in sol.net.items():
            if abs(f) <= EPS:
                continue
            ed = g.edges[e]
            src, dst = (ed.source_node, ed.target_node) if f > 0 else (ed.target_node, ed.source_node)
            into[dst].append((src, e))
        for z in self.zones:
            seen = {z}
            order: list[str] = []
            frontier = [z]
            while frontier:
                nxt: list[str] = []
                for n in frontier:
                    for up, e in sorted(into[n]):
                        order.append(e)
                        if up not in seen:
                            seen.add(up)
                            order.append(up)
                            nxt.append(up)
                frontier = nxt
            self.base_up[z] = list(dict.fromkeys(order))

    def _primary_paths(self) -> dict[str, set[str]]:
        g = self.g
        G = nx.Graph()
        for e in self.pipes:
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if u in self.nc_valves or v in self.nc_valves or e in self.nc_pipes:
                continue
            w = g.edge_length(e)
            if not G.has_edge(u, v) or G[u][v]["w"] > w:
                G.add_edge(u, v, w=w, eid=e)
        srcs = [s for s in self.supplies if s in G]
        out: dict[str, set[str]] = {}
        if not srcs:
            return out
        _, paths = nx.multi_source_dijkstra(G, srcs, weight="w")
        for z in self.zones:
            p = paths.get(z)
            if not p:
                continue
            elems = set(p)
            for a, b in zip(p, p[1:]):
                elems.add(G[a][b]["eid"])
            out[z] = elems
        return out

    # ------------------------------------------------------------------ helpers
    def _isolate(
        self, fn: frozenset[str], fe: frozenset[str]
    ) -> tuple[set[str], set[str], set[str], dict[str, str]]:
        g = self.g
        iso_n: set[str] = set()
        iso_e: set[str] = set()
        closing: set[str] = set()
        origin: dict[str, str] = {}
        seeds: list[tuple[str, list[str]]] = []
        for e in self.pipes:
            if e in fe:
                ed = g.edges[e]
                seeds.append((e, [ed.source_node, ed.target_node]))
        for n in self.nodes:
            if n in fn and g.node_type[n] == "junction":
                seeds.append((n, [n]))
        for rupture, ends in seeds:
            stack: list[str] = []
            for n in ends:
                if n in fn and n != rupture:
                    continue
                if n == rupture:
                    # failed junction: its pipes are isolated
                    for pe in self.inc[n]:
                        if pe in fe:
                            continue
                        iso_e.add(pe)
                        origin.setdefault(pe, rupture)
                        if pe in self.pipe_valve:  # in-line valve closes this main
                            closing.add(pe)
                            continue
                        m = g.other_end(pe, n)
                        if m in fn or m in iso_n:
                            continue
                        if g.node_type[m] in BOUNDARY_TYPES:
                            if g.node_type[m] == "valve":
                                closing.add(m)
                                origin.setdefault(m, rupture)
                        else:
                            stack.append(m)
                    continue
                if g.node_type[n] in BOUNDARY_TYPES:
                    if g.node_type[n] == "valve":
                        closing.add(n)
                        origin.setdefault(n, rupture)
                else:
                    stack.append(n)
            while stack:
                n = stack.pop()
                if n in iso_n:
                    continue
                iso_n.add(n)
                origin.setdefault(n, rupture)
                for pe in self.inc[n]:
                    if pe in fe:
                        continue
                    iso_e.add(pe)
                    origin.setdefault(pe, rupture)
                    if pe in self.pipe_valve:  # in-line valve closes this main
                        closing.add(pe)
                        continue
                    m = g.other_end(pe, n)
                    if m in iso_n or m in fn:
                        continue
                    if g.node_type[m] in BOUNDARY_TYPES:
                        if g.node_type[m] == "valve":
                            closing.add(m)
                            origin.setdefault(m, rupture)
                    else:
                        stack.append(m)
        return iso_n, iso_e, closing, origin

    def _solve(
        self,
        removed_n: set[str],
        removed_e: set[str],
        unpowered: frozenset[str],
        opened: frozenset[str],
        horizon: float,
    ) -> _Solve:
        g = self.g
        alive = [n for n in self.nodes if n not in removed_n and (n not in self.nc_valves or n in opened)]
        alive_set = set(alive)
        D = nx.DiGraph()

        def add(u: str, v: str, cap: int) -> None:
            if cap <= 0:
                return
            if D.has_edge(u, v):
                D[u][v]["capacity"] += cap
            else:
                D.add_edge(u, v, capacity=cap)

        def scaled(x: float | None) -> int:
            return BIG if x is None or x <= 0 else int(round(x * SCALE))

        for n in alive:
            add(f"{n}@H", f"{n}@L", BIG)
        for p in self.pumps:
            if p in alive_set and p not in unpowered:
                add(f"{p}@L", f"{p}@H", scaled(as_float(g.nodes[p].capacity)))
        pipe_ends: dict[str, tuple[str, str]] = {}
        for e in self.pipes:
            if e in removed_e or (e in self.nc_pipes and e not in opened):
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if u not in alive_set or v not in alive_set:
                continue
            c = scaled(self.pipe_cap.get(e))
            pipe_ends[e] = (u, v)
            for layer in ("L", "H"):
                add(f"{u}@{layer}", f"{v}@{layer}", c)
                if not ed.directed:
                    add(f"{v}@{layer}", f"{u}@{layer}", c)
        total_dem = sum(self.demand.values())
        for s in self.supplies:
            if s in alive_set:
                cap = as_float(g.nodes[s].capacity)
                c = int(round(cap * SCALE)) if cap and cap > 0 else int(round(total_dem * SCALE)) + 1
                add("S", f"{s}@{'H' if self.supply_high.get(s) else 'L'}", c)
        sink_of: dict[str, str] = {}
        for z in self.zones:
            if z in alive_set and self.demand[z] > 0:
                sink_of[z] = f"{z}@{'H' if self.high[z] else 'L'}"
                add(sink_of[z], "T", int(round(self.demand[z] * SCALE)))

        flow: dict[str, dict[str, int]] = {}
        if "S" in D and "T" in D:
            _, flow = nx.maximum_flow(D, "S", "T")
        s1 = {z: flow.get(sk, {}).get("T", 0) / SCALE for z, sk in sink_of.items()}

        # reachability (pressurised nodes)
        reach_keys: set[str] = set()
        if "S" in D:
            reach_keys = set(nx.descendants(D, "S"))

        # ---- tanks on the residual network
        tank_out: dict[str, float] = {}
        tank_hours: dict[str, float] = {}
        depleted: dict[str, float] = {}
        zone_tanks: dict[str, tuple[str, ...]] = {}
        flow2: dict[str, dict[str, int]] = {}
        s2 = {z: 0.0 for z in sink_of}
        deficit = sum(self.demand[z] - s1[z] for z in sink_of)
        candidates = [
            tk for tk in self.tanks if tk in alive_set and (self.storage_m3.get(tk) or 0) > 0
        ]
        first_attr: dict[str, set[str]] | None = None
        if deficit > EPS and candidates and "T" in D:
            R = nx.DiGraph()

            def addr(u: str, v: str, cap: int) -> None:
                if cap <= 0:
                    return
                if R.has_edge(u, v):
                    R[u][v]["capacity"] += cap
                else:
                    R.add_edge(u, v, capacity=cap)

            for u, nbrs in D.adj.items():
                for v, attr in nbrs.items():
                    f = flow.get(u, {}).get(v, 0)
                    addr(u, v, attr["capacity"] - f)
                    addr(v, u, f)
            active = list(candidates)
            for _ in range(len(candidates) + 1):
                R2 = R.copy()
                for tk in active:
                    addr2 = scaled(self.tank_rate.get(tk))
                    if R2.has_edge("S2", f"{tk}@H"):
                        R2["S2"][f"{tk}@H"]["capacity"] += addr2
                    else:
                        R2.add_edge("S2", f"{tk}@H", capacity=addr2)
                if "S2" not in R2 or "T" not in R2:
                    flow2 = {}
                    break
                _, flow2 = nx.maximum_flow(R2, "S2", "T")
                outs = {tk: flow2["S2"].get(f"{tk}@H", 0) / SCALE for tk in active}
                attr = self._attribute(flow2, active, sink_of)
                if first_attr is None:
                    first_attr = attr
                newly_depleted = False
                for tk in active:
                    out = outs[tk]
                    if out <= EPS:
                        continue
                    hours = (self.storage_m3[tk] or 0.0) * 1000.0 / out / 3600.0
                    if hours + 1e-9 < horizon:
                        depleted[tk] = hours
                        newly_depleted = True
                if not newly_depleted:
                    tank_out = {tk: o for tk, o in outs.items() if o > EPS}
                    tank_hours = {
                        tk: (self.storage_m3[tk] or 0.0) * 1000.0 / o / 3600.0 for tk, o in tank_out.items()
                    }
                    s2 = {z: flow2.get(sk, {}).get("T", 0) / SCALE for z, sk in sink_of.items()}
                    for tk in tank_out:
                        reach_keys |= {f"{tk}@H"} | set(nx.descendants(R2, f"{tk}@H"))
                    break
                active = [tk for tk in active if tk not in depleted]
                flow2 = {}
                if not active:
                    break
            if first_attr:
                for z, tks in first_attr.items():
                    zone_tanks[z] = tuple(sorted(tks))

        # ---- net pipe flows
        net: dict[str, float] = {}
        for e, (u, v) in pipe_ends.items():
            tot = 0
            for layer in ("L", "H"):
                a, b = f"{u}@{layer}", f"{v}@{layer}"
                tot += flow.get(a, {}).get(b, 0) - flow.get(b, {}).get(a, 0)
                tot += flow2.get(a, {}).get(b, 0) - flow2.get(b, {}).get(a, 0)
            net[e] = tot / SCALE
        reach = {k.rsplit("@", 1)[0] for k in reach_keys if "@" in k}
        return _Solve(s1, s2, tank_out, tank_hours, depleted, zone_tanks, net, reach)

    @staticmethod
    def _attribute(flow2: dict[str, dict[str, int]], tanks: list[str], sink_of: dict[str, str]) -> dict[str, set[str]]:
        """Zones reached by each tank's positive phase-2 flow."""
        sink_zone = {sk: z for z, sk in sink_of.items()}
        out: dict[str, set[str]] = {}
        for tk in tanks:
            start = f"{tk}@H"
            if flow2.get("S2", {}).get(start, 0) <= 0:
                continue
            seen = {start}
            stack = [start]
            while stack:
                u = stack.pop()
                for v, f in flow2.get(u, {}).items():
                    if f > 0 and v not in seen:
                        seen.add(v)
                        stack.append(v)
                        if v in sink_zone and flow2.get(v, {}).get("T", 0) > 0:
                            out.setdefault(sink_zone[v], set()).add(tk)
        return out

    # ------------------------------------------------------------------ evaluate
    def evaluate(self, inp: WaterInputs) -> WaterResult:
        g = self.g
        fn = frozenset(n for n in inp.failed_nodes if n in self.node_set)
        fe = frozenset(e for e in inp.failed_edges if e in self.pipe_cap)
        iso_n, iso_e, closing, origin = self._isolate(fn, fe)
        removed_n = set(fn) | iso_n | closing
        removed_e = set(fe) | iso_e
        unpowered = frozenset(p for p in inp.unpowered_pumps if p in self.node_set)
        sol = self._solve(removed_n, removed_e, unpowered, inp.opened_valves, inp.horizon)
        base = getattr(self, "base_solve", sol)

        served: dict[str, float] = {}
        level: dict[str, float] = {}
        for z in self.zones:
            if z in removed_n:
                served[z] = 0.0
                level[z] = 0.0
                continue
            s = sol.s1.get(z, 0.0) + sol.s2.get(z, 0.0)
            served[z] = s
            ref = self.ref.get(z, self.demand[z]) if hasattr(self, "ref") else self.demand[z]
            level[z] = 1.0 if ref <= EPS else min(1.0, s / ref)

        cc = dict(inp.common_cause)

        def issue_text(x: str) -> str | None:
            if x in fe:
                return f"main {g.label(x)} ruptured" + (f" (common-cause damage in {g.cc_phrase(cc[x])})" if x in cc else "")
            if x in iso_e:
                return f"main {g.label(x)} isolated around rupture {g.label(origin[x])}"
            if x in fn:
                return f"{g.label(x)} failed"
            if x in closing:
                return f"valve {g.label(x)} closed to isolate rupture {g.label(origin[x])}"
            if x in iso_n:
                return f"{g.label(x)} isolated around rupture {g.label(origin[x])}"
            if x in unpowered:
                return f"booster pump {g.label(x)} has no power"
            return None

        node_out: dict[str, NodeOutcome] = {}
        node_level: dict[str, float] = {}
        closing_names = {}
        for v in closing:
            closing_names.setdefault(origin.get(v, ""), []).append(v)
        for z in self.zones:
            if z in fn:
                node_level[z] = 0.0
                continue
            node_level[z] = level[z]
            d = self.demand[z]
            if z in iso_n:
                node_out[z] = NodeOutcome(
                    "isolated",
                    f"{g.label(z)} isolated: valves {join_names(sorted(closing_names.get(origin[z], [])))} closed "
                    f"around rupture {g.label(origin[z])}.",
                    (origin[z],),
                    0.0,
                )
                continue
            lv = level[z]
            s2 = sol.s2.get(z, 0.0)
            tanks_txt = ""
            tank_ids: list[str] = []
            for tk in sol.zone_tanks.get(z, ()):
                tank_ids.append(tk)
                if tk in sol.depleted:
                    tanks_txt += (
                        f"; storage tank {g.label(tk)} would be drained after {sol.depleted[tk]:.1f} h "
                        f"(< {fmt_num(inp.horizon)} h horizon)"
                    )
                elif tk in sol.tank_out:
                    tanks_txt += (
                        f"; storage tank {g.label(tk)} supplies {fmt_num(sol.tank_out[tk])} L/s and its "
                        f"{fmt_num(self.storage_m3[tk] or 0, 0)} m³ last {sol.tank_hours[tk]:.1f} h "
                        f"(≥ {fmt_num(inp.horizon)} h horizon)"
                    )
            if lv >= OPERATIONAL_LEVEL and s2 <= EPS:
                continue
            issues: list[str] = []
            issue_ids: list[str] = []
            for x in self.base_up.get(z, []):
                txt = issue_text(x)
                if txt:
                    issues.append(txt)
                    issue_ids.append(x)
            if self.high.get(z) and any(p in unpowered for p in self.base_up.get(z, [])):
                issues.append("a high pressure zone needs an operating booster pump or elevated storage")
            reason = "; ".join(issues[:3]) if issues else "upstream supply capacity is insufficient after rerouting"
            head = f"{g.label(z)} receives {fmt_num(served[z])} of {fmt_num(d)} L/s ({lv * 100:.0f}%)"
            caused = tuple(dict.fromkeys(issue_ids[:4] + tank_ids))
            if lv >= OPERATIONAL_LEVEL:
                node_out[z] = NodeOutcome("on_backup", f"{head} — {reason}{tanks_txt}.", caused, lv)
            elif lv >= OUTAGE_LEVEL:
                node_out[z] = NodeOutcome(
                    "degraded", f"{head}, low pressure — {reason}{tanks_txt}.", caused, lv
                )
            else:
                node_out[z] = NodeOutcome("outage", f"{head} — {reason}{tanks_txt}.", caused, lv)

        for n in self.nodes:
            if n in self.zones or n in fn:
                continue
            ty = g.node_type[n]
            if n in iso_n:
                node_level[n] = 0.0
                node_out[n] = NodeOutcome(
                    "isolated",
                    f"{g.label(n)} isolated: valves {join_names(sorted(closing_names.get(origin[n], [])))} closed "
                    f"around rupture {g.label(origin[n])}.",
                    (origin[n],),
                    0.0,
                )
                continue
            if ty == "pump_station" and n in unpowered:
                node_level[n] = 0.0
                node_out[n] = NodeOutcome(
                    "outage",
                    "Booster pump out of service: bypassed (gravity flow only), it cannot lift water to "
                    "high pressure zones.",
                    (),
                    0.0,
                    dep="power_supply",
                )
                continue
            if ty == "pump_station" and n in inp.backup_pumps:
                node_level[n] = 1.0
                node_out[n] = NodeOutcome("on_backup", "Booster pump running on backup power.", (), 1.0, dep="power_supply")
                continue
            if ty == "storage_tank" and n in sol.tank_out:
                node_level[n] = 1.0
                node_out[n] = NodeOutcome(
                    "on_backup",
                    f"{g.label(n)} drains {fmt_num(sol.tank_out[n])} L/s to cover the supply deficit; "
                    f"{fmt_num(self.storage_m3[n] or 0, 0)} m³ last {sol.tank_hours[n]:.1f} h "
                    f"(≥ {fmt_num(inp.horizon)} h horizon).",
                    (),
                    1.0,
                )
                continue
            if ty == "storage_tank" and n in sol.depleted:
                node_level[n] = 0.0
                node_out[n] = NodeOutcome(
                    "outage",
                    f"{g.label(n)} would be drained after {sol.depleted[n]:.1f} h covering the supply deficit "
                    f"(< {fmt_num(inp.horizon)} h horizon).",
                    (),
                    0.0,
                )
                continue
            if n in closing or (n in self.nc_valves and n not in inp.opened_valves):
                node_level[n] = 1.0
                continue
            if n in sol.reach:
                node_level[n] = 1.0
                continue
            if n in base.reach:
                node_level[n] = 0.0
                node_out[n] = NodeOutcome(
                    "outage",
                    f"{g.label(n)} de-pressurised: no hydraulic path from any supply source or tank.",
                    (),
                    0.0,
                )
            else:
                node_level[n] = 1.0

        # ---- edges & flows
        base_net = base.net
        flows: dict[str, FlowRec] = {}
        edge_out: dict[str, EdgeOutcome] = {}
        for e in self.pipes:
            f = sol.net.get(e, 0.0)
            cap = self.pipe_cap.get(e)
            af = abs(f)
            flows[e] = FlowRec(
                (1 if f > 0 else -1) if af > EPS else 0,
                round(af, 3),
                round(af / cap, 4) if cap else 0.0,
                "L/s",
            )
            if e in fe:
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if e in iso_e:
                vs = sorted(closing_names.get(origin[e], []))
                edge_out[e] = EdgeOutcome(
                    "isolated",
                    f"Isolated: valves {join_names(vs) or 'n/a'} closed around rupture {g.label(origin[e])}",
                )
                continue
            nc = [x for x in (u, v) if x in self.nc_valves and x not in inp.opened_valves]
            if e in self.nc_pipes and e not in inp.opened_valves:
                nc = [e]
            if nc and af <= EPS:
                edge_out[e] = EdgeOutcome("normally_open", f"Behind normally-closed boundary valve {g.label(nc[0])}")
                continue
            bf = base_net.get(e, 0.0)
            if cap and af > cap * (1 + 1e-6):
                edge_out[e] = EdgeOutcome("overloaded", f"Carries {fmt_num(af)} L/s = {af / cap * 100:.0f}% of capacity")
            elif af <= EPS and abs(bf) > EPS:
                bad = [x for x in (u, v) if x in removed_n or x in unpowered]
                why = f"{g.label(bad[0])} out of service" if bad else "upstream supply lost"
                edge_out[e] = EdgeOutcome("interrupted", f"No flow: {why}")
            elif af > EPS and (abs(bf) <= EPS or (bf > 0) != (f > 0)):
                edge_out[e] = EdgeOutcome("rerouted", f"Carries rerouted flow ({fmt_num(af)} L/s)")

        served_total = sum(served.values())
        initially_lost = 0.0
        recovered = 0.0
        prim = getattr(self, "base_primary", {})
        bad_set = set(removed_n) | set(removed_e) | set(unpowered)
        for z in self.zones:
            if z in fn:
                continue
            elems = prim.get(z, set())
            up = set(self.base_up.get(z, [])) if hasattr(self, "base_up") else set()
            hit = bool(elems & bad_set) or (self.high.get(z, False) and bool(up & set(unpowered)))
            if hit:
                initially_lost += self.demand[z]
                recovered += min(self.demand[z], served[z])
        return WaterResult(
            zone_served=served,
            zone_level=level,
            node_level=node_level,
            node_out=node_out,
            edge_out=edge_out,
            flows=flows,
            isolated_nodes=frozenset(iso_n),
            isolated_edges=frozenset(iso_e),
            closing_valves=frozenset(closing),
            tank_outflow=sol.tank_out,
            tank_hours=sol.tank_hours,
            depleted=sol.depleted,
            served_total=served_total,
            demand_total=self.demand_total,
            initially_lost=initially_lost,
            recovered=recovered,
            inputs=inp,
            removed_nodes=frozenset(removed_n),
        )

    # ------------------------------------------------------------- alternatives
    def valve_alternatives(self, res: WaterResult) -> list[AlternativePath]:
        """Opening a normally-closed boundary valve: how much unserved demand would return?"""
        g = self.g
        inp = res.inputs
        deficit = sum(self.demand[z] - res.zone_served[z] for z in self.zones if z not in inp.failed_nodes)
        if deficit <= 0.05:
            return []
        out: list[AlternativePath] = []
        for v in sorted(self.nc_valves | self.nc_pipes):
            if v in res.removed_nodes or v in inp.opened_valves or v in res.isolated_edges:
                continue
            trial = self.evaluate(
                WaterInputs(
                    inp.failed_nodes,
                    inp.failed_edges,
                    inp.unpowered_pumps,
                    inp.backup_pumps,
                    inp.common_cause,
                    inp.horizon,
                    inp.opened_valves | {v},
                )
            )
            gain = trial.served_total - res.served_total
            if gain <= 0.05:
                continue
            gains = {
                z: trial.zone_served[z] - res.zone_served[z]
                for z in self.zones
                if trial.zone_served[z] - res.zone_served[z] > 0.01
            }
            if not gains:
                continue
            best = max(sorted(gains), key=lambda z: gains[z])
            zone_deficit = sum(self.demand[z] - res.zone_served[z] for z in gains)
            # path from the valve to the main beneficiary over in-service pipes
            G = nx.Graph()
            for e in self.pipes:
                if e in inp.failed_edges or e in res.isolated_edges:
                    continue
                ed = g.edges[e]
                a, b = ed.source_node, ed.target_node
                if (a in res.removed_nodes or b in res.removed_nodes) and v not in (a, b):
                    continue
                if (a in self.nc_valves and a != v) or (b in self.nc_valves and b != v):
                    continue
                if e in self.nc_pipes and e != v:
                    continue
                if not G.has_edge(a, b):
                    G.add_edge(a, b, eid=e, w=g.edge_length(e))
            start = v if v in self.node_set else g.edges[v].source_node
            try:
                path = nx.shortest_path(G, start, best, weight="w")
                epath = [G[a][b]["eid"] for a, b in zip(path, path[1:])]
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                path, epath = [start, best], list(self.inc.get(v, [v]))
            if v in self.nc_pipes:
                epath = [v] + [x for x in epath if x != v]
            out.append(
                AlternativePath(
                    id=f"alt-water-valve-{v}",
                    system="water",
                    purpose="boundary valve opening",
                    from_node=v,
                    to_node=best,
                    node_ids=path,
                    edge_ids=epath,
                    description=(
                        f"Opening normally-closed boundary valve {g.label(v)} would restore {fmt_num(gain)} L/s "
                        f"to {join_names([g.label(z) for z in sorted(gains)])} (deficit there "
                        f"{fmt_num(zone_deficit)} L/s); not applied automatically."
                    ),
                    capacity_ok=gain >= zone_deficit * OPERATIONAL_LEVEL,
                    added_length_m=round(sum(g.edge_length(e) for e in epath), 1),
                )
            )
        return out
