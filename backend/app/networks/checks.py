"""Structural sanity checks for a generated DEEPTRACE network.

``check_network`` returns a list of human-readable problems (empty = OK). It is run by
``python -m app.networks.generate`` after every build and by ``tests/test_dataset.py``.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import networkx as nx

from app.models.schemas import EDGE_CONNECTION_TYPES, NODE_TYPES, InfrastructureNetwork
from app.networks import geo

FACILITY_TYPES = set(NODE_TYPES["facility"])

# connection_type -> (allowed provider types, allowed consumer types)
DEPENDENCY_RULES: dict[str, tuple[set[str], set[str]]] = {
    "power_supply": (
        {"network_vault"},
        {"pump_station", "internet_exchange", "data_center", "central_office", "cell_site", "access_node", "intersection", "transit_station"}
        | FACILITY_TYPES,
    ),
    "water_supply": ({"service_zone"}, FACILITY_TYPES | {"data_center", "internet_exchange"}),
    "telecom_link": ({"fiber_hub", "access_node", "central_office", "internet_exchange"}, FACILITY_TYPES | {"transit_station"}),
    "control_link": ({"fiber_hub", "access_node", "central_office", "internet_exchange"}, {"pump_station", "switch", "storage_tank"}),
    "road_access": ({"intersection", "gateway"}, FACILITY_TYPES | {"transit_station"}),
}


def _graph(nodes: dict[str, dict[str, Any]], edges: list[dict[str, Any]]) -> nx.Graph:
    g = nx.Graph()
    g.add_nodes_from(nodes)
    for e in edges:
        g.add_edge(e["source_node"], e["target_node"])
    return g


def check_network(
    network: dict[str, Any],
    *,
    presets: list[dict[str, Any]] | None = None,
    demo: dict[str, Any] | None = None,
    bbox_margin_m: float = 150.0,
) -> list[str]:
    problems: list[str] = []
    try:
        InfrastructureNetwork.model_validate(network)
    except Exception as exc:  # pragma: no cover - reported, not raised
        return [f"schema validation failed: {exc}"]

    nodes = {n["id"]: n for n in network["nodes"]}
    edges = network["edges"]
    edge_by_id = {e["id"]: e for e in edges}
    bbox = network["region"]["bbox"]

    # -- identity -----------------------------------------------------------
    if len(nodes) != len(network["nodes"]):
        problems.append("duplicate node ids")
    if len(edge_by_id) != len(edges):
        problems.append("duplicate edge ids")
    clash = set(nodes) & set(edge_by_id)
    if clash:
        problems.append(f"ids used by both a node and an edge: {sorted(clash)[:5]}")

    # -- vocabulary, provenance, positions ----------------------------------
    datasets = network.get("datasets", [])
    inspected_mapped = any(d["category"] == "publicly_mapped" and d.get("inspected") for d in datasets)
    for n in nodes.values():
        if n["type"] not in NODE_TYPES.get(n["system"], []):
            problems.append(f"node {n['id']}: type {n['type']} not in NODE_TYPES[{n['system']}]")
        if not geo.in_bbox((n["longitude"], n["latitude"]), bbox, bbox_margin_m):
            problems.append(f"node {n['id']} outside region bbox")
        cat = n["provenance"]["category"]
        if cat == "verified":
            problems.append(f"node {n['id']} claims VERIFIED provenance")
        if cat == "publicly_mapped" and not inspected_mapped:
            problems.append(f"node {n['id']} is PUBLICLY_MAPPED but no inspected public dataset is listed")
        if cat == "simulated" and n["provenance"]["confidence"] > 0.2:
            problems.append(f"node {n['id']}: simulated asset with confidence > 0.2")
        if "(simulated)" in n["name"] and cat != "simulated":
            problems.append(f"node {n['id']} is named as simulated but labelled {cat.upper()}")
        if n["system"] in ("power", "water", "underground") and cat != "simulated":
            problems.append(f"node {n['id']}: utility assets must stay SIMULATED (an OSM match only sets location)")
    for e in edges:
        rel = e["relation"]
        if e["connection_type"] not in EDGE_CONNECTION_TYPES[rel]:
            problems.append(f"edge {e['id']}: {e['connection_type']} is not a {rel} connection type")
        if e["source_node"] not in nodes or e["target_node"] not in nodes:
            problems.append(f"edge {e['id']} has a dangling endpoint")
            continue
        if e["source_node"] == e["target_node"]:
            problems.append(f"edge {e['id']} is a self-loop")
        geom = e["geometry"]
        if len(geom) < 2:
            problems.append(f"edge {e['id']} has fewer than 2 geometry vertices")
            continue
        s, t = nodes[e["source_node"]], nodes[e["target_node"]]
        if geo.haversine_m(geom[0], (s["longitude"], s["latitude"])) > 5 or geo.haversine_m(geom[-1], (t["longitude"], t["latitude"])) > 5:
            problems.append(f"edge {e['id']}: geometry does not start/end at its nodes")
        if any(not geo.in_bbox(p, bbox, bbox_margin_m) for p in geom):
            problems.append(f"edge {e['id']}: geometry leaves the region bbox")
        if abs(geo.polyline_length_m(geom) - e["length_m"]) > 1.0:
            problems.append(f"edge {e['id']}: length_m does not match geometry")
        cat = e["provenance"]["category"]
        if cat == "verified":
            problems.append(f"edge {e['id']} claims VERIFIED provenance")
        if cat == "publicly_mapped" and not inspected_mapped:
            problems.append(f"edge {e['id']} is PUBLICLY_MAPPED but no inspected public dataset is listed")
        if rel == "dependency":
            if cat != "simulated":
                problems.append(f"dependency {e['id']} must be SIMULATED")
            if not e["directed"] or e["depth_m"] != 0:
                problems.append(f"dependency {e['id']} must be directed with depth 0")
            providers, consumers = DEPENDENCY_RULES[e["connection_type"]]
            if s["type"] not in providers:
                problems.append(f"dependency {e['id']}: provider type {s['type']} not allowed for {e['connection_type']}")
            if t["type"] not in consumers:
                problems.append(f"dependency {e['id']}: consumer type {t['type']} not allowed for {e['connection_type']}")
        if e["infrastructure_type"] in ("power", "water", "telecom", "underground") and rel == "physical" and cat == "simulated":
            if e["provenance"]["confidence"] > 0.2:
                problems.append(f"edge {e['id']}: simulated asset with confidence > 0.2")

    phys = [e for e in edges if e["relation"] == "physical"]
    deps = [e for e in edges if e["relation"] == "dependency"]

    def system_nodes(system: str) -> dict[str, dict[str, Any]]:
        return {k: v for k, v in nodes.items() if v["system"] == system}

    # -- power ----------------------------------------------------------------
    pn = system_nodes("power")
    pe = [e for e in phys if e["infrastructure_type"] == "power" and e["status"] != "normally_open"]
    g = _graph({k: v for k, v in pn.items() if not v["properties"].get("normally_open")}, pe)
    sources = {k for k, v in pn.items() if v["type"] == "transmission_substation"}
    for comp in nx.connected_components(g):
        if not comp & sources:
            problems.append(f"power island without a transmission source: {sorted(comp)[:4]}")
    for k, v in pn.items():
        if v["properties"].get("normally_open"):
            ties = [e for e in phys if k in (e["source_node"], e["target_node"])]
            if len(ties) != 2 or any(e["connection_type"] != "tie_line" or e["status"] != "normally_open" for e in ties):
                problems.append(f"tie switch {k} must have exactly two normally-open tie_line edges")
            ends = {e["source_node"] for e in ties} | {e["target_node"] for e in ties}
            subs = {pn[x]["properties"].get("substation") for x in ends if x != k and x in pn}
            if len(subs) != 2:
                problems.append(f"tie switch {k} must join feeders of two different substations")
            if not 2 <= float(v["properties"].get("manual_switch_hours", 0)) <= 4:
                problems.append(f"tie switch {k}: manual_switch_hours outside 2-4")
    for k, v in pn.items():
        if v["type"] == "network_vault" and not (0.6 <= (v["demand"] or 0) <= 3.0):
            problems.append(f"vault {k}: demand {v['demand']} MW outside 0.6-3.0")
        if v["type"] == "distribution_substation":
            ratio = (v["demand"] or 0) / (v["capacity"] or 1)
            if not 0.55 <= ratio <= 0.75:
                problems.append(f"substation {k}: load {ratio:.0%} of rating outside 55-75%")

    # -- water ----------------------------------------------------------------
    wn = system_nodes("water")
    closed = {k for k, v in wn.items() if v["properties"].get("normally_closed")}
    we = [e for e in phys if e["infrastructure_type"] == "water"]
    open_edges = [e for e in we if e["source_node"] not in closed and e["target_node"] not in closed]
    g = _graph({k: v for k, v in wn.items() if k not in closed}, open_edges)
    wsources = {k for k, v in wn.items() if v["type"] in ("supply_source", "storage_tank")}
    for comp in nx.connected_components(g):
        if not comp & wsources:
            problems.append(f"water island without supply: {sorted(comp)[:4]}")
    pumps = {k for k, v in wn.items() if v["type"] == "pump_station"}
    g_no_pump = g.copy()
    g_no_pump.remove_nodes_from(pumps)
    supply = {k for k, v in wn.items() if v["type"] == "supply_source"}
    reach_without_pump = set().union(*(nx.node_connected_component(g_no_pump, s) for s in supply)) if supply else set()
    for k, v in wn.items():
        if v["properties"].get("pressure_zone") == "high" and v["type"] in ("junction", "service_zone") and k in reach_without_pump:
            problems.append(f"high-zone node {k} is reachable from a low-zone source without the pump")
    if not closed:
        problems.append("no normally-closed boundary valves in the water system")

    # -- telecom ----------------------------------------------------------------
    tn = system_nodes("telecom")
    te = [e for e in phys if e["infrastructure_type"] == "telecom"]
    g = _graph(tn, te)
    cores = {k for k, v in tn.items() if v["type"] == "internet_exchange"}
    for comp in nx.connected_components(g):
        if not comp & cores:
            problems.append(f"telecom island without a core: {sorted(comp)[:4]}")
    if len(cores) >= 2:
        a, b = sorted(cores)[:2]
        if nx.has_path(g, a, b) and nx.edge_connectivity(g, a, b) < 2:
            problems.append("the two telecom cores are not joined by two edge-disjoint paths")

    # -- transport --------------------------------------------------------------
    roads = [e for e in phys if e["connection_type"] == "road_segment"]
    road_nodes = {k: v for k, v in nodes.items() if v["type"] in ("intersection", "gateway")}
    if road_nodes and nx.number_connected_components(_graph(road_nodes, roads)) != 1:
        problems.append("street network is not a single connected component")
    stations = {k for k, v in nodes.items() if v["type"] == "transit_station"}
    rails = [e for e in phys if e["connection_type"] == "rail_segment"]
    if stations and nx.number_connected_components(_graph({k: nodes[k] for k in stations}, rails)) != 1:
        problems.append("rail network does not connect all stations")

    # -- dependencies per consumer ------------------------------------------------
    incoming: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for e in deps:
        incoming[e["target_node"]][e["connection_type"]].append(e["source_node"])
    for k, v in nodes.items():
        if v["system"] == "facility" or v["type"] == "transit_station":
            if not incoming[k]["power_supply"]:
                problems.append(f"{k} has no power_supply dependency")
            if not incoming[k]["road_access"]:
                problems.append(f"{k} has no road_access dependency")
        if v["type"] == "hospital":
            subs = {nodes[p]["properties"].get("substation") for p in incoming[k]["power_supply"]}
            if len(subs) < 2:
                problems.append(f"hospital {k} is not fed from two different substations")
        if v["type"] in ("pump_station", "internet_exchange", "central_office", "cell_site", "access_node", "data_center"):
            if not incoming[k]["power_supply"]:
                problems.append(f"{k} has no power_supply dependency")
        if v["type"] == "intersection" and v["properties"].get("signalized") and not incoming[k]["power_supply"]:
            problems.append(f"signalised intersection {k} has no power_supply dependency")
        if v["type"] == "switch" and v["properties"].get("normally_open") and not incoming[k]["control_link"]:
            problems.append(f"tie switch {k} has no SCADA control_link")

    # -- underground corridors ------------------------------------------------------
    corridors = {e["id"]: e for e in phys if e["infrastructure_type"] == "underground"}
    for cid, c in corridors.items():
        if c["connection_type"] not in ("duct_bank", "utility_tunnel"):
            problems.append(f"corridor {cid} has connection_type {c['connection_type']}")
        for end in (c["source_node"], c["target_node"]):
            if nodes[end]["type"] != "utility_vault":
                problems.append(f"corridor {cid} does not end at a utility_vault")
        for h in c["properties"].get("hosted_edge_ids", []):
            if h not in edge_by_id or edge_by_id[h]["corridor_id"] != cid:
                problems.append(f"corridor {cid}: hosted edge {h} does not reference it")
    for e in edges:
        cid = e.get("corridor_id")
        if cid is None:
            continue
        if cid not in corridors:
            problems.append(f"edge {e['id']} references unknown corridor {cid}")
        elif e["id"] not in corridors[cid]["properties"].get("hosted_edge_ids", []):
            problems.append(f"edge {e['id']} not listed in corridor {cid} hosted_edge_ids")
    if corridors and not any(
        {edge_by_id[h]["infrastructure_type"] for h in c["properties"].get("hosted_edge_ids", [])} >= {"power", "telecom"}
        for c in corridors.values()
    ):
        problems.append("no corridor hosts both a power and a telecom edge (common-cause showcase missing)")

    # -- presets & demo ----------------------------------------------------------------
    for p in presets or []:
        sc = p["scenario"]
        for nid in sc["failed_nodes"]:
            if nid not in nodes:
                problems.append(f"preset {p['id']}: unknown failed node {nid}")
        for eid in sc["failed_edges"]:
            if eid not in edge_by_id:
                problems.append(f"preset {p['id']}: unknown failed edge {eid}")
        if not sc["failed_nodes"] and not sc["failed_edges"]:
            problems.append(f"preset {p['id']} fails nothing")
        if p.get("focus_node_id") and p["focus_node_id"] not in nodes:
            problems.append(f"preset {p['id']}: unknown focus node {p['focus_node_id']}")
    if demo:
        ids = {p["id"] for p in presets or []}
        for key in ("scenario_a_preset", "scenario_b_preset"):
            if demo[key] not in ids:
                problems.append(f"demo {key} {demo[key]} is not a preset")
        if demo["focus_node_id"] not in nodes:
            problems.append("demo focus node missing")
        for st in demo["steps"]:
            if st.get("node_id") and st["node_id"] not in nodes:
                problems.append(f"demo step {st['id']}: unknown node {st['node_id']}")
            if st.get("preset_id") and st["preset_id"] not in ids:
                problems.append(f"demo step {st['id']}: unknown preset {st['preset_id']}")
    return problems
