"""Transport model: road closures, dark signals, O-D travel times, detours and rail.

* **Road graph** – directed graph of ``road_segment`` edges (both directions unless
  ``directed``); travel time = ``properties.travel_time_s`` or length / speed
  (``speed_kph``, default 40 km/h). Failed segments / intersections are removed.
* **Signals** – a ``signalized`` intersection that loses power without battery backup
  becomes an all-way stop: +25 s on every approach (arc entering the node); the node is
  ``degraded``.
* **O-D analysis** – origins are the district ``gateway`` nodes; destinations are critical
  facilities (reached via their ``road_access`` provider intersections, else the nearest
  road node), transit stations and the other gateways. Travel-time change =
  Σ scenario / Σ baseline − 1 over pairs reachable in both. A gateway that can reach
  fewer than half of its baseline destinations is itself cut off (``inaccessible``) and
  its pairs are not held against other destinations. A destination no connected gateway
  can reach is ``inaccessible``; one whose travel time grew by more than 25 % (or that
  some connected gateways can no longer reach) is ``delayed``. Every facility with ``road_access`` gets an
  access status the same way (used by the dependency step).
* **Detours** – pairs whose baseline route is blocked but still reachable become
  ``AlternativePath`` (purpose "traffic detour"); road edges whose O-D load grew are
  ``rerouted``.
* **Edge flows** – an O-D assignment *index*: each O-D pair loads one trip unit onto its
  shortest path; units are scaled so the busiest baseline edge runs at 85 % of its
  capacity (veh/h, default lanes × 900). Not counted traffic.
* **Rail** – a ``transit_station`` without station/traction power (no backup) is
  ``closed``; stations severed from every other open station are closed; rail segments
  touching closed stations or isolated fragments are ``interrupted``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import networkx as nx

from app.models.schemas import AlternativePath
from app.simulation.common import EPS, EdgeOutcome, FlowRec, NodeOutcome, fmt_num, join_names
from app.simulation.graph import NetworkGraphs, as_bool, as_float, haversine_m

SIGNAL_DELAY_S = 25.0
DEFAULT_SPEED_KPH = 40.0
DELAY_THRESHOLD = 0.25
LANE_CAPACITY_VPH = 900.0
DEFAULT_LANES = 2.0
TARGET_PEAK_UTIL = 0.85
MAX_DETOURS = 12


@dataclass(frozen=True)
class TransportInputs:
    failed_nodes: frozenset[str]
    failed_edges: frozenset[str]
    dark: frozenset[str] = frozenset()
    signal_backup: frozenset[str] = frozenset()
    stations_unpowered: frozenset[str] = frozenset()
    stations_backup: frozenset[str] = frozenset()
    common_cause: frozenset[tuple[str, str]] = frozenset()
    detours: bool = True


@dataclass(frozen=True)
class Destination:
    id: str
    kind: str  # "facility" | "station" | "gateway"
    access: tuple[str, ...]
    in_od: bool  # counts towards the O-D travel-time metric


@dataclass
class AccessStatus:
    status: str  # "ok" | "detour" (rerouted, below the delay threshold) | "delayed" | "inaccessible"
    increase: float
    cause: str
    caused_by: tuple[str, ...]


@dataclass
class TransportResult:
    reachable: frozenset[str]
    access: dict[str, AccessStatus]
    stations_closed: frozenset[str]
    node_out: dict[str, NodeOutcome]
    edge_out: dict[str, EdgeOutcome]
    flows: dict[str, FlowRec]
    alternatives: list[AlternativePath]
    travel_time_increase_pct: float
    base_sum_s: float
    scen_sum_s: float
    od_pairs_total: int
    od_pairs_unreachable: int
    accessible_destinations: int
    destinations_total: int
    initially_lost: float
    recovered: float
    pair_time: dict[tuple[str, str], float]
    pair_path: dict[tuple[str, str], list[str]]
    pair_epath: dict[tuple[str, str], list[str]]
    counts: dict[str, float] = field(default_factory=dict)


class TransportModel:
    def __init__(self, g: NetworkGraphs) -> None:
        self.g = g
        self.nodes: list[str] = list(g.nodes_by_system.get("transport", []))
        self.node_set = set(self.nodes)
        t = g.node_type
        tedges = [
            e
            for e in g.physical_edges_by_system.get("transport", [])
            if g.edges[e].source_node in self.node_set and g.edges[e].target_node in self.node_set
        ]
        self.rail_edges = [e for e in tedges if g.edges[e].connection_type == "rail_segment"]
        self.road_edges = [e for e in tedges if g.edges[e].connection_type != "rail_segment"]
        self.gateways = [n for n in self.nodes if t[n] == "gateway"]
        self.stations = [n for n in self.nodes if t[n] == "transit_station"]
        self.signalized = {
            n for n in self.nodes if t[n] == "intersection" and as_bool(g.nodes[n].properties.get("signalized", False))
        }
        self.road_nodes = sorted(
            {g.edges[e].source_node for e in self.road_edges}
            | {g.edges[e].target_node for e in self.road_edges}
            | set(self.gateways)
        )
        self.tt: dict[str, float] = {}
        self.cap: dict[str, float] = {}
        for e in self.road_edges:
            ed = g.edges[e]
            tt = as_float(ed.properties.get("travel_time_s"))
            if tt is None or tt <= 0:
                speed = as_float(ed.properties.get("speed_kph"), DEFAULT_SPEED_KPH) or DEFAULT_SPEED_KPH
                tt = g.edge_length(e) / (speed / 3.6)
            self.tt[e] = max(0.1, tt)
            cap = as_float(ed.capacity)
            if not cap or cap <= 0:
                lanes = as_float(ed.properties.get("lanes"), DEFAULT_LANES) or DEFAULT_LANES
                cap = lanes * LANE_CAPACITY_VPH
            self.cap[e] = cap

        # destinations
        road_set = set(self.road_nodes)
        self.dests: list[Destination] = []
        for f in g.nodes_by_system.get("facility", []):
            acc = sorted(
                {
                    link.provider
                    for link in g.providers.get(f, [])
                    if link.ctype == "road_access" and link.provider in road_set
                }
            )
            critical = bool(g.nodes[f].critical)
            if not acc and critical:
                near = self._nearest_road(f)
                acc = [near] if near else []
            if acc:
                self.dests.append(Destination(f, "facility", tuple(acc), critical))
        for s in self.stations:
            if s in road_set:
                acc = [s]
            else:
                acc = sorted(
                    {
                        link.provider
                        for link in g.providers.get(s, [])
                        if link.ctype == "road_access" and link.provider in road_set
                    }
                )
                if not acc:
                    near = self._nearest_road(s)
                    acc = [near] if near else []
            if acc:
                self.dests.append(Destination(s, "station", tuple(acc), True))
        for gw in self.gateways:
            self.dests.append(Destination(gw, "gateway", (gw,), True))
        self.dest_by_id = {d.id: d for d in self.dests}

        self.k = 1.0
        self.baseline = self.evaluate(TransportInputs(frozenset(), frozenset()))
        peak = [self.cap[e] / cnt for e, cnt in self._base_counts.items() if cnt > 0 and self.cap.get(e)]
        self.k = TARGET_PEAK_UTIL * min(peak) if peak else 1.0
        self.baseline = self.evaluate(TransportInputs(frozenset(), frozenset()))

    def _nearest_road(self, nid: str) -> str | None:
        if not self.road_nodes:
            return None
        n = self.g.nodes[nid]
        return min(
            self.road_nodes,
            key=lambda r: (
                haversine_m(n.latitude, n.longitude, self.g.nodes[r].latitude, self.g.nodes[r].longitude),
                r,
            ),
        )

    # ------------------------------------------------------------------ evaluate
    def evaluate(self, inp: TransportInputs) -> TransportResult:
        g = self.g
        fn = frozenset(n for n in inp.failed_nodes if n in self.node_set)
        fe = inp.failed_edges
        dark = frozenset(n for n in inp.dark if n in self.node_set and n not in fn)
        D = nx.DiGraph()
        D.add_nodes_from(n for n in self.road_nodes if n not in fn)

        def add(u: str, v: str, w: float, e: str) -> None:
            w2 = w + (SIGNAL_DELAY_S if v in dark else 0.0)
            if not D.has_edge(u, v) or D[u][v]["w"] > w2:
                D.add_edge(u, v, w=w2, eid=e)

        for e in self.road_edges:
            if e in fe:
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if u in fn or v in fn:
                continue
            add(u, v, self.tt[e], e)
            if not ed.directed:
                add(v, u, self.tt[e], e)

        base: TransportResult | None = getattr(self, "baseline", None)
        reach: set[str] = set()
        pair_time: dict[tuple[str, str], float] = {}
        pair_path: dict[tuple[str, str], list[str]] = {}
        pair_epath: dict[tuple[str, str], list[str]] = {}
        for gw in self.gateways:
            if gw not in D:
                continue
            dist, paths = nx.single_source_dijkstra(D, gw, weight="w")
            reach |= set(dist)
            for d in self.dests:
                if d.id == gw:
                    continue
                key = (gw, d.id)
                if not inp.detours and base is not None and key in base.pair_path:
                    # no rerouting: keep the baseline route if it is still passable
                    bp = base.pair_path[key]
                    if all(
                        D.has_edge(a, b) and D[a][b]["eid"] == e for a, b, e in zip(bp, bp[1:], base.pair_epath[key])
                    ):
                        pair_time[key] = sum(D[a][b]["w"] for a, b in zip(bp, bp[1:]))
                        pair_path[key] = bp
                        pair_epath[key] = base.pair_epath[key]
                    continue
                best = None
                for a in d.access:
                    if a in dist and (best is None or (dist[a], a) < (dist[best], best)):
                        best = a
                if best is None:
                    continue
                p = paths[best]
                pair_time[key] = dist[best]
                pair_path[key] = p
                pair_epath[key] = [D[a][b]["eid"] for a, b in zip(p, p[1:])]

        # ---- O-D assignment counts
        counts: dict[str, float] = {e: 0.0 for e in self.road_edges}
        signed: dict[str, float] = {e: 0.0 for e in self.road_edges}
        for key, p in pair_path.items():
            for a, e in zip(p, pair_epath[key]):
                counts[e] += 1
                signed[e] += 1 if g.edges[e].source_node == a else -1
        if base is None:
            self._base_counts = counts

        # ---- rail
        stations_closed: dict[str, NodeOutcome] = {}
        for s in self.stations:
            if s in fn:
                continue
            if s in inp.stations_unpowered:
                stations_closed[s] = NodeOutcome(
                    "closed", "Station closed: no station/traction power.", (), 0.0, dep="power_supply"
                )
        R = nx.MultiGraph()
        rail_nodes = {g.edges[e].source_node for e in self.rail_edges} | {
            g.edges[e].target_node for e in self.rail_edges
        }
        R.add_nodes_from(n for n in rail_nodes if n not in fn and n not in stations_closed)
        for e in self.rail_edges:
            if e in fe:
                continue
            ed = g.edges[e]
            if ed.source_node in R and ed.target_node in R:
                R.add_edge(ed.source_node, ed.target_node, key=e)
        severed_comp: set[str] = set()
        for comp in nx.connected_components(R):
            open_st = [n for n in comp if g.node_type[n] == "transit_station"]
            if len(open_st) < 2:
                severed_comp |= set(comp)
                for s in open_st:
                    if s in rail_nodes and s not in stations_closed:
                        cut = sorted(
                            {e for e in self.rail_edges if e in fe}
                            | {n for n in rail_nodes if n in fn or n in stations_closed}
                        )
                        stations_closed[s] = NodeOutcome(
                            "closed",
                            f"{g.label(s)} closed: rail line severed"
                            + (f" ({join_names([g.label(x) for x in cut], 3)} out of service)" if cut else "")
                            + "; no train can reach it.",
                            tuple(cut[:4]),
                            0.0,
                        )

        # ---- destinations
        cc = dict(inp.common_cause)

        def blocked_text(x: str) -> str:
            if x in g.edges:
                return f"{g.label(x)} closed" + (f" (common-cause damage in {g.cc_phrase(cc[x])})" if x in cc else "")
            return f"{g.label(x)} failed"

        def first_blocked(p: list[str], ep: list[str]) -> str | None:
            if p and p[0] in fn:
                return p[0]
            for b, e in zip(p[1:], ep):
                if e in fe:
                    return e
                if b in fn:
                    return b
            return None

        access: dict[str, AccessStatus] = {}
        base_sum = scen_sum = 0.0
        od_total = od_unreach = 0
        initially_lost = recovered = 0.0
        accessible = dest_total = 0
        detour_cands: list[tuple[float, str, str]] = []
        # a gateway that can no longer reach most of its baseline destinations is itself cut
        # off: it is reported as inaccessible and its pairs do not make every destination "delayed"
        cut_gateways: set[str] = set()
        if base is not None:
            for gw in self.gateways:
                b_n = sum(1 for k in base.pair_time if k[0] == gw)
                s_n = sum(1 for k in pair_time if k[0] == gw)
                if b_n and s_n < 0.5 * b_n:
                    cut_gateways.add(gw)
        for d in self.dests:
            pairs = [(gw, d.id) for gw in self.gateways if gw != d.id]
            bpairs = [k for k in pairs if base is None or k in base.pair_time]
            if not bpairs:
                continue
            rpairs = [k for k in bpairs if k in pair_time]
            if d.in_od:
                dest_total += 1
                accessible += 1 if rpairs else 0
                od_total += len(bpairs)
                od_unreach += len(bpairs) - len(rpairs)
            if base is None:
                if d.in_od:
                    tsum = sum(pair_time[k] for k in rpairs)
                    base_sum += tsum
                    scen_sum += tsum
                access[d.id] = AccessStatus("ok", 0.0, "", ())
                continue
            bsum = sum(base.pair_time[k] for k in rpairs)
            ssum = sum(pair_time[k] for k in rpairs)
            if d.in_od:
                base_sum += bsum
                scen_sum += ssum
            blocked: list[str] = []
            for k in bpairs:
                br = first_blocked(base.pair_path[k], base.pair_epath[k])
                if br is not None:
                    blocked.append(br)
                    if d.in_od:
                        initially_lost += 1
                        if k in pair_time:
                            recovered += 1
                            detour_cands.append((pair_time[k] - base.pair_time[k], k[0], k[1]))
            darks = sorted({x for k in rpairs for x in pair_path[k] if x in dark})
            blocked_u = list(dict.fromkeys(blocked))
            inc = (ssum / bsum - 1.0) if bsum > EPS else 0.0
            why_parts: list[str] = []
            if blocked_u:
                why_parts.append("route blocked where " + join_names([blocked_text(x) for x in blocked_u], 3))
            if darks:
                why_parts.append(
                    f"dark signals at {join_names([g.label(x) for x in darks], 3)} (+{SIGNAL_DELAY_S:.0f} s per approach)"
                )
            why = "; ".join(why_parts) if why_parts else "longer routes after closures"
            ids = tuple(dict.fromkeys(blocked_u[:4] + darks[:3]))
            judged = [k for k in bpairs if k[0] not in cut_gateways] or bpairs
            lost_gw = sum(1 for k in judged if k not in pair_time)
            if not rpairs or not any(k in pair_time for k in judged):
                access[d.id] = AccessStatus(
                    "inaccessible",
                    1.0,
                    f"Unreachable from all {len(judged)} connected district gateways: {why}."
                    if rpairs
                    else f"Unreachable from all {len(bpairs)} district gateways: {why}.",
                    ids,
                )
            elif inc > DELAY_THRESHOLD + 1e-9 or lost_gw:
                access[d.id] = AccessStatus(
                    "delayed",
                    inc,
                    f"Travel time from gateways {'+' if inc >= 0 else ''}{inc * 100:.0f}% "
                    f"(avg {bsum / len(rpairs) / 60:.1f} → {ssum / len(rpairs) / 60:.1f} min)"
                    + (f", unreachable from {lost_gw} of {len(judged)} gateways" if lost_gw else "")
                    + f": {why}.",
                    ids,
                )
            else:
                changed = [k for k in rpairs if pair_epath[k] != base.pair_epath[k]]
                if changed and ssum > bsum + 0.5:
                    # still within the delay threshold, but traffic had to take another route
                    access[d.id] = AccessStatus(
                        "detour",
                        inc,
                        f"Detour from {len(changed)} of {len(judged)} gateways: travel time "
                        f"{'+' if inc >= 0 else ''}{inc * 100:.0f}% (avg {bsum / len(rpairs) / 60:.1f} → "
                        f"{ssum / len(rpairs) / 60:.1f} min, below the {DELAY_THRESHOLD * 100:.0f}% delay "
                        f"threshold): {why}.",
                        ids,
                    )
                else:
                    access[d.id] = AccessStatus("ok", inc, "", ())

        tt_pct = (scen_sum / base_sum - 1.0) * 100.0 if base_sum > EPS else 0.0

        # ---- node outcomes
        node_out: dict[str, NodeOutcome] = {}
        base_reach = base.reachable if base is not None else frozenset(reach)
        for n in self.nodes:
            if n in fn:
                continue
            out: NodeOutcome | None = None
            if n in dark:
                out = NodeOutcome(
                    "degraded",
                    f"Traffic signal dark: operates as an all-way stop (+{SIGNAL_DELAY_S:.0f} s per approach).",
                    (),
                    0.5,
                    dep="power_supply",
                )
            elif n in inp.signal_backup and n in self.signalized:
                out = NodeOutcome("on_backup", "Traffic signal running on battery backup.", (), 1.0, dep="power_supply")
            if n in stations_closed:
                out = stations_closed[n]
            elif n in self.stations and n in inp.stations_backup:
                out = NodeOutcome("on_backup", "Station running on backup power.", (), 1.0, dep="power_supply")
            if n in self.road_nodes and n in base_reach and n not in reach:
                why = ""
                blk = sorted(
                    {e for e in g.incident[n] if e in fe}
                    | {g.other_end(e, n) for e in g.incident[n] if g.other_end(e, n) in fn}
                )
                if blk:
                    why = ": " + join_names([blocked_text(x) for x in blk], 3)
                inacc = NodeOutcome(
                    "inaccessible",
                    f"{g.label(n)} cut off from every district gateway{why}.",
                    tuple(blk[:4]),
                    0.0,
                )
                out = inacc if out is None or out.state in ("degraded", "on_backup") else out
            acc = access.get(n)
            if acc and acc.status == "detour" and out is None:
                out = NodeOutcome("operational", f"{g.label(n)}: {acc.cause}", acc.caused_by, 1.0, info=True)
            elif acc and acc.status not in ("ok", "detour") and (out is None or out.state in ("degraded", "on_backup")):
                st = "inaccessible" if acc.status == "inaccessible" else "delayed"
                lvl = (
                    0.0 if st == "inaccessible" else round(max(0.0, min(1.0, 1.0 / (1.0 + max(acc.increase, 0.0)))), 4)
                )
                new = NodeOutcome(st, f"{g.label(n)}: {acc.cause}", acc.caused_by, lvl)
                out = (
                    new
                    if out is None
                    else NodeOutcome(
                        new.state, f"{new.cause} {out.cause}", new.caused_by, new.service_level, dep=out.dep
                    )
                )
            if out is not None:
                node_out[n] = out

        # ---- edges carrying rerouted O-D traffic: new edges on every changed route
        detour_edges: set[str] = set()
        if base is not None:
            for key, ep in pair_epath.items():
                bep = base.pair_epath.get(key)
                if bep is not None and ep != bep:
                    detour_edges |= set(ep) - set(bep)

        # ---- edges & flows
        base_counts = base.counts if base is not None else counts
        flows: dict[str, FlowRec] = {}
        edge_out: dict[str, EdgeOutcome] = {}
        for e in self.road_edges:
            veh = counts[e] * self.k
            util = veh / self.cap[e] if self.cap[e] else 0.0
            flows[e] = FlowRec(
                (1 if signed[e] > 0 else -1 if signed[e] < 0 else 1) if counts[e] > 0 else 0,
                round(veh, 2),
                round(util, 4),
                "veh/h",
            )
            if e in fe:
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            bad = [x for x in (u, v) if x in fn]
            if bad:
                edge_out[e] = EdgeOutcome("interrupted", f"Closed: intersection {g.label(bad[0])} failed")
            elif (u in base_reach and u not in reach) or (v in base_reach and v not in reach):
                edge_out[e] = EdgeOutcome("interrupted", "Cut off from every district gateway")
            elif util > 1.0 + 1e-6 and counts[e] > base_counts.get(e, 0):
                edge_out[e] = EdgeOutcome("overloaded", f"Detour traffic at {util * 100:.0f}% of capacity (O-D index)")
            elif e in detour_edges:
                delta = counts[e] - base_counts.get(e, 0)
                edge_out[e] = EdgeOutcome(
                    "rerouted",
                    "Carries detour traffic" + (f" ({int(delta)} more O-D routes than normal)" if delta > 0 else ""),
                )
        for e in self.rail_edges:
            flows[e] = FlowRec(0, 0.0, 0.0, None)
            if e in fe:
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            bad = [x for x in (u, v) if x in fn or x in stations_closed]
            if bad:
                edge_out[e] = EdgeOutcome("interrupted", f"No service: station {g.label(bad[0])} closed")
            elif u in severed_comp or v in severed_comp:
                edge_out[e] = EdgeOutcome("interrupted", "No service: isolated rail fragment")

        # ---- detours
        alternatives: list[AlternativePath] = []
        if base is not None:
            detour_cands.sort(key=lambda x: (-x[0], x[1], x[2]))
            for added, gw, did in detour_cands[:MAX_DETOURS]:
                key = (gw, did)
                p = list(pair_path[key])
                ep = pair_epath[key]
                if p[-1] != did:
                    p.append(did)
                new_len = sum(g.edge_length(e) for e in ep)
                old_len = sum(g.edge_length(e) for e in base.pair_epath[key])
                br = first_blocked(base.pair_path[key], base.pair_epath[key])
                alternatives.append(
                    AlternativePath(
                        id=f"alt-transport-{gw}-{did}",
                        system="transport",
                        purpose="traffic detour",
                        from_node=gw,
                        to_node=did,
                        node_ids=p,
                        edge_ids=ep,
                        description=(
                            f"Detour {g.label(gw)} → {g.label(did)} avoiding {blocked_text(br) if br else 'closures'}: "
                            f"{base.pair_time[key] / 60:.1f} → {pair_time[key] / 60:.1f} min "
                            f"(+{added:.0f} s, {'+' if new_len >= old_len else ''}{fmt_num(new_len - old_len, 0)} m)."
                        ),
                        capacity_ok=all(flows[e].utilization <= 1.0 + 1e-6 for e in ep),
                        added_length_m=round(new_len - old_len, 1),
                        added_time_s=round(added, 1),
                    )
                )

        res = TransportResult(
            reachable=frozenset(reach),
            access=access,
            stations_closed=frozenset(stations_closed),
            node_out=node_out,
            edge_out=edge_out,
            flows=flows,
            alternatives=alternatives,
            travel_time_increase_pct=tt_pct,
            base_sum_s=base_sum,
            scen_sum_s=scen_sum,
            od_pairs_total=od_total,
            od_pairs_unreachable=od_unreach,
            accessible_destinations=accessible,
            destinations_total=dest_total,
            initially_lost=initially_lost,
            recovered=recovered,
            pair_time=pair_time,
            pair_path=pair_path,
            pair_epath=pair_epath,
            counts=counts,
        )
        return res
