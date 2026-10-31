"use client";
/**
 * DEEPTRACE interface shell: lays out every floating surface over the full-screen 3D world.
 *
 *   ┌──────────── toolbar (identity · status │ search · DEEP MODE · panels · demo) ────────────┐
 *   │ Infrastructure │            demo bar / toasts (top-centre)            │ Inspector │      │
 *   │   explorer     │                                                      │ Analyst   │      │
 *   │   (left)       │                  3D city (unobstructed)              │ Compare   │      │
 *   │                │                                                      │ Provenance│ cam  │
 *   │ (world legend) │ ───────────── simulation dock (bottom) ───────────── │ (tabs)    │      │
 *   └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * On phones the side panels become bottom sheets and only one sheet is open at a time.
 */
import { Bot, BookOpenCheck, Crosshair, GitCompareArrows, type LucideIcon } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { useViewport } from "@/hooks/useViewport";
import { usePlaybackDriver } from "@/hooks/usePlaybackDriver";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { AIAnalyst } from "./AIAnalyst";
import { BootOverlay } from "./BootOverlay";
import { CameraControls } from "./CameraControls";
import { CommandPalette } from "./CommandPalette";
import { ComponentInspector } from "./ComponentInspector";
import { DeepModeDescent } from "./DeepModeToggle";
import { DemoBar } from "./DemoBar";
import { LayerPanel } from "./LayerPanel";
import { MainToolbar } from "./MainToolbar";
import { ProvenancePanel } from "./ProvenancePanel";
import { ScenarioComparison } from "./ScenarioComparison";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SimulationPanel } from "./SimulationPanel";
import { Toasts } from "./Toasts";
import { cx } from "./ui";
import { useUI, type RightPanel } from "./uiStore";
import { openPanel } from "./actions";

const RIGHT: RightPanel[] = ["inspector", "analyst", "comparison", "provenance"];
const RIGHT_META: Record<RightPanel, { label: string; Icon: LucideIcon }> = {
  inspector: { label: "Inspector", Icon: Crosshair },
  analyst: { label: "Analyst", Icon: Bot },
  comparison: { label: "Compare", Icon: GitCompareArrows },
  provenance: { label: "Provenance", Icon: BookOpenCheck },
};

const GAP = 12;
const TOP = 72;
/**
 * Space kept clear at the bottom-left (under the explorer) for the world's legend / notices
 * (WorldOverlay: left 12 / bottom 12, 288 px wide, max 112 px tall — 250 px in Deep Mode or diff view).
 */
const LEFT_BOTTOM_RESERVE = 12 + 112 + 8;
const LEFT_BOTTOM_RESERVE_TALL = 12 + 250 + 8;
/** Space kept clear at the bottom-right for map credits. */
const RIGHT_BOTTOM_RESERVE = 40;

/**
 * Interface glass is a touch more opaque than the shared .dt-panel token so text stays legible
 * over the bright network (and where backdrop blur is unavailable). Scoped to the interface root.
 */
const GLASS_CSS = `.dt-ui .dt-panel{background:rgba(7,11,20,0.86)}.dt-ui .dt-panel-strong{background:rgba(7,11,20,0.94)}`;

