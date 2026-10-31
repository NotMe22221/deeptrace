/**
 * Colour helpers for the world renderer. All hues come from src/lib/systems.ts; this file only adds
 * the few world-specific accents (highlight tones, comparison diff) and conversion utilities.
 */
import type * as Cesium from "cesium";
import { EDGE_STATE_STYLES, NODE_STATE_STYLES, SYSTEM_STYLES } from "@/lib/systems";
import type { EdgeState, NodeState, SystemType } from "@/types/infrastructure";

export type RGB = [number, number, number];

export const hexToRgb = (hex: string): RGB => {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

export const rgbToHex = (c: RGB) =>
  "#" +
  c
    .map((x) =>
      Math.round(Math.max(0, Math.min(1, x)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

/** Highlight tones used by the AI analyst / search. */
export const TONE_HEX = {
  info: "#38bdf8",
  warning: "#fb923c",
  critical: "#f43f5e",
  success: "#4ade80",
} as const;

/** Scenario comparison diff palette. */
export const DIFF_HEX = { a: "#f59e0b", b: "#38bdf8", both: "#f43f5e" } as const;

export const WHITE: RGB = [1, 1, 1];
export const NEUTRAL_DIM: RGB = hexToRgb("#64748b");

export const systemRgb = (s: SystemType): RGB => SYSTEM_STYLES[s]?.rgb ?? [0.6, 0.7, 0.8];
export const nodeStateRgb = (s: NodeState): RGB => NODE_STATE_STYLES[s]?.rgb ?? [0.6, 0.7, 0.8];
export const edgeStateRgb = (s: EdgeState): RGB => EDGE_STATE_STYLES[s]?.rgb ?? [0.6, 0.7, 0.8];

export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Write an RGB + alpha into an existing Cesium Color (no allocation). */
export function setColor(target: Cesium.Color, c: RGB, a: number): Cesium.Color {
  target.red = c[0];
  target.green = c[1];
  target.blue = c[2];
  target.alpha = a;
  return target;
}

export const sameRgb = (a: RGB, b: RGB) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
