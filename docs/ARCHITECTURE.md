# Remi × Multiremi —— 分层架构与目录体系

> 目标:一套**人和 AI agent 都能快速定位、安全修改、独立验证**的代码分层。
> 配套 [`FUSION.md`](./FUSION.md)(品牌/实现统一目标)与 [`MULTIREMI_PARITY_MATRIX.md`](./MULTIREMI_PARITY_MATRIX.md)(后端能力对标)。
> 本文档由全仓扫描(7 区域测绘 + 架构 + 对抗式评审)综合得出,已并入评审发现的修正。

---

## 1. 现状诊断(诚实版)

仓库融合了两个产品:**Remi**(个人助理:memory + Feishu + Claude Code)和 **Multiremi**(类 Linear 任务管理,正用 Bun 原生重写)。核心 hub-and-spoke(`core.ts` 在 connectors↔providers 间路由)是清晰的;**乱主要集中在后端内部,不在边界**。量化:

| 文件 | 行数 | 问题 |
|---|---|---|
| `src/multiremi/store.ts` | 10,704 | 上帝对象:277 公有方法 + ~713 处内部 `this.` 互调 + 共享可变状态(listener Sets / metric Map)|
| `src/multiremi/api.ts` | 9,139 | 489 路由内联;`/api/*` 与 `/api/multiremi/*` 双前缀,其中 **34 条 compat 路由行为不同**(不是单纯重复)|
| `src/multiremi/dashboard.ts` | 5,132 | 手写 HTML 内置看板,与真前端职责重叠 |
| `src/core.ts` | 1,163 | 助理 hub 上帝对象(路由/会话/命令/恢复混在一起)|
| `tests/multiremi-core.test.ts` | 11,466 | 单文件测试巨石(827 处 `app.request`)|
| `src/cli/multiremi.ts` | 1,991 | 解析 + 业务逻辑混杂 |
| `packages/feishu-channel/src/streaming.ts` | 1,387 | 卡片渲染/状态同步/转录映射混在一起 |

其它结构性债务:
- **前端无家可归**:真正在用的 Next.js 漂亮 UI 在 **gitignore 的 `multiremi/` 运行时副本**里(CI 看不见,改动不入库)。同时还存在 `web/frontend`(Vite SPA,已跟踪)和 `dashboard.ts`——**三套 UI 干一件事**。
- **命名残留**:`multica`/`Multimira`(gitignore 前端里 ~144 文件含 `multimira`)。
- **PG 桥**:`sql-database.ts` 用 Worker+SharedArrayBuffer+Atomics 把异步 Postgres 同步化 + 正则翻译 SQL 方言,**CI 未覆盖**。
- **跨树泄漏**:`src/multiremi/builtin-skills.ts` 直接读 `pipeline/skills/*`(评审发现,层模型必须显式纳入)。

---

## 2. 设计原则

1. **依赖单向向下**,且**可被 lint 强制**(不是口号)。
2. **同一 feature 词跨层同名** —— agent 靠文件名定位,无需 grep。
3. **业务逻辑下沉到能拥有它的最低层**;route/CLI 只是适配器。
4. **一处翻译**:所有 snake/camel + Go-compat 序列化集中在 `contracts/wire.ts`。
5. **文件预算**:目标 <500 行,硬顶 800(旧巨石只准拆、不准加)。
6. **测试镜像源码**,且每层能**单独验证**(改 L2 跑该域单测,不必起 e2e)。
7. **gitignore 的代码不算"家"**:产品依赖的东西必须入库 + 进 CI。
8. **每次重构提交保持 `bun test` 绿**,纯搬迁与行为变更分开提交。

---

## 3. 分层模型(依赖只能向下)

