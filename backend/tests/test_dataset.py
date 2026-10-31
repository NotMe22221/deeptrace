"""Sanity checks for the shipped downtown Atlanta dataset (network.json, scenarios.json, demo.json).

These guard the properties the demo relies on: a valid contract, honest provenance,
geographically coherent geometry, the intended topology of every system, consistent
corridor hosting and up-to-date, byte-stable generated files.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx
import pytest

from app.config import PUBLIC_DEMO_DIR, REGIONS_DIR
from app.models.schemas import InfrastructureNetwork
from app.networks import geo
from app.networks.checks import check_network
from app.networks.generate import generate_region
from app.networks.loader import load_demo_script, load_network, load_presets, load_region

REGION = "atlanta-downtown"
REGION_DIR = REGIONS_DIR / REGION


@pytest.fixture(scope="module")
def raw() -> dict:
    return json.loads((REGION_DIR / "network.json").read_text())


@pytest.fixture(scope="module")
def presets() -> list[dict]:
    return json.loads((REGION_DIR / "scenarios.json").read_text())


@pytest.fixture(scope="module")
def demo() -> dict:
    return json.loads((REGION_DIR / "demo.json").read_text())


@pytest.fixture(scope="module")
def nodes(raw) -> dict[str, dict]:
    return {n["id"]: n for n in raw["nodes"]}


@pytest.fixture(scope="module")
def edges(raw) -> dict[str, dict]:
    return {e["id"]: e for e in raw["edges"]}


def deps_into(edges: dict[str, dict], node_id: str, ctype: str | None = None) -> list[dict]:
    return [
        e
        for e in edges.values()
        if e["relation"] == "dependency" and e["target_node"] == node_id and (ctype is None or e["connection_type"] == ctype)
    ]


# --------------------------------------------------------------------------- contract & files


def test_validates_against_contract(raw) -> None:
    net = InfrastructureNetwork.model_validate(raw)
    assert net.version == "1.0.0"
    assert net.generated_at == "2026-10-31T00:00:00Z"
    assert net.region.id == REGION


def test_loader_reads_dataset() -> None:
    load_network.cache_clear()
    net = load_network(REGION)
    assert len(net.nodes) == len(json.loads((REGION_DIR / "network.json").read_text())["nodes"])
    assert load_region(REGION).ground_elevation_m == pytest.approx(290, abs=30)
    assert {p.id for p in load_presets(REGION)} >= {"A-DS-FIVEPOINTS", "B-EDGEWOOD-DUCTBANK"}
    script = load_demo_script(REGION)
    assert script is not None and script.focus_node_id == "PWR-DS-FIVEPOINTS"


def test_all_structural_checks_pass(raw, presets, demo) -> None:
    assert check_network(raw, presets=presets, demo=demo) == []


def test_generated_files_are_current_and_byte_stable(tmp_path: Path) -> None:
    """Regenerating reproduces the committed files exactly (deterministic, no stale outputs)."""
    generate_region(REGION_DIR, out_dir=tmp_path / "a", mirror_dir=tmp_path / "mirror")
    generate_region(REGION_DIR, out_dir=tmp_path / "b", mirror_dir=None)
    for name in ("network.json", "scenarios.json", "demo.json"):
        a = (tmp_path / "a" / name).read_bytes()
        assert a == (tmp_path / "b" / name).read_bytes(), f"{name} is not deterministic"
        assert a == (REGION_DIR / name).read_bytes(), f"{name} is stale: run python -m app.networks.generate"
    assert (PUBLIC_DEMO_DIR / "network.json").read_bytes() == (REGION_DIR / "network.json").read_bytes()


def test_size_targets(raw) -> None:
    assert 260 <= len(raw["nodes"]) <= 360
    assert 420 <= len(raw["edges"]) <= 650


# --------------------------------------------------------------------------- identity & geometry


def test_ids_unique_and_endpoints_exist(raw, nodes, edges) -> None:
    assert len(nodes) == len(raw["nodes"])
    assert len(edges) == len(raw["edges"])
    assert not set(nodes) & set(edges)
    for e in edges.values():
        assert e["source_node"] in nodes and e["target_node"] in nodes, e["id"]


def test_geometry_inside_region(raw, nodes, edges) -> None:
    bbox = raw["region"]["bbox"]
    for n in nodes.values():
        assert geo.in_bbox((n["longitude"], n["latitude"]), bbox, 100), n["id"]
    for e in edges.values():
        assert len(e["geometry"]) >= 2, e["id"]
        assert all(geo.in_bbox(p, bbox, 150) for p in e["geometry"]), e["id"]
        assert e["length_m"] == pytest.approx(geo.polyline_length_m(e["geometry"]), abs=1.0)


def test_utility_edges_follow_streets(nodes, edges) -> None:
    """Routed utility edges have street-following geometry with modest detours."""
    routed = [
        e
        for e in edges.values()
        if e["relation"] == "physical" and e["infrastructure_type"] in ("power", "water", "telecom", "underground")
    ]
    multi_vertex = sum(1 for e in routed if len(e["geometry"]) > 2)
    assert multi_vertex / len(routed) > 0.8
    for e in routed:
        a, b = nodes[e["source_node"]], nodes[e["target_node"]]
        straight = geo.haversine_m((a["longitude"], a["latitude"]), (b["longitude"], b["latitude"]))
        if e["length_m"] > 250:
            assert e["length_m"] / max(straight, 1) < 2.6, e["id"]


# --------------------------------------------------------------------------- provenance honesty


def test_provenance_is_honest(raw, nodes, edges) -> None:
    cats = Counter(x["provenance"]["category"] for x in list(nodes.values()) + list(edges.values()))
    assert cats["verified"] == 0
    assert cats["publicly_mapped"] == 0, "nothing was fetched from a public dataset in this build"
    for x in list(nodes.values()) + list(edges.values()):
        p = x["provenance"]
        assert p["source"]
        if p["category"] == "simulated":
            assert p["confidence"] <= 0.2 and "NOT" in (p["notes"] or "") or "SIMULATED" in (p["notes"] or ""), x["id"]
        if p["category"] == "estimated":
            assert 0.3 <= p["confidence"] <= 0.75, x["id"]
    for n in nodes.values():
        if n["system"] in ("power", "water", "underground"):
            assert n["provenance"]["category"] == "simulated", n["id"]
            assert "(simulated)" in n["name"], n["id"]
    for e in edges.values():
        if e["relation"] == "dependency":
            assert e["provenance"]["category"] == "simulated"
    ix = nodes["TEL-IX-56MARIETTA"]
    assert ix["provenance"]["category"] == "estimated" and "SIMULATED" in ix["provenance"]["notes"]


def test_datasets_documented(raw) -> None:
    ds = {d["id"]: d for d in raw["datasets"]}
    assert ds["authored-streets"]["category"] == "estimated" and not ds["authored-streets"]["inspected"]
    assert ds["authored-landmarks"]["category"] == "estimated"
    assert ds["deeptrace-generator"]["category"] == "simulated"
    osm = ds["osm-overpass"]
    assert osm["category"] == "publicly_mapped" and osm["feature_count"] == 0 and not osm["inspected"]
    assert osm["license"] == "ODbL-1.0" and "Not fetched" in osm["notes"]
    assert ds["cesium-osm-buildings"]["feature_count"] == 0 and not ds["cesium-osm-buildings"]["inspected"]
    assert len(raw["assumptions"]) >= 8


# --------------------------------------------------------------------------- per-system topology


def test_power_design(nodes, edges) -> None:
    by_type = Counter(n["type"] for n in nodes.values() if n["system"] == "power")
    assert 2 <= by_type["transmission_substation"] <= 3
    assert 5 <= by_type["distribution_substation"] <= 6
    for n in nodes.values():
        if n["type"] == "transmission_substation":
            assert 90 <= n["capacity"] <= 140 and n["properties"]["voltage_kv"] == 115
        if n["type"] == "distribution_substation":
            assert 28 <= n["capacity"] <= 45
            assert 2 <= len(n["properties"]["feeders"]) <= 3
            assert 0.55 <= n["demand"] / n["capacity"] <= 0.75
        if n["type"] == "network_vault":
            assert 0.6 <= n["demand"] <= 3.0 and n["properties"]["population_served"] > 0
    feeders = [e for e in edges.values() if e["connection_type"] == "feeder_cable"]
    assert all(9 <= e["capacity"] <= 14 for e in feeders)
    # radial feeders: without ties, every vault has exactly one path to its substation
    g = nx.Graph()
    g.add_edges_from((e["source_node"], e["target_node"]) for e in feeders)
    assert nx.is_forest(g)
    ties = [e for e in edges.values() if e["connection_type"] == "tie_line"]
    assert ties and all(e["status"] == "normally_open" and 4 <= e["capacity"] <= 10 for e in ties)


def test_five_points_can_only_be_partially_restored(nodes, edges) -> None:
    ds = nodes["PWR-DS-FIVEPOINTS"]
    fp_feeders = set(ds["properties"]["feeders"])
    tie_switches = [
        n for n in nodes.values() if n["properties"].get("normally_open") and set(n["properties"]["feeders"]) & fp_feeders
    ]
    assert len(tie_switches) >= 2
    tie_capacity = sum(n["properties"]["tie_capacity_mw"] for n in tie_switches)
    assert tie_capacity < ds["demand"], "ties must not be able to pick up the whole Five Points load"
    for sw in tie_switches:
        assert 2 <= sw["properties"]["manual_switch_hours"] <= 4
        assert deps_into(edges, sw["id"], "control_link"), "remote switching needs a SCADA comms link"


def test_marietta_corridor_hosts_power_and_fibre(edges) -> None:
    db = edges["UGD-DB-01"]
    assert db["connection_type"] == "duct_bank" and 1.5 <= db["depth_m"] <= 3.0
    hosted = [edges[h] for h in db["properties"]["hosted_edge_ids"]]
    assert any(h["infrastructure_type"] == "power" and h["properties"].get("substation") == "PWR-DS-FIVEPOINTS" for h in hosted)
    assert any(h["connection_type"] == "fiber_link" for h in hosted)
    assert all(h["corridor_id"] == "UGD-DB-01" for h in hosted)
    corridors = [e for e in edges.values() if e["infrastructure_type"] == "underground"]
    assert 6 <= len(corridors) <= 9


def test_edgewood_corridor_is_a_hidden_single_point_of_failure(nodes, edges) -> None:
    """Scenario B: one trench carries a Grady feed, a station traction feed and BOTH of Grady's comms paths."""
    db = edges["UGD-DB-06"]
    hosted = {h: edges[h] for h in db["properties"]["hosted_edge_ids"]}
    feeder_sections = [h for h in hosted.values() if h["connection_type"] == "feeder_cable"]
    assert len(feeder_sections) >= 2, "a vault stranded between two cuts cannot be restored"
    stranded = {h["target_node"] for h in feeder_sections} & {h["source_node"] for h in feeder_sections}
    assert stranded, "some vault must sit between two hosted feeder sections"
    tie_vaults = {
        e["source_node"] if e["source_node"] in nodes and nodes[e["source_node"]]["type"] == "network_vault" else e["target_node"]
        for e in edges.values()
        if e["connection_type"] == "tie_line"
    }
    assert not stranded & tie_vaults, "the stranded vault must have no tie"
    grady_power = {e["source_node"] for e in deps_into(edges, "FAC-GRADY", "power_supply")}
    assert grady_power & stranded, "one of Grady's two feeds runs through the trench"
    grady_comms = {e["source_node"] for e in deps_into(edges, "FAC-GRADY", "telecom_link")}
    assert len(grady_comms) == 2
    fibre_targets = {h["target_node"] for h in hosted.values() if h["connection_type"] == "fiber_link"}
    assert grady_comms <= fibre_targets, "both 'diverse' comms paths share the trench"
    for acc in grady_comms:
        homes = [e for e in edges.values() if e["connection_type"] == "fiber_link" and acc in (e["source_node"], e["target_node"])]
        assert len(homes) == 1, f"{acc} is single-homed"
    station_feed = {e["source_node"] for e in deps_into(edges, "TRN-STN-GEORGIASTATE", "power_supply")}
    assert nodes[next(iter(station_feed))]["properties"]["feeder"] == "GR-1"


