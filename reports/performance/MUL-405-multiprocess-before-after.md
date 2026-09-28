# MUL-405 多进程安全：并发迁移失败率与 issue 编号冲突的前后对比

- 父单：MUL-383（P0 第 5 项，决策结果 `sres_wep8c9z66cef`）
- 本单：MUL-405
- 生成时间：2026-09-27
- 改前树：`43d75571e736293b1300fabf1c54c2d03302de57`（本分支的父提交，`git archive` 导出，未含本 PR 改动）
- 改后树：`1f5b282a`（本分支，工作树实测）
- 被测实现指纹：`migrations.ts` sha256 `dc170fea18fde68f1abe30b62c823f4e941da9f02b85ee0a59ff115967218267`、`db/postgres.ts` sha256 `075e740bf4882adcbb02225fe7314812d5072909e18374e79cb40bbe510d8411`。两份报告 JSON 都记了这两个字段；复核时先比对，再决定数字是否仍然描述当前代码。
- 运行机器：linux x64，64 vCPU
- Bun：1.3.14
- 数据库：**真实 PostgreSQL 15.19**（Debian `15.19-0+deb12u1`），本机无 Docker，按仓库 wiki 的 `guides/postgresql-without-docker-in-agent-container.md` 用 `apt-get download` + 嵌套 user namespace 起在 `127.0.0.1:5442`
- harness：`tests/manual/mul405-multiprocess-safety.ts`（改前与改后用同一份文件、同一组参数）
- 原始 JSON：[`MUL-405-multiprocess-before.json`](MUL-405-multiprocess-before.json) / [`MUL-405-multiprocess-after.json`](MUL-405-multiprocess-after.json)

## 为什么必须是多进程

`PostgresSyncDatabase` 把 PostgreSQL 的异步连接通过 Worker + SharedArrayBuffer + `Atomics.wait` 变成同步调用（`packages/server/src/store/db/postgres.ts`）。每个 SQL 都阻塞主线程，所以**同一个进程里的两个 store 物理上无法交错**，同进程"并发"测试复现不了本单的任何竞态。harness 因此为每个并发方起真实子进程。

## 判定口径

- 并发迁移：N 轮，每轮 `DROP DATABASE` / `CREATE DATABASE` 造一个**全新空库**，然后同时启动 2 个进程各自 `new MultiremiStore()`（构造函数无条件 `runMigrations`）。一轮算失败，当且仅当任一子进程非 0 退出，或写出 `ok:false`，或 crash。子进程跑完 `listIssues` + `ensureLocalWorkspace` 才报成功，避免"连库都没打开也算过"。
- issue 编号：同一个库上 2 个进程各 `createIssue` N 次。冲突数 = 两边全部编号里 `总数 - 去重后数量`。两个子进程各自也断言自己进程内无重复。
- 生产发版时两个进程是 `api` 与 `ssh-mesh-control-plane` 容器（compose 里没有 `depends_on`）；harness 用两个 OS 进程复现的是同一个竞态。

## 改前 / 改后

| 场景 | 改前 `43d75571` | 改后 `1f5b282a` |
|---|---|---|
| 冷库 2 进程并发 `runMigrations`，20 轮 | **20/20 轮失败（失败率 100%）** | **0/20 轮失败（失败率 0%）** |
| 同库 2 进程各 `createIssue` 200 次 | 400 次调用成功，但只产生 **348 个不同编号**，**52 个重复** | **400 个编号全部唯一，0 个重复，0 次失败** |
| 并发迁移单轮墙钟 p50 / p95 | 2900 ms / 3016 ms | 3931 ms / 4092 ms |

改前 20 轮的失败样本（每轮先到的进程都撞在同一个 catalog 冲突上）：

```
postgres: duplicate key value violates unique constraint "pg_type_typname_nsp_index"
SQL: CREATE TABLE IF NOT EXISTS multiremi_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)
```

这与描述里引用的 `cmt_3su5m4465hmp` 现场一致。描述里另一条 `type "multiremi_schema_migrations" already exists` 是同一竞态在另一时序下的表现（先到的进程已经把类型建出来、后到的才开始建）。

## 迁移变慢是预期结果，不是回归

p50 从 2900 ms 升到 3931 ms，增量约 1 秒，正是第二个进程在等第一个跑完。这段等待是**本次修复的目的**：改前它不等待，而是直接失败并让容器起不来。迁移只在启动时跑一次，单进程下的耗时没有变化。

## 锁本身的互斥性（`--part lock`）

harness 里的第三个场景直接量锁，不经过迁移或编号：3 个真实进程同时进入同一段临界区（忙等 400 ms），对比「持锁」与「完全不加锁」两种写法。

| 写法 | 区间重叠对数 | 区间 |
|---|---|---|
| `advisoryLock`（本 PR 实现） | **0** | `A[…8559..8959] B[…8961..9361] C[…9363..9763]` |
| 同一临界区、不加锁（改前形状） | **2** | `A[…9813..0213] B[…9814..0214] C[…9814..0214]` |

