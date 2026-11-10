from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import uuid
import zipfile
from pathlib import Path

import pytest
import yaml
from lingxi.workspace import WorkspaceError, WorkspaceService


def _analysis(source_id: str, evidence_id: str) -> dict:
    return {
        "schema_version": "0.1",
        "material_scope": [source_id],
        "claims": [
            {
                "claim_type": "observation",
                "text": "材料中直接表达了对安静活动的偏好。",
                "evidence_ids": [evidence_id],
            },
            {
                "claim_type": "hypothesis",
                "text": "近期可能更适合低压力的活动选项。",
                "evidence_ids": [evidence_id],
                "uncertainty": "medium",
                "alternatives": ["这句话也可能只描述当天的状态。"],
            },
            {
                "claim_type": "unknown",
                "text": "尚不知道这种偏好是否长期稳定。",
                "evidence_ids": [evidence_id],
            },
            {
                "claim_type": "suggestion",
                "text": "先询问本周更想散步还是在家休息。",
                "evidence_ids": [evidence_id],
            },
        ],
    }


def _create_slice(vault: Path) -> tuple[WorkspaceService, dict[str, dict], str]:
    service = WorkspaceService()
    service.open(vault)
    person = service.create_person("林夏（虚构）", "朋友")
    event = service.create_event(
        "约定周末散步",
        "2026-07-26T10:30:00+08:00",
        [person["id"]],
    )
    text = "第一行保留原样。\r\n林夏说：最近更喜欢安静一点的周末。\n最后一行没有额外换行。"
    source = service.import_text_source(
        "散步聊天摘录",
        text,
        "text",
        [person["id"]],
        [event["id"]],
    )
    quote = "林夏说：最近更喜欢安静一点的周末。"
    start = text.index(quote)
    evidence = service.create_evidence(
        source["id"],
        quote,
        {"kind": "text_quote", "start": start, "end": start + len(quote)},
        "direct_quote",
        "high",
        [person["id"]],
        [event["id"]],
    )
    report = service.create_report(
        "近期沟通准备",
        "special",
        "communication_prep",
        [person["id"]],
        [evidence["id"]],
        _analysis(source["id"], evidence["id"]),
    )
    return service, {
        "person": person,
        "event": event,
        "source": source,
        "evidence": evidence,
        "topic": report["topic"],
        "snapshot": report["snapshot"],
    }, text


def _frontmatter(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    _, raw_frontmatter, body = text.split("---\n", 2)
    return yaml.safe_load(raw_frontmatter), body


def test_vertical_slice_preserves_source_and_is_obsidian_readable(tmp_path: Path) -> None:
    service, records, original_text = _create_slice(tmp_path)

    for record in records.values():
        uuid.UUID(record["id"])

    source_path = tmp_path / records["source"]["original_path"]
    assert source_path.read_bytes() == original_text.encode("utf-8")
    assert records["source"]["sha256"] == hashlib.sha256(original_text.encode()).hexdigest()

    event = service.get_record(records["event"]["id"])
    assert records["source"]["id"] in event["record"]["source_ids"]
    assert event["body"].startswith("# 约定周末散步")
    assert event["file_hash"] == hashlib.sha256(
        (tmp_path / event["relative_path"]).read_bytes()
    ).hexdigest()

    source = service.get_record(records["source"]["id"])
    assert source["relative_path"] == records["source"]["original_path"]
    assert source["body"] == original_text

    for relative_path in (
        f"people/{records['person']['id']}.md",
        f"events/{records['event']['id']}.md",
        f"evidence/{records['evidence']['id']}.md",
        f"reports/{records['topic']['id']}.md",
        f"reports/snapshots/{records['snapshot']['id']}.md",
    ):
        frontmatter, body = _frontmatter(tmp_path / relative_path)
        assert frontmatter["id"] in {record["id"] for record in records.values()}
        assert body.strip()

    reports = service.list_entities("report")
    assert reports == [
        {
            "topic": records["topic"],
            "snapshot": records["snapshot"],
            "analysis": _analysis(records["source"]["id"], records["evidence"]["id"]),
        }
    ]


def test_evidence_locator_must_match_original_text_exactly(tmp_path: Path) -> None:
    service = WorkspaceService()
    service.open(tmp_path)
    person = service.create_person("林夏（虚构）", "朋友")
    source = service.import_text_source(
        "原始观察",
        "喜欢散步",
        "user_observation",
        [person["id"]],
        [],
    )

    with pytest.raises(WorkspaceError) as caught:
        service.create_evidence(
            source["id"],
            "喜欢跑步",
            {"kind": "text_quote", "start": 0, "end": 4},
            "user_observation",
            "medium",
            [person["id"]],
            [],
        )

    assert caught.value.code == "evidence_locator_mismatch"
    assert service.list_entities("evidence") == []


def test_deleted_sqlite_is_fully_rebuilt_from_open_files(tmp_path: Path) -> None:
    service, records, original_text = _create_slice(tmp_path)
    index_path = tmp_path / ".lingxi" / "index.sqlite3"
    snapshot_path = tmp_path / "reports" / "snapshots" / f"{records['snapshot']['id']}.md"
    snapshot_before = snapshot_path.read_bytes()

    index_path.unlink()
    result = service.rebuild_index()

    assert result["record_count"] == 6
    assert result["counts"] == {
        "event": 1,
        "evidence": 1,
        "person": 1,
        "report_snapshot": 1,
        "report_topic": 1,
        "source": 1,
    }
    assert service.get_record(records["source"]["id"])["body"] == original_text
    assert snapshot_path.read_bytes() == snapshot_before

    with sqlite3.connect(index_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            )
        }
        assert "records_fts" in tables
        matched = connection.execute(
            "SELECT id FROM records_fts WHERE records_fts MATCH ?",
            ('"安静一点"',),
        ).fetchall()
    assert (records["source"]["id"],) in matched


