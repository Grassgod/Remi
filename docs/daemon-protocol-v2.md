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

## 1. 连接与帧

### 1.1 一个进程一条 socket

daemon 以 Bearer daemon token 连接 `GET /api/daemon/ws`，**每个 daemon 进程一条 socket**，
由 `hello` 帧列出本进程的全部 runtime。服务端按 runtime 逐个复核归属、workspace 与成员资格，
与今天的 `authorizeDaemonWebSocketRequest` 同一套判定。

选单 socket 而不是每 runtime 一条，因为升级、drain 与 CLI 更新锁（`MultiremiCliUpdateCoordinator`）
都是进程级动作：两条 socket 会让同一台机器的两个 lane 看到顺序不一致的指令，也会让 `seq`
需要两个作用域。

服务端注册表以 daemon 为单位（`Map<daemonId, DaemonSession>`），并维护 `runtimeId → daemonId`
索引供 `trace.read` 定位。同一 runtime 出现两条连接时，新连接生效，旧连接以 4001 关闭。

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
| `best_effort` | `hb`、`runtime.ready`、`concierge.status` | 不带 `seq`，不重放 |
| `event` | 见下 §1.4 | 带 `seq`，未确认前重放 |
| `rpc` | 见下 §1.5 | 按 `id`/`re` 配对，由调用方重试 |
| `reply` | `res` | 答复某个 rpc |
| `ack` | `ack` | 独立累计确认 |

设计初稿曾把这些压成五类，把 `res` 并进 rpc、把 `hb` 当作唯一的尽力而为帧。两者在代码里都不成立：
应答与请求的校验路径不同，而 `runtime.ready` 与 `concierge.status` 之所以尽力而为，与 `hb`
是同一个理由——它们都能从本地状态重算，丢一帧没有代价。

`best_effort` 与 `rpc` 都不参与滑动窗口，也不带 `seq`。

### 1.4 可靠事件清单

**daemon → server**（进本地 outbox，见 §2）：

`task.start`、`task.prompt`、`task.session_pin`、`task.progress`、`task.usage`、`task.workspace`、
`task.complete`、`task.fail`、`runtime.update_result`、`runtime.command_result`、
`runtime.model_list_result`、`runtime.local_skills_result`、`runtime.directory_scan_result`、
`runtime.local_skill_import_result`、`runtime.bot_menu_result`、`feishu.outbound_result`、`plugin.state`、
`runtime.archive_sessions_result`（`rt:` 分区）。
另有 `trace.append`，可靠但**不进 outbox**，见 §5。

**server → daemon**（由 DB 状态重推导，无服务端队列，见 §2.3）：

`task.offer`、`task.cancelled`、`task.steer`、`task.human_request.settled`、`runtime.update`、
`runtime.command`、`runtime.model_list`、`runtime.local_skills`、`runtime.directory_scan`、
`runtime.local_skill_import`、`runtime.bot_menu`、`runtime.profile`、`feishu.outbound`、
`feishu.directive`、`ssh_mesh.reconcile`、`platform.drain`、`plugin.desired_revision`、`workspace.settings`、
`runtime.archive_sessions`。

### 1.5 RPC 清单

**daemon → server**：`steer.consume`、`human_request.create`、`human_request.expire`、`plugin.desired`、
`trace.head`、`trace.subscribe`、`trace.unsubscribe`、`trace.fetch`、`gc.check_issue`、
`gc.check_chat_session`、`gc.check_autopilot_run`、`gc.check_task`、`gc.workspace_cleaned`。

**server → daemon**：`trace.read`。

RPC 应答的 `t` 固定为 `res`，`p` 为 `{ "ok": true, ... }` 或
`{ "ok": false, "code": <错误码>, "message": "人话", "retryable": <bool> }`。

`gc.check_*` 与 `gc.workspace_cleaned` 是 A-5 从周期性 HTTP 平移过来的维护扫描（原 15 分钟一轮、
每天约 13 次/分钟的 `gc-check` 请求）。它们不是等活轮询，但留在 HTTP 上「轮询降到 0」在 nginx
日志口径就不成立，因此一并改成 RPC；不做批量合并。

