# MUL-389 性能归因与前后对比（heartbeat 待办 poll 合并 + claim 只 hydrate 选中任务）

- 生成时间：2026-09-26
- before 提交：`a1e61623`（`agent/MUL-389` 的起点；harness 在 Phase 0 提交 `d17337f4` 里加入，该提交不改生产代码）；after 提交：`21470603`
- 复现入口：`bun run tests/manual/bench-daemon-heartbeat-claim.ts`
  - 环境变量：`MUL389_BENCH_SAMPLES`（默认 3）、`MUL389_BENCH_TOP_N`（默认 12）、`MUL389_BENCH_OUTPUT`（默认 `/tmp/MUL-389-heartbeat-claim.json`）
  - 原始数据：before `reports/performance/MUL-389-heartbeat-claim-baseline.json`、after `reports/performance/MUL-389-heartbeat-claim-after.json`（同一个 harness、同一台机器的完整运行结果；after 用 `MUL389_BENCH_TOP_N=200` 跑，逐条语句全量列出）
- 关联：父单 MUL-383 的 C.5 节（诊断评论 `cmt_eq02zhglhl3u`）、方案评论 `cmt_gstdr9auvjlm`、验收口径裁决 `cmt_0xz79shqif5t`（Senior大哥）

## 口径（重要，先读这一节）

1. **所有数字都是 SQLite 计数代理数字，不是 PG 实测。** 本机没有可长期使用的本地 PostgreSQL，所以 heartbeat / claim 都在 `bun:sqlite` 的内存库上测，用一个 `Proxy` 包住 `SqlDatabase`：
   - `db_queries`（下表 `dbq`）＝ `query()`/`prepare()` 返回的 statement 上 `get`/`all`/`values`/`run` 的调用次数，加上直接 `db.run()` 的次数。
   - `db_bytes`（下表 `dbb`）＝ 每条语句返回值 `JSON.stringify({ rows, count })` 的 UTF-8 字节数。
     这是 PG 桥的**替身**：`packages/server/src/store/db/postgres.ts` 的 `PgBridge.request` 就是把 `JSON.stringify({rows, count})` 写进共享缓冲并把长度记为 `db_bytes`。因此 `dbb` 与生产 `Server-Timing` 的 `dbb` **同量纲、可同向比较，但不是同一个数**：SQLite 侧量的是同一份行数据的 JSON 体积，不包含 PG 行解码、`64MB` 共享缓冲拷贝和主线程 `TextDecoder`+`JSON.parse`。
   - 因此**不能**把这里的 `dbb=6.65MB` 与 C.5 观测到的生产 `bytes=5012751` 直接说成「同一指标」。生产 claim 观测值（445 查询 / 5.0MB / 3.87s）与本报告的 398 查询 / 6.65MB 属同一量级、同一构成，但两者的 fixture 不同。
2. **两条口径分开报。** 每个场景先报 HTTP 路由（`POST /api/daemon/heartbeat`、`POST /api/daemon/runtimes/:id/tasks/claim`）的总量，这是生产 `Server-Timing` 对齐的口径；再对 heartbeat 单独报 `store.heartbeatRuntime()` 的直调量，用来把「路由自身的成本」和「待办 poll 的成本」分开。claim 没有单独报 store 口径，因为 router 里额外做的 `getTask` 仍在同一事务口径内。
3. **认证确实被计入了。** HTTP 场景用真实 daemon access token 走完整中间件（`verifyAccessToken` 的 SELECT + `last_used_at` UPDATE 都在数里）。
4. 每个场景重建 fixture（内存 SQLite + 全新 store + 真实 token），**样本 3 次，查询数必须逐次完全相同**，否则脚本直接报错退出。`wall_ms` 只在原始 JSON 里保留、不进表：SQLite 是进程内读，不具备生产 PG 桥的阻塞时间，墙钟没有比较意义。
5. 知识内容是**真造的**：Project Wiki / Repository Wiki 通过 `ProjectKnowledgeService` / `RepositoryWikiService` 的 openviking 模式写入，配一个内存 stub OpenViking client，所以 claim 真的会下发 Wiki 正文，服务端也真的会去读那些控制面行。
6. 日志、评论、本报告不含任何 token 或凭证；原始 JSON 只有归一化后的 SQL 文本（参数全是 `?`）、次数与字节数，不含行内容。

