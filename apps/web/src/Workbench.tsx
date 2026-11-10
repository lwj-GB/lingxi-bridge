import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { api, type EventRecord, type Person, type ReportListItem, type SourceRecord } from "./api";
import "./Workbench.css";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { formatEventNodeTime } from "./eventTime";
import { TerminalPanel } from "./TerminalPanel";

export type WorkbenchTarget = "assistant" | "people" | "events" | "autofill" | "mobile" | "live" | "reports" | "settings" | "workspace" | "data" | "usage" | "help" | "obsidian";
type IconName = "phone" | "people" | "folder" | "mic" | "report" | "settings" | "plus" | "refresh" | "search" | "layout" | "maximize" | "terminal" | "chevron";

// These small geometric glyphs are drawn for this workbench, not copied from an IDE.
function Icon({ name }: { name: IconName }) {
  const shapes: Record<IconName, ReactNode> = {
    phone: <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M10 5h4M11 19h2" /></>,
    people: <><circle cx="12" cy="7" r="3" /><path d="M5 21v-4a7 7 0 0 1 14 0v4M3 3h18v18H3z" /></>,
    folder: <path d="M2 6h8l2 2h10l-3 12H2V6Zm0 2V4h8l2 2h8v2" />,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    report: <><path d="M4 2h11l5 5v15H4zM14 2v6h6M8 17v-3m4 3V9m4 8v-5" /></>,
    settings: <><path d="m9 3 1-2h4l1 2 3 2 2 1v4l-2 1v3l2 1v4l-2 1-3 2-1 2h-4l-1-2-3-2-2-1v-4l2-1v-3-1l-2-1V6l2-1z" transform="translate(0 -1) scale(1 .95)" /><circle cx="12" cy="11" r="3" /></>,
    plus: <path d="M12 3v18M3 12h18" />,
    refresh: <><path d="M20 3v6h-6M4 21v-6h6" /><path d="M20 9A8 8 0 0 0 6 5M4 15a8 8 0 0 0 14 4" /></>,
    search: <><circle cx="10" cy="10" r="7" /><path d="m15 15 7 7" /></>,
    layout: <><rect x="2" y="3" width="20" height="18" /><path d="M8 3v18M8 10h14M16 10v11" /></>,
    maximize: <path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6" />,
    terminal: <><rect x="2" y="4" width="20" height="16" /><path d="m6 8 4 4-4 4m7 0h5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;
}


interface LayoutPreferences { directory: boolean; leftHeight: number; rightHeight: number; rightWidth: number; personOpen: boolean; resultsOpen: boolean; contextOpen: boolean; assistantOpen: boolean; }
const DEFAULT_LAYOUT: LayoutPreferences = { directory: true, leftHeight: 174, rightHeight: 292, rightWidth: 35, personOpen: true, resultsOpen: true, contextOpen: true, assistantOpen: true };
const LAYOUT_KEY = "lingxi.workbench-layout.v1";

function readLayout(): LayoutPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Partial<LayoutPreferences> | null;
    return {
      personOpen: stored?.personOpen !== false, resultsOpen: stored?.resultsOpen !== false, contextOpen: stored?.contextOpen !== false, assistantOpen: stored?.assistantOpen !== false,
      directory: typeof stored?.directory === "boolean" ? stored.directory : true,
      leftHeight: typeof stored?.leftHeight === "number" ? Math.min(300, Math.max(130, stored.leftHeight)) : DEFAULT_LAYOUT.leftHeight,
      rightHeight: typeof stored?.rightHeight === "number" ? Math.min(500, Math.max(160, stored.rightHeight)) : DEFAULT_LAYOUT.rightHeight,
      rightWidth: typeof stored?.rightWidth === "number" ? Math.min(48, Math.max(26, stored.rightWidth)) : DEFAULT_LAYOUT.rightWidth,
    };
  } catch { return DEFAULT_LAYOUT; }
}

