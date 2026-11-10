import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api, type ChatAnalysisResponse, type SourceRecord } from "./api";
import "./ChatDataAnalysis.css";
import type { TextEngine } from "./ControlCenter";

interface ChatDataAnalysisProps {
  sources: SourceRecord[];
  textEngine?: TextEngine;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function BarList({
  items,
}: {
  items: Array<{ key: string; label: string; count: number; share: number }>;
}) {
  if (!items.length) {
    return <p className="analysis-empty">当前格式中没有足够的可比数据。</p>;
  }
  const maximum = Math.max(...items.map((item) => item.count), 1);
  return (
    <ol className="analysis-bars">
      {items.map((item) => (
        <li key={item.key}>
          <span className="analysis-bar-label">{item.label}</span>
          <span className="analysis-bar-track" aria-hidden="true">
            <span style={{ width: `${Math.max(6, (item.count / maximum) * 100)}%` }} />
          </span>
          <strong>{item.count}</strong>
          <small>{percent(item.share)} 消息</small>
        </li>
      ))}
    </ol>
  );
}

export function ChatDataAnalysis({
  sources, textEngine = "local_demo",
}: ChatDataAnalysisProps) {
  const eligibleSources = useMemo(
    () =>
      sources.filter(
        (item) =>
          item.source_kind !== "screenshot" ||
          item.processing_status === "confirmed",
      ),
    [sources],
  );
  const [sourceId, setSourceId] = useState("");
  const [result, setResult] = useState<ChatAnalysisResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [semanticConfirmed, setSemanticConfirmed] = useState(false);
  const source = eligibleSources.find((item) => item.id === sourceId);

  useEffect(() => {
    if (!sourceId && eligibleSources[0]) {
      setSourceId(eligibleSources[0].id);
    }
  }, [eligibleSources, sourceId]);

  useEffect(() => {
    setResult(null);
    setError("");
    setSemanticConfirmed(false);
  }, [sourceId, textEngine]);

  async function handleAnalyze(event: FormEvent) {
    event.preventDefault();
    if (!sourceId) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await api.analyzeChatSource(sourceId, {
          engine: "local_demo",
          profile_id: "local_demo",
          material_scope_confirmed: false,
        }),
      );
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "分析未能完成。");
    } finally {
      setBusy(false);
    }
  }

  async function handleSemanticAnalysis() {
    if (!sourceId || textEngine === "local_demo" || !semanticConfirmed) return;
    setBusy(true); setError("");
    try {
      setResult(await api.analyzeChatSource(sourceId, { engine: textEngine, profile_id: "inherited", material_scope_confirmed: true }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "主题分析未能完成。"); }
    finally { setBusy(false); }
  }

  return (
    <section className="chat-analysis-panel" aria-label="聊天数据分析">
      <div className="chat-analysis-heading">
        <div>
          <span className="overline">生成前可选</span>
          <h3>聊天统计预览</h3>
          <p>
            查看词频、参与者和时段；统计不会自动写成证据。
          </p>
        </div>
        <span className="local-badge">结果回链原始聊天</span>
      </div>

      <form className="chat-analysis-form" onSubmit={handleAnalyze}>
        <label>
          原始聊天材料
          <select
            aria-label="聊天分析原始材料"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            required
          >
            <option value="">请选择</option>
            {eligibleSources.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title} · {item.source_kind}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || !sourceId}
        >
          {busy ? "正在统计…" : "预览聊天统计"}
        </button>
      </form>
      {textEngine !== "local_demo" && <div className="analysis-semantic-actions"><label><input type="checkbox" checked={semanticConfirmed} disabled={busy} onChange={event => setSemanticConfirmed(event.target.checked)} />确认将当前这一份聊天交给{ textEngine === "api" ? "设置中的 API 服务" : textEngine === "claude" ? "Claude Code" : "Codex" }补充主题分析</label><button type="button" className="secondary-button" disabled={busy || !sourceId || !semanticConfirmed} onClick={() => void handleSemanticAnalysis()}>补充 AI 主题分析</button></div>}


      {!eligibleSources.length && (
        <div className="analysis-empty-state">
          <strong>还没有可分析的文字材料</strong>
          <p>先在通讯录的“原始材料”中导入聊天文本，或确认截图转写。</p>
        </div>
      )}
      {error && (
        <div className="analysis-error" role="alert">
          {error}
        </div>
      )}

      {result && source && (
        <div className="analysis-results" aria-live="polite">
          {result.execution.degraded && (
            <div className="analysis-warning">
              本机 CLI 本次没有完成主题归纳，已保留本地统计结果。
            </div>
          )}
          <div className="analysis-metrics">
            <article><strong>{result.analysis.metrics.messages}</strong><span>消息</span></article>
            <article><strong>{result.analysis.metrics.participants || "—"}</strong><span>识别说话人</span></article>
            <article><strong>{result.analysis.metrics.lines}</strong><span>原文行数</span></article>
            <article><strong>{result.analysis.metrics.characters.toLocaleString("zh-CN")}</strong><span>字符</span></article>
          </div>

          <div className="analysis-grid">
            <article>
              <h4>高频词组</h4>
              <p>已去除部分常见语气词；中文为重复词组线索。</p>
              <BarList
                items={result.analysis.top_terms.slice(0, 10).map((item) => ({
                  key: item.term,
                  label: item.term,
                  count: item.count,
                  share: item.message_share,
                }))}
              />
            </article>
            <article>
              <h4>说话人消息量</h4>
              <p>只统计原文中明确写出的说话人，不猜测身份。</p>
              <BarList
                items={result.analysis.speakers.map((item) => ({
                  key: item.name,
                  label: item.name,
                  count: item.message_count,
                  share: item.message_share,
                }))}
              />
            </article>
            <article>
              <h4>聊天时段</h4>
              <p>只统计可识别时间的消息。</p>
              <BarList
                items={result.analysis.time_buckets.map((item) => ({
                  key: item.label,
                  label: item.label,
                  count: item.message_count,
                  share: item.message_share,
                }))}
              />
            </article>
          </div>

          <section className="analysis-topics">
            <div>
              <span className="overline">
                {result.analysis.topic_method === "cli_assisted"
                  ? "本机 AI 主题"
                  : "本地频次线索"}
              </span>
              <h4>主题与原文片段</h4>
            </div>
            {result.analysis.topics.length ? (
              <div className="analysis-topic-list">
                {result.analysis.topics.map((topic) => (
                  <article key={`${topic.title}-${topic.message_count}`}>
                    <header>
                      <strong>{topic.title}</strong>
                      <span>{topic.message_count} 条 · {percent(topic.message_share)}</span>
                    </header>
                    <p>{topic.summary}</p>
                    <div className="topic-keywords">
                      {topic.keywords.map((keyword) => (
                        <span key={keyword}>{keyword}</span>
                      ))}
                    </div>
                    {topic.source_refs.map((reference) => (
                      <blockquote key={`${topic.title}-${reference.message_index}`}>
                        <small>消息 {reference.message_index + 1}</small>
                        {reference.quote}
                      </blockquote>
                    ))}
                  </article>
                ))}
              </div>
            ) : (
              <p className="analysis-empty">
                这份材料还没有形成重复主题线索，可以增加更多原始材料。
              </p>
            )}
          </section>

          <details className="analysis-limitations">
            <summary>统计口径与限制</summary>
            <ul>
              {result.analysis.limitations.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </details>
          <div className="analysis-actions">
            <a
              className="secondary-button"
              href={api.sourceOriginalUrl(source.id)}
              target="_blank"
              rel="noreferrer"
            >
              打开原始聊天
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
