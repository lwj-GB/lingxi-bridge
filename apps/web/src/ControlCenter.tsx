import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  api,
  type AnalysisTemplate,
  type AnalysisTemplatesResponse,
  type EventRecord,
  type EvidenceRecord,
  type ExecutorStatus,
  type Person,
  type ReportListItem,
  type SourceRecord,
} from "./api";
import {
  COLOR_THEMES,
  colorThemePreview,
  isColorTheme,
  isInterfaceFont,
  type ColorTheme,
  type InterfaceFont,
} from "./appearance";
import "./appearance.css";
export { applyAppearance } from "./appearance";

export type AppLanguage = "zh-CN" | "en";
export type AppTheme = "light" | "dark" | "system";
export type AppAccent =
  | "orange"
  | "blue"
  | "green"
  | "purple"
  | "rose"
  | "neutral";
export type TextEngine = "local_demo" | "claude" | "codex" | "api";
export type VoiceRecognizer = "browser_stream" | "demo" | "doubao";
export type WorkspaceStartView = "assistant" | "people";
export type AnalysisScene =
  | "daily"
  | "emotional"
  | "care"
  | "education"
  | "work"
  | "professional";
export type AnalysisObject =
  | "partner"
  | "crush"
  | "friend"
  | "parent_elder"
  | "child"
  | "teacher_mentor"
  | "colleague"
  | "leader"
  | "other";
export type ControlView = "settings" | "usage" | "data" | "help";
export type ToolbarTarget = ControlView | "workspace";
export type SettingsTab =
  | "general"
  | "workspace"
  | "analysis"
  | "templates"
  | "models";
export type GuideTarget =
  | "workspace"
  | "people"
  | "autofill"
  | "live"
  | "reports"
  | "data"
  | "settings"
  | `settings/${SettingsTab}`;

export interface AppPreferences {
  language: AppLanguage;
  theme: AppTheme;
  accent: AppAccent;
  colorTheme?: ColorTheme;
  fontFamily?: InterfaceFont;
  fontSize?: number;
  textEngine: TextEngine;
  voiceRecognizer: VoiceRecognizer;
  startupView: WorkspaceStartView;
  analysisScenes: AnalysisScene[];
  analysisObjects: AnalysisObject[];
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  language: "zh-CN",
  theme: "light",
  accent: "blue",
  colorTheme: "positron-light",
  fontFamily: "system",
  fontSize: 14,
  textEngine: "local_demo",
  voiceRecognizer: "browser_stream",
  startupView: "assistant",
  analysisScenes: ["daily"],
  analysisObjects: [],
};

const PREFERENCES_KEY = "lingxi.preferences.v1";
export const ONBOARDING_KEY = "lingxi.onboarding.v1";

const EXECUTOR_SETUP_URLS: Record<ExecutorStatus["engine"], string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://developers.openai.com/codex/cli/",
};
const DOUBAO_SETUP_URL = "https://www.volcengine.com/docs/6561/196768?lang=zh";
const ANALYSIS_SCENES: Array<{
  value: AnalysisScene;
  zh: string;
  en: string;
}> = [
  { value: "daily", zh: "日常关系", en: "Everyday relationships" },
  { value: "emotional", zh: "情感沟通", en: "Emotional communication" },
  { value: "care", zh: "家庭与关怀", en: "Family & care" },
  { value: "education", zh: "教育与成长", en: "Education & growth" },
  { value: "work", zh: "工作与协作", en: "Work & collaboration" },
  { value: "professional", zh: "专业支持", en: "Professional support" },
];

const ANALYSIS_OBJECTS: Array<{
  value: AnalysisObject;
  zh: string;
  en: string;
}> = [
  { value: "partner", zh: "伴侣", en: "Partner" },
  { value: "crush", zh: "暧昧对象 / Crush", en: "Crush" },
  { value: "friend", zh: "朋友 / 同辈", en: "Friend / peer" },
  { value: "parent_elder", zh: "父母 / 长辈", en: "Parent / elder" },
  { value: "child", zh: "孩子", en: "Child" },
  { value: "teacher_mentor", zh: "老师 / 导师", en: "Teacher / mentor" },
  { value: "colleague", zh: "同事 / 合作方", en: "Colleague / partner" },
  { value: "leader", zh: "领导 / 上级", en: "Leader / manager" },
  { value: "other", zh: "其他", en: "Other" },
];

const TEMPLATE_CATEGORY_LABELS: Record<AnalysisTemplate["category"], string> = {
  general: "通用",
  romantic: "恋爱与暧昧",
  family: "家庭与亲子",
  education: "导师与师生",
  friendship: "朋友与同辈",
  workplace: "工作与协作",
  professional_support: "专业支持",
};

export function shouldShowOnboarding() {
  return window.localStorage.getItem(ONBOARDING_KEY) !== "completed";
}

function markOnboardingCompleted() {
  window.localStorage.setItem(ONBOARDING_KEY, "completed");
}

