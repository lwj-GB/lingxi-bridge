import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api, type ReportSnapshot } from "./api";
import { ReportDocument } from "./ReportDocument";
const snapshot = { id: "s1", charts: { manifest_path: "attachments/reports/s1/manifest.json", frequency_mode: "daily", source_ids: ["source1"], missing_information: [], assets: [{ name: "frequency.png", title: "图一 互动频率", kind: "image", mime_type: "image/png", sha256: "a".repeat(64) }] } } as unknown as ReportSnapshot;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("安全渲染Markdown表格与本地R图，图文统一且不重复图片", async () => {
  vi.spyOn(api, "getReportDocument").mockResolvedValue({ is_editable_copy: true, source_snapshot_id: "s1", workspace_path: "/tmp/test-vault", relative_path: "exports/reports/s1.md", file_hash: "hash", body: "# 沟通观察\n\n一句清楚的话。\n\n|维度|观察|\n|---|---|\n|需要|待确认|\n\n![](../../attachments/reports/s1/frequency.png)\n\n![[attachments/reports/s1/frequency.png]]\n\n![越界图](../../attachments/reports/other/frequency.png)\n\n![外部图](https://tracking.example/x.png)\n\n![任意文件](file:///etc/passwd)\n\n<script>window.attack=true</script>\n\n<img src='https://tracking.example/html.png'>" });
  render(<ReportDocument snapshot={snapshot} fallback={<button>准确，保留</button>} />);
  expect(await screen.findByRole("heading", { name: "沟通观察" })).toBeVisible();
  expect(screen.getByRole("table")).toHaveTextContent("需要待确认");
  const images = screen.getAllByRole("img");
  expect(images).toHaveLength(1);
  expect(images[0]).toHaveAttribute("src", api.reportAssetUrl("s1", "frequency.png"));
  expect(screen.getByText(/图一 互动频率 · 来源/)).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByText("结论复核与原文依据")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "准确，保留" })).not.toBeInTheDocument();
});

it("PDF导出失败展示真实服务错误，不提示成功", async () => {
  vi.spyOn(api, "getReportDocument").mockRejectedValue(new Error("missing"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "PDF字体不可用" } }), { status: 503 })));
  render(<ReportDocument snapshot={snapshot} fallback={<p>结构化结论</p>} />);
  fireEvent.click(screen.getByRole("button", { name: "导出 PDF" }));
  fireEvent.click(screen.getByRole("button", { name: "选择位置并导出" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("PDF字体不可用");
  expect(screen.getByText("结构化结论")).toBeInTheDocument();
});

it("桌面定位仅提交后端核验的阅读副本路径", async () => {
  vi.spyOn(api, "getReportDocument").mockResolvedValue({ is_editable_copy: true, source_snapshot_id: "s1", workspace_path: "/tmp/test-vault", relative_path: "exports/reports/s1.md", file_hash: "hash", body: "# 报告" });
  vi.spyOn(api, "getReportFile").mockResolvedValue({ workspace_path: "/tmp/test-vault", relative_path: "exports/reports/s1.md" });
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  render(<ReportDocument snapshot={snapshot} fallback={null} />);
  fireEvent.click(screen.getByRole("button", { name: "在访达中显示" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reveal_report_markdown", { workspacePath: "/tmp/test-vault", relativePath: "exports/reports/s1.md" }));
});

it("下载当前阅读稿Markdown的真实字节，并在显式刷新后重读人工编辑稿", async () => {
  const document = { is_editable_copy: true, source_snapshot_id: "s1", workspace_path: "/tmp/test-vault", relative_path: "exports/reports/s1.md", file_hash: "hash", body: "# 原稿" };
  const read = vi.spyOn(api, "getReportDocument").mockResolvedValueOnce(document).mockResolvedValue({ ...document, body: "# 人工修改的标题" });
  const createObjectURL = vi.fn().mockReturnValue("blob:download");
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# 人工修改的标题", { headers: { "Content-Type": "text/markdown" } })));
  const refresh = vi.fn().mockImplementation(async () => { window.dispatchEvent(new Event("lingxi:workspace-refreshed")); });
  render(<ReportDocument snapshot={snapshot} fallback={null} onRefresh={refresh} />);
  expect(await screen.findByRole("heading", { name: "原稿" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "刷新阅读稿" }));
  expect(await screen.findByRole("heading", { name: "人工修改的标题" })).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "下载 Markdown" }));
  fireEvent.click(screen.getByRole("button", { name: "选择位置并导出" }));
  await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob)));
  expect(fetch).toHaveBeenCalledWith(api.reportDownloadUrl(snapshot.id, "markdown"));
});

it("旧报告的JSON代码块继续使用可读结论，避免向读者展示内部JSON", async () => {
  vi.spyOn(api, "getReportDocument").mockResolvedValue({ body: '# 旧报告\n\n```json\n{"claims":[]}\n```', is_editable_copy: true, source_snapshot_id: "s1", workspace_path: "/tmp/test", relative_path: "exports/reports/s1.md", file_hash: "hash" });
  render(<ReportDocument snapshot={snapshot} fallback={<p>旧版可读结论</p>} />);
  await waitFor(() => expect(api.getReportDocument).toHaveBeenCalled());
  expect(screen.getByText("旧版可读结论")).toBeVisible();
  expect(screen.queryByText('{"claims":[]}')).not.toBeInTheDocument();
});

it.each([true, false])("桌面原生保存对话框返回%s时准确显示保存或取消", async saved => {
  vi.spyOn(api, "getReportDocument").mockRejectedValue(new Error("missing"));
  const content = "%PDF-1.7\nfictional-test";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(content, { headers: { "Content-Type": "application/pdf" } })));
  const invoke = vi.fn().mockResolvedValue(saved);
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  render(<ReportDocument snapshot={snapshot} fallback={null} />);
  fireEvent.click(screen.getByRole("button", { name: "导出 PDF" }));
  fireEvent.click(screen.getByRole("button", { name: "选择位置并导出" }));
  expect(await screen.findByRole("status")).toHaveTextContent(saved ? "文件已保存。" : "已取消保存。");
  expect(invoke).toHaveBeenCalledWith("save_report_export", { kind: "pdf", suggestedName: "report-s1.pdf", bytes: Array.from(new TextEncoder().encode(content)) });
  expect(anchor).not.toHaveBeenCalled();
  if (!saved) expect(screen.queryByText("文件已保存。")).not.toBeInTheDocument();
});

it("报告正文隐藏来源附录，保留综合文章",async()=>{
 vi.spyOn(api,"getReportDocument").mockResolvedValue({body:"# 完整报告\n\n## 整体情况\n\n基于已有记录，偏好低压力的活动。\n\n## 资料依据\n\n来源1：原始聊天碎片",is_editable_copy:false,source_snapshot_id:"s1",workspace_path:"/fictional",relative_path:"report.md",file_hash:"hash"});
 render(<ReportDocument snapshot={snapshot} fallback={null}/>);expect(await screen.findByText("基于已有记录，偏好低压力的活动。")).toBeVisible();expect(screen.queryByText(/来源1：原始聊天碎片/)).not.toBeInTheDocument();
});
