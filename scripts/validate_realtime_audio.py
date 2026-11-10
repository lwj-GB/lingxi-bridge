#!/usr/bin/env python3
"""Repeatable local acceptance check for Lingxi Bridge realtime audio."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
import wave
from collections import Counter
from collections.abc import AsyncIterator, Iterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
import websockets

ROOT = Path(__file__).resolve().parents[1]
SERVER_ROOT = ROOT / "apps" / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

HOST = "127.0.0.1"
SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2
CHANNELS = 1
DEFAULT_CHUNK_MS = 200
DEFAULT_TIMEOUT_SECONDS = 45.0
REFERENCE_TEXT = "我希望先把问题说清楚，我们可以先确认下一步。"
MAX_NORMALIZED_CHARACTER_ERROR_RATE = 0.5


class ValidationFailure(RuntimeError):
    """An expected, user-actionable validation failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.details = details


class DoubaoStreamObservation:
    def __init__(self) -> None:
        self.first_text_at: float | None = None
        self.transcript_before_stop = False
        self.analysis_before_stop = False
        self.ready = asyncio.Event()

    def mark_ready(self) -> None:
        if self.transcript_before_stop and self.analysis_before_stop:
            self.ready.set()


def normalize_transcript(text: str) -> str:
    """Normalize harmless presentation differences before quality scoring."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return "".join(character for character in normalized if character.isalnum())


def _character_distance(reference: str, hypothesis: str) -> int:
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    previous = list(range(len(hypothesis) + 1))
    for row, reference_character in enumerate(reference, start=1):
        current = [row]
        for column, hypothesis_character in enumerate(hypothesis, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1]
                    + (reference_character != hypothesis_character),
                )
            )
        previous = current
    return previous[-1]


def transcript_quality(reference: str, transcript: str) -> dict[str, float | int]:
    normalized_reference = normalize_transcript(reference)
    normalized_transcript = normalize_transcript(transcript)
    if not normalized_reference:
        raise ValueError("reference transcript must not be empty")
    distance = _character_distance(normalized_reference, normalized_transcript)
    error_rate = distance / len(normalized_reference)
    return {
        "normalized_reference_characters": len(normalized_reference),
        "normalized_transcript_characters": len(normalized_transcript),
        "character_distance": distance,
        "normalized_character_error_rate": round(error_rate, 4),
        "normalized_similarity": round(max(0.0, 1.0 - error_rate), 4),
    }


def build_say_command(
    executable: str,
    *,
    voice: str,
    output_path: Path,
    text: str,
) -> list[str]:
    return [executable, "-v", voice, "-o", str(output_path), text]


def build_afconvert_command(
    executable: str,
    *,
    input_path: Path,
    output_path: Path,
) -> list[str]:
    return [
        executable,
        str(input_path),
        str(output_path),
        "-f",
        "WAVE",
        "-d",
        f"LEI16@{SAMPLE_RATE}",
        "-c",
        str(CHANNELS),
    ]


def select_mandarin_voice(voice_listing: str) -> str:
    """Prefer the stable Tingting voice, otherwise use the first zh_CN voice."""
    candidates: list[str] = []
    for line in voice_listing.splitlines():
        prefix, separator, _example = line.partition("#")
        if not separator or "zh_CN" not in prefix:
            continue
        voice = prefix.split("zh_CN", maxsplit=1)[0].rstrip()
        if not voice:
            continue
        candidates.append(voice)
        if voice == "Tingting":
            return voice
    if candidates:
        return candidates[0]
    raise ValidationFailure(
        "mandarin_voice_unavailable",
        "macOS 没有可用的中文（中国大陆）系统语音，请先安装一个中文语音。",
    )


def iter_pcm_chunks(
    pcm: bytes,
    *,
    chunk_ms: int = DEFAULT_CHUNK_MS,
) -> Iterator[bytes]:
    if chunk_ms <= 0:
        raise ValueError("chunk_ms must be positive")
    bytes_per_chunk = SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS * chunk_ms // 1000
    if bytes_per_chunk <= 0:
        raise ValueError("chunk_ms is too small")
    for offset in range(0, len(pcm), bytes_per_chunk):
        chunk = pcm[offset : offset + bytes_per_chunk]
        if chunk:
            yield chunk


def _run_command(command: Sequence[str]) -> str:
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValidationFailure(
            "audio_generation_failed",
            f"{Path(command[0]).name} 未能生成验收音频。",
        ) from exc
    return completed.stdout


def _read_pcm_wave(path: Path) -> bytes:
    try:
        with wave.open(str(path), "rb") as audio:
            properties = (
                audio.getnchannels(),
                audio.getsampwidth(),
                audio.getframerate(),
                audio.getcomptype(),
            )
            expected = (CHANNELS, SAMPLE_WIDTH, SAMPLE_RATE, "NONE")
            if properties != expected:
                raise ValidationFailure(
                    "audio_format_invalid",
                    "生成的音频不是 16 kHz、16-bit、单声道 PCM。",
                )
            pcm = audio.readframes(audio.getnframes())
    except (EOFError, OSError, wave.Error) as exc:
        raise ValidationFailure(
            "audio_format_invalid",
            "无法读取生成的 PCM 验收音频。",
        ) from exc
    if not pcm:
        raise ValidationFailure("audio_empty", "生成的 PCM 验收音频为空。")
    return pcm


def synthesize_mandarin_pcm(
    *,
    say_path: str,
    afconvert_path: str,
    voice: str,
    text: str = REFERENCE_TEXT,
) -> bytes:
    """Generate raw PCM in a temporary directory that is always removed."""
    with tempfile.TemporaryDirectory(prefix="lingxi-realtime-audio-") as directory:
        temporary_root = Path(directory)
        source_path = temporary_root / "source.aiff"
        wave_path = temporary_root / "converted.wav"
        _run_command(
            build_say_command(
                say_path,
                voice=voice,
                output_path=source_path,
                text=text,
            )
        )
        _run_command(
            build_afconvert_command(
                afconvert_path,
                input_path=source_path,
                output_path=wave_path,
            )
        )
        return _read_pcm_wave(wave_path)


def _doubao_preflight() -> tuple[str, str, str]:
    if platform.system() != "Darwin":
        raise ValidationFailure(
            "macos_required",
            "豆包自测需要 macOS 的 say 与 afconvert。",
        )

    api_key = os.getenv("LINGXI_DOUBAO_API_KEY")
    app_key = os.getenv("LINGXI_DOUBAO_APP_KEY")
    access_key = os.getenv("LINGXI_DOUBAO_ACCESS_KEY")
    if not api_key and not app_key and not access_key:
        raise ValidationFailure(
            "doubao_not_configured",
            "尚未配置豆包凭据；请配置环境变量后重试。",
        )
    if not api_key and (not app_key or not access_key):
        raise ValidationFailure(
            "doubao_configuration_invalid",
            "旧版豆包鉴权需要同时配置 APP_KEY 与 ACCESS_KEY 环境变量。",
        )

    say_path = shutil.which("say")
    afconvert_path = shutil.which("afconvert")
    if say_path is None or afconvert_path is None:
        missing = "say" if say_path is None else "afconvert"
        raise ValidationFailure(
            "system_command_missing",
            f"缺少 macOS 系统命令 {missing}。",
        )
    voice_listing = _run_command([say_path, "-v", "?"])
    return say_path, afconvert_path, select_mandarin_voice(voice_listing)


@asynccontextmanager
async def local_realtime_server() -> AsyncIterator[str]:
    """Run the project FastAPI app on an OS-assigned loopback port."""
    from lingxi.main import create_app

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((HOST, 0))
    port = int(listener.getsockname()[1])
    config = uvicorn.Config(
        create_app(),
        host=HOST,
        port=port,
        access_log=False,
        log_level="critical",
        lifespan="on",
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        deadline = time.monotonic() + 5
        while not server.started:
            if task.done():
                raise ValidationFailure(
                    "local_service_start_failed",
                    "本地实时服务启动失败。",
                )
            if time.monotonic() >= deadline:
                raise ValidationFailure(
                    "local_service_start_timeout",
                    "本地实时服务启动超时。",
                )
            await asyncio.sleep(0.02)
        yield f"ws://{HOST}:{port}/api/live"
    finally:
        server.should_exit = True
        if not task.done():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(task, timeout=5)
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        with contextlib.suppress(OSError):
            listener.close()


def _decode_event(message: Any) -> dict[str, Any]:
    if not isinstance(message, str):
        raise ValidationFailure(
            "invalid_service_event",
            "本地实时服务返回了非 JSON 事件。",
        )
    try:
        event = json.loads(message)
    except json.JSONDecodeError as exc:
        raise ValidationFailure(
            "invalid_service_event",
            "本地实时服务返回了无效 JSON。",
        ) from exc
    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        raise ValidationFailure(
            "invalid_service_event",
            "本地实时服务返回的事件格式无效。",
        )
    if event["type"] == "error":
        code = str(event.get("code") or "service_error")
        message = str(event.get("message") or "实时服务返回错误。")
        raise ValidationFailure(code, message)
    return event


async def _receive_event(
    websocket: Any,
    *,
    deadline: float,
) -> dict[str, Any]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValidationFailure("session_timeout", "实时验收超时。")
    try:
        message = await asyncio.wait_for(websocket.recv(), timeout=remaining)
    except TimeoutError as exc:
        raise ValidationFailure("session_timeout", "实时验收超时。") from exc
    except websockets.ConnectionClosed as exc:
        raise ValidationFailure(
            "service_connection_closed",
            "本地实时服务在验收结束前关闭了连接。",
        ) from exc
    return _decode_event(message)


async def validate_demo(
    websocket_url: str,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    started_at = time.monotonic()
    deadline = started_at + timeout_seconds
    event_counts: Counter[str] = Counter()
    first_text_at: float | None = None
    started_event: dict[str, Any] | None = None
    ended_event: dict[str, Any] | None = None

    try:
        async with websockets.connect(
            websocket_url,
            origin="http://127.0.0.1",
            open_timeout=5,
            close_timeout=2,
        ) as websocket:
            await websocket.send(
                json.dumps(
                    {
                        "type": "start",
                        "recognizer": "demo",
                        "consent": True,
                        "default_speaker": "other",
                    },
                    separators=(",", ":"),
                )
            )
            while ended_event is None:
                event = await _receive_event(websocket, deadline=deadline)
                event_counts[event["type"]] += 1
                if event["type"] == "started":
                    started_event = event
                elif event["type"] == "transcript_delta" and first_text_at is None:
                    first_text_at = time.monotonic()
                elif event["type"] == "ended":
                    ended_event = event
    except ValidationFailure:
        raise
    except (OSError, websockets.WebSocketException) as exc:
        raise ValidationFailure(
            "local_service_connection_failed",
            "无法连接本地实时服务。",
        ) from exc

    if (
        started_event is None
        or started_event.get("recognizer") != "demo"
        or started_event.get("data_destination") != "local_only"
        or started_event.get("audio_saved") is not False
    ):
        raise ValidationFailure(
            "demo_start_invalid",
            "本地演示没有返回预期的隐私与识别状态。",
        )
    if first_text_at is None or event_counts["analysis_snapshot"] == 0:
        raise ValidationFailure(
            "demo_stream_incomplete",
            "本地演示没有同时产生转写与分析流。",
        )
    transcript = str(ended_event.get("transcript") or "")
    if not transcript:
        raise ValidationFailure(
            "demo_transcript_empty",
            "本地演示结束时没有最终转写。",
        )
    finished_at = time.monotonic()
    return {
        "ok": True,
        "mode": "demo",
        "audio_saved": False,
        "transcript": transcript,
        "analysis_count": int(ended_event.get("analysis_count") or 0),
        "event_counts": dict(sorted(event_counts.items())),
        "metrics": {
            "first_text_latency_ms": round((first_text_at - started_at) * 1000),
            "completion_latency_ms": round((finished_at - started_at) * 1000),
        },
    }


async def _await_doubao_started(
    websocket: Any,
    *,
    deadline: float,
    event_counts: Counter[str],
) -> None:
    while True:
        event = await _receive_event(websocket, deadline=deadline)
        event_counts[event["type"]] += 1
        if event["type"] == "started":
            if (
                event.get("recognizer") != "doubao"
                or event.get("data_destination") != "volcengine_doubao"
                or event.get("audio_saved") is not False
            ):
                raise ValidationFailure(
                    "doubao_start_invalid",
                    "豆包会话没有返回预期的识别与隐私状态。",
                )
            return


async def _collect_doubao_events(
    websocket: Any,
    *,
    deadline: float,
    event_counts: Counter[str],
    stop_sent: asyncio.Event,
    observation: DoubaoStreamObservation,
) -> dict[str, Any]:
    while True:
        event = await _receive_event(websocket, deadline=deadline)
        event_counts[event["type"]] += 1
        if event["type"] == "transcript_delta":
            has_text = any(
                str(event.get(field) or "").strip()
                for field in ("text", "committed_text", "interim_text")
            )
            if has_text and observation.first_text_at is None:
                observation.first_text_at = time.monotonic()
            if has_text and not stop_sent.is_set():
                observation.transcript_before_stop = True
                observation.mark_ready()
        elif event["type"] == "analysis_snapshot" and not stop_sent.is_set():
            observation.analysis_before_stop = True
            observation.mark_ready()
        if event["type"] == "ended":
            if observation.first_text_at is None:
                raise ValidationFailure(
                    "doubao_transcript_empty",
                    "豆包会话结束时没有返回转写文本。",
                )
            transcript = str(event.get("transcript") or "")
            if not transcript:
                raise ValidationFailure(
                    "doubao_transcript_empty",
                    "豆包会话结束时没有最终转写。",
                )
            return event


def _pre_stop_failure(
    observation: DoubaoStreamObservation,
    event_counts: Counter[str],
) -> ValidationFailure:
    if not observation.transcript_before_stop and not observation.analysis_before_stop:
        code = "doubao_stream_missing_before_stop"
        message = "停止前没有观察到实时转写和分析结果。"
    elif not observation.transcript_before_stop:
        code = "doubao_transcript_missing_before_stop"
        message = "停止前没有观察到实时转写。"
    else:
        code = "doubao_analysis_missing_before_stop"
        message = "停止前没有观察到实时分析结果。"
    return ValidationFailure(
        code,
        message,
        details={
            "transcript_before_stop": observation.transcript_before_stop,
            "analysis_snapshot_before_stop": observation.analysis_before_stop,
            "event_counts": dict(sorted(event_counts.items())),
        },
    )


async def _await_pre_stop_stream(
    collector: asyncio.Task[dict[str, Any]],
    *,
    deadline: float,
    observation: DoubaoStreamObservation,
    event_counts: Counter[str],
) -> None:
    while not observation.ready.is_set():
        if time.monotonic() >= deadline:
            raise _pre_stop_failure(observation, event_counts)
        if collector.done():
            await collector
            raise ValidationFailure(
                "doubao_ended_early",
                "豆包会话在停止事件发送前结束。",
            )
        try:
            await asyncio.wait_for(observation.ready.wait(), timeout=0.05)
        except TimeoutError:
            continue


async def validate_doubao(
    websocket_url: str,
    *,
    pcm: bytes,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    chunk_ms: int = DEFAULT_CHUNK_MS,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    event_counts: Counter[str] = Counter()
    chunks = list(iter_pcm_chunks(pcm, chunk_ms=chunk_ms))
    if not chunks:
        raise ValidationFailure("audio_empty", "PCM 验收音频为空。")
    observation = DoubaoStreamObservation()
    stop_sent = asyncio.Event()

    try:
        async with websockets.connect(
            websocket_url,
            origin="http://127.0.0.1",
            open_timeout=5,
            close_timeout=2,
            max_size=8 * 1024 * 1024,
        ) as websocket:
            await websocket.send(
                json.dumps(
                    {
                        "type": "start",
                        "recognizer": "doubao",
                        "consent": True,
                        "default_speaker": "other",
                    },
                    separators=(",", ":"),
                )
            )
            await _await_doubao_started(
                websocket,
                deadline=deadline,
                event_counts=event_counts,
            )
            audio_started_at = time.monotonic()
            collector = asyncio.create_task(
                _collect_doubao_events(
                    websocket,
                    deadline=deadline,
                    event_counts=event_counts,
                    stop_sent=stop_sent,
                    observation=observation,
                )
            )
            try:
                scheduled_at = audio_started_at
                for chunk in chunks:
                    if collector.done():
                        await collector
                        raise ValidationFailure(
                            "doubao_ended_early",
                            "豆包会话在音频发送完成前结束。",
                        )
                    await websocket.send(chunk)
                    scheduled_at += len(chunk) / (
                        SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS
                    )
                    delay = scheduled_at - time.monotonic()
                    if delay > 0:
                        await asyncio.sleep(delay)
                await _await_pre_stop_stream(
                    collector,
                    deadline=deadline,
                    observation=observation,
                    event_counts=event_counts,
                )
                stop_sent_at = time.monotonic()
                stop_sent.set()
                await websocket.send('{"type":"stop"}')
                ended_event = await collector
            finally:
                if not collector.done():
                    collector.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await collector
                else:
                    with contextlib.suppress(Exception):
                        collector.result()
    except ValidationFailure:
        raise
    except (OSError, websockets.WebSocketException) as exc:
        raise ValidationFailure(
            "doubao_session_failed",
            "豆包实时验收连接失败。",
        ) from exc

    finished_at = time.monotonic()
    transcript = str(ended_event["transcript"])
    quality = transcript_quality(REFERENCE_TEXT, transcript)
    if (
        quality["normalized_character_error_rate"]
        > MAX_NORMALIZED_CHARACTER_ERROR_RATE
    ):
        raise ValidationFailure(
            "doubao_transcript_quality_below_threshold",
            "豆包转写与固定虚构参考文本差异过大。",
            details={
                **quality,
                "maximum_normalized_character_error_rate": (
                    MAX_NORMALIZED_CHARACTER_ERROR_RATE
                ),
            },
        )
    duration_ms = round(
        len(pcm) / (SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS) * 1000
    )
    return {
        "ok": True,
        "mode": "doubao",
        "audio_saved": False,
        "reference_text": REFERENCE_TEXT,
        "transcript": transcript,
        "analysis_count": int(ended_event.get("analysis_count") or 0),
        "event_counts": dict(sorted(event_counts.items())),
        "stream_evidence": {
            "transcript_before_stop": observation.transcript_before_stop,
            "analysis_snapshot_before_stop": observation.analysis_before_stop,
        },
        "audio": {
            "sample_rate_hz": SAMPLE_RATE,
            "sample_width_bits": SAMPLE_WIDTH * 8,
            "channels": CHANNELS,
            "duration_ms": duration_ms,
            "chunk_ms": chunk_ms,
            "chunk_count": len(chunks),
            "generated_with": "macOS say + afconvert",
        },
        "metrics": {
            "first_text_latency_ms": round(
                (observation.first_text_at - audio_started_at) * 1000
            ),
            "completion_latency_ms": round((finished_at - audio_started_at) * 1000),
            "finalization_latency_ms": round((finished_at - stop_sent_at) * 1000),
            **quality,
            "maximum_normalized_character_error_rate": (
                MAX_NORMALIZED_CHARACTER_ERROR_RATE
            ),
        },
    }


async def run_validation(
    mode: str,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    pcm: bytes | None = None
    if mode == "doubao":
        say_path, afconvert_path, voice = _doubao_preflight()
        pcm = synthesize_mandarin_pcm(
            say_path=say_path,
            afconvert_path=afconvert_path,
            voice=voice,
        )
    async with local_realtime_server() as websocket_url:
        if mode == "demo":
            return await validate_demo(
                websocket_url,
                timeout_seconds=timeout_seconds,
            )
        if mode == "doubao" and pcm is not None:
            return await validate_doubao(
                websocket_url,
                pcm=pcm,
                timeout_seconds=timeout_seconds,
            )
    raise ValidationFailure("invalid_mode", "未知的实时验收模式。")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="启动临时本地服务并验收实时转写与分析流。",
    )
    parser.add_argument("mode", choices=("demo", "doubao"))
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="整次会话超时秒数（默认 45）。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.timeout <= 0:
        result = {
            "ok": False,
            "mode": arguments.mode,
            "error": {
                "code": "invalid_timeout",
                "message": "超时必须大于零秒。",
            },
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 1
    try:
        result = asyncio.run(
            run_validation(
                arguments.mode,
                timeout_seconds=arguments.timeout,
            )
        )
    except ValidationFailure as exc:
        error: dict[str, Any] = {"code": exc.code, "message": str(exc)}
        if exc.details is not None:
            error["details"] = exc.details
        result = {
            "ok": False,
            "mode": arguments.mode,
            "error": error,
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 1
    except KeyboardInterrupt:
        result = {
            "ok": False,
            "mode": arguments.mode,
            "error": {
                "code": "interrupted",
                "message": "实时验收已中止。",
            },
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 130
    except Exception:
        result = {
            "ok": False,
            "mode": arguments.mode,
            "error": {
                "code": "unexpected_failure",
                "message": "实时验收发生未预期错误。",
            },
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
