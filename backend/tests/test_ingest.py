"""Ingestion tests: Overpass fetch/cache, OSM normalisation, the --use-osm generator path
and the Poly Haven asset fetcher. No network access: HTTP is mocked with httpx.MockTransport
and OSM input comes from a synthetic fixture (tests/fixtures/overpass_sample.json)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import networkx as nx
import pytest

from app.config import REGIONS_DIR
from app.ingest import assets, overpass
from app.ingest.normalize import load_raw, normalize_overpass, parse_maxspeed_kph
from app.networks.checks import check_network
from app.networks.generate import generate_region
from app.networks.loader import load_region
from app.networks.streetgraph import build_street_graph

FIXTURE = Path(__file__).parent / "fixtures" / "overpass_sample.json"
REGION = "atlanta-downtown"


@pytest.fixture(scope="module")
def raw() -> dict:
    return load_raw(FIXTURE)


@pytest.fixture(scope="module")
def bbox() -> tuple[float, float, float, float]:
    return load_region(REGION).bbox


def test_fixture_is_marked_synthetic(raw: dict) -> None:
    assert "SYNTHETIC" in raw["_comment"] and "NOT real OpenStreetMap" in raw["_comment"]


# --------------------------------------------------------------------------- overpass


def test_build_query_covers_bbox_and_feature_classes(bbox) -> None:
    q = overpass.build_query(bbox)
    assert q.startswith("[out:json]")
    assert "33.742500,-84.408500,33.774000,-84.371500" in q
    for needle in ('"highway"', '"railway"~"^(subway|light_rail|rail)$"', '"public_transport"="station"',
                   '"power"~"^(substation', "water_tower", "pumping_station", '"telecom"', '"building"="data_center"',
                   "hospital|fire_station|police", "out body geom;"):  # fmt: skip
        assert needle in q, needle


def _overpass_transport(calls: list[httpx.Request], status: int = 200) -> httpx.MockTransport:
    payload = json.loads(FIXTURE.read_text())

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if status != 200:
            return httpx.Response(status, text="busy")
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handler)


def test_ingest_fetches_and_caches_with_metadata(tmp_path: Path) -> None:
    calls: list[httpx.Request] = []
    now = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
    out = tmp_path / "osm" / f"{REGION}.json"
    with httpx.Client(transport=_overpass_transport(calls)) as client:
        path, fetched = overpass.ingest_region(REGION, client=client, now=now, out_path=out, url="https://overpass.test/api/interpreter")
    assert fetched and path == out and len(calls) == 1
    req = calls[0]
    assert req.method == "POST" and str(req.url) == "https://overpass.test/api/interpreter"
    assert "DEEPTRACE" in req.headers["user-agent"]
    assert b"data=" in req.content and b"out+body+geom" in req.content
    cached = json.loads(out.read_text())
    meta = cached["deeptrace_meta"]
    assert meta["retrieved_at"] == "2026-10-01T12:00:00Z"
    assert meta["region"] == REGION and meta["license"] == "ODbL-1.0"
    assert meta["element_count"] == len(cached["elements"])


def test_ingest_reuses_fresh_cache_without_http(tmp_path: Path) -> None:
    out = tmp_path / f"{REGION}.json"
    now = datetime(2026, 10, 1, tzinfo=UTC)
    calls: list[httpx.Request] = []
    with httpx.Client(transport=_overpass_transport(calls)) as client:
        overpass.ingest_region(REGION, client=client, now=now, out_path=out)
        path, fetched = overpass.ingest_region(REGION, client=client, now=now + timedelta(hours=5), out_path=out)
        assert not fetched and len(calls) == 1
        # stale cache -> refetch
        _, fetched = overpass.ingest_region(REGION, client=client, now=now + timedelta(days=30), out_path=out)
        assert fetched and len(calls) == 2
        # --force always refetches
        _, fetched = overpass.ingest_region(REGION, client=client, now=now + timedelta(days=30), out_path=out, force=True)
        assert fetched and len(calls) == 3


def test_ingest_reports_rate_limit(tmp_path: Path) -> None:
    calls: list[httpx.Request] = []
    with httpx.Client(transport=_overpass_transport(calls, status=429)) as client, pytest.raises(RuntimeError, match="429"):
        overpass.ingest_region(REGION, client=client, out_path=tmp_path / "x.json")
    assert not (tmp_path / "x.json").exists()


def test_cli_print_query(capsys) -> None:
    assert overpass.main(["--print-query"]) == 0
    assert "[out:json]" in capsys.readouterr().out


# --------------------------------------------------------------------------- normalise


def test_parse_maxspeed() -> None:
    assert parse_maxspeed_kph("25 mph") == pytest.approx(40.2, abs=0.1)
    assert parse_maxspeed_kph("50") == 50
    assert parse_maxspeed_kph("40 km/h") == 40
    assert parse_maxspeed_kph("signals") is None


def test_normalize_streets(raw: dict, bbox) -> None:
    norm = normalize_overpass(raw, bbox)
    streets = {s["id"]: s for s in norm["streets"]}
    # footway and service roads are excluded; the motorway and its ramp are kept
    assert set(streets) == {f"OSM-W{i}" for i in range(2001, 2009)}
    pt = streets["OSM-W2002"]
    assert len(pt["coordinates"]) == 3, "vertex outside the bbox is clipped"
    assert pt["node_refs"] == [1002, 1005, 1008]
    assert pt["coordinates"][0] == [-84.39, 33.76]
    assert streets["OSM-W2005"]["speed_kph"] == pytest.approx(40.2, abs=0.1)
    assert streets["OSM-W2003"]["oneway"] is True
    assert streets["OSM-W2007"]["class"] == "motorway"
    prov = pt["provenance"]
    assert prov["category"] == "publicly_mapped"
    assert prov["source"] == "OpenStreetMap contributors via Overpass API"
    assert prov["license"] == "ODbL-1.0"
    assert prov["source_url"] == "https://www.openstreetmap.org/way/2002"
    assert prov["retrieved_at"] == "2026-01-01T00:00:00Z"
    assert 0.8 <= prov["confidence"] <= 0.9


def test_normalize_points_and_lines(raw: dict, bbox) -> None:
    norm = normalize_overpass(raw, bbox)
    kinds = {p["osm_id"]: p["kind"] for p in norm["points"]}
    assert kinds["node/3001"] == "substation"
    assert kinds["way/3002"] == "substation"  # polygon -> centroid
    assert kinds["node/3003"] == "water_tower"
    assert kinds["node/3004"] == "telecom_exchange"
    assert kinds["node/3005"] == "hospital"
    assert kinds["node/3006"] == "station"
    assert "node/3009" not in kinds, "points outside the bbox are dropped"
    sub_b = next(p for p in norm["points"] if p["osm_id"] == "way/3002")
    assert sub_b["lat"] == pytest.approx(33.747, abs=1e-3)
    assert {ln["kind"] for ln in norm["lines"]} == {"line", "subway"}
    assert norm["meta"]["counts"]["streets"] == 8


def test_street_graph_from_osm_is_topological(raw: dict, bbox) -> None:
    norm = normalize_overpass(raw, bbox)
    g = build_street_graph(norm["streets"], center=(-84.3905, 33.758))
    # 9 grid corners + both motorway ends; the motorway only joins the grid through its ramp
    assert len(g.nodes) == 11
    assert nx.is_connected(g.graph)
    motorway_ends = [n for n in g.nodes.values() if "motorway" in n.classes]
    assert all(n.degree <= 2 for n in motorway_ends)
    assert len(g.surface_graph.nodes) == 9


# --------------------------------------------------------------------------- generator --use-osm


def test_generate_with_osm_fixture(tmp_path: Path) -> None:
    region_dir = REGIONS_DIR / REGION
    before = {p.name: p.read_bytes() for p in region_dir.glob("*.json")}
    network, presets, demo, _ = generate_region(region_dir, out_dir=tmp_path, use_osm=True, osm_cache=FIXTURE, mirror_dir=None)
    after = {p.name: p.read_bytes() for p in region_dir.glob("*.json")}
    assert before == after, "tests must not overwrite the real dataset"
    assert (tmp_path / "network.json").exists() and (tmp_path / "scenarios.json").exists() and (tmp_path / "demo.json").exists()
    assert check_network(network, presets=presets, demo=demo) == []

    nodes = {n["id"]: n for n in network["nodes"]}
    roads = [e for e in network["edges"] if e["connection_type"] == "road_segment"]
    assert roads and all(e["provenance"]["category"] == "publicly_mapped" for e in roads)
    # mapped features position modelled assets; their role/topology stays simulated (stated in notes)
    ds = nodes["PWR-DS-FIVEPOINTS"]["provenance"]
    assert ds["category"] == "publicly_mapped" and ds["source_url"].endswith("/node/3001")
    assert "SIMULATED" in ds["notes"]
    assert nodes["PWR-TS-SOUTH"]["provenance"]["source_url"].endswith("/way/3002")
    assert nodes["WTR-TNK-NORTH"]["provenance"]["category"] == "publicly_mapped"
    assert nodes["FAC-GRADY"]["provenance"]["source_url"].endswith("/node/3005")
    assert nodes["TRN-STN-FIVEPOINTS"]["provenance"]["source_url"].endswith("/node/3006")
    assert nodes["PWR-DS-CIVIC"]["provenance"]["category"] == "simulated"
    deps = [e for e in network["edges"] if e["relation"] == "dependency"]
    assert all(e["provenance"]["category"] == "simulated" for e in deps)
    osm_ds = next(d for d in network["datasets"] if d["id"] == "osm-overpass")
    assert osm_ds["inspected"] is True and osm_ds["feature_count"] > 0 and osm_ds["retrieved_at"] == "2026-01-01T00:00:00Z"
    assert not any(d["id"] == "authored-streets" for d in network["datasets"])


def test_generate_with_osm_requires_cache(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="app.ingest.overpass"):
        generate_region(REGIONS_DIR / REGION, out_dir=tmp_path, use_osm=True, osm_cache=tmp_path / "missing.json")


# --------------------------------------------------------------------------- Poly Haven assets

CATALOG = {
    "industrial_pump": {"name": "Industrial Pump", "categories": ["props", "industrial"], "tags": ["pump", "pipe", "machine"], "download_count": 50},
    "water_tank_01": {"name": "Water Tank 01", "categories": ["props"], "tags": ["tank", "water tower", "metal"], "download_count": 10},
    "wooden_chair": {"name": "Wooden Chair", "categories": ["furniture"], "tags": ["chair", "wood"], "download_count": 900},
    "evil": {"name": "Bad includes", "categories": ["props"], "tags": ["valve"], "download_count": 1},
}


def _files_tree(asset_id: str) -> dict:
    base = f"https://dl.polyhaven.test/file/ph-assets/Models/gltf/1k/{asset_id}"
    include = {f"textures/{asset_id}_diff_1k.jpg": {"url": f"{base}/textures/{asset_id}_diff_1k.jpg", "size": 3}, f"{asset_id}.bin": {"url": f"{base}/{asset_id}.bin", "size": 3}}
    if asset_id == "evil":
        include = {"../../escape.txt": {"url": f"{base}/escape.txt"}}
    return {"gltf": {"1k": {"gltf": {"url": f"{base}/{asset_id}_1k.gltf", "size": 10, "include": include}}}, "blend": {}}


def _polyhaven_transport(seen: list[str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen.append(url)
        assert "DEEPTRACE" in request.headers.get("user-agent", "")
        if url.startswith("https://api.polyhaven.com/assets"):
            assert request.url.params.get("t") == "models"
            return httpx.Response(200, json=CATALOG)
        if url.startswith("https://api.polyhaven.com/files/"):
            return httpx.Response(200, json=_files_tree(url.rsplit("/", 1)[1]))
        if url.startswith("https://dl.polyhaven.test/"):
            return httpx.Response(200, content=b"ok!")
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def test_rank_assets_and_gltf_parsing() -> None:
    assert assets.rank_assets(CATALOG, assets.TYPE_KEYWORDS["pump_station"])[0] == "industrial_pump"
    assert assets.rank_assets(CATALOG, assets.TYPE_KEYWORDS["storage_tank"])[0] == "water_tank_01"
    assert assets.rank_assets(CATALOG, ["chair"]) == ["wooden_chair"]
    url, inc = assets.gltf_entry(_files_tree("industrial_pump"))
    assert url.endswith("industrial_pump_1k.gltf") and len(inc) == 2
    # tolerate a missing requested resolution and the flat {"url", "include"} shape
    url2, _ = assets.gltf_entry({"gltf": {"2k": {"url": "https://x.test/a_2k.gltf", "include": {}}}}, "1k")
    assert url2.endswith("a_2k.gltf")
    with pytest.raises(assets.AssetError):
        assets.gltf_entry({"blend": {}})
    assert assets.normalise_catalog([{"id": "a", "name": "A"}]) == {"a": {"id": "a", "name": "A"}}


def test_safe_relpath_rejects_traversal() -> None:
    assert assets.safe_relpath("textures/a_1k.jpg") is not None
    for bad in ("../x", "/etc/passwd", "a/../../b", "C:/x", "a\\b", ""):
        assert assets.safe_relpath(bad) is None, bad


def test_fetch_models_writes_manifest_and_credits(tmp_path: Path) -> None:
    models_dir = tmp_path / "models"
    credits = tmp_path / "ASSET_CREDITS.md"
    credits.write_text("# Asset credits\n\n## Fonts\n\nInter (OFL).\n\n## Downloaded 3D models\n\n_None downloaded in this build._\n")
    seen: list[str] = []
    with httpx.Client(transport=_polyhaven_transport(seen)) as client:
        manifest = assets.fetch_models(
            ["pump_station", "storage_tank", "valve", "service_zone"],
            models_dir=models_dir, credits_path=credits, client=client, log=lambda *_: None,
        )  # fmt: skip
    written = json.loads((models_dir / "manifest.json").read_text())
    assert written == manifest
    assert set(written) == {"version", "models"} and written["version"] == 1
    assert set(written["models"]) == {"pump_station", "storage_tank", "valve"}
    # the best valve match had unsafe include paths -> skipped, falls back to the next candidate
    assert written["models"]["valve"]["source_url"].endswith("/industrial_pump")
    assert not (models_dir / "evil").exists()
    pump = written["models"]["pump_station"]
    assert pump == {
        "uri": "/assets/models/industrial_pump/industrial_pump_1k.gltf",
        "scale": assets.SCALE_HINTS["pump_station"],
        "heightOffset": 0,
        "headingDeg": 0,
        "credit": "Industrial Pump \u2014 Poly Haven (CC0)",
        "source_url": "https://polyhaven.com/a/industrial_pump",
        "license": "CC0-1.0",
    }
    assert (models_dir / "industrial_pump" / "industrial_pump_1k.gltf").read_bytes() == b"ok!"
    assert (models_dir / "industrial_pump" / "textures" / "industrial_pump_diff_1k.jpg").exists()
    assert not (tmp_path / "escape.txt").exists() and not (models_dir.parent / "escape.txt").exists()
    text = credits.read_text()
    assert "## Fonts\n\nInter (OFL)." in text, "other sections untouched"
    assert "_None downloaded in this build._" not in text
    assert "| Industrial Pump | pump_station, valve | https://polyhaven.com/a/industrial_pump | CC0-1.0 |" in text
    assert text.count("## Downloaded 3D models") == 1


def test_update_credits_appends_missing_section(tmp_path: Path) -> None:
    credits = tmp_path / "ASSET_CREDITS.md"
    credits.write_text("# Credits\n\n## Other\n\nkeep me\n")
    assets.update_credits(credits, [{"name": "M", "types": ["valve"], "source_url": "https://polyhaven.com/a/m", "files": ["m.gltf"]}])
    text = credits.read_text()
    assert text.startswith("# Credits\n\n## Other\n\nkeep me\n")
    assert text.rstrip().endswith("| M | valve | https://polyhaven.com/a/m | CC0-1.0 | `m.gltf` |")


def test_dry_run_does_not_write(tmp_path: Path) -> None:
    seen: list[str] = []
    with httpx.Client(transport=_polyhaven_transport(seen)) as client:
        planned = assets.fetch_models(["pump_station"], models_dir=tmp_path / "m", credits_path=tmp_path / "c.md", client=client, dry_run=True, log=lambda *_: None)
    assert "pump_station" in planned["models"]
    assert not (tmp_path / "m").exists() and not (tmp_path / "c.md").exists()
    assert not any("/files/" in u for u in seen)
