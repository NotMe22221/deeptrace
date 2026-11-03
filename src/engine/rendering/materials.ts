/**
 * Custom Fabric materials for network lines, corridor tubes, shockwave rings, strata grids and
 * outage glows. Materials of the same type share one shader program; PolylineCollection merges
 * consecutive polylines whose uniform values are identical into one draw call.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";

const DERIV = `#if (__VERSION__ == 300 || defined(GL_OES_standard_derivatives))
#define DT_HAS_DERIV 1
#endif
`;

/**
 * Glowing network line. params: x glow (0 flat .. 1 soft halo), y white-hot core, z dash mix,
 * w dash march speed (px/s, signed); shape: x dash period (px), y duty cycle (0..1).
 * Dashes are screen-space so they stay crisp at any zoom.
 */
const LINE_SRC = `
uniform vec4 color;
uniform vec4 params;
uniform vec4 shape;
uniform float time;
in float v_polylineAngle;

mat2 dtRot(float rad) {
  float c = cos(rad);
  float s = sin(rad);
  return mat2(c, s, -s, c);
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  float d = abs(materialInput.st.t - 0.5) * 2.0;
  float glow = params.x;
  float coreW = mix(0.9, 0.3, glow);
  float body = 1.0 - smoothstep(coreW * 0.72, coreW, d);
  float halo = glow * exp(-d * d * 3.6) * 0.7;
  float hot = params.y * (1.0 - smoothstep(0.0, coreW * 0.6, d));
  vec3 rgb = color.rgb * (body * 1.05 + halo) + vec3(hot) * 0.9;
  float a = clamp(body + halo, 0.0, 1.0) * color.a;
  if (params.z > 0.001) {
    vec2 pos = dtRot(v_polylineAngle) * gl_FragCoord.xy;
    float dashLen = shape.x * czm_pixelRatio;
    float ph = fract((pos.x - time * params.w * czm_pixelRatio) / dashLen);
    float on = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(shape.y, shape.y + 0.06, ph));
    a *= mix(1.0, on, params.z);
  }
  if (a < 0.004) discard;
  vec4 c = czm_gammaCorrect(vec4(rgb, a));
  material.emission = c.rgb;
  material.alpha = c.a;
  return material;
}
`;

/** Translucent "tube" with cylindrical shading across the line width (utility corridors). */
const TUBE_SRC = `
uniform vec4 color;
uniform vec4 params;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  float x = (materialInput.st.t - 0.5) * 2.0;
  float shade = sqrt(max(0.0, 1.0 - x * x));
  float wall = smoothstep(0.62, 0.92, abs(x)) * (1.0 - smoothstep(0.92, 1.0, abs(x)));
  float spec = pow(max(0.0, 1.0 - abs(x + 0.35) * 2.6), 6.0);
  vec3 rgb = color.rgb * (0.28 + 0.5 * shade) + color.rgb * wall * 0.9 + vec3(spec) * 0.25 * params.x;
  float a = color.a * (0.32 + 0.55 * wall + 0.12 * shade);
  if (a < 0.004) discard;
  vec4 c = czm_gammaCorrect(vec4(rgb, a));
  material.emission = c.rgb;
  material.alpha = c.a;
  return material;
}
`;

/** Expanding shockwave ring on a flat ellipse. params: x progress 0..1, y thickness, z inner fill */
const RING_SRC = `
uniform vec4 color;
uniform vec4 params;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  float r = length(materialInput.st - 0.5) * 2.0;
  float p = params.x;
  float k = (r - p) / max(params.y, 0.002);
  float ring = exp(-k * k);
  float inner = step(r, p) * smoothstep(0.0, p + 1e-3, r) * params.z;
  float fade = 1.0 - smoothstep(0.3, 1.0, p);
  float a = (ring + inner) * fade * color.a * step(r, 1.0);
  if (a < 0.004) discard;
  material.diffuse = vec3(0.0);
  material.emission = color.rgb * (1.0 + ring * 0.35);
  material.alpha = clamp(a, 0.0, 1.0);
  return material;
}
`;

