---
title: daemon 协议 v2
status: active
summary: daemon 与平台之间的全双工 WebSocket 协议：帧封装、可靠性分级、推送派活、trace 流、版本协商与升级通道。
---

# daemon 协议 v2

本页是 daemon ↔ 服务端协议的唯一规范（MUL-401，父单 A）。帧名、常量、错误码与 close
code 的机器可读定义在 [`packages/contracts/src/daemon-protocol.ts`](../packages/contracts/src/daemon-protocol.ts)；
trace 事件的唯一定义在 [`packages/contracts/src/trace.ts`](../packages/contracts/src/trace.ts)。
两者是实现的直接依据，本页说明它们的语义与取舍。定义与实现冲突时以源码为准并同批修正本页。

范围：本单只描述协议 v2 的终态。存量 v1 daemon 的处置见「版本协商与升级通道」。

本页提到的实现模块，一次性列在这里：

| 模块 | 内容 | 当前状态 |
|---|---|---|
| `packages/contracts/src/daemon-protocol.ts` | 帧类型、常量、错误码、close code、载荷类型 | A-0 落地 |
| `packages/contracts/src/trace.ts` | `TraceEvent`、`KNOWN_TRACE_EVENT_TYPES` | A-0 落地 |
| `packages/shared/src/trace-sanitize.ts` | 字段截断与消隐（唯一 sanitize 点） | A-0 落地，A-6 接入 |
| `packages/shared/src/trace-derive.ts` | `deriveFinalReply` / 直方图 / 取模型 | A-0 落地，A-5、A-8 接入 |
| `packages/server/src/worker/trace-store.ts` | `TraceStore` 接口 + 内存实现 | A-0 接口，B3 文件版 |
| `packages/server/src/api/trace/trace-sink.ts` | `TraceSink` 接口 + 内存实现 | A-0 接口，C 的 Hub 实现 |
| `packages/server/src/api/trace/daemon-trace-reader.ts` | `DaemonTraceReader` 接口 + 内存假实现 | A-0 接口，A-6 真实现 |
| `packages/server/src/api/daemon-protocol/` | 服务端握手、注册表、hb、ack 与 RPC 分发 | A-1 落地 |
| `packages/server/src/worker/daemon-protocol-client.ts` | 进程级 socket、定时器、RPC、去重接口与升级等待 | A-2 接线，业务泵待 A-3 至 A-6 |
| `tests/integration/daemon-protocol-v2/` | 真实 daemon/API/SQLite 与断线、重启、服务端入站 ledger | A-2 脚手架 |

### MUL-498：评论交付、门铃唤醒与按需输入

daemon 的任务 `output` 只保留最后一条顶层 assistant 消息。顶层工具调用、工具结果、
compaction 与 steer 切分消息段，连续文本 chunk 合并；同段存在 final 时只取 final。
子 agent 的正文及工具事件不参与结果，完整执行过程仍保留在 trace。

委派终态信封保留三种英文首行和独立 `Status:` 行，后面只写结论评论 id、
`remi comment list <issue> --thread <comment>` 与最多 500 字的摘要。自动回复沿用
「本轮自己发过评论就不再自动贴」的判定；未评论时，自动回复与终态在同一事务写入，
门铃引用实际写成的 id。自动回复写入失败时给任务读取入口，不引用未写成的评论。
委派门铃目标小于 2 KiB，同类信封在统一写入口限制为 4 KiB；子单的
`<KEY> 有新日志：`、`状态 <x>` 及 envelope metadata 保持原格式，供前端解析。

服务端在既有 `session_projection.jsonl` 中提供两类记录：`unread_range` 和
`triggering_message`。会话 prompt 只包含本轮触发消息、未读范围和读取命令，
合并唤醒保留每条触发消息。其他未读消息的正文、标题、摘要和 inbox 目录均不内联。
触发消息通常内联 8,000 个 JavaScript 字符，超长保留开头、准确省略数和
`remi session log get <session> <seq>`。冷启动范围从 0 开始，未读统计与范围读取
排除 agent 自己的历史消息；提示词明确要求动手前先读未读部分。

现有命令增加 `remi session log get <session> --from X --to Y`，语义为 `X < seq ≤ Y`。
沿用 `GET /api/sessions/:id/log/entry`，不新增 API 或 CLI 命令路径。
服务端按最多 100 条、32,000 正文字符分页，超长条目按字符偏移分片，不切开代理对；
CLI 自动读取全部页并拼回完整正文。使用任务 token 的成功读取写结构化日志
`session_log_range_read`；单条读取写 `session_log_entry_expanded`。
记录 task/agent/session、范围或 seq、实际返回的 seq 区间、分页起止偏移、下一页游标及
已读高水位，不记录凭证或正文，不拦截任务。`complete` 仅表示本页已到范围结尾，
不表示前面的所有页都已读取。只有连续读取才推进实际高水位；乱序或跳过分页不会越过未读缺口。
Issue/Chat 会话在 `multiremi_conversation_heads.agent_read_state` 可空 JSON 字段按 agent
保存完整条目的高水位和下一条的已读字符偏移。完成任务只推进 provider 续跑检查点；
下一轮未读范围从实际高水位开始。已接受 offer 中完整内联、紧邻高水位的触发消息也可推进，
折叠消息和未接受的 offer 不推进。每个 agent 首次访问已读状态时，用旧 Issue lane 游标或
已完成 Chat 任务的投影检查点初始化并保存；这些旧投影曾完整内联，不要求重读全部历史。
没有旧检查点的冷启动仍从 0 开始。初始化只做一次，之后 provider 检查点变化不影响已读位置。
全新 provider bootstrap（含 stale_session 恢复）没有此前记忆，prompt 的未读范围始终从 0 开始。
仅在接受 bootstrap offer 时重置实际高水位，再记账相邻的完整内联触发消息；准备或拒绝 offer 不重置。
重置后的 delta 按新会话实际读取的高水位继续。
内联记账每次最多检查 100 条元数据，不加载正文；旧镜像忽略此可空列，回滚无需删列。

daemon 在 `hello.caps` 声明 `wiki.fetch` 时，服务端只查询 Wiki 元数据，不读取正文、不计算
正文 hash。offer 携带 version，`content_sha256` 可选。新 daemon 用任务 token 调用既有 Project/Repository Wiki GET 接口，
在物化前下载正文。经过校验的本地 baseline 缓存 version/sha；未变页不重复拉取。
下载失败保留上次成功版本、路径与本地编辑，首次失败不造空正文。prompt 中 Wiki 不可用信息
最多一行汇总（页数和 `remi wiki` 读取提示），不逐页列出；成功下载没有固定省略 warning。
没有该能力的旧 daemon 仍在软预算内接收完整正文；超预算时 Wiki 第一个被裁减，只去掉够用的页。
Repository Wiki 被裁减的页保留不可用标记，旧 daemon 对未裁减的页继续更新本地副本。
旧版逐页渲染不可用提示是过渡期限制，升级后才统一为一行。
新范围命令需要包含这些 flags 的 CLI；平台更新不会自动证明所有 daemon/CLI 已升级。

`task.offer` 在服务端发送前按完整 JSON 帧加预留开销计量，软预算为 512 KiB，硬限
仍为 1 MiB。依次移除 Wiki/重复文档正文、收缩触发消息、折叠长描述、移除过大的
可选执行上下文。按最新输入约定，旧投影正文在预算检查前已被范围指针替换。
日志 `daemon_offer_budget` 记录各字段字节及降级阶段。移除可选上下文后仍超预算时，从最大的
剩余文本字段开始截短，保留开头、未读字数和相应读取命令；agent instructions 指向
`remi agent get <id>`，没有触发消息的长 prompt 指向 `remi task get <id>`。
JSONL 按条目内文本截短，保留有效 JSON。`project_resources` 的执行绑定、Runtime workspace、
目录、分支、冻结插件与模型连接配置和续跑身份不能作为可选上下文删除。普通路由字符串保持原样；最后一层可截短
超过 8,000 字符的异常 URL/path，保留凭证和 task/agent/Issue 等身份字段。
只有文本截短后结构本身仍超过编码器 1 MiB 硬限时，才一次性置任务失败，
`failure_reason=offer_too_large`，报告各部分字节并向派活人发短门铃。
此异常不将 Issue 置 blocked，runtime 立即继续下一项任务，不反复排队、不等待容量或冷却。
具体决策见 [ADR 0013](adr/0013-deliverable-is-comment-wakeup-is-doorbell.md)。

## 1. 连接与帧

### 1.1 一个进程一条 socket

daemon 以 Bearer daemon token 连接 `GET /api/daemon/ws`，**每个 daemon 进程一条 socket**，
由 `hello` 帧列出本进程的全部 runtime。服务端按 runtime 逐个复核归属、workspace 与成员资格，
与 HTTP daemon 身份、workspace 和成员鉴权同一套判定。

**URL 形状：v2 客户端必须带 `?protocol=2`。**

```
GET /api/daemon/ws?protocol=2
Authorization: Bearer <daemon token>
```

v1 客户端把 runtime 写在查询串里（`?runtime_ids=<id>`），v2 客户端一条 socket 承载全部 runtime，
所以两者靠 URL 形状区分，判定规则是：

