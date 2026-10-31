"use client";
import {
  BookOpenCheck,
  Bot,
  Clapperboard,
  FlaskConical,
  GitCompareArrows,
  Keyboard,
  Layers,
  Menu,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useStore, type PanelKey } from "@/lib/store";
import { useViewport } from "@/hooks/useViewport";
import { openPanel, restoreWorld, startDemo, togglePanel } from "./actions";
import { DeepModeToggle } from "./DeepModeToggle";
import { BrandMark } from "./BrandMark";
import { cx, IconButton, Kbd, Tooltip } from "./ui";
import { useUI } from "./uiStore";

/** "claude-opus-5-5" -> "Claude Opus 5.5" */
export function prettyModel(model: string | null | undefined): string {
  if (!model) return "Claude";
  const parts = model.split(/[-_]/).filter((p) => !/^\d{8}$/.test(p));
  if (parts[0]?.toLowerCase() !== "claude") return model;
  const words: string[] = [];
  const nums: string[] = [];
  for (const p of parts) (/^\d+$/.test(p) ? nums : words).push(p);
  return `${words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")}${nums.length ? ` ${nums.join(".")}` : ""}`;
}

type Tone = "ok" | "warn" | "idle" | "error" | "busy";
const TONE_COLOR: Record<Tone, string> = {
  ok: "#4ade80",
  warn: "#e9c46a",
  idle: "#6b7791",
  error: "#f43f5e",
  busy: "#7dd3fc",
};

function StatusChip({
  label,
  value,
  tone,
  detail,
  showLabel,
}: {
  label: string;
  value: string;
  tone: Tone;
  detail: string;
  showLabel: boolean;
  short?: string;
}) {
  const c = TONE_COLOR[tone];
  return (
    <Tooltip label={detail}>
      <span
        tabIndex={0}
        aria-label={`${label}: ${value}. ${detail}`}
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.025] px-2"
      >
        <span
          className={cx("size-1.5 rounded-full", tone === "busy" && "animate-pulse-soft")}
          style={{ background: c, boxShadow: `0 0 6px ${c}` }}
        />
        {showLabel && (
          <span className="font-mono text-[9.5px] tracking-[0.14em] whitespace-nowrap text-ink-400">{label}</span>
        )}
        <span className="max-w-[150px] truncate font-mono text-[10.5px] tracking-[0.02em] whitespace-nowrap text-ink-100">
          {value}
        </span>
      </span>
    </Tooltip>
  );
}

function useStatus() {
  const dataMode = useStore((s) => s.dataMode);
  const health = useStore((s) => s.health);
  const snapshot = useStore((s) => s.snapshot);
  const ws = useStore((s) => s.worldStatus);

  const engine: { value: string; short: string; tone: Tone; detail: string } =
    dataMode === "live"
      ? {
          value: `Live · v${health?.version ?? "?"}`,
          short: "Live",
          tone: "ok",
          detail: `Connected to the DEEPTRACE simulation engine (v${health?.version ?? "?"}). Any scenario can be simulated.`,
        }
      : dataMode === "snapshot"
        ? {
            value: "Offline snapshot",
            short: "Snapshot",
            tone: "warn",
            detail: snapshot
              ? `Engine offline — using precomputed results exported by engine v${snapshot.engine_version}. Only preset and single-component scenarios are available.`
              : "Engine offline and no precomputed results — exploring the network only. Start the backend to simulate.",
          }
        : dataMode === "loading"
          ? { value: "Connecting", short: "Connecting", tone: "busy", detail: "Connecting to the simulation engine…" }
          : {
              value: "Error",
              short: "Error",
              tone: "error",
              detail: "No engine and no offline snapshot could be loaded.",
            };

  const city: { value: string; short: string; tone: Tone; detail: string } =
    ws.buildings === "ion-osm"
      ? {
          value: "OSM Buildings",
          short: "3D city",
          tone: "ok",
          detail: "3D buildings: Cesium OSM Buildings (© OpenStreetMap contributors).",
        }
      : ws.buildings === "unavailable"
        ? {
            value: ws.ionToken ? "Buildings unavailable" : "No buildings",
            short: "No 3D",
            tone: "idle",
            detail: ws.ionToken
              ? `3D buildings could not be loaded${ws.message ? `: ${ws.message}` : "."}`
              : "3D buildings unavailable — no Cesium ion token configured (NEXT_PUBLIC_CESIUM_ION_TOKEN). The network still renders on the globe.",
          }
        : { value: "Loading city", short: "City…", tone: "busy", detail: "Loading the 3D city…" };

  const ai: { value: string; short: string; tone: Tone; detail: string } =
    dataMode !== "live"
      ? {
          value: "Analyst offline",
          short: "AI off",
          tone: "idle",
          detail: "The AI analyst needs the live engine so it can call simulation tools.",
        }
      : health?.llm_available
        ? {
            value: prettyModel(health.llm_model),
            short: "Claude",
            tone: "ok",
            detail: `AI analyst powered by ${prettyModel(health.llm_model)} with DEEPTRACE tool access.`,
          }
        : {
            value: "Offline analyst",
            short: "AI no-LLM",
            tone: "warn",
            detail: "No LLM key configured — the analyst answers deterministically from engine tools (no LLM).",
          };
  return { engine, city, ai };
}