不加锁时三个区间起点相差 1 ms 以内、几乎完全重合；加锁后严格首尾相接。改前树（`43d75571`）**跑不了这个场景的持锁一半**——那里没有 `SqlDatabase.advisoryLock`，harness 因此直接报错退出，而不是把空日志报成「0 重叠」。这一点是刻意的：把「锁不存在」静默记成「无重叠」会让报告自证成功。

## 复现方式

```bash
MULTIREMI_TEST_POSTGRES_URL=postgres://… \
  bun run tests/manual/mul405-multiprocess-safety.ts --part all --rounds 20 --per-process 200 \
  --out reports/performance/MUL-405-multiprocess-after.json
```

`--part` 可选 `migrations` / `issues` / `lock` / `all`（默认 `all`）。

改前数字在同一台 PG、同一参数下，把这份 harness 拷进 `43d75571` 的 `git archive` 工作树后跑同一条命令得到（该目录没有本 PR 的代码改动）。注意 `--part lock` 在改前树上会**失败**（见上一节），`--part migrations` 与 `issues` 则是把这份 harness 原样拷过去再跑。

harness 不读也不写生产库，只使用 `MULTIREMI_TEST_POSTGRES_URL` 指向的实例，且每轮自建、自删临时库。子进程通过环境变量收到该 URL，不落盘。

**凭据**：两份 JSON 与本文都不含连接串或口令；`command` 字段按仓库既有惯例写成 `postgres://…`。

## 本次未覆盖

- 生产 209 的真实数据分布与双容器同时启动：由 Explorer 在低峰只读核查，结果贴 MUL-405；本报告只证明机制在真实 PostgreSQL 上成立。
- `api_minute_summary` / `api_slow_request` 的 `pid` 字段：MUL-386（PR #255，`fd52ff9e`）已合入 main，本轮已实现并有单测覆盖，见上文「pid 观测字段」。
- 发布后在 209 只读确认两个容器的启动日志都没有迁移报错：属于上线后动作，不在本 PR 范围。

## 锁顺序死锁：QA 复现、修复与回归测试

QA 在 `512332dd` 上用两条 PostgreSQL 事务按相反顺序交错两条真实业务路径，得到 `deadlock detected`，其中一条事务被回滚。根因是 Issue 编号锁当时不是叶子锁：

- Feishu 摄取（`feishu-bot-repo.ts`）：先取 workspace 行锁，再经 `createIssue` 取 Issue 编号锁；
- Autopilot `create_issue`（`autopilots-repo.ts`）：先取 Issue 编号锁，再经 `createTaskWithinTransaction`（`tasks-repo.ts`）取同一 workspace 行锁。

两条路径顺序相反，形成环。修复方式是在 `store/advisory-locks.ts` 里写下一个全局取锁顺序，并让所有同时需要这两类锁的路径都遵守：

```
workspace 生命周期行锁  ->  编号分配锁  ->  领域行锁
```

选这个顺序而不是把编号锁改成严格叶子锁，原因是：`createIssue` 的调用方在持有编号锁之后本来就要写 Issue 行、序列事件、创建 Issue Session，把所有这些都排除在编号锁之外会改变现有事务语义；而「先取 workspace 行锁」与既有 Feishu 路径、`createTaskWithinTransaction` 的既有顺序一致，改动只影响取锁时机，不改业务语义、不改 API/CLI。

改动文件：

- `packages/server/src/store/advisory-locks.ts`（顺序契约与理由）
- `packages/server/src/store/repos/issues-repo.ts`（`createIssueWithinTransaction` 先取 workspace 行锁）
- `packages/server/src/store/repos/autopilots-repo.ts`（`runAutopilot`、`enqueueScheduleTargets`、调度分发先取 workspace 行锁）
- `packages/server/src/store/repos/feishu-bot-repo.ts`（`recordAudit` 先取 workspace 行锁）
- `packages/server/src/store/repos/projects-repo.ts`（`createPinnedItem` 先取 workspace 行锁）

回归测试 `tests/unit/multiremi/mul405-lock-order.test.ts`（fixture：`tests/unit/multiremi/fixtures/postgres-lock-order-interleave-worker.ts`）分两步：先从 store 真实代码里推导每条路径的取锁顺序（用一个记录型 `SqlDatabase` 包住真实 SQLite store），再把推导出的顺序放到**两条独立的 PostgreSQL 连接**上用 barrier 交错回放。

| 树 | 测试结果 |
|---|---|
| 改前 `512332dd`（同一份测试文件拷入） | **复现**：`autopilot [error] deadlock detected — derived orders: feishu workspace -> number, autopilot number -> workspace`；顺序断言也失败 |
| 修复后 `d6dd448f` | **通过**：2 pass / 0 fail，两条事务都提交，Issue 编号唯一且连续 |

测试用 `MULTIREMI_TEST_POSTGRES_URL` 开关；未设置时 skip，CI 口径不变。

## 嵌套事务回滚

`tests/unit/multiremi/mul405-nested-rollback.test.ts` 覆盖三处真实嵌套调用，SQLite 与 PostgreSQL 各跑一遍（PG 同上开关）：