| 请求 | 判定 |
|---|---|
| 带 `?protocol=2` | v2；runtime 列表只读 `hello` |
| 无标记、旧 runtime 参数或其他 protocol 版本 | HTTP 426 `{ code: "daemon_protocol_upgrade_required", min_version: 2 }` |

`?protocol=2` 是**规范要求的形状**。A-2 已删除 A-1 与 v1 并存时的无标记兼容，以及
`hasRuntimeParameters` / `requestsDaemonProtocolV2` / `isV2Upgrade`，只保留有标记的路径。

选单 socket 而不是每 runtime 一条，因为升级、drain 与 CLI 更新锁（`MultiremiCliUpdateCoordinator`）
都是进程级动作：两条 socket 会让同一台机器的两个 lane 看到顺序不一致的指令，也会让 `seq`
需要两个作用域。

服务端注册表以 daemon 为单位（`Map<daemonId, DaemonSession>`），并维护 `runtimeId → daemonId`
索引供 `trace.read` 定位。

**替换规则按 daemon 看，不按 runtime 看：**

| 情况 | 处理 |
|---|---|
| 同一个 daemon 建了新连接 | 旧连接以 4001 关闭（它属于同一台机器，新连接就是它的替代品） |
| 另一个 daemon 的在线会话已持有某个 runtime | 新连接**不驱逐**对方：把这个 runtime 归入自己的 unavailable，首个 `hb` 报 `runtime_gone`（§4） |

第二条是必须的：一条 socket 承载整台机器的全部 runtime，为其中一个 runtime 的归属冲突关掉对方的
整条连接，会把对方那些**完全正常**的 runtime 一起断供。归属检查在握手时先做一遍（runtime 行上的
`daemonId` 与 `hello` 的 `daemon_id` 不一致即按 `runtime_gone` 处理），注册表这一步是兜底，
覆盖 runtime 行上没有 `daemonId` 的历史数据。

### 1.2 帧封装

JSON 文本帧，不用二进制：

```json
{ "v": 2, "t": "task.offer", "seq": 17, "ack": 42, "id": "q-9", "re": "q-9", "rt": "rt_fkmqtl", "ts": 1759000000000, "p": { } }
```

| 字段 | 含义 |
|---|---|
| `v` | 协议版本，当前固定 `2` |
| `t` | 帧类型，`域.动作` |
| `seq` | 可靠事件帧的发送方序号；其他类别不带 |
| `ack` | 接收方的累计确认，可搭在任意帧上，也可单独发 `ack` 帧 |
| `id` | RPC 请求 id |
| `re` | 本帧所答复的 `id` |
| `rt` | runtime 作用域；runtime 级帧必带，进程级帧（`hello`、`platform.drain`、`runtime.update`）不带 |
| `ts` | 发送方墙钟，毫秒 |
| `p` | 载荷 |

### 1.3 六个类别

类别的定义在 `daemonFrameCategory()`，不是注释里的约定：

| 类别 | 帧 | 可靠性与重放 |
|---|---|---|
| `handshake` | `hello` / `welcome` / `reject` | 每连接一次 |
| `best_effort` | `hb`、`runtime.ready`、`concierge.status` | 不带 `seq`，不重放；`hb` 的服务端答复是 `res`（见 §4） |
| `event` | 见下 §1.4 | 带 `seq`，未确认前重放 |
| `rpc` | 见下 §1.5 | 按 `id`/`re` 配对，由调用方重试 |
| `reply` | `res` | 答复某个 rpc |
| `ack` | `ack` | 独立累计确认 |

设计初稿曾把这些压成五类，把 `res` 并进 rpc、把 `hb` 当作唯一的尽力而为帧。两者在代码里都不成立：
应答与请求的校验路径不同，而 `runtime.ready` 与 `concierge.status` 之所以尽力而为，与 `hb`
是同一个理由——它们都能从本地状态重算，丢一帧没有代价。

`best_effort` 与 `rpc` 都不参与滑动窗口，也不带 `seq`。
trace 组不是窗口可靠帧：上行 `trace.append` 用 RPC 的 `id`/`re` 关联，可靠性来自 task trace
head 续传与事件 seq 幂等，不来自外层 `seq`；下行 `trace.push` 仍是带 `seq` 的 event。

### 1.4 可靠事件清单

**daemon → server**（进本地 outbox，见 §2）：

`task.start`、`task.prompt`、`task.session_pin`、`task.progress`、`task.usage`、`task.workspace`、
`turn.complete`、`task.fail`、`runtime.update_result`、`runtime.command_result`、
`runtime.model_list_result`、`runtime.local_skills_result`、`runtime.directory_scan_result`、
`runtime.local_skill_import_result`、`runtime.bot_menu_result`、`feishu.outbound_result`、`plugin.state`、
`runtime.archive_sessions_result`（`rt:` 分区）。
`trace.append` 不属于可靠事件清单：它是按 trace head 续传的 RPC，**不进 outbox**，见 §5。
`task.complete` 只为拒绝旧 outbox 残留保留解析，返回 `report_shape_retired`，不执行完成写入。

**server → daemon**（由 DB 状态重推导，无服务端队列，见 §2.3）：

`task.offer`、`task.cancelled`、`turn.message`、`turn.wrap_up`、`runtime.update`、
`runtime.command`、`runtime.model_list`、`runtime.local_skills`、`runtime.directory_scan`、
`runtime.local_skill_import`、`runtime.bot_menu`、`runtime.profile`、`feishu.outbound`、
`feishu.directive`、`ssh_mesh.reconcile`、`platform.drain`、`plugin.desired_revision`、`workspace.settings`、
`runtime.archive_sessions`、`trace.push`（订阅内保序，可暂停）。

`task.offer` 不再携带 `id`/`prompt`，而是 `turn_id`、`attempt_id`、`input_from_seq`、
`input_to_seq` 和区间 `(input_from_seq, input_to_seq]` 的 `input_messages`。
trace、usage、附件、Session Archive 与 outbox 分区仍以 attempt id（原 `tsk_` id）关联。
`turn.message` 携带同一对 ID 和消息正文；`turn.wrap_up` 携带同一对 ID 与 `requested_at`，
后者是控制帧，不推进消息游标。elicitation 和 `kind=permission` 都使用 `turn.decision`：
S2 同事务创建 decision 消息并将轮置为 `awaiting_human`，通过 `reply_to_id` 匹配答复。
权限选项保留原 option ID、名称、种类和工具上下文；没有旧 `human_request.*` 兼容通道。

### 1.5 RPC 清单

**daemon → server**：`turn.input`、`turn.decision`、`turn.decision.get`、`turn.decision.expire`、`plugin.desired`、
`trace.append`、`trace.head`、`trace.subscribe`、`trace.unsubscribe`、`trace.fetch`、`gc.check_issue`、
`gc.check_chat_session`、`gc.check_autopilot_run`、`gc.check_task`、`gc.workspace_cleaned`。

**server → daemon**：`trace.read`。

RPC 应答的 `t` 固定为 `res`，`p` 为 `{ "ok": true, ... }` 或
`{ "ok": false, "code": <错误码>, "message": "人话", "retryable": <bool> }`。

`turn.decision.get` 按 `p:{turn_id,attempt_id,message_id}` 读取 decision 消息及答复；
创建、读取、过期都交给 S2 的 `DaemonTurnBridge.rpc`，写入时校验 runtime / 当前 attempt / turn。
答复超时或取消走 `turn.decision.expire`；若答复先于过期提交，以返回的 reply 消息为准。
服务端启动时默认取 `Store.getDaemonTurnBridge()`，将同一适配器接入 offer 输入、
下行快照、decision/input RPC 与原子完成；绑定无效的尝试由 Store 拒绝，不访问旧请求表。

`gc.check_*` 与 `gc.workspace_cleaned` 是 A-5 从周期性 HTTP 平移过来的维护扫描（原 15 分钟一轮、
每天约 13 次/分钟的 `gc-check` 请求）。它们不是等活轮询，但留在 HTTP 上「轮询降到 0」在 nginx
日志口径就不成立，因此一并改成 RPC；不做批量合并。
仅 `gc.*` 的失败应答（`DaemonGcErrorReply`）可附 `operation_error: {status, code, message}`，
保留原 HTTP 业务错误的状态码、`code`（没有时为 null）和 `error` 文案；daemon 包装器还原同一个
`MultiremiDaemonHttpError`，维护调用点的判断不变。此字段不属于通用 `DaemonProtocolErrorReply`。

### 1.6 错误码与 close code

错误码共 19 个，定义在 `DAEMON_PROTOCOL_ERROR_CODES`，分五组：握手 2 个、上报 5 个、
offer 与派活 5 个、trace 与传输 6 个、服务端故障 1 个（`server_error`）。

`DAEMON_RETRYABLE_ERROR_CODES` 有 `daemon_busy`、`daemon_timeout` 与 `server_error`；其余都是
确定性结果，重发无益。

`server_error` 是服务端自己处理某一帧时抛异常时给出的答复（可重试）：它表示「这一次是我的问题，
你按退避重发就好」，而不是「你的帧不对」。这类异常同时会往 stdout 写一条 warn，只带帧类型、方向、
会话 id 与异常的类名，不带异常内容和 payload。`DAEMON_TERMINAL_ERROR_CODES`（`authority_revoked`、`task_not_found`、
`invalid_report`）表示确定性失败；其中 `authority_revoked`、`invalid_report` 会让该分区停摆，语义等同于今天 HTTP 侧的终态鉴权错误
（`isTerminalDaemonAuthorityError` 的 401/403/410）。
`task_not_found` 清掉整个 outbox 分区并记 warn（§2.1）；这条规则不适用于不进入 outbox 的 RPC。

