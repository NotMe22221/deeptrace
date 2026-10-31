import { NODE_STATE_STYLES } from "@/lib/systems";
import type { AffectedNode } from "@/types/infrastructure";

export interface AffectedStyle {
  label: string;
  color: string;
  /** Lost (some) service in the scenario */
  impacted: boolean;
  /** Re-routed / detoured with full service (engine reports state "operational") */
  rerouted: boolean;
}

/** Display style for an affected component, treating "operational" entries as rerouted with no service loss. */
export function affectedStyle(a: Pick<AffectedNode, "state" | "severity">): AffectedStyle {
  if (a.state === "operational")
    return { label: "Rerouted · no service loss", color: "#4ade80", impacted: false, rerouted: true };
  const s = NODE_STATE_STYLES[a.state];
  return { label: s?.label ?? a.state, color: s?.color ?? "#9fb3c8", impacted: s?.impacted ?? true, rerouted: false };
}
