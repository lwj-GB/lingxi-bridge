from __future__ import annotations

import hashlib
import html
import json
import os
import sqlite3
import tempfile
import threading
import uuid
import zipfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from jsonschema.exceptions import ValidationError

from lingxi.analysis.report_charts import ASSET_TYPES, ReportChartError, generate_report_charts
from lingxi.analysis.schema import schema_validator
from lingxi.index import DerivedIndex, IndexRecord

SCHEMA_VERSION = "0.1"
ENTITY_DIRECTORIES = {
    "person": "people",
    "relation": "relations",
    "event": "events",
    "source": "sources",
    "screenshot_transcript": "transcripts",
    "evidence": "evidence",
    "report_topic": "reports",
    "report_snapshot": "reports/snapshots",
}
ENTITY_ALIASES = {
    "people": "person",
    "events": "event",
    "sources": "source",
    "transcripts": "screenshot_transcript",
    "reports": "report",
    "snapshots": "report_snapshot",
}
PROFILE_SECTION_LABELS = {
    "basic_info": "基础信息",
    "appearance_style": "外貌与穿搭",
    "preferences": "饮食与生活偏好",
    "habits": "习惯",
    "important_experiences": "重要经历",
    "works_expression": "作品与表达",
    "social_content": "社交内容",
    "interactions": "互动",
    "user_observations": "用户观察",
}
SCREENSHOT_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
MAX_SCREENSHOTS = 20
MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024
MAX_SCREENSHOT_BATCH_BYTES = 100 * 1024 * 1024
ANALYSIS_TEMPLATES_FILE = "analysis-templates.json"
BUILTIN_ANALYSIS_TEMPLATES = [
    {
        "id": "general_relationship",
        "name": "通用关系理解",
        "category": "general",
        "description": "从事实、互动模式、未知项和可执行沟通问题四个层次整理资料。",
        "dimensions": ["可核对事实", "互动模式", "可能解释", "未知与待确认项"],
        "evidence_requirements": [
            "每项判断必须回链到所选原始材料",
            "主观推断必须标明不确定性",
        ],
        "forbidden_conclusions": ["不得把单次行为写成人格定论", "不得推断未被材料支持的内心意图"],
        "template_family": "person_long_term",
        "template_variant": "overview",
        "default_question": "请整理目前能够由材料支持的人物与关系观察，并区分事实、假设和未知项。",
    },
    {
        "id": "romantic_connection",
        "name": "恋爱与暧昧关系",
        "category": "romantic",
        "description": "用于伴侣、男女朋友、约会对象或 Crush，关注边界、表达与冲突修复。",
        "dimensions": ["亲密表达", "边界与期待", "冲突与修复", "关系中的未知项"],
        "evidence_requirements": ["优先引用双方原话和具体互动", "区分对方表达与用户解释"],
        "forbidden_conclusions": ["不得给出依恋类型定论", "不得把暧昧行为解释为确定意图"],
        "template_family": "relation",
        "template_variant": "romantic",
        "default_question": (
            "请分析这段关系中的表达、边界、期待与冲突修复线索，"
            "并指出仍需直接沟通的问题。"
        ),
    },
    {
        "id": "family_parent_child",
        "name": "家长理解孩子",
        "category": "family",
        "description": "从家长具体关切出发，同时保留孩子表达、成长任务与自主空间。",
        "dimensions": [
            '家长关切与具体情境',
            '孩子的表达和视角',
            '成长需要与自主边界',
            '可协商的支持行动',
        ],
        "evidence_requirements": ["区分直接表达与第三方转述", "涉及儿童时只使用必要材料"],
        "forbidden_conclusions": ["不得诊断家庭成员", "不得替代监护、医疗或专业干预决策"],
        "template_family": "relation",
        "template_variant": "family_parent",
        "default_question": (
            "围绕家长最想理解的具体问题核对材料；保留孩子自己的表达与可能视角，"
            "区分家长期待和孩子需要，提出可协商的小步支持，不贴人格或疾病标签。"
        ),
    },
    {
        "id": "education_mentor",
        "name": "导师与师生协作",
        "category": "education",
        "description": "用于大学导师、任课老师或中小学教师，关注沟通预期、反馈与学习支持。",
        "dimensions": ["任务预期", "反馈方式", "沟通节奏", "需要澄清的问题"],
        "evidence_requirements": ["引用具体要求、反馈或安排", "区分制度要求与个人偏好"],
        "forbidden_conclusions": ["不得用于自动评价教师或学生", "不得推断能力、品行或心理状态"],
        "template_family": "relation",
        "template_variant": "mentor_collaboration",
        "default_question": (
            "请整理师生或导师协作中的预期、反馈方式和待澄清事项，"
            "帮助准备下一次沟通。"
        ),
    },
    {
        "id": "peer_friendship",
        "name": "朋友与同辈关系",
        "category": "friendship",
        "description": "用于朋友、闺蜜、同学与其他同辈，关注互动偏好、支持与误解修复。",
        "dimensions": ["互动偏好", "支持方式", "共同经历", "可能的误解"],
        "evidence_requirements": ["优先使用具体共同经历", "保留与现有解释不一致的材料"],
        "forbidden_conclusions": [
            "不得把社交频率等同于关系质量",
            "不得推断未表达的好恶",
        ],
        "template_family": "relation",
        "template_variant": "friend_social",
        "default_question": (
            "请基于共同经历整理这段同辈关系中的互动偏好、"
            "支持方式和需要澄清的误解。"
        ),
    },
    {
        "id": "workplace_collaboration",
        "name": "同事、上下级与协作",
        "category": "workplace",
        "description": "用于同事、领导、下属、合作方与谈判准备，关注目标、角色和沟通策略。",
        "dimensions": ["角色与目标", "决策与反馈方式", "利益与约束", "下一次沟通准备"],
        "evidence_requirements": ["引用明确的任务、承诺和反馈", "区分组织规则与个人判断"],
        "forbidden_conclusions": [
            "不得用于招聘、晋升或政务自动决策",
            "不得输出忠诚度、危险性或人格评分",
        ],
        "template_family": "special",
        "template_variant": "communication_prep",
        "default_question": (
            "请整理协作双方的目标、角色、已知约束与沟通风险，"
            "为下一次会谈准备可验证的问题。"
        ),
    },
    {
        "id": "professional_observation",
        "name": "非临床心理观察",
        "category": "professional_support",
        "description": "为咨询、教育和社会支持场景整理情绪表达、需要与变化线索，不作诊断。",
        "dimensions": ["情绪表达", "需要与压力来源", "行为变化", "支持与转介信息"],
        "evidence_requirements": ["注明时间范围和材料来源", "保留替代解释与信息缺口"],
        "forbidden_conclusions": ["不得诊断精神疾病", "不得输出危险性判断或心理评分"],
        "template_family": "recent_change",
        "template_variant": "recent_state",
        "default_question": (
            "请整理材料中的情绪表达、需要和近期变化，明确不确定性，"
            "并只给出低风险的支持与求助建议。"
        ),
    },

    {
        "id": "cognitive_behavior_review",
        "name": "认知与行为线索",
        "category": "professional_support",
        "description": "借鉴认知行为视角，整理具体情境与反应链条，不推断稳定人格。",
        "dimensions": ["触发情境", "当事人明确表达的想法", "情绪与行动", "替代解释与可尝试行动"],
        "evidence_requirements": ["只将原话记为当事人想法", "情绪强度和身体反应未提供则写未知"],
        "forbidden_conclusions": ["不得把推测写成认知偏差定论", "不得诊断或提供治疗方案"],
        "template_family": "special",
        "template_variant": "behavior_interpretation",
        "default_question": (
            '选取材料中的一次具体经历，梳理情境、明确表达的想法、情绪和行'
            '动；保留替代解释，提出一个可核对问题。'
        ),
    },
    {
        "id": "development_learning_support",
        "name": "发展与学习支持",
        "category": "education",
        "description": "关注成长阶段、任务难度和环境支持，避免用一次表现评价孩子。",
        "dimensions": [
            '当前学习任务与关切',
            '孩子已有能力与兴趣',
            '任务和环境条件',
            '孩子参与的支持尝试',
        ],
        "evidence_requirements": ["年龄和成长阶段只取自明确资料", "区分观察、成人评价与孩子自述"],
        "forbidden_conclusions": [
            '不得推断智力、发育异常或学习障碍',
            '不得排名、打分或给孩子贴标签',
        ],
        "template_family": "relation",
        "template_variant": "mentor_collaboration",
        "default_question": (
            '围绕具体学习困难，分别整理成人关切、孩子视角、已有优势和环境'
            '条件；信息不足先提问，与孩子共同设计小步尝试。'
        ),
    },
    {
        "id": "systemic_interaction_review",
        "name": "系统互动与沟通循环",
        "category": "family",
        "description": "观察双方回应如何形成循环，兼顾家庭、同辈或团队的环境约束。",
        "dimensions": ["互动发生的情境", "双方回应顺序", "各方需要与约束", "循环中的例外和调整点"],
        "evidence_requirements": ["互动顺序必须有原文依据", "单方资料须说明另一方视角缺失"],
        "forbidden_conclusions": ["不得确定谁是问题根源", "不得给家庭角色或依恋类型定论"],
        "template_family": "special",
        "template_variant": "conflict_review",
        "default_question": (
            '依据具体互动顺序描述双方如何相互回应；保留各方视角与环境限制'
            '，找出循环的例外和一个可协商的调整点。'
        ),
    },

    {
        "id": "humanistic_listening",
        "name": "人本倾听与需要",
        "category": "professional_support",
        "description": "先理解当事人的体验、需要和自主选择，再讨论支持。",
        "dimensions": [
            '当事人如何描述经历',
            '明确表达的感受与需要',
            '个人资源与选择',
            '尊重自主的回应',
        ],
        "evidence_requirements": ["以当事人原话为先", "未表达的感受只能作为待确认问题"],
        "forbidden_conclusions": ["不得替当事人定义真实需要", "不得以共情之名赞同未经核实的事实"],
        "template_family": "special",
        "template_variant": "communication_prep",
        "default_question": (
            '用当事人的语言理解经历和需要，保留其选择权；给出一句可供核对'
            '的理解和一个开放问题，不急于劝说。'
        ),
    },
    {
        "id": "motivation_change",
        "name": "动机与改变对话",
        "category": "professional_support",
        "description": "观察本人对改变的期待、顾虑与准备，避免替人设定目标。",
        "dimensions": [
            '本人想改变的事情',
            '改变和维持现状的理由',
            '已有尝试与资源',
            '自主选择的下一小步',
        ],
        "evidence_requirements": ["改变理由必须来自本人表达", "成人希望与孩子意愿分别记录"],
        "forbidden_conclusions": ["不得把犹豫归为抵抗或缺乏动机", "不得诱导、操控或替本人作决定"],
        "template_family": "special",
        "template_variant": "communication_prep",
        "default_question": (
            '梳理本人表达的改变愿望与顾虑，寻找已有尝试和资源；优先开放提'
            '问，由本人选择是否及如何迈出下一步。'
        ),
    },
    {
        "id": "narrative_meaning",
        "name": "叙事意义与例外",
        "category": "general",
        "description": "区分人与问题，寻找不同经历、个人价值与例外，保留多种理解。",
        "dimensions": [
            '本人如何讲述问题',
            '问题对生活的影响',
            '不符合问题叙述的例外',
            '本人重视的意义与行动',
        ],
        "evidence_requirements": ["问题命名尊重本人用词", "例外经历与价值必须有明确材料"],
        "forbidden_conclusions": ["不得编造积极故事或创伤经历", "不得用单一故事定义一个人"],
        "template_family": "person_long_term",
        "template_variant": "experiences_values",
        "default_question": (
            '把人和当前困扰分开描述，核对问题的影响及材料中的例外；询问这'
            '些经历对本人意味着什么，不替其编写人生意义。'
        ),
    },

]


class WorkspaceError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 422,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


