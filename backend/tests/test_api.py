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
