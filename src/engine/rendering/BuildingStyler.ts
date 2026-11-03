/**
 * Cesium OSM Buildings with DEEPTRACE styling.
 *
 *  - Base look: graphite / blue-grey massing with a height gradient, soft directional shading
 *    and procedural warm "lit window" bands on facades (fading to an average glow at distance).
 *  - BLACKOUT: up to 12 outage zones (u_zone0..u_zone11 = centre relative to the district origin
 *    + radius) switch windows off and darken the massing; zones grow / shrink smoothly so a
 *    restoration visibly "re-lights" the block.
 *  - X-RAY (Deep Mode): a translucent variant fades buildings to ~6-12 % alpha with a cool
 *    fresnel rim so silhouettes stay readable; a scanline sweeps down through the city as the
 *    transition plays (u_xray 0 -> 1), and back up when leaving Deep Mode.
 *
 * Normals come from screen-space derivatives of positionEC, so the shader does not depend on
 * optional vertex attributes. World positions are reconstructed relative to the district origin
 * (camera offset uniform + inverse view rotation * positionEC) to keep full float precision.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import type { LocalFrame } from "@/engine/geographic/LocalFrame";

export const MAX_ZONES = 12;

export interface BlackoutZone {
  position: Cesium.Cartesian3;
  radius: number;
}

function shaderText(xray: boolean): string {
  const zoneCalls = Array.from({ length: MAX_ZONES }, (_, i) => `  dark = max(dark, dtZone(u_zone${i}, rel));`).join("\n");
  return `
#if (__VERSION__ == 300 || defined(GL_OES_standard_derivatives))
#define DT_DERIV 1
#endif

float dtHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float dtZone(vec4 z, vec3 rel) {
  if (z.w <= 0.5) return 0.0;
  vec3 d = rel - z.xyz;
  d -= dot(d, u_up) * u_up;
  return 1.0 - smoothstep(z.w * 0.68, z.w, length(d));
}

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
  vec3 posEC = fsInput.attributes.positionEC;
  vec3 V = normalize(-posEC);
#ifdef DT_DERIV
  vec3 nEC = normalize(cross(dFdx(posEC), dFdy(posEC)));
#else
  vec3 nEC = vec3(0.0, 0.0, 1.0);
#endif
  if (dot(nEC, V) < 0.0) nEC = -nEC;
  vec3 nW = normalize(czm_inverseViewRotation * nEC);
  vec3 rel = u_camRel + czm_inverseViewRotation * posEC;
  float h = dot(rel, u_up);
  float upness = dot(nW, u_up);
  float dist = length(posEC);

  // ---- massing (authored in sRGB, converted to linear at the end)
  float hN = clamp(h / 230.0, 0.0, 1.0);
  vec3 col = mix(vec3(0.085, 0.105, 0.145), vec3(0.235, 0.27, 0.335), pow(hN, 0.65));
  vec3 L = normalize(u_east * 0.45 - u_north * 0.55 + u_up * 0.72);
  float lam = 0.62 + 0.38 * max(dot(nW, L), 0.0);
  col *= lam;
  float roof = smoothstep(0.7, 0.95, upness);
  col = mix(col, vec3(0.16, 0.19, 0.24), roof * 0.55);
  // faint cool sky reflection on facades facing the camera at grazing angles
  float graze = pow(1.0 - abs(dot(nEC, V)), 3.0);
  col += vec3(0.05, 0.08, 0.14) * graze * (1.0 - roof);

  // ---- blackout zones
  float dark = 0.0;
${zoneCalls}

  // ---- lit windows
  float facade = 1.0 - smoothstep(0.2, 0.45, abs(upness));
  vec3 tang = normalize(cross(u_up, nW) + vec3(1e-5));
  vec2 g = vec2(dot(rel, tang) / 3.1, h / 3.7);
  vec2 cell = floor(g);
  vec2 fr = fract(g);
  float win = smoothstep(0.14, 0.22, fr.x) * (1.0 - smoothstep(0.78, 0.86, fr.x))
            * smoothstep(0.26, 0.34, fr.y) * (1.0 - smoothstep(0.74, 0.82, fr.y));
  vec2 block = floor(vec2(dot(rel, u_east), dot(rel, u_north)) / 55.0);
  float occupancy = 0.12 + 0.2 * dtHash(block * 3.7 + 1.3);
  float lit = step(1.0 - occupancy, dtHash(cell + block * 17.0));
  float warmth = dtHash(cell * 1.7 + 3.1);
  vec3 winCol = mix(vec3(1.0, 0.7, 0.36), vec3(0.72, 0.84, 1.0), step(0.86, warmth));
  float nearF = 1.0 - smoothstep(650.0, 2400.0, dist);
  float groundCut = smoothstep(3.0, 6.0, h);
  float windowGlow = facade * groundCut * (win * lit * nearF + (1.0 - nearF) * occupancy * 0.32);
  col += winCol * windowGlow * 0.7 * (1.0 - dark);
  // blackout: darker massing, faint emergency-lighting tint on lower floors
  col *= mix(1.0, 0.42, dark);
  col += vec3(0.32, 0.07, 0.04) * dark * facade * (1.0 - smoothstep(4.0, 26.0, h)) * 0.12;

  float alpha = 1.0;
${
  xray
    ? `
  // ---- X-RAY
  float scanH = mix(u_scanTop, -70.0, u_xray);
  float xr = smoothstep(scanH - 14.0, scanH + 14.0, h);
  xr = u_xray >= 0.999 ? 1.0 : (u_xray <= 0.001 ? 0.0 : xr);
  float fres = pow(1.0 - abs(dot(nEC, V)), 2.0);
  vec3 xcol = vec3(0.3, 0.58, 1.0) * (0.24 + 1.3 * fres) + vec3(0.55, 0.8, 1.0) * roof * 0.1;
  xcol += winCol * windowGlow * 0.18 * (1.0 - dark);
  float xa = 0.085 + 0.5 * fres + roof * 0.05;
  col = mix(col, xcol, xr);
  alpha = mix(1.0, xa, xr);
  float band = (1.0 - smoothstep(0.0, 6.0, abs(h - scanH))) * step(0.002, u_xray) * step(u_xray, 0.998);
  col += vec3(0.4, 0.82, 1.0) * band * 1.4;
  alpha = max(alpha, band * 0.8);
`
    : ""
}
  material.diffuse = czm_srgbToLinear(clamp(col, 0.0, 1.0));
  material.alpha = alpha;
}
`;
}

export class BuildingStyler {
  private readonly C: CesiumModule;
  private readonly scene: Cesium.Scene;
  tileset: Cesium.Cesium3DTileset | null = null;
  readonly opaque: Cesium.CustomShader;
  readonly xray: Cesium.CustomShader;
  private frame: LocalFrame;
  private xrayT = 0;
  private active: "opaque" | "xray" = "opaque";
  private readonly slotsTarget: { rel: Cesium.Cartesian3; radius: number }[];
  private readonly slotsCur: { rel: Cesium.Cartesian3; radius: number }[];
  private readonly scratch: Cesium.Cartesian3;
  private readonly zoneVec: Cesium.Cartesian4[];
  private destroyed = false;
  /** additional glTF models styled like the city (kept in sync with the x-ray state) */
  private readonly models = new Set<{ customShader: Cesium.CustomShader | undefined; isDestroyed(): boolean }>();

  constructor(C: CesiumModule, scene: Cesium.Scene, frame: LocalFrame) {
    this.C = C;
    this.scene = scene;
    this.frame = frame;
    this.scratch = new C.Cartesian3();
    this.zoneVec = Array.from({ length: MAX_ZONES }, () => new C.Cartesian4(0, 0, 0, 0));
    this.slotsTarget = Array.from({ length: MAX_ZONES }, () => ({ rel: new C.Cartesian3(), radius: 0 }));
    this.slotsCur = Array.from({ length: MAX_ZONES }, () => ({ rel: new C.Cartesian3(), radius: 0 }));
    this.opaque = this.createShader(false);
    this.xray = this.createShader(true);
  }

  createShader(xray: boolean): Cesium.CustomShader {
    const C = this.C;
    const uniforms: Record<string, Cesium.UniformSpecifier> = {
      u_xray: { type: C.UniformType.FLOAT, value: 0 },
      u_time: { type: C.UniformType.FLOAT, value: 0 },
      u_scanTop: { type: C.UniformType.FLOAT, value: 340 },
      u_camRel: { type: C.UniformType.VEC3, value: new C.Cartesian3() },
      u_east: { type: C.UniformType.VEC3, value: C.Cartesian3.clone(this.frame.east) },
      u_north: { type: C.UniformType.VEC3, value: C.Cartesian3.clone(this.frame.north) },
      u_up: { type: C.UniformType.VEC3, value: C.Cartesian3.clone(this.frame.up) },
    };
    for (let i = 0; i < MAX_ZONES; i++) uniforms[`u_zone${i}`] = { type: C.UniformType.VEC4, value: new C.Cartesian4(0, 0, 0, 0) };
    return new C.CustomShader({
      lightingModel: C.LightingModel.UNLIT,
      translucencyMode: xray ? C.CustomShaderTranslucencyMode.TRANSLUCENT : C.CustomShaderTranslucencyMode.OPAQUE,
      uniforms,
      fragmentShaderText: shaderText(xray),
    });
  }

  /** Stream Cesium OSM Buildings (requires an ion token). Resolves false when unavailable. */
  async load(offsetForEllipsoid: number): Promise<boolean> {
    const C = this.C;
    try {
      const tileset = await C.createOsmBuildingsAsync({
        style: new C.Cesium3DTileStyle({ color: "color('#ffffff')" }),
        showOutline: false,
      });
      if (this.destroyed) {
        tileset.destroy();
        return false;
      }
      tileset.customShader = this.opaque;
      tileset.maximumScreenSpaceError = 12;
      if (offsetForEllipsoid) {
        // Without world terrain the globe is the bare ellipsoid; drop buildings onto it.
        const t = C.Cartesian3.multiplyByScalar(this.frame.up, -offsetForEllipsoid, new C.Cartesian3());
        tileset.modelMatrix = C.Matrix4.fromTranslation(t);
      }
      this.scene.primitives.add(tileset);
      this.tileset = tileset;
      return true;
    } catch (e) {
      console.warn("[deeptrace] OSM Buildings unavailable:", (e as Error)?.message ?? e);
      return false;
    }
  }

  setFrame(frame: LocalFrame) {
    const C = this.C;
    const oldOrigin = this.frame.origin;
    this.frame = frame;
    for (const sh of [this.opaque, this.xray]) {
      sh.setUniform("u_east", frame.east);
      sh.setUniform("u_north", frame.north);
      sh.setUniform("u_up", frame.up);
    }
    // re-express zone centres relative to the new origin
    const shift = C.Cartesian3.subtract(oldOrigin, frame.origin, new C.Cartesian3());
    for (const z of [...this.slotsCur, ...this.slotsTarget]) C.Cartesian3.add(z.rel, shift, z.rel);
  }

  /** Outage zones in the displayed result (centre + radius in metres). */
  setZones(zones: BlackoutZone[]) {
    const C = this.C;
    const next = zones.slice(0, MAX_ZONES).map((z) => ({
      rel: C.Cartesian3.subtract(z.position, this.frame.origin, new C.Cartesian3()),
      radius: z.radius,
    }));
    const assigned = new Array<boolean>(MAX_ZONES).fill(false);
    const pending: typeof next = [];
    // keep slots stable so radii animate (blackout spreads, restoration re-lights) instead of jumping
    for (const z of next) {
      let best = -1;
      let bd = 80;
      for (let i = 0; i < MAX_ZONES; i++) {
        if (assigned[i] || this.slotsCur[i].radius < 1) continue;
        const d = C.Cartesian3.distance(this.slotsCur[i].rel, z.rel);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) {
        assigned[best] = true;
        C.Cartesian3.clone(z.rel, this.slotsTarget[best].rel);
        this.slotsTarget[best].radius = z.radius;
      } else pending.push(z);
    }
    for (const z of pending) {
      let slot = -1;
      let smallest = Infinity;
      for (let i = 0; i < MAX_ZONES; i++) {
        if (assigned[i]) continue;
        if (this.slotsCur[i].radius < smallest) {
          smallest = this.slotsCur[i].radius;
          slot = i;
        }
      }
      if (slot < 0) break;
      assigned[slot] = true;
      C.Cartesian3.clone(z.rel, this.slotsTarget[slot].rel);
      C.Cartesian3.clone(z.rel, this.slotsCur[slot].rel);
      this.slotsCur[slot].radius = 0;
      this.slotsTarget[slot].radius = z.radius;
    }
    for (let i = 0; i < MAX_ZONES; i++) if (!assigned[i]) this.slotsTarget[i].radius = 0;
  }

  get hasZones() {
    return this.slotsCur.some((z) => z.radius > 1);
  }

  /** Per-frame update. xray: 0..1 eased deep-mode factor. */
  update(dt: number, time: number, xray: number) {
    if (this.destroyed) return;
    const C = this.C;
    this.xrayT = xray;
    const want = xray > 0.0005 ? "xray" : "opaque";
    if (want !== this.active) {
      const sh = want === "xray" ? this.xray : this.opaque;
      if (this.tileset) this.tileset.customShader = sh;
      for (const m of this.models) if (!m.isDestroyed()) m.customShader = sh;
    }
    this.active = want;
    const sh = want === "xray" ? this.xray : this.opaque;
    const cam = this.scene.camera.positionWC;
    C.Cartesian3.subtract(cam, this.frame.origin, this.scratch);
    sh.setUniform("u_camRel", this.scratch);
    sh.setUniform("u_xray", xray);
    sh.setUniform("u_time", time);
    // animate zone radii (blackout spreads over ~1.2 s, restoration re-lights over ~1.6 s)
    for (let i = 0; i < MAX_ZONES; i++) {
      const c = this.slotsCur[i];
      const t = this.slotsTarget[i];
      const v = this.zoneVec[i];
      const rate = t.radius > c.radius ? 2.4 : 1.7;
      c.radius += (t.radius - c.radius) * Math.min(1, dt * rate);
      if (Math.abs(t.radius - c.radius) < 0.5) c.radius = t.radius;
      if (t.radius > 0) C.Cartesian3.clone(t.rel, c.rel);
      v.x = c.rel.x;
      v.y = c.rel.y;
      v.z = c.rel.z;
      v.w = c.radius;
      sh.setUniform(`u_zone${i}`, v);
    }
  }

  /** Style an arbitrary glTF Model like the city buildings (lit windows, blackout, x-ray). */
  addModel(model: { customShader: Cesium.CustomShader | undefined; isDestroyed(): boolean }) {
    this.models.add(model);
    model.customShader = this.active === "xray" ? this.xray : this.opaque;
  }

  get hasModels() {
    return this.models.size > 0;
  }

  removeModel(model: { customShader: Cesium.CustomShader | undefined; isDestroyed(): boolean }) {
    this.models.delete(model);
  }

  get xrayValue() {
    return this.xrayT;
  }

  destroy() {
    this.destroyed = true;
    for (const m of this.models) if (!m.isDestroyed()) m.customShader = undefined;
    this.models.clear();
    if (this.tileset && !this.tileset.isDestroyed()) {
      this.scene.primitives.remove(this.tileset);
    }
    this.tileset = null;
    try {
      this.opaque.destroy();
      this.xray.destroy();
    } catch {
      /* ignore */
    }
  }
}
