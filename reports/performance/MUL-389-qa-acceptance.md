# MUL-389 QA 独立验收报告

- 复核对象：`agent/MUL-389`，代码 `21470603`，报告提交 `96acdf41`
- PR：https://github.com/Grassgod/Remi/pull/254（Draft）
- 执行环境：共享 checkout（未新建/切换分支），本地临时 PostgreSQL 18.4 仅监听 `127.0.0.1:55432`
- 结论：**通过**（heartbeat.idle 29 ≤ 30，worst 47 ≤ 55，poll 结构 1，poll 增量 14 ≤ 20，claim 438,486 B < 1MB，PG 72 pass）

所有命令在共享 checkout `/data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-389/Remi` 上执行，未新建或切换分支，未修改 `./wiki`；PR 保持 Draft，未转 Ready、未合入。

### 逐条结论

| 验收项 | 场景 / 读法 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| 典型 heartbeat | `heartbeat.idle` `queries` | ≤ 30 | **29**（3 样本一致） | ✅ |
| 最坏 heartbeat | `heartbeat.worst_case_with_side_channels` `queries` | ≤ 55 | **47**（3 样本一致） | ✅ |
| 待办 poll 合并 | `heartbeat.idle` 中触及 7 张待办表的语句数 | = 1 | **1**（合并 probe；before 23） | ✅ |
| 待办 poll 增量 | `store_only.pending.every_family − store_only.idle` | ≤ 20 | 28 − 14 = **14** | ✅ |
| claim 过桥字节 | `claim.mixed_workspace` `bytes` | < 1MB | **438,486** | ✅ |
| 7 类待办 claim | `multiremi-heartbeat-poll-merge.test.ts` | 全通过 | 15 pass | ✅ |
| claim 选中一致性 | `multiremi-claim-hydrate-selected.test.ts` | 全通过 | 8 pass | ✅ |
| PG 新 SQL | `multiremi-postgres-store.test.ts` on real PG | 全通过 | 72 pass / 0 fail | ✅ |
| 回归 | `tsc` / CLI checker / 全量单测 | 见下 | 通过 | ✅ |
| 协议兼容 | `ack.pending_*` 只增不减 | 不变 | 字段集合逐项相同 | ✅ |
| 延迟上界 | 待办延迟 | 下一次心跳 | 报告已写明，probe 每次心跳都跑 | ✅ |

复核用的 bench 命令与裁决一致：
`MUL389_BENCH_TOP_N=200 bun run tests/manual/bench-daemon-heartbeat-claim.ts`
输出 `/tmp/qa-mul389-after.json`，与 `reports/performance/MUL-389-heartbeat-claim-after.json` 的 `dbq`/`dbb` 逐场景一致。

### 独立复核（不复用执行者的结论）

以下都是复跑或自建的最小验证，不是转述报告：

1. **PG 真机**：临时 PostgreSQL 18.4（`postgresql-wheel` 不可用，改用 npm 包 `@embedded-postgres/linux-x64` 的二进制，`unshare -U` 降权后 `initdb`），只监听 `127.0.0.1:55432`，数据目录 `/tmp`，跑完即停并删除。`MULTIREMI_TEST_POSTGRES_URL` 走 `$MULTIREMI`，命令行与报告里都没有连接串或口令。
   - `bun test tests/unit/multiremi/multiremi-postgres-store.test.ts` → **72 pass / 0 fail**，其中包含新 SQL 的 PG 专项：`UNION ALL` probe（各分支同为 boolean）、`UPDATE … WHERE status='pending' AND id = (SELECT … LIMIT 1) RETURNING *`、`IN (SELECT … LIMIT ?)`、按行取各自文案的 `CASE` expire。
   - 仓库里全部 PG 门控文件（6 个）→ **106 pass / 0 fail**；把整个 `tests/unit/multiremi/` 接上真 PG 再跑一遍 → **3045 pass / 0 skip / 0 fail**（无 PG 时那 85 条 skip 全部实跑）。
2. **并发 claim 在真 PG 上是真的**：自建两连接竞态，A 持行锁未提交、B 同时 claim。
   - 带外层 `AND status = 'pending'`：赢家 1 行、输家 **0 行**（等下一次心跳）。
   - 去掉该谓词（变异体）：输家也拿到 **同一行** —— 即两个 daemon 会拿到同一请求。
   - 单行 `claim` 与 `claimBatch` 两种形状都验证过，结论一致。
