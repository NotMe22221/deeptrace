/**
 * Local tangent frame for the district. The network covers a few kilometres, so a flat
 * east/north/up approximation around the region centre is accurate to centimetres for the
 * planar maths (resampling, distances, arcs). Absolute positions are always produced with
 * proper WGS84 conversions (Cartesian3.fromDegrees) so everything stays geographically exact.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "./cesiumLoader";

export class LocalFrame {
  readonly lon: number;
  readonly lat: number;
  /** ellipsoidal height of the frame origin (ground at the region centre) */
  height: number;
  readonly origin: Cesium.Cartesian3;
  readonly east: Cesium.Cartesian3;
  readonly north: Cesium.Cartesian3;
  readonly up: Cesium.Cartesian3;
  readonly mPerDegLon: number;
  readonly mPerDegLat: number;
  private readonly C: CesiumModule;

  constructor(C: CesiumModule, lon: number, lat: number, height = 0) {
    this.C = C;
    this.lon = lon;
    this.lat = lat;
    this.height = height;
    this.origin = C.Cartesian3.fromDegrees(lon, lat, height);
    const enu = C.Transforms.eastNorthUpToFixedFrame(this.origin);
    this.east = new C.Cartesian3(enu[0], enu[1], enu[2]);
    this.north = new C.Cartesian3(enu[4], enu[5], enu[6]);
    this.up = new C.Cartesian3(enu[8], enu[9], enu[10]);
    const latR = (lat * Math.PI) / 180;
    // WGS84 metres per degree at this latitude
    this.mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latR) + 1.175 * Math.cos(4 * latR);
    this.mPerDegLon = 111412.84 * Math.cos(latR) - 93.5 * Math.cos(3 * latR);
  }

  /** planar metres east/north of the origin */
  toLocal(lon: number, lat: number): [number, number] {
    return [(lon - this.lon) * this.mPerDegLon, (lat - this.lat) * this.mPerDegLat];
  }

  toLonLat(x: number, y: number): [number, number] {
    return [this.lon + x / this.mPerDegLon, this.lat + y / this.mPerDegLat];
  }

  /** Re-anchor the origin height (after terrain sampling). */
  withHeight(height: number): LocalFrame {
    return new LocalFrame(this.C, this.lon, this.lat, height);
  }
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
