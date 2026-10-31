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
/** Bottom sheets on phones that a visible right-panel sheet would otherwise hide. */
const SHEETS: PanelKey[] = ["layers", "simulation"];
/** Same breakpoint as useViewport().narrow (Interface phone layout). */
const PHONE_MAX_WIDTH = 768;

/** Phone layout only: is a right-panel sheet currently in front of the layers/simulation sheets? */
function rightSheetCovers(): boolean {
  if (typeof window === "undefined" || window.innerWidth >= PHONE_MAX_WIDTH) return false;
  const s = S();
  const hasSelection = !!(s.selectedNodeId || s.selectedEdgeId);
  return RIGHT.some((k) => s.panels[k] && (k !== "inspector" || hasSelection));
}

export function openPanel(key: PanelKey) {
  // One sheet at a time on phones: the explorer / simulation sheet replaces a right-panel sheet.
  // (setPanel rather than closePanel keeps the current selection.)
  if (SHEETS.includes(key) && rightSheetCovers()) for (const k of RIGHT) if (S().panels[k]) S().setPanel(k, false);
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
  // A layers/simulation sheet hidden behind a right sheet on phones is revealed, not closed.
  if (!open || (SHEETS.includes(key) && rightSheetCovers())) return openPanel(key);
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

/**
 * The A/B diff view draws neither cascade playback nor highlights. When the user drives playback
 * or turns on a highlight while the map shows the diff, switch the map to the slot that holds
 * `result` (matched by identity or scenario id) without touching result, playback or highlight.
 */
export function leaveDiff() {
  const s = S();
  if (s.compareView !== "diff") return;
  if (!s.result) return void useStore.setState({ compareView: null });
  const r = s.result;
  const id = r.scenario_id;
  const slot =
    s.slots.A === r || s.slots.A?.scenario_id === id
      ? "A"
      : s.slots.B === r || s.slots.B?.scenario_id === id
        ? "B"
        : null;
  useStore.setState({ compareView: slot });
}

/**
 * Add/remove a failure target in the draft. Editing a loaded preset turns the draft into a
 * custom scenario (so it is no longer labelled with the preset's name).
 */
export function toggleDraftTarget(kind: "node" | "edge", id: string) {
  const st = S();
  if (kind === "node") st.toggleDraftNode(id);
  else st.toggleDraftEdge(id);
  const d = S().draft;
  if (d.scenario_id || d.name) S().setDraft({ scenario_id: null, name: null });
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
  useUI
    .getState()
    .pushToast({ tone: "success", title: "World restored", body: "Baseline network, default layers and camera." });
}
