# ADR 0020: Chat 跟进队列与原生引导

- 状态：已接受（PR 3 编排决定，2026-10-15）。决策 1–6（跟进队列）在本分支实现；“原生引导”一节计划在 Phase B 实现，尚未落地。本 ADR 不代表已部署。
- 修订：[ADR 0012（统一收件箱）](0012-unified-inbox-and-single-pending-turn.md) 决策 5。Chat lane 的 now 消息仍插话、合并或建轮；新增的“排队”不使用 `next_turn`，而是服务端队列表，在轮 completed 的终态事务里放行为 now 消息。`next_turn` 的含义不变。
- 继承 [ADR 0016](0016-unified-message-inbox-and-turn.md)：唯一写入口、同 lane 单 pending 轮、lane 实际读游标与完成屏障不变。
- 编号：main 上最后一份为 0018，PR 2 预留 0019，本 ADR 取 0020。

## 背景

运行中的 Chat 只有一种发送行为：now 消息送进正在运行的轮，daemon 目前以中止后重新提示的方式实现。页面上的“队列”实际是 agent 尚未确认读取的未读消息。用户需要两种方式，行为对齐 Codex：引导（送进这一轮）和排队（这一轮结束后发送）。

用 `wake=next_turn` 日志行充当队列不可行：

1. next_turn 不开启下一轮。运行中时 `ensurePendingTurn` 直接返回，pending 时只合并；`reRingAfterTurnEnd` 与周期扫描只看 now；ADR 0012 决策 5 明确它不补铃。
2. 正文不送达。下一轮输入只内联 now 触发消息，next_turn 正文投影为空，agent 只看到范围提示。
3. 排队后再引导会失败。轮输入按连续范围确认：队列行 Q 在引导 S 之前，S 的 `turn.input` 确认必须包含 Q，而 `assertOfferedInputRead` 对非 now 行抛 `input_gap`；除非 agent 范围读取 Q，而读取会在轮中途消费 Q。
4. 日志顺序错误。队列行出现在它所跟随的回复之前。

在游标模型里修补这些问题需要约 10 处特殊情况，全部落在 ADR 0016 MUL-506 规则最敏感的代码里。

## 决策

1. **队列在日志之外。** 条目存在 `multiremi_queued_messages`（id 前缀 `qmsg_`），按 lane（session、agent、execution_scope）存放，记录发送人、正文、附件 ID、Chat 内唯一的 `client_id`、状态（queued/failed/released/deleted）、发送错误、放行信息（消息 ID、`released_via` 为 `turn` 或 `steer`、时间）和 revision。同 lane 内用单调 `seq` 定序，不依赖同毫秒的时间戳。暂停记在 agent lane 的 `queue_paused_at`、`queue_pause_reason`。迁移 `20261016_chat_follow_up_queue` 为加法变更。
2. **放行就是普通发送。** 每条转成成员 `wake=now` request，经 `sendMessageWithinTransaction` 写入，dedupe key 为 `queue:<id>`，同一行重复放行返回原消息。每条用独立 savepoint 与事件队列。第一条建 pending 轮，其余合并进同一轮；全部是 now，下一轮按 seq 内联正文。游标、完成屏障与 next_turn 规则都不变。消息在下一轮开始时进入日志，排在上一轮回复之后，与 Codex 一致。
3. **放行时机与暂停。** 入队时 lane 没有 pending、running、awaiting_human 轮且未暂停则立即放行；轮 completed 时在终态事务里放行（`reRingAfterTurnEnd` 的归档检查之后、未读 now 扫描之前，扫描随后合并进同一 pending 轮）；resume 时放行。轮 failed 或被成员以外的身份取消时只暂停为 `turn_ended`，不让失败的 agent 吞掉排队的指令；该 lane 之后任一轮 completed（包括失败轮重试成功）时自动解除 `turn_ended` 并放行。成员停止当前轮时暂停为 `interrupted`，只由 resume 解除。某条放行失败时该条标 failed，lane 暂停为 `send_failed` 并停止，后面的条目不越过它。
4. **条目操作。** 只有原发送人可以编辑（可选 `expected_revision`）、删除（幂等）或引导。引导立即放行该条，不论 lane 状态，由 `ensurePendingTurn` 插话、合并或建轮；重复引导返回同一条消息。已被轮放行的条目返回 409 `queued_message_consumed`。resume 清除暂停、把 failed 重置为 queued；编辑、删除或成功引导 failed 条目后若不再有 failed 条目，`send_failed` 自动解除。归档的 Chat 仍可编辑和删除条目，但只解除暂停、不放行；放行从不重新打开归档的 Chat。复用已删除条目的 `client_id` 入队返回 409 `queued_message_deleted`。没有 queued/failed 条目时暂停自动清除。每个 lane 最多 50 条未放行条目，每条最多 10 个附件。
5. **只给成员用。** 接口沿用 Chat 创建人、工作区成员与 Agent 访问规则，并要求成员身份；task token 一律 403。agent 不操作成员的队列，CLI 不增加队列命令，`remi message send --wake` 不变。每次变更、放行与暂停在提交后发射已有的 Chat 级 `chat:queue_updated`，放行的消息经普通日志流到达。
6. **送达未确认是客户端状态。** 服务端写入原子且幂等：`client_id` 使入队幂等，dedupe key 使放行幂等，引导按条幂等。请求没有得到 HTTP 状态（网络错误、超时）时客户端标记“未确认”，不自动重试；手动重试安全，重新读取看到已放行即清除该状态。