## Phase 0 归因结论

### heartbeat：一次 HTTP heartbeat 有 93 条查询，其中 36 条是路由自身的

`heartbeat.store_only.idle` 是 57 条，而 `heartbeat.idle`（HTTP）是 93 条，差值 36 条全部来自 `POST /api/daemon/heartbeat` 路由在 `heartbeatRuntime` 之外做的事，而且是**每次心跳固定发生、与待办队列无关**：

- `SELECT runtime.*, profile...`（runtime 读取，含 daemon profile join）与配套的 `SELECT * FROM multiremi_runtimes WHERE id = ?`、execution group、runtime models、`multiremi_tasks` usage 扫描：这些随 `getRuntime` 一起被反复调用（idle 口径下同一形状出现 7 次）；
- `multiremi_workspace_ssh_mesh` / `multiremi_daemon_ssh_mesh_states`：ssh mesh 心跳；
- `multiremi_workspace_members` / `multiremi_workspaces`：`workspaceReposResponse` 与 `callerCanReceiveRelay`；
- `UPDATE multiremi_workspaces SET updated_at = updated_at`：生命周期行锁；
- platform maintenance 的读写。

所以原验收「heartbeat 最坏 `db_queries ≤ 20`」光砍待办 poll 是达不到的，这一点后来由裁决 `cmt_0xz79shqif5t` 换成了新的验收口径（见「达标情况」）。

### heartbeat：待办 poll 的形状与最大头

`heartbeat.store_only.pending.every_family`（7 个 family 各一条 `pending`，无插件状态）＝ **87 条查询**；`heartbeat.store_only.idle` ＝ **57 条**。两者之差 30 条是「有 pending 时才会走的 claim 路径」。

单 family 命中时（`heartbeat.store_only.pending.*`）是 **61–63 条**：每个命中的 family 走一次 `RuntimeRequestQueue.claim`，形状是 `expire`（2 条 UPDATE）+ 1 条 SELECT pending + 1 条 UPDATE running + `get()` 再 `expire`（2 条 UPDATE）+ 1 条 SELECT by id = 7 条，与方案里的代码阅读一致。

**空队列也要付全部扫描**：用 `MUL389_BENCH_TOP_N=200` 在 `d17337f4` 上全量列出 `heartbeat.idle` 的语句，触及 7 张待办表的语句有 **23 条**——7 个 family × 2 条 timeout UPDATE（14）+ 7 条 `SELECT … status = 'pending'`（7）+ CLI update 的 `SELECT id, scope …`（1）+ command 的 scrub UPDATE（1）。

worst case（`heartbeat.store_only.worst_case`，127 条）里最大的两块是：

- **batch import 10 条**：`expire` 2 + 1 条 `LIMIT 10` 的 SELECT + **10 条逐行 UPDATE** + 10 次 `get()`（每次再 2 条 expire + 1 条 SELECT by id）（顶层表里 `SELECT * FROM multiremi_runtime_local_skill_import_requests WHERE id = ?` 10 次、两条 timeout UPDATE 各 11 次、running UPDATE 10 次）。这是「一条 SQL 变十条」的典型 N+1。
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
3. 因此 `dbb < 1MB` 只要把 eligibility 阶段的技能文件读掉就能达成（6.65MB → 0.61MB 量级），不需要动协议；byte cap 是第二个保险，因为知识正文（本 fixture 里 ~295KB）在真实项目里可以轻易超过 1MB。

## 延迟上界

**不变：一条待办从入队到被 daemon 取走，上界仍是「下一次心跳」。**

- 合并后的 probe 只决定「这次心跳要不要进某个 family 的 claim 路径」，每次心跳都跑，**不做每 N 次心跳才 poll 的降频**（裁决已明确作废该选项）。
- probe 与随后的 claim 在同一次心跳、同一个请求里执行；probe 说某 family 有 `pending` 行，本次心跳就 claim。probe 之后才入队的行（probe 时不存在），在旧实现里同样要等到下一次心跳，所以上界没有变长。
- deadline sweep 只在 probe 证明「这个 family 没有已过期的 `pending` 行、也没有超时的 `running` 行」时才跳过。只要有过期行，哪怕没有可 claim 的行，这个 family 也照样进 claim 路径、先做 sweep，所以过期行仍在下一次心跳被置为 `timeout`，与旧实现一致（`cd80d24d` 修复，见 Phase 3 第 5 条）。
- 心跳间隔不变，协议字段也没变：`ack.pending_*` 一个字段都不增不减，老 daemon 不受影响。

