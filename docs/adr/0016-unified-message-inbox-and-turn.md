# ADR 0016: 消息、轮、尝试与对话游标

- 状态：设计已由贺华杰确认；存储实现已接入本分支，尚未切换生产。
- 决策人：贺华杰（范围、一步切换与生产边界）、Senior大哥（设计）、带头大哥（拆分）。
- 交付单：MUL-505（存储）、MUL-506（消息状态机与 Issue 推导）。
- 修订：ADR 0012（决策 1、3、5、6：消息信封与 pending 轮）、ADR 0006（决策 4：轮卡存储）、ADR 0011（令牌落点）。已存在两份编号 0012，引用时需带文档标题。
- 继承 [ADR 0013](0013-deliverable-is-comment-wakeup-is-doorbell.md)：交付物是 `reply/final` 消息，门铃是收件箱投影和平台的 `status/report` 消息；offer 预算与 `offer_too_large` 不变。0013 里 `agent_read_state` 那一段由本 ADR 取代，读进度归 lane 游标（S2 落地）。
- 继承 [ADR 0014](0014-every-agent-dispatch-is-a-delegation.md) 决策 1–4（派活一律算委派、谱系计数、环境变量上限），修订其决策 5–6：超过来回上限时不再返回 409，也不再记 `comment_mention_skipped`；消息照常落库，降级为下一轮（`wake_reason=pair_round_trip_limit`），通知和活动保留（S2 落地）。
- 取代 [ADR 0005](0005-cross-issue-delegation-return.md) 决策 3–5（桥接行、回程任务、手动叫醒抑制）。
- 编号：设计时暂定 0013，因 main 上已有 0013、0014，合入集成分支时改为 0015（MUL-493 方案修订 cmt_mnjqdgx7jwvr §3）；main 随后由 MUL-501 占用 0015（Issue 活动不进对话日志），同步 main 时改为 0016。


MUL-506 QA 修订（带头大哥裁定，2026-10-05，MUL-493 评论 cmt_ahun4f63lpo7）：lane 的 `cursor_seq/cursor_offset` 只保存当前 provider 会话的实际读取高水位，范围完整读取或连续输入确认才推进。轮完成不重置或推进它；provider 续接/完成位置另存 `provider_cursor_seq`，业务消费边界存 `turn.input_to_seq`。本 ADR 继承 ADR 0013 的冷 bootstrap 语义：新 provider 的输入从 0 开始，接受后实际读取高水位清零，再按连续读取或完整 inline 输入确认抬高；准备或拒绝不会清零。冷 replacement 同样从 0 重读并包含原轮的原始输入，使用新 attempt 自己的确认和正文读取凭据。Runtime 删除或 daemon 退役仅重置 provider 续接缓存，不在运行环境变化时清零实际读取。

## 背景

切换前的模型通过评论、Chat、信封、提示词、插话、提问和决定等入口写入消息。人的通知与 agent 游标分开，轮卡镜像执行数据，重试建立另一个工作标识并驱动 Issue 状态；部分自动化没有对话。该分支已统一存储和消息状态机，提供 Daemon/用户功能的 Store 适配；传输、CLI 和页面由消费者集成。

## 决策

