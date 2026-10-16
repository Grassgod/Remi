# ADR 0022: 后台任务按需保活

- 状态：已接受（PR 6 编排决定，用户决定 U1–U3 取推荐值，共享本地文件夹锁由用户于 2026-10-16 决定）。决策 1–13 均已实现。本 ADR 不代表已部署。
- 修订 [ADR 0021](0021-subagent-sessions-and-autonomous-rounds.md) 决策 2 的「provider 一个 attempt 一个」：Chat 会话线的桥进程可以在 attempt 之后继续存活，由下一个 attempt 接手（决策 2、5）。ADR 0021「影响」的最后一条（后台 shell 和工作流随 provider 关闭丢失）由本 ADR 解决。
- 继承 [ADR 0019](0019-turn-and-item-traces.md)：trace 格式版本不变，`background_task` 是新的条目类型，不新增状态值。继承 [ADR 0013](0013-deliverable-is-comment-wakeup-is-doorbell.md) 与 [ADR 0016](0016-unified-message-inbox-and-turn.md)：轮由消息创建，唤醒是门铃（决策 4）。
- 编号：main 上最后一份为 0021，本 ADR 取 0022。

## 背景

claude-agent-acp 0.90.0 与 codex-acp 2.2.2 都能发布 AIR 后台任务：Claude 的后台 Bash（`run_in_background`，或运行中被移到后台的前台 Bash）、工作流和 MCP 后台任务，Codex 的后台终端（unified-exec 里仍在 `thread/backgroundTerminals/list` 中的命令）。客户端在 initialize 的 AIR 能力里列出 `asyncTasks` 后，桥发 `async_task_spawned` / `async_task_progress` / `async_task_state_update`，并接受 `_session/async_task/stop`。在本 ADR 之前：

1. **Remi 不声明 `asyncTasks`。** 两个桥都不发这些帧，Claude 也不发「已转入后台」标记，Chat 看不到后台任务。
2. **一个 attempt 一个 provider。** `runAgent` 在 attempt 结束时关闭 provider：`session/close`，随后对桥的进程组 SIGTERM、SIGKILL。仍在运行的后台命令被无声杀掉。
3. **Claude 会自己醒来。** Claude 的 SDK 消费者在会话整个生命期内都在读流：后台任务在没有 prompt 时结束，SDK 注入 `<task-notification>`，Claude Code 自开一轮（结果来源 `task-notification`）。进程被关掉后，这一轮与它的回复一起丢失（PR 5 R14）。Codex 没有发现自开的轮；终端在 app-server 持有线程时跨轮保留。
4. **池键是 attempt。** daemon 里 `chatId = task.id`，provider 池按它取条目，下一个 attempt 找不到上一个进程；`_ensureSession` 在 cwd、MCP、插件、启动模型或 `CODEX_HOME` 变化时丢弃池里的会话，空闲 10 分钟的会话被池清理关闭。

用户的方向是只在后台任务运行时保活：轮在回复时照常结束，进程只在需要时留下。

## 决策

