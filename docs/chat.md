---
title: Chat 私聊与消息队列
status: active
summary: 独立 Chat 页面与浮窗共用私聊、执行队列和会话管理。
---

# Chat

Chat 是用户与一个 Agent 的持续私聊。可以直接提问、讨论或要求执行工作，无需先创建 Issue。
独立页面位于 `/<workspaceSlug>/chat`，与其他页面的浮窗共享会话选择和草稿；独立页不再挂载浮窗。
页面可以通过 `?session=<id>` 打开已有聊天，或通过 `?agent=<id>` 开始新聊天。

## 页面与侧栏

独立页没有页头横幅。会话头显示 Agent 头像、会话标题和已绑定的工作位置（Project 或 Runtime 目录名）；新聊天和历史都在左侧栏。浮窗保留原来的「⊕」按钮和会话下拉。

侧栏顶部是「新聊天」和「搜索」，「搜索」打开全局 Cmd+K。可滚动区按「置顶 / 项目 / 最近」分区：

- 置顶会话只出现在「置顶」，不论绑定在哪里；
- 绑定 Project 或 Runtime 目录的会话只出现在对应分组，不在「最近」重复。分组按其中最新的会话排序，先显示 5 组、每组 5 条；
- 「最近」是没有绑定位置的会话，先显示 10 条。

「显示更多」每次加 10 条；只会隐藏 1 条时直接全部显示。分组标题悬停时出现「+」，新聊天直接带上该 Project 或目录。

每行只显示 Agent 头像和标题，不显示时间和第二行；运行中显示 spinner，等待人工回答显示「待回答」，有未读回复显示蓝点。悬停或键盘聚焦时，状态位换成「归档」和「⋯」菜单；右键打开同一个菜单：重命名、置顶或取消置顶、停止运行（仅运行中）、归档（「已归档」列表里为恢复）、删除。

- 运行中的会话归档前要确认，因为归档会在服务端停止这一轮；空闲会话直接归档，并给出可撤销的提示，撤销即恢复为活跃。
- 删除需要二次确认；删除当前打开的会话会清空选择。

侧栏底部的「自动化」「已归档」切换到对应列表：「自动化」列出未归档的自动化 Chat，有未读时入口带圆点；「已归档」列出用户自己的和自动化的已归档 Chat。

全局搜索的「聊天」分组只在面板打开时读取会话列表：按标题匹配（不区分大小写），最多 9 条，活跃会话在前，选中后打开该会话。

会话区不显示消息信封头（收件人、消息类型、唤醒方式）。用户消息没有唤醒 Agent 时，气泡下方留一行原因。失败或取消的轮显示状态和失败原因，并提供「重试」「在新会话中重试」和执行记录入口；已完成轮不显示状态文字，执行记录入口在回复下方，悬停或聚焦时出现。Chat 不再显示尝试列表。重试由 Chat 的创建者发起，服务端按私聊规则放行，只接受失败或取消、且同一会话没有其他活跃轮的轮；规则见[消息接口](dev/message-api.md)。

## 会话与上下文

新聊天选择 Agent，首条消息或首次附件上传时创建会话。每个会话绑定一个 Agent，切换 Agent 会开始新聊天。
新聊天通过工作位置选择器选择 Project 或 Runtime 本机目录，两者互斥；也可保持纯对话。首次发送或上传附件创建会话后，位置选择固定，需要更换时新建 Chat；已有会话只在确有位置绑定时显示该行，纯对话不显示「无项目」位置条。Runtime 目录的绑定与保留规则见 [Runtime 工作区契约](dev/runtime-workspaces.md)。
选择 Project 后使用其指令、资源、Memory 和 Wiki。绑定的 Project 被归档或删除后，下一轮清除旧执行上下文，在平台 Chat 目录冷启动为纯对话；之后正常续聊。
界面显示「已绑定的项目不可用」，旧真实目录和已有仓库文件保持不动。历史列表不提供按 Agent 或 Runtime 的筛选。
Chat 与 Issue 独立：在聊天里创建 Issue 只创建工作项，不绑定会话，不继承该 Issue 的项目、仓库、附件或 Wiki 上下文。
任务领取中的只读 `chat_project_id` 来自 Chat 显式选择的项目；仅保留与该 ID 匹配的项目提示词和资源，不从历史 Issue 推导项目。
Web Chat 和飞书一对一私聊不接收 Issue 活动播报；飞书群里的 Issue 话题由飞书绑定表记录归属。Issue 最后一个在跑任务结束时（完成、失败、取消均算），系统将带触发任务 ID 的报告信封写入绑定 Chat 的会话日志，转述任务自行阅读 Issue 日志并回帖；同一触发任务的信封去重。
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

