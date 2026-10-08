---
title: 统一问题与责任路由
status: active
summary: 原会话中的唯一问题、责任路由、答复版本与provider等待和续接消费。
---

# 统一问题

[`Questions`](../../packages/server/src/store/inbox/questions.ts)以原会话的 decision 消息为问题主体，状态保存在 `metadata.question`，不建立第二个问答表。原题在 `human_request.payload.questions`；Remi 总结独立保存，选项不改写。跨会话通知只带 `root_question_id`，`reply_to_id` 仍只允许同会话引用。

[`QuestionView`](../../packages/contracts/src/question.ts)是 Web 与 CLI 的共享投影。`GET /api/issues/:id/questions` 返回待答和历史；`GET /api/messages/:id/question`读取一个原问题。答复、升级、责任移交、Remi 总结、例外续接及显式关闭使用 `/api/messages/:id/question/{answer,escalate,transfer,present,continue,close}`。所有写操作提交 `expected_route_revision`；已答问题只有指定人类可以显式 `revise`，且必须给原因和 `expected_answer_revision`。正常答复重放不当作改答。原 provider 上下文在 `original_context`，责任不可解析原因在 `route_reason`；均与 Remi 总结分开。关闭保存原因和完整历史，并取消尚存的原 provider 等待。

责任从唯一 Issue resolver 读取。Worker 先问本单执行统筹人，再逐级问父单执行统筹人，最后问顶层明确人类。重复负责人和提问者自己被跳过。缺少 Leader 不能替换成普通成员；父链循环、父单缺失或跨工作区链保持不可处理状态。无 Issue 的 Chat 只从明确创建人映射人类，不取工作区 owner。权限请求直接交人类，Remi 只总结同一个 Q。

答复身份必须是当前处理者；Agent 还必须提交属于自己和同一工作区的当前执行轮。HTTP 先校验原会话及来源消息可见性。责任变更在同一事务重新路由、记录移交历史、增加路由版本并使旧卡凭据失效，不改变原消息冻结收件人。答案和原会话 reply、问题结算以及可靠通知意图同事务保存，实时推送在提交后执行。

业务问题与 provider 调用分开：超时保留待答 Q，将等待标为 `detached`。授权答复可安排原会话及原 execution scope 的新续接轮，冻结原委派回程和 provider 会话血缘，先取消旧轮避免并发；状态先是 `continuation_pending`，由真实输入消费确认后才成为 `continuation_consumed`。显式取消不自动开新轮。原回调仍活着时，答案回填原调用，daemon 的 `turn.decision.consume` 确认消费后才标 `consumed`。`none` 表示历史 decision 没有原 AUQ；不会补造等待对象。

原生等待有进程内 nonce，随 `hello.runtimes[].active_question_waits` 和 `runtime.ready` 的清单声明。短暂断线保留同一 nonce；新进程没有旧回调清单，服务端在恢复普通孤儿任务前分离该等待并取消旧 attempt 权限。若答案已保存，自动安排唯一新消费者。数据库中的 `running` 或 `awaiting_human` 只用于检查 attempt 仍有效，不能证明退出进程的回调存在；保存答复与实际消费是两个不同状态。

飞书卡和降级文字引用同一个 Q。当前人类必须能唯一映射到 bot 应用的 open_id；映射不明降级到带原 Q 与工作台入口的文字，不选择群主。路由版本随一次性 token 发卡；重新投递或移交立即失效旧卡。待呈现意图使用既有飞书持久 outbox operations，在 Remi/bot 忙碌或离线时可重试。

验证入口：[`issue-questions.test.ts`](../../tests/unit/multiremi/issue-questions.test.ts)覆盖 SQLite 和配置的真实 PostgreSQL 上的路由、答复、重复负责人、超时、来源尝试替换和移交。[`decision-callback-integration.test.ts`](../../tests/unit/daemon/decision-callback-integration.test.ts)使用原生 WS 与 mock provider callback，包含短断线保留 nonce 和真实 SIGKILL 后新进程执行唯一续接、读取上下文并确认消费。在线 provider 或飞书在线行为需要独立端到端验证，不由 mock 用例推断。
