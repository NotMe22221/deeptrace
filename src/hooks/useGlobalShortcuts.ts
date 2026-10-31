"use client";
import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { isTypingTarget } from "@/lib/format";
import { world } from "@/engine/worldBridge";
import { closePanel, leaveDiff, openPanel, toggleDeepMode, togglePanel } from "@/components/interface/actions";
import { useUI, type RightPanel } from "@/components/interface/uiStore";

const RIGHT: RightPanel[] = ["inspector", "analyst", "comparison", "provenance"];

/** Esc: close the top-most surface, then selection, then highlights. */
function handleEscape() {
  const S = useStore.getState();
  const U = useUI.getState();
  if (U.shortcutsOpen) return U.setShortcutsOpen(false);
  if (S.panels.search) return closePanel("search");
  const hasSelection = !!(S.selectedNodeId || S.selectedEdgeId);
  const visible = RIGHT.filter((k) => S.panels[k] && (k !== "inspector" || hasSelection));
  if (visible.length) {
    const front = [...U.rightOrder].reverse().find((k) => visible.includes(k)) ?? visible[visible.length - 1];
    return closePanel(front);
  }
  if (S.traceVisible) return S.hideTrace();
  if (hasSelection) return closePanel("inspector");
  if (S.highlight) return S.setHighlight(null);
  if (S.panels.simulation) return closePanel("simulation");
}

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const S = useStore.getState();
      const U = useUI.getState();
      // Search works everywhere, including inside inputs.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (S.panels.search) closePanel("search");
        else openPanel("search");
        return;
      }
      if (e.key === "Escape") {
        if (isTypingTarget(e.target)) {
          // Palette handles its own Esc; elsewhere Esc leaves the field first.
          if (!S.panels.search) (e.target as HTMLElement).blur();
          return;
        }
        handleEscape();
        return;
      }
      if (e.defaultPrevented || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (S.panels.search) return;
      if (U.shortcutsOpen && e.key !== "?") return;

      const k = e.key;
      switch (k) {
        case "?":
          e.preventDefault();
          U.setShortcutsOpen(!U.shortcutsOpen);
          return;
        case "/":
          e.preventDefault();
          openPanel("search");
          return;
        case "ArrowRight":
        case "ArrowLeft": {
          // Only controls that really move with the arrow keys keep them: range sliders (depth,
          // horizon, cascade scrubber) and native radios. Text fields are excluded above by
          // isTypingTarget. Our role=tab / role=radio buttons (demo step dots, panel tabs, Show A/B/Diff)
          // have no arrow handling, so the demo keeps the arrows there. If roving arrow navigation is
          // added to those groups later, add their selectors here.
          const t = e.target as HTMLElement | null;
          const onControl =
            t && t !== document.body && t.closest("input[type=range], input[type=radio], [role=slider]");
          if (onControl || !S.demo.active || S.demo.busy) return;
          e.preventDefault();
          void (k === "ArrowRight" ? S.demoNext() : S.demoPrev());
          return;
        }
        case " ": {
          const t = e.target as HTMLElement | null;
          const onControl = t && t !== document.body && t.closest("button, a, [role=tab], [role=slider], input");
          if (!S.result || onControl) return;
          e.preventDefault();
          const atEnd = S.playback.step >= S.playback.maxStep;
          if (S.playback.playing) return S.setPlaying(false);
          // Playback only renders outside the A/B diff view.
          leaveDiff();
          if (atEnd) S.replayCascade();
          else S.setPlaying(true);
          return;
        }
      }
      if (e.repeat) return;
      switch (k.toLowerCase()) {
        case "d":
          toggleDeepMode();
          break;
        case "h":
          world().flyHome();
          break;
        case "s":
          togglePanel("simulation");
          break;
        case "a":
          togglePanel("analyst");
          break;
        case "c":
          togglePanel("comparison");
          break;
        case "p":
          togglePanel("provenance");
          break;
        case "l":
          togglePanel("layers");
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
