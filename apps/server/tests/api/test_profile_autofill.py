from typing import Any

from fastapi.testclient import TestClient
from lingxi.analysis.cli import CliExecutionError
from lingxi.main import create_app


def test_local_autofill_preview_works_without_opening_a_workspace() -> None:
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/profile-autofill/preview",
            json={
                "text": "姓名：林舟\n关系：朋友\n职业：建筑设计师",
                "engine": "local_demo",
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["preview"]["person"] == {
        "display_name": "林舟",
        "relation_to_user": "朋友",
    }
    assert body["preview"]["candidates"][0]["value"] == "建筑设计师"
    assert body["execution"] == {
        "engine": "local_demo",
        "profile_id": "local_demo",
        "data_destination": "local_only",
    }


def test_cli_autofill_uses_the_selected_engine_and_profile() -> None:
    calls: list[tuple[str, str, str]] = []
    preview: dict[str, Any] = {
        "schema_version": "0.1",
        "person": {"display_name": "林舟", "relation_to_user": None},
        "candidates": [],
        "skipped_sections": [],
    }

    class FakeAdapter:
        def run_profile_autofill(self, text: str) -> dict[str, Any]:
            calls.append(("run", "", text))
            return preview

    def factory(engine: str, profile_id: str) -> FakeAdapter:
        calls.append(("factory", engine, profile_id))
        return FakeAdapter()

    with TestClient(create_app(cli_adapter_factory=factory)) as client:
        response = client.post(
            "/api/profile-autofill/preview",
            json={
                "text": "一段待整理原文",
                "engine": "codex",
                "profile_id": "inherited",
            },
        )

    assert response.status_code == 200
    assert calls == [
        ("factory", "codex", "inherited"),
        ("run", "", "一段待整理原文"),
    ]
    assert response.json()["preview"] == preview
    assert response.json()["execution"]["data_destination"] == "selected_cli_process"


def test_cli_autofill_failure_is_explicit_and_does_not_fake_a_preview() -> None:
    def factory(_engine: str, _profile_id: str) -> Any:
        raise CliExecutionError("private failure detail")

    with TestClient(create_app(cli_adapter_factory=factory)) as client:
        response = client.post(
            "/api/profile-autofill/preview",
            json={"text": "一段待整理原文", "engine": "claude"},
        )

    assert response.status_code == 502
    assert response.json() == {
        "error": {
            "code": "profile_autofill_failed",
            "message": (
                "AI 自动整理未能完成；原文尚未写入工作区，"
                "可切换本地规则预览后重试。"
            ),
            "details": {"reason": "execution_failed"},
        }
    }
