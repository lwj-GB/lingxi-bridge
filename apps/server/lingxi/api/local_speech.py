from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile
from starlette.concurrency import run_in_threadpool

from lingxi.api.errors import ApiError
from lingxi.api.mobile import _trusted_control
from lingxi.local_speech import MAX_BYTES, LocalSpeechError, speech

router = APIRouter(prefix="/api/local-speech")


def _local(request: Request):
    _trusted_control(request)
    if request.client and request.client.host not in {
        "127.0.0.1",
        "::1",
        "localhost",
        "testclient",
    }:
        raise ApiError(403, "local_speech_forbidden", "本机转写只能由此电脑的工作台调用。")


@router.get("/status")
def status(request: Request):
    _local(request)
    return speech.status()


@router.post("/transcribe")
async def transcribe(request: Request, file: UploadFile):
    _local(request)
    try:
        with tempfile.TemporaryDirectory(prefix="lingxi-upload-") as temporary:
            path = Path(temporary) / "audio"
            size = 0
            with path.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ApiError(
                            413, "local_speech_too_large", "音频不能超过64MB，请先分段。"
                        )
                    output.write(chunk)
            return await run_in_threadpool(speech.transcribe, path)
    except LocalSpeechError as exc:
        raise ApiError(exc.status, exc.code, str(exc)) from exc
    finally:
        await file.close()
