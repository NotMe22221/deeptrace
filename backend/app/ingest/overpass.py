"""Fetch and cache OpenStreetMap data for a region from the Overpass API.

Usage (from ``backend/``)::

    python -m app.ingest.overpass [--region atlanta-downtown] [--force] [--max-age-hours 168]

The raw Overpass JSON is cached to ``backend/datasets/cache/osm/<region>.json`` together
with a ``deeptrace_meta`` block (retrieval timestamp, endpoint, bbox, query). A fresh
cache is reused unless ``--force`` is given. This module is only ever run from the
command line: the API server never contacts Overpass on startup.

After fetching, rebuild the network from mapped streets with::

    python -m app.networks.generate --region atlanta-downtown --use-osm

Data © OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from app.config import CACHE_DIR, REGIONS_DIR, get_settings
from app.networks.loader import load_region

DEFAULT_MAX_AGE_HOURS = 24 * 7
DEFAULT_TIMEOUT_S = 180
USER_AGENT = os.getenv(
    "DEEPTRACE_OVERPASS_USER_AGENT",
    "DEEPTRACE-ingest/1.0 (open-source infrastructure digital-twin demo; one cached request per region)",
)

HIGHWAY_REGEX = (
    "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|"
    "tertiary|tertiary_link|unclassified|residential)$"
)


def _name_pattern(name: str) -> str:
    """Case-insensitive Overpass regex for a landmark name (non-alphanumerics become wildcards)."""
    return "".join(ch if ch.isalnum() or ch == " " else "." for ch in name.strip())


def landmark_clauses(landmarks: Sequence[dict[str, Any]], bbox_text: str) -> list[str]:
    """One clause per landmark ``osm_match`` spec: its tag filters plus a name filter.

    Generic tags such as ``building=yes`` are only ever queried together with the name, so
    the query never asks for every building in the box.
    """
    clauses: list[str] = []
    for lm in landmarks:
        spec = lm.get("osm_match") or {}
        name = spec.get("name")
        if not name:
            continue
        filters = "".join(f'["{k}"="{v}"]' for k, v in sorted((spec.get("tags") or {}).items()))
        clause = f'  nwr{filters}["name"~"{_name_pattern(name)}",i]({bbox_text});'
        if clause not in clauses:
            clauses.append(clause)
    return clauses


def build_query(
    bbox: Sequence[float], timeout_s: int = DEFAULT_TIMEOUT_S, landmarks: Sequence[dict[str, Any]] | None = None
) -> str:
    """Overpass QL for the infrastructure-relevant features inside ``(south, west, north, east)``.

    ``landmarks`` (the region's landmarks.json entries) adds a clause per ``osm_match`` spec so
    every landmark the generator tries to match can actually be present in the cache.
    """
    s, w, n, e = (float(v) for v in bbox)
    b = f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"
    return "\n".join(
        [
            f"[out:json][timeout:{int(timeout_s)}];",
            "(",
            f'  way["highway"~"{HIGHWAY_REGEX}"]({b});',
            f'  way["railway"~"^(subway|light_rail|rail)$"]({b});',
            f'  nwr["railway"="station"]({b});',
            f'  nwr["public_transport"="station"]({b});',
            f'  nwr["power"~"^(substation|transformer|line|cable|minor_line|tower)$"]({b});',
            f'  nwr["man_made"~"^(water_tower|storage_tank|pumping_station|water_works)$"]({b});',
            f'  nwr["telecom"]({b});',
            f'  nwr["building"="data_center"]({b});',
            f'  nwr["amenity"~"^(hospital|fire_station|police|townhall|courthouse|university)$"]({b});',
            *landmark_clauses(landmarks or [], b),
            ");",
            "out body geom;",
        ]
    )


def region_landmarks(region_id: str) -> list[dict[str, Any]]:
    path = REGIONS_DIR / region_id / "landmarks.json"
    if not path.exists():
        return []
    return list(json.loads(path.read_text()).get("landmarks", []))


def cache_path(region_id: str) -> Path:
    return CACHE_DIR / "osm" / f"{region_id}.json"


def _parse_ts(value: str) -> datetime | None:
    try:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def cache_age(path: Path, now: datetime | None = None) -> timedelta | None:
    """Age of a cache file from its recorded retrieval time (falls back to mtime)."""
    if not path.exists():
        return None
    now = now or datetime.now(UTC)
    try:
        meta = json.loads(path.read_text()).get("deeptrace_meta") or {}
    except (OSError, ValueError):
        return None
    ts = _parse_ts(str(meta.get("retrieved_at", ""))) if meta.get("retrieved_at") else None
    if ts is None:
        ts = datetime.fromtimestamp(path.stat().st_mtime, UTC)
    return now - ts


def cache_is_fresh(path: Path, max_age_hours: float, now: datetime | None = None) -> bool:
    age = cache_age(path, now)
    return age is not None and age <= timedelta(hours=max_age_hours)


def fetch_overpass(
    query: str,
    url: str,
    *,
    client: httpx.Client | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> dict[str, Any]:
    """POST ``query`` to an Overpass endpoint and return the decoded JSON."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    owns = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(timeout_s + 30, connect=30))
    try:
        response = client.post(url, data={"data": query}, headers=headers)
        if response.status_code == 429:
            raise RuntimeError("Overpass API rate limit (HTTP 429). Wait a few minutes and retry; do not loop.")
        if response.status_code == 504:
            raise RuntimeError("Overpass API timeout (HTTP 504). The server is busy; retry later.")
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:  # JSONDecodeError / UnicodeDecodeError, e.g. an HTML captive portal
            ctype = response.headers.get("content-type", "unknown")
            raise RuntimeError(
                f"Overpass returned a non-JSON response (HTTP {response.status_code}, {ctype}) from {url}; "
                "check DEEPTRACE_OVERPASS_URL or any proxy / captive portal"
            ) from exc
    finally:
        if owns:
            client.close()
    if not isinstance(data, dict) or "elements" not in data:
        raise RuntimeError("Unexpected Overpass response: no 'elements' array")
    remark = data.get("remark")
    if remark and "error" in str(remark).lower():
        raise RuntimeError(f"Overpass reported an error: {remark}")
    return data


def ingest_region(
    region_id: str | None = None,
    *,
    force: bool = False,
    max_age_hours: float = DEFAULT_MAX_AGE_HOURS,
    url: str | None = None,
    client: httpx.Client | None = None,
    now: datetime | None = None,
    out_path: Path | None = None,
) -> tuple[Path, bool]:
    """Fetch (or reuse) the cached Overpass extract for a region.

    Returns ``(cache_path, fetched)`` where ``fetched`` is False when a fresh cache was reused.
    """
    region = load_region(region_id)
    path = out_path or cache_path(region.id)
    if not force and cache_is_fresh(path, max_age_hours, now):
        return path, False
    url = url or get_settings().overpass_url
    query = build_query(region.bbox, landmarks=region_landmarks(region.id))
    data = fetch_overpass(query, url, client=client)
    retrieved = (now or datetime.now(UTC)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    data["deeptrace_meta"] = {
        "region": region.id,
        "bbox": list(region.bbox),
        "retrieved_at": retrieved,
        "overpass_url": url,
        "user_agent": USER_AGENT,
        "query": query,
        "attribution": "© OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "element_count": len(data.get("elements", [])),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)
    return path, True


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch and cache OpenStreetMap data for a DEEPTRACE region (Overpass API).")
    parser.add_argument("--region", default=None, help="Region id (default: DEEPTRACE_REGION or atlanta-downtown)")
    parser.add_argument("--force", action="store_true", help="Ignore a fresh cache and fetch again")
    parser.add_argument(
        "--max-age-hours",
        type=float,
        default=float(os.getenv("DEEPTRACE_OVERPASS_MAX_AGE_HOURS", DEFAULT_MAX_AGE_HOURS)),
        help=f"Reuse a cache younger than this (default {DEFAULT_MAX_AGE_HOURS} h)",
    )
    parser.add_argument("--url", default=None, help="Overpass interpreter URL (default: DEEPTRACE_OVERPASS_URL)")
    parser.add_argument("--print-query", action="store_true", help="Print the Overpass QL query and exit")
    args = parser.parse_args(argv)

    if args.print_query:
        region = load_region(args.region)
        print(build_query(region.bbox, landmarks=region_landmarks(region.id)))
        return 0
    try:
        path, fetched = ingest_region(args.region, force=args.force, max_age_hours=args.max_age_hours, url=args.url)
    except (httpx.HTTPError, RuntimeError) as exc:
        print(f"Overpass ingestion failed: {exc}", file=sys.stderr)
        return 1
    meta = json.loads(path.read_text()).get("deeptrace_meta", {})
    state = "fetched" if fetched else "reused fresh cache"
    print(f"{state}: {path} ({meta.get('element_count', '?')} elements, retrieved {meta.get('retrieved_at')})")
    print("Next: python -m app.networks.generate --use-osm")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
