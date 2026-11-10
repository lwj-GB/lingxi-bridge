import { request } from "./api";

export interface MobileArchiveSummary {
  id: string; date: string; deviceId: string; generatedAt: number; receivedAt: string;
  lineCount: number; todoCount: number; hasJournal: boolean;
}
export interface ReceiverStatus {
  active: boolean; addresses: string[]; code: string | null; expiresAt: string | null; receivedCount: number;
}
export interface MobileLine {
  id: string; localId: number; segmentId: number; startAt: number; endAt: number; speaker: string | null; text: string;
}
export interface MobileTodo {
  id: string; localId: number; category: string; content: string; status: string; at: number;
  dueAt: number | null; sourceLineId: string | null; generatedBy: "ai" | "manual" | "unknown";
}
export interface HealthMetric<T> {
  state: "Available" | "NoData" | "NotAuthorized" | "Unavailable" | "Failed";
  value: T | null; sourcePackages: string[]; message: string | null;
}
export interface MobileStatistics {
  usage: {
    state: string; message: string;
    apps: Array<{packageName: string; label: string; foregroundMillis: number}>;
    timeline: Array<{packageName: string; label: string; startAt: number; endAt: number}>;
  };
  notifications: {
    state: string; message: string; observedFromMillis: number | null; observedUntilMillis: number | null;
    coveredMillis: number; total: number | null;
    apps: Array<{packageName: string; label: string; count: number}>;
    hourly: Array<{hourStartMillis: number; count: number}>;
  };
  health: {
    availability: string;
    steps: HealthMetric<number>; distanceMeters: HealthMetric<number>; exerciseMinutes: HealthMetric<number>;
    hourlySteps: HealthMetric<Array<{startAt: number; endAt: number; count: number | null}>>;
    sessions: HealthMetric<Array<{startAt: number; endAt: number; typeCode: number; typeLabel: string; sourcePackage: string}>>;
  };
}
export interface MobileArchive {
  type: "lingxi_mobile_archive"; version: 1; deviceId: string; generatedAt: number; date: string; timeZone: string;
  lines: MobileLine[]; todos: MobileTodo[];
  contexts?: Array<{segmentId: number; participants: string; background: string; updatedAt: number; source: "user"}>;
  journal?: {markdown: string; statistics: MobileStatistics};
}
export const mobileApi = {
  list: () => request<{archives: MobileArchiveSummary[]}>("/mobile/archives"),
  read: (id: string) => request<{id: string; archive: MobileArchive}>(`/mobile/archives/${encodeURIComponent(id)}`),
  importArchive: (archive: unknown, workspacePath?: string) => request<{id: string; status: "created" | "exists"}>("/mobile/import", {method: "POST", headers: workspacePath ? {"X-Lingxi-Workspace": encodeURIComponent(workspacePath)} : undefined, body: JSON.stringify({archive})}),
  receiver: () => request<ReceiverStatus>("/mobile/receiver"),
  startReceiver: (workspacePath?: string) => request<ReceiverStatus>("/mobile/receiver/start", {method: "POST", headers: workspacePath ? {"X-Lingxi-Workspace": encodeURIComponent(workspacePath)} : undefined}),
  stopReceiver: (workspacePath?: string) => request<ReceiverStatus>("/mobile/receiver/stop", {method: "POST", headers: workspacePath ? {"X-Lingxi-Workspace": encodeURIComponent(workspacePath)} : undefined}),
};
