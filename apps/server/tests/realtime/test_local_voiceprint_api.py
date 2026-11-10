"""No real voices: finite inference/ephemeral comparison and request boundaries."""

from __future__ import annotations

import io
import math
import struct
import wave

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from lingxi.api.errors import ApiError
from lingxi.api.local_voiceprint import router
from lingxi.realtime.voiceprint import default_model_path


def tone(frequency=220) -> bytes:
    pcm = b"".join(
        struct.pack("<h", int(3000 * math.sin(2 * math.pi * frequency * i / 16000)))
        for i in range(32000)
    )
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)
    return out.getvalue()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)

    @app.exception_handler(ApiError)
    async def error(_request: Request, exc: ApiError):
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status_code
        )

    return TestClient(app)


def files(reference=None, candidate=None):
    return {
        "reference": ("reference.wav", reference or tone()),
        "candidate": ("candidate.wav", candidate or tone()),
    }


def test_requires_explicit_single_speaker_confirmation(client):
    result = client.post("/api/local-voiceprint/compare", files=files())
    assert result.status_code == 422
    assert result.json()["error"]["code"] == "voiceprint_speech_confirmation_required"


def test_rejects_oversized_audio(client):
    result = client.post(
        "/api/local-voiceprint/compare",
        files=files(reference=b"0" * 2_000_001),
        data={"pretrimmed_speech": "true"},
    )
    assert result.status_code == 413


def test_rejects_invalid_wav_before_inference(client):
    result = client.post(
        "/api/local-voiceprint/compare",
        files=files(candidate=b"not wav"),
        data={"pretrimmed_speech": "true"},
    )
    assert result.status_code == 422
    assert "无法读取" in result.json()["error"]["message"]


def test_status_does_not_claim_registered_identity(client, monkeypatch, tmp_path):
    monkeypatch.setenv("LINGXI_VOICEPRINT_MODEL", str(tmp_path / "missing.onnx"))
    state = client.get("/api/local-voiceprint/status").json()
    assert state["available"] is False
    assert state["registered_self"] is False


@pytest.mark.skipif(not default_model_path().is_file(), reason="Optional local CAM++ model absent")
def test_real_cpu_model_comparison_is_finite_and_never_identity(client):
    result = client.post(
        "/api/local-voiceprint/compare", files=files(), data={"pretrimmed_speech": "true"}
    )
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["dimension"] == 192
    assert body["similarity"] == pytest.approx(1.0, abs=1e-5)
    assert body["processing"] == "local_cpu"
    assert body["persisted"] is False
    assert "speaker" not in body and "embedding" not in body
    other = client.post(
        "/api/local-voiceprint/compare",
        files=files(candidate=tone(440)),
        data={"pretrimmed_speech": "true"},
    )
    assert other.status_code == 200
    assert math.isfinite(other.json()["similarity"])
    assert -1 <= other.json()["similarity"] <= 1


@pytest.mark.parametrize("endpoint", ["status", "compare"])
def test_rejects_external_origin(client, endpoint):
    headers = {"Origin": "https://untrusted.example"}
    if endpoint == "status":
        response = client.get("/api/local-voiceprint/status", headers=headers)
    else:
        response = client.post(
            "/api/local-voiceprint/compare",
            files=files(),
            data={"pretrimmed_speech": "true"},
            headers=headers,
        )
    assert response.status_code == 403


@pytest.mark.parametrize("endpoint", ["status", "compare"])
def test_rejects_non_loopback_client(client, endpoint):
    remote = TestClient(client.app, client=("192.168.1.11", 50000))
    if endpoint == "status":
        response = remote.get("/api/local-voiceprint/status")
    else:
        response = remote.post(
            "/api/local-voiceprint/compare",
            files=files(),
            data={"pretrimmed_speech": "true"},
        )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "local_voiceprint_forbidden"
