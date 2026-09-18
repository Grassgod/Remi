---
title: Remi 开发上下文入口
status: active
summary: 按任务定位当前实现、约束和验证命令。
---

# 开发上下文

先读[仓库规则](../../AGENTS.md)，从下表选择与任务相关的一项，再沿源码链接定位实现。
这里维护本仓库的开发依据；用户项目的 Memory/Wiki 是另一个产品能力。

| 当前任务 | 当前说明 | 需要确认 |
|---|---|---|
| 首次接手、跨模块修改 | [架构](../ARCHITECTURE.md) | 入口、模块职责、配置与数据流 |
| 配置环境、运行开发命令 | [命令](../../CLAUDE.md)、[贡献指南](../../CONTRIBUTING.md) | 依赖、启动前提、构建和检查 |
| 改 Web 页面、查询或实时更新 | [前端](frontend.md)、[前端规则](../../frontend/AGENTS.md) | 状态、请求、渲染的归属 |
| 调查速度、吞吐或卡顿 | [性能](performance.md) | 静态事实、待测假设、事务约束与采样方法 |
| 判断能力是否存在 | [能力定位](../MULTIREMI_PARITY_MATRIX.md) | 当前实现和验证入口；不从旧完成标记推断 |
| 运行测试、验证回归 | [测试](../../TESTING.md) | 测试发现范围与真实服务前提 |
| 新增 API 或 CLI 能力 | [CLI 命令契约](../cli-command-migration.md) | canonical 命令、注册与能力检查 |
| 通过 CLI 使用、管理或排查 Remi | [Remi Skill](../../.agents/skills/remi/SKILL.md) | 任务协作、项目知识、云友与模型、集成、权限和运行维护 |
| 改 Runtime 工作区、执行目录或本地上下文 | [Runtime 持久化工作区](runtime-workspaces.md) | daemon 归属、绑定、目录和上下文保留、调度约束 |
| 改 Chat 页面、私聊或消息队列 | [Chat 契约](../chat.md) | 会话管理、工作位置、队列串行和私聊权限 |
| 改 Agent 并行调度与执行目录 | [并行执行](../parallel-agent-execution.md) | Agent/Session 执行隔离、共享代码和 daemon 协议升级 |
| 修改登录、租户隔离或 token 权限 | [认证与权限](auth.md) | 身份来源、资源 guard 和生产启动约束 |
| 修改 ACP 后端或 token-sync | [Codex 接入](../design/acp-codex-via-codex-acp.md)、[Claude Code 接入](../design/acp-claude-via-claude-agent-acp.md)、[认证插件与同步](../design/1passport-bytedance-sso.md) | 实际启动、认证、会话和凭据隔离边界 |
| 修改 Antigravity / agy 执行 | [Antigravity Runtime](../antigravity.md) | 原生 CLI 发现、事件流、续接、旧版恢复和能力边界 |
| 修改云友模板或 Skill | [Agent 配置规范](../agent-config-spec.md) | 提示词结构、字段和元信息检查 |
| 改工作台与通知 | [工作台/收件箱边界](../inbox-workbench-boundary.md) | 通知的触发条件与状态归属 |
| 改项目 Memory/Wiki | [项目知识契约](../project-wiki-memory-spec.md) | 查询、提案、发布、物化与权限 |
| 改飞书消息接入 | [消息接入](../feishu-message-ingestion.md) | Connection、Source、消息处理与凭据 |
| 配置部署或排障 | [部署](../../deploy/README.md)、[本机 stable/dev](../deploy/local-profiles.md)、[daemon 环境](../deploy/66-8-remi-environment.md) | 服务组成、配置和启动条件 |
| 更新这些开发依据 | [维护方法](context-maintenance.md) | 归属、源码核对和可执行检查 |

文档中的源码链接提供定位依据，测试链接提供验证入口。它们不等于本次测试已通过；性能基线是否已采集以[性能页](performance.md)为准。
