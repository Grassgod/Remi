# MUL-389 性能归因与前后对比（heartbeat 待办 poll 合并 + claim 只 hydrate 选中任务）

- 生成时间：2026-09-26
- 被测提交：`a1e61623`（分支 `agent/MUL-389`，Phase 0 归因时的 HEAD）
- 复现入口：`bun run tests/manual/bench-daemon-heartbeat-claim.ts`
  - 环境变量：`MUL389_BENCH_SAMPLES`（默认 3）、`MUL389_BENCH_TOP_N`（默认 12）、`MUL389_BENCH_OUTPUT`（默认 `/tmp/MUL-389-heartbeat-claim.json`）
  - 原始数据：`/tmp/MUL-389-heartbeat-claim.json`（本报告发布时另存 `reports/performance/MUL-389-heartbeat-claim-baseline.json`）
- 关联：父单 MUL-383 的 C.5 节（诊断评论 `cmt_eq02zhglhl3u`）、方案评论 `cmt_gstdr9auvjlm`

## 口径（重要，先读这一节）

1. **所有数字都是 SQLite 计数代理数字，不是 PG 实测。** 本机没有可用的本地 PostgreSQL（5432 关闭、不能用 docker），所以 heartbeat / claim 都在 `bun:sqlite` 的内存库上测，用一个 `Proxy` 包住 `SqlDatabase`：
   - `db_queries`（下表 `dbq`）＝ `query()`/`prepare()` 返回的 statement 上 `get`/`all`/`values`/`run` 的调用次数，加上直接 `db.run()` 的次数。
   - `db_bytes`（下表 `dbb`）＝ 每条语句返回值 `JSON.stringify({ rows, count })` 的 UTF-8 字节数。
     这是 PG 桥的**替身**：`packages/server/src/store/db/postgres.ts` 的 `PgBridge.request` 就是把 `JSON.stringify({rows, count})` 写进共享缓冲并把长度记为 `db_bytes`。因此 `dbb` 与生产 `Server-Timing` 的 `dbb` **同量纲、可同向比较，但不是同一个数**：SQLite 侧量的是同一份行数据的 JSON 体积，不包含 PG 行解码、`64MB` 共享缓冲拷贝和主线程 `TextDecoder`+`JSON.parse`。
   - 因此**不能**把这里的 `dbb=6.65MB` 与 C.5 观测到的生产 `bytes=5012751` 直接说成「同一指标」。生产 claim 观测值（445 查询 / 5.0MB / 3.87s）与本报告的 398 查询 / 6.65MB 属同一量级、同一构成，但两者的 fixture 不同。
2. **两条口径分开报。** 每个场景先报 HTTP 路由（`POST /api/daemon/heartbeat`、`POST /api/daemon/runtimes/:id/tasks/claim`）的总量，这是生产 `Server-Timing` 对齐的口径；再对 heartbeat 单独报 `store.heartbeatRuntime()` 的直调量，用来把「路由自身的成本」和「待办 poll 的成本」分开。claim 没有单独报 store 口径，因为 router 里额外做的 `getTask` 仍在同一事务口径内。
3. **认证确实被计入了。** HTTP 场景用真实 daemon access token 走完整中间件（`verifyAccessToken` 的 SELECT + `last_used_at` UPDATE 都在数里）。
4. 每个场景重建 fixture（内存 SQLite + 全新 store + 真实 token），**样本 3 次，查询数必须逐次完全相同**，否则脚本直接报错退出；表里的 `wall_ms` 是首次样本的墙钟时间，仅作参考（SQLite 是进程内读，不具备生产 PG 桥的阻塞时间）。
5. 知识内容是**真造的**：Project Wiki / Repository Wiki 通过 `ProjectKnowledgeService` / `RepositoryWikiService` 的 openviking 模式写入，配一个内存 stub OpenViking client，所以 claim 真的会下发 Wiki 正文，服务端也真的会去读那些控制面行。
6. 日志、评论、本报告不含任何 token 或凭证。

