"use client";
import { ArrowUp, Bot, Check, CircleAlert, Sparkles, Trash2, X } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore, type ChatMessage, type NetworkIndex, type ToolActivity } from "@/lib/store";
import { toolLabel } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { SYSTEM_STYLES } from "@/lib/systems";
import { closePanel, focusEdge, focusNode } from "./actions";
import { prettyModel } from "./MainToolbar";
import { cx, IconButton, Spinner, SystemDot } from "./ui";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex matching any node/edge id of the loaded network as a whole token. */
function useIdMatcher(index: NetworkIndex | null) {
  return useMemo(() => {
    if (!index) return null;
    const ids = [...index.nodes.keys(), ...index.edges.keys()].filter((id) => id.length >= 3);
    if (!ids.length) return null;
    ids.sort((a, b) => b.length - a.length);
    return new RegExp(`(?<![\\w-])(${ids.map(escapeRe).join("|")})(?![\\w-])`, "g");
  }, [index]);
}

function IdChip({ id, index }: { id: string; index: NetworkIndex }) {
  const n = index.nodes.get(id);
  const e = n ? null : index.edges.get(id);
  const system = n?.system ?? e?.infrastructure_type;
  const name = n?.name ?? e?.name ?? id;
  return (
    <button
      type="button"
      onClick={() => (n ? focusNode(id) : focusEdge(id))}
      title={`${name} — click to select and fly to it`}
      className="mx-[1px] inline-flex translate-y-[-1px] items-center gap-1 rounded-[5px] border px-1 py-[0px] align-middle font-mono text-[10.5px] leading-[16px] text-ink-50 transition-colors hover:bg-white/[0.1]"
      style={{ borderColor: system ? `${SYSTEM_STYLES[system].color}55` : "rgba(255,255,255,0.15)", background: system ? `${SYSTEM_STYLES[system].color}12` : undefined }}
    >
      {system && <SystemDot system={system} size={5} />}
      {id}
    </button>
  );
}

