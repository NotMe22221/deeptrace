"""Turn a :class:`CascadeOutcome` into the contract's ``SimulationResult``.

Severity index (0–100, transparent composite)
--------------------------------------------
::

    severity_index = 100 × ( 0.20·√x_power + 0.15·√x_water + 0.15·√x_telecom
                           + 0.15·√x_transport + 0.25·√x_facilities + 0.10·√x_population )

with every share clipped to [0, 1]:

* ``x_power``      = unserved MW / baseline served MW
* ``x_water``      = unserved L/s / baseline served L/s
* ``x_telecom``    = (endpoints without service + 0.3 × congested endpoints) / endpoints
* ``x_transport``  = min(1, Δ O-D travel time % / 100 + share of O-D pairs unreachable
  + 0.5 × share of transit stations closed)
* ``x_facilities`` = Σ impact / number of critical facilities, impact = 1 for
  outage / failed / inaccessible, 0.5 degraded (0.25 when service is intact and only a
  redundant feed was lost), 0.25 on backup or delayed
* ``x_population`` = population affected / modelled population

The square root makes the index sensitive to the first losses (a 10 % power loss
contributes 0.2·√0.1 ≈ 6.3 points) while staying bounded; the weights sum to 1.

Population affected = max(residents of de-energised vaults, of water zones in
outage/low pressure, of disconnected telecom endpoints) + occupants of facilities in
outage / inaccessible. The maximum (not the sum) avoids double-counting residents who
lose several services.

Redundancy score = Σ_s recovered_s / Σ_s initially-lost_s, each normalised by the
system's baseline (power MW, water L/s, telecom endpoints, transport O-D pairs), where
"initially lost" is demand whose baseline supply path/route was broken and
"recovered" is the part still served at the horizon thanks to meshing, tie switching,
rerouting, storage or detours. 1.0 when nothing was cut.
"""

from __future__ import annotations

import math
from collections import Counter

from app.models.schemas import (
    AffectedNode,
    AlternativePath,
    CascadeStep,
    EdgeFlow,
    ImpactMetrics,
    InterruptedEdge,
    SimulationResult,
    SystemImpact,
)
from app.simulation.cascade import COND_RANK, RESOURCE_NAME, CascadeEngine, CascadeOutcome, RoundRecord
from app.simulation.common import EPS, LOSS_STATES, MAJOR_STATES, STATE_RANK, NodeOutcome, fmt_num, join_names, plural
from app.simulation.graph import SYSTEMS
from app.simulation.power import EMERGENCY_LIMIT
from app.simulation.transport import SIGNAL_DELAY_S

SEVERITY_WEIGHTS = {
    "power": 0.20,
    "water": 0.15,
    "telecom": 0.15,
    "transport": 0.15,
    "facilities": 0.25,
    "population": 0.10,
}
SEVERITY_FORMULA = (
    "Severity index = 100 × (0.20·√x_power + 0.15·√x_water + 0.15·√x_telecom + 0.15·√x_transport + "
    "0.25·√x_facilities + 0.10·√x_population); x_power = unserved MW / baseline MW; x_water = unserved L/s / "
    "baseline L/s; x_telecom = (endpoints without service + 0.3 × congested) / endpoints; x_transport = "
    "min(1, Δ O-D travel time %/100 + share of O-D pairs unreachable + 0.5 × share of stations closed); "
    "x_facilities = Σ impact / critical facilities (outage/inaccessible 1, degraded 0.5 — 0.25 if only a redundant "
    "feed was lost — on backup/delayed 0.25); "
    "x_population = affected / modelled population; every x clipped to [0, 1]."
)
CORE_TYPES = frozenset({"internet_exchange", "data_center", "transmission_substation", "supply_source"})
SEVERITY_ORDER = {"critical": 0, "major": 1, "minor": 2, "info": 3}
FACILITY_IMPACT = {
    "outage": 1.0,
    "failed": 1.0,
    "inaccessible": 1.0,
    "degraded": 0.5,
    "on_backup": 0.25,
    "delayed": 0.25,
}
REDUNDANCY_ONLY_IMPACT = 0.25  # degraded facility whose service is intact (a redundant feed was lost)
STATE_WORD = {
    "de_energized": "de-energised",
    "restored": "restored",
    "overloaded": "overloaded",
    "failed": "failed",
    "outage": "in outage",
    "isolated": "isolated",
    "disconnected": "disconnected",
    "on_backup": "on backup",
    "degraded": "degraded",
    "delayed": "delayed",
    "inaccessible": "inaccessible",
    "closed": "closed",
    "rerouted": "rerouted",
    "interrupted": "interrupted",
    "activated": "activated",
}
EDGE_RANK_FOR_LABEL = {"isolated": 4, "interrupted": 4, "overloaded": 3, "rerouted": 2, "activated": 1}
SYSTEM_TITLE = {
    "power": "Power",
    "water": "Water",
    "telecom": "Telecom",
    "transport": "Transport",
    "underground": "Underground",
    "facility": "Facilities",
}


def node_severity(ce: CascadeEngine, nid: str, o: NodeOutcome) -> str:
    g = ce.g
    if o.info or o.state in ("operational", "restored"):
        return "info"
    if o.state in ("outage", "failed", "inaccessible") and g.is_critical_facility(nid):
        return "critical"
    if o.state in ("failed", "outage") and (g.node_type.get(nid) in CORE_TYPES or g.nodes[nid].critical):
        return "critical"
    if o.state in MAJOR_STATES:
        return "major"
    return "minor"