## 实现后的前后对比

before 与 after 是**同一个 harness、同一台机器、各 3 个样本**（查询数逐样本完全一致）。

### HTTP route（与生产 `Server-Timing` 对齐的口径）

| scenario | fixture | dbq before | dbb before | dbq after | dbb after |
| --- | --- | ---: | ---: | ---: | ---: |
| `heartbeat.idle` | 7 queues empty, plugin protocol advertised | 93 | 12437 | **29** | 4637 |
| `heartbeat.pending.update` | one `pending` row: CLI update | 99 | 13117 | 34 | 5058 |
| `heartbeat.pending.model_list` | one `pending` row: model list | 97 | 12965 | 30 | 4891 |
| `heartbeat.pending.command` | one `pending` row: command | 97 | 13341 | 31 | 5100 |
| `heartbeat.pending.bot_menu` | one `pending` row: bot menu publish | 97 | 13229 | 30 | 5023 |
| `heartbeat.pending.local_skills` | one `pending` row: local skill list | 97 | 13021 | 30 | 4919 |
| `heartbeat.pending.directory_scan` | one `pending` row: directory scan | 97 | 13101 | 30 | 4959 |
| `heartbeat.pending.local_skill_import` | one `pending` row: local skill import | 97 | 13167 | 30 | 4992 |
| `heartbeat.worst_case` | every flag on, 4 `pending` plugin states, 10-item batch import | 163 | 31692 | 42 | 15091 |
| `heartbeat.worst_case_with_side_channels` | same + ssh mesh, drain ack, concierge protocol | 168 | 31806 | **47** | 15950 |

### Store call only (`store.heartbeatRuntime`)

| scenario | fixture | dbq before | dbb before | dbq after | dbb after |
| --- | --- | ---: | ---: | ---: | ---: |
| `heartbeat.store_only.idle` | queues empty | 57 | 6198 | 14 | 2538 |
| `heartbeat.store_only.pending.update` | one pending update | 63 | 6878 | 21 | 4209 |
| `heartbeat.store_only.pending.model_list` | one pending model list | 61 | 6726 | 15 | 2792 |
| `heartbeat.store_only.pending.command` | one pending command | 61 | 7102 | 16 | 3001 |
| `heartbeat.store_only.pending.bot_menu` | one pending bot menu publish | 61 | 6990 | 15 | 2924 |
| `heartbeat.store_only.pending.local_skills` | one pending local skill list | 61 | 6782 | 15 | 2820 |
| `heartbeat.store_only.pending.directory_scan` | one pending directory scan | 61 | 6862 | 15 | 2860 |
| `heartbeat.store_only.pending.local_skill_import` | one pending local skill import | 61 | 6928 | 15 | 2893 |
| `heartbeat.store_only.pending.every_family` | one `pending` row in all 7 families | 87 | 11080 | 28 | 6271 |
| `heartbeat.store_only.worst_case` | worst case | 127 | 24699 | 29 | 16134 |
| `heartbeat.store_only.worst_case_with_side_channels` | worst case + side channels | 127 | 24699 | 29 | 16134 |

### Claim

| scenario | fixture | dbq before | dbb before | dbq after | dbb after |
| --- | --- | ---: | ---: | ---: | ---: |
| `claim.mixed_workspace` | 5 agents w/ ~300 KiB skill files, 4 profile tasks, 4 chat turns, 9 project wiki docs + 8 repo wiki docs | 398 | 6650345 | 307 | **438486** |

after 的 claim 响应：`status=200`、`response_bytes=610131`、`skill_file_bytes=309355`、project wiki 9 篇 / 148764 字节、repo wiki 8 篇 / 145735 字节、`knowledge_warnings=0`。与 before 逐项相同——下发给 daemon 的内容没变，省掉的全是过桥后被丢弃的字节。本 fixture 的知识正文不触发 512 KiB cap，cap 的行为由单测覆盖（见「测试」）。

### 达标情况

