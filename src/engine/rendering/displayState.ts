/**
 * Display model: turns store state (layers, simulation result + playback step, comparison,
 * trace, highlight, selection) into a per-node / per-edge visual description. Pure logic, no
 * Cesium — renderers consume the result. Recomputed only when one of its inputs changes.
 */
import type { DeeptraceState } from "@/lib/store";
import { EDGE_STATE_STYLES, NODE_STATE_STYLES } from "@/lib/systems";
import type { EdgeFlow, EdgeState, NodeState, SimulationResult } from "@/types/infrastructure";
import type { NetworkGeometry } from "./NetworkGeometry";
import { DIFF_HEX, edgeStateRgb, hexToRgb, nodeStateRgb, systemRgb, TONE_HEX, WHITE, type RGB } from "./palette";

export type Pulse = "none" | "fail" | "blink" | "alert";

export interface NodeVisual {
  visible: boolean;
  /** ring / glyph colour */
  rgb: RGB;
  alpha: number;
  state: NodeState;
  impacted: boolean;
  /** 0 normal, 1 emphasised (trace/highlight/diff), 2 selected */
  emphasis: number;
  halo: RGB | null;
  pulse: Pulse;
  /** cascade step at which the current state appeared (-1 = baseline) */
  step: number;
}

export interface FlowVisual {
  dir: -1 | 1;
  utilization: number;
  speedMul: number;
  sizeMul: number;
  alpha: number;
  rgb: RGB;
  /** also run particles in the opposite direction (two-way traffic) */
  twoWay: boolean;
}

export interface EdgeVisual {
  visible: boolean;
  rgb: RGB;
  alpha: number;
  widthMul: number;
  /** white-hot core 0..1 */
  core: number;
  state: EdgeState;
  impacted: boolean;
  /** force dashed (normally-open ties, interrupted) */
  dashed: boolean;
  pulse: Pulse;
  flow: FlowVisual | null;
  /** trace role */
  trace: "none" | "up" | "down" | "dep";
  step: number;
}

export interface DisplayModel {
  nodes: NodeVisual[];
  edges: EdgeVisual[];
  /** a focus mode (trace / highlight / diff) dims non-focused items */
  focusMode: "none" | "trace" | "highlight" | "diff";
  resultActive: boolean;
  diff: boolean;
}

export type DisplayInput = Pick<
  DeeptraceState,
  | "layers"
  | "showDependencies"
  | "result"
  | "baseline"
  | "playback"
  | "compareView"
  | "comparison"
  | "trace"
  | "traceVisible"
  | "highlight"
  | "selectedNodeId"
  | "selectedEdgeId"
>;

const BLOCKED: Set<EdgeState> = new Set(["failed", "interrupted", "isolated", "normally_open"]);
const ALT: Set<EdgeState> = new Set(["rerouted", "activated"]);
const BLACK_NODE: Set<NodeState> = new Set(["failed", "de_energized", "outage", "disconnected", "isolated", "closed", "inaccessible"]);

const TONES: Record<string, RGB> = {
  info: hexToRgb(TONE_HEX.info),
  warning: hexToRgb(TONE_HEX.warning),
  critical: hexToRgb(TONE_HEX.critical),
  success: hexToRgb(TONE_HEX.success),
};
const DIFF = { a: hexToRgb(DIFF_HEX.a), b: hexToRgb(DIFF_HEX.b), both: hexToRgb(DIFF_HEX.both) };
const ALT_GREEN = hexToRgb("#4ade80");
/** minor assets: dependency arcs into them stay quiet until focused */
const MINOR_TYPES = new Set(["intersection", "junction", "valve", "access_node", "switch"]);

/** Step lookups for a result (cached per result object). */
interface ResultIndex {
  nodeStep: Map<string, number>;
  affState: Map<string, NodeState>;
  edgeStep: Map<string, number>;
  altEdges: Set<string>;
  maxStep: number;
}
const resultCache = new WeakMap<SimulationResult, ResultIndex>();