def test_water_design(nodes, edges) -> None:
    w = {k: v for k, v in nodes.items() if v["system"] == "water"}
    types = Counter(v["type"] for v in w.values())
    assert types["supply_source"] == 2 and types["pump_station"] == 1 and types["storage_tank"] == 1
    assert 8 <= types["service_zone"] <= 12
    assert types["valve"] >= 8
    tank = next(v for v in w.values() if v["type"] == "storage_tank")
    assert tank["properties"]["storage_m3"] == pytest.approx(4000) and tank["elevation"] == pytest.approx(40)
    boundary = [v for v in w.values() if v["properties"].get("normally_closed")]
    assert 1 <= len(boundary) <= 2
    zones = [v for v in w.values() if v["type"] == "service_zone"]
    assert all(15 <= z["demand"] <= 60 and z["properties"]["population"] > 0 for z in zones)
    assert {z["properties"]["pressure_zone"] for z in zones} == {"high", "low"}
    # looped grid: the low-zone network has cycles (not a tree)
    pipes = [e for e in edges.values() if e["infrastructure_type"] == "water" and e["relation"] == "physical"]
    g = nx.Graph()
    g.add_edges_from((e["source_node"], e["target_node"]) for e in pipes)
    assert len(nx.cycle_basis(g)) >= 4
    pump = next(v for v in w.values() if v["type"] == "pump_station")
    assert deps_into(edges, pump["id"], "power_supply") and deps_into(edges, pump["id"], "control_link")


