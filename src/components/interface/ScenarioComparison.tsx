"use client";
import { ArrowDown, ArrowUp, ChevronDown, GitCompareArrows, Minus, X } from "lucide-react";
import { useState } from "react";
import { useStore, type NetworkIndex } from "@/lib/store";
import { fmtNum } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { SCENARIO_TYPE_LABELS, connectionLabel } from "@/lib/systems";
import type { ComparisonMetric, ScenarioInput, SimulationResult } from "@/types/infrastructure";
import { closePanel, focusAny, focusNode, openPanel } from "./actions";
import { severityColor } from "./SimulationResults";
import { Button, cx, IconButton, SectionLabel, SystemDot, useFocusFallback } from "./ui";

const sortedKey = (ids: string[]) => [...ids].sort().join("|");

/** Same failure targets and settings (what the engine result depends on). */
function sameScenario(a: ScenarioInput, b: ScenarioInput) {
  return (
    sortedKey(a.failed_nodes) === sortedKey(b.failed_nodes) &&
    sortedKey(a.failed_edges) === sortedKey(b.failed_edges) &&
    a.horizon_hours === b.horizon_hours &&
    a.enable_restoration === b.enable_restoration &&
    a.max_cascade_rounds === b.max_cascade_rounds
  );
}

export const DIFF_COLORS = { a: "#f59e0b", b: "#38bdf8", both: "#f43f5e" } as const;

function ScenarioHeader({ slot, r, index }: { slot: "A" | "B"; r: SimulationResult; index: NetworkIndex | null }) {
  const color = slot === "A" ? DIFF_COLORS.a : DIFF_COLORS.b;
  const targets = [...r.failed_nodes, ...r.failed_edges];
  return (
    <div className="min-w-0 rounded-lg border bg-white/[0.02] p-2.5" style={{ borderColor: `${color}40` }}>
      <div className="flex items-start gap-1.5">
        <span
          className="dt-num flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold"
          style={{ background: `${color}2a`, color }}
        >
          {slot}
        </span>
        <span className="line-clamp-2 text-[12.5px] leading-tight font-medium text-ink-50">
          {r.scenario.name ?? "Custom scenario"}
        </span>
      </div>
      <div className="mt-1 text-[10.5px] text-ink-400">{SCENARIO_TYPE_LABELS[r.scenario.scenario_type]}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {targets.slice(0, 3).map((id) => {
          const n = index?.nodes.get(id);
          const e = index?.edges.get(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => focusAny(id)}
              className="inline-flex max-w-full items-center gap-1 rounded bg-white/[0.05] px-1.5 py-[1px] text-[10px] text-ink-200 hover:bg-white/10"
            >
              {n && <SystemDot system={n.system} size={5} />}
              <span className="truncate">{n?.name ?? (e ? e.name || connectionLabel(e.connection_type) : id)}</span>
            </button>
          );
        })}
        {targets.length > 3 && <span className="text-[10px] text-ink-400">+{targets.length - 3}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className="dt-num text-[20px] leading-none"
          style={{ color: severityColor(r.impact_metrics.severity_index) }}
        >
          {Math.round(r.impact_metrics.severity_index)}
        </span>
        <span className="text-[10px] text-ink-400">severity · {r.impact_metrics.total_nodes_affected} affected</span>
      </div>
    </div>
  );
}

