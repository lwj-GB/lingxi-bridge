import pytest
from fastapi.testclient import TestClient
from lingxi.local_speech import LocalSpeech, LocalSpeechError
from lingxi.main import create_app


def test_status_missing_model_is_explicit(tmp_path, monkeypatch):
    monkeypatch.setenv("LINGXI_LOCAL_SPEECH_MODEL_DIR", str(tmp_path))
    status = LocalSpeech().status()
    assert status["ready"] is False
    assert {"model.int8.onnx", "tokens.txt"} <= set(status["missing"])
    assert status["local_only"] is True


def test_unavailable_and_busy_do_not_recognize(tmp_path, monkeypatch):
    monkeypatch.setenv("LINGXI_LOCAL_SPEECH_MODEL_DIR", str(tmp_path))
    service = LocalSpeech()
    with pytest.raises(LocalSpeechError, match="安装"):
        service.transcribe(tmp_path / "missing")
    service._lock.acquire()
    try:
        with pytest.raises(LocalSpeechError) as error:
            service.transcribe(tmp_path / "missing")
        assert error.value.code == "local_speech_busy"
    finally:
        service._lock.release()


def test_local_only_api_and_missing_model(tmp_path, monkeypatch):
    monkeypatch.setenv("LINGXI_LOCAL_SPEECH_MODEL_DIR", str(tmp_path))
    with TestClient(create_app(recent_workspace_file=tmp_path / "recent")) as client:
        assert client.get("/api/local-speech/status").json()["ready"] is False
        assert (
            client.get(
                "/api/local-speech/status", headers={"origin": "https://example.org"}
            ).status_code
            == 403
        )
        response = client.post(
            "/api/local-speech/transcribe", files={"file": ("private.wav", b"invalid")}
        )
        assert response.status_code == 503
        assert "private" not in response.text


def test_upload_size_limit_and_cleanup(tmp_path, monkeypatch):
    import lingxi.api.local_speech as api

    monkeypatch.setattr(api, "MAX_BYTES", 3)
    with TestClient(create_app(recent_workspace_file=tmp_path / "recent")) as client:
        response = client.post(
            "/api/local-speech/transcribe", files={"file": ("audio.wav", b"1234")}
        )
        assert response.status_code == 413


def test_invalid_audio_is_rejected_without_model_load(tmp_path, monkeypatch):
    service = LocalSpeech()
    monkeypatch.setattr(service, "status", lambda: {"ready": True})
    source = tmp_path / "broken.webm"
    source.write_bytes(b"not an audio file")
    with pytest.raises(LocalSpeechError, match="无法读取"):
        service.transcribe(source)
    assert service._recognizer is None


def test_upload_is_cleaned_after_transcription_error(tmp_path, monkeypatch):
    import lingxi.api.local_speech as api

    uploaded = []

    def fail(path):
        assert path.read_bytes() == b"invalid"
        uploaded.append(path)
        raise LocalSpeechError("音频不可读。")

    monkeypatch.setattr(api.speech, "transcribe", fail)
    with TestClient(create_app(recent_workspace_file=tmp_path / "recent")) as client:
        response = client.post(
            "/api/local-speech/transcribe", files={"file": ("audio.wav", b"invalid")}
        )
        assert response.status_code == 422
    assert len(uploaded) == 1
    assert not uploaded[0].exists()
    assert not uploaded[0].parent.exists()


def test_decoded_duration_limit_before_model_load(tmp_path, monkeypatch):
    import wave

    import lingxi.local_speech as module

    monkeypatch.setattr(module, "MAX_DURATION_SECONDS", 1)
    service = LocalSpeech()
    monkeypatch.setattr(service, "status", lambda: {"ready": True})
    source = tmp_path / "long.wav"
    with wave.open(str(source), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x00\x00" * 17600)
    with pytest.raises(LocalSpeechError, match="不超过30分钟"):
        service.transcribe(source)
    assert service._recognizer is None


def test_non_loopback_client_is_rejected(tmp_path):
    with TestClient(
        create_app(recent_workspace_file=tmp_path / "recent"), client=("192.168.1.11", 50000)
    ) as client:
        assert client.get("/api/local-speech/status").status_code == 403
