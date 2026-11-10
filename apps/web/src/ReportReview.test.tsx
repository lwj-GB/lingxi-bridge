import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ReportReview } from "./ReportReview";
import type { AnalysisClaim, Person, ReportResponse } from "./api";
const first: AnalysisClaim={claim_type:"observation",text:"材料说喜欢散步。",evidence_ids:["e1"]};
const second: AnalysisClaim={claim_type:"hypothesis",text:"可能更喜欢安静活动。",evidence_ids:["e1"],alternatives:["也可能只限当天。"],uncertainty:"high"};
const report={topic:{person_ids:["p1"]},snapshot:{id:"snapshot1"},analysis:{claims:[first,second]}} as ReportResponse;
const person={id:"p1",display_name:"小林",profile_sections:[]} as unknown as Person;
it("保存成功自动进入下一题，跳过后可重新查看，正文不改写",async()=>{
 const save=vi.fn().mockResolvedValue(true);const user=userEvent.setup();
 function Harness(){const [reviews,setReviews]=useState<Record<string,"accepted"|"rejected">>({});return <ReportReview report={report} people={[person]} personId="p1" reviews={reviews} busy={false} onPersonChange={vi.fn()} onEvidence={vi.fn()} onReview={async(key,claim,correct)=>{await save(key,claim,correct);setReviews({...reviews,[key]:correct?"accepted":"rejected"});return true;}}/>;}
 render(<Harness/>);expect(screen.getByText("第 1 / 2 题 · 待核对描述")).toBeInTheDocument();await user.click(screen.getByRole("button",{name:"准确，保留"}));
 expect(await screen.findByText("第 2 / 2 题 · 一种推测")).toBeInTheDocument();await user.click(screen.getByRole("button",{name:"跳过"}));expect(screen.getByText("本轮核对结束")).toBeInTheDocument();await user.click(screen.getByRole("button",{name:"重新查看跳过的题"}));expect(screen.getByText("第 2 / 2 题 · 一种推测")).toBeInTheDocument();expect(save).toHaveBeenCalledOnce();
});
it("失败留在原题，重开报告继承已保存核对",async()=>{
 const user=userEvent.setup();const save=vi.fn().mockResolvedValue(false);const props={report,people:[person],personId:"p1",reviews:{},busy:false,onPersonChange:vi.fn(),onEvidence:vi.fn(),onReview:save};
 const view=render(<ReportReview {...props}/>);await user.click(screen.getByRole("button",{name:"不准确，退回"}));expect(await screen.findByRole("alert")).toHaveTextContent("没有保存");expect(screen.getByText("第 1 / 2 题 · 待核对描述")).toBeInTheDocument();
 const saved={...person,profile_sections:[{id:"entry",section:"user_observations",label:"AI 候选描述",value:first.text,origin:"ai",confirmation_status:"rejected",evidence_ids:["e1"]}]} as Person;
 view.rerender(<ReportReview {...props} people={[saved]}/>);expect(screen.getByText("第 2 / 2 题 · 一种推测")).toBeInTheDocument();expect(screen.getByText("已记录 1 / 2")).toBeInTheDocument();
});