报送类错误码取代 HTTP 状态码：

| 原 HTTP | 帧错误码 |
|---|---|
| 404 task not found | `task_not_found` |
| 401 / 403 / 410 | `authority_revoked` |
| 其他确定性 4xx | `invalid_report` |
| `start` 的 400「已离开 dispatched」（原本就是成功） | `start_replayed` |
| 409 `turn_input_pending` | `turn_input_pending` |

close code。协议**只显式列出四个终态码**，其余一律默认重连：

| code | 含义 | 是否重连 |
|---|---|---|
| 4401 | 凭证被吊销，或 owner 已不是成员 | **否**，终态（daemon 级） |
| 4403 | 凭证的 daemon 身份与 `hello` 不符，或凭证不是 daemon token | **否**，终态（daemon 级） |
| 4410 | daemon 已退役 | **否**，终态（daemon 级） |
| 4002 | `protocol_violation`：对端违反了无法用 `res` 答复的协议 | 是，走退避 |
| 4426 | 需要协议 v2 | **否**（进 `upgrade_wait`，改走升级通道） |
| 4000 | `ack_timeout`：15 s 内未确认 | 是，走退避 |
| 4001 | 服务端正常关闭（发布、重启） | 是，走退避 |
| 1000 / 1001 | 正常关闭 / going away | 是，走退避 |
| 1006 | 异常关闭（断网、服务端被杀） | 是，走退避 |
| 1011 / 1012 / 1013 | 服务端错误 / 重启 / 稍后重试 | 是，走退避 |
| 其他未知码 | — | 是，走退避 |

**未知类型的帧。** 服务端不认识的 `t` 按「能答复就答复、答复不了就忽略」处理，规则与超限帧同源：
`re` 要指向发送方需要处置的那一行，所以取址顺序是 `seq` 优先、`id` 其次。

| 未知类型的帧 | 处理 |
|---|---|
| 带 `seq`（可靠事件） | 回 `res{re: seq, ok:false, code:"unknown_frame", retryable:false}`，连接保持 |
| 只带 `id`（RPC） | 回 `res{re: id}`，其余同上 |
| 两个都没有 | 不回 `res`，只记帧指标，连接保持。新版 daemon 可能发来旧服务端不认识的通知类帧，忽略它比关连接更利于前向兼容 |

`unknown_frame` 是传输层的答复码，**不是**业务错误码：它不在 `DAEMON_PROTOCOL_ERROR_CODES` 里，
没有重试策略应该把它读成业务结果。

**升级阶段的 HTTP 拒绝 → 等价关闭码。** 同样的 daemon 级事实在升级握手时表现为 HTTP 状态码
（那时还没有 socket 可关）。A-2 的客户端必须把它映射成同一个动作，两张表是一份判定：

| 升级阶段答复 | 等价关闭码 | 客户端动作 |
|---|---|---|
| 401 `unauthorized`，或 403 `daemon_owner_membership_required` | 4401 | 停止重连 |
| 403 `daemon_token_required` / `daemon_identity_forbidden` | 4403 | 停止重连 |
| 410 `daemon_retired` | 4410 | 停止重连 |
| 426 | 4426 | 进入 `upgrade_wait` |
| 其他（400、404、421、429、5xx、网络错误） | — | 走退避重连 |

只有 401、403、410 调用 A-1 的 `daemonAuthorizationCloseCode`。该函数对其余状态默认返回
4403，不能用来判断网络或服务错误。421 包括 daemon 地址误配到 UI 进程的情况。

**默认是「重连」，只有上面那四个是终态**（`DAEMON_TERMINAL_CLOSE_CODES`，
判定函数 `daemonCloseCodeIsRetryable`）。这个方向是刻意的：断网与被杀时 daemon 实际拿到的就是
**1006**（异常关闭，由客户端栈产生，对端根本不会发这个码），如果写成「默认终态、只列出可重连」，
A-2 照字面实现就会永不重连，那台机器只能靠 SSH 救回来。默认重连的代价只是某个没预料到的码多退避几次。

**只有 daemon 级的事实才用 close code；runtime 级的事实不关连接。** 这条是 1.1 的直接后果：
一条 socket 承载这台 daemon 的全部 runtime，所以

| 事实 | 级别 | 处理 |
|---|---|---|
| daemon 已退役 | daemon | close 4410 |
| 凭证无效、owner 已不是成员 | daemon | close 4401 |
| `hello` 的 `daemon_id` 与凭证不符、凭证不是 daemon token | daemon | close 4403 |
| 握手时 `hello` 报的 runtime 行不存在 | runtime | 照常 `welcome`，该 runtime 不进注册索引，不派活；第一次 `hb` 回复里报 `runtime_gone` |
| runtime 属于别的 daemon | runtime | 同上。沿用 v1 的 `hideForbiddenAsNotFound`：把「无权访问」当作「不存在」，返回 `runtime_gone`，且**不刷新**对方那一行 |
| runtime 在别的 workspace | runtime | 同上。daemon 进程只有一个 workspace、一个 token，这最可能是 token 换了 workspace 而本地还记着旧 runtime；它需要的是重新注册，不是永久停机 |
| runtime 已被另一个 daemon 的在线会话持有 | runtime | 同上，且**不驱逐**对方（见 §1.1） |
| 连接后某个 runtime 行被删 | runtime | `hb` 回复里报 `runtime_gone`，socket 保持打开 |

把 runtime 级事实当 daemon 级处理是不行的：4403/4410 是终态，会让同一台机器上其它正常 runtime
一起永久断供；换成 4001 则 daemon 退避重连后又遇到同一个 runtime，形成循环。daemon 收到
`runtime_gone` 后按既有路径重新注册（`worker/daemon.ts` 的 `handleHeartbeatAck` 分支），
再回收孤儿任务。A-2 重新注册后关闭旧 socket，再以全部最新 runtime ID 建新连接、重发 `hello`；
不在同一条连接上重复 `hello` 或扩展 runtime 列表。注册表的 unavailable 列表固定，原持有者
断开也不会自动取得该 runtime，因此 ID 即使不变也必须建立新会话。

4426 虽然也在终态列表里，但它不是死路：`daemonCloseCodeRequiresUpgrade(code)` 单独把它标出来，
A-2 用它进入 `upgrade_wait`（§7.3）而不是单纯停止重连。另外三个终态码没有这样的后续动作。

## 2. 可靠性、序号与重放

### 2.1 三条流三种缓冲

**上行可靠帧：`seq` 就是 outbox 行 id。**`outbox_events.id` 是 AUTOINCREMENT，跨进程重启持久且
单调，天然满足「每 daemon 会话、跨重启」的作用域。重放缓冲就是 outbox 本身：行未删即未确认。
泵按 id 顺序单泵发送，滑动窗口取 64 帧或 1 MiB 先到者；服务端逐帧回 `res{re: seq}`，`ok` 即删行。
`ok:false` 且 `retryable:false` → 该分区（task 或 runtime）进入 blocked，与今天
`isPermanentDeliveryError` 的语义一致。
例外是 `task_not_found`：daemon 清掉整个分区并记 warn，任务已被删除，重放没有意义；
`turn_input_pending` 也不进入 blocked，daemon 删除这一行，将结果交回正在等待的执行端。
没有执行端等待时（重启重放或等待超时），改报 `task.fail`，原因 `runtime_recovery`，
说明完成时有未注入的 steer，执行端已不在，并记 warn。
尾帧例外：`task.progress(final:true)`（展示摘要）和 runAgent `finally` 的 `task.workspace`
允许排在 complete 之后；complete 是最后一条改变任务状态的帧，其余帧类型仍须在它之前。
服务端接收这两种终态尾帧，不改变任务状态，相同内容的重放只生效一次。

`outbox_events.task_id` 语义扩展为分区键：runtime 级记录写 `rt:<runtime_id>`。每分区内保序，
分区间可并行。断线期间照常入库，重连后从最小未删 id 续发。

**容量上限（默认 256 MiB）是软上限。** 超限时只允许删除同分区、同类型已有更新待发行覆盖的
`task.progress`、`task.session_pin`、`task.workspace` 旧行；`progress(final:true)` 不删除。
其余可靠行一律保留，包括 start、prompt、usage（合并计量）、messages、complete、fail、
所有 runtime 结果、feishu.outbound_result 和 plugin.state。压缩后仍超限只记 warn，stats 的
`overCapBytes` 暴露 SQLite 已分配文件大小超过上限的字节数（空闲页可能仍被保留），
不阻塞调用方，也不向调用方报错。

**下行可靠帧：`seq` 每连接从 1 起，只在内存。不建服务端持久队列——DB 就是队列。**

| 帧 | 重连后从哪里重新推导 |
|---|---|
| `task.offer` | `multiremi_tasks` 中 queued / dispatched 的行 |
| `turn.message` | 当前 turn 未确认的 now 消息 |
| `turn.wrap_up` | 当前 turn 的 `wrap_up_requested_at` |
| `task.cancelled` | 任务已终态而 daemon 仍在跑 |
| `runtime.*` 各类待办 | 各自请求表 |
| `platform.drain` | 平台维护状态行 |
| `plugin.desired_revision` | `desiredRevision` |
| `runtime.archive_sessions` | `multiremi_session_archive_requests` 中 status=pending 的行（B6 提供） |

