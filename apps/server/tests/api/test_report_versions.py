from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from lingxi.analysis.placeholder import build_safe_placeholder
from lingxi.analysis.report_charts import plotting_capabilities
from lingxi.main import create_app
from lingxi.workspace import service as service_module
from lingxi.workspace.service import WorkspaceError


def _prepare(client: TestClient, vault: Path) -> tuple[dict, dict]:
    assert client.post("/api/workspaces/open", json={"path": str(vault)}).status_code == 200
    person = client.post("/api/people", json={
        "display_name": "林舟（虚构）", "relation_to_user": "朋友",
    }).json()
    text = "明天想去安静的地方散步。"
    source = client.post("/api/sources/text", json={
        "title": "虚构记录", "text": text, "source_kind": "text",
        "person_ids": [person["id"]], "event_ids": [],
    }).json()
    evidence = client.post("/api/evidence", json={
        "source_id": source["id"], "quote": text,
        "locator": {"kind": "text_quote", "start": 0, "end": len(text)},
        "evidence_kind": "user_statement", "reliability": "high",
        "person_ids": [person["id"]], "event_ids": [],
    }).json()
    payload = {
        "title": "近期沟通（虚构）", "template_family": "special",
        "template_variant": "communication_prep", "person_ids": [person["id"]],
        "evidence_ids": [evidence["id"]], "engine": "safe_placeholder",
    }
    response = client.post("/api/reports", json=payload)
    assert response.status_code == 201, response.text
    return payload, response.json()


def test_new_version_preserves_old_snapshot_and_survives_reopen(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        payload, first = _prepare(client, tmp_path)
        topic_id = first["topic"]["id"]
        snapshot = tmp_path / "reports" / "snapshots" / f"{first['snapshot']['id']}.md"
        original = snapshot.read_bytes()
        visible, _ = original.decode().split("<!-- lingxi-structured-analysis", 1)
        assert "## 材料里看到了什么" in visible
        assert "```json" not in visible
        assert first["analysis"]["claims"][0]["text"] in visible
        second = client.post("/api/reports", json={
            **payload, "title": "近期沟通修订（虚构）",
            "topic_id": topic_id, "expected_revision": 1,
        })
        assert second.status_code == 201, second.text
        updated = second.json()
        assert updated["topic"]["id"] == topic_id
        assert updated["topic"]["revision"] == 2
        assert updated["snapshot"]["version"] == 2
        assert updated["snapshot"]["id"] != first["snapshot"]["id"]
        assert snapshot.read_bytes() == original
        assert len(list((tmp_path / "reports").glob("*.md"))) == 1

    with TestClient(create_app()) as client:
        assert client.post("/api/workspaces/open", json={"path": str(tmp_path)}).status_code == 200
        history = client.get(f"/api/reports/{topic_id}/versions")
        assert history.status_code == 200
        assert [item["snapshot"]["version"] for item in history.json()["items"]] == [2, 1]
        assert client.get("/api/reports").json()["items"][0]["snapshot"]["version"] == 2
        assert snapshot.read_bytes() == original


@pytest.mark.parametrize("change", ["external", "stale", "type", "missing_revision"])
def test_invalid_updates_do_not_create_snapshots(tmp_path: Path, change: str) -> None:
    with TestClient(create_app()) as client:
        payload, first = _prepare(client, tmp_path)
        topic = tmp_path / "reports" / f"{first['topic']['id']}.md"
        if change == "external":
            topic.write_bytes(topic.read_bytes() + "\n人工附注：待核对。\n".encode())
        before = topic.read_bytes()
        update = {**payload, "topic_id": first["topic"]["id"], "expected_revision": 1}
        if change == "stale":
            update["expected_revision"] = 2
        elif change == "type":
            update["template_variant"] = "custom"
        elif change == "missing_revision":
            del update["expected_revision"]
        response = client.post("/api/reports", json=update)
        assert response.status_code in {409, 422}, response.text
        assert topic.read_bytes() == before
        assert len(list((tmp_path / "reports" / "snapshots").glob("*.md"))) == 1


def test_failed_topic_commit_archives_new_snapshot_without_mutating_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    with TestClient(create_app()) as client:
        payload, first = _prepare(client, tmp_path)
        topic = tmp_path / "reports" / f"{first['topic']['id']}.md"
        original = topic.read_bytes()
        real_replace = service_module._atomic_replace

        def refuse_report(path: Path, *args, **kwargs) -> None:
            if path == topic:
                raise WorkspaceError("workspace_conflict", "模拟提交时外部修改", status_code=409)
            real_replace(path, *args, **kwargs)

        monkeypatch.setattr(service_module, "_atomic_replace", refuse_report)
        update = {**payload, "topic_id": first["topic"]["id"], "expected_revision": 1}
        assert client.post("/api/reports", json=update).status_code == 409
        assert topic.read_bytes() == original
        assert len(list((tmp_path / "reports" / "snapshots").glob("*.md"))) == 1
        assert len(list((tmp_path / "归档" / "未提交报告").glob("*.md"))) == 1
        monkeypatch.setattr(service_module, "_atomic_replace", real_replace)
        assert client.post("/api/reports", json=update).status_code == 201
        history = client.get(f"/api/reports/{first['topic']['id']}/versions").json()["items"]
        assert [item["snapshot"]["version"] for item in history] == [2, 1]


@pytest.mark.parametrize("change", ["workspace", "selected_source"])
def test_report_generation_rejects_changed_workspace_or_sources(
    tmp_path: Path, change: str,
) -> None:
    app = create_app()
    with TestClient(app) as client:
        payload, first = _prepare(client, tmp_path)
        original = (tmp_path / "reports" / f"{first['topic']['id']}.md").read_bytes()
        source = client.get("/api/sources").json()["items"][0]
        other = tmp_path.parent / (tmp_path.name + "-other")
        other.mkdir()

        class DelayedAdapter:
            def run(self, evidence, **kwargs):
                if change == "workspace":
                    replacement = service_module.WorkspaceService()
                    replacement.open(other)
                    app.state.workspace = replacement
                else:
                    path = tmp_path / source["original_path"]
                    path.write_bytes(path.read_bytes() + "\n外部补充。".encode())
                return build_safe_placeholder(evidence)

        app.state.cli_adapter_factory = lambda *args: DelayedAdapter()
        response = client.post("/api/reports", json={
            **payload, "engine": "codex", "topic_id": first["topic"]["id"],
            "expected_revision": 1,
        })
        assert response.status_code == 409, response.text
        assert (tmp_path / "reports" / f"{first['topic']['id']}.md").read_bytes() == original
        assert len(list((tmp_path / "reports" / "snapshots").glob("*.md"))) == 1
        assert not list((other / "reports").glob("*.md"))


@pytest.mark.parametrize("selected", [True, False])
def test_real_r_generation_external_edits_do_not_commit_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, selected: bool,
) -> None:
    if not plotting_capabilities()["available"]:
        pytest.skip("Local R and ggplot2 are required for this real-render regression")
    with TestClient(create_app()) as client:
        payload, first = _prepare(client, tmp_path)
        person_id = payload["person_ids"][0]
        if selected:
            source = client.get("/api/sources").json()["items"][0]
        else:
            source = client.post("/api/sources/text", json={
                "title": "未选入报告的虚构材料", "text": "另一份材料。", "source_kind": "text",
                "person_ids": [person_id], "event_ids": [],
            }).json()
        topic_path = tmp_path / "reports" / f"{first['topic']['id']}.md"
        before = topic_path.read_bytes()
        original_render = service_module.generate_report_charts

        def render_then_edit(*args, **kwargs):
            result = original_render(*args, **kwargs)
            path = tmp_path / source["original_path"]
            path.write_bytes(path.read_bytes() + "\nR绘制期间人工追加。".encode())
            return result

        monkeypatch.setattr(service_module, "generate_report_charts", render_then_edit)
        response = client.post("/api/reports", json={
            **payload, "include_charts": True,
            "topic_id": first["topic"]["id"], "expected_revision": 1,
        })
        assert response.status_code in {409, 422}, response.text
        assert topic_path.read_bytes() == before
        assert len(list((tmp_path / "reports" / "snapshots").glob("*.md"))) == 1
        assert not list((tmp_path / "attachments" / "reports").iterdir())
        assert list((tmp_path / "归档" / "未提交报告").iterdir())


