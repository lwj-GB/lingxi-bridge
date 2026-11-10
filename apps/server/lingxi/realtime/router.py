from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jsonschema import ValidationError

from lingxi.analysis.direct_api import DirectApiAdapter, DirectModelSettings
from lingxi.analysis.schema import schema_validator
from lingxi.realtime.analysis import LiveSessionState
from lingxi.realtime.api_analysis import LiveApiAnalysis
from lingxi.realtime.doubao import DoubaoClient, DoubaoConfig

router = APIRouter(prefix="/api")

_DESTINATIONS = {
    "browser_stream": "browser_provider",
    "doubao": "volcengine_doubao",
    "demo": "local_only",
}
_DEMO_CHUNKS = (
    (0.45, 1, "我不太确定", "other", False, 0, 420),
    (
        0.45,
        2,
        "我不太确定，但是我希望先把问题说清楚。",
        "other",
        True,
        0,
        1360,
    ),
    (0.45, 3, "好，我们先确认下一步。", "me", True, 1360, 2240),
)
_TAURI_ORIGINS = {
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
}
_DOUBAO_FINAL_TIMEOUT_SECONDS = 8


def _origin_is_allowed(origin: str | None) -> bool:
    if origin is None:
        return True
    if origin in _TAURI_ORIGINS:
        return True
    parsed = urlsplit(origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and parsed.username is None
        and parsed.password is None
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
    )


def _validate_event(event: dict[str, Any]) -> None:
    schema_validator("live-session.schema.json").validate(event)


async def _send(websocket: WebSocket, event: dict[str, Any]) -> None:
    _validate_event(event)
    await websocket.send_json(event)


async def _send_error(
    websocket: WebSocket,
    *,
    code: str,
    message: str,
    recoverable: bool,
) -> None:
    await _send(
        websocket,
        {
            "type": "error",
            "code": code,
            "message": message,
            "recoverable": recoverable,
        },
    )


async def _send_started(
    websocket: WebSocket,
    *,
    session_id: str,
    recognizer: str,
) -> None:
    await _send(
        websocket,
        {
            "type": "started",
            "session_id": session_id,
            "recognizer": recognizer,
            "data_destination": _DESTINATIONS[recognizer],
            "audio_saved": False,
        },
    )


async def _emit_state_update(
    websocket: WebSocket,
    state: LiveSessionState,
    *,
    sequence: int,
    text: str,
    speaker: str,
    is_final: bool,
    start_ms: int,
    end_ms: int,
    snapshot: bool = False,
    api_analysis: LiveApiAnalysis | None = None,
) -> None:
    previous_committed = state.committed_text
    apply = state.apply_snapshot if snapshot else state.apply_chunk
    transcript, cards = apply(
        sequence=sequence,
        text=text,
        speaker=speaker,
        is_final=is_final,
        start_ms=start_ms,
        end_ms=end_ms,
    )
    await _send(websocket, transcript)
    await _send(websocket, {"type": "analysis_snapshot", "cards": cards})
    insight = state.consume_insight_event()
    if api_analysis is None and insight is not None:
        await _send(websocket, insight)
    if api_analysis is not None and is_final and speaker == "other":
        api_text = transcript["text"]
        if snapshot:
            api_text = (
                state.committed_text[len(previous_committed) :]
                if state.committed_text.startswith(previous_committed)
                else ""
            )
        await api_analysis.submit(api_text, end_ms)


async def _run_demo(
    websocket: WebSocket,
    *,
    session_id: str,
    state: LiveSessionState,
    api_analysis: LiveApiAnalysis | None = None,
) -> None:
    await _send_started(websocket, session_id=session_id, recognizer="demo")
    control_task = asyncio.create_task(websocket.receive_json())
    try:
        for delay, sequence, text, speaker, is_final, start_ms, end_ms in _DEMO_CHUNKS:
            done, _ = await asyncio.wait({control_task}, timeout=delay)
            if control_task in done:
                try:
                    event = control_task.result()
                    _validate_event(event)
                except WebSocketDisconnect:
                    return
                except (ValidationError, TypeError):
                    await _send_error(
                        websocket,
                        code="invalid_event",
                        message="本地演示只接受停止事件。",
                        recoverable=True,
                    )
                    control_task = asyncio.create_task(websocket.receive_json())
                else:
                    if event["type"] == "stop":
                        if api_analysis is not None:
                            await api_analysis.close()
                        break
                    if event["type"] == "analysis_control":
                        if api_analysis is not None:
                            await api_analysis.set_enabled(event["enabled"])
                    else:
                        await _send_error(
                            websocket,
                            code="unexpected_event",
                            message="本地演示只接受停止或分析开关事件。",
                            recoverable=True,
                        )
                    control_task = asyncio.create_task(websocket.receive_json())
            await _emit_state_update(
                websocket,
                state,
                sequence=sequence,
                text=text,
                speaker=speaker,
                is_final=is_final,
                start_ms=start_ms,
                end_ms=end_ms,
                api_analysis=api_analysis,
            )
    finally:
        if not control_task.done():
            control_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await control_task
    if api_analysis is not None:
        await api_analysis.close()
    await _send(
        websocket,
        {
            "type": "ended",
            "transcript": state.transcript,
            "analysis_count": state.analysis_count,
        },
    )


