import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api, type EventRecord, type ReportListItem, type ReportResponse } from "./api";
import { loadPreferences, ONBOARDING_KEY } from "./ControlCenter";

const person = {
  schema_version: "0.1" as const,
  entity_type: "person" as const,
  id: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  created_at: "2026-07-27T00:00:00Z",
  updated_at: "2026-07-27T00:00:00Z",
  display_name: "林澄",
  relation_to_user: "朋友",
};

const source = {
  schema_version: "0.1",
  entity_type: "source",
  id: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  created_at: "2026-07-27T00:00:00Z",
  updated_at: "2026-07-27T00:00:00Z",
  title: "雨后散步",
  source_kind: "text",
  original_path:
    "attachments/22222222-2222-4222-8222-222222222222/original.txt",
  sha256: "a".repeat(64),
  person_ids: [person.id],
  event_ids: [],
};

const eventRecord = {
  schema_version: "0.1",
  entity_type: "event",
  id: "12121212-1212-4121-8121-121212121212",
  revision: 1,
  created_at: "2026-07-27T00:00:00Z",
  updated_at: "2026-07-27T00:00:00Z",
  title: "雨后散步",
  occurred_at: "2026-07-27T00:00:00Z",
  person_ids: [person.id],
  source_ids: [source.id],
};

const liveSource = {
  ...source,
  id: "13131313-1313-4131-8131-131313131313",
  title: "实时会谈校对稿",
  original_path:
    "attachments/13131313-1313-4131-8131-131313131313/original.txt",
  sha256: "c".repeat(64),
  event_ids: [eventRecord.id],
};

const liveAnalysisSource = {
  ...liveSource,
  id: "16161616-1616-4161-8161-161616161616",
  title: "实时会谈校对稿 · 同步分析摘要",
  original_path:
    "attachments/16161616-1616-4161-8161-161616161616/original.txt",
  sha256: "d".repeat(64),
  source_kind: "user_observation",
};

const evidence = {
  schema_version: "0.1",
  entity_type: "evidence",
  id: "33333333-3333-4333-8333-333333333333",
  revision: 1,
  created_at: "2026-07-27T00:00:00Z",
  updated_at: "2026-07-27T00:00:00Z",
  source_id: source.id,
  quote: "雨停以后，我们慢慢走回家。",
  locator: { kind: "text_quote", start: 3, end: 17 },
  evidence_kind: "direct_quote",
  reliability: "high",
  person_ids: [person.id],
  event_ids: [],
};

const reportResponse = {
  topic: {
    schema_version: "0.1",
    entity_type: "report_topic",
    id: "44444444-4444-4444-8444-444444444444",
    revision: 1,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
    title: "散步后的沟通准备",
    template_family: "special",
    template_variant: "communication_prep",
    person_ids: [person.id],
    current_snapshot_id: "55555555-5555-4555-8555-555555555555",
    snapshot_count: 1,
    status: "draft",
  },
  snapshot: {
    schema_version: "0.1",
    entity_type: "report_snapshot",
    id: "55555555-5555-4555-8555-555555555555",
    revision: 1,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
    topic_id: "44444444-4444-4444-8444-444444444444",
    version: 1,
    generation_kind: "safe_placeholder",
    evidence_ids: [evidence.id],
  },
  analysis: {
    schema_version: "0.1",
    material_scope: [source.id],
    claims: [
      {
        claim_type: "observation",
        text: "材料记录了雨后一起步行回家的经历。",
        evidence_ids: [evidence.id],
      },
      {
        claim_type: "hypothesis",
        text: "安静同行可能是双方都能接受的相处方式。",
        evidence_ids: [evidence.id],
        uncertainty: "high",
        alternatives: ["也可能只是当时交通不便。"],
      },
      {
        claim_type: "unknown",
        text: "尚不知道对方如何评价这段经历。",
        evidence_ids: [evidence.id],
      },
      {
        claim_type: "suggestion",
        text: "可以询问对方是否喜欢这种低压力的散步。",
        evidence_ids: [evidence.id],
      },
    ],
  },
  execution: {
    engine: "safe_placeholder",
    profile_id: "safe_placeholder",
    material_scope: [source.id],
    data_destination: "local_only",
    degraded: false,
    degraded_reason: null,
  },
};

const analysisTemplate = {
  id: "romantic_connection",
  name: "亲密关系理解",
  category: "romantic",
  description: "整理互动事实、关系期待与需要进一步澄清的问题。",
  dimensions: ["互动事实", "表达偏好", "边界与期待"],
  evidence_requirements: ["每项判断回链到所选原始材料"],
  forbidden_conclusions: ["不得把对方意图写成确定事实"],
  template_family: "relation",
  template_variant: "relationship",
  default_question: "请基于所选材料整理这段关系中可核对的互动模式。",
  source: "built_in",
} as const;

function screenshotSource(index: number) {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    schema_version: "0.1",
    entity_type: "source",
    id: `66666666-6666-4666-8666-${suffix}`,
    revision: 1,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
    title: `聊天截图 ${index + 1}`,
    source_kind: "screenshot",
    original_path: `attachments/66666666-6666-4666-8666-${suffix}/original.png`,
    sha256: "b".repeat(64),
    person_ids: [person.id],
    event_ids: [],
    mime_type: "image/png",
    byte_size: 8,
    batch_id: "77777777-7777-4777-8777-777777777777",
    sequence_index: index,
    processing_status: "pending_confirmation",
  };
}

function jsonResponse(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

class MockWebSocket {
  static instance: MockWebSocket;
  static readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instance = this;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(value: unknown) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
  }
}

