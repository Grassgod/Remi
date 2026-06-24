# 后端上帝文件拆分方案(store.ts / api.ts / types / tests)

> 配套 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的具体执行版。基于对 `store.ts`(10704)、`api.ts`(9139)、`types.ts`(1868)、`tests/multiremi-core.test.ts`(11466)的方法/路由级测绘。
> 由 workflow(store/api/aux 三路精测 + 综合 + 修正)产出。

## 0. 前提与铁律

- **基线已绿**:`bun test tests/multiremi-core.test.ts` = **142 pass / 0 fail**(此前我引入的 member email 泄漏已修,`6036ed4d`)。每个 PR 的验收 = **pass 数不降、fail 数不增**。
- **纯搬迁 ≠ 行为变更**:facade/垫片/router 搬迁与任何行为改动**分开提交**。一个"搬迁"PR 的 `git diff` 必须每行都是机械移动/委托。
- **公共面零变**:`createMultiremiApp`、`startMultiremiServer`、`MultiremiStore` 公共方法、`index.ts` 导出保持不变 → `api.ts` 变成对 `server.ts` 的 re-export,`types.ts` 变成 barrel。约 **248 个 `store.*` 调用点 + 测试文件零改**。
- **每个新文件配一个兄弟 `:memory:` 测试**,与新文件同 PR。

## 1. store.ts 怎么拆(最关键)

**10 个域**(方法数 / 耦合):

| 域 | 目标文件 | 方法 | 耦合 | 依赖 |
|---|---|---|---|---|
| attachments | `store/attachments.ts` | 4 | 低 | — |
| analytics_metrics | `store/analytics-metrics.ts` | 8 | 低 | — |
| auth_tokens | `store/auth-tokens.ts` | 9 | 低 | workspace |
| workspace | `store/workspace.ts` | 32 | 中 | analytics |
| projects(含 squads/pins) | `store/projects.ts` | 22 | 中 | workspace, analytics |
| agents_skills | `store/agents-skills.ts` | 36 | 中 | workspace, analytics |
| runtimes | `store/runtimes.ts` | 26 | 高 | agents, tasks, workspace, analytics |
| issues(含 comments/labels) | `store/issues.ts` | 57 | 高 | attachments, projects, workspace, analytics |
| autopilots(含 webhooks) | `store/autopilots.ts` | 21 | 高 | issues, workspace, analytics |
| tasks_chat | `store/tasks-chat.ts` | 31 | 高 | issues, runtimes, workspace, autopilots, analytics |

**拆法(顺序是硬约束):**

1. **先抽 `StoreContext`(`store/context.ts`)** —— 不搬任何方法,只把多域共享的东西显式化:
   - 共享状态:`db`、`taskEnqueuedListeners`/`taskEventListeners`/`workspaceEventListeners`(三个 Set,行 312-314)、`analyticsEvents[]`(315)、`metricCounters` Map(316)。
   - 跨域私有 helper:`notifyTaskEnqueued`(8130)、`notifyTaskEvent`(8140,7 处)、`emitWorkspaceEvent`、`recordAnalyticsEvent`(5614,9 处)、`incrementMetricCounter`(5696,10 处)、`appendIssueActivity`(5175,**21 处**)、`createInboxItem`(7434)、`emitChatEvent`(354)、`ensureIssueSubscriberTypedSchema`(7980)。
   - **不先抽这步,后面每个域搬走后都会留下悬空的 `this.helper`。** 这步是承重墙,不是风格。
