from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from lingxi.main import create_app


class StubWorkspace:
    def open(self, path: str) -> dict[str, Any]:
        return {
            "path": path,
            "workspace_id": "10000000-0000-4000-8000-000000000001",
            "schema_version": "0.1",
            "counts": {},
            "index_path": ".lingxi/index.sqlite3",
        }


class StubScreenshotJobs:
    def __init__(self) -> None:
        self.calls: list[tuple[object, list[str], str, str]] = []
        self.shut_down = False

    def submit(
        self,
        workspace: object,
        source_ids: list[str],
        engine: str,
        profile_id: str,
    ) -> dict[str, object]:
        self.calls.append((workspace, source_ids, engine, profile_id))
        return {
            "id": "20000000-0000-4000-8000-000000000001",
            "status": "queued",
            "source_ids": source_ids,
        }

    def get(self, job_id: str) -> dict[str, str]:
        return {"id": job_id, "status": "running"}

    def cancel(self, job_id: str) -> dict[str, str]:
        return {"id": job_id, "status": "cancelled"}

    def shutdown(self) -> None:
        self.shut_down = True


def test_screenshot_job_routes_use_injected_manager_and_close_it(
    tmp_path: Path,
) -> None:
    manager = StubScreenshotJobs()
    source_id = "30000000-0000-4000-8000-000000000001"
    app = create_app(
        workspace_factory=StubWorkspace,
        screenshot_jobs=manager,
    )

    with TestClient(app) as client:
        assert client.post(
            "/api/workspaces/open",
            json={"path": str(tmp_path)},
        ).status_code == 200
        submitted = client.post(
            "/api/screenshot-recognition-jobs",
            json={
                "source_ids": [source_id],
                "engine": "codex",
                "profile_id": "inherited",
            },
        )
        assert submitted.status_code == 202
        assert submitted.json()["status"] == "queued"
        assert manager.calls[0][1:] == ([source_id], "codex", "inherited")

        job_id = submitted.json()["id"]
        assert (
            client.get(f"/api/screenshot-recognition-jobs/{job_id}").json()["status"]
            == "running"
        )
        assert (
            client.delete(f"/api/screenshot-recognition-jobs/{job_id}").json()["status"]
            == "cancelled"
        )

    assert manager.shut_down is True
