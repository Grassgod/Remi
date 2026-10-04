---
title: 统一消息与收件箱 Store
status: active
summary: 消息唯一入口、lane 状态机、Issue 推导及 Daemon 和用户接口的 Store 适配。
---

# 统一消息与收件箱 Store

该分支实现 [ADR 0015](../adr/0015-unified-message-inbox-and-turn.md) 的消息状态机。S4 已将 message/inbox/turn HTTP 接到这些 Store 方法，页面契约见 [Message HTTP 接口](message-api.md)；不代表生产已经切换。

## 写入与事务

[sendMessageWithinTransaction](../../packages/server/src/store/inbox/send-message.ts) 是唯一消息写入口。调用方先开启事务并传入 `CommitEventQueue`；消息、lane、轮、Issue 推导和说明活动同事务落库，事件在最外层 COMMIT 后发送。`Store.sendMessage(input)` 自行管理事务，返回 `{message,wake_applied,wake_reason,turn_id?}`。运行中的请求、评论、Chat、平台门铃、自动化结果与执行回复暂存均经此入口。历史迁移单独读取旧表，运行路径没有旧表回退。

消息头在发送时冻结收件人。`source_turn_id` 验证发件轮的 agent 和工作区；`reply_to_id` 必须属于原对话。角色可能选择父单或委派来源对话。agent request 只有源为 Issue 轮、非旁支、目标在 Issue 上时才产生委派；符合条件的所有方向均为 `now / agent_dispatch`。self、不运行的收件人、依赖、来源和目标前置优先于派活规则。超过 `countDelegationPairHops` 的 `2L` 边界时消息保留，降为 `next_turn / pair_round_trip_limit`，不建或合并轮，说明通知和活动在同事务记录。L 默认 5，由 `MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT` 调整。

用户 HTTP 发送会传入内部 `authorizeRecipient` 回调，在持有 workspace 锁且解析最终角色 agent 后、写消息之前执行访问检查。拒绝会回滚同事务上传的附件行，上传包装器清理文件。该回调不属于请求体或公共消息合约。提问答复进入 `answerMessageDecision` 后，permission/question response 先按原提问结构规范化并验证，再调用原子消费接口；无效结构不会消费请求或卡片 token。

平台 status/report 正文限 4 KiB，agent reply/final 正文完整保存。委派进度按触发 request 回到发件轮的对话与 scope，终态只发一条有收件人的 report；谱系计数也沿触发 request 追溯。对话内 dedupe_key 唯一，合并或插话后的重发返回原 delivery turn。执行适配器通过注册的消息 writer 调用同一入口；隐藏的 terminal reply 暂存和产品回复发布仍在终态事务内，已有本轮 agent 评论时 reply_message_id 指向它，避免重复回复。发布失败时回滚后只完成轮，reply_message_id 留空。

[lane-machine](../../packages/server/src/store/inbox/lane-machine.ts) 在 `(session_id,agent,execution_scope)` 上串行化发送和结束：pending 合并、running 插话、结束补铃；数据库部分唯一索引保证同 lane 只有一个 pending。只有未读 now 消息能单独补铃。扫描以 wake_hint/swept 进度分页、等待 idle 至少一分钟，每个 lane 用 savepoint 隔离失败。确认输入不越过日志 head、不跳 gap；游标只前进。

## Store 消费接口

类型及参数的事实来源为 [unified-model.ts](../../packages/contracts/src/unified-model.ts)、[InboxOperations](../../packages/server/src/store/inbox/operations.ts) 和 [Store facade](../../packages/server/src/store/store.ts)。HTTP/CLI 调用方负责鉴权、身份解析和参数校验；Store 同时校验消息源、收件人、对话与成员工作区边界。匿名旧领域评论允许 member/null，新用户入口应传入实际成员身份。

消息列表和完整 turn input 从查询行直接批量投影，不再逐 ID 重新读取。HTTP 按页批量加载附件和反应。inbox 以有界候选页查正文，计数单独按对话和受保护的来源任务聚合；可见性缓存只在当前请求内使用，隐藏提问不计入未读和 attention 数。

`sendMessageWithinTransaction` 发射 `inbox:new` 索引刷新，`readMessageInbox` / `readAgentMessageInbox` 发射 `inbox:read`，全读发射 `inbox:batch-read`。统一索引事件的 payload 仅有 `{index_only:true}`；`emitWorkspaceEvent` 在最外层事务提交后才通知现有 workspace realtime/peer，回滚会丢弃。读写新的 inbox API 获取计数，不依赖旧 inbox_items。

| 功能 | Store 方法 | 结果或边界 |
|---|---|---|
| 消息发送、读取 | `sendMessage(input)`、`getMessage(id)`、`listMessages(sessionId,{from,to,limit,thread,unread_by})` | seq 范围为 `(from,to]`；发送返回实际 wake；读取过滤 tombstone |
| 编辑、删除、解决、反应 | `editMessage(id,{body_md})`、`deleteMessage(id)`、`resolveMessage(id,actor,resolved)`、`reactMessage(id,input)` | 已消费或部分已消费内容不能编辑或删除；删除保留 tombstone；反应幂等 |
| 人的收件箱 | `listMessageInbox(memberId,workspaceId,{limit})`、`readMessageInbox(memberId,sessionId,toSeq)`、`readAllMessageInbox(memberId,workspaceId)` | member lane，计数不受分页影响；priority≤2 且未解决进入 attention；读到哪只前进 |
| 轮与尝试 | `getTurn(id)`、`listTurns(input)`、`getTurnInput(id)`、`listTurnAttempts(id)`、`getTurnTrace(id)` | trace 定位 current_attempt_id；历史输入范围保留 legacy_prompt |
| 轮控制 | `cancelTurn(id)`、`wrapUpTurn(id)`、`retryTurn(id,cold)` | wrap-up 是标记；retry 同轮新 attempt，cold 清 provider 续接缓存，不改变 Issue |
| 卡片答复 | `issueMessageCardToken(id,recipient)`、`answerMessageDecision(id,input)` | hash/binding/consumed 在消息行，答复 CAS 与 reply 同事务；宿主负责把答复者映射到成员 |
| Daemon | `getDaemonTurnBridge()` | 下述适配器与 S3 的结构接口一致 |

