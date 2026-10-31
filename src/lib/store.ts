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
  runSimulation: (scenario?: ScenarioInput, slot?: SimSlot) => Promise<SimulationResult | null>;
  setPlaybackStep: (step: number) => void;
  setPlaying: (playing: boolean) => void;
  replayCascade: () => void;
  showSlot: (slot: "A" | "B") => void;
  runComparison: (a?: ScenarioInput, b?: ScenarioInput) => Promise<ScenarioComparison | null>;
  setCompareView: (v: "A" | "B" | "diff" | null) => void;
  clearSimulation: () => void;
  restoreWorld: () => void;

  sendAnalystMessage: (text: string, opts?: { forceOffline?: boolean }) => Promise<void>;
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

/** Build the minimal TraceResult locally from the network when the backend is offline. */
function localTrace(index: NetworkIndex, nodeId: string): TraceResult {
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
    upstream: neighbours,
    downstream: [],
    dependencies,
    dependents,
    physical_edge_ids: physical,
    dependency_edge_ids: dependency,
    source_paths: [],
    summary: "Direct connections only (offline snapshot — full upstream/downstream tracing requires the live engine).",
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useStore = create<DeeptraceState>((set, get) => {
  /** Simulate against the live engine or the offline snapshot. */
  async function simulate(scenario: ScenarioInput): Promise<SimulationResult> {
    const { dataMode, snapshot } = get();
    if (dataMode === "live") return liveApi.simulate(scenario);
    if (snapshot) {
      const r = snapshotSimulate(snapshot, scenario);
      if (r) return r;
    }
    throw new ApiError(
      "This scenario was not precomputed in the offline snapshot. Start the DEEPTRACE engine (backend) to run arbitrary scenarios.",
    );
  }

  async function compare(a: ScenarioInput, b: ScenarioInput): Promise<ScenarioComparison> {
    const { dataMode, snapshot } = get();
    if (dataMode === "live") return liveApi.compare(a, b);
    if (snapshot) {
      const c = snapshotCompare(snapshot, a, b);
      if (c) return c;
    }
    throw new ApiError("This comparison was not precomputed in the offline snapshot. Start the backend engine.");
  }

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
    showDependencies: true,
    showParticles: true,
    showLabels: true,
    deepMode: false,
    depthScale: 8,
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
      const { dataMode, index } = get();
      if (dataMode === "live") {
        try {
          const details = await liveApi.nodeDetails(id);
          if (get().selectedNodeId === id) set({ details, detailsLoading: false });
        } catch {
          if (get().selectedNodeId === id) set({ detailsLoading: false });
        }
      } else if (index) {
        const node = index.nodes.get(id);
        if (node) {
          const tr = localTrace(index, id);
          const rank = get().metrics?.criticality_ranking.findIndex((c) => c.node_id === id) ?? -1;
          const entry = rank >= 0 ? get().metrics!.criticality_ranking[rank] : null;
          set({
            details: {
              node,
              connected_node_ids: [...tr.upstream, ...tr.dependencies, ...tr.dependents].map((h) => h.node_id),
              connected_edge_ids: [...tr.physical_edge_ids, ...tr.dependency_edge_ids],
              upstream_ids: [],
              downstream_ids: [],
              dependency_ids: tr.dependencies.map((h) => h.node_id),
              dependent_ids: tr.dependents.map((h) => h.node_id),
              criticality_rank: rank >= 0 ? rank + 1 : null,
              criticality_score: entry?.affected_count ?? null,
              is_single_point_of_failure: false,
              baseline_state: get().baseline?.node_states[id] ?? "operational",
            },
            detailsLoading: false,
          });
        }
      }
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
      const { dataMode, index } = get();
      try {
        const trace = dataMode === "live" ? await liveApi.trace(nodeId) : index ? localTrace(index, nodeId) : null;
        if (trace) set({ trace, traceVisible: true });
      } catch (e) {
        set({ simError: `Trace failed: ${(e as Error).message}` });
      }
    },
    hideTrace: () => set({ traceVisible: false }),
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
    runSimulation: async (scenario, slot = "active") => {
      const input = scenario ?? get().draft;
      if (!input.failed_nodes.length && !input.failed_edges.length) {
        set({ simError: "Select at least one component or connection to fail.", simStatus: "error" });
        return null;
      }
      set({ simStatus: "running", simError: null });
      try {
        const result = await simulate(input);
        set((s) => ({
          result,
          simStatus: "idle",
          compareView: null,
          slots: slot === "A" ? { ...s.slots, A: result } : slot === "B" ? { ...s.slots, B: result } : s.slots,
          playback: { step: 0, maxStep: maxStepOf(result), playing: true, runId: s.playback.runId + 1 },
          panels: { ...s.panels, simulation: true },
        }));
        return result;
      } catch (e) {
        set({ simStatus: "error", simError: (e as Error).message });
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
        playback: { step: maxStepOf(r), maxStep: maxStepOf(r), playing: false, runId: s.playback.runId + 1 },
      }));
    },
    runComparison: async (a, b) => {
      const A = a ?? get().slots.A?.scenario;
      const B = b ?? get().slots.B?.scenario;
      if (!A || !B) {
        set({ simError: "Run two scenarios (A and B) before comparing.", compareStatus: "error" });
        return null;
      }
      set({ compareStatus: "running", simError: null });
      try {
        const comparison = await compare(A, B);
        set((s) => ({
          comparison,
          compareStatus: "idle",
          compareView: "diff",
          slots: { A: comparison.scenario_a, B: comparison.scenario_b },
          panels: { ...s.panels, comparison: true },
        }));
        return comparison;
      } catch (e) {
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
          playback: r
            ? { step: maxStepOf(r), maxStep: maxStepOf(r), playing: false, runId: s.playback.runId + 1 }
            : s.playback,
        }));
      } else set({ compareView: v });
    },
    clearSimulation: () =>
      set((s) => ({
        result: null,
        simStatus: "idle",
        simError: null,
        compareView: null,
        playback: { step: 0, maxStep: 0, playing: false, runId: s.playback.runId + 1 },
      })),
    restoreWorld: () => {
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
        deepMode: false,
        panels: { ...DEFAULT_PANELS, analyst: s.panels.analyst },
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
      set((s) => ({
        messages: [...s.messages, userMsg, asst],
        analystPending: true,
        panels: { ...s.panels, analyst: true },
      }));

      const onEvent = (ev: AnalystEvent) => {
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

      if (s0.dataMode !== "live") {
        // Offline snapshot: replay a recorded offline-analyst answer when one exists for this
        // exact question (demo safety net); otherwise explain that the analyst needs the engine.
        const replay = s0.snapshot?.analyst_replays?.[trimmed];
        if (replay?.length) {
          for (const ev of replay) {
            onEvent(ev);
            if (ev.type === "tool_result") await sleep(220);
          }
          patchMessage(asst.id, (m) => ({ ...m, pending: false }));
          set({ analystPending: false });
          return;
        }
        patchMessage(asst.id, (m) => ({
          ...m,
          pending: false,
          error:
            "The AI analyst needs the DEEPTRACE engine (backend) so it can call simulation tools. It is not available in offline snapshot mode.",
        }));
        set({ analystPending: false });
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
        );
      } catch (e) {
        patchMessage(asst.id, (m) => ({ ...m, error: (e as Error).message }));
      } finally {
        patchMessage(asst.id, (m) => ({ ...m, pending: false }));
        set({ analystPending: false });
      }
    },
    clearChat: () => set({ messages: [] }),
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
          if (a.trace) set({ trace: a.trace, traceVisible: true });
          break;
        case "show_simulation":
          if (a.result) {
            const r = a.result;
            const slot = a.slot ?? "active";
            set((s) => ({
              result: r,
              compareView: null,
              slots: slot === "A" ? { ...s.slots, A: r } : slot === "B" ? { ...s.slots, B: r } : s.slots,
              playback: { step: 0, maxStep: maxStepOf(r), playing: true, runId: s.playback.runId + 1 },
            }));
          }
          break;
        case "show_comparison":
          if (a.comparison) {
            const c = a.comparison;
            set((s) => ({
              comparison: c,
              compareView: "diff",
              slots: { A: c.scenario_a, B: c.scenario_b },
              panels: { ...s.panels, comparison: true },
            }));
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
    exitDemo: () => set({ demo: { active: false, step: 0, busy: false } }),
    resetDemo: () => {
      get().restoreWorld();
      set({ demo: { active: true, step: 0, busy: false }, messages: [] });
      void get().demoGoto(0);
    },
    demoGoto: async (stepIndex) => {
      const script = get().demoScript;
      if (!script) return;
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
            get().setAllLayers(false);
            const order: LayerKey[] = ["underground", "water", "power", "telecom", "transport", "facility"];
            for (const k of order) {
              await sleep(550);
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
            await get().showTrace(focus);
            break;
          case "simulate":
          case "cascade": {
            if (presetA) {
              set({ draft: { ...presetA.scenario } });
              const existing = get().slots.A;
              if (step.action === "cascade" && existing) {
                set((s) => ({ result: existing, compareView: null }));
                get().replayCascade();
              } else {
                set({ traceVisible: false });
                await get().runSimulation(presetA.scenario, "A");
              }
              const r = get().result;
              if (r && step.action === "cascade") {
                world().flyToNodes(r.affected_nodes.map((a) => a.node_id));
              }
            }
            break;
          }
          case "ask_ai":
            set((s) => ({ panels: { ...s.panels, analyst: true } }));
            if (step.question) await get().sendAnalystMessage(step.question);
            break;
          case "simulate_b":
            if (presetB) {
              set({ draft: { ...presetB.scenario } });
              await get().runSimulation(presetB.scenario, "B");
              const r = get().result;
              if (r) world().flyToNodes(r.affected_nodes.map((a) => a.node_id));
            }
            break;
          case "compare":
            if (!get().slots.A && presetA) await get().runSimulation(presetA.scenario, "A");
            if (!get().slots.B && presetB) await get().runSimulation(presetB.scenario, "B");
            await get().runComparison();
            break;
        }
      } finally {
        set((s) => ({ demo: { ...s.demo, busy: false } }));
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
