/**
 * Deep Mode reference geometry: a surface grid at ground level and translucent STRATA planes at
 * reference depths (scaled by depthScale x deepT) with small depth labels, so the layered
 * networks read as a geological cross-section.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import { lerp, smoothstep } from "@/engine/geographic/LocalFrame";
import { createMaterial, setParams } from "./materials";
import type { NetworkGeometry } from "./NetworkGeometry";
import { setColor, type RGB } from "./palette";

export interface Stratum {
  depth: number;
  label: string;
  rgb: RGB;
}

/** Reference planes. Default labels match the bundled dataset; build() re-derives them from the network. */
export const STRATA: Stratum[] = [
  { depth: 3, label: "0–3 m · utilities & corridors", rgb: [0.45, 0.78, 0.95] },
  { depth: 8, label: "3–8 m · shallow transit", rgb: [0.55, 0.62, 0.86] },
  { depth: 30, label: "8–30 m · deep transit", rgb: [0.62, 0.52, 0.92] },
];

const fmt = (m: number) => (Math.abs(m - Math.round(m)) < 0.05 ? String(Math.round(m)) : m.toFixed(1));

/**
 * Label each band (previous plane, this plane] with what the network actually puts there, so the
 * legend can never contradict the dataset's burial depths.
 */
export function deriveStrata(geom: NetworkGeometry): Stratum[] {
  type Cat = "utilities" | "corridors" | "transit";
  const items: { depth: number; cat: Cat }[] = [];
  for (const e of geom.edges) {
    const d = e.edge.depth_m ?? 0;
    if (e.cls === "corridor") items.push({ depth: d, cat: "corridors" });
    else if (e.cls === "buried") items.push({ depth: d, cat: e.edge.infrastructure_type === "transport" ? "transit" : "utilities" });
  }
  for (const n of geom.nodes) {
    if (!n.underground) continue;
    const d = -(n.node.elevation ?? 0);
    const t = n.node.type;
    const cat: Cat = n.node.system === "transport" ? "transit" : n.node.system === "underground" || /tunnel|corridor/.test(t) ? "corridors" : "utilities";
    items.push({ depth: d, cat });
  }
  if (!items.length) return STRATA;
  const maxDepth = Math.max(...items.map((i) => i.depth));
  const order: Cat[] = ["utilities", "corridors", "transit"];
  const bands = STRATA.map((st, i) => {
    const lo = i ? STRATA[i - 1].depth : 0;
    const hi = i === STRATA.length - 1 ? Math.max(st.depth, maxDepth) : st.depth;
    const inBand = items.filter((it) => it.depth > lo + 1e-6 && it.depth <= hi + 1e-6);
    const cats = order.filter((c) => inBand.some((it) => it.cat === c));
    return { st, lo, hi, cats, inBand };
  });
  // the same category in consecutive bands reads as shallow / deep
  return bands.map((b, i) => {
    const names = b.cats.map((c) => {
      const above = bands.slice(0, i).some((o) => o.cats.includes(c));
      const below = bands.slice(i + 1).some((o) => o.cats.includes(c));
      return above && !below ? `deep ${c}` : !above && below ? `shallow ${c}` : c;
    });
    const range = `${fmt(b.lo)}–${fmt(b.hi)} m`;
    return { ...b.st, label: names.length ? `${range} · ${names.join(" & ")}` : `${range} · reference plane` };
  });
}

interface Plane {
  prim: Cesium.Primitive;
  mat: Cesium.Material;
  depth: number;
  rgb: RGB;
  label: Cesium.Label | null;
  surface: boolean;
}

export class StrataLayer {
  private readonly C: CesiumModule;
  private readonly scene: Cesium.Scene;
  private planes: Plane[] = [];
  readonly labels: Cesium.LabelCollection;
  private up: Cesium.Cartesian3;
  private corner: Cesium.Cartesian3;
  private labelAnchors: Cesium.Cartesian3[] = [];
  /** band labels derived from the current network (also shown in the overlay legend) */
  strata: Stratum[] = STRATA;
  private readonly tmp: Cesium.Cartesian3;
  private readonly tmpColor: Cesium.Color;
  private last = "";

  constructor(C: CesiumModule, scene: Cesium.Scene) {
    this.C = C;
    this.scene = scene;
    this.labels = scene.primitives.add(new C.LabelCollection({ scene }));
    this.up = new C.Cartesian3(0, 0, 1);
    this.corner = new C.Cartesian3();
    this.tmp = new C.Cartesian3();
    this.tmpColor = new C.Color();
  }

