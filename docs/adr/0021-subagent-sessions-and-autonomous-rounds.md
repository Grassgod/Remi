# ADR 0021: 原生子代理会话与自主轮

- 状态：已接受（PR 5 编排决定与用户决定 U1、U3，2026-10-15）。决策 1–9 均已实现。本 ADR 不代表已部署。
- 继承 [ADR 0019](0019-turn-and-item-traces.md)：trace 格式版本不变，不新增条目类型或状态值；子代理仍是 `subagent` 条目，新事实都是可选的加法字段。
- 修订 [ADR 0020](0020-chat-follow-up-queue-and-native-steering.md)“原生引导”的“后台子代理”一条：`session/prompt` 结束后才到的 task-notification 后续轮不再丢失，而是作为自主轮留在同一 attempt 里（决策 5）。
- 编号：main 上最后一份为 0020，本 ADR 取 0021。

## 背景

claude-agent-acp 0.90.0 与 codex-acp 2.2.2 都能把子代理的工作放在子代理自己的 ACP 会话里：桥在发起它的会话上发 `subagent_spawned`、结束时发 `subagent_state_update`，子代理的消息、工具和用量走子会话。在本 ADR 之前 Remi 没有用上：

1. **只收根会话。** provider 丢弃 `sessionId` 不是根会话的每一帧。Codex 不声明原生子会话时根本不转发子代理的工作，只剩 `spawnAgent`、`wait` 和「Start subagent X」几行，`wait` 还被显示成「子代理已完成：wait」；Claude 的子代理帧带 `parentToolUseId` 戳在根会话上，后台子代理的结束从不发信号。
2. **不能只去掉过滤。** 子会话帧会改写根会话的模型与配置选项，以会话失败或压缩失败结束根轮，混进根轮的流式文本（带戳的 Claude 子代理正文今天已经如此），覆盖上下文占用，被当作根工具调用计入引导等待和轮开始。
3. **迟到的回答丢失。** claude-agent-acp 0.89 的探针实测：后台子代理在 10.85 s 结束，早于根会话 14.5 s 的结果，所以桥不保留这一轮；`session/prompt` 在 14.5 s 返回，task-notification 后续轮在 16.5 s 才给出真正的答案。Remi 把「我已在后台启动子代理……完成后回复」当成回复完成 attempt，随后关闭 provider，桥进程随之停止，后续轮被中途杀掉，答案、trace 与计费全部丢失。关闭原生子会话也有同样的竞态。
4. **0.90 的子代理宣布缺事实。** AIR 形式的 `subagent_spawned` 不带子代理类型和模型，也不说是否在后台；Agent 工具调用被桥吞掉。2026-10-15 的实测还表明 0.90 不发孤儿 Agent hook：在根会话写任何东西之前就结束的后台子代理看起来像前台子代理，第 3 条的迟到回答无法判定。

## 决策

