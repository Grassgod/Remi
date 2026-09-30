# MUL-404 方案：统一消息格式、统一收件箱、未读优先级

作者：Senior大哥　日期：2026-09-28　口径：`remi issue get MUL-404` 描述 + 评论 `cmt_okduecknm176`、`cmt_mlz7faxlukbf`
调研依据：`.mul404-evidence/senior-explore-0928/1..5`（5 份报告），本文所有代码事实已在共享 checkout 用 `git show` / `git grep` / `git merge-tree` 按今日 fetch 的分支头核对。

## 0. 结论（先读这一段）

1. **统一收件箱 = conversation_log + 每个 (会话, agent, 执行范围) 的 lane 游标。不建新表。** 队友回报、子单结果、人的答复、@ 都写成收件人会话里的一条 `system` 系统评论（chat 会话则是 system 消息），带 `metadata.envelope`。agent 醒来读的「未读」就是游标之后的日志。
2. **待处理轮 = `multiremi_tasks` 里那条 `queued` 任务本身。** 用两条部分唯一索引保证每个 lane 只有一条 queued：issue 会话按 `(issue_session_id, agent_id, execution_scope)`，chat 会话按 `(chat_session_id, agent_id)`。为此给 `multiremi_tasks` 加真实列 `execution_scope`（今天只是 `executionScopeSql` 表达式）。
3. **唤醒和状态变化同一事务：** 新增唯一写入口 `sendEnvelopeWithinTransaction`（写日志条目 + `ensurePendingTurnWithinTransaction`），E2、E3 通知类、E4、队友回报、@ 五条路径全部改走它，在外层事务内完成。MUL-400 的「事务深度 1」规则不变，变的是这些唤醒从「提交后钩子里另开事务」改为「外层事务内的 `...WithinTransaction` 调用」。提交后只剩推送类副作用（workspace event、`notifyTaskEnqueued`）和 E3 自动开工（MUL-452 已有回放）。
4. **今天四套「找已排队任务再拼 prompt」的合并逻辑全部删除**（`findQueuedTaskForIssueAndAgent`、`findQueuedTaskForDelegationReturn`、`queueDecisionRound` 的拼接、@ 的 `comment_mention_coalesced`），由 `ensurePendingTurn` 一处取代。内容不再拼进 prompt，收件人从日志读。
5. **转述 Remi** 改为在 issue 默认会话上拥有自己的 lane 游标（`execution_scope = relay:<chat_session_id>`），任何轮次结束（completed / failed / cancelled）且 issue 无活跃任务时收到一封 `report` 信封，醒来读游标之后的日志区间。`multiremi_agent_issue_update_state` 本单停止写入，删表放到切换后。
6. **提问卡片一次性令牌**：任务提问（`fr_`）和 issue 决策卡（`fd_`，MUL-412 已合入 main）两条路径同批改，令牌哈希存库、只绑定收件人 open_id、首次成功答复即消费，服务端校验，宿主不再靠内存登记表判权。
7. **子单 5 张**：D1 收件箱内核（关键路径，今天可派）、D2 回执与 re-ring、D3 未读目录与展开、D4 转述 Remi、D5 一次性令牌（独立，今天也可派）。
8. **需要贺华杰确认的 3 个用户可见变化**见 §8，每题已给推荐答案；方案按推荐答案写，答案不同时改动点已标出。

### 0.1 基线事实（2026-09-28 fetch 后与调研报告的差异）

| 分支 | 报告时 | 现在 | 影响 |
|---|---|---|---|
| origin/main | b95dd2fa | 439aa141 | **MUL-412 已合入**（决策卡 + `decision_operator_mismatch` 校验）。Q6「怎么分工」变成「在已合入代码上改」。 |
| origin/agent/MUL-403 | c366a949 | d81525cb | **MUL-436 Live Hub 已合入**：`hub-core.ts` 有真实 `onEntry` 与环形缓冲，`human-request-feed.ts` 由 store 写路径发布。仍不作为唤醒载体（见 §5）。 |
| origin/agent/MUL-427 | 04c8d2d0 | 566ccf8b | B7 回填已做（`conversation-log-backfill.ts`，迁移 `20260928_conversation_log_backfill`）；`listSessionEvents` 已改为从日志投影。**`delegation_report` 仍未镜像进日志**（`SESSION_EVENT_KIND_MAP` 无此项），本单要自己把队友回报写进日志。 |
| origin/agent/MUL-452 | 71791740 | 9d9e5b6b | 只多一个测试 fixture 提交；与 main 干跑合并 0 冲突。未合入 main。 |
| origin/agent/MUL-402 | a4b913c2 | a4b913c2 | 未动。**它本身不含 MUL-400 的 E2/E4/E5**（merge-base 80adecfd，落后 main 28 个提交）；MUL-427 已含 MUL-406/407/410，但不含 MUL-409、MUL-456、MUL-412。 |
| 本单 agent/MUL-404 | — | 本地 b95dd2fa，干净 | 远端尚无该分支。 |

`git merge-tree` 干跑冲突文件（D1 第一天要解的）：
- main + MUL-427：`packages/contracts/src/index.ts`、`api/routers/daemon.ts`、`store/context.ts`、`store/db/postgres.ts`、`repos/issue-sessions-repo.ts`、`repos/issues-repo.ts`、`repos/tasks-repo.ts`、`scripts/api-routes.golden.json`、3 个测试。
- main + MUL-403：`apps/remi/cli/multiremi.ts`、`docs/dev/README.md`、`api/routers/daemon.ts`、`api/server.ts`、`store/context.ts`、`store/migrations.ts`、`repos/feishu-bot-repo.ts`（MUL-412 与 C5 都改了 `claimOutbound` 过滤和外发表列）、`worker/client.ts`、golden、2 个测试。
- MUL-427 + MUL-403：`docs/dev/README.md`、`packages/contracts/package.json`、`config/api-role.ts`、golden、`tests/arch/a0-contract-isolation.test.ts`、`api-role-guard.test.ts`。
- main + MUL-452：无冲突。

## 1. 子单拆分与关键路径

拆分依据：干活组「子单拆分」规则。一环接一环的步骤放同一子单分提交；能并行的写明和谁并行、省几天。每张子单 ≤ 1 个 PR，PR 标题带子单号，正文写明依赖的分支。

| 子单 | 名称 | 拆分规则 | 基于分支（merge 顺序） | 前置 | 并行 / 省时 | 验收强度 | 等切换上线的部分 |
|---|---|---|---|---|---|---|---|
| **D1** | 收件箱内核：基线合并、ADR、待处理轮唯一约束、同事务唤醒、崩溃注入测试 | 一环接一环（约束 → 写入口 → 五条路径切换 → 崩溃测试） | `origin/main` → `origin/agent/MUL-427`（含 MUL-402）→ `origin/agent/MUL-403` → `origin/agent/MUL-452` | 无 | **关键路径，今天派**。第 1 天把合并基线单独一个提交推到 `agent/MUL-404`，D2–D4 都基于它 | 严验 | 无 |
| **D2** | 已送达回执、轮次结束 re-ring、认领时「已覆盖」跳过、requeue 清投影 | 能并行（与 D3、D4 同时做，三者并行比串行省约 6 天） | `origin/agent/MUL-404`（D1 基线之后） | D1 的 `ensurePendingTurn` 落地（约 D1 第 4 天） | 与 D3、D4 并行 | 严验 | 无 |
| **D3** | 未读投影「目录 + 优先级」、长正文折叠、展开命令、CLI 对齐 | 能并行（只依赖 D1 第 2 天的 contracts 提交） | `origin/agent/MUL-404`（D1 contracts 提交之后） | D1 的信封类型 | 与 D2、D4 并行 | 轻验（投影快照测试 + 模板预览测试） | 上线后观测折叠命中率（可选） |
| **D4** | 转述 Remi：按自己的游标读 issue 日志，失败/取消轮次也汇报 | 能并行（与 D2、D3 同时做） | `origin/agent/MUL-404`（D1 `sendEnvelope` 之后） | D1 的 `sendEnvelope` | 与 D2、D3 并行 | 轻验 + 一次真机飞书冒烟（测试机器人） | **删 `multiremi_agent_issue_update_state` 表、repo、30s 清扫**；上线后统计汇报次数 |
| **D5** | 提问卡片一次性令牌（`fr_` 任务提问 + `fd_` issue 决策卡） | 能并行（与 D1 同时做，省 3 天）；独立于 402/403 | `origin/main`（439aa141，已含 MUL-412）；后期 merge `origin/agent/MUL-404` 一次以对齐 C5 的外发表 | 无 | **今天可派**，与 D1 并行 | 严验（安全） | 无 |

