/**
 * Precomputed geometry of the network and the DEPTH TRANSFORM.
 *
 *   displayed position = ground(lon, lat) + up * relativeElevation
 *
 * Underground items use relativeElevation = -depth * depthScale * deepT (+ a small ghost lift
 * while deepT -> 0 so buried networks show as faint traces just above the surface). Every
 * renderer (lines, nodes, particles, glyphs, drop lines, trace pulses, camera framing) reads
 * displayed positions from here, so surface and underground stay geographically consistent.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import { clamp, LocalFrame, smoothstep } from "@/engine/geographic/LocalFrame";
import type { InfrastructureEdge, InfrastructureNetwork, InfrastructureNode, SystemType } from "@/types/infrastructure";

export type EdgeClass = "surface" | "buried" | "corridor" | "dependency";

export interface NodeGeom {
  idx: number;
  id: string;
  node: InfrastructureNode;
  lon: number;
  lat: number;
  x: number;
  y: number;
  ground: number;
  underground: boolean;
  /** ECEF at ground (no lift) */
  base: Cesium.Cartesian3;
  up: Cesium.Cartesian3;
  /** current relative elevation (m above ground; negative underground) */
  rel: number;
  /** current displayed position (mutated in place) */
  pos: Cesium.Cartesian3;
}

export interface EdgeGeom {
  idx: number;
  id: string;
  edge: InfrastructureEdge;
  cls: EdgeClass;
  /** colour/layer system (dependency arcs: provider system) */
  system: SystemType;
  src: number;
  dst: number;
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  ground: Float64Array;
  /** cumulative horizontal distance (m) per vertex */
  dist: Float64Array;
  length: number;
  base: Float64Array;
  up: Float64Array;
  /** displayed ECEF xyz per vertex */
  pos: Float64Array;
  /** displayed positions as Cartesian3 (objects reused across updates) */
  positions: Cesium.Cartesian3[];
  /** arc peak height for dependency arcs */
  arcPeak: number;
  /** touches a facility node (facility layer gating) */
  facility: boolean;
}

export interface DepthParams {
  depthScale: number;
  deepT: number;
}

const GHOST_LIFT = 0.7;
const NODE_LIFT = 1.2;

/** Height above ground for surface (depth 0) physical edges, per system. */
function surfaceLift(e: InfrastructureEdge): number {
  switch (e.infrastructure_type) {
    case "power":
      return e.connection_type === "transmission_line" ? 14 : 9; // overhead conductors
    case "telecom":
      return 6; // aerial fibre
    case "transport":
      return 0.9;
    default:
      return 1.2;
  }
}

export class NetworkGeometry {
  readonly C: CesiumModule;
  readonly network: InfrastructureNetwork;
  frame: LocalFrame;
  readonly nodes: NodeGeom[] = [];
  readonly edges: EdgeGeom[] = [];
  readonly nodeIndex = new Map<string, number>();
  readonly edgeIndex = new Map<string, number>();
  /** ground used before / without terrain sampling */
  groundBase: number;
  private params: DepthParams = { depthScale: 8, deepT: 0 };
  /** increments whenever displayed positions change */
  version = 0;

  constructor(C: CesiumModule, network: InfrastructureNetwork, groundBase: number) {
    this.C = C;
    this.network = network;
    this.groundBase = groundBase;
    const r = network.region;
    const [s, w, n, e] = r.bbox;
    const cLat = r.center?.[0] ?? (s + n) / 2;
    const cLon = r.center?.[1] ?? (w + e) / 2;
    this.frame = new LocalFrame(C, cLon, cLat, groundBase);
    this.build();
  }