### 1.6 错误码与 close code

错误码共 17 个，定义在 `DAEMON_PROTOCOL_ERROR_CODES`，分四组：握手 2 个、上报 4 个、
offer 与派活 5 个、trace 与传输 6 个。

`DAEMON_RETRYABLE_ERROR_CODES` 只有 `daemon_busy` 与 `daemon_timeout`；其余都是确定性结果，
重发无益。`DAEMON_TERMINAL_ERROR_CODES`（`authority_revoked`、`task_not_found`、
`invalid_report`）会让该分区停摆，语义等同于今天 HTTP 侧的终态鉴权错误
（`isTerminalDaemonAuthorityError` 的 401/403/410）。

报送类错误码取代 HTTP 状态码：

| 原 HTTP | 帧错误码 |
|---|---|
| 404 task not found | `task_not_found` |
| 401 / 403 / 410 | `authority_revoked` |
| 其他确定性 4xx | `invalid_report` |
| `start` 的 400「已离开 dispatched」（原本就是成功） | `start_replayed` |

close code。协议**只显式列出四个终态码**，其余一律默认重连：

| code | 含义 | 是否重连 |
|---|---|---|
| 4401 | 凭证被吊销 | **否**，终态 |
| 4403 | token 缺少该 socket 的权限 | **否**，终态 |
| 4410 | daemon 已退役 | **否**，终态 |
| 4426 | 需要协议 v2 | **否**（进 `upgrade_wait`，改走升级通道） |
| 4000 | `ack_timeout`：15 s 内未确认 | 是，走退避 |
| 4001 | 服务端正常关闭（发布、重启） | 是，走退避 |
| 1000 / 1001 | 正常关闭 / going away | 是，走退避 |
| 1006 | 异常关闭（断网、服务端被杀） | 是，走退避 |
| 1011 / 1012 / 1013 | 服务端错误 / 重启 / 稍后重试 | 是，走退避 |
| 其他未知码 | — | 是，走退避 |

**默认是「重连」，只有上面那四个是终态**（`DAEMON_TERMINAL_CLOSE_CODES`，
判定函数 `daemonCloseCodeIsRetryable`）。这个方向是刻意的：断网与被杀时 daemon 实际拿到的就是
**1006**（异常关闭，由客户端栈产生，对端根本不会发这个码），如果写成「默认终态、只列出可重连」，
A-2 照字面实现就会永不重连，那台机器只能靠 SSH 救回来。默认重连的代价只是某个没预料到的码多退避几次。

4426 虽然也在终态列表里，但它不是死路：`daemonCloseCodeRequiresUpgrade(code)` 单独把它标出来，
A-2 用它进入 `upgrade_wait`（§7.3）而不是单纯停止重连。另外三个终态码没有这样的后续动作。

## 2. 可靠性、序号与重放

### 2.1 三条流三种缓冲

**上行可靠帧：`seq` 就是 outbox 行 id。**`outbox_events.id` 是 AUTOINCREMENT，跨进程重启持久且
单调，天然满足「每 daemon 会话、跨重启」的作用域。重放缓冲就是 outbox 本身：行未删即未确认。
泵按 id 顺序单泵发送，滑动窗口取 64 帧或 1 MiB 先到者；服务端逐帧回 `res{re: seq}`，`ok` 即删行。
`ok:false` 且 `retryable:false` → 该分区（task 或 runtime）进入 blocked，与今天
`isPermanentDeliveryError` 的语义一致。

`outbox_events.task_id` 语义扩展为分区键：runtime 级记录写 `rt:<runtime_id>`。每分区内保序，
分区间可并行。断线期间照常入库，重连后从最小未删 id 续发。

**下行可靠帧：`seq` 每连接从 1 起，只在内存。不建服务端持久队列——DB 就是队列。**