**关键路径**：D1。它决定唯一约束的键、信封的 metadata 形状和写入口签名，其余四张都依赖或复用它。建议带头大哥今天先派 D1 和 D5。

**工期估计**（单人）：D1 6–7 天（其中合并基线 1 天、崩溃测试 2 天）；D2 2–3 天；D3 3–4 天；D4 3–4 天；D5 3 天。串行约 18–21 天，按上表并行约 10–11 天。

**D1 内部的提交顺序**（其他子单按提交号对齐）：
1. `merge` 基线（4 个 merge，解 §0.1 的冲突，`bun test` 全绿）→ 推送。
2. `docs/adr/0010-…`、`0011-…` + `packages/contracts` 信封类型、`metadata.envelope` 形状、`kind → 优先级` 映射（纯类型，无行为）。D3 从这里起步。
3. 迁移：`multiremi_tasks.execution_scope` 列 + 回填 + 两条部分唯一索引 + 重复 queued 折叠。
4. `ensurePendingTurnWithinTransaction` + `sendEnvelopeWithinTransaction`（issue 会话 → 系统评论；chat 会话 → system 消息）。D4 从这里起步。
5. 五条路径切换（E2、E3 通知两种、E4、队友回报、@），删四套合并逻辑和 prompt 拼接。
6. 深度规则修订（ADR 0003 决策 8 的补注 + 深度测试）。
7. 崩溃注入测试（3 注入点 × 3 场景 × 2 后端）。

**等切换上线才做的（全部子单汇总）**：删 `multiremi_agent_issue_update_state`；删 `session_events` 里 `delegation_report` 的旧写入（B 的 MUL-432 删旧表时一并）；209 生产切换；上线后的合并次数 / re-ring 次数 / 折叠命中率观测。其余全部现在开工。

## 2. 各子单的范围与验收

### D1 收件箱内核（关键路径，严验）

**范围**

1. **基线合并**：按 §1 顺序 4 个 merge，不 rebase。冲突重点：
   - `repos/feishu-bot-repo.ts` 的 `claimOutbound`：MUL-412 用 `plainTextRow = "o.kind IS NULL OR o.kind = '' OR o.degraded IS NOT NULL"` 过滤，C5 用 `o.kind NOT IN ('decision_card','decision_card_patch','decision_reminder')`。取 C5 的写法，再补上 MUL-412 的 `feishu_issue_decision_card` 能力判断，否则 C5 拆行的 `cot/receipt/interaction_card/result_card` 会被不支持决策卡的宿主卡住。
   - `repos/issues-repo.ts`、`repos/tasks-repo.ts`：MUL-427 把唤醒读者改到日志，main 的 MUL-409/456/412 改了 E3 与决策路径。以 MUL-427 的读路径为准，把 main 的新逻辑搬到日志读法上。
   - `store/migrations.ts`：MUL-412 的 `reminder_sent_at`/`decision_id` 列与 C5 的 `unit_key`/`cascade_failure` 列都要保留。
   - 合并后 `bun test` 全绿再开始功能提交。
2. **contracts**（`packages/contracts/src/types.ts` 或新文件 `inbox.ts`）：
   ```ts
   export type EnvelopeKind = "request" | "reply" | "report" | "decision_needed" | "lifecycle" | "final";
   export type EnvelopeWake = "now" | "next_turn" | "inbox_only";
   export interface Envelope {
     to: EnvelopeAddress;            // 按角色寻址，见下
     kind: EnvelopeKind;
     wake: EnvelopeWake;
     dedupeKey?: string;             // 同一收件会话内唯一
     replyTo?: string;               // 被回复的日志条目 id / 决策 id / 提问 id
     grantRef?: string;              // 先留字段，不解释
     body: string;                   // markdown
     outcome?: "done" | "failed" | "blocked" | "cancelled"; // report / final 用
     source: { issueId?: string; taskId?: string; commentId?: string; decisionId?: string };
   }
   export type EnvelopeAddress =
     | { role: "issue_owner"; issueId: string }          // 该 issue 的负责人（agent/squad）
     | { role: "parent_owner"; childIssueId: string }    // 子单的父单负责人
     | { role: "delegator"; delegationId: string }       // 派单人，回到 delegated_from_issue_session_id
     | { role: "relay"; issueId: string }                // 绑定该 issue 的所有转述 Remi chat
     | { role: "agent"; agentId: string; issueSessionId: string }
     | { role: "chat"; chatSessionId: string; agentId: string };
   export interface EnvelopeMetadata { envelope: Omit<Envelope, "body" | "to"> & { to: EnvelopeAddress; priority: 1|2|3|4 } }
   ```
   `kind → 优先级`：`decision_needed`、成员发出的 `request` = 1（人的决定）；`report/final` 且 `outcome ∈ {failed, blocked, cancelled}`、`lifecycle` 里的 task_failed/cancelled = 2（失败/卡住）；`report/final/reply` 其余 = 3（完成）；`lifecycle` 其余、`wake = inbox_only` = 4（知会）。映射是纯函数 `envelopePriority(entry)`，放 contracts，D3 直接用。
3. **迁移**（`runMigrationOnce`，id `20260929_tasks_one_pending_turn`）：
   - `ALTER TABLE multiremi_tasks ADD COLUMN execution_scope TEXT NOT NULL DEFAULT ''`（`addColumnIfMissing`），回填 `UPDATE multiremi_tasks SET execution_scope = <executionScopeSql('multiremi_tasks')>`；`createTaskWithinWorkspaceLock` 插入时写该列（它已经为 lane 算过同一个值）。`executionScopeSql` 的 5 处调用改读列。
   - 折叠已有重复：同一键下多条 `queued`，保留最早一条，把较晚几条的 `prompt` 按今天 `appendDelegationTerminalReports` 的格式追加到最早那条，然后把较晚几条置 `cancelled` 并写活动 `pending_turn_collapsed {kept_task_id}`。这样不丢内容。
   - 两条部分唯一索引（一段 SQL 两种方言，`translateSqliteToPg` 不动 `WHERE`，先例 `idx_multiremi_webhook_deliveries_dedupe`）：
     ```sql
     CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_tasks_one_pending_turn_session
       ON multiremi_tasks(issue_session_id, agent_id, execution_scope)
       WHERE status = 'queued' AND issue_session_id IS NOT NULL;
     CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_tasks_one_pending_turn_chat
       ON multiremi_tasks(chat_session_id, agent_id)
       WHERE status = 'queued' AND chat_session_id IS NOT NULL AND issue_session_id IS NULL;
     ```
     不排除 `continued_from_task_id IS NOT NULL`：续接任务也是这个 lane 的待处理轮，新通知从日志读，不需要第二条 queued。
