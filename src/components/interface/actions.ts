"use client";
/**
 * Interface-level intents composed from store actions + camera commands, so every
 * panel (and the command palette / shortcuts) triggers exactly the same behaviour.
 */
import { emptyScenario } from "@/lib/api";
import { SCENARIO_FOR_SYSTEM } from "@/lib/format";
import { useStore, type PanelKey } from "@/lib/store";
import { connectionLabel } from "@/lib/systems";
import { world } from "@/engine/worldBridge";
import { useUI, type RightPanel } from "./uiStore";

const S = () => useStore.getState();

const RIGHT: PanelKey[] = ["inspector", "analyst", "comparison", "provenance"];

export function openPanel(key: PanelKey) {
  S().setPanel(key, true);
  if (RIGHT.includes(key)) useUI.getState().focusRight(key as RightPanel);
}

export function closePanel(key: PanelKey) {
  if (key === "inspector") {
    void S().selectNode(null);
    S().selectEdge(null);
  }
  S().setPanel(key, false);
}

export function togglePanel(key: PanelKey) {
  const open = S().panels[key];
  if (!open) return openPanel(key);
  // A right drawer that is open but behind another one is brought to the front first.
  if (RIGHT.includes(key)) {
    const order = useUI.getState().rightOrder;
    const visible = RIGHT.filter((k) => S().panels[k]);
    const front = [...order].reverse().find((k) => visible.includes(k));
    if (front && front !== key) return useUI.getState().focusRight(key as RightPanel);
  }
  closePanel(key);
}

export function focusNode(id: string) {
  useUI.getState().focusRight("inspector");
  void S().selectNode(id, { fly: true });
}

export function focusEdge(id: string) {
  const e = S().index?.edges.get(id);
  useUI.getState().focusRight("inspector");
  S().selectEdge(id);
  if (e) world().flyToNodes([e.source_node, e.target_node]);
}

/** Focus a node or an edge id (whichever exists). */
export function focusAny(id: string) {
  const idx = S().index;
  if (idx?.nodes.has(id)) focusNode(id);
  else if (idx?.edges.has(id)) focusEdge(id);
}

export function toggleDeepMode() {
  S().setDeepMode(!S().deepMode, { fly: true });
}

/** Slot to use for one-click failures: fill A first, then keep exploring in the active slot. */
const quickSlot = () => (S().slots.A ? "active" : "A");

export async function simulateNodeFailure(id: string) {
  const n = S().index?.nodes.get(id);
  if (!n) return;
  const scenario = emptyScenario({
    name: `Failure of ${n.name}`,
    scenario_type: SCENARIO_FOR_SYSTEM[n.system],
    failed_nodes: [id],
  });
  useUI.getState().setSimTab("results");
  await S().runSimulation(scenario, quickSlot());
}

export async function simulateEdgeFailure(id: string) {
  const e = S().index?.edges.get(id);
  if (!e) return;
  const scenario = emptyScenario({
    name: `Failure of ${e.name || connectionLabel(e.connection_type)}`,
    scenario_type: SCENARIO_FOR_SYSTEM[e.infrastructure_type],
    failed_edges: [id],
  });
  useUI.getState().setSimTab("results");
  await S().runSimulation(scenario, quickSlot());
}

export function runPreset(presetId: string, slot: "active" | "A" | "B" = "active") {
  const p = S().presets.find((x) => x.id === presetId);
  if (!p) return;
  S().setDraft({ ...p.scenario });
  useUI.getState().setSimTab("results");
  return S().runSimulation(p.scenario, slot);
}

export function askAnalyst(question: string) {
  openPanel("analyst");
  void S().sendAnalystMessage(question);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function startDemo() {
  useUI.getState().setSimTab("results");
  S().startDemo();
}

export function restoreWorld() {
  S().restoreWorld();
  useUI.getState().setSimTab("build");
  useUI.getState().pushToast({ tone: "success", title: "World restored", body: "Baseline network, default layers and camera." });
}
