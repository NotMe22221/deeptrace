"use client";
/**
 * Interface-only state (which right-hand drawer is in front, transient toasts, overlays).
 * Kept out of the main store because nothing in the 3D world depends on it.
 */
import { create } from "zustand";

export type RightPanel = "inspector" | "analyst" | "comparison" | "provenance";

export interface Toast {
  id: string;
  tone: "info" | "success" | "warning" | "error";
  title: string;
  body?: string;
}

interface UIState {
  /** Most-recently-focused right panel last. */
  rightOrder: RightPanel[];
  shortcutsOpen: boolean;
  toasts: Toast[];
  /** Increments each time Deep Mode is switched on (drives the descent animation). */
  deepFx: number;
  simTab: "build" | "results";
  focusRight: (p: RightPanel) => void;
  setShortcutsOpen: (v: boolean) => void;
  pushToast: (t: Omit<Toast, "id">, ttlMs?: number) => void;
  dismissToast: (id: string) => void;
  bumpDeepFx: () => void;
  setSimTab: (t: "build" | "results") => void;
}

let toastSeq = 0;

export const useUI = create<UIState>((set, get) => ({
  rightOrder: [],
  shortcutsOpen: false,
  toasts: [],
  deepFx: 0,
  simTab: "build",
  focusRight: (p) => set((s) => ({ rightOrder: [...s.rightOrder.filter((x) => x !== p), p] })),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  pushToast: (t, ttlMs = 3200) => {
    const id = `t${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    if (ttlMs > 0) setTimeout(() => get().dismissToast(id), ttlMs);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  bumpDeepFx: () => set((s) => ({ deepFx: s.deepFx + 1 })),
  setSimTab: (t) => set({ simTab: t }),
}));
