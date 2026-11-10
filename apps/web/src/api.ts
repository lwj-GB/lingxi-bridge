export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8765/api";

export type Id = string;

export const PROFILE_SECTIONS = [
  "basic_info",
  "appearance_style",
  "preferences",
  "habits",
  "important_experiences",
  "works_expression",
  "social_content",
  "interactions",
  "user_observations",
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

export interface ProfileEntry {
  id: Id;
  section: ProfileSection;
  label: string;
  value: string;
  origin: "user" | "ai";
  confirmation_status: "candidate" | "confirmed" | "rejected";
  evidence_ids: Id[];
}

export interface Person {
  schema_version: "0.1";
  entity_type: "person";
  id: Id;
  revision: number;
  created_at: string;
  updated_at: string;
  display_name: string;
  relation_to_user: string;
  profile_sections?: ProfileEntry[];
}

export interface EventRecord {
  schema_version: "0.1";
  entity_type: "event";
  id: Id;
  revision: number;
  created_at: string;
  updated_at: string;
  title: string;
  occurred_at: string;
  person_ids: Id[];
  source_ids: Id[];
  location?: string;
  summary?: string;
  analysis?: {
    schema_version: "0.1";
    generated_at: string;
    engine: "api" | "claude" | "codex";
    event_revision: number;
    source_ids: Id[];
    source_hashes: Record<Id, string>;
    source_text_hashes: Record<Id, string>;
    summary: string;
    nodes: Array<{
      id: Id;
      label: string;
      source_id: Id;
      quote: string;
      quote_start: number;
      quote_end: number;
      timestamp_ms?: number;
      status: "candidate";
    }>;
  };
}

export type SourceKind =
  | "text"
  | "markdown"
  | "file"
  | "chat_export"
  | "user_observation"
  | "screenshot";

export interface SourceRecord {
  schema_version: "0.1";
  entity_type: "source";
  id: Id;
  revision: number;
  created_at: string;
  updated_at: string;
  title: string;
  source_kind: SourceKind;
  original_path: string;
  sha256: string;
  person_ids: Id[];
  event_ids: Id[];
  mime_type?: string;
  byte_size?: number;
  batch_id?: Id;
  sequence_index?: number;
  processing_status?: "pending_confirmation" | "confirmed";
  transcript_id?: Id;
}

export interface TextQuoteLocator {
  kind: "text_quote";
  start: number;
  end: number;
}

export interface ScreenshotSegmentLocator {
  kind: "screenshot_segment";
  transcript_id: Id;
  segment_id: Id;
  start: number;
  end: number;
}

export interface EvidenceRecord {
  schema_version: "0.1";
  entity_type: "evidence";
  id: Id;
  revision: number;
  created_at: string;
  updated_at: string;
  source_id: Id;
  quote: string;
  locator: TextQuoteLocator | ScreenshotSegmentLocator;
  evidence_kind:
    | "direct_quote"
    | "user_observation"
    | "user_statement"
    | "third_party_statement";
  reliability: "low" | "medium" | "high";
  person_ids: Id[];
  event_ids: Id[];
}

export interface ReportTopic {
  schema_version: "0.1";
  entity_type: "report_topic";
  id: Id;
  revision: number;
  created_at: string;
  updated_at: string;
  title: string;
  template_family:
    | "person_long_term"
    | "relation"
    | "recent_change"
    | "special";
  template_variant?: ReportVariant;
  analysis_question?: string;
  person_ids: Id[];
  current_snapshot_id: Id;
  snapshot_count: number;
  status: "draft" | "confirmed";
}

export interface ReportSnapshot {
  schema_version: "0.1";
  entity_type: "report_snapshot";
  id: Id;
  revision: 1;
  created_at: string;
  updated_at: string;
  topic_id: Id;
  version: number;
  generation_kind: "safe_placeholder" | "claude" | "codex" | "api" | "manual";
  evidence_ids: Id[];
  charts?: {
    manifest_path: string;
    frequency_mode: "daily" | "speaker_totals";
    source_ids: Id[];
    missing_information: string[];
    assets: Array<{ name: string; title: string; sha256: string; mime_type: string; kind: "image" | "data" | "script" | "manifest" }>;
  };
}

export interface AnalysisClaim {
  claim_type: "observation" | "hypothesis" | "unknown" | "suggestion";
  text: string;
  evidence_ids: Id[];
  uncertainty?: "low" | "medium" | "high";
  alternatives?: string[];
}

export interface AnalysisOutput {
  report_markdown?: string;
  schema_version: "0.1";
  material_scope: Id[];
  claims: AnalysisClaim[];
}

export interface ExecutorStatus {
  engine: "claude" | "codex";
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
  degraded_reason: string | null;
}

export interface ExecutionSummary {
  engine: "safe_placeholder" | "claude" | "codex" | "api";
  profile_id: string;
  material_scope: Id[];
  data_destination: "local_only" | "selected_cli_process" | "configured_api_endpoint";
  degraded: boolean;
  degraded_reason: string | null;
}

export interface ProfileAutofillCandidate {
  section: ProfileSection;
  label: string;
  value: string;
  quote: string;
  start: number;
  end: number;
  confidence: "low" | "medium" | "high";
}

export interface ProfileAutofillPreview {
  schema_version: "0.1";
  person: {
    display_name: string | null;
    relation_to_user: string | null;
  };
  candidates: ProfileAutofillCandidate[];
  skipped_sections: ProfileSection[];
}

export interface ProfileAutofillResponse {
  preview: ProfileAutofillPreview;
  execution: {
    engine: "local_demo" | "claude" | "codex" | "api";
    profile_id: string;
    data_destination: "local_only" | "selected_cli_process" | "configured_api_endpoint";
  };
}

export interface ReportResponse {
  topic: ReportTopic;
  snapshot: ReportSnapshot;
  analysis: AnalysisOutput;
  execution: ExecutionSummary;
}

export interface ReportListItem {
  topic: ReportTopic;
  snapshot: ReportSnapshot;
  analysis?: AnalysisOutput;
  execution?: ExecutionSummary;
}

export interface ReportAdvisorResponse {
  status: "ready" | "needs_input";
  reply: string;
  proposed_report: {
    title: string;
    template_family: ReportTopic["template_family"];
    template_variant: ReportVariant;
    analysis_question: string;
  };
  evidence_ids: Id[];
  questions: string[];
  recommended_materials: string[];
}

export interface ChatAnalysisReference {
  message_index: number;
  start: number;
  end: number;
  quote: string;
}

export interface ChatAnalysisResponse {
  analysis: {
    schema_version: "0.1";
    source: {
      id: Id;
      title: string;
      sha256: string;
      source_kind: SourceKind;
    };
    topic_method: "local_frequency_clues" | "cli_assisted";
    metrics: {
      characters: number;
      non_whitespace_characters: number;
      lines: number;
      messages: number;
      participants: number;
      timestamped_messages: number;
    };
    top_terms: Array<{
      term: string;
      count: number;
      message_count: number;
      message_share: number;
    }>;
    speakers: Array<{
      name: string;
      message_count: number;
      message_share: number;
    }>;
    time_buckets: Array<{
      label: string;
      message_count: number;
      message_share: number;
    }>;
    topics: Array<{
      title: string;
      summary: string;
      keywords: string[];
      message_count: number;
      message_share: number;
      source_refs: ChatAnalysisReference[];
    }>;
    limitations: string[];
  };
  execution: {
    engine: "local_demo" | "claude" | "codex" | "api";
    profile_id: string;
    data_destination: "local_only" | "selected_cli_process" | "configured_api_endpoint";
    degraded: boolean;
    degraded_reason: string | null;
  };
}

export interface RecordResponse {
  record: Record<string, unknown>;
  relative_path: string;
  body: string;
  file_hash: string;
}

export interface WorkspaceSummary {
  path?: string;
  schema_version?: string;
  [key: string]: unknown;
}

export interface CurrentWorkspaceSummary extends WorkspaceSummary {
  open: boolean;
}

export type ReportVariant =
  | "overview"
  | "preferences_habits"
  | "experiences_values"
  | "romantic"
  | "family_parent"
  | "mentor_collaboration"
  | "friend_social"
  | "other"
  | "recent_state"
  | "gift_advice"
  | "communication_prep"
  | "conflict_review"
  | "behavior_interpretation"
  | "custom";

export type AnalysisTemplateCategory =
  | "general"
  | "romantic"
  | "family"
  | "education"
  | "friendship"
  | "workplace"
  | "professional_support";

export interface AnalysisTemplate {
  id: string;
  name: string;
  category: AnalysisTemplateCategory;
  description: string;
  dimensions: string[];
  evidence_requirements: string[];
  forbidden_conclusions: string[];
  template_family: ReportTopic["template_family"];
  template_variant: ReportVariant;
  default_question: string;
  source: "built_in" | "custom";
}

export interface AnalysisTemplatesResponse {
  schema_version: "0.1";
  active_template_id: string;
  custom_templates: Array<Omit<AnalysisTemplate, "source">>;
  items: AnalysisTemplate[];
  relative_path: string;
  file_hash: string | null;
}

export interface ScreenshotSegmentInput {
  order: number;
  speaker: "me" | "other" | "unknown";
  text: string;
  uncertainty: "low" | "medium" | "high";
}

export interface ScreenshotSegment extends ScreenshotSegmentInput {
  segment_id: Id;
}

export interface ScreenshotTranscript {
  schema_version: "0.1";
  entity_type: "screenshot_transcript";
  id: Id;
  revision: number;
  created_at: string;
  updated_at: string;
  source_id: Id;
  status: "confirmed";
  segments: ScreenshotSegment[];
  person_ids: Id[];
  event_ids: Id[];
}

export interface ScreenshotBatchResponse {
  batch_id: Id;
  items: SourceRecord[];
}

export interface ScreenshotConfirmationResponse {
  source: SourceRecord;
  transcript: ScreenshotTranscript;
  evidence: EvidenceRecord[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    const isFormData =
      typeof FormData !== "undefined" && init?.body instanceof FormData;
    if (!isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new ApiError(
      "无法连接本地服务，请确认 8765 端口上的服务已经启动。",
      0,
      "service_unreachable",
    );
  }

  const body = (await response.json().catch(() => null)) as
    | {
        error?: {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
      }
    | T
    | null;

  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body ? body.error : undefined;
    throw new ApiError(
      error?.message ?? `本地服务返回 ${response.status}`,
      response.status,
      error?.code ?? "request_failed",
      error?.details,
    );
  }
  return body as T;
}

const json = (value: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(value),
});

const SCREENSHOT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SCREENSHOT_SIZE = 15 * 1024 * 1024;
const MAX_SCREENSHOT_BATCH_SIZE = 100 * 1024 * 1024;

export function validateScreenshotFiles(files: File[]) {
  if (files.length < 1 || files.length > 20) {
    throw new ApiError(
      "一次只能选择 1 到 20 张截图。",
      422,
      "screenshot_count_out_of_range",
      { count: files.length },
    );
  }
  const unsupported = files.find((file) => !SCREENSHOT_TYPES.has(file.type));
  if (unsupported) {
    throw new ApiError(
      `不支持截图格式：${unsupported.name}`,
      422,
      "unsupported_screenshot_type",
      { filename: unsupported.name, content_type: unsupported.type },
    );
  }
  const oversized = files.find((file) => file.size > MAX_SCREENSHOT_SIZE);
  if (oversized) {
    throw new ApiError(
      `单张截图不能超过 15 MiB：${oversized.name}`,
      422,
      "screenshot_size_out_of_range",
      { filename: oversized.name, byte_size: oversized.size },
    );
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_SCREENSHOT_BATCH_SIZE) {
    throw new ApiError(
      "一批截图总大小不能超过 100 MiB。",
      422,
      "screenshot_batch_too_large",
      { byte_size: total },
    );
  }
}

export interface DirectModelSettings {
  base_url: string; model: string; key_env: string; has_key: boolean;
  configured: boolean; key_storage: "session" | "environment" | "none";
}

export const api = {
  getPlottingCapabilities: () => request<{ available: boolean; reason?: string; r_version?: string; ggplot2_version?: string }>("/plotting/capabilities"),
  getReportDocument: (snapshotId: Id) => request<{body: string; is_editable_copy: boolean; source_snapshot_id: Id; workspace_path: string; relative_path: string; file_hash: string}>(`/reports/snapshots/${encodeURIComponent(snapshotId)}/document`),
  reportDownloadUrl: (snapshotId: Id, format: "pdf" | "markdown") => `${API_BASE_URL}/reports/snapshots/${encodeURIComponent(snapshotId)}/${format}`,
  getReportFile: (snapshotId: Id) => request<{workspace_path: string; relative_path: string}>(`/reports/snapshots/${encodeURIComponent(snapshotId)}/file`),
  reportAssetUrl: (snapshotId: Id, name: string) => `${API_BASE_URL}/reports/snapshots/${encodeURIComponent(snapshotId)}/assets/${encodeURIComponent(name)}`,
  getDirectModelSettings: () => request<DirectModelSettings>("/model-settings"),
  configureDirectModel: (input: { base_url: string; model: string; api_key?: string; key_env?: string; clear_key?: boolean }) => request<DirectModelSettings>("/model-settings", json(input)),
  testDirectModel: () => request<{ok: boolean; model: string}>("/model-settings/test", json({})),
  createAssistantPerson: (input: {
    text: string; preview: ProfileAutofillPreview; display_name: string;
    relation_to_user: string; request_id: string;
  }) => request<{ person: Person; replayed: boolean }>("/assistant/people", json(input)),
  answerQuestion: (input: {
    question: string; person_id: Id; source_ids: Id[];
    engine: "claude" | "codex" | "api";
  }) => request<{ answer: string; source_ids: Id[]; person_id: Id }>(
    "/assistant/answer", json(input),
  ),
  openWorkspace: (path: string) =>
    request<WorkspaceSummary>("/workspaces/open", json({ path })),
  currentWorkspace: () =>
    request<CurrentWorkspaceSummary>("/workspaces/current"),
  refreshWorkspace: () =>
    request<WorkspaceSummary>("/workspaces/refresh", json({})),
  workspaceExportUrl: () => `${API_BASE_URL}/workspaces/export`,
  getAnalysisTemplates: () =>
    request<AnalysisTemplatesResponse>("/analysis-templates"),
  updateAnalysisTemplates: (input: {
    active_template_id: string;
    custom_templates: Array<Omit<AnalysisTemplate, "source">>;
    expected_hash: string | null;
  }) =>
    request<AnalysisTemplatesResponse>(
      "/analysis-templates",
      json(input, "PUT"),
    ),
  listPeople: () => request<{ items: Person[] }>("/people"),
  createPerson: (display_name: string, relation_to_user: string) =>
    request<Person>("/people", json({ display_name, relation_to_user })),
  updatePerson: (
    personId: Id,
    input: { display_name?: string; relation_to_user?: string },
  ) =>
    request<Person>(
      `/people/${encodeURIComponent(personId)}`,
      json(input, "PATCH"),
    ),
  previewProfileAutofill: (input: {
    text: string;
    engine: "local_demo" | "claude" | "codex" | "api";
    profile_id?: string;
  }) =>
    request<ProfileAutofillResponse>(
      "/profile-autofill/preview",
      json(input),
    ),
  savePersonInterview: (personId: Id, input: { request_id: string; answers: {question: string; answer: string; status: "answered" | "unknown"}[]; attachments: {name: string; text: string}[] }) => request<{sources: SourceRecord[]; replayed: boolean}>(`/people/${encodeURIComponent(personId)}/interview`, json(input)),
  addProfileEntry: (
    personId: Id,
    input: {
      section: ProfileSection;
      label: string;
      value: string;
      evidence_ids: Id[];
      origin?: ProfileEntry["origin"];
      confirmation_status?: ProfileEntry["confirmation_status"];
    },
  ) =>
    request<Person>(
      `/people/${encodeURIComponent(personId)}/profile-entries`,
      json(input),
    ),
  listEvents: () => request<{ items: EventRecord[] }>("/events"),
  createEvent: (input: {
    title: string;
    occurred_at: string;
    person_ids: Id[];
    location?: string;
    summary?: string;
  }) => request<EventRecord>("/events", json(input)),
  updateEvent: (id: Id, input: {
    title?: string;
    occurred_at?: string;
    person_ids?: Id[];
    location?: string;
    summary?: string;
    expected_revision?: number;
  }) => request<EventRecord>(`/events/${id}`, json(input, "PATCH")),
  analyzeEvent: (id: Id, input: {
    source_ids: Id[];
    engine: "api" | "claude" | "codex";
    profile_id?: string;
    scope_confirmed: boolean;
    expected_revision?: number;
  }) => request<EventRecord>(`/events/${encodeURIComponent(id)}/analysis`, json(input)),
  updateEventNodeLabel: (id: Id, nodeId: Id, input: {
    label: string;
    expected_revision?: number;
  }) => request<EventRecord>(
    `/events/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}`,
    json(input, "PATCH"),
  ),
  listSources: () => request<{ items: SourceRecord[] }>("/sources"),
  importText: (input: {
    title: string;
    text: string;
    source_kind: SourceKind;
    person_ids: Id[];
    event_ids: Id[];
  }) => request<SourceRecord>("/sources/text", json(input)),
  uploadScreenshotBatch: (input: {
    title: string;
    person_ids: Id[];
    event_ids: Id[];
    files: File[];
  }) => {
    validateScreenshotFiles(input.files);
    const body = new FormData();
    body.set("title", input.title);
    body.set("person_ids", JSON.stringify(input.person_ids));
    body.set("event_ids", JSON.stringify(input.event_ids));
    input.files.forEach((file) => body.append("files", file, file.name));
    return request<ScreenshotBatchResponse>("/screenshot-batches", {
      method: "POST",
      body,
    });
  },
  sourceOriginalUrl: (sourceId: Id) =>
    `${API_BASE_URL}/sources/${encodeURIComponent(sourceId)}/original`,
  analyzeChatSource: (
    sourceId: Id,
    input: {
      engine: "local_demo" | "claude" | "codex" | "api";
      profile_id?: string;
      material_scope_confirmed?: boolean;
    },
  ) =>
    request<ChatAnalysisResponse>(
      `/sources/${encodeURIComponent(sourceId)}/chat-analysis`,
      json(input),
    ),
  confirmScreenshotTranscript: (
    sourceId: Id,
    segments: ScreenshotSegmentInput[],
  ) =>
    request<ScreenshotConfirmationResponse>(
      `/sources/${encodeURIComponent(sourceId)}/transcript`,
      json({ segments }, "PUT"),
    ),
  listEvidence: () => request<{ items: EvidenceRecord[] }>("/evidence"),
  createEvidence: (input: {
    source_id: Id;
    quote: string;
    locator: EvidenceRecord["locator"];
    evidence_kind: EvidenceRecord["evidence_kind"];
    reliability: EvidenceRecord["reliability"];
    person_ids: Id[];
    event_ids: Id[];
  }) => request<EvidenceRecord>("/evidence", json(input)),
  listReports: () => request<{ items: ReportListItem[] }>("/reports"),
  listReportVersions: (topicId: Id) =>
    request<{ items: ReportListItem[] }>(`/reports/${encodeURIComponent(topicId)}/versions`),
  getReportSuggestions: (personId: Id) =>
    request<{ person_id: Id; items: string[] }>(
      `/report-advisor/suggestions/${encodeURIComponent(personId)}`,
    ),
  previewReportAdvisor: (input: {
    person_id: Id;
    request_text: string;
    evidence_ids?: Id[];
    template_family?: ReportTopic["template_family"];
    template_variant?: ReportVariant;
  }) =>
    request<ReportAdvisorResponse>(
      "/report-advisor/preview",
      json(input),
    ),
  createReport: (input: {
    include_charts?: boolean;
    topic_id?: Id;
    expected_revision?: number;
    title: string;
    template_family: ReportTopic["template_family"];
    template_variant: ReportVariant;
    analysis_question?: string;
    person_ids: Id[];
    evidence_ids: Id[];
    engine?: string;
    profile_id?: string;
  }) => request<ReportResponse>("/reports", json(input)),
  getRecord: (id: Id) =>
    request<RecordResponse>(`/records/${encodeURIComponent(id)}`),
  listExecutors: () => request<{ items: ExecutorStatus[] }>("/executors"),
};
