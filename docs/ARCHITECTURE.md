---
title: Remi 当前架构地图
status: active
summary: 从 CLI、Web 和飞书入口追踪到 API、存储与 Agent 执行，并定位配置和验证边界。
---

# 当前架构地图

本页描述当前工作树的实现位置。运行命令见[根 CLAUDE.md](../CLAUDE.md)，包成员和脚本以[根 package.json](../package.json)为准。
任务导航见[开发入口](dev/README.md)。本页与源码一起维护；接口字段和默认值回到其定义处读取。

## 入口与职责

| 入口或模块 | 当前职责 | 读代码从这里开始 |
|---|---|---|
| `apps/remi` | `remi` CLI、登录、服务生命周期和平台命令 | [main.ts](../apps/remi/main.ts)、[CommandRegistry](../apps/remi/cli/core/command-registry.ts) |
| `apps/server` | 平台 CLI 入口，复用服务端启动分发 | [main.ts](../apps/server/main.ts)、[multiremi.ts](../apps/remi/cli/multiremi.ts) |
| `frontend/apps/web` | Next.js Web 入口 | [应用目录](../frontend/apps/web)、[前端地图](dev/frontend.md) |
| `packages/server` | Hono API、wire 序列化、领域存储、平台 worker | [API 组合与服务启动](../packages/server/src/api/server.ts)、[Store](../packages/server/src/store/store.ts) |
| `packages/daemon` | 共享 AgentRuntime、工作目录/插件/MCP/提示词组装、lane 和定时调度 | [runtime.ts](../packages/daemon/src/agent-runtime/runtime.ts)、[orchestrator.ts](../packages/daemon/src/orchestrator.ts)、[scheduler.ts](../packages/daemon/src/scheduler.ts) |
| `packages/remi` | Remi core 库与会话辅助代码；当前 foreground 的飞书消息接线位于 `apps/remi/cli/multiremi.ts` | [core.ts](../packages/remi/src/core.ts)、[当前 foreground](../apps/remi/cli/multiremi.ts) |
| `packages/acp` | ACP 连接、原生 agy 与统一 provider 事件 | [provider 工厂](../packages/acp/src/runtime-provider.ts)、[client.ts](../packages/acp/src/client.ts)、[adapter registry](../packages/acp/src/adapters/index.ts) |
| `packages/connectors` | 平台消息接收与回复适配 | [base.ts](../packages/connectors/src/base.ts)、[feishu](../packages/connectors/src/feishu) |
| `packages/contracts` / `shared` / `auth` | 共享类型、配置/基础设施、认证 | [contracts](../packages/contracts/src)、[shared](../packages/shared/src)、[auth](../packages/auth/src) |

当前执行实现跨两个包：领取、上报、取消与恢复的主循环在
[server/worker/daemon.ts](../packages/server/src/worker/daemon.ts)，它调用 `packages/daemon` 的运行时构件。
排查任务执行时两个位置都要看；包名不等于全部生命周期的归属。

## 三条数据流

**Web / CLI 读写平台数据**：前端查询或 CommandRegistry → Hono [routers](../packages/server/src/api/routers) →
[Store facade](../packages/server/src/store/store.ts) / [领域 repos](../packages/server/src/store/repos) → 数据库。
对外形状集中到 [wire](../packages/server/src/api/wire)；事件经 [realtime](../packages/server/src/api/realtime.ts) 到前端缓存。

**任务执行**：issue/chat/autopilot 产生 task → [任务存储](../packages/server/src/store/repos/tasks-repo.ts) →
[daemon client](../packages/server/src/worker/client.ts) / [worker loop](../packages/server/src/worker/daemon.ts) 领取 →
[AgentRuntime](../packages/daemon/src/agent-runtime/runtime.ts) 组装执行上下文 → ACP 或原生 agy provider → 消息、usage 和终态上报。
权限请求、会话延续、工作目录归属与重试都在这条链路中，不可只以模型输出判断完成。

上面这段是当前工作树的实现：领取走 HTTP claim 轮询，过程消息经 `TaskMessageBatcher` 写入
`multiremi_task_messages`。MUL-401（协议 v2）把它换成 daemon 进程一条全双工 socket——服务端推送派活、
过程事件作为 trace 流交给 Live Hub 而不再落库、`trace.read` 作为反向 RPC 读热 trace。**协议 v2 尚未接线**：
契约与内存实现随 A-0 落地，连接层与派活在其后的子单，规范见
[daemon 协议 v2](daemon-protocol-v2.md)，取舍见 [ADR 0005](adr/0005-daemon-protocol-v2-single-socket-and-db-derived-downlink.md)。
在这条链路换完之前，以本段描述的 HTTP 路径为准。

