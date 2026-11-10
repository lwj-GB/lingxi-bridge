import json
from pathlib import Path

import pytest
from lingxi.cli import main
from lingxi.workspace.service import WorkspaceError, WorkspaceService


def test_cli_creates_lists_and_updates_people(
    tmp_path: Path,
    capsys: object,
) -> None:
    assert main(
        [
            "--vault",
            str(tmp_path),
            "people",
            "create",
            "--name",
            "林澄（虚构）",
            "--relation",
            "朋友",
        ]
    ) == 0
    created = json.loads(capsys.readouterr().out)

    assert main(
        [
            "--vault",
            str(tmp_path),
            "people",
            "update",
            "--id",
            created["id"],
            "--relation",
            "同事",
        ]
    ) == 0
    updated = json.loads(capsys.readouterr().out)

    assert main(["--vault", str(tmp_path), "people", "list"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert updated["relation_to_user"] == "同事"
    assert listed["items"][0]["id"] == created["id"]


def test_cli_archives_only_after_explicit_confirmation(
    tmp_path: Path,
    capsys: object,
) -> None:
    assert main(
        [
            "--vault",
            str(tmp_path),
            "people",
            "create",
            "--name",
            "周岚（虚构）",
            "--relation",
            "同学",
        ]
    ) == 0
    created = json.loads(capsys.readouterr().out)

    command = [
        "--vault",
        str(tmp_path),
        "people",
        "archive",
        "--id",
        created["id"],
    ]
    assert main(command) == 2
    error = json.loads(capsys.readouterr().err)
    assert error["error"]["code"] == "confirmation_required"

    assert main([*command, "--confirm"]) == 0
    archived = json.loads(capsys.readouterr().out)
    assert archived == {
        "id": created["id"],
        "archived_to": f"归档/联系人/{created['id']}.md",
        "recoverable": True,
    }
    assert (tmp_path / archived["archived_to"]).is_file()
    assert main(["--vault", str(tmp_path), "people", "list"]) == 0
    assert json.loads(capsys.readouterr().out)["items"] == []


def test_archive_person_refuses_to_break_existing_material_links(
    tmp_path: Path,
) -> None:
    service = WorkspaceService()
    service.open(tmp_path)
    person = service.create_person("沈屿（虚构）", "朋友")
    service.import_text_source(
        "虚构观察",
        "这是仅用于测试的虚构材料。",
        "user_observation",
        [person["id"]],
        [],
    )

    with pytest.raises(WorkspaceError) as caught:
        service.archive_person(person["id"])

    assert caught.value.code == "person_has_dependencies"
    assert caught.value.status_code == 409
    assert caught.value.details["dependencies"]["source"]
    assert (tmp_path / "people" / f"{person['id']}.md").is_file()
