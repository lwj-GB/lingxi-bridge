from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from lingxi.workspace.service import WorkspaceError, WorkspaceService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lingxi",
        description="Operate one explicitly selected Lingxi local workspace.",
    )
    parser.add_argument(
        "--vault",
        required=True,
        help="Absolute path to the Lingxi workspace.",
    )
    groups = parser.add_subparsers(dest="group", required=True)

    workspace = groups.add_parser("workspace", help="Inspect workspace state.")
    workspace.add_subparsers(dest="action", required=True).add_parser("summary")

    people = groups.add_parser("people", help="Read and edit contacts.")
    people_actions = people.add_subparsers(dest="action", required=True)
    people_actions.add_parser("list")
    people_show = people_actions.add_parser("show")
    people_show.add_argument("--id", required=True)
    people_create = people_actions.add_parser("create")
    people_create.add_argument("--name", required=True)
    people_create.add_argument("--relation", required=True)
    people_update = people_actions.add_parser("update")
    people_update.add_argument("--id", required=True)
    people_update.add_argument("--name")
    people_update.add_argument("--relation")
    people_archive = people_actions.add_parser(
        "archive",
        help="Move an unreferenced contact to the recoverable archive.",
    )
    people_archive.add_argument("--id", required=True)
    people_archive.add_argument(
        "--confirm",
        action="store_true",
        help="Confirm the explicit contact archive operation.",
    )

    reports = groups.add_parser("reports", help="Read generated reports.")
    report_actions = reports.add_subparsers(dest="action", required=True)
    report_actions.add_parser("list")
    report_show = report_actions.add_parser("show")
    report_show.add_argument("--id", required=True, help="Report topic ID.")
    return parser


def execute(args: argparse.Namespace) -> Any:
    vault = Path(args.vault).expanduser()
    service = WorkspaceService()
    summary = service.open(vault)

    if args.group == "workspace":
        return summary
    if args.group == "people":
        if args.action == "list":
            return {"items": service.list_entities("person")}
        if args.action == "show":
            return service.get_entity(args.id, "person")
        if args.action == "create":
            return service.create_person(args.name, args.relation)
        if args.action == "update":
            if args.name is None and args.relation is None:
                raise WorkspaceError(
                    "validation_error",
                    "people update 至少需要 --name 或 --relation。",
                )
            return service.update_person(
                args.id,
                display_name=args.name,
                relation_to_user=args.relation,
            )
        if args.action == "archive":
            if not args.confirm:
                raise WorkspaceError(
                    "confirmation_required",
                    "people archive 需要显式提供 --confirm。",
                )
            return service.archive_person(args.id)
    if args.group == "reports":
        reports = service.list_entities("report")
        if args.action == "list":
            return {"items": reports}
        for report in reports:
            if report["topic"]["id"] == args.id:
                return report
        raise WorkspaceError(
            "reference_not_found",
            "报告主题不存在。",
            details={"record_id": args.id, "expected_type": "report_topic"},
        )
    raise WorkspaceError("validation_error", "未知 CLI 操作。")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = execute(args)
    except WorkspaceError as error:
        print(
            json.dumps(
                {
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "details": error.details,
                    }
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