- Feishu bot 摄取：内层失败、内层成功但后续步骤失败，两种情况都断言 12 张相关表的行数与调用前完全一致；
- messaging outcomes：内层失败后 Issue 与 outcome 都不落库，且消息保持未处理以便重试；
- Autopilot `create_issue`：内层失败后 run / Issue / Session / Task 均无残留；
- 捕获内层失败后外层仍可提交：断言外层事务仍可用并能正常提交。

修复后 12 pass / 0 fail（改前树上同文件也通过，因为 SAVEPOINT 修复在 `512332dd` 里已经存在；这组测试补的是当时缺失的验收覆盖）。

## `pid` 观测字段

MUL-386（PR #255，`fd52ff9e`）合入 main 后，按本单「观测」行给两条日志加 `pid`：

- `packages/server/src/observability/request-metrics.ts`：`api_minute_summary` 与 `api_slow_request` 各加 `pid: process.pid`；
- `tests/unit/multiremi/request-metrics.test.ts`：断言两条日志都带 `pid`，精确字段集随之更新，并断言事件名、其余字段、采样、阈值与 `Server-Timing` 响应头均未变化。

测试：`bun test tests/unit/multiremi/request-metrics.test.ts` → 30 pass / 0 fail（含 PG 集成）。

## 本轮新 head

- 锁顺序修复：`d4254edd`
- 合并 `origin/main`（`d905961b`，含 `fd52ff9e`）：`2a802b67`
- `pid` 观测字段：`d6dd448f`
- 回归修复（createIssue 的实时推送改回提交后发布，MUL-400 S1 契约）：`3bd9d736`

## 锁序与提交后推送（第二轮 QA 复核后）

第二轮 QA 发现两件事：全仓还有 5 条真实路径把领域行锁排在编号锁之前，以及嵌套调用 `createIssue` 会在最外层 COMMIT 之前推送 `activity:created`。本节记录这两项的修复与验证。

### 一、取锁顺序收敛到 W -> N -> D

契约不变（`store/advisory-locks.ts`）：W（workspace 生命周期行锁）-> N（编号分配锁）-> D（领域行锁）。这一轮把 5 条路径改成符合契约，做法都是把 W、N 提到该路径第一条领域写语句之前：

| 路径 | 修复前 | 修复后 |
|---|---|---|
| `FeishuBotRepo.submitMessage` | W -> sender UPSERT(D) -> N -> Chat/Task(D) | **W -> N -> sender UPSERT(D)** -> Chat/Task |
| `AutopilotsRepo.runAutopilot(create_issue)` | W -> autopilot UPDATE(D) -> N -> Task(D) | **W -> N -> autopilot UPDATE(D)** -> Task |
| `MessagingOutcomeService.createIssue` | message UPDATE(D) -> W -> N -> outcome(D) | **W -> N -> message UPDATE(D)** -> outcome |
| `MessagingOutcomeService.approveProposal` | message UPDATE(D) -> W -> N -> outcome(D) | **W -> N -> message UPDATE(D)** -> outcome |
| `FeishuIngestRepo.createIssueOutcome` | Feishu message UPDATE(D) -> W -> N -> outcome(D) | **W -> N -> message UPDATE(D)** -> outcome |
| `FeishuIngestRepo.approveIssueProposal` | Feishu message UPDATE(D) -> W -> N -> outcome(D) | **W -> N -> message UPDATE(D)** -> outcome |
| `FeishuBotRepo.setSenderAllowed` | W -> sender UPDATE(D) -> N -> audit(D) | **W -> N -> sender UPDATE(D)** -> audit(D) |

取舍：`submitMessage` 与 `runAutopilot` 无法在事务开头就确定要不要建单（取决于 sender 解析、execution mode），因此**无条件先取 N**。N 是按 workspace 的编号锁，持有代价是「同 workspace 的建单多等几毫秒」，换来的是取锁顺序与请求内容无关——这一点比省下几毫秒重要。

### 二、提交后推送：嵌套时也必须等最外层 COMMIT

第二轮 QA 的探针在 SQLite 和 PG 上都构造了「外层事务 -> `createIssue` -> 断言尚未收到事件 -> 外层回滚」，2/2 失败：事件在外层回滚前已经发出。根因是 `createIssue` 在自己的 `db.transaction()` 返回后立刻 `emitCommitEvents`，而在嵌套场景里那个返回只是 `RELEASE SAVEPOINT`。

复用 main 上已有的 `CommitEventQueue` / `emitCommitEvents`，补的是这个队列表达不了的「嵌套边界」：

- `SqlDatabase` 增加可选 `afterCommit(fn)`；
- `PostgresSyncDatabase` 原生实现，按事务帧记账——内层帧干净退出时并入父帧，`ROLLBACK TO SAVEPOINT` 时整帧丢弃，只有最外层帧在真正 COMMIT 之后才执行；
- `invalidatingDatabase` 包装层为 SQLite 提供同样的语义；
- `emitWorkspaceEvent`、`notifyTaskEnqueued`、`emitCommitEvents` 都经过这个钩子。

