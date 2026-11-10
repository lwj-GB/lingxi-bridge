import hashlib
import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from lingxi.analysis.autofill import build_local_autofill
from lingxi.api.assistant_create import router
from lingxi.main import create_app
from lingxi.workspace.service import WorkspaceError, WorkspaceService

TEXT = "姓名：小刘（虚构）\n关系：朋友\n喜欢：喝茶🍵\n职业：设计师\n"


def payload():
    return {
        "text": TEXT,
        "preview": build_local_autofill(TEXT),
        "display_name": "小刘（虚构）",
        "relation_to_user": "朋友",
        "request_id": str(uuid4()),
    }


def test_create_preserves_original_and_exact_quotes_with_idempotency(tmp_path):
    workspace = WorkspaceService()
    workspace.open(tmp_path)
    data = payload()
    result = workspace.create_person_from_preview(**data)
    assert result["replayed"] is False
    assert (tmp_path / result["source"]["original_path"]).read_text() == TEXT
    assert len(result["person"]["profile_sections"]) == 2
    for entry, evidence in zip(result["person"]["profile_sections"], result["evidence"]):
        assert entry["evidence_ids"] == [evidence["id"]]
        assert evidence["quote"] == TEXT[evidence["locator"]["start"]:evidence["locator"]["end"]]
    workspace = WorkspaceService()
    workspace.open(tmp_path)
    replay = workspace.create_person_from_preview(**data)
    assert replay["replayed"] is True
    assert replay["person"]["id"] == result["person"]["id"]
    assert len(workspace.list_entities("person")) == 1
    with pytest.raises(WorkspaceError, match="请求编号"):
        workspace.create_person_from_preview(**{**data, "display_name": "另一个人"})


def test_invalid_quote_leaves_no_person_or_source(tmp_path):
    workspace = WorkspaceService()
    workspace.open(tmp_path)
    data = payload()
    data["preview"]["candidates"][0]["quote"] = "错误的引文"
    with pytest.raises(WorkspaceError, match="原文引用"):
        workspace.create_person_from_preview(**data)
    assert workspace.list_entities("person") == []
    assert workspace.list_entities("source") == []
    assert list((tmp_path / "attachments").iterdir()) == []


def test_write_failure_archives_only_new_files_and_retry_succeeds(tmp_path, monkeypatch):
    import lingxi.workspace.service as service

    workspace = WorkspaceService()
    workspace.open(tmp_path)
    existing = workspace.create_person("已有人物", "朋友")
    data = payload()
    original = service._atomic_create

    def fail_source(path, content):
        if path.parent.name == "sources":
            raise OSError("simulated write failure")
        return original(path, content)

    monkeypatch.setattr(service, "_atomic_create", fail_source)
    with pytest.raises(OSError, match="simulated"):
        workspace.create_person_from_preview(**data)
    assert [p["id"] for p in workspace.list_entities("person")] == [existing["id"]]
    assert workspace.list_entities("source") == []
    assert workspace.list_entities("evidence") == []
    assert list((tmp_path / "归档" / "未完成建档").rglob("original.txt"))
    monkeypatch.setattr(service, "_atomic_create", original)
    created = workspace.create_person_from_preview(**data)
    assert created["person"]["display_name"] == data["display_name"]


def test_open_recovers_interrupted_creation_before_index_scan(tmp_path):
    workspace = WorkspaceService()
    workspace.open(tmp_path)
    source_id = str(uuid4())
    relative = f"attachments/{source_id}/original.txt"
    original = tmp_path / relative
    original.parent.mkdir()
    original.write_text(TEXT)
    journals = tmp_path / ".lingxi" / "assistant-transactions"
    journals.mkdir()
    journal = journals / f"{uuid4()}.json"
    journal.write_text(json.dumps({"files": {relative: hashlib.sha256(TEXT.encode()).hexdigest()}}))
    WorkspaceService().open(tmp_path)
    assert not original.exists()
    assert not journal.exists()
    assert list((tmp_path / "归档").rglob("original.txt"))[0].read_text() == TEXT


def test_api_validates_and_creates_in_open_workspace(tmp_path):
    app = create_app()
    app.include_router(router)
    with TestClient(app) as client:
        assert client.post("/api/workspaces/open", json={"path": str(tmp_path)}).status_code == 200
        data = payload()
        response = client.post("/api/assistant/people", json=data)
        assert response.status_code == 200, response.text
        assert response.json()["person"]["display_name"] == data["display_name"]
        assert client.post("/api/assistant/people", json=data).json()["replayed"] is True
        data["request_id"] = "not-a-uuid"
        assert client.post("/api/assistant/people", json=data).status_code == 422


def test_recovery_does_not_move_externally_changed_files(tmp_path):
    workspace = WorkspaceService()
    workspace.open(tmp_path)
    relative = f"attachments/{uuid4()}/original.txt"
    original = tmp_path / relative
    original.parent.mkdir()
    original.write_text("用户后来修改的资料")
    journals = tmp_path / ".lingxi" / "assistant-transactions"
    journals.mkdir()
    journal = journals / f"{uuid4()}.json"
    journal.write_text(json.dumps({"files": {relative: hashlib.sha256(TEXT.encode()).hexdigest()}}))
    with pytest.raises(WorkspaceError, match="外部修改"):
        WorkspaceService().open(tmp_path)
    assert original.read_text() == "用户后来修改的资料"
    assert journal.exists()
