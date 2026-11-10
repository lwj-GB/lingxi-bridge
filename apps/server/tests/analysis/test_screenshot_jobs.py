from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from lingxi.analysis.screenshot_jobs import (
    ScreenshotJobError,
    ScreenshotJobManager,
)


def _source_id(position: int) -> str:
    return f"20000000-0000-4000-8000-{position:012d}"


class FakeWorkspace:
    def __init__(
        self,
        root: Path,
        source_ids: list[str],
        *,
        source_kind: str = "screenshot",
    ) -> None:
        self.calls: list[str] = []
        self.originals: dict[str, dict[str, str]] = {}
        for position, source_id in enumerate(source_ids):
            path = root / f"{position:02d}.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes([position]))
            self.originals[source_id] = {
                "path": str(path.resolve()),
                "mime_type": "image/png",
                "filename": path.name,
                "source_kind": source_kind,
                "source_id": source_id,
            }

    def get_source_original(self, source_id: str) -> dict[str, str]:
        self.calls.append(source_id)
        return self.originals[source_id]


class SuccessfulAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Path]] = []

    def recognize(
        self,
        source_id: str,
        path: str | Path,
        *,
        cancel_event: threading.Event,
    ) -> dict[str, Any]:
        assert not cancel_event.is_set()
        image_path = Path(path)
        assert image_path.is_file()
        self.calls.append((source_id, image_path))
        return {
            "schema_version": "0.1",
            "items": [
                {
                    "source_id": source_id,
                    "segments": [
                        {
                            "order": 0,
                            "speaker": "unknown",
                            "text": f"虚构识别-{image_path.stem}",
                            "uncertainty": "high",
                        }
                    ],
                }
            ],
        }


