# ADR 0025：Chat 输入框的「/」菜单——agent 自己的命令和技能

- 状态：已接受（Q1–Q8 由评审人按建议决定（2026-10-20），用户可推翻，见文末「已决定」）。PR1「命令轮安全」已实现（决策 7、8、9 和契约类型的修正）；PR2「列表带回与保存」已实现（决策 2、3、4 和 Claude 重复回复的去重）；PR3「网页菜单」已实现（决策 1、5、6）。本 ADR 不代表功能已部署，也不代表 daemon 已升级。
- 依赖 [ADR 0023](0023-turn-input-and-provider-agents-md.md) 决策 4：私有 Chat 一对一时，本轮输入就是用户输入的原文，所以开头的 `/命令` 能原样到达桥。修订 ADR 0023 决策 5 的一处：Remi 写入的 `SKILL.md` 里 `name` 改用目录名（决策 7）。
- 依赖 [ADR 0020](0020-chat-follow-up-queue-and-native-steering.md)：运行中发出的命令一律排队，不插话（决策 6）；排队每轮只放行一条，命令通常自成一轮。
- 编号：main 上最后一份为 0024（2026-10-20 核对 `origin/main` 85383dd0e）。

## 背景

用户在 2026-10-20 定下了范围：

1. 在 Chat 输入框打「/」，菜单列出两类条目：**agent 自己的命令**，即 provider 本身支持、由 ACP 桥发布的命令（Claude Code 的内置命令、用户和项目的自定义命令、Claude Code 的技能，Codex 的内置命令和技能）；以及 **Remi 平台上给这个 agent 配置的技能**（现有功能，保留）。
2. 选中一项后发出去，由 agent 执行。
3. 不在范围内：平台操作（新对话、改名、归档、换模型等）和提示词模板。

现状（代码核对）：

- **菜单只有平台技能，而且可能是别的 agent 的。** [slash-command-suggestion.tsx](../../frontend/packages/views/editor/extensions/slash-command-suggestion.tsx) 的 `buildItems` 只列 `activeAgent.skills`，`activeAgent` 取自 `useChatStore` 的 `selectedAgentId`。这个值是「上次选的 agent」，打开已有对话时并不总会同步：`?session=` 链接（[chat-page.tsx](../../frontend/packages/views/chat/components/chat-page.tsx) 第 24 行）和 `setActiveSession`（[store.ts](../../frontend/packages/core/chat/store.ts) 369–386 行）都不改它；而会话窗口自己优先用会话的 agent（[chat-window.tsx](../../frontend/packages/views/chat/components/chat-window.tsx) 401–405 行）。没有配置技能时菜单为空。
- **选中技能插入的是链接，不是命令。** 节点序列化为 `[/名字](slash://skill/<技能 id>)`（[slash-command-extension.ts](../../frontend/packages/views/editor/extensions/slash-command-extension.ts) 59–64 行）。服务端和 daemon 都不改写它，agent 收到的就是这段 Markdown 链接文字；开头是 `[`，桥不会把它当命令。
- **PR2 之前，桥发布的命令到不了服务端（决策 2–4 修正）。** 两个桥都发 `available_commands_update`。provider 在两次 prompt 之间只保留用量帧（[provider.ts](../../packages/acp/src/provider.ts) `_handleIdleUpdate`，2079–2122 行），而桥恰好在 `session/new`、`session/load` 刚应答时发这一帧；prompt 期间到达的那一帧又被 trace 翻译器忽略（[trace-translator.ts](../../packages/server/src/worker/trace-translator.ts) 1594–1596 行）。契约类型的字段名也写错了：[acp-protocol.ts](../../packages/contracts/src/acp-protocol.ts) 633–636 行写成 `commands`，ACP 和两个桥用的都是 `availableCommands`，条目还有 `input.hint` 和 `_meta`。
- **PR1 之前，手动打 `/compact` 会让这一轮失败。** 私有 Chat 里桥会执行压缩，但压缩轮没有回复文字，daemon 看到「有压缩、没文字」就把这一轮判为 `agent_error.empty_or_unparseable_output`（当时的 `daemon.ts` 5335–5345 行；决策 9 修正）。
- **PR1 之前，手动打 Codex 的 `/logout` 会真的登出（决策 8 修正）。** codex-acp 收到后调用 app-server 的 `account/logout`，而会话 home 的 `auth.json` 是指向运行机器主人凭据的软链接（[codex-home.ts](../../packages/daemon/src/agent-runtime/agent-plugins/codex-home.ts) 133–135 行）。

## 可行性验证

### 方法

