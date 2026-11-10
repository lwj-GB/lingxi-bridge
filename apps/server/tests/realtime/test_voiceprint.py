"""Boundary tests; synthetic tones are not evidence of speaker accuracy."""

from __future__ import annotations

import hashlib
import math
import os
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest
from lingxi.realtime.voiceprint import (
    DIMENSION,
    CampPlusExtractor,
    VoiceprintError,
    enroll,
    load_profile,
    match,
    read_clip,
    save_profile,
    unit,
    validate_profile,
)

MODEL_HASH = "a" * 64


def vector(index: int) -> list[float]:
    return [1.0 if i == index else 0.0 for i in range(DIMENSION)]


def profile() -> dict:
    return {
        "version": 1,
        "dimension": DIMENSION,
        "model_sha256": MODEL_HASH,
        "pretrimmed_speech": True,
        "samples": [
            {
                "seconds": 10.0,
                "pcm_sha256": hashlib.sha256(bytes([i])).hexdigest(),
                "embedding": vector(0),
            }
            for i in range(3)
        ],
    }


def write_wav(
    path: Path, seconds: float = 2, *, rate: int = 16000, channels: int = 1, silent: bool = False
) -> Path:
    # Fixed artificial tone, not a recording or a claimed voice model fixture.
    pcm = b"".join(
        struct.pack("<h", 0 if silent else int(1000 * math.sin(i * 0.1)))
        for i in range(int(seconds * rate) * channels)
    )
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return path


def test_read_pcm_and_reject_bad_format(tmp_path):
    clip = read_clip(write_wav(tmp_path / "ok.wav"))
    assert clip.seconds == 2
    assert len(clip.samples) == 32000
    for options in ({"rate": 8000}, {"channels": 2}, {"seconds": 1}, {"silent": True}):
        with pytest.raises(VoiceprintError):
            read_clip(write_wav(tmp_path / "bad.wav", **options))


def test_truncated_and_non_wav(tmp_path):
    path = write_wav(tmp_path / "cut.wav")
    path.write_bytes(path.read_bytes()[:-2])
    with pytest.raises(VoiceprintError, match="不完整"):
        read_clip(path)
    path.write_text("not audio")
    with pytest.raises(VoiceprintError, match="无法读取"):
        read_clip(path)


@pytest.mark.parametrize(
    "value",
    [[0.0] * DIMENSION, [1.0], [float("nan")] * DIMENSION, [float("inf")] * DIMENSION, None],
)
def test_invalid_embeddings(value):
    with pytest.raises(VoiceprintError):
        unit(value)


def test_normalized_match_and_unknown():
    assert unit([v * 5 for v in vector(0)]) == vector(0)
    assert match(profile(), vector(0), MODEL_HASH, 0.7)["speaker"] == "me"
    result = match(profile(), vector(1), MODEL_HASH, 0.7)
    assert result == {"speaker": "unknown", "similarity": 0.0, "threshold": 0.7}
    with pytest.raises(VoiceprintError, match="模型与登记时不同"):
        match(profile(), vector(0), "b" * 64, 0.7)
    for threshold in (0, 1.01, float("nan")):
        with pytest.raises(VoiceprintError):
            match(profile(), vector(0), MODEL_HASH, threshold)


def test_registration_duration_and_duplicate_boundaries():
    data = profile()
    data["samples"].pop()
    with pytest.raises(VoiceprintError, match="至少"):
        validate_profile(data, MODEL_HASH)
    data = profile()
    data["samples"][0]["seconds"] = 9.9
    with pytest.raises(VoiceprintError, match="30 秒"):
        validate_profile(data, MODEL_HASH)
    data = profile()
    data["samples"][0]["pcm_sha256"] = data["samples"][1]["pcm_sha256"]
    with pytest.raises(VoiceprintError, match="重复"):
        validate_profile(data, MODEL_HASH)


def test_enrollment_checks_before_inference(tmp_path):
    class UnusedExtractor:
        model_sha256 = MODEL_HASH

        def compute(self, clip):
            pytest.fail("invalid input must not reach inference")

    clip = read_clip(write_wav(tmp_path / "a.wav"))
    with pytest.raises(VoiceprintError, match="不执行 VAD"):
        enroll(UnusedExtractor(), [clip], pretrimmed_speech=False)
    with pytest.raises(VoiceprintError, match="至少"):
        enroll(UnusedExtractor(), [clip], pretrimmed_speech=True)


def test_private_atomic_profile_roundtrip_no_overwrite(tmp_path):
    path = tmp_path / "private" / "me.json"
    data = profile()
    save_profile(path, data)
    assert load_profile(path, MODEL_HASH) == data
    before = path.read_bytes()
    with pytest.raises(VoiceprintError, match="已存在"):
        save_profile(path, data)
    assert path.read_bytes() == before
    assert not list(path.parent.glob(".voiceprint-*"))
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(VoiceprintError, match="绝对路径"):
        save_profile(Path("voice.json"), data)
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "workspace.json").write_text("{}")
    with pytest.raises(VoiceprintError, match="开放工作区"):
        save_profile(vault / "me.json", data)
    repository = tmp_path / "repo"
    repository.mkdir()
    (repository / ".git").mkdir()
    with pytest.raises(VoiceprintError, match="Git 仓库"):
        save_profile(repository / "me.json", data)


def test_no_model_means_clear_error(tmp_path):
    with pytest.raises(VoiceprintError, match="绝对文件路径"):
        CampPlusExtractor(tmp_path / "missing.onnx")
    with pytest.raises(VoiceprintError, match="绝对文件路径"):
        CampPlusExtractor(Path("model.onnx"))


def test_cli_does_not_silently_claim_vad(tmp_path):
    script = Path(__file__).resolve().parents[4] / "scripts" / "voiceprint.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "enroll",
            "--model",
            str(tmp_path / "model.onnx"),
            "--profile",
            str(tmp_path / "me.json"),
            str(tmp_path / "clip.wav"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "没有 VAD" in result.stderr
    assert not (tmp_path / "me.json").exists()


@pytest.mark.skipif(
    not os.environ.get("LINGXI_TEST_VOICE_MODEL"),
    reason="No local CAM++ weights configured; real inference not verified",
)
def test_real_model_extracts_finite_normalized_vector(tmp_path):
    extractor = CampPlusExtractor(Path(os.environ["LINGXI_TEST_VOICE_MODEL"]))
    result = extractor.compute(read_clip(write_wav(tmp_path / "synthetic.wav")))
    assert len(result) == DIMENSION
    assert sum(x * x for x in result) == pytest.approx(1.0)