4. **`ensurePendingTurnWithinTransaction(input)`**（`tasks-repo.ts`，新）：断言 `ctx.db.inTransaction`；`lockWorkspaceRuntimeLifecycle`；按键查 `queued`；有则 `UPDATE ... SET updated_at = ?, wake_seq = MAX(wake_seq, ?) WHERE id = ? AND status = 'queued'` 并写活动 `pending_turn_coalesced {task_id, entry_seq, reason}`；无则 `createTaskWithinWorkspaceLock({... prompt: 固定短文本「读收件箱」+ 触发条目指针, wakeSource: reason, preserveIssueStatus: true, triggerCommentId: 触发系统评论 id})`。返回 `{ task, created }`。唯一索引只是兜底：正常路径永远先查后写，同一事务持有 workspace 行锁，PG/SQLite 都串行。`wake = inbox_only` 不调用它；`next_turn` 只在 lane 上**没有**排队或在跑的任务时创建（否则只写日志，等下一轮顺带读）。
5. **`sendEnvelopeWithinTransaction(env, collector, deferredEvents)`**（新文件 `repos/inbox-repo.ts`）：解析 `to` → (会话, agent, execution_scope)；dedupe：条目 id 取 `cmt_env_<sha256(sessionId + ':' + dedupeKey) 前 20 位>`，先 `UPDATE multiremi_conversation_heads SET updated_at = updated_at WHERE session_id = ?` 锁头，再查 id 存在即返回旧条目（不再分配 seq，避免空洞）；issue 会话走 `createSystemIssueCommentWithinTransaction(issueId, body, {type: 'envelope', envelope}, deferredEvents, null, sessionId)`，chat 会话走 chat-repo 的 system 消息写入（今天 `flushOneWithinTransaction` 用的那条），都把 `metadata.envelope` 落在日志条目上；然后按 `wake` 调 `ensurePendingTurn`。
6. **五条路径切换**（都在外层事务内，不再开第二个事务）：
   - E2：`notifyParentOfChildOutcome` 改为 `WithinTransaction`，由 `updateIssueWithinTransaction` 和 `syncIssueStatusFromTaskWithinTransaction` 直接调用（不再经 `ChildStatusChangeCollector` 延后）。`rederiveParentStatus` 本来就在事务内，保持。`notifyChildStatusChange` 只剩 E3 自动开工（提交后、深度 0、MUL-452 回放）。
   - E3 通知类：`reportPrerequisiteFailureToOwner` → `sendEnvelope({to: issue_owner, kind: report, outcome: failed/cancelled, wake: now})`；`reportDependencyReady`（无 agent 可自动开工时的就绪报告）→ `sendEnvelope({kind: lifecycle, wake: next_turn})`，两者在 `updateIssueWithinTransaction` 内调用，删除 `appendToQueuedParentRound`。
   - E4：`answerIssueDecision` 内改为 `sendEnvelope({to: issue_owner(source), kind: reply, replyTo: decisionId, wake: now})`；成员改答时给父单负责人也发一封。删 `queueDecisionRound`。
   - 队友回报：`drainDelegationReturnsWithinWorkspaceLock` 保留「找哪些终态子任务需要回报、`delegation_return_task_id` 盖章、`already_covered` 判定」，把「找 queued 候选 + 拼 prompt」换成 `sendEnvelope({to: delegator, kind: report/final, outcome, wake: now, dedupeKey: 'delegation_return:' + source.id})`。`delegation_report` 会话事件停写（B 删旧表时一并删）。
   - @：`triggerCommentMentions` 里 agent 作者与成员作者统一：评论本身已是日志条目，只调 `ensurePendingTurn({reason: 'mention', triggerCommentId})`；`comment_mention_coalesced` 活动改名 `pending_turn_coalesced`。
   - 删除：`findQueuedTaskForIssueAndAgent`、`findQueuedTaskForDelegationReturn`、`appendChildStatusReport`、`appendDelegationTerminalReports`、`queueDecisionRound`、`appendToQueuedParentRound`。
7. **深度规则**：ADR 0003 决策 8 加一条补注（在 0010 里写全）：「唤醒写入是外层事务的一部分；提交后钩子只允许推送和 MUL-452 回放」。`multiremi-parent-status-tx-depth.test.ts`、`-pg-depth`、`multiremi-dependency-transaction-depth.test.ts` 加断言：E2/E3 通知/E4 路径 `maxTransactionDepth === 1` 且事务内出现 `INSERT INTO multiremi_tasks`。`pg-nesting-preload.ts` 不改。
8. **崩溃注入测试**（`tests/unit/multiremi/multiremi-inbox-crash.test.ts` + `fixtures/inbox-crash-probe.ts`，照抄 MUL-452 的子进程 + `Atomics.wait` + `SIGKILL` 模式，`MULTIREMI_TEST_POSTGRES_URL` 决定 PG 是否跑）：
   - 注入点：`before-turn`（事务内、状态 UPDATE 之后、`INSERT INTO multiremi_tasks` 之前，包 `db.run` 匹配 SQL 前停住）；`after-turn`（同一事务内、INSERT 之后、COMMIT 之前）；`after-commit`（包 `db.transaction` 返回的 runner，COMMIT 后、`emitCommitEvents` 前停住）。
   - 场景：E2 子单 `done`；E3 前置单 `failed` 通知负责人；E4 `answerIssueDecision`。
   - 断言：`before-turn`/`after-turn` → 重启后状态未变、无 queued 任务、无系统评论；`after-commit` → 状态已变、恰好一条 queued、一条系统评论；再跑一次同样的触发 → 仍恰好一条（dedupe + 唯一索引）；两条 queued 同键强插 → 唯一索引报错（各方言各一条）。
   - PG 额外一条：两个探针进程同时触发同一父单，用 `pg_stat_activity` 等到 2 个锁等待者再放行，结果仍恰好一条 queued（照 MUL-452 P5）。

**验收**
- 范围 2 唯一约束：PG、SQLite 上对同键第二条 `queued` 的 INSERT 都失败；迁移在含重复 queued 的库上跑完不丢 prompt 内容（活动 `pending_turn_collapsed`）。
- 描述「验收：唤醒不因进程崩溃丢失」逐条：三个注入点 × 三个场景 × 两后端 = 18 个用例全过；重启后唤醒不丢不重复；每键仍只有一条待处理轮。
- 深度测试：新增断言通过；`pg-nesting-preload` 不报新的嵌套。
- 旧合并逻辑删除后，`multiremi-delegation-result-comment-once.test.ts`、E2/E3/E4 既有测试改为断言「系统评论 + 一条 queued」而不是「prompt 里有拼接段落」。
- 合并基线：`bun test`、`bun run cli:capabilities:check` 0 missing、`scripts/api-routes.golden.json` 更新。
- ADR 0010、0011 文件存在于 `docs/adr/`。

### D2 已送达回执、re-ring、认领跳过（严验）

**范围**
1. **已送达回执（尽力而为）**：认领时 `buildTaskSessionProjection` 已在一个事务里算出 `projection_from_seq/to_seq`；提交后（不在认领事务内）给这一轮的 `turn` 日志条目打一个 patch：`metadata.inbox = { delivered_from_seq, delivered_to_seq, delivered_at, task_id }`（用 `conversation-log-repo` 的 `updateTurnCardWithinTransaction` 同类 patch）。失败只 `log.warn`，不影响认领（范围 1「回执失败不影响消息本身」）。不给每条信封单独打回执：发件方要看「送达没有」用「条目 seq ≤ 收件 lane 的 cursor 或某轮 delivered_to_seq」推导，`remi session log get` 输出里带 `delivered: true|false`。
2. **re-ring**：`promoteSessionAgentLane`（轮次 completed 或 resume-safe failed 之后）新增：若日志里存在 `seq > 新 cursor`、`author_id ≠ 本 agent`、`metadata.envelope.wake = 'now'` 的条目，且该 lane 没有 queued 任务 → `ensurePendingTurn({reason: 're_ring', triggerSeq})`。这是不变量兜底：「轮次结束 ⇒ 没有未读的 now 信封，或已有待处理轮」。取消的轮次不推进 cursor（现状），所以也会 re-ring。
3. **认领时「已覆盖」跳过**：`claimNextTaskForRuntime` 认领到的任务若 `wake_source ∈ {re_ring, child_status, mention, delegation_return, decision, dependency}` 且 lane cursor ≥ 该任务的 `wake_seq`，且没有未读 now 信封 → 置 `cancelled` 并写活动 `pending_turn_skipped {reason: 'already_covered'}`，继续认领下一条。取代今天 `drainDelegationReturns…` 里的 `already_covered` / `covered_by_queued_task` 判定。
4. **requeue 清投影**：`tasks-repo.ts` 的两处 requeue（约 :3510、:3523）把 `projection_from_seq/to_seq/mode/...` 清空，认领时重新投影，否则被 requeue 的待处理轮读不到它排队期间的新条目。
5. **观测**：活动 `pending_turn_coalesced`、`pending_turn_skipped`、`re_ring` 的 `wake_source` 计数就是上线后要看的「合并次数、被覆盖次数」；不加新表。

