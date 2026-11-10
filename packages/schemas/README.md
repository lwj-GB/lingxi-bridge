# 共享 Schema

本目录由总负责人维护，是工作区实体与分析输出的唯一机器可读契约。

`live-session.schema.json` 定义实时会谈 WebSocket 的双向事件。识别器只负责产生
增量文本；转写展示和本地观察分析始终使用同一套事件，不随浏览器或豆包识别器变化。
前端构建会直接从这份 Schema 生成 TypeScript 类型，并在接收事件时用同一份 Schema
做运行期校验；不得另行维护一套手写事件模型。

`chat-analysis.schema.json` 定义一份原始聊天的本地统计、说话人、时段、词频、主题回链
和执行信息；`chat-topics.schema.json` 只定义可选 CLI 的语义主题输出。二者分开是为了
让无模型配置时仍有确定性分析，同时防止 CLI 输出绕过来源回链和不确定性约束。

## 稳定 ID

- 新实体统一使用 RFC 4122 UUID；创建后永不因文件移动、改名或索引重建而改变。
- API 可以生成 UUIDv4/UUIDv7，调用方不得提交带业务含义的临时 ID。
- 引用只保存实体 UUID，不使用文件名作为关联键。

## 工作区布局

```text
workspace.json
people/<person-id>.md
relations/<relation-id>.md
events/<event-id>.md
sources/<source-id>.json
transcripts/<transcript-id>.md
evidence/<evidence-id>.md
reports/<topic-id>.md
reports/snapshots/<snapshot-id>.md
attachments/<source-id>/<original-name>
.lingxi/index.sqlite3
```

Markdown 文件的 YAML frontmatter 必须通过 `entities.schema.json` 对应实体校验；
正文保存用户可读内容。`source` 使用 JSON 保存结构化元数据，原始导入文件保持原字节，
规范化文本不能替代原件。截图确认稿保存为 `transcripts/<id>.md`，在正文中链接
`attachments/<source-id>/<original-name>` 原图；确认稿不会覆盖原图。`.lingxi/index.sqlite3`
是可删除、可重建的派生索引。

## 原子写入与冲突

1. 应用写入同目录临时文件，刷新文件内容后使用原子替换。
2. 新建实体使用排他创建；已有 UUID 或路径一律报冲突。
3. 修改可变记录时必须提交上次读取到的完整文件 SHA-256。
4. 磁盘哈希不一致时返回 `409 workspace_conflict`，保留双方内容，不静默覆盖。
5. 原始附件与 `report_snapshot` 创建后不可改写；修订报告必须创建新快照。
6. “刷新工作区”只校验并重建索引，不自动改写开放文件。

## 报告快照提交

报告首次生成或修订均按以下顺序提交：

1. 验证分析输出及全部 `evidence_ids`。
2. 排他写入新的 `reports/snapshots/<snapshot-id>.md`。
3. 原子创建或更新 `reports/<topic-id>.md`，指向新快照并增加版本。
4. 更新 SQLite 派生索引。

步骤 3 发生冲突时不覆盖主题；新快照作为未挂接快照保留，刷新时报告为待处理项。
这样不会牺牲不可变历史来伪装跨文件事务。
