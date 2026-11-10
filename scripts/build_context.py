#!/usr/bin/env python3
"""Build a source-linked Markdown context bundle for one analysis object."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def parse_frontmatter(path: Path) -> dict[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    try:
        end = lines.index("---", 1)
    except ValueError:
        return {}
    data: dict[str, str] = {}
    for line in lines[1:end]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"\'')
    return data


def record_kind(path: Path, data: dict[str, str]) -> str:
    kind = data.get("type", "unknown")
    if kind == "person":
        return "对象"
    if kind == "evidence":
        return "材料"
    if kind == "event":
        return "事件"
    if kind == "report":
        return "报告"
    return path.parent.name or kind


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--object", required=True, help="对象记录的 id")
    parser.add_argument("--question", default="", help="本次分析问题")
    parser.add_argument("--output", type=Path, help="可选：把上下文写入本地 Markdown 文件")
    args = parser.parse_args()

    vault = args.vault.expanduser().resolve()
    if not vault.is_dir():
        print(f"ERROR: vault 不存在：{vault}", file=sys.stderr)
        return 1

    records: list[tuple[Path, dict[str, str]]] = []
    for path in sorted(vault.rglob("*.md")):
        data = parse_frontmatter(path)
        if data:
            records.append((path, data))

    object_records = [(path, data) for path, data in records if data.get("id") == args.object]
    if not object_records:
        print(f"ERROR: 未找到对象 id={args.object}", file=sys.stderr)
        return 1
    object_path, object_data = object_records[0]
    if object_data.get("type") != "person":
        print(f"ERROR: id={args.object} 不是 person 记录", file=sys.stderr)
        return 1

    related = [(object_path, object_data)]
    for path, data in records:
        if path == object_path:
            continue
        if data.get("object") == args.object:
            related.append((path, data))

    order = {"对象": 0, "材料": 1, "事件": 2, "报告": 3}
    related.sort(key=lambda item: (order.get(record_kind(*item), 9), str(item[0])))

    parts = [
        "# 灵犀桥分析上下文包",
        "",
        f"- 对象 ID：`{args.object}`",
        f"- 对象名称：{object_data.get('display_name', '<未填写>')}",
        f"- 对象笔记：`{object_path.relative_to(vault)}`",
        f"- 本次问题：{args.question or object_data.get('analysis_scope', '<请先明确问题>')}",
        "",
        (
            "> 使用规则：只把下列材料作为有限证据。请区分观察、用户转述、可能解释、"
            "替代解释和未知信息；不要做诊断、测谎、动机断言或高风险决策。"
        ),
        "",
    ]
    for path, data in related:
        kind = record_kind(path, data)
        parts.extend(
            [
                f"## {kind}：{path.stem}",
                f"来源文件：`{path.relative_to(vault)}`",
                "",
                path.read_text(encoding="utf-8").strip(),
                "",
                "---",
                "",
            ]
        )

    output = "\n".join(parts).rstrip() + "\n"
    if args.output:
        target = args.output.expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(output, encoding="utf-8")
        print(f"WROTE: {target}")
    else:
        print(output, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
