# ADR 0024：侧边聊天——从主对话分叉出的临时 Chat

- 状态：已接受（第一阶段的设计与可行性验证；用户 2026-10-20 对 Q1–Q8 的决定见文末「已决定」）。尚未实现：本 ADR 不代表功能已存在、已部署，也不代表 daemon 已升级。
- 继承 [ADR 0016](0016-unified-message-inbox-and-turn.md)：轮由消息创建；一条会话线同时只有一个 pending 轮；会话线有自己的读游标。侧边聊天是一个普通 Chat 会话，这些规则原样适用。
- 继承 [ADR 0018](0018-local-records-and-recyclable-workspaces.md)：归档就是主体结束，工作区和运行环境按保留期回收，重开时恢复。侧边聊天跟着主对话归档和恢复（决策 11）。
- 继承 [ADR 0020](0020-chat-follow-up-queue-and-native-steering.md) 和 [ADR 0021](0021-subagent-sessions-and-autonomous-rounds.md)：侧边聊天里的引导、排队、子代理和自主轮与普通 Chat 相同。
- 修订 [ADR 0022](0022-background-tasks-keep-alive-on-demand.md) 的两处适用范围：侧边聊天的会话线从不驻留（决策 8）；它以「客人」身份进入主对话的本地文件夹，不排共享文件夹锁（决策 8）。
- 使用 [ADR 0023](0023-turn-input-and-provider-agents-md.md) 的会话设定通道：边界说明写进侧边聊天自己的 `AGENTS.md`（决策 7）。
- 编号：main 上最后一份为 0023。2026-10-20 核对，开着的 PR（`gh pr list`）和本地、远端分支都没有新增 ADR，本 ADR 取 0024。

## 背景

用户在 2026-10-20 定下了侧边聊天的产品规则：

1. **上下文。** 侧边聊天从主对话「此刻」的上下文开始，也就是把主对话分叉一份。它和主对话的轮同时进行，互相不等。
2. **安全模型学 Codex，不学 Claude。** 智能体、模型和工作目录都与主对话相同。「尽量不改东西」靠侧边聊天自己的说明（侧边对话边界：主对话的历史只作参考，不接着做主对话的计划、改动和批准，优先读和搜索），不靠硬性的只读工具。主对话里的批准不带过来；侧边聊天自己的权限请求走普通的提问与批准流程。
3. **生命周期是临时的。** 关闭就丢弃；有内容时先确认「关闭侧边聊天？这个侧边聊天将被删除，且无法恢复。」。隐藏面板不丢弃。「保存为普通对话」把它变成普通 Chat。没有自动删除：侧边聊天一直挂在主对话下，直到用户关闭或保存它（Q3）。
4. v1 不自动把结果带回主对话，也没有「发送到主对话」。
5. v1 只有会话头的一个按钮作为入口，没有 `/side`，也不能从选中文字或排队消息打开。
6. 布局上与子代理、后台任务的抽屉共用右侧面板，作为其中的标签；一个主对话可以同时有多个侧边聊天，每个一个标签，与 Codex 右侧的多个侧边聊天标签相同（Q2）。另一位 agent 正在改造这个抽屉（常驻的会话头按钮、Codex 那样随进度变化的宽度动画、所有轮的子代理概览），本设计按改造后的样子考虑。

参考行为（对 Codex 桌面版 v26.1007 的静态分析，以及 Claude 桌面版）：Codex 在用户请求时对父线程做 `thread/fork`（`ephemeral: true`），再加一段「Side conversation boundary」说明；侧边面板只画侧边聊天自己的消息，不重画继承来的历史；侧边线程不出现在普通线程列表里；轮、流和批准按线程隔离；已归档的对话不能开侧边聊天；归档或删除父线程似乎不会连带处理侧边线程（我们要连带）。Claude 桌面版用 SDK 的 `resume` 加 `forkSession: true`、`persistSession: false`。

仓库里已有的相关部分：

- **Issue 的旁支会话。** `multiremi_issue_sessions` 有 `parent_session_id`、`inherit_mode`（snapshot/follow）、`inherit_cutoff_seq`、`with_code`（[issue-sessions-repo.ts](../../packages/server/src/store/repos/issue-sessions-repo.ts) 109–197 行）。它不分叉 provider 会话，而是由服务端按预算把父会话日志做成摘录（`buildSessionProjection`，`perspectiveMode: "inherited"`），记录截断情况，并让 agent 用 `remi message list <父会话> --from --to` 读原文（[ephemeral.ts](../../packages/daemon/src/agent-runtime/prompts/ephemeral.ts) 436–460 行）。旁支会话的边界说明是 [side-conversation.ts](../../packages/daemon/src/agent-runtime/prompts/side-conversation.ts)；`isSideConversation` 对普通 Chat 恒为 false。
- **Chat 的 provider 谱系只有一个槽位。** `multiremi_chat_sessions` 的 `session_id`、`work_dir`、`session_runtime_id`、`session_provider`、`session_execution_fingerprint` 在轮结束时一起写入（[tasks-repo.ts](../../packages/server/src/store/repos/tasks-repo.ts) `afterTaskTerminal` 6333–6376 行）。轮进行中，daemon 只把 provider 会话 id 写在尝试那一行上（`task.session_pin`，[report-handlers.ts](../../packages/server/src/api/daemon-protocol/report-handlers.ts) 249–251 行）。新开 provider 会话时，这个 id 要到轮结束才报（[daemon.ts](../../packages/server/src/worker/daemon.ts) 4700 行只报继承来的 id）。
- **每条会话线有自己的 provider home。** 路径是 `env/<主体>/<会话>/<agent>/<scope|main>/<generation>/[executions/<指纹>/]home`（[layout.ts](../../packages/daemon/src/agent-runtime/workspace/layout.ts) 185–193 行，[session-home.ts](../../packages/daemon/src/agent-runtime/workspace/session-home.ts) 119–145 行）。Claude 的原生历史在 `CLAUDE_CONFIG_DIR/projects/<cwd>/<会话>.jsonl`，Codex 的在 `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`。所以父对话的原生历史只在它自己那台 daemon、自己那个 home 里。
- **每个 attempt 起一个新的桥进程，再 `session/resume`。** 只有驻留的会话线例外（[provider.ts](../../packages/acp/src/provider.ts) 2385–2386 行）。`packages/acp` 里还没有 `session/fork`。
- **共享本地文件夹锁。** Project 的 `local_directory` 和 Runtime 工作区按真实路径排 FIFO 锁；Runtime 工作区还要拿一份全机的 supervisor 租约（[ephemeral.ts](../../packages/daemon/src/agent-runtime/workspace/ephemeral.ts) 188–286 行）。daemon 自己管理的 `work/<chat>` 目录不加锁。

