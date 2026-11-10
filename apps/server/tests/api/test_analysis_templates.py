import json
from pathlib import Path

from fastapi.testclient import TestClient
from lingxi.main import create_app

CUSTOM_TEMPLATE = {
    "id": "custom_conversation_review",
    "name": "我的沟通复盘",
    "category": "workplace",
    "description": "只复盘一次已经发生的沟通，不扩展为人格判断。",
    "dimensions": ["双方原话", "已确认事项", "需要继续澄清的问题"],
    "evidence_requirements": ["每项观察回链到原始材料"],
    "forbidden_conclusions": ["不得推断忠诚度或危险性"],
    "template_family": "special",
    "template_variant": "communication_prep",
    "default_question": "请区分原话、解释和未知项，复盘这次沟通。",
}


def _open(client: TestClient, vault: Path) -> None:
    response = client.post("/api/workspaces/open", json={"path": str(vault)})
    assert response.status_code == 200


def test_analysis_templates_have_safe_builtins_without_creating_a_file(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        _open(client, tmp_path)
        response = client.get("/api/analysis-templates")

    assert response.status_code == 200
    result = response.json()
    assert result["active_template_id"] == "general_relationship"
    assert result["file_hash"] is None
    assert len(result["items"]) == 13
    assert {item["source"] for item in result["items"]} == {"built_in"}
    assert not (tmp_path / "analysis-templates.json").exists()
    templates = {item["id"]: item for item in result["items"]}
    assert "孩子的表达和视角" in templates["family_parent_child"]["dimensions"]
    for template_id in (
        "cognitive_behavior_review",
        "development_learning_support",
        "systemic_interaction_review",
        "humanistic_listening",
        "motivation_change",
        "narrative_meaning",
    ):
        template = templates[template_id]
        assert len(template["dimensions"]) == 4
        assert template["evidence_requirements"] and template["forbidden_conclusions"]


def test_custom_analysis_template_is_an_open_portable_workspace_file(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        _open(client, tmp_path)
        response = client.put(
            "/api/analysis-templates",
            json={
                "active_template_id": CUSTOM_TEMPLATE["id"],
                "custom_templates": [CUSTOM_TEMPLATE],
                "expected_hash": None,
            },
        )

    assert response.status_code == 200
    result = response.json()
    assert result["active_template_id"] == CUSTOM_TEMPLATE["id"]
    assert result["file_hash"]
    assert result["items"][-1] == {**CUSTOM_TEMPLATE, "source": "custom"}
    saved = json.loads((tmp_path / "analysis-templates.json").read_text())
    assert saved == {
        "schema_version": "0.1",
        "active_template_id": CUSTOM_TEMPLATE["id"],
        "custom_templates": [CUSTOM_TEMPLATE],
    }


def test_template_save_does_not_overwrite_an_external_ai_edit(
    tmp_path: Path,
) -> None:
    with TestClient(create_app()) as client:
        _open(client, tmp_path)
        created = client.put(
            "/api/analysis-templates",
            json={
                "active_template_id": "general_relationship",
                "custom_templates": [],
                "expected_hash": None,
            },
        ).json()
        path = tmp_path / "analysis-templates.json"
        external = json.loads(path.read_text())
        external["active_template_id"] = "romantic_connection"
        path.write_text(json.dumps(external, ensure_ascii=False, indent=2) + "\n")

        response = client.put(
            "/api/analysis-templates",
            json={
                "active_template_id": CUSTOM_TEMPLATE["id"],
                "custom_templates": [CUSTOM_TEMPLATE],
                "expected_hash": created["file_hash"],
            },
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "workspace_conflict"
    assert json.loads(path.read_text())["active_template_id"] == "romantic_connection"


def test_template_config_rejects_an_unknown_active_template(tmp_path: Path) -> None:
    with TestClient(create_app()) as client:
        _open(client, tmp_path)
        response = client.put(
            "/api/analysis-templates",
            json={
                "active_template_id": "missing_template",
                "custom_templates": [],
                "expected_hash": None,
            },
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_template_config"