1. **声明能力，一个开关。** daemon 默认向两个桥声明 AIR `asyncTasks`（`REMI_ACP_ASYNC_TASKS=0` 关闭，此时什么都不保活）。adapter 声明 `asyncTasks: { wakesModel }`：Claude 为 `true`，Codex 为 `false`。provider 每个池条目有一张任务登记表，从每一帧更新（prompt 中、监听中和空闲时都算），空闲时即使不捕获也保留 `async_task_*` 帧；provider 提供 `stopAsyncTask`（根会话 id，10 s 超时）、`settleAsyncTasks`、`reuseCheck`、`adoptSession`、`park` 与 `processGroupId`。Claude 的 Monitor 工具（只把输出流给模型）与子代理（走 ADR 0021 的原生子会话）不作为后台任务发布。`packages/remi` 不开这个选项。桥侧事实见 [Claude 接入](../design/acp-claude-via-claude-agent-acp.md#后台任务)与 [Codex 接入](../design/acp-codex-via-codex-acp.md#后台任务)。
2. **驻留（park）。** attempt 结束时，下列条件都成立才保留进程，否则按今天的路径先停止仍在运行的任务（并行，至多 3 s，trace 记 `stop_reason: turn_end`）再关闭：
   - 能力开关打开，且这条连接双方都持有 `lane.background`（决策 9）；
   - 这是 Chat 会话线：任务有 `chatSessionId`、没有 Issue（决策 12）；
   - 结束时的排空之后 provider 登记表里仍有运行或暂停的任务（Codex 的终端在 prompt 之后才宣布，排空最多等 2 s）；
   - 进程还活着，会话线没有被服务端要求释放，daemon 没有在停止或排空；
   - 驻留登记表有空位，或能淘汰一条（决策 6）。

   驻留时 attempt 的资源交给驻留记录（私有临时目录、执行追踪的保留、工作目录及其锁、已物化的插件），trace 中仍在运行的任务以 `completed` 加 `handed_off: true` 关闭，provider 进入驻留模式（暂停池的空闲清理，捕获所有帧），发 `state: "parked"` 快照，`parked_until = 现在 + 保活上限`。驻留进程不占并发槽位。取消一轮（输入框的停止）只结束这一轮回复，任务照常交出或停止，不会顺带杀掉开发服务器；要结束它们用「全部停止」。
3. **每个会话一张登记表。** daemon 的 [ParkedLanes](../../packages/server/src/worker/parked-lanes.ts) 按会话线 `(会话, Agent, 执行范围)` 记录进程：`in_attempt`（attempt 在用）、`parked`（两轮之间）、`claimed`（下一个 attempt 准备中）、`closed`。它向服务端发 best-effort 快照 `lane.background_tasks`（变化后防抖 1 s，有任务运行时每 30 s 重报，重连时重报，`closed` 隔 10 s 重报 3 次，`revision` 单调）。服务端把快照写进会话级登记表 `multiremi_background_tasks`，这是后台任务视图、运行条和侧栏的唯一来源；trace 只记自己这个 attempt 的部分，空闲页面从不读 trace（MUL-472）。`hello` 带 `parked_lanes`，服务端把该 runtime 其他尚未结束的行写成 `stopped` / `daemon_restart`；runtime 离线超过 10 分钟，运行中的行变为 `unknown`。表结构、授权、保留与接口见 [daemon 协议](../daemon-protocol-v2.md)的「后台任务」。
4. **门铃。** 驻留的 Claude 任务自己完成或失败时，Claude 会醒来，所以 daemon 调 RPC `lane.background_wake`（停止从不响铃，桥对停止不注入任何东西）。服务端在一个事务里、按写消息的取锁顺序校验会话线谱系，以平台身份给该 Agent 写一条 `status` 消息（`wake_requested: "now"`，正文「后台任务已结束：{名称}（已完成，用时 …）」，`metadata.background_task`，去重键 `bg:{agent}:{scope}:{task}`），交给普通的会话线状态机：新建 pending 轮（`created`）、并入未派发的 pending 轮（`merged`）或作为引导送达运行中的轮（`delivered`）。会话线已迁走或会话已关闭时答 `lane_moved` / `session_closed`，daemon 取消这一轮自开周期并释放会话线（`session_closed`），这段周期的用量随之丢失（R4）。来源 attempt 在飞书有回复卡时，新建的轮在同一事务里复制一张主动卡片到原话题；门铃消息本身不外发。

   offer 回到同一台 daemon（会话线固定在 runtime 上），接手驻留进程后进入 attach 模式：门铃消息按原生送达确认、不再提示，`listenAutonomous` 先重放驻留时捕获的周期并等它的结果标记；轮输入里还有别的消息时随后照常提示；周期在 `autonomousIdleMs` 内没来或进程已死时，把门铃正文当普通 prompt，所以这一轮总有回复。用门铃而不是「没有消息的轮」，是为了沿用轮由消息创建、合并、引导、跟进队列、补铃和归档检查，日志里也看得出 Agent 为什么开口。
5. **一个会话一个进程。** 每个 `(runtime, provider 会话)` 至多一个桥进程。offer 在准备之前先认领（`claim`）会话线的驻留进程；adapter 的 `reuseCheck`（`_ensureSession` 的过期规则，无副作用）通过、provider 会话相同、启动指纹相同（可执行文件、参数、MCP、路由与 profile 环境、允许的工具和系统提示词，不含每个 attempt 自己的 token 与轮 id）时接手（`adoptSession` 把池条目、子会话映射、权限处理器和死亡监听改挂到新 attempt）。否则先释放：停止它的任务（冷重试为 `lane_reset`，配置变化为 `config_changed`，进程已死为 `lost`），关闭并等进程退出，再按今天的路径启动；同一个 Claude 会话从不同时在两个进程里恢复。只改模型或推理强度不算过期，直接作用在活的会话上。接手的 attempt 沿用驻留进程的私有临时目录、工作目录（及其锁）与插件，不自己再建。
6. **上限。** 每台 daemon 至多 4 条驻留会话线（`REMI_MAX_PARKED_LANES`，0 关闭驻留），满时淘汰 `lastActivityAt` 最早、且门铃未发出的一条（`evicted`）；都在等门铃时新的会话线不驻留（`no_capacity`）。保活上限（U1）默认 2 小时（`REMI_BACKGROUND_KEEPALIVE_MS`，低于 1 s 的值不生效），从会话线最近一个 attempt 结束算起，每轮重置；到时停止全部任务（`keepalive_cap`），最多等 3 s 后关闭。没有任务运行、门铃也没发出时，最后一个任务结束 60 s 后关闭（`done`）。驻留时桥发起的权限或提问请求最多等 60 s 让 attempt 接上，否则取消。
7. **崩溃清扫与有计划的停止。** 桥在自己的进程组里，可能比 daemon 活得久。每个驻留进程组与它的启动时间写在 daemon 状态目录的 `parked-bridges-<provider>-<身份>.json`；daemon 启动、领取任何任务之前，杀掉其中启动时间仍然吻合的进程组，然后清空文件。daemon 停止或重启（包括 CLI 更新引起的重启）与平台排空时，驻留会话线不计为活跃任务、不阻挡更新；退出前停止它们的全部任务（至多 3 s）、发 `closed` 快照再关闭，原因 `daemon_restart`；排空期间不再驻留新的会话线。
8. **任务上下文文件。** 驻留进程保留的是它启动时的环境，其中 attempt 的 `MULTIREMI_TOKEN` 在那个 attempt 完成时被吊销。可驻留的 Chat 会话线因此另得 `MULTIREMI_TASK_CONTEXT_FILE`：会话线私有临时目录里的一个稳定路径（0600，目录 0700），daemon 在每个 attempt 开始用这个进程时（接手与 attach 也算）原子改写为当前的 token、轮与 attempt，驻留时写成 `token: null`。`remi` CLI 与 git 凭据代理优先读这个文件，文件不可读时退回环境变量；文件说没有 token 时报「后台任务所在的轮已结束，暂无有效凭据」，不使用已吊销的旧 token。Issue 会话线不驻留，不设这个变量。
9. **停止与释放走 DB 推导的下行，受能力位约束。** 浏览器 ■、「停止」与「全部停止」调用 `POST /api/chat/sessions/:id/background-tasks/stop`（只有 Chat 创建者，没有运行中的任务 409 `task_not_running`，电脑离线 409 `runtime_offline`，成功 202），在登记表上记停止请求；下行 `lane.background_stop` 由登记表推导，`hello` 时重推。冷重试、换 runtime、Chat 归档或删除、Agent 归档时，服务端从存活行推导 `lane.background_release`（`lane_reset` / `session_closed`）；配置变化留给 daemon 在下一次 offer 时判定（`config_changed`）。daemon 在 `hello.caps` 声明 `lane.background`，服务端在 `welcome.caps` 回显（旧服务端恒答 `[]`）；双方都持有时才驻留，否则在 attempt 结束时停止任务，所以新 daemon 不会向旧服务端发门铃。服务端只对声明了能力位的连接推导这两种下行。协议版本不变。
10. **共享本地文件夹的锁。** 默认的 Chat 工作目录归 daemon 所有、彼此隔离，没有锁。几个 Chat 指向同一个本地文件夹（Project 的 `local_directory` 或 Runtime 工作区）时共用该文件夹的 FIFO 锁，驻留的会话线**保留**这把锁直到保活上限，因为驻留的 Claude 会在任务结束时自己醒来并可能改文件。会话线自己的下一个 attempt 在这把锁下运行，不排队等自己（[`lockedFolderOf`](../../packages/daemon/src/agent-runtime/workspace/ephemeral.ts)）。另一个 Chat 的轮等待，等待原因写成 `local_directory <路径> (held by background tasks of chat <会话 id>)`：attempt 的原因是自由文本，这段注记是其中结构化的部分（shared 的 `backgroundFolderHolderNote` / `readBackgroundFolderHolder`）；持有者仍在一轮里时原因仍是它的任务 id。持有者驻留时，排在它后面的等待者会被再通知一次，服务端接受等待中 attempt 的新原因（相同原因不写库、不推事件）。轮列表给出 `local_directory_wait_reason`，Chat 的状态条显示「本地文件夹正被另一个对话的后台任务占用」，持有的对话在读者自己的会话列表里时附「打开「{标题}」的后台任务」，直达那里的「全部停止」；不在时（例如另一位成员的对话）只显示这句文案，不带 id 和链接。原始原因（路径、id）从不显示；给人读的进度摘要（Issue 行等）里这段注记写成 `held by another chat's background tasks`，不带会话 id。
11. **Codex 驻留，但没有门铃（U2）。** Codex 跨轮保留后台终端是它的工作方式：驻留让下一轮复用同一个 app-server，模型还能读取、轮询它启动的开发服务器（`write_stdin`）。Codex 不自开一轮，所以从不响门铃；驻留时终端结束若被桥报告，登记表随之更新，否则显示运行中直到下一轮的列表同步或上限。Codex 没有输出文件，驻留时没有输出末尾。
12. **Issue 会话线从不驻留。** Issue 的轮是委派出去的工作，持有工作区生命周期锁、在持有者之间共享工作区，通常无人在看。它们在 attempt 结束时停止后台任务（`turn_end`），启动行据实说明。以后的 ADR 可以把驻留扩展到 Issue。
13. **用量与界面。** 自开周期的请求在接手它的 attempt 里计费：驻留时捕获的帧保留 `remiUsageUnits`，缓冲溢出时用量帧最后丢；接手的 provider 开始新的 prompt 状态，Claude 轮范围的 `sdk_estimate`（SDK 累计的 `total_cost_usd`）以驻留 prompt 最后的累计值为基线，只记差值，请求单位仍是权威，见[统一用量与价格](../usage-accounting.md#后台任务与自开的轮)。界面见 [Chat 契约](../chat.md#后台任务)（右侧面板的「子代理 | 后台任务」、没有运行中的轮也显示的运行条与侧栏计数、停止，U3：单个停止不确认，「全部停止」2 个及以上才确认）与[飞书任务呈现](../feishu-native-task-presentation.md)。

## 未采用的方案

- **在轮内等待，最多 10 分钟。** 回复之后同一 attempt 继续监听，任务结束的通知周期留在同一轮里，到上限或 attempt 结束时停止剩下的任务；不需要驻留子系统、接手、门铃、会话级表和对账，也不修订「一个 attempt 一个 provider」。代价是轮在回复后最多 10 分钟仍显示运行，占着会话线（排队的消息要等）、并发槽位和 Issue 工作区，飞书回复卡也要等；开发服务器最迟在回复 10 分钟后被杀（Codex 总在轮结束时），「启动服务器，然后继续聊」做不到，超过上限的测试照样丢失后续回复。它保留为驻留不可用时（旧端、Issue 会话线、驻留关闭）的回退：任务在 attempt 结束时停止。
- **进程常驻。** 每个 Chat 会话一直保留桥进程，不论有没有后台任务。内存与进程数随会话数增长，空闲进程也占着工作区和凭据；按需保活只在任务运行时付出这个代价，并由 4 条上限与「全部停止」约束。
- **驻留时释放文件夹锁。** 让别的 Chat 立即进入同一个文件夹。驻留的 Claude 会在任务结束时自己醒来写文件，两条会话线会同时改同一个工作树；开发服务器也会在另一轮的准备期间看到文件变化。等待者改为看到是谁占着、去哪里停止（决策 10）。
- **没有消息的自开轮。** 由 daemon 直接建轮。违背「轮由消息创建」，要另造合并、引导与归档检查，日志里看不出 Agent 为什么开口，进程不在时也没有可提示的内容（决策 4）。
- **在输入框旁放后台任务指示。** 那里是跟进队列和人工请求，Codex 自己的输入框条默认关闭；后台任务放在右侧面板、运行条和侧栏。

## 影响

- 三个开关 `REMI_ACP_ASYNC_TASKS`、`REMI_MAX_PARKED_LANES`、`REMI_BACKGROUND_KEEPALIVE_MS` 只读 daemon 进程环境，见 [daemon 环境](../deploy/66-8-remi-environment.md)。
- 每条驻留的 Claude 会话线保留桥（Node）、Claude Code CLI 进程树和任务进程本身，Codex 保留 codex-acp 与 app-server；估计每条几百 MB，未实测，4 条上限约束总量。
- Chat 可能在没有人发消息时回复（门铃轮），飞书里发在启动任务的那一轮的话题下；只有 Claude 的完成与失败会响铃。
- 混合版本：两端都持有 `lane.background` 才驻留；旧 daemon 不产生登记行，旧服务端忽略快照帧，任务在 attempt 结束时停止。
- 只有 CLI 更新（会重启 daemon）、停止与平台排空停止驻留任务；`acp` / `agent` 范围的更新不重启 daemon，不动驻留进程，见[配套升级说明](../daemon-runtime-upgrades.md#后台任务与驻留进程)。
- 协议、登记表与接口见 [daemon 协议](../daemon-protocol-v2.md)的「后台任务」，门铃的事务见 [Inbox 存储](../dev/inbox-store.md#后台任务门铃)。回归见 [驻留登记表](../../tests/unit/daemon/parked-lanes.test.ts)、[翻译器](../../tests/unit/daemon/trace-translator-background-tasks.test.ts)、[provider](../../tests/unit/acp/async-tasks.test.ts)、[daemon 集成](../../tests/integration/multiremi-daemon-background-tasks.test.ts)、[服务端登记表](../../tests/unit/multiremi/background-tasks-registry.test.ts)、[门铃](../../tests/unit/multiremi/lane-background-wake.test.ts)与[停止接口](../../tests/unit/multiremi/background-task-stop-route.test.ts)；这些是验证入口，不是本 ADR 的执行结果。