## Phase 0 归因结论

### heartbeat：一次 HTTP heartbeat 有 93 条查询，其中 36 条是路由自身的

`heartbeat.store_only.idle` 是 57 条，而 `heartbeat.idle`（HTTP）是 93 条，差值 36 条全部来自 `POST /api/daemon/heartbeat` 路由在 `heartbeatRuntime` 之外做的事，而且是**每次心跳固定发生、与待办队列无关**：

- `SELECT runtime.*, profile...`（runtime 读取，含 daemon profile join）与配套的 `SELECT * FROM multiremi_runtimes WHERE id = ?`、execution group、runtime models、`multiremi_tasks` usage 扫描：这些随 `getRuntime` 一起被反复调用（idle 口径下同一形状出现 7 次）；
- `multiremi_workspace_ssh_mesh` / `multiremi_daemon_ssh_mesh_states`：ssh mesh 心跳；
- `multiremi_workspace_members` / `multiremi_workspaces`：`workspaceReposResponse` 与 `callerCanReceiveRelay`；
- `UPDATE multiremi_workspaces SET updated_at = updated_at`：生命周期行锁；
- platform maintenance 的读写。

**这意味着 `db_queries ≤ 20` 这个目标，光砍待办 poll 是达不到的**：idle 状态下路由已经用掉 93 条，其中 36 条不属于 poll。要达到目标，需要把「每次心跳重复 read runtime + workspace + usage」这条链一并收掉（同一事务里复用已读行），而不是只把 7 个 family 合成 1 个 probe。本报告的 after 列会在实现后按这个拆分重新填。

### heartbeat：待办 poll 的形状与最大头

`heartbeat.store_only.pending.every_family`（7 个 family 各一条 `pending`，无插件状态）＝ **87 条查询**；`heartbeat.store_only.idle` ＝ **57 条**。两者之差 30 条是「有 pending 时才会走的 claim 路径」。

单 family 命中时（`heartbeat.store_only.pending.*`）是 **61–63 条**：每个命中的 family 走一次 `RuntimeRequestQueue.claim`，形状是 `expire`（2 条 UPDATE）+ 1 条 SELECT pending + 1 条 UPDATE running + `get()` 再 `expire`（2 条 UPDATE）+ 1 条 SELECT by id = 7 条，与方案里的代码阅读一致。也说明**空队列也要付 2 条 expire UPDATE**：idle 的 57 条里有 7×2 = 14 条是空扫。

worst case（`heartbeat.store_only.worst_case`，127 条）里最大的两块是：

- **batch import 10 条 = 32 条查询**：`expire` 2 + 1 条 `LIMIT 10` 的 SELECT + **10 条逐行 UPDATE** + 10 次 `get()`（每次再 2 条 expire + 1 条 SELECT by id）≈ 2 + 1 + 10 + 30 = 43 条中的绝大部分（顶层表里 `SELECT * FROM multiremi_runtime_local_skill_import_requests WHERE id = ?` 10 次、两条 timeout UPDATE 各 11 次、running UPDATE 10 次）。这是「一条 SQL 变十条」的典型 N+1。
- **插件状态 = 4 条 `pending_heartbeat_count` UPDATE + 两次全量状态 SELECT**（`SELECT * FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ? AND desired = 1` 出现 2 次、`WHERE workspace_id = ?` 1 次，外加 reconcile 的 bindings / task snapshot / runtimes / lock SELECT），即方案里说的「1 UPDATE per pending state row」。

### claim：6.65MB 过桥字节里 6.5MB 是候选 Agent 的技能文件

`claim.mixed_workspace` ＝ **398 条查询 / 6,650,345 字节**。逐条归因：

