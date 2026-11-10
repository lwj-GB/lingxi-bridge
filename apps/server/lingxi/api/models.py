from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, SecretStr, model_validator

ProfileSection = Literal[
    "basic_info",
    "appearance_style",
    "preferences",
    "habits",
    "important_experiences",
    "works_expression",
    "social_content",
    "interactions",
    "user_observations",
]
ReportFamily = Literal["person_long_term", "relation", "recent_change", "special"]
ReportVariant = Literal[
    "overview",
    "preferences_habits",
    "experiences_values",
    "romantic",
    "family_parent",
    "mentor_collaboration",
    "friend_social",
    "other",
    "recent_state",
    "gift_advice",
    "communication_prep",
    "conflict_review",
    "behavior_interpretation",
    "custom",
]

REPORT_VARIANTS: dict[str, set[str]] = {
    "person_long_term": {"overview", "preferences_habits", "experiences_values"},
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

DEFAULT_REPORT_VARIANTS: dict[str, str] = {
    "person_long_term": "overview",
    "relation": "other",
    "recent_change": "recent_state",
    "special": "custom",
}

TemplateCategory = Literal[
    "general",
    "romantic",
    "family",
    "education",
    "friendship",
    "workplace",
    "professional_support",
]
TemplateText = Annotated[str, Field(min_length=1, max_length=240)]


class OpenWorkspaceRequest(BaseModel):
    path: str = Field(min_length=1)


class PersonCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    relation_to_user: str = Field(min_length=1, max_length=120)


class PersonUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    relation_to_user: str | None = Field(default=None, min_length=1, max_length=120)

    @model_validator(mode="after")
    def at_least_one_field(self) -> "PersonUpdate":
        if self.display_name is None and self.relation_to_user is None:
            raise ValueError("at least one person field must be provided")
        return self


class ReportAdvisorCreate(BaseModel):
    person_id: UUID
    request_text: str = Field(min_length=1, max_length=4000)
    evidence_ids: list[UUID] = Field(default_factory=list)
    template_family: ReportFamily | None = None
    template_variant: ReportVariant | None = None

    @model_validator(mode="after")
    def explicit_template_is_complete_and_valid(self) -> "ReportAdvisorCreate":
        if (self.template_family is None) != (self.template_variant is None):
            raise ValueError("template_family and template_variant must be provided together")
        if (
            self.template_family is not None
            and self.template_variant not in REPORT_VARIANTS[self.template_family]
        ):
            raise ValueError("template_variant does not belong to template_family")
        return self


class PersonInterviewAnswer(BaseModel):
    question: str = Field(min_length=1, max_length=240)
    answer: str = Field(min_length=1, max_length=4000)
    status: Literal["answered", "unknown"] = "answered"


class PersonInterviewAttachment(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    text: str = Field(min_length=1, max_length=5 * 1024 * 1024)


class PersonInterviewCreate(BaseModel):
    request_id: UUID
    answers: list[PersonInterviewAnswer] = Field(default_factory=list, max_length=24)
    attachments: list[PersonInterviewAttachment] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def has_material(self) -> "PersonInterviewCreate":
        if not self.answers and not self.attachments:
            raise ValueError("no interview material")
        return self


class ProfileEntryCreate(BaseModel):
    section: ProfileSection
    label: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=4000)
    evidence_ids: list[UUID] = Field(default_factory=list)
    origin: Literal["user", "ai"] = "user"
    confirmation_status: Literal["candidate", "confirmed", "rejected"] = "confirmed"


class EventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    occurred_at: str = Field(min_length=1)
    person_ids: list[UUID] = Field(min_length=1)
    location: str = Field(default="", max_length=400)
    summary: str = Field(default="", max_length=20000)


class EventUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    occurred_at: str | None = Field(default=None, min_length=1)
    person_ids: list[UUID] | None = Field(default=None, min_length=1)
    location: str | None = Field(default=None, max_length=400)
    summary: str | None = Field(default=None, max_length=20000)
    expected_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def at_least_one_event_field(self) -> "EventUpdate":
        if all(
            getattr(self, name) is None
            for name in ("title", "occurred_at", "person_ids", "location", "summary")
        ):
            raise ValueError("at least one event field must be provided")
        return self


class EventAnalysisCreate(BaseModel):
    source_ids: list[UUID] = Field(min_length=1, max_length=30)
    engine: Literal["api", "claude", "codex"]
    profile_id: str = Field(default="inherited", min_length=1, max_length=120)
    scope_confirmed: bool = False
    expected_revision: int | None = Field(default=None, ge=1)


class EventNodeUpdate(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    expected_revision: int | None = Field(default=None, ge=1)


class TextSourceCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    text: str
    source_kind: Literal["text", "markdown", "chat_export", "user_observation"]
    person_ids: list[UUID] = Field(min_length=1)
    event_ids: list[UUID] = Field(default_factory=list)


class ProfileAutofillPreviewCreate(BaseModel):
    text: str = Field(min_length=1, max_length=2_000_000)
    engine: Literal["local_demo", "claude", "codex", "api"] = "local_demo"
    profile_id: str = Field(default="inherited", min_length=1, max_length=120)


class ChatAnalysisCreate(BaseModel):
    engine: Literal["local_demo", "claude", "codex", "api"] = "local_demo"
    profile_id: str = Field(default="inherited", min_length=1, max_length=120)
    material_scope_confirmed: bool = False


class EvidenceLocator(BaseModel):
    kind: Literal["text_quote"]
    start: int = Field(ge=0)
    end: int = Field(ge=1)

    @model_validator(mode="after")
    def end_is_after_start(self) -> "EvidenceLocator":
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class ScreenshotSegmentConfirm(BaseModel):
    order: int = Field(ge=0)
    speaker: Literal["me", "other", "unknown"]
    text: str = Field(min_length=1, max_length=4000)
    uncertainty: Literal["low", "medium", "high"]


class ScreenshotTranscriptConfirm(BaseModel):
    segments: list[ScreenshotSegmentConfirm] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def orders_are_unique(self) -> "ScreenshotTranscriptConfirm":
        orders = [segment.order for segment in self.segments]
        if len(orders) != len(set(orders)):
            raise ValueError("segment orders must be unique")
        return self


class ScreenshotRecognitionCreate(BaseModel):
    source_ids: list[UUID] = Field(min_length=1, max_length=20)
    engine: Literal["claude", "codex", "api"]
    profile_id: str = Field(default="inherited", min_length=1, max_length=120)


class EvidenceCreate(BaseModel):
    source_id: UUID
    quote: str = Field(min_length=1)
    locator: EvidenceLocator
    evidence_kind: Literal[
        "direct_quote",
        "user_observation",
        "user_statement",
        "third_party_statement",
    ]
    reliability: Literal["low", "medium", "high"]
    person_ids: list[UUID] = Field(min_length=1)
    event_ids: list[UUID] = Field(default_factory=list)


class ReportCreate(BaseModel):
    include_charts: bool = False
    topic_id: UUID | None = None
    expected_revision: int | None = Field(default=None, ge=1)
    title: str = Field(min_length=1, max_length=200)
    template_family: ReportFamily
    template_variant: ReportVariant | None = None
    analysis_question: str | None = Field(default=None, min_length=1, max_length=4000)
    person_ids: list[UUID] = Field(min_length=1)
    evidence_ids: list[UUID] = Field(min_length=1)
    engine: Literal["safe_placeholder", "claude", "codex", "api"] | None = None
    profile_id: str | None = None

    @model_validator(mode="after")
    def variant_matches_family(self) -> "ReportCreate":
        if self.topic_id is not None and self.expected_revision is None:
            raise ValueError("updating a report requires expected_revision")
        if self.template_variant is None:
            self.template_variant = DEFAULT_REPORT_VARIANTS[self.template_family]
        if self.template_variant not in REPORT_VARIANTS[self.template_family]:
            raise ValueError("template_variant does not belong to template_family")
        return self


class AnalysisTemplateDefinition(BaseModel):
    id: str = Field(
        min_length=3,
        max_length=80,
        pattern=r"^[a-z0-9][a-z0-9_-]*$",
    )
    name: str = Field(min_length=1, max_length=80)
    category: TemplateCategory
    description: str = Field(min_length=1, max_length=400)
    dimensions: list[TemplateText] = Field(min_length=1, max_length=12)
    evidence_requirements: list[TemplateText] = Field(min_length=1, max_length=8)
    forbidden_conclusions: list[TemplateText] = Field(min_length=1, max_length=8)
    template_family: ReportFamily
    template_variant: ReportVariant
    default_question: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def variant_matches_family(self) -> "AnalysisTemplateDefinition":
        if self.template_variant not in REPORT_VARIANTS[self.template_family]:
            raise ValueError("template_variant does not belong to template_family")
        return self


class AnalysisTemplatesUpdate(BaseModel):
    active_template_id: str = Field(min_length=3, max_length=80)
    custom_templates: list[AnalysisTemplateDefinition] = Field(
        default_factory=list,
        max_length=50,
    )
    expected_hash: str | None = Field(
        default=None,
        min_length=64,
        max_length=64,
        pattern=r"^[a-f0-9]{64}$",
    )

    @model_validator(mode="after")
    def template_ids_are_unique(self) -> "AnalysisTemplatesUpdate":
        ids = [item.id for item in self.custom_templates]
        if len(ids) != len(set(ids)):
            raise ValueError("custom template ids must be unique")
        return self


class AssistantQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=20000)
    person_id: UUID
    source_ids: list[UUID] = Field(default_factory=list, max_length=100)
    engine: Literal["claude", "codex", "api"]
    profile_id: Literal["inherited"] = "inherited"


class DirectModelConfigure(BaseModel):
    base_url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    api_key: SecretStr | None = Field(default=None, repr=False)
    key_env: str = Field(default="", max_length=200)
    clear_key: bool = False
