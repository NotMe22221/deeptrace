/**
 * DEEPTRACE data contract — TypeScript mirror of backend/app/models/schemas.py.
 * The Python Pydantic models are the source of truth; keep these in sync field-for-field.
 *
 * Coordinates: WGS84 degrees. Geometry arrays are [longitude, latitude].
 * InfrastructureNode.elevation: metres relative to ground (negative = underground).
 * InfrastructureEdge.depth_m: burial depth below ground (0 = surface).
 */

export type SystemType = "power" | "water" | "telecom" | "transport" | "underground" | "facility";
export const SYSTEMS: SystemType[] = ["power", "water", "telecom", "transport", "underground", "facility"];

export type ProvenanceCategory = "verified" | "publicly_mapped" | "estimated" | "simulated";
export const PROVENANCE_CATEGORIES: ProvenanceCategory[] = ["verified", "publicly_mapped", "estimated", "simulated"];

export type Relation = "physical" | "dependency";

export type NodeState =
  | "operational"
  | "failed"
  | "de_energized"
  | "restored"
  | "overloaded"
  | "on_backup"
  | "degraded"
  | "outage"
  | "disconnected"
  | "isolated"
  | "inaccessible"
  | "delayed"
  | "closed";

export type EdgeState =
  | "operational"
  | "failed"
  | "interrupted"
  | "isolated"
  | "overloaded"
  | "rerouted"
  | "activated"
  | "normally_open";

export type Severity = "critical" | "major" | "minor" | "info";

export type ScenarioType =
  | "power_failure"
  | "water_rupture"
  | "telecom_outage"
  | "road_disruption"
  | "corridor_strike"
  | "custom";

export interface Provenance {
  category: ProvenanceCategory;
  source: string;
  source_url?: string | null;
  confidence: number;
  retrieved_at?: string | null;
  license?: string | null;
  notes?: string | null;
}

export interface DatasetInfo {
  id: string;
  name: string;
  category: ProvenanceCategory;
  source: string;
  source_url?: string | null;
  license?: string | null;
  retrieved_at?: string | null;
  feature_count: number;
  systems: SystemType[];
  notes?: string | null;
  inspected: boolean;
}

export interface CameraView {
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
}

export interface RegionInfo {
  id: string;
  name: string;
  city: string;
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  /** [latitude, longitude] */
  center: [number, number];
  default_camera: CameraView;
  ground_elevation_m: number;
  timezone: string;
  description?: string | null;
}

export interface InfrastructureNode {
  id: string;
  name: string;
  system: SystemType;
  type: string;
  latitude: number;
  longitude: number;
  elevation: number;
  status: NodeState;
  provenance: Provenance;
  capacity?: number | null;
  capacity_unit?: string | null;
  demand?: number | null;
  critical: boolean;
  description?: string | null;
  properties: Record<string, unknown>;
}

export interface InfrastructureEdge {
  id: string;
  source_node: string;
  target_node: string;
  infrastructure_type: SystemType;
  connection_type: string;
  relation: Relation;
  directed: boolean;
  capacity?: number | null;
  capacity_unit?: string | null;
  length_m: number;
  status: EdgeState;
  depth_m: number;
  /** [lon, lat] vertices including both endpoints */
  geometry: [number, number][];
  corridor_id?: string | null;
  provenance: Provenance;
  name?: string | null;
  properties: Record<string, unknown>;
}

export interface InfrastructureNetwork {
  id: string;
  name: string;
  version: string;
  generated_at: string;
  description?: string | null;
  region: RegionInfo;
  nodes: InfrastructureNode[];
  edges: InfrastructureEdge[];
  datasets: DatasetInfo[];
  assumptions: string[];
}

export interface ScenarioInput {
  scenario_id?: string | null;
  name?: string | null;
  scenario_type: ScenarioType;
  failed_nodes: string[];
  failed_edges: string[];
  horizon_hours: number;
  enable_restoration: boolean;
  max_cascade_rounds: number;
}

