"use client";
import { ChevronsLeft, ChevronsRight, Eye, EyeOff, Layers } from "lucide-react";
import { motion } from "framer-motion";
import { useStore } from "@/lib/store";
import { fmtNum } from "@/lib/format";
import { EDGE_STATE_STYLES, LAYER_ORDER, NODE_STATE_STYLES, PROVENANCE_STYLES, SYSTEM_STYLES } from "@/lib/systems";
import { useNetworkStats, type NetworkStats } from "@/hooks/useNetworkStats";
import { PROVENANCE_CATEGORIES } from "@/types/infrastructure";
import { SYSTEM_ICONS } from "./icons";
import { closePanel, toggleDeepMode } from "./actions";
import { cx, IconButton, PanelHeader, SectionLabel, ShareBar, Slider, Switch, Tooltip } from "./ui";

const LEGEND_STATES: { key: string; label: string; color: string; kind: "node" | "edge" }[] = [
  { key: "operational", ...NODE_STATE_STYLES.operational, kind: "node" },
  { key: "failed", ...NODE_STATE_STYLES.failed, kind: "node" },
  { key: "outage", ...NODE_STATE_STYLES.outage, kind: "node" },
  { key: "de_energized", ...NODE_STATE_STYLES.de_energized, kind: "node" },
  { key: "on_backup", ...NODE_STATE_STYLES.on_backup, kind: "node" },
  { key: "restored", ...NODE_STATE_STYLES.restored, label: "Restored", kind: "node" },
  { key: "rerouted", ...EDGE_STATE_STYLES.rerouted, label: "Rerouted", kind: "edge" },
];

/** Left column: the infrastructure explorer (layers, overlays, deep mode, legend). */
export function LayerPanel({ rail, onExpand }: { rail?: boolean; onExpand?: () => void }) {
  const stats = useNetworkStats();
  if (rail) return <LayerRail stats={stats} onExpand={onExpand} />;
  return (
    <section aria-label="Infrastructure explorer" className="dt-panel flex max-h-full min-h-0 flex-col overflow-hidden">
      <PanelHeader
        icon={<Layers className="size-4" />}
        title="Infrastructure"
        subtitle={
          stats ? (
            <span className="dt-num">
              {fmtNum(stats.totalNodes, 0)} nodes · {fmtNum(stats.totalEdges, 0)} links
            </span>
          ) : (
            "Loading network…"
          )
        }
        actions={
          <IconButton label="Collapse explorer" shortcut="L" size="sm" onClick={() => closePanel("layers")}>
            <ChevronsLeft className="size-4" />
          </IconButton>
        }
      />
      <div className="dt-scroll min-h-0 flex-1 overflow-y-auto">
        <SystemList stats={stats} />
        <Overlays stats={stats} />
        <DeepBlock stats={stats} />
        <StateLegend />
      </div>
    </section>
  );
}

