"""Offline speech recognition. Model installation is a separate explicit command."""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

MODEL = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
ENGINE = "sherpa-onnx/SenseVoiceSmall-int8"
MAX_BYTES = 64 * 1024 * 1024
MAX_DURATION_SECONDS = 1800
RATE = 16000


class LocalSpeechError(ValueError):
    def __init__(self, message: str, code: str = "local_speech_invalid", status: int = 422):
        super().__init__(message)
        self.code, self.status = code, status


def model_dir() -> Path:
    override = os.environ.get("LINGXI_LOCAL_SPEECH_MODEL_DIR")
    if override:
        return Path(override).expanduser()
    cache = (
        Path.home() / "Library/Caches"
        if sys.platform == "darwin"
        else Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    )
    return cache / "lingxi-bridge/models" / MODEL


class LocalSpeech:
    def __init__(self):
        self._lock = threading.Lock()
        self._recognizer = None
        self._loaded_directory: Path | None = None

    def status(self) -> dict:
        directory = model_dir()
        missing = []
        for module in ("sherpa_onnx", "numpy"):
            if importlib.util.find_spec(module) is None:
                missing.append(module)
        if shutil.which("ffmpeg") is None:
            missing.append("ffmpeg")
        for filename in ("model.int8.onnx", "tokens.txt"):
            if not (directory / filename).is_file():
                missing.append(filename)
        return dict(
            ready=not missing,
            engine=ENGINE,
            model=MODEL,
            local_only=True,
            missing=missing,
            max_bytes=MAX_BYTES,
            max_duration_seconds=MAX_DURATION_SECONDS,
        )

    def _load(self):
        directory = model_dir().resolve()
        if self._recognizer is None or directory != self._loaded_directory:
            import sherpa_onnx

            self._recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(directory / "model.int8.onnx"),
                tokens=str(directory / "tokens.txt"),
                num_threads=4,
                use_itn=True,
                language="auto",
                provider="cpu",
                debug=False,
            )
            self._loaded_directory = directory
        return self._recognizer

    def transcribe(self, audio: Path) -> dict:
        if not self._lock.acquire(blocking=False):
            raise LocalSpeechError("本机正在转写另一段音频，请稍后重试。", "local_speech_busy", 409)
        started = time.monotonic()
        try:
            if not self.status()["ready"]:
                raise LocalSpeechError(
                    "请先安装本机语音运行库和模型。", "local_speech_unavailable", 503
                )
            if not audio.is_file() or not 0 < audio.stat().st_size <= MAX_BYTES:
                raise LocalSpeechError("音频不能为空，且不能超过64MB。")
            with tempfile.TemporaryDirectory(prefix="lingxi-speech-") as temporary:
                wav_path = Path(temporary) / "audio.wav"
                try:
                    subprocess.run(
                        [
                            shutil.which("ffmpeg"),
                            "-nostdin",
                            "-hide_banner",
                            "-loglevel",
                            "error",
                            "-protocol_whitelist",
                            "file,pipe",
                            "-format_whitelist",
                            "wav,matroska,webm,mov,mp3,aac,ogg,flac,aiff",
                            "-i",
                            str(audio),
                            "-map",
                            "0:a:0",
                            "-vn",
                            "-t",
                            str(MAX_DURATION_SECONDS + 1),
                            "-ac",
                            "1",
                            "-ar",
                            str(RATE),
                            "-c:a",
                            "pcm_s16le",
                            str(wav_path),
                        ],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=120,
                        check=True,
                    )
                except (subprocess.SubprocessError, OSError) as exc:
                    raise LocalSpeechError(
                        "无法读取这段音频，请使用有效的WAV、WebM或常见音频文件。"
                    ) from exc
                import numpy as np

                with wave.open(str(wav_path), "rb") as wav:
                    duration = wav.getnframes() / RATE
                    if not 0 < duration <= MAX_DURATION_SECONDS:
                        raise LocalSpeechError("音频需大于0秒且不超过30分钟，请先分段。")
                    recognizer = self._load()
                    texts = []
                    # Bound each model invocation's memory, including long recordings.
                    while pcm := wav.readframes(RATE * 30):
                        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
                        if not np.any(samples):
                            continue
                        stream = recognizer.create_stream()
                        stream.accept_waveform(RATE, samples)
                        recognizer.decode_stream(stream)
                        text = re.sub(r"<\|[^|]*\|>", "", stream.result.text).strip()
                        if text:
                            texts.append(text)
                return dict(
                    text="".join(texts),
                    duration_seconds=round(duration, 3),
                    elapsed_seconds=round(time.monotonic() - started, 3),
                    engine=ENGINE,
                    model=MODEL,
                    local_only=True,
                )
        except LocalSpeechError:
            raise
        except Exception as exc:
            raise LocalSpeechError(
                "本机转写失败，请检查模型与运行库是否完整。", "local_speech_failed", 503
            ) from exc
        finally:
            self._lock.release()


speech = LocalSpeech()
