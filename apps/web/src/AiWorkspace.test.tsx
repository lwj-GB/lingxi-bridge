import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AiWorkspace } from "./AiWorkspace";
import { api, type Person, type SourceRecord } from "./api";

const person = {id: "p1", display_name: "小刘（虚构）", relation_to_user: "朋友"} as Person;
const source = {id: "s1", title: "茶", person_ids: ["p1"], source_kind: "text"} as SourceRecord;
const props = { language: "zh-CN" as const, openedPath: "/fictional", people: [person], sources: [source],
  executors: [{engine: "codex", name: "Codex", available: true, path: "/test", version: "test", degraded_reason: null}] as Parameters<typeof AiWorkspace>[0]["executors"],
  textEngine: "codex" as const, conversationId: "c1", onConversationChange: vi.fn(),
  onOpenWorkspace: vi.fn(), onOpenPeople: vi.fn(), onPrepareAutofill: vi.fn(),
  onStartLive: vi.fn(), onPrepareReport: vi.fn(), onWorkspaceChanged: vi.fn() };
afterEach(() => vi.restoreAllMocks());

it("直接回答并保留当前人物材料范围，不跳转报告", async () => {
  const request = vi.spyOn(api, "answerQuestion").mockResolvedValue({ answer: "可以送茶杯。他喜欢喝茶。", source_ids: ["s1"], person_id: "p1" });
  const user = userEvent.setup();
  render(<AiWorkspace {...props} />);
  await user.type(screen.getByRole("textbox", {name: "告诉 AI 你想完成什么"}), "送什么？");
  await user.click(screen.getByRole("button", {name: "发送"}));
  expect(await screen.findByText("可以送茶杯。他喜欢喝茶。")).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith({question:"送什么？",person_id:"p1",source_ids:["s1"],engine:"codex"});
  expect(props.onPrepareReport).not.toHaveBeenCalled();
});

it("输入在下、消息在上，连续问答保留双方消息且不显示任务按钮", async () => {
  vi.spyOn(api, "answerQuestion").mockResolvedValue({ answer: "先问偏好。", source_ids: ["s1"], person_id: "p1" });
  const user = userEvent.setup();
  render(<AiWorkspace {...props} />);
  expect(screen.queryByRole("button", { name: "新增人物" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "问一问" })).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox"), "第一问"); await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText("先问偏好。")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("");
  await user.type(screen.getByRole("textbox"), "第二问"); await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getAllByLabelText("AI 回复")).toHaveLength(2));
  expect(screen.getAllByLabelText("我的消息")).toHaveLength(2);
});

it("API助手展示目标地址并只发送当前选择的人物材料", async () => {
  vi.spyOn(api, "getDirectModelSettings").mockResolvedValue({ base_url: "https://model.example.test/v1", model: "test-model", key_env: "", has_key: true, configured: true, key_storage: "session" });
  const request = vi.spyOn(api, "answerQuestion").mockResolvedValue({ answer: "材料明确提到喝茶，可以先问偏好的茶类。", source_ids: ["s1"], person_id: "p1" });
  const user = userEvent.setup();
  render(<AiWorkspace {...props} textEngine="api" executors={[]} />);
  expect(await screen.findByText(/API · test-model/)).toBeInTheDocument();
  await user.click(screen.getByText(/API · test-model/));
  expect(screen.getByText(/发送到 https:\/\/model.example.test\/v1/)).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "告诉 AI 你想完成什么" }), "应该先问什么？");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText("材料明确提到喝茶，可以先问偏好的茶类。")).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith({ question: "应该先问什么？", person_id: "p1", source_ids: ["s1"], engine: "api" });
});

it("API配置未就绪时不发送材料", async () => {
  vi.spyOn(api, "getDirectModelSettings").mockResolvedValue({ base_url: "", model: "", key_env: "", has_key: false, configured: false, key_storage: "none" });
  const request = vi.spyOn(api, "answerQuestion");
  const user = userEvent.setup();
  render(<AiWorkspace {...props} textEngine="api" />);
  await user.type(screen.getByRole("textbox", { name: "告诉 AI 你想完成什么" }), "分析这份资料");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请先在设置中配置 API 地址、模型与密钥");
  expect(request).not.toHaveBeenCalled();
});

it("全局人物变化时助手使用新人物材料，不沿用旧对象范围", async () => {
  const request = vi.spyOn(api, "answerQuestion").mockResolvedValue({ answer: "只分析当前人物材料。", source_ids: ["s2"], person_id: "p2" });
  const second = { ...person, id: "p2", display_name: "陈溪（虚构）" };
  const otherSource = { ...source, id: "s2", title: "会面安排", person_ids: ["p2"] };
  const user = userEvent.setup();
  const view = render(<AiWorkspace {...props} people={[person, second]} sources={[source, otherSource]} contextPersonId="p1" />);
  await user.type(screen.getByRole("textbox", { name: "告诉 AI 你想完成什么" }), "有什么需要核对？");
  view.rerender(<AiWorkspace {...props} people={[person, second]} sources={[source, otherSource]} contextPersonId="p2" />);
  await waitFor(() => expect(screen.getByLabelText("当前人物")).toHaveValue("p2"));
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ question: "有什么需要核对？", person_id: "p2", source_ids: ["s2"], engine: "codex" }));
});

it("人物切换后丢弃旧人物的延迟回答", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.answerQuestion>>) => void;
  vi.spyOn(api, "answerQuestion").mockReturnValue(new Promise(done => { resolve = done; }));
  const history = vi.fn();
  const second = { ...person, id: "p2", display_name: "陈溪（虚构）" };
  const user = userEvent.setup();
  const view = render(<AiWorkspace {...props} onConversationChange={history} people={[person, second]} contextPersonId="p1" />);
  await user.type(screen.getByRole("textbox", { name: "告诉 AI 你想完成什么" }), "需要注意什么？");
  await user.click(screen.getByRole("button", { name: "发送" }));
  view.rerender(<AiWorkspace {...props} onConversationChange={history} people={[person, second]} contextPersonId="p2" />);
  resolve({ answer: "旧人物延迟回答", source_ids: ["s1"], person_id: "p1" });
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  expect(screen.queryByText("旧人物延迟回答")).not.toBeInTheDocument();
  expect(history).not.toHaveBeenCalled();
});

it("切换到空工作区后清除旧对话", async () => {
  vi.spyOn(api, "answerQuestion").mockResolvedValue({answer: "仅属于A的回答", source_ids: ["s1"], person_id: "p1"});
  const user = userEvent.setup();
  const view = render(<AiWorkspace {...props} contextPersonId="p1" />);
  await user.type(screen.getByRole("textbox"), "A的资料"); await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText("仅属于A的回答")).toBeInTheDocument();
  view.rerender(<AiWorkspace {...props} openedPath="/empty-b" people={[]} sources={[]} contextPersonId="" />);
  expect(screen.queryByText("仅属于A的回答")).not.toBeInTheDocument();
  expect(screen.queryByText("A的资料")).not.toBeInTheDocument();
});