def test_refresh_indexes_external_edit_without_rewriting_file(tmp_path: Path) -> None:
    service, records, _ = _create_slice(tmp_path)
    person_path = tmp_path / "people" / f"{records['person']['id']}.md"
    externally_edited = person_path.read_text(encoding="utf-8") + "\n外部补充：喜欢晨间散步。\n"
    person_path.write_text(externally_edited, encoding="utf-8", newline="")
    bytes_before_refresh = person_path.read_bytes()

    result = service.refresh()

    assert result["modified"] == 1
    assert person_path.read_bytes() == bytes_before_refresh
    assert "喜欢晨间散步" in service.get_record(records["person"]["id"])["body"]


def test_refresh_rejects_invalid_open_file_without_overwriting_it(tmp_path: Path) -> None:
    service, records, _ = _create_slice(tmp_path)
    person_path = tmp_path / "people" / f"{records['person']['id']}.md"
    invalid = person_path.read_text(encoding="utf-8").replace(
        "display_name: 林夏（虚构）",
        "display_name: ''",
    )
    person_path.write_text(invalid, encoding="utf-8", newline="")
    bytes_before_refresh = person_path.read_bytes()

    with pytest.raises(WorkspaceError) as caught:
        service.refresh()

    assert caught.value.code == "validation_error"
    assert person_path.read_bytes() == bytes_before_refresh


def test_report_rejects_unselected_evidence_and_snapshot_is_exclusive(tmp_path: Path) -> None:
    service, records, _ = _create_slice(tmp_path)
    invalid_analysis = _analysis(records["source"]["id"], records["evidence"]["id"])
    invalid_analysis["claims"][0]["evidence_ids"] = [str(uuid.uuid4())]

    with pytest.raises(WorkspaceError) as caught:
        service.create_report(
            "不应生成的报告",
            "special",
            "communication_prep",
            [records["person"]["id"]],
            [records["evidence"]["id"]],
            invalid_analysis,
        )

    assert caught.value.code == "validation_error"
    assert len(service.list_entities("report")) == 1


def test_open_requires_absolute_existing_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    service = WorkspaceService()

    with pytest.raises(WorkspaceError) as caught:
        service.open("relative-vault")

    assert caught.value.code == "invalid_workspace"
    assert not (tmp_path / "relative-vault").exists()


def test_workspace_json_is_stable_across_reopen(tmp_path: Path) -> None:
    first = WorkspaceService().open(tmp_path)
    manifest_before = (tmp_path / "workspace.json").read_bytes()
    second = WorkspaceService().open(tmp_path)

    assert second["workspace_id"] == first["workspace_id"]
    assert (tmp_path / "workspace.json").read_bytes() == manifest_before
    assert json.loads(manifest_before)["schema_version"] == "0.1"


def test_fictitious_demo_vault_opens_without_committed_index(tmp_path: Path) -> None:
    repository_root = Path(__file__).resolve().parents[4]
    demo_vault = repository_root / "examples" / "vault-v0.1"
    copied_vault = tmp_path / "vault-v0.1"
    shutil.copytree(demo_vault, copied_vault)

    service = WorkspaceService()
    opened = service.open(copied_vault)

    assert opened["counts"] == {
        "event": 1,
        "evidence": 1,
        "person": 1,
        "report_snapshot": 1,
        "report_topic": 1,
        "source": 2,
    }
    evidence = service.list_entities("evidence")[0]
    assert evidence["quote"] == "最近更喜欢安静一点的周末"
    assert not (demo_vault / ".lingxi" / "index.sqlite3").exists()


