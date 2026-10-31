/**
 * Optional detailed 3D models for node types listed in public/assets/models/manifest.json:
 *   {"version":1,"models":{"<node_type>":{"uri","scale","heightOffset","headingDeg","credit"}}}
 * Models load lazily when the camera is within ~1.5 km of a matching node and hide beyond ~2 km.
 * With an empty / missing manifest this does nothing.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import type { NetworkGeometry } from "./NetworkGeometry";

interface ModelSpec {
  uri: string;
  scale?: number;
  heightOffset?: number;
  headingDeg?: number;
  credit?: string;
}

interface Slot {
  nodeIdx: number;
  spec: ModelSpec;
  model: Cesium.Model | null;
  loading: boolean;
  failed: boolean;
}

const LOAD_RANGE = 1500;
const HIDE_RANGE = 2000;

export class ModelLodManager {
  private readonly C: CesiumModule;
  private readonly viewer: Cesium.Viewer;
  private specs: Record<string, ModelSpec> = {};
  private slots: Slot[] = [];
  private credits = new Set<string>();
  private lastCheck = 0;
  private destroyed = false;
  private geom: NetworkGeometry | null = null;

  constructor(C: CesiumModule, viewer: Cesium.Viewer) {
    this.C = C;
    this.viewer = viewer;
    void this.loadManifest();
  }

  private async loadManifest() {
    try {
      const r = await fetch("/assets/models/manifest.json", { cache: "no-cache" });
      if (!r.ok) return;
      const m = (await r.json()) as { version?: number; models?: Record<string, ModelSpec> };
      if (this.destroyed || !m?.models) return;
      this.specs = Object.fromEntries(Object.entries(m.models).filter(([, v]) => v && typeof v.uri === "string" && v.uri.length > 0));
      if (this.geom) this.setGeometry(this.geom);
    } catch {
      /* no manifest: harmless */
    }
  }

  setGeometry(geom: NetworkGeometry) {
    this.geom = geom;
    this.clearModels();
    this.slots = [];
    if (!Object.keys(this.specs).length) return;
    for (const n of geom.nodes) {
      const spec = this.specs[n.node.type];
      if (spec) this.slots.push({ nodeIdx: n.idx, spec, model: null, loading: false, failed: false });
    }
  }

  private matrixFor(slot: Slot): Cesium.Matrix4 {
    const C = this.C;
    const n = this.geom!.nodes[slot.nodeIdx];
    const pos = C.Cartesian3.add(n.pos, C.Cartesian3.multiplyByScalar(n.up, slot.spec.heightOffset ?? 0, new C.Cartesian3()), new C.Cartesian3());
    const hpr = new C.HeadingPitchRoll(C.Math.toRadians(slot.spec.headingDeg ?? 0), 0, 0);
    const m = C.Transforms.headingPitchRollToFixedFrame(pos, hpr);
    const s = slot.spec.scale ?? 1;
    return C.Matrix4.multiplyByUniformScale(m, s, m);
  }

  /** Call every frame; work is throttled to ~2 Hz. */
  update(positionsChanged: boolean) {
    if (!this.slots.length || !this.geom) return;
    const C = this.C;
    if (positionsChanged) for (const s of this.slots) if (s.model) s.model.modelMatrix = this.matrixFor(s);
    const now = performance.now();
    if (now - this.lastCheck < 500) return;
    this.lastCheck = now;
    const cam = this.viewer.scene.camera.positionWC;
    for (const s of this.slots) {
      const n = this.geom.nodes[s.nodeIdx];
      const d = C.Cartesian3.distance(cam, n.pos);
      if (s.model) s.model.show = d < HIDE_RANGE;
      else if (d < LOAD_RANGE && !s.loading && !s.failed) void this.load(s);
    }
  }

  private async load(s: Slot) {
    const C = this.C;
    s.loading = true;
    try {
      const model = await C.Model.fromGltfAsync({ url: s.spec.uri, modelMatrix: this.matrixFor(s), minimumPixelSize: 0 });
      if (this.destroyed) {
        model.destroy();
        return;
      }
      this.viewer.scene.primitives.add(model);
      s.model = model;
      if (s.spec.credit && !this.credits.has(s.spec.credit)) {
        this.credits.add(s.spec.credit);
        this.viewer.creditDisplay.addStaticCredit(new C.Credit(s.spec.credit, false));
      }
    } catch (e) {
      s.failed = true;
      console.warn("[deeptrace] model failed to load", s.spec.uri, e);
    } finally {
      s.loading = false;
    }
  }

  private clearModels() {
    for (const s of this.slots) {
      if (s.model && !s.model.isDestroyed()) this.viewer.scene.primitives.remove(s.model);
      s.model = null;
    }
  }

  destroy() {
    this.destroyed = true;
    this.clearModels();
  }
}
