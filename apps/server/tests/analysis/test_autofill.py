import pytest
from jsonschema import ValidationError
from lingxi.analysis.autofill import (
    PROFILE_SECTIONS,
    build_local_autofill,
    validate_profile_autofill,
)


def test_local_autofill_extracts_only_explicit_fields_with_exact_unicode_quotes() -> None:
    source = (
        "这是没有明确标签的介绍，不应被猜测。\n"
        "姓名：林舟\n"
        "关系：朋友\n"
        "职业：建筑设计师\n"
        "喜欢：徒步和黑咖啡🙂\n"
        "聊天：他说希望先把问题讲清楚。\n"
    )

    preview = build_local_autofill(source)

    assert preview["person"] == {
        "display_name": "林舟",
        "relation_to_user": "朋友",
    }
    assert [
        (item["section"], item["label"], item["value"])
        for item in preview["candidates"]
    ] == [
        ("basic_info", "职业", "建筑设计师"),
        ("preferences", "喜欢", "徒步和黑咖啡🙂"),
        ("interactions", "聊天", "他说希望先把问题讲清楚。"),
    ]
    for item in preview["candidates"]:
        assert source[item["start"] : item["end"]] == item["quote"]
    assert "habits" in preview["skipped_sections"]
    assert set(preview["skipped_sections"]).issubset(PROFILE_SECTIONS)


def test_local_autofill_leaves_missing_identity_and_sections_empty() -> None:
    preview = build_local_autofill("未标注的长段落不会被本地规则推断。")

    assert preview["person"] == {
        "display_name": None,
        "relation_to_user": None,
    }
    assert preview["candidates"] == []
    assert preview["skipped_sections"] == list(PROFILE_SECTIONS)


def test_profile_autofill_rejects_a_quote_that_does_not_match_the_source() -> None:
    source = "喜欢：徒步"
    preview = build_local_autofill(source)
    preview["candidates"][0]["quote"] = "喜欢：游泳"

    with pytest.raises(ValidationError, match="locator did not match"):
        validate_profile_autofill(preview, source)