**验收**
- 认领后 `turn` 条目带 `metadata.inbox.delivered_to_seq = projection_to_seq`；把 patch 故意打失败（spyOn 抛错），认领仍成功。
- 单元：任务运行中收到一封 now 信封 → 结束后恰好一条新 queued；收到 `next_turn` 信封 → 不 re-ring；收到 `inbox_only` → 不 re-ring；自己写的评论 → 不 re-ring。
- 单元：queued 任务的 `wake_seq` ≤ cursor 且无未读 → 认领时被跳过，活动 `already_covered`；有未读 → 正常认领。
- requeue 后再认领，投影 `to_seq` 覆盖到排队期间的新条目。
- PG、SQLite 都跑（用 MUL-427 的 `withConversationLogStore` 双后端 helper）。

### D3 未读投影「目录 + 优先级」、长正文折叠、展开命令（轻验）

**范围**
1. **服务端**（`store/session-projection.ts`）：`buildSessionProjection` 输出增加 `inbox_toc`（目录）：对窗口内每条「他人写的」条目算 `envelopePriority(entry)`（D1 contracts 的纯函数；没有 `metadata.envelope` 的旧条目按启发式：成员 `message` 且 @ 到我 = 1，`task_failed/cancelled` 标记 = 2，`task_completed` = 3，其余 = 4），按优先级 → seq 排序，每行 `{seq, id, priority, kind, author_name, created_at, title(首行 ≤ 80 字), chars, folded}`。JSONL 里加一行 `{"type":"inbox_toc", ...}`，放在 header 之后、事件之前。
2. **折叠而不是截断**：`DEFAULT_EVENT_BODY_MAX_CHARS = 4_000` 改成「折叠阈值」：正文超过阈值的条目输出 `body_summary`（前 600 字 + markdown 标题大纲 `# / ## / ###` 列表）+ `body_folded: true` + `body_omitted_chars` + `expand: "remi session log get <session> <seq>"`，不再输出被截断的 `body`。原来的预算降级阶梯保留（折叠后仍超预算才继续减事件）。token 估算按折叠后计。
3. **展开命令**：新路由 `GET /api/sessions/:sessionId/log/entry?seq=<n>|id=<entry>`（issue 会话走 workspace 访问，chat 走 `loadChatSessionForCurrentUser`，同 MUL-402 的 `/log` 路由），返回完整 `body_md` + `metadata` + `delivered`。CLI：`remi session log get <session> <seq|entry-id>`；同时让 `remi session event list` 真正转发 `--since-seq/--to-seq`（服务端早就支持）。两条都在 CommandRegistry 注册、跑 `bun run cli:capabilities:generate`、`check` 0 missing、`docs/cli-command-migration.md` 补一行（项目规则 7）。
4. **daemon 提示词**（`packages/daemon/src/agent-runtime/prompts/ephemeral.ts` 的 `appendSessionContextSections`）：在 `## Current Session Context` 之前渲染 `## Inbox`：按优先级分四组（人的决定 / 失败·卡住 / 完成 / 知会），每行「seq · 作者 · 时间 · 标题 · N 字（已折叠，展开：命令）」。没有 `inbox_toc` 的旧服务端响应 → 不渲染该节（向后兼容，daemon 与平台分开升级）。`multiremi-prompt-template-preview.test.ts` 的期望段落加 `## Inbox`。
5. 转述 Remi 的 chat 投影（`chat-repo.ts` 的 `buildTaskSessionProjection`）同样加目录与折叠，D4 用。

**验收**
- 一条 23,109 字的评论（拿 Senior 那份方案做 fixture）在投影里是 `body_folded: true` + 大纲 + 展开命令，`remi session log get` 拿回全文，字数一致。
- 目录顺序：同一窗口内含成员 @、子单失败报告、子单完成报告、`lifecycle` 四种条目时，目录顺序为 1→2→3→4；同级按 seq。
- 模板预览测试与投影快照测试更新；`cli:capabilities:check` 0 missing；golden 路由文件更新。
- 旧 daemon（无 `inbox_toc` 字段）拿到新响应仍能生成提示词（JSONL 未知行类型被忽略的测试）。

### D4 转述 Remi 按游标读 issue 日志（轻验 + 真机冒烟）

**范围**
1. **游标**：复用 `multiremi_session_agent_lanes`，键 `(issue 默认会话 id, 转述 agent id, execution_scope = 'relay:' + chat_session_id)`。不新建表。`cursor_seq` 就是「转述 Remi 读到哪」。
2. **触发**：`afterTaskTerminal`（`tasks-repo.ts` 约 :5649）现在的条件 `status === "completed" && lead?.id === task.agentId && !hasActiveTaskForIssue` 改为 `status ∈ {completed, failed, cancelled} && task.issueSessionId && !task.chatSessionId && !hasActiveTaskForIssue(issue.id)`（谁的轮次都算，见 §8 Q-A）。满足时对每个绑定该 issue 的转述 chat 调 `sendEnvelope({to: {role: 'relay', issueId}, kind: 'report', outcome: status→done/failed/cancelled, wake: 'now', dedupeKey: 'relay:' + issueId + ':' + task.id, body: 指针文本})`，指针文本 = 「MUL-xxx 有新日志：会话 ises_…，seq (cursor, head]；本次轮次 tsk_… 状态 failed，原因 …」。`hasActiveTaskForIssue` 排除 chat 任务（现状）。
3. **认领内容**：`appendDaemonClaimBoundIssueUpdates`（`wire/tasks.ts`）把 `bound_issue_updates`（最近 12 条聚合）换成 `bound_issue_log`：服务端读 `listConversationLogShown(issueSession, {sinceSeq: cursor, toSeq: head})`，最多 100 条、总字数按投影预算折叠（复用 D3），附目录；超出部分给「用 `remi session log window/get` 继续读」的提示。转述 Remi 的文字总结仍由它自己写（贺华杰的决定）。
4. **推进游标**：转述任务 completed → 把该 lane 的 `cursor_seq` 推到认领时给它的 `to_seq`；failed/cancelled 不推进，下次触发重读同一区间（dedupeKey 按触发轮次不同，不会被去重掉）。
5. **停写旧聚合**：`queueAgentIssueUpdate`、`flushAgentIssueUpdatesForIssueWithinTransaction`、`flushDue`、`preparePendingAgentIssueUpdatesForTask*` 全部改为不再调用（代码留到删旧步骤一起删，避免和 C5 的 `feishu-bot-repo.ts` 再打架）；`OutboundNotificationDispatcher.sweep` 里的 `flushDue` 调用去掉。表不删（切换后）。
6. **飞书投递不变**：`prepareFeishuIssueRoundPushesWithinTransaction` 仍负责创建/复用转述 chat 任务和 `cot` 外发行（C5）；只是「有 pending chat 任务就 steer」改为走 D1 的 chat lane `ensurePendingTurn`；`multiremi_feishu_bot_round_pushes(binding_id, leader_task_id)` 的 `leader_task_id` 语义扩为「触发轮次 id」，列名不改。

**验收**
- 负责人轮次 failed → 转述 chat 收到一封 `report/outcome=failed` 信封，转述任务认领时 `bound_issue_log` 覆盖 (cursor, head]；转述任务完成后 lane cursor = head；再来一轮 → 只拿到新增区间。
- 同一触发轮次重复触发（例如 `afterTaskTerminal` 重入）→ dedupe，转述 chat 只有一条信封。
- `multiremi_agent_issue_update_state` 在整个流程里 0 写入（测试断言行数不变）。
- 真机冒烟：在测试机器人绑定的话题里跑一个会失败的轮次，飞书收到失败汇报（人工看一次，记录在 PR）。

### D5 提问卡片一次性令牌（严验）

