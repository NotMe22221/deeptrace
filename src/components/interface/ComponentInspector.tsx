"use client";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  FlaskConical,
  GitBranch,
  ListPlus,
  MapPin,
  Waypoints,
  X,
  Zap,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useStore, type NetworkIndex } from "@/lib/store";
import {
  connectionLabel,
  EDGE_STATE_STYLES,
  NODE_STATE_STYLES,
  PROVENANCE_STYLES,
  SEVERITY_STYLES,
  SYSTEM_STYLES,
  typeLabel,
} from "@/lib/systems";
import { fmtElevation, fmtLat, fmtLon, fmtMeters, fmtNum, fmtPct, fmtValue, humanizeKey } from "@/lib/format";
import { world } from "@/engine/worldBridge";
import type { InfrastructureEdge, InfrastructureNode, Provenance, Relation, SystemType } from "@/types/infrastructure";
import {
  askAnalyst,
  closePanel,
  copyText,
  focusEdge,
  focusNode,
  leaveDiff,
  simulateEdgeFailure,
  simulateNodeFailure,
  toggleDraftTarget,
} from "./actions";
import {
  Chip,
  cx,
  IconButton,
  KeyValue,
  ProvenanceChip,
  SectionLabel,
  Spinner,
  StateChip,
  SystemDot,
  Tooltip,
} from "./ui";
import { useUI } from "./uiStore";
import { affectedStyle } from "./stateStyle";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(id)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
      aria-label={`Copy id ${id}`}
      className="group inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[11px] text-ink-300 hover:bg-white/[0.05] hover:text-ink-100"
    >
      <span className="truncate">{id}</span>
      {done ? <Check className="size-3 text-ok" /> : <Copy className="size-3 opacity-50 group-hover:opacity-100" />}
    </button>
  );
}