- 版本与发版固定的一致：claude-agent-acp 0.93.0（Claude Agent SDK 0.3.303，Claude Code 2.1.303）；codex-acp 2.2.2（codex 0.163.0）（[runtime-versions.json](../../packages/acp/src/runtime-versions.json)）。读的是本机 `~/.remi/acp/bundles` 下 daemon 实际使用的 bundle（含 Remi 的用量补丁），只读，没有修改。
- 静态读两个桥的源码；结论都给出 `dist/` 文件和行号。Antigravity 1.4.0 是闭源二进制，只用仓库里已有的录制帧（[antigravity-140-turn-notifications.json](../../tests/fixtures/acp/antigravity-140-turn-notifications.json) 第一帧）。
- 没有用任何真实凭据。桥进程都在一次性的 `HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`TMPDIR` 下运行，环境变量只给最小的 `PATH`；模型请求发到 127.0.0.1 上的假接口（假 Anthropic Messages 接口加假 key；假 OpenAI Responses 接口作为 Codex 的自定义 provider，`env_key` 填假值），Claude 另设 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。假接口存下每个请求体，所以能直接看到命令是否被展开。没有试 `/remote-control` 和 `/logout`。
- 用一个最小的 ACP 客户端按 Remi 的方式驱动桥：`initialize` 时带 Remi 的客户端能力（`jetbrains.air`、`session.compaction`、`session.notices` 等，见 [client.ts](../../packages/acp/src/client.ts) 599–650 行），然后 `session/new` 和一串 `session/prompt`。一次性目录里放了项目技能、带 `argument-hint` 的项目自定义命令、`CLAUDE_CONFIG_DIR/skills` 下的用户技能、`CODEX_HOME/skills` 下的技能，和一个 `name` 里带空格的技能。
- 脚本和日志放在一次性目录，没有提交，验证后已删除。Codex 的 app-server 在一次性 `CODEX_HOME` 里后台拉取了 `openai/plugins` 仓库（精选插件同步），这个进程在验证后已停止。

### 结果

| 编号 | 问题 | Claude（claude-agent-acp 0.93.0） | Codex（codex-acp 2.2.2） |
|---|---|---|---|
| R1 | 发布什么 | `query.supportedCommands()` 的全部条目，字段 `{name, description, input: {hint} \| null}`（`dist/acp-agent.js` 9718–9747 行）。实测 `session/new` 后 48 条：内置命令（`compact context init model config effort fast usage rename goal mcp remote-control …`）、随 Claude Code 附带的技能（`code-review simplify verify batch loop …`）、项目和用户的自定义命令与技能。用户和项目来源的说明后缀「(user)」「(project)」。Remi 在 `initialize` 里声明了 `jetbrains.air`（[client.ts](../../packages/acp/src/client.ts) 620–623 行），所以桥找到 `SKILL.md` 时会加 `_meta.jetbrains.air = {kind: "skill", skillPath}`；它只在工作目录和 `$HOME` 下的 `.claude/skills`、`.agents/skills` 里找，不看 `CLAUDE_CONFIG_DIR`（`dist/tool-calls/reporters/interaction.js` 188–222 行）。 | 11 条固定的内置命令（`plan mcp skills status review review-branch review-commit compact goal rename logout`，`dist/index.js` 38790–38862 行）加 app-server `skills/list` 的每个技能，技能名写成 `$名字`，带 `_meta…skillPath`（38765–38785 行）。实测还有 Codex 自带的 5 个系统技能。没有自定义提示词（`prompts/`），也没有 MCP 提示词。 |
| R2 | 桥自己过滤了什么 | `clear cost keybindings-help login logout output-style:new release-notes todos`（9697–9706 行），以及 CLI 在 `system/init` 里标为终端专用的命令。后者第一次 prompt 时才知道，桥随即重发一次（4148–4163 行）：实测 48 条变成 44 条，去掉了 `color doctor focus reload-plugins`。 | 不过滤，只按名字去重（38773 行）。 |
| R3 | 什么时候发 | `session/new`、`session/load`、`session/resume`、fork 应答后立刻发（`afterSetupResponse`，7915–7921 行）；第一次 prompt 里按终端命令重发；CLI 报 `commands_changed` 时重发（4431–4446 行）。 | `session/new`、`session/resume`（不等待）和 `session/load`（等待）时发；每个普通轮结束后列表有变化才重发（据源码：45241–45245 行调用，38744–38747 行比较）。 |
| R4 | 开头是 `/名字 参数` | 桥原样交给 Claude Code。实测：自定义命令 `/fix-issue 123` 展开成命令正文，参数填进 `$ARGUMENTS`；技能 `/deploy-prod api-server` 载入 `SKILL.md`；`/context` 不调模型，直接回一段 Markdown；`/model claude-haiku-4-5` 回「Set model to Haiku 4.5 for this session only」，之后的请求都改用 haiku；`/config theme=dark` 写进会话 home 的 `settings.json`；`/clear` 之后的请求不再带之前的对话；未知的 `/nonexistent-cmd foo` 当普通文字发给模型。 | 只看第一个内容块，`trim()` 后以 `/` 开头才算，名字转小写（38864–38877 行）。内置命令由桥执行（`compact` 调 `thread/compact/start`，`review` 调 `review/start`，`logout` 调 `account/logout`，`status` 回复账号信息），处理完直接结束这一轮（45015–45049 行）；`$` 开头和未知名字原样发给模型。插话（`turn/steer`）不解析命令。 |
| R5 | 技能怎么调用 | `/名字`。实测名字是 `SKILL.md` 里的 `name`，不是目录名：`name: "Git Commit"` 发布成 `Git Commit`，而 `/Git Commit` 不会被识别成命令。 | `$名字`。实测 `$deploy-prod api-server` 和 `/$deploy-prod api-server` 都会让 Codex 把 `<skill><name>…</name><path>…</path>正文</skill>` 放进请求。 |
| R6 | 命令不在开头 | 实测 `[Alice] /fix-issue 456`、`  /fix-issue 5`（前面有空格）都不执行；但 Claude Code 会附一句提醒：消息里提到了技能名，用户要运行时请调用 Skill 工具。所以技能多半仍会被用上，内置命令不会。`/compact\n\n其他文字` 仍执行，第二段成为压缩的附加说明；附件行同样会成为命令参数。 | 实测 `[Alice] /compact` 当普通文字发给模型。`$技能` 写在文字中间也会被识别。 |
| R7 | `/compact` 的输出 | 实测只有 `compaction_update`（进行中、完成），没有任何回复文字。 | 实测同样只有 `compaction_update`，没有回复文字。 |
| R8 | 其他 | `/context` 实测发出两条内容相同、`messageId` 不同的回复。 | — |

Antigravity 1.4.0 的录制帧里，会话开始就发 `available_commands_update`，只有 `plan`、`logout`、`usage` 三条，没有技能。它怎么处理以 `/` 开头的文字，没有验证。

### 结论

- 两个桥都能把命令执行起来，前提是命令在第一段文字的最开头。Remi 私有 Chat 一对一时满足这一点（[turn-input.ts](../../packages/daemon/src/agent-runtime/prompts/turn-input.ts) 94–105 行不加标签，241 行各段用空行连接）；`AcpClient.prompt` 把这段文字作为第一个内容块（[client.ts](../../packages/acp/src/client.ts) 669–679 行）。
- 平台技能已经同步到 provider 自己的技能目录（ADR 0023 决策 5），所以原生命令列表里本来就有它们（Claude 写作 `名字`，Codex 写作 `$名字`），两类条目会重叠。
- 要补的是：把命令列表带回服务端；`/compact` 这类没有文字回复的命令不能被判失败；挡住少数在托管环境里有害的命令；平台技能名要能当命令用。
- 没有验证：真实 provider 与真实模型的表现、Claude 的 `/login` `/logout` `/remote-control` 和 Codex 的 `/logout` 实际做了什么、Antigravity 对 `/` 文字的处理、带图片的命令、Windows。

## 决策

### 1. 菜单的两组和条目

菜单分两组，顺序固定：

- **Agent 命令**：这个会话的桥发布的命令，去掉已被识别为平台技能的条目（决策 7）和决策 8 隐藏的条目。Claude Code 自带的技能、项目和用户自己的命令与技能、Codex 的 `$技能` 都在这一组，各带一个来源标记（内置、技能、MCP 等，由名字和 `_meta` 推得，推不出就不标）。
- **技能**：这个 agent 在 Remi 上配置的技能，永远显示，不依赖桥发布。

每个条目分开保存：稳定 id、来源（`native` / `platform`）、真正发送的调用文字（`/compact`、`$deploy-prod`）、显示名、说明、参数提示、`skill_id`（平台技能）。去重按 `skill_id`，不按名字：平台技能叫 `review` 不会吞掉 Codex 的 `/review`。

### 2. 命令列表从哪里来：轮结束时随终态报告带回（已实现）

- **provider 记下最新的一份。** `available_commands_update` 无论在空闲时还是 prompt 中到达，provider 都把它存在会话池条目上（后到的整份替换先到的），并提供读取方法 `availableCommands(chatId)`；子会话（子代理）的列表不算。帧本身照旧不进 trace，trace 翻译器继续把它当作与轮无关的会话状态忽略：这份列表属于 provider 会话，驻留的进程被下一个尝试接着用时它仍在，而 trace 只属于一个尝试。
  - 两个桥都在 `session/new` 应答后马上发列表，这时 Remi 还在设模式和模型，会话还没进池，原来的空闲处理找不到会话就丢掉了。现在正在启动的进程发来的列表先记下，会话进池时归给它。
  - 只保留 `contracts` 的 `ObservedSlashCommand`：名字、说明、参数提示、`kind`（`$` 开头或 AIR `kind: "skill"` 为技能，`mcp:` 开头为 MCP 提示词，其余是来源不明的命令），以及 `skillPath` 所在目录的名字。不留 `_meta`，不留路径。名字里有空白的条目丢掉（桥认不出 `/Git Commit`），同名只留第一个。
- **daemon 在终态报告里带上。** `turn.complete` 和 `task.fail` 增加可选字段 `available_commands`：`{provider, reported_at, commands: [{name, description, hint, kind, skill_id?}]}`。daemon 在这一尝试的每个 prompt 后读一次列表，按 `SLASH_COMMAND_LIMITS` 截好：说明 300 字符，提示 200 字符，至多 200 条，整个字段不超过 32 KiB。agent 从没发过列表时不带这个字段。
  - `skill_id`：这一轮 `syncAgentSkills` 真正装下的 Remi 技能（它现在返回装下的目录），条目的技能目录等于该技能的目录，或名字等于技能的命令名（生成的 `SKILL.md` 是目录名，自带 frontmatter 的是作者写的 `name`）时填上。Codex 只认 `$` 开头的名字，所以内置的 `/review` 不会变成平台技能 `review`。没装上的（同名目录早已存在）不填。
- **为什么是轮结束时。** 菜单是在两轮之间用的；Claude 的终端命令过滤要到这一轮的 `system/init` 之后才生效，轮结束时拿到的正是过滤后的那份。终态报告走可靠通道，可以重放；可选字段有先例（PR 5 的 `late_subagents`，[daemon-protocol.ts](../../packages/contracts/src/daemon-protocol.ts) 483–487 行，服务端在 [report-handlers.ts](../../packages/server/src/api/daemon-protocol/report-handlers.ts) 83–100 行读取，缺失时不报错）。
- **版本不一致。** 新服务端遇到旧 daemon：字段缺失，保留原来存的值。旧服务端遇到新 daemon：只读它认识的字段，多出的字段被忽略。不需要能力位，也不需要新帧。

### 3. 服务端保存：每条会话线一份（已实现）

- `multiremi_session_lanes` 加一列 `available_commands TEXT`（JSON，可空；迁移 `20261020_lane_available_commands`），两条迁移链都做加法迁移。先例是 ADR 0020 加在会话线上的 `queue_paused_at`、`queue_pause_reason`。列里存上报的目录，外加写下它的 `attempt_id`、该尝试的 `created_at` 和 `runtime_id`。
- 终态事务里写：字段缺失或 null 时什么都不写；格式不对就记一行日志（不记内容）并忽略，不影响终态；服务端再按 `SLASH_COMMAND_LIMITS` 截一遍，只留契约里的键；空列表照存，与「从没报过」（null）不同。
- 较早的尝试不覆盖较新尝试写下的目录，按尝试的 `created_at` 比较。没有用 `last_attempt_id`：Chat 会话线的这一列只在部分完成路径上推进，不能代表「最新的尝试」。同一个尝试重放时照常写。会话线的 `updated_at` 不变，它决定扫描顺序，而目录不是会话线的进展。
- 列表跟着会话线走，所以侧边聊天（ADR 0024）有自己的一份。

### 4. 接口（已实现）

- `GET /api/chat/slash-commands?agent_id=<id>[&session_id=<id>]`，返回 contracts 的 `ChatSlashCommandsResponse`：`{state, provider, reported_at, commands}`。带 `session_id` 时与读这个 Chat 相同，只有创建人能读（别人 403），`agent_id` 可省，填了别的 agent 时 400；只带 `agent_id` 时（还没建的新对话）要求是工作区成员且能和这个 agent 聊天（不能时 403）。两个都没有时 400，agent 不存在时 404。
  - `state: "session"`：这个会话自己的会话线上报过；
  - `state: "preview"`：会话还没有上报（新对话，或还没跑完第一轮），用当前用户自己和这个 agent 的另一个对话里最新的列表（看最近 50 个），provider 和 Runtime 都要与 agent 现在的一致；别人的对话从不参与；
  - `state: "none"`：都没有（旧 daemon 从不上报，也落到这里）。
  - `session` 而列表为空，表示桥确实发来了空列表，与 `none`（还没收到）分开显示。
  - 存着的列表与 agent 现在的 provider 不一致时不返回（agent 从 Claude 改成 Codex 后，旧列表作废）。
- 决策 8 的隐藏和拦截在这里过滤（`visibleSlashCommands`），所以改名单只要部署服务端；存储里保留桥发来的全部。
- 网页在 `chat:done` 和 `task:failed` 时让这个查询失效，不需要新的实时事件（PR3，已实现）。
- CLI 对齐：登记为 `cli_exempt`，类别 `pure_ui`（输入框菜单；用 CLI 发消息的人直接在 `message send` 里写命令）。生成脚本同时补上了此前手写在清单里的后台任务两条路由的分类，脚本重新生成的清单与仓库一致。

### 5. 新对话和旧 daemon

- 新对话先显示 `preview`，组标题旁注明「来自最近一次对话」；第一轮结束后换成会话自己的列表。
- `none` 时只显示「技能」组，下面一行灰字「Agent 命令会在第一次回复后出现」。
- 查询失败时同样只显示「技能」组，灰字说明暂时无法加载。不把失败当成空列表。

### 6. 前端（已实现）

- **用这个对话自己的 agent。** `ChatWindow` 已经算出 `activeAgent`（会话的 agent 优先），把它和会话 id 通过一个取值函数传给编辑器（与 `getMentionContextItems` 同样的做法），菜单不再读 `selectedAgentId`。
- **只在消息开头触发。** 桥只认开头的命令，所以「/」只在整条消息的第一个字符处打开菜单，别处的「/」是普通文字。
- **匹配。** 依次是：名字完全相同、名字前缀、名字里的单词开头、名字包含、说明包含；匹配时忽略开头的 `/` 和 `$`。分组顺序不变，组内按匹配强度排。高度有限，可以滚动，不截断列表。
- **键盘。** ↑↓ 移动，Enter 或 Tab 选中，Esc 关闭；输入法组字时不处理（沿用 `isImeComposing`）。只有名字完全相同或前缀匹配时才默认高亮第一项；只靠说明匹配上时不高亮，Enter 保持它原来的作用。Mod+Enter 永远是发送，不被菜单截走；打完整的 `/compact` 直接按 Mod+Enter 就按原文发出。
- **选中只插入，不发送。** 插入一个命令标签和一个空格，光标停在后面等用户补参数。标签序列化为调用文字本身（`/compact`、`$deploy-prod`），不再是 `slash://skill/` 链接。参数提示只在菜单里和标签后面以灰色占位显示，不进正文。草稿重新载入时标签变回普通文字，发送内容不变。
- **运行中发命令一律排队。** 以 `/` 开头的消息在 agent 运行时不插话，按排队发送，按钮文字说明「本轮结束后执行」。Codex 的插话根本不解析命令；Claude 没有验证。
- **被拦截的命令。** 用户手动打出决策 8 拦截的命令时，输入框下方提示「这个命令在 Remi 里不会执行，会作为普通文字发给 agent」，仍允许发送。
- **对话记录。** 用户消息原样存 `/compact 保留测试输出`；显示时开头的命令画成标签，其余照常。实际发给 agent 的文字照 ADR 0023 决策 7 记在「输入 Prompt」里；桥返回的结果照常进 trace：压缩是过程里的压缩步骤，`/context`、`/skills`、`/review` 的输出是普通回复。
- 旧消息里的 `[/名字](slash://skill/<id>)` 照旧显示成标签。

