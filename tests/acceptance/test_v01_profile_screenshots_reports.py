from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app

PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR"
    b"\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff"
    b"\x89\x99=\x1d"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _open_and_create_person(client: TestClient, vault: Path) -> dict[str, Any]:
    assert client.post("/api/workspaces/open", json={"path": str(vault)}).status_code == 200
    response = client.post(
        "/api/people",
        json={"display_name": "林夏（虚构）", "relation_to_user": "朋友"},
    )
    assert response.status_code == 201
    return response.json()


def _screenshot_files(count: int) -> list[tuple[str, tuple[str, bytes, str]]]:
    return [
        ("files", (f"chat-{index + 1:02d}.png", PNG + bytes([index]), "image/png"))
        for index in range(count)
    ]


def _upload(
    client: TestClient,
    person_id: str,
    count: int,
) -> Any:
    return client.post(
        "/api/screenshot-batches",
        data={
            "title": "虚构聊天截图",
            "person_ids": f'["{person_id}"]',
            "event_ids": "[]",
        },
        files=_screenshot_files(count),
    )


def test_profile_and_twenty_screenshots_survive_rebuild_as_obsidian_files(
    tmp_path: Path,
) -> None:
    vault = tmp_path / "截图闭环工作区"
    vault.mkdir()

    with TestClient(create_app()) as client:
        person = _open_and_create_person(client, vault)

        profile_response = client.post(
            f"/api/people/{person['id']}/profile-entries",
            json={
                "section": "preferences",
                "label": "周末偏好",
                "value": "更喜欢安静一点的周末。",
                "evidence_ids": [],
            },
        )
        assert profile_response.status_code == 201
        updated_person = profile_response.json()
        assert updated_person["profile_sections"][0]["section"] == "preferences"
        assert updated_person["profile_sections"][0]["confirmation_status"] == "confirmed"

        before_files = {
            str(path.relative_to(vault))
            for path in vault.rglob("*")
            if path.is_file()
        }
        rejected = _upload(client, person["id"], 21)
        assert rejected.status_code == 422
        assert rejected.json()["error"]["code"] == "screenshot_count_out_of_range"
        assert {
            str(path.relative_to(vault))
            for path in vault.rglob("*")
            if path.is_file()
        } == before_files
        assert client.get("/api/sources").json()["items"] == []

        accepted = _upload(client, person["id"], 20)
        assert accepted.status_code == 201
        batch = accepted.json()
        assert len(batch["items"]) == 20
        assert [item["sequence_index"] for item in batch["items"]] == list(range(20))
        assert all(item["processing_status"] == "pending_confirmation" for item in batch["items"])

        seventh = batch["items"][6]
        original = vault / seventh["original_path"]
        assert original.read_bytes() == PNG + b"\x06"
        assert seventh["sha256"] == hashlib.sha256(PNG + b"\x06").hexdigest()

        transcript_response = client.put(
            f"/api/sources/{seventh['id']}/transcript",
            json={
                "segments": [
                    {
                        "order": 0,
                        "speaker": "other",
                        "text": "最近更喜欢安静一点的周末。",
                        "uncertainty": "low",
                    },
                    {
                        "order": 1,
                        "speaker": "me",
                        "text": "那我们去安静的公园。",
                        "uncertainty": "low",
                    },
                ]
            },
        )
        assert transcript_response.status_code == 201
        confirmed = transcript_response.json()
        assert confirmed["source"]["processing_status"] == "confirmed"
        assert confirmed["transcript"]["source_id"] == seventh["id"]
        assert len(confirmed["evidence"]) == 2

        transcript_path = (
            vault / "transcripts" / f"{confirmed['transcript']['id']}.md"
        )
        transcript_text = transcript_path.read_text(encoding="utf-8")
        assert "最近更喜欢安静一点的周末。" in transcript_text
        assert seventh["original_path"] in transcript_text

        report_response = client.post(
            "/api/reports",
            json={
                "title": "近期变化（虚构）",
                "template_family": "recent_change",
                "template_variant": "recent_state",
                "person_ids": [person["id"]],
                "evidence_ids": [confirmed["evidence"][0]["id"]],
            },
        )
        assert report_response.status_code == 201
        report = report_response.json()
        assert report["topic"]["template_family"] == "recent_change"
        assert report["topic"]["template_variant"] == "recent_state"

        hashes_before = {
            str(path.relative_to(vault)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in vault.rglob("*")
            if path.is_file() and ".lingxi" not in path.parts
        }
        (vault / ".lingxi" / "index.sqlite3").unlink()
        rebuild = client.post("/api/workspaces/rebuild-index")
        assert rebuild.status_code == 200
        assert {
            str(path.relative_to(vault)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in vault.rglob("*")
            if path.is_file() and ".lingxi" not in path.parts
        } == hashes_before

        person_record = client.get(f"/api/records/{person['id']}").json()
        assert "周末偏好" in person_record["body"]
        source_record = client.get(f"/api/records/{seventh['id']}").json()
        assert "最近更喜欢安静一点的周末。" in source_record["body"]
        assert source_record["record"]["transcript_id"] == confirmed["transcript"]["id"]


@pytest.mark.parametrize(
    ("family", "variant"),
    [
        ("person_long_term", "overview"),
        ("relation", "friend_social"),
        ("recent_change", "recent_state"),
        ("special", "communication_prep"),
    ],
)
def test_each_report_family_persists_its_variant(
    tmp_path: Path,
    family: str,
    variant: str,
) -> None:
    vault = tmp_path / f"{family}-工作区"
    vault.mkdir()
    with TestClient(create_app()) as client:
        person = _open_and_create_person(client, vault)
        text = "一条可以验证的虚构材料。"
        source = client.post(
            "/api/sources/text",
            json={
                "title": "虚构材料",
                "text": text,
                "source_kind": "text",
                "person_ids": [person["id"]],
                "event_ids": [],
            },
        ).json()
        evidence = client.post(
            "/api/evidence",
            json={
                "source_id": source["id"],
                "quote": text,
                "locator": {"kind": "text_quote", "start": 0, "end": len(text)},
                "evidence_kind": "direct_quote",
                "reliability": "high",
                "person_ids": [person["id"]],
                "event_ids": [],
            },
        ).json()

        response = client.post(
            "/api/reports",
            json={
                "title": f"{family}（虚构）",
                "template_family": family,
                "template_variant": variant,
                "person_ids": [person["id"]],
                "evidence_ids": [evidence["id"]],
            },
        )

        assert response.status_code == 201
        topic = response.json()["topic"]
        assert topic["template_family"] == family
        assert topic["template_variant"] == variant
        report_path = vault / "reports" / f"{topic['id']}.md"
        assert f"template_variant: {variant}" in report_path.read_text(encoding="utf-8")