因此事件在嵌套事务里只会等最外层提交，回滚时整队丢弃，且不会重复：一次调用只入队一个回调，按入队顺序排空。

测试（SQLite + PostgreSQL 各一遍，`tests/unit/multiremi/mul405-nested-rollback.test.ts`）：

- 外层事务 -> `createIssue` -> 断言尚未收到 `activity:created` -> 外层提交 -> 恰好 1 条；
- 外层事务 -> `createIssue` -> 断言尚未收到 -> 外层回滚 -> 仍然 0 条，且行已回滚。

### 三、逐路径锁序断言与变异验证

`tests/unit/multiremi/mul405-lock-order-paths.test.ts` 用记录型 `SqlDatabase` 包住真实 store，对每条路径单独记录取锁序列，断言「每类锁的首次获取」按 W -> N -> D 单调不减（同一事务内重复取已持有的锁不算违规，Postgres 允许，store 也依赖这一点）。覆盖 11 条路径：直接 `createIssue`、quick-create、Feishu bot、Autopilot、`setSenderAllowed`、`recordAudit`、`createPinnedItem`、messaging outcomes 建单与批准、Feishu ingest 建单与批准。

`tests/unit/multiremi/mul405-lock-order.test.ts` 另外把「纯 `createIssue`（quick-create）对 Feishu bot」加进双连接交错回放。

三次变异的实际结果（每次都跑，跑完还原）：

| 变异 | 结果 |
|---|---|
| 删掉 `issues-repo.ts` 里 `createIssueWithinTransaction` 的 `lockWorkspaceRuntimeLifecycle`（QA 上轮做过、测试没抓住的那条） | **2 fail / 9 pass**：`direct createIssue` 与 `quick-create` 各自报「first W acquisition comes after a higher class」 |
| Autopilot 改回「autopilot 行 UPDATE 在 N 之前」 | **1 fail / 10 pass**：`runAutopilot(create_issue)` 报同一断言 |
| messaging outcomes 改回「message 行锁在 W/N 之前」 | **1 fail / 10 pass**（与上一条同批跑）：`messagingOutcomes.createIssue` 报同一断言 |
| `afterCommit` 改成立即执行（即提交前推送的旧行为） | **2 fail / 7 pass**：两条嵌套推送用例各自失败 |

还原后：逐路径 11 pass / 0 fail；嵌套回滚 9 用例 x SQLite + PG = 18 pass / 0 fail。

### 四、messaging outcomes 的另一个回滚方向

第二轮 QA 指出该套件只覆盖「内层失败」。补上「内层建单成功、外层随后失败」：内层落库的 Issue、`issue_created` outcome 与消息的 `processed_at` 全部随外层回滚，消息保持可重试。SQLite 与 PG 都跑。

## 第二轮 head

- 合并 `origin/main`（`c33828f0`，含 MUL-406 的事件管线）：`8f5acc70`
- 合并后补回编号锁与 E1 回放：`3fddad9d`
- 五条路径锁序 + 最外层提交后推送：`fa8ac817`
- 逐路径锁序断言 + 纯 `createIssue` 交错回放：`f84f9e5a`
- 嵌套推送测试 + messaging 外层失败用例：`6af0a289`

## 全仓锁序（第三轮 QA 后）

第三轮 QA 用全仓检索找到两条逐路径测试没覆盖的反序，并指出「逐路径断言只有单调性、没有必需锁存在断言」，删掉 `recordAudit` 的 W 后 11 条用例仍全绿。本轮把这两件事一起解决：修反序、补必需锁断言、再加一个覆盖全量测试套件的哨兵。

### 一、合入的 main

`git merge origin/main`，合入提交 `01ceef3b`（main = `bda58bd9`，MUL-457），无冲突。

### 二、本轮修复的两条反序

| 入口 | 修复前 | 修复后 |
|---|---|---|
| `agents-skills-repo.ts` `archiveAgent`（经 `disableConfigsReferencingAgent` → `recordAuditWithinTransaction`） | W → agents UPDATE(D) → N(audit) | **W → N(audit) → agents UPDATE(D)** |
| `runtimes-repo.ts` Runtime 级联删除（`deleteRuntime` / `deleteRuntimeWithArchivedAgentCleanup` / `archiveAgentsAndDeleteRuntime` / `mergeRuntimeInto` → `disableWhere` → audit） | W → config UPDATE(D) → N(audit) | **W → N(audit) → config UPDATE(D)** |

两条都选**无条件**先取 N：这是低频管理操作；有条件写法需要一次「有没有配置引用这个 X」的读，而该读无法证明无竞态——`upsertConfig` 与 `replaceRoutes` 同样取 W，所以「读之后到取锁之前」可能被并发创建插入。

### 三、哨兵发现的新路径（本轮新增）

哨兵启用后立刻报出第三条反序，逐路径清单里原本没有：

| 入口 | 修复前 | 修复后 | 处理 |
|---|---|---|---|
| `daemon-retirement-repo.ts` `lockLifecycle`（`registerRuntime`、`registerDaemonRuntimeBatch`、`retire`、以及 3 条 access-token 路径共 7 个调用点） | D(daemon_lifecycle_locks) → W | **W → D** | 已修：把 W 提到 `lockLifecycle` 开头，一处覆盖全部调用点 |