  private build() {
    const C = this.C;
    const f = this.frame;
    for (const node of this.network.nodes) {
      const [x, y] = f.toLocal(node.longitude, node.latitude);
      const base = C.Cartesian3.fromDegrees(node.longitude, node.latitude, this.groundBase);
      const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(base, new C.Cartesian3());
      const g: NodeGeom = {
        idx: this.nodes.length,
        id: node.id,
        node,
        lon: node.longitude,
        lat: node.latitude,
        x,
        y,
        ground: this.groundBase,
        underground: (node.elevation ?? 0) < -0.05,
        base,
        up,
        rel: 0,
        pos: C.Cartesian3.clone(base),
      };
      this.nodeIndex.set(node.id, g.idx);
      this.nodes.push(g);
    }
    for (const edge of this.network.edges) {
      const src = this.nodeIndex.get(edge.source_node);
      const dst = this.nodeIndex.get(edge.target_node);
      if (src === undefined || dst === undefined) continue;
      const dep = edge.relation === "dependency";
      const depth = Math.max(0, edge.depth_m ?? 0);
      const cls: EdgeClass = dep
        ? "dependency"
        : depth > 0.01 && (edge.infrastructure_type === "underground" || /duct|tunnel|corridor/.test(edge.connection_type))
          ? "corridor"
          : depth > 0.01
            ? "buried"
            : "surface";
      const sn = this.nodes[src];
      const dn = this.nodes[dst];
      let pts: [number, number][];
      if (dep) {
        pts = this.arcPoints(sn, dn);
      } else {
        let geom = edge.geometry && edge.geometry.length >= 2 ? edge.geometry : [[sn.lon, sn.lat] as [number, number], [dn.lon, dn.lat] as [number, number]];
        // orient geometry source -> target
        const d0 = Math.hypot(...f.toLocal(geom[0][0], geom[0][1]).map((v, i) => v - [sn.x, sn.y][i]));
        const d1 = Math.hypot(...f.toLocal(geom[geom.length - 1][0], geom[geom.length - 1][1]).map((v, i) => v - [sn.x, sn.y][i]));
        if (d1 < d0) geom = [...geom].reverse();
        pts = this.resample(geom);
      }
      const n = pts.length;
      const lon = new Float64Array(n);
      const lat = new Float64Array(n);
      const dist = new Float64Array(n);
      let prev: [number, number] | null = null;
      for (let i = 0; i < n; i++) {
        lon[i] = pts[i][0];
        lat[i] = pts[i][1];
        const p = f.toLocal(pts[i][0], pts[i][1]);
        dist[i] = prev ? dist[i - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]) : 0;
        prev = p;
      }
      const length = Math.max(1, dist[n - 1]);
      const span = Math.hypot(dn.x - sn.x, dn.y - sn.y);
      const g: EdgeGeom = {
        idx: this.edges.length,
        id: edge.id,
        edge,
        cls,
        system: dep ? sn.node.system ?? edge.infrastructure_type : edge.infrastructure_type,
        src,
        dst,
        n,
        lon,
        lat,
        ground: new Float64Array(n).fill(this.groundBase),
        dist,
        length,
        base: new Float64Array(n * 3),
        up: new Float64Array(n * 3),
        pos: new Float64Array(n * 3),
        positions: Array.from({ length: n }, () => new C.Cartesian3()),
        arcPeak: dep ? clamp(span * 0.2, 22, 240) : 0,
        facility: sn.node.system === "facility" || dn.node.system === "facility",
      };
      this.edgeIndex.set(edge.id, g.idx);
      this.edges.push(g);
      this.computeBase(g);
    }
    this.update(this.params, true);
  }

  /** Resample a [lon,lat] polyline so no segment is longer than ~28 m (keeps original vertices). */
  private resample(geom: [number, number][]): [number, number][] {
    const f = this.frame;
    const local = geom.map(([lo, la]) => f.toLocal(lo, la));
    let total = 0;
    for (let i = 1; i < local.length; i++) total += Math.hypot(local[i][0] - local[i - 1][0], local[i][1] - local[i - 1][1]);
    const step = clamp(total / 32, 8, 28);
    const out: [number, number][] = [geom[0]];
    for (let i = 1; i < local.length; i++) {
      const [ax, ay] = local[i - 1];
      const [bx, by] = local[i];
      const segLen = Math.hypot(bx - ax, by - ay);
      if (segLen < 0.05) continue;
      const k = Math.max(1, Math.ceil(segLen / step));
      for (let j = 1; j <= k; j++) {
        const t = j / k;
        out.push(f.toLonLat(ax + (bx - ax) * t, ay + (by - ay) * t));
      }
    }
    if (out.length < 2) out.push(geom[geom.length - 1]);
    return out;
  }

  private arcPoints(a: NodeGeom, b: NodeGeom): [number, number][] {
    const N = 25;
    const out: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      out.push([a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t]);
    }
    return out;
  }

  private computeBase(g: EdgeGeom) {
    const C = this.C;
    const scratch = new C.Cartesian3();
    const nrm = new C.Cartesian3();
    for (let i = 0; i < g.n; i++) {
      C.Cartesian3.fromDegrees(g.lon[i], g.lat[i], g.ground[i], undefined, scratch);
      C.Ellipsoid.WGS84.geodeticSurfaceNormal(scratch, nrm);
      g.base[i * 3] = scratch.x;
      g.base[i * 3 + 1] = scratch.y;
      g.base[i * 3 + 2] = scratch.z;
      g.up[i * 3] = nrm.x;
      g.up[i * 3 + 1] = nrm.y;
      g.up[i * 3 + 2] = nrm.z;
    }
  }

  /** Total displayed vertex count (diagnostics). */
  vertexCount(): number {
    return this.edges.reduce((a, e) => a + e.n, 0);
  }

  /** All cartographic sample points (nodes first, then edge vertices) for terrain sampling. */
  samplePoints(): { lon: number; lat: number }[] {
    const pts: { lon: number; lat: number }[] = this.nodes.map((n) => ({ lon: n.lon, lat: n.lat }));
    for (const e of this.edges) for (let i = 0; i < e.n; i++) pts.push({ lon: e.lon[i], lat: e.lat[i] });
    return pts;
  }

  /**
   * Apply sampled ground heights (same order as samplePoints()). Points without a height (failed
   * terrain tiles, or an empty array to re-anchor everything) take `fallback`.
   */
  applyGround(heights: ArrayLike<number>, regionGround: number, fallback: number = regionGround) {
    const C = this.C;
    let k = 0;
    for (const n of this.nodes) {
      const h = heights[k++];
      n.ground = Number.isFinite(h) ? h : fallback;
      C.Cartesian3.fromDegrees(n.lon, n.lat, n.ground, undefined, n.base);
    }
    for (const e of this.edges) {
      for (let i = 0; i < e.n; i++) {
        const h = heights[k++];
        e.ground[i] = Number.isFinite(h) ? h : fallback;
      }
      this.computeBase(e);
    }
    this.groundBase = regionGround;
    this.frame = this.frame.withHeight(regionGround);
    this.update(this.params, true);
  }

  get depth(): DepthParams {
    return this.params;
  }

  /** Relative elevation of a node for the given depth parameters. */
  nodeRel(n: NodeGeom, p: DepthParams = this.params): number {
    const el = n.node.elevation ?? 0;
    if (n.underground) return el * p.depthScale * p.deepT + GHOST_LIFT * (1 - p.deepT);
    return Math.max(0, el) + NODE_LIFT;
  }

  /** Relative elevation of the body of an edge. */
  edgeRel(e: EdgeGeom, p: DepthParams = this.params): number {
    if (e.cls === "surface") return surfaceLift(e.edge);
    const depth = Math.max(0, e.edge.depth_m ?? 0);
    return -depth * p.depthScale * p.deepT + GHOST_LIFT * (1 - p.deepT);
  }

  /** Displayed position of a node for arbitrary depth parameters (camera framing). */
  nodePositionFor(n: NodeGeom, p: DepthParams, result?: Cesium.Cartesian3): Cesium.Cartesian3 {
    const C = this.C;
    const rel = this.nodeRel(n, p);
    const out = result ?? new C.Cartesian3();
    return C.Cartesian3.add(n.base, C.Cartesian3.multiplyByScalar(n.up, rel, out), out);
  }

  /** Recompute displayed positions. Returns true if anything changed. */
  update(p: DepthParams, force = false): boolean {
    if (!force && p.deepT === this.params.deepT && p.depthScale === this.params.depthScale) return false;
    this.params = { ...p };
    const C = this.C;
    for (const n of this.nodes) {
      n.rel = this.nodeRel(n, p);
      C.Cartesian3.add(n.base, C.Cartesian3.multiplyByScalar(n.up, n.rel, n.pos), n.pos);
    }
    for (const e of this.edges) this.updateEdge(e, p);
    this.version++;
    return true;
  }

  private updateEdge(e: EdgeGeom, p: DepthParams) {
    const a = this.nodes[e.src];
    const b = this.nodes[e.dst];
    const L = e.length;
    const pos = e.pos;
    const base = e.base;
    const up = e.up;
    if (e.cls === "dependency") {
      for (let i = 0; i < e.n; i++) {
        const t = e.dist[i] / L;
        // interpolate between endpoint displayed heights in ECEF (heights may differ a lot)
        const relA = a.rel + (a.ground - e.ground[i]);
        const relB = b.rel + (b.ground - e.ground[i]);
        const rel = relA + (relB - relA) * t + e.arcPeak * 4 * t * (1 - t);
        pos[i * 3] = base[i * 3] + up[i * 3] * rel;
        pos[i * 3 + 1] = base[i * 3 + 1] + up[i * 3 + 1] * rel;
        pos[i * 3 + 2] = base[i * 3 + 2] + up[i * 3 + 2] * rel;
      }
    } else {
      const body = this.edgeRel(e, p);
      const relA = a.rel;
      const relB = b.rel;
      const rampA = clamp(Math.max(18, Math.abs(relA - body) * 1.4), 0, L * 0.35);
      const rampB = clamp(Math.max(18, Math.abs(relB - body) * 1.4), 0, L * 0.35);
      for (let i = 0; i < e.n; i++) {
        const s = e.dist[i];
        const wa = 1 - smoothstep(0, rampA, s);
        const wb = 1 - smoothstep(0, rampB, L - s);
        const rel = body + (relA - body) * wa + (relB - body) * wb;
        pos[i * 3] = base[i * 3] + up[i * 3] * rel;
        pos[i * 3 + 1] = base[i * 3 + 1] + up[i * 3 + 1] * rel;
        pos[i * 3 + 2] = base[i * 3 + 2] + up[i * 3 + 2] * rel;
      }
    }
    for (let i = 0; i < e.n; i++) {
      const c = e.positions[i];
      c.x = pos[i * 3];
      c.y = pos[i * 3 + 1];
      c.z = pos[i * 3 + 2];
    }
  }

  /** Point along an edge at distance s (m) from its first vertex. */
  pointAlong(e: EdgeGeom, s: number, out: Cesium.Cartesian3): Cesium.Cartesian3 {
    const d = e.dist;
    const n = e.n;
    if (s <= 0) {
      out.x = e.pos[0];
      out.y = e.pos[1];
      out.z = e.pos[2];
      return out;
    }
    if (s >= d[n - 1]) {
      out.x = e.pos[(n - 1) * 3];
      out.y = e.pos[(n - 1) * 3 + 1];
      out.z = e.pos[(n - 1) * 3 + 2];
      return out;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = d[hi] - d[lo];
    const t = seg > 1e-6 ? (s - d[lo]) / seg : 0;
    const p = e.pos;
    out.x = p[lo * 3] + (p[hi * 3] - p[lo * 3]) * t;
    out.y = p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * t;
    out.z = p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * t;
    return out;
  }

  /** Max displayed depth (m, positive) at deepT = 1 for the given scale. */
  maxDisplayDepth(depthScale: number): number {
    let m = 0;
    for (const n of this.nodes) if (n.underground) m = Math.max(m, -(n.node.elevation ?? 0));
    for (const e of this.edges) if (e.cls === "buried" || e.cls === "corridor") m = Math.max(m, e.edge.depth_m ?? 0);
    return m * depthScale;
  }

  /** District extent in local metres [minX, minY, maxX, maxY] from node positions. */
  extent(): [number, number, number, number] {
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const n of this.nodes) {
      a = Math.min(a, n.x);
      b = Math.min(b, n.y);
      c = Math.max(c, n.x);
      d = Math.max(d, n.y);
    }
    if (!Number.isFinite(a)) return [-1000, -1000, 1000, 1000];
    return [a, b, c, d];
  }
}