def test_complete_narrative_and_scoped_review_feedback_keep_old_snapshot(tmp_path):
    app = create_app()
    with TestClient(app) as client:
        payload, first = _prepare(client, tmp_path)
        original_path = tmp_path / 'reports' / 'snapshots' / f"{first['snapshot']['id']}.md"
        original = original_path.read_bytes()
        person_id = payload['person_ids'][0]
        review = {'section':'user_observations', 'label':'AI 候选描述',
                  'value':'喜欢安静的活动。', 'evidence_ids':payload['evidence_ids'],
                  'origin':'ai', 'confirmation_status':'rejected'}
        saved = client.post(f'/api/people/{person_id}/profile-entries', json=review).json()
        replay = client.post(f'/api/people/{person_id}/profile-entries', json=review).json()
        assert replay['revision'] == saved['revision']
        assert len(replay['profile_sections']) == len(saved['profile_sections'])
        captured = []
        class Adapter:
            def run(self, evidence, **kwargs):
                captured.append(kwargs)
                analysis = build_safe_placeholder(evidence)
                analysis['report_markdown'] = '## 整体情况\n\n现有记录较少，只能说明本次表达。\n\n## 相处建议\n\n先询问当天偏好的安排。'
                return analysis
        app.state.cli_adapter_factory = lambda *args: Adapter()
        response = client.post('/api/reports', json={**payload,'engine':'codex',
            'topic_id':first['topic']['id'],'expected_revision':first['topic']['revision']})
        assert response.status_code == 201, response.text
        result = response.json()
        assert '喜欢安静的活动。' in captured[0]['analysis_question']
        assert 'rejected' in captured[0]['analysis_question']
        assert result['analysis']['report_markdown'].startswith('## 整体情况')
        new_path = tmp_path / 'reports' / 'snapshots' / f"{result['snapshot']['id']}.md"
        visible = new_path.read_text().split('<!-- lingxi-structured-analysis')[0]
        assert '只能说明本次表达' in visible and '材料里看到了什么' not in visible
        assert original_path.read_bytes() == original
        other = client.post('/api/sources/text', json={'title':'新记录','text':'周末想休息。','source_kind':'text','person_ids':[person_id],'event_ids':[]}).json()
        evidence = client.post('/api/evidence',json={'source_id':other['id'],'quote':'周末想休息。','locator':{'kind':'text_quote','start':0,'end':len('周末想休息。')},'person_ids':[person_id],'event_ids':[],'evidence_kind':'user_statement','reliability':'medium'}).json()
        response = client.post('/api/reports',json={**payload,'engine':'codex','evidence_ids':[evidence['id']]})
        assert response.status_code == 201, response.text
        assert '喜欢安静的活动。' not in captured[-1]['analysis_question']