function SystemList({ stats }: { stats: NetworkStats | null }) {
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const setAllLayers = useStore((s) => s.setAllLayers);
  const allOn = LAYER_ORDER.every((k) => layers[k]);
  return (
    <div className="px-3 pt-3 pb-2">
      <SectionLabel
        className="mb-1.5 px-0.5"
        right={
          <button
            type="button"
            onClick={() => setAllLayers(!allOn)}
            className="flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[9.5px] tracking-[0.12em] text-ink-300 uppercase hover:text-ink-50"
          >
            {allOn ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            {allOn ? "Hide all" : "Show all"}
          </button>
        }
      >
        Systems
      </SectionLabel>
      <ul className="space-y-0.5">
        {LAYER_ORDER.map((key) => {
          const st = SYSTEM_STYLES[key];
          const s = stats?.bySystem[key];
          const on = layers[key];
          const Icon = SYSTEM_ICONS[key];
          return (
            <li key={key}>
              <div
                className={cx(
                  "group rounded-lg px-2 py-[6px] transition-colors",
                  on ? "hover:bg-white/[0.04]" : "opacity-55 hover:bg-white/[0.03] hover:opacity-80",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-md"
                    style={{ background: on ? `${st.color}1f` : "rgba(255,255,255,0.03)", color: st.color }}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <button
                    type="button"
                    onClick={() => setLayer(key, !on)}
                    className="min-w-0 flex-1 text-left"
                    title={st.description}
                  >
                    <div className="truncate text-[12.5px] leading-tight text-ink-50">{st.label}</div>
                    <div className="dt-num mt-[2px] text-[10px] leading-none text-ink-400">
                      {s ? `${s.nodes} nodes · ${s.edges} links` : "—"}
                    </div>
                  </button>
                  <Switch
                    checked={on}
                    onChange={(v) => setLayer(key, v)}
                    label={`${st.label} layer`}
                    color={st.color}
                  />
                </div>
                {s && s.nodes + s.edges > 0 && (
                  <ProvenanceBar provenance={s.provenance} className="mt-[5px] ml-[34px] mr-[38px]" />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {stats && (
        <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 px-0.5">
          {PROVENANCE_CATEGORIES.map((c) => (
            <span key={c} className="flex items-center gap-1 text-[9.5px] text-ink-300">
              <span
                className={cx("inline-block h-[5px] w-2.5 rounded-[1px]", c === "simulated" && "dt-hatch")}
                style={{
                  background: c === "simulated" ? `${PROVENANCE_STYLES[c].color}55` : PROVENANCE_STYLES[c].color,
                }}
              />
              {PROVENANCE_STYLES[c].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProvenanceBar({
  provenance,
  className,
  height = 3,
}: {
  provenance: Record<string, number>;
  className?: string;
  height?: number;
}) {
  const total = PROVENANCE_CATEGORIES.reduce((a, c) => a + (provenance[c] ?? 0), 0) || 1;
  const label = PROVENANCE_CATEGORIES.filter((c) => provenance[c])
    .map((c) => `${PROVENANCE_STYLES[c].label} ${Math.round(((provenance[c] ?? 0) / total) * 100)}%`)
    .join(" · ");
  return (
    <Tooltip label={`Data provenance: ${label}`} className={cx("block", className)}>
      <ShareBar
        height={height}
        parts={PROVENANCE_CATEGORIES.map((c) => ({
          key: c,
          value: provenance[c] ?? 0,
          color: PROVENANCE_STYLES[c].color,
          hatched: c === "simulated",
          label: PROVENANCE_STYLES[c].label,
        }))}
      />
    </Tooltip>
  );
}

function Overlays({ stats }: { stats: NetworkStats | null }) {
  const showDependencies = useStore((s) => s.showDependencies);
  const showParticles = useStore((s) => s.showParticles);
  const showLabels = useStore((s) => s.showLabels);
  const setShowDependencies = useStore((s) => s.setShowDependencies);
  const setShowParticles = useStore((s) => s.setShowParticles);
  const setShowLabels = useStore((s) => s.setShowLabels);
  const rows: { label: string; hint: string; value: boolean; set: (v: boolean) => void; preview: React.ReactNode }[] = [
    {
      label: "Dependency links",
      hint: stats ? `${stats.dependencyEdges}` : "",
      value: showDependencies,
      set: setShowDependencies,
      preview: <span className="h-0 w-4 border-t border-dashed border-ink-200" />,
    },
    {
      label: "Flow particles",
      hint: "",
      value: showParticles,
      set: setShowParticles,
      preview: (
        <span className="flex w-4 items-center justify-between">
          <span className="size-[3px] rounded-full bg-ink-200" />
          <span className="size-[3px] rounded-full bg-ink-200" />
          <span className="size-[3px] rounded-full bg-ink-200" />
        </span>
      ),
    },
    {
      label: "Labels",
      hint: "",
      value: showLabels,
      set: setShowLabels,
      preview: <span className="font-mono text-[8px] leading-none text-ink-200">Aa</span>,
    },
  ];
  return (
    <div className="border-t border-white/[0.06] px-3 py-2.5">
      <SectionLabel className="mb-1 px-0.5">Overlays</SectionLabel>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2.5 rounded-lg px-2 py-[5px] hover:bg-white/[0.03]">
          <span className="flex w-6 justify-center" aria-hidden>
            {r.preview}
          </span>
          <button
            type="button"
            onClick={() => r.set(!r.value)}
            className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
          >
            <span className="shrink-0 text-[12.5px] text-ink-100">{r.label}</span>
            {r.hint && <span className="dt-num truncate text-[10px] text-ink-400">{r.hint}</span>}
          </button>
          <Switch checked={r.value} onChange={r.set} label={r.label} size="sm" />
        </div>
      ))}
    </div>
  );
}

const DEEP_SYSTEMS = ["telecom", "power", "water", "underground", "transport"] as const;
const STRATA_NAMES: Record<(typeof DEEP_SYSTEMS)[number], string> = {
  telecom: "Fibre",
  power: "Power",
  water: "Water",
  underground: "Corridors",
  transport: "Rail / transit",
};

function DeepBlock({ stats }: { stats: NetworkStats | null }) {
  const deepMode = useStore((s) => s.deepMode);
  const depthScale = useStore((s) => s.depthScale);
  const setDepthScale = useStore((s) => s.setDepthScale);
  const maxDepth = Math.max(stats?.maxDepth ?? 0, 1);
  const strata = DEEP_SYSTEMS.map((k) => ({ key: k, s: stats?.bySystem[k] })).filter((x) => x.s && x.s.depthMax > 0);
  return (
    <div
      className={cx(
        "border-t border-white/[0.06] px-3 py-2.5 transition-colors duration-500",
        deepMode && "bg-[linear-gradient(180deg,rgba(34,211,238,0.05),transparent_70%)]",
      )}
    >
      <SectionLabel
        className="mb-1.5 px-0.5"
        right={
          <Switch checked={deepMode} onChange={() => toggleDeepMode()} label="Deep Mode" size="sm" color="#22d3ee" />
        }
      >
        <span className={deepMode ? "text-cyan-200" : undefined}>Deep mode · subsurface</span>
      </SectionLabel>
      <div className="px-0.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] text-ink-200">Depth exaggeration</span>
          <span className="dt-num text-[12px] text-ink-50">{depthScale}×</span>
        </div>
        <div className="mt-1">
          <Slider
            value={depthScale}
            min={1}
            max={30}
            step={1}
            onChange={setDepthScale}
            label="Depth exaggeration"
            color="#22d3ee"
            marks={[1, 8, 15, 30]}
            format={(v) => `${v} times`}
          />
        </div>
        <div className="dt-num mt-0.5 flex justify-between text-[9px] text-ink-400">
          <span>1× true</span>
          <span>30×</span>
        </div>
        {strata.length > 0 && (
          <div className="mt-2.5">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="dt-label">Strata · burial depth</span>
              <span className="dt-num text-[9.5px] text-ink-400">true · rendered</span>
            </div>
            <div className="relative space-y-[5px]">
              {strata.map(({ key, s }) => {
                const st = SYSTEM_STYLES[key];
                const lo = (s!.depthMin / maxDepth) * 100;
                const hi = (s!.depthMax / maxDepth) * 100;
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-[66px] truncate text-[10.5px] text-ink-200">{STRATA_NAMES[key]}</span>
                    <div className="relative h-[6px] flex-1 rounded-full bg-white/[0.04]">
                      <span
                        className="absolute top-0 h-full rounded-full"
                        style={{
                          left: `${lo}%`,
                          width: `${Math.max(3, hi - lo)}%`,
                          background: `linear-gradient(90deg, ${st.color}66, ${st.color})`,
                        }}
                      />
                    </div>
                    <span className="dt-num w-[84px] text-right text-[9.5px] text-ink-300">
                      {fmtNum(s!.depthMin, 1)}–{fmtNum(s!.depthMax, 1)} m<span className="text-ink-500"> · </span>
                      <span className={deepMode ? "text-cyan-200/80" : "text-ink-400"}>
                        {fmtNum(s!.depthMax * depthScale, 0)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StateLegend() {
  return (
    <div className="border-t border-white/[0.06] px-3 pt-2.5 pb-3">
      <SectionLabel className="mb-1.5 px-0.5">Simulation states</SectionLabel>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 px-0.5">
        {LEGEND_STATES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-ink-200">
            {s.kind === "edge" ? (
              <span className="h-[2px] w-2.5 rounded-full" style={{ background: s.color }} />
            ) : (
              <span
                className="size-[7px] rounded-full"
                style={{ background: s.color, boxShadow: `0 0 6px ${s.color}66` }}
              />
            )}
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Collapsed explorer: a slim rail of system toggles. */
function LayerRail({ stats, onExpand }: { stats: NetworkStats | null; onExpand?: () => void }) {
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  return (
    <motion.nav
      aria-label="Layers (collapsed)"
      className="dt-panel flex w-11 flex-col items-center gap-1 py-1.5"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.16 }}
    >
      <IconButton label="Expand infrastructure explorer" shortcut="L" tooltipSide="right" size="sm" onClick={onExpand}>
        <ChevronsRight className="size-4" />
      </IconButton>
      <span className="my-0.5 h-px w-5 bg-white/[0.08]" />
      {LAYER_ORDER.map((k) => {
        const st = SYSTEM_STYLES[k];
        const Icon = SYSTEM_ICONS[k];
        const s = stats?.bySystem[k];
        return (
          <Tooltip
            key={k}
            side="right"
            label={`${st.label}${s ? ` · ${s.nodes} nodes` : ""} — ${layers[k] ? "visible" : "hidden"}`}
          >
            <button
              type="button"
              aria-pressed={layers[k]}
              aria-label={`${st.label} layer`}
              onClick={() => toggleLayer(k)}
              className={cx(
                "flex size-8 items-center justify-center rounded-lg transition-all",
                layers[k] ? "opacity-100" : "opacity-35 hover:opacity-70",
              )}
              style={{ color: st.color, background: layers[k] ? `${st.color}1a` : undefined }}
            >
              <Icon className="size-4" />
            </button>
          </Tooltip>
        );
      })}
    </motion.nav>
  );
}
