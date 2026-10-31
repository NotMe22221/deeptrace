/**
 * Formatting helpers shared by the interface. Numbers are always rendered with
 * tabular figures (see .dt-num) and units spelled the same way everywhere.
 */
import type { ScenarioType, SystemType } from "@/types/infrastructure";

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Compact human number: 1234 -> "1,234", 12.345 -> "12.3", 0.123 -> "0.12". */
export function fmtNum(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (digits !== undefined) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
  }
  const a = Math.abs(v);
  if (a >= 100) return nf0.format(v);
  if (a >= 10) return nf1.format(v);
  return nf2.format(v);
}

/** Large counts: 12_400 -> "12.4k". */
export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${nf1.format(v / 1_000_000)}M`;
  if (a >= 10_000) return `${nf0.format(v / 1000)}k`;
  if (a >= 1000) return `${nf1.format(v / 1000)}k`;
  return nf0.format(v);
}

/** 0..1 fraction -> "42%". */
export function fmtPct(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtMeters(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "—";
  if (Math.abs(m) >= 1000) return `${nf2.format(m / 1000)} km`;
  if (Math.abs(m) >= 10) return `${nf0.format(m)} m`;
  return `${nf1.format(m)} m`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || Number.isNaN(s)) return "—";
  if (s >= 3600) return `${nf1.format(s / 3600)} h`;
  if (s >= 60) return `${nf0.format(s / 60)} min`;
  return `${nf0.format(s)} s`;
}

export function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}`;
}

export function fmtLon(lon: number): string {
  return `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
}

/** Elevation relative to ground: negative = below ground. */
export function fmtElevation(m: number): string {
  if (Math.abs(m) < 0.05) return "At grade";
  return m < 0 ? `${nf1.format(-m)} m below ground` : `${nf1.format(m)} m above ground`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export const pluralize = (n: number, one: string, many = `${one}s`) => `${fmtNum(n, 0)} ${n === 1 ? one : many}`;

/** Prettify a property key: "backup_hours" -> "Backup hours". */
export const humanizeKey = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => fmtValue(x)).join(", ");
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Analyst tool names -> human activity labels. */
export const TOOL_LABELS: Record<string, string> = {
  get_component_details: "Inspecting component",
  get_node_details: "Inspecting component",
  run_failure_simulation: "Running failure simulation",
  simulate_failure: "Running failure simulation",
  trace_network_path: "Tracing network path",
  trace_dependencies: "Tracing dependencies",
  get_connected_nodes: "Finding connected components",
  compare_scenarios: "Comparing scenarios",
  get_affected_components: "Listing affected components",
  get_network_metrics: "Reading network metrics",
  get_criticality_ranking: "Ranking critical components",
  get_data_provenance: "Checking data provenance",
  highlight_components: "Highlighting on the map",
  focus_camera: "Moving the camera",
  search_components: "Searching components",
  find_alternative_paths: "Finding alternative paths",
  list_scenarios: "Listing scenarios",
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? humanizeKey(name.replace(/^get_/, ""));

/** Map a system to the scenario type used when failing one of its components. */
export const SCENARIO_FOR_SYSTEM: Record<SystemType, ScenarioType> = {
  power: "power_failure",
  water: "water_rupture",
  telecom: "telecom_outage",
  transport: "road_disruption",
  underground: "corridor_strike",
  facility: "custom",
};

export const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
};
