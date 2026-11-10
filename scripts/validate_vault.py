#!/usr/bin/env python3
"""Validate a Lingxi Bridge legacy demo or V0.1 open workspace."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

LEGACY_REQUIRED_DIRS = ("对象", "事件", "材料", "报告")
LEGACY_REQUIRED_FIELDS = {
    "person": ("type", "id", "display_name", "analysis_scope"),
    "event": ("type", "id", "object", "event_date", "question"),
    "evidence": ("type", "id", "object", "source_kind", "observed_at"),
    "report": ("type", "id", "object", "status"),
}
V01_REQUIRED_DIRS = (
    "attachments",
    "events",
    "evidence",
    "people",
    "reports",
    "reports/snapshots",
    "sources",
)
V01_MARKDOWN_GROUPS = (
    ("people", "person"),
    ("relations", "relation"),
    ("events", "event"),
    ("transcripts", "screenshot_transcript"),
    ("evidence", "evidence"),
    ("reports", "report_topic"),
    ("reports/snapshots", "report_snapshot"),
)
V01_BASE_FIELDS = (
    "schema_version",
    "entity_type",
    "id",
    "revision",
    "created_at",
    "updated_at",
)
SECRET_PATTERNS = {
    "可能的 API key": re.compile(r"(?:sk-|AKIA|AIza)[A-Za-z0-9_-]{12,}"),
    "可能的私钥": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
}


def parse_frontmatter(path: Path) -> tuple[dict[str, str], list[str]]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, ["缺少 YAML frontmatter"]
    try:
        end = lines.index("---", 1)
    except ValueError:
        return {}, ["frontmatter 未闭合"]

    data: dict[str, str] = {}
    errors: list[str] = []
    for line_no, line in enumerate(lines[1:end], 2):
        if not line.strip():
            continue
        if ":" not in line:
            errors.append(f"第 {line_no} 行不是 key: value")
            continue
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip().strip('"\'')
        if not key:
            errors.append(f"第 {line_no} 行 key 为空")
        elif key in data:
            errors.append(f"字段重复：{key}")
        else:
            data[key] = value
    return data, errors


def parse_v01_frontmatter(path: Path) -> tuple[dict[str, str], list[str]]:
    """Read only top-level scalar keys; nested YAML is validated by the service."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, ["缺少 YAML frontmatter"]
    try:
        end = lines.index("---", 1)
    except ValueError:
        return {}, ["frontmatter 未闭合"]

    data: dict[str, str] = {}
    errors: list[str] = []
    for line_no, line in enumerate(lines[1:end], 2):
        if not line.strip() or line[0].isspace() or line.lstrip().startswith("-"):
            continue
        if ":" not in line:
            errors.append(f"第 {line_no} 行不是 key: value")
            continue
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip().strip("\"'")
        if not key:
            errors.append(f"第 {line_no} 行 key 为空")
        elif key in data:
            errors.append(f"字段重复：{key}")
        else:
            data[key] = value
    return data, errors


