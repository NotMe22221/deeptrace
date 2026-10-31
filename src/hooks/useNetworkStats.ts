"use client";
import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { LAYER_ORDER } from "@/lib/systems";
import { PROVENANCE_CATEGORIES, type ProvenanceCategory, type SystemType } from "@/types/infrastructure";

export interface SystemStats {
  system: SystemType;
  nodes: number;
  edges: number;
  /** provenance category -> count of nodes + physical edges */
  provenance: Record<ProvenanceCategory, number>;
  /** burial depth range of physical edges (m, positive = below ground) and node elevations */
  depthMin: number;
  depthMax: number;
  critical: number;
}

export interface NetworkStats {
  bySystem: Record<SystemType, SystemStats>;
  dependencyEdges: number;
  totalNodes: number;
  totalEdges: number;
  provenanceTotals: Record<ProvenanceCategory, number>;
  maxDepth: number;
}

const zeroProv = (): Record<ProvenanceCategory, number> => ({
  verified: 0,
  publicly_mapped: 0,
  estimated: 0,
  simulated: 0,
});

/** Aggregate per-system counts derived from the loaded network (memoised). */
export function useNetworkStats(): NetworkStats | null {
  const network = useStore((s) => s.network);
  return useMemo(() => {
    if (!network) return null;
    const bySystem = Object.fromEntries(
      LAYER_ORDER.map((k) => [
        k,
        { system: k, nodes: 0, edges: 0, provenance: zeroProv(), depthMin: Infinity, depthMax: 0, critical: 0 },
      ]),
    ) as Record<SystemType, SystemStats>;
    const provenanceTotals = zeroProv();
    let dependencyEdges = 0;
    let maxDepth = 0;
    for (const n of network.nodes) {
      const s = bySystem[n.system];
      if (!s) continue;
      s.nodes++;
      if (n.critical) s.critical++;
      if (PROVENANCE_CATEGORIES.includes(n.provenance.category)) {
        s.provenance[n.provenance.category]++;
        provenanceTotals[n.provenance.category]++;
      }
      if (n.elevation < 0) {
        const d = -n.elevation;
        s.depthMin = Math.min(s.depthMin, d);
        s.depthMax = Math.max(s.depthMax, d);
        maxDepth = Math.max(maxDepth, d);
      }
    }
    for (const e of network.edges) {
      if (e.relation === "dependency") {
        dependencyEdges++;
        continue;
      }
      const s = bySystem[e.infrastructure_type];
      if (!s) continue;
      s.edges++;
      if (PROVENANCE_CATEGORIES.includes(e.provenance.category)) {
        s.provenance[e.provenance.category]++;
        provenanceTotals[e.provenance.category]++;
      }
      if (e.depth_m > 0) {
        s.depthMin = Math.min(s.depthMin, e.depth_m);
        s.depthMax = Math.max(s.depthMax, e.depth_m);
        maxDepth = Math.max(maxDepth, e.depth_m);
      }
    }
    for (const k of LAYER_ORDER) if (!Number.isFinite(bySystem[k].depthMin)) bySystem[k].depthMin = 0;
    return {
      bySystem,
      dependencyEdges,
      totalNodes: network.nodes.length,
      totalEdges: network.edges.length,
      provenanceTotals,
      maxDepth,
    };
  }, [network]);
}