实现说明（PR3）：

- 分组、匹配、默认选中和调用文字是纯函数，在 [slash-menu.ts](../../frontend/packages/core/chat/slash-menu.ts)；查询在 [queries.ts](../../frontend/packages/core/chat/queries.ts) 的 `chatSlashCommandsOptions`，实时失效在 [realtime/sync/chat.ts](../../frontend/packages/core/realtime/sync/chat.ts)。
- `ChatWindow` 算出对话自己的 agent（已有对话只认会话的 agent；会话还没读到时菜单显示读取中，不借用别的 agent），经 [use-slash-command-menu.ts](../../frontend/packages/views/chat/components/use-slash-command-menu.ts) 组成菜单交给输入框。编辑器把它放进一个可订阅的来源（[slash-command-suggestion.tsx](../../frontend/packages/views/editor/extensions/slash-command-suggestion.tsx) 的 `createSlashMenuSource`），已经打开的菜单在列表读到后直接补上，不用再打字。
- 命令列表在这个对话里第一次打开菜单时才读，切换对话不读；读过的在缓存里直接用。
- Chat 的 Enter 本来是换行（Mod+Enter 发送），所以「Enter 保持原来的作用」在 Chat 里就是换行。没有选中项时 Tab 插入第一项。
- 参数提示是标签所在段落末尾的装饰（光标之后），段落里出现别的文字就消失；它不是文档内容，序列化时不存在。平台技能的行显示原名，后面是真正插入的调用文字；「Agent 命令」里桥标为技能或 MCP 提示的条目带一个小标记。
- 对话记录在渲染前把开头的命令改写成 `slash://command/<名字>` 链接，`Markdown` 和 `ReadonlyContent` 都把它画成标签；存的消息不变。路径（`/tmp/x`）和「/ 名字」不算命令。