[DaemonTurnBridge](../../packages/server/src/store/inbox/daemon-turn-bridge.ts) 提供 `offerInput`、`snapshot`、`rpc`、`complete`。所有 RPC 检查 workspace/runtime/daemon/current-attempt 绑定；旧 attempt 无法提交。offer 使用 lane 游标和 `taskSessionInput` 的 unread_range，触发消息正文最多内联 8,000 字，长正文通过 message list 范围读取。正文、HTML、任意 metadata 与卡片凭据不重复塞入输入帧。折叠正文或仅提供范围提示的上下文未完整读取时不能越过它确认输入；snapshot 只投递轮开始后当前 lane 的 now 插话与 wrap-up 标记。complete 在终态事务内确认输入、写 reply/final、补铃并推导 Issue 状态，重发返回已提交结果。

## 状态与迁移

[deriveIssueStatusWithinTransaction](../../packages/server/src/store/inbox/issue-status.ts) 按 running、awaiting_human/负责人未答 decision、pending、负责人最后终态的顺序推导。human_sender 或 agent_dispatch 的 pending 为 todo，纯平台 pending 保持原状态。completed/failed/cancelled 分别为 in_review/blocked/todo。尝试失败、lost、换机、重试不推导 Issue。Guard A/B、依赖及终态父单边界继续适用；子单状态每次变化向父单负责人发一条 status，已关闭父单只留原状态活动。

`20261005_fold_agent_read_state` 把 head 上的 seq/offset 合并到 agent lane；lane 更靠前时保留 lane，等 seq 时保留最大 offset。`20261005_fold_decision_records` 将历史提问与决定的状态、选项和一次性令牌搬到消息，消息令牌使用部分唯一索引。领域消费者读取只投影新消息的 question/decision/member-inbox views。原提问、决定、插话表仍留作物理删除的备份窗口，但运行代码不读取它们。退役脚本 mul493 组同时列出 head.agent_read_state，执行前验证折叠迁移已完成。

## Producer 定位

按函数名核对改接；同一函数里的多处分支共用入口，不能按旧行号找。

| 原来源 | 当前入口或适配器 |
|---|---|
| 人的评论及无 @ 负责人响应 | `createIssueCommentWithinTransaction`、`maybeTriggerAssigneeReply` → central writer / task wrapper |
| rich mention | `triggerCommentMentions` → central writer，原评论重新路由，多收件人追加关联消息 |
| Chat 输入与回复 | `sendChatMessage`、`appendChatMessageWithinTransaction` → central writer |
| 飞书入站 | `submitMessage` → `createTaskWithinTransaction` → central writer |
| 飞书轮次推送 | `prepareIssueRoundPushesWithinTransaction` → pending adapter → central writer |
| 飞书提问卡与文本回退 | question/decision metadata 与 message card_token；回退 task wrapper |
| E2 子单状态 | `notifyChildStatusChangeWithinTransaction` → parent_owner status |
| E3 依赖就绪 | `reportDependencyReady` → envelope adapter → central writer |
| E3 前置失败 | `reportPrerequisiteFailureToOwner` → envelope adapter → central writer |
| E4 决定请求和上下通知 | Issue decision request/answer → decision/reply；说明 envelope adapter |
| 委派进度 | `ensureDelegationWakeupWithinWorkspaceLock` → envelope adapter |
| 委派终态 | `drainDelegationReturnsWithinWorkspaceLock` → envelope adapter |
| 转述汇报 | `afterTaskTerminal` → relay envelope adapter |
| task create | API → `createTask` → central writer |
| session task create | `createSessionTask` → task wrapper → central writer |
| agent issue rerun | store bridge → task wrapper → central writer |
| 指派 | `assignIssue` → task wrapper |
| 强制开工 | `startForcedIssueWithinTransaction` → task wrapper，保留 force guard |
| 依赖自动开工 | `autoStartDependent` → task wrapper |
| 快速建单 | `quickCreateIssue` → 指派与 task wrapper |
| 自动化立即运行 | `runAutopilot` → timer request → task wrapper 复用同一消息 |
| 自动化调度目标 | `advanceScheduledTargetRuns` → timer request → task wrapper |
| 重试、redispatch | replacement attempt writer，同轮新 attempt |
| steer、Organizer steer | `createTaskSteerMessage` → now request；force_answer 变 wrap-up |
| 终态回复与自动化结果 | execution message writer hook → central writer |

前四个 agent 派活入口（task create、session task create、rerun、rich mention）统一以触发 request 生成委派；返回降级字段，不再靠 409 回滚后另写通知。

## 验证入口

相关文件：`inbox-wake-policy`、`inbox-lane-machine`、`inbox-issue-status`、`inbox-operations`、`inbox-daemon-turn-bridge`、`inbox-concurrency-pg`、`inbox-dispatch-entrypoints`、`multiremi-question-card-token`、`turn-card-completion-fields`、`unified-model-migration`。PG 并发用例必须配置本地隔离的 MULTIREMI_TEST_POSTGRES_URL，使用两个独立服务进程；没有配置则未执行，不能以 SQLite 通过代替。生产切换与物理删表仍按[切换手册](../deploy/unified-model-cutover.md)操作。