export function ProvenanceBlock({ provenance }: { provenance: Provenance }) {
  const p = PROVENANCE_STYLES[provenance.category];
  const simulated = provenance.category === "simulated";
  return (
    <div
      className={cx("rounded-lg border px-3 py-2.5", simulated ? "dt-hatch border-dashed" : "bg-white/[0.02]")}
      style={{ borderColor: `${p.color}${simulated ? "66" : "33"}` }}
    >
      <div className="flex items-center gap-2">
        <span className="dt-label">Provenance</span>
        <ProvenanceChip category={provenance.category} />
        <span className="ml-auto flex items-center gap-1.5" title="Confidence in this record">
          <span className="relative h-1 w-12 overflow-hidden rounded-full bg-white/[0.08]">
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${Math.round(provenance.confidence * 100)}%`, background: p.color }}
            />
          </span>
          <span className="dt-num text-[10.5px] text-ink-200">{fmtPct(provenance.confidence)}</span>
        </span>
      </div>
      {simulated && (
        <p className="mt-1.5 text-[11.5px] leading-snug font-medium text-ink-50">
          Illustrative asset — generated for modelling. It does not describe real infrastructure.
        </p>
      )}
      <p className="mt-1 text-[11.5px] leading-snug text-ink-300">
        <span className="text-ink-200">{provenance.source}</span>
        {provenance.license && <span> · {provenance.license}</span>}
        {provenance.retrieved_at && <span> · retrieved {provenance.retrieved_at.slice(0, 10)}</span>}
      </p>
      {provenance.notes && <p className="mt-1 text-[11.5px] leading-snug text-ink-300">{provenance.notes}</p>}
    </div>
  );
}

/** Property value; ids of known components/connections become clickable links. */
function PropValue({ v, index }: { v: unknown; index: NetworkIndex }) {
  const ids = (Array.isArray(v) ? v : [v]).filter(
    (x): x is string => typeof x === "string" && (index.nodes.has(x) || index.edges.has(x)),
  );
  if (!ids.length) return <>{fmtValue(v)}</>;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      {ids.map((id) => {
        const n = index.nodes.get(id);
        const e = n ? null : index.edges.get(id);
        const sys = n?.system ?? e?.infrastructure_type;
        return (
          <button
            key={id}
            type="button"
            onClick={() => (n ? focusNode(id) : focusEdge(id))}
            title={n?.name ?? e?.name ?? id}
            className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-1 font-mono text-[10.5px] text-ink-100 hover:border-white/25"
          >
            {sys && <SystemDot system={sys} size={5} />}
            {id}
          </button>
        );
      })}
    </span>
  );
}

function RelationTag({ relation }: { relation?: Relation }) {
  if (!relation) return null;
  return relation === "physical" ? (
    <span
      className="flex items-center gap-1 font-mono text-[9px] tracking-[0.1em] text-ink-300"
      title="Physical conduit"
    >
      <span className="h-0 w-3 border-t-[1.5px] border-ink-300" />
      PHYS
    </span>
  ) : (
    <span
      className="flex items-center gap-1 font-mono text-[9px] tracking-[0.1em] text-sky-200/80"
      title="Service dependency"
    >
      <span className="h-0 w-3 border-t-[1.5px] border-dashed border-sky-200/80" />
      DEP
    </span>
  );
}

interface LinkRow {
  id: string;
  relation?: Relation;
  via?: string;
  depth?: number;
}

function NodeRow({ row, index, onClick }: { row: LinkRow; index: NetworkIndex; onClick: () => void }) {
  const n = index.nodes.get(row.id);
  const result = useStore((s) => s.result);
  const state = result?.node_states[row.id];
  const impacted = state && NODE_STATE_STYLES[state]?.impacted;
  if (!n) return null;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left hover:bg-white/[0.05]"
      >
        <SystemDot system={n.system} size={7} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-ink-100 group-hover:text-ink-50">{n.name}</span>
          <span className="block truncate text-[10px] text-ink-400">
            {typeLabel(n.type)}
            {row.via && <span> · via {row.via}</span>}
            {row.depth !== undefined && row.depth > 1 && <span> · {row.depth} hops</span>}
          </span>
        </span>
        {impacted && (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: NODE_STATE_STYLES[state!].color }}
            title={NODE_STATE_STYLES[state!].label}
          />
        )}
        <RelationTag relation={row.relation} />
      </button>
    </li>
  );
}

function LinkGroup({
  title,
  hint,
  rows,
  index,
  defaultOpen = true,
}: {
  title: string;
  hint?: string;
  rows: LinkRow[];
  index: NetworkIndex;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-white/[0.03]"
      >
        <ChevronDown className={cx("size-3 text-ink-400 transition-transform", !open && "-rotate-90")} />
        <span className="text-[11.5px] font-medium text-ink-200">{title}</span>
        <span className="dt-num text-[10.5px] text-ink-400">{rows.length}</span>
        {hint && <span className="ml-auto text-[10px] text-ink-400">{hint}</span>}
      </button>
      {open && (
        <>
          <ul>
            {shown.map((r) => (
              <NodeRow key={r.id} row={r} index={index} onClick={() => focusNode(r.id)} />
            ))}
          </ul>
          {rows.length > 6 && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="ml-2 py-1 text-[11px] text-sky-200/80 hover:text-sky-100"
            >
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ActionCell({
  icon,
  label,
  onClick,
  active,
  tone,
  disabled,
  loading,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  tone?: "danger" | "default";
  disabled?: boolean;
  loading?: boolean;
  title?: string;
}) {
  return (
    <Tooltip label={title ?? label} side="bottom" className="flex-1">
      <button
        type="button"
        // while loading the cell keeps keyboard focus (aria-disabled), see Button's `busy`
        onClick={() => {
          if (!loading) onClick();
        }}
        disabled={disabled}
        aria-disabled={(!disabled && loading) || undefined}
        aria-busy={loading || undefined}
        aria-pressed={active}
        className={cx(
          "flex h-[46px] w-full flex-col items-center justify-center gap-1 rounded-lg border text-[10.5px] leading-none transition-colors disabled:opacity-40 aria-disabled:opacity-40",
          tone === "danger"
            ? "border-alert/30 bg-alert/[0.1] text-[#fda4af] hover:bg-alert/[0.18]"
            : active
              ? "border-sky-300/35 bg-sky-300/[0.1] text-sky-100"
              : "border-white/[0.07] bg-white/[0.025] text-ink-200 hover:border-white/15 hover:bg-white/[0.06] hover:text-ink-50",
        )}
      >
        {loading ? <Spinner className="text-current" /> : icon}
        <span className="whitespace-nowrap">{label}</span>
      </button>
    </Tooltip>
  );
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-white/[0.06] px-4 py-3">
      <SectionLabel className="mb-1.5" right={right}>
        {title}
      </SectionLabel>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inspector root
// ---------------------------------------------------------------------------

export function ComponentInspector() {
  const index = useStore((s) => s.index);
  const nodeId = useStore((s) => s.selectedNodeId);
  const edgeId = useStore((s) => s.selectedEdgeId);
  if (!index) return null;
  const node = nodeId ? index.nodes.get(nodeId) : null;
  const edge = edgeId ? index.edges.get(edgeId) : null;
  if (node) return <NodeInspector key={node.id} node={node} index={index} />;
  if (edge) return <EdgeInspector key={edge.id} edge={edge} index={index} />;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <Crosshair className="size-5 text-ink-400" />
      <p className="text-[12.5px] text-ink-200">Select a component in the city</p>
      <p className="text-[11.5px] text-ink-400">or press / to search by name, id or type.</p>
    </div>
  );
}

function InspectorHeader({
  system,
  kicker,
  title,
  id,
  chips,
}: {
  system: SystemType;
  kicker: ReactNode;
  title: string;
  id: string;
  chips?: ReactNode;
}) {
  const st = SYSTEM_STYLES[system];
  return (
    <div className="relative shrink-0 overflow-hidden px-4 pt-3 pb-3">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-20 opacity-70"
        style={{ background: `radial-gradient(120% 100% at 0% 0%, ${st.color}26, transparent 70%)` }}
      />
      <div aria-hidden className="absolute top-0 left-0 h-full w-[2px]" style={{ background: st.color }} />
      <div className="relative flex items-center gap-2">
        <span
          className="flex items-center gap-1.5 font-mono text-[9.5px] tracking-[0.14em] uppercase"
          style={{ color: st.color }}
        >
          <SystemDot system={system} size={7} />
          {st.label}
        </span>
        <span className="truncate text-[11px] text-ink-300">· {kicker}</span>
        <span className="ml-auto -mr-2">
          <IconButton label="Close inspector" shortcut="Esc" size="sm" onClick={() => closePanel("inspector")}>
            <X className="size-4" />
          </IconButton>
        </span>
      </div>
      <h2 className="relative mt-1 font-display text-[18px] leading-tight font-semibold text-ink-50">{title}</h2>
      <div className="relative mt-1 flex flex-wrap items-center gap-1.5">
        <span className="-ml-1">
          <CopyId id={id} />
        </span>
        {chips}
      </div>
    </div>
  );
}

function NodeInspector({ node, index }: { node: InfrastructureNode; index: NetworkIndex }) {
  const details = useStore((s) => (s.details?.node.id === node.id ? s.details : null));
  const detailsLoading = useStore((s) => s.detailsLoading);
  const trace = useStore((s) => (s.trace?.node_id === node.id ? s.trace : null));
  const traceVisible = useStore((s) => s.traceVisible);
  const showTrace = useStore((s) => s.showTrace);
  const hideTrace = useStore((s) => s.hideTrace);
  const draft = useStore((s) => s.draft);
  const result = useStore((s) => s.result);
  const simStatus = useStore((s) => s.simStatus);
  const metrics = useStore((s) => s.metrics);
  const pushToast = useUI((s) => s.pushToast);
  const [tracing, setTracing] = useState(false);

  const inDraft = draft.failed_nodes.includes(node.id);
  const tracingThis = traceVisible && !!trace;

  // Single point of failure is only claimed from engine output: live node details, or (offline)
  // the engine's SPOF set exported in the snapshot. null = unknown, so nothing is claimed.
  const dataMode = useStore((s) => s.dataMode);
  const spof: boolean | null = details?.is_single_point_of_failure ?? null;
  const critEntry = useMemo(() => {
    const i = metrics?.criticality_ranking.findIndex((c) => c.node_id === node.id) ?? -1;
    return i >= 0
      ? { rank: i + 1, entry: metrics!.criticality_ranking[i], of: metrics!.criticality_ranking.length }
      : null;
  }, [metrics, node.id]);
  const rank = details?.criticality_rank ?? critEntry?.rank ?? null;

  // Direct edges from this node to each neighbour -> relation + connection type
  const direct = useMemo(() => {
    const m = new Map<string, InfrastructureEdge>();
    for (const eid of index.incident.get(node.id) ?? []) {
      const e = index.edges.get(eid);
      if (!e) continue;
      const other = e.source_node === node.id ? e.target_node : e.source_node;
      if (!m.has(other) || e.relation === "physical") m.set(other, e);
    }
    return m;
  }, [index, node.id]);

  const hopInfo = useMemo(() => {
    const m = new Map<string, { relation: Relation; depth: number }>();
    if (trace)
      for (const h of [...trace.upstream, ...trace.downstream, ...trace.dependencies, ...trace.dependents])
        if (!m.has(h.node_id)) m.set(h.node_id, { relation: h.relation, depth: h.depth });
    return m;
  }, [trace]);

  const toRows = (ids: string[] | undefined): LinkRow[] =>
    [...new Set(ids ?? [])]
      .filter((id) => id !== node.id && index.nodes.has(id))
      .map((id) => {
        const e = direct.get(id);
        const hop = hopInfo.get(id);
        return {
          id,
          relation: e?.relation ?? hop?.relation,
          via: e ? connectionLabel(e.connection_type) : undefined,
          depth: e ? 1 : hop?.depth,
        };
      });

  const physicalNeighbours = [...direct.entries()].filter(([, e]) => e.relation === "physical").map(([id]) => id);
  const upstream = toRows(details?.upstream_ids?.length ? details.upstream_ids : trace?.upstream.map((h) => h.node_id));
  const downstream = toRows(
    details?.downstream_ids?.length ? details.downstream_ids : trace?.downstream.map((h) => h.node_id),
  );
  const dependencies = toRows(
    details?.dependency_ids ??
      [...direct.entries()]
        .filter(([, e]) => e.relation === "dependency" && e.target_node === node.id)
        .map(([id]) => id),
  );
  const dependents = toRows(
    details?.dependent_ids ??
      [...direct.entries()]
        .filter(([, e]) => e.relation === "dependency" && e.source_node === node.id)
        .map(([id]) => id),
  );
  const listed = new Set([...upstream, ...downstream, ...dependencies, ...dependents].map((r) => r.id));
  const connected = toRows(physicalNeighbours.filter((id) => !listed.has(id)));

  const affected = result?.affected_nodes.find((a) => a.node_id === node.id) ?? null;
  const simState = result?.node_states[node.id] ?? null;

  const propEntries = Object.entries(node.properties ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  const modelled =
    node.provenance.category === "simulated" ||
    node.provenance.category === "estimated" ||
    node.properties.modelled_figures === true;

  const onTrace = async () => {
    if (tracingThis) return hideTrace();
    // the A/B diff view does not draw traces: show this one on the map
    leaveDiff();
    setTracing(true);
    await showTrace(node.id);
    setTracing(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <InspectorHeader
        system={node.system}
        kicker={typeLabel(node.type)}
        title={node.name}
        id={node.id}
        chips={
          <>
            <ProvenanceChip category={node.provenance.category} />
            {node.critical && <Chip color="#f43f5e">Critical</Chip>}
            {spof === true && (
              <Chip
                color="#fb923c"
                title="Engine N-1 analysis: its failure cuts demand off from every source in its network, or affects 5+ components"
              >
                Single point of failure
              </Chip>
            )}
          </>
        }
      />
      <div className="flex shrink-0 gap-1.5 px-4 pb-3">
        <ActionCell
          icon={<Waypoints className="size-4" />}
          label={tracingThis ? "Hide trace" : "Trace"}
          onClick={onTrace}
          active={tracingThis}
          loading={tracing}
          title={tracingThis ? "Hide traced connections" : "Trace upstream, downstream and dependencies"}
        />
        <ActionCell icon={<MapPin className="size-4" />} label="Fly to" onClick={() => world().flyToNode(node.id)} />
        <ActionCell
          icon={inDraft ? <Check className="size-4" /> : <ListPlus className="size-4" />}
          label={inDraft ? "In scenario" : "Add to scenario"}
          active={inDraft}
          onClick={() => {
            toggleDraftTarget("node", node.id);
            pushToast({
              tone: "info",
              title: inDraft ? "Removed from scenario" : "Added to scenario",
              body: `${node.name} — ${useStore.getState().draft.failed_nodes.length + useStore.getState().draft.failed_edges.length} failure target(s) in the draft.`,
            });
          }}
          title={inDraft ? "Remove from the draft scenario" : "Add as a failure target to the draft scenario"}
        />
        <ActionCell
          icon={<Zap className="size-4" />}
          label="Simulate"
          tone="danger"
          loading={simStatus === "running"}
          onClick={() => void simulateNodeFailure(node.id)}
          title="Simulate the failure of this component"
        />
        <ActionCell
          icon={<Bot className="size-4" />}
          label="Ask AI"
          onClick={() => askAnalyst("What depends on this component and what happens if it fails?")}
          title="Ask the analyst what depends on this component"
        />
      </div>

      <div className="dt-scroll min-h-0 flex-1 overflow-y-auto pb-2">
        {result && simState && (
          <Section
            title="Simulation status"
            right={
              <span className="dt-num text-[10px] text-ink-400">{result.scenario.name ?? result.scenario_id}</span>
            }
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {affected && affectedStyle(affected).rerouted ? (
                <Chip color="#4ade80">Rerouted · no service loss</Chip>
              ) : (
                <StateChip state={simState} />
              )}
              {affected && !affectedStyle(affected).impacted && !affectedStyle(affected).rerouted && (
                <Chip color="#4ade80">No service loss</Chip>
              )}
              {affected && affectedStyle(affected).impacted && (
                <>
                  <Chip color={SEVERITY_STYLES[affected.severity].color}>
                    {SEVERITY_STYLES[affected.severity].label}
                  </Chip>
                  <span className="dt-num text-[10.5px] text-ink-300">
                    step {affected.step} · service {fmtPct(affected.service_level)}
                  </span>
                </>
              )}
            </div>
            {affected ? (
              <>
                <p className="mt-2 text-[12.5px] leading-snug text-ink-100">{affected.cause}</p>
                {affected.caused_by.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className="dt-label mr-1">Caused by</span>
                    {affected.caused_by.map((id, i) => {
                      const n = index.nodes.get(id);
                      const e = index.edges.get(id);
                      return (
                        <span key={id} className="flex items-center gap-1">
                          {i > 0 && <ArrowRight className="size-3 text-ink-500" />}
                          <button
                            type="button"
                            onClick={() => (n ? focusNode(id) : focusEdge(id))}
                            className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[11px] text-ink-100 hover:border-white/25"
                          >
                            {n && <SystemDot system={n.system} size={6} />}
                            {n?.name ?? (e ? e.name || connectionLabel(e.connection_type) : id)}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 text-[12px] text-ink-300">Not affected in this scenario.</p>
            )}
          </Section>
        )}

        {tracingThis && trace && (
          <Section title="Trace" right={<span className="dt-num text-[10px] text-ink-400">shown on map</span>}>
            <div className="grid grid-cols-4 gap-1.5">
              {[
                ["Upstream", trace.upstream.length],
                ["Downstream", trace.downstream.length],
                ["Depends on", trace.dependencies.length],
                ["Dependents", trace.dependents.length],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                  <div className="dt-num text-[15px] leading-none text-ink-50">{v as number}</div>
                  <div className="mt-1 text-[9.5px] text-ink-400">{k as string}</div>
                </div>
              ))}
            </div>
            {trace.summary && <p className="mt-2 text-[11.5px] leading-snug text-ink-300">{trace.summary}</p>}
          </Section>
        )}

        <Section title="Location">
          <dl>
            <KeyValue label="Latitude" mono>
              {fmtLat(node.latitude)}
            </KeyValue>
            <KeyValue label="Longitude" mono>
              {fmtLon(node.longitude)}
            </KeyValue>
            <KeyValue label={node.elevation < 0 ? "Depth" : "Elevation"} mono>
              {fmtElevation(node.elevation)}
            </KeyValue>
          </dl>
        </Section>

        {(node.capacity != null || node.demand != null || critEntry || rank || node.description) && (
          <Section title="Capacity & criticality">
            {node.description && <p className="mb-1.5 text-[12px] leading-snug text-ink-200">{node.description}</p>}
            <dl>
              {node.capacity != null && (
                <KeyValue label="Capacity" mono hint={modelled ? "modelled" : undefined}>
                  {fmtNum(node.capacity)} {node.capacity_unit ?? ""}
                </KeyValue>
              )}
              {node.demand != null && (
                <KeyValue label="Demand" mono hint={modelled ? "modelled" : undefined}>
                  {fmtNum(node.demand)} {node.capacity_unit ?? ""}
                </KeyValue>
              )}
              <KeyValue label="Critical asset">{node.critical ? "Yes" : "No"}</KeyValue>
              {rank != null && (
                <KeyValue label="N-1 criticality rank" mono hint={critEntry ? `of ${critEntry.of}` : undefined}>
                  #{rank}
                </KeyValue>
              )}
              {critEntry && (
                <KeyValue label="Components lost if it fails" mono>
                  {fmtNum(critEntry.entry.affected_count, 0)}
                </KeyValue>
              )}
              <KeyValue
                label="Single point of failure"
                hint={spof === null && dataMode !== "live" ? "needs live engine" : undefined}
              >
                {spof === true ? (
                  <span className="inline-flex items-center gap-1 text-warn">
                    <AlertTriangle className="size-3" /> Yes
                  </span>
                ) : spof === false ? (
                  "No"
                ) : (
                  "—"
                )}
              </KeyValue>
            </dl>
          </Section>
        )}

        {propEntries.length > 0 && (
          <Section title="Properties">
            <dl>
              {propEntries.map(([k, v]) => {
                const assumed = /assum|estimat|model/i.test(k) || (modelled && typeof v === "number");
                return (
                  <KeyValue
                    key={k}
                    label={humanizeKey(k)}
                    mono={typeof v === "number"}
                    hint={assumed ? "modelled" : undefined}
                  >
                    <PropValue v={v} index={index} />
                  </KeyValue>
                );
              })}
            </dl>
          </Section>
        )}

        <Section
          title="Connections"
          right={
            detailsLoading ? <Spinner /> : <span className="dt-num text-[10px] text-ink-400">{direct.size} direct</span>
          }
        >
          <div className="-mx-1">
            <LinkGroup title="Upstream" hint="supplies this" rows={upstream} index={index} />
            <LinkGroup title="Downstream" hint="served by this" rows={downstream} index={index} />
            <LinkGroup title="Depends on" hint="providers" rows={dependencies} index={index} />
            <LinkGroup title="Dependents" hint="consumers" rows={dependents} index={index} />
            <LinkGroup
              title="Directly connected"
              hint="physical"
              rows={connected}
              index={index}
              defaultOpen={!upstream.length && !downstream.length}
            />
            {!upstream.length &&
              !downstream.length &&
              !dependencies.length &&
              !dependents.length &&
              !connected.length && <p className="px-1 py-1 text-[12px] text-ink-400">No connections recorded.</p>}
          </div>
          <div className="mt-2 flex items-center gap-3 px-0.5 text-[10px] text-ink-400">
            <RelationTag relation="physical" />
            <span>physical conduit</span>
            <RelationTag relation="dependency" />
            <span>service dependency</span>
          </div>
        </Section>

        <section className="border-t border-white/[0.06] px-4 py-3">
          <ProvenanceBlock provenance={node.provenance} />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edge inspector
// ---------------------------------------------------------------------------

function EdgeInspector({ edge, index }: { edge: InfrastructureEdge; index: NetworkIndex }) {
  const draft = useStore((s) => s.draft);
  const result = useStore((s) => s.result);
  const simStatus = useStore((s) => s.simStatus);
  const network = useStore((s) => s.network);
  const pushToast = useUI((s) => s.pushToast);
  const inDraft = draft.failed_edges.includes(edge.id);
  const src = index.nodes.get(edge.source_node);
  const dst = index.nodes.get(edge.target_node);

  const corridorKey = edge.infrastructure_type === "underground" ? edge.id : edge.corridor_id;
  const corridorEdge = edge.corridor_id ? index.edges.get(edge.corridor_id) : null;
  const hosted = useMemo(
    () => (corridorKey ? (network?.edges ?? []).filter((e) => e.corridor_id === corridorKey && e.id !== edge.id) : []),
    [network, corridorKey, edge.id],
  );

  const state = result?.edge_states[edge.id];
  const interrupted = result?.interrupted_edges.find((x) => x.edge_id === edge.id);
  const flow = result?.edge_flows?.[edge.id];

  const endpoint = (n: InfrastructureNode | undefined, label: string) =>
    n ? (
      <button
        type="button"
        onClick={() => focusNode(n.id)}
        className="flex w-full items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-left hover:border-white/15 hover:bg-white/[0.05]"
      >
        <span className="dt-label w-8">{label}</span>
        <SystemDot system={n.system} size={7} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-ink-50">{n.name}</span>
          <span className="block truncate text-[10px] text-ink-400">{typeLabel(n.type)}</span>
        </span>
        <ArrowRight className="size-3.5 text-ink-400" />
      </button>
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <InspectorHeader
        system={edge.infrastructure_type}
        kicker={connectionLabel(edge.connection_type)}
        title={edge.name || `${connectionLabel(edge.connection_type)}`}
        id={edge.id}
        chips={
          <>
            <ProvenanceChip category={edge.provenance.category} />
            <Chip color={edge.relation === "dependency" ? "#7dd3fc" : undefined}>
              {edge.relation === "dependency" ? "Dependency" : "Physical"}
            </Chip>
            {edge.status !== "operational" && <StateChip state={edge.status} kind="edge" />}
          </>
        }
      />
      <div className="flex shrink-0 gap-1.5 px-4 pb-3">
        <ActionCell
          icon={<MapPin className="size-4" />}
          label="Fly to"
          onClick={() => world().flyToNodes([edge.source_node, edge.target_node])}
        />
        <ActionCell
          icon={inDraft ? <Check className="size-4" /> : <ListPlus className="size-4" />}
          label={inDraft ? "In scenario" : "Add to scenario"}
          active={inDraft}
          onClick={() => {
            toggleDraftTarget("edge", edge.id);
            pushToast({
              tone: "info",
              title: inDraft ? "Connection removed from scenario" : "Connection added to scenario",
            });
          }}
          title={inDraft ? "Remove connection from the draft scenario" : "Add connection to the draft scenario"}
        />
        <ActionCell
          icon={<FlaskConical className="size-4" />}
          label="Fail connection"
          tone="danger"
          loading={simStatus === "running"}
          onClick={() => void simulateEdgeFailure(edge.id)}
          title="Simulate the failure of this connection"
        />
      </div>
      <div className="dt-scroll min-h-0 flex-1 overflow-y-auto pb-2">
        {result && state && (
          <Section title="Simulation status">
            <div className="flex items-center gap-2">
              <StateChip state={state} kind="edge" />
              {interrupted && <span className="dt-num text-[10.5px] text-ink-300">step {interrupted.step}</span>}
            </div>
            {interrupted?.reason && (
              <p className="mt-2 text-[12.5px] leading-snug text-ink-100">{interrupted.reason}</p>
            )}
            {!EDGE_STATE_STYLES[state]?.impacted && !interrupted && (
              <p className="mt-1.5 text-[12px] text-ink-300">Not affected in this scenario.</p>
            )}
            {flow && flow.direction !== 0 && (
              <p className="dt-num mt-1.5 text-[11px] text-ink-300">
                Flow {fmtNum(flow.flow)} {flow.unit ?? ""} · utilisation {fmtPct(flow.utilization)}
              </p>
            )}
          </Section>
        )}
        <Section title="Endpoints">
          <div className="space-y-1.5">
            {endpoint(src, edge.directed ? "From" : "A")}
            {endpoint(dst, edge.directed ? "To" : "B")}
          </div>
        </Section>
        <Section title="Specification">
          <dl>
            <KeyValue label="Connection">{connectionLabel(edge.connection_type)}</KeyValue>
            <KeyValue label="Relation">
              {edge.relation === "dependency" ? "Service dependency" : "Physical conduit"}
            </KeyValue>
            {edge.capacity != null && (
              <KeyValue label="Capacity" mono>
                {fmtNum(edge.capacity)} {edge.capacity_unit ?? ""}
              </KeyValue>
            )}
            {edge.relation === "physical" && (
              <KeyValue label="Length" mono>
                {fmtMeters(edge.length_m)}
              </KeyValue>
            )}
            {edge.relation === "physical" && (
              <KeyValue label="Burial depth" mono>
                {edge.depth_m > 0 ? `${fmtNum(edge.depth_m, 1)} m below ground` : "At grade"}
              </KeyValue>
            )}
            <KeyValue label="Directed">{edge.directed ? "Yes" : "No"}</KeyValue>
            {Object.entries(edge.properties ?? {})
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => (
                <KeyValue key={k} label={humanizeKey(k)} mono={typeof v === "number"}>
                  <PropValue v={v} index={index} />
                </KeyValue>
              ))}
          </dl>
        </Section>
        {(corridorEdge || hosted.length > 0 || edge.corridor_id) && (
          <Section title={edge.infrastructure_type === "underground" ? "Hosted in this corridor" : "Shared corridor"}>
            {edge.corridor_id && (
              <div className="mb-1.5 flex items-center gap-2 text-[12px]">
                <GitBranch className="size-3.5 text-ink-400" />
                <span className="text-ink-300">Runs in</span>
                {corridorEdge ? (
                  <button
                    type="button"
                    className="truncate text-sky-200 hover:text-sky-100"
                    onClick={() => focusEdge(corridorEdge.id)}
                  >
                    {corridorEdge.name || corridorEdge.id}
                  </button>
                ) : (
                  <span className="font-mono text-[11px] text-ink-100">{edge.corridor_id}</span>
                )}
              </div>
            )}
            {hosted.length > 0 ? (
              <ul className="-mx-1">
                {hosted.slice(0, 12).map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => focusEdge(h.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left hover:bg-white/[0.05]"
                    >
                      <SystemDot system={h.infrastructure_type} size={7} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-100">
                        {h.name || connectionLabel(h.connection_type)}
                      </span>
                      <span className="font-mono text-[10px] text-ink-400">{h.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11.5px] text-ink-400">No other connections recorded in this corridor.</p>
            )}
            {hosted.length > 0 && (
              <p className="mt-1.5 text-[11px] leading-snug text-ink-400">
                A strike here can cut every system that shares the corridor.
              </p>
            )}
          </Section>
        )}
        <section className="border-t border-white/[0.06] px-4 py-3">
          <ProvenanceBlock provenance={edge.provenance} />
        </section>
      </div>
    </div>
  );
}
