from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from lingxi.analysis.cli import CliAdapter, CliExecutionError
from lingxi.analysis.executors import resolve_executable
from lingxi.analysis.screenshot_jobs import ScreenshotJobManager
from lingxi.api.assistant_create import router as assistant_create_router
from lingxi.api.errors import ApiError
from lingxi.api.mobile import router as mobile_router
from lingxi.api.local_speech import router as local_speech_router
from lingxi.api.local_voiceprint import router as local_voiceprint_router
from lingxi.mobile.receiver import MobileReceiver
from lingxi.api.router import restore_recent_workspace, router
from lingxi.realtime.router import router as realtime_router
from lingxi.terminal import router as terminal_router


def _default_workspace_factory() -> Any:
    from lingxi.workspace import WorkspaceService

    return WorkspaceService()


def _default_cli_adapter_factory(engine: str, _profile_id: str) -> CliAdapter:
    executable = resolve_executable(engine)
    if executable is None:
        raise CliExecutionError("analysis executable is unavailable")
    return CliAdapter(engine, executable, profile_id=_profile_id)  # type: ignore[arg-type]


def create_app(
    workspace_factory: Callable[[], Any] | None = None,
    cli_adapter_factory: Callable[[str, str], Any] | None = None,
    screenshot_jobs: Any | None = None,
    recent_workspace_file: Path | None = None,
) -> FastAPI:
    job_manager = screenshot_jobs or ScreenshotJobManager()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        restore_recent_workspace(_app)
        yield
        _app.state.mobile_receiver.stop()
        job_manager.shutdown()
        for session in tuple(_app.state.terminal_sessions):
            session.close()
        _app.state.terminal_sessions.clear()

    app = FastAPI(
        title="Lingxi Bridge Local API",
        version="0.2.0",
        lifespan=lifespan,
    )
    app.state.workspace = None
    app.state.mobile_receiver = MobileReceiver(lambda: app.state.workspace)
    app.state.terminal_sessions = set()
    app.state.recent_workspace_file = recent_workspace_file
    app.state.screenshot_jobs = job_manager
    if workspace_factory is None:
        workspace_factory = _default_workspace_factory
    app.state.workspace_factory = workspace_factory
    if cli_adapter_factory is None:
        cli_adapter_factory = _default_cli_adapter_factory
    app.state.cli_adapter_factory = cli_adapter_factory
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ],
        allow_origin_regex=r"^http://(?:localhost|127\.0\.0\.1)(?::\d+)?$",
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Lingxi-Workspace"],
    )

    @app.exception_handler(ApiError)
    async def handle_api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "details": exc.details,
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation(
        _request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        issues = [
            {
                "path": ".".join(str(part) for part in error["loc"]),
                "type": error["type"],
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "请求数据无效。",
                    "details": {"issues": issues},
                }
            },
        )

    @app.exception_handler(HTTPException)
    async def handle_http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        code, message = {
            404: ("not_found", "未找到请求的接口。"),
            405: ("method_not_allowed", "该接口不支持此请求方法。"),
        }.get(exc.status_code, ("http_error", "请求未能完成。"))
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": code,
                    "message": message,
                    "details": {},
                }
            },
            headers=exc.headers,
        )

    app.include_router(router)
    app.include_router(mobile_router)
    app.include_router(local_speech_router)
    app.include_router(local_voiceprint_router)
    app.include_router(assistant_create_router)
    app.include_router(realtime_router)
    app.include_router(terminal_router)
    return app


app = create_app()
