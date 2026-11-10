import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { API_BASE_URL } from "./api";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

export function TerminalPanel({ workspacePath, active = true }: {
  workspacePath: string; active?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const appearance = useRef<MutationObserver | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [engine, setEngine] = useState("claude-deepseek");
  const [status, setStatus] = useState("未启动");
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);

  function send(message: object) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }
  function resize() {
    if (!activeRef.current || !fit.current || !term.current || !container.current?.clientWidth) return;
    fit.current.fit();
    send({ type: "resize", cols: term.current.cols, rows: term.current.rows });
  }

  useEffect(() => {
    if (!active || term.current) { if (active) resize(); return; }
    let cancelled = false;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, addon]) => {
      if (cancelled || !container.current) return;
      const terminal = new xterm.Terminal({ cursorBlink: true, fontSize: 12,
        fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace', scrollback: 3000 });
      const fitAddon = new addon.FitAddon();
      terminal.loadAddon(fitAddon); terminal.open(container.current);
      term.current = terminal; fit.current = fitAddon;
      const updateTheme = () => {
        const css = getComputedStyle(document.documentElement);
        terminal.options.theme = {
          background: css.getPropertyValue("--paper").trim() || "#ffffff",
          foreground: css.getPropertyValue("--ink").trim() || "#303942",
          cursor: css.getPropertyValue("--clay").trim() || "#397db5",
        };
      };
      updateTheme();
      appearance.current = new MutationObserver(updateTheme);
      appearance.current.observe(document.documentElement, { attributes: true });
      terminal.onData(data => {
        if (data === "\u0003") send({ type: "interrupt" });
        else send({ type: "input", data });
      });
      observer.current = new ResizeObserver(resize); observer.current.observe(container.current);
      resize(); setReady(true);
    }).catch(() => setStatus("终端组件加载失败，请重新打开页面。"));
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    socket.current?.close(); socket.current = null; setConnected(false);
    setStatus(workspacePath ? "未启动" : "请先打开工作区"); term.current?.reset();
    return () => { socket.current?.close(); socket.current = null; };
  }, [workspacePath]);

  useEffect(() => () => {
    socket.current?.close(); observer.current?.disconnect(); appearance.current?.disconnect();
    term.current?.dispose(); term.current = null;
  }, []);

  function start() {
    if (!workspacePath || !ready || socket.current) return;
    term.current?.reset(); setStatus("正在连接…");
    const connection = new WebSocket(API_BASE_URL.replace(/^http/, "ws") + "/terminal");
    socket.current = connection; setConnected(true);
    connection.onopen = () => connection.send(JSON.stringify({ type: "start", engine,
      workspace_path: workspacePath, cols: term.current?.cols ?? 80, rows: term.current?.rows ?? 24 }));
    connection.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "output") term.current?.write(message.data);
        if (message.type === "started") { setStatus("运行中"); term.current?.focus(); }
        if (message.type === "exit") setStatus(`已退出（${message.code}）`);
        if (message.type === "error") setStatus(message.message);
      } catch { setStatus("收到无效终端消息。"); }
    };
    connection.onerror = () => setStatus("终端连接失败，请检查本地服务。");
    connection.onclose = () => {
      if (socket.current === connection) { socket.current = null; setConnected(false);
        setStatus(current => ["运行中", "正在连接…", "正在结束…"].includes(current) ? "会话已结束" : current); }
    };
  }

  return <section className="terminal-panel" aria-label="本机交互终端">
    <div className="terminal-toolbar">
      <select aria-label="终端执行器" value={engine} disabled={connected} onChange={e => setEngine(e.target.value)}>
        <option value="claude-deepseek">Claude Code · DeepSeek（现有配置）</option><option value="shell">系统 Shell</option><option value="claude">Claude Code</option><option value="codex">Codex CLI</option>
      </select>
      <button type="button" onClick={start} disabled={!workspacePath || !ready || connected}>启动终端</button>
      <button type="button" onClick={() => send({type:"interrupt"})} disabled={!connected}>中断</button>
      <button type="button" onClick={() => { send({type:"stop"}); setStatus("正在结束…"); }} disabled={!connected}>结束</button>
      <span role="status">{status}</span>
    </div>
    <div className="terminal-cwd" title={workspacePath}>{workspacePath || "尚未打开工作区"}</div>
    <div className="terminal-viewport" ref={container} />
    <small className="terminal-permissions">{engine === "claude-deepseek" ? "DeepSeek 配置读取自本机 CC Switch，材料发往该配置地址。" : "继承本机 CLI 配置。"}本机CLI沿用自身权限；切换标签不结束。可通过 LINGXI_API_BASE_URL 操作应用，先读取 LINGXI_OPENAPI_URL。</small>
  </section>;
}
