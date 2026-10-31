"""End-to-end API tests against the real region dataset and engine (skipped if not generated)."""

from __future__ import annotations

import json

import pytest

from app.networks.loader import load_demo_script, load_presets, network_path

pytestmark = pytest.mark.skipif(not network_path().exists(), reason="network.json not generated")


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def _sse(resp) -> list[dict]:
    events = []
    for chunk in resp.text.split("\n\n"):
        for line in chunk.splitlines():
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events


def test_health_and_network(client) -> None:
    h = client.get("/api/health").json()
    assert h["status"] == "ok" and h["node_count"] > 50 and h["edge_count"] > 50
    net = client.get("/api/network").json()
    assert len(net["nodes"]) == h["node_count"]
    assert {n["system"] for n in net["nodes"]} >= {"power", "water", "telecom", "transport", "facility"}
    for n in net["nodes"]:
        assert n["provenance"]["category"] in ("verified", "publicly_mapped", "estimated", "simulated")
    assert client.get("/api/region").json()["id"] == net["region"]["id"]


def test_baseline_has_flows_and_no_failures(client) -> None:
    b = client.get("/api/baseline").json()
    assert b["failed_nodes"] == [] and b["failed_edges"] == []
    assert b["edge_flows"], "baseline must expose flows for particle animation"
    assert len(b["node_states"]) == client.get("/api/health").json()["node_count"]


def test_every_preset_simulates(client) -> None:
    presets = client.get("/api/scenarios/presets").json()
    assert len(presets) >= 5
    types = {p["scenario_type"] for p in presets}
    assert {"power_failure", "water_rupture", "telecom_outage", "road_disruption", "corridor_strike"} <= types
    for p in presets:
        r = client.post("/api/simulate", json=p["scenario"])
        assert r.status_code == 200, (p["id"], r.text)
        res = r.json()
        assert res["affected_nodes"], f"preset {p['id']} affects nothing"
        assert res["cascade_steps"] and res["assumptions"] and res["summary"]
        assert 0 <= res["impact_metrics"]["severity_index"] <= 100


def test_simulation_is_deterministic(client) -> None:
    p = load_presets()[0]
    a = client.post("/api/simulate", json=p.scenario.model_dump(mode="json")).json()
    b = client.post("/api/simulate", json=p.scenario.model_dump(mode="json")).json()
    for k in ("timestamp", "computation_ms"):
        a.pop(k)
        b.pop(k)
    assert a == b


def test_validation_errors(client) -> None:
    assert client.post("/api/simulate", json={"failed_nodes": [], "failed_edges": []}).status_code == 422
    assert client.post("/api/simulate", json={"failed_nodes": ["NOPE-123"]}).status_code in (404, 422)
    assert client.get("/api/nodes/NOPE-123").status_code in (404, 422)
    assert client.get("/api/trace/NOPE-123").status_code in (404, 422)


def test_demo_compare_trace_details(client) -> None:
    demo = load_demo_script()
    assert demo is not None and len(demo.steps) == 10
    script = client.get("/api/demo/script").json()
    assert script["focus_node_id"] == demo.focus_node_id
    by_id = {p.id: p for p in load_presets()}
    a, b = by_id[demo.scenario_a_preset], by_id[demo.scenario_b_preset]
    cmp = client.post(
        "/api/compare", json={"scenario_a": a.scenario.model_dump(mode="json"), "scenario_b": b.scenario.model_dump(mode="json")}
    ).json()
    assert cmp["metrics"] and cmp["verdict"]
    tr = client.get(f"/api/trace/{demo.focus_node_id}").json()
    assert tr["node_id"] == demo.focus_node_id and (tr["downstream"] or tr["dependents"])
    d = client.get(f"/api/nodes/{demo.focus_node_id}").json()
    assert d["node"]["id"] == demo.focus_node_id
    m = client.get("/api/network/metrics").json()
    assert m["criticality_ranking"] and m["systems"]


def test_offline_analyst_explains_and_quantifies_mitigation(client) -> None:
    demo = load_demo_script()
    by_id = {p.id: p for p in load_presets()}
    scenario = by_id[demo.scenario_a_preset].scenario.model_dump(mode="json")
    question = next(s.question for s in demo.steps if s.action == "ask_ai")
    r = client.post(
        "/api/analyst/chat",
        json={
            "message": question,
            "context": {"selected_node_id": demo.focus_node_id, "active_scenario": scenario, "scenario_a": scenario},
            "force_offline": True,
        },
    )
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = _sse(r)
    assert events[0]["type"] == "status" and events[0]["mode"] == "offline"
    calls = [e["name"] for e in events if e["type"] == "tool_call"]
    assert "get_affected_components" in calls
    assert all(e["ok"] for e in events if e["type"] == "tool_result"), [e for e in events if e["type"] == "tool_result"]
    text = [e for e in events if e["type"] == "message"][-1]["text"]
    assert "Why it cascades" in text and "Data caveats" in text
    assert events[-1]["type"] == "done"


