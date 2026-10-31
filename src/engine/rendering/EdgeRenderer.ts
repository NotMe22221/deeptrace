/**
 * Network connections as batched PolylineCollections:
 *  - lines: physical edges (surface: glowing lines; buried: ghost dashed traces at the surface
 *    that drop to depth and light up in Deep Mode) + ghost traces of utility corridors
 *  - tubes: utility corridors (duct banks / tunnels) as wide translucent shaded tubes (Deep Mode)
 *  - arcs:  dependency edges as dashed, marching arcs lifted above the ground
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import { lerp } from "@/engine/geographic/LocalFrame";
import type { SystemType } from "@/types/infrastructure";
import type { DisplayModel, EdgeVisual } from "./displayState";
import { createMaterial, setDash, setParams } from "./materials";
import type { EdgeGeom, NetworkGeometry } from "./NetworkGeometry";
import { setColor, WHITE, mixRgb } from "./palette";

export interface PickId {
  dt: "node" | "edge";
  id: string;
}

const BASE_WIDTH: Record<SystemType, number> = {
  power: 6.5,
  water: 7.5,
  telecom: 5.5,
  transport: 4.6,
  underground: 6,
  facility: 5,
};

interface EdgeEntry {
  g: EdgeGeom;
  pickId: PickId;
  main: Cesium.Polyline;
  mainMat: Cesium.Material;
  /** corridors: ghost trace in `lines` while the tube lives in `tubes` */
  ghost?: Cesium.Polyline;
  ghostMat?: Cesium.Material;
  vis?: EdgeVisual;
  flashStart: number;
}

export class EdgeRenderer {
  private readonly C: CesiumModule;
  private readonly scene: Cesium.Scene;
  readonly lines: Cesium.PolylineCollection;
  readonly tubes: Cesium.PolylineCollection;
  readonly arcs: Cesium.PolylineCollection;
  private entries: EdgeEntry[] = [];
  private byId = new Map<string, EdgeEntry>();
  private display: DisplayModel | null = null;
  private deepT = 0;
  private hovered: string | null = null;
  private animated: EdgeEntry[] = [];
  private readonly tmpColor: Cesium.Color;

  constructor(C: CesiumModule, scene: Cesium.Scene) {
    this.C = C;
    this.scene = scene;
    this.tubes = scene.primitives.add(new C.PolylineCollection());
    this.lines = scene.primitives.add(new C.PolylineCollection());
    this.arcs = scene.primitives.add(new C.PolylineCollection());
    this.tmpColor = new C.Color();
  }

  build(geom: NetworkGeometry) {
    const C = this.C;
    this.lines.removeAll();
    this.tubes.removeAll();
    this.arcs.removeAll();
    this.entries = [];
    this.byId.clear();
    // sort so polylines that usually share a style are consecutive (better draw-call merging)
    const order = [...geom.edges].sort((a, b) => (a.cls + a.system).localeCompare(b.cls + b.system));
    for (const g of order) {
      const pickId: PickId = { dt: "edge", id: g.id };
      const col = setColor(this.tmpColor, [1, 1, 1], 1);
      let entry: EdgeEntry;
      if (g.cls === "dependency") {
        const mat = createMaterial(C, "line", col, [0, 0, 1, 26]);
        const main = this.arcs.add({ positions: g.positions, width: 2.4, material: mat, id: pickId });
        entry = { g, pickId, main, mainMat: mat, flashStart: -1 };
      } else if (g.cls === "corridor") {
        const mat = createMaterial(C, "tube", col, [1, 0, 0, 0]);
        const main = this.tubes.add({ positions: g.positions, width: 18, material: mat, id: pickId });
        const gm = createMaterial(C, "line", col, [0, 0, 1, 0]);
        const ghost = this.lines.add({ positions: g.positions, width: 3, material: gm, id: pickId });
        entry = { g, pickId, main, mainMat: mat, ghost, ghostMat: gm, flashStart: -1 };
      } else {
        const mat = createMaterial(C, "line", col, [1, 0, 0, 0]);
        const main = this.lines.add({ positions: g.positions, width: BASE_WIDTH[g.system] ?? 6, material: mat, id: pickId });
        entry = { g, pickId, main, mainMat: mat, flashStart: -1 };
      }
      this.entries.push(entry);
      this.byId.set(g.id, entry);
    }
  }

  /** Push displayed positions (after depth / ground changes). */
  updatePositions() {
    for (const e of this.entries) {
      e.main.positions = e.g.positions;
      if (e.ghost) e.ghost.positions = e.g.positions;
    }
  }

  setHovered(id: string | null) {
    this.hovered = id;
  }

  /** Mark edges that just changed state during cascade playback (flash then settle). */
  flash(ids: string[], time: number) {
    for (const id of ids) {
      const e = this.byId.get(id);
      if (e) e.flashStart = time;
    }
  }

  applyDisplay(model: DisplayModel, deepT: number) {
    this.display = model;
    this.deepT = deepT;
    this.restyle(performance.now() / 1000);
  }

  setDeepT(deepT: number) {
    this.deepT = deepT;
  }

  /** Full restyle (display change or deep transition frame). */
  restyle(time: number) {
    const model = this.display;
    if (!model) return;
    this.animated = [];
    for (const e of this.entries) {
      const v = model.edges[e.g.idx];
      e.vis = v;
      this.style(e, v, time);
      if (v.visible && (v.pulse !== "none" || e.flashStart >= 0 || e.g.id === this.hovered)) this.animated.push(e);
    }
  }