def test_water_valve_segments_are_small(nodes, edges) -> None:
    """Every main between junctions has an isolation valve, so a break isolates ~1 junction (+ its zone)."""
    boundary_types = {"valve", "supply_source", "pump_station", "storage_tank", "service_zone"}
    pipes = [e for e in edges.values() if e["infrastructure_type"] == "water" and e["relation"] == "physical"]
    g = nx.Graph()
    g.add_edges_from((e["source_node"], e["target_node"]) for e in pipes)
    junctions = [n for n in g if nodes[n]["type"] == "junction"]
    interior = g.subgraph(n for n in g if nodes[n]["type"] not in boundary_types)
    sizes = [len(c) for c in nx.connected_components(interior)]
    assert sum(sizes) == len(junctions) and max(sizes) <= 2, sizes
    dual = [n for n in nodes.values() if n["type"] == "service_zone" and n["properties"].get("service_connections", 1) >= 2]
    assert 1 <= len(dual) <= 3
    for z in dual:
        feeds = [e for e in pipes if e["target_node"] == z["id"]]
        assert len({e["source_node"] for e in feeds}) >= 2


def test_ts_south_loss_overloads_alternate_line(nodes, edges) -> None:
    """F-TS-SOUTH: Five Points' only other supply is an alternate line that cannot carry it (> 120% -> trip)."""
    lines = [e for e in edges.values() if e["connection_type"] == "transmission_line" and "PWR-DS-FIVEPOINTS" in (e["source_node"], e["target_node"])]
    primary = [e for e in lines if e["properties"]["role"] == "primary"]
    alternate = [e for e in lines if e["properties"]["role"] == "alternate"]
    assert {e["source_node"] for e in primary} == {"PWR-TS-SOUTH"} and len(alternate) == 1
    assert nodes["PWR-DS-FIVEPOINTS"]["demand"] > 1.2 * alternate[0]["capacity"]


