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
新聊天通过工作位置选择器选择 Project 或 Runtime 本机目录，两者互斥；也可保持纯对话。首次发送或上传附件创建会话后，位置选择固定，需要更换时新建 Chat。Runtime 目录的绑定与保留规则见 [Runtime 工作区契约](dev/runtime-workspaces.md)。
选择 Project 后使用其指令、资源、Memory 和 Wiki。绑定的 Project 被归档或删除后，下一轮清除旧执行上下文，在平台 Chat 目录冷启动为纯对话；之后正常续聊。
界面显示「已绑定的项目不可用」，旧真实目录和已有仓库文件保持不动。历史列表不提供按云友或 Runtime 的筛选。
Chat 与 Issue 独立：在聊天里创建 Issue 只创建工作项，不绑定会话，不继承该 Issue 的项目、仓库、附件或 Wiki 上下文。
任务领取中的只读 `chat_project_id` 来自 Chat 显式选择的项目；仅保留与该 ID 匹配的项目提示词和资源，不从历史 Issue 推导项目。
Web Chat 和飞书一对一私聊不接收 Issue 活动播报；飞书群里的 Issue 话题由飞书绑定表记录归属，继续接收 Issue 更新与工作轮次回帖。
飞书 Issue 话题不出现在 Web/CLI 的 Chat 会话列表和待处理列表中，其讨论与更新保留在 Issue 话题入口。
升级时，缺少确定归属证据的历史群关联需要管理员按[迁移手册](migrations/chat-issue-decoupling.md)审计并恢复；恢复前暂停该关联的 Issue 通知。

会话支持重命名、置顶、归档、恢复和删除。归档会停止未完成的运行并禁止继续发送，恢复后可继续聊天。
删除会移除会话及消息，并取消未完成运行。列表提供最新消息、未读数及运行状态；置顶会话优先。

## 项目仓库与工作目录

显式选择 Runtime 工作区时，Chat 使用注册的本机目录，不附加 Project 仓库，也不自动 clone、fetch 或切换分支。
未选择任何工作位置的 Chat 保持纯对话，仓库按需通过 `remi repo checkout` 获取。
Project 配置了 `local_directory` 时，Chat 在该真实目录执行，启动不会自动 clone、fetch 或修改 Git 工作树；
Wiki 使用 CLI 访问，既有 `.multiremi` 任务元数据仍会更新。

同一 Project 可在不同 daemon 上配置多个目录。唯一选择规则是资源列表按 `position, created_at, id` 升序
排序后的首个 `local_directory`；路由、执行指纹、旧目录匹配和 daemon 都消费
[`selectChatLocalDirectory`](../packages/contracts/src/chat-local-directory.ts) 的同一个选择。
daemon 只校验本机是否持有所选目录，不能跳过首项改用列表里的本机目录。
已使用的选择发生变化时，已有 Chat 在 `chats/<id>` 冷启动一次，后续正常续聊；
旧用户目录保持不动，不进入替换目录。只有新建 Chat 才采用当前选择。

目录选择变化的检查清单（指纹比较所选 daemon 与规范化 path，不比较整个集合）：

| 操作 | 选择及已有会话行为 |
| --- | --- |
| 新增第一个目录，或新增排在当前项之前的目录 | 选中项变化，已有会话留在/转入托管目录 |
| 删除当前项，包括删除最后一个目录 | 选择下一项或空值，已有会话转入托管目录 |
| 调整任一项 position，使首项变化 | 新首项改变指纹，已有会话不进入新目录 |
| 同 position 下 created_at 次序变化（例如删除后重建） | 遵循资源列表的次序，与路由及 daemon 一致 |
| 修改选中项 local_path 或 daemon | 选中赋值变化，已有会话转入托管目录 |
| Project 归档、删除或不可用 | 可用选择变空，同时清除旧项目上下文 |
| Project 恢复、重新添加目录 | 托管模式保持；已有会话不重新取得用户目录权限 |
| 修改 label、非目录资源，或修改/增删/重排未影响首项的目录 | 选中赋值不变，不因此重置会话 |
| 路径仅作等价规范化、position 数值变化但首项不变 | 选中赋值不变，不因此重置会话 |

资源类型不能原地修改，类型替换通过删除再新增处理。`project_ref` 不继承本地目录。
`position` 与 `created_at` 完全相同时，以唯一资源 `id` 升序打破并列，保证重复查询的选择稳定；
调用方保持此顺序，不增加另一套排序规则。

其他绑定 Project 的 Chat 在 daemon 的 `workspaces/chats/<chat_session_id>` 目录运行。
首次使用时自动拉取 Project 显式声明的 `github_repo`（包括 `project_ref` 引用），
不会因 Project 未声明仓库而自动拉取整个 workspace 的目录清单。
工作分支为 `chat/<chat_session_id>`；已有 worktree 后续轮次直接复用，保留本地改动，不重复 fetch。
需要刷新或重试失败仓库时使用 `remi repo checkout <repo-id>`。

自动同步按仓库串行执行，共享 120 秒网络预算；daemon 环境变量
`MULTIREMI_REPO_CHAT_STARTUP_TIMEOUT_MS` 可指定 1–2147483647 的整数毫秒覆盖该预算。
已有 bare cache 的刷新最多占用 30 秒，也受总预算约束。Issue 的同步预算不受此配置影响。
启动过程中 Chat 显示仓库准备进度；鉴权、网络或超时失败会保留之前成功的仓库，继续启动对话，
并在智能体提示词中记录失败原因与手动获取指引。该网络预算不包含本地 worktree 文件落盘耗时。

项目绑定在创建时固定。自动准备不会删除已有仓库，也不会覆盖同名的其他目录；
Project 资源列表变化或项目不可用时，已有工作副本保留。

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
任务详情与控制接口、云友任务列表同样检查私聊权限；Issue 分享不包含 Chat 的输入与执行记录。
删除会话后，留存任务继续保留私聊标识以拒绝读取，也不能通过复用旧会话 ID 重新取得这些记录。
工作区选择沿用服务端统一解析规则：显式工作区参数优先，其次为请求头和凭据绑定的工作区。
聊天列表、创建和待处理任务在解析工作区后继续校验成员权限；未知 slug 不回退到 `local`。

服务端数据由 Query cache 管理，草稿和选择由工作区分区的 store 管理。WS 更新保持当前执行任务与后续队列分离，
取消某条排队消息不能清除另一条正在执行任务的状态。
已上传附件的草稿绑定与文本一起按工作区保存，切换浮窗、独立页或会话后仍可发送。

## CLI 与验证入口

```bash
remi chat create --agent <id>
remi chat create --agent <id> --project <project-id>
remi chat create --agent <id> --runtime-workspace <runtime-workspace-id>
remi chat update <chat> --title <title>
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
