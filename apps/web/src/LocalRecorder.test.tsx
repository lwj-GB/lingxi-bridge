import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalRecorder } from "./LocalRecorder";

class Recorder {
  static latest: Recorder;
  static isTypeSupported = () => true;
  state = "inactive"; mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
  constructor() { Recorder.latest = this; }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["fictional-audio"], { type: this.mimeType }) }); this.onstop?.(); }
}
const track = { stop: vi.fn(), onended: null };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
const busy = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn().mockReturnValue("blob:fictional"); static revokeObjectURL = vi.fn(); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function record() {
  const user = userEvent.setup(); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "开始录音" }));
  await screen.findByRole("button", { name: "停止录音" }); return user;
}
it("同意后才调用麦克风，停止后保留可试听原音且不调用网络", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); render(<LocalRecorder onBusyChange={busy} />);
  expect(screen.getByRole("button", { name: "开始录音" })).toBeDisabled();
  const user = await record(); expect(busy).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "停止录音" }));
  expect(screen.getByLabelText("试听本次录音")).toHaveAttribute("src", "blob:fictional");
  expect(track.stop).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("系统取消保存后保留音频，允许再次保存", async () => {
  let saves = 0;
  const invoke = vi.fn().mockImplementation((command: string) => Promise.resolve(command === "save_recording" ? ++saves > 1 : undefined)); vi.stubGlobal("__TAURI__", { core: { invoke } });
  // jsdom Blob lacks arrayBuffer; use the platform implementation for this IPC test.
  const TestBlob = class extends Blob { arrayBuffer() { return Promise.resolve(new TextEncoder().encode("fictional-audio").buffer); } };
  vi.stubGlobal("Blob", TestBlob);
  render(<LocalRecorder onBusyChange={busy} />); const user = await record(); await user.click(screen.getByRole("button", { name: "停止录音" }));
  await user.click(screen.getByRole("button", { name: "保存录音" }));
  expect(await screen.findByText(/已取消保存，录音仍可试听/)).toBeInTheDocument(); expect(screen.getByLabelText("试听本次录音")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存录音" })); expect(await screen.findByText(/录音已保存。可继续试听/)).toBeInTheDocument();
  expect(invoke).toHaveBeenLastCalledWith("save_recording", expect.objectContaining({ extension: "webm", bytes: expect.any(Array) }));
});
it("麦克风拒绝授权恢复可重试状态", async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new Error("权限被拒绝"));
  render(<LocalRecorder onBusyChange={busy} />); const user = userEvent.setup(); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "开始录音" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("权限被拒绝"); expect(screen.getByRole("button", { name: "开始录音" })).toBeEnabled(); expect(busy).toHaveBeenLastCalledWith(false);
});
it("组件在等待授权时卸载会释放迟到的麦克风流", async () => {
  let resolve!: (value: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise(done => { resolve = done; }));
  const view = render(<LocalRecorder onBusyChange={busy} />); const user = userEvent.setup(); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "开始录音" }));
  view.unmount(); await act(async () => { resolve(stream as unknown as MediaStream); }); expect(track.stop).toHaveBeenCalled(); expect(busy).toHaveBeenLastCalledWith(false);
});
it("录音和未结束会谈阻止页面退出，卸载会停止麦克风", async () => {
  const view = render(<LocalRecorder onBusyChange={busy} />); await record();
  const event = new Event("beforeunload", { cancelable: true }); fireEvent(window, event); expect(event.defaultPrevented).toBe(true);
  view.unmount(); await waitFor(() => expect(Recorder.latest.state).toBe("inactive")); expect(track.stop).toHaveBeenCalled();
});

it("结束前可返回保存，明确确认后才释放录音和会谈锁", async () => {
  render(<LocalRecorder onBusyChange={busy} />); const user = await record(); await user.click(screen.getByRole("button", { name: "停止录音" }));
  await user.click(screen.getByRole("button", { name: "结束本次会谈" }));
  await user.click(screen.getByRole("button", { name: "返回保存" })); expect(screen.getByLabelText("试听本次录音")).toBeInTheDocument(); expect(busy).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "结束本次会谈" })); await user.click(screen.getByRole("button", { name: "确认结束" }));
  expect(screen.queryByLabelText("试听本次录音")).not.toBeInTheDocument(); expect(busy).toHaveBeenLastCalledWith(false); expect(screen.getByRole("button", { name: "开始录音" })).toBeDisabled();
});

it("停止后的录音可显式本地转写且保留试听与保存", async () => {
  const { localAudioApi } = await import("./local-audio-api");
  const transcribe = vi.spyOn(localAudioApi, "transcribe").mockResolvedValue({text:"虚构转写原文",duration_seconds:3,elapsed_seconds:0.2,engine:"sherpa-onnx",model:"sensevoice",local_only:true});
  render(<LocalRecorder onBusyChange={busy} />);
  const user = await record(); await user.click(screen.getByRole("button", {name:"停止录音"}));
  await user.click(screen.getByRole("button", {name:"本地转写"}));
  expect(await screen.findByLabelText("本地转写原文")).toHaveValue("虚构转写原文");
  expect(transcribe).toHaveBeenCalledWith(expect.any(File));
  expect(screen.getByLabelText("试听本次录音")).toBeInTheDocument();
  expect(screen.getByRole("button", {name:"保存录音"})).toBeEnabled();
  transcribe.mockRestore();
});
