# 目录结构重设计 v4（最终版）

> 核心理念：**像搭积木**——每个模块是松耦合的独立块,逐层向上,上层复用底层能力。
> 目录树 = 架构图的投影。拿着图,每个框直接指到一个目录。

## 0. 架构模型

```
L0  基础设施        shared/
                      │
L1  独立积木块      acp/  memory/  queue/  agents/  connectors/  auth/
                      │
L2  运行时引擎      daemon/
                    ├── orchestrator     消息路由、调度、session
                    └── agent-runtime    agent 完整运行环境
                        ├── skills/      (persistent + ephemeral)
                        ├── mcp/         (persistent + ephemeral + server 管理)
                        ├── prompts/     (persistent + ephemeral)
                        ├── env/         (环境变量注入)
                        ├── plugins/     (插件加载)
                        ├── workspace/   (persistent cwd + ephemeral worktree)
                        └── repo/        (代码仓库 checkout)
                      │
L3  产品            remi/  (薄: 聊天 bot)
                    multiremi/  (平台: 任务管理, 中心化, PostgreSQL)
                      │
L4  界面            cli/  frontend/
```

- 每层只依赖下层,不准反向。同层之间不互相 import。
- **daemon 是中枢**:负责所有运行时编排。Remi 和 Multiremi 都是 daemon 的消费者。
- **agent-runtime 按能力维度组织**(skills/mcp/prompts/...),每个能力内部分 persistent 和 ephemeral 两种模式。
- **persistent 模式**（Remi 用）:改配置就生效,一直在。不再使用 cc-switch 品牌/路径。
- **ephemeral 模式**（Multiremi 用）:per-task 从 DB 读 agent 配置 → 写到临时 workdir → task 结束 GC。
- **部署模型**:multiremi = 中心化单实例 + PostgreSQL;daemon = 分布式多机,通过 HTTP 调 multiremi API,不直连 PG;remi = 单机 SQLite。

## 1. 目标目录树

