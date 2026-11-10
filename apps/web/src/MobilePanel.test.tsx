import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobilePanel } from "./MobilePanel";
import { mobileApi, type MobileArchive, type MobileArchiveSummary, type ReceiverStatus } from "./mobile-api";

vi.mock("./LocalAudioTools", () => ({ LocalAudioTools: () => null }));
vi.mock("./mobile-api", () => ({ mobileApi: { list: vi.fn(), read: vi.fn(), receiver: vi.fn(), startReceiver: vi.fn(), stopReceiver: vi.fn(), importArchive: vi.fn() } }));
const off: ReceiverStatus = { active: false, addresses: [], code: null, expiresAt: null, receivedCount: 0 };
const on: ReceiverStatus = { active: true, addresses: ["http://192.168.1.12:18188"], code: "12345678", expiresAt: "2026-11-10T12:00:00Z", receivedCount: 0 };
const day = Date.parse("2026-11-10T02:00:00Z");
function archive(text = "合成测试原话", date = "2026-11-10"): MobileArchive {
  return { type: "lingxi_mobile_archive", version: 1, deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generatedAt: day, date, timeZone: "Asia/Shanghai", lines: [{ id: "line1", localId: 1, segmentId: 1, startAt: day, endAt: day + 3000, speaker: "测试者", text }], todos: [] };
}
function summary(id: string, date = "2026-11-10"): MobileArchiveSummary { return { id, date, deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generatedAt: day, receivedAt: "2026-11-10T02:00:00Z", lineCount: 1, todoCount: 0, hasJournal: false }; }
function withJournal(value: MobileArchive, markdown: string): MobileArchive {
  return { ...value, journal: { markdown, statistics: {
    usage: { state: "PermissionRequired", message: "使用统计尚未授权", apps: [], timeline: [] },
    notifications: { state: "Ready", message: "仅有已观测时段", observedFromMillis: day, observedUntilMillis: day + 3600000, coveredMillis: 3600000, total: 2, apps: [{ packageName: "example.synthetic", label: "测试应用", count: 2 }], hourly: [{ hourStartMillis: day, count: 2 }] },
    health: { availability: "Available", steps: { state: "NotAuthorized", value: null, sourcePackages: [], message: "步数尚未授权" }, distanceMeters: { state: "NoData", value: null, sourcePackages: [], message: "来源尚未提供记录" }, exerciseMinutes: { state: "Available", value: 0, sourcePackages: ["example.synthetic.health"], message: null }, hourlySteps: { state: "NoData", value: null, sourcePackages: [], message: null }, sessions: { state: "NoData", value: null, sourcePackages: [], message: null } },
  } } };
}
beforeEach(() => {
  vi.setSystemTime(new Date("2026-11-10T04:00:00Z"));
  vi.mocked(mobileApi.list).mockReset().mockResolvedValue({ archives: [] });
  vi.mocked(mobileApi.receiver).mockReset().mockResolvedValue(off);
  vi.mocked(mobileApi.read).mockReset().mockResolvedValue({ id: "old", archive: archive() });
  vi.mocked(mobileApi.startReceiver).mockReset().mockResolvedValue(on);
  vi.mocked(mobileApi.stopReceiver).mockReset().mockResolvedValue(off);
  vi.mocked(mobileApi.importArchive).mockReset().mockResolvedValue({ id: "old", status: "exists" });
});
afterEach(() => { vi.useRealTimers(); });

it("未打开工作区时不读手机资料或启动接收", () => {
  render(<MobilePanel workspacePath={null} />);
  expect(screen.getByText(/先打开电脑工作区/)).toBeVisible();
  expect(mobileApi.list).not.toHaveBeenCalled();
  expect(mobileApi.receiver).not.toHaveBeenCalled();
});

it("归档原文按时段显示，Markdown不执行HTML或加载外部图片", async () => {
  const value = withJournal(archive("<script>window.attack=1</script>"), "# 合成日记\n\n|事项|内容|\n|---|---|\n|会议|合成测试|\n\n![跟踪](https://tracker.example/pixel.png)\n\n[网址](javascript:alert(1))\n\n<script>window.attack=2</script>");
  vi.mocked(mobileApi.list).mockResolvedValue({ archives: [summary("old")] });
  vi.mocked(mobileApi.read).mockResolvedValue({ id: "old", archive: value });
  render(<MobilePanel workspacePath="/fictional/mobile" />);
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  expect(await screen.findByText("<script>window.attack=1</script>")).toBeVisible();
  expect(screen.getByText("10:00–10:00")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "AI 笔记" }));
  expect(screen.getByRole("heading", { name: "合成日记" })).toBeVisible();
  expect(screen.getByRole("table")).toHaveTextContent("会议合成测试");
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("a[href] ")).toBeNull();
});

