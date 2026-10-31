"""Cascade orchestrator: initiating failures → system models → dependency rounds.

Round structure
---------------
* **Round 0** – the initiating failure. Failing an underground corridor segment
  (``duct_bank`` / ``utility_tunnel``) or a ``utility_vault`` also fails every edge routed
  through it (*common-cause failure*).
* **Round r ≥ 1** – every system model (power, water, telecom, transport) is evaluated
  with the current failed sets and the *dependency conditions derived from round r-1*;
  facilities are evaluated from the same conditions. Each round therefore advances the
  cascade by exactly one dependency hop: round 1 holds the direct physical consequences
  (plus the immediate dependants of the failed elements themselves), round 2 the first
  cross-system propagation, and so on. Substations loaded above the 120 % emergency
  limit trip and are failed in the next round (true cascading).
* The loop stops when neither conditions nor trips change, or after
  ``scenario.max_cascade_rounds`` rounds (the result then says it was truncated).

Dependency rule
---------------
For every consumer and every dependency type (``power_supply``, ``water_supply``,
``telecom_link``, ``control_link``, ``road_access``) the providers' service is checked:
power – provider energised (or restored); water – provider zone service ≥ 50 %;
telecom/control – provider connected and in service; road – provider reachable (for
facilities: the O-D access status). If *all* providers lost service the consumer loses
the resource unless its backup (``backup_power_hours``/``backup_hours`` for power,
``water_storage_hours`` for water) covers the horizon (→ ``on_backup``). Losing only some
providers is reported as lost redundancy. Conditions are monotone (a resource lost in
round r is not regained in later rounds), which guarantees termination.

System models are memoised on their (system-filtered) inputs, so unchanged systems are
not recomputed across rounds and across the N-1 criticality sweep.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.models.schemas import ScenarioInput
from app.simulation.common import (
    LOSS_STATES,
    EdgeOutcome,
    NodeOutcome,
    fmt_num,
    join_names,
    worse_node,
)
from app.simulation.graph import NetworkGraphs
from app.simulation.power import PowerInputs, PowerModel, PowerResult
from app.simulation.telecom import TelecomInputs, TelecomModel, TelecomResult
from app.simulation.transport import TransportInputs, TransportModel, TransportResult
from app.simulation.water import OPERATIONAL_LEVEL, OUTAGE_LEVEL, WaterInputs, WaterModel, WaterResult

RESOURCE_NAME = {
    "power_supply": "power",
    "water_supply": "water supply",
    "telecom_link": "telecom service",
    "control_link": "SCADA/remote-control link",
    "road_access": "road access",
}
COND_RANK = {"ok": 0, "redundancy_lost": 1, "degraded": 2, "backup": 3, "lost": 4}
FACILITY_PRECEDENCE = {"failed": 6, "outage": 5, "inaccessible": 4, "on_backup": 3, "degraded": 2, "delayed": 1}
MEMO_LIMIT = 4096


@dataclass(frozen=True)
class Condition:
    """Dependency status of one consumer for one connection type."""

    ctype: str
    status: str  # redundancy_lost | degraded | backup | lost
    lost: tuple[str, ...]
    ok: tuple[str, ...]
    backup_hours: float
    text: str


@dataclass
class RoundView:
    nodes: dict[str, NodeOutcome]
    edges: dict[str, EdgeOutcome]
    power: PowerResult | None = None
    water: WaterResult | None = None
    telecom: TelecomResult | None = None
    transport: TransportResult | None = None

    def state(self, nid: str) -> str:
        o = self.nodes.get(nid)
        return o.state if o is not None else "operational"


@dataclass
class RoundRecord:
    round: int
    nodes: dict[str, tuple[str, str, bool]]  # id -> (old state, new state, info)
    edges: dict[str, tuple[str, str]]
    conditions: list[tuple[str, Condition]]  # (consumer, condition) applied in this round
    trips: list[tuple[str, float]]


@dataclass
class CascadeOutcome:
    scenario: ScenarioInput
    direct_nodes: list[str]
    direct_edges: list[str]
    failed_nodes: set[str]
    failed_edges: set[str]
    common_cause: dict[str, str]
    tripped: dict[str, tuple[int, float]]
    view: RoundView
    first_round: dict[str, int]
    edge_first_round: dict[str, int]
    rounds: list[RoundRecord]
    conditions: dict[tuple[str, str], Condition]
    truncated: bool
    extras: dict[str, Any] = field(default_factory=dict)


class CascadeEngine:
    """Owns the system models and runs scenarios (no Pydantic conversion here)."""

    def __init__(self, g: NetworkGraphs) -> None:
        self.g = g
        self.power = PowerModel(g)
        self.water = WaterModel(g)
        self.telecom = TelecomModel(g)
        self.transport = TransportModel(g)
        self._memo: dict[str, dict[Any, Any]] = {"power": {}, "water": {}, "telecom": {}, "transport": {}}
        self.sys_nodes = {s: frozenset(ids) for s, ids in g.nodes_by_system.items()}
        self.sys_edges = {s: frozenset(ids) for s, ids in g.physical_edges_by_system.items()}
        self.facilities = list(g.nodes_by_system.get("facility", []))
        self.signalized = self.transport.signalized
        self.baseline: CascadeOutcome | None = None
        self.baseline = self.run(ScenarioInput(name="Baseline"))

    # ------------------------------------------------------------------ memo
    def _memo_eval(self, system: str, inputs: Any) -> Any:
        cache = self._memo[system]
        hit = cache.get(inputs)
        if hit is not None:
            return hit
        model = getattr(self, system)
        res = model.evaluate(inputs)
        if len(cache) >= MEMO_LIMIT:
            cache.clear()
        cache[inputs] = res
        return res

    # ------------------------------------------------------------------ run
    def expand_common_cause(self, nodes: list[str], edges: list[str]) -> dict[str, str]:
        """Hosted edges failed by a corridor segment / utility vault: edge -> corridor/vault."""
        g = self.g
        cc: dict[str, str] = {}
        for x in sorted(nodes) + sorted(edges):
            hosted = g.corridor_hosted.get(x) or g.vault_hosted.get(x) or []
            for h in hosted:
                if h not in edges and h not in cc:
                    cc[h] = x
        return cc

    def run(self, sc: ScenarioInput) -> CascadeOutcome:
        g = self.g
        direct_n = sorted(set(sc.failed_nodes))
        direct_e = sorted(set(sc.failed_edges))
        cc = self.expand_common_cause(direct_n, direct_e)
        failed_n: set[str] = set(direct_n)
        failed_e: set[str] = set(direct_e) | set(cc)
        tripped: dict[str, tuple[int, float]] = {}
        trip_text: dict[str, str] = {}

        fail_out = {n: self._failed_outcome(n, sc, tripped, trip_text) for n in failed_n}
        edges0 = {e: self._failed_edge(e, cc, tripped, trip_text) for e in failed_e}
        view = RoundView(dict(fail_out), dict(edges0))
        conds: dict[tuple[str, str], Condition] = {}
        new_conds = self._derive(view, failed_e, sc.horizon_hours)
        applied = [(c, cnd) for (c, _ct), cnd in sorted(new_conds.items())]
        conds = dict(new_conds)

        first_round: dict[str, int] = {n: 0 for n in failed_n}
        edge_first: dict[str, int] = {e: 0 for e in failed_e}
        prev_nodes: dict[str, tuple[str, bool]] = {n: (o.state, o.info) for n, o in view.nodes.items()}
        prev_edges: dict[str, str] = {e: o.state for e, o in view.edges.items()}
        rounds: list[RoundRecord] = [
            RoundRecord(
                0,
                {n: ("operational", "failed", False) for n in sorted(failed_n)},
                {e: ("operational", "failed") for e in sorted(failed_e)},
                [],
                [],
            )
        ]
        applied_trips: list[tuple[str, float]] = []
        truncated = False
        for r in range(1, sc.max_cascade_rounds + 1):
            view = self._evaluate(failed_n, failed_e, cc, tripped, trip_text, conds, sc)
            cur_nodes = {n: (o.state, o.info) for n, o in view.nodes.items()}
            cur_edges = {e: o.state for e, o in view.edges.items()}
            ch_nodes: dict[str, tuple[str, str, bool]] = {}
            for n in sorted(set(cur_nodes) | set(prev_nodes)):
                old = prev_nodes.get(n, ("operational", False))
                new = cur_nodes.get(n, ("operational", False))
                if old != new:
                    ch_nodes[n] = (old[0], new[0], new[1])
                    if n not in first_round and (new[0] != "operational" or new[1]):
                        first_round[n] = r
            ch_edges: dict[str, tuple[str, str]] = {}
            for e in sorted(set(cur_edges) | set(prev_edges)):
                old_e = prev_edges.get(e, "operational")
                new_e = cur_edges.get(e, "operational")
                if old_e != new_e:
                    ch_edges[e] = (old_e, new_e)
                    if e not in edge_first and new_e not in ("operational", "normally_open"):
                        edge_first[e] = r
            rounds.append(RoundRecord(r, ch_nodes, ch_edges, applied, applied_trips))
            prev_nodes, prev_edges = cur_nodes, cur_edges

            # next round inputs
            new_trips = sorted(
                [(s, frac) for s, frac in (view.power.trip.items() if view.power else []) if s not in failed_n]
                + [(e, frac) for e, frac in (view.power.trip_edges.items() if view.power else []) if e not in failed_e]
            )
            derived = self._derive(view, failed_e, sc.horizon_hours)
            merged = dict(conds)
            changed: list[tuple[str, Condition]] = []
            for key, cnd in sorted(derived.items()):
                old_c = merged.get(key)
                if (
                    old_c is None
                    or COND_RANK[cnd.status] > COND_RANK[old_c.status]
                    or (COND_RANK[cnd.status] == COND_RANK[old_c.status] and set(cnd.lost) > set(old_c.lost))
                ):
                    merged[key] = cnd
                    changed.append((key[0], cnd))
            if not new_trips and not changed:
                break
            if r == sc.max_cascade_rounds:
                truncated = True
                break
            for s, frac in new_trips:
                tripped[s] = (r, frac)
                if s in g.nodes:
                    cause = view.power.node_out.get(s) if view.power else None
                    trip_text[s] = cause.cause if cause else ""
                    failed_n.add(s)
                else:
                    ecause = view.power.edge_out.get(s) if view.power else None
                    trip_text[s] = ecause.reason if ecause else ""
                    failed_e.add(s)
            conds = merged
            applied = changed
            applied_trips = new_trips

        return CascadeOutcome(
            scenario=sc,
            direct_nodes=direct_n,
            direct_edges=direct_e,
            failed_nodes=failed_n,
            failed_edges=failed_e,
            common_cause=cc,
            tripped=tripped,
            view=view,
            first_round=first_round,
            edge_first_round=edge_first,
            rounds=rounds,
            conditions=conds,
            truncated=truncated,
        )

    # ------------------------------------------------------------- evaluation
    def _failed_outcome(
        self, n: str, sc: ScenarioInput, tripped: dict[str, tuple[int, float]], trip_text: dict[str, str]
    ) -> NodeOutcome:
        g = self.g
        if n in tripped:
            r, frac = tripped[n]
            cap = g.nodes[n].capacity
            detail = trip_text.get(n) or ""
            return NodeOutcome(
                "failed",
                f"{g.label(n)} tripped: overload protection opened at {frac * 100:.0f}% of its "
                f"{fmt_num(cap or 0)} MW rating (emergency limit 120%). {detail}".strip(),
                (),
                0.0,
            )
        txt = f"{g.label(n)} failed: initiating failure ({sc.name or 'scenario input'})."
        hosted = g.vault_hosted.get(n)
        if hosted:
            systems = sorted({g.edge_sys[h] for h in hosted})
            txt += f" Common-cause: {len(hosted)} edges routed through it fail ({', '.join(systems)})."
        return NodeOutcome("failed", txt, (), 0.0)

    def _failed_edge(
        self,
        e: str,
        cc: dict[str, str],
        tripped: dict[str, tuple[int, float]] | None = None,
        trip_text: dict[str, str] | None = None,
    ) -> EdgeOutcome:
        g = self.g
        if tripped and e in tripped:
            _r, frac = tripped[e]
            cap = g.edges[e].capacity
            return EdgeOutcome(
                "failed",
                f"Tripped: overload protection opened at {frac * 100:.0f}% of its {fmt_num(cap or 0)} MW rating "
                f"(emergency limit 120%)",
            )
        if e in cc:
            src = cc[e]
            if src in g.edges:
                return EdgeOutcome("failed", f"Common-cause failure: hosted in corridor {g.label(src)}, which failed")
            return EdgeOutcome(
                "failed", f"Common-cause failure: routed through utility vault {g.label(src)}, which failed"
            )
        hosted = g.corridor_hosted.get(e)
        if hosted:
            systems = sorted({g.edge_sys[h] for h in hosted})
            return EdgeOutcome(
                "failed",
                f"Initiating failure (scenario input); common-cause damage to {len(hosted)} hosted edges "
                f"({', '.join(systems)})",
            )
        return EdgeOutcome("failed", "Initiating failure (scenario input)")

    def _evaluate(
        self,
        failed_n: set[str],
        failed_e: set[str],
        cc: dict[str, str],
        tripped: dict[str, tuple[int, float]],
        trip_text: dict[str, str],
        conds: dict[tuple[str, str], Condition],
        sc: ScenarioInput,
    ) -> RoundView:
        g = self.g
        fn = frozenset(failed_n)
        fe = frozenset(failed_e)
        sn, se = self.sys_nodes, self.sys_edges

        def part(system: str) -> tuple[frozenset[str], frozenset[str], frozenset[tuple[str, str]]]:
            nodes = fn & sn.get(system, frozenset())
            edges = fe & se.get(system, frozenset())
            return nodes, edges, frozenset((e, c) for e, c in cc.items() if e in edges)

        lost_power: dict[str, Condition] = {}
        backup_power: set[str] = set()
        scada: list[tuple[str, tuple[str, ...]]] = []
        for (c, ct), cnd in conds.items():
            if ct == "power_supply":
                if cnd.status == "lost":
                    lost_power[c] = cnd
                elif cnd.status == "backup":
                    backup_power.add(c)
            elif ct == "control_link" and cnd.status == "lost" and g.node_sys.get(c) == "power":
                scada.append((c, cnd.lost))

        pn, pe, pcc = part("power")
        power = self._memo_eval(
            "power",
            PowerInputs(
                pn,
                pe,
                frozenset(tripped) & (pn | pe),
                pcc,
                frozenset(scada),
                sc.enable_restoration,
                float(sc.horizon_hours),
            ),
        )
        wn, we, wcc = part("water")
        pumps = sn.get("water", frozenset())
        water = self._memo_eval(
            "water",
            WaterInputs(
                wn,
                we,
                frozenset(c for c in lost_power if c in pumps and g.node_type[c] == "pump_station"),
                frozenset(c for c in backup_power if c in pumps and g.node_type[c] == "pump_station"),
                wcc,
                float(sc.horizon_hours),
            ),
        )
        tn, te, tcc = part("telecom")
        tel_nodes = sn.get("telecom", frozenset())
        telecom = self._memo_eval(
            "telecom",
            TelecomInputs(
                tn,
                te,
                frozenset(c for c in lost_power if c in tel_nodes),
                frozenset(c for c in backup_power if c in tel_nodes),
                tcc,
                sc.enable_restoration,
            ),
        )
        rn, re_, rcc = part("transport")
        stations = set(self.transport.stations)
        transport = self._memo_eval(
            "transport",
            TransportInputs(
                rn,
                re_,
                frozenset(c for c in lost_power if c in self.signalized),
                frozenset(c for c in backup_power if c in self.signalized),
                frozenset(c for c in lost_power if c in stations),
                frozenset(c for c in backup_power if c in stations),
                rcc,
                sc.enable_restoration,
            ),
        )

        nodes: dict[str, NodeOutcome] = {n: self._failed_outcome(n, sc, tripped, trip_text) for n in failed_n}
        for res in (power, water, telecom, transport):
            for n, o in res.node_out.items():
                if n in fn:
                    continue
                if o.dep:
                    cnd = conds.get((n, o.dep))
                    if cnd is not None:
                        o = NodeOutcome(
                            o.state,
                            f"{g.label(n)}: {cnd.text} {o.cause}",
                            tuple(dict.fromkeys(cnd.lost + o.caused_by)),
                            o.service_level,
                            o.info,
                            o.dep,
                        )
                nodes[n] = worse_node(nodes.get(n), o)  # type: ignore[assignment]
        for (c, ct), cnd in sorted(conds.items()):
            if c in fn:
                continue
            o = self._generic_dep(c, ct, cnd)
            if o is not None:
                nodes[c] = worse_node(nodes.get(c), o)  # type: ignore[assignment]
        for f in self.facilities:
            if f in fn:
                continue
            o = self._facility(f, conds, transport)
            if o is not None:
                nodes[f] = o

        edges: dict[str, EdgeOutcome] = {e: self._failed_edge(e, cc, tripped, trip_text) for e in failed_e}
        for res in (power, water, telecom, transport):
            for e, o in res.edge_out.items():
                if e not in fe:
                    edges[e] = o
        for c in g.corridor_edges:
            if c in fe:
                continue
            ed = g.edges[c]
            bad = [x for x in (ed.source_node, ed.target_node) if x in fn]
            if bad:
                edges[c] = EdgeOutcome(
                    "interrupted", f"Corridor segment unusable: utility vault {g.label(bad[0])} failed"
                )
        view = RoundView(nodes, edges, power, water, telecom, transport)
        for eid in g.dependency_edge_ids:
            if eid in fe:
                continue
            link = g.dep_links[eid]
            st, phrase = self._provider_status(link.provider, link.ctype, view)
            if st == "lost":
                edges[eid] = EdgeOutcome(
                    "interrupted",
                    f"{RESOURCE_NAME.get(link.ctype, link.ctype).capitalize()} not delivered: provider "
                    f"{g.label(link.provider)} {phrase}",
                )
        return view

    # ------------------------------------------------------------- dependencies
    def _provider_status(self, p: str, ct: str, view: RoundView) -> tuple[str, str]:
        """(status, phrase) of provider ``p`` for connection type ``ct``: ok | degraded | lost."""
        g = self.g
        st = view.state(p)
        if st == "failed":
            return "lost", "failed"
        psys = g.node_sys.get(p)
        if ct == "power_supply":
            if psys == "power" and view.power is not None:
                if p in view.power.deenergized:
                    return "lost", "de-energised"
                return "ok", st
            return ("lost", st.replace("_", "-")) if st in LOSS_STATES else ("ok", st)
        if ct == "water_supply":
            if psys == "water" and view.water is not None:
                lvl = view.water.node_level.get(p, 1.0)
                if lvl < OUTAGE_LEVEL:
                    return "lost", f"{st.replace('_', '-')}, {lvl * 100:.0f}% of demand served"
                if lvl < OPERATIONAL_LEVEL:
                    return "degraded", f"low pressure, {lvl * 100:.0f}% of demand served"
                return "ok", st
            return ("lost", st) if st in LOSS_STATES else ("ok", st)
        if ct in ("telecom_link", "control_link"):
            if st in LOSS_STATES:
                return "lost", st.replace("_", "-")
            if st == "degraded" and psys == "telecom":
                return "degraded", "congested"
            return "ok", st
        if ct == "road_access":
            if st in ("inaccessible", "closed", "isolated"):
                return "lost", st
            if st in ("degraded", "delayed"):
                return "degraded", "dark signal" if st == "degraded" else "delayed"
            return "ok", st
        return ("lost", st) if st in LOSS_STATES else ("ok", st)

    def _derive(self, view: RoundView, failed_e: set[str], horizon: float) -> dict[tuple[str, str], Condition]:
        g = self.g
        out: dict[tuple[str, str], Condition] = {}
        for c in sorted(g.providers):
            groups: dict[str, list[Any]] = {}
            for link in g.providers[c]:
                groups.setdefault(link.ctype, []).append(link)
            for ct, links in sorted(groups.items()):
                lost: list[tuple[str, str]] = []
                deg: list[tuple[str, str]] = []
                ok: list[str] = []
                for link in sorted(links):
                    if link.edge_id in failed_e:
                        lost.append((link.provider, f"link {link.edge_id} cut"))
                        continue
                    stt, phrase = self._provider_status(link.provider, ct, view)
                    if stt == "lost":
                        lost.append((link.provider, phrase))
                    elif stt == "degraded":
                        deg.append((link.provider, phrase))
                    else:
                        ok.append(link.provider)
                if ct == "road_access" and g.node_sys.get(c) == "facility" and view.transport is not None:
                    acc = view.transport.access.get(c)
                    if acc is not None:
                        if acc.status == "inaccessible" and not lost:
                            lost = [(p, "unreachable") for p in ok] or lost
                            ok = []
                        elif acc.status == "delayed" and not lost and not deg:
                            deg = [(p, "delayed") for p in ok]
                if not lost and not deg:
                    continue
                res = RESOURCE_NAME.get(ct, ct)
                lost_txt = join_names([f"{g.label(p)} ({ph})" for p, ph in lost], 3)
                bh = 0.0
                if ct == "power_supply":
                    bh = g.power_backup_hours(c)
                elif ct == "water_supply":
                    bh = g.water_backup_hours(c)
                if lost and not ok and not deg:
                    if bh > 0 and bh + 1e-9 >= horizon:
                        status = "backup"
                        text = (
                            f"Lost {res} from {lost_txt}; running on backup "
                            f"({fmt_num(bh)} h ≥ {fmt_num(horizon)} h horizon)."
                        )
                    else:
                        status = "lost"
                        if ct in ("power_supply", "water_supply"):
                            bk = (
                                f"backup of {fmt_num(bh)} h does not cover the {fmt_num(horizon)} h horizon"
                                if bh > 0
                                else "no backup"
                            )
                            text = f"Lost {res} from {lost_txt}; {bk}."
                        else:
                            text = f"Lost {res} from {lost_txt}."
                elif lost and ok:
                    status = "redundancy_lost"
                    text = (
                        f"Lost redundant {res} feed from {lost_txt}; still supplied by "
                        f"{join_names([g.label(p) for p in ok], 3)}."
                    )
                else:
                    status = "degraded"
                    parts = [f"{g.label(p)} ({ph})" for p, ph in deg + lost]
                    text = f"{res.capitalize()} degraded: {join_names(parts, 3)}."
                out[(c, ct)] = Condition(
                    ct, status, tuple(p for p, _ in lost) + tuple(p for p, _ in deg), tuple(ok), bh, text
                )
        return out

    def _generic_dep(self, c: str, ct: str, cnd: Condition) -> NodeOutcome | None:
        """State of consumers whose dependency effect is not modelled by a system model."""
        g = self.g
        sys_ = g.node_sys.get(c)
        ty = g.node_type.get(c)
        if sys_ == "facility":
            return None
        if ct == "power_supply" and (
            (sys_ == "water" and ty == "pump_station")
            or sys_ == "telecom"
            or (sys_ == "transport" and (c in self.signalized or ty == "transit_station"))
        ):
            return None
        if ct == "road_access" and sys_ == "transport":
            return None
        if cnd.status == "backup" and ct in ("power_supply", "water_supply"):
            return NodeOutcome("on_backup", f"{g.label(c)}: {cnd.text}", cnd.lost, 1.0)
        if cnd.status != "lost":
            return None
        effect = {
            "power_supply": "auxiliary systems (telemetry, motorised valves, ventilation) without power",
            "water_supply": "process/cooling water lost",
            "telecom_link": "communications lost",
            "control_link": "remote control lost — local/manual operation only",
            "road_access": "crew access by road cut",
        }.get(ct, "dependency lost")
        return NodeOutcome("degraded", f"{g.label(c)}: {cnd.text} Effect: {effect}.", cnd.lost, 0.75)

    def _facility(self, f: str, conds: dict[tuple[str, str], Condition], tr: TransportResult) -> NodeOutcome | None:
        g = self.g
        cands: list[tuple[str, float, str, tuple[str, ...]]] = []
        for ct in ("power_supply", "water_supply", "telecom_link", "control_link"):
            cnd = conds.get((f, ct))
            if cnd is None:
                continue
            if cnd.status == "lost":
                st = "outage" if ct in ("power_supply", "water_supply") else "degraded"
                lvl = 0.0 if st == "outage" else 0.75
            elif cnd.status == "backup":
                st, lvl = "on_backup", 1.0
            elif cnd.status == "degraded":
                st, lvl = "degraded", 0.75
            else:  # redundancy lost, service maintained
                st, lvl = "degraded", 1.0
            cands.append((st, lvl, cnd.text, cnd.lost))
        acc = tr.access.get(f)
        if acc is not None and acc.status == "detour":
            if not cands:  # informational only: service intact, traffic rerouted
                return NodeOutcome("operational", f"{g.label(f)}: {acc.cause}", acc.caused_by, 1.0, info=True)
        elif acc is not None and acc.status != "ok":
            if acc.status == "inaccessible":
                cands.append(("inaccessible", 0.0, acc.cause, acc.caused_by))
            else:
                lvl = round(max(0.0, min(1.0, 1.0 / (1.0 + max(acc.increase, 0.0)))), 4)
                cands.append(("delayed", lvl, acc.cause, acc.caused_by))
        elif acc is None:
            cnd = conds.get((f, "road_access"))
            if cnd is not None and cnd.status == "lost":
                cands.append(("inaccessible", 0.0, cnd.text, cnd.lost))
        if not cands:
            return None
        cands.sort(key=lambda x: -FACILITY_PRECEDENCE[x[0]])
        state = cands[0][0]
        crit = " (critical facility)" if g.nodes[f].critical else ""
        texts = list(dict.fromkeys(c[2] for c in cands))
        return NodeOutcome(
            state,
            f"{g.label(f)}{crit}: " + " ".join(texts),
            tuple(dict.fromkeys(x for c in cands for x in c[3])),
            min(c[1] for c in cands),
        )

    # ---------------------------------------------------------------- helpers
    def affected(self, outcome: CascadeOutcome) -> dict[str, NodeOutcome]:
        """Nodes whose state differs from the baseline (plus direct failures and info entries)."""
        base = self.baseline.view.nodes if self.baseline is not None else {}
        out: dict[str, NodeOutcome] = {}
        for n, o in outcome.view.nodes.items():
            if o.state == "operational" and not o.info:
                continue
            b = base.get(n)
            if b is not None and b.state == o.state and b.info == o.info and n not in outcome.failed_nodes:
                continue
            out[n] = o
        return out


__all__ = ["CascadeEngine", "CascadeOutcome", "Condition", "RoundRecord", "RoundView"]