```text
remi/
├── src/
│   │
│   │  ─────────── L0: 基础设施 ───────────
│   │
│   ├── shared/                          # 纯 infra 原语,无业务逻辑
│   │   ├── logger.ts
│   │   ├── config.ts
│   │   ├── tracing.ts
│   │   ├── version.ts
│   │   ├── metrics/
│   │   ├── infra/
│   │   └── db/                          # SQLite 封装（两产品共用的轻量 DB）
│   │       ├── index.ts                 # 统一接口
│   │       ├── sqlite.ts
│   │       └── sqlite-custom.ts         # ⚠️ 必须是入口首行 import
│   │
│   │  ─────────── L1: 独立积木块 ───────────
│   │  每个块自包含、可独立测试、可被任何上层复用
│   │  L1 积木块之间零依赖
│   │
│   ├── acp/                             # AI 协议
│   │   ├── provider.ts                  # Provider 接口 + AcpProvider 实现
│   │   ├── client.ts                    # JSON-RPC stdio client
│   │   ├── adapters/                    # claude / codex adapter
│   │   ├── protocol.ts                  # 消息/事件类型
│   │   ├── switch-mode.ts               # provider 切换
│   │   └── elicitation.ts               # AskUser 交互
│   │   # 合并原 packages/acp-provider + src/providers
│   │
│   ├── memory/                          # 记忆系统（独立块,不属于 remi）
│   │   ├── store.ts                     # MemoryStore
│   │   ├── link-graph.ts
│   │   ├── maintenance.ts
│   │   └── mcp-server.ts               # recall/remember MCP 暴露
│   │
│   ├── queue/                           # 任务队列基础设施
│   │   ├── index.ts                     # BunQueue manager
│   │   └── handlers/
│   │
│   ├── agents/                          # agent 定义 + 运行时 registry
│   │   ├── registry.ts
│   │   ├── runner.ts
│   │   └── types.ts
│   │
│   ├── connectors/                      # 输入适配
│   │   ├── base.ts                      # Connector 接口
│   │   └── feishu/                      # 飞书实现
│   │       # 合并原 packages/feishu-channel + src/connectors
│   │
│   ├── auth/                            # 身份/登录
│   │
│   │  ─────────── L2: 运行时引擎 ───────────
│   │
│   ├── daemon/                          # 中央运行时引擎
│   │   ├── orchestrator.ts              # 消息路由、队列调度、session 管理
│   │   │
│   │   ├── agent-runtime/               # agent 完整运行环境（按能力维度组织）
│   │   │   │
│   │   │   ├── skills/                  # Skill 注入
│   │   │   │   ├── persistent.ts        #   SSOT + symlink（~/.remi/skills/,不再用 cc-switch）
│   │   │   │   └── ephemeral.ts         #   per-task 写 .claude/skills/ + prompt 注入
│   │   │   │
│   │   │   ├── mcp/                     # MCP 工具
│   │   │   │   ├── persistent.ts        #   持久 .mcp.json 同步
│   │   │   │   ├── ephemeral.ts         #   ACP session/new mcpServers 参数
│   │   │   │   └── servers/             #   MCP server 注册/启动/管理
│   │   │   │
│   │   │   ├── prompts/                 # CLAUDE.md / AGENTS.md / 指令
│   │   │   │   ├── persistent.ts        #   managed block fan-out（不再用 cc-switch）
│   │   │   │   └── ephemeral.ts         #   写文件 / prompt 注入
│   │   │   │
│   │   │   ├── env/                     # 环境变量 + 自定义参数
│   │   │   │   └── injector.ts          #   统一：→ spawn env
│   │   │   │
│   │   │   ├── plugins/                 # 插件加载
│   │   │   │   ├── registry.ts          #   in-tree + external
│   │   │   │   └── sso/                 #   SSO 认证插件
│   │   │   │
│   │   │   ├── workspace/               # 工作区
│   │   │   │   ├── persistent.ts        #   固定 cwd
│   │   │   │   └── ephemeral.ts         #   per-task worktree + git exclude + GC
│   │   │   │
│   │   │   └── repo/                    # 代码仓库
│   │   │       └── checkout.ts          #   git bare clone → worktree
│   │   │
│   │   ├── scheduler.ts
│   │   └── pm2.ts
│   │
│   │  ─────────── L3: 产品 ───────────
│   │
│   ├── remi/                            # 薄层：飞书聊天 bot
│   │   │                                # 只管"我是谁、我在跟谁聊"
│   │   ├── conversation/
│   │   ├── group/
│   │   ├── project/
│   │   ├── imaging/
│   │   └── admin/                       # Remi 后台 API
│   │
│   ├── multiremi/                       # 平台：任务/agent/workspace 管理
│   │   ├── store/                       # 数据层 + PostgreSQL（中心化 DB）
│   │   │   └── db/                      #   PG adapter（不在 shared,是 multiremi 内部事）
│   │   │       ├── postgres.ts
│   │   │       └── pg-worker.ts
│   │   ├── api/                         # Hono 路由
│   │   ├── contracts/                   # types + wire 序列化
│   │   └── worker/                      # task claim → 调 daemon/agent-runtime ephemeral → 执行
│   │
│   │  ─────────── L4: 界面 ───────────
│   │
│   ├── cli/                             # 薄分发
│   └── main.ts                          # 统一入口
│
├── frontend/                            # 独立前端工作区（pnpm+turbo,和根仓 Bun 隔离）
│   ├── apps/console/                    # 一个 Next.js app
│   │   app/
│   │     page.tsx                       #   入口页 → Remi 后台 + Multiremi 看板
│   │     (remi)/...
│   │     (multiremi)/...
│   ├── packages/ui/  core/  views/
│   └── pnpm-workspace.yaml
│
├── packages/
│   └── plugin-sdk/                      # 唯一保留的 package：外部插件 SDK 契约
│
├── agents/                              # 旧模式残留：迁移到 multiremi agent 配置后删除
├── pipeline/skills/                     # 顶层：skill 定义 SSOT（迁移到 multiremi 后可删）
│
├── tests/
│   ├── unit/                            # 按模块镜像 src
│   │   ├── shared/  acp/  memory/  queue/  agents/
│   │   ├── daemon/  remi/  multiremi/
│   └── integration/                     # 跨模块 + e2e
│       ├── daemon-smoke/
│       ├── api-golden-snapshot/
│       └── e2e/
│
├── scripts/  docs/  bin/
```

## 2. 完整 path 映射

### L0 shared
| 现状 | → 新家 |
|---|---|
| `src/logger.ts` `config.ts` `tracing.ts` `version.ts` | `src/shared/` |
| `src/metrics/` `src/infra/` | `src/shared/` |
| `src/db/`（不含 PG 桥） | `src/shared/db/` |

### L1 积木块
| 现状 | → 新家 |
|---|---|
| `packages/acp-provider/src/*` + `src/providers/*` + `src/switch-mode.ts` | `src/acp/` |
| `src/memory/*` + `src/mcp/memory-server.ts` | `src/memory/` |
| `src/queue/*` | `src/queue/` |
| `src/agents/*` | `src/agents/` |
| `packages/feishu-channel/src/*` + `src/connectors/*` | `src/connectors/` |
| `src/auth/*` | `src/auth/` |

### L2 daemon
| 现状 | → 新家 |
|---|---|
| `src/core.ts`（编排部分） | `src/daemon/orchestrator.ts` |
| `src/multiremi/daemon.ts`（环境准备） | `src/daemon/agent-runtime/` 各能力目录 |
| `src/multiremi/repo-cache.ts` | `src/daemon/agent-runtime/repo/` |
| `src/multiremi/prompt.ts`（通用部分） | `src/daemon/agent-runtime/prompts/ephemeral.ts` |
| `src/plugins/config-hub/*` | `src/daemon/agent-runtime/` 各能力目录的 persistent |
| `src/plugins/registry.ts` + `sso/` | `src/daemon/agent-runtime/plugins/` |
| `src/multiremi/scheduler.ts` | `src/daemon/scheduler.ts` |
| `src/pm2.ts` | `src/daemon/pm2.ts` |

