import { useState } from "react";
import { api, type ReportSnapshot } from "./api";
import "./ReportCharts.css";

export function ReportCharts({ snapshot, hiddenImageNames = [] }: { snapshot: ReportSnapshot; hiddenImageNames?: string[] }) {
  const [failed, setFailed] = useState<string[]>([]);
  if (!snapshot.charts) return null;
  const charts = snapshot.charts;
  return <section className="report-charts" aria-label="本地 R 统计图">
    {(!hiddenImageNames.length || charts.assets.some(asset => asset.kind === "image" && !hiddenImageNames.includes(asset.name))) && <header><h3>本地 R 统计图</h3><span>{charts.source_ids.length} 份来源 · 随报告版本保存</span></header>}
    <div className="report-charts-grid">
      {charts.assets.filter((asset) => asset.kind === "image" && !hiddenImageNames.includes(asset.name)).map((asset) => <figure key={`${snapshot.id}-${asset.name}`}>
        <figcaption>{asset.title}</figcaption>
        {failed.includes(`${snapshot.id}/${asset.name}`) ? <p role="alert">图表文件无法读取或完整性校验失败，请刷新并核对附件。</p> :
          <a href={api.reportAssetUrl(snapshot.id, asset.name)} target="_blank" rel="noreferrer" aria-label={`查看原尺寸${asset.title}`}>
            <img src={api.reportAssetUrl(snapshot.id, asset.name)} alt={asset.title} loading="lazy" onError={() => setFailed((items) => [...items, `${snapshot.id}/${asset.name}`])} />
          </a>}
      </figure>)}
    </div>
    <details>
      <summary>统计范围、方法与复现文件</summary>
      <p>仅统计本报告证据关联的完整文字材料，在本机由固定 R 脚本绘制，不修改来源原件。中文词频为去除停用词后的重复词组线索，不等同于精确分词。</p>
      {charts.frequency_mode === "speaker_totals" && <p>日期信息不完整，展示说话人记录数量，不推断时间趋势。</p>}
      {!!charts.missing_information.length && <ul>{charts.missing_information.map((item) => <li key={item}>{item}</li>)}</ul>}
      <nav aria-label="下载图表复现文件">
        {charts.assets.map((asset) => <a key={asset.name} href={api.reportAssetUrl(snapshot.id, asset.name)} download={asset.name}>{asset.title}</a>)}
      </nav>
      <p>下载两份 CSV 与固定 R 脚本至同一目录；运行方式、R/ggplot2 版本、来源哈希和文件哈希见完整性清单。</p>
    </details>
  </section>;
}