| 语句 | 次数 | 字节 | 说明 |
| --- | ---: | ---: | --- |
| `SELECT * FROM multiremi_skill_files WHERE skill_id = ? ORDER BY path ASC` | 21 | 6,497,820 | **占全部字节的 97.7%** |
| `SELECT p.*, COUNT(i.id) ... FROM multiremi_projects ...` | 57 | 29,925 | 项目列表聚合，被反复调用 |
| `SELECT * FROM multiremi_agents WHERE id = ?` / `... WHERE id = ? AND archived_at IS NULL` | 34 | 22,938 | 同一批 Agent 被重复 hydrate |
| `SELECT * FROM multiremi_project_resources ...` | 26 | 7,202 | |
| `SELECT s.* FROM multiremi_skills ...` | 21 | 5,670 | |
| `SELECT issue_id FROM multiremi_feishu_bot_chat_bindings ...` | 28 | 588 | 每个 queued chat turn 一次 |
| `SELECT execution_fingerprint, work_dir, runtime_id FROM multiremi_tasks WHERE chat_session_id = ...` | 24 | 504 | 同上 |

关键事实：

1. **单个被选中任务的技能文件只有 ~309KB**（`skill_file_bytes=309355`），最终整个 HTTP 响应是 **610KB**（`response_bytes=610131`，含 9 篇 project wiki 148KB + 8 篇 repo wiki 146KB）。也就是说 6.65MB 里 5.8MB 是**为了淘汰候选而 hydrate 出来的、最后被丢掉**的字节。
2. N+1 不在「选行」而在「eligibility 扫描」：`getAgent`（skills+files）、`runtimeCanRunAgent`（重建 catalog）、`refreshQueuedChatAffinity`（每个 queued chat turn 都 `getTask` + `getChatSession` + `getAgent` + plugin snapshot）、`getTaskWithAgent` 跑两遍、router 再 `getTask` 一次。这与方案里的代码阅读**完全一致**，并且把 C.5 评论里「445 条只有总数、没有逐查询归因」的空白补上了。
3. 因此 **Phase 2 的 `dbb < 1MB` 只要把 eligibility 阶段的技能文件读掉就能达成**（6.65MB → 0.61MB 量级），不需要动协议；byte cap 是第二个保险，因为知识正文（本 fixture 里 ~295KB）在真实项目里可以轻易超过 1MB。

## 延迟上界

**不变：一条待办从入队到被 daemon 取走，上界仍是「下一次心跳」。** 合并后的 probe 只决定「这次心跳要不要进某个 family 的 claim 路径」，**不做每 N 次心跳才 poll 的降频**（ADR 0001 里那条可选项在本次实现里不采用）。心跳间隔不变，所以协议字段也没变：`ack.pending_*` 一个字段都不增不减，老 daemon 不受影响。

## Phase 0 原始表格（after 列留空，Phase 1/2 完成后回填）

### HTTP route

| scenario | fixture | dbq before | dbb before | wall ms before | dbq after | dbb after | wall ms after |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `heartbeat.idle` | 7 queues empty, plugin protocol advertised | 93 | 12437 | 19 |  |  |  |
| `heartbeat.pending.update` | one `pending` row: CLI update | 99 | 13117 | 6.5 |  |  |  |
| `heartbeat.pending.model_list` | one `pending` row: model list | 97 | 12965 | 6.8 |  |  |  |
| `heartbeat.pending.command` | one `pending` row: command | 97 | 13341 | 6.2 |  |  |  |
| `heartbeat.pending.bot_menu` | one `pending` row: bot menu publish | 97 | 13229 | 6.1 |  |  |  |
| `heartbeat.pending.local_skills` | one `pending` row: local skill list | 97 | 13021 | 6.6 |  |  |  |
| `heartbeat.pending.directory_scan` | one `pending` row: directory scan | 97 | 13101 | 6.2 |  |  |  |
| `heartbeat.pending.local_skill_import` | one `pending` row: local skill import | 97 | 13167 | 7.1 |  |  |  |
| `heartbeat.worst_case` | every flag on, 4 `pending` plugin states, 10-item batch import, ssh mesh + drain + concierge | 168 | 31806 | 11.2 |  |  |  |

