from __future__ import annotations

import copy
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from jsonschema.exceptions import ValidationError

from lingxi.analysis.schema import schema_validator

TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}


class ScreenshotJobError(RuntimeError):
    """A safe error that can cross the local HTTP API boundary."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 422,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


class ScreenshotAdapter(Protocol):
    def recognize(
        self,
        source_id: str,
        path: str | Path,
        *,
        cancel_event: threading.Event,
    ) -> dict[str, Any]: ...


class _UnsupportedScreenshotAdapter:
    def recognize(
        self,
        _source_id: str,
        _path: str | Path,
        *,
        cancel_event: threading.Event,
    ) -> dict[str, Any]:
        if cancel_event.is_set():
            raise ScreenshotJobError(
                "execution_cancelled",
                "截图识别任务已取消。",
                status_code=409,
            )
        raise ScreenshotJobError(
            "screenshot_recognition_unsupported",
            "当前执行器尚未配置截图识别能力。",
            status_code=503,
        )


def _default_adapter_factory(
    _engine: str,
    _profile_id: str,
) -> ScreenshotAdapter:
    return _UnsupportedScreenshotAdapter()


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class _Job:
    id: str
    source_ids: list[str]
    originals: list[Path]
    engine: str
    profile_id: str
    status: str = "queued"
    results: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    completed: int = 0
    succeeded: int = 0
    failed: int = 0
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "engine": self.engine,
            "profile_id": self.profile_id,
            "source_ids": list(self.source_ids),
            "progress": {
                "completed": self.completed,
                "total": len(self.source_ids),
                "succeeded": self.succeeded,
                "failed": self.failed,
            },
            "results": copy.deepcopy(self.results),
            "errors": copy.deepcopy(self.errors),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class ScreenshotJobManager:
    """Run screenshot recognition in memory without confirming or writing evidence."""

    def __init__(
        self,
        *,
        adapter_factory: Callable[[str, str], ScreenshotAdapter] | None = None,
        max_workers: int = 1,
    ) -> None:
        if max_workers < 1:
            raise ValueError("max_workers must be at least 1")
        self._adapter_factory = adapter_factory or _default_adapter_factory
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="lingxi-screenshot",
        )
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.RLock()
        self._shut_down = False

    def submit(
        self,
        workspace: Any,
        source_ids: list[str],
        engine: str,
        profile_id: str,
    ) -> dict[str, Any]:
        with self._lock:
            if self._shut_down:
                raise ScreenshotJobError(
                    "screenshot_jobs_shut_down",
                    "截图识别任务管理器已经停止。",
                    status_code=503,
                )

        if not 1 <= len(source_ids) <= 20:
            raise ScreenshotJobError(
                "screenshot_count_out_of_range",
                "A job requires 1 to 20 screenshot sources.",
                details={"count": len(source_ids), "minimum": 1, "maximum": 20},
            )
        if len(source_ids) != len(set(source_ids)):
            raise ScreenshotJobError(
                "duplicate_screenshot_source",
                "截图识别任务中的来源不得重复。",
            )
        if engine not in {"claude", "codex"}:
            raise ScreenshotJobError(
                "unsupported_engine",
                "截图识别执行器必须是 claude 或 codex。",
            )
        if not isinstance(profile_id, str) or not profile_id:
            raise ScreenshotJobError(
                "invalid_profile",
                "截图识别配置档不能为空。",
            )

        originals = [
            self._resolve_original(workspace, source_id) for source_id in source_ids
        ]
        job = _Job(
            id=str(uuid4()),
            source_ids=list(source_ids),
            originals=originals,
            engine=engine,
            profile_id=profile_id,
        )
        with self._lock:
            if self._shut_down:
                raise ScreenshotJobError(
                    "screenshot_jobs_shut_down",
                    "截图识别任务管理器已经停止。",
                    status_code=503,
                )
            self._jobs[job.id] = job
            self._executor.submit(self._run_job, job.id)
            return job.snapshot()

    def get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            return self._require_job(job_id).snapshot()

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._require_job(job_id)
            if job.status not in TERMINAL_STATUSES:
                job.cancel_event.set()
                job.status = "cancelled"
                job.updated_at = _now()
            return job.snapshot()

    def shutdown(self) -> None:
        with self._lock:
            if self._shut_down:
                return
            self._shut_down = True
            for job in self._jobs.values():
                if job.status not in TERMINAL_STATUSES:
                    job.cancel_event.set()
                    job.status = "cancelled"
                    job.updated_at = _now()
        self._executor.shutdown(wait=True, cancel_futures=True)

    def _run_job(self, job_id: str) -> None:
        with self._lock:
            job = self._require_job(job_id)
            if job.status == "cancelled":
                return
            job.status = "running"
            job.updated_at = _now()

        try:
            adapter = self._adapter_factory(job.engine, job.profile_id)
        except Exception as error:
            code, message = self._safe_error(error, adapter_creation=True)
            self._fail_remaining(job, code, message)
            return

        for source_id, path in zip(job.source_ids, job.originals, strict=True):
            if job.cancel_event.is_set():
                self._mark_cancelled(job)
                return
            try:
                result = adapter.recognize(
                    source_id,
                    path,
                    cancel_event=job.cancel_event,
                )
                item = self._validate_single_result(result, source_id)
            except Exception as error:
                if job.cancel_event.is_set():
                    self._mark_cancelled(job)
                    return
                code, message = self._safe_error(error)
                self._record_error(job, source_id, code, message)
            else:
                self._record_result(job, item)

        with self._lock:
            if job.status == "cancelled":
                return
            job.status = "succeeded" if job.failed == 0 else "failed"
            job.updated_at = _now()

    @staticmethod
    def _resolve_original(workspace: Any, source_id: str) -> Path:
        original = workspace.get_source_original(source_id)
        if not isinstance(original, dict):
            raise ScreenshotJobError(
                "invalid_source_original",
                "工作区返回的截图原件信息无效。",
                details={"source_id": source_id},
            )
        if original.get("source_id") != source_id:
            raise ScreenshotJobError(
                "source_original_mismatch",
                "工作区返回的截图原件与请求来源不匹配。",
                details={"source_id": source_id},
            )
        if original.get("source_kind") != "screenshot":
            raise ScreenshotJobError(
                "source_not_screenshot",
                "截图识别任务只能使用 screenshot 来源。",
                details={"source_id": source_id},
            )
        raw_path = original.get("path")
        if not isinstance(raw_path, str):
            raise ScreenshotJobError(
                "invalid_source_original",
                "截图来源没有有效的本地原件路径。",
                details={"source_id": source_id},
            )
        path = Path(raw_path)
        if not path.is_absolute() or not path.is_file():
            raise ScreenshotJobError(
                "source_original_unavailable",
                "截图原件不是可读取的本地文件。",
                details={"source_id": source_id},
            )
        return path

    @staticmethod
    def _validate_single_result(
        result: dict[str, Any],
        source_id: str,
    ) -> dict[str, Any]:
        try:
            schema_validator("screenshot-recognition.schema.json").validate(result)
            items = result["items"]
            if len(items) != 1 or items[0]["source_id"] != source_id:
                raise ValueError
            return copy.deepcopy(items[0])
        except (KeyError, TypeError, ValueError, ValidationError) as error:
            raise ScreenshotJobError(
                "invalid_structured_output",
                "截图识别器返回了无效的结构化结果。",
            ) from error

    def _record_result(self, job: _Job, item: dict[str, Any]) -> None:
        with self._lock:
            if job.status == "cancelled":
                return
            job.results.append(item)
            job.completed += 1
            job.succeeded += 1
            job.updated_at = _now()

    def _record_error(
        self,
        job: _Job,
        source_id: str,
        code: str,
        message: str,
    ) -> None:
        with self._lock:
            if job.status == "cancelled":
                return
            job.errors.append(
                {"source_id": source_id, "code": code, "message": message}
            )
            job.completed += 1
            job.failed += 1
            job.updated_at = _now()

    def _fail_remaining(self, job: _Job, code: str, message: str) -> None:
        for source_id in job.source_ids:
            if job.cancel_event.is_set():
                self._mark_cancelled(job)
                return
            self._record_error(job, source_id, code, message)
        with self._lock:
            if job.status != "cancelled":
                job.status = "failed"
                job.updated_at = _now()

    def _mark_cancelled(self, job: _Job) -> None:
        with self._lock:
            job.status = "cancelled"
            job.updated_at = _now()

    @staticmethod
    def _safe_error(
        error: Exception,
        *,
        adapter_creation: bool = False,
    ) -> tuple[str, str]:
        if isinstance(error, ScreenshotJobError):
            return error.code, error.message
        if adapter_creation:
            return (
                "screenshot_adapter_unavailable",
                "截图识别执行器无法启动。",
            )
        return (
            "screenshot_recognition_failed",
            "截图识别未能完成。",
        )

    def _require_job(self, job_id: str) -> _Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise ScreenshotJobError(
                "screenshot_job_not_found",
                "截图识别任务不存在。",
                status_code=404,
                details={"job_id": job_id},
            )
        return job
