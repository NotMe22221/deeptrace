"use client";
import { ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "@/lib/store";
import { Button, cx, IconButton, Spinner, Tooltip } from "./ui";

/** Guided walkthrough controller (top-centre while demo mode is active). */
export function DemoBar() {
  const demo = useStore((s) => s.demo);
  const script = useStore((s) => s.demoScript);
  const demoGoto = useStore((s) => s.demoGoto);
  const demoNext = useStore((s) => s.demoNext);
  const demoPrev = useStore((s) => s.demoPrev);
  const resetDemo = useStore((s) => s.resetDemo);
  const exitDemo = useStore((s) => s.exitDemo);
  // While a step runs (and Previous at the first step), the controls are unavailable but keep keyboard
  // focus: aria-disabled plus an ignored activation, not `disabled` (a focused button that becomes
  // disabled drops focus to <body>, so a keyboard user's next Enter does nothing). `busy` is read at the
  // event, not from the render; demoPrev itself does nothing at the first step.
  const whenIdle = (fn: () => unknown) => () => {
    if (!useStore.getState().demo.busy) void fn();
  };

  return (
    <AnimatePresence>
      {demo.active && script && (
        <motion.div
          role="region"
          aria-label="Guided demo"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
          className="dt-panel-strong pointer-events-auto w-full overflow-hidden"
        >
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
            <span className="font-mono text-[9.5px] tracking-[0.18em] text-sky-200/90">GUIDED DEMO</span>
            <span className="dt-num text-[10.5px] text-ink-300">
              {demo.step + 1} / {script.steps.length}
            </span>
            <div className="ml-1 flex flex-1 items-center gap-1" role="tablist" aria-label="Demo steps">
              {script.steps.map((s, i) => (
                <Tooltip key={s.id} label={`${i + 1}. ${s.title}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={i === demo.step}
                    aria-label={`Step ${i + 1}: ${s.title}`}
                    aria-disabled={demo.busy || undefined}
                    onClick={whenIdle(() => demoGoto(i))}
                    className="group flex h-4 items-center px-[1px] aria-disabled:cursor-wait"
                  >
                    <span
                      className={cx(
                        "block h-[3px] rounded-full transition-all duration-300",
                        i === demo.step
                          ? "w-5 bg-sky-200"
                          : i < demo.step
                            ? "w-2.5 bg-ink-200/70"
                            : "w-2.5 bg-white/15 group-hover:bg-white/30",
                      )}
                    />
                  </button>
                </Tooltip>
              ))}
            </div>
            <Tooltip label="Restart the walkthrough from step 1 (restores the world)">
              <Button size="xs" variant="ghost" icon={<RotateCcw className="size-3" />} onClick={resetDemo}>
                Reset demo
              </Button>
            </Tooltip>
            <IconButton label="Exit demo" size="xs" onClick={exitDemo}>
              <X className="size-3.5" />
            </IconButton>
          </div>
          <div className="flex items-center gap-3 px-3 py-2.5">
            <IconButton
              label="Previous step"
              shortcut="←"
              size="sm"
              aria-disabled={demo.busy || demo.step === 0 || undefined}
              onClick={whenIdle(demoPrev)}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-35"
            >
              <ChevronLeft className="size-4" />
            </IconButton>
            <div className="min-w-0 flex-1">
              {/* Keyed so each step's text eases in; no exit phase, so the text is never blank. */}
              <motion.div
                key={demo.step}
                initial={{ opacity: 0.4, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-display text-[14.5px] font-semibold text-ink-50">
                    {script.steps[demo.step]?.title}
                  </h2>
                  {demo.busy && (
                    <span className="flex items-center gap-1 text-[10.5px] text-ink-300">
                      <Spinner className="size-3" /> running
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[12.5px] leading-snug text-ink-200">{script.steps[demo.step]?.narration}</p>
              </motion.div>
            </div>
            {demo.step < script.steps.length - 1 ? (
              <Tooltip label="Next step" shortcut="→">
                <Button
                  size="sm"
                  variant="primary"
                  aria-disabled={demo.busy || undefined}
                  onClick={whenIdle(demoNext)}
                  className="min-w-[78px] aria-disabled:pointer-events-none aria-disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="size-3.5" />
                </Button>
              </Tooltip>
            ) : (
              <Tooltip label="End the walkthrough and keep exploring">
                <Button
                  size="sm"
                  variant="subtle"
                  aria-disabled={demo.busy || undefined}
                  onClick={whenIdle(exitDemo)}
                  className="min-w-[78px] aria-disabled:pointer-events-none aria-disabled:opacity-40"
                >
                  Finish
                </Button>
              </Tooltip>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
