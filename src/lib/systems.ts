/**
 * Visual and textual vocabulary for infrastructure systems, node types, states and
 * provenance categories. Shared by the 3D renderer and the interface so colours and
 * labels are identical everywhere.
 */
import type { EdgeState, NodeState, ProvenanceCategory, Severity, SystemType } from "@/types/infrastructure";

export interface SystemStyle {
  key: SystemType;
  label: string;
  shortLabel: string;
  /** CSS hex colour */
  color: string;
  /** [r, g, b] 0-1 for Cesium */
  rgb: [number, number, number];
  description: string;
  /** flow particle behaviour */
  particle: { speed: number; spacing: number; size: number; label: string };
}

const hexToRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

const mk = (s: Omit<SystemStyle, "rgb">): SystemStyle => ({ ...s, rgb: hexToRgb(s.color) });

export const SYSTEM_STYLES: Record<SystemType, SystemStyle> = {
  water: mk({
    key: "water",
    label: "Water",
    shortLabel: "H₂O",
    color: "#22d3ee",
    description: "Treated-water mains, pumps, storage and service zones",
    particle: { speed: 28, spacing: 70, size: 7, label: "Water flow" },
  }),
  power: mk({
    key: "power",
    label: "Electricity",
    shortLabel: "PWR",
    color: "#f5b83d",
    description: "Transmission supply, substations, feeders and network vaults",
    particle: { speed: 140, spacing: 120, size: 8, label: "Energy pulse" },
  }),
  telecom: mk({
    key: "telecom",
    label: "Internet",
    shortLabel: "NET",
    color: "#a78bfa",
    description: "Carrier hotels, central offices, fibre rings and access sites",
    particle: { speed: 220, spacing: 95, size: 6, label: "Data packet" },
  }),
  transport: mk({
    key: "transport",
    label: "Transportation",
    shortLabel: "TRN",
    color: "#34d399",
    description: "Street network, highway gateways and rail transit",
    particle: { speed: 45, spacing: 60, size: 6, label: "Traffic" },
  }),
  underground: mk({
    key: "underground",
    label: "Underground utilities",
    shortLabel: "UGD",
    color: "#94a3b8",
    description: "Shared duct banks, utility tunnels and access vaults",
    particle: { speed: 0, spacing: 0, size: 0, label: "" },
  }),
  facility: mk({
    key: "facility",
    label: "Critical facilities",
    shortLabel: "FAC",
    color: "#e2e8f0",
    description: "Hospitals, emergency services, government and venues",
    particle: { speed: 0, spacing: 0, size: 0, label: "" },
  }),
};

export const LAYER_ORDER: SystemType[] = ["water", "power", "telecom", "transport", "underground", "facility"];

export const NODE_TYPE_LABELS: Record<string, string> = {
  transmission_substation: "Transmission supply substation",
  distribution_substation: "Distribution substation",
  switch: "Switch",
  network_vault: "Network transformer vault",
  supply_source: "Supply main entry",
  pump_station: "Booster pump station",
  storage_tank: "Elevated storage tank",
  valve: "Isolation valve",
  junction: "Pipe junction",
  service_zone: "Water service zone",
  internet_exchange: "Internet exchange / carrier hotel",
  central_office: "Central office",
  data_center: "Data center",
  fiber_hub: "Fibre hub",
  cell_site: "Cell site",
  access_node: "Access node",
  intersection: "Intersection",
  gateway: "Highway gateway",
  transit_station: "Rail transit station",
  utility_vault: "Utility vault",
  hospital: "Hospital",
  emergency_services: "Emergency services",
  government: "Government",
  university: "University",
  venue: "Venue",
  transit_hub: "Transit hub",
  commercial: "Commercial",
};