Runtime 可持有独立的[持久化工作区](dev/runtime-workspaces.md)：绑定 daemon 的已有目录。任务和聊天通过统一的「工作位置」选择项目或本机目录，二者互斥；Agent 可在不同任务中选择不同位置。目录绑定只能在所属机器执行；未指定位置时沿用自动任务目录。

Chat 与 Issue 独立，Chat 创建时保存项目或本机目录选择；Runtime 本机目录不附加项目仓库；项目聊天优先采用项目所选的 `local_directory`，否则在托管 Chat 目录自动准备项目显式声明的仓库，后续复用已有 worktree。未选工作位置时使用自动 Chat 目录。在 Chat 中创建 Issue 不绑定会话，也不继承新 Issue 的上下文；普通私聊不接收 Issue 播报。飞书群 Issue 话题的归属由 [FeishuBotRepo](../packages/server/src/store/repos/feishu-bot-repo.ts)维护，投递和任务领取检查绑定、Issue、工作区、Chat 与 Agent 一致性；归属不明的旧关联按[迁移手册](migrations/chat-issue-decoupling.md)审计恢复。[claim wire](../packages/server/src/api/wire/tasks.ts)保留有预算的会话 projection，仅向已确认的 Issue 话题附加 Issue 与增量摘要。详见 [Chat 契约](chat.md)。

**飞书聊天**：[controlPlaneConciergeHost / createFeishuTaskHandler](../apps/remi/cli/multiremi.ts)启动 connector；普通消息经 daemon client 提交平台 Chat/Task，再走上面的任务执行链。connector 从 task 事件流回复；去重、运行中 steering、取消与人工请求也使用平台 task。当前 foreground 不实例化 `packages/remi` 的 `Remi` core，不能以该库的 `_process()` 作为当前 bot 入口。
工作区的 [Feishu bot 配置](../packages/server/src/store/repos/feishu-bot-repo.ts)指定 Agent 和 Runtime；
bot 控制指令携带版本和期望状态。[concierge supervisor](../packages/server/src/worker/feishu-concierge.ts)经鉴权接口拉取 assignment 后串行协调 connector 的启动、停止与重试，应用凭据不随心跳下发。心跳还可领取持久化出站投递，由 connector 发送并回报；自动 Issue 话题及负责人轮次完成推送见[飞书接入契约](feishu-message-ingestion.md)。

## 存储与事务

当前 Store 使用同步 `SqlDatabase` 接口。[openMultiremiDatabase](../packages/server/src/store/db/postgres.ts)
根据 `MULTIREMI_DATABASE_URL` 选择 PostgreSQL，否则使用本地 SQLite。
这是底层存储适配的选择；生产 server 启动还有[必要配置检查](dev/auth.md)，不能据此省略部署配置。
PostgreSQL 的 `PgBridge.request` 用 `Atomics.wait` 等待 [pg-worker](../packages/server/src/store/db/pg-worker.ts)，worker 使用单连接。
这是真实实现约束，不应被“整体 async/await”概述掩盖。

该适配文件记录的动机是兼容已有同步 Store 调用；不能据此推断它仍适合当前并发负载。
改为异步时需同时处理调用链与事务连接归属，不能只调大连接数。
性能影响、现有基线脚本和待测项见[性能调查](dev/performance.md)。

## 配置与能力定位