  private style(e: EdgeEntry, v: EdgeVisual, time: number) {
    const g = e.g;
    const deep = this.deepT;
    const hover = this.hovered === g.id;
    let pulseA = 1;
    let pulseCore = 0;
    let pulseW = 1;
    if (v.pulse === "fail") {
      const p = 0.5 + 0.5 * Math.sin(time * Math.PI * 2 * 1.1);
      pulseA = 0.55 + 0.45 * p;
      pulseCore = 0.5 * p;
      pulseW = 1 + 0.25 * p;
    }
    if (e.flashStart >= 0) {
      const k = (time - e.flashStart) / 0.9;
      if (k >= 1 || k < 0) e.flashStart = -1;
      else {
        const f = 1 - k;
        pulseCore = Math.max(pulseCore, f);
        pulseW = Math.max(pulseW, 1 + 0.8 * f);
        pulseA = Math.max(pulseA, 1);
      }
    }
    if (hover) {
      pulseCore = Math.max(pulseCore, 0.45);
      pulseW *= 1.3;
    }
    const emph = v.trace !== "none" || v.core > 0.3 || v.widthMul > 1.2;
    const core = Math.min(1, v.core + pulseCore);
    const rgb = v.trace === "up" ? mixRgb(v.rgb, WHITE, 0.25) : v.rgb;

    if (g.cls === "dependency") {
      const show = v.visible && v.alpha > 0.02;
      e.main.show = show;
      if (!show) return;
      const traceDep = v.trace === "dep" || v.trace === "up" || v.trace === "down";
      // logical dependency: dotted marching arc (provider -> dependent), never a solid line
      setColor(e.mainMat.uniforms.color, rgb, Math.min(1, v.alpha * pulseA * (traceDep ? 1 : 0.8)));
      setParams(e.mainMat, traceDep ? 0.7 : 0.35, core * 0.6, 1, traceDep ? 46 : 18);
      setDash(e.mainMat, traceDep ? 12 : 9, traceDep ? 0.42 : 0.32);
      const w = (traceDep ? 4.2 : 3.0) * v.widthMul * pulseW;
      if (e.main.width !== w) e.main.width = w;
      return;
    }

    const base = BASE_WIDTH[g.system] ?? 6;
    if (g.cls === "surface") {
      const show = v.visible && v.alpha > 0.02;
      e.main.show = show;
      if (!show) return;
      const road = g.system === "transport" && !/rail/.test(g.edge.connection_type);
      setColor(e.mainMat.uniforms.color, rgb, Math.min(1, v.alpha * pulseA * (road && !v.impacted && !emph ? 0.62 : 1)));
      setParams(e.mainMat, road ? 0.75 : 1, core, v.dashed ? 1 : 0, 0);
      setDash(e.mainMat, 13, 0.52);
      const w = base * v.widthMul * pulseW;
      if (e.main.width !== w) e.main.width = w;
      return;
    }

    // buried + corridor: ghost (surface) -> lit (deep)
    const ghostiness = (1 - deep) * (emph ? 0.25 : 1);
    if (g.cls === "buried") {
      const show = v.visible && v.alpha > 0.02;
      e.main.show = show;
      if (!show) return;
      const a = v.alpha * pulseA * lerp(1, 0.34, ghostiness);
      setColor(e.mainMat.uniforms.color, rgb, Math.min(1, a));
      setParams(e.mainMat, 1 - ghostiness, core, Math.max(v.dashed ? 1 : 0, ghostiness > 0.5 ? 1 : ghostiness * 2), 0);
      setDash(e.mainMat, lerp(13, 7, ghostiness), lerp(0.52, 0.62, ghostiness));
      const w = lerp(base * v.widthMul, 2.0, ghostiness) * pulseW;
      if (e.main.width !== w) e.main.width = w;
      return;
    }

    // corridor
    const show = v.visible && v.alpha > 0.02;
    const tubeA = v.alpha * pulseA * (1 - ghostiness) * (emph ? 1.4 : 1);
    e.main.show = show && tubeA > 0.01;
    if (e.main.show) {
      setColor(e.mainMat.uniforms.color, v.impacted || emph ? rgb : rgb, Math.min(1, tubeA));
      setParams(e.mainMat, 1, 0, 0, 0);
      const w = lerp(6, 20, deep) * v.widthMul * pulseW;
      if (e.main.width !== w) e.main.width = w;
    }
    if (e.ghost && e.ghostMat) {
      const ga = v.alpha * pulseA * ghostiness * 0.5;
      e.ghost.show = show && ga > 0.01;
      if (e.ghost.show) {
        setColor(e.ghostMat.uniforms.color, rgb, Math.min(1, ga));
        setParams(e.ghostMat, 0, core, 1, 0);
        setDash(e.ghostMat, 7, 0.62);
        if (e.ghost.width !== 2.4) e.ghost.width = 2.4;
      }
    }
  }

  /** Per-frame: dash marching time + animated (pulsing / flashing / hovered) edges. */
  animate(time: number) {
    for (const e of this.entries) {
      if (e.g.cls === "dependency" || e.mainMat.uniforms.time !== undefined) e.mainMat.uniforms.time = time;
    }
    if (!this.animated.length) return;
    const keep: EdgeEntry[] = [];
    for (const e of this.animated) {
      if (!e.vis) continue;
      this.style(e, e.vis, time);
      if (e.vis.pulse !== "none" || e.flashStart >= 0 || e.g.id === this.hovered) keep.push(e);
    }
    this.animated = keep;
  }

  /** Re-include an edge in the animated list (hover / flash started). */
  touch(id: string | null) {
    if (!id) return;
    const e = this.byId.get(id);
    if (e && !this.animated.includes(e)) this.animated.push(e);
  }

  destroy() {
    for (const c of [this.lines, this.tubes, this.arcs]) {
      if (!c.isDestroyed()) this.scene.primitives.remove(c);
    }
  }
}
