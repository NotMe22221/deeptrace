"""Small, dependency-free geodesy helpers used by the street graph and the generator.

All public functions take points as ``(longitude, latitude)`` tuples in WGS84
degrees, matching the ``geometry`` convention of the data contract. Planar
operations (intersections, offsets, projections onto segments) are done in a
local equirectangular projection (:class:`LocalProjection`), which is accurate to
well under a metre over a downtown-sized area.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

EARTH_RADIUS_M = 6_371_008.8

LonLat = tuple[float, float]
XY = tuple[float, float]


# ---------------------------------------------------------------------------
# Spherical helpers
# ---------------------------------------------------------------------------


def haversine_m(a: Sequence[float], b: Sequence[float]) -> float:
    """Great-circle distance in metres between two ``(lon, lat)`` points."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a: Sequence[float], b: Sequence[float]) -> float:
    """Initial bearing from ``a`` to ``b`` in degrees clockwise from north (0-360)."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def destination(origin: Sequence[float], bearing: float, distance_m: float) -> LonLat:
    """Point reached travelling ``distance_m`` from ``origin`` on ``bearing`` (degrees)."""
    lon1, lat1 = math.radians(origin[0]), math.radians(origin[1])
    brg = math.radians(bearing)
    d = distance_m / EARTH_RADIUS_M
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    lon2 = lon1 + math.atan2(math.sin(brg) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return (math.degrees(lon2), math.degrees(lat2))


def polyline_length_m(coords: Sequence[Sequence[float]]) -> float:
    """Length of a ``[(lon, lat), ...]`` polyline in metres."""
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def interpolate_along(coords: Sequence[Sequence[float]], distance_m: float) -> LonLat:
    """Point at ``distance_m`` along a polyline (clamped to its ends)."""
    if not coords:
        raise ValueError("empty polyline")
    if distance_m <= 0 or len(coords) == 1:
        return (coords[0][0], coords[0][1])
    walked = 0.0
    for i in range(len(coords) - 1):
        seg = haversine_m(coords[i], coords[i + 1])
        if walked + seg >= distance_m and seg > 0:
            t = (distance_m - walked) / seg
            return (
                coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
                coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
            )
        walked += seg
    return (coords[-1][0], coords[-1][1])


def interpolate_fraction(coords: Sequence[Sequence[float]], fraction: float) -> LonLat:
    """Point at ``fraction`` (0-1) of a polyline's length."""
    return interpolate_along(coords, max(0.0, min(1.0, fraction)) * polyline_length_m(coords))


def split_polyline_at(coords: Sequence[Sequence[float]], distance_m: float) -> tuple[list[LonLat], list[LonLat]]:
    """Split a polyline into two at ``distance_m`` along it; the split point is shared."""
    pts = [(float(c[0]), float(c[1])) for c in coords]
    total = polyline_length_m(pts)
    distance_m = max(0.0, min(total, distance_m))
    walked = 0.0
    for i in range(len(pts) - 1):
        seg = haversine_m(pts[i], pts[i + 1])
        if walked + seg >= distance_m:
            t = 0.0 if seg == 0 else (distance_m - walked) / seg
            p = (pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1]))
            first = pts[: i + 1] + [p]
            second = [p] + pts[i + 1 :]
            return dedupe_consecutive(first), dedupe_consecutive(second)
        walked += seg
    return dedupe_consecutive(pts), [pts[-1], pts[-1]]


def dedupe_consecutive(coords: Iterable[Sequence[float]], tolerance_m: float = 0.05) -> list[LonLat]:
    """Drop consecutive vertices closer than ``tolerance_m``."""
    out: list[LonLat] = []
    for c in coords:
        p = (float(c[0]), float(c[1]))
        if out and haversine_m(out[-1], p) <= tolerance_m:
            continue
        out.append(p)
    return out


def centroid(coords: Sequence[Sequence[float]]) -> LonLat:
    """Arithmetic mean of vertices (adequate for small features)."""
    if not coords:
        raise ValueError("empty coordinate list")
    return (sum(c[0] for c in coords) / len(coords), sum(c[1] for c in coords) / len(coords))


def in_bbox(point: Sequence[float], bbox: Sequence[float], margin_m: float = 0.0) -> bool:
    """``bbox`` is ``(south, west, north, east)`` as in :class:`RegionInfo`."""
    south, west, north, east = bbox
    dlat = margin_m / 111_195.0
    dlon = margin_m / (111_195.0 * max(0.1, math.cos(math.radians((south + north) / 2))))
    return (south - dlat) <= point[1] <= (north + dlat) and (west - dlon) <= point[0] <= (east + dlon)


