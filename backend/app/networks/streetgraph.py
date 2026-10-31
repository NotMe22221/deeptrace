"""Street / intersection graph built from street centreline polylines.

The same graph serves two purposes in DEEPTRACE:

* it *is* the transport network (intersections = nodes, street blocks = edges), and
* it provides the routing corridors that utility cables and pipes follow, so that
  feeders, mains and fibre runs are drawn along streets instead of as straight lines.

Two noding strategies are supported and can be mixed:

* **Geometric** (authored centrelines): proper crossings between polylines become
  intersections; feature endpoints that stop just short of / just past another street
  are snapped onto it (T-junctions); points closer than ``snap_m`` are merged.
* **Topological** (OpenStreetMap ways carrying ``node_refs``): ways are noded where they
  share OSM node ids, which respects bridges and tunnels exactly.

Grade separation is respected in geometric mode: motorways never form at-grade
intersections with surface streets (they only connect through ``*_link`` ramps), and
features flagged ``bridge``/``tunnel`` or on a different ``layer`` do not cross.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import networkx as nx

from app.networks.geo import (
    LocalProjection,
    LonLat,
    dedupe_consecutive,
    nearest_point_on_polyline,
    nearest_point_on_polyline_xy,
    offset_polyline,
    polyline_length_m,
    segment_intersection,
    substring,
)

MOTORWAY_CLASSES = frozenset({"motorway", "trunk"})
LINK_CLASSES = frozenset({"motorway_link", "trunk_link"})
HIGHWAY_CLASSES = MOTORWAY_CLASSES | LINK_CLASSES

# Lower rank = more important (used to order names at an intersection).
CLASS_RANK = {
    "motorway": 0,
    "trunk": 1,
    "motorway_link": 2,
    "trunk_link": 2,
    "primary": 3,
    "primary_link": 3,
    "secondary": 4,
    "secondary_link": 4,
    "tertiary": 5,
    "tertiary_link": 5,
    "unclassified": 6,
    "residential": 7,
}


@dataclass
class StreetFeature:
    id: str
    name: str
    cls: str
    coords: list[LonLat]
    lanes: int | None = None
    oneway: bool | None = None
    speed_kph: float | None = None
    provenance: dict[str, Any] = field(default_factory=dict)
    node_refs: list[Any] | None = None
    layer: int = 0
    bridge: bool = False
    tunnel: bool = False
    properties: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StreetFeature:
        coords = [(float(c[0]), float(c[1])) for c in d["coordinates"]]
        refs = d.get("node_refs")
        return cls(
            id=str(d["id"]),
            name=str(d.get("name") or d["id"]),
            cls=str(d.get("class", "tertiary")),
            coords=coords,
            lanes=d.get("lanes"),
            oneway=d.get("oneway"),
            speed_kph=d.get("speed_kph"),
            provenance=dict(d.get("provenance") or {}),
            node_refs=list(refs) if refs and len(refs) == len(coords) else None,
            layer=int(d.get("layer") or 0),
            bridge=bool(d.get("bridge", False)),
            tunnel=bool(d.get("tunnel", False)),
            properties=dict(d.get("properties") or {}),
        )

    @property
    def is_motorway(self) -> bool:
        return self.cls in MOTORWAY_CLASSES

    @property
    def is_link(self) -> bool:
        return self.cls in LINK_CLASSES

    @property
    def is_highway(self) -> bool:
        return self.cls in HIGHWAY_CLASSES


@dataclass
class StreetNode:
    id: str
    lon: float
    lat: float
    names: list[str]
    classes: list[str]
    feature_ids: list[str]
    degree: int = 0

    @property
    def point(self) -> LonLat:
        return (self.lon, self.lat)

    @property
    def is_highway_only(self) -> bool:
        return all(c in HIGHWAY_CLASSES for c in self.classes)

    @property
    def touches_motorway(self) -> bool:
        return any(c in MOTORWAY_CLASSES for c in self.classes)


@dataclass
class StreetEdge:
    id: str
    u: str
    v: str
    feature_id: str
    name: str
    cls: str
    geometry: list[LonLat]
    length_m: float
    lanes: int | None
    oneway: bool | None
    speed_kph: float | None
    provenance: dict[str, Any]

    @property
    def is_highway(self) -> bool:
        return self.cls in HIGHWAY_CLASSES


@dataclass
class Access:
    """One way for an off-street point to join the street graph.

    ``geometry`` runs from the point to street node ``node`` (a perpendicular service drop
    to ``edge`` and then along it); ``cost`` is the weighted access length in metres.
    """

    node: str
    cost: float
    geometry: list[LonLat]
    edge: str | None = None
    along: float = 0.0  # position of the drop along the edge's canonical (u -> v) direction
    dist: float = 0.0  # straight length of the drop
    traversed: float = 0.0  # length of street edge travelled to reach ``node``


@dataclass
class _Split:
    feature: int
    pos: float  # vertex index + fraction along the following segment
    xy: tuple[float, float]
    ref: Any = None


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, i: int) -> int:
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            if ra < rb:
                self.parent[rb] = ra
            else:
                self.parent[ra] = rb


def _can_cross(a: StreetFeature, b: StreetFeature) -> bool:
    """May two features form an at-grade junction where their interiors cross?"""
    if a.bridge or a.tunnel or b.bridge or b.tunnel or a.layer != b.layer:
        return False
    if a.is_motorway != b.is_motorway and not (a.is_link or b.is_link):
        return False
    return True


def _can_join(a: StreetFeature, b: StreetFeature) -> bool:
    """May an endpoint of ``a`` be snapped onto ``b`` (T-junction / ramp terminal)?"""
    if a.is_motorway != b.is_motorway and not (a.is_link or b.is_link):
        return False
    return True


class StreetGraph:
    """Noded street network with routing helpers."""

    def __init__(
        self,
        features: Sequence[StreetFeature],
        nodes: dict[str, StreetNode],
        edges: dict[str, StreetEdge],
        projection: LocalProjection,
    ):
        self.features = {f.id: f for f in features}
        self.nodes = nodes
        self.edges = edges
        self.projection = projection
        self.graph = nx.Graph()
        for nid in sorted(nodes):
            n = nodes[nid]
            self.graph.add_node(nid, lon=n.lon, lat=n.lat)
        for eid in sorted(edges):
            e = edges[eid]
            existing = self.graph.get_edge_data(e.u, e.v)
            if existing is None or existing["length"] > e.length_m:
                self.graph.add_edge(e.u, e.v, length=e.length_m, eid=eid, highway=e.is_highway)
        surface_edges = [(u, v) for u, v, d in self.graph.edges(data=True) if not d["highway"]]
        self.surface_graph = self.graph.edge_subgraph(surface_edges).copy()
        self._offset_cache: dict[tuple[str, float], list[LonLat]] = {}

    # -- lookup -------------------------------------------------------------

    def nearest_node(
        self,
        point: Sequence[float],
        *,
        surface_only: bool = True,
        exclude: Iterable[str] = (),
        max_distance_m: float | None = None,
    ) -> str | None:
        """Nearest graph node to ``(lon, lat)``; ties broken by id for determinism."""
        excluded = set(exclude)
        pool = self.surface_graph.nodes if surface_only else self.graph.nodes
        p = self.projection.to_xy(point)
        best: tuple[float, str] | None = None
        for nid in pool:
            if nid in excluded:
                continue
            q = self.projection.to_xy(self.nodes[nid].point)
            d = math.hypot(p[0] - q[0], p[1] - q[1])
            if max_distance_m is not None and d > max_distance_m:
                continue
            key = (round(d, 3), nid)
            if best is None or key < best:
                best = key
        return best[1] if best else None

    def nearest_nodes(self, point: Sequence[float], k: int = 4, *, surface_only: bool = True) -> list[str]:
        """The ``k`` nearest graph nodes to ``(lon, lat)``, closest first (ties by id)."""
        pool = self.surface_graph.nodes if surface_only else self.graph.nodes
        p = self.projection.to_xy(point)
        scored = []
        for nid in pool:
            q = self.projection.to_xy(self.nodes[nid].point)
            scored.append((round(math.hypot(p[0] - q[0], p[1] - q[1]), 3), nid))
        return [nid for _, nid in sorted(scored)[:k]]

    def access_options(
        self, point: Sequence[float], *, offset_m: float = 0.0, k_edges: int = 3, drop_weight: float = 1.5
    ) -> list[Access]:
        """Ways for an off-street point to join the surface network via its nearest street edges."""
        scored = []
        for eid in sorted(self.edges):
            e = self.edges[eid]
            if e.is_highway or e.u not in self.surface_graph:
                continue
            geom = self.edge_geometry(eid, e.u, offset_m)
            proj, dist, along = nearest_point_on_polyline(point, geom, self.projection)
            scored.append((round(dist, 3), eid, geom, proj, along))
        scored.sort(key=lambda s: (s[0], s[1]))
        start = (float(point[0]), float(point[1]))
        out: list[Access] = []
        for dist, eid, geom, proj, along in scored[:k_edges]:
            e = self.edges[eid]
            total = polyline_length_m(geom)
            to_u = [start, proj] + list(reversed(substring(geom, 0.0, along)))[1:]
            to_v = [start, proj] + substring(geom, along, total)[1:]
            out.append(Access(e.u, drop_weight * dist + along, dedupe_consecutive(to_u), eid, along, dist, along))
            out.append(Access(e.v, drop_weight * dist + total - along, dedupe_consecutive(to_v), eid, along, dist, total - along))
        return out

    def edge_between(self, u: str, v: str) -> StreetEdge:
        return self.edges[self.graph.edges[u, v]["eid"]]

    # -- routing ------------------------------------------------------------

    def shortest_path(self, u: str, v: str, *, surface_only: bool = True) -> tuple[list[str], list[str]]:
        """Node and edge ids of the shortest path (metres) between two street nodes."""
        if u == v:
            return [u], []
        g = self.surface_graph if surface_only and u in self.surface_graph and v in self.surface_graph else self.graph
        try:
            path = nx.shortest_path(g, u, v, weight="length")
        except nx.NetworkXNoPath:
            if g is self.graph:
                raise
            path = nx.shortest_path(self.graph, u, v, weight="length")
            g = self.graph
        edge_ids = [g.edges[path[i], path[i + 1]]["eid"] for i in range(len(path) - 1)]
        return path, edge_ids

    def edge_geometry(self, eid: str, from_node: str, offset_m: float = 0.0) -> list[LonLat]:
        """Geometry of a street edge oriented to start at ``from_node``.

        ``offset_m`` shifts the line sideways; the side is fixed relative to the edge's
        canonical direction (u -> v), so every utility using a street stays on the same
        side of it regardless of the direction it is traversed.
        """
        e = self.edges[eid]
        key = (eid, round(offset_m, 3))
        if key not in self._offset_cache:
            geom = e.geometry if offset_m == 0 else offset_polyline(e.geometry, offset_m, self.projection)
            self._offset_cache[key] = geom
        geom = self._offset_cache[key]
        if from_node == e.u:
            return list(geom)
        if from_node == e.v:
            return list(reversed(geom))
        raise ValueError(f"{from_node} is not an endpoint of {eid}")

    def path_geometry(self, node_path: Sequence[str], edge_path: Sequence[str], offset_m: float = 0.0) -> list[LonLat]:
        coords: list[LonLat] = []
        if not edge_path:
            n = self.nodes[node_path[0]]
            return [n.point]
        for i, eid in enumerate(edge_path):
            seg = self.edge_geometry(eid, node_path[i], offset_m)
            coords.extend(seg if not coords else seg[1:])
        return dedupe_consecutive(coords)

    def route(
        self, a: Sequence[float], b: Sequence[float], *, offset_m: float = 0.0, a_node: str | None = None, b_node: str | None = None
    ) -> tuple[list[LonLat], list[str], list[str]]:
        """Route between two arbitrary points along surface streets.

        Returns ``(geometry, node_path, edge_path)``; the geometry starts at ``a`` and ends
        at ``b`` and follows the (offset) street centrelines in between.
        """
        u = a_node or self.nearest_node(a)
        v = b_node or self.nearest_node(b)
        assert u is not None and v is not None
        node_path, edge_path = self.shortest_path(u, v)
        middle = self.path_geometry(node_path, edge_path, offset_m) if edge_path else []
        coords = dedupe_consecutive([tuple(a)] + middle + [tuple(b)], tolerance_m=0.5)
        if len(coords) < 2:
            coords = [(float(a[0]), float(a[1])), (float(b[0]), float(b[1]))]
        return coords, node_path, edge_path

    # -- descriptive helpers -------------------------------------------------

    def node_label(self, nid: str) -> str:
        n = self.nodes[nid]
        names = n.names
        if len(names) >= 2:
            return " & ".join(names)
        if names:
            return f"{names[0]} (end of mapped segment)"
        return nid


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def build_street_graph(
    features: Sequence[StreetFeature | dict[str, Any]],
    *,
    center: Sequence[float] | None = None,
    snap_m: float = 12.0,
    endpoint_snap_m: float = 25.0,
    min_stub_m: float = 20.0,
    keep_largest_component: bool = True,
    contract_degree_two: bool = True,
) -> StreetGraph:
    """Node street polylines into a graph.

    ``center`` is ``(lon, lat)`` for the local projection (defaults to the mean vertex).
    """
    feats = [f if isinstance(f, StreetFeature) else StreetFeature.from_dict(f) for f in features]
    feats = [f for f in feats if len(dedupe_consecutive(f.coords)) >= 2]
    feats.sort(key=lambda f: f.id)
    for f in feats:
        if f.node_refs is None:
            f.coords = dedupe_consecutive(f.coords)
    if center is None:
        allpts = [c for f in feats for c in f.coords]
        center = (sum(p[0] for p in allpts) / len(allpts), sum(p[1] for p in allpts) / len(allpts))
    proj = LocalProjection(center[0], center[1])
    xy = [[proj.to_xy(c) for c in f.coords] for f in feats]

    # Uniform grid index of segments for candidate search.
    cell = 150.0
    grid: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    for fi, pts in enumerate(xy):
        for si in range(len(pts) - 1):
            (x0, y0), (x1, y1) = pts[si], pts[si + 1]
            for gx in range(int(math.floor(min(x0, x1) / cell)), int(math.floor(max(x0, x1) / cell)) + 1):
                for gy in range(int(math.floor(min(y0, y1) / cell)), int(math.floor(max(y0, y1) / cell)) + 1):
                    grid[(gx, gy)].append((fi, si))

    def candidates_near(x: float, y: float, radius: float) -> set[tuple[int, int]]:
        out: set[tuple[int, int]] = set()
        for gx in range(int(math.floor((x - radius) / cell)), int(math.floor((x + radius) / cell)) + 1):
            for gy in range(int(math.floor((y - radius) / cell)), int(math.floor((y + radius) / cell)) + 1):
                out.update(grid.get((gx, gy), ()))
        return out

    splits: list[_Split] = []

    # 1. Endpoints (snapped onto nearby joinable features for authored data).
    for fi, f in enumerate(feats):
        pts = xy[fi]
        for end_index in (0, len(pts) - 1):
            p = pts[end_index]
            ref = f.node_refs[end_index] if f.node_refs else None
            if f.node_refs is None:
                best: tuple[float, int, int, tuple[float, float], float] | None = None
                for fj, sj in sorted(candidates_near(p[0], p[1], endpoint_snap_m)):
                    if fj == fi or not _can_join(f, feats[fj]):
                        continue
                    q, _, t, d = nearest_point_on_polyline_xy(p, xy[fj][sj : sj + 2])
                    if d <= endpoint_snap_m and (best is None or (d, fj, sj) < best[:3]):
                        best = (d, fj, sj, q, t)
                if best is not None and best[0] > 1e-6:
                    _, fj, sj, q, t = best
                    pts[end_index] = q
                    f.coords[end_index] = proj.to_lonlat(q)
                    splits.append(_Split(fj, sj + t, q))
            splits.append(_Split(fi, float(end_index), pts[end_index], ref))

    # 2. Proper crossings between geometric features.
    seen_pairs: set[tuple[int, int, int, int]] = set()
    for fi, pts in enumerate(xy):
        for si in range(len(pts) - 1):
            (x0, y0), (x1, y1) = pts[si], pts[si + 1]
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            radius = math.hypot(x1 - x0, y1 - y0) / 2 + 1.0
            for fj, sj in sorted(candidates_near(mx, my, radius)):
                if fj <= fi:
                    continue
                key = (fi, si, fj, sj)
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                a, b = feats[fi], feats[fj]
                if a.node_refs is not None and b.node_refs is not None:
                    continue  # topological features are noded by shared refs below
                if not _can_cross(a, b):
                    continue
                hit = segment_intersection(pts[si], pts[si + 1], xy[fj][sj], xy[fj][sj + 1])
                if hit is None:
                    continue
                q, t, u = hit
                splits.append(_Split(fi, si + t, q))
                splits.append(_Split(fj, sj + u, q))

    # 3. Shared OSM node refs.
    ref_count: dict[Any, int] = defaultdict(int)
    for f in feats:
        if f.node_refs:
            for r in f.node_refs:
                if r is not None:
                    ref_count[r] += 1
    for fi, f in enumerate(feats):
        if not f.node_refs:
            continue
        for vi, r in enumerate(f.node_refs):
            if r is not None and ref_count[r] >= 2 and 0 < vi < len(f.node_refs) - 1:
                splits.append(_Split(fi, float(vi), xy[fi][vi], r))

    # 4. Cluster split points (same OSM ref, or within snap_m).
    uf = _UnionFind(len(splits))
    by_ref: dict[Any, int] = {}
    pgrid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, s in enumerate(splits):
        if s.ref is not None:
            if s.ref in by_ref:
                uf.union(i, by_ref[s.ref])
            else:
                by_ref[s.ref] = i
        gx, gy = int(math.floor(s.xy[0] / snap_m)), int(math.floor(s.xy[1] / snap_m))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in pgrid.get((gx + dx, gy + dy), ()):
                    if math.hypot(s.xy[0] - splits[j].xy[0], s.xy[1] - splits[j].xy[1]) <= snap_m:
                        uf.union(i, j)
        pgrid[(gx, gy)].append(i)

    clusters: dict[int, list[int]] = defaultdict(list)
    for i in range(len(splits)):
        clusters[uf.find(i)].append(i)
    cluster_xy: dict[int, tuple[float, float]] = {}
    for root, members in clusters.items():
        cluster_xy[root] = (
            sum(splits[m].xy[0] for m in members) / len(members),
            sum(splits[m].xy[1] for m in members) / len(members),
        )

    # 5. Cut each feature at its split points.
    raw_edges: list[dict[str, Any]] = []
    per_feature: dict[int, list[tuple[float, int]]] = defaultdict(list)
    for i, s in enumerate(splits):
        per_feature[s.feature].append((s.pos, uf.find(i)))
    for fi, f in enumerate(feats):
        pts = xy[fi]
        stops = sorted(set(per_feature[fi]))
        # collapse consecutive stops on the same cluster
        collapsed: list[tuple[float, int]] = []
        for pos, root in stops:
            if collapsed and collapsed[-1][1] == root:
                continue
            collapsed.append((pos, root))
        for k in range(len(collapsed) - 1):
            (pa, ra), (pb, rb) = collapsed[k], collapsed[k + 1]
            if ra == rb:
                continue
            interior = [pts[vi] for vi in range(int(math.floor(pa)) + 1, int(math.ceil(pb))) if pa < vi < pb]
            geom_xy = [cluster_xy[ra]] + interior + [cluster_xy[rb]]
            geom = dedupe_consecutive([proj.to_lonlat(p) for p in geom_xy])
            if len(geom) < 2:
                continue
            raw_edges.append({"feature": fi, "u": ra, "v": rb, "geometry": geom})

    # 6. Node bookkeeping.
    node_feats: dict[int, set[int]] = defaultdict(set)
    for e in raw_edges:
        node_feats[e["u"]].add(e["feature"])
        node_feats[e["v"]].add(e["feature"])

    # Drop duplicate edges between the same pair of clusters (keep shortest).
    best_pair: dict[tuple[int, int], dict[str, Any]] = {}
    for e in raw_edges:
        key = (min(e["u"], e["v"]), max(e["u"], e["v"]))
        e["length"] = polyline_length_m(e["geometry"])
        if key not in best_pair or e["length"] < best_pair[key]["length"]:
            best_pair[key] = e
    edges_list = list(best_pair.values())

    # Remove short dangling stubs created by imprecise authored endpoints.
    changed = True
    while changed:
        changed = False
        deg: dict[int, int] = defaultdict(int)
        for e in edges_list:
            deg[e["u"]] += 1
            deg[e["v"]] += 1
        keep = []
        for e in edges_list:
            if e["length"] < min_stub_m and (deg[e["u"]] == 1 or deg[e["v"]] == 1) and deg[e["u"]] + deg[e["v"]] > 2:
                changed = True
                continue
            keep.append(e)
        edges_list = keep

    # Keep the largest connected component.
    if keep_largest_component and edges_list:
        g = nx.Graph()
        for e in edges_list:
            g.add_edge(e["u"], e["v"])
        comps = sorted(nx.connected_components(g), key=lambda c: (-len(c), min(c)))
        main = comps[0]
        edges_list = [e for e in edges_list if e["u"] in main]

    if contract_degree_two:
        edges_list = _contract_degree_two(edges_list, feats)

    # 7. Deterministic ids: nodes north->south, west->east; edges by feature then position.
    used = sorted({e["u"] for e in edges_list} | {e["v"] for e in edges_list}, key=lambda r: (-round(cluster_xy[r][1], 2), round(cluster_xy[r][0], 2), r))
    node_id = {r: f"S{idx + 1:04d}" for idx, r in enumerate(used)}
    nodes: dict[str, StreetNode] = {}
    incident: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for e in edges_list:
        incident[e["u"]].append(e)
        incident[e["v"]].append(e)
    for r in used:
        fset = sorted({feats[e["feature"]].id for e in incident[r]})
        fobjs = sorted({e["feature"] for e in incident[r]}, key=lambda fi: (CLASS_RANK.get(feats[fi].cls, 9), feats[fi].name))
        names: list[str] = []
        for fi in fobjs:
            if feats[fi].name not in names:
                names.append(feats[fi].name)
        lon, lat = proj.to_lonlat(cluster_xy[r])
        nodes[node_id[r]] = StreetNode(
            id=node_id[r],
            lon=lon,
            lat=lat,
            names=names,
            classes=sorted({feats[fi].cls for fi in fobjs}, key=lambda c: CLASS_RANK.get(c, 9)),
            feature_ids=fset,
            degree=len(incident[r]),
        )

    def along_key(e: dict[str, Any]) -> tuple[str, float]:
        f = feats[e["feature"]]
        start = f.coords[0]
        a = e["geometry"][0]
        return (f.id, round((a[0] - start[0]) ** 2 + (a[1] - start[1]) ** 2, 12))

    edges: dict[str, StreetEdge] = {}
    for idx, e in enumerate(sorted(edges_list, key=along_key)):
        f = feats[e["feature"]]
        u, v = node_id[e["u"]], node_id[e["v"]]
        geom = list(e["geometry"])
        geom[0] = nodes[u].point
        geom[-1] = nodes[v].point
        geom = dedupe_consecutive(geom)
        if len(geom) < 2:
            geom = [nodes[u].point, nodes[v].point]
        eid = f"G{idx + 1:04d}"
        edges[eid] = StreetEdge(
            id=eid,
            u=u,
            v=v,
            feature_id=f.id,
            name=f.name,
            cls=f.cls,
            geometry=geom,
            length_m=polyline_length_m(geom),
            lanes=f.lanes,
            oneway=f.oneway,
            speed_kph=f.speed_kph,
            provenance=f.provenance,
        )
    return StreetGraph(feats, nodes, edges, proj)


def _contract_degree_two(edges_list: list[dict[str, Any]], feats: Sequence[StreetFeature]) -> list[dict[str, Any]]:
    """Merge chains through degree-2 nodes where both sides are the same street."""
    while True:
        incident: dict[int, list[int]] = defaultdict(list)
        for i, e in enumerate(edges_list):
            incident[e["u"]].append(i)
            incident[e["v"]].append(i)
        target = None
        for node in sorted(incident):
            idxs = incident[node]
            if len(idxs) != 2 or idxs[0] == idxs[1]:
                continue
            a, b = edges_list[idxs[0]], edges_list[idxs[1]]
            fa, fb = feats[a["feature"]], feats[b["feature"]]
            if fa.name == fb.name and fa.cls == fb.cls:
                other_a = a["v"] if a["u"] == node else a["u"]
                other_b = b["v"] if b["u"] == node else b["u"]
                if other_a != other_b:
                    target = (node, idxs[0], idxs[1])
                    break
        if target is None:
            return edges_list
        node, ia, ib = target
        a, b = edges_list[ia], edges_list[ib]
        ga = a["geometry"] if a["v"] == node else list(reversed(a["geometry"]))
        gb = b["geometry"] if b["u"] == node else list(reversed(b["geometry"]))
        start = a["u"] if a["v"] == node else a["v"]
        end = b["v"] if b["u"] == node else b["u"]
        geom = dedupe_consecutive(ga + gb[1:])
        merged = {"feature": a["feature"], "u": start, "v": end, "geometry": geom, "length": polyline_length_m(geom)}
        edges_list = [e for i, e in enumerate(edges_list) if i not in (ia, ib)] + [merged]
