---
title: Feishu 消息接入
status: active
summary: 当前机器人 Chat/Issue 话题与轮次推送，以及独立的 Messaging Core 采集、授权和验证入口。
---

# Feishu 消息接入

本页分别说明机器人对话和 [Messaging Core](../packages/server/src/messaging/index.ts)的 Lark CLI 采集。机器人连接器在[packages/connectors/src/feishu](../packages/connectors/src/feishu)，由[工作区 bot 配置与 Runtime 分配](deploy/66-8-remi-environment.md)驱动；两者的凭据、消息处理和验证不能混用。

## 机器人对话、Issue 话题与更新

[FeishuBotRepo](../packages/server/src/store/repos/feishu-bot-repo.ts)维护飞书传输会话及群 Issue 话题归属。普通 Web Chat 和飞书私聊与 Issue 独立，在其中创建 Issue 不绑定会话，也不继承新 Issue 的项目、仓库、附件或 Wiki。Chat 的 Issue 绑定和订阅 API/CLI 已移除，见[命令迁移](cli-command-migration.md#removed-chat-issue-binding-mul-301)。

- **自动话题**：[工作区配置](../packages/server/src/issue-topics/config.ts)默认关闭，启用需目标群 `chat_id`，可按 `project_ids` 限制；空项目列表表示不限制项目。配置写入要求人类工作区管理员，[workspace CLI](../apps/remi/cli/commands/workspace.ts)提供 `remi workspace issue-topics get/set`。话题创建还需 bot 在线，根消息进入持久化 outbox；缺少条件不代表以后会自动补建。群消息自动建单另受发送者与 Agent 提议策略约束。
- **增量上下文**：[AgentIssueUpdatesRepo](../packages/server/src/store/repos/agent-issue-updates-repo.ts)仅对有效飞书 Issue 话题及已启用的通知通道合并活动，过滤目标会话自己的回声。更新写成待投递消息，不逐条唤醒 Agent；[claim wire](../packages/server/src/api/wire/tasks.ts)按预算附加该话题的 Issue 与摘要。普通私聊不接收这些播报，摘要不能替代 Issue 详情与评论查询。
- **轮次推送**：负责人 Issue Session 任务完成并满足活跃任务条件时，[TasksRepo](../packages/server/src/store/repos/tasks-repo.ts)准备话题总结；需要人工输入时也可准备话题提醒。领取、投递与完成均核对绑定、Issue、工作区、Chat 和 Agent 的一致性，失配不继续发送。话题总结本身不自动修改 Issue 状态或追加 Issue 评论。
- **出站投递**：daemon 心跳领取带租约的 delivery，经 [concierge host](../apps/remi/cli/multiremi.ts)发送并回报；失败按持久化 outbox 规则重试。[send.ts](../packages/connectors/src/feishu/send.ts)使用 delivery 幂等键，根消息成功后以返回的消息 ID 固定话题目标；这不等于真实飞书端已验证恰好一次投递。

### 斜杠命令与「结束任务」

飞书客户端在原生 CoT 消息上渲染「中断」按钮（7.71 起）。点击后**客户端不是回调应用，而是以用户身份发一条普通文本消息**：单聊为 `/stop`，群聊为 `@bot /stop`；飞书接入参考要求接入方像 `/help` 一样在 prompt 前拦截它。正因为它是用户消息，入站链路不会过滤，必须由命令层识别。

命令识别在 daemon Task 模式的 `createFeishuTaskHandler`（[apps/remi/cli/multiremi.ts](../apps/remi/cli/multiremi.ts)），匹配源是 `metadata.rawContent`（连接器已剥离 @机器人），**不是 `message.text`** —— 后者带群聊 `贺华杰: ` 前缀与引用回复的 `[Replying to: …]` 前缀，按它匹配会让群内所有命令失配并落回建任务。解析规则见 [feishu-commands.ts](../apps/remi/cli/feishu-commands.ts)：`^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$`，命令名大小写不敏感，忽略首尾空白。

| 命令 | 行为 |
|---|---|
| `/stop` | 取消该会话当前的**一条** chat task（含 `/stop <task_id\|Issue key>` 消歧形式），回一张命令卡 |
| `/new` | 取消该会话当前任务并开始新对话 |
| `/status` | 回一张对话快照卡（对话 / 任务 / 状态 / 工作目录） |
| 其他裸斜杠单 token（如 `/clear`、已下线的 `/esc` `/sessions` `/context` `/cwd` `/compact`） | 回中文提示卡，列出 `/stop /new /status`，**不建任务、不建 Issue** |

命令表只有这三项（`apps/remi/cli/feishu-commands.ts` 的 `FEISHU_COMMANDS`）。已下线的名字**不留别名**：`/esc` 曾是 `/stop` 的同义词，现在与 `/clear` 一样落入提示卡。

带参数或含第二个 `/` 的消息（如 `/data00/home/x 看下`、`/help 怎么用`）按普通消息提交，避免误伤。`receive.ts` 的 `isSlashCommand` 群准入豁免保持不变——这是群聊里不 @ 机器人也能收到 `/stop` 的前提。

取消定位分三级（[FeishuBotRepo.cancelSessionTask](../packages/server/src/store/repos/feishu-bot-repo.ts)）：① 会话 key 精确命中（私聊 `chatId`、话题内 `chatId:thread:rootId`）；② 群顶层消息按**同 chat + 同发送者**的未结束任务回退，恰好 1 个才取消，≥2 个回候选卡（列出 Issue key / task id / 状态 / 已运行时长，最多 5 条）而不猜；③ 无候选则回「当前没有正在运行的任务」且不做任何写操作。判定候选沿用 Chat 队列的 pending 状态集合（`queued` / `dispatched` / `running` / `waiting_local_directory` / `awaiting_human`），发送者无法匹配时一律不进候选（fail closed）。

**取消范围只到那一条 chat task。** 飞书 concierge 是独立 agent，它的 run 与 Issue 侧的 run 是两回事，所以 `/stop` 只取消 `getPendingChatTask(binding.chat_session_id)` 定位到的那一个任务（`TasksRepo.cancelTask`）。委派出去的子任务与评论 @ 触发的任务虽然带着 `parent_task_id` 指回它，但那个字段记录的是「谁触发了它」，不是「谁的 run」——这些任务 `chat_session_id IS NULL` 且有自己的 `issue_id`，**继续运行**，它们的回报仍会通过正常的 delegation wakeup 送给 delegator agent。停止一条飞书消息不应结束 Issue 的工作。

取消经已有内部路由 `POST /api/daemon/runtimes/:runtimeId/feishu-bot/session/cancel` 落到 `TasksRepo.cancelTask`：同一事务、同一 workspace 生命周期锁。内部路由与 `FeishuBotCancelResult` wire 契约未变。

反馈以服务端 task 状态为唯一事实源：命令卡只说「已请求停止」，CoT 卡片的 `RUN_FINISHED{status:"interrupted"}` 仍由既有 `pollFeishuTask` 在看到 `cancelled` 快照后触发（见[原生任务呈现](feishu-native-task-presentation.md)）。服务端未确认前不会出现「已停止」字样。

Issue 话题不出现在 Web/CLI 私聊和待处理列表中。旧关联按确定归属证据迁移，无法确认的关联暂停 Issue 通知，保留管理员审计记录；修复流程及数据回滚条件见[迁移手册](migrations/chat-issue-decoupling.md)。不得通过旧 Chat Issue 字段或历史任务重新恢复普通私聊的 Issue 上下文。

## 当前组件与能力

| 组件 | 职责与源码 |
|---|---|
| Connection | 绑定 provider/channel 与配置，保存连接健康状态。见[MessagingRepo](../packages/server/src/store/repos/messaging-repo.ts)。 |
| Source | 绑定 Connection，设置会话 allowlist、启用状态、轮询间隔及保留策略。 |
| Scheduler | 租约、增量游标、重叠时间窗、去重、未处理重试和过期清理。见[scheduler.ts](../packages/server/src/messaging/scheduler.ts)。 |
| Lark CLI Provider | 通过 argv 调用 lark-cli；执行渠道读取、结构归一、连接配置和交互授权。见[provider.ts](../packages/server/src/messaging/providers/lark-cli/provider.ts)、[runner.ts](../packages/server/src/messaging/providers/lark-cli/runner.ts)。 |
| Outcomes | 通知、回复草稿、Issue 提案和处理审计。见[outcomes.ts](../packages/server/src/messaging/outcomes.ts)。 |

Provider manifest 当前声明 pull、会话检索/读取、send/reply、attachmentDownload、edit/recall、连接配置及交互授权；不支持 push、attachmentUpload、mention、reaction。**Provider 能力不等于已发布的用户 API**：当前 [Messaging 路由](../packages/server/src/api/routers/messaging.ts)提供采集/查询/处理结果/提案操作，没有通用发送或附件下载端点。采集产生的回复草稿是 Inbox 内容，不会自动发送飞书消息。

附件归一支持结构化 `attachments` 和内容中的 file/image key。若 lark-cli 只给渲染后的文字占位符，Provider 不从 `[Image: ...]` 猜测文件 key；不能据此声称所有历史消息都能下载附件。

## 部署与连接授权

API 镜像内置固定版本并校验摘要的 lark-cli；版本及构建参数见[Dockerfile.api](../deploy/docker/Dockerfile.api)，运行配置见[部署指南](../deploy/README.md)。Provider 当前最低版本为 `LARK_CLI_MINIMUM_VERSION=1.0.90`。Core 不依赖另起一个采集 sidecar。

通过 Connection 配置应用时，Provider 为每个连接创建 managed profile；应用 secret 经 stdin 交给 lark-cli，数据库配置只保存 profile 引用。交互授权会返回用于用户完成授权的 URL 和公开会话状态；私有 device code 留在服务端会话内。实现见 Provider 的 `provisionConnection`、`beginAuthorization` 以及 Messaging 路由，不能把一次全局 CLI login 当作每个 Connection 都已完成授权。

[CLI 声明](../apps/remi/cli/commands/operations.ts)中的常用入口：

```bash
remi messaging provider list
remi messaging connection add --help
remi messaging connection authorization start <connection>
remi messaging connection authorization get <connection> <session>
remi messaging connection check <connection>
remi messaging source add --help
remi messaging source available-conversations <source>
remi messaging source status <source>
```

Connection 的 Provider 配置走结构化输入，具体字段以 API 和 CLI help 为准。现有 profile 与 managed profile 的清理行为不同：删除 managed Connection 会调用 lark-cli logout/remove profile；不直接编辑凭据文件。旧 `remi feishu` 命令仍有兼容路由，新接入使用上述 Messaging 入口。

## 机器人发送者白名单

机器人默认使用 `sender_access_policy=agent`：能与机器人聊天的人，都可以使用回复 Agent 已开放的能力，无需绑定空间成员或单独审批发送人。Agent 自身的提议审批要求以及独立的任务策略仍然有效。升级后已有机器人同样默认采用此规则；已记录账号的 `allowed=false` 不再限制现有 Chat、子任务或由其触发的自动化建单。无需把 owner 或其他账号补进白名单。

需要额外限制发送人时，空间管理者可在设置的「集成」中主动开启白名单（`sender_access_policy=allowlist`）。只有此模式下才检查下面的账号授权。修改访问策略会在下一次 API 请求生效；任务凭证不能修改此配置。普通配置保存省略此字段时保留已选策略。

机器人收到请求时，按当前应用的 `(app_id, open_id)` 自动记录发送者并去重，保存显示名称、首次和最近请求时间；账号记录不等于建单权限。白名单模式下，新账号默认「待授权」。空间管理者可「加入白名单」或「移出白名单」，不需要关联 Remi 用户，也不创建空间成员。更换机器人应用后按新应用的账号范围重新管理。

账号列表会从机器人已接收消息的发送者信息补全姓名和英文名（`with_sender_name=true`），不要求额外的通讯录资料权限。Web 展示姓名、英文名、Open ID，并可展开查看 Union ID；CLI `sender list` 同步返回这些资料。列表每次最多刷新 10 个账号，单次网络查询最多 4 秒，同一账号 10 分钟内复用结果；查询失败保留已知姓名及原有授权。刷新只更新资料，不改变授权、首次或最近请求时间。无法读取姓名时，页面用账号 ID 后缀区分用户。

白名单控制该账号通过机器人 Chat 创建 Issue 的权限，未允许的账号仍可对话。Issue 创建时重新检查来源账号；允许后可继续当前 Chat，移出后该 Chat 及其子任务的下一次创建会被拒绝。同一 Chat 已收到多名发送者的请求时，全部来源账号都需允许。Agent 自身的提议审批策略仍独立生效；白名单不会将普通聊天中的「同意」当作审批，也不会追溯撤销已经建立的独立定时自动化。

已配置群话题的自动 Issue 创建同样检查白名单和 Agent 提议策略；已有 Chat 必须满足全部来源账号均已允许，才会在后续群消息到达时创建并绑定 Issue。群聊路由仍决定负责该 Issue 的 Agent。

旧版本已写入任务的 `issueCreationRestricted` 不会自动清除；历史任务缺少可可靠归因的发送者记录。遇到此类旧受限会话，加入白名单后需在飞书使用 `/new` 开始新会话，再发送请求。

未授权任务创建的持久 Agent 或 Autopilot 配置仍继承已有的提议审批策略，后续给账号授权不会自动清除这些配置上的策略；需要空间管理者另行调整。白名单的动态恢复针对 Chat 与普通任务来源链，不等于重写已保存的自动化权限。

[管理 API](../packages/server/src/api/routers/feishu-bot.ts)仅允许已登录的空间管理者读取和更新账号授权，task/daemon 身份不能自行授权。对应 [CLI](../apps/remi/cli/commands/workspace.ts)使用明确的位置参数，`sender` 为列表返回的账号记录 ID：

```bash
remi workspace feishu-bot sender list <workspace>
remi workspace feishu-bot sender allow <workspace> <sender>
remi workspace feishu-bot sender revoke <workspace> <sender>
```

这份账号白名单属于机器人对话链路，与下面 Messaging Source 的会话采集 allowlist 分开维护。

## 机器人消息回应

- **消息回应**：原消息收到后保留 🤔（`THINKING`）；任务正常完成且结果卡已确认发送后移除本机器人的处理中回应，不再添加 `DONE`；失败或取消仍替换为 ❌（`CROSSMARK`）。入队和 steer 返回不清除回应；最终任务快照携带全部原消息 ID，确保执行期间追加的消息也能更新。失败替换先添加新回应，再删除旧状态；成功清理也兼容旧版本的 `DONE`，保留其他人、其他应用及非回执类表情。本进程记录最近完成的消息，避免迟到的 received 回调恢复处理中；跨重启的入站事件由接收去重处理，投递重试则依据已持久化的结果卡 ID 跳过处理中回应。终态回应清理的可重试错误由持久化 outbox 重试，已确认的结果卡不重复发送，Runtime 交接不标记失败。实现见[回应状态](../packages/connectors/src/feishu/message-receipt.ts)与[任务投递](../packages/connectors/src/feishu/task-presentation.ts)。本次回执修复需要升级承载机器人的 Runtime。

## 采集与处理约束

这些约束来自 Scheduler、MessagingRepo、Provider 和 Outcomes，不代表已验证任何当前部署：

- 空 allowlist 不采集；Scheduler 和落库层均检查范围。落库层比较消息及会话激活时间的分钟值，仅接受后续分钟，激活所在分钟的部分消息可能被跳过。
- 消息身份为 `(connection_id, external_message_id)`；内容更新不会重置已有处理状态。Scheduler 使用重叠时间窗接住延迟出现的消息，避免仅依赖严格单向时间游标。
- Runner 强制 `TZ=UTC` 归一 lark-cli 无时区的分钟时间。消息搜索页上限 50、会话搜索上限 100，Provider 按各命令上限截取。
- `processed_at` 标识处理完成；默认 900 秒检查未处理消息，达到默认 3 次重试限额后写入 `dismissed/unprocessed_timeout`。实际值由 Source 配置决定。
- notify/draft-reply 受 `feishu_messages` 通知偏好控制；明确静音产生 `recipient_muted` 终态。Issue 提案需经人类管理员批准/拒绝；批准路径有去重与审计，task token 不能批准提案。
- 对 watcher 启用 `issue_creation_requires_proposal` 时，直接和 Autopilot 间接建 Issue 都受策略限制；此策略不是所有 agent 的默认行为。
- 缺失 CLI、未授权、版本不兼容等通过 Connection 状态及错误码暴露；限流/超时的可重试处理见 Provider，不能把这些状态等同于 Source 永久停用。

**暂停与删除有不同的数据结果**：停用 Source 停止后续采集；已有内容仍受保留策略管理。删除 Source 会删除关联消息、outcome 和游标；删除 Connection 会连同 Sources、消息和 outcomes 一并删除。需要保留数据时使用停用操作，不能把删除作为无损暂停。

## 验证入口

按改动选择当前单元测试：

```bash
bun test tests/unit/multiremi/multiremi-feishu-issue-topics.test.ts tests/unit/multiremi/multiremi-feishu-bot-task-bridge.test.ts
bun test tests/unit/multiremi/multiremi-agent-issue-updates.test.ts tests/unit/multiremi/multiremi-store-daemon-wire.test.ts tests/unit/connectors/feishu-send.test.ts
bun test tests/unit/multiremi/lark-cli-message-provider.test.ts tests/unit/multiremi/messaging-scheduler.test.ts
bun test tests/unit/multiremi/messaging-repo.test.ts tests/unit/multiremi/messaging-outcomes.test.ts
bun test tests/unit/multiremi/messaging-api.test.ts tests/unit/multiremi/messaging-contract.test.ts tests/unit/multiremi/feishu-compat.test.ts
```

[真实 CLI 集成测试](../tests/integration/lark-cli-message-provider.test.ts)只读取当前已授权账户，不发送/回复/上传；缺少 lark-cli 或登录时会跳过。`bun test tests/integration/lark-cli-message-provider.test.ts` 的绿色结果必须同时检查执行/跳过数量。更改连接授权、发送等 Provider 能力时，还需分别验证对应能力；只读采集测试不覆盖它们。实际执行结果和真实飞书验证范围应记录在对应任务或 PR。