  build(geom: NetworkGeometry) {
    const C = this.C;
    this.clear();
    const f = geom.frame;
    const [x0, y0, x1, y1] = geom.extent();
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const half = Math.max(x1 - x0, y1 - y0) / 2 + 380;
    const [w, s] = f.toLonLat(cx - half, cy - half);
    const [e, n] = f.toLonLat(cx + half, cy + half);
    const rect = C.Rectangle.fromDegrees(w, s, e, n);
    const ground = f.height;
    this.up = C.Cartesian3.clone(f.up);
    // labels sit along the west edge of the district (left side of the home and deep views),
    // staggered north-south so neighbouring strata never overlap on screen
    const inner = half - 380;
    this.labelAnchors = STRATA.map((_, i) => {
      const [lon, lat] = f.toLonLat(cx - inner * 0.92, cy + inner * (0.5 - 0.42 * i));
      return C.Cartesian3.fromDegrees(lon, lat, ground);
    });
    this.corner = this.labelAnchors[0];
    const lines = Math.max(8, Math.round((half * 2) / 100));
    const mk = (depth: number, rgb: RGB, label: string | null, surface: boolean) => {
      const mat = createMaterial(C, "grid", setColor(this.tmpColor, rgb, 0), [lines, 0.05, 0.22, 0.12]);
      const prim = this.scene.primitives.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: new C.RectangleGeometry({
              rectangle: rect,
              height: ground + (surface ? 0.35 : 0),
              vertexFormat: C.VertexFormat.POSITION_NORMAL_AND_ST,
              granularity: C.Math.RADIANS_PER_DEGREE * 0.2,
            }),
          }),
          appearance: new C.MaterialAppearance({
            material: mat,
            translucent: true,
            flat: true,
            faceForward: true,
            closed: false,
            renderState: { depthTest: { enabled: true }, depthMask: false, cull: { enabled: false } },
          }),
          asynchronous: false,
          allowPicking: false,
          show: false,
        }),
      );
      let lab: Cesium.Label | null = null;
      if (label) {
        lab = this.labels.add({
          position: this.corner,
          text: label,
          font: "500 10.5px 'JetBrains Mono Variable', ui-monospace, monospace",
          fillColor: C.Color.fromCssColorString("#cfe3ff"),
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString("rgba(6,10,19,0.6)"),
          backgroundPadding: new C.Cartesian2(6, 3),
          horizontalOrigin: C.HorizontalOrigin.LEFT,
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: false,
        });
      }
      this.planes.push({ prim, mat, depth, rgb, label: lab, surface });
    };
    mk(0, [0.5, 0.7, 0.95], null, true);
    this.strata = deriveStrata(geom);
    for (const st of this.strata) mk(st.depth, st.rgb, st.label, false);
    this.last = "";
  }

  update(deepT: number, depthScale: number) {
    const key = `${deepT.toFixed(4)}|${depthScale}`;
    if (key === this.last) return;
    this.last = key;
    const C = this.C;
    for (const p of this.planes) {
      // the surface grid stays faintly visible in surface mode as a reference plane
      const a = p.surface ? lerp(0.32, 1, smoothstep(0.05, 0.6, deepT)) : smoothstep(0.35, 1, deepT);
      p.prim.show = a > 0.01;
      const offset = -p.depth * depthScale * deepT;
      C.Matrix4.fromTranslation(C.Cartesian3.multiplyByScalar(this.up, offset, this.tmp), p.prim.modelMatrix);
      setColor(p.mat.uniforms.color, p.rgb, a * (p.surface ? 0.75 : 0.7));
      setParams(p.mat, (p.mat.uniforms.params as Cesium.Cartesian4).x, p.surface ? 0.0 : 0.055, p.surface ? 0.16 : 0.15, 0.2);
      if (p.label) {
        p.label.show = a > 0.2;
        const anchor = this.labelAnchors[STRATA.findIndex((st) => st.depth === p.depth)] ?? this.corner;
        p.label.position = C.Cartesian3.add(anchor, C.Cartesian3.multiplyByScalar(this.up, offset, this.tmp), new C.Cartesian3());
        p.label.fillColor = setColor(this.tmpColor, [0.82, 0.9, 1], a);
        p.label.backgroundColor = setColor(this.tmpColor, [0.024, 0.04, 0.075], 0.6 * a);
      }
    }
  }

  /** Planes are hidden during the pick pass so they never occlude or corrupt picks below them. */
  get pickExcluded(): { show: boolean }[] {
    return this.planes.map((p) => p.prim);
  }

  clear() {
    for (const p of this.planes) this.scene.primitives.remove(p.prim);
    this.planes = [];
    this.labels.removeAll();
  }

  destroy() {
    this.clear();
    if (!this.labels.isDestroyed()) this.scene.primitives.remove(this.labels);
  }
}