daemon 按实体 id 去重（`activeTaskIds`、`runtimeModelListRequests`、steer 的 `seen` 集合今天就有，
补齐 update / command / skills 的同类集合即可）。服务端对每条下行可靠帧记发送时刻，15 s 未 ack
即关连接（4000），由重连后的快照重推兜底。

decision 的答复通过 `turn.message` 投递，携带 `reply_to_id`。daemon 按 decision 消息 ID
匹配等待中的 question 或 permission 回调，向 provider 返回答复，并在连续输入确认时推进游标；
不把同一答复再注入为普通插话。断线重连由 S2 的消息快照重推。
daemon 已创建的 decision 在 RPC 应答中取得消息 ID 与 seq，同答复一起按 seq 排序确认，
仍须等待更早的插话消费完成；权限题目不作为已有最终回复复用。
旧 `task.human_request.settled` 已退役；旧 bot request hooks 显式返回 `report_shape_retired`，
其卡片与答复调用方由 S4 改接 decision 消息后再集成，不提供旧表兼容读写。

**trace 流：** 见 §5。

### 2.2 不丢不重

| 场景 | 上行可靠帧 | 下行可靠帧 | trace 流 |
|---|---|---|---|
| daemon 重启 | outbox 行仍在，启动后按 id 续发；服务端幂等吸收重复 | 重连后快照重推，实体 id 去重 | 从 `welcome.trace_heads` 续传；文件是唯一来源 |
| 服务端重启 | daemon 收到 close，走 1 s→30 s 抖动退避；窗口内未 `res` 的帧不删行，重连后重发 | 服务端无状态可丢，从 DB 重推导 | head 归零，daemon 回放尾部，Hub 记 `first_seq` |
| 任务进行中断线 | 同上；`turn.complete` 是其 task 分区最后一条改变状态的帧；只允许 §2.1 两种展示/工作区尾帧排在其后 | 断线期间新 steer / 取消留在 DB，重连后推 | 同上 |

判定口径：每一帧在服务端**至少到达一次、至多生效一次**，用 `(分区键, seq)` 对账。重复到达允许，
必须被幂等吸收。

### 2.3 为什么不建服务端下行队列

下行的事实本来就都在表里。再建一份持久队列只是第二份真相，服务端重启后还要对账两者，
而重新推导的代价就是今天 claim 已经在付的那一次查询。出现「不落 DB 的下行指令」时这个取舍
才需要翻案，目前一条都没有。

### 2.4 消息语义

每类帧的幂等键就是它的实体 id：

| 帧 | 幂等键 | 重复到达时 |
|---|---|---|
| `task.start` | task id | 已离开 dispatched 视为成功（`start_replayed`） |
| `task.progress` | task id | 覆盖写；终态的 `final:true` 尾帧相同内容即 ok，不重复写 |
| `task.session_pin` / `task.workspace` | task id | 覆盖写；终态的 workspace 尾帧相同内容即 ok，不重复写 |
| `task.usage` | task id + provider + model | 合并 |
| `turn.complete` / `task.fail` | attempt id | 已终态即 ok |
| `runtime.*_result` | request id | 状态机 pending→running→completed/failed 只能前进 |
| `feishu.outbound_result` | delivery id + claim_token | 租约已不是当前的即 ok（不写库，记 warn），应答带 `lease_lost:true`，在等结果的发送方据此停止；相同终态和没有推进的 streaming 检查点也吸收，不带 `lease_lost`。`prepared` 成功应答带 `mention_open_id`（open_id 或 null） |
| `plugin.state` | request id | 同上 |
| `runtime.archive_sessions` | request id | 状态机 pending→sent→acked→completed/failed 只能前进 |
| `runtime.archive_sessions_result` | request id | 已终态即 ok；重复结果被幂等吸收 |
| `trace.append` | `(task_id, trace_seq)` | Hub 丢弃 `≤ head` |

## 3. 推送派活

### 3.1 offer / accept / reject 取代 claim

服务端每 runtime 一个常驻单飞泵（沿用 `preparingClaims` 的单飞思想），基础触发源四个：
`onTaskEnqueued`、任务终态或 reject 释放容量、`hb` 报告的 `active_task_count` 变化、`hello`。
另由 `daemon:models_updated` 的模型能力变化、Agent / Plugin 就绪 / Runtime / Project 路由配置与设备绑定变化、
30 s reject 冷却到期、延迟重试的 `next_retry_at` 到期、断连后未 start 的 accept 租约 90 s 恢复到期触发。
Chat 恢复、Issue workspace 归属/清理、维护 drain 释放都在写入后触发；drain 租约到期另有定时触发。
终态释放 Agent 或执行 lane 容量时唤醒同 workspace 的在线 runtime，不只唤醒原 runtime。
跨进程的写后事件统一经 MUL-462 实时扇出；v2 连接层不直接订阅 Store。

每个在线 runtime 每 `DAEMON_OFFER_SWEEP_MS`（60 s）兜底 `kick` 一次；泵正在运行、等应答、
等窗口恢复或冷却中则跳过。扫描派出任务意味着遗漏了直接触发，必须记带 task id 的 warn，
并计入 `ws_minute_summary.offer_sweep_recovered`。普通测试默认将扫描间隔设为很大，仅扫描专测开启。

泵每次跑现有 `store.claimTask(runtimeId)`：选任务、置 `dispatched`、**只 hydrate 选中的任务**
（MUL-389 的原样保留），把今天 claim 响应的内容（含 `auth_token`）作为 `task.offer` 载荷推出。

daemon 收到 offer：有空位且未暂停 → `res{ok:true}` 即 accept，随后照常发 `task.start`
（start 仍是独立可靠帧，因为 workspace 准备可能先进入 `wait_local_directory`）；否则
`res{ok:false, code}`，code 取 `capacity` / `claims_paused` / `draining` /
`binary_skill_files_unsupported`。

reject、30 s 未应答、或连接断开 → 服务端把任务 `dispatched→queued`，并对该 runtime 冷却 30 s
（内存态）。仅 `capacity` 拒绝可提前结束冷却：daemon 释放本地任务槽位后立即补发已有的
`hb` 帧；服务端发现 `active_task_count` 变化且当前冷却原因为 `capacity` 时清理计时器并 kick。
该补发使用常规 hb 负载（含 drain ACK 与运行时状态），同时重置正常 15 s 心跳计时；丢帧仍由
30 s 冷却兜底。`claims_paused`、`draining`、超时和断线均保持 30 s，不用 `runtime.ready`
作为槽位释放信号。`CLAIM_RESPONSE_RECOVERY_MS`（90 s）的重领逻辑保留为最终兜底。

### 3.2 并发上限、租约与断线

并发上限不变：`claimTask` 的选择查询已按 `dispatched + running` 计数封顶 `maxConcurrency`，
offer 只在有空位时发。dispatch-lease 的 2.5 s 续租取消，租约改为「连接存活 + accept」。

daemon 断线期间：queued 留在队列；dispatched 未 accept 的按 §3.1 重排；running 的保持 running
（与今天一致），trace 暂停、页面按 §6 显示不可达。重连后 daemon 发 `runtime.ready{active_task_ids}`，
服务端对账：DB 已终态而 daemon 仍在跑的推 `task.cancelled`；DB 为 running 而 daemon 没列出的
走 `recoverOrphans`（原 `POST /recover-orphans` 路由删除，逻辑移到这里）。

`hello` 与 `runtime.ready` 的 `active_task_ids` 共用同一个来源：正在跑的任务，加上本 runtime
的 outbox 中还有未送达终态帧的任务；blocked 分区不计入。断线期间已完成、等待重放的任务因此
不会被提前判成孤儿。daemon 对自己未在运行的任务收到 `task.cancelled` 时为空操作，不清 outbox。

### 3.3 派活延迟怎么测

任务表新增 `offered_at` 与 `accepted_at` 两列，分三段报告：

- `created → offered`：只统计 offer 触发时该 runtime 有空位的任务；
- `offered → accepted`：**纯唤醒分量，这是验收口径的 p95**；
- `accepted → started`。

另加 `tests/manual/measure-dispatch-latency.ts`：真实 daemon + API + SQLite，在空闲 runtime 上注入
200 个 no-op 任务，输出三段 p50/p95，前后各跑一次。

不能用「created → dispatched」的 SQL 分位数代替：现有基线（24h，n=316）p50 292 ms /
p95 12,159 ms，其中混入了所有 runtime 都忙时的排队等待，不是唤醒延迟。

## 4. heartbeat 与 pending_*

