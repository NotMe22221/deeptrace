"use client";
/**
 * Hover tooltip for nodes and edges in the 3D world, positioned at the pointer.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { indexResult } from "@/engine/rendering/displayState";
import { useWorldUi } from "@/engine/worldUi";
import { useStore } from "@/lib/store";
import { connectionLabel, EDGE_STATE_STYLES, NODE_STATE_STYLES, PROVENANCE_STYLES, SYSTEM_STYLES, typeLabel } from "@/lib/systems";
import type { EdgeState, NodeState, ProvenanceCategory, SystemType } from "@/types/infrastructure";

interface TipModel {
  title: string;
  subtitle: string;
  system: SystemType;
  state: { label: string; color: string; impacted: boolean };
  provenance: ProvenanceCategory;
  depth: string | null;
}

export default function WorldTooltip() {
  const pointer = useWorldUi((s) => s.pointer);
  const hoveredId = useStore((s) => s.hoveredId);
  const index = useStore((s) => s.index);
  const result = useStore((s) => (s.compareView === "diff" ? null : s.result));
  const baseline = useStore((s) => s.baseline);
  const step = useStore((s) => s.playback.step);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 240, h: 90 });

  const model = useMemo<TipModel | null>(() => {
    if (!hoveredId || !index) return null;
    const ri = result ? indexResult(result) : null;
    const node = index.nodes.get(hoveredId);
    if (node) {
      let state: NodeState = (baseline?.node_states?.[node.id] as NodeState | undefined) ?? node.status ?? "operational";
      if (result && ri) {
        const rs = result.node_states?.[node.id] ?? ri.affState.get(node.id);
        const at = ri.nodeStep.get(node.id) ?? 0;
        if (rs && at <= step) state = rs;
      }
      const ss = NODE_STATE_STYLES[state] ?? NODE_STATE_STYLES.operational;
      return {
        title: node.name,
        subtitle: typeLabel(node.type),
        system: node.system,
        state: { label: ss.label, color: ss.color, impacted: ss.impacted },
        provenance: node.provenance?.category ?? "simulated",
        depth: node.elevation < 0 ? `${Math.abs(node.elevation).toFixed(node.elevation > -10 ? 1 : 0)} m below ground` : node.elevation > 2 ? `${node.elevation.toFixed(0)} m above ground` : null,
      };
    }
    const edge = index.edges.get(hoveredId);
    if (edge) {
      let state: EdgeState = (baseline?.edge_states?.[edge.id] as EdgeState | undefined) ?? edge.status ?? "operational";
      if (result && ri) {
        const rs = result.edge_states?.[edge.id];
        const at = ri.edgeStep.get(edge.id) ?? 0;
        if (rs && rs !== "operational" && at <= step) state = rs;
      }
      const ss = EDGE_STATE_STYLES[state] ?? EDGE_STATE_STYLES.operational;
      const a = index.nodes.get(edge.source_node)?.name ?? edge.source_node;
      const b = index.nodes.get(edge.target_node)?.name ?? edge.target_node;
      const sys = edge.relation === "dependency" ? (index.nodes.get(edge.source_node)?.system ?? edge.infrastructure_type) : edge.infrastructure_type;
      return {
        title: edge.name || connectionLabel(edge.connection_type),
        subtitle: `${a} → ${b}`,
        system: sys,
        state: { label: edge.relation === "dependency" ? `Dependency · ${ss.label}` : ss.label, color: ss.color, impacted: ss.impacted },
        provenance: edge.provenance?.category ?? "simulated",
        depth: edge.depth_m > 0 ? `${edge.depth_m.toFixed(edge.depth_m < 10 ? 1 : 0)} m deep · ${Math.round(edge.length_m)} m` : `${Math.round(edge.length_m)} m`,
      };
    }
    return null;
  }, [hoveredId, index, result, baseline, step]);

  useLayoutEffect(() => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      if (Math.abs(r.width - size.w) > 1 || Math.abs(r.height - size.h) > 1) setSize({ w: r.width, h: r.height });
    }
  }, [model, size.w, size.h]);

  if (!model || !pointer) return null;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1600;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  let x = pointer.x + 16;
  let y = pointer.y + 18;
  if (x + size.w > vw - 8) x = pointer.x - size.w - 14;
  if (y + size.h > vh - 8) y = pointer.y - size.h - 14;
  const sys = SYSTEM_STYLES[model.system];
  const prov = PROVENANCE_STYLES[model.provenance] ?? PROVENANCE_STYLES.simulated;

  return (
    <div
      ref={ref}
      role="tooltip"
      className="dt-panel-strong pointer-events-none absolute z-40 max-w-[300px] px-3 py-2.5"
      style={{ left: x, top: y, borderRadius: 10 }}
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: sys?.color, boxShadow: `0 0 8px ${sys?.color}` }} />
        <span className="truncate text-[12.5px] font-semibold leading-tight text-ink-50">{model.title}</span>
      </div>
      <div className="mt-0.5 truncate pl-4 text-[11px] text-ink-300">
        {model.subtitle}
        {sys ? <span className="text-ink-400"> · {sys.label}</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-4">
        <span
          className="dt-num rounded px-1.5 py-[1px] text-[10px] uppercase tracking-wider"
          style={{
            color: model.state.impacted ? model.state.color : "#a1abc0",
            background: model.state.impacted ? `${model.state.color}1f` : "rgba(148,163,184,0.1)",
            border: `1px solid ${model.state.impacted ? `${model.state.color}55` : "rgba(148,163,184,0.18)"}`,
          }}
        >
          {model.state.label}
        </span>
        <span
          className={`dt-num rounded px-1.5 py-[1px] text-[10px] tracking-wider ${model.provenance === "simulated" ? "dt-hatch" : ""}`}
          style={{ color: prov.color, border: `1px solid ${prov.color}40` }}
          title={prov.description}
        >
          {prov.short}
        </span>
        {model.depth && <span className="dt-num text-[10px] text-ink-400">{model.depth}</span>}
      </div>
    </div>
  );
}
