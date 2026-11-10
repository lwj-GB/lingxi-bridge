from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from subprocess import CompletedProcess
from typing import Any
from uuid import UUID, uuid4

import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from lingxi.main import create_app

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "packages" / "schemas"
TEXT = "第一行保留原样。\r\n林夏（虚构）说：最近更喜欢安静一点的周末。\n最后一行。"
QUOTE = "林夏（虚构）说：最近更喜欢安静一点的周末。"


def _validator(name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMAS / name).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _create_material_slice(client: TestClient, vault: Path) -> dict[str, Any]:
    opened = client.post("/api/workspaces/open", json={"path": str(vault)})
    assert opened.status_code == 200

    person_response = client.post(
        "/api/people",
        json={"display_name": "林夏（虚构）", "relation_to_user": "朋友"},
    )
    assert person_response.status_code == 201
    person = person_response.json()

    event_response = client.post(
        "/api/events",
        json={
            "title": "虚构的周末散步约定",
            "occurred_at": "2026-07-27T10:30:00+08:00",
            "person_ids": [person["id"]],
        },
    )
    assert event_response.status_code == 201
    event = event_response.json()

    source_response = client.post(
        "/api/sources/text",
        json={
            "title": "散步聊天摘录（虚构）",
            "text": TEXT,
            "source_kind": "text",
            "person_ids": [person["id"]],
            "event_ids": [event["id"]],
        },
    )
    assert source_response.status_code == 201
    source = source_response.json()

    start = TEXT.index(QUOTE)
    evidence_response = client.post(
        "/api/evidence",
        json={
            "source_id": source["id"],
            "quote": QUOTE,
            "locator": {
                "kind": "text_quote",
                "start": start,
                "end": start + len(QUOTE),
            },
            "evidence_kind": "direct_quote",
            "reliability": "high",
            "person_ids": [person["id"]],
            "event_ids": [event["id"]],
        },
    )
    assert evidence_response.status_code == 201
    return {
        "person": person,
        "event": event,
        "source": source,
        "evidence": evidence_response.json(),
    }


def _create_safe_report(
    client: TestClient,
    records: dict[str, Any],
    *,
    title: str,
) -> dict[str, Any]:
    response = client.post(
        "/api/reports",
        json={
            "title": title,
            "template_family": "special",
            "person_ids": [records["person"]["id"]],
            "evidence_ids": [records["evidence"]["id"]],
        },
    )
    assert response.status_code == 201
    return response.json()


