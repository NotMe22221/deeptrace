"""Tests for the Claude tool-use loop with a fake streaming client (no network, no API key).

They verify the agentic loop wiring: tool_use blocks are executed through the controlled
tools, results are returned as tool_result blocks in one user turn, UI actions are derived
from tool results, the final text is streamed, refusals are handled, and API failures fall
back to the deterministic offline analyst.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import anthropic
import pytest

from app.ai import analyst
from app.config import get_settings
from app.models.schemas import (
    AnalystContext,
    AnalystRequest,
    CameraView,
    InfrastructureNetwork,
    InfrastructureNode,
    Provenance,
    ProvenanceCategory,
    RegionInfo,
    SystemType,
)


def _net() -> InfrastructureNetwork:
    prov = Provenance(category=ProvenanceCategory.SIMULATED, source="test", confidence=0.0)
    region = RegionInfo(
        id="t",
        name="Test",
        city="Test",
        bbox=(0, 0, 1, 1),
        center=(0.5, 0.5),
        default_camera=CameraView(longitude=0.5, latitude=0.5, height=1000),
        ground_elevation_m=0,
    )
    nodes = [
        InfrastructureNode(id="PWR-DS-A", name="DS-A Alpha (simulated)", system=SystemType.POWER,
                           type="distribution_substation", latitude=0.5, longitude=0.5, provenance=prov),
        InfrastructureNode(id="WTR-PS-1", name="Booster PS-1 (simulated)", system=SystemType.WATER,
                           type="pump_station", latitude=0.6, longitude=0.6, provenance=prov),
    ]
    return InfrastructureNetwork(id="net", name="Test", version="1", generated_at="x", region=region, nodes=nodes, edges=[])


class StubEngine:
    def __init__(self) -> None:
        self.network = _net()


def _block(**kw: Any) -> SimpleNamespace:
    return SimpleNamespace(**kw)


class FakeStream:
    def __init__(self, final: SimpleNamespace, texts: list[str]) -> None:
        self.final = final
        self.texts = texts

    async def __aenter__(self) -> "FakeStream":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    def __aiter__(self):
        async def gen():
            for t in self.texts:
                yield SimpleNamespace(type="text", text=t)

        return gen()

    async def get_final_message(self) -> SimpleNamespace:
        return self.final


class FakeClient:
    """Scripted responses; records every request's kwargs."""

    def __init__(self, script: list[tuple[SimpleNamespace, list[str]]]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []
        outer = self

        class _Messages:
            def stream(self, **kw: Any) -> FakeStream:
                outer.calls.append({**kw, "messages": list(kw["messages"])})  # snapshot: the loop appends to the list
                final, texts = outer.script.pop(0)
                return FakeStream(final, texts)

        self.beta = SimpleNamespace(messages=_Messages())


@pytest.fixture(autouse=True)
def _llm_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _collect(gen) -> list[dict[str, Any]]:
    async def run():
        return [ev async for ev in gen]

    return asyncio.run(run())


def test_tool_loop_executes_tools_and_streams_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    first = _block(
        stop_reason="tool_use",
        content=[
            _block(type="thinking", thinking="", signature="sig"),
            _block(type="tool_use", id="tu_1", name="search_components", input={"query": "alpha substation"}),
            _block(type="tool_use", id="tu_2", name="highlight_components", input={"node_ids": ["PWR-DS-A"], "tone": "warning"}),
        ],
    )
    second = _block(stop_reason="end_turn", content=[_block(type="text", text="DS-A is `PWR-DS-A`.")])
    fake = FakeClient([(first, []), (second, ["DS-A is ", "`PWR-DS-A`."])])
    monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda: fake)

    req = AnalystRequest(message="Which substation is alpha?", context=AnalystContext(selected_node_id="PWR-DS-A"))
    events = _collect(analyst.stream_analyst(req, StubEngine()))
    types = [e["type"] for e in events]

    assert types[0] == "status" and events[0]["mode"] == "llm"
    assert types.count("tool_call") == 2 and types.count("tool_result") == 2
    assert all(e["ok"] for e in events if e["type"] == "tool_result")
    ui = [e["action"] for e in events if e["type"] == "ui_action"]
    assert ui and ui[0]["kind"] == "highlight" and ui[0]["node_ids"] == ["PWR-DS-A"]
    assert events[-2] == {"type": "message", "text": "DS-A is `PWR-DS-A`."}
    assert events[-1]["type"] == "done" and events[-1]["tool_calls"] == 2

    # Request wiring: model/effort/fallbacks/tools, context block, append-only history
    kw = fake.calls[0]
    assert kw["model"] == get_settings().llm_model
    assert kw["fallbacks"] == "default" and kw["betas"] == [analyst.FALLBACK_BETA]
    assert kw["output_config"] == {"effort": get_settings().llm_effort}
    assert {t["name"] for t in kw["tools"]} >= {"run_failure_simulation", "get_component_details", "compare_scenarios"}
    assert "<app_context>" in kw["messages"][-1]["content"] and "PWR-DS-A" in kw["messages"][-1]["content"]
    second_msgs = fake.calls[1]["messages"]
    assert second_msgs[-2]["role"] == "assistant" and second_msgs[-2]["content"] is first.content
    results = second_msgs[-1]["content"]
    assert [r["tool_use_id"] for r in results] == ["tu_1", "tu_2"]
    assert all(r["type"] == "tool_result" for r in results)


def test_unknown_ids_are_reported_as_tool_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    first = _block(
        stop_reason="tool_use",
        content=[_block(type="tool_use", id="tu_1", name="get_component_details", input={"node_id": "PWR-DS-ZZZ"})],
    )
    second = _block(stop_reason="end_turn", content=[_block(type="text", text="That id does not exist.")])
    fake = FakeClient([(first, []), (second, [])])
    monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda: fake)
    events = _collect(analyst.stream_analyst(AnalystRequest(message="details of PWR-DS-ZZZ"), StubEngine()))
    res = [e for e in events if e["type"] == "tool_result"][0]
    assert res["ok"] is False and "Unknown node id" in res["summary"]
    sent = fake.calls[1]["messages"][-1]["content"][0]
    assert sent["is_error"] is True and "PWR-DS-A" in sent["content"]  # close-match suggestion


def test_refusal_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient([(_block(stop_reason="refusal", content=[]), [])])
    monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda: fake)
    events = _collect(analyst.stream_analyst(AnalystRequest(message="hello"), StubEngine()))
    assert any(e["type"] == "error" and "declined" in e["message"] for e in events)
    assert events[-1]["type"] == "done"


def test_auth_failure_falls_back_to_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    class Boom:
        def __init__(self) -> None:
            outer = self

            class _M:
                def stream(self, **kw: Any):
                    req = SimpleNamespace(method="POST", url="https://api.anthropic.com/v1/messages", headers={})
                    resp = SimpleNamespace(status_code=401, headers={}, request=req)
                    raise anthropic.AuthenticationError("bad key", response=resp, body=None)  # type: ignore[arg-type]

            outer.beta = SimpleNamespace(messages=_M())

    monkeypatch.setattr(anthropic, "AsyncAnthropic", Boom)
    events = _collect(analyst.stream_analyst(AnalystRequest(message="Which component is most important?"), StubEngine()))
    status = [e for e in events if e["type"] == "status"]
    assert status[-1]["mode"] == "offline" and "LLM unavailable" in (status[-1]["note"] or "")
    assert events[-1] == {"type": "done", "tool_calls": events[-1]["tool_calls"], "mode": "offline"}