`hb` 上行每 15 s，载荷包含 `active_task_count`、outbox 统计、`drain_ack_generation`，
以及各 runtime 的 `{ runtime_id, capabilities, ssh_mesh_protocol?, ssh_mesh_status? }`。
SSH Mesh 两字段与 v1 HTTP heartbeat 的同名字段同语义；显式协议版本 0 按不支持处理，
旧 v2 daemon 不带字段时不写 Mesh 状态。能力字段与 HTTP heartbeat 同名同语义；
缺失的字段视为不支持，覆盖旧值。服务端更新 `last_heartbeat_at`（`RUNTIME_HEARTBEAT_STALE_MS`
5 分钟的规则不动，platform-maintenance 与 ssh-mesh 继续用它）、记录 drain ack，并在能力
变化时更新 runtime metadata，不因无变化的心跳重写 metadata。`heartbeatRuntime` 里 7 类待办的
合并轮询（MUL-389）在 v2 服务端不再由心跳触发。

**`hb` 的回复按 runtime 逐条给出，且不关连接。** 服务端用 `res` 回
`{ runtime_acks: [MultiremiDaemonHeartbeatAck, ...] }`，顺序与 `hello` 报的 runtime 一致，
结构就是 v1 HTTP 心跳返回的那一个（`contracts/types.ts` 的 `MultiremiDaemonHeartbeatAck`）。

这一条是**必须的，不是可选的**：一条 socket 承载这台 daemon 的全部 runtime，所以「某个 runtime
的行没了」只关系到那个 runtime。运行时行不存在时返回 `status: "runtime_gone"` /
`runtime_gone: true`，socket 保持打开、daemon 的其它 runtime 照常收派活与 ack，daemon 按既有
恢复路径（重新注册 + 回收孤儿任务）自行处理。

**握手阶段适用同一条规则。** `hello` 里某个 runtime 的行不存在，或那个 runtime 属于别的 daemon，
服务端都照常回 `welcome`、保持 socket、把该 runtime 排除在注册索引之外（不派活、不打心跳），
并在第一次 `hb` 的 `runtime_acks` 里把它报成 `runtime_gone`。即使 `hello` 报的**全部** runtime
都是这种情况也不关连接——daemon 需要这条连接才能听到「你的 runtime 没了」并重新注册。

「属于别的 daemon」按 v1 WS 升级的 `hideForbiddenAsNotFound` 口径报成 `runtime_gone` 而不是
403：既让 daemon 得到它需要的同一个答案，也不泄漏别的机器上有哪些 runtime id。这类 runtime 的
行**绝不写**，否则会替对方 daemon 把那一行刷成在线。

只有 daemon 级事实才用终态码关连接，边界见 §1.6。

不能用 close code 代替，三种都不行：

- 4410 是「daemon 已退役」的终态，同一 daemon 上其它正常 runtime 会被永久断供；
- 4001 会让 daemon 退避重连，重连后又遇到同一个 runtime，形成循环；
- 映射成 `authority_revoked` 会让该分区停摆，daemon 就不再重新注册了。

只有两种情况才关 socket：daemon 本身被退役或 token 被吊销（4410 / 4401），以及整条连接出错
（4000 / 4001）。

被 drain 清理掉的 runtime 不在 `runtime_acks` 里出现：那次关停已经直接说过，daemon 不能把
「运维把它删了」当成「重新注册我」。

008 的 `rt_fkmqtl` 被分配为飞书 concierge，今天心跳 3 s；出站改推送后这个 3 s 节奏不再需要。

各 `pending_*` 改为**创建即推**：写入口在提交后发布既有实时事件，经 MUL-462 的进程间扇出
到 runtime 进程，再调用下行泵的统一 `kick(runtimeId)`。v2 连接层不直接订阅 `store.on*`，
也不另建进程间通道。进程内的 hello、ack 和 drain 直接调用同一入口。
状态机为 `pending → sent(seq) → acked(claimed) → result`；未 ack 前断连回到 pending，
下次 `hello` 快照重推。
`feishu.outbound` 在 ACK 前仅用现有列固定本轮 `claim_token` 和 presentation checkpoint，
重连重推保持同一载荷；收到 ACK 才转为 `sending`、开始租约并增加领取次数。过期租约重投产生新 token，
不增加投递单元或改变数据模型。
升级成功请求重启时，先等同一 runtime 已接收的其他维护请求收尾，避免独立下行帧的
并发处理把模型探测或技能导入中止；升级自身不参与这个等待。

| 今天 | v2 |
|---|---|
| heartbeat ack 捎带 `pending_update` / `pending_command` / `pending_model_list` / `pending_local_skills` / `pending_directory_scan` / `pending_bot_menu` / `pending_feishu_outbound` | 创建即推对应下行帧；`turn.complete` 等结果走上行可靠帧 |
| `GET agent-plugins/desired` 30 s 兜底 | v2 服务端推 `plugin.desired_revision`，daemon 用 rpc `plugin.desired` 拉快照；30 s 兜底取消。v1 的 GET 暂作升级桥，供旧进程完成启动并进入升级心跳，非 v2 稳态轮询。桥路由不接受客户端写入；读取时与 RPC 一样先 reconcile desired 状态，有漂移时可能更新业务状态，稳态无漂移时不改 desired 业务状态（既有工作区锁行更新仍会发生） |
| desired 的 10 分钟强制刷新（ADR 0001 的「revision 定义漏字段」防御） | 保留，改为 WS rpc；不算轮询 |
| `GET tasks/:id/steer` 2.5 s | 创建即推 `turn.message`，daemon 用 rpc `turn.input` 标记消费 |
| `GET tasks/:id/status` 2.5 s（取消与 `waiting_local_directory`） | `task.cancelled` 推送；`watchTaskState` 的 2.5 s 定时器删除。飞书 bot 的独立任务状态轮询仍按需使用此 GET，见下方条件 HTTP 清单 |
| 人工提问 / 权限请求等待 | 创建、读取、过期走 `turn.decision*` RPC；答复走 `turn.message`，以 `reply_to_id` 匹配 |
| `GET .../gc-check` ×4 与 `workspace/cleaned` | rpc（见 §1.5） |
| 归档：退役流程要 daemon 打包会话 | 下行 `runtime.archive_sessions` + 上行 `runtime.archive_sessions_result`（见 §4.1）；**不**复用 `pending_command` |

条件 HTTP 清单：`GET /api/daemon/tasks/:taskId/status` 仅在飞书 bot 轮询任务时出现，
不是 daemon 空闲稳态轮询。15 分钟空闲窗口的 HTTP 请求数仍为 0；飞书任务活跃时
该 GET 允许按其任务轮询节奏发出。将这条读取迁至 WS 留待单独处理。
旧 human-request 卡片 HTTP 调用已从 daemon 消费端移除；卡片生成和答复路由由 S4 改接 decision 消息。

### 4.1 归档为什么不用 `pending_command`

`pending_command` 是**通用 shell 通道**（`{command, args, timeout_ms}`，daemon 直接
`executeRuntimeCommand`），把归档塞进去等于让服务端远程执行 shell（裁决 6a）。改用一对类型化帧：

- 下行 `runtime.archive_sessions { request_id, subjects: [{ kind: "issue"|"chat"|"task", id }] }`，
  可靠 evt，实体 id = `request_id`，由 DB 状态重推导；
- 上行 `runtime.archive_sessions_result { request_id, status, archive_ids, error? }`，
  可靠 evt，走 `rt:` 分区。

派生表 `multiremi_session_archive_requests` 由 B6 提供，状态机
`pending → sent → acked → completed/failed` 与其它 `pending_*` 一致；A-4 只接推送与状态机。
退役 plan 的 `blockingReasons` 加 `unarchived_hot_traces`：进入 retire 流程时写 request 行。
daemon 端执行归档本身与上传仍走 HTTP（§4 保留），归 B6。

## 5. 实时 trace 流

### 5.1 事件 schema 只定义一份

`packages/contracts/src/trace.ts` 是唯一定义：daemon 的 trace 文件行、`trace.append` 帧、
C 的 Live Hub 元素、B 的归档 conversation log 都直接用它。谁要加字段，改这一个文件并在三单同步。

字段与 `TaskMessageInput` 一一对应、无损（B 的回填要能还原每一行历史），唯一的命名差异是
`toolCallId` → `tool_call_id`。

**`type` 是开放的 `string`，不是闭合枚举**（裁决 1）。daemon 写文件与 B 回填都原样保留字符串，
不改写、不丢。`KNOWN_TRACE_EVENT_TYPES` 只供前端/飞书 switch 穷举与直方图分桶，**不是校验器**；
`KnownTraceEventType` 这个闭合联合类型存在，但不允许用作任何字段的类型。

已知的 13 种取值，从生产者而不是从查看处读出：

`execution`、`text`、`thinking`、`compaction`、`usage`、`plan`、`tool_use`、`tool_result`、
`permission_request`、`permission_response`、`question_request`、`question_response`、`steer`。

**不含 `assistant` 与 `error`。**`assistant` 是已被 e1d88572 删掉的陈旧生产者（mapper 产出 `text`）；
`error` 只出现在前端展示联合类型和浏览器 socket 的握手帧上，没有任何 daemon 写入者产出它。
展示层要显示 error 或 assistant 行由它自己派生，不能指望线上出现。历史数据里若出现这两种或任何
未知 type，回填**原样保留**，不归一成 `text`。

`ts` 是 **ISO 8601 字符串**，不是数字。回填时 `ts` 就等于 `task_messages.created_at`，逐字段可比对。
帧封装上那个数字 `ts` 是另一层，不受影响。

`input` / `meta` 是 JSON **对象**，不是字符串（生产上有 112 行 meta 含 `\u0000`，在 Bun 里是合法 JSON；
B8 回填在 Bun 里解析，SQL 里不用 `::jsonb`）。