export function indexResult(r: SimulationResult): ResultIndex {
  const hit = resultCache.get(r);
  if (hit) return hit;
  const nodeStep = new Map<string, number>();
  const affState = new Map<string, NodeState>();
  const edgeStep = new Map<string, number>();
  for (const id of r.failed_nodes ?? []) nodeStep.set(id, 0);
  for (const id of r.failed_edges ?? []) edgeStep.set(id, 0);
  let maxStep = 0;
  for (const a of r.affected_nodes ?? []) {
    nodeStep.set(a.node_id, Math.min(nodeStep.get(a.node_id) ?? Infinity, a.step));
    affState.set(a.node_id, a.state);
    maxStep = Math.max(maxStep, a.step);
  }
  for (const ie of r.interrupted_edges ?? []) {
    edgeStep.set(ie.edge_id, Math.min(edgeStep.get(ie.edge_id) ?? Infinity, ie.step));
    maxStep = Math.max(maxStep, ie.step);
  }
  for (const s of r.cascade_steps ?? []) maxStep = Math.max(maxStep, s.step);
  const altEdges = new Set<string>();
  for (const p of r.alternative_paths ?? []) {
    // alternative paths illuminate once both their end points have been reached by the cascade
    const st = Math.max(nodeStep.get(p.from_node) ?? 0, nodeStep.get(p.to_node) ?? 0, 1);
    for (const eid of p.edge_ids) {
      altEdges.add(eid);
      if (!edgeStep.has(eid)) edgeStep.set(eid, Math.min(st, maxStep));
    }
  }
  const idx = { nodeStep, affState, edgeStep, altEdges, maxStep };
  resultCache.set(r, idx);
  return idx;
}

