import asyncio

import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app
from lingxi.realtime.router import _provider_result
from starlette.websockets import WebSocketDisconnect


def test_demo_streams_transcript_and_analysis_without_saving_audio():
    with TestClient(create_app()) as client:
        with client.websocket_connect(
            "/api/live",
            headers={"origin": "http://127.0.0.1:5173"},
        ) as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "demo",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            events = []
            while True:
                event = websocket.receive_json()
                events.append(event)
                if event["type"] == "ended":
                    break

    started = events[0]
    assert started["type"] == "started"
    assert started["data_destination"] == "local_only"
    assert started["audio_saved"] is False
    assert any(event["type"] == "transcript_delta" for event in events)
    assert any(event["type"] == "analysis_snapshot" for event in events)
    assert events[-1]["transcript"] == (
        "我不太确定，但是我希望先把问题说清楚。好，我们先确认下一步。"
    )
    transcript_events = [
        event for event in events if event["type"] == "transcript_delta"
    ]
    assert {event["speaker"] for event in transcript_events} == {"me", "other"}


def test_demo_stops_before_the_next_scripted_chunk():
    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "demo",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            assert websocket.receive_json()["type"] == "started"
            websocket.send_json({"type": "stop"})
            ended = websocket.receive_json()

    assert ended == {
        "type": "ended",
        "transcript": "",
        "analysis_count": 0,
    }


def test_start_requires_explicit_consent():
    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json({"type": "start", "recognizer": "demo"})
            event = websocket.receive_json()

    assert event == {
        "type": "error",
        "code": "invalid_start",
        "message": "开始实时会话前必须选择识别方式并确认参与者同意。",
        "recoverable": True,
    }


def test_live_websocket_rejects_non_local_browser_origins():
    with TestClient(create_app()) as client:
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect(
                "/api/live",
                headers={"origin": "https://example.com"},
            ):
                pass
    assert rejected.value.code == 1008


def test_browser_stream_forwards_interim_and_final_text_to_local_analysis():
    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "browser_stream",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            assert websocket.receive_json()["type"] == "started"
            websocket.send_json(
                {
                    "type": "transcript",
                    "speaker": "other",
                    "sequence": 1,
                    "text": "我可能",
                    "is_final": False,
                    "start_ms": 0,
                    "end_ms": 300,
                }
            )
            interim = websocket.receive_json()
            analysis = websocket.receive_json()
            websocket.send_json(
                {
                    "type": "transcript",
                    "speaker": "other",
                    "sequence": 2,
                    "text": "我可能需要先确认。",
                    "is_final": True,
                    "start_ms": 0,
                    "end_ms": 800,
                }
            )
            final = websocket.receive_json()
            analysis_update = websocket.receive_json()
            websocket.send_json({"type": "stop"})
            ended = websocket.receive_json()

    assert interim["interim_text"] == "我可能"
    assert {card["kind"] for card in analysis["cards"]} == {"uncertainty"}
    assert final["committed_text"] == "我可能需要先确认。"
    assert {card["kind"] for card in analysis_update["cards"]} == {
        "uncertainty",
        "request",
    }
    assert ended["transcript"] == "我可能需要先确认。"


def test_browser_stream_ignores_duplicate_and_stale_sequences():
    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "browser_stream",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            assert websocket.receive_json()["type"] == "started"
            first_final = {
                "type": "transcript",
                "speaker": "other",
                "sequence": 3,
                "text": "先确认。",
                "is_final": True,
                "start_ms": 0,
                "end_ms": 500,
            }
            websocket.send_json(first_final)
            assert websocket.receive_json()["sequence"] == 3
            assert websocket.receive_json()["type"] == "analysis_snapshot"

            websocket.send_json(first_final)
            websocket.send_json(
                {
                    "type": "transcript",
                    "speaker": "other",
                    "sequence": 2,
                    "text": "不应显示的回退内容",
                    "is_final": False,
                    "start_ms": 0,
                    "end_ms": 300,
                }
            )
            websocket.send_json(
                {
                    "type": "transcript",
                    "speaker": "other",
                    "sequence": 4,
                    "text": "继续说明。",
                    "is_final": True,
                    "start_ms": 500,
                    "end_ms": 900,
                }
            )
            later_delta = websocket.receive_json()
            later_analysis = websocket.receive_json()
            websocket.send_json({"type": "stop"})
            ended = websocket.receive_json()

    assert later_delta == {
        "type": "transcript_delta",
        "speaker": "other",
        "sequence": 4,
        "text": "继续说明。",
        "committed_text": "先确认。继续说明。",
        "interim_text": "",
        "is_final": True,
        "start_ms": 500,
        "end_ms": 900,
    }
    assert later_analysis["type"] == "analysis_snapshot"
    assert ended["transcript"] == "先确认。继续说明。"


