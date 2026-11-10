from lingxi.realtime.analysis import LiveSessionState


def test_interim_text_is_replaced_and_final_text_is_committed() -> None:
    state = LiveSessionState()

    first, _ = state.apply_chunk(
        sequence=0,
        speaker="other",
        text="我想确认",
        is_final=False,
        start_ms=0,
        end_ms=500,
    )
    second, cards = state.apply_chunk(
        sequence=1,
        speaker="other",
        text="我想确认周末的安排是不是还没定？",
        is_final=False,
        start_ms=0,
        end_ms=1100,
    )
    final, _ = state.apply_chunk(
        sequence=2,
        speaker="other",
        text="我想确认周末的安排是不是还没定？",
        is_final=True,
        start_ms=0,
        end_ms=1300,
    )

    assert first["interim_text"] == "我想确认"
    assert second["interim_text"].endswith("还没定？")
    assert final["committed_text"] == "我想确认周末的安排是不是还没定？"
    assert final["interim_text"] == ""
    assert any(card["kind"] == "question" for card in cards)


def test_analysis_separates_observation_hypothesis_and_alternative() -> None:
    state = LiveSessionState()

    _, cards = state.apply_chunk(
        sequence=0,
        speaker="other",
        text="我不太确定，不过我希望先确认一下。",
        is_final=False,
        start_ms=0,
        end_ms=900,
    )

    kinds = {card["kind"] for card in cards}
    assert kinds == {"uncertainty", "contrast", "request"}
    for card in cards:
        assert card["evidence"]
        assert card["hypothesis"].startswith("这可能")
        assert card["alternative"].startswith("也可能")
        assert card["question"]
        assert card["uncertainty"] == "high"


def test_repeated_interim_result_updates_in_place_instead_of_growing_cards() -> None:
    state = LiveSessionState()

    _, first = state.apply_chunk(
        sequence=0,
        speaker="other",
        text="我可能",
        is_final=False,
        start_ms=0,
        end_ms=300,
    )
    _, second = state.apply_chunk(
        sequence=1,
        speaker="other",
        text="我可能需要再想一想",
        is_final=False,
        start_ms=0,
        end_ms=800,
    )

    assert [card["id"] for card in first] == ["uncertainty"]
    assert {card["id"] for card in second} == {"uncertainty", "request"}
    assert state.analysis_count == 2


def test_corrected_interim_text_removes_cards_without_current_evidence() -> None:
    state = LiveSessionState()

    _, first = state.apply_chunk(
        sequence=0,
        speaker="other",
        text="我可能",
        is_final=False,
        start_ms=0,
        end_ms=300,
    )
    _, corrected = state.apply_chunk(
        sequence=1,
        speaker="other",
        text="我会",
        is_final=False,
        start_ms=0,
        end_ms=500,
    )

    assert [card["id"] for card in first] == ["uncertainty"]
    assert corrected == []
    assert state.analysis_count == 0


def test_me_and_unknown_are_transcribed_but_not_analyzed() -> None:
    state = LiveSessionState()

    me_delta, me_cards = state.apply_chunk(
        sequence=0,
        speaker="me",
        text="我可能需要确认。",
        is_final=True,
        start_ms=0,
        end_ms=500,
    )
    unknown_delta, unknown_cards = state.apply_chunk(
        sequence=1,
        speaker="unknown",
        text="还不确定。",
        is_final=True,
        start_ms=500,
        end_ms=900,
    )

    assert me_delta["speaker"] == "me"
    assert unknown_delta["speaker"] == "unknown"
    assert me_cards == []
    assert unknown_cards == []
    assert state.transcript == "我可能需要确认。还不确定。"


def test_goal_mode_emits_fast_progress_then_advice_and_live_summary() -> None:
    state = LiveSessionState(
        analysis_mode="goal",
        goal="安慰对方，先听清楚感受，不急着给方案。",
    )

    state.apply_chunk(
        sequence=0,
        speaker="other",
        text="我最近有点难过",
        is_final=False,
        start_ms=0,
        end_ms=420,
    )
    updating = state.consume_insight_event()
    assert updating is not None
    assert updating["type"] == "insight_snapshot"
    assert updating["is_updating"] is True

    state.apply_chunk(
        sequence=1,
        speaker="other",
        text="我最近有点难过，感觉没有人愿意听我说。",
        is_final=True,
        start_ms=0,
        end_ms=900,
    )
    settled = state.consume_insight_event()
    assert settled is not None
    assert settled["is_updating"] is False
    assert "支持" in settled["intent"] or "倾听" in settled["intent"]
    assert any("感受" in point or "倾听" in point for point in settled["reply_points"])
    assert settled["cautions"]
    assert settled["summary_points"] == [
        "对面：我最近有点难过，感觉没有人愿意听我说。"
    ]
    assert "情绪支持" in settled["topics"]

    state.apply_chunk(
        sequence=2,
        speaker="me",
        text="我听见了，你可以慢慢说。",
        is_final=True,
        start_ms=900,
        end_ms=1300,
    )
    after_my_reply = state.consume_insight_event()
    assert after_my_reply is not None
    assert after_my_reply["reply_points"] == settled["reply_points"]
    assert after_my_reply["cautions"] == settled["cautions"]


def test_live_summary_keeps_both_speakers_while_intent_tracks_the_other_side() -> None:
    state = LiveSessionState()
    state.apply_chunk(
        sequence=0,
        speaker="other",
        text="我希望下周再确认时间。",
        is_final=True,
        start_ms=0,
        end_ms=500,
    )
    other_insight = state.consume_insight_event()
    assert other_insight is not None
    intent = other_insight["intent"]

    state.apply_chunk(
        sequence=1,
        speaker="me",
        text="好，我周一再联系你。",
        is_final=True,
        start_ms=500,
        end_ms=900,
    )
    full_summary = state.consume_insight_event()
    assert full_summary is not None
    assert full_summary["intent"] == intent
    assert full_summary["reply_points"] == []
    assert full_summary["summary_points"] == [
        "对面：我希望下周再确认时间。",
        "我：好，我周一再联系你。",
    ]
