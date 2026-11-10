#!/usr/bin/env python3
"""Archive an explicitly selected mobile export; never modify a desktop vault."""

from __future__ import annotations

import hashlib
import html
import json
import math
import os
import re
import tempfile
from datetime import date, datetime
from pathlib import Path
from uuid import UUID
from zoneinfo import ZoneInfo

MAX_BYTES = 20 * 1024 * 1024
MAX_TIME = 253402300799999


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 含重复字段。")
        result[key] = value
    return result


def _timestamp(value):
    return type(value) is int and 0 <= value <= MAX_TIME


def _text(value):
    return isinstance(value, str) and len(value) <= 100_000


def _fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys.split()):
        raise ValueError("日记统计字段不符合只读元数据协议。")


def _number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _rows(values, fields, nullable_counts=False):
    if not isinstance(values, list) or len(values) > 50_000:
        raise ValueError("日记时序列表无效或过长。")
    for value in values:
        _fields(value, fields)
        for key, item in value.items():
            if key in {"count", "foregroundMillis", "typeCode"}:
                if not (nullable_counts and key == "count" and item is None) and not (
                    type(item) is int and item >= 0
                ):
                    raise ValueError("统计值必须为非负数字或明确缺失。")
            elif key in {"startAt", "endAt", "hourStartMillis"}:
                if not _timestamp(item):
                    raise ValueError("统计时间无效。")
            elif not _text(item):
                raise ValueError("统计元数据必须为文字。")
        if "endAt" in value and value["endAt"] < value["startAt"]:
            raise ValueError("统计时段起止顺序无效。")


def _validate_journal(journal):
    _fields(journal, "markdown statistics")
    if not _text(journal["markdown"]):
        raise ValueError("日记正文无效。")
    stats = journal["statistics"]
    _fields(stats, "usage notifications health")
    ready_states = {"Ready", "PermissionRequired", "NoHistory", "Unavailable"}
    usage = stats["usage"]
    _fields(usage, "state message apps timeline")
    if usage["state"] not in ready_states or not _text(usage["message"]):
        raise ValueError("使用情况状态无效。")
    _rows(usage["apps"], "packageName label foregroundMillis")
    _rows(usage["timeline"], "packageName label startAt endAt")
    notices = stats["notifications"]
    _fields(
        notices,
        "state message observedFromMillis observedUntilMillis coveredMillis total apps hourly",
    )
    if (
        notices["state"] not in ready_states
        or not _text(notices["message"])
        or not _number(notices["coveredMillis"])
        or not (notices["total"] is None or type(notices["total"]) is int and notices["total"] >= 0)
        or not all(
            v is None or _timestamp(v)
            for v in (notices["observedFromMillis"], notices["observedUntilMillis"])
        )
    ):
        raise ValueError("通知观测范围或计数无效。")
    _rows(notices["apps"], "packageName label count")
    _rows(notices["hourly"], "hourStartMillis count")
    health = stats["health"]
    _fields(health, "availability steps distanceMeters exerciseMinutes hourlySteps sessions")
    if health["availability"] not in {"Available", "Unsupported", "Unavailable"}:
        raise ValueError("健康服务状态无效。")
    for name in ("steps", "distanceMeters", "exerciseMinutes", "hourlySteps", "sessions"):
        metric = health[name]
        _fields(metric, "state value sourcePackages message")
        if (
            metric["state"] not in {"Available", "NoData", "NotAuthorized", "Unavailable", "Failed"}
            or not isinstance(metric["sourcePackages"], list)
            or not all(_text(x) for x in metric["sourcePackages"])
            or not (metric["message"] is None or _text(metric["message"]))
        ):
            raise ValueError("健康统计状态无效。")
        value = metric["value"]
        if metric["state"] != "Available" and value is not None:
            raise ValueError("缺失或未授权健康数据不能填成零。")
        if value is None:
            continue
        if name == "hourlySteps":
            _rows(value, "startAt endAt count", nullable_counts=True)
        elif name == "sessions":
            _rows(value, "startAt endAt typeCode typeLabel sourcePackage")
        elif not _number(value):
            raise ValueError("健康统计值无效。")


def load_json(raw: bytes):
    return json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=_object,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("JSON 数值无效。")),
    )