字段字节上限整套从服务端现行规则搬到 daemon 的 `TraceStore.append`（裁决 6b）：

| 字段 | 上限 |
|---|---|
| `tool` | 512 B |
| `content` | 256 KiB |
| `input` | 256 KiB |
| `output` | 64 KiB |
| `meta` | 64 KiB |

`input` / `meta` 另有 JSON 深度 8、数组 256、**base64 消隐**（长度 > 4096 且形如 base64 的字符串）
三项结构处理，与 `sanitizeTaskMessageJson` 一致。UTF-8 边界的截断方式（按字节切、去掉尾部
U+FFFD、追加 `… [truncated]`）也逐字一致。实现是 `packages/shared/src/trace-sanitize.ts`，
由 `tests/unit/daemon/trace-sanitize-equivalence.test.ts` 用同一组夹具同时喂给它和
`tasks-repo.ts` 的现行实现，断言输出相等；A-6 删掉旧写路径时该测试的 tasks-repo 一侧随之删除。

`TaskMessageBatcher` 的 64 KiB 是 text/thinking 的**合并上限**，不是截断上限（裁决 6b）；
截断上限只有 `TraceStore.append` 一处。

生产数据佐证：库里 `input` 正好卡在 256 KiB 的有 187 行，`output` 卡在 64 KiB 的有 2,492 行。

### 5.2 seq 连续分配、只追加

`TraceStore.append` 在**写盘那一刻**为每个 task 从 1 起**连续**分配 seq（裁决 2），
`seq` 与 `ts` 都由它分配（实时路径按本地时钟盖章；回填路径用事件自带的
`ts = task_messages.created_at`，见 §5.1），已写入的 seq 永不重写。

今天 `TaskMessageBatcher` 合并时会沿用首片 seq、留下空洞；**这个旧 seq 在 v2 里作废**。
seq 连续是 Hub「丢弃 `≤ head` 的事件」这条规则成立的前提，也是「`first_seq..head` 连续无洞」
这条断言能成立的原因（该断言只适用于新写的实时 trace，见下）。

**不允许「同一个 seq 后写覆盖」。**读端遇到重复 seq 视为数据损坏：取先出现的一条，不做后写覆盖。
写盘 crash 留下的半行（无换行结尾）读端丢弃。v2 里这个容忍的成因已消失——今天的同 seq 重写来自
outbox 跨 record 重新 coalesce 后再发，而 trace 不进 outbox。

这两条（半行丢弃、重复取先）是**文件读端**的规则，由 B3 的 `trace-file-store.ts` 实现：
A-0 的内存 store 自己分配 seq，不可能产出重复 seq 或半行。内存实现只保证「已 close 不再接受追加」
与「seq 从 1 连续」，文件版要额外满足上面两条，B3 的验收里包含它们。

事件本身不带 `task_id`，由外层容器（`trace.append` 的 `p.task_id`、文件头、订阅）携带。

**连续性断言只针对新写的实时 trace。**回填出来的历史 trace 保留原来的稀疏 seq，
不能断言连续，也**不能断言 `head = event_count`**（A11）；对账历史成员要用 `event_count`。
这是 `head` 与 `event_count` 在 `task.complete.trace` 里分成两个字段的原因。

`closed` 是 trace 唯一的终态信号（裁决 3），出现在 `TraceStore.head()`、reader 结果、
`trace.read` / `trace.fetch` 的应答、`trace.push` 与 Hub 订阅上。**不存在 `trace.end` 事件**，
它的 type 名已作废；文件首行与末行是文件框架行，**不带 `seq`，不占 seq 0**，也不经
`TraceStore.read`、`trace.append` 或 Hub 流出。读端判定：有整数 `seq ≥ 1` 的行才是事件。

### 5.3 三条接口

| 接口 | 归属 | 实现者 |
|---|---|---|
| `TraceStore`（`worker/trace-store.ts`） | A 定义 | A-0 内存版；B 的 `trace-file-store.ts` 实现文件版 |
| `TraceSink`（`api/trace/trace-sink.ts`） | A 定义 | A-0 内存版；C 的 Live Hub 实现真实版 |
| `DaemonTraceReader`（`api/trace/daemon-trace-reader.ts`） | A 定义 | A-6 |

`TraceStore` 的签名（A2）：`append(taskId, events: Omit<TraceEvent, "seq" | "ts">[]) → { head, events }`，
seq/ts 与截断都在这里做；`read(taskId, afterSeq, limit, maxBytes) → { events, head, eof }`；
`head(taskId) → { head, closed } | null`；`close(taskId, { status, ended_at })` 写末行，幂等，首次生效。

`TraceSink.subscribe(taskId, fromSeq, onEvents)` 返回 `{ first_seq, head, gap, closed, unsubscribe }`。
`gap` 为真表示 `fromSeq` 早于 sink 还能提供的最早序号，调用方须用 `DaemonTraceReader` 补齐；
订阅仍会投递它能提供的部分，所以缺口让视图降级而不是静默。

**trace 的终态信号就是 `closed`**（裁决 3），它回答的是 C 在 `cmt_61c2frz1ta03` 里提的问题：
不存在 `trace.end` 事件，也不要再等一个特殊 type 的行；`head()`、reader 结果、`trace.read` /
`trace.fetch` 应答、`trace.push`、Hub 订阅上都带这个布尔值。`head` 与 `closed` 都是**活值**
（订阅创建后仍随状态变化读取），否则一个长驻订阅看不到 head 前进或 trace 收尾。

命名说明：MUL-402 方案里的 `HotTraceSource` 就是 `DaemonTraceReader`，只保留这一个名字；
B 的 `cursor` 就是本接口的 `after_seq`，B 的 `not_found` 对应 `trace_not_hot`，
B 的 `unreachable` 对应其余三种错误。

### 5.4 daemon 侧改造

`TaskMessageBatcher` 的出口从 outbox 改为 `TraceStore.append`，随后 `TraceStreamer` 按 head 读游标
发 `trace.append`。daemon 上只有一份数据：trace 文件既是被上传的内容，也是重放缓冲。
`trace.append` 的外层信封用 `id`/`re`，不带 `seq`，应答仍捎带 `hub_head`；带 `seq`、
不带 `id` 的误用按 RPC 拒绝为 `protocol_violation`，不追加事件。丢失应答后按服务端 head
重发，服务端按 task 内事件 seq 幂等，不使用 outbox 或滑动窗口。

**trace 不进 outbox。**B 已经要写规范化 trace 文件，再进 outbox 就是双写，而且这个量级
（线上 4.9M 行）会把 SQLite outbox 变成瓶颈。

`trace.append` 每帧 ≤ 256 条或 ≤ 256 KiB，**但至少 1 条**。单条事件最坏约 640 KiB
（content 256 + input 256 + output 64 + meta 64 KiB），在 1 MiB 协议帧上限内，也远低于
`maxPayloadLength` 4 MiB。`TaskMessageBatcher` 现有 200 ms / 16 KiB 触发与 64 KiB 合并上限保持
（那是合并上限，不是截断上限）。

### 5.4b 完成帧的轮次卡字段

`turn.complete` 与 `task.fail` 在现有载荷上加三项（裁决 5）：

```ts
trace: {
  head: number; event_count: number; closed: true;
  tool_call_count: number;                                        // tool_use 事件数
  type_histogram: Array<{ type: string; tool: string | null; count: number }>;
};
final_reply_md: string | null;
model: { provider: string; model: string } | null;                // 最后一条 execution 事件的 meta
```

- `type_histogram` 按 `(type, tool)` 分桶，`tool` 只在 `tool_use` / `tool_result` 上非空（A11）；
  organizer 今天就是这么算的（`api/helpers/organizer.ts:52-58`），只按 type 会让它丢掉工具维度。
- `final_reply_md` 由 `deriveFinalReply(events)` 产出，规则见 §5.4c。服务端收到即写轮次卡；
  字段缺失或畸形时，终态照常生效，卡片留空并打日志；卡片字段永不阻塞终态。不去读 trace 补算。
- `turn.complete` 的回复在 `reply: {body_md, message_kind}` 中，载荷另带 `turn_id`、`attempt_id`、`input_to_seq`；不再上报旧 `output`。卡片的最终回复以 `reply.body_md` 为准。
- `head` 与 `event_count` 分开：新写的 trace 两者相等，**回填的历史 trace 是稀疏的**，
  `head ≠ event_count`（A11）。

历史 HTTP 入口 `POST /api/daemon/tasks/:taskId/complete|fail` 已退役；以下描述其 trace 迁移口径。
B5 只读取其中的 `event_count`：非负安全整数才有效，非法值按未提供处理并记一条 warn。
只有明确的 `event_count === 0` 才把热指针写成 `none`；缺失或正数保留 daemon 指针，
不通过旧消息表推断空 trace。旧的空任务因此可能暂时返回 `unreachable` 或 `not_found`，
由 B8 回填在确认旧表无事件且没有 archive member 后写成 `none`。

### 5.4c `deriveFinalReply` 与直方图

`packages/shared/src/trace-derive.ts` 提供三个纯函数，daemon 完成时与 B8 回填**共用**，
新卡片与历史卡片才对得上：

