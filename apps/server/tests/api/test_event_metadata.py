from pathlib import Path

import yaml
from fastapi.testclient import TestClient
from lingxi.main import create_app


def _open_with_person(client: TestClient, vault: Path) -> dict:
    assert client.post("/api/workspaces/open", json={"path": str(vault)}).status_code == 200
    response = client.post(
        "/api/people", json={"display_name": "林舟（虚构）", "relation_to_user": "同事"}
    )
    assert response.status_code == 201
    return response.json()


def _create_event(client: TestClient, person: dict) -> dict:
    response = client.post(
        "/api/events",
        json={
            "title": "虚构项目讨论",
            "occurred_at": "2026-11-09T10:00:00+08:00",
            "person_ids": [person["id"]],
            "location": "示例会议室",
            "summary": "讨论交付安排。\n各自说明时间限制。",
        },
    )
    assert response.status_code == 201
    return response.json()


def test_event_metadata_survives_restart_and_updates_in_place(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        person = _open_with_person(client, tmp_path)
        event = _create_event(client, person)
        file = tmp_path / "events" / f"{event['id']}.md"
        assert "地点：示例会议室" in file.read_text()
        assert "## 事件简述\n\n讨论交付安排。" in file.read_text()

    with TestClient(create_app()) as client:
        assert client.post("/api/workspaces/open", json={"path": str(tmp_path)}).status_code == 200
        restored = client.get("/api/events").json()["items"][0]
        assert restored["location"] == "示例会议室"
        assert restored["summary"] == event["summary"]
        response = client.patch(
            f"/api/events/{event['id']}",
            json={
                "title": "虚构项目复谈",
                "occurred_at": "2026-11-10T11:00:00+08:00",
                "location": "",
                "summary": "补充一项已确认安排。",
                "expected_revision": restored["revision"],
            },
        )
        assert response.status_code == 200
        updated = response.json()
        assert updated["id"] == event["id"]
        assert updated["revision"] == event["revision"] + 1
        assert updated["person_ids"] == event["person_ids"]
        assert updated["source_ids"] == []
        assert updated["location"] == ""
        assert updated["summary"] == "补充一项已确认安排。"
        assert "# 虚构项目复谈" in file.read_text()
        assert "讨论交付安排。" not in file.read_text()
        assert len(list((tmp_path / "events").glob("*.md"))) == 1


def test_event_update_rejects_external_changes_and_stale_revision(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        person = _open_with_person(client, tmp_path)
        event = _create_event(client, person)
        file = tmp_path / "events" / f"{event['id']}.md"
        changed = file.read_bytes() + "\n人工补充：等待下一次核对。\n".encode()
        file.write_bytes(changed)
        rejected = client.patch(
            f"/api/events/{event['id']}", json={"summary": "不得覆盖人工补充"}
        )
        assert rejected.status_code == 409
        assert rejected.json()["error"]["code"] == "workspace_conflict"
        assert file.read_bytes() == changed
        assert client.post("/api/workspaces/refresh").status_code == 200
        updated = client.patch(
            f"/api/events/{event['id']}",
            json={"summary": "已核对新的概要。", "expected_revision": 1},
        )
        assert updated.status_code == 200
        assert "人工补充：等待下一次核对。" in file.read_text()
        after = file.read_bytes()
        stale = client.patch(
            f"/api/events/{event['id']}",
            json={"location": "过期编辑", "expected_revision": 1},
        )
        assert stale.status_code == 409
        assert file.read_bytes() == after
        assert not list((tmp_path / "events").glob(".*.tmp"))


def test_legacy_event_is_readable_and_notes_survive_metadata_update(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        person = _open_with_person(client, tmp_path)
        event = _create_event(client, person)
    file = tmp_path / "events" / f"{event['id']}.md"
    legacy = {key: value for key, value in event.items() if key not in {"location", "summary"}}
    file.write_text(
        "---\n" + yaml.safe_dump(legacy, allow_unicode=True, sort_keys=False)
        + f"---\n# {event['title']}\n\n发生时间：{event['occurred_at']}\n"
        + "\n## 后续跟进\n\n保留这段人工记录。\n"
    )
    with TestClient(create_app()) as client:
        assert client.post("/api/workspaces/open", json={"path": str(tmp_path)}).status_code == 200
        response = client.patch(
            f"/api/events/{event['id']}", json={"location": "新的示例地点"}
        )
        assert response.status_code == 200
        assert response.json()["location"] == "新的示例地点"
        assert "保留这段人工记录。" in file.read_text()
        assert "地点：新的示例地点" in file.read_text()
        assert client.patch(f"/api/events/{event['id']}", json={}).status_code == 422
        assert client.patch(
            f"/api/events/{event['id']}", json={"person_ids": []}
        ).status_code == 422