const ACTIONS: { key: PanelKey; label: string; shortcut: string; Icon: typeof FlaskConical }[] = [
  { key: "simulation", label: "Simulation center", shortcut: "S", Icon: FlaskConical },
  { key: "analyst", label: "AI analyst", shortcut: "A", Icon: Bot },
  { key: "comparison", label: "Compare scenarios", shortcut: "C", Icon: GitCompareArrows },
  { key: "provenance", label: "Data provenance", shortcut: "P", Icon: BookOpenCheck },
];

export function MainToolbar() {
  const { width, narrow, wide } = useViewport();
  const network = useStore((s) => s.network);
  const panels = useStore((s) => s.panels);
  const demoActive = useStore((s) => s.demo.active);
  const demoScript = useStore((s) => s.demoScript);
  const slots = useStore((s) => s.slots);
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen);
  const status = useStatus();
  const [menuOpen, setMenuOpen] = useState(false);
  const showLabels = width >= 1700;
  const showChipLabels = width >= 1820;
  const showRegion = width >= 1360;
  const shortChips = width < 1440;

  const region = network?.region;

  if (narrow) {
    return (
      <header className="pointer-events-auto absolute top-2 right-2 left-2 z-30 flex items-center gap-2">
        <div className="dt-panel flex h-11 min-w-0 flex-1 items-center gap-2 px-3">
          <BrandMark size={18} />
          <span className="font-display text-[13px] font-semibold tracking-[0.3em] text-ink-50">DEEPTRACE</span>
          <span
            className="ml-auto size-1.5 shrink-0 rounded-full"
            style={{ background: TONE_COLOR[status.engine.tone] }}
            aria-label={`Engine ${status.engine.value}`}
          />
        </div>
        <div className="dt-panel flex h-11 items-center gap-1 px-1.5">
          <IconButton label="Search" onClick={() => openPanel("search")}>
            <Search className="size-4" />
          </IconButton>
          <DeepModeToggle compact />
          <IconButton
            label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((v) => !v)}
            pressed={menuOpen}
            data-menu-toggle=""
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </IconButton>
        </div>
        <AnimatePresence>
          {menuOpen && <NarrowMenu onClose={() => setMenuOpen(false)} status={status} demoDisabled={!demoScript} />}
        </AnimatePresence>
      </header>
    );
  }

  return (
    <header className="pointer-events-none absolute top-3 right-3 left-3 z-30 flex items-start justify-between gap-3">
      {/* Identity + status */}
      <div className="dt-panel pointer-events-auto flex h-12 min-w-0 items-center gap-3 pr-2 pl-3">
        <div className="flex items-center gap-2.5">
          <BrandMark size={22} />
          <div className="leading-none">
            <div className="font-display text-[14.5px] font-semibold tracking-[0.32em] text-ink-50">DEEPTRACE</div>
            {wide && (
              <div className="mt-[3px] text-[9.5px] tracking-[0.04em] whitespace-nowrap text-ink-300">
                See the systems that make our world work
              </div>
            )}
          </div>
        </div>
        {showRegion && region && (
          <>
            <span className="h-6 w-px bg-white/[0.08]" />
            <div className="min-w-[96px] shrink leading-tight">
              <div className="truncate text-[12.5px] font-medium text-ink-50">{region.name}</div>
              <div className="dt-num truncate text-[9.5px] tracking-[0.08em] text-ink-400 uppercase">
                {network.nodes.length} nodes · {network.edges.length} links
              </div>
            </div>
          </>
        )}
        <span className="h-6 w-px bg-white/[0.08]" />
        <div className="flex items-center gap-1.5">
          <StatusChip
            label="ENGINE"
            {...status.engine}
            value={shortChips ? status.engine.short : status.engine.value}
            showLabel={showChipLabels}
          />
          <StatusChip
            label="3D CITY"
            {...status.city}
            value={shortChips ? status.city.short : status.city.value}
            showLabel={showChipLabels}
          />
          <StatusChip
            label="AI"
            {...status.ai}
            value={shortChips ? status.ai.short : status.ai.value}
            showLabel={showChipLabels}
          />
        </div>
      </div>

      {/* Actions */}
      <nav aria-label="Primary" className="dt-panel pointer-events-auto flex h-12 shrink-0 items-center gap-1 px-2">
        <Tooltip label="Search components and commands" shortcut="⌘K">
          <button
            type="button"
            onClick={() => openPanel("search")}
            aria-label="Search components and commands"
            className={cx(
              "flex h-8 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] pr-1.5 pl-2.5 text-ink-300 transition-colors hover:border-white/20 hover:text-ink-100",
              width >= 1360 ? "w-[188px]" : "w-auto",
            )}
          >
            <Search className="size-3.5" />
            {width >= 1360 && <span className="flex-1 text-left text-[12px]">Search…</span>}
            <Kbd>⌘K</Kbd>
          </button>
        </Tooltip>
        <span className="mx-1 h-6 w-px bg-white/[0.08]" />
        <DeepModeToggle />
        <span className="mx-1 h-6 w-px bg-white/[0.08]" />
        {ACTIONS.map(({ key, label, shortcut, Icon }) => {
          const badge =
            key === "comparison" && (slots.A || slots.B) ? `${slots.A ? "A" : ""}${slots.B ? "B" : ""}` : null;
          return showLabels ? (
            <Tooltip key={key} label={label} shortcut={shortcut}>
              <button
                type="button"
                aria-pressed={panels[key]}
                onClick={() => togglePanel(key)}
                className={cx(
                  "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] transition-colors",
                  panels[key] ? "bg-white/[0.1] text-ink-50" : "text-ink-200 hover:bg-white/[0.06] hover:text-ink-50",
                )}
              >
                <Icon className="size-3.5" />
                {label
                  .replace(" center", "")
                  .replace("Compare scenarios", "Compare")
                  .replace("Data provenance", "Provenance")}
                {badge && <span className="dt-num text-[9.5px] text-ink-300">{badge}</span>}
              </button>
            </Tooltip>
          ) : (
            <span key={key} className="relative">
              <IconButton label={label} shortcut={shortcut} pressed={panels[key]} onClick={() => togglePanel(key)}>
                <Icon className="size-4" />
              </IconButton>
              {badge && (
                <span className="dt-num pointer-events-none absolute -top-0.5 -right-0.5 rounded-[3px] bg-ink-600 px-[3px] text-[8.5px] leading-[12px] text-ink-100">
                  {badge}
                </span>
              )}
            </span>
          );
        })}
        <span className="mx-1 h-6 w-px bg-white/[0.08]" />
        <Tooltip
          label={
            demoScript
              ? demoActive
                ? "Guided demo is running"
                : "Start the guided 10-step walkthrough"
              : "Demo script not available"
          }
        >
          <button
            type="button"
            disabled={!demoScript}
            aria-pressed={demoActive}
            onClick={startDemo}
            className={cx(
              "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-40",
              demoActive
                ? "border-sky-300/40 bg-sky-300/[0.12] text-sky-100"
                : "border-white/[0.1] text-ink-100 hover:border-white/25 hover:bg-white/[0.06]",
            )}
          >
            <Clapperboard className="size-3.5" />
            Demo
          </button>
        </Tooltip>
        <IconButton label="Restore world (clear simulations, selection and layers)" onClick={restoreWorld}>
          <RotateCcw className="size-4" />
        </IconButton>
        <IconButton label="Keyboard shortcuts" shortcut="?" onClick={() => setShortcutsOpen(true)}>
          <Keyboard className="size-4" />
        </IconButton>
      </nav>
    </header>
  );
}

