import json
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, status
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from lingxi.analysis.autofill import build_local_autofill
from lingxi.analysis.chat_analysis import (
    build_chat_analysis,
    model_message_payload,
    parse_chat_messages,
)
from lingxi.analysis.cli import (
    AnalysisOutputInvalid,
    CliExecutionError,
    ExecutionCancelled,
    ExecutionTimedOut,
)
from lingxi.analysis.direct_api import (
    DirectApiAdapter,
    DirectApiAuthenticationError,
    DirectModelSettings,
)
from lingxi.analysis.event_analysis import analyze_event
from lingxi.analysis.executors import discover_executors
from lingxi.analysis.placeholder import build_safe_placeholder
from lingxi.analysis.report_advisor import advise_report, suggested_prompts
from lingxi.analysis.report_charts import plotting_capabilities
from lingxi.api.errors import ApiError
from lingxi.api.models import (
    AnalysisTemplatesUpdate,
    AssistantQuestion,
    ChatAnalysisCreate,
    DirectModelConfigure,
    EventAnalysisCreate,
    EventCreate,
    EventNodeUpdate,
    EventUpdate,
    EvidenceCreate,
    OpenWorkspaceRequest,
    PersonCreate,
    PersonInterviewCreate,
    PersonUpdate,
    ProfileAutofillPreviewCreate,
    ProfileEntryCreate,
    ReportAdvisorCreate,
    ReportCreate,
    ScreenshotRecognitionCreate,
    ScreenshotTranscriptConfirm,
    TextSourceCreate,
)
from lingxi.api.report_exports import router as report_exports_router

router = APIRouter(prefix="/api")
router.include_router(report_exports_router)


@router.get("/plotting/capabilities")
def get_plotting_capabilities() -> dict:
    return plotting_capabilities()


def _direct_settings(request: Request) -> DirectModelSettings:
    if not hasattr(request.app.state, "direct_model_settings"):
        request.app.state.direct_model_settings = DirectModelSettings()
    return request.app.state.direct_model_settings


def _analysis_adapter(request: Request, engine: str, profile_id: str):
    if engine == "api":
        return DirectApiAdapter(_direct_settings(request))
    return request.app.state.cli_adapter_factory(engine, profile_id)


@router.get("/model-settings")
def direct_model_settings(request: Request):
    return _direct_settings(request).public()


@router.post("/model-settings")
def configure_direct_model(payload: DirectModelConfigure, request: Request):
    try:
        values = payload.model_dump(exclude={"api_key"})
        values["api_key"] = payload.api_key.get_secret_value() if payload.api_key else None
        _direct_settings(request).configure(**values)
    except ValueError as error:
        raise ApiError(
            422, "direct_api_invalid_config", "模型配置无效；请检查地址、模型和环境变量名称。"
        ) from error
    return _direct_settings(request).public()


@router.post("/model-settings/test")
def test_direct_model(request: Request):
    settings = _direct_settings(request)
    if not settings.public()["configured"]:
        raise ApiError(422, "direct_api_not_configured", "请先保存API地址、模型和密钥。")
    try:
        return DirectApiAdapter(settings, timeout_seconds=20).test_connection()
    except DirectApiAuthenticationError as error:
        raise ApiError(401, "direct_api_authentication_failed", str(error),
                       {"provider_http_status": error.status_code}) from error
    except CliExecutionError as error:
        raise ApiError(503, "direct_api_failed", "API请求失败，请检查配置或网络。") from error


MAX_SCREENSHOTS = 20
MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024
MAX_SCREENSHOT_BATCH_BYTES = 100 * 1024 * 1024
SCREENSHOT_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}


def _remember_recent_workspace(state_file: Path | None, workspace_path: str) -> None:
    if state_file is None:
        return
    temporary_file = state_file.with_suffix(f"{state_file.suffix}.tmp")
    try:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary_file.write_text(
            json.dumps({"path": workspace_path}, ensure_ascii=False),
            encoding="utf-8",
        )
        temporary_file.replace(state_file)
    except OSError:
        temporary_file.unlink(missing_ok=True)


