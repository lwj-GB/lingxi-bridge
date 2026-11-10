from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Request

from lingxi.api.errors import ApiError
from lingxi.mobile.archive import MAX_BYTES, load_json
from lingxi.mobile.receiver import MobileReceiver
from lingxi.mobile.store import MobileArchiveStore

router = APIRouter(prefix="/api/mobile")


def _trusted_control(request: Request) -> None:
    origin = request.headers.get("origin")
    if (
        origin is not None
        and origin
        not in {
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        }
        and re.fullmatch(r"http://(?:localhost|127\.0\.0\.1)(?::\d+)?", origin) is None
    ):
        raise ApiError(403, "mobile_origin_forbidden", "手机接收只能由本机工作台开启或管理。")


def _receiver(request: Request) -> MobileReceiver:
    return request.app.state.mobile_receiver


def _workspace(request: Request):
    workspace = request.app.state.workspace
    if workspace is None:
        raise ApiError(422, "workspace_not_open", "请先打开接收手机记录的工作区。")
    return workspace


def _checked_workspace(request: Request):
    workspace = _workspace(request)
    expected = request.headers.get("x-lingxi-workspace")
    if expected is not None:
        try:
            if re.search(r"%(?![0-9A-Fa-f]{2})", expected):
                raise ValueError("invalid workspace header encoding")
            expected = unquote(expected, errors="strict")
            matches = (
                Path(expected).is_absolute()
                and Path(expected).resolve() == workspace.root_path.resolve()
            )
        except (ValueError, OSError):
            matches = False
        if not matches:
            raise _workspace_changed()
    return workspace


def _workspace_changed():
    return ApiError(409, "mobile_workspace_changed", "工作区已切换，请刷新手机页后重试。")


def _store(request: Request) -> MobileArchiveStore:
    return MobileArchiveStore(_workspace(request).root_path)


def _error():
    return ApiError(422, "mobile_archive_invalid", "手机归档无效或原件已改动，请核对后重新导出。")


@router.get("/archives")
def list_mobile_archives(request: Request) -> dict:
    with _receiver(request).lock:
        try:
            return {"archives": _store(request).list_archives()}
        except (ValueError, OSError, KeyError, TypeError, UnicodeError, RecursionError) as exc:
            raise _error() from exc


@router.get("/archives/{archive_id}")
def read_mobile_archive(archive_id: str, request: Request) -> dict:
    with _receiver(request).lock:
        try:
            return _store(request).read(archive_id)
        except KeyError as exc:
            raise ApiError(404, "mobile_archive_not_found", "未找到这份手机归档。") from exc
        except (ValueError, OSError, TypeError, UnicodeError, RecursionError) as exc:
            raise _error() from exc


@router.post("/import")
async def import_mobile_archive(request: Request) -> dict:
    _trusted_control(request)
    if (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "application/json"
    ):
        raise ApiError(415, "mobile_content_type_invalid", "请以 JSON 格式导入手机归档。")
    with _receiver(request).lock:
        workspace = _checked_workspace(request)
        root = workspace.root_path
    raw_body = bytearray()
    async for chunk in request.stream():
        raw_body.extend(chunk)
        # A string-wrapped JSON file can expand through escaping; cap before parsing too.
        if len(raw_body) > MAX_BYTES * 2:
            raise ApiError(413, "mobile_archive_too_large", "归档包过大，请按日导出。")
    try:
        payload = load_json(bytes(raw_body))
        if not isinstance(payload, dict) or set(payload) != {"archive"}:
            raise ValueError("invalid import wrapper")
        value: Any = payload["archive"]
        raw = (
            value.encode("utf-8")
            if isinstance(value, str)
            else json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        )
        with _receiver(request).lock:
            if request.app.state.workspace is not workspace or workspace.root_path != root:
                raise _workspace_changed()
            result = MobileArchiveStore(root).receive(raw)
            return {"id": result["id"], "status": result["status"]}
    except (ValueError, OSError, KeyError, TypeError, UnicodeError, RecursionError) as exc:
        raise _error() from exc


@router.get("/receiver")
def mobile_receiver_status(request: Request) -> dict:
    return _receiver(request).status()


@router.post("/receiver/start")
def start_mobile_receiver(request: Request) -> dict:
    _trusted_control(request)
    with _receiver(request).lock:
        workspace = _checked_workspace(request)
        try:
            return _receiver(request).start(workspace, workspace.root_path)
        except (OSError, ValueError) as exc:
            raise ApiError(
                503, "mobile_receiver_unavailable", "无法开启手机接收，请检查网络或收件箱路径。"
            ) from exc


@router.post("/receiver/stop")
def stop_mobile_receiver(request: Request) -> dict:
    _trusted_control(request)
    with _receiver(request).lock:
        if request.headers.get("x-lingxi-workspace") is not None:
            _checked_workspace(request)
        return _receiver(request).stop()