验收口径按 Senior大哥的裁决 `cmt_0xz79shqif5t`（替代原「heartbeat 最坏 `db_queries ≤ 20`」），所有数字都从 `tests/manual/bench-daemon-heartbeat-claim.ts` 输出的 `queries` / `bytes` 字段读取。

| 验收项 | 场景 / 读法 | before | after | 目标 | 结论 |
| --- | --- | ---: | ---: | --- | --- |
| 典型 heartbeat | `heartbeat.idle` | 93 | **29** | ≤ 30 | ✅ 达标（−68.8%） |
| 最坏 heartbeat | `heartbeat.worst_case_with_side_channels` | 168 | **47** | ≤ 55 | ✅ 达标（−72.0%） |
| 待办 poll 合并 | `heartbeat.idle` 里触及 7 张待办表的语句数 | 23 | **1**（`UNION ALL` probe） | = 1 | ✅ 达标；`multiremi-heartbeat-poll-merge.test.ts` 有结构断言锁定 |
| 待办 poll 增量 | `store_only.pending.every_family − store_only.idle` | 30 | **14** | ≤ 20 | ✅ 达标 |
| claim 过桥字节 | `claim.mixed_workspace` 的 `bytes` | 6,650,345 | **438,486** | < 1MB | ✅ 达标（−93.4%） |

裁决的推翻条件都没有触发：idle 已经 ≤ 30，不需要改用「去重后剩余语句数」作为目标；209 的复核条件见文末。

为什么原来的「≤ 20」要换掉（详见裁决）：7 个 family 全有待办时，一次请求至少要写 7 张表 7 次，加上 probe、插件批量写、workspace 级 reconcile、runtime 读/写/锁和鉴权，下界约 27 条。所以整请求最坏值在任何方案下都到不了 20。revision gating 只能省「没变化」的路径，而最坏值正是「全都变了」的路径。

#### `heartbeat.idle` after 的全部语句（29 条）

| statement | count | bytes |
| --- | ---: | ---: |
| `SELECT * FROM multiremi_daemon_ssh_mesh_states WHERE workspace_id = ? AND daemon_id = ?` | 2 | 622 |
| `SELECT fragment, auth_token, revision FROM multiremi_relay_config WHERE workspace_id = ? AND engine = ?` | 2 | 42 |
| `UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?` | 2 | 42 |
| `SELECT * FROM multiremi_runtimes WHERE COALESCE(workspace_id, 'local') = ?` | 1 | 635 |
| `SELECT runtime.*, profile.display_name AS daemon_display_name FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon…` | 1 | 625 |
| `SELECT state.* FROM multiremi_daemon_ssh_mesh_states state WHERE state.workspace_id = ? AND ( COALESCE(state.node_kind, …` | 1 | 601 |
| `SELECT 'update' AS family, EXISTS (SELECT 1 FROM multiremi_runtime_update_requests …) … UNION ALL …`（合并 probe） | 1 | 480 |
| `SELECT * FROM multiremi_access_tokens WHERE token_hash = ?` | 1 | 422 |
| `SELECT * FROM multiremi_workspace_members WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC` | 1 | 252 |
| `SELECT * FROM multiremi_workspaces WHERE id = ?` | 1 | 250 |
| `SELECT * FROM multiremi_platform_maintenance WHERE id = 'platform'` | 1 | 219 |
| `SELECT id, name, daemon_id, status, last_heartbeat_at FROM multiremi_runtimes r WHERE COALESCE(workspace_id, 'local') = …` | 1 | 153 |
| `INSERT INTO multiremi_agent_plugin_workspace_locks … ON CONFLICT(workspace_id) DO NOTHING` | 1 | 21 |
| `INSERT INTO multiremi_daemon_ssh_mesh_states (…) …` | 1 | 21 |
| `INSERT INTO multiremi_platform_maintenance (…) VALUES ('platform', 'normal', …) ON CONFLICT(id) DO NOTHING` | 1 | 21 |
| `SELECT * FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ? AND desired = 1` | 1 | 21 |
| `SELECT * FROM multiremi_agent_plugin_runtime_states WHERE workspace_id = ?` | 1 | 21 |
| `SELECT * FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?` | 1 | 21 |
| `SELECT DISTINCT snapshot.plugin_id, snapshot.version_id, snapshot.provider FROM multiremi_task_plugin_snapshots …` | 1 | 21 |
| `SELECT id, pending_heartbeat_count FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ? AND desired = 1 AND …` | 1 | 21 |
| `SELECT p.id AS plugin_id, p.active_version_id, … FROM multiremi_agent_plugin_bindings …` | 1 | 21 |
| `SELECT profile FROM multiremi_runtime_claude_profiles WHERE runtime_id = ?` | 1 | 21 |
| `SELECT profile FROM multiremi_runtime_codex_profiles WHERE runtime_id = ?` | 1 | 21 |
| `UPDATE multiremi_access_tokens SET last_used_at = ? WHERE id = ?` | 1 | 21 |
| `UPDATE multiremi_agent_plugin_workspace_locks SET updated_at = ? WHERE workspace_id = ?` | 1 | 21 |
| `UPDATE multiremi_runtimes SET status = 'online', metadata = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?` | 1 | 21 |

