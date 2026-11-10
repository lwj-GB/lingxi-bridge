from pathlib import Path

from fastapi.testclient import TestClient
from lingxi.main import create_app


def _person(client: TestClient, vault: Path) -> dict:
    assert client.post("/api/workspaces/open", json={"path": str(vault)}).status_code == 200
    return client.post(
        "/api/people",
        json={"display_name": "林澄（虚构）", "relation_to_user": "女朋友"},
    ).json()


def _add_answer(client: TestClient, person_id: str, text: str) -> dict:
    source = client.post(
        "/api/sources/text",
        json={
            "title": "报告助手补充回答",
            "text": text,
            "source_kind": "user_observation",
            "person_ids": [person_id],
            "event_ids": [],
        },
    ).json()
    return client.post(
        "/api/evidence",
        json={
            "source_id": source["id"],
            "quote": text,
            "locator": {"kind": "text_quote", "start": 0, "end": len(text)},
            "evidence_kind": "user_statement",
            "reliability": "medium",
            "person_ids": [person_id],
            "event_ids": [],
        },
    ).json()


def test_report_advisor_asks_then_prepares_existing_report_flow(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        person = _person(client, tmp_path)
        first = client.post(
            "/api/report-advisor/preview",
            json={
                "person_id": person["id"],
                "request_text": "我想了解她的恋爱观",
            },
        )
        first_evidence = _add_answer(
            client,
            person["id"],
            "她说恋爱中需要把边界和不满及时讲清楚。",
        )
        second_evidence = _add_answer(
            client,
            person["id"],
            "有分歧时，她通常会先冷静一会儿，再约时间沟通。",
        )
        ready = client.post(
            "/api/report-advisor/preview",
            json={
                "person_id": person["id"],
                "request_text": "我想了解她的恋爱观",
            },
        )

    assert first.status_code == 200
    assert first.json()["status"] == "needs_input"
    assert len(first.json()["questions"]) == 3
    assert first.json()["evidence_ids"] == []
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"
    assert ready.json()["proposed_report"]["template_variant"] == "romantic"
    assert set(ready.json()["evidence_ids"]) == {
        first_evidence["id"],
        second_evidence["id"],
    }
    assert ready.json()["proposed_report"]["analysis_question"] == "我想了解她的恋爱观"


def test_report_advisor_does_not_use_unrelated_evidence_as_filler(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        person = _person(client, tmp_path)
        unrelated = _add_answer(client, person["id"], "她周末常去植物园散步。")
        without_selection = client.post(
            "/api/report-advisor/preview",
            json={
                "person_id": person["id"],
                "request_text": "我想了解她的恋爱观",
            },
        )
        with_explicit_answer = client.post(
            "/api/report-advisor/preview",
            json={
                "person_id": person["id"],
                "request_text": "我想了解她的恋爱观",
                "evidence_ids": [unrelated["id"]],
            },
        )

    assert without_selection.json()["status"] == "needs_input"
    assert without_selection.json()["evidence_ids"] == []
    assert with_explicit_answer.json()["status"] == "ready"
    assert with_explicit_answer.json()["evidence_ids"] == [unrelated["id"]]


def test_report_advisor_respects_explicit_report_type_over_request_keywords(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        person = _person(client, tmp_path)
        evidence = _add_answer(
            client,
            person["id"],
            "2026-07-01 09:00 我：先把聊天中的事实和待核对问题分开。",
        )
        response = client.post(
            "/api/report-advisor/preview",
            json={
                "person_id": person["id"],
                "request_text": "整理聊天记录；时间侧重：近期材料优先。",
                "evidence_ids": [evidence["id"]],
                "template_family": "special",
                "template_variant": "custom",
            },
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["proposed_report"]["template_family"] == "special"
    assert response.json()["proposed_report"]["template_variant"] == "custom"
    assert "聊天记录分析" in response.json()["reply"]


def test_relation_tag_changes_report_suggestions_and_can_be_updated(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        person = _person(client, tmp_path)
        before = client.get(f"/api/report-advisor/suggestions/{person['id']}")
        updated = client.patch(
            f"/api/people/{person['id']}",
            json={"relation_to_user": "同事"},
        )
        after = client.get(f"/api/report-advisor/suggestions/{person['id']}")

    assert before.json()["items"][0] == "整理一份恋爱关系报告"
    assert updated.status_code == 200
    assert updated.json()["relation_to_user"] == "同事"
    assert updated.json()["revision"] == 2
    assert after.json()["items"][0] == "整理师生与协作报告"
