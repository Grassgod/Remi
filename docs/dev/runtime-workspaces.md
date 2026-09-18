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
- Chat、Issue、Task 保存引用；Task 创建时确定绑定。独立 Task 的基础设施重试和重新调度保留工作区。Issue 中不占用工作区的讨论/侧会话（`holds_workspace=false`）使用独立目录，不继承父 Issue 的本机目录或机器限制；重试和重新调度同样保持隔离。
- 领取要求 Runtime 声明 `runtime_workspaces: 1`、匹配 daemon，并通过已有 provider、Agent、插件和 Project 设备路由检查。旧版或其他机器不能领取；会话重置不会解除机器约束。
- 主机离线、Runtime 行被清理或暂缺兼容 provider 时，任务等待。记录和文件保留，不回落到自动目录。「主机可用」表示主机协议状态；目录和上下文在任务启动时检查。
- 服务端将同一工作区的任务串行领取。daemon 按真实 cwd 加进程间锁，覆盖目录别名及不同 provider 进程；锁记录位于外部本机状态目录，活进程不会因超时被抢锁。
- 完成、取消、删除 Chat / Issue 不删除工作区。归档注册要求没有排队或执行中的任务，只阻止新运行，保留原目录。此接口不承担目录删除或迁移。

未选择工作区时继续使用原有自动目录规则。独立 Task 的基础设施重试使用新的临时 provider home，不复用旧的原生会话 ID；工作区文件继续保留。

## 本地上下文

daemon 检查 cwd、额外上下文和环境文件的真实路径位于根目录内。目录缺失、越界或不可读写时任务失败，不创建替代目录。

原生会话历史继续按 Session 隔离。daemon 在隔离的 provider home 中生成本地指令，包含用户级指令、根目录到 cwd 的指令和 Skill 索引。Codex 每层按 `AGENTS.override.md`、`AGENTS.md`、`AGENT.md` 选一份；Claude 每层按 `CLAUDE.md`、`AGENTS.md`、`AGENT.md` 选一份。目录越具体，优先级越高。

Skill 索引包含名称、触发描述和绝对 `SKILL.md` 路径，支持文件从原目录读取。数据库 Agent Skill 写入 daemon 状态目录，不覆盖本地同名 Skill。单份上下文文件上限 256 KiB；生成的本地指令和 Skill 索引合计上限 24 KiB，超限明确失败。

`env_file` 使用 dotenv 格式，不执行 shell。注入顺序：机器环境 → 团队环境 → Agent 环境 → 本地环境文件 → provider 路由/认证 → Task 坐标。本地文件不能覆盖 `MULTIREMI_*`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`OPENAI_*`、`ANTHROPIC_*`。其他 provider 配置继续沿用现有筛选、插件和 relay 机制，不共享完整 native home。

这些文件无需纳入云端 Git。注册不上传文件内容，服务端 Task prompt 仅描述路径；执行 agent 及其模型服务仍可能读取文件，任务输出和会话归档仍按现有机制处理。跨 Chat 的原生历史不会自动合并；跨任务记忆可保存在工作区文件中。

原目录不写入 `.multiremi` 任务元数据。Issue 的 provider / archive 状态保存在 daemon 管理的目录；旧 Issue workspace 上报只指向该状态目录，不把注册目录交给 Issue GC。

Windows 和 macOS 下，现有 [GC 安全删除实现](../../packages/daemon/src/agent-runtime/workspace/safe-remove.ts) 缺少通过目录描述符遍历子目录的实现，会拒绝删除，因此 daemon 管理的旧状态清理可能保留目录。Runtime 工作区注册、执行和归档均不依赖删除用户目录。

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
