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
- `api_minute_summary` / `api_slow_request` 的 `pid` 字段：等 MUL-386（PR #255）合入 main 后单独做，不在本 PR。
- 发布后在 209 只读确认两个容器的启动日志都没有迁移报错：属于上线后动作，不在本 PR 范围。
