from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ReportIntent:
    family: str
    variant: str
    label: str
    keywords: tuple[str, ...]
    minimum_evidence: int
    questions: tuple[str, ...]
    recommended_materials: tuple[str, ...]


INTENTS = (
    ReportIntent(
        "relation",
        "romantic",
        "恋爱关系",
        (
            "恋爱",
            "伴侣",
            "亲密",
            "约会",
            "表白",
            "爱情",
            "婚恋",
            "关系",
            "边界",
            "在意",
            "不满",
            "分歧",
        ),
        2,
        (
            "在亲密关系里，对方通常如何表达在意或不满？",
            "遇到分歧时，对方更倾向立即沟通、暂时回避，还是寻求他人帮助？",
            "对方明确说过哪些对恋爱、边界或长期关系的看法？",
        ),
        ("相关聊天原文", "具体相处事件", "对方对关系与边界的直接表达"),
    ),
    ReportIntent(
        "relation",
        "family_parent",
        "家庭与亲子",
        ("家庭", "父母", "妈妈", "爸爸", "孩子", "小孩", "亲子", "家长"),
        2,
        (
            "这个人在家庭生活中最稳定的日常习惯是什么？",
            "面对提醒、规则或冲突时，他通常有什么可观察到的反应？",
            "最近一次让你印象深刻的家庭互动是什么？",
        ),
        ("日常行为记录", "具体家庭互动", "本人表达或可核对的聊天原文"),
    ),
    ReportIntent(
        "relation",
        "mentor_collaboration",
        "师生与协作",
        ("老师", "领导", "上司", "同事", "工作", "协作", "合作", "师生"),
        2,
        (
            "对方在分工、反馈或截止时间上有过哪些明确表达？",
            "出现意见不一致时，对方通常如何处理？",
            "哪些具体协作事件最能说明你现在关心的问题？",
        ),
        ("工作或学习沟通原文", "具体协作事件", "任务反馈与结果"),
    ),
    ReportIntent(
        "relation",
        "friend_social",
        "朋友与社交",
        ("朋友", "闺蜜", "兄弟", "社交", "友谊", "友情"),
        2,
        (
            "你们通常在哪些事情上最容易聊得来或产生分歧？",
            "对方维护友谊时有哪些可观察到的做法？",
            "最近一次有代表性的互动是什么？",
        ),
        ("聊天原文", "共同经历", "对方关于友谊的直接表达"),
    ),
    ReportIntent(
        "person_long_term",
        "preferences_habits",
        "偏好与习惯",
        ("习惯", "偏好", "爱好", "喜欢", "不喜欢", "日常", "作息"),
        2,
        (
            "有哪些行为在不同场景下重复出现？",
            "这些习惯出现的时间、场景和频率是什么？",
            "哪些是对方亲口表达的偏好，哪些只是你的观察？",
        ),
        ("多次日常观察", "本人关于偏好的直接表达", "带时间与场景的具体记录"),
    ),
    ReportIntent(
        "person_long_term",
        "experiences_values",
        "经历与价值观",
        ("经历", "价值观", "原则", "理想", "选择", "成长"),
        2,
        (
            "哪些关键经历对这个人产生过可观察到的影响？",
            "面对重要选择时，对方明确表达过哪些原则？",
            "有没有与这些原则不一致的具体事件需要一起保留？",
        ),
        ("本人讲述的关键经历", "重要选择记录", "能体现或反驳某种价值取向的原文"),
    ),
    ReportIntent(
        "recent_change",
        "recent_state",
        "近期变化",
        ("最近", "近期", "变化", "状态", "这段时间"),
        2,
        (
            "最近具体发生了哪些与过去不同的行为或表达？",
            "变化从什么时候开始，持续了多久？",
            "是否存在工作、家庭、健康等其他可能解释？",
        ),
        ("带日期的近期记录", "可对照的过去材料", "可能影响状态的背景事件"),
    ),
    ReportIntent(
        "special",
        "gift_advice",
        "礼物建议",
        ("礼物", "送什么", "生日"),
        1,
        (
            "对方最近明确喜欢或需要什么？",
            "这次送礼的场景、预算和你们的关系边界是什么？",
        ),
        ("本人明确表达的偏好", "以往送礼反馈", "场景与预算"),
    ),
    ReportIntent(
        "special",
        "communication_prep",
        "沟通准备",
        ("沟通", "怎么说", "谈一谈", "谈话", "交流"),
        1,
        (
            "你希望这次沟通解决什么具体问题？",
            "对方之前对这件事说过什么，是否有明确边界？",
            "哪些事实是双方都能核对的？",
        ),
        ("相关对话原文", "具体事件时间线", "双方都能确认的事实"),
    ),
    ReportIntent(
        "special",
        "conflict_review",
        "冲突复盘",
        ("冲突", "吵架", "矛盾", "争执", "不愉快"),
        2,
        (
            "冲突发生前后，双方分别说了什么、做了什么？",
            "哪些是事实，哪些是你当时的感受或推测？",
            "双方是否提出过明确诉求或边界？",
        ),
        ("完整对话原文", "冲突前后时间线", "双方明确诉求"),
    ),
    ReportIntent(
        "special",
        "behavior_interpretation",
        "行为解释",
        ("行为", "动作", "为什么", "表现", "反应"),
        2,
        (
            "你观察到的具体行为是什么，发生在什么场景？",
            "同样行为是否重复出现，是否有相反例子？",
            "当事人是否解释过自己的原因？",
        ),
        ("具体行为记录", "相反案例", "当事人的直接解释"),
    ),
    ReportIntent(
        "person_long_term",
        "overview",
        "综合概览",
        ("性格", "心理", "整体", "综合", "了解", "分析", "报告"),
        2,
        (
            "你最想了解这个人的哪一方面？",
            "有哪些重复出现、可以核对的行为或表达？",
            "是否有与当前印象相反的例子？",
        ),
        ("不同场景的原始材料", "本人直接表达", "能支持与反驳当前印象的具体事件"),
    ),
)