function linkify(text: string, re: RegExp | null, index: NetworkIndex | null, key: string): ReactNode {
  if (!re || !index) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<IdChip key={`${key}-${n++}`} id={m[1]} index={index} />);
    last = m.index + m[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function toolTarget(t: ToolActivity, index: NetworkIndex | null): string | null {
  const inp = t.input ?? {};
  const id = (inp.node_id ?? inp.component_id ?? inp.from_node ?? inp.id) as string | undefined;
  if (typeof id === "string") return index?.nodes.get(id)?.name ?? id;
  const ids = (inp.node_ids ?? inp.failed_nodes) as string[] | undefined;
  if (Array.isArray(ids) && ids.length) {
    const first = index?.nodes.get(ids[0])?.name ?? ids[0];
    return ids.length > 1 ? `${first} +${ids.length - 1}` : first;
  }
  if (typeof inp.preset_id === "string") return inp.preset_id;
  return null;
}

function ToolRow({ t, index }: { t: ToolActivity; index: NetworkIndex | null }) {
  const target = toolTarget(t, index);
  return (
    <li className="flex items-start gap-2 py-[3px]">
      <span className="mt-[2px] flex size-3.5 shrink-0 items-center justify-center">
        {t.status === "running" ? (
          <Spinner className="size-3 text-sky-200" />
        ) : t.status === "ok" ? (
          <Check className="size-3 text-ok" />
        ) : (
          <CircleAlert className="size-3 text-alert" />
        )}
      </span>
      <span className="min-w-0 flex-1" title={t.name}>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={cx("shrink-0 text-[11.5px]", t.status === "running" ? "text-ink-50" : "text-ink-200")}>
            {toolLabel(t.name)}
          </span>
          {target && <span className="min-w-0 truncate text-[10.5px] text-ink-400">{target}</span>}
        </span>
        {t.summary && <span className="line-clamp-2 block text-[10.5px] leading-snug text-ink-400">{t.summary}</span>}
      </span>
    </li>
  );
}

function ModeBadge({ mode, model }: { mode?: "llm" | "offline" | null; model?: string | null }) {
  if (!mode) return null;
  return mode === "llm" ? (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-white/10 px-1 font-mono text-[9px] tracking-[0.08em] text-ink-200 uppercase">
      <Sparkles className="size-2.5" />
      {prettyModel(model)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-[4px] border border-white/10 px-1 font-mono text-[9px] tracking-[0.08em] text-ink-300 uppercase">
      Offline analyst · no LLM
    </span>
  );
}

function AssistantMessage({ m, index, re }: { m: ChatMessage; index: NetworkIndex | null; re: RegExp | null }) {
  const [showTools, setShowTools] = useState(false);
  const toolsDone = !m.pending && m.tools.length > 3;
  const tools = toolsDone && !showTools ? m.tools.slice(-2) : m.tools;
  const body = useMemo(
    () =>
      m.content
        ? renderMarkdown(m.content, {
            renderText: (t, k) => linkify(t, re, index, k),
            renderCode: (code, k) =>
              index && (index.nodes.has(code) || index.edges.has(code)) ? <IdChip key={k} id={code} index={index} /> : null,
          })
        : null,
    [m.content, re, index],
  );
  return (
    <div className="group">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="flex size-4 items-center justify-center rounded-[5px] bg-white/[0.07]">
          <Bot className="size-3 text-ink-100" />
        </span>
        <span className="font-mono text-[9.5px] tracking-[0.14em] text-ink-300">ANALYST</span>
        <ModeBadge mode={m.mode} model={m.model} />
      </div>
      {m.note && <p className="mb-1 pl-[22px] text-[10.5px] leading-snug text-ink-400">{m.note}</p>}
      {m.tools.length > 0 && (
        <div className="mb-1.5 ml-[22px] rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1">
          {toolsDone && (
            <button
              type="button"
              onClick={() => setShowTools((v) => !v)}
              className="mb-0.5 font-mono text-[9.5px] tracking-[0.1em] text-ink-400 uppercase hover:text-ink-200"
            >
              {showTools ? "Hide" : "Show"} all {m.tools.length} tool calls
            </button>
          )}
          <ul>
            {tools.map((t) => (
              <ToolRow key={t.id} t={t} index={index} />
            ))}
          </ul>
        </div>
      )}
      {body && <div className="ml-[22px] text-[13px] leading-[1.55] text-ink-100">{body}</div>}
      {m.pending && !m.content && (
        <div className="ml-[22px] flex items-center gap-2 py-1 text-[12px] text-ink-300">
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="size-1 rounded-full bg-ink-200"
                animate={{ opacity: [0.25, 1, 0.25] }}
                transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.16 }}
              />
            ))}
          </span>
          {m.tools.some((t) => t.status === "running") ? "Calling DEEPTRACE tools…" : "Analysing…"}
        </div>
      )}
      {m.error && (
        <div className="mt-1 ml-[22px] flex gap-2 rounded-lg border border-alert/25 bg-alert/[0.07] px-2.5 py-2 text-[12px] leading-snug text-[#fecdd3]">
          <CircleAlert className="mt-[1px] size-3.5 shrink-0" />
          <span>{m.error}</span>
        </div>
      )}
    </div>
  );
}

function useSuggestions(): string[] {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const result = useStore((s) => s.result);
  const slots = useStore((s) => s.slots);
  const index = useStore((s) => s.index);
  const name = selectedNodeId ? index?.nodes.get(selectedNodeId)?.name : null;
  const out: string[] = [];
  if (result) {
    out.push("Why did this happen, and what could we do differently?");
    out.push("Which alternative paths exist?");
  }
  if (slots.A && slots.B) out.push("Compare scenario A and B — which is worse and why?");
  if (name) {
    out.push("What depends on this component?");
    out.push("What happens if this fails?");
  }
  out.push("Which component is the most important in this network?");
  if (!result && !name) out.push("Where are the single points of failure?");
  return [...new Set(out)].slice(0, 3);
}

