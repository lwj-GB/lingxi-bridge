# V0.1 本地服务契约

基础地址为 `http://127.0.0.1:8765/api`。所有写入先落开放文件，再更新 SQLite。
服务只处理当前显式打开的一个工作区；未打开时写接口返回 `409 workspace_not_open`。

共享实体遵循 `../schemas/entities.schema.json`，报告分析输出遵循
`../schemas/analysis-output.schema.json`，截图候选识别结果遵循
`../schemas/screenshot-recognition.schema.json`，聊天数据分析遵循
`../schemas/chat-analysis.schema.json` 和 `../schemas/chat-topics.schema.json`。响应错误统一为：

```json
{"error":{"code":"machine_readable_code","message":"用户可读说明","details":{}}}
```

## 路由

| 方法与路径 | 请求 | 成功响应 | 说明 |
|---|---|---|---|
| `GET /health` | 无 | `{status, schema_version}` | 不要求已打开工作区 |
| `POST /workspaces/open` | `{path}` | `WorkspaceSummary` | 只接受本机绝对目录 |
| `POST /workspaces/refresh` | 无 | `RefreshResult` | 校验文件、报告变化并重建索引 |
| `POST /workspaces/rebuild-index` | 无 | `IndexResult` | 删除数据库后也能从文件重建 |
| `GET /workspaces/export` | 无 | ZIP 文件 | 导出开放资料、原始附件与哈希清单；排除可重建索引、系统杂项和符号链接 |
| `GET /people` | 无 | `{items:[person...]}` | 从工作区索引读取 |
| `POST /people` | `{display_name, relation_to_user}` | `person` | 服务生成稳定 UUID |
| `POST /people/{person_id}/profile-entries` | `{section, label, value, evidence_ids}` | `person` | 新增一条用户确认的分类档案信息 |
| `GET /events` | 无 | `{items:[event...]}` | 事件列表 |
| `POST /events` | `{title, occurred_at, person_ids}` | `event` | 验证人物引用 |
| `GET /sources` | 无 | `{items:[source...]}` | 材料列表 |
| `POST /sources/text` | `{title, text, source_kind, person_ids, event_ids}` | `source` | 原文写入附件，元数据写入 JSON |
| `POST /screenshot-batches` | multipart: `title, person_ids(JSON), event_ids(JSON), files` | `{batch_id,items:[source...]}` | 原子校验 1–20 张截图后保存原字节 |
| `GET /sources/{source_id}/original` | 无 | 原始二进制 | 只读取工作区内已登记的原件 |
| `POST /sources/{source_id}/chat-analysis` | `{engine, profile_id?, material_scope_confirmed}` | `ChatAnalysis` | 本地统计默认运行；CLI 主题需确认本次材料范围 |
| `PUT /sources/{source_id}/transcript` | `{segments:[{order,speaker,text,uncertainty}]}` | `{source,transcript,evidence}` | 人工确认识别稿后生成可回链证据 |
| `POST /screenshot-recognition-jobs` | `{source_ids,engine,profile_id}` | `RecognitionJob` | 创建异步候选识别任务，不自动确认 |
| `GET /screenshot-recognition-jobs/{job_id}` | 无 | `RecognitionJob` | 查询进度、逐图结果或错误 |
| `DELETE /screenshot-recognition-jobs/{job_id}` | 无 | `RecognitionJob` | 取消尚未完成的任务 |
| `GET /evidence` | 无 | `{items:[evidence...]}` | 原子证据列表 |
| `POST /evidence` | `{source_id, quote, locator, evidence_kind, reliability, person_ids, event_ids}` | `evidence` | quote 必须与原文 locator 对应 |
| `GET /reports` | 无 | `{items:[{topic,snapshot,analysis}]}` | 返回主题、当前快照和结构化分析 |
| `GET /report-advisor/suggestions/{person_id}` | 无 | `{person_id,items}` | 按联系人关系标签给出可选问题，不生成结论 |
| `POST /report-advisor/preview` | `{person_id, request_text, evidence_ids?}` | `ReportAdvisorResponse` | 只按问题相关或显式选中的证据判断资料是否足够 |
| `POST /reports` | `{title, template_family, template_variant?, analysis_question?, person_ids, evidence_ids, engine?, profile_id?}` | `{topic,snapshot,analysis,execution}` | 保存本次问题；无 CLI 时使用安全占位分析 |
| `GET /analysis-templates` | 无 | `{schema_version,active_template_id,custom_templates,items,relative_path,file_hash}` | `items` 合并稳定内置模板和工作区自定义模板；首次读取不创建文件 |
| `PUT /analysis-templates` | `{active_template_id,custom_templates,expected_hash?}` | 同上 | 原子写入开放 JSON；用哈希阻止覆盖外部修改 |
| `GET /records/{record_id}` | 无 | `{record, relative_path, body, file_hash}` | 来源回链入口 |
| `GET /executors` | 无 | `{items:[ExecutorStatus...]}` | 只报告引擎名/路径/版本/可用性和降级原因，不推断厂商 |

## 实时 WebSocket

