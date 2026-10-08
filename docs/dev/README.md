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
| 改用量采集、统计报表或模型价格 | [统一用量与价格](../usage-accounting.md)、[公开参考价格导入](../usage-reference-prices.md) | actual/context/unknown、run 幂等、执行归属、双时轴和受控历史迁移 |
| 通过 CLI 使用、管理或排查 Remi | [Remi Skill](../../.agents/skills/remi/SKILL.md) | 任务协作、项目知识、云友与模型、集成、权限和运行维护 |
| 改 Runtime 工作区、执行目录或本地上下文 | [Runtime 持久化工作区](runtime-workspaces.md) | daemon 归属、绑定、目录和上下文保留、调度约束 |
| 改 Chat 页面、私聊或消息队列 | [Chat 契约](../chat.md) | 会话管理、工作位置、队列串行和私聊权限 |
| 改 Agent 并行调度与执行目录 | [并行执行](../parallel-agent-execution.md) | Agent/Session 执行隔离、共享代码和 daemon 协议升级 |
| 修改登录、租户隔离或 token 权限 | [认证与权限](auth.md) | 身份来源、资源 guard 和生产启动约束 |
| 修改 ACP 后端或 token-sync | [Codex 接入](../design/acp-codex-via-codex-acp.md)、[Claude Code 接入](../design/acp-claude-via-claude-agent-acp.md)、[认证插件与同步](../design/1passport-bytedance-sso.md) | 实际启动、认证、会话和凭据隔离边界 |
| 改 turn 失败检测、备用模型恢复或能力排队切换 | [ADR 0010](../adr/0010-turn-failure-from-bridge-typed-session-failure.md) | AIR 失败 metadata、失败分类、单次切换、5 分钟能力等待与提交后事件 |
| 修改 Antigravity / agy 执行 | [Antigravity Runtime](../antigravity.md) | 原生 CLI 发现、事件流、续接、旧版恢复和能力边界 |
| 修改云友模板或 Skill | [Agent 配置规范](../agent-config-spec.md) | 提示词结构、字段和元信息检查 |
| 改工作台与通知 | [工作台/收件箱边界](../inbox-workbench-boundary.md) | 通知的触发条件与状态归属 |
| 改 daemon 轮询节奏、心跳 ack 或插件 desired 协议 | [ADR 0001](../adr/0001-daemon-poll-cadence-and-desired-revision.md) | 已定的取舍、被否决的替代方案和回到源码的位置 |
| 改父 issue 状态推导、子 issue 结束通知或 `force` | [ADR 0003](../adr/0003-parent-status-derived-from-children.md) | 守卫 A/B、再推导、A1/A4 判定和排一轮合并的取舍 |
| 改 Issue 责任、正式交付、根人类或关闭权限 | [Issue 责任与正式交付](issue-responsibility.md) | 统一 resolver、未知历史责任、具体交付验收与代理授权 |
| 改系统收件箱、平台待处理轮或唤醒事务 | [统一收件箱 Store](inbox-store.md)、[Message HTTP 接口](message-api.md)、[ADR 0016](../adr/0016-unified-message-inbox-and-turn.md) | 唯一入口、叫醒降级、合并/插话/补铃、member 游标与页面接口 |
| 改提问卡片答复鉴权、令牌轮换或宿主重启恢复 | [ADR 0011](../adr/0011-question-card-one-time-token.md) | 服务端一次性令牌、收件人绑定与成员映射的边界 |
| 改 issue 依赖、`blocked_by` 语义、依赖闸门或自动开工 | [ADR 0004](../adr/0004-issue-dependency-semantics.md) | 单向存储、满足判定、闸门位置、自动开工与失败报告的取舍 |
| 改 agent 派活、来回上限、委派回叫或 `wake_source` | [ADR 0014](../adr/0014-every-agent-dispatch-is-a-delegation.md)、[ADR 0005](../adr/0005-cross-issue-delegation-return.md) | 通用派活入口、来源会话、谱系计数降级、D4 去重和回程血缘 |
| 改任务结果、门铃正文、未读输入或 Wiki 下载 | [ADR 0013](../adr/0013-deliverable-is-comment-wakeup-is-doorbell.md)、[daemon 协议](../daemon-protocol-v2.md) | 最后顶层消息、事务内结论评论、完整范围读取、Wiki 缓存与派单预算 |
| 改消息头、轮/尝试存储、统一 lane 或启动迁移 | [ADR 0016](../adr/0016-unified-message-inbox-and-turn.md)、[切换手册](../deploy/unified-model-cutover.md) | 存储投影、四项启动预检、lane 迁移、消息状态机、只读对账与删表边界；传输和用户接口由消费者集成 |
| 改会话日志表、轮次卡、trace 归属或 Session Archive 主体 | [ADR 0006](../adr/0006-conversation-log-and-daemon-owned-traces.md) | 契约类型、被否决的替代方案和回到源码的位置 |
| 改 daemon 与服务端之间的传输协议、派活方式或 trace 流 | [daemon 协议 v2](../daemon-protocol-v2.md)、[ADR 0012](../adr/0012-daemon-protocol-v2-single-socket-and-db-derived-downlink.md) | 进程级 socket、升级等待与 offer；pending/配置和任务输入走下行帧及 RPC，跨进程触发依赖实时扇出；outbox 与 trace 归 v2-A |
| 改浏览器实时订阅、Live Hub 或前端本地副本 | [浏览器实时 v2](realtime-v2.md)、[ADR 0007](../adr/0007-live-hub-and-browser-replica.md) | 两条流的端点与归属、订阅鉴权、续传与退避、resync 广播；C1 已落核心、按角色锁与 health 字段 |
| 对接 Hub 的 trace 订阅（A-6、飞书 CoT） | [Live Hub 对接说明](live-hub-a6-integration.md) | 调用方式、gap 由谁补读、背压恢复与 `closed` 终态 |
| 改详情页首屏定位、贴底或 `data-perf-state` 契约 | [ADR 0008](../adr/0008-issue-detail-anchored-reveal-and-stick-to-bottom.md) | 先隐藏后一次定位、贴底状态机与预算口径 |
| 改项目 Memory/Wiki | [项目知识契约](../project-wiki-memory-spec.md) | 查询、提案、发布、物化与权限 |
| 改飞书消息接入 | [消息接入](../feishu-message-ingestion.md) | Connection、Source、消息处理与凭据 |
| 配置部署或排障 | [部署](../../deploy/README.md)、[本机 stable/dev](../deploy/local-profiles.md)、[daemon 环境](../deploy/66-8-remi-environment.md) | 服务组成、配置和启动条件 |
| 更新这些开发依据 | [维护方法](context-maintenance.md) | 归属、源码核对和可执行检查 |

文档中的源码链接提供定位依据，测试链接提供验证入口。它们不等于本次测试已通过；性能基线是否已采集以[性能页](performance.md)为准。
