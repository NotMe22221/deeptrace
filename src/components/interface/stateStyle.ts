import { NODE_STATE_STYLES } from "@/lib/systems";
import type { AffectedNode } from "@/types/infrastructure";

export interface AffectedStyle {
  label: string;
  /** Short label for compact chips */
  short: string;
  color: string;
  /**
   * Lost (some) service in the scenario. Mirrors the engine: rows with severity "info"
   * (rerouted with full service, or restored via switching) are excluded from
   * impact_metrics.total_nodes_affected, so they are not counted as impacted here either.
   */
  impacted: boolean;
  /** Re-routed / detoured with full service (engine reports state "operational") */
  rerouted: boolean;
}

/** Display style for an affected component, consistent with the engine's impact counts. */
export function affectedStyle(a: Pick<AffectedNode, "state" | "severity">): AffectedStyle {
  if (a.state === "operational")
    return {
      label: "Rerouted · no service loss",
      short: "Rerouted",
      color: "#4ade80",
      impacted: false,
      rerouted: true,
    };
  const s = NODE_STATE_STYLES[a.state];
  const label = s?.label ?? a.state;
  const impacted = a.severity !== "info" && (s?.impacted ?? true);
  return {
    label: impacted ? label : `${label} · no service loss`,
    short: a.state === "restored" ? "Restored" : label,
    color: s?.color ?? "#9fb3c8",
    impacted,
    rerouted: false,
  };
}
