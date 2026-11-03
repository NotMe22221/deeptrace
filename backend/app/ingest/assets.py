"""Fetch CC0 3D models from Poly Haven for DEEPTRACE node types.

Usage (from ``backend/``)::

    python -m app.ingest.assets [--types pump_station,storage_tank] [--resolution 1k] [--dry-run]

For each node type a keyword list is scored against Poly Haven's model catalogue
(``GET https://api.polyhaven.com/assets?t=models``); the best match's glTF files
(``GET /files/{id}`` -> ``gltf -> <resolution> -> gltf {url, include}``) are downloaded to
``public/assets/models/<id>/`` and registered in ``public/assets/models/manifest.json``::

    {"version": 1, "models": {"<node_type>": {"uri": "/assets/models/<id>/<file>.gltf", "scale": 1.0,
      "heightOffset": 0, "headingDeg": 0, "credit": "<name> — Poly Haven (CC0)",
      "source_url": "https://polyhaven.com/a/<id>", "license": "CC0-1.0"}}}

A credits table is written into the "## Downloaded 3D models" section of
``ASSET_CREDITS.md`` (other sections are left untouched). Poly Haven assets are CC0;
crediting them is courtesy, not a licence requirement.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

import httpx

from app.config import REPO_ROOT

API_BASE = "https://api.polyhaven.com"
SITE_BASE = "https://polyhaven.com/a"
MODELS_DIR = REPO_ROOT / "public" / "assets" / "models"
MANIFEST_PATH = MODELS_DIR / "manifest.json"
CREDITS_PATH = REPO_ROOT / "ASSET_CREDITS.md"
CREDITS_HEADING = "## Downloaded 3D models"
USER_AGENT = os.getenv("DEEPTRACE_ASSETS_USER_AGENT", "DEEPTRACE-assets/1.0 (infrastructure digital-twin demo)")
MAX_FILE_BYTES = 60 * 1024 * 1024

# Keywords per DEEPTRACE node type, most specific first. Types without keywords are skipped
# (buildings, zones and similar are better represented by footprints / OSM buildings).
TYPE_KEYWORDS: dict[str, list[str]] = {
    "transmission_substation": ["substation", "transformer", "electrical", "electric", "industrial"],
    "distribution_substation": ["transformer", "electrical", "electric", "industrial"],
    "switch": ["electrical box", "fuse box", "switch", "electric", "box"],
    "network_vault": ["manhole", "grate", "vent", "electrical"],
    "pump_station": ["pump", "pipe", "machine", "industrial"],
    "storage_tank": ["water tower", "tank", "silo", "barrel"],
    "valve": ["valve", "hydrant", "pipe"],
    "supply_source": ["pipe", "valve", "industrial"],
    "internet_exchange": ["server", "rack", "computer"],
    "data_center": ["server", "rack", "computer"],
    "central_office": ["server", "rack", "electrical box", "cabinet"],
    "fiber_hub": ["cabinet", "electrical box", "box"],
    "access_node": ["cabinet", "electrical box", "box"],
    "cell_site": ["antenna", "satellite", "radio", "tower"],
    "intersection": ["traffic light", "traffic", "street light", "lamp"],
    "gateway": ["road sign", "barrier", "traffic cone", "sign"],
    "transit_station": ["bench", "train", "station"],
    "utility_vault": ["manhole", "grate"],
    "hospital": ["medical", "hospital", "first aid"],
    "emergency_services": ["fire extinguisher", "fire", "hydrant"],
}

# Optional scale hints so small props read at map scale (models are real-world metres).
SCALE_HINTS: dict[str, float] = {
    "transmission_substation": 2.0,
    "distribution_substation": 1.5,
    "storage_tank": 4.0,
    "pump_station": 1.5,
}


class AssetError(RuntimeError):
    pass


def _client(client: httpx.Client | None) -> tuple[httpx.Client, bool]:
    if client is not None:
        return client, False
    return httpx.Client(timeout=httpx.Timeout(120, connect=20), headers={"User-Agent": USER_AGENT}, follow_redirects=True), True


def get_json(client: httpx.Client, url: str) -> Any:
    response = client.get(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    response.raise_for_status()
    try:
        return response.json()
    except ValueError as exc:  # e.g. an HTML captive portal answering with HTTP 200
        raise AssetError(f"non-JSON response from {url} (HTTP {response.status_code})") from exc


def normalise_catalog(raw: Any) -> dict[str, dict[str, Any]]:
    """Accept ``{id: info}`` (current API) or a list of ``{"id": ...}`` records."""
    if isinstance(raw, dict):
        return {str(k): v for k, v in raw.items() if isinstance(v, dict)}
    if isinstance(raw, list):
        return {str(v["id"]): v for v in raw if isinstance(v, dict) and v.get("id")}
    raise AssetError("Unexpected Poly Haven catalogue format")


def _terms(info: dict[str, Any], key: str) -> list[str]:
    value = info.get(key) or []
    if isinstance(value, str):
        value = [value]
    if isinstance(value, dict):
        value = list(value)
    return [str(v).lower() for v in value]


def score_asset(asset_id: str, info: dict[str, Any], keywords: Sequence[str]) -> float:
    """Keyword score: tags 3, categories 2, name/id words 1; earlier keywords weigh more."""
    tags = _terms(info, "tags")
    cats = _terms(info, "categories")
    name = f"{info.get('name', '')} {asset_id.replace('_', ' ')}".lower()
    total = 0.0
    for rank, kw in enumerate(keywords):
        weight = 1.0 + 0.25 * (len(keywords) - rank)
        kw = kw.lower()
        if kw in tags:
            total += 3 * weight
        elif any(kw in t for t in tags):
            total += 2 * weight
        if kw in cats or any(kw in c for c in cats):
            total += 2 * weight
        if re.search(rf"\b{re.escape(kw)}\b", name):
            total += 1 * weight
    return total


def rank_assets(catalog: dict[str, dict[str, Any]], keywords: Sequence[str], min_score: float = 2.0) -> list[str]:
    scored = []
    for asset_id, info in catalog.items():
        s = score_asset(asset_id, info, keywords)
        if s >= min_score:
            scored.append((-s, -int(info.get("download_count") or 0), asset_id))
    return [a for _, _, a in sorted(scored)]


def safe_relpath(path: str) -> PurePosixPath | None:
    """Reject absolute paths, parent traversal and odd characters in include paths."""
    if not path or "\\" in path or path.startswith("/") or re.match(r"^[a-zA-Z]:", path):
        return None
    p = PurePosixPath(path)
    if any(part in ("", ".", "..") for part in p.parts):
        return None
    if not re.fullmatch(r"[A-Za-z0-9._\-/ ]+", path):
        return None
    return p


def gltf_entry(files: dict[str, Any], resolution: str = "1k") -> tuple[str, dict[str, str]]:
    """Return ``(gltf_url, {relative_include_path: url})`` from a ``/files/{id}`` tree."""
    gltf = files.get("gltf") if isinstance(files, dict) else None
    if not isinstance(gltf, dict) or not gltf:
        raise AssetError("asset has no glTF files")
    order = [resolution] + sorted((r for r in gltf if r != resolution), key=lambda r: int(re.sub(r"\D", "", r) or 99))
    for res in order:
        node = gltf.get(res)
        if not isinstance(node, dict):
            continue
        entry = node.get("gltf") if isinstance(node.get("gltf"), dict) else None
        if entry is None:  # tolerate {"<res>": {"url": ..., "include": ...}}
            entry = node if "url" in node else None
        if not entry or not entry.get("url"):
            continue
        includes: dict[str, str] = {}
        for rel, inc in (entry.get("include") or {}).items():
            url = inc.get("url") if isinstance(inc, dict) else inc
            if isinstance(url, str) and url:
                includes[str(rel)] = url
        return str(entry["url"]), includes
    raise AssetError("no usable glTF resolution")


def _download(client: httpx.Client, url: str, dest: Path) -> int:
    if not url.startswith("https://"):
        raise AssetError(f"refusing non-HTTPS download {url}")
    with client.stream("GET", url, headers={"User-Agent": USER_AGENT}) as response:
        response.raise_for_status()
        dest.parent.mkdir(parents=True, exist_ok=True)
        size = 0
        tmp = dest.with_name(dest.name + ".part")
        with tmp.open("wb") as fh:
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise AssetError(f"{url} exceeds {MAX_FILE_BYTES} bytes")
                fh.write(chunk)
        tmp.replace(dest)
    return size


def download_model(
    client: httpx.Client, asset_id: str, files: dict[str, Any], models_dir: Path, resolution: str = "1k"
) -> tuple[str, list[str]]:
    """Download one model's glTF + includes. Returns ``(gltf_file_name, relative_files)``."""
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", asset_id):
        raise AssetError(f"unsafe asset id {asset_id!r}")
    gltf_url, includes = gltf_entry(files, resolution)
    gltf_name = PurePosixPath(httpx.URL(gltf_url).path).name or f"{asset_id}.gltf"
    if safe_relpath(gltf_name) is None or not gltf_name.endswith(".gltf"):
        gltf_name = f"{asset_id}.gltf"
    safe_includes: list[tuple[PurePosixPath, str]] = []
    for rel, url in sorted(includes.items()):  # validate everything before writing anything
        safe = safe_relpath(rel)
        if safe is None:
            raise AssetError(f"unsafe include path {rel!r} in {asset_id}")
        safe_includes.append((safe, url))
    root = models_dir / asset_id
    written = []
    _download(client, gltf_url, root / gltf_name)
    written.append(gltf_name)
    for safe, url in safe_includes:
        _download(client, url, root / Path(*safe.parts))
        written.append(str(safe))
    return gltf_name, written


