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
  showTrace: (nodeId: string) => Promise<void>;
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
  clearSimulation: () => void;
  restoreWorld: () => void;

  sendAnalystMessage: (text: string, opts?: { forceOffline?: boolean }) => Promise<void>;
  /** Abort the analyst answer that is streaming (keeps what has arrived so far). */
  stopAnalyst: () => void;
  clearChat: () => void;
  applyUIAction: (a: UIAction) => void;

  startDemo: () => void;
  exitDemo: () => void;
  resetDemo: () => void;
  demoGoto: (step: number) => Promise<void>;
  demoNext: () => Promise<void>;
  demoPrev: () => Promise<void>;
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
  /** Latest simulation request; only it may set the displayed `result` and `simStatus`. */
  let simSeq = 0;
  /** Latest request per slot, so an older run cannot overwrite a newer run's slot. */
  const slotSeq: Record<"A" | "B", number> = { A: 0, B: 0 };
  let compareSeq = 0;
  /**
   * The caller's guard of the latest simulation / comparison (demo steps pass theirs). A run whose
   * guard turned false is dropped when it lands; settleCancelledRuns clears its spinner right away.
   */
  let latestSimGuard: (() => boolean) | undefined;
  let latestCompareGuard: (() => boolean) | undefined;
  /** Bumped by every showTrace / hideTrace / deselect / restore. */
  let traceSeq = 0;
  /** Bumped by every demoGoto and by start/reset/exit/restore: a superseded step stops at its next await. */
  let demoRun = 0;
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
      const r = snapshotSimulate(snapshot, scenario);
      if (r) {
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
      const c = snapshotCompare(snapshot, a, b);
      if (c) {
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
   * The recorded offline-analyst answer for this question, but only when the app is showing the
   * scenario it was recorded for (export_snapshot records it against the demo's scenario A).
   */
  function matchingReplay(question: string): AnalystEvent[] | null {
    const s = get();
    const events = s.snapshot?.analyst_replays?.[question];
    if (!events?.length) return null;
    const recordedFor = s.presets.find((p) => p.id === s.snapshot?.demo?.scenario_a_preset)?.scenario;
    const active = s.result?.scenario;
    if (!recordedFor || !active || !sameScenario(active, recordedFor)) return null;
    return events;
  }

  /** Abort the in-flight analyst request (if any) and settle its message. */
  function cancelAnalyst(reason: string) {
    const ctrl = analystCtrl;
    if (!ctrl) return;
    analystCtrl = null;
    ctrl.abort(reason);
    set((s) => ({
      analystPending: false,
      messages: s.messages.map((m) =>
        m.pending
          ? {
              ...m,
              pending: false,
              tools: m.tools.map((t) => (t.status === "running" ? { ...t, status: "error" as const, summary: "Stopped" } : t)),
              error: m.error ?? reason,
            }
          : m,
      ),
    }));
  }

  /** A highlight the user made for the previously shown result no longer applies to a new one. */
  const dropUserHighlight = (h: Highlight | null) => (h && h.source === "user" ? null : h);

  /**
   * State for a new comparison. Slot objects the UI already holds are kept when they are the
   * compared scenarios, and `result` follows its slot, so the displayed result stays identifiable
   * as A or B (the A/B chips compare by identity). A slot in `keep` was filled by a newer write
   * while the comparison ran: it belongs to that write and is kept as it is (the comparison panel
   * then shows "Slots changed since this comparison" instead of the older run coming back).
   */
  /** Slot objects a comparison put there (the user's or an analyst show_comparison): not a newer run. */
  const comparisonFilled = new WeakSet<SimulationResult>();

  function adoptComparison(
    s: DeeptraceState,
    c: ScenarioComparison,
    keep: { A: boolean; B: boolean } = { A: false, B: false },
  ): Partial<DeeptraceState> {
    const compared = { A: c.scenario_a, B: c.scenario_b };
    const pick = (k: "A" | "B") => {
      const cur = s.slots[k];
      return cur && (keep[k] || sameScenario(cur.scenario, compared[k].scenario)) ? cur : compared[k];
    };
    const A = pick("A");
    const B = pick("B");
    if (A !== s.slots.A) comparisonFilled.add(A);
    if (B !== s.slots.B) comparisonFilled.add(B);
    // a kept slot that now holds another scenario means a newer run owns the map
    const superseded = (["A", "B"] as const).some((k) => {
      const cur = s.slots[k];
      return keep[k] && !!cur && !sameScenario(cur.scenario, compared[k].scenario);
    });
    const result = s.result && s.result === s.slots.A ? A : s.result && s.result === s.slots.B ? B : s.result;
    const moved = result !== s.result && result !== null;
    return {
      comparison: c,
      // don't swap the map from a newer run to the diff of an older comparison
      compareView: superseded ? s.compareView : "diff",
      slots: { A, B },
      result,
      panels: { ...s.panels, comparison: true },
      ...(moved
        ? {
            // the displayed result changed: its playback range and any user highlight are stale
            highlight: dropUserHighlight(s.highlight),
            playback: { step: maxStepOf(result), maxStep: maxStepOf(result), playing: false, runId: s.playback.runId + 1 },
          }
        : {}),
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
      if (!id) {
        traceSeq++;
        set({ selectedNodeId: null, details: null, trace: null, traceVisible: false });
        return;
      }
      set((s) => ({
        selectedNodeId: id,
        selectedEdgeId: null,
        details: null,
        detailsLoading: true,
        panels: { ...s.panels, inspector: true },
      }));
      if (opts?.fly) world().flyToNode(id);
      let details: NodeDetails | null = null;
      if (get().dataMode === "live") {
        try {
          details = await liveApi.nodeDetails(id);
        } catch (e) {
          if (await failOverToSnapshot(e)) details = offlineDetails(id);
        }
      } else details = offlineDetails(id);
      if (get().selectedNodeId !== id) return; // a newer selection superseded this one
      set({ details, detailsLoading: false });
      if (opts?.trace) await get().showTrace(id);
      else if (get().traceVisible && get().trace?.node_id !== id) await get().showTrace(id);
    },
    selectEdge: (id) =>
      set((s) => ({
        selectedEdgeId: id,
        selectedNodeId: id ? null : s.selectedNodeId,
        details: id ? null : s.details,
        panels: id ? { ...s.panels, inspector: true } : s.panels,
      })),
    setHovered: (id) => {
      if (get().hoveredId !== id) set({ hoveredId: id });
    },
    showTrace: async (nodeId) => {
      const seq = ++traceSeq;
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
        // A newer trace request, a hide, or a selection change supersedes this response.
        if (seq !== traceSeq || get().selectedNodeId !== nodeId) return;
        if (trace) set({ trace, traceVisible: true });
      } catch (e) {
        if (seq === traceSeq) set({ simError: `Trace failed: ${(e as Error).message}` });
      }
    },
    hideTrace: () => {
      traceSeq++;
      set({ traceVisible: false });
    },
    setHighlight: (h) => set({ highlight: h }),

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
      const seq = ++simSeq;
      latestSimGuard = isCurrent;
      if (slot === "A" || slot === "B") slotSeq[slot] = seq;
      set({ simStatus: "running", simError: null });
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
        if (cancelled()) return null;
        const latest = seq === simSeq; // only the newest run may change what is displayed
        const ownsSlot = (slot === "A" || slot === "B") && slotSeq[slot] === seq;
        if (!latest && !ownsSlot) return null;
        set((s) => ({
          slots: ownsSlot ? { ...s.slots, [slot]: result } : s.slots,
          ...(latest
            ? {
                result,
                simStatus: "idle" as const,
                compareView: null,
                // highlights belonged to the previously shown result
                highlight: null,
                playback: { step: 0, maxStep: maxStepOf(result), playing: true, runId: s.playback.runId + 1 },
                panels: { ...s.panels, simulation: true },
              }
            : {}),
        }));
        return result;
      } catch (e) {
        if (cancelled()) return null;
        const message = (e as Error).message;
        if (seq === simSeq) {
          set({ simStatus: "error", simError: message });
        } else if ((slot === "A" || slot === "B") && slotSeq[slot] === seq) {
          // A newer run owns simStatus / result, but this slot was not filled: say so, so a later
          // Compare is not silently run against the slot's previous scenario.
          set({ simError: `Scenario ${slot} failed: ${message}` });
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
        highlight: r === s.result ? s.highlight : dropUserHighlight(s.highlight),
        playback: { step: maxStepOf(r), maxStep: maxStepOf(r), playing: false, runId: s.playback.runId + 1 },
      }));
    },
    runComparison: async (a, b, opts) => {
      const A = a ?? get().slots.A?.scenario;
      const B = b ?? get().slots.B?.scenario;
      if (!A || !B) {
        set({ simError: "Run two scenarios (A and B) before comparing.", compareStatus: "error" });
        return null;
      }
      const isCurrent = opts?.isCurrent;
      const epoch = simEpoch;
      const seq = ++compareSeq;
      latestCompareGuard = isCurrent;
      // A slot holding another object when the comparison lands was filled by a newer run (a
      // re-run, one already in flight at Compare, or an analyst show_simulation) and belongs to it.
      // Failed or cancelled re-runs leave the slot untouched and do not count, and neither does a
      // slot another comparison filled (e.g. an analyst answer to an earlier question): this
      // comparison replaces `comparison`, so it takes those slots back too.
      const startSlots = get().slots;
      const newer = (k: "A" | "B", cur: SimulationResult | null) =>
        cur !== startSlots[k] && !(cur && comparisonFilled.has(cur));
      set({ compareStatus: "running", simError: null });
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
        set((s) => ({
          ...adoptComparison(s, comparison, { A: newer("A", s.slots.A), B: newer("B", s.slots.B) }),
          compareStatus: "idle",
        }));
        return comparison;
      } catch (e) {
        if (stale()) return null;
        set({ compareStatus: "error", simError: (e as Error).message });
        return null;
      }
    },
    setCompareView: (v) => {
      if (v === "A" || v === "B") {
        const r = get().slots[v];
        set((s) => ({
          compareView: v,
          result: r ?? s.result,
          highlight: r && r !== s.result ? dropUserHighlight(s.highlight) : s.highlight,
          playback: r
            ? { step: maxStepOf(r), maxStep: maxStepOf(r), playing: false, runId: s.playback.runId + 1 }
            : s.playback,
        }));
      } else set({ compareView: v });
    },
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
      const history = s0.messages
        .filter((m) => !m.pending && !m.error && m.content)
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      const userMsg: ChatMessage = { id: uid(), role: "user", content: trimmed, tools: [] };
      const asst: ChatMessage = { id: uid(), role: "assistant", content: "", tools: [], pending: true };
      const ctrl = new AbortController();
      analystCtrl = ctrl;
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
            get().applyUIAction(ev.action);
            break;
          case "message":
            patchMessage(asst.id, (m) => ({ ...m, content: ev.text }));
            break;
          case "done":
            patchMessage(asst.id, (m) => ({ ...m, pending: false, mode: ev.mode }));
            break;
          case "error":
            patchMessage(asst.id, (m) => ({ ...m, pending: false, error: ev.message }));
            break;
        }
      };
      const finish = (error?: string) => {
        if (stale()) return;
        analystCtrl = null;
        patchMessage(asst.id, (m) => ({ ...m, pending: false, ...(error ? { error } : {}) }));
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
        const events = matchingReplay(trimmed);
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
          const events = matchingReplay(trimmed);
          if (events) {
            patchMessage(asst.id, (m) => ({ ...m, content: "", tools: [] }));
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
    applyUIAction: (a) => {
      switch (a.kind) {
        case "select_node":
          if (a.node_id) void get().selectNode(a.node_id, { fly: false });
          break;
        case "fly_to":
          if (a.node_id) world().flyToNode(a.node_id);
          else if (a.node_ids.length) world().flyToNodes(a.node_ids);
          break;
        case "highlight":
          set({
            highlight: {
              node_ids: a.node_ids,
              edge_ids: a.edge_ids,
              label: a.label ?? null,
              tone: a.tone ?? "info",
              source: "ai",
            },
          });
          break;
        case "clear_highlights":
          set({ highlight: null });
          break;
        case "show_trace":
          if (a.trace) {
            traceSeq++;
            // the analyst is showing a component's connections: the diff view would hide them
            set((s) => ({
              trace: a.trace,
              traceVisible: true,
              ...(s.compareView === "diff" && s.comparison ? { compareView: viewOutsideDiff(s) } : {}),
            }));
          }
          break;
        case "show_simulation":
          if (a.result) {
            const r = a.result;
            const slot = a.slot ?? "active";
            set((s) => ({
              result: r,
              compareView: null,
              // keep analyst highlights (this same turn may have just set one); user ones are stale
              highlight: dropUserHighlight(s.highlight),
              slots: slot === "A" ? { ...s.slots, A: r } : slot === "B" ? { ...s.slots, B: r } : s.slots,
              playback: { step: 0, maxStep: maxStepOf(r), playing: true, runId: s.playback.runId + 1 },
            }));
          }
          break;
        case "show_comparison":
          if (a.comparison) {
            const c = a.comparison;
            set((s) => adoptComparison(s, c));
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
      finishPendingReveal();
      settleCancelledRuns();
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
      set({ demo: { active: true, step: i, busy: true } });
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
          case "select_node":
            if (!get().deepMode) get().setDeepMode(true);
            await get().selectNode(focus, { fly: true });
            break;
          case "trace":
            if (get().selectedNodeId !== focus) await get().selectNode(focus, { fly: true });
            if (!current()) return;
            // reached by a step chip from the compare step: the diff view would hide the trace
            if (get().compareView === "diff") set((s) => ({ compareView: viewOutsideDiff(s) }));
            await get().showTrace(focus);
            break;
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
                  highlight: existing === s.result ? s.highlight : dropUserHighlight(s.highlight),
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
            set((s) => ({ panels: { ...s.panels, analyst: true } }));
            if (!step.question) break;
            // The scripted question is about scenario A (and the offline replay was recorded for A
            // only). Reached by Prev (after simulate_b) or a step chip, put A on screen first.
            const shown = get().result;
            if (presetA && !(shown && sameScenario(shown.scenario, presetA.scenario))) {
              const existing = get().slots.A;
              if (existing && sameScenario(existing.scenario, presetA.scenario)) get().showSlot("A");
              else {
                get().hideTrace();
                await get().runSimulation(presetA.scenario, "A", guard);
                if (!current()) return;
              }
            }
            // sendAnalystMessage ignores calls while another answer is streaming: wait for it
            // instead of silently skipping the scripted question.
            await waitUntil(() => !get().analystPending || !current());
            if (!current()) return;
            await get().sendAnalystMessage(step.question);
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
          case "compare":
            if (!get().slots.A && presetA) await get().runSimulation(presetA.scenario, "A", guard);
            if (!current()) return;
            if (!get().slots.B && presetB) await get().runSimulation(presetB.scenario, "B", guard);
            if (!current()) return;
            await get().runComparison(undefined, undefined, guard);
            break;
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
