import io
import zipfile
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from lingxi.analysis.cli import CliExecutionError
from lingxi.main import create_app


def _create_material_slice(client: TestClient, vault: Path) -> dict[str, Any]:
    opened = client.post("/api/workspaces/open", json={"path": str(vault)})
    assert opened.status_code == 200

    person = client.post(
        "/api/people",
        json={"display_name": "林夏（虚构）", "relation_to_user": "朋友"},
    ).json()
    event = client.post(
        "/api/events",
        json={
            "title": "约定周末散步",
            "occurred_at": "2026-07-27T10:30:00+08:00",
            "person_ids": [person["id"]],
        },
    ).json()
    text = "第一行保留原样。\r\n林夏说：最近更喜欢安静一点的周末。\n最后一行。"
    source = client.post(
        "/api/sources/text",
        json={
            "title": "散步聊天摘录",
            "text": text,
            "source_kind": "text",
            "person_ids": [person["id"]],
            "event_ids": [event["id"]],
        },
    ).json()
    quote = "林夏说：最近更喜欢安静一点的周末。"
    start = text.index(quote)
    evidence = client.post(
        "/api/evidence",
        json={
            "source_id": source["id"],
            "quote": quote,
            "locator": {
                "kind": "text_quote",
                "start": start,
                "end": start + len(quote),
            },
            "evidence_kind": "direct_quote",
            "reliability": "high",
            "person_ids": [person["id"]],
            "event_ids": [event["id"]],
        },
    ).json()
    return {
        "person": person,
        "event": event,
        "source": source,
        "evidence": evidence,
        "text": text,
    }


def test_http_vertical_slice_uses_safe_analysis_and_source_backlinks(
    tmp_path: Path,
) -> None:
    adapter_calls: list[tuple[str, str]] = []

    def adapter_factory(engine: str, profile_id: str) -> object:
        adapter_calls.append((engine, profile_id))
        raise AssertionError("safe_placeholder must not start a CLI")

    with TestClient(create_app(cli_adapter_factory=adapter_factory)) as client:
        records = _create_material_slice(client, tmp_path)
        report_response = client.post(
            "/api/reports",
            json={
                "title": "近期沟通准备",
                "template_family": "special",
                "person_ids": [records["person"]["id"]],
                "evidence_ids": [records["evidence"]["id"]],
            },
        )
        source_response = client.get(f"/api/records/{records['source']['id']}")
        reports_response = client.get("/api/reports")
        refresh_response = client.post("/api/workspaces/refresh")
        rebuild_response = client.post("/api/workspaces/rebuild-index")

    assert report_response.status_code == 201
    report = report_response.json()
    assert report["analysis"]["material_scope"] == [records["source"]["id"]]
    assert {
        claim["claim_type"] for claim in report["analysis"]["claims"]
    } == {"observation", "hypothesis", "unknown", "suggestion"}
    assert all(
        claim["evidence_ids"] == [records["evidence"]["id"]]
        for claim in report["analysis"]["claims"]
    )
    assert report["snapshot"]["generation_kind"] == "safe_placeholder"
    assert report["execution"] == {
        "engine": "safe_placeholder",
        "profile_id": "safe_placeholder",
        "material_scope": [records["source"]["id"]],
        "data_destination": "local_only",
        "degraded": False,
        "degraded_reason": None,
    }
    assert adapter_calls == []
    assert source_response.status_code == 200
    assert source_response.json()["body"] == records["text"]
    assert source_response.json()["relative_path"] == records["source"]["original_path"]
    assert reports_response.json()["items"] == [
        {
            "topic": report["topic"],
            "snapshot": report["snapshot"],
            "analysis": report["analysis"],
        }
    ]
    assert refresh_response.status_code == 200
    assert rebuild_response.status_code == 200