- bot assignment 由工作区独立的 `multiremi_feishu_bot_configs` 记录关联 Agent/Runtime；实际任务通过 Agent 行组装执行参数。bot 凭据在控制面配置，daemon 环境仅承载连接和进程设置，见[配置说明](deploy/66-8-remi-environment.md)。
- 当前运行时支持 Claude、Codex 和 [Antigravity](antigravity.md)：前两者通过 ACP，Antigravity 通过原生 `agy` CLI，统一输出 Remi 事件。认证方式按各 CLI 和[安装说明](../README.md)配置，不能把所有后端概括为“不需要 API key”。
- Codex 与 Claude Code 的 Runtime 详情支持自定义模型连接，执行时注入隔离 Home；鉴权、任务快照与协议分别见 [Codex 连接](design/acp-codex-via-codex-acp.md) 和 [Claude Code 连接](design/acp-claude-via-claude-agent-acp.md)。
- [MCP 组装](../packages/daemon/src/agent-runtime/mcp/ephemeral.ts)当前接受 `command` 形式的 stdio 服务；远程 HTTP 配置不能仅因存进 agent 字段就视为已注入。
- 项目知识由[知识服务](../packages/server/src/project-knowledge/service.ts)和[知识路由](../packages/server/src/api/routers/knowledge.ts)提供；用户项目知识与本仓库开发文档分别维护。

## 验证与修改边界

| 修改范围 | 先检查的依据 |
|---|---|
| 包依赖与共享类型 | [package-boundaries.test.ts](../tests/arch/package-boundaries.test.ts)、[tsconfig.json](../tsconfig.json) |
| HTTP 能力与 CLI | [仓库规则](../AGENTS.md)、[路由快照脚本](../scripts/snapshot-api-routes.ts)、[CLI 能力检查](../scripts/check-cli-capabilities.ts) |
| 任务路由、重试与会话 | [tasks-repo.ts](../packages/server/src/store/repos/tasks-repo.ts) 与 [worker/daemon.ts](../packages/server/src/worker/daemon.ts) 的相关测试；发现方式见[测试指南](../TESTING.md) |
| Chat/Issue 隔离、话题归属与飞书推送 | [claim wire 测试](../tests/unit/multiremi/multiremi-store-daemon-wire.test.ts)、[Issue 更新测试](../tests/unit/multiremi/multiremi-agent-issue-updates.test.ts)、[话题测试](../tests/unit/multiremi/multiremi-feishu-issue-topics.test.ts) |
| 前端缓存与渲染 | [前端规则](../frontend/AGENTS.md)、[前端地图](dev/frontend.md) |

链接和静态检查只提供定位依据。本页不宣称已经启动生产服务、通过全部测试或完成性能测量。

## 云友执行能力组

[执行组存储](../packages/server/src/store/execution-groups.ts)与[调度](../packages/server/src/store/repos/tasks-repo.ts)共同管理执行能力组。云友通过 `execution_group_id` 选择执行能力组，`provider` 表示 Runtime 类型。系统默认按工作区、机器（优先使用 daemon ID）与 Runtime 类型生成稳定的 `eg_` 组标识；Runtime 也可配置自定义组标识，将同工作区、同类型的多个 Runtime 合并调度。自定义标识使用 1–128 位字母、数字、下划线、点、冒号或连字符，首位必须为字母或数字，`eg_` 前缀保留给默认组。旧机器身份补齐时保留默认组，已有同机器默认组时归并并迁移云友引用。将 Runtime 的 `execution_group_id` 设为 `null` 可恢复默认组；`execution_group_ids` 返回实际成员关系。通用 `any` Runtime 自动加入 Claude/Codex 默认组，自定义组要求具体类型。

创建和编辑云友共用能力组选择器，显示组标识、成员和在线数量；也可选择「自动调度」，保留按引擎和归属在工作区内跨机器调度的原有行为。自动调度的模型与思考选项使用云友所有者可用的工作区目录。选择具体组时，模型及思考选项取各可执行成员（含离线成员）的有效连接目录交集：自定义连接优先，并保留 daemon 为配置模型实际探测到的思考能力，否则应用工作区网关；成员一致时才标记默认模型。组内任务领取及重领通过 `runtimeCanRunAgent` 复验成员关系、模型能力、类型、工作区和归属，并与项目设备和本机目录约束取交集。组离线或无可用成员时排队，不转到组外机器。

切换云友执行组默认清空模型和思考覆盖，未冻结的排队任务清除旧会话信息，已冻结但未启动的任务取消，运行中任务继续原执行。组和成员关系持久化；Runtime 离组或删除后保留组，已有云友不会静默转组。旧 `runtime_id` 绑定迁移到对应组并保留机器约束与手填模型兼容行为，显式选择组（包括重选当前组）后解除旧机器绑定并启用组模型校验；原先未绑定的云友保留原调度行为。当前分组由默认规则和显式组标识决定，后续可在组成员解析层扩展能力匹配。
