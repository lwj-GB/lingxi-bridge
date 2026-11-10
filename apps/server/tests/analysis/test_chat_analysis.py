from lingxi.analysis.chat_analysis import (
    build_chat_analysis,
    model_message_payload,
    parse_chat_messages,
)

SOURCE_ID = "20000000-0000-4000-8000-000000000001"
SOURCE = {
    "id": SOURCE_ID,
    "title": "虚构植物园聊天",
    "source_kind": "chat_export",
    "sha256": "a" * 64,
}
CHAT = """\
2026-07-27 09:00 林澄：周末去植物园散步吧
2026-07-27 09:01 我：好啊，周末去植物园散步
2026-07-27 20:00 林澄：晚上再确认植物园路线
"""


def test_chat_analysis_counts_messages_speakers_time_and_repeated_terms() -> None:
    messages = parse_chat_messages(CHAT)
    result = build_chat_analysis(SOURCE, CHAT, messages)

    assert result["metrics"]["messages"] == 3
    assert result["metrics"]["participants"] == 2
    assert result["metrics"]["timestamped_messages"] == 3
    assert {item["name"] for item in result["speakers"]} == {"林澄", "我"}
    assert {item["label"] for item in result["time_buckets"]} == {"上午", "晚间"}
    assert any("植物园" in item["term"] for item in result["top_terms"])
    assert result["topics"][0]["source_refs"]

    reference = result["topics"][0]["source_refs"][0]
    assert CHAT[reference["start"] : reference["end"]] == reference["quote"]


def test_model_topic_payload_contains_only_bounded_message_fields() -> None:
    messages = parse_chat_messages(CHAT)

    assert model_message_payload(messages) == [
        {
            "index": item.index,
            "speaker": item.speaker,
            "hour": item.hour,
            "text": item.text,
            "locator": {"start": item.start, "end": item.end},
        }
        for item in messages
    ]


def test_cli_topics_are_checked_and_merged_with_original_message_refs() -> None:
    messages = parse_chat_messages(CHAT)
    result = build_chat_analysis(
        SOURCE,
        CHAT,
        messages,
        topic_result={
            "schema_version": "0.1",
            "source_id": SOURCE_ID,
            "topics": [
                {
                    "title": "周末活动安排",
                    "summary": "消息讨论了植物园散步与路线确认。",
                    "keywords": ["周末", "植物园", "路线"],
                    "message_indexes": [0, 1, 2],
                }
            ],
        },
    )

    assert result["topic_method"] == "cli_assisted"
    assert result["topics"][0]["message_count"] == 3
    assert result["topics"][0]["source_refs"][2]["message_index"] == 2