另修一条哨兵在 MUL-400 父状态钩子里报出的 W/D 反序：

| 入口 | 修复前 | 修复后 | 处理 |
|---|---|---|---|
| `issues-repo.ts` 父状态钩子（`notifyChildStatusChange` 的两个分支） | 通知评论 INSERT(D) → W | **W → 通知评论 INSERT(D)** | 已修（只涉及 W/D，改动小） |

### 四、逐路径表（16 条）

`tests/unit/multiremi/mul405-lock-order-paths.test.ts`：每条路径声明**必需锁集合**并断言其全部出现，同时断言首次取得顺序单调。D 的判定与哨兵一致——事务内任何非读语句都算 D。

| # | 入口 | 必需锁 | 实际顺序 |
|---|---|---|---|
| 1 | 直接 `createIssue` | W, N | W → N → D |
| 2 | quick-create | W, N | W → N → D |
| 3 | Feishu bot `submitMessage` | W, N, D | W → N → D |
| 4 | `runAutopilot(create_issue)` | W, N, D | W → N → D |
| 5 | `setSenderAllowed` | W, N, D | W → N → D |
| 6 | `recordAudit` 独立调用 | W, N, D | W → N → D |
| 7 | `createPinnedItem` | W, N, D | W → N → D |
| 8 | messaging outcomes `createIssue` | W, N, D | W → N → D |
| 9 | messaging outcomes `approveProposal` | W, N, D | W → N → D |
| 10 | Feishu ingest `createIssueOutcome` | W, N, D | W → N → D |
| 11 | Feishu ingest `approveIssueProposal` | W, N, D | W → N → D |
| 12 | `archiveAgent`（本轮新增） | W, N, D | W → N → D |
| 13 | Runtime 级联删除（本轮新增） | W, N, D | W → N → D |
| 14 | `updateIssueWithinTransaction`（MUL-457，本轮新增） | W, D（**N 不出现**） | W → D |
| 15 | `grantParentDone`（MUL-457，本轮新增） | D（**N/W 不出现**） | D |
| 16 | `revokeParentDone`（MUL-457，本轮新增） | D（**N/W 不出现**） | D |

第 14~16 条先核对了是否间接取 N：`updateIssueWithinTransaction` 只锁 Issue 行、不建子单、不写 audit；`grantParentDone` / `revokeParentDone` 只有 `UPDATE multiremi_issues SET id = id` 的行锁加一次状态写，同样不取 N。所以按「不取 N 的断言 W→D，且 N 不出现」处理。

### 五、全仓哨兵

实现：`packages/server/src/store/lock-order-sentinel.ts`。两个数据库包装层分别喂给它：

- `store/request-read-cache.ts`（`invalidatingDatabase`，SQLite 走这里）：在每个语句**执行**时分类（不是 prepare 时——预编译的语句可能在之后的事务里执行）；
- `store/db/postgres.ts`（`PostgresSyncDatabase`）：`run`/`exec`/`SentinelPgStatement`/`advisoryXactLock` 各点喂入。

规则：只对每个事务**首次**取得每类锁排序（同事务重复取已持有的锁在 PG 是免费的，store 也确实依赖这一点），首次取得的类低于已取过的最高类即抛错，错误信息带 trace 与调用栈。W = `UPDATE multiremi_workspaces SET updated_at = updated_at`；N = 任意 `advisoryXactLock`；D = 事务内任意非读语句。事务外不检查。

开关：`MULTIREMI_TEST_LOCK_ORDER_SENTINEL=1`，由 `bun test` preload 默认打开（`tests/setup/hermetic-env-policy.ts`），`NODE_ENV=production` 下无论变量如何都拒绝启用；关闭时是一个缓存的布尔判断。`MULTIREMI_TEST_*` 不参与环境清洗，所以开发者可以用 `=0` 关掉。

全量结果：

| 运行 | 结果 | 违例 | 耗时 |
|---|---|---|---|
| `bun test tests/unit/multiremi/ --timeout 20000`（SQLite，哨兵开） | 3257 pass / 137 skip / 0 fail | **0** | **497s** |
| 同上（哨兵关） | 3257 pass / 137 skip / 0 fail | — | **498s** |
| 同上（真实 PG 17.9，哨兵开） | 3382 pass / 1 fail（见下） | **0** | 639s |

开销在噪声范围内（497s vs 498s），所以 CI 默认开启：`release-build-check.yml` 的 backend 步骤显式声明 `MULTIREMI_TEST_LOCK_ORDER_SENTINEL: "1"`。

唯一失败是既有 flaky，与本轮无关：`MUL-301 PostgreSQL executable audit runbook` 在 15s 上限附近超时。单文件跑：本分支 15.4s 失败、哨兵关闭 16.0s 失败、**纯 main `bda58bd9` 16.2s 同样失败**，属该测试自身贴近超时上限。

哨兵变异（全量运行中验证）：