export function Workbench({
  activeView, pageLabel, openedPath, people, person, events, event, sources, reports, subjectType, onSubjectTypeChange,
  navigation, content, inspector, reportReview, meetingContext, assistant, live, topbar, overlays, onLiveAnalysisContainer,
  onNavigate, onNewPerson, onRefresh, refreshing, onSelectPerson, onBrowsePerson,
  onOpenSource, onOpenReport, onSelectEvent, onNewEvent, onRun, onPrepareReport, runEnabled, inspectedEvidenceId, currentReportTopicId, onInspectEventQuote, onRenameEventNode,
}: {
  subjectType: "person" | "event"; onSubjectTypeChange: (type: "person" | "event") => void;
  activeView: WorkbenchTarget; pageLabel: string; openedPath: string;
  people: Person[]; person?: Person; events: EventRecord[]; event?: EventRecord; sources: SourceRecord[]; reports: ReportListItem[];
  navigation: ReactNode; content: ReactNode; inspector: ReactNode; reportReview?: ReactNode; meetingContext?: ReactNode; assistant: ReactNode; live: ReactNode;
  onLiveAnalysisContainer: (element: HTMLDivElement | null) => void; inspectedEvidenceId: string; currentReportTopicId: string;
  topbar: ReactNode; overlays: ReactNode;
  onNavigate: (view: WorkbenchTarget) => void; onNewPerson: () => void;
  onRefresh: () => void; refreshing: boolean; onSelectPerson: (id: string) => void;
  onBrowsePerson: (view: "profile" | "sources" | "evidence" | "events" | "reports") => void;
  onInspectEventQuote: (sourceId: string, start: number, end: number, quote: string) => void;
  onRenameEventNode: (nodeId: string, label: string) => Promise<boolean>;
  onSelectEvent: (event: EventRecord) => void; onNewEvent: () => void; onRun: () => void; onPrepareReport: () => void; runEnabled: boolean;
  onOpenSource: (source: SourceRecord) => void; onOpenReport: (report: ReportListItem) => void;
}) {
  const [layout, setLayout] = useState(readLayout);
  const [maximized, setMaximized] = useState(false);
  const [newDialog, setNewDialog] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = () => menuRef.current?.querySelectorAll(".wb-menu details[open], .toolbar-more[open]").forEach(item => item.removeAttribute("open"));
    const outside = (event: PointerEvent) => { menuRef.current?.querySelectorAll(".wb-menu details[open], .toolbar-more[open]").forEach(item => { if (!item.contains(event.target as Node)) item.removeAttribute("open"); }); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { const selected = menuRef.current?.querySelector<HTMLDetailsElement>(".wb-menu details[open], .toolbar-more[open]"); close(); selected?.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  const [contacts, setContacts] = useState(false);
  const [aiTab, setAiTab] = useState<"assistant" | "terminal">("assistant");
  const [query, setQuery] = useState("");
  const setSubjectType = onSubjectTypeChange;
  const liveRef = useRef<HTMLDivElement>(null);
  const [liveControls, setLiveControls] = useState({ start: false, stop: false });
  useEffect(() => { const element = liveRef.current; if (!element) return; const refresh = () => { const controls = element.querySelector(".local-recorder") ?? element; const start = controls.querySelector<HTMLButtonElement>('[data-live-action="start"]'); const stop = controls.querySelector<HTMLButtonElement>('[data-live-action="stop"]'); setLiveControls({ start: Boolean(start && !start.disabled), stop: Boolean(stop && !stop.disabled) }); }; refresh(); const observer = new MutationObserver(refresh); observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "data-session-phase"] }); return () => observer.disconnect(); }, []);
  const [context, setContext] = useState<"process" | "source" | "versions" | "live" | "review">(activeView === "reports" ? "review" : activeView === "live" ? "live" : "process");
  const previousView = useRef(activeView);
  useEffect(() => { if (activeView === "reports" && previousView.current !== activeView) { setContext("review"); setLayout(previous => ({ ...previous, contextOpen: true })); } if (activeView === "live" && previousView.current !== activeView) { setContext("live"); setLayout(previous => ({ ...previous, contextOpen: true })); } previousView.current = activeView; }, [activeView]);
  useEffect(() => { if (inspectedEvidenceId) { setContext("source"); setLayout(previous => ({ ...previous, contextOpen: true })); } }, [inspectedEvidenceId]);
  const [versionHistory, setVersionHistory] = useState<ReportListItem[]>([]);
  const [versionsError, setVersionsError] = useState("");
  const currentTopicRevision = reports.find(item => item.topic.id === currentReportTopicId)?.topic.revision;
  useEffect(() => {
    let cancelled = false;
    setVersionHistory([]); setVersionsError("");
    if (context === "versions" && currentReportTopicId) {
      void api.listReportVersions(currentReportTopicId).then(result => { if (!cancelled) setVersionHistory(result.items); }).catch(error => { if (!cancelled) setVersionsError(error instanceof Error ? error.message : "版本未能加载"); });
    }
    return () => { cancelled = true; };
  }, [context, currentReportTopicId, currentTopicRevision]);
  useEffect(() => { if (activeView === "events" && !liveControls.stop) setContext("process"); }, [activeView, liveControls.stop]);
  const columns = useRef<HTMLDivElement>(null);
  useEffect(() => { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }, [layout]);
  useEffect(() => { setContacts(false); }, [person?.id, openedPath]);
  const relevantSources = subjectType === "event" && event ? sources.filter(item => item.event_ids.includes(event.id)) : person ? sources.filter(item => item.person_ids.includes(person.id)) : [];
  const relevantReports = subjectType === "event" && event ? reports.filter(item => item.analysis?.material_scope.some(id => relevantSources.some(source => source.id === id))) : person ? reports.filter(item => item.topic.person_ids.includes(person.id)) : reports;
  const age = person?.profile_sections?.find(item => item.section === "basic_info" && item.label === "年龄" && item.confirmation_status === "confirmed")?.value;
  const filteredPeople = people.filter(item => `${item.display_name} ${item.relation_to_user}`.toLowerCase().includes(query.toLowerCase()));
  const latestUpdate = relevantSources.reduce((date, item) => item.updated_at > date ? item.updated_at : date, person?.updated_at ?? "");
  const title = openedPath.replace(/\/+$/, "").split("/").at(-1) || "本地工作台";
  const reset = () => { setLayout(DEFAULT_LAYOUT); setMaximized(false); };
  const closePane = (pane: "personOpen" | "resultsOpen" | "contextOpen" | "assistantOpen") => setLayout(previous => ({ ...previous, [pane]: false }));
  const togglePane = (pane: "personOpen" | "resultsOpen" | "contextOpen" | "assistantOpen") => setLayout(previous => ({ ...previous, [pane]: !previous[pane] }));
  function drag(event: React.PointerEvent<HTMLElement>, key: "leftHeight" | "rightHeight" | "rightWidth") {
    event.preventDefault();
    const element = event.currentTarget;
    const origin = event.clientY;
    const start = layout[key];
    const rect = columns.current?.getBoundingClientRect();
    element.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const value = key === "rightWidth" && rect
        ? Math.min(48, Math.max(26, 100 * (rect.right - e.clientX) / rect.width))
        : Math.min(key === "leftHeight" ? 300 : 500, Math.max(key === "leftHeight" ? 130 : 160, start + e.clientY - origin));
      setLayout(previous => ({ ...previous, [key]: value }));
    };
    const end = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", end); element.removeEventListener("pointercancel", end); };
    element.addEventListener("pointermove", move); element.addEventListener("pointerup", end); element.addEventListener("pointercancel", end);
  }
  function resizeKey(event: React.KeyboardEvent<HTMLElement>, key: "leftHeight" | "rightHeight" | "rightWidth") {
    const decreasing = event.key === "ArrowUp" || event.key === "ArrowLeft";
    const increasing = event.key === "ArrowDown" || event.key === "ArrowRight";
    if (!decreasing && !increasing) return;
    event.preventDefault();
    const step = key === "rightWidth" ? 2 : 10;
    setLayout(previous => ({ ...previous, [key]: Math.min(key === "rightWidth" ? 48 : key === "leftHeight" ? 300 : 500, Math.max(key === "rightWidth" ? 26 : key === "leftHeight" ? 130 : 160, previous[key] + (decreasing ? -step : step))) }));
  }
  const separator = (key: "leftHeight" | "rightHeight" | "rightWidth", label: string) => <div className={`wb-divider ${key === "rightWidth" ? "vertical" : "horizontal"}`} role="separator" aria-label={label} aria-orientation={key === "rightWidth" ? "vertical" : "horizontal"} aria-valuenow={Math.round(layout[key])} tabIndex={0} onPointerDown={e => drag(e, key)} onKeyDown={e => resizeKey(e, key)} />;
  return <div className={`workbench ${activeView === "mobile" ? "wb-mobile" : ""} ${layout.directory ? "" : "wb-directory-hidden"} ${activeView === "live" ? "wb-meeting" : ""} ${maximized ? "wb-maximized" : ""} ${!layout.personOpen ? "wb-person-closed" : ""} ${!layout.resultsOpen ? "wb-results-closed" : ""} ${!layout.contextOpen ? "wb-context-closed" : ""} ${!layout.assistantOpen ? "wb-assistant-closed" : ""}`} style={{ "--wb-left-height": `${layout.leftHeight}px`, "--wb-right-height": `${layout.rightHeight}px`, "--wb-right-width": `${layout.rightWidth}%` } as CSSProperties}>
    <header className="wb-chrome" ref={menuRef} onClick={event => { const target = event.target as HTMLElement; const summary = target.closest("summary"); const current = summary?.parentElement; menuRef.current?.querySelectorAll(".wb-menu details[open], .toolbar-more[open]").forEach(item => { if (item !== current) item.removeAttribute("open"); }); if (target.closest("button")) menuRef.current?.querySelectorAll(".wb-menu details[open], .toolbar-more[open]").forEach(item => item.removeAttribute("open")); }}>
      <div className="wb-title"><span>灵犀桥</span><span>{title}</span><div className="wb-window-tools"><button type="button" title="切换资料目录" aria-label="切换资料目录" onClick={() => setLayout(previous => ({ ...previous, directory: !previous.directory }))}><Icon name="folder" /></button><button type="button" title="恢复默认布局" aria-label="恢复默认布局" onClick={reset}><Icon name="layout" /></button><button type="button" title="最大化或还原工作区" aria-label="最大化或还原工作区" onClick={() => setMaximized(value => !value)}><Icon name="maximize" /></button></div></div>
      <div className="wb-menu"><details><summary>文件</summary><div><button type="button" onClick={() => onNavigate("workspace")}>打开工作区</button><button type="button" onClick={onNewPerson}>新建人物</button><button type="button" onClick={onNewEvent}>新建事件</button><button type="button" onClick={() => onNavigate("data")}>管理与导出</button></div></details><details><summary>编辑</summary><div><button type="button" onClick={() => onBrowsePerson("profile")}>编辑人物档案</button><button type="button" onClick={() => onNavigate("events")}>编辑事件信息</button></div></details><details><summary>视图</summary><div><button type="button" onClick={() => setLayout(previous => ({ ...previous, directory: !previous.directory }))}>资料目录</button><button type="button" onClick={() => togglePane("personOpen")}>{layout.personOpen ? "隐藏" : "显示"}人物窗格</button><button type="button" onClick={() => togglePane("resultsOpen")}>{layout.resultsOpen ? "隐藏" : "显示"}结果窗格</button><button type="button" onClick={() => togglePane("contextOpen")}>{layout.contextOpen ? "隐藏" : "显示"}依据/会谈窗格</button><button type="button" onClick={() => togglePane("assistantOpen")}>{layout.assistantOpen ? "隐藏" : "显示"}AI窗格</button><button type="button" onClick={reset}>恢复布局</button></div></details><details><summary>资料</summary><div><button type="button" onClick={() => onBrowsePerson("sources")}>浏览人物材料</button><button type="button" onClick={() => onNavigate("autofill")}>整理与导入</button></div></details><details><summary>分析</summary><div><button type="button" onClick={onPrepareReport}>生成分析报告</button><button type="button" onClick={() => onBrowsePerson("sources")}>聊天统计</button></div></details><details><summary>工具</summary><div><button type="button" onClick={() => onNavigate("live")}>会谈与转写</button><button type="button" onClick={() => onNavigate("obsidian")}>Obsidian 与 CLI</button></div></details><details><summary>帮助</summary><div><button type="button" onClick={() => onNavigate("help")}>使用帮助</button><button type="button" onClick={() => onNavigate("usage")}>资料统计</button></div></details></div>
      <div className="wb-toolbar"><div className="wb-quick-tools"><button type="button" aria-label="新建" title="新建人物或事件" onClick={() => setNewDialog(true)}><Icon name="plus" /></button><button type="button" aria-label="刷新资料" title={openedPath ? "刷新当前工作区" : "先打开工作区"} disabled={!openedPath || refreshing} onClick={onRefresh}><Icon name="refresh" /></button><span className="wb-tool-separator" /><button type="button" aria-label="运行当前任务" title={activeView === "live" ? "开始会谈" : "运行已确认的报告任务"} disabled={activeView === "live" ? !liveControls.start : !runEnabled} onClick={() => { if (activeView === "live") liveRef.current?.querySelector<HTMLButtonElement>('.local-recorder [data-live-action="start"]')?.click(); else onRun(); }}><span aria-hidden="true">▷</span></button><button type="button" aria-label="停止当前任务" title={liveControls.stop ? "停止会谈并保留转写" : "当前没有可停止的会谈任务"} disabled={!liveControls.stop} onClick={() => liveRef.current?.querySelector<HTMLButtonElement>('.local-recorder [data-live-action="stop"]')?.click()}><span aria-hidden="true">□</span></button><button type="button" aria-label="切换目录" title="切换资料目录" onClick={() => setLayout(previous => ({ ...previous, directory: !previous.directory }))}><Icon name="folder" /></button></div>{topbar}</div>
    </header>
    <div className="wb-body">
      <nav className="wb-activity" aria-label="工作台模块">{([
        ["people", "people", "人物模块"], ["events", "report", "事件模块"], ["mobile", "phone", "手机模块"], ["live", "mic", "会谈模块"], ["reports", "report", "报告模块"],
      ] as const).map(([target, icon, label]) => <button type="button" key={target} aria-label={label} title={label} aria-current={activeView === target ? "page" : undefined} onClick={() => { if (target === "people") setSubjectType("person"); if (target === "events") setSubjectType("event"); if (target !== "mobile") setLayout(previous => ({ ...previous, personOpen: true, resultsOpen: true, contextOpen: true })); if (target === "reports") setContext("review"); if (target === "live") setContext("live"); onNavigate(target); }}><Icon name={icon} /><span>{label.replace("模块", "")}</span></button>)}<div className="wb-activity-space" /><button type="button" aria-label="外观与设置" title="设置" aria-current={activeView === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><Icon name="settings" /><span>设置</span></button></nav>
      <aside className="wb-directory" aria-label="资料目录" hidden={activeView === "mobile"}>
        <div className="wb-panel-heading"><span>资料目录</span><div><button type="button" title="刷新目录" aria-label="刷新目录" disabled={!openedPath || refreshing} onClick={onRefresh}><Icon name="refresh" /></button></div></div>
        <label className="wb-search"><Icon name="search" /><input aria-label="查找联系人" placeholder="查找联系人" value={query} onChange={e => { setQuery(e.target.value); if (e.target.value) { setContacts(true); setSubjectType("person"); } }} /></label>
        {navigation}
        <nav className="wb-resource-tree" aria-label="事件目录"><strong>事件</strong><button type="button" onClick={onNewEvent}><Icon name="plus" />新建事件</button>{events.map(item => <button type="button" key={item.id} onClick={() => { setSubjectType("event"); onSelectEvent(item); }}><Icon name="report" /><span>{item.title}</span></button>)}</nav>
        {person && <nav className="wb-resource-tree" aria-label="当前人物资料目录"><strong>{person.display_name}</strong><button type="button" onClick={() => onBrowsePerson("profile")}><Icon name="people" />档案</button><button type="button" onClick={() => onBrowsePerson("sources")}><Icon name="folder" />浏览资料 <small>{relevantSources.length}</small></button>{relevantSources.slice(0, 8).map(source => <button type="button" className="wb-resource-file" title={source.title} key={source.id} onClick={() => { setContext("source"); setLayout(previous => ({ ...previous, contextOpen: true, resultsOpen: true })); onOpenSource(source); }}><Icon name="report" /><span>{source.title}</span></button>)}<button type="button" onClick={() => onBrowsePerson("events")}><Icon name="chevron" />事件</button><button type="button" onClick={() => onBrowsePerson("reports")}><Icon name="report" />报告主题 <small>{relevantReports.length}</small></button></nav>}
      </aside>
      <div className="wb-columns" ref={columns}>
        <div className="wb-left-column">
          <section className="wb-person" aria-label="人物上下文" hidden={activeView === "mobile" || !layout.personOpen}>
            <div className="wb-panel-heading"><button type="button" className={subjectType === "person" && !contacts ? "is-active" : ""} onClick={() => { setContacts(false); setSubjectType("person"); }}>人物信息</button><button type="button" className={subjectType === "event" ? "is-active" : ""} onClick={() => { setSubjectType("event"); onNavigate("events"); }}>事件</button><button type="button" className={contacts ? "is-active" : ""} onClick={() => { setContacts(true); setSubjectType("person"); }}>联系人列表</button><div><button type="button" aria-label="添加人物" title="添加人物" onClick={onNewPerson}><Icon name="plus" /></button><button type="button" aria-label="编辑当前档案" title="编辑当前人物档案" disabled={!person} onClick={() => onBrowsePerson("profile")}><Icon name="people" /></button><button type="button" aria-label="关闭人物窗格" title="关闭人物窗格" onClick={() => closePane("personOpen")}>×</button></div></div>
            {activeView === "live" ? <div className="wb-meeting-draft"><h2>本次会谈</h2>{meetingContext}</div> : subjectType === "event" ? event ? <div className="wb-event-summary"><h2>{event.title}</h2><p>{new Date(event.occurred_at).toLocaleString("zh-CN")}{event.location ? `　·　${event.location}` : ""}</p><p>参与人物：{people.filter(item => event.person_ids.includes(item.id)).map(item => item.display_name).join("、") || "待关联"}　·　材料 {relevantSources.length} 份</p>{event.summary && <p>{event.summary}</p>}<button type="button" onClick={() => onSelectEvent(event)}>编辑事件信息</button></div> : <div className="wb-contact-picker">{events.length ? events.map(item => <button type="button" key={item.id} onClick={() => onSelectEvent(item)}>{item.title}</button>) : <p>选择或新建事件</p>}</div> : !person || contacts ? <div className="wb-contact-picker">{filteredPeople.length ? filteredPeople.map(item => <button type="button" key={item.id} onClick={() => { setSubjectType("person"); onSelectPerson(item.id); setContacts(false); }}><span>{item.display_name}</span><small>{item.relation_to_user}</small></button>) : <p>{query ? "没有匹配的联系人" : "打开工作区后选择或新建人物"}</p>}</div> : <div className="wb-person-summary"><div className="wb-person-avatar" aria-hidden="true">{person.display_name.slice(0, 1)}</div><div><h2>{person.display_name}</h2><p>{person.relation_to_user}{age ? `　·　${age}` : ""}</p><dl><div><dt>原始资料</dt><dd>{relevantSources.length} 份</dd></div><div><dt>报告</dt><dd>{relevantReports.length} 个主题</dd></div><div><dt>最近更新</dt><dd>{latestUpdate ? new Date(latestUpdate).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</dd></div></dl></div></div>}
          </section>
          {separator("leftHeight", "调整人物区与结果区高度")}
          <section className="wb-results" aria-label="结果工作区" hidden={activeView !== "mobile" && !layout.resultsOpen}><div className="wb-panel-heading"><span className="wb-current-tab">{pageLabel}</span><div><button type="button" title="最大化结果区" aria-label="最大化结果区" onClick={() => setMaximized(value => !value)}><Icon name="maximize" /></button><button type="button" aria-label="关闭结果窗格" title="关闭结果窗格" onClick={() => closePane("resultsOpen")}>×</button></div></div>{content}<div ref={onLiveAnalysisContainer} hidden={activeView !== "live"} className="wb-live-analysis" /></section>
        </div>
        {separator("rightWidth", "调整左右工作区宽度")}
        <div className="wb-right-column" hidden={activeView === "mobile"}>
          <section className="wb-context" aria-label="过程与依据" hidden={!layout.contextOpen}><div className="wb-panel-heading">{activeView === "reports" && <button type="button" className={context === "review" ? "is-active" : ""} onClick={() => setContext("review")}>逐题核对</button>}{activeView === "live" && <button type="button" className={context === "live" ? "is-active" : ""} onClick={() => setContext("live")}>会谈</button>}{activeView !== "reports" && activeView !== "live" && <button type="button" className={context === "process" ? "is-active" : ""} onClick={() => setContext("process")}>过程与依据</button>}<button type="button" className={context === "source" ? "is-active" : ""} onClick={() => setContext("source")}>原文</button><button type="button" className={context === "versions" ? "is-active" : ""} onClick={() => setContext("versions")}>版本</button><div><button type="button" aria-label="关闭依据窗格" title="关闭窗格，不停止会谈" onClick={() => closePane("contextOpen")}>×</button></div></div><div className="wb-context-body"><div className="wb-live" ref={liveRef} hidden={context !== "live"}>{live}</div><div className="wb-review" hidden={context !== "review"}>{reportReview}</div><div hidden={context === "live" || context === "review"}>{context === "source" ? inspector : context === "versions" ? <div className="wb-report-versions"><h3>{currentReportTopicId ? "当前主题的历史版本" : "当前对象的报告记录"}</h3>{versionsError && <p role="alert">{versionsError}</p>}{(currentReportTopicId ? versionHistory : relevantReports).length ? (currentReportTopicId ? versionHistory : relevantReports).map(item => <button type="button" key={item.snapshot.id} onClick={() => { setLayout(previous => ({ ...previous, resultsOpen: true })); onOpenReport(item); }}><strong>{item.topic.title}</strong><span>v{item.snapshot.version} · {new Date(item.snapshot.created_at).toLocaleDateString("zh-CN")}</span></button>) : <p>尚无报告。生成后可在这里打开已保存记录。</p>}</div> : <div className="wb-process"><h3>{subjectType === "event" && event ? event.title : person ? person.display_name : "当前工作区"}</h3><dl><div><dt>工作区</dt><dd>{openedPath || "尚未打开"}</dd></div><div><dt>当前操作</dt><dd>{pageLabel}</dd></div><div><dt>可用材料</dt><dd>{relevantSources.length} 份</dd></div></dl>{subjectType === "event" && event?.analysis ? <section className="wb-event-nodes"><h3>候选时间节点</h3>{event.analysis.nodes.map(node => <article className="wb-event-node" key={`${node.id}-${event.revision}`}><div className="wb-event-node-time"><time>{formatEventNodeTime(node.timestamp_ms)}</time><span>待核对</span></div><input aria-label={`候选节点名称：${node.label}`} defaultValue={node.label} maxLength={500} onBlur={blurEvent => { const input = blurEvent.currentTarget; if (input.value.trim() && input.value.trim() !== node.label) void onRenameEventNode(node.id, input.value).then(saved => { if (!saved && input.isConnected) input.value = node.label; }); else input.value = node.label; }} /><button type="button" onClick={() => { setContext("source"); setLayout(previous => ({ ...previous, contextOpen: true })); onInspectEventQuote(node.source_id, node.quote_start, node.quote_end, node.quote); }}><blockquote>{node.quote}</blockquote><small>{sources.find(item => item.id === node.source_id)?.title ?? "原始材料"} · 待核对</small></button></article>)}</section> : <p>打开报告的来源引用，可核对原文与位置。</p>}<button type="button" onClick={() => setContext("source")}>打开来源检查器</button></div>}</div></div></section>
          {separator("rightHeight", "调整依据与AI工作区高度")}
          <section className="wb-assistant" aria-label="AI 工作区" hidden={!layout.assistantOpen}><div className="wb-panel-heading"><button type="button" aria-label="切换AI助手" className={aiTab === "assistant" ? "is-active" : ""} onClick={() => setAiTab("assistant")}><h2>AI 工作台</h2></button><button type="button" title="真实本机CLI终端" aria-label="CLI 终端" className={aiTab === "terminal" ? "is-active" : ""} onClick={() => setAiTab("terminal")}><Icon name="terminal" />CLI 终端</button><div><button type="button" aria-label="AI模型设置" title="配置模型" onClick={() => onNavigate("settings")}><Icon name="settings" /></button><button type="button" aria-label="关闭AI窗格" title="关闭AI窗格" onClick={() => closePane("assistantOpen")}>×</button></div></div><div className="wb-assistant-body" hidden={aiTab !== "assistant"}>{assistant}</div><div className="wb-terminal-body" hidden={aiTab !== "terminal"}><TerminalPanel workspacePath={openedPath} active={aiTab === "terminal" && layout.assistantOpen} /></div></section>
        </div>
      </div>
    </div>
    <footer className="wb-status"><span><Icon name="folder" />{title}</span><span hidden={activeView === "mobile"}>{person?.display_name ?? "未选择人物"}</span><span>{openedPath ? "本地工作区" : "未打开工作区"}</span></footer>
    {newDialog && <WorkbenchDialog title="新建" onClose={() => setNewDialog(false)}><div className="wb-new-options"><button type="button" onClick={() => { setNewDialog(false); onNewPerson(); }}>新建人物</button><button type="button" onClick={() => { setNewDialog(false); onNewEvent(); }}>新建事件</button></div></WorkbenchDialog>}
    {overlays}
  </div>;
}
