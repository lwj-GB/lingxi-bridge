import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api, type Person } from "./api";
import { PersonInterview } from "./PersonInterview";
const person = {id:"p1", display_name:"小林（虚构）", relation_to_user:"朋友"} as Person;
afterEach(() => vi.restoreAllMocks());
it("逐题回答、未知和跳过后，一次提交并保留原文文件", async () => {
  const save = vi.spyOn(api,"savePersonInterview").mockResolvedValue({sources:[],replayed:false});
  const close = vi.fn(); const updated = vi.fn().mockResolvedValue(undefined); const user = userEvent.setup();
  render(<StrictMode><PersonInterview person={person} workspacePath="/fictional" onSaved={updated} onClose={close} /></StrictMode>);
  await user.type(screen.getByLabelText("本题回答"),"一起参加过读书会。"); await user.click(screen.getByRole("button",{name:"记下回答，下一题"}));
  await user.click(screen.getByRole("button",{name:"不知道"})); await user.click(screen.getByRole("button",{name:"跳过"}));
  await user.click(screen.getByRole("button",{name:"直接去添加资料"}));
  const file = new File(["原话🍵\n保留换行\n"],"资料.md",{type:"text/markdown"}); Object.defineProperty(file,"text",{value:async()=>"原话🍵\n保留换行\n"});
  await user.upload(screen.getByLabelText("选择文本资料"),file); await screen.findByText("资料.md");
  expect(save).not.toHaveBeenCalled(); await user.click(screen.getByRole("button",{name:"保存补充并完成"}));
  await waitFor(()=>expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith("p1",expect.objectContaining({answers:[expect.objectContaining({answer:"一起参加过读书会。",status:"answered"}),expect.objectContaining({answer:"还不知道",status:"unknown"})],attachments:[{name:"资料.md",text:"原话🍵\n保留换行\n"}]}));
});
it("全部跳过不创建虚构资料，基础人物继续保留", async()=>{
  const save=vi.spyOn(api,"savePersonInterview");const close=vi.fn();const user=userEvent.setup();
  render(<PersonInterview person={person} workspacePath="/fictional" onSaved={vi.fn()} onClose={close}/>);
  await user.click(screen.getByRole("button",{name:"直接去添加资料"}));await user.click(screen.getByRole("button",{name:"暂不添加，完成建档"}));
  expect(close).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();
});
it("失败保留回答，重试沿用请求编号；取消需明确放弃",async()=>{
  const save=vi.spyOn(api,"savePersonInterview").mockRejectedValueOnce(new Error("服务暂不可用")).mockResolvedValue({sources:[],replayed:true});
  const close=vi.fn();const user=userEvent.setup();render(<PersonInterview person={person} workspacePath="/fictional" onSaved={vi.fn().mockResolvedValue(undefined)} onClose={close}/>);
  await user.type(screen.getByLabelText("本题回答"),"喜欢散步。");await user.click(screen.getByRole("button",{name:"直接去添加资料"}));await user.click(screen.getByRole("button",{name:"保存补充并完成"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("服务暂不可用");expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button",{name:/关闭补充了解/}));expect(screen.getByRole("dialog",{name:"放弃未保存的补充"})).toBeInTheDocument();await user.click(screen.getByRole("button",{name:"继续填写"}));
  await user.click(screen.getByRole("button",{name:"保存补充并完成"}));await waitFor(()=>expect(close).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1].request_id).toBe(save.mock.calls[1][1].request_id);
});