- 把 `archiveAgent` 改回旧顺序（去掉 N）→ **4 fail**，报 `MUL-405 lock order violated: first N acquisition comes after a higher class`，报出该问题的测试是：
  - `Feishu bot Agent route API > replaces routes idempotently, validates Agents, and leaves revision unchanged`
  - `Feishu bot Agent route repository > falls through archived route Agents without stopping the bot`
  - `workspace Feishu bot config API > stops the bot when its Agent is archived`
  - `MUL-405 per-path lock order > archiveAgent`
- 还原后 0 违例。

逐路径变异（QA 指定）：

- 删掉 `recordAuditWithinTransaction` 的 W（第三轮 QA 的变异，旧测试没抓住）→ **1 fail / 15 pass**，报 `recordFeishuBotAudit is missing required lock(s) W; recorded: N, D`；
- 删掉 Runtime 级联的 N → **1 fail / 15 pass**，报 `Runtime cascade delete` 用例失败。

### 六、回归与手册

- 定向：`mul405-lock-order-paths` 16 pass、`mul405-lock-order` 3 pass、`mul405-nested-rollback` 18 pass，合计 37 pass / 0 fail（真实 PG）。
- `bun test tests/arch/` 92 pass / 0 fail；`bunx tsc --noEmit` 0 error；`npm run docs:check` 通过；`bun run scripts/snapshot-api-routes.ts --check` 通过。
- 多进程手册：`--part all --rounds 20 --per-process 200` → 并发迁移 0/20 失败、双进程建单 400/400、编号唯一且失败 0、加锁区间重叠 0（不加锁对照 2）。

### 七、第三轮 head

- 合入 main（`bda58bd9`）：`01ceef3b`
- 两条反序 + lockLifecycle + 哨兵 + 逐路径断言：`75d32b73`
- `afterCommit` 语义注释 + CI 默认开启哨兵：`7f76c07a`

## 第五轮：合入 MUL-409 并验证新增事务路径

本轮续跑先盘点：分支仍为 `agent/MUL-405`，`eaadbd14` 已推送，父提交为
`386907f5` 和 `bbc964c9`；没有未推送提交或 stash。唯一未提交成果是逐路径测试，
在其基础上完成，而不是重新合并。新增测试提交为 `65a471e3`。
随后再合 `origin/main = 7bd32800`（含 MUL-473 的 `c7be1916`），无冲突，
得到 `3c640acf`。
推送报告前 main 又到 `b6bdcc51`（MUL-458，人类强制开工入口），
再次无冲突合入得到 `027ae998`。因为涉及同一套依赖/派发代码，停止了
本轮自己刚启动的 PG 全量进程组，再在新合并态运行定向和完整门禁；
被中止的部分运行不计作一次完整结果。

### 五处冲突的语义合并

| 文件 | MUL-405 一侧 | MUL-409 一侧 | 合并结果及理由 |
|---|---|---|---|
| `store/db/postgres.ts` | SAVEPOINT 嵌套、after-commit 帧、语句执行时哨兵记账 | `inTransaction`、`maxTransactionDepth` 和峰值统计 | 保留嵌套/回滚/最外层提交语义，同时在每层 transaction 更新峰值；统计接口不创建 SQL 旁路。409 要求其路径深度为 1，405 对真正嵌套路径继续提供 SAVEPOINT |
| `store/context.ts` | `emitCommitEvents` 经 `afterCommit`，最外层提交后排空 | `CommitEventQueue.issueActivities`、提交后活动写入，以及 transaction-internal 调用所需的 host surface | 保留三种队列及新增 surface；活动、workspace events、task wakeups 的 drain 全放入既有 `afterCommit` 回调，外层回滚时一起丢弃 |
| `store/repos/issues-repo.ts` | 共享建单 body 先 W、后编号 N；事件在提交后发布 | 显式 `IssueCreationTransactionOwner`，caller-owned 写入需要 collector 和队列，新增 force/auto 原子路径 | 使用 409 的 owner API 和事务边界，在共享 `createIssueWithinTransaction` body 保留 W→N。嵌套回滚测试传完整 owner，并由 owner 安排队列 drain |
| `messaging/outcomes.ts` | 在 message 行 UPDATE 前取 W、N | 同一 owner 传 `childStatusChanges`，调用 `recordOutcomeWithinTransaction` | 保留 W→N prelude，collector/queue 传到底；Issue、outcome 和消息状态共用一个事务，提交后 replay/drain |
| `store/repos/feishu-ingest-repo.ts` | direct/approval 的 message 行写入前取 W、N | caller-owned 建单的 collector/queue | 两者同时保留；审批、Issue 和消息状态仍原子提交，锁序为 W→N→D |

`eaadbd14` 的 merge resolution 另修一个哨兵实际报出的新路径：
`IssueSessionsRepo.createSessionTask` 原为 participant INSERT(D)→Task writer 首次取 W。
现在在同一个原有事务开头取 W，再写 participant/lane/task，成为 W→D；
没有拆分或合并 MUL-409 的事务边界。

### PostgreSQL 的全部语句入口