接口见 [Message HTTP 接口](../dev/message-api.md)的 Queue 一节，Store 实现见[统一收件箱 Store](../dev/inbox-store.md)的“跟进队列”，产品规则见 [Chat 契约](../chat.md)。

## 原生引导（计划中，Phase B）

尚未实现，Phase B 落地时补全本节。计划要点：

- Claude 与 Codex 的 ACP 桥都提供 `_session/steering` 并在初始化结果里声明能力。daemon 在有进行中的 prompt 时调用它把引导注入当前轮；不支持、超时或失败时退回现有的中止后重新提示。Antigravity 不声明该能力，始终走退回路径。
- **D3**：桥在空闲时自行开启的新轮（Codex 的 `startedNewTurn` 竞态）算作同一 attempt 内的又一个 provider 轮，即现有 turnIndex 循环多一次迭代：先取消桥开启的轮，等待该会话 500 ms 无更新（最多 5 s，超时走现有的停止进程路径），再重新提示。它不新建 Remi 轮或 attempt：引导消息作为本 attempt 的输入下发并确认，第二个 Remi 轮会破坏同 lane 单轮与完成屏障，桥也不给出独立轮的结束信号。竞态下内容会在 Codex 线程里出现两次，接受。

## 未采用的方案

- **next_turn 日志行。** 理由见背景。若必须留在日志：成员的 `requested_next_turn` 消息要补铃并作为触发内联，且任何引导都要先提升之前的排队行；这偏离 Codex，日志顺序仍然错误。
- **只在客户端排队。** 刷新或多标签页会丢失或重复，也无法在服务端终态事务里与轮结束原子放行。
- **为排队消息预建下一个 pending 轮。** 运行中再建 pending 轮违反同 lane 单 pending 轮，并让完成屏障与补铃需要另一套规则。

## 影响

- 旧的 Chat 任务队列 Store 写入口（按排队任务编辑、移除、优先）已无路由使用，随本 ADR 删除。
- 归档时被取消的轮既不放行也不暂停；条目保留，恢复后由 resume、下一次入队或下一轮 completed 放行，客户端显示“尚未发送”提示。归档期间整理队列（编辑、删除）不会放行或重新打开 Chat。周期扫描不处理队列。删除 Chat 时同事务删除其队列行。
- 运行中输入框的引导/排队切换、队列列表与偏好由前端阶段接入；在此之前页面运行中仍直接发送（引导）。
