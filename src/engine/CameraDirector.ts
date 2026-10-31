/**
 * Camera choreography: cinematic arrival, home / node / footprint framing (deep-mode aware),
 * the oblique underground cross-section view, slow orbit, zoom / north / tilt helpers.
 * Every method is safe before the network is loaded.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import { clamp } from "@/engine/geographic/LocalFrame";
import type { NetworkGeometry } from "@/engine/rendering/NetworkGeometry";
import type { RegionInfo } from "@/types/infrastructure";

const D2R = Math.PI / 180;

export interface CameraContext {
  geom: () => NetworkGeometry | null;
  region: () => RegionInfo | null;
  /** true when world terrain is active (heights are absolute) */
  terrain: () => boolean;
  deep: () => boolean;
  depthScale: () => number;
  onOrbitChange?: (on: boolean) => void;
}

export class CameraDirector {
  private readonly C: CesiumModule;
  private readonly viewer: Cesium.Viewer;
  private readonly ctx: CameraContext;
  private orbiting = false;
  private orbitCenter: Cesium.Cartesian3 | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(C: CesiumModule, viewer: Cesium.Viewer, ctx: CameraContext) {
    this.C = C;
    this.viewer = viewer;
    this.ctx = ctx;
    const canvas = viewer.scene.canvas;
    const stop = () => {
      if (this.orbiting) this.setOrbit(false);
    };
    for (const ev of ["pointerdown", "wheel", "touchstart"] as const) {
      canvas.addEventListener(ev, stop, { passive: true });
      this.cleanup.push(() => canvas.removeEventListener(ev, stop));
    }
  }

  private get camera() {
    return this.viewer.scene.camera;
  }

  /** Ground height used for camera targets (absolute ellipsoidal metres). */
  private ground(): number {
    const g = this.ctx.geom();
    if (g) return g.frame.height;
    const r = this.ctx.region();
    return this.ctx.terrain() && r ? r.ground_elevation_m : 0;
  }

  /** Region default camera height expressed for the active globe (ellipsoid vs world terrain). */
  private homeHeight(r: RegionInfo): number {
    const cam = r.default_camera;
    const ge = r.ground_elevation_m ?? 0;
    // default_camera.height is an absolute altitude; on the bare ellipsoid the ground sits at 0
    const rel = cam.height > ge + 80 ? cam.height - ge : cam.height;
    return this.ground() + Math.max(120, rel);
  }

