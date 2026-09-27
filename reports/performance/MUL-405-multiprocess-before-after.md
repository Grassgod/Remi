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
- 回归修复（createIssue 的实时推送改回提交后发布，MUL-400 S1 契约）：`3bd9d736`（当前 head）
