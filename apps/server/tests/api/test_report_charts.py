from __future__ import annotations

import hashlib
import json
import struct
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from lingxi.analysis import report_charts
from lingxi.main import create_app


def prepare(client: TestClient, root: Path, dated: bool = True) -> tuple[dict, dict]:
    assert client.post("/api/workspaces/open", json={"path": str(root)}).status_code == 200
    person = client.post("/api/people", json={
        "display_name": "林舟（虚构）", "relation_to_user": "朋友",
    }).json()
    text = (
        "2026-11-01 10:00 林舟：周末计划一起散步，准备工作资料。\n"
        "2026-11-01 10:05 我：周末计划先完成工作资料。\n"
        "2026-11-02 11:00 林舟：工作资料完成，再安排散步。\n"
        "2026-11-02 11:06 我：周末计划安排散步。"
        if dated else
        "林舟：周末计划一起散步。\n我：周末计划先整理工作资料。\n林舟：工作资料完成，再安排散步。"
    )
    source = client.post("/api/sources/text", json={
        "title": "虚构聊天", "text": text, "source_kind": "chat_export",
        "person_ids": [person["id"]], "event_ids": [],
    }).json()
    evidence = client.post("/api/evidence", json={
        "source_id": source["id"], "quote": text,
        "locator": {"kind": "text_quote", "start": 0, "end": len(text)},
        "evidence_kind": "direct_quote", "reliability": "high",
        "person_ids": [person["id"]], "event_ids": [],
    }).json()
    return {
        "title": "虚构聊天报告", "template_family": "special",
        "template_variant": "communication_prep",
        "person_ids": [person["id"]], "evidence_ids": [evidence["id"]],
        "engine": "safe_placeholder",
    }, source


def test_actual_r_charts_are_reproducible_assets_and_preserve_history(tmp_path: Path) -> None:
    capability = report_charts.plotting_capabilities()
    if not capability["available"]:
        pytest.skip(capability["reason"])
    with TestClient(create_app()) as client:
        assert client.get("/api/plotting/capabilities").json()["available"]
        payload, source = prepare(client, tmp_path)
        first_response = client.post("/api/reports", json=payload)
        assert first_response.status_code == 201, first_response.text
        first = first_response.json()
        old_path = tmp_path / "reports/snapshots" / f"{first['snapshot']['id']}.md"
        old_bytes = old_path.read_bytes()
        original = tmp_path / source["original_path"]
        original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
        response = client.post("/api/reports", json={
            **payload, "include_charts": True, "topic_id": first["topic"]["id"],
            "expected_revision": 1,
        })
        assert response.status_code == 201, response.text
        report = response.json()
        snapshot = report["snapshot"]
        assert snapshot["version"] == 2
        assert snapshot["charts"]["frequency_mode"] == "daily"
        assert len(snapshot["charts"]["assets"]) == 6
        prefix = f"/api/reports/snapshots/{snapshot['id']}/assets/"
        for asset in snapshot["charts"]["assets"]:
            downloaded = client.get(prefix + asset["name"])
            assert downloaded.status_code == 200
            assert hashlib.sha256(downloaded.content).hexdigest() == asset["sha256"]
            if asset["kind"] == "image":
                assert downloaded.content.startswith(b"\x89PNG\r\n\x1a\n")
                assert struct.unpack(">II", downloaded.content[16:24]) == (2400, 1350)
        manifest = client.get(prefix + "manifest.json").json()
        assert manifest["runtime"]["R"] == capability["r_version"]
        assert manifest["output"]["dpi"] == 300
        assert manifest["record_count"] == 4
        assert manifest["sources"][0]["sha256"] == original_hash
        assert "不是精确中文分词" in manifest["rules"]["terms"]
        assert old_path.read_bytes() == old_bytes
        assert hashlib.sha256(original.read_bytes()).hexdigest() == original_hash
        new_snapshot = tmp_path / "reports/snapshots" / f"{snapshot['id']}.md"
        assert "![[attachments/reports/" in new_snapshot.read_text()
        assert client.get(prefix + "other.txt").status_code == 404
        assert client.get(prefix + "..%2F..%2Fworkspace.json").status_code == 404

        # Downloaded fixed script and aggregate CSVs can be rerun, without source text.
        reproduction = tmp_path / "reproduction"
        reproduction.mkdir()
        for name in ("frequency.csv", "terms.csv", "report_charts.R"):
            (reproduction / name).write_bytes(client.get(prefix + name).content)
        rerun = subprocess.run([
            report_charts._rscript(), "--vanilla", str(reproduction / "report_charts.R"),
            str(reproduction), "daily",
        ], capture_output=True, timeout=60, env=report_charts._r_environment())
        assert rerun.returncode == 0, rerun.stderr.decode()
        assert (reproduction / "frequency.png").is_file()
        assert client.post("/api/workspaces/open", json={"path": str(tmp_path)}).status_code == 200
        assert client.get(prefix + "terms.png").status_code == 200
        data_path = tmp_path / "attachments/reports" / snapshot["id"] / "frequency.csv"
        data_path.write_bytes(data_path.read_bytes() + b"modified\n")
        assert client.get(prefix + "frequency.csv").status_code == 409
        assert hashlib.sha256(original.read_bytes()).hexdigest() == original_hash


def test_missing_dates_use_real_speaker_counts_without_inventing_a_trend(tmp_path: Path) -> None:
    capability = report_charts.plotting_capabilities()
    if not capability["available"]:
        pytest.skip(capability["reason"])
    with TestClient(create_app()) as client:
        payload, _ = prepare(client, tmp_path, dated=False)
        response = client.post("/api/reports", json={**payload, "include_charts": True})
        assert response.status_code == 201, response.text
        snapshot = response.json()["snapshot"]
        assert snapshot["charts"]["frequency_mode"] == "speaker_totals"
        assert any("不绘制时间趋势" in text for text in snapshot["charts"]["missing_information"])
        manifest_path = tmp_path / snapshot["charts"]["manifest_path"]
        manifest = json.loads(manifest_path.read_text())
        assert manifest["record_count"] == 3


@pytest.mark.parametrize("failure", ["missing_r", "render_failure"])
def test_r_failure_does_not_write_a_report_or_change_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str,
) -> None:
    with TestClient(create_app()) as client:
        payload, source = prepare(client, tmp_path)
        original = (tmp_path / source["original_path"]).read_bytes()
        if failure == "missing_r":
            monkeypatch.setattr(report_charts, "_rscript", lambda: None)
            assert client.get("/api/plotting/capabilities").json()["available"] is False
        else:
            monkeypatch.setattr(report_charts, "plotting_capabilities", lambda: {
                "available": True, "r_version": "test", "ggplot2_version": "test",
            })
            monkeypatch.setattr(
                report_charts.subprocess, "run",
                lambda *args, **kwargs: subprocess.CompletedProcess([], 1, "", "failure"),
            )
        response = client.post("/api/reports", json={**payload, "include_charts": True})
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "report_charts_failed"
        assert not list((tmp_path / "reports").rglob("*.md"))
        assert not (tmp_path / "attachments/reports").exists()
        assert (tmp_path / source["original_path"]).read_bytes() == original
        # Text-only reports remain usable without R.
        if failure == "missing_r":
            assert client.post("/api/reports", json=payload).status_code == 201
