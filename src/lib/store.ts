"use client";
/**
 * DEEPTRACE application state (zustand).
 *
 * The store is the single coordination point between the 3D world and the interface:
 * the world controller subscribes to view/selection/simulation state and re-renders;
 * panels read and mutate it through the actions below. Camera moves go through
 * `world()` from engine/worldBridge.
 */
import { create } from "zustand";
import {
  ApiError,
  emptyScenario,
  liveApi,
  loadOfflineBundle,
  sameScenario,
  snapshotCompare,
  snapshotSimulate,
  streamAnalyst,
} from "@/lib/api";
import { world } from "@/engine/worldBridge";
import type {
  AnalystEvent,
  DemoScript,
  DemoSnapshot,
  HealthStatus,
  InfrastructureEdge,
  InfrastructureNetwork,
  InfrastructureNode,
  NetworkMetrics,
  NodeDetails,
  ScenarioComparison,
  ScenarioInput,
  ScenarioPreset,
  SimulationResult,
  SystemType,
  TraceResult,
  UIAction,
} from "@/types/infrastructure";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LayerKey = SystemType;
export type PanelKey = "layers" | "inspector" | "simulation" | "analyst" | "comparison" | "provenance" | "search";
export type DataMode = "loading" | "live" | "snapshot" | "error";
export type SimSlot = "active" | "A" | "B";

export interface NetworkIndex {
  nodes: Map<string, InfrastructureNode>;
  edges: Map<string, InfrastructureEdge>;
  /** node id -> incident edge ids (physical + dependency) */
  incident: Map<string, string[]>;
  bySystem: Map<SystemType, InfrastructureNode[]>;
}

export interface Highlight {
  node_ids: string[];
  edge_ids: string[];
  label: string | null;
  tone: "info" | "warning" | "critical" | "success";
  source: "ai" | "search" | "user" | "demo";
}

export interface ToolActivity {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "ok" | "error";
  summary?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: ToolActivity[];
  mode?: "llm" | "offline" | null;
  model?: string | null;
  /** Why the analyst is in its current mode, e.g. "No ANTHROPIC_API_KEY configured" */
  note?: string | null;
  pending?: boolean;
  error?: string | null;
}

export interface WorldStatus {
  status: "loading" | "ready" | "error";
  buildings: "loading" | "ion-osm" | "unavailable";
  terrain: "loading" | "ion-world" | "ellipsoid";
  imagery: string;
  message: string | null;
  ionToken: boolean;
}

export interface Playback {
  step: number;
  maxStep: number;
  playing: boolean;
  /** increments whenever a new cascade animation should start from the beginning */
  runId: number;
}

export interface DeeptraceState {
  // ---- data
  dataMode: DataMode;
  dataError: string | null;
  health: HealthStatus | null;
  network: InfrastructureNetwork | null;
  index: NetworkIndex | null;
  baseline: SimulationResult | null;
  metrics: NetworkMetrics | null;
  presets: ScenarioPreset[];
  demoScript: DemoScript | null;
  snapshot: DemoSnapshot | null;

  // ---- world
  worldStatus: WorldStatus;

  // ---- view
  layers: Record<LayerKey, boolean>;
  showDependencies: boolean;
  showParticles: boolean;
  showLabels: boolean;
  deepMode: boolean;
  /** Visual depth exaggeration for underground layers (1 = true scale) */
  depthScale: number;
  panels: Record<PanelKey, boolean>;
  /**
   * A right panel a demo step or a click on the map brings to the front (a new object on every request),
   * as openPanel does for the UI: its flag may already be on with the panel behind another one. The
   * interface focuses it.
   */
  panelFront: { key: "inspector" | "analyst" | "comparison" } | null;

  // ---- selection & tracing
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hoveredId: string | null;
  details: NodeDetails | null;
  detailsLoading: boolean;
  trace: TraceResult | null;
  traceVisible: boolean;
  highlight: Highlight | null;

  // ---- simulation
  draft: ScenarioInput;
  simStatus: "idle" | "running" | "error";
  simError: string | null;
  /** Result currently rendered in the world */
  result: SimulationResult | null;
  slots: { A: SimulationResult | null; B: SimulationResult | null };
  comparison: ScenarioComparison | null;
  compareStatus: "idle" | "running" | "error";
  /** When set, the world renders the comparison instead of a single result */
  compareView: "A" | "B" | "diff" | null;
  playback: Playback;

  // ---- analyst
  messages: ChatMessage[];
  analystPending: boolean;

  // ---- demo
  demo: { active: boolean; step: number; busy: boolean };

  // ---- actions
  bootstrap: () => Promise<void>;
  setWorldStatus: (patch: Partial<WorldStatus>) => void;

  setLayer: (key: LayerKey, value: boolean) => void;
  toggleLayer: (key: LayerKey) => void;
  setAllLayers: (value: boolean) => void;
  setShowDependencies: (v: boolean) => void;
  setShowParticles: (v: boolean) => void;
  setShowLabels: (v: boolean) => void;
  setDeepMode: (v: boolean, opts?: { fly?: boolean }) => void;
  setDepthScale: (v: number) => void;
  setPanel: (key: PanelKey, open: boolean) => void;
  togglePanel: (key: PanelKey) => void;

  selectNode: (id: string | null, opts?: { fly?: boolean; trace?: boolean }) => Promise<void>;
  selectEdge: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  /** `guard.isCurrent`: the caller's guard (the demo's trace step); once false, the response and its failure are dropped. */
  showTrace: (nodeId: string, guard?: { isCurrent: () => boolean }) => Promise<void>;
  hideTrace: () => void;
  setHighlight: (h: Highlight | null) => void;

  setDraft: (patch: Partial<ScenarioInput>) => void;
  toggleDraftNode: (id: string) => void;
  toggleDraftEdge: (id: string) => void;
  clearDraft: () => void;
  loadPreset: (presetId: string) => void;
  /** `opts.isCurrent`: the caller's guard (demo steps); once false, the response is dropped. */
  runSimulation: (
    scenario?: ScenarioInput,
    slot?: SimSlot,
    opts?: { isCurrent?: () => boolean },
  ) => Promise<SimulationResult | null>;
  setPlaybackStep: (step: number) => void;
  setPlaying: (playing: boolean) => void;
  replayCascade: () => void;
  showSlot: (slot: "A" | "B") => void;
  runComparison: (
    a?: ScenarioInput,
    b?: ScenarioInput,
    opts?: { isCurrent?: () => boolean },
  ) => Promise<ScenarioComparison | null>;
  setCompareView: (v: "A" | "B" | "diff" | null) => void;
  /**
   * Leave the A/B diff view (it draws no playback, highlight or trace) for the slot holding `result`, or
   * no comparison view. `opts.showHighlight` (the highlight chip's "show"): a highlight an answer made
   * about its own comparison that does not describe `result` is shown on a slot of a scenario it compared.
   */
  leaveDiff: (opts?: { showHighlight?: boolean }) => void;
  /**
   * Where the highlight chip's "show" (leaveDiff with `showHighlight`) puts the highlight the A/B diff
   * hides: "here" (it describes the result under the diff), "A" / "B" (a slot of a scenario its answer
   * compared), or null (no result left that it describes: leaving the diff drops it, so the chip does not
   * offer "show").
   */
  highlightShowTarget: () => "here" | "A" | "B" | null;
  clearSimulation: () => void;
  restoreWorld: () => void;

  sendAnalystMessage: (text: string, opts?: { forceOffline?: boolean }) => Promise<void>;
  /** Abort the analyst answer that is streaming (keeps what has arrived so far). */
  stopAnalyst: () => void;
  clearChat: () => void;
  /**
   * Apply an analyst UI action. `turn` orders it at the moment its question was sent (see
   * AnalystTurn); without one it is treated as asked just now.
   */
  applyUIAction: (a: UIAction, turn?: AnalystTurn) => void;

  startDemo: () => void;
  exitDemo: () => void;
  resetDemo: () => void;
  demoGoto: (step: number) => Promise<void>;
  demoNext: () => Promise<void>;
  demoPrev: () => Promise<void>;
}

/**
 * An analyst answer is ordered at the moment its question was sent, on the same timeline as runs
 * and comparisons (its actions sit just after the question). Nothing you started before asking
 * replaces what the answer shows when it lands later. The answer is held back only by something
 * you started after asking that has already landed (the map, the comparison, or that slot); one
 * still in flight replaces the answer when it lands, and one that failed or was cancelled never
 * counts. Captured by sendAnalystMessage.
 */
