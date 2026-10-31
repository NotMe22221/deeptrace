"use client";
import {
  Bot,
  BookOpenCheck,
  Clapperboard,
  CornerDownLeft,
  Eye,
  FlaskConical,
  GitCompareArrows,
  House,
  Layers,
  Play,
  RotateCcw,
  Search,
  Tag,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { LAYER_ORDER, SCENARIO_TYPE_LABELS, SYSTEM_STYLES, typeLabel } from "@/lib/systems";
import { world } from "@/engine/worldBridge";
import type { InfrastructureNode } from "@/types/infrastructure";
import { closePanel, focusNode, leaveDiff, openPanel, restoreWorld, runPreset, startDemo, toggleDeepMode } from "./actions";
import { SYSTEM_ICONS } from "./icons";
import { cx, Kbd, ProvenanceChip, SystemDot } from "./ui";

interface Command {
  id: string;
  label: string;
  hint?: string;
  Icon: LucideIcon;
  color?: string;
  keywords: string;
  run: () => void;
}

/** Subsequence fuzzy score (higher is better), or -1 when not matched. */
function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 + (idx === 0 || /[\s_\-/(]/.test(t[idx - 1]) ? 200 : 0) - t.length * 0.5;
  let score = 0;
  let ti = 0;
  let prev = -2;
  let runs = 0;
  const chars = q.replace(/\s+/g, "");
  for (const ch of chars) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    if (found === prev + 1) score += 12;
    else {
      runs++;
      score += 2;
    }
    if (found === 0 || /[\s_\-/(]/.test(t[found - 1])) score += 8;
    prev = found;
    ti = found + 1;
  }
  // Scattered single-letter matches are noise: require mostly contiguous runs.
  if (runs > Math.max(1, Math.ceil(chars.length / 3))) return -1;
  return score - t.length * 0.3;
}

/** Adds a field weight to a match score, keeping non-matches (< 0) as non-matches. */
const bonus = (score: number, w: number) => (score < 0 ? -1 : Math.max(0.1, score + w));

function useCommands(): Command[] {
  const layers = useStore((s) => s.layers);
  const presets = useStore((s) => s.presets);
  const deepMode = useStore((s) => s.deepMode);
  const showDependencies = useStore((s) => s.showDependencies);
  const showParticles = useStore((s) => s.showParticles);
  const showLabels = useStore((s) => s.showLabels);
  const demoScript = useStore((s) => s.demoScript);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  return useMemo(() => {
    const S = useStore.getState;
    const cmds: Command[] = [
      {
        id: "deep",
        label: deepMode ? "Exit Deep Mode" : "Enter Deep Mode",
        hint: "D",
        Icon: Layers,
        color: "#22d3ee",
        keywords: "deep mode underground subsurface depth",
        run: toggleDeepMode,
      },
      ...LAYER_ORDER.map<Command>((k) => ({
        id: `layer-${k}`,
        label: `${layers[k] ? "Hide" : "Show"} ${SYSTEM_STYLES[k].label}`,
        Icon: SYSTEM_ICONS[k],
        color: SYSTEM_STYLES[k].color,
        keywords: `layer toggle ${k} ${SYSTEM_STYLES[k].label}`,
        run: () => S().setLayer(k, !layers[k]),
      })),
      {
        id: "deps",
        label: `${showDependencies ? "Hide" : "Show"} dependency links`,
        Icon: Waypoints,
        keywords: "dependency links overlay cross-system",
        run: () => S().setShowDependencies(!showDependencies),
      },
      {
        id: "particles",
        label: `${showParticles ? "Hide" : "Show"} flow particles`,
        Icon: Eye,
        keywords: "flow particles animation overlay",
        run: () => S().setShowParticles(!showParticles),
      },
      {
        id: "labels",
        label: `${showLabels ? "Hide" : "Show"} labels`,
        Icon: Tag,
        keywords: "labels names overlay",
        run: () => S().setShowLabels(!showLabels),
      },
      ...presets.map<Command>((p) => ({
        id: `preset-${p.id}`,
        label: `Run: ${p.name}`,
        hint: SCENARIO_TYPE_LABELS[p.scenario_type],
        Icon: Play,
        color: "#f43f5e",
        keywords: `simulate run scenario preset ${p.name} ${p.scenario_type} ${SCENARIO_TYPE_LABELS[p.scenario_type]}`,
        run: () => void runPreset(p.id, "active"),
      })),
      {
        id: "demo",
        label: "Start guided demo",
        Icon: Clapperboard,
        keywords: "demo walkthrough tour judge",
        run: () => (demoScript ? startDemo() : undefined),
      },
      {
        id: "restore",
        label: "Restore world",
        Icon: RotateCcw,
        keywords: "reset restore clear baseline",
        run: restoreWorld,
      },
      {
        id: "home",
        label: "Fly home",
        hint: "H",
        Icon: House,
        keywords: "camera home overview",
        run: () => world().flyHome(),
      },
      {
        id: "sim",
        label: "Open simulation center",
        hint: "S",
        Icon: FlaskConical,
        keywords: "simulation scenarios",
        run: () => openPanel("simulation"),
      },
      {
        id: "ai",
        label: "Open AI analyst",
        hint: "A",
        Icon: Bot,
        keywords: "ai analyst claude chat ask",
        run: () => openPanel("analyst"),
      },
      {
        id: "cmp",
        label: "Open scenario comparison",
        hint: "C",
        Icon: GitCompareArrows,
        keywords: "compare a b diff",
        run: () => openPanel("comparison"),
      },
      {
        id: "prov",
        label: "Open data provenance",
        hint: "P",
        Icon: BookOpenCheck,
        keywords: "provenance data sources license attribution",
        run: () => openPanel("provenance"),
      },
    ];
    if (selectedNodeId)
      cmds.push({
        id: "trace",
        label: "Trace selected component",
        Icon: Waypoints,
        keywords: "trace upstream downstream dependencies selected",
        run: () => {
          leaveDiff(); // the A/B diff view does not draw traces
          void S().showTrace(selectedNodeId);
        },
      });
    return cmds.filter((c) => c.id !== "demo" || demoScript);
  }, [layers, presets, deepMode, showDependencies, showParticles, showLabels, demoScript, selectedNodeId]);
}

type Item = { kind: "node"; node: InfrastructureNode; score: number } | { kind: "cmd"; cmd: Command; score: number };

export function CommandPalette() {
  const open = useStore((s) => s.panels.search);
  return <AnimatePresence>{open && <PaletteDialog />}</AnimatePresence>;
}

function PaletteDialog() {
  const network = useStore((s) => s.network);
  const metrics = useStore((s) => s.metrics);
  const commands = useCommands();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => closePanel("search");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items: Item[] = useMemo(() => {
    const nodes = network?.nodes ?? [];
    const query = q.trim();
    if (!query) {
      // Suggest the most critical components first.
      const rankIds = metrics?.criticality_ranking.slice(0, 6).map((c) => c.node_id) ?? [];
      const top = rankIds.length
        ? rankIds.map((id) => nodes.find((n) => n.id === id)).filter((n): n is InfrastructureNode => !!n)
        : nodes.filter((n) => n.critical).slice(0, 6);
      return [
        ...top.map<Item>((node) => ({ kind: "node", node, score: 0 })),
        ...commands.slice(0, 8).map<Item>((cmd) => ({ kind: "cmd", cmd, score: 0 })),
      ];
    }
    const nodeHits: Item[] = [];
    for (const n of nodes) {
      const s = Math.max(
        bonus(fuzzy(query, n.name), 40),
        bonus(fuzzy(query, n.id), 20),
        fuzzy(query, typeLabel(n.type)),
        bonus(fuzzy(query, SYSTEM_STYLES[n.system]?.label ?? n.system), -40),
      );
      if (s > 0) nodeHits.push({ kind: "node", node: n, score: s });
    }
    nodeHits.sort((a, b) => b.score - a.score);
    const cmdHits: Item[] = [];
    for (const c of commands) {
      const s = Math.max(bonus(fuzzy(query, c.label), 30), fuzzy(query, c.keywords));
      if (s > 0) cmdHits.push({ kind: "cmd", cmd: c, score: s });
    }
    cmdHits.sort((a, b) => b.score - a.score);
    // Commands first when they clearly match better than any component.
    const bestNode = nodeHits[0]?.score ?? -1;
    const bestCmd = cmdHits[0]?.score ?? -1;
    const n = nodeHits.slice(0, 30);
    const c = cmdHits.slice(0, 8);
    return bestCmd > bestNode + 100 ? [...c, ...n] : [...n, ...c];
  }, [q, network, commands, metrics]);

  const safeActive = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${safeActive}"]`)?.scrollIntoView({ block: "nearest" });
  }, [safeActive]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    close();
    if (it.kind === "node") focusNode(it.node.id);
    else it.cmd.run();
  };

  const firstCmd = items.findIndex((i) => i.kind === "cmd");
  const firstNode = items.findIndex((i) => i.kind === "node");

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-ink-950/45 px-4 pt-[12vh] backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Search components and commands"
        initial={{ opacity: 0, y: -8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.985 }}
        transition={{ duration: 0.14 }}
        className="dt-panel-strong flex max-h-[min(560px,72vh)] w-full max-w-[620px] flex-col overflow-hidden"
      >
        <div className="flex items-center gap-2.5 border-b border-white/[0.08] px-4">
          <Search className="size-4 text-ink-300" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(items[safeActive]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items.length ? `palette-item-${safeActive}` : undefined}
            placeholder="Search components by name, id, type or system — or type a command…"
            style={{ outline: "none" }}
            className="h-12 flex-1 bg-transparent text-[14px] text-ink-50 placeholder:text-ink-400"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="dt-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
          {!items.length && (
            <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">No components or commands match “{q}”.</p>
          )}
          {items.map((it, i) => (
            <div key={it.kind === "node" ? `n-${it.node.id}` : `c-${it.cmd.id}`}>
              {i === firstNode && (
                <div className="dt-label px-2.5 pt-2 pb-1">{q ? "Components" : "Most critical components"}</div>
              )}
              {i === firstCmd && <div className="dt-label px-2.5 pt-2 pb-1">Commands</div>}
              <div
                id={`palette-item-${i}`}
                data-idx={i}
                role="option"
                aria-selected={i === safeActive}
                onPointerMove={() => i !== safeActive && setActive(i)}
                onClick={() => choose(it)}
                className={cx(
                  "flex h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5",
                  i === safeActive ? "bg-white/[0.08]" : "hover:bg-white/[0.04]",
                )}
              >
                {it.kind === "node" ? (
                  <>
                    <SystemDot system={it.node.system} size={8} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink-50">{it.node.name}</span>
                      <span className="block truncate text-[10.5px] text-ink-400">
                        {typeLabel(it.node.type)} · {SYSTEM_STYLES[it.node.system]?.label}
                      </span>
                    </span>
                    {it.node.critical && (
                      <span className="font-mono text-[9px] tracking-[0.1em] text-[#fda4af]">CRITICAL</span>
                    )}
                    <ProvenanceChip category={it.node.provenance.category} />
                    <span className="hidden w-[110px] truncate text-right font-mono text-[10px] text-ink-500 sm:block">
                      {it.node.id}
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="flex size-5 items-center justify-center"
                      style={{ color: it.cmd.color ?? "#a1abc0" }}
                    >
                      <it.cmd.Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{it.cmd.label}</span>
                    {it.cmd.hint && <span className="text-[10.5px] text-ink-400">{it.cmd.hint}</span>}
                  </>
                )}
                {i === safeActive && <CornerDownLeft className="size-3.5 text-ink-400" />}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-white/[0.07] px-3 py-1.5 text-[10.5px] text-ink-400">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> select &amp; fly
          </span>
          <span className="ml-auto">{network ? `${network.nodes.length} components indexed` : ""}</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
