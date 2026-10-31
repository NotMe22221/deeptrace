"""Power distribution model: energisation, tie-switch restoration, loading and trips.

Model (deliberately simple and explainable — *no AC power flow*):

1. **Energisation** – multi-source BFS from every operating ``transmission_substation``
   over closed, operational elements. Normally-open elements (``tie_line`` edges with
   status ``normally_open`` / ``properties.normally_open`` and ``switch`` nodes with
   ``properties.normally_open``) are excluded. The BFS tree is the radial supply path;
   every reached node knows its supplying distribution substation (``ds_of``) and
   transmission source (``root_of``). Neighbours are visited in sorted order, so a
   substation fed from two transmission sources is assigned to the first one reached
   (deterministic).
2. **Restoration** (``scenario.enable_restoration``) – each de-energised island (connected
   component of the closed graph) is offered every normally-open *tie unit* (an open
   switch plus its incident edges, or a lone open edge) that joins it to an energised
   node. Headroom = min(tie capacity, supplying DS rating − served load, supplying TS
   rating − served load). If headroom ≥ island load the whole island is restored;
   otherwise vaults are restored greedily in priority order (critical consumers first,
   then larger loads) as long as the energised path from the tie still fits — the
   rest is sectionalised off and stays de-energised.
3. **SCADA** – a tie whose switch has a ``control_link`` provider that is down can only
   be closed by a crew: allowed when ``horizon_hours ≥ manual_switch_hours`` (default
   3 h). Ties without a control link are assumed remotely controlled.
4. **Loading** – the load of a substation is the sum of served demand below it in the
   supply tree (radial approximation, unity power factor, no losses). Above 100 % of
   rating the substation is ``overloaded``; above the 120 % emergency limit it trips
   (the cascade orchestrator fails it in the next round).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from app.simulation.common import EPS, EdgeOutcome, FlowRec, NodeOutcome, fmt_num
from app.simulation.graph import INF, NetworkGraphs, as_bool, as_float

EMERGENCY_LIMIT = 1.2
DEFAULT_MANUAL_SWITCH_HOURS = 3.0
SUBSTATION_TYPES = frozenset({"transmission_substation", "distribution_substation"})


@dataclass(frozen=True)
class PowerInputs:
    """Everything that determines a power evaluation (used as memoisation key)."""

    failed_nodes: frozenset[str]
    failed_edges: frozenset[str]
    tripped: frozenset[str] = frozenset()
    common_cause: frozenset[tuple[str, str]] = frozenset()  # (edge id, corridor id)
    scada_down: frozenset[tuple[str, tuple[str, ...]]] = frozenset()  # (switch id, lost providers)
    restoration: bool = True
    horizon: float = 4.0


@dataclass(frozen=True)
class TieUnit:
    id: str
    switches: tuple[str, ...]
    edges: tuple[str, ...]
    terminals: tuple[str, ...]
    capacity: float
    manual_hours: float
    automated: bool


@dataclass(frozen=True)
class TieAction:
    unit: TieUnit
    supplier: str
    entry: str
    ds: str | None
    island_load: float
    restored_load: float
    headroom: float
    limit: str
    mode: str  # "automatic" | "manual"
    scada_providers: tuple[str, ...]
    restored_nodes: tuple[str, ...]
    left_nodes: tuple[str, ...]


@dataclass
class PowerResult:
    energized: frozenset[str]
    restored: frozenset[str]
    deenergized: frozenset[str]
    parent: dict[str, tuple[str | None, str | None]]
    ds_of: dict[str, str | None]
    root_of: dict[str, str]
    load: dict[str, float]
    loading: dict[str, float]
    overloaded: dict[str, float]
    trip: dict[str, float]
    node_out: dict[str, NodeOutcome]
    edge_out: dict[str, EdgeOutcome]
    flows: dict[str, FlowRec]
    actions: list[TieAction]
    served_load: float
    total_load: float
    initially_lost: float
    recovered: float
    restored_load: float
    blocked_ties: dict[str, str] = field(default_factory=dict)


class PowerModel:
    def __init__(self, g: NetworkGraphs) -> None:
        self.g = g
        self.nodes: list[str] = list(g.nodes_by_system.get("power", []))
        self.node_set = set(self.nodes)
        t = g.node_type
        self.sources = [n for n in self.nodes if t[n] == "transmission_substation"] or [
            n for n in self.nodes if t[n] == "distribution_substation"
        ]
        self.substations = [n for n in self.nodes if t[n] in SUBSTATION_TYPES]
        self.cap: dict[str, float | None] = {n: as_float(g.nodes[n].capacity) for n in self.substations}
        self.demand: dict[str, float] = {}
        for n in self.nodes:
            if t[n] in SUBSTATION_TYPES:
                continue
            d = as_float(g.nodes[n].demand, 0.0) or 0.0
            if d > 0:
                self.demand[n] = d
        self.total_load = sum(self.demand.values())
        self.open_nodes = {
            n for n in self.nodes if t[n] == "switch" and as_bool(g.nodes[n].properties.get("normally_open", False))
        }
        self.edges: list[str] = [
            e
            for e in g.physical_edges_by_system.get("power", [])
            if g.edges[e].source_node in self.node_set and g.edges[e].target_node in self.node_set
        ]
        self.edge_cap: dict[str, float | None] = {e: as_float(g.edges[e].capacity) for e in self.edges}
        open_edges = {
            e
            for e in self.edges
            if g.edges[e].status == "normally_open" or as_bool(g.edges[e].properties.get("normally_open", False))
        }

        # closed adjacency (sorted -> deterministic BFS)
        adj: dict[str, list[tuple[str, str]]] = {n: [] for n in self.nodes}
        unit_elems: list[str] = []
        for e in self.edges:
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if e in open_edges or u in self.open_nodes or v in self.open_nodes:
                unit_elems.append(e)
                continue
            adj[u].append((v, e))
            if not ed.directed:
                adj[v].append((u, e))
        self.adj = {n: sorted(lst) for n, lst in adj.items()}

        # tie units (union-find over open switches and open/attached edges)
        uf: dict[str, str] = {}

        def find(x: str) -> str:
            while uf[x] != x:
                uf[x] = uf[uf[x]]
                x = uf[x]
            return x

        def union(a: str, b: str) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                uf[max(ra, rb)] = min(ra, rb)

        for s in self.open_nodes:
            uf["n:" + s] = "n:" + s
        for e in unit_elems:
            uf["e:" + e] = "e:" + e
            ed = g.edges[e]
            for end in (ed.source_node, ed.target_node):
                if end in self.open_nodes:
                    union("e:" + e, "n:" + end)
        groups: dict[str, list[str]] = {}
        for k in sorted(uf):
            groups.setdefault(find(k), []).append(k)
        self.units: list[TieUnit] = []
        for members in groups.values():
            switches = tuple(sorted(m[2:] for m in members if m.startswith("n:")))
            uedges = tuple(sorted(m[2:] for m in members if m.startswith("e:")))
            terms = sorted(
                {
                    end
                    for e in uedges
                    for end in (g.edges[e].source_node, g.edges[e].target_node)
                    if end not in self.open_nodes
                }
            )
            if len(terms) < 2:
                continue
            caps = [c for c in (self.edge_cap[e] for e in uedges) if c is not None and c > 0]
            caps += [c for c in (as_float(g.nodes[s].capacity) for s in switches) if c is not None and c > 0]
            hours = [
                as_float(g.nodes[s].properties.get("manual_switch_hours"), None) for s in switches
            ]
            hours = [h for h in hours if h is not None]
            automated = not any(
                g.nodes[s].properties.get("automated") is False
                or g.nodes[s].properties.get("remote_controlled") is False
                or as_bool(g.nodes[s].properties.get("manual_only", False))
                for s in switches
            )
            self.units.append(
                TieUnit(
                    id=switches[0] if switches else uedges[0],
                    switches=switches,
                    edges=uedges,
                    terminals=tuple(terms),
                    capacity=min(caps) if caps else INF,
                    manual_hours=max(hours) if hours else DEFAULT_MANUAL_SWITCH_HOURS,
                    automated=automated,
                )
            )
        self.units.sort(key=lambda u: u.id)
        self.term_units: dict[str, list[int]] = {}
        for i, u in enumerate(self.units):
            for tnode in u.terminals:
                self.term_units.setdefault(tnode, []).append(i)
        self.unit_of_edge = {e: i for i, u in enumerate(self.units) for e in u.edges}
        self.unit_of_switch = {s: i for i, u in enumerate(self.units) for s in u.switches}

        # restoration priority: vaults that are critical or feed a critical consumer
        self.critical: set[str] = set()
        for n in self.nodes:
            if g.nodes[n].critical:
                self.critical.add(n)
            for link in g.consumers.get(n, []):
                if link.ctype == "power_supply" and g.nodes[link.consumer].critical:
                    self.critical.add(n)

        # baseline supply tree (used to explain *why* a node lost supply)
        self.baseline = self.evaluate(PowerInputs(frozenset(), frozenset()))
        self.base_chain: dict[str, list[tuple[str, str]]] = {}
        self.base_feeder: dict[str, str | None] = {}
        par = self.baseline.parent
        for n in par:
            chain: list[tuple[str, str]] = []
            cur = n
            while par[cur][0] is not None:
                p, e = par[cur]
                chain.append((e or "", p))  # type: ignore[arg-type]
                cur = p  # type: ignore[assignment]
            self.base_chain[n] = chain
            feeder = None
            for e, p in chain:
                if p is not None and g.node_type.get(p) == "distribution_substation":
                    feeder = g.eprop(e, "feeder_id", "feeder", default=None) or e
                    break
            self.base_feeder[n] = feeder

    # ------------------------------------------------------------------ helpers
    def _components(self, nodes: set[str], fe: frozenset[str]) -> list[list[str]]:
        seen: set[str] = set()
        comps: list[list[str]] = []
        for start in sorted(nodes):
            if start in seen:
                continue
            comp = [start]
            seen.add(start)
            q = deque([start])
            while q:
                u = q.popleft()
                for v, e in self.adj[u]:
                    if v in nodes and v not in seen and e not in fe:
                        seen.add(v)
                        comp.append(v)
                        q.append(v)
            comps.append(sorted(comp))
        # most valuable islands first: critical, then load, then id
        comps.sort(
            key=lambda c: (
                not any(n in self.critical for n in c),
                -sum(self.demand.get(n, 0.0) for n in c),
                c[0],
            )
        )
        return comps

    def _restore_subset(
        self, comp: list[str], entry: str, headroom: float, fe: frozenset[str]
    ) -> tuple[list[str], float, dict[str, tuple[str, str]]]:
        comp_set = set(comp)
        tree: dict[str, tuple[str, str]] = {}
        order = [entry]
        seen = {entry}
        q = deque([entry])
        while q:
            u = q.popleft()
            for v, e in self.adj[u]:
                if v in comp_set and v not in seen and e not in fe:
                    seen.add(v)
                    tree[v] = (u, e)
                    order.append(v)
                    q.append(v)
        comp_load = sum(self.demand.get(n, 0.0) for n in order)
        if comp_load <= headroom + EPS:
            return order, comp_load, tree
        prio = sorted(
            (n for n in order if self.demand.get(n, 0.0) > 0),
            key=lambda n: (n not in self.critical, -self.demand[n], n),
        )
        chosen: set[str] = set()
        load = 0.0
        for v in prio:
            path = [v]
            while path[-1] != entry:
                path.append(tree[path[-1]][0])
            add = [p for p in path if p not in chosen]
            add_load = sum(self.demand.get(p, 0.0) for p in add)
            if load + add_load <= headroom + EPS:
                chosen.update(add)
                load += add_load
        return [n for n in order if n in chosen], load, tree

    def _subtree_loads(self, order: list[str], parent: dict[str, tuple[str | None, str | None]]) -> dict[str, float]:
        load = {n: self.demand.get(n, 0.0) for n in order}
        for n in reversed(order):
            p = parent[n][0]
            if p is not None and p in load:
                load[p] += load[n]
        return load

    def _culprit(self, n: str, fn: frozenset[str], fe: frozenset[str]) -> str | None:
        for e, p in self.base_chain.get(n, []):
            if e and e in fe:
                return e
            if p in fn:
                return p
        return None

    def _culprit_text(self, cid: str, inp: PowerInputs) -> str:
        g = self.g
        if cid in g.edges:
            corr = dict(inp.common_cause).get(cid)
            kind = g.edges[cid].connection_type.replace("_", " ")
            if corr:
                return f"{kind} {g.label(cid)} failed (common-cause damage in corridor {g.label(corr)})"
            return f"{kind} {g.label(cid)} failed"
        if cid in inp.tripped:
            return f"{g.label(cid)} tripped on overload protection"
        return f"{g.label(cid)} failed"

    def _loss_text(self, n: str, inp: PowerInputs, fn: frozenset[str]) -> tuple[str, tuple[str, ...]]:
        g = self.g
        if n not in self.base_chain:
            return "not energised in the baseline network", ()
        cid = self._culprit(n, fn, inp.failed_edges)
        ds = self.baseline.ds_of.get(n)
        feeder = self.base_feeder.get(n)
        via = f"feeder {feeder} from {g.label(ds)}" if feeder and ds else (g.label(ds) if ds else "its transmission source")
        if cid is None:
            return f"supply via {via} lost (no closed path to an operating transmission source)", ()
        return f"supply via {via} lost because {self._culprit_text(cid, inp)}", (cid,)

    # ------------------------------------------------------------------ evaluate
    def evaluate(self, inp: PowerInputs) -> PowerResult:
        g = self.g
        fn = frozenset(n for n in inp.failed_nodes if n in self.node_set)
        fe = inp.failed_edges
        t = g.node_type

        parent: dict[str, tuple[str | None, str | None]] = {}
        root_of: dict[str, str] = {}
        ds_of: dict[str, str | None] = {}
        order: list[str] = []
        q: deque[str] = deque()
        for s in self.sources:
            if s in fn:
                continue
            parent[s] = (None, None)
            root_of[s] = s
            ds_of[s] = s if t[s] == "distribution_substation" else None
            q.append(s)
        while q:
            u = q.popleft()
            order.append(u)
            for v, e in self.adj[u]:
                if v in parent or v in fn or e in fe:
                    continue
                parent[v] = (u, e)
                root_of[v] = root_of[u]
                ds_of[v] = v if t[v] == "distribution_substation" else ds_of[u]
                q.append(v)
        energized0 = set(parent)
        deen0 = {n for n in self.nodes if n not in parent and n not in fn and n not in self.open_nodes}
        load0 = self._subtree_loads(order, parent)
        cur_load: dict[str, float] = {s: load0.get(s, 0.0) for s in self.substations}

        restored_order: list[str] = []
        actions: list[TieAction] = []
        used_units: set[int] = set()
        via_tie: dict[str, int] = {}
        island_note: dict[str, tuple[str, tuple[str, ...]]] = {}
        partial_note: dict[str, tuple[str, tuple[str, ...]]] = {}
        blocked_ties: dict[str, str] = {}
        scada = dict(inp.scada_down)

        def headroom(unit: TieUnit, sup: str) -> tuple[float, str]:
            limits: list[tuple[float, str]] = [(unit.capacity, f"tie capacity {fmt_num(unit.capacity)} MW")]
            ds = ds_of.get(sup)
            ts = root_of.get(sup)
            if ds is not None and self.cap.get(ds):
                limits.append((self.cap[ds] - cur_load[ds], f"spare capacity of {g.label(ds)}"))  # type: ignore[operator]
            if ts is not None and ts != ds and self.cap.get(ts):
                limits.append((self.cap[ts] - cur_load[ts], f"spare capacity of {g.label(ts)}"))  # type: ignore[operator]
            return min(limits, key=lambda x: x[0])

        if deen0 and inp.restoration:
            for _ in range(len(self.units) + 1):
                remaining = deen0 - set(restored_order)
                if not remaining:
                    break
                progress = False
                for comp in self._components(remaining, fe):
                    comp_set = set(comp)
                    comp_load = sum(self.demand.get(n, 0.0) for n in comp)
                    cands: list[tuple[float, str, int, str, str, str]] = []
                    for ui in sorted({ui for n in comp for ui in self.term_units.get(n, [])}):
                        if ui in used_units:
                            continue
                        unit = self.units[ui]
                        if any(s in fn for s in unit.switches) or any(e in fe for e in unit.edges):
                            continue
                        t_in = [x for x in unit.terminals if x in comp_set]
                        t_en = [x for x in unit.terminals if x in parent and x not in fn]
                        if not t_in or not t_en:
                            continue
                        best = max(((headroom(unit, s), s) for s in t_en), key=lambda x: (x[0][0], x[1]))
                        (h, why), sup = best
                        cands.append((h, why, ui, sup, t_in[0], unit.id))
                    cands.sort(key=lambda c: (-c[0], c[5]))
                    notes: list[str] = []
                    note_ids: list[str] = []
                    for h, why, ui, sup, entry, _uid in cands:
                        unit = self.units[ui]
                        lost_scada = tuple(sorted({p for s in unit.switches for p in scada.get(s, ())}))
                        mode = "automatic"
                        if lost_scada or not unit.automated:
                            if inp.horizon + EPS >= unit.manual_hours:
                                mode = "manual"
                            else:
                                if lost_scada:
                                    reason = (
                                        f"tie {g.label(unit.id)} could not be closed: its SCADA control via "
                                        f"{', '.join(g.label(p) for p in lost_scada)} is down and manual switching "
                                        f"takes {fmt_num(unit.manual_hours)} h (> {fmt_num(inp.horizon)} h horizon)"
                                    )
                                else:
                                    reason = (
                                        f"tie {g.label(unit.id)} is manually operated and needs "
                                        f"{fmt_num(unit.manual_hours)} h (> {fmt_num(inp.horizon)} h horizon)"
                                    )
                                blocked_ties[unit.id] = reason
                                notes.append(reason)
                                note_ids.extend([unit.id, *lost_scada])
                                continue
                        if h <= EPS:
                            notes.append(f"tie {g.label(unit.id)} is available but {why} is exhausted")
                            note_ids.append(unit.id)
                            continue
                        chosen, rload, tree = self._restore_subset(comp, entry, h, fe)
                        if not chosen or (rload <= EPS and comp_load > EPS):
                            notes.append(
                                f"tie {g.label(unit.id)} offers only {fmt_num(h)} MW ({why}), too little for any vault"
                            )
                            note_ids.append(unit.id)
                            continue
                        # apply
                        used_units.add(ui)
                        parent[entry] = (sup, None)
                        via_tie[entry] = ui
                        for n in chosen:
                            if n != entry:
                                parent[n] = tree[n]
                            root_of[n] = root_of[sup]
                            ds_of[n] = ds_of[sup]
                        restored_order.extend(chosen)
                        ds = ds_of[sup]
                        ts = root_of[sup]
                        if ds is not None:
                            cur_load[ds] = cur_load.get(ds, 0.0) + rload
                        if ts is not None and ts != ds:
                            cur_load[ts] = cur_load.get(ts, 0.0) + rload
                        left = tuple(sorted(comp_set - set(chosen)))
                        limit = "" if not left else why
                        actions.append(
                            TieAction(
                                unit=unit,
                                supplier=sup,
                                entry=entry,
                                ds=ds,
                                island_load=comp_load,
                                restored_load=rload,
                                headroom=h,
                                limit=limit,
                                mode=mode,
                                scada_providers=lost_scada,
                                restored_nodes=tuple(chosen),
                                left_nodes=left,
                            )
                        )
                        if left:
                            txt = (
                                f"tie {g.label(unit.id)} restored only {fmt_num(rload)} of {fmt_num(comp_load)} MW "
                                f"({why} limit); the rest of the section was sectionalised off because it did not fit "
                                f"within the remaining headroom"
                            )
                            for n in left:
                                partial_note[n] = (txt, (unit.id,))
                        progress = True
                        break
                    if not progress:
                        if not cands:
                            txt = "no normally-open tie can back-feed this section"
                        else:
                            txt = "; ".join(notes)
                        for n in comp:
                            island_note[n] = (txt, tuple(note_ids))
                    else:
                        break
                if not progress:
                    break

        restored = frozenset(restored_order)
        all_order = order + restored_order
        energized = frozenset(all_order)
        load = self._subtree_loads(all_order, parent)
        deen = frozenset(deen0 - restored)

        # loading (only substations that supply through their own transformer)
        loading: dict[str, float] = {}
        overloaded: dict[str, float] = {}
        trip: dict[str, float] = {}
        for s in self.substations:
            cap = self.cap.get(s)
            if s not in energized0 or not cap or cap <= 0:
                continue
            frac = load.get(s, 0.0) / cap
            loading[s] = frac
            if frac > 1.0 + 1e-6:
                overloaded[s] = frac
            if frac > EMERGENCY_LIMIT + 1e-9:
                trip[s] = frac

        # flows ------------------------------------------------------------
        flows: dict[str, FlowRec] = {}
        for n in all_order:
            p, e = parent[n]
            if p is None:
                continue
            if e is None:  # entered through a tie unit
                unit = self.units[via_tie[n]]
                f = load.get(n, 0.0)
                for ue in unit.edges:
                    ed = g.edges[ue]
                    if ed.source_node == p or ed.target_node == n:
                        d = 1
                    elif ed.target_node == p or ed.source_node == n:
                        d = -1
                    else:
                        d = 1 if ed.source_node in unit.switches and ed.target_node == n else -1
                    cap = self.edge_cap.get(ue)
                    flows[ue] = FlowRec(d if f > EPS else 0, round(f, 4), round(f / cap, 4) if cap else 0.0, "MW")
                continue
            ed = g.edges[e]
            f = load.get(n, 0.0)
            d = 1 if ed.source_node == p else -1
            cap = self.edge_cap.get(e)
            flows[e] = FlowRec(d if f > EPS else 0, round(f, 4), round(f / cap, 4) if cap else 0.0, "MW")
        for e in self.edges:
            if e not in flows:
                flows[e] = FlowRec(0, 0.0, 0.0, "MW")

        # edge states -------------------------------------------------------
        used_edges = {e for ui in used_units for e in self.units[ui].edges}
        edge_out: dict[str, EdgeOutcome] = {}
        for e in self.edges:
            if e in fe:
                continue  # orchestrator reports direct failures
            if e in self.unit_of_edge:
                if e in used_edges:
                    unit = self.units[self.unit_of_edge[e]]
                    edge_out[e] = EdgeOutcome("activated", f"Tie {g.label(unit.id)} closed to restore supply")
                else:
                    edge_out[e] = EdgeOutcome("normally_open", "Normally-open tie (idle)")
                continue
            ed = g.edges[e]
            u, v = ed.source_node, ed.target_node
            if u in fn or v in fn:
                bad = u if u in fn else v
                edge_out[e] = EdgeOutcome("interrupted", f"De-energised: connected element {g.label(bad)} failed")
            elif u not in energized or v not in energized:
                edge_out[e] = EdgeOutcome("interrupted", "De-energised section (no path to an operating source)")
            elif flows[e].utilization > 1.0 + 1e-6:
                edge_out[e] = EdgeOutcome(
                    "overloaded", f"Carries {fmt_num(flows[e].flow)} MW = {flows[e].utilization * 100:.0f}% of rating"
                )

        # node states -------------------------------------------------------
        node_out: dict[str, NodeOutcome] = {}
        for n in sorted(deen):
            loss, cb = self._loss_text(n, inp, fn)
            if not inp.restoration:
                extra, extra_ids = "automatic restoration is disabled for this scenario", ()
            elif n in partial_note:
                extra, extra_ids = partial_note[n]
            else:
                extra, extra_ids = island_note.get(n, ("no normally-open tie can back-feed this section", ()))
            node_out[n] = NodeOutcome(
                "de_energized",
                f"{g.label(n)} de-energised: {loss}; {extra}.",
                tuple(dict.fromkeys(cb + extra_ids)),
                0.0,
            )
        for act in actions:
            sup_ds = act.ds
            src_txt = g.label(sup_ds) if sup_ds else g.label(act.supplier)
            mode_txt = (
                "automatic switching"
                if act.mode == "automatic"
                else (
                    f"manual switching after {fmt_num(act.unit.manual_hours)} h"
                    + (
                        f" — SCADA via {', '.join(g.label(p) for p in act.scada_providers)} is down"
                        if act.scada_providers
                        else ""
                    )
                )
            )
            share = (
                f"{fmt_num(act.restored_load)} of {fmt_num(act.island_load)} MW restored"
                + (f" ({act.limit} limit)" if act.left_nodes else "")
            )
            for n in act.restored_nodes:
                loss, cb = self._loss_text(n, inp, fn)
                node_out[n] = NodeOutcome(
                    "restored",
                    f"{g.label(n)} restored: {loss}; re-energised through tie {g.label(act.unit.id)} "
                    f"({mode_txt}) from {src_txt} — {share}.",
                    tuple(dict.fromkeys(cb + (act.unit.id,))),
                    1.0,
                )
            for s in act.unit.switches:
                node_out[s] = NodeOutcome(
                    "restored",
                    f"Tie switch {g.label(s)} closed ({mode_txt}) to back-feed the isolated section from "
                    f"{src_txt}: {share}.",
                    (act.entry,),
                    1.0,
                )
        base_loading = self.baseline.loading if hasattr(self, "baseline") else {}
        for s, frac in sorted(overloaded.items()):
            cap = self.cap[s] or 0.0
            bl = base_loading.get(s)
            txt = (
                f"{g.label(s)} loaded to {frac * 100:.0f}% of its {fmt_num(cap)} MW rating "
                f"({fmt_num(load.get(s, 0.0))} MW"
                + (f"; baseline {bl * 100:.0f}%" if bl is not None else "")
                + ")"
                + (
                    " after load transfer from failed/tripped supply"
                    if bl is not None and frac > bl + 1e-6
                    else ""
                )
            )
            if s in trip:
                txt += f" — above the {EMERGENCY_LIMIT * 100:.0f}% emergency limit, protective trip follows."
            else:
                txt += f" — within the {EMERGENCY_LIMIT * 100:.0f}% emergency limit."
            node_out[s] = NodeOutcome("overloaded", txt, (), 1.0)

        served = sum(d for n, d in self.demand.items() if n in energized)
        initially_lost = 0.0
        recovered = 0.0
        if hasattr(self, "baseline"):
            for n, d in self.demand.items():
                if n in fn or n not in self.base_chain:
                    continue
                if self._culprit(n, fn, fe) is not None:
                    initially_lost += d
                    if n in energized:
                        recovered += d
        return PowerResult(
            energized=energized,
            restored=restored,
            deenergized=deen,
            parent=parent,
            ds_of=ds_of,
            root_of=root_of,
            load=load,
            loading=loading,
            overloaded=overloaded,
            trip=trip,
            node_out=node_out,
            edge_out=edge_out,
            flows=flows,
            actions=actions,
            served_load=served,
            total_load=self.total_load,
            initially_lost=initially_lost,
            recovered=recovered,
            restored_load=sum(a.restored_load for a in actions),
            blocked_ties=blocked_ties,
        )