### Store call only (`store.heartbeatRuntime`)

| scenario | fixture | dbq before | dbb before | wall ms before | dbq after | dbb after | wall ms after |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `heartbeat.store_only.idle` | same as idle, store call only | 57 | 6198 | 1.9 |  |  |  |
| `heartbeat.store_only.pending.update` | same as one pending update, store call only | 63 | 6878 | 1.8 |  |  |  |
| `heartbeat.store_only.pending.every_family` | one `pending` row in all 7 families, store call only | 87 | 11080 | 2.8 |  |  |  |
| `heartbeat.store_only.worst_case` | same as worst case, store call only | 127 | 24699 | 3.6 |  |  |  |

### Claim

| scenario | fixture | dbq before | dbb before | wall ms before | dbq after | dbb after | wall ms after |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `claim.mixed_workspace` | 5 agents with ~300 KiB skill files, 4 profile tasks, 4 queued chat turns, 9 project wiki docs, 8 repository wiki docs | 398 | 6650345 | 56.3 |  |  |  |

#### `heartbeat.store_only.worst_case` top statements

| statement | count | bytes |
| --- | ---: | ---: |
| `UPDATE multiremi_runtime_local_skill_import_requests SET status = 'timeout', error = 'daemon did not finish within 60 se` | 11 | 231 |
| `UPDATE multiremi_runtime_local_skill_import_requests SET status = 'timeout', error = 'daemon did not respond within 3 mi` | 11 | 231 |
| `SELECT * FROM multiremi_runtime_local_skill_import_requests WHERE id = ? AND runtime_id = ?` | 10 | 3550 |
| `UPDATE multiremi_runtime_local_skill_import_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id` | 10 | 210 |
| `SELECT runtime.*, profile.display_name AS daemon_display_name FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon` | 5 | 3340 |
| `SELECT group_id FROM multiremi_execution_group_members WHERE runtime_id = ? ORDER BY provider` | 5 | 355 |
| `SELECT * FROM multiremi_runtime_models WHERE runtime_id = ? ORDER BY is_default DESC, label ASC` | 5 | 105 |
| `SELECT id, status, usage FROM multiremi_tasks WHERE runtime_id = ?` | 5 | 105 |
| `UPDATE multiremi_agent_plugin_runtime_states SET pending_heartbeat_count = ? WHERE id = ?` | 4 | 84 |
| `SELECT * FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ? AND desired = 1` | 2 | 3864 |

#### `heartbeat.store_only.pending.every_family` top statements

| statement | count | bytes |
| --- | ---: | ---: |
| `SELECT runtime.*, profile.display_name AS daemon_display_name FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon` | 5 | 3125 |
| `SELECT group_id FROM multiremi_execution_group_members WHERE runtime_id = ? ORDER BY provider` | 5 | 355 |
| `SELECT * FROM multiremi_runtime_models WHERE runtime_id = ? ORDER BY is_default DESC, label ASC` | 5 | 105 |
| `SELECT id, status, usage FROM multiremi_tasks WHERE runtime_id = ?` | 5 | 105 |
| `SELECT * FROM multiremi_runtimes WHERE id = ?` | 2 | 1196 |
| `SELECT * FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ? AND desired = 1` | 2 | 42 |
| `UPDATE multiremi_bot_menu_publish_requests SET status = 'timeout', error = 'bot menu publish did not finish within 5 min` | 2 | 42 |
| `UPDATE multiremi_bot_menu_publish_requests SET status = 'timeout', error = 'bot menu publisher did not respond within 3 ` | 2 | 42 |
| `UPDATE multiremi_runtime_command_requests SET status = 'timeout', error = 'daemon did not finish the command within 20 m` | 2 | 42 |
| `UPDATE multiremi_runtime_command_requests SET status = 'timeout', error = 'daemon did not respond within 3 minutes', upd` | 2 | 42 |
| `UPDATE multiremi_runtime_directory_scan_requests SET status = 'timeout', error = 'daemon did not finish within 60 second` | 2 | 42 |
| `UPDATE multiremi_runtime_directory_scan_requests SET status = 'timeout', error = 'daemon did not respond within 3 minute` | 2 | 42 |
| `UPDATE multiremi_runtime_local_skill_import_requests SET status = 'timeout', error = 'daemon did not finish within 60 se` | 2 | 42 |
| `UPDATE multiremi_runtime_local_skill_import_requests SET status = 'timeout', error = 'daemon did not respond within 3 mi` | 2 | 42 |

