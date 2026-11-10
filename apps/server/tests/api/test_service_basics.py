import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app


def test_health_is_available_without_an_open_workspace() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "schema_version": "0.1"}


def test_business_route_returns_structured_conflict_before_workspace_open() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/people")

    assert response.status_code == 409
    assert response.json() == {
        "error": {
            "code": "workspace_not_open",
            "message": "请先打开一个工作区。",
            "details": {},
        }
    }


def test_current_workspace_can_be_checked_and_resumed(tmp_path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()

    with TestClient(create_app()) as client:
        unopened = client.get("/api/workspaces/current")
        opened = client.post("/api/workspaces/open", json={"path": str(vault)})
        current = client.get("/api/workspaces/current")

    assert unopened.status_code == 200
    assert unopened.json() == {"open": False}
    assert opened.status_code == 200
    assert current.status_code == 200
    assert current.json()["open"] is True
    assert current.json()["path"] == str(vault.resolve())


def test_recent_workspace_is_restored_after_local_service_restart(tmp_path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    state_file = tmp_path / "desktop-state.json"

    with TestClient(create_app(recent_workspace_file=state_file)) as client:
        opened = client.post("/api/workspaces/open", json={"path": str(vault)})

    assert opened.status_code == 200
    assert state_file.is_file()

    with TestClient(create_app(recent_workspace_file=state_file)) as client:
        restored = client.get("/api/workspaces/current")

    assert restored.status_code == 200
    assert restored.json()["open"] is True
    assert restored.json()["path"] == str(vault.resolve())


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("post", "/api/workspaces/refresh", None),
        ("post", "/api/workspaces/rebuild-index", None),
        ("get", "/api/events", None),
        (
            "post",
            "/api/events",
            {
                "title": "虚构事件",
                "occurred_at": "2026-07-27T00:00:00Z",
                "person_ids": ["10000000-0000-4000-8000-000000000001"],
            },
        ),
        ("get", "/api/sources", None),
        (
            "post",
            "/api/sources/20000000-0000-4000-8000-000000000001/chat-analysis",
            {"engine": "local_demo", "profile_id": "inherited"},
        ),
        (
            "post",
            "/api/sources/text",
            {
                "title": "虚构材料",
                "text": "这是一段虚构材料。",
                "source_kind": "text",
                "person_ids": ["10000000-0000-4000-8000-000000000001"],
                "event_ids": [],
            },
        ),
        ("get", "/api/evidence", None),
        (
            "post",
            "/api/evidence",
            {
                "source_id": "20000000-0000-4000-8000-000000000001",
                "quote": "虚构",
                "locator": {"kind": "text_quote", "start": 0, "end": 2},
                "evidence_kind": "direct_quote",
                "reliability": "medium",
                "person_ids": ["10000000-0000-4000-8000-000000000001"],
                "event_ids": [],
            },
        ),
        ("get", "/api/reports", None),
        (
            "post",
            "/api/reports",
            {
                "title": "虚构报告",
                "template_family": "special",
                "person_ids": ["10000000-0000-4000-8000-000000000001"],
                "evidence_ids": ["30000000-0000-4000-8000-000000000001"],
            },
        ),
        (
            "get",
            "/api/records/20000000-0000-4000-8000-000000000001",
            None,
        ),
    ],
)
def test_all_workspace_routes_require_an_explicit_open(
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    with TestClient(create_app()) as client:
        response = client.request(method, path, json=payload)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "workspace_not_open"


def test_cors_allows_localhost_and_tauri_but_rejects_non_local_origins() -> None:
    with TestClient(create_app()) as client:
        local = client.options(
            "/api/people",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        tauri = client.options(
            "/api/people",
            headers={
                "Origin": "tauri://localhost",
                "Access-Control-Request-Method": "GET",
            },
        )
        remote = client.options(
            "/api/people",
            headers={
                "Origin": "https://example.com",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert local.status_code == 200
    assert local.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert tauri.status_code == 200
    assert tauri.headers["access-control-allow-origin"] == "tauri://localhost"
    assert "access-control-allow-origin" not in remote.headers


def test_request_validation_errors_use_the_shared_error_envelope() -> None:
    with TestClient(create_app()) as client:
        response = client.post("/api/workspaces/open", json={"path": 42})

    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "validation_error",
            "message": "请求数据无效。",
            "details": {
                "issues": [
                    {
                        "path": "body.path",
                        "type": "string_type",
                    }
                ]
            },
        }
    }


def test_unknown_api_route_uses_the_shared_error_envelope() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/not-a-route")

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "not_found",
            "message": "未找到请求的接口。",
            "details": {},
        }
    }
