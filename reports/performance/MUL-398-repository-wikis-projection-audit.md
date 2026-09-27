# MUL-398 A：repository-wikis 查询列投影 — 调用方核查与拟投影列清单

| | |
| --- | --- |
| 分支 / 提交 | `agent/MUL-398` @ `43d75571e736293b1300fabf1c54c2d03302de57`（= `origin/main`） |
| 状态 | **只读核查 + 本地基线**；产品代码改动等 MUL-386（PR #255）合入 main 之后再做 |
| 依据 | `repository-wiki-outcome.ts`、`autopilots-repo.ts`、`workspaces.ts`、`tasks-repo.ts`、`knowledge-repo.ts` 与它们的全部调用点 |

## 1. 结论速览

两条 `SELECT r.* FROM multiremi_autopilot_runs` 都可以投影，`result` 两边都可以整列去掉；**`payload` 不能无条件去掉**，因为 `autopilotRunSourceRevision()` 在 `dedupe_key` 为空或以 `:head` 结尾时会回落到 `payload.data.merge_sha`，而这个值直接影响 repository-wikis 响应里的 `build.source_revision`。

| 语句 | 位置 | `payload` | `result` |
| --- | --- | --- | --- |
| 观测查询 | `repository-wiki-outcome.ts:95` | 条件保留（见 §2.1） | **删除** |
| 构建状态查询 | `autopilots-repo.ts:969` | 条件保留（见 §3.1） | **删除** |

`result` 在这两条语句上没有任何活路径读取，删除是安全的。

## 2. 调用方核查：`repositoryWikiObservability` 的 `SELECT r.*`

### 2.1 语句本身用到哪些列

`repository-wiki-outcome.ts:96` 的 `.all()` 只取 6 个字段（line 99-102 的类型注解即为契约）：

| 列 | 用途 |
| --- | --- |
| `r.id` | 加入 `knowledgeAutopilotRuns`，与编译记录里的 `autopilot_run_id` 对齐 |
| `r.repository_id` | 决定这条 run 归哪个仓库；为空时回落到 `schedule_target.id` |
| `r.schedule_target` | `parseJson` 后取 `{kind, id}`；`kind === "repository"` 时补出 `repository_id` |
| `r.task_id` | 从 `byTask` 取该 run 的编译记录，算 `latest_completed_outcome` |
| `r.completed_at` | 与 `last_published_at` 比较，决定 `builds_since_publish` |
| `r.created_at` | `completed_at` 为空时的回退时间；`ORDER BY` 也用它 |
| `r.status` | `WHERE` 已过滤为 `completed` / `failed`，取回后未再读，但 WHERE 必须保留 |

`payload` 与 `result` 在**本函数内**没有任何读取。

### 2.2 该查询的调用方

| 调用点 | 位置 | 依赖字段 |
| --- | --- | --- |
| `GET /api/workspaces/:id/repository-wikis` | `workspaces.ts:518`；消费 `workspaces.ts:525-547` | `last_published_at`、`builds_since_publish`、`consecutive_blocked`、`latest_completed_outcome.status/reason`、`alert` |
| 任务完成时的 Wiki 健康告警 | `tasks-repo.ts:4082` | 只用 `[repositoryId].alert`，即 `consecutive_blocked >= 3` 时构造出的 `{code, threshold, count, reason}`；`reason` 来自 `latest_completed_outcome.reason` |
| `KnowledgeRepo.repositoryObservability` | `knowledge-repo.ts:73`（`store.repositoryWikiObservability` 转发，`store.ts:3957`） | 直接透传整个 `RepositoryWikiObservability` 结构 |
| `store.listKnowledgeCompilationRuns`/`runs` 列表里的 `outcome` | `knowledge-repo.ts:69` 走 `repositoryWikiTaskOutcome` → 私有 `compilations()` | 见 §2.3 |

三个入口拿到的都是 `Record<repositoryId, RepositoryWikiObservability>`，字段只有 §2.2 第 1 行那 5 个。**没有任何调用方触碰 run 的 `payload` 或 `result`。**