def test_http_workspace_export_downloads_portable_zip(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        records = _create_material_slice(client, tmp_path)
        response = client.get("/api/workspaces/export")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "attachment;" in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert records["source"]["original_path"] in names
        assert ".lingxi/index.sqlite3" not in names
        assert any(name.startswith("LINGXI_EXPORT_MANIFEST") for name in names)


def test_http_records_rejected_ai_review_without_promoting_it_to_person_fact(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        records = _create_material_slice(client, tmp_path)
        response = client.post(
            f"/api/people/{records['person']['id']}/profile-entries",
            json={
                "section": "user_observations",
                "label": "AI 候选描述",
                "value": "这个人总是非常乐观。",
                "origin": "ai",
                "confirmation_status": "rejected",
                "evidence_ids": [records["evidence"]["id"]],
            },
        )
        person_record = client.get(
            f"/api/records/{records['person']['id']}"
        )

    assert response.status_code == 201
    assert response.json()["profile_sections"][0] == {
        "id": response.json()["profile_sections"][0]["id"],
        "section": "user_observations",
        "label": "AI 候选描述",
        "value": "这个人总是非常乐观。",
        "origin": "ai",
        "confirmation_status": "rejected",
        "evidence_ids": [records["evidence"]["id"]],
    }
    body = person_record.json()["body"]
    assert "## 用户观察\n\n- 暂无" in body
    assert "## AI 候选复核记录" in body
    assert "- **已退回**：这个人总是非常乐观。" in body


def test_report_uses_only_explicit_evidence_with_selected_cli(
    tmp_path: Path,
) -> None:
    seen: dict[str, Any] = {}

    class StubAdapter:
        def run(
            self,
            evidence: list[dict[str, Any]],
            *,
            analysis_question: str,
            template_family: str,
            template_variant: str,
            relation_labels: list[str],
        ) -> dict[str, Any]:
            seen["evidence"] = evidence
            seen["analysis_question"] = analysis_question
            seen["template_family"] = template_family
            seen["template_variant"] = template_variant
            seen["relation_labels"] = relation_labels
            return {
                "schema_version": "0.1",
                "material_scope": [evidence[0]["source_id"]],
                "claims": [
                    {
                        "claim_type": "observation",
                        "text": "只读取了请求选中的虚构证据。",
                        "evidence_ids": [evidence[0]["id"]],
                    }
                ],
            }

    def adapter_factory(engine: str, profile_id: str) -> StubAdapter:
        seen["engine"] = engine
        seen["profile_id"] = profile_id
        return StubAdapter()

    with TestClient(create_app(cli_adapter_factory=adapter_factory)) as client:
        records = _create_material_slice(client, tmp_path)
        response = client.post(
            "/api/reports",
            json={
                "title": "CLI 分析",
                "template_family": "special",
                "template_variant": "communication_prep",
                "analysis_question": "下次沟通前，哪些事实需要先核对？",
                "person_ids": [records["person"]["id"]],
                "evidence_ids": [records["evidence"]["id"]],
                "engine": "codex",
                "profile_id": "isolated-test",
            },
        )

    assert response.status_code == 201
    result = response.json()
    assert seen["engine"] == "codex"
    assert seen["profile_id"] == "isolated-test"
    assert [item["id"] for item in seen["evidence"]] == [records["evidence"]["id"]]
    assert seen["analysis_question"] == "下次沟通前，哪些事实需要先核对？"
    assert seen["template_family"] == "special"
    assert seen["template_variant"] == "communication_prep"
    assert seen["relation_labels"] == ["朋友"]
    assert result["topic"]["analysis_question"] == "下次沟通前，哪些事实需要先核对？"
    assert result["snapshot"]["generation_kind"] == "codex"
    assert result["execution"]["engine"] == "codex"
    assert result["execution"]["profile_id"] == "isolated-test"
    assert result["execution"]["degraded"] is False
    assert result["execution"]["data_destination"] == "selected_cli_process"


def test_selected_cli_failure_degrades_without_leaking_details(tmp_path: Path) -> None:
    def adapter_factory(_engine: str, _profile_id: str) -> object:
        raise CliExecutionError("private command output: secret-value")

    with TestClient(create_app(cli_adapter_factory=adapter_factory)) as client:
        records = _create_material_slice(client, tmp_path)
        response = client.post(
            "/api/reports",
            json={
                "title": "降级报告",
                "template_family": "special",
                "person_ids": [records["person"]["id"]],
                "evidence_ids": [records["evidence"]["id"]],
                "engine": "claude",
            },
        )

    assert response.status_code == 201
    result = response.json()
    assert result["snapshot"]["generation_kind"] == "safe_placeholder"
    assert result["execution"]["engine"] == "claude"
    assert result["execution"]["degraded"] is True
    assert result["execution"]["degraded_reason"] == "execution_failed"
    assert "secret-value" not in response.text
