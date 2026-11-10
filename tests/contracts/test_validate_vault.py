from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts" / "validate_vault.py"


def _write_v01_vault(vault: Path) -> None:
    for directory in (
        "attachments/source-1",
        "events",
        "evidence",
        "people",
        "relations",
        "reports/snapshots",
        "sources",
        "transcripts",
    ):
        (vault / directory).mkdir(parents=True, exist_ok=True)

    (vault / "workspace.json").write_text(
        json.dumps(
            {
                "schema_version": "0.1",
                "workspace_id": "workspace-test",
                "created_at": "2026-07-27T00:00:00Z",
                "title": "虚构验收工作区",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (vault / "people" / "person-1.md").write_text(
        """---
schema_version: '0.1'
entity_type: person
id: person-1
revision: 1
created_at: '2026-07-27T00:00:00Z'
updated_at: '2026-07-27T00:00:00Z'
display_name: 虚构人物
relation_to_user: 朋友
profile_sections: []
---
# 虚构人物
""",
        encoding="utf-8",
    )
    original = b"\x89PNG\r\n\x1a\nfictional"
    (vault / "attachments" / "source-1" / "original.png").write_bytes(original)
    (vault / "sources" / "source-1.json").write_text(
        json.dumps(
            {
                "schema_version": "0.1",
                "entity_type": "source",
                "id": "source-1",
                "revision": 1,
                "created_at": "2026-07-27T00:00:00Z",
                "updated_at": "2026-07-27T00:00:00Z",
                "title": "虚构截图",
                "source_kind": "screenshot",
                "original_path": "attachments/source-1/original.png",
                "sha256": hashlib.sha256(original).hexdigest(),
                "byte_size": len(original),
                "mime_type": "image/png",
                "person_ids": ["person-1"],
                "event_ids": [],
                "processing_status": "pending_confirmation",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _run_validator(vault: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), "--vault", str(vault)],
        check=False,
        capture_output=True,
        text=True,
    )


def test_validator_accepts_v01_open_workspace(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    _write_v01_vault(vault)

    result = _run_validator(vault)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "format: v0.1 open workspace" in result.stdout
    assert "records: 2" in result.stdout


def test_validator_rejects_changed_v01_original(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    _write_v01_vault(vault)
    (vault / "attachments" / "source-1" / "original.png").write_bytes(b"changed")

    result = _run_validator(vault)

    assert result.returncode == 1
    assert "附件 SHA-256 与来源记录不一致" in result.stdout
