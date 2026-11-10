import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, type ExecutorStatus, type Person, type SourceRecord, type DirectModelSettings } from "./api";
import type { AppLanguage, TextEngine } from "./ControlCenter";
import "./AiWorkspace.css";

export type AiTaskTarget = "autofill" | "live" | "people" | "reports";
export interface AiConversation {
  id: string; title: string; prompt: string; target: AiTaskTarget;
  person_id?: string; workspace_path: string; updated_at: string;
  answer?: string;
  messages?: { role: "user" | "assistant"; text: string }[];
}

export function AiWorkspace({
  openedPath, people, sources, executors, textEngine, conversationId,
  conversation, onConversationChange, onOpenWorkspace,
  contextPersonId, onPersonChange,
}: {
  language: AppLanguage; openedPath: string; people: Person[]; sources: SourceRecord[];
  executors: ExecutorStatus[]; textEngine: TextEngine; conversationId: string;
  conversation?: AiConversation; onConversationChange: (value: AiConversation) => void;
  onOpenWorkspace: () => void;
  onStartLive: () => void;
  onWorkspaceChanged?: () => Promise<unknown>;
  contextPersonId?: string; onPersonChange?: (personId: string) => void;
}) {
  const [prompt, setPrompt] = useState(conversation?.prompt ?? "");
  const [personId, setPersonId] = useState(conversation?.person_id ?? people[0]?.id ?? "");
  const [messages, setMessages] = useState(conversation?.messages ?? (conversation?.answer ? [{ role: "user" as const, text: conversation.prompt }, { role: "assistant" as const, text: conversation.answer }] : []));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [directModel, setDirectModel] = useState<DirectModelSettings | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { logEnd.current?.scrollIntoView?.({ block: "nearest" }); }, [messages, busy]);
  const alive = useRef(true);
  const requestGeneration = useRef(0);
  const scope = useRef({ workspace: openedPath, personId: contextPersonId });
  const appliedScope = useRef({ workspace: openedPath, personId: contextPersonId });
  if (scope.current.workspace !== openedPath || scope.current.personId !== contextPersonId) {
    requestGeneration.current += 1;
    scope.current = { workspace: openedPath, personId: contextPersonId };
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; requestGeneration.current += 1; }; }, []);
  const currentRequest = (generation: number, workspace: string) => alive.current && requestGeneration.current === generation && scope.current.workspace === workspace;
  useEffect(() => {
    if (!people.some((person) => person.id === personId)) setPersonId(people[0]?.id ?? "");
  }, [people, personId]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (textEngine !== "api") { setDirectModel(null); return; }
      void api.getDirectModelSettings().then(settings => { if (!cancelled) setDirectModel(settings); }).catch(() => { if (!cancelled) setDirectModel(null); });
    };
    refresh();
    window.addEventListener("lingxi:model-settings-changed", refresh);
    return () => { cancelled = true; window.removeEventListener("lingxi:model-settings-changed", refresh); };
  }, [textEngine]);
  useEffect(() => {
    if (appliedScope.current.workspace === openedPath && appliedScope.current.personId === contextPersonId) return;
    if (appliedScope.current.workspace !== openedPath) setPrompt("");
    appliedScope.current = { workspace: openedPath, personId: contextPersonId };
    setBusy(false); setMessages([]); setError(""); setExcluded([]);
    if (contextPersonId !== undefined) setPersonId(contextPersonId || people[0]?.id || "");
  }, [openedPath, contextPersonId]);
  const materials = sources.filter((source) => source.person_ids.includes(personId) && source.source_kind !== "screenshot");
  const selected = materials.filter((source) => !excluded.includes(source.id));
  const engineReady = textEngine === "api" ? Boolean(directModel?.configured) : textEngine !== "local_demo" && executors.some((item) => item.engine === textEngine && item.available);

  function remember(text: string, result: string, history: { role: "user" | "assistant"; text: string }[], target: AiTaskTarget = "reports", id = personId) {
    onConversationChange({ id: conversationId, title: text.trim().slice(0, 24), prompt: text,
      target, person_id: id || undefined, workspace_path: openedPath,
      updated_at: new Date().toISOString(), answer: result, messages: history });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!openedPath) { onOpenWorkspace(); return; }
    if (!prompt.trim() || busy) return;
    if (textEngine === "local_demo" || !engineReady) { setError(textEngine === "api" ? "请先在设置中配置 API 地址、模型与密钥。" : "请先在设置中连接模型。"); return; }
    if (!personId) { setError("请选择人物，或先新增人物。"); return; }
    const generation = ++requestGeneration.current; const workspace = openedPath;
    const text = prompt.trim();
    const history = [...messages, { role: "user" as const, text }];
    setMessages(history); setPrompt(""); setBusy(true); setError("");
    try {
      const result = await api.answerQuestion({ question: text, person_id: personId,
        source_ids: selected.map((source) => source.id), engine: textEngine });
      if (!currentRequest(generation, workspace)) return;
      const settled = [...history, { role: "assistant" as const, text: result.answer }];
      setMessages(settled); remember(text, result.answer, settled);
    } catch (cause) {
      if (currentRequest(generation, workspace)) { setError(cause instanceof Error ? cause.message : "没有完成，请重试。"); setMessages(messages); setPrompt(text); }
    } finally { if (currentRequest(generation, workspace)) setBusy(false); }
  }

  return <div className="ai-workspace">
    <div className="ai-messages" role="log" aria-label="对话消息" aria-live="polite">
      {messages.map((message, index) => <article key={index} className={`ai-message ai-message-${message.role}`} aria-label={message.role === "user" ? "我的消息" : "AI 回复"}>{message.text.split(/\n\s*\n/).map((paragraph, line) => <p key={line}>{paragraph}</p>)}</article>)}
      {busy && <p role="status">正在回复…</p>}
      <div ref={logEnd} />
    </div>
    {error && <p role="alert" className="ai-error">{error}</p>}
    <form className="ai-command-form" onSubmit={(event) => void submit(event)}>
      <textarea aria-label="告诉 AI 你想完成什么" rows={3} value={prompt} disabled={busy}
        placeholder="输入问题…（Shift+Enter 换行）" onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && prompt.trim()) event.currentTarget.form?.requestSubmit(); } }} onChange={event => setPrompt(event.target.value)} />
      <footer>
        <details className="ai-materials">
          <summary>{`人物资料 · ${selected.length} 份材料`} · {textEngine === "local_demo" ? "未连接模型" : textEngine === "api" ? `API · ${directModel?.model || "尚未配置"}` : textEngine === "claude" ? "Claude Code" : "Codex"}</summary>
          <select aria-label="当前人物" value={personId} disabled={busy} onChange={event => { requestGeneration.current += 1; setPersonId(event.target.value); onPersonChange?.(event.target.value); setMessages([]); setExcluded([]); }}>
            <option value="" disabled>选择人物</option>{people.map(person => <option key={person.id} value={person.id}>{person.display_name}</option>)}
          </select>
          <p>{textEngine === "api" ? `发送到 ${directModel?.base_url || "设置中的 API 地址"}；模型 ${directModel?.model || "尚未配置"}。` : "发送给所选 CLI；服务地址由你的 CLI 配置决定。"}</p>
          <p>每次只发送当前问题与勾选材料。</p>
          {materials.map(source => <label key={source.id}><input type="checkbox" disabled={busy} checked={!excluded.includes(source.id)} onChange={event => setExcluded(ids => event.target.checked ? ids.filter(id => id !== source.id) : [...ids, source.id])} />{source.title}</label>)}
        </details>
        <button type="submit" className="primary-button" disabled={busy || !prompt.trim()}>{busy ? "处理中…" : "发送"}</button>
      </footer>
    </form>
  </div>;
}
