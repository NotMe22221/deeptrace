"""Deterministic generator for a DEEPTRACE region network.

Usage (from ``backend/``)::

    python -m app.networks.generate [--region atlanta-downtown] [--use-osm] [--generated-at ISO]

Inputs (all in ``datasets/regions/<region>/``):

* ``region.json``    RegionInfo
* ``streets.json``   authored street centrelines (ESTIMATED), replaced by OSM roads with ``--use-osm``
* ``landmarks.json`` real public places with approximate positions (ESTIMATED) + rail alignments
* ``design.json``    the illustrative infrastructure design (SIMULATED): substations, feeders,
  ties, mains, valves, fibre rings, cell sites, duct banks, facility profiles, scenarios, demo

Outputs: ``network.json``, ``scenarios.json``, ``demo.json`` in the region folder, and a copy
of ``network.json`` in ``public/demo/`` for the frontend's offline mode.

The generator uses no randomness: variation (e.g. vault loads) comes from stable hashes of
ids, and ``generated_at`` is fixed, so the output is byte-identical across runs.

Physical utility edges are routed along the street graph (shortest path over surface
streets between the endpoints' street anchors) with a fixed lateral offset per system,
so cables and pipes follow streets. Dependency edges are straight provider -> consumer
lines for display.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import CACHE_DIR, PUBLIC_DEMO_DIR, REGIONS_DIR
from app.models.schemas import DemoScript, InfrastructureNetwork, RegionInfo, ScenarioPreset
from app.networks import geo
from app.networks.streetgraph import HIGHWAY_CLASSES, Access, StreetGraph, build_street_graph

GENERATOR_VERSION = "1.0.0"
DEFAULT_GENERATED_AT = "2026-10-31T00:00:00Z"

SIM_SOURCE = "DEEPTRACE illustrative infrastructure generator"
SIM_NOTE = (
    "Illustrative asset generated for modelling; it does NOT describe a real utility asset at this location. "
    "Confidence describes how likely this is to match reality (very low by design)."
)
SIM_DEP_NOTE = (
    "Modelled service dependency (SIMULATED). It illustrates a plausible relationship and is not "
    "a documented connection."
)

# Lateral offset (m) from the street centreline per system: positive = left of the
# street edge's canonical direction. Keeps each system on a consistent side of the street.
ROUTE_OFFSET_M = {"power": 4.5, "telecom": 6.5, "water": -5.0, "underground": 5.5}
# Offset (dx east, dy north, metres) of street-anchored assets from the intersection centre.
NODE_OFFSET_M = {"power": (7.0, 7.0), "water": (-7.0, -7.0), "telecom": (7.0, -7.0), "underground": (-7.0, 7.0)}

_STREET_SUFFIXES = {
    "st", "street", "ave", "avenue", "av", "dr", "drive", "blvd", "boulevard", "bv", "rd", "road", "pl", "place",
    "way", "pkwy", "parkway", "ln", "lane", "ct", "court", "ter", "terrace", "sq", "square", "cir", "circle",
    "hwy", "highway", "nw", "ne", "sw", "se", "n", "s", "e", "w", "northwest", "northeast", "southwest",
    "southeast", "jr", "junior",
}  # fmt: skip


# Which normalised OSM point kinds (app.ingest.normalize.classify_point) may stand for a
# landmark of a given kind. Landmark kinds not listed are never matched (e.g. commercial).
LANDMARK_OSM_KINDS: dict[str, frozenset[str]] = {
    "transit_station": frozenset({"station"}),
    "hospital": frozenset({"hospital"}),
    "government": frozenset({"townhall", "courthouse", "government"}),
    "emergency_services": frozenset({"police", "fire_station"}),
    "university": frozenset({"university"}),
    "venue": frozenset({"stadium", "sports_centre", "park", "aquarium", "named_feature"}),
    "internet_exchange": frozenset({"data_center", "telecom_exchange", "telecom", "named_feature"}),
}

# Mirrors app.simulation.power.EMERGENCY_LIMIT (a test keeps them in sync): a line loaded above
# this multiple of its rating trips.
EMERGENCY_LIMIT = 1.2


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def street_key(name: str) -> str:
    """Normalised street name for matching ('Peachtree Street Northeast' -> 'peachtree')."""
    tokens = re.sub(r"[^a-z0-9 ]+", " ", name.lower()).split()
    kept = [t for t in tokens if t not in _STREET_SUFFIXES]
    return " ".join(kept) or " ".join(tokens)


def stable_unit(key: str) -> float:
    """Deterministic pseudo-random number in [0, 1) derived from ``key``."""
    return int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:12], 16) / float(16**12)


def latlon(pair: Sequence[float]) -> tuple[float, float]:
    """Design files give ``[lat, lon]``; convert to the contract's ``(lon, lat)``."""
    return (float(pair[1]), float(pair[0]))


def r6(p: Sequence[float]) -> tuple[float, float]:
    return (round(float(p[0]), 6), round(float(p[1]), 6))


def sim_prov(notes: str | None = None, confidence: float = 0.1) -> dict[str, Any]:
    return {
        "category": "simulated",
        "source": SIM_SOURCE,
        "source_url": None,
        "confidence": confidence,
        "retrieved_at": None,
        "license": "CC0-1.0 (generated)",
        "notes": notes or SIM_NOTE,
    }


@dataclass
class RegionInputs:
    region: RegionInfo
    streets: list[dict[str, Any]]
    landmarks: dict[str, Any]
    design: dict[str, Any]
    osm: dict[str, Any] | None
    street_source: str  # "authored" | "osm"


def load_inputs(region_dir: Path, *, use_osm: bool = False, osm_cache: Path | None = None) -> RegionInputs:
    region = RegionInfo.model_validate_json((region_dir / "region.json").read_text())
    landmarks = json.loads((region_dir / "landmarks.json").read_text())
    design = json.loads((region_dir / "design.json").read_text())
    osm = None
    if use_osm:
        from app.ingest.normalize import load_raw, normalize_overpass

        path = osm_cache or (CACHE_DIR / "osm" / f"{region.id}.json")
        if not path.exists():
            raise FileNotFoundError(
                f"OSM cache {path} not found. Fetch it first with: python -m app.ingest.overpass --region {region.id}"
            )
        osm = normalize_overpass(load_raw(path), region.bbox)
        if not osm["streets"]:
            raise ValueError(f"OSM cache {path} contains no usable road ways inside the region bbox")
        streets = osm["streets"]
        source = "osm"
    else:
        streets = json.loads((region_dir / "streets.json").read_text())["features"]
        source = "authored"
    return RegionInputs(region, streets, landmarks, design, osm, source)