1. `multiremi_conversation_log` 的消息头使用普通列：sender、to、message_kind、wake、reply_to_id、dedupe_key、options 和 card_token。`sender_type/id` 替代 author，`reply_to_id` 统一线程与决定答复。收件人写入时解析并冻结。对话内 dedupe_key 唯一；人的收件箱索引按 to_member_id、session_id、seq。
2. `multiremi_turns` 是工作单位；`multiremi_turn_attempts` 是执行单位，attempt 保留现有 `tsk_` 标识。trace、归档成员、附件和用量继续引用 attempt。重试、换机与孤儿恢复只建尝试，不建轮，也不修改 Issue 状态。显式继续是另一轮，不能被重试链合并。
3. 日志的 turn 行保存 id 与 seq 指针。卡片的状态、用量、模型、统计与最终回复由轮及当前尝试投影，轮状态变化集中产生 Live Hub 更新。Chat 未结束的轮投影为隐藏，回复完成后在相同 id/seq 上显示；Chat 更新发送完整 entry，让已消费隐藏标记的副本能恢复同一张卡，其余轮使用 patch。历史提示词保存为轮的 legacy_prompt，新的轮输入由消息 seq 范围决定。
4. `multiremi_session_lanes` 以 `(session_id,reader_type,reader_id,execution_scope)` 为主键，支持 agent 与 member。人的 lane 不包含 provider 状态，没有逐条归档；读取只推进 cursor。历史 inbox_items 不迁移，人的 cursor 初始化为迁移后的 head；迁移报告单列未读 attention 项。
5. 每个自动化拥有 `auto_<autopilot id>` 对话；timer 发送 request 消息。Issue 模式执行仍在 Issue 对话，自动化对话记录指向它的 status。运行账本引用 turn，状态从轮推导。现有 run_only 和按目标调度入口按 run id 分配独立 execution_scope，同一个 auto 对话可以排队多个独立运行；Issue 模式将 timer request 的 seq 绑定到轮的 wake_seq/input 范围，完成时不会重复执行这条输入。
6. 唯一消息入口为 `sendMessageWithinTransaction(ctx,input,deferredEvents)`，返回 `{message,wake_applied,wake_reason,turn_id?}`。事务归调用方。状态机、门铃规则和 producer 已接入；终态回复暂存与自动化结果也通过该入口。agent 来回上限默认 5 次，可通过环境变量调整。
7. Issue 状态只由轮与未答复 decision 推导，尝试失败、等待重试、换机不参与。父子 Issue 守卫与依赖规则继续适用。
8. 旧 CLI 命令登记 retired，执行提示替代命令；旧路由返回 410。daemon 协议号仍为 2，以最低 CLI 版本门拒绝旧客户端并走现有升级通道。这些接口及 daemon 改接与存储同一版本发布。
9. 迁移在启动的一次事务中完成，四项预检任一失败即拒绝切换。PG 原 attempts 表原地改造，保留入向 trace/归档外键，并显式建立 attempt.turn_id → turn.id 外键；已完成迁移的 PG 启动也检查补齐该外键。旧表迁移后保留但停止写入；物理删除通过单独脚本的两组选项执行。

## 未采用的方案

将轮全部存到日志并删除执行表，会同时改变领取、affinity、用量和归档的主键。不拆轮与尝试，无法隔离执行故障和业务工作状态。给人另建游标表会复制 lane 机制。保留 metadata.envelope 会让人的收件箱查询、去重与两端索引持续依赖不同 JSON 方言。

## 影响与实施边界

切换前必须 drain、排空 outbox，并停稳历史 trace 回填。Chat 待办消息合并进同一轮，取消 prioritize；人的收件箱失去逐条归档。切换后产生的对话无法在恢复旧备份时保留。

新版本运行至少 7 天后，两组退役表一起报批；备份后仍需贺华杰明确批准物理删表。删表前可恢复备份与旧镜像，删表后只能前向修复。本单交付脚本和本地演练，不操作生产。

规范合约见 [unified-model.ts](../../packages/contracts/src/unified-model.ts)，表定义见 [unified-model-schema.ts](../../packages/server/src/store/unified-model-schema.ts)，操作步骤见 [切换手册](../deploy/unified-model-cutover.md)。启动迁移及执行读写已接入；执行消费者通过只读视图取得既有 wire 形状，写入器按字段归属更新轮与尝试。视图只读取新结构，没有旧表回退。队列迁移保留每条历史重试链的轮，合并同 lane 的排队输入到最早待办轮，其余轮留为取消历史。`trigger_message_id` 支持派活谱系，`cursor_offset` 支持完整范围读取；启动迁移把 head 读进度和历史提问/决定令牌合并到 lane/消息。接口见 [收件箱 Store](../dev/inbox-store.md)。后续子单接入 daemon 传输和用户接口后才能整体切换，不能以本 ADR 作为已经上线的证据。