### 2.3 相邻但独立的语句（本次不改）

`compilations()`（`repository-wiki-outcome.ts:26`）是另一条 `SELECT r.*`，读的是 `multiremi_knowledge_compilation_runs`。它在被核查的这条路由上只贡献 55 KB，且本单范围限定为「autopilot runs 的两个大列」，因此**不在本轮投影范围**；`repositoryWikiTaskOutcome` / `repositoryWikiTaskHasPublication` 的行为保持原样。

## 3. 调用方核查：`listLatestRepositoryAutopilotRuns`

### 3.1 语句本身用到哪些列

`autopilots-repo.ts:967-995` 先 `SELECT r.*`，再经 `toAutopilotRun()` 转成 `MultiremiAutopilotRunRecord`：

| 列 | 用途 |
| --- | --- |
| `r.id` | 作为 `run_id` 返回；也被 `isRepositoryWikiRunPublished` 二次查询使用 |
| `r.status` | 映射 `build.status`（`failed` / `queued` / `building` / `idle`），并决定 `published` 是否为 `null` |
| `r.repository_id` | 选「每个仓库最新一条」的键 |
| `r.schedule_target` | `repository_id` 为空时补出仓库；`kind === "repository"` 才认 |
| `r.created_at` | 「最新」的排序与平局判定；`updated_at` 回退值 |
| `r.triggered_at` | `build.started_at` |
| `r.completed_at` | `build.updated_at` |
| `r.failure_reason` | `build.failure_reason`（仅 `status === "failed"`） |
| `r.task_id` | 取 task、算 `updated_at` 回落、算 `outcome` |
| `r.dedupe_key` | **`autopilotRunSourceRevision()` 的第一顺位来源**（`:head` 视为无修订） |
| `r.payload` | **`dedupe_key` 缺失或等于 `...:head` 时，从中取 `data.merge_sha` / `mergeSha` / `head_sha` / `headSha`** |
| `r.result` | 无读取 |

其余列（`autopilot_id`、`source`、`issue_id`、`trigger_id`、`event_id`、`issue_session_id`、`schedule_batch_id`）由 `toAutopilotRun()` 填充进返回值，但该路由只消费上表字段；不过 `MultiremiAutopilotRunRecord` 是 store 公开类型，投影时应保留这些标量列以免其它未来的读取者拿到 `undefined`。

### 3.2 所有调用方

| 调用点 | 位置 | 依赖字段 |
| --- | --- | --- |
| `GET /api/workspaces/:id/repository-wikis` | `workspaces.ts:515` | 经 `repositoryWikiBuildState()`（`workspaces.ts:1484-1517`）消费：`id`、`taskId`、`status`、`failureReason`、`triggeredAt`、`completedAt`、`repositoryId`、`dedupeKey`+`payload`（→`source_revision`）、`autopilotId`（→`getAutopilot`） |
| `MultiremiStore.listLatestRepositoryAutopilotRuns` | `store.ts:4205` | 纯转发 |
| `isRepositoryWikiRunPublished(runId)` | `autopilots-repo.ts:1000` | 用 `getAutopilotRun(runId)`（**独立语句**，不经过本函数），读 `repositoryId`、`scheduleTarget`、`autopilotId`、`dedupeKey`、`payload`、`taskId` |

**关键点：`listLatestRepositoryAutopilotRuns` 只有一个真实调用方**（repository-wikis 路由）；`store.ts` 是转发，`isRepositoryWikiRunPublished` 走的是另一条 `SELECT *`。

### 3.3 关于 `store.ts` 与 `tasks-repo.ts:4082` 的澄清

任务里提到的 `tasks-repo.ts:4082` 与 `store.ts` 都是**观测查询**的调用方，不是 `listLatestRepositoryAutopilotRuns` 的调用方：

- `store.ts:3957` 只是把 `repositoryWikiObservability` 转发出去。
- `tasks-repo.ts:4082` 在任务进入终态时取该仓库的 `alert`，用于决定是否给 Wiki 维护者发 Inbox 告警。
- `store.ts:4205` 只是把 `listLatestRepositoryAutopilotRuns` 转发出去。

