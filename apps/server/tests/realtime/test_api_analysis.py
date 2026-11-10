import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app


@pytest.fixture
def endpoint():
    calls = []
    entered, release = threading.Event(), threading.Event()
    state = {"status": 200, "hold_first": False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append(body)
            number = len(calls)
            entered.set()
            if state["hold_first"] and number == 1:
                release.wait(timeout=5)
            output = {
                "intent": f"建议{number}：可能需要澄清，仍需核对。",
                "reply_points": ["请确认下一步安排。"],
                "cautions": ["不要把推测当成事实。"],
                "summary_points": ["对方提到一项待确认安排。"],
                "topics": ["安排"],
            }
            self.send_response(state["status"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": json.dumps(output, ensure_ascii=False),
                                }
                            }
                        ]
                    }
                ).encode()
            )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", calls, state, entered, release
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join()


def configure(client, url):
    assert (
        client.post(
            "/api/model-settings",
            json={
                "base_url": url,
                "model": "fixture-model",
                "api_key": "fixture-secret",
            },
        ).status_code
        == 200
    )


def start(websocket, **overrides):
    websocket.send_json(
        {
            "type": "start",
            "recognizer": "browser_stream",
            "consent": True,
            "default_speaker": "other",
            "analysis_mode": "goal",
            "goal": "确认安排",
            "analysis_api": {"scope_confirmed": True, "enabled": True},
            **overrides,
        }
    )


def transcript(websocket, sequence, text, *, speaker="other", final=True):
    websocket.send_json(
        {
            "type": "transcript",
            "sequence": sequence,
            "text": text,
            "speaker": speaker,
            "is_final": final,
            "start_ms": 0,
            "end_ms": sequence * 100,
        }
    )
    assert websocket.receive_json()["type"] == "transcript_delta"
    assert websocket.receive_json()["type"] == "analysis_snapshot"


def test_real_api_only_receives_confirmed_other_turn_and_disable_stops_requests(endpoint):
    url, calls, _, _, _ = endpoint
    with TestClient(create_app()) as client:
        configure(client, url)
        with client.websocket_connect("/api/live") as websocket:
            start(websocket)
            assert websocket.receive_json()["type"] == "started"
            transcript(websocket, 1, "临时文本不发送", final=False)
            transcript(websocket, 2, "我的发言不发送", speaker="me")
            transcript(websocket, 3, "未知说话人不发送", speaker="unknown")
            transcript(websocket, 4, "明天需要确认安排。")
            assert websocket.receive_json()["is_updating"] is True
            insight = websocket.receive_json()
            assert insight["type"] == "insight_snapshot"
            assert insight["observed_at_ms"] == 400
            assert insight["is_updating"] is False
            assert insight["reply_points"] == ["请确认下一步安排。"]
            assert len(calls) == 1
            payload = json.dumps(calls[0], ensure_ascii=False)
            assert "明天需要确认安排。" in payload
            for excluded in ["临时文本不发送", "我的发言不发送", "未知说话人不发送"]:
                assert excluded not in payload
            websocket.send_json({"type": "analysis_control", "enabled": False})
            transcript(websocket, 5, "关闭后不发送")
            websocket.send_json({"type": "stop"})
            assert websocket.receive_json()["type"] == "ended"
            assert len(calls) == 1


def test_scope_confirmation_is_independent_of_recording_consent(endpoint):
    url, calls, _, _, _ = endpoint
    with TestClient(create_app()) as client:
        configure(client, url)
        with client.websocket_connect("/api/live") as websocket:
            start(websocket, analysis_api={"scope_confirmed": False})
            assert websocket.receive_json()["code"] == "invalid_start"
    assert calls == []


def test_api_failure_is_recoverable_and_recording_continues(endpoint):
    url, calls, state, _, _ = endpoint
    state["status"] = 503
    with TestClient(create_app()) as client:
        configure(client, url)
        with client.websocket_connect("/api/live") as websocket:
            start(websocket)
            assert websocket.receive_json()["type"] == "started"
            transcript(websocket, 1, "需要确认安排。")
            assert websocket.receive_json()["is_updating"] is True
            assert websocket.receive_json()["is_updating"] is False
            error = websocket.receive_json()
            assert error["code"] == "api_analysis_failed"
            assert error["recoverable"] is True
            transcript(websocket, 2, "失败后我仍然可以继续说话。", speaker="me")
            websocket.send_json({"type": "stop"})
            ended = websocket.receive_json()
            assert "失败后我仍然可以继续说话。" in ended["transcript"]
    assert len(calls) == 1


