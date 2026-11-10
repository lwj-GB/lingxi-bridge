import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";

const props = { activeView: "people" as const, pageLabel: "人物", openedPath: "/fictional", people: [], events: [], sources: [], reports: [], subjectType: "person" as const,
  onSubjectTypeChange: vi.fn(), navigation: null, content: <p>原有阅读内容</p>, inspector: null, assistant: null, live: null, topbar: null, overlays: null,
  onLiveAnalysisContainer: vi.fn(), onNavigate: vi.fn(), onNewPerson: vi.fn(), onNewEvent: vi.fn(), onRefresh: vi.fn(), refreshing: false,
  onSelectPerson: vi.fn(), onBrowsePerson: vi.fn(), onOpenSource: vi.fn(), onOpenReport: vi.fn(), onSelectEvent: vi.fn(), onRun: vi.fn(), onPrepareReport: vi.fn(), runEnabled: false,
  inspectedEvidenceId: "", currentReportTopicId: "", onInspectEventQuote: vi.fn(), onRenameEventNode: vi.fn() };
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
it("菜单互斥，点击空白、执行动作或Esc均收起", async () => {
  const user = userEvent.setup(); render(<Workbench {...props} />);
  const file = screen.getByText("文件").closest("details")!;
  const view = screen.getByText("视图").closest("details")!;
  await user.click(screen.getByText("文件")); expect(file.open).toBe(true);
  await user.click(screen.getByText("视图")); expect(file.open).toBe(false); expect(view.open).toBe(true);
  await user.click(screen.getByText("原有阅读内容")); expect(view.open).toBe(false);
  await user.click(screen.getByText("文件")); await user.keyboard("{Escape}"); expect(file.open).toBe(false);
  await user.click(screen.getByText("文件")); await user.click(screen.getByRole("button", { name: "新建人物" })); expect(file.open).toBe(false); expect(props.onNewPerson).toHaveBeenCalledOnce();
});
it("加号明确选择人物或事件，背景内容继续挂载", async () => {
  const user = userEvent.setup(); render(<Workbench {...props} />);
  await user.click(screen.getByRole("button", { name: /^新建$/ }));
  expect(screen.getByRole("dialog", { name: "新建" })).toBeInTheDocument();
  expect(screen.getByText("原有阅读内容")).toBeInTheDocument();
  await user.click(screen.getByRole("dialog").querySelectorAll("button")[2]);
  expect(props.onNewEvent).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("四窗格全部关闭后重挂载仍保持关闭，并能从菜单恢复", async () => {
  const user = userEvent.setup(); const view = render(<Workbench {...props} />);
  for (const name of ["关闭人物窗格", "关闭结果窗格", "关闭依据窗格", "关闭AI窗格"]) await user.click(screen.getByRole("button", { name }));
  const saved = JSON.parse(localStorage.getItem("lingxi.workbench-layout.v1")!);
  expect(saved).toMatchObject({ personOpen: false, resultsOpen: false, contextOpen: false, assistantOpen: false });
  view.unmount(); render(<Workbench {...props} />);
  expect(screen.getByLabelText("结果工作区")).not.toBeVisible();
  expect(screen.getByLabelText("AI 工作区")).not.toBeVisible();
  await user.click(screen.getByText("视图")); await user.click(screen.getByRole("button", { name: "恢复布局" }));
  expect(screen.getByRole("region", { name: "结果工作区" })).toBeVisible();
});
it("手机入口打开手机收件页，AI设置有真实回调", async () => {
  const user = userEvent.setup(); render(<Workbench {...props} />);
  await user.click(screen.getByRole("button", { name: "手机模块" })); expect(props.onNavigate).toHaveBeenCalledWith("mobile");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "AI模型设置" })); expect(props.onNavigate).toHaveBeenCalledWith("settings");
});

it("手机看板隐藏通用目录人物，保留会谈挂载与其他页面布局", () => {
  const view = render(<Workbench {...props} live={<input aria-label="持续录音状态" defaultValue="正在录音" />} />);
  fireEvent.click(screen.getByRole("button", { name: "关闭结果窗格" }));
  const saved = localStorage.getItem("lingxi.workbench-layout.v1");
  const recording = screen.getByLabelText("持续录音状态");
  view.rerender(<Workbench {...props} activeView="mobile" live={<input aria-label="持续录音状态" defaultValue="正在录音" />} />);
  expect(screen.getByLabelText("资料目录")).not.toBeVisible();
  expect(screen.getByLabelText("人物上下文")).not.toBeVisible();
  expect(screen.getByLabelText("结果工作区")).toBeVisible();
  expect(screen.getByLabelText("持续录音状态")).toBe(recording);
  expect(localStorage.getItem("lingxi.workbench-layout.v1")).toBe(saved);
  view.rerender(<Workbench {...props} live={<input aria-label="持续录音状态" defaultValue="正在录音" />} />);
  expect(screen.getByLabelText("资料目录")).toBeVisible();
  expect(screen.getByLabelText("结果工作区")).not.toBeVisible();
});