def manifest_entry(node_type: str, asset_id: str, name: str, gltf_name: str) -> dict[str, Any]:
    return {
        "uri": f"/assets/models/{asset_id}/{gltf_name}",
        "scale": SCALE_HINTS.get(node_type, 1.0),
        "heightOffset": 0,
        "headingDeg": 0,
        "credit": f"{name} — Poly Haven (CC0)",
        "source_url": f"{SITE_BASE}/{asset_id}",
        "license": "CC0-1.0",
    }


def read_manifest(path: Path) -> dict[str, Any]:
    if path.exists():
        try:
            data = json.loads(path.read_text())
            if isinstance(data, dict) and isinstance(data.get("models"), dict):
                return {"version": 1, "models": dict(data["models"])}
        except ValueError:
            pass
    return {"version": 1, "models": {}}


def write_manifest(path: Path, models: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "models": dict(sorted(models.items()))}, indent=2, ensure_ascii=False) + "\n")


def credits_table(rows: Iterable[dict[str, Any]]) -> str:
    lines = ["| Model | Used for | Source | License | Files |", "| --- | --- | --- | --- | --- |"]
    for r in rows:
        files = ", ".join(f"`{f}`" for f in r["files"])
        lines.append(f"| {r['name']} | {', '.join(r['types'])} | {r['source_url']} | CC0-1.0 | {files} |")
    return "\n".join(lines)


