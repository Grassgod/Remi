# Remi × Multica 融合蓝图

> 把当前**分离**的 Remi 与 Multica 合成**一个统一项目**。治理原则:**删重复,不要两份并存**。同一问题两套实现时,指定一个 canonical,另一个删除——不包装、不并行适配。

## 0. 当前真实状态(摸清才好融合)

- **`src/multica/`** = Multica 后端的 **Bun/SQLite 重写版**,通过 `remi multica <serve|daemon|seed>` 子命令接入,是**独立两进程**(serve `:6130` API + daemon 轮询),但**共用 Remi 的 SQLite**(`store.ts` 调 `getDb()` = `~/.remi/remi.db`,44 张 `multica_*` 表)。`src/cli/serve.ts` 对 Multica **零引用**——主 daemon 根本不启动 Multica。
- **`multiremi/`** = 上游 Multimira 整个 monorepo(Next.js + Go/Postgres + server-bun),**未被 Remi 运行时引用**,只是 subtree 引入,**仅作参考**。
- 关键张力:UI 维度单独看会选 Next.js,但那需要 Postgres + Go + SSR,**直接违背单进程/单 SQLite**。本蓝图按"四票对一票 + 你要的单进程"原则裁决:**canonical 运行时 = Bun + SQLite + Hono + React/Vite SPA;`multiremi` 降级为纯参考(数据模型规格 + 可摘取的 React 视图组件),永不作为运行时依赖。**

## 1. 目标系统形态(canonical 选择)

| 关注点 | Canonical | 理由 |
|---|---|---|
| **进程** | **一个 `remi serve`**:Multica API、scheduler、in-process loopback daemon 都在里面启动;保留 loopback HTTP claim API 以便远程 runtime 接入 | 唯一拦路的只是 CLI 拆分;`store.ts` 已用共享 `getDb()` |
| **数据库** | **一个 SQLite `~/.remi/remi.db`**;cc-switch.db 被吸收 | `multica_*` 表已在里面;**不迁 Postgres** |
| **Web 服务** | **一个 Hono `:6120`**;Multica 的 `:6130` app 作为子路由 `mount` 进来 | 两边都是 Hono-on-Bun |
| **UI** | **一个 React 19 + Vite SPA**(Hono 托管);两个 Multica 前端都删,Next.js 的 `@multimira/views` 组件**作为源码摘取** | 保单进程/单端口 |
| **Agent 运行时** | **一个 `AcpProvider`**,交互聊天与任务执行共用 | 已共用 |
| **Scheduler** | BunQueue cron 为主,`MulticaScheduler`(croner)同进程运行;合并为可选后续 | 同进程两个 scheduler 可接受 |

**目标进程图:**
```
remi serve  (单 Bun 进程, :6120)
├── Remi hub (core.ts)        — Feishu → AcpProvider → reply
├── BunQueue workers          — conversation / memory / cron
├── Hono app (web/server.ts)
│   ├── /api/v1/*             — Remi 运维 API
│   ├── /api/multica/*        — 挂载 createMulticaApp()(原 :6130)
│   └── /                     — React SPA
├── MulticaScheduler          — croner autopilots, 进程内
├── Multica task store        — multica_* 表 @ ~/.remi/remi.db
└── in-process loopback daemon — runAgentInline() 跑任务(远程 daemon 仍可接入)
```
`multiremi/` 保留为 subtree 参考,**永不被 `src/` import、永不运行时启动**。

## 2. 五大维度融合

### 2.1 Agent 管理 —— canonical: Multica DB 模型;**删 `src/agents/*`**
Remi 是 3 个硬编码 TS map(改代码才能加),Multica 是 `multica_agents` 表 + 运行时 CRUD + 25 模板,**严格超集**。
- **唯一关键改动**:Multica 没有进程内运行路径(`runAgent` 私有且焊死在 `this.client`+轮询)。**抽出 `runAgentInline(agent, prompt, {cwd, signal}) → RunSummary`**(`daemon.ts:106-165` 里只保留 AcpProvider 构造 + sendStream 循环,无 client/无轮询)。
- 把 memory-extract/memory-audit/wiki-curate **seed 成 `multica_agents` 行**(CLAUDE.md→instructions,skills→multica_skills);`memory.ts`/`cron-bridge.ts` 改调 `runAgentInline`(保同步输出 + exit-code gate + 飞书汇报)。
- 词汇映射:`haiku/opus`→完整 model id;`--dangerously-skip-permissions`→`allowedTools`;`mcp:boolean`→`mcpConfig`。
- **删**:`src/agents/{registry,runner,types,index}.ts`、磁盘 `agents/{name}/`、`web/handlers/agents.ts`、JSONL 日志。**Effort: L**

