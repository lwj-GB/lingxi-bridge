from typing import Any

from lingxi.analysis.schema import validate_analysis


def build_safe_placeholder(evidence: list[dict[str, Any]]) -> dict[str, Any]:
    if not evidence:
        raise ValueError("safe_placeholder requires at least one evidence item")

    evidence_ids = [str(item["id"]) for item in evidence]
    source_ids = list(dict.fromkeys(str(item["source_id"]) for item in evidence))
    claims: list[dict[str, Any]] = []
    for item in evidence:
        quote = " ".join(str(item.get("quote", "")).split())
        if quote:
            text = f"材料中可直接核对到这段表述：{quote[:160]}"
        else:
            text = "材料中存在一条已定位、可回链的记录。"
        claims.append(
            {
                "claim_type": "observation",
                "text": text,
                "evidence_ids": [str(item["id"])],
            }
        )

    claims.extend(
        [
            {
                "claim_type": "hypothesis",
                "text": "这些材料可能反映了当时的关注、偏好或沟通需要。",
                "evidence_ids": evidence_ids,
                "uncertainty": "high",
                "alternatives": [
                    "也可能只是特定情境下的临时表达，不能据此推断稳定特征。"
                ],
            },
            {
                "claim_type": "unknown",
                "text": "现有材料不足以判断这种表达是否持续、是否适用于其他情境。",
                "evidence_ids": evidence_ids,
            },
            {
                "claim_type": "suggestion",
                "text": (
                    "先核对材料发生的时间和情境，再用开放式问题询问当事人的当前想法；"
                    "记录对方的纠正，并约定是否需要后续跟进。"
                ),
                "evidence_ids": evidence_ids,
            },
        ]
    )
    return validate_analysis(
        {
            "schema_version": "0.1",
            "material_scope": source_ids,
            "claims": claims,
        }
    )
