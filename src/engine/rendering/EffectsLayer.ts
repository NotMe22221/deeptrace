/**
 * One-shot cascade effects and outage areas:
 *  - shockwave: red ring expanding on the ground from initiating failures (+ bright flare)
 *  - ripple:    smaller rings at nodes newly affected in a cascade step (state colour)
 *  - outage glows: soft discs over de-energised power areas (reads even without 3D buildings)
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import { easeOutCubic } from "@/engine/geographic/LocalFrame";
import { glowSprite } from "./icons";
import { createMaterial, setParams } from "./materials";
import { setColor, type RGB } from "./palette";

interface RingFx {
  prim: Cesium.Primitive;
  mat: Cesium.Material;
  start: number;
  duration: number;
  alpha: number;
  thickness: number;
}

interface FlareFx {
  bb: Cesium.Billboard;
  start: number;
  duration: number;
  rgb: RGB;
  size: number;
}

export interface RingSpec {
  /** ground position (lon/lat used) */
  lon: number;
  lat: number;
  /** ellipsoidal height for the ring plane */
  height: number;
}

export class EffectsLayer {
  private readonly C: CesiumModule;
  private readonly scene: Cesium.Scene;
  private rings: RingFx[] = [];
  private flares: FlareFx[] = [];
  readonly flareCollection: Cesium.BillboardCollection;
  private outage: Cesium.Primitive | null = null;
  private outageMat: Cesium.Material | null = null;
  private outageKey = "";
  private readonly tmpColor: Cesium.Color;

  constructor(C: CesiumModule, scene: Cesium.Scene) {
    this.C = C;
    this.scene = scene;
    this.flareCollection = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.tmpColor = new C.Color();
  }

  private ringPrimitive(specs: RingSpec[], radius: number, mat: Cesium.Material): Cesium.Primitive {
    const C = this.C;
    const instances = specs.map(
      (s) =>
        new C.GeometryInstance({
          geometry: new C.EllipseGeometry({
            center: C.Cartesian3.fromDegrees(s.lon, s.lat),
            semiMajorAxis: radius,
            semiMinorAxis: radius,
            height: s.height,
            granularity: C.Math.RADIANS_PER_DEGREE * 0.5,
            vertexFormat: C.VertexFormat.POSITION_NORMAL_AND_ST,
          }),
        }),
    );
    return this.scene.primitives.add(
      new C.Primitive({
        geometryInstances: instances,
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
        compressVertices: false,
      }),
    );
  }

  /** Expanding rings at the given points. */
  addRings(specs: RingSpec[], rgb: RGB, radius: number, duration: number, alpha = 0.9, thickness = 0.06) {
    if (!specs.length) return;
    const C = this.C;
    const mat = createMaterial(C, "ring", setColor(this.tmpColor, rgb, alpha), [0, thickness, 0.18, 0]);
    try {
      const prim = this.ringPrimitive(specs.slice(0, 40), radius, mat);
      this.rings.push({ prim, mat, start: performance.now() / 1000, duration, alpha, thickness });
    } catch (e) {
      console.warn("[deeptrace] ring effect failed", e);
    }
  }

  shockwave(specs: RingSpec[], positions: Cesium.Cartesian3[]) {
    const red: RGB = [0.96, 0.25, 0.37];
    this.addRings(specs, red, 620, 2.6, 0.95, 0.045);
    this.addRings(specs, [1, 0.55, 0.45], 260, 1.5, 0.7, 0.08);
    for (const p of positions.slice(0, 12)) this.flare(p, [1, 0.42, 0.42], 220, 0.9);
  }

  ripple(specs: RingSpec[], rgb: RGB) {
    this.addRings(specs, rgb, 140, 1.7, 0.85, 0.08);
  }

  flare(position: Cesium.Cartesian3, rgb: RGB, size: number, duration: number) {
    const bb = this.flareCollection.add({
      position,
      image: glowSprite("flare"),
      width: size,
      height: size,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      color: setColor(this.tmpColor, rgb, 1),
    });
    this.flares.push({ bb, start: performance.now() / 1000, duration, rgb, size });
  }

  /** Soft outage discs (rebuilt only when the zone set changes). */
  setOutageZones(zones: { lon: number; lat: number; height: number; radius: number }[]) {
    const key = zones.map((z) => `${z.lon.toFixed(5)},${z.lat.toFixed(5)},${Math.round(z.radius)},${Math.round(z.height)}`).join("|");
    if (key === this.outageKey) return;
    this.outageKey = key;
    if (this.outage) {
      this.scene.primitives.remove(this.outage);
      this.outage = null;
    }
    if (!zones.length) return;
    const C = this.C;
    if (!this.outageMat) this.outageMat = createMaterial(C, "glow", setColor(this.tmpColor, [0.98, 0.45, 0.09], 0.32), [0, 0, 0, 0]);
    const instances = zones.map(
      (z) =>
        new C.GeometryInstance({
          geometry: new C.EllipseGeometry({
            center: C.Cartesian3.fromDegrees(z.lon, z.lat),
            semiMajorAxis: z.radius,
            semiMinorAxis: z.radius,
            height: z.height,
            granularity: C.Math.RADIANS_PER_DEGREE * 0.5,
            vertexFormat: C.VertexFormat.POSITION_NORMAL_AND_ST,
          }),
        }),
    );
    try {
      this.outage = this.scene.primitives.add(
        new C.Primitive({
          geometryInstances: instances,
          appearance: new C.MaterialAppearance({
            material: this.outageMat,
            translucent: true,
            flat: true,
            faceForward: true,
            closed: false,
            renderState: { depthTest: { enabled: true }, depthMask: false, cull: { enabled: false } },
          }),
          asynchronous: false,
          allowPicking: false,
        }),
      );
    } catch (e) {
      console.warn("[deeptrace] outage glow failed", e);
    }
  }

  update(time: number) {
    const now = performance.now() / 1000;
    if (this.rings.length) {
      const keep: RingFx[] = [];
      for (const r of this.rings) {
        const k = (now - r.start) / r.duration;
        if (k >= 1) {
          this.scene.primitives.remove(r.prim);
          continue;
        }
        setParams(r.mat, easeOutCubic(Math.max(0, k)), r.thickness, 0.18, 0);
        keep.push(r);
      }
      this.rings = keep;
    }
    if (this.flares.length) {
      const keep: FlareFx[] = [];
      for (const f of this.flares) {
        const k = (now - f.start) / f.duration;
        if (k >= 1) {
          this.flareCollection.remove(f.bb);
          continue;
        }
        f.bb.scale = 0.4 + easeOutCubic(k) * 1.1;
        f.bb.color = setColor(this.tmpColor, f.rgb, (1 - k) * (1 - k));
        keep.push(f);
      }
      this.flares = keep;
    }
    if (this.outageMat) setParams(this.outageMat, 0.5 + 0.5 * Math.sin(time * 2.2), 0, 0, 0);
  }

  clear() {
    for (const r of this.rings) this.scene.primitives.remove(r.prim);
    this.rings = [];
    this.flareCollection.removeAll();
    this.flares = [];
  }

  destroy() {
    this.clear();
    if (this.outage) this.scene.primitives.remove(this.outage);
    if (!this.flareCollection.isDestroyed()) this.scene.primitives.remove(this.flareCollection);
  }
}
