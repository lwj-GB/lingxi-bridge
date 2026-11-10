import { localAudioApi } from "./local-audio-api";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { useEffect, useRef, useState } from "react";

const MAX_BYTES = 128 * 1024 * 1024;
export function LocalRecorder({ onBusyChange, disabled = false, contextLabel = "会谈" }: { onBusyChange: (busy: boolean) => void; disabled?: boolean; contextLabel?: string }) {
  const [phase, setPhase] = useState<"idle" | "requesting" | "recording" | "ready">("idle");
  const [clip, setClip] = useState<Blob | null>(null);
  const [url, setUrl] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [consent, setConsent] = useState(false);
  const [ending, setEnding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const recordingLabel = useRef(contextLabel);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(track => track.stop()); busyCallback.current(false); void window.__TAURI__?.core.invoke("set_recording_busy", { busy: false }).catch(() => undefined); };
  }, []);
  useEffect(() => { busyCallback.current(phase !== "idle"); if (phase === "idle") void window.__TAURI__?.core.invoke("set_recording_busy", { busy: false }).catch(() => undefined); }, [phase]);
  useEffect(() => {
    if (!clip) { setUrl(""); return; }
    const next = URL.createObjectURL(clip); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [clip]);
  useEffect(() => {
    if (phase !== "recording") return;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (phase !== "idle") { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [phase]);
  async function start() {
    if (disabled) return;
    recordingLabel.current = contextLabel;
    setError(""); setStatus(""); setTranscript(""); setSeconds(0); setPhase("requesting");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("当前环境无法录音，请使用桌面客户端并允许麦克风权限。");
      if (window.__TAURI__?.core.invoke) await window.__TAURI__.core.invoke("set_recording_busy", { busy: true });
      if (!alive.current) return;
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const mime = ["audio/webm;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
      const recording = new MediaRecorder(input, mime ? { mimeType: mime } : undefined);
      recorder.current = recording;
      const chunks: Blob[] = []; let size = 0;
      recording.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); size += event.data.size; if (size >= MAX_BYTES - 1024 * 1024 && recording.state === "recording") { setStatus("录音已接近128MB，已停止，请先保存。"); recording.stop(); } } };
      recording.onstop = () => {
        input.getTracks().forEach(track => track.stop()); stream.current = null;
        if (!alive.current) return;
        const blob = new Blob(chunks, { type: recording.mimeType || mime || "audio/webm" });
        if (!blob.size) { setError("没有录到音频，请检查麦克风后重试。"); setPhase("idle"); return; }
        setClip(blob); setPhase("ready");
      };
      recording.onerror = () => { if (alive.current) setError("录音中断。可试听并保存已录部分。"); if (recording.state !== "inactive") recording.stop(); };
      input.getAudioTracks().forEach(track => { track.onended = () => { if (recording.state === "recording") recording.stop(); }; });
      recording.start(1000); setPhase("recording");
    } catch (cause) { stream.current?.getTracks().forEach(track => track.stop()); if (alive.current) { setError(cause instanceof Error ? cause.message : "无法启动麦克风。"); setPhase("idle"); } }
  }
  async function transcribe() {
    if (!clip || transcribing) return;
    if (clip.size > 64 * 1024 * 1024) { setError("音频超过本地转写的64MB上限，请先保存并分段。"); return; }
    setTranscribing(true); setError("");
    try {
      const extension = clip.type.includes("mp4") ? "m4a" : "webm";
      const result = await localAudioApi.transcribe(new File([clip], `recording.${extension}`, {type: clip.type}));
      if (alive.current) { setTranscript(result.text); setStatus(`已在本机转写，处理耗时 ${result.elapsed_seconds.toFixed(2)} 秒。原录音仍保留。`); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "本地转写失败，录音仍保留。"); }
    finally { if (alive.current) setTranscribing(false); }
  }
  async function save() {
    if (!clip) return;
    setSaving(true); setError("");
    try {
      const extension = clip.type.includes("mp4") ? "m4a" : "webm";
      const safeLabel = recordingLabel.current.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 50);
      const filename = `${safeLabel}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
      if (window.__TAURI__?.core.invoke) {
        const saved = await window.__TAURI__.core.invoke<boolean>("save_recording", { extension, bytes: Array.from(new Uint8Array(await clip.arrayBuffer())), suggestedName: filename });
        if (!saved) { setStatus("已取消保存，录音仍可试听和再次保存。"); return; }
        setStatus("录音已保存。可继续试听，或开始下一次会谈。");
      } else {
        const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
        setStatus("已请求浏览器下载，请确认文件已保存后再开始下一次会谈。");
      }
      // Keep the clip until the user explicitly discards it or starts a new session.
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，录音仍保留，可重试。"); }
    finally { if (alive.current) setSaving(false); }
  }
  return <section className="local-recorder" aria-label="本机会谈录音">
    <h3>{phase === "recording" ? "正在录音" : "会谈录音"}</h3>
    {disabled && <p>请先结束转写工具中的会谈，再开始新的录音。</p>}
    <p>录音保存在本机。停止后可手动本地转写，不发送云端。</p>
    <output aria-label="录音时长">{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</output>
    {phase === "idle" && <label><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />参与者已同意录音</label>}
    <div className="form-row">
      {phase === "idle" && <button type="button" className="primary-button" data-live-action="start" disabled={!consent || disabled} onClick={() => void start()}>开始录音</button>}
      {phase === "requesting" && <p role="status">等待麦克风授权…</p>}
      {phase === "recording" && <button type="button" className="primary-button" data-live-action="stop" onClick={() => recorder.current?.stop()}>停止录音</button>}
      {phase === "ready" && <><button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存录音"}</button><button type="button" disabled={saving || transcribing} onClick={() => void transcribe()}>{transcribing ? "正在本地转写…" : "本地转写"}</button><button type="button" disabled={saving || transcribing} onClick={() => { setEnding(true); }}>结束本次会谈</button></>}
    </div>
    {ending && <WorkbenchDialog title="结束本次会谈" onClose={() => setEnding(false)}><p>请确认录音已保存。结束后会清除本次录音的内存副本。</p><button type="button" onClick={() => { setEnding(false); setClip(null); setTranscript(""); setConsent(false); setSeconds(0); setPhase("idle"); setStatus(""); }}>确认结束</button><button type="button" onClick={() => setEnding(false)}>返回保存</button></WorkbenchDialog>}
    {url && <audio controls src={url} aria-label="试听本次录音" />}
    {phase === "ready" && <p>请先保存。录音尚未加入资料目录，结束本次会谈后不会保留内存副本。</p>}
    {transcript && <label>本地转写原文<textarea aria-label="本地转写原文" readOnly value={transcript} rows={6} style={{width:"100%",boxSizing:"border-box"}} /></label>}
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