async def _run_browser_stream(
    websocket: WebSocket,
    *,
    session_id: str,
    state: LiveSessionState,
    api_analysis: LiveApiAnalysis | None = None,
) -> None:
    await _send_started(websocket, session_id=session_id, recognizer="browser_stream")
    last_sequence = -1
    while True:
        try:
            event = await websocket.receive_json()
        except WebSocketDisconnect:
            return
        try:
            _validate_event(event)
        except (ValidationError, TypeError):
            await _send_error(
                websocket,
                code="invalid_event",
                message="实时转写事件格式无效。",
                recoverable=True,
            )
            continue
        if event["type"] == "stop":
            if api_analysis is not None:
                await api_analysis.close()
            break
        if event["type"] == "analysis_control":
            if api_analysis is not None:
                await api_analysis.set_enabled(event["enabled"])
            continue
        if event["type"] != "transcript":
            await _send_error(
                websocket,
                code="unexpected_event",
                message="浏览器识别会话只接受转写增量或停止事件。",
                recoverable=True,
            )
            continue
        if event["sequence"] <= last_sequence:
            continue
        last_sequence = event["sequence"]
        await _emit_state_update(
            websocket,
            state,
            sequence=event["sequence"],
            text=event["text"],
            speaker=event["speaker"],
            is_final=event["is_final"],
            start_ms=event["start_ms"],
            end_ms=event["end_ms"],
            api_analysis=api_analysis,
        )
    if api_analysis is not None:
        await api_analysis.close()
    await _send(
        websocket,
        {
            "type": "ended",
            "transcript": state.transcript,
            "analysis_count": state.analysis_count,
        },
    )


def _provider_result(parsed: dict[str, Any]) -> tuple[str, bool, int]:
    payload = parsed.get("payload") or {}
    result = payload.get("result") or payload
    text = result.get("text", "") if isinstance(result, dict) else ""
    utterances = result.get("utterances", []) if isinstance(result, dict) else []
    valid_utterances = [item for item in utterances if isinstance(item, dict)]
    is_final = parsed.get("is_last", False) or (
        bool(valid_utterances) and all(item.get("definite", False) for item in valid_utterances)
    )
    audio_info = payload.get("audio_info") or {}
    end_ms = audio_info.get("duration", 0) if isinstance(audio_info, dict) else 0
    return text.strip(), bool(is_final), max(0, int(end_ms))


