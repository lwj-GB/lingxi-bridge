import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app


@pytest.fixture
def provider():
    state = {"output": {}, "calls": [], "before_response": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            state["calls"].append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            if state["before_response"]:
                state["before_response"]()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"choices": [{"message": {
                "content": json.dumps(state["output"], ensure_ascii=False)
            }}]}).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def _materials(client, vault, provider_url):
    assert client.post("/api/workspaces/open", json={"path": str(vault)}).status_code == 200
    person = client.post("/api/people", json={
        "display_name": "林舟（虚构）", "relation_to_user": "同事"
    }).json()
    event = client.post("/api/events", json={
        "title": "虚构沟通复盘", "occurred_at": "2026-11-09T10:00:00+08:00",
        "person_ids": [person["id"]], "summary": "核对当时各自理解的安排。"
    }).json()
    text = "[00:43.2–00:45.0][对面] 我以为你已经答应了。\n随后我说明：先看一下时间。"
    source = client.post("/api/sources/text", json={
        "title": "虚构会谈转写", "text": text, "source_kind": "text",
        "person_ids": [person["id"]], "event_ids": [event["id"]]
    }).json()
    outside = client.post("/api/sources/text", json={
        "title": "未选择的私人笔记", "text": "这份材料不得发送给模型。", "source_kind": "text",
        "person_ids": [person["id"]], "event_ids": []
    }).json()
    event = client.get("/api/events").json()["items"][0]
    if provider_url:
        assert client.post("/api/model-settings", json={
            "base_url": provider_url, "model": "local-fixture", "api_key": "test-key-only"
        }).status_code == 200
    return event, source, outside, text


def _output(source, text):
    quotes = ["我以为你已经答应了。", "先看一下时间。"]
    return {"schema_version": "0.1", "summary": "双方对安排的理解不同，候选节点需要人工核对。",
            "nodes": [{"label": label, "source_id": source["id"], "quote": quote,
                       "quote_start": text.index(quote),
                       "quote_end": text.index(quote) + len(quote), "timestamp_ms": 999999}
                      for quote, label in zip(quotes, ["提出分歧", "澄清安排"], strict=True)]}


def _payload(event, source):
    return {"source_ids": [source["id"]], "engine": "api", "scope_confirmed": True,
            "expected_revision": event["revision"]}


def test_real_http_event_analysis_stores_only_scoped_grounded_candidates(tmp_path, provider):
    url, state = provider
    with TestClient(create_app()) as client:
        event, source, outside, text = _materials(client, tmp_path, url)
        state["output"] = _output(source, text)
        original = tmp_path / source["original_path"]
        source_before = original.read_bytes()
        response = client.post(f"/api/events/{event['id']}/analysis", json=_payload(event, source))
        assert response.status_code == 200, response.text
        analysis = response.json()["analysis"]
        assert response.json()["revision"] == event["revision"] + 1
        assert analysis["source_ids"] == [source["id"]]
        assert analysis["source_hashes"] == {
            source["id"]: hashlib.sha256(source_before).hexdigest()
        }
        assert analysis["nodes"][0]["timestamp_ms"] == 43200
        assert "timestamp_ms" not in analysis["nodes"][1]
        assert all(node["status"] == "candidate" for node in analysis["nodes"])
        assert original.read_bytes() == source_before
        request = json.dumps(state["calls"][0], ensure_ascii=False)
        assert source["id"] in request
        assert text in state["calls"][0]["messages"][1]["content"].replace("\\n", "\n")
        assert outside["id"] not in request
        assert "这份材料不得发送给模型" not in request
        event_file = tmp_path / "events" / f"{event['id']}.md"
        assert "AI 候选分析（待核对）" in event_file.read_text()
        assert "test-key-only" not in event_file.read_text()
        node = analysis["nodes"][0]
        edited = client.patch(
            f"/api/events/{event['id']}/nodes/{node['id']}",
            json={"label": "双方核对原先的理解", "expected_revision": response.json()["revision"]},
        )
        assert edited.status_code == 200
        analysis = edited.json()["analysis"]
        assert analysis["nodes"][0] == {**node, "label": "双方核对原先的理解"}
        assert original.read_bytes() == source_before

    with TestClient(create_app()) as client:
        assert client.post("/api/workspaces/open", json={"path": str(tmp_path)}).status_code == 200
        restored = client.get("/api/events").json()["items"][0]
        assert restored["analysis"] == analysis


@pytest.mark.parametrize("invalid", ["quote", "position", "scope"])
def test_invalid_model_quote_or_scope_is_never_saved(tmp_path, provider, invalid):
    url, state = provider
    with TestClient(create_app()) as client:
        event, source, outside, text = _materials(client, tmp_path, url)
        state["output"] = _output(source, text)
        node = state["output"]["nodes"][0]
        node.update({"quote": "凭空编造原话"} if invalid == "quote"
                    else {"quote_start": 0} if invalid == "position"
                    else {"source_id": outside["id"]})
        event_file = tmp_path / "events" / f"{event['id']}.md"
        before = event_file.read_bytes()
        response = client.post(f"/api/events/{event['id']}/analysis", json=_payload(event, source))
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "event_analysis_invalid_output"
        assert event_file.read_bytes() == before


def test_scope_confirmation_and_association_are_checked_before_call(tmp_path, provider):
    url, state = provider
    with TestClient(create_app()) as client:
        event, source, outside, _ = _materials(client, tmp_path, url)
        payload = _payload(event, source)
        response = client.post(f"/api/events/{event['id']}/analysis", json={
            **payload, "scope_confirmed": False
        })
        assert response.status_code == 422
        response = client.post(f"/api/events/{event['id']}/analysis", json={
            **payload, "source_ids": [outside["id"]]
        })
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "invalid_material_scope"
        response = client.post(f"/api/events/{event['id']}/analysis", json={
            **payload, "expected_revision": event["revision"] + 1
        })
        assert response.status_code == 409
        original = tmp_path / source["original_path"]
        original.write_bytes(original.read_bytes() + b"modified")
        response = client.post(f"/api/events/{event['id']}/analysis", json=payload)
        assert response.status_code == 422
        assert state["calls"] == []


@pytest.mark.parametrize("changed_object", ["event", "source"])
def test_external_change_during_model_call_is_not_overwritten(tmp_path, provider, changed_object):
    url, state = provider
    with TestClient(create_app()) as client:
        event, source, _, text = _materials(client, tmp_path, url)
        state["output"] = _output(source, text)
        event_file = tmp_path / "events" / f"{event['id']}.md"
        target = event_file if changed_object == "event" else tmp_path / source["original_path"]
        changed = target.read_bytes() + "\n人工补充不得覆盖。\n".encode()
        state["before_response"] = lambda: target.write_bytes(changed)
        response = client.post(f"/api/events/{event['id']}/analysis", json=_payload(event, source))
        assert response.status_code == 409
        assert target.read_bytes() == changed
        assert "analysis" not in client.get("/api/events").json()["items"][0]


def test_missing_model_configuration_fails_clearly_without_placeholder(tmp_path: Path):
    with TestClient(create_app()) as client:
        event, source, _, _ = _materials(client, tmp_path, None)
        response = client.post(f"/api/events/{event['id']}/analysis", json=_payload(event, source))
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "event_analysis_failed"
        assert "analysis" not in client.get("/api/events").json()["items"][0]
