import {
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  PROFILE_SECTIONS,
  api,
  validateScreenshotFiles,
  type AnalysisClaim,
  type DirectModelSettings,
  type AnalysisTemplate,
  type EventRecord,
  type EvidenceRecord,
  type ExecutorStatus,
  type Id,
  type Person,
  type ProfileAutofillResponse,
  type ProfileSection,
  type RecordResponse,
  type ReportAdvisorResponse,
  type ReportListItem,
  type ReportResponse,
  type ReportTopic,
  type ReportVariant,
  type ScreenshotSegmentInput,
  type SourceKind,
  type SourceRecord,
} from "./api";
import { ChatDataAnalysis } from "./ChatDataAnalysis";
import {
  AiWorkspace,
  type AiConversation,
} from "./AiWorkspace";
import {
  DataManagementCenter,
  DEFAULT_PREFERENCES,
  HelpCenter,
  OnboardingGuide,
  SettingsCenter,
  TopToolbar,
  UsageCenter,
  loadPreferences,
  applyAppearance,
  analysisTemplateQuestion,
  savePreferences,
  shouldShowOnboarding,
  type AppPreferences,
  type ControlView,
  type GuideTarget,
  type SettingsTab,
  type ToolbarTarget,
} from "./ControlCenter";
import { LocalRecorder } from "./LocalRecorder";
import { LiveSession, type LiveTranscriptSaveInput } from "./LiveSession";
import { PersonInterview } from "./PersonInterview";
import { ReportReview } from "./ReportReview";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { Workbench } from "./Workbench";
import { formatEventNodeTime } from "./eventTime";
import { ReportDocument } from "./ReportDocument";
import { MobilePanel } from "./MobilePanel";

const DEFAULT_WORKSPACE =
  import.meta.env.VITE_DEMO_VAULT_PATH ??
  (import.meta.env.MODE === "test" ? "/tmp/lingxi-vault-v01" : "");

type Notice = { kind: "success" | "error" | "info"; text: string } | null;
type AppView =
  | "workspace"
  | "assistant"
  | "people"
  | "events"
  | "autofill"
  | "mobile"
  | "live"
  | "reports"
  | "obsidian"
  | ControlView;
type PersonView = "profile" | "sources" | "evidence" | "events" | "reports";
type ClaimReviewState = "accepted" | "rejected";

const VIEW_COPY: Record<
  AppView,
  { label: string; icon: string; title: string; description: string }
> = {
  workspace: {
    label: "工作区",
    icon: "⌂",
    title: "打开本地工作区",
    description: "选择资料所在目录；所有原件、人物和报告默认只保存在本机。",
  },
  assistant: {
    label: "AI 工作台",
    icon: "AI",
    title: "先告诉 AI 你想完成什么",
    description:
      "AI 负责理解目标、整理任务和调用已有流程；你负责确认材料范围与最终写入。",
  },
  people: {
    label: "通讯录",
    icon: "人",
    title: "通讯录",
    description: "从联系人进入资料、事件与人工确认过的观察，不把 AI 猜测直接写成事实。",
  },
  events: { label: "事件", icon: "事", title: "事件工作区", description: "按事件整理时间、地点、参与人物与相关材料。" },
  mobile: { label: "手机", icon: "▯", title: "手机记录", description: "接收手机按日归档的原文、AI 笔记和当天统计。" },
  autofill: {
    label: "AI 自动填入",
    icon: "填",
    title: "AI 自动填入",
    description: "放入一段原始资料，先预览可核对的条目，再保存原文、人物档案与报告。",
  },
  live: {
    label: "会谈录音",
    icon: "声",
    title: "会谈录音",
    description: "录音、试听和保存本次会谈；转写工具按需展开。",
  },
  reports: {
    label: "报告",
    icon: "析",
    title: "报告",
    description: "主区阅读完整报告，右上逐题核对；生成新版本另行选择材料。",
  },
  obsidian: {
    label: "Obsidian",
    icon: "链",
    title: "Obsidian 与 AI 接入",
    description: "用 Obsidian 打开同一份本地资料，也让 Claude Code/Codex 通过受控 CLI 读写。",
  },
  settings: {
    label: "设置",
    icon: "设",
    title: "设置",
    description: "统一管理语言、外观、模型角色和本机连接。",
  },
  usage: {
    label: "使用统计",
    icon: "统",
    title: "使用统计",
    description: "查看当前工作区已经整理的资料和可回链产出。",
  },
  data: {
    label: "管理与导出",
    icon: "管",
    title: "管理与导出",
    description: "导出、迁移和管理属于你的开放资料。",
  },
  help: {
    label: "帮助",
    icon: "？",
    title: "帮助",
    description: "快速了解使用流程、资料位置和 AI 边界。",
  },
};

const PRIMARY_VIEWS: AppView[] = [
  "assistant",
  "people",
  "events",
  "autofill",
  "mobile",
  "live",
  "reports",
];
const DATA_TOOL_VIEWS: AppView[] = ["obsidian"];
const CONTROL_VIEWS: ControlView[] = ["settings", "usage", "data", "help"];
const AI_CONVERSATIONS_KEY = "lingxi.ai-conversations.v1";
const LAST_WORKSPACE_KEY = "lingxi.last-workspace.v1";
const LOCAL_API_RETRY_ATTEMPTS = 60;
const LOCAL_API_RETRY_DELAY_MS =
  import.meta.env.MODE === "test" ? 0 : 250;
const SETTINGS_TABS: SettingsTab[] = [
  "general",
  "workspace",
  "analysis",
  "templates",
  "models",
];
const APP_VIEWS: AppView[] = [
  "workspace",
  ...PRIMARY_VIEWS,
  ...DATA_TOOL_VIEWS,
  ...CONTROL_VIEWS,
];

function createConversationId() {
  return globalThis.crypto?.randomUUID?.() ?? `conversation-${Date.now()}`;
}

async function retryLocalApi<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOCAL_API_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < LOCAL_API_RETRY_ATTEMPTS) {
        await new Promise((resolveWait) =>
          window.setTimeout(resolveWait, LOCAL_API_RETRY_DELAY_MS),
        );
      }
    }
  }
  throw lastError;
}

function loadAiConversations(): AiConversation[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(AI_CONVERSATIONS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is AiConversation =>
            Boolean(
              item &&
                typeof item.id === "string" &&
                typeof item.title === "string" &&
                typeof item.prompt === "string",
            ),
        )
      : [];
  } catch {
    return [];
  }
}

function isSettingsGuideTarget(
  target: GuideTarget,
): target is `settings/${SettingsTab}` {
  return target.startsWith("settings/");
}

const VIEW_ENGLISH_LABELS: Record<AppView, string> = {
  workspace: "Workspace",
  assistant: "AI Workspace",
  people: "Contacts",
  events: "Events",
  autofill: "AI Autofill",
  mobile: "Mobile Archive",
  live: "Meeting Recording",
  reports: "AI Reports",
  obsidian: "Obsidian",
  settings: "Settings",
  usage: "Usage",
  data: "Data & Export",
  help: "Help",
};

const PERSON_VIEWS: Array<{
  value: PersonView;
  label: string;
  shortLabel: string;
}> = [
  { value: "profile", label: "人物档案", shortLabel: "档案" },
  { value: "sources", label: "原始材料", shortLabel: "材料" },
  { value: "evidence", label: "引用与证据", shortLabel: "证据" },
  { value: "events", label: "相关事件", shortLabel: "事件" },
  { value: "reports", label: "相关报告", shortLabel: "报告" },
];

const RELATION_GROUPS = [
  {
    label: "恋爱与同辈",
    items: [
      "伴侣",
      "男朋友",
      "女朋友",
      "约会对象",
      "暧昧对象 / Crush",
      "好朋友",
      "闺蜜",
      "朋友",
      "同学",
    ],
  },
  {
    label: "家庭",
    items: ["父亲", "母亲", "孩子", "兄弟姐妹", "祖辈 / 长辈", "亲戚"],
  },
  {
    label: "教育",
    items: ["大学导师", "大学老师", "中小学老师"],
  },
  {
    label: "工作",
    items: ["领导 / 上级", "同事", "下属", "合作伙伴", "客户 / 服务对象"],
  },
  {
    label: "专业支持",
    items: ["心理咨询师", "教育 / 社工人员", "其他专业人员"],
  },
  { label: "其他", items: ["其他"] },
] as const;

const RELATION_TAGS = Array.from(
  new Set(RELATION_GROUPS.flatMap((group) => group.items)),
);

const QUICK_RELATION_TAGS = [
  "伴侣",
  "朋友",
  "父亲",
  "母亲",
  "大学导师",
  "同事",
  "领导 / 上级",
] as const;

const OCCUPATION_OPTIONS = [
  "学生",
  "教师",
  "高校教师 / 导师",
  "公务员 / 事业单位人员",
  "心理咨询 / 社会工作",
  "医疗卫生",
  "企业管理",
  "专业技术",
  "自由职业",
  "退休",
] as const;

const GENDER_OPTIONS = ["女性", "男性", "其他", "不说明"] as const;

const PROFILE_SECTION_LABELS: Record<ProfileSection, string> = {
  basic_info: "基本信息",
  appearance_style: "外貌与风格",
  preferences: "偏好",
  habits: "习惯",
  important_experiences: "重要经历",
  works_expression: "作品与表达",
  social_content: "社交内容",
  interactions: "互动记录",
  user_observations: "我的观察",
};

type ReportKind =
  | "chat_analysis"
  | "personality"
  | "relationship"
  | "recent_change"
  | "communication"
  | "custom";

type ReportMode = "generate" | "read";

interface ReportKindOption {
  id: ReportKind;
  label: string;
  description: string;
  family: ReportTopic["template_family"];
  variant: ReportVariant;
  prompt: string;
}

const REPORT_KIND_OPTIONS: ReportKindOption[] = [
  {
    id: "chat_analysis",
    label: "聊天记录分析",
    description: "主题、词频、互动与原文回链",
    family: "special",
    variant: "custom",
    prompt: "整理所选聊天记录中的主题、互动事实、重复线索和仍需核对的问题。",
  },
  {
    id: "personality",
    label: "性格与习惯",
    description: "只基于可核对材料整理稳定倾向",
    family: "person_long_term",
    variant: "preferences_habits",
    prompt: "整理材料中可核对的表达习惯、偏好与行为倾向，并区分事实、假设和未知。",
  },
  {
    id: "relationship",
    label: "关系与沟通",
    description: "互动模式、边界与待澄清问题",
    family: "relation",
    variant: "friend_social",
    prompt: "整理关系中的互动事实、沟通模式、边界和需要继续澄清的问题。",
  },
  {
    id: "recent_change",
    label: "近期变化",
    description: "近期状态与变化线索",
    family: "recent_change",
    variant: "recent_state",
    prompt: "整理近期材料中出现的变化、相反证据和仍需继续观察的线索。",
  },
  {
    id: "communication",
    label: "沟通准备",
    description: "下一次交流的重点与提醒",
    family: "special",
    variant: "communication_prep",
    prompt: "为下一次沟通整理已知事实、待确认问题、可回应的重点和需要避免的误判。",
  },
  {
    id: "custom",
    label: "其他",
    description: "按你的问题自由整理",
    family: "special",
    variant: "custom",
    prompt: "围绕用户提出的问题整理所选材料，并明确事实、假设、未知和建议。",
  },
];

const REPORT_PURPOSES = [
  ["understand", "自己理解"],
  ["prepare", "沟通前准备"],
  ["review", "关系复盘"],
  ["support", "关怀与支持"],
  ["organize", "资料整理"],
] as const;

const REPORT_TIME_FOCUS = [
  ["all", "全部材料"],
  ["three_months", "最近 3 个月"],
  ["one_year", "最近 1 年"],
  ["recent_first", "近期优先"],
] as const;

const REPORT_MATERIAL_FOCUS = [
  ["facts", "原文事实优先"],
  ["balanced", "事实与变化平衡"],
  ["recent", "近期材料优先"],
] as const;

function reportKindFor(
  family: ReportTopic["template_family"],
  variant: ReportVariant | undefined,
): ReportKind {
  return (
    REPORT_KIND_OPTIONS.find(
      (item) => item.family === family && (!variant || item.variant === variant),
    )?.id ?? "custom"
  );
}

function screenshotStatus(source: SourceRecord) {
  return source.processing_status === "confirmed" ? "已确认" : "待确认";
}

function asMessage(error: unknown) {
  if (error instanceof ApiError) {
    return `${error.message}（${error.code}）`;
  }
  return error instanceof Error ? error.message : "发生未知错误";
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function utf16OffsetToCodePoint(text: string, offset: number) {
  return Array.from(text.slice(0, offset)).length;
}

function codePointOffsetToUtf16(text: string, offset: number) {
  return Array.from(text).slice(0, offset).join("").length;
}

function directQuotes(body: string, sourceKind: SourceRecord["source_kind"]) {
  const candidates: Array<{ quote: string; start: number; end: number }> = [];
  const lines = body.matchAll(/[^\r\n]+/g);
  for (const match of lines) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (
      trimmed.length < 12 ||
      trimmed.startsWith("#") ||
      trimmed === "---" ||
      trimmed.startsWith("```") ||
      /^(日期|时间|作者|来源|主题)[：:]/.test(trimmed)
    ) {
      continue;
    }
    const quote = Array.from(trimmed).slice(0, 280).join("");
    const utf16Start = (match.index ?? 0) + raw.indexOf(trimmed);
    const utf16End = utf16Start + quote.length;
    candidates.push({
      quote,
      start: utf16OffsetToCodePoint(body, utf16Start),
      end: utf16OffsetToCodePoint(body, utf16End),
    });
  }
  const limit = sourceKind === "chat_export" ? 12 : 3;
  if (candidates.length <= limit) return candidates;
  return Array.from({ length: limit }, (_, index) => {
    const position = Math.round(
      (index * (candidates.length - 1)) / (limit - 1),
    );
    return candidates[position];
  });
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function localDateTimeValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function CheckboxList<T extends { id: Id }>({
  items,
  selected,
  onChange,
  label,
  render,
}: {
  items: T[];
  selected: Id[];
  onChange: (ids: Id[]) => void;
  label: string;
  render: (item: T) => ReactNode;
}) {
  if (!items.length) {
    return <p className="empty-note">暂无{label}，请先完成上一步。</p>;
  }
  return (
    <div className="check-grid" aria-label={label}>
      {items.map((item) => (
        <label className="check-card" key={item.id}>
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, item.id]
                  : selected.filter((id) => id !== item.id),
              )
            }
          />
          <span>{render(item)}</span>
        </label>
      ))}
    </div>
  );
}

function Section({
  id,
  title,
  visible = true,
  children,
}: {
  id: string;
  title: string;
  visible?: boolean;
  children: ReactNode;
}) {
  if (!visible) return null;
  return (
    <section className="section-card" id={id}>
      <header className="section-heading">
        <div>
          <h2>{title}</h2>
        </div>
      </header>
      {children}
    </section>
  );
}

function SourceBody({
  record,
  locator,
}: {
  record: RecordResponse;
  locator?: EvidenceRecord["locator"];
}) {
  const textLocator = locator?.kind === "text_quote" ? locator : undefined;
  const codePointLength = Array.from(record.body).length;
  const valid =
    textLocator &&
    textLocator.start >= 0 &&
    textLocator.end > textLocator.start &&
    textLocator.end <= codePointLength;
  const start = valid
    ? codePointOffsetToUtf16(record.body, textLocator.start)
    : 0;
  const end = valid ? codePointOffsetToUtf16(record.body, textLocator.end) : 0;
  return (
    <>
      <div className="path-row">
        <span>工作区相对路径</span>
        <code>{record.relative_path}</code>
      </div>
      <div className="source-body" aria-label="来源原文">
        {valid ? (
          <>
            {record.body.slice(0, start)}
            <mark>{record.body.slice(start, end)}</mark>
            {record.body.slice(end)}
          </>
        ) : (
          record.body
        )}
      </div>
    </>
  );
}

function ReportView({ report, onRefresh }: {
  report: ReportResponse; onRefresh: () => Promise<void>;
}) {
  const groups = [["整体情况", "observation"], ["可能的理解", "hypothesis"], ["相处与行动建议", "suggestion"], ["仍需了解", "unknown"]] as const;
  return <article className="report-sheet" aria-label="当前报告"><header className="report-title"><div><h3>{report.topic.title}</h3><time dateTime={report.snapshot.created_at}>{formatDate(report.snapshot.created_at)}</time></div><span className="version-badge">v{report.snapshot.version}</span></header>
    {report.snapshot.generation_kind === "safe_placeholder" && <p className="report-meta">资料摘录 · 尚未生成 AI 报告</p>}
    <ReportDocument key={report.snapshot.id} snapshot={report.snapshot} title={report.topic.title} onRefresh={onRefresh} fallback={<div className="report-document">{groups.map(([title, kind]) => { const claims = report.analysis.claims.filter(claim => claim.claim_type === kind); return claims.length ? <section key={kind}><h2>{title}</h2>{claims.map((claim,index) => <p key={index}>{kind === "hypothesis" ? "一种可能是：" : ""}{claim.text}</p>)}</section> : null; })}</div>} />
  </article>;
}

