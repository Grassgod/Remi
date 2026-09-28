---
title: 浏览器实时 v2（stream 订阅与 trace 端点）
status: active
summary: 浏览器 WebSocket 的 v2 帧、两条流的端点与鉴权、断线续传与退避重连、resync 的触发与客户端动作。
---

# 浏览器实时 v2

本页记录 C0 契约（MUL-435）、C3（MUL-438）落地后的浏览器实时协议。Hub 本体、环形缓冲与背压在 C1（MUL-436）；多进程的角色锁与 peer 通道在 MUL-461/462。ADR 0007 是这些取舍的决策记录。

## 两条流、两个端点

| 流键 | 内容 | 序号来源 | 浏览器端点 |
|---|---|---|---|
| `log:<session_id>` | 会话日志（展示单元与隐藏标记） | MUL-402 行自身的 `seq` | `/ws` |
| `trace:<task_id>` | 执行过程 trace | daemon 分配的 `trace_seq` | `/api/trace/ws` |

两个端点各自**只**承载一种流：`/ws` 收到 `stream.subscribe{stream:"trace"}` 回 `stream.error{code:"wrong_endpoint"}`，`/api/trace/ws` 收到 `stream:"log"` 同样处理。这条规则让「订阅发错进程」变成显式错误，而不是一个永远收不到帧的订阅。

trace 流的家在 runtime 进程（ADR 0007 决策一），因此 [api-role.ts](../../packages/server/src/config/api-role.ts) 把 `/api/trace/ws` 放进 runtime 放行清单：nginx 把该路径交给 runtime（MUL-464），ui 进程收到它是 421，不是 426。

## 帧

客户端 → 服务端：

| 帧 | 载荷 |
|---|---|
| `auth` | `{token}`，握手第一帧（cookie 模式省略） |
| `stream.subscribe` | `{stream, id, from_seq}`，`from_seq` 为**排他**游标（下一条想要的序号） |
| `stream.unsubscribe` | `{stream, id}` |
| `ping` | 无 |

服务端 → 客户端：

| 帧 | 载荷 |
|---|---|
| `auth_ack` | 无 |
| `stream.ack` | `{stream, id, first_seq, head_seq, log_version, gap}` |
| `stream.data` | `{stream, id, frames:[{seq, kind, payload}]}`，按 `seq` 升序 |
| `stream.gap` | `{stream, id, from, to}`，订阅期间掉队，需自行补读 |
| `stream.error` | `{stream, id, code}` |
| `resync` | 无 |
| `pong` | 无 |

`stream.error` 的 code 集在 [contracts/live-hub.ts](../../packages/contracts/src/live-hub.ts) 冻结：`invalid_payload`、`forbidden`、`wrong_endpoint`、`unavailable`。`forbidden` 同时用于「不存在」与「无权限」，订阅者无法据此枚举 id；`unavailable` 表示鉴权查询本身失败（只读池饱和/超时），可重试。

`stream.ack.gap` 与 `stream.gap` 不是同一件事：前者是订阅建立时环尾已追不回，后者是订阅期间掉队。

## 订阅鉴权

实现在 [hub/stream-auth.ts](../../packages/server/src/api/hub/stream-auth.ts)，规则只写一次，两种后端各自提供事实：

- `log:` 按会话归属。chat 会话只允许 `creatorId` 本人；issue 会话要求请求者是该会话所属工作区的成员。socket 的 workspace 绑定仍然生效，跨工作区一律拒绝。
- `trace:` 按 `canUserViewTaskMessages`。chat 任务只允许会话创建者；私有 Agent 的任务只允许其 owner 与工作区 owner/admin；其余任务工作区成员可读。

Postgres 下每条订阅走 C4 只读池一条 `SELECT`（`LOG_STREAM_FACTS_SQL` / `TRACE_STREAM_FACTS_SQL`），不使用同步 bridge；SQLite 与测试退回 store 同步读取。`userId === null`（主令牌/开放模式）保留本地管理员语义。

## 断线续传、退避与 resync

[ws-client.ts](../../frontend/packages/core/api/ws-client.ts)：

- 重连为 1s→30s 抖动指数退避（`reconnectDelayMs`），失败计数在认证成功后归零。
- 每 25s 发一次 `ping`（Bun `idleTimeout` 为 120s）。
- 认证成功后对每条活动流重发 `stream.subscribe`：有本地帧则 `from_seq = 本地 head + 1`，否则沿用调用方原始锚点。
- 收到 `resync` 与收到重连走同一恢复动作：重订阅所有流，再跑一次非流式缓存的失效（[use-realtime-sync.ts](../../frontend/packages/core/realtime/use-realtime-sync.ts)）。

`resync` 的发送方是服务端一个进程级入口 `server.broadcastResync()`（[server.ts](../../packages/server/src/api/server.ts)、[hub/browser-stream.ts](../../packages/server/src/api/hub/browser-stream.ts)）：给本进程所有已认证浏览器连接发 `{type:"resync"}`，每连接 0–2s 抖动，避免整片客户端同一刻重取。Hub 的 peer 适配器在链路恢复后调用它。

## 客户端订阅入口

- [realtime/streams.ts](../../frontend/packages/core/realtime/streams.ts) 提供 `useLogStreamSubscription` / `useTraceStreamSubscription`，按 `(stream,id)` 引用计数，多个界面共用一条订阅。
- `TraceSocket`（[api/trace-socket.ts](../../frontend/packages/core/api/trace-socket.ts)）懒建：第一次 `subscribeTrace` 才建连接，最后一个退订时关闭。`deriveTraceWsUrl` 把 `/ws` 映射到 `/api/trace/ws`。

## 兼容

旧 `task`/`chat` scope、`task:message`/`chat:message` 帧与 v1 `subscribe`/`unsubscribe` 系列帧在本版保留，统一由 C12（MUL-447）删除。`chat:done | queue_updated | session_*` 已改为投递到会话创建者的 user 注册表（[realtime.ts](../../packages/server/src/api/realtime.ts)）。

## 验证入口

- 服务端协议与鉴权：`bun test tests/unit/multiremi/multiremi-browser-stream-protocol.test.ts`（假 Hub，覆盖三种 log 归属、trace 四种可见性、ack/gap、续传、`wrong_endpoint`、resync）。
- 服务端端点接线与 chat 归属：`bun test tests/unit/multiremi/multiremi-browser-stream-socket.test.ts`。
- 客户端：`cd frontend/packages/core && bunx vitest run api/ws-client-streams.test.ts api/trace-socket.test.ts`。
- 路由清单：`bun run scripts/snapshot-api-routes.ts --check`；角色守卫计数：`bun test tests/unit/multiremi/api-role-guard.test.ts`。
