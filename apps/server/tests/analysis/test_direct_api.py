import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from lingxi.analysis.cli import AnalysisOutputInvalid, CliExecutionError
from lingxi.analysis.direct_api import DirectApiAdapter, DirectModelSettings
from lingxi.main import create_app


@pytest.fixture
def endpoint():
    calls = []
    state = {"output": {"answer": "材料不足，需要补充。", "source_ids": []}, "status": 200}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, body, self.headers.get("Authorization")))
            self.send_response(state["status"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": json.dumps(state["output"], ensure_ascii=False),
                                }
                            }
                        ]
                    }
                ).encode()
            )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", calls, state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_real_http_transport_and_scope_validation(endpoint):
    url, calls, state = endpoint
    settings = DirectModelSettings()
    settings.configure(base_url=url, model="fixture-model", api_key="fixture-secret")
    adapter = DirectApiAdapter(settings)
    context = {"question": "有什么依据？", "person": {}, "sources": [], "evidence": []}
    assert adapter.answer_workspace_question(context)["source_ids"] == []
    assert calls[0][0] == "/v1/chat/completions"
    assert calls[0][2] == "Bearer fixture-secret"
    assert calls[0][1]["response_format"] == {"type": "json_object"}
    state["output"]["source_ids"] = ["outside-source"]
    with pytest.raises(AnalysisOutputInvalid):
        adapter.answer_workspace_question(context)
    state["status"] = 401
    with pytest.raises(CliExecutionError) as error:
        adapter.test_connection()
    assert "fixture-secret" not in str(error.value)


def test_configuration_api_is_session_scoped_and_never_returns_key(endpoint, monkeypatch):
    url, calls, _ = endpoint
    with TestClient(create_app()) as client:
        result = client.post(
            "/api/model-settings",
            json={
                "base_url": url,
                "model": "fixture-model",
                "api_key": "fixture-secret",
            },
        )
        assert result.status_code == 200
        assert result.json()["configured"]
        assert result.json()["key_storage"] == "session"
        assert "fixture-secret" not in result.text
        assert calls == []  # Saving alone does not call the endpoint.
        assert client.post("/api/model-settings/test").status_code == 200
        monkeypatch.setenv("LINGXI_TEST_FAKE_API_KEY", "env-fixture")
        configured = client.post(
            "/api/model-settings",
            json={
                "base_url": url,
                "model": "fixture-model",
                "key_env": "LINGXI_TEST_FAKE_API_KEY",
            },
        ).json()
        assert configured["key_storage"] == "environment"
        assert client.post("/api/model-settings/test").status_code == 200
        assert calls[-1][2] == "Bearer env-fixture"
        cleared = client.post(
            "/api/model-settings",
            json={
                "base_url": url,
                "model": "fixture-model",
                "key_env": "LINGXI_TEST_FAKE_API_KEY",
                "clear_key": True,
            },
        ).json()
        assert not cleared["has_key"]
        assert cleared["key_env"] == ""
        assert "LINGXI_TEST_FAKE_API_KEY" in __import__("os").environ
    with TestClient(create_app()) as client:
        assert not client.get("/api/model-settings").json()["configured"]


def test_configuration_rejects_credentials_in_urls_and_clear_key():
    settings = DirectModelSettings()
    with pytest.raises(ValueError):
        settings.configure(base_url="https://user:secret@example.com/v1", model="m")
    with pytest.raises(ValueError):
        settings.configure(base_url="http://example.com/v1", model="m")
    settings.configure(base_url="https://example.com/v1", model="m", api_key="fixture")
    assert "fixture" not in repr(settings)
    settings.configure(base_url="https://example.com/v1", model="m", clear_key=True)
    assert not settings.public()["has_key"]


def test_model_connection_reports_authentication_without_secret_or_provider_body(endpoint):
    url, _, state = endpoint
    with TestClient(create_app()) as client:
        client.post("/api/model-settings", json={"base_url":url,"model":"fixture-model","api_key":"fixture-secret"})
        state["status"] = 401
        result = client.post("/api/model-settings/test")
        assert result.status_code == 401
        assert result.json()["error"]["code"] == "direct_api_authentication_failed"
        assert result.json()["error"]["details"]["provider_http_status"] == 401
        assert "fixture-secret" not in result.text
