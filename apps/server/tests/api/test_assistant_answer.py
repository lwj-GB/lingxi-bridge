import json
from pathlib import Path

from fastapi.testclient import TestClient
from lingxi.analysis.cli import CliAdapter, CliExecutionError
from lingxi.main import create_app


def test_question_reads_only_selected_person_and_material(tmp_path: Path):
    (tmp_path / "vault").mkdir()
    contexts = []

    class Adapter:
        def answer_workspace_question(self, context):
            contexts.append(context)
            return {"answer": "可以送茶杯，他提到喜欢喝茶。预算还没有记录。", "source_ids": []}

    with TestClient(create_app(cli_adapter_factory=lambda *_: Adapter())) as client:
        assert (
            client.post("/api/workspaces/open", json={"path": str(tmp_path / "vault")}).status_code
            == 200
        )
        person = client.post(
            "/api/people", json={"display_name": "小刘（虚构）", "relation_to_user": "朋友"}
        ).json()
        other = client.post(
            "/api/people", json={"display_name": "其他人（虚构）", "relation_to_user": "朋友"}
        ).json()
        source = client.post(
            "/api/sources/text",
            json={
                "title": "偏好",
                "text": "我喜欢喝茶。",
                "source_kind": "text",
                "person_ids": [person["id"]],
                "event_ids": [],
            },
        ).json()
        foreign = client.post(
            "/api/sources/text",
            json={
                "title": "其他",
                "text": "不能发出的材料",
                "source_kind": "text",
                "person_ids": [other["id"]],
                "event_ids": [],
            },
        ).json()
        payload = {
            "question": "送什么？",
            "person_id": person["id"],
            "source_ids": [source["id"]],
            "engine": "codex",
        }
        assert client.post("/api/assistant/answer", json=payload).status_code == 200
        assert len(contexts) == 1
        assert contexts[0]["sources"][0]["text"] == "我喜欢喝茶。"
        assert "不能发出" not in json.dumps(contexts, ensure_ascii=False)
        assert (
            client.post(
                "/api/assistant/answer", json={**payload, "source_ids": [foreign["id"]]}
            ).status_code
            == 422
        )
        assert len(contexts) == 1
        assert (
            client.post(
                "/api/assistant/answer", json={**payload, "engine": "local_demo"}
            ).status_code
            == 422
        )


def test_unavailable_model_is_not_a_successful_answer(tmp_path: Path):
    (tmp_path / "vault").mkdir()

    def factory(*_args):
        raise CliExecutionError("not available")

    with TestClient(create_app(cli_adapter_factory=factory)) as client:
        client.post("/api/workspaces/open", json={"path": str(tmp_path / "vault")})
        person = client.post(
            "/api/people", json={"display_name": "虚构", "relation_to_user": "朋友"}
        ).json()
        response = client.post(
            "/api/assistant/answer",
            json={"question": "你好", "person_id": person["id"], "engine": "codex"},
        )
        assert response.status_code == 503
        assert "answer" not in response.json()


def test_question_cli_receives_rules_and_returns_verified_citations(tmp_path: Path):
    import sys

    executable = tmp_path / "test-cli"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """import json,sys
prompt=sys.stdin.read()
assert "先回答问题" in prompt
assert "喜欢喝茶" in prompt
assert "workspace-rules" not in prompt
print(json.dumps({"answer":"送茶杯。", "source_ids":["s1"]}))
"""
    )
    executable.chmod(0o700)
    result = CliAdapter("claude", executable).answer_workspace_question(
        {
            "question": "礼物",
            "person": {},
            "sources": [{"id": "s1", "text": "喜欢喝茶"}],
            "evidence": [],
        }
    )
    assert result["answer"] == "送茶杯。"
