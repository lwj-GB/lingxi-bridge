"""Explicit, ephemeral comparison of two user-selected, pre-trimmed clips."""

from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path
from threading import Lock

from fastapi import APIRouter, File, Form, Request, UploadFile
from starlette.concurrency import run_in_threadpool

from lingxi.api.errors import ApiError
from lingxi.api.mobile import _trusted_control
from lingxi.realtime.voiceprint import (
    CampPlusExtractor,
    VoiceprintError,
    default_model_path,
    read_clip,
)

router = APIRouter(prefix="/api/local-voiceprint", tags=["local-voiceprint"])
MAX_UPLOAD_BYTES = 2_000_000
# Keep only the model in memory. No uploaded audio or derived embeddings are cached.
_lock = Lock()
_extractor: CampPlusExtractor | None = None
_extractor_key: tuple | None = None


def _local(request: Request) -> None:
    _trusted_control(request)
    if request.client and request.client.host not in {
        "127.0.0.1",
        "::1",
        "localhost",
        "testclient",
    }:
        raise ApiError(403, "local_voiceprint_forbidden", "本机声纹只能由此电脑的工作台调用。")


def _model() -> CampPlusExtractor:
    global _extractor, _extractor_key
    path = default_model_path()
    try:
        stat = path.stat()
    except OSError as exc:
        raise VoiceprintError(
            "本机声纹模型尚未准备，请运行 scripts/prepare_voiceprint_model.py。"
        ) from exc
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    if _extractor is None or _extractor_key != key:
        _extractor = CampPlusExtractor(path)
        _extractor_key = key
    return _extractor


@router.get("/status")
def status(request: Request) -> dict:
    _local(request)
    dependencies = all(
        importlib.util.find_spec(name) is not None for name in ("sherpa_onnx", "numpy")
    )
    model_present = default_model_path().is_file()
    available = False
    error = None
    if dependencies and model_present:
        try:
            with _lock:
                _model()
            available = True
        except VoiceprintError as exc:
            error = str(exc)
    return {
        "available": available,
        "model_present": model_present,
        "dependencies_present": dependencies,
        "engine": "sherpa-onnx CAM++ CPU",
        "mode": "local_clip_comparison",
        "registered_self": False,
        "error": error,
        "note": "只比较明确选择的单人片段；未登记本人，不自动分段或识别人名。",
    }


def _compare(reference: bytes, candidate: bytes) -> dict:
    with tempfile.TemporaryDirectory(prefix="lingxi-voiceprint-") as directory:
        paths = [Path(directory) / name for name in ("reference.wav", "candidate.wav")]
        for path, content in zip(paths, (reference, candidate), strict=True):
            path.write_bytes(content)
            path.chmod(0o600)
        clips = [read_clip(path) for path in paths]
        with _lock:
            extractor = _model()
            vectors = [extractor.compute(clip) for clip in clips]
            similarity = max(-1.0, min(1.0, sum(a * b for a, b in zip(*vectors, strict=True))))
            return {
                "similarity": similarity,
                "model_sha256": extractor.model_sha256,
                "dimension": len(vectors[0]),
                "reference_seconds": clips[0].seconds,
                "candidate_seconds": clips[1].seconds,
                "processing": "local_cpu",
                "persisted": False,
                "note": "相似度不是概率，也不是本人身份确认；本次未登记或保存声纹。",
            }


@router.post("/compare")
async def compare(
    request: Request,
    reference: UploadFile = File(...),
    candidate: UploadFile = File(...),
    pretrimmed_speech: bool = Form(False),
) -> dict:
    try:
        _local(request)
        if not pretrimmed_speech:
            raise ApiError(
                422, "voiceprint_speech_confirmation_required", "请确认两段均已裁剪为单人有效语音。"
            )
        contents = []
        for upload in (reference, candidate):
            content = await upload.read(MAX_UPLOAD_BYTES + 1)
            if len(content) > MAX_UPLOAD_BYTES:
                raise ApiError(413, "voiceprint_audio_too_large", "每段WAV不能超过2MB或60秒。")
            contents.append(content)
        return await run_in_threadpool(_compare, *contents)
    except VoiceprintError as exc:
        raise ApiError(422, "local_voiceprint_unavailable", str(exc)) from exc
    finally:
        await reference.close()
        await candidate.close()