@pytest.mark.parametrize(
    "question,expected_tool",
    [
        ("Which component is the most important in this network?", "get_network_metrics"),
        ("What depends on this infrastructure component?", "trace_network_path"),
        ("What happens if this fails?", "run_failure_simulation"),
        ("Is this data real?", "get_data_provenance"),
    ],
)
def test_offline_analyst_intents(client, question: str, expected_tool: str) -> None:
    demo = load_demo_script()
    r = client.post(
        "/api/analyst/chat",
        json={"message": question, "context": {"selected_node_id": demo.focus_node_id}, "force_offline": True},
    )
    events = _sse(r)
    calls = [e["name"] for e in events if e["type"] == "tool_call"]
    assert expected_tool in calls, (question, calls)
    assert [e for e in events if e["type"] == "message"], "no answer produced"
    assert not [e for e in events if e["type"] == "error"]


# --- regressions from the adversarial review (offline analyst target resolution & routing) ---


def _offline(client, message: str, context: dict | None = None) -> tuple[list[tuple[str, dict]], str]:
    r = client.post("/api/analyst/chat", json={"message": message, "context": context or {}, "force_offline": True})
    events = _sse(r)
    calls = [(e["name"], e["input"]) for e in events if e["type"] == "tool_call"]
    text = [e for e in events if e["type"] == "message"][-1]["text"]
    return calls, text


def test_named_substation_resolves_to_substation_not_intersection(client) -> None:
    calls, _ = _offline(client, "What happens if the Five Points substation fails?")
    assert calls[0][0] == "run_failure_simulation" and calls[0][1]["failed_nodes"] == ["PWR-DS-FIVEPOINTS"]
    calls, _ = _offline(client, "What depends on the Grady substation?")
    assert calls[0][1]["node_id"] == "PWR-DS-GRADY"


def test_edge_ids_are_simulated_as_edges_and_unknown_ids_are_not_guessed(client) -> None:
    calls, _ = _offline(client, "What happens if UGD-DB-06 fails?")
    assert calls[0][1]["failed_edges"] == ["UGD-DB-06"] and calls[0][1]["failed_nodes"] == []
    calls, text = _offline(client, "What happens if XYZ-123 fails?")
    assert calls == [] and "couldn't find `XYZ-123`" in text


def test_named_component_overrides_loaded_scenario_unless_it_is_a_victim(client) -> None:
    a = {"failed_nodes": ["PWR-DS-FIVEPOINTS"]}
    calls, _ = _offline(client, "How could we mitigate a failure of PWR-TS-EAST?", {"active_scenario": a})
    assert calls[0][1]["failed_nodes"] == ["PWR-TS-EAST"]
    b = {"failed_edges": ["UGD-DB-06"]}
    calls, _ = _offline(client, "Why did Grady Memorial Hospital lose communications?", {"active_scenario": b})
    assert calls[0][1]["failed_edges"] == ["UGD-DB-06"]


def test_provenance_and_system_scoped_metrics(client) -> None:
    calls, text = _offline(client, "How much of the utility data is real versus simulated?")
    assert calls == [("get_data_provenance", {})] and "Nothing is labelled verified" in text
    calls, text = _offline(client, "What is the most important component in the water network?")
    assert calls[0] == ("get_network_metrics", {"top_n": 8, "system": "water"}) and "water network" in text


def test_affected_components_excludes_rerouted_info_rows(client) -> None:
    from app.ai.tools import ToolContext, execute_tool
    from app.models.schemas import AnalystContext
    from app.simulation import get_engine

    ctx = ToolContext(engine=get_engine(), context=AnalystContext())
    ok, out = execute_tool(ctx, "get_affected_components", {"failed_nodes": ["TEL-IX-56MARIETTA"]})
    r = get_engine().simulate(__import__("app.models.schemas", fromlist=["ScenarioInput"]).ScenarioInput(failed_nodes=["TEL-IX-56MARIETTA"]))
    assert ok and out.payload["count"] == r.impact_metrics.total_nodes_affected


def test_non_finite_and_oversized_inputs_are_422(client) -> None:
    raw = '{"failed_nodes":["PWR-DS-FIVEPOINTS"],"horizon_hours":NaN}'
    assert client.post("/api/simulate", content=raw, headers={"Content-Type": "application/json"}).status_code == 422
    assert client.post("/api/simulate", json={"failed_nodes": ["X"] * 500}).status_code == 422


def test_sse_sends_heartbeats_while_the_analyst_is_silent() -> None:
    import asyncio

    from app.api.routes import _sse

    async def slow():
        yield {"type": "status", "mode": "offline"}
        await asyncio.sleep(0.25)
        yield {"type": "done", "tool_calls": 0, "mode": "offline"}

    async def boom():
        yield {"type": "status", "mode": "llm"}
        raise RuntimeError("model exploded")

    async def collect(gen):
        return [chunk async for chunk in gen]

    chunks = asyncio.run(collect(_sse(slow(), heartbeat_s=0.05)))
    assert chunks[0].startswith(b"data:") and chunks[-1].startswith(b"data:")
    assert b": ping\n\n" in chunks, chunks
    chunks = asyncio.run(collect(_sse(boom(), heartbeat_s=5)))
    text = b"".join(chunks).decode()
    assert "model exploded" in text and '"type": "done"' in text


def test_spof_set_matches_node_details() -> None:
    from app.simulation import get_engine

    engine = get_engine()
    spof = set(engine.single_points_of_failure())
    assert spof, "the demo network should have single points of failure"
    for n in engine.network.nodes:
        assert engine.node_details(n.id).is_single_point_of_failure == (n.id in spof), n.id
