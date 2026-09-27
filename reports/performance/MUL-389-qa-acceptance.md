# MUL-389 QA 独立验收报告

- 复核对象：`agent/MUL-389`，head `6f17863f`（代码 `585c5d7a`，报告 `6f17863f`）
- 前一轮复核的 `21470603` / `811ba95b` 结论已被本报告取代
- PR：https://github.com/Grassgod/Remi/pull/254（Draft，未转 Ready、未合入）
- CI：`Release build check` run **36250759530**（head `6f17863f`）**success**；`build` 任务内 `Backend test suite` 步骤 success（4637 pass / 6 skip / 0 fail）
- 执行环境：共享 checkout（未新建/切换分支），本地临时 PostgreSQL 18.4 仅监听 `127.0.0.1:55434`，用完已停并删除
- 结论：**通过**

## 1. 验收数字（裁决 `cmt_0xz79shqif5t` + 复裁 `cmt_4i1vbal7tpeq`）

全部取自 `bun run tests/manual/bench-daemon-heartbeat-claim.ts` 的 `queries` / `bytes`，`MUL389_BENCH_TOP_N=200`，3 个样本查询数逐样本一致。报告 JSON 为 `reports/performance/MUL-389-heartbeat-claim-after.json`。

| 验收项 | 场景 / 读法 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| 典型 heartbeat | `heartbeat.idle` `queries` | ≤ 31 | **31** | 通过 |
| 最坏 heartbeat | `heartbeat.worst_case_with_side_channels` `queries` | ≤ 55 | **50** | 通过 |
| 待办 poll 结构 | `heartbeat.idle` 中触及 7 张待办表的语句数 | = 1 | **1** | 通过 |
| 待办 poll 增量 | `store_only.pending.every_family − store_only.idle` | ≤ 20 | 28 − 14 = **14** | 通过 |
| claim 过桥字节 | `claim.mixed_workspace` `bytes` | < 1MB | **439,784** | 通过 |
| CI | PR 的 `Release build check` 在被复核 SHA 上 | 绿 | run **36250759530** success | 通过 |

`heartbeat.idle` / `worst_case_with_side_channels` / `store_only.idle` / `store_only.pending.every_family` / `claim.mixed_workspace` 的 `dbq` 与 `bytes` 与我本地跑出的 JSON 逐场景一致（31 / 5924、50 / 18230、14 / 2538、28 / 6271、309 / 439784）。

数字演进链（同一 harness，逐个 commit 实测，不是转述）：

| commit | `heartbeat.idle` | `worst_case_with_side_channels` | `claim.mixed_workspace` |
| --- | ---: | ---: | ---: |
| `21470603` | 29 | 47 | 307 / 438,486 B |
| `62cf6ef7` | 31 | 50 | 308 / 439,135 B |
| `585c5d7a` | **31** | **50** | **309 / 439,784 B** |

即：事务换代让 heartbeat 从 29 涨到 31（两条锁后重读），锁换代让 claim 从 308 涨到 309（+649 B，一行 Runtime）。两者都与说明一致。

## 2. 落地条件 2：缓存换代点移到「事务内第一次拿锁」

机制（读了实现，不是只看注释）：

- `request-read-cache.ts` 的 `MapReadCache` 带 `generation` 与 `transactionDepth`。`get` 在事务内只返回 `generation` 与当前代相同的条目；`enterTransaction` 在最外层事务开始时加代，`lockTaken` 在事务内加代，`leaveTransaction(committed=false)` 清空整个缓存。
- `invalidatingDatabase` 包装 `transaction`，用 `withinTransaction` 把 BEGIN 到 COMMIT 圈进一代，提交后保留事务内读到的行供同一请求后续使用，失败（含 COMMIT 抛错）清空。
- `markRequestReadCacheLockTaken()` 的调用点只有 `lockWorkspaceRuntimeLifecycle`（`context.ts:591`）与 `lockAgentPluginWorkspace`（`agent-plugins-repo.ts:124`），`585c5d7a` 的代码改动也只在 `request-read-cache.ts`、这两个 helper 与测试内，符合复裁的范围约束。

测试与变异（本机实跑）：

- `tests/unit/multiremi/multiremi-request-read-cache.test.ts` → **11 pass / 0 fail**，含复裁点名的两条：`never serves a row read before a lock to a read after it`、`re-reads a Runtime under each store lock even when the transaction read it first`。
- 变异 1：把 `MapReadCache.lockTaken` 改成空操作 → **2 fail**，正是上述两条（其余 9 条通过）。
- 变异 2（更强）：只把 `context.ts` 里 `lockWorkspaceRuntimeLifecycle` 的标记调用删掉 → **1 fail**，`re-reads a Runtime under each store lock...`。可见标记不是「加了就行」，缺一把锁也会红。
- 在真 PG 上复跑同语义（自建探针）：事务内先读 → 另一连接改行 → 拿锁 → 再读，第二次读到新值；锁前读与锁后读分别返回旧值与新值；失败事务回滚后缓存回到事务前的值。

