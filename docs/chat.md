---
title: Chat 私聊与消息队列
status: active
summary: 独立 Chat 页面与浮窗共用私聊、执行队列和会话管理。
---

# Chat

Chat 是用户与一个云友的持续私聊。可以直接提问、讨论或要求执行工作，无需先创建 Issue。
独立页面位于 `/<workspaceSlug>/chat`，与其他页面的浮窗共享会话选择和草稿；独立页不再挂载浮窗。
页面可以通过 `?session=<id>` 打开已有聊天，或通过 `?agent=<id>` 开始新聊天。

## 会话与上下文

新聊天选择云友，首条消息或首次附件上传时创建会话。每个会话绑定一个云友，切换云友会开始新聊天。
项目和 Issue 引用沿用既有上下文机制，执行位置由现有任务调度与云友配置决定。
Chat 页面不提供独立 Runtime 或机器工作目录选择器，历史列表不提供按云友或 Runtime 的筛选。
Chat 可绑定一个同工作区 Issue，绑定不把聊天变成团队公开讨论，也不让 Chat 完成自动改变 Issue 状态。

会话支持重命名、置顶、归档、恢复和删除。归档会停止未完成的运行并禁止继续发送，恢复后可继续聊天。
删除会移除会话及消息，并取消未完成运行。列表提供最新消息、未读数及运行状态；置顶会话优先。

## 消息与执行队列

每次发送创建独立任务。消息、任务和附件绑定在同一事务中保存；运行中的会话可继续接收后续消息。
同一会话的任务串行执行，后续任务在领取时取得最新可续接的 provider 会话，而非沿用入队时的旧指针。
当前轮的上下文投影排除尚未处理的后续输入。

队列支持编辑文本、移除、清空和立即处理。立即处理将选中消息排到下一位，并取消当前运行；服务端负责这两个动作。
已经进入执行的消息不能按排队消息修改，状态冲突返回 409。取消保留已有 task transcript；它不等于撤销已执行的工具操作。
输入框在发送失败时保留草稿，删除失败时保持会话选择。

聊天记录与 provider 会话是两层状态。正常续接复用既有运行上下文；无法续接时，Remi 使用有预算的聊天历史投影，
截断会被标识。不能据此承诺每轮携带完整历史或底层工具的全部工作记忆。

## 权限与实时更新

直接聊天仅创建者可读写，另需满足工作区成员与云友访问条件。其他工作区成员及管理员不能读取别人的私聊。
消息、附件、task transcript 和实时订阅各自保留对应权限检查，不能只依赖页面隐藏。
任务详情与控制接口、云友任务列表及关联 Issue 的任务列表同样检查私聊权限；Issue 分享不包含 Chat 的输入与执行记录。
删除会话后，留存任务继续保留私聊标识以拒绝读取，也不能通过复用旧会话 ID 重新取得这些记录。
工作区选择沿用服务端统一解析规则：显式工作区参数优先，其次为请求头和凭据绑定的工作区。
聊天列表、创建和待处理任务在解析工作区后继续校验成员权限；未知 slug 不回退到 `local`。

服务端数据由 Query cache 管理，草稿和选择由工作区分区的 store 管理。WS 更新保持当前执行任务与后续队列分离，
取消某条排队消息不能清除另一条正在执行任务的状态。
已上传附件的草稿绑定与文本一起按工作区保存，切换浮窗、独立页或会话后仍可发送。

## CLI 与验证入口

```bash
remi chat create --agent <id>
remi chat message create <chat> --content-file <path>
remi chat pin <chat>
remi chat unpin <chat>
remi chat archive <chat>
remi chat restore <chat>
remi chat queue list <chat>
remi chat queue update <chat> <task> --content-file <path>
remi chat queue remove <chat> <task>
remi chat queue clear <chat>
remi chat queue prioritize <chat> <task>
```

接口实现见 [Chat 路由](../packages/server/src/api/routers/chat.ts)、
[ChatRepo](../packages/server/src/store/repos/chat-repo.ts) 和
[任务领取](../packages/server/src/store/repos/tasks-repo.ts)。前端入口见
[Chat 视图](../frontend/packages/views/chat) 与 [core/chat](../frontend/packages/core/chat)。
验证方法遵循[测试指南](../TESTING.md)；`bun run smoke:chat` 启动隔离浏览器测试。
单元测试、浏览器冒烟和真实 provider 执行分别报告结果。