def scan_secrets(vault: Path, paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in sorted(paths):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                errors.append(f"{path.relative_to(vault)}：{label}")
    return errors


def validate_legacy(vault: Path) -> tuple[list[str], list[str], int, int]:
    errors: list[str] = []
    warnings: list[str] = []

    for dirname in LEGACY_REQUIRED_DIRS:
        if not (vault / dirname).is_dir():
            errors.append(f"缺少目录：{dirname}/")

    seen_ids: dict[str, Path] = {}
    records: list[tuple[Path, dict[str, str]]] = []
    for path in sorted(vault.rglob("*.md")):
        if path.name == "00-使用说明.md":
            continue
        data, parse_errors = parse_frontmatter(path)
        errors.extend(f"{path.relative_to(vault)}：{error}" for error in parse_errors)
        if not data:
            continue
        records.append((path, data))
        kind = data.get("type", "")
        if kind not in LEGACY_REQUIRED_FIELDS:
            warnings.append(f"{path.relative_to(vault)}：未知 type={kind or '<空>'}")
            continue
        for field in LEGACY_REQUIRED_FIELDS[kind]:
            if not data.get(field, "").strip():
                errors.append(f"{path.relative_to(vault)}：缺少字段 {field}")
        record_id = data.get("id", "").strip()
        if record_id:
            if record_id in seen_ids:
                errors.append(
                    f"重复 id={record_id}：{seen_ids[record_id].relative_to(vault)} "
                    f"与 {path.relative_to(vault)}"
                )
            else:
                seen_ids[record_id] = path

    all_ids = {data.get("id", "").strip() for _, data in records}
    for path, data in records:
        if data.get("type") in {"event", "evidence", "report"}:
            target = data.get("object", "").strip()
            if target and target not in all_ids:
                warnings.append(f"{path.relative_to(vault)}：暂未找到 object={target} 对应对象")

    markdown_paths = list(vault.rglob("*.md"))
    errors.extend(scan_secrets(vault, markdown_paths))
    return errors, warnings, len(markdown_paths), len(seen_ids)


def validate_v01(vault: Path) -> tuple[list[str], list[str], int, int]:
    errors: list[str] = []
    warnings: list[str] = []
    seen_ids: dict[str, Path] = {}
    inspected_paths: list[Path] = []

    for dirname in V01_REQUIRED_DIRS:
        if not (vault / dirname).is_dir():
            errors.append(f"缺少目录：{dirname}/")

    manifest_path = vault / "workspace.json"
    inspected_paths.append(manifest_path)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        errors.append("workspace.json：无法解析")
        manifest = {}
    for field in ("schema_version", "workspace_id", "created_at", "title"):
        if not str(manifest.get(field, "")).strip():
            errors.append(f"workspace.json：缺少字段 {field}")
    if manifest.get("schema_version") not in (None, "0.1"):
        errors.append("workspace.json：schema_version 必须为 0.1")

    for directory, expected_type in V01_MARKDOWN_GROUPS:
        base = vault / directory
        paths = sorted(base.glob("*.md")) if base.is_dir() else []
        inspected_paths.extend(paths)
        for path in paths:
            data, parse_errors = parse_v01_frontmatter(path)
            errors.extend(f"{path.relative_to(vault)}：{error}" for error in parse_errors)
            if not data:
                continue
            for field in V01_BASE_FIELDS:
                if not data.get(field, "").strip():
                    errors.append(f"{path.relative_to(vault)}：缺少字段 {field}")
            if data.get("schema_version") != "0.1":
                errors.append(f"{path.relative_to(vault)}：schema_version 必须为 0.1")
            if data.get("entity_type") != expected_type:
                errors.append(
                    f"{path.relative_to(vault)}：entity_type 应为 {expected_type}"
                )
            record_id = data.get("id", "").strip()
            if record_id and path.stem != record_id:
                errors.append(f"{path.relative_to(vault)}：文件名必须与 id 一致")
            if record_id in seen_ids:
                errors.append(
                    f"重复 id={record_id}：{seen_ids[record_id].relative_to(vault)} "
                    f"与 {path.relative_to(vault)}"
                )
            elif record_id:
                seen_ids[record_id] = path

    source_dir = vault / "sources"
    source_paths = sorted(source_dir.glob("*.json")) if source_dir.is_dir() else []
    inspected_paths.extend(source_paths)
    for path in source_paths:
        try:
            source = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            errors.append(f"{path.relative_to(vault)}：无法解析 JSON")
            continue
        for field in (*V01_BASE_FIELDS, "original_path", "sha256"):
            if not str(source.get(field, "")).strip():
                errors.append(f"{path.relative_to(vault)}：缺少字段 {field}")
        if source.get("schema_version") != "0.1":
            errors.append(f"{path.relative_to(vault)}：schema_version 必须为 0.1")
        if source.get("entity_type") != "source":
            errors.append(f"{path.relative_to(vault)}：entity_type 应为 source")
        record_id = str(source.get("id", "")).strip()
        if record_id and path.stem != record_id:
            errors.append(f"{path.relative_to(vault)}：文件名必须与 id 一致")
        if record_id in seen_ids:
            errors.append(
                f"重复 id={record_id}：{seen_ids[record_id].relative_to(vault)} "
                f"与 {path.relative_to(vault)}"
            )
        elif record_id:
            seen_ids[record_id] = path

        relative_original = str(source.get("original_path", "")).strip()
        if relative_original:
            original = (vault / relative_original).resolve()
            try:
                original.relative_to(vault)
            except ValueError:
                errors.append(f"{path.relative_to(vault)}：附件路径越出工作区")
                continue
            try:
                original_bytes = original.read_bytes()
            except OSError:
                errors.append(f"{path.relative_to(vault)}：附件不存在或无法读取")
                continue
            if hashlib.sha256(original_bytes).hexdigest() != source.get("sha256"):
                errors.append(
                    f"{path.relative_to(vault)}：附件 SHA-256 与来源记录不一致"
                )

    errors.extend(scan_secrets(vault, inspected_paths))
    return errors, warnings, len(list(vault.rglob("*.md"))), len(seen_ids)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path)
    args = parser.parse_args()
    vault = args.vault.expanduser().resolve()

    if not vault.is_dir():
        print(f"FAIL: vault 不存在：{vault}")
        return 1

    is_v01 = (vault / "workspace.json").is_file()
    if is_v01:
        errors, warnings, markdown_count, record_count = validate_v01(vault)
        format_label = "v0.1 open workspace"
    else:
        errors, warnings, markdown_count, record_count = validate_legacy(vault)
        format_label = "legacy demo"

    if errors:
        print("FAIL")
        for error in errors:
            print(f"- {error}")
        if warnings:
            print("WARNINGS")
            for warning in warnings:
                print(f"- {warning}")
        return 1

    print(f"PASS: {vault}")
    print(f"- format: {format_label}")
    print(f"- markdown files: {markdown_count}")
    print(f"- records: {record_count}")
    for warning in warnings:
        print(f"WARN: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