两条语句都需要投影，但各自的调用方集合不同，改法也不一样。

## 4. 拟投影的列清单

### 4.1 观测查询（`repository-wiki-outcome.ts:95`）

```sql
SELECT r.id, r.repository_id, r.schedule_target, r.task_id,
       r.completed_at, r.created_at, r.status
FROM multiremi_autopilot_runs r
JOIN multiremi_autopilots a ON a.id = r.autopilot_id
WHERE a.workspace_id = ? AND (r.repository_id IS NOT NULL OR r.schedule_target IS NOT NULL)
  AND r.status IN ('completed', 'failed')
ORDER BY r.completed_at DESC, r.created_at DESC, r.id DESC
```

### 4.2 构建状态查询（`autopilots-repo.ts:969`）

`payload` 在 `dedupe_key` 为空或以 `:head` 结尾时才可能被 `autopilotRunSourceRevision()` 读到，因此投影必须带上条件表达式，而不是直接删列：

```sql
SELECT r.id, r.autopilot_id, r.source, r.status, r.issue_id, r.task_id,
       r.trigger_id, r.event_id, r.issue_session_id, r.repository_id,
       r.dedupe_key, r.schedule_target, r.schedule_batch_id,
       r.triggered_at, r.completed_at, r.failure_reason, r.created_at,
       CASE WHEN r.dedupe_key IS NULL OR r.dedupe_key LIKE '%:head'
            THEN r.payload ELSE NULL END AS payload
FROM multiremi_autopilot_runs r
JOIN multiremi_autopilots a ON a.id = r.autopilot_id
WHERE ...
```

**注意 `LIKE '%:head'`**：`autopilotRunSourceRevision()` 判定的是 `dedupeKey.split(":").slice(2).join(":") !== "head"`，即「最后一段是 head」。用 `LIKE '%:head'` 与之等价（dedupe key 形如 `repo:mode:head`）。

代码侧建议：`toAutopilotRun()` 已把 `payload` 解析为对象，未投影时该列返回 `null` 即可——`autopilotRunSourceRevision()` 里 `isRecord(run.payload)` 对 `null` 返回 `false`，行为与「没有 payload」一致，因此**不需要改 `toAutopilotRun()` 或 `autopilotRunSourceRevision()` 的签名**。

### 4.3 投影后仍需保留 `getAutopilotRun` 的整行读

`isRepositoryWikiRunPublished()`（`autopilots-repo.ts:1001`）与 `runAutopilot()` 内部（`autopilots-repo.ts:1357`/`1437`）走 `SELECT * FROM multiremi_autopilot_runs WHERE id = ?`。这条语句在本路由上只贡献 114 KB（单行、2 次调用），且 `repositoryWikiRunHasPublication()` 确实需要 `taskId`+`dedupeKey`+`payload`+`autopilotId`，**不在本单投影范围**。

## 5. 与 MUL-387 / MUL-397 / MUL-399 的交互

三个单都已合入 main（`b8b24970` 之前），它们改的都是同一条路由，必须一起看：

| 单 | 改动 | 与本单的关系 |
| --- | --- | --- |
| MUL-387（PR #257，`be2e5823`） | `GET .../repos/:repositoryId/wiki` 改为只返元数据，正文走显式批量读；新增 Bun-UA 兼容分支 | 改的是 `.../repos/:repo/wiki`，**不是** `.../repository-wikis`。两条路由共用 `RepositoryWikiService`，但摘要路由从不读正文，所以没有投影冲突 |
| MUL-397（`dfc60a0a`） | `withRequestDeadline()` 包住单页与批量读，超时统一 504 | 只包 `get` / `readBodies`。摘要路由没有 OpenViking 调用，**不受影响** |
| MUL-399（`9b81b71f`、`736c2f2e`、`8bdff844`） | 把 `?q=` 搜索、backlinks、Bun-UA shim list 也纳入同一个 25s deadline | 同样只在 `.../repos/:repo/wiki` 家族。摘要路由不经过它们 |