**范围**
1. **迁移**（id `20260929_human_request_tokens`）：`multiremi_task_human_requests` 和 `multiremi_issue_decisions` 各加 `token_hash TEXT`、`token_recipient TEXT`（open_id）、`token_consumed_at TEXT`；索引 `(token_hash) WHERE token_hash IS NOT NULL`。
2. **发放**：卡片入队时（`enqueueDecisionDeliveryWithinTransaction` 对 `fr_`；MUL-412 的 `decision_card` 插入对 `fd_`）生成 32 字节随机令牌，库里只存 `sha256`，明文放进外发行的卡片载荷（`packages/shared/src/feishu-task-card.ts` 的按钮 `value: { t: token, r: requestId }`）。`resolveDecisionRecipient` 为 `person` 时立即写 `token_recipient`；为 `host_resolved`（群主）时在宿主报 `sent` 回传 `interaction_open_id` 那一刻补写（`COALESCE` 只写一次）。重发 / retarget / 提醒卡 → 轮换新令牌，旧的作废（`token_hash` 覆盖）。
3. **校验（服务端）**：两条宿主答复路由 `POST /api/daemon/tasks/:taskId/human-requests/:requestId/respond` 与 issue 决策卡路由改为要求 `{ token, operator_open_id }`；SQL 一次性完成：`UPDATE ... SET status='responded', token_consumed_at=?, responded_by=? WHERE id=? AND status='pending' AND token_hash=? AND token_recipient=? AND token_consumed_at IS NULL`；`changes = 0` 时区分错误码：`token_invalid`、`token_consumed`、`recipient_mismatch`（返回 403，宿主转成 toast）。`decision_operator_mismatch` 与成员映射（`resolveIssueDecisionOperatorMember`）保留在令牌校验之后：令牌管「是不是这张卡、是不是这个人」，成员映射管「这个人对应哪个 member」。Web 路由（成员登录答复）不走令牌，保持现状。
4. **宿主**（`packages/connectors/src/feishu/task-interaction.ts`）：从 `action.value` 取 `t`/`r`，直接转发服务端，不再比对内存里的 `recipientOpenId` / `chatId`；`pending` 登记表和 `restoreDecisionCardClicks` 只保留「message_id → 卡片补丁」的用途。宿主重启不影响答复。
5. **不落日志**：令牌明文不进 `log.*`、活动、Issue 评论；测试用 spy 断言日志行不含明文。

**验收**
- 正确的人 + 正确令牌 → 200，第二次同令牌 → 403 `token_consumed`；其他人拿到同一令牌 → 403 `recipient_mismatch`；重发卡片后旧令牌 → 403 `token_invalid`。
- 宿主进程重启后（无内存登记）点击仍成功。
- `fr_`（任务提问）和 `fd_`（issue 决策）两条路径各一套用例；PG、SQLite 都跑。
- `multiremi-issue-decision-card.test.ts` 里模拟点击的 `action` 改为携带 `value`，顺手把调研发现的「表单 checker 选项只从 `action.name` 读」问题作为本单测试覆盖（若确认是 bug，修在本单，范围内：卡片答复路径）。

## 3. 评论 `cmt_okduecknm176` 的 7 个问题

**Q1 统一收件箱和 conversation_log 的关系；和 MUL-427 唤醒读者的衔接；本单 merge 哪些分支。**
- 关系：**在日志上加游标做投影，不单独建表。** 理由：三类消息今天已经或即将在收件人的会话日志里（@ = 评论；E2 子单结果 = 父单会话的系统评论；队友回报 = `delegation_report` 会话事件，本单改成系统评论）；lane 的 `cursor_seq` 已经是「读到哪」；再建一张收件箱表就有两份「agent 看到了什么」的真相，还要另做投影和前端。
- 与 MUL-427 的衔接：MUL-427 把投影、`agentCommentedSince`、W4 覆盖判定、@ 派发全部改到读日志，本单直接在这些读者上工作，不再碰 `session_events`。MUL-427 没做的两件事由本单补：`delegation_report` 进日志（改成信封系统评论）、E4 答复进日志（今天只在 prompt 里）。日志的 `emit()` 监听器仍在事务内、提交前触发（MUL-427 未改），所以本单的唤醒不依赖监听器，只依赖同事务写入的 queued 行。
- merge：`origin/main`（含 MUL-412、MUL-409、MUL-456）→ `origin/agent/MUL-427`（自带 MUL-402）→ `origin/agent/MUL-403`（含 MUL-436、C5）→ `origin/agent/MUL-452`。必须合 427：不合 427 就得在 `session_events` 上再做一遍再迁一次，违反「一步到位」。必须合 452：本单删掉的提交后钩子里包含 E3 自动开工的宿主 `notifyChildStatusChange`，要和 452 的回放对齐边界。冲突文件见 §0.1。

**Q2 唯一约束落在哪张表，PG / SQLite 怎么写；和 session lane、队友回报合并逻辑的关系。**
- 落在 `multiremi_tasks`，两条部分唯一索引（SQL 见 D1 第 3 条），一段 SQL 两种方言（`translateSqliteToPg` 不动 `WHERE`，先例 `idx_multiremi_webhook_deliveries_dedupe`）。前提是给 `multiremi_tasks` 加真实列 `execution_scope`，因为 SQLite 与 PG 的部分索引都不适合放 `CASE WHEN` 表达式（PG 支持但 `ON CONFLICT` 无法命中；SQLite 支持但 `translateSqliteToPg` 不翻译表达式索引），列比表达式稳。
- 与 session lane：lane 主键 `(session_id, agent_id, execution_scope)` 与唯一索引的键**一模一样**，lane 负责「读到哪 + provider 会话缓存」，待处理轮负责「下一轮什么时候跑」。两者不互相取代。
- 与队友回报合并逻辑：`drainDelegationReturnsWithinWorkspaceLock` 的**发现与盖章**保留（找终态子任务、`delegation_return_task_id`、`already_covered`），它的**合并与拼 prompt**被 `ensurePendingTurn` 取代。今天 30 天里「触发 700、合并 20、被覆盖 75」对应的三个活动 `delegation_return_triggered / _skipped(coalesced_into_pending_return) / _skipped(already_covered)` 改为 `pending_turn_created / pending_turn_coalesced / pending_turn_skipped(already_covered)`，其余 `DelegationSkipReason`（`delegator_unavailable` 等）保留。E2、E4、@ 的三套 `findQueued…` 判定同样被取代（它们的谓词彼此不一致：报告 2 §「Things that matter」第 1 条）。

**Q3 E2 / E3 通知类 / E4 如何同事务；「事务深度 1」怎么调；崩溃注入怎么设计；与 MUL-452 的分界。**
- 同事务：三条路径都已经有「外层拥有唯一事务」的结构（`updateIssueWithOutcome`、`syncIssueStatusFromTaskWithinTransaction`、`answerIssueDecision`），今天缺的是它们把唤醒推到提交后另开事务。改法是把 `notifyParentOfChildOutcome`、`reportPrerequisiteFailureToOwner`、`reportDependencyReady`、决策答复唤醒都改成 `…WithinTransaction`，接收外层的 `collector` 与 `deferredEvents`，在外层事务内调用 `sendEnvelope` → `ensurePendingTurn`。
- 深度规则：**不变，仍是深度 1**。变的是「哪些东西允许留在提交后」：只剩推送（`emitCommitEvents`、`notifyTaskEnqueued`）和 E3 自动开工（要锁另一张 issue，有锁序问题，MUL-452 已用 `system_events` 回放兜底）。ADR 0003 决策 8 由 ADR 0010 补注，深度测试加断言（D1 第 7 条）。
- 崩溃注入：三个注入点 `before-turn / after-turn / after-commit`，三个场景 E2 / E3 失败通知 / E4，两后端，共 18 例，加一条 PG 并发例；用 MUL-452 的子进程 + `SIGKILL` 模式，注入方式是运行时包 `db.run` / `db.transaction` / `ctx.emitCommitEvents`，生产代码不加钩子（D1 第 8 条）。
- 分界：MUL-452 只回放 E3 **自动开工**（`dependency_auto_start_check`，`replayDependencyAutoStart` 明确不回放通知，测试 U4）。本单负责 E2、E3 **通知类**、E4 的同事务写入，不写回放。两边接缝在 `notifyChildStatusChange`：本单删掉它里面的报告事务，保留它对 `reactToIssueDependencyOutcome` 的提交后调用；MUL-452 的 ADR 0004 §5 文字里「E2/E4 and E3 readiness/failure notifications belong to MUL-404」不需要改。

