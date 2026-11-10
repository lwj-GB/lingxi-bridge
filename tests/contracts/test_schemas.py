from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "packages" / "schemas"
UUIDS = {
    "person": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a01",
    "event": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a02",
    "source": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a03",
    "evidence": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a04",
    "topic": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a05",
    "snapshot": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a06",
    "transcript": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a07",
    "segment": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a08",
    "batch": "018f7d44-bf2e-7d12-8f2a-c28f7d5d8a09",
}


def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / name).read_text(encoding="utf-8"))


def validator(name: str) -> Draft202012Validator:
    schema = load_schema(name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def test_entity_contract_accepts_complete_vertical_slice_records() -> None:
    entity_validator = validator("entities.schema.json")
    records = [
        {
            "schema_version": "0.1",
            "entity_type": "person",
            "id": UUIDS["person"],
            "revision": 1,
            "created_at": "2026-07-27T08:00:00Z",
            "updated_at": "2026-07-27T08:00:00Z",
            "display_name": "林夏（虚构）",
            "relation_to_user": "朋友",
        },
        {
            "schema_version": "0.1",
            "entity_type": "event",
            "id": UUIDS["event"],
            "revision": 1,
            "created_at": "2026-07-27T08:00:00Z",
            "updated_at": "2026-07-27T08:00:00Z",
            "title": "约定周末散步",
            "occurred_at": "2026-07-26T10:30:00+08:00",
            "person_ids": [UUIDS["person"]],
            "source_ids": [UUIDS["source"]],
        },
        {
            "schema_version": "0.1",
            "entity_type": "source",
            "id": UUIDS["source"],
            "revision": 1,
            "created_at": "2026-07-27T08:00:00Z",
            "updated_at": "2026-07-27T08:00:00Z",
            "title": "散步聊天摘录",
            "source_kind": "text",
            "original_path": "attachments/018f7d44-bf2e-7d12-8f2a-c28f7d5d8a03/original.txt",
            "sha256": "a" * 64,
            "person_ids": [UUIDS["person"]],
            "event_ids": [UUIDS["event"]],
        },
        {
            "schema_version": "0.1",
            "entity_type": "evidence",
            "id": UUIDS["evidence"],
            "revision": 1,
            "created_at": "2026-07-27T08:00:00Z",
            "updated_at": "2026-07-27T08:00:00Z",
            "source_id": UUIDS["source"],
            "quote": "林夏说：最近更喜欢安静一点的周末。",
            "locator": {"kind": "text_quote", "start": 0, "end": 21},
            "evidence_kind": "direct_quote",
            "reliability": "high",
            "person_ids": [UUIDS["person"]],
            "event_ids": [UUIDS["event"]],
        },
        {
            "schema_version": "0.1",
            "entity_type": "report_topic",
            "id": UUIDS["topic"],
            "revision": 1,
            "created_at": "2026-07-27T08:00:00Z",
            "updated_at": "2026-07-27T08:00:00Z",
            "title": "近期沟通准备",
            "template_family": "special",
            "person_ids": [UUIDS["person"]],
            "current_snapshot_id": UUIDS["snapshot"],
            "snapshot_count": 1,
            "status": "draft",
        },
        {
            "schema_version": "0.1",
            "entity_type": "report_snapshot",
            "id": UUIDS["snapshot"],
            "revision": 1,
            "created_at": "2026-07-27T08:00:00Z",
            "updated_at": "2026-07-27T08:00:00Z",
            "topic_id": UUIDS["topic"],
            "version": 1,
            "generation_kind": "safe_placeholder",
            "evidence_ids": [UUIDS["evidence"]],
        },
    ]

    for record in records:
        entity_validator.validate(record)


def test_entity_contract_rejects_non_uuid_stable_id() -> None:
    entity_validator = validator("entities.schema.json")
    record = {
        "schema_version": "0.1",
        "entity_type": "person",
        "id": "person-lin",
        "revision": 1,
        "created_at": "2026-07-27T08:00:00Z",
        "updated_at": "2026-07-27T08:00:00Z",
        "display_name": "林夏（虚构）",
        "relation_to_user": "朋友",
    }

    with pytest.raises(Exception):
        entity_validator.validate(record)


def test_entity_contract_accepts_profile_screenshot_transcript_and_locator() -> None:
    entity_validator = validator("entities.schema.json")
    person = {
        "schema_version": "0.1",
        "entity_type": "person",
        "id": UUIDS["person"],
        "revision": 2,
        "created_at": "2026-07-27T08:00:00Z",
        "updated_at": "2026-07-27T09:00:00Z",
        "display_name": "林夏（虚构）",
        "relation_to_user": "朋友",
        "profile_sections": [
            {
                "id": UUIDS["segment"],
                "section": "preferences",
                "label": "周末偏好",
                "value": "偏好安静的周末。",
                "origin": "user",
                "confirmation_status": "confirmed",
                "evidence_ids": [],
            }
        ],
    }
    source = {
        "schema_version": "0.1",
        "entity_type": "source",
        "id": UUIDS["source"],
        "revision": 2,
        "created_at": "2026-07-27T08:00:00Z",
        "updated_at": "2026-07-27T09:00:00Z",
        "title": "虚构截图 1",
        "source_kind": "screenshot",
        "original_path": (
            "attachments/018f7d44-bf2e-7d12-8f2a-c28f7d5d8a03/original.png"
        ),
        "sha256": "a" * 64,
        "person_ids": [UUIDS["person"]],
        "event_ids": [],
        "mime_type": "image/png",
        "byte_size": 123,
        "batch_id": UUIDS["batch"],
        "sequence_index": 0,
        "processing_status": "confirmed",
        "transcript_id": UUIDS["transcript"],
    }
    transcript = {
        "schema_version": "0.1",
        "entity_type": "screenshot_transcript",
        "id": UUIDS["transcript"],
        "revision": 1,
        "created_at": "2026-07-27T09:00:00Z",
        "updated_at": "2026-07-27T09:00:00Z",
        "source_id": UUIDS["source"],
        "status": "confirmed",
        "segments": [
            {
                "segment_id": UUIDS["segment"],
                "order": 0,
                "speaker": "other",
                "text": "偏好安静的周末。",
                "uncertainty": "low",
            }
        ],
        "person_ids": [UUIDS["person"]],
        "event_ids": [],
    }
    evidence = {
        "schema_version": "0.1",
        "entity_type": "evidence",
        "id": UUIDS["evidence"],
        "revision": 1,
        "created_at": "2026-07-27T09:00:00Z",
        "updated_at": "2026-07-27T09:00:00Z",
        "source_id": UUIDS["source"],
        "quote": "偏好安静的周末。",
        "locator": {
            "kind": "screenshot_segment",
            "transcript_id": UUIDS["transcript"],
            "segment_id": UUIDS["segment"],
            "start": 0,
            "end": 9,
        },
        "evidence_kind": "direct_quote",
        "reliability": "high",
        "person_ids": [UUIDS["person"]],
        "event_ids": [],
    }
    for record in (person, source, transcript, evidence):
        entity_validator.validate(record)


def test_screenshot_recognition_contract_limits_batch_to_twenty() -> None:
    recognition_validator = validator("screenshot-recognition.schema.json")
    result = {
        "schema_version": "0.1",
        "items": [
            {
                "source_id": UUIDS["source"],
                "segments": [
                    {
                        "order": 0,
                        "speaker": "unknown",
                        "text": "虚构识别文本",
                        "uncertainty": "high",
                    }
                ],
            }
        ],
    }
    recognition_validator.validate(result)
    result["items"] = result["items"] * 21
    with pytest.raises(Exception):
        recognition_validator.validate(result)


def test_analysis_contract_requires_sources_and_alternative_for_hypothesis() -> None:
    analysis_validator = validator("analysis-output.schema.json")
    invalid = {
        "schema_version": "0.1",
        "material_scope": [UUIDS["source"]],
        "claims": [
            {
                "claim_type": "hypothesis",
                "text": "对方可能希望减少高刺激安排。",
                "evidence_ids": [UUIDS["evidence"]],
                "uncertainty": "medium",
                "alternatives": [],
            }
        ],
    }

    with pytest.raises(Exception):
        analysis_validator.validate(invalid)


def test_analysis_contract_accepts_safe_placeholder_result() -> None:
    analysis_validator = validator("analysis-output.schema.json")
    valid = {
        "schema_version": "0.1",
        "material_scope": [UUIDS["source"]],
        "claims": [
            {
                "claim_type": "observation",
                "text": "材料中直接出现了对安静周末的偏好表达。",
                "evidence_ids": [UUIDS["evidence"]],
            },
            {
                "claim_type": "hypothesis",
                "text": "近期可优先提出低压力的活动选项。",
                "evidence_ids": [UUIDS["evidence"]],
                "uncertainty": "medium",
                "alternatives": ["这句话也可能只针对当周状态。"],
            },
            {
                "claim_type": "unknown",
                "text": "尚不知道这种偏好是否长期稳定。",
                "evidence_ids": [UUIDS["evidence"]],
            },
            {
                "claim_type": "suggestion",
                "text": "询问对方本周更想散步还是在家休息。",
                "evidence_ids": [UUIDS["evidence"]],
            },
        ],
    }

    analysis_validator.validate(valid)


def test_live_session_contract_accepts_incremental_transcript_and_analysis() -> None:
    live_validator = validator("live-session.schema.json")
    events = [
            {
                "type": "start",
                "recognizer": "browser_stream",
                "consent": True,
                "default_speaker": "other",
                "analysis_mode": "goal",
                "goal": "安慰对方，先理解感受。",
            },
        {
            "type": "transcript_delta",
            "sequence": 2,
                "text": "周末的安排是不是还没定？",
                "speaker": "other",
                "committed_text": "",
            "interim_text": "周末的安排是不是还没定？",
            "is_final": False,
            "start_ms": 0,
            "end_ms": 1200,
        },
        {
            "type": "analysis_snapshot",
            "cards": [{
                    "id": "question",
                    "kind": "question",
                    "observed_at_ms": 1200,
                    "evidence": "出现了提问表达：“周末的安排是不是还没定？”",
                    "hypothesis": "说话者可能在寻求信息或确认。",
                    "alternative": "也可能只是复述一个尚未确定的事项。",
                    "question": "可以先确认：你现在最想弄清楚的是哪一部分？",
                    "uncertainty": "high",
                }],
        },
        {
            "type": "insight_snapshot",
            "observed_at_ms": 1200,
            "is_updating": False,
            "intent": "对方可能希望先被倾听和理解。",
            "reply_points": ["先复述并确认对方的感受。"],
            "cautions": ["不要急着否定或给出结论。"],
            "summary_points": ["对面：周末的安排是不是还没定？"],
            "topics": ["时间安排"],
        },
    ]

    for event in events:
        live_validator.validate(event)


def test_live_session_contract_rejects_start_without_explicit_consent() -> None:
    live_validator = validator("live-session.schema.json")

    with pytest.raises(Exception):
        live_validator.validate(
            {
                "type": "start",
                "recognizer": "doubao",
                "consent": False,
            }
        )


def test_live_session_contract_requires_goal_when_goal_mode_is_enabled() -> None:
    live_validator = validator("live-session.schema.json")

    with pytest.raises(Exception):
        live_validator.validate(
            {
                "type": "start",
                "recognizer": "demo",
                "consent": True,
                "default_speaker": "other",
                "analysis_mode": "goal",
            }
        )


def test_chat_analysis_contract_keeps_statistics_linked_to_original_source() -> None:
    analysis_validator = validator("chat-analysis.schema.json")
    topics_validator = validator("chat-topics.schema.json")
    analysis_validator.validate(
        {
            "schema_version": "0.1",
            "source": {
                "id": UUIDS["source"],
                "title": "虚构聊天记录",
                "sha256": "a" * 64,
                "source_kind": "chat_export",
            },
            "topic_method": "local_frequency_clues",
            "metrics": {
                "characters": 42,
                "non_whitespace_characters": 38,
                "lines": 3,
                "messages": 3,
                "participants": 2,
                "timestamped_messages": 3,
            },
            "top_terms": [
                {
                    "term": "植物园",
                    "count": 3,
                    "message_count": 3,
                    "message_share": 1,
                }
            ],
            "speakers": [
                {"name": "林澄", "message_count": 2, "message_share": 0.6667}
            ],
            "time_buckets": [
                {"label": "上午", "message_count": 2, "message_share": 0.6667}
            ],
            "topics": [
                {
                    "title": "周末植物园安排",
                    "summary": "三条消息围绕植物园安排。",
                    "keywords": ["植物园", "周末"],
                    "message_count": 3,
                    "message_share": 1,
                    "source_refs": [
                        {
                            "message_index": 0,
                            "start": 18,
                            "end": 25,
                            "quote": "周末去植物园",
                        }
                    ],
                }
            ],
            "limitations": ["主题和频次仍需回看原始材料确认。"],
        }
    )
    topics_validator.validate(
        {
            "schema_version": "0.1",
            "source_id": UUIDS["source"],
            "topics": [
                {
                    "title": "周末植物园安排",
                    "summary": "消息讨论了植物园时间。",
                    "keywords": ["植物园"],
                    "message_indexes": [0, 1, 2],
                }
            ],
        }
    )