### 2.2 Skill 管理 —— canonical: Multica DB;Remi 两套 skill 系统降为投影
Remi 有**两套互不集成**的 skill(config-hub 跨工具安装器 + web 文件浏览器),Multica 以 DB 行为真值、磁盘为渲染产物——且**桥已存在**:`writeAgentSkillContext`(`daemon.ts:199`)已能把 DB skill 落成 `.claude/skills/<name>/SKILL.md`。
- DB CRUD + URL-import 成为唯一创建路径(`skill-import.ts` 已记 provenance)。
- 把 `writeAgentSkillContext` 泛化成 `materializeSkillToDir`,喂给 config-hub 现有的跨工具 symlink 同步(**同步引擎保留,真值改成 DB**)。
- **⚠️ 硬前置(R4)**:Multica DB 存文件为 text、跳过二进制(1MB/8MB/128 上限)。Remi skill 目录有任意二进制。**先给 `multica_skill_files` 加 blob 列或"二进制留磁盘按路径引用"逃生口,否则迁移会静默丢二进制。** **Effort: L**(+ 二进制决策为硬前置)

### 2.3 MCP 管理 —— canonical: 混合(Multica 按 agent 选择为脊,Remi config-hub 提升为共享 catalog)
两边最终都产出同一个 stdio MCP server 列表给 ACP。Remi 按**工具**开关,Multica 按 **agent** 开关——多 agent 场景 Remi 表达不了,**按 agent 隔离必须赢**。
- **⚠️ 必修**:`agent.mcpConfig` 在 Bun 重写版里是**死的**——`daemon.ts:123` 构造 AcpProvider 时**根本没传 mcpServers**。把 `agent.mcpConfig` 接进 `getMcpServers` 钩子。
- config-hub 的 `mcp_servers` 表升级为 workspace catalog(库),agent 的 `mcp_config` 引用 catalog 条目。
- **memory MCP 成为内置 catalog 条目**(`bun run src/mcp/memory-server.ts`),默认给有记忆能力的 agent 开 → 任务 agent 获得 `recall`/`remember`/`backlinks`。
- **删**:`web/handlers/mcp.ts` 原始文件面、`config_hub_project_mcp` 空表。**Effort: L**

### 2.4 Memory & Wiki —— canonical: Remi 的,不动;Multica 零拥有;**不删任何东西**
Multica 完全没有 memory/wiki 概念(grep 零命中)。这不是合并,是单向能力赋予。
- UI:把 Remi 现有 Memory + Wiki 页接进统一导航(后端不动)。
- **Agent 访问(高价值)**:走**已存在但当前被丢弃**的 MCP 路径——在 `daemon.ts:123` 的 `getMcpServers` 钩子注入 `remi-memory` stdio server + `allowedTools` 加 `mcp__remi-memory__*`。**MemoryStore/MCP server 零改动**(和 2.3 第一步是同一个接线活,一起做)。
- 优先 MCP 而非直接 FS(cron memory agent 硬编码了 `~/.remi/memory` 单用户路径,撑不住 Multica 多租户)。**Effort: M**

### 2.5 管理 UI —— canonical: React+Vite SPA(Hono 托管);两个 Multica 前端都删,Next.js 视图组件摘取
**此处推翻 UI 调研的 Next.js 建议**——它单看 UI 对,但需要 Go/Postgres + SSR,**违背单进程/单库**。系统形态必须压倒 UI 选择。
- **删** `src/multica/dashboard.ts`(~238KB 内联 HTML 串)+ `multiremi/apps/web` 作为运行时。**摘取 `@multimira/views`**(agents/skills/runtimes/squads/members/autopilots/projects/issues/inbox/usage/settings)端口进 `web/frontend/src/pages/`,打 `/api/multica/*`。
- 4 个重叠名词(Agents/Skills/MCP/Projects)以 Multica schema 为准融合,Remi 专属页(Memory/Wiki/Prompts/Providers/Scheduler/Traces/Logs/Conversations/Database/Bot Menu/Mission Board)保留为 workspace 管理段。
- **租户**:引入单一默认 workspace `'local'`,让 Multica 页单租户渲染,多租户维度**潜伏**在 schema 里(以后再用,现在不付成本)。**Effort: XL**(全程真正的长杆)

## 3. 最大冲突与化解