export interface ScenarioPreset {
  id: string;
  name: string;
  scenario_type: ScenarioType;
  description: string;
  scenario: ScenarioInput;
  focus_node_id?: string | null;
}

export interface AffectedNode {
  node_id: string;
  system: SystemType;
  state: NodeState;
  severity: Severity;
  step: number;
  cause: string;
  caused_by: string[];
  service_level: number;
}

export interface InterruptedEdge {
  edge_id: string;
  system: SystemType;
  state: EdgeState;
  reason: string;
  step: number;
}

export interface AlternativePath {
  id: string;
  system: SystemType;
  purpose: string;
  from_node: string;
  to_node: string;
  node_ids: string[];
  edge_ids: string[];
  description: string;
  capacity_ok: boolean;
  added_length_m?: number | null;
  added_time_s?: number | null;
}

export interface EdgeFlow {
  /** 1 = source_node -> target_node, -1 = reverse, 0 = no flow */
  direction: number;
  utilization: number;
  flow: number;
  unit?: string | null;
}

export interface CascadeStep {
  step: number;
  label: string;
  description: string;
  systems: SystemType[];
  node_ids: string[];
  edge_ids: string[];
}

export interface SystemImpact {
  system: SystemType;
  nodes_total: number;
  nodes_affected: number;
  metric_name: string;
  baseline_value: number;
  remaining_value: number;
  unit: string;
  percent_served: number;
  reachable_fraction: number;
  notes: string[];
}

export interface ImpactMetrics {
  total_nodes_affected: number;
  critical_facilities_affected: string[];
  population_affected_estimate: number;
  power_load_unserved_mw: number;
  water_demand_unserved_lps: number;
  telecom_nodes_disconnected: number;
  transport_travel_time_increase_pct: number;
  transit_stations_closed: number;
  redundancy_score: number;
  severity_index: number;
  per_system: SystemImpact[];
}

export interface SimulationResult {
  scenario_id: string;
  scenario: ScenarioInput;
  network_id: string;
  failed_nodes: string[];
  failed_edges: string[];
  affected_nodes: AffectedNode[];
  interrupted_edges: InterruptedEdge[];
  reachable_nodes: string[];
  alternative_paths: AlternativePath[];
  impact_metrics: ImpactMetrics;
  cascade_steps: CascadeStep[];
  node_states: Record<string, NodeState>;
  edge_states: Record<string, EdgeState>;
  edge_flows: Record<string, EdgeFlow>;
  assumptions: string[];
  timestamp: string;
  engine_version: string;
  computation_ms: number;
  summary: string;
}

export interface ComparisonMetric {
  key: string;
  label: string;
  unit: string;
  a: number;
  b: number;
  delta: number;
  higher_is_worse: boolean;
  worse: "a" | "b" | "equal";
}

export interface ScenarioComparison {
  scenario_a: SimulationResult;
  scenario_b: SimulationResult;
  metrics: ComparisonMetric[];
  only_in_a: string[];
  only_in_b: string[];
  in_both: string[];
  verdict: string;
  summary: string;
}

export interface TraceHop {
  node_id: string;
  via_edge_id: string | null;
  depth: number;
  relation: Relation;
  system: SystemType;
}

export interface TraceResult {
  node_id: string;
  upstream: TraceHop[];
  downstream: TraceHop[];
  dependencies: TraceHop[];
  dependents: TraceHop[];
  physical_edge_ids: string[];
  dependency_edge_ids: string[];
  source_paths: string[][];
  summary: string;
}

export interface NodeDetails {
  node: InfrastructureNode;
  connected_node_ids: string[];
  connected_edge_ids: string[];
  upstream_ids: string[];
  downstream_ids: string[];
  dependency_ids: string[];
  dependent_ids: string[];
  criticality_rank?: number | null;
  criticality_score?: number | null;
  is_single_point_of_failure: boolean;
  baseline_state: NodeState;
}