export function computeDisplay(geom: NetworkGeometry, s: DisplayInput): DisplayModel {
  const { layers, result, baseline, playback } = s;
  const diff = s.compareView === "diff" && !!s.comparison;
  const res = diff ? null : result;
  const ri = res ? indexResult(res) : null;
  const step = playback?.step ?? 0;

  // ---- focus sets
  let focusMode: DisplayModel["focusMode"] = "none";
  const focusNodes = new Set<string>();
  const focusEdges = new Set<string>();
  const upEdges = new Set<string>();
  const downEdges = new Set<string>();
  const depEdges = new Set<string>();
  let tone: RGB | null = null;
  const tr = s.traceVisible ? s.trace : null;
  if (diff) {
    focusMode = "diff";
  } else if (tr) {
    focusMode = "trace";
    focusNodes.add(tr.node_id);
    for (const h of [...tr.upstream, ...tr.downstream, ...tr.dependencies, ...tr.dependents]) focusNodes.add(h.node_id);
    for (const h of tr.upstream) if (h.via_edge_id) upEdges.add(h.via_edge_id);
    for (const h of tr.dependencies) if (h.via_edge_id) upEdges.add(h.via_edge_id);
    for (const h of tr.downstream) if (h.via_edge_id) downEdges.add(h.via_edge_id);
    for (const h of tr.dependents) if (h.via_edge_id) downEdges.add(h.via_edge_id);
    for (const id of tr.physical_edge_ids) focusEdges.add(id);
    for (const id of tr.dependency_edge_ids) {
      focusEdges.add(id);
      depEdges.add(id);
    }
    for (const path of tr.source_paths ?? []) {
      for (let i = 0; i < path.length; i++) {
        const id = path[i];
        if (geom.edgeIndex.has(id)) {
          upEdges.add(id);
          focusEdges.add(id);
        } else focusNodes.add(id);
      }
    }
    for (const id of focusEdges) {
      const g = geom.edges[geom.edgeIndex.get(id) ?? -1];
      if (g) {
        focusNodes.add(g.edge.source_node);
        focusNodes.add(g.edge.target_node);
      }
    }
  } else if (s.highlight && (s.highlight.node_ids.length || s.highlight.edge_ids.length)) {
    focusMode = "highlight";
    tone = TONES[s.highlight.tone] ?? TONES.info;
    for (const id of s.highlight.node_ids) focusNodes.add(id);
    for (const id of s.highlight.edge_ids) focusEdges.add(id);
  }

  // ---- diff sets
  const onlyA = new Set(diff ? s.comparison!.only_in_a : []);
  const onlyB = new Set(diff ? s.comparison!.only_in_b : []);
  const both = new Set(diff ? s.comparison!.in_both : []);
  const edgeA = new Set<string>();
  const edgeB = new Set<string>();
  if (diff) {
    const ca = s.comparison!.scenario_a;
    const cb = s.comparison!.scenario_b;
    for (const ie of ca?.interrupted_edges ?? []) if (BLOCKED.has(ie.state)) edgeA.add(ie.edge_id);
    for (const ie of cb?.interrupted_edges ?? []) if (BLOCKED.has(ie.state)) edgeB.add(ie.edge_id);
    // initiating failures count as affected even if the engine omitted them from the sets
    for (const id of ca?.failed_nodes ?? []) if (!onlyA.has(id) && !onlyB.has(id) && !both.has(id)) onlyA.add(id);
    for (const id of cb?.failed_nodes ?? []) {
      if (onlyA.has(id)) {
        onlyA.delete(id);
        both.add(id);
      } else if (!onlyB.has(id) && !both.has(id)) onlyB.add(id);
    }
  }

  // ---- nodes
  const nodes: NodeVisual[] = geom.nodes.map((g) => {
    const n = g.node;
    const visible = layers[n.system] !== false;
    let state: NodeState = (baseline?.node_states?.[n.id] as NodeState | undefined) ?? n.status ?? "operational";
    let st = -1;
    if (res && ri) {
      const rs = res.node_states?.[n.id];
      const at = ri.nodeStep.get(n.id);
      if (rs && rs !== "operational" && (at ?? 0) <= step) {
        state = rs;
        st = at ?? 0;
      } else if (at !== undefined && at <= step && !rs) {
        const as = ri.affState.get(n.id);
        if (as) {
          state = as;
          st = at;
        }
      }
    }
    const style = NODE_STATE_STYLES[state] ?? NODE_STATE_STYLES.operational;
    const impacted = style.impacted;
    let rgb: RGB = impacted ? nodeStateRgb(state) : systemRgb(n.system);
    let alpha = 1;
    let emphasis = 0;
    let halo: RGB | null = null;
    let pulse: Pulse = "none";
    if (impacted) {
      if (state === "failed") pulse = "fail";
      else if (state === "on_backup") pulse = "blink";
      else if (state === "outage" || state === "closed" || state === "inaccessible") pulse = "alert";
      halo = rgb;
    } else if (res) {
      alpha = 0.55; // unaffected elements recede while a cascade is on screen
    }
    if (diff) {
      if (both.has(n.id)) rgb = DIFF.both;
      else if (onlyA.has(n.id)) rgb = DIFF.a;
      else if (onlyB.has(n.id)) rgb = DIFF.b;
      else {
        alpha = 0.16;
        rgb = systemRgb(n.system);
      }
      if (alpha === 1) {
        emphasis = 1;
        halo = rgb;
      }
    } else if (focusMode === "trace") {
      if (focusNodes.has(n.id)) {
        emphasis = 1;
        alpha = 1;
      } else alpha = Math.min(alpha, 0.17);
    } else if (focusMode === "highlight") {
      if (focusNodes.has(n.id)) {
        emphasis = 1;
        alpha = 1;
        halo = tone;
      } else alpha = Math.min(alpha, 0.4);
    }
    if (s.selectedNodeId === n.id) {
      emphasis = 2;
      alpha = 1;
    }
    return { visible, rgb, alpha, state, impacted, emphasis, halo, pulse, step: st };
  });

  // ---- edges
  const flowsBase: Record<string, EdgeFlow> | null = baseline?.edge_flows ?? null;
  const flowsRes: Record<string, EdgeFlow> | null = res?.edge_flows ?? null;
  const edges: EdgeVisual[] = geom.edges.map((g) => {
    const e = g.edge;
    const sv = nodes[g.src];
    const dv = nodes[g.dst];
    const dep = g.cls === "dependency";
    let visible: boolean;
    if (dep) {
      visible = sv.visible && dv.visible && (s.showDependencies || depEdges.has(e.id) || focusEdges.has(e.id));
    } else {
      visible = layers[e.infrastructure_type] !== false && (!g.facility || layers.facility !== false);
    }
    let state: EdgeState = (baseline?.edge_states?.[e.id] as EdgeState | undefined) ?? e.status ?? "operational";
    let st = -1;
    if (res && ri) {
      const rs = res.edge_states?.[e.id];
      const at = ri.edgeStep.get(e.id);
      if (rs && rs !== "operational" && rs !== "normally_open" && (at ?? 0) <= step) {
        state = rs;
        st = at ?? 0;
      }
    }
    const style = EDGE_STATE_STYLES[state] ?? EDGE_STATE_STYLES.operational;
    const impacted = style.impacted;
    const sysRgb = systemRgb(g.system);
    let rgb: RGB = impacted ? edgeStateRgb(state) : sysRgb;
    const minorArc = dep && (MINOR_TYPES.has(geom.nodes[g.dst].node.type) || MINOR_TYPES.has(geom.nodes[g.src].node.type));
    let alpha = dep ? (minorArc ? 0.2 : 0.5) : g.cls === "corridor" ? 0.5 : 0.92;
    let widthMul = 1;
    let core = 0;
    let dashed = state === "normally_open";
    let pulse: Pulse = "none";
    let trace: EdgeVisual["trace"] = "none";
    if (state === "normally_open") alpha = 0.32;
    if (impacted) {
      if (state === "failed") {
        pulse = "fail";
        widthMul = 1.25;
      } else if (BLOCKED.has(state)) {
        alpha = 0.3;
        dashed = true;
      } else if (ALT.has(state)) {
        rgb = ALT_GREEN;
        alpha = 1;
        widthMul = 1.35;
        core = 0.35;
        dashed = false;
      }
    } else if (res) {
      const srcDark = sv.impacted && BLACK_NODE.has(sv.state);
      const dstDark = dv.impacted && BLACK_NODE.has(dv.state);
      alpha *= srcDark || dstDark ? 0.35 : 0.55;
    }

    // ---- flow
    let flow: FlowVisual | null = null;
    if (!dep && g.cls !== "corridor" && !BLOCKED.has(state)) {
      const endpointsDark = (sv.impacted && BLACK_NODE.has(sv.state)) || (dv.impacted && BLACK_NODE.has(dv.state));
      let f: EdgeFlow | undefined;
      if (impacted || endpointsDark) f = flowsRes?.[e.id] ?? flowsBase?.[e.id];
      else f = flowsBase?.[e.id] ?? (res && step >= (ri?.maxStep ?? 0) ? flowsRes?.[e.id] : undefined) ?? flowsRes?.[e.id];
      let dir = f ? Math.sign(f.direction) : 1;
      let util = f ? f.utilization : 0.5;
      if (endpointsDark && !ALT.has(state)) dir = 0;
      if (ALT.has(state) && dir === 0) {
        dir = 1;
        util = 0.9;
      }
      if (dir !== 0) {
        const alt = ALT.has(state);
        flow = {
          dir: dir as -1 | 1,
          utilization: Math.max(0.05, Math.min(1, util || 0.4)),
          speedMul: alt ? 1.8 : 1,
          sizeMul: alt ? 1.35 : 1,
          alpha: alt ? 1 : 0.9,
          rgb: alt ? ALT_GREEN : sysRgb,
          twoWay: e.infrastructure_type === "transport" && !e.directed,
        };
      }
    }

    // ---- focus / diff
    if (diff) {
      flow = null;
      const ia = edgeA.has(e.id);
      const ib = edgeB.has(e.id);
      if (ia || ib) {
        rgb = ia && ib ? DIFF.both : ia ? DIFF.a : DIFF.b;
        alpha = 1;
        widthMul = 1.3;
        dashed = false;
        pulse = "none";
      } else {
        const touch = (x: string) => onlyA.has(x) || onlyB.has(x) || both.has(x);
        alpha = dep && touch(e.source_node) && touch(e.target_node) ? 0.35 : 0.1;
        rgb = sysRgb;
        pulse = "none";
      }
    } else if (focusMode === "trace") {
      if (upEdges.has(e.id) || downEdges.has(e.id) || focusEdges.has(e.id)) {
        trace = depEdges.has(e.id) ? "dep" : upEdges.has(e.id) ? "up" : downEdges.has(e.id) ? "down" : "up";
        alpha = 1;
        // upstream (toward sources) = white-hot core; downstream = pure system colour
        widthMul = Math.max(widthMul, trace === "up" ? 1.6 : 1.2);
        core = trace === "up" ? 1 : 0;
        if (trace === "dep") visible = sv.visible || dv.visible;
        if (flow) {
          flow = { ...flow, sizeMul: flow.sizeMul * 1.2, speedMul: flow.speedMul * 1.1 };
        }
      } else {
        alpha = Math.min(alpha, 0.14);
        flow = null;
      }
    } else if (focusMode === "highlight") {
      if (focusEdges.has(e.id)) {
        rgb = tone ?? rgb;
        alpha = 1;
        widthMul = 1.5;
        core = 0.4;
      } else {
        alpha = Math.min(alpha, 0.38);
        if (flow) flow = { ...flow, alpha: flow.alpha * 0.45 };
      }
    }
    if (s.selectedEdgeId === e.id) {
      alpha = 1;
      widthMul = Math.max(widthMul, 1.7);
      core = Math.max(core, 0.9);
    }
    if (dep && trace === "none" && !diff) {
      // dependency arcs read as logical links, never as solid lines
      dashed = true;
    }
    return { visible, rgb, alpha, widthMul, core, state, impacted, dashed, pulse, flow, trace, step: st };
  });

  return { nodes, edges, focusMode, resultActive: !!res, diff };
}

/** Power areas that are dark in the displayed result (for building blackout). */
export const BLACKOUT_STATES = BLACK_NODE;
export { WHITE };