function baseRouter({
  withEvidence = false,
  includeEvidence = withEvidence,
  historyReports = [],
  currentWorkspaceOpen = false,
}: {
  withEvidence?: boolean;
  includeEvidence?: boolean;
  historyReports?: unknown[];
  currentWorkspaceOpen?: boolean;
} = {}) {
  let uploadedScreenshots: ReturnType<typeof screenshotSource>[] = [];
  let importedSources: (typeof source)[] = [];
  const importedSourceBodies = new Map<string, string>();
  let screenshotEvidence: Record<string, unknown> | null = null;
  let createdEvidence: Record<string, unknown>[] = [];
  let analysisTemplates = {
    schema_version: "0.1",
    active_template_id: analysisTemplate.id,
    custom_templates: [],
    items: [analysisTemplate],
    relative_path: "analysis-templates.json",
    file_hash: null as string | null,
  };
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";

    if (path === "/executors") {
      return jsonResponse({
        items: [
          {
            engine: "claude",
            name: "Claude Code CLI",
            available: false,
            path: null,
            version: null,
            degraded_reason: "not_found",
          },
          {
            engine: "codex",
            name: "Codex CLI",
            available: false,
            path: null,
            version: null,
            degraded_reason: "not_found",
          },
        ],
      });
    }
    if (path === "/profile-autofill/preview" && method === "POST") {
      const input = JSON.parse(String(init?.body));
      const quote = "职业：建筑设计师";
      return jsonResponse({
        preview: {
          schema_version: "0.1",
          person: {
            display_name: "林澄",
            relation_to_user: "朋友",
          },
          candidates: [
            {
              section: "basic_info",
              label: "职业",
              value: "建筑设计师",
              quote,
              start: input.text.indexOf(quote),
              end: input.text.indexOf(quote) + quote.length,
              confidence: "high",
            },
          ],
          skipped_sections: ["habits", "important_experiences"],
        },
        execution: {
          engine: "local_demo",
          profile_id: "local_demo",
          data_destination: "local_only",
        },
      });
    }
    if (path === "/workspaces/open" && method === "POST") {
      return jsonResponse({ path: "/tmp/vault-v0.1", schema_version: "0.1" });
    }
    if (path === "/workspaces/current" && method === "GET") {
      return jsonResponse(
        currentWorkspaceOpen
          ? { open: true, path: "/tmp/vault-v0.1" }
          : { open: false },
      );
    }
    if (path === "/workspaces/refresh" && method === "POST") {
      return jsonResponse({ path: "/tmp/vault-v0.1", schema_version: "0.1" });
    }
    if (path === "/analysis-templates" && method === "GET") {
      return jsonResponse(analysisTemplates);
    }
    if (path === "/analysis-templates" && method === "PUT") {
      const input = JSON.parse(String(init?.body));
      analysisTemplates = {
        ...analysisTemplates,
        active_template_id: input.active_template_id,
        custom_templates: input.custom_templates,
        items: [
          analysisTemplate,
          ...input.custom_templates.map((item: Record<string, unknown>) => ({
            ...item,
            source: "custom",
          })),
        ],
        file_hash: "template-config-hash",
      };
      return jsonResponse(analysisTemplates);
    }
    if (path === "/people" && method === "GET") {
      return jsonResponse({ items: withEvidence ? [person] : [] });
    }
    if (path === "/people" && method === "POST") {
      return jsonResponse(person, 201);
    }
    if (path === `/people/${person.id}/profile-entries` && method === "POST") {
      const input = JSON.parse(String(init?.body));
      return jsonResponse(
        {
          ...person,
          revision: 2,
          profile_sections: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              ...input,
              origin: "user",
              confirmation_status: "confirmed",
            },
          ],
        },
        201,
      );
    }
    if (
      path === `/report-advisor/suggestions/${person.id}` &&
      method === "GET"
    ) {
      return jsonResponse({
        person_id: person.id,
        items: [
          "整理朋友与社交报告",
          "总结相处偏好与习惯",
          "为下一次重要沟通做准备",
        ],
      });
    }
    if (path === "/report-advisor/preview" && method === "POST") {
      const input = JSON.parse(String(init?.body ?? "{}")) as {
        evidence_ids?: string[];
      };
      const selectedEvidence = input.evidence_ids ?? [];
      const ready = createdEvidence.length > 0 || selectedEvidence.length > 0;
      return jsonResponse({
        status: ready ? "ready" : "needs_input",
        reply: ready
          ? "现有资料足以先生成一版“恋爱关系”报告。"
          : "现有资料还不足以稳妥生成“恋爱关系”报告。",
        proposed_report: {
          title: "林澄 · 恋爱关系",
          template_family: "relation",
          template_variant: "romantic",
          analysis_question: "我想了解他的恋爱观",
        },
        evidence_ids: ready
          ? Array.from(
              new Set([
                ...selectedEvidence,
                ...createdEvidence.map((item) => String(item.id)),
              ]),
            )
          : [],
        questions: ready
          ? []
          : ["在亲密关系里，对方通常如何表达在意或不满？"],
        recommended_materials: ready
          ? []
          : ["相关聊天原文", "具体相处事件"],
      });
    }
    if (path === "/events") {
      return jsonResponse({ items: withEvidence ? [eventRecord] : [] });
    }
    if (path === "/sources" && method === "GET") {
      return jsonResponse({
        items: [
          ...(withEvidence ? [source] : []),
          ...importedSources,
          ...uploadedScreenshots,
        ],
      });
    }
    if (path === "/sources/text" && method === "POST") {
      const input = JSON.parse(String(init?.body));
      const base =
        importedSources.length === 0 ? liveSource : liveAnalysisSource;
      const created = {
        ...base,
        title: input.title,
        source_kind: input.source_kind,
        person_ids: input.person_ids,
        event_ids: input.event_ids,
      };
      importedSources = [...importedSources, created];
      importedSourceBodies.set(created.id, input.text);
      return jsonResponse(created, 201);
    }
    if (
      path === `/sources/${source.id}/chat-analysis` &&
      method === "POST"
    ) {
      return jsonResponse({
        analysis: {
          schema_version: "0.1",
          source: {
            id: source.id,
            title: source.title,
            sha256: source.sha256,
            source_kind: source.source_kind,
          },
          topic_method: "local_frequency_clues",
          metrics: {
            characters: 68,
            non_whitespace_characters: 61,
            lines: 3,
            messages: 3,
            participants: 2,
            timestamped_messages: 3,
          },
          top_terms: [
            {
              term: "雨后散步",
              count: 3,
              message_count: 3,
              message_share: 1,
            },
          ],
          speakers: [
            {
              name: "林澄",
              message_count: 2,
              message_share: 0.6667,
            },
            {
              name: "我",
              message_count: 1,
              message_share: 0.3333,
            },
          ],
          time_buckets: [
            {
              label: "晚间",
              message_count: 3,
              message_share: 1,
            },
          ],
          topics: [
            {
              title: "高频线索：雨后散步",
              summary: "三条消息包含“雨后散步”，需要回看上下文。",
              keywords: ["雨后散步"],
              message_count: 3,
              message_share: 1,
              source_refs: [
                {
                  message_index: 0,
                  start: 3,
                  end: 17,
                  quote: "雨停以后，我们慢慢走回家。",
                },
              ],
            },
          ],
          limitations: ["本地主题只是频次线索，不是语义结论。"],
        },
        execution: {
          engine: "local_demo",
          profile_id: "local_demo",
          data_destination: "local_only",
          degraded: false,
          degraded_reason: null,
        },
      });
    }
    if (path === "/screenshot-batches" && method === "POST") {
      const body = init?.body as FormData;
      uploadedScreenshots = body
        .getAll("files")
        .map((_, index) => screenshotSource(index));
      return jsonResponse(
        {
          batch_id: "77777777-7777-4777-8777-777777777777",
          items: uploadedScreenshots,
        },
        201,
      );
    }
    if (
      path === `/sources/${screenshotSource(0).id}/transcript` &&
      method === "PUT"
    ) {
      const input = JSON.parse(String(init?.body));
      const confirmed = {
        ...screenshotSource(0),
        revision: 2,
        processing_status: "confirmed",
        transcript_id: "99999999-9999-4999-8999-999999999999",
      };
      uploadedScreenshots = uploadedScreenshots.map((item) =>
        item.id === confirmed.id ? confirmed : item,
      );
      screenshotEvidence = {
        ...evidence,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        source_id: confirmed.id,
        quote: input.segments[0].text,
        locator: {
          kind: "screenshot_segment",
          transcript_id: confirmed.transcript_id,
          segment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          start: 0,
          end: input.segments[0].text.length,
        },
      };
      return jsonResponse(
        {
          source: confirmed,
          transcript: {
            schema_version: "0.1",
            entity_type: "screenshot_transcript",
            id: confirmed.transcript_id,
            revision: 1,
            created_at: confirmed.created_at,
            updated_at: confirmed.updated_at,
            source_id: confirmed.id,
            status: "confirmed",
            segments: input.segments.map(
              (segment: Record<string, unknown>, index: number) => ({
                ...segment,
                segment_id: `segment-${index}`,
              }),
            ),
            person_ids: confirmed.person_ids,
            event_ids: [],
          },
          evidence: [screenshotEvidence],
        },
        201,
      );
    }
    if (path === "/evidence" && method === "POST") {
      const input = JSON.parse(String(init?.body));
      const sequence = String(createdEvidence.length + 1).padStart(12, "0");
      const created = {
        ...evidence,
        id: `15151515-1515-4151-8151-${sequence}`,
        ...input,
      };
      createdEvidence = [...createdEvidence, created];
      return jsonResponse(created, 201);
    }
    if (path === "/evidence" && method === "GET") {
      return jsonResponse({
        items: [
          ...(includeEvidence ? [evidence] : []),
          ...(screenshotEvidence ? [screenshotEvidence] : []),
          ...createdEvidence,
        ],
      });
    }
    if (path === "/reports" && method === "GET") {
      return jsonResponse({ items: historyReports });
    }
    if (path === "/reports" && method === "POST") {
      return jsonResponse(reportResponse, 201);
    }
    if (path === `/records/${source.id}`) {
      return jsonResponse({
        record: source,
        relative_path: source.original_path,
        body: [
          "# 雨后散步",
          "",
          "日期：2026-07-27",
          "",
          "序言：雨停以后，我们慢慢走回家。😀后来聊到最近的安排。",
          "",
          "我们在路口停下来，先核对下周各自能空出的时间。",
          "",
          "到家前，我们约定有变化就直接说明，不让对方猜。",
        ].join("\n"),
        file_hash: source.sha256,
      });
    }
    const importedRecord = importedSources.find(
      (item) => path === `/records/${item.id}`,
    );
    if (importedRecord) {
      return jsonResponse({
        record: importedRecord,
        relative_path: importedRecord.original_path,
        body: importedSourceBodies.get(importedRecord.id) ?? "",
        file_hash: importedRecord.sha256,
      });
    }
    return jsonResponse(
      {
        error: {
          code: "unexpected_request",
          message: `${method} ${path}`,
          details: {},
        },
      },
      500,
    );
  });
}

