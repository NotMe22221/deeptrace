"use client";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { toggleDeepMode } from "./actions";
import { cx, Tooltip } from "./ui";
import { useUI } from "./uiStore";

const STRATA = ["#34d399", "#a78bfa", "#f5b83d", "#22d3ee"];

/** Four strata bars that "sink" when Deep Mode engages. */
function StrataGlyph({ active }: { active: boolean }) {
  return (
    <span aria-hidden className="relative flex h-4 w-4 flex-col justify-between py-[1px]">
      {STRATA.map((c, i) => (
        <motion.span
          key={c}
          className="block h-[2px] rounded-full"
          initial={false}
          animate={{
            width: active ? `${100 - i * 8}%` : `${100 - i * 18}%`,
            x: active ? i * 0.6 : 0,
            backgroundColor: active ? c : "#6b7791",
            opacity: active ? 1 : 0.55 + i * 0.1,
          }}
          transition={{ duration: 0.45, delay: active ? i * 0.07 : 0, ease: [0.2, 0.8, 0.2, 1] }}
        />
      ))}
    </span>
  );
}

/** The hero control: switches the world into the subsurface exploration view. */
export function DeepModeToggle({ compact }: { compact?: boolean }) {
  const deepMode = useStore((s) => s.deepMode);
  const depthScale = useStore((s) => s.depthScale);
  const deepFx = useUI((s) => s.deepFx);
  const reduce = useReducedMotion();

  return (
    <Tooltip
      label={deepMode ? "Return to the surface view" : "Reveal the infrastructure beneath the streets"}
      shortcut="D"
    >
      <button
        type="button"
        aria-pressed={deepMode}
        aria-label="Deep Mode"
        onClick={toggleDeepMode}
        className={cx(
          "group relative flex h-8 items-center gap-2 overflow-hidden rounded-lg border pr-2.5 pl-2 transition-[background,border-color,box-shadow] duration-300",
          deepMode
            ? "border-cyan-300/45 bg-[linear-gradient(180deg,rgba(34,211,238,0.16),rgba(14,21,36,0.6))] shadow-[0_0_22px_-6px_rgba(34,211,238,0.65),inset_0_1px_0_rgba(255,255,255,0.08)]"
            : "border-white/[0.12] bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.07]",
        )}
      >
        <StrataGlyph active={deepMode} />
        {!compact && (
          <span
            className={cx(
              "font-display text-[11px] font-semibold tracking-[0.22em] transition-colors",
              deepMode ? "text-cyan-50" : "text-ink-100",
            )}
          >
            DEEP MODE
          </span>
        )}
        <span
          className={cx(
            "dt-num min-w-[26px] rounded-[4px] px-1 py-[1px] text-center text-[10px] transition-colors",
            deepMode ? "bg-cyan-300/15 text-cyan-100" : "bg-white/[0.05] text-ink-300",
          )}
        >
          {deepMode ? `${depthScale}×` : "OFF"}
        </span>
        {/* sweep on activation */}
        <AnimatePresence>
          {deepMode && !reduce && (
            <motion.span
              key={deepFx}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-10 bg-[linear-gradient(90deg,transparent,rgba(165,243,252,0.45),transparent)]"
              initial={{ left: "-30%" }}
              animate={{ left: "120%" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.85, ease: "easeOut" }}
            />
          )}
        </AnimatePresence>
      </button>
    </Tooltip>
  );
}

/**
 * Full-screen "descent" cue played once when Deep Mode engages: a luminous scan line
 * sinks through the frame while depth strata fade in. Purely decorative, pointer-transparent.
 */
export function DeepModeDescent() {
  const deepFx = useUI((s) => s.deepFx);
  const depthScale = useStore((s) => s.depthScale);
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    if (!deepFx || reduce) return;
    // Schedule (rather than set synchronously) so the effect only subscribes to the counter.
    const start = window.setTimeout(() => setActive(deepFx), 0);
    const stop = window.setTimeout(() => setActive(null), 1500);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(stop);
    };
  }, [deepFx, reduce]);

  return (
    <AnimatePresence>
      {active !== null && (
        <motion.div
          key={active}
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[5] overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
        >
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_60%,rgba(34,211,238,0.07),transparent_60%)]" />
          {[0.3, 0.46, 0.62, 0.78].map((y, i) => (
            <motion.div
              key={y}
              className="absolute right-[18%] left-[18%] h-px"
              style={{
                top: `${y * 100}%`,
                background: `linear-gradient(90deg, transparent, ${STRATA[i]}55, transparent)`,
              }}
              initial={{ scaleX: 0, opacity: 0 }}
              animate={{ scaleX: 1, opacity: [0, 1, 0] }}
              transition={{ duration: 1.2, delay: 0.15 + i * 0.12, ease: "easeOut" }}
            />
          ))}
          <motion.div
            className="absolute right-0 left-0 h-[2px] bg-[linear-gradient(90deg,transparent,rgba(165,243,252,0.85),transparent)] shadow-[0_0_24px_4px_rgba(34,211,238,0.35)]"
            initial={{ top: "12%", opacity: 0 }}
            animate={{ top: "88%", opacity: [0, 1, 1, 0] }}
            transition={{ duration: 1.25, ease: [0.4, 0, 0.2, 1] }}
          />
          <motion.div
            className="absolute top-[54%] left-1/2 -translate-x-1/2 text-center"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: [0, 1, 0], y: 0 }}
            transition={{ duration: 1.4, ease: "easeOut" }}
          >
            <div className="font-display text-[11px] font-semibold tracking-[0.5em] text-cyan-100/90">
              DESCENDING BELOW GRADE
            </div>
            <div className="dt-num mt-1 text-[10px] tracking-[0.2em] text-cyan-200/60">
              DEPTH EXAGGERATION {depthScale}×
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
