/* Generated from packages/schemas/live-session.schema.json. Do not edit. */

export type LingxiBridgeRealtimeSessionEvents =
  | Start
  | TranscriptInput
  | SpeakerSelection
  | AnalysisControl
  | Stop
  | Started
  | TranscriptDelta
  | AnalysisSnapshot
  | InsightSnapshot
  | Status
  | Error
  | Ended;
export type Start = {
  [k: string]: unknown;
} & {
  type: "start";
  recognizer: Recognizer;
  consent: true;
  default_speaker: SpeakerRole;
  analysis_mode?: AnalysisMode;
  goal?: string;
  analysis_api?: {
    scope_confirmed: true;
    enabled?: boolean;
  };
};
export type Recognizer = "browser_stream" | "doubao" | "demo";
export type SpeakerRole = "me" | "other" | "unknown";
export type AnalysisMode = "observe" | "goal";

export interface TranscriptInput {
  type: "transcript";
  /**
   * 同一会话内按事件严格递增；interim 到 final 修订也必须使用新序号。重复或回退事件由服务端幂等忽略。
   */
  sequence: number;
  text: string;
  speaker: SpeakerRole;
  is_final: boolean;
  start_ms: number;
  end_ms: number;
}
export interface SpeakerSelection {
  type: "speaker_selection";
  speaker: SpeakerRole;
}
export interface AnalysisControl {
  type: "analysis_control";
  enabled: boolean;
}
export interface Stop {
  type: "stop";
}
export interface Started {
  type: "started";
  session_id: string;
  recognizer: Recognizer;
  data_destination: "local_only" | "browser_provider" | "volcengine_doubao";
  audio_saved: false;
}
export interface TranscriptDelta {
  type: "transcript_delta";
  sequence: number;
  text: string;
  speaker: SpeakerRole;
  committed_text: string;
  interim_text: string;
  is_final: boolean;
  start_ms: number;
  end_ms: number;
}
export interface AnalysisSnapshot {
  type: "analysis_snapshot";
  /**
   * @maxItems 4
   */
  cards:
    | []
    | [AnalysisCard]
    | [AnalysisCard, AnalysisCard]
    | [AnalysisCard, AnalysisCard, AnalysisCard]
    | [AnalysisCard, AnalysisCard, AnalysisCard, AnalysisCard];
}
export interface AnalysisCard {
  id: string;
  kind: "question" | "uncertainty" | "contrast" | "request";
  observed_at_ms: number;
  evidence: string;
  hypothesis: string;
  alternative: string;
  question: string;
  uncertainty: "high";
}
export interface InsightSnapshot {
  type: "insight_snapshot";
  observed_at_ms: number;
  is_updating: boolean;
  intent: string;
  /**
   * @maxItems 6
   */
  reply_points:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string];
  /**
   * @maxItems 6
   */
  cautions:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string];
  /**
   * @maxItems 8
   */
  summary_points:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  /**
   * @maxItems 6
   */
  topics:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string];
}
export interface Status {
  type: "status";
  phase: "connecting" | "listening" | "stopping";
  message: string;
}
export interface Error {
  type: "error";
  code: string;
  message: string;
  recoverable: boolean;
}
export interface Ended {
  type: "ended";
  transcript: string;
  analysis_count: number;
}
