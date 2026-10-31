"use client";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "@/lib/store";

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
  const color = highlight ? (TONE[highlight.tone] ?? TONE.info) : TONE.info;
  const count = highlight ? highlight.node_ids.length + highlight.edge_ids.length : 0;
  return (
    <AnimatePresence>
      {highlight && (
        <motion.div
          key="highlight-chip"
          role="status"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className="dt-panel pointer-events-auto flex h-8 max-w-full items-center gap-2 pr-1 pl-3"
          style={{ borderColor: `${color}55`, borderRadius: 999 }}
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
          <span className="min-w-0 truncate text-[12px] text-ink-100">
            <span className="text-ink-400">Highlight: </span>
            {highlight.label ?? "custom"}
          </span>
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