def restore_recent_workspace(app: Any) -> None:
    state_file = app.state.recent_workspace_file
    if state_file is None:
        return
    try:
        saved = json.loads(state_file.read_text(encoding="utf-8"))
        path = Path(saved["path"])
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return
    if not path.is_absolute() or not path.is_dir():
        return
    workspace = app.state.workspace_factory()
    try:
        _invoke(workspace.open, str(path))
    except Exception:
        return
    app.state.workspace = workspace


def _workspace(request: Request) -> Any:
    workspace = request.app.state.workspace
    if workspace is None:
        raise ApiError(409, "workspace_not_open", "请先打开一个工作区。")
    return workspace


def _invoke(method: Any, *args: Any, **kwargs: Any) -> Any:
    try:
        return method(*args, **kwargs)
    except Exception as exc:
        code = getattr(exc, "code", None)
        status_code = getattr(exc, "status_code", None)
        if isinstance(code, str) and isinstance(status_code, int):
            raise ApiError(
                status_code,
                code,
                str(getattr(exc, "message", str(exc))),
                getattr(exc, "details", {}),
            ) from exc
        raise


def _ids(values: list[UUID]) -> list[str]:
    return [str(value) for value in values]


def _form_ids(value: str, field: str, *, required: bool = False) -> list[str]:
    try:
        raw = json.loads(value)
        if not isinstance(raw, list):
            raise ValueError
        parsed = [str(UUID(item)) for item in raw]
    except (json.JSONDecodeError, TypeError, ValueError, AttributeError) as error:
        raise ApiError(
            422,
            "validation_error",
            "截图批次引用的 ID 列表无效。",
            {"field": field},
        ) from error
    if required and not parsed:
        raise ApiError(
            422,
            "validation_error",
            "截图批次必须至少关联一个人物。",
            {"field": field},
        )
    if len(parsed) != len(set(parsed)):
        raise ApiError(
            422,
            "validation_error",
            "截图批次引用的 ID 不得重复。",
            {"field": field},
        )
    return parsed


def _detected_image_type(content: bytes) -> str | None:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(content) >= 12 and content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def _select_evidence(workspace: Any, evidence_ids: list[str]) -> list[dict[str, Any]]:
    indexed = {item["id"]: item for item in _invoke(workspace.list_entities, "evidence")}
    missing = [evidence_id for evidence_id in evidence_ids if evidence_id not in indexed]
    if missing:
        raise ApiError(
            422,
            "reference_not_found",
            "请求引用的证据不存在。",
            {"entity_type": "evidence", "ids": missing},
        )
    return [indexed[evidence_id] for evidence_id in evidence_ids]


def _degraded_reason(error: CliExecutionError | OSError) -> str:
    if isinstance(error, ExecutionTimedOut):
        return "execution_timed_out"
    if isinstance(error, ExecutionCancelled):
        return "execution_cancelled"
    if isinstance(error, AnalysisOutputInvalid):
        return "invalid_structured_output"
    return "execution_failed"


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "schema_version": "0.1"}


@router.get("/executors")
def list_executors() -> dict[str, list[dict[str, object]]]:
    return {"items": discover_executors()}


@router.post("/profile-autofill/preview")
def preview_profile_autofill(
    payload: ProfileAutofillPreviewCreate,
    request: Request,
) -> dict[str, object]:
    if payload.engine == "local_demo":
        preview = build_local_autofill(payload.text)
        profile_id = "local_demo"
        data_destination = "local_only"
    else:
        profile_id = payload.profile_id
        data_destination = (
            "configured_api_endpoint" if payload.engine == "api" else "selected_cli_process"
        )
        try:
            adapter = _analysis_adapter(
                request,
                payload.engine,
                profile_id,
            )
            preview = adapter.run_profile_autofill(payload.text)
        except (CliExecutionError, OSError, ValueError) as error:
            reason = (
                _degraded_reason(error)
                if isinstance(
                    error,
                    (CliExecutionError, OSError),
                )
                else "invalid_input"
            )
            raise ApiError(
                502,
                "profile_autofill_failed",
                "AI 自动整理未能完成；原文尚未写入工作区，可切换本地规则预览后重试。",
                {"reason": reason},
            ) from error
    return {
        "preview": preview,
        "execution": {
            "engine": payload.engine,
            "profile_id": profile_id,
            "data_destination": data_destination,
        },
    }


