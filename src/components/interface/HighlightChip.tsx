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
  const rootRef = useRef<HTMLDivElement>(null);
  const color = highlight ? (TONE[highlight.tone] ?? TONE.info) : TONE.info;
  const count = highlight ? highlight.node_ids.length + highlight.edge_ids.length : 0;
  return (
    <AnimatePresence>
      {highlight && (
        <motion.div
          key="highlight-chip"
          ref={rootRef}
          role="status"
          // focus target after "show" (which unmounts): not the destructive Clear button, so Space
          // still plays / pauses and a repeated Enter does nothing
          tabIndex={-1}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className="dt-panel pointer-events-auto flex h-8 max-w-full items-center gap-2 pr-1 pl-3 outline-none focus-visible:ring-1 focus-visible:ring-sky-300/50"
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
              onClick={(e) => {
                const hadFocus = document.activeElement === e.currentTarget;
                leaveDiff(); // this button unmounts on the next render: keep keyboard focus in the chip
                if (hadFocus) rootRef.current?.focus();
              }}
              title="The A/B diff view does not draw highlights. Show this highlight on the map instead."
              className="shrink-0 rounded-full px-1.5 text-[10.5px] whitespace-nowrap text-sky-300 hover:bg-white/[0.08]"
            >
              hidden in A/B diff · show
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
