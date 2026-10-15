# ADR 0019：执行 trace 改为「轮 + 条目」

- 状态：已接受（PR 2；编排决策 2026-10-15，风险项 R1–R16、P1 后续问题 Q1–Q6 与 P2a 复审决定 D-final、D-count 已裁定）。
- 取代 [ADR 0006](0006-conversation-log-and-daemon-owned-traces.md) 中 trace 格式的部分：决策 5 的 `multiremi.trace.v1` 片段事件与「字段和 `TaskMessageInput` 一一对应」，以及决策 4 末尾「轮卡上的 trace 数字由 `trace-derive` 函数派生」。trace 的归属（daemon 持有文件，服务端只存指针）不变；决策 5–9 的其余内容已由 [ADR 0018](0018-local-records-and-recyclable-workspaces.md) 取代。
- 继承 [ADR 0013](0013-deliverable-is-comment-wakeup-is-doorbell.md)：任务回复仍是最后一条顶层 assistant 消息，现在由本 ADR 决策 4 的规则选出。
- 不改 [daemon 协议 v2](../daemon-protocol-v2.md) 的帧、序号与续传机制，也不改 `DAEMON_PROTOCOL_VERSION`。

## 背景

PR 2 之前，daemon 把 ACP 通知映射成 13 种片段事件（`text`、`thinking`、`tool_use`、`tool_result`、`usage` 等）写进 trace。每个读者都要自己做同样的工作：把 `tool_use` 和 `tool_result` 按调用 id 配对，合并文字分片，判断哪段是最终回答，按 `(type, tool)` 统计。这些规则在 `trace-derive`、`trace-semantics`、网页 `build-timeline` 与飞书的 `TraceFinalReplyAccumulator` 里各写了一遍，结果会互相漂移。

另外三件事也挤在片段流里：

- 计费帧和上下文快照混在 `usage` 事件中，读者要自己区分哪些是计费、哪些是上下文占用；
- 压缩靠匹配横幅文字识别，桥接改一句文案就失效；
- Chat 页面要显示已结束轮的「用时」和折叠的过程步骤，只能去读 trace，而 MUL-472 要求空闲页面不读 trace。

## 决策

### 1. 条目模型

一份 trace 对应一次轮尝试（attempt），由一个 `TraceTurn` 和若干 `TraceItem` 组成，每个条目都是完整记录。条目有 13 种：`user_message`、`agent_message`、`reasoning`、`command`、`file_change`、`web_search`、`tool`、`subagent`、`plan`、`permission`、`question`、`compaction`、`notice`。子 agent 的条目用 `parent_id` 指向它的 `subagent` 条目。

事件只有七种：`turn.started`、`turn.updated`、`turn.completed`、`item.started`、`item.updated`（进行中条目的整体替换，R1）、`item.delta`（`text` 或 `output` 追加）、`item.completed`。类型、校验器和分页形状只定义在 [`contracts/trace.ts`](../../packages/contracts/src/trace.ts)。

所有读者用同一个 fold：[`shared/turn-trace.ts`](../../packages/shared/src/turn-trace.ts)。daemon、网页、飞书、CLI 与 organizer 因此在条目顺序、最终回复和工具数上天然一致。规则：

- 条目按 `id` upsert，保留第一次出现的位置；
- 应用任一事件都把 `item.seq` 设为事件的 `seq`，`seq` 不大于它的事件被跳过，所以重放快照 head 以下的事件、拼接不同 head 的分页都是幂等的；
- `item.delta` 只追加到 `in_progress` 的条目；
- 工具数只有一条规则：任意深度的 `command`、`file_change`、`web_search`、`tool`、`subagent`。

单个事件序列化后不超过 1 MiB（含事件外壳）；超出时按条目类型丢掉最大的字段并置 `*_truncated`，仍放不下的事件不占 seq，存储记一条警告。命令的 `command`、`cwd` 与 `actions[].command` 也有上限，截断时置 `command_truncated`，所以超长 heredoc 不会让整个命令条目被丢弃。字段上限见 [`trace-sanitize.ts`](../../packages/shared/src/trace-sanitize.ts)。

校验器向前兼容：`isTraceTurn` 遇到未知条目类型的直方图桶时丢掉这些桶，不拒绝整轮，所以旧读者能读新 daemon 的统计。

### 2. 文件格式 `multiremi.trace.v2`

首行与 v1 相同，只换格式标记；每行一个事件。`close()` 依次写：所有未结束条目的 `item.completed`、`turn.completed`（状态、错误、完成时间、最终条目、统计）、快照分片行（`{"snapshot":{part, parts, head, turn, items}}`，每行至多 768 KiB，不带 `seq`）、trailer（`end.snapshot_parts` 记分片数）。快照分片与首行、trailer 一样是文件框架，不进 seq 轴、Live Hub 和冷启动回放预算（R8）。`close()` 中途崩溃留下的分片与半个 trailer 在恢复时截回最后一个事件，再重新封口（Q2）。