def test_carrier_hotel_has_single_homed_dependants(nodes, edges) -> None:
    """D-TELECOM-56MARIETTA: some sites reach the core only through 56 Marietta, one serving critical facilities."""
    fibre = [e for e in edges.values() if e["connection_type"] == "fiber_link"]
    homes: dict[str, set[str]] = defaultdict(set)
    for e in fibre:
        for a, b in ((e["source_node"], e["target_node"]), (e["target_node"], e["source_node"])):
            if nodes[a]["type"] in ("cell_site", "access_node"):
                homes[a].add(b)
    only_56 = [k for k, v in homes.items() if v == {"TEL-IX-56MARIETTA"}]
    assert 2 <= len(only_56) <= 3
    served = {e["target_node"] for e in edges.values() if e["connection_type"] == "telecom_link" and e["source_node"] in only_56}
    assert any(nodes[f]["critical"] for f in served)


def test_assumptions_match_the_data(raw, nodes, edges) -> None:
    """Every data-derived assumption sentence agrees with the network it describes."""
    from app.networks.generate import EMERGENCY_LIMIT
    from app.simulation import power as engine_power

    assert EMERGENCY_LIMIT == engine_power.EMERGENCY_LIMIT
    text = " ".join(raw["assumptions"])
    under = [
        e["id"]
        for e in edges.values()
        if e["connection_type"] == "transmission_line"
        and e["properties"].get("role") == "alternate"
        and e["capacity"] * EMERGENCY_LIMIT < nodes[e["target_node"]]["demand"]
    ]
    assert under == ["PWR-TL-02"]
    for e in edges.values():
        if e["connection_type"] == "transmission_line" and e["properties"].get("role") == "alternate":
            assert (e["id"] in text) == (e["id"] in under)
    assert "single-homed spur" not in text and "links the rings" in text
    assert "drawn from the nearest network vault" not in text
    assert "Georgia State station (MARTA) <- GR-1" in text and "Fairlie-Poplar booster pump station <- FP-1" in text
    vaults = [n for n in nodes.values() if n["type"] == "network_vault"]
    for consumer in ("TRN-STN-FIVEPOINTS", "TEL-IX-56MARIETTA", "FAC-STADIUM"):  # pinned, but to their nearest vault anyway
        assert f"{nodes[consumer]['name']} <-" not in text
        c = nodes[consumer]
        nearest = min(vaults, key=lambda v: (geo.haversine_m((c["longitude"], c["latitude"]), (v["longitude"], v["latitude"])), v["id"]))
        assert {e["source_node"] for e in deps_into(edges, consumer, "power_supply")} == {nearest["id"]}
    assert "Access node Capitol Hill (simulated) and Cell site Five Points rooftop (simulated) reach the core only through" not in text
    assert "Access node Capitol Hill and Cell site Five Points rooftop reach the core only through 56 Marietta" in text
    assert "every tie is rated below the load of the feeders it joins" in text
    assert "isolates at most 2 junction(s)" in text


