"""Local, offline speaker matching for explicitly supplied, pre-trimmed WAV clips.

This module does not detect speech, separate speakers, record a microphone, or
learn from matches. Clip duration is not a measurement of valid speech duration.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import math
import os
import re
import sys
import tempfile
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RATE = 16_000
MIN_SECONDS = 1.5
MAX_SECONDS = 60
DIMENSION = 192
MODEL_FILENAME = "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
MODEL_SHA256 = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"


def default_model_path() -> Path:
    """Use an explicit override or the separately prepared application cache."""
    override = os.environ.get("LINGXI_VOICEPRINT_MODEL")
    if override:
        return Path(override).expanduser()
    cache = (
        (Path.home() / "Library" / "Caches")
        if sys.platform == "darwin"
        else Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
    )
    return cache / "LingxiBridge" / "models" / MODEL_FILENAME


class VoiceprintError(ValueError):
    """A configuration or input error safe to show without audio contents."""


@dataclass(frozen=True)
class Clip:
    samples: array
    seconds: float
    pcm_sha256: str


def unit(vector: Any) -> list[float]:
    try:
        values = [float(value) for value in vector]
    except (TypeError, ValueError, OverflowError) as exc:
        raise VoiceprintError("声纹向量格式错误。") from exc
    if len(values) != DIMENSION or not all(math.isfinite(value) for value in values):
        raise VoiceprintError("需要有限数值组成的 192 维 CAM++ 声纹。")
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(norm) or norm <= 1e-12:
        raise VoiceprintError("声纹为空或无效。")
    return [value / norm for value in values]


def read_clip(path: Path) -> Clip:
    try:
        with wave.open(str(path), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, RATE):
                raise VoiceprintError("音频必须是 16 kHz、单声道、16-bit PCM WAV。")
            frames = wav.getnframes()
            if not MIN_SECONDS * RATE <= frames <= MAX_SECONDS * RATE:
                raise VoiceprintError("每段音频需为 1.5 至 60 秒，请先裁剪单人有效语音。")
            pcm = wav.readframes(frames)
            if len(pcm) != frames * 2:
                raise VoiceprintError("WAV 文件不完整。")
    except (OSError, EOFError, wave.Error) as exc:
        raise VoiceprintError("无法读取 PCM WAV 文件。") from exc
    values = array("h")
    values.frombytes(pcm)
    if sys.byteorder != "little":
        values.byteswap()
    if not any(values):
        raise VoiceprintError("音频只有数字静音，无法提取声纹。")
    return Clip(values, frames / RATE, hashlib.sha256(pcm).hexdigest())


class CampPlusExtractor:
    """Load a user-supplied CAM++ ONNX model; never download or send data."""

    def __init__(self, model: Path | None = None):
        model = model if model is not None else default_model_path()
        if not model.is_absolute() or not model.is_file():
            raise VoiceprintError("请提供本机 CAM++ ONNX 模型的绝对文件路径。")
        try:
            with model.open("rb") as stream:
                self.model_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
            sherpa = importlib.import_module("sherpa_onnx")
            self.numpy = importlib.import_module("numpy")
        except ImportError as exc:
            raise VoiceprintError("未安装本地语音依赖，请安装 requirements-voice.txt。") from exc
        except OSError as exc:
            raise VoiceprintError("无法读取声纹模型。") from exc
        try:
            config = sherpa.SpeakerEmbeddingExtractorConfig(
                model=str(model), num_threads=2, debug=False, provider="cpu"
            )
            if not config.validate():
                raise VoiceprintError("声纹模型配置无效。")
            self.extractor = sherpa.SpeakerEmbeddingExtractor(config)
            if self.extractor.dim != DIMENSION:
                raise VoiceprintError("仅支持输出 192 维向量的 CAM++ 模型。")
            with model.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != self.model_sha256:
                    raise VoiceprintError("模型在加载期间发生变化，请重试。")
        except VoiceprintError:
            raise
        except Exception as exc:
            raise VoiceprintError("本地声纹模型加载失败，请检查模型与运行库版本。") from exc

    def compute(self, clip: Clip) -> list[float]:
        try:
            samples = self.numpy.asarray(clip.samples, dtype=self.numpy.float32) / 32768.0
            stream = self.extractor.create_stream()
            stream.accept_waveform(sample_rate=RATE, waveform=samples)
            stream.input_finished()
            if not self.extractor.is_ready(stream):
                raise VoiceprintError("当前片段不足以提取声纹。")
            return unit(self.extractor.compute(stream))
        except VoiceprintError:
            raise
        except Exception as exc:
            raise VoiceprintError("本地声纹提取失败。") from exc


def validate_profile(profile: Any, model_sha256: str) -> dict[str, Any]:
    if not isinstance(profile, dict) or profile.get("version") != 1:
        raise VoiceprintError("声纹文件版本不受支持。")
    if profile.get("model_sha256") != model_sha256:
        raise VoiceprintError("模型与登记时不同，请使用原模型或重新登记。")
    if profile.get("dimension") != DIMENSION or profile.get("pretrimmed_speech") is not True:
        raise VoiceprintError("声纹文件元数据无效。")
    samples = profile.get("samples")
    if not isinstance(samples, list) or not 3 <= len(samples) <= 20:
        raise VoiceprintError("至少需要 3 个登记样本。")
    hashes: set[str] = set()
    total = 0.0
    for sample in samples:
        if not isinstance(sample, dict):
            raise VoiceprintError("声纹样本格式错误。")
        seconds = sample.get("seconds")
        digest = sample.get("pcm_sha256")
        if (
            isinstance(seconds, bool)
            or not isinstance(seconds, (int, float))
            or not math.isfinite(seconds)
            or not MIN_SECONDS <= seconds <= MAX_SECONDS
        ):
            raise VoiceprintError("声纹样本时长无效。")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise VoiceprintError("声纹样本校验值无效。")
        if digest in hashes:
            raise VoiceprintError("不能重复使用同一段音频登记。")
        hashes.add(digest)
        total += seconds
        unit(sample.get("embedding"))
    if total < 30:
        raise VoiceprintError("登记样本累计需至少 30 秒，且须由你预先裁剪为单人有效语音。")
    return profile


def enroll(extractor: CampPlusExtractor, clips: list[Clip], *, pretrimmed_speech: bool) -> dict:
    if not pretrimmed_speech:
        raise VoiceprintError("请先裁剪单人有效语音并明确确认；本模块不执行 VAD。")
    # Validate duration and duplication before expensive inference.
    profile = {
        "version": 1,
        "model_sha256": extractor.model_sha256,
        "dimension": DIMENSION,
        "pretrimmed_speech": True,
        "samples": [
            {
                "seconds": clip.seconds,
                "pcm_sha256": clip.pcm_sha256,
                "embedding": [1.0] + [0.0] * (DIMENSION - 1),
            }
            for clip in clips
        ],
    }
    validate_profile(profile, extractor.model_sha256)
    for sample, clip in zip(profile["samples"], clips, strict=True):
        sample["embedding"] = unit(extractor.compute(clip))
    return profile


def match(profile: dict, vector: list[float], model_sha256: str, threshold: float) -> dict:
    if not math.isfinite(threshold) or not 0 < threshold <= 1:
        raise VoiceprintError("匹配阈值须大于 0 且不超过 1。")
    validate_profile(profile, model_sha256)
    candidate = unit(vector)
    scores = sorted(
        (
            sum(a * b for a, b in zip(candidate, unit(sample["embedding"]), strict=True))
            for sample in profile["samples"]
        ),
        reverse=True,
    )
    score = max(-1.0, min(1.0, sum(scores[:3]) / 3))
    return {
        "speaker": "me" if score >= threshold else "unknown",
        "similarity": score,
        "threshold": threshold,
    }


def load_profile(path: Path, model_sha256: str) -> dict:
    try:
        if path.stat().st_size > 1_048_576:
            raise VoiceprintError("声纹文件超过大小限制。")
        return validate_profile(json.loads(path.read_text(encoding="utf-8")), model_sha256)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VoiceprintError("无法读取声纹文件。") from exc


def save_profile(path: Path, profile: dict) -> None:
    if not path.is_absolute():
        raise VoiceprintError("声纹保存位置必须是应用私有目录中的绝对路径。")
    validate_profile(profile, profile.get("model_sha256", ""))
    if not re.fullmatch(r"[0-9a-f]{64}", profile.get("model_sha256", "")):
        raise VoiceprintError("模型校验值无效。")
    resolved = path.resolve()
    if any((parent / "workspace.json").exists() for parent in resolved.parents):
        raise VoiceprintError("声纹不得保存在开放工作区，请使用应用私有目录。")
    if any((parent / ".git").exists() for parent in resolved.parents):
        raise VoiceprintError("声纹不得保存在 Git 仓库，请使用应用私有目录。")
    temporary: str | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=".voiceprint-", dir=path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(profile, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        # Link is an atomic create-if-absent; never overwrite an existing profile.
        os.link(temporary, path)
    except FileExistsError as exc:
        raise VoiceprintError("声纹文件已存在，请另选文件；不会覆盖已有登记。") from exc
    except OSError as exc:
        raise VoiceprintError("无法保存声纹文件。") from exc
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)
