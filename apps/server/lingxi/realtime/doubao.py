from __future__ import annotations

import gzip
import json
import os
import uuid
from dataclasses import dataclass, field
from typing import Any

FULL_CLIENT_REQUEST = 0x1
AUDIO_ONLY_REQUEST = 0x2
FULL_SERVER_RESPONSE = 0x9
SERVER_ACK = 0xB
SERVER_ERROR_RESPONSE = 0xF
GZIP = 0x1
NONE = 0x0
JSON = 0x1
DOUBAO_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"


def _header(
    message_type: int,
    *,
    flags: int = 0,
    serialization: int = JSON,
    compression: int = GZIP,
) -> bytes:
    return bytes(
        [
            0x11,
            (message_type << 4) | flags,
            (serialization << 4) | compression,
            0x00,
        ]
    )


def build_full_request(session_id: str) -> bytes:
    body = {
        "user": {"uid": session_id},
        "audio": {
            "format": "pcm",
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1,
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "show_utterances": True,
            "result_type": "full",
            "enable_nonstream": True,
        },
    }
    payload = gzip.compress(
        json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    )
    return _header(FULL_CLIENT_REQUEST) + len(payload).to_bytes(4, "big") + payload


def build_audio_frame(audio: bytes, *, final: bool = False) -> bytes:
    payload = gzip.compress(audio)
    return (
        _header(
            AUDIO_ONLY_REQUEST,
            flags=0x2 if final else 0,
            serialization=NONE,
        )
        + len(payload).to_bytes(4, "big")
        + payload
    )


def parse_response(frame: bytes) -> dict[str, Any]:
    if len(frame) < 4:
        raise RuntimeError("豆包返回了不完整的协议帧。")
    header_size = (frame[0] & 0x0F) * 4
    message_type = frame[1] >> 4
    flags = frame[1] & 0x0F
    serialization = frame[2] >> 4
    compression = frame[2] & 0x0F
    payload = frame[header_size:]
    sequence = None
    if flags & 0x1:
        if len(payload) < 4:
            raise RuntimeError("豆包返回了缺少序号的协议帧。")
        sequence = int.from_bytes(payload[:4], "big", signed=True)
        payload = payload[4:]
    if message_type == SERVER_ERROR_RESPONSE:
        if len(payload) < 8:
            raise RuntimeError("豆包返回了不完整的错误帧。")
        code = int.from_bytes(payload[:4], "big")
        size = int.from_bytes(payload[4:8], "big")
        message = payload[8 : 8 + size].decode("utf-8", errors="replace")
        raise RuntimeError(f"豆包语音识别失败（{code}）：{message}")
    if message_type not in (FULL_SERVER_RESPONSE, SERVER_ACK):
        return {"payload": {}, "sequence": sequence, "is_last": bool(flags & 0x2)}
    if message_type == SERVER_ACK:
        if len(payload) < 4:
            return {"payload": {}, "sequence": sequence, "is_last": bool(flags & 0x2)}
        payload = payload[4:]
    if len(payload) < 4:
        return {"payload": {}, "sequence": sequence, "is_last": bool(flags & 0x2)}
    size = int.from_bytes(payload[:4], "big")
    content = payload[4 : 4 + size]
    if compression == GZIP and content:
        content = gzip.decompress(content)
    decoded: Any = content
    if serialization == JSON and content:
        decoded = json.loads(content.decode("utf-8"))
    return {
        "payload": decoded if isinstance(decoded, dict) else {},
        "sequence": sequence,
        "is_last": bool(flags & 0x2),
    }


@dataclass(frozen=True)
class DoubaoConfig:
    api_key: str | None = field(default=None, repr=False)
    app_key: str | None = field(default=None, repr=False)
    access_key: str | None = field(default=None, repr=False)
    resource_id: str = "volc.seedasr.sauc.duration"
    url: str = DOUBAO_URL

    @classmethod
    def from_env(cls) -> DoubaoConfig | None:
        api_key = os.getenv("LINGXI_DOUBAO_API_KEY")
        app_key = os.getenv("LINGXI_DOUBAO_APP_KEY")
        access_key = os.getenv("LINGXI_DOUBAO_ACCESS_KEY")
        if not api_key and not app_key and not access_key:
            return None
        if not api_key and (not app_key or not access_key):
            raise ValueError(
                "旧版豆包鉴权必须同时配置 LINGXI_DOUBAO_APP_KEY 和 "
                "LINGXI_DOUBAO_ACCESS_KEY。"
            )
        return cls(
            api_key=api_key,
            app_key=app_key,
            access_key=access_key,
            resource_id=os.getenv(
                "LINGXI_DOUBAO_RESOURCE_ID",
                "volc.seedasr.sauc.duration",
            ),
        )

    def headers(self) -> dict[str, str]:
        headers = {
            "X-Api-Resource-Id": self.resource_id,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        if self.api_key:
            headers["X-Api-Key"] = self.api_key
        else:
            headers["X-Api-App-Key"] = self.app_key or ""
            headers["X-Api-Access-Key"] = self.access_key or ""
        return headers


class DoubaoClient:
    def __init__(self, config: DoubaoConfig, session_id: str):
        self.config = config
        self.session_id = session_id
        self.websocket: Any = None

    async def connect(self) -> None:
        import websockets

        self.websocket = await websockets.connect(
            self.config.url,
            additional_headers=self.config.headers(),
            max_size=8 * 1024 * 1024,
            ping_interval=20,
            open_timeout=10,
        )
        await self.websocket.send(build_full_request(self.session_id))

    async def send_audio(self, audio: bytes, *, final: bool = False) -> None:
        if self.websocket is None:
            raise RuntimeError("豆包语音识别连接尚未建立。")
        await self.websocket.send(build_audio_frame(audio, final=final))

    async def receive(self) -> dict[str, Any]:
        if self.websocket is None:
            raise RuntimeError("豆包语音识别连接尚未建立。")
        return parse_response(await self.websocket.recv())

    async def close(self) -> None:
        if self.websocket is not None:
            await self.websocket.close()
            self.websocket = None