def test_named_simulated_assets_are_labelled_simulated(nodes) -> None:
    for n in nodes.values():
        if "(simulated)" in n["name"] or n["system"] in ("power", "water", "underground"):
            assert n["provenance"]["category"] == "simulated", n["id"]
    for n in nodes.values():
        if n["system"] == "facility" or n["type"] == "transit_station" or n["id"] == "TEL-IX-56MARIETTA":
            assert n["properties"].get("modelled_figures") is True, n["id"]


def test_telecom_design(nodes, edges) -> None:
    t = {k: v for k, v in nodes.items() if v["system"] == "telecom"}
    cores = [k for k, v in t.items() if v["type"] == "internet_exchange"]
    assert "TEL-IX-56MARIETTA" in cores and len(cores) == 2
    assert t["TEL-IX-56MARIETTA"]["properties"]["backup_hours"] == 48
    fibre = [e for e in edges.values() if e["connection_type"] == "fiber_link"]
    assert all(e["capacity"] <= 400 for e in fibre)
    g = nx.Graph()
    g.add_edges_from((e["source_node"], e["target_node"]) for e in fibre)
    assert nx.edge_connectivity(g, cores[0], cores[1]) >= 2, "dual-homed core"
    cells = [v for v in t.values() if v["type"] in ("cell_site", "access_node")]
    assert 10 <= len(cells) <= 16
    degrees = Counter(g.degree(c["id"]) for c in cells)
    assert degrees[1] >= 3 and degrees[2] >= 3, "mix of single- and dual-homed sites"
    for c in (v for v in t.values() if v["type"] == "cell_site"):
        assert c["elevation"] == 35 and 2 <= c["properties"]["backup_hours"] <= 8
    rings = {e["properties"]["role"] for e in fibre}
    assert {"west", "east", "spur"} <= rings