export interface AnalystTurn {
  /** The request sequence number when the question was sent. */
  seq: number;
  /** The slots the analyst was given (its comparisons were computed from these). */
  slots: { A: SimulationResult | null; B: SimulationResult | null };
  /** The result on screen when the question was asked (what the answer is about). */
  asked: SimulationResult | null;
  /** Results the answer put on the map itself (shown simulations, a result its comparison moved to). */
  shown: SimulationResult[];
  /** Results this answer's simulations produced (by identity, wherever they ended up). */
  own: WeakSet<SimulationResult>;
  /**
   * Scenarios this answer's comparisons compared. Any result of one of them is what the answer is
   * about, whichever object of it a slot holds (an older run of the same scenario that lands after
   * the comparison fills its slot as data and is no less what the comparison compared).
   */
  compared: ScenarioInput[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  water: true,
  power: true,
  telecom: true,
  transport: true,
  underground: true,
  facility: true,
};

const DEFAULT_PANELS: Record<PanelKey, boolean> = {
  layers: true,
  inspector: false,
  simulation: false,
  analyst: false,
  comparison: false,
  provenance: false,
  search: false,
};

/** Overlay and depth defaults; Restore world and the guided demo return to these. */
const DEFAULT_VIEW = { showDependencies: true, showParticles: true, showLabels: true, depthScale: 8 } as const;

export function buildIndex(network: InfrastructureNetwork): NetworkIndex {
  const nodes = new Map<string, InfrastructureNode>();
  const edges = new Map<string, InfrastructureEdge>();
  const incident = new Map<string, string[]>();
  const bySystem = new Map<SystemType, InfrastructureNode[]>();
  for (const n of network.nodes) {
    nodes.set(n.id, n);
    incident.set(n.id, []);
    const arr = bySystem.get(n.system) ?? [];
    arr.push(n);
    bySystem.set(n.system, arr);
  }
  for (const e of network.edges) {
    edges.set(e.id, e);
    incident.get(e.source_node)?.push(e.id);
    incident.get(e.target_node)?.push(e.id);
  }
  return { nodes, edges, incident, bySystem };
}

const uid = () => Math.random().toString(36).slice(2, 10);

const maxStepOf = (r: SimulationResult | null) =>
  r ? Math.max(0, ...r.cascade_steps.map((s) => s.step), ...r.affected_nodes.map((a) => a.step)) : 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a direct-connections-only TraceResult from the network when no engine trace exists
 * (backend offline and the node was not precomputed in the snapshot). Physical edges are
 * undirected in the data, so neighbours are NOT labelled upstream/downstream here; they are
 * returned through `physical_edge_ids` and shown as "directly connected".
 */
function localTrace(index: NetworkIndex, nodeId: string): TraceResult & { neighbours: string[] } {
  const physical: string[] = [];
  const dependency: string[] = [];
  const dependencies: TraceResult["dependencies"] = [];
  const dependents: TraceResult["dependents"] = [];
  const neighbours: TraceResult["upstream"] = [];
  for (const eid of index.incident.get(nodeId) ?? []) {
    const e = index.edges.get(eid)!;
    const other = e.source_node === nodeId ? e.target_node : e.source_node;
    const otherNode = index.nodes.get(other);
    if (!otherNode) continue;
    if (e.relation === "dependency") {
      dependency.push(eid);
      const hop = { node_id: other, via_edge_id: eid, depth: 1, relation: e.relation, system: otherNode.system };
      if (e.target_node === nodeId) dependencies.push(hop);
      else dependents.push(hop);
    } else {
      physical.push(eid);
      neighbours.push({ node_id: other, via_edge_id: eid, depth: 1, relation: e.relation, system: otherNode.system });
    }
  }
  return {
    node_id: nodeId,
    upstream: [],
    downstream: [],
    dependencies,
    dependents,
    physical_edge_ids: physical,
    dependency_edge_ids: dependency,
    source_paths: [],
    summary:
      "Direct connections only (offline snapshot; this component's full upstream/downstream trace was not precomputed — start the engine to trace it).",
    neighbours: neighbours.map((h) => h.node_id),
  };
}

/**
 * The A/B diff view draws no cascade playback, highlight or trace. When one of those is asked for
 * while the diff is shown, the map switches to this view: the slot that holds `result` (by identity
 * or scenario id), or no comparison view at all.
 */
export function viewOutsideDiff(s: Pick<DeeptraceState, "result" | "slots">): "A" | "B" | null {
  const r = s.result;
  if (!r) return null;
  if (s.slots.A === r || s.slots.A?.scenario_id === r.scenario_id) return "A";
  if (s.slots.B === r || s.slots.B?.scenario_id === r.scenario_id) return "B";
  return null;
}

/** An engine request that never reached the engine (network failure / timeout, no HTTP status). */
const engineUnreachable = (e: unknown) => e instanceof ApiError && e.status === undefined;

/**
 * The tool rows of an analyst answer that is over (stopped, failed or finished): a tool call that never
 * got its result (the answer was stopped, or its stream ended mid-tool) is settled as an error with
 * `summary`, so no row keeps its spinner.
 */
const settleTools = (tools: ToolActivity[], summary: string): ToolActivity[] =>
  tools.some((t) => t.status === "running")
    ? tools.map((t) => (t.status === "running" ? { ...t, status: "error" as const, summary } : t))
    : tools;

/**
 * Results answered from the offline snapshot, by identity. A result's "precomputed" label follows
 * where it came from, not the current dataMode, which a mid-session failover or recovery can flip.
 */
const snapshotResults = new WeakSet<SimulationResult>();
export const isSnapshotResult = (r: SimulationResult) => snapshotResults.has(r);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStore = create<DeeptraceState>((set, get, api) => {
  // -------------------------------------------------------------------------
  // Async bookkeeping. Every async action captures a token before it awaits and drops its
  // response when the token moved on, so a slow response can never resurrect state that a
  // newer action (or Restore world / Reset demo) already replaced.
  // -------------------------------------------------------------------------
  /**
   * Bumped by restoreWorld / clearSimulation: in-flight simulate/compare results are dropped.
   * (A demo step's own runs are dropped by its guard when the step is superseded or exited.)
   */
  let simEpoch = 0;
  /**
   * One timeline for runs, comparisons and analyst questions: every request takes the next number
   * (an analyst answer's actions are ordered at its question's number + 0.5).
   */
  let reqSeq = 0;
  /** Newest run requested: owns `simStatus`, and only it may put its result on the map. */
  let simSeq = 0;
  /** Newest request that may write each slot (a run, or an analyst answer's slot write). */
  const slotSeq: Record<"A" | "B", number> = { A: 0, B: 0 };
  /** Request number of what each slot holds now. */
  const slotWriteSeq: Record<"A" | "B", number> = { A: 0, B: 0 };
  /** Newest comparison requested: owns `compareStatus` and is the only one that may land. */
  let compareSeq = 0;
  /** Request number of the comparison stored now. */
  let comparisonSeq = 0;
  /**
   * Request number of what the map shows (a run's result, or a comparison's A/B diff). Something
   * requested earlier never takes the map back when it lands later.
   */
  let displaySeq = 0;
  /**
   * The slot run (Run as A / Run as B) whose result took the map last (numbered `displaySeq`), or
   * null when something else took it since: an active run, a comparison or an analyst answer.
   */
  let displaySlotRun: { slot: "A" | "B"; result: SimulationResult } | null = null;
  /**
   * Where the latest analyst answer that put its simulation on the map sits on the request timeline (its
   * question + 0.5). It supersedes the runs requested before that question: they no longer take the map,
   * and one that no longer fills its slot either is dropped when it lands, its failure too.
   */
  let answerSimSeq = 0;
  /**
   * Where the latest trace put on the map sits on the request timeline: an analyst answer's (its
   * question + 0.5) or the demo's trace step's (its own number). A comparison requested before it
   * lands without taking the diff view over that trace.
   */
  let viewSeq = 0;
  /** Slot k holds an analyst answer's write (question + 0.5) for a question asked before request `seq`. */
  const olderAnswerWrite = (k: "A" | "B", seq: number) => slotWriteSeq[k] % 1 !== 0 && slotWriteSeq[k] < seq;
  /** Slot k still holds the scenario the stored comparison compared on that side (it is not stale there). */
  const showsComparedScenario = (k: "A" | "B") => {
    const { comparison: c, slots } = get();
    const cur = slots[k];
    return !!c && !!cur && sameScenario(cur.scenario, (k === "A" ? c.scenario_a : c.scenario_b).scenario);
  };
  /**
   * Request number of the stored comparison if slot k showed what it compared when it landed (0: it
   * did not). The comparison holds that slot against analyst answers to questions asked before it,
   * even after a run requested before the comparison has filled the slot since (as data only); a
   * newer write to the slot (a later run, an answer's own write) or the next comparison ends it.
   */
  const cmpHold: Record<"A" | "B", number> = { A: 0, B: 0 };
  /** The comparison numbered `seq` was just stored: it holds the slots that show what it compared. */
  const holdComparedSlots = (seq: number) => {
    for (const k of ["A", "B"] as const) cmpHold[k] = showsComparedScenario(k) ? seq : 0;
  };
  /**
   * Runs still in flight, so an analyst answer (or the demo's Compare step) can tell whether a pending
   * run still matters. A run leaves it as soon as it lands or fails, before its own updates.
   */
  const liveRuns = new Map<number, { slot: SimSlot; alive: () => boolean }>();
  /**
   * The caller's guard of the latest simulation / comparison (demo steps pass theirs). A run whose
   * guard turned false is dropped when it lands; settleCancelledRuns clears its spinner right away.
   */
  let latestSimGuard: (() => boolean) | undefined;
  let latestCompareGuard: (() => boolean) | undefined;
  /** Bumped by supersedeTraces (showTrace / hideTrace / deselect / an analyst show_trace) and by restore. */
  let traceSeq = 0;
  /** The traceSeq the latest follow-trace took (selectNode tracing the component it selected, as the trace shown followed it). */
  let followTraceSeq = 0;
  /** Bumped by every selectNode call (also of the component already selected): only the newest call's details count. */
  let selectCalls = 0;
  /**
   * Bumped when the selection moves off a component (to another one, a connection or none): the trace
   * requests made before it are superseded, so their result and their failure are dropped when they land.
   */
  let selectionSeq = 0;
  /**
   * A failure the error toast (`simError`) reports: `seq` places its request on the request timeline
   * (a trace takes no request number: it sits after the requests made before it). Kind "check" is the
   * demo Compare step's "Run two scenarios" message: it sits where the step's Compare would have.
   */
  type ReportedError = {
    seq: number;
    kind: "run" | "slot" | "compare" | "trace" | "check";
    message: string;
    /** A slot run's failure: its slot, and (kind "run") the engine's message without the slot prefix. */
    slot?: "A" | "B";
    raw?: string;
  };
  /**
   * The failures the toast reports, oldest request first: it shows the newest request's failure,
   * whichever landed last. All are forgotten once the toast no longer shows that one (dismissed,
   * cleared by a new request or Restore world, or replaced by another message).
   */
  let reportedErrors: ReportedError[] = [];
  /**
   * Request number of the last Compare whose failure was reported (setting compareStatus "error");
   * Restore world, which resets that status, sets it back to 0. An analyst answer that supersedes the
   * newest Compare settles an "error" status only when that Compare is the one that failed. (The "Run
   * two scenarios" message is no request's failure. It needs an empty slot, and only Restore world
   * empties slots, so it never follows a reported Compare failure that this still names.)
   */
  let compareErrorSeq = 0;
  const syncReportedErrors = () => {
    const shown = reportedErrors[reportedErrors.length - 1];
    if (!shown || get().simError !== shown.message) reportedErrors = [];
  };
  /** Report a request's failure (`patch` sets its status); the toast keeps a newer request's failure. */
  const reportError = (
    seq: number,
    kind: ReportedError["kind"],
    message: string,
    patch: Partial<DeeptraceState> = {},
    about: Pick<ReportedError, "slot" | "raw"> = {},
  ) => {
    syncReportedErrors();
    // a stable sort: of two failures at the same point on the timeline, the one that landed last shows
    reportedErrors = [...reportedErrors, { seq, kind, message, ...about }].sort((x, y) => x.seq - y.seq);
    set({ ...patch, simError: reportedErrors[reportedErrors.length - 1].message });
  };
  /**
   * Something (an analyst answer, or a newer trace action) superseded these requests: had they failed
   * after it, their failure would have been dropped, so one that already failed comes off the toast
   * too (the newest other failure it reports shows instead). Returns the patch for the caller's set().
   */
  const retractErrors = (drop: (e: ReportedError) => boolean): Partial<DeeptraceState> => {
    syncReportedErrors();
    if (!reportedErrors.some(drop)) return {};
    reportedErrors = reportedErrors.filter((e) => !drop(e));
    return { simError: reportedErrors[reportedErrors.length - 1]?.message ?? null };
  };
  /**
   * A demo step's run or Compare does not clear the toast: the step cleared it at the click, and when
   * it makes the request depends on what landed while it waited. It settles only the failures the new
   * request supersedes, as they would have been had they failed after it was made: an older run's
   * failure is dropped, or becomes its slot's failure while that run still owns its slot (a slot's
   * failure is dropped once a newer run took the slot); an older Compare's failure is dropped. Call it
   * once the request has taken its numbers (simSeq and slotSeq, or compareSeq). Returns the patch for
   * the caller's set().
   */
  const settleErrorsBehindDemoRequest = (kind: "run" | "compare"): Partial<DeeptraceState> => {
    syncReportedErrors();
    if (!reportedErrors.length) return {};
    /** The failed run is still the newest request for its slot. */
    const ownsSlot = (e: ReportedError) => !!e.slot && slotSeq[e.slot] === e.seq;
    const next: ReportedError[] = [];
    for (const e of reportedErrors) {
      if (kind === "compare") {
        if (e.kind !== "compare") next.push(e);
      } else if (e.kind === "run") {
        if (ownsSlot(e)) next.push({ ...e, kind: "slot", message: `Scenario ${e.slot} failed: ${e.raw}` });
      } else if (e.kind !== "slot" || ownsSlot(e)) next.push(e);
    }
    const shown = reportedErrors[reportedErrors.length - 1].message;
    reportedErrors = next;
    const now = next[next.length - 1]?.message ?? null;
    return now === shown ? {} : { simError: now };
  };
  /**
   * A newer trace request, Hide trace, a deselection or an analyst trace supersedes the traces before
   * it: one still in flight is dropped when it lands, so a failure one of them already reported comes
   * off the toast too. Returns the patch for the caller's set().
   */
  const supersedeTraces = (): Partial<DeeptraceState> => {
    traceSeq++;
    return retractErrors((e) => e.kind === "trace");
  };
  /** Bumped by every demoGoto and by start/reset/exit/restore: a superseded step stops at its next await. */
  let demoRun = 0;
  /**
   * Bumped by exitDemo: a trace a demo step requested that is still in flight is dropped when it lands.
   * (Moving to another step leaves it: the steps' own runs and comparisons are what a new step cancels.)
   */
  let demoExits = 0;
  /** The analyst request answering the demo's own question: Exit demo stops it while it streams. */
  let demoAnswer: AbortController | null = null;
  /** Layers the running reveal_layers demo step switched off and has not switched back on yet. */
  let pendingReveal: LayerKey[] = [];
  /** The analyst request currently streaming. */
  let analystCtrl: AbortController | null = null;
  /** Polls /api/health after a mid-session failover so the app returns to live mode when the engine is back. */
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Turns the layers an interrupted reveal_layers step had not revealed yet back on (synchronously). */
  const finishPendingReveal = () => {
    if (!pendingReveal.length) return;
    const keys = pendingReveal;
    pendingReveal = [];
    set((s) => {
      const layers = { ...s.layers };
      for (const k of keys) layers[k] = true;
      return { layers };
    });
  };

  /**
   * After an analyst answer took the map: if no run still in flight can put its result on the map
   * or fill its slot, its spinner goes away (its result would be dropped when it lands).
   */
  const settleRunsBehindAnswer = () => {
    if (get().simStatus !== "running") return;
    for (const [q, e] of liveRuns) {
      if (!e.alive()) continue;
      if (q === simSeq && q > displaySeq) return; // will still take the map
      if ((e.slot === "A" || e.slot === "B") && slotSeq[e.slot] === q) return; // will still fill its slot
    }
    set({ simStatus: "idle" });
  };

  /** A demo step was superseded or exited: its simulate / compare requests no longer show a spinner. */
  const settleCancelledRuns = () =>
    set((s) => ({
      simStatus: s.simStatus === "running" && latestSimGuard && !latestSimGuard() ? "idle" : s.simStatus,
      compareStatus:
        s.compareStatus === "running" && latestCompareGuard && !latestCompareGuard() ? "idle" : s.compareStatus,
    }));

  const scheduleRecovery = () => {
    if (recoveryTimer) return;
    recoveryTimer = setTimeout(async () => {
      recoveryTimer = null;
      if (get().dataMode !== "snapshot") return;
      try {
        const health = await liveApi.health();
        set({ dataMode: "live", health });
      } catch {
        scheduleRecovery();
      }
    }, 15000);
  };

  /**
   * The engine could not be reached mid-session. If a snapshot is loaded and /api/health is down
   * too, switch to snapshot mode (toolbar, panels and later calls all follow) and return true so
   * the caller answers from the precomputed engine outputs instead of failing.
   */
  async function failOverToSnapshot(e: unknown): Promise<boolean> {
    if (!engineUnreachable(e) || !get().snapshot) return false;
    if (get().dataMode !== "live") return true;
    try {
      await liveApi.health();
      return false; // the engine is up; this request itself failed (e.g. timed out)
    } catch {
      set({ dataMode: "snapshot", health: null });
      scheduleRecovery();
      return true;
    }
  }

  /** Simulate against the live engine or the offline snapshot. */
  async function simulate(scenario: ScenarioInput): Promise<SimulationResult> {
    if (get().dataMode === "live") {
      try {
        return await liveApi.simulate(scenario);
      } catch (e) {
        if (!(await failOverToSnapshot(e))) throw e;
      }
    }
    const snapshot = get().snapshot;
    if (snapshot) {
      const precomputed = snapshotSimulate(snapshot, scenario);
      if (precomputed) {
        // A new object per answer, as the live engine returns: slot writes are told apart by identity
        // (newerSlot), and the snapshot would otherwise answer a scenario with the same object every time.
        const r = { ...precomputed };
        snapshotResults.add(r);
        return r;
      }
    }
    throw new ApiError(
      "This scenario was not precomputed in the offline snapshot. Start the DEEPTRACE engine (backend) to run arbitrary scenarios.",
    );
  }

  async function compare(a: ScenarioInput, b: ScenarioInput): Promise<ScenarioComparison> {
    if (get().dataMode === "live") {
      try {
        return await liveApi.compare(a, b);
      } catch (e) {
        if (!(await failOverToSnapshot(e))) throw e;
      }
    }
    const snapshot = get().snapshot;
    if (snapshot) {
      const precomputed = snapshotCompare(snapshot, a, b);
      if (precomputed) {
        // new objects per answer, as from the live engine (see simulate)
        const c = { ...precomputed, scenario_a: { ...precomputed.scenario_a }, scenario_b: { ...precomputed.scenario_b } };
        snapshotResults.add(c.scenario_a);
        snapshotResults.add(c.scenario_b);
        return c;
      }
    }
    throw new ApiError("This comparison was not precomputed in the offline snapshot. Start the backend engine.");
  }

  /** Engine trace offline: the precomputed one from the snapshot, else direct connections only. */
  function offlineTrace(nodeId: string): TraceResult | null {
    const { snapshot, index } = get();
    return snapshot?.traces?.[nodeId] ?? (index ? localTrace(index, nodeId) : null);
  }

  /** Node details without the engine, built only from what the snapshot actually contains. */
  function offlineDetails(id: string): NodeDetails | null {
    const { index, snapshot, metrics, baseline } = get();
    const node = index?.nodes.get(id);
    if (!index || !node) return null;
    const local = localTrace(index, id);
    const pre = snapshot?.traces?.[id] ?? null;
    const rank = metrics?.criticality_ranking.findIndex((c) => c.node_id === id) ?? -1;
    const entry = rank >= 0 ? metrics!.criticality_ranking[rank] : null;
    const spofIds = snapshot?.spof_node_ids;
    return {
      node,
      connected_node_ids: [...new Set([...local.neighbours, ...local.dependencies.map((h) => h.node_id), ...local.dependents.map((h) => h.node_id)])],
      connected_edge_ids: [...local.physical_edge_ids, ...local.dependency_edge_ids],
      upstream_ids: pre ? pre.upstream.map((h) => h.node_id) : [],
      downstream_ids: pre ? pre.downstream.map((h) => h.node_id) : [],
      dependency_ids: (pre ?? local).dependencies.map((h) => h.node_id),
      dependent_ids: (pre ?? local).dependents.map((h) => h.node_id),
      criticality_rank: rank >= 0 ? rank + 1 : null,
      criticality_score: entry?.affected_count ?? null,
      // Only claimed when the snapshot exports the engine's SPOF set; otherwise unknown.
      is_single_point_of_failure: spofIds ? spofIds.includes(id) : null,
      baseline_state: baseline?.node_states[id] ?? "operational",
    };
  }

  /**
   * The recorded offline-analyst answer for this question, but only when it was asked about the
   * scenario it was recorded for (`asked`: the result on screen when the question was sent;
   * export_snapshot records it against the demo's scenario A).
   */
  function matchingReplay(question: string, asked: SimulationResult | null): AnalystEvent[] | null {
    const s = get();
    const events = s.snapshot?.analyst_replays?.[question];
    if (!events?.length) return null;
    const recordedFor = s.presets.find((p) => p.id === s.snapshot?.demo?.scenario_a_preset)?.scenario;
    if (!recordedFor || !asked || !sameScenario(asked.scenario, recordedFor)) return null;
    return events;
  }

  /** Abort the in-flight analyst request (if any) and settle its message. */
  function cancelAnalyst(reason: string) {
    endAnswer(); // also once the answer finished: Clear chat and Restore world end what it holds
    const ctrl = analystCtrl;
    if (!ctrl) return;
    analystCtrl = null;
    ctrl.abort(reason);
    set((s) => ({
      analystPending: false,
      messages: s.messages.map((m) =>
        m.pending ? { ...m, pending: false, tools: settleTools(m.tools, "Stopped"), error: m.error ?? reason } : m,
      ),
    }));
  }

  /** A highlight the user made for the previously shown result no longer applies to a new one. */
  const dropUserHighlight = (h: Highlight | null) => (h && h.source === "user" ? null : h);
  /** The analyst answer that set each AI highlight (by identity: two questions can share a request number). */
  const highlightTurn = new WeakMap<Highlight, AnalystTurn>();
  /** A new result an answer shows: only a highlight this same answer set describes it. */
  const keepTurnHighlight = (h: Highlight | null, t: AnalystTurn) => (h && highlightTurn.get(h) === t ? h : null);
  /** The result each AI highlight was drawn on (the result it describes). */
  const highlightBase = new WeakMap<Highlight, SimulationResult | null>();
  /** `r` is a result answer `t` produced: one of its simulations, or a result of a scenario it compared. */
  const answerProduced = (t: AnalystTurn, r: SimulationResult) =>
    t.own.has(r) || t.compared.some((sc) => sameScenario(sc, r.scenario));
  /** `r` is what answer `t` is about: the scenario it was asked about or showed, or a result it produced. */
  const answerDescribes = (t: AnalystTurn, r: SimulationResult) =>
    answerProduced(t, r) || [t.asked, ...t.shown].some((x) => !!x && (x === r || sameScenario(x.scenario, r.scenario)));
  /**
   * The latest answer, streaming or finished, until it is stopped, cleared or restored away or the next
   * question is asked: only its highlight can be held. (Its end is not a request: a request made before
   * asking that lands after the answer has ended treats its highlight as one landing before the end.)
   */
  let currentTurn: AnalystTurn | null = null;
  /**
   * Recorded answers replayed after a failover in place of the partial answer the engine was streaming:
   * they share its place on the timeline (its request number), not what it showed.
   */
  const replayTurns = new WeakSet<AnalystTurn>();
  /**
   * The current answer's highlight while the map shows a result the answer does not describe, which a
   * request made before asking (or a switch of slots) put there. It is not drawn there; but had that
   * request still been in flight, the highlight would be on the map and would follow the answer to the
   * next result the answer shows (keepTurnHighlight). So it does: the answer's next result of its own,
   * a request made before asking that brings a result the answer describes, or a switch to such a
   * result brings it back, whether the answer is still streaming or not. Anything that would have
   * replaced or dropped it on the map ends the hold: another highlight, the answer clearing its
   * highlights, a run or Compare requested after asking that takes the map, a switch to a result it
   * does not describe, the next question, Stop, Clear chat and Restore world.
   */
  let heldHighlight: { h: Highlight; t: AnalystTurn } | null = null;
  const holdHighlight = (h: Highlight, t: AnalystTurn) => {
    if (t === currentTurn) heldHighlight = { h, t };
  };
  /** The current answer is over for holding (stopped, cleared, restored, or the next question asked). */
  const endAnswer = () => {
    currentTurn = null;
    heldHighlight = null;
  };
  /** The highlight answer `t` keeps on a new result of its own: its highlight on the map, else its held one. */
  const turnHighlight = (cur: Highlight | null, t: AnalystTurn) => {
    const held = heldHighlight?.t === t ? heldHighlight.h : null;
    heldHighlight = null;
    return keepTurnHighlight(cur, t) ?? held;
  };
  /**
   * A run takes the map. An analyst highlight from an answer to a question asked after this run was
   * requested stays while that answer describes the run's result (nothing started before asking takes
   * the answer back), and is held while it does not; other highlights described the previous result.
   */
  const keepLaterAnswerHighlight = (h: Highlight | null, seq: number, r: SimulationResult) => {
    // a run requested after asking replaces the answer: its held highlight goes too
    if (heldHighlight && heldHighlight.t.seq < seq) heldHighlight = null;
    const t = h && h.source === "ai" ? highlightTurn.get(h) : undefined;
    if (h && t && t.seq >= seq) {
      if (answerDescribes(t, r)) return h;
      holdHighlight(h, t);
    }
    // an answer's highlight held off an earlier result comes back on one the answer describes
    const held = heldHighlight;
    if (held && answerDescribes(held.t, r)) {
      heldHighlight = null;
      return held.h;
    }
    return null;
  };
  /**
   * The user switches the map from `prev` to `r` (a slot chip, Show A / Show B, the demo's replay of
   * A). A user highlight described `prev`; an analyst highlight still describes `r` only if it was
   * drawn on that scenario or its answer produced `r` (a simulation of its own, or a result of a
   * scenario it compared). Other highlights (search, demo) are not tied to a result.
   */
  const highlightForView = (h: Highlight | null, prev: SimulationResult | null, r: SimulationResult) => {
    if (!h || r === prev) return h;
    if (h.source === "user") return null;
    if (h.source !== "ai") return h;
    const base = highlightBase.get(h);
    if (base && sameScenario(base.scenario, r.scenario)) return h;
    const t = highlightTurn.get(h);
    return t && answerProduced(t, r) ? h : null;
  };
  /**
   * AI highlights an answer made under its own A/B diff, or held off an older result and brought back by
   * that diff: about its comparison, not the result under the diff.
   */
  const diffHighlights = new WeakSet<Highlight>();
  /** A highlight an answer held off an older result, back under that answer's own diff (see highlightOffDiff). */
  const heldOwnBack = (h: Highlight | null) => {
    if (h) diffHighlights.add(h);
    return h;
  };
  /**
   * `h` once the map leaves the A/B diff for `r`, the result under it. A highlight an answer made about
   * its own comparison stays only if the answer describes `r` (a run requested before asking may have put
   * `r` there while the answer was coming). Otherwise it is not drawn on `r`: with `hold` it is held for
   * the current answer (its next result of its own, or a result it describes, brings it back).
   */
  function highlightOffDiff(h: Highlight | null, r: SimulationResult | null, hold: boolean) {
    if (!h || !r || !diffHighlights.has(h)) return h;
    const t = highlightTurn.get(h);
    if (!t || answerDescribes(t, r)) return h;
    if (hold) holdHighlight(h, t);
    return null;
  }
  /** See DeeptraceState.highlightShowTarget: the search leaveDiff's `showHighlight` makes (no side effects). */
  const showTarget = (s: DeeptraceState): "here" | "A" | "B" | null => {
    const h = s.highlight;
    if (!h) return null;
    if (highlightOffDiff(h, s.result, false)) return "here";
    // the highlight does not describe the result under the diff: a slot of a scenario its answer compared
    // (as Show A / Show B would)
    return (
      (["A", "B"] as const).find((k) => {
        const r = s.slots[k];
        return !!r && r !== s.result && highlightForView(h, s.result, r) === h;
      }) ?? null
    );
  };
  /**
   * The same view switch, with a held answer highlight (which would have replaced the one on the map):
   * it comes back if it describes `r`, and the hold ends either way. A switch to the result already shown
   * (the chip of the slot on screen) changes nothing: the highlight stays, and so does the hold (on the
   * map the held one would have stayed too); only the diff may be left (see highlightOffDiff).
   */
  const viewHighlight = (h: Highlight | null, prev: SimulationResult | null, r: SimulationResult) => {
    if (r === prev) return highlightOffDiff(h, r, false);
    const held = heldHighlight;
    heldHighlight = null;
    return held ? highlightForView(held.h, null, r) : highlightForView(h, prev, r);
  };

  /**
   * State for a new comparison. Slot objects the UI already holds are kept when they are the
   * compared scenarios, and `result` follows its slot, so the displayed result stays identifiable
   * as A or B (the A/B chips compare by identity). A slot in `keep` was filled by a newer write
   * while the comparison ran: it belongs to that write and is kept as it is (the comparison panel
   * then shows "Slots changed since this comparison" instead of the older run coming back).
   */
  /** Slot objects a comparison put there (the user's or an analyst show_comparison): not a newer run. */
  const comparisonFilled = new WeakSet<SimulationResult>();
  /**
   * The slot now holds a newer write than `base` (the slot when a comparison's data was taken): a
   * run or an analyst show_simulation. Failed or cancelled runs leave the slot untouched, and a slot
   * another comparison filled does not count (the new comparison replaces it anyway).
   */
  const newerSlot = (base: SimulationResult | null, cur: SimulationResult | null) =>
    cur !== base && !(cur && comparisonFilled.has(cur));

  function adoptComparison(
    s: DeeptraceState,
    c: ScenarioComparison,
    keep: { A: boolean; B: boolean } = { A: false, B: false },
    /** Something requested later than this comparison owns the map: store it without its diff view. */
    keepView = false,
    /**
     * A run the diff would hide owns the map (see runComparison): store this without its diff view,
     * although the shown result still follows its slot.
     */
    heldOff = false,
    /**
     * An analyst answer's comparison: for a slot that a request numbered before the question has filled
     * since (as data only: it never took the map), the object the slot held when the analyst was given
     * it. The shown result follows that slot as given, as it does when that request lands after this.
     */
    given: { A?: SimulationResult; B?: SimulationResult } = {},
  ): {
    patch: Partial<DeeptraceState>;
    tookView: boolean;
    /** Without `keepView` it would take the diff view or move the shown result to another scenario. */
    wouldDraw: boolean;
  } {
    const compared = { A: c.scenario_a, B: c.scenario_b };
    const pick = (k: "A" | "B") => {
      const cur = s.slots[k];
      return cur && (keep[k] || sameScenario(cur.scenario, compared[k].scenario)) ? cur : compared[k];
    };
    const A = pick("A");
    const B = pick("B");
    if (A !== s.slots.A) comparisonFilled.add(A);
    if (B !== s.slots.B) comparisonFilled.add(B);
    const followGiven = (k: "A" | "B") => {
      const g = given[k];
      return g && s.result === g ? (sameScenario(g.scenario, compared[k].scenario) ? g : compared[k]) : undefined;
    };
    const followed =
      followGiven("A") ??
      followGiven("B") ??
      (s.result && s.result === s.slots.A ? A : s.result && s.result === s.slots.B ? B : s.result);
    // Something requested later owns the map: this comparison stores its data (slots, comparison)
    // and the shown result stays, with its highlight and trace. An A/B chip follows its slot.
    const result = keepView ? s.result : followed;
    const moved = result !== s.result && result !== null;
    // don't swap the map from a newer run to the diff of an older comparison
    const tookView = !heldOff && !keepView;
    const followedElsewhere =
      !!followed && !!s.result && followed !== s.result && !sameScenario(followed.scenario, s.result.scenario);
    return {
      tookView,
      wouldDraw: !heldOff || followedElsewhere,
      patch: {
        comparison: c,
        compareView: tookView
          ? "diff"
          : keepView && (s.compareView === "A" || s.compareView === "B")
            ? viewOutsideDiff({ result, slots: { A, B } })
            : s.compareView,
        slots: { A, B },
        result,
        panels: { ...s.panels, comparison: true },
        ...(moved
          ? {
              // the displayed result changed: its playback range and any user highlight are stale
              highlight: dropUserHighlight(s.highlight),
              playback: {
                step: maxStepOf(result),
                maxStep: maxStepOf(result),
                playing: false,
                runId: s.playback.runId + 1,
              },
            }
          : {}),
      },
    };
  }

  /** Resolves once `pred()` holds (re-checked on every store update). */
  const waitUntil = (pred: () => boolean) =>
    new Promise<void>((resolve) => {
      if (pred()) return resolve();
      const unsub = api.subscribe(() => {
        if (pred()) {
          unsub();
          resolve();
        }
      });
    });

  const patchMessage = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) }));

  return {
    dataMode: "loading",
    dataError: null,
    health: null,
    network: null,
    index: null,
    baseline: null,
    metrics: null,
    presets: [],
    demoScript: null,
    snapshot: null,

    worldStatus: {
      status: "loading",
      buildings: "loading",
      terrain: "loading",
      imagery: "loading",
      message: null,
      ionToken: false,
    },

    layers: { ...DEFAULT_LAYERS },
    ...DEFAULT_VIEW,
    deepMode: false,
    panels: { ...DEFAULT_PANELS },
    panelFront: null,

    selectedNodeId: null,
    selectedEdgeId: null,
    hoveredId: null,
    details: null,
    detailsLoading: false,
    trace: null,
    traceVisible: false,
    highlight: null,

    draft: emptyScenario(),
    simStatus: "idle",
    simError: null,
    result: null,
    slots: { A: null, B: null },
    comparison: null,
    compareStatus: "idle",
    compareView: null,
    playback: { step: 0, maxStep: 0, playing: false, runId: 0 },

    messages: [],
    analystPending: false,

    demo: { active: false, step: 0, busy: false },

    // ------------------------------------------------------------------ data
    bootstrap: async () => {
      set({ dataMode: "loading", dataError: null });
      try {
        const health = await liveApi.health();
        const [network, baseline, presets, demoScript] = await Promise.all([
          liveApi.network(),
          liveApi.baseline(),
          liveApi.presets(),
          liveApi.demoScript(),
        ]);
        set({
          health,
          network,
          index: buildIndex(network),
          baseline,
          presets,
          demoScript,
          dataMode: "live",
        });
        // Metrics (N-1 ranking) can take a moment; load in the background.
        liveApi
          .metrics()
          .then((metrics) => set({ metrics }))
          .catch(() => {});
        // Snapshot is still useful as a safety net for demo mode; load quietly.
        loadOfflineBundle()
          .then(({ snapshot }) => {
            if (snapshot) set({ snapshot });
          })
          .catch(() => {});
        return;
      } catch {
        // fall through to snapshot
      }
      try {
        const { network, snapshot } = await loadOfflineBundle();
        set({
          health: null,
          network,
          index: buildIndex(network),
          baseline: snapshot?.baseline ?? null,
          metrics: snapshot?.metrics ?? null,
          presets: snapshot?.presets ?? [],
          demoScript: snapshot?.demo ?? null,
          snapshot,
          dataMode: "snapshot",
        });
      } catch (e) {
        set({ dataMode: "error", dataError: (e as Error).message });
      }
    },

    setWorldStatus: (patch) => set((s) => ({ worldStatus: { ...s.worldStatus, ...patch } })),

    // ------------------------------------------------------------------ view
    setLayer: (key, value) => set((s) => ({ layers: { ...s.layers, [key]: value } })),
    toggleLayer: (key) => set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),
    setAllLayers: (value) =>
      set({
        layers: {
          water: value,
          power: value,
          telecom: value,
          transport: value,
          underground: value,
          facility: value,
        },
      }),
    setShowDependencies: (v) => set({ showDependencies: v }),
    setShowParticles: (v) => set({ showParticles: v }),
    setShowLabels: (v) => set({ showLabels: v }),
    setDeepMode: (v, opts) => {
      set({ deepMode: v });
      if (opts?.fly) {
        if (v) world().flyToDeepView();
        else world().flyHome();
      }
    },
    setDepthScale: (v) => set({ depthScale: Math.min(30, Math.max(1, v)) }),
    setPanel: (key, open) => set((s) => ({ panels: { ...s.panels, [key]: open } })),
    togglePanel: (key) => set((s) => ({ panels: { ...s.panels, [key]: !s.panels[key] } })),

    // ------------------------------------------------------------------ selection
    selectNode: async (id, opts) => {
      const call = ++selectCalls;
      if (!id) {
        selectionSeq++;
        set({ selectedNodeId: null, details: null, trace: null, traceVisible: false, ...supersedeTraces() });
        return;
      }
      // Moving the selection to another component supersedes the trace requests made before it: one still
      // in flight is dropped when it lands (also its failure), and a failure one already reported comes off
      // the toast.
      const moved = id !== get().selectedNodeId;
      if (moved) selectionSeq++;
      const retracted = moved ? retractErrors((e) => e.kind === "trace") : {};
      set((s) => ({
        selectedNodeId: id,
        selectedEdgeId: null,
        details: null,
        detailsLoading: true,
        panels: { ...s.panels, inspector: true },
        ...retracted,
      }));
      /** Trace actions so far: the trace follows this selection only if none is taken before its details land. */
      const tracesAtClick = traceSeq;
      if (opts?.fly) world().flyToNode(id);
      let details: NodeDetails | null = null;
      if (get().dataMode === "live") {
        try {
          details = await liveApi.nodeDetails(id);
        } catch (e) {
          if (await failOverToSnapshot(e)) details = offlineDetails(id);
        }
      } else details = offlineDetails(id);
      // A newer selection superseded this one: another component, a connection, a deselect, or a newer
      // click on this same component (only the newest call's details count, whichever lands last).
      if (call !== selectCalls || get().selectedNodeId !== id) return;
      set({ details, detailsLoading: false });
      if (opts?.trace) await get().showTrace(id);
      // The trace on screen follows the selection as of the click: a trace requested, shown by an analyst
      // answer or hidden since then is newer than the click, whether it landed before these details or after.
      else if (traceSeq === tracesAtClick && get().traceVisible && get().trace?.node_id !== id) {
        const follow = get().showTrace(id);
        followTraceSeq = traceSeq; // showTrace took its number before its first await
        await follow;
      }
    },
    selectEdge: (id) => {
      // clicking a connection moves the selection off the component (see selectNode)
      const moved = !!id && !!get().selectedNodeId;
      if (moved) selectionSeq++;
      const retracted = moved ? retractErrors((e) => e.kind === "trace") : {};
      set((s) => ({
        selectedEdgeId: id,
        selectedNodeId: id ? null : s.selectedNodeId,
        details: id ? null : s.details,
        panels: id ? { ...s.panels, inspector: true } : s.panels,
        ...retracted,
      }));
    },
    setHovered: (id) => {
      if (get().hoveredId !== id) set({ hoveredId: id });
    },
    showTrace: async (nodeId, guard) => {
      // A new trace request (also selectNode's follow-trace and the demo's trace step) supersedes the
      // earlier ones: a failure one of them already reported comes off the toast now.
      const retracted = supersedeTraces();
      const seq = traceSeq;
      const selectionAt = selectionSeq;
      if ("simError" in retracted) set(retracted);
      /** Where a failure of this trace sits on the request timeline: after the requests made before it. */
      const at = reqSeq + 0.5;
      /**
       * A newer trace request, a hide, or the selection moving off this component (even if it was selected
       * again since) supersedes this request, and so does the caller's guard turning false (the demo was
       * exited): its response and its failure are both dropped.
       */
      const superseded = () =>
        seq !== traceSeq || selectionSeq !== selectionAt || get().selectedNodeId !== nodeId || (!!guard && !guard.isCurrent());
      try {
        let trace: TraceResult | null;
        if (get().dataMode === "live") {
          try {
            trace = await liveApi.trace(nodeId);
          } catch (e) {
            if (!(await failOverToSnapshot(e))) throw e;
            trace = offlineTrace(nodeId);
          }
        } else trace = offlineTrace(nodeId);
        if (superseded()) return;
        if (trace) set({ trace, traceVisible: true });
      } catch (e) {
        if (!superseded()) reportError(at, "trace", `Trace failed: ${(e as Error).message}`);
      }
    },
    hideTrace: () => {
      set({ traceVisible: false, ...supersedeTraces() });
    },
    setHighlight: (h) => {
      heldHighlight = null; // it would have replaced a held answer highlight on the map
      set({ highlight: h });
    },

    // ------------------------------------------------------------------ simulation
    setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
    toggleDraftNode: (id) =>
      set((s) => {
        const has = s.draft.failed_nodes.includes(id);
        return {
          draft: {
            ...s.draft,
            failed_nodes: has ? s.draft.failed_nodes.filter((x) => x !== id) : [...s.draft.failed_nodes, id],
          },
        };
      }),
    toggleDraftEdge: (id) =>
      set((s) => {
        const has = s.draft.failed_edges.includes(id);
        return {
          draft: {
            ...s.draft,
            failed_edges: has ? s.draft.failed_edges.filter((x) => x !== id) : [...s.draft.failed_edges, id],
          },
        };
      }),
    clearDraft: () => set({ draft: emptyScenario() }),
    loadPreset: (presetId) => {
      const p = get().presets.find((x) => x.id === presetId);
      if (p) set({ draft: { ...p.scenario } });
    },
    runSimulation: async (scenario, slot = "active", opts) => {
      const input = scenario ?? get().draft;
      if (!input.failed_nodes.length && !input.failed_edges.length) {
        set({ simError: "Select at least one component or connection to fail.", simStatus: "error" });
        return null;
      }
      const isCurrent = opts?.isCurrent;
      const epoch = simEpoch;
      const seq = (simSeq = ++reqSeq);
      latestSimGuard = isCurrent;
      if (slot === "A" || slot === "B") slotSeq[slot] = seq;
      liveRuns.set(seq, { slot, alive: () => epoch === simEpoch && (!isCurrent || isCurrent()) });
      // a new request clears the error toast; a demo step's settles only what it supersedes
      set({ simStatus: "running", ...(isCurrent ? settleErrorsBehindDemoRequest("run") : { simError: null }) });
      /** The world was restored / cleared, or the caller (a demo step) was superseded or exited. */
      const cancelled = () => {
        if (epoch !== simEpoch) return true;
        if (isCurrent && !isCurrent()) {
          if (seq === simSeq && get().simStatus === "running") set({ simStatus: "idle" });
          return true;
        }
        return false;
      };
      try {
        const result = await simulate(input);
        liveRuns.delete(seq); // landed: no longer in flight (before the updates below wake waiters)
        if (cancelled()) return null;
        const latest = seq === simSeq; // the newest run requested owns simStatus
        // ...and takes the map, unless something requested after it (a comparison, an analyst
        // answer to a later question) already did
        const display = latest && seq > displaySeq;
        const ownsSlot = (slot === "A" || slot === "B") && slotSeq[slot] === seq;
        if (!display && !ownsSlot) {
          if (latest && get().simStatus === "running") set({ simStatus: "idle" });
          return null;
        }
        if (display) {
          displaySeq = seq;
          displaySlotRun = slot === "A" || slot === "B" ? { slot, result } : null;
        }
        if (ownsSlot) {
          const k = slot as "A" | "B";
          slotWriteSeq[k] = seq;
          // a run requested after the comparison holding this slot owns it now; an older one only
          // fills it as data (the comparison then shows stale) and the hold stays
          if (seq > cmpHold[k]) cmpHold[k] = 0;
        }
        set((s) => ({
          slots: ownsSlot ? { ...s.slots, [slot]: result } : s.slots,
          ...(latest && !display ? { simStatus: "idle" as const } : {}),
          ...(display
            ? {
                result,
                simStatus: "idle" as const,
                compareView: null,
                // highlights belonged to the previously shown result (a later answer's still describes it)
                highlight: keepLaterAnswerHighlight(s.highlight, seq, result),
                playback: { step: 0, maxStep: maxStepOf(result), playing: true, runId: s.playback.runId + 1 },
                panels: { ...s.panels, simulation: true },
              }
            : {}),
        }));
        return result;
      } catch (e) {
        liveRuns.delete(seq); // failed: no longer in flight (before the updates below wake waiters)
        if (cancelled()) return null;
        const message = (e as Error).message;
        const ownsSlot = (slot === "A" || slot === "B") && slotSeq[slot] === seq;
        if (seq === simSeq && answerSimSeq > seq && !ownsSlot) {
          // An analyst answer to a question asked after this run put its simulation on the map, and this
          // run no longer fills its slot: landing, it would have been dropped, and so is its failure.
          if (get().simStatus === "running") set({ simStatus: "idle" });
          return null;
        }
        if (seq === simSeq) {
          // (a demo step's run requested after it makes this its slot's failure: see settleErrorsBehindDemoRequest)
          const about = slot === "A" || slot === "B" ? { slot, raw: message } : {};
          reportError(seq, "run", message, { simStatus: "error" }, about);
        } else if (ownsSlot) {
          // A newer run owns simStatus / result, but this slot was not filled: say so, so a later
          // Compare is not silently run against the slot's previous scenario.
          reportError(seq, "slot", `Scenario ${slot} failed: ${message}`, {}, { slot });
        }
        return null;
      }
    },
    setPlaybackStep: (step) =>
      set((s) => ({ playback: { ...s.playback, step: Math.max(0, Math.min(step, s.playback.maxStep)) } })),
    setPlaying: (playing) => set((s) => ({ playback: { ...s.playback, playing } })),
    replayCascade: () =>
      set((s) => ({ playback: { ...s.playback, step: 0, playing: true, runId: s.playback.runId + 1 } })),
    showSlot: (slot) => {
      const r = get().slots[slot];
      if (!r) return;
      set((s) => ({
        result: r,
        compareView: s.comparison ? slot : null,
        highlight: viewHighlight(s.highlight, s.result, r),
        playback: { step: maxStepOf(r), maxStep: maxStepOf(r), playing: false, runId: s.playback.runId + 1 },
      }));
    },
    runComparison: async (a, b, opts) => {
      const A = a ?? get().slots.A?.scenario;
      const B = b ?? get().slots.B?.scenario;
      if (!A || !B) {
        // (this "error" is no request's failure: no analyst answer settles it, see compareErrorSeq)
        const message = "Run two scenarios (A and B) before comparing.";
        // The demo's Compare step gets here after waiting (its run for a slot failed or was dropped). The
        // message takes the place on the request timeline its Compare would have taken, so a failure of a
        // request made before it does not replace it, whether that lands before or after it.
        if (opts?.isCurrent) reportError(++reqSeq, "check", message, { compareStatus: "error" });
        else set({ simError: message, compareStatus: "error" });
        return null;
      }
      const isCurrent = opts?.isCurrent;
      const epoch = simEpoch;
      const seq = (compareSeq = ++reqSeq);
      latestCompareGuard = isCurrent;
      // A slot holding another object when the comparison lands was filled by a newer run (a
      // re-run, one already in flight at Compare, or an analyst answer to a question asked after
      // this Compare) and belongs to it.
      // Failed or cancelled re-runs leave the slot untouched and do not count, and neither does a
      // slot another comparison filled (e.g. an analyst answer to an earlier question): this
      // comparison replaces `comparison`, so it takes those slots back too.
      const startSlots = get().slots;
      /** What the map showed when this Compare was requested: a run that takes it since may hold the diff back. */
      const displayAtRequest = displaySeq;
      // a new request clears the error toast; a demo step's settles only what it supersedes
      set({ compareStatus: "running", ...(isCurrent ? settleErrorsBehindDemoRequest("compare") : { simError: null }) });
      const stale = () => {
        if (seq !== compareSeq) return true; // a newer comparison owns compareStatus
        if (epoch !== simEpoch || (isCurrent && !isCurrent())) {
          if (get().compareStatus === "running") set({ compareStatus: "idle" });
          return true;
        }
        return false;
      };
      try {
        const comparison = await compare(A, B);
        if (stale()) return null;
        let owns = false;
        set((s) => {
          // A slot run already in flight at Compare that took the map since keeps it when it ran
          // another scenario than this comparison compared on its side: the diff would hide that
          // newer result (the comparison is stored and shows stale). A newer slot write that never
          // took the map (a run was requested after it, even one that failed) does not hold the
          // diff back: it only makes the diff show stale.
          const run = displaySeq !== displayAtRequest && displaySeq < seq ? displaySlotRun : null;
          const comparedThere = run && (run.slot === "A" ? comparison.scenario_a : comparison.scenario_b);
          const heldOff = !!run && !!comparedThere && !sameScenario(run.result.scenario, comparedThere.scenario);
          const r = adoptComparison(
            s,
            comparison,
            {
              // an analyst answer to a question asked before this Compare is older than it: replaced
              A: newerSlot(startSlots.A, s.slots.A) && !olderAnswerWrite("A", seq),
              B: newerSlot(startSlots.B, s.slots.B) && !olderAnswerWrite("B", seq),
            },
            // something requested after this Compare (a run, an analyst answer, or a trace: an answer's
            // or the demo's trace step's) already took the map: store the comparison, leave the map (and
            // the shown result) alone
            seq < Math.max(displaySeq, viewSeq),
            heldOff,
          );
          // The shown result moved to another scenario (it followed a slot this comparison took back
          // from an older answer, or one another comparison filled): highlights, the analyst's too,
          // described the result it replaced. (A run taking the map clears them the same way.)
          const nr = r.patch.result;
          const replaced = !!nr && !!s.result && nr !== s.result && !sameScenario(nr.scenario, s.result.scenario);
          // Held back only by a trace shown since (an answer's to a question asked after this Compare,
          // or the demo's trace step's; nothing requested after it took the map): landing before that
          // trace it drew its diff and owned the map, and the trace only left the diff. It owns the map
          // all the same.
          const heldByTrace = seq > displaySeq && seq < viewSeq && r.wouldDraw;
          // The map now shows this comparison if it took the diff view, if the diff was already on
          // (it now draws this comparison), or if it moved the shown result: requests made before it
          // must no longer take the map back.
          owns = r.tookView || s.compareView === "diff" || replaced || heldByTrace;
          // ...and it replaces an answer to a question asked before it (had it landed first, that
          // answer's highlight would have been held back), as a run that takes the map does
          const h = s.highlight;
          const ht = h && h.source === "ai" ? highlightTurn.get(h) : undefined;
          const olderAnswer = owns && !!ht && ht.seq < seq;
          // An answer asked before this Compare loses its held highlight too; one asked after it only has
          // its highlight held off the result this moved to (as a run requested before asking does).
          if (owns && heldHighlight && heldHighlight.t.seq < seq) heldHighlight = null;
          if (replaced && h && ht && ht.seq >= seq) holdHighlight(h, ht);
          // Take the map before this update reaches listeners: the demo steps' waits re-check displaySeq
          // when the store updates, and requests made before this comparison no longer take the map back.
          if (owns && seq > displaySeq) {
            displaySeq = seq;
            displaySlotRun = null;
          }
          return { ...r.patch, ...(replaced || olderAnswer ? { highlight: null } : {}), compareStatus: "idle" as const };
        });
        comparisonSeq = seq;
        holdComparedSlots(seq);
        return comparison;
      } catch (e) {
        if (stale()) return null;
        compareErrorSeq = seq;
        reportError(seq, "compare", (e as Error).message, { compareStatus: "error" });
        return null;
      }
    },
    setCompareView: (v) => {
      if (v === "A" || v === "B") {
        const r = get().slots[v];
        set((s) => ({
          compareView: v,
          result: r ?? s.result,
          highlight: r ? viewHighlight(s.highlight, s.result, r) : s.highlight,
          playback: r
            ? { step: maxStepOf(r), maxStep: maxStepOf(r), playing: false, runId: s.playback.runId + 1 }
            : s.playback,
        }));
      } else set({ compareView: v });
    },
    leaveDiff: (opts) => {
      const s = get();
      if (s.compareView !== "diff") return;
      if (opts?.showHighlight) {
        const k = showTarget(s);
        if (k === "A" || k === "B") return get().setCompareView(k);
      }
      set((s) => ({ compareView: viewOutsideDiff(s), highlight: highlightOffDiff(s.highlight, s.result, true) }));
    },
    highlightShowTarget: () => showTarget(get()),
    clearSimulation: () => {
      simEpoch++; // in-flight simulations and comparisons are dropped when they land
      set((s) => ({
        result: null,
        simStatus: "idle",
        compareStatus: "idle",
        simError: null,
        compareView: null,
        playback: { step: 0, maxStep: 0, playing: false, runId: s.playback.runId + 1 },
      }));
    },
    restoreWorld: () => {
      // Drop everything still in flight: simulations, comparisons, traces, demo steps, analyst answers.
      simEpoch++;
      traceSeq++;
      demoRun++;
      cmpHold.A = cmpHold.B = 0; // the slots and the comparison are cleared below
      compareErrorSeq = 0; // compareStatus is reset below: an earlier failure no longer owns it
      pendingReveal = []; // layers are reset to their defaults below
      cancelAnalyst("Stopped: the world was restored.");
      set((s) => ({
        result: null,
        slots: { A: null, B: null },
        comparison: null,
        compareView: null,
        compareStatus: "idle",
        simStatus: "idle",
        simError: null,
        draft: emptyScenario(),
        playback: { step: 0, maxStep: 0, playing: false, runId: s.playback.runId + 1 },
        selectedNodeId: null,
        selectedEdgeId: null,
        details: null,
        trace: null,
        traceVisible: false,
        highlight: null,
        layers: { ...DEFAULT_LAYERS },
        ...DEFAULT_VIEW,
        deepMode: false,
        panels: { ...DEFAULT_PANELS, analyst: s.panels.analyst },
        // a restored world no longer matches any demo step (startDemo/resetDemo re-activate it)
        demo: { active: false, step: 0, busy: false },
      }));
      world().setOrbit(false);
      world().flyHome();
    },

    // ------------------------------------------------------------------ analyst
    sendAnalystMessage: async (text, opts) => {
      const trimmed = text.trim();
      if (!trimmed || get().analystPending) return;
      const s0 = get();
      const turn: AnalystTurn = { seq: reqSeq, slots: { ...s0.slots }, asked: s0.result, shown: [], own: new WeakSet(), compared: [] };
      const history = s0.messages
        .filter((m) => !m.pending && !m.error && m.content)
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      const userMsg: ChatMessage = { id: uid(), role: "user", content: trimmed, tools: [] };
      const asst: ChatMessage = { id: uid(), role: "assistant", content: "", tools: [], pending: true };
      const ctrl = new AbortController();
      analystCtrl = ctrl;
      endAnswer(); // the previous answer holds nothing any more
      currentTurn = turn;
      /** The answer whose actions arrive (after a failover, the recorded answer that replaces this one). */
      let answering = turn;
      /** Stopped, cleared, restored, or replaced by a newer question: ignore anything further. */
      const stale = () => analystCtrl !== ctrl;
      set((s) => ({
        messages: [...s.messages, userMsg, asst],
        analystPending: true,
        panels: { ...s.panels, analyst: true },
      }));

      const onEvent = (ev: AnalystEvent) => {
        if (stale()) return;
        switch (ev.type) {
          case "status":
            patchMessage(asst.id, (m) => ({ ...m, mode: ev.mode, model: ev.model, note: ev.note ?? null }));
            break;
          case "tool_call":
            patchMessage(asst.id, (m) => ({
              ...m,
              tools: [...m.tools, { id: ev.id, name: ev.name, input: ev.input, status: "running" }],
            }));
            break;
          case "tool_result":
            patchMessage(asst.id, (m) => ({
              ...m,
              tools: m.tools.map((t) =>
                t.id === ev.id ? { ...t, status: ev.ok ? "ok" : "error", summary: ev.summary } : t,
              ),
            }));
            break;
          case "ui_action":
            get().applyUIAction(ev.action, answering);
            break;
          case "message":
            patchMessage(asst.id, (m) => ({ ...m, content: ev.text }));
            break;
          case "done":
            patchMessage(asst.id, (m) => ({ ...m, pending: false, mode: ev.mode }));
            break;
          case "error":
            patchMessage(asst.id, (m) => ({ ...m, pending: false, tools: settleTools(m.tools, "Interrupted"), error: ev.message }));
            break;
        }
      };
      const finish = (error?: string) => {
        if (stale()) return;
        analystCtrl = null; // (it stays the current answer: a highlight it holds can still come back)
        // A tool call still without its result when the answer ended (the connection dropped, the engine
        // died, the stream timed out or ended early) never gets one: its row is settled, as Stop does.
        patchMessage(asst.id, (m) => ({
          ...m,
          pending: false,
          tools: settleTools(m.tools, "Interrupted"),
          ...(error ? { error } : {}),
        }));
        set({ analystPending: false });
      };
      const replay = async (events: AnalystEvent[]) => {
        for (const ev of events) {
          if (stale()) return;
          if (ev.type === "ui_action") {
            // recorded answers carry precomputed engine outputs
            const a = ev.action;
            if (a.kind === "show_simulation" && a.result) snapshotResults.add(a.result);
            if (a.kind === "show_comparison" && a.comparison) {
              snapshotResults.add(a.comparison.scenario_a);
              snapshotResults.add(a.comparison.scenario_b);
            }
          }
          onEvent(ev);
          if (ev.type === "tool_result") await sleep(220);
        }
        finish();
      };
      const needsEngine =
        "The AI analyst needs the DEEPTRACE engine (backend) so it can call simulation tools. In offline snapshot mode only the recorded answer to the demo question about the demo's scenario A is available.";

      if (s0.dataMode !== "live") {
        // Offline snapshot: replay the recorded offline-analyst answer when it was recorded for this
        // exact question AND the scenario on screen; otherwise explain that the analyst needs the engine.
        const events = matchingReplay(trimmed, turn.asked);
        if (events) await replay(events);
        else finish(needsEngine);
        return;
      }

      try {
        await streamAnalyst(
          {
            message: trimmed,
            history,
            context: {
              selected_node_id: s0.selectedNodeId,
              selected_edge_id: s0.selectedEdgeId,
              active_scenario: s0.result?.scenario ?? null,
              scenario_a: s0.slots.A?.scenario ?? null,
              scenario_b: s0.slots.B?.scenario ?? null,
            },
            force_offline: opts?.forceOffline ?? false,
          },
          onEvent,
          ctrl.signal,
        );
        finish();
      } catch (e) {
        if (stale()) return;
        if (await failOverToSnapshot(e)) {
          // stopped, cleared, restored or replaced while the health check ran: what had arrived stays
          if (stale()) return;
          // The recorded answer to the question as it was asked (about the result on screen then, not
          // one a run landing meanwhile put there): the same answer whichever failure is handled first.
          const events = matchingReplay(trimmed, turn.asked);
          if (events) {
            patchMessage(asst.id, (m) => ({ ...m, content: "", tools: [] }));
            // The recorded answer replaces the partial one: it answers the question as asked, not what the
            // partial answer showed (that stays on the map). So it replays as an answer of its own at the
            // same place on the timeline: its highlights are held off those results, and the partial
            // answer holds nothing any more.
            answering = { seq: turn.seq, slots: { ...turn.slots }, asked: turn.asked, shown: [], own: new WeakSet(), compared: [] };
            replayTurns.add(answering);
            endAnswer();
            currentTurn = answering;
            await replay(events);
          } else finish(`The engine stopped responding. ${needsEngine}`);
          return;
        }
        finish((e as Error).message);
      }
    },
    stopAnalyst: () => cancelAnalyst("Stopped."),
    clearChat: () => {
      cancelAnalyst("Cleared.");
      // highlights the analyst applied are explained only by the conversation being cleared
      set((s) => ({ messages: [], highlight: s.highlight?.source === "ai" ? null : s.highlight }));
    },
    applyUIAction: (a, turn) => {
      const t: AnalystTurn = turn ?? { seq: reqSeq, slots: { ...get().slots }, asked: get().result, shown: [], own: new WeakSet(), compared: [] };
      /** Where this answer sits on the request timeline: after its question, before anything later. */
      const at = t.seq + 0.5;
      /** Nothing started after the question has taken the map yet (one still in flight replaces this when it lands). */
      const mayShow = () => displaySeq <= at;
      switch (a.kind) {
        case "select_node":
          if (a.node_id) void get().selectNode(a.node_id, { fly: false });
          break;
        case "fly_to":
          if (a.node_id) world().flyToNode(a.node_id);
          else if (a.node_ids.length) world().flyToNodes(a.node_ids);
          break;
        case "highlight": {
          // a highlight describes what this answer shows; a newer result on the map is not that
          if (!mayShow()) break;
          const s = get();
          const cur = s.result;
          const h: Highlight = {
            node_ids: a.node_ids,
            edge_ids: a.edge_ids,
            label: a.label ?? null,
            tone: a.tone ?? "info",
            source: "ai",
          };
          highlightTurn.set(h, t);
          // This answer's own diff on the map: the highlight is about its comparison, whichever object of
          // a compared scenario the result under the diff is (an older run may have filled that slot), and
          // whatever the result under it is (see highlightOffDiff). (A recorded answer replayed after a
          // failover shares the partial answer's place on the timeline, not the comparison it drew.)
          const ownDiff =
            s.compareView === "diff" && !!s.comparison && comparisonSeq === at && (t.compared.length > 0 || !replayTurns.has(t));
          if (!ownDiff && cur && !answerDescribes(t, cur)) {
            // ...nor is a result of another scenario that an older request (or the user, switching
            // slots) put on the map while the answer was coming: it was never asked about. It is held
            // (see heldHighlight) and describes the result the answer was about until then.
            highlightBase.set(h, t.shown.length ? t.shown[t.shown.length - 1] : t.asked);
            holdHighlight(h, t);
            break;
          }
          heldHighlight = null; // this one replaces a highlight the answer held
          highlightBase.set(h, ownDiff ? null : cur);
          if (ownDiff) diffHighlights.add(h);
          set({ highlight: h });
          break;
        }
        case "clear_highlights": {
          if (!mayShow()) break;
          if (heldHighlight?.t === t) heldHighlight = null; // its held highlight too
          const cur = get().result;
          const h0 = get().highlight;
          // not this answer's result: the highlight there is not ours (unless this answer set it)
          if (cur && !answerDescribes(t, cur) && !(h0 && highlightTurn.get(h0) === t)) break;
          set({ highlight: null });
          break;
        }
        case "show_trace":
          if (a.trace) {
            // a user trace still in flight is dropped when it lands: one that already failed is too
            const retracted = supersedeTraces();
            // The analyst is showing a component's connections and the diff view would hide them, so
            // leave the diff, unless something started after asking already took the map (the trace
            // is still stored: the inspector and the A/B chips show it).
            const s0 = get();
            const show = mayShow();
            const leave = show && s0.compareView === "diff" && !!s0.comparison;
            // the trace is on the map either way: comparisons started before asking land without their diff
            if (show) viewSeq = Math.max(viewSeq, at);
            set((s) => ({
              trace: a.trace,
              traceVisible: true,
              ...(leave ? { compareView: viewOutsideDiff(s), highlight: highlightOffDiff(s.highlight, s.result, true) } : {}),
              ...retracted,
            }));
          }
          break;
        case "show_simulation":
          if (a.result) {
            const r = a.result;
            const k = a.slot === "A" || a.slot === "B" ? a.slot : null;
            const show = mayShow();
            // A slot written by something you started after asking keeps it, and so does a slot that
            // showed what a comparison started after asking compared when it landed, even if a run
            // started before that comparison has filled it since (as data). An older run that the
            // comparison merely kept there is not that comparison's, and the answer may replace it.
            const fill = k !== null && slotWriteSeq[k] <= at && !(cmpHold[k] > at);
            if (!show && !fill) break;
            t.own.add(r); // the answer produced this result (wherever it ends up)
            /** The run this answer's slot write took the slot from. */
            let slotOld = -1;
            if (show) {
              displaySeq = at; // earlier runs and comparisons no longer take the map when they land
              displaySlotRun = null;
              answerSimSeq = Math.max(answerSimSeq, at);
              t.shown.push(r); // ...and the answer is now about it too
            }
            if (k && fill) {
              // earlier runs for this slot no longer overwrite it; a later one still in flight does
              if (slotSeq[k] <= t.seq) {
                slotOld = slotSeq[k];
                slotSeq[k] = at;
              }
              slotWriteSeq[k] = at;
              cmpHold[k] = 0;
              t.slots[k] = r; // the answer's own write is not newer than its later comparisons
            }
            // The runs this answer superseded have their failure dropped when they land, so one that
            // already failed comes off the toast too: the run for the slot it wrote, and, when it took the
            // map, a run requested before asking that no longer fills its slot (that failure's simStatus
            // "error" goes back to idle; a failure of kind "run" is always the newest run's).
            const superseded = (e: ReportedError) =>
              (e.kind === "slot" && e.seq === slotOld) ||
              (show && e.kind === "run" && e.seq <= t.seq && !(e.slot && slotSeq[e.slot] === e.seq));
            syncReportedErrors();
            const settleSim = reportedErrors.some((e) => e.kind === "run" && superseded(e));
            const retracted = retractErrors(superseded);
            set((s) => ({
              ...(k && fill ? { slots: { ...s.slots, [k]: r } } : {}),
              ...(show
                ? {
                    result: r,
                    compareView: null,
                    // only a highlight this same answer set describes the new result (earlier answers'
                    // and the user's described the result it replaces), one it held too
                    highlight: turnHighlight(s.highlight, t),
                    playback: { step: 0, maxStep: maxStepOf(r), playing: true, runId: s.playback.runId + 1 },
                  }
                : {}),
              ...retracted,
              ...(settleSim && s.simStatus === "error" ? { simStatus: "idle" as const } : {}),
            }));
            if (show) settleRunsBehindAnswer();
          }
          break;
        case "show_comparison":
          if (a.comparison) {
            const c = a.comparison;
            // a comparison you started after asking has already landed: it stays
            if (comparisonSeq > at) break;
            // Comparisons started before asking and still in flight are dropped when they land (a
            // later one still in flight replaces this answer's comparison when it lands).
            const supersede = compareSeq <= t.seq;
            // ...and so is their failure: one that already failed comes off the toast, and its
            // compareStatus "error" goes back to idle
            const settleFailed = supersede && compareSeq > 0 && compareErrorSeq === compareSeq;
            let retracted: Partial<DeeptraceState> = {};
            if (supersede) {
              const old = compareSeq;
              compareSeq = at;
              latestCompareGuard = undefined;
              retracted = retractErrors((e) => e.kind === "compare" && e.seq === old);
            }
            // The demo's trace step, reached after asking, holds the map for its trace (see demoGoto):
            // this comparison then lands without its diff view. (An answer's own trace is at `at`.)
            const traceHold = viewSeq > at;
            const show = mayShow() && !traceHold;
            let owns = false;
            set((s) => {
              // slots changed since the analyst was given them belong to the newer write
              const keep = { A: newerSlot(t.slots.A, s.slots.A), B: newerSlot(t.slots.B, s.slots.B) };
              // ...but one an older run (requested before asking) filled as data only does not hold the
              // answer back: the shown result follows that slot as given, the same whether that run lands
              // before this comparison or after it
              const given = (k: "A" | "B") => (keep[k] && slotWriteSeq[k] < at && t.slots[k]) || undefined;
              const r = adoptComparison(
                s,
                c,
                keep,
                // something started after asking already took the map: store this without its diff view
                // (a slot written since that never took the map, or by an older run that landed in
                // between, keeps its slot as data, and the diff shows stale)
                !show,
                false,
                { A: given("A"), B: given("B") },
              );
              const nr = r.patch.result;
              const replaced = !!nr && !!s.result && nr !== s.result && !sameScenario(nr.scenario, s.result.scenario);
              // the map now shows this answer's comparison (its diff, or a result it moved)
              owns = show && (r.tookView || s.compareView === "diff" || replaced);
              // Held back only by that trace: landing before the step's trace, this comparison drew its
              // diff and owned the map, and the step only left the diff. It owns the map all the same.
              if (traceHold && mayShow()) owns = true;
              // the scenarios it compared are this answer's results too (whichever object a slot holds)
              t.compared.push(c.scenario_a.scenario, c.scenario_b.scenario);
              if (show && nr && nr !== s.result) t.shown.push(nr);
              // ...and, like a Compare that takes the map, it replaces an earlier answer's highlight
              // (one question streams at a time: another answer's highlight was asked before this one)
              const h0 = s.highlight;
              const ht = h0 && h0.source === "ai" ? highlightTurn.get(h0) : undefined;
              const olderAnswer = owns && !!ht && ht !== t;
              /**
               * This answer held a highlight off an older result: drawing its own diff brings it back, as a
               * highlight about that diff (leaving the diff for a result it does not describe holds it again).
               */
              const heldOwn = owns && r.tookView && heldHighlight?.t === t;
              // the map is this answer's now (before this update reaches listeners: the demo steps' waits
              // read displaySeq)
              if (owns && at > displaySeq) {
                displaySeq = at;
                displaySlotRun = null;
              }
              return {
                ...r.patch,
                // only a highlight this same answer set (or held) describes a result it moved to
                ...(replaced
                  ? { highlight: turnHighlight(s.highlight, t) }
                  : heldOwn
                    ? { highlight: heldOwnBack(turnHighlight(null, t)) }
                    : olderAnswer
                      ? { highlight: null }
                      : {}),
                compareStatus:
                  (supersede && s.compareStatus === "running") || (settleFailed && s.compareStatus === "error")
                    ? ("idle" as const)
                    : s.compareStatus,
                ...retracted,
              };
            });
            comparisonSeq = at;
            holdComparedSlots(at);
            if (owns) settleRunsBehindAnswer();
          }
          break;
      }
    },

    // ------------------------------------------------------------------ demo
    startDemo: () => {
      get().restoreWorld();
      set((s) => ({ demo: { active: true, step: 0, busy: false }, messages: [], panels: { ...s.panels, layers: false } }));
      void get().demoGoto(0);
    },
    exitDemo: () => {
      demoRun++; // the running step stops at its next await, and its simulate / compare is dropped
      demoExits++; // ...and so is a trace a demo step requested
      finishPendingReveal();
      settleCancelledRuns();
      // the answer to the demo's own question stops too (an answer to a question you typed keeps streaming)
      if (demoAnswer && demoAnswer === analystCtrl) cancelAnalyst("Stopped: you exited the demo.");
      demoAnswer = null;
      set({ demo: { active: false, step: 0, busy: false } });
    },
    resetDemo: () => get().startDemo(),
    demoGoto: async (stepIndex) => {
      const script = get().demoScript;
      if (!script) return;
      const run = ++demoRun;
      /** False once another step started or the demo was exited / reset / restored. */
      const current = () => run === demoRun;
      // the step being replaced is cancelled: finish its layer reveal, clear its spinners
      finishPendingReveal();
      settleCancelledRuns();
      const guard = { isCurrent: current };
      const i = Math.max(0, Math.min(stepIndex, script.steps.length - 1));
      const step = script.steps[i];
      // A step that can run a simulation or a comparison clears the error toast at the click, like Run or
      // Compare (the requests it makes, some only after waiting, settle only what they supersede).
      const clearsToast = ["simulate", "cascade", "simulate_b", "compare", "ask_ai"].includes(step.action);
      set({ demo: { active: true, step: i, busy: true }, ...(clearsToast ? { simError: null } : {}) });
      const st = get();
      const presetA = st.presets.find((p) => p.id === script.scenario_a_preset);
      const presetB = st.presets.find((p) => p.id === script.scenario_b_preset);
      const focus = step.node_id ?? script.focus_node_id;
      try {
        switch (step.action) {
          case "overview":
            world().flyHome({ duration: 2.5 });
            world().setOrbit(true);
            break;
          case "deep_mode":
            world().setOrbit(false);
            get().setDeepMode(true, { fly: true });
            break;
          case "reveal_layers": {
            if (!get().deepMode) get().setDeepMode(true, { fly: true });
            const order: LayerKey[] = ["underground", "water", "power", "telecom", "transport", "facility"];
            get().setAllLayers(false);
            pendingReveal = [...order];
            for (const k of order) {
              await sleep(550);
              if (!current()) return; // exit / the next step already turned pendingReveal back on
              pendingReveal = pendingReveal.filter((x) => x !== k);
              get().setLayer(k, true);
            }
            break;
          }
          case "select_node": {
            if (!get().deepMode) get().setDeepMode(true);
            const selecting = get().selectNode(focus, { fly: true }); // selects (and opens the inspector) at once
            // the step shows its focus node's inspector: it comes to the front, also when it was open behind
            // another panel (the focus already selected, reached by Prev or a step chip) or an answer is
            // streaming (a selection alone does not bring the inspector forward then)
            set({ panelFront: { key: "inspector" } });
            await selecting;
            break;
          }
          case "trace": {
            // The step has its own place on the request timeline (like the Ask the AI step): its trace
            // holds the map against a comparison started before it (yours, or an analyst answer's to a
            // question asked before it), whether that lands before or after the node details below,
            // but not against something started after it that took the map.
            const stepSeq = ++reqSeq;
            /** Trace actions so far (as selectNode's follow-trace counts them from the click). */
            const tracesAtStep = traceSeq;
            const selecting = get().selectedNodeId !== focus ? get().selectNode(focus, { fly: true }) : null;
            /** Selection moves so far, the step's own selection of its focus included (counted before its first await). */
            const selectionsAtStep = selectionSeq;
            // the trace's inspector (its counts and summary) comes to the front, as in the select step
            set({ panelFront: { key: "inspector" } });
            if (selecting) await selecting;
            if (!current()) return;
            // reached by a step chip from the compare step: the diff view would hide the trace (a diff
            // drawn by a comparison started after this step stays)
            if (get().compareView === "diff" && displaySeq < stepSeq) get().leaveDiff();
            // ...and a comparison started before the step that is still in flight lands without its diff
            viewSeq = Math.max(viewSeq, stepSeq);
            {
              // The step traces its focus as of the click: a trace requested, shown or hidden since (yours
              // or an answer's), or another selection (also one that has come back to the focus since), is
              // newer than the step and stays, whether it landed before the focus node's details or after.
              // (The selection's own follow-trace of the focus, already landed and the one trace action
              // since the click, is the step's trace. Your trace of the focus, or an answer's, is not: it
              // stays as it would landing after the details.)
              const s = get();
              const ownFollow =
                traceSeq === tracesAtStep + 1 && followTraceSeq === traceSeq && s.traceVisible && s.trace?.node_id === focus;
              const moved = s.selectedNodeId !== focus || selectionSeq !== selectionsAtStep;
              if (moved || (traceSeq !== tracesAtStep && !ownFollow)) break;
            }
            // (dropped when it lands after Exit demo, as is its failure)
            const exits = demoExits;
            await get().showTrace(focus, { isCurrent: () => exits === demoExits });
            break;
          }
          case "simulate":
          case "cascade": {
            if (presetA) {
              set({ draft: { ...presetA.scenario } });
              const existing = get().slots.A;
              if (step.action === "cascade" && existing && sameScenario(existing.scenario, presetA.scenario)) {
                // replay scenario A's cascade from the start (playback follows the result shown)
                set((s) => ({
                  result: existing,
                  compareView: null,
                  highlight: viewHighlight(s.highlight, s.result, existing),
                  playback: { step: 0, maxStep: maxStepOf(existing), playing: true, runId: s.playback.runId + 1 },
                }));
              } else {
                get().hideTrace();
                await get().runSimulation(presetA.scenario, "A", guard);
                if (!current()) return;
              }
              const r = get().result;
              if (r && step.action === "cascade") {
                world().flyToNodes(r.affected_nodes.map((a) => a.node_id));
              }
            }
            break;
          }
          case "ask_ai": {
            // the question and its answer are what the step shows: the analyst comes to the front
            set((s) => ({ panels: { ...s.panels, analyst: true }, panelFront: { key: "analyst" } }));
            if (!step.question) break;
            // The scripted question is about scenario A (and the offline replay was recorded for A
            // only). Reached by Prev (after simulate_b) or a step chip, put A on screen first.
            // The step has its own place on the request timeline: it takes the map back from an answer
            // to a question asked before it, and from a run or Compare of yours started before it (see
            // the wait below), but not from something started after it that took the map (your run or
            // Compare, or an answer to a question asked meanwhile), nor from your run or Compare started
            // after it that is still in flight (it replaces A when it lands; one that fails never counts).
            const stepSeq = ++reqSeq;
            /** Request numbers of this step's own runs for A. */
            const ownRuns = new Set<number>();
            /**
             * A run or Compare of yours (not the step's own) is still in flight and can still take the map
             * or fill a slot, whether you started it before or after this step: your newest run that
             * nothing newer has taken the map from, the newest run for slot A or for slot B, or your
             * Compare. One started after the step replaces A when it lands; one started before it that
             * lands is taken back like an earlier answer; a run for slot B only fills its slot, which the
             * question's context carries (scenario_b); a failed one never counts. So the step decides, and
             * asks with the same context, only once it has settled, whether it lands before or after an
             * earlier answer ends or the step's own run for A. (Each of these settling updates the store:
             * the waits below wake.)
             */
            const yoursInFlight = () =>
              (simSeq > displaySeq && !ownRuns.has(simSeq) && !!liveRuns.get(simSeq)?.alive()) ||
              (!ownRuns.has(slotSeq.A) && !!liveRuns.get(slotSeq.A)?.alive()) ||
              !!liveRuns.get(slotSeq.B)?.alive() ||
              get().compareStatus === "running";
            /** Something started after this step took the map, or a run or Compare of yours is still in flight. */
            const yieldsToLater = () => (displaySeq > stepSeq && !ownRuns.has(displaySeq)) || yoursInFlight();
            /** Scenario A is what the map shows (not under the A/B diff). */
            const aShown = () => {
              const { result: r, compareView } = get();
              return !presetA || (!!r && sameScenario(r.scenario, presetA.scenario) && compareView !== "diff");
            };
            /** The step ran A once already: a run of its own that failed (or lost slot A) is not run again. */
            let ranA = false;
            const showA = async () => {
              if (!presetA || aShown() || yieldsToLater()) return;
              // An answer to a question asked after this step is still streaming: it may take the map (the
              // step then yields to it), and a run of the step's own requested now would be numbered after
              // that question and take the map back from it. So the step decides once the answer has ended
              // (the loop below waits for it).
              if (get().analystPending && currentTurn && currentTurn.seq >= stepSeq) return;
              const existing = get().slots.A;
              if (existing && sameScenario(existing.scenario, presetA.scenario)) get().showSlot("A");
              else if (!ranA) {
                ranA = true;
                get().hideTrace();
                const before = reqSeq;
                const ran = get().runSimulation(presetA.scenario, "A", guard);
                if (simSeq > before) ownRuns.add(simSeq); // numbered before its first await
                await ran;
              }
            };
            // sendAnalystMessage ignores calls while another answer is streaming: wait for it instead
            // of silently skipping the scripted question. An answer to a question asked before this step
            // may put another result on the map, so A is put back on screen once it is done; one asked
            // after it holds the map if it took it (no question). Wait the same way for a run
            // or Compare of yours that is still in flight: once it has landed, one started after this step
            // holds the map (no question) and one started before it is taken back; once it has failed, A
            // is put on screen after all. The step's own run may land in slot A without taking the map (a
            // run you started after it was newer): A is then shown from its slot too, whether or not the
            // step had to wait. So the decision does not depend on the order the answer, the step's run
            // and yours land in.
            for (;;) {
              const ranBefore: boolean = ranA;
              await showA();
              if (!current()) return;
              if (get().analystPending) {
                await waitUntil(() => !get().analystPending || !current());
                if (!current()) return;
              } else if (yoursInFlight()) {
                // decide once it has landed or failed (a failed one never counts)
                await waitUntil(() => !yoursInFlight() || !current());
                if (!current()) return;
              } else if (ranA === ranBefore) break; // A is on screen now, or this step will not put it there
            }
            // A is not on screen (its run failed, or something started after this step took the map):
            // the question is about A, so it is not asked.
            if (!aShown()) break;
            // (a wait may have put another panel in front of the analyst)
            set({ panelFront: { key: "analyst" } });
            const prevCtrl = analystCtrl;
            const asking = get().sendAnalystMessage(step.question);
            // Exit demo stops this answer (sendAnalystMessage sets analystCtrl before its first await)
            if (analystCtrl !== prevCtrl) demoAnswer = analystCtrl;
            await asking;
            break;
          }
          case "simulate_b":
            if (presetB) {
              set({ draft: { ...presetB.scenario } });
              await get().runSimulation(presetB.scenario, "B", guard);
              if (!current()) return;
              const r = get().result;
              if (r) world().flyToNodes(r.affected_nodes.map((a) => a.node_id));
            }
            break;
          case "compare": {
            // Fill the empty slots with the presets, then compare. First wait for everything requested
            // before this step that can still write a slot, filled or empty, or take the map: a run you
            // requested that is still the newest request for slot A or B (an earlier step's own runs were
            // cancelled when this step started), your newest run while it can still take the map (the
            // step's own runs would be newer and keep it off), a streaming analyst answer (its slot
            // writes) and a Compare in flight (it takes slots back). Then run a preset only into a slot
            // still empty, and wait again after each of this step's runs (for any of those started
            // meanwhile). Compare only once all of them have settled, so what the step runs and compares,
            // and what the map shows, does not depend on the order the responses land in.
            // (Exit, Reset, Restore world or another step ends each wait: each makes current() false, then
            // updates the store, which re-checks it. Stop / Clear chat end an answer's.)
            /** The newest request for slot k is a run still in flight. */
            const owed = (k: "A" | "B") => !!liveRuns.get(slotSeq[k])?.alive();
            /**
             * The newest run (a Run of yours too, not only Run as A / B) is still in flight and nothing
             * requested after it took the map: it puts its result there when it lands, unless this step
             * runs a preset first. (False for an earlier step's cancelled runs, and for this step's own
             * once they have landed or failed.)
             */
            const mapOwed = () => simSeq > displaySeq && !!liveRuns.get(simSeq)?.alive();
            const unsettled = () =>
              owed("A") || owed("B") || mapOwed() || get().analystPending || get().compareStatus === "running";
            /**
             * Resolves once nothing can still write a slot or take the map: true, or false once this step is
             * no longer current.
             */
            const settled = async () => {
              if (unsettled()) await waitUntil(() => !current() || !unsettled());
              return current();
            };
            if (!(await settled())) return;
            for (const [k, preset] of [["A", presetA], ["B", presetB]] as const) {
              if (get().slots[k] || !preset) continue;
              await get().runSimulation(preset.scenario, k, guard);
              if (!(await settled())) return;
            }
            // like the Compare button, the comparison comes to the front (its panel may be open behind another)
            if ((await get().runComparison(undefined, undefined, guard)) && current())
              set({ panelFront: { key: "comparison" } });
            break;
          }
        }
      } finally {
        // a superseded step must not clear `busy` for the step that replaced it
        if (current()) set((s) => ({ demo: { ...s.demo, busy: false } }));
      }
    },
    demoNext: async () => {
      const { demo, demoScript } = get();
      if (!demoScript) return;
      if (demo.step < demoScript.steps.length - 1) await get().demoGoto(demo.step + 1);
    },
    demoPrev: async () => {
      const { demo } = get();
      if (demo.step > 0) await get().demoGoto(demo.step - 1);
    },
  };
});

/** Convenience selector for the node currently selected. */
export const useSelectedNode = () =>
  useStore((s) => (s.selectedNodeId && s.index ? s.index.nodes.get(s.selectedNodeId) ?? null : null));

// Expose the store for debugging and automated browser tests (harmless in production).
if (typeof window !== "undefined") {
  (window as unknown as { __deeptraceStore?: typeof useStore }).__deeptraceStore = useStore;
}