还剩 3 个重复形状（各 ×2）：本 daemon 的 `ssh_mesh_states` 行、`relay_config`、workspace 生命周期锁的自写。去掉它们也只到 26，已在目标内，本单不再追。

idle 剩下的基本都是路由的旁路字段：ssh mesh、drain/maintenance、relay、workspace 配置、provider profile 和鉴权。把它们改成「revision 变化才下发」是建议的后续单：
- 属于 ADR 0001 的扩展，需要写明老 daemon 的降级路径；
- 验收应量典型 heartbeat；
- 开不开、何时排由贺华杰决定。

#### `heartbeat.store_only.pending.every_family` after 触及待办表的语句（10 条）

1 条 probe + 7 条 `UPDATE … SET status = 'running' … WHERE status = 'pending' AND id = (SELECT …) RETURNING *`（每 family 一条）+ CLI update 的 `SELECT id, scope …` + command scrub。fixture 的行都没过期，所以 deadline sweep 全被 probe 证明为空、没有执行。before 同一场景触及待办表的语句是 51 条。

#### `heartbeat.worst_case_with_side_channels` after 前几名

| statement | count | bytes |
| --- | ---: | ---: |
| `UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?` | 3 | 63 |
| `SELECT runtime.*, profile.display_name AS daemon_display_name FROM multiremi_runtimes runtime LEFT JOIN multiremi_daemon…` | 2 | 1536 |
| `SELECT * FROM multiremi_daemon_ssh_mesh_states WHERE workspace_id = ? AND daemon_id = ?` | 2 | 622 |
| `SELECT * FROM multiremi_feishu_bot_configs WHERE workspace_id = ?` | 2 | 42 |
| `SELECT fragment, auth_token, revision FROM multiremi_relay_config WHERE workspace_id = ? AND engine = ?` | 2 | 42 |
| `UPDATE multiremi_runtime_local_skill_import_requests SET status = 'running', … WHERE status = 'pending' AND id IN (…) RETURNING *` | 1 | 3371 |
| `SELECT * FROM multiremi_agent_plugin_runtime_states WHERE runtime_id = ? AND desired = 1` | 1 | 1932 |
| `SELECT * FROM multiremi_agent_plugin_runtime_states WHERE workspace_id = ?` | 1 | 1932 |

10 条 batch import 现在是 1 条 `UPDATE … WHERE status = 'pending' AND id IN (SELECT … LIMIT ?) RETURNING *`。

#### `claim.mixed_workspace` after 前几名

| statement | count | bytes |
| --- | ---: | ---: |
| `SELECT p.*, COUNT(i.id) AS issue_count, … FROM multiremi_projects …` | 55 | 28875 |
| `SELECT issue_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ? …` | 28 | 588 |
| `SELECT * FROM multiremi_project_resources WHERE project_id = ? …` | 25 | 6925 |
| `SELECT execution_fingerprint, work_dir, runtime_id FROM multiremi_tasks WHERE chat_session_id = ? …` | 24 | 504 |
| `SELECT * FROM multiremi_agents WHERE id = ? AND archived_at IS NULL` | 18 | 12114 |
| `SELECT * FROM multiremi_agents WHERE id = ?` | 16 | 10824 |
| `SELECT * FROM multiremi_tasks WHERE id = ?` | 11 | 20860 |

claim 剩下的查询数（307）主要是项目聚合和 chat affinity。它们的字节都很小（单项不到 30KB），不在本单的字节目标里。`SELECT * FROM multiremi_skill_files` 已经不在前几名里了。