其他绑定 Project 的 Chat 在 daemon 的 `work/<chat_session_id>` 目录运行（位于 `MULTIREMI_WORKSPACES_ROOT` 下，见[存储与保留](dev/storage-retention.md)）。
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

消息写入对话日志。正在运行的轮收到定向的 now 消息会插话；pending 轮合并后续消息，领取时读取连续输入范围。同一 lane 只有一个 pending 轮。
运行中有两种后续发送方式，取舍见 [ADR 0020](adr/0020-chat-follow-up-queue-and-native-steering.md)：

- **引导**：普通发送 `POST /api/sessions/:id/messages`，`wake_requested:"now"`，行为不变，送进正在运行的这一轮。未读消息可用 `PATCH`/`DELETE /api/messages/:id` 编辑或删除，已进入轮输入的返回 409；编辑和删除留下日志标记。
- **排队**：`POST /api/sessions/:id/queue` 把消息存进服务端队列表，不写对话日志。lane 没有 pending、running 或 awaiting_human 轮且未暂停时立即放行；否则在当前轮 completed 的终态事务里按入队顺序放行。放行把每条转成普通成员 now request，第一条建 pending 轮，其余合并进同一轮，正文全部内联；它们排在本轮回复之后进入日志。

排队的条目只有原发送人能改：`PATCH .../queue/:qid` 可带 `expected_revision`，`DELETE` 幂等，`POST .../queue/:qid/steer` 立即放行这一条（改为引导，重复调用返回同一条消息）。
已被轮放行的条目再改或引导返回 409 `queued_message_consumed`，版本不符返回 409 `revision_conflict`，归档的 Chat 入队、引导和继续返回 409。每个 Chat 最多 50 条未放行条目，每条最多 10 个附件。

队列会暂停，暂停期间轮结束也不放行：

| 原因 | 触发 | 解除 |
|---|---|---|
| `interrupted` | 成员停止当前轮（`POST /api/turns/:id/cancel`） | `POST .../queue/resume` |
| `turn_ended` | 轮 failed，或被成员以外的身份取消 | `POST .../queue/resume` |
| `send_failed` | 放行某条失败；该条标为 failed，后面的条目不越过它 | resume，或编辑、删除、引导该条后不再有 failed 条目 |

resume 清除暂停、把 failed 条目重置为 queued，lane 空闲时全部放行；队列为空时暂停自动清除。
归档时被取消的轮既不放行也不暂停；恢复后条目保留，resume、下一次入队或下一轮 completed 时放行。`wake=next_turn` 的含义不变，仍不会单独补铃。
当前 Web 输入框在运行中仍直接发送（引导）；排队入口与队列列表由前端后续接入。

收尾用 turn wrap-up，取消用 turn cancel，重试在同一轮新增 attempt。取消不撤销已执行的工具操作。
输入框在发送失败时保留草稿，删除失败时保持会话选择。

聊天记录与 provider 会话是两层状态。正常续接复用既有运行上下文，输入范围从当前 agent lane 的实际读游标开始，
包含尚未读取的请求和编辑后的 next_turn 正文，过滤已删除消息；无法续接时，Remi 使用有预算的聊天历史投影，
截断会被标识。不能据此承诺每轮携带完整历史或底层工具的全部工作记忆。

内部恢复入口可为尚无已完成谱系的首轮显式提供 Runtime、provider session 与工作目录；领取时保留这些初始值，后续用户轮使用已完成的 Chat 谱系。飞书 transport 的亲和性仍按其绑定刷新。

只读飞书 Issue 话题保留所属 Project 的仓库展示目录，自动 checkout 仍使用独立的显式仓库清单。

自动终态回复发给 Chat 创建者的工作区成员，成功结果和最终失败均进入该成员的收件箱。
Chat 列表的未读计数使用同一 member lane；读到较早消息保留最终回复未读，读到回复后清零。

## 权限与实时更新

