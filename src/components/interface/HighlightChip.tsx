"use client";
import { useRef } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cx } from "./ui";
import { useStore } from "@/lib/store";
import { leaveDiff } from "./actions";

const TONE: Record<string, string> = {
  info: "#7dd3fc",
  warning: "#fb923c",
  critical: "#f43f5e",
  success: "#4ade80",
};

const SOURCE: Record<string, string> = { ai: "AI analyst", search: "search", user: "you", demo: "demo" };

/** Shows the active map highlight (from the analyst, a path, a metric…) with a one-click clear. */
export function HighlightChip() {
  const highlight = useStore((s) => s.highlight);
  const setHighlight = useStore((s) => s.setHighlight);
  // The A/B diff view does not draw highlights (e.g. one set by the analyst while comparing).
  const hiddenByDiff = useStore((s) => s.compareView === "diff" && !!s.comparison);
  // "show" is offered only when leaving the diff keeps the highlight (on the result under the diff or a
  // slot of a scenario its answer compared); otherwise it describes no result left to show it on
  const showable = useStore((s) => s.compareView === "diff" && !!s.comparison && s.highlightShowTarget() !== null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The "show" button was pressed with a pointer (mouse / touch / pen), not a key or a screen reader. */
  const pointerPress = useRef(false);
  const color = highlight ? (TONE[highlight.tone] ?? TONE.info) : TONE.info;
  const count = highlight ? highlight.node_ids.length + highlight.edge_ids.length : 0;
  return (
    <AnimatePresence>
      {highlight && (
        <motion.div
          key="highlight-chip"
          ref={rootRef}
          role="status"
          // made focusable only while it is the keyboard focus target after "show" (see below)
          onBlur={(e) => {
            // A window / tab switch also fires blur, but the chip stays document.activeElement and
            // gets focus back on return: only a real focus move ends its focusability.
            if (e.target === e.currentTarget && document.activeElement !== e.currentTarget) {
              e.currentTarget.removeAttribute("tabindex");
            }
          }}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className="dt-panel pointer-events-auto flex h-8 max-w-full items-center gap-2 pr-1 pl-3"
          style={{ borderColor: `${color}55`, borderRadius: 999 }}
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
          <span className={cx("min-w-0 truncate text-[12px] text-ink-100", hiddenByDiff && "opacity-70")}>
            <span className="text-ink-400">Highlight: </span>
            {highlight.label ?? "custom"}
          </span>
          {hiddenByDiff && (
            <button
              type="button"
              onPointerDown={() => {
                pointerPress.current = true;
              }}
              onKeyDown={() => {
                pointerPress.current = false; // a pointer press abandoned earlier does not count
              }}
              // (unavailable rather than removed when there is nothing to show it on: it keeps keyboard
              // focus if that happens while it has it, as Button's `busy` does)
              aria-disabled={!showable || undefined}
              onClick={(e) => {
                if (!useStore.getState().highlightShowTarget()) return; // read at the event, not the render
                // This button unmounts on the next render. A keyboard or screen-reader user keeps
                // focus in the chip, on the chip itself rather than the destructive Clear button, so
                // Space still plays and a repeated Enter does nothing. A pointer press lets focus
                // fall to the page as before, so no focus ring appears on later shortcut keys.
                // (Pointer tracking, not e.detail: some screen readers send clicks with detail 1.)
                const keyboard = document.activeElement === e.currentTarget && !pointerPress.current;
                pointerPress.current = false;
                leaveDiff({ showHighlight: true });
                const root = rootRef.current;
                // (the highlight stays: "show" is offered only then)
                if (keyboard && root && useStore.getState().highlight) {
                  root.tabIndex = -1;
                  root.focus();
                }
              }}
              title={
                showable
                  ? "The A/B diff view does not draw highlights. Show this highlight on the map instead."
                  : "The A/B diff view does not draw highlights, and neither slot holds a result this highlight describes."
              }
              className="shrink-0 rounded-full px-1.5 text-[10.5px] whitespace-nowrap text-sky-300 hover:bg-white/[0.08] aria-disabled:cursor-default aria-disabled:text-ink-400 aria-disabled:hover:bg-transparent"
            >
              {showable ? "hidden in A/B diff · show" : "hidden in A/B diff"}
            </button>
          )}
          <span
            className="dt-num shrink-0 text-[10.5px] text-ink-400"
            title={`Set by ${SOURCE[highlight.source] ?? highlight.source}`}
          >
            {count}
          </span>
          <button
            type="button"
            aria-label="Clear highlight"
            title="Clear highlight"
            onClick={() => setHighlight(null)}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-300 hover:bg-white/[0.08] hover:text-ink-50"
          >
            <X className="size-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
