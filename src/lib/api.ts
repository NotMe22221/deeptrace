/**
 * DEEPTRACE API client.
 *
 * Talks to the FastAPI backend (NEXT_PUBLIC_DEEPTRACE_API_URL, default http://localhost:8000).
 * If the backend is unreachable the app falls back to an OFFLINE SNAPSHOT exported by the
 * same Python engine (public/demo/snapshot.json + public/demo/network.json). Snapshot results
 * are genuine engine outputs computed ahead of time; the UI labels them as such.
 */
import type {
  AnalystEvent,
  AnalystRequest,
  DemoScript,
  DemoSnapshot,
  HealthStatus,
  InfrastructureNetwork,
  NetworkMetrics,
  NodeDetails,
  PathResult,
  ScenarioComparison,
  ScenarioInput,
  ScenarioPreset,
  SimulationResult,
  TraceResult,
} from "@/types/infrastructure";

export const API_BASE = (process.env.NEXT_PUBLIC_DEEPTRACE_API_URL || "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 20000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: init?.signal ?? ctrl.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail ?? body);
      } catch {
        /* ignore */
      }
      throw new ApiError(detail || `HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error)?.name === "AbortError") throw new ApiError("Request timed out");
    throw new ApiError((e as Error)?.message || "Network error");
  } finally {
    clearTimeout(timeout);
  }
}

export const liveApi = {
  health: () => request<HealthStatus>("/api/health", { timeoutMs: 4000 }),
  network: () => request<InfrastructureNetwork>("/api/network"),
  baseline: () => request<SimulationResult>("/api/baseline"),
  metrics: () => request<NetworkMetrics>("/api/network/metrics", { timeoutMs: 60000 }),
  presets: () => request<ScenarioPreset[]>("/api/scenarios/presets"),
  demoScript: () => request<DemoScript>("/api/demo/script"),
  nodeDetails: (id: string) => request<NodeDetails>(`/api/nodes/${encodeURIComponent(id)}`),
  trace: (id: string, maxDepth = 8) =>
    request<TraceResult>(`/api/trace/${encodeURIComponent(id)}?max_depth=${maxDepth}`),
  path: (from: string, to: string) =>
    request<PathResult>(`/api/path?from_node=${encodeURIComponent(from)}&to_node=${encodeURIComponent(to)}`),
  simulate: (scenario: ScenarioInput) =>
    request<SimulationResult>("/api/simulate", { method: "POST", body: JSON.stringify(scenario), timeoutMs: 60000 }),
  compare: (a: ScenarioInput, b: ScenarioInput) =>
    request<ScenarioComparison>("/api/compare", {
      method: "POST",
      body: JSON.stringify({ scenario_a: a, scenario_b: b }),
      timeoutMs: 60000,
    }),
};

/**
 * Streams analyst events from the backend (Server-Sent Events over a POST body).
 * Resolves when the stream ends.
 */
export async function streamAnalyst(
  req: AnalystRequest,
  onEvent: (ev: AnalystEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/analyst/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new ApiError(`Analyst request failed (${res.status})`, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AnalystEvent);
      } catch {
        /* ignore malformed event */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Offline snapshot
// ---------------------------------------------------------------------------

export interface OfflineBundle {
  network: InfrastructureNetwork;
  /** Null when only the network snapshot exists (engine snapshot not exported yet). */
  snapshot: DemoSnapshot | null;
}

export async function loadOfflineBundle(): Promise<OfflineBundle> {
  const networkRes = await fetch("/demo/network.json");
  if (!networkRes.ok) throw new ApiError("Offline network snapshot missing (public/demo/network.json)");
  const network = (await networkRes.json()) as InfrastructureNetwork;
  let snapshot: DemoSnapshot | null = null;
  try {
    const r = await fetch("/demo/snapshot.json");
    if (r.ok) snapshot = (await r.json()) as DemoSnapshot;
  } catch {
    snapshot = null;
  }
  return { network, snapshot };
}

const sameSet = (a: string[] = [], b: string[] = []) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** Re-expand a delta-encoded snapshot result (see DemoSnapshot.single_failures_encoding). */
export function expandDelta(r: SimulationResult, baseline: SimulationResult): SimulationResult {
  const unreachable = new Set(r.reachable_nodes);
  return {
    ...r,
    node_states: { ...baseline.node_states, ...r.node_states },
    edge_states: { ...baseline.edge_states, ...r.edge_states },
    edge_flows: { ...baseline.edge_flows, ...r.edge_flows },
    reachable_nodes: baseline.reachable_nodes.filter((id) => !unreachable.has(id)),
    assumptions: r.assumptions.length ? r.assumptions : baseline.assumptions,
  };
}

/** Resolve a scenario against the precomputed snapshot. Returns null if it was not precomputed. */
export function snapshotSimulate(snapshot: DemoSnapshot, scenario: ScenarioInput): SimulationResult | null {
  for (const preset of snapshot.presets) {
    const r = snapshot.preset_results[preset.id];
    if (
      r &&
      sameSet(preset.scenario.failed_nodes, scenario.failed_nodes) &&
      sameSet(preset.scenario.failed_edges, scenario.failed_edges) &&
      preset.scenario.horizon_hours === scenario.horizon_hours &&
      preset.scenario.enable_restoration === scenario.enable_restoration
    ) {
      return r;
    }
  }
  if (
    snapshot.single_failures &&
    scenario.failed_nodes.length === 1 &&
    scenario.failed_edges.length === 0 &&
    scenario.horizon_hours === 4 &&
    scenario.enable_restoration
  ) {
    const r = snapshot.single_failures[scenario.failed_nodes[0]];
    if (!r) return null;
    return snapshot.single_failures_encoding === "delta_from_baseline" ? expandDelta(r, snapshot.baseline) : r;
  }
  return null;
}

export function snapshotCompare(
  snapshot: DemoSnapshot,
  a: ScenarioInput,
  b: ScenarioInput,
): ScenarioComparison | null {
  for (const cmp of Object.values(snapshot.comparisons)) {
    if (
      sameSet(cmp.scenario_a.scenario.failed_nodes, a.failed_nodes) &&
      sameSet(cmp.scenario_a.scenario.failed_edges, a.failed_edges) &&
      sameSet(cmp.scenario_b.scenario.failed_nodes, b.failed_nodes) &&
      sameSet(cmp.scenario_b.scenario.failed_edges, b.failed_edges)
    ) {
      return cmp;
    }
  }
  return null;
}

export const emptyScenario = (overrides: Partial<ScenarioInput> = {}): ScenarioInput => ({
  scenario_id: null,
  name: null,
  scenario_type: "custom",
  failed_nodes: [],
  failed_edges: [],
  horizon_hours: 4,
  enable_restoration: true,
  max_cascade_rounds: 8,
  ...overrides,
});