| 帧 | 重连后从哪里重新推导 |
|---|---|
| `task.offer` | `multiremi_tasks` 中 queued / dispatched 的行 |
| `task.steer` | 未消费的 steer 行 |
| `task.cancelled` | 任务已终态而 daemon 仍在跑 |
| `task.human_request.settled` | human request 的状态 |
| `runtime.*` 各类待办 | 各自请求表 |
| `platform.drain` | 平台维护状态行 |
| `plugin.desired_revision` | `desiredRevision` |
| `runtime.archive_sessions` | `multiremi_session_archive_requests` 中 status=pending 的行（B6 提供） |

daemon 按实体 id 去重（`activeTaskIds`、`runtimeModelListRequests`、steer 的 `seen` 集合今天就有，
补齐 update / command / skills 的同类集合即可）。服务端对每条下行可靠帧记发送时刻，15 s 未 ack
即关连接（4000），由重连后的快照重推兜底。

**trace 流：** 见 §5。

### 2.2 不丢不重

| 场景 | 上行可靠帧 | 下行可靠帧 | trace 流 |
|---|---|---|---|
| daemon 重启 | outbox 行仍在，启动后按 id 续发；服务端幂等吸收重复 | 重连后快照重推，实体 id 去重 | 从 `welcome.trace_heads` 续传；文件是唯一来源 |
| 服务端重启 | daemon 收到 close，走 1 s→30 s 抖动退避；窗口内未 `res` 的帧不删行，重连后重发 | 服务端无状态可丢，从 DB 重推导 | head 归零，daemon 回放尾部，Hub 记 `first_seq` |
| 任务进行中断线 | 同上；`task.complete` 永远在其 task 分区最后，不可能先于 progress 到达 | 断线期间新 steer / 取消留在 DB，重连后推 | 同上 |

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
| `task.progress` | task id | 覆盖写 |
| `task.session_pin` / `task.workspace` | task id | 覆盖写 |
| `task.usage` | task id + provider + model | 合并 |
| `task.complete` / `task.fail` | task id | 已终态即 ok |
| `runtime.*_result` | request id | 状态机 pending→running→completed/failed 只能前进 |
| `plugin.state` | request id | 同上 |
| `runtime.archive_sessions` | request id | 状态机 pending→sent→acked→completed/failed 只能前进 |
| `runtime.archive_sessions_result` | request id | 已终态即 ok；重复结果被幂等吸收 |
| `trace.append` | `(task_id, trace_seq)` | Hub 丢弃 `≤ head` |

## 3. 推送派活

### 3.1 offer / accept / reject 取代 claim

服务端每 runtime 一个常驻单飞泵（沿用 `preparingClaims` 的单飞思想），触发源四个：
`onTaskEnqueued`、任务终态或 reject 释放容量、`hb` 报告的 `active_task_count` 变化、`hello`。

泵每次跑现有 `store.claimTask(runtimeId)`：选任务、置 `dispatched`、**只 hydrate 选中的任务**
（MUL-389 的原样保留），把今天 claim 响应的内容（含 `auth_token`）作为 `task.offer` 载荷推出。

daemon 收到 offer：有空位且未暂停 → `res{ok:true}` 即 accept，随后照常发 `task.start`
（start 仍是独立可靠帧，因为 workspace 准备可能先进入 `wait_local_directory`）；否则
`res{ok:false, code}`，code 取 `capacity` / `claims_paused` / `draining` /
`binary_skill_files_unsupported`。

reject、30 s 未应答、或连接断开 → 服务端把任务 `dispatched→queued`，并对该 runtime 冷却 30 s
（内存态）。`CLAIM_RESPONSE_RECOVERY_MS`（90 s）的重领逻辑保留为最终兜底。

### 3.2 并发上限、租约与断线

并发上限不变：`claimTask` 的选择查询已按 `dispatched + running` 计数封顶 `maxConcurrency`，
offer 只在有空位时发。dispatch-lease 的 2.5 s 续租取消，租约改为「连接存活 + accept」。

