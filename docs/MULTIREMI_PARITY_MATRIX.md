# Remi 能力定位与验证入口

本表按当前源码定位能力与边界，不使用历史 `done` 标记作为本版本验收。其他项目的能力与版本需要在具体对标任务中核对；这里维护 Remi 本身的实现依据。

| 能力 | 当前实现 | 开发时注意的边界 | 验证入口 |
|---|---|---|---|
| Web / CLI 平台操作 | [Hono routers](../packages/server/src/api/routers)、[CommandRegistry](../apps/remi/cli/core/command-registry.ts) | API 存在不等于 CLI 已覆盖；注册的身份、参数与 canonical 路径需要一致 | [CLI manifest](../cli-capabilities.json)、[能力检查](../scripts/check-cli-capabilities.ts) |
| 工作区与成员鉴权 | [auth helpers](../packages/server/src/api/helpers/auth-guards.ts)、[workspaces repo](../packages/server/src/store/repos/workspaces-repo.ts) | 按资源检查工作区和身份，不能由页面是否隐藏推断权限 | [multiuser 测试](../tests/unit/multiremi/multiremi-multiuser-auth.test.ts) |
| Agent 与 Squad | [agents](../packages/server/src/api/routers/agents.ts)、[squads](../packages/server/src/api/routers/squads.ts) | 持久 bot 使用工作区 concierge assignment；派单资格还受 workspace/runtime/provider 约束 | [任务存储](../packages/server/src/store/repos/tasks-repo.ts)、[worker](../packages/server/src/worker/daemon.ts) |
| 领取、心跳、取消与恢复 | [daemon loop](../packages/server/src/worker/daemon.ts)、[task repo](../packages/server/src/store/repos/tasks-repo.ts) | 自动重试受 `AUTO_RETRY_FAILURE_REASONS` 白名单限制；不能宣称任意错误自愈 | [daemon API 测试](../tests/unit/multiremi/multiremi-api-daemon.test.ts) |
| Chat / Issue 隔离与话题上下文 | [ChatRepo](../packages/server/src/store/repos/chat-repo.ts)、[claim wire](../packages/server/src/api/wire/tasks.ts)、[CLI context](../packages/server/src/api/routers/cli.ts) | 普通 Chat 与 Issue 独立；飞书群话题通过绑定表确认 Issue 归属，会话投影与话题增量摘要有预算，Chat task 的结束不自动结束 Issue | [claim wire 测试](../tests/unit/multiremi/multiremi-store-daemon-wire.test.ts)、[CLI context 测试](../tests/unit/multiremi/multiremi-api-cli.test.ts) |
| Agent provider | [provider 工厂](../packages/acp/src/runtime-provider.ts)、[provisioning](../packages/acp/src/provision.ts) | Claude/Codex 使用 ACP，[Antigravity](antigravity.md) 使用原生 agy；需要对应认证，平台注册不证明 provider 可运行 | [provider 测试](../tests/unit/acp/providers.test.ts)、[agy 测试](../tests/unit/acp/antigravity.test.ts)、[真实 ACP 冒烟](../tests/integration/smoke-multiremi-acp.ts) |
| Agent MCP | [ephemeral MCP](../packages/daemon/src/agent-runtime/mcp/ephemeral.ts) | 当前注入接受 `command` stdio；仅有 HTTP/SSE URL 的项被跳过 | `buildTaskMcpServers` 与 `buildAgentMcpServers` 的调用及测试 |
| 项目 Memory / Wiki | [知识服务](../packages/server/src/project-knowledge/service.ts)、[当前契约](project-wiki-memory-spec.md) | 查询、提交和发布是不同权限/生命周期；不要把旧本地 Memory 当事实源 | [知识路由](../packages/server/src/api/routers/knowledge.ts)及其契约测试 |
| 飞书聊天 / Issue 话题 / 消息接入 | [foreground Chat/Task 接线](../apps/remi/cli/multiremi.ts)、[FeishuBotRepo](../packages/server/src/store/repos/feishu-bot-repo.ts)、[消息接入契约](feishu-message-ingestion.md) | 自动话题需配置且 bot 在线；负责人轮次完成可唤醒绑定 Chat，出站投递持久化并重试；普通 Issue 更新摘要不逐条唤醒。Connection/Source 采集另有生命周期和凭据 | [话题测试](../tests/unit/multiremi/multiremi-feishu-issue-topics.test.ts)、[轮次推送测试](../tests/unit/multiremi/multiremi-feishu-bot-task-bridge.test.ts)、[Issue 更新测试](../tests/unit/multiremi/multiremi-agent-issue-updates.test.ts) |
| Inbox 分页与计数 | [Inbox 路由](../packages/server/src/api/routers/inbox.ts)、[列表与摘要](../packages/server/src/store/repos/issues-repo.ts) | 列表使用游标分页；badge 从独立 summary 读取，不能只统计已加载页；summary 仍扫描轻量行，不能推断吞吐提升幅度 | [分页/摘要测试](../tests/unit/multiremi/multiremi-api-search-inbox.test.ts)、[收件箱边界](inbox-workbench-boundary.md) |
| Autopilot / SCM / Inbox | [autopilot repo](../packages/server/src/store/repos/autopilots-repo.ts)、[SCM 路由](../packages/server/src/api/routers/scm.ts)、[Inbox 路由策略](../packages/server/src/store/inbox-routing.ts) | webhook、运行记录和通知都有专门契约；是否达到业务验收需按场景检查 | [工作台/收件箱边界](inbox-workbench-boundary.md)、[测试指南](../TESTING.md) |
| 性能与容量 | [同步数据库桥](../packages/server/src/store/db/postgres.ts)、[查询与渲染地图](dev/performance.md) | 结构性热点已定位，未采集的基线不能填入延迟或吞吐数字 | [性能采样方法](dev/performance.md) |

Chat 的独立页面、置顶、归档和消息队列见 [Chat 契约](chat.md)；项目和 Runtime 目录绑定见 [工作位置](dev/runtime-workspaces.md)。并行任务与共享代码目录的限制见 [并行执行](parallel-agent-execution.md)。

改动能力后，同批更新对应专题及验证入口。目录、类型定义、测试文件存在只证明有相应代码，不能自动等价为本次验证通过。