class Report:
    """Computes metrics (cheap, used by the N-1 sweep too) and the full result."""

    def __init__(self, ce: CascadeEngine) -> None:
        self.ce = ce
        g = ce.g
        self.critical_facilities = [f for f in g.nodes_by_system.get("facility", []) if g.nodes[f].critical]
        self.endpoints = set(ce.telecom.endpoints)
        pw = sum(g.population(n) for n in ce.power.demand)
        wt = sum(g.population(z) for z in ce.water.zones)
        tc = sum(g.population(n) for n in ce.telecom.endpoints)
        fac = sum(g.population(f) for f in g.nodes_by_system.get("facility", []))
        self.population_total = max(pw, wt, tc) + fac

    # ---------------------------------------------------------------- metrics
    def population(self, affected: dict[str, NodeOutcome]) -> tuple[int, dict[str, float]]:
        g = self.ce.g
        parts = {"power": 0.0, "water": 0.0, "telecom": 0.0, "facility": 0.0}
        for n, o in affected.items():
            s = g.node_sys[n]
            if s == "power" and o.state in ("de_energized", "failed"):
                parts["power"] += g.population(n)
            elif (
                s == "water"
                and g.node_type[n] == "service_zone"
                and o.state in ("outage", "degraded", "isolated", "failed")
            ):
                parts["water"] += g.population(n)
            elif s == "telecom" and n in self.endpoints and o.state in ("disconnected", "outage", "failed", "degraded"):
                parts["telecom"] += g.population(n)
            elif s == "facility" and o.state in ("outage", "inaccessible", "failed"):
                parts["facility"] += g.population(n)
        est = max(parts["power"], parts["water"], parts["telecom"]) + parts["facility"]
        return int(round(est)), parts

    def impact(self, oc: CascadeOutcome, affected: dict[str, NodeOutcome] | None = None) -> ImpactMetrics:
        ce, g = self.ce, self.ce.g
        if affected is None:
            affected = ce.affected(oc)
        base = ce.baseline.view if ce.baseline is not None else oc.view
        v = oc.view
        sev = {n: node_severity(ce, n, o) for n, o in affected.items()}
        real = {n: o for n, o in affected.items() if sev[n] != "info"}

        p, bp = v.power, base.power
        w, bw = v.water, base.water
        t, bt = v.telecom, base.telecom
        tr = v.transport
        assert p and bp and w and bw and t and bt and tr
        p_base, w_base = bp.served_load, bw.served_total
        mw_unserved = max(0.0, p_base - p.served_load)
        lps_unserved = max(0.0, w_base - w.served_total)
        tel_lost = [
            n for n, o in real.items() if g.node_sys[n] == "telecom" and o.state in ("disconnected", "outage", "failed")
        ]
        stations_closed = [
            n for n, o in real.items() if g.node_type[n] == "transit_station" and o.state in ("closed", "failed")
        ]
        crit = sorted(n for n in real if g.is_critical_facility(n))
        pop, _ = self.population(real)

        # redundancy
        lost_share = rec_share = 0.0
        for lost, rec, total in (
            (p.initially_lost, p.recovered, p_base),
            (w.initially_lost, w.recovered, w_base),
            (t.initially_lost, t.recovered, float(bt.endpoints_total)),
            (tr.initially_lost, tr.recovered, float(tr.od_pairs_total)),
        ):
            if total > EPS and lost > EPS:
                lost_share += lost / total
                rec_share += rec / total
        redundancy = 1.0 if lost_share <= EPS else max(0.0, min(1.0, rec_share / lost_share))

        # severity
        def share(a: float, b: float) -> float:
            return max(0.0, min(1.0, a / b)) if b > EPS else 0.0

        ep_lost = sum(1 for n in tel_lost if n in self.endpoints)
        ep_cong = sum(1 for n, o in real.items() if n in self.endpoints and o.state == "degraded")
        n_stations = len(ce.transport.stations)
        x = {
            "power": share(mw_unserved, p_base),
            "water": share(lps_unserved, w_base),
            "telecom": share(ep_lost + 0.3 * ep_cong, float(len(self.endpoints))),
            "transport": max(
                0.0,
                min(
                    1.0,
                    max(0.0, tr.travel_time_increase_pct) / 100.0
                    + share(tr.od_pairs_unreachable, float(tr.od_pairs_total))
                    + 0.5 * share(len(stations_closed), float(n_stations)),
                ),
            ),
            "facilities": share(
                sum(
                    REDUNDANCY_ONLY_IMPACT
                    if real[f].state == "degraded" and real[f].service_level >= 1.0 - EPS
                    else FACILITY_IMPACT.get(real[f].state, 0.0)
                    for f in crit
                ),
                float(len(self.critical_facilities)),
            ),
            "population": share(pop, self.population_total),
        }
        severity = 100.0 * sum(SEVERITY_WEIGHTS[k] * math.sqrt(x[k]) for k in SEVERITY_WEIGHTS)
        severity = round(max(0.0, min(100.0, severity)), 1)

        per_system = self._per_system(oc, real)
        return ImpactMetrics(
            total_nodes_affected=len(real),
            critical_facilities_affected=crit,
            population_affected_estimate=pop,
            power_load_unserved_mw=round(mw_unserved, 3),
            water_demand_unserved_lps=round(lps_unserved, 3),
            telecom_nodes_disconnected=len(tel_lost),
            transport_travel_time_increase_pct=round(tr.travel_time_increase_pct, 2),
            transit_stations_closed=len(stations_closed),
            redundancy_score=round(redundancy, 4),
            severity_index=severity,
            per_system=per_system,
        )

    def _per_system(self, oc: CascadeOutcome, real: dict[str, NodeOutcome]) -> list[SystemImpact]:
        ce, g = self.ce, self.ce.g
        v, base = oc.view, ce.baseline.view  # type: ignore[union-attr]
        p, bp, w, bw, t, bt, tr, btr = (
            v.power,
            base.power,
            v.water,
            base.water,
            v.telecom,
            base.telecom,
            v.transport,
            base.transport,
        )
        assert p and bp and w and bw and t and bt and tr and btr

        def pct(rem: float, b: float) -> float:
            return round(100.0 * rem / b, 2) if b > EPS else 100.0

        def counts(system: str) -> tuple[int, int, float]:
            ids = g.nodes_by_system.get(system, [])
            aff = sum(1 for n in ids if n in real)
            ok = sum(1 for n in ids if v.state(n) not in LOSS_STATES)
            return len(ids), aff, (round(ok / len(ids), 4) if ids else 1.0)

        out: list[SystemImpact] = []
        tot, aff, rf = counts("power")
        notes: list[str] = []
        if p.actions:
            notes.append(
                f"{fmt_num(p.restored_load)} MW restored by {plural(len(p.actions), 'tie switch', 'tie switches')} "
                f"({join_names([a.unit.id for a in p.actions], 3)})"
            )
        for s, frac in sorted(p.overloaded.items()):
            notes.append(f"{s} loaded to {frac * 100:.0f}% of rating")
        for e, frac in sorted(p.line_overloaded.items()):
            notes.append(f"line {e} loaded to {frac * 100:.0f}% of rating")
        for s, (_round, frac) in sorted(oc.tripped.items()):
            notes.append(f"{s} tripped at {frac * 100:.0f}% (> {EMERGENCY_LIMIT * 100:.0f}% emergency limit)")
        for _uid, why in sorted(p.blocked_ties.items()):
            notes.append(why[0].upper() + why[1:])
        out.append(
            SystemImpact(
                system="power",
                nodes_total=tot,
                nodes_affected=aff,
                metric_name="Load served",
                baseline_value=round(bp.served_load, 3),
                remaining_value=round(p.served_load, 3),
                unit="MW",
                percent_served=pct(p.served_load, bp.served_load),
                reachable_fraction=rf,
                notes=notes,
            )
        )
        tot, aff, rf = counts("water")
        notes = []
        if w.isolated_edges:
            notes.append(
                f"{plural(len(w.isolated_edges), 'pipe')} isolated by closing "
                f"{plural(len(w.closing_valves), 'valve')} ({join_names(sorted(w.closing_valves), 3)})"
            )
        for tk, out_lps in sorted(w.tank_outflow.items()):
            notes.append(f"{tk} supplies {fmt_num(out_lps)} L/s from storage ({w.tank_hours[tk]:.1f} h)")
        for tk, hrs in sorted(w.depleted.items()):
            notes.append(f"{tk} would drain after {hrs:.1f} h (before the horizon)")
        out.append(
            SystemImpact(
                system="water",
                nodes_total=tot,
                nodes_affected=aff,
                metric_name="Demand served",
                baseline_value=round(bw.served_total, 3),
                remaining_value=round(w.served_total, 3),
                unit="L/s",
                percent_served=pct(w.served_total, bw.served_total),
                reachable_fraction=rf,
                notes=notes,
            )
        )
        tot, aff, rf = counts("telecom")
        notes = []
        if t.rerouted:
            notes.append(f"{plural(len(t.rerouted), 'node')} rerouted over alternative fibre")
        over = sorted(e for e, o in v.edges.items() if o.state == "overloaded" and g.edge_sys.get(e) == "telecom")
        if over:
            notes.append(f"Congested links: {join_names(over, 3)}")
        if t.outage:
            notes.append(f"{plural(len(t.outage), 'node')} out of service for lack of power")
        out.append(
            SystemImpact(
                system="telecom",
                nodes_total=tot,
                nodes_affected=aff,
                metric_name="Endpoints connected",
                baseline_value=float(bt.endpoints_connected),
                remaining_value=float(t.endpoints_connected),
                unit="endpoints",
                percent_served=pct(t.endpoints_connected, bt.endpoints_connected),
                reachable_fraction=rf,
                notes=notes,
            )
        )
        tot, aff, rf = counts("transport")
        notes = [f"O-D travel time {tr.travel_time_increase_pct:+.1f}% over {tr.od_pairs_total} gateway pairs"]
        if tr.od_pairs_unreachable:
            notes.append(f"{tr.od_pairs_unreachable} O-D pairs unreachable")
        if tr.stations_closed:
            notes.append(f"Stations closed: {join_names(sorted(tr.stations_closed), 3)}")
        dark = sorted(n for n, o in v.nodes.items() if n in ce.signalized and o.state == "degraded")
        if dark:
            notes.append(f"{plural(len(dark), 'traffic signal')} dark (+{SIGNAL_DELAY_S:.0f} s per approach)")
        out.append(
            SystemImpact(
                system="transport",
                nodes_total=tot,
                nodes_affected=aff,
                metric_name="Accessible destinations",
                baseline_value=float(btr.accessible_destinations),
                remaining_value=float(tr.accessible_destinations),
                unit="destinations",
                percent_served=pct(tr.accessible_destinations, btr.accessible_destinations),
                reachable_fraction=rf,
                notes=notes,
            )
        )
        tot, aff, rf = counts("underground")
        corr = g.corridor_edges
        intact = sum(1 for c in corr if v.edges.get(c) is None or v.edges[c].state == "operational")
        notes = []
        if oc.common_cause:
            by = Counter(g.edge_sys[e] for e in oc.common_cause)
            notes.append(
                f"Common-cause: {plural(len(oc.common_cause), 'hosted edge')} failed ("
                + ", ".join(f"{k} {n}" for k, n in sorted(by.items()))
                + ")"
            )
        out.append(
            SystemImpact(
                system="underground",
                nodes_total=tot,
                nodes_affected=aff,
                metric_name="Corridor segments intact",
                baseline_value=float(len(corr)),
                remaining_value=float(intact),
                unit="segments",
                percent_served=pct(intact, len(corr)),
                reachable_fraction=rf,
                notes=notes,
            )
        )
        tot, aff, rf = counts("facility")
        fac = g.nodes_by_system.get("facility", [])
        base_ok = sum(1 for f in fac if base.state(f) == "operational")
        now_ok = sum(1 for f in fac if v.state(f) == "operational")
        notes = [
            f"{f}: {STATE_WORD.get(real[f].state, real[f].state)}"
            for f in sorted(real)
            if g.node_sys[f] == "facility" and g.nodes[f].critical
        ]
        out.append(
            SystemImpact(
                system="facility",
                nodes_total=tot,
                nodes_affected=aff,
                metric_name="Facilities fully served",
                baseline_value=float(base_ok),
                remaining_value=float(now_ok),
                unit="facilities",
                percent_served=pct(now_ok, base_ok),
                reachable_fraction=rf,
                notes=notes,
            )
        )
        return out

    # ---------------------------------------------------------------- steps
    def _noun(self, ids: list[str]) -> str:
        g = self.ce.g
        if all(g.node_sys[i] == "facility" for i in ids):
            return "facility"
        types = Counter(g.node_type[i] for i in ids)
        ty = types.most_common(1)[0][0] if len(types) == 1 else "node"
        return ty.replace("_", " ")

    def _phrase(self, system: str, key: str, ids: list[str], oc: CascadeOutcome) -> str:
        g = self.ce.g
        n = len(ids)
        names = [g.name(i) for i in ids]
        noun = self._noun(ids)
        who = join_names(names, 2) if n <= 2 else plural(n, noun, "facilities" if noun == "facility" else None)
        if system == "transport" and key == "degraded" and all(i in self.ce.signalized for i in ids):
            return f"{n} traffic signal{'s' if n != 1 else ''} dark" if n > 2 else f"signal at {who} dark"
        if system == "power" and key == "failed":
            tr = [i for i in ids if i in oc.tripped]
            if tr:
                return f"{join_names([g.name(i) for i in tr], 2)} tripped on overload"
        if system == "water" and key == "outage" and all(g.node_type[i] == "pump_station" for i in ids):
            return f"{who} without power (booster bypassed)"
        if system == "power" and key == "restored":
            return f"{who} restored by tie switching"
        if key == "rerouted" and system in ("transport", "facility"):
            return f"{who} reached by detour"
        return f"{who} {STATE_WORD.get(key, key)}"

    def _fragments(self, rec: RoundRecord, oc: CascadeOutcome) -> list[tuple[str, int, str, list[str]]]:
        """(system, severity rank, phrase, ids) for every state group that changed in the round."""
        g = self.ce.g
        groups: dict[tuple[str, str], list[str]] = {}
        for n, (_old, new, info) in rec.nodes.items():
            if new == "operational" and not info:
                continue
            key = "rerouted" if info and new == "operational" else new
            groups.setdefault((g.node_sys[n], key), []).append(n)
        out = []
        for (system, key), ids in groups.items():
            out.append((system, STATE_RANK.get(key, 1), self._phrase(system, key, sorted(ids), oc), sorted(ids)))
        # systems whose only visible change is on edges (detours, overloaded lines, ...)
        node_systems = {system for system, _key in groups}
        egroups: dict[tuple[str, str, str], list[str]] = {}
        for e, (_old, new) in rec.edges.items():
            if new in ("operational", "normally_open", "failed"):
                continue
            ed = g.edges[e]
            if ed.relation != "physical" or g.edge_sys[e] in node_systems:
                continue
            egroups.setdefault((g.edge_sys[e], ed.connection_type, new), []).append(e)
        for (system, ctype, state), ids in egroups.items():
            noun = ctype.replace("_", " ")
            who = join_names([g.name(i) for i in sorted(ids)], 1) if len(ids) == 1 else plural(len(ids), noun)
            out.append(
                (system, EDGE_RANK_FOR_LABEL.get(state, 1), f"{who} {STATE_WORD.get(state, state)}", sorted(ids))
            )
        out.sort(key=lambda x: (-x[1], SYSTEMS.index(x[0]) if x[0] in SYSTEMS else 9, x[2]))
        return out

    @staticmethod
    def _group_fragments(frags: list[tuple[str, int, str, list[str]]]) -> list[str]:
        """'Power: A de-energised, B restored' — one entry per system, in severity order."""
        by: dict[str, list[str]] = {}
        for system, _r, ph, _ids in frags:
            by.setdefault(system, []).append(ph)
        return [f"{SYSTEM_TITLE.get(s, s)}: {', '.join(phs[:2])}" for s, phs in by.items()]

    def steps(self, oc: CascadeOutcome) -> tuple[list[CascadeStep], dict[int, int]]:
        g = self.ce.g
        steps: list[CascadeStep] = []
        mapping: dict[int, int] = {}
        if not oc.direct_nodes and not oc.direct_edges:
            return steps, mapping
        for rec in oc.rounds:
            node_ids = sorted(n for n, (_o, new, info) in rec.nodes.items() if new != "operational" or info)
            edge_ids = sorted(e for e, (_o, new) in rec.edges.items() if new not in ("operational",))
            if rec.round > 0 and not node_ids and not edge_ids:
                continue
            idx = len(steps)
            mapping[rec.round] = idx
            systems = sorted({g.node_sys[n] for n in node_ids} | {g.edge_sys[e] for e in edge_ids})
            if rec.round == 0:
                direct = oc.direct_nodes + oc.direct_edges
                label = "Initiating failure: " + join_names([g.name(x) for x in direct], 2)
                desc = (
                    f"{oc.scenario.name or 'Scenario'}: "
                    + join_names([g.label(x) for x in direct], 6)
                    + " fail at t = 0."
                )
                if oc.common_cause:
                    by_src: dict[str, list[str]] = {}
                    for e, src in oc.common_cause.items():
                        by_src.setdefault(src, []).append(e)
                    for src, hs in sorted(by_src.items()):
                        sy = sorted({g.edge_sys[h] for h in hs})
                        desc += (
                            f" Common-cause: {g.label(src)} carries {plural(len(hs), 'edge')} ({', '.join(sy)}) — "
                            f"{join_names(sorted(hs), 4)} fail with it."
                        )
                steps.append(
                    CascadeStep(
                        step=idx, label=label, description=desc, systems=systems, node_ids=node_ids, edge_ids=edge_ids
                    )
                )
                continue
            frags = self._fragments(rec, oc)
            frag_txt = self._group_fragments(frags)
            if rec.round == 1:
                label = "Direct impact — " + (" · ".join(frag_txt[:3]) if frag_txt else "edge states change")
            elif rec.trips:
                trip_names = join_names([g.name(s) for s, _ in rec.trips], 2)
                pct_txt = ", ".join(f"{frac * 100:.0f}%" for _s, frac in rec.trips)
                pw = [f for f in frags if f[0] == "power" and "tripped" not in f[2]]
                rest = self._group_fragments(pw or [f for f in frags if "tripped" not in f[2]])
                label = f"Protective trip: {trip_names} ({pct_txt})" + (f" → {rest[0]}" if rest else "")
                if rec.conditions:
                    label += f" · {plural(len(rec.conditions), 'dependency effect')}"
            elif rec.conditions:
                # lead with a dependency whose consequence shows up in this round (causal arrow)
                changed = [n for n, (_o, new, info) in rec.nodes.items() if new != "operational" or info]

                def effects(c: str, changed: list[str] = changed) -> list[str]:
                    return [n for n in changed if n != c and n in oc.view.nodes and c in oc.view.nodes[n].caused_by]

                ranked = sorted(
                    rec.conditions,
                    key=lambda x: (
                        not effects(x[0]),
                        -COND_RANK[x[1].status],
                        not g.nodes[x[0]].critical,
                        g.node_sys[x[0]] == "facility",
                        x[0],
                    ),
                )
                consumers = {c for c, _cnd in rec.conditions}
                lost_res = Counter(
                    RESOURCE_NAME.get(cnd.ctype, cnd.ctype)
                    for _c, cnd in rec.conditions
                    if cnd.status in ("lost", "backup")
                )
                lead_c, lead = ranked[0]
                res = RESOURCE_NAME.get(lead.ctype, lead.ctype)
                verb = {
                    "lost": f"lost {res}",
                    "backup": f"on backup {res}" if lead.ctype in ("power_supply", "water_supply") else f"lost {res}",
                    "redundancy_lost": f"lost a redundant {res} feed",
                    "degraded": f"{res} degraded",
                }[lead.status]
                eff = effects(lead_c)
                if len(consumers) > 3 and lost_res:
                    # a wide round: summarise instead of singling out one consumer
                    res_txt = join_names([r for r, _n in lost_res.most_common(2)], 2)
                    label = f"Dependency: {len(consumers)} consumers lose {res_txt}"
                    if frag_txt:
                        label += " → " + " · ".join(frag_txt[:2])
                else:
                    label = f"Dependency: {g.name(lead_c)} {verb}"
                    if eff:
                        sub = RoundRecord(rec.round, {n: rec.nodes[n] for n in eff}, {}, [], [])
                        eff_txt = self._group_fragments(self._fragments(sub, oc))
                        if eff_txt:
                            label += f" → {eff_txt[0]}"
                    if len(rec.conditions) > 1:
                        label += f" (+{len(rec.conditions) - 1} more)"
            else:
                label = "Further propagation — " + " · ".join(frag_txt[:3])
            sentences: list[str] = []
            if rec.trips:
                for s, frac in rec.trips:
                    sentences.append(
                        f"{g.label(s)} exceeded the {EMERGENCY_LIMIT * 100:.0f}% emergency limit ({frac * 100:.0f}%) "
                        "and tripped."
                    )
            if rec.conditions and rec.round > 1:
                for c, cnd in sorted(rec.conditions, key=lambda x: (x[0], x[1].ctype))[:6]:
                    sentences.append(f"{g.label(c)} — {cnd.text}")
                if len(rec.conditions) > 6:
                    sentences.append(f"…and {len(rec.conditions) - 6} more dependency effects.")
            for s, _r, ph, ids in frags:
                sentences.append(f"{SYSTEM_TITLE.get(s, s)}: {ph} ({join_names([g.label(i) for i in ids], 5)}).")
            changed_edges = Counter(
                new for _o, new in rec.edges.values() if new not in ("operational", "normally_open")
            )
            if changed_edges:
                sentences.append(
                    "Edges: "
                    + ", ".join(f"{n} {STATE_WORD.get(st, st)}" for st, n in sorted(changed_edges.items()))
                    + "."
                )
            steps.append(
                CascadeStep(
                    step=idx,
                    label=label,
                    description=" ".join(sentences),
                    systems=systems,
                    node_ids=node_ids,
                    edge_ids=edge_ids,
                )
            )
        return steps, mapping

    # ---------------------------------------------------------------- texts
    def summary(self, oc: CascadeOutcome, im: ImpactMetrics, n_steps: int) -> str:
        ce, g = self.ce, self.ce.g
        v = oc.view
        p, w, t, tr = v.power, v.water, v.telecom, v.transport
        assert p and w and t and tr
        if not oc.direct_nodes and not oc.direct_edges:
            return (
                f"Baseline: no failures applied. All modelled systems operate normally — {fmt_num(p.served_load)} MW of "
                f"load served, {fmt_num(w.served_total)} L/s of water demand met, {t.endpoints_connected} telecom "
                f"endpoints connected and {tr.accessible_destinations} transport destinations accessible."
            )
        direct = oc.direct_nodes + oc.direct_edges
        parts: list[str] = []
        systems = sorted({g.node_sys[n] for n, o in ce.affected(oc).items() if node_severity(ce, n, o) != "info"})
        initiators = join_names([g.label(x) for x in direct], 3)
        if im.total_nodes_affected == 0:
            parts.append(
                f"{oc.scenario.name or 'Scenario'}: failure of {initiators} causes no loss of service — the network "
                f"absorbs it through redundancy; severity index {im.severity_index:.1f}/100."
            )
        else:
            parts.append(
                f"{oc.scenario.name or 'Scenario'}: failure of {initiators} affects "
                f"{plural(im.total_nodes_affected, 'node')} across {len(systems)} system{'s' if len(systems) != 1 else ''} "
                f"({', '.join(systems)}) over {plural(max(0, n_steps - 1), 'cascade step')}; "
                f"severity index {im.severity_index:.1f}/100."
            )
        if oc.common_cause:
            srcs = sorted(set(oc.common_cause.values()))
            parts.append(
                f"The failure is common-cause: {plural(len(oc.common_cause), 'hosted edge')} "
                f"({', '.join(sorted({g.edge_sys[e] for e in oc.common_cause}))}) are routed through "
                f"{join_names([g.cc_phrase(x) for x in srcs], 2)}."
            )
        bp = ce.baseline.view.power  # type: ignore[union-attr]
        if im.power_load_unserved_mw > EPS or p.actions or oc.tripped or p.line_overloaded or p.overloaded:
            s = f"Power: {fmt_num(im.power_load_unserved_mw)} of {fmt_num(bp.served_load)} MW unserved"  # type: ignore[union-attr]
            if p.actions:
                s += f", {fmt_num(p.restored_load)} MW restored through {plural(len(p.actions), 'tie switch', 'tie switches')}"
            over = [
                (x, f)
                for x, f in sorted(p.overloaded.items()) + sorted(p.line_overloaded.items())
                if x not in oc.tripped
            ]
            if over:
                s += ", " + join_names([f"{g.name(x)} loaded to {f * 100:.0f}%" for x, f in over], 2)
                if all(f <= EMERGENCY_LIMIT for _x, f in over):
                    s += f" (overloaded but below the {EMERGENCY_LIMIT * 100:.0f}% trip limit)"
            if oc.tripped:
                s += f", {join_names([g.name(x) for x in sorted(oc.tripped)], 2)} tripped on overload"
            parts.append(s + ".")
        zones_out = [n for n in w.node_out if g.node_type[n] == "service_zone" and v.state(n) in ("outage", "isolated")]
        zones_low = [n for n in w.node_out if g.node_type[n] == "service_zone" and v.state(n) == "degraded"]
        zones_tank = [n for n in w.node_out if g.node_type[n] == "service_zone" and v.state(n) == "on_backup"]
        if im.water_demand_unserved_lps > EPS or zones_tank:
            s = f"Water: {fmt_num(im.water_demand_unserved_lps)} L/s of demand unserved"
            bits = []
            if zones_out:
                bits.append(f"{plural(len(zones_out), 'zone')} without supply")
            if zones_low:
                bits.append(f"{len(zones_low)} at low pressure")
            if zones_tank:
                bits.append(f"{plural(len(zones_tank), 'zone')} carried by storage tanks")
            parts.append(s + (f" ({', '.join(bits)})" if bits else "") + ".")
        if im.telecom_nodes_disconnected or t.rerouted:
            parts.append(
                f"Telecom: {plural(im.telecom_nodes_disconnected, 'node')} without connectivity"
                + (f", {len(t.rerouted)} rerouted over alternative fibre" if t.rerouted else "")
                + "."
            )
        inacc = [d for d, a in tr.access.items() if a.status == "inaccessible"]
        delayed = [d for d, a in tr.access.items() if a.status == "delayed"]
        detour = [d for d, a in tr.access.items() if a.status == "detour"]
        if abs(im.transport_travel_time_increase_pct) > 0.05 or im.transit_stations_closed or inacc or detour:
            parts.append(
                f"Transport: O-D travel time {im.transport_travel_time_increase_pct:+.1f}%"
                + (
                    f", {plural(im.transit_stations_closed, 'transit station')} closed"
                    if im.transit_stations_closed
                    else ""
                )
                + (f", {plural(len(inacc), 'destination')} inaccessible" if inacc else "")
                + (f", {len(delayed)} delayed by more than 25%" if delayed else "")
                + (f", {plural(len(detour), 'destination')} reached by detour" if detour else "")
                + "."
            )
        if im.critical_facilities_affected:
            parts.append(
                "Critical facilities affected: "
                + join_names(
                    [
                        f"{g.name(f)} ({STATE_WORD.get(v.state(f), v.state(f))})"
                        for f in im.critical_facilities_affected
                    ],
                    5,
                )
                + "."
            )
        else:
            parts.append("No critical facility is affected.")
        parts.append(
            f"Estimated population affected: {im.population_affected_estimate:,}. Redundancy recovered "
            f"{im.redundancy_score * 100:.0f}% of the service initially cut."
        )
        if oc.truncated:
            parts.append(f"Cascade truncated after {oc.scenario.max_cascade_rounds} rounds.")
        return " ".join(parts)

    def assumptions(self, oc: CascadeOutcome) -> list[str]:
        sc = oc.scenario
        out = [
            "Screening model, not a validated engineering model: results show plausible impact paths on a "
            "partly simulated/estimated network (see provenance), not certified outcomes.",
            "Power: energisation by graph connectivity (BFS) from transmission substations over closed elements; "
            "no AC power flow, voltage, fault-current or protection-coordination study.",
            "Power: loading = sum of served demand on the radial supply path (no losses, unity power factor); "
            f">100% of rating = overloaded, >{EMERGENCY_LIMIT * 100:.0f}% emergency limit = protective trip in the next round.",
        ]
        if sc.enable_restoration:
            out.append(
                "Power: normally-open ties close automatically when the headroom — tie capacity, supplying substations' "
                "spare capacity (rating − served load) and the supplying cables'/lines' 120% emergency rating — covers the "
                "de-energised island; otherwise vaults are restored in priority order (critical consumers incl. pumps, "
                "telecom cores and hospitals, then larger loads) along the feeder and the rest is sectionalised off. "
                "Substation buses are not back-fed."
            )
            out.append(
                "Power: a tie whose SCADA control link is down can only be closed manually after its manual_switch_hours "
                "(default 3 h) — only if that fits within the horizon; ties without a control link are assumed remote-controlled."
            )
        else:
            out.append("Restoration disabled: no tie switching, no fibre rerouting and no traffic detours are applied.")
        out += [
            "Water: hydraulics approximated by max-flow (no pressures or head losses); pressure zones modelled with a "
            "two-layer graph — high zones need an operating booster pump or elevated storage.",
            "Water: a rupture closes the nearest isolation valves (BFS through non-valve nodes); stations and zone "
            "connections are assumed to have their own isolation valves; normally-closed boundary valves stay closed "
            "and are listed as alternatives.",
            "Water: storage tanks only cover demand the supply network cannot meet; duration = storage / outflow; "
            "zones on a tank that lasts the horizon are on backup, otherwise in outage after depletion. Zone service "
            "≥98% operational, ≥50% degraded (low pressure), <50% outage.",
            "Telecom: connectivity = path over operational fibre to any operating internet exchange / data centre; "
            "shortest-path routing by latency/length; capacity check sums endpoint demand along routes (no protocol/QoS model).",
            "Backup (backup_power_hours / backup_hours / water_storage_hours) counts only when it covers the horizon; "
            "missing backup properties mean no backup.",
            f"Transport: static shortest-path travel times (travel_time_s, else length / speed, default 40 km/h); dark "
            f"signals add +{SIGNAL_DELAY_S:.0f} s per approach; no congestion feedback. Destinations delayed above +25% "
            "travel time; road flows are an O-D assignment index (busiest baseline edge at 85% of capacity), not counted traffic.",
            "Transit: stations close without station/traction power (no backup) or when severed from every other open station.",
            "Underground: damage to a duct bank / utility tunnel segment or a utility vault fails every edge routed through it.",
            "Dependencies: a consumer loses a resource only when all its providers lose service; losing some providers is "
            "reported as lost redundancy. One dependency hop per cascade round; losses are not reversed in later rounds.",
            SEVERITY_FORMULA,
            "Population affected = max(residents of de-energised vaults, water zones without full supply, disconnected "
            "telecom endpoints) + occupants of facilities in outage/inaccessible (max avoids double counting).",
        ]
        if oc.truncated:
            out.append(
                f"Cascade truncated at max_cascade_rounds = {sc.max_cascade_rounds}; later effects are not shown."
            )
        return out

    # ---------------------------------------------------------------- result
    def alternatives(self, oc: CascadeOutcome, full: bool = True) -> list[AlternativePath]:
        ce, g = self.ce, self.ce.g
        v = oc.view
        p = v.power
        alts: list[AlternativePath] = []
        assert p and v.water and v.telecom and v.transport
        for a in p.actions:
            src = a.ds or a.supplier
            alts.append(
                AlternativePath(
                    id=f"alt-power-tie-{a.unit.id}",
                    system="power",
                    purpose="tie-switch restoration",
                    from_node=a.supplier,
                    to_node=a.entry,
                    node_ids=[a.supplier, *a.unit.switches, a.entry],
                    edge_ids=list(a.unit.edges),
                    description=(
                        f"Tie {g.label(a.unit.id)} closed ({a.mode}"
                        + (f" after {fmt_num(a.unit.manual_hours)} h" if a.mode == "manual" else "")
                        + f") back-feeds {g.label(a.entry)} from {g.label(src)}: {fmt_num(a.restored_load)} of "
                        f"{fmt_num(a.island_load)} MW restored"
                        + (f" (limited by {a.limit})" if a.left_nodes else "")
                        + "."
                    ),
                    capacity_ok=not a.left_nodes,
                    added_length_m=round(sum(g.edge_length(e) for e in a.unit.edges), 1),
                )
            )
        alts += v.telecom.alternatives
        alts += v.transport.alternatives
        if full:
            alts += ce.water.valve_alternatives(v.water)
        return sorted(alts, key=lambda a: a.id)

    def build(
        self,
        oc: CascadeOutcome,
        *,
        scenario_id: str,
        network_id: str,
        timestamp: str,
        engine_version: str,
        computation_ms: float,
    ) -> SimulationResult:
        ce, g = self.ce, self.ce.g
        v = oc.view
        affected = ce.affected(oc)
        im = self.impact(oc, affected)
        steps, mapping = self.steps(oc)

        def step_of(first: int | None) -> int:
            if first is None:
                return max(mapping.values()) if mapping else 0
            if first in mapping:
                return mapping[first]
            earlier = [s for r, s in mapping.items() if r <= first]
            return max(earlier) if earlier else 0

        aff_nodes: list[AffectedNode] = []
        for n, o in affected.items():
            sev = node_severity(ce, n, o)
            aff_nodes.append(
                AffectedNode(
                    node_id=n,
                    system=g.node_sys[n],
                    state=o.state,  # type: ignore[arg-type]
                    severity=sev,  # type: ignore[arg-type]
                    step=step_of(oc.first_round.get(n)),
                    cause=o.cause,
                    caused_by=sorted(set(o.caused_by) - {n}),
                    service_level=round(max(0.0, min(1.0, o.service_level)), 4),
                )
            )
        aff_nodes.sort(key=lambda a: (a.step, SEVERITY_ORDER[a.severity], a.node_id))

        base_edges = ce.baseline.view.edges if ce.baseline is not None else {}
        interrupted: list[InterruptedEdge] = []
        edge_states: dict[str, str] = {}
        for e in g.edge_ids:
            o = v.edges.get(e)
            st = o.state if o is not None else "operational"
            edge_states[e] = st
            if o is None or st in ("operational", "normally_open"):
                continue
            b = base_edges.get(e)
            if b is not None and b.state == st and e not in oc.failed_edges:
                continue
            interrupted.append(
                InterruptedEdge(
                    edge_id=e,
                    system=g.edge_sys[e],
                    state=st,  # type: ignore[arg-type]
                    reason=o.reason,
                    step=step_of(oc.edge_first_round.get(e)),
                )
            )
        interrupted.sort(key=lambda x: (x.step, x.edge_id))

        node_states = {n: v.state(n) for n in g.node_ids}
        flows: dict[str, EdgeFlow] = {}
        for res in (v.power, v.water, v.telecom, v.transport):
            for e, f in res.flows.items():  # type: ignore[union-attr]
                flows[e] = EdgeFlow(
                    direction=f.direction, utilization=max(0.0, f.utilization), flow=f.flow, unit=f.unit
                )
        flows = {e: flows[e] for e in sorted(flows)}
        reachable = sorted(n for n in g.node_ids if node_states[n] not in LOSS_STATES)

        return SimulationResult(
            scenario_id=scenario_id,
            scenario=oc.scenario,
            network_id=network_id,
            failed_nodes=sorted(oc.failed_nodes),
            failed_edges=sorted(oc.failed_edges),
            affected_nodes=aff_nodes,
            interrupted_edges=interrupted,
            reachable_nodes=reachable,
            alternative_paths=self.alternatives(oc),
            impact_metrics=im,
            cascade_steps=steps,
            node_states=node_states,  # type: ignore[arg-type]
            edge_states=edge_states,  # type: ignore[arg-type]
            edge_flows=flows,
            assumptions=self.assumptions(oc),
            timestamp=timestamp,
            engine_version=engine_version,
            computation_ms=round(computation_ms, 2),
            summary=self.summary(oc, im, len(steps)),
        )