def credit_rows(models: dict[str, Any], models_dir: Path) -> list[dict[str, Any]]:
    """One credits row per downloaded asset referenced by the manifest."""
    by_asset: dict[str, dict[str, Any]] = {}
    for node_type, entry in sorted(models.items()):
        parts = str(entry.get("uri", "")).removeprefix("/assets/models/").split("/")
        if len(parts) < 2:
            continue
        asset_id = parts[0]
        row = by_asset.setdefault(
            asset_id,
            {
                "name": str(entry.get("credit", asset_id)).split(" \u2014 ")[0],
                "types": [],
                "source_url": entry.get("source_url") or f"{SITE_BASE}/{asset_id}",
                "files": sorted(
                    str(f.relative_to(models_dir / asset_id).as_posix())
                    for f in (models_dir / asset_id).rglob("*")
                    if f.is_file() and not f.name.endswith(".part")
                ),
            },
        )
        row["types"].append(node_type)
    return [by_asset[k] for k in sorted(by_asset)]


def update_credits(path: Path, rows: list[dict[str, Any]]) -> None:
    """Replace the body of the '## Downloaded 3D models' section (create it if missing)."""
    text = path.read_text() if path.exists() else "# Asset credits\n"
    body = (
        "Models downloaded by `python -m app.ingest.assets` from Poly Haven (https://polyhaven.com), "
        "released under CC0 1.0 (public domain). Attribution is given as a courtesy.\n\n" + credits_table(rows) + "\n"
        if rows
        else "_None downloaded in this build._\n"
    )
    lines = text.split("\n")
    start = next((i for i, line in enumerate(lines) if line.strip() == CREDITS_HEADING), None)
    if start is None:
        new_text = text.rstrip("\n") + f"\n\n{CREDITS_HEADING}\n\n{body}"
    else:
        end = next((j for j in range(start + 1, len(lines)) if lines[j].startswith("## ")), len(lines))
        before = "\n".join(lines[: start + 1])
        after = "\n".join(lines[end:])
        new_text = before + "\n\n" + body + ("\n" + after if after.strip() else "")
    path.write_text(new_text if new_text.endswith("\n") else new_text + "\n")


