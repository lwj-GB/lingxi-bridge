from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from lingxi.api.router import _invoke, _workspace

router = APIRouter(prefix="/api")


class AssistantPersonCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    text: str = Field(min_length=1, max_length=2_000_000)
    preview: dict[str, Any]
    display_name: str = Field(min_length=1, max_length=120)
    relation_to_user: str = Field(min_length=1, max_length=120)
    request_id: UUID


@router.post("/assistant/people")
def create_assistant_person(
    payload: AssistantPersonCreate, workspace: Any = Depends(_workspace),
) -> dict:
    return _invoke(
        workspace.create_person_from_preview, payload.text, payload.preview,
        payload.display_name, payload.relation_to_user, str(payload.request_id),
    )