def test_latest_final_turn_replaces_pending_and_old_result_never_overwrites(endpoint):
    url, calls, state, entered, release = endpoint
    state["hold_first"] = True
    with TestClient(create_app()) as client:
        configure(client, url)
        with client.websocket_connect("/api/live") as websocket:
            start(websocket)
            assert websocket.receive_json()["type"] == "started"
            transcript(websocket, 1, "第一段")
            assert websocket.receive_json()["is_updating"] is True
            assert entered.wait(timeout=2)
            transcript(websocket, 2, "中间段无需另一次请求")
            assert websocket.receive_json()["is_updating"] is True
            transcript(websocket, 3, "最新段")
            assert websocket.receive_json()["is_updating"] is True
            release.set()
            insight = websocket.receive_json()
            assert insight["is_updating"] is False
            assert insight["observed_at_ms"] == 300
            assert insight["intent"].startswith("建议2")
            assert len(calls) == 2
            assert "最新段" in json.dumps(calls[1], ensure_ascii=False)
            assert "中间段无需另一次请求" not in json.dumps(calls, ensure_ascii=False)
            websocket.send_json({"type": "stop"})
            assert websocket.receive_json()["type"] == "ended"


def test_stop_discards_inflight_result_and_new_session_has_no_old_insight(endpoint):
    url, calls, state, entered, release = endpoint
    state["hold_first"] = True
    with TestClient(create_app()) as client:
        configure(client, url)
        with client.websocket_connect("/api/live") as websocket:
            start(websocket)
            assert websocket.receive_json()["type"] == "started"
            transcript(websocket, 1, "旧会话")
            assert websocket.receive_json()["is_updating"] is True
            assert entered.wait(timeout=2)
            websocket.send_json({"type": "stop"})
            assert websocket.receive_json()["type"] == "ended"
            release.set()
        with client.websocket_connect("/api/live") as websocket:
            start(websocket)
            assert websocket.receive_json()["type"] == "started"
            transcript(websocket, 2, "新会话")
            busy = websocket.receive_json()
            assert busy["intent"] == ""
            assert busy["is_updating"] is True
            insight = websocket.receive_json()
            assert insight["intent"].startswith("建议2")
            websocket.send_json({"type": "stop"})
            assert websocket.receive_json()["type"] == "ended"
    assert len(calls) == 2


def test_disable_discards_inflight_and_reenable_only_sends_new_turn(endpoint):
    url, calls, state, entered, release = endpoint
    state["hold_first"] = True
    with TestClient(create_app()) as client:
        configure(client, url)
        with client.websocket_connect("/api/live") as websocket:
            start(websocket)
            assert websocket.receive_json()["type"] == "started"
            transcript(websocket, 1, "关闭前在途请求")
            assert websocket.receive_json()["is_updating"] is True
            assert entered.wait(timeout=2)
            websocket.send_json({"type": "analysis_control", "enabled": False})
            transcript(websocket, 2, "关闭期间不外发也不补发")
            websocket.send_json({"type": "analysis_control", "enabled": True})
            transcript(websocket, 3, "重新开启后的新段落")
            assert websocket.receive_json()["is_updating"] is True
            release.set()
            insight = websocket.receive_json()
            assert insight["observed_at_ms"] == 300
            assert insight["intent"].startswith("建议2")
            assert len(calls) == 2
            assert "关闭期间不外发也不补发" not in json.dumps(calls, ensure_ascii=False)
            websocket.send_json({"type": "stop"})
            assert websocket.receive_json()["type"] == "ended"


def test_missing_model_configuration_does_not_stop_transcription():
    with TestClient(create_app()) as client:
        with client.websocket_connect("/api/live") as websocket:
            start(websocket)
            error = websocket.receive_json()
            assert error["code"] == "api_analysis_not_configured"
            assert error["recoverable"] is True
            assert websocket.receive_json()["type"] == "started"
            transcript(websocket, 1, "缺少模型也继续记录。")
            websocket.send_json({"type": "stop"})
            ended = websocket.receive_json()
            assert ended["transcript"] == "缺少模型也继续记录。"


def test_analysis_control_does_not_skip_demo_transcript_chunks():
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
            websocket.send_json({"type": "analysis_control", "enabled": False})
            while True:
                event = websocket.receive_json()
                if event["type"] == "ended":
                    break
            assert event["transcript"] == (
                "我不太确定，但是我希望先把问题说清楚。好，我们先确认下一步。"
            )