## 实现要点

### Phase 1：heartbeat 待办 poll

1. **合并 probe**：`probePendingRequestFamilies` 是一条 `UNION ALL`，每个 family 一行，带三个 `EXISTS` 列：
   - `claimable`：有没有可 claim 的 `pending` 行；
   - `sweep`：有没有已过期、需要 deadline sweep 的行；
   - `housekeeping`：只有 command 用，判断要不要做 scrub。

   它决定哪些 family 进 claim 路径，哪些 sweep 可以证明为空而跳过。capability 关闭的 family 根本不进 SQL。每个分支的 `housekeeping` 都必须是 boolean（非 command 的分支写 `FALSE`，不是 `0`），否则 PG 会拒绝这条 `UNION ALL`（见「PG 验证」）。
2. **claim 路径**：
   - `expire` 从 2 条 UPDATE 合成 1 条 `CASE`。每行仍按更新前的 `status` 取自己的超时文案，逐 family 的文案有单测锁定。
   - `claim` 合成一条 `UPDATE … WHERE status = 'pending' AND id = (SELECT … ORDER BY created_at LIMIT 1) RETURNING *`，不再二次 `get` / `expire`。
   - `claimBatchIds` 改为 `claimBatch`：`WHERE status = 'pending' AND id IN (SELECT … LIMIT ?)` 一次写完整批，返回后按 `created_at` 排序。worst case 的 10 条 import 从 32 条查询降到 1 条。
3. **agent-plugin**：
   - `pending_heartbeat_count` 的推进和 blocked 转换各用一条批量 UPDATE，变更过的状态用一次 `WHERE id IN` 读回。旧实现是每行一条 UPDATE 加一次 `requireRuntimeState`。
   - `reconcileAgentPluginDesiredStateLocked` **没有跳过**。它读的是 workspace 级的 bindings、task snapshot 和 runtime 全集，而 `beforeRows` 只是本 runtime 的切片，没法从切片证明「workspace 里别处没变」。跳过的话，别处新建的 desired 状态会晚一个心跳才生效。按方案第 3 条「证明不了就保留」处理。
4. **不降频，协议零变化**：没有实现「每 N 次心跳 poll 一次」。`ack.pending_*` 字段不增不减。

### Phase 2：claim 只 hydrate 选中任务

1. `AgentsSkillsRepo.getAgentLite` / `listAgentsLite` 只读 Agent 行，不带 skills 和 skill files。改用 lite 读的地方：
   - eligibility 扫描、profile 扫描；
   - `refreshQueuedChatAffinity`；
   - `snapshotTaskExecution` 的资格判断；
   - `getOrCreateSessionAgentLane`；
   - `createTaskAccessToken` 的 scope 判定；
   - `resolveRepositoryWikiAutomation` 的能力判定。
2. `claimNextTaskForRuntime` 不再自己 hydrate。改由 `claimTask` 对**选中任务**做一次 `getTaskWithAgent`，再通过 `snapshotTaskExecution` / `rehydrateSnapshot` 往下传，省掉第二次全量 hydrate。`rehydrateSnapshot` 只合并 snapshot 真正写过的列，这样 hydration 时做的归一化（普通 chat 摘掉 Issue/session、回收运行时工作区）不会被覆盖。
3. **byte cap**：`CLAIM_KNOWLEDGE_BYTE_CAP = 512 KiB`。`applyClaimKnowledgeByteCap` 按 store 返回的顺序逐篇放入，放不下就整篇跳过，绝不截断：
   - Project Wiki 超限时**整篇丢弃**，绝不发空 body。否则旧 daemon 会把空 body 写进本地副本和 baseline，再被之后的 `wiki push` 上传。同一个 id 也从 Intake `projectContexts` 里移除。
   - Repository Wiki 超限时保留 metadata，`status` 设为 `"unavailable"`，body 置空。daemon 现有的 `repositoryWikiDocUnavailable` 会保留旧副本并跳过写入。
   - `knowledge_warnings` 加一条，列出被省略的文档，并指向 `remi wiki`。
   - 已验证 `remi wiki push` 不会因为某篇文档不在 manifest 里就删掉远端：
     - `buildPushPlan` / `buildRepositoryPushPlan` 只对 manifest 里逐条比对过的条目生成 delete；
     - 发 delete 还要求 `remoteText === base`，也就是本地确实删了、远端也没变；
     - 不存在「远端有、manifest 没有 → 删除」这条路径。

     daemon 侧另有单测锁定：被省略的 project doc，干净副本会删除；编辑过的副本会保留，baseline 仍是旧的远端文本。