def test_doubao_mode_fails_clearly_before_credentials_are_configured(monkeypatch):
    monkeypatch.delenv("LINGXI_DOUBAO_API_KEY", raising=False)
    monkeypatch.delenv("LINGXI_DOUBAO_APP_KEY", raising=False)
    monkeypatch.delenv("LINGXI_DOUBAO_ACCESS_KEY", raising=False)

    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "doubao",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            event = websocket.receive_json()

    assert event["code"] == "doubao_not_configured"
    assert event["recoverable"] is True


def test_doubao_snapshot_is_final_only_when_all_utterances_are_definite():
    text, is_final, end_ms = _provider_result(
        {
            "payload": {
                "result": {
                    "text": "前一句已经确定，后一句还在说",
                    "utterances": [
                        {"text": "前一句已经确定", "definite": True},
                        {"text": "后一句还在说", "definite": False},
                    ],
                },
                "audio_info": {"duration": 900},
            },
            "is_last": False,
        }
    )

    assert text == "前一句已经确定，后一句还在说"
    assert is_final is False
    assert end_ms == 900


def test_doubao_mode_bridges_pcm_and_streams_provider_results(monkeypatch):
    class FakeDoubaoClient:
        instance = None

        def __init__(self, _config, _session_id):
            self.audio = []
            self.responses = asyncio.Queue()
            FakeDoubaoClient.instance = self

        async def connect(self):
            await self.responses.put(
                {
                    "payload": {"result": {"text": "我可能", "utterances": []}},
                    "is_last": False,
                }
            )

        async def send_audio(self, audio, *, final=False):
            self.audio.append((audio, final))
            if final:
                await self.responses.put(
                    {
                        "payload": {
                            "result": {
                                "text": "我可能",
                                "utterances": [{"definite": True}],
                            },
                            "audio_info": {"duration": 820},
                        },
                        "is_last": True,
                    }
                )

        async def receive(self):
            return await self.responses.get()

        async def close(self):
            return None

    monkeypatch.setenv("LINGXI_DOUBAO_API_KEY", "test-only")
    monkeypatch.setattr(
        "lingxi.realtime.router.DoubaoClient",
        FakeDoubaoClient,
    )

    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "doubao",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            assert websocket.receive_json()["phase"] == "connecting"
            assert websocket.receive_json()["type"] == "started"
            assert websocket.receive_json()["type"] == "transcript_delta"
            analysis = websocket.receive_json()
            assert analysis["type"] == "analysis_snapshot"
            assert {card["kind"] for card in analysis["cards"]} == {
                "uncertainty"
            }
            websocket.send_bytes(b"\x00\x00" * 3200)
            websocket.send_json({"type": "stop"})
            events = []
            while True:
                event = websocket.receive_json()
                events.append(event)
                if event["type"] == "ended":
                    break

    final_transcripts = [
        event
        for event in events
        if event["type"] == "transcript_delta" and event["is_final"]
    ]
    assert final_transcripts == [
        {
            "type": "transcript_delta",
            "speaker": "other",
            "sequence": 2,
            "text": "我可能",
            "committed_text": "我可能",
            "interim_text": "",
            "is_final": True,
            "start_ms": 0,
            "end_ms": 820,
        }
    ]
    assert events[-1]["transcript"] == "我可能"
    assert FakeDoubaoClient.instance.audio == [
        (b"\x00\x00" * 3200, False),
        (b"", True),
    ]