def validate(raw: bytes) -> dict:
    if len(raw) > MAX_BYTES:
        raise ValueError("归档包超过 20 MiB，请按日导出。")
    data = load_json(raw)
    keys = {"type", "version", "deviceId", "generatedAt", "date", "timeZone", "lines", "todos"}
    if (
        not isinstance(data, dict)
        or not keys <= set(data)
        or set(data) - keys - {"contexts", "journal"}
    ):
        raise ValueError("归档包字段不符合协议；不接收额外配置或附件。")
    if (
        data["type"] != "lingxi_mobile_archive"
        or type(data["version"]) is not int
        or data["version"] != 1
    ):
        raise ValueError("仅接受 lingxi_mobile_archive 第 1 版。")
    if not isinstance(data["deviceId"], str):
        raise ValueError("设备标识必须为 UUID 文字。")
    device = str(UUID(data["deviceId"]))
    if data["deviceId"] != device or not _timestamp(data["generatedAt"]):
        raise ValueError("设备标识或生成时间无效。")
    day = data["date"]
    if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("日期必须为 YYYY-MM-DD。")
    date.fromisoformat(day)
    ZoneInfo(data["timeZone"])
    ids = set()
    line_ids = set()
    for collection, kind in (("lines", "line"), ("todos", "item")):
        rows = data[collection]
        if not isinstance(rows, list) or len(rows) > 50_000:
            raise ValueError("记录列表无效或过长。")
        for row in rows:
            expected = (
                {"id", "localId", "segmentId", "startAt", "endAt", "speaker", "text"}
                if kind == "line"
                else {
                    "id",
                    "localId",
                    "category",
                    "content",
                    "status",
                    "at",
                    "dueAt",
                    "sourceLineId",
                    "generatedBy",
                }
            )
            if not isinstance(row, dict) or set(row) != expected:
                raise ValueError("记录字段不符合协议。")
            local_id = row["localId"]
            if (
                type(local_id) is not int
                or local_id < 0
                or row["id"] != f"{device}:{kind}:{local_id}"
                or row["id"] in ids
            ):
                raise ValueError("记录标识无效或重复。")
            ids.add(row["id"])
            if kind == "line":
                if (
                    type(row["segmentId"]) is not int
                    or row["segmentId"] < 0
                    or not _timestamp(row["startAt"])
                    or not _timestamp(row["endAt"])
                    or row["endAt"] < row["startAt"]
                    or not _text(row["text"])
                    or not (row["speaker"] is None or _text(row["speaker"]))
                ):
                    raise ValueError("原话时间或内容无效。")
                line_ids.add(row["id"])
            elif (
                not all(_text(row[k]) for k in ("category", "content", "status"))
                or not _timestamp(row["at"])
                or not (row["dueAt"] is None or _timestamp(row["dueAt"]))
                or row["generatedBy"] not in ("ai", "manual", "unknown")
            ):
                raise ValueError("待办内容或时间无效。")
    for row in data["todos"]:
        if row["sourceLineId"] is not None and row["sourceLineId"] not in line_ids:
            raise ValueError("待办来源不存在于归档包。")
    contexts = data.get("contexts", [])
    if not isinstance(contexts, list) or len(contexts) > 50_000:
        raise ValueError("对话补充列表无效。")
    segments = {row["segmentId"] for row in data["lines"]}
    context_segments = set()
    for context in contexts:
        if (
            not isinstance(context, dict)
            or set(context) != {"segmentId", "participants", "background", "updatedAt", "source"}
            or type(context["segmentId"]) is not int
            or context["segmentId"] not in segments
            or context["segmentId"] in context_segments
            or not _text(context["participants"])
            or not _text(context["background"])
            or not _timestamp(context["updatedAt"])
            or context["source"] != "user"
        ):
            raise ValueError("对话补充须对应包内录音段，且明确为用户陈述。")
        context_segments.add(context["segmentId"])
    if "journal" in data:
        _validate_journal(data["journal"])
    if re.search(
        rb"(?:sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN .*PRIVATE KEY-----)", raw
    ):
        raise ValueError("包内含疑似凭据，请核对后重新导出。")
    return data