### 7. 平台技能

- **名字要能当命令（已实现）。** Remi 生成 `SKILL.md` 的 frontmatter 时，`name` 写目录名，不再写平台上的显示名。目录名由 contracts 的 `skillCommandName` 算出，daemon 安装和以后的网页菜单用同一个函数。这样「Git Commit」的调用文字是 `/git-commit`（Claude、Antigravity）或 `$git-commit`（Codex），菜单里仍显示「Git Commit」。
  - ASCII 名字的目录名与以前完全相同，已装的目录不动；下一次同步（每轮都会同步）整份重写 `SKILL.md`，`name` 随之更新。
  - 名字里有非 ASCII 字符（例如中文）时，以前的规则把这些字符全部去掉，所有中文名的技能都落到同一个 `skill` 目录、互相覆盖。现在在后面加上整个名字的 6 位哈希（如 `skill-1a2b3c`、`pr-4d5e6f`），各占一个目录；旧的 `skill` 目录记在清单里，下一次同步时删除。这类技能的显示名放在 `description` 开头（`代码审查 — 原说明`），模型仍能看到原名。
  - 技能正文自带 frontmatter 的仍原样保留，`name` 由作者决定。
  - 没有其他代码依赖 `SKILL.md` 里的 `name`：清单、删除和 Codex 个人技能的禁用都按目录或路径，`local-skills.ts` 只扫描运行机器上用户自己的技能目录，不扫描 Remi 安装的目录。