export function AIAnalyst() {
  const messages = useStore((s) => s.messages);
  const pending = useStore((s) => s.analystPending);
  const send = useStore((s) => s.sendAnalystMessage);
  const clearChat = useStore((s) => s.clearChat);
  const dataMode = useStore((s) => s.dataMode);
  const health = useStore((s) => s.health);
  const index = useStore((s) => s.index);
  const hasReplays = useStore((s) => !!s.snapshot?.analyst_replays && Object.keys(s.snapshot.analyst_replays).length > 0);
  const selectedName = useStore((s) => (s.selectedNodeId ? s.index?.nodes.get(s.selectedNodeId)?.name : null));
  const re = useIdMatcher(index);
  const suggestions = useSuggestions();
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const live = dataMode === "live";
  const last = messages[messages.length - 1];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, last?.content, last?.tools.length]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  const submit = (q?: string) => {
    const v = (q ?? text).trim();
    if (!v || pending) return;
    void send(v);
    if (!q) setText("");
  };

  const headerMode = !live ? (
    <span className="text-ink-400">Engine offline — analyst unavailable</span>
  ) : health?.llm_available ? (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 rounded-full bg-ok" />
      {prettyModel(health.llm_model)} · tool-grounded
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 rounded-full bg-[#e9c46a]" />
      Offline analyst — deterministic, no LLM
    </span>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.07] pr-1.5 pl-3.5">
        <Bot className="size-4 text-ink-300" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[12.5px] font-semibold tracking-[0.12em] text-ink-50 uppercase">AI Analyst</h2>
          <div className="truncate text-[10.5px] leading-tight text-ink-300">{headerMode}</div>
        </div>
        <IconButton label="Clear conversation" size="sm" disabled={!messages.length || pending} onClick={clearChat}>
          <Trash2 className="size-3.5" />
        </IconButton>
        <IconButton label="Close analyst" shortcut="A" size="sm" onClick={() => closePanel("analyst")}>
          <X className="size-4" />
        </IconButton>
      </div>

      {!live && (
        <div className="mx-3 mt-3 rounded-lg border border-[#e9c46a]/25 bg-[#e9c46a]/[0.06] px-3 py-2 text-[11.5px] leading-snug text-ink-200">
          <span className="font-medium text-[#f3d98b]">Offline snapshot.</span> The analyst calls live DEEPTRACE tools, so it needs
          the engine: <code className="font-mono text-[10.5px] text-ink-100">cd backend &amp;&amp; .venv/bin/uvicorn app.main:app --port 8000</code>
          {hasReplays && <span className="text-ink-300"> Recorded answers are available for the demo question.</span>}
        </div>
      )}

      <div ref={scrollRef} className="dt-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-3" aria-live="polite">
        {!messages.length && (
          <div className="pt-2">
            <p className="text-[13px] leading-relaxed text-ink-100">
              Ask about dependencies, failure impacts and mitigations. Every answer is computed by DEEPTRACE tools — traces,
              simulations and network metrics — and shown on the map as it runs.
            </p>
            {selectedName && (
              <p className="mt-2 text-[12px] text-ink-300">
                Context: <span className="text-ink-100">{selectedName}</span> is selected.
              </p>
            )}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[88%] rounded-xl rounded-br-sm border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap text-ink-50">
                {m.content}
              </div>
            </div>
          ) : (
            <AssistantMessage key={m.id} m={m} index={index} re={re} />
          ),
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.07] px-3 pt-2.5 pb-2">
        {!pending && (
          <div className="mb-2 flex flex-wrap gap-1">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => submit(q)}
                className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-left text-[11px] leading-snug text-ink-200 transition-colors hover:border-white/20 hover:bg-white/[0.05] hover:text-ink-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-end gap-1.5 rounded-xl border border-white/[0.1] bg-black/20 py-1.5 pr-1.5 pl-3 focus-within:border-white/25"
        >
          <label htmlFor="analyst-input" className="sr-only">
            Ask the analyst
          </label>
          <textarea
            id="analyst-input"
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={selectedName ? `Ask about ${selectedName}…` : "Ask about the network…"}
            style={{ outline: "none" }}
            className="dt-scroll max-h-[120px] min-h-[22px] flex-1 resize-none bg-transparent py-[3px] text-[13px] leading-snug text-ink-50 placeholder:text-ink-400"
          />
          <button
            type="submit"
            disabled={!text.trim() || pending}
            aria-label="Send question"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink-50 text-ink-950 transition-opacity disabled:opacity-25"
          >
            {pending ? <Spinner className="text-ink-950" /> : <ArrowUp className="size-4" />}
          </button>
        </form>
        <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-ink-400">
          Answers are grounded in DEEPTRACE tool outputs. Simulated data is labelled as such.
          <span className="ml-1 text-ink-500">Enter to send · Shift+Enter for a new line</span>
        </p>
      </div>
    </div>
  );
}