def test_doubao_full_snapshot_does_not_repeat_prior_final_text(monkeypatch):
    class FakeDoubaoClient:
        instance = None

        def __init__(self, _config, _session_id):
            self.audio = []
            self.responses = asyncio.Queue()
            FakeDoubaoClient.instance = self

        async def connect(self):
            await self.responses.put(
                {
                    "payload": {
                        "result": {
                            "text": "第一句。",
                            "utterances": [
                                {"text": "第一句。", "definite": True}
                            ],
                        },
                        "audio_info": {"duration": 500},
                    },
                    "is_last": False,
                }
            )
            await self.responses.put(
                {
                    "payload": {
                        "result": {
                            "text": "第一句。第二",
                            "utterances": [
                                {"text": "第一句。", "definite": True},
                                {"text": "第二", "definite": False},
                            ],
                        },
                        "audio_info": {"duration": 900},
                    },
                    "is_last": False,
                }
            )

        async def send_audio(self, audio, *, final=False):
            self.audio.append((audio, final))
            if final:
                await self.responses.put(
                    {
                        "payload": {
                            "result": {
                                "text": "第一句。第二句。",
                                "utterances": [
                                    {"text": "第一句。", "definite": True},
                                    {"text": "第二句。", "definite": True},
                                ],
                            },
                            "audio_info": {"duration": 1200},
                        },
                        "is_last": True,
                    }
                )

        async def receive(self):
            return await self.responses.get()

        async def close(self):
            return None

    monkeypatch.setenv("LINGXI_DOUBAO_API_KEY", "test-only")
    monkeypatch.setattr(
        "lingxi.realtime.router.DoubaoClient",
        FakeDoubaoClient,
    )

    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "doubao",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            assert websocket.receive_json()["phase"] == "connecting"
            assert websocket.receive_json()["type"] == "started"

            first_final = websocket.receive_json()
            assert first_final["type"] == "transcript_delta"
            assert first_final["is_final"] is True
            assert first_final["committed_text"] == "第一句。"
            assert websocket.receive_json()["type"] == "analysis_snapshot"

            full_interim = websocket.receive_json()
            assert full_interim["type"] == "transcript_delta"
            assert full_interim["is_final"] is False
            assert (
                full_interim["committed_text"] + full_interim["interim_text"]
                == "第一句。第二"
            )
            assert websocket.receive_json()["type"] == "analysis_snapshot"

            websocket.send_json({"type": "stop"})
            events = []
            while True:
                event = websocket.receive_json()
                events.append(event)
                if event["type"] == "ended":
                    break

    final_transcripts = [
        event
        for event in events
        if event["type"] == "transcript_delta" and event["is_final"]
    ]
    assert final_transcripts[-1]["committed_text"] == "第一句。第二句。"
    assert final_transcripts[-1]["interim_text"] == ""
    assert events[-1]["transcript"] == "第一句。第二句。"
    assert events[-1]["transcript"].count("第一句。") == 1


def test_doubao_stop_timeout_is_error_instead_of_normal_ended(monkeypatch):
    real_wait = asyncio.wait

    async def immediate_stop_timeout(tasks, *, return_when, timeout=None):
        if timeout is not None:
            return set(), set(tasks)
        return await real_wait(
            tasks,
            return_when=return_when,
            timeout=timeout,
        )

    class FakeDoubaoClient:
        instance = None

        def __init__(self, _config, _session_id):
            self.audio = []
            self.responses = asyncio.Queue()
            FakeDoubaoClient.instance = self

        async def connect(self):
            return None

        async def send_audio(self, audio, *, final=False):
            self.audio.append((audio, final))

        async def receive(self):
            return await self.responses.get()

        async def close(self):
            return None

    monkeypatch.setenv("LINGXI_DOUBAO_API_KEY", "test-only")
    monkeypatch.setattr(
        "lingxi.realtime.router.DoubaoClient",
        FakeDoubaoClient,
    )
    monkeypatch.setattr(
        "lingxi.realtime.router.asyncio.wait",
        immediate_stop_timeout,
    )

    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            websocket.send_json(
                {
                    "type": "start",
                    "recognizer": "doubao",
                    "consent": True,
                    "default_speaker": "other",
                }
            )
            assert websocket.receive_json()["phase"] == "connecting"
            assert websocket.receive_json()["type"] == "started"
            websocket.send_json({"type": "stop"})
            assert websocket.receive_json()["phase"] == "stopping"
            timed_out = websocket.receive_json()

    assert timed_out["type"] == "error"
    assert timed_out["recoverable"] is False
    assert "超时" in timed_out["message"]
    assert FakeDoubaoClient.instance.audio == [(b"", True)]