# ---------------------------------------------------------------------------
# Local planar projection
# ---------------------------------------------------------------------------


class LocalProjection:
    """Equirectangular projection centred on ``(lon0, lat0)``; x east, y north, metres."""

    def __init__(self, lon0: float, lat0: float):
        self.lon0 = lon0
        self.lat0 = lat0
        self.kx = math.radians(1.0) * EARTH_RADIUS_M * math.cos(math.radians(lat0))
        self.ky = math.radians(1.0) * EARTH_RADIUS_M

    def to_xy(self, p: Sequence[float]) -> XY:
        return ((p[0] - self.lon0) * self.kx, (p[1] - self.lat0) * self.ky)

    def to_lonlat(self, xy: Sequence[float]) -> LonLat:
        return (self.lon0 + xy[0] / self.kx, self.lat0 + xy[1] / self.ky)

    def offset(self, p: Sequence[float], dx_m: float, dy_m: float) -> LonLat:
        """Shift a point by ``dx_m`` east and ``dy_m`` north."""
        return (p[0] + dx_m / self.kx, p[1] + dy_m / self.ky)


# ---------------------------------------------------------------------------
# Planar segment geometry (operates on XY tuples)
# ---------------------------------------------------------------------------


def segment_intersection(p1: XY, p2: XY, p3: XY, p4: XY, eps: float = 1e-9) -> tuple[XY, float, float] | None:
    """Proper intersection of segments p1-p2 and p3-p4.

    Returns ``(point, t, u)`` where ``point = p1 + t (p2 - p1) = p3 + u (p4 - p3)``
    with ``0 <= t, u <= 1``, or ``None`` when the segments do not meet or are parallel.
    """
    d1x, d1y = p2[0] - p1[0], p2[1] - p1[1]
    d2x, d2y = p4[0] - p3[0], p4[1] - p3[1]
    denom = d1x * d2y - d1y * d2x
    if abs(denom) < eps:
        return None
    ex, ey = p3[0] - p1[0], p3[1] - p1[1]
    t = (ex * d2y - ey * d2x) / denom
    u = (ex * d1y - ey * d1x) / denom
    if -eps <= t <= 1 + eps and -eps <= u <= 1 + eps:
        t = min(1.0, max(0.0, t))
        u = min(1.0, max(0.0, u))
        return ((p1[0] + t * d1x, p1[1] + t * d1y), t, u)
    return None


def project_on_segment(p: XY, a: XY, b: XY) -> tuple[XY, float, float]:
    """Closest point to ``p`` on segment a-b: ``(point, t, distance)``."""
    abx, aby = b[0] - a[0], b[1] - a[1]
    denom = abx * abx + aby * aby
    t = 0.0 if denom == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / denom))
    q = (a[0] + t * abx, a[1] + t * aby)
    return q, t, math.hypot(p[0] - q[0], p[1] - q[1])


def nearest_point_on_polyline_xy(p: XY, pts: Sequence[XY]) -> tuple[XY, int, float, float]:
    """Closest point on an XY polyline: ``(point, segment_index, t, distance)``."""
    best: tuple[XY, int, float, float] | None = None
    if len(pts) == 1:
        return pts[0], 0, 0.0, math.hypot(p[0] - pts[0][0], p[1] - pts[0][1])
    for i in range(len(pts) - 1):
        q, t, d = project_on_segment(p, pts[i], pts[i + 1])
        if best is None or d < best[3]:
            best = (q, i, t, d)
    assert best is not None
    return best


def nearest_point_on_polyline(
    point: Sequence[float], coords: Sequence[Sequence[float]], projection: LocalProjection | None = None
) -> tuple[LonLat, float, float]:
    """Closest point on a ``(lon, lat)`` polyline.

    Returns ``(point, distance_m, along_m)`` where ``along_m`` is the distance from
    the start of the polyline to the closest point.
    """
    proj = projection or LocalProjection(point[0], point[1])
    pts = [proj.to_xy(c) for c in coords]
    q, i, t, d = nearest_point_on_polyline_xy(proj.to_xy(point), pts)
    along = sum(math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) for k in range(i))
    if len(pts) > 1:
        along += t * math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
    return proj.to_lonlat(q), d, along


