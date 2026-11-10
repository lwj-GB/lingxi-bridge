# Fixed Lingxi plotting script. Inputs are aggregate CSVs, never source text.
# Reproduce: Rscript --vanilla report_charts.R . daily
library(ggplot2)
args <- commandArgs(trailingOnly=TRUE)
if (length(args) != 2) stop("Expected output directory and frequency mode")
out <- args[[1]]
mode <- args[[2]]
if (!mode %in% c("daily", "speaker_totals")) stop("Invalid mode")
if (Sys.info()[["sysname"]] == "Darwin") {
  grDevices::quartzFonts(lingxi=grDevices::quartzFont(rep("PingFangSC-Regular",4)))
  chart_font <- "lingxi"
  bitmap_type <- "quartz"
} else {
  chart_font <- "sans"
  bitmap_type <- "cairo"
}
base <- theme_minimal(base_size=12,base_family=chart_font) +
  theme(panel.grid.minor=element_blank(),
        panel.grid.major.x=element_blank(),
        panel.grid.major.y=element_line(color="#e0e5eb",linewidth=.35),
        axis.title=element_text(color="#475563"),
        axis.text=element_text(color="#475563"),
        legend.position="top",legend.title=element_blank(),
        plot.title=element_text(size=14,face="plain"),
        plot.subtitle=element_text(size=10,color="#657180"),
        plot.margin=margin(10,20,10,10))
frequency <- read.csv(file.path(out,"frequency.csv"),encoding="UTF-8",check.names=FALSE)
terms <- read.csv(file.path(out,"terms.csv"),encoding="UTF-8",check.names=FALSE)
if (mode == "daily") {
  frequency$date <- as.Date(frequency$date)
  p <- ggplot(frequency,aes(date,count,color=speaker,group=speaker)) +
    geom_line(linewidth=.75) + geom_point(size=1.8) +
    scale_x_date(date_labels="%m/%d") +
    scale_y_continuous(limits=c(0,NA),breaks=scales::breaks_pretty()) +
    labs(title="每日记录频率",subtitle="仅统计所选材料中明确标注日期的记录",
         x="日期",y="记录数 / 条",color=NULL) + base
} else {
  frequency$speaker <- factor(frequency$speaker,levels=rev(frequency$speaker))
  p <- ggplot(frequency,aes(count,speaker)) +
    geom_col(fill="#397ab1",width=.62) +
    geom_text(aes(label=count),hjust=-.2,size=3.3) +
    scale_x_continuous(expand=expansion(mult=c(0,.15))) +
    labs(title="按说话人统计记录",subtitle="日期信息不完整，不绘制时间趋势",
         x="记录数 / 条",y=NULL) + base
}
ggsave(file.path(out,"frequency.png"),p,width=8,height=4.5,dpi=300,bg="white",type=bitmap_type)
if (nrow(terms)) {
  terms$term <- factor(terms$term,levels=rev(terms$term))
  q <- ggplot(terms,aes(count,term)) + geom_col(fill="#5485b1",width=.62) +
    geom_text(aes(label=count),hjust=-.2,size=3.1) +
    scale_x_continuous(expand=expansion(mult=c(0,.15))) +
    labs(title="重复词组与词频线索",subtitle="去除常见停用词；中文词组不等同于精确分词",
         x="出现次数",y=NULL) + base
} else {
  q <- ggplot() + annotate("text",x=0,y=0,label="无符合统计规则的重复词组",
                          family=chart_font,size=4,color="#657180") +
    theme_void(base_family=chart_font) + labs(title="词频线索：无可用数据")
}
ggsave(file.path(out,"terms.png"),q,width=8,height=4.5,dpi=300,bg="white",type=bitmap_type)