daemon 断线期间：queued 留在队列；dispatched 未 accept 的按 §3.1 重排；running 的保持 running
（与今天一致），trace 暂停、页面按 §6 显示不可达。重连后 daemon 发 `runtime.ready{active_task_ids}`，
服务端对账：DB 已终态而 daemon 仍在跑的推 `task.cancelled`；DB 为 running 而 daemon 没列出的
走 `recoverOrphans`（原 `POST /recover-orphans` 路由删除，逻辑移到这里）。

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

`hb` 上行每 15 s，载荷只含 `active_task_count`、outbox 统计、`drain_ack_generation`。
服务端只做两件事：更新 `last_heartbeat_at`（`RUNTIME_HEARTBEAT_STALE_MS` 5 分钟的规则不动，
platform-maintenance 与 ssh-mesh 继续用它）和记录 drain ack。`heartbeatRuntime` 里 7 类待办的
合并轮询（MUL-389）在 v2 服务端不再由心跳触发。

008 的 `rt_fkmqtl` 被分配为飞书 concierge，今天心跳 3 s；出站改推送后这个 3 s 节奏不再需要。

各 `pending_*` 改为**创建即推**：在各自的写入口挂 store 事件，WS 层订阅并推给对应 daemon。
状态机为 `pending → sent(seq) → acked(claimed) → result`；未 ack 前断连回到 pending，
下次 `hello` 快照重推。

| 今天 | v2 |
|---|---|
| heartbeat ack 捎带 `pending_update` / `pending_command` / `pending_model_list` / `pending_local_skills` / `pending_directory_scan` / `pending_bot_menu` / `pending_feishu_outbound` | 创建即推对应下行帧；`task.complete` 等结果走上行可靠帧 |
| `GET agent-plugins/desired` 30 s 兜底 | 服务端推 `plugin.desired_revision`，daemon 用 rpc `plugin.desired` 拉快照；30 s 兜底取消 |
| desired 的 10 分钟强制刷新（ADR 0001 的「revision 定义漏字段」防御） | 保留，改为 WS rpc；不算轮询 |
| `GET tasks/:id/steer` 2.5 s | 创建即推 `task.steer`，daemon 用 rpc `steer.consume` 标记消费 |
| `GET tasks/:id/status` 2.5 s（取消与 `waiting_local_directory`） | `task.cancelled` 推送；`watchTaskState` 的 2.5 s 定时器删除 |
| `GET tasks/:id/human-requests/:rid` 2 s | `task.human_request.settled` 推送；`human_request.create` / `expire` 走 rpc |
| `GET .../gc-check` ×4 与 `workspace/cleaned` | rpc（见 §1.5） |
| 归档：退役流程要 daemon 打包会话 | 下行 `runtime.archive_sessions` + 上行 `runtime.archive_sessions_result`（见 §4.1）；**不**复用 `pending_command` |

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

**trace 不进 outbox。**B 已经要写规范化 trace 文件，再进 outbox 就是双写，而且这个量级
（线上 4.9M 行）会把 SQLite outbox 变成瓶颈。

`trace.append` 每帧 ≤ 256 条或 ≤ 256 KiB，**但至少 1 条**。单条事件最坏约 640 KiB
（content 256 + input 256 + output 64 + meta 64 KiB），在 1 MiB 协议帧上限内，也远低于
`maxPayloadLength` 4 MiB。`TaskMessageBatcher` 现有 200 ms / 16 KiB 触发与 64 KiB 合并上限保持
（那是合并上限，不是截断上限）。

### 5.4b 完成帧的轮次卡字段

`task.complete` 与 `task.fail` 在现有载荷上加三项（裁决 5）：

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
  daemon 缺字段（同版上线，不应发生）时卡片留空并打日志，不去读 trace 补算。