| 层 | 目录 | 职责 | 可依赖 | 怎么测 |
|---|---|---|---|---|
| **L0 共享原语** | `src/shared/` | logger、ids、db(sqlite)、`sql-database`+`pg-worker`(PG 桥)、version、tracing | 无(纯基础设施) | 纯函数单测;**PG 桥契约测试(SQLite vs 真 PG 同一批 query)必须是 CI 硬门禁** |
| **L1 契约** | `src/multiremi/contracts/` | 按域拆的 types + **唯一序列化器 `wire.ts`**(native 与 compat 两个 shaper) | L0 | round-trip 单测 + schema-drift(喂坏数据走 parseWithFallback)|
| **L2 数据/Store** | `src/multiremi/store/` | 按域拆的 store 模块 + `StoreContext`(db+事件发射器+listener) + `schema.ts`(DDL) | L0,L1 | `new MultiremiStore(db)` + `:memory:`,每文件独立、各自 fresh DB |
| **L3 服务/领域** | `src/multiremi/service/` | 用例编排:组合 store、发事件、经接口调 provider | L0,L1,L2,L5(接口) | 用例单测,mock provider/connector |
| **L4 传输/适配** | `src/multiremi/api/`(Hono 按域 router)、`src/cli/` | HTTP 路由(native+compat 经 wire.ts)、CLI 薄分发 | L0–L3 | `createMultiremiApp({store})` + `app.request()`,无 socket/子进程 |
| **L4 守护/运行时** | `src/multiremi/daemon/` | daemon、scheduler、client、repo-cache、task-failure、prompt | L0–L3,L5 | daemon-once smoke |
| **L5 Provider** | `packages/acp-provider`(canonical)、`src/providers/*`(re-export 垫片) | Claude/Codex ACP | L0 | provider 构造/health 单测 + ACP smoke |
| **L6 前端** | `apps/<console>`(**唯一一套,待定**) | Web UI | 只经 HTTP 调 L4 | Playwright e2e against 真后端 |

**Remi 助理侧**(与 multiremi 平级的产品,共享 L0/L1):`src/assistant/`
`core/{routing,session,commands,recovery}`(拆自 core.ts)、`memory`、`conversation`、`mission`、`project`、`group`、`agents`、`queue`;`src/connectors/`(Feishu 适配)。
**硬规则:`src/multiremi/*` 与 `src/assistant/*` 互不 import 对方 L2+,只共享 L0/L1。**

---

## 4. 目标目录树

```text
src/
├─ shared/                      # L0 logger ids db sql-database pg-worker version tracing
├─ multiremi/                   # 任务管理产品(后端)
│  ├─ contracts/                # L1 types/*.ts + wire.ts(唯一序列化:native + compat)
│  ├─ store/                    # L2 context.ts schema.ts events.ts + 按域: agents/issues/tasks-runtimes/projects/workspace-auth/automation/chat/attachments/analytics.ts + index.ts(facade,保 `new MultiremiStore(db)` 不变)
│  ├─ service/                  # L3 用例编排
│  ├─ api/                      # L4 server.ts + routers/*.ts(Hono app.route,native+compat)
│  ├─ daemon/                   # L4 daemon client scheduler repo-cache task-failure prompt
│  ├─ skills/                   # builtin-skills skill-import agent-templates
│  └─ index.ts
├─ assistant/                   # 个人助理产品
│  ├─ core/                     # routing session commands recovery(拆自 core.ts)
│  ├─ memory/ conversation/ mission/ project/ group/ agents/
│  └─ queue/handlers/{conversation,memory,cron,mission}.ts(拆自 cron-bridge)
├─ connectors/                  # L4 feishu 适配
├─ providers/                   # L5 packages/acp-provider 的 re-export 垫片
├─ plugins/ infra/ metrics/ imaging/ auth/   # 跨产品插件/基础设施
├─ cli/                         # L4 薄解析+分发
└─ main.ts  multiremi-main.ts   # 两个入口

packages/  acp-provider(canonical) feishu-channel(streaming/ 拆分) plugin-sdk
apps/      <console>            # L6 唯一一套被跟踪的前端(待决策)
tests/     multiremi/{store-*,api-*}.test.ts  contracts/*  assistant/*  e2e/  helpers.ts
scripts/   docs/
```

---

## 5. 现状 → 新家(关键映射)

