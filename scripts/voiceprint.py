#!/usr/bin/env python3
"""Offline CAM++ registration/matching. No recording, VAD, download or upload."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "server"))

from lingxi.realtime.voiceprint import (  # noqa: E402
    CampPlusExtractor,
    VoiceprintError,
    enroll,
    load_profile,
    match,
    read_clip,
    save_profile,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="本机声纹登记与比对。只接受已裁剪的单人语音；不检测静音或重叠说话。",
        epilog="声纹建议保存在系统应用数据目录，如 macOS 的 "
        "~/Library/Application Support/LingxiBridge/voiceprints/me.json；"
        "--profile 需展开为绝对路径。不要放入 Git、Obsidian 或资料工作区。",
    )
    parser.add_argument("action", choices=["enroll", "match"])
    parser.add_argument("--model", required=True, type=Path, help="本机 CAM++ ONNX 绝对路径")
    parser.add_argument("--profile", required=True, type=Path, help="私有声纹 JSON 绝对路径")
    parser.add_argument("--trimmed-speech", action="store_true", help="确认已裁剪为清晰单人语音")
    parser.add_argument("--threshold", type=float, help="比对必填；相似度阈值，不是概率")
    parser.add_argument("audio", nargs="+", type=Path, help="16 kHz 单声道 16-bit PCM WAV")
    args = parser.parse_args()
    try:
        profile_path = args.profile.resolve()
        if not args.profile.is_absolute() or ROOT == profile_path or ROOT in profile_path.parents:
            raise VoiceprintError("请将 --profile 指向项目外的应用私有绝对路径。")
        if not args.trimmed_speech:
            raise VoiceprintError("请先裁剪单人有效语音，再加 --trimmed-speech；本模块没有 VAD。")
        if args.action == "match" and (len(args.audio) != 1 or args.threshold is None):
            raise VoiceprintError("比对只接受一段音频，并须指定 --threshold。")
        if args.action == "enroll" and not 3 <= len(args.audio) <= 20:
            raise VoiceprintError("登记需要 3 至 20 段不同的单人语音。")
        if args.action == "enroll" and args.profile.exists():
            raise VoiceprintError("声纹文件已存在，请另选文件；不会覆盖已有登记。")
        clips = [read_clip(path) for path in args.audio]
        extractor = CampPlusExtractor(args.model)
        if args.action == "enroll":
            profile = enroll(extractor, clips, pretrimmed_speech=True)
            save_profile(args.profile, profile)
            result = {
                "status": "registered",
                "samples": len(clips),
                "submitted_speech_seconds": sum(clip.seconds for clip in clips),
            }
        else:
            profile = load_profile(args.profile, extractor.model_sha256)
            result = match(
                profile, extractor.compute(clips[0]), extractor.model_sha256, args.threshold
            )
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except VoiceprintError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