`WS /api/live` 的收发事件统一遵循 `../schemas/live-session.schema.json`。首条消息必须是
已明确同意数据去向的 `start`；浏览器识别随后发送 `transcript` 和 `stop`，豆包识别发送
16 kHz、16-bit、单声道 PCM 二进制分片和 `stop`。服务端返回 `started`、增量转写、
分析快照、状态、错误和最终 `ended`。

浏览器识别的 `sequence` 在同一会话内按每次事件严格递增，包括 interim 到 final 的
修订。服务端幂等忽略重复或回退序号，后续更大序号仍可继续，避免上游重发导致确认稿重复。

豆包返回的识别文本按“当前完整快照”处理：服务端只把相对上一次已确认文本的新增后缀作为
`transcript_delta.text`，而 `committed_text` 和 `interim_text` 始终表示当前权威全文，
避免上一句确认后下一份完整快照重复追加。

`error.recoverable=true` 表示当前连接继续工作，客户端展示提示但不得清空确认稿或结束会话；
`recoverable=false` 才进入异常结束与确认稿挽救流程。用户停止后若豆包未在等待期内返回最终
结果，服务端必须发送 `doubao_final_result_timeout` 的不可恢复错误，不能把可能不完整的文本
伪装成正常 `ended`。

## 固定行为

- `POST /sources/text` 必须先原样保存 UTF-8 文本，再创建 `source` 元数据。
- `POST /screenshot-batches` 在任何写入前校验数量、引用、MIME、魔数、单文件
  15 MiB 与整批 100 MiB 上限；21 张返回
  `422 screenshot_count_out_of_range` 且零残留。截图原件不可变。
- 截图来源在上传后为 `pending_confirmation`。AI 识别只返回候选分段，用户可修改
  顺序、说话人、文本与不确定性；只有 `PUT /sources/{id}/transcript` 会创建确认稿和证据。
- 截图确认稿位于同一工作区的 `transcripts/`，正文链接原图，Obsidian 可直接读取。
  证据 locator 使用 `screenshot_segment` 精确引用确认稿分段。
- `POST /evidence` 的 `quote` 必须等于 `[start:end]` 对应原文；不匹配返回
  `422 evidence_locator_mismatch`。
- `POST /sources/{source_id}/chat-analysis` 只读取该来源的原始文本，最多处理 5,000,000
  个字符。本地统计不启动外部进程；选择 CLI 时必须确认材料范围，子进程只读取隔离后的
  `messages.json`。CLI 失败时保留本地统计，并在 `execution.degraded_reason` 说明原因。
- 聊天词频、参与者和时段是派生统计，不是原子证据。主题项必须保留原始消息索引、摘录和
  `source_id`，不能用频率推断人物心理、动机或关系结论。
- `template_variant` 必须属于选定的四大报告家族；省略时使用该家族的兼容默认值。
- `POST /report-advisor/preview` 不得因联系人存在其他证据就自动扩大范围；只使用与
  `request_text` 相关或调用方在 `evidence_ids` 中显式选中的证据。
- `POST /reports` 保存 `analysis_question`，并把它连同模板和关系标签交给所选执行器；
  未提供时兼容使用报告标题。接口只发送请求中 `evidence_ids` 所引用的材料范围。响应中的
  `execution` 明确 `engine`、`profile_id`、`material_scope`、`data_destination` 与
  是否降级；AI 结果须通过 Schema，但 V0.1 不自动覆盖人工资料。
- 分析模板只提供报告问题、建议维度、证据要求和禁用结论，不改变人物、材料、证据和报告
  Schema。内置模板由程序稳定提供；用户修改内置模板时创建自定义副本，不覆盖内置定义。
- 工作区自定义模板保存在根目录 `analysis-templates.json`，可以随工作区迁移和导出。
  Claude Code/Codex 只有在用户明确要求后才可编辑这一个配置文件；模板编辑权限不扩展到
  UI、代码、系统架构或原始材料。`expected_hash` 与现存文件不一致时返回
  `409 workspace_conflict`，用户必须重新读取后再决定是否保存。
- `safe_placeholder` 不调用外部进程，仍生成具备观察、假设、替代解释、未知项、
  建议和来源引用的初级快照。
- `ExecutorStatus` 的固定字段为
  `{engine,name,available,path,version,degraded_reason}`；`path`、`version` 和
  `degraded_reason` 不可用时为 `null`，不能省略。
- CLI 子进程使用参数数组、隔离临时目录、只读材料副本、超时和取消；不得直接写工作区，
  不得读取或改写 `~/.claude`、`~/.codex`，日志不得包含凭据或完整私密原文。


## 桌面助手（2026-11-08）

- `POST /api/assistant/answer`：`question`、`person_id`、`source_ids`、`engine`（claude/codex）、可选inherited配置档。只读选中人物及文字材料，返回 `answer/source_ids/person_id`。禁止跨人物来源；模型失败503，不回退为占位成功。
- `POST /api/assistant/people`：`text/preview/display_name/relation_to_user/request_id`。preview复用profile-autofill schema；返回 `person/source/evidence/replayed`。同请求编号和内容幂等，不同内容409；原文和引用一同保存。
- 运行规则：`packages/schemas/workspace-rules.md`；回答结构：`assistant-answer.schema.json`。
