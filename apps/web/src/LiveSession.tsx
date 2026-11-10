import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./LiveSession.css";
import { api, type DirectModelSettings } from "./api";
import {
  BrowserSpeechStream,
  browserSpeechSupported,
  LIVE_WS_URL,
  PcmMicrophone,
  parseLiveServerEvent,
  type AnalysisCard,
  type LiveServerEvent,
  type Recognizer,
} from "./realtimeClient";

const MODE_LABELS: Record<Recognizer, string> = {
  browser_stream: "浏览器流式识别",
  demo: "本地自动演示",
  doubao: "豆包流式识别",
};

type DataDestination = Extract<
  LiveServerEvent,
  { type: "started" }
>["data_destination"];

const SERVER_DESTINATIONS: Record<Recognizer, DataDestination> = {
  browser_stream: "browser_provider",
  demo: "local_only",
  doubao: "volcengine_doubao",
};

const KIND_LABELS: Record<AnalysisCard["kind"], string> = {
  question: "提问",
  uncertainty: "不确定",
  contrast: "转折",
  request: "需要",
};

type SpeakerRole = "me" | "other" | "unknown";

const SPEAKER_LABELS: Record<SpeakerRole, string> = {
  me: "我",
  other: "对面",
  unknown: "未识别",
};

type Phase =
  "idle" | "connecting" | "listening" | "stopping" | "ended" | "error";

export interface LiveTranscriptSaveInput {
  title: string;
  text: string;
  analysis_text: string;
  person_ids: string[];
  event_ids: string[];
}

interface LiveSessionProps {
  onWorkspaceBusyChange?: (busy: boolean) => void;
  analysisContainer?: HTMLElement | null;
  analysisVisible?: boolean;
  defaultPersonId?: string;
  defaultEventId?: string;
  workspacePath?: string;
  people?: Array<{ id: string; display_name: string }>;
  events?: Array<{ id: string; title: string }>;
  defaultRecognizer?: Recognizer;
  onSaveTranscript?: (input: LiveTranscriptSaveInput) => Promise<void>;
  onCreatePerson?: (
    displayName: string,
  ) => Promise<{ id: string; display_name: string }>;
}

type TranscriptDelta = Extract<LiveServerEvent, { type: "transcript_delta" }>;
type InsightSnapshot = Extract<LiveServerEvent, { type: "insight_snapshot" }>;
type AnalysisMode = "observe" | "goal";

