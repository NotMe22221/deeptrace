"""Normalise a raw Overpass API response into DEEPTRACE inputs.

Produces

* ``streets`` — features in the same format as ``datasets/regions/<id>/streets.json``
  (``[lon, lat]`` coordinates, ``class``, ``lanes``, ``oneway``, ``speed_kph``) plus
  ``node_refs`` so the street graph can be noded topologically (respecting bridges and
  tunnels). Provenance is PUBLICLY_MAPPED with the OSM attribution and ODbL licence.
* ``points`` — candidate facility / infrastructure locations (substations, water towers,
  pumping stations, telecom exchanges, data centres, hospitals, fire and police
  stations, rail stations) with their tags. The generator may use these to position
  modelled assets; the *topology* it attaches to them remains SIMULATED.
* ``lines`` — mapped linear infrastructure (power lines/cables, rail) kept for reference.

The input may be the raw Overpass JSON or the cache written by
:mod:`app.ingest.overpass` (raw JSON plus a ``deeptrace_meta`` block).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from app.networks.geo import centroid, in_bbox

OSM_SOURCE = "OpenStreetMap contributors via Overpass API"
OSM_LICENSE = "ODbL-1.0"
OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright"
OSM_STREET_CONFIDENCE = 0.85
OSM_POINT_CONFIDENCE = 0.8

DEFAULT_ROAD_CLASSES: tuple[str, ...] = (
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
)

DEFAULT_SPEED_KPH = {
    "motorway": 89,
    "motorway_link": 56,
    "trunk": 72,
    "trunk_link": 48,
    "primary": 48,
    "primary_link": 40,
    "secondary": 40,
    "secondary_link": 40,
    "tertiary": 40,
    "tertiary_link": 32,
    "unclassified": 32,
    "residential": 32,
}

DEFAULT_LANES = {"motorway": 6, "trunk": 4, "primary": 4, "secondary": 3, "tertiary": 2}

# Classes collapse "*_link" variants of surface roads to their parent class.
_CLASS_ALIASES = {"primary_link": "primary", "secondary_link": "secondary", "tertiary_link": "tertiary"}


def load_raw(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict) or "elements" not in data:
        raise ValueError(f"{path} is not an Overpass JSON response (no 'elements')")
    return data


def retrieved_at_of(raw: dict[str, Any]) -> str | None:
    meta = raw.get("deeptrace_meta") or {}
    if meta.get("retrieved_at"):
        return str(meta["retrieved_at"])
    osm3s = raw.get("osm3s") or {}
    return osm3s.get("timestamp_osm_base")


def _truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"yes", "true", "1", "-1", "viaduct", "building_passage", "culvert"}


def _parse_int(value: Any) -> int | None:
    if value is None:
        return None
    m = re.match(r"\s*(-?\d+)", str(value))
    return int(m.group(1)) if m else None


def parse_maxspeed_kph(value: Any) -> float | None:
    """Parse an OSM ``maxspeed`` tag (``"35 mph"``, ``"50"``, ``"40 km/h"``) to km/h."""
    if value is None:
        return None
    text = str(value).strip().lower()
    m = re.match(r"(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph)?", text)
    if not m:
        return None
    speed = float(m.group(1))
    if m.group(2) == "mph":
        speed *= 1.609344
    return round(speed, 1)


def _element_coords(el: dict[str, Any], node_index: dict[int, tuple[float, float]]) -> list[tuple[float, float]]:
    """Coordinates of a way as ``[(lon, lat)]`` from inline geometry or the node index."""
    geom = el.get("geometry")
    if geom:
        return [(float(g["lon"]), float(g["lat"])) for g in geom if g and "lon" in g and "lat" in g]
    return [node_index[r] for r in el.get("nodes", []) if r in node_index]


def _element_point(el: dict[str, Any], node_index: dict[int, tuple[float, float]]) -> tuple[float, float] | None:
    """Representative ``(lon, lat)`` for any element (node position, centre or centroid)."""
    if el.get("type") == "node" and "lat" in el and "lon" in el:
        return (float(el["lon"]), float(el["lat"]))
    if "center" in el and el["center"]:
        return (float(el["center"]["lon"]), float(el["center"]["lat"]))
    if el.get("type") == "way":
        coords = _element_coords(el, node_index)
        return centroid(coords) if coords else None
    if el.get("type") == "relation":
        pts: list[tuple[float, float]] = []
        for m in el.get("members", []) or []:
            for g in m.get("geometry", []) or []:
                if g and "lon" in g and "lat" in g:
                    pts.append((float(g["lon"]), float(g["lat"])))
            if m.get("type") == "node" and "lat" in m and "lon" in m:
                pts.append((float(m["lon"]), float(m["lat"])))
        if not pts and "bounds" in el:
            b = el["bounds"]
            pts = [(b["minlon"], b["minlat"]), (b["maxlon"], b["maxlat"])]
        return centroid(pts) if pts else None
    return None


def classify_point(tags: dict[str, str]) -> str | None:
    """Map OSM tags to a DEEPTRACE candidate kind (or ``None`` if not of interest).

    Water candidates require evidence that they carry *water* (an untagged storage tank
    or a sewage pumping station must not stand in for a water-supply asset). Named
    elements that match nothing else become ``named_feature`` so that landmarks fetched
    by name can still be matched; asset placement never uses that kind.
    """
    power = tags.get("power")
    man_made = tags.get("man_made")
    amenity = tags.get("amenity")
    if power == "substation":
        return "substation"
    if power == "transformer":
        return "transformer"
    if man_made == "water_tower":
        return "water_tower"
    if man_made == "storage_tank":
        return "storage_tank" if tags.get("content") == "water" else "storage_tank_other"
    if man_made == "water_works":
        return "water_works"
    if man_made == "pumping_station":
        water = tags.get("pumping_station") in ("water", "water_supply", "drinking_water") or tags.get("substance") == "water"
        return "pumping_station" if water else "pumping_station_other"
    if tags.get("telecom") == "data_center" or tags.get("building") == "data_center":
        return "data_center"
    if tags.get("telecom") == "exchange":
        return "telecom_exchange"
    if "telecom" in tags:
        return "telecom"
    if amenity in ("hospital", "fire_station", "police", "townhall", "courthouse", "university"):
        return amenity
    if tags.get("public_transport") == "station" or tags.get("railway") == "station":
        return "station"
    if tags.get("leisure") in ("stadium", "sports_centre", "park"):
        return tags["leisure"]
    if tags.get("tourism") == "aquarium":
        return "aquarium"
    if tags.get("building") == "government" or tags.get("office") == "government":
        return "government"
    if tags.get("name"):
        return "named_feature"
    return None


def osm_url(el_type: str, el_id: Any) -> str:
    return f"https://www.openstreetmap.org/{el_type}/{el_id}"


def osm_provenance(el_type: str, el_id: Any, retrieved_at: str | None, confidence: float, notes: str) -> dict[str, Any]:
    return {
        "category": "publicly_mapped",
        "source": OSM_SOURCE,
        "source_url": osm_url(el_type, el_id),
        "confidence": confidence,
        "retrieved_at": retrieved_at,
        "license": OSM_LICENSE,
        "notes": notes,
    }


def _inside_runs(
    coords: Sequence[tuple[float, float]], refs: Sequence[Any], bbox: Sequence[float] | None, margin_m: float
) -> list[tuple[list[tuple[float, float]], list[Any]]]:
    """Split a way into runs of consecutive vertices inside the bbox (+margin)."""
    if bbox is None:
        return [(list(coords), list(refs))]
    runs: list[tuple[list[tuple[float, float]], list[Any]]] = []
    cur_c: list[tuple[float, float]] = []
    cur_r: list[Any] = []
    for c, r in zip(coords, refs, strict=False):
        if in_bbox(c, bbox, margin_m):
            cur_c.append(c)
            cur_r.append(r)
        else:
            if len(cur_c) >= 2:
                runs.append((cur_c, cur_r))
            cur_c, cur_r = [], []
    if len(cur_c) >= 2:
        runs.append((cur_c, cur_r))
    return runs


def normalize_overpass(
    raw: dict[str, Any],
    bbox: Sequence[float] | None = None,
    *,
    road_classes: Iterable[str] = DEFAULT_ROAD_CLASSES,
    margin_m: float = 40.0,
) -> dict[str, Any]:
    """Convert raw Overpass JSON to ``{"streets", "points", "lines", "meta"}``.

    ``bbox`` is ``(south, west, north, east)``; ways are cut to runs of vertices inside it.
    """
    classes = set(road_classes)
    retrieved_at = retrieved_at_of(raw)
    elements = raw.get("elements", []) or []
    node_index: dict[int, tuple[float, float]] = {}
    for el in elements:
        if el.get("type") == "node" and "lat" in el and "lon" in el:
            node_index[el["id"]] = (float(el["lon"]), float(el["lat"]))

    streets: list[dict[str, Any]] = []
    points: list[dict[str, Any]] = []
    lines: list[dict[str, Any]] = []

    for el in sorted(elements, key=lambda e: (str(e.get("type")), int(e.get("id", 0)))):
        tags = el.get("tags") or {}
        etype = el.get("type")
        eid = el.get("id")
        if etype == "way" and tags.get("highway") in classes:
            coords = _element_coords(el, node_index)
            refs = list(el.get("nodes") or [])
            if len(refs) != len(coords):
                refs = [None] * len(coords)
            highway = tags["highway"]
            cls = _CLASS_ALIASES.get(highway, highway)
            lanes = _parse_int(tags.get("lanes")) or DEFAULT_LANES.get(cls.replace("_link", ""), 2)
            speed = parse_maxspeed_kph(tags.get("maxspeed")) or DEFAULT_SPEED_KPH.get(highway, 40)
            name = tags.get("name") or tags.get("ref") or f"Unnamed {highway.replace('_', ' ')}"
            runs = _inside_runs(coords, refs, bbox, margin_m)
            for k, (cc, rr) in enumerate(runs):
                fid = f"OSM-W{eid}" if len(runs) == 1 else f"OSM-W{eid}-{k + 1}"
                streets.append(
                    {
                        "id": fid,
                        "name": name,
                        "class": cls,
                        "lanes": lanes,
                        "oneway": _truthy(tags.get("oneway")) if "oneway" in tags else (highway in ("motorway", "motorway_link")),
                        "speed_kph": speed,
                        "coordinates": [[round(c[0], 7), round(c[1], 7)] for c in cc],
                        "node_refs": rr,
                        "layer": _parse_int(tags.get("layer")) or 0,
                        "bridge": _truthy(tags.get("bridge")) if "bridge" in tags else False,
                        "tunnel": _truthy(tags.get("tunnel")) if "tunnel" in tags else False,
                        "provenance": osm_provenance(
                            "way",
                            eid,
                            retrieved_at,
                            OSM_STREET_CONFIDENCE,
                            "Road centreline from OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0). "
                            "Positional accuracy typically a few metres.",
                        ),
                        "properties": {"osm_id": f"way/{eid}", "highway": highway, **({"ref": tags["ref"]} if "ref" in tags else {})},
                    }
                )
            continue

        if etype == "way" and (
            tags.get("power") in ("line", "cable", "minor_line") or tags.get("railway") in ("subway", "light_rail", "rail")
        ):
            coords = _element_coords(el, node_index)
            if len(coords) >= 2 and (bbox is None or any(in_bbox(c, bbox, margin_m) for c in coords)):
                lines.append(
                    {
                        "osm_id": f"way/{eid}",
                        "kind": tags.get("power") or tags.get("railway"),
                        "name": tags.get("name"),
                        "coordinates": [[round(c[0], 7), round(c[1], 7)] for c in coords],
                        "tags": dict(sorted(tags.items())),
                    }
                )
            continue

        if not tags:
            continue
        kind = classify_point(tags)
        if kind is None:
            continue
        pt = _element_point(el, node_index)
        if pt is None or (bbox is not None and not in_bbox(pt, bbox, margin_m)):
            continue
        points.append(
            {
                "osm_id": f"{etype}/{eid}",
                "osm_type": etype,
                "osm_numeric_id": eid,
                "kind": kind,
                "name": tags.get("name"),
                "lat": round(pt[1], 7),
                "lon": round(pt[0], 7),
                "tags": dict(sorted(tags.items())),
            }
        )

    counts: dict[str, int] = {"streets": len(streets), "lines": len(lines)}
    for p in points:
        counts[f"points.{p['kind']}"] = counts.get(f"points.{p['kind']}", 0) + 1
    return {
        "meta": {
            "source": OSM_SOURCE,
            "license": OSM_LICENSE,
            "source_url": OSM_COPYRIGHT_URL,
            "retrieved_at": retrieved_at,
            "bbox": list(bbox) if bbox else None,
            "counts": counts,
        },
        "streets": streets,
        "points": points,
        "lines": lines,
    }


def normalize_name(name: str | None) -> str:
    """Loose name key for matching mapped features to authored landmarks."""
    if not name:
        return ""
    text = re.sub(r"[^a-z0-9 ]+", " ", name.lower())
    return " ".join(text.split())