2. **抽 `store/schema.ts`**:把 `migrate()`(418-1290)的所有 CREATE TABLE/INDEX + 三个遗留迁移(`ensureIssueSubscriberTypedSchema` 7980、`ensureInboxGenericSchema` 8025、`renameLegacyMulticaObjects` 396)搬进去,导出 `ensureMigrations(db)`,`migrate()` 变成一行调用。**这三个遗留迁移必须每次启动都跑**(`8f20d1c8` 证明丢了会让旧库升级崩)。schema **不按域再拆**(DDL 相互依赖,一个文件更简单)。
3. **按 carve order 逐域搬**(每域一个 PR):`attachments → analytics_metrics → auth_tokens → workspace → projects → agents_skills → runtimes → issues → autopilots → tasks_chat`。每个域变成 `class XStore { constructor(private ctx: StoreContext) {} }`,方法**逐字搬**(`this.db`→`this.ctx.db`,`this.recordAnalyticsEvent`→`this.ctx.recordAnalyticsEvent`)。facade `MultiremiStore` 持有各域实例,每个公共方法一行委托:`createIssue(...a){return this.issues.createIssue(...a)}`。
4. **循环依赖用懒 getter 解**(不是构造器注入,否则 carve 顺序死锁):`tasks↔issues`(`enqueueChildDoneParentTask` 4158 / `notifyParentOfChildDone` 4084)、`tasks↔autopilots`、`runtimes↔tasks`。ctx 提供 `getTasksStore()` 在调用时解析。**tasks_chat 和 runtimes 最后拆**(耦合最高)。

## 2. api.ts 怎么拆

1. **先抽 `api/wire.ts`** —— 把 **45 个 `*CompatibilityResponse` + native `*Response`** 序列化器全搬进去。**compat 是要保留的一等差异,不是重复**(评审实证:34+ 路由行为不同 —— compat 只读 snake_case,native 读两种;compat 走 `issueCompatibilityResponse` 等不同 shaper)。**绝不合并两个前缀的 handler**。
2. **搬 router 前先打 golden 快照**:`scripts/snapshot-api-routes.ts` 启动 `createMultiremiApp` over 种子 `:memory:` store,对**两个前缀**(`/api/multiremi/*` 与 `/api/*` compat)每个路由族录下 body+status,提交。之后每个 router 搬迁 PR 必须快照**逐字节不变**。
3. **`api/server.ts` 骨架**:`new Hono` + cors + auth/onError 中间件(253-298)+ daemon 前缀中间件(423-457)+ health/readyz/config + 一串 `register*Routes(app, store)` 调用。**WebSocket 升级(`/ws` 502、`/api/daemon/ws` 497、`/api/realtime/ws` 507)留在 server 骨架**,不能进域 router、不能排在 error handler 后(否则 101 Upgrade 变 401)。
4. **每域一个 `api/routers/<domain>.ts`**,`register<Domain>Routes(app, store)` 里**把 native 和 compat 两条路由并排放在同一文件**(差异可见、可 diff;不用 AUX 建议的 multiremi/ vs compat/ 双目录树)。搬迁顺序由轻到重:attachments/labels/pins/projects/squads/comments/chat/inbox/workspaces/invitations/auth/github/dashboard-data → agents/skills/autopilots → **issues(80)/runtimes(50)/daemon(40)/autopilots(40) 最后**。
5. `api.ts` 变成 `server.ts` 的 re-export(`index.ts` 与测试 import 不动)。

## 3. types / tests / dashboard / shared

- **types.ts → `contracts/types/<domain>.ts`**(daemon/issue/workspace/autopilot/agent/chat/task/project/squad/analytics/github/token/feedback,13 个)+ `types.ts` 变 barrel(`export *`)。**纯搬,放在 store+api 之后做**。snake/camel 双字段的 `wire.ts` 归一化是**行为变更**,除非有具体 bug 否则不做。
- **tests 拆**:建 `tests/multiremi/helpers.ts`(`createStore()=new Database(':memory:')`、`signTestJwt`、`mockFetch`、WS 辅助等);把 11466 行按域 carve 成 `tests/multiremi/{daemon-runtime,api-issue,api-agent,api-task,api-autopilot,api-workspace,api-project,api-squad,api-chat,api-attachment,store-mutations}.test.ts`,**每个 `it()` fresh `:memory:` + afterEach 关库**(否则合跑过、单跑挂)。每 PR 后断言总用例数不降。
- **dashboard.ts 不能直接删!**(AUX map 说错了)`tests/multiremi-core.test.ts:9` import 了 `renderMultiremiDashboardHtml` 并断言 8 次(3663-3735)。删它会**直接编译失败**。处理:这是**产品决策**(是否保留零依赖内置看板),且要先迁移那 8 处断言,排到最后、独立 PR。
- **L0 `src/shared` 暂不做**:实测只有 `logger` 真共享(已在 `src/logger.ts`);`ids/sql-database/pg-worker` 用 Multiremi 专有前缀/schema,留原地。为一个文件建目录是过度抽象——跳过。

