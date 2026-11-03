"""DEEPTRACE data contract.

These Pydantic models are the single source of truth for every structure exchanged
between the dataset generator, the simulation engine, the AI analyst and the frontend.
`src/types/infrastructure.ts` mirrors them field-for-field — keep both in sync.

Conventions
-----------
* Coordinates are WGS84 decimal degrees. Geometry arrays are ``[longitude, latitude]``.
* ``InfrastructureNode.elevation`` is metres relative to the local ground surface
  (negative = below ground). It is *not* an ellipsoid height; the renderer samples the
  terrain and applies the offset (with an optional visual depth exaggeration).
* ``InfrastructureEdge.depth_m`` is burial depth below ground (0 = at/above surface).
* Every node, edge and dataset carries a :class:`Provenance` record. The four
  provenance categories are shown verbatim in the UI and must never be upgraded
  without inspecting the underlying data.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------


class SystemType(str, Enum):
    POWER = "power"
    WATER = "water"
    TELECOM = "telecom"
    TRANSPORT = "transport"
    UNDERGROUND = "underground"  # shared utility corridors: duct banks, utility tunnels, vaults
    FACILITY = "facility"  # critical facilities that consume infrastructure services


class ProvenanceCategory(str, Enum):
    VERIFIED = "verified"  # authoritative source, inspected and checked
    PUBLICLY_MAPPED = "publicly_mapped"  # present in a public map dataset (e.g. OpenStreetMap)
    ESTIMATED = "estimated"  # approximate value derived from general/public knowledge, not surveyed
    SIMULATED = "simulated"  # illustrative, generated for modelling; does not describe a real asset


class Relation(str, Enum):
    PHYSICAL = "physical"  # a physical conduit: cable, pipe, fibre, road, rail, duct bank
    DEPENDENCY = "dependency"  # a logical service dependency (provider -> consumer)


# Node types per system. Stored as plain strings on the model so new types can be
# added by data ingestion without a schema change; these lists document the
# vocabulary the engine and renderer understand.
NODE_TYPES: dict[str, list[str]] = {
    "power": [
        "transmission_substation",  # bulk supply point (source), capacity in MW
        "distribution_substation",  # feeds 12.47 kV distribution feeders, capacity in MW
        "switch",  # sectionalising or tie switch (properties.normally_open)
        "network_vault",  # underground transformer vault serving local load (demand in MW)
    ],
    "water": [
        "supply_source",  # treated-water transmission main entry point (source), capacity L/s
        "pump_station",  # booster pump (needs power), capacity L/s
        "storage_tank",  # elevated storage, properties.storage_m3
        "valve",  # isolation valve (properties.normally_closed for zone boundaries)
        "junction",  # pipe junction
        "service_zone",  # demand node, demand in L/s, properties.population
    ],
    "telecom": [
        "internet_exchange",  # core / carrier hotel (source)
        "central_office",  # aggregation exchange
        "data_center",
        "fiber_hub",  # splice / aggregation point
        "cell_site",  # radio access site, properties.backup_hours
        "access_node",  # fixed access cabinet serving an area, demand in Gbps
    ],
    "transport": [
        "intersection",  # properties.signalized
        "gateway",  # district entry/exit (highway ramp) used for O-D analysis
        "transit_station",  # rail station
    ],
    "underground": [
        "utility_vault",  # access vault / manhole joining corridor segments
    ],
    "facility": [
        "hospital",
        "emergency_services",
        "government",
        "university",
        "venue",
        "transit_hub",
        "commercial",
    ],
}

EDGE_CONNECTION_TYPES: dict[str, list[str]] = {
    "physical": [
        "transmission_line",
        "feeder_cable",
        "tie_line",  # normally-open tie between feeders
        "water_main",  # transmission main
        "distribution_main",
        "fiber_link",
        "road_segment",
        "rail_segment",
        "duct_bank",  # underground corridor segment hosting other edges
        "utility_tunnel",
    ],
    "dependency": [
        "power_supply",
        "water_supply",
        "telecom_link",
        "road_access",
        "control_link",  # e.g. SCADA / signal control over telecom
    ],
}

NodeState = Literal[
    "operational",  # nominal
    "failed",  # directly failed by the scenario (or tripped)
    "de_energized",  # power: no path to a source
    "restored",  # power: re-energised through automatic switching
    "overloaded",  # loading above rating
    "on_backup",  # running on backup (generator / battery / storage) within horizon
    "degraded",  # partial service
    "outage",  # no service
    "disconnected",  # telecom: no path to core
    "isolated",  # water: isolated by valve closure
    "inaccessible",  # transport: cannot be reached
    "delayed",  # transport: reachable with increased travel time
    "closed",  # transit station / road closed
]

EdgeState = Literal[
    "operational",
    "failed",  # directly failed (rupture, cut, closure)
    "interrupted",  # carries no service because an upstream element failed
    "isolated",  # water: valved off
    "overloaded",
    "rerouted",  # carries traffic/flow that was rerouted onto it
    "activated",  # normally-open element closed to restore service
    "normally_open",  # idle tie / open valve in nominal state
]

Severity = Literal["critical", "major", "minor", "info"]

ScenarioType = Literal[
    "power_failure",
    "water_rupture",
    "telecom_outage",
    "road_disruption",
    "corridor_strike",
    "custom",
]

# ---------------------------------------------------------------------------
# Provenance
# ---------------------------------------------------------------------------


class Provenance(BaseModel):
    category: ProvenanceCategory
    source: str = Field(description="Human-readable source, e.g. 'OpenStreetMap contributors via Overpass API'")
    source_url: str | None = None
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence that the item reflects reality (0-1)")
    retrieved_at: str | None = Field(default=None, description="ISO-8601 date the data was retrieved, for fetched data")
    license: str | None = None
    notes: str | None = None


class DatasetInfo(BaseModel):
    id: str
    name: str
    category: ProvenanceCategory
    source: str
    source_url: str | None = None
    license: str | None = None
    retrieved_at: str | None = None
    feature_count: int = 0
    systems: list[SystemType] = Field(default_factory=list)
    notes: str | None = None
    inspected: bool = Field(
        default=False, description="True only if the dataset content was actually inspected by the pipeline"
    )


# ---------------------------------------------------------------------------
# Region
# ---------------------------------------------------------------------------


class CameraView(BaseModel):
    longitude: float
    latitude: float
    height: float = Field(description="Camera height above ellipsoid, metres")
    heading: float = Field(default=0.0, description="Degrees, 0 = north")
    pitch: float = Field(default=-35.0, description="Degrees, negative looks down")
    roll: float = 0.0


class RegionInfo(BaseModel):
    id: str
    name: str
    city: str
    bbox: tuple[float, float, float, float] = Field(description="(south, west, north, east) in degrees")
    center: tuple[float, float] = Field(description="(latitude, longitude)")
    default_camera: CameraView
    ground_elevation_m: float = Field(
        description="Approximate terrain ellipsoid height used when no terrain provider is available"
    )
    timezone: str = "UTC"
    description: str | None = None


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------


class InfrastructureNode(BaseModel):
    id: str
    name: str
    system: SystemType
    type: str
    latitude: float
    longitude: float
    elevation: float = Field(default=0.0, description="Metres relative to ground surface (negative = underground)")
    status: NodeState = "operational"
    provenance: Provenance
    capacity: float | None = None
    capacity_unit: str | None = None
    demand: float | None = Field(default=None, description="Modelled baseline demand/load in capacity_unit")
    critical: bool = False
    description: str | None = None
    properties: dict[str, Any] = Field(default_factory=dict)


class InfrastructureEdge(BaseModel):
    id: str
    source_node: str
    target_node: str
    infrastructure_type: SystemType = Field(description="System the edge belongs to")
    connection_type: str
    relation: Relation = Relation.PHYSICAL
    directed: bool = False
    capacity: float | None = None
    capacity_unit: str | None = None
    length_m: float = 0.0
    status: EdgeState = "operational"
    depth_m: float = Field(default=0.0, description="Burial depth below ground in metres (0 = surface)")
    geometry: list[tuple[float, float]] = Field(
        default_factory=list, description="Route as [lon, lat] vertices, including both endpoints"
    )
    corridor_id: str | None = Field(default=None, description="Underground corridor edge hosting this edge")
    provenance: Provenance
    name: str | None = None
    properties: dict[str, Any] = Field(default_factory=dict)


class InfrastructureNetwork(BaseModel):
    id: str
    name: str
    version: str
    generated_at: str
    description: str | None = None
    region: RegionInfo
    nodes: list[InfrastructureNode]
    edges: list[InfrastructureEdge]
    datasets: list[DatasetInfo] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Scenarios & simulation
# ---------------------------------------------------------------------------


class ScenarioInput(BaseModel):
    scenario_id: str | None = Field(default=None, description="Optional caller id; a deterministic hash is used if empty")
    name: str | None = None
    scenario_type: ScenarioType = "custom"
    failed_nodes: list[str] = Field(default_factory=list, max_length=200)
    failed_edges: list[str] = Field(default_factory=list, max_length=200)
    horizon_hours: float = Field(
        default=4.0, ge=0.0, le=168.0, allow_inf_nan=False, description="Hours after onset at which impacts are assessed"
    )
    enable_restoration: bool = Field(default=True, description="Allow automatic switching / rerouting / detours")
    max_cascade_rounds: int = Field(default=8, ge=1, le=20)


class ScenarioPreset(BaseModel):
    id: str
    name: str
    scenario_type: ScenarioType
    description: str
    scenario: ScenarioInput
    focus_node_id: str | None = None


class AffectedNode(BaseModel):
    node_id: str
    system: SystemType
    state: NodeState
    severity: Severity
    step: int = Field(description="Cascade round in which the state first appeared (0 = initiating failure)")
    cause: str = Field(description="Human-readable explanation of why the node is affected")
    caused_by: list[str] = Field(default_factory=list, description="Upstream node/edge ids responsible")
    service_level: float = Field(ge=0.0, le=1.0, description="Remaining service fraction (1 = full service)")


class InterruptedEdge(BaseModel):
    edge_id: str
    system: SystemType
    state: EdgeState
    reason: str
    step: int


class AlternativePath(BaseModel):
    id: str
    system: SystemType
    purpose: str = Field(description="e.g. 'tie-switch restoration', 'fibre reroute', 'traffic detour'")
    from_node: str
    to_node: str
    node_ids: list[str]
    edge_ids: list[str]
    description: str
    capacity_ok: bool = True
    added_length_m: float | None = None
    added_time_s: float | None = None


class EdgeFlow(BaseModel):
    direction: int = Field(description="1 = source_node->target_node, -1 = reverse, 0 = no flow")
    utilization: float = Field(ge=0.0, description="Flow / capacity (may exceed 1 when overloaded)")
    flow: float = 0.0
    unit: str | None = None


class CascadeStep(BaseModel):
    step: int
    label: str
    description: str
    systems: list[SystemType] = Field(default_factory=list)
    node_ids: list[str] = Field(default_factory=list)
    edge_ids: list[str] = Field(default_factory=list)


class SystemImpact(BaseModel):
    system: SystemType
    nodes_total: int
    nodes_affected: int
    metric_name: str
    baseline_value: float
    remaining_value: float
    unit: str
    percent_served: float
    reachable_fraction: float = Field(description="Fraction of system nodes still connected to a source/core")
    notes: list[str] = Field(default_factory=list)


class ImpactMetrics(BaseModel):
    total_nodes_affected: int
    critical_facilities_affected: list[str]
    population_affected_estimate: int = Field(description="Modelled residents/occupants in affected service areas")
    power_load_unserved_mw: float
    water_demand_unserved_lps: float
    telecom_nodes_disconnected: int
    transport_travel_time_increase_pct: float
    transit_stations_closed: int
    redundancy_score: float = Field(ge=0.0, le=1.0, description="Share of affected demand restored via alternative paths")
    severity_index: float = Field(ge=0.0, le=100.0, description="Composite 0-100 index; formula documented in README")
    per_system: list[SystemImpact]


class SimulationResult(BaseModel):
    scenario_id: str
    scenario: ScenarioInput
    network_id: str
    failed_nodes: list[str]
    failed_edges: list[str]
    affected_nodes: list[AffectedNode]
    interrupted_edges: list[InterruptedEdge]
    reachable_nodes: list[str] = Field(description="Nodes that still receive service from a source/core")
    alternative_paths: list[AlternativePath]
    impact_metrics: ImpactMetrics
    cascade_steps: list[CascadeStep]
    node_states: dict[str, NodeState] = Field(description="State of every node after the scenario")
    edge_states: dict[str, EdgeState] = Field(description="State of every edge after the scenario")
    edge_flows: dict[str, EdgeFlow] = Field(description="Modelled flow direction/utilisation per physical edge")
    assumptions: list[str]
    timestamp: str
    engine_version: str
    computation_ms: float
    summary: str = Field(description="One-paragraph deterministic summary of the outcome")


class ComparisonMetric(BaseModel):
    key: str
    label: str
    unit: str
    a: float
    b: float
    delta: float = Field(description="b - a")
    higher_is_worse: bool = True
    worse: Literal["a", "b", "equal"]


class ScenarioComparison(BaseModel):
    scenario_a: SimulationResult
    scenario_b: SimulationResult
    metrics: list[ComparisonMetric]
    only_in_a: list[str]
    only_in_b: list[str]
    in_both: list[str]
    verdict: str
    summary: str


# ---------------------------------------------------------------------------
# Tracing, details, metrics
# ---------------------------------------------------------------------------


class TraceHop(BaseModel):
    node_id: str
    via_edge_id: str | None
    depth: int
    relation: Relation
    system: SystemType


class TraceResult(BaseModel):
    node_id: str
    upstream: list[TraceHop] = Field(description="Nodes this node draws service from (towards sources)")
    downstream: list[TraceHop] = Field(description="Nodes that draw service through this node")
    dependencies: list[TraceHop] = Field(description="Cross-system providers this node logically depends on")
    dependents: list[TraceHop] = Field(description="Cross-system consumers that logically depend on this node")
    physical_edge_ids: list[str]
    dependency_edge_ids: list[str]
    source_paths: list[list[str]] = Field(description="Node-id paths from this node to each reachable source/core")
    summary: str


class NodeDetails(BaseModel):
    node: InfrastructureNode
    connected_node_ids: list[str]
    connected_edge_ids: list[str]
    upstream_ids: list[str]
    downstream_ids: list[str]
    dependency_ids: list[str]
    dependent_ids: list[str]
    criticality_rank: int | None = None
    criticality_score: float | None = Field(default=None, description="Nodes affected by this node's single failure")
    is_single_point_of_failure: bool = False
    baseline_state: NodeState = "operational"


class SystemMetrics(BaseModel):
    system: SystemType
    node_count: int
    edge_count: int
    connected_components: int
    average_degree: float
    articulation_points: list[str]
    top_betweenness: list[tuple[str, float]]
    redundancy_fraction: float = Field(description="Share of demand nodes with >=2 edge-disjoint paths to a source")


class CriticalityEntry(BaseModel):
    node_id: str
    system: SystemType
    affected_count: int
    critical_facilities_affected: int
    severity_index: float


class NetworkMetrics(BaseModel):
    network_id: str
    systems: list[SystemMetrics]
    criticality_ranking: list[CriticalityEntry] = Field(description="N-1 single-failure ranking, worst first")
    cross_system_dependencies: int
    provenance_counts: dict[str, dict[str, int]] = Field(description="system -> provenance category -> count")


class PathResult(BaseModel):
    from_node: str
    to_node: str
    found: bool
    node_ids: list[str]
    edge_ids: list[str]
    length_m: float
    systems: list[SystemType]
    description: str


# ---------------------------------------------------------------------------
# AI analyst
# ---------------------------------------------------------------------------


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=64_000)  # generous: assistant answers can be long and are resent as history


class AnalystContext(BaseModel):
    selected_node_id: str | None = None
    selected_edge_id: str | None = None
    active_scenario: ScenarioInput | None = None
    scenario_a: ScenarioInput | None = None
    scenario_b: ScenarioInput | None = None


class AnalystRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=40)
    context: AnalystContext = Field(default_factory=AnalystContext)
    force_offline: bool = False


class UIAction(BaseModel):
    """Instruction for the frontend emitted from *tool results* (never from free text)."""

    kind: Literal[
        "select_node",
        "fly_to",
        "highlight",
        "show_trace",
        "show_simulation",
        "show_comparison",
        "clear_highlights",
    ]
    node_id: str | None = None
    node_ids: list[str] = Field(default_factory=list)
    edge_ids: list[str] = Field(default_factory=list)
    label: str | None = None
    tone: Literal["info", "warning", "critical", "success"] | None = None
    slot: Literal["active", "A", "B"] | None = None
    trace: TraceResult | None = None
    result: SimulationResult | None = None
    comparison: ScenarioComparison | None = None


class HealthStatus(BaseModel):
    status: Literal["ok"]
    version: str
    network_id: str
    region_id: str
    node_count: int
    edge_count: int
    llm_available: bool
    llm_provider: str | None
    llm_model: str | None


# ---------------------------------------------------------------------------
# Demo mode
# ---------------------------------------------------------------------------


class DemoStep(BaseModel):
    id: str
    title: str
    narration: str
    action: Literal[
        "overview",
        "deep_mode",
        "reveal_layers",
        "select_node",
        "trace",
        "simulate",
        "cascade",
        "ask_ai",
        "simulate_b",
        "compare",
    ]
    node_id: str | None = None
    preset_id: str | None = None
    question: str | None = None


class DemoScript(BaseModel):
    id: str
    title: str
    steps: list[DemoStep]
    scenario_a_preset: str
    scenario_b_preset: str
    focus_node_id: str


class DemoSnapshot(BaseModel):
    """Offline snapshot exported by the engine to public/demo/snapshot.json."""

    generated_at: str
    engine_version: str
    network_id: str
    baseline: SimulationResult
    metrics: NetworkMetrics
    presets: list[ScenarioPreset]
    preset_results: dict[str, SimulationResult]
    comparisons: dict[str, ScenarioComparison]
    traces: dict[str, TraceResult]
    single_failures: dict[str, SimulationResult] | None = None
    single_failures_encoding: Literal["full", "delta_from_baseline"] = Field(
        default="full",
        description=(
            "delta_from_baseline: node_states/edge_states/edge_flows only list entries that differ from baseline, "
            "reachable_nodes lists baseline-reachable nodes that became unreachable, empty assumptions = baseline's"
        ),
    )
    demo: DemoScript
    analyst_replays: dict[str, list[dict[str, Any]]] | None = Field(
        default=None,
        description="Recorded offline-analyst event streams keyed by question (used only when the backend is down)",
    )
    spof_node_ids: list[str] | None = Field(
        default=None, description="engine single-point-of-failure set (NodeDetails.is_single_point_of_failure rule)"
    )
