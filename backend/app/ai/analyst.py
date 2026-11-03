"""AI Infrastructure Analyst — Claude tool-use loop.

The model answers only through the controlled tools in :mod:`app.ai.tools`; every
simulation number it cites comes from the deterministic engine. Events are yielded as
plain dicts matching the ``AnalystEvent`` union in ``src/types/infrastructure.ts`` and are
streamed to the browser as Server-Sent Events by the API layer.

Without an API key (or when the API is unreachable) the deterministic offline analyst in
:mod:`app.ai.offline` answers instead, using the same tools, and says so.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any

import anthropic

from app.ai import offline
from app.ai.tools import TOOL_DEFINITIONS, ToolContext, execute_tool, network_brief
from app.config import get_settings
from app.models.schemas import AnalystRequest

SYSTEM_PROMPT = """You are DEEPTRACE's AI Infrastructure Analyst, embedded in a 3D digital-twin of a city's interconnected infrastructure (water, electricity, internet, transportation, shared underground corridors and the critical facilities that depend on them).

How you work
- Every fact about the network or a simulation must come from your tools in this conversation. Never invent components, ids, connections, capacities, numbers or outcomes. If a tool cannot answer, say what is missing.
- Resolve components the user names with search_components (or use the selected component given in <app_context>) before acting on them.
- For "what happens if X fails" questions, run run_failure_simulation. For "why did this happen", read the scenario's cascade steps and causes (get_affected_components or the simulation output). For "what could we do differently", propose concrete mitigations and quantify one or two with evaluate_mitigation instead of guessing their effect.
- Your tool calls drive the 3D view (simulations animate, traces and highlights appear). Use highlight_components or focus_camera when pointing the user at specific elements helps.
- The model is a simplified, deterministic, explainable simulation — not a validated engineering prediction. Say so briefly when presenting consequences.

Data honesty (mandatory)
- Every element has a provenance category: verified, publicly_mapped, estimated or simulated. In this dataset most utility assets and all connections/dependencies are SIMULATED (illustrative); named public places (stations, hospital, venues) have ESTIMATED locations. Never present simulated or estimated items as real, surveyed infrastructure. When in doubt call get_data_provenance.
- Questions outside the loaded data (real-time status, real utility records, costs, regulations) — explain the limitation plainly.

Answer style
- Lead with the direct answer in one or two sentences, then short sections with bold labels as useful (e.g. **What the simulation shows**, **Why it cascades**, **Alternatives & redundancy**, **Mitigation options**, **Data caveats**). Prefer bullet points with concrete numbers and component names; write component ids in backticks (e.g. `PWR-DS-FIVEPOINTS`) so the interface can link them.
- Be concise: usually under 250 words. No preamble about calling tools.