export function App() {
  const initialHash = window.location.hash.replace(/^#/, "");
  const requestedSettingsTab = initialHash.startsWith("settings/")
    ? initialHash.slice("settings/".length)
    : "general";
  const initialSettingsTab = SETTINGS_TABS.includes(requestedSettingsTab as SettingsTab)
    ? (requestedSettingsTab as SettingsTab)
    : "general";
  const requestedPersonView =
    initialHash === "sources"
      ? "sources"
      : initialHash === "evidence"
        ? "evidence"
        : initialHash.startsWith("people/")
          ? initialHash.slice("people/".length)
          : "profile";
  const initialPersonView: PersonView = PERSON_VIEWS.some(
    (item) => item.value === requestedPersonView,
  )
    ? (requestedPersonView as PersonView)
    : "profile";
  const initialAppView: AppView =
    initialHash === "sources" ||
    initialHash === "evidence" ||
    initialHash.startsWith("people/")
      ? "people"
      : initialHash.startsWith("settings/")
        ? "settings"
      : APP_VIEWS.includes(initialHash as AppView)
        ? (initialHash as AppView)
        : "assistant";
  const [activeView, setActiveView] = useState<AppView>(
    ["workspace", "settings", "data", "usage", "help"].includes(initialAppView) ? "assistant" : initialAppView,
  );
  const [dialogView, setDialogView] = useState<AppView | null>(["workspace", "settings", "data", "usage", "help"].includes(initialAppView) ? initialAppView : null);
  const [interviewPersonId, setInterviewPersonId] = useState("");
  const [eventCreatorOpen, setEventCreatorOpen] = useState(false);
  const eventDraftBeforeCreate = useRef<{ title: string; location: string; summary: string; at: string; people: string[]; sources: string[]; confirmed: boolean } | null>(null);
  const [preferences, setPreferences] = useState<AppPreferences>(() =>
    typeof window === "undefined" ? DEFAULT_PREFERENCES : loadPreferences(),
  );
  const [onboardingOpen, setOnboardingOpen] = useState(() =>
    typeof window === "undefined" ? false : shouldShowOnboarding(),
  );
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialSettingsTab);
  const [personView, setPersonView] =
    useState<PersonView>(initialPersonView);
  const [workspacePath, setWorkspacePath] = useState(DEFAULT_WORKSPACE);
  const [openedPath, setOpenedPath] = useState("");
  const workspaceGeneration = useRef(0);
  const liveWorkspaceBusy = useRef(false);
  const recordingBusy = useRef(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [transcriptionBusy, setTranscriptionBusy] = useState(false);
  const [meetingDraft, setMeetingDraft] = useState({ kind: "person", personId: "", eventId: "", title: "", participantName: "" });
  const renderedWorkspaceGeneration = workspaceGeneration.current;
  const workspaceOpenQueue = useRef<Promise<void>>(Promise.resolve());
  const workspacePickerGeneration = useRef(0);
  const [opening, setOpening] = useState(false);
  const [transcriptionOpen, setTranscriptionOpen] = useState(false);
  const [liveAnalysisContainer, setLiveAnalysisContainer] = useState<HTMLDivElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectingWorkspace, setSelectingWorkspace] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const [people, setPeople] = useState<Person[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [executors, setExecutors] = useState<ExecutorStatus[]>([]);
  const [executorsLoaded, setExecutorsLoaded] = useState(false);
  const [executorError, setExecutorError] = useState("");

  const [personName, setPersonName] = useState("");
  const [personRelation, setPersonRelation] = useState("");
  const [personOccupation, setPersonOccupation] = useState("");
  const [personAge, setPersonAge] = useState("");
  const [personGender, setPersonGender] = useState("");
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [personCreatorOpen, setPersonCreatorOpen] = useState(false);
  const [assistantExpanded, setAssistantExpanded] = useState(false);
  const [liveExpanded, setLiveExpanded] = useState(false);
  const [peopleExpanded, setPeopleExpanded] = useState(
    initialAppView === "people",
  );
  const [assistantConversations, setAssistantConversations] = useState<
    AiConversation[]
  >(() => (typeof window === "undefined" ? [] : loadAiConversations()));
  const [assistantConversationId, setAssistantConversationId] = useState<string>(
    createConversationId,
  );
  const [profilePersonId, setProfilePersonId] = useState("");
  const [analysisObjectType, setAnalysisObjectType] = useState<"person" | "event">(initialAppView === "events" ? "event" : "person");
  const [profileSection, setProfileSection] =
    useState<ProfileSection>("basic_info");
  const [profileLabel, setProfileLabel] = useState("");
  const [profileValue, setProfileValue] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const [autofillText, setAutofillText] = useState("");
  const [autofillTitle, setAutofillTitle] = useState("AI 自动整理原始资料");
  const [autofillEngine, setAutofillEngine] = useState<
    "local_demo" | "claude" | "codex" | "api"
  >("local_demo");
  const [autofillTarget, setAutofillTarget] =
    useState<"new" | "existing">("new");
  const [autofillPersonId, setAutofillPersonId] = useState("");
  const [autofillName, setAutofillName] = useState("");
  const [autofillRelation, setAutofillRelation] = useState("");
  const [autofillPreview, setAutofillPreview] =
    useState<ProfileAutofillResponse | null>(null);
  const [autofillSelected, setAutofillSelected] = useState<number[]>([]);
  const [autofillState, setAutofillState] = useState<
    "idle" | "previewing" | "saving" | "saved"
  >("idle");
  const [autofillSavedPersonId, setAutofillSavedPersonId] = useState("");

  const [eventTitle, setEventTitle] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [eventSummary, setEventSummary] = useState("");
  const [workbenchEventId, setWorkbenchEventId] = useState("");
  const [savingWorkbenchEvent, setSavingWorkbenchEvent] = useState(false);
  const [eventAnalysisSources, setEventAnalysisSources] = useState<Id[]>([]);
  const [eventAnalysisEngine, setEventAnalysisEngine] = useState<"api" | "claude" | "codex">("api");
  const [eventScopeConfirmed, setEventScopeConfirmed] = useState(false);
  const [analyzingEvent, setAnalyzingEvent] = useState(false);
  const [eventDirectSettings, setEventDirectSettings] = useState<DirectModelSettings | null>(null);
  const [eventAt, setEventAt] = useState(localDateTimeValue);
  const [eventPeople, setEventPeople] = useState<Id[]>([]);

  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("text");
  const [sourceText, setSourceText] = useState("");
  const [sourcePeople, setSourcePeople] = useState<Id[]>([]);
  const [sourceEvents, setSourceEvents] = useState<Id[]>([]);
  const [screenshotTitle, setScreenshotTitle] = useState("聊天截图");
  const [screenshotPeople, setScreenshotPeople] = useState<Id[]>([]);
  const [screenshotEvents, setScreenshotEvents] = useState<Id[]>([]);
  const [screenshotFiles, setScreenshotFiles] = useState<File[]>([]);
  const [draggingScreenshots, setDraggingScreenshots] = useState(false);
  const [uploadingScreenshots, setUploadingScreenshots] = useState(false);
  const [selectedScreenshotId, setSelectedScreenshotId] = useState("");
  const [screenshotSegments, setScreenshotSegments] = useState<
    ScreenshotSegmentInput[]
  >([{ order: 0, speaker: "unknown", text: "", uncertainty: "high" }]);
  const [confirmingTranscript, setConfirmingTranscript] = useState(false);

  const sourceRequestGeneration = useRef(0);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [savedLiveSourceId, setSavedLiveSourceId] = useState("");
  const [sourceRecords, setSourceRecords] = useState<
    Record<string, RecordResponse>
  >({});
  const [locatorStart, setLocatorStart] = useState(0);
  const [locatorEnd, setLocatorEnd] = useState(0);
  const [evidenceKind, setEvidenceKind] =
    useState<EvidenceRecord["evidence_kind"]>("direct_quote");
  const [reliability, setReliability] =
    useState<EvidenceRecord["reliability"]>("medium");
  const [evidencePeople, setEvidencePeople] = useState<Id[]>([]);
  const [evidenceEvents, setEvidenceEvents] = useState<Id[]>([]);

  const [reportKind, setReportKind] = useState<ReportKind>("personality");
  const [reportPurpose, setReportPurpose] = useState("understand");
  const [reportTimeFocus, setReportTimeFocus] = useState("all");
  const [reportMaterialFocus, setReportMaterialFocus] =
    useState("balanced");
  const [reportMode, setReportMode] = useState<ReportMode>("generate");
  const [reportSources, setReportSources] = useState<Id[]>([]);
  const [reportContextPersonId, setReportContextPersonId] = useState("");
  const [reportConfirmed, setReportConfirmed] = useState(false);
  const [reportUpdateTopicId, setReportUpdateTopicId] = useState("");
  const [includeCharts, setIncludeCharts] = useState(false);
  const [plottingCapabilities, setPlottingCapabilities] = useState<Awaited<ReturnType<typeof api.getPlottingCapabilities>> | null>(null);
  const [creatingReport, setCreatingReport] = useState(false);
  const [currentReport, setCurrentReport] = useState<ReportResponse | null>(
    null,
  );
  const [reviewPersonId, setReviewPersonId] = useState("");
  const [claimReviews, setClaimReviews] = useState<
    Record<string, ClaimReviewState>
  >({});
  const [reviewingClaim, setReviewingClaim] = useState("");
  const [advisorPersonId, setAdvisorPersonId] = useState("");
  const [advisorRequest, setAdvisorRequest] = useState("");
  const [selectedAnalysisTemplate, setSelectedAnalysisTemplate] = useState<AnalysisTemplate | null>(null);
  const [advisorAnswer, setAdvisorAnswer] = useState("");
  const [advisorResult, setAdvisorResult] =
    useState<ReportAdvisorResponse | null>(null);
  const [advisorBusy, setAdvisorBusy] = useState(false);

  const [inspectedEvidenceId, setInspectedEvidenceId] = useState("");
  const [inspectorRecord, setInspectorRecord] = useState<RecordResponse | null>(
    null,
  );
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [eventQuoteInspection, setEventQuoteInspection] = useState<{ sourceId: Id; start: number; end: number; quote: string } | null>(null);
  const sourceInspectionToken = useRef(0);

  const selectedSource = sources.find(
    (item) =>
      item.id === selectedSourceId &&
      (!profilePersonId || item.person_ids.includes(profilePersonId)),
  );
  const screenshotSources = sources
    .filter((item) => item.source_kind === "screenshot")
    .sort(
      (left, right) =>
        (left.sequence_index ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence_index ?? Number.MAX_SAFE_INTEGER),
    );
  const selectedScreenshot = screenshotSources.find(
    (item) =>
      item.id === selectedScreenshotId &&
      (!profilePersonId || item.person_ids.includes(profilePersonId)),
  );
  const profilePerson = people.find((item) => item.id === profilePersonId);
  const workbenchEvent = events.find(item => item.id === workbenchEventId);
  const workbenchEventSources = sources.filter(item => item.event_ids.includes(workbenchEventId) && item.source_kind !== "screenshot" && item.source_kind !== "file");
  const eventEngineReady = eventAnalysisEngine === "api" ? Boolean(eventDirectSettings?.configured) : executors.some(item => item.engine === eventAnalysisEngine && item.available);
  const eventHasUnsavedChanges = Boolean(workbenchEvent && (eventTitle.trim() !== workbenchEvent.title || eventLocation.trim() !== (workbenchEvent.location ?? "") || eventSummary.trim() !== (workbenchEvent.summary ?? "") || Date.parse(eventAt) !== Date.parse(workbenchEvent.occurred_at) || [...eventPeople].sort().join("|") !== [...workbenchEvent.person_ids].sort().join("|")));

  const personSources = profilePersonId
    ? sources.filter((item) => item.person_ids.includes(profilePersonId))
    : [];
  const personTextSources = personSources.filter(
    (item) => item.source_kind !== "screenshot",
  );
  const personScreenshotSources = personSources
    .filter((item) => item.source_kind === "screenshot")
    .sort(
      (left, right) =>
        (left.sequence_index ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence_index ?? Number.MAX_SAFE_INTEGER),
    );
  const personEvents = profilePersonId
    ? events.filter((item) => item.person_ids.includes(profilePersonId))
    : [];
  const personEvidence = profilePersonId
    ? evidence.filter((item) => item.person_ids.includes(profilePersonId))
    : [];
  const personReports = profilePersonId
    ? reports.filter((item) => item.topic.person_ids.includes(profilePersonId))
    : [];
  const reportUpdateTopic = reports.find(item => item.topic.id === reportUpdateTopicId)?.topic;
  const reportContextPerson = people.find(
    (item) => item.id === reportContextPersonId,
  );
  const reportAvailableSources = reportContextPersonId
    ? sources.filter((item) => item.person_ids.includes(reportContextPersonId))
    : sources;
  const visibleReports = (reportContextPersonId
    ? reports.filter((item) => item.topic.person_ids.includes(reportContextPersonId))
    : [...reports]).sort((left, right) => right.snapshot.created_at.localeCompare(left.snapshot.created_at));
  const workspaceConversations = assistantConversations
    .filter(
      (item) =>
        Boolean(openedPath) && item.workspace_path === openedPath,
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const activeConversation = assistantConversations.find(
    (item) => item.id === assistantConversationId && item.workspace_path === openedPath,
  );
  const liveHistorySources = sources
    .filter(
      (item) =>
        item.source_kind === "text" && item.title.includes("实时会谈"),
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const selectedSourceRecord = sourceRecords[selectedSourceId];
  const selectedSourceBody = selectedSourceRecord?.body ?? "";
  const selectedQuote =
    locatorEnd > locatorStart && locatorEnd <= selectedSourceBody.length
      ? selectedSourceBody.slice(locatorStart, locatorEnd)
      : "";
  const codePointLocatorStart = utf16OffsetToCodePoint(
    selectedSourceBody,
    locatorStart,
  );
  const codePointLocatorEnd = utf16OffsetToCodePoint(
    selectedSourceBody,
    locatorEnd,
  );
  const inspectedEvidence = evidence.find(
    (item) => item.id === inspectedEvidenceId,
  );
  const availableExecutors = executors.filter((item) => item.available);
  const selectedReportSources = sources.filter((item) =>
    reportSources.includes(item.id) && (!reportContextPersonId || item.person_ids.includes(reportContextPersonId)),
  );
  const selectedReportEvidence = evidence.filter((item) =>
    selectedReportSources.some(source => source.id === item.source_id),
  );
  const selectedReportFeedback = [...new Map((people.find(item => item.id === advisorPersonId)?.profile_sections ?? [])
    .filter(entry => entry.origin === "ai" && entry.label === "AI 候选描述" && entry.evidence_ids.length > 0 && entry.evidence_ids.every(id => selectedReportEvidence.some(item => item.id === id)))
    .map(entry => [JSON.stringify([entry.value, [...entry.evidence_ids].sort()]), entry])).values()].slice(-30);
  const selectedReportKind =
    REPORT_KIND_OPTIONS.find((item) => item.id === reportKind) ??
    REPORT_KIND_OPTIONS[1];
  const selectedReportPurpose =
    REPORT_PURPOSES.find(([id]) => id === reportPurpose)?.[1] ??
    REPORT_PURPOSES[0][1];
  const selectedReportTimeFocus =
    REPORT_TIME_FOCUS.find(([id]) => id === reportTimeFocus)?.[1] ??
    REPORT_TIME_FOCUS[0][1];
  const selectedReportMaterialFocus =
    REPORT_MATERIAL_FOCUS.find(([id]) => id === reportMaterialFocus)?.[1] ??
    REPORT_MATERIAL_FOCUS[1][1];
  const reportRequestText = [
    selectedAnalysisTemplate ? "按所选分析模板整理材料。" : selectedReportKind.prompt,
    advisorRequest.trim()
      ? `补充问题：${advisorRequest.trim()}`
      : "",
    `报告用途：${selectedReportPurpose}。`,
    `时间侧重：${selectedReportTimeFocus}。`,
    `资料侧重：${selectedReportMaterialFocus}。`,
  ]
    .filter(Boolean)
    .join("\n");
  const selectedView = VIEW_COPY[activeView];
  const isControlView = CONTROL_VIEWS.includes(activeView as ControlView);

  useEffect(() => {
    void retryLocalApi(() => api.listExecutors())
      .then((result) => {
        setExecutors(result.items);
        setExecutorError("");
      })
      .catch((error: unknown) => setExecutorError(asMessage(error)))
      .finally(() => setExecutorsLoaded(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let generation = renderedWorkspaceGeneration;

    async function resumeCurrentWorkspace() {
      const current = await retryLocalApi(() => api.currentWorkspace());
      if (cancelled || !isWorkspaceCurrent(generation)) return;
      let resolvedPath = current.path ?? "";
      if (!current.open) {
        const rememberedPath =
          window.localStorage.getItem(LAST_WORKSPACE_KEY)?.trim() ?? "";
        if (!rememberedPath) return;
        const opened = await openWorkspaceSerialized(rememberedPath, generation);
        if (cancelled || !isWorkspaceCurrent(generation)) return;
        resolvedPath = opened.path ?? rememberedPath;
      }
      if (cancelled || !isWorkspaceCurrent(generation)) return;
      generation = resetWorkspaceSessionState();
      const collections = await loadWorkspaceCollections(generation);
      if (cancelled || !isWorkspaceCurrent(generation)) return;
      setWorkspacePath(resolvedPath);
      setOpenedPath(resolvedPath); setDialogView(null);
      restoreWorkspaceConversation(resolvedPath);
      if (resolvedPath) {
        window.localStorage.setItem(LAST_WORKSPACE_KEY, resolvedPath);
      }
      const latestReport = [...collections.reports].sort((left, right) =>
        right.snapshot.created_at.localeCompare(left.snapshot.created_at),
      )[0];
      if (latestReport?.analysis) {
        const personId = latestReport.topic.person_ids[0] ?? "";
        setReportContextPersonId(personId);
        setAdvisorPersonId(personId);
        setCurrentReport({
          topic: latestReport.topic,
          snapshot: latestReport.snapshot,
          analysis: latestReport.analysis,
          execution: latestReport.execution ?? {
            engine: "safe_placeholder",
            profile_id: "legacy_report",
            material_scope: latestReport.analysis.material_scope,
            data_destination: "local_only",
            degraded:
              latestReport.snapshot.generation_kind === "safe_placeholder",
            degraded_reason: "历史报告未记录执行器信息。",
          },
        });
        setReviewPersonId(personId);
        setReportMode("read");
        setActiveView("reports");
        window.history.replaceState(null, "", "#reports");
      }

    }

    void resumeCurrentWorkspace().catch((error: unknown) => {
      if (!cancelled && isWorkspaceCurrent(generation)) {
        setNotice({
          kind: "error",
          text: `本地服务或上次工作区未能恢复：${asMessage(error)}`,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    savePreferences(preferences);
    document.documentElement.lang = preferences.language;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      applyAppearance(preferences, Boolean(media?.matches));
    };
    applyTheme();
    media?.addEventListener?.("change", applyTheme);
    return () => media?.removeEventListener?.("change", applyTheme);
  }, [preferences]);

  useEffect(() => {
    window.localStorage.setItem(
      AI_CONVERSATIONS_KEY,
      JSON.stringify(assistantConversations.slice(0, 40)),
    );
  }, [assistantConversations]);

  useEffect(() => {
    if (!notice || !notice.text.startsWith("文档已加载")) return;
    const timer = window.setTimeout(() => setNotice(current => current === notice ? null : current), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    setAutofillEngine(preferences.textEngine);
    if (preferences.textEngine !== "local_demo") setEventAnalysisEngine(preferences.textEngine);
  }, [preferences.textEngine]);

  useEffect(() => {
    setReportConfirmed(false);
  }, [
    advisorRequest,
    reportKind,
    reportPurpose,
    reportSources,
    reportTimeFocus,
    reportMaterialFocus,
    includeCharts,
  ]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (activeView !== "events" || eventAnalysisEngine !== "api") return;
      void api.getDirectModelSettings().then(settings => { if (!cancelled) setEventDirectSettings(settings); }).catch(() => { if (!cancelled) setEventDirectSettings(null); });
    };
    refresh(); window.addEventListener("lingxi:model-settings-changed", refresh);
    return () => { cancelled = true; window.removeEventListener("lingxi:model-settings-changed", refresh); };
  }, [activeView, eventAnalysisEngine]);

  useEffect(() => {
    let cancelled = false;
    if (activeView === "reports") void api.getPlottingCapabilities().then(capabilities => {
      if (cancelled) return;
      setPlottingCapabilities(capabilities);
      if (!capabilities.available) setIncludeCharts(false);
    }).catch(() => { if (!cancelled) { setPlottingCapabilities({ available: false, reason: "无法检查本机 R 环境，请确认本地服务可用后重试。" }); setIncludeCharts(false); } });
    return () => { cancelled = true; };
  }, [activeView]);

  function switchView(view: AppView) {
    if (view === "obsidian") {
      if (!openedPath) { setNotice({ kind: "error", text: "请先打开工作区。" }); return; }
      const url = `obsidian://open?path=${encodeURIComponent(openedPath)}`;
      if (window.__TAURI__?.core.invoke) void window.__TAURI__.core.invoke("open_obsidian", { workspacePath: openedPath }).catch(error => setNotice({ kind: "error", text: asMessage(error) }));
      else window.location.href = url;
      return;
    }
    if (["settings", "data", "workspace", "help", "usage"].includes(view)) { setDialogView(view); return; }
    setDialogView(null);
    if (view === "reports") { setReportMode("read"); setReportContextPersonId(profilePersonId); if (currentReport && profilePersonId && !currentReport.topic.person_ids.includes(profilePersonId)) setCurrentReport(null); }
    if (view === "people") setAnalysisObjectType("person");
    if (view === "events") setAnalysisObjectType("event");    if (view === "people") {
      setPeopleExpanded((current) =>
        activeView === "people" ? !current : true,
      );
    }
    setActiveView(view);
    window.history.replaceState(null, "", `#${view}`);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function startNewAiConversation() {
    setAssistantConversationId(createConversationId());
    setActiveView("assistant");
    window.history.replaceState(null, "", "#assistant");
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function openAiConversation(id: string) {
    const conversation = assistantConversations.find(item => item.id === id && item.workspace_path === openedPath);
    if (!conversation) return;
    const personId = conversation.person_id;
    if (personId && people.some(item => item.id === personId)) { setAnalysisObjectType("person"); selectPerson(personId); }
    setAssistantConversationId(id);
    setActiveView("assistant");
    window.history.replaceState(null, "", "#assistant");
  }

  function updateAiConversation(conversation: AiConversation) {
    if (!isWorkspaceCurrent(renderedWorkspaceGeneration)) return;
    setAssistantConversations((items) => [
      conversation,
      ...items.filter((item) => item.id !== conversation.id),
    ]);
  }

  function openReports(personId = profilePersonId, mode: "read" | "generate" = "read") {
    selectReportPerson(personId);
    setReportMode(mode);
    setActiveView("reports");
    window.history.replaceState(null, "", "#reports");
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function openLatestReport(personId: string) {
    selectReportPerson(personId);
    const latestReport = reports
      .filter(
        (item) =>
          item.analysis && item.topic.person_ids.includes(personId),
      )
      .sort((left, right) =>
        right.snapshot.created_at.localeCompare(left.snapshot.created_at),
      )[0];
    if (latestReport) {
      openReportForReading(latestReport);
    }
    setActiveView("reports");
    window.history.replaceState(null, "", "#reports");
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function selectReportPerson(personId: string) {
    setReportContextPersonId(personId);
    setReportUpdateTopicId("");
    setAdvisorPersonId(personId);
    setAdvisorRequest("");
    setAdvisorAnswer("");
    setAdvisorResult(null);
    setReportSources(
      personId
        ? sources
            .filter((item) => item.person_ids.includes(personId))
            .map((item) => item.id)
        : [],
    );
    if (!currentReport?.topic.person_ids.includes(personId)) setCurrentReport(null);
    setReportUpdateTopicId("");
    setReportMode("generate");
  }

  function openLiveHistory(source: SourceRecord) {
    const personId = source.person_ids[0] ?? "";
    if (personId) selectPerson(personId);
    setSelectedSourceId(source.id);
    switchPersonView("sources");
  }

  function switchSettingsTab(tab: SettingsTab) {
    setSettingsTab(tab);
    setDialogView("settings");
    window.history.replaceState(null, "", `#settings/${tab}`);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function navigateToGuideTarget(target: GuideTarget) {
    if (isSettingsGuideTarget(target)) {
      switchSettingsTab(target.slice("settings/".length) as SettingsTab);
      return;
    }
    switchView(target);
  }

  function createPersonFromToolbar() {
    setPeopleExpanded(true);
    setPersonCreatorOpen(true);
  }

  function switchPersonView(view: PersonView) {
    setPeopleExpanded(true);
    setPersonView(view);
    setActiveView("people");
    window.history.replaceState(null, "", `#people/${view}`);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function isWorkspaceCurrent(generation: number) {
    return generation === workspaceGeneration.current;
  }

  function assertWorkspaceCurrent(generation: number) {
    if (!isWorkspaceCurrent(generation)) throw new Error("工作区已切换，旧任务不会载入当前工作区。");
  }

  async function openWorkspaceSerialized(path: string, generation: number) {
    const request = workspaceOpenQueue.current.catch(() => undefined).then(() => {
      assertWorkspaceCurrent(generation);
      return api.openWorkspace(path);
    });
    workspaceOpenQueue.current = request.then(() => undefined, () => undefined);
    const result = await request;
    assertWorkspaceCurrent(generation);
    return result;
  }

  function restoreWorkspaceConversation(path: string) {
    const latest = assistantConversations.filter(item => item.workspace_path === path)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    setAssistantConversationId(latest?.id ?? createConversationId());
  }

  function resetWorkspaceSessionState() {
    const generation = ++workspaceGeneration.current;
    setAssistantConversationId(createConversationId());
    setNotice(null);
    setCreatingReport(false); setCreatingPerson(false); setSavingProfile(false);
    setSavingWorkbenchEvent(false); setAnalyzingEvent(false); setAdvisorBusy(false);
    setUploadingScreenshots(false); setConfirmingTranscript(false);
    setAutofillState("idle"); setReviewingClaim(""); setRefreshing(false);
    sourceInspectionToken.current += 1;
    setEventQuoteInspection(null);
    setPeople([]);
    setEvents([]);
    setAnalysisObjectType("person");
    setInterviewPersonId("");
    setMeetingDraft({kind:"person", personId:"", eventId:"", title:"", participantName:""});
    setWorkbenchEventId("");
    setEventLocation("");
    setEventSummary("");
    setEventAnalysisSources([]); setEventScopeConfirmed(false);
    setSources([]);
    setEvidence([]);
    setReports([]);
    setProfilePersonId("");
    setAdvisorPersonId("");
    setAutofillPersonId("");
    setAutofillPreview(null);
    setAutofillSelected([]);
    setAutofillSavedPersonId("");
    setEventPeople([]);
    setSourcePeople([]);
    setSourceEvents([]);
    setScreenshotPeople([]);
    setScreenshotEvents([]);
    setScreenshotFiles([]);
    setSelectedSourceId("");
    setSelectedScreenshotId("");
    setSavedLiveSourceId("");
    setSourceRecords({});
    setLocatorStart(0);
    setLocatorEnd(0);
    setEvidencePeople([]);
    setEvidenceEvents([]);
    setReportKind("personality");
    setSelectedAnalysisTemplate(null);
    setReportPurpose("understand");
    setReportTimeFocus("all");
    setReportMaterialFocus("balanced");
    setReportMode("generate");
    setReportSources([]);
    setReportContextPersonId("");
    setReportConfirmed(false);
    setCurrentReport(null);
    setReportUpdateTopicId("");
    setIncludeCharts(false);
    setReviewPersonId("");
    setClaimReviews({});
    setAdvisorRequest("");
    setAdvisorAnswer("");
    setAdvisorResult(null);
    setInspectedEvidenceId("");
    setInspectorRecord(null);
    setInspectorLoading(false);
    return generation;
  }

  function clearWorkspaceDerivedCaches() {
    setSourceRecords({});
    setLocatorStart(0);
    setLocatorEnd(0);
    setInspectedEvidenceId("");
    setInspectorRecord(null);
    setInspectorLoading(false);
  }

  function selectPerson(id: Id) {
    setPeopleExpanded(true);
    setProfilePersonId(id);
    setReportContextPersonId(id);
    if (currentReport && !currentReport.topic.person_ids.includes(id)) setCurrentReport(null);
    setEventPeople([id]);
    setSourcePeople([id]);
    setScreenshotPeople([id]);
    if (
      selectedSourceId &&
      !sources
        .find((item) => item.id === selectedSourceId)
        ?.person_ids.includes(id)
    ) {
      setSelectedSourceId("");
      setLocatorStart(0);
      setLocatorEnd(0);
    }
    if (
      selectedScreenshotId &&
      !sources
        .find((item) => item.id === selectedScreenshotId)
        ?.person_ids.includes(id)
    ) {
      setSelectedScreenshotId("");
    }
  }

  async function createLivePerson(displayName: string) {
    const generation = renderedWorkspaceGeneration;
    assertWorkspaceCurrent(generation);

    const person = await api.createPerson(displayName, "会谈对象");
    assertWorkspaceCurrent(generation);
    setPeople((items) => [...items, person]);
    selectPerson(person.id);
    setNotice({
      kind: "success",
      text: `已创建联系人“${person.display_name}”，本次会谈会自动关联。`,
    });
    return { id: person.id, display_name: person.display_name };
  }

  async function loadWorkspaceCollections(generation = renderedWorkspaceGeneration) {
    assertWorkspaceCurrent(generation);

    const [
      peopleResult,
      eventsResult,
      sourcesResult,
      evidenceResult,
      reportsResult,
    ] = await Promise.all([
      api.listPeople(),
      api.listEvents(),
      api.listSources(),
      api.listEvidence(),
      api.listReports(),
    ]);
    assertWorkspaceCurrent(generation);
    setPeople(peopleResult.items);
    setEvents(eventsResult.items);
    setSources(sourcesResult.items);
    setEvidence(evidenceResult.items);
    setReports(reportsResult.items);
    setPersonCreatorOpen(false);
    setProfilePersonId((current) =>
      peopleResult.items.some((item) => item.id === current)
        ? current
        : (peopleResult.items[0]?.id ?? ""),
    );
    setAdvisorPersonId((current) =>
      peopleResult.items.some((item) => item.id === current)
        ? current
        : (peopleResult.items[0]?.id ?? ""),
    );
    setSelectedSourceId((current) =>
      sourcesResult.items.some((item) => item.id === current) ? current : "",
    );
    setReportSources((current) =>
      current.filter((id) =>
        sourcesResult.items.some((item) => item.id === id),
      ),
    );
    const firstScreenshot = sourcesResult.items.find(
      (item) => item.source_kind === "screenshot",
    );
    setSelectedScreenshotId((current) =>
      sourcesResult.items.some(
        (item) => item.id === current && item.source_kind === "screenshot",
      )
        ? current
        : (firstScreenshot?.id ?? ""),
    );
    return {
      people: peopleResult.items,
      events: eventsResult.items,
      sources: sourcesResult.items,
      evidence: evidenceResult.items,
      reports: reportsResult.items,
    };
  }

  async function openWorkspacePath(path: string) {
    const normalizedPath = path.trim();
    if (normalizedPath !== openedPath && (liveWorkspaceBusy.current || recordingBusy.current)) {
      setNotice({ kind: "error", text: "请先停止并保存或放弃当前会谈，再切换工作区。" });
      return;
    }
    if (normalizedPath && normalizedPath === openedPath) { await handleRefreshWorkspace(); return; }
    if (!normalizedPath) { setNotice({ kind: "error", text: "请选择工作区文件夹。" }); return; }
    const generation = resetWorkspaceSessionState();
    setOpenedPath(""); setOpening(true);
    try {
      const result = await openWorkspaceSerialized(normalizedPath, generation);
      assertWorkspaceCurrent(generation);
      await loadWorkspaceCollections(generation);
      assertWorkspaceCurrent(generation);
      const resolvedPath = result.path ?? normalizedPath;
      setWorkspacePath(resolvedPath); setOpenedPath(resolvedPath); setDialogView(null); setDialogView(null);
      restoreWorkspaceConversation(resolvedPath);
      window.localStorage.setItem(LAST_WORKSPACE_KEY, resolvedPath);
      setActiveView(preferences.startupView); setPersonView("profile");
      window.history.replaceState(null, "", `#${preferences.startupView}`);
      setNotice(null);
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;
      setOpenedPath(""); setNotice({ kind: "error", text: asMessage(error) });
    } finally { if (isWorkspaceCurrent(generation)) setOpening(false); }
  }

  async function handleSelectWorkspace() {
    if (!window.lingxiDesktop) return;
    const picker = ++workspacePickerGeneration.current;
    const generation = workspaceGeneration.current;
    setSelectingWorkspace(true);
    try {
      const path = await window.lingxiDesktop.selectWorkspace();
      if (picker !== workspacePickerGeneration.current || !isWorkspaceCurrent(generation)) return;
      if (path) await openWorkspacePath(path);
    } catch (error) { if (picker === workspacePickerGeneration.current && isWorkspaceCurrent(generation)) setNotice({ kind: "error", text: asMessage(error) }); }
    finally { if (picker === workspacePickerGeneration.current) setSelectingWorkspace(false); }
  }

  async function handleUseDefaultWorkspace() {
    const picker = ++workspacePickerGeneration.current;
    const generation = workspaceGeneration.current;
    setSelectingWorkspace(true);
    try {
      const path = (await window.lingxiDesktop?.defaultWorkspace?.()) ?? DEFAULT_WORKSPACE;
      if (picker !== workspacePickerGeneration.current || !isWorkspaceCurrent(generation)) return;
      if (!path) throw new Error("当前开发环境没有默认目录，请使用桌面版选择文件夹。");
      await openWorkspacePath(path);
    } catch (error) { if (picker === workspacePickerGeneration.current && isWorkspaceCurrent(generation)) setNotice({ kind: "error", text: asMessage(error) }); }
    finally { if (picker === workspacePickerGeneration.current) setSelectingWorkspace(false); }
  }

  async function handleRefreshWorkspace() {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    setRefreshing(true);
    try {
      const result = await api.refreshWorkspace();
      if (!isWorkspaceCurrent(generation)) return;
      clearWorkspaceDerivedCaches();
      await loadWorkspaceCollections();
      if (!isWorkspaceCurrent(generation)) return;
      setOpenedPath(result.path ?? openedPath);
      window.dispatchEvent(new Event("lingxi:workspace-refreshed"));
      setNotice({
        kind: "success",
        text: "工作区已刷新，外部修改经过索引重新载入。",
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setRefreshing(false);
      }
    }
  }

  async function handleCreatePerson(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    setCreatingPerson(true);
    try {
      let person = await api.createPerson(
        personName.trim(),
        personRelation.trim(),
      );
      if (!isWorkspaceCurrent(generation)) return;
      const optionalProfileEntries = [
        ["职业 / 身份", personOccupation.trim()],
        ["年龄", personAge ? `${personAge} 岁` : ""],
        ["性别", personGender],
      ] as const;
      for (const [label, value] of optionalProfileEntries) {
        if (!value) continue;
        person = await api.addProfileEntry(person.id, {
          section: "basic_info",
          label,
          value,
          evidence_ids: [],
        });
        if (!isWorkspaceCurrent(generation)) return;
      }
      setPeople((items) => [...items, person]);
      setPersonName("");
      setPersonRelation("");
      setPersonOccupation("");
      setPersonAge("");
      setPersonGender("");
      setPersonCreatorOpen(false);
      setInterviewPersonId(person.id);
      setActiveView("people"); setAnalysisObjectType("person");
      setEventPeople((ids) => [...ids, person.id]);
      setSourcePeople((ids) => [...ids, person.id]);
      setScreenshotPeople((ids) => [...ids, person.id]);
      selectPerson(person.id);
      setPersonView("profile");
      setNotice({
        kind: "success",
        text: `已创建人物“${person.display_name}”。`,
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      await loadWorkspaceCollections().catch(() => undefined);
      if (!isWorkspaceCurrent(generation)) return;
      setNotice({ kind: "error", text: asMessage(error) });
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setCreatingPerson(false);
      }
    }
  }

  function applyAnalysisTemplate(template: AnalysisTemplate) {
    if (!isWorkspaceCurrent(renderedWorkspaceGeneration)) return;
    setDialogView(null);
    openReports();
    setSelectedAnalysisTemplate(template);
    setReportUpdateTopicId("");
    setReportKind(
      reportKindFor(template.template_family, template.template_variant),
    );
    setAdvisorRequest(analysisTemplateQuestion(template));
    setReportMode("generate");
    setReportConfirmed(false);
    setNotice({
      kind: "success",
      text: `已应用“${template.name}”，请继续选择人物和原始材料。`,
    });
  }

  async function handleAddProfileEntry(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    setSavingProfile(true);
    try {
      const updated = await api.addProfileEntry(profilePersonId, {
        section: profileSection,
        label: profileLabel.trim(),
        value: profileValue.trim(),
        evidence_ids: [],
      });
      if (!isWorkspaceCurrent(generation)) return;
      setPeople((items) =>
        items.map((person) => (person.id === updated.id ? updated : person)),
      );
      setProfileLabel("");
      setProfileValue("");
      setNotice({
        kind: "success",
        text: `已保存“${PROFILE_SECTION_LABELS[profileSection]}”资料。`,
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setSavingProfile(false);
      }
    }
  }

  async function handleCreateEvent(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    try {
      const created = await api.createEvent({
        title: eventTitle.trim(),
        occurred_at: new Date(eventAt).toISOString(),
        person_ids: eventPeople,
        ...(eventLocation.trim() ? { location: eventLocation.trim() } : {}),
        ...(eventSummary.trim() ? { summary: eventSummary.trim() } : {}),
      });
      if (!isWorkspaceCurrent(generation)) return;
      setEvents((items) => [...items, created]);
      setWorkbenchEventId(created.id);
      if (eventCreatorOpen) { setEventCreatorOpen(false); setAnalysisObjectType("event"); setActiveView("events"); }
      if (activeView === "events" || eventCreatorOpen) { setEventTitle(created.title); setEventLocation(created.location ?? ""); setEventSummary(created.summary ?? ""); }
      else { setEventTitle(""); setEventLocation(""); setEventSummary(""); }
      setSourceEvents((ids) => [...ids, created.id]);
      setScreenshotEvents((ids) => [...ids, created.id]);
      setNotice({
        kind: "success",
        text: `事件“${created.title}”已关联人物。`,
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    }
  }

  function selectWorkbenchEvent(item: EventRecord) {
    if (item.person_ids[0]) selectPerson(item.person_ids[0]);
    setAnalysisObjectType("event");
    setWorkbenchEventId(item.id);
    setEventTitle(item.title);
    setEventAt(new Date(new Date(item.occurred_at).getTime() - new Date(item.occurred_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16));
    setEventPeople(item.person_ids);
    setEventLocation(item.location ?? "");
    setEventSummary(item.summary ?? "");
    setEventAnalysisSources(sources.filter(source => source.event_ids.includes(item.id) && source.source_kind !== "screenshot" && source.source_kind !== "file").map(source => source.id));
    setEventScopeConfirmed(false);
    switchView("events");
  }

  function newWorkbenchEvent() {
    eventDraftBeforeCreate.current = { title: eventTitle, location: eventLocation, summary: eventSummary, at: eventAt, people: eventPeople, sources: eventAnalysisSources, confirmed: eventScopeConfirmed };
    setEventTitle(""); setEventLocation(""); setEventSummary(""); setEventAt(localDateTimeValue());
    setEventPeople(profilePersonId ? [profilePersonId] : []);
    setEventAnalysisSources([]); setEventScopeConfirmed(false);
    setEventCreatorOpen(true);
  }

  async function saveWorkbenchEvent(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (eventCreatorOpen || !workbenchEventId) { if (savingWorkbenchEvent) return; setSavingWorkbenchEvent(true); try { await handleCreateEvent(event); } finally { if (isWorkspaceCurrent(generation)) setSavingWorkbenchEvent(false); } return; }
    if (!workbenchEvent || savingWorkbenchEvent) return;
    setSavingWorkbenchEvent(true);
    try {
      const updated = await api.updateEvent(workbenchEvent.id, { title: eventTitle.trim(), occurred_at: new Date(eventAt).toISOString(), person_ids: eventPeople, location: eventLocation.trim(), summary: eventSummary.trim(), expected_revision: workbenchEvent.revision });
      if (!isWorkspaceCurrent(generation)) return;
      setEvents(items => items.map(item => item.id === updated.id ? updated : item));
      setNotice({ kind: "success", text: `已保存事件“${updated.title}”。` });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;
 setNotice({ kind: "error", text: asMessage(error) }); }
    finally {
      if (isWorkspaceCurrent(generation)) { setSavingWorkbenchEvent(false);
      }
    }
  }

  async function analyzeWorkbenchEvent() {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (!workbenchEvent || !eventScopeConfirmed || !eventAnalysisSources.length || !eventEngineReady || eventHasUnsavedChanges || analyzingEvent) return;
    setAnalyzingEvent(true); setNotice(null);
    try {
      const updated = await api.analyzeEvent(workbenchEvent.id, { source_ids: eventAnalysisSources, engine: eventAnalysisEngine, scope_confirmed: true, expected_revision: workbenchEvent.revision });
      if (!isWorkspaceCurrent(generation)) return;
      setEvents(items => items.map(item => item.id === updated.id ? updated : item));
      setNotice({ kind: "success", text: "事件分析已完成，摘要和时间节点均为待核对候选，可点击原句查看依据。" });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;
 setNotice({ kind: "error", text: asMessage(error) }); }
    finally {
      if (isWorkspaceCurrent(generation)) { setAnalyzingEvent(false);
      }
    }
  }

  async function renameWorkbenchEventNode(nodeId: Id, label: string) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return false;

    if (!workbenchEvent || !label.trim() || analyzingEvent) return false;
    try {
      const updated = await api.updateEventNodeLabel(workbenchEvent.id, nodeId, { label: label.trim(), expected_revision: workbenchEvent.revision });
      if (!isWorkspaceCurrent(generation)) return false;
      setEvents(items => items.map(item => item.id === updated.id ? updated : item));
      setNotice({ kind: "success", text: "已更新候选节点名称，原文引用和时间保持不变。" });
      return true;
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return false;
 setNotice({ kind: "error", text: asMessage(error) }); return false; }
  }

  async function inspectEventQuote(sourceId: Id, start: number, end: number, expectedQuote?: string) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    const source = sources.find(item => item.id === sourceId);
    if (!source) return;
    const token = ++sourceInspectionToken.current;
    setInspectorLoading(true); setEventQuoteInspection(null); setInspectedEvidenceId("");
    try {
      const record = sourceRecords[sourceId] ?? await api.getRecord(sourceId);
      if (!isWorkspaceCurrent(generation)) return;
      if (token !== sourceInspectionToken.current) return;
      const rangeStart = codePointOffsetToUtf16(record.body, start);
      const rangeEnd = codePointOffsetToUtf16(record.body, end);
      const quote = record.body.slice(rangeStart, rangeEnd);
      if (!quote || (expectedQuote !== undefined && quote !== expectedQuote)) throw new Error("原文内容与节点引用不一致，请刷新资料后重新核对。");
      if (source.person_ids[0]) selectPerson(source.person_ids[0]);
      setSourceRecords(items => ({ ...items, [sourceId]: record }));
      setSelectedSourceId(sourceId); setEvidencePeople(source.person_ids); setEvidenceEvents(source.event_ids);
      setLocatorStart(rangeStart); setLocatorEnd(rangeEnd);
      setInspectorRecord(record); setEventQuoteInspection({ sourceId, start, end, quote });
      switchPersonView("evidence");
      setNotice({ kind: "info", text: "已定位事件节点的原文依据，引用仍待人工确认。" });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;
 if (token === sourceInspectionToken.current) { setInspectorRecord(null); setNotice({ kind: "error", text: asMessage(error) }); } }
    finally {
      if (isWorkspaceCurrent(generation)) { if (token === sourceInspectionToken.current) setInspectorLoading(false);
      }
    }
  }

  function openWorkbenchEventReport() {
    if (!workbenchEvent) return;
    selectReportPerson(workbenchEvent.person_ids[0] ?? "");
    setReportSources(sources.filter(item => item.event_ids.includes(workbenchEvent.id)).map(item => item.id));
    setAdvisorRequest(`围绕事件“${workbenchEvent.title}”整理经过、各方原话、已确认事项和待核对问题。`);
    setSelectedAnalysisTemplate(null);
    setReportKind("custom");
    setActiveView("reports");
    window.history.replaceState(null, "", "#reports");
  }

  async function handleImportSource(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    try {
      const created = await api.importText({
        title: sourceTitle.trim(),
        text: sourceText,
        source_kind: sourceKind,
        person_ids: sourcePeople,
        event_ids: sourceEvents,
      });
      if (!isWorkspaceCurrent(generation)) return;
      setSources((items) => [...items, created]);
      setSelectedSourceId(created.id);
      setSourceRecords((items) => ({
        ...items,
        [created.id]: {
          record: created as unknown as Record<string, unknown>,
          relative_path: created.original_path,
          body: sourceText,
          file_hash: created.sha256,
        },
      }));
      setEvidencePeople(created.person_ids);
      setEvidenceEvents(created.event_ids);
      setReportSources((ids) => [...new Set([...ids, created.id])]);
      setLocatorStart(0);
      setLocatorEnd(0);
      setSourceTitle("");
      setSourceText("");
      setNotice({
        kind: "success",
        text: "文档已加载，可选择分析任务并点击运行。原文已保存，也可从原文中创建引用。",
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    }
  }

  function changeAutofillText(text: string) {
    setAutofillText(text);
    setAutofillPreview(null);
    setAutofillSelected([]);
    setAutofillState("idle");
    setAutofillSavedPersonId("");
  }

  async function loadAutofillFile(file: File) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (file.size > 5 * 1024 * 1024) {
      setNotice({
        kind: "error",
        text: "单个自动填入文件不能超过 5 MiB；请先拆分为单人物资料。",
      });
      return;
    }
    try {
      const text = await file.text();
      if (!isWorkspaceCurrent(generation)) return;
      changeAutofillText(text);
      setAutofillTitle(file.name.replace(/\.[^.]+$/, "") || file.name);
      setNotice({
        kind: "info",
        text: `已读取“${file.name}”，原文件尚未写入；请先生成预览。`,
      });
    } catch {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: "无法读取该文本文件。" });
    }
  }

  async function handleAutofillPreview(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    setAutofillState("previewing");
    setNotice(null);
    try {
      const result = await api.previewProfileAutofill({
        text: autofillText,
        engine: autofillEngine,
        profile_id: "inherited",
      });
      if (!isWorkspaceCurrent(generation)) return;
      setAutofillPreview(result);
      setAutofillSelected(result.preview.candidates.map((_, index) => index));
      if (autofillTarget === "new") {
        setAutofillName(result.preview.person.display_name ?? "");
        setAutofillRelation(result.preview.person.relation_to_user ?? "");
      }
      setAutofillState("idle");
      setNotice({
        kind: "info",
        text:
          result.execution.engine === "local_demo"
            ? "本地规则预览已完成：只识别带明确字段名的内容，没有调用 AI。"
            : "AI 预览已完成：请核对人物、原文引用和候选条目后再保存。",
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setAutofillState("idle");
      setNotice({ kind: "error", text: asMessage(error) });
    }
  }

  async function handleAutofillSave() {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (
      !autofillPreview ||
      !autofillText.trim() ||
      !autofillSelected.length ||
      (autofillTarget === "new" &&
        (!autofillName.trim() || !autofillRelation.trim())) ||
      (autofillTarget === "existing" && !autofillPersonId)
    ) {
      return;
    }
    setAutofillState("saving");
    setNotice(null);
    try {
      const person =
        autofillTarget === "existing"
          ? people.find((item) => item.id === autofillPersonId)
          : await api.createPerson(
              autofillName.trim(),
              autofillRelation.trim(),
            );
      if (!isWorkspaceCurrent(generation)) return;
      if (!person) throw new Error("请选择要写入的联系人。");

      const source = await api.importText({
        title: autofillTitle.trim() || "AI 自动整理原始资料",
        text: autofillText,
        source_kind: "text",
        person_ids: [person.id],
        event_ids: [],
      });
      if (!isWorkspaceCurrent(generation)) return;
      const evidenceIds: Id[] = [];
      for (const index of autofillSelected) {
        const candidate = autofillPreview.preview.candidates[index];
        if (!candidate) continue;
        const createdEvidence = await api.createEvidence({
          source_id: source.id,
          quote: candidate.quote,
          locator: {
            kind: "text_quote",
            start: candidate.start,
            end: candidate.end,
          },
          evidence_kind: "direct_quote",
          reliability: candidate.confidence,
          person_ids: [person.id],
          event_ids: [],
        });
        if (!isWorkspaceCurrent(generation)) return;
        evidenceIds.push(createdEvidence.id);
        await api.addProfileEntry(person.id, {
          section: candidate.section,
          label: candidate.label,
          value: candidate.value,
          evidence_ids: [createdEvidence.id],
          origin: "ai",
          confirmation_status: "confirmed",
        });
        if (!isWorkspaceCurrent(generation)) return;
      }
      if (!evidenceIds.length) {
        throw new Error("没有可保存的候选条目。");
      }
      const report = await api.createReport({
        title: `${person.display_name} · 自动整理报告`,
        template_family: "person_long_term",
        template_variant: "overview",
        analysis_question:
          "请基于本次确认的信息，整理可核对的人物概览与下一步补充方向。",
        person_ids: [person.id],
        evidence_ids: evidenceIds,
        engine:
          autofillPreview.execution.engine === "local_demo"
            ? "safe_placeholder"
            : autofillPreview.execution.engine,
        profile_id: autofillPreview.execution.profile_id,
      });
      if (!isWorkspaceCurrent(generation)) return;
      await loadWorkspaceCollections();
      if (!isWorkspaceCurrent(generation)) return;
      setSourceRecords((items) => ({
        ...items,
        [source.id]: {
          record: source as unknown as Record<string, unknown>,
          relative_path: source.original_path,
          body: autofillText,
          file_hash: source.sha256,
        },
      }));
      setProfilePersonId(person.id);
      setCurrentReport(report);
      setReviewPersonId(person.id);
      setAutofillSavedPersonId(person.id);
      setAutofillState("saved");
      setNotice({
        kind: "success",
        text: `已保存原文、${evidenceIds.length} 条证据与人物条目，并生成报告。`,
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setAutofillState("idle");
      setNotice({ kind: "error", text: asMessage(error) });
    }
  }

  async function handleSaveLiveTranscript(input: LiveTranscriptSaveInput) {
    const generation = renderedWorkspaceGeneration;
    assertWorkspaceCurrent(generation);

    const transcript = await api.importText({
      title: input.title,
      text: input.text,
      source_kind: "text",
      person_ids: input.person_ids,
      event_ids: input.event_ids,
    });
    assertWorkspaceCurrent(generation);
    const analysis = input.analysis_text.trim()
      ? await api.importText({
          title: `${input.title} · 同步分析摘要`,
          text: input.analysis_text,
          source_kind: "user_observation",
          person_ids: input.person_ids,
          event_ids: input.event_ids,
        })
      : null;
    assertWorkspaceCurrent(generation);
    setSources((items) => [
      ...items,
      transcript,
      ...(analysis ? [analysis] : []),
    ]);
    setSelectedSourceId(transcript.id);
    setSourceRecords((items) => ({
      ...items,
      [transcript.id]: {
        record: transcript as unknown as Record<string, unknown>,
        relative_path: transcript.original_path,
        body: input.text,
        file_hash: transcript.sha256,
      },
      ...(analysis
        ? {
            [analysis.id]: {
              record: analysis as unknown as Record<string, unknown>,
              relative_path: analysis.original_path,
              body: input.analysis_text,
              file_hash: analysis.sha256,
            },
          }
        : {}),
    }));
    setEvidencePeople(transcript.person_ids);
    setEvidenceEvents(transcript.event_ids);
    setReportSources((ids) => [
      ...new Set([
        ...ids,
        transcript.id,
        ...(analysis ? [analysis.id] : []),
      ]),
    ]);
    setLocatorStart(0);
    setLocatorEnd(0);
    setSavedLiveSourceId(transcript.id);
    setNotice({
      kind: "success",
      text: analysis
        ? "会谈已自动归档到联系人材料；同步分析摘要仍待人工复核。"
        : "会谈转写已自动归档到联系人材料。",
    });
  }

  function goToEvidenceCreator() {
    const savedSource = sources.find((item) => item.id === savedLiveSourceId);
    if (savedSource?.person_ids[0]) {
      selectPerson(savedSource.person_ids[0]);
    }
    switchPersonView("evidence");
    window.setTimeout(() => {
      document
        .querySelector<HTMLSelectElement>("#evidence select")
        ?.focus();
    }, 0);
  }

  function acceptScreenshotFiles(files: File[]) {
    try {
      validateScreenshotFiles(files);
      setScreenshotFiles(files);
      setNotice({
        kind: "info",
        text: `已选择 ${files.length} 张截图，请核对顺序和关联人物后上传。`,
      });
    } catch (error) {
      setScreenshotFiles([]);
      setNotice({ kind: "error", text: asMessage(error) });
    }
  }

  function handleScreenshotDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDraggingScreenshots(false);
    acceptScreenshotFiles(Array.from(event.dataTransfer.files));
  }

  async function handleUploadScreenshots(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    setUploadingScreenshots(true);
    try {
      const result = await api.uploadScreenshotBatch({
        title: screenshotTitle.trim(),
        person_ids: screenshotPeople,
        event_ids: screenshotEvents,
        files: screenshotFiles,
      });
      if (!isWorkspaceCurrent(generation)) return;
      setSources((items) => [
        ...items.filter(
          (item) => !result.items.some((created) => created.id === item.id),
        ),
        ...result.items,
      ]);
      const first = result.items[0];
      if (first) {
        setSelectedScreenshotId(first.id);
        setScreenshotSegments([
          { order: 0, speaker: "unknown", text: "", uncertainty: "high" },
        ]);
      }
      setScreenshotFiles([]);
      setNotice({
        kind: "success",
        text: `${result.items.length} 张截图已按选择顺序保存，等待逐张确认转写。`,
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setUploadingScreenshots(false);
      }
    }
  }

  function chooseScreenshot(sourceId: Id) {
    setSelectedScreenshotId(sourceId);
    setScreenshotSegments([
      { order: 0, speaker: "unknown", text: "", uncertainty: "high" },
    ]);
  }

  function updateScreenshotSegment(
    index: number,
    patch: Partial<ScreenshotSegmentInput>,
  ) {
    setScreenshotSegments((items) =>
      items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  }

  function addScreenshotSegment() {
    setScreenshotSegments((items) => [
      ...items,
      {
        order: items.length,
        speaker: "unknown",
        text: "",
        uncertainty: "high",
      },
    ]);
  }

  async function handleConfirmTranscript(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (!selectedScreenshot) return;
    setConfirmingTranscript(true);
    try {
      const result = await api.confirmScreenshotTranscript(
        selectedScreenshot.id,
        screenshotSegments,
      );
      if (!isWorkspaceCurrent(generation)) return;
      setSources((items) =>
        items.map((item) =>
          item.id === result.source.id ? result.source : item,
        ),
      );
      const evidenceResult = await api.listEvidence();
      if (!isWorkspaceCurrent(generation)) return;
      setEvidence(evidenceResult.items);
      setNotice({
        kind: "success",
        text: `截图转写已确认，并刷新 ${evidenceResult.items.length} 条证据。`,
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setConfirmingTranscript(false);
      }
    }
  }

  async function chooseSource(id: string) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return false;

    const request = ++sourceRequestGeneration.current;
    setSelectedSourceId(id);
    setLocatorStart(0);
    setLocatorEnd(0);
    const source = sources.find((item) => item.id === id);
    setEvidencePeople(source?.person_ids ?? []);
    setEvidenceEvents(source?.event_ids ?? []);
    let record = sourceRecords[id];
    if (!record) {
      try {
        record = await api.getRecord(id);
        if (!isWorkspaceCurrent(generation) || request !== sourceRequestGeneration.current) return false;
        const loaded = record;
        setSourceRecords((items) => ({ ...items, [id]: loaded }));
      } catch (error) {
      if (!isWorkspaceCurrent(generation) || request !== sourceRequestGeneration.current) return false;

        setNotice({ kind: "error", text: asMessage(error) });
        return false;
      }
    }
    return record;
  }

  async function openSourceForEvidence(id: string) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (!(await chooseSource(id))) return;
    if (!isWorkspaceCurrent(generation)) return;
    const source = sources.find((item) => item.id === id);
    if (source?.person_ids[0]) {
      selectPerson(source.person_ids[0]);
    }
    switchPersonView("evidence");
  }

  async function openWorkbenchSource(source: SourceRecord) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (source.person_ids[0]) selectPerson(source.person_ids[0]);
    const record = await chooseSource(source.id);
    if (!record) return;
    if (!isWorkspaceCurrent(generation)) return;
    setInspectedEvidenceId(""); setEventQuoteInspection(null); setInspectorRecord(record);
    switchPersonView("evidence");
    setNotice({ kind: "info", text: "文档已加载，可选择分析任务并点击运行。" });
  }

  async function handleCreateEvidence(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    try {
      const created = await api.createEvidence({
        source_id: selectedSourceId,
        quote: selectedQuote,
        locator: {
          kind: "text_quote",
          start: codePointLocatorStart,
          end: codePointLocatorEnd,
        },
        evidence_kind: evidenceKind,
        reliability,
        person_ids: evidencePeople,
        event_ids: evidenceEvents,
      });
      if (!isWorkspaceCurrent(generation)) return;
      setEvidence((items) => [...items, created]);
      setReportSources((ids) => [
        ...new Set([...ids, created.source_id]),
      ]);
      setLocatorStart(0);
      setLocatorEnd(0);
      setNotice({
        kind: "success",
        text: "原子证据已创建，locator 与原文片段一并保存。",
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    }
  }

  async function inspectEvidence(id: string) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    const item = evidence.find((entry) => entry.id === id);
    if (!item) return;
    const token = ++sourceInspectionToken.current;
    setEventQuoteInspection(null);
    setInspectedEvidenceId(id);
    setInspectorLoading(true);
    try {
      const record = await api.getRecord(item.source_id);
      if (!isWorkspaceCurrent(generation)) return;
      if (token === sourceInspectionToken.current) setInspectorRecord(record);
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      if (token === sourceInspectionToken.current) { setInspectorRecord(null); setNotice({ kind: "error", text: asMessage(error) }); }
    } finally {
      if (isWorkspaceCurrent(generation)) { if (token === sourceInspectionToken.current) setInspectorLoading(false);
      }
    }
  }

  function applyAdvisorResult(
    result: ReportAdvisorResponse,
    knownEvidence: EvidenceRecord[] = evidence,
    personId: string = advisorPersonId,
  ) {
    setAdvisorResult(result);
    if (result.status !== "ready") return;
    setReportKind(
      reportKindFor(
        result.proposed_report.template_family,
        result.proposed_report.template_variant,
      ),
    );
    const selected = knownEvidence.filter((item) =>
      result.evidence_ids.includes(item.id),
    );
    setReportSources(
      Array.from(new Set(selected.map((item) => item.source_id))),
    );
    setReportConfirmed(false);
  }

  async function handleAdvisorAnswer(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    const answer = advisorAnswer.trim();
    if (!advisorPersonId || !answer) return;
    setAdvisorBusy(true);
    setNotice(null);
    try {
      const createdSource = await api.importText({
        title: `报告助手补充回答 · ${new Date().toLocaleDateString("zh-CN")}`,
        text: answer,
        source_kind: "user_observation",
        person_ids: [advisorPersonId],
        event_ids: [],
      });
      if (!isWorkspaceCurrent(generation)) return;
      const createdEvidence = await api.createEvidence({
        source_id: createdSource.id,
        quote: answer,
        locator: {
          kind: "text_quote",
          start: 0,
          end: Array.from(answer).length,
        },
        evidence_kind: "user_statement",
        reliability: "medium",
        person_ids: [advisorPersonId],
        event_ids: [],
      });
      if (!isWorkspaceCurrent(generation)) return;
      const result = await api.previewReportAdvisor({
        person_id: advisorPersonId,
        request_text: reportRequestText,
        evidence_ids: [createdEvidence.id],
      });
      if (!isWorkspaceCurrent(generation)) return;
      applyAdvisorResult(result, [...evidence, createdEvidence]);
      await loadWorkspaceCollections();
      if (!isWorkspaceCurrent(generation)) return;
      setAdvisorAnswer("");
      setNotice({
        kind: "success",
        text:
          result.status === "ready"
            ? "补充回答已保存为原始材料，可以确认生成报告。"
            : "补充回答已保存为原始材料；仍可继续回答或上传更多材料。",
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setAdvisorBusy(false);
      }
    }
  }

  async function handleCreateReport(event: FormEvent) {
    event.preventDefault();
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return;

    if (!reportConfirmed) {
      setNotice({
        kind: "error",
        text: "请先核对本次选择的原始材料，再确认生成报告。",
      });
      return;
    }
    if (!advisorPersonId) {
      setNotice({ kind: "error", text: "请先选择报告是关于谁的。" });
      return;
    }
    setCreatingReport(true);
    setNotice(null);
    try {
      const preparedEvidence = [...selectedReportEvidence];
      const preparedSourceIds = new Set(
        preparedEvidence.map((item) => item.source_id),
      );
      const createdEvidence: EvidenceRecord[] = [];
      for (const source of selectedReportSources) {
        if (preparedSourceIds.has(source.id)) continue;
        if (source.source_kind === "screenshot") {
          throw new Error(
            `材料“${source.title}”是截图且尚无已确认引用；请改选文本材料或先人工确认转写。`,
          );
        }
        const record = sourceRecords[source.id] ?? (await api.getRecord(source.id));
        if (!isWorkspaceCurrent(generation)) return;
        const sourceQuotes = directQuotes(record.body, source.source_kind);
        if (!sourceQuotes.length) {
          throw new Error(`材料“${source.title}”没有可直接引用的文本。`);
        }
        for (const directQuote of sourceQuotes) {
          const created = await api.createEvidence({
            source_id: source.id,
            quote: directQuote.quote,
            locator: {
              kind: "text_quote",
              start: directQuote.start,
              end: directQuote.end,
            },
            evidence_kind: "direct_quote",
            reliability: "high",
            person_ids: source.person_ids,
            event_ids: source.event_ids,
          });
          if (!isWorkspaceCurrent(generation)) return;
          createdEvidence.push(created);
          preparedEvidence.push(created);
        }
        preparedSourceIds.add(source.id);
      }
      if (createdEvidence.length) {
        setEvidence((items) => [...items, ...createdEvidence]);
      }
      const preview = await api.previewReportAdvisor({
        person_id: advisorPersonId,
        request_text: reportRequestText,
        evidence_ids: preparedEvidence.map((item) => item.id),
        template_family: reportUpdateTopic?.template_family ?? selectedAnalysisTemplate?.template_family ?? selectedReportKind.family,
        template_variant: reportUpdateTopic?.template_variant ?? selectedAnalysisTemplate?.template_variant ?? selectedReportKind.variant,
      });
      if (!isWorkspaceCurrent(generation)) return;
      setAdvisorResult(preview);
      if (preview.status === "needs_input") {
        setNotice({
          kind: "info",
          text: "现有资料还不够，先回答下面的问题或补充原始材料。",
        });
        return;
      }
      const personName =
        people.find((item) => item.id === advisorPersonId)?.display_name ??
        "人物";
      const selectedEvidenceIds = preview.evidence_ids.length
        ? preview.evidence_ids
        : preparedEvidence.map((item) => item.id);
      const created = await api.createReport({
        ...(reportUpdateTopic ? { topic_id: reportUpdateTopic.id, expected_revision: reportUpdateTopic.revision } : {}),
        ...(includeCharts && plottingCapabilities?.available ? { include_charts: true } : {}),
        title: reportUpdateTopic?.title ?? `${personName} · ${selectedReportKind.label}`,
        template_family: reportUpdateTopic?.template_family ?? selectedAnalysisTemplate?.template_family ?? selectedReportKind.family,
        template_variant: reportUpdateTopic?.template_variant ?? selectedAnalysisTemplate?.template_variant ?? selectedReportKind.variant,
        analysis_question: reportRequestText,
        person_ids: reportUpdateTopic?.person_ids ?? [advisorPersonId],
        evidence_ids: selectedEvidenceIds,
        ...(preferences.textEngine !== "local_demo"
          ? { engine: preferences.textEngine }
          : {}),
      });
      if (!isWorkspaceCurrent(generation)) return;
      setCurrentReport(created);
      setReviewPersonId(created.topic.person_ids[0] ?? "");
      setClaimReviews({});
      setReports((items) => [
        ...items.filter((item) => item.topic.id !== created.topic.id),
        {
          topic: created.topic,
          snapshot: created.snapshot,
          analysis: created.analysis,
          execution: created.execution,
        },
      ]);
      setReportConfirmed(false);
      setReportMode("read");
      setNotice({
        kind: "success",
        text: `报告“${created.topic.title}”版本 ${created.snapshot.version} 已生成。`,
      });
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return;

      setNotice({ kind: "error", text: asMessage(error) });
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setCreatingReport(false);
      }
    }
  }

  function openReportForReading(item: ReportListItem) {
    if (!item.analysis) {
      setNotice({
        kind: "error",
        text: "这份历史记录缺少报告内容，请刷新工作区后重试。",
      });
      return;
    }
    const execution = item.execution ?? {
      engine: "safe_placeholder" as const,
      profile_id: "legacy_report",
      material_scope: item.analysis.material_scope,
      data_destination: "local_only" as const,
      degraded: item.snapshot.generation_kind === "safe_placeholder",
      degraded_reason: "历史报告未记录执行器信息。",
    };
    setCurrentReport({
      topic: item.topic,
      snapshot: item.snapshot,
      analysis: item.analysis,
      execution,
    });
    setReviewPersonId(
      reportContextPersonId && item.topic.person_ids.includes(reportContextPersonId)
        ? reportContextPersonId
        : item.topic.person_ids.length === 1 ? item.topic.person_ids[0] : "",
    );
    setActiveView("reports");
    setReportContextPersonId(item.topic.person_ids.includes(profilePersonId) ? profilePersonId : item.topic.person_ids[0] ?? "");
    window.history.replaceState(null, "", "#reports");
    setClaimReviews({});
    setReportMode("read");
  }

  async function handleAcceptClaim(
    key: string,
    claim: AnalysisClaim,
  ) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return false;

    if (!reviewPersonId) {
      setNotice({ kind: "error", text: "请先选择这条描述要写入的人物。" });
      return false;
    }
    setReviewingClaim(key);
    try {
      const updated = await api.addProfileEntry(reviewPersonId, {
        section: "user_observations",
        label: "AI 候选描述",
        value: claim.text,
        evidence_ids: claim.evidence_ids,
        origin: "ai",
        confirmation_status: "confirmed",
      });
      if (!isWorkspaceCurrent(generation)) return false;
      setPeople((items) =>
        items.map((person) =>
          person.id === updated.id ? updated : person,
        ),
      );
      setClaimReviews((items) => ({ ...items, [key]: "accepted" }));
      setNotice(null);
      return true;
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return false;

      setNotice({ kind: "error", text: asMessage(error) });
      return false;
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setReviewingClaim("");
      }
    }
  }

  async function handleRejectClaim(
    key: string,
    claim: AnalysisClaim,
  ) {
    const generation = renderedWorkspaceGeneration;
    if (!isWorkspaceCurrent(generation)) return false;

    if (!reviewPersonId) {
      setNotice({ kind: "error", text: "请先选择这条描述属于哪位人物。" });
      return false;
    }
    setReviewingClaim(key);
    try {
      const updated = await api.addProfileEntry(reviewPersonId, {
        section: "user_observations",
        label: "AI 候选描述",
        value: claim.text,
        evidence_ids: claim.evidence_ids,
        origin: "ai",
        confirmation_status: "rejected",
      });
      if (!isWorkspaceCurrent(generation)) return false;
      setPeople((items) =>
        items.map((person) =>
          person.id === updated.id ? updated : person,
        ),
      );
      setClaimReviews((items) => ({ ...items, [key]: "rejected" }));
      setNotice(null);
      return true;
    } catch (error) {
      if (!isWorkspaceCurrent(generation)) return false;

      setNotice({ kind: "error", text: asMessage(error) });
      return false;
    } finally {
      if (isWorkspaceCurrent(generation)) {
        setReviewingClaim("");
      }
    }
  }

  const eventEditor = (<form className="form-stack compact-form" onSubmit={(event) => void saveWorkbenchEvent(event)}>
            <label>事件名称<input required value={eventTitle} onChange={event => setEventTitle(event.target.value)} /></label>
            <div className="form-row"><label>事件时间<input type="datetime-local" required value={eventAt} onChange={event => setEventAt(event.target.value)} /></label><label>事件地点<input value={eventLocation} onChange={event => setEventLocation(event.target.value)} maxLength={500} /></label></div>
            <label>事件简述<textarea value={eventSummary} onChange={event => setEventSummary(event.target.value)} rows={3} maxLength={10000} /></label>
            <CheckboxList label="参与人物" items={people} selected={eventPeople} onChange={setEventPeople} render={person => person.display_name} />
            <div className="form-row"><button type="submit" className="primary-button" disabled={!openedPath || !eventPeople.length || savingWorkbenchEvent}>{savingWorkbenchEvent ? "正在保存…" : !eventCreatorOpen && workbenchEvent ? "保存事件信息" : "创建并关联事件"}</button>{!eventCreatorOpen && workbenchEvent && <button type="button" className="secondary-button" onClick={openWorkbenchEventReport}>基于事件材料准备报告</button>}</div>
          </form>);

  return (
    <Workbench
      activeView={activeView}
      pageLabel={preferences.language === "en" ? VIEW_ENGLISH_LABELS[activeView] : selectedView.label}
      openedPath={openedPath}
      people={people}
      person={profilePerson}
      subjectType={analysisObjectType}
      onSubjectTypeChange={setAnalysisObjectType}
      events={events}
      event={workbenchEvent}
      onSelectEvent={selectWorkbenchEvent}
      onNewEvent={newWorkbenchEvent}
      onInspectEventQuote={(sourceId, start, end, quote) => void inspectEventQuote(sourceId, start, end, quote)}
      onRenameEventNode={renameWorkbenchEventNode}
      onPrepareReport={() => openReports(profilePersonId, "generate")}
      onRun={() => { if (activeView === "events") void analyzeWorkbenchEvent(); else document.querySelector<HTMLFormElement>(".report-questionnaire")?.requestSubmit(); }}
      runEnabled={(activeView === "events" && Boolean(workbenchEvent) && eventAnalysisSources.length > 0 && eventScopeConfirmed && eventEngineReady && !eventHasUnsavedChanges && !analyzingEvent) || (activeView === "reports" && reportMode === "generate" && Boolean(advisorPersonId) && selectedReportSources.length > 0 && reportConfirmed && !creatingReport)}
      sources={sources}
      reports={reports}
      currentReportTopicId={currentReport?.topic.id ?? ""}
      onNavigate={view => { if (view === "settings") setSettingsTab("models"); switchView(view); }}
      onNewPerson={createPersonFromToolbar}
      onRefresh={() => void handleRefreshWorkspace()}
      refreshing={refreshing}
      onSelectPerson={(id) => { setAnalysisObjectType("person"); selectPerson(id); }}
      onBrowsePerson={switchPersonView}
      onOpenSource={(source) => void openWorkbenchSource(source)}
      onOpenReport={openReportForReading}
      onLiveAnalysisContainer={setLiveAnalysisContainer}
      inspectedEvidenceId={inspectedEvidenceId}
      navigation={
      <aside className="left-rail">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            桥
          </div>
          <div>
            <strong>灵犀桥</strong>
            <span>
              {preferences.language === "en"
                ? "AI relationship workspace"
                : "AI 关系工作台"}
            </span>
          </div>
        </div>
        <div className="rail-group">
          <span className="rail-group-label">
            {preferences.language === "en" ? "AI workspace" : "AI 工作区"}
          </span>
          <nav
            aria-label={
              preferences.language === "en" ? "AI workspace" : "AI 工作区"
            }
          >
            <div className="rail-nav-entry">
              <div className="rail-nav-row">
                <button
                  className={activeView === "assistant" ? "is-active" : ""}
                  type="button"
                  aria-current={
                    activeView === "assistant" ? "page" : undefined
                  }
                  onClick={() => {
                    setActiveView("assistant");
                    window.history.replaceState(null, "", "#assistant");
                  }}
                >
                  <span aria-hidden="true">{VIEW_COPY.assistant.icon}</span>
                  AI 工作台
                  <small aria-hidden="true">
                    {workspaceConversations.length || ""}
                  </small>
                </button>
                <button
                  className="rail-disclosure"
                  type="button"
                  aria-label={
                    assistantExpanded
                      ? "收起 AI 对话历史"
                      : "展开 AI 对话历史"
                  }
                  aria-expanded={assistantExpanded}
                  onClick={() => setAssistantExpanded((current) => !current)}
                >
                  <span aria-hidden="true">
                    {assistantExpanded ? "⌄" : "›"}
                  </span>
                </button>
              </div>
              {assistantExpanded && (
                <div className="rail-children rail-history" aria-label="AI 对话历史">
                  {workspaceConversations.slice(0, 8).map((conversation) => (
                    <button
                      className={
                        assistantConversationId === conversation.id
                          ? "is-selected"
                          : ""
                      }
                      type="button"
                      key={conversation.id}
                      title={conversation.title}
                      onClick={() => openAiConversation(conversation.id)}
                    >
                      <span aria-hidden="true">⌁</span>
                      <span>
                        <strong>{conversation.title}</strong>
                        <small>
                          {new Intl.DateTimeFormat("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                          }).format(new Date(conversation.updated_at))}
                        </small>
                      </span>
                    </button>
                  ))}
                  {!workspaceConversations.length && (
                    <p>还没有 AI 对话</p>
                  )}
                </div>
              )}
            </div>
            <button
              className={activeView === "mobile" ? "is-active" : ""}
              type="button"
              aria-current={activeView === "mobile" ? "page" : undefined}
              onClick={() => switchView("mobile")}
            >
              <span aria-hidden="true">{VIEW_COPY.mobile.icon}</span>手机
            </button>
            <button
              className={activeView === "autofill" ? "is-active" : ""}
              type="button"
              aria-current={activeView === "autofill" ? "page" : undefined}
              onClick={() => switchView("autofill")}
            >
              <span aria-hidden="true">{VIEW_COPY.autofill.icon}</span>
              AI 自动填入
            </button>
            <div className="rail-divider" role="separator" />
            <div className="rail-nav-entry">
              <div className="rail-nav-row">
                <button
                  className={activeView === "live" ? "is-active" : ""}
                  type="button"
                  aria-current={activeView === "live" ? "page" : undefined}
                  onClick={() => switchView("live")}
                >
                  <span aria-hidden="true">{VIEW_COPY.live.icon}</span>
                  会谈录音
                  <small aria-hidden="true">
                    {liveHistorySources.length || ""}
                  </small>
                </button>
                <button
                  className="rail-disclosure"
                  type="button"
                  aria-label={
                    liveExpanded ? "收起会谈历史" : "展开会谈历史"
                  }
                  aria-expanded={liveExpanded}
                  onClick={() => setLiveExpanded((current) => !current)}
                >
                  <span aria-hidden="true">
                    {liveExpanded ? "⌄" : "›"}
                  </span>
                </button>
              </div>
              {liveExpanded && (
                <div className="rail-children rail-history" aria-label="会谈历史">
                  {liveHistorySources.slice(0, 8).map((source) => (
                    <button
                      type="button"
                      key={source.id}
                      title={source.title}
                      onClick={() => openLiveHistory(source)}
                    >
                      <span aria-hidden="true">声</span>
                      <span>
                        <strong>{source.title}</strong>
                      </span>
                    </button>
                  ))}
                  {!liveHistorySources.length && <p>还没有会谈记录</p>}
                </div>
              )}
            </div>
          </nav>
        </div>
        <div className="rail-group">
          <span className="rail-group-label">
            {preferences.language === "en" ? "People & reports" : "人物与报告"}
          </span>
          <nav aria-label="人物与报告">
            <div className="rail-nav-entry">
              <button
                className={activeView === "people" ? "is-active" : ""}
                type="button"
                aria-current={activeView === "people" ? "page" : undefined}
                aria-expanded={peopleExpanded}
                onClick={() => switchView("people")}
              >
                <span aria-hidden="true">{VIEW_COPY.people.icon}</span>
                通讯录
                <small aria-hidden="true">
                  {people.length || ""}
                  <b>{peopleExpanded ? "⌄" : "›"}</b>
                </small>
              </button>
              {peopleExpanded && (
                <div className="rail-people rail-children" aria-label="联系人">
                  {people.map((person) => (
                    <button
                      className={
                        profilePersonId === person.id ? "is-selected" : ""
                      }
                      type="button"
                      key={person.id}
                      onClick={() => {
                        setAnalysisObjectType("person");
                        selectPerson(person.id);
                        switchPersonView("profile");
                      }}
                    >
                      <span aria-hidden="true">
                        {person.display_name.slice(0, 1)}
                      </span>
                      <span>
                        <strong>{person.display_name}</strong>
                        <small>{person.relation_to_user}</small>
                      </span>
                    </button>
                  ))}
                  <button
                    className="rail-new-person"
                    type="button"
                    onClick={createPersonFromToolbar}
                  >
                    <span aria-hidden="true">＋</span>
                    新建联系人
                  </button>
                </div>
              )}
            </div>
            <button
              className={activeView === "reports" ? "is-active" : ""}
              type="button"
              aria-current={activeView === "reports" ? "page" : undefined}
              onClick={() =>
                openLatestReport(reportContextPersonId || profilePersonId)
              }
            >
              <span aria-hidden="true">{VIEW_COPY.reports.icon}</span>
              {reportContextPerson
                ? `${reportContextPerson.display_name}的报告`
                : "报告"}
            </button>
          </nav>
        </div>
        <div className="rail-group utility-group">
          <span className="rail-group-label">
            {preferences.language === "en" ? "Data tools" : "资料工具"}
          </span>
          <nav
            aria-label={preferences.language === "en" ? "Data tools" : "资料工具"}
          >
            {DATA_TOOL_VIEWS.map((view) => {
              const item = VIEW_COPY[view];
              return (
                <button
                  className={activeView === view ? "is-active" : ""}
                  type="button"
                  key={view}
                  aria-current={activeView === view ? "page" : undefined}
                  onClick={() => switchView(view)}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {preferences.language === "en"
                    ? VIEW_ENGLISH_LABELS[view]
                    : item.label}
                </button>
              );
            })}
          </nav>
        </div>
      </aside>
      }
      topbar={
        <TopToolbar
          activeTarget={activeView}
          pageLabel={
            preferences.language === "en"
              ? VIEW_ENGLISH_LABELS[activeView]
              : selectedView.label
          }
          openedPath={openedPath}
          executors={executors}
          preferences={preferences}
          onNavigate={(target: ToolbarTarget) => switchView(target)}
          onNewConversation={startNewAiConversation}
        />
      }
      content={
      <main
        key={openedPath}
        className={`main-column ${
          activeView === "reports" ? "report-workspace-active" : ""
        }`}
      >



        {notice && !dialogView && !personCreatorOpen && !eventCreatorOpen && (
          <div className={`notice ${notice.kind}`} role="alert">
            <span>{notice.kind === "error" ? "!" : "✓"}</span>
            <p>{notice.text}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
        )}


        {dialogView === "settings" && (<WorkbenchDialog title="设置" onClose={() => setDialogView(null)}>{notice?.kind === "error" && <p role="alert">{notice.text}</p>}
          <SettingsCenter
            preferences={preferences}
            executors={executors}
            openedPath={openedPath}
            activeTab={settingsTab}
            onTabChange={switchSettingsTab}
            onChange={setPreferences}
            onStartGuide={() => { setDialogView(null); setOnboardingOpen(true); }}
            onUseTemplate={applyAnalysisTemplate}
            onUseDefaultWorkspace={() => void handleUseDefaultWorkspace()}
            onChooseWorkspace={() => void handleSelectWorkspace()}
            workspaceBusy={opening || selectingWorkspace}
          /></WorkbenchDialog>
        )}
        {dialogView === "usage" && (<WorkbenchDialog title="资料统计" onClose={() => setDialogView(null)}>{notice?.kind === "error" && <p role="alert">{notice.text}</p>}
          <UsageCenter
            preferences={preferences}
            openedPath={openedPath}
            sources={sources}
            evidence={evidence}
            reports={reports}
          /></WorkbenchDialog>
        )}
        {dialogView === "data" && (<WorkbenchDialog title="管理与导出" onClose={() => setDialogView(null)}>{notice?.kind === "error" && <p role="alert">{notice.text}</p>}
          <DataManagementCenter
            preferences={preferences}
            openedPath={openedPath}
            people={people}
            events={events}
            sources={sources}
            evidence={evidence}
            reports={reports}
            onOpenContacts={() => switchView("people")}
          /></WorkbenchDialog>
        )}
        {dialogView === "help" && (<WorkbenchDialog title="使用帮助" onClose={() => setDialogView(null)}>{notice?.kind === "error" && <p role="alert">{notice.text}</p>}
          <HelpCenter
            preferences={preferences}
            openedPath={openedPath}
            onStartGuide={() => { setDialogView(null); setOnboardingOpen(true); }}
            onNavigate={navigateToGuideTarget}
          /></WorkbenchDialog>
        )}

        <Section id="event-workspace" title="事件工作区" visible={activeView === "events"}>
          {workbenchEvent?.analysis && <article className="event-analysis-result"><header><h3>事件分析摘要</h3><span>待核对候选</span></header><p>{workbenchEvent.analysis.summary}</p><small>{new Date(workbenchEvent.analysis.generated_at).toLocaleString("zh-CN")} · {workbenchEvent.analysis.engine} · {workbenchEvent.analysis.source_ids.length}份材料</small><ol className="event-node-summary">{workbenchEvent.analysis.nodes.map(node => <li key={node.id}><time>{formatEventNodeTime(node.timestamp_ms)}</time><span>{node.label}</span><button type="button" onClick={() => void inspectEventQuote(node.source_id, node.quote_start, node.quote_end, node.quote)}>查看原句</button></li>)}</ol></article>}

          <div className="subsection-heading"><h3>{workbenchEvent ? "编辑事件" : "新建事件"}</h3><button type="button" className="secondary-button" onClick={newWorkbenchEvent}>新建事件</button></div>
          {workbenchEvent && <details className="event-metadata-editor"><summary>事件信息与编辑</summary>{eventEditor}</details>}
          {workbenchEvent && <section className="event-analysis-controls" aria-label="事件分析任务"><h3>分析材料与方法</h3><label>事件分析执行器<select value={eventAnalysisEngine} onChange={event => { setEventAnalysisEngine(event.target.value as "api" | "claude" | "codex"); setEventScopeConfirmed(false); }} disabled={analyzingEvent}><option value="api">API · 设置中的模型与地址</option>{executors.map(item => <option value={item.engine} key={item.engine} disabled={!item.available}>{item.name}{item.available ? "" : "（不可用）"}</option>)}</select></label><p className="empty-note">{eventAnalysisEngine === "api" ? `API：${eventDirectSettings?.base_url || "尚未配置地址"} · ${eventDirectSettings?.model || "尚未配置模型"}` : `${eventAnalysisEngine === "claude" ? "Claude Code" : "Codex"} · 沿用本机配置与服务去向`}{!eventEngineReady ? "；请先在设置中完成配置。" : ""}</p><CheckboxList label="用于事件分析的材料" items={workbenchEventSources} selected={eventAnalysisSources} onChange={ids => { setEventAnalysisSources(ids); setEventScopeConfirmed(false); }} render={source => source.title} /><label className="report-confirm-check"><input type="checkbox" checked={eventScopeConfirmed} onChange={event => setEventScopeConfirmed(event.target.checked)} disabled={analyzingEvent || !eventAnalysisSources.length} />我已确认将勾选的文本或转写材料交给上述执行器，用于事件摘要和候选节点分析。</label>{eventHasUnsavedChanges && <p className="empty-note">事件信息有未保存修改，请先保存后分析。</p>}<button type="button" className="primary-button" disabled={!eventScopeConfirmed || !eventAnalysisSources.length || !eventEngineReady || eventHasUnsavedChanges || analyzingEvent} onClick={() => void analyzeWorkbenchEvent()}>{analyzingEvent ? "正在分析事件…" : "运行事件分析"}</button></section>}
          {workbenchEvent && <div className="source-library-grid">{sources.filter(item => item.event_ids.includes(workbenchEvent.id)).map(source => <button className="secondary-button" key={source.id} type="button" onClick={() => { const id = source.person_ids[0]; if (id) selectPerson(id); setSelectedSourceId(source.id); switchPersonView("sources"); }}>{source.title}</button>)}</div>}
        </Section>

        <Section id="assistant" title="工作台" visible={activeView === "assistant"}>
          <div className="workbench-welcome"><h3>资料、报告与依据在同一工作台</h3><p>从左侧选择人物和材料，或在右下角交代任务。报告与来源保留在各自的工作区。</p><button className="secondary-button" type="button" onClick={() => switchView("people")}>浏览通讯录</button><button className="secondary-button" type="button" onClick={() => openReports()}>打开报告工作区</button></div>
        </Section>

        {dialogView === "workspace" && <WorkbenchDialog title="打开工作区" onClose={() => setDialogView(null)}>{notice?.kind === "error" && <p role="alert">{notice.text}</p>}
          <div className="workspace-picker">
            <div>
              <span>当前工作区</span>
              <code>{openedPath || workspacePath || "尚未选择"}</code>
            </div>
            <div className="workspace-actions">
              {window.lingxiDesktop && (
                <button
                  className="secondary-button"
                  disabled={selectingWorkspace}
                  type="button"
                  onClick={() => void handleSelectWorkspace()}
                >
                  {selectingWorkspace ? "正在选择…" : "选择文件夹"}
                </button>
              )}
              <button
                className="primary-button"
                disabled={opening || selectingWorkspace}
                type="button"
                onClick={() => void handleUseDefaultWorkspace()}
              >
                {opening ? "正在打开…" : "使用默认工作区"}
              </button>
            </div>
          </div>
          {openedPath && (
            <div className="opened-workspace">
              <div>
                <span>当前工作区 · 本地保存</span>
                <code>{openedPath}</code>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={refreshing}
                onClick={() => void handleRefreshWorkspace()}
              >
                {refreshing ? "正在刷新…" : "刷新工作区"}
              </button>
            </div>
          )}
        </WorkbenchDialog>}



        <div
          className={[
            !openedPath &&
            activeView !== "workspace" &&
            activeView !== "assistant" &&
            activeView !== "live" &&
            !isControlView
              ? "locked-content"
              : "",
            activeView === "reports" ? "report-workspace-shell" : "",
            activeView === "mobile" ? "mobile-workspace-shell" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {!openedPath &&
            activeView !== "workspace" &&
            activeView !== "assistant" &&
            activeView !== "live" &&
            !isControlView && (
            <div className="locked-overlay">
              <span>先打开工作区，后续写入才会启用</span>
            </div>
          )}
          {activeView === "mobile" && <MobilePanel workspacePath={openedPath || null} />}

          <Section
            id="autofill"
            title="整理资料"
            visible={activeView === "autofill"}
          >
            <form className="autofill-form" onSubmit={handleAutofillPreview}>
              <div className="form-row">
                <label>
                  原始材料标题
                  <input
                    value={autofillTitle}
                    maxLength={200}
                    required
                    onChange={(event) => setAutofillTitle(event.target.value)}
                  />
                </label>
                <label>
                  整理方式
                  <select
                    value={autofillEngine}
                    onChange={(event) => {
                      setAutofillEngine(
                        event.target.value as
                          | "local_demo"
                          | "claude"
                          | "codex"
                          | "api",
                      );
                      setAutofillPreview(null);
                      setAutofillSelected([]);
                      setAutofillState("idle");
                    }}
                  >
                    <option value="local_demo">本地规则预览（不调用 AI）</option>
                    <option value="api">API 分析（使用设置中的模型）</option>
                    {executors.map((executor) => (
                      <option
                        key={executor.engine}
                        value={executor.engine}
                        disabled={!executor.available}
                      >
                        {executor.name}
                        {executor.available ? "" : "（当前不可用）"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="autofill-file">
                导入文本文件（TXT / Markdown / JSON / CSV，最大 5 MiB）
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.json,.csv,text/plain,text/markdown,application/json,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadAutofillFile(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <label>
                原始长文本
                <textarea
                  rows={11}
                  value={autofillText}
                  required
                  maxLength={2_000_000}
                  placeholder={
                    "示例：\n姓名：林舟\n关系：朋友\n职业：建筑设计师\n喜欢：徒步和黑咖啡\n聊天：他说希望先把问题讲清楚。"
                  }
                  onChange={(event) => changeAutofillText(event.target.value)}
                />
              </label>
              {autofillEngine !== "local_demo" && (
                <p className="hint">发送此文本至 {autofillEngine}</p>
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={!autofillText.trim() || autofillState === "previewing"}
              >
                {autofillState === "previewing"
                  ? "正在整理…"
                  : "整理资料"}
              </button>
            </form>

            {autofillPreview && (
              <div className="autofill-preview">
                <header>
                  <div>
                    <span>保存前确认</span>
                    <h3>识别到 {autofillPreview.preview.candidates.length} 条候选</h3>
                  </div>
                  <strong>
                    {autofillPreview.execution.engine === "local_demo"
                      ? "本地明确字段"
                      : "AI 结构化提取"}
                  </strong>
                </header>
                <div className="autofill-target">
                  <fieldset>
                    <legend>写入对象</legend>
                    <label>
                      <input
                        type="radio"
                        name="autofill-target"
                        checked={autofillTarget === "new"}
                        onChange={() => setAutofillTarget("new")}
                      />
                      新建联系人
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="autofill-target"
                        checked={autofillTarget === "existing"}
                        disabled={!people.length}
                        onChange={() => setAutofillTarget("existing")}
                      />
                      写入已有联系人
                    </label>
                  </fieldset>
                  {autofillTarget === "new" ? (
                    <div className="form-row">
                      <label>
                        姓名
                        <input
                          value={autofillName}
                          required
                          placeholder="未识别时请补充"
                          onChange={(event) =>
                            setAutofillName(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        与我的关系
                        <input
                          value={autofillRelation}
                          required
                          placeholder="未识别时请补充"
                          onChange={(event) =>
                            setAutofillRelation(event.target.value)
                          }
                        />
                      </label>
                    </div>
                  ) : (
                    <label>
                      已有联系人
                      <select
                        value={autofillPersonId}
                        required
                        onChange={(event) =>
                          setAutofillPersonId(event.target.value)
                        }
                      >
                        <option value="">请选择</option>
                        {people.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.display_name} · {person.relation_to_user}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                {autofillPreview.preview.candidates.length ? (
                  <div className="autofill-candidates">
                    {autofillPreview.preview.candidates.map(
                      (candidate, index) => (
                        <label className="autofill-candidate" key={`${candidate.start}-${index}`}>
                          <input
                            type="checkbox"
                            checked={autofillSelected.includes(index)}
                            onChange={(event) =>
                              setAutofillSelected((selected) =>
                                event.target.checked
                                  ? [...selected, index]
                                  : selected.filter((item) => item !== index),
                              )
                            }
                          />
                          <span>
                            <strong>
                              {PROFILE_SECTION_LABELS[candidate.section]} ·{" "}
                              {candidate.label}
                            </strong>
                            <b>{candidate.value}</b>
                            <q>{candidate.quote}</q>
                          </span>
                        </label>
                      ),
                    )}
                  </div>
                ) : (
                  <p className="empty-note">
                    没有找到可回链的条目。可改用可用的 AI
                    执行器，或在原文中使用“姓名：”“喜欢：”等明确字段。
                  </p>
                )}
                <p className="autofill-skipped">
                  未写入：{" "}
                  {autofillPreview.preview.skipped_sections
                    .map((section) => PROFILE_SECTION_LABELS[section])
                    .join("、") || "无"}
                </p>
                <div className="autofill-save">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      autofillState === "saving" ||
                      !autofillSelected.length ||
                      (autofillTarget === "new" &&
                        (!autofillName.trim() ||
                          !autofillRelation.trim())) ||
                      (autofillTarget === "existing" && !autofillPersonId)
                    }
                    onClick={() => void handleAutofillSave()}
                  >
                    {autofillState === "saving"
                      ? "正在保存并生成报告…"
                      : "确认并生成完整资料"}
                  </button>
                  {autofillState === "saved" && autofillSavedPersonId && (
                    <>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => {
                          selectPerson(autofillSavedPersonId);
                          switchPersonView("profile");
                        }}
                      >
                        查看人物档案
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => openReports(autofillSavedPersonId)}
                      >
                        查看新报告
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </Section>
          <Section
            id="people"
            title="通讯录"
            visible={activeView === "people"}
          >
            <div className="form-row"><button type="button" className="secondary-button" onClick={createPersonFromToolbar}>新建联系人</button>{profilePerson && <button type="button" className="secondary-button" onClick={() => setInterviewPersonId(profilePerson.id)}>逐题补充资料</button>}</div>
            <div className="profile-workspace">
              {profilePerson && (
                <header className="contact-profile-header">
                  <span className="avatar large">
                    {profilePerson.display_name.slice(0, 1)}
                  </span>
                  <div>
                    <span className="overline">联系人档案</span>
                    <h3>{profilePerson.display_name}</h3>
                    <p>{profilePerson.relation_to_user}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>原始材料</dt>
                      <dd>{personSources.length}</dd>
                    </div>
                    <div>
                      <dt>引用证据</dt>
                      <dd>{personEvidence.length}</dd>
                    </div>
                    <div>
                      <dt>相关报告</dt>
                      <dd>{personReports.length}</dd>
                    </div>
                  </dl>
                </header>
              )}
              <nav className="person-tabs" aria-label="联系人内容">
                {PERSON_VIEWS.map((item) => {
                  const count =
                    item.value === "sources"
                      ? personSources.length
                      : item.value === "evidence"
                        ? personEvidence.length
                        : item.value === "events"
                          ? personEvents.length
                          : item.value === "reports"
                            ? personReports.length
                            : null;
                  return (
                    <button
                      className={personView === item.value ? "is-active" : ""}
                      type="button"
                      key={item.value}
                      disabled={!profilePerson}
                      aria-label={item.label}
                      aria-current={
                        personView === item.value ? "page" : undefined
                      }
                      onClick={() => switchPersonView(item.value)}
                    >
                      <span className="person-tab-label">{item.label}</span>
                      <span className="person-tab-short">{item.shortLabel}</span>
                      {count !== null && <small>{count}</small>}
                    </button>
                  );
                })}
              </nav>
              {!profilePerson && (
                <div className="person-empty">
                  <strong>先选择或新建一个联系人</strong>
                  <p>原始材料、引用证据、事件与报告都会归在联系人名下。</p>
                </div>
              )}
              {personView === "profile" && profilePerson && (
                <>
              <div className="subsection-heading">
                <div>
                  <span className="overline">九类资料</span>
                  <h3>人物分类信息</h3>
                </div>
                <p>仅保存你明确填写的内容；AI 候选不会自动变成事实。</p>
              </div>
              <form
                className="form-stack profile-form"
                onSubmit={handleAddProfileEntry}
              >
                <div className="form-row three">
                  <label>
                    资料人物
                    <select
                      value={profilePersonId}
                      onChange={(event) => selectPerson(event.target.value)}
                      required
                    >
                      <option value="">请选择</option>
                      {people.map((person) => (
                        <option value={person.id} key={person.id}>
                          {person.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    资料分类
                    <select
                      value={profileSection}
                      onChange={(event) =>
                        setProfileSection(event.target.value as ProfileSection)
                      }
                    >
                      {PROFILE_SECTIONS.map((section) => (
                        <option value={section} key={section}>
                          {PROFILE_SECTION_LABELS[section]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="form-row">
                  <label>
                    资料名称
                    <input
                      value={profileLabel}
                      onChange={(event) => setProfileLabel(event.target.value)}
                      placeholder="例如：常点饮品"
                      required
                    />
                  </label>
                  <label>
                    资料内容
                    <input
                      value={profileValue}
                      onChange={(event) => setProfileValue(event.target.value)}
                      placeholder="例如：无糖乌龙茶"
                      required
                    />
                  </label>
                </div>
                <button
                  className="secondary-button align-start"
                  type="submit"
                  disabled={!profilePersonId || savingProfile}
                >
                  {savingProfile ? "正在保存…" : "保存分类资料"}
                </button>
              </form>
              <div className="profile-grid">
                {PROFILE_SECTIONS.map((section) => {
                  const entries = (
                    profilePerson?.profile_sections ?? []
                  ).filter(
                    (entry) =>
                      entry.section === section &&
                      entry.confirmation_status === "confirmed",
                  );
                  return (
                    <article className="profile-group" key={section}>
                      <h4>{PROFILE_SECTION_LABELS[section]}</h4>
                      {entries.length ? (
                        <dl>
                          {entries.map((entry) => (
                            <div key={entry.id}>
                              <dt>{entry.label}</dt>
                              <dd>{entry.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p>暂无已确认内容</p>
                      )}
                    </article>
                  );
                })}
              </div>
                </>
              )}
              {personView === "events" && profilePerson && (
                <div className="person-pane">
                  <div className="subsection-heading">
                    <div>
                      <span className="overline">人物时间线</span>
                      <h3>{profilePerson.display_name}的相关事件</h3>
                    </div>
                    <p>这里只显示已经明确关联到当前联系人的事件。</p>
                  </div>
                  <div className="entity-list">
                    {personEvents.map((item) => (
                      <button type="button" className="entity-row event-row" key={item.id} onClick={() => selectWorkbenchEvent(item)}>
                        <span className="date-tile">
                          {formatDate(item.occurred_at)}
                        </span>
                        <div>
                          <strong>{item.title}</strong>
                          <small>关联 {item.person_ids.length} 人</small>
                        </div>
                      </button>
                    ))}
                    {!personEvents.length && (
                      <p className="empty-note">这个联系人还没有相关事件。</p>
                    )}
                  </div>
                  <button type="button" className="secondary-button" onClick={newWorkbenchEvent}>新建关联事件</button>
                </div>
              )}
              {personView === "reports" && profilePerson && (
                <div className="person-pane">
                  <div className="subsection-heading">
                    <div>
                      <span className="overline">历史结果</span>
                      <h3>{profilePerson.display_name}的相关报告</h3>
                    </div>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => openReports(profilePerson.id, "generate")}
                    >
                      在 AI 报告中新建
                    </button>
                  </div>
                  <div className="report-history person-report-history">
                    {personReports.map((item) => (
                      <button type="button" className="history-row" key={item.topic.id} onClick={() => openReportForReading(item)}>
                        <div>
                          <strong>{item.topic.title}</strong>
                          <small>
                            {item.topic.template_family}
                            {item.topic.template_variant
                              ? ` · ${item.topic.template_variant}`
                              : ""}
                          </small>
                        </div>
                        <span>v{item.snapshot.version}</span>
                      </button>
                    ))}
                    {!personReports.length && (
                      <p className="empty-note">这个联系人还没有相关报告。</p>
                    )}
                  </div>
                </div>
              )}
              {(personView === "sources" || personView === "evidence") &&
                profilePerson && (
                  <div className="person-context-note">
                    <span aria-hidden="true">
                      {personView === "sources" ? "原" : "引"}
                    </span>
                    <p>
                      下方正在整理
                      <strong> {profilePerson.display_name} </strong>
                      的{personView === "sources" ? "原始材料" : "引用与证据"}。
                      所有内容均按人物关联筛选。
                    </p>
                  </div>
                )}
            </div>
          </Section>

          <Section
            id="sources"
            title={`${profilePerson?.display_name ?? "联系人"}的原始材料`}
            visible={activeView === "people" && personView === "sources"}
          >
            <div className="original-library">
              <div className="subsection-heading">
                <div>
                  <span className="overline">原件优先</span>
                  <h3>已保存的原始资料</h3>
                </div>
                <p>原件不会被 AI 生成内容覆盖；哈希用于检查是否仍是同一份资料。</p>
              </div>
              <div className="source-library-grid">
                {personSources.map((source) => {
                  const quoteCount = evidence.filter(
                    (item) => item.source_id === source.id,
                  ).length;
                  return (
                    <article className="source-library-card" key={source.id}>
                      <div className="source-kind-icon" aria-hidden="true">
                        {source.source_kind === "screenshot" ? "图" : "文"}
                      </div>
                      <div>
                        <span>{source.source_kind}</span>
                        <h4>{source.title}</h4>
                        <code>{source.original_path}</code>
                      </div>
                      <dl>
                        <div>
                          <dt>原件哈希</dt>
                          <dd>{source.sha256.slice(0, 12)}…</dd>
                        </div>
                        <div>
                          <dt>精确引用</dt>
                          <dd>{quoteCount} 条</dd>
                        </div>
                      </dl>
                      <div className="source-card-actions">
                        <a
                          className="text-button"
                          href={api.sourceOriginalUrl(source.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          打开原件
                        </a>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => void openSourceForEvidence(source.id)}
                        >
                          从原文取证
                        </button>
                      </div>
                    </article>
                  );
                })}
                {!personSources.length && (
                  <div className="source-library-empty">
                    <strong>还没有原始材料</strong>
                    <p>从下方粘贴文本或导入截图，原件会先保存，再进入分析。</p>
                  </div>
                )}
              </div>
            </div>
            <form className="form-stack" onSubmit={handleImportSource}>
              <div className="form-row">
                <label>
                  材料标题
                  <input
                    value={sourceTitle}
                    onChange={(event) => setSourceTitle(event.target.value)}
                    required
                  />
                </label>
                <label>
                  来源类型
                  <select
                    value={sourceKind}
                    onChange={(event) =>
                      setSourceKind(event.target.value as SourceKind)
                    }
                  >
                    <option value="text">文本</option>
                    <option value="markdown">Markdown</option>
                    <option value="chat_export">聊天导出</option>
                    <option value="user_observation">用户观察</option>
                  </select>
                </label>
              </div>
              <label>
                原始文本
                <textarea
                  rows={7}
                  value={sourceText}
                  onChange={(event) => setSourceText(event.target.value)}
                  placeholder="粘贴你主动提供、依法可使用的原始内容…"
                  required
                />
              </label>
              <div className="association-grid">
                <div>
                  <span className="field-label">关联人物</span>
                  <CheckboxList
                    items={people}
                    selected={sourcePeople}
                    onChange={setSourcePeople}
                    label="关联人物"
                    render={(person) => person.display_name}
                  />
                </div>
                <div>
                  <span className="field-label">关联事件（可选）</span>
                  <CheckboxList
                    items={events}
                    selected={sourceEvents}
                    onChange={setSourceEvents}
                    label="关联事件"
                    render={(item) => item.title}
                  />
                </div>
              </div>
              <div className="privacy-confirm">
                <span aria-hidden="true">i</span>
                只会保存本次粘贴内容，不会自动抓取其他账号或文件。
              </div>
              <button
                className="primary-button align-start"
                type="submit"
                disabled={!sourcePeople.length}
              >
                导入原文材料
              </button>
            </form>
            <div className="screenshot-workspace">
              <div className="subsection-heading">
                <div>
                  <span className="overline">1–20 张</span>
                  <h3>导入聊天截图</h3>
                </div>
                <p>按选择顺序保存原图；转写必须由你逐张核对后确认。</p>
              </div>
              <form className="form-stack" onSubmit={handleUploadScreenshots}>
                <div className="form-row">
                  <label>
                    截图批次标题
                    <input
                      value={screenshotTitle}
                      onChange={(event) =>
                        setScreenshotTitle(event.target.value)
                      }
                      required
                    />
                  </label>
                  <div
                    className={`screenshot-dropzone ${
                      draggingScreenshots ? "is-dragging" : ""
                    }`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDraggingScreenshots(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setDraggingScreenshots(false)}
                    onDrop={handleScreenshotDrop}
                  >
                    <label>
                      选择截图
                      <input
                        aria-label="选择截图"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        multiple
                        onChange={(event) =>
                          acceptScreenshotFiles(
                            Array.from(event.currentTarget.files ?? []),
                          )
                        }
                      />
                    </label>
                    <small>PNG、JPEG 或 WebP，也可拖入这里</small>
                  </div>
                </div>
                {screenshotFiles.length > 0 && (
                  <div className="screenshot-file-preview">
                    <strong>{screenshotFiles.length} 张，等待上传</strong>
                    <ol>
                      {screenshotFiles.map((file, index) => (
                        <li key={`${file.name}-${index}`}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          {file.name}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <div className="association-grid">
                  <div>
                    <span className="field-label">截图关联人物</span>
                    <CheckboxList
                      items={people}
                      selected={screenshotPeople}
                      onChange={setScreenshotPeople}
                      label="截图关联人物"
                      render={(person) => (
                        <>截图关联人物 · {person.display_name}</>
                      )}
                    />
                  </div>
                  <div>
                    <span className="field-label">截图关联事件（可选）</span>
                    <CheckboxList
                      items={events}
                      selected={screenshotEvents}
                      onChange={setScreenshotEvents}
                      label="截图关联事件"
                      render={(item) => <>截图关联事件 · {item.title}</>}
                    />
                  </div>
                </div>
                <div className="privacy-confirm">
                  <span aria-hidden="true">⌂</span>
                  原图保存在当前本地工作区，不会自动上传或识别其他图片。
                </div>
                <button
                  className="primary-button align-start"
                  type="submit"
                  disabled={
                    uploadingScreenshots ||
                    !screenshotFiles.length ||
                    !screenshotPeople.length
                  }
                >
                  {uploadingScreenshots
                    ? "正在上传…"
                    : `上传 ${screenshotFiles.length || 0} 张截图`}
                </button>
              </form>

              {personScreenshotSources.length > 0 && (
                <div className="screenshot-review">
                  <h3>截图顺序与确认状态</h3>
                  <div className="screenshot-grid">
                    {personScreenshotSources.map((source, index) => {
                      const sequence = (source.sequence_index ?? index) + 1;
                      return (
                        <button
                          className={`screenshot-card ${
                            selectedScreenshotId === source.id
                              ? "is-selected"
                              : ""
                          }`}
                          type="button"
                          key={source.id}
                          onClick={() => chooseScreenshot(source.id)}
                        >
                          <img
                            src={api.sourceOriginalUrl(source.id)}
                            alt={`截图 ${sequence}：${source.title}`}
                          />
                          <span className="screenshot-order">
                            顺序 {String(sequence).padStart(2, "0")}
                          </span>
                          <strong>{source.title}</strong>
                          <small
                            className={`source-status ${
                              source.processing_status === "confirmed"
                                ? "confirmed"
                                : ""
                            }`}
                          >
                            {screenshotStatus(source)}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedScreenshot && (
                <form
                  className="transcript-editor"
                  onSubmit={handleConfirmTranscript}
                >
                  <div className="transcript-preview">
                    <img
                      src={api.sourceOriginalUrl(selectedScreenshot.id)}
                      alt={`待核对原图：${selectedScreenshot.title}`}
                    />
                    <div>
                      <span className="overline">原图核对</span>
                      <h3>{selectedScreenshot.title}</h3>
                      <code>{selectedScreenshot.original_path}</code>
                    </div>
                  </div>
                  <div className="segment-stack">
                    {screenshotSegments.map((segment, index) => (
                      <fieldset className="segment-card" key={index}>
                        <legend>片段 {index + 1}</legend>
                        <div className="segment-fields">
                          <label>
                            顺序
                            <input
                              aria-label={`片段 ${index + 1} 顺序`}
                              type="number"
                              min="0"
                              value={segment.order}
                              onChange={(event) =>
                                updateScreenshotSegment(index, {
                                  order: Number(event.target.value),
                                })
                              }
                              required
                            />
                          </label>
                          <label>
                            说话人
                            <select
                              aria-label={`片段 ${index + 1} 说话人`}
                              value={segment.speaker}
                              onChange={(event) =>
                                updateScreenshotSegment(index, {
                                  speaker: event.target
                                    .value as ScreenshotSegmentInput["speaker"],
                                })
                              }
                            >
                              <option value="unknown">未知</option>
                              <option value="me">我</option>
                              <option value="other">对方</option>
                            </select>
                          </label>
                          <label>
                            不确定性
                            <select
                              aria-label={`片段 ${index + 1} 不确定性`}
                              value={segment.uncertainty}
                              onChange={(event) =>
                                updateScreenshotSegment(index, {
                                  uncertainty: event.target
                                    .value as ScreenshotSegmentInput["uncertainty"],
                                })
                              }
                            >
                              <option value="low">低</option>
                              <option value="medium">中</option>
                              <option value="high">高</option>
                            </select>
                          </label>
                        </div>
                        <label>
                          转写文本
                          <textarea
                            aria-label={`片段 ${index + 1} 文本`}
                            rows={3}
                            value={segment.text}
                            onChange={(event) =>
                              updateScreenshotSegment(index, {
                                text: event.target.value,
                              })
                            }
                            required
                          />
                        </label>
                        {screenshotSegments.length > 1 && (
                          <button
                            className="text-button"
                            type="button"
                            onClick={() =>
                              setScreenshotSegments((items) =>
                                items.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              )
                            }
                          >
                            移除此片段
                          </button>
                        )}
                      </fieldset>
                    ))}
                  </div>
                  <div className="transcript-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={addScreenshotSegment}
                    >
                      新增片段
                    </button>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={
                        confirmingTranscript ||
                        screenshotSegments.some(
                          (segment) => !segment.text.trim(),
                        )
                      }
                    >
                      {confirmingTranscript
                        ? "正在确认…"
                        : "确认转写并刷新证据"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </Section>

          <Section
            id="evidence"
            title={`从${profilePerson?.display_name ?? "联系人"}的原文框选证据`}
            visible={activeView === "people" && personView === "evidence"}
          >
            <form className="form-stack" onSubmit={handleCreateEvidence}>
              <label>
                选择材料
                <select
                  value={selectedSourceId}
                  onChange={(event) => void chooseSource(event.target.value)}
                  required
                >
                  <option value="">请选择</option>
                  {personTextSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.title}
                    </option>
                  ))}
                </select>
              </label>
              {selectedSource && (
                <>
                  <label>
                    在原文中拖动框选一句话
                    <textarea
                      className="source-selector"
                      rows={8}
                      readOnly
                      value={selectedSourceBody}
                      onSelect={(event) => {
                        const target = event.currentTarget;
                        setLocatorStart(target.selectionStart);
                        setLocatorEnd(target.selectionEnd);
                      }}
                      aria-label="可框选的来源原文"
                    />
                  </label>
                  <div className="locator-preview">
                    <div>
                      <span>locator</span>
                      <code>
                        {codePointLocatorStart}:{codePointLocatorEnd}
                      </code>
                    </div>
                    <blockquote>
                      {selectedQuote || "请在上方框选要作为证据的原文片段"}
                    </blockquote>
                  </div>
                  <div className="form-row three">
                    <label>
                      证据类型
                      <select
                        value={evidenceKind}
                        onChange={(event) =>
                          setEvidenceKind(
                            event.target
                              .value as EvidenceRecord["evidence_kind"],
                          )
                        }
                      >
                        <option value="direct_quote">直接引文</option>
                        <option value="user_observation">用户观察</option>
                        <option value="user_statement">用户陈述</option>
                        <option value="third_party_statement">
                          第三方转述
                        </option>
                      </select>
                    </label>
                    <label>
                      可靠性
                      <select
                        value={reliability}
                        onChange={(event) =>
                          setReliability(
                            event.target.value as EvidenceRecord["reliability"],
                          )
                        }
                      >
                        <option value="low">低</option>
                        <option value="medium">中</option>
                        <option value="high">高</option>
                      </select>
                    </label>
                  </div>
                  <button
                    className="primary-button align-start"
                    type="submit"
                    disabled={!selectedQuote || !evidencePeople.length}
                  >
                    保存原子证据
                  </button>
                </>
              )}
            </form>
            {!!personEvidence.length && (
              <div className="evidence-stack">
                <h3>已保存证据</h3>
                {personEvidence.map((item) => (
                  <button
                    className="evidence-card"
                    key={item.id}
                    type="button"
                    onClick={() => void inspectEvidence(item.id)}
                  >
                    <span className={`reliability ${item.reliability}`}>
                      {item.reliability}
                    </span>
                    <q>{item.quote}</q>
                    <small>
                      {item.locator.kind === "text_quote"
                        ? `${item.locator.start}:${item.locator.end}`
                        : "截图片段"}{" "}
                      · 查看来源
                    </small>
                  </button>
                ))}
              </div>
            )}
          </Section>

          {activeView === "reports" && (
          <section
            className="report-workspace"
            id="reports"
            aria-label="AI 报告工作区"
          >
            <div className="report-mode-switch" role="tablist" aria-label="报告功能">
              <button
                type="button"
                role="tab"
                aria-selected={reportMode === "generate"}
                onClick={() => { if (advisorPersonId !== profilePersonId) selectReportPerson(profilePersonId); setReportMode("generate"); }}
              >
                生成报告
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={reportMode === "read"}
                onClick={() => setReportMode("read")}
              >
                阅读报告
              </button>
            </div>

            <div className={`report-studio report-mode-${reportMode}`}>
              {reportMode === "generate" && <WorkbenchDialog title="生成报告" busy={creatingReport} onClose={() => setReportMode("read")}><section className="report-composer report-pane" aria-label="生成报告">
                <header className="report-pane-heading">
                  <div>
                    <h3>{reportUpdateTopic ? "更新报告主题" : "新报告"}</h3>
                  </div>
                  <span>{selectedReportEvidence.length} 条引用</span>
                </header>

                <form className="report-questionnaire" onSubmit={handleCreateReport}>
                  {selectedAnalysisTemplate && <div className="report-step" aria-label="当前分析模板"><strong>{selectedAnalysisTemplate.name}</strong><span>本次关注：{selectedAnalysisTemplate.dimensions.join(" · ")}</span></div>}
                  <label className="report-step"><span>保存方式</span><select aria-label="报告保存方式" value={reportUpdateTopicId} onChange={event => { const id = event.target.value; setReportUpdateTopicId(id); setReportConfirmed(false); const item = reports.find(report => report.topic.id === id); if (item) setReportKind(reportKindFor(item.topic.template_family, item.topic.template_variant)); }}><option value="">新建报告主题</option>{visibleReports.map(item => <option value={item.topic.id} key={item.topic.id} disabled={!item.topic.template_variant}>更新：{item.topic.title}（当前 v{item.snapshot.version}）</option>)}</select>{reportUpdateTopic && <small>沿用主题的分析类型，保存新版本并完整保留旧稿；材料范围需要重新确认。</small>}</label>

                  {!reportContextPerson && <label className="report-step">
                    <span><b>1</b> 关于谁</span>
                    <select
                      value={advisorPersonId}
                      onChange={(event) => selectReportPerson(event.target.value)}
                      required
                    >
                      <option value="">请选择联系人</option>
                      {people.map((person) => (
                        <option value={person.id} key={person.id}>
                          {person.display_name} · {person.relation_to_user}
                        </option>
                      ))}
                    </select>
                  </label>}

                  <fieldset className="report-step" hidden={Boolean(reportUpdateTopic)}>
                    <legend><b>2</b> 想要什么报告</legend>
                    <div className="report-choice-grid" aria-label="报告类型">
                      {REPORT_KIND_OPTIONS.map((item) => (
                          <button
                            type="button"
                            aria-label={item.label}
                            aria-pressed={reportKind === item.id}
                            disabled={Boolean(reportUpdateTopicId)}
                          className={reportKind === item.id ? "is-selected" : ""}
                          onClick={() => { setSelectedAnalysisTemplate(null); setReportKind(item.id); }}
                          key={item.id}
                        >
                          <strong>{item.label}</strong>
                        </button>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset className="report-step">
                    <legend><b>3</b> 报告用途</legend>
                    <div className="report-inline-options" aria-label="报告用途">
                      {REPORT_PURPOSES.map(([id, label]) => (
                        <button
                          type="button"
                          aria-pressed={reportPurpose === id}
                          className={reportPurpose === id ? "is-selected" : ""}
                          onClick={() => setReportPurpose(id)}
                          key={id}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </fieldset>

                  <label className="report-step">
                    <span><b>4</b> 还想补充什么？</span>
                    <textarea
                      aria-label="补充问题"
                      rows={3}
                      value={advisorRequest}
                      onChange={(event) => setAdvisorRequest(event.target.value)}
                      placeholder="可选，例如：重点看他在冲突中的沟通习惯。"
                    />
                  </label>

                  <div className="report-focus-grid">
                    <fieldset className="report-step">
                      <legend><b>5</b> 时间侧重</legend>
                      <div className="report-inline-options" aria-label="时间侧重">
                        {REPORT_TIME_FOCUS.map(([id, label]) => (
                          <button
                            type="button"
                            aria-pressed={reportTimeFocus === id}
                            className={reportTimeFocus === id ? "is-selected" : ""}
                            onClick={() => setReportTimeFocus(id)}
                            key={id}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset className="report-step">
                      <legend><b>6</b> 资料侧重</legend>
                      <div className="report-inline-options" aria-label="资料侧重">
                        {REPORT_MATERIAL_FOCUS.map(([id, label]) => (
                          <button
                            type="button"
                            aria-pressed={reportMaterialFocus === id}
                            className={reportMaterialFocus === id ? "is-selected" : ""}
                            onClick={() => setReportMaterialFocus(id)}
                            key={id}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  </div>

                  <div className="report-step">
                    <span><b>7</b> 选择原始材料</span>
                    <CheckboxList
                      items={reportAvailableSources}
                      selected={reportSources}
                      onChange={setReportSources}
                      label="原始材料"
                      render={(source) => (
                        <>
                          <strong>{source.title}</strong>
                          <small>
                            {evidence.filter((item) => item.source_id === source.id).length} 条精确引用
                          </small>
                        </>
                      )}
                    />
                  </div>

                  {!!selectedReportSources.length && (
                    <details className="included-evidence">
                      <summary>
                        本次实际使用的引用 · {selectedReportEvidence.length} 条
                      </summary>
                      {selectedReportEvidence.length ? (
                        <ul>
                          {selectedReportEvidence.map((item) => (
                            <li key={item.id}>
                              <q>{item.quote}</q>
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => void inspectEvidence(item.id)}
                              >
                                核对原文
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="material-warning">
                          所选文本材料还没有精确引用；确认生成时会直接提取可回链原文，不调用截图分析。
                        </div>
                      )}
                    </details>
                  )}

                  {selectedReportFeedback.length > 0 && <details className="included-evidence"><summary>本次带入核对反馈 · {selectedReportFeedback.length} 条</summary><p>仅带入与所选引用相关的反馈。它们是用户陈述，未独立核实；历史快照不会修改。</p>{selectedReportFeedback.map(entry => <p key={entry.id}>{entry.confirmation_status === "confirmed" ? "已保留" : "已退回"}：{entry.value}</p>)}</details>}
                  <label className="report-chart-option"><input type="checkbox" checked={includeCharts} disabled={!plottingCapabilities?.available || creatingReport} onChange={event => setIncludeCharts(event.target.checked)} />附加 R 统计图（对本次证据关联的完整材料做本地统计）</label>
                  <small className="report-chart-environment">{plottingCapabilities?.available ? `本机 R ${plottingCapabilities.r_version ?? ""} · ggplot2 ${plottingCapabilities.ggplot2_version ?? ""}；图表、CSV和脚本随报告版本保存。` : plottingCapabilities?.reason ?? "正在检查本机 R 绘图环境…"}</small>

                  <label className="report-confirm-check">
                    <input
                      type="checkbox"
                      checked={reportConfirmed}
                      onChange={(event) => setReportConfirmed(event.target.checked)}
                    />
                    我已核对本次选择的原始材料。
                  </label>
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={creatingReport || !reportConfirmed || !advisorPersonId}
                  >
                    {creatingReport ? "正在生成…" : "确认生成报告"}
                  </button>
                </form>

                {reportKind === "chat_analysis" && (
                  <ChatDataAnalysis sources={reportAvailableSources} textEngine={preferences.textEngine} />
                )}

                {advisorResult && (
                  <div className={`advisor-reply ${advisorResult.status}`} role="status">
                    <div className="assistant-avatar" aria-hidden="true">AI</div>
                    <div>
                      <strong>
                        {advisorResult.status === "ready"
                          ? "资料可以生成"
                          : "还需要一点信息"}
                      </strong>
                      <p>{advisorResult.reply}</p>
                      {advisorResult.status === "needs_input" && (
                        <>
                          <ol>
                            {advisorResult.questions.map((question) => (
                              <li key={question}>{question}</li>
                            ))}
                          </ol>
                          <form className="advisor-answer" onSubmit={handleAdvisorAnswer}>
                            <label>
                              直接回答（会保存为原始材料）
                              <textarea
                                rows={4}
                                value={advisorAnswer}
                                onChange={(event) => setAdvisorAnswer(event.target.value)}
                                placeholder="只写确实知道、可以核对的事实；不知道的可以跳过。"
                                required
                              />
                            </label>
                            <button
                              className="secondary-button"
                              type="submit"
                              disabled={advisorBusy || !advisorAnswer.trim()}
                            >
                              保存回答并重新检查
                            </button>
                          </form>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </section></WorkbenchDialog>}

              <aside className="report-reader-pane report-pane" aria-label="阅读报告">
                <header className="report-pane-heading">
                  <div>
                    <h3>
                      {reportContextPerson
                        ? `${reportContextPerson.display_name}的报告`
                        : "历史报告"}
                    </h3>
                  </div>
                  <span>{visibleReports.length} 份</span>
                </header>

                <details className="report-history" open={!currentReport}>
                  <summary>选择历史报告</summary>
                  {visibleReports.length ? (
                    visibleReports.map((item) => (
                      <button
                        className="history-row"
                        type="button"
                        onClick={() => openReportForReading(item)}
                        key={item.topic.id}
                      >
                        <span>
                          <strong>{item.topic.title}</strong>
                          <small>{formatDate(item.snapshot.created_at)}</small>
                        </span>
                        <em>v{item.snapshot.version}</em>
                      </button>
                    ))
                  ) : (
                    <p className="empty-note">还没有报告。</p>
                  )}
                </details>

                {currentReport ? (
                  <ReportView
                    onRefresh={handleRefreshWorkspace}
                    report={currentReport}
                  />
                ) : (
                  <div className="report-reader-empty">
                    <span aria-hidden="true">文</span>
                    <strong>选择一份报告开始阅读</strong>
                    <p>在上方选择已有报告，或点击生成报告创建新版本。</p>
                  </div>
                )}
              </aside>
            </div>
          </section>
          )}

          <Section
            id="obsidian"
            title="同一份资料，两种操作方式"
            visible={activeView === "obsidian"}
          >
            <div className="integration-grid">
              <article className="integration-card">
                <span className="integration-icon" aria-hidden="true">
                  O
                </span>
                <h3>用 Obsidian 打开</h3>
                <p>
                  不复制、不转换资料，直接打开当前工作区。外部修改后回到灵犀桥点击“刷新工作区”。
                </p>
                <code className="path-code">{openedPath || "尚未打开工作区"}</code>
                <a
                  className="primary-button link-button"
                  href={
                    openedPath
                      ? `obsidian://open?path=${encodeURIComponent(openedPath)}`
                      : undefined
                  }
                  aria-disabled={!openedPath}
                  onClick={(event) => {
                    if (!openedPath) event.preventDefault();
                  }}
                >
                  在 Obsidian 中打开
                </a>
              </article>
              <article className="integration-card">
                <span className="integration-icon cli" aria-hidden="true">
                  &gt;_
                </span>
                <h3>让 Claude Code / Codex 操作</h3>
                <p>
                  当前使用本地 CLI，不需要安装 MCP。AI 可以列出、创建、修改和可恢复归档联系人，也能读取报告；写入仍经过
                  同一套 Schema 校验。
                </p>
                <ol className="install-steps">
                  <li>
                    在项目根目录安装：<code>python3 -m pip install -e .</code>
                  </li>
                  <li>
                    把当前工作区路径交给 AI，不要提供整个磁盘权限。
                  </li>
                  <li>
                    让 AI 先运行：<code>lingxi --vault &quot;路径&quot; people list</code>
                  </li>
                </ol>
                <pre className="command-example">
                  <code>{`lingxi --vault "${openedPath || "/绝对/工作区路径"}" people create \\
  --name "林澄" --relation "朋友"`}</code>
                </pre>
                <p className="hint">
                  联系人只支持带 <code>--confirm</code> 的可恢复归档；有关联资料时会拒绝执行，
                  不向 AI 开放永久删除。
                </p>
              </article>
            </div>
          </Section>

        </div>
      </main>
      }
      reportReview={<ReportReview key={`${openedPath}:${currentReport?.snapshot.id ?? "empty"}:${reviewPersonId}`} report={currentReport} people={people} personId={reviewPersonId} reviews={claimReviews} busy={Boolean(reviewingClaim)} onPersonChange={id => { setReviewPersonId(id); setClaimReviews({}); }} onReview={(key, claim, correct) => correct ? handleAcceptClaim(key, claim) : handleRejectClaim(key, claim)} onEvidence={id => void inspectEvidence(id)} />}
      inspector={
      <aside className="right-inspector" aria-label="证据检查器">
        <div className="inspector-heading">
          <span className="overline">来源检查器</span>
          <h2>证据回链</h2>
          <p>从报告或证据卡片打开，核对原文与工作区路径。</p>
        </div>
        {inspectorLoading && <p className="empty-note">正在读取来源原文…</p>}
        {!inspectorLoading && eventQuoteInspection && inspectorRecord ? <div className="inspector-content"><blockquote>{eventQuoteInspection.quote}</blockquote><p className="empty-note">事件候选节点原句 · 待人工核对</p><SourceBody record={inspectorRecord} locator={{ kind: "text_quote", start: eventQuoteInspection.start, end: eventQuoteInspection.end }} /></div> : !inspectorLoading && inspectedEvidence && inspectorRecord ? (
          <div className="inspector-content">
            <blockquote>{inspectedEvidence.quote}</blockquote>
            <dl className="evidence-meta">
              <div>
                <dt>证据类型</dt>
                <dd>{inspectedEvidence.evidence_kind}</dd>
              </div>
              <div>
                <dt>可靠性</dt>
                <dd>{inspectedEvidence.reliability}</dd>
              </div>
              <div>
                <dt>来源位置</dt>
                <dd>
                  {inspectedEvidence.locator.kind === "text_quote"
                    ? `${inspectedEvidence.locator.start}:${inspectedEvidence.locator.end}`
                    : `截图片段 ${shortId(
                        inspectedEvidence.locator.segment_id,
                      )}`}
                </dd>
              </div>
            </dl>
            {inspectedEvidence.locator.kind === "screenshot_segment" && (
              <img
                className="inspector-source-image"
                src={api.sourceOriginalUrl(inspectedEvidence.source_id)}
                alt="截图证据原图"
              />
            )}
            <SourceBody
              record={inspectorRecord}
              locator={inspectedEvidence.locator}
            />
          </div>
        ) : !inspectorLoading && inspectorRecord ? <div className="inspector-content"><SourceBody record={inspectorRecord} /></div> : (
          !inspectorLoading && (
            <div className="inspector-empty">
              <div aria-hidden="true">“</div>
              <p>选择一条证据，或点击报告中的“查看来源”。</p>
              <small>这里会显示相对路径、原文和精确高亮位置。</small>
            </div>
          )
        )}
      </aside>
      }
      assistant={
          <AiWorkspace
            key={`${openedPath}:${assistantConversationId}`}
            language={preferences.language}
            openedPath={openedPath}
            people={people}
            sources={sources}
            executors={executors}
            textEngine={preferences.textEngine}
            conversationId={assistantConversationId}
            conversation={activeConversation}
            onConversationChange={updateAiConversation}
            onWorkspaceChanged={loadWorkspaceCollections}
            contextPersonId={profilePersonId}
            onPersonChange={(id) => { setAnalysisObjectType("person"); selectPerson(id); }}
            onOpenWorkspace={() => switchView("workspace")}
            onStartLive={() => switchView("live")}
          />
      }
      meetingContext={<div className="meeting-context-form"><label>本次对象类型<select aria-label="本次对象类型" value={meetingDraft.kind} disabled={recordingActive || transcriptionBusy} onChange={event => setMeetingDraft({...meetingDraft, kind: event.target.value})}><option value="person">人物</option><option value="event">事件</option></select></label>{meetingDraft.kind === "person" ? <label>本次人物<select aria-label="本次会谈人物" value={meetingDraft.personId} disabled={recordingActive || transcriptionBusy} onChange={event => setMeetingDraft({...meetingDraft, personId: event.target.value})}><option value="">可选择已建档对象</option>{people.map(item => <option value={item.id} key={item.id}>{item.display_name}</option>)}</select></label> : <label>本次事件<select aria-label="本次会谈事件" value={meetingDraft.eventId} disabled={recordingActive || transcriptionBusy} onChange={event => setMeetingDraft({...meetingDraft, eventId: event.target.value})}><option value="">可选择已建档对象</option>{events.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}<label>交谈对象<input aria-label="本次交谈对象姓名" placeholder="直接填写姓名或称呼，可选" value={meetingDraft.participantName} disabled={recordingActive || transcriptionBusy} onChange={event => setMeetingDraft({...meetingDraft, participantName: event.target.value})} maxLength={120} /></label><label>会谈名称<input aria-label="本次会谈名称" placeholder="待填写，可选" value={meetingDraft.title} disabled={recordingActive || transcriptionBusy} onChange={event => setMeetingDraft({...meetingDraft, title: event.target.value})} maxLength={120} /></label></div>}
      live={
        <div id="live" className="workbench-live-session">
          <LocalRecorder disabled={transcriptionBusy} contextLabel={[meetingDraft.title, meetingDraft.participantName || (meetingDraft.kind === "person" ? people.find(item => item.id === meetingDraft.personId)?.display_name : events.find(item => item.id === meetingDraft.eventId)?.title) || "未关联会谈"].filter(Boolean).join(" · ")} onBusyChange={busy => { recordingBusy.current = busy; setRecordingActive(busy); }} />
          <details className="advanced-transcription" onToggle={event => { if (recordingBusy.current && event.currentTarget.open) { event.currentTarget.open = false; setNotice({kind:"error", text:"请先保存并结束本次录音，再使用转写工具。"}); return; } setTranscriptionOpen(event.currentTarget.open); }}><summary>转写与校对工具</summary>
          <LiveSession
            onWorkspaceBusyChange={(busy) => { liveWorkspaceBusy.current = busy; setTranscriptionBusy(busy); }}
            analysisContainer={liveAnalysisContainer}
            analysisVisible={transcriptionOpen}
            defaultPersonId={meetingDraft.kind === "person" ? meetingDraft.personId : ""}
            defaultEventId={meetingDraft.kind === "event" ? meetingDraft.eventId : undefined}
            workspacePath={openedPath}
            people={people}
            events={events}
            defaultRecognizer={preferences.voiceRecognizer}
            onSaveTranscript={handleSaveLiveTranscript}
            onCreatePerson={createLivePerson}
          />
          </details>
          {savedLiveSourceId && (
            <button
              className="secondary-button"
              type="button"
              onClick={goToEvidenceCreator}
            >
              去创建证据
            </button>
          )}
        </div>
      }
      overlays={
      <>
      {interviewPersonId && people.find(item => item.id === interviewPersonId) && <PersonInterview key={`${openedPath}:${interviewPersonId}`} person={people.find(item => item.id === interviewPersonId)!} workspacePath={openedPath} onSaved={loadWorkspaceCollections} onClose={() => setInterviewPersonId("")} />}
      {personCreatorOpen && <WorkbenchDialog title="新建人物" busy={creatingPerson} onClose={() => setPersonCreatorOpen(false)}>{notice?.kind === "error" && <p role="alert">{notice.text}</p>}                <form
                  className="form-stack compact-form new-contact-form"
                  onSubmit={handleCreatePerson}
                >
                  <label>
                    姓名或昵称
                    <input
                      value={personName}
                      onChange={(event) => setPersonName(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    与我的关系
                    <select
                      value={personRelation}
                      onChange={(event) =>
                        setPersonRelation(event.target.value)
                      }
                      required
                    >
                      <option value="">请选择关系</option>
                      {RELATION_GROUPS.map((group) => (
                        <optgroup label={group.label} key={group.label}>
                          {group.items.map((tag) => (
                            <option value={tag} key={tag}>
                              {tag}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <div className="quick-relation-tags" aria-label="常用关系">
                    {QUICK_RELATION_TAGS.map((tag) => (
                      <button
                        className={personRelation === tag ? "is-active" : ""}
                        type="button"
                        key={tag}
                        onClick={() => setPersonRelation(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <label>
                    职业或身份 <small>可选</small>
                    <input
                      value={personOccupation}
                      list="occupation-options"
                      onChange={(event) =>
                        setPersonOccupation(event.target.value)
                      }
                      placeholder="可选择，也可自行填写"
                    />
                    <datalist id="occupation-options">
                      {OCCUPATION_OPTIONS.map((occupation) => (
                        <option value={occupation} key={occupation} />
                      ))}
                    </datalist>
                  </label>
                  <div className="contact-field-row">
                    <label>
                      年龄 <small>可选</small>
                      <select
                        value={personAge}
                        onChange={(event) => setPersonAge(event.target.value)}
                      >
                        <option value="">未填写</option>
                        {Array.from({ length: 100 }, (_, index) => index + 1).map(
                          (age) => (
                            <option value={age} key={age}>
                              {age} 岁
                            </option>
                          ),
                        )}
                        <option value="100+">100 岁以上</option>
                      </select>
                    </label>
                    <label>
                      性别 <small>可选</small>
                      <select
                        value={personGender}
                        onChange={(event) => setPersonGender(event.target.value)}
                      >
                        <option value="">未填写</option>
                        {GENDER_OPTIONS.map((gender) => (
                          <option value={gender} key={gender}>
                            {gender}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="contact-form-hint">
                    只填写确实知道的信息；空缺项会跳过，不由 AI 猜测。
                  </p>
                  <button
                    className="secondary-button"
                    type="submit"
                    disabled={creatingPerson}
                  >
                    {creatingPerson ? "正在创建…" : "创建人物"}
                  </button>
                </form></WorkbenchDialog>}
      {eventCreatorOpen && <WorkbenchDialog title="新建事件" busy={savingWorkbenchEvent} onClose={() => { setEventCreatorOpen(false); const draft = eventDraftBeforeCreate.current; if (draft) { setEventTitle(draft.title); setEventLocation(draft.location); setEventSummary(draft.summary); setEventAt(draft.at); setEventPeople(draft.people); setEventAnalysisSources(draft.sources); setEventScopeConfirmed(draft.confirmed); } }}>{notice?.kind === "error" && <p role="alert">{notice.text}</p>}{eventEditor}</WorkbenchDialog>}
      <OnboardingGuide
        open={onboardingOpen}
        preferences={preferences}
        executors={executors}
        onClose={() => setOnboardingOpen(false)}
        onNavigate={navigateToGuideTarget}
      />
      </>
      }
    />
  );
}
