import { useEffect, useRef, useState } from "react";
import { api, type Person } from "./api";
import { WorkbenchDialog } from "./WorkbenchDialog";

export const INTERVIEW_QUESTIONS = [
  "你们是怎样认识的？平时通常怎样联系？", "你和这个人发生过什么有趣或印象深刻的事？",
  "你知道他有哪些重要经历或人生转折吗？", "他最近正在关注什么，或面临什么变化？",
  "他喜欢什么颜色、衣服或穿着风格？", "他喜欢哪些饮食？有没有明确的忌口？",
  "他喜欢什么电影、剧集或音乐？", "他喜欢读什么书，或者关注哪些主题？",
  "他通常怎样度过空闲时间？", "你注意到他有哪些稳定的生活习惯？",
  "他做过哪些让自己投入或自豪的事？", "遇到压力时，他通常怎样表达，又希望得到什么支持？",
  "你们相处时，什么做法通常比较顺利？", "有没有需要尊重的边界、约定或不喜欢的话题？",
  "你们曾经有过什么分歧？后来怎样处理？", "你现在最希望了解或改善的是什么？",
] as const;
type Answer = {question: string; answer: string; status: "answered" | "unknown"};
export function PersonInterview({person, workspacePath, onSaved, onClose}: {
  person: Person; workspacePath: string; onSaved: () => Promise<unknown>; onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<{name: string; text: string}[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cancel, setCancel] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const requestId = useRef(crypto.randomUUID());
  const currentScope = useRef(workspacePath); currentScope.current = workspacePath;
  const final = step === INTERVIEW_QUESTIONS.length;
  const dirty = Boolean(text.trim() || Object.keys(answers).length || attachments.length);
  function next(status?: "answered" | "unknown") {
    const updated = {...answers};
    if (status) updated[step] = {question: INTERVIEW_QUESTIONS[step], answer: status === "unknown" ? "还不知道" : text.trim(), status};
    else delete updated[step];
    setAnswers(updated); setStep(step + 1); setText(updated[step + 1]?.answer ?? "");
    requestId.current = crypto.randomUUID();
  }
  async function files(list: FileList | null) {
    if (!list) return;
    setError(""); setBusy(true);
    try {
      if (list.length > 3) throw new Error("一次最多选择3份文本资料。");
      const loaded = [];
      for (const file of Array.from(list)) {
        if (!/\.(txt|md|json)$/i.test(file.name) || file.size > 5 * 1024 * 1024) throw new Error("请选择TXT、Markdown或JSON，每份不超过5MiB。");
        const body = await file.text();
        if (!body.trim() || body.includes("\ufffd") || body.includes("\0")) throw new Error("文件不是有效的UTF-8文本，请检查编码。");
        loaded.push({name: file.name, text: body});
      }
      setAttachments(loaded); requestId.current = crypto.randomUUID();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "文件读取失败。"); }
    finally { setBusy(false); }
  }
  async function save() {
    const records = Object.values(answers);
    if (!records.length && !attachments.length) { onClose(); return; }
    const workspace = workspacePath; setBusy(true); setError("");
    try {
      await api.savePersonInterview(person.id, {request_id: requestId.current, answers: records, attachments});
      if (!alive.current || currentScope.current !== workspace) return;
      await onSaved(); if (alive.current && currentScope.current === workspace) onClose();
    } catch (cause) { if (alive.current && currentScope.current === workspace) setError(cause instanceof Error ? cause.message : "补充未保存，请重试。"); }
    finally { if (alive.current && currentScope.current === workspace) setBusy(false); }
  }
  return <><WorkbenchDialog title={`补充了解${person.display_name}`} busy={busy} onClose={() => dirty ? setCancel(true) : onClose()}>
    <div className="interview-step">
      <p>{final ? "最后一步 · 添加资料" : `第 ${step + 1} / ${INTERVIEW_QUESTIONS.length} 题 · 可跳过，完成后统一保存`}</p>
      {!final ? <><h3>{INTERVIEW_QUESTIONS[step]}</h3><textarea aria-label="本题回答" rows={5} maxLength={4000} value={text} disabled={busy} onChange={event => setText(event.target.value)} placeholder="只写你知道的事。不确定也可以直接说。" /><div className="form-row"><button type="button" className="primary-button" disabled={!text.trim()} onClick={() => next("answered")}>记下回答，下一题</button><button type="button" onClick={() => next("unknown")}>不知道</button><button type="button" onClick={() => next()}>跳过</button></div><button type="button" className="text-button" onClick={() => { if (text.trim()) setAnswers({...answers, [step]: {question: INTERVIEW_QUESTIONS[step], answer: text.trim(), status: "answered"}}); setStep(INTERVIEW_QUESTIONS.length); }}>直接去添加资料</button></> : <><h3>可再上传已有资料</h3><p>回答和文件会作为新增资料保存。原有材料与历史报告保留，之后还可以继续添加。</p><label>选择文本资料<input type="file" multiple accept=".txt,.md,.json" disabled={busy} onChange={event => void files(event.target.files)} /></label><p>支持TXT、Markdown、JSON；最多3份，每份5MiB。截图可稍后从“资料 → 导入与整理资料”添加。</p>{attachments.map((file,index) => <p key={index}>{file.name}</p>)}<details><summary>核对本轮补充 · {Object.keys(answers).length} 项</summary>{Object.values(answers).map((answer,index) => <section key={index}><strong>{answer.question}</strong><p>{answer.answer}</p></section>)}</details><button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : dirty ? "保存补充并完成" : "暂不添加，完成建档"}</button></>}
      {step > 0 && <button type="button" disabled={busy} onClick={() => { setStep(step - 1); setText(answers[step - 1]?.status === "answered" ? answers[step - 1].answer : ""); }}>上一题</button>}
      {error && <p role="alert">{error}</p>}
    </div>
  </WorkbenchDialog>{cancel && <WorkbenchDialog title="放弃未保存的补充" onClose={() => setCancel(false)}><p>基础人物已经保存。本轮还未提交的回答和所选文件会被放弃。</p><button type="button" onClick={onClose}>放弃本轮补充</button><button type="button" onClick={() => setCancel(false)}>继续填写</button></WorkbenchDialog>}</>;
}