| 现状 | 去向 | 关键说明 |
|---|---|---|
| `store.ts`(10.7k) | `store/<域>.ts` + `store/index.ts` facade + `store/schema.ts` | 按已验证的 9 个域簇拆;**先抽 `StoreContext`(db+events+listeners)再拆**;facade 保签名→273 处调用点零改 |
| `api.ts`(9.1k) | `api/server.ts` + `api/routers/<域>.ts` | Hono `app.route()` 挂载;**34 条 compat 路由是"行为不同的一等公民",经 wire.ts 双 shaper,不可合并删除** |
| `types.ts`(snake+camel 混) | `contracts/types/*` + `contracts/wire.ts` | 内部统一 camelCase,snake_case 只在 wire 边缘 |
| `dashboard.ts`(5.1k) | 选定前端后**删/缩**(见待决策) | 选定 SPA 前作零依赖本地兜底 |
| `core.ts`(1.1k) | `assistant/core/{routing,session,commands,recovery}` | 拆前**先写 characterization 测试**锁住现有行为(恢复逻辑脆弱)|
| `queue/handlers/cron-bridge.ts`(774) | `assistant/queue/handlers/*`(每任务一文件) | |
| `cli/multiremi.ts`(1991) | 保留薄解析;业务 helper 下沉到 daemon/service | 测试改从新位置 import |
| `packages/feishu-channel/streaming.ts`(1.4k) | `streaming/{card-render,state-sync,transcript-map,acp-adapter}` | |
| `multiremi/apps/web`+`packages/{core,ui,views}`(gitignore) | **待决策**:提升为 `apps/console`(入库)或删 | 最高优先级债务:CI 看不见 |
| `web/`(Vite SPA + `remi-data.ts` 2.1k,已跟踪,含提交的 `dist/`) | **待决策**:作助理仪表盘留存或删 | `dist/` 不该入库 |
| `tests/multiremi-core.test.ts`(11.4k) | `tests/multiremi/{store-*,api-*}.test.ts` + `tests/contracts/*` | 抽公共 fixture 到 `helpers.ts`;每文件独立 `:memory:` DB |

---

## 6. 人 & Agent 协作规则(可执行)

1. **依赖方向(硬规则 + lint)**:import 只能向下。`src/multiremi/*` 永不 import `src/assistant/*`/`connectors`/`mission`。**先用 `scripts/check-layers.ts` 跑出真实 import 图**(评审发现 `pipeline/skills` 是真实跨树边——必须显式归类,否则 lint 是摆设),CI 先 WARN、迁移末期转 ERROR。
2. **X 住哪(定位规则)**:`<feature>.<layer>`。改 issues 的数据访问 → `store/issues.ts`;改 issues 的路由 → `api/routers/issues.ts`;改 issues 的类型 → `contracts/types/issues.ts`。同一词跨层,agent 凭名定位。
3. **新代码进能拥有它的最低层**。想往 `api.ts` 加 SQL?停——它属于 `store/`。
4. **一处序列化**:所有 snake↔camel / Go-wire 翻译只在 `contracts/wire.ts`。改字段=改一处。
5. **文件预算** <500/硬顶 800;旧巨石只拆不加。
6. **唯一实现**:provider 只在 `packages/acp-provider`(`src/providers/*` 是垫片,别 fork);后端只在 `src/multiremi`;前端定案后 `apps/` 只留一套,其余删不留。
7. **测试镜像源码 + 单层可验证**:改 `store/issues.ts` → `tests/multiremi/store-issues.test.ts`(`:memory:`,不起服务);改路由 → `api-*.test.ts`(`app.request`)。**改 L2 跑该域单测,几乎永远不需要 e2e 验证局部改动。**
8. **不许新增 `multica`/`Multimira`**;旧名只在明确标注的 migration 块里识别。
9. **gitignore 不是家**:产品依赖的代码必须入库 + 进 CI 才能继续在其上开发。

---

## 7. 测试策略(四层,各自独立可验)

- **① 单元**(快,最多 `:memory:` SQLite):按域 store 模块、纯工具(ids/wire/task-failure)、助理域模块。每个拆出的文件配一个从巨石碾出的兄弟测试,**各自 fresh DB + teardown**(否则合跑过、单跑挂)。
- **② 契约(层缝,收益最高)**:`wire.ts` round-trip;schema-drift(坏数据走 parseWithFallback);**parity-matrix 测试**(每个 Go 参考端点都有活的 Bun 路由,掉一个 CI 红);**PG 桥契约**(SQLite vs 真 PG 同一批 query——必须硬门禁,否则方言漂移无人察觉);**34 条 compat 路由的 golden 快照**(改 api 前先把现有字节快照下来,改完逐字节比对,防止 compat 行为悄悄变)。
- **③ HTTP/服务**(无 socket/子进程):`createMultiremiApp({store})` + `app.request()` 按 router 测;用例测 mock provider/connector。
- **④ e2e/smoke**(慢,门禁式):`e2e-multiremi.ts`、`e2e-frontend-ours.ts`、`smoke-multiremi-acp.ts`、daemon-smoke。
- **CI 门禁**:每 PR 跑 ①②③ + 层 lint;e2e/smoke 在 release tag 跑。