/** Strata / reference grid plane. params: x line count, y cell alpha, z line alpha, w edge fade */
const GRID_SRC =
  DERIV +
  `
uniform vec4 color;
uniform vec4 params;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  vec2 g = st * params.x;
#ifdef DT_HAS_DERIV
  vec2 w = max(fwidth(g), vec2(1e-4));
  vec2 gl = abs(fract(g - 0.5) - 0.5) / w;
  float line = 1.0 - min(min(gl.x, gl.y), 1.0);
  vec2 g5 = st * params.x / 5.0;
  vec2 w5 = max(fwidth(g5), vec2(1e-4));
  vec2 gl5 = abs(fract(g5 - 0.5) - 0.5) / (w5 * 1.6);
  float major = 1.0 - min(min(gl5.x, gl5.y), 1.0);
#else
  vec2 f = abs(fract(g - 0.5) - 0.5);
  float line = 1.0 - smoothstep(0.0, 0.04, min(f.x, f.y));
  float major = 0.0;
#endif
  float rr = length(st - 0.5) * 2.0;
  float fade = 1.0 - smoothstep(1.0 - params.w * 2.0, 1.0, rr);
  float a = (params.y + max(line * params.z, major * params.z * 1.6)) * fade * color.a;
  if (a < 0.003) discard;
  material.diffuse = vec3(0.0);
  material.emission = color.rgb * (1.0 + major * 0.5);
  material.alpha = clamp(a, 0.0, 1.0);
  return material;
}
`;

/** Soft radial glow on a flat disc (outage areas, service zones). params: x pulse 0..1, y inner hole */
const GLOW_SRC = `
uniform vec4 color;
uniform vec4 params;

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  float r = length(materialInput.st - 0.5) * 2.0;
  float body = (1.0 - smoothstep(0.2, 1.0, r));
  float rim = (1.0 - smoothstep(0.0, 0.05, abs(r - 0.95))) * 0.22;
  float a = (body * 0.5 + rim) * color.a * (0.8 + 0.2 * params.x) * step(r, 1.0);
  if (a < 0.003) discard;
  material.diffuse = vec3(0.0);
  material.emission = color.rgb;
  material.alpha = a;
  return material;
}
`;

export type DtMaterialKind = "line" | "tube" | "ring" | "grid" | "glow";

const SOURCES: Record<DtMaterialKind, string> = {
  line: LINE_SRC,
  tube: TUBE_SRC,
  ring: RING_SRC,
  grid: GRID_SRC,
  glow: GLOW_SRC,
};

export function createMaterial(
  C: CesiumModule,
  kind: DtMaterialKind,
  color: Cesium.Color,
  params: [number, number, number, number] = [0, 0, 0, 0],
): Cesium.Material {
  const uniforms: Record<string, unknown> = {
    color: C.Color.clone(color),
    params: new C.Cartesian4(...params),
  };
  if (kind === "line") {
    uniforms.time = 0;
    uniforms.shape = new C.Cartesian4(13, 0.52, 0, 0);
  }
  return new C.Material({
    fabric: { type: `Dt_${kind}`, uniforms, source: SOURCES[kind] },
    translucent: true,
  });
}

/** Dash period (px) and duty cycle of a line material. */
export function setDash(m: Cesium.Material, period: number, duty: number) {
  const p = m.uniforms.shape as Cesium.Cartesian4 | undefined;
  if (!p) return;
  p.x = period;
  p.y = duty;
}

/** Mutate a material's params uniform in place (no allocation). */
export function setParams(m: Cesium.Material, x: number, y: number, z: number, w: number) {
  const p = m.uniforms.params as Cesium.Cartesian4;
  p.x = x;
  p.y = y;
  p.z = z;
  p.w = w;
}