INTENT_BY_VARIANT = {intent.variant: intent for intent in INTENTS}


def advise_report(
    person: dict[str, Any],
    evidence: list[dict[str, Any]],
    request_text: str,
    explicit_evidence_ids: set[str] | None = None,
    template_family: str | None = None,
    template_variant: str | None = None,
) -> dict[str, Any]:
    intent = (
        _explicit_intent(template_family, template_variant, request_text)
        if template_family and template_variant
        else _match_intent(request_text, str(person.get("relation_to_user", "")))
    )
    relevant = [
        item
        for item in evidence
        if any(keyword in str(item.get("quote", "")) for keyword in intent.keywords)
    ]
    explicit_ids = explicit_evidence_ids or set()
    explicit = [item for item in evidence if str(item["id"]) in explicit_ids]
    selected_by_id = {
        str(item["id"]): item
        for item in (*relevant, *explicit)
    }
    selected = list(selected_by_id.values())
    enough = len(relevant) >= intent.minimum_evidence or bool(explicit)
    display_name = str(person.get("display_name", "这位联系人"))
    title = f"{display_name} · {intent.label}"
    if enough:
        reply = (
            f"现有资料足以先生成一版“{intent.label}”报告。"
            "我已选出可回链的材料；请在下方核对范围后生成。"
        )
    else:
        missing = intent.minimum_evidence - len(selected)
        reply = (
            f"现有资料还不足以稳妥生成“{intent.label}”报告，"
            f"至少还需要 {missing} 条具体、可核对的信息。"
            "你可以直接回答下面的问题，回答会先保存为原始材料。"
        )
    return {
        "status": "ready" if enough else "needs_input",
        "reply": reply,
        "proposed_report": {
            "title": title,
            "template_family": intent.family,
            "template_variant": intent.variant,
            "analysis_question": request_text,
        },
        "evidence_ids": [str(item["id"]) for item in selected] if enough else [],
        "questions": [] if enough else list(intent.questions),
        "recommended_materials": [] if enough else list(intent.recommended_materials),
    }


def suggested_prompts(relation_to_user: str) -> list[str]:
    relation = relation_to_user.lower()
    if any(word in relation for word in ("恋人", "伴侣", "男朋友", "女朋友", "对象")):
        return [
            "整理一份恋爱关系报告",
            "我们沟通时有哪些需要注意的地方？",
            "现有资料能看出哪些相处习惯？",
        ]
    if any(word in relation for word in ("孩子", "女儿", "儿子", "父母", "妈妈", "爸爸")):
        return ["整理家庭与亲子报告", "分析可观察到的日常习惯", "最近有哪些变化值得继续记录？"]
    if any(word in relation for word in ("老师", "领导", "上司", "同事")):
        return ["整理师生与协作报告", "为下一次沟通做准备", "复盘最近一次分歧"]
    if any(word in relation for word in ("朋友", "闺蜜", "兄弟")):
        return ["整理朋友与社交报告", "总结相处偏好与习惯", "为下一次重要沟通做准备"]
    return ["先生成一份综合概览", "总结偏好与习惯", "最近有哪些变化？"]


def _match_intent(request_text: str, relation_to_user: str) -> ReportIntent:
    normalized = request_text.strip().lower()
    for intent in INTENTS:
        if any(keyword in normalized for keyword in intent.keywords):
            return intent
    relation = relation_to_user.lower()
    relation_defaults = (
        (("恋人", "伴侣", "男朋友", "女朋友", "对象"), "romantic"),
        (("孩子", "女儿", "儿子", "父母", "妈妈", "爸爸"), "family_parent"),
        (("老师", "领导", "上司", "同事"), "mentor_collaboration"),
        (("朋友", "闺蜜", "兄弟"), "friend_social"),
    )
    for words, variant in relation_defaults:
        if any(word in relation for word in words):
            return INTENT_BY_VARIANT[variant]
    return INTENT_BY_VARIANT["overview"]


def _explicit_intent(
    family: str,
    variant: str,
    request_text: str,
) -> ReportIntent:
    known = INTENT_BY_VARIANT.get(variant)
    if known is not None and known.family == family:
        return known
    if family == "relation" and variant == "other":
        return ReportIntent(
            family,
            variant,
            "关系报告",
            ("关系", "互动", "沟通", "边界"),
            1,
            (
                "哪些互动事实与这次关系问题直接相关？",
                "对方明确表达过哪些需要、边界或不同意见？",
            ),
            ("相关聊天原文", "具体互动事件", "双方可核对的直接表达"),
        )
    if family == "special" and variant == "custom":
        chat_analysis = "聊天" in request_text
        return ReportIntent(
            family,
            variant,
            "聊天记录分析" if chat_analysis else "自定义分析",
            ("聊天", "对话", "互动", "表达") if chat_analysis else (),
            1,
            (
                "哪些原始片段与这次问题直接相关？",
                "还需要补充什么时间、场景或相反例子？",
            ),
            ("可回链的原始文本", "带时间与说话人的上下文"),
        )
    return _match_intent(request_text, "")