function MetricRow({ m }: { m: ComparisonMetric }) {
  const cell = (side: "a" | "b") => {
    const worse = m.worse === side;
    return (
      <td className="py-[5px] pl-2 text-right">
        <span
          className={cx("dt-num rounded px-1 py-[1px] text-[12px]", worse ? "text-ink-50" : "text-ink-200")}
          style={
            worse
              ? {
                  background: `${side === "a" ? DIFF_COLORS.a : DIFF_COLORS.b}22`,
                  boxShadow: `inset 0 0 0 1px ${side === "a" ? DIFF_COLORS.a : DIFF_COLORS.b}55`,
                }
              : undefined
          }
        >
          {fmtNum(m[side])}
        </span>
      </td>
    );
  };
  const up = m.delta > 0;
  const zero = Math.abs(m.delta) < 1e-9;
  // B relative to A: is B's change bad?
  const bad = !zero && (m.higher_is_worse ? up : !up);
  return (
    <tr className="border-b border-white/[0.04] last:border-0">
      <td className="py-[5px] pr-2 text-[11.5px] text-ink-200">
        {m.label}
        {m.unit && <span className="ml-1 text-[10px] text-ink-400">{m.unit}</span>}
      </td>
      {cell("a")}
      {cell("b")}
      <td className="py-[5px] pl-2 text-right">
        <span
          className={cx(
            "dt-num inline-flex items-center justify-end gap-0.5 text-[11px]",
            zero ? "text-ink-400" : bad ? "text-[#fda4af]" : "text-[#86efac]",
          )}
        >
          {zero ? <Minus className="size-3" /> : up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
          {zero ? "0" : fmtNum(Math.abs(m.delta))}
        </span>
      </td>
    </tr>
  );
}

function OverlapList({
  label,
  color,
  ids,
  index,
}: {
  label: string;
  color: string;
  ids: string[];
  index: NetworkIndex | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={!ids.length}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
      >
        <span className="size-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
        <span className="flex-1 text-[12px] text-ink-100">{label}</span>
        <span className="dt-num text-[13px] text-ink-50">{ids.length}</span>
        {ids.length > 0 && (
          <ChevronDown className={cx("size-3.5 text-ink-400 transition-transform", !open && "-rotate-90")} />
        )}
      </button>
      {open && (
        <ul className="dt-scroll max-h-[180px] overflow-y-auto border-t border-white/[0.05] px-1 py-1">
          {ids.map((id) => {
            const n = index?.nodes.get(id);
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => focusNode(id)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-[4px] text-left hover:bg-white/[0.05]"
                >
                  {n && <SystemDot system={n.system} size={6} />}
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-100">{n?.name ?? id}</span>
                  <span className="font-mono text-[9.5px] text-ink-500">{id}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 260;
  return (
    <div className="mt-1.5">
      <div
        className="text-[12px] leading-relaxed text-ink-300"
        style={
          !open && long
            ? { display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }
            : undefined
        }
      >
        {renderMarkdown(text)}
      </div>
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

export function ScenarioComparison() {
  const comparison = useStore((s) => s.comparison);
  const slots = useStore((s) => s.slots);
  const compareView = useStore((s) => s.compareView);
  const setCompareView = useStore((s) => s.setCompareView);
  const runComparison = useStore((s) => s.runComparison);
  const compareStatus = useStore((s) => s.compareStatus);
  const index = useStore((s) => s.index);
  // "Compare A vs B" (the empty state) and the stale banner's "Re-run" go away when their comparison
  // lands: keep keyboard focus on the map view the comparison shows (or Close)
  const rootRef = useFocusFallback<HTMLDivElement>(
    (root) =>
      root.querySelector<HTMLElement>('[aria-label="Map view"] [aria-checked="true"]') ??
      root.querySelector<HTMLElement>('[aria-label="Close comparison"]'),
  );

  // A slot is stale when it now holds a different scenario than the one compared: different
  // failure targets, horizon or restoration (scenario ids alone can be reused by presets).
  const stale =
    !!comparison &&
    ((!!slots.A &&
      slots.A !== comparison.scenario_a &&
      !sameScenario(slots.A.scenario, comparison.scenario_a.scenario)) ||
      (!!slots.B &&
        slots.B !== comparison.scenario_b &&
        !sameScenario(slots.B.scenario, comparison.scenario_b.scenario)));

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.07] pr-1.5 pl-3.5">
        <GitCompareArrows className="size-4 text-ink-300" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[12.5px] font-semibold tracking-[0.12em] text-ink-50 uppercase">
            Compare scenarios
          </h2>
          <div className="truncate text-[10.5px] leading-tight text-ink-300">A vs B · same network, same engine</div>
        </div>
        <IconButton label="Close comparison" shortcut="C" size="sm" onClick={() => closePanel("comparison")}>
          <X className="size-4" />
        </IconButton>
      </div>

      {!comparison ? (
        <div className="dt-scroll flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2">
            {(["A", "B"] as const).map((k) => {
              const r = slots[k];
              const color = k === "A" ? DIFF_COLORS.a : DIFF_COLORS.b;
              return r ? (
                <ScenarioHeader key={k} slot={k} r={r} index={index} />
              ) : (
                <div
                  key={k}
                  className="flex flex-col items-center justify-center rounded-lg border border-dashed border-white/12 p-3 text-center"
                  style={{ minHeight: 112 }}
                >
                  <span
                    className="dt-num flex size-6 items-center justify-center rounded-md text-[11px] font-semibold"
                    style={{ background: `${color}22`, color }}
                  >
                    {k}
                  </span>
                  <span className="mt-1.5 text-[11.5px] text-ink-300">Slot {k} empty</span>
                </div>
              );
            })}
          </div>
          <div className="mt-4 space-y-2 text-[12.5px] leading-relaxed text-ink-200">
            <p className="font-medium text-ink-50">How to compare two failures</p>
            <ol className="list-decimal space-y-1 pl-5 text-ink-300 marker:font-mono marker:text-[10.5px] marker:text-ink-500">
              <li>
                Open the <span className="text-ink-100">Simulation center</span> (S) and pick a scenario.
              </li>
              <li>
                Press <span className="text-ink-100">A</span> on one preset (or “Run as A” for your draft).
              </li>
              <li>
                Press <span className="text-ink-100">B</span> on a second one.
              </li>
              <li>Run the comparison — the map shows what each failure takes out and where they overlap.</li>
            </ol>
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => openPanel("simulation")}>
              Open simulation center
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<GitCompareArrows className="size-3.5" />}
              disabled={!slots.A || !slots.B}
              loading={compareStatus === "running"}
              onClick={() => void runComparison()}
            >
              Compare A vs B
            </Button>
          </div>
        </div>
      ) : (
        <div className="dt-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2 px-3.5 pt-3">
            <ScenarioHeader slot="A" r={comparison.scenario_a} index={index} />
            <ScenarioHeader slot="B" r={comparison.scenario_b} index={index} />
          </div>
          {stale && (
            <div className="mx-3.5 mt-2 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11.5px] text-ink-300">
              <span className="flex-1">Slots changed since this comparison.</span>
              <Button
                size="xs"
                variant="outline"
                loading={compareStatus === "running"}
                onClick={() => void runComparison()}
              >
                Re-run
              </Button>
            </div>
          )}

          <div className="px-3.5 pt-3">
            <SectionLabel className="mb-1.5">Show on map</SectionLabel>
            <div
              role="radiogroup"
              aria-label="Map view"
              className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.04] p-0.5"
            >
              {(
                [
                  ["A", "Show A"],
                  ["B", "Show B"],
                  ["diff", "Diff"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={compareView === v}
                  onClick={() => setCompareView(v)}
                  className={cx(
                    "h-7 rounded-md text-[11.5px] transition-colors",
                    compareView === v
                      ? "bg-white/[0.12] text-ink-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
                      : "text-ink-300 hover:text-ink-100",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {compareView === "diff" && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-ink-300">
                {[
                  ["Only A", DIFF_COLORS.a],
                  ["Only B", DIFF_COLORS.b],
                  ["Both", DIFF_COLORS.both],
                ].map(([l, c]) => (
                  <span key={l} className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: c }} />
                    {l}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="mx-3.5 mt-3 rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2.5">
            <div className="dt-label">Verdict</div>
            <p className="mt-1 text-[13px] leading-snug font-medium text-ink-50">{comparison.verdict}</p>
            {comparison.summary && comparison.summary !== comparison.verdict && <Summary text={comparison.summary} />}
          </div>

          <div className="px-3.5 pt-3">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.07]">
                  <th className="pb-1 text-left font-mono text-[9.5px] font-normal tracking-[0.12em] text-ink-400 uppercase">
                    Metric
                  </th>
                  <th
                    className="pb-1 text-right font-mono text-[9.5px] font-normal tracking-[0.12em] uppercase"
                    style={{ color: DIFF_COLORS.a }}
                  >
                    A
                  </th>
                  <th
                    className="pb-1 text-right font-mono text-[9.5px] font-normal tracking-[0.12em] uppercase"
                    style={{ color: DIFF_COLORS.b }}
                  >
                    B
                  </th>
                  <th className="pb-1 text-right font-mono text-[9.5px] font-normal tracking-[0.12em] text-ink-400 uppercase">
                    Δ B−A
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparison.metrics.map((m) => (
                  <MetricRow key={m.key} m={m} />
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[10px] text-ink-400">
              Outlined value = worse side. Modelled outcomes, illustrative only.
            </p>
          </div>

          <div className="space-y-1.5 px-3.5 pt-3 pb-4">
            <SectionLabel className="mb-1">Affected components overlap</SectionLabel>
            <OverlapList label="Only in A" color={DIFF_COLORS.a} ids={comparison.only_in_a} index={index} />
            <OverlapList label="Only in B" color={DIFF_COLORS.b} ids={comparison.only_in_b} index={index} />
            <OverlapList label="In both" color={DIFF_COLORS.both} ids={comparison.in_both} index={index} />
          </div>
        </div>
      )}
    </div>
  );
}