---

## 8. 迁移路线(增量、每步保绿;已并入评审修正)

| 阶段 | 动作 | 风险 | 验证 |
|---|---|---|---|
| **P0 铺骨架不搬逻辑** | 建目标目录 + tsconfig 路径别名;加 `scripts/check-layers.ts`(**先跑真实 import 图**,WARN 模式);建 parity-matrix 骨架 | 近零 | `bun test` 不变绿;lint 报当前违规为警告 |
| **P1 抽 L0 共享** | logger/version/ids/db/sql-database/pg-worker 移入 `src/shared`,旧路径留 re-export 垫片;**加 PG 桥契约测试并设为门禁** | 低(垫片保 import) | 绿 + PG 桥测试过 |
| **P2 拆 store(facade 后)** | **先抽 `StoreContext`(db+events+listeners)**,再按域搬,`store/index.ts` 保 `new MultiremiStore(db)` 不变;**最耦合的 Tasks/Runtimes 放最后**,Analytics/Chat 等先行;每域搬完碾出对应测试 | 中(类大;每 PR 一域) | 每 PR 后绿;碾出的域测试 `:memory:` 独立过 |
| **P3 拆 api → router** | handler 进 `api/routers/*`,`app.route()` 挂载;引入 `wire.ts` 双 shaper;**compat 当作保留的一等差异**(先 golden 快照,再搬,逐字节比对——不合并删除) | 中(compat 偏移) | 按 router HTTP 测 + golden 快照不变 + parity-matrix 不掉端点 |
| **P4 拆 core/cron/streaming/cli** | core.ts→assistant/core/*(**先写 characterization 测试**);cron-bridge→每任务一文件;streaming 拆;cli 薄化 | core.ts 中高(恢复逻辑脆) | 新 characterization 测试搬前后都过 |
| **P4.5 后端冻结点** | 确保 P0–P4 在**不动现有三套前端**下全部可发布、全绿 | — | 后端独立于前端决策可交付 |
| **P5 前端定案(需人决策)** | 选定唯一 UI → 入库 `apps/console`(一次性 `multimira→multiremi` 改名)→ 删另两套 → 接 CI build + Playwright | 产品风险高、技术风险低 | 前端进 CI 构建;e2e 绿;gitignore 不再藏产品码 |
| **P6 品牌 + 死码清扫** | 清 `multica`/`Multimira` 残留;未用导出检测;层 lint 转 ERROR | 低 | 绿;grep 仅剩标注的 migration 码 |

---

## 9. 待决策项(需要人拍板,挡住相应阶段)

1. **前端归宿(#1 决策)**:三套 UI 干一件事(`dashboard.ts` 已跟踪 / `web/frontend` 已跟踪 / Next.js console gitignore 未入 CI)。选一套删其余。倾向:把最完整的 Next.js console 提升入库——但代价是把 Next.js+pnpm 工具链引进 Bun 仓库,需确认团队接受这份长期构建复杂度。**(此决策不应阻塞 P0–P4 后端重构。)**
2. **Remi vs Multiremi 主从**:一个产品(助理+任务管理作模块)还是两个产品共享库?决定 `src/assistant` 与 `src/multiremi` 是平级共享 L0/L1,还是 multiremi 最终独立成包。当前树假设"两产品一仓共享基座"。
3. **Postgres 地位**:SAB+Atomics 同步桥是生产支持路径还是实验?现 CI 只测 SQLite。要么把 PG 桥契约测试设硬门禁,要么标实验、停止实时翻译 SQL 方言。
4. **内置看板取舍**:选定 SPA 后,是否保留 `dashboard.ts` 作零依赖本地 daemon 兜底,还是删。
5. **CLI 形态**:`multiremi` 与 `remi` 是两个二进制,还是 `multiremi` 收编为子命令。
6. **wire 规范大小写**:内部统一 camelCase、snake_case 只在 wire 边缘(推荐),以便彻底删掉 types.ts 的双字段而非永久保留。