function NarrowMenu({
  onClose,
  status,
  demoDisabled,
}: {
  onClose: () => void;
  status: ReturnType<typeof useStatus>;
  demoDisabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panels = useStore((s) => s.panels);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("[data-menu-toggle]")) return;
      if (ref.current && !ref.current.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const item = (
    label: string,
    Icon: typeof FlaskConical,
    onClick: () => void,
    active?: boolean,
    disabled?: boolean,
  ) => (
    <button
      key={label}
      type="button"
      disabled={disabled}
      onClick={() => {
        onClick();
        onClose();
      }}
      className={cx(
        "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] disabled:opacity-40",
        active ? "bg-white/[0.08] text-ink-50" : "text-ink-100 hover:bg-white/[0.05]",
      )}
    >
      <Icon className="size-4 text-ink-300" />
      {label}
    </button>
  );
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.15 }}
      className="dt-panel-strong absolute top-[52px] right-0 w-[260px] p-1.5"
      role="menu"
    >
      {item("Layers", Layers, () => togglePanel("layers"), panels.layers)}
      {ACTIONS.map((a) => item(a.label, a.Icon, () => togglePanel(a.key), panels[a.key]))}
      {item("Start demo", Clapperboard, startDemo, false, demoDisabled)}
      {item("Restore world", RotateCcw, restoreWorld)}
      <div className="mt-1.5 space-y-1 border-t border-white/[0.07] px-3 pt-2 pb-1">
        {[
          ["Engine", status.engine],
          ["3D city", status.city],
          ["AI", status.ai],
        ].map(([k, v]) => {
          const s = v as { value: string; tone: Tone };
          return (
            <div key={k as string} className="flex items-center justify-between text-[11px]">
              <span className="dt-label">{k as string}</span>
              <span className="flex items-center gap-1.5 text-ink-100">
                <span className="size-1.5 rounded-full" style={{ background: TONE_COLOR[s.tone] }} />
                {s.value}
              </span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