1. **两个桥都开原生子会话，一个开关。** client 在 `initialize` 声明 `clientCapabilities.subagents: {}`；Codex 还需要 AIR 能力 `nativeSubagentSessions`（codex-acp 2.2.2 只收到 `subagents: {}` 时不生效），见 [Codex 接入](../design/acp-codex-via-codex-acp.md#原生子代理)。桥回报 `sessionCapabilities.subagents` 或该 AIR 能力时 `nativeSubagentsEnabled` 为真，两个固定版本都回报两者。daemon 默认打开，`REMI_ACP_NATIVE_SUBAGENTS=0` 恢复只收根会话的帧；关闭时翻译器保留此前的规则（按 `parentToolUseId` 归属、异步启动标记、Codex 活动条目）。`packages/remi` 不设这两个 provider 选项，帧与以前相同。
2. **注册表与子会话帧隔离。** 每个 provider 池条目有一张子会话注册表：根会话或已登记子会话上的 `subagent_spawned` 登记新子会话（嵌套子代理在父子代理的会话上宣布），同时把它映射到同一个 chat。只接受根会话和已登记子会话的帧，未知会话的帧丢弃，每个会话 id 记一次日志。子会话帧带 `_meta.remiSessionId`，根会话帧原样不变，已有夹具与读者看到的根帧完全相同。子会话帧不碰根状态：不改模型与配置，不让根轮失败（子会话的 AIR `sessionFailure` 成为该子代理下的嵌套 `notice` 条目 `fail:<id>`），不进流式文本（带 `parentToolUseId` 的 Claude 子代理正文同样不进），不计入根工具调用和轮开始，用量只计费、不计上下文（决策 7）。`subagent_state_update` 标记子会话结束但保留登记，迟到的帧仍能路由。注册表只从实时帧填充：provider 一个 attempt 一个，`session/resume` 不重放，上一个 attempt 的子会话随进程消失；加载或恢复会话前丢弃捕获的自主轮，只留其中的用量帧。
3. **一个原生子代理一个条目。** 条目 id 是 `sa:<原生 id>`（去掉恢复时附加的 `:generation:N`），`parent_id` 是发起它的会话对应的条目，根会话为 null。恢复的一代重新打开同一条目（`item.updated` 回到 `in_progress`），带提示词时再加一条子条目 `user_message`；面板把它画成下一段指令。状态映射为 completed → `completed`、failed → `failed`、cancelled 与 disconnected → `stopped`；`output` 取子代理最后的回复，`duration_ms` 从第一代开始算。`title = name`，飞书等按 `title` 读取的地方不用改；`thread_id` 现在表示原生 agent 或线程 id。Codex 协作工具中除 `spawnAgent` 与活动调用外（`wait`、`sendInput`、`sendMessage`、`followupTask`、`resumeAgent`、`closeAgent`、`interruptAgent`、`listAgents`）都是普通 `tool` 条目；发消息、打断、恢复、关闭、列出由 shared 的 `agentControl` 从工具名和输入推导成控制动作行，`wait` 是隐藏步骤，不出现在 Chat、面板和飞书里，也不计入 `process_item_count`（只影响新轮，不迁移）。执行记录对话框仍显示全部条目。
4. **权限与提问按子会话路由。** 子会话登记时就映射到 chat，所以子代理的 `session/request_permission` 与 `elicitation/create` 由同一个 chat 的处理器接收；`_whileUserInput` 因此也计入子代理的卡片，ADR 0020“有待人回答的请求时不原生引导”对子代理同样成立，`packages/remi` 也不再取消子会话的请求。权限与提问条目保持顶层（飞书按顶层条目等待交互），`tool_item_id` 指向子代理自己的工具条目，拒绝时由它标记。daemon 在 `turn.decision` 的元数据里加可选的 `subagent: {item_id, name}`：先按会话问翻译器，子代理的宣布还没被消费时问 provider 自己的注册表。轮桥把元数据复制进 `human_request.payload`，问题投影把它作为 `QuestionView.source_subagent` 交给 Web（[统一问题](../dev/questions.md)），Chat 的问题行与问题卡显示「来自子代理 X」，飞书卡片前缀「子代理 X 请求：」。
5. **Claude 的迟到回答是同一 attempt 里的自主轮（U1）。**
   - **捕获。** Claude adapter 声明 `autonomousRounds.resultOrigins`：task-notification、peer、coordinator、observer、observer-activity，取自桥的 `AUTONOMOUS_RESULT_ORIGINS`；人的一轮标记为 `human`。开关打开时，prompt 结束后 provider 缓存每一条已接受的帧（根会话与已登记子会话），而不只是用量；上限 2000 帧或 4 MiB，溢出时丢最老的非用量帧并记 warning。下一次 `listenAutonomous` 或 `sendStream` 先按原样重放缓存。Codex 和 `packages/remi` 保留 ADR 0020 只缓存用量的规则：Codex D3 必须丢弃桥自开一轮的文本。
   - **是否欠一轮。** 由翻译器的 `owesAutonomousRound` 判断，只对声明了自主轮的 adapter 成立。原生子会话打开时：某个顶层后台子代理还在运行；或者它在翻译器看到的最后一个自主结果标记之后才结束，而在那之后既没有完成的顶层非子代理工具（工具结果说明下一次模型请求已在根轮里带上了通知），也没有更晚的 prompt 结果。原生子会话关闭时：本 attempt 的后台启动多于首次启动之后看到的自主结果标记。标记取自根会话 `usage_update` 的 `_meta["_claude/origin"].kind`。
   - **等待。** 每个 provider 轮结束、steer pump 空闲之后、取引导之前，只要欠一轮、没有待处理的引导、wrap-up 宽限未过、轮未出错也未取消，daemon 就调用 `provider.listenAutonomous`。监听等第一帧最多 `autonomousIdleMs`（默认 60 s，U1；测试可缩短）；有帧之后等到这一轮的结果标记。10 分钟上限（与 Codex 根会话等子代理的上限相同）从本 attempt 第一次出现自主活动算起，之后的各轮共用；进程退出或取消也结束监听。一个 attempt 最多 8 轮。
   - **占位结果。** Claude Code 2.1.274 起用一次模型调用回答排队的多个通知，其余通知先得到 `num_turns: 0` 的空结果，各自仍发带来源标记的 `usage_update`。所以结果标记只有在上一个计数的标记之后出现过根会话工作（正文、思考或工具调用）才结束监听、才在翻译器里计数；共用的那次后续回答因此能到达、成为回复、只计费一次。按工作而不是按欠下的通知数判断，是因为在 prompt 内已处理的通知会让计数永远等不到标记。
   - **等人回答。** 会话有权限或提问卡片在等时，监听不因第一帧时限、10 分钟预算或 wrap-up 截止而结束（由 daemon 的人工请求超时约束）；人回答所用的时间顺延预算和截止时间，回答后这一轮至少还能再等 min(10 分钟上限, `autonomousIdleMs`)，默认即 60 s。卡片出现和结束都会唤醒监听。60 s 没有一帧说明通知已在根轮内处理，记 `autonomous_wait_empty`，按原回复完成。监听失败只记 warning，轮按已有内容完成。
   - **结果。** 后续轮的消息和工具都是普通顶层条目。按 ADR 0019 的最终回复规则，「我已在后台启动……」成为过程中的说明，后续轮的消息成为最终回复；`worked_ms` 包括等待。监听沿用上一个 prompt 的状态（用量 collector、流式文本、上下文占用），结束后 `getLastResponse()` 覆盖 prompt 与这一轮。飞书的回复卡规则不变：后续轮的消息到达后「我已启动……」作为过程放出，回复卡在 `turn.completed` 时发出。
   - **引导、wrap-up 与取消。** 引导和 wrap-up（它也是引导）结束等待，随后走现有的重新提示路径。已经生效的 wrap-up（宽限计时已开始）通过 `ListenAutonomousOptions.deadline` 约束监听，到期后这一轮像宽限计时到期一样交付已有的回复。后续轮已经开始时，Claude 的 prompt 队列把新 prompt 并入它，后续帧进入同一 attempt 的下一轮；不对后续轮尝试原生注入，它不是用户的一轮。取消由任务信号结束等待，轮照常取消，跟进队列按 ADR 0020 暂停。跟进队列只在轮 completed 后放行，等待只推迟放行。
   - **竞态与代价。** 桥的 SDK 空闲信号（`session_state_changed`）在桥内被消费，Remi 收不到“通知待发”的显式信号，所以上面的判断是推断。推断错的代价是一轮结束时最多多等 60 s，只在后台子代理结束后没有任何根工具结果时出现。仍在运行的后台子代理不需要这一等：桥自己保留这一轮，直到它结束。
   - **开关。** `REMI_ACP_AUTONOMOUS_ROUNDS=0` 同时关闭捕获与等待，恢复此前的完成时机，迟到回答再次丢失；它与 `REMI_ACP_NATIVE_SUBAGENTS` 互相独立。Codex 没有自主轮：根会话自己等子代理，最多 10 分钟。
6. **Claude 桥补丁 `claude-subagents-v1`（U3，取代 U2）。** 补丁改 `dist/acp-agent.js`：在 SDK 的 `task_started` 处按 task id 记下 `is_backgrounded` 与 `subagent_type`，在会话的 `NativeSubagentRuntime` 发布回调处给 `subagent_spawned` 加上 `_meta.remi = { backgrounded, subagentType }`，未知为 null；恢复的一代总是 `backgrounded: true`，因为 SDK 总在后台注册恢复的子代理。
   - **使用。** 翻译器只把 `backgrounded: true` 当作定论，什么都不能把它降级；`false` 仍可由推断升级为 true：前台子代理会阻塞调用方，调用方在它运行时继续说话或调工具，说明它已被移到后台（例如为了接引导，`task_updated` 没有宣布可携带）。补丁缺失或值为 null 时退回推断。类型标签因此恢复。模型取自子代理第一次请求的 `remiTokenUsage.model`，不需要补丁，之后也不改。
   - **安装与发版校验。** 与 `claude-usage-v4` 用同一机制：`patchClaudeUsageBridge` 先打用量补丁再打本补丁，两个锚点（`case "task_started"` 与 `NativeSubagentRuntime` 发布回调）必须各恰好出现一次，否则安装失败。插入段由 `/*remi-subagents:begin*/…/*remi-subagents:end*/` 包围，可以剥离后由后续版本重打，同一版本重复打是幂等的。`bridgeSatisfied` 同时要求用量补丁标记与 `const REMI_SUBAGENT_PATCH = "claude-subagents-v1";`，所以没打本补丁的旧 bundle 视为不满足并重新准备。`release:prepare` 的候选校验（`scripts/verify-runtime-candidate.ts`）调用同一函数，锚点缺失时依赖准备失败，不改发版文件。升级检查见[配套升级说明](../daemon-runtime-upgrades.md#claude-升级检查项)。
7. **用量：上下文与计费分开。** 子会话的 `usage_update` 以 `context: false` 累加：不改 `totalTokens`、上下文快照与窗口大小，也不读上下文占用；计费部分（请求单位、未拆分的总量、金额）照常累加，翻译器也不把子会话用量和模型当作根会话的。Codex 子线程的计费本来就从根会话到达（usage 补丁把子线程的 `rawResponse/completed` 转到根会话，rollout 读取包含子线程），按请求身份去重；子会话上的 `usage_update` 只是子代理自己的上下文，Chat 的上下文环不受它影响。Claude 子代理的用量照旧在根会话上、带 `parentToolUseId`。自主轮的帧带 `remiUsageUnits`，按请求 ID 是新单位；daemon 在每一轮之后以 `turn:<n>:auto:<r>` 结算检查点。Claude 轮范围的 `sdk_estimate` 金额单位与人的那一轮同 ID（监听沿用同一个 collector），后续轮累计的 `total_cost_usd` 恰好替换它一次。规则见[统一用量与价格](../usage-accounting.md#子代理与自主轮)。
8. **trace 与卡片事实。**
   - **条目。** `sa:<id>` 子代理条目（决策 3）；`TraceSubagentItem.background` 来自补丁或推断，Codex 为 null。
   - **完成事实 `late_subagents`。** 最终回复开始后才结束的顶层子代理，至多 5 个 `{item_id, name, status, duration_ms}`。daemon 的 fold 计算，随 `turn.complete` 的完成字段上报；服务端校验后写入 `multiremi_turn_attempts.late_subagents` 并投影到轮卡。可选字段：旧 daemon 不发时写 null，旧服务端只取已知字段、忽略它。Chat 已结束的轮据此在回复下方显示后台完成行，不读 trace（MUL-472）。
   - **运行中计数 `running_subagents`。** 翻译器在子代理状态变化时给出顶层与嵌套计数，daemon 用 best-effort 上行帧 `task.activity { task_id, runtime_id?, running_subagents }` 上报：500 ms 去抖，计数大于 0 时每 30 s 及重连时重发，attempt 结束时报 0。服务端写入 `multiremi_turn_attempts.running_subagents`，值变化时向 Chat 创建者推 `task:subagents`；`GET /api/turns` 的每行带当前尝试的计数，侧栏据此显示「N 个子代理」。用 best-effort 帧是因为计数能从本地状态重算，丢一帧由下次变化或刷新补上，旧服务端按规则忽略未知的 best-effort 帧；复用 `task.progress` 会被服务端按摘要去重，新的可靠事件又需要协议门槛。协议见 [daemon 协议 v2](../daemon-protocol-v2.md)。
   - **存储。** 迁移 `20261017_turn_attempt_subagents` 在两条迁移链上给 `multiremi_turn_attempts` 加两列，加法变更，不迁移旧数据。
9. **子代理只读。** Chat 的子代理面板只读，提示到主对话里调整。两个桥给子会话的 capabilities 都是 `{}`，claude-agent-acp 的 `prompt()` 不认子会话 id，所以不提供给子代理发消息或停止子代理的入口；运行条也没有停止按钮。

## 未采用的方案

- **迟到回答作为 daemon 发起的后续 attempt 或新轮。** 会多一份 trace、一个 attempt、第二张飞书回复卡和两条回复。轮由消息创建，同一 lane 只有一个 pending 轮（ADR 0012、0016）；provider 与桥进程随 attempt 结束，后续轮活不到那时；还需要一种新的协议消息。
- **先完成，再把迟到回答追加到已完成的轮。** 要重新打开已关闭的 trace 与快照，在终态报告之后计费，改已发出的飞书卡片和 Chat 轮卡。已完成的轮不可变。
- **不打桥补丁（U2，已被 U3 取代）。** 0.90 不发孤儿 Agent hook，在根会话说话之前就结束的后台子代理看起来是前台，决策 5 无从判定，迟到回答照样丢失；类型标签也缺失。补丁的代价是升级风险，由安装与 `release:prepare` 的锚点校验兜底：锚点变了就失败，不会带着失效的补丁发版。
- **只去掉只收根会话的过滤。** 子会话帧会污染根轮的状态，见背景第 2 条。
- **为子代理开放消息或停止入口。** 桥不支持（决策 9）。

## 影响

- 两个开关 `REMI_ACP_NATIVE_SUBAGENTS`、`REMI_ACP_AUTONOMOUS_ROUNDS` 默认打开，只读 daemon 进程环境，见 [daemon 环境](../deploy/66-8-remi-environment.md)。关闭原生子会话后 Codex 子代理的工作重新不可见。
- Claude 桥 bundle 必须带 `claude-subagents-v1`：升级到本版本的 daemon 把缺标记的 bundle 视为不满足并重新准备，锚点不匹配时准备失败。
- 判定欠一轮时，一轮最多多等 60 s 才完成。
- 旧 daemon 不发 `late_subagents` 与 `task.activity`：侧栏不显示计数，已结束的轮不显示后台完成行。旧服务端忽略两者。
- 后台 shell 和工作流在 prompt 之后结束同样会开启自主周期；本 ADR 只为子代理等待，它们仍随 provider 关闭丢失，留给会话级后台任务（PR 6）。
- 用户可见的规则在 [Chat 契约](../chat.md#子代理)与[飞书任务呈现](../feishu-native-task-presentation.md)。回归见 [原生子会话](../../tests/unit/acp/native-subagents.test.ts)、[自主轮](../../tests/unit/acp/autonomous-turn.test.ts)、[翻译器](../../tests/unit/daemon/trace-translator-native-subagents.test.ts)、[桥补丁](../../tests/unit/acp/usage-bridge-patches.test.ts)、[daemon 集成](../../tests/integration/multiremi-daemon-subagents.test.ts)与 [`task.activity` 服务端](../../tests/unit/multiremi/task-activity-report.test.ts)；这些是验证入口，不是本 ADR 的执行结果。
