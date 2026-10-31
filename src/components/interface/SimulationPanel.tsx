"use client";
import {
  Building2,
  ChevronDown,
  ChevronUp,
  Construction,
  Droplets,
  FlaskConical,
  GitCompareArrows,
  Play,
  RotateCcw,
  Server,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { connectionLabel, SCENARIO_TYPE_LABELS, SYSTEM_STYLES } from "@/lib/systems";
import type { ScenarioPreset, ScenarioType, SimulationResult } from "@/types/infrastructure";
import { closePanel, focusAny, openPanel, restoreWorld, runPreset } from "./actions";
import { CascadeTimeline, PlaybackControls, ResultDetails, ResultOverview, severityColor } from "./SimulationResults";
import { Button, cx, IconButton, SectionLabel, Slider, Spinner, Switch, SystemDot, Tooltip } from "./ui";
import { useUI } from "./uiStore";

const TYPE_TABS: { type: ScenarioType; label: string; Icon: LucideIcon; color: string }[] = [
  { type: "power_failure", label: "Power failure", Icon: Zap, color: SYSTEM_STYLES.power.color },
  { type: "water_rupture", label: "Water pipeline rupture", Icon: Droplets, color: SYSTEM_STYLES.water.color },
  { type: "telecom_outage", label: "Internet exchange outage", Icon: Server, color: SYSTEM_STYLES.telecom.color },
  { type: "road_disruption", label: "Road network disruption", Icon: Construction, color: SYSTEM_STYLES.transport.color },
  { type: "corridor_strike", label: "Utility corridor strike", Icon: Building2, color: SYSTEM_STYLES.underground.color },
];

const sameTargets = (a: { failed_nodes: string[]; failed_edges: string[] }, b: { failed_nodes: string[]; failed_edges: string[] }) =>
  [...a.failed_nodes].sort().join() === [...b.failed_nodes].sort().join() &&
  [...a.failed_edges].sort().join() === [...b.failed_edges].sort().join();

/** Which slot (if any) holds exactly this result. */
function useSlotOf(r: SimulationResult | null) {
  const slots = useStore((s) => s.slots);
  if (!r) return null;
  if (slots.A === r) return "A";
  if (slots.B === r) return "B";
  return null;
}

function SlotChips() {
  const slots = useStore((s) => s.slots);
  const result = useStore((s) => s.result);
  const showSlot = useStore((s) => s.showSlot);
  const runComparison = useStore((s) => s.runComparison);
  const compareStatus = useStore((s) => s.compareStatus);
  return (
    <div className="flex min-w-0 items-center gap-1">
      {(["A", "B"] as const).map((k) => {
        const r = slots[k];
        const shown = r && result === r;
        return (
          <Tooltip
            key={k}
            label={r ? `Scenario ${k}: ${r.scenario.name ?? r.scenario_id} — click to show` : `Slot ${k} empty — use “Run as ${k}”`}
          >
            <button
              type="button"
              disabled={!r}
              onClick={() => showSlot(k)}
              aria-pressed={!!shown}
              className={cx(
                "flex h-6 max-w-[150px] min-w-0 items-center gap-1.5 rounded-md border px-1.5 text-[11px] transition-colors",
                !r && "border-dashed border-white/10 text-ink-500",
                r && !shown && "border-white/12 text-ink-200 hover:border-white/25",
                shown && "border-ink-100/50 bg-white/[0.08] text-ink-50",
              )}
            >
              <span
                className="dt-num flex size-4 items-center justify-center rounded-[4px] text-[9.5px] font-semibold"
                style={{ background: k === "A" ? "#f59e0b33" : "#38bdf833", color: k === "A" ? "#fcd34d" : "#7dd3fc" }}
              >
                {k}
              </span>
              <span className="truncate">{r ? (r.scenario.name ?? "Custom") : "empty"}</span>
            </button>
          </Tooltip>
        );
      })}
      {slots.A && slots.B && (
        <Button
          size="xs"
          variant="outline"
          icon={<GitCompareArrows className="size-3" />}
          loading={compareStatus === "running"}
          onClick={async () => {
            const c = await runComparison();
            if (c) openPanel("comparison");
          }}
        >
          Compare
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build tab
// ---------------------------------------------------------------------------

function PresetCard({ p }: { p: ScenarioPreset }) {
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);
  const simStatus = useStore((s) => s.simStatus);
  const index = useStore((s) => s.index);
  const loaded = sameTargets(draft, p.scenario);
  const targets = [...p.scenario.failed_nodes, ...p.scenario.failed_edges];
  const busy = simStatus === "running";
  return (
    <div
      className={cx(
        "flex flex-col rounded-lg border p-2.5 transition-colors",
        loaded ? "border-ink-100/35 bg-white/[0.05]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/15",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-ink-50">{p.name}</div>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-300">{p.description}</p>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {targets.slice(0, 3).map((id) => {
          const n = index?.nodes.get(id);
          const e = index?.edges.get(id);
          return (
            <span key={id} className="inline-flex max-w-[150px] items-center gap-1 rounded bg-white/[0.04] px-1.5 py-[1px] text-[10px] text-ink-200">
              {n && <SystemDot system={n.system} size={5} />}
              {e && <SystemDot system={e.infrastructure_type} size={5} />}
              <span className="truncate">{n?.name ?? (e ? e.name || connectionLabel(e.connection_type) : id)}</span>
            </span>
          );
        })}
        {targets.length > 3 && <span className="text-[10px] text-ink-400">+{targets.length - 3}</span>}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <Button size="xs" variant={loaded ? "subtle" : "ghost"} onClick={() => setDraft({ ...p.scenario })} disabled={loaded}>
          {loaded ? "Loaded" : "Load"}
        </Button>
        <span className="flex-1" />
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void runPreset(p.id, "A")} aria-label={`Run ${p.name} as scenario A`}>
          A
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void runPreset(p.id, "B")} aria-label={`Run ${p.name} as scenario B`}>
          B
        </Button>
        <Button size="xs" variant="primary" icon={<Play className="size-3" />} disabled={busy} onClick={() => void runPreset(p.id, "active")}>
          Run
        </Button>
      </div>
    </div>
  );
}

function ScenarioLibrary({ tab, setTab }: { tab: ScenarioType; setTab: (t: ScenarioType) => void }) {
  const presets = useStore((s) => s.presets);
  const dataMode = useStore((s) => s.dataMode);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of presets) m[p.scenario_type] = (m[p.scenario_type] ?? 0) + 1;
    return m;
  }, [presets]);
  const tabs = counts.custom ? [...TYPE_TABS, { type: "custom" as const, label: "Custom", Icon: FlaskConical, color: "#94a3b8" }] : TYPE_TABS;
  const list = presets.filter((p) => p.scenario_type === tab);
  return (
    <div className="flex min-h-0 flex-col">
      <div role="tablist" aria-label="Scenario type" className="dt-scroll -mx-0.5 flex shrink-0 gap-1 overflow-x-auto px-0.5 pb-2">
        {tabs.map(({ type, label, Icon, color }) => {
          const active = tab === type;
          return (
            <button
              key={type}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setTab(type)}
              className={cx(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors",
                active ? "border-white/20 bg-white/[0.08] text-ink-50" : "border-transparent text-ink-300 hover:bg-white/[0.04] hover:text-ink-100",
              )}
            >
              <Icon className="size-3.5" style={{ color: active ? color : undefined }} />
              {label}
              <span className="dt-num text-[10px] text-ink-400">{counts[type] ?? 0}</span>
            </button>
          );
        })}
      </div>
      <div className="dt-scroll min-h-0 flex-1 overflow-y-auto">
        {list.length ? (
          <div className="grid grid-cols-1 gap-1.5 @xl:grid-cols-2">
            {list.map((p) => (
              <PresetCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11.5px] text-ink-400">
            {presets.length
              ? `No ${SCENARIO_TYPE_LABELS[tab]?.toLowerCase() ?? "preset"} scenarios in this network.`
              : dataMode === "snapshot"
                ? "No precomputed scenarios in the offline snapshot. Start the engine to load presets."
                : "No scenario presets available."}
          </p>
        )}
      </div>
    </div>
  );
}

function DraftBuilder() {
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);
  const toggleDraftNode = useStore((s) => s.toggleDraftNode);
  const toggleDraftEdge = useStore((s) => s.toggleDraftEdge);
  const clearDraft = useStore((s) => s.clearDraft);
  const runSimulation = useStore((s) => s.runSimulation);
  const simStatus = useStore((s) => s.simStatus);
  const index = useStore((s) => s.index);
  const dataMode = useStore((s) => s.dataMode);
  const setSimTab = useUI((s) => s.setSimTab);
  const targets = [
    ...draft.failed_nodes.map((id) => ({ id, kind: "node" as const })),
    ...draft.failed_edges.map((id) => ({ id, kind: "edge" as const })),
  ];
  const empty = targets.length === 0;
  const busy = simStatus === "running";
  const run = (slot: "active" | "A" | "B") => {
    setSimTab("results");
    void runSimulation(undefined, slot);
  };
  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
      <SectionLabel
        right={
          !empty && (
            <button type="button" onClick={clearDraft} className="flex items-center gap-1 text-[10.5px] text-ink-300 hover:text-ink-50">
              <Trash2 className="size-3" /> Clear
            </button>
          )
        }
      >
        Draft scenario
      </SectionLabel>
      <div className="mt-0.5 truncate text-[12px] text-ink-100">
        {draft.name ?? (empty ? "Untitled" : "Custom scenario")}
        <span className="ml-1.5 text-[10.5px] text-ink-400">{SCENARIO_TYPE_LABELS[draft.scenario_type]}</span>
      </div>
      <div className="dt-scroll mt-1.5 max-h-[76px] min-h-[30px] overflow-y-auto">
        {empty ? (
          <p className="text-[11px] leading-snug text-ink-400">
            Add failure targets with <span className="text-ink-200">Add to scenario</span> in the inspector, or load a preset.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {targets.map(({ id, kind }) => {
              const n = kind === "node" ? index?.nodes.get(id) : null;
              const e = kind === "edge" ? index?.edges.get(id) : null;
              const sys = n?.system ?? e?.infrastructure_type;
              return (
                <span key={id} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-white/12 bg-white/[0.04] pr-0.5 pl-1.5 text-[11px] text-ink-100">
                  {sys && <SystemDot system={sys} size={6} />}
                  <button type="button" onClick={() => focusAny(id)} className="max-w-[150px] truncate hover:text-ink-50">
                    {n?.name ?? (e ? e.name || connectionLabel(e.connection_type) : id)}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${id} from scenario`}
                    onClick={() => (kind === "node" ? toggleDraftNode(id) : toggleDraftEdge(id))}
                    className="flex size-4 items-center justify-center rounded text-ink-400 hover:bg-white/10 hover:text-ink-50"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[11.5px] text-ink-200">Horizon</span>
          <span className="dt-num text-[11.5px] text-ink-50">{draft.horizon_hours} h</span>
        </div>
        <Slider
          value={draft.horizon_hours}
          min={0}
          max={72}
          step={1}
          onChange={(v) => setDraft({ horizon_hours: v })}
          label="Assessment horizon in hours"
          marks={[4, 24, 48]}
          format={(v) => `${v} hours`}
        />
        <p className="text-[10.5px] text-ink-400">Impacts assessed {draft.horizon_hours} h after onset — backups may run out.</p>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11.5px] text-ink-200">Automatic restoration</span>
        <Switch
          checked={draft.enable_restoration}
          onChange={(v) => setDraft({ enable_restoration: v })}
          label="Automatic restoration (switching and rerouting)"
          size="sm"
          color="#4ade80"
        />
      </div>
      {dataMode === "snapshot" && (
        <p className="mt-1.5 text-[10px] leading-snug text-ink-400">
          Offline snapshot: presets and single-component failures (4 h, restoration on) are precomputed.
        </p>
      )}
      <div className="mt-2.5 flex items-center gap-1">
        <Button size="sm" variant="primary" className="flex-1" icon={<Play className="size-3.5" />} disabled={empty} loading={busy} onClick={() => run("active")}>
          Run
        </Button>
        <Button size="sm" variant="outline" disabled={empty || busy} onClick={() => run("A")}>
          Run as A
        </Button>
        <Button size="sm" variant="outline" disabled={empty || busy} onClick={() => run("B")}>
          Run as B
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------

export function SimulationPanel({ narrow }: { narrow?: boolean }) {
  const open = useStore((s) => s.panels.simulation);
  const result = useStore((s) => s.result);
  const simStatus = useStore((s) => s.simStatus);
  const presets = useStore((s) => s.presets);
  const draft = useStore((s) => s.draft);
  const playback = useStore((s) => s.playback);
  const tab = useUI((s) => s.simTab);
  const setTab = useUI((s) => s.setSimTab);
  const scenarioTab = useScenarioTab();
  const slot = useSlotOf(result);
  const effectiveTab = result ? tab : "build";

  if (!open) {
    return (
      <motion.div
        key="sim-collapsed"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.18 }}
        className="dt-panel pointer-events-auto flex h-11 max-w-full items-center gap-2 pr-1.5 pl-3"
      >
        <FlaskConical className="size-4 shrink-0 text-ink-300" />
        <button type="button" onClick={() => openPanel("simulation")} className="flex min-w-0 items-center gap-2 text-left">
          <span className="font-display text-[11.5px] font-semibold tracking-[0.16em] whitespace-nowrap text-ink-50">SIMULATION</span>
          {simStatus === "running" ? (
            <span className="flex items-center gap-1.5 text-[11.5px] text-ink-300">
              <Spinner /> Propagating…
            </span>
          ) : result ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="dt-num text-[13px]" style={{ color: severityColor(result.impact_metrics.severity_index) }}>
                {Math.round(result.impact_metrics.severity_index)}
              </span>
              {slot && <span className="dt-num rounded bg-white/[0.08] px-1 text-[9.5px] text-ink-100">{slot}</span>}
              <span className="max-w-[200px] truncate text-[12px] text-ink-200">{result.scenario.name ?? "Custom scenario"}</span>
              <span className="dt-num text-[10.5px] whitespace-nowrap text-ink-400">
                step {playback.step}/{playback.maxStep}
              </span>
            </span>
          ) : (
            <span className="truncate text-[12px] text-ink-300">
              {draft.failed_nodes.length + draft.failed_edges.length
                ? `${draft.failed_nodes.length + draft.failed_edges.length} target(s) in draft`
                : presets.length
                  ? `${presets.length} scenarios ready`
                  : "Build a failure scenario"}
            </span>
          )}
        </button>
        {result && <PlaybackControls compact />}
        <IconButton label="Open simulation center" shortcut="S" size="sm" onClick={() => openPanel("simulation")}>
          <ChevronUp className="size-4" />
        </IconButton>
      </motion.div>
    );
  }

  return (
    <motion.section
      key="sim-open"
      aria-label="Simulation center"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className={cx(
        "dt-panel pointer-events-auto relative @container/dock flex w-full flex-col overflow-hidden",
        narrow ? "h-[62vh]" : "h-[min(360px,46vh)] min-h-[260px]",
      )}
    >
      {simStatus === "running" && (
        <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden">
          <div className="animate-scan h-full w-1/3 bg-[linear-gradient(90deg,transparent,#e2e8f0,transparent)]" />
        </div>
      )}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.07] pr-1.5 pl-3.5">
        <FlaskConical className="size-4 shrink-0 text-ink-300" />
        <h2 className="font-display text-[12.5px] font-semibold tracking-[0.12em] whitespace-nowrap text-ink-50 uppercase">
          Simulation<span className="hidden @4xl/dock:inline"> center</span>
        </h2>
        <div role="tablist" aria-label="Simulation view" className="ml-1 flex shrink-0 items-center rounded-md bg-white/[0.04] p-0.5">
          {(["build", "results"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={effectiveTab === t}
              disabled={t === "results" && !result}
              onClick={() => setTab(t)}
              className={cx(
                "h-6 rounded-[5px] px-2.5 text-[11.5px] transition-colors disabled:opacity-40",
                effectiveTab === t ? "bg-white/[0.1] text-ink-50" : "text-ink-300 hover:text-ink-100",
              )}
            >
              {t === "build" ? "Scenarios" : "Results"}
            </button>
          ))}
        </div>
        {simStatus === "running" && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-300">
            <Spinner /> <span className="hidden @3xl/dock:inline">Propagating cascade…</span>
          </span>
        )}
        <span className="min-w-0 flex-1" />
        <div className="hidden min-w-0 @xl/dock:block">
          <SlotChips />
        </div>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-white/[0.08]" />
        <Tooltip label="Restore world: clear results, slots, selection and layers">
          <Button size="xs" variant="ghost" icon={<RotateCcw className="size-3" />} onClick={restoreWorld} aria-label="Restore world">
            <span className="hidden @4xl/dock:inline">Restore</span>
          </Button>
        </Tooltip>
        <IconButton label="Collapse simulation center" shortcut="S" size="sm" onClick={() => closePanel("simulation")}>
          <ChevronDown className="size-4" />
        </IconButton>
      </div>

      <div className="@container min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {effectiveTab === "build" || !result ? (
            <motion.div
              key="build"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="dt-scroll grid h-full grid-cols-1 gap-3 overflow-y-auto p-3 @3xl:grid-cols-[1fr_300px] @3xl:overflow-hidden"
            >
              <div className="flex min-h-0 flex-col">
                <ScenarioLibrary tab={scenarioTab.tab} setTab={scenarioTab.setTab} />
              </div>
              <div className="flex min-h-0 flex-col">
                <DraftBuilder />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={`results-${result.scenario_id}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="dt-scroll grid h-full grid-cols-1 overflow-y-auto @xl:grid-cols-[240px_1fr] @xl:overflow-hidden @4xl:grid-cols-[250px_1fr_270px]"
            >
              <div className="dt-scroll min-h-0 border-white/[0.06] p-3 @xl:overflow-y-auto @xl:border-r">
                <ResultOverview result={result} />
              </div>
              <div className="dt-scroll min-h-0 p-3 @xl:overflow-y-auto">
                <CascadeTimeline result={result} />
                <div className="mt-3 @4xl:hidden">
                  <ResultDetails result={result} />
                </div>
              </div>
              <div className="dt-scroll hidden min-h-0 overflow-y-auto border-l border-white/[0.06] p-3 @4xl:block">
                <ResultDetails result={result} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

/** Scenario tab follows the draft's scenario type when a preset is loaded elsewhere. */
function useScenarioTab() {
  const draftType = useStore((s) => s.draft.scenario_type);
  const presets = useStore((s) => s.presets);
  const tab = useUI((s) => s.scenarioTab);
  const setScenarioTab = useUI((s) => s.setScenarioTab);
  const fallback: ScenarioType =
    draftType !== "custom" ? draftType : (presets[0]?.scenario_type ?? "power_failure");
  return { tab: tab ?? fallback, setTab: setScenarioTab };
}