### Phase 3：去掉路由里的重复读，补并发与顺序的保证

1. **请求级读缓存**（`packages/server/src/store/request-read-cache.ts`）：
   - 用 `AsyncLocalStorage` 只在一次 HTTP 请求内生效，由 `/api/daemon/*` 的中间件开启，且在鉴权之前开，所以鉴权的读也能共用；后台任务、CLI 和测试默认不开。
   - 缓存哪些行是逐个 opt-in 的：Runtime 行、workspace、成员列表、relay config、SSH mesh 配置和状态、飞书 bot 行。
   - 经 store 的写会清掉被写那张表的缓存（`invalidatingDatabase` 按 SQL 目标表失效，认不出表名就全清）。heartbeat 自己的 Runtime UPDATE 是 write-through。
   - 缓存不跨请求：已退役或已撤销的 daemon token，下一次请求就会被拒，有单测锁定。
2. **并发 claim 保护**：外层 UPDATE 带 `AND status = 'pending'`。在 PG 的 READ COMMITTED 下，两个请求同时选中同一行时，输的一方重新检查条件后会拿到 0 行，而不是重复下发。有回归测试。
3. **同毫秒顺序**：旧的 batch claim 在 `created_at` 相同时沿用引擎返回的顺序。之前改成按随机 id 排序会打乱这个顺序，现已改回只按 `created_at` 排序：JS 排序是稳定的，同毫秒的行保持引擎原来的顺序。有两条单测锁定（全部同毫秒、部分同毫秒）。
4. `recordAgentPluginRuntimeHeartbeatWithinLock` 在 reconcile 之后读回的那一步也走缓存。reconcile 是这段时间里唯一的写入方，而且用的是同一个会失效缓存的句柄。idle 因此从 30 降到 29。
5. **只有过期行的 family 照样 sweep**（`cd80d24d`）：最初的 probe 在「没有可 claim 的行」时整个跳过该 family，连 deadline sweep 也一起跳过了。
   - 后果：daemon 在升级途中挂掉，`running` 的 update 行过了 20 分钟也不会被置为 `timeout`。`createRuntimeUpdateRequest` 检查进行中的行时不先 sweep，于是这个 runtime 之后的每次升级请求都会被拒绝（"an update is already in progress"），直到有人通过 getter 读到那一行。
   - 修复：probe 的 `sweep` 列为真时，该 family 也进 claim 路径（先 sweep 再 claim）。只在确实有过期行时多出这几条语句，idle 和 bench 各场景的数字不变。
   - 两条回归测试直接读表，不走 getter，因为 getter 读之前会先 sweep，会把问题掩盖掉。同样这两条测试在 `a1e61623`（改动前）上通过、在 `77127310` 上失败、在 `cd80d24d` 上通过。
6. **请求级读缓存只在 `/api/daemon/*` 上开启**（`21470603`）：handler 里没有 await 的异步任务会通过 AsyncLocalStorage 继承缓存作用域。daemon 路由以外，没人检查过这类任务会读什么，所以其余 API 保持直接读库，与改动前一致。heartbeat 和 claim 都在 `/api/daemon/*` 下，实测数字不受影响。

## PG 验证

- 新的三种 SQL 形状各有 PG 专项回归（`tests/unit/multiremi/multiremi-postgres-store.test.ts`，PG 不可达时跳过）：
  - `UNION ALL` probe；
  - `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`；
  - `IN (SELECT … LIMIT ?)`，以及按行取各自文案的 `CASE` expire。
- 干活小弟在真实 PostgreSQL 上跑新 SQL 时，发现了一个只在 PG 上出现的问题：`UNION ALL` 各分支类型不一致（`0` 与 boolean），PG 报 `UNION types integer and boolean cannot be matched`。SQLite 能接受这种写法，所以整套 SQLite 测试一直是绿的。已在 `3caa0a91` 修复（改成 `FALSE`）。
- 本报告的数字仍然全部来自 SQLite 代理。PG 专项在本机默认环境下跳过，QA 会在只绑定 `127.0.0.1` 的临时 PG 上独立复跑，结论写在 Issue 的 QA 评论里。不使用本机常驻的共享 PG，也不连 209。