class NetworkBuilder:
    """Builds the network dict from region inputs. Use :meth:`build`."""

    def __init__(self, inputs: RegionInputs, generated_at: str = DEFAULT_GENERATED_AT):
        self.inp = inputs
        self.region = inputs.region
        self.design = inputs.design
        self.generated_at = generated_at
        center = (self.region.center[1], self.region.center[0])
        self.proj = geo.LocalProjection(*center)
        self.sg: StreetGraph = build_street_graph(inputs.streets, center=center)
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: dict[str, dict[str, Any]] = {}
        self.anchor: dict[str, str] = {}  # node id -> street node id used for routing
        self.street_paths: dict[str, list[str]] = {}  # physical edge id -> street edge ids
        self.used: dict[str, set[str]] = defaultdict(set)  # system -> street nodes already hosting an asset
        self.counters: Counter[str] = Counter()
        self.feeder_vaults: dict[str, list[str]] = {}
        self.landmarks = {lm["id"]: lm for lm in inputs.landmarks.get("landmarks", [])}
        self.street_node_to_trn: dict[str, str] = {}
        self.warnings: list[str] = []
        self.osm_points_used: set[str] = set()
        self.asset_osm_matches = 0  # simulated assets positioned at a mapped OSM feature (location only)
        self.landmark_osm_ids: set[str] = set()  # landmarks whose position came from OSM
        self.site_nodes: set[str] = set()  # off-street nodes free to join the street graph at any nearby node
        self.place_names: dict[str, str] = {}  # street node -> well-known place name (e.g. "Five Points")
        self._sp_cache: dict[str, dict[str, float]] = {}
        self._access_cache: dict[tuple[str, float], list[Access]] = {}
        self._street_keys = {nid: {street_key(n) for n in node.names} for nid, node in self.sg.nodes.items()}

    # ------------------------------------------------------------------ helpers

    def next_id(self, prefix: str, width: int) -> str:
        self.counters[prefix] += 1
        return f"{prefix}{self.counters[prefix]:0{width}d}"

    def pos(self, node_id: str) -> tuple[float, float]:
        n = self.nodes[node_id]
        return (n["longitude"], n["latitude"])

    def resolve_anchor(self, spec: dict[str, Any] | str, *, avoid: set[str] | None = None) -> str:
        """Street node for an anchor spec ``{"at": "A & B", "near": [lat, lon]}``."""
        if isinstance(spec, str):
            spec = {"at": spec}
        avoid = avoid or set()
        near = latlon(spec["near"]) if spec.get("near") else None
        candidates: list[str] = []
        if spec.get("at"):
            keys = [street_key(p) for p in str(spec["at"]).split("&")]
            for nid in self.sg.surface_graph.nodes:
                if all(k in self._street_keys[nid] for k in keys):
                    candidates.append(nid)
            if near is not None:
                candidates = [c for c in candidates if geo.haversine_m(near, self.sg.nodes[c].point) <= 400]
        if candidates:
            free = [c for c in candidates if c not in avoid] or candidates
            if near is None:
                return sorted(free)[0]
            return min(free, key=lambda c: (round(geo.haversine_m(near, self.sg.nodes[c].point), 3), c))
        if near is None:
            raise ValueError(f"Cannot resolve anchor {spec}: no matching intersection and no 'near' fallback")
        nid = self.sg.nearest_node(near, exclude=avoid) or self.sg.nearest_node(near)
        if nid is None:
            raise ValueError(f"Cannot resolve anchor {spec}")
        if spec.get("at"):
            self.warnings.append(f"anchor '{spec['at']}' not found by name; snapped to nearest street node")
        return nid

    def placed_point(self, street_node: str, system: str) -> tuple[float, float]:
        dx, dy = NODE_OFFSET_M[system]
        return self.proj.offset(self.sg.nodes[street_node].point, dx, dy)

    def add_node(
        self,
        node_id: str,
        name: str,
        system: str,
        ntype: str,
        point: Sequence[float],
        provenance: dict[str, Any],
        *,
        anchor: str | None = None,
        elevation: float = 0.0,
        capacity: float | None = None,
        capacity_unit: str | None = None,
        demand: float | None = None,
        critical: bool = False,
        description: str | None = None,
        properties: dict[str, Any] | None = None,
        location: dict[str, Any] | None = None,
    ) -> str:
        if node_id in self.nodes:
            raise ValueError(f"duplicate node id {node_id}")
        properties = {**(properties or {}), **(location or {})}
        lon, lat = r6(point)
        self.nodes[node_id] = {
            "id": node_id,
            "name": name,
            "system": system,
            "type": ntype,
            "latitude": lat,
            "longitude": lon,
            "elevation": elevation,
            "status": "operational",
            "provenance": provenance,
            "capacity": capacity,
            "capacity_unit": capacity_unit,
            "demand": demand,
            "critical": critical,
            "description": description,
            "properties": properties or {},
        }
        if anchor is None:
            self.site_nodes.add(node_id)
        self.anchor[node_id] = anchor or self.sg.nearest_node((lon, lat)) or ""
        return node_id

    def street_label(self, street_node: str) -> str:
        """Intersection label, preferring a well-known place name when one is configured."""
        label = self.sg.node_label(street_node)
        place = self.place_names.get(street_node)
        return f"{place} ({label})" if place else label

    def short_label(self, street_node: str) -> str:
        return self.place_names.get(street_node) or self.sg.node_label(street_node)

    def add_edge(
        self,
        edge_id: str,
        source: str,
        target: str,
        system: str,
        ctype: str,
        geometry: Sequence[Sequence[float]],
        provenance: dict[str, Any],
        *,
        relation: str = "physical",
        street_path: list[str] | None = None,
        capacity: float | None = None,
        capacity_unit: str | None = None,
        depth: float = 0.0,
        directed: bool = False,
        status: str = "operational",
        name: str | None = None,
        properties: dict[str, Any] | None = None,
    ) -> str:
        if edge_id in self.edges:
            raise ValueError(f"duplicate edge id {edge_id}")
        geom = geo.dedupe_consecutive(geometry, tolerance_m=0.3)
        if len(geom) < 2:
            geom = [tuple(self.pos(source)), tuple(self.pos(target))]
        geom = [r6(p) for p in geom]
        self.edges[edge_id] = {
            "id": edge_id,
            "source_node": source,
            "target_node": target,
            "infrastructure_type": system,
            "connection_type": ctype,
            "relation": relation,
            "directed": directed,
            "capacity": capacity,
            "capacity_unit": capacity_unit,
            "length_m": round(geo.polyline_length_m(geom), 1),
            "status": status,
            "depth_m": depth,
            "geometry": geom,
            "corridor_id": None,
            "provenance": provenance,
            "name": name,
            "properties": properties or {},
        }
        if street_path is not None:
            self.street_paths[edge_id] = street_path
        return edge_id

    def _path_lengths(self, src: str) -> dict[str, float]:
        if src not in self._sp_cache:
            import networkx as nx

            g = self.sg.surface_graph
            self._sp_cache[src] = nx.single_source_dijkstra_path_length(g, src, weight="length") if src in g else {src: 0.0}
        return self._sp_cache[src]

    def _access(self, node_id: str, offset: float) -> list[Access]:
        key = (node_id, offset)
        if key not in self._access_cache:
            if node_id in self.site_nodes:
                self._access_cache[key] = self.sg.access_options(self.pos(node_id), offset_m=offset)
            else:
                self._access_cache[key] = [Access(self.anchor[node_id], 0.0, [self.pos(node_id)])]
        return self._access_cache[key]

    def route(self, a: str, b: str, system: str) -> tuple[list[tuple[float, float]], list[str]]:
        """Route a utility edge along surface streets.

        Street-anchored nodes join at their intersection; off-street sites join through a short
        service drop onto one of their nearest street edges. The cheapest combination wins.
        Returns ``(geometry, street_edge_ids)``; the street edge ids feed corridor hosting.
        """
        off = ROUTE_OFFSET_M[system]
        best: tuple[tuple[Any, ...], Access, Access, bool] | None = None
        for oa in self._access(a, off):
            lengths = self._path_lengths(oa.node)
            for ob in self._access(b, off):
                if ob.node in lengths:
                    key = (round(oa.cost + lengths[ob.node] + ob.cost, 3), 0, oa.node, ob.node)
                    if best is None or key < best[0]:
                        best = (key, oa, ob, False)
                if oa.edge is not None and oa.edge == ob.edge:  # both drops land on the same street edge
                    direct = 1.5 * (oa.dist + ob.dist) + abs(oa.along - ob.along)
                    key = (round(direct, 3), 1, oa.edge, "")
                    if best is None or key < best[0]:
                        best = (key, oa, ob, True)
        if best is None:
            geom, _, epath = self.sg.route(self.pos(a), self.pos(b), offset_m=off, a_node=self.anchor[a], b_node=self.anchor[b])
            return geom, epath
        _, oa, ob, direct = best
        if direct:
            assert oa.edge is not None
            edge_geom = self.sg.edge_geometry(oa.edge, self.sg.edges[oa.edge].u, off)
            piece = geo.substring(edge_geom, min(oa.along, ob.along), max(oa.along, ob.along))
            if oa.along > ob.along:
                piece = list(reversed(piece))
            geom = [self.pos(a)] + piece + [self.pos(b)]
            span = abs(oa.along - ob.along)
            epath = [oa.edge] if span >= 0.5 * self.sg.edges[oa.edge].length_m else []
        else:
            npath, epath = self.sg.shortest_path(oa.node, ob.node)
            middle = self.sg.path_geometry(npath, epath, off) if epath else []
            geom = oa.geometry + middle + list(reversed(ob.geometry))
            epath = list(epath)
            for acc in (oa, ob):  # count access stretches that run along most of a street block
                if acc.edge and acc.traversed >= 0.5 * self.sg.edges[acc.edge].length_m and acc.edge not in epath:
                    epath.append(acc.edge)
        return geo.dedupe_consecutive(geom, tolerance_m=0.3), epath

    def add_routed_edge(self, edge_id: str, a: str, b: str, system: str, ctype: str, **kw: Any) -> str:
        geom, epath = self.route(a, b, system)
        return self.add_edge(edge_id, a, b, system, ctype, geom, kw.pop("provenance", sim_prov()), street_path=epath, **kw)

    def split_with_node(
        self, geom: list[tuple[float, float]], fraction: float = 0.5
    ) -> tuple[tuple[float, float], list[tuple[float, float]], list[tuple[float, float]]]:
        total = geo.polyline_length_m(geom)
        first, second = geo.split_polyline_at(geom, total * fraction)
        return first[-1], first, second

    def osm_site(self, kinds: set[str], point: tuple[float, float], max_m: float) -> dict[str, Any] | None:
        """Nearest unused OSM candidate point of one of ``kinds`` within ``max_m``."""
        if not self.inp.osm:
            return None
        best = None
        for p in self.inp.osm["points"]:
            if p["kind"] not in kinds or p["osm_id"] in self.osm_points_used:
                continue
            d = geo.haversine_m(point, (p["lon"], p["lat"]))
            if d <= max_m and (best is None or (d, p["osm_id"]) < best[0]):
                best = ((d, p["osm_id"]), p)
        if best is None:
            return None
        self.osm_points_used.add(best[1]["osm_id"])
        return best[1]

    def site_and_provenance(
        self, site: Sequence[float], kinds: set[str], role: str, max_m: float = 600.0
    ) -> tuple[tuple[float, float], dict[str, Any], dict[str, Any]]:
        """Position a simulated asset; with OSM data, snap it to a mapped feature of a plausible kind.

        The asset stays SIMULATED: only its *location* comes from the mapped feature, which is
        recorded in the provenance notes / ``source_url`` and in ``properties.location_source``.
        Returns ``(point, provenance, extra_properties)``.
        """
        point = latlon(site)
        match = self.osm_site(kinds, point, max_m) if kinds else None
        if match is None:
            return point, sim_prov(), {}
        from app.ingest.normalize import osm_url

        self.asset_osm_matches += 1
        label = match.get("name") or match["kind"].replace("_", " ")
        prov = sim_prov(
            f"Illustrative asset. LOCATION ONLY snapped to OpenStreetMap feature {match['osm_id']} ('{label}', "
            f"\u00a9 OpenStreetMap contributors, ODbL). Its modelled role ({role}), capacity and every connection are "
            "SIMULATED - the mapped feature is not known to play this role.",
            confidence=0.15,
        )
        prov["source_url"] = osm_url(match["osm_type"], match["osm_numeric_id"])
        prov["retrieved_at"] = (self.inp.osm or {}).get("meta", {}).get("retrieved_at")
        extra = {"location_source": f"OpenStreetMap {match['osm_id']}", "location_source_name": label}
        return (match["lon"], match["lat"]), prov, extra

    def landmark_position(self, lm: dict[str, Any]) -> tuple[tuple[float, float], dict[str, Any]]:
        """Landmark position + provenance (ESTIMATED, or PUBLICLY_MAPPED when matched in OSM)."""
        prov = {
            "category": "estimated",
            "source": "General public knowledge",
            "source_url": None,
            "confidence": 0.6,
            "retrieved_at": None,
            "license": None,
            "notes": "Approximate position from general public knowledge; not surveyed.",
        }
        prov.update(lm.get("provenance") or {})
        point = (float(lm["lon"]), float(lm["lat"]))
        osm = self.inp.osm
        match_spec = lm.get("osm_match")
        if osm and match_spec and match_spec.get("name"):
            from app.ingest.normalize import normalize_name, osm_provenance

            want = normalize_name(match_spec["name"])
            tags_req = match_spec.get("tags") or {}
            allowed = LANDMARK_OSM_KINDS.get(lm.get("kind"), frozenset())
            best = None
            for p in osm["points"]:
                if p["osm_id"] in self.osm_points_used or p["kind"] not in allowed:
                    continue
                if any(p["tags"].get(k) != v for k, v in tags_req.items()):
                    continue
                if want not in normalize_name(p.get("name")):
                    continue
                d = geo.haversine_m(point, (p["lon"], p["lat"]))
                if d <= 800 and (best is None or (d, p["osm_id"]) < best[0]):
                    best = ((d, p["osm_id"]), p)
            if best is None:
                self.warnings.append(f"landmark {lm['id']} ('{match_spec['name']}') not matched in the OSM cache; position stays ESTIMATED")
            else:
                p = best[1]
                self.osm_points_used.add(p["osm_id"])
                self.landmark_osm_ids.add(lm["id"])
                point = (p["lon"], p["lat"])
                prov = osm_provenance(
                    p["osm_type"],
                    p["osm_numeric_id"],
                    osm["meta"].get("retrieved_at"),
                    0.85,
                    f"Position from OpenStreetMap feature {p['osm_id']} ('{p.get('name')}'), © OpenStreetMap contributors (ODbL).",
                )
        return point, prov

    # ------------------------------------------------------------------ systems

    def build_transport(self) -> None:
        tdesign = self.design.get("transport", {})
        sg = self.sg
        authored = self.inp.street_source == "authored"
        lane_cap = tdesign.get("lane_capacity_vph", {})
        unsig_share = float(tdesign.get("unsignalized_share", 0.15))
        sig_backup = tdesign.get("signal_backup_hours", {})

        for place in tdesign.get("named_places", []):
            self.place_names[self.resolve_anchor(place)] = place["name"]

        # Gateways replace selected street nodes.
        gateway_for: dict[str, dict[str, Any]] = {}
        for gw in tdesign.get("gateways", []):
            sid = sg.nearest_node(latlon(gw["near"]), surface_only=False, exclude=set(gateway_for))
            if sid is None:
                self.warnings.append(f"gateway {gw['id']} could not be placed")
                continue
            gateway_for[sid] = gw

        def street_prov(conf: float, what: str) -> dict[str, Any]:
            if authored:
                return {
                    "category": "estimated",
                    "source": "Derived from DEEPTRACE authored street centrelines",
                    "source_url": None,
                    "confidence": conf,
                    "retrieved_at": None,
                    "license": None,
                    "notes": f"{what} computed from approximate, authored street alignments; may be tens of metres off.",
                }
            meta = (self.inp.osm or {}).get("meta", {})
            return {
                "category": "publicly_mapped",
                "source": "Derived from OpenStreetMap road geometry (Overpass API)",
                "source_url": "https://www.openstreetmap.org/copyright",
                "confidence": 0.8,
                "retrieved_at": meta.get("retrieved_at"),
                "license": "ODbL-1.0",
                "notes": f"{what} computed from OpenStreetMap ways (© OpenStreetMap contributors, ODbL).",
            }

        for sid in sorted(sg.nodes):
            sn = sg.nodes[sid]
            classes = set(sn.classes)
            highway_only = classes <= HIGHWAY_CLASSES
            if sid in gateway_for:
                gw = gateway_for[sid]
                nid = gw["id"]
                self.add_node(
                    nid,
                    gw["name"],
                    "transport",
                    "gateway",
                    sn.point,
                    street_prov(0.45 if authored else 0.8, "Gateway position"),
                    anchor=sid,
                    description=f"District entry/exit used for origin-destination analysis ({gw.get('connects_to', '')}).",
                    properties={"role": "gateway", "connects_to": gw.get("connects_to"), "streets": sn.names, "signalized": False},
                )
            else:
                nid = self.next_id("TRN-INT-", 4)
                tertiary_only = classes <= {"tertiary", "unclassified", "residential"}
                signalized = (
                    sn.degree >= 3
                    and not highway_only
                    and not (tertiary_only and stable_unit(f"signal:{nid}") < unsig_share * 2.5)
                )
                backup = 0.0
                if signalized:
                    best_class = min(classes - HIGHWAY_CLASSES, key=lambda c: {"primary": 0, "secondary": 1}.get(c, 2))
                    backup = float(sig_backup.get(best_class, sig_backup.get("default", 0)))
                label = self.street_label(sid)
                props: dict[str, Any] = {
                    "signalized": signalized,
                    "streets": sn.names,
                    "street_classes": sn.classes,
                    "control": "traffic signal" if signalized else ("grade-separated" if highway_only else "stop/yield or none"),
                }
                if signalized:
                    props["backup_hours"] = backup
                self.add_node(
                    nid,
                    label,
                    "transport",
                    "intersection",
                    sn.point,
                    street_prov(0.45 if authored else 0.8, "Intersection position"),
                    anchor=sid,
                    description=("Signalised intersection" if signalized else "Unsignalised junction") + f": {label}.",
                    properties=props,
                )
            self.street_node_to_trn[sid] = nid

        def cross(sid: str, street: str) -> str:
            if sid in self.place_names:
                return self.place_names[sid]
            others = [n for n in sg.nodes[sid].names if n != street]
            return others[0] if others else "end"

        for eid in sorted(sg.edges):
            se = sg.edges[eid]
            u, v = self.street_node_to_trn[se.u], self.street_node_to_trn[se.v]
            lanes = int(se.lanes or 2)
            speed = float(se.speed_kph or 40)
            cap = lanes * float(lane_cap.get(se.cls, lane_cap.get(se.cls.replace("_link", ""), 600)))
            name = f"{se.name}: {cross(se.u, se.name)} \u2192 {cross(se.v, se.name)}"
            prov = dict(se.provenance) if se.provenance else street_prov(0.45, "Road segment")
            self.add_edge(
                self.next_id("TRN-RD-", 4),
                u,
                v,
                "transport",
                "road_segment",
                se.geometry,
                prov,
                capacity=round(cap),
                capacity_unit="veh/h",
                name=name,
                properties={
                    "street": se.name,
                    "class": se.cls,
                    "lanes": lanes,
                    "speed_kph": speed,
                    "oneway": bool(se.oneway),
                    "travel_time_s": round(se.length_m / (speed / 3.6), 1),
                    "street_feature_id": se.feature_id,
                },
            )

        # Rail: stations from landmarks, segments along authored alignments.
        station_ids: dict[str, str] = {}
        for lm_id, lm in self.landmarks.items():
            if lm.get("kind") != "transit_station":
                continue
            point, prov = self.landmark_position(lm)
            nid = f"TRN-STN-{lm_id}"
            props = dict(lm.get("properties") or {})
            props.update({"backup_hours": 0, "power": "traction & station power (modelled)", "modelled_figures": True})
            elevation = float(lm.get("elevation_m", 0.0))
            self.add_node(
                nid,
                f"{lm['name']} station (MARTA)",
                "transport",
                "transit_station",
                point,
                prov,
                elevation=elevation,
                description=f"MARTA rail station (real; position approximate). Platform level {elevation:+.0f} m (low-confidence estimate).",
                properties=props,
            )
            station_ids[lm_id] = nid

        for line in self.inp.landmarks.get("rail_lines", []):
            align = [(float(c[0]), float(c[1])) for c in line["alignment"]]
            stations = [s for s in line["stations"] if s in station_ids]
            depths = line.get("segment_depths_m", [])
            prov = dict(line.get("provenance") or {})
            prov.setdefault("category", "estimated")
            prov.setdefault("source", "Authored approximate alignment")
            prov.setdefault("confidence", 0.4)
            for i in range(len(stations) - 1):
                a, b = station_ids[stations[i]], station_ids[stations[i + 1]]
                pa, pb = self.pos(a), self.pos(b)
                _, _, along_a = geo.nearest_point_on_polyline(pa, align, self.proj)
                _, _, along_b = geo.nearest_point_on_polyline(pb, align, self.proj)
                piece = geo.substring(align, along_a, along_b)
                if along_b < along_a:
                    piece = list(reversed(piece))
                geom = [pa] + piece[1:-1] + [pb]
                length = geo.polyline_length_m(geom)
                depth = float(depths[i]) if i < len(depths) else 10.0
                self.add_edge(
                    f"TRN-RL-{line['id']}-{i + 1:02d}",
                    a,
                    b,
                    "transport",
                    "rail_segment",
                    geom,
                    prov,
                    capacity=float(line.get("capacity_riders_per_h", 10000)),
                    capacity_unit="riders/h",
                    depth=depth,
                    name=f"{line['name']}: {self.nodes[a]['name'].replace(' station (MARTA)', '')} → "
                    f"{self.nodes[b]['name'].replace(' station (MARTA)', '')}",
                    properties={
                        "line": line["name"],
                        "travel_time_s": round(length / (45 / 3.6) + 30, 1),
                        "depth_confidence": "low",
                        "alignment": "approximate",
                    },
                )

    def build_power(self) -> None:
        pd = self.design["power"]
        ds_meta: dict[str, dict[str, Any]] = {}
        for ts in pd["transmission_substations"]:
            point, prov, loc = self.site_and_provenance(ts["site"], {"substation"}, "transmission bulk supply point")
            self.add_node(
                ts["id"],
                ts["name"],
                "power",
                "transmission_substation",
                point,
                prov,
                location=loc,
                capacity=float(ts["capacity_mw"]),
                capacity_unit="MW",
                description="Bulk supply point where 115 kV transmission enters the district (simulated source).",
                properties={"voltage_kv": 115, "role": "source"},
            )
        for ds in pd["distribution_substations"]:
            point, prov, loc = self.site_and_provenance(ds["site"], {"substation"}, "distribution substation")
            ds_meta[ds["id"]] = ds
            self.add_node(
                ds["id"],
                f"{ds['label']} (simulated)",
                "power",
                "distribution_substation",
                point,
                prov,
                location=loc,
                capacity=float(ds["capacity_mw"]),
                capacity_unit="MW",
                description=f"Distribution substation stepping 115 kV down to 12.47 kV radial feeders ({ds['label']}, simulated).",
                properties={"label": ds["label"], "voltage_kv": "115/12.47", "load_factor": ds["load_factor"], "feeders": []},
            )

        for i, tl in enumerate(pd["transmission_lines"], start=1):
            a, b = tl["from"], tl["to"]
            self.add_routed_edge(
                f"PWR-TL-{i:02d}",
                a,
                b,
                "power",
                "transmission_line",
                capacity=float(tl["capacity_mw"]),
                capacity_unit="MW",
                depth=1.8,
                name=f"TL-{i:02d} {self.nodes[a]['name'].split(' (')[0]} → {self.nodes[b]['name'].split(' (')[0]} (115 kV, simulated)",
                properties={"voltage_kv": 115, "role": tl.get("role", "primary"), "construction": "underground cable (assumed)"},
            )

        # Feeders: substation -> sectionalising switch -> vault -> vault ...
        feeder_specs = pd["feeders"]
        vault_specs: list[tuple[str, int, dict[str, Any]]] = []
        for f in feeder_specs:
            for k, v in enumerate(f["vaults"], start=1):
                vault_specs.append((f["id"], k, v))

        # Deterministic load allocation per substation.
        weights: dict[tuple[str, int], float] = {}
        per_ds: dict[str, list[tuple[str, int]]] = defaultdict(list)
        feeder_ds = {f["id"]: f["substation"] for f in feeder_specs}
        for fid, k, _ in vault_specs:
            weights[(fid, k)] = 0.9 + 0.2 * stable_unit(f"load:{fid}:{k}")
            per_ds[feeder_ds[fid]].append((fid, k))
        demand: dict[tuple[str, int], float] = {}
        for ds_id, keys in per_ds.items():
            meta = ds_meta[ds_id]
            target = float(meta["capacity_mw"]) * float(meta["load_factor"])
            total_w = sum(weights[k] for k in keys)
            for key in keys:
                demand[key] = round(target * weights[key] / total_w, 2)
        ppm = float(pd.get("population_per_mw", 1000))

        for f in feeder_specs:
            fid, ds_id = f["id"], f["substation"]
            ds_label = ds_meta[ds_id]["label"]
            sw_anchor = self.resolve_anchor(f["switch"], avoid=self.used["power"])
            self.used["power"].add(sw_anchor)
            sw_id = f"PWR-SW-{fid.replace('-', '')}"
            self.add_node(
                sw_id,
                f"Feeder {fid} head switch (simulated)",
                "power",
                "switch",
                self.placed_point(sw_anchor, "power"),
                sim_prov(),
                anchor=sw_anchor,
                elevation=-2.0,
                capacity=float(f["capacity_mw"]),
                capacity_unit="MW",
                description=f"Sectionalising switch at the head of feeder {fid} from {ds_label} (normally closed, simulated).",
                properties={"normally_open": False, "role": "sectionalizing", "feeder": fid, "substation": ds_id},
            )
            self.nodes[ds_id]["properties"]["feeders"].append(fid)
            chain = [ds_id, sw_id]
            vault_ids: list[str] = []
            for k, vspec in enumerate(f["vaults"], start=1):
                anchor = self.resolve_anchor(vspec, avoid=self.used["power"])
                self.used["power"].add(anchor)
                vid = self.next_id("PWR-NV-", 3)
                d = demand[(fid, k)]
                pop = int(round(d * ppm * (0.8 + 0.4 * stable_unit(f"pop:{vid}")), -1))
                cross = self.short_label(anchor)
                self.add_node(
                    vid,
                    f"Vault {vid[-3:]} {cross} (simulated)",
                    "power",
                    "network_vault",
                    self.placed_point(anchor, "power"),
                    sim_prov(),
                    anchor=anchor,
                    elevation=-3.0,
                    capacity=float(max(2.5, math.ceil(d * 1.4 * 2) / 2)),
                    capacity_unit="MW",
                    demand=d,
                    description=f"Underground network transformer vault on feeder {fid} ({ds_label}); load {d:.2f} MW (modelled).",
                    properties={
                        "feeder": fid,
                        "substation": ds_id,
                        "position_on_feeder": k,
                        "population_served": pop,
                        "population_basis": "modelled daytime population",
                    },
                )
                vault_ids.append(vid)
                chain.append(vid)
            self.feeder_vaults[fid] = vault_ids
            for i in range(len(chain) - 1):
                a, b = chain[i], chain[i + 1]
                self.add_routed_edge(
                    self.next_id("PWR-FDR-", 4),
                    a,
                    b,
                    "power",
                    "feeder_cable",
                    capacity=float(f["capacity_mw"]),
                    capacity_unit="MW",
                    depth=1.5,
                    name=f"Feeder {fid} section {i + 1} (12.47 kV, simulated)",
                    properties={"feeder": fid, "substation": ds_id, "section": i + 1, "voltage_kv": 12.47},
                )
            self.nodes[ds_id]["demand"] = round(sum(self.nodes[v]["demand"] for v in vault_ids) + (self.nodes[ds_id]["demand"] or 0), 2)

        for tie in pd.get("ties", []):
            a = self.feeder_ref(tie["a"])
            b = self.feeder_ref(tie["b"])
            geom, epath = self.route(a, b, "power")
            mid, first, second = self.split_with_node(geom)
            tid = tie["id"]
            sw_id = f"PWR-SW-TIE{tid}"
            fa, fb = self.nodes[a]["properties"]["feeder"], self.nodes[b]["properties"]["feeder"]
            self.add_node(
                sw_id,
                f"Tie switch {tid} {fa} ↔ {fb} (simulated)",
                "power",
                "switch",
                mid,
                sim_prov(),
                elevation=-2.0,
                capacity=float(tie["capacity_mw"]),
                capacity_unit="MW",
                description=(
                    f"Normally-open tie between feeder {fa} and feeder {fb} (different substations). "
                    f"Closing it can pick up at most {tie['capacity_mw']} MW. Remote closing needs SCADA comms; "
                    f"otherwise a crew switches manually after ~{tie['manual_switch_hours']} h (simulated)."
                ),
                properties={
                    "normally_open": True,
                    "role": "tie",
                    "feeders": [fa, fb],
                    "substations": [self.nodes[a]["properties"]["substation"], self.nodes[b]["properties"]["substation"]],
                    "tie_capacity_mw": float(tie["capacity_mw"]),
                    "manual_switch_hours": float(tie["manual_switch_hours"]),
                    "remote_control": True,
                },
            )
            for suffix, (src, dst, g) in (("A", (a, sw_id, first)), ("B", (sw_id, b, second))):
                self.add_edge(
                    f"PWR-TIE-{tid}{suffix}",
                    src,
                    dst,
                    "power",
                    "tie_line",
                    g,
                    sim_prov(),
                    street_path=epath,
                    capacity=float(tie["capacity_mw"]),
                    capacity_unit="MW",
                    depth=1.5,
                    status="normally_open",
                    name=f"Tie {tid} {fa} ↔ {fb} ({suffix}, normally open, simulated)",
                    properties={"tie_switch_id": sw_id, "feeders": [fa, fb], "voltage_kv": 12.47},
                )

    def feeder_ref(self, ref: str) -> str:
        """Resolve 'FP-1:3' to the third vault of feeder FP-1 (ids pass through unchanged)."""
        if ":" in ref:
            fid, k = ref.rsplit(":", 1)
            return self.feeder_vaults[fid][int(k) - 1]
        return ref

    def build_water(self) -> None:
        wd = self.design["water"]
        for s in wd["sources"]:
            point, prov, loc = self.site_and_provenance(s["site"], {"water_works"}, "treated-water supply entry")
            self.add_node(
                s["id"], s["name"], "water", "supply_source", point, prov, location=loc,
                elevation=-2.5, capacity=float(s["capacity_lps"]), capacity_unit="L/s",
                description="Point where a treated-water transmission main enters the district (simulated source).",
                properties={"pressure_zone": "low", "role": "source"},
            )  # fmt: skip
        for p in wd.get("pump_stations", []):
            point, prov, loc = self.site_and_provenance(p["site"], {"pumping_station"}, "booster pump station")
            self.add_node(
                p["id"], p["name"], "water", "pump_station", point, prov, location=loc,
                capacity=float(p["capacity_lps"]), capacity_unit="L/s",
                description=f"Booster pump lifting low-zone water into the {p['serves_pressure_zone']}-pressure zone; needs grid power (simulated).",
                properties={"serves_pressure_zone": p["serves_pressure_zone"], "backup_hours": float(p.get("backup_hours", 0)), "power_kw": 450},
            )  # fmt: skip
        for t in wd.get("storage_tanks", []):
            point, prov, loc = self.site_and_provenance(t["site"], {"water_tower", "storage_tank"}, "elevated storage tank")
            self.add_node(
                t["id"], t["name"], "water", "storage_tank", point, prov, location=loc,
                elevation=float(t.get("elevation_m", 40)), capacity=float(t.get("capacity_lps", 150)), capacity_unit="L/s",
                description=f"Elevated storage ({t['storage_m3']} m³) floating on the {t['pressure_zone']}-pressure zone (simulated).",
                properties={"storage_m3": float(t["storage_m3"]), "pressure_zone": t["pressure_zone"]},
            )  # fmt: skip
        for j in wd["junctions"]:
            anchor = self.resolve_anchor(j, avoid=self.used["water"])
            self.used["water"].add(anchor)
            self.add_node(
                j["id"], f"Junction {self.short_label(anchor)} (simulated)", "water", "junction",
                self.placed_point(anchor, "water"), sim_prov(), anchor=anchor, elevation=-2.0,
                description=f"Pipe junction in the {j.get('pressure_zone', 'low')}-pressure zone (simulated).",
                properties={"pressure_zone": j.get("pressure_zone", "low")},
            )  # fmt: skip

        def edge_id(ctype: str) -> str:
            return self.next_id("WTR-MAIN-" if ctype == "water_main" else "WTR-DIST-", 4)

        for pipe in wd["pipes"]:
            a, b, ctype = pipe["from"], pipe["to"], pipe["type"]
            cap = float(pipe["capacity_lps"])
            depth = 2.0 if ctype == "water_main" else 1.5
            label = pipe.get("label")
            base_name = f"{'Transmission' if ctype == 'water_main' else 'Distribution'} main {self.short(a)} → {self.short(b)}"
            geom, epath = self.route(a, b, "water")
            valve_id = pipe.get("boundary_valve") or (self.next_id("WTR-VLV-", 2) if pipe.get("valve") else None)
            props = {"pressure_zone": self.nodes[a]["properties"].get("pressure_zone") or self.nodes[b]["properties"].get("pressure_zone")}
            if label:
                props["purpose"] = label
            if not valve_id:
                self.add_edge(
                    edge_id(ctype), a, b, "water", ctype, geom, sim_prov(), street_path=epath, capacity=cap,
                    capacity_unit="L/s", depth=depth, directed=bool(pipe.get("directed", False)),
                    name=f"{base_name} (simulated)" + (f" - {label}" if label else ""), properties=props,
                )  # fmt: skip
                continue
            mid, first, second = self.split_with_node(geom)
            boundary = bool(pipe.get("boundary_valve"))
            self.add_node(
                valve_id,
                (f"Boundary valve {valve_id[-2:]}, normally closed (simulated)" if boundary else f"Isolation valve {valve_id[-2:]} (simulated)"),
                "water", "valve", mid, sim_prov(), elevation=-1.8,
                description=(
                    "Normally-closed valve separating the high- and low-pressure zones; can be opened to back-feed (simulated)."
                    if boundary else "Isolation valve used to shut off a pipe section for repairs (simulated)."
                ),
                properties={"normally_closed": boundary, "role": "zone boundary" if boundary else "isolation", "on_main": f"{a} → {b}"},
            )  # fmt: skip
            for part, (src, dst, g) in enumerate(((a, valve_id, first), (valve_id, b, second)), start=1):
                self.add_edge(
                    edge_id(ctype), src, dst, "water", ctype, g, sim_prov(), street_path=epath, capacity=cap,
                    capacity_unit="L/s", depth=depth, directed=bool(pipe.get("directed", False)),
                    name=f"{base_name} part {part} (simulated)" + (f" - {label}" if label else ""), properties=props,
                )  # fmt: skip

        for z in wd["zones"]:
            point = latlon(z["site"])
            self.add_node(
                z["id"], z["name"] + " (simulated)", "water", "service_zone", point, sim_prov(),
                capacity=None, capacity_unit="L/s", demand=float(z["demand_lps"]),
                description=f"Aggregated customer demand area, {z['pressure_zone']}-pressure zone; {z['population']:,} people (modelled).",
                properties={"population": int(z["population"]), "pressure_zone": z["pressure_zone"], "population_basis": "modelled daytime population"},
            )  # fmt: skip
            connects = [z["connect"]] if isinstance(z["connect"], str) else list(z["connect"])
            if len(connects) > 1:
                self.nodes[z["id"]]["properties"]["service_connections"] = len(connects)
            cap = float(min(300, max(80, round(float(z["demand_lps"]) * 2.5 / 10) * 10)))
            for junction in connects:
                self.add_routed_edge(
                    edge_id("distribution_main"), junction, z["id"], "water", "distribution_main",
                    capacity=cap, capacity_unit="L/s", depth=1.5,
                    name=f"Service mains {self.short(junction)} → {z['name']} (simulated)",
                    properties={"pressure_zone": z["pressure_zone"], "purpose": "zone service connection"},
                )  # fmt: skip

    def short(self, node_id: str) -> str:
        name = self.nodes[node_id]["name"]
        return re.sub(r"\s*\(simulated\)$", "", name).replace("Junction ", "")

    def build_telecom(self) -> None:
        td = self.design["telecom"]
        for c in td["cores"]:
            if c.get("landmark"):
                lm = self.landmarks[c["landmark"]]
                point, prov = self.landmark_position(lm)
                loc = {}
                prov = dict(prov)
                prov["notes"] = (prov.get("notes") or "") + " Modelled connections, capacity and backup hours are SIMULATED."
                desc = f"{lm['name']}: real carrier hotel / interconnection facility (position approximate). Its role as the district's core and every link attached to it are SIMULATED."
            else:
                point, prov, loc = self.site_and_provenance(c["site"], {"data_center", "telecom_exchange"}, "internet exchange / data centre")
                desc = "Secondary core: data centre with an internet exchange (simulated)."
            self.add_node(
                c["id"], c["name"], "telecom", c.get("type", "internet_exchange"), point, prov, location=loc,
                capacity=float(c["capacity_gbps"]), capacity_unit="Gbps", description=desc,
                properties={"role": "core", "modelled_figures": True, "backup_hours": float(c["backup_hours"]), "water_backup_hours": float(c.get("water_backup_hours", 0)),
                            **({"facility_type": c["facility_type"]} if c.get("facility_type") else {})},
            )  # fmt: skip
        for c in td.get("central_offices", []):
            point, prov, loc = self.site_and_provenance(c["site"], {"telecom_exchange"}, "central office")
            self.add_node(
                c["id"], c["name"], "telecom", "central_office", point, prov, location=loc,
                capacity=float(c["capacity_gbps"]), capacity_unit="Gbps",
                description="Aggregation exchange with battery + generator backup (simulated).",
                properties={"backup_hours": float(c["backup_hours"])},
            )  # fmt: skip
        for c in td.get("data_centers", []):
            point, prov, loc = self.site_and_provenance(c["site"], {"data_center"}, "data centre")
            self.add_node(
                c["id"], c["name"], "telecom", "data_center", point, prov, location=loc,
                capacity_unit="Gbps", demand=float(c["demand_gbps"]),
                description="Colocation data centre consuming transit capacity; needs power and cooling water (simulated).",
                properties={"backup_hours": float(c["backup_hours"]), "water_backup_hours": float(c.get("water_backup_hours", 0))},
            )  # fmt: skip
        for h in td["hubs"]:
            anchor = self.resolve_anchor(h, avoid=self.used["telecom"])
            self.used["telecom"].add(anchor)
            self.add_node(
                h["id"], h["name"], "telecom", "fiber_hub", self.placed_point(anchor, "telecom"), sim_prov(),
                anchor=anchor, elevation=-1.5,
                description=f"Passive fibre splice / aggregation vault at {self.short_label(anchor)} (simulated).",
                properties={"passive": True},
            )  # fmt: skip
        for c in td.get("access_nodes", []):
            anchor = self.resolve_anchor(c, avoid=self.used["telecom"])
            self.used["telecom"].add(anchor)
            self.add_node(
                c["id"], c["name"], "telecom", "access_node", self.placed_point(anchor, "telecom"), sim_prov(),
                anchor=anchor, capacity_unit="Gbps", demand=float(c["demand_gbps"]),
                description="Street-side fixed-access cabinet serving nearby buildings (simulated).",
                properties={"backup_hours": float(c.get("backup_hours", 2)), "homing": "dual" if len(c["homes"]) > 1 else "single"},
            )  # fmt: skip
        for c in td.get("cell_sites", []):
            point = latlon(c["site"])
            self.add_node(
                c["id"], c["name"], "telecom", "cell_site", point, sim_prov(), elevation=35.0,
                capacity_unit="Gbps", demand=round(1.0 + 2.0 * stable_unit(f"cell:{c['id']}"), 1),
                description="Rooftop radio site; battery backup then outage when grid power is lost (simulated).",
                properties={"backup_hours": float(c["backup_hours"]), "homing": "dual" if len(c["homes"]) > 1 else "single", "mount": "rooftop"},
            )  # fmt: skip

        def fiber(a: str, b: str, cap: float, role: str) -> None:
            self.add_routed_edge(
                self.next_id("TEL-FBR-", 4), a, b, "telecom", "fiber_link",
                capacity=cap, capacity_unit="Gbps", depth=1.0,
                name=f"Fibre {self.short(a)} ↔ {self.short(b)} (simulated)",
                properties={"role": role},
            )  # fmt: skip

        for link in td["links"]:
            fiber(link["from"], link["to"], float(link["capacity_gbps"]), link.get("ring", "ring"))
        for c in td.get("access_nodes", []):
            for h in c["homes"]:
                fiber(h, c["id"], 40.0, "access backhaul")
        for c in td.get("cell_sites", []):
            for h in c["homes"]:
                fiber(h, c["id"], 10.0, "cell backhaul")

    def build_underground(self) -> None:
        ud = self.design.get("underground", {})
        vault_at: dict[str, str] = {}

        def vault(spec: dict[str, Any], avoid: set[str] | None = None) -> str:
            anchor = self.resolve_anchor(spec, avoid=avoid)
            if avoid and anchor in avoid:  # sparse street graph: never build a corridor from a vault to itself
                anchor = self.sg.nearest_node(self.sg.nodes[anchor].point, exclude=avoid) or anchor
            if anchor in vault_at:
                return vault_at[anchor]
            vid = self.next_id("UGD-VLT-", 2)
            self.add_node(
                vid, f"Utility vault {vid[-2:]} {self.short_label(anchor)} (simulated)", "underground", "utility_vault",
                self.placed_point(anchor, "underground"), sim_prov(), anchor=anchor, elevation=-2.5,
                description="Access vault / manhole joining shared duct-bank sections (simulated).",
                properties={"access": "manhole"},
            )  # fmt: skip
            vault_at[anchor] = vid
            return vid

        corridors: list[str] = []
        for c in ud.get("corridors", []):
            a = vault(c["from"])
            b = vault(c["to"], avoid={self.anchor[a]})
            self.add_routed_edge(
                c["id"], a, b, "underground", c.get("type", "duct_bank"),
                depth=float(c["depth_m"]), name=c["name"] + " (simulated)",
                properties={"ducts": int(c.get("ducts", 12)), "hosted_edge_ids": []},
            )  # fmt: skip
            corridors.append(c["id"])

        host_types = set(ud.get("host_connection_types", ["feeder_cable", "tie_line", "fiber_link"]))
        min_shared = float(ud.get("min_shared_length_m", 60))
        corridor_sets = {cid: set(self.street_paths.get(cid, [])) for cid in corridors}
        for eid in sorted(self.edges):
            e = self.edges[eid]
            if e["connection_type"] not in host_types or e["relation"] != "physical":
                continue
            path = set(self.street_paths.get(eid, []))
            best: tuple[float, str] | None = None
            for cid, cset in corridor_sets.items():
                shared = sum(self.sg.edges[s].length_m for s in path & cset)
                if shared >= min_shared and (best is None or (shared, cid) > best):
                    best = (shared, cid)
            if best is None:
                continue
            cid = best[1]
            e["corridor_id"] = cid
            e["depth_m"] = self.edges[cid]["depth_m"]
            e["properties"]["corridor_shared_length_m"] = round(best[0], 1)
            self.edges[cid]["properties"]["hosted_edge_ids"].append(eid)
        for cid in corridors:
            hosted = sorted(self.edges[cid]["properties"]["hosted_edge_ids"])
            self.edges[cid]["properties"]["hosted_edge_ids"] = hosted
            systems = sorted({self.edges[h]["infrastructure_type"] for h in hosted})
            self.edges[cid]["properties"]["hosted_systems"] = systems

    def build_facilities(self) -> None:
        for f in self.design.get("facilities", []):
            lm = self.landmarks[f["landmark"]]
            point, prov = self.landmark_position(lm)
            prov = dict(prov)
            prov["notes"] = (prov.get("notes") or "") + " Occupancy, backup-generator and water-storage figures are modelled (SIMULATED)."
            props: dict[str, Any] = {
                "occupancy": int(f["occupancy"]),
                "occupancy_basis": "modelled typical weekday daytime occupancy",
                "modelled_figures": True,
                "backup_power_hours": float(f["backup_power_hours"]),
                "backup_hours": float(f["backup_power_hours"]),
                "water_storage_hours": float(f.get("water_storage_hours", 0)),
            }
            if f.get("event_capacity"):
                props["event_capacity"] = int(f["event_capacity"])
            if lm.get("properties"):
                props.update(lm["properties"])
            self.add_node(
                f["id"], lm["name"], "facility", lm["kind"], point, prov, critical=bool(f.get("critical", False)),
                description=(f.get("notes") or f"{lm['name']} (real place; position approximate).")
                + f" Modelled occupancy {int(f['occupancy']):,}; backup power {f['backup_power_hours']} h.",
                properties=props,
            )  # fmt: skip

    # ------------------------------------------------------------------ dependencies

    def nearest(self, point: Sequence[float], candidates: Sequence[str], exclude: set[str] | None = None) -> str:
        exclude = exclude or set()
        best = min(
            (c for c in candidates if c not in exclude),
            key=lambda c: (round(geo.haversine_m(point, self.pos(c)), 3), c),
        )
        return best

    def add_dependency(self, prefix: str, provider: str, consumer: str, system: str, ctype: str, service: str, **props: Any) -> None:
        self.add_edge(
            self.next_id(prefix, 4), provider, consumer, system, ctype, [self.pos(provider), self.pos(consumer)],
            sim_prov(SIM_DEP_NOTE), relation="dependency", directed=True,
            name=f"{service}: {self.short(provider)} → {self.short(consumer)}",
            properties={"service": service, **props},
        )  # fmt: skip

    def build_dependencies(self) -> None:
        dd = self.design.get("dependencies", {})
        by_type: dict[str, list[str]] = defaultdict(list)
        for nid, n in self.nodes.items():
            by_type[n["type"]].append(nid)
        vaults = sorted(by_type["network_vault"])
        facilities = sorted(n for n, v in self.nodes.items() if v["system"] == "facility")
        overrides = dd.get("power_overrides", {})

        def power_consumers() -> list[tuple[str, str]]:
            out: list[tuple[str, str]] = []
            for t, service in (
                ("pump_station", "pump motor supply"),
                ("internet_exchange", "facility power"),
                ("data_center", "facility power"),
                ("central_office", "exchange power"),
                ("access_node", "cabinet power"),
                ("cell_site", "radio site power"),
                ("transit_station", "traction & station power"),
            ):
                out.extend((c, service) for c in sorted(by_type[t]))
            out.extend((c, "building power") for c in facilities)
            out.extend(
                (c, "traffic signal power")
                for c in sorted(by_type["intersection"])
                if self.nodes[c]["properties"].get("signalized")
            )
            return out

        for consumer, service in power_consumers():
            props: dict[str, Any] = {}
            backup = self.nodes[consumer]["properties"].get("backup_hours")
            if backup is not None:
                props["consumer_backup_hours"] = backup
            providers = [self.feeder_ref(r) for r in overrides.get(consumer, [])] or [self.nearest(self.pos(consumer), vaults)]
            for provider in providers:
                self.add_dependency("DEP-PWR-", provider, consumer, "power", "power_supply", service, **props)
            if len(providers) > 1:
                self.nodes[consumer]["properties"]["power_feeds"] = len(providers)

        # Water: service zone -> facilities / data centres / exchanges in it.
        zones = sorted(by_type["service_zone"])
        wtypes = set(dd.get("water_consumer_types", []))
        woverrides = dd.get("water_overrides", {})
        for consumer in sorted(n for n, v in self.nodes.items() if v["type"] in wtypes):
            provider = woverrides.get(consumer) or self.nearest(self.pos(consumer), zones)
            props = {}
            hours = self.nodes[consumer]["properties"].get("water_storage_hours", self.nodes[consumer]["properties"].get("water_backup_hours"))
            if hours is not None:
                props["consumer_storage_hours"] = hours
            service = "cooling water" if self.nodes[consumer]["system"] == "telecom" else "potable & fire water"
            self.add_dependency("DEP-WTR-", provider, consumer, "water", "water_supply", service, **props)

        # Telecom links to critical facilities and stations; SCADA control links.
        tel_providers = sorted(by_type["fiber_hub"] + by_type["access_node"] + by_type["central_office"])
        tconsumers = set(dd.get("telecom_consumers", []))
        redundant = set(dd.get("telecom_redundant_consumers", []))
        toverrides = dd.get("telecom_overrides", {})
        for consumer in sorted(n for n, v in self.nodes.items() if v["type"] in tconsumers):
            n = self.nodes[consumer]
            service = "train control & signalling" if n["type"] == "transit_station" else "voice & data"
            if consumer in toverrides:
                for provider in toverrides[consumer]:
                    self.add_dependency("DEP-TEL-", provider, consumer, "telecom", "telecom_link", service)
                continue
            first = self.nearest(self.pos(consumer), tel_providers)
            self.add_dependency("DEP-TEL-", first, consumer, "telecom", "telecom_link", service)
            if n["type"] in redundant:
                second = self.nearest(self.pos(consumer), tel_providers, exclude={first})
                self.add_dependency("DEP-TEL-", second, consumer, "telecom", "telecom_link", service + " (diverse path)")
        for consumer in sorted(by_type["pump_station"]) + sorted(
            s for s in by_type["switch"] if self.nodes[s]["properties"].get("normally_open")
        ):
            provider = self.nearest(self.pos(consumer), tel_providers)
            service = "SCADA pump control" if self.nodes[consumer]["type"] == "pump_station" else "SCADA remote switching"
            props = {}
            if self.nodes[consumer]["type"] == "switch":
                props["fallback"] = f"manual switching after {self.nodes[consumer]['properties']['manual_switch_hours']} h"
            self.add_dependency("DEP-CTL-", provider, consumer, "telecom", "control_link", service, **props)

        # Road access from the nearest surface intersection.
        intersections = sorted(by_type["intersection"])
        for consumer in facilities + sorted(by_type["transit_station"]):
            provider = self.nearest(self.pos(consumer), intersections)
            self.add_dependency("DEP-RD-", provider, consumer, "transport", "road_access", "road access")

    # ------------------------------------------------------------------ outputs

    def datasets(self) -> list[dict[str, Any]]:
        sim_count = sum(1 for x in list(self.nodes.values()) + list(self.edges.values()) if x["provenance"]["category"] == "simulated")
        osm = self.inp.osm
        street_count = len(self.inp.streets)
        landmark_count = len(self.landmarks) + len(self.inp.landmarks.get("rail_lines", []))
        n_lm = len(self.landmark_osm_ids)
        out: list[dict[str, Any]] = []
        if self.inp.street_source == "authored":
            out.append({
                "id": "authored-streets", "name": "Authored downtown street centrelines", "category": "estimated",
                "source": "DEEPTRACE authors (general knowledge of the downtown grid)", "license": "CC0-1.0",
                "feature_count": street_count, "systems": ["transport"], "inspected": False,
                "notes": "Approximate centrelines drawn from general knowledge, not traced from a surveyed or licensed dataset; may deviate tens of metres. Intersections, road segments and utility routing corridors derive from them. Replace via `python -m app.ingest.overpass` + `python -m app.networks.generate --use-osm`.",
            })  # fmt: skip
        out.append({
            "id": "authored-landmarks", "name": "Authored landmark positions and MARTA alignments", "category": "estimated",
            "source": "General public knowledge (not surveyed)", "license": "CC0-1.0",
            "feature_count": landmark_count, "systems": ["transport", "telecom", "facility"], "inspected": False,
            "notes": "Real public places (MARTA stations, Grady, City Hall, State Capitol, venues, 56 Marietta St) at approximate positions; station depths and rail alignments are low-confidence estimates."
            + (f" {n_lm} of {len(self.landmarks)} landmark positions were replaced by matched OpenStreetMap features." if n_lm else ""),
        })  # fmt: skip
        out.append({
            "id": "deeptrace-generator", "name": f"DEEPTRACE illustrative infrastructure generator v{GENERATOR_VERSION}", "category": "simulated",
            "source": SIM_SOURCE, "license": "CC0-1.0", "feature_count": sim_count,
            "systems": ["power", "water", "telecom", "underground", "facility", "transport"], "inspected": False,
            "notes": "All utility assets, capacities, loads, backup durations, occupancies, corridors and cross-system dependencies are generated from design.json for illustration. They do NOT describe real Georgia Power, Atlanta Watershed, carrier or MARTA infrastructure."
            + (f" {self.asset_osm_matches} of these simulated assets take only their location from a mapped OpenStreetMap feature (recorded in properties.location_source); they remain SIMULATED." if self.asset_osm_matches else ""),
        })  # fmt: skip
        if osm:
            meta = osm["meta"]
            out.append({
                "id": "osm-overpass", "name": "OpenStreetMap via Overpass API", "category": "publicly_mapped",
                "source": "OpenStreetMap contributors via Overpass API", "source_url": "https://www.openstreetmap.org/copyright",
                "license": "ODbL-1.0", "retrieved_at": meta.get("retrieved_at"),
                "feature_count": len(osm["streets"]) + n_lm + self.asset_osm_matches,
                "systems": ["transport", "power", "water", "telecom", "facility"], "inspected": True,
                "notes": f"Road ways ({len(osm['streets'])}) replace the authored streets. {n_lm} landmark position(s) come from matched OSM features (PUBLICLY_MAPPED); {self.asset_osm_matches} simulated asset(s) were snapped to a mapped feature for location only and stay SIMULATED. \u00a9 OpenStreetMap contributors.",
            })  # fmt: skip
        else:
            out.append({
                "id": "osm-overpass", "name": "OpenStreetMap via Overpass API", "category": "publicly_mapped",
                "source": "OpenStreetMap contributors via Overpass API", "source_url": "https://www.openstreetmap.org/copyright",
                "license": "ODbL-1.0", "feature_count": 0, "systems": ["transport", "power", "water", "telecom", "facility"],
                "inspected": False,
                "notes": "Not fetched in this build (network access to Overpass was unavailable); nothing in this network comes from OSM. Run `python -m app.ingest.overpass` then `python -m app.networks.generate --use-osm` to replace authored streets with mapped roads.",
            })  # fmt: skip
        out.append({
            "id": "cesium-osm-buildings", "name": "Cesium OSM Buildings", "category": "publicly_mapped",
            "source": "OpenStreetMap contributors, streamed via Cesium ion", "source_url": "https://cesium.com/platform/cesium-ion/content/cesium-osm-buildings/",
            "license": "ODbL-1.0", "feature_count": 0, "systems": [], "inspected": False,
            "notes": "3D building context streamed at runtime by the browser when a Cesium ion token is configured. Not part of this dataset and not inspected by the pipeline.",
        })  # fmt: skip
        return out

    # -- data-derived assumption sentences (each one is checked against the data it describes)

    def _deps_into(self, consumer: str, ctype: str) -> list[str]:
        return [e["source_node"] for e in self.edges.values() if e["target_node"] == consumer and e["connection_type"] == ctype]

    def _label(self, node_id: str) -> str:
        return re.sub(r"\s*\(simulated\)$", "", self.nodes[node_id]["name"])

    def _power_sentence(self) -> str:
        pd = self.design["power"]
        feeder_load: dict[str, float] = defaultdict(float)
        for n in self.nodes.values():
            if n["type"] == "network_vault":
                feeder_load[n["properties"]["feeder"]] += n["demand"] or 0.0
        ties = [n for n in self.nodes.values() if n["properties"].get("normally_open")]
        below = [t for t in ties if all(t["properties"]["tie_capacity_mw"] < feeder_load[f] for f in t["properties"]["feeders"])]
        tie_text = (
            "every tie is rated below the load of the feeders it joins, so restoration can be partial"
            if len(below) == len(ties)
            else f"{len(below)} of {len(ties)} ties are rated below the load of the feeders they join, so restoration can be partial"
        )
        lf = [float(d["load_factor"]) for d in pd["distribution_substations"]]
        return (
            "Power: 115 kV bulk supply points feed distribution substations over underground cables; each substation feeds "
            "radial 12.47 kV feeders (head switch, then network transformer vaults). Normally-open tie switches join feeders "
            f"of different substations; {tie_text}. Substation load = rating x properties.load_factor "
            f"({min(lf):.0%}-{max(lf):.0%}); vault loads are split deterministically from stable hashes; population_served "
            f"is about {pd.get('population_per_mw', 1000):,.0f} people per MW of load (modelled daytime population)."
        )

    def _alternate_line_sentence(self) -> str:
        under: list[str] = []
        for e in self.edges.values():
            if e["connection_type"] != "transmission_line" or e["properties"].get("role") != "alternate":
                continue
            ds = self.nodes[e["target_node"]]
            load = float(ds["demand"] or 0.0)
            if e["capacity"] * EMERGENCY_LIMIT < load:
                under.append(f"{e['id']} ({self._label(ds['id'])}, {e['capacity']:.0f} MW vs {load:.1f} MW load)")
        text = "Alternate (standby) transmission lines can carry their substation's full load"
        if under:
            text += (
                " except " + ", ".join(under) + ", which is rated below that load and trips (above the "
                f"{EMERGENCY_LIMIT:.0%} emergency limit) when its primary supply is lost"
            )
        return text + "."

    def _water_sentence(self) -> str:
        import networkx as nx

        boundary = {"valve", "supply_source", "pump_station", "storage_tank", "service_zone"}
        g = nx.Graph()
        for e in self.edges.values():
            if e["infrastructure_type"] == "water" and e["relation"] == "physical":
                g.add_edge(e["source_node"], e["target_node"])
        interior = g.subgraph(n for n in g if self.nodes[n]["type"] not in boundary)
        biggest = max((len(c) for c in nx.connected_components(interior)), default=0)
        dual = sorted(
            self._label(n["id"]) for n in self.nodes.values() if n["properties"].get("service_connections", 1) >= 2
        )
        dual_text = f" {' and '.join(dual)} have a second service connection." if dual else ""
        return (
            "Water: two transmission-main entries feed a looped low-pressure grid; isolation valves sit on the mains between "
            f"junctions, so closing the valves around a break isolates at most {biggest} junction(s) and the zones they serve."
            f"{dual_text} A booster pump (needs grid power) feeds the high-pressure zone, backed by an elevated tank; "
            "normally-closed boundary valves separate the zones and are treated as closed unless opened."
        )

    def _telecom_sentence(self) -> str:
        import networkx as nx

        g = nx.Graph()
        homes: dict[str, set[str]] = defaultdict(set)
        for e in self.edges.values():
            if e["connection_type"] != "fiber_link":
                continue
            a, b = e["source_node"], e["target_node"]
            g.add_edge(a, b)
            for x, y in ((a, b), (b, a)):
                if self.nodes[x]["type"] in ("cell_site", "access_node"):
                    homes[x].add(y)
        cores = sorted(n for n in g if self.nodes[n]["type"] == "internet_exchange")
        g.add_edges_from(("__core__", c) for c in cores)
        single = sorted(k for k, v in homes.items() if len(v) == 1)
        dual = sorted(k for k, v in homes.items() if len(v) >= 2)
        only_core = {c: sorted(k for k, v in homes.items() if v == {c}) for c in cores}
        spur = nx.Graph()
        spur.add_edges_from(
            (e["source_node"], e["target_node"]) for e in self.edges.values() if e["properties"].get("role") == "spur"
        )
        spur_nodes = sorted(spur.nodes)
        ends = sorted(n for n in spur if spur.degree(n) == 1)
        if len(ends) == 2 and nx.is_connected(spur):
            spur_nodes = nx.shortest_path(spur, ends[0], ends[1])
        spur_text = ""
        if spur_nodes:
            stub = [n for n in spur_nodes if n not in cores and nx.edge_connectivity(g, "__core__", n) < 2]
            names = " - ".join(self._label(n) for n in spur_nodes)
            spur_text = (
                f" A spur ({names}) links the rings, so its sites are reachable both ways."
                if not stub
                else f" A spur ({names}) leaves {', '.join(self._label(n) for n in stub)} single-homed."
            )
        core_text = "".join(
            f" {_join([self._label(n) for n in v])} reach the core only through {self._label(c)}." for c, v in only_core.items() if v
        )
        return (
            f"Telecom: dual cores ({' and '.join(self._label(c) for c in cores)}; the carrier hotel is a real building whose "
            "modelled links are simulated) with west and east fibre rings." + spur_text
            + f" {len(dual)} access/cell sites are dual-homed and {len(single)} single-homed." + core_text
            + " properties.backup_hours is battery/generator autonomy."
        )

    def _transport_sentence(self) -> str:
        signals = [n for n in self.nodes.values() if n["type"] == "intersection" and n["properties"].get("signalized")]
        ups = [n for n in signals if (n["properties"].get("backup_hours") or 0) > 0]
        hours = sorted({n["properties"]["backup_hours"] for n in ups})
        ups_text = (
            f"{len(ups)} of {len(signals)} signalised intersections (those on primary streets) have "
            f"{'/'.join(f'{h:g}' for h in hours)} h of UPS backup, the rest go dark when grid power is lost"
            if ups
            else f"all {len(signals)} signalised intersections go dark when grid power is lost"
        )
        return (
            f"Transport: {ups_text}; one-way flags are recorded in properties.oneway but road edges are modelled as "
            "undirected; MARTA stations draw traction and station power from the power grid like any other consumer "
            "(see the power-feed exceptions below)."
        )

    def _power_feed_sentence(self) -> str:
        vaults = sorted(n for n, v in self.nodes.items() if v["type"] == "network_vault")
        exceptions: list[str] = []
        for consumer in sorted(self.nodes):
            providers = self._deps_into(consumer, "power_supply")
            if not providers:
                continue
            nearest = self.nearest(self.pos(consumer), vaults)
            if len(providers) > 1 or providers[0] != nearest:
                feeders = ", ".join(f"{self.nodes[p]['properties']['feeder']} ({self._label(p)})" for p in providers)
                exceptions.append(f"{self._label(consumer)} <- {feeders}")
        text = "Each power consumer is fed from its nearest network vault"
        if exceptions:
            text += ", except these deliberate design choices: " + "; ".join(exceptions)
        return text + "."

    def assumptions(self) -> list[str]:
        n_lm = len(self.landmark_osm_ids)
        street_line = (
            "Street centrelines are authored approximations (ESTIMATED, typically within tens of metres); landmark "
            "positions are approximate public knowledge (ESTIMATED), not surveyed."
            if self.inp.street_source == "authored"
            else "Road geometry comes from OpenStreetMap (PUBLICLY_MAPPED, \u00a9 OpenStreetMap contributors, ODbL); "
            f"{n_lm} of {len(self.landmarks)} landmark positions are OSM-matched, the rest ESTIMATED; "
            f"{self.asset_osm_matches} simulated asset(s) take only their location from a mapped feature and stay SIMULATED."
        )
        return [
            "Every utility asset (substations, feeders, vaults, switches, mains, valves, pumps, tanks, fibre, hubs, cell sites, "
            "duct banks) and every cross-system dependency is SIMULATED for illustration; none describes the real Georgia Power, "
            "Atlanta Department of Watershed Management, carrier or MARTA systems.",
            street_line,
            "Utility routes follow the street graph (shortest path over surface streets; off-street sites join through a short "
            "service drop) with a fixed lateral offset per system; burial depths are typical values, not surveyed.",
            self._power_sentence(),
            "Tie switches are operated remotely over a SCADA control link; if that link is down, a crew closes them manually "
            "after properties.manual_switch_hours. " + self._alternate_line_sentence(),
            self._water_sentence(),
            self._telecom_sentence(),
            self._transport_sentence(),
            self._power_feed_sentence(),
            "Facilities: occupancy, backup-generator hours and water-storage hours are modelled assumptions, not published "
            "figures (properties.modelled_figures). Grady Memorial Hospital is modelled with two power feeds from different "
            "substations.",
            "Shared corridors: a feeder, tie or fibre route that runs at least "
            f"{self.design.get('underground', {}).get('min_shared_length_m', 60)} m inside a duct bank or utility tunnel is "
            "recorded as hosted (corridor_id); a strike on the corridor fails every hosted edge.",
            "Dependency edges run provider -> consumer (directed); their straight-line geometry is for display only.",
            "Units: power MW, water L/s, telecom Gbps, roads vehicles/hour, rail riders/hour.",
            "Generated deterministically (no randomness); generated_at is fixed so output is byte-stable.",
        ]

    def description(self) -> str | None:
        nd = self.design.get("network", {})
        if self.inp.street_source == "authored":
            return nd.get("description")
        return (
            "Six interdependent infrastructure systems for downtown Atlanta. Road geometry is PUBLICLY_MAPPED "
            "(OpenStreetMap contributors, ODbL); landmark positions are OSM-matched where possible, otherwise ESTIMATED; "
            "every utility asset, connection and capacity is SIMULATED for demonstration and does not describe the real grid."
        )

    def build(self) -> dict[str, Any]:
        self.build_transport()
        self.build_power()
        self.build_water()
        self.build_telecom()
        self.build_facilities()
        self.build_underground()
        self.build_dependencies()
        nd = self.design.get("network", {})
        network = {
            "id": nd.get("id", self.region.id),
            "name": nd.get("name", f"DEEPTRACE {self.region.name}"),
            "version": GENERATOR_VERSION,
            "generated_at": self.generated_at,
            "description": self.description(),
            "region": self.region.model_dump(mode="json"),
            "nodes": list(self.nodes.values()),
            "edges": list(self.edges.values()),
            "datasets": self.datasets(),
            "assumptions": self.assumptions(),
        }
        validated = InfrastructureNetwork.model_validate(network)
        return validated.model_dump(mode="json")

    # ------------------------------------------------------------------ scenarios & demo

    def resolve_focus(self, ref: str | None) -> str | None:
        if not ref:
            return None
        if ref.startswith("corridor:"):
            return self.edges[ref.split(":", 1)[1]]["source_node"]
        if ref.startswith("road:"):
            return self.street_node_to_trn[self.resolve_anchor({"at": ref.split(":", 1)[1]})]
        return ref

    def scenarios(self) -> list[dict[str, Any]]:
        out = []
        for s in self.design.get("scenarios", []):
            failed_nodes = list(s.get("fail_nodes", []))
            failed_edges = list(s.get("fail_edges", []))
            for sel in s.get("fail_edges_near", []):
                p = latlon(sel["near"])
                cands = [e for e in self.edges.values() if e["connection_type"] == sel["connection_type"]]
                best = min(
                    cands,
                    key=lambda e: (round(geo.nearest_point_on_polyline(p, e["geometry"], self.proj)[1], 3), e["id"]),
                )
                failed_edges.append(best["id"])
            for spec in s.get("fail_intersections", []):
                failed_nodes.append(self.street_node_to_trn[self.resolve_anchor(spec)])
            legs = s.get("fail_road_legs")
            if legs:
                sid = self.resolve_anchor(legs)
                tid = self.street_node_to_trn[sid]
                want = {street_key(x) for x in legs["streets"]}
                for e in self.edges.values():
                    if e["connection_type"] != "road_segment" or tid not in (e["source_node"], e["target_node"]):
                        continue
                    if street_key(e["properties"]["street"]) in want:
                        failed_edges.append(e["id"])
            for nid in failed_nodes:
                if nid not in self.nodes:
                    raise ValueError(f"scenario {s['id']}: unknown node {nid}")
            for eid in failed_edges:
                if eid not in self.edges:
                    raise ValueError(f"scenario {s['id']}: unknown edge {eid}")
            preset = {
                "id": s["id"],
                "name": s["name"],
                "scenario_type": s["scenario_type"],
                "description": s["description"],
                "scenario": {
                    "scenario_id": s["id"],
                    "name": s["name"],
                    "scenario_type": s["scenario_type"],
                    "failed_nodes": sorted(dict.fromkeys(failed_nodes)),
                    "failed_edges": sorted(failed_edges),
                    "horizon_hours": float(s.get("horizon_hours", 4.0)),
                    "enable_restoration": bool(s.get("enable_restoration", True)),
                    "max_cascade_rounds": int(s.get("max_cascade_rounds", 8)),
                },
                "focus_node_id": self.resolve_focus(s.get("focus_node_id")),
            }
            out.append(ScenarioPreset.model_validate(preset).model_dump(mode="json"))
        return out

    def demo(self, presets: list[dict[str, Any]]) -> dict[str, Any] | None:
        d = self.design.get("demo")
        if not d:
            return None
        preset_ids = {p["id"] for p in presets}
        for key in ("scenario_a_preset", "scenario_b_preset"):
            if d[key] not in preset_ids:
                raise ValueError(f"demo {key} {d[key]} is not a preset")
        if d["focus_node_id"] not in self.nodes:
            raise ValueError(f"demo focus node {d['focus_node_id']} not in network")
        steps = []
        for st in d["steps"]:
            step = {k: st.get(k) for k in ("id", "title", "narration", "action", "node_id", "preset_id", "question")}
            if step["node_id"] and step["node_id"] not in self.nodes:
                raise ValueError(f"demo step {st['id']}: unknown node {step['node_id']}")
            steps.append(step)
        script = {
            "id": d["id"],
            "title": d["title"],
            "steps": steps,
            "scenario_a_preset": d["scenario_a_preset"],
            "scenario_b_preset": d["scenario_b_preset"],
            "focus_node_id": d["focus_node_id"],
        }
        return DemoScript.model_validate(script).model_dump(mode="json")