def _wait_for_terminal(
    manager: ScreenshotJobManager,
    job_id: str,
    timeout: float = 2,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = manager.get(job_id)
        if job["status"] in {"succeeded", "failed", "cancelled"}:
            return job
        time.sleep(0.01)
    raise AssertionError("screenshot job did not reach a terminal state")


def test_submit_runs_one_to_twenty_local_screenshots_and_returns_schema_items(
    tmp_path: Path,
) -> None:
    source_ids = [_source_id(index) for index in range(1, 21)]
    workspace = FakeWorkspace(tmp_path, source_ids)
    adapter = SuccessfulAdapter()
    manager = ScreenshotJobManager(
        adapter_factory=lambda engine, profile_id: adapter,
        max_workers=1,
    )
    try:
        submitted = manager.submit(workspace, source_ids, "codex", "inherited")
        UUID(submitted["id"])
        assert submitted["source_ids"] == source_ids
        assert submitted["engine"] == "codex"
        assert submitted["profile_id"] == "inherited"

        completed = _wait_for_terminal(manager, submitted["id"])
        assert completed["status"] == "succeeded"
        assert completed["progress"] == {
            "completed": 20,
            "total": 20,
            "succeeded": 20,
            "failed": 0,
        }
        assert [item["source_id"] for item in completed["results"]] == source_ids
        assert completed["errors"] == []
        assert workspace.calls == source_ids
        assert [source_id for source_id, _path in adapter.calls] == source_ids
    finally:
        manager.shutdown()


@pytest.mark.parametrize("count", [0, 21])
def test_submit_rejects_out_of_range_counts(tmp_path: Path, count: int) -> None:
    source_ids = [_source_id(index) for index in range(1, count + 1)]
    manager = ScreenshotJobManager(
        adapter_factory=lambda _engine, _profile_id: SuccessfulAdapter(),
    )
    try:
        with pytest.raises(
            ScreenshotJobError,
            match="1 to 20 screenshot sources",
        ) as raised:
            manager.submit(FakeWorkspace(tmp_path, source_ids), source_ids, "codex", "p")
        assert raised.value.code == "screenshot_count_out_of_range"
    finally:
        manager.shutdown()


def test_submit_rejects_non_screenshot_and_duplicate_sources(tmp_path: Path) -> None:
    source_id = _source_id(1)
    manager = ScreenshotJobManager(
        adapter_factory=lambda _engine, _profile_id: SuccessfulAdapter(),
    )
    try:
        with pytest.raises(ScreenshotJobError) as duplicate:
            manager.submit(
                FakeWorkspace(tmp_path, [source_id]),
                [source_id, source_id],
                "claude",
                "p",
            )
        assert duplicate.value.code == "duplicate_screenshot_source"

        with pytest.raises(ScreenshotJobError) as wrong_kind:
            manager.submit(
                FakeWorkspace(tmp_path, [source_id], source_kind="text"),
                [source_id],
                "claude",
                "p",
            )
        assert wrong_kind.value.code == "source_not_screenshot"
    finally:
        manager.shutdown()


def test_invalid_adapter_output_is_per_image_error_and_does_not_stop_later_items(
    tmp_path: Path,
) -> None:
    source_ids = [_source_id(1), _source_id(2)]
    workspace = FakeWorkspace(tmp_path, source_ids)

    class PartlyInvalidAdapter(SuccessfulAdapter):
        def recognize(
            self,
            source_id: str,
            path: str | Path,
            *,
            cancel_event: threading.Event,
        ) -> dict[str, Any]:
            if source_id == source_ids[0]:
                return {
                    "schema_version": "0.1",
                    "items": [{"source_id": source_id, "segments": "not-an-array"}],
                }
            return super().recognize(
                source_id,
                path,
                cancel_event=cancel_event,
            )

    manager = ScreenshotJobManager(
        adapter_factory=lambda _engine, _profile_id: PartlyInvalidAdapter(),
    )
    try:
        submitted = manager.submit(
            workspace,
            source_ids,
            "claude",
            "isolated-test",
        )
        completed = _wait_for_terminal(manager, submitted["id"])
        assert completed["status"] == "failed"
        assert completed["progress"] == {
            "completed": 2,
            "total": 2,
            "succeeded": 1,
            "failed": 1,
        }
        assert [item["source_id"] for item in completed["results"]] == [source_ids[1]]
        assert completed["errors"] == [
            {
                "source_id": source_ids[0],
                "code": "invalid_structured_output",
                "message": "截图识别器返回了无效的结构化结果。",
            }
        ]
    finally:
        manager.shutdown()


def test_cancel_marks_running_job_and_signals_adapter(tmp_path: Path) -> None:
    source_id = _source_id(1)
    workspace = FakeWorkspace(tmp_path, [source_id])
    started = threading.Event()
    stopped = threading.Event()

    class BlockingAdapter:
        def recognize(
            self,
            _source_id: str,
            _path: str | Path,
            *,
            cancel_event: threading.Event,
        ) -> dict[str, Any]:
            started.set()
            assert cancel_event.wait(timeout=2)
            stopped.set()
            raise RuntimeError("private adapter detail")

    manager = ScreenshotJobManager(
        adapter_factory=lambda _engine, _profile_id: BlockingAdapter(),
    )
    try:
        submitted = manager.submit(
            workspace,
            [source_id],
            "codex",
            "inherited",
        )
        assert started.wait(timeout=1)
        cancelled = manager.cancel(submitted["id"])
        assert cancelled["status"] == "cancelled"
        assert stopped.wait(timeout=1)
        assert manager.get(submitted["id"])["errors"] == []
    finally:
        manager.shutdown()


def test_unknown_job_and_submit_after_shutdown_fail_clearly(tmp_path: Path) -> None:
    manager = ScreenshotJobManager()
    with pytest.raises(ScreenshotJobError) as missing:
        manager.get(_source_id(99))
    assert missing.value.code == "screenshot_job_not_found"

    manager.shutdown()
    manager.shutdown()
    source_id = _source_id(1)
    with pytest.raises(ScreenshotJobError) as stopped:
        manager.submit(
            FakeWorkspace(tmp_path, [source_id]),
            [source_id],
            "codex",
            "inherited",
        )
    assert stopped.value.code == "screenshot_jobs_shut_down"


def test_default_adapter_fails_without_fabricating_recognition(
    tmp_path: Path,
) -> None:
    source_id = _source_id(1)
    manager = ScreenshotJobManager()
    try:
        submitted = manager.submit(
            FakeWorkspace(tmp_path, [source_id]),
            [source_id],
            "codex",
            "inherited",
        )
        completed = _wait_for_terminal(manager, submitted["id"])
        assert completed["status"] == "failed"
        assert completed["results"] == []
        assert completed["progress"] == {
            "completed": 1,
            "total": 1,
            "succeeded": 0,
            "failed": 1,
        }
        assert completed["errors"] == [
            {
                "source_id": source_id,
                "code": "screenshot_recognition_unsupported",
                "message": "当前执行器尚未配置截图识别能力。",
            }
        ]
    finally:
        manager.shutdown()