| # | 冲突 | 化解 |
|---|---|---|
| R1 | 存储引擎分裂(multiremi=Postgres vs Remi=SQLite) | **SQLite 赢,multiremi 仅参考**;multiremi 的 Postgres schema 当作 `src/multica` SQLite 实现的**规格** |
| R2 | 进程模型(client/server vs 单 hub) | Multica API 挂 loopback + 进程内单 daemon;**保留 HTTP claim API** 让远程 runtime 仍可接入 |
| R3 | Multica 无进程内运行路径 | **抽 `runAgentInline`——全程最高杠杆的重构**,解锁 agent 融合 + memory-MCP + 删 AgentRunner。**先做** |
| R4 | 二进制/大 skill 文件被丢 | **硬前置门**:迁移前给 `multica_skill_files` 加 blob/大文件路径,否则静默损坏 |
| R5 | 多租户 vs 单用户 | 折叠为单一默认 `'local'` workspace,租户表潜伏;memory/wiki 明确单租户 |
| R6 | 三个 scheduler | 短期同进程跑 BunQueue+MulticaScheduler,删 Go 那个;合并为可选后续 |
| R7 | 漂移的 ACP fork(multiremi/server-bun) | **忽略/删 fork**,`src/providers/acp` 是唯一 canonical |

## 4. 分阶段路线(每阶段独立可发布)

| 阶段 | 范围 | 交付 | Effort |
|---|---|---|---|
| **P0 单进程/单服务** | 把 `createMulticaApp()` 挂到 `web/server.ts` 的 `/api/multica/*`;在 `runServe` 里启动 `MulticaScheduler` + 进程内 loopback daemon;保留 loopback claim API。`remi multica serve` 变成 `--standalone` flag | 一进程一端口一库,行为不变 | **M** |
| **P1 抽 `runAgentInline`** | 从 `daemon.runAgent` 抽出进程内运行路径,`runAgent` 变薄封装(R3) | 解锁后续,无可见变化 | **M** |
| **P2 memory MCP 进任务 agent** | 把 `agent.mcpConfig` + 内置 `remi-memory` 接进 `daemon.ts:123` 的 `getMcpServers` | 任务 agent 获得 recall/remember/backlinks,高价值低成本 | **M** |
| **P3 Agent registry 融合** | seed 3 个 Remi agent 进 `multica_agents`;callers 改调 `runAgentInline`;**删 `src/agents/*` + `web/handlers/agents.ts` + 磁盘 agent 目录** | 一个 agent registry + 运行时 CRUD + 25 模板 | **L** |
| **P4 Skill registry 融合** | (R4 门后)泛化 materializer 喂 config-hub 同步;磁盘 skill 迁入 `multica_skills`;web Skills 页改 DB;**删 cc-switch.db skills 表 + SSOT + RemiData fs 读路径** | 一个 skill 真值,URL-import + 跨工具同步都留 | **L** |
| **P5 MCP catalog 融合** | config-hub `mcp_servers` 升级 workspace catalog;agent 引用条目;加 redaction;**删 `web/handlers/mcp.ts` 原始文件面** | 一个 MCP catalog + 按 agent 选择 | **L** |
| **P6 UI 统一** | 摘取 `@multimira/views` 进 `web/frontend`;4 名词以 Multica schema 融合;Remi 专属页保留;**删 `dashboard.ts` + `multiremi/apps/web` 运行时 + 退役 Remi 页** | 一个 SPA,单默认 workspace,完整产品面 | **XL** |
| **P7(可选)scheduler 合并** | 把 autopilot 折进 BunQueue cron | 一个 scheduler | M |

## 5. 先做什么

**P0 → P1,按此序,任何删除之前。**

1. **P0 先**:让系统变成**一进程一服务**,**零删除零行为变化**,纯加性接线(`mount createMulticaApp` 进 `web/server.ts`;`serve.ts` 里起 `MulticaScheduler`+loopback daemon)。最低风险、最高结构收益、易回滚。直接消灭"`serve.ts` 对 Multica 零引用"。
2. **P1(`runAgentInline`)紧随**:keystone(R3),解锁 P2/P3 与删 `runner.ts`。

**别先碰 Skill(P4)**——卡在 R4 二进制决策,操之过急会静默损坏。**别先碰 UI(P6)**——XL 长杆,依赖 P3-P5 的 schema 融合先落地。

**第一个提交**:`src/cli/serve.ts` 里 `Remi.boot()` 之后,import 并 mount `createMulticaApp` 到现有 Hono app,启动 `MulticaScheduler` + 进程内 loopback `MulticaDaemon`。一进程、一库、一端口——其余随之。