/** Store → interface reactions that are not tied to a single component. */
function useInterfaceReactions(narrow: boolean, compact: boolean) {
  const focusRight = useUI((s) => s.focusRight);
  const bumpDeepFx = useUI((s) => s.bumpDeepFx);
  const setSimTab = useUI((s) => s.setSimTab);
  const narrowRef = useRef(narrow);
  const compactRef = useRef(compact);
  useEffect(() => {
    narrowRef.current = narrow;
    compactRef.current = compact;
  }, [narrow, compact]);

  // Phones start with the map unobstructed.
  useEffect(() => {
    if (narrow) useStore.getState().setPanel("layers", false);
  }, [narrow]);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        for (const k of RIGHT) {
          if (s.panels[k] && !prev.panels[k]) {
            if (k === "inspector" && s.analystPending) continue;
            focusRight(k);
            // Laptop widths: give the map room by folding the explorer to its rail.
            if (compactRef.current && !narrowRef.current && s.panels.layers && window.innerWidth < 1360)
              s.setPanel("layers", false);
          }
        }
        const sel = s.selectedNodeId ?? s.selectedEdgeId;
        if (sel && sel !== (prev.selectedNodeId ?? prev.selectedEdgeId) && !s.analystPending) focusRight("inspector");
        if (s.deepMode && !prev.deepMode) bumpDeepFx();
        if (s.result && s.result !== prev.result) setSimTab("results");
        if (narrowRef.current) {
          // One bottom sheet at a time on phones.
          const opened = (["layers", "simulation"] as const).find((k) => s.panels[k] && !prev.panels[k]);
          if (opened === "layers" && s.panels.simulation) s.setPanel("simulation", false);
          if (opened === "simulation" && s.panels.layers) s.setPanel("layers", false);
        }
      }),
    [focusRight, bumpDeepFx, setSimTab],
  );
}

