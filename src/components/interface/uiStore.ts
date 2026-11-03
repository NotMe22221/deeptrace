"use client";
/**
 * Interface-only state (which right-hand drawer is in front, transient toasts, overlays).
 * Kept out of the main store because nothing in the 3D world depends on it.
 */
import { create } from "zustand";
import { isTypingTarget } from "@/lib/format";
import type { ScenarioType } from "@/types/infrastructure";

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
  /** Scenario-type tab in the simulation library (null = follow the draft). */
  scenarioTab: ScenarioType | null;
  /**
   * The unsent analyst question. Kept here, not in the analyst's component state, so it survives the
   * analyst panel unmounting while another right panel is in front.
   */
  analystDraft: string;
  /** Right panels that came forward behind a field the user was typing in (a dot on their tab). */
  rightAttention: RightPanel[];
  /** A click or key: bring the panel to the front. */
  focusRight: (p: RightPanel) => void;
  /** The panel is in front (by any route, e.g. the one before it closed): its tab no longer needs a dot. */
  clearAttention: (p: RightPanel) => void;
  /**
   * Something that landed (a comparison, a demo step) brings its panel forward. While the user is typing
   * in a field of the front right panel, that panel keeps the front and its field keeps keyboard focus
   * (unmounting it would drop focus to <body> and send the next keys to the single-key shortcuts); the
   * new panel goes right behind it with a dot on its tab.
   */
  surfaceRight: (p: RightPanel) => void;
  setAnalystDraft: (v: string) => void;
  setShortcutsOpen: (v: boolean) => void;
  pushToast: (t: Omit<Toast, "id">, ttlMs?: number) => void;
  dismissToast: (id: string) => void;
  bumpDeepFx: () => void;
  setSimTab: (t: "build" | "results") => void;
  setScenarioTab: (t: ScenarioType) => void;
}

let toastSeq = 0;

export const useUI = create<UIState>((set, get) => ({
  rightOrder: [],
  shortcutsOpen: false,
  toasts: [],
  deepFx: 0,
  simTab: "build",
  scenarioTab: null,
  analystDraft: "",
  rightAttention: [],
  focusRight: (p) =>
    set((s) => ({
      rightOrder: [...s.rightOrder.filter((x) => x !== p), p],
      rightAttention: s.rightAttention.filter((x) => x !== p),
    })),
  clearAttention: (p) => {
    if (get().rightAttention.includes(p)) set((s) => ({ rightAttention: s.rightAttention.filter((x) => x !== p) }));
  },
  surfaceRight: (p) => {
    const a = typeof document === "undefined" ? null : document.activeElement;
    const typingIn = a && isTypingTarget(a) ? (a.closest("[data-right-panel]")?.getAttribute("data-right-panel") ?? null) : null;
    if (!typingIn || typingIn === p) return get().focusRight(p);
    const keep = typingIn as RightPanel;
    set((s) => ({
      rightOrder: [...s.rightOrder.filter((x) => x !== p && x !== keep), p, keep],
      rightAttention: s.rightAttention.includes(p) ? s.rightAttention : [...s.rightAttention, p],
    }));
  },
  setAnalystDraft: (v) => set({ analystDraft: v }),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  pushToast: (t, ttlMs = 3200) => {
    const id = `t${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    if (ttlMs > 0) setTimeout(() => get().dismissToast(id), ttlMs);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  bumpDeepFx: () => set((s) => ({ deepFx: s.deepFx + 1 })),
  setSimTab: (t) => set({ simTab: t }),
  setScenarioTab: (t) => set({ scenarioTab: t }),
}));