直接聊天仅创建者可读写，另需满足工作区成员与 Agent 访问条件。其他工作区成员及管理员不能读取别人的私聊。
消息范围读取 `messages?from&to`、单条展开 `log/entry`、定位 `log/locate` 和 `log` 窗口允许任务凭据读取自身绑定的 Chat，
前提是任务、凭据与 Chat 的工作区一致；飞书个人机器人 Chat 同样适用。任务凭据访问同工作区其他 Chat 返回 403，
即使目标创建者是凭据中的用户或 Runtime owner，也不回退到创建者权限。未绑定且不存在的会话同样返回 403；
已删除的绑定 Chat 与跨工作区 Chat 返回 404。人类 PAT/JWT 仍沿用创建者访问规则。
范围读取按凭据中的 agent 记录实际已读进度，定位、窗口和单条展开不推进该进度。
消息、附件、task transcript 和实时订阅各自保留对应权限检查，不能只依赖页面隐藏。
任务详情与控制接口、Agent 任务列表同样检查私聊权限；Issue 分享不包含 Chat 的输入与执行记录。
删除会话后，留存任务继续保留私聊标识以拒绝读取，也不能通过复用旧会话 ID 重新取得这些记录。
工作区选择沿用服务端统一解析规则：显式工作区参数优先，其次为请求头和凭据绑定的工作区。
聊天列表、创建和待处理任务在解析工作区后继续校验成员权限；未知 slug 不回退到 `local`。

服务端数据由 Query cache 管理，草稿和选择由工作区分区的 store 管理。WS 更新保持当前执行任务与后续队列分离，
取消某条排队消息不能清除另一条正在执行任务的状态。队列的每次变更、放行和暂停在提交后发送 `chat:queue_updated`，只推给该 Chat 的创建者；放行的消息经普通日志流到达。
已上传附件的草稿绑定与文本一起按工作区保存，切换浮窗、独立页或会话后仍可发送。

## 归档、来源与自动化 Chat

Chat 是 daemon 存储模型里的一类主体（见[存储与保留](dev/storage-retention.md)）：被归档即视为结束，工作区按保留期回收，置顶的 Chat 不回收。
活跃 Chat 超过工作区设置 `chat_idle_days`（默认 14 天，0 为不自动归档）没有新消息会被自动归档；归档的 Chat 收到新消息（成员、飞书或自动化续接）自动恢复活跃。
`run_only` 自动化每次运行新开一个 Chat，带 `origin: { autopilot_id, run_id }`；agent 判断没有值得报告的内容时执行 `remi automation quiet`，运行完成后该 Chat 自动归档，否则保持活跃并带未读。
Chat 列表默认只显示用户的对话，`origin=automation|all` 或 `remi chat list --origin automation|all` 查看自动化开的 Chat；独立页侧栏通过底部「自动化」入口查看。

## CLI 与验证入口

```bash
remi chat create --agent <id>
remi chat create --agent <id> --project <project-id>
remi chat create --agent <id> --runtime-workspace <runtime-workspace-id>
remi chat update <chat> --title <title>
remi message send <chat> --to <agent> --content-file <path>
remi chat pin <chat>
remi chat unpin <chat>
remi chat archive <chat>
remi chat restore <chat>
remi message list <chat> --unread-by <agent>
remi message edit <message> --content-file <path>
remi message delete <message> --yes
remi inbox read <chat>
remi turn list --chat <chat>
```

接口实现见 [Chat 路由](../packages/server/src/api/routers/chat.ts)、
[ChatRepo](../packages/server/src/store/repos/chat-repo.ts) 和
[任务领取](../packages/server/src/store/repos/tasks-repo.ts)。前端入口见
[Chat 视图](../frontend/packages/views/chat) 与 [core/chat](../frontend/packages/core/chat)。
验证方法遵循[测试指南](../TESTING.md)；`bun run smoke:chat` 启动隔离浏览器测试。
单元测试、浏览器冒烟和真实 provider 执行分别报告结果。
跟进队列的 Store 状态机与 HTTP 鉴权、错误码分别由 `tests/unit/multiremi/inbox-chat-follow-up-queue.test.ts` 和
`tests/unit/multiremi/multiremi-api-chat-queue.test.ts` 覆盖，配置 `MULTIREMI_TEST_POSTGRES_URL` 时同时跑 PostgreSQL。
`tests/integration/daemon-protocol-v2/chat-unread-consumption.test.ts` 使用隔离的真实 daemon、API、SQLite、
ACP 子进程与 CLI 范围读取，回归连续 warm 输入和 next_turn 编辑/删除的消息 ID、正文哈希、读取次数与持久回执。
该测试使用测试 provider，不调用真实模型，也不代替 PPE 或浏览器验收。