`PostgresSyncDatabase.query` 创建 `SentinelPgStatement`；`prepare` 委托给 `query`。
返回语句的 `get`、`all`、`run`、`values` 都在真正执行前调用
`lockOrderSentinelNoteStatement(sourceSql)`。直接 `run` 同样先记账；
`exec` 对 `splitStatements` 的每一段分别记账。`advisoryXactLock` 先记 N，
再调用 bridge。事务控制语句由 `transaction` 的最外层 begin/end 记账管理；
迁移会话 advisory lock 不属于编号 N。

409 的 `get/reset maxTransactionDepth` 只是读写计数器；它新增的
`query(... FOR UPDATE).get(...)` 也返回上述语句包装，并未直接调用 bridge。
哨兵规则、开关、CI 默认开启、afterCommit 行为均保持第四轮实现。

409 的 “keep the force lock order” 是 `4a75ee87`：可能 dispatch 的请求，
先锁 workspace 行，再锁 Issue 行。该路径不取 N，与本单 W→D 一致。
它还保留一笔事务中只作一次 dispatch decision 的规则。

### 自动 start：真实 PG 的事务边界证据

新增 `MUL-409 real PG: automatic start and dependency transaction frames` 用例：
记录器代理真实 `PostgresSyncDatabase`，保留 `instanceof`/dialect，所以运行到
自动 start 的 PG `FOR UPDATE` 分支。每个最外层事务单独成帧，每条锁记录带
实际 callback 深度；同时断言 PG 原生 `maxTransactionDepth === 1`。

执行实际入口得到：

```text
createIssueDependency:
  frame 1, depth 1: D INSERT INTO multiremi_issue_dependencies

updateIssue(prerequisite, {status: done}):
  frame 1, depth 1: D UPDATE multiremi_issues SET id = id
  COMMIT
  frame 2, depth 1: W workspace-lifecycle
                  D UPDATE multiremi_issues SET status = 'todo' ...
  COMMIT
  maxTransactionDepth = 1
```

自动 start 是前置 Issue 更新提交后的独立事务，不是外层事务里的 D→W。
用例断言 dependent 真正变成 todo，且恰好有一条 Task，避免只测到空事务。
上一轮的未完成用例先启动 dependent，再给已启动的 Issue 加另一条依赖，
没有再次触发自动 start；本轮改成从 backlog 首次自动启动。

独立 `createIssueDependency` 只写依赖和活动行，不分配编号、不写 audit、
不操作 workspace/Runtime 生命周期，也没有继续取得 W/N 的调用链。
`advisory-locks.ts` 的契约是“事务取多类锁时必须排序”，不要求每个 D-only
事务凭空加 W；与既有 grant/revoke 的 D-only 断言一致。因此不新增 W，
按实际 `{D}` 断言，并明确禁止 W、N 出现。

记录器改为事务分帧，并在语句执行而非 prepare 时分类。路径的所有事务都
断言首次顺序单调；原有 16 条必需锁断言保留。多事务入口另外精确断言
每帧的锁集合、帧数和深度，不把不匹配的事务从顺序检查里过滤掉。

### 新增逐路径表

| # | 入口 | 必需锁 | 实际首次顺序 |
|---|---|---|---|
| 17 | forced start (`updateIssue` member force) | W,D | W→D，N 不出现 |
| 18 | automatic start (`updateIssue` prerequisite done) | 更新帧 D；自动 start 帧 W,D | 独立两个事务：D / W→D，N 不出现 |
| 19 | `createSessionTask` | W,D | W→participant/lane/task D，N 不出现 |
| 20 | 独立 `createIssueDependency` | D | D，W/N 均不出现 |
| 21 | messaging direct owner 中的 `recordOutcomeWithinTransaction` | W,N,D | W→N→D；outcome writer 深度 1，只有一个事务帧 |

第 17~20 条不创建 Issue、不分配 audit 序号，因此不取 N。
第 21 条的 outcome writer 本身不取 N，但其 owner 创建 Issue，故整个事务
必须取 Issue 编号 N；用例断言 outcome writer 加入同一帧，没有开启新事务。

### 本轮验证记录

合 MUL-409 后、再合新 main 前的定向真实 PG：六个文件共 **200 pass / 0 fail**，
覆盖本单三文件、409 的 PG 七入口探针、dependency PG 端到端和第五轮任务唤醒测试。
新增逐路径及 PG 帧证据为 **22 pass / 0 fail**，无 skip。
PG 版本为 18.4，Bun 为固定的 1.3.14；独立端口和数据目录。

`3c640acf` 上：架构 **92 pass / 0 fail**，docs:test **13 pass**，
docs:check 通过，CLI capability checker **677 mapped / 92 exempt / 0 missing
(769 routes)**，API route snapshot matches。

### 新路径变异：完整目录门禁

临时删除 `createSessionTask` 事务开头的 W，恢复 409 合并前的
participant INSERT(D)→Task writer 首次取 W。在开启原哨兵的完整
`bun test tests/unit/multiremi/ --timeout 20000`（SQLite）里得到：
**3385 pass / 216 skip / 77 fail，547.01s**。