- **对上原生条目。** daemon 知道它这一轮写了哪些技能、写成了什么名字，所以由它在上报时给对应条目填 `skill_id`；Codex 还可以用 `_meta` 里技能路径的目录名核对。网页按 `skill_id` 合并：对上的条目只在「技能」组出现一次，调用文字用原生条目的。
- **没对上时**（旧 daemon、`state` 不是 `session`、同名目录已存在导致没装上），技能仍显示在「技能」组，按 provider 的写法插入调用文字。

### 8. 隐藏和拦截

名单放在 contracts（`slash-commands.ts`），按 provider 分两类，依据是这个桥在托管环境里实际会执行什么，不照搬桌面版的名单：

- **拦截（已实现）**：菜单里不出现；daemon 发送前若本轮文字以它开头，在前面加一行说明、空一行再接用户的原文，命令因此不在开头，不会被桥识别：
  - 说明的原文是 `[Remi] The user typed the command /<名字>, which Remi does not run here. It reached you as text and did not run.`，模型据此可以解释，而不会装作已经执行。
  - 「开头」按最宽松的桥来认：去掉开头的空白和换行，`/` 之后允许空白（codex-acp 会把 `/ logout` 当成 `logout`），名字不分大小写。
  - `/$名字` 不拦截：两个桥都不把 `$` 开头的名字当命令执行（codex-acp `dist/index.js` 38882 行），它只是技能提及。
  - Claude Code 会把命令的别名当作命令本身执行（SDK `SlashCommand.aliases`），所以被拦截命令在 Claude Code 2.1.303 里的别名一起拦截：`rc`（remote-control）、`settings`（config）、`reset` 和 `new`（clear）、`cost` 和 `stats`（usage）。这些别名取自 CLI 自带的命令注册表。
  - 不认识的 provider 按三家名单的并集处理。
  - 本轮输入和插话文字都经过这一步（插话退回重新提示时，桥会像普通输入一样解析命令）；带发言人标签的文字以 `[` 开头，本来就不会被当成命令。daemon 是所有入口（网页、飞书）的必经之处，所以拦截放在这里。
- **隐藏**：只是菜单里不出现，手动打出来照常发出。名单已在 contracts 里，网页菜单（PR3）使用。

| provider | 命令 | 处理 | 依据 |
|---|---|---|---|
| Claude | `remote-control` `rc` | 拦截 | 由桥执行（`dist/acp-agent.js` 2162–2196 行），把会话接到 claude.ai，用运行机器的账号绕过 Remi 的权限。 |
| Claude | `model` `effort` `fast` | 拦截 | 在 Remi 的模型选择之外换模型；实测 `/model` 之后的请求都改了模型。用户决定换模型不在范围内（Q3）。 |
| Claude | `config` `settings` `output-style` `autocompact` `auto-mode-setup` | 拦截 | 改 Claude Code 设置；实测 `/config` 写进了会话 home 的 `settings.json`，另三个按说明推断，没有逐一实测。 |
| Claude | `clear` `reset` `new` | 拦截 | 桥已不列出，但手动输入仍会执行，实测清空了上下文；Remi 下一轮按原会话 id 续接，结果不确定。重开请用「新对话」。 |
| Claude | `usage` `cost` `stats` | 拦截（Q2） | 桥自己生成用量报告（2088 行起），会显示运行机器账号的用量和额度。 |
| Claude | `login` `logout` | 拦截 | 桥已不列出；手动输入的效果没有验证，可能动到运行机器主人的登录。 |
| Claude | `rename` `goal` `loop` `insights` `mcp` `reload-skills` `agents` `__remote-workflow` `workflow-launch-exec` `update-config` `fewer-permission-prompts` `plugin-authoring` | 隐藏（Q7） | 标题由 Remi 管；`loop` 要常驻的 CLI 会话，Remi 每轮结束进程；`mcp` 的重连会发起远端无法完成的 OAuth；Remi 每轮重新同步技能；`agents` 已移除，后两个只给服务端启动的会话；最后三个改的是 Claude Code 本机设置，在 Remi 里是会话 home；`goal`、`insights` 在 Remi 里的行为没有验证。 |
| Codex | `logout` | 拦截 | 桥调用 `account/logout` 并回复「Logged out from Codex account.」（`dist/index.js` 38949–38955 行），会话 home 的 `auth.json` 是指向运行机器主人凭据的软链接。 |
| Codex | `status` | 拦截（Q2） | 回复里有账号邮箱、套餐和额度（39065–39075 行）。 |
| Codex | `plan` `goal` `rename` `mcp` | 隐藏（Q7） | 在 Remi 之外切协作模式；`goal` 会让桥自己开后续轮（43964–43974 行）；标题由 Remi 管；`mcp reconnect` 重载配置并可能发起 OAuth。 |
| Antigravity | `logout` `usage` | 拦截 | 与另两家一致；Antigravity 的凭据在 daemon 的网关里，这两个命令在 Remi 里没有意义。 |
| Antigravity | `plan` | 隐藏（Q7） | 说明是生成计划并等用户批准，这条流程在 Remi 里没有验证。 |

