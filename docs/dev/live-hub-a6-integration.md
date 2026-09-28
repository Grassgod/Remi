---
title: Live Hub 对接说明（A-6）
status: active
summary: A-6 如何用 Hub 的 trace 订阅、gap 时怎么补读、背压与 closed 终态的确切语义。
---

# Live Hub 对接说明（A-6）

本页写给 A-6（MUL-422）的 daemon 连接层：它把 daemon 的 `trace.append` 帧交给
Hub，并从 Hub 取订阅喂给浏览器 trace socket（C3）和飞书 CoT。实现与契约的归属见
[ADR 0007](../adr/0007-live-hub-and-browser-replica.md) 与
[`packages/server/src/api/hub/`](../../packages/server/src/api/hub/)；本页只讲调用方式与
边界，不重复决策依据。

## 1. Hub 在哪、谁构造

`createMultiremiApp` 默认构造一个 `HubImpl`（本地 transport），`api/server.ts` 与测试
共用这一条构造路径；`startMultiremiServer` 额外把它标注成当前进程角色。A-6 不自己
`new` 一个 Hub：从 app 的 `deps` 或启动参数里取，否则健康指标和订阅会分属两个对象。

trace 流的家**只在 daemon 所连的进程**（`runtime`）。浏览器经 `/api/trace/ws`（C3，
nginx 路由到 runtime）直连，不跨进程。

## 2. 写：`append` / `head` / `close`

```ts
import type { TraceSink } from "@multiremi/api/trace/trace-sink.js";

sink.append(taskId, events);   // 返回 { head }
sink.head(taskId);             // 帧数之外的 head；本进程没有该 task 的帧时是 null
sink.close?.(taskId);          // 终态
```

三条规则，都有测试钉住（`tests/unit/multiremi/hub-trace-contract.test.ts`）：

1. **序号由 daemon 给**。`seq <= head` 的帧丢弃并计数，`seq == head + 1` 入环，
   跳号进 500ms 连续性缓冲。Hub 不另起序号，也不编造缺的号。
2. **`head` / `closed` 是实时 getter**，不是订阅时的快照。持有一次订阅即可看到 head
   前进与 trace 结束，不要为拿新值重新订阅。
3. **`close(taskId)` 对从未 append 过的 task 也建立 closed 状态**。零事件的一轮、
   或先收到终态帧再收到事件的情况，靠这条让订阅者拿到 `closed`，否则它会一直等。

`trace:` 流不跨进程：`HubImpl` 只把 `log:` 帧交给 transport。A-6 不需要为此写判断。

## 3. 订阅：两种拼写

```ts
// A-0 的拼写（裸 task id）：gap 是 boolean，带 closed
const sub = hub.subscribe(taskId, fromSeq, (taskId, events) => { /* ... */ });

// 键化拼写（浏览器 socket 与内部同一份实现）：gap 是范围，带 log_version
const keyed = hub.subscribe("trace:" + taskId, fromSeq, (key, frames) => { /* ... */ });
```

两种拼写指向同一条流，按 listener 类型区分（`HubFrameListener` 与
`TraceSinkListener` 互不兼容），因此调用点不需要额外的类型参数。

订阅立即返回；冷流的 warm-up 在后台完成，**结果通过 sink 的 `gap` 通知**，不写进已经
发出的 ack。这正是 `from_seq` 重连协议能工作的原因：客户端报 `local_head + 1`，Hub 回
它能服务的范围，超出部分让客户端自己补。

## 4. gap：由谁补读

订阅者拿到 `gap` 时，**Hub 不会读库回填**。补读路径按订阅者分：

- A-6（飞书 connector）：用 daemon 的 `trace.fetch` RPC 取 `[from, to]`，即
  `DaemonTraceReader.read({ taskId, runtimeId, afterSeq: from - 1 })` 逐页读到底。
- 浏览器：C3 决定用哪条 HTTP trace 路由（MUL-402 B5）。
- Hub 自己只在三种情况下读：冷流 warm-up、对端 head 指针补环、连续性缓冲补洞。这三种
  都是「修自己的环」，不是对外读路由。

`gap.from` 用的是订阅者的 cursor 而不是 `cursor + 1`，范围保守一格：重复读由 seq 去重，
漏读则不可恢复，所以宁多读一条。

## 5. 背压：什么时候会停、怎么恢复

- 每个订阅者一次 flush 只发**一个批帧**，单帧上限 64 KiB；超限的批会切分，但**单个
  帧不切**（订阅者无法重组半个帧）。
- sink 的 `getBufferedAmount()` 超过 512 KiB 时该订阅者被标记 lagging 并停止接收；
  队列不会被继续增长。
- 传输 drain 后调用订阅句柄的 `notifyDrain()`。若此时的续推位置已经越过环尾，订阅者会
  先收到一次 `gap`，再从环尾继续——慢订阅者退化成「补这一段」，而不是静默跳过。

缓存的订阅句柄需要保留 `notifyDrain`：`subscribe(taskId, …)` 返回的类型**没有**这个方法
（A-0 的 `TraceSinkSubscription` 不扩宽）；需要 drain 恢复的调用点用
`hub.subscribeWithSink(key, fromSeq, sink)`，它返回带 `notifyDrain()` 的键化订阅句柄。

## 6. closed 终态

`closed` 是唯一的完整性信号：没有 `trace.end` 事件，也没有帧上的 `ended` 字段。
`task.complete` / `task.fail` 帧带的 `trace{head, event_count, closed: true}` 是同一个
事实的另一种表达。订阅者读 `closed`，不要轮询 `/status`。

## 7. 不在这张接口上的东西

- 浏览器 WS 帧协议与 `/api/trace/ws`：C3。
- daemon 侧 trace 存储与 `trace.append` 帧本身：MUL-401/MUL-402。
- 真实 `readRange` SQL：v2 集成接 B1 的 repo 函数与 C4 的 `readPool.query`，
  做法见父单 MUL-402 评论 `cmt_mzsa67algpsl` 第 4 项。