### L3 产品
| 现状 | → 新家 |
|---|---|
| `src/core.ts`（remi 特有） | `src/remi/` |
| `src/conversation/` `group/` `project/` `imaging/` | `src/remi/` |
| `web/server.ts` + `handlers/` + `auth.ts` + `remi-data.ts` | `src/remi/admin/` |
| `src/multiremi/store.ts` | `src/multiremi/store/` |
| `src/multiremi/api.ts` | `src/multiremi/api/` |
| `src/multiremi/types.ts` | `src/multiremi/contracts/` |
| `src/multiremi/daemon.ts`（执行逻辑） + `client.ts` + `task-failure.ts` | `src/multiremi/worker/` |
| `src/multiremi/sql-database.ts` + `pg-worker.ts` | `src/multiremi/store/db/` |
| `src/multiremi/builtin-skills.ts` | `src/multiremi/` setup/migration |
| `src/multiremi/skill-import.ts` | `src/daemon/agent-runtime/skills/` |
| `src/multiremi/agent-templates.ts` | `src/multiremi/api/` |
| `src/multiremi/dashboard.ts` | 删除（先迁 8 处断言） |
| `src/multiremi/config.ts` `ids.ts` `version.ts` `index.ts` | `src/multiremi/` 原位 |

### L4 界面 + 顶层
| 现状 | → 新家 |
|---|---|
| `src/cli/` | 原位 |
| `src/main.ts` `multiremi-main.ts` `index.ts` | 原位 |
| `web/frontend/` | `frontend/apps/console/(remi)/` |
| gitignore `multiremi/` | `frontend/` |
| `packages/acp-provider/` `feishu-channel/` | 合并进 src/,删除 |
| `packages/plugin-sdk/` | 保留 |
| `dist/` `log/` | 移出版本库 |

## 3. 分层规则

```
L0  shared         ← 不 import 任何人
L1  acp memory queue agents connectors auth  ← 只 import L0; L1 之间零依赖
L2  daemon         ← import L0 + L1
L3  remi multiremi ← import L0 + L1 + L2; 互不 import
L4  cli frontend   ← import 任何层
```

## 4. agent-runtime 双模式

按能力维度组织,每个能力内部分 persistent / ephemeral:

| 能力 | persistent（Remi 用） | ephemeral（Multiremi 用） |
|---|---|---|
| Skills | SSOT `~/.remi/skills/` + symlink | 从 DB → 写 `.claude/skills/` + prompt |
| MCP | 持久 `.mcp.json` 同步 | ACP `session/new` mcpServers 参数 |
| Prompts | CLAUDE.md/AGENTS.md managed block | 写文件 / prompt 注入 |
| Env | 进程 env | 进程 env |
| Workspace | 固定 cwd | per-task worktree + git exclude + GC |

注入底层统一走 ACP 官方协议 + Claude Code 文件系统约定 + 进程环境。

## 5. 数据库

- **shared/db/**: SQLite（remi + daemon 本地状态用）
- **multiremi/store/db/**: PostgreSQL（中心化平台,多 daemon 并发访问）
- daemon 不直连 PG,通过 HTTP 调 multiremi API
- 不再使用 cc-switch 品牌/DB名/路径

## 6. 前端

- `frontend/` 自包含 pnpm+turbo 工作区
- 一个 Next app(`apps/console`),入口页 → (remi) + (multiremi) 两个 route group
- 两后端只吐 JSON
- `packages/ui` 共享设计系统

## 7. 执行序列

| 步骤 | 做什么 | 验证 |
|---|---|---|
| D0 | tsconfig 别名 + check-layers.ts(WARN) + 基线 | bun test 不变 |
| D1 | `shared/` — 搬 L0 | 绿 |
| D2 | `acp/` — 合并 packages/acp-provider + src/providers | 绿 |
| D3 | `memory/` — 搬 src/memory + mcp/memory-server | 绿 |
| D4 | `queue/` `agents/` `auth/` — L1 归位 | 绿 |
| D5 | `connectors/` — 合并 packages/feishu-channel + src/connectors | 绿 |
| D6 | `daemon/` — orchestrator + agent-runtime + plugins + scheduler | 绿 |
| D7 | `remi/` — conversation/group/project/imaging + web→admin | 绿 |
| D8 | `multiremi/` — store/ api/ contracts/ worker/ + PG 归入 store/db/ | 绿 |
| D9 | 清理：改路径,删垫片,dist/log 移出 | 绿 + tsc |
| D10 | `tests/` 分 unit/integration | 绿 |
| D11 | `frontend/` 入库 | console 构建 + e2e |

## 8. 铁律

1. 每步 `bun test` pass 数不低于基线
2. 纯搬迁 ≠ 行为变更,git diff 每行是机械移动
3. 旧路径留 re-export 垫片
4. sqlite-custom 首加载顺序不可破
5. core.ts 拆分(D6)先写 characterization 测试
6. L1 积木块之间零依赖
7. 不再出现 cc-switch 命名
8. PG 相关代码只在 multiremi/store/db/ 内,不进 shared
9. packages/acp-provider 和 feishu-channel 合并进 src 后保持 re-export 兼容直到所有 import 迁完