def fetch_models(
    types: Sequence[str] | None = None,
    *,
    resolution: str = "1k",
    models_dir: Path = MODELS_DIR,
    manifest_path: Path | None = None,
    credits_path: Path = CREDITS_PATH,
    client: httpx.Client | None = None,
    dry_run: bool = False,
    log: Any = print,
) -> dict[str, Any]:
    """Select, download and register models. Returns the manifest written (or planned)."""
    manifest_path = manifest_path or models_dir / "manifest.json"
    wanted = list(types) if types else list(TYPE_KEYWORDS)
    http, owns = _client(client)
    try:
        catalog = normalise_catalog(get_json(http, f"{API_BASE}/assets?t=models"))
        manifest = read_manifest(manifest_path)
        models: dict[str, Any] = {
            k: v
            for k, v in manifest["models"].items()
            if isinstance(v, dict) and (models_dir / str(v.get("uri", "")).removeprefix("/assets/models/")).exists()
        }
        downloaded: dict[str, dict[str, Any]] = {}
        files_cache: dict[str, Any] = {}
        for node_type in wanted:
            keywords = TYPE_KEYWORDS.get(node_type)
            if not keywords:
                log(f"skip {node_type}: no keywords")
                continue
            candidates = rank_assets(catalog, keywords)
            if not candidates:
                log(f"skip {node_type}: no matching Poly Haven model")
                continue
            for asset_id in candidates[:5]:
                info = catalog[asset_id]
                name = str(info.get("name") or asset_id)
                if dry_run:
                    log(f"{node_type}: would use {asset_id} ({name})")
                    models[node_type] = manifest_entry(node_type, asset_id, name, f"{asset_id}_{resolution}.gltf")
                    break
                try:
                    if asset_id in downloaded:
                        gltf_name = downloaded[asset_id]["gltf"]
                    else:
                        if asset_id not in files_cache:
                            files_cache[asset_id] = get_json(http, f"{API_BASE}/files/{asset_id}")
                        gltf_name, written = download_model(http, asset_id, files_cache[asset_id], models_dir, resolution)
                        downloaded[asset_id] = {"gltf": gltf_name, "files": written, "name": name, "types": []}
                except (AssetError, httpx.HTTPError, ValueError) as exc:
                    log(f"{node_type}: {asset_id} unusable ({exc}); trying next candidate")
                    continue
                downloaded[asset_id]["types"].append(node_type)
                models[node_type] = manifest_entry(node_type, asset_id, name, gltf_name)
                log(f"{node_type}: {asset_id} ({name})")
                break
        if not dry_run:
            write_manifest(manifest_path, models)
            update_credits(credits_path, credit_rows(models, models_dir))
        return {"version": 1, "models": dict(sorted(models.items()))}
    finally:
        if owns:
            http.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download CC0 glTF models from Poly Haven for DEEPTRACE node types.")
    parser.add_argument("--types", default="", help="Comma-separated node types (default: all with keywords)")
    parser.add_argument("--resolution", default="1k", help="Texture resolution to download (default 1k)")
    parser.add_argument("--dry-run", action="store_true", help="Only show which models would be used")
    args = parser.parse_args(argv)
    types = [t.strip() for t in args.types.split(",") if t.strip()] or None
    try:
        manifest = fetch_models(types, resolution=args.resolution, dry_run=args.dry_run)
    except (httpx.HTTPError, AssetError) as exc:
        print(f"Poly Haven download failed: {exc}", file=sys.stderr)
        return 1
    print(f"{'planned' if args.dry_run else 'registered'} {len(manifest['models'])} model(s) in {MANIFEST_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
