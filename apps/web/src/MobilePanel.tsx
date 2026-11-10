import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mobileApi, type MobileArchive, type MobileArchiveSummary, type ReceiverStatus } from "./mobile-api";
import "./mobile.css";
import { LocalAudioTools } from "./LocalAudioTools";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const tabs = [["timeline", "日记时间线"], ["lines", "原文"], ["journal", "AI 笔记"]] as const;
type Tab = typeof tabs[number][0];
const closedReceiver: ReceiverStatus = { active: false, addresses: [], code: null, expiresAt: null, receivedCount: 0 };
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试。";

function clock(value: number, timeZone: string, withDate = false) {
  const options: Intl.DateTimeFormatOptions = { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (withDate) Object.assign(options, { month: "2-digit", day: "2-digit" });
  return new Intl.DateTimeFormat("zh-CN", options).format(new Date(value));
}
function duration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
function localDay() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }
function shiftDay(day: string, offset: number) { const value = new Date(`${day}T12:00:00`); value.setDate(value.getDate() + offset); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function deviceLabel(id: string) { return `设备 ${id.slice(0, 8)}`; }

export function MobilePanel({ workspacePath }: { workspacePath: string | null }) {
  if (!workspacePath) return <section className="mobile-panel mobile-no-workspace"><h2>手机</h2><p>先打开电脑工作区，再接收手机上的每日记录。</p></section>;
  return <MobileWorkspace key={workspacePath} workspacePath={workspacePath} />;
}
export default MobilePanel;

function MobileWorkspace({ workspacePath }: { workspacePath: string }) {
  const [archives, setArchives] = useState<MobileArchiveSummary[]>([]);
  const [receiver, setReceiver] = useState<ReceiverStatus>(closedReceiver);
  const [selectedDate, setSelectedDate] = useState(localDay);
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState<Tab>("timeline");
  const [detail, setDetail] = useState<{ id: string; archive: MobileArchive } | null>(null);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");
  const [receiverError, setReceiverError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const dashboard = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("lingxi.mobile-layout.v1") ?? "{}");
      return Object.fromEntries(["width", "left", "right"].map(key => [key, Number.isFinite(saved[key]) ? Math.max(20, Math.min(80, saved[key])) : 50])) as Record<string, number>;
    } catch { return { width: 50, left: 50, right: 50 }; }
  });
  useEffect(() => { localStorage.setItem("lingxi.mobile-layout.v1", JSON.stringify(layout)); }, [layout]);
  function separator(key: string, label: string) {
    return <div className={`mobile-divider mobile-divider-${key}`} role="separator" aria-label={label} aria-orientation={key === "width" ? "vertical" : "horizontal"} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(layout[key])} tabIndex={0}
      onKeyDown={event => { if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const delta = ["ArrowUp", "ArrowLeft"].includes(event.key) ? -2 : 2; setLayout(old => ({ ...old, [key]: Math.max(20, Math.min(80, old[key] + delta)) })); }}
      onPointerDown={event => {
        event.preventDefault(); const element = event.currentTarget; const rect = dashboard.current?.getBoundingClientRect(); if (!rect) return;
        element.setPointerCapture(event.pointerId);
        const move = (e: PointerEvent) => { const value = key === "width" ? (e.clientX - rect.left) / rect.width * 100 : (e.clientY - rect.top) / rect.height * 100; setLayout(old => ({ ...old, [key]: Math.max(20, Math.min(80, value)) })); };
        const end = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", end); element.removeEventListener("pointercancel", end); };
        element.addEventListener("pointermove", move); element.addEventListener("pointerup", end); element.addEventListener("pointercancel", end);
      }} />;
  }
  const fileInput = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const refreshing = useRef(false);
  const refreshVersion = useRef(0);

  const refresh = useCallback(async (force = false) => {
    if (refreshing.current && !force) return;
    refreshing.current = true;
    const version = ++refreshVersion.current;
    const generation = epoch.current;
    try {
      const [records, state] = await Promise.allSettled([mobileApi.list(), mobileApi.receiver()]);
      if (generation !== epoch.current || version !== refreshVersion.current) return;
      if (records.status === "fulfilled") {
        const list = [...records.value.archives].sort((a, b) => b.date.localeCompare(a.date) || b.generatedAt - a.generatedAt || b.id.localeCompare(a.id));
        setArchives(list); setListError("");

      } else setListError(errorText(records.reason));
      if (state.status === "fulfilled") { setReceiver(state.value); setReceiverError(""); }
      else setReceiverError(errorText(state.reason));
      setLoading(false);
    } finally {
      if (generation === epoch.current && version === refreshVersion.current) refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    epoch.current += 1;
    refreshing.current = false;
    void refresh();
    return () => { epoch.current += 1; refreshing.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (!receiver.active) return;
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [receiver.active, refresh]);
  const dayArchives = archives.filter(item => item.date === selectedDate);
  const selectedId = dayArchives.find(item => item.id === selected)?.id ?? dayArchives[0]?.id ?? "";
  useEffect(() => {
    let cancelled = false;
    setDetail(null); setDetailError("");
    if (!selectedId) { setReading(false); return; }
    setReading(true);
    void mobileApi.read(selectedId).then(record => {
      if (!cancelled) setDetail(record);
    }).catch(error => { if (!cancelled) setDetailError(errorText(error)); })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  async function toggleReceiver() {
    if (busy) return;
    const generation = epoch.current;
    setBusy(true); setActionError(""); setNotice("");
    try {
      const state = await (receiver.active ? mobileApi.stopReceiver(workspacePath) : mobileApi.startReceiver(workspacePath));
      if (generation !== epoch.current) return;
      setReceiver(state); setReceiverError("");
      void refresh();
    } catch (error) { if (generation === epoch.current) setActionError(errorText(error)); }
    finally { if (generation === epoch.current) setBusy(false); }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || busy) return;
    const generation = epoch.current;
    setActionError(""); setNotice("");
    if (!file.name.toLowerCase().endsWith(".json")) { setActionError("请选择手机导出的 JSON 归档文件。"); return; }
    if (file.size > MAX_ARCHIVE_BYTES) { setActionError("归档包超过 20 MiB，请在手机上按日导出。"); return; }
    setBusy(true);
    try {
      let raw: string;
      try { raw = await file.text(); JSON.parse(raw); }
      catch { throw new Error("文件不是有效的 JSON，请重新选择手机归档包。"); }
      if (generation !== epoch.current) return;
      const result = await mobileApi.importArchive(raw, workspacePath);
      if (generation !== epoch.current) return;
      setNotice(result.status === "exists" ? "这份归档已在电脑中，没有重复新增。" : "手机归档已保存到当前工作区。");
      const imported = await mobileApi.read(result.id);
      if (generation !== epoch.current) return;
      setSelectedDate(imported.archive.date); setSelected(result.id); setTab("lines");
      await refresh(true);
    } catch (error) { if (generation === epoch.current) setActionError(errorText(error)); }
    finally { if (generation === epoch.current) setBusy(false); }
  }

  const dayCount = new Set(archives.map(item => item.date)).size;
  const chosen = archives.find(item => item.id === selectedId);
  const archive = detail?.id === selectedId ? detail.archive : null;
  const archivedCharacters = archive?.lines.reduce((count, line) => count + Array.from(line.text.replace(/\s/gu, "")).length, 0);
  function chooseDate(value: string) { if (!value) return; setSelectedDate(value); setSelected(""); }
  const calendarMonth = new Date(`${selectedDate.slice(0,7)}-01T12:00:00`);
  const calendarOffset = (calendarMonth.getDay() + 6) % 7;
  const calendarDays = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth()+1, 0).getDate();
  const recordedDates = new Set(archives.map(item => item.date));
  return <section ref={dashboard} style={{ "--mobile-width": `${layout.width}%`, "--mobile-left": `${layout.left}%`, "--mobile-right": `${layout.right}%` } as CSSProperties} className="mobile-panel mobile-dashboard" aria-label="手机记录">
    <section className="mobile-day-statistics" aria-label="当天统计"><h2>当天统计 <small>{selectedDate}</small></h2>
      {archive ? <><p className="mobile-word-count">转写字数 <strong>{archivedCharacters}</strong> 字 <span>{archive.lines.length} 段原文</span></p><DayStatistics archive={archive} /></> : <p className="mobile-empty">{reading ? "正在打开归档…" : "当天没有归档统计。"}</p>}
    </section>
    <section className="mobile-date-picker" aria-label="选择日期"><div className="mobile-calendar-pane"><h2>日期</h2><input aria-label="手机记录日期" type="date" value={selectedDate} onChange={event => chooseDate(event.target.value)} /><div className="mobile-date-actions"><button type="button" onClick={() => chooseDate(shiftDay(selectedDate, -1))}>前一天</button><button type="button" onClick={() => chooseDate(localDay())}>今天</button><button type="button" onClick={() => chooseDate(shiftDay(selectedDate, 1))}>后一天</button></div><div className="mobile-calendar" aria-label="归档日历"><strong>{selectedDate.slice(0,4)} 年 {Number(selectedDate.slice(5,7))} 月</strong><div className="mobile-calendar-week">{["一","二","三","四","五","六","日"].map(day=><span key={day}>{day}</span>)}</div><div className="mobile-calendar-days">{Array.from({length:Math.ceil((calendarOffset+calendarDays)/7)*7},(_,index)=>{const day=index-calendarOffset+1;if(day<1||day>calendarDays)return <span key={index}/>;const date=`${selectedDate.slice(0,7)}-${String(day).padStart(2,"0")}`;return <button key={date} type="button" aria-label={`选择${date}`} aria-pressed={date===selectedDate} className={date===selectedDate?"is-selected":""} onClick={()=>chooseDate(date)}>{day}{recordedDates.has(date)&&<span className="mobile-calendar-dot" aria-label="有归档"/>}</button>;})}</div></div><p>{dayCount} 天 / {archives.length} 份</p>
      {loading ? <p>正在读取手机记录…</p> : listError ? <p role="alert">{listError}</p> : !archives.length ? <p className="mobile-empty">还没有手机记录。开启接收或导入归档。</p> : <p className="mobile-data-note">有记录：{[...new Set(archives.map(item => item.date))].join("、")}</p>}
      </div><div className="mobile-todo-pane"><h2>待办 <small>{selectedDate}</small></h2>{archive ? <TodoList archive={archive} /> : <p className="mobile-empty">当天没有归档待办。</p>}</div>
    </section>
    <section className="mobile-day-summary mobile-day-reader" aria-label="当日记录">
      <div className="mobile-document-heading"><div><h3>{selectedDate}</h3><p>{chosen ? `${deviceLabel(chosen.deviceId)} · ${chosen.todoCount} 条所选待办` : "当天没有手机记录"}</p></div></div>
      <label className="mobile-version-select">归档版本 <select aria-label="归档版本" value={selected} onChange={event => setSelected(event.target.value)}><option value="">当天最新快照</option>{dayArchives.map(item => <option key={item.id} value={item.id}>{deviceLabel(item.deviceId)} · {new Date(item.generatedAt).toLocaleString("zh-CN")}</option>)}</select></label>
      <div className="mobile-tabs" role="tablist" aria-label="手机记录内容">{tabs.map(([value, label]) => <button type="button" role="tab" key={value} aria-selected={tab === value} aria-controls={`mobile-tab-${value}`} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className="mobile-document" role="tabpanel" id={`mobile-tab-${tab}`} aria-label={tabs.find(([value]) => value === tab)?.[1]}>
        {reading ? <p className="mobile-empty">正在打开归档…</p> : detailError ? <p role="alert" className="mobile-error">{detailError}</p> : !archive ? <p className="mobile-empty">当天没有归档内容。</p> : tab === "timeline" ? <JournalTimeline key={selectedId} markdown={archive.journal?.markdown ?? ""} /> : tab === "lines" ? <Transcript archive={archive} /> : tab === "journal" ? archive.journal?.markdown.trim() ? <article className="mobile-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{archive.journal.markdown}</Markdown></article> : <p className="mobile-empty">这份归档没有日记或 AI 笔记。可以在手机整理后，再归档这一天。</p> : null}
      </div>
    </section>
    <section className="mobile-day-connection" aria-label="连接手机">
    <header className="mobile-header"><div><h3>连接手机</h3></div><div className="mobile-actions">
      <button type="button" onClick={() => void refresh()} disabled={busy}>刷新记录</button>
      <button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>导入归档 JSON</button>
      <input ref={fileInput} className="mobile-file-input" type="file" accept=".json,application/json" aria-label="导入手机归档 JSON" onChange={event => void importFile(event)} />
      <button type="button" className="primary-button" onClick={() => void toggleReceiver()} disabled={busy}>{busy ? "处理中…" : receiver.active ? "停止接收" : "开启手机接收"}</button>
    </div></header>
    <div className={`mobile-receiver ${receiver.active ? "is-active" : ""}`}>
      <div className="mobile-receiver-heading"><strong>{receiver.active ? "正在接收手机归档" : "手机接收未开启"}</strong><span>{receiver.active ? `本次已收到 ${receiver.receivedCount} 份` : "仅在电脑开启接收后，手机才能发送"}</span></div>
      {receiver.active ? <div className="mobile-pairing"><div><span>电脑地址</span>{receiver.addresses.length ? receiver.addresses.map(address => <code key={address}>{address}</code>) : <p>没有可用的局域网地址，请检查电脑网络。</p>}</div><div><span>配对码</span><strong className="mobile-pair-code">{receiver.code ?? "—"}</strong>{receiver.expiresAt && <small>有效至 {new Date(receiver.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>}</div><p>手机与电脑连接同一 Wi-Fi，在手机归档窗口填写地址和配对码，再点“发送到电脑”。</p></div>
        : <p>开启后会显示电脑地址和临时配对码。也可以先把手机导出的 JSON 文件传到电脑，再导入。</p>}
    </div>
    {(actionError || receiverError) && <p role="alert" className="mobile-error">{actionError || receiverError}</p>}
    {notice && <p role="status" className="mobile-notice">{notice}</p>}
    <details><summary>本机语音</summary><LocalAudioTools /></details>
    </section>
    {separator("width", "调整手机左右窗格宽度")}{separator("left", "调整统计与阅读高度")}{separator("right", "调整日历与连接高度")}
  </section>;
}

function JournalTimeline({ markdown }: { markdown: string }) {
  const timeline = markdown.match(/^## 时间线[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
  const entries = [...timeline.matchAll(/^### ([^\n]+)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  if (!entries.length) return <p className="mobile-empty">这份归档没有日记时间线。可在 AI 笔记阅读已归档全文，或在手机整理后重新归档。</p>;
  return <div className="mobile-journal-timeline">{entries.map((entry, index) => <details key={index}><summary>{entry[1]}</summary><article className="mobile-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{entry[2]}</Markdown></article></details>)}</div>;
}

function Transcript({ archive }: { archive: MobileArchive }) {
  const groups = useMemo(() => {
    const result = new Map<string, MobileArchive["lines"]>();
    const formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: archive.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    for (const line of [...archive.lines].sort((a, b) => a.startAt - b.startAt || a.localId - b.localId)) {
      const hour = formatter.format(new Date(line.startAt));
      const group = result.get(hour);
      if (group) group.push(line); else result.set(hour, [line]);
    }
    return result;
  }, [archive]);
  const contexts = new Map(archive.contexts?.map(item => [item.segmentId, item]));
  const seenSegments = new Set<number>();
  if (!archive.lines.length) return <p className="mobile-empty">这份归档没有转写原文。录音完成转写后，可从手机再次归档。</p>;
  return <div className="mobile-transcript">{[...groups].map(([hour, lines]) => <section className="mobile-hour" key={hour}><h4>{hour}</h4>{lines.map(line => {
    const context = seenSegments.has(line.segmentId) ? undefined : contexts.get(line.segmentId);
    seenSegments.add(line.segmentId);
    return <div className="mobile-utterance" key={line.id}>
      {context && <details className="mobile-context"><summary>用户补充的对话背景</summary>{context.participants && <p>交谈对象：{context.participants}</p>}{context.background && <p>{context.background}</p>}</details>}
      <div className="mobile-utterance-meta"><time>{clock(line.startAt, archive.timeZone)}–{clock(line.endAt, archive.timeZone)}</time><strong>{line.speaker || "未知说话人"}</strong></div><p>{line.text}</p>
    </div>;
  })}</section>)}</div>;
}

function Ranking({ rows, unit }: { rows: Array<{ name: string; value: number; display?: string }>; unit: string }) {
  const top = [...rows].sort((a, b) => b.value - a.value).slice(0, 7);
  const max = Math.max(...top.map(item => item.value), 1);
  return <ol className="mobile-ranking">{top.map((item, index) => <li key={`${item.name}-${index}`}><div><span>{item.name}</span><span>{item.display ?? `${item.value} ${unit}`}</span></div><div className="mobile-track"><span style={{ width: `${Math.max(0, Math.min(100, item.value / max * 100))}%` }} /></div></li>)}</ol>;
}
const metricState: Record<string, string> = { NoData: "暂无记录", NotAuthorized: "尚未授权", Unavailable: "暂不支持", Failed: "读取失败" };

function DayStatistics({ archive }: { archive: MobileArchive }) {
  const stats = archive.journal?.statistics;
  if (!stats) return <p className="mobile-empty">这份归档未附当天统计。请从手机日记页归档，并选择包含当天记录。</p>;
  const maxNotices = Math.max(...stats.notifications.hourly.map(item => item.count), 1);
  const metrics = [["步数", stats.health.steps, "步"], ["距离", stats.health.distanceMeters, "米"], ["运动时长", stats.health.exerciseMinutes, "分钟"]] as const;
  return <div className="mobile-statistics">
    <section><h4>手机使用</h4><p className="mobile-data-note">{stats.usage.message}</p>{stats.usage.state === "Ready" && stats.usage.apps.length > 0 ? <Ranking rows={stats.usage.apps.map(item => ({ name: item.label, value: item.foregroundMillis, display: duration(item.foregroundMillis) }))} unit="" /> : !stats.usage.message && <p className="mobile-empty">没有可用的使用记录。</p>}
      {stats.usage.timeline.length > 0 && <details className="mobile-statistic-details"><summary>查看使用时段</summary><ul>{stats.usage.timeline.map((item, index) => <li key={index}><time>{clock(item.startAt, archive.timeZone)}–{clock(item.endAt, archive.timeZone)}</time><span>{item.label}</span></li>)}</ul></details>}
    </section>
    <section><h4>通知 <span>{stats.notifications.total === null ? "暂无计数" : `${stats.notifications.total} 条`}</span></h4><p className="mobile-data-note">{stats.notifications.message}</p>{stats.notifications.coveredMillis > 0 && <p className="mobile-data-note">实际观测 {duration(stats.notifications.coveredMillis)}；未观测时段不补零。</p>}
      {stats.notifications.apps.length > 0 && <Ranking rows={stats.notifications.apps.map(item => ({ name: item.label, value: item.count }))} unit="条" />}
      {stats.notifications.hourly.length > 0 && <div className="mobile-hour-chart" aria-label="已观测小时通知数量">{stats.notifications.hourly.map(item => <div className="mobile-hour-column" key={item.hourStartMillis} title={`${clock(item.hourStartMillis, archive.timeZone)} ${item.count} 条通知`}><span>{item.count}</span><div><i style={{ height: `${item.count / maxNotices * 100}%` }} /></div><time>{clock(item.hourStartMillis, archive.timeZone)}</time></div>)}</div>}
    </section>
    <section><h4>运动与健康</h4><dl className="mobile-health-metrics">{metrics.map(([label, metric, unit]) => <div key={label}><dt>{label}</dt><dd>{metric.state === "Available" && metric.value !== null ? `${metric.value} ${unit}` : metricState[metric.state] ?? "暂无可用数据"}</dd>{metric.message && <small>{metric.message}</small>}</div>)}</dl>
      {stats.health.sessions.value && stats.health.sessions.value.length > 0 && <ul className="mobile-exercise-sessions">{stats.health.sessions.value.map((item, index) => <li key={index}><time>{clock(item.startAt, archive.timeZone)}–{clock(item.endAt, archive.timeZone)}</time><span>{item.typeLabel}</span></li>)}</ul>}
    </section>
    <p className="mobile-data-note">以上是手机归档时的统计快照，通知数不等于聊天消息数。</p>
  </div>;
}

function TodoList({ archive }: { archive: MobileArchive }) {
  if (!archive.todos.length) return <p className="mobile-empty">没有勾选归档到电脑的待办。手机中的其他待办不会自动加入这里。</p>;
  const statusLabel: Record<string, string> = { Pending: "待确认", Accepted: "待完成", Done: "已完成", Completed: "已完成" };
  return <ul className="mobile-todos">{archive.todos.map(todo => <li key={todo.id}><div><strong>{todo.content}</strong><span>{statusLabel[todo.status] ?? todo.status}</span></div><p>{todo.category}{todo.dueAt !== null ? ` · 约定时间 ${clock(todo.dueAt, archive.timeZone, true)}` : ""} · {todo.generatedBy === "ai" ? "AI 提取" : todo.generatedBy === "manual" ? "用户记录" : "生成方式未注明"}</p>{todo.sourceLineId && <small>来源：{archive.lines.find(line => line.id === todo.sourceLineId)?.text ?? "原文未载入"}</small>}</li>)}</ul>;
}