# ---------------------------------------------------------------------- serialisation


def dumps_network(network: dict[str, Any]) -> str:
    """Stable JSON: pretty top level, one node / edge per line (diff-friendly, compact)."""
    parts = ["{"]
    keys = list(network.keys())
    for i, key in enumerate(keys):
        comma = "," if i < len(keys) - 1 else ""
        value = network[key]
        if key in ("nodes", "edges") and isinstance(value, list):
            parts.append(f'  "{key}": [')
            for j, item in enumerate(value):
                sep = "," if j < len(value) - 1 else ""
                parts.append("    " + json.dumps(item, ensure_ascii=False, separators=(",", ":")) + sep)
            parts.append("  ]" + comma)
        else:
            body = json.dumps(value, ensure_ascii=False, indent=2).replace("\n", "\n  ")
            parts.append(f'  "{key}": {body}{comma}')
    parts.append("}")
    return "\n".join(parts) + "\n"


def write_atomic(path: Path, text: str) -> None:
    """Write a complete file then rename it into place (readers never see a partial file)."""
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text)
    tmp.replace(path)


def dumps_pretty(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def summarize(network: dict[str, Any]) -> str:
    nodes, edges = network["nodes"], network["edges"]
    lines = [f"network {network['id']} v{network['version']}: {len(nodes)} nodes, {len(edges)} edges"]
    by_sys: dict[str, Counter[str]] = defaultdict(Counter)
    for n in nodes:
        by_sys[n["system"]][n["type"]] += 1
    for sys_name in sorted(by_sys):
        c = by_sys[sys_name]
        lines.append(f"  {sys_name:<12} nodes {sum(c.values()):>4}: " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
    by_ct: dict[str, Counter[str]] = defaultdict(Counter)
    for e in edges:
        by_ct[e["relation"]][e["connection_type"]] += 1
    for rel in sorted(by_ct):
        c = by_ct[rel]
        lines.append(f"  {rel:<12} edges {sum(c.values()):>4}: " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
    prov: dict[str, Counter[str]] = defaultdict(Counter)
    for x in nodes:
        prov[x["system"]][x["provenance"]["category"]] += 1
    for x in edges:
        prov[x["infrastructure_type"]][x["provenance"]["category"]] += 1
    lines.append("  provenance (nodes+edges) per system:")
    for sys_name in sorted(prov):
        lines.append(f"    {sys_name:<12} " + ", ".join(f"{k} {v}" for k, v in sorted(prov[sys_name].items())))
    hosted = {e["id"]: e["properties"].get("hosted_edge_ids", []) for e in edges if e["infrastructure_type"] == "underground"}
    lines.append("  corridors: " + "; ".join(f"{k} hosts {len(v)}" for k, v in sorted(hosted.items())))
    return "\n".join(lines)


def generate_region(
    region_dir: Path,
    *,
    out_dir: Path | None = None,
    use_osm: bool = False,
    osm_cache: Path | None = None,
    generated_at: str = DEFAULT_GENERATED_AT,
    mirror_dir: Path | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None, list[str]]:
    """Generate and write a region's network, scenarios and demo script.

    Returns ``(network, presets, demo, warnings)``. Files go to ``out_dir`` (default: the
    region folder); ``network.json`` is also copied to ``mirror_dir`` when given.
    """
    inputs = load_inputs(region_dir, use_osm=use_osm, osm_cache=osm_cache)
    builder = NetworkBuilder(inputs, generated_at=generated_at)
    network = builder.build()
    presets = builder.scenarios()
    demo = builder.demo(presets)
    out = out_dir or region_dir
    out.mkdir(parents=True, exist_ok=True)
    text = dumps_network(network)
    write_atomic(out / "network.json", text)
    write_atomic(out / "scenarios.json", dumps_pretty(presets))
    if demo is not None:
        write_atomic(out / "demo.json", dumps_pretty(demo))
    if mirror_dir is not None:
        mirror_dir.mkdir(parents=True, exist_ok=True)
        write_atomic(mirror_dir / "network.json", text)
    return network, presets, demo, list(dict.fromkeys(builder.warnings))


def main(argv: Sequence[str] | None = None) -> int:
    from app.config import get_settings
    from app.networks.checks import check_network

    parser = argparse.ArgumentParser(description="Generate the DEEPTRACE network for a region (deterministic).")
    parser.add_argument("--region", default=None, help="Region id under datasets/regions (default: DEEPTRACE_REGION)")
    parser.add_argument("--use-osm", action="store_true", help="Use cached OpenStreetMap data (see app.ingest.overpass)")
    parser.add_argument("--osm-cache", type=Path, default=None, help="Path to an Overpass cache JSON (default: datasets/cache/osm/<region>.json)")
    parser.add_argument("--generated-at", default=DEFAULT_GENERATED_AT, help="Timestamp recorded in network.json")
    parser.add_argument("--out-dir", type=Path, default=None, help="Write outputs here instead of the region folder")
    parser.add_argument("--no-mirror", action="store_true", help="Do not copy network.json to public/demo/")
    args = parser.parse_args(argv)

    region_id = args.region or get_settings().region_id
    region_dir = REGIONS_DIR / region_id
    if not region_dir.exists():
        print(f"Region folder {region_dir} not found", file=sys.stderr)
        return 2
    network, presets, demo, warnings = generate_region(
        region_dir,
        out_dir=args.out_dir,
        use_osm=args.use_osm,
        osm_cache=args.osm_cache,
        generated_at=args.generated_at,
        mirror_dir=None if args.no_mirror else PUBLIC_DEMO_DIR,
    )
    print(summarize(network))
    print(f"  presets: {', '.join(p['id'] for p in presets)}")
    if demo:
        print(f"  demo: {demo['id']} ({len(demo['steps'])} steps, focus {demo['focus_node_id']})")
    for w in warnings:
        print(f"  warning: {w}")
    problems = check_network(network, presets=presets, demo=demo)
    for p in problems:
        print(f"  CHECK FAILED: {p}", file=sys.stderr)
    out = args.out_dir or region_dir
    print(f"wrote {out}/network.json, scenarios.json, demo.json" + ("" if args.no_mirror else f" (+ {PUBLIC_DEMO_DIR}/network.json)"))
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