- `deriveFinalReply(events)`：从 `connectors/src/feishu/cot-timeline.ts:47-58` 与 `:32` 抽出。
  顶层（无 `meta.parent_tool_call_id`）`text` 里 `meta.phase === "final"` 的追加到 `final`；
  `phase === "commentary"` 的只结束候选段、自身不参与回答；其他顶层 `text` 追加到 `candidate`；
  `thinking / tool_use / permission_request / question_request / plan / compaction` 这六种
  事件结束候选段；嵌套事件既不贡献也不结束。`final` 非空白则用它，否则用 `candidate`，结果 trim。
- `traceTypeHistogram(events)` / `countToolCalls(events)`：给完成帧与回填算同一份直方图与计数。
- `deriveTraceModel(events)`：取最后一条同时带 provider 与 model 的 `execution` 事件。

**这里有一处与裁决措辞的偏差，需要指出**：裁决 5 把第二条规则描述为「取最后一个非 text 事件之后的
顶层 text 连续段」。按代码实测，`cot-timeline.ts:56` 只在上面那六种类型上 flush 候选段；
`tool_result`、`usage`、`execution`、`steer`、`*_response` 都**不**结束候选段
（`text → usage → text` 是一段，`text → tool_use → text` 才是两段）。另外嵌套事件在
`:42-46` 提前 return，所以它们也不 flush。我按**代码**实现，并写了逐事件对照的等价用例；
如果裁决想要的是「任何非 text 都断开」，那是一行改动，但会让新卡片与现有飞书卡片不一致。

### 5.5 续传与冷启动

`welcome.trace_heads[task_id]` 给出服务端已知 head，daemon 从 `head + 1` 读文件续传。

服务端重启后 head 归零，daemon 只回放**尾部至多 2 MiB 或 2,000 条**，Hub 记录 `first_seq`；
更早的部分由页面走 `trace.read`（§6）或 B 的归档补齐。这是有意的降级：重启后把整个 trace
全量推一遍会把一次部署变成一次流量尖峰。

### 5.6 daemon 侧飞书 connector 的订阅帧

飞书 CoT 的 connector 跑在 daemon 上，今天每 400 ms 轮询一次
`GET /api/daemon/tasks/:id/messages`，该路由在 v2 里要删掉。协议提供四个帧：

- `trace.subscribe{task_id, from_seq}`：rpc，返回 `{first_seq, head, closed, gap}`；
- `trace.unsubscribe`；
- 下行 `trace.push{task_id, events, closed}`：每个订阅内保序，`closed` 表示该 task 的 trace 已收尾；
- `trace.fetch{task_id, after_seq, limit}`：rpc，服务端调 B 的 `readTrace` 补缺口。

B 方案里的 `GET /api/daemon/tasks/:id/trace` 改用 `trace.fetch`，不新增这条 HTTP 路由。
实现在 A-6；connector 从轮询切到订阅归 C。

### 5.7 与 B、C 的切换边界

- A（本单）**只删写路径**：daemon 不再产 `messages` outbox 记录，服务端删
  `POST /api/daemon/tasks/:id/messages` 与 `appendTaskMessages` 的 daemon 入口。
- B（MUL-402）负责删表与指针路由；C（MUL-403）负责前端与飞书 CoT 改订阅 Hub。
- A 一行不动 `multiremi_task_messages` 的读者（`routers/tasks.ts:385/433`、
  `helpers/organizer.ts:53`、`routers/issue-shares.ts:166/173`、飞书 CoT）。
- 三者在 `v2-integration` 合流 PR 里同时存在，缺一不合。

## 6. 反向 RPC `trace.read`

daemon 上唯一的只读方法，供 B、C 读热 trace。

```ts
DaemonTraceReader.read({
  taskId, runtimeId, afterSeq = 0, limit = 200, maxBytes = 1 MiB, timeoutMs = 10_000,
}) → { ok: true, events, next_after_seq, head, eof, closed }
   | { ok: false, code, runtime_id?, last_seen_at? }
```

`runtimeId` 是必填（裁决 4）：B 的指针里存的就是它，服务端用自己的注册表做
`runtimeId → daemonId` 路由，比先查 task 表再拿 runtime 少一次查询。

A-0 除接口外还提供内存假实现 `InMemoryDaemonTraceReader`，按 `runtimeId → TraceStore` 路由：
runtime 不在（无可用连接）返回 `daemon_unreachable`；`store.head(taskId) === null` 返回 `trace_not_hot`。
`daemon_busy` 与 `daemon_timeout` 属于 socket 层，由 A-6 的真实实现补上，假实现不假装有。

**端点归属**（裁决 4）：页面与分享的 `GET /api/tasks/:id/trace`、
`GET /api/shares/:token/tasks/:task_id/trace` 归 B5（MUL-429），鉴权用 `canUserViewTaskMessages`；
concierge 走 WS rpc `trace.fetch`，**不保留** daemon 侧的 HTTP 读路由（今天它在
`GET /api/daemon/tasks/:id/messages?since_seq` 上每 400 ms 轮询，由 A-6 删除）。

- **cursor**：`after_seq` 是整数，与 B 文件行的 `seq` 同一含义；第一条返回的事件满足
  `seq > after_seq`。B 的文件需能按 seq 定位（索引或顺序扫描均可，B 定）。
- **上限**：`limit ≤ 500`，`max_bytes ≤ 1 MiB`，超出截断并返回 `eof: false`。单条事件大于
  `max_bytes` 时仍单独返回，否则读者会死锁。
- **并发**：每连接最多 4 个在途 `trace.read`，排队上限 32，超出即 `daemon_busy`。
- **超时**：默认 10 s，超时返回 `daemon_timeout`。
- **鉴权**：daemon 侧校验该 task 属于本进程的 runtime，否则 `trace_not_hot`。页面侧 HTTP 接口与
  鉴权由 C 定义，沿用 `canUserViewTaskMessages`。
- **离线**：无存活连接时返回 `daemon_unreachable`，附 `runtime_id` 与 `last_seen_at`；页面按 §5
  降级显示为「不可达」，而不是空 trace。
- **`trace_not_hot` 的判定**：daemon 端 `TraceStore.head(taskId) === null`（裁决 4）。已 `close`
  的 trace 仍然是热的、仍然可读，不是 `trace_not_hot`。

`eof` 表示本页读到了当前 head；`closed` 表示 trace 已写尾（任务结束）。两者分开，因为运行中的任务
经常处于 `eof` 但永远不 `closed`。

命名统一：**表示完整性的那个布尔值一律叫 `closed`**，不再有 `ended` 布尔、`isEnded()` 或
`trace.end` 事件。唯一的 `ended` 出现在 `close(taskId, { status, ended_at })` 的
`ended_at` 时间戳字段名里——那是一个时刻，不是状态标志。

## 7. 版本协商与升级通道

### 7.1 hello / welcome / reject

```
daemon → hello   { protocol: 2, daemon_id, cli_version, launched_by,
                   runtimes: [{ runtime_id, provider, max_concurrency, active_task_ids,
                                capabilities: { supports_batch_import, supports_directory_scan,
                                  supports_skill_directory, supports_bot_menu,
                                  agent_plugin_protocol, feishu_concierge_protocol,
                                  feishu_decision_card, feishu_issue_decision_card } }],
                   caps: ["offer", "turn.message", "trace.read", "trace.subscribe"] }
server → welcome { protocol: 2, server_version, min_cli_version, session_id,
                   hb_interval_ms: 15000,
                   limits: { frame_bytes, window_frames, window_bytes },
                   trace_heads: { [task_id]: head }, caps: [...] }
server → reject  { code: "daemon_protocol_upgrade_required", min_protocol: 2,
                   min_cli_version, hint }   然后 close(4426)
```

服务端在首次派活或推送前写入 `hello` 的 runtime 能力；重连时重新声明。连上后能力变化由下一次
`hb` 更新。上述能力缺失均按 false/0 处理，不能沿用数据库里的旧值。`feishu_concierge_protocol`
达到服务端支持版本时同时表示 `supportsFeishuBotConfig`。

服务端在 `hello` 时按 `protocol` 与 `cli_version` 双重判定。载荷级语义变化随发布用
`min_cli_version` 把关，协议号只在传输与帧封装变化时升；统一消息/轮载荷仍使用协议 2。
新 daemon 收到旧服务端的 `welcome.min_cli_version` 时进入 `upgrade_wait`，停止领轮。
旧形状的 `task.complete` 返回 `report_shape_retired`（`retryable: false`），outbox 隔离该分区。

### 7.2 v1 被拒后怎么升级

这是本单要正面处理的矛盾：**最近几次 fleet 升级全部走心跳 ack 的 `pending_update`**
（008、133、MBP 三台的 `daemon.log` 都有 `Multiremi daemon restarting with updated binary`），
没有人工记录。如果服务端在心跳 handler 里按版本直接硬拒 v1，v1 daemon 就再也拿不到升级指令，
`dmn_40119` 是贺华杰本人的机器，计入「全部 daemon 升到 v2」的验收：先走升级通道，
失败时经 SSH mesh 别名 `212` 登录处理（依据：MUL-401 Q5 答复 `cmt_70sumd6bces1`）。
有 SSH 兜底也不能切断自动升级通道。209 上至今还挂着 `remi-block-retired-daemon.conf` 挡一个 v0.2.27 之前、
不会看 401 停机的 daemon（MUL-368），说明「旧 daemon 卡死」真实发生过。

