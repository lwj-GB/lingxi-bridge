import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pcmWorkletSource from "../public/pcm-worklet.js?raw";
import { LiveSession } from "./LiveSession";
import { api } from "./api";
import {
  BrowserSpeechStream,
  downsampleTo16kPcm,
  parseLiveServerEvent,
} from "./realtimeClient";

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

  disconnect() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("LiveSession", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires separate API scope consent and forwards the live analysis switch", async () => {
    vi.spyOn(api, "getDirectModelSettings").mockResolvedValue({
      base_url: "http://127.0.0.1:8791", model: "fictional-test", key_env: "",
      has_key: true, configured: true, key_storage: "session",
    });
    const user = userEvent.setup();
    render(<LiveSession defaultRecognizer="demo" />);
    await user.selectOptions(screen.getByLabelText("会谈分析方式"), "api");
    await screen.findByText("fictional-test · http://127.0.0.1:8791");
    await user.click(screen.getByLabelText("我确认参与者同意本次处理"));
    expect(screen.getByRole("button", { name: "开始实时会谈" })).toBeDisabled();
    await user.click(screen.getByLabelText(/允许将本次已确认的对方发言/));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const socket = MockWebSocket.instance;
    act(() => socket.open());
    expect(socket.sent.map(String).map(value => JSON.parse(value))).toContainEqual(
      expect.objectContaining({ type: "start", analysis_api: { scope_confirmed: true, enabled: true } }),
    );
    await user.click(screen.getByRole("button", { name: "关闭同步分析" }));
    expect(socket.sent.map(String).map(value => JSON.parse(value))).toContainEqual({
      type: "analysis_control", enabled: false,
    });
  });

  it("keeps a live session running while its pane is hidden and analysis is in a separate pane", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const user = userEvent.setup();
    const view = render(
      <div hidden={false}>
        <LiveSession analysisContainer={target} defaultRecognizer="demo" />
      </div>,
    );
    try {
      expect(within(target).getByText("同步分析")).toBeInTheDocument();
      expect(view.container.querySelector(".live-analysis")).toBeNull();
      await user.click(screen.getByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
      const socket = MockWebSocket.instance;
      act(() => {
        socket.open();
        socket.emit({
          type: "started",
          session_id: "11111111-1111-4111-8111-111111111111",
          recognizer: "demo",
          data_destination: "local_only",
          audio_saved: false,
        });
      });
      view.rerender(
        <div hidden>
          <LiveSession analysisContainer={target} defaultRecognizer="demo" />
        </div>,
      );
      act(() => socket.emit({
        type: "transcript_delta", speaker: "other", sequence: 1,
        text: "可以继续谈这件事", committed_text: "可以继续谈这件事",
        interim_text: "", is_final: true, start_ms: 0, end_ms: 600,
      }));
      expect(socket.readyState).toBe(MockWebSocket.OPEN);
      expect(view.container).toHaveTextContent("可以继续谈这件事");
      view.rerender(
        <div hidden={false}>
          <LiveSession analysisContainer={target} defaultRecognizer="demo" />
        </div>,
      );
      expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
      expect(MockWebSocket.instance).toBe(socket);
    } finally {
      view.unmount();
      target.remove();
    }
  });

  it("captures the selected person and event without reassigning a recording while browsing", async () => {
    const user = userEvent.setup();
    const people = [
      { id: "10000000-0000-4000-8000-000000000001", display_name: "林舟" },
      { id: "10000000-0000-4000-8000-000000000002", display_name: "陈溪" },
    ];
    const events = [
      { id: "20000000-0000-4000-8000-000000000001", title: "安排讨论" },
      { id: "20000000-0000-4000-8000-000000000002", title: "周末计划" },
    ];
    const save = vi.fn().mockResolvedValue(undefined);
    const view = render(<LiveSession workspacePath="/tmp/fictional-vault"
      people={people} events={events} defaultRecognizer="demo"
      defaultPersonId={people[0].id} defaultEventId={events[0].id}
      onSaveTranscript={save} />);
    expect(screen.getByLabelText("默认分析对象")).toHaveValue(people[0].id);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const socket = MockWebSocket.instance;
    act(() => {
      socket.open();
      socket.emit({ type: "started", session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo", data_destination: "local_only", audio_saved: false });
    });
    view.rerender(<LiveSession workspacePath="/tmp/fictional-vault"
      people={people} events={events} defaultRecognizer="demo"
      defaultPersonId={people[1].id} defaultEventId={events[1].id}
      onSaveTranscript={save} />);
    expect(screen.getByLabelText("默认分析对象")).toHaveValue(people[0].id);
    act(() => socket.emit({ type: "transcript_delta", speaker: "other", sequence: 1,
      text: "先把时间安排说清楚。", committed_text: "先把时间安排说清楚。",
      interim_text: "", is_final: true, start_ms: 0, end_ms: 1000 }));
    await user.click(screen.getByRole("button", { name: "停止" }));
    act(() => socket.emit({ type: "ended", transcript: "先把时间安排说清楚。", analysis_count: 0 }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      person_ids: [people[0].id], event_ids: [events[0].id],
    })));
  });

  it("shows the selected audio destination and requires renewed consent when it changes", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    expect(screen.getByLabelText("音频去向")).toHaveTextContent("由浏览器语音服务处理");
    expect(screen.getByText("连接详情").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("查看会谈提示").closest("details")).not.toHaveAttribute("open");
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "开始实时会谈" })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("实时识别方式"), "doubao");
    expect(screen.getByLabelText("音频去向")).toHaveTextContent("音频发送至豆包");
    expect(screen.getByRole("button", { name: "开始实时会谈" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    expect(screen.getByLabelText("音频去向")).toHaveTextContent("不使用麦克风");
  });

  it("streams the local demo into transcript and cautious analysis cards", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();

    expect(JSON.parse(String(MockWebSocket.instance.sent[0]))).toEqual({
      type: "start",
      recognizer: "demo",
      consent: true,
      default_speaker: "other",
      analysis_mode: "observe",
    });

    MockWebSocket.instance.emit({
      type: "started",
      session_id: "11111111-1111-4111-8111-111111111111",
      recognizer: "demo",
      data_destination: "local_only",
      audio_saved: false,
    });
    MockWebSocket.instance.emit({
      type: "transcript_delta",
      speaker: "other",
      sequence: 1,
      text: "我不太确定",
      committed_text: "",
      interim_text: "我不太确定",
      is_final: false,
      start_ms: 0,
      end_ms: 420,
    });
    MockWebSocket.instance.emit({
      type: "analysis_snapshot",
      cards: [
        {
          id: "uncertainty",
          kind: "uncertainty",
          observed_at_ms: 420,
          evidence: "当前表达出现了不确定性措辞“可能”。",
          hypothesis: "这可能是在主动保留判断空间。",
          alternative: "也可能只是日常口头语。",
          question: "哪些部分还需要核对？",
          uncertainty: "high",
        },
      ],
    });

    expect((await screen.findAllByText("我不太确定")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("解释性假设")).not.toBeVisible();
    await user.click(screen.getByText("查看会谈提示"));
    expect(screen.getByText("解释性假设")).toBeVisible();
    expect(
      screen.getByText("这可能是在主动保留判断空间。"),
    ).toBeInTheDocument();
    MockWebSocket.instance.emit({ type: "analysis_snapshot", cards: [] });
    await waitFor(() =>
      expect(screen.queryByText("解释性假设")).not.toBeInTheDocument(),
    );
  });

  it("streams goal advice and a pause-based live summary", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    expect(screen.queryByText("本次数据去向")).not.toBeInTheDocument();
    expect(
      screen.queryByText("本机界面测量，不代表云端服务内部耗时。"),
    ).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("button", { name: "目标模式" }));
    const goal = screen.getByLabelText("会谈目标");
    expect(screen.getByRole("button", { name: "开始实时会谈" })).toBeDisabled();

    await user.type(goal, "安慰对方，先听清楚感受，不急着给方案。");
    await user.click(
      screen.getByRole("checkbox", { name: "我确认参与者同意本次处理" }),
    );
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();

    expect(JSON.parse(String(MockWebSocket.instance.sent[0]))).toEqual({
      type: "start",
      recognizer: "demo",
      consent: true,
      default_speaker: "other",
      analysis_mode: "goal",
      goal: "安慰对方，先听清楚感受，不急着给方案。",
    });

    MockWebSocket.instance.emit({
      type: "insight_snapshot",
      observed_at_ms: 420,
      is_updating: true,
      intent: "",
      reply_points: [],
      cautions: [],
      summary_points: [],
      topics: [],
    });
    expect(await screen.findByText("正在结合最新发言…")).toBeInTheDocument();

    MockWebSocket.instance.emit({
      type: "insight_snapshot",
      observed_at_ms: 900,
      is_updating: false,
      intent: "对方可能希望先被倾听和理解。",
      reply_points: ["先复述并确认对方的感受。"],
      cautions: ["不要急着否定或给出结论。"],
      summary_points: ["对面：最近有点难过，希望有人愿意听。"],
      topics: ["情绪支持"],
    });
    expect(
      await screen.findByText("对方可能希望先被倾听和理解。"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("先复述并确认对方的感受。"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("对面：最近有点难过，希望有人愿意听。"),
    ).toBeInTheDocument();
  });

  it("replaces interim timeline segments and settles final segments without duplicates", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    MockWebSocket.instance.emit({
      type: "started",
      session_id: "11111111-1111-4111-8111-111111111111",
      recognizer: "demo",
      data_destination: "local_only",
      audio_saved: false,
    });
    MockWebSocket.instance.emit({
      type: "transcript_delta",
      speaker: "other",
      sequence: 1,
      text: "我不太",
      committed_text: "",
      interim_text: "我不太",
      is_final: false,
      start_ms: 0,
      end_ms: 220,
    });

    const timeline = await screen.findByRole("list", {
      name: "转写分段时间线",
    });
    expect(within(timeline).getByText("我不太")).toBeInTheDocument();
    expect(within(timeline).getByText("临时")).toBeInTheDocument();

    MockWebSocket.instance.emit({
      type: "transcript_delta",
      speaker: "other",
      sequence: 2,
      text: "我不太确定",
      committed_text: "",
      interim_text: "我不太确定",
      is_final: false,
      start_ms: 0,
      end_ms: 420,
    });
    await waitFor(() =>
      expect(within(timeline).queryByText("我不太")).not.toBeInTheDocument(),
    );
    expect(within(timeline).getByText("我不太确定")).toBeInTheDocument();

    MockWebSocket.instance.emit({
      type: "transcript_delta",
      speaker: "other",
      sequence: 3,
      text: "我不太确定",
      committed_text: "我不太确定",
      interim_text: "",
      is_final: true,
      start_ms: 0,
      end_ms: 520,
    });
    await waitFor(() =>
      expect(within(timeline).getByText("已确认")).toBeInTheDocument(),
    );
    expect(within(timeline).getAllByText("我不太确定")).toHaveLength(1);

    MockWebSocket.instance.emit({
      type: "transcript_delta",
      speaker: "me",
      sequence: 4,
      text: "我们先确认下一步。",
      committed_text: "我不太确定我们先确认下一步。",
      interim_text: "",
      is_final: true,
      start_ms: 520,
      end_ms: 980,
    });
    await waitFor(() =>
      expect(within(timeline).getAllByText("已确认")).toHaveLength(2),
    );
    expect(
      within(timeline).getByText("我们先确认下一步。"),
    ).toBeInTheDocument();
  });

  it("keeps locally measured timing and the timeline visible after the session ends", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
    });

    now.mockReturnValue(1450);
    act(() => {
      MockWebSocket.instance.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "先说明事实。",
        committed_text: "先说明事实。",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 400,
      });
    });
    expect(screen.getByText("450 毫秒")).toBeInTheDocument();

    now.mockReturnValue(3600);
    act(() => {
      MockWebSocket.instance.emit({
        type: "ended",
        transcript: "先说明事实。",
        analysis_count: 0,
      });
    });

    expect(screen.getByText("00:02.6")).toBeInTheDocument();
    expect(
      screen.queryByText("本机界面测量，不代表云端服务内部耗时。"),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "转写分段时间线" })).getByText(
        "先说明事实。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("会话记录")).toBeInTheDocument();
  });

  it("automatically archives an explicitly stopped session to the selected contact", async () => {
    const user = userEvent.setup();
    const onSaveTranscript = vi.fn().mockResolvedValue(undefined);
    render(
      <LiveSession
        workspacePath="/tmp/lingxi-vault"
        people={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            display_name: "林澄",
          },
        ]}
        onSaveTranscript={onSaveTranscript}
      />,
    );

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.selectOptions(
      screen.getByLabelText("默认分析对象"),
      "11111111-1111-4111-8111-111111111111",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      MockWebSocket.instance.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "我们下周再确认一次。",
        committed_text: "我们下周再确认一次。",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 600,
      });
    });

    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(
      JSON.parse(String(MockWebSocket.instance.sent.at(-1))),
    ).toEqual({ type: "stop" });
    act(() => {
      MockWebSocket.instance.emit({
        type: "ended",
        transcript: "我们下周再确认一次。",
        analysis_count: 0,
      });
    });

    await waitFor(() => expect(onSaveTranscript).toHaveBeenCalledOnce());
    expect(onSaveTranscript).toHaveBeenCalledWith({
      title: expect.stringMatching(/· 林澄 · 实时会谈$/),
      text: "[00:00.0–00:00.6][对面] 我们下周再确认一次。",
      analysis_text: expect.stringContaining("本次没有生成同步分析提示"),
      person_ids: ["11111111-1111-4111-8111-111111111111"],
      event_ids: [],
    });
    expect(
      await screen.findByText(
        "转写与提示已保存",
      ),
    ).toBeInTheDocument();
  });

  it("saves only the edited post-session transcript after explicit local confirmation", async () => {
    const user = userEvent.setup();
    const onSaveTranscript = vi.fn().mockResolvedValue(undefined);
    render(
      <LiveSession
        workspacePath="/tmp/lingxi-vault"
        people={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            display_name: "林澄",
          },
        ]}
        events={[
          {
            id: "22222222-2222-4222-8222-222222222222",
            title: "周末沟通",
          },
        ]}
        onSaveTranscript={onSaveTranscript}
      />,
    );

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "33333333-3333-4333-8333-333333333333",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      MockWebSocket.instance.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "机器转写初稿。",
        committed_text: "机器转写初稿。",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 500,
      });
      MockWebSocket.instance.emit({
        type: "ended",
        transcript: "机器转写初稿。",
        analysis_count: 0,
      });
    });

    const review = await screen.findByLabelText("会后确认稿");
    const liveConsent = screen.getByRole("checkbox", {
      name: /我确认参与者同意/,
    });
    expect(liveConsent).not.toBeChecked();
    await user.click(liveConsent);
    expect(
      screen.getByText(
        "有未保存的转写，请先保存或放弃。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeDisabled();
    await user.clear(review);
    await user.type(review, "人工校对后的文字🙂");
    await user.click(screen.getByRole("checkbox", { name: "林澄" }));
    await user.click(screen.getByRole("checkbox", { name: "周末沟通" }));
    await user.click(
      screen.getByRole("checkbox", {
        name: /我已校对确认稿，并确认只把上述文字/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "保存转写与分析摘要" }),
    );

    await waitFor(() => expect(onSaveTranscript).toHaveBeenCalledOnce());
    expect(onSaveTranscript).toHaveBeenCalledWith({
      title: expect.stringMatching(/· 会谈对象 · 实时会谈$/),
      text: "人工校对后的文字🙂",
      analysis_text: expect.stringContaining("本次没有生成同步分析提示"),
      person_ids: ["11111111-1111-4111-8111-111111111111"],
      event_ids: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(
      screen.getByText(
        "转写与提示已保存",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeEnabled();
  });

  it("keeps the final transcript in memory when no workspace is open", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      MockWebSocket.instance.emit({
        type: "ended",
        transcript: "页面内保留的最终确认稿。",
        analysis_count: 0,
      });
    });

    expect(
      await screen.findByText(
        "打开工作区后即可保存，转写暂留在此页。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("页面内保留的最终确认稿。")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "保存转写与分析摘要" }),
    ).not.toBeInTheDocument();
  });

  it("stops receiving analysis cards while disabled and keeps transcription active", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
    });

    await user.click(screen.getByRole("button", { name: "关闭同步分析" }));
    expect(screen.queryByText("查看会谈提示")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开启同步分析" })).toHaveAttribute(
      "aria-pressed", "false",
    );
    act(() => {
      MockWebSocket.instance.emit({
        type: "analysis_snapshot",
        cards: [
          {
            id: "request",
            kind: "request",
            observed_at_ms: 700,
            evidence: "隐藏期间收到的新提示",
            hypothesis: "这可能是在表达一个行动方向。",
            alternative: "也可能只是尚未确定的想法。",
            question: "接下来最小的一步是什么？",
            uncertainty: "high",
          },
        ],
      });
    });

    expect(screen.getByText("已关闭")).toBeInTheDocument();
    expect(screen.queryByText("隐藏期间收到的新提示")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开启同步分析" }));
    expect(screen.queryByText("隐藏期间收到的新提示")).not.toBeInTheDocument();
    act(() => {
      MockWebSocket.instance.emit({
        type: "analysis_snapshot",
        cards: [
          {
            id: "request",
            kind: "request",
            observed_at_ms: 900,
            evidence: "重新开启后的新提示",
            hypothesis: "这可能是在表达一个行动方向。",
            alternative: "也可能只是尚未确定的想法。",
            question: "接下来最小的一步是什么？",
            uncertainty: "high",
          },
        ],
      });
    });
    expect(
      await screen.findByText("重新开启后的新提示"),
    ).toBeInTheDocument();
  });

  it("locates the transcript segment related to an analysis card", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      MockWebSocket.instance.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "第一段。",
        committed_text: "第一段。",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 400,
      });
      MockWebSocket.instance.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 2,
        text: "第二段需要确认。",
        committed_text: "第一段。第二段需要确认。",
        interim_text: "",
        is_final: true,
        start_ms: 400,
        end_ms: 900,
      });
    });

    const timeline = await screen.findByRole("list", {
      name: "转写分段时间线",
    });
    const targetSegment = within(timeline)
      .getByText("第二段需要确认。")
      .closest("li");
    if (!targetSegment) throw new Error("Expected a transcript segment");
    const scrollIntoView = vi.fn();
    Object.defineProperty(targetSegment, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    act(() => {
      MockWebSocket.instance.emit({
        type: "analysis_snapshot",
        cards: [
          {
            id: "request",
            kind: "request",
            observed_at_ms: 650,
            evidence: "第二段出现需要措辞。",
            hypothesis: "这可能是在提出行动方向。",
            alternative: "也可能只是试探性表达。",
            question: "希望先确认哪一步？",
            uncertainty: "high",
          },
        ],
      });
    });

    await user.click(screen.getByText("查看会谈提示"));
    await user.click(
      await screen.findByRole("button", { name: "定位到 00:00.6" }),
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
    expect(document.activeElement).toBe(targetSegment);
    expect(
      screen.getByRole("button", { name: "跟随最新" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("locks an unsaved ended draft until discarding is explicitly confirmed", async () => {
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const user = userEvent.setup();
    render(
      <LiveSession
        workspacePath="/tmp/lingxi-vault"
        people={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            display_name: "林澄",
          },
        ]}
        onSaveTranscript={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const mode = screen.getByLabelText("实时识别方式");
    const consent = screen.getByRole("checkbox", {
      name: /我确认参与者同意/,
    });
    await user.selectOptions(mode, "demo");
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const firstSocket = MockWebSocket.instance;
    firstSocket.open();
    act(() => {
      firstSocket.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      firstSocket.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "尚未保存的确认稿。",
        committed_text: "尚未保存的确认稿。",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 500,
      });
      firstSocket.emit({
        type: "ended",
        transcript: "尚未保存的确认稿。",
        analysis_count: 0,
      });
    });

    expect(mode).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeDisabled();
    const discard = screen.getByRole("button", {
      name: "放弃本次（不保存）",
    });
    await user.click(discard);
    expect(screen.getByLabelText("会后确认稿")).toHaveValue(
      "尚未保存的确认稿。",
    );
    expect(mode).toBeDisabled();

    await user.click(discard);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("会后确认稿")).not.toBeInTheDocument();
    expect(mode).toBeEnabled();

    await user.selectOptions(mode, "doubao");
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const secondSocket = MockWebSocket.instance;
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.open();
    expect(JSON.parse(String(secondSocket.sent[0]))).toEqual({
      type: "start",
      recognizer: "doubao",
      consent: true,
      default_speaker: "other",
      analysis_mode: "observe",
    });
  });

  it("offers a saveable review draft when the connection fails after committed text", async () => {
    const user = userEvent.setup();
    const onSaveTranscript = vi.fn().mockResolvedValue(undefined);
    render(
      <LiveSession
        workspacePath="/tmp/lingxi-vault"
        people={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            display_name: "林澄",
          },
        ]}
        onSaveTranscript={onSaveTranscript}
      />,
    );

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const socket = MockWebSocket.instance;
    socket.open();
    act(() => {
      socket.emit({
        type: "started",
        session_id: "22222222-2222-4222-8222-222222222222",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      socket.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "异常前已确认的文字。",
        committed_text: "异常前已确认的文字。",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 600,
      });
      socket.disconnect();
    });

    expect(await screen.findByText("实时会话连接已中断。")).toBeInTheDocument();
    expect(screen.getByLabelText("会后确认稿")).toHaveValue(
      "[00:00.0–00:00.6][对面] 异常前已确认的文字。",
    );
    await user.click(screen.getByRole("checkbox", { name: "林澄" }));
    await user.click(
      screen.getByRole("checkbox", {
        name: /我已校对确认稿，并确认只把上述文字/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "保存转写与分析摘要" }),
    );

    await waitFor(() => expect(onSaveTranscript).toHaveBeenCalledOnce());
    expect(onSaveTranscript).toHaveBeenCalledWith({
      title: expect.stringMatching(/· 会谈对象 · 实时会谈$/),
      text: "[00:00.0–00:00.6][对面] 异常前已确认的文字。",
      analysis_text: expect.stringContaining("本次没有生成同步分析提示"),
      person_ids: ["11111111-1111-4111-8111-111111111111"],
      event_ids: [],
    });
  });

  it("requires participant consent before starting", () => {
    render(<LiveSession />);
    expect(screen.getByRole("button", { name: "开始实时会谈" })).toBeDisabled();
  });

  it("keeps receiving transcript and ended events after a recoverable error", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    const consent = screen.getByRole("checkbox", {
      name: /我确认参与者同意/,
    });
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const socket = MockWebSocket.instance;
    socket.open();
    act(() => {
      socket.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      socket.emit({
        type: "error",
        code: "invalid_event",
        message: "本帧无效，可继续。",
        recoverable: true,
      });
    });

    expect(
      await screen.findByText(/本帧无效，可继续。.*会话仍在继续/),
    ).toBeInTheDocument();
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(consent).toBeChecked();

    act(() => {
      socket.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "错误后仍收到的文字。",
        committed_text: "错误后仍收到的文字。",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 500,
      });
      socket.emit({
        type: "ended",
        transcript: "错误后仍收到的文字。",
        analysis_count: 0,
      });
    });

    expect(
      await screen.findAllByText("错误后仍收到的文字。"),
    ).not.toHaveLength(0);
    expect(
      screen.getByText("录音已结束"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "打开工作区后即可保存，转写暂留在此页。",
      ),
    ).toBeInTheDocument();
  });

  it("ignores callbacks from an older socket after a replacement session starts", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    const consent = screen.getByRole("checkbox", {
      name: /我确认参与者同意/,
    });
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const firstSocket = MockWebSocket.instance;
    firstSocket.open();
    act(() => {
      firstSocket.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      firstSocket.emit({
        type: "error",
        code: "first_session_failed",
        message: "首个会话失败",
        recoverable: false,
      });
    });

    expect(await screen.findByText(/首个会话失败/)).toBeInTheDocument();
    expect(consent).not.toBeChecked();
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "重新开始" }));
    const secondSocket = MockWebSocket.instance;
    secondSocket.open();
    act(() => {
      secondSocket.emit({
        type: "started",
        session_id: "22222222-2222-4222-8222-222222222222",
        recognizer: "demo",
        data_destination: "local_only",
        audio_saved: false,
      });
      firstSocket.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 99,
        text: "旧会话不应出现",
        committed_text: "旧会话不应出现",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 100,
      });
      firstSocket.emit({
        type: "ended",
        transcript: "旧会话不应出现",
        analysis_count: 0,
      });
      firstSocket.disconnect();
      secondSocket.emit({
        type: "transcript_delta",
        speaker: "other",
        sequence: 1,
        text: "新会话有效",
        committed_text: "新会话有效",
        interim_text: "",
        is_final: true,
        start_ms: 0,
        end_ms: 100,
      });
    });

    expect(await screen.findAllByText("新会话有效")).not.toHaveLength(0);
    expect(screen.queryByText("旧会话不应出现")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("会后确认稿")).not.toBeInTheDocument();
  });

  it("does not let an older asynchronous input stop tear down a new microphone", async () => {
    class MockSpeechRecognition {
      static instance: MockSpeechRecognition;
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        MockSpeechRecognition.instance = this;
      }
    }
    class MockAudioContext {
      static instance: MockAudioContext;
      sampleRate = 48000;
      state = "running";
      destination = {};
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
      createGain = vi.fn(() => ({
        gain: { value: 1 },
        connect: vi.fn(),
      }));
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockImplementation(async () => {
        this.state = "closed";
      });

      constructor() {
        MockAudioContext.instance = this;
      }
    }
    class MockAudioWorkletNode {
      static instance: MockAudioWorkletNode;
      port = {
        onmessage: null as
          ((event: { data: ArrayBuffer | { type: "flushed" } }) => void) | null,
        postMessage: vi.fn(),
      };
      connect = vi.fn();
      disconnect = vi.fn();

      constructor() {
        MockAudioWorkletNode.instance = this;
      }
    }
    const trackStop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: trackStop }],
    });
    vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });

    const user = userEvent.setup();
    render(<LiveSession />);
    const mode = screen.getByLabelText("实时识别方式");
    const consent = screen.getByRole("checkbox", {
      name: /我确认参与者同意/,
    });
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "browser_stream",
        data_destination: "browser_provider",
        audio_saved: false,
      });
      MockWebSocket.instance.emit({
        type: "ended",
        transcript: "",
        analysis_count: 0,
      });
    });

    await user.selectOptions(mode, "doubao");
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    act(() => {
      MockWebSocket.instance.emit({
        type: "started",
        session_id: "22222222-2222-4222-8222-222222222222",
        recognizer: "doubao",
        data_destination: "volcengine_doubao",
        audio_saved: false,
      });
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(MockAudioContext.instance.resume).toHaveBeenCalledOnce(),
    );

    await act(async () => {
      MockSpeechRecognition.instance.onend?.();
      await Promise.resolve();
    });

    expect(
      MockAudioWorkletNode.instance.port.postMessage,
    ).not.toHaveBeenCalled();
    expect(trackStop).not.toHaveBeenCalled();
  });

  it("closes and tears down the current browser session when recognition fails", async () => {
    class MockSpeechRecognition {
      static instance: MockSpeechRecognition;
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        MockSpeechRecognition.instance = this;
      }
    }
    vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
    const user = userEvent.setup();
    render(<LiveSession />);

    const consent = screen.getByRole("checkbox", {
      name: /我确认参与者同意/,
    });
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    const socket = MockWebSocket.instance;
    socket.open();
    act(() => {
      socket.emit({
        type: "started",
        session_id: "11111111-1111-4111-8111-111111111111",
        recognizer: "browser_stream",
        data_destination: "browser_provider",
        audio_saved: false,
      });
      MockSpeechRecognition.instance.onerror?.({
        error: "network",
        message: "浏览器识别服务异常",
      });
    });

    expect(await screen.findByText("浏览器识别服务异常")).toBeInTheDocument();
    expect(socket.readyState).toBe(3);
    expect(MockSpeechRecognition.instance.stop).toHaveBeenCalledOnce();
    expect(consent).not.toBeChecked();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeDisabled();
  });

  it("downsamples a local 48 kHz synthetic audio block to 16 kHz PCM", () => {
    const input = Float32Array.from(
      { length: 9600 },
      (_, index) => Math.sin((2 * Math.PI * 440 * index) / 48000) * 0.5,
    );
    const pcm = downsampleTo16kPcm(input, 48000);

    expect(pcm).toHaveLength(3200);
    expect(Math.max(...pcm)).toBeGreaterThan(15000);
    expect(Math.min(...pcm)).toBeLessThan(-15000);
  });

  it("waits for the browser final result before completing stop", async () => {
    class MockSpeechRecognition {
      static instance: MockSpeechRecognition;
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        MockSpeechRecognition.instance = this;
      }
    }
    vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
    const events: string[] = [];
    const stream = new BrowserSpeechStream(
      (event) => events.push(event.text),
      vi.fn(),
    );
    stream.start();

    let stopped = false;
    const stopping = stream.stop().then(() => {
      stopped = true;
    });
    MockSpeechRecognition.instance.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          isFinal: true,
          length: 1,
          0: { transcript: "最后一句" },
        },
      },
    });

    expect(events).toEqual(["最后一句"]);
    expect(stopped).toBe(false);
    MockSpeechRecognition.instance.onend?.();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("rejects server events that do not match the shared schema", () => {
    expect(() => parseLiveServerEvent({ type: "analysis_snapshot" })).toThrow(
      "Invalid live server event",
    );
  });

  it("flushes a short PCM tail before the worklet reports stopped", () => {
    class MockPort {
      onmessage: ((event: { data: { type: string } }) => void) | null = null;
      sent: unknown[] = [];

      postMessage(value: unknown) {
        this.sent.push(value);
      }
    }
    class MockProcessor {
      port = new MockPort();
    }
    const registration: {
      Processor?: new () => MockProcessor;
    } = {};
    const loadWorklet = new Function(
      "AudioWorkletProcessor",
      "sampleRate",
      "registerProcessor",
      pcmWorkletSource,
    );
    loadWorklet(
      MockProcessor,
      48000,
      (_name: string, candidate: new () => MockProcessor) => {
        registration.Processor = candidate;
      },
    );
    if (!registration.Processor) {
      throw new Error("PCM worklet was not registered");
    }
    const worklet = new registration.Processor();
    const tail = Float32Array.from({ length: 4800 }, () => 0.25);

    (
      worklet as MockProcessor & {
        process(inputs: Float32Array[][]): boolean;
      }
    ).process([[tail]]);
    expect(worklet.port.sent).toEqual([]);
    worklet.port.onmessage?.({ data: { type: "flush" } });

    expect(worklet.port.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect((worklet.port.sent[0] as ArrayBuffer).byteLength).toBe(4800 * 4);
    expect(worklet.port.sent[1]).toEqual({ type: "flushed" });
  });

  it("recovers if the connection closes while stopping", async () => {
    const user = userEvent.setup();
    render(<LiveSession />);

    await user.selectOptions(screen.getByLabelText("实时识别方式"), "demo");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "开始实时会谈" }));
    MockWebSocket.instance.open();
    MockWebSocket.instance.emit({
      type: "started",
      session_id: "11111111-1111-4111-8111-111111111111",
      recognizer: "demo",
      data_destination: "local_only",
      audio_saved: false,
    });

    const stopButton = screen.getByRole("button", { name: "停止" });
    await waitFor(() => expect(stopButton).toBeEnabled());
    await user.click(stopButton);
    MockWebSocket.instance.disconnect();

    expect(await screen.findByText("实时会话连接已中断。")).toBeInTheDocument();
    const consent = screen.getByRole("checkbox", {
      name: /我确认参与者同意/,
    });
    expect(consent).not.toBeChecked();
    expect(screen.getByRole("button", { name: "重新开始" })).toBeDisabled();
    await user.click(consent);
    expect(screen.getByRole("button", { name: "重新开始" })).toBeEnabled();
  });
});
