from pathlib import Path

from lingxi.analysis.schema import clear_schema_validator_cache, schema_validator, writing_style


def test_schema_directory_can_be_supplied_for_packaged_runtime(
    monkeypatch,
    tmp_path: Path,
) -> None:
    project_schemas = Path(__file__).resolve().parents[4] / "packages" / "schemas"
    target = tmp_path / "schemas"
    target.mkdir()
    for name in (
        "writing-style.md",
        "analysis-output.schema.json",
        "screenshot-recognition.schema.json",
        "live-session.schema.json",
        "profile-autofill.schema.json",
        "chat-topics.schema.json",
        "chat-analysis.schema.json",
    ):
        (target / name).write_bytes((project_schemas / name).read_bytes())

    monkeypatch.setenv("LINGXI_SCHEMA_DIR", str(target))
    clear_schema_validator_cache()
    try:
        assert "语气温和、体谅、尊重" in writing_style()
        assert schema_validator("analysis-output.schema.json").schema["title"]
        assert schema_validator("screenshot-recognition.schema.json").schema["title"]
        assert schema_validator("live-session.schema.json").schema["title"]
        assert schema_validator("profile-autofill.schema.json").schema["title"]
        assert schema_validator("chat-topics.schema.json").schema["title"]
        assert schema_validator("chat-analysis.schema.json").schema["title"]
    finally:
        clear_schema_validator_cache()
