---
title: Runtime 持久化工作区
status: active
summary: 注册机器上的已有目录，跨 Chat 和 Issue 复用本地上下文、依赖和目录关系。
---

# Runtime 持久化工作区

Runtime Workspace 是某台机器持有的执行环境，独立于 Issue、Chat、Project 和 Git。`workspace_id` 仍表示团队租户；`runtime_workspace_id` 表示执行环境。

## 使用

在 Runtime 详情的「工作目录」页登记已有目录。任务创建（手动或 Agent 模式）和详情使用同一个「工作位置」选择器，将「项目 / 仓库」与「本机工作目录」并列展示；目录项显示所属机器及实际执行路径。每个任务只选择一个位置，选择项目会清空目录绑定，选择目录会清空项目。未指定位置时保留自动安排。

Chat 使用同一选择器，创建时保存 `project_id` 或 `runtime_workspace_id`，两者互斥。显式选择的项目决定项目上下文和设备路由；选本机目录时不附加项目仓库。Chat 与 Issue 独立，不因在聊天中创建 Issue 而继承其执行位置。项目 Chat 的目录选择、自动准备显式仓库及项目不可用时的冷启动遵循 [Chat 契约](../chat.md#项目仓库与工作目录)；显式 Runtime 工作区仍使用注册目录，不自动检出仓库。Issue 尚未产生任务时也可在详情中选择；产生任务后绑定固定。Chat 在创建时确定绑定，换目录需要新建 Chat。子 Issue 也独立选择执行环境，不隐式继承父 Issue 的本地目录。

「选择根目录」通过所属 Runtime 的目录浏览接口打开该机器的用户主目录，可以逐级进入、返回上级、筛选当前文件夹或输入路径跳转。页面使用 daemon 返回的绝对路径，并自动填入目录名称；浏览器在 Windows 上也可以选择 Mac/Linux 的目录。机器离线时不能发起浏览，读取失败不会允许提交上一次的目录结果。

Agent 默认在共享根目录执行，也可通过「选择子目录」指定其内部目录；相对路径自动计算，右侧预览实际执行位置。名称可修改，额外上下文和环境文件收在高级设置中。工作目录无需关联项目。目录浏览只列出已有目录，不创建目录；文件权限和上下文仍在任务启动时再次检查。

例如，根目录设为 `C:\workbench`，工作目录设为 `app`：

```text
C:\workbench\
  AGENTS.md                 共享指令
  .agents\skills\           本地 Skill
  dependencies\             本地依赖
  app\                     agent 的 cwd，可以不是 Git 仓库
    .env.local
    node_modules\
```

父子目录关系保留。工作区可以包含多个仓库，也可以没有 Git；注册和启动不会自动 clone、checkout、切分支或创建 Wiki 副本。

控制面保存名称、绝对根路径、相对 `cwd`、可选 `context_paths` 和 `env_file`。注册记录的旧 `project_id` 元数据仍兼容，但不作为执行位置，也不再出现在登记表单中。Issue 创建时同时指定项目与目录会报 400；更新中单独选择一种会原子清空另一种，同时指定两种也报 400。选目录的子 Issue 不继承父 Issue 的项目，显式 `project_id: null` 也不继承。旧版双重绑定记录在普通标题等更新时保持原值，重新选择位置时才按互斥规则处理；已执行任务的目录绑定不允许变更。路径配置注册后固定，可改名或归档；改变环境需注册新工作区。

```bash
remi runtime workspace list
remi runtime workspace list --runtime <runtime-id>
remi runtime workspace create <runtime-id> --name "Local workbench" --root "C:\workbench" --cwd app --env-file app/.env.local
remi runtime workspace get <runtime-workspace-id>
remi runtime workspace rename <runtime-workspace-id> --name "Research"
remi chat create --agent <agent-id> --runtime-workspace <runtime-workspace-id>
remi chat create --agent <agent-id> --project <project-id>
remi issue create --title "Inspect local state" --runtime-workspace <runtime-workspace-id>
remi issue quick-create --agent <agent-id> --prompt "Plan local work" --runtime-workspace <runtime-workspace-id>
remi runtime workspace archive <runtime-workspace-id>
```

Agent 创建模式把工作目录绑定到 intake Issue / Task，并在生成提示词中要求后续 execution Issue 显式携带 `--runtime-workspace`，不再自动匹配项目。它仍由 agent 创建后续任务，不隐式改变所有子任务的继承规则。

重复的 `--context-path` 指向额外指令文件或 Skill 目录，全部相对于根目录。注册也支持 Registry 的 JSON 文件输入。

## 生命周期

- 工作区归属 `(workspace_id, daemon_id)`。同一 daemon 上的 Claude / Codex Runtime 可使用同一工作区。
- Chat、Issue、Task 保存引用；Task 创建时确定绑定。独立 Task 的基础设施重试和重新调度保留工作区。Issue 中不占用工作区的讨论/侧会话（`holds_workspace=false`）使用独立目录，不继承父 Issue 的本机目录或机器限制；重试和重新调度同样保持隔离。工作区亲和不与设备解耦：Project 设备绑定和独享设备对**所有**任务生效，不管 `holds_workspace` 是多少（MUL-449）。会话亲和（`chat_sessions.session_runtime_id`）在重算时一并检查设备路由，被 Project 拒绝的机器不会被钉死排队。
- 领取要求 Runtime 声明 `runtime_workspaces: 1`、匹配 daemon，并通过已有 provider、Agent、插件和 Project 设备路由检查；抢单 SQL 与派发回收的 eligibility 判定一致。旧版或其他机器不能领取；会话重置不会解除机器约束。
- 主机离线、Runtime 行被清理或暂缺兼容 provider 时，任务等待。记录和文件保留，不回落到自动目录。「主机可用」表示主机协议状态；目录和上下文在任务启动时检查。
- 服务端将同一工作区的任务串行领取。daemon 按真实 cwd 加进程间锁，覆盖目录别名及不同 provider 进程；锁记录位于外部本机状态目录，活进程不会因超时被抢锁。
- 完成、取消、删除 Chat / Issue 不删除工作区。归档注册要求没有排队或执行中的任务，只阻止新运行，保留原目录。此接口不承担目录删除或迁移。

未选择工作区时继续使用原有自动目录规则。独立 Task 的基础设施重试使用新的临时 provider home，不复用旧的原生会话 ID；工作区文件继续保留。

## 亲和与设备路由

Project 设备绑定（含独享设备）是放置约束，任何亲和都不能绕过它。以下规则由同一个硬亲和分类函数驱动，`refreshQueuedIssueLaneAffinity` 的跳过集合与 `wait_reason` 的文案不会分叉。亲和分两类，规则不同（MUL-449）：

- **软亲和**＝ provider 会话血统：Chat 的 `chat_sessions.session_id / session_runtime_id`，Issue 的 `session_agent_lanes.provider_session_id / runtime_id`。钉住的机器过不了设备路由、或与真实 Issue 工作区所在机器冲突时，放弃血统、任务回池冷启动（`inheritChatSession=false`，Issue lane 走 `resetSessionAgentLane`，重置原因分别记为 `device_routing_rejected` / `issue_workspace_elsewhere`）。硬亲和优先于软亲和：真实工作区在 B 而旧会话在 A 时丢掉会话（`issue_workspace_elsewhere`），由工作区把任务约束到 B。工作区只约束**持有它**的任务（`holds_workspace=1`），讨论/侧会话轮次不因此丢会话；没有未 cleaned 工作区时不构成约束，lane 照常继承。判定按**机器**而非 Runtime id：同一台机器上的另一个 provider（例如 B 上的 codex 与 claude）算作同一台，不会互相判成冲突，只有 Runtime 已删除时才退化为按 id 比较。建单时（`createTaskWithinWorkspaceLock`）和领取前（`refreshQueuedIssueLaneAffinity` / `refreshQueuedChatAffinity`）都重算，所以改绑后已排队和存量的这类任务会自愈，不需要数据迁移。
- **落点** ＝ 同时满足任务全部硬亲和、能被抢单放行的机器。抢单 SQL 的结构谓词（`placementBeforeRoutingSql` / `placementAfterRoutingSql` + 共享的 `TASK_CLAIM_FROM_SQL`）与观察者共用一个只读探针 `runtimePlacementForTask(runtime, taskId)`，所以「哪台能领」只有一处口径；`store.describeTaskPlacement(taskId)` 可以只读地看每台已注册 Runtime 的 `placementOk` / `routingOk`。观察者按一条不变式判定：有机器同时满足落点与路由 → 不写原因；有落点但全被设备路由拒绝 → 写「等待项目设备：」并列出这些机器；没有任何机器满足落点 → 全部约束指向同一台未注册机器时退回 daemon 级判断，否则写新前缀「等待任务落点：」。优先级为落点 > 设备 > 模型能力；软亲和（可回池的 provider 血统）不写落点原因。
- **硬亲和**＝数据或配置只在那台机器：`with_code` 代码快照、真正持有 Issue 工作区的任务（`holds_workspace=1` 且存在未 cleaned 的工作区记录）、项目 `local_directory`、显式 `runtime_workspace_id`、Agent 绑定的 Runtime，以及按既有契约不重算的冻结重试（`attempt>1` 且带 `execution_fingerprint`）。工作区按**机器集合**判断（`runtime_id` 或该 runtime 的 `daemon_id` / `legacy_daemon_id`），任意一条记录命中即可，和抢单 SQL 的 `EXISTS` 一致；等待原因也报工作区所在机器，不会拿过期的会话 pin 冒充。回池会让任务在没有数据的机器上运行，所以不回池、不报错、不迁移；任务继续排队，由 60 秒观察者 `refreshQueuedCapabilityWaitReasons` 写 `wait_reason`，文本以 `等待项目设备：` 开头，说明钉在哪台机器、为什么（代码快照 / Issue 工作区 / 本机目录 / 显式 Runtime 工作区 / Agent 绑定 / 冻结重试）以及真正能解除等待的操作：把该机器加回项目设备绑定、取消它的独享设置，或（Agent 绑定）调整该 Agent 的 Runtime 绑定。「等待任务落点：」的补救文案按优先级只给一条：工作区 Runtime 已删除 → 提示重新注册原机器或人工处理；冻结重试（只按 `execution_fingerprint` 判定，`attempt>1` 不算）→ 提示 `remi task redispatch`（替代任务没有指纹，会按当前工作区重新计算落点）；Agent 绑定 → 提示改绑或解绑（`remi agent update --runtime`）；其余 → 让约束指向同一台机器。对其他硬亲和（代码快照、本机目录、显式 Runtime 工作区）不给 `redispatch`：它会重新推导出同一硬亲和，只会得到另一个同样排队的新任务。设备路由的原因优先于模型能力的原因，路由恢复后自动清空。跳过集合与文案标签共用同一个分类函数，不会各说各话；`holds_workspace=1` 但没有工作区记录的讨论/无项目任务仍按软亲和回池。

## 任务私有 /tmp

每个任务执行前，daemon 在本次执行的 provider home 下分配一个独占目录（`task-tmp/<task>-XXXXXX`，0700），执行结束后删除。Linux 把它挂载为进程树的字面 `/tmp`（[实现](../../packages/acp/src/private-tmp.ts)），因此同一个任务里的 shell、子进程和 ACP 文件工具看到同一份 `/tmp`，不同任务互不可见。namespace 不可用时 fail-closed：任务以 `private_tmp_isolation_unavailable` 失败，不退回共享 `/tmp`。

macOS 是有意降级（MUL-449）：内核没有 user / mount namespace，无法按任务替换字面 `/tmp`。darwin 上不套 `unshare`，改为把 `TMPDIR` / `TMP` / `TEMP` 指向该任务的私有目录，并接受字面 `/tmp` 与主机共享；`mapPrivateTmpPath` / `privateTmpVisiblePath` 在 darwin 上恒等，保证文件工具与 shell 解析同一路径（包括 antigravity 的 `--log-file`）。其他非 Linux 平台（win32 等）仍然报错。平台参数只为单测模拟 darwin，不影响 Linux 行为。

macOS 的 socket 路径上限是 104 字节（`sun_path`），而真实私有目录在 provider home 下，委派任务的路径可超过 220 字节，所以在 TMPDIR 里建 socket 的工具（MCP/IDE 的 IPC、git credential cache、tmux 等）会失败。darwin 上因此额外为每次执行创建一个 `/tmp/remi-XXXXXXXX` 短别名（`symlink()` 原子创建，随机名字，EEXIST 就换名重试，有次数上限；建好后 `lstat` 校验确实是自己建的链接并指向本次真实目录），`TMPDIR` / `TMP` / `TEMP` 指向别名，真实目录仍在 `task-tmp` 下。别名创建失败（例如 `/tmp` 不可写）只记一条 warn 并退回长路径，任务照常执行。执行结束时先校验「是符号链接」且「readlink 等于本次真实目录」，两项都满足才 `unlink` 别名，绝不经由别名递归删除；真实目录仍由 `cleanupTaskPrivateTempDirectory` 按 storage 边界删除。daemon 崩溃留下的悬空别名不做启动清扫：macOS 会定期清理 `/tmp`，且残留链接指向已删除的目录，只占名字不占数据。`isolateProcessTmp` 的 darwin 分支因此保留传入路径原样（不做 realpath），否则别名会被展开回长路径。

## 本地上下文

daemon 检查 cwd、额外上下文和环境文件的真实路径位于根目录内。目录缺失、越界或不可读写时任务失败，不创建替代目录。

原生会话历史继续按 Session 隔离。daemon 在隔离的 provider home 中生成本地指令，包含用户级指令、根目录到 cwd 的指令和 Skill 索引。Codex 每层按 `AGENTS.override.md`、`AGENTS.md`、`AGENT.md` 选一份；Claude 每层按 `CLAUDE.md`、`AGENTS.md`、`AGENT.md` 选一份。目录越具体，优先级越高。

Skill 索引包含名称、触发描述和绝对 `SKILL.md` 路径，支持文件从原目录读取。数据库 Agent Skill 写入 daemon 状态目录，不覆盖本地同名 Skill。单份上下文文件上限 256 KiB；生成的本地指令和 Skill 索引合计上限 24 KiB，超限明确失败。

`env_file` 使用 dotenv 格式，不执行 shell。注入顺序：机器环境 → 团队环境 → Agent 环境 → 本地环境文件 → provider 路由/认证 → Task 坐标。本地文件不能覆盖 `MULTIREMI_*`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`OPENAI_*`、`ANTHROPIC_*`。其他 provider 配置继续沿用现有筛选、插件和 relay 机制，不共享完整 native home。

这些文件无需纳入云端 Git。注册不上传文件内容，服务端 Task prompt 仅描述路径；执行 agent 及其模型服务仍可能读取文件，任务输出和会话归档仍按现有机制处理。跨 Chat 的原生历史不会自动合并；跨任务记忆可保存在工作区文件中。

原目录不写入 `.multiremi` 任务元数据。Issue 的 provider / archive 状态保存在 daemon 管理的目录；旧 Issue workspace 上报只指向该状态目录，不把注册目录交给 Issue GC。

[GC 安全删除实现](../../packages/daemon/src/agent-runtime/workspace/safe-remove.ts) 有两种寻址策略：Linux 用 `/proc/self/fd` 描述符锚定，macOS 用逐级 `lstat` 校验 + 隔离区重命名（`rename` 前后比对 dev/ino，校验通过才改名 `.deleting` 并递归删除）。两种策略都先移入 root 下 0700 的 `.multiremi-delete-quarantine`，不跟随符号链接，也不删除 owned root 之外的内容。Windows 没有可用策略，`ownedDirectoryRemovalSupport()` 仍报 blocked 并拒绝删除，daemon 管理的旧状态清理可能保留目录；Runtime 工作区注册、执行和归档均不依赖删除用户目录。

## 实现和验证

入口：[存储](../../packages/server/src/store/repos/runtime-workspaces-repo.ts)、[接口](../../packages/server/src/api/routers/runtime-workspaces.ts)、[调度](../../packages/server/src/store/repos/tasks-repo.ts)、[目录解析](../../packages/daemon/src/agent-runtime/workspace/ephemeral.ts)、[本地上下文](../../packages/daemon/src/agent-runtime/workspace/runtime-context.ts)、[daemon](../../packages/server/src/worker/daemon.ts)。

```bash
bun test tests/unit/multiremi/runtime-workspaces.test.ts
bun test tests/unit/daemon/runtime-workspace-context.test.ts tests/unit/daemon/workspace-supervisor-owner.test.ts
bun test tests/integration/multiremi-daemon-smoke.test.ts -t "executes a runtime workspace"
bun run --filter @multiremi/core test api/endpoints/runtime-workspaces.test.ts
bun run --filter @multiremi/views test runtimes/components/runtime-workspaces-tab.test.tsx
```

daemon 集成用例运行真实本地 API / worker，provider 使用测试实现；它不代表真实 Claude / Codex 模型已经验收。

使用机器上已登录的真实 provider，可运行下面的手动验证（会发送两个模型请求）：

```bash
bun run tests/integration/smoke-runtime-workspace-acp.ts --provider=codex
# 或 --provider=claude；可用 --model=<model-id> 指定模型
```

[该脚本](../../tests/integration/smoke-runtime-workspace-acp.ts) 创建非 Git 的临时工作区，先运行 Chat，再重启 daemon 并运行独立 Issue。它核对父目录 `AGENT.md`、额外上下文、Skill 原位置的支持文件、本地环境变量、前一任务留下的文件、真实 cwd、任务输出和用量。标记仅写入本地测试文件，不放入任务 prompt；归档后确认文件仍存在，再由测试自身清理临时目录。脚本不修改用户的已有工作区或 provider 配置。
