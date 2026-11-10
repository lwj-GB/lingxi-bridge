import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ReportSnapshot } from "./api";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { ReportCharts } from "./ReportCharts";
import "./ReportDocument.css";

export function reportMarkdown(body: string, snapshot: ReportSnapshot) {
  const assets = snapshot.charts?.assets ?? [];
  const directory = snapshot.charts?.manifest_path.replace(/\/manifest\.json$/, "");
  const allowed = new Map(assets.map(asset => [`${directory}/${asset.name}`, asset]));
  const wikiResolved = body.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (_match, image: string, target: string) => {
    const [path, label] = target.split("|");
    const asset = allowed.get(path);
    if (!asset || (image && asset.kind !== "image")) return image ? "" : label || path;
    const url = api.reportAssetUrl(snapshot.id, asset.name);
    const title = asset.title.replace(/[\[\]\\]/g, "");
    return `${image}[${label || title}](${url})`;
  });
  const imagePaths = new Map(assets.filter(asset => asset.kind === "image").flatMap(asset => {
    const url = api.reportAssetUrl(snapshot.id, asset.name);
    return [[`../../${directory}/${asset.name}`, url], [url, url]];
  }));
  const included = new Set<string>();
  return wikiResolved.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, label: string, path: string) => {
    const url = imagePaths.get(path);
    if (!url) return match;
    if (included.has(url)) return "";
    included.add(url);
    const caption = label || assets.find(asset => api.reportAssetUrl(snapshot.id, asset.name) === url)?.title || "统计图";
    return `![${caption.replace(/[\[\]\\]/g, "")}](${url})`;
  });
}

