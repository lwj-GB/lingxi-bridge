from pathlib import Path

from fastapi.testclient import TestClient
from lingxi.main import create_app

CHAT = """\
2026-07-27 09:00 林澄：周末去植物园散步吧
2026-07-27 09:01 我：好啊，周末去植物园散步
2026-07-27 20:00 林澄：晚上再确认植物园路线
"""


def _source(client: TestClient, vault: Path) -> dict:
    assert client.post("/api/workspaces/open", json={"path": str(vault)}).status_code == 200
    person = client.post(
        "/api/people",
        json={"display_name": "林澄（虚构）", "relation_to_user": "朋友"},
    ).json()
    return client.post(
        "/api/sources/text",
        json={
            "title": "虚构植物园聊天",
            "text": CHAT,
            "source_kind": "chat_export",
            "person_ids": [person["id"]],
            "event_ids": [],
        },
    ).json()


def test_chat_analysis_returns_local_statistics_with_source_identity(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        source = _source(client, tmp_path)
        response = client.post(
            f"/api/sources/{source['id']}/chat-analysis",
            json={"engine": "local_demo"},
        )

    assert response.status_code == 200
    value = response.json()
    assert value["execution"] == {
        "engine": "local_demo",
        "profile_id": "local_demo",
        "data_destination": "local_only",
        "degraded": False,
        "degraded_reason": None,
    }
    assert value["analysis"]["source"]["id"] == source["id"]
    assert value["analysis"]["source"]["sha256"] == source["sha256"]
    assert value["analysis"]["metrics"]["messages"] == 3
    assert any("植物园" in item["term"] for item in value["analysis"]["top_terms"])


def test_chat_analysis_can_use_selected_cli_for_topics(tmp_path: Path) -> None:
    calls: list[tuple[str, list[dict[str, object]]]] = []

    class StubAdapter:
        def run_chat_topics(
            self,
            source_id: str,
            messages: list[dict[str, object]],
        ) -> dict[str, object]:
            calls.append((source_id, messages))
            return {
                "schema_version": "0.1",
                "source_id": source_id,
                "topics": [
                    {
                        "title": "周末活动安排",
                        "summary": "消息讨论了植物园散步与路线。",
                        "keywords": ["植物园", "路线"],
                        "message_indexes": [0, 1, 2],
                    }
                ],
            }

    with TestClient(
        create_app(cli_adapter_factory=lambda _engine, _profile: StubAdapter())
    ) as client:
        source = _source(client, tmp_path)
        response = client.post(
            f"/api/sources/{source['id']}/chat-analysis",
            json={
                "engine": "codex",
                "profile_id": "inherited",
                "material_scope_confirmed": True,
            },
        )

    assert response.status_code == 200
    value = response.json()
    assert value["execution"]["data_destination"] == "selected_cli_process"
    assert value["execution"]["degraded"] is False
    assert value["analysis"]["topic_method"] == "cli_assisted"
    assert value["analysis"]["topics"][0]["title"] == "周末活动安排"
    assert calls[0][0] == source["id"]
    assert calls[0][1][0]["text"] == "周末去植物园散步吧"


def test_chat_analysis_rejects_unconfirmed_cli_material_scope(
    tmp_path: Path,
) -> None:
    adapter_called = False

    def adapter_factory(_engine: str, _profile: str):
        nonlocal adapter_called
        adapter_called = True
        raise AssertionError("unconfirmed material must not reach the CLI")

    with TestClient(create_app(cli_adapter_factory=adapter_factory)) as client:
        source = _source(client, tmp_path)
        response = client.post(
            f"/api/sources/{source['id']}/chat-analysis",
            json={"engine": "codex", "profile_id": "inherited"},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "material_scope_not_confirmed"
    assert adapter_called is False