## 测试

以下结果在 `21470603` 上由带头大哥本机实跑（2026-09-26），QA 会独立复跑。

| 命令 | 结果 |
| --- | --- |
| `bunx tsc --noEmit` | 通过 |
| `bun run cli:capabilities:check` | `668 mapped / 91 exempt / 0 missing (759 routes)` |
| `bun test tests/unit/multiremi/`（全量，260 个文件） | 2970 pass / 85 skip / 0 fail |
| `bun test tests/arch/` | 91 pass / 0 fail |
| `bun test tests/unit/daemon/` | 519 pass / 2 fail：`safe-remove`（quarantine rename 失败时恢复 0555）和 `gc-policy`（单条删除失败后继续）。两条在 `a1e61623` 上同样失败，是既有问题，与本单无关 |
| `multiremi-heartbeat-poll-merge.test.ts`（新增） | 15 pass：7 类 family 在一次心跳里全部 claim、同 family 取最老的行、10 条 batch 一次写、capability 关闭不 claim 也不进 probe、不支持 skill directory 仍失败、逐 family 超时文案、仅 running 超时、未到期不超时、CLI update drain、command scrub、**只有过期行时心跳仍 sweep（update running / model_list pending 各一条）**、idle 只有 1 条语句触及 7 张待办表（结构断言）、每次心跳只有一个 probe、capability 关闭的表不进 probe |
| `multiremi-claim-hydrate-selected.test.ts`（新增） | 8 pass：选中任务的 payload 完整（skill 正文与 files）、priority / created_at 定序、profile、stale dispatch 回收、HTTP 与 daemon client 两条入口选中同一任务 |
| `multiremi-claim-knowledge-byte-cap.test.ts`（新增） | 8 pass：未超限不变、project 超限整篇丢弃且有 warning、绝不发空 body、Intake context 同步移除、repo 超限变 unavailable、共享预算 |
| `multiremi-request-read-cache.test.ts`（新增） | 6 pass：作用域外不生效、不跨请求（已退役的 daemon token 下一次心跳即被拒）、token 有效期间持续可用、作用域内写后读不陈旧、按表失效 |
| `store-runtime-request-queue.test.ts`（扩展） | 19 pass：golden SQL 更新为合并后的 claim / expire，并发 claim 保护，同毫秒顺序两条 |
| `store-agent-plugins-repo.test.ts`（扩展） | 22 pass（含批量写入断言） |
| `tests/unit/daemon/wiki-workspace.test.ts`（扩展） | 13 pass（含「被省略的 project doc」与「repo doc unavailable 保留旧副本」） |
| `multiremi-postgres-store.test.ts`（扩展） | 本机无 PG：11 pass / 63 skip。PG 专项待 QA 在临时 127.0.0.1 PG 上复跑 |

已知的既有问题：`multiremi-api-realtime.test.ts` 的 WebSocket 用例在并行全量运行时偶发超时，单独运行 9/9 通过；本次全量运行未出现。

## 发版后在 209 复核

- 209 **只读**：只跑 `docker logs` 和只读 API 探测，不改配置、不重启服务、不写库。不在 209 上启动 daemon。
- **判定口径（裁决）**：只和同源数据比，即 `POST /api/daemon/heartbeat` 的 `Server-Timing` `dbq`。先记录发版前一个窗口的 `api_slow_request` / `api_minute_summary` 基线，再看发版后同一 route 的值：**典型 heartbeat 的 `dbq` p50 下降 ≥ 50%** 即达标。本地 fixture 上 idle 降了 68.8%。
- **推翻条件**：如果 209 的降幅 < 50%，就用生产日志里的语句重新归因。生产的 workspace 里 runtime、task、member 更多，旁路字段的占比可能和本地 fixture 不同。
- claim 同样只比同源：C.5 那次最坏的 claim 是 `q=445 bytes=5012751 total=3866ms db_ms=278`，发版后同类请求的 `dbb` 应当明显低于这个值。如果 `dbb` 还 > 1MB，先确认 byte cap 有没有触发（Wiki 正文本来就不大时不会触发），以及 eligibility 阶段的重复读是否还在。