async def _run_doubao(
    websocket: WebSocket,
    *,
    session_id: str,
    state: LiveSessionState,
    config: DoubaoConfig,
    default_speaker: str,
    api_analysis: LiveApiAnalysis | None = None,
) -> None:
    client = DoubaoClient(config, session_id)
    await _send(
        websocket,
        {
            "type": "status",
            "phase": "connecting",
            "message": "正在连接豆包流式语音识别。",
        },
    )
    try:
        await client.connect()
        await _send_started(websocket, session_id=session_id, recognizer="doubao")
        input_task = asyncio.create_task(websocket.receive())
        provider_task = asyncio.create_task(client.receive())
        sequence = 0
        last_text = ""
        last_is_final: bool | None = None
        current_speaker = default_speaker
        stopping = False
        while True:
            done, _ = await asyncio.wait(
                {input_task, provider_task},
                return_when=asyncio.FIRST_COMPLETED,
                timeout=_DOUBAO_FINAL_TIMEOUT_SECONDS if stopping else None,
            )
            if not done and stopping:
                await _send_error(
                    websocket,
                    code="doubao_final_result_timeout",
                    message="等待豆包最后一段转写超时；当前确认稿可能不完整，请核对后再保存。",
                    recoverable=False,
                )
                return
            if input_task in done:
                message = input_task.result()
                if message["type"] == "websocket.disconnect":
                    return
                if message.get("bytes") is not None:
                    audio = message["bytes"]
                    if not audio or len(audio) > 64 * 1024:
                        await _send_error(
                            websocket,
                            code="invalid_audio_chunk",
                            message="音频分片必须是非空且不超过 64 KB 的 PCM 数据。",
                            recoverable=True,
                        )
                    else:
                        await client.send_audio(audio)
                elif message.get("text") is not None:
                    try:
                        event = message["text"]
                        parsed_event = json.loads(event)
                        _validate_event(parsed_event)
                    except (json.JSONDecodeError, ValidationError, TypeError):
                        await _send_error(
                            websocket,
                            code="invalid_event",
                            message="实时语音控制事件格式无效。",
                            recoverable=True,
                        )
                    else:
                        if parsed_event["type"] == "stop":
                            stopping = True
                            if api_analysis is not None:
                                await api_analysis.close()
                            await _send(
                                websocket,
                                {
                                    "type": "status",
                                    "phase": "stopping",
                                    "message": "正在等待最后一段转写。",
                                },
                            )
                            await client.send_audio(b"", final=True)
                        elif parsed_event["type"] == "analysis_control":
                            if api_analysis is not None:
                                await api_analysis.set_enabled(parsed_event["enabled"])
                        elif parsed_event["type"] == "speaker_selection":
                            current_speaker = parsed_event["speaker"]
                        else:
                            await _send_error(
                                websocket,
                                code="unexpected_event",
                                message="豆包识别会话只接受 PCM 音频或停止事件。",
                                recoverable=True,
                            )
                if not stopping:
                    input_task = asyncio.create_task(websocket.receive())
            if provider_task in done:
                parsed = provider_task.result()
                text, is_final, end_ms = _provider_result(parsed)
                repeated_final_prefix = last_is_final is True and not is_final and text == last_text
                if (
                    text
                    and not repeated_final_prefix
                    and (text != last_text or is_final != last_is_final)
                ):
                    sequence += 1
                    await _emit_state_update(
                        websocket,
                        state,
                        sequence=sequence,
                        text=text,
                        speaker=current_speaker,
                        is_final=is_final,
                        start_ms=0,
                        end_ms=end_ms,
                        snapshot=True,
                        api_analysis=api_analysis,
                    )
                    last_text = text
                    last_is_final = is_final
                if parsed.get("is_last"):
                    break
                provider_task = asyncio.create_task(client.receive())
            if stopping and input_task in done:
                input_task = asyncio.create_task(asyncio.sleep(3600))
        if api_analysis is not None:
            await api_analysis.close()
        await _send(
            websocket,
            {
                "type": "ended",
                "transcript": state.transcript,
                "analysis_count": state.analysis_count,
            },
        )
    finally:
        for task in (locals().get("input_task"), locals().get("provider_task")):
            if isinstance(task, asyncio.Task) and not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        await client.close()


@router.websocket("/live")
async def live_session(websocket: WebSocket) -> None:
    if not _origin_is_allowed(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        start = await websocket.receive_json()
        _validate_event(start)
        if start["type"] != "start":
            raise ValidationError("first event must start the session")
    except WebSocketDisconnect:
        return
    except (ValidationError, TypeError, ValueError):
        await _send_error(
            websocket,
            code="invalid_start",
            message="开始实时会话前必须选择识别方式并确认参与者同意。",
            recoverable=True,
        )
        return

    session_id = str(uuid.uuid4())
    state = LiveSessionState(
        analysis_mode=start["analysis_mode"] if "analysis_mode" in start else "legacy",
        goal=start.get("goal", ""),
    )
    recognizer = start["recognizer"]
    api_analysis = None
    if "analysis_api" in start:
        settings = getattr(websocket.app.state, "direct_model_settings", DirectModelSettings())
        api_analysis = LiveApiAnalysis(
            DirectApiAdapter(settings, timeout_seconds=15),
            lambda event: _send(websocket, event),
            enabled=start["analysis_api"].get("enabled", True),
            mode=start.get("analysis_mode", "observe"),
            goal=start.get("goal", ""),
        )
        if not api_analysis.configured:
            await api_analysis.set_enabled(True)
    try:
        if recognizer == "demo":
            await _run_demo(
                websocket,
                session_id=session_id,
                state=state,
                api_analysis=api_analysis,
            )
        elif recognizer == "browser_stream":
            await _run_browser_stream(
                websocket,
                session_id=session_id,
                state=state,
                api_analysis=api_analysis,
            )
        else:
            try:
                config = DoubaoConfig.from_env()
            except ValueError as exc:
                await _send_error(
                    websocket,
                    code="doubao_configuration_invalid",
                    message=str(exc),
                    recoverable=True,
                )
                return
            if config is None:
                await _send_error(
                    websocket,
                    code="doubao_not_configured",
                    message="尚未配置豆包凭据；可先使用浏览器识别或本地演示。",
                    recoverable=True,
                )
                return
            await _run_doubao(
                websocket,
                session_id=session_id,
                state=state,
                config=config,
                default_speaker=start["default_speaker"],
                api_analysis=api_analysis,
            )
    except WebSocketDisconnect:
        return
    except Exception:
        await _send_error(
            websocket,
            code="live_session_failed",
            message="实时会话未能继续，请重试或切换识别方式。",
            recoverable=False,
        )

    finally:
        if api_analysis is not None:
            await api_analysis.close()