def test_person_profile_entry_is_confirmed_and_rendered_in_nine_sections(
    tmp_path: Path,
) -> None:
    service = WorkspaceService()
    service.open(tmp_path)
    person = service.create_person("林夏（虚构）", "朋友")

    assert person["profile_sections"] == []
    initial_body = service.get_record(person["id"])["body"]
    for heading in (
        "基础信息",
        "外貌与穿搭",
        "饮食与生活偏好",
        "习惯",
        "重要经历",
        "作品与表达",
        "社交内容",
        "互动",
        "用户观察",
    ):
        assert f"## {heading}" in initial_body

    updated = service.add_profile_entry(
        person["id"],
        "preferences",
        "周末偏好",
        "更喜欢安静一点的活动。",
        [],
    )

    assert updated["revision"] == 2
    assert updated["profile_sections"] == [
        {
            "id": updated["profile_sections"][0]["id"],
            "section": "preferences",
            "label": "周末偏好",
            "value": "更喜欢安静一点的活动。",
            "origin": "user",
            "confirmation_status": "confirmed",
            "evidence_ids": [],
        }
    ]
    body = service.get_record(person["id"])["body"]
    assert "- **周末偏好**：更喜欢安静一点的活动。" in body


def test_rejected_ai_profile_entry_is_recorded_without_becoming_person_fact(
    tmp_path: Path,
) -> None:
    service = WorkspaceService()
    service.open(tmp_path)
    person = service.create_person("林夏（虚构）", "朋友")

    updated = service.add_profile_entry(
        person["id"],
        "user_observations",
        "AI 候选描述",
        "这个人总是非常乐观。",
        [],
        origin="ai",
        confirmation_status="rejected",
    )

    assert updated["profile_sections"] == [
        {
            "id": updated["profile_sections"][0]["id"],
            "section": "user_observations",
            "label": "AI 候选描述",
            "value": "这个人总是非常乐观。",
            "origin": "ai",
            "confirmation_status": "rejected",
            "evidence_ids": [],
        }
    ]
    body = service.get_record(person["id"])["body"]
    assert "## 用户观察\n\n- 暂无" in body
    assert "## AI 候选复核记录" in body
    assert "- **已退回**：这个人总是非常乐观。" in body


