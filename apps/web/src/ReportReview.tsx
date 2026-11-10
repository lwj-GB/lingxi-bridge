import { useMemo, useState } from "react";
import type { AnalysisClaim, Person, ReportResponse } from "./api";

export function ReportReview({report, people, personId, reviews, busy, onPersonChange, onReview, onEvidence}: {
  report: ReportResponse | null; people: Person[]; personId: string;
  reviews: Record<string, "accepted" | "rejected">; busy: boolean;
  onPersonChange: (id: string) => void; onReview: (key: string, claim: AnalysisClaim, correct: boolean) => Promise<boolean>;
  onEvidence: (id: string) => void;
}) {
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState("");
  const person = people.find(item => item.id === personId);
  const candidates = useMemo(() => report?.analysis.claims.flatMap((claim, index) =>
    ["observation", "hypothesis"].includes(claim.claim_type) ? [{claim, key: `${report.snapshot.id}-${index}`}] : []) ?? [], [report]);
  function persisted(claim: AnalysisClaim) {
    const previous = person?.profile_sections?.filter(entry => entry.origin === "ai" && entry.label === "AI 候选描述" && entry.value === claim.text && entry.evidence_ids.length === claim.evidence_ids.length && claim.evidence_ids.every(id => entry.evidence_ids.includes(id))).at(-1);
    return previous?.confirmation_status === "confirmed" ? "accepted" : previous?.confirmation_status === "rejected" ? "rejected" : undefined;
  }
  const pending = candidates.filter(item => !reviews[item.key] && !persisted(item.claim) && !skipped.includes(item.key));
  const current = pending[0];
  const completed = candidates.filter(item => reviews[item.key] || persisted(item.claim)).length;
  async function review(correct: boolean) {
    if (!current || busy) return; setError("");
    if (!await onReview(current.key, current.claim, correct)) setError("这次核对没有保存，请重试。当前题目已保留。");
  }
  return <section className="report-review-quiz" aria-label="逐题核对报告">
    {!report ? <p>先在报告主区选择一份报告。</p> : !candidates.length ? <p>这份报告没有足够材料支持可核对的判断。可先补充资料。</p> : <>
      <header><h3>逐题核对</h3><span>已记录 {completed} / {candidates.length}</span></header>
      <p className="empty-note">按你了解的情况回答。反馈供下一版参考，不会改写原报告，也不代表模型已训练。</p>
      {report.topic.person_ids.length > 1 && <label>这次核对属于谁<select aria-label="核对对象" value={personId} disabled={busy} onChange={event => { onPersonChange(event.target.value); setSkipped([]); }}><option value="">请选择</option>{people.filter(item => report.topic.person_ids.includes(item.id)).map(item => <option value={item.id} key={item.id}>{item.display_name}</option>)}</select></label>}
      {current ? <><p>第 {candidates.indexOf(current) + 1} / {candidates.length} 题{current.claim.claim_type === "hypothesis" ? " · 一种推测" : " · 待核对描述"}</p><blockquote>{current.claim.text}</blockquote><div className="quiz-actions"><button type="button" className="primary-button" disabled={busy || !personId} onClick={() => void review(true)}>准确，保留</button><button type="button" disabled={busy || !personId} onClick={() => void review(false)}>不准确，退回</button><button type="button" disabled={busy} onClick={() => { setSkipped([...skipped, current.key]); setError(""); }}>跳过</button></div><details><summary>查看这题依据</summary>{current.claim.alternatives?.map((text,index) => <p key={index}>也可能：{text}</p>)}{current.claim.evidence_ids.map((id,index) => <button type="button" key={id} className="text-button" onClick={() => onEvidence(id)}>原文 {index + 1}</button>)}</details></> : <><h3>{skipped.length ? "本轮核对结束" : "这份报告已核对完"}</h3>{skipped.length > 0 && <button type="button" onClick={() => setSkipped([])}>重新查看跳过的题</button>}<p>新资料或新的反馈可以用于生成同主题的新版本。旧快照会保留。</p></>}
      <details><summary>全部判断与依据</summary>{candidates.map(({claim,key},index) => <section key={key}><p>{index + 1}. {claim.text}</p><small>{(reviews[key] || persisted(claim)) === "accepted" ? "已保留" : (reviews[key] || persisted(claim)) === "rejected" ? "已退回" : skipped.includes(key) ? "本轮跳过" : "待核对"}</small>{claim.evidence_ids.map((id,n) => <button type="button" className="text-button" key={id} onClick={() => onEvidence(id)}>原文 {n + 1}</button>)}</section>)}</details>
      {busy && <p role="status">正在保存本题…</p>}{error && <p role="alert">{error}</p>}
    </>}
  </section>;
}