**Q4 未读投影「目录 + 优先级」与「长正文先摘要」；展开用什么命令。**
- 目录 = JSONL 里新增一行 `inbox_toc`，daemon 提示词渲染成 `## Inbox` 四组（人的决定 / 失败·卡住 / 完成 / 知会）；优先级由 `envelopePriority(entry)` 纯函数决定，旧条目用启发式（D3 第 1 条）。
- 折叠：4000 不再是截断上限而是折叠阈值；超过的条目给「前 600 字 + markdown 标题大纲 + 省略字数 + 展开命令」。摘要是确定性的，不调模型（被否方案见 §5）。
- 展开命令：新增 `remi session log get <session> <seq|entry-id>`（新路由 `GET /api/sessions/:id/log/entry`），并让 `remi session event list` 转发 `--since-seq/--to-seq`。两者同批注册 CommandRegistry、重生成 `cli-capabilities.json`、checker 0 missing、更新 `docs/cli-command-migration.md`（项目规则 7）。

**Q5 转述 Remi 改按 cursor 读 issue 日志；和 C5 按 kind 拆行怎么衔接；`multiremi_agent_issue_update_state` 何时删。**
- 游标复用 lane（`execution_scope = 'relay:<chat_session_id>'`），触发条件扩到 failed / cancelled，内容是「日志区间指针 + 认领时附上区间内容」（D4）。
- 与 C5：C5 管**飞书怎么发**（`cot` 载体行、`receipt` 独立 lease、`result_card`），本单管**转述 Remi 什么时候醒、读什么**。接缝只有 `prepareFeishuIssueRoundPushesWithinTransaction`：触发条件从「负责人 completed」改为 D4 的条件，「有 pending chat 任务就 steer」改为 chat lane 的 `ensurePendingTurn`；`cot` 行的创建与 lease 一行不改。`agent-issue-updates-repo.ts` 在 main 与 MUL-403 完全相同，没有合并冲突。
- 删表：**放到切换后的删旧步骤。** 本单只停止写入与清扫（D4 第 5 条）。理由：描述的开工条件明确「删旧表、旧接口放最后」；且该表的 repo 与 `feishu-bot-repo.ts` 同文件区域，C5 还在动，现在删会再打一次架。

**Q6 提问卡片一次性令牌与 MUL-412 的分工。**
- MUL-412 今天已合入 main（439aa141），不再有「两边同时改一处」的问题。D5 在已合入的代码上把 `fd_`（issue 决策卡）和 `fr_`（任务提问卡）两条路径一起改成令牌校验；MUL-412 的成员映射（`resolveIssueDecisionOperatorMember`）保留在令牌之后作为第二层。D5 基于 `origin/main` 起步，不需要 402/403，可以今天和 D1 同时派。

**Q7 哪些部分依赖切换后的生产数据。**
- 只有：删 `multiremi_agent_issue_update_state`（表、repo、30s 清扫）；删 `session_events` 的 `delegation_report` 旧写入（随 B 的 MUL-432 删旧表）；209 生产切换；上线后观测（`pending_turn_coalesced` / `pending_turn_skipped` / `re_ring` 计数、折叠命中率、转述汇报次数）。其余 D1–D5 全部现在开工。

## 4. 验收标准对照（描述范围 1–5 + 崩溃安全）

| 描述条目 | 验收怎么判 | 落在哪张子单 |
|---|---|---|
| 范围 1 `send(envelope)` 字段 `to / kind / wake / dedupeKey / replyTo / grantRef` | contracts 里有该类型；`sendEnvelopeWithinTransaction` 是五条路径唯一的写入口（grep 不再出现四个被删函数）；`to` 六种角色各有单测；`dedupeKey` 重复发送只产生一条日志条目、seq 不产生空洞；`grantRef` 原样落 metadata 不解释 | D1 |
| 范围 1 回执尽力而为、回执失败不影响消息 | 认领后 `turn.metadata.inbox.delivered_to_seq` 存在；spy 让 patch 抛错，认领仍成功、消息仍在 | D2 |
| 范围 2 三类消息进同一收件箱 | E2 结果、队友回报、@ 三种触发后，收件人会话日志各多一条带 `metadata.envelope` 的条目，投影 `inbox_toc` 三条都在 | D1（写入）+ D3（目录） |
| 范围 2 每个 (会话, agent) 只有一个待处理轮，由唯一约束保证 | 两条部分唯一索引存在于 PG 与 SQLite；同键第二条 queued INSERT 失败；迁移折叠既有重复不丢 prompt | D1 |
| 范围 2 认领时写「已送达」回执 | 同上「回执」 | D2 |
| 范围 2 轮次结束仍有未读则 re-ring | 运行中收到 now 信封 → 结束后恰好一条新 queued；`next_turn` / `inbox_only` / 自己写的 → 不 re-ring | D2 |
| 范围 3 目录 + 优先级（人的决定 > 失败/卡住 > 完成 > 知会） | 四类混合窗口的目录顺序 1→2→3→4；提示词有 `## Inbox` 四组 | D3 |
| 范围 3 修掉 4000 字截断，长正文先摘要再展开 | 23,109 字 fixture 折叠为大纲 + 展开命令；`remi session log get` 取回全文字数一致；CLI checker 0 missing | D3 |
| 范围 4 转述 Remi 用自己的 cursor 读 issue 日志 | 转述任务认领 `bound_issue_log` 覆盖 (cursor, head]；完成后 cursor = head；旧聚合表 0 写入 | D4 |
| 范围 4 失败和取消的轮次也要汇报 | 负责人轮次 failed / cancelled → 转述 chat 收到 `report/outcome` 信封；真机冒烟一次 | D4 |
| 范围 4 文字总结仍由转述 Remi 负责 | 服务端只给区间内容与指针，不生成总结（代码里没有总结文本模板） | D4 |
| 范围 5 提问卡片一次性令牌，只绑定被问的人 | 正确人 + 令牌 200；二次 403 `token_consumed`；他人 403 `recipient_mismatch`；重发后旧令牌 403 `token_invalid`；宿主重启后仍可答 | D5 |
| 崩溃安全：E2 / E3 通知类 / E4 的写待处理轮与状态变化同事务 | 深度测试断言事务内出现 `INSERT INTO multiremi_tasks` 且 `maxTransactionDepth === 1` | D1 |
| 崩溃安全：三个注入点，结果只能「都没提交」或「都提交」 | 18 例（3 点 × 3 场景 × 2 后端）+ 1 例 PG 并发 | D1 |
| 崩溃安全：重启后唤醒不丢不重复，每键仍只一条 | `after-commit` 例重启后恰一条 queued，重复触发仍一条 | D1 |
| 真实 PG 与 SQLite 都通过 | 所有新增测试用 `MULTIREMI_TEST_POSTGRES_URL` 双后端模式；CI 配置了该变量则 PG 例不得 skip | D1、D2、D5 |
| 本单上线前 E2/E4 窗口仍在，由父单每轮盘点兜底 | 不是本单验收；写进 ADR 0010 的「过渡」段 | — |

## 5. 被否方案及理由

