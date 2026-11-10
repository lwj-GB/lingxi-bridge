from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_RULES = (
    (
        "question",
        ("？", "?", "是不是", "能不能", "为什么", "怎么"),
        "提问或确认",
        "这可能是在寻求信息、确认理解或邀请回应。",
        "也可能只是复述一个尚未确定的事项。",
        "可以先确认：你现在最想弄清楚的是哪一部分？",
    ),
    (
        "uncertainty",
        ("可能", "也许", "不太确定", "说不准", "好像", "猜"),
        "不确定性措辞",
        "这可能是在主动保留判断空间。",
        "也可能只是日常口头语，不能据此判断真实态度。",
        "可以问：这里有哪些部分是你确定的，哪些还需要核对？",
    ),
    (
        "contrast",
        ("但是", "不过", "可是", "其实", "不是"),
        "转折或修正措辞",
        "这可能是在补充限制、修正前述表达或提出不同角度。",
        "也可能只是连接上下文的习惯表达。",
        "可以问：转折后这部分，是你更希望被理解的重点吗？",
    ),
    (
        "request",
        ("希望", "想要", "我想", "需要", "能不能"),
        "需要或期待措辞",
        "这可能是在表达一个愿望、需要或行动方向。",
        "也可能只是试探性想法，尚未形成明确请求。",
        "可以问：你希望接下来发生的最小一步是什么？",
    ),
)

_TOPIC_TERMS = (
    ("情绪支持", ("难过", "委屈", "焦虑", "害怕", "压力", "不开心", "孤独")),
    ("方案协商", ("谈判", "条件", "方案", "底线", "合作", "价格", "让步")),
    ("时间安排", ("时间", "今天", "明天", "周末", "下周", "几点", "安排")),
    ("关系边界", ("关系", "边界", "尊重", "拒绝", "不舒服", "距离")),
    ("工作协作", ("工作", "项目", "领导", "同事", "任务", "进度")),
    ("家庭沟通", ("父母", "孩子", "家里", "妈妈", "爸爸", "长辈")),
)

_SPEAKER_LABELS = {
    "me": "我",
    "other": "对面",
    "unknown": "未识别",
}


def _clean_excerpt(text: str) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= 64:
        return compact
    return f"…{compact[-63:]}"


def analyze_increment(text: str, observed_at_ms: int) -> list[dict[str, Any]]:
    excerpt = _clean_excerpt(text)
    if not excerpt:
        return []
    cards = []
    for kind, terms, label, hypothesis, alternative, question in _RULES:
        matched = next((term for term in terms if term in excerpt), None)
        if matched is None:
            continue
        cards.append(
            {
                "id": kind,
                "kind": kind,
                "observed_at_ms": observed_at_ms,
                "evidence": f"当前表达出现了{label}“{matched}”：{excerpt}",
                "hypothesis": hypothesis,
                "alternative": alternative,
                "question": question,
                "uncertainty": "high",
            }
        )
    return cards


def _infer_intent(text: str) -> str:
    if any(
        term in text
        for term in ("难过", "委屈", "焦虑", "害怕", "压力", "不开心", "孤独")
    ):
        return "对方可能希望先被倾听和支持，具体需要仍要通过追问确认。"
    if any(term in text for term in ("条件", "方案", "底线", "合作", "价格", "让步")):
        return "对方可能在核对条件或寻找可接受的方案，优先级和边界仍需确认。"
    if any(term in text for term in ("总是", "每次", "习惯", "通常")):
        return "对方可能在描述反复出现的习惯或行为模式，仍需确认频率和例外。"
    if any(term in text for term in ("希望", "想要", "我想", "需要")):
        return "对方可能在表达需要或期待，可以先确认最重要的那一项。"
    if any(term in text for term in ("？", "?", "是不是", "为什么", "怎么")):
        return "对方可能在寻求信息或确认理解，可以先回应问题再核对重点。"
    return "对方可能在补充当前话题的重点，具体意图仍需结合后续表达确认。"


def _goal_guidance(goal: str, text: str) -> tuple[list[str], list[str]]:
    combined = f"{goal} {text}"
    if any(term in combined for term in ("安慰", "倾听", "难过", "委屈", "焦虑")):
        return (
            [
                "先复述并确认对方的感受，让对方知道你在倾听。",
                "可以问对方现在更需要被陪伴，还是一起想一个小办法。",
            ],
            ["不要急着否定、比较经历或替对方下结论。"],
        )
    if any(term in combined for term in ("谈判", "条件", "底线", "协商", "价格")):
        return (
            [
                "先确认双方共同目标和已经明确的条件。",
                "追问对方最优先的一项，再提出不越过自己边界的方案。",
            ],
            ["不要把试探性表达直接当成对方的最终底线。"],
        )
    return (
        [
            "先回应对方最新表达的重点，再用一个开放问题确认理解。",
            f"提出下一步前，对照本次目标：{_clean_excerpt(goal)}",
        ],
        ["没有得到确认前，不把推测当成对方的事实或决定。"],
    )