- `output` 字段保持原样：它是全部顶层 text 的拼接（`worker/daemon.ts:4416`），不随本改动变化。
- `head` 与 `event_count` 分开：新写的 trace 两者相等，**回填的历史 trace 是稀疏的**，
  `head ≠ event_count`（A11）。

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
                   runtimes: [{ runtime_id, provider, max_concurrency, active_task_ids }],
                   caps: ["offer", "steer.push", "trace.read", "trace.subscribe"] }
server → welcome { protocol: 2, server_version, min_cli_version, session_id,
                   hb_interval_ms: 15000,
                   limits: { frame_bytes, window_frames, window_bytes },
                   trace_heads: { [task_id]: head }, caps: [...] }
server → reject  { code: "daemon_protocol_upgrade_required", min_protocol: 2,
                   min_cli_version, hint }   然后 close(4426)
```

服务端在 `hello` 时按 `protocol` 与 `cli_version` 双重判定。`caps` 是加法位：新增帧不升主版本，
删帧或改语义才升。

### 7.2 v1 被拒后怎么升级

这是本单要正面处理的矛盾：**最近几次 fleet 升级全部走心跳 ack 的 `pending_update`**
（008、133、MBP 三台的 `daemon.log` 都有 `Multiremi daemon restarting with updated binary`），
没有人工记录。如果服务端在心跳 handler 里按版本直接硬拒 v1，v1 daemon 就再也拿不到升级指令，
而且 `dmn_40119`（字节 VM `iv-yerno49q0wxjd1vp77df-root`）没有可用 SSH 路径，
等于永久断供。209 上至今还挂着 `remi-block-retired-daemon.conf` 挡一个 v0.2.27 之前、
不会看 401 停机的 daemon（MUL-368），说明「旧 daemon 卡死」真实发生过。

因此 v2 服务端**不在心跳 handler 里拒绝**，而是把
`POST /api/daemon/heartbeat` 降级为**升级通道**：

- v1 daemon 心跳到达时，若 `cli_version < DAEMON_MIN_CLI_VERSION`，服务端自动
  `createRuntimeUpdateRequest`（目标版本 = 服务端自身 `multiremiVersion`；同 runtime 只保留一个
  pending，失败后每次心跳重建直到 daemon 空闲）；
- ack 只含 `pending_update` 与 `drain: draining`；
- claim 路由永远返回 `{task: null}`；
- 其余 v1 路由返回 426 `{code: "daemon_protocol_upgrade_required", min_version}`。

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
| `dmn_40119cf7…` | `iv-yerno…` 字节 VM | 未确认 | **只有升级通道**，无 SSH 路径；主机归属待确认 |

`launched_by = desktop` 的 daemon 会拒绝 CLI 更新（现有逻辑），fleet 里目前没有这种情况。

### 7.4b `DAEMON_MIN_CLI_VERSION` 是占位值

代码里的 `"0.2.83"` 是**占位**，不是既成事实：它必须等于第一个真正携带协议 v2 的 release tag。
由 A-7（MUL-423）在发版那一步钉死，不需要贺华杰定。已验证的行为只有「不可读的版本视为更旧、
必须升级」（有用例锁住）。

### 7.5 升级失败的提示

runtime wire 新增 `protocol: { version, state: "ok" | "upgrade_pending" | "upgrade_failed" | "rejected",
min_version, last_error }`：

- `remi runtime list` 与 runtime 卡片显示「协议 v1 · 升级失败：<error>」；
- `remi platform status` 汇总「待升级 N 台 / 失败 M 台」。

失败来源就是 `multiremi_runtime_update_requests.status = failed` 的 error 字段。

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

发送侧：服务端读 `ws.send` 返回值，`-1` 表示已排队但有背压 → 暂停 offer 与非关键推送，等恢复；
`0` 表示连接已坏 → 注销连接。`res` / `ack` 不受暂停影响。daemon 侧 `bufferedAmount > 2 MiB`
暂停 outbox 泵与 trace 泵，降到 512 KiB 以下恢复；trace 泵优先级低于 outbox 泵。

`hb` 每 15 s，远小于 Bun 的 120 s 与 nginx 的 1 h。
