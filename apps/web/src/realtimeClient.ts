import liveSessionSchema from "../../../packages/schemas/live-session.schema.json";
import { API_BASE_URL } from "./api";
import validateLiveEvent from "./live-session.validator.generated.js";
import type {
  AnalysisCard,
  LingxiBridgeRealtimeSessionEvents,
  Recognizer,
} from "./live-session.generated";

export type { AnalysisCard, Recognizer };
type LiveSessionEvent = LingxiBridgeRealtimeSessionEvents;
export type LiveServerEvent = Exclude<
  LiveSessionEvent,
  { type: "start" | "transcript" | "speaker_selection" | "analysis_control" | "stop" }
>;

const clientEventTypes = new Set([
  "start",
  "transcript",
  "speaker_selection",
  "analysis_control",
  "stop",
]);
const runtimeSchema = liveSessionSchema as {
  $defs: Record<
    string,
    { properties?: { type?: { const?: string } } }
  >;
};
const serverEventTypes = new Set(
  Object.values(runtimeSchema.$defs)
    .map((definition) => definition.properties?.type?.const)
    .filter(
      (type): type is string =>
        typeof type === "string" && !clientEventTypes.has(type),
    ),
);
export function parseLiveServerEvent(value: unknown): LiveServerEvent {
  if (
    !validateLiveEvent(value) ||
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !serverEventTypes.has(value.type)
  ) {
    throw new Error("Invalid live server event");
  }
  return value as LiveServerEvent;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export const LIVE_WS_URL = `${API_BASE_URL.replace(/^http/, "ws")}/live`;

export function browserSpeechSupported() {
  return Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
}

export class BrowserSpeechStream {
  private active = false;
  private sequence = 0;
  private startedAt = 0;
  private restartTimer: number | null = null;
  private stopTimer: number | null = null;
  private stopResolver: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly recognition: SpeechRecognitionLike;

  constructor(
    private readonly onTranscript: (event: {
      sequence: number;
      text: string;
      is_final: boolean;
      start_ms: number;
      end_ms: number;
    }) => void,
    private readonly onError: (message: string) => void,
  ) {
    const Recognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      throw new Error("当前浏览器不支持流式语音识别。");
    }
    this.recognition = new Recognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "zh-CN";
    this.recognition.onresult = (event) => {
      const endMs = Math.max(0, Date.now() - this.startedAt);
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript.trim();
        if (!text) continue;
        this.sequence += 1;
        this.onTranscript({
          sequence: this.sequence,
          text,
          is_final: result.isFinal,
          start_ms: 0,
          end_ms: endMs,
        });
      }
    };
    this.recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") {
        this.onError(event.message || `浏览器语音识别失败：${event.error}`);
      }
    };
    this.recognition.onend = () => {
      if (!this.active) {
        this.finishStop();
        return;
      }
      this.restartTimer = window.setTimeout(() => {
        if (!this.active) return;
        try {
          this.recognition.start();
        } catch {
          this.onError("浏览器语音识别未能继续，请重新开始。");
        }
      }, 200);
    };
  }

  start() {
    this.active = true;
    this.startedAt = Date.now();
    this.recognition.start();
  }

  private finishStop() {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    const resolve = this.stopResolver;
    this.stopResolver = null;
    resolve?.();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.active = false;
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopPromise = new Promise((resolve) => {
      this.stopResolver = resolve;
      this.stopTimer = window.setTimeout(() => this.finishStop(), 1000);
      try {
        this.recognition.stop();
      } catch {
        this.finishStop();
      }
    });
    return this.stopPromise;
  }
}

export function downsampleTo16kPcm(
  samples: Float32Array,
  inputRate: number,
): Int16Array {
  if (inputRate < 16000) {
    throw new Error("麦克风采样率低于 16 kHz，无法发送给豆包。");
  }
  const ratio = inputRate / 16000;
  const output = new Int16Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end && source < samples.length; source += 1) {
      sum += samples[source];
    }
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export class PcmMicrophone {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private flushResolver: (() => void) | null = null;

  async start(onChunk: (chunk: ArrayBuffer) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule("/pcm-worklet.js");
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "lingxi-pcm-capture");
    const silentOutput = this.context.createGain();
    silentOutput.gain.value = 0;
    this.node.port.onmessage = (
      event: MessageEvent<ArrayBuffer | { type: "flushed" }>,
    ) => {
      if (!(event.data instanceof ArrayBuffer)) {
        if (event.data.type === "flushed") {
          const resolve = this.flushResolver;
          this.flushResolver = null;
          resolve?.();
        }
        return;
      }
      const pcm = downsampleTo16kPcm(
        new Float32Array(event.data),
        this.context?.sampleRate ?? 16000,
      );
      onChunk(pcm.buffer as ArrayBuffer);
    };
    source.connect(this.node);
    this.node.connect(silentOutput);
    silentOutput.connect(this.context.destination);
    await this.context.resume();
  }

  async stop() {
    const node = this.node;
    if (node) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => {
          this.flushResolver = null;
          resolve();
        }, 500);
        this.flushResolver = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        node.port.postMessage({ type: "flush" });
      });
    }
    node?.disconnect();
    this.node = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }
}