class WorkspaceService:
    """Read and write one explicitly opened Lingxi V0.1 workspace."""

    def __init__(self) -> None:
        self._root: Path | None = None
        self._manifest: dict | None = None
        self._index: DerivedIndex | None = None
        self._lock = threading.RLock()
        self._entity_validator = schema_validator("entities.schema.json")
        self._analysis_validator = schema_validator("analysis-output.schema.json")

    @property
    def root_path(self) -> Path:
        with self._lock:
            root, _ = self._require_open()
            return root

    def open(self, path: str | Path) -> dict:
        requested = Path(path).expanduser()
        if not requested.is_absolute():
            raise WorkspaceError(
                "invalid_workspace",
                "工作区路径必须是本机绝对目录。",
                details={"path": str(path)},
            )
        root = requested.resolve()
        if not root.is_dir():
            raise WorkspaceError(
                "invalid_workspace",
                "工作区目录不存在或不是目录。",
                details={"path": str(root)},
            )

        with self._lock:
            self._initialize_layout(root)
            manifest = self._load_manifest(root)
            self._root = root
            self._manifest = manifest
            self._index = DerivedIndex(root / ".lingxi" / "index.sqlite3")
            self._recover_assistant_creates()
            result = self.rebuild_index()
            return {
                "path": str(root),
                "workspace_id": manifest["workspace_id"],
                "schema_version": SCHEMA_VERSION,
                "counts": result["counts"],
                "index_path": result["index_path"],
            }

    def refresh(self) -> dict:
        with self._lock:
            root, index = self._require_open()
            before = index.fingerprints()
            records, pending = self._scan_workspace()
            after = {item.record["id"]: item.fingerprint for item in records}
            index.rebuild(records)
            created = sum(record_id not in before for record_id in after)
            modified = sum(
                record_id in before and before[record_id] != fingerprint
                for record_id, fingerprint in after.items()
            )
            deleted = sum(record_id not in after for record_id in before)
            unchanged = len(after) - created - modified
            return {
                "path": str(root),
                "created": created,
                "modified": modified,
                "deleted": deleted,
                "unchanged": unchanged,
                "counts": _counts(records),
                "pending_snapshots": pending,
                "index_path": str(index.path.relative_to(root)),
            }

    def create_export_archive(self) -> dict:
        """Create a portable snapshot without the rebuildable local index."""
        with self._lock:
            root, _ = self._require_open()
            files: list[tuple[str, Path]] = []
            for current_root, directory_names, file_names in os.walk(
                root,
                followlinks=False,
            ):
                current = Path(current_root)
                relative_directory = current.relative_to(root)
                directory_names[:] = sorted(
                    name
                    for name in directory_names
                    if not (
                        (relative_directory == Path(".") and name == ".lingxi")
                        or (current / name).is_symlink()
                    )
                )
                for name in sorted(file_names):
                    path = current / name
                    if path.is_symlink() or name == ".DS_Store":
                        continue
                    relative = path.relative_to(root).as_posix()
                    files.append((relative, path))

            descriptor, temporary_path = tempfile.mkstemp(
                prefix="lingxi-workspace-",
                suffix=".zip",
            )
            os.close(descriptor)
            archive_path = Path(temporary_path)
            entries: list[dict[str, Any]] = []
            try:
                with zipfile.ZipFile(
                    archive_path,
                    mode="w",
                    compression=zipfile.ZIP_DEFLATED,
                ) as archive:
                    for relative, path in files:
                        content = path.read_bytes()
                        archive.writestr(relative, content)
                        entries.append(
                            {
                                "path": relative,
                                "size": len(content),
                                "sha256": hashlib.sha256(content).hexdigest(),
                            }
                        )
                    manifest_name = "LINGXI_EXPORT_MANIFEST.json"
                    existing_names = {relative for relative, _ in files}
                    suffix = 1
                    while manifest_name in existing_names:
                        manifest_name = f"LINGXI_EXPORT_MANIFEST-{suffix}.json"
                        suffix += 1
                    manifest = {
                        "schema_version": SCHEMA_VERSION,
                        "workspace_id": self._manifest["workspace_id"],
                        "workspace_title": self._manifest["title"],
                        "exported_at": _now(),
                        "excluded": [".lingxi/", ".DS_Store", "symbolic_links"],
                        "file_count": len(entries),
                        "files": entries,
                    }
                    archive.writestr(
                        manifest_name,
                        json.dumps(
                            manifest,
                            ensure_ascii=False,
                            indent=2,
                        ).encode("utf-8")
                        + b"\n",
                    )
            except Exception:
                archive_path.unlink(missing_ok=True)
                raise

            safe_title = "".join(
                character
                for character in str(self._manifest["title"])
                if character not in '/\\:*?"<>|'
            ).strip() or "灵犀桥工作区"
            timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
            return {
                "path": str(archive_path),
                "filename": f"{safe_title}-灵犀桥备份-{timestamp}.zip",
                "file_count": len(entries),
            }

    def get_analysis_templates(self) -> dict:
        """Read the open, AI-editable template configuration."""
        with self._lock:
            root, _ = self._require_open()
            path = root / ANALYSIS_TEMPLATES_FILE
            if path.exists():
                try:
                    raw = path.read_bytes()
                    config = json.loads(raw.decode("utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError) as error:
                    raise WorkspaceError(
                        "invalid_template_config",
                        "分析模板配置无法读取；请修复 analysis-templates.json 后重试。",
                        details={"path": ANALYSIS_TEMPLATES_FILE},
                    ) from error
                _validate_analysis_template_config(config)
                file_hash: str | None = hashlib.sha256(raw).hexdigest()
            else:
                config = {
                    "schema_version": SCHEMA_VERSION,
                    "active_template_id": "general_relationship",
                    "custom_templates": [],
                }
                file_hash = None

            custom = config["custom_templates"]
            return {
                **config,
                "items": [
                    *(
                        {**template, "source": "built_in"}
                        for template in BUILTIN_ANALYSIS_TEMPLATES
                    ),
                    *({**template, "source": "custom"} for template in custom),
                ],
                "relative_path": ANALYSIS_TEMPLATES_FILE,
                "file_hash": file_hash,
            }

    def update_analysis_templates(
        self,
        active_template_id: str,
        custom_templates: list[dict[str, Any]],
        expected_hash: str | None,
    ) -> dict:
        """Atomically save user templates without overwriting external AI edits."""
        with self._lock:
            root, _ = self._require_open()
            config = {
                "schema_version": SCHEMA_VERSION,
                "active_template_id": active_template_id,
                "custom_templates": custom_templates,
            }
            _validate_analysis_template_config(config)
            path = root / ANALYSIS_TEMPLATES_FILE
            content = _json_bytes(config)
            if path.exists():
                if expected_hash is None:
                    raise WorkspaceError(
                        "workspace_conflict",
                        "分析模板文件已存在；请先重新读取，再保存修改。",
                        status_code=409,
                        details={"path": ANALYSIS_TEMPLATES_FILE},
                    )
                _atomic_replace(path, content, expected_hash)
            else:
                if expected_hash is not None:
                    raise WorkspaceError(
                        "workspace_conflict",
                        "分析模板文件状态已变化；请先重新读取。",
                        status_code=409,
                        details={"path": ANALYSIS_TEMPLATES_FILE},
                    )
                _atomic_create(path, content)
            return self.get_analysis_templates()

    def rebuild_index(self) -> dict:
        with self._lock:
            root, index = self._require_open()
            records, pending = self._scan_workspace()
            index.rebuild(records)
            return {
                "path": str(root),
                "index_path": str(index.path.relative_to(root)),
                "record_count": len(records),
                "counts": _counts(records),
                "pending_snapshots": pending,
            }

    def list_entities(self, entity_type: str) -> list[dict]:
        with self._lock:
            _, index = self._require_open()
            normalized = ENTITY_ALIASES.get(entity_type, entity_type)
            if normalized == "report":
                reports: list[dict] = []
                for topic in index.list("report_topic"):
                    snapshot_item = index.get(topic["current_snapshot_id"])
                    if snapshot_item is None:
                        raise WorkspaceError(
                            "validation_error",
                            "报告主题引用的当前快照不存在。",
                            details={
                                "topic_id": topic["id"],
                                "snapshot_id": topic["current_snapshot_id"],
                            },
                        )
                    reports.append(
                        {
                            "topic": topic,
                            "snapshot": snapshot_item.record,
                            "analysis": _analysis_from_body(snapshot_item.body),
                        }
                    )
                return reports
            if normalized not in ENTITY_DIRECTORIES:
                raise WorkspaceError(
                    "validation_error",
                    "未知实体类型。",
                    details={"entity_type": entity_type},
                )
            try:
                return index.list(normalized)
            except sqlite3.DatabaseError as error:
                raise WorkspaceError(
                    "index_unavailable",
                    "派生索引不可用，请重建索引。",
                    status_code=409,
                ) from error

    def create_person(self, display_name: str, relation_to_user: str) -> dict:
        with self._lock:
            root, _ = self._require_open()
            record = self._base_record("person")
            record.update(
                {
                    "display_name": display_name,
                    "relation_to_user": relation_to_user,
                    "profile_sections": [],
                }
            )
            self._validate_entity(record)
            body = _person_body(record)
            path = root / "people" / f"{record['id']}.md"
            _atomic_create(path, _markdown_bytes(record, body))
            self.rebuild_index()
            return record

    def create_person_from_preview(
        self, text: str, preview: dict, display_name: str,
        relation_to_user: str, request_id: str,
    ) -> dict:
        """Create one confirmed profile, preserving its original text and exact quotes."""
        from lingxi.analysis.autofill import validate_profile_autofill

        with self._lock:
            root, _ = self._require_open()
            try:
                request_uuid = uuid.UUID(request_id)
                validate_profile_autofill(preview, text)
            except (ValueError, TypeError, ValidationError) as error:
                raise WorkspaceError("validation_error", "资料格式或原文引用无效。") from error
            fingerprint = hashlib.sha256(_json_bytes({
                "text": text, "preview": preview, "display_name": display_name,
                "relation_to_user": relation_to_user,
            })).hexdigest()
            person_id = str(uuid.uuid5(request_uuid, "lingxi:person"))
            source_id = str(uuid.uuid5(request_uuid, "lingxi:source"))
            receipt_path = root / "attachments" / source_id / "assistant-request.json"
            self._recover_assistant_creates()
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                if receipt.get("fingerprint") != fingerprint:
                    raise WorkspaceError(
                        "request_conflict", "本次请求编号已用于其他资料，请重新提交。",
                        status_code=409,
                    )
                self.rebuild_index()
                return {
                    "person": self.get_entity(person_id, "person"),
                    "source": self.get_entity(source_id, "source"),
                    "evidence": [self.get_entity(i, "evidence") for i in receipt["evidence_ids"]],
                    "replayed": True,
                }

            person = self._base_record("person")
            person.update(id=person_id, display_name=display_name,
                          relation_to_user=relation_to_user, profile_sections=[])
            source = self._base_record("source")
            raw = text.encode("utf-8")
            original_path = f"attachments/{source_id}/original.txt"
            source.update(id=source_id, title=f"{display_name}的资料", source_kind="text",
                          original_path=original_path, sha256=hashlib.sha256(raw).hexdigest(),
                          person_ids=[person_id], event_ids=[])
            files = {original_path: raw}
            evidence = []
            for position, candidate in enumerate(preview["candidates"]):
                record = self._base_record("evidence")
                record.update(
                    id=str(uuid.uuid5(request_uuid, f"lingxi:evidence:{position}")),
                    source_id=source_id, quote=candidate["quote"],
                    locator={"kind": "text_quote", "start": candidate["start"],
                             "end": candidate["end"]},
                    evidence_kind="user_statement", reliability="medium",
                    person_ids=[person_id], event_ids=[],
                )
                self._validate_entity(record)
                evidence.append(record)
                files[f"evidence/{record['id']}.md"] = _markdown_bytes(
                    record, f"# 原文引用\n\n{candidate['quote']}\n",
                )
                person["profile_sections"].append({
                    "id": str(uuid.uuid5(request_uuid, f"lingxi:profile:{position}")),
                    "section": candidate["section"], "label": candidate["label"],
                    "value": candidate["value"], "origin": "ai",
                    "confirmation_status": "confirmed", "evidence_ids": [record["id"]],
                })
            self._validate_entity(person)
            self._validate_entity(source)
            files[f"people/{person_id}.md"] = _markdown_bytes(person, _person_body(person))
            files[f"sources/{source_id}.json"] = _json_bytes(source)
            files[str(receipt_path.relative_to(root))] = _json_bytes({
                "request_id": str(request_uuid), "fingerprint": fingerprint,
                "evidence_ids": [record["id"] for record in evidence],
            })
            if any((root / name).exists() or (root / name).is_symlink() for name in files):
                raise WorkspaceError("workspace_conflict", "资料已存在，未覆盖任何文件。",
                                     status_code=409)
            journal_dir = root / ".lingxi" / "assistant-transactions"
            journal_dir.mkdir(exist_ok=True)
            journal = journal_dir / f"{request_uuid}.json"
            _atomic_create(journal, _json_bytes({
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
            }))
            try:
                for name, content in files.items():
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_create(target, content)
                self.rebuild_index()
                journal.unlink()
                _fsync_directory(journal_dir)
            except Exception:
                self._recover_assistant_creates()
                self.rebuild_index()
                raise
            return {"person": person, "source": source, "evidence": evidence, "replayed": False}

    def append_person_interview(self, person_id: str, answers: list[dict],
                                attachments: list[dict], request_id: str) -> dict:
        """Append interview and original text files together; retries cannot duplicate them."""
        with self._lock:
            root, _ = self._require_open()
            self._require_references([person_id], "person")
            person = self.get_entity(person_id, "person")
            request_uuid = uuid.UUID(request_id)
            fingerprint = hashlib.sha256(_json_bytes({
                "person_id": person_id, "answers": answers, "attachments": attachments,
            })).hexdigest()
            texts = []
            if answers:
                lines = [f"# {person['display_name']}的建档补充", "", "以下为用户陈述，未经独立核实。", ""]
                for answer in answers:
                    value = "还不知道" if answer["status"] == "unknown" else answer["answer"]
                    lines.extend([f"## {answer['question']}", "", value, ""])
                texts.append((f"{person['display_name']}的建档补充", "\n".join(lines)))
            texts.extend((item["name"], item["text"]) for item in attachments)
            if not texts or len(texts) > 4:
                raise WorkspaceError("validation_error", "请填写补充，或选择最多3份文本资料。")
            ids = [str(uuid.uuid5(request_uuid, f"lingxi:interview:{i}")) for i in range(len(texts))]
            receipt_path = root / "attachments" / ids[0] / "assistant-request.json"
            if receipt_path.is_symlink() or not receipt_path.resolve().is_relative_to(root):
                raise WorkspaceError("workspace_conflict", "补充资料路径无效。", status_code=409)
            self._recover_assistant_creates()
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                if receipt.get("fingerprint") != fingerprint:
                    raise WorkspaceError("request_conflict", "请求编号已用于其他补充，请重新保存。", status_code=409)
                self.rebuild_index()
                return {"sources": [self.get_entity(i, "source") for i in receipt["source_ids"]], "replayed": True}
            files = {}
            sources = []
            for source_id, (title, text) in zip(ids, texts):
                raw = text.encode("utf-8")
                if not raw or len(raw) > 5 * 1024 * 1024:
                    raise WorkspaceError("validation_error", "每份补充资料须非空且不超过5MiB。")
                source = self._base_record("source")
                source.update(id=source_id, title=title, source_kind="user_observation",
                              original_path=f"attachments/{source_id}/original.txt",
                              sha256=hashlib.sha256(raw).hexdigest(), person_ids=[person_id], event_ids=[])
                self._validate_entity(source)
                files[source["original_path"]] = raw
                files[f"sources/{source_id}.json"] = _json_bytes(source)
                sources.append(source)
            files[str(receipt_path.relative_to(root))] = _json_bytes({"fingerprint": fingerprint, "source_ids": ids})
            for name in files:
                target = root / name
                if (not target.resolve().is_relative_to(root)
                        or any(parent.is_symlink() for parent in target.parents if parent != root and root in parent.parents)):
                    raise WorkspaceError("workspace_conflict", "补充资料路径不能经过符号链接。", status_code=409)
            if any((root / name).exists() or (root / name).is_symlink() for name in files):
                raise WorkspaceError("workspace_conflict", "补充资料已存在，未覆盖原件。", status_code=409)
            journal_dir = root / ".lingxi" / "assistant-transactions"
            journal_dir.mkdir(exist_ok=True)
            journal = journal_dir / f"{request_uuid}.json"
            _atomic_create(journal, _json_bytes({"files": {
                name: hashlib.sha256(data).hexdigest() for name, data in files.items()
            }}))
            try:
                for name, content in files.items():
                    target = root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_create(target, content)
                self.rebuild_index()
                journal.unlink()
                _fsync_directory(journal_dir)
            except Exception:
                self._recover_assistant_creates()
                self.rebuild_index()
                raise
            return {"sources": sources, "replayed": False}

    def _recover_assistant_creates(self) -> None:
        """Archive only untouched files belonging to an interrupted profile creation."""
        root, _ = self._require_open()
        for journal in sorted((root / ".lingxi" / "assistant-transactions").glob("*.json")):
            try:
                uuid.UUID(journal.stem)
                files = json.loads(journal.read_text(encoding="utf-8"))["files"]
                paths = []
                for name, expected_hash in files.items():
                    relative = Path(name)
                    parts = relative.parts
                    allowed = (
                        len(parts) == 2 and parts[0] in {"people", "sources", "evidence"}
                    ) or (
                        len(parts) == 3 and parts[0] == "attachments"
                        and parts[2] in {"original.txt", "assistant-request.json"}
                    )
                    if not allowed or ".." in parts or relative.is_absolute():
                        raise ValueError("invalid transaction path")
                    uuid.UUID(Path(parts[1]).stem)
                    target = root / relative
                    if target.is_symlink() or not target.resolve().is_relative_to(root):
                        raise ValueError("invalid transaction target")
                    if target.exists():
                        if hashlib.sha256(target.read_bytes()).hexdigest() != expected_hash:
                            raise ValueError("transaction file was externally modified")
                        paths.append((relative, target))
                archive = root / "归档" / "未完成建档" / journal.stem
                for relative, target in paths:
                    destination = archive / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if destination.exists():
                        if destination.read_bytes() != target.read_bytes():
                            raise ValueError("recovery archive conflict")
                        destination = destination.with_name(f"{uuid.uuid4()}-{destination.name}")
                    target.rename(destination)
                    _fsync_directory(target.parent)
                    _fsync_directory(destination.parent)
                journal.unlink()
                _fsync_directory(journal.parent)
            except (ValueError, KeyError, TypeError) as error:
                raise WorkspaceError(
                    "workspace_conflict", "未完成的建档资料有外部修改，请先检查工作区。",
                    status_code=409,
                ) from error


    def get_entity(self, record_id: str, entity_type: str) -> dict:
        with self._lock:
            _, index = self._require_open()
            item = index.get(record_id)
            if item is None or item.record["entity_type"] != entity_type:
                raise WorkspaceError(
                    "reference_not_found",
                    "请求的记录不存在。",
                    details={
                        "record_id": record_id,
                        "expected_type": entity_type,
                    },
                )
            return item.record

    def update_person(
        self,
        person_id: str,
        *,
        display_name: str | None = None,
        relation_to_user: str | None = None,
    ) -> dict:
        with self._lock:
            root, index = self._require_open()
            item = index.get(person_id)
            if item is None or item.record["entity_type"] != "person":
                raise WorkspaceError(
                    "reference_not_found",
                    "关联人物不存在。",
                    details={"record_id": person_id, "expected_type": "person"},
                )
            record = dict(item.record)
            if display_name is not None:
                record["display_name"] = display_name
            if relation_to_user is not None:
                record["relation_to_user"] = relation_to_user
            record["revision"] += 1
            record["updated_at"] = _now()
            self._validate_entity(record)
            path = root / "people" / f"{person_id}.md"
            _atomic_replace(
                path,
                _markdown_bytes(record, _person_body(record)),
                expected_hash=item.file_hash,
            )
            self.rebuild_index()
            return record

    def archive_person(self, person_id: str) -> dict:
        """Remove an unreferenced contact from active views without destroying it."""
        with self._lock:
            root, index = self._require_open()
            item = index.get(person_id)
            if item is None or item.record["entity_type"] != "person":
                raise WorkspaceError(
                    "reference_not_found",
                    "关联人物不存在。",
                    details={"record_id": person_id, "expected_type": "person"},
                )

            dependency_ids: dict[str, list[str]] = {}
            for entity_type in (
                "relation",
                "event",
                "source",
                "screenshot_transcript",
                "evidence",
                "report_topic",
            ):
                matching = [
                    record["id"]
                    for record in index.list(entity_type)
                    if _record_references_person(record, person_id)
                ]
                if matching:
                    dependency_ids[entity_type] = matching
            if dependency_ids:
                raise WorkspaceError(
                    "person_has_dependencies",
                    "联系人仍有关联资料，未归档。请先整理这些资料。",
                    status_code=409,
                    details={"person_id": person_id, "dependencies": dependency_ids},
                )

            source = root / "people" / f"{person_id}.md"
            archive_directory = root / "归档" / "联系人"
            archive_directory.mkdir(parents=True, exist_ok=True)
            target = archive_directory / source.name
            if target.exists():
                raise WorkspaceError(
                    "workspace_conflict",
                    "归档中已存在同名联系人文件，未覆盖。",
                    status_code=409,
                    details={"path": str(target.relative_to(root))},
                )
            if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != (
                item.file_hash
            ):
                raise WorkspaceError(
                    "workspace_conflict",
                    "联系人文件已被外部修改，未归档。",
                    status_code=409,
                    details={"path": str(source.relative_to(root))},
                )
            os.replace(source, target)
            _fsync_directory(source.parent)
            _fsync_directory(target.parent)
            self.rebuild_index()
            return {
                "id": person_id,
                "archived_to": str(target.relative_to(root)),
                "recoverable": True,
            }

    def add_profile_entry(
        self,
        person_id: str,
        section: str,
        label: str,
        value: str,
        evidence_ids: list[str],
        *,
        origin: str = "user",
        confirmation_status: str = "confirmed",
    ) -> dict:
        with self._lock:
            root, index = self._require_open()
            item = index.get(person_id)
            if item is None or item.record["entity_type"] != "person":
                raise WorkspaceError(
                    "reference_not_found",
                    "关联人物不存在。",
                    details={"record_id": person_id, "expected_type": "person"},
                )
            self._require_references(evidence_ids, "evidence")
            if origin == "ai" and label == "AI 候选描述":
                matches = [entry for entry in item.record.get("profile_sections", [])
                           if entry.get("origin") == origin and entry.get("label") == label
                           and entry.get("value") == value
                           and set(entry.get("evidence_ids", [])) == set(evidence_ids)]
                if matches and matches[-1].get("confirmation_status") == confirmation_status:
                    return dict(item.record)
            entry = {
                "id": str(uuid.uuid4()),
                "section": section,
                "label": label,
                "value": value,
                "origin": origin,
                "confirmation_status": confirmation_status,
                "evidence_ids": evidence_ids,
            }
            record = dict(item.record)
            record["profile_sections"] = [
                *record.get("profile_sections", []),
                entry,
            ]
            record["revision"] += 1
            record["updated_at"] = _now()
            self._validate_entity(record)
            path = root / "people" / f"{person_id}.md"
            _atomic_replace(
                path,
                _markdown_bytes(record, _person_body(record)),
                expected_hash=item.file_hash,
            )
            self.rebuild_index()
            return record

    def create_event(
        self,
        title: str,
        occurred_at: str,
        person_ids: list[str],
        *,
        location: str = "",
        summary: str = "",
    ) -> dict:
        with self._lock:
            root, _ = self._require_open()
            self._require_references(person_ids, "person")
            record = self._base_record("event")
            record.update(
                {
                    "title": title,
                    "occurred_at": occurred_at,
                    "person_ids": person_ids,
                    "source_ids": [],
                    "location": location,
                    "summary": summary,
                }
            )
            self._validate_entity(record)
            path = root / "events" / f"{record['id']}.md"
            _atomic_create(path, _markdown_bytes(record, _event_body(record)))
            self.rebuild_index()
            return record

    def update_event(
        self,
        event_id: str,
        *,
        title: str | None = None,
        occurred_at: str | None = None,
        person_ids: list[str] | None = None,
        location: str | None = None,
        summary: str | None = None,
        expected_revision: int | None = None,
        analysis: dict | None = None,
    ) -> dict:
        with self._lock:
            root, index = self._require_open()
            item = index.get(event_id)
            if item is None or item.record["entity_type"] != "event":
                raise WorkspaceError(
                    "reference_not_found",
                    "事件不存在。",
                    details={"record_id": event_id, "expected_type": "event"},
                )
            if expected_revision is not None and expected_revision != item.record["revision"]:
                raise WorkspaceError(
                    "workspace_conflict",
                    "事件已有更新，请刷新后核对再保存。",
                    status_code=409,
                    details={"record_id": event_id, "revision": item.record["revision"]},
                )
            if person_ids is not None:
                self._require_references(person_ids, "person")
            record = dict(item.record)
            for key, value in (
                ("title", title),
                ("occurred_at", occurred_at),
                ("person_ids", person_ids),
                ("location", location),
                ("summary", summary),
                ("analysis", analysis),
            ):
                if value is not None:
                    record[key] = value
            record["revision"] += 1
            record["updated_at"] = _now()
            self._validate_entity(record)
            path = root / "events" / f"{event_id}.md"
            try:
                original = path.read_bytes()
            except OSError as error:
                raise WorkspaceError(
                    "workspace_conflict", "事件文件已改变，请先刷新工作区。", status_code=409
                ) from error
            if hashlib.sha256(original).hexdigest() != item.file_hash:
                raise WorkspaceError(
                    "workspace_conflict", "事件文件已被外部修改，未覆盖。", status_code=409
                )
            _, old_body = _parse_markdown(original.decode("utf-8"))
            old_generated = _event_body(item.record)
            legacy_generated = (
                f"# {item.record['title']}\n\n发生时间：{item.record['occurred_at']}\n"
            )
            if old_body.startswith(old_generated):
                notes = old_body[len(old_generated):]
            elif old_body.startswith(legacy_generated):
                notes = old_body[len(legacy_generated):]
            else:
                notes = f"\n## 原有记录\n\n{old_body}"
            _atomic_replace(
                path,
                _markdown_bytes(record, _event_body(record) + notes),
                expected_hash=item.file_hash,
            )
            self.rebuild_index()
            return record

    def event_analysis_context(
        self, event_id: str, source_ids: list[str], expected_revision: int | None = None
    ) -> dict:
        with self._lock:
            root, index = self._require_open()
            event = self.get_entity(event_id, "event")
            if expected_revision is not None and event["revision"] != expected_revision:
                raise WorkspaceError(
                    "workspace_conflict", "事件已有更新，请刷新后再分析。", status_code=409
                )
            event_item = index.get(event_id)
            event_path = root / "events" / f"{event_id}.md"
            if (
                not event_path.is_file()
                or hashlib.sha256(event_path.read_bytes()).hexdigest() != event_item.file_hash
            ):
                raise WorkspaceError(
                    "workspace_conflict", "事件文件有外部变化，请先刷新。", status_code=409
                )
            if not source_ids or len(source_ids) > 30 or len(set(source_ids)) != len(source_ids):
                raise WorkspaceError("invalid_material_scope", "请选择1至30份不重复的事件材料。")
            selected, fingerprints, hashes, text_hashes = [], {}, {}, {}
            for source_id in source_ids:
                source = self.get_entity(source_id, "source")
                if event_id not in source.get("event_ids", []):
                    raise WorkspaceError(
                        "invalid_material_scope", "只能分析已关联当前事件的所选材料。",
                        details={"source_id": source_id, "event_id": event_id},
                    )
                loaded = self._load_source(root / "sources" / f"{source_id}.json")
                if loaded.fingerprint != index.get(source_id).fingerprint:
                    raise WorkspaceError(
                        "workspace_conflict", "所选材料有外部变化，请先刷新。", status_code=409
                    )
                if not loaded.body.strip():
                    raise WorkspaceError(
                        "event_text_unavailable", "材料没有可分析的文字；请先校对转写。",
                        details={"source_id": source_id},
                    )
                selected.append({"id": source_id, "title": source["title"], "text": loaded.body})
                fingerprints[source_id] = loaded.fingerprint
                hashes[source_id] = loaded.file_hash
                text_hashes[source_id] = hashlib.sha256(loaded.body.encode("utf-8")).hexdigest()
            if sum(len(source["text"]) for source in selected) > 500_000:
                raise WorkspaceError("material_scope_too_large", "本次材料超过50万字，请缩小范围。")
            return {
                "event": {key: event.get(key, "") for key in (
                    "id", "title", "occurred_at", "location", "summary", "person_ids"
                )},
                "revision": event["revision"],
                "event_file_hash": event_item.file_hash,
                "sources": selected,
                "fingerprints": fingerprints,
                "source_hashes": hashes,
                "source_text_hashes": text_hashes,
            }

    def save_event_analysis(self, event_id: str, context: dict, result: dict, engine: str) -> dict:
        from lingxi.analysis.event_analysis import validate_event_analysis

        with self._lock:
            source_ids = [source["id"] for source in context["sources"]]
            try:
                current = self.event_analysis_context(event_id, source_ids, context["revision"])
            except WorkspaceError as error:
                raise WorkspaceError(
                    "workspace_conflict", "分析期间事件或材料已变化，结果未写入。", status_code=409
                ) from error
            if (
                current["event_file_hash"] != context["event_file_hash"]
                or current["fingerprints"] != context["fingerprints"]
            ):
                raise WorkspaceError(
                    "workspace_conflict", "分析期间事件或材料已变化，结果未写入。", status_code=409
                )
            validated = validate_event_analysis(result, current["sources"])
            analysis = {
                "schema_version": SCHEMA_VERSION,
                "generated_at": _now(),
                "engine": engine,
                "event_revision": context["revision"],
                "source_ids": source_ids,
                "source_hashes": current["source_hashes"],
                "source_text_hashes": current["source_text_hashes"],
                "summary": validated["summary"],
                "nodes": [
                    {**node, "id": str(uuid.uuid4()), "status": "candidate"}
                    for node in validated["nodes"]
                ],
            }
            return self.update_event(
                event_id, analysis=analysis, expected_revision=context["revision"]
            )

    def update_event_node_label(
        self, event_id: str, node_id: str, label: str, *, expected_revision: int | None = None
    ) -> dict:
        with self._lock:
            event = self.get_entity(event_id, "event")
            analysis = event.get("analysis")
            if analysis is None or not any(node["id"] == node_id for node in analysis["nodes"]):
                raise WorkspaceError("reference_not_found", "未找到这条事件候选节点。")
            updated = {
                **analysis,
                "nodes": [
                    {**node, "label": label} if node["id"] == node_id else dict(node)
                    for node in analysis["nodes"]
                ],
            }
            return self.update_event(
                event_id, analysis=updated, expected_revision=expected_revision
            )

    def import_text_source(
        self,
        title: str,
        text: str,
        source_kind: str,
        person_ids: list[str],
        event_ids: list[str],
    ) -> dict:
        with self._lock:
            root, _ = self._require_open()
            if not isinstance(text, str):
                raise WorkspaceError("validation_error", "原始文本必须是字符串。")
            self._require_references(person_ids, "person")
            self._require_references(event_ids, "event")
            record = self._base_record("source")
            original_path = f"attachments/{record['id']}/original.txt"
            raw_text = text.encode("utf-8")
            record.update(
                {
                    "title": title,
                    "source_kind": source_kind,
                    "original_path": original_path,
                    "sha256": hashlib.sha256(raw_text).hexdigest(),
                    "person_ids": person_ids,
                    "event_ids": event_ids,
                }
            )
            self._validate_entity(record)

            attachment_directory = root / "attachments" / record["id"]
            try:
                attachment_directory.mkdir()
            except FileExistsError as error:
                raise WorkspaceError(
                    "workspace_conflict",
                    "材料附件目录已存在，未覆盖任何文件。",
                    status_code=409,
                    details={"path": str(attachment_directory.relative_to(root))},
                ) from error
            _fsync_directory(attachment_directory.parent)
            _atomic_create(root / original_path, raw_text)
            source_path = root / "sources" / f"{record['id']}.json"
            _atomic_create(source_path, _json_bytes(record))
            for event_id in event_ids:
                self._attach_source_to_event(event_id, record["id"])
            self.rebuild_index()
            return record

    def import_screenshot_batch(
        self,
        title: str,
        items: list[dict[str, object]],
        person_ids: list[str],
        event_ids: list[str],
    ) -> dict:
        with self._lock:
            root, _ = self._require_open()
            if not isinstance(items, list) or not 1 <= len(items) <= MAX_SCREENSHOTS:
                raise WorkspaceError(
                    "screenshot_count_out_of_range",
                    "一次只能保存 1 到 20 张截图。",
                    details={
                        "count": len(items) if isinstance(items, list) else None,
                        "minimum": 1,
                        "maximum": MAX_SCREENSHOTS,
                    },
                )
            self._require_references(person_ids, "person")
            self._require_references(event_ids, "event")
            if len(person_ids) != len(set(person_ids)) or len(event_ids) != len(
                set(event_ids)
            ):
                raise WorkspaceError(
                    "validation_error",
                    "人物与事件引用不得重复。",
                )

            normalized: list[tuple[str, bytes]] = []
            total_bytes = 0
            for item in items:
                if not isinstance(item, dict):
                    raise WorkspaceError(
                        "validation_error",
                        "截图条目必须是对象。",
                    )
                mime_type = item.get("mime_type")
                content = item.get("content")
                if mime_type not in SCREENSHOT_EXTENSIONS:
                    raise WorkspaceError(
                        "unsupported_screenshot_type",
                        "截图只支持 PNG、JPEG 或 WebP。",
                        details={"mime_type": mime_type},
                    )
                if not isinstance(content, bytes):
                    raise WorkspaceError(
                        "validation_error",
                        "截图原件必须是二进制内容。",
                    )
                if not content or len(content) > MAX_SCREENSHOT_BYTES:
                    raise WorkspaceError(
                        "screenshot_size_out_of_range",
                        "单张截图必须大于 0 字节且不超过 15 MiB。",
                        details={"byte_size": len(content)},
                    )
                if not _matches_screenshot_magic(content, mime_type):
                    raise WorkspaceError(
                        "screenshot_content_mismatch",
                        "截图内容与声明的图片类型不一致。",
                        details={"mime_type": mime_type},
                    )
                total_bytes += len(content)
                if total_bytes > MAX_SCREENSHOT_BATCH_BYTES:
                    raise WorkspaceError(
                        "screenshot_batch_too_large",
                        "一次保存的截图总大小不能超过 100 MiB。",
                        details={"byte_size": total_bytes},
                    )
                normalized.append((mime_type, content))

            batch_id = str(uuid.uuid4())
            records: list[dict] = []
            for sequence_index, (mime_type, content) in enumerate(normalized):
                record = self._base_record("source")
                extension = SCREENSHOT_EXTENSIONS[mime_type]
                original_path = f"attachments/{record['id']}/original{extension}"
                record.update(
                    {
                        "title": _screenshot_title(title, sequence_index, len(items)),
                        "source_kind": "screenshot",
                        "original_path": original_path,
                        "sha256": hashlib.sha256(content).hexdigest(),
                        "person_ids": person_ids,
                        "event_ids": event_ids,
                        "mime_type": mime_type,
                        "byte_size": len(content),
                        "batch_id": batch_id,
                        "sequence_index": sequence_index,
                        "processing_status": "pending_confirmation",
                    }
                )
                self._validate_entity(record)
                records.append(record)

            for record, (_, content) in zip(records, normalized, strict=True):
                attachment_directory = root / "attachments" / record["id"]
                try:
                    attachment_directory.mkdir()
                except FileExistsError as error:
                    raise WorkspaceError(
                        "workspace_conflict",
                        "截图附件目录已存在，未覆盖任何文件。",
                        status_code=409,
                        details={
                            "path": str(attachment_directory.relative_to(root)),
                        },
                    ) from error
                _fsync_directory(attachment_directory.parent)
                _atomic_create(root / record["original_path"], content)
                _atomic_create(
                    root / "sources" / f"{record['id']}.json",
                    _json_bytes(record),
                )

            source_ids = [record["id"] for record in records]
            for event_id in event_ids:
                self._attach_sources_to_event(event_id, source_ids)
            self.rebuild_index()
            return {"batch_id": batch_id, "items": records}

    def confirm_screenshot_transcript(
        self,
        source_id: str,
        segments: list[dict[str, object]],
    ) -> dict:
        with self._lock:
            root, index = self._require_open()
            source_item = index.get(source_id)
            if source_item is None or source_item.record["entity_type"] != "source":
                raise WorkspaceError(
                    "reference_not_found",
                    "关联截图来源不存在。",
                    details={"record_id": source_id, "expected_type": "source"},
                )
            source = source_item.record
            if source["source_kind"] != "screenshot":
                raise WorkspaceError(
                    "validation_error",
                    "只有截图来源可以确认识别稿。",
                    details={"source_id": source_id},
                )
            if (
                source.get("processing_status") != "pending_confirmation"
                or "transcript_id" in source
            ):
                raise WorkspaceError(
                    "screenshot_already_confirmed",
                    "该截图已经确认，不能重复创建确认稿。",
                    status_code=409,
                    details={"source_id": source_id},
                )
            if not isinstance(segments, list) or not 1 <= len(segments) <= 200:
                raise WorkspaceError(
                    "validation_error",
                    "确认稿必须包含 1 到 200 个分段。",
                )
            if any(not isinstance(segment, dict) for segment in segments):
                raise WorkspaceError(
                    "validation_error",
                    "确认稿分段必须是对象。",
                )
            orders = [segment.get("order") for segment in segments]
            if len(orders) != len(set(orders)):
                raise WorkspaceError(
                    "validation_error",
                    "确认稿分段顺序不得重复。",
                )

            transcript = self._base_record("screenshot_transcript")
            normalized_segments = [
                {
                    "segment_id": str(uuid.uuid4()),
                    "order": segment.get("order"),
                    "speaker": segment.get("speaker"),
                    "text": segment.get("text"),
                    "uncertainty": segment.get("uncertainty"),
                }
                for segment in sorted(segments, key=lambda item: item.get("order", -1))
            ]
            transcript.update(
                {
                    "source_id": source_id,
                    "status": "confirmed",
                    "segments": normalized_segments,
                    "person_ids": source["person_ids"],
                    "event_ids": source["event_ids"],
                }
            )
            self._validate_entity(transcript)

            evidence_records: list[dict] = []
            for segment in normalized_segments:
                evidence = self._base_record("evidence")
                evidence.update(
                    {
                        "source_id": source_id,
                        "quote": segment["text"],
                        "locator": {
                            "kind": "screenshot_segment",
                            "transcript_id": transcript["id"],
                            "segment_id": segment["segment_id"],
                            "start": 0,
                            "end": len(segment["text"]),
                        },
                        "evidence_kind": "direct_quote",
                        "reliability": _reliability_from_uncertainty(
                            segment["uncertainty"]
                        ),
                        "person_ids": source["person_ids"],
                        "event_ids": source["event_ids"],
                    }
                )
                self._validate_entity(evidence)
                evidence_records.append(evidence)

            source_path = root / "sources" / f"{source_id}.json"
            try:
                expected_source_hash = hashlib.sha256(
                    source_path.read_bytes()
                ).hexdigest()
            except OSError as error:
                raise WorkspaceError(
                    "workspace_conflict",
                    "截图来源元数据已不可用，未创建确认稿。",
                    status_code=409,
                    details={"source_id": source_id},
                ) from error
            transcript_path = root / "transcripts" / f"{transcript['id']}.md"
            _atomic_create(
                transcript_path,
                _markdown_bytes(transcript, _screenshot_transcript_body(source, transcript)),
            )
            for evidence, segment in zip(
                evidence_records,
                normalized_segments,
                strict=True,
            ):
                evidence_path = root / "evidence" / f"{evidence['id']}.md"
                _atomic_create(
                    evidence_path,
                    _markdown_bytes(
                        evidence,
                        _screenshot_evidence_body(source, transcript, segment),
                    ),
                )

            updated_source = dict(source)
            updated_source.update(
                {
                    "revision": source["revision"] + 1,
                    "updated_at": _now(),
                    "processing_status": "confirmed",
                    "transcript_id": transcript["id"],
                }
            )
            self._validate_entity(updated_source)
            _atomic_replace(
                source_path,
                _json_bytes(updated_source),
                expected_hash=expected_source_hash,
            )
            self.rebuild_index()
            return {
                "source": updated_source,
                "transcript": transcript,
                "evidence": evidence_records,
            }

    def get_source_original(self, source_id: str) -> dict:
        with self._lock:
            root, _ = self._require_open()
            source = self._require_reference(source_id, "source")
            original = _safe_workspace_path(root, source["original_path"])
            try:
                raw = original.read_bytes()
            except OSError as error:
                raise WorkspaceError(
                    "validation_error",
                    "来源原件不存在或无法读取。",
                    details={"source_id": source_id, "path": source["original_path"]},
                ) from error
            if hashlib.sha256(raw).hexdigest() != source["sha256"]:
                raise WorkspaceError(
                    "validation_error",
                    "来源原件哈希与元数据不一致。",
                    details={"source_id": source_id, "path": source["original_path"]},
                )
            return {
                "path": str(original),
                "mime_type": source.get("mime_type", "text/plain; charset=utf-8"),
                "filename": original.name,
                "source_kind": source["source_kind"],
                "source_id": source_id,
            }

    def create_evidence(
        self,
        source_id: str,
        quote: str,
        locator: dict,
        evidence_kind: str,
        reliability: str,
        person_ids: list[str],
        event_ids: list[str],
    ) -> dict:
        with self._lock:
            root, index = self._require_open()
            source = self._require_reference(source_id, "source")
            self._require_references(person_ids, "person")
            self._require_references(event_ids, "event")
            if not isinstance(locator, dict):
                raise WorkspaceError("validation_error", "证据定位信息必须是对象。")

            record = self._base_record("evidence")
            record.update(
                {
                    "source_id": source_id,
                    "quote": quote,
                    "locator": locator,
                    "evidence_kind": evidence_kind,
                    "reliability": reliability,
                    "person_ids": person_ids,
                    "event_ids": event_ids,
                }
            )
            self._validate_entity(record)
            source_item = index.get(source_id)
            assert source_item is not None
            start = locator["start"]
            end = locator["end"]
            if end > len(source_item.body) or source_item.body[start:end] != quote:
                raise WorkspaceError(
                    "evidence_locator_mismatch",
                    "证据引文与原始文本定位不一致。",
                    details={
                        "source_id": source["id"],
                        "locator": locator,
                    },
                )
            body = (
                f"# 原子证据\n\n"
                f"> {quote.replace(chr(10), chr(10) + '> ')}\n\n"
                f"来源：`{source_id}`，字符范围 `{start}:{end}`。\n"
            )
            path = root / "evidence" / f"{record['id']}.md"
            _atomic_create(path, _markdown_bytes(record, body))
            self.rebuild_index()
            return record

    def report_analysis_context(self, evidence_ids: list[str]) -> dict:
        with self._lock:
            root, index = self._require_open()
            fingerprints = {}
            source_ids = set()
            for evidence_id in evidence_ids:
                evidence = self._require_reference(evidence_id, "evidence")
                loaded = self._load_markdown(root / "evidence" / f"{evidence_id}.md", "evidence")
                if loaded.fingerprint != index.get(evidence_id).fingerprint:
                    raise WorkspaceError(
                        "workspace_conflict", "所选引用已有外部变化，请先刷新。", status_code=409,
                    )
                fingerprints[evidence_id] = loaded.fingerprint
                source_ids.add(evidence["source_id"])
            for source_id in source_ids:
                loaded = self._load_source(root / "sources" / f"{source_id}.json")
                if loaded.fingerprint != index.get(source_id).fingerprint:
                    raise WorkspaceError(
                        "workspace_conflict", "所选材料已有外部变化，请先刷新。", status_code=409,
                    )
                fingerprints[source_id] = loaded.fingerprint
            return {"path": str(root), "fingerprints": fingerprints}

    def create_report(
        self,
        title: str,
        template_family: str,
        template_variant: str,
        person_ids: list[str],
        evidence_ids: list[str],
        analysis: dict,
        generation_kind: str = "safe_placeholder",
        analysis_question: str | None = None,
        topic_id: str | None = None,
        expected_revision: int | None = None,
        include_charts: bool = False,
        expected_context: dict | None = None,
    ) -> dict:
        with self._lock:
            root, index = self._require_open()
            if expected_context is None:
                expected_context = self.report_analysis_context(evidence_ids)
            if expected_context is not None:
                try:
                    matches = self.report_analysis_context(evidence_ids) == expected_context
                except WorkspaceError:
                    matches = False
                if not matches:
                    raise WorkspaceError(
                        "workspace_conflict", "分析期间材料或工作区发生变化，未保存报告。",
                        status_code=409,
                    )
            previous_topic = None
            previous_hash = None
            previous_topic_bytes = None
            if topic_id:
                previous_topic = self._require_reference(topic_id, "report_topic")
                item = index.get(topic_id)
                assert item is not None
                previous_hash = item.file_hash
                topic_file = root / item.relative_path
                try:
                    previous_topic_bytes = topic_file.read_bytes()
                    current_hash = hashlib.sha256(previous_topic_bytes).hexdigest()
                except OSError as error:
                    raise WorkspaceError(
                        "workspace_conflict", "报告文件已不可读取，请刷新后再更新。",
                        status_code=409,
                    ) from error
                if (
                    expected_revision is not None
                    and previous_topic["revision"] != expected_revision
                ) or current_hash != previous_hash:
                    raise WorkspaceError(
                        "workspace_conflict",
                        "报告已发生变化，请刷新后核对再更新。",
                        status_code=409,
                    )
                if (
                    previous_topic["template_family"] != template_family
                    or previous_topic.get("template_variant", template_variant) != template_variant
                ):
                    raise WorkspaceError(
                        "validation_error", "更新报告需沿用同一主题的分析类型。",
                    )
            self._require_references(person_ids, "person")
            evidence_records = [
                self._require_reference(evidence_id, "evidence")
                for evidence_id in evidence_ids
            ]
            self._validate_analysis(analysis)
            selected_evidence = set(evidence_ids)
            used_evidence = {
                evidence_id
                for claim in analysis["claims"]
                for evidence_id in claim["evidence_ids"]
            }
            source_ids = list(dict.fromkeys(item["source_id"] for item in evidence_records))
            if used_evidence - selected_evidence or set(analysis["material_scope"]) != set(
                source_ids
            ):
                raise WorkspaceError(
                    "validation_error",
                    "分析输出引用了请求范围之外的证据或材料。",
                    details={
                        "selected_evidence_ids": evidence_ids,
                        "expected_material_scope": source_ids,
                    },
                )

            now = _now()
            topic_id = topic_id or str(uuid.uuid4())
            version = previous_topic["snapshot_count"] + 1 if previous_topic else 1
            snapshot = {
                "schema_version": SCHEMA_VERSION,
                "entity_type": "report_snapshot",
                "id": str(uuid.uuid4()),
                "revision": 1,
                "created_at": now,
                "updated_at": now,
                "topic_id": topic_id,
                "version": version,
                "generation_kind": generation_kind,
                "evidence_ids": evidence_ids,
            }
            topic = {
                "schema_version": SCHEMA_VERSION,
                "entity_type": "report_topic",
                "id": topic_id,
                "revision": previous_topic["revision"] + 1 if previous_topic else 1,
                "created_at": previous_topic["created_at"] if previous_topic else now,
                "updated_at": now,
                "title": title,
                "template_family": template_family,
                "template_variant": template_variant,
                "analysis_question": analysis_question or title,
                "person_ids": person_ids,
                "current_snapshot_id": snapshot["id"],
                "snapshot_count": version,
                "status": "draft",
            }
            self._validate_entity(snapshot)
            self._validate_entity(topic)
            body = _report_body(title, analysis)
            charts_directory = None
            if include_charts:
                chart_sources = []
                for source_id in source_ids:
                    self.get_source_original(source_id)
                    source = self._require_reference(source_id, "source")
                    item = index.get(source_id)
                    assert item is not None
                    text = item.body
                    if source["source_kind"] == "screenshot":
                        transcript = self._require_reference(
                            source["transcript_id"], "screenshot_transcript",
                        )
                        text = "\n".join(
                            f"{segment['speaker']}：{segment['text']}"
                            for segment in sorted(
                                transcript["segments"], key=lambda row: row["order"],
                            )
                        )
                    chart_sources.append({
                        "id": source_id, "sha256": source["sha256"],
                        "source_kind": source["source_kind"], "text": text,
                    })
                relative_directory = f"attachments/reports/{snapshot['id']}"
                charts_directory = _safe_workspace_path(root, relative_directory)
                try:
                    charts = generate_report_charts(charts_directory, chart_sources)
                except ReportChartError as error:
                    raise WorkspaceError("report_charts_failed", str(error)) from error
                charts["manifest_path"] = f"{relative_directory}/manifest.json"
                snapshot["charts"] = charts
                self._validate_entity(snapshot)
                # Vault-root links work from both topic and snapshot locations;
                # the two documents must retain exactly the same current body.
                body += (
                    "\n## 本地 R 统计图\n\n"
                    f"![[{relative_directory}/frequency.png]]\n\n"
                    f"![[{relative_directory}/terms.png]]\n\n"
                    f"[[{relative_directory}/manifest.json|统计方法与完整性清单]] · "
                    f"[[{relative_directory}/report_charts.R|R 脚本]]\n\n"
                    "统计范围为本报告证据关联的完整材料；中文词频为重复词组线索，非精确分词。\n"
                )
            if expected_context is not None:
                try:
                    matches = self.report_analysis_context(evidence_ids) == expected_context
                except WorkspaceError:
                    matches = False
                if not matches:
                    if charts_directory is not None:
                        archive = root / "归档" / "未提交报告"
                        archive.mkdir(parents=True, exist_ok=True)
                        os.replace(charts_directory, archive / snapshot["id"])
                    raise WorkspaceError(
                        "workspace_conflict", "绘图期间材料发生变化，未保存报告。",
                        status_code=409,
                    )
            snapshot_path = (
                root / "reports" / "snapshots" / f"{snapshot['id']}.md"
            )
            _atomic_create(snapshot_path, _markdown_bytes(snapshot, body))
            topic_path = root / "reports" / f"{topic['id']}.md"
            topic_bytes = _markdown_bytes(topic, body)
            topic_written = False
            try:
                if previous_topic:
                    _atomic_replace(topic_path, topic_bytes, previous_hash)
                else:
                    _atomic_create(topic_path, topic_bytes)
                topic_written = True
                self.rebuild_index()
            except Exception:
                # A snapshot that failed to become current remains recoverable,
                # outside the live index and without creating a duplicate version.
                archive = root / "归档" / "未提交报告"
                archive.mkdir(parents=True, exist_ok=True)
                if topic_written:
                    try:
                        written_hash = hashlib.sha256(topic_bytes).hexdigest()
                        if hashlib.sha256(topic_path.read_bytes()).hexdigest() != written_hash:
                            raise WorkspaceError(
                                "workspace_conflict", "报告提交后又有外部修改，请刷新核对。",
                                status_code=409,
                            )
                        if previous_topic_bytes is not None:
                            _atomic_replace(topic_path, previous_topic_bytes, written_hash)
                        else:
                            os.replace(topic_path, archive / topic_path.name)
                    except Exception as rollback_error:
                        # Never overwrite an external edit or remove a snapshot
                        # that the externally changed topic might still reference.
                        raise WorkspaceError(
                            "workspace_conflict",
                            "工作区有并发修改，新快照已保留，请刷新后核对报告。",
                            status_code=409,
                        ) from rollback_error
                os.replace(snapshot_path, archive / snapshot_path.name)
                if charts_directory is not None:
                    os.replace(charts_directory, archive / snapshot["id"])
                _fsync_directory(snapshot_path.parent)
                _fsync_directory(archive)
                raise
            return {"topic": topic, "snapshot": snapshot, "analysis": analysis}

    def get_report_asset(self, snapshot_id: str, name: str) -> dict:
        with self._lock:
            root, _ = self._require_open()
            snapshot = self._require_reference(snapshot_id, "report_snapshot")
            charts = snapshot.get("charts")
            if not charts or name not in ASSET_TYPES or Path(name).name != name:
                raise WorkspaceError("record_not_found", "未找到报告附件。", status_code=404)
            assets = {item["name"]: item for item in charts["assets"]}
            if name not in assets or "manifest.json" not in assets:
                raise WorkspaceError("record_not_found", "未找到报告附件。", status_code=404)
            relative = f"attachments/reports/{snapshot_id}"
            manifest_path = _safe_workspace_path(root, f"{relative}/manifest.json")
            path = _safe_workspace_path(root, f"{relative}/{name}")
            try:
                manifest_raw = manifest_path.read_bytes()
                if hashlib.sha256(manifest_raw).hexdigest() != assets["manifest.json"]["sha256"]:
                    raise ValueError("manifest hash mismatch")
                if name != "manifest.json":
                    manifest = json.loads(manifest_raw)
                    declared = {item["name"]: item for item in manifest["files"]}
                    if name not in declared or declared[name]["sha256"] != assets[name]["sha256"]:
                        raise ValueError("asset not in manifest")
                if hashlib.sha256(path.read_bytes()).hexdigest() != assets[name]["sha256"]:
                    raise ValueError("asset hash mismatch")
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise WorkspaceError(
                    "report_asset_invalid", "报告图表或附件已改变，请核对原始文件。",
                    status_code=409,
                ) from error
            return {"path": str(path), "mime_type": ASSET_TYPES[name][1], "filename": name}

    def get_report_versions(self, topic_id: str) -> list[dict]:
        with self._lock:
            _, index = self._require_open()
            topic = self._require_reference(topic_id, "report_topic")
            snapshots = [
                item for item in index.list("report_snapshot")
                if item["topic_id"] == topic_id
                and item["version"] <= topic["snapshot_count"]
            ]
            result = []
            for snapshot in sorted(snapshots, key=lambda item: item["version"], reverse=True):
                item = index.get(snapshot["id"])
                assert item is not None
                result.append({
                    "topic": topic,
                    "snapshot": snapshot,
                    "analysis": _analysis_from_body(item.body),
                })
            return result

    def get_record(self, record_id: str) -> dict:
        with self._lock:
            _, index = self._require_open()
            try:
                uuid.UUID(record_id)
            except (TypeError, ValueError, AttributeError) as error:
                raise WorkspaceError(
                    "record_not_found",
                    "未找到指定记录。",
                    status_code=404,
                    details={"record_id": record_id},
                ) from error
            item = index.get(record_id)
            if item is None:
                raise WorkspaceError(
                    "record_not_found",
                    "未找到指定记录。",
                    status_code=404,
                    details={"record_id": record_id},
                )
            return {
                "record": item.record,
                "relative_path": item.relative_path,
                "body": item.body,
                "file_hash": item.file_hash,
            }

    def _initialize_layout(self, root: Path) -> None:
        manifest_path = root / "workspace.json"
        if not manifest_path.exists():
            now = _now()
            manifest = {
                "schema_version": SCHEMA_VERSION,
                "workspace_id": str(uuid.uuid4()),
                "created_at": now,
                "title": root.name,
            }
            _atomic_create(manifest_path, _json_bytes(manifest))
        for relative in (
            "people",
            "relations",
            "events",
            "sources",
            "transcripts",
            "evidence",
            "reports/snapshots",
            "attachments",
            ".lingxi",
        ):
            (root / relative).mkdir(parents=True, exist_ok=True)

    def _load_manifest(self, root: Path) -> dict:
        path = root / "workspace.json"
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            if set(manifest) != {"schema_version", "workspace_id", "created_at", "title"}:
                raise ValueError("unexpected workspace manifest fields")
            if manifest["schema_version"] != SCHEMA_VERSION:
                raise ValueError("unsupported schema version")
            uuid.UUID(manifest["workspace_id"])
            datetime.fromisoformat(manifest["created_at"].replace("Z", "+00:00"))
            if not isinstance(manifest["title"], str) or not manifest["title"]:
                raise ValueError("empty title")
        except (
            OSError,
            UnicodeError,
            json.JSONDecodeError,
            KeyError,
            TypeError,
            ValueError,
        ) as error:
            raise WorkspaceError(
                "invalid_workspace",
                "workspace.json 无效。",
                details={"path": str(path)},
            ) from error
        return manifest

    def _scan_workspace(self) -> tuple[list[IndexRecord], list[str]]:
        root, _ = self._require_open()
        records: list[IndexRecord] = []
        canonical_paths: dict[str, str] = {}
        for entity_type, directory in ENTITY_DIRECTORIES.items():
            base = root / directory
            pattern = "*.json" if entity_type == "source" else "*.md"
            for path in sorted(base.glob(pattern)):
                item = (
                    self._load_source(path)
                    if entity_type == "source"
                    else self._load_markdown(path, entity_type)
                )
                record_id = item.record["id"]
                if record_id in canonical_paths:
                    raise WorkspaceError(
                        "validation_error",
                        "工作区存在重复实体 ID。",
                        details={
                            "record_id": record_id,
                            "paths": [canonical_paths[record_id], str(path.relative_to(root))],
                        },
                    )
                canonical_paths[record_id] = str(path.relative_to(root))
                records.append(item)
        pending = self._validate_references(records)
        return records, pending

    def _load_markdown(self, path: Path, expected_type: str) -> IndexRecord:
        root, _ = self._require_open()
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8")
            record, body = _parse_markdown(text)
        except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
            raise WorkspaceError(
                "validation_error",
                "Markdown 实体无法解析。",
                details={"path": str(path.relative_to(root)), "reason": str(error)},
            ) from error
        self._validate_entity(record, path)
        if record["entity_type"] != expected_type or path.stem != record["id"]:
            raise WorkspaceError(
                "validation_error",
                "实体类型、ID 与文件路径不一致。",
                details={"path": str(path.relative_to(root)), "record_id": record.get("id")},
            )
        digest = hashlib.sha256(raw).hexdigest()
        return IndexRecord(
            record=record,
            relative_path=str(path.relative_to(root)),
            body=body,
            file_hash=digest,
            fingerprint=digest,
        )

    def _load_source(self, path: Path) -> IndexRecord:
        root, _ = self._require_open()
        try:
            metadata_raw = path.read_bytes()
            record = json.loads(metadata_raw.decode("utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise WorkspaceError(
                "validation_error",
                "来源 JSON 无法解析。",
                details={"path": str(path.relative_to(root))},
            ) from error
        self._validate_entity(record, path)
        if record["entity_type"] != "source" or path.stem != record["id"]:
            raise WorkspaceError(
                "validation_error",
                "来源 ID 与文件路径不一致。",
                details={"path": str(path.relative_to(root)), "record_id": record.get("id")},
            )
        original = _safe_workspace_path(root, record["original_path"])
        try:
            original_raw = original.read_bytes()
        except OSError as error:
            raise WorkspaceError(
                "validation_error",
                "来源原件不存在或无法读取。",
                details={"path": record["original_path"]},
            ) from error
        original_hash = hashlib.sha256(original_raw).hexdigest()
        if original_hash != record["sha256"]:
            raise WorkspaceError(
                "validation_error",
                "来源原件哈希与元数据不一致。",
                details={"source_id": record["id"], "path": record["original_path"]},
            )
        fingerprint_parts = [metadata_raw, b"\0", original_raw]
        if record["source_kind"] == "screenshot":
            if record["processing_status"] == "pending_confirmation":
                body = ""
            else:
                transcript_id = record.get("transcript_id")
                if not transcript_id:
                    raise WorkspaceError(
                        "validation_error",
                        "已确认截图缺少确认稿引用。",
                        details={"source_id": record["id"]},
                    )
                transcript_path = root / "transcripts" / f"{transcript_id}.md"
                transcript_item = self._load_markdown(
                    transcript_path,
                    "screenshot_transcript",
                )
                if transcript_item.record["source_id"] != record["id"]:
                    raise WorkspaceError(
                        "validation_error",
                        "截图与确认稿之间的引用不一致。",
                        details={
                            "source_id": record["id"],
                            "transcript_id": transcript_id,
                        },
                    )
                body = transcript_item.body
                fingerprint_parts.extend(
                    [b"\0", transcript_item.fingerprint.encode("ascii")]
                )
        else:
            try:
                body = original_raw.decode("utf-8")
            except UnicodeError as error:
                raise WorkspaceError(
                    "validation_error",
                    "原始文本不是 UTF-8 文本。",
                    details={"path": record["original_path"]},
                ) from error
        fingerprint = hashlib.sha256(b"".join(fingerprint_parts)).hexdigest()
        return IndexRecord(
            record=record,
            relative_path=record["original_path"],
            body=body,
            file_hash=original_hash,
            fingerprint=fingerprint,
        )

    def _validate_references(self, records: list[IndexRecord]) -> list[str]:
        by_id = {item.record["id"]: item.record for item in records}

        def require(record: dict, field: str, expected: str) -> None:
            values = record.get(field, [])
            if isinstance(values, str):
                values = [values]
            for target_id in values:
                target = by_id.get(target_id)
                if target is None or target["entity_type"] != expected:
                    raise WorkspaceError(
                        "validation_error",
                        "实体引用不存在或类型不匹配。",
                        details={
                            "record_id": record["id"],
                            "field": field,
                            "target_id": target_id,
                            "expected_type": expected,
                        },
                    )

        for item in records:
            record = item.record
            entity_type = record["entity_type"]
            if entity_type == "person":
                for entry in record.get("profile_sections", []):
                    require(entry | {"id": record["id"]}, "evidence_ids", "evidence")
            elif entity_type == "relation":
                require(record, "from_person_id", "person")
                require(record, "to_person_id", "person")
                require(record, "evidence_ids", "evidence")
            elif entity_type == "event":
                require(record, "person_ids", "person")
                require(record, "source_ids", "source")
                if analysis := record.get("analysis"):
                    require(analysis | {"id": record["id"]}, "source_ids", "source")
                    scope = set(analysis["source_ids"])
                    if (
                        set(analysis["source_hashes"]) != scope
                        or set(analysis["source_text_hashes"]) != scope
                        or any(node["source_id"] not in scope for node in analysis["nodes"])
                    ):
                        raise WorkspaceError("validation_error", "事件候选分析的材料范围不一致。")
            elif entity_type == "source":
                require(record, "person_ids", "person")
                require(record, "event_ids", "event")
                if record["source_kind"] == "screenshot":
                    if record["processing_status"] == "confirmed":
                        require(record, "transcript_id", "screenshot_transcript")
                        transcript = by_id[record["transcript_id"]]
                        if transcript["source_id"] != record["id"]:
                            raise WorkspaceError(
                                "validation_error",
                                "截图与确认稿之间的引用不一致。",
                                details={
                                    "source_id": record["id"],
                                    "transcript_id": transcript["id"],
                                },
                            )
                    elif "transcript_id" in record:
                        raise WorkspaceError(
                            "validation_error",
                            "待确认截图不能引用确认稿。",
                            details={"source_id": record["id"]},
                        )
            elif entity_type == "screenshot_transcript":
                require(record, "source_id", "source")
                require(record, "person_ids", "person")
                require(record, "event_ids", "event")
                source = by_id[record["source_id"]]
                if (
                    source["source_kind"] != "screenshot"
                    or source.get("processing_status") != "confirmed"
                    or source.get("transcript_id") != record["id"]
                ):
                    raise WorkspaceError(
                        "validation_error",
                        "确认稿与截图来源之间的引用不一致。",
                        details={
                            "transcript_id": record["id"],
                            "source_id": source["id"],
                        },
                    )
            elif entity_type == "evidence":
                require(record, "source_id", "source")
                require(record, "person_ids", "person")
                require(record, "event_ids", "event")
                items_by_id = {
                    candidate.record["id"]: candidate for candidate in records
                }
                start = record["locator"]["start"]
                end = record["locator"]["end"]
                locator = record["locator"]
                if locator["kind"] == "text_quote":
                    located_text = items_by_id[record["source_id"]].body
                else:
                    require(
                        locator | {"id": record["id"]},
                        "transcript_id",
                        "screenshot_transcript",
                    )
                    transcript = by_id[locator["transcript_id"]]
                    if transcript["source_id"] != record["source_id"]:
                        raise WorkspaceError(
                            "evidence_locator_mismatch",
                            "截图证据引用了其他来源的确认稿。",
                            details={"record_id": record["id"]},
                        )
                    segment = next(
                        (
                            candidate
                            for candidate in transcript["segments"]
                            if candidate["segment_id"] == locator["segment_id"]
                        ),
                        None,
                    )
                    if segment is None:
                        raise WorkspaceError(
                            "evidence_locator_mismatch",
                            "截图证据引用的确认稿分段不存在。",
                            details={"record_id": record["id"]},
                        )
                    located_text = segment["text"]
                if end > len(located_text) or located_text[start:end] != record["quote"]:
                    raise WorkspaceError(
                        "evidence_locator_mismatch",
                        "证据引文与来源定位不一致。",
                        details={"record_id": record["id"]},
                    )
            elif entity_type == "report_topic":
                require(record, "person_ids", "person")
                if "relation_id" in record:
                    require(record, "relation_id", "relation")
            elif entity_type == "report_snapshot":
                require(record, "evidence_ids", "evidence")
                analysis = _analysis_from_body(item.body)
                self._validate_analysis(analysis)
                selected_evidence = set(record["evidence_ids"])
                used_evidence = {
                    evidence_id
                    for claim in analysis["claims"]
                    for evidence_id in claim["evidence_ids"]
                }
                expected_sources = {
                    by_id[evidence_id]["source_id"] for evidence_id in selected_evidence
                }
                if (
                    used_evidence - selected_evidence
                    or set(analysis["material_scope"]) != expected_sources
                ):
                    raise WorkspaceError(
                        "validation_error",
                        "报告快照引用了范围之外的证据或材料。",
                        details={"snapshot_id": record["id"]},
                    )

        for source in (
            record for record in by_id.values() if record["entity_type"] == "source"
        ):
            for event_id in source["event_ids"]:
                if source["id"] not in by_id[event_id]["source_ids"]:
                    raise WorkspaceError(
                        "validation_error",
                        "来源与事件之间的双向引用不一致。",
                        details={"source_id": source["id"], "event_id": event_id},
                    )
        for event in (
            record for record in by_id.values() if record["entity_type"] == "event"
        ):
            for source_id in event["source_ids"]:
                if event["id"] not in by_id[source_id]["event_ids"]:
                    raise WorkspaceError(
                        "validation_error",
                        "事件与来源之间的双向引用不一致。",
                        details={"event_id": event["id"], "source_id": source_id},
                    )

        topics = {
            record_id: record
            for record_id, record in by_id.items()
            if record["entity_type"] == "report_topic"
        }
        snapshots = {
            record_id: record
            for record_id, record in by_id.items()
            if record["entity_type"] == "report_snapshot"
        }
        for topic in topics.values():
            snapshot = snapshots.get(topic["current_snapshot_id"])
            if snapshot is None or snapshot["topic_id"] != topic["id"]:
                raise WorkspaceError(
                    "validation_error",
                    "报告主题引用的当前快照不存在或归属错误。",
                    details={"topic_id": topic["id"]},
                )
            topic_item = next(item for item in records if item.record["id"] == topic["id"])
            snapshot_item = next(
                item for item in records if item.record["id"] == snapshot["id"]
            )
            if topic_item.body != snapshot_item.body:
                raise WorkspaceError(
                    "validation_error",
                    "报告主题当前正文与当前快照不一致。",
                    details={"topic_id": topic["id"], "snapshot_id": snapshot["id"]},
                )
        pending = [
            snapshot["id"]
            for snapshot in snapshots.values()
            if snapshot["topic_id"] not in topics
            or snapshot["version"] > topics[snapshot["topic_id"]]["snapshot_count"]
        ]
        return sorted(pending)

    def _attach_source_to_event(self, event_id: str, source_id: str) -> None:
        self._attach_sources_to_event(event_id, [source_id])

    def _attach_sources_to_event(
        self,
        event_id: str,
        source_ids: list[str],
    ) -> None:
        root, index = self._require_open()
        item = index.get(event_id)
        if item is None:
            raise WorkspaceError(
                "reference_not_found",
                "关联事件不存在。",
                details={"record_id": event_id},
            )
        record = dict(item.record)
        additions = [
            source_id
            for source_id in source_ids
            if source_id not in record["source_ids"]
        ]
        if not additions:
            return
        record["source_ids"] = [*record["source_ids"], *additions]
        record["revision"] += 1
        record["updated_at"] = _now()
        self._validate_entity(record)
        path = root / "events" / f"{event_id}.md"
        _atomic_replace(
            path,
            _markdown_bytes(record, item.body),
            expected_hash=item.file_hash,
        )

    def _require_references(self, record_ids: list[str], expected_type: str) -> None:
        if not isinstance(record_ids, list):
            raise WorkspaceError("validation_error", "实体引用必须是列表。")
        for record_id in record_ids:
            self._require_reference(record_id, expected_type)

    def _require_reference(self, record_id: str, expected_type: str) -> dict:
        _, index = self._require_open()
        item = index.get(record_id)
        if item is None or item.record["entity_type"] != expected_type:
            raise WorkspaceError(
                "reference_not_found",
                "关联记录不存在或类型不匹配。",
                details={"record_id": record_id, "expected_type": expected_type},
            )
        return item.record

    def _base_record(self, entity_type: str) -> dict:
        now = _now()
        return {
            "schema_version": SCHEMA_VERSION,
            "entity_type": entity_type,
            "id": str(uuid.uuid4()),
            "revision": 1,
            "created_at": now,
            "updated_at": now,
        }

    def _validate_entity(self, record: dict, path: Path | None = None) -> None:
        try:
            self._entity_validator.validate(record)
        except ValidationError as error:
            details: dict[str, Any] = {
                "field": ".".join(str(item) for item in error.absolute_path),
                "reason": error.message,
            }
            if path is not None and self._root is not None:
                details["path"] = str(path.relative_to(self._root))
            raise WorkspaceError(
                "validation_error",
                "实体不符合共享 Schema。",
                details=details,
            ) from error

    def _validate_analysis(self, analysis: dict) -> None:
        try:
            self._analysis_validator.validate(analysis)
        except ValidationError as error:
            raise WorkspaceError(
                "validation_error",
                "分析输出不符合共享 Schema。",
                details={
                    "field": ".".join(str(item) for item in error.absolute_path),
                    "reason": error.message,
                },
            ) from error

    def _require_open(self) -> tuple[Path, DerivedIndex]:
        if self._root is None or self._index is None:
            raise WorkspaceError(
                "workspace_not_open",
                "请先打开工作区。",
                status_code=409,
            )
        return self._root, self._index


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _counts(records: list[IndexRecord]) -> dict[str, int]:
    return dict(sorted(Counter(item.record["entity_type"] for item in records).items()))


def _json_bytes(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _markdown_bytes(frontmatter: dict, body: str) -> bytes:
    yaml_text = yaml.safe_dump(
        frontmatter,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    normalized_body = body if body.endswith("\n") else f"{body}\n"
    return f"---\n{yaml_text}---\n{normalized_body}".encode()


def _parse_markdown(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        raise ValueError("missing YAML frontmatter")
    marker = text.find("\n---\n", 4)
    if marker < 0:
        raise ValueError("unclosed YAML frontmatter")
    record = yaml.safe_load(text[4:marker])
    if not isinstance(record, dict):
        raise ValueError("frontmatter is not an object")
    return record, text[marker + 5 :]


def _event_body(record: dict) -> str:
    people = "、".join(f"[[people/{person_id}|{person_id}]]" for person_id in record["person_ids"])
    body = (
        f"# {record['title']}\n\n发生时间：{record['occurred_at']}\n"
        f"地点：{record.get('location', '')}\n相关人物：{people}\n\n"
        f"## 事件简述\n\n{record.get('summary', '')}\n"
    )
    analysis = record.get("analysis")
    if analysis:
        body += f"\n## AI 候选分析（待核对）\n\n{analysis['summary']}\n\n### 候选节点\n"
        for node in analysis["nodes"]:
            time = (
                f"（原文时码 {node['timestamp_ms'] / 1000:g} 秒）"
                if "timestamp_ms" in node else ""
            )
            quote = node["quote"].replace("\n", "\n> ")
            body += (
                f"\n- {node['label']}{time} · 待核对\n\n> {quote}\n\n"
                f"  来源：[[sources/{node['source_id']}|所选原文]]，"
                f"字符位置 {node['quote_start']}–{node['quote_end']}\n"
            )
    return body


def _person_body(record: dict) -> str:
    entries_by_section: dict[str, list[dict]] = {
        section: [] for section in PROFILE_SECTION_LABELS
    }
    review_entries: list[dict] = []
    for entry in record.get("profile_sections", []):
        if entry["confirmation_status"] == "confirmed":
            entries_by_section[entry["section"]].append(entry)
        else:
            review_entries.append(entry)

    sections = [
        f"# {record['display_name']}",
        "",
        f"与用户关系：{record['relation_to_user']}",
    ]
    for section, heading in PROFILE_SECTION_LABELS.items():
        sections.extend(["", f"## {heading}", ""])
        entries = entries_by_section[section]
        if not entries:
            sections.append("- 暂无")
            continue
        for entry in entries:
            sections.append(f"- **{entry['label']}**：{entry['value']}")
            if entry["evidence_ids"]:
                evidence_links = "、".join(
                    f"[[evidence/{evidence_id}|{evidence_id}]]"
                    for evidence_id in entry["evidence_ids"]
                )
                sections.append(f"  - 证据：{evidence_links}")
    if review_entries:
        sections.extend(["", "## AI 候选复核记录", ""])
        status_labels = {"candidate": "待确认", "rejected": "已退回"}
        for entry in review_entries:
            status = status_labels.get(
                entry["confirmation_status"],
                entry["confirmation_status"],
            )
            sections.append(f"- **{status}**：{entry['value']}")
            if entry["evidence_ids"]:
                evidence_links = "、".join(
                    f"[[evidence/{evidence_id}|{evidence_id}]]"
                    for evidence_id in entry["evidence_ids"]
                )
                sections.append(f"  - 证据：{evidence_links}")
    return "\n".join(sections) + "\n"


def _matches_screenshot_magic(content: bytes, mime_type: str) -> bool:
    if mime_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    if mime_type == "image/webp":
        return (
            len(content) >= 12
            and content.startswith(b"RIFF")
            and content[8:12] == b"WEBP"
        )
    return False


def _screenshot_title(title: str, sequence_index: int, total: int) -> str:
    if total == 1:
        return title
    suffix = f"（{sequence_index + 1}/{total}）"
    return f"{title[: 200 - len(suffix)]}{suffix}"


def _reliability_from_uncertainty(uncertainty: str) -> str:
    return {"low": "high", "medium": "medium", "high": "low"}[uncertainty]


def _record_references_person(record: dict, person_id: str) -> bool:
    if record["entity_type"] == "relation":
        return person_id in {
            record["from_person_id"],
            record["to_person_id"],
        }
    return person_id in record.get("person_ids", [])


def _screenshot_transcript_body(source: dict, transcript: dict) -> str:
    speaker_labels = {"me": "我", "other": "对方", "unknown": "未知说话人"}
    lines = [
        f"# {source['title']}确认稿",
        "",
        f"原图：![[{source['original_path']}]]",
        "",
        "## 已确认分段",
    ]
    for segment in transcript["segments"]:
        lines.extend(
            [
                "",
                f"### {segment['order'] + 1}. {speaker_labels[segment['speaker']]}",
                "",
                segment["text"],
                "",
                f"识别不确定性：{segment['uncertainty']}",
            ]
        )
    return "\n".join(lines) + "\n"


def _screenshot_evidence_body(
    source: dict,
    transcript: dict,
    segment: dict,
) -> str:
    quoted = segment["text"].replace("\n", "\n> ")
    return (
        "# 截图原子证据\n\n"
        f"> {quoted}\n\n"
        f"原图：![[{source['original_path']}]]\n\n"
        f"确认稿：[[transcripts/{transcript['id']}]]；"
        f"分段：`{segment['segment_id']}`。\n"
    )


def _report_body(title: str, analysis: dict) -> str:
    lines = [f"# {html.escape(title, quote=False)}", ""]
    headings = {
        "observation": "材料里看到了什么",
        "hypothesis": "一种可能的理解",
        "unknown": "还需要了解什么",
        "suggestion": "可以试试什么",
    }
    if analysis.get("report_markdown"):
        lines.extend([html.escape(analysis["report_markdown"], quote=False).strip(), ""])
    else:
        for kind, heading in headings.items():
            claims = [item for item in analysis["claims"] if item["claim_type"] == kind]
            if not claims:
                continue
            lines.extend([f"## {heading}", ""])
            for claim in claims:
                text = html.escape(claim["text"], quote=False).replace("![", r"\![")
                lines.extend([text, ""])
                alternatives = claim.get("alternatives", [])
                if alternatives:
                    lines.extend([
                        "也可能是："
                        + "；".join(html.escape(item, quote=False) for item in alternatives),
                        "",
                    ])
    # Keep existing evidence parsing, but hide machine data in ordinary Markdown readers.
    structured = json.dumps(analysis, ensure_ascii=False, indent=2).replace("-->", r"\u002d\u002d>")
    lines.extend([
        "<!-- lingxi-structured-analysis", "```json", structured, "```", "-->", "",
    ])
    return "\n".join(lines)


def _analysis_from_body(body: str) -> dict:
    prefix = "```json\n"
    marker = body.find("<!-- lingxi-structured-analysis\n")
    start = body.find(prefix, max(marker, 0))
    end = body.find("\n```", start + len(prefix))
    if start < 0 or end < 0:
        raise WorkspaceError(
            "validation_error",
            "报告快照缺少结构化分析。",
        )
    try:
        analysis = json.loads(body[start + len(prefix) : end])
    except json.JSONDecodeError as error:
        raise WorkspaceError(
            "validation_error",
            "报告快照中的结构化分析无法解析。",
        ) from error
    return analysis


def _safe_workspace_path(root: Path, relative_path: str) -> Path:
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise WorkspaceError(
            "validation_error",
            "实体路径超出工作区。",
            details={"path": relative_path},
        ) from error
    return candidate


def _validate_analysis_template_config(config: Any) -> None:
    expected_root = {"schema_version", "active_template_id", "custom_templates"}
    template_fields = {
        "id",
        "name",
        "category",
        "description",
        "dimensions",
        "evidence_requirements",
        "forbidden_conclusions",
        "template_family",
        "template_variant",
        "default_question",
    }
    categories = {
        "general",
        "romantic",
        "family",
        "education",
        "friendship",
        "workplace",
        "professional_support",
    }
    family_variants = {
        "person_long_term": {
            "overview",
            "preferences_habits",
            "experiences_values",
        },
        "relation": {
            "romantic",
            "family_parent",
            "mentor_collaboration",
            "friend_social",
            "other",
        },
        "recent_change": {"recent_state"},
        "special": {
            "gift_advice",
            "communication_prep",
            "conflict_review",
            "behavior_interpretation",
            "custom",
        },
    }

    def invalid(message: str) -> None:
        raise WorkspaceError(
            "invalid_template_config",
            message,
            details={"path": ANALYSIS_TEMPLATES_FILE},
        )

    if not isinstance(config, dict) or set(config) != expected_root:
        invalid("分析模板配置的顶层字段不正确。")
    if config.get("schema_version") != SCHEMA_VERSION:
        invalid("分析模板配置版本不受支持。")
    custom = config.get("custom_templates")
    if not isinstance(custom, list) or len(custom) > 50:
        invalid("自定义分析模板必须是最多 50 项的列表。")

    built_in_ids = {item["id"] for item in BUILTIN_ANALYSIS_TEMPLATES}
    custom_ids: set[str] = set()
    allowed_id_chars = set("abcdefghijklmnopqrstuvwxyz0123456789_-")
    list_limits = {
        "dimensions": 12,
        "evidence_requirements": 8,
        "forbidden_conclusions": 8,
    }
    for template in custom:
        if not isinstance(template, dict) or set(template) != template_fields:
            invalid("自定义分析模板字段不完整或包含未知字段。")
        template_id = template["id"]
        if (
            not isinstance(template_id, str)
            or not 3 <= len(template_id) <= 80
            or template_id[0] not in allowed_id_chars - {"_", "-"}
            or any(character not in allowed_id_chars for character in template_id)
            or template_id in built_in_ids
            or template_id in custom_ids
        ):
            invalid("自定义分析模板 ID 无效、重复或与内置模板冲突。")
        custom_ids.add(template_id)
        if template["category"] not in categories:
            invalid("自定义分析模板分类无效。")
        for field, maximum in (
            ("name", 80),
            ("description", 400),
            ("default_question", 2000),
        ):
            value = template[field]
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                invalid(f"自定义分析模板的 {field} 字段无效。")
        for field, maximum in list_limits.items():
            values = template[field]
            if (
                not isinstance(values, list)
                or not 1 <= len(values) <= maximum
                or any(
                    not isinstance(value, str)
                    or not value.strip()
                    or len(value) > 240
                    for value in values
                )
            ):
                invalid(f"自定义分析模板的 {field} 字段无效。")
        family = template["template_family"]
        variant = template["template_variant"]
        if family not in family_variants or variant not in family_variants[family]:
            invalid("自定义分析模板的报告类型与细分类不匹配。")

    active_id = config.get("active_template_id")
    if active_id not in built_in_ids | custom_ids:
        invalid("当前启用的分析模板不存在。")


def _atomic_create(path: Path, content: bytes) -> None:
    temporary = _write_temporary(path, content)
    reserved = False
    reserved_inode: int | None = None
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        reserved_inode = os.fstat(descriptor).st_ino
        os.close(descriptor)
        reserved = True
        if path.stat().st_ino != reserved_inode:
            raise WorkspaceError(
                "workspace_conflict",
                "目标文件在创建期间发生变化，未覆盖外部内容。",
                status_code=409,
                details={"path": str(path)},
            )
        os.replace(temporary, path)
        reserved = False
        _fsync_directory(path.parent)
    except FileExistsError as error:
        raise WorkspaceError(
            "workspace_conflict",
            "目标文件已存在，未覆盖原内容。",
            status_code=409,
            details={"path": str(path)},
        ) from error
    finally:
        temporary.unlink(missing_ok=True)
        if reserved and reserved_inode is not None and _same_inode(path, reserved_inode):
            path.unlink(missing_ok=True)


def _atomic_replace(path: Path, content: bytes, expected_hash: str) -> None:
    temporary = _write_temporary(path, content)
    try:
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise WorkspaceError(
                "workspace_conflict",
                "开放文件已被外部修改，未静默覆盖。",
                status_code=409,
                details={"path": str(path), "expected_hash": expected_hash},
            )
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _write_temporary(path: Path, content: bytes) -> Path:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return temporary


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _same_inode(path: Path, inode: int) -> bool:
    try:
        return path.stat().st_ino == inode
    except FileNotFoundError:
        return False