原哨兵在既有用例中实际报出：

```text
MUL-405 lock order violated: first W acquisition comes after a higher class
Trace:
  D INSERT INTO multiremi_session_participants (...)
  W UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?
Stack: createTaskWithinTransaction -> createSessionTask -> calling test
```

报错用例包括：

- `Feishu bot standard Task bridge > wakes once after a lead round and durably retries the proactive topic reply`
- `MUL-405 per-path lock order > MUL-409 session task creation: W -> participant row -> task, no number lock`
- `MUL-409 — fix round 5: a refused session task leaves no participant or lane > answers 409 dependencies_unmet and leaves participants, lanes and tasks unchanged`
- 同组 `still creates the participant, the lane and the round for an ordinary issue`
- `MUL-409 QA round 5 task wakeups on SQLite > SQLite: keeps ordinary and session task wakeups at one each`

每次变异仅移除一行 W；完整运行结束后用 patch 还原，
`git diff --exit-code -- packages/server/src/store/repos/issue-sessions-repo.ts`
确认与已提交的合并结果完全一致。没有改哨兵规则，也没有跳过或放宽业务断言。

还原后的 PG/SQLite 全量、多进程 harness 及最新 head 的 CI 数字，
以 MUL-405 第五轮交付评论为准；本节保留可由提交中用例复现的锁序与变异证据。

### 合入 MUL-458 后的 Worker 环境发现

`multiremi-dependency-human-force-pg.test.ts` 的两个双连接 Worker HTTP 用例
在本环境原启动方式下均返回 401：八文件定向运行是 218 pass / 2 fail，
单文件复跑也是 5 pass / 2 fail（11.70s）。这发生在鉴权阶段，没有哨兵违例。
Worker 没有显式 authToken，读取的是启动环境中继承的 `MULTIREMI_TOKEN`；
主测试进程的 hermetic preload 清理并未覆盖这个 Worker 的初始环境。

在启动 Bun 前用 `env -u MULTIREMI_TOKEN` 清理宿主凭证，完全相同的 PG
文件成为 **7 pass / 0 fail（11.25s）**，包括两个真实双连接 race。
后续本地验证使用该隔离方式；没有修改任何鉴权、业务断言或 skip 条件，
也没有关闭哨兵。CI 本来就没有该宿主凭证。
建议这类 Worker 统一显式采用清理后的环境或复用 hermetic preload；
这个新环境问题列入交付，由父单决定归属，本轮不新开子单。

在 `027ae998` 的合并态、上述隔离环境中，八文件定向真实 PG 回归为
**220 pass / 0 fail / 0 skip（68.10s）**：本单三文件、409 PG 七入口探针、
dependency PG 端到端、第五轮 task wakeups，以及 458 的 SQLite/PG 人类
强制开工用例。事务帧 PG 证据仍是 D / W→D、最大深度 1。
合并态 `bunx tsc --noEmit` 为 0 error；CLI capability checker 仍是
**677 mapped / 92 exempt / 0 missing（769 routes）**，API route snapshot matches。

### 交付前再合 MUL-474

按父单补充要求再次 fetch，合入 `origin/main = 58bf5cc0`（MUL-474），
合并提交为 `5667c1fa`，没有文本冲突。`context.ts` 自动合并后同时保留
六字段 `TaskMessageFanoutSubject`、新增 Task identity/status 读接口，以及
本单的最外层 `afterCommit` 事件队列。`access-tokens-repo.ts` 相对 main
没有 diff；60 秒 last-used 节流保持 MUL-474 的实现。

在该合并态重跑本单/409/458 的八个定向文件，并增加 MUL-474 的 daemon
task-poll 和 token-throttle 两文件，真实 PG、哨兵开启、启动前清理
`MULTIREMI_TOKEN`：**243 pass / 0 fail / 0 skip（81.85s）**。
tsc 0 error，架构 92 pass，docs:check 通过，CLI checker 仍为
**677 mapped / 92 exempt / 0 missing（769 routes）**，API route snapshot matches。

前一次完整 PG 目录运行（`e5583b2a`，含 main 到 `b6bdcc51`）是
**3679 pass / 0 fail / 0 违例（828.25s）**；MUL-301 PG audit 实测
**11.32s**，本次没有复现第四轮超时。合 MUL-474 后再次顺序运行 PG 和
SQLite 完整目录，最终结果、20 轮手册和最新 head CI 见第五轮交付评论。

最后一次推送前 fetch 又得到 `0c2b3865`（MUL-449），无冲突合入为
`7652c963`；`context.ts` 的新增 Task claim surface 与队列代码同时保留。
再次运行上述十文件真实 PG 定向为 **243 pass / 0 fail（76.34s）**；
tsc、架构、文档、CLI checker 和路由快照仍通过。最终完整目录运行使用
这个代码合并结果。另校正 409 深度统计接口残留的“没有 SAVEPOINT”旧注释，
明确本分支的嵌套实现使用 SAVEPOINT，但 409 的 owner 路径仍断言深度 1；
此次仅改注释，不改事务边界或执行行为。
