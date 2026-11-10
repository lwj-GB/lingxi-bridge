from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

from lingxi.analysis.schema import validate_chat_analysis

MAX_CHAT_CHARACTERS = 5_000_000
MAX_MESSAGES_FOR_MODEL = 20_000

_TIMESTAMP = (
    r"(?:\[?\s*)?"
    r"(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?[,\s]+)?"
    r"(?P<hour>[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?"
    r"(?:\s*\]?)"
)
_INLINE_MESSAGE = re.compile(
    rf"^\s*(?:{_TIMESTAMP}\s*)?"
    r"(?P<speaker>[^:：\n]{1,40})\s*[:：]\s*(?P<body>.+?)\s*$"
)
_HEADER_MESSAGE = re.compile(
    rf"^\s*{_TIMESTAMP}\s+(?P<speaker>\S.{{0,39}}?)\s*$"
)
_HOUR_ONLY = re.compile(r"(?<!\d)(?P<hour>[01]?\d|2[0-3]):[0-5]\d")
_LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_'-]{1,39}")
_HAN_SEQUENCE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]{2,}")
_URL = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)

_STOP_TERMS = {
    "一个",
    "一下",
    "一点",
    "不是",
    "不会",
    "不能",
    "什么",
    "他们",
    "你们",
    "其实",
    "可以",
    "可能",
    "因为",
    "如果",
    "就是",
    "应该",
    "怎么",
    "我们",
    "所以",
    "时候",
    "明白",
    "没有",
    "然后",
    "现在",
    "真的",
    "知道",
    "自己",
    "觉得",
    "还是",
    "这个",
    "那个",
    "比较",
    "进行",
    "对吧",
    "哈哈",
    "呵呵",
    "嗯嗯",
}
_STOP_LATIN = {
    "and",
    "are",
    "but",
    "for",
    "from",
    "have",
    "that",
    "the",
    "this",
    "was",
    "were",
    "with",
    "you",
}
_TIME_BUCKETS = (
    ("凌晨", range(0, 6)),
    ("上午", range(6, 12)),
    ("下午", range(12, 18)),
    ("晚间", range(18, 24)),
)


@dataclass(frozen=True)
class ChatMessage:
    index: int
    text: str
    start: int
    end: int
    speaker: str | None
    hour: int | None


def parse_chat_messages(text: str) -> list[ChatMessage]:
    messages: list[ChatMessage] = []
    pending_header: tuple[str, int | None] | None = None
    offset = 0
    for raw_line in text.splitlines(keepends=True):
        line = raw_line.rstrip("\r\n")
        stripped = line.strip()
        line_start = offset
        offset += len(raw_line)
        if not stripped:
            continue

        header = _HEADER_MESSAGE.match(line)
        if header and ":" not in stripped and "：" not in stripped:
            pending_header = (
                header.group("speaker").strip(),
                int(header.group("hour")),
            )
            continue

        inline = _INLINE_MESSAGE.match(line)
        if inline:
            body = inline.group("body").strip()
            body_start = line_start + inline.start("body")
            messages.append(
                ChatMessage(
                    index=len(messages),
                    text=body,
                    start=body_start,
                    end=body_start + len(body),
                    speaker=inline.group("speaker").strip(),
                    hour=(
                        int(inline.group("hour"))
                        if inline.group("hour") is not None
                        else _line_hour(line)
                    ),
                )
            )
            pending_header = None
            continue

        body_start = line_start + len(line) - len(line.lstrip())
        speaker, hour = pending_header or (None, _line_hour(line))
        messages.append(
            ChatMessage(
                index=len(messages),
                text=stripped,
                start=body_start,
                end=body_start + len(stripped),
                speaker=speaker,
                hour=hour,
            )
        )
        pending_header = None

    if not messages and text.strip():
        start = len(text) - len(text.lstrip())
        body = text.strip()
        messages.append(ChatMessage(0, body, start, start + len(body), None, None))
    return messages