def test_transport_design(nodes, edges) -> None:
    gateways = [n for n in nodes.values() if n["type"] == "gateway"]
    assert 5 <= len(gateways) <= 7 and all(g["properties"]["role"] == "gateway" for g in gateways)
    ints = [n for n in nodes.values() if n["type"] == "intersection"]
    signalised = [n for n in ints if n["properties"]["signalized"]]
    assert len(signalised) / len(ints) > 0.6
    for n in ints:
        if all(c in ("motorway", "motorway_link") for c in n["properties"]["street_classes"]):
            assert not n["properties"]["signalized"]
    roads = [e for e in edges.values() if e["connection_type"] == "road_segment"]
    for r in roads:
        p = r["properties"]
        assert r["capacity"] > 0 and p["speed_kph"] > 0 and p["lanes"] >= 1 and p["travel_time_s"] > 0
        assert r["depth_m"] == 0
    names = {r["properties"]["street"] for r in roads}
    for street in ("Peachtree St", "Marietta St", "Edgewood Ave", "Decatur St", "Auburn Ave", "Martin Luther King Jr Dr",
                   "Mitchell St", "Courtland St", "Piedmont Ave", "Jesse Hill Jr Dr", "Ted Turner Dr", "Spring St",
                   "Centennial Olympic Park Dr", "Northside Dr", "Andrew Young International Blvd", "North Ave",
                   "Downtown Connector (I-75/I-85)", "I-20"):  # fmt: skip
        assert street in names, street
    # rail lines cross at Five Points
    rails = [e for e in edges.values() if e["connection_type"] == "rail_segment"]
    deg = Counter()
    for e in rails:
        deg[e["source_node"]] += 1
        deg[e["target_node"]] += 1
    assert deg["TRN-STN-FIVEPOINTS"] == 4
    assert len(rails) == 8
    assert nodes["TRN-STN-PEACHTREECENTER"]["elevation"] <= -12
    for n in nodes.values():
        if n["type"] == "transit_station":
            assert deps_into(edges, n["id"], "power_supply") and deps_into(edges, n["id"], "telecom_link")
            assert deps_into(edges, n["id"], "road_access")


def test_facilities(nodes, edges) -> None:
    fac = [n for n in nodes.values() if n["system"] == "facility"]
    assert 10 <= len(fac) <= 14
    grady = nodes["FAC-GRADY"]
    assert grady["type"] == "hospital" and grady["critical"]
    assert grady["properties"]["backup_power_hours"] == 96 and grady["properties"]["water_storage_hours"] == 24
    feeds = deps_into(edges, "FAC-GRADY", "power_supply")
    assert len({nodes[e["source_node"]]["properties"]["substation"] for e in feeds}) == 2
    for f in fac:
        assert f["properties"]["occupancy"] > 0
        assert deps_into(edges, f["id"], "power_supply") and deps_into(edges, f["id"], "road_access")
        assert deps_into(edges, f["id"], "water_supply")
        if f["type"] in ("government", "emergency_services", "hospital"):
            assert f["critical"] and deps_into(edges, f["id"], "telecom_link")
        if f["type"] == "venue":
            assert f["properties"]["backup_power_hours"] <= 4 or f["id"] == "FAC-AQUARIUM"


def test_dependency_consumers_are_sensible(nodes, edges) -> None:
    counts: dict[str, Counter] = defaultdict(Counter)
    for e in edges.values():
        if e["relation"] != "dependency":
            continue
        counts[e["connection_type"]][nodes[e["target_node"]]["type"]] += 1
        assert e["directed"] and len(e["geometry"]) == 2
    assert counts["power_supply"]["intersection"] == sum(
        1 for n in nodes.values() if n["type"] == "intersection" and n["properties"]["signalized"]
    )
    assert counts["control_link"]["pump_station"] == 1 and counts["control_link"]["switch"] >= 5
    assert counts["water_supply"]["internet_exchange"] >= 1 and counts["water_supply"]["data_center"] == 1


# --------------------------------------------------------------------------- scenarios & demo