### 3. 两种读取视图

`trace.read` RPC 与三个 HTTP 路由（`GET /api/turns/:id/trace`、`GET /api/tasks/:id/trace`、`GET /api/shares/:token/tasks/:task_id/trace`）都按 `view` 返回：

| `view` | 游标 | 运行中 | 已结束 | v1 文件 |
|---|---|---|---|---|
| `turn`（默认） | `item_cursor`（条目序号） | daemon 内存 fold；`turn.stats` 是整个 fold 的实时统计 | 持久化快照分片 | `format: "legacy"`，`turn: null`，`items: []` |
| `events` | `after_seq` | 原始事件行 | 原始事件行 | 原始片段行 |

两种视图都接受 `limit` 与 `max_bytes`（Q5），首个条目或事件超出预算时单独返回。另一视图的游标是 400，不静默忽略。`state` / `reason` 语义不变（`ok` / `unreachable` / `not_found` / `lost`），非 `ok` 时页面为空。CLI 的 `remi turn trace read` 默认输出折叠后的 `{turn, items}`，`--cursor` 翻页；`--raw` 读原始行，也是查看 v1 文件的唯一方式。

### 4. 最终回复只有一条规则

daemon 在每次报告完成前调用 `settle()`：

1. 有桥接标为 `phase: "final"` 的顶层 `agent_message` 时，取最后一条，更早的改标 `commentary`；
2. 否则（Claude 不标阶段）取最后一条非空、阶段为 `unknown`、之后没有顶层工具条目或 `question` 条目的顶层 `agent_message`，标为 `final`。Claude 的 AskUserQuestion 没有工具条目，所以 `question` 与工具一样阻断；桥接标为 `commentary` 的消息也阻断，且永远不是最终回复；
3. 规则 2 找不到时（轮在最后一段文字之后以工具或问题结束），仍取最后一条非空、阶段为 `unknown` 的顶层 `agent_message` 标为 `final`（D-final）。这与旧的 `LastAssistantMessage` 一致，避免这类轮退化成 `Task completed.`。

之前由规则 2 或 3 推断出的另一条改回 `unknown`。

回复正文是最终条目的文本；一条 `agent_message` 都没有时用 provider 的最后响应；仍为空时用 `Task completed.`。`final_reply_md` 与回复正文相同。子 agent 的文本永远不是最终回复。

### 5. 压缩由桥接直接报告

daemon 在 ACP `clientCapabilities` 声明 `session.compaction` 与 `session.notices`。有了前者，两个固定版本的桥（Claude ACP 0.89、Codex ACP 2.2.2）发送 `compaction_update`，而不是「Compact conversation」工具调用或横幅文字；对两个桥的夹具录制验证了这一点（R11，`tests/fixtures/acp/*-089-*`、`codex-222-*`）。有了后者，提示以 `notice` 更新到达，不再混进回复文字。压缩成为 `compaction` 条目，横幅文字匹配删除。

### 6. 计费不进 trace

`size == 0` 的 `usage_update` 是计费帧，翻译器直接丢弃；计费照旧经 `_meta.remiUsageUnits` 进入用量账本和可靠报告（见[统一用量](../usage-accounting.md)）。上下文占用是 `turn.updated {context_usage}`，相同值不重复写。trace 不再承载任何计费事实。

### 7. 轮卡带 trace 摘要

`turn.complete` / `task.fail` 的完成字段增加 `context_usage`、`worked_ms`（`final_started_at - started_at`）、`process_item_count`（R3）。服务端逐项校验，畸形或缺失的值记日志后写 null，从不阻塞终态。迁移 `20261015_turn_attempt_trace_summary` 给 `multiremi_turn_attempts` 加 `context_usage`（JSON 文本）、`worked_ms`、`process_item_count` 三列，两条迁移链都调用，统一 schema 也带这三列。轮卡元数据和尝试列表投影这三项。

Chat 页面据此显示已结束轮：`process_item_count > 0` 才显示折叠，标题用 `worked_ms`，空闲时上下文环读最近一张终态卡的 `context_usage`；展开折叠才读 trace。`process_item_count` 恰好统计在 Chat 折叠中产生一行的条目：除最终回复、`user_message`、`permission`、`question`、`reasoning` 和没有可见文字的 `agent_message` 外的顶层条目（Q1、D-count）。前端以 `buildTurnSteps(items).processCount === processItemCount(items)` 守住两边一致。PR 2 之前的轮这三项为 null，不显示折叠和标签。

### 8. 不兼容旧格式

v1 文件只读：不追加、不续传、不重新封口，`view=turn` 只给 legacy 空页。旧片段的读者（mapper、batcher、`trace-derive` 等）删除，网页与飞书在各自阶段切到 fold。daemon outbox 里遗留的 `messages` 行打警告后丢弃。`multiremi_task_messages` 仍是只读的历史表。