**结论：本单的投影与这三个单不冲突。** 摘要路由（`repository-wikis`）与文档路由（`repos/:id/wiki`）在实现上共享 store 与 service，但读取的语句和数据完全不同；投影只改前者读的两条 run 语句。

需要留意的一点：MUL-399 给 `.../repos/:repo/wiki` 加了「未显式请求正文时不得回落到空 `body`」的严格语义。本单不碰该语义，after 对比时会用 `responseContract.fieldPaths` 逐字段确认摘要路由响应未变（摘要路由本来就不返回 `body`）。

## 6. 投影效果预演（不改产品代码，只在 DB 包装层改写 SQL）

为了确认 §4 的列清单能达到验收门槛，用同一 fixture 在包装 `SqlDatabase` 里按上述表达式重写两条语句（产品代码一行未改）：

| | before | 投影后 | 变化 |
| --- | --- | --- | --- |
| `db_bytes` | 23,471,509 B（22.38 MiB） | **448,339 B（0.43 MiB）** | −98.1% |
| `db_queries` | 11 | 11 | 不变 |
| p50 | 107.1 ms | 17.9 ms | −83% |
| 响应体 | 字节级相同 | 字节级相同 | 一致 |

投影后单次请求的剩余贡献（已按 6 次请求折算回每次）：

| 语句 | B/次 | 说明 |
| --- | --- | --- |
| 两条 run 投影 | 155,810 | 12 个标量列 + 条件 `payload` |
| `SELECT * FROM multiremi_repository_wiki_docs` | 120,178 | 146 行元数据；OpenViking 模式下 `body` 为空串 |
| `SELECT * FROM multiremi_autopilot_runs WHERE id = ?` | 114,751 | `getAutopilotRun` 的整行读，2 次/请求 |
| `compilations()` 的 join | 55,510 | 133 条编译记录 |
| 其余（PRAGMA、逐 id 查询等） | ~2,000 | |

**这意味着验收门槛 `< 1 MB` 的余量约 2.2 倍，但并不宽裕。** 即使只投影两条 run 语句，剩下的 `repository_wiki_docs` 整表读（120 KB）与 `getAutopilotRun` 整行读（115 KB）会随仓库页数和编译记录数线性增长。如果 after 在 209 的真实规模上超门槛，下一步的候选是：把 `listWorkspaceRepositoryWikiDocs` 也投影掉 `body`（OpenViking 模式下该列本来就是空串），以及让 `getAutopilotRun` 走同一个窄投影。两者都不在本轮批准范围内，先记录为 after 时的观察点。

## 7. 本轮交付的回归护栏

投影本身等 MUL-386 合入后再写，但投影**必须保住的行为**已经用单测钉住，避免 after 阶段改错：

`tests/unit/multiremi/repository-wikis-run-projection.test.ts`（4 条，随本 PR 提交，改动前就已全绿）：

1. `autopilotRunSourceRevision()` 在 `dedupe_key` 有修订段时优先用它；`:head` 与无 `dedupe_key` 时才回落到 `payload.data.*`。这条直接固化了 §4.2「不能无条件删 `payload`」的约束。
2. `source_revision` / `published` / `last_published_at` / `builds_since_publish` / `consecutive_blocked` / `alert` 在摘要响应里的取值。
3. 无 `dedupe_key` 的 legacy run 仍能从 `payload` 拿到 `source_revision`。
4. `published` 由文档修订证明，不由 run 的 `result` 文本决定——这条是「`result` 可以整列删」的直接依据。

## 8. 复跑

```bash
MULTIREMI_TEST_POSTGRES_URL=postgres://… \
  bun run tests/manual/bench-repository-wikis-db-bytes.ts \
  --out reports/performance/MUL-398-repository-wikis-db-bytes-before.json
```

fixture 与脚本的参数都可用 `MUL398_*` 环境变量覆盖。

> 预演用的包装层脚本是本轮临时诊断工具，**不随本 PR 提交**；上面的列清单才是交付物，after 会在真实产品代码里按它投影。
