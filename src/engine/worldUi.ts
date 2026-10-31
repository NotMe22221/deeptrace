"use client";
/**
 * World-local UI state shared between the Cesium controller and the small React overlays it owns
 * (tooltip position, cascade flash, deep-mode progress). Kept out of the main store so 30 Hz
 * pointer updates never re-render the interface panels.
 */
import { create } from "zustand";
import type { Stratum } from "./rendering/StrataLayer";

export interface WorldUiState {
  /** pointer position (CSS px, relative to the viewer) of the hovered object */
  pointer: { x: number; y: number } | null;
  /** increments on each initiating-failure flash */
  flash: number;
  /** eased deep-mode factor 0..1 */
  deepT: number;
  orbiting: boolean;
  noticeDismissed: boolean;
  /** strata band labels derived from the loaded network (null until built) */
  strata: Stratum[] | null;
  set: (p: Partial<Omit<WorldUiState, "set">>) => void;
}

export const useWorldUi = create<WorldUiState>((set) => ({
  pointer: null,
  flash: 0,
  deepT: 0,
  orbiting: false,
  noticeDismissed: false,
  strata: null,
  set: (p) => set(p),
}));