其余命令都显示，例如 Claude 的 `compact context init security-review recap list-agents`、附带的技能、自定义命令、项目和用户技能、插件命令、MCP 提示词；Codex 的 `review review-branch review-commit compact skills` 和所有 `$技能`。

### 9. 命令轮的完成

已实现。只有下面的条件全部满足，「有压缩、没有回复文字」才算正常完成；其余情况照旧判为 `agent_error.empty_or_unparseable_output`，不掩盖真正的空输出：

- 这一轮发出的第一段文字是 `/compact` 命令（可以带说明），而不是普通文字、带标签的文字或别的命令；
- 这一轮看到了 `compaction_update`；
- 只跑了这一个 prompt：没有插话（原生注入或重新提示都不行），也没有桥自己开的、有动静的自主轮。

满足时回复是固定的 `Context compacted.`，代替「Task completed.」；桥若自己回了文字，就用桥的文字。压缩本身照常作为过程里的压缩步骤显示（Q5）。实际发出的文字（包括拦截时加的那一行）照 ADR 0023 决策 7 记录，与用户看到的消息分开。

### 10. 不做的

- 平台操作、提示词模板（用户决定）。
- 飞书里的命令菜单；Issue 会话。daemon 的拦截对所有入口都生效。
- 用「$」单独打开技能菜单。
- Codex 的自定义提示词：codex-acp 2.2.2 既不发布也不执行它们。

## 失败与边界情况

| 情况 | 行为 |
|---|---|
| 群聊或飞书里消息带发言人标签 | 内置命令不执行，当普通文字发出；Claude 会提醒模型用上提到的技能，Codex 的 `$技能` 在文字中间也生效（R6）。v1 只保证网页私聊里命令可执行（Q8）。 |
| 命令前面还有别的未读消息（例如排队放行时合并进来的未读消息，或 `[Remi]` 门铃） | 命令不在开头，当普通文字发出。 |
| 命令后面跟着附件行、未读提示 | 它们成为命令参数：Claude 的 `/compact` 当作附加说明，技能填进 `$ARGUMENTS`；Codex 的 `/compact` 忽略参数。 |
| 命令带图片 | Claude 桥的 `/usage` `/mcp` `/remote-control` 只在只有一个文字块时由桥处理；Codex 的内置命令丢掉其余内容块。不专门处理。 |
| 开头有空格 | Claude 不认（实测）；网页发送前已去掉首尾空白。 |
| 名字里有空格的技能，正文自带 frontmatter | 保留作者写的 `name`；这种技能在 Claude 里不能用 `/` 调用，只出现在「技能」组，按普通文字插入。 |
| agent 换了 provider 或 Runtime | 旧列表不返回，回到 `preview` 或 `none`。 |
| 平台技能刚加上 | 「技能」组立刻有；原生条目在下一轮结束后对上。 |
| `/context` 回两条相同的回复（R8） | 原因：claude-agent-acp 0.93 对不调模型的命令（`/context`、`/heapdump`、`/extra-usage`）把 `local_command_output` 和这一轮的 result 各发一次，消息 id 不同（`dist/acp-agent.js` 4242–4260、5381–5395）。Remi 的 trace 按消息 id 分条目，所以聊天里不会多一条消息行，但同一段输出会先作为执行步骤里的中间说明、再作为回复各出现一次。PR2 起 provider 在 Claude 的这类命令里丢掉与上一条文字完全相同的第二条消息；别的提示词和 Codex 不受影响。 |
| Codex 里以 `/status`、`/review` 开头的普通句子 | 桥按前缀当成命令（这是桥的行为）；`/status` 会被拦截加注，`/review` 照常执行评审。 |

## 未采用的方案

- **新的尽力而为帧加能力位（像 `lane.background_tasks`）。** 要防抖、重连重报和能力协商；而菜单只在两轮之间用，轮结束时随可靠的终态报告带回就够了，也有可选字段的先例。
- **走 trace（`turn.updated`）。** trace 按尝试保存，两轮之间就没了，网页还要读 trace 才能出菜单。
- **新对话时提前起一个桥拿列表，或复用模型探测。** 多一个进程的代价；模型探测按 Runtime 做，拿不到 agent 的技能和项目里的命令。
- **在网页里猜命令或扫描目录。** 网页看不到运行机器上的目录，猜出来的名字不保证能执行。
- **继续插入 `slash://skill/` 链接，由 daemon 展开成技能正文。** 这绕开了 provider 自己的技能加载，Claude 的 `$ARGUMENTS` 和 Codex 的技能注入都用不上。
- **服务端拒收被拦截的命令。** 飞书等入口绕不过 daemon 但绕得过网页接口；拦截放在 daemon，网页只做提示。
- **照搬桌面版的隐藏名单。** Codex 和 Claude 桌面版的菜单由各自的应用按上下文注册（参考「Codex/Claude 桌面版静态分析」），桌面上有 `/model` 等本地实现，与 ACP 桥的列表不是一回事；名单只按我们的桥实际会执行什么来定。