interface TranscriptSegment {
  sequence: number;
  text: string;
  speaker: SpeakerRole;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

function updateTranscriptSegments(
  current: TranscriptSegment[],
  event: TranscriptDelta,
): TranscriptSegment[] {
  const text = event.text.trim();
  if (!text) return current;

  const latestSequence = current.at(-1)?.sequence ?? -1;
  if (event.sequence < latestSequence) return current;

  const settled = current.filter((segment) => segment.isFinal);
  const next: TranscriptSegment = {
    sequence: event.sequence,
    text,
    speaker: event.speaker,
    startMs: event.start_ms,
    endMs: event.end_ms,
    isFinal: event.is_final,
  };
  if (!event.is_final) return [...settled, next];

  const duplicate = settled.findIndex(
    (segment) =>
      segment.sequence === next.sequence ||
      (segment.text === next.text &&
        segment.startMs === next.startMs &&
        segment.endMs === next.endMs),
  );
  if (duplicate === -1) return [...settled, next];

  return settled.map((segment, index) =>
    index === duplicate ? next : segment,
  );
}

function formatReviewTranscript(segments: TranscriptSegment[], fallback: string) {
  const finalized = segments.filter((segment) => segment.isFinal);
  if (!finalized.length) return fallback;
  return finalized
    .map(
      (segment) =>
        `[${formatElapsed(segment.startMs)}–${formatElapsed(segment.endMs)}]` +
        `[${SPEAKER_LABELS[segment.speaker]}] ${segment.text}`,
    )
    .join("\n");
}

function formatAnalysisSummary(
  cards: AnalysisCard[],
  targetName: string,
  insight?: InsightSnapshot | null,
  analysisMode: AnalysisMode = "observe",
  goal = "",
  analysisSource = "本地规则提示",
) {
  const lines = [
    "# 会谈同步分析摘要（待复核）",
    "",
    `分析对象：${targetName || "本次标记为“对面”的发言"}`,
    `实时要点来源：${analysisSource}；条目卡片来自本地规则。`,
    "说明：以下内容来自会谈中的谨慎提示，只是解释性假设与澄清问题，不是人物事实。",
  ];
  if (analysisMode === "goal" && goal.trim()) {
    lines.push(`会谈目标：${goal.trim()}`);
  }
  if (insight) {
    lines.push("", "## 实时要点");
    if (insight.intent) lines.push(`- 可能意图：${insight.intent}`);
    if (insight.topics.length) {
      lines.push(`- 话题：${insight.topics.join("、")}`);
    }
    insight.reply_points.forEach((point) =>
      lines.push(`- 可回复：${point}`),
    );
    insight.cautions.forEach((point) => lines.push(`- 注意：${point}`));
    if (insight.summary_points.length) {
      lines.push(
        "",
        "## 实时摘要",
        ...insight.summary_points.map((point) => `- ${point}`),
      );
    }
  }
  if (!cards.length && !insight) {
    lines.push("", "本次没有生成同步分析提示。");
    return lines.join("\n");
  }
  cards.forEach((card, index) => {
    lines.push(
      "",
      `## ${index + 1}. ${KIND_LABELS[card.kind]}（高不确定性）`,
      `- 观察：${card.evidence}`,
      `- 解释性假设：${card.hypothesis}`,
      `- 替代解释：${card.alternative}`,
      `- 可问的问题：${card.question}`,
    );
  });
  return lines.join("\n");
}

function StreamingText({ text }: { text: string }) {
  const [visible, setVisible] = useState(text);

  useEffect(() => {
    if (!text) {
      setVisible("");
      return;
    }
    let cursor = 0;
    setVisible("");
    const timer = window.setInterval(() => {
      cursor = Math.min(text.length, cursor + 8);
      setVisible(text.slice(0, cursor));
      if (cursor === text.length) window.clearInterval(timer);
    }, 18);
    return () => window.clearInterval(timer);
  }, [text]);

  return (
    <>
      {visible}
      {visible.length < text.length && (
        <i className="stream-caret" aria-hidden="true" />
      )}
    </>
  );
}

function segmentAt(
  segments: TranscriptSegment[],
  observedAtMs: number,
): TranscriptSegment | undefined {
  const containing = segments.find(
    (segment) =>
      segment.startMs <= observedAtMs && observedAtMs <= segment.endMs,
  );
  if (containing) return containing;

  return segments.reduce<TranscriptSegment | undefined>((nearest, segment) => {
    if (segment.endMs > observedAtMs) return nearest;
    if (!nearest || segment.endMs > nearest.endMs) return segment;
    return nearest;
  }, undefined);
}

function formatElapsed(milliseconds: number) {
  const totalTenths = Math.max(0, Math.floor(milliseconds / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function defaultTranscriptTitle(personName = "") {
  const time = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  return `${time} · ${personName || "会谈对象"} · 实时会谈`;
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "保存失败，请保留确认稿后重试。";
}

export function LiveSession({
  analysisContainer = null,
  analysisVisible = true,
  onWorkspaceBusyChange,
  defaultPersonId = "",
  defaultEventId = "",
  workspacePath = "",
  people = [],
  events = [],
  defaultRecognizer = "browser_stream",
  onSaveTranscript,
  onCreatePerson,
}: LiveSessionProps) {
  const [recognizer, setRecognizer] = useState<Recognizer>(defaultRecognizer);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("选择识别方式后开始。");
  const [committed, setCommitted] = useState("");
  const [interim, setInterim] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [cards, setCards] = useState<AnalysisCard[]>([]);
  const [insight, setInsight] = useState<InsightSnapshot | null>(null);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("observe");
  const [goal, setGoal] = useState("");
  const [currentSpeaker, setCurrentSpeaker] =
    useState<SpeakerRole>("other");
  const [analysisPersonId, setAnalysisPersonId] = useState("");
  const [newPersonName, setNewPersonName] = useState("");
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [analysisEnabled, setAnalysisEnabled] = useState(true);
  const [analysisEngine, setAnalysisEngine] = useState<"rules" | "api">("rules");
  const [apiConsent, setApiConsent] = useState(false);
  const [apiSettings, setApiSettings] = useState<DirectModelSettings | null>(null);
  const sessionUsesApiRef = useRef(false);
  const sessionAnalysisSourceRef = useRef("本地规则提示");
  const [followLatest, setFollowLatest] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [firstTranscriptLatencyMs, setFirstTranscriptLatencyMs] = useState<
    number | null
  >(null);
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewText, setReviewText] = useState("");
  const [reviewPersonIds, setReviewPersonIds] = useState<string[]>([]);
  const [reviewEventIds, setReviewEventIds] = useState<string[]>([]);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const analysisEnabledRef = useRef(true);
  const latestInsightRef = useRef<InsightSnapshot | null>(null);
  const analysisModeRef = useRef<AnalysisMode>("observe");
  const goalRef = useRef("");
  const analysisPersonIdRef = useRef("");
  const analysisPersonNameRef = useRef("");
  const autoArchiveRequestedRef = useRef(false);
  const sessionEventIdsRef = useRef<string[]>([]);

  useEffect(() => {
    setRecognizer(defaultRecognizer);
  }, [defaultRecognizer]);
  const speechRef = useRef<BrowserSpeechStream | null>(null);
  const microphoneRef = useRef<PcmMicrophone | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const committedRef = useRef("");
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const currentSpeakerRef = useRef<SpeakerRole>("other");
  const analysisHistoryRef = useRef(new Map<string, AnalysisCard>());
  const startedAtRef = useRef<number | null>(null);
  const firstTranscriptSeenRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const segmentRefs = useRef(new Map<number, HTMLLIElement>());

  function updatePhase(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function sendJson(socket: WebSocket | null, value: unknown) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(value));
    }
  }

  function selectSpeaker(speaker: SpeakerRole) {
    currentSpeakerRef.current = speaker;
    setCurrentSpeaker(speaker);
    if (recognizer === "doubao" && phaseRef.current === "listening") {
      sendJson(socketRef.current, { type: "speaker_selection", speaker });
    }
  }

  async function stopInput() {
    const speech = speechRef.current;
    const microphone = microphoneRef.current;
    if (speechRef.current === speech) speechRef.current = null;
    if (microphoneRef.current === microphone) microphoneRef.current = null;
    await Promise.allSettled([speech?.stop(), microphone?.stop()]);
  }

  function isCurrentSession(generation: number, socket: WebSocket) {
    return (
      sessionGenerationRef.current === generation &&
      socketRef.current === socket
    );
  }

  function closeSocket(socket: WebSocket) {
    if (socketRef.current === socket) socketRef.current = null;
    socket.close();
  }

  function fail(
    message: string,
    generation = sessionGenerationRef.current,
    socket = socketRef.current,
  ) {
    if (
      generation !== sessionGenerationRef.current ||
      (socket !== null && socketRef.current !== socket)
    ) {
      return;
    }
    const shouldOpenReview =
      ["connecting", "listening", "stopping"].includes(phaseRef.current) &&
      Boolean(committedRef.current.trim());
    void stopInput();
    if (startedAtRef.current !== null) {
      setElapsedMs(performance.now() - startedAtRef.current);
    }
    updatePhase("error");
    setConsent(false);
    setStatus(message);
    if (socket) closeSocket(socket);
    if (shouldOpenReview) {
      setReviewTitle((current) =>
        current.trim() ? current : defaultTranscriptTitle(),
      );
      setReviewText((current) =>
        current.trim()
          ? current
          : formatReviewTranscript(segmentsRef.current, committedRef.current),
      );
      setReviewPersonIds(analysisPersonId ? [analysisPersonId] : []);
      setReviewEventIds(sessionEventIdsRef.current);
      setSaveConfirmed(false);
      setSaveState("idle");
      setSaveMessage("");
    }
  }

  async function startInput(
    selected: Recognizer,
    generation: number,
    socket: WebSocket,
  ) {
    if (
      !isCurrentSession(generation, socket) ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (selected === "browser_stream") {
      const speech = new BrowserSpeechStream(
        (event) => {
          if (isCurrentSession(generation, socket)) {
            sendJson(socket, {
              type: "transcript",
              ...event,
              speaker: currentSpeakerRef.current,
            });
          }
        },
        (message) => fail(message, generation, socket),
      );
      speechRef.current = speech;
      speech.start();
    } else if (selected === "doubao") {
      const microphone = new PcmMicrophone();
      microphoneRef.current = microphone;
      await microphone.start((chunk) => {
        if (
          isCurrentSession(generation, socket) &&
          socket.readyState === WebSocket.OPEN
        ) {
          socket.send(chunk);
        }
      });
      if (!isCurrentSession(generation, socket)) {
        await microphone.stop();
      }
    }
  }

  function handleServerEvent(
    event: LiveServerEvent,
    selected: Recognizer,
    generation: number,
    socket: WebSocket,
  ) {
    if (event.type === "status") {
      updatePhase(event.phase);
      setStatus(event.message);
      return;
    }
    if (event.type === "started") {
      if (
        event.recognizer !== selected ||
        event.data_destination !== SERVER_DESTINATIONS[selected] ||
        event.audio_saved !== false
      ) {
        fail(
          "服务返回的会话配置与当前选择不一致。",
          generation,
          socket,
        );
        return;
      }
      startedAtRef.current = performance.now();
      firstTranscriptSeenRef.current = false;
      setElapsedMs(0);
      setFirstTranscriptLatencyMs(null);
      updatePhase("listening");
      setStatus(
        selected === "demo" ? "正在播放演示" : "正在录音",
      );
      void startInput(selected, generation, socket).catch(() => {
        fail("无法使用麦克风，请检查浏览器权限后重试。", generation, socket);
      });
      return;
    }
    if (event.type === "transcript_delta") {
      if (!firstTranscriptSeenRef.current && startedAtRef.current !== null) {
        firstTranscriptSeenRef.current = true;
        setFirstTranscriptLatencyMs(
          Math.max(0, performance.now() - startedAtRef.current),
        );
      }
      committedRef.current = event.committed_text;
      setCommitted(event.committed_text);
      setInterim(event.interim_text);
      setSegments((current) => {
        const next = updateTranscriptSegments(current, event);
        segmentsRef.current = next;
        return next;
      });
      return;
    }
    if (event.type === "analysis_snapshot") {
      if (!analysisEnabledRef.current) return;
      setCards(event.cards);
      event.cards.forEach((card) => {
        analysisHistoryRef.current.set(
          `${card.id}-${card.observed_at_ms}`,
          card,
        );
      });
      return;
    }
    if (event.type === "insight_snapshot") {
      if (!analysisEnabledRef.current) return;
      latestInsightRef.current = event;
      setInsight(event);
      return;
    }
    if (event.type === "error") {
      if (event.recoverable) {
        setStatus(`${event.message}（${event.code}，会话仍在继续）`);
        return;
      }
      fail(`${event.message}（${event.code}）`, generation, socket);
      return;
    }
    if (event.type === "ended") {
      void stopInput();
      if (startedAtRef.current !== null) {
        setElapsedMs(performance.now() - startedAtRef.current);
      }
      committedRef.current = event.transcript;
      setCommitted(event.transcript);
      setInterim("");
      const targetPersonId = analysisPersonIdRef.current;
      const targetPerson = people.find((person) => person.id === targetPersonId);
      const targetPersonName =
        targetPerson?.display_name ?? analysisPersonNameRef.current;
      const title = defaultTranscriptTitle(targetPersonName);
      const review = formatReviewTranscript(segmentsRef.current, event.transcript);
      setReviewTitle(title);
      setReviewText(review);
      setReviewPersonIds(targetPersonId ? [targetPersonId] : []);
      setReviewEventIds(sessionEventIdsRef.current);
      setSaveConfirmed(false);
      setSaveState("idle");
      setSaveMessage("");
      updatePhase("ended");
      setConsent(false);
      const shouldAutoArchive =
        autoArchiveRequestedRef.current &&
        Boolean(workspacePath && onSaveTranscript && targetPersonId);
      autoArchiveRequestedRef.current = false;
      if (shouldAutoArchive) {
        setSaveState("saving");
        setStatus("正在保存");
        void onSaveTranscript!({
          title,
          text: review,
          analysis_text: analysisEnabledRef.current
              ? formatAnalysisSummary(
                  Array.from(analysisHistoryRef.current.values()),
                  targetPersonName,
                  latestInsightRef.current,
                  analysisModeRef.current,
                  goalRef.current,
                  sessionAnalysisSourceRef.current,
                )
            : "",
          person_ids: [targetPersonId],
          event_ids: sessionEventIdsRef.current,
        })
          .then(() => {
            setSaveState("saved");
            setSaveMessage(
              analysisEnabledRef.current
                ? "转写与提示已保存"
                : "转写已保存",
            );
            setStatus(`已归档为“${title}”。`);
          })
          .catch((error: unknown) => {
            setSaveState("error");
            setSaveMessage(errorMessage(error));
            setStatus("自动归档失败，确认稿仍保留在当前页面。");
          });
      } else {
        setStatus(`录音已结束`);
      }
      closeSocket(socket);
    }
  }

  async function start() {
    if (!consent || (analysisMode === "goal" && !goal.trim())) return;
    if (analysisEngine === "api" && (!apiConsent || !apiSettings?.configured)) {
      setStatus("请先配置文本 API，并确认本次会谈文字的发送范围。");
      return;
    }
    if (recognizer === "browser_stream" && !browserSpeechSupported()) {
      fail("当前浏览器不支持流式语音识别，可先使用本地自动演示。");
      return;
    }
    if (
      !analysisPersonIdRef.current &&
      newPersonName.trim() &&
      onCreatePerson
    ) {
      setCreatingPerson(true);
      try {
        const person = await onCreatePerson(newPersonName.trim());
        analysisPersonIdRef.current = person.id;
        analysisPersonNameRef.current = person.display_name;
        setAnalysisPersonId(person.id);
        setNewPersonName("");
      } catch (error) {
        setStatus(errorMessage(error));
        return;
      } finally {
        setCreatingPerson(false);
      }
    }
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    void stopInput();
    const previousSocket = socketRef.current;
    socketRef.current = null;
    previousSocket?.close();
    setCommitted("");
    committedRef.current = "";
    setInterim("");
    setSegments([]);
    segmentsRef.current = [];
    setCards([]);
    setInsight(null);
    latestInsightRef.current = null;
    analysisHistoryRef.current.clear();
    autoArchiveRequestedRef.current = false;
    setFollowLatest(true);
    startedAtRef.current = null;
    firstTranscriptSeenRef.current = false;
    setElapsedMs(0);
    setFirstTranscriptLatencyMs(null);
    setReviewTitle("");
    setReviewText("");
    setReviewPersonIds([]);
    sessionEventIdsRef.current = events.some(item => item.id === defaultEventId)
      ? [defaultEventId] : [];
    setReviewEventIds(sessionEventIdsRef.current);
    setSaveConfirmed(false);
    setSaveState("idle");
    setSaveMessage("");
    updatePhase("connecting");
    setStatus("正在连接");
    const selected = recognizer;
    sessionUsesApiRef.current = analysisEngine === "api";
    sessionAnalysisSourceRef.current = sessionUsesApiRef.current && apiSettings
      ? `文本 API · ${apiSettings.model} · ${apiSettings.base_url}` : "本地规则提示";
    const socket = new WebSocket(LIVE_WS_URL);
    socketRef.current = socket;
    socket.onopen = () => {
      if (isCurrentSession(generation, socket)) {
        sendJson(socket, {
          type: "start",
          recognizer: selected,
          consent: true,
          default_speaker: currentSpeakerRef.current,
          ...(sessionUsesApiRef.current ? { analysis_api: {
            scope_confirmed: true, enabled: analysisEnabledRef.current,
          } } : {}),
          analysis_mode: analysisModeRef.current,
          ...(analysisModeRef.current === "goal"
            ? { goal: goalRef.current.trim() }
            : {}),
        });
      }
    };
    socket.onmessage = (message) => {
      if (!isCurrentSession(generation, socket)) return;
      try {
        handleServerEvent(
          parseLiveServerEvent(JSON.parse(String(message.data))),
          selected,
          generation,
          socket,
        );
      } catch {
        fail("收到无法识别的实时会话事件。", generation, socket);
      }
    };
    socket.onerror = () =>
      fail("本地实时服务连接失败，请确认服务已启动。", generation, socket);
    socket.onclose = () => {
      if (!isCurrentSession(generation, socket)) return;
      if (
        phaseRef.current === "connecting" ||
        phaseRef.current === "listening" ||
        phaseRef.current === "stopping"
      ) {
        fail("实时会话连接已中断。", generation, socket);
      }
    };
  }

  function stop() {
    const socket = socketRef.current;
    autoArchiveRequestedRef.current = true;
    updatePhase("stopping");
    setStatus(
      analysisPersonIdRef.current && workspacePath && onSaveTranscript
        ? "正在完成转写并保存"
        : "正在完成转写",
    );
    void stopInput().finally(() => sendJson(socket, { type: "stop" }));
  }

  function discardTranscript() {
    if (
      !window.confirm(
        "放弃后，本次转写与会后确认稿将从当前页面清除，且不会保存。确定继续吗？",
      )
    ) {
      return;
    }
    sessionGenerationRef.current += 1;
    void stopInput();
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    committedRef.current = "";
    startedAtRef.current = null;
    firstTranscriptSeenRef.current = false;
    setCommitted("");
    setInterim("");
    setSegments([]);
    segmentsRef.current = [];
    setCards([]);
    setInsight(null);
    latestInsightRef.current = null;
    analysisHistoryRef.current.clear();
    autoArchiveRequestedRef.current = false;
    setFollowLatest(true);
    setElapsedMs(0);
    setFirstTranscriptLatencyMs(null);
    setReviewTitle("");
    setReviewText("");
    setReviewPersonIds([]);
    setReviewEventIds([]);
    setSaveConfirmed(false);
    setSaveState("idle");
    setSaveMessage("");
    setConsent(false);
    updatePhase("idle");
    setStatus("本次未保存内容已放弃。");
  }

  function toggleSelection(
    selected: string[],
    id: string,
    update: (ids: string[]) => void,
  ) {
    update(
      selected.includes(id)
        ? selected.filter((candidate) => candidate !== id)
        : [...selected, id],
    );
    setSaveState("idle");
    setSaveMessage("");
  }

  function updateReviewSpeaker(sequence: number, speaker: SpeakerRole) {
    const next = segmentsRef.current.map((segment) =>
      segment.sequence === sequence ? { ...segment, speaker } : segment,
    );
    segmentsRef.current = next;
    setSegments(next);
    setReviewText(formatReviewTranscript(next, committedRef.current));
    setSaveState("idle");
    setSaveMessage("");
  }

  async function saveTranscript() {
    if (
      !onSaveTranscript ||
      !workspacePath ||
      !reviewTitle.trim() ||
      !reviewText.trim() ||
      reviewPersonIds.length === 0 ||
      !saveConfirmed
    ) {
      return;
    }
    setSaveState("saving");
    setSaveMessage("");
    try {
      const includeAnalysis = analysisEnabledRef.current;
      await onSaveTranscript({
        title: reviewTitle.trim(),
        text: reviewText,
        analysis_text: includeAnalysis
          ? formatAnalysisSummary(
              Array.from(analysisHistoryRef.current.values()),
              people.find((person) => person.id === analysisPersonId)
                ?.display_name ?? "",
              latestInsightRef.current,
              analysisModeRef.current,
              goalRef.current,
              sessionAnalysisSourceRef.current,
            )
          : "",
        person_ids: reviewPersonIds,
        event_ids: reviewEventIds,
      });
      setSaveState("saved");
      setSaveMessage(
        includeAnalysis
          ? "转写与提示已保存"
          : "转写已保存",
      );
    } catch (error) {
      setSaveState("error");
      setSaveMessage(errorMessage(error));
    }
  }

  useEffect(
    () => () => {
      sessionGenerationRef.current += 1;
      void stopInput();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    },
    [],
  );

  const active = ["connecting", "listening", "stopping"].includes(phase);
  const reviewRequiresSave =
    (phase === "ended" || phase === "error") &&
    Boolean(committed.trim()) &&
    saveState !== "saved";

  useEffect(() => {
    onWorkspaceBusyChange?.(active || reviewRequiresSave || saveState === "saving" || creatingPerson);
  }, [active, reviewRequiresSave, saveState, creatingPerson, onWorkspaceBusyChange]);

  useEffect(() => {
    // Browsing other materials must never reassign an active or unsaved session.
    if (active || reviewRequiresSave || saveState === "saving") return;
    const selected = people.find(person => person.id === defaultPersonId);
    analysisPersonIdRef.current = selected?.id ?? "";
    analysisPersonNameRef.current = selected?.display_name ?? "";
    setAnalysisPersonId(selected?.id ?? "");
  }, [defaultPersonId, people, active, reviewRequiresSave, saveState]);

  useEffect(() => {
    if (
      (phase !== "listening" && phase !== "stopping") ||
      startedAtRef.current === null
    ) {
      return;
    }
    const updateElapsed = () => {
      if (startedAtRef.current !== null) {
        setElapsedMs(performance.now() - startedAtRef.current);
      }
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 100);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (!followLatest) return;
    const latest = segments.at(-1);
    if (!latest) return;
    const element = segmentRefs.current.get(latest.sequence);
    element?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [followLatest, segments]);

  function focusSegment(segment: TranscriptSegment) {
    setFollowLatest(false);
    const element = segmentRefs.current.get(segment.sequence);
    element?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    element?.focus({ preventScroll: true });
  }

  const renderAnalysis = (content: ReactNode) =>
    !analysisVisible ? null : analysisContainer ? createPortal(content, analysisContainer) : content;

  return (
    <div className={`live-session${analysisContainer ? " live-session--split" : ""}`} data-session-phase={phase}>
      <div className="live-controls">
        <label>
          识别方式
          <select
            aria-label="实时识别方式"
            value={recognizer}
            disabled={active || reviewRequiresSave}
            onChange={(event) => {
              setRecognizer(event.target.value as Recognizer);
              setConsent(false);
              updatePhase("idle");
              setStatus("选择识别方式后开始。");
            }}
          >
            <option value="browser_stream">{MODE_LABELS.browser_stream}</option>
            <option value="demo">{MODE_LABELS.demo}</option>
            <option value="doubao">{MODE_LABELS.doubao}</option>
          </select>
        </label>
        <label>
          会谈分析方式
          <select
            aria-label="会谈分析方式"
            value={analysisEngine}
            disabled={active || reviewRequiresSave}
            onChange={(event) => {
              const engine = event.target.value as "rules" | "api";
              setAnalysisEngine(engine);
              setApiConsent(false);
              setApiSettings(null);
              if (engine === "api") {
                void api.getDirectModelSettings().then(setApiSettings).catch(() => {
                  setStatus("无法读取 API 配置，请到设置中检查。");
                });
              }
            }}
          >
            <option value="rules">本地规则提示</option>
            <option value="api">文本 API 实时建议</option>
          </select>
        </label>
        {analysisEngine === "api" && (
          <div className="live-api-scope">
            <p className="live-destination">
              {apiSettings?.configured
                ? `${apiSettings.model} · ${apiSettings.base_url}`
                : "请先在设置 → 模型与语音中配置文本 API。"}
            </p>
            <label className="live-consent">
              <input type="checkbox" checked={apiConsent} disabled={active}
                onChange={(event) => setApiConsent(event.target.checked)} />
              <span>允许将本次已确认的对方发言及会谈目标发送至上述 API，用于实时建议</span>
            </label>
          </div>
        )}
        <div className="live-analysis-mode">
          <div>
            <strong>{analysisMode === "goal" ? "带着目标聊" : "记录会谈"}</strong>
          </div>
          <button
            className="live-mode-toggle"
            type="button"
            aria-pressed={analysisMode === "goal"}
            disabled={active || reviewRequiresSave}
            onClick={() => {
              const next = analysisMode === "goal" ? "observe" : "goal";
              analysisModeRef.current = next;
              setAnalysisMode(next);
            }}
          >
            目标模式
          </button>
        </div>
        {analysisMode === "goal" && (
          <label>
            会谈目标
            <textarea
              aria-label="会谈目标"
              value={goal}
              disabled={active || reviewRequiresSave}
              rows={2}
              maxLength={500}
              placeholder="例如：安慰对方，先听清楚感受，不急着给方案"
              onChange={(event) => {
                goalRef.current = event.target.value;
                setGoal(event.target.value);
              }}
            />
          </label>
        )}
        <div className="form-row live-role-controls">
          <label>
            联系人
            <select
              aria-label="默认分析对象"
              value={analysisPersonId}
              disabled={active || reviewRequiresSave}
              onChange={(event) => {
                analysisPersonIdRef.current = event.target.value;
                analysisPersonNameRef.current =
                  people.find((person) => person.id === event.target.value)
                    ?.display_name ?? "";
                setAnalysisPersonId(event.target.value);
              }}
            >
              <option value="">暂不选择</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            当前发言人
            <select
              aria-label="当前发言人"
              value={currentSpeaker}
              disabled={recognizer === "demo" && active}
              onChange={(event) =>
                selectSpeaker(event.target.value as SpeakerRole)
              }
            >
              <option value="other">对方</option>
              <option value="me">我</option>
              <option value="unknown">未识别</option>
            </select>
          </label>
        </div>
        {!analysisPersonId && onCreatePerson && (
          <label>
            新联系人姓名（可选）
            <input
              value={newPersonName}
              disabled={active || reviewRequiresSave || creatingPerson}
              placeholder="姓名"
              onChange={(event) => setNewPersonName(event.target.value)}
            />
          </label>
        )}
        <p className="live-destination" aria-label="音频去向">
          {recognizer === "doubao"
            ? "音频发送至豆包 · 不保存录音"
            : recognizer === "browser_stream"
              ? "由浏览器语音服务处理 · 不保存录音"
              : "虚构演示 · 不使用麦克风"}
        </p>
        <label className="live-consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={active}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>我确认参与者同意本次处理</span>
        </label>
        <div className="live-actions">
          <button
            className="primary-button"
            type="button"
            disabled={
              !consent ||
              (analysisEngine === "api" && (!apiConsent || !apiSettings?.configured)) ||
              active ||
              reviewRequiresSave ||
              creatingPerson ||
              (analysisMode === "goal" && !goal.trim())
            }
            data-live-action="start"
            onClick={() => void start()}
          >
            {creatingPerson
              ? "正在创建联系人…"
              : phase === "ended" || phase === "error"
              ? "重新开始"
              : "开始实时会谈"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={phase !== "listening"}
            data-live-action="stop"
            onClick={stop}
          >
            停止
          </button>
          {reviewRequiresSave && (
            <button
              className="secondary-button"
              type="button"
              disabled={saveState === "saving"}
              onClick={discardTranscript}
            >
              放弃本次（不保存）
            </button>
          )}
        </div>
        {reviewRequiresSave && (
          <p className="live-review-notice">
            有未保存的转写，请先保存或放弃。
          </p>
        )}
        {phase !== "idle" && (
          <p className={`live-status ${phase}`} role="status">
            <span aria-hidden="true" />
            {status}
          </p>
        )}
        <div className="live-metrics" aria-label="本机会话测量">
          <div>
            <span>会话计时</span>
            <strong>{formatElapsed(elapsedMs)}</strong>
          </div>
          <details className="live-technical-details">
            <summary>连接详情</summary>
            <span>首个转写延迟</span>
            <strong>
              {firstTranscriptLatencyMs === null
                ? "等待首段"
                : `${Math.round(firstTranscriptLatencyMs)} 毫秒`}
            </strong>
          </details>
        </div>
      </div>

      <div
        className="live-output"
        aria-busy={phase === "connecting" || phase === "stopping"}
      >
        <article className="live-transcript">
          <header>
            <h3>实时转写</h3>
            <span>
              {phase === "ended"
                ? "会话记录"
                : active
                  ? "流式更新"
                  : "等待输入"}
            </span>
          </header>
          {committed || interim ? (
            <>
              <details className="live-transcript-copy">
                <summary>查看全文</summary>
                <p aria-live="polite" aria-atomic="false">
                  {committed}
                  {interim && <mark>{interim}</mark>}
                  {active && <i className="stream-caret" aria-hidden="true" />}
                </p>
              </details>
              <div className="live-timeline">
                <div className="live-timeline-header">
                  <h4>分段时间线</h4>
                  <button
                    className="live-follow-toggle"
                    type="button"
                    aria-pressed={followLatest}
                    disabled={segments.length === 0}
                    onClick={() => setFollowLatest((current) => !current)}
                  >
                    {followLatest ? "正在跟随最新" : "跟随最新"}
                  </button>
                </div>
                <ol aria-label="转写分段时间线">
                  {segments.map((segment) => (
                    <li
                      className={segment.isFinal ? "is-final" : "is-interim"}
                      data-sequence={segment.sequence}
                      key={`${segment.isFinal ? "final" : "interim"}-${segment.sequence}`}
                      ref={(element) => {
                        if (element) {
                          segmentRefs.current.set(segment.sequence, element);
                        } else {
                          segmentRefs.current.delete(segment.sequence);
                        }
                      }}
                      tabIndex={-1}
                    >
                      <time
                        aria-label={`${segment.startMs} 到 ${segment.endMs} 毫秒`}
                      >
                        {formatElapsed(segment.startMs)}–
                        {formatElapsed(segment.endMs)}
                      </time>
                      <p>
                        <b>{SPEAKER_LABELS[segment.speaker]}</b>
                        {segment.text}
                      </p>
                      <span>{segment.isFinal ? "已确认" : "临时"}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          ) : (
            <p className="empty-note">
              开始录音后，文字显示在这里。
            </p>
          )}
        </article>
        {renderAnalysis(
        <article className="live-analysis">
          <header>
            <h3>同步分析</h3>
            <small>{analysisEngine === "api" ? "文本 API" : "本地规则"}</small>
            <div className="live-analysis-controls">
              <span role="status" aria-live="polite" aria-atomic="true">
                {!analysisEnabled
                  ? "已关闭"
                  : insight?.is_updating
                    ? "正在分析"
                    : "随停顿更新"}
              </span>
              <button
                className="live-analysis-toggle"
                type="button"
                aria-pressed={analysisEnabled}
                onClick={() => {
                  const next = !analysisEnabledRef.current;
                  analysisEnabledRef.current = next;
                  setAnalysisEnabled(next);
                  if (sessionUsesApiRef.current) {
                    sendJson(socketRef.current, { type: "analysis_control", enabled: next });
                  }
                  setCards([]);
                  setInsight(null);
                  latestInsightRef.current = null;
                  analysisHistoryRef.current.clear();
                }}
              >
                {analysisEnabled ? "关闭同步分析" : "开启同步分析"}
              </button>
            </div>
          </header>
          {analysisEnabled && (
            <details className="live-advice-details">
              <summary>查看会谈提示</summary>
            <div className="live-analysis-stream">
              {insight?.is_updating && (
                <p className="live-analysis-progress">
                  <i className="stream-caret" aria-hidden="true" />
                  正在结合最新发言…
                </p>
              )}
              {insight && !insight.is_updating && (
                <div className="live-insight-grid">
                  {insight.intent && (
                    <section>
                      <span>可能意图</span>
                      <p><StreamingText text={insight.intent} /></p>
                    </section>
                  )}
                  {analysisMode === "goal" && insight.reply_points.length > 0 && (
                    <section className="live-next-reply">
                      <span>接下来怎么回应</span>
                      <ul>
                        {insight.reply_points.map((point) => (
                          <li key={point}><StreamingText text={point} /></li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {analysisMode === "goal" && insight.cautions.length > 0 && (
                    <section>
                      <span>注意</span>
                      <ul>
                        {insight.cautions.map((point) => (
                          <li key={point}><StreamingText text={point} /></li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {insight.summary_points.length > 0 && (
                    <section className="live-summary">
                      <span>实时摘要</span>
                      {insight.topics.length > 0 && (
                        <div className="live-topic-list">
                          {insight.topics.map((topic) => (
                            <b key={topic}>{topic}</b>
                          ))}
                        </div>
                      )}
                      <ul>
                        {insight.summary_points.map((point) => (
                          <li key={point}><StreamingText text={point} /></li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              )}
              {cards.length > 0 && (
                <div className="live-card-list">
                  {cards.map((card) => {
                    const relatedSegment = segmentAt(
                      segments,
                      card.observed_at_ms,
                    );
                    return (
                      <section className="live-analysis-card" key={card.id}>
                        <span>本地规则 · {KIND_LABELS[card.kind]} · 供参考</span>
                        <strong>{card.evidence}</strong>
                        <dl>
                          <div>
                            <dt>解释性假设</dt>
                            <dd>{card.hypothesis}</dd>
                          </div>
                          <div>
                            <dt>替代解释</dt>
                            <dd>{card.alternative}</dd>
                          </div>
                          <div>
                            <dt>可问的问题</dt>
                            <dd>{card.question}</dd>
                          </div>
                        </dl>
                        <button
                          className="live-card-locate"
                          type="button"
                          disabled={!relatedSegment}
                          onClick={() => {
                            if (relatedSegment) focusSegment(relatedSegment);
                          }}
                        >
                          {relatedSegment
                            ? `定位到 ${formatElapsed(card.observed_at_ms)}`
                            : "暂无对应转写"}
                        </button>
                      </section>
                    );
                  })}
                </div>
              )}
              {!insight && cards.length === 0 && (
                <p className="empty-note">暂无提示</p>
              )}
            </div>
            </details>
          )}
        </article>
        )}
      </div>
      {renderAnalysis(<>
      {(phase === "ended" || phase === "error") && committed.trim() && (
        <section className="live-review" aria-labelledby="live-review-title">
          <header>
            <div>
              <h3 id="live-review-title">会谈记录</h3>
            </div>
          </header>
          {!workspacePath || !onSaveTranscript ? (
            <p className="live-review-notice">
              打开工作区后即可保存，转写暂留在此页。
            </p>
          ) : (
            <form
              className="live-review-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveTranscript();
              }}
            >
              <div className="form-row">
                <label>
                  材料标题
                  <input
                    value={reviewTitle}
                    maxLength={200}
                    required
                    disabled={saveState === "saving" || saveState === "saved"}
                    onChange={(event) => {
                      setReviewTitle(event.target.value);
                      setSaveState("idle");
                    }}
                  />
                </label>
                <details className="live-save-location">
                  <summary>保存位置</summary>
                  <span>{workspacePath}</span>
                </details>
              </div>
              {segments.filter((segment) => segment.isFinal).length > 0 && (
                <fieldset className="live-speaker-review">
                  <legend>逐段校正说话人</legend>
                  {segments
                    .filter((segment) => segment.isFinal)
                    .map((segment) => (
                      <label key={`review-${segment.sequence}`}>
                        <span>
                          {formatElapsed(segment.startMs)} · {segment.text}
                        </span>
                        <select
                          aria-label={`第 ${segment.sequence} 段说话人`}
                          value={segment.speaker}
                          disabled={
                            saveState === "saving" || saveState === "saved"
                          }
                          onChange={(event) =>
                            updateReviewSpeaker(
                              segment.sequence,
                              event.target.value as SpeakerRole,
                            )
                          }
                        >
                          <option value="other">对面</option>
                          <option value="me">我</option>
                          <option value="unknown">未识别</option>
                        </select>
                      </label>
                    ))}
                </fieldset>
              )}
              <label>
                会后确认稿
                <textarea
                  rows={7}
                  value={reviewText}
                  required
                  disabled={saveState === "saving" || saveState === "saved"}
                  onChange={(event) => {
                    setReviewText(event.target.value);
                    setSaveState("idle");
                  }}
                />
              </label>
              <details className="live-association-details">
                <summary>关联人物与事件</summary>
              <div className="live-review-associations">
                <fieldset>
                  <legend>关联人物（至少一人）</legend>
                  {people.length ? (
                    people.map((person) => (
                      <label key={person.id}>
                        <input
                          type="checkbox"
                          checked={reviewPersonIds.includes(person.id)}
                          disabled={
                            saveState === "saving" || saveState === "saved"
                          }
                          onChange={() =>
                            toggleSelection(
                              reviewPersonIds,
                              person.id,
                              setReviewPersonIds,
                            )
                          }
                        />
                        <span>{person.display_name}</span>
                      </label>
                    ))
                  ) : (
                    <p>工作区中还没有人物，请先在下方创建。</p>
                  )}
                </fieldset>
                <fieldset>
                  <legend>关联事件（可选）</legend>
                  {events.length ? (
                    events.map((item) => (
                      <label key={item.id}>
                        <input
                          type="checkbox"
                          checked={reviewEventIds.includes(item.id)}
                          disabled={
                            saveState === "saving" || saveState === "saved"
                          }
                          onChange={() =>
                            toggleSelection(
                              reviewEventIds,
                              item.id,
                              setReviewEventIds,
                            )
                          }
                        />
                        <span>{item.title}</span>
                      </label>
                    ))
                  ) : (
                    <p>暂无事件，可以只关联人物。</p>
                  )}
                </fieldset>
              </div>
              </details>
              <label className="live-consent">
                <input
                  type="checkbox"
                  aria-label="我已校对确认稿，并确认只把上述文字、人物与事件关联保存到本地工作区"
                  checked={saveConfirmed}
                  disabled={saveState === "saving" || saveState === "saved"}
                  onChange={(event) => {
                    setSaveConfirmed(event.target.checked);
                    setSaveState("idle");
                  }}
                />
                <span>
                  已核对，保存到工作区
                </span>
              </label>
              <div className="live-review-submit">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    !reviewTitle.trim() ||
                    !reviewText.trim() ||
                    reviewPersonIds.length === 0 ||
                    !saveConfirmed ||
                    saveState === "saving" ||
                    saveState === "saved"
                  }
                >
                  {saveState === "saving"
                    ? "正在保存…"
                    : saveState === "saved"
                      ? "已保存"
                      : "保存转写与分析摘要"}
                </button>
                {saveMessage && (
                  <p className={`live-save-message ${saveState}`} role="status">
                    {saveMessage}
                  </p>
                )}
              </div>
            </form>
          )}
        </section>
      )}
      </>)}
    </div>
  );
}
