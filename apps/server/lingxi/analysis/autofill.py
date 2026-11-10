from __future__ import annotations

import re
from typing import Any

from jsonschema import ValidationError

from lingxi.analysis.schema import schema_validator

PROFILE_SECTIONS = (
    "basic_info",
    "appearance_style",
    "preferences",
    "habits",
    "important_experiences",
    "works_expression",
    "social_content",
    "interactions",
    "user_observations",
)

_PERSON_FIELDS = {
    "姓名": "display_name",
    "名字": "display_name",
    "昵称": "display_name",
    "关系": "relation_to_user",
    "与我的关系": "relation_to_user",
}

_SECTION_LABELS = {
    "年龄": ("basic_info", "年龄"),
    "生日": ("basic_info", "生日"),
    "出生": ("basic_info", "出生信息"),
    "职业": ("basic_info", "职业"),
    "工作": ("basic_info", "工作"),
    "学校": ("basic_info", "学校"),
    "城市": ("basic_info", "所在城市"),
    "居住地": ("basic_info", "居住地"),
    "外貌": ("appearance_style", "外貌"),
    "穿搭": ("appearance_style", "穿搭"),
    "风格": ("appearance_style", "风格"),
    "喜欢": ("preferences", "喜欢"),
    "偏好": ("preferences", "偏好"),
    "爱好": ("preferences", "爱好"),
    "兴趣": ("preferences", "兴趣"),
    "习惯": ("habits", "习惯"),
    "通常": ("habits", "通常"),
    "经常": ("habits", "经常"),
    "经历": ("important_experiences", "重要经历"),
    "曾经": ("important_experiences", "曾经"),
    "重要经历": ("important_experiences", "重要经历"),
    "作品": ("works_expression", "作品"),
    "文章": ("works_expression", "文章"),
    "表达": ("works_expression", "表达"),
    "社交": ("social_content", "社交内容"),
    "动态": ("social_content", "公开动态"),
    "互动": ("interactions", "互动"),
    "聊天": ("interactions", "聊天"),
    "沟通": ("interactions", "沟通"),
    "我的观察": ("user_observations", "我的观察"),
}

_PREFIXES = sorted(
    {*_PERSON_FIELDS, *_SECTION_LABELS},
    key=len,
    reverse=True,
)
_EXPLICIT_LINE = re.compile(
    rf"(?m)^[ \t]*(?P<label>{'|'.join(map(re.escape, _PREFIXES))})"
    r"[：:][ \t]*(?P<value>[^\r\n]+)"
)


def profile_autofill_validator():
    return schema_validator("profile-autofill.schema.json")


def validate_profile_autofill(
    value: dict[str, Any],
    source_text: str,
) -> dict[str, Any]:
    profile_autofill_validator().validate(value)
    for candidate in value["candidates"]:
        start = candidate["start"]
        end = candidate["end"]
        if end <= start or source_text[start:end] != candidate["quote"]:
            raise ValidationError("autofill quote locator did not match source text")
    return value


def build_local_autofill(source_text: str) -> dict[str, Any]:
    person: dict[str, str | None] = {
        "display_name": None,
        "relation_to_user": None,
    }
    candidates: list[dict[str, Any]] = []
    present_sections: set[str] = set()

    for match in _EXPLICIT_LINE.finditer(source_text):
        prefix = match.group("label")
        value = match.group("value").strip()
        if not value:
            continue
        if prefix in _PERSON_FIELDS:
            field = _PERSON_FIELDS[prefix]
            if person[field] is None:
                person[field] = value[:120]
            continue

        section, label = _SECTION_LABELS[prefix]
        raw_line = match.group(0)
        leading = len(raw_line) - len(raw_line.lstrip())
        quote = raw_line.strip()
        start = match.start() + leading
        candidates.append(
            {
                "section": section,
                "label": label,
                "value": value[:4000],
                "quote": quote[:8000],
                "start": start,
                "end": start + len(quote[:8000]),
                "confidence": "high",
            }
        )
        present_sections.add(section)

    if person["display_name"] or person["relation_to_user"]:
        present_sections.add("basic_info")
    preview = {
        "schema_version": "0.1",
        "person": person,
        "candidates": candidates,
        "skipped_sections": [
            section for section in PROFILE_SECTIONS if section not in present_sections
        ],
    }
    return validate_profile_autofill(preview, source_text)