  /** Far establishing view (before / during arrival). */
  setSpaceView(lon = -84.39, lat = 33.75) {
    const C = this.C;
    this.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon + 6, lat - 18, 9_500_000),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO + 0.12, roll: 0 },
    });
  }

  /** Cinematic arrival: from the establishing shot into the region's default camera (~3.4 s). */
  arrive() {
    const r = this.ctx.region();
    if (!r) return;
    const C = this.C;
    const cam = r.default_camera;
    // establishing: high above the district, looking down, same heading
    this.camera.setView({
      destination: C.Cartesian3.fromDegrees(cam.longitude, cam.latitude - 0.06, this.ground() + 26000),
      orientation: { heading: cam.heading * D2R, pitch: -78 * D2R, roll: 0 },
    });
    this.flyHome({ duration: 3.4, easing: C.EasingFunction.QUADRATIC_IN_OUT });
  }

  flyHome(opts?: { duration?: number; easing?: Cesium.EasingFunction.Callback }) {
    const r = this.ctx.region();
    if (!r) return;
    this.setOrbit(false);
    const C = this.C;
    const cam = r.default_camera;
    this.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(cam.longitude, cam.latitude, this.homeHeight(r)),
      orientation: { heading: cam.heading * D2R, pitch: cam.pitch * D2R, roll: (cam.roll ?? 0) * D2R },
      duration: opts?.duration ?? 2.2,
      easingFunction: opts?.easing ?? C.EasingFunction.CUBIC_IN_OUT,
    });
  }

  /** Displayed node position at the *target* deep state (camera moves often start with the transition). */
  private nodeTarget(id: string): Cesium.Cartesian3 | null {
    const g = this.ctx.geom();
    if (!g) return null;
    const i = g.nodeIndex.get(id);
    if (i === undefined) return null;
    const n = g.nodes[i];
    return g.nodePositionFor(n, { depthScale: this.ctx.depthScale(), deepT: this.ctx.deep() ? 1 : 0 });
  }

  flyToNode(id: string, opts?: { duration?: number; range?: number }) {
    const C = this.C;
    const g = this.ctx.geom();
    const p = this.nodeTarget(id);
    if (!g || !p) return;
    this.setOrbit(false);
    const n = g.nodes[g.nodeIndex.get(id)!];
    const deep = this.ctx.deep();
    const under = n.underground && deep;
    const range = opts?.range ?? (under ? 380 : n.node.type === "service_zone" ? 900 : 600);
    const pitch = under ? -16 * D2R : -34 * D2R;
    this.camera.flyToBoundingSphere(new C.BoundingSphere(p, 1), {
      offset: new C.HeadingPitchRange(this.camera.heading, pitch, range),
      duration: opts?.duration ?? 1.8,
      easingFunction: C.EasingFunction.CUBIC_IN_OUT,
    });
  }

  flyToNodes(ids: string[], opts?: { duration?: number }) {
    const C = this.C;
    const pts = ids.map((id) => this.nodeTarget(id)).filter((p): p is Cesium.Cartesian3 => !!p);
    if (!pts.length) return;
    if (pts.length === 1) {
      this.flyToNode(ids.find((id) => this.nodeTarget(id))!, opts);
      return;
    }
    this.setOrbit(false);
    const bs = C.BoundingSphere.fromPoints(pts);
    const radius = Math.max(bs.radius, 180);
    const deep = this.ctx.deep();
    this.camera.flyToBoundingSphere(new C.BoundingSphere(bs.center, radius), {
      offset: new C.HeadingPitchRange(this.camera.heading, (deep ? -24 : -42) * D2R, Math.max(520, radius * 2.5)),
      duration: opts?.duration ?? 2.0,
      easingFunction: C.EasingFunction.CUBIC_IN_OUT,
    });
  }

  /** Deep view framing (exposed for tuning). Heights are fractions of the displayed max depth. */
  deepView = { headingDeg: 24, distK: 0.5, camBelowK: 0, camAboveK: 0.04, targetK: 0.85 };

  /** Oblique cross-section vantage just under the surface, looking across the layered district. */
  flyToDeepView(opts?: { duration?: number }) {
    const C = this.C;
    const g = this.ctx.geom();
    if (!g) return;
    this.setOrbit(false);
    const f = g.frame;
    const [x0, y0, x1, y1] = g.extent();
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const span = Math.max(x1 - x0, y1 - y0, 600);
    const maxDepth = Math.max(40, g.maxDisplayDepth(this.ctx.depthScale()));
    const t = this.deepView;
    const heading = t.headingDeg * D2R;
    const dist = span * t.distK;
    const camX = cx - Math.sin(heading) * dist;
    const camY = cy - Math.cos(heading) * dist;
    const [lon, lat] = f.toLonLat(camX, camY);
    const camH = f.height - maxDepth * t.camBelowK + span * t.camAboveK;
    // aim below the district centre so every stratum sits in frame
    const targetH = f.height - maxDepth * t.targetK;
    const pitch = Math.atan2(targetH - camH, dist);
    this.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(lon, lat, camH),
      orientation: { heading, pitch, roll: 0 },
      duration: opts?.duration ?? 3.0,
      easingFunction: C.EasingFunction.CUBIC_IN_OUT,
    });
  }

  /** Point under the screen centre (globe / ellipsoid), falling back to the region centre. */
  private viewCenter(): Cesium.Cartesian3 {
    const C = this.C;
    const scene = this.viewer.scene;
    const canvas = scene.canvas;
    const pos = new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = this.camera.getPickRay(pos);
    let p: Cesium.Cartesian3 | undefined;
    if (ray) {
      try {
        p = scene.globe.pick(ray, scene);
      } catch {
        p = undefined;
      }
    }
    if (!p) p = this.camera.pickEllipsoid(pos) ?? undefined;
    const g = this.ctx.geom();
    if (!p || (g && C.Cartesian3.distance(p, g.frame.origin) > 25000)) {
      if (g) return C.Cartesian3.clone(g.frame.origin);
      const r = this.ctx.region();
      if (r) return C.Cartesian3.fromDegrees(r.center[1], r.center[0], this.ground());
      return C.Cartesian3.fromDegrees(-84.39, 33.75);
    }
    return p;
  }

  setOrbit(enabled: boolean) {
    const C = this.C;
    if (enabled === this.orbiting) return;
    if (enabled) {
      this.orbitCenter = this.viewCenter();
      this.camera.lookAtTransform(C.Transforms.eastNorthUpToFixedFrame(this.orbitCenter));
      this.orbiting = true;
    } else {
      this.orbiting = false;
      this.orbitCenter = null;
      this.camera.lookAtTransform(C.Matrix4.IDENTITY);
    }
    this.ctx.onOrbitChange?.(this.orbiting);
  }

  isOrbiting() {
    return this.orbiting;
  }

  /** per-frame (orbit) */
  update(dt: number) {
    if (this.orbiting) this.camera.rotateRight(-dt * 0.055);
  }

  zoom(direction: 1 | -1) {
    const C = this.C;
    this.setOrbit(false);
    const center = this.viewCenter();
    const d = C.Cartesian3.distance(this.camera.positionWC, center);
    const amount = direction > 0 ? d * 0.42 : -d * 0.7;
    const dest = C.Cartesian3.add(this.camera.positionWC, C.Cartesian3.multiplyByScalar(this.camera.directionWC, amount, new C.Cartesian3()), new C.Cartesian3());
    this.camera.flyTo({
      destination: dest,
      orientation: { heading: this.camera.heading, pitch: this.camera.pitch, roll: 0 },
      duration: 0.6,
      easingFunction: C.EasingFunction.QUADRATIC_OUT,
    });
  }

  resetNorth() {
    const C = this.C;
    this.setOrbit(false);
    const center = this.viewCenter();
    const range = C.Cartesian3.distance(this.camera.positionWC, center);
    this.camera.flyToBoundingSphere(new C.BoundingSphere(center, 0), {
      offset: new C.HeadingPitchRange(0, this.camera.pitch, range),
      duration: 0.9,
      easingFunction: C.EasingFunction.CUBIC_IN_OUT,
    });
  }

  tilt(deltaDeg: number) {
    const C = this.C;
    this.setOrbit(false);
    const center = this.viewCenter();
    const range = C.Cartesian3.distance(this.camera.positionWC, center);
    const deep = this.ctx.deep();
    const pitch = clamp(this.camera.pitch + deltaDeg * D2R, -89.5 * D2R, (deep ? 25 : -6) * D2R);
    this.camera.flyToBoundingSphere(new C.BoundingSphere(center, 0), {
      offset: new C.HeadingPitchRange(this.camera.heading, pitch, range),
      duration: 0.6,
      easingFunction: C.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  destroy() {
    if (this.orbiting) {
      try {
        this.camera.lookAtTransform(this.C.Matrix4.IDENTITY);
      } catch {
        /* viewer may already be gone */
      }
    }
    this.orbiting = false;
    this.cleanup.forEach((f) => f());
  }
}
