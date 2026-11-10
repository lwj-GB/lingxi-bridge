import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LocalAudioTools } from "./LocalAudioTools";
import { localAudioApi } from "./local-audio-api";
vi.mock("./local-audio-api",()=>({localAudioApi:{speechStatus:vi.fn(),voiceStatus:vi.fn(),transcribe:vi.fn(),compare:vi.fn()}}));
beforeEach(()=>{
  vi.resetAllMocks();
  vi.mocked(localAudioApi.speechStatus).mockResolvedValue({ready:true,engine:"sherpa-onnx",model:"sensevoice",local_only:true,missing:[],max_bytes:67108864,max_duration_seconds:1800});
  vi.mocked(localAudioApi.voiceStatus).mockResolvedValue({available:true,model_present:true,dependencies_present:true,engine:"CAM++",mode:"compare",registered_self:false,note:""});
});
it("只把明确选择的文件送本机转写并显示返回原文",async()=>{
 render(<LocalAudioTools/>);const file=new File(["synthetic"],"test.webm",{type:"audio/webm"});
 vi.mocked(localAudioApi.transcribe).mockResolvedValue({text:"固定虚构原文",duration_seconds:2,elapsed_seconds:.1,engine:"sherpa",model:"sensevoice",local_only:true});
 fireEvent.change(screen.getByLabelText("选择音频"),{target:{files:[file]}});
 await waitFor(()=>expect(screen.getByRole("button",{name:"开始本地转写"})).toBeEnabled());
 fireEvent.click(screen.getByRole("button",{name:"开始本地转写"}));
 expect(await screen.findByDisplayValue("固定虚构原文")).toBeInTheDocument();expect(localAudioApi.transcribe).toHaveBeenCalledWith(file);
});
it("声纹比较须选两段并确认单人裁剪，不把相似度当身份",async()=>{
 render(<LocalAudioTools/>);const a=new File(["a"],"a.wav"),b=new File(["b"],"b.wav");
 vi.mocked(localAudioApi.compare).mockResolvedValue({similarity:.8,model_sha256:"fake",dimension:192,reference_seconds:2,candidate_seconds:2,processing:"local_cpu",persisted:false,note:""});
 fireEvent.change(screen.getByLabelText("参考单人片段"),{target:{files:[a]}});fireEvent.change(screen.getByLabelText("待比较单人片段"),{target:{files:[b]}});
 expect(screen.getByRole("button",{name:"比较两段声音"})).toBeDisabled();fireEvent.click(screen.getByRole("checkbox"));
 await waitFor(()=>expect(screen.getByRole("button",{name:"比较两段声音"})).toBeEnabled());fireEvent.click(screen.getByRole("button",{name:"比较两段声音"}));
 expect(await screen.findByRole("status")).toHaveTextContent("0.800");expect(screen.getByRole("status")).toHaveTextContent("不是身份置信度");expect(localAudioApi.compare).toHaveBeenCalledWith(a,b);
});
it("本地处理失败保留文件可重试，不造成功原文",async()=>{
 render(<LocalAudioTools/>);vi.mocked(localAudioApi.transcribe).mockRejectedValue(new Error("音频格式不可用"));
 fireEvent.change(screen.getByLabelText("选择音频"),{target:{files:[new File(["x"],"bad.wav")]}});
 await waitFor(()=>expect(screen.getByRole("button",{name:"开始本地转写"})).toBeEnabled());fireEvent.click(screen.getByRole("button",{name:"开始本地转写"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("音频格式不可用");expect(screen.queryByLabelText("转写原文")).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"开始本地转写"})).toBeEnabled();
});