{network}
"""

FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _context_block(req: AnalystRequest) -> str:
    c = req.context
    lines = []
    if c.selected_node_id:
        lines.append(f"selected_component: {c.selected_node_id}")
    if c.selected_edge_id:
        lines.append(f"selected_connection: {c.selected_edge_id}")

    def sc(label: str, s):
        if s is None:
            return
        lines.append(
            f"{label}: failed_nodes={s.failed_nodes} failed_edges={s.failed_edges} "
            f"horizon_hours={s.horizon_hours} restoration={s.enable_restoration} name={s.name!r}"
        )

    sc("scenario_shown_in_app", c.active_scenario)
    sc("stored_scenario_A", c.scenario_a)
    sc("stored_scenario_B", c.scenario_b)
    if not lines:
        lines.append("nothing selected; no scenario loaded")
    return "<app_context>\n" + "\n".join(lines) + "\n</app_context>"


def _tool_result_content(payload: dict[str, Any]) -> str:
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) > 60_000:  # keep tool results bounded; payloads are already compact
        text = text[:60_000] + "…(truncated)"
    return text


async def run_llm(req: AnalystRequest, engine) -> AsyncIterator[dict[str, Any]]:
    settings = get_settings()
    ctx = ToolContext(engine=engine, context=req.context)
    client = anthropic.AsyncAnthropic()
    system = SYSTEM_PROMPT.replace("{network}", network_brief(engine.network))

    # Bound the replayed history (most recent turns, ~60k chars total) to cap input cost.
    recent: list[dict[str, Any]] = []
    budget = 60_000
    for t in reversed(req.history[-12:]):
        if not t.content.strip():
            continue
        if budget - len(t.content) < 0:
            break
        budget -= len(t.content)
        recent.append({"role": t.role, "content": t.content})
    messages: list[dict[str, Any]] = list(reversed(recent))
    # The API requires alternating roles starting with "user"; drop a leading assistant turn.
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    messages.append({"role": "user", "content": f"{_context_block(req)}\n\n{req.message}"})

    yield {"type": "status", "mode": "llm", "model": settings.llm_model, "note": None}

    tool_calls = 0
    for _round in range(settings.llm_max_tool_rounds + 1):
        text = ""
        last_emit = 0.0
        async with client.beta.messages.stream(
            model=settings.llm_model,
            max_tokens=16000,
            system=system,
            tools=TOOL_DEFINITIONS,
            messages=messages,
            output_config={"effort": settings.llm_effort},
            cache_control={"type": "ephemeral"},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        ) as stream:
            async for event in stream:
                if event.type == "text":
                    text += event.text
                    now = time.monotonic()
                    if now - last_emit > 0.12:
                        last_emit = now
                        yield {"type": "message", "text": text}
            final = await stream.get_final_message()

        if final.stop_reason == "refusal":
            yield {
                "type": "error",
                "message": "The model declined this request. Try rephrasing it as a question about the loaded infrastructure network.",
            }
            break

        # Append the assistant turn unchanged (includes thinking + tool_use blocks).
        messages.append({"role": "assistant", "content": final.content})
        tool_uses = [b for b in final.content if b.type == "tool_use"]

        if final.stop_reason == "tool_use" and tool_uses:
            if _round >= settings.llm_max_tool_rounds:
                yield {"type": "message", "text": (text + "\n\n_Stopped: tool-call limit reached for this question._").strip()}
                break
            results = []
            for tu in tool_uses:
                tool_calls += 1
                args = tu.input if isinstance(tu.input, dict) else {}
                yield {"type": "tool_call", "id": tu.id, "name": tu.name, "input": args}
                ok, out = await asyncio.to_thread(execute_tool, ctx, tu.name, args)
                yield {"type": "tool_result", "id": tu.id, "name": tu.name, "ok": ok, "summary": out.summary}
                for action in out.ui_actions:
                    yield {"type": "ui_action", "action": action.model_dump(mode="json")}
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": _tool_result_content(out.payload),
                        **({"is_error": True} if not ok else {}),
                    }
                )
            messages.append({"role": "user", "content": results})
            continue

        final_text = "".join(b.text for b in final.content if b.type == "text").strip()
        if final.stop_reason == "max_tokens":
            final_text += "\n\n_Answer truncated (output limit)._"
        yield {"type": "message", "text": final_text or "_No answer was produced._"}
        break

    yield {"type": "done", "tool_calls": tool_calls, "mode": "llm"}


async def stream_analyst(req: AnalystRequest, engine) -> AsyncIterator[dict[str, Any]]:
    """Entry point used by the API: LLM when configured, deterministic offline analyst otherwise."""
    settings = get_settings()
    if req.force_offline or not settings.llm_available:
        async for ev in offline.run_offline(req, engine, note=None if req.force_offline else "No ANTHROPIC_API_KEY configured"):
            yield ev
        return

    started = False
    try:
        async for ev in run_llm(req, engine):
            if ev["type"] in ("tool_call", "message"):
                started = True
            yield ev
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError) as exc:
        reason = f"LLM unavailable ({type(exc).__name__}: check ANTHROPIC_API_KEY / DEEPTRACE_LLM_MODEL)"
        async for ev in _fallback(req, engine, reason, started):
            yield ev
    except anthropic.RateLimitError:
        async for ev in _fallback(req, engine, "LLM rate-limited", started):
            yield ev
    except anthropic.APIStatusError as exc:
        async for ev in _fallback(req, engine, f"LLM API error {exc.status_code}", started):
            yield ev
    except anthropic.APIConnectionError:
        async for ev in _fallback(req, engine, "LLM API unreachable", started):
            yield ev


async def _fallback(req: AnalystRequest, engine, reason: str, started: bool) -> AsyncIterator[dict[str, Any]]:
    if started:
        # Partial LLM output was already streamed; do not mix answers.
        yield {"type": "error", "message": f"{reason}. The answer was interrupted — please retry."}
        yield {"type": "done", "tool_calls": 0, "mode": "llm"}
        return
    async for ev in offline.run_offline(req, engine, note=f"{reason} — answered by the offline analyst"):
        yield ev