## 4. PR 序列(每个独立可发、保持 142/0)

| PR | 做什么 | 验证 |
|---|---|---|
| **基线** | 记录 `bun test` 基线计数(142/0);写 `scripts/snapshot-api-routes.ts` 打 golden 快照并提交 | 快照生成 |
| **S1** | `store/context.ts`:建 StoreContext,构造器里组装 ctx,绑定所有跨域 helper(**不搬方法**)| 全绿 + `store/context.test.ts` |
| **S2** | `store/schema.ts`:抽 DDL + 3 个遗留迁移;`migrate()` 变一行 | 全绿 + `schema.test.ts`(建表 + 幂等)|
| **S3–S12** | 按 carve order 逐域搬(每域一 PR,facade 委托;tasks_chat/runtimes 最后,循环依赖用懒 getter)| 每 PR 全绿 + 该域 `store/<domain>.test.ts` 独立过 |
| **A1** | `api/wire.ts`:搬 45 个序列化器(纯搬)| 全绿 + golden 快照零 diff + `wire.test.ts` |
| **A2** | `api/server.ts` 骨架 + 中间件 + WS 升级 | 全绿 + daemon-smoke |
| **A3–A20** | 逐域搬 router(native+compat 同文件;issues/runtimes/daemon 最后)| 每 PR golden 快照零 diff + 该 router HTTP 测 |
| **T1** | `contracts/types/*` + barrel(纯搬)| 全绿 + `tsc --noEmit` |
| **T2–Tn** | 逐域 carve 测试到 `tests/multiremi/*` + `helpers.ts` | 用例总数不降 + 单文件独立过 |
| **D1(可选/待决策)** | dashboard.ts 去留:若删,先迁 8 处测试断言、再替换 `GET /` 路由 | 全绿 |
| **末尾** | `scripts/check-layers.ts`(真实 import 图,先 WARN)→ 收尾转 ERROR | lint 通过 |

## 5. 验证机制

- **每 PR**:`bun test` 全量,计数 ≥ 基线;纯搬迁 PR 额外证明行为等价 —— router 搬迁跑 golden 快照(零 diff),store facade 靠现有 827 个 `app.request` 测试当 oracle,types 搬迁跑 `tsc --noEmit`。
- **新文件**:其兄弟 `:memory:` 测试单独可过(`bun test src/multiremi/store/<domain>.test.ts`)。
- **store / api 整块拆完后**:重跑 golden + `daemon-smoke` + `cli-config` + `release` 测试,抓 daemon/auth 接线回归。
- **每个"搬迁"PR `git diff` 人眼过一遍**:每行都是机械移动/委托,无逻辑潜入。

## 6. 坑(务必避开)

1. **dashboard.ts 不能直接删** —— 测试 import 它并断言 8 次,删则编译挂(产品决策 + 先迁测试)。
2. **StoreContext 必须先抽** —— 跨域 helper(`appendIssueActivity` 21 处、`notifyTaskEvent` 7 处、`recordAnalyticsEvent` 9 处等)不先 hoist,域一搬就悬空。
3. **循环依赖用懒 getter**,不是构造器注入(否则 carve 死锁);tasks_chat/runtimes 最后拆。
4. **compat 不可合并/删除** —— 34+ 路由行为不同;改 api 前先 golden 快照,搬迁后逐字节比对;"搬迁"PR 绝不碰 wire.ts 函数体。
5. **facade 必须委托全部 ~248 个公共方法** —— 漏一个是运行时(非编译期)挂;从方法清单机械生成委托并断言数量对齐。
6. **WS 升级 + daemon 前缀中间件留 server 骨架**,顺序错会把 101 变 401(只有 daemon-smoke 能抓,拆完显式跑)。
7. **schema 的 3 个遗留迁移每次启动都要跑**(旧库升级依赖,`8f20d1c8` 是前车之鉴)。
8. **wire.ts 的 snake/camel 归一化(toCamelCase/toSnakeCase)是行为变更**,别混进搬迁 PR;除非有具体 bug 否则不做。