@router.post("/workspaces/open")
def open_workspace(payload: OpenWorkspaceRequest, request: Request) -> dict[str, object]:
    path = Path(payload.path)
    if not path.is_absolute() or not path.is_dir():
        raise ApiError(
            422,
            "invalid_workspace",
            "工作区路径必须是本机已存在的绝对目录。",
            {"path": payload.path},
        )
    factory = request.app.state.workspace_factory
    workspace = factory()
    summary = _invoke(workspace.open, str(path))
    # Serialize handover with in-flight mobile receipt; never write into a new vault.
    with request.app.state.mobile_receiver.lock:
        request.app.state.mobile_receiver.stop()
        request.app.state.workspace = workspace
    remembered_path = summary.get("path")
    if isinstance(remembered_path, str):
        _remember_recent_workspace(
            request.app.state.recent_workspace_file,
            remembered_path,
        )
    return summary


@router.get("/workspaces/current")
def get_current_workspace(request: Request) -> dict[str, object]:
    workspace = request.app.state.workspace
    if workspace is None:
        return {"open": False}
    return {"open": True, **_invoke(workspace.refresh)}


@router.post("/workspaces/refresh")
def refresh_workspace(workspace: Any = Depends(_workspace)) -> dict[str, object]:
    return _invoke(workspace.refresh)


@router.post("/workspaces/rebuild-index")
def rebuild_index(workspace: Any = Depends(_workspace)) -> dict[str, object]:
    return _invoke(workspace.rebuild_index)


@router.get("/workspaces/export")
def export_workspace(workspace: Any = Depends(_workspace)) -> FileResponse:
    result = _invoke(workspace.create_export_archive)
    archive_path = Path(result["path"])
    return FileResponse(
        archive_path,
        media_type="application/zip",
        filename=result["filename"],
        background=BackgroundTask(archive_path.unlink, missing_ok=True),
    )