3. **外层 guard 有测试兜底**：把 `AND status = 'pending'` 从两条 UPDATE 里删掉的变异体，在 `store-runtime-request-queue.test.ts` 上 **8 fail**，含专门的 `re-checks the row status on the UPDATE, not only in the sub-select`。恢复后 19 pass。
4. **只有过期行的 sweep 回归确实被锁住**：生产代码取 `77127310`、测试取 `cd80d24d` 的变异组合上，`multiremi-heartbeat-poll-merge.test.ts` 恰好 **2 fail**（stuck running update / overdue pending model list）；`cd80d24d` 全绿。与执行者说明一致。
5. **请求级读缓存不跨请求，且尊重外部连接写**：自建双连接用例（`storeA` 服务请求、`storeB` 改库）：另一个连接写入过期时间后，下一次心跳立即 **401**；另一个连接改 Runtime 行后，下一次请求读到新值；另一个连接新签的 token 下一次请求可用。
6. **缓存作用域只覆盖 `/api/daemon/*`**：自建 Hono 应用验证 `/api/daemon/heartbeat` 在作用域内，`/api/daemons/:id` 不在（`/api/daemon/*` 不匹配 `daemons`），与 `21470603` 的缩放一致。
7. **wire 兼容**：同一 fixture 在 `a1e61623` 与 `96acdf41` 上分别导出 heartbeat ack 字段集、claim 响应字段集与 Agent 字段集，`diff` 结果完全一致（`IDENTICAL_KEYS`）。`ack.pending_*` 无增无减，claim 响应结构不变。
8. **claim 选中一致性（差分）**：同一确定性 fixture（同 created_at 下按 priority 取胜、跨 provider 任务应跳过、queued chat turn 的 affinity 路径、stale dispatch 回收、7 类 family 的 claim 与两种 deadline 文案、10 条 batch 顺序）在 `a1e61623` 与 `96acdf41` 上跑同一脚本，输出 `diff` 为 **完全一致**；选中任务的 skill 正文与 files 完整。
9. **byte cap 端到端**：用真实的 `ProjectKnowledgeService` / `RepositoryWikiService`（openviking 模式 + 内存 stub）写入超限文档，经 `hydrateClaimKnowledge` 用小 cap 处理后再喂给 daemon 的 `prepareIssueWikiWorkspace`：
   - 超限 Project doc **整篇丢弃**，落地目录里没有空文件，**baseline 里也没有**（`huge_in_baseline=false`）；
   - 上一次留下的**干净副本被删除**，**编辑过的副本保留**（`edited_copy_kept=true`）；
   - 超限 Repo doc 变成 `status: "unavailable"`、body 为空、本地旧副本不写；
   - `knowledge_warnings` 列出被省略的两篇并指向 `remi wiki`。
10. **`remi wiki push` 不会因文档缺失而删远端**：读 `buildPushPlan` / `buildRepositoryPushPlan` 确认 delete 只会从 manifest 里逐条比对产生，且要求 `remoteText === base`；「远端有、manifest 没有」不生成任何动作（无该分支）。
11. **既有失败确认**：`tests/unit/daemon/` 在 `96acdf41` 上 519 pass / 2 fail，在干净 worktree 的 `a1e61623` 上同样 2 fail（`safe-remove`、`gc-policy`），属既有问题。
12. **报告数字与 JSON 一致**：`heartbeat.idle 29`、`worst_case_with_side_channels 47`、`store_only.idle 14`、`store_only.pending.every_family 28`、`claim 438486` 与 `-after.json` 完全对应；before 列与 `-baseline.json` 对应。报告/JSON 里没有 token、口令、连接串（按 `password`/`secret`/`api_key`/`bearer`/`postgres://` 等模式扫过，0 命中）。

### 命令与结果（本轮在 `21470603` 上实跑）

| 命令 | 结果 |
| --- | --- |
| `bunx tsc --noEmit` | 通过（exit 0） |
| `bun run cli:capabilities:check` | `668 mapped / 91 exempt / 0 missing (759 routes)` |
| `bun test tests/unit/multiremi/`（260 文件，无 PG） | 2970 pass / 85 skip / **0 fail** |
| `bun test tests/unit/multiremi/`（260 文件，**接真 PG**，85 条 skip 全部实跑） | **3045 pass / 0 skip / 0 fail** |
| `bun test tests/arch/` | 91 pass / 0 fail |
| `bun test tests/unit/daemon/` | 519 pass / 2 fail（既有，见上） |
| 点名的 9 个文件 | 166 pass / 0 fail |
| `tests/unit/daemon/wiki-workspace.test.ts` + 两个 prompt 文件 | 35 pass / 0 fail |
| 新增 4 个文件（poll-merge / hydrate-selected / byte-cap / read-cache） | 37 pass / 0 fail |
| `multiremi-postgres-store.test.ts`（真 PG） | 72 pass / 0 fail |
| 全部 PG 门控文件（postgres-store / task-list / request-metrics / reconnect / usage-summary / chat-issue-audit） | 106 pass / 0 fail |
| bench（`MUL389_BENCH_TOP_N=200`） | 与报告逐场景一致 |

### 风险与遗留

- 上面所有 heartbeat/claim 性能数字仍是 **SQLite 计数代理**，不是 PG 桥实测；同量纲、可同向比较，但不可与生产绝对值互比。PG 真机只用来验证 SQL 正确性与并发语义、以及让 85 条 PG 门控用例真正执行，没有取性能数字。
- `safe-remove` / `gc-policy` 两条既有失败与本单无关，未修。
- 本机无 5432 的服务，209 的复核（同源 `Server-Timing` `dbq` p50 降幅 ≥ 50%）只能在发版后做，属未完成的验收环节。
- `heartbeat.idle` 剩 3 个「同一形状读两次」的数据需求（本 daemon 的 ssh mesh 行、relay config、workspace 生命周期锁自写）；报告已注明去掉也只到 26，已达标故未继续改。这是旁路字段 revision 下发后续单的输入。
- 未做的事（按边界）：未转 PR Ready、未合入 main、未在 209 做任何写操作、未执行 `remi wiki push`、未改 `./wiki`。