export function loadPreferences(): AppPreferences {
  try {
    const stored = window.localStorage.getItem(PREFERENCES_KEY);
    if (!stored) return DEFAULT_PREFERENCES;
    const value = JSON.parse(stored) as Partial<AppPreferences> & {
      analysisScenario?: string;
    };
    const validScenes = value.analysisScenes?.filter((item): item is AnalysisScene =>
      ANALYSIS_SCENES.some((candidate) => candidate.value === item),
    );
    const validObjects = value.analysisObjects?.filter((item): item is AnalysisObject =>
      ANALYSIS_OBJECTS.some((candidate) => candidate.value === item),
    );
    const legacyDefaults: Record<
      string,
      { scenes: AnalysisScene[]; objects: AnalysisObject[] }
    > = {
      general: { scenes: ["daily"], objects: [] },
      romantic: { scenes: ["emotional"], objects: ["partner", "crush"] },
      family: { scenes: ["care"], objects: ["parent_elder"] },
      parent_child: { scenes: ["care"], objects: ["child"] },
      education: { scenes: ["education"], objects: ["teacher_mentor"] },
      friendship: { scenes: ["daily"], objects: ["friend"] },
      workplace: { scenes: ["work"], objects: ["colleague", "leader"] },
      professional_support: { scenes: ["professional"], objects: [] },
    };
    const legacy =
      legacyDefaults[value.analysisScenario ?? "general"] ??
      legacyDefaults.general;
    return {
      language: value.language === "en" ? "en" : "zh-CN",
      theme:
        value.theme === "light" || value.theme === "dark"
          ? value.theme
          : "system",
      accent:
        value.accent === "orange" ||
        value.accent === "blue" ||
        value.accent === "green" ||
        value.accent === "purple" ||
        value.accent === "rose" ||
        value.accent === "neutral"
          ? value.accent
          : DEFAULT_PREFERENCES.accent,
      colorTheme: isColorTheme(value.colorTheme) ? value.colorTheme : undefined,
      fontFamily: isInterfaceFont(value.fontFamily) ? value.fontFamily : "system",
      fontSize: [12, 13, 14, 15, 16].includes(value.fontSize ?? 0) ? value.fontSize : 14,
      textEngine:
        value.textEngine === "claude" || value.textEngine === "codex" || value.textEngine === "api"
          ? value.textEngine
          : "local_demo",
      voiceRecognizer:
        value.voiceRecognizer === "demo" || value.voiceRecognizer === "doubao"
          ? value.voiceRecognizer
          : "browser_stream",
      startupView: value.startupView === "people" ? "people" : "assistant",
      analysisScenes: validScenes?.length ? validScenes : legacy.scenes,
      analysisObjects: validObjects ?? legacy.objects,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(value: AppPreferences) {
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value));
}

function Glyph({
  name,
}: {
  name:
    | "folder"
    | "chart"
    | "archive"
    | "settings"
    | "help"
    | "plus"
    | "model"
    | "download"
    | "refresh"
    | "link";
}) {
  const paths = {
    folder: (
      <>
        <path d="M3 6.5h6l1.5 2H21v9.75A1.75 1.75 0 0 1 19.25 20H4.75A1.75 1.75 0 0 1 3 18.25Z" />
        <path d="M3 9h18" />
      </>
    ),
    chart: (
      <>
        <path d="M5 20V10m7 10V4m7 16v-7" />
        <path d="M3 20h18" />
      </>
    ),
    archive: (
      <>
        <path d="M4 6h16v14H4zM3 3h18v4H3z" />
        <path d="M9 11h6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.2.38.54.73 1 .95.34.16.72.24 1.1.24h.1v4h-.1c-.38 0-.76.08-1.1.24-.46.22-.8.57-1 .95Z" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.7 9a2.45 2.45 0 1 1 3.6 2.17c-.8.42-1.3.86-1.3 1.83" />
        <path d="M12 17h.01" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    model: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <path d="M9 9h6v6H9zM12 1v3m0 16v3M1 12h3m16 0h3" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4" />
        <path d="M4 19h16" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6.1 8A7 7 0 0 1 18.7 6.7L20 12M4 12l1.3 5.3A7 7 0 0 0 17.9 16" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a4 4 0 0 0 5.7.1l2.2-2.2a4 4 0 0 0-5.7-5.7L11 6.4" />
        <path d="M14 11a4 4 0 0 0-5.7-.1l-2.2 2.2a4 4 0 0 0 5.7 5.7l1.2-1.2" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function lastPathPart(path: string) {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").at(-1) || normalized;
}

function engineLabel(engine: TextEngine, language: AppLanguage) {
  if (engine === "local_demo") {
    return language === "en" ? "Local analysis" : "本地分析";
  }
  if (engine === "api") return language === "en" ? "Direct API" : "API 直连";
  return engine === "claude" ? "Claude Code" : "Codex";
}

export function TopToolbar({
  activeTarget, openedPath, preferences, onNavigate, onNewConversation,
}: {
  activeTarget: string; pageLabel: string; openedPath: string;
  executors: ExecutorStatus[]; preferences: AppPreferences;
  onNavigate: (target: ToolbarTarget) => void;
  onNewConversation: () => void;
}) {
  const isEnglish = preferences.language === "en";
  return <div className="desktop-toolbar" aria-label={isEnglish ? "App toolbar" : "应用工具栏"}>
    <button className="workspace-switch" type="button" onClick={() => onNavigate("workspace")}>
      <Glyph name="folder" /><strong>{openedPath ? lastPathPart(openedPath) : "打开资料夹"}</strong>
    </button>
    <nav className="toolbar-tools" aria-label="系统工具" style={{ marginLeft: "auto" }}>
      <button type="button" aria-label="设置" title="设置" aria-current={activeTarget === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><Glyph name="settings" /></button>
      <details className="toolbar-more">
        <summary aria-label="更多工具" title="更多工具">···</summary>
        <div>
          <button type="button" onClick={() => onNavigate("data")}>管理与导出</button>
          <button type="button" onClick={() => onNavigate("usage")}>使用统计</button>
          <button type="button" onClick={() => onNavigate("help")}>帮助</button>
        </div>
      </details>
    </nav>
    <button className="toolbar-create" type="button" onClick={onNewConversation} aria-label="新建 AI 对话" title="新建 AI 对话"><Glyph name="plus" /></button>
  </div>;
}

function ControlPage({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="control-page">
      <header className="control-page-heading">
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}

type EditableAnalysisTemplate = Omit<AnalysisTemplate, "source">;

export function analysisTemplateQuestion(template: AnalysisTemplate): string {
  return [
    `分析模板：${template.name}`,
    template.default_question,
    `分析维度：${template.dimensions.join("；")}。`,
    `材料要求：${template.evidence_requirements.join("；")}。`,
    `边界：${template.forbidden_conclusions.join("；")}。`,
    "以本次所选材料为主；没有依据的维度写明未知，不为凑齐维度补写事实。",
  ].join("\n");
}

function templateWithoutSource(
  template: AnalysisTemplate,
): EditableAnalysisTemplate {
  const { source: _source, ...editable } = template;
  return editable;
}

function AnalysisTemplatesSettings({
  preferences,
  openedPath,
  onUseTemplate,
}: {
  preferences: AppPreferences;
  openedPath: string;
  onUseTemplate: (template: AnalysisTemplate) => void;
}) {
  const isEnglish = preferences.language === "en";
  const [collection, setCollection] =
    useState<AnalysisTemplatesResponse | null>(null);
  const [draft, setDraft] = useState<EditableAnalysisTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadTemplates() {
    if (!openedPath) return;
    setLoading(true);
    setMessage("");
    try {
      setCollection(await api.getAnalysisTemplates());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setCollection(null);
    setDraft(null);
    if (openedPath) void loadTemplates();
  }, [openedPath]);

  async function saveCollection(
    activeTemplateId: string,
    customTemplates: EditableAnalysisTemplate[],
  ) {
    if (!collection) return null;
    setSaving(true);
    setMessage("");
    try {
      const updated = await api.updateAnalysisTemplates({
        active_template_id: activeTemplateId,
        custom_templates: customTemplates,
        expected_hash: collection.file_hash,
      });
      setCollection(updated);
      return updated;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setSaving(false);
    }
  }

  function startCustomTemplate(template?: AnalysisTemplate) {
    if (template) {
      setDraft({
        ...templateWithoutSource(template),
        id:
          template.source === "built_in"
            ? `custom_${Date.now().toString(36)}`
            : template.id,
        name:
          template.source === "built_in"
            ? `${template.name}（自定义）`
            : template.name,
      });
      return;
    }
    setDraft({
      id: `custom_${Date.now().toString(36)}`,
      name: "",
      category: "general",
      description: "",
      dimensions: ["可核对事实", "可能解释", "未知项"],
      evidence_requirements: ["每项判断回链到所选原始材料"],
      forbidden_conclusions: ["不得把假设写成事实"],
      template_family: "special",
      template_variant: "custom",
      default_question: "",
    });
  }

  async function saveDraft() {
    if (!collection || !draft) return;
    const customTemplates = [
      ...collection.custom_templates.filter((item) => item.id !== draft.id),
      draft,
    ];
    const updated = await saveCollection(draft.id, customTemplates);
    if (updated) {
      setDraft(null);
      setMessage(isEnglish ? "Custom template saved." : "自定义模板已保存并启用。");
    }
  }

  async function useTemplate(template: AnalysisTemplate) {
    if (!collection) return;
    const updated =
      collection.active_template_id === template.id && collection.file_hash
        ? collection
        : await saveCollection(
            template.id,
            collection.custom_templates,
          );
    if (updated) {
      onUseTemplate(template);
    }
  }

  async function initialiseConfig() {
    if (!collection) return;
    const updated = await saveCollection(
      collection.active_template_id,
      collection.custom_templates,
    );
    if (updated) {
      setMessage(
        isEnglish
          ? "Editable workspace configuration created."
          : "已在工作区生成可由 AI 编辑的模板配置。",
      );
    }
  }

  async function copyAiInstruction() {
    if (!collection) return;
    const fullPath = `${openedPath.replace(/\/+$/, "")}/${collection.relative_path}`;
    const prompt = [
      `请只编辑灵犀桥工作区配置文件：${fullPath}`,
      "可以修改 active_template_id，或在 custom_templates 中新增、编辑模板。",
      "保留 schema_version=0.1，不修改应用 UI、程序代码、工作区结构和任何原始材料。",
      "每个模板必须明确 dimensions、evidence_requirements、forbidden_conclusions、template_family、template_variant 和 default_question。",
      "完成后不要自动删除任何模板；告诉我改了什么，我会在灵犀桥中点击“重新读取”。",
    ].join("\n");
    await navigator.clipboard.writeText(prompt);
    setMessage(isEnglish ? "AI editing instruction copied." : "已复制给 AI 的安全编辑指令。");
  }

  if (!openedPath) {
    return (
      <div className="settings-empty-state">
        <strong>{isEnglish ? "Open a workspace first" : "请先打开工作区"}</strong>
        <p>{isEnglish ? "Templates are portable files stored with the workspace." : "模板属于工作区配置，会和资料一起迁移和导出。"}</p>
      </div>
    );
  }

  if (loading && !collection) {
    return <div className="settings-empty-state">{isEnglish ? "Loading templates…" : "正在读取模板…"}</div>;
  }

  if (!collection) {
    return (
      <div className="settings-empty-state">
        <strong>{isEnglish ? "Templates could not be loaded" : "模板读取失败"}</strong>
        <p>{message}</p>
        <button type="button" onClick={() => void loadTemplates()}>{isEnglish ? "Retry" : "重试"}</button>
      </div>
    );
  }

  return (
    <>
      <div className="template-toolbar">
        <div>
          <strong>{isEnglish ? "Workspace templates" : "工作区分析模板"}</strong>
          <span>
            {collection.file_hash
              ? collection.relative_path
              : (isEnglish ? "Configuration file not created yet" : "尚未生成配置文件")}
          </span>
        </div>
        <div>
          {!collection.file_hash && (
            <button type="button" onClick={() => void initialiseConfig()} disabled={saving}>
              {isEnglish ? "Create config" : "生成配置文件"}
            </button>
          )}
          <button type="button" onClick={() => void loadTemplates()} disabled={loading}>
            {isEnglish ? "Reload" : "重新读取"}
          </button>
          <button
            type="button"
            onClick={() => void copyAiInstruction()}
            disabled={!collection.file_hash}
            title={collection.file_hash ? undefined : "请先生成配置文件"}
          >
            {isEnglish ? "Copy AI edit prompt" : "复制 AI 编辑指令"}
          </button>
          <button className="settings-inline-action" type="button" onClick={() => startCustomTemplate()}>
            {isEnglish ? "New custom template" : "新建自定义模板"}
          </button>
        </div>
      </div>

      {message && <div className="template-message" role="status">{message}</div>}

      {draft && (
        <section className="template-editor" aria-label={isEnglish ? "Custom template editor" : "自定义模板编辑器"}>
          <header>
            <div>
              <span>{isEnglish ? "CUSTOM TEMPLATE" : "自定义模板"}</span>
              <h3>{draft.name || (isEnglish ? "Untitled template" : "未命名模板")}</h3>
            </div>
            <button type="button" onClick={() => setDraft(null)}>{isEnglish ? "Cancel" : "取消"}</button>
          </header>
          <div className="template-editor-grid">
            <label>
              {isEnglish ? "Name" : "模板名称"}
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={80}
                required
              />
            </label>
            <label>
              {isEnglish ? "Scenario" : "适用场景"}
              <select
                value={draft.category}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    category: event.target.value as AnalysisTemplate["category"],
                  })
                }
              >
                {Object.entries(TEMPLATE_CATEGORY_LABELS).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="span-two">
              {isEnglish ? "Description" : "说明"}
              <input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                maxLength={400}
                required
              />
            </label>
            <label>
              {isEnglish ? "Analysis dimensions, one per line" : "分析维度（每行一项）"}
              <textarea
                value={draft.dimensions.join("\n")}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    dimensions: event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              {isEnglish ? "Evidence requirements, one per line" : "证据要求（每行一项）"}
              <textarea
                value={draft.evidence_requirements.join("\n")}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    evidence_requirements: event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label className="span-two">
              {isEnglish ? "Forbidden conclusions, one per line" : "禁止结论（每行一项）"}
              <textarea
                value={draft.forbidden_conclusions.join("\n")}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    forbidden_conclusions: event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label className="span-two">
              {isEnglish ? "Default report question" : "默认报告问题"}
              <textarea
                value={draft.default_question}
                onChange={(event) => setDraft({ ...draft, default_question: event.target.value })}
                maxLength={2000}
                required
              />
            </label>
          </div>
          <footer>
            <span>{isEnglish ? "The template keeps its report route; its dimensions and boundaries are added to the report question." : "模板会保留对应的报告路径，分析维度与边界会一起带入报告问题。"}</span>
            <button
              className="settings-inline-action"
              type="button"
              disabled={
                saving ||
                !draft.name.trim() ||
                !draft.description.trim() ||
                !draft.default_question.trim() ||
                !draft.dimensions.length ||
                !draft.evidence_requirements.length ||
                !draft.forbidden_conclusions.length
              }
              onClick={() => void saveDraft()}
            >
              {saving ? (isEnglish ? "Saving…" : "保存中…") : (isEnglish ? "Save & activate" : "保存并启用")}
            </button>
          </footer>
        </section>
      )}

      <div className="template-grid">
        {collection.items.map((template) => {
          const active = template.id === collection.active_template_id;
          return (
            <article className={`template-card ${active ? "is-active" : ""}`} key={template.id}>
              <header>
                <span>{TEMPLATE_CATEGORY_LABELS[template.category]}</span>
                <small>{template.source === "built_in" ? "内置" : "自定义"}</small>
              </header>
              <h3>{template.name}</h3>
              <p>{template.description}</p>
              <div className="template-dimensions">
                {template.dimensions.map((item) => <span key={item}>{item}</span>)}
              </div>
              <details><summary>{isEnglish ? "Prompt and material requirements" : "短提示与材料要求"}</summary><p>{template.default_question}</p><p>{template.evidence_requirements.join("；")}</p><p>{template.forbidden_conclusions.join("；")}</p></details>
              <footer>
                <span>{active ? (isEnglish ? "Active" : "当前启用") : ""}</span>
                <div>
                  <button type="button" onClick={() => startCustomTemplate(template)}>
                    {template.source === "built_in" ? (isEnglish ? "Copy & edit" : "复制并修改") : (isEnglish ? "Edit" : "编辑")}
                  </button>
                  <button
                    className="settings-inline-action"
                    type="button"
                    onClick={() => void useTemplate(template)}
                    disabled={saving}
                  >
                    {isEnglish ? "Use in report" : "用于报告"}
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
      </div>

    </>
  );
}

export function SettingsCenter({
  preferences,
  executors,
  openedPath,
  activeTab,
  onTabChange,
  onChange,
  onStartGuide,
  onUseTemplate,
  onUseDefaultWorkspace,
  onChooseWorkspace,
  workspaceBusy,
}: {
  preferences: AppPreferences;
  executors: ExecutorStatus[];
  openedPath: string;
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onChange: (next: AppPreferences) => void;
  onStartGuide: () => void;
  onUseTemplate: (template: AnalysisTemplate) => void;
  onUseDefaultWorkspace: () => void;
  onChooseWorkspace: () => void;
  workspaceBusy: boolean;
}) {
  const isEnglish = preferences.language === "en";
  const [apiConfigured, setApiConfigured] = useState(false);

  function patch(next: Partial<AppPreferences>) {
    onChange({ ...preferences, ...next });
  }

  function toggleScene(value: AnalysisScene) {
    const selected = preferences.analysisScenes.includes(value);
    patch({
      analysisScenes: selected
        ? preferences.analysisScenes.filter((item) => item !== value)
        : [...preferences.analysisScenes, value],
    });
  }

  function toggleObject(value: AnalysisObject) {
    const selected = preferences.analysisObjects.includes(value);
    patch({
      analysisObjects: selected
        ? preferences.analysisObjects.filter((item) => item !== value)
        : [...preferences.analysisObjects, value],
    });
  }

  return (
    <ControlPage eyebrow={isEnglish ? "Preferences" : "设置"} title={isEnglish ? "Settings" : "设置"}>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label={isEnglish ? "Settings categories" : "设置分类"}>
          {([
            ["general", isEnglish ? "General" : "通用"],
            ["workspace", isEnglish ? "Workspace" : "工作区"],
            ["analysis", isEnglish ? "Analysis defaults" : "分析偏好"],
            ["models", isEnglish ? "Models & voice" : "模型与语音"],
            ["templates", isEnglish ? "Templates" : "分析模板"],
          ] as const).map(([value, label]) => (
            <button
              className={activeTab === value ? "is-active" : ""}
              type="button"
              key={value}
              aria-current={activeTab === value ? "page" : undefined}
              onClick={() => onTabChange(value)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {activeTab === "general" && (
            <div className="settings-group">
              <article className="preference-card">
                <h3>{isEnglish ? "Language" : "语言"}</h3>
                <div className="segmented-control" aria-label={isEnglish ? "Language" : "界面语言"}>
                  <button
                    className={preferences.language === "zh-CN" ? "is-active" : ""}
                    type="button"
                    onClick={() => patch({ language: "zh-CN" })}
                  >
                    简体中文
                  </button>
                  <button
                    className={preferences.language === "en" ? "is-active" : ""}
                    type="button"
                    onClick={() => patch({ language: "en" })}
                  >
                    English
                  </button>
                </div>
              </article>

              <article className="preference-card">
                <h3>{isEnglish ? "Appearance" : "外观"}</h3>
                <div className="appearance-controls">
                  <div className="segmented-control" aria-label={isEnglish ? "Theme" : "外观主题"}>
                    {([
                      ["light", isEnglish ? "Light" : "浅色"],
                      ["dark", isEnglish ? "Dark" : "深色"],
                      ["system", isEnglish ? "System" : "跟随系统"],
                    ] as const).map(([value, label]) => (
                      <button
                        className={preferences.theme === value ? "is-active" : ""}
                        type="button"
                        key={value}
                        onClick={() => patch({ theme: value, colorTheme: undefined })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="color-theme-picker" aria-label={isEnglish ? "Color theme presets" : "主题配色方案"}>
                    {COLOR_THEMES.map((theme) => (
                      <button
                        type="button"
                        key={theme.id}
                        className="color-theme-option"
                        aria-pressed={preferences.colorTheme === theme.id}
                        onClick={() => patch({ colorTheme: theme.id, theme: theme.mode, accent: theme.accent })}
                      >
                        <span className="color-theme-swatch" style={{ background: colorThemePreview(theme.id) }} aria-hidden="true" />
                        {theme.name}
                      </button>
                    ))}
                  </div>
                  <div className="accent-picker" aria-label={isEnglish ? "Unified accent" : "统一主色"}>
                    {([
                      ["orange", isEnglish ? "Warm" : "暖陶"],
                      ["blue", isEnglish ? "Blue" : "海蓝"],
                      ["green", isEnglish ? "Green" : "翡翠"],
                      ["purple", isEnglish ? "Purple" : "紫藤"],
                      ["rose", isEnglish ? "Rose" : "玫瑰"],
                      ["neutral", isEnglish ? "Graphite" : "石墨"],
                    ] as const).map(([value, label]) => (
                      <button
                        className={`accent-option accent-${value}`}
                        type="button"
                        key={value}
                        aria-pressed={preferences.accent === value}
                        onClick={() => patch({ accent: value, colorTheme: undefined })}
                      >
                        <span aria-hidden="true" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </article>

              <article className="preference-card">
                <h3>{isEnglish ? "Typography" : "字体与字号"}</h3>
                <div className="typography-controls">
                  <label>
                    {isEnglish ? "Interface font" : "界面字体"}
                    <select
                      value={preferences.fontFamily ?? "system"}
                      onChange={(event) => patch({ fontFamily: event.target.value as InterfaceFont })}
                    >
                      <option value="system">{isEnglish ? "System" : "系统字体"}</option>
                      <option value="sans">{isEnglish ? "Sans serif" : "无衬线 / 思源黑体"}</option>
                      <option value="serif">{isEnglish ? "Serif" : "衬线 / 宋体"}</option>
                      <option value="mono">{isEnglish ? "Monospace" : "等宽字体"}</option>
                    </select>
                  </label>
                  <label>
                    {isEnglish ? "Interface size" : "界面字号"}
                    <select
                      value={preferences.fontSize ?? 14}
                      onChange={(event) => patch({ fontSize: Number(event.target.value) })}
                    >
                      {[12, 13, 14, 15, 16].map((size) => <option key={size} value={size}>{size} px</option>)}
                    </select>
                  </label>
                </div>
              </article>

              <article className="preference-card">
                <h3>{isEnglish ? "Start page" : "启动页面"}</h3>
                <div className="segmented-control" role="group" aria-label={isEnglish ? "Start page" : "启动页面"}>
                  <button
                    className={preferences.startupView === "assistant" ? "is-active" : ""}
                    type="button"
                    onClick={() => patch({ startupView: "assistant" })}
                  >
                    {isEnglish ? "AI workspace" : "AI 工作台"}
                  </button>
                  <button
                    className={preferences.startupView === "people" ? "is-active" : ""}
                    type="button"
                    onClick={() => patch({ startupView: "people" })}
                  >
                    {isEnglish ? "Contacts" : "通讯录"}
                  </button>
                </div>
              </article>

              <article className="preference-card">
                <h3>{isEnglish ? "Product tour" : "使用教程"}</h3>
                <button className="settings-inline-action" type="button" onClick={onStartGuide}>
                  {isEnglish ? "Start" : "打开教程"}
                </button>
              </article>
            </div>
          )}

          {activeTab === "workspace" && (
            <div className="settings-group workspace-settings">
              <article className="preference-card">
                <div className="settings-value">
                  <h3>{isEnglish ? "Current workspace" : "当前工作区"}</h3>
                  <code>{openedPath || (isEnglish ? "Not opened" : "尚未打开")}</code>
                </div>
                <div className="settings-actions">
                  <button type="button" onClick={onChooseWorkspace} disabled={workspaceBusy}>
                    {isEnglish ? "Choose folder" : "选择文件夹"}
                  </button>
                  <button type="button" onClick={onUseDefaultWorkspace} disabled={workspaceBusy}>
                    {isEnglish ? "Use default" : "使用默认工作区"}
                  </button>
                  <a
                    href={openedPath ? `obsidian://open?path=${encodeURIComponent(openedPath)}` : undefined}
                    aria-disabled={!openedPath}
                    onClick={(event) => {
                      if (!openedPath) event.preventDefault();
                    }}
                  >
                    {isEnglish ? "Open in Obsidian" : "用 Obsidian 打开"}
                  </a>
                </div>
              </article>
              <div className="workspace-structure" aria-label={isEnglish ? "Workspace folders" : "工作区目录"}>
                <code>people/</code>
                <code>sources/</code>
                <code>evidence/</code>
                <code>reports/</code>
                <code>attachments/</code>
              </div>
            </div>
          )}

          {activeTab === "analysis" && (
            <div className="analysis-settings">
              <section className="settings-group">
                <header className="settings-group-title">
                  <h3>{isEnglish ? "Common scenarios" : "常用场景"}</h3>
                  <span>{isEnglish ? "Multiple selection" : "可多选"}</span>
                </header>
                <div className="settings-choice-grid" role="group" aria-label={isEnglish ? "Common scenarios" : "常用场景"}>
                  {ANALYSIS_SCENES.map((scene) => (
                    <button
                      className={preferences.analysisScenes.includes(scene.value) ? "is-active" : ""}
                      type="button"
                      role="checkbox"
                      aria-checked={preferences.analysisScenes.includes(scene.value)}
                      key={scene.value}
                      onClick={() => toggleScene(scene.value)}
                    >
                      {preferences.analysisScenes.includes(scene.value) && <span aria-hidden="true">✓</span>}
                      {isEnglish ? scene.en : scene.zh}
                    </button>
                  ))}
                </div>
              </section>
              <section className="settings-group">
                <header className="settings-group-title">
                  <h3>{isEnglish ? "Common people" : "常见对象"}</h3>
                  <span>{isEnglish ? "Multiple selection" : "可多选"}</span>
                </header>
                <div className="settings-choice-grid" role="group" aria-label={isEnglish ? "Common people" : "常见对象"}>
                  {ANALYSIS_OBJECTS.map((object) => (
                    <button
                      className={preferences.analysisObjects.includes(object.value) ? "is-active" : ""}
                      type="button"
                      role="checkbox"
                      aria-checked={preferences.analysisObjects.includes(object.value)}
                      key={object.value}
                      onClick={() => toggleObject(object.value)}
                    >
                      {preferences.analysisObjects.includes(object.value) && <span aria-hidden="true">✓</span>}
                      {isEnglish ? object.en : object.zh}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          )}

          {activeTab === "models" && (
            <div className="models-settings">
              <section className="settings-group">
                <article className="preference-card">
                  <div>
                    <h3>{isEnglish ? "Text analysis" : "文本分析"}</h3>
                    <small>{isEnglish ? "Autofill · reports · chat analysis" : "自动填入 · 报告 · 聊天分析"}</small>
                  </div>
                  <label>
                    <span className="sr-only">{isEnglish ? "Primary text model" : "文本分析主模型"}</span>
                    <select
                      value={preferences.textEngine}
                      onChange={(event) => patch({ textEngine: event.target.value as TextEngine })}
                    >
                      <option value="local_demo">{isEnglish ? "Local analysis" : "本地分析（不启动外部进程）"}</option>
                      <option value="api" disabled={!apiConfigured}>{isEnglish ? "Direct API" : "API 直连"}{apiConfigured ? "" : (isEnglish ? " · configure below" : " · 请先完成下方配置")}</option>
                      {executors.map((item) => (
                        <option value={item.engine} key={item.engine} disabled={!item.available}>
                          {item.name}{item.available ? "" : (isEnglish ? " · unavailable" : " · 当前不可用")}
                        </option>
                      ))}
                    </select>
                  </label>
                </article>

                <div className="inline-connections">
                  {executors.map((item) => (
                    <article className="inline-connection" key={item.engine}>
                      <div>
                        <strong>{item.name}</strong>
                        <code>{item.path ?? (isEnglish ? "Not detected" : "未检测到")}</code>
                      </div>
                      <span className={item.available ? "is-ready" : ""}>
                        {item.available ? (isEnglish ? "Ready" : "可用") : (isEnglish ? "Unavailable" : "不可用")}
                      </span>
                      <a
                        href={EXECUTOR_SETUP_URLS[item.engine]}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={isEnglish ? `Configure ${item.name}` : `配置 ${item.name}`}
                      >
                        {isEnglish ? "Setup" : "配置"}
                      </a>
                    </article>
                  ))}
                </div>
                <DirectModelSettings isEnglish={isEnglish} onConfigured={setApiConfigured} />
              </section>

              <section className="settings-group">
                <article className="preference-card">
                  <div>
                    <h3>{isEnglish ? "Speech recognition" : "语音识别"}</h3>
                    <small>{isEnglish ? "Live meeting" : "实时会谈"}</small>
                  </div>
                  <label>
                    <span className="sr-only">{isEnglish ? "Speech recognizer" : "语音流式识别"}</span>
                    <select
                      value={preferences.voiceRecognizer}
                      onChange={(event) => patch({ voiceRecognizer: event.target.value as VoiceRecognizer })}
                    >
                      <option value="browser_stream">{isEnglish ? "Browser streaming" : "浏览器流式识别"}</option>
                      <option value="demo">{isEnglish ? "Local demo script" : "本地自动演示"}</option>
                      <option value="doubao">{isEnglish ? "Doubao streaming API" : "豆包流式识别"}</option>
                    </select>
                  </label>
                  <a
                    href={DOUBAO_SETUP_URL}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={isEnglish ? "Configure Doubao" : "配置豆包"}
                  >
                    {isEnglish ? "Doubao setup" : "豆包配置"}
                  </a>
                </article>
              </section>
            </div>
          )}

          {activeTab === "templates" && (
            <AnalysisTemplatesSettings
              preferences={preferences}
              openedPath={openedPath}
              onUseTemplate={onUseTemplate}
            />
          )}
        </div>
      </div>
    </ControlPage>
  );
}

const DIRECT_MODEL_PREFERENCES_KEY = "lingxi.direct-model.preferences.v1";

function DirectModelSettings({
  isEnglish,
  onConfigured,
}: {
  isEnglish: boolean;
  onConfigured: (configured: boolean) => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyEnv, setKeyEnv] = useState("");
  const [credentialMode, setCredentialMode] = useState<"session" | "environment">("session");
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.getDirectModelSettings>> | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "test" | "clear" | null>("load");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.getDirectModelSettings().then((settings) => {
      if (!active) return;
      let remembered: { base_url?: string; model?: string; key_env?: string } = {};
      try {
        const stored = JSON.parse(window.localStorage.getItem(DIRECT_MODEL_PREFERENCES_KEY) ?? "{}");
        remembered = {
          base_url: typeof stored.base_url === "string" ? stored.base_url : "",
          model: typeof stored.model === "string" ? stored.model : "",
          key_env: typeof stored.key_env === "string" ? stored.key_env : "",
        };
      } catch { /* An invalid optional preference must not hide server settings. */ }
      setStatus(settings);
      setBaseUrl(settings.base_url || remembered.base_url || "");
      setModel(settings.model || remembered.model || "");
      setKeyEnv(settings.key_env || remembered.key_env || "");
      setCredentialMode(settings.key_storage === "environment" || (!settings.has_key && remembered.key_env) ? "environment" : "session");
      onConfigured(settings.configured);
    }).catch((reason: unknown) => {
      if (active) {
        onConfigured(false);
        setError(reason instanceof Error ? reason.message : (isEnglish ? "Unable to load model settings." : "模型设置读取失败。"));
      }
    }).finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, [isEnglish, onConfigured]);

  function changed() {
    setDirty(true);
    setMessage("");
    setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setMessage("");
    setError("");
    try {
      const settings = await api.configureDirectModel({
        base_url: baseUrl.trim(),
        model: model.trim(),
        key_env: credentialMode === "environment" ? keyEnv.trim() : "",
        ...(credentialMode === "session" && apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      setStatus(settings);
      setApiKey("");
      setDirty(false);
      onConfigured(settings.configured);
      window.localStorage.setItem(DIRECT_MODEL_PREFERENCES_KEY, JSON.stringify({ base_url: settings.base_url, model: settings.model, key_env: settings.key_env }));
      window.dispatchEvent(new Event("lingxi:model-settings-changed"));
      setMessage(isEnglish ? "Settings saved. Connection has not been tested; the default executor is unchanged." : "配置已保存，尚未测试连接；默认执行器未切换。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : (isEnglish ? "Save failed." : "配置保存失败。"));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("test");
    setMessage("");
    setError("");
    try {
      const result = await api.testDirectModel();
      if (!result.ok) throw new Error(isEnglish ? "The endpoint did not confirm a working connection." : "服务未确认连接成功。");
      setMessage(isEnglish ? `Connection verified: ${result.model}` : `连接测试通过：${result.model}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : (isEnglish ? "Connection test failed." : "连接测试失败。"));
    } finally {
      setBusy(null);
    }
  }

  async function clearKey() {
    if (!status) return;
    setBusy("clear");
    setMessage("");
    setError("");
    try {
      const settings = await api.configureDirectModel({ base_url: status.base_url, model: status.model, key_env: status.key_env, clear_key: true });
      setStatus(settings);
      setApiKey("");
      onConfigured(settings.configured);
      window.dispatchEvent(new Event("lingxi:model-settings-changed"));
      setMessage(isEnglish ? "Session key cleared." : "会话 Key 已清除。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : (isEnglish ? "Unable to clear the key." : "会话 Key 清除失败。"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form className="direct-model-settings" onSubmit={(event) => void save(event)} aria-label={isEnglish ? "Direct API settings" : "API 直连配置"}>
      <header><h3>{isEnglish ? "Direct API" : "API 直连"}</h3><span>{status?.configured ? (isEnglish ? "Configured · test connection before use" : "已配置 · 可测试连接") : (isEnglish ? "Not configured" : "未完成配置")}</span></header>
      <p>{isEnglish ? "Use a Chat Completions compatible endpoint. Saving does not switch your default executor." : "使用 Chat Completions 兼容接口。保存后不会自动切换默认执行器。"}</p>
      <div className="direct-model-grid">
        <label>{isEnglish ? "API base URL" : "API 地址"}<input type="url" required value={baseUrl} placeholder="https://your-provider.example/v1" disabled={busy === "load"} onChange={(event) => { setBaseUrl(event.target.value); changed(); }} /></label>
        <label>{isEnglish ? "Model" : "模型名称"}<input required value={model} placeholder={isEnglish ? "Model ID from your provider" : "填写服务提供方的模型 ID"} disabled={busy === "load"} onChange={(event) => { setModel(event.target.value); changed(); }} /></label>
        <label>{isEnglish ? "Credentials" : "凭据来源"}<select value={credentialMode} onChange={(event) => { setCredentialMode(event.target.value as "session" | "environment"); setApiKey(""); changed(); }}><option value="session">{isEnglish ? "Session API key" : "会话 API Key"}</option><option value="environment">{isEnglish ? "Environment variable reference" : "环境变量引用"}</option></select></label>
        {credentialMode === "session" ? <label>API Key<input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} placeholder={status?.has_key && status.key_storage === "session" ? (isEnglish ? "Already set for this session; leave blank to keep" : "当前会话已设置，留空沿用") : (isEnglish ? "Enter a key for this session" : "输入本次服务会话使用的 Key")} onChange={(event) => { setApiKey(event.target.value); changed(); }} /></label> : <label>{isEnglish ? "Environment variable name" : "环境变量名称"}<input required value={keyEnv} placeholder="LINGXI_MODEL_API_KEY" autoComplete="off" onChange={(event) => { setKeyEnv(event.target.value); changed(); }} /></label>}
      </div>
      <p className="direct-model-key-note">{credentialMode === "session" ? (isEnglish ? "The key stays in local service memory and must be entered again after a service restart. Only the address, model and environment variable reference are remembered locally." : "Key 仅保留在本地服务内存，服务重启后需重新填写；本机仅记住地址、模型与环境变量引用。") : (isEnglish ? "Only the environment variable name is remembered. Set its secret value in the local service environment; save the configuration again after restarting the service." : "本机仅记住环境变量名称，密钥值由本地服务环境提供；服务重启后需重新保存配置。")}</p>
      <footer><button type="submit" disabled={busy !== null}>{busy === "save" ? (isEnglish ? "Saving…" : "正在保存…") : (isEnglish ? "Save API settings" : "保存 API 配置")}</button><button type="button" disabled={busy !== null || dirty || !status?.configured} onClick={() => void testConnection()}>{busy === "test" ? (isEnglish ? "Testing…" : "正在测试…") : (isEnglish ? "Test saved connection" : "测试已保存配置")}</button><button type="button" disabled={busy !== null || status?.key_storage !== "session" || !status.has_key} onClick={() => void clearKey()}>{isEnglish ? "Clear session key" : "清除会话 Key"}</button></footer>
      <small>{isEnglish ? "A connection test sends a minimal request and may consume provider credits." : "连接测试会发送最小请求，可能消耗模型额度。"}</small>
      {message && <p role="status">{message}</p>}
      {error && <p className="direct-model-error" role="alert">{error}</p>}
    </form>
  );
}

function countTextUnits(text: string) {
  const han = text.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const words = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return han + words;
}

function formatNumber(value: number, language: AppLanguage) {
  return value.toLocaleString(language);
}

interface MaterialTotals {
  units: number;
  characters: number;
  loaded: number;
  failed: number;
}

export function UsageCenter({
  preferences,
  openedPath,
  sources,
  evidence,
  reports,
}: {
  preferences: AppPreferences;
  openedPath: string;
  sources: SourceRecord[];
  evidence: EvidenceRecord[];
  reports: ReportListItem[];
}) {
  const isEnglish = preferences.language === "en";
  const [totals, setTotals] = useState<MaterialTotals>({
    units: 0,
    characters: 0,
    loaded: 0,
    failed: 0,
  });
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!openedPath || !sources.length) {
      setTotals({ units: 0, characters: 0, loaded: 0, failed: 0 });
      return;
    }
    setLoading(true);
    void Promise.allSettled(sources.map((source) => api.getRecord(source.id)))
      .then((results) => {
        if (cancelled) return;
        const next = results.reduce<MaterialTotals>(
          (sum, result) => {
            if (result.status === "rejected") {
              sum.failed += 1;
              return sum;
            }
            sum.loaded += 1;
            sum.units += countTextUnits(result.value.body);
            sum.characters += Array.from(result.value.body).length;
            return sum;
          },
          { units: 0, characters: 0, loaded: 0, failed: 0 },
        );
        setTotals(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openedPath, refreshKey, sources]);

  const reportEvidenceCount = reports.reduce(
    (sum, item) => sum + item.snapshot.evidence_ids.length,
    0,
  );
  const maximum = Math.max(sources.length, evidence.length, reports.length, 1);
  const bars = [
    { label: isEnglish ? "Raw materials" : "原始材料", value: sources.length },
    { label: isEnglish ? "Evidence" : "已确认引用", value: evidence.length },
    { label: isEnglish ? "Reports" : "报告", value: reports.length },
  ];

  return (
    <ControlPage
      eyebrow={isEnglish ? "Usage" : "使用统计"}
      title={isEnglish ? "What has been organised and produced" : "已经整理了什么、产出了什么"}
      description={isEnglish ? "All counts come from the currently opened local workspace." : "所有数字都来自当前打开的本地工作区，不使用模拟统计。"}
    >
      <div className="usage-headline">
        <article className="usage-primary">
          <span>{isEnglish ? "Organised text" : "已整理字数"}</span>
          <strong>{loading ? "…" : formatNumber(totals.units, preferences.language)}</strong>
          <small>{isEnglish ? "Chinese characters + English words" : "中文字 + 英文单词；不含图片原字节"}</small>
        </article>
        <article>
          <span>{isEnglish ? "Materials" : "原始材料"}</span>
          <strong>{formatNumber(sources.length, preferences.language)}</strong>
          <small>{totals.loaded}/{sources.length} {isEnglish ? "readable" : "份可读取正文"}</small>
        </article>
        <article>
          <span>{isEnglish ? "Reports" : "报告产出"}</span>
          <strong>{formatNumber(reports.length, preferences.language)}</strong>
          <small>{reportEvidenceCount} {isEnglish ? "evidence links" : "条证据回链"}</small>
        </article>
        <article className="usage-token">
          <span>{isEnglish ? "Model tokens" : "模型 Token"}</span>
          <strong>—</strong>
          <small>{isEnglish ? "CLI does not return verifiable usage yet" : "当前 CLI 未回传可信 usage"}</small>
        </article>
      </div>

      <div className="usage-grid">
        <article className="usage-card">
          <header>
            <div>
              <h3>{isEnglish ? "Workspace conversion" : "资料整理进度"}</h3>
              <p>{isEnglish ? "From original material to traceable outputs." : "从原始材料到可回链结果的数量关系。"}</p>
            </div>
            <button type="button" disabled={loading || !openedPath} onClick={() => setRefreshKey((value) => value + 1)}>
              <Glyph name="refresh" />
              {isEnglish ? "Refresh" : "刷新"}
            </button>
          </header>
          <ol className="workspace-bars">
            {bars.map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <i><b style={{ width: `${Math.max(item.value ? 8 : 0, (item.value / maximum) * 100)}%` }} /></i>
                <strong>{item.value}</strong>
              </li>
            ))}
          </ol>
          <p className="usage-footnote">
            {isEnglish
              ? `${formatNumber(totals.characters, preferences.language)} source characters loaded.`
              : `已读取 ${formatNumber(totals.characters, preferences.language)} 个原文字符。`}
            {totals.failed > 0 && (isEnglish ? ` ${totals.failed} files could not be counted.` : ` ${totals.failed} 份材料暂时无法计数。`)}
          </p>
        </article>

        <article className="usage-card">
          <header>
            <div>
              <h3>{isEnglish ? "Recent outputs" : "最近产出"}</h3>
              <p>{isEnglish ? "Current report snapshots saved in Markdown." : "当前保存在 Markdown 中的报告快照。"}</p>
            </div>
          </header>
          {reports.length ? (
            <ol className="recent-output-list">
              {reports.slice(0, 5).map((item) => (
                <li key={item.topic.id}>
                  <span>{item.topic.title.slice(0, 1)}</span>
                  <div>
                    <strong>{item.topic.title}</strong>
                    <small>v{item.snapshot.version} · {item.snapshot.evidence_ids.length} {isEnglish ? "evidence links" : "条证据"}</small>
                  </div>
                  <time>{new Intl.DateTimeFormat(preferences.language, { month: "short", day: "numeric" }).format(new Date(item.snapshot.updated_at))}</time>
                </li>
              ))}
            </ol>
          ) : (
            <div className="control-empty">
              <strong>{isEnglish ? "No reports yet" : "还没有报告产出"}</strong>
              <p>{isEnglish ? "Select original material and evidence in AI Reports." : "在 AI 报告中选择原始材料与证据后生成第一份报告。"}</p>
            </div>
          )}
        </article>
      </div>
    </ControlPage>
  );
}

export function buildWorkspaceManifest({
  openedPath,
  people,
  events,
  sources,
  evidence,
  reports,
}: {
  openedPath: string;
  people: Person[];
  events: EventRecord[];
  sources: SourceRecord[];
  evidence: EvidenceRecord[];
  reports: ReportListItem[];
}) {
  const lines = [
    "# 灵犀桥工作区资料清单",
    "",
    `- 导出时间：${new Date().toISOString()}`,
    `- 工作区：${openedPath}`,
    `- 联系人：${people.length}`,
    `- 原始材料：${sources.length}`,
    `- 原子证据：${evidence.length}`,
    `- 相关事件：${events.length}`,
    `- 报告：${reports.length}`,
    "",
    "## 联系人",
    "",
    ...people.flatMap((person) => [
      `- ${person.display_name}（${person.relation_to_user}）`,
      `  - ID: \`${person.id}\``,
    ]),
    "",
    "## 原始材料",
    "",
    ...sources.flatMap((source) => [
      `- ${source.title}（${source.source_kind}）`,
      `  - 原件：\`${source.original_path}\``,
      `  - SHA-256: \`${source.sha256}\``,
      `  - ID: \`${source.id}\``,
    ]),
    "",
    "## 报告",
    "",
    ...reports.flatMap((report) => [
      `- ${report.topic.title}（v${report.snapshot.version}）`,
      `  - 证据回链：${report.snapshot.evidence_ids.length} 条`,
      `  - 报告 ID: \`${report.topic.id}\``,
      `  - 当前快照 ID: \`${report.snapshot.id}\``,
    ]),
    "",
    "> 此文件是便于迁移和审计的清单。完整原件、Markdown、JSON 与归档请使用“导出完整工作区”。",
    "",
  ];
  return lines.join("\n");
}

function downloadMarkdown(name: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function DataManagementCenter({
  preferences,
  openedPath,
  people,
  events,
  sources,
  evidence,
  reports,
  onOpenContacts,
}: {
  preferences: AppPreferences;
  openedPath: string;
  people: Person[];
  events: EventRecord[];
  sources: SourceRecord[];
  evidence: EvidenceRecord[];
  reports: ReportListItem[];
  onOpenContacts: () => void;
}) {
  const isEnglish = preferences.language === "en";
  const manifest = useMemo(
    () => buildWorkspaceManifest({ openedPath, people, events, sources, evidence, reports }),
    [openedPath, people, events, sources, evidence, reports],
  );
  const groups = [
    {
      icon: "原",
      title: isEnglish ? "Original material" : "原始资料",
      count: sources.length,
      detail: isEnglish ? "Immutable attachments and source metadata" : "原始附件与来源元数据，始终保留哈希",
    },
    {
      icon: "中",
      title: isEnglish ? "Structured work" : "中间整理",
      count: evidence.length + events.length,
      detail: isEnglish ? "Evidence links and related events" : "原子证据、来源引用与相关事件",
    },
    {
      icon: "报",
      title: isEnglish ? "Final outputs" : "最终产出",
      count: reports.length,
      detail: isEnglish ? "Versioned Markdown reports" : "带版本和证据回链的 Markdown 报告",
    },
  ];

  return (
    <ControlPage
      eyebrow={isEnglish ? "Data control" : "管理与导出"}
      title={isEnglish ? "Your data stays readable and movable" : "资料属于你，也始终能迁移"}
      description={isEnglish ? "Open formats are the source of truth. SQLite can always be rebuilt." : "开放文件是权威资料源；SQLite 只是可随时重建的索引。"}
    >
      <div className="data-summary-grid">
        {groups.map((group) => (
          <article key={group.title}>
            <span>{group.icon}</span>
            <div>
              <h3>{group.title}</h3>
              <p>{group.detail}</p>
            </div>
            <strong>{group.count}</strong>
          </article>
        ))}
      </div>

      <div className="data-actions-grid">
        <article className="export-card is-primary">
          <span className="export-icon"><Glyph name="download" /></span>
          <h3>{isEnglish ? "Export the complete workspace" : "导出完整工作区"}</h3>
          <p>{isEnglish ? "A ZIP containing Markdown, JSON, original attachments and recoverable archives. The rebuildable index is excluded." : "ZIP 包含 Markdown、JSON、原始附件和可恢复归档；不包含可重建索引。"}</p>
          <a
            className="control-action primary"
            href={openedPath ? api.workspaceExportUrl() : undefined}
            download
            aria-disabled={!openedPath}
            onClick={(event) => {
              if (!openedPath) event.preventDefault();
            }}
          >
            <Glyph name="download" />
            {isEnglish ? "Export ZIP" : "导出 ZIP"}
          </a>
        </article>

        <article className="export-card">
          <span className="export-icon">M↓</span>
          <h3>{isEnglish ? "Export a Markdown inventory" : "导出 Markdown 清单"}</h3>
          <p>{isEnglish ? "A portable index of people, source paths, hashes and report versions." : "生成联系人、来源路径、哈希与报告版本的便携索引。"}</p>
          <button
            className="control-action"
            type="button"
            disabled={!openedPath}
            onClick={() => downloadMarkdown("灵犀桥工作区资料清单.md", manifest)}
          >
            <Glyph name="download" />
            {isEnglish ? "Export .md" : "导出 .md"}
          </button>
        </article>

        <article className="export-card">
          <span className="export-icon">O</span>
          <h3>{isEnglish ? "Manage in Obsidian" : "在 Obsidian 中管理"}</h3>
          <p>{isEnglish ? "Edit the same files, then refresh the workspace to import changes with conflict checks." : "直接整理同一份文件；完成后刷新工作区并经过冲突检查导入。"}</p>
          <a
            className="control-action"
            href={openedPath ? `obsidian://open?path=${encodeURIComponent(openedPath)}` : undefined}
            aria-disabled={!openedPath}
            onClick={(event) => {
              if (!openedPath) event.preventDefault();
            }}
          >
            <Glyph name="link" />
            {isEnglish ? "Open Obsidian" : "打开 Obsidian"}
          </a>
        </article>
      </div>

      <article className="data-governance">
        <div>
          <span>盾</span>
          <div>
            <h3>{isEnglish ? "Deletion is recoverable and reference-aware" : "删除采用可恢复归档，并检查引用"}</h3>
            <p>{isEnglish ? "Contacts can be archived only when no source, evidence or report still links to them. Original files are never silently removed." : "联系人只有在没有材料、证据和报告引用时才能归档；原始文件不会被静默删除。进入通讯录逐项检查，或让本机 CLI 执行带确认的归档。"}</p>
          </div>
        </div>
        <button type="button" onClick={onOpenContacts}>
          {isEnglish ? "Open contacts" : "进入通讯录"}
        </button>
      </article>
    </ControlPage>
  );
}

type HelpTopic = "start" | "materials" | "meeting" | "privacy";

export function HelpCenter({
  preferences,
  openedPath,
  onStartGuide,
  onNavigate,
}: {
  preferences: AppPreferences;
  openedPath: string;
  onStartGuide: () => void;
  onNavigate: (target: GuideTarget) => void;
}) {
  const isEnglish = preferences.language === "en";
  const [topic, setTopic] = useState<HelpTopic>("start");
  const topics: Array<{
    value: HelpTopic;
    number: string;
    title: string;
    summary: string;
  }> = [
    {
      value: "start",
      number: "01",
      title: isEnglish ? "Quick start" : "快速开始",
      summary: isEnglish ? "The shortest complete path" : "最短完整使用路径",
    },
    {
      value: "materials",
      number: "02",
      title: isEnglish ? "Source & evidence" : "材料与证据",
      summary: isEnglish ? "What is preserved and linked" : "什么被保存和回链",
    },
    {
      value: "meeting",
      number: "03",
      title: isEnglish ? "Live meeting" : "实时会谈",
      summary: isEnglish ? "Transcribe, review, then save" : "转写、校对、再保存",
    },
    {
      value: "privacy",
      number: "04",
      title: isEnglish ? "Data & privacy" : "数据与隐私",
      summary: isEnglish ? "Local mode and export" : "本地模式与导出",
    },
  ];

  return (
    <ControlPage
      eyebrow={isEnglish ? "Help" : "帮助"}
      title={isEnglish ? "Use Lingxi Bridge with confidence" : "知道下一步，也知道边界"}
      description={isEnglish ? "A short, actionable guide for the desktop demo. Your workspace remains readable without this app." : "桌面 Demo 的可操作说明；即使不用本程序，工作区文件也仍然可读。"}
    >
      <div className="help-layout">
        <nav className="help-topic-nav" aria-label={isEnglish ? "Help topics" : "帮助主题"}>
          {topics.map((item) => (
            <button
              className={topic === item.value ? "is-active" : ""}
              type="button"
              key={item.value}
              aria-current={topic === item.value ? "page" : undefined}
              onClick={() => setTopic(item.value)}
            >
              <span>{item.number}</span>
              <strong>{item.title}</strong>
              <small>{item.summary}</small>
            </button>
          ))}
        </nav>

        <div className="help-topic-content">
          {topic === "start" && (
            <>
              <article className="help-launch-card">
                <div>
                  <span>{isEnglish ? "5 short steps" : "5 个短步骤"}</span>
                  <h3>{isEnglish ? "Take the three-minute product tour" : "用三分钟走完一次完整流程"}</h3>
                  <p>{isEnglish ? "Each step explains what to do, where data goes, and opens the real page." : "每一步都说明要做什么、资料保存到哪里，并可直接进入真实页面。"}</p>
                </div>
                <button type="button" onClick={onStartGuide}>
                  {isEnglish ? "Start tour" : "开始使用教程"}
                </button>
              </article>
              <ol className="help-flow-list">
                <li><span>1</span><div><strong>{isEnglish ? "Open a workspace" : "打开工作区"}</strong><p>{isEnglish ? "Choose the local folder that owns the data." : "选择承载全部资料的本地目录。"}</p></div><button type="button" onClick={() => onNavigate("workspace")}>{isEnglish ? "Open" : "前往"}</button></li>
                <li><span>2</span><div><strong>{isEnglish ? "Create a contact" : "创建联系人"}</strong><p>{isEnglish ? "Create manually or use AI Autofill for a long passage." : "可手动创建，也可把长文本交给 AI 自动填入。"}</p></div><button type="button" onClick={() => onNavigate("people")}>{isEnglish ? "Open" : "前往"}</button></li>
                <li><span>3</span><div><strong>{isEnglish ? "Keep original material" : "保留原始材料"}</strong><p>{isEnglish ? "Import first; confirm extracted evidence separately." : "先保存原件，再单独确认 AI 提取的证据。"}</p></div><button type="button" onClick={() => onNavigate("people")}>{isEnglish ? "Open" : "前往"}</button></li>
                <li><span>4</span><div><strong>{isEnglish ? "Create a report" : "生成报告"}</strong><p>{isEnglish ? "Select original material and keep every claim traceable." : "选择原始材料，让报告中的内容可以回链核对。"}</p></div><button type="button" onClick={() => onNavigate("reports")}>{isEnglish ? "Open" : "前往"}</button></li>
              </ol>
            </>
          )}

          {topic === "materials" && (
            <div className="help-article-stack">
              <article><span>原</span><div><h3>{isEnglish ? "Original material stays original" : "原始材料保持原样"}</h3><p>{isEnglish ? "Imported text, screenshots, and attachments are preserved. AI summaries are separate derived records." : "导入的文本、截图和附件按原件保存；AI 摘要属于单独的衍生内容，不覆盖原件。"}</p></div></article>
              <article><span>证</span><div><h3>{isEnglish ? "Evidence requires confirmation" : "证据需要人工确认"}</h3><p>{isEnglish ? "A quote becomes usable evidence only after its source and locator can be checked." : "只有来源和位置能够核对的引用，经过人工确认后才进入证据层。"}</p></div></article>
              <article><span>链</span><div><h3>{isEnglish ? "Reports link back" : "报告可以回链"}</h3><p>{isEnglish ? "Use View source beside a report claim to return to the exact material." : "点击报告条目旁的“查看来源”，即可回到对应原始材料。"}</p></div></article>
            </div>
          )}

          {topic === "meeting" && (
            <div className="help-detail-card">
              <span className="help-detail-kicker">Beta</span>
              <h3>{isEnglish ? "Transcribe both sides; analyse the selected counterpart" : "双方都转写，重点分析你指定的对方"}</h3>
              <p>{isEnglish ? "Choose speaker roles before starting. Live text and cautious observations stream separately. Nothing enters the profile until you review and save the transcript." : "开始前设置“我”和“对方”的说话人。实时文字与谨慎观察分栏流式显示；会后先校对，确认保存后才进入该人物的原始材料。"}</p>
              <ol>
                <li>{isEnglish ? "Select or create the counterpart." : "选择或创建本次会谈的对方。"}</li>
                <li>{isEnglish ? "Test locally with the demo script when no microphone is available." : "没有麦克风时可先用本地自动演示测试。"}</li>
                <li>{isEnglish ? "Review speaker labels and wording, then save." : "核对说话人和文字，再保存转写稿与分析摘要。"}</li>
              </ol>
              <button type="button" onClick={() => onNavigate("live")}>{isEnglish ? "Open live meeting" : "打开实时会谈"}</button>
            </div>
          )}

          {topic === "privacy" && (
            <div className="help-article-stack">
              <article><span>⌂</span><div><h3>{isEnglish ? "No account required" : "无需账号"}</h3><p>{isEnglish ? "The demo has no cloud account or remote sync. The selected workspace is the real data boundary." : "当前 Demo 没有云账号和远程同步，所选工作区才是真正的资料边界。"}</p></div></article>
              <article><span>导</span><div><h3>{isEnglish ? "Portable by design" : "资料可以自由迁移"}</h3><p>{isEnglish ? "Export a ZIP or Markdown inventory from Data & Export. Open files remain readable in Obsidian." : "在“管理与导出”中导出 ZIP 或 Markdown 清单，也可直接用 Obsidian 阅读开放文件。"}</p></div></article>
              <article><span>刷</span><div><h3>{isEnglish ? "Refresh after external edits" : "外部修改后刷新"}</h3><p>{isEnglish ? "Return to Workspace and select Refresh. Conflicts are reported instead of silently overwriting files." : "回到“工作区”点击刷新；遇到冲突会明确提示，不会静默覆盖。"}</p></div></article>
              <button className="help-wide-action" type="button" onClick={() => onNavigate("settings/workspace")}>{isEnglish ? "Open workspace settings" : "打开工作区设置"}</button>
            </div>
          )}
        </div>
      </div>

      <div className="help-footer">
        <div>
          <strong>{isEnglish ? "Current workspace" : "当前工作区"}</strong>
          <code>{openedPath || (isEnglish ? "Not open" : "尚未打开")}</code>
        </div>
        <div>
          <strong>{isEnglish ? "Open formats" : "开放格式"}</strong>
          <span>Markdown · TXT · JSON · {isEnglish ? "original attachments" : "原始附件"}</span>
        </div>
        <div>
          <strong>{isEnglish ? "Index" : "索引"}</strong>
          <span>SQLite · {isEnglish ? "rebuildable" : "可重建"}</span>
        </div>
        <div>
          <strong>{isEnglish ? "Open source" : "开源许可"}</strong>
          <a href={`${import.meta.env.BASE_URL}third-party-notices.txt`} target="_blank" rel="noreferrer">
            {isEnglish ? "Third-party notices" : "第三方组件许可"}
          </a>
        </div>
      </div>
    </ControlPage>
  );
}

export function OnboardingGuide({
  open,
  preferences,
  executors,
  onClose,
  onNavigate,
}: {
  open: boolean;
  preferences: AppPreferences;
  executors: ExecutorStatus[];
  onClose: () => void;
  onNavigate: (target: GuideTarget) => void;
}) {
  const [step, setStep] = useState(0);
  const isEnglish = preferences.language === "en";
  const steps: Array<{
    number: string;
    title: string;
    summary: string;
    detail: string;
    target: GuideTarget;
    action: string;
  }> = [
    {
      number: "01",
      title: isEnglish ? "Prepare the local AI environment" : "准备本地 AI 环境",
      summary: isEnglish ? "Connect tools, then choose text and speech AI" : "先连接工具，再选择文本与语音 AI",
      detail: isEnglish ? "Configure a compatible API or use an already configured Claude Code/Codex CLI, then explicitly choose the text executor and speech recognizer." : "填写兼容 API 配置，或使用已配置的 Claude Code/Codex CLI，再明确选择文本执行器和语音识别方式。",
      target: "settings/models",
      action: isEnglish ? "Open AI setup" : "去配置 AI",
    },
    {
      number: "02",
      title: isEnglish ? "Choose your main relationship context" : "选择主要分析场景",
      summary: isEnglish ? "Tune recommendations without locking the workflow" : "让推荐更贴合你，不锁死后续选择",
      detail: isEnglish ? "Choose the people and relationships you most often work with, such as a partner, parent, mentor, friend, or colleague. This only changes defaults; every task remains editable." : "选择你最常关注的人与关系，例如伴侣、父母、导师、朋友或同事。它只调整默认推荐，每次任务仍可重新选择。",
      target: "settings/analysis",
      action: isEnglish ? "Choose defaults" : "去选择偏好",
    },
    {
      number: "03",
      title: isEnglish ? "Open a local workspace" : "打开本地工作区",
      summary: isEnglish ? "Choose where every file lives" : "决定所有资料保存在哪里",
      detail: isEnglish ? "Select a Lingxi Bridge folder. Original material, profiles, and reports remain readable files on this Mac." : "选择一个灵犀桥资料目录。原始材料、人物档案和报告都以可读文件保存在这台 Mac 上。",
      target: "workspace",
      action: isEnglish ? "Open workspace" : "去打开工作区",
    },
    {
      number: "04",
      title: isEnglish ? "Let AI create and organise" : "让 AI 建档与整理",
      summary: isEnglish ? "Paste source material, review before saving" : "上传原始材料，核对后再保存",
      detail: isEnglish ? "Paste a long passage into AI Autofill. The original is preserved, missing fields stay unknown, and extracted candidates are written only after review." : "把长文本交给 AI 自动填入：原始材料会被保留，缺失字段保持未知，提取候选只有核对后才写入通讯录。",
      target: "autofill",
      action: isEnglish ? "Open AI Autofill" : "去 AI 自动填入",
    },
    {
      number: "05",
      title: isEnglish ? "Record a meeting" : "开始会谈录音",
      summary: isEnglish ? "Record, listen and save locally" : "本机录音、试听并保存",
      detail: isEnglish ? "Start local recording after consent, then stop, listen and save. Transcription tools are optional and require separate configuration." : "确认参与者同意后开始本机录音，停止后可试听并选择位置保存。需要转写时再展开工具并单独配置。",
      target: "live",
      action: isEnglish ? "Open recording" : "去会谈录音",
    },
    {
      number: "06",
      title: isEnglish ? "Create a traceable report" : "生成可回链的报告",
      summary: isEnglish ? "Select material, review claims, export" : "选材料、核对描述、再导出",
      detail: isEnglish ? "Choose original material for the question. Accept or reject each AI description and use View source whenever you need to verify it." : "围绕问题选择原始材料，逐条保留或退回 AI 描述；有疑问时随时点击“查看来源”核对。",
      target: "reports",
      action: isEnglish ? "Open reports" : "去 AI 报告",
    },
  ];
  const current = steps[step];

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  if (!open) return null;

  function finish(target?: GuideTarget) {
    markOnboardingCompleted();
    onClose();
    if (target) onNavigate(target);
  }

  function openSetup(target: GuideTarget) {
    onClose();
    onNavigate(target);
  }

  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-dialog" role="dialog" aria-modal="true" aria-label={isEnglish ? "Lingxi Bridge product tour" : "灵犀桥使用教程"}>
        <aside className="onboarding-progress">
          <span className="overline">{isEnglish ? "Getting started" : "第一次使用"}</span>
          <h2>{isEnglish ? "Let AI work first" : "先让 AI 能工作"}</h2>
          <p>{isEnglish ? "Start with local tools and AI setup, then complete one source-backed workflow." : "先配置本地工具与 AI，再走通一条有原始材料回链的流程。"}</p>
          <nav aria-label={isEnglish ? "Tour steps" : "教程步骤"}>
            {steps.map((item, index) => (
              <button
                className={step === index ? "is-active" : index < step ? "is-done" : ""}
                type="button"
                key={item.number}
                aria-current={step === index ? "step" : undefined}
                onClick={() => setStep(index)}
              >
                <span>{index < step ? "✓" : item.number}</span>
                <div><strong>{item.title}</strong><small>{item.summary}</small></div>
              </button>
            ))}
          </nav>
        </aside>
        <div className="onboarding-content">
          <button className="onboarding-close" type="button" aria-label={isEnglish ? "Close tutorial" : "关闭教程"} onClick={() => finish()}>×</button>
          <div className="onboarding-visual" aria-hidden="true">
            <span>{current.number}</span>
            <i />
            <i />
            <i />
          </div>
          <span className="onboarding-step-label">{isEnglish ? `Step ${step + 1} of ${steps.length}` : `第 ${step + 1} / ${steps.length} 步`}</span>
          <h3>{current.title}</h3>
          <p>{current.detail}</p>
          {step === 0 && (
            <div className="onboarding-setup-grid">
              <article>
                <div>
                  <span aria-hidden="true">&gt;_</span>
                  <div>
                    <strong>{isEnglish ? "Models and local tools" : "模型与本地工具"}</strong>
                    <small>
                      {executors.some((item) => item.available)
                        ? (isEnglish
                            ? `${executors.filter((item) => item.available).length} executor detected`
                            : `已检测到 ${executors.filter((item) => item.available).length} 个可用执行器`)
                        : (isEnglish ? "Claude Code and Codex are not detected" : "尚未检测到 Claude Code 或 Codex")}
                    </small>
                  </div>
                </div>
                <button type="button" onClick={() => openSetup("settings/models")}>
                  {isEnglish ? "Configure AI" : "配置 AI 与语音"}
                </button>
              </article>
            </div>
          )}
          {step === 1 && (
            <div className="onboarding-setup-grid">
              <article>
                <div>
                  <span aria-hidden="true">景</span>
                  <div>
                    <strong>{isEnglish ? "Current defaults" : "当前偏好"}</strong>
                    <small>
                      {isEnglish
                        ? `${preferences.analysisScenes.length} scenarios · ${preferences.analysisObjects.length} people`
                        : `${preferences.analysisScenes.length} 个场景 · ${preferences.analysisObjects.length} 类对象`}
                    </small>
                  </div>
                </div>
                <button type="button" onClick={() => openSetup("settings/analysis")}>
                  {isEnglish ? "Choose defaults" : "选择分析偏好"}
                </button>
              </article>
            </div>
          )}
          <footer>
            <button className="onboarding-skip" type="button" onClick={() => finish()}>{isEnglish ? "Skip for now" : "以后再看"}</button>
            <div>
              <button type="button" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>{isEnglish ? "Back" : "上一步"}</button>
              {step < steps.length - 1 ? (
                <button className="onboarding-primary" type="button" onClick={() => setStep((value) => value + 1)}>{isEnglish ? "Next" : "下一步"}</button>
              ) : (
                <button className="onboarding-primary" type="button" onClick={() => finish(current.target)}>{current.action}</button>
              )}
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}
