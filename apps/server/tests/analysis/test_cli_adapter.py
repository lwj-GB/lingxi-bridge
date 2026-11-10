import os
import stat
import threading
import time
from pathlib import Path

import pytest
from lingxi.analysis.cli import (
    CliAdapter,
    CliExecutionError,
    ExecutionCancelled,
    ExecutionTimedOut,
    _codex_output_schema,
)
from lingxi.analysis.schema import analysis_validator

EVIDENCE_ID = "30000000-0000-4000-8000-000000000001"
SOURCE_ID = "20000000-0000-4000-8000-000000000001"


def test_cli_adapter_allows_long_local_report_runs_by_default(
    tmp_path: Path,
) -> None:
    adapter = CliAdapter("codex", tmp_path / "codex")

    assert adapter.timeout_seconds == 180


def _make_fake_cli(path: Path, body: str) -> Path:
    path.write_text(f"#!{os.sys.executable}\n{body}", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_cli_adapter_uses_isolated_read_only_materials_and_validates_json(
    tmp_path: Path,
    monkeypatch,
) -> None:
    executable = _make_fake_cli(
        tmp_path / "fake claude",
        f"""
import json
import os
from pathlib import Path

root = Path.cwd()
prompt = os.sys.stdin.read()
materials = list((root / "input" / "materials").glob("*.json"))
assert len(materials) == 1
assert materials[0].stat().st_mode & 0o222 == 0
assert Path(os.environ["HOME"]).parent == root
assert Path(os.environ["CLAUDE_CONFIG_DIR"]).is_relative_to(root)
assert Path(os.environ["CODEX_HOME"]).is_relative_to(root)
assert "LINGXI_TEST_SECRET" not in os.environ
assert "--tools" in os.sys.argv
assert "虚构材料" in prompt
assert "{SOURCE_ID}" in prompt
assert "Write natural Chinese paragraphs" in prompt
assert "语气温和、体谅、尊重" in prompt
assert "一句说一件事" in prompt
assert "下次沟通前，哪些事实需要先核对？" in prompt
assert "分析维度：具体情境；孩子视角" in prompt
assert "边界：不得贴标签" in prompt
assert "communication_prep" in prompt
assert "Never diagnose mental illness" in prompt
print(json.dumps({{
    "schema_version": "0.1",
    "material_scope": ["{SOURCE_ID}"],
    "claims": [{{
        "claim_type": "observation",
        "text": "已读取隔离材料。",
        "evidence_ids": ["{EVIDENCE_ID}"]
    }}]
}}))
""",
    )
    monkeypatch.setenv("LINGXI_TEST_SECRET", "must-not-cross-boundary")
    monkeypatch.setenv("HOME", str(tmp_path / "must-not-use-home"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "must-not-use-claude"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "must-not-use-codex"))

    analysis = CliAdapter(
        "claude",
        executable,
        profile_id="isolated-test",
        timeout_seconds=2,
    ).run(
        [
            {
                "id": EVIDENCE_ID,
                "source_id": SOURCE_ID,
                "quote": "虚构材料",
                "reliability": "medium",
            }
        ],
        analysis_question="下次沟通前，哪些事实需要先核对？\n分析维度：具体情境；孩子视角\n边界：不得贴标签",
        template_family="special",
        template_variant="communication_prep",
        relation_labels=["朋友"],
    )

    assert analysis["material_scope"] == [SOURCE_ID]
    assert analysis["claims"][0]["text"] == "已读取隔离材料。"


def test_cli_adapter_autofill_reads_one_source_and_validates_exact_quote(
    tmp_path: Path,
) -> None:
    source = "姓名：林舟\n喜欢：徒步🙂"
    start = source.index("喜欢：")
    quote = "喜欢：徒步🙂"
    executable = _make_fake_cli(
        tmp_path / "fake codex",
        f"""
import json
from pathlib import Path

root = Path.cwd()
source = (root / "input" / "materials" / "0000.txt").read_text(encoding="utf-8")
assert source == {source!r}
schema = json.loads(
    (root / "profile-autofill.schema.json").read_text(encoding="utf-8")
)
assert schema["properties"]["schema_version"] == {{
    "enum": ["0.1"],
    "type": "string"
}}
result = {{
    "schema_version": "0.1",
    "person": {{"display_name": "林舟", "relation_to_user": None}},
    "candidates": [{{
        "section": "preferences",
        "label": "喜欢",
        "value": "徒步🙂",
        "quote": {quote!r},
        "start": {start},
        "end": {start + len(quote)},
        "confidence": "high"
    }}],
    "skipped_sections": []
}}
(root / "profile-autofill.json").write_text(
    json.dumps(result, ensure_ascii=False),
    encoding="utf-8",
)
""",
    )

    preview = CliAdapter("codex", executable, timeout_seconds=2).run_profile_autofill(
        source
    )

    assert preview["person"]["display_name"] == "林舟"
    assert preview["candidates"][0]["quote"] == quote


def test_codex_schema_removes_conditionals_and_makes_optional_fields_nullable() -> None:
    schema = _codex_output_schema(analysis_validator().schema)
    claim = schema["$defs"]["claim"]

    assert "allOf" not in claim
    assert set(claim["required"]) == set(claim["properties"])
    assert claim["properties"]["uncertainty"]["anyOf"][-1] == {"type": "null"}
    assert schema["properties"]["schema_version"] == {
        "enum": ["0.1"],
        "type": "string",
    }


def test_codex_output_drops_nulls_for_canonical_optional_fields(
    tmp_path: Path,
) -> None:
    executable = _make_fake_cli(
        tmp_path / "fake strict codex",
        f"""
import json
from pathlib import Path

root = Path.cwd()
result = {{
    "schema_version": "0.1",
    "material_scope": ["{SOURCE_ID}"],
    "claims": [{{
        "claim_type": "observation",
        "text": "结构化结果可用。",
        "evidence_ids": ["{EVIDENCE_ID}"],
        "uncertainty": None,
        "alternatives": None
    }}]
}}
(root / "analysis-output.json").write_text(
    json.dumps(result, ensure_ascii=False),
    encoding="utf-8",
)
""",
    )

    analysis = CliAdapter("codex", executable, timeout_seconds=2).run(
        [{"id": EVIDENCE_ID, "source_id": SOURCE_ID, "quote": "虚构材料"}]
    )

    assert "uncertainty" not in analysis["claims"][0]
    assert "alternatives" not in analysis["claims"][0]


def test_cli_adapter_chat_topics_use_message_indexes_and_shared_schema(
    tmp_path: Path,
) -> None:
    executable = _make_fake_cli(
        tmp_path / "fake chat codex",
        f"""
import json
from pathlib import Path

root = Path.cwd()
messages = json.loads(
    (root / "input" / "materials" / "messages.json").read_text(encoding="utf-8")
)
assert messages[0]["text"] == "周末去植物园吗？"
assert (root / "chat-topics.schema.json").exists()
result = {{
    "schema_version": "0.1",
    "source_id": "{SOURCE_ID}",
    "topics": [{{
        "title": "周末安排",
        "summary": "消息在讨论周末活动。",
        "keywords": ["周末", "植物园"],
        "message_indexes": [0]
    }}]
}}
(root / "chat-topics.json").write_text(
    json.dumps(result, ensure_ascii=False),
    encoding="utf-8",
)
""",
    )

    result = CliAdapter(
        "codex",
        executable,
        timeout_seconds=2,
    ).run_chat_topics(
        SOURCE_ID,
        [
            {
                "index": 0,
                "speaker": "林澄",
                "hour": 9,
                "text": "周末去植物园吗？",
                "locator": {"start": 18, "end": 27},
            }
        ],
    )

    assert result["topics"][0]["message_indexes"] == [0]


def test_inherited_profile_preserves_environment_without_rewriting_cli_config(
    tmp_path: Path,
    monkeypatch,
) -> None:
    home_dir = tmp_path / "existing-home"
    claude_dir = tmp_path / "existing-claude"
    codex_dir = tmp_path / "existing-codex"
    for directory in (home_dir, claude_dir, codex_dir):
        directory.mkdir()
    claude_settings = claude_dir / "settings.json"
    codex_settings = codex_dir / "config.toml"
    claude_settings.write_text('{"model":"existing"}\n', encoding="utf-8")
    codex_settings.write_text('model = "existing"\n', encoding="utf-8")
    before = (claude_settings.read_bytes(), codex_settings.read_bytes())
    executable = _make_fake_cli(
        tmp_path / "fake inherited claude",
        f"""
import json
import os

assert os.environ["HOME"] == {str(home_dir)!r}
assert os.environ["CLAUDE_CONFIG_DIR"] == {str(claude_dir)!r}
assert os.environ["CODEX_HOME"] == {str(codex_dir)!r}
assert os.environ["LINGXI_NONSENSITIVE_PROFILE_VALUE"] == "kept"
print(json.dumps({{
    "schema_version": "0.1",
    "material_scope": ["{SOURCE_ID}"],
    "claims": [{{
        "claim_type": "observation",
        "text": "继承档环境可用。",
        "evidence_ids": ["{EVIDENCE_ID}"]
    }}]
}}))
""",
    )
    monkeypatch.setenv("HOME", str(home_dir))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude_dir))
    monkeypatch.setenv("CODEX_HOME", str(codex_dir))
    monkeypatch.setenv("LINGXI_NONSENSITIVE_PROFILE_VALUE", "kept")

    analysis = CliAdapter(
        "claude",
        executable,
        profile_id="inherited",
        timeout_seconds=2,
    ).run(
        [{"id": EVIDENCE_ID, "source_id": SOURCE_ID, "quote": "虚构材料"}]
    )

    assert analysis["claims"][0]["text"] == "继承档环境可用。"
    assert (claude_settings.read_bytes(), codex_settings.read_bytes()) == before