#### `claim.mixed_workspace` top statements

| statement | count | bytes |
| --- | ---: | ---: |
| `SELECT p.*, COUNT(i.id) AS issue_count, COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0` | 57 | 29925 |
| `SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ? AND issue_id IS NOT NULL ORDER BY crea` | 28 | 588 |
| `SELECT * FROM multiremi_project_resources WHERE project_id = ? ORDER BY position ASC, created_at ASC, id ASC` | 26 | 7202 |
| `SELECT execution_fingerprint, work_dir, runtime_id FROM multiremi_tasks WHERE chat_session_id = ? AND issue_id IS NULL A` | 24 | 504 |
| `SELECT * FROM multiremi_skill_files WHERE skill_id = ? ORDER BY path ASC` | 21 | 6497820 |
| `SELECT s.* FROM multiremi_skills s JOIN multiremi_agent_skills aks ON aks.skill_id = s.id WHERE aks.agent_id = ? AND s.a` | 21 | 5670 |
| `SELECT id FROM multiremi_skills WHERE id = ? AND archived_at IS NULL` | 21 | 966 |
| `SELECT * FROM multiremi_agents WHERE id = ? AND archived_at IS NULL` | 18 | 12114 |
| `SELECT * FROM multiremi_agents WHERE id = ?` | 16 | 10824 |
| `SELECT runtime.*, profile.display_name AS daemon_display_name FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon` | 11 | 7139 |
| `SELECT id, status, usage FROM multiremi_tasks WHERE runtime_id = ?` | 11 | 5871 |
| `SELECT group_id FROM multiremi_execution_group_members WHERE runtime_id = ? ORDER BY provider` | 11 | 781 |

claim response: {"status": 200, "claimed_task_id": "tsk_jrfusyaw21it", "claimed_agent_id": "agt_bench_0", "response_bytes": 610131, "skill_file_bytes": 309355, "project_wiki_docs": 9, "project_wiki_bytes": 148764, "repository_wiki_docs": 8, "repository_wiki_bytes": 145735, "knowledge_warnings": 0}

## 发版后在 209 复核的注意事项

- 209 是**只读**：只跑 `docker logs` 与只读 API 探测，不改配置、不重启服务、不写库。
- 复核要看的是生产 `Server-Timing` 的 `dbq` / `dbb`，和本报告的计数口径不同源，因此**只对比同源前后**：先记录复核前窗口的 `api_slow_request` 与 `api_minute_summary` 基线，再比发版后的同一 route（`/api/daemon/heartbeat`、`/api/daemon/runtimes/:runtimeId/tasks/claim`）。
- 需要特别确认：C.5 那次最坏 claim 是 `q=445 bytes=5012751 total=3866ms db_ms=278`。发版后同类请求的 `dbb` 应当显著低于此值；若 `dbb` 仍 >1MB，先看是不是 byte cap 没触发（Wiki 正文本来就不大）而 eligibility 重复读仍在。
- 生产 heartbeat 的最坏值受「workspace 里有多少 runtime / task / member」影响，本报告的 fixture 是单个 runtime + 单个 workspace，比 209 干净，比较时以相对降幅为准。
- PG 专项测试（`tests/unit/multiremi/multiremi-postgres-store.test.ts` 等）在本地因不可达而跳过，需要在 209 或 CI 上确认 `RETURNING` / `WHERE id IN (...)` 的 PG 路径。