def _open_file_hashes(vault: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(vault.rglob("*")):
        relative = path.relative_to(vault)
        if not path.is_file() or relative.parts[0] == ".lingxi":
            continue
        result[str(relative)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _parse_markdown(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    marker = text.find("\n---\n", 4)
    assert marker >= 0
    frontmatter = yaml.safe_load(text[4:marker])
    assert isinstance(frontmatter, dict)
    body = text[marker + 5 :]
    assert body.strip()
    return frontmatter, body


def test_complete_slice_is_portable_and_rebuilds_without_mutating_open_files(
    tmp_path: Path,
) -> None:
    adapter_calls: list[tuple[str, str]] = []

    def adapter_factory(engine: str, profile_id: str) -> object:
        adapter_calls.append((engine, profile_id))
        raise AssertionError("safe placeholder must not invoke a CLI")

    entity_validator = _validator("entities.schema.json")
    analysis_validator = _validator("analysis-output.schema.json")
    vault = tmp_path / "虚构验收工作区"
    vault.mkdir()

    with TestClient(create_app(cli_adapter_factory=adapter_factory)) as client:
        records = _create_material_slice(client, vault)
        first_report = _create_safe_report(client, records, title="近期沟通准备（虚构）")

        for record in [
            records["person"],
            records["event"],
            records["source"],
            records["evidence"],
            first_report["topic"],
            first_report["snapshot"],
        ]:
            entity_validator.validate(record)
            assert str(UUID(record["id"])) == record["id"]
        analysis_validator.validate(first_report["analysis"])

        evidence_backlink = client.get(
            f"/api/records/{records['evidence']['id']}"
        )
        assert evidence_backlink.status_code == 200
        assert evidence_backlink.json()["record"]["source_id"] == records["source"]["id"]
        source_backlink = client.get(f"/api/records/{records['source']['id']}")
        assert source_backlink.status_code == 200
        assert source_backlink.json()["body"] == TEXT
        assert source_backlink.json()["relative_path"] == records["source"]["original_path"]

        source_path = vault / records["source"]["original_path"]
        assert source_path.read_bytes() == TEXT.encode("utf-8")
        source_metadata = vault / "sources" / f"{records['source']['id']}.json"
        assert json.loads(source_metadata.read_text(encoding="utf-8")) == records["source"]

        markdown_records: list[dict[str, Any]] = []
        for markdown_path in sorted(vault.rglob("*.md")):
            frontmatter, _body = _parse_markdown(markdown_path)
            entity_validator.validate(frontmatter)
            markdown_records.append(frontmatter)
        assert {item["entity_type"] for item in markdown_records} == {
            "person",
            "event",
            "evidence",
            "report_topic",
            "report_snapshot",
        }

        first_snapshot_path = (
            vault / "reports" / "snapshots" / f"{first_report['snapshot']['id']}.md"
        )
        first_snapshot_bytes = first_snapshot_path.read_bytes()
        second_report = _create_safe_report(
            client,
            records,
            title="第二次沟通准备（虚构）",
        )
        assert second_report["snapshot"]["id"] != first_report["snapshot"]["id"]
        assert first_snapshot_path.read_bytes() == first_snapshot_bytes
        assert first_report["snapshot"]["revision"] == 1

        expected_ids = {
            "people": {records["person"]["id"]},
            "events": {records["event"]["id"]},
            "sources": {records["source"]["id"]},
            "evidence": {records["evidence"]["id"]},
            "reports": {
                first_report["topic"]["id"],
                second_report["topic"]["id"],
            },
        }
        open_hashes_before = _open_file_hashes(vault)
        index_path = vault / ".lingxi" / "index.sqlite3"
        assert index_path.is_file()
        index_path.unlink()

        rebuild = client.post("/api/workspaces/rebuild-index")
        assert rebuild.status_code == 200
        assert rebuild.json()["record_count"] == 8
        assert index_path.is_file()
        assert _open_file_hashes(vault) == open_hashes_before
        assert first_snapshot_path.read_bytes() == first_snapshot_bytes

        for endpoint, expected in expected_ids.items():
            response = client.get(f"/api/{endpoint}")
            assert response.status_code == 200
            if endpoint == "reports":
                actual = {item["topic"]["id"] for item in response.json()["items"]}
            else:
                actual = {item["id"] for item in response.json()["items"]}
            assert actual == expected

    assert adapter_calls == []


def test_non_exact_evidence_locator_is_rejected_without_creating_evidence(
    tmp_path: Path,
) -> None:
    vault = tmp_path / "虚构定位验收"
    vault.mkdir()
    with TestClient(create_app()) as client:
        records = _create_material_slice(client, vault)
        before = _open_file_hashes(vault)
        start = TEXT.index(QUOTE)
        mismatch = client.post(
            "/api/evidence",
            json={
                "source_id": records["source"]["id"],
                "quote": f"{QUOTE}并未出现在原文",
                "locator": {
                    "kind": "text_quote",
                    "start": start,
                    "end": start + len(QUOTE),
                },
                "evidence_kind": "direct_quote",
                "reliability": "high",
                "person_ids": [records["person"]["id"]],
                "event_ids": [records["event"]["id"]],
            },
        )

        assert mismatch.status_code == 422
        assert mismatch.json()["error"]["code"] == "evidence_locator_mismatch"
        evidence = client.get("/api/evidence")
        assert evidence.status_code == 200
        assert [item["id"] for item in evidence.json()["items"]] == [
            records["evidence"]["id"]
        ]
        assert _open_file_hashes(vault) == before


def test_missing_selected_cli_degrades_explicitly_without_leaking_secrets(
    tmp_path: Path,
    monkeypatch,
) -> None:
    canary = f"sk-acceptance-{uuid4().hex}"
    monkeypatch.setenv("LINGXI_ACCEPTANCE_SECRET", canary)
    monkeypatch.setattr("lingxi.main.resolve_executable", lambda _engine: None)
    vault = tmp_path / "虚构降级验收"
    vault.mkdir()

    with TestClient(create_app()) as client:
        records = _create_material_slice(client, vault)
        response = client.post(
            "/api/reports",
            json={
                "title": "无 CLI 时的虚构降级报告",
                "template_family": "special",
                "person_ids": [records["person"]["id"]],
                "evidence_ids": [records["evidence"]["id"]],
                "engine": "codex",
            },
        )

    assert response.status_code == 201
    report = response.json()
    assert report["snapshot"]["generation_kind"] == "safe_placeholder"
    assert report["execution"] == {
        "engine": "codex",
        "profile_id": "inherited",
        "material_scope": [records["source"]["id"]],
        "data_destination": "local_only",
        "degraded": True,
        "degraded_reason": "execution_failed",
    }
    assert {claim["claim_type"] for claim in report["analysis"]["claims"]} == {
        "observation",
        "hypothesis",
        "unknown",
        "suggestion",
    }
    assert canary not in response.text
    assert all(
        canary.encode() not in path.read_bytes()
        for path in vault.rglob("*")
        if path.is_file()
    )


def test_executor_discovery_uses_an_isolated_probe_and_never_infers_vendor(
    tmp_path: Path,
    monkeypatch,
) -> None:
    global_home = tmp_path / "真实用户配置不可触碰"
    claude_config = global_home / ".claude" / "settings.json"
    codex_config = global_home / ".codex" / "config.toml"
    claude_config.parent.mkdir(parents=True)
    codex_config.parent.mkdir(parents=True)
    claude_config.write_text('{"marker":"do-not-read-or-modify"}\n', encoding="utf-8")
    codex_config.write_text('marker = "do-not-read-or-modify"\n', encoding="utf-8")
    before = {
        claude_config: claude_config.read_bytes(),
        codex_config: codex_config.read_bytes(),
    }
    secret_env = f"acceptance-secret-{uuid4().hex}"
    monkeypatch.setenv("HOME", str(global_home))
    monkeypatch.setenv("LINGXI_ACCEPTANCE_SECRET", secret_env)
    monkeypatch.setattr(
        "lingxi.analysis.executors.shutil.which",
        lambda engine, **_kwargs: "/opt/fake/claude" if engine == "claude" else None,
    )
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object) -> CompletedProcess[str]:
        calls.append((command, kwargs))
        return CompletedProcess(
            command,
            0,
            stdout="Opaque CLI build from an unrelated model vendor\n",
            stderr="",
        )

    monkeypatch.setattr("lingxi.analysis.executors.subprocess.run", fake_run)

    with TestClient(create_app()) as client:
        response = client.get("/api/executors")

    assert response.status_code == 200
    items = response.json()["items"]
    assert items[0] == {
        "engine": "claude",
        "name": "Claude Code CLI",
        "available": True,
        "path": "/opt/fake/claude",
        "version": "Opaque CLI build from an unrelated model vendor",
        "degraded_reason": None,
    }
    assert items[1]["engine"] == "codex"
    assert items[1]["available"] is False
    assert all(set(item) == {
        "engine",
        "name",
        "available",
        "path",
        "version",
        "degraded_reason",
    } for item in items)
    assert calls[0][0] == ["/opt/fake/claude", "--version"]
    probe_environment = calls[0][1].get("env")
    assert isinstance(probe_environment, dict)
    assert Path(str(probe_environment["HOME"])).resolve() != global_home.resolve()
    assert probe_environment.get("LINGXI_ACCEPTANCE_SECRET") is None
    assert {path: path.read_bytes() for path in before} == before


def test_active_repo_and_generated_workspace_contain_no_plaintext_credentials_or_local_paths(
    tmp_path: Path,
) -> None:
    ignored_directories = {
        ".git",
        ".build",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "dist",
        "node_modules",
        "target",
        "归档",
    }
    text_suffixes = {
        "",
        ".css",
        ".html",
        ".json",
        ".md",
        ".py",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".yaml",
        ".yml",
    }
    credential_patterns = [
        re.compile(rb"sk-[A-Za-z0-9_-]{32,}"),
        re.compile(rb"AKIA[0-9A-Z]{16}"),
        re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    ]
    local_path_patterns = [
        re.compile(rb"/" + rb"Users/[A-Za-z0-9._-]+/"),
        re.compile(rb"[A-Za-z]:\\" + rb"Users\\[A-Za-z0-9._-]+\\"),
    ]
    violations: list[str] = []
    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if any(part in ignored_directories for part in relative.parts):
            continue
        if not path.is_file() or path.suffix.lower() not in text_suffixes:
            continue
        raw = path.read_bytes()
        if any(
            pattern.search(raw)
            for pattern in [*credential_patterns, *local_path_patterns]
        ):
            violations.append(str(relative))

    demo_readme = (ROOT / "examples" / "vault-v0.1" / "README.md").read_text(
        encoding="utf-8"
    )
    assert "完整虚构示例，不含真实人物、真实聊天记录" in demo_readme
    assert violations == []

    vault = tmp_path / "generated-fictional-vault"
    vault.mkdir()
    with TestClient(create_app()) as client:
        _create_material_slice(client, vault)
    assert all(
        not any(
            pattern.search(path.read_bytes())
            for pattern in [*credential_patterns, *local_path_patterns]
        )
        for path in vault.rglob("*")
        if path.is_file()
    )
