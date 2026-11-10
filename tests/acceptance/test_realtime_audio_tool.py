import asyncio
import importlib.util
import json
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "validate_realtime_audio.py"
SPEC = importlib.util.spec_from_file_location("validate_realtime_audio", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tool)


class FakeDoubaoWebSocket:
    def __init__(
        self,
        *,
        transcript_before_stop: bool = True,
        analysis_before_stop: bool = True,
        final_transcript: str = tool.REFERENCE_TEXT,
    ):
        self.transcript_before_stop = transcript_before_stop
        self.analysis_before_stop = analysis_before_stop
        self.final_transcript = final_transcript
        self.events: asyncio.Queue[str] = asyncio.Queue()
        self.audio_seen = False
        self.stop_sent = False

    async def send(self, payload):
        if isinstance(payload, bytes):
            if self.audio_seen:
                return
            self.audio_seen = True
            if self.transcript_before_stop:
                await self._put(
                    {
                        "type": "transcript_delta",
                        "sequence": 1,
                        "text": self.final_transcript,
                        "committed_text": "",
                        "interim_text": self.final_transcript,
                        "is_final": False,
                        "start_ms": 0,
                        "end_ms": 200,
                    }
                )
            if self.analysis_before_stop:
                await self._put({"type": "analysis_snapshot", "cards": []})
            return

        event = json.loads(payload)
        if event["type"] == "start":
            await self._put(
                {
                    "type": "started",
                    "session_id": "test-session",
                    "recognizer": "doubao",
                    "data_destination": "volcengine_doubao",
                    "audio_saved": False,
                }
            )
        elif event["type"] == "stop":
            self.stop_sent = True
            await self._put(
                {
                    "type": "ended",
                    "transcript": self.final_transcript,
                    "analysis_count": 1,
                }
            )

    async def recv(self):
        return await self.events.get()

    async def _put(self, event):
        await self.events.put(json.dumps(event, ensure_ascii=False))


class FakeConnection:
    def __init__(self, websocket):
        self.websocket = websocket

    async def __aenter__(self):
        return self.websocket

    async def __aexit__(self, _exc_type, _exc, _traceback):
        return False


def use_fake_doubao(monkeypatch, websocket):
    monkeypatch.setattr(
        tool.websockets,
        "connect",
        lambda *_args, **_kwargs: FakeConnection(websocket),
    )


def test_command_builders_are_argument_safe_and_request_required_pcm_format():
    source = Path("/tmp/source audio.aiff")
    destination = Path("/tmp/output audio.wav")

    assert tool.build_say_command(
        "/usr/bin/say",
        voice="Tingting",
        output_path=source,
        text=tool.REFERENCE_TEXT,
    ) == [
        "/usr/bin/say",
        "-v",
        "Tingting",
        "-o",
        str(source),
        tool.REFERENCE_TEXT,
    ]
    assert tool.build_afconvert_command(
        "/usr/bin/afconvert",
        input_path=source,
        output_path=destination,
    ) == [
        "/usr/bin/afconvert",
        str(source),
        str(destination),
        "-f",
        "WAVE",
        "-d",
        "LEI16@16000",
        "-c",
        "1",
    ]


def test_mandarin_voice_selection_prefers_tingting_and_rejects_missing_locale():
    listing = "\n".join(
        [
            "Sandy (中文（中国大陆）)      zh_CN    # 你好！",
            "Tingting                    zh_CN    # 你好，我叫婷婷。",
        ]
    )
    assert tool.select_mandarin_voice(listing) == "Tingting"

    with pytest.raises(tool.ValidationFailure) as missing:
        tool.select_mandarin_voice("Samantha en_US # Hello")
    assert missing.value.code == "mandarin_voice_unavailable"


def test_pcm_chunks_are_200_ms_and_keep_the_final_tail():
    pcm = bytes(range(256)) * 60
    chunks = list(tool.iter_pcm_chunks(pcm))

    assert len(chunks[0]) == 6_400
    assert len(chunks[1]) == 6_400
    assert len(chunks[2]) == len(pcm) - 12_800
    assert b"".join(chunks) == pcm


def test_synthetic_audio_temporary_files_are_removed(monkeypatch):
    temporary_roots: list[Path] = []

    def fake_run(command):
        output_index = command.index("-o") + 1 if "-o" in command else 2
        output_path = Path(command[output_index])
        temporary_roots.append(output_path.parent)
        if command[0].endswith("say"):
            output_path.write_bytes(b"synthetic-aiff")
        else:
            with wave.open(str(output_path), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16_000)
                audio.writeframes(b"\x00\x00" * 3_200)
        return ""

    monkeypatch.setattr(tool, "_run_command", fake_run)

    pcm = tool.synthesize_mandarin_pcm(
        say_path="/usr/bin/say",
        afconvert_path="/usr/bin/afconvert",
        voice="Tingting",
    )

    assert pcm == b"\x00\x00" * 3_200
    assert temporary_roots
    assert all(not path.exists() for path in temporary_roots)