| 被否方案 | 最强论据 | 为什么不成立 |
|---|---|---|
| **A. 单独建收件箱表 `multiremi_inbox_envelopes`**（信封一行一条，游标在该表） | 不用动 B 的日志语义，前端也不用渲染新东西 | 三类消息今天就已经在收件人会话日志里，再建表就是两份「agent 看到了什么」；投影、目录、展开命令都要再做一套；lane 游标要么废掉要么两套并存。 |
| **B. 待处理轮单独建表 `multiremi_pending_turns`**（Multica 原样） | 主键天然唯一，`INSERT ... ON CONFLICT DO UPDATE` 一条 SQL 完成合并 | 要和 `multiremi_tasks` 的 queued 行保持一致（取消、认领、requeue 都要双写）；daemon 认领路径只认 tasks。部分唯一索引直接放在 tasks 上，queued 行本身就是待处理轮，少一张表少一类不一致。 |
| **C. 用 Live Hub 订阅当唤醒载体**（agent 作为订阅者） | MUL-436 已有环形缓冲与订阅接口，延迟最低 | 内存态、单进程、进程重启即丢，和「唤醒不因进程崩溃丢失」正面冲突；日志监听器在事务内提交前触发，看到的可能是会回滚的写入；ADR 0007 也没有「agent 订阅者」。Hub 留给浏览器和飞书。 |
| **D. 用 `multiremi_system_events` 出箱回放 E2/E4**（MUL-452 同款） | 已有 claim/lease/退避机制，写事件行也是同事务 | 多一跳（5s 可用延迟 + ≤30s 轮询）；queued 任务行本身就是持久出箱，同事务写它比写事件再回放少一个消费者；MUL-452 保留 E3 自动开工回放是因为自动开工要锁另一张 issue，唤醒没有这个问题。 |
| **E. 新增日志 kind `envelope`** | 语义最干净，投影按 kind 直接分流 | 需要 B 改 `CONVERSATION_LOG_KIND_VISIBILITY`、C 的浏览器副本加渲染器，本单会同时卡在两条前置分支上；系统评论已经是 `system` kind 并带 metadata，够用。切换上线后若要单独 kind，另开单。 |
| **F. 认领时用模型生成长正文摘要** | 摘要质量高 | 认领在事务里、要确定性、要快；每次认领都调模型成本不可控；折叠 = 前 600 字 + 标题大纲已能让 agent 决定要不要展开。 |
| **G. 保留 `multiremi_agent_issue_update_state` 作为缓存，转述 Remi 两边都读** | 平滑过渡 | 贺华杰定的是一步到位不做中间兼容；两份来源会重复汇报。停写即可，删表按规则放最后。 |
| **H. 令牌用确定性标记（沿用 `fd_<sha256(issueId:decisionId)>`）** | 不用新列，宿主无状态 | 可推导、不能一次性作废、不绑人；描述要求「一次性、只绑定被问的人」。 |
| **I. 人的 @ 仍然「每条新建一轮、不合并」**（保留今天 by request 的规则） | 每次 @ 都有独立的轮次卡片，可追溯 | 与「每键只一条待处理轮」的唯一约束直接矛盾；合并后评论仍在日志与目录里，可追溯性不减。此项作为用户可见变化在 §8 Q-B 请贺华杰确认。 |

## 6. 风险与回滚

**风险**

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 四路合并基线（main + 427 + 403 + 452）冲突多，§0.1 列了 20 余个文件，`feishu-bot-repo.ts` 是 MUL-412 与 C5 的正面冲突 | D1 第一天可能不止一天；解错会让 C5 拆行或决策卡失效 | 基线单独一个提交，`bun test` 全绿再推；解冲突原则写在 D1 第 1 条；402/403 再前进就再 merge 一次，不 rebase |
| R2 | 唯一索引迁移时生产库里有重复 queued（30 天里 75 次「被覆盖」说明并发常见） | 迁移失败会让平台起不来 | 折叠迁移先跑、索引后建，同一 `runMigrationOnce`；在 209 只读导出的 tasks 快照上先演练一次；部署前按规则请贺华杰批准并备份（该迁移会把任务置 cancelled，属数据变更） |
| R3 | 人的 @ 合并进已排队轮，`## Triggering Comment` 显示的是最早那条 | agent 可能把最早的 @ 当成主要请求 | D3 的 `## Inbox` 把所有未读 @ 按优先级 1 列在最上；触发评论段落注明「还有 N 条未读请求，见 Inbox」；仍列为 §8 Q-B 请确认 |
| R4 | daemon 提示词构建在 `packages/daemon`，平台与 daemon CLI 分开升级 | 老 daemon 看不到 `## Inbox`，新 daemon 遇老平台没有 `inbox_toc` | 两边都容错（D3 第 4 条），不假设同时升级；发版说明写清 |
| R5 | re-ring 死循环 | 一个 agent 每轮都被自己触发 | 只数「他人写的、`wake = now`、seq > cursor」的条目，自己的评论不算；取消的轮次不推进 cursor 会 re-ring 一次，第二次 cursor 推进后停止；测试覆盖 |
| R6 | 锁序：`ensurePendingTurn` 在外层事务内取 workspace 行锁，而 E3 自动开工路径先 workspace 再 issue `FOR UPDATE` | PG 上顺序反了会死锁 | 统一「workspace → issue session → issue」顺序，`ensurePendingTurn` 只在已持 workspace 锁的事务里调用（断言 `markRequestReadCacheLockTaken` 已置） |
| R7 | 转述 Remi 触发条件放宽到所有轮次与失败/取消 | 飞书话题里汇报变多 | §8 Q-A 请确认；dedupeKey 保证一轮一封；`hasActiveTaskForIssue` 仍要求 issue 无活跃任务 |
| R8 | 令牌明文经外发行载荷到宿主 | 泄露到日志或评论 | 只存哈希；测试 spy 断言日志无明文；`decision_card` 载荷不进 `appendIssueActivity` |
| R9 | 系统评论变多：队友回报、决策答复从 prompt 变成收件人会话里可见的系统评论 | 时间线更长 | 这是统一收件箱的必然结果，且现有 E2 通知已是系统评论；§8 Q-B 一并说明 |
| R10 | MUL-427 尚未合入 MUL-402，427 若被 B 的复核改动，本单基线要再合 | 重复解冲突 | PR 里写明依赖 `origin/agent/MUL-427@566ccf8b`；427 变化时由 D1 负责人再 merge |

**回滚**
- 每张子单一个 PR，可独立 revert。D2–D5 revert 后系统退回 D1 状态仍自洽（D1 是完整的一步：唯一约束 + 同事务唤醒）。
- D1 revert：代码 revert 后 `execution_scope` 列与两条索引留着无害（索引只约束 queued；老代码本来就靠先查后写）。若必须去掉索引：新迁移 `DROP INDEX IF EXISTS` 两条，`runMigrationOnce` 新 id。折叠迁移置为 `cancelled` 的任务不可自动恢复，这是 R2 要备份的原因。
- D4 revert：旧聚合的代码没删，只是不再调用，revert 即恢复 30s 聚合。
- D5 revert：新列留着无害，宿主与服务端路由恢复 open_id 比对。
- 生产：按项目规则由 updater 保留旧镜像回滚，不在 209 上手工改。
- 不做功能开关：贺华杰要求一步到位，不留兼容路径；回滚粒度就是 PR。

## 7. ADR 正文（由 D1 落进 `docs/adr/`）

ADR 门槛（三条同时满足）：难以回退（改 `multiremi_tasks` 约束与五条唤醒路径的事务结构）、没上下文会奇怪（为什么收件箱不是一张表、为什么唤醒不走出箱回放）、真实取舍（§5 A–E）。令牌单独成 0011：安全边界的决定，回退代价与语义都和 0010 不同。

### `docs/adr/0010-unified-inbox-and-single-pending-turn.md`