def render(data: dict, digest: str) -> str:
    zone = ZoneInfo(data["timeZone"])

    def at(value):
        return datetime.fromtimestamp(value / 1000, zone).isoformat(timespec="seconds")

    def quote(value):
        return "\n".join(
            "> " + html.escape(line).replace("!", "\\!").replace("[", "\\[")
            for line in str(value).splitlines()
        )

    text = [
        f"# 手机记录 · {data['date']}",
        "",
        f"设备：`{data['deviceId']}`；生成时间：{at(data['generatedAt'])}",
        f"原件 SHA-256：`{digest}`",
        "",
        "此文件是原件的阅读副本。说话人及 AI 待办可能有误，未写入人物档案或正式报告。",
        "仅包含导出时所选的结构化待办；当日原话仍可能提及未选待办。",
        "",
    ]
    if "journal" in data:
        journal = data["journal"]
        text += ["## 当天日记", "", quote(journal["markdown"]), "", "## 当天统计", ""]
        stats = journal["statistics"]
        usage = stats["usage"]
        text += [f"使用记录：{usage['state']}。{html.escape(usage['message'])}", ""]
        for app in usage["apps"]:
            text.append(
                f"- {html.escape(app['label'])}：{app['foregroundMillis'] / 60000:.1f} 分钟"
            )
        notices = stats["notifications"]
        total = str(notices["total"]) if notices["total"] is not None else "无可用计数"
        text += ["", f"通知：{total}；{notices['state']}。{html.escape(notices['message'])}", ""]
        for app in notices["apps"]:
            text.append(f"- {html.escape(app['label'])}：{app['count']} 条通知")
        health = stats["health"]
        for key, label, unit in (
            ("steps", "步数", "步"),
            ("distanceMeters", "距离", "米"),
            ("exerciseMinutes", "运动", "分钟"),
        ):
            metric = health[key]
            value = f"{metric['value']} {unit}" if metric["value"] is not None else "无可用数据"
            text += [
                f"- {label}：{value}；{metric['state']}。{html.escape(metric['message'] or '')}"
            ]
        text += ["", "完整应用时段、逐小时通知/步数与运动时序保存在 JSON 原件中。", ""]
    if data.get("contexts"):
        text += [
            "## 用户补充",
            "",
            "以下是用户对录音背景的陈述，不是原话或经过声纹验证的身份。",
            "",
        ]
        for context in data["contexts"]:
            text += [
                f"### 录音段 {context['segmentId']} · {at(context['updatedAt'])}",
                "",
                "交谈对象：",
                quote(context["participants"]),
                "背景：",
                quote(context["background"]),
                "",
            ]
    text += ["## 原话", ""]
    for line in sorted(data["lines"], key=lambda x: (x["startAt"], x["id"])):
        text += [
            f"### {at(line['startAt'])} · {html.escape(line['speaker'] or '未知')}",
            f"来源：`{line['id']}`",
            "",
            quote(line["text"]),
            "",
        ]
    text += ["## 所选待办", ""]
    for item in data["todos"]:
        text += [
            f"- 标识：`{item['id']}`；状态：{html.escape(item['status'])}；"
            f"生成方式：{item['generatedBy']}",
            quote(item["content"]),
            f"  来源：`{item['sourceLineId'] or '未关联原话'}`",
            "",
        ]
    return "\n".join(text)


def archive_bytes(raw: bytes, inbox: Path) -> dict:
    data = validate(raw)
    digest = hashlib.sha256(raw).hexdigest()
    inbox = inbox.expanduser().resolve()
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = inbox / f"{data['date']}-{data['deviceId']}-{digest}"
    markdown = render(data, digest).encode("utf-8")
    if target.exists() or target.is_symlink():
        if (
            target.is_symlink()
            or not target.is_dir()
            or any((target / name).is_symlink() for name in ("original.json", "记录.md"))
            or (target / "original.json").read_bytes() != raw
            or (target / "记录.md").read_bytes() != markdown
        ):
            raise ValueError("同名归档已被改动，停止写入，请先核对。")
        return {"status": "exists", "path": str(target), "sha256": digest}
    stage = Path(tempfile.mkdtemp(prefix=".mobile-", dir=inbox))
    for name, content in (("original.json", raw), ("记录.md", markdown)):
        with (stage / name).open("xb") as out:
            os.chmod(stage / name, 0o600)
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
    try:
        stage.rename(target)
    except OSError as exc:
        raise ValueError(f"归档未发布，完整暂存包保留于 {stage}，请核对后重试。") from exc
    return {"status": "created", "path": str(target), "sha256": digest}


def archive(source: Path, inbox: Path) -> dict:
    with source.open("rb") as stream:
        return archive_bytes(stream.read(MAX_BYTES + 1), inbox)
