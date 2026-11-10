import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from lingxi.analysis.placeholder import build_safe_placeholder


def test_safe_placeholder_is_schema_valid_and_separates_claim_kinds() -> None:
    evidence_id = "30000000-0000-4000-8000-000000000001"
    source_id = "20000000-0000-4000-8000-000000000001"
    analysis = build_safe_placeholder(
        [
            {
                "id": evidence_id,
                "source_id": source_id,
                "quote": "她说最近更喜欢安静地散步。",
                "reliability": "medium",
            }
        ]
    )

    schema_path = (
        Path(__file__).resolve().parents[4]
        / "packages"
        / "schemas"
        / "analysis-output.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(analysis)

    claims_by_kind = {claim["claim_type"]: claim for claim in analysis["claims"]}
    assert set(claims_by_kind) == {
        "observation",
        "hypothesis",
        "unknown",
        "suggestion",
    }
    assert claims_by_kind["observation"]["evidence_ids"] == [evidence_id]
    assert claims_by_kind["hypothesis"]["alternatives"]
    assert all(claim["evidence_ids"] == [evidence_id] for claim in analysis["claims"])
    assert analysis["material_scope"] == [source_id]