def test_demo_validation_self_starts_server_and_observes_both_streams():
    result = asyncio.run(tool.run_validation("demo", timeout_seconds=5))

    assert result["ok"] is True
    assert result["mode"] == "demo"
    assert result["audio_saved"] is False
    assert result["transcript"]
    assert result["event_counts"]["transcript_delta"] >= 1
    assert result["event_counts"]["analysis_snapshot"] >= 1
    assert result["metrics"]["first_text_latency_ms"] >= 0
    assert result["metrics"]["completion_latency_ms"] >= 0


def test_transcript_quality_ignores_punctuation_but_detects_wrong_text():
    punctuation_only = tool.transcript_quality(
        tool.REFERENCE_TEXT,
        "我希望先把问题说清楚。我们可以先确认下一步！",
    )
    unrelated = tool.transcript_quality(tool.REFERENCE_TEXT, "今天天气很好")

    assert punctuation_only["normalized_character_error_rate"] == 0
    assert punctuation_only["normalized_similarity"] == 1
    assert unrelated["normalized_character_error_rate"] > 0.5


def test_doubao_validation_proves_streaming_before_stop_and_scores_quality(
    monkeypatch,
):
    websocket = FakeDoubaoWebSocket()
    use_fake_doubao(monkeypatch, websocket)

    result = asyncio.run(
        tool.validate_doubao(
            "ws://test/api/live",
            pcm=b"\x00\x00" * 160,
            timeout_seconds=1,
        )
    )

    assert websocket.stop_sent is True
    assert result["stream_evidence"] == {
        "transcript_before_stop": True,
        "analysis_snapshot_before_stop": True,
    }
    assert result["event_counts"]["transcript_delta"] == 1
    assert result["event_counts"]["analysis_snapshot"] == 1
    assert result["metrics"]["normalized_character_error_rate"] == 0
    assert result["metrics"]["normalized_similarity"] == 1


def test_doubao_validation_fails_without_analysis_before_stop(monkeypatch):
    websocket = FakeDoubaoWebSocket(analysis_before_stop=False)
    use_fake_doubao(monkeypatch, websocket)

    with pytest.raises(tool.ValidationFailure) as failure:
        asyncio.run(
            tool.validate_doubao(
                "ws://test/api/live",
                pcm=b"\x00\x00" * 160,
                timeout_seconds=0.15,
            )
        )

    assert websocket.stop_sent is False
    assert failure.value.code == "doubao_analysis_missing_before_stop"
    assert failure.value.details == {
        "transcript_before_stop": True,
        "analysis_snapshot_before_stop": False,
        "event_counts": {"started": 1, "transcript_delta": 1},
    }


def test_doubao_validation_fails_structurally_below_quality_threshold(
    monkeypatch,
):
    websocket = FakeDoubaoWebSocket(final_transcript="今天天气很好")
    use_fake_doubao(monkeypatch, websocket)

    with pytest.raises(tool.ValidationFailure) as failure:
        asyncio.run(
            tool.validate_doubao(
                "ws://test/api/live",
                pcm=b"\x00\x00" * 160,
                timeout_seconds=1,
            )
        )

    assert websocket.stop_sent is True
    assert failure.value.code == "doubao_transcript_quality_below_threshold"
    assert failure.value.details["normalized_character_error_rate"] > 0.5
    assert failure.value.details["maximum_normalized_character_error_rate"] == 0.5


def test_doubao_without_credentials_exits_nonzero_and_never_prints_secret(
    monkeypatch,
    capsys,
):
    monkeypatch.setattr(tool.platform, "system", lambda: "Darwin")
    monkeypatch.delenv("LINGXI_DOUBAO_API_KEY", raising=False)
    monkeypatch.delenv("LINGXI_DOUBAO_APP_KEY", raising=False)
    monkeypatch.delenv("LINGXI_DOUBAO_ACCESS_KEY", raising=False)
    monkeypatch.setenv("UNRELATED_TEST_SECRET", "must-not-appear")

    exit_code = tool.main(["doubao"])
    output = capsys.readouterr().out
    payload = json.loads(output)

    assert exit_code != 0
    assert payload["ok"] is False
    assert payload["error"]["code"] == "doubao_not_configured"
    assert "must-not-appear" not in output