export const CONNECTION_LABELS: Record<string, string> = {
  transmission_line: "Transmission line",
  feeder_cable: "Feeder cable",
  tie_line: "Tie line (normally open)",
  water_main: "Transmission main",
  distribution_main: "Distribution main",
  fiber_link: "Fibre link",
  road_segment: "Road segment",
  rail_segment: "Rail segment",
  duct_bank: "Duct bank",
  utility_tunnel: "Utility tunnel",
  power_supply: "Power supply",
  water_supply: "Water supply",
  telecom_link: "Telecom link",
  road_access: "Road access",
  control_link: "Control link",
};

export const typeLabel = (t: string) => NODE_TYPE_LABELS[t] ?? t.replace(/_/g, " ");
export const connectionLabel = (t: string) => CONNECTION_LABELS[t] ?? t.replace(/_/g, " ");

export interface StateStyle {
  label: string;
  color: string;
  rgb: [number, number, number];
  /** Whether this is a non-nominal (impacted) state */
  impacted: boolean;
}

const st = (label: string, color: string, impacted = true): StateStyle => ({
  label,
  color,
  rgb: hexToRgb(color),
  impacted,
});

export const NODE_STATE_STYLES: Record<NodeState, StateStyle> = {
  operational: st("Operational", "#9fb3c8", false),
  failed: st("Failed", "#f43f5e"),
  de_energized: st("De-energised", "#f97316"),
  restored: st("Restored via switching", "#4ade80"),
  overloaded: st("Overloaded", "#fb7185"),
  on_backup: st("On backup", "#facc15"),
  degraded: st("Degraded", "#fb923c"),
  outage: st("Service outage", "#ef4444"),
  disconnected: st("Disconnected", "#f97316"),
  isolated: st("Isolated (valved off)", "#f97316"),
  inaccessible: st("Inaccessible", "#ef4444"),
  delayed: st("Delayed access", "#fbbf24"),
  closed: st("Closed", "#ef4444"),
};

export const EDGE_STATE_STYLES: Record<EdgeState, StateStyle> = {
  operational: st("Operational", "#9fb3c8", false),
  failed: st("Failed", "#f43f5e"),
  interrupted: st("Interrupted", "#f97316"),
  isolated: st("Isolated", "#f97316"),
  overloaded: st("Overloaded", "#fb7185"),
  rerouted: st("Carrying rerouted flow", "#4ade80"),
  activated: st("Activated (closed tie)", "#4ade80"),
  normally_open: st("Normally open", "#64748b", false),
};

export const SEVERITY_STYLES: Record<Severity, { label: string; color: string }> = {
  critical: { label: "Critical", color: "#f43f5e" },
  major: { label: "Major", color: "#fb923c" },
  minor: { label: "Minor", color: "#facc15" },
  info: { label: "Info", color: "#7dd3fc" },
};

export interface ProvenanceStyle {
  label: string;
  short: string;
  color: string;
  description: string;
}

export const PROVENANCE_STYLES: Record<ProvenanceCategory, ProvenanceStyle> = {
  verified: {
    label: "Verified data",
    short: "VERIFIED",
    color: "#e2e8f0",
    description: "From an authoritative source and inspected by the pipeline.",
  },
  publicly_mapped: {
    label: "Publicly mapped",
    short: "MAPPED",
    color: "#7dd3fc",
    description: "Present in a public map dataset such as OpenStreetMap; not independently verified.",
  },
  estimated: {
    label: "Estimated",
    short: "ESTIMATED",
    color: "#e9c46a",
    description: "Approximate location or value from general public knowledge; not surveyed.",
  },
  simulated: {
    label: "Simulated",
    short: "SIMULATED",
    color: "#8f9bb3",
    description: "Illustrative asset or connection generated for modelling. Does not describe real infrastructure.",
  },
};

export const SCENARIO_TYPE_LABELS: Record<string, string> = {
  power_failure: "Power failure",
  water_rupture: "Water main rupture",
  telecom_outage: "Internet exchange outage",
  road_disruption: "Road network disruption",
  corridor_strike: "Utility corridor strike",
  custom: "Custom scenario",
};