def model_message_payload(messages: list[ChatMessage]) -> list[dict[str, object]]:
    if len(messages) > MAX_MESSAGES_FOR_MODEL:
        raise ValueError("聊天消息超过 20000 条，暂不发送给 CLI；本地统计仍可使用。")
    return [
        {
            "index": item.index,
            "speaker": item.speaker,
            "hour": item.hour,
            "text": item.text,
            "locator": {"start": item.start, "end": item.end},
        }
        for item in messages
    ]


def build_chat_analysis(
    source: dict[str, Any],
    text: str,
    messages: list[ChatMessage] | None = None,
    *,
    topic_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if len(text) > MAX_CHAT_CHARACTERS:
        raise ValueError("聊天材料超过 500 万字符，请先按时间分段后再分析。")
    parsed = messages if messages is not None else parse_chat_messages(text)
    if not parsed:
        raise ValueError("聊天材料中没有可分析的文本。")

    terms = _top_terms(parsed)
    speakers = _speaker_activity(parsed)
    time_buckets = _time_activity(parsed)
    if topic_result is None:
        topics = _local_topics(parsed, terms)
        topic_method = "local_frequency_clues"
    else:
        topics = _model_topics(parsed, topic_result)
        topic_method = "cli_assisted"

    limitations = [
        "词频已去除常见语气词，但中文结果是重复词组线索，不等同于精确分词。",
        "说话人和时间统计依赖文本中可识别的“姓名：内容”与时间格式；缺失字段不会猜测。",
        (
            "主题由本机 CLI 归纳，仍需回看原文确认，不能据此推断人格、心理状态或真实意图。"
            if topic_result is not None
            else "本地主题只是按高频词组聚合的线索，不是 AI 语义结论。"
        ),
    ]
    if len(parsed) > MAX_MESSAGES_FOR_MODEL:
        limitations.append("材料超过 20000 条消息：仅完成本地统计，不会把整份材料交给 CLI。")

    result = {
        "schema_version": "0.1",
        "source": {
            "id": str(source["id"]),
            "title": str(source["title"]),
            "sha256": str(source["sha256"]),
            "source_kind": str(source["source_kind"]),
        },
        "topic_method": topic_method,
        "metrics": {
            "characters": len(text),
            "non_whitespace_characters": sum(
                1 for character in text if not character.isspace()
            ),
            "lines": len(text.splitlines()) or 1,
            "messages": len(parsed),
            "participants": len({item.speaker for item in parsed if item.speaker}),
            "timestamped_messages": sum(item.hour is not None for item in parsed),
        },
        "top_terms": terms,
        "speakers": speakers,
        "time_buckets": time_buckets,
        "topics": topics,
        "limitations": limitations,
    }
    return validate_chat_analysis(result)


def _line_hour(line: str) -> int | None:
    match = _HOUR_ONLY.search(line)
    return int(match.group("hour")) if match else None


def _message_terms(text: str) -> Counter[str]:
    cleaned = _URL.sub(" ", text)
    terms: Counter[str] = Counter()
    for match in _LATIN_WORD.findall(cleaned):
        term = match.lower()
        if term not in _STOP_LATIN:
            terms[term] += 1
    for sequence in _HAN_SEQUENCE.findall(cleaned):
        for size in range(2, min(6, len(sequence)) + 1):
            for start in range(0, len(sequence) - size + 1):
                term = sequence[start : start + size]
                if term not in _STOP_TERMS:
                    terms[term] += 1
    return terms


def _top_terms(messages: list[ChatMessage]) -> list[dict[str, object]]:
    occurrences: Counter[str] = Counter()
    message_counts: Counter[str] = Counter()
    for message in messages:
        terms = _message_terms(message.text)
        occurrences.update(terms)
        message_counts.update(terms.keys())

    minimum_messages = 2 if len(messages) >= 3 else 1
    candidates = [
        term
        for term, count in message_counts.items()
        if count >= minimum_messages
    ]
    candidates.sort(
        key=lambda term: (
            -message_counts[term],
            -occurrences[term],
            -len(term),
            term,
        )
    )
    selected: list[str] = []
    for term in candidates:
        if any(
            term in existing
            and message_counts[term] == message_counts[existing]
            for existing in selected
        ):
            continue
        selected.append(term)
        if len(selected) == 16:
            break
    total_messages = len(messages)
    return [
        {
            "term": term,
            "count": occurrences[term],
            "message_count": message_counts[term],
            "message_share": _share(message_counts[term], total_messages),
        }
        for term in selected
    ]


def _speaker_activity(messages: list[ChatMessage]) -> list[dict[str, object]]:
    counts = Counter(item.speaker for item in messages if item.speaker)
    total = sum(counts.values())
    return [
        {
            "name": str(name),
            "message_count": count,
            "message_share": _share(count, total),
        }
        for name, count in sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))
    ]


