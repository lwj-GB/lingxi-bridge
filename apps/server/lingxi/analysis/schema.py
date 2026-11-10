import json
import os
import sys
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


def schema_directory() -> Path:
    configured = os.environ.get("LINGXI_SCHEMA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        bundled = Path(bundle_root) / "schemas"
        if bundled.is_dir():
            return bundled
    project_root = Path(__file__).resolve().parents[4]
    return project_root / "packages" / "schemas"


@cache
def _schema_validator(schema_directory_path: str, name: str) -> Draft202012Validator:
    schema_path = Path(schema_directory_path) / name
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    return Draft202012Validator(schema, format_checker=FormatChecker())


def schema_validator(name: str) -> Draft202012Validator:
    return _schema_validator(str(schema_directory()), name)


def clear_schema_validator_cache() -> None:
    _schema_validator.cache_clear()


def analysis_validator() -> Draft202012Validator:
    return schema_validator("analysis-output.schema.json")


def validate_analysis(value: dict[str, Any]) -> dict[str, Any]:
    analysis_validator().validate(value)
    return value


def chat_topics_validator() -> Draft202012Validator:
    return schema_validator("chat-topics.schema.json")


def validate_chat_topics(value: dict[str, Any]) -> dict[str, Any]:
    chat_topics_validator().validate(value)
    return value


def chat_analysis_validator() -> Draft202012Validator:
    return schema_validator("chat-analysis.schema.json")


def validate_chat_analysis(value: dict[str, Any]) -> dict[str, Any]:
    chat_analysis_validator().validate(value)
    return value


def writing_style() -> str:
    return (schema_directory() / "writing-style.md").read_text(encoding="utf-8")