def _topics_for(text: str) -> list[str]:
    return [
        topic
        for topic, terms in _TOPIC_TERMS
        if any(term in text for term in terms)
    ]


@dataclass
class LiveSessionState:
    analysis_mode: str = "observe"
    goal: str = ""
    committed_text: str = ""
    interim_text: str = ""
    _committed_cards: dict[str, dict[str, Any]] = field(default_factory=dict)
    _interim_cards: dict[str, dict[str, Any]] = field(default_factory=dict)
    _intent: str = ""
    _reply_points: list[str] = field(default_factory=list)
    _cautions: list[str] = field(default_factory=list)
    _summary_points: list[str] = field(default_factory=list)
    _topics: list[str] = field(default_factory=list)
    _insight_event: dict[str, Any] | None = None

    @property
    def transcript(self) -> str:
        return f"{self.committed_text}{self.interim_text}".strip()

    @property
    def analysis_count(self) -> int:
        return len(self._active_cards())

    def _active_cards(self) -> dict[str, dict[str, Any]]:
        return {**self._committed_cards, **self._interim_cards}

    def consume_insight_event(self) -> dict[str, Any] | None:
        event = self._insight_event
        self._insight_event = None
        return event

    def apply_chunk(
        self,
        *,
        sequence: int,
        text: str,
        speaker: str,
        is_final: bool,
        start_ms: int,
        end_ms: int,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        clean = text.strip()
        if is_final:
            self.committed_text = f"{self.committed_text}{clean}"
            self.interim_text = ""
        else:
            self.interim_text = clean
        return self._events(
            sequence,
            clean,
            speaker,
            is_final,
            start_ms,
            end_ms,
            snapshot=False,
        )

    def apply_snapshot(
        self,
        *,
        sequence: int,
        text: str,
        speaker: str,
        is_final: bool,
        start_ms: int,
        end_ms: int,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        clean = text.strip()
        previous_committed = self.committed_text
        segment_text = clean
        if previous_committed and clean.startswith(previous_committed):
            segment_text = clean[len(previous_committed) :]
        if is_final:
            self.committed_text = clean
            self.interim_text = ""
        else:
            if previous_committed and not clean.startswith(previous_committed):
                self.committed_text = ""
                self._committed_cards = {}
                self.interim_text = clean
            else:
                self.interim_text = segment_text
        return self._events(
            sequence,
            segment_text or clean,
            speaker,
            is_final,
            start_ms,
            end_ms,
            snapshot=True,
            analysis_text=clean,
        )

    def _events(
        self,
        sequence: int,
        text: str,
        speaker: str,
        is_final: bool,
        start_ms: int,
        end_ms: int,
        *,
        snapshot: bool,
        analysis_text: str | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        delta = {
            "type": "transcript_delta",
            "sequence": sequence,
            "text": text,
            "speaker": speaker,
            "committed_text": self.committed_text,
            "interim_text": self.interim_text,
            "is_final": is_final,
            "start_ms": start_ms,
            "end_ms": end_ms,
        }
        current = (
            {
                card["id"]: card
                for card in analyze_increment(analysis_text or text, end_ms)
            }
            if speaker == "other"
            else {}
        )
        if is_final:
            if speaker == "other":
                if snapshot:
                    self._committed_cards = current
                else:
                    self._committed_cards.update(current)
            self._interim_cards = {}
        else:
            self._interim_cards = current
        self._update_insight(
            text=text,
            speaker=speaker,
            is_final=is_final,
            observed_at_ms=end_ms,
        )
        return delta, list(self._active_cards().values())

    def _update_insight(
        self,
        *,
        text: str,
        speaker: str,
        is_final: bool,
        observed_at_ms: int,
    ) -> None:
        if self.analysis_mode == "legacy":
            return
        if not is_final:
            if speaker != "other":
                return
            self._insight_event = {
                "type": "insight_snapshot",
                "observed_at_ms": observed_at_ms,
                "is_updating": True,
                "intent": self._intent,
                "reply_points": self._reply_points,
                "cautions": self._cautions,
                "summary_points": self._summary_points,
                "topics": self._topics,
            }
            return

        clean = _clean_excerpt(text)
        if clean:
            label = _SPEAKER_LABELS.get(speaker, "未识别")
            self._summary_points = [
                *self._summary_points,
                f"{label}：{clean}",
            ][-8:]
            for topic in _topics_for(clean):
                if topic not in self._topics:
                    self._topics.append(topic)
            self._topics = self._topics[-6:]

        if speaker == "other" and clean:
            self._intent = _infer_intent(clean)
            if self.analysis_mode == "goal" and self.goal.strip():
                self._reply_points, self._cautions = _goal_guidance(self.goal, clean)

        self._insight_event = {
            "type": "insight_snapshot",
            "observed_at_ms": observed_at_ms,
            "is_updating": False,
            "intent": self._intent,
            "reply_points": self._reply_points,
            "cautions": self._cautions,
            "summary_points": self._summary_points,
            "topics": self._topics,
        }
