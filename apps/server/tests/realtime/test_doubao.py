import asyncio
import gzip
import json

import pytest
import websockets
from lingxi.realtime.doubao import (
    AUDIO_ONLY_REQUEST,
    FULL_CLIENT_REQUEST,
    SERVER_ERROR_RESPONSE,
    DoubaoClient,
    DoubaoConfig,
    build_audio_frame,
    build_full_request,
    parse_response,
)


def test_new_console_api_key_is_read_without_exposing_it(monkeypatch) -> None:
    monkeypatch.setenv("LINGXI_DOUBAO_API_KEY", "secret-for-test")
    monkeypatch.delenv("LINGXI_DOUBAO_APP_KEY", raising=False)
    monkeypatch.delenv("LINGXI_DOUBAO_ACCESS_KEY", raising=False)

    config = DoubaoConfig.from_env()

    assert config is not None
    assert config.headers()["X-Api-Key"] == "secret-for-test"
    assert config.headers()["X-Api-Resource-Id"] == "volc.seedasr.sauc.duration"
    assert "secret-for-test" not in repr(config)


def test_partial_legacy_credentials_are_rejected(monkeypatch) -> None:
    monkeypatch.delenv("LINGXI_DOUBAO_API_KEY", raising=False)
    monkeypatch.setenv("LINGXI_DOUBAO_APP_KEY", "app")
    monkeypatch.delenv("LINGXI_DOUBAO_ACCESS_KEY", raising=False)

    with pytest.raises(ValueError, match="必须同时配置"):
        DoubaoConfig.from_env()


def test_full_request_uses_pcm_16k_mono_and_gzip_json() -> None:
    frame = build_full_request("session-for-test")

    assert frame[1] >> 4 == FULL_CLIENT_REQUEST
    assert frame[2] & 0x0F == 1
    size = int.from_bytes(frame[4:8], "big")
    payload = json.loads(gzip.decompress(frame[8 : 8 + size]))
    assert payload["audio"] == {
        "format": "pcm",
        "codec": "raw",
        "rate": 16000,
        "bits": 16,
        "channel": 1,
    }
    assert payload["request"]["show_utterances"] is True


def test_audio_frame_marks_the_last_packet_without_changing_audio_format() -> None:
    regular = build_audio_frame(b"\x00\x01" * 3200)
    final = build_audio_frame(b"", final=True)

    assert regular[1] >> 4 == AUDIO_ONLY_REQUEST
    assert regular[1] & 0x0F == 0
    assert regular[2] >> 4 == 0
    assert regular[2] & 0x0F == 1
    assert final[1] & 0x0F == 2
    assert gzip.decompress(regular[8:]) == b"\x00\x01" * 3200
    assert gzip.decompress(final[8:]) == b""


def test_connect_sends_config_without_waiting_for_an_initial_ack(monkeypatch) -> None:
    class FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[bytes] = []

        async def send(self, frame: bytes) -> None:
            self.sent.append(frame)

        async def recv(self) -> bytes:
            raise AssertionError("配置帧后不应等待服务器 ACK 才开始发送音频")

        async def close(self) -> None:
            return None

    fake_socket = FakeWebSocket()

    async def fake_connect(*args, **kwargs):
        return fake_socket

    monkeypatch.setattr(websockets, "connect", fake_connect)
    client = DoubaoClient(DoubaoConfig(api_key="test-only"), "session-for-test")

    asyncio.run(client.connect())

    assert len(fake_socket.sent) == 1
    assert fake_socket.sent[0][1] >> 4 == FULL_CLIENT_REQUEST


def test_provider_response_and_error_are_parsed_without_credentials() -> None:
    payload = gzip.compress(
        json.dumps(
            {
                "result": {
                    "text": "虚构转写",
                    "utterances": [{"text": "虚构转写", "definite": True}],
                }
            },
            ensure_ascii=False,
        ).encode()
    )
    response = bytes([0x11, 0x91, 0x11, 0x00])
    response += (1).to_bytes(4, "big", signed=True)
    response += len(payload).to_bytes(4, "big")
    response += payload

    parsed = parse_response(response)

    assert parsed["payload"]["result"]["text"] == "虚构转写"
    assert parsed["is_last"] is False

    message = json.dumps({"message": "bad request"}).encode()
    error = bytes([0x11, SERVER_ERROR_RESPONSE << 4, 0x10, 0x00])
    error += (45000000).to_bytes(4, "big")
    error += len(message).to_bytes(4, "big")
    error += message
    with pytest.raises(RuntimeError, match="45000000"):
        parse_response(error)