def offset_polyline_xy(pts: Sequence[XY], offset_m: float) -> list[XY]:
    """Parallel offset of an XY polyline (positive = left of travel direction).

    Uses mitred joins with a miter limit so sharp turns do not produce spikes.
    """
    n = len(pts)
    if n < 2 or offset_m == 0:
        return [tuple(p) for p in pts]  # type: ignore[misc]
    normals: list[XY] = []
    for i in range(n - 1):
        dx, dy = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        length = math.hypot(dx, dy) or 1.0
        normals.append((-dy / length, dx / length))
    out: list[XY] = []
    for i in range(n):
        if i == 0:
            nx_, ny_ = normals[0]
            scale = 1.0
        elif i == n - 1:
            nx_, ny_ = normals[-1]
            scale = 1.0
        else:
            ax, ay = normals[i - 1]
            bx, by = normals[i]
            mx, my = ax + bx, ay + by
            mlen = math.hypot(mx, my)
            if mlen < 1e-6:
                nx_, ny_, scale = ax, ay, 1.0
            else:
                nx_, ny_ = mx / mlen, my / mlen
                cos_half = nx_ * ax + ny_ * ay
                scale = min(2.0, 1.0 / max(cos_half, 1e-6))
        out.append((pts[i][0] + nx_ * offset_m * scale, pts[i][1] + ny_ * offset_m * scale))
    return out


def offset_polyline(coords: Sequence[Sequence[float]], offset_m: float, projection: LocalProjection) -> list[LonLat]:
    """Parallel offset of a ``(lon, lat)`` polyline (positive = left of travel direction)."""
    pts = [projection.to_xy(c) for c in coords]
    return [projection.to_lonlat(p) for p in offset_polyline_xy(pts, offset_m)]


def substring(coords: Sequence[Sequence[float]], start_m: float, end_m: float) -> list[LonLat]:
    """Portion of a polyline between two distances along it."""
    if end_m < start_m:
        start_m, end_m = end_m, start_m
    _, rest = split_polyline_at(coords, start_m)
    piece, _ = split_polyline_at(rest, end_m - start_m)
    return piece


def simplify(coords: Sequence[Sequence[float]], tolerance_m: float, projection: LocalProjection) -> list[LonLat]:
    """Douglas-Peucker simplification in metres (keeps both endpoints)."""
    pts = [projection.to_xy(c) for c in coords]
    if len(pts) <= 2:
        return [(float(c[0]), float(c[1])) for c in coords]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best_d, best_k = -1.0, -1
        for k in range(i + 1, j):
            _, _, d = project_on_segment(pts[k], pts[i], pts[j])
            if d > best_d:
                best_d, best_k = d, k
        if best_d > tolerance_m and best_k > 0:
            keep[best_k] = True
            stack.append((i, best_k))
            stack.append((best_k, j))
    return [(float(coords[k][0]), float(coords[k][1])) for k in range(len(pts)) if keep[k]]


def clip_polyline_to_bbox(coords: Sequence[Sequence[float]], bbox: Sequence[float]) -> list[list[LonLat]]:
    """Clip a polyline to ``(south, west, north, east)``; returns the inside pieces.

    Each segment is clipped with Liang-Barsky in lon/lat space (adequate for small boxes).
    """
    south, west, north, east = bbox
    pieces: list[list[LonLat]] = []
    current: list[LonLat] = []

    def inside(p: Sequence[float]) -> bool:
        return west <= p[0] <= east and south <= p[1] <= north

    for i in range(len(coords) - 1):
        x0, y0 = float(coords[i][0]), float(coords[i][1])
        x1, y1 = float(coords[i + 1][0]), float(coords[i + 1][1])
        dx, dy = x1 - x0, y1 - y0
        t0, t1 = 0.0, 1.0
        ok = True
        for p, q in ((-dx, x0 - west), (dx, east - x0), (-dy, y0 - south), (dy, north - y0)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                r = q / p
                if p < 0:
                    if r > t1:
                        ok = False
                        break
                    t0 = max(t0, r)
                else:
                    if r < t0:
                        ok = False
                        break
                    t1 = min(t1, r)
        if not ok:
            if len(current) >= 2:
                pieces.append(current)
            current = []
            continue
        a = (x0 + t0 * dx, y0 + t0 * dy)
        b = (x0 + t1 * dx, y0 + t1 * dy)
        if not current:
            current = [a]
        elif current[-1] != a:
            if len(current) >= 2:
                pieces.append(current)
            current = [a]
        current.append(b)
        if t1 < 1.0 or not inside((x1, y1)):
            if len(current) >= 2:
                pieces.append(current)
            current = []
    if len(current) >= 2:
        pieces.append(current)
    return [dedupe_consecutive(p) for p in pieces if len(dedupe_consecutive(p)) >= 2]


def round_coords(coords: Iterable[Sequence[float]], ndigits: int = 6) -> list[tuple[float, float]]:
    """Round coordinates (6 decimals ~ 0.1 m) for compact, byte-stable output."""
    return [(round(float(c[0]), ndigits), round(float(c[1]), ndigits)) for c in coords]