it("接收开启时轮询新包，保留正在阅读的旧日期，离页清理轮询", async () => {
  vi.useRealTimers();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T04:00:00Z"));
  vi.mocked(mobileApi.receiver).mockResolvedValue(on);
  vi.mocked(mobileApi.list).mockResolvedValueOnce({ archives: [summary("old", "2026-11-09")] }).mockResolvedValue({ archives: [summary("new"), summary("old", "2026-11-09")] });
  vi.mocked(mobileApi.read).mockImplementation(async id => ({ id, archive: archive(id === "old" ? "旧日原文" : "新日原文") }));
  let unmount: () => void = () => undefined;
  await act(async () => { ({ unmount } = render(<MobilePanel workspacePath="/fictional/poll" />)); });
  await act(async () => { fireEvent.change(screen.getByLabelText("手机记录日期"), { target: { value: "2026-11-09" } }); });
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  expect(screen.getByText("旧日原文")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText("2 天 / 2 份")).toBeVisible();
  expect(screen.getByText("旧日原文")).toBeVisible();
  expect(mobileApi.read).not.toHaveBeenCalledWith("new");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "今天" })); });
  expect(screen.getByText("新日原文")).toBeVisible();
  unmount();
  const calls = vi.mocked(mobileApi.list).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(mobileApi.list).toHaveBeenCalledTimes(calls);
});

it("切换工作区后忽略旧工作区的迟到归档正文", async () => {
  let resolveOld: (value: { id: string; archive: MobileArchive }) => void = () => undefined;
  vi.mocked(mobileApi.list).mockResolvedValueOnce({ archives: [summary("old")] }).mockResolvedValue({ archives: [summary("new")] });
  vi.mocked(mobileApi.read).mockImplementation(id => id === "old" ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ id, archive: archive("新工作区原文") }));
  const { rerender } = render(<MobilePanel workspacePath="/fictional/old" />);
  await waitFor(() => expect(mobileApi.read).toHaveBeenCalledWith("old"));
  rerender(<MobilePanel workspacePath="/fictional/new" />);
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  expect(await screen.findByText("新工作区原文")).toBeVisible();
  await act(async () => { resolveOld({ id: "old", archive: archive("不应出现的旧工作区原文") }); });
  expect(screen.queryByText("不应出现的旧工作区原文")).not.toBeInTheDocument();
});

it("接收服务失败不隐藏已归档内容，空白页不造原文或日记", async () => {
  vi.mocked(mobileApi.receiver).mockRejectedValue(new Error("接收状态暂时不可用"));
  const { unmount } = render(<MobilePanel workspacePath="/fictional/empty" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("接收状态暂时不可用");
  expect(screen.getByText(/还没有手机记录/)).toBeVisible();
  unmount();
  vi.mocked(mobileApi.list).mockResolvedValue({ archives: [summary("old")] });
  render(<MobilePanel workspacePath="/fictional/has-record" />);
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  expect(await screen.findByText("合成测试原话")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "AI 笔记" }));
  expect(screen.getByText(/这份归档没有日记或 AI 笔记/)).toBeVisible();
});