## 3. 回归

| 命令 | 结果 |
| --- | --- |
| `bunx tsc --noEmit` | 通过（exit 0） |
| `bun run cli:capabilities:check` | `668 mapped / 91 exempt / 0 missing (759 routes)` |
| `bun test`（与 CI 同一命令，含 `tests/integration/`） | **4537 pass / 85 skip / 2 fail** |
| `bun test tests/integration/multiremi-daemon-smoke.test.ts` | **49 pass / 0 fail**，含 `re-registers and continues when heartbeat reports runtime_gone` |
| `bun test tests/unit/multiremi/`（无 PG） | 2970 pass / 85 skip / 0 fail |
| `bun test tests/unit/multiremi/`（**真 PG**） | **3050 pass / 0 skip / 0 fail** |
| 全部 PG 门控文件（6 个） | **106 pass / 0 fail** |
| CI `Release build check` on `6f17863f` | success（run 36250759530），`Backend test suite` 步骤 4637 pass / 6 skip / 0 fail |

2 条 fail 是 `safe-remove`（quarantine rename 失败时恢复 0555）与 `gc-policy`（单条删除失败后继续）——本机既有失败，在 base `a1e61623` 上以同样方式失败，CI 上不失败。**runtime_gone smoke 用例本地与 CI 均通过。**

## 4. 落地条件 3：报告里的语句表与归属

用 `MUL389_BENCH_TOP_N=200` 的本地 JSON 与报告逐行对照：

- 报告「`heartbeat.idle` after 的全部语句（31 条）」表：**26 行、合计 31 条**，与我的 26 个 distinct 语句、31 次执行**一一对应**（双向核对，报告没有多余行，我也没有多出的语句）。出现次数 > 1 的 4 个形状与我的一致：Runtime JOIN 行 ×3、本 daemon 的 `ssh_mesh_states` ×2、`relay_config` ×2（claude/codex 两个 engine）、workspace 生命周期锁自写 ×2。
- **Runtime ×3 归属用临时栈追踪独立复验**（本地一次性探针，未提交）：三条栈分别是 `denyDaemonTokenRuntimeIdentity`（`auth-guards.ts:777`）、heartbeat 事务内 `runtimes-repo.ts:1840`（栈内含 `transaction` → `withinTransaction` → `heartbeatRuntime`）、SSH mesh 事务内 `ssh-mesh-repo.ts:887`（经 `recordHeartbeat` ← `store.ts:1298` ← `transaction`）。与报告写的事务与锁完全一致。
- **worst-case `Runtime 行 ×5`**：同样用栈追踪复验，五条分别是鉴权、heartbeat 事务锁后重读、`withRuntimeLifecycleLock` 锁后重读（`runtimes-repo.ts:2261`，由 CLI update drain 触发）、SSH mesh 事务重读、路由组装响应（`daemon.ts:443`，drain ack 先写 Runtime 清缓存，所以是写后读）。与报告的五项构成一致。
- claim 的 `+2`：`21470603 → 62cf6ef7` 是事务开头 `tasks-repo.ts:1630` 的 `getRuntime` 不再用鉴权缓存；`62cf6ef7 → 585c5d7a` 是 `tasks-repo.ts:1644` 的锁后重读不再用 1630 的锁前行。我在 `21470603` / `62cf6ef7` / `585c5d7a` 三个 commit 上分别跑了同一 harness，得到 307 / 308 / 309，与该归属相符。

## 5. PG 与临时资源

- `postgresql-wheel` 在本机 PyPI 拉不到，改用 npm 的 `@embedded-postgres/linux-x64` 二进制，`unshare -U` 降权跑 `initdb`，起 PostgreSQL 18.4 只监听 `127.0.0.1:55434`。连接串只作为命令行环境变量传递，报告、评论、提交里无凭证。
- 用完 `pg_ctl stop` 并删除数据目录与 npm 包；已确认 55434 无监听、无残留 postgres 进程。临时 worktree 全部移除。

## 6. 边界与遗留

- heartbeat / claim 的性能数字仍是 **SQLite 计数代理**，不是 PG 桥实测；PG 真机只用于 SQL 正确性、并发与缓存语义，以及让 PG 门控用例实跑。
- **209 发版后的同源复核未做**：典型 heartbeat `dbq` p50 降幅 ≥ 50%（93 → 31 的代理降幅是 67%）。需发版后窗口，本单唯一未完成的验收环节。
- `safe-remove` / `gc-policy` 两条本地失败是本机既有问题，与改动无关，未修。
- 请求级缓存对 `multiremi_daemon_profiles` 写后同请求读仍存在理论缺口（缓存键挂在 `multiremi_runtimes` 上）；当前 daemon 请求路径不可达（唯一在请求内写该表的是 register 的 device-name upsert，发生在该请求第一次 Runtime 读之前），已用真实 HTTP 探针确认无陈旧读。
- 未做：PR 转 Ready、合入 main、209 任何写操作、`remi wiki push`；`./wiki` 未改。