### 9. 协议门槛与部署顺序

`DAEMON_PROTOCOL_VERSION` 与 `DAEMON_PROTOCOL_MIN` 保持 2（R2）：版本号升到 3 不增加安全性，还要改约 30 个写死 `protocol: 2` 的测试。改为提高 `DAEMON_MIN_CLI_VERSION` 到 `0.2.90`：

- 服务端拒绝 v0.2.89 及更早的 daemon（`reject` + close 4426），它们进入 `upgrade_wait`，经 HTTP 心跳通道自动排队升级到服务端版本；
- v0.2.90 的 daemon 遇到门槛更低的旧服务端时自行进入 `upgrade_wait`，因此新 daemon 只会收到带 `view` 的 `trace.read`，不带 `view` 的请求按 `protocol_violation` 拒绝。

`package.json` 版本只由发版准备（`bun run release:prepare --version <next>`）连同依赖快照一起修改，`release:check` 也要求二者一致，所以本 PR 不改它。**携带 PR 2 的发版必须准备为 v0.2.90。**在那之前，源码运行的测试 daemon 报告门槛版本本身（`tests/fixtures/daemon-protocol.ts`）。

部署顺序：负责人发起 updater drain，暂停派活 → 等运行中的轮与 outbox 排空 → 部署 API（跑上述迁移）→ 升级 daemon（被拒的旧 daemon 自动升级）→ 核对后解除 drain。部署前还要检查飞书 outbox 中持有 `messageId` 但没有展示检查点的投递（R10），它们在新版本只经 `FeishuTaskPresentation` 补发最终卡片。

## 未采用的方案

- **保留片段事件，在服务端派生视图**：规则仍分散在每个读者，计费与上下文仍混在一起。
- **用 `item.started` 兼做 upsert，不加 `item.updated`**（R1）：Claude AIR 在 `tool_call` 之后才给出 Bash 命令和 Read 路径，计划和 hook diff 也会整体替换，同名事件会掩盖语义。
- **把快照写成带 seq 的事件**（R8）：快照会进入 Hub、冷启动回放和 2 MB 预算。
- **`DAEMON_PROTOCOL_VERSION` 升到 3**（R2）：见决策 9。
- **不加列，用 `elapsed_ms` 与 `tool_call_count > 0` 代替**（R3）：「用时」会包含回复生成时间，只有消息没有工具的轮也会误判。

## 影响与实施位置

- 契约：[`trace.ts`](../../packages/contracts/src/trace.ts)、[`trace-file.ts`](../../packages/contracts/src/trace-file.ts)、[`daemon-protocol.ts`](../../packages/contracts/src/daemon-protocol.ts)（视图联合、完成字段、门槛）、[`conversation-log.ts`](../../packages/contracts/src/conversation-log.ts)。
- 共享：[`turn-trace.ts`](../../packages/shared/src/turn-trace.ts)、[`command-parse.ts`](../../packages/shared/src/command-parse.ts)、[`trace-step-copy.ts`](../../packages/shared/src/trace-step-copy.ts)、[`trace-sanitize.ts`](../../packages/shared/src/trace-sanitize.ts)。
- daemon：[`trace-translator.ts`](../../packages/server/src/worker/trace-translator.ts)、[`trace-vendor.ts`](../../packages/acp/src/adapters/trace-vendor.ts)、[`trace-transport.ts`](../../packages/server/src/worker/trace-transport.ts)、[`trace-pages.ts`](../../packages/server/src/worker/trace-pages.ts)、[`trace-file-store.ts`](../../packages/server/src/worker/trace-file-store.ts)、[`usage-units.ts`](../../packages/server/src/worker/usage-units.ts)。
- 服务端：[`trace-reader.ts`](../../packages/server/src/trace/trace-reader.ts)、[`daemon-trace-reader.ts`](../../packages/server/src/api/trace/daemon-trace-reader.ts)、[`socket-trace-reader.ts`](../../packages/server/src/api/trace/socket-trace-reader.ts)、[`request.ts`](../../packages/server/src/api/trace/request.ts)、[`report-handlers.ts`](../../packages/server/src/api/daemon-protocol/report-handlers.ts)、[`organizer.ts`](../../packages/server/src/api/helpers/organizer.ts)（运行中的轮读一页 `view=turn`，用其 `turn.stats`）、[`turn-attempts.ts`](../../packages/server/src/store/turn-attempts.ts)、[`migrations.ts`](../../packages/server/src/store/migrations.ts)。
- CLI：[`unified.ts`](../../apps/remi/cli/commands/unified.ts)、[`collaboration.ts`](../../apps/remi/cli/commands/collaboration.ts)，选项定义在 [`resource-common.ts`](../../apps/remi/cli/commands/resource-common.ts)。
- 协议细节：[daemon 协议 v2](../daemon-protocol-v2.md) §5–6。
