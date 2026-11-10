#!/usr/bin/env python3
"""Archive an explicitly selected mobile export into a portable inbox."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "server"))
from lingxi.mobile.archive import MAX_BYTES, archive, render, validate  # noqa: E402,F401


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--inbox", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(archive(args.input, args.inbox), ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError, OverflowError) as exc:
        parser.exit(1, f"归档失败：{exc}\n")


if __name__ == "__main__":
    main()