async function openDefaultWorkspace() {
  fireEvent.click(screen.getByRole("button", { name: "使用默认工作区" }));
  await screen.findByRole("button", { name: "vault-v0.1" });
}

describe("灵犀桥首切片", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#workspace");
    window.localStorage.clear();
    window.localStorage.setItem(ONBOARDING_KEY, "completed");
    vi.stubGlobal("fetch", baseRouter());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("首次打开显示六步教程，并能从教程进入真实页面", async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem(ONBOARDING_KEY);
    render(<App />);

    const guide = screen.getByRole("dialog", { name: "灵犀桥使用教程" });
    expect(within(guide).getByText("第 1 / 6 步")).toBeInTheDocument();
    expect(
      within(guide).getByRole("heading", { name: "准备本地 AI 环境" }),
    ).toBeInTheDocument();

    await user.click(within(guide).getByRole("button", { name: /生成可回链的报告/ }));
    expect(within(guide).getByText("第 6 / 6 步")).toBeInTheDocument();
    await user.click(within(guide).getByRole("button", { name: "去 AI 报告" }));

    expect(window.location.hash).toBe("#reports");
    expect(window.localStorage.getItem(ONBOARDING_KEY)).toBe("completed");
    expect(screen.queryByRole("dialog", { name: "灵犀桥使用教程" })).not.toBeInTheDocument();
  });

  it("桌面端启动时恢复后端当前工作区并直接呈现最新报告", async () => {
    vi.stubGlobal(
      "fetch",
      baseRouter({
        withEvidence: true,
        historyReports: [reportResponse],
        currentWorkspaceOpen: true,
      }),
    );
    render(<App />);

    expect(
      await screen.findByLabelText("当前报告"),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("#reports");
    expect(screen.queryByText("已恢复当前工作区，并打开最新报告。")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 已降级，资料仍可继续使用")).not.toBeInTheDocument();
    expect(screen.getByLabelText("当前报告")).toHaveTextContent(
      "散步后的沟通准备",
    );
  });

  it("从侧栏重新进入人物报告时直接呈现该人物最新报告", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      baseRouter({
        withEvidence: true,
        historyReports: [reportResponse],
        currentWorkspaceOpen: true,
      }),
    );
    render(<App />);

    expect(
      await screen.findByLabelText("当前报告"),
    ).toBeInTheDocument();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "人物与报告" }),
      ).getByRole("button", { name: "林澄的报告" }),
    );

    expect(screen.getByLabelText("当前报告")).toHaveTextContent(
      "散步后的沟通准备",
    );
    expect(
      screen.queryByText("选择一份报告开始阅读"),
    ).not.toBeInTheDocument();
  });

  it("桌面端等待冷启动服务并恢复上次打开的工作区", async () => {
    const router = baseRouter({
      withEvidence: true,
      historyReports: [reportResponse],
    });
    let currentWorkspaceAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/api/, "");
      if (path === "/workspaces/current" && currentWorkspaceAttempts < 25) {
        currentWorkspaceAttempts += 1;
        return Promise.reject(new TypeError("local service is starting"));
      }
      return router(input, init);
    });
    window.localStorage.setItem(
      "lingxi.last-workspace.v1",
      "/tmp/vault-v0.1",
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByLabelText("当前报告"),
    ).toBeInTheDocument();
    expect(currentWorkspaceAttempts).toBe(25);
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const path = new URL(String(input)).pathname.replace(/^\/api/, "");
        return path === "/workspaces/open" && init?.method === "POST";
      }),
    ).toBe(true);
    expect(screen.getByLabelText("当前报告")).toHaveTextContent(
      "散步后的沟通准备",
    );
  });

  it("引导首步直达模型与语音，并在当前页提供官方配置链接", async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem(ONBOARDING_KEY);
    render(<App />);

    let guide = screen.getByRole("dialog", { name: "灵犀桥使用教程" });
    expect(within(guide).getByText("尚未检测到 Claude Code 或 Codex")).toBeInTheDocument();
    await user.click(within(guide).getByRole("button", { name: "配置 AI 与语音" }));

    expect(window.location.hash).toBe("#settings/models");
    expect(screen.getByRole("button", { name: "模型与语音" })).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: "配置 Claude Code CLI" }),
    ).toHaveAttribute("href", "https://code.claude.com/docs/en/setup");
    expect(
      screen.getByRole("link", { name: "配置 Codex CLI" }),
    ).toHaveAttribute("href", "https://developers.openai.com/codex/cli/");
    expect(screen.queryByRole("button", { name: "连接" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "通用" }));
    await user.click(screen.getByRole("button", { name: "打开教程" }));
    guide = screen.getByRole("dialog", { name: "灵犀桥使用教程" });
    await user.click(within(guide).getByRole("button", { name: "配置 AI 与语音" }));

    expect(window.location.hash).toBe("#settings/models");
    expect(screen.getByRole("button", { name: "模型与语音" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "配置豆包" })).toHaveAttribute(
      "href",
      "https://www.volcengine.com/docs/6561/196768?lang=zh",
    );
  });

  it("可选择独立配色，并将配色偏好保存到本机", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "海蓝" }));

    expect(document.documentElement).toHaveAttribute("data-accent", "blue");
    expect(loadPreferences().accent).toBe("blue");
    expect(screen.getByRole("button", { name: "海蓝" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("可从帮助和设置重开教程，设置只保留可操作选项", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByText("···"));
    await user.click(screen.getByRole("button", { name: "帮助" }));
    expect(screen.getByRole("heading", { name: "知道下一步，也知道边界" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始使用教程" }));
    expect(screen.getByRole("dialog", { name: "灵犀桥使用教程" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "以后再看" }));

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("button", { name: "打开教程" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "账户与隐私" })).not.toBeInTheDocument();
  });

  it("可分别多选常用场景和分析对象，并保存为个人偏好", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "分析偏好" }));
    await user.click(screen.getByRole("checkbox", { name: "情感沟通" }));
    await user.click(screen.getByRole("checkbox", { name: "伴侣" }));

    expect(loadPreferences().analysisScenes).toEqual(["daily", "emotional"]);
    expect(loadPreferences().analysisObjects).toEqual(["partner"]);
    expect(screen.getByRole("checkbox", { name: "情感沟通" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("checkbox", { name: "伴侣" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("工作区模板可直接带着证据边界进入报告", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    const create = vi.spyOn(api, "createReport").mockResolvedValue(reportResponse as ReportResponse);
    render(<App />);

    await openDefaultWorkspace();
    await screen.findByRole("button", { name: "vault-v0.1" });
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "分析模板" }));
    expect(
      await screen.findByRole("heading", { name: analysisTemplate.name }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "用于报告" }));

    expect(window.location.hash).toBe("#reports");
    expect(screen.getByLabelText("当前分析模板")).toHaveTextContent(analysisTemplate.name);
    expect(screen.getByLabelText("当前分析模板")).toHaveTextContent(analysisTemplate.dimensions[0]);
    const question = screen.getByLabelText("补充问题") as HTMLTextAreaElement;
    expect(question.value).toContain(analysisTemplate.default_question);
    for (const dimension of analysisTemplate.dimensions) expect(question.value).toContain(dimension);
    for (const boundary of analysisTemplate.forbidden_conclusions) expect(question.value).toContain(boundary);
    expect(
      within(document.body).getByRole(
        "button",
        { name: "其他" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
    const reportUi = within(document.body);
    await user.click(reportUi.getByRole("checkbox", { name: /我已核对本次选择的原始材料/ }));
    await user.click(reportUi.getByRole("button", { name: "确认生成报告" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ analysis_question: expect.stringContaining(`分析维度：${analysisTemplate.dimensions.join("；")}`) })));
    expect(create.mock.calls[0][0].analysis_question).toContain(analysisTemplate.forbidden_conclusions[0]);
    expect(create.mock.calls[0][0].analysis_question).toContain(analysisTemplate.name);
    expect(create.mock.calls[0][0]).toMatchObject({ template_family: analysisTemplate.template_family, template_variant: analysisTemplate.template_variant });
  });

  it("打开工作区后解锁流程，并能创建人物", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("button", { name: "打开资料夹" })).toBeInTheDocument();
    await openDefaultWorkspace();

    expect(await screen.findByRole("button", { name: "vault-v0.1" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#assistant");
    expect(
      screen.getByRole("heading", { name: "AI 工作台" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^通讯录/ }));
    const peopleSection = document.querySelector("#people") as HTMLElement;
    await user.click(within(peopleSection).getByText("新建联系人"));
    await user.type(screen.getByLabelText("姓名或昵称"), "林澄");
    await user.selectOptions(screen.getByLabelText("与我的关系"), "朋友");
    await user.type(screen.getByLabelText(/职业或身份/), "建筑设计师");
    await user.selectOptions(screen.getByLabelText(/年龄/), "28");
    await user.selectOptions(screen.getByLabelText(/性别/), "女性");
    await user.click(screen.getByRole("button", { name: "创建人物" }));

    expect(await screen.findByText("已创建人物“林澄”。")).toBeInTheDocument();
    expect(screen.getAllByText("林澄").length).toBeGreaterThan(0);
    const profileWrites = vi.mocked(fetch).mock.calls.filter(([input, init]) => (
      String(input).includes(`/people/${person.id}/profile-entries`) &&
      init?.method === "POST"
    ));
    expect(profileWrites.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      expect.objectContaining({ section: "basic_info", label: "职业 / 身份", value: "建筑设计师" }),
      expect.objectContaining({ section: "basic_info", label: "年龄", value: "28 岁" }),
      expect.objectContaining({ section: "basic_info", label: "性别", value: "女性" }),
    ]);
  });

  it("把 AI 工作区与人物资料分层，并把 Obsidian 收进资料工具", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    render(<App />);

    const aiNavigation = screen.getByRole("navigation", {
      name: "AI 工作区",
    });
    const peopleNavigation = screen.getByRole("navigation", {
      name: "人物与报告",
    });
    expect(
      within(aiNavigation).getByRole("button", { name: "AI 工作台" }),
    ).toBeInTheDocument();
    expect(
      within(peopleNavigation).getByRole("button", { name: /^通讯录/ }),
    ).toBeInTheDocument();
    expect(
      within(aiNavigation).getByRole("button", { name: "会谈录音" }),
    ).toBeInTheDocument();
    expect(
      within(aiNavigation).getByRole("button", { name: "AI 自动填入" }),
    ).toBeInTheDocument();
    expect(
      within(peopleNavigation).getByRole("button", { name: "报告" }),
    ).toBeInTheDocument();
    expect(
      within(aiNavigation).queryByRole("button", { name: "Obsidian" }),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("navigation", { name: "资料工具" }),
      ).getByRole("button", { name: "Obsidian" }),
    ).toBeInTheDocument();
    expect(
      within(aiNavigation).queryByRole("button", { name: "原始材料" }),
    ).not.toBeInTheDocument();
    expect(
      within(aiNavigation).queryByRole("button", { name: "引用与证据" }),
    ).not.toBeInTheDocument();

    await openDefaultWorkspace();
    await user.click(
      within(peopleNavigation).getByRole("button", { name: /^通讯录/ }),
    );

    const personNavigation = screen.getByRole("navigation", {
      name: "联系人内容",
    });
    expect(
      within(personNavigation).getByRole("button", { name: "人物档案" }),
    ).toHaveAttribute("aria-current", "page");
    await user.click(
      within(personNavigation).getByRole("button", { name: "原始材料" }),
    );

    expect(window.location.hash).toBe("#people/sources");
    expect(
      screen.getByRole("heading", { name: "林澄的原始材料" }),
    ).toBeInTheDocument();
    expect(
      within(document.querySelector("#sources") as HTMLElement).getByRole(
        "heading",
        { name: "雨后散步", level: 4 },
      ),
    ).toBeInTheDocument();
  });

  it("AI 工作台没有模型时明确提示连接，不伪造回答或跳转报告", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await openDefaultWorkspace();
    await user.type(screen.getByRole("textbox", { name: "告诉 AI 你想完成什么" }), "送什么礼物合适？");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请先在设置中连接模型");
    expect(screen.queryByRole("article", { name: "AI 任务计划" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/assistant/answer"))).toBe(false);
  });

  it("通用设置可选择打开工作区后的默认入口", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(
      within(
        screen.getByRole("group", { name: "启动页面" }),
      ).getByRole("button", { name: "通讯录" }),
    );

    expect(loadPreferences().startupView).toBe("people");
  });

  it("报告助手在资料不足时提问，并把回答保存为原始材料后准备报告", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "人物与报告" }),
      ).getByRole("button", { name: "报告" }),
    );

    const reportUi = within(document.body);
    await user.click(screen.getByRole("tab", { name: "生成报告" }));
    await user.click(within(screen.getByRole("dialog", { name: "生成报告" })).getByRole("checkbox", { name: /雨后散步/ }));
    await user.type(
      reportUi.getByLabelText("补充问题"),
      "我想了解他的恋爱观",
    );
    await user.click(
      reportUi.getByRole("checkbox", {
        name: "我已核对本次选择的原始材料。",
      }),
    );
    await user.click(
      reportUi.getByRole("button", { name: "确认生成报告" }),
    );

    expect(await reportUi.findByText("还需要一点信息")).toBeInTheDocument();
    expect(
      reportUi.getByText("在亲密关系里，对方通常如何表达在意或不满？"),
    ).toBeInTheDocument();
    const answer = "他明确说过，产生分歧时希望先冷静十分钟再继续沟通。";
    await user.type(
      reportUi.getByLabelText("直接回答（会保存为原始材料）"),
      answer,
    );
    await user.click(
      reportUi.getByRole("button", { name: "保存回答并重新检查" }),
    );

    expect(await reportUi.findByText("资料可以生成")).toBeInTheDocument();
    expect(reportUi.getByLabelText("补充问题")).toHaveValue(
      "我想了解他的恋爱观",
    );
    expect(
      await screen.findByText("补充回答已保存为原始材料，可以确认生成报告。"),
    ).toBeInTheDocument();
    const answerSource = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/sources/text") &&
        init?.method === "POST" &&
        JSON.parse(String(init.body)).text === answer,
    );
    expect(answerSource).toBeDefined();
  });

  it("把聊天统计收进报告类型，不再重复选择执行方式", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "人物与报告" }),
      ).getByRole("button", { name: "报告" }),
    );

    const reportUi = within(document.body);
    await user.click(screen.getByRole("tab", { name: "生成报告" }));
    expect(reportUi.queryByLabelText("模板家族")).not.toBeInTheDocument();
    expect(reportUi.queryByLabelText("执行方式")).not.toBeInTheDocument();
    await user.click(
      reportUi.getByRole("button", { name: "聊天记录分析" }),
    );

    const analysis = within(
      screen.getByRole("region", { name: "聊天数据分析" }),
    );
    expect(analysis.queryByLabelText("聊天分析方式")).not.toBeInTheDocument();
    expect(analysis.getByLabelText("聊天分析原始材料")).toHaveValue(source.id);
    await user.click(analysis.getByRole("button", { name: "预览聊天统计" }));

    expect(await analysis.findByText("雨后散步", { selector: ".analysis-bar-label" }))
      .toBeInTheDocument();
    expect(analysis.getByText("高频线索：雨后散步")).toBeInTheDocument();
    expect(analysis.getByRole("link", { name: "打开原始聊天" })).toHaveAttribute(
      "href",
      expect.stringContaining(`/sources/${source.id}/original`),
    );
    expect(
      within(screen.getByRole("dialog", { name: "生成报告" })).getByRole("checkbox", { name: /雨后散步/ }),
    ).toBeChecked();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith(`/sources/${source.id}/chat-analysis`) &&
          init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("Obsidian 是独立资料工具，并打开当前工作区而不是复制资料", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    render(<App />);

    await openDefaultWorkspace();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "资料工具" }),
      ).getByRole("button", { name: "Obsidian" }),
    );

    expect(invoke).toHaveBeenCalledWith("open_obsidian", { workspacePath: "/tmp/vault-v0.1" });

  });

  it("从长文本预览候选并确认生成单人物资料与报告", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "AI 工作区" }),
      ).getByRole("button", { name: "AI 自动填入" }),
    );

    const sourceText = "姓名：林澄\n关系：朋友\n职业：建筑设计师";
    await user.type(screen.getByLabelText("原始长文本"), sourceText);
    await user.click(screen.getByRole("button", { name: "整理资料" }));

    expect(await screen.findByText("识别到 1 条候选")).toBeInTheDocument();
    expect(screen.getByLabelText("姓名")).toHaveValue("林澄");
    expect(screen.getByLabelText("与我的关系")).toHaveValue("朋友");
    expect(screen.getByText("职业：建筑设计师")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "确认并生成完整资料" }),
    );

    expect(
      await screen.findByText("已保存原文、1 条证据与人物条目，并生成报告。"),
    ).toBeInTheDocument();
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined,
    }));
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/api/profile-autofill/preview",
          method: "POST",
        }),
        expect.objectContaining({ path: "/api/people", method: "POST" }),
        expect.objectContaining({ path: "/api/sources/text", method: "POST" }),
        expect.objectContaining({ path: "/api/evidence", method: "POST" }),
        expect.objectContaining({
          path: `/api/people/${person.id}/profile-entries`,
          method: "POST",
          body: expect.objectContaining({
            section: "basic_info",
            origin: "ai",
            confirmation_status: "confirmed",
          }),
        }),
        expect.objectContaining({ path: "/api/reports", method: "POST" }),
      ]),
    );
  });

  it("可在九类资料中新增并按分类显示人物信息", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    render(<App />);

    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: /^通讯录/ }));

    const peopleSection = within(
      document.querySelector("#people") as HTMLElement,
    );
    expect(
      peopleSection.getByRole("heading", { name: "基本信息" }),
    ).toBeInTheDocument();
    expect(
      peopleSection.getByRole("heading", { name: "我的观察" }),
    ).toBeInTheDocument();
    await user.selectOptions(
      peopleSection.getByLabelText("资料分类"),
      "preferences",
    );
    await user.type(peopleSection.getByLabelText("资料名称"), "饮品");
    await user.type(peopleSection.getByLabelText("资料内容"), "喜欢无糖乌龙茶");
    await user.click(
      peopleSection.getByRole("button", { name: "保存分类资料" }),
    );

    expect(
      await peopleSection.findByText("喜欢无糖乌龙茶"),
    ).toBeInTheDocument();
    expect(peopleSection.getByText("饮品")).toBeInTheDocument();
  });

  it("前端拒绝 21 张截图，并让 20 张截图按顺序进入待确认流程", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: /^通讯录/ }));
    await user.click(screen.getByRole("button", { name: /^原始材料/ }));

    const sourceSection = within(
      document.querySelector("#sources") as HTMLElement,
    );
    const input = sourceSection.getByLabelText("选择截图");
    const twentyOne = Array.from(
      { length: 21 },
      (_, index) =>
        new File([`image-${index}`], `screen-${index + 1}.png`, {
          type: "image/png",
        }),
    );
    await user.upload(input, twentyOne);
    expect(
      await screen.findByText(/一次只能选择 1 到 20 张截图/),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/screenshot-batches"),
      ),
    ).toBe(false);

    await user.upload(input, twentyOne.slice(0, 20));
    expect(sourceSection.getByText("20 张，等待上传")).toBeInTheDocument();
    await user.click(
      sourceSection.getByRole("checkbox", { name: /截图关联人物.*林澄/ }),
    );
    await user.click(
      sourceSection.getByRole("button", { name: "上传 20 张截图" }),
    );

    expect(await sourceSection.findByText("顺序 01")).toBeInTheDocument();
    expect(sourceSection.getByText("顺序 20")).toBeInTheDocument();
    expect(sourceSection.getAllByText("待确认")).toHaveLength(20);
  });

  it("编辑截图片段并确认后刷新证据", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: /^通讯录/ }));
    await user.click(screen.getByRole("button", { name: /^原始材料/ }));
    const sourceSection = within(
      document.querySelector("#sources") as HTMLElement,
    );
    const image = new File(["image"], "screen.png", { type: "image/png" });
    await user.upload(sourceSection.getByLabelText("选择截图"), image);
    await user.click(
      sourceSection.getByRole("checkbox", { name: /截图关联人物.*林澄/ }),
    );
    await user.click(
      sourceSection.getByRole("button", { name: "上传 1 张截图" }),
    );

    await user.selectOptions(
      sourceSection.getByLabelText("片段 1 说话人"),
      "other",
    );
    await user.clear(sourceSection.getByLabelText("片段 1 顺序"));
    await user.type(sourceSection.getByLabelText("片段 1 顺序"), "3");
    await user.type(
      sourceSection.getByLabelText("片段 1 文本"),
      "周末可以一起去散步。",
    );
    await user.selectOptions(
      sourceSection.getByLabelText("片段 1 不确定性"),
      "low",
    );
    await user.click(
      sourceSection.getByRole("button", { name: "确认转写并刷新证据" }),
    );

    expect(await sourceSection.findByText("已确认")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "引用与证据" }));
    expect(
      await screen.findByRole("button", {
        name: /周末可以一起去散步。.*截图片段.*查看来源/,
      }),
    ).toBeInTheDocument();
    const transcriptCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/transcript"),
    );
    expect(transcriptCall?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(transcriptCall?.[1]?.body))).toEqual({
      segments: [
        {
          order: 3,
          speaker: "other",
          text: "周末可以一起去散步。",
          uncertainty: "low",
        },
      ],
    });
  });

  it("提交引文时把浏览器 UTF-16 选区转换为 Unicode code-point locator", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: /^通讯录/ }));
    await user.click(screen.getByRole("button", { name: "引用与证据" }));

    const evidenceSection = within(
      document.querySelector("#evidence") as HTMLElement,
    );
    await user.selectOptions(
      evidenceSection.getByLabelText("选择材料"),
      source.id,
    );
    const selector = await evidenceSection.findByLabelText("可框选的来源原文");
    const body = (selector as HTMLTextAreaElement).value;
    const quote = "后来聊到最近的安排。";
    const start = body.indexOf(quote);
    const end = start + quote.length;
    (selector as HTMLTextAreaElement).setSelectionRange(start, end);
    fireEvent.select(selector);

    expect(evidenceSection.getByText(quote)).toBeInTheDocument();
    await user.click(
      evidenceSection.getByRole("button", { name: "保存原子证据" }),
    );

    const evidenceCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/evidence") && init?.method === "POST",
    );
    expect(JSON.parse(String(evidenceCall?.[1]?.body))).toMatchObject({
      quote,
      locator: {
        kind: "text_quote",
        start: Array.from(body.slice(0, start)).length,
        end: Array.from(body.slice(0, end)).length,
      },
    });
  });

  it("实时会谈确认稿可创建 Unicode 原子证据并精确回链原文", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: "会谈录音" }));

    await user.type(screen.getByLabelText("本次交谈对象姓名"), "测试称呼");
    expect(screen.getByLabelText("本次交谈对象姓名")).toHaveValue("测试称呼");
    fireEvent.click(screen.getByText("转写与校对工具"));
    await user.selectOptions(screen.getByLabelText("本次会谈人物"), person.id);
    const liveSection = within(document.querySelector("#live") as HTMLElement);
    await user.selectOptions(
      liveSection.getByLabelText("实时识别方式"),
      "demo",
    );
    await user.click(
      liveSection.getByRole("checkbox", {
        name: /我确认参与者同意本次处理/,
      }),
    );
    await user.click(liveSection.getByRole("button", { name: "开始实时会谈" }));
    act(() => {
      MockWebSocket.instance.open();
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "14141414-1414-4141-8141-141414141414",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      MockWebSocket.instance.emit({
        type: "analysis_snapshot",
        cards: [
          {
            id: "question",
            kind: "question",
            observed_at_ms: 300,
            evidence: "当前表达出现了提问。",
            hypothesis: "可能希望共同确认下一步。",
            alternative: "也可能只是普通问句。",
            question: "下一步具体指什么？",
            uncertainty: "high",
          },
        ],
      });
      MockWebSocket.instance.emit({
        type: "ended",
        transcript: "机器临时转写。",
        analysis_count: 1,
      });
    });

    const reviewSection = within(document.querySelector(".wb-live-analysis") as HTMLElement);
    const title = "实时会谈校对稿";
    const reviewedText = "开场😀校对后：我们先确认下一步。";
    const quote = "我们先确认下一步。";
    const titleInput = await reviewSection.findByLabelText("材料标题");
    await user.clear(titleInput);
    await user.type(titleInput, title);
    const transcriptInput = reviewSection.getByLabelText("会后确认稿");
    await user.clear(transcriptInput);
    await user.type(transcriptInput, reviewedText);
    expect(
      reviewSection.getByRole("checkbox", { name: person.display_name }),
    ).toBeChecked();
    await user.click(
      reviewSection.getByRole("checkbox", { name: eventRecord.title }),
    );
    await user.click(
      reviewSection.getByRole("checkbox", {
        name: /我已校对确认稿，并确认只把上述文字/,
      }),
    );
    await user.click(
      reviewSection.getByRole("button", { name: "保存转写与分析摘要" }),
    );

    expect(
      await reviewSection.findByText(
        "转写与提示已保存",
      ),
    ).toBeInTheDocument();
    const sourceCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/sources/text") && init?.method === "POST",
    );
    expect(sourceCalls).toHaveLength(2);
    expect(JSON.parse(String(sourceCalls[0]?.[1]?.body))).toEqual({
      title,
      text: reviewedText,
      source_kind: "text",
      person_ids: [person.id],
      event_ids: [eventRecord.id],
    });
    expect(JSON.parse(String(sourceCalls[1]?.[1]?.body))).toMatchObject({
      title: `${title} · 同步分析摘要`,
      text: expect.stringContaining(`分析对象：${person.display_name}`),
      source_kind: "user_observation",
      person_ids: [person.id],
      event_ids: [eventRecord.id],
    });
    await user.click(
      liveSection.getByRole("button", { name: "去创建证据" }),
    );
    const evidenceSection = document.querySelector("#evidence") as HTMLElement;
    const evidenceUi = within(evidenceSection);
    expect(evidenceUi.getByRole("option", { name: title })).toBeInTheDocument();
    expect(evidenceUi.getByLabelText("选择材料")).toHaveFocus();
    expect(evidenceUi.getByLabelText("选择材料")).toHaveValue(liveSource.id);

    const selector = evidenceUi.getByLabelText("可框选的来源原文");
    expect(selector).toHaveValue(reviewedText);
    const start = reviewedText.indexOf(quote);
    const end = start + quote.length;
    (selector as HTMLTextAreaElement).setSelectionRange(start, end);
    fireEvent.select(selector);
    await user.click(
      evidenceUi.getByRole("button", { name: "保存原子证据" }),
    );

    const evidenceCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/evidence") && init?.method === "POST",
    );
    expect(evidenceCalls).toHaveLength(1);
    expect(JSON.parse(String(evidenceCalls[0]?.[1]?.body))).toMatchObject({
      source_id: liveSource.id,
      quote,
      locator: {
        kind: "text_quote",
        start: Array.from(reviewedText.slice(0, start)).length,
        end: Array.from(reviewedText.slice(0, end)).length,
      },
    });

    const evidenceCard = evidenceUi
      .getAllByRole("button")
      .find((button) => button.textContent?.includes(quote));
    expect(evidenceCard).toBeDefined();
    await user.click(evidenceCard!);

    const inspector = within(screen.getByLabelText("证据检查器"));
    expect(await inspector.findByText(liveSource.original_path)).toBeInTheDocument();
    const original = inspector.getByLabelText("来源原文");
    expect(original).toHaveTextContent(reviewedText);
    expect(original.querySelector("mark")).toHaveTextContent(quote);
  });

  it("显示本地服务的结构化错误", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname.replace(/^\/api/, "");
        if (path === "/executors") return jsonResponse({ items: [] });
        return jsonResponse(
          {
            error: {
              code: "workspace_invalid",
              message: "目录不是有效的灵犀桥工作区",
              details: {},
            },
          },
          422,
        );
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "使用默认工作区" }));

    expect(
      await screen.findByText(
        "目录不是有效的灵犀桥工作区（workspace_invalid）",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开资料夹" })).toBeInTheDocument();
  });

  it("报告直接显示带日期的结论，继承人物复核并按需查看原文", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({ withEvidence: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    expect(await screen.findByRole("button", { name: "vault-v0.1" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "报告" }));

    const reportSection = document.querySelector("#reports");
    expect(reportSection).not.toBeNull();
    expect(reportSection).toHaveClass("report-workspace");
    expect(reportSection).not.toHaveClass("section-card");
    expect(document.querySelector(".main-column")).toHaveClass(
      "report-workspace-active",
    );
    expect(reportSection?.parentElement).toHaveClass("report-workspace-shell");
    const reportUi = within(document.body);
    await user.click(screen.getByRole("tab", { name: "生成报告" }));
    expect(
      document.querySelector(".report-composer")?.closest("dialog")?.getAttribute("aria-modal"),
    ).toBe("true");


    await user.click(reportUi.getByRole("button", { name: "沟通准备" }));
    await user.type(
      reportUi.getByLabelText("补充问题"),
      "下次沟通前，哪些事实需要先核对？",
    );
    expect(within(screen.getByRole("dialog", { name: "生成报告" })).getByRole("checkbox", { name: /雨后散步/ })).toBeChecked();
    await user.click(
      reportUi.getByRole("checkbox", {
        name: "我已核对本次选择的原始材料。",
      }),
    );
    await user.click(reportUi.getByRole("button", { name: "确认生成报告" }));

    const report = await reportUi.findByLabelText("当前报告");
    expect(report).toHaveTextContent("材料记录了雨后一起步行回家的经历。");
    expect(within(report).getByText(/一种可能是：/)).toBeInTheDocument();
    expect(within(report).queryByText("复核写入")).not.toBeInTheDocument();
    expect(within(report).queryByRole("combobox")).not.toBeInTheDocument();
    expect(report.querySelector("time")).toHaveAttribute("dateTime", reportResponse.snapshot.created_at);
    expect(within(report).queryByRole("button", { name: "准确，保留" })).not.toBeInTheDocument();
    const quiz = within(screen.getByRole("region", { name: "逐题核对报告" }));
    await user.click(quiz.getByRole("button", { name: "准确，保留" }));
    await quiz.findByText("已记录 1 / 2");
    const profileCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes(`/people/${person.id}/profile-entries`) &&
        init?.method === "POST",
    );
    expect(JSON.parse(String(profileCall?.[1]?.body))).toMatchObject({
      section: "user_observations",
      label: "AI 候选描述",
      value: "材料记录了雨后一起步行回家的经历。",
      origin: "ai",
      confirmation_status: "confirmed",
      evidence_ids: [evidence.id],
    });

    await user.click(quiz.getByRole("button", { name: "不准确，退回" }));
    expect(await quiz.findByText("已记录 2 / 2")).toBeInTheDocument();
    const profileCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(`/people/${person.id}/profile-entries`) &&
        init?.method === "POST",
    );
    expect(profileCalls).toHaveLength(2);
    expect(JSON.parse(String(profileCalls[1]?.[1]?.body))).toMatchObject({
      section: "user_observations",
      label: "AI 候选描述",
      value: "安静同行可能是双方都能接受的相处方式。",
      origin: "ai",
      confirmation_status: "rejected",
      evidence_ids: [evidence.id],
    });

    await user.click(quiz.getByText("全部判断与依据"));
    await user.click(quiz.getAllByRole("button", { name: "原文 1" })[0]);

    expect(await screen.findByText(source.original_path)).toBeInTheDocument();
    expect(screen.getByLabelText("来源原文")).toHaveTextContent(
      "雨停以后，我们慢慢走回家",
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/records/${source.id}`),
        expect.any(Object),
      ),
    );
    const reportCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/reports") && init?.method === "POST",
    );
    expect(JSON.parse(String(reportCall?.[1]?.body))).toMatchObject({
      template_family: "special",
      template_variant: "communication_prep",
      analysis_question: expect.stringContaining(
        "下次沟通前，哪些事实需要先核对？",
      ),
      person_ids: [person.id],
      evidence_ids: [evidence.id],
    });
  });

  it("从已确认的文本材料直接建立精确引用并按显式类型生成报告", async () => {
    const user = userEvent.setup();
    const fetchMock = baseRouter({
      withEvidence: true,
      includeEvidence: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: "报告" }));
    const reportUi = within(document.body);
    await user.click(screen.getByRole("tab", { name: "生成报告" }));
    await user.click(reportUi.getByRole("button", { name: "聊天记录分析" }));
    await user.click(
      reportUi.getByRole("checkbox", {
        name: "我已核对本次选择的原始材料。",
      }),
    );
    await user.click(reportUi.getByRole("button", { name: "确认生成报告" }));

    expect(await reportUi.findByLabelText("当前报告")).toHaveTextContent("材料记录了雨后一起步行回家的经历。");
    const evidenceCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/evidence") && init?.method === "POST",
    );
    expect(evidenceCalls).toHaveLength(3);
    expect(JSON.parse(String(evidenceCalls[0]?.[1]?.body))).toMatchObject({
      source_id: source.id,
      quote: "序言：雨停以后，我们慢慢走回家。😀后来聊到最近的安排。",
      evidence_kind: "direct_quote",
      reliability: "high",
      person_ids: [person.id],
    });
    expect(
      evidenceCalls.map(([, init]) => JSON.parse(String(init?.body)).quote),
    ).not.toContain("日期：2026-07-27");
    const advisorCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/report-advisor/preview") &&
        init?.method === "POST",
    );
    expect(JSON.parse(String(advisorCall?.[1]?.body))).toMatchObject({
      template_family: "special",
      template_variant: "custom",
    });
  });

  it("旧报告缺少执行元数据时仍可在阅读器打开", async () => {
    const user = userEvent.setup();
    const legacyReport = {
      topic: reportResponse.topic,
      snapshot: reportResponse.snapshot,
      analysis: reportResponse.analysis,
    };
    vi.stubGlobal("fetch", baseRouter({ historyReports: [legacyReport] }));
    render(<App />);

    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: "报告" }));

    const reportUi = within(document.body);
    await user.click(reportUi.getByRole("tab", { name: "阅读报告" }));
    await user.click(
      reportUi.getByRole("button", { name: /散步后的沟通准备/ }),
    );

    expect(await reportUi.findByLabelText("当前报告")).toHaveTextContent(
      reportResponse.topic.title,
    );
    expect(
      screen.queryByText("这份历史记录缺少完整报告内容，请刷新工作区后重试。"),
    ).not.toBeInTheDocument();
  });
  it("关闭会谈窗格并浏览原文时保留同一录音会话", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<App />);
    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: "会谈录音" }));
    const liveUi = within(document.querySelector("#live") as HTMLElement);
    await user.click(screen.getByText("转写与校对工具"));
    await user.selectOptions(liveUi.getByLabelText("实时识别方式"), "demo");
    await user.click(liveUi.getByRole("checkbox", { name: /我确认参与者同意/ }));
    await user.click(liveUi.getByRole("button", { name: "开始实时会谈" }));
    const socket = MockWebSocket.instance;
    act(() => { socket.open(); socket.emit({ type: "started", session_id: "14141414-1414-4141-8141-141414141414", recognizer: "demo", data_destination: "local_only", audio_saved: false }); });
    await user.click(screen.getByRole("button", { name: "关闭依据窗格" }));
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    await user.click(within(screen.getByRole("navigation", { name: "当前人物资料目录" })).getByRole("button", { name: source.title }));
    expect(await screen.findByText("文档已加载，可选择分析任务并点击运行。")).toBeInTheDocument();
    act(() => socket.emit({ type: "transcript_delta", speaker: "other", sequence: 1, text: "继续讨论这个问题", committed_text: "继续讨论这个问题", interim_text: "", is_final: true, start_ms: 0, end_ms: 600 }));
    await user.click(screen.getByRole("button", { name: "恢复默认布局" }));
    expect(MockWebSocket.instance).toBe(socket);
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(await liveUi.findByText("继续讨论这个问题", { selector: ".live-timeline p" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "会谈模块" }));
    expect(liveUi.getByRole("button", { name: "停止" })).toBeEnabled();
  });

  it("事件作为一级对象并通过修订号保存地点与简述", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    const update = vi.spyOn(api, "updateEvent").mockResolvedValue({ ...eventRecord, schema_version: "0.1", entity_type: "event", revision: 2, location: "项目讨论室", summary: "核对下一次沟通的时间安排" });
    render(<App />);
    await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: "事件模块" }));
    await user.click(within(screen.getByRole("navigation", { name: "事件目录" })).getByRole("button", { name: eventRecord.title }));
    await user.type(screen.getByLabelText("事件地点"), "项目讨论室");
    await user.type(screen.getByLabelText("事件简述"), "核对下一次沟通的时间安排");
    await user.click(screen.getByRole("button", { name: "保存事件信息" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(eventRecord.id, expect.objectContaining({ location: "项目讨论室", summary: "核对下一次沟通的时间安排", expected_revision: 1 })));
    expect(await screen.findByText(`已保存事件“${eventRecord.title}”。`)).toBeInTheDocument();
  });

  it("事件运行需确认范围，并把真实接口返回的候选节点回链原文", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    vi.spyOn(api, "listSources").mockResolvedValue({ items: [{ ...source, schema_version: "0.1", entity_type: "source", source_kind: "text", event_ids: [eventRecord.id] }] });
    vi.spyOn(api, "getDirectModelSettings").mockResolvedValue({ base_url: "https://model.example.test/v1", model: "test-model", key_env: "", has_key: true, configured: true, key_storage: "session" });
    const quote = "雨停以后，我们慢慢走回家。";
    const body = ["# 雨后散步", "", "日期：2026-07-27", "", "序言：雨停以后，我们慢慢走回家。😀后来聊到最近的安排。", "", "我们在路口停下来，先核对下周各自能空出的时间。", "", "到家前，我们约定有变化就直接说明，不让对方猜。"].join("\n");
    const start = Array.from(body.slice(0, body.indexOf(quote))).length;
    const analyzed: EventRecord = { ...eventRecord, schema_version: "0.1", entity_type: "event", revision: 2, analysis: { schema_version: "0.1", generated_at: "2026-11-09T12:00:00Z", engine: "api", event_revision: 1, source_ids: [source.id], source_hashes: { [source.id]: source.sha256 }, source_text_hashes: { [source.id]: "b".repeat(64) }, summary: "材料描述了一次雨后共同步行的经过，后续安排仍需核对。", nodes: [{ id: "abababab-abab-4bab-8bab-abababababab", label: "雨后步行", source_id: source.id, quote, quote_start: start, quote_end: start + Array.from(quote).length, status: "candidate" }] } };
    const run = vi.spyOn(api, "analyzeEvent").mockResolvedValue(analyzed);
    render(<App />);
    await openDefaultWorkspace();
    await user.click(within(screen.getByRole("navigation", { name: "事件目录" })).getByRole("button", { name: eventRecord.title }));
    expect(screen.getByRole("button", { name: "运行当前任务" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /我已确认将勾选的文本或转写材料/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "运行当前任务" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "运行当前任务" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith(eventRecord.id, { source_ids: [source.id], engine: "api", scope_confirmed: true, expected_revision: 1 }));
    expect(await screen.findByText(analyzed.analysis!.summary)).toBeInTheDocument();
    expect(screen.getByLabelText("候选节点名称：雨后步行")).toHaveValue("雨后步行");
    await user.click(within(screen.getByRole("region", { name: "过程与依据" })).getByRole("button", { name: new RegExp(quote) }));
    expect(await within(document.querySelector(".locator-preview") as HTMLElement).findByText(quote)).toBeInTheDocument();
    const sourceMark = await within(screen.getByRole("complementary", { name: "证据检查器" })).findByText(quote, { selector: ".source-body mark" });
    expect(sourceMark).toBeVisible();
  });

  it("阅读旧快照后显式更新仍使用当前主题修订号", async () => {
    const user = userEvent.setup();
    const latest = { ...reportResponse, topic: { ...reportResponse.topic, revision: 4, snapshot_count: 3 }, snapshot: { ...reportResponse.snapshot, version: 3 } } as ReportListItem;
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true, historyReports: [latest] }));
    vi.spyOn(api, "listReportVersions").mockResolvedValue({ items: [reportResponse as ReportListItem] });
    const save = vi.spyOn(api, "createReport").mockResolvedValue({ ...reportResponse, topic: { ...reportResponse.topic, revision: 5, snapshot_count: 4 }, snapshot: { ...reportResponse.snapshot, version: 4 } } as ReportResponse);
    render(<App />);
    await openDefaultWorkspace();
    await user.click(within(screen.getByRole("navigation", { name: "人物与报告" })).getByRole("button", { name: /报告/ }));
    await user.click(screen.getByRole("button", { name: "版本" }));
    await user.click(await within(document.querySelector(".wb-report-versions") as HTMLElement).findByRole("button", { name: /v1/ }));
    const reportUi = within(document.body);
    await user.click(reportUi.getByRole("tab", { name: "生成报告" }));
    await user.selectOptions(reportUi.getByLabelText("报告保存方式"), reportResponse.topic.id);
    await user.click(reportUi.getByRole("checkbox", { name: /我已核对本次选择的原始材料/ }));
    await user.click(reportUi.getByRole("button", { name: "确认生成报告" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ topic_id: reportResponse.topic.id, expected_revision: 4, template_family: reportResponse.topic.template_family, template_variant: reportResponse.topic.template_variant })));
    expect(await reportUi.findByLabelText("当前报告")).toBeInTheDocument();
  });

  it("明确选择本地R图后才把绘图要求写入报告请求", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    vi.spyOn(api, "getPlottingCapabilities").mockResolvedValue({ available: true, r_version: "4.5.2", ggplot2_version: "4.0.0" });
    const save = vi.spyOn(api, "createReport").mockResolvedValue(reportResponse as ReportResponse);
    render(<App />);
    await openDefaultWorkspace();
    await user.click(within(screen.getByRole("navigation", { name: "人物与报告" })).getByRole("button", { name: /报告/ }));
    const reportUi = within(document.body);
    await user.click(screen.getByRole("tab", { name: "生成报告" }));
    const charts = reportUi.getByRole("checkbox", { name: /附加 R 统计图/ });
    await waitFor(() => expect(charts).toBeEnabled());
    expect(charts).not.toBeChecked();
    await user.click(charts);
    await user.click(reportUi.getByRole("checkbox", { name: /我已核对本次选择的原始材料/ }));
    await user.click(reportUi.getByRole("button", { name: "确认生成报告" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ include_charts: true })));
  });

  it("切换工作区后忽略旧区延迟报告，不把旧报告载入空工作区", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    vi.stubGlobal("lingxiDesktop", { selectWorkspace: vi.fn().mockResolvedValue("/tmp/vault-b"), defaultWorkspace: vi.fn().mockResolvedValue("/tmp/vault-v0.1") });
    let active = "a";
    const originalOpen = api.openWorkspace.bind(api);
    vi.spyOn(api, "openWorkspace").mockImplementation(async path => {
      const response = await originalOpen(path);
      active = path.endsWith("vault-b") ? "b" : "a";
      return { ...response, path };
    });
    for (const method of ["listPeople", "listEvents", "listSources", "listEvidence", "listReports"] as const) {
      const original = api[method].bind(api);
      vi.spyOn(api, method).mockImplementation((() => active === "b" ? Promise.resolve({ items: [] }) : original()) as never);
    }
    window.localStorage.setItem("lingxi.preferences.v1", JSON.stringify({ textEngine: "api" }));
    vi.spyOn(api, "getDirectModelSettings").mockResolvedValue({ base_url: "https://example.test/v1", model: "test", key_env: "", has_key: true, configured: true, key_storage: "session" });
    vi.spyOn(api, "previewProfileAutofill").mockResolvedValue({ preview: { schema_version: "0.1", person: { display_name: "A区待保存人物", relation_to_user: "朋友" }, candidates: [], skipped_sections: [] }, execution: { engine: "api", profile_id: "inherited", data_destination: "configured_api_endpoint" } });
    const savePerson = vi.spyOn(api, "createAssistantPerson");
    let resolve!: (value: ReportResponse) => void;
    const save = vi.spyOn(api, "createReport").mockReturnValue(new Promise(done => { resolve = done; }));
    render(<App />);
    await openDefaultWorkspace();
    await user.click(within(screen.getByRole("navigation", { name: "人物与报告" })).getByRole("button", { name: /报告/ }));
    const reportUi = within(document.body);
    await user.click(screen.getByRole("tab", { name: "生成报告" }));
    await user.click(reportUi.getByRole("checkbox", { name: /我已核对本次选择的原始材料/ }));
    await user.click(reportUi.getByRole("button", { name: "确认生成报告" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "vault-v0.1" }));
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await screen.findByRole("button", { name: "vault-b" });
    expect(screen.queryByRole("button", { name: "保存人物" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "告诉 AI 你想完成什么" })).not.toHaveValue("A区私有候选原文");
    expect(savePerson).not.toHaveBeenCalled();
    await act(async () => { resolve({ ...reportResponse, topic: { ...reportResponse.topic, title: "A区迟到报告" } } as ReportResponse); });
    expect(screen.queryByText("A区迟到报告")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("当前报告")).not.toBeInTheDocument();
    expect(screen.queryByText(/报告已生成/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "vault-b" })).toBeInTheDocument();
  });

  it("人物报告列表可直接进入阅读，切换人物不显示上一人的报告", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", baseRouter({ withEvidence: true, historyReports: [reportResponse] }));
    const second = { ...person, id: "22222222-2222-4222-8222-222222222222", display_name: "陈溪（虚构）" };
    vi.spyOn(api, "listPeople").mockResolvedValue({ items: [person, second] });
    render(<App />); await openDefaultWorkspace();
    await user.click(screen.getByRole("button", { name: "人物模块" }));
    await user.click(within(screen.getByRole("navigation", { name: "当前人物资料目录" })).getByRole("button", { name: /报告主题/ }));
    await user.click(within(document.querySelector(".person-report-history") as HTMLElement).getByRole("button", { name: /散步后的沟通准备/ }));
    expect(screen.getByLabelText("当前报告")).toHaveTextContent(reportResponse.topic.title);
    expect(screen.getByRole("tab", { name: "阅读报告" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByText(/人物资料 ·/));
    await user.selectOptions(screen.getByLabelText("当前人物"), second.id);
    await user.click(screen.getByRole("button", { name: "报告模块" }));
    expect(screen.queryByLabelText("当前报告")).not.toBeInTheDocument();
    expect(screen.getByText("选择一份报告开始阅读")).toBeInTheDocument();
  });

  it("新建事件弹窗取消后保留当前事件与编辑稿", async () => {
    const user = userEvent.setup(); vi.stubGlobal("fetch", baseRouter({ withEvidence: true }));
    render(<App />); await openDefaultWorkspace();
    await user.click(within(screen.getByRole("navigation", { name: "事件目录" })).getByRole("button", { name: eventRecord.title }));
    const original = screen.getByLabelText("事件名称") as HTMLInputElement;
    await user.clear(original); await user.type(original, "尚未保存的修改");
    await user.click(within(screen.getByRole("navigation", { name: "事件目录" })).getByRole("button", { name: "新建事件" }));
    const dialog = screen.getByRole("dialog", { name: "新建事件" });
    expect(within(screen.getByLabelText("人物上下文")).getByRole("heading", { name: eventRecord.title })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("事件名称"), "未创建的新事件");
    await user.click(within(dialog).getByRole("button", { name: "关闭新建事件" }));
    expect(screen.getByLabelText("事件名称")).toHaveValue("尚未保存的修改");
  });

});
