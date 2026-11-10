import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportCharts } from "./ReportCharts";
import { api, type ReportSnapshot } from "./api";

const snapshot: ReportSnapshot = {
  schema_version: "0.1", entity_type: "report_snapshot", id: "snapshot-id", revision: 1,
  created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z",
  topic_id: "topic-id", version: 2, generation_kind: "manual", evidence_ids: ["evidence-id"],
  charts: {
    manifest_path: "attachments/reports/snapshot-id/manifest.json",
    frequency_mode: "speaker_totals", source_ids: ["source-id"],
    missing_information: ["3条统计记录缺少明确日期，改为按说话人计数，不绘制时间趋势。"],
    assets: [
      { name: "frequency.png", title: "记录频率", sha256: "a".repeat(64), mime_type: "image/png", kind: "image" },
      { name: "terms.png", title: "词频线索", sha256: "b".repeat(64), mime_type: "image/png", kind: "image" },
      { name: "frequency.csv", title: "频率数据 CSV", sha256: "c".repeat(64), mime_type: "text/csv", kind: "data" },
      { name: "report_charts.R", title: "固定 R 脚本", sha256: "d".repeat(64), mime_type: "text/plain", kind: "script" },
      { name: "manifest.json", title: "统计方法与完整性清单", sha256: "e".repeat(64), mime_type: "application/json", kind: "manifest" },
    ],
  },
};

describe("report charts", () => {
  it("opens the snapshot assets and explains missing dates and reproducibility", () => {
    render(<ReportCharts snapshot={snapshot} />);
    expect(screen.getByAltText("记录频率")).toHaveAttribute("src", api.reportAssetUrl("snapshot-id", "frequency.png"));
    expect(screen.getByAltText("词频线索")).toBeInTheDocument();
    fireEvent.click(screen.getByText("统计范围、方法与复现文件"));
    expect(screen.getByText("日期信息不完整，展示说话人记录数量，不推断时间趋势。")).toBeVisible();
    expect(screen.getByRole("link", { name: "固定 R 脚本" })).toHaveAttribute("href", api.reportAssetUrl("snapshot-id", "report_charts.R"));
    expect(screen.getByRole("link", { name: "统计方法与完整性清单" })).toHaveAttribute("download", "manifest.json");
  });

  it("reports unavailable or changed image assets instead of showing a broken image", () => {
    render(<ReportCharts snapshot={snapshot} />);
    fireEvent.error(screen.getByAltText("记录频率"));
    expect(screen.getByRole("alert")).toHaveTextContent("完整性校验失败");
    expect(screen.queryByAltText("记录频率")).not.toBeInTheDocument();
  });

  it("keeps old reports with no chart metadata unchanged", () => {
    const { charts: _charts, ...old } = snapshot;
    const view = render(<ReportCharts snapshot={old} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