def test_cli_adapter_cancels_a_running_process(tmp_path: Path) -> None:
    executable = _make_fake_cli(
        tmp_path / "slow claude",
        """
import time
time.sleep(30)
""",
    )
    cancelled = threading.Event()
    timer = threading.Timer(0.1, cancelled.set)
    timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(ExecutionCancelled):
            CliAdapter("claude", executable, timeout_seconds=5).run(
                [{"id": EVIDENCE_ID, "source_id": SOURCE_ID, "quote": "虚构材料"}],
                cancel_event=cancelled,
            )
    finally:
        timer.cancel()

    assert time.monotonic() - started < 2


def test_cli_adapter_times_out_without_exposing_process_output(tmp_path: Path) -> None:
    executable = _make_fake_cli(
        tmp_path / "timeout claude",
        """
import os
import time
print(os.environ.get("LINGXI_TEST_SECRET", "private-output"), flush=True)
time.sleep(30)
""",
    )

    with pytest.raises(ExecutionTimedOut, match="analysis process timed out") as raised:
        CliAdapter("claude", executable, timeout_seconds=0.1).run(
            [{"id": EVIDENCE_ID, "source_id": SOURCE_ID, "quote": "虚构材料"}]
        )

    assert "private-output" not in str(raised.value)


def test_cli_adapter_hides_process_start_failure_details(tmp_path: Path) -> None:
    executable = tmp_path / "missing-secret-name"

    with pytest.raises(CliExecutionError, match="analysis process could not start") as raised:
        CliAdapter("claude", executable).run(
            [{"id": EVIDENCE_ID, "source_id": SOURCE_ID, "quote": "虚构材料"}]
        )

    assert "missing-secret-name" not in str(raised.value)