因此 v2 服务端**不在心跳 handler 里拒绝**，而是把
`POST /api/daemon/heartbeat` 降级为**升级通道**：

- v1 daemon 心跳到达时，若 `cli_version < DAEMON_MIN_CLI_VERSION`，服务端自动
  `createRuntimeUpdateRequest`（目标版本 = 服务端自身 `multiremiVersion`；同 runtime 只保留一个
  pending，失败后每次心跳重建直到 daemon 空闲）；
- ack 只含 `pending_update` 与 `drain: draining`；
- claim 路由永远返回 `{task: null}`；
- 已退役的 v1 路由返回 426 `{code: "daemon_protocol_upgrade_required", min_version}`。

v1 进程在 `upgrade_pending` 期间，每次心跳仍会重发 plugin state POST 并收到 426，
直到升级完成。这是已接受的升级桥行为，不恢复任何 plugin state 写路由。

只有退役路由表中精确匹配 method + path 的 `/api/daemon/*` 请求返回 426，`min_version` 为协议版本 `2`；
从未存在的地址保持原有 404。现存按需 HTTP 路由、心跳升级通道和 `update/:id/result` 继续由原 handler
处理；鉴权与角色 guard 仍在退役路由之前。回归用固定 v1 路由快照与当前活路由快照的差集校验退役表。

v1 daemon 因此拿不到任何任务，但会走它自己的 `handleRuntimeUpdate` 升级并重启。**这不是兼容方案**：
v1 在 v2 服务端上一件活都干不了，保留的唯一能力是「把自己换成 v2」。

### 7.3 v2 daemon 的 upgrade_wait

WS 收到 4426、或收到 v1 服务端的 `ready` 帧（说明服务端回退了）时，daemon 停掉所有 lane 的接单，
每 60 s 调一次升级通道，`/health.protocol = { state: "rejected", server_min, self, next_probe_at }`，
日志固定一句可检索的话：

```
daemon protocol rejected by server (min X, self Y); waiting for pending_update, no tasks will be claimed
```

这条状态机同时是将来任何一次协议升级与回退的通用通道。

### 7.4 fleet 逐台升级路径

| daemon | 设备 | 服务管理 | 升级路径 |
|---|---|---|---|
| `n37-066-008-hehuajie` | n37-066-008 (10.37.66.8) | systemd user unit | 升级通道（历史全部走它）；SSH 兜底可用 |
| `n37-206-133-hehuajie` | n37-206-133 (10.37.206.133) | systemd user unit | 同上 |
| `dmn_5d98ad65…` | GrassgodMBP (macOS，`http://10.66.66.4`) | launchd `dev.remi.multiremi.daemon` | 升级通道；SSH 经 WireGuard 兜底 |
| `dmn_40119cf7…` | 贺华杰；runtime `rt_1wfnlsb`（claude）、`rt_1wlrzjc`（codex） | 切换当天核对 | 升级通道；SSH 经 mesh 别名 `212` 兜底 |

`launched_by = desktop` 的 daemon 会拒绝 CLI 更新（现有逻辑），fleet 里目前没有这种情况。

### 7.4b `DAEMON_MIN_CLI_VERSION` 与载荷发布版本

当前 `DAEMON_MIN_CLI_VERSION` 为明显的未发布占位值 `999.0.0-unreleased-mul507`。
发布负责人集成时必须将其替换为第一个包含本单的正式版本，并校验常量与正式 tag 一致；
`0.2.86` 留给 MUL-496 补丁，不得用作本单门槛。切换前执行[统一模型切换清单](deploy/unified-model-cutover.md)
中的替换步骤，不得携带占位值发版或部署；门槛不表示 fleet 已升级。

### 7.5 升级失败的提示

runtime wire 新增 `protocol: { version, state: "ok" | "upgrade_pending" | "upgrade_failed" | "rejected",
min_version, last_error }`：

- `remi runtime list` 与 runtime 卡片显示「协议 v1 · 升级失败：<error>」；
- `remi platform status` 汇总「待升级 N 台 / 失败 M 台」。

失败来源就是 `multiremi_runtime_update_requests.status = failed` 的 error 字段。

该字段只从数据库推导，不读取 v2 会话注册表。成功的 `hello` 将协议版本与 CLI 版本写入
runtime 的可空 `daemon_protocol_version` 列与既有 `metadata.cli_version`；旧行的空值按 v1 读。
HTTP 升级探测不覆盖最近一次成功协商的版本。当前 v2 且 CLI 达标时为 `ok`；否则优先查看
CLI 升级请求：pending/running 为 `upgrade_pending`，最近一次 failed 为 `upgrade_failed`，
其余为 `rejected`。ACP/agent 更新失败不算协议升级失败。平台汇总按 daemon 去重计数，
失败优先于待升级，未排队的 `rejected` 也计入待升级。

迁移只给 runtime 表新增一个可空列，不回填、不修改升级请求表。旧版代码不读取该列即可回退，
无需删除列；切换与回滚核对见 [v2 切换清单](deploy/daemon-v2-cutover.md)。

### 7.6 回滚

分两个时点。**B 删表之前**：服务端回退到 v1 镜像后，v2 daemon 进入 `upgrade_wait`，
对每个 runtime 执行 `remi runtime release start --version <旧版>`，daemon 通过同一条升级通道降级；
fleet 出现短暂断供（每台 ≤ 2 min）。**B 删表之后**：只能前向修复，这一点由 B 的删表审批单独承担，
本单不再另设回滚。

## 8. 背压与大小上限

生产实测：nginx 到 API 一跳直连（不过 Next.js），`proxy_read_timeout` 1 h，Bun `idleTimeout` 120 s，
`maxPayloadLength` 未设置，`perMessageDeflate` 未启，现有 `sendText` 不读返回值也不做背压。

v2 显式设置：

| 项 | 值 | 理由 |
|---|---|---|
| `Bun.serve.maxPayloadLength` | 4 MiB | 高于协议上限，违规帧要能完整到达才能回 `protocol_violation` |
| 协议单帧上限 | 1 MiB | |
| `backpressureLimit` | 4 MiB | |
| `closeOnBackpressureLimit` | false | 背压时暂停，不断连 |
| `idleTimeout` | 120 s | 保持现状 |
| `perMessageDeflate` | 不开 | 内网单跳，nginx 的 gzip_types 也是注释状态，压缩换不到收益；要开另开单测 |

**上行超限帧怎么处理（不能只关连接）。** `maxPayloadLength` 取 4 MiB 的意义就是让超过协议上限
（1 MiB）的帧**完整到达**，能回一个 `protocol_violation` 而不是被截断。关连接在这里是错的：daemon
重连后会重放同一条未确认的 outbox 行，同一条超限帧再被断开，形成无限循环。规则是：

| 超限帧 | 处理 |
|---|---|
| 可靠事件，信封里能读出 `seq` | 回 `res{re: seq, ok:false, code:"protocol_violation", retryable:false}`，不处理内容，连接保持。daemon 据此隔离/blocked 那一行 |
| RPC，信封里能读出 `id` | 回 `res{re: id}`，其余同上 |
| 两个都没有 | close **4002** |
| 整帧解析不出信封 | close **4002**。这种帧引用不到 outbox 行，只能由客户端在入 outbox 前挡住（归 A-5） |

`res` / `ack` 与 `hb` 的答复不受下行窗口限制。`violations` 计数照旧。

**下行窗口要真正执行。** `welcome` 里的 `window_frames: 64` / `window_bytes: 1 MiB` 不只是宣告：
`sendEvent` 在发送前按未确认帧数与字节数记账，窗口满时**拒绝发送且不占用 seq**（与暂停同一个规则）。
返回值区分**四种**拒绝，调用方的下一步动作各不相同：

| 拒发原因 | 含义 | 调用方动作 |
|---|---|---|
| `window_full` | 未确认帧数或字节数已到窗口上限 | 等 ack 腾出空间，从 DB 重新推导后重推 |
| `paused` | socket 处于背压暂停 | 等 drain 后重推 |
| `too_large` | 单帧编码后超过 `frame_bytes`（1 MiB） | `task.offer` 先降级并截短异常长路由字符串；结构仍超硬限才以 `offer_too_large` 一次性失败并报告尺寸。不置 Issue blocked、不等待容量、不冷却，继续后续任务。其他实体丢弃并记录诊断；不等 ack |
| `closed` | 连接已关闭或 socket 丢弃了帧 | 放弃这条连接，等重连后重建 |

`too_large` 是服务端内部类型（`DaemonSessionSendRefusal`），不是协议契约的一部分。ack 腾出空间后
由回调通知重推，**不建内存队列**：§2.1 已经规定 DB 就是下行队列，推送方从 DB 重新推导。

发送侧：服务端读 `ws.send` 返回值，`-1` 表示已排队但有背压 → 暂停 offer 与非关键推送，等恢复；
`0` 表示连接已坏 → 注销连接。`res` / `ack` 不受暂停影响。daemon 侧 `bufferedAmount > 2 MiB`
暂停 outbox 泵与 trace 泵，降到 512 KiB 以下恢复；trace 泵优先级低于 outbox 泵。

`hb` 每 15 s，远小于 Bun 的 120 s 与 nginx 的 1 h。