def test_presets(presets, nodes, edges) -> None:
    by_id = {p["id"]: p for p in presets}
    expected = {
        "A-DS-FIVEPOINTS": "power_failure",
        "B-EDGEWOOD-DUCTBANK": "corridor_strike",
        "C-WATER-MAIN-DECATUR": "water_rupture",
        "D-TELECOM-56MARIETTA": "telecom_outage",
        "E-ROADS-FIVEPOINTS": "road_disruption",
        "F-TS-SOUTH": "power_failure",
    }
    assert {k: by_id[k]["scenario_type"] for k in expected} == expected
    for p in presets:
        sc = p["scenario"]
        assert sc["horizon_hours"] == 4 and sc["enable_restoration"] is True
        assert sc["scenario_type"] == p["scenario_type"]
    assert by_id["A-DS-FIVEPOINTS"]["scenario"]["failed_nodes"] == ["PWR-DS-FIVEPOINTS"]
    assert by_id["B-EDGEWOOD-DUCTBANK"]["scenario"]["failed_edges"] == ["UGD-DB-06"]
    assert by_id["D-TELECOM-56MARIETTA"]["scenario"]["failed_nodes"] == ["TEL-IX-56MARIETTA"]
    assert by_id["F-TS-SOUTH"]["scenario"]["failed_nodes"] == ["PWR-TS-SOUTH"]
    water = by_id["C-WATER-MAIN-DECATUR"]["scenario"]["failed_edges"]
    assert len(water) == 1 and edges[water[0]]["connection_type"] == "water_main"
    roads = by_id["E-ROADS-FIVEPOINTS"]["scenario"]["failed_edges"]
    assert 2 <= len(roads) <= 4 and all(edges[r]["connection_type"] == "road_segment" for r in roads)
    hub = by_id["E-ROADS-FIVEPOINTS"]["focus_node_id"]
    assert nodes[hub]["name"].startswith("Five Points")
    assert all(hub in (edges[r]["source_node"], edges[r]["target_node"]) for r in roads)
    closed = by_id["E-ROADS-FIVEPOINTS"]["scenario"]["failed_nodes"]
    assert hub in closed and all(nodes[n]["type"] == "intersection" for n in closed)
    station_access = {e["source_node"] for e in deps_into(edges, "TRN-STN-FIVEPOINTS", "road_access")}
    assert station_access <= set(closed), "the cordon must cut Five Points station's street access"


def test_demo_script(demo, presets) -> None:
    actions = [s["action"] for s in demo["steps"]]
    assert actions == [
        "overview", "deep_mode", "reveal_layers", "select_node", "trace",
        "simulate", "cascade", "ask_ai", "simulate_b", "compare",
    ]  # fmt: skip
    assert demo["focus_node_id"] == "PWR-DS-FIVEPOINTS"
    assert demo["scenario_a_preset"] == "A-DS-FIVEPOINTS" and demo["scenario_b_preset"] == "B-EDGEWOOD-DUCTBANK"
    steps = {s["action"]: s for s in demo["steps"]}
    assert steps["select_node"]["node_id"] == "PWR-DS-FIVEPOINTS"
    assert steps["simulate"]["preset_id"] == "A-DS-FIVEPOINTS"
    assert steps["simulate_b"]["preset_id"] == "B-EDGEWOOD-DUCTBANK"
    assert steps["ask_ai"]["question"] == "Why did this happen, and what could we do differently?"
    for s in demo["steps"]:
        assert s["title"] and 40 <= len(s["narration"]) <= 400


def test_demo_trace_claims_hold(nodes, edges) -> None:
    """The 'trace' narration names assets that really hang off DS Five Points in the data."""

    def on_fivepoints(node_id: str) -> bool:
        return any(
            nodes[e["source_node"]]["properties"].get("substation") == "PWR-DS-FIVEPOINTS"
            for e in deps_into(edges, node_id, "power_supply")
        )

    for nid in ("WTR-PS-FAIRLIE", "TEL-IX-56MARIETTA", "FAC-CITYHALL", "TRN-STN-FIVEPOINTS"):
        assert on_fivepoints(nid), nid
    signals = [n for n in nodes.values() if n["type"] == "intersection" and on_fivepoints(n["id"])]
    assert len(signals) >= 20
