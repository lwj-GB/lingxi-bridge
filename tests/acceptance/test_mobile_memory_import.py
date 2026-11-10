from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from lingxi.workspace.service import WorkspaceService

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "import_mobile_memory.py"


def _payload() -> dict:
    return {
        "type": "daily_memory",
        "version": 1,
        "app": "resound",
        "date": "2026-11-08",
        "generatedAt": 1794103200000,
        "markdown": "# 虚构会谈\n林澄可能喜欢茶具，仍需确认。",
        "data": {
            "review": None,
            "events": [],
            "items": [],
            "cards": [],
            "lines": [
                {
                    "id": 7,
                    "at": 1794103000000,
                    "speaker": "林澄（虚构）",
                    "text": "我最近每天都喝茶。",
                }
            ],
        },
    }


def _workspace(tmp_path: Path) -> tuple[Path, WorkspaceService, str]:
    vault = tmp_path / "vault"
    vault.mkdir()
    service = WorkspaceService()
    service.open(vault)
    person = service.create_person("林澄（虚构）", "朋友")
    return vault, service, person["id"]


def _run(path: Path, vault: Path, person_id: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--input",
            str(path),
            "--vault",
            str(vault),
            "--person-id",
            person_id,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def _public_hashes(vault: Path) -> dict[str, str]:
    return {
        str(p.relative_to(vault)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in vault.rglob("*")
        if p.is_file() and ".lingxi" not in p.relative_to(vault).parts
    }


def test_mobile_import_preserves_original_and_is_idempotent_for_contact(tmp_path: Path) -> None:
    vault, service, person_id = _workspace(tmp_path)
    source_file = tmp_path / "手机导出.json"
    raw = (json.dumps(_payload(), ensure_ascii=False, indent=2) + "\r\n").encode()
    source_file.write_bytes(raw)
    first = _run(source_file, vault, person_id)
    assert first.returncode == 0, first.stderr
    result = json.loads(first.stdout)
    assert result["status"] == "created"
    service.refresh()
    source = service.get_entity(result["source_id"], "source")
    assert source["source_kind"] == "file"
    assert source["title"] == "手机记录 · 2026-11-08"
    assert source["person_ids"] == [person_id]
    assert (vault / source["original_path"]).read_bytes() == raw
    assert source["sha256"] == hashlib.sha256(raw).hexdigest()
    assert not service.list_entities("evidence")
    assert not service.list_entities("report_topic")
    before = _public_hashes(vault)
    second = _run(source_file, vault, person_id)
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout) == {**result, "status": "exists"}
    assert _public_hashes(vault) == before
    other = service.create_person("江远（虚构）", "同事")
    third = _run(source_file, vault, other["id"])
    assert third.returncode == 0, third.stderr
    assert json.loads(third.stdout)["status"] == "created"
    assert json.loads(third.stdout)["source_id"] != result["source_id"]


def test_mobile_import_accepts_summary_only_export_without_confirming_it(tmp_path: Path) -> None:
    vault, service, person_id = _workspace(tmp_path)
    person_before = service.get_entity(person_id, "person")
    payload = _payload()
    payload["data"].pop("lines")
    source_file = tmp_path / "summary.json"
    source_file.write_text(json.dumps(payload, ensure_ascii=False))
    result = _run(source_file, vault, person_id)
    assert result.returncode == 0, result.stderr
    service.refresh()
    assert len(service.list_entities("source")) == 1
    assert not service.list_entities("evidence")
    assert service.get_entity(person_id, "person") == person_before


@pytest.mark.parametrize(
    "case",
    [
        "version",
        "date",
        "generated_at",
        "line_time",
        "line_text",
        "duplicate_id",
        "secret",
        "voiceprint",
        "oversize",
        "invalid_json",
        "unknown_person",
    ],
)
def test_mobile_import_rejects_invalid_exports_without_writing_materials(
    tmp_path: Path,
    case: str,
) -> None:
    vault, _, person_id = _workspace(tmp_path)
    payload = _payload()
    if case == "version":
        payload["version"] = True
    elif case == "date":
        payload["date"] = "2026-02-30"
    elif case == "generated_at":
        payload["generatedAt"] = "2026-11-08"
    elif case == "line_time":
        payload["data"]["lines"][0]["at"] = -1
    elif case == "line_text":
        payload["data"]["lines"][0]["text"] = []
    elif case == "duplicate_id":
        payload["data"]["lines"] *= 2
    elif case == "secret":
        payload["data"]["api_key"] = "dummy-secret-not-a-real-key"
    elif case == "voiceprint":
        payload["data"]["lines"][0]["voice_input"] = {"embedding": [0.1, 0.2]}
    elif case == "unknown_person":
        person_id = str(uuid4())
    source_file = tmp_path / "mobile.json"
    source_file.write_text(json.dumps(payload, ensure_ascii=False))
    if case == "oversize":
        source_file.write_bytes(b" " * (5 * 1024 * 1024 + 1))
    elif case == "invalid_json":
        source_file.write_text('{"type": "daily_memory", "type": "unexpected"}')
    before = _public_hashes(vault)
    result = _run(source_file, vault, person_id)
    assert result.returncode == 1
    assert json.loads(result.stderr)["status"] == "error"
    assert not result.stdout
    assert _public_hashes(vault) == before


def test_mobile_import_does_not_initialize_an_unrelated_folder(tmp_path: Path) -> None:
    source_file = tmp_path / "mobile.json"
    source_file.write_text(json.dumps(_payload(), ensure_ascii=False))
    vault = tmp_path / "ordinary-folder"
    vault.mkdir()
    result = _run(source_file, vault, str(uuid4()))
    assert result.returncode == 1
    assert not list(vault.iterdir())