function RightTabs({ visible, front }: { visible: RightPanel[]; front: RightPanel }) {
  const focusRight = useUI((s) => s.focusRight);
  if (visible.length < 2) return null;
  return (
    <div role="tablist" aria-label="Open panels" className="dt-panel mb-2 flex shrink-0 gap-0.5 p-1">
      {visible.map((k) => {
        const { label, Icon } = RIGHT_META[k];
        const active = k === front;
        return (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => focusRight(k)}
            className={cx(
              "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11.5px] transition-colors",
              active ? "bg-white/[0.1] text-ink-50" : "text-ink-300 hover:bg-white/[0.04] hover:text-ink-100",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function RightBody({ k }: { k: RightPanel }) {
  if (k === "inspector") return <ComponentInspector />;
  if (k === "analyst") return <AIAnalyst />;
  if (k === "comparison") return <ScenarioComparison />;
  return <ProvenancePanel />;
}

export function Interface() {
  const vp = useViewport();
  const { narrow, compact } = vp;
  const panels = useStore((s) => s.panels);
  const hasSelection = useStore((s) => !!(s.selectedNodeId || s.selectedEdgeId));
  const demoActive = useStore((s) => s.demo.active);
  const dataReady = useStore((s) => s.dataMode === "live" || s.dataMode === "snapshot");
  const rightOrder = useUI((s) => s.rightOrder);
  const deepMode = useStore((s) => s.deepMode);
  const compareView = useStore((s) => s.compareView);

  useInterfaceReactions(narrow, compact);
  usePlaybackDriver();
  useGlobalShortcuts();

  const visible = RIGHT.filter((k) => panels[k] && (k !== "inspector" || hasSelection));
  const front = [...rightOrder].reverse().find((k) => visible.includes(k)) ?? visible[visible.length - 1] ?? null;

  const leftW = vp.width >= 1440 ? 288 : 272;
  const rightW = front === "comparison" ? (vp.width >= 1440 ? 420 : 392) : vp.width >= 1440 ? 384 : 360;
  const layersOpen = panels.layers;
  const leftOffset = GAP + (layersOpen ? leftW : 44) + GAP;
  const rightOffset = front ? GAP + rightW + GAP : GAP + 40 + GAP;
  const dockH = Math.max(240, Math.min(340, vp.height * 0.4));
  const leftReserve = deepMode || compareView === "diff" ? LEFT_BOTTOM_RESERVE_TALL : LEFT_BOTTOM_RESERVE;
  const simOpen = panels.simulation;
  // The expanded dock stays clear of the world legend column when that legend carries content.
  const dockLeft = deepMode || compareView === "diff" ? Math.max(leftOffset, GAP + 288 + GAP) : leftOffset;

  if (narrow) {
    const sheet: "right" | "layers" | "sim" | null = front ? "right" : layersOpen ? "layers" : simOpen ? "sim" : null;
    return (
      <MotionConfig reducedMotion="user">
        <style>{GLASS_CSS}</style>
        <div className="dt-ui pointer-events-none fixed inset-0 z-10">
          <MainToolbar />
          <div className="absolute top-[60px] right-2 left-2 z-20 flex flex-col gap-2">
            <DemoBar />
            <Toasts />
          </div>
          <AnimatePresence>
            {sheet && sheet !== "sim" && (
              <motion.div
                key={sheet === "right" ? `r-${front}` : "layers"}
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex max-h-[72vh] flex-col px-2 pb-2"
              >
                <div className="mx-auto mb-1.5 h-1 w-10 shrink-0 rounded-full bg-white/25" aria-hidden />
                {sheet === "right" && front ? (
                  <>
                    <RightTabs visible={visible} front={front} />
                    <aside className="dt-panel-strong flex h-[64vh] min-h-0 flex-col overflow-hidden">
                      <RightBody k={front} />
                    </aside>
                  </>
                ) : (
                  <LayerPanel />
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {(!sheet || sheet === "sim") && dataReady && (
            <div className="absolute inset-x-2 bottom-2 z-20 flex justify-center">
              <AnimatePresence mode="wait">
                <SimulationPanel narrow />
              </AnimatePresence>
            </div>
          )}
          <DeepModeDescent />
        </div>
        <div className="dt-ui">
          <CommandPalette />
          <ShortcutsOverlay />
          <BootOverlay />
        </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <style>{GLASS_CSS}</style>
      <div className="dt-ui pointer-events-none fixed inset-0 z-10">
        <MainToolbar />

        {/* Left column: infrastructure explorer (or its rail) */}
        {dataReady && (
          <div
            className="absolute flex flex-col"
            style={{ left: GAP, top: TOP, bottom: leftReserve, width: layersOpen ? leftW : 44 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={layersOpen ? "panel" : "rail"}
                className="pointer-events-auto flex min-h-0 flex-col"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.16 }}
              >
                {layersOpen ? <LayerPanel /> : <LayerPanel rail onExpand={() => openPanel("layers")} />}
              </motion.div>
            </AnimatePresence>
          </div>
        )}

        {/* Right column: inspector / analyst / comparison / provenance */}
        <AnimatePresence>
          {front && (
            <motion.div
              key="right-col"
              className="absolute flex flex-col"
              style={{ right: GAP, top: TOP, bottom: RIGHT_BOTTOM_RESERVE, width: rightW }}
              initial={{ opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 18 }}
              transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <div className="pointer-events-auto">
                <RightTabs visible={visible} front={front} />
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.aside
                  key={front}
                  aria-label={RIGHT_META[front].label}
                  className="dt-panel pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                >
                  <RightBody k={front} />
                </motion.aside>
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top-centre: demo bar + notices */}
        <div
          className="absolute flex flex-col items-center gap-2"
          style={{ top: TOP, left: leftOffset, right: rightOffset }}
        >
          <div className="w-full max-w-[680px]">
            <DemoBar />
          </div>
          <div className={cx("flex w-full max-w-[680px] justify-end", demoActive && "mt-0")}>
            <Toasts />
          </div>
        </div>

        {/* Bottom: simulation dock */}
        {dataReady && (
          <div
            className="absolute flex justify-center"
            style={{ left: simOpen ? dockLeft : leftOffset, right: front ? rightOffset : GAP + 40 + GAP, bottom: GAP }}
          >
            <AnimatePresence mode="wait">
              <SimulationPanel key={simOpen ? "open" : "closed"} />
            </AnimatePresence>
          </div>
        )}

        {/* Camera cluster: bottom-right, left of the right column; lifted above the dock when they would collide */}
        {dataReady && (
          <motion.div
            className="absolute"
            initial={false}
            animate={{
              right: front ? rightOffset : GAP,
              bottom: front && simOpen ? dockH + GAP * 2 : RIGHT_BOTTOM_RESERVE,
            }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <CameraControls />
          </motion.div>
        )}

        <DeepModeDescent />
      </div>
      <div className="dt-ui">
        <CommandPalette />
        <ShortcutsOverlay />
        <BootOverlay />
      </div>
    </MotionConfig>
  );
}