@router.get("/analysis-templates")
def get_analysis_templates(
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(workspace.get_analysis_templates)


@router.put("/analysis-templates")
def update_analysis_templates(
    payload: AnalysisTemplatesUpdate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.update_analysis_templates,
        payload.active_template_id,
        [item.model_dump(mode="json") for item in payload.custom_templates],
        payload.expected_hash,
    )


@router.get("/people")
def list_people(workspace: Any = Depends(_workspace)) -> dict[str, list[dict[str, object]]]:
    return {"items": _invoke(workspace.list_entities, "person")}


@router.post("/people", status_code=status.HTTP_201_CREATED)
def create_person(
    payload: PersonCreate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.create_person,
        payload.display_name,
        payload.relation_to_user,
    )


@router.patch("/people/{person_id}")
def update_person(
    person_id: UUID,
    payload: PersonUpdate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.update_person,
        str(person_id),
        display_name=payload.display_name,
        relation_to_user=payload.relation_to_user,
    )


@router.post("/people/{person_id}/interview", status_code=status.HTTP_201_CREATED)
def save_person_interview(
    person_id: UUID, payload: PersonInterviewCreate, workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(workspace.append_person_interview, str(person_id),
                   [item.model_dump() for item in payload.answers],
                   [item.model_dump() for item in payload.attachments], str(payload.request_id))


@router.post(
    "/people/{person_id}/profile-entries",
    status_code=status.HTTP_201_CREATED,
)
def add_profile_entry(
    person_id: UUID,
    payload: ProfileEntryCreate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.add_profile_entry,
        str(person_id),
        payload.section,
        payload.label,
        payload.value,
        _ids(payload.evidence_ids),
        origin=payload.origin,
        confirmation_status=payload.confirmation_status,
    )


@router.get("/events")
def list_events(workspace: Any = Depends(_workspace)) -> dict[str, list[dict[str, object]]]:
    return {"items": _invoke(workspace.list_entities, "event")}


@router.post("/events", status_code=status.HTTP_201_CREATED)
def create_event(
    payload: EventCreate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.create_event,
        payload.title,
        payload.occurred_at,
        _ids(payload.person_ids),
        location=payload.location,
        summary=payload.summary,
    )


@router.patch("/events/{event_id}")
def update_event(
    event_id: UUID,
    payload: EventUpdate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.update_event,
        str(event_id),
        title=payload.title,
        occurred_at=payload.occurred_at,
        person_ids=_ids(payload.person_ids) if payload.person_ids is not None else None,
        location=payload.location,
        summary=payload.summary,
        expected_revision=payload.expected_revision,
    )


@router.patch("/events/{event_id}/nodes/{node_id}")
def update_event_node_label(
    event_id: UUID,
    node_id: UUID,
    payload: EventNodeUpdate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.update_event_node_label,
        str(event_id),
        str(node_id),
        payload.label,
        expected_revision=payload.expected_revision,
    )


@router.post("/events/{event_id}/analysis")
def analyze_event_materials(
    event_id: UUID,
    payload: EventAnalysisCreate,
    request: Request,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    if not payload.scope_confirmed:
        raise ApiError(422, "material_scope_not_confirmed", "请确认本次事件分析的材料范围。")
    context = _invoke(
        workspace.event_analysis_context,
        str(event_id),
        _ids(payload.source_ids),
        payload.expected_revision,
    )
    try:
        adapter = _analysis_adapter(request, payload.engine, payload.profile_id)
        result = analyze_event(adapter, context)
    except AnalysisOutputInvalid as error:
        raise ApiError(
            422, "event_analysis_invalid_output", "分析结果的结构或原文引用未通过校验，未保存。"
        ) from error
    except (CliExecutionError, OSError) as error:
        raise ApiError(
            503, "event_analysis_failed", "事件分析未完成，请检查模型配置或连接后重试。"
        ) from error
    if request.app.state.workspace is not workspace:
        raise ApiError(409, "workspace_changed", "工作区已切换，未保存旧事件分析。")
    return _invoke(workspace.save_event_analysis, str(event_id), context, result, payload.engine)


@router.get("/sources")
def list_sources(workspace: Any = Depends(_workspace)) -> dict[str, list[dict[str, object]]]:
    return {"items": _invoke(workspace.list_entities, "source")}


@router.post("/sources/text", status_code=status.HTTP_201_CREATED)
def import_text_source(
    payload: TextSourceCreate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.import_text_source,
        payload.title,
        payload.text,
        payload.source_kind,
        _ids(payload.person_ids),
        _ids(payload.event_ids),
    )


@router.post("/screenshot-batches", status_code=status.HTTP_201_CREATED)
async def import_screenshot_batch(
    title: str = Form(min_length=1, max_length=200),
    person_ids: str = Form(),
    event_ids: str = Form(default="[]"),
    files: list[UploadFile] = File(),
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    if not 1 <= len(files) <= MAX_SCREENSHOTS:
        raise ApiError(
            422,
            "screenshot_count_out_of_range",
            "一次只能上传 1 到 20 张截图。",
            {"count": len(files), "minimum": 1, "maximum": MAX_SCREENSHOTS},
        )
    parsed_person_ids = _form_ids(person_ids, "person_ids", required=True)
    parsed_event_ids = _form_ids(event_ids, "event_ids")
    items: list[dict[str, object]] = []
    total_bytes = 0
    for upload in files:
        content_type = (upload.content_type or "").lower()
        if content_type not in SCREENSHOT_MIME_TYPES:
            raise ApiError(
                422,
                "unsupported_screenshot_type",
                "截图只支持 PNG、JPEG 或 WebP。",
                {"filename": upload.filename or "", "mime_type": content_type},
            )
        content = await upload.read(MAX_SCREENSHOT_BYTES + 1)
        if not content or len(content) > MAX_SCREENSHOT_BYTES:
            raise ApiError(
                422,
                "screenshot_size_out_of_range",
                "单张截图必须大于 0 字节且不超过 15 MiB。",
                {"filename": upload.filename or "", "byte_size": len(content)},
            )
        detected_type = _detected_image_type(content)
        if detected_type != content_type:
            raise ApiError(
                422,
                "screenshot_content_mismatch",
                "截图文件内容与声明类型不一致。",
                {
                    "filename": upload.filename or "",
                    "mime_type": content_type,
                    "detected_type": detected_type,
                },
            )
        total_bytes += len(content)
        if total_bytes > MAX_SCREENSHOT_BATCH_BYTES:
            raise ApiError(
                422,
                "screenshot_batch_too_large",
                "一次上传的截图总大小不能超过 100 MiB。",
                {"byte_size": total_bytes},
            )
        items.append(
            {
                "filename": upload.filename or "screenshot",
                "mime_type": content_type,
                "content": content,
            }
        )
    return _invoke(
        workspace.import_screenshot_batch,
        title,
        items,
        parsed_person_ids,
        parsed_event_ids,
    )


@router.put(
    "/sources/{source_id}/transcript",
    status_code=status.HTTP_201_CREATED,
)
def confirm_screenshot_transcript(
    source_id: UUID,
    payload: ScreenshotTranscriptConfirm,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.confirm_screenshot_transcript,
        str(source_id),
        [segment.model_dump() for segment in payload.segments],
    )


@router.get("/sources/{source_id}/original")
def get_source_original(
    source_id: UUID,
    workspace: Any = Depends(_workspace),
) -> FileResponse:
    item = _invoke(workspace.get_source_original, str(source_id))
    return FileResponse(
        item["path"],
        media_type=item["mime_type"],
        filename=item["filename"],
    )


@router.post("/sources/{source_id}/chat-analysis")
def analyze_chat_source(
    source_id: UUID,
    payload: ChatAnalysisCreate,
    request: Request,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    item = _invoke(workspace.get_record, str(source_id))
    source = item["record"]
    if source.get("entity_type") != "source":
        raise ApiError(422, "validation_error", "只能分析原始材料。")
    text = item["body"]
    if not isinstance(text, str) or not text.strip():
        raise ApiError(
            422,
            "chat_text_unavailable",
            "这份材料没有可分析的文本；截图需先确认转写。",
            {"source_id": str(source_id)},
        )
    try:
        messages = parse_chat_messages(text)
        analysis = build_chat_analysis(source, text, messages)
    except ValueError as error:
        raise ApiError(
            422,
            "chat_analysis_unavailable",
            str(error),
            {"source_id": str(source_id)},
        ) from error

    if payload.engine != "local_demo" and not payload.material_scope_confirmed:
        raise ApiError(
            422,
            "material_scope_not_confirmed",
            "请先确认本次只分析这一份原始材料。",
            {"source_id": str(source_id)},
        )

    if payload.engine == "local_demo":
        return {
            "analysis": analysis,
            "execution": {
                "engine": "local_demo",
                "profile_id": "local_demo",
                "data_destination": "local_only",
                "degraded": False,
                "degraded_reason": None,
            },
        }

    degraded = False
    degraded_reason: str | None = None
    try:
        adapter = _analysis_adapter(
            request,
            payload.engine,
            payload.profile_id,
        )
        topics = adapter.run_chat_topics(
            str(source_id),
            model_message_payload(messages),
        )
        analysis = build_chat_analysis(
            source,
            text,
            messages,
            topic_result=topics,
        )
    except (CliExecutionError, OSError, ValueError) as error:
        degraded = True
        degraded_reason = (
            _degraded_reason(error)
            if isinstance(error, (CliExecutionError, OSError))
            else "analysis_limit"
        )
    return {
        "analysis": analysis,
        "execution": {
            "engine": payload.engine,
            "profile_id": payload.profile_id,
            "data_destination": (
                "local_only"
                if degraded
                else "configured_api_endpoint"
                if payload.engine == "api"
                else "selected_cli_process"
            ),
            "degraded": degraded,
            "degraded_reason": degraded_reason,
        },
    }


@router.post(
    "/screenshot-recognition-jobs",
    status_code=status.HTTP_202_ACCEPTED,
)
def create_screenshot_recognition_job(
    payload: ScreenshotRecognitionCreate,
    request: Request,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        request.app.state.screenshot_jobs.submit,
        workspace,
        _ids(payload.source_ids),
        payload.engine,
        payload.profile_id,
    )


@router.get("/screenshot-recognition-jobs/{job_id}")
def get_screenshot_recognition_job(
    job_id: UUID,
    request: Request,
) -> dict[str, object]:
    return _invoke(request.app.state.screenshot_jobs.get, str(job_id))


@router.delete("/screenshot-recognition-jobs/{job_id}")
def cancel_screenshot_recognition_job(
    job_id: UUID,
    request: Request,
) -> dict[str, object]:
    return _invoke(request.app.state.screenshot_jobs.cancel, str(job_id))


@router.get("/evidence")
def list_evidence(workspace: Any = Depends(_workspace)) -> dict[str, list[dict[str, object]]]:
    return {"items": _invoke(workspace.list_entities, "evidence")}


@router.post("/evidence", status_code=status.HTTP_201_CREATED)
def create_evidence(
    payload: EvidenceCreate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(
        workspace.create_evidence,
        str(payload.source_id),
        payload.quote,
        payload.locator.model_dump(),
        payload.evidence_kind,
        payload.reliability,
        _ids(payload.person_ids),
        _ids(payload.event_ids),
    )


@router.get("/reports")
def list_reports(workspace: Any = Depends(_workspace)) -> dict[str, list[dict[str, object]]]:
    return {"items": _invoke(workspace.list_entities, "report")}


@router.get("/report-advisor/suggestions/{person_id}")
def report_advisor_suggestions(
    person_id: UUID,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    person = _invoke(workspace.get_entity, str(person_id), "person")
    return {
        "person_id": str(person_id),
        "items": suggested_prompts(str(person.get("relation_to_user", ""))),
    }


@router.post("/report-advisor/preview")
def preview_report_advisor(
    payload: ReportAdvisorCreate,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    person_id = str(payload.person_id)
    person = _invoke(workspace.get_entity, person_id, "person")
    evidence = [
        item
        for item in _invoke(workspace.list_entities, "evidence")
        if person_id in item.get("person_ids", [])
    ]
    return advise_report(
        person,
        evidence,
        payload.request_text,
        set(_ids(payload.evidence_ids)),
        payload.template_family,
        payload.template_variant,
    )


@router.get("/reports/{topic_id}/versions")
def report_versions(
    topic_id: UUID,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return {"items": _invoke(workspace.get_report_versions, str(topic_id))}


@router.post("/reports", status_code=status.HTTP_201_CREATED)
def create_report(
    payload: ReportCreate,
    request: Request,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    if payload.topic_id:
        topic = _invoke(workspace.get_entity, str(payload.topic_id), "report_topic")
        if topic["revision"] != payload.expected_revision:
            raise ApiError(409, "workspace_conflict", "报告已更新，请刷新后再生成新版本。")
        if (
            topic["template_family"] != payload.template_family
            or topic.get("template_variant", payload.template_variant) != payload.template_variant
        ):
            raise ApiError(422, "validation_error", "更新报告需沿用同一主题的分析类型。")
    person_ids = _ids(payload.person_ids)
    evidence_ids = _ids(payload.evidence_ids)
    selected_evidence = _select_evidence(workspace, evidence_ids)
    input_context = _invoke(workspace.report_analysis_context, evidence_ids)
    analysis_question = payload.analysis_question or payload.title
    selected_ids = set(evidence_ids)
    review_feedback_by_key = {}
    for person_id in person_ids:
        person_record = _invoke(workspace.get_entity, person_id, "person")
        for entry in person_record.get("profile_sections", []):
            linked = set(entry.get("evidence_ids", []))
            if (entry.get("origin") == "ai" and entry.get("label") == "AI 候选描述"
                    and linked and linked.issubset(selected_ids)):
                review_feedback_by_key[(person_id, entry["value"], tuple(sorted(linked)))] = {
                    "description": entry["value"], "user_review": entry.get("confirmation_status", "unknown")}
    review_feedback = list(review_feedback_by_key.values())
    if review_feedback:
        analysis_question += ("\n补充核对（用户陈述，非独立核实，不覆盖原文；退回项不当作事实）：\n"
                              + json.dumps(review_feedback[-30:], ensure_ascii=False))
    relation_labels = [
        str(_invoke(workspace.get_entity, person_id, "person")["relation_to_user"])
        for person_id in person_ids
    ]
    engine = payload.engine or "safe_placeholder"
    source_scope = list(dict.fromkeys(str(item["source_id"]) for item in selected_evidence))
    degraded = False
    degraded_reason: str | None = None
    generation_kind = engine

    if engine == "safe_placeholder":
        profile_id = "safe_placeholder"
        data_destination = "local_only"
        analysis = build_safe_placeholder(selected_evidence)
    else:
        profile_id = payload.profile_id or "inherited"
        data_destination = "configured_api_endpoint" if engine == "api" else "selected_cli_process"
        try:
            adapter = _analysis_adapter(request, engine, profile_id)
            analysis = adapter.run(
                selected_evidence,
                analysis_question=analysis_question,
                template_family=payload.template_family,
                template_variant=payload.template_variant,
                relation_labels=relation_labels,
            )
        except (CliExecutionError, OSError) as error:
            degraded = True
            degraded_reason = _degraded_reason(error)
            generation_kind = "safe_placeholder"
            data_destination = "local_only"
            analysis = build_safe_placeholder(selected_evidence)

    if request.app.state.workspace is not workspace:
        raise ApiError(409, "workspace_changed", "工作区已切换，未保存旧报告。")
    report = _invoke(
        workspace.create_report,
        payload.title,
        payload.template_family,
        payload.template_variant,
        person_ids,
        evidence_ids,
        analysis,
        generation_kind=generation_kind,
        analysis_question=analysis_question,
        topic_id=str(payload.topic_id) if payload.topic_id else None,
        expected_revision=payload.expected_revision,
        include_charts=payload.include_charts,
        expected_context=input_context,
    )
    report["execution"] = {
        "engine": engine,
        "profile_id": profile_id,
        "material_scope": source_scope,
        "data_destination": data_destination,
        "degraded": degraded,
        "degraded_reason": degraded_reason,
    }
    return report


@router.get("/reports/snapshots/{snapshot_id}/assets/{name}")
def get_report_asset(snapshot_id: UUID, name: str, workspace: Any = Depends(_workspace)):
    item = _invoke(workspace.get_report_asset, str(snapshot_id), name)
    return FileResponse(
        item["path"],
        media_type=item["mime_type"],
        filename=item["filename"],
        content_disposition_type="inline" if item["mime_type"] == "image/png" else "attachment",
    )


@router.get("/records/{record_id}")
def get_record(
    record_id: UUID,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    return _invoke(workspace.get_record, str(record_id))


@router.post("/assistant/answer")
def answer_question(
    payload: AssistantQuestion,
    request: Request,
    workspace: Any = Depends(_workspace),
) -> dict[str, object]:
    person_id = str(payload.person_id)
    person = _invoke(workspace.get_entity, person_id, "person")
    selected_ids = list(dict.fromkeys(_ids(payload.source_ids)))
    sources = []
    total_bytes = 0
    for source_id in selected_ids:
        source = _invoke(workspace.get_entity, source_id, "source")
        if person_id not in source.get("person_ids", []):
            raise ApiError(422, "material_scope_mismatch", "材料不属于当前人物。")
        original = _invoke(workspace.get_source_original, source_id)
        path = Path(original["path"])
        size = path.stat().st_size
        total_bytes += size
        if total_bytes > 200_000:
            raise ApiError(422, "material_scope_too_large", "材料太长，请减少本次选择。")
        if source.get("source_kind") == "screenshot":
            raise ApiError(422, "unsupported_material", "图片请先转成文字。")
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise ApiError(422, "unsupported_material", "本次只支持文字材料。") from error
        sources.append(
            {
                "id": source_id,
                "title": source["title"],
                "created_at": source["created_at"],
                "text": text,
            }
        )
    evidence = [
        item
        for item in _invoke(workspace.list_entities, "evidence")
        if item["source_id"] in selected_ids and person_id in item["person_ids"]
    ]
    # The client chooses the person and source IDs. The model cannot widen that scope.
    context = {
        "question": payload.question,
        "person": person,
        "sources": sources,
        "evidence": evidence,
    }
    try:
        adapter = _analysis_adapter(request, payload.engine, payload.profile_id)
        result = adapter.answer_workspace_question(context)
    except (CliExecutionError, OSError) as error:
        raise ApiError(503, "assistant_unavailable", "暂时无法连接模型，请到设置检查。") from error
    return {**result, "person_id": person_id}
