from __future__ import annotations

import bisect
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import date
from pathlib import Path

from lingxi.analysis.chat_analysis import (
    _STOP_LATIN,
    _STOP_TERMS,
    MAX_CHAT_CHARACTERS,
    _top_terms,
    parse_chat_messages,
)

SCRIPT = Path(__file__).with_name("report_charts.R")
_DATE = re.compile(
    r"^[ \t\[]*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?"
    r"(?=[T, \t]+\d{1,2}:\d{2}|[ \t\]]*$)", re.MULTILINE,
)
_DATE_ONLY = re.compile(r"[\[\] \t]*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?[\[\] \t]*")
ASSET_TYPES = {
    "frequency.png": ("记录频率", "image/png", "image"),
    "terms.png": ("词频线索", "image/png", "image"),
    "frequency.csv": ("频率数据 CSV", "text/csv", "data"),
    "terms.csv": ("词频数据 CSV", "text/csv", "data"),
    "report_charts.R": ("固定 R 脚本", "text/plain", "script"),
    "manifest.json": ("统计方法与完整性清单", "application/json", "manifest"),
}


class ReportChartError(Exception):
    pass


def _r_environment() -> dict[str, str]:
    allowed = {"PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
               "R_HOME", "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"}
    return {key: value for key, value in os.environ.items() if key in allowed}


def _rscript() -> str | None:
    executable = shutil.which("Rscript")
    if executable:
        return executable
    for candidate in (
        "/usr/local/bin/Rscript", "/opt/homebrew/bin/Rscript",
        "/Library/Frameworks/R.framework/Resources/bin/Rscript",
    ):
        if os.access(candidate, os.X_OK):
            return candidate
    return None