export interface SystemMetrics {
  system: SystemType;
  node_count: number;
  edge_count: number;
  connected_components: number;
  average_degree: number;
  articulation_points: string[];
  top_betweenness: [string, number][];
  redundancy_fraction: number;
}

export interface CriticalityEntry {
  node_id: string;
  system: SystemType;
  affected_count: number;
  critical_facilities_affected: number;
  severity_index: number;
}

export interface NetworkMetrics {
  network_id: string;
  systems: SystemMetrics[];
  criticality_ranking: CriticalityEntry[];
  cross_system_dependencies: number;
  provenance_counts: Record<string, Record<string, number>>;
}

export interface PathResult {
  from_node: string;
  to_node: string;
  found: boolean;
  node_ids: string[];
  edge_ids: string[];
  length_m: number;
  systems: SystemType[];
  description: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AnalystContext {
  selected_node_id?: string | null;
  selected_edge_id?: string | null;
  active_scenario?: ScenarioInput | null;
  scenario_a?: ScenarioInput | null;
  scenario_b?: ScenarioInput | null;
}

export interface AnalystRequest {
  message: string;
  history: ChatTurn[];
  context: AnalystContext;
  force_offline?: boolean;
}

export type UIActionKind =
  | "select_node"
  | "fly_to"
  | "highlight"
  | "show_trace"
  | "show_simulation"
  | "show_comparison"
  | "clear_highlights";

export interface UIAction {
  kind: UIActionKind;
  node_id?: string | null;
  node_ids: string[];
  edge_ids: string[];
  label?: string | null;
  tone?: "info" | "warning" | "critical" | "success" | null;
  slot?: "active" | "A" | "B" | null;
  trace?: TraceResult | null;
  result?: SimulationResult | null;
  comparison?: ScenarioComparison | null;
}

/** Server-sent events emitted by POST /api/analyst/chat (text/event-stream, one JSON object per `data:` line). */
export type AnalystEvent =
  | { type: "status"; mode: "llm" | "offline"; model: string | null; note?: string | null }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "ui_action"; action: UIAction }
  | { type: "message"; text: string }
  | { type: "done"; tool_calls: number; mode: "llm" | "offline" }
  | { type: "error"; message: string };

export interface HealthStatus {
  status: "ok";
  version: string;
  network_id: string;
  region_id: string;
  node_count: number;
  edge_count: number;
  llm_available: boolean;
  llm_provider: string | null;
  llm_model: string | null;
}

/** Offline snapshot exported by the Python engine (public/demo/snapshot.json). */
export interface DemoSnapshot {
  generated_at: string;
  engine_version: string;
  network_id: string;
  baseline: SimulationResult;
  metrics: NetworkMetrics;
  presets: ScenarioPreset[];
  /** keyed by preset id */
  preset_results: Record<string, SimulationResult>;
  /** keyed by `${presetA}__${presetB}` */
  comparisons: Record<string, ScenarioComparison>;
  /** keyed by node id (demo-relevant nodes only) */
  traces: Record<string, TraceResult>;
  /** keyed by node id: single-node failure results for every node (lets the UI simulate offline) */
  single_failures?: Record<string, SimulationResult>;
  demo: DemoScript;
}

export interface DemoStep {
  id: string;
  title: string;
  narration: string;
  action:
    | "overview"
    | "deep_mode"
    | "reveal_layers"
    | "select_node"
    | "trace"
    | "simulate"
    | "cascade"
    | "ask_ai"
    | "simulate_b"
    | "compare";
  node_id?: string | null;
  preset_id?: string | null;
  question?: string | null;
}

export interface DemoScript {
  id: string;
  title: string;
  steps: DemoStep[];
  scenario_a_preset: string;
  scenario_b_preset: string;
  focus_node_id: string;
}