## 可行性验证

### 方法

- 版本与发版固定的一致：claude-agent-acp 0.93.0，`@anthropic-ai/claude-agent-sdk` 0.3.303（Claude Code 2.1.303）；codex-acp 2.2.2，codex 0.163.0（[runtime-versions.json](../../packages/acp/src/runtime-versions.json)）。桥用 `npm install --prefix /tmp/…` 装进一次性目录，没有使用 `~/.remi` 下已有的 bundle。
- 没有用任何真实凭据。每个桥进程都在一次性的 `HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 下运行，模型请求发到 127.0.0.1 上的假接口：一个假 OpenAI Responses 接口（Codex 的自定义 provider，`env_key` 填假值），一个假 Anthropic Messages 接口（`ANTHROPIC_BASE_URL` 加假 key）。假接口把每个请求体存下来，所以能直接看到分叉后的会话实际把什么发给了模型。
- 用一个最小的 ACP 客户端，按 Remi 的方式驱动桥：`initialize`、`session/new`、`session/prompt`、`session/fork`、在新进程里 `session/resume`。主对话第二轮故意做慢：Codex 的假接口推一段文字后挂 8 秒；Claude 的假接口回一个 `Bash sleep 8` 工具调用。在这一轮进行中分叉。
- 试了两种分叉方式。(a) 在主对话的桥进程里分叉。(b) 照 daemon 将来的做法：把主对话的原生历史文件复制到另一个 home（只保留完整的行），在另一个桥进程里分叉，再在第三个新进程里 `session/resume` 这个分叉出来的会话。
- 脚本和日志放在一次性目录里，没有提交进仓库，目录现已删除。上面的方法足以照做一遍；第二阶段会把它改成需要显式开启的集成测试（见测试计划）。

### 结果

| 编号 | 问题 | Claude（claude-agent-acp 0.93.0） | Codex（codex-acp 2.2.2 / codex 0.163.0） |
|---|---|---|---|
| F1 | 桥能不能分叉 | 能。`initialize` 声明 `sessionCapabilities.fork: {}`（`dist/acp-agent.js` 1406 行）；`session/fork` 由 `unstable_forkSession` 处理（1540–1562 行）。它调用 SDK 独立的 `forkSession(sessionId, {dir, upToMessageId?})`（`dist/fork-session.js`；SDK `sdk.d.ts` 840–877 行）：把对话记录复制成新会话、换新的 UUID，再像续接一样启动它。走的不是 `query({resume, forkSession: true})`，桥也不允许经 `_meta` 透传 `forkSession`（440 行）。不需要打桥补丁。 | 能。声明 `fork: {}`（`dist/index.js` 42440 行）；`session/fork` 转成 app-server 的 `thread/fork`，参数是 `{excludeTurns: true, config, cwd, lastTurnId?, modelProvider, threadId}`（34653–34687 行）。codex 0.163 的 `ThreadForkParams` 还支持 `ephemeral`、`developerInstructions`、`baseInstructions`，但桥不传这些。不需要打桥补丁。 |
| F2 | 指定分叉点 | 可选：AIR `_meta.jetbrains.air.fork = {version: 1, messageId, messageFingerprint?, messageOccurrence?}` 转成 `upToMessageId`。不带时复制到最新。 | 同一个 AIR 字段转成 `lastTurnId`（「这一轮不能正在进行」）。不带时复制到最新。 |
| F3 | 主对话正在跑时分叉 | 成功。正在跑的 `tool_use` 在分叉里被补成一条出错的 `tool_result`：「[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]」，后面跟一条 assistant「No response requested.」。主对话不受影响：它后来的请求里是真实的工具结果 `slow-done`，没有侧边内容。 | 成功。分叉里有主对话正在进行的那条用户消息，后面加一条 `<turn_aborted>`：「The user interrupted the previous turn on purpose…」。已经流出来、还没写进记录的文字不在里面。主对话照常完成，它后来的请求里没有侧边内容。 |
| F4 | 在另一个 home、另一个进程里分叉，之后用新进程续接 | 只复制 `projects/<cwd>/<会话>.jsonl` 一个文件就够了。分叉成功，新进程 `session/resume` 也成功。 | 分叉成功，新进程续接也成功。但 Codex 的分叉记录是「引用式」的：分叉出来的 rollout 只有自己的新条目，`session_meta` 写着 `forked_from_id`、`history_mode: "paginated"` 和 `history_base: {thread_id, end_ordinal_exclusive, end_byte_offset}`，续接时要读被引用的 rollout。只复制分叉自己的 rollout 时，再分叉会失败：`invalid paginated history lineage for <id>: missing source rollout`；把 `history_base` 指向的整条链一起复制就成功。 |
| F5 | 边界说明从哪条通道进得去 | `session/fork` 上的 `_meta.systemPrompt` 和规范字段 `systemPrompt` 都没有生效：分叉沿用源会话的系统提示词（对照实验：源会话带的追加标记出现在分叉的请求里，分叉自己带的标记没有出现）。新进程 `session/resume` 时带的 `_meta.systemPrompt` 也没有出现。新进程会重新读 `CLAUDE_CONFIG_DIR` 里的指令文件，并在下一条用户消息里注入：「Instruction files were re-read when this session started; these differ from their earlier copies — each replaces its earlier copy … Instructions no longer present: <主对话 home>/CLAUDE.md」。 | 新 home 的 `config.toml` 里的 `developer_instructions` 进不了分叉，它只在新线程创建时写进初始上下文（对照实验：新线程的请求里有，另一个 home 分叉出来的线程里没有）。新 `CODEX_HOME` 的 `AGENTS.md` 会被重新注入：「These AGENTS.md instructions replace all previously provided AGENTS.md instructions.」 |
| F6 | 用量会不会重复计 | 实测：分叉后每次 `session/prompt` 返回的 `usage` 只对应这一轮的新请求。没有经过 Remi 的用量采集器验证。 | 实测：分叉出来的 rollout 不含主对话的 `token_usage_record`，只有分叉自己的记录。按代码推断：daemon 读 rollout 用量时按线程 id 和 `sinceMs` 过滤（[codex-rollout-usage.ts](../../packages/acp/src/codex-rollout-usage.ts)），复制过来的主对话 rollout 不会被算进去；这一点没有实测。 |
| F7 | 额外的模型调用 | Claude Code 照常发起标题生成和「建议下一句」请求（与现在的行为相同）。 | 在主对话进程内分叉时，桥另发了一次标题生成请求；在另一个进程里分叉时没有看到。 |

### 结论

- Claude 和 Codex 都能用固定版本的桥原生分叉，不需要打补丁。Remi 要补的是：ACP 客户端的 `session/fork` 方法，provider 的分叉选项，以及 daemon 复制原生历史文件（Codex 要复制整条引用链）。
- 分叉要放在侧边聊天自己的桥进程和自己的 home 里做，这样它和主对话进程的生死、驻留、home 都不相干，主对话没在跑时也能分叉。
- 边界说明必须走 `AGENTS.md`（Claude 是经 `CLAUDE.md` 引用的 `@AGENTS.md`）。系统提示词和 `developer_instructions` 进不了分叉。
- 没有验证的：真实 provider 与真实模型的表现；首轮请求能不能命中提示词缓存；Antigravity（假定不能分叉，走退路）；主对话记录里有压缩、子代理侧链或后台任务时的分叉；Windows。

## 决策

### 1. 侧边聊天是一个独立的 Chat 会话

侧边聊天是 `multiremi_chat_sessions` 里新的一行。工作区、创建人、Agent、Project、Runtime 工作区都与主对话相同；它有自己的对话日志、成员会话线和 agent 会话线（执行范围为 `''`）、轮、跟进队列、提问、后台任务登记、trace、provider 会话和 provider home（`env/<侧边>/<侧边>/<agent>/main/1/…`）。

不在主对话上另开一条会话线（新的 `execution_scope`）。按会话 id 做的几处判断会让两条会话线互相干扰：会话线释放会把另一条标成 `lane_reset`（[background-tasks-repo.ts](../../packages/server/src/store/repos/background-tasks-repo.ts) 480–506 行）；排队的轮按 `chat_session_id` 串行领取（tasks-repo.ts 4295–4303 行）；归档会取消所有会话线的轮；谱系只有一个槽位，侧边的 provider 会话会覆盖主对话的。

不能从侧边聊天再开侧边聊天，与 Issue 旁支会话不支持链式分叉一致。保存为普通对话以后可以再开。

### 2. 数据模型

两条迁移链都做加法迁移，只给 `multiremi_chat_sessions` 加列：

| 列 | 含义 |
|---|---|
| `parent_session_id TEXT` | 主对话的 id。保存为普通对话后保留，用来显示来源；主对话删除时置空。索引 `(parent_session_id, ephemeral)`。 |
| `ephemeral INTEGER NOT NULL DEFAULT 0` | 1 表示还没保存的侧边聊天。 |
| `side_client_id TEXT` | 创建时的幂等键，与 `parent_session_id` 联合唯一。 |
| `fork_point_seq INTEGER` | 侧边聊天带的主对话日志位置（决策 4）。第一轮派发之前为空。 |
| `fork_json TEXT` | daemon 报告的分叉事实：方式（`native` 或 `projection`）、主对话的 provider 会话 id、分叉时主对话是否有轮在跑、复制了多少字节、走退路的原因、摘录的截断统计、时间。 |
| `promoted_at TEXT` | 保存为普通对话的时间。 |

- **可以有多个，上限放宽到 10 个。** 一个主对话可以同时有多个未保存的侧边聊天（Q2）。每个 `(主对话, 创建人)` 最多 10 个，创建时在锁住主对话那一行的事务里计数。上限只是保护资源：每个侧边聊天的第一次请求都带着整段主对话的上下文（决策 10），每个在跑的侧边聊天在主对话那台电脑上占一个桥进程和一个并发槽位，而且它们都不排文件夹锁（决策 8）。10 个远超正常使用，主要用来拦住重复点击或脚本误用；标签再多，右侧面板也难以使用。保存为普通对话的不计入。
- **所有列表都排除它。** `ephemeral = 1` 的会话不出现在 Web 列表、`remi chat list`、Cmd+K、「自动化」和「已归档」列表、未读汇总、收件箱和外发通知里。它不按自己的 `chat_idle_days` 自动归档，归档与恢复只跟着主对话（决策 11）。
- **wire 字段。** `ChatSession` 增加 `parent_session_id` 和 `side`（`{ephemeral, fork_point_seq, fork_mode, promoted_at}`，普通对话为 null）。主对话的会话响应增加 `side_chats`（按创建顺序的 `[{id, title, unread_count, running}]`），批量读取，与后台任务计数的做法相同，供会话头按钮和面板标签显示状态，不用另发请求。

### 3. 创建：发出第一条消息时才建

新开一个侧边聊天标签时，前端生成一个 `client_id`，草稿键是 `side:<主对话 id>:<client_id>`。用户在这个标签里发出第一条消息时，前端先调 `POST /api/chat/sessions/:parentId/side-chats {client_id, title?}` 建会话，再按普通方式发消息。`title` 默认取第一条消息的第一行，截到 30 个字，用作标签名。这与「新聊天在首条消息或首次上传附件时创建会话」一致：只打开不说话的标签什么都不留下，关闭时也不用确认。

创建条件：

- 主对话归档了，返回 409 `parent_archived`；
- 主对话本身是未保存的侧边聊天，返回 409 `parent_is_side_chat`；
- 飞书 transport 的会话，返回 409 `transport_chat`；
- 主对话还没有在任何电脑上运行过（没有谱系，也没有派到 Runtime 的尝试），返回 409 `parent_not_started`，按钮这时不可用；
- 已有 10 个未保存的侧边聊天，返回 409 `side_chat_limit`。

同一个 `client_id` 重复请求，返回 200 和同一行，所以网络重试和多个浏览器标签页都不会多建。

### 4. 分叉点：第一条侧边消息开始执行的那一刻

「此刻」定义为侧边聊天第一轮在 daemon 上开始的时刻，通常就是用户发出第一条侧边消息之后一两秒（Q1）。每个侧边聊天各自在自己的第一条消息时分叉，所以同一个主对话的几个侧边聊天可以带着不同时刻的上下文。

- 服务端在派发侧边聊天的第一个尝试时，在同一个事务里锁住主对话这一行，把主对话日志的当前最大序号写进 `fork_point_seq`（已经写过就不改），并把主对话的谱系放进派发内容（决策 13）。
- daemon 在准备这个尝试时复制原生历史。两边的时间点只差派发到准备之间的几秒，差多少记在 `fork_json` 里。
- 主对话这时有轮在跑：provider 会在分叉里把这一轮记成被中断（F3），边界说明会解释这件事（决策 7）。还在排队、或者正在送去引导但还没进原生记录的消息，侧边聊天看不到。
- 第一个尝试还没成功就失败或被取消时，谱系不会写入，下一个尝试重新分叉，用更新的快照。旧的分叉留在侧边聊天自己的 home 里，随它一起清理。

### 5. daemon 怎么分叉

带 `side_chat.fork` 的尝试在准备阶段：

1. **找到主对话的原生会话。** 主对话的会话线正在这台 daemon 上（attempt 中或驻留中）时，用它当前的 provider 会话 id，这样也覆盖了主对话第一轮新开会话、id 还没报给服务端的情况。否则用派发里的 `parent_provider_session_id`，它来自主对话的谱系或正在跑的尝试上记下的 id。主对话的 home 按 `resolveTaskProviderHome` 用主对话的会话 id 和执行指纹算出来，并校验它在存储根目录之内。
2. **复制原生历史到侧边聊天的 home**，保持相同的相对路径，截到最后一个完整的行：
   - Claude：`projects/<cwd>/<会话>.jsonl`（子代理侧链不复制，SDK 分叉用不到）；
   - Codex：根 rollout，以及沿 `session_meta.history_base.thread_id` 递归找到的每一个 rollout（F4）。
3. **在侧边聊天自己的桥进程里分叉。** 新增 `AcpClient.forkSession` 和 provider 的 `SendOptions.forkFrom`：`initialize` 之后，要求 `agentCapabilities.sessionCapabilities.fork` 存在，然后发 `session/fork {sessionId: 主对话会话, cwd, mcpServers, additionalDirectories}`，不带分叉点（复制到最新）。之后与 `_ensureSession` 对新会话做的一样，设权限模式、模型和推理强度。
4. **报告结果。** 新的可靠上报 `task.side_fork`：`{mode, provider_session_id, parent_provider_session_id, parent_turn_in_flight, copied_bytes, reason?}`，服务端写进 `fork_json`。新会话 id 照常经 `task.session_pin` 和轮结束时的谱系写入。
5. 第一轮成功以后，侧边聊天的谱系就是它自己的会话。之后每一轮都是普通的 `session/resume`，侧边聊天特有的只剩工作目录（决策 8）和不驻留。

### 6. 退路：用主对话的文字记录

下面这些情况不能原生分叉：provider 不声明 `fork`（Antigravity）；主对话的原生历史不在这台 daemon 上或已被回收；复制或 `session/fork` 出错；主对话还没有原生会话。这时 daemon 在侧边聊天的 home 里新开 provider 会话，本轮输入改用主对话日志的摘录，只到 `fork_point_seq` 为止（Q8）。

侧边聊天以后冷启动时也用同样的办法。比如主对话归档后被回收，侧边聊天跟着归档，它的运行环境也被回收；恢复以后，下一轮只能新开一代会话。普通 Chat 冷启动时只投影自己的日志，侧边聊天则是「主对话到 `fork_point_seq` 的摘录」加上自己的日志，预算按 Issue 旁支会话的继承份额切分。否则主对话那部分上下文会丢掉。

- **摘录与 Issue 旁支会话相同。** 服务端用 `buildSessionProjection`（`perspectiveMode: "inherited"`）和 `resolveProjectionTokenBudget` 的预算，按「只给范围加读取命令」的方式随第一轮派发（[offer-budget.ts](../../packages/server/src/api/daemon-protocol/offer-budget.ts) `useTaskSessionInput`），所以 daemon 走退路不需要再问服务端一次。
- **记录截断。** 截断写进 `fork_json.projection`：是否截断、省略了几条、估算 token 数、起止序号。
- **权限放宽一处。** 侧边聊天的任务凭据可以读主对话日志，但只能读到 `fork_point_seq`（扩展 [conversations.ts](../../packages/server/src/api/helpers/conversations.ts) 229–241 行的 `loadConversation`）。别的会话照旧返回 403。
- **界面提示。** 侧边面板显示一行「没能带上主对话的完整上下文，改用了它的文字记录（省略了 N 条）」。

### 7. 边界说明写进侧边聊天的 `AGENTS.md`

侧边聊天的 `AGENTS.md` 与主对话的内容相同（同一个 Agent、同一个 Project），末尾多一节「Side Conversation」。F5 说明这是唯一能进入分叉的通道：Claude 在新进程里重新读指令文件，用新的一份替换主对话的那份；Codex 重新注入 `AGENTS.md`，替换之前的那份。不使用 `systemPrompt`，也不使用 Codex 的 `developer_instructions`。

侧边聊天的第一轮输入在用户原文前多一行固定提示，因为模型刚读完很长的主对话历史，容易接着做下去。这是 [ADR 0023](0023-turn-input-and-provider-agents-md.md) 决策 4 里「每轮变化的事实各占一行」的一种。新增 `isSideChat(task)`。Issue 旁支会话的 `SIDE_CONVERSATION_INSTRUCTIONS` 写着不许改文件、不许委派，比本 ADR 要的更严，所以不复用；`isSideConversation` 对侧边聊天仍为 false。

`AGENTS.md` 里的那一节，初稿：

```text
## Side Conversation
This session is a side conversation that the user opened from the main conversation "<title>". The earlier history in this session is a copy of the main conversation up to the moment the side conversation started. Treat it as reference only.
- Only messages sent in this side conversation are requests to you. Do not continue, retry, or complete the main conversation's plans, edits, tool calls, approvals, or open questions.
- The main conversation keeps running in parallel, in the same working directory. If its last turn looks interrupted in your copy, or a tool call has no result, it was not interrupted: it is still running there. Do not re-run it, and do not check whether it took effect unless the user asks.
- Prefer reading, searching, and explaining. Change files, Git state, running processes, or configuration only when the user asks for it in this side conversation, and say exactly what you changed.
- Approvals given in the main conversation do not apply here.
- Nothing you write here is sent to the main conversation. The user decides what to carry over.
```

第一轮那一行：`(Side conversation: the history above is the main conversation, for reference only; see "Side Conversation" in your instructions.)`。走退路时改成摘录的说明，并给出 `remi message list <主对话> --to <fork_point_seq>`。

### 8. 工作目录与并发：以客人身份进入主对话的目录

- **同一台电脑、同一个目录。** 侧边聊天的每一轮都固定派到主对话所在的 Runtime，也就是持有主对话原生历史和工作目录的那台电脑。工作目录与主对话相同：daemon 管理的 `work/<主对话>`、Project 的 `local_directory`，或 Runtime 工作区。那台电脑离线时，侧边聊天的轮照常显示离线等待，不换到别的电脑。
- **客人不排锁。** 侧边聊天的会话线不排共享文件夹的 FIFO 锁，也不拿 Runtime 工作区的 supervisor 租约，所以从不等主对话的轮、它驻留的后台任务或同一主对话的其他侧边聊天。它也不做仓库自动准备（不 clone、不 fetch），只用主对话已经准备好的目录。daemon 对侧边聊天的工作目录做的是「这是主对话的目录」的校验，而不是「这是我自己的目录」。
- **主对话的工作区被回收过时，先替它恢复。** 主对话的 `work/<主对话>` 被回收过、侧边聊天又比主对话先跑一轮时，daemon 先按主对话下一轮会做的那样恢复它的工作区（快照与分支，[存储与保留](../dev/storage-retention.md)），再让侧边聊天进去。外部目录（`local_directory`、Runtime 工作区）不回收，不受影响。
- **从不驻留。** 侧边聊天的后台任务在每个 attempt 结束时停止，与 ADR 0022 决策 12 对 Issue 会话线的处理相同（Q5）。理由：它是临时的客人；驻留会占着进程，还可能在没人看的时候自己醒来改主对话的目录。
- **剩下的风险，用户已接受。** 侧边聊天、同一主对话的其他侧边聊天和主对话，可能同时改同一个工作树，或同时动 git 的 index。用户接受这个风险（Q7，与 Codex 相同），靠边界说明降低。并发槽位照常计算：daemon 的并发满了时，侧边聊天的轮和其他轮一样排队。
- **保存为普通对话之后，它就不再是客人。** 从下一轮起它在同一个位置按普通 Chat 的规则排锁和驻留。

### 9. 权限请求与提问

侧边聊天的 provider 是新进程里的新会话，主对话这次会话里给过的批准（Claude 的会话级规则、Codex 的已批准命令缓存）都只在内存里，带不过来。权限模式取 Agent 的配置，与主对话相同。

侧边聊天自己的权限请求和 AskUserQuestion 走普通 Chat 的路径：挂在侧边聊天的轮上，交给 Chat 的创建人（[questions.ts](../../packages/server/src/store/inbox/questions.ts) 64–81 行），显示在侧边面板自己的问题行和抽屉里。主对话的问题不显示在侧边面板里，侧边的问题也不显示在主对话里。

### 10. 用量

侧边聊天的每次尝试都是它自己的尝试，用量记在侧边聊天的任务上，Agent、Runtime、Project 与主对话相同。继承来的历史不会重复计费（F6）。

侧边聊天第一次请求的输入就是整段主对话的上下文，费用约等于主对话当时的上下文大小。能不能命中提示词缓存没有实测：Claude 的前缀相同，可能命中；Codex 按线程设缓存键，可能不命中。侧边聊天的上下文圆环从分叉时的大小开始。

### 11. 生命周期

未保存的侧边聊天只因用户的操作或主对话的生命周期而改变，没有按时间的自动删除（Q3）。

- **隐藏不等于关闭。** Esc、切换标签或收起面板都只是隐藏，侧边聊天和它正在跑的轮都还在。刷新页面后，会话头按钮和面板标签靠 `side_chats` 恢复。
- **关闭就是删除。** 走现有的 `DELETE /api/chat/sessions/:id`：取消它的轮，删除消息、队列和附件。有内容时先确认（决策 15）。这是删除未保存侧边聊天的两条途径之一，另一条是删除主对话。
- **跟着主对话归档与恢复（Q4）。** 现在归档一个 Chat 并不删除它：停止在跑的轮和后台任务，禁止继续发送，daemon 按保留期回收它的工作区，恢复后可以接着用（[Chat 契约](../chat.md)「归档、来源与自动化 Chat」，[存储与保留](../dev/storage-retention.md)）。侧边聊天照此处理：
  - **归档主对话。** 主对话被归档时，不论是手动归档、按 `chat_idle_days` 自动归档，还是自动化运行结束后归档，同一个事务都把它的未保存侧边聊天也归档。它们的轮被取消，内容保留。
  - **恢复主对话。** 主对话从归档变回活跃时，不论是点「恢复」还是有人往里写了新消息，同一个事务把它归档着的未保存侧边聊天也恢复。
  - **不能单独归档或恢复。** 未保存的侧边聊天不能单独归档或恢复：对它改 `status` 返回 409 `side_chat_follows_parent`。主对话归档期间往侧边聊天里发消息返回 409 `parent_archived`，不走「写消息就重开」的路径（[send-message.ts](../../packages/server/src/store/inbox/send-message.ts) 151–157 行要排除侧边聊天）。
  - **自动归档要算上侧边聊天。** 判断主对话是否闲置超过 `chat_idle_days` 时，它的未保存侧边聊天里的新消息和在跑的轮也算主对话的活动（[chat-repo.ts](../../packages/server/src/store/repos/chat-repo.ts) 202–233 行的 `archiveIdleChats`）。否则用户正在用侧边聊天，主对话却被自动归档。
- **删除主对话。** 主对话被删除时，同一个事务删除它的未保存侧边聊天。已保存的不受影响，`parent_session_id` 置空。
- **保存为普通对话。** `ephemeral` 置 0，写 `promoted_at`，状态不变。保留侧边聊天的标题（第一条消息的第一行，或用户改过的名字），保存时可以再改。它从此出现在列表里，按普通 Chat 的规则归档、恢复、回收，与主对话再无连带；会话头显示「从「{主对话}」分出」。
- **daemon 上的数据。** 侧边聊天是自己的存储主体。归档期间它是「已结束」，运行环境与普通 Chat 一样按保留期回收；`gc.check_chat_session` 对侧边聊天报告主对话的置顶状态，所以置顶的主对话连同侧边聊天都不回收。运行环境被回收过的侧边聊天，恢复以后走决策 6 的冷启动。关闭（删除）以后，`gc.check_chat_session` 返回 404，现有回收流程在 `orphan_ttl_ms`（默认 72 小时）之后删掉它的 home 和复制过来的原生历史（[reclaim.ts](../../packages/daemon/src/agent-runtime/workspace/reclaim.ts) 205–237 行）。这是跟在用户删除后面的清理，不是按时间的自动删除。界面上的「无法恢复」指产品里找不回来；原生文件在电脑上最多再留一个回收周期。

### 12. 接口

| 方法与路径 | 说明 |
|---|---|
| `POST /api/chat/sessions/:parentId/side-chats` | `{client_id, title?}`。新建返回 201，同一个 `client_id` 再请求返回 200，错误码见决策 3。只有主对话的创建人可以调；任务凭据返回 403。 |
| `GET /api/chat/sessions/:parentId/side-chats` | 主对话的全部未保存侧边聊天（最多 10 个，按创建顺序；主对话归档时它们也是归档状态），只有创建人可读。 |
| `PATCH /api/chat/sessions/:sideId` | 现有路由。可以改名；对未保存的侧边聊天改 `status` 返回 409 `side_chat_follows_parent`（决策 11）。 |
| `POST /api/chat/sessions/:sideId/promote` | `{title?}`，幂等：已经保存过的返回 200 和同一行；不是侧边聊天返回 409 `not_side_chat`。 |
| `DELETE /api/chat/sessions/:sideId` | 现有路由，就是关闭。前端把 404 当作已经关闭。 |
| 消息、排队、取消、重试、后台任务、提问 | 全部沿用现有的按会话 id 的路由；主对话归档期间写入返回 409 `parent_archived`。 |

- **实时事件。** 新增 `chat:side_chats_updated {parent_session_id, side_chats}`，只推给创建人；创建、关闭、保存、改名，以及跟着主对话归档或恢复时都发，供别的浏览器标签页更新会话头按钮和面板标签。保存后另发 `chat:session_updated`，前端让列表缓存失效重读。删除沿用 `chat:session_deleted`。
- **注意前端的删除处理。** 收到 `chat:session_deleted` 时只能重置与之匹配的 `activeSessionId`，不能清掉正在显示的主对话。

### 13. daemon 协议

- **能力位 `chat.side`。** daemon 在 `hello.caps` 声明，服务端在 `welcome.caps` 回显，与 `lane.background` 的做法相同。服务端只把侧边聊天的尝试派给声明了它的 Runtime，否则这一轮以「运行主对话的电脑上的 Remi 需要升级」等待。旧 daemon 不认识客人目录，会把侧边聊天放进它自己的 `work/<侧边>`，所以不能派给它。协议版本号不变。
- **派发字段 `side_chat`**，只出现在侧边聊天的任务上：`{parent_chat_session_id, parent_title, guest_work_dir, fork: null | {parent_provider_session_id, parent_execution_fingerprint, parent_runtime_id, point_seq, inherited_projection}}`。`fork_json` 记下分叉方式之前，每次派发都带 `fork`。
- **上报 `task.side_fork`**：可靠上报，同样受这个能力位约束（决策 5）。
- **派到哪台电脑。** 第一轮显式指定 `runtimeId` 和 `workDir`，与内部恢复入口的做法相同。但绝不把主对话的 `session_id` 当作侧边聊天的会话 id，否则会续接到主对话的原生历史上。侧边聊天第一轮排队时还没有谱系，`refreshQueuedChatAffinity`（tasks-repo.ts 4182–4239 行）不能把这台固定的 Runtime 刷掉。之后各轮跟随侧边聊天自己的谱系。服务端判断工作区谱系是否还有效时（[chat-workspace.ts](../../packages/server/src/store/chat-workspace.ts)），要把侧边聊天的工作目录当作主对话的目录来看。

### 14. CLI：注册真实命令

注册真实命令：`remi chat side create <chat> [--title]`、`remi chat side list <chat>`、`remi chat side promote <side-chat> [--title]`；关闭用现有的 `remi chat delete <side-chat>`；收发消息用现有的 `remi message send/list`。

理由：侧边聊天是有消息、有轮、有用量的真实资源，现有的消息命令已经可以完整地使用它。把创建标成 `pure_ui` 豁免，就等于藏起一项用户能力，[仓库规则](../../AGENTS.md)不允许这样做。

`chat side` 是现有 `chat` 主题域下的子命令，不是新的顶层主题域。新路由在 `scripts/generate-cli-capabilities.ts` 里登记映射，并重新生成 `cli-capabilities.json`。这三个接口对任务凭据都返回 403，与跟进队列相同：agent 不能给自己的对话开侧边聊天。

### 15. 前端

- **入口。** 独立页的会话头右侧新增一组按钮（现在会话头没有右侧按钮组，[chat-window.tsx](../../frontend/packages/views/chat/components/chat-window.tsx) 787–816 行）。抽屉改造加的常驻面板按钮和「侧边聊天」按钮并排放在这一组里。
  - 没有侧边聊天时，按钮打开面板并新开一个空的侧边聊天标签；
  - 已经有侧边聊天时，按钮打开面板，切到最近用过的那个侧边聊天标签；
  - 有侧边聊天时按钮带个数，其中有未读回复时带蓝点。
  v1 只在独立页放这个按钮，浮窗不放（Q6）。
- **面板与标签。** 与子代理、后台任务共用右侧面板。
  - **标签条。** 面板头是一条标签：先是「子代理」「后台任务」（各自有内容时才出现），然后每个侧边聊天一个标签，按创建顺序排列，最后是「+」新开侧边聊天。侧边聊天标签显示标题（第一条消息的第一行，没发消息前是「新侧边聊天」）、在跑时的转圈和未读圆点。悬停或聚焦时出现 ×，点了就是关闭（见下）。
  - **标签放不下时。** 标签条横向滚动，右端的「更多」菜单列出全部标签。标签条用 `role="tablist"`，方向键切换。
  - **状态怎么存。** `ChatPanelView` 从 `"subagents" | "tasks"` 扩成加上 `{kind: "side", key}`（[store.ts](../../frontend/packages/core/chat/store.ts) 169 行）。`key` 是侧边聊天的会话 id；还没发消息的标签，`key` 是 `client_id`。打开的标签和当前标签按主对话记在 store 里，切换会话再回来时还在；没发过消息的空标签刷新后不保留，有草稿的保留。
  - **宽度。** 沿用面板记住的比例。抽屉改造后随进度变化的宽度动画只作用于子代理和后台任务视图，切到侧边聊天标签时不动宽度。窄于 768px 时全宽覆盖，与现在一样。
- **一个侧边聊天标签的内容。** 从上到下：
  - 标题，副标题「带着主对话到 {时间} 为止的内容」，走退路时多一行说明（决策 6）；
  - 菜单：「重命名」「保存为普通对话」「关闭侧边聊天」；
  - 只有这个侧边聊天自己的消息，不重画主对话的历史；
  - 问题行、跟进队列和输入框。
  主对话归档时，标签仍可以打开查看，输入框与主对话一样不可用。侧边聊天里的子代理行和后台任务行在 v1 只能打开执行记录，不打开嵌套面板。
- **必须做的重构。** `ChatWindow` 现在把日志、乐观消息、发送、pending 轮、停止、已读都写在组件里，还会改全局的 `activeSessionId`，打开面板也只有一个全局槽位（`subagentPanel`）。要同时显示主对话和侧边聊天，先把这些抽成按会话 id 工作的 `useChatConversation(sessionId)`。侧边聊天的实例不调 `setActiveSession`，也不碰主对话的面板槽位。
  - **只挂当前标签。** 面板只挂载当前标签的那一段对话，日志订阅、乐观消息和输入框只有一份。其他标签的转圈、未读和标题来自主对话会话响应里的 `side_chats` 和 `chat:side_chats_updated`，所以开着 10 个标签也不会有 10 份实时订阅。
  - **切走时的状态。** 切走的标签，草稿按 `side:<主对话>:<key>` 保存，跟进队列在服务端，切回来时重新挂载。
- **键盘与焦点。** 打开或切到侧边聊天标签时，焦点进它的输入框。面板上按 Esc 隐藏面板，焦点回到主对话的输入框。在侧边聊天的输入框里连按两次 Esc，停止这个侧边聊天的这一轮，与主对话的规则相同。
- **关闭确认。** 用现有的 `AlertDialog`，文案「关闭侧边聊天？这个侧边聊天将被删除，且无法恢复。」；它有轮在跑时加一句「正在进行的回复会被停止。」；按钮是「取消」和「关闭」（destructive）。没发过消息的空标签直接关闭，不确认。关闭后切到相邻的标签；没有标签了就收起面板。
- **主对话的归档与删除确认。** 主对话的删除确认里多一句「它的 N 个侧边聊天也会被删除」。归档确认的条件不变（有轮或后台任务在跑），其中算上侧边聊天在跑的轮。
- **保存。** 「保存为普通对话」之后提示「已保存为普通对话 · 打开」，这个标签关闭，这段对话出现在侧栏里。
- **到了上限。** 已有 10 个侧边聊天时，「+」和会话头按钮的「新开」不可用，提示「最多同时保留 10 个侧边聊天，先关闭或保存一些」。

## 失败与边界情况

| 情况 | 行为 |
|---|---|
| 复制或 `session/fork` 失败，或 provider 不支持分叉 | 同一个尝试里改走退路（决策 6），`fork_json.reason` 记下原因，面板显示一行说明。退路也失败时，这一轮照常失败，可以重试。 |
| 运行主对话的电脑离线 | 侧边聊天的轮显示离线等待；可以关闭。 |
| 那台电脑上的 daemon 没有 `chat.side` | 等待，原因写明需要升级。 |
| 侧边聊天在跑时主对话被归档 | 同一个事务归档侧边聊天，取消它们的轮，内容保留；标签仍可查看，输入框不可用。恢复主对话时一起恢复（决策 11）。 |
| 侧边聊天在跑时主对话被删除 | 同一个事务删除未保存的侧边聊天，取消它们的轮。面板关闭，提示「主对话已删除，它的侧边聊天也已删除」。 |
| 主对话归档后被回收，再恢复 | 主对话的工作区由它自己或第一个跑的侧边聊天先恢复（决策 8）；侧边聊天的运行环境也被回收过，它冷启动，带主对话摘录加自己的日志（决策 6）。 |
| 主对话的原生历史已经回收（侧边聊天第一轮时） | 走退路。 |
| 分叉之后主对话冷重试或换了电脑 | 侧边聊天不受影响：它有自己的副本，固定在自己谱系所在的电脑上。 |
| 浏览器刷新 | 侧边聊天都还在，标签靠 `side_chats` 恢复；有草稿的空标签按 `side:<主对话>:<client_id>` 恢复。 |
| 网络重试或两个浏览器标签页用同一个 `client_id` | 幂等，返回同一个侧边聊天。 |
| 已有 10 个未保存的侧边聊天 | 返回 409 `side_chat_limit`；界面提示先关闭或保存一些。 |
| 侧边聊天有轮在跑时关闭 | 确认里提示会停止回复；删除会取消这一轮。 |
| 保存后的对话，主对话归档并被回收 | 保存后不再跟着主对话，但它用的仍是 `work/<主对话>`，这个目录可能被回收。下一轮走现有的「工作区谱系失效」路径，在它自己的目录里冷启动（tasks-repo.ts `clearStaleChatWorkspaceLineage`）。 |
| 侧边聊天的 daemon 重启 | 按普通尝试的恢复处理。它不驻留，所以没有要清扫的进程。 |

## 未采用的方案

- **像 Claude 那样硬性只读。** 产品决定 2 要的是 Codex 的方式；而且硬性只读要给两个桥分别做工具白名单，Codex 那边没有 allowed-tools 机制（[codex adapter](../../packages/acp/src/adapters/codex/index.ts)）。
- **只给摘要。** 丢掉工具输出和推理过程，侧边聊天回答「它刚才在做什么」时会凭空编；而原生分叉已经证明可行（F1–F4）。摘要只保留为退路，而且用的是原文摘录，不是另行生成的摘要。
- **自动把结果带回主对话，或提供「发送到主对话」。** 产品决定 4 不要。往运行中的轮里注入内容，还要另定插话和合并的规则。
- **在主对话上另开一条会话线。** 原因见决策 1。
- **在主对话的桥进程里分叉。** 这只在主对话的进程活着的时候才能做，会把两条会话线的进程、驻留和 home 绑在一起，侧边聊天也就没法用不同的 `AGENTS.md`（F5）。
- **复用 `multiremi_issue_sessions`。** Chat 的队列、后台任务、提问和权限都挂在 `multiremi_chat_sessions` 上，换表就要把这些重做一遍。
- **SDK 的 `persistSession: false` 或 Codex 的 `ephemeral: true`。** Remi 每个 attempt 起新进程再续接，必须有能续接的原生会话。临时性放在产品层面做：不进列表，关闭即删除，跟着主对话归档、恢复和删除。主对话归档后恢复时，侧边聊天也需要能续接或冷启动，进程内存里的会话做不到。
- **点开面板那一刻就做快照（经下行帧让 daemon 立即复制）。** 要多一个下行帧和一套确认机制，而首条消息时分叉与它通常只差几十秒（Q1）。
- **只分叉到上一个已完成的轮（`lastTurnId` / `upToMessageId`）。** 这样记录更干净，但会丢掉正在进行的请求，而那往往正是用户想问的；也不符合「此刻」。
- **一个主对话只允许一个侧边聊天。** 用户要的是 Codex 那样的多个标签（Q2）。
- **闲置一段时间自动删除。** 用户不要（Q3）。侧边聊天一直挂在主对话下，直到用户关闭或保存它。
- **归档主对话时删除侧边聊天。** 归档 Chat 本来就不删除它，侧边聊天也一样，跟着归档和恢复（Q4）。

## 影响

- 实现之前，现有行为没有任何变化。
- ACP 的 `session/fork` 在规范里仍标为 UNSTABLE。`release:prepare` 的候选校验（`scripts/verify-runtime-candidate.ts`）要加一项：两个桥都声明 `sessionCapabilities.fork`；不声明时依赖准备失败，不改发版文件。升级检查写进[配套升级说明](../daemon-runtime-upgrades.md)。
- 每个在跑的侧边聊天，在运行主对话的电脑上多一个桥进程（只在它的轮期间）。一个主对话最多 10 个侧边聊天，最坏同时多 10 个进程，仍受 daemon 并发上限约束。每个侧边聊天的 home 里有一份主对话原生历史的副本，大小与主对话的记录相当；它和主对话一起归档时按保留期回收，删除后由回收流程清理。
- 没有按时间的清理：用户不关也不保存的侧边聊天会一直留着，数量由每个主对话 10 个的上限约束。
- [开发入口](../dev/README.md)和 [Chat 契约](../chat.md)现在链接本 ADR，并标明尚未实现。实现时同批把 Chat 契约里的这一条改写成「侧边聊天」一节，并更新[架构地图](../ARCHITECTURE.md)、[daemon 协议](../daemon-protocol-v2.md)、[存储与保留](../dev/storage-retention.md)、[统一用量](../usage-accounting.md)和 [CLI 命令契约](../cli-command-migration.md)。

## 实施计划

粗略工作量：S 约 1 个 agent 日，M 2–4 天，L 约 1 周。

| 阶段 | 内容 | 量 |
|---|---|---|
| P1 | 本 ADR 与可行性验证 | 已完成 |
| P2 分叉能力 | `AcpClient.forkSession`、provider 的 `forkFrom`、能力检测；复制原生历史（Claude 记录、Codex rollout 引用链，截断不完整的行）；`release:prepare` 校验 fork 能力 | M |
| P3 服务端 | 迁移（两条链）；ChatRepo 的创建（10 个上限）、列表排除、保存、改名；跟着主对话的归档与恢复，四条入口都要接：手动归档、按 `chat_idle_days` 自动归档（算上侧边聊天的活动）、自动化运行结束归档、写消息重开；不能单独改状态，主对话归档期间不能写入；删除连带；接口与错误码；任务凭据读主对话的范围；派发 `side_chat`、Runtime 固定、谱系与工作区谱系判断；冷启动时「主对话摘录加自己的日志」；`gc.check_chat_session` 报告主对话的置顶；能力位与 `task.side_fork`；CLI 命令、`cli-capabilities.json` 与路由快照 | L |
| P4 daemon | 客人目录的解析与校验（不排锁、不拿租约、不做仓库准备）；主对话工作区被回收过时替它恢复；不驻留；`AGENTS.md` 的那一节与第一轮提示；第一轮分叉与上报；退路和冷启动时的输入 | M |
| P5 前端 | 抽出 `useChatConversation`；多个侧边聊天标签（标签条、「+」、×、溢出菜单、按主对话记住打开的标签、只挂当前标签、靠 `side_chats` 显示其他标签的状态），与抽屉改造协调；会话头按钮与状态；关闭确认、保存、重命名、刷新恢复、主对话归档时只读、10 个上限的提示、Esc 与焦点；中英文案 | L+（约 1.5 周） |
| P6 文档与验收 | 上面列出的文档更新；浏览器冒烟；用真实 provider 的手工验收（需要用户的凭据） | S |

和用户决定之前相比，取消自动清理省下一点工作，但多个标签、跟着主对话归档与恢复、恢复后的冷启动加回了更多：P3 从 M–L 调到 L，P5 从 L 调到 L+，P4 仍是 M，只是多了替主对话恢复工作区。

P2、P3 可以并行。P4 依赖 P2 和 P3 的派发字段。P5 依赖 P3 的接口，以及抽屉改造合入之后的面板结构。

## 测试计划

- **Store（SQLite 与 PostgreSQL 都跑）。** 创建条件与各个 409、`client_id` 幂等、多个侧边聊天与第 11 个返回 `side_chat_limit`（并发创建也不超）、所有列表和计数都排除它、保存幂等且状态不变、`fork_point_seq` 只写一次。
- **跟着主对话的归档与恢复。** 四条归档入口都会连带，恢复和写消息重开都会连带恢复；不能单独改状态，主对话归档期间写入返回 `parent_archived`；侧边聊天的活动让主对话不被自动归档；删除主对话时删除未保存的、保留已保存的并把 `parent_session_id` 置空；没有任何按时间删除侧边聊天的路径。
- **路由。** 只有创建人能用，任务凭据返回 403；侧边聊天的任务凭据读主对话日志只能读到 `fork_point_seq`。
- **冷启动。** 恢复以后新开一代时，派发里带主对话到 `fork_point_seq` 的摘录和自己的日志，预算按继承份额切分。
- **wire 与协议。** 只有带 `side_chat` 的任务和有能力位的连接才派发；`fork` 字段在 `fork_json` 写入后消失；`task.side_fork` 校验；旧 daemon 不会收到侧边聊天的任务。
- **daemon 单元测试。** 客人目录不排锁也不拿租约，同一主对话的几个侧边聊天互不等待；主对话工作区被回收过时先恢复再进入；侧边聊天的会话线不驻留；复制截到完整的行；Codex 引用链递归复制，链里缺一个文件时走退路；主对话会话线在本机活着时用它当前的会话 id。
- **provider 单元测试（用测试桥）。** `forkFrom` 走 `session/fork`；桥不声明 `fork` 时报告不支持、走退路；分叉之后照常设模式和模型。
- **集成测试（显式开启，需要已安装的固定版本 bundle）。** 把本次 spike 改成测试：真实的固定版本桥，加上假的 Responses / Messages 接口，覆盖主对话有轮在跑时分叉、另一个 home 里分叉、新进程续接、主对话不受影响、`AGENTS.md` 边界说明出现在侧边聊天第一次请求里、Codex 引用链。
- **前端。** store 与面板标签；多个侧边聊天标签的新开、切换、关闭（切到相邻标签）、溢出菜单；主对话与当前侧边聊天同屏不串（草稿、问题、停止、已读）；切走的标签草稿保留；只挂当前标签；关闭确认、保存、重命名、刷新恢复、主对话归档时只读、10 个上限。扩展 `bun run smoke:chat`。
- **真实 provider 的手工验收。** 需要用户的凭据，不在本阶段执行。

## 已决定（用户，2026-10-20）

| 编号 | 问题 | 决定 | 落在 |
|---|---|---|---|
| Q1 | 快照什么时候取 | 第一条侧边消息开始执行时（同意建议） | 决策 4 |
| Q2 | 一个主对话能有几个侧边聊天 | 不限于一个，像 Codex 一样多个标签。本 ADR 设一个宽松的资源上限：每个主对话 10 个未保存的 | 决策 2、3、15 |
| Q3 | 多久自动删除 | 不自动删除。侧边聊天一直挂在主对话下，直到用户关闭（即删除，有确认）或保存；只保留跟在用户操作和主对话生命周期后面的清理 | 决策 11 |
| Q4 | 主对话归档时怎么办 | 跟着归档（保留，不删除），主对话恢复时一起恢复；主对话删除时一起删除 | 决策 11 |
| Q5 | 侧边聊天的后台任务 | 每轮结束时停止（同意建议） | 决策 8 |
| Q6 | 浮窗里放不放按钮 | v1 只放 Chat 独立页（同意建议） | 决策 15 |
| Q7 | 同一目录里两边同时改文件的风险 | 接受，与 Codex 相同 | 决策 8 |
| Q8 | 不能原生分叉时 | 用主对话日志的摘录兜底，并在面板上说明（同意建议） | 决策 6 |
