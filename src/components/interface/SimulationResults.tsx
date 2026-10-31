"use client";
import { AlertTriangle, ChevronDown, Pause, Play, RotateCcw, Route, SkipBack, SkipForward } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useStore } from "@/lib/store";
import { fmtCompact, fmtMeters, fmtNum, fmtPct, fmtSeconds } from "@/lib/format";
import { LAYER_ORDER, NODE_STATE_STYLES, SYSTEM_STYLES, typeLabel } from "@/lib/systems";
import { world } from "@/engine/worldBridge";
import type { AlternativePath, SimulationResult, SystemType } from "@/types/infrastructure";
import { focusNode } from "./actions";
import { affectedStyle } from "./stateStyle";
import { Chip, cx, IconButton, SectionLabel, Slider, SystemDot, Tooltip } from "./ui";

export const severityColor = (v: number) =>
  v >= 75 ? "#f43f5e" : v >= 50 ? "#fb923c" : v >= 25 ? "#facc15" : "#4ade80";
export const severityWord = (v: number) => (v >= 75 ? "Severe" : v >= 50 ? "Major" : v >= 25 ? "Moderate" : "Minor");

/** Semi-circular 0-100 gauge. */
export function SeverityGauge({ value, size = 128 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const r = 46;
  const c = Math.PI * r;
  const color = severityColor(v);
  return (
    <div
      className="relative"
      style={{ width: size, height: size * 0.62 }}
      role="img"
      aria-label={`Severity index ${Math.round(v)} of 100`}
    >
      <svg viewBox="0 0 110 64" className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id="sev-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#4ade80" />
            <stop offset="40%" stopColor="#facc15" />
            <stop offset="70%" stopColor="#fb923c" />
            <stop offset="100%" stopColor="#f43f5e" />
          </linearGradient>
        </defs>
        <path
          d="M9 57 A46 46 0 0 1 101 57"
          fill="none"
          stroke="rgba(255,255,255,0.07)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M9 57 A46 46 0 0 1 101 57"
          fill="none"
          stroke="url(#sev-grad)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          style={{ transition: "stroke-dasharray 700ms cubic-bezier(.2,.8,.2,1)" }}
        />
        {[25, 50, 75].map((t) => {
          const a = Math.PI * (1 - t / 100);
          return (
            <line
              key={t}
              x1={55 + Math.cos(a) * 39}
              y1={57 - Math.sin(a) * 39}
              x2={55 + Math.cos(a) * 36}
              y2={57 - Math.sin(a) * 36}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth="1"
            />
          );
        })}
      </svg>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center leading-none">
        <span className="dt-num text-[26px] font-medium" style={{ color }}>
          {Math.round(v)}
        </span>
        <span className="mt-1 font-mono text-[8.5px] tracking-[0.18em] text-ink-400 uppercase">index /100</span>
      </div>
    </div>
  );
}

/** Paragraph clamped to a few lines with a "more" toggle (engine summaries can be long). */
function ExpandableText({ text, lines = 4 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 48;
  return (
    <div>
      <p
        className="text-[12.5px] leading-snug text-ink-100"
        style={
          !open && long
            ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }
            : undefined
        }
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-0.5 text-[11px] text-sky-200/80 hover:text-sky-100"
        >
          {open ? "Show less" : "Show full summary"}
        </button>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
      <div className="flex items-baseline gap-1">
        <span className="dt-num text-[15px] leading-none text-ink-50" style={tone ? { color: tone } : undefined}>
          {value}
        </span>
        {unit && <span className="text-[10px] text-ink-300">{unit}</span>}
      </div>
      <div className="mt-1 flex items-start gap-1 text-[10px] leading-tight text-ink-300">
        <span className="line-clamp-2">{label}</span>
        {hint && (
          <span className="shrink-0 font-mono text-[8.5px] tracking-[0.08em] text-ink-500 uppercase">{hint}</span>
        )}
      </div>
    </div>
  );
}

export function ResultOverview({ result }: { result: SimulationResult }) {
  const m = result.impact_metrics;
  const setHighlight = useStore((s) => s.setHighlight);
  const index = useStore((s) => s.index);
  const critCount = m.critical_facilities_affected.length;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <SeverityGauge value={m.severity_index} size={104} />
        <dl className="min-w-0 flex-1 space-y-1.5">
          <div>
            <dt className="font-mono text-[9px] tracking-[0.12em] text-ink-400 uppercase">Severity</dt>
            <dd className="text-[12px] font-medium" style={{ color: severityColor(m.severity_index) }}>
              {severityWord(m.severity_index)}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[9px] tracking-[0.12em] text-ink-400 uppercase">Affected</dt>
            <dd className="dt-num text-[12px] text-ink-100">{m.total_nodes_affected} components</dd>
          </div>
          <div>
            <dt className="font-mono text-[9px] tracking-[0.12em] text-ink-400 uppercase">Redundancy</dt>
            <dd className="dt-num text-[12px] text-ink-100">{fmtPct(m.redundancy_score)}</dd>
          </div>
        </dl>
      </div>
      <ExpandableText text={result.summary} />
      <div className="grid grid-cols-2 gap-1.5">
        <Metric
          label="Power unserved"
          value={fmtNum(m.power_load_unserved_mw)}
          unit="MW"
          tone={m.power_load_unserved_mw ? SYSTEM_STYLES.power.color : undefined}
        />
        <Metric
          label="Water unserved"
          value={fmtNum(m.water_demand_unserved_lps)}
          unit="L/s"
          tone={m.water_demand_unserved_lps ? SYSTEM_STYLES.water.color : undefined}
        />
        <Metric
          label="Telecom endpoints disconnected"
          value={fmtNum(m.telecom_nodes_disconnected, 0)}
          tone={m.telecom_nodes_disconnected ? SYSTEM_STYLES.telecom.color : undefined}
        />
        <Metric
          label="Travel time"
          value={`+${fmtNum(m.transport_travel_time_increase_pct, 0)}`}
          unit="%"
          tone={m.transport_travel_time_increase_pct ? SYSTEM_STYLES.transport.color : undefined}
        />
        <Metric label="Stations closed" value={fmtNum(m.transit_stations_closed, 0)} />
        <Tooltip
          label={critCount ? "Highlight affected critical facilities" : "No critical facilities affected"}
          className="block"
        >
          <button
            type="button"
            disabled={!critCount}
            onClick={() => {
              setHighlight({
                node_ids: m.critical_facilities_affected,
                edge_ids: [],
                label: "Critical facilities affected",
                tone: "critical",
                source: "user",
              });
              world().flyToNodes(m.critical_facilities_affected);
            }}
            className="w-full text-left disabled:cursor-default"
          >
            <Metric label="Critical facilities" value={fmtNum(critCount, 0)} tone={critCount ? "#f43f5e" : undefined} />
          </button>
        </Tooltip>
        <div className="col-span-2">
          <Metric
            label="Population affected (estimate)"
            value={fmtCompact(m.population_affected_estimate)}
            unit="people"
            hint="modelled"
          />
        </div>
      </div>
      {m.per_system.length > 0 && (
        <div>
          <SectionLabel className="mb-1.5">Service level by system</SectionLabel>
          <div className="space-y-1.5">
            {[...m.per_system]
              .sort((a, b) => LAYER_ORDER.indexOf(a.system) - LAYER_ORDER.indexOf(b.system))
              .map((p) => {
                const st = SYSTEM_STYLES[p.system];
                return (
                  <Tooltip
                    key={p.system}
                    className="block"
                    label={`${p.metric_name}: ${fmtNum(p.remaining_value)} of ${fmtNum(p.baseline_value)} ${p.unit} · ${p.nodes_affected}/${p.nodes_total} nodes affected${p.notes.length ? ` · ${p.notes.join("; ")}` : ""}`}
                  >
                    <div className="w-full">
                      <div className="flex items-baseline justify-between text-[10.5px]">
                        <span className="text-ink-200">{st?.label ?? p.system}</span>
                        <span className="dt-num text-ink-100">{fmtPct(p.percent_served)}</span>
                      </div>
                      <div className="mt-[3px] h-[4px] overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                          className="h-full rounded-full transition-[width] duration-700"
                          style={{
                            width: `${Math.max(0, Math.min(1, p.percent_served)) * 100}%`,
                            background: st?.color ?? "#94a3b8",
                          }}
                        />
                      </div>
                    </div>
                  </Tooltip>
                );
              })}
          </div>
          <p className="mt-1.5 text-[10px] text-ink-400">Share of baseline service still delivered (modelled).</p>
        </div>
      )}
      {index && critCount > 0 && (
        <div>
          <SectionLabel className="mb-1">Critical facilities affected</SectionLabel>
          <ul>
            {m.critical_facilities_affected.map((id) => {
              const n = index.nodes.get(id);
              const st = result.node_states[id];
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => focusNode(id)}
                    className="flex w-full items-center gap-2 rounded px-1 py-[3px] text-left hover:bg-white/[0.05]"
                  >
                    {n && <SystemDot system={n.system} size={6} />}
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-100">{n?.name ?? id}</span>
                    {st && (
                      <span className="text-[10px]" style={{ color: NODE_STATE_STYLES[st]?.color }}>
                        {NODE_STATE_STYLES[st]?.label}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cascade timeline
// ---------------------------------------------------------------------------

export function PlaybackControls({ compact }: { compact?: boolean }) {
  const playback = useStore((s) => s.playback);
  const setPlaying = useStore((s) => s.setPlaying);
  const setPlaybackStep = useStore((s) => s.setPlaybackStep);
  const replayCascade = useStore((s) => s.replayCascade);
  const atEnd = playback.step >= playback.maxStep;
  return (
    <div className="flex items-center gap-1">
      {!compact && (
        <IconButton label="Replay cascade" size="sm" onClick={replayCascade}>
          <RotateCcw className="size-3.5" />
        </IconButton>
      )}
      {!compact && (
        <IconButton
          label="Previous step"
          size="sm"
          disabled={playback.step <= 0}
          onClick={() => {
            setPlaying(false);
            setPlaybackStep(playback.step - 1);
          }}
        >
          <SkipBack className="size-3.5" />
        </IconButton>
      )}
      <IconButton
        label={playback.playing ? "Pause cascade" : atEnd ? "Replay cascade" : "Play cascade"}
        size="sm"
        pressed={playback.playing}
        onClick={() => (playback.playing ? setPlaying(false) : atEnd ? replayCascade() : setPlaying(true))}
      >
        {playback.playing ? (
          <Pause className="size-3.5" />
        ) : atEnd && compact ? (
          <RotateCcw className="size-3.5" />
        ) : (
          <Play className="size-3.5" />
        )}
      </IconButton>
      {!compact && (
        <IconButton
          label="Next step"
          size="sm"
          disabled={atEnd}
          onClick={() => {
            setPlaying(false);
            setPlaybackStep(playback.step + 1);
          }}
        >
          <SkipForward className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

export function CascadeTimeline({ result }: { result: SimulationResult }) {
  const playback = useStore((s) => s.playback);
  const setPlaying = useStore((s) => s.setPlaying);
  const setPlaybackStep = useStore((s) => s.setPlaybackStep);
  const index = useStore((s) => s.index);
  const steps = useMemo(() => [...result.cascade_steps].sort((a, b) => a.step - b.step), [result]);

  return (
    <div>
      <SectionLabel
        className="mb-1.5"
        right={
          <span className="dt-num text-[10px] text-ink-300">
            step {playback.step} / {playback.maxStep}
          </span>
        }
      >
        Cascade timeline
      </SectionLabel>
      <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-1.5 py-1">
        <PlaybackControls />
        <div className="min-w-0 flex-1 px-1">
          <Slider
            value={playback.step}
            min={0}
            max={Math.max(1, playback.maxStep)}
            onChange={(v) => {
              setPlaying(false);
              setPlaybackStep(v);
            }}
            label="Cascade step"
            color="#e2e8f0"
            marks={steps.map((s) => s.step)}
            format={(v) => `Step ${v}`}
          />
        </div>
      </div>
      <ol className="relative mt-2">
        {steps.map((s, i) => {
          const done = s.step < playback.step;
          const current = s.step === playback.step;
          const future = s.step > playback.step;
          const last = i === steps.length - 1;
          return (
            <li key={`${s.step}-${i}`} className="relative">
              {!last && (
                <span
                  aria-hidden
                  className={cx(
                    "absolute top-[18px] bottom-[-4px] left-[11px] w-px transition-colors duration-500",
                    done ? "bg-ink-200/60" : "bg-white/[0.08]",
                  )}
                />
              )}
              <button
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => {
                  setPlaying(false);
                  setPlaybackStep(s.step);
                }}
                className={cx(
                  "relative flex w-full gap-2.5 rounded-lg px-1 py-1.5 text-left transition-[background,opacity] duration-300",
                  current ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
                  future && "opacity-45",
                )}
              >
                <span
                  className={cx(
                    "dt-num relative z-[1] mt-[1px] flex size-[21px] shrink-0 items-center justify-center rounded-full border text-[10px] transition-colors duration-500",
                    current
                      ? "border-ink-50 bg-ink-50 text-ink-950"
                      : done
                        ? "border-ink-200/70 bg-ink-800 text-ink-100"
                        : "border-white/15 bg-ink-900 text-ink-400",
                  )}
                >
                  {s.step}
                  {current && playback.playing && (
                    <span className="absolute inset-[-4px] animate-ping rounded-full border border-white/30" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-ink-50">{s.label}</span>
                    <span className="flex shrink-0 gap-[3px]">
                      {s.systems.map((sys) => (
                        <SystemDot key={sys} system={sys} size={6} />
                      ))}
                    </span>
                    <span
                      className="dt-num ml-auto shrink-0 text-[10px] text-ink-400"
                      title={`${s.node_ids.length} components and ${s.edge_ids.length} connections change state`}
                    >
                      {s.node_ids.length ? `+${s.node_ids.length}` : ""}
                    </span>
                  </span>
                  <span
                    title={s.description}
                    className={cx(
                      "mt-0.5 text-[11.5px] leading-snug text-ink-300",
                      current ? "line-clamp-4" : "line-clamp-1",
                    )}
                  >
                    {s.description}
                  </span>
                  {current && index && s.node_ids.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {s.node_ids.slice(0, 6).map((id) => {
                        const n = index.nodes.get(id);
                        return (
                          <span
                            key={id}
                            role="link"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              focusNode(id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.stopPropagation();
                                focusNode(id);
                              }
                            }}
                            className="inline-flex max-w-[160px] cursor-pointer items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-1.5 py-[1px] text-[10.5px] text-ink-100 hover:border-white/25"
                          >
                            {n && <SystemDot system={n.system} size={5} />}
                            <span className="truncate">{n?.name ?? id}</span>
                          </span>
                        );
                      })}
                      {s.node_ids.length > 6 && (
                        <span className="text-[10.5px] text-ink-400">+{s.node_ids.length - 6}</span>
                      )}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {!steps.length && <p className="text-[12px] text-ink-400">No cascade — the failure stays contained.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details: affected components, alternative paths, assumptions
// ---------------------------------------------------------------------------

function Collapsible({
  title,
  count,
  children,
  defaultOpen = true,
  right,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-left"
      >
        <ChevronDown className={cx("size-3 text-ink-400 transition-transform", !open && "-rotate-90")} />
        <span className="dt-label">{title}</span>
        {count !== undefined && <span className="dt-num text-[10px] text-ink-300">{count}</span>}
        {right && <span className="ml-auto">{right}</span>}
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

function AffectedGroups({ result }: { result: SimulationResult }) {
  const index = useStore((s) => s.index);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const m = new Map<SystemType, SimulationResult["affected_nodes"]>();
    for (const a of result.affected_nodes) {
      const arr = m.get(a.system) ?? [];
      arr.push(a);
      m.set(a.system, arr);
    }
    // Impacted components first (by cascade step), rerouted-with-full-service last.
    for (const arr of m.values())
      arr.sort((x, y) => Number(affectedStyle(x).rerouted) - Number(affectedStyle(y).rerouted) || x.step - y.step);
    return LAYER_ORDER.filter((k) => m.has(k)).map((k) => ({ system: k, items: m.get(k)! }));
  }, [result]);
  if (!index) return null;
  return (
    <div className="space-y-2">
      {groups.map(({ system, items }) => {
        const st = SYSTEM_STYLES[system];
        const all = expanded[system];
        const shown = all ? items : items.slice(0, 5);
        const rerouted = items.filter((a) => affectedStyle(a).rerouted).length;
        return (
          <div key={system}>
            <div className="flex items-center gap-1.5 px-1">
              <SystemDot system={system} size={6} />
              <span className="text-[11px] font-medium text-ink-200">{st.label}</span>
              <span className="dt-num text-[10px] text-ink-400">
                {items.length - rerouted}
                {rerouted > 0 && <span className="text-[#86efac]/80"> · {rerouted} rerouted</span>}
              </span>
            </div>
            <ul className="mt-0.5">
              {shown.map((a) => {
                const n = index.nodes.get(a.node_id);
                const s = affectedStyle(a);
                return (
                  <li key={a.node_id}>
                    <Tooltip label={a.cause} side="left" className="block">
                      <button
                        type="button"
                        onClick={() => focusNode(a.node_id)}
                        className="flex w-full items-center gap-2 rounded px-1 py-[3px] text-left hover:bg-white/[0.05]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px] text-ink-100">{n?.name ?? a.node_id}</span>
                          <span className="block truncate text-[9.5px] text-ink-400">{n ? typeLabel(n.type) : ""}</span>
                        </span>
                        <span
                          className={cx(
                            "inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1 py-[1px] text-[9.5px]",
                            s.rerouted && "border border-dashed border-ok/30",
                          )}
                          style={{ color: s.color, background: s.rerouted ? undefined : `${s.color}1a` }}
                        >
                          <span className="size-1 rounded-full" style={{ background: s.color }} />
                          {s.rerouted ? "Rerouted" : s.label}
                        </span>
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
            {items.length > 5 && (
              <button
                type="button"
                onClick={() => setExpanded((e) => ({ ...e, [system]: !all }))}
                className="ml-1 text-[10.5px] text-sky-200/80 hover:text-sky-100"
              >
                {all ? "Show fewer" : `Show all ${items.length}`}
              </button>
            )}
          </div>
        );
      })}
      {!groups.length && <p className="px-1 text-[11.5px] text-ink-400">No components affected.</p>}
    </div>
  );
}

function AltPathRow({ p }: { p: AlternativePath }) {
  const highlight = useStore((s) => s.highlight);
  const setHighlight = useStore((s) => s.setHighlight);
  const active = highlight?.label === p.purpose && highlight.tone === "success";
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={() => {
          if (active) return setHighlight(null);
          setHighlight({
            node_ids: p.node_ids,
            edge_ids: p.edge_ids,
            label: p.purpose,
            tone: "success",
            source: "user",
          });
          if (p.node_ids.length) world().flyToNodes(p.node_ids);
        }}
        className={cx(
          "w-full rounded-lg border px-2 py-1.5 text-left transition-colors",
          active ? "border-ok/40 bg-ok/[0.08]" : "border-white/[0.06] bg-white/[0.02] hover:border-white/15",
        )}
      >
        <span className="flex items-center gap-1.5">
          <Route className={cx("size-3.5 shrink-0", active ? "text-ok" : "text-ink-300")} />
          <SystemDot system={p.system} size={6} />
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink-50">{p.purpose}</span>
          <Chip color={p.capacity_ok ? "#4ade80" : "#fb923c"}>{p.capacity_ok ? "Capacity OK" : "Constrained"}</Chip>
        </span>
        <span className="mt-1 block text-[11px] leading-snug text-ink-300">{p.description}</span>
        {(p.added_length_m || p.added_time_s) && (
          <span className="dt-num mt-1 block text-[10px] text-ink-400">
            {p.added_length_m ? `+${fmtMeters(p.added_length_m)}` : ""}
            {p.added_length_m && p.added_time_s ? " · " : ""}
            {p.added_time_s ? `+${fmtSeconds(p.added_time_s)}` : ""}
          </span>
        )}
      </button>
    </li>
  );
}

export function ResultDetails({ result }: { result: SimulationResult }) {
  const dataMode = useStore((s) => s.dataMode);
  return (
    <div className="space-y-3">
      <Collapsible
        title="Affected components"
        count={result.affected_nodes.filter((a) => !affectedStyle(a).rerouted).length}
      >
        <AffectedGroups result={result} />
      </Collapsible>
      {result.alternative_paths.length > 0 && (
        <Collapsible title="Alternative paths" count={result.alternative_paths.length}>
          <ul className="space-y-1.5">
            {result.alternative_paths.map((p) => (
              <AltPathRow key={p.id} p={p} />
            ))}
          </ul>
        </Collapsible>
      )}
      <div className="rounded-lg border border-warn/25 bg-warn/[0.06] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#fdba74]">
          <AlertTriangle className="size-3.5" />
          Illustrative model — not a validated engineering prediction
        </div>
        <Collapsible title="Assumptions" count={result.assumptions.length} defaultOpen={false}>
          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-ink-300 marker:text-ink-500">
            {result.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Collapsible>
      </div>
      <dl className="dt-num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] text-ink-400">
        <dt>Engine</dt>
        <dd className="text-ink-300">
          v{result.engine_version}
          {dataMode === "snapshot" && " · precomputed (offline snapshot)"}
        </dd>
        <dt>Compute</dt>
        <dd className="text-ink-300">{fmtNum(result.computation_ms, 0)} ms</dd>
        <dt>Scenario</dt>
        <dd className="truncate text-ink-300" title={result.scenario_id}>
          {result.scenario_id}
        </dd>
        <dt>Horizon</dt>
        <dd className="text-ink-300">
          {result.scenario.horizon_hours} h · restoration {result.scenario.enable_restoration ? "on" : "off"}
        </dd>
      </dl>
    </div>
  );
}