```markdown
# ADR 0010: Unified inbox on the conversation log, one pending turn per lane, wakes commit with state

- Status: accepted (MUL-404, 2026-09-28; supersedes the per-path coalescing in ADR 0005 decisions 3–6 and amends ADR 0003 decision 8)
- Deciders: 贺华杰 (scope), Senior大哥 (design), 带头大哥 (split)

## Context

Three wake paths grew independently: delegation returns
(`drainDelegationReturnsWithinWorkspaceLock`), child terminal notifications
(MUL-400 E2), and comment mentions. Each has its own "find the queued task"
predicate, its own prompt-append coalescing, and its own lock coverage; the
predicates disagree (delegation ignores `continued_from_task_id`, E2 ignores
`projection_to_seq` and execution scope), and nothing in the database prevents
two queued rounds for the same agent on the same session. E2, the E3
notifications, and E4 run their wake in a post-commit hook that opens a second
transaction, so a process exit between the two commits loses the wake (ADR 0004
§5 "known crash window"). Agents wake to a JSONL projection with no table of
contents, no priority, and bodies cut at 4,000 characters.

MUL-402 B1 made `multiremi_conversation_log` the single per-session log, with
`multiremi_session_agent_lanes.cursor_seq` as each agent's read position
(ADR 0006). MUL-427 moved the wake readers onto that log. MUL-452 replays E3
automatic starts from `multiremi_system_events` and explicitly leaves the
notification wakes to this decision.

## Decision

1. **The inbox is the recipient's conversation log read from its lane cursor.**
   There is no inbox table. Every cross-agent message is an entry in the
   recipient's session log carrying `metadata.envelope` (`kind`, `wake`,
   `dedupe_key`, `reply_to`, `grant_ref`, `priority`, `source`). On Issue
   sessions the entry is a system comment (`kind = system`); on chat sessions it
   is a system message. Delegation reports and decision answers, which today live
   only in task prompts or `session_events`, become such entries.
2. **`sendEnvelopeWithinTransaction` is the only writer.** It resolves the
   role address, dedupes by a deterministic entry id under the session head lock
   (no seq is allocated for a duplicate), appends the entry, and calls
   `ensurePendingTurnWithinTransaction`. The five wake paths (E2, E3 failure
   notice, E3 readiness notice, E4, delegation return, mention) call it and
   nothing else. Message content is never appended to a task prompt.
3. **The pending turn is the queued `multiremi_tasks` row, one per lane.**
   `multiremi_tasks.execution_scope` becomes a stored column. Two partial unique
   indexes enforce at most one `status = 'queued'` row per
   `(issue_session_id, agent_id, execution_scope)` and per
   `(chat_session_id, agent_id)`. The key equals the lane primary key on purpose:
   the lane says how far the agent has read, the pending turn says that it will
   read again. Writers still look before they insert under the workspace row
   lock; the index is the invariant, not the control flow.
4. **Wakes commit with the state change.** `ensurePendingTurn` asserts it is
   inside the caller's transaction. ADR 0003 decision 8 ("every guarded path runs
   at transaction depth 1") stands; what changes is what may remain post-commit:
   only pushes (`emitCommitEvents`, `notifyTaskEnqueued`) and the E3 automatic
   start, which must lock a second Issue and is replayed by MUL-452. Crash
   injection before the turn write, after it, and after commit must observe
   either nothing or everything, on PostgreSQL and SQLite.
5. **`wake` has three meanings.** `now`: ensure a pending turn; if the turn ends
   with such entries still unread, ring again (re-ring). `next_turn`: no turn is
   created while one is queued or running; the entry rides along and never
   re-rings. `inbox_only`: never rings; it appears in the table of contents only.
6. **Receipts are best effort and coarse.** At claim time the turn card receives
   `metadata.inbox.delivered_to_seq`, written after the claim commit; failure
   is logged and does not affect the message. "Delivered" for a single entry is
   derived from the recipient lane cursor and turn coverage, never stored per
   entry.
7. **The unread projection gets a table of contents and folding.** Entries are
   ranked human decision > failed/stuck > done > notice, from
   `envelopePriority(entry)`; bodies over the fold threshold are summarised
   deterministically (head + heading outline) with an expand command instead of
   being cut.

## Consequences

- Four coalescing implementations and their prompt-append helpers are deleted.
  Skip/coalesce audit moves to `pending_turn_created | pending_turn_coalesced |
  pending_turn_skipped`; the lineage reasons in `DelegationSkipReason` stay.
- A human mention while a round is queued no longer creates a second queued
  task; it is read by the queued round. A continuation task is the pending turn
  for its lane like any other queued task.
- Delegation reports and decision answers become visible system comments in the
  recipient session.
- The migration collapses existing duplicate queued rows (keeps the oldest,
  appends the newer prompts, cancels the newer rows) before creating the indexes.
- The relay agent (转述 Remi) reads the Issue log through a lane of its own
  (`execution_scope = relay:<chat_session_id>`) instead of the latest-only
  aggregate in `multiremi_agent_issue_update_state`; that table is dropped after
  the v2 switch-over, not here.
- Until this lands, the E2/E4 crash window from ADR 0004 §5 remains and is
  covered by the parent's per-round inventory of children.

## Alternatives considered

A separate inbox table; a separate pending-turn table; the Live Hub as the
wake carrier; `multiremi_system_events` replay for E2/E4; a new log kind
`envelope`. All rejected for the reasons in the MUL-404 plan §5.
```

### `docs/adr/0011-question-card-one-time-token.md`

```markdown
# ADR 0011: Question cards are answered with a one-time token bound to the addressee

- Status: accepted (MUL-404 range 5, 2026-09-28)

## Context

Task question cards (`fr_`) and Issue decision cards (`fd_`, MUL-412) decide
who may answer in two places that both rely on session identity: the bot host
keeps an in-memory registry keyed by `appId:open_message_id` and compares the
clicker's `open_id` and chat id with the card's recipient, and the server trusts
the host's `operator_open_id` (decision cards) or a fixed `responded_by =
"feishu"` (question cards). The registry is lost on host restart and re-built
from the database; the card action carries a derivable marker, not a secret.

## Decision

1. Every card delivery mints a random token. The database stores only its hash,
   the recipient `open_id`, and a consumed timestamp, on
   `multiremi_task_human_requests` and `multiremi_issue_decisions`. The plaintext
   travels once, inside the card action `value`.
2. The server is the only judge. The respond routes require `{token,
   operator_open_id}` and settle in one conditional `UPDATE` (`status =
   'pending' AND token_hash = ? AND token_recipient = ? AND token_consumed_at IS
   NULL`). Failures are `token_invalid`, `token_consumed`, `recipient_mismatch`.
   Member mapping (`resolveIssueDecisionOperatorMember`) runs after the token
   check.
3. Redelivery, retarget, and reminders rotate the token; the previous one is
   invalid immediately.
4. The host forwards; it no longer authorises. Its registry is kept only for
   card patching.
5. The web respond route (a signed-in member) is unchanged.

## Consequences

- A card survives host restarts and can be answered only once, only by the
  person it was addressed to.
- Tokens must never be logged or echoed into activities or comments.
- Group-owner-resolved recipients bind the token when the host reports the sent
  message's `interaction_open_id`.
```

## 8. 请贺华杰确认的三题（用户可见交互变化；方案按推荐答案写）

**Q-A 转述 Remi 的汇报触发范围**：今天只在 issue 负责人的轮次 completed 时汇报。改法有三种：
1. 推荐：**issue 上任何 agent 的轮次结束（completed / failed / cancelled）且 issue 无其他活跃任务时都汇报**。理由：范围 4 要求失败和取消也汇报；子单/委派的失败往往不是负责人的轮次；dedupeKey 保证一轮一封。
2. 只在负责人的轮次结束时汇报（三种状态都算）。
3. 负责人轮次三种状态 + 其他 agent 只在 failed / cancelled 时汇报。
答案不同时的改动点：D4 第 2 条的触发条件一处。

**Q-B 人的 @ 与已排队轮的关系**：唯一约束意味着同一 agent 在同一会话已有排队轮时，人的新 @ 不再新建第二个任务，而是并入那一轮（评论仍在日志和 `## Inbox` 里，优先级最高；`## Triggering Comment` 显示的是最早那条，并注明「还有 N 条未读请求」）。这推翻了之前「成员评论每条新建一轮、不合并（by request）」的规则。
1. 推荐：**并入已排队轮**。理由：这是范围 2「每键只一条待处理轮」的直接结果；agent 在同一轮里看到全部未读，比排两轮各看一半更好。
2. 例外：人的 @ 仍新建一轮，但把它排在已排队轮之后（需要放宽唯一索引的谓词，例如只约束 `wake_source IS NOT NULL` 的系统唤醒轮）。
答案选 2 时的改动点：D1 第 3 条索引谓词加 `AND wake_source IS NOT NULL`，D1 第 6 条 @ 路径保留新建，ADR 0010 决策 3 与后果第 2 条改写。

**Q-C 长正文的「摘要」怎么生成**：
1. 推荐：**确定性折叠**——前 600 字 + markdown 标题大纲 + 省略字数 + 展开命令，不调模型。理由：认领在事务内、要快、要可复现；agent 自己决定要不要展开。
2. 认领后异步调一次模型生成摘要，写回条目 metadata，下次投影用；首次仍用确定性折叠。
答案选 2 时的改动点：D3 第 2 条加一个提交后任务与 `metadata.summary` 字段，另需定模型与成本口径（本单不含）。

---
附：本文件路径 `/data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-404/.mul404-evidence/plan/mul404-plan.md`；调研报告 `.mul404-evidence/senior-explore-0928/1..5`。