## 影响

- PR1 改变的行为（新 daemon 上生效）：被拦截的命令不再执行，模型收到说明行；`/compact` 轮不再失败；Remi 安装的技能 `name` 改为目录名，名字含非 ASCII 字符的技能换到带哈希的目录。PR1 不改接口、协议和存储。
- 技能名改为目录名后，模型看到的技能名变成 `git-commit` 这样的形式；已有会话下一轮生效。
- 拦截名单把 `/new`、`/reset` 等普通词也算作命令：一条以 `/new` 开头的消息会带上说明行。以 `/` 开头的普通句子很少，说明行也不改变原文，所以接受。
- PR2：daemon 协议的终态报告多一个可选字段，不改版本、不加能力位（[协议文档](../daemon-protocol-v2.md) 5.4b）；会话线多一列，两条迁移链都做了，一份目录不超过 32 KiB；接口快照和 `cli-capabilities.json` 已更新。新 daemon 配旧服务端、旧 daemon 配新服务端都照常工作，只是没有目录（`none`）。
- [Chat 契约](../chat.md#斜杠命令)、[开发入口](../dev/README.md)、[Agent 配置规范](../agent-config-spec.md)和 ADR 0023 决策 5 已随 PR1、PR2 更新。

## 实施计划

粗略工作量：S 约 1 个 agent 日，M 2–4 天。

| PR | 内容 | 量 |
|---|---|---|
| PR1 命令轮安全（只动 daemon 和 contracts；已实现） | contracts 的 [slash-commands.ts](../../packages/contracts/src/slash-commands.ts)（开头命令解析、按 provider 的拦截与隐藏名单、说明行、技能命令名）；修正 `AvailableCommandsUpdate` 类型；在本轮输入（[ephemeral.ts](../../packages/daemon/src/agent-runtime/prompts/ephemeral.ts)）和插话文字（`buildSteerInput`）上加拦截；`/compact` 轮「有压缩没文字」不算失败、回复用固定句（[daemon.ts](../../packages/server/src/worker/daemon.ts)）；技能 frontmatter 写目录名（[skills/ephemeral.ts](../../packages/daemon/src/agent-runtime/skills/ephemeral.ts)）。可以单独发版，先堵上今天就存在的 `/compact` 失败和 Codex `/logout`。 | S |
| PR2 列表带回与保存（已实现） | provider 记下最新列表（空闲、启动中和 prompt 中都记，[provider.ts](../../packages/acp/src/provider.ts)）；daemon 规整、对上 `skill_id`（`reportedSlashCommands`），写进 `turn.complete` / `task.fail`；服务端读可选字段（[report-handlers.ts](../../packages/server/src/api/daemon-protocol/report-handlers.ts)）、会话线新列（两条迁移链）、较早的尝试不覆盖（[store/slash-commands.ts](../../packages/server/src/store/slash-commands.ts)）；`GET /api/chat/slash-commands`（`session` / `preview` / `none`、按 provider 过滤、按名单过滤，响应类型在 contracts）；Claude 不调模型的命令的重复回复去重；CLI 豁免、接口快照、协议文档。 | M |
| PR3 网页菜单（已实现） | 用对话自己的 agent；两组、匹配顺序、键盘规则；命令标签与参数占位；只在开头触发；运行中排队；被拦截命令的提示；消息里的命令标签；`chat:done` 刷新；中英文文案。 | M |

PR1 不依赖其他两个。PR2 定下接口形状后 PR3 可以并行。

## 测试计划

- **contracts 单元测试（PR1，[slash-commands.test.ts](../../tests/unit/shared/slash-commands.test.ts)）。** 开头命令的解析（`/`、`/ 名字`、`$`、开头空白和换行、大小写、换行后的参数）；三个 provider 的每个被拦截命令及其变体加上说明行后，按最宽松的桥的读法都不再是命令，再加一次不变；允许的命令、隐藏的命令、`/$技能`、文字中间和带标签的命令不受影响；不认识的 provider 用并集；技能命令名对 ASCII 名字与以前的目录名完全一致，非 ASCII 名字带稳定哈希且互不相同。
- **daemon 测试（PR1）。** [turn-input.test.ts](../../tests/unit/daemon/turn-input.test.ts)：私有 Chat 的允许命令原样在开头；三个 provider 的每个被拦截命令在本轮输入和插话里都带说明行，记录的哈希是发出文字的哈希；按 provider 区分（Codex `/status` 拦截、Claude `/status` 不拦截）；带标签的命令不动。[skills-ephemeral.test.ts](../../tests/unit/daemon/skills-ephemeral.test.ts)：`name` 是目录名；非 ASCII 名字各占一个目录、原名进说明；自带 frontmatter 不变；旧版装下的技能在下一次同步时重写，旧的共享 `skill` 目录被删除。[multiremi-daemon-smoke.test.ts](../../tests/integration/multiremi-daemon-smoke.test.ts)（真 daemon，假 provider 记下收到的文字）：`/compact` 轮只压缩时以「Context compacted.」完成；桥自己回了文字时用桥的文字；普通文字、带标签的 `/compact`、`/compactor`、`/context` 只压缩时仍判失败；`/model` 到达 provider 时说明行在前。
- **contracts 单元测试（PR2，同一文件）。** 观察到的条目只留名字、说明、提示、`kind` 和技能目录名，不留路径和 `_meta`；名字带空白、重复、超限的条目处理；`boundSlashCommands` 只留契约的键并装进 32 KiB；`visibleSlashCommands` 按 provider 去掉拦截和隐藏的命令，保留 Codex 的 `$技能`。
- **provider 单元测试（PR2，测试桥，[available-commands.test.ts](../../tests/unit/acp/available-commands.test.ts)）。** `session/new` 应答后、会话进池前到达的列表被记下，路径不留；prompt 中的重发替换它，并在下一个 prompt 里保留；空列表算数；子会话的列表不算；Claude 的 `/context` 重复回复只留一份，其他提示词、内容不同的第二条消息和 Codex 不受影响。
- **daemon 测试（PR2）。** [skills-ephemeral.test.ts](../../tests/unit/daemon/skills-ephemeral.test.ts)：`syncAgentSkills` 返回装下的目录；`reportedSlashCommands` 按名字和技能目录填 `skill_id`，Codex 只认 `$` 名字，没装上的、没有 id 的不填。[multiremi-daemon-smoke.test.ts](../../tests/integration/multiremi-daemon-smoke.test.ts)：真 daemon 把假 provider 的列表随终态报告带到 Chat 的会话线，平台技能带上 `skill_id`；provider 说不知道或没有这个方法时什么都不存，空列表照存。
- **服务端测试（PR2，SQLite 与 PostgreSQL 都跑，[chat-slash-commands.test.ts](../../tests/unit/multiremi/chat-slash-commands.test.ts)）。** 迁移在新库和升级的库上各加一次列；经真服务端的协议层发 `turn.complete` / `task.fail`：带列表时存到会话线、路径和多余的键不留；不带（旧 daemon）和格式错误时不动已存的、终态照常；空列表照存；较早的尝试不覆盖较新的，同一尝试可以重写；接口的 `session` / `preview` / `none`，拦截与隐藏的不列出；`preview` 只取请求者自己的对话，别的成员既拿不到预览、也读不了创建人的会话（403）；agent 换 Runtime 后没有预览、换 provider 后旧列表作废；不能和私有 agent 聊天的成员 403，参数错误 400，agent 不存在 404。
- **网页单元测试（PR3，已实现）。** 另有 [slash-menu.test.ts](../../frontend/packages/core/chat/slash-menu.test.ts)（分组、按 `skill_id` 合并、匹配顺序、默认选中、调用文字、拦截判断）、[use-slash-command-menu.test.tsx](../../frontend/packages/views/chat/components/use-slash-command-menu.test.tsx)（会话的 agent、第一次打开才读、`preview`、失败、换对话、轮结束刷新）、接口解析和实时失效的测试、对话记录里命令标签的测试。扩展 [slash-command-suggestion.test.tsx](../../frontend/packages/views/editor/extensions/slash-command-suggestion.test.tsx)：用的是会话的 agent 而不是 `selectedAgentId`；分组与按 `skill_id` 去重（同名的 Codex `/review` 与平台技能 `review` 不合并）；匹配顺序；弱匹配不抢 Enter，Mod+Enter 照常发送；输入法组字；只在开头触发；插入的标签序列化成调用文字、含下划线也不转义；参数提示不进正文；`preview`、`none`、加载失败三种提示。扩展 [chat-input.test.tsx](../../frontend/packages/views/chat/components/chat-input.test.tsx)：运行中以 `/` 开头的消息按排队发送；被拦截命令的提示。
- **集成测试（显式开启，需要本机已装的固定版本 bundle，不需要凭据；尚未做）。** 把这次验证改成测试：假的 Messages / Responses 接口，覆盖发布的列表与终端过滤、`/自定义命令` 和 `/技能` 展开、Codex `$技能` 注入、`/compact` 只有压缩帧、带标签时不执行。放在 `tests/integration/`，默认跳过。
- **真实 provider 的手工验收。** 需要用户的凭据，不在本阶段执行：`/compact`、`/review`、`/init`、一个平台技能、一个项目自定义命令，各在 Claude 和 Codex 上跑一遍；确认拦截加注后模型的回答合理。

## 已决定（评审人按建议决定（2026-10-20），用户可推翻）

| 编号 | 问题 | 决定 | 落在 |
|---|---|---|---|
| Q1 | 新对话还没跑过时，Agent 命令先用「你上次和这个 agent 对话时的列表」顶上，还是只显示平台技能、等第一次回复后再出现？ | 用当前用户自己和这个 agent 最近一次对话的列表（provider 和 Runtime 一致），标明「来自最近一次对话」 | 决策 4、5 |
| Q2 | 会暴露运行机器主人账号信息的命令（Codex `/status` 显示账号邮箱和套餐，Claude `/usage` 显示用量和额度）默认拦截；要不要在聊天的人就是这台机器的主人时放开？ | v1 对所有人拦截 | 决策 8 |
| Q3 | Claude 的 `/model`、`/effort`、`/fast` 会绕过 Remi 直接换模型（实测会换）。按「换模型不在范围内」拦截它们，可以吗？ | 拦截 | 决策 8 |
| Q4 | agent 正在回复时发 `/命令`，一律排到这一轮结束后执行，不插话，可以吗？ | 一律排队，从不插话 | 决策 6 |
| Q5 | `/compact` 这类没有文字回复的命令，聊天里显示「压缩」过程步骤加一句简短回复，可以吗？还是不要回复气泡？ | 压缩步骤加固定的简短回复（`Context compacted.`） | 决策 9 |
| Q6 | 平台技能名带空格或中文时 agent 认不出来。Remi 写给 agent 的技能名改成目录名（如 `git-commit`），菜单里仍显示原名，可以吗？ | `SKILL.md` 的 `name` 写目录名，菜单显示原名 | 决策 7 |
| Q7 | 一些在 Remi 里没意义或没验证过的命令只在菜单里隐藏，手动打出来照样发给 agent（名单见决策 8）。可以吗？ | 按建议的名单只隐藏 | 决策 8 |
| Q8 | 群聊、飞书里带发言人标签的消息，内置命令不会执行（技能多半仍会被 agent 用上）。v1 只保证网页私聊里命令能执行，可以吗？ | v1 只保证网页一对一私聊 | 失败与边界情况 |