def test_screenshot_batch_confirmation_original_and_rebuild(
    tmp_path: Path,
) -> None:
    service = WorkspaceService()
    service.open(tmp_path)
    person = service.create_person("林夏（虚构）", "朋友")
    event = service.create_event(
        "虚构聊天截图",
        "2026-07-27T10:30:00+08:00",
        [person["id"]],
    )
    png = b"\x89PNG\r\n\x1a\nfictional-screenshot-bytes"
    jpeg = b"\xff\xd8\xff\xe0fictional-screenshot-bytes"

    imported = service.import_screenshot_batch(
        "周末聊天（虚构）",
        [
            {"filename": "../../unsafe.png", "mime_type": "image/png", "content": png},
            {"filename": "second.jpg", "mime_type": "image/jpeg", "content": jpeg},
        ],
        [person["id"]],
        [event["id"]],
    )

    assert [item["sequence_index"] for item in imported["items"]] == [0, 1]
    assert {
        item["batch_id"] for item in imported["items"]
    } == {imported["batch_id"]}
    first = imported["items"][0]
    original_path = tmp_path / first["original_path"]
    assert original_path.name == "original.png"
    assert original_path.read_bytes() == png
    assert first["sha256"] == hashlib.sha256(png).hexdigest()
    assert service.get_record(first["id"])["body"] == ""
    assert service.get_source_original(first["id"]) == {
        "path": str(original_path.resolve()),
        "mime_type": "image/png",
        "filename": "original.png",
        "source_kind": "screenshot",
        "source_id": first["id"],
    }
    assert set(service.get_record(event["id"])["record"]["source_ids"]) == {
        item["id"] for item in imported["items"]
    }

    confirmed = service.confirm_screenshot_transcript(
        first["id"],
        [
            {
                "order": 1,
                "speaker": "other",
                "text": "最近更喜欢安静一点的周末。",
                "uncertainty": "low",
            },
            {
                "order": 0,
                "speaker": "me",
                "text": "这周末想做什么？",
                "uncertainty": "medium",
            },
        ],
    )

    assert confirmed["source"]["processing_status"] == "confirmed"
    transcript = confirmed["transcript"]
    assert [segment["order"] for segment in transcript["segments"]] == [0, 1]
    assert len(confirmed["evidence"]) == 2
    transcript_path = tmp_path / "transcripts" / f"{transcript['id']}.md"
    transcript_before = transcript_path.read_bytes()
    assert first["original_path"] in transcript_before.decode("utf-8")
    confirmed_source = service.get_record(first["id"])
    assert "最近更喜欢安静一点的周末。" in confirmed_source["body"]
    assert confirmed_source["record"]["transcript_id"] == transcript["id"]

    index_path = tmp_path / ".lingxi" / "index.sqlite3"
    index_path.unlink()
    rebuilt = service.rebuild_index()
    assert rebuilt["counts"]["screenshot_transcript"] == 1
    assert service.get_record(first["id"])["body"] == confirmed_source["body"]
    assert original_path.read_bytes() == png
    assert transcript_path.read_bytes() == transcript_before

    open_files_before = {
        str(path.relative_to(tmp_path)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in tmp_path.rglob("*")
        if path.is_file() and ".lingxi" not in path.parts
    }
    with pytest.raises(WorkspaceError) as caught:
        service.confirm_screenshot_transcript(
            first["id"],
            [
                {
                    "order": 0,
                    "speaker": "unknown",
                    "text": "不能覆盖。",
                    "uncertainty": "high",
                }
            ],
        )
    assert caught.value.code == "screenshot_already_confirmed"
    assert {
        str(path.relative_to(tmp_path)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in tmp_path.rglob("*")
        if path.is_file() and ".lingxi" not in path.parts
    } == open_files_before


def test_invalid_screenshot_batch_has_no_partial_open_files(tmp_path: Path) -> None:
    service = WorkspaceService()
    service.open(tmp_path)
    person = service.create_person("林夏（虚构）", "朋友")
    sources_before = list((tmp_path / "sources").iterdir())
    attachments_before = list((tmp_path / "attachments").iterdir())

    with pytest.raises(WorkspaceError) as caught:
        service.import_screenshot_batch(
            "类型不匹配",
            [
                {
                    "filename": "fake.png",
                    "mime_type": "image/png",
                    "content": b"not-a-png",
                }
            ],
            [person["id"]],
            [],
        )

    assert caught.value.code == "screenshot_content_mismatch"
    assert list((tmp_path / "sources").iterdir()) == sources_before
    assert list((tmp_path / "attachments").iterdir()) == attachments_before


def test_workspace_export_contains_open_files_hashes_and_no_index(
    tmp_path: Path,
) -> None:
    service, records, original_text = _create_slice(tmp_path)
    linked_path = tmp_path / "linked-copy.txt"
    linked_path.symlink_to(tmp_path / records["source"]["original_path"])

    result = service.create_export_archive()
    archive_path = Path(result["path"])
    try:
        with zipfile.ZipFile(archive_path) as archive:
            names = archive.namelist()
            assert records["source"]["original_path"] in names
            assert ".lingxi/index.sqlite3" not in names
            assert "linked-copy.txt" not in names
            manifest_name = next(
                name for name in names if name.startswith("LINGXI_EXPORT_MANIFEST")
            )
            manifest = json.loads(archive.read(manifest_name))
            source_entry = next(
                item
                for item in manifest["files"]
                if item["path"] == records["source"]["original_path"]
            )
            assert archive.read(records["source"]["original_path"]) == original_text.encode()
            assert source_entry["sha256"] == hashlib.sha256(
                original_text.encode()
            ).hexdigest()
            assert manifest["file_count"] == result["file_count"]
            assert manifest["excluded"] == [
                ".lingxi/",
                ".DS_Store",
                "symbolic_links",
            ]
    finally:
        archive_path.unlink(missing_ok=True)


def test_schema_validator_prefers_configured_sidecar_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema_dir = tmp_path / "sidecar-schemas"
    schema_dir.mkdir()
    (schema_dir / "entities.schema.json").write_text(
        json.dumps(
            {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "required": ["sidecar_marker"],
            }
        ),
        encoding="utf-8",
    )
    (schema_dir / "analysis-output.schema.json").write_text(
        json.dumps(
            {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LINGXI_SCHEMA_DIR", str(schema_dir))
    vault = tmp_path / "vault"
    vault.mkdir()
    service = WorkspaceService()
    service.open(vault)

    with pytest.raises(WorkspaceError) as caught:
        service.create_person("林夏（虚构）", "朋友")

    assert caught.value.code == "validation_error"
    assert caught.value.details["reason"] == "'sidecar_marker' is a required property"
