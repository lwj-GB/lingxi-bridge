#!/usr/bin/env python3
"""Import one explicitly selected TaoSheng daily-memory export into a local vault."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID

SERVER_ROOT = Path(__file__).resolve().parents[1] / "apps" / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from lingxi.workspace.service import WorkspaceError, WorkspaceService  # noqa: E402

MAX_BYTES = 5 * 1024 * 1024
MAX_LINES = 10_000
MAX_TIMESTAMP_MS = 253402300799999
FORBIDDEN_KEYS = {
    "apikey",
    "accesskey",
    "secretkey",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "password",
    "credentials",
    "voiceprint",
    "voiceprints",
    "voiceprintid",
    "embedding",
    "embeddings",
    "speakerembedding",
}
SECRET_PATTERN = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|"
    r"github_pat_[A-Za-z0-9_]{30,}|-----BEGIN .*PRIVATE KEY-----)"
)


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 中存在重复字段。")
        result[key] = value
    return result


def _check_contents(value: Any, depth: int = 0) -> None:
    if depth > 30:
        raise ValueError("JSON 嵌套层级过多。")
    if isinstance(value, dict):
        for key, item in value.items():
            if re.sub(r"[^a-z]", "", key.lower()) in FORBIDDEN_KEYS:
                raise ValueError("文件含凭据或声纹字段，请只导出会谈文字。")
            _check_contents(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _check_contents(item, depth + 1)
    elif isinstance(value, str) and SECRET_PATTERN.search(value):
        raise ValueError("文件含疑似密钥，请移除后重新导出。")


def _invalid_constant(_: str) -> None:
    raise ValueError("JSON 不能包含 NaN 或 Infinity。")


def _timestamp(value: Any) -> bool:
    return type(value) is int and 0 <= value <= MAX_TIMESTAMP_MS


def load_export(path: Path) -> tuple[str, dict[str, Any]]:
    with path.open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("导出文件不能超过 5 MiB。")
    text = raw.decode("utf-8")
    payload = json.loads(text, object_pairs_hook=_object, parse_constant=_invalid_constant)
    if not isinstance(payload, dict):
        raise ValueError("导出内容必须是 JSON 对象。")
    _check_contents(payload)
    if (
        payload.get("type") != "daily_memory"
        or type(payload.get("version")) is not int
        or payload["version"] != 1
        or payload.get("app") != "resound"
    ):
        raise ValueError("仅支持 TaoSheng daily_memory 第 1 版导出。")
    day = payload.get("date")
    if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("date 必须是 YYYY-MM-DD。")
    date.fromisoformat(day)
    if not _timestamp(payload.get("generatedAt")):
        raise ValueError("generatedAt 必须是有效的 Unix 毫秒时间。")
    if not isinstance(payload.get("markdown"), str):
        raise ValueError("markdown 必须是文字。")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("data 必须是对象。")
    for key in ("events", "items", "cards"):
        if key in data and not isinstance(data[key], list):
            raise ValueError(f"data.{key} 必须是数组。")
    if data.get("review") is not None and not isinstance(data["review"], dict):
        raise ValueError("data.review 必须是对象或 null。")
    lines = data.get("lines", [])
    if not isinstance(lines, list) or len(lines) > MAX_LINES:
        raise ValueError("data.lines 必须是数组，且不能超过 10000 条。")
    ids: set[int] = set()
    for line in lines:
        if not isinstance(line, dict):
            raise ValueError("每条转写必须是对象。")
        line_id = line.get("id")
        if type(line_id) is not int or line_id < 0 or line_id in ids:
            raise ValueError("转写 id 必须是唯一的非负整数。")
        ids.add(line_id)
        if not _timestamp(line.get("at")):
            raise ValueError("转写 at 必须是有效的 Unix 毫秒时间。")
        if not isinstance(line.get("speaker"), str) or not line["speaker"].strip():
            raise ValueError("每条转写必须有说话人标签。")
        if not isinstance(line.get("text"), str) or not line["text"].strip():
            raise ValueError("每条转写必须有文字。")
    if not lines and not payload["markdown"].strip():
        raise ValueError("文件没有可导入的转写或摘要。")
    return text, payload


def import_memory(input_path: Path, vault: Path, person_id: str) -> dict[str, str]:
    text, payload = load_export(input_path)
    try:
        UUID(person_id)
    except ValueError as error:
        raise ValueError("person-id 必须是已有联系人的 UUID。") from error
    vault = vault.expanduser().resolve()
    if not (vault / "workspace.json").is_file():
        raise ValueError("请选择已有的灵犀桥工作区。")
    service = WorkspaceService()
    service.open(vault)
    person = service.get_entity(person_id, "person")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    for source in service.list_entities("source"):
        if source.get("sha256") == digest and person["id"] in source.get("person_ids", []):
            service.get_source_original(source["id"])
            return {"status": "exists", "source_id": source["id"], "sha256": digest}
    # The JSON stays byte-for-byte intact; summaries are source material, never evidence.
    source = service.import_text_source(
        title=f"手机记录 · {payload['date']}",
        text=text,
        source_kind="file",
        person_ids=[person["id"]],
        event_ids=[],
    )
    return {"status": "created", "source_id": source["id"], "sha256": digest}


def main() -> int:
    parser = argparse.ArgumentParser(description="将 TaoSheng JSON 记录导入已有联系人。")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--person-id", required=True)
    args = parser.parse_args()
    try:
        result = import_memory(args.input, args.vault, args.person_id)
    except (OSError, ValueError, RecursionError, WorkspaceError) as error:
        message = error.message if isinstance(error, WorkspaceError) else str(error)
        print(
            json.dumps({"status": "error", "message": message}, ensure_ascii=False), file=sys.stderr
        )
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