it("显式JSON导入保持原始文本并区分重复，错误文件不发请求", async () => {
  vi.mocked(mobileApi.list).mockResolvedValue({ archives: [summary("old")] });
  render(<MobilePanel workspacePath="/fictional/import" />);
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  await screen.findByText("合成测试原话");
  const raw = '  {"type":"lingxi_mobile_archive","version":1}  \n';
  const file = new File([raw], "手机归档.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => raw });
  fireEvent.change(screen.getByLabelText("导入手机归档 JSON"), { target: { files: [file] } });
  expect(await screen.findByRole("status")).toHaveTextContent("没有重复新增");
  expect(mobileApi.importArchive).toHaveBeenCalledWith(raw, "/fictional/import");
  const invalid = new File(["{}"], "配置.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("导入手机归档 JSON"), { target: { files: [invalid] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("请选择手机导出的 JSON 归档文件");
  expect(mobileApi.importArchive).toHaveBeenCalledTimes(1);
});

it("当天统计区分未授权、缺记录和真实零，不补未观测小时", async () => {
  vi.mocked(mobileApi.list).mockResolvedValue({ archives: [summary("old")] });
  vi.mocked(mobileApi.read).mockResolvedValue({ id: "old", archive: withJournal(archive(), "合成测试日记") });
  render(<MobilePanel workspacePath="/fictional/statistics" />);
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  await screen.findByText("合成测试原话");
  const panel = screen.getByRole("region", { name: "当天统计" });
  expect(within(panel).getByText("尚未授权")).toBeVisible();
  expect(within(panel).getByText("暂无记录")).toBeVisible();
  expect(within(panel).getByText("0 分钟")).toBeVisible();
  expect(within(panel).getByLabelText("已观测小时通知数量").children).toHaveLength(1);
  expect(within(panel).getByText(/实际观测 1 小时 0 分钟/)).toBeVisible();
});


it("开启和停止手机接收绑定当前工作区，防止切库后落到另一工作区", async () => {
  vi.mocked(mobileApi.startReceiver).mockImplementation(async () => { vi.mocked(mobileApi.receiver).mockResolvedValue(on); return on; });
  render(<MobilePanel workspacePath="/fictional/pairing" />);
  await screen.findByText(/还没有手机记录/);
  fireEvent.click(screen.getByRole("button", { name: "开启手机接收" }));
  expect(await screen.findByRole("button", { name: "停止接收" })).toBeVisible();
  expect(mobileApi.startReceiver).toHaveBeenCalledWith("/fictional/pairing");
  fireEvent.click(screen.getByRole("button", { name: "停止接收" }));
  await waitFor(() => expect(mobileApi.stopReceiver).toHaveBeenCalledWith("/fictional/pairing"));
});

it("日期联动清空空日，切回后恢复最新版本且不重复统计", async () => {
  vi.mocked(mobileApi.list).mockResolvedValue({ archives: [{ ...summary("latest"), generatedAt: day + 1000 }, summary("old")] });
  vi.mocked(mobileApi.read).mockImplementation(async id => ({ id, archive: withJournal(archive(id === "latest" ? "最新原文" : "旧原文"), id === "latest" ? "最新日记" : "旧日记") }));
  render(<MobilePanel workspacePath="/fictional/calendar" />);
  fireEvent.click(screen.getByRole("tab", { name: "原文" }));
  await screen.findByText("最新原文");
  expect(mobileApi.read).not.toHaveBeenCalledWith("old");
  expect(within(screen.getByRole("region", { name: "当天统计" })).getByText("4")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "后一天" }));
  expect(screen.queryByText("最新原文")).not.toBeInTheDocument();
  expect(screen.queryByText("最新日记")).not.toBeInTheDocument();
  expect(screen.getByText("当天没有归档统计。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "前一天" }));
  await screen.findByText("最新原文");
  fireEvent.change(screen.getByLabelText("归档版本"), { target: { value: "old" } });
  await screen.findByText("旧原文");
  expect(screen.queryByText("最新原文")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "AI 笔记" }));
  expect(within(screen.getByRole("region", { name: "当日记录" })).getByText("旧日记")).toBeVisible();
});

it("日历选择空日时绑定日期并清空归档统计与日记", async () => {
  render(<MobilePanel workspacePath="/fictional" />);
  await screen.findByRole("button", {name:"选择2026-11-11"});
  fireEvent.click(screen.getByRole("button", {name:"选择2026-11-11"}));
  expect(screen.getByLabelText("手机记录日期")).toHaveValue("2026-11-11");
  expect(screen.getByRole("button", {name:"选择2026-11-11"})).toHaveAttribute("aria-pressed","true");
  expect(within(screen.getByRole("region", {name:"当天统计"})).getByText("当天没有归档统计。")).toBeInTheDocument();
});


it("手机时间线保留标题时间和全部要点，折叠展开且不混入其他章节", async () => {
  vi.mocked(mobileApi.list).mockResolvedValue({ archives: [summary("old")] });
  vi.mocked(mobileApi.read).mockResolvedValue({ id: "old", archive: withJournal(archive(), "## 回顾\n其他回顾\n\n## 时间线\n### 09:00–09:30 项目讨论（工作）\n商定下周复核。\n- 确认设计\n- 准备样例\n\n### 10:00 整理文件（工作）\n归档资料。\n\n## 原话\n不应出现在时间线") });
  render(<MobilePanel workspacePath="/fictional/timeline" />);
  const title = await screen.findByText("09:00–09:30 项目讨论（工作）");
  const item = title.closest("details")!;
  expect(item).not.toHaveAttribute("open");
  fireEvent.click(title);
  expect(item).toHaveAttribute("open");
  expect(within(item).getByText("确认设计")).toBeVisible();
  expect(within(item).getByText("准备样例")).toBeVisible();
  expect(screen.queryByText("不应出现在时间线")).not.toBeInTheDocument();
  expect(screen.queryByText("其他回顾")).not.toBeInTheDocument();
  const splitter = screen.getByRole("separator", { name: "调整统计与阅读高度" });
  fireEvent.keyDown(splitter, { key: "ArrowUp" });
  expect(splitter).toHaveAttribute("aria-valuenow", "48");
  fireEvent.click(title);
  expect(item).not.toHaveAttribute("open");
});