export function ReportDocument({ snapshot, fallback, onRefresh, title }: { snapshot: ReportSnapshot; fallback: ReactNode; onRefresh?: () => Promise<void>; title?: string }) {
  const [exportKind, setExportKind] = useState<"pdf" | "markdown" | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const alive = useRef(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    const refreshed = () => setRefreshVersion(value => value + 1);
    window.addEventListener("lingxi:workspace-refreshed", refreshed);
    return () => window.removeEventListener("lingxi:workspace-refreshed", refreshed);
  }, []);
  useEffect(() => {
    alive.current = true;
    setBody(null); setLoadError(""); setActionError("");
    let cancelled = false;
    void api.getReportDocument(snapshot.id).then(record => {
      if (!cancelled) setBody(/^#[^\n]*\n+\s*```json\s*\n/.test(record.body) ? null : record.body);
    }).catch(() => { if (!cancelled) setLoadError("Markdown 阅读稿暂时无法读取，以下显示已保存的结构化内容。"); });
    return () => { cancelled = true; alive.current = false; };
  }, [snapshot.id, refreshVersion]);
  const assetUrls = new Set(snapshot.charts?.assets.map(asset => api.reportAssetUrl(snapshot.id, asset.name)) ?? []);
  const imageUrls = new Set(snapshot.charts?.assets.filter(asset => asset.kind === "image").map(asset => api.reportAssetUrl(snapshot.id, asset.name)) ?? []);
  const articleBody = title && body?.startsWith(`# ${title}\n`) ? body.slice(title.length + 3).trimStart() : body;
  const mainBody = articleBody?.split(/^#{1,3}\s+资料依据\s*$/m)[0] ?? null;
  const markdown = mainBody === null ? "" : reportMarkdown(mainBody, snapshot);
  const embeddedImages = [...imageUrls].filter(url => markdown.includes(`](${url})`));
  const hiddenChartNames = snapshot.charts?.assets.filter(asset => embeddedImages.includes(api.reportAssetUrl(snapshot.id, asset.name))).map(asset => asset.name) ?? [];

  async function action(kind: "pdf" | "markdown" | "reveal" | "open" | "refresh") {
    setBusy(true); setActionError(""); setActionStatus("");
    try {
      if (kind === "refresh") {
        await onRefresh?.();
      } else if (kind === "reveal" || kind === "open") {
        const file = await api.getReportFile(snapshot.id);
        if (!alive.current) return;
        await window.__TAURI__!.core.invoke(kind === "reveal" ? "reveal_report_markdown" : "open_report_markdown", { workspacePath: file.workspace_path, relativePath: file.relative_path });
      } else {
        const response = await fetch(api.reportDownloadUrl(snapshot.id, kind));
        if (!response.ok) {
          const failure = await response.json().catch(() => null);
          throw new Error(failure?.error?.message || "导出失败，请刷新后重试。");
        }
        if (!alive.current) return;
        const suggestedName = `report-${snapshot.id}.${kind === "pdf" ? "pdf" : "md"}`;
        if (window.__TAURI__?.core.invoke) {
          const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
          if (!alive.current) return;
          const saved = await window.__TAURI__.core.invoke<boolean>("save_report_export", { kind, suggestedName, bytes });
          if (alive.current) setActionStatus(saved ? "文件已保存。" : "已取消保存。");
        } else {
          const blob = await response.blob();
          if (!alive.current) return;
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url; link.download = suggestedName;
          link.click(); setActionStatus("已请求浏览器下载，请在下载列表确认文件。"); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
    } catch (error) {
      if (alive.current) setActionError(error instanceof Error ? error.message : "操作失败，请重试。");
    } finally { if (alive.current) setBusy(false); }
  }

  return <>
    {exportKind && <WorkbenchDialog title="导出报告" busy={busy} onClose={() => setExportKind(null)}><p>{title || "当前阅读报告"}</p><label>文件格式<select aria-label="导出格式" value={exportKind} disabled={busy} onChange={event => setExportKind(event.target.value as "pdf" | "markdown")}><option value="pdf">PDF（含报告图表）</option><option value="markdown">Markdown 阅读稿</option></select></label><p>导出当前阅读稿，保留历史分析快照。</p><button type="button" className="primary-button" disabled={busy} onClick={() => void action(exportKind)}>{busy ? "正在导出…" : "选择位置并导出"}</button>{actionError && <p role="alert">{actionError}</p>}{actionStatus && <p role="status">{actionStatus}</p>}</WorkbenchDialog>}
    <nav className="report-document-actions" aria-label="报告文件操作">
      {onRefresh && <button type="button" disabled={busy} title="外部编辑后显式刷新，核对文件变化" onClick={() => void action("refresh")}>刷新阅读稿</button>}
      <button type="button" disabled={busy} onClick={() => setExportKind("pdf")}>导出 PDF</button>
      <button type="button" disabled={busy} onClick={() => setExportKind("markdown")}>下载 Markdown</button>
      {window.__TAURI__?.core.invoke && <>
        <button type="button" disabled={busy} onClick={() => void action("reveal")}>在访达中显示</button>
        <button type="button" disabled={busy} onClick={() => void action("open")}>打开 Markdown 编辑</button>
      </>}
    </nav>
    <p className="report-document-note">Markdown 阅读稿 · 外部编辑后请刷新；人工修改不会改变原分析结论，复核仍依据原快照。</p>
    {!exportKind && actionError && <p role="alert">{actionError}</p>}
    {!exportKind && actionStatus && <p role="status">{actionStatus}</p>}
    {body !== null ? <div className="report-document" aria-label="Markdown 报告正文">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => assetUrls.has(url) ? url : undefined} components={{
        img: ({ src, alt }) => src && imageUrls.has(src) ? <figure>{failedImages.includes(src) ? <p role="alert">图表文件无法读取或完整性校验失败，请刷新后核对。</p> : <img src={src} alt={alt || "报告统计图"} loading="lazy" onError={() => setFailedImages(values => [...values, src])} />}<figcaption>{alt} · 来源：本次证据关联材料，本地 R 统计</figcaption></figure> : null,
        p: ({ children, node }) => node?.children.some(child => child.type === "element" && child.tagName === "img") ? <div>{children}</div> : <p>{children}</p>,
        a: ({ href, children }) => href && assetUrls.has(href) ? <a href={href} download>{children}</a> : <span>{children}</span>,
      }}>{markdown}</Markdown>
      <ReportCharts snapshot={snapshot} hiddenImageNames={hiddenChartNames} />

    </div> : <>{loadError && <p className="report-document-note">{loadError}</p>}{fallback}<ReportCharts snapshot={snapshot} /></>}
  </>;
}