def plotting_capabilities() -> dict:
    executable = _rscript()
    if not executable or not SCRIPT.is_file():
        return {"available": False, "reason": "未找到本机 Rscript 或固定绘图脚本。"}
    try:
        result = subprocess.run(
            [executable, "--vanilla", "-e", (
                'if (!requireNamespace("ggplot2", quietly=TRUE)) quit(status=2); '
                'cat(as.character(getRversion()), "\\n", '
                'as.character(packageVersion("ggplot2")), "\\n", sep="")'
            )],
            capture_output=True, text=True, timeout=15, check=False, env=_r_environment(),
        )
        if result.returncode != 0:
            return {"available": False, "reason": "本机 R 缺少可用的 ggplot2。"}
        versions = result.stdout.strip().splitlines()
        if len(versions) != 2:
            raise ValueError("invalid R version response")
        return {"available": True, "r_version": versions[0], "ggplot2_version": versions[1]}
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {"available": False, "reason": "本机 R 运行检查失败或超时。"}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def generate_report_charts(destination: Path, sources: list[dict]) -> dict:
    """Generate only aggregate CSVs with a fixed local script; never execute model code."""
    capability = plotting_capabilities()
    if not capability["available"]:
        raise ReportChartError(capability["reason"])
    if destination.exists():
        raise ReportChartError("图表目录已存在，未覆盖已有图表。")
    messages = []
    combined_text = []
    daily: Counter[tuple[str, str]] = Counter()
    speakers: Counter[str] = Counter()
    missing_dates = 0
    source_manifest = []
    for source in sources:
        text = source["text"]
        if len(text) > MAX_CHAT_CHARACTERS:
            raise ReportChartError("单份图表材料超过500万字符，请先分段。")
        positions, dates = [], []
        for match in _DATE.finditer(text):
            try:
                value = date(*map(int, match.groups())).isoformat()
            except ValueError:
                continue
            positions.append(match.start())
            dates.append(value)
        parsed = [item for item in parse_chat_messages(text) if not _DATE_ONLY.fullmatch(item.text)]
        for item in parsed:
            speaker = item.speaker or "未标注说话人"
            speakers[speaker] += 1
            position = bisect.bisect_right(positions, item.start) - 1
            if position < 0:
                missing_dates += 1
            else:
                daily[(dates[position], speaker)] += 1
        messages.extend(parsed)
        combined_text.append(text)
        source_manifest.append({
            "id": source["id"], "sha256": source["sha256"],
            "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "source_kind": source["source_kind"], "parsed_records": len(parsed),
        })
    if not messages:
        raise ReportChartError("所选材料没有可统计的文本，未创建带图表报告。")
    if sum(len(text) for text in combined_text) > MAX_CHAT_CHARACTERS:
        raise ReportChartError("本次图表材料合计超过500万字符，请缩小范围。")
    mode = "daily" if missing_dates == 0 else "speaker_totals"
    missing = []
    if missing_dates:
        missing.append(f"{missing_dates}条统计记录缺少明确日期，改为按说话人计数，不绘制时间趋势。")
    unknown = speakers.get("未标注说话人", 0)
    if unknown:
        missing.append(f"{unknown}条统计记录没有可识别说话人，单列为未标注说话人。")
    terms = _top_terms(messages)
    if not terms:
        missing.append("没有符合规则的重复词组，词频图显示无可用数据。")
    frequency = (
        [{"date": day, "speaker": speaker, "count": count}
         for (day, speaker), count in sorted(daily.items())]
        if mode == "daily" else
        [{"date": "", "speaker": speaker, "count": count}
         for speaker, count in sorted(speakers.items(), key=lambda item: (-item[1], item[0]))]
    )
    with tempfile.TemporaryDirectory(prefix="lingxi-r-charts-") as temporary:
        stage = Path(temporary)
        _write_csv(stage / "frequency.csv", ["date", "speaker", "count"], frequency)
        _write_csv(stage / "terms.csv", ["term", "count", "message_count"], [
            {key: item[key] for key in ("term", "count", "message_count")} for item in terms
        ])
        shutil.copyfile(SCRIPT, stage / "report_charts.R")
        try:
            result = subprocess.run(
                [_rscript(), "--vanilla", str(stage / "report_charts.R"), str(stage), mode],
                capture_output=True, text=True, timeout=90, check=False, env=_r_environment(),
            )
        except (OSError, subprocess.TimeoutExpired, TypeError) as error:
            raise ReportChartError("本机 R 绘图失败或超时，未创建带图表报告。") from error
        if result.returncode != 0:
            raise ReportChartError("本机 R 未能完成图表，请检查 R/ggplot2 和字体环境。")
        for name in ("frequency.png", "terms.png"):
            path = stage / name
            if not path.is_file() or not path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
                raise ReportChartError("R 未输出有效图表，未创建带图表报告。")
        assets = [
            {"name": name, "title": ASSET_TYPES[name][0], "sha256": _sha(stage / name),
             "mime_type": ASSET_TYPES[name][1], "kind": ASSET_TYPES[name][2]}
            for name in ASSET_TYPES if name != "manifest.json"
        ]
        manifest = {
            "schema_version": "0.1", "sources": source_manifest,
            "record_count": len(messages), "frequency_mode": mode,
            "missing_information": missing,
            "rules": {
                "parser": "lingxi.analysis.chat_analysis.parse_chat_messages",
                "unit": "按可识别聊天消息或非空文本记录计数；独立日期标题不计入。",
                "dates": "仅识别明确的年月日日期标记；未补全日期，不推断未提供时段。",
                "terms": "复用本地2–6字中文重复词组与英文词频规则；不是精确中文分词。",
                "stop_terms": sorted(_STOP_TERMS), "stop_latin": sorted(_STOP_LATIN),
                "scope": "只统计本报告证据关联的所选原始材料，不推断材料库外的行为。",
            },
            "runtime": {"R": capability["r_version"], "ggplot2": capability["ggplot2_version"]},
            "output": {"dpi": 300, "width_inches": 8, "height_inches": 4.5,
                       "device": "quartz" if sys.platform == "darwin" else "cairo"},
            "command": ["Rscript", "--vanilla", "report_charts.R", ".", mode],
            "files": assets,
        }
        (stage / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        assets.append({
            "name": "manifest.json", "title": ASSET_TYPES["manifest.json"][0],
            "sha256": _sha(stage / "manifest.json"), "mime_type": "application/json",
            "kind": "manifest",
        })
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Only complete output is moved into the workspace; originals stay untouched.
        staged_directory = Path(tempfile.mkdtemp(prefix=".charts-", dir=destination.parent))
        for path in stage.iterdir():
            shutil.copyfile(path, staged_directory / path.name)
        os.rename(staged_directory, destination)
    return {"assets": assets, "frequency_mode": mode,
            "source_ids": [item["id"] for item in sources], "missing_information": missing}