def _time_activity(messages: list[ChatMessage]) -> list[dict[str, object]]:
    hours = [item.hour for item in messages if item.hour is not None]
    if not hours:
        return []
    return [
        {
            "label": label,
            "message_count": count,
            "message_share": _share(count, len(hours)),
        }
        for label, hour_range in _TIME_BUCKETS
        if (count := sum(hour in hour_range for hour in hours))
    ]


def _local_topics(
    messages: list[ChatMessage],
    terms: list[dict[str, object]],
) -> list[dict[str, object]]:
    topics: list[dict[str, object]] = []
    claimed: set[int] = set()
    term_names = [str(item["term"]) for item in terms]
    for term in term_names:
        indexes = [
            item.index
            for item in messages
            if item.index not in claimed and term.lower() in item.text.lower()
        ]
        if not indexes:
            continue
        claimed.update(indexes)
        related = [
            candidate
            for candidate in term_names
            if candidate != term
            and any(candidate.lower() in messages[index].text.lower() for index in indexes)
        ][:5]
        topics.append(
            _topic_item(
                messages,
                title=f"高频线索：{term}",
                summary=(
                    f"{len(indexes)} 条消息包含“{term}”。"
                    "这是频次聚合，含义和上下文仍需回看原文确认。"
                ),
                keywords=[term, *related],
                indexes=indexes,
            )
        )
        if len(topics) == 6:
            break
    return topics


def _model_topics(
    messages: list[ChatMessage],
    topic_result: dict[str, Any],
) -> list[dict[str, object]]:
    topics: list[dict[str, object]] = []
    for topic in topic_result["topics"]:
        indexes = [int(index) for index in topic["message_indexes"]]
        if any(index < 0 or index >= len(messages) for index in indexes):
            raise ValueError("CLI 主题引用了不存在的消息。")
        topics.append(
            _topic_item(
                messages,
                title=str(topic["title"]),
                summary=str(topic["summary"]),
                keywords=[str(item) for item in topic["keywords"]],
                indexes=indexes,
            )
        )
    return topics


def _topic_item(
    messages: list[ChatMessage],
    *,
    title: str,
    summary: str,
    keywords: list[str],
    indexes: list[int],
) -> dict[str, object]:
    unique_indexes = list(dict.fromkeys(indexes))
    return {
        "title": title,
        "summary": summary,
        "keywords": list(dict.fromkeys(keywords))[:8],
        "message_count": len(unique_indexes),
        "message_share": _share(len(unique_indexes), len(messages)),
        "source_refs": [
            {
                "message_index": index,
                "start": messages[index].start,
                "end": messages[index].start + len(messages[index].text[:500]),
                "quote": messages[index].text[:500],
            }
            for index in unique_indexes[:3]
        ],
    }


def _share(count: int, total: int) -> float:
    return round(count / total, 4) if total else 0.0
