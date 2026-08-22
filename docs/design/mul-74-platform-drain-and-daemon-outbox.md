# MUL-74 设计说明:平台升级 Drain 协议 + daemon 持久化上报 Outbox

目标:平台(API/Web/ssh-mesh-control-plane)升级期间,正在执行的 Agent 无感——
不被终止、不丢消息、不卡在 `running`;升级默认不在有活跃任务时切换容器。

两层保护:

1. **Drain 协议**:升级切换容器前,平台进入 `draining`,daemon 暂停领取新任务,
   Updater 等待所有在线 daemon 确认且活跃任务归零后才执行 `docker compose up`。
2. **daemon Outbox**:daemon 对任务执行过程中的所有 API 上报改为本地持久化队列 +
   有序幂等重放,短暂 API 不可用(如 API 容器重建的 10~30s)不再中断 provider session。

---

## 一、Drain 协议

### 1.1 持久化维护状态(新表)

`packages/server/src/store/migrations.ts` 追加(遵循现有 `CREATE TABLE IF NOT EXISTS` 风格):

```sql
CREATE TABLE IF NOT EXISTS multiremi_platform_maintenance (
  id TEXT PRIMARY KEY,                    -- 恒为 'platform'(单行)
  mode TEXT NOT NULL DEFAULT 'normal',    -- normal | draining
  generation INTEGER NOT NULL DEFAULT 0,  -- 每次 normal→draining 自增
  operation_id TEXT,                      -- 持有 Drain 的平台 operation
  started_at TEXT,
  expires_at TEXT,                        -- lease 到期时间(UTC ISO)
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`multiremi_runtimes` 增列(`addColumnIfMissing`):

- `drain_ack_generation INTEGER` — 该 runtime 已确认并应用的 Drain generation
- `drain_ack_at TEXT` — 最近一次确认时间
- `drain_reported_active_tasks INTEGER` — daemon 自报的本地活跃任务数(仅展示/对账用)

新 repo `packages/server/src/store/repos/platform-maintenance-repo.ts`:

| 方法 | 语义 |
|---|---|
| `get()` | 读取单行;**惰性过期**:若 `mode='draining'` 且 `expires_at < now`,原地 CAS 回 `normal` 再返回(即 API 自动恢复,无需后台任务) |
| `beginDrain({operationId, reason, ttlMs})` | `normal→draining`:generation+1、记 operation_id/started_at/expires_at;若已是 `draining` 且 operation_id 相同 → 幂等续租;不同 → 409 冲突 |
| `renewDrain(operationId, ttlMs)` | CAS `WHERE mode='draining' AND operation_id=?` 刷新 `expires_at`;不匹配返回 null(lease 已失效/被释放) |
| `releaseDrain(operationId)` | **幂等**:`UPDATE ... SET mode='normal', operation_id=NULL ... WHERE mode='draining' AND operation_id=?`;已是 normal 或持有者不同时为 no-op,总是返回当前状态 |
| `recordRuntimeDrainAck(runtimeId, generation, activeTasks)` | 写 runtime 三列 |
| `drainStatus()` | 汇总:当前 maintenance + 在线 runtime 数(复用 `isRuntimeEffectivelyOnline`,5min 窗口)+ 已确认数(`drain_ack_generation >= generation`)+ 服务端权威活跃任务数(`multiremi_tasks` 中 `dispatched/running/waiting_local_directory/awaiting_human` 计数)+ 未确认 runtime 明细 |

**状态机**(mode × lease):

```
normal ──beginDrain(op)──▶ draining(gen+1, lease)
draining ──renewDrain(同 op)──▶ draining(续租)
draining ──releaseDrain(同 op)──▶ normal        (幂等,重复释放 no-op)
draining ──lease 过期后任意 get()──▶ normal      (Updater 崩溃自愈)
```

active 任务口径:**服务端权威计数**(tasks 表 in-flight 状态),包含离线 runtime 上
未恢复的 in-flight 任务——有卡死任务时 Drain 等到超时并失败,属于 fail-safe(操作者
需先处理卡死任务或取消),不会静默切换。daemon 自报值仅用于 UI 对账展示。

### 1.2 Updater API(复用 `X-Multiremi-Updater-Token` 鉴权,`denyUpdater`)

- `POST /api/platform-updater/drain/begin` `{operation_id, reason?, ttl_ms?}` → `{maintenance, status}`
- `POST /api/platform-updater/drain/renew` `{operation_id, ttl_ms?}` → `{maintenance, status, cancel_requested}`
  (renew 即轮询:一次调用完成续租 + 拿到聚合进度 + 取消标志;lease 失效返回 409)
- `POST /api/platform-updater/drain/release` `{operation_id}` → `{maintenance}`(幂等)

`ttl_ms` 服务端钳制在 30s~10min,默认 120s。

### 1.3 心跳协议扩展

请求(`POST /api/daemon/heartbeat`)新增可选字段:

```jsonc
{ "drain_ack_generation": 3, "active_task_count": 2 }
```

响应 ack 新增:

```jsonc
{ "drain": { "mode": "draining", "generation": 3 } }   // normal 时 mode="normal"
```

服务端心跳 handler:读 maintenance(触发惰性过期)、下发 `drain` 字段、把 daemon 上
报的 ack/active 写入 runtime 行。旧版 daemon 不发这两个字段 → 永不确认 → Drain 等待
超时失败(fail-safe,错误信息列出未确认 runtime,提示先升级/退役 daemon)。

### 1.4 daemon 行为(`packages/server/src/worker/daemon.ts`)

新增独立状态 `serverDrainGeneration: number | null`(**不复用** `claimsPaused`:
后者语义是"暂停后退出主循环",用于 CLI 自更新;Drain 需要"继续心跳、只停领取")。

- 收到 `drain.mode === "draining"`:记下 generation;**不再进入 claim 泵**;已运行任务
  继续;心跳继续,并在后续心跳带上 `drain_ack_generation` + `active_task_count`。
- 收到 `drain.mode === "normal"`:清空,恢复领取。
- `handleRuntimeUpdate` 的本地 `claimsPaused` 逻辑不变,两者互不影响。

### 1.5 Updater 编排(compose driver)

驱动契约扩展:`execute(operation, report, drain?)`,新增
`packages/platform-updater/src/drain.ts` 提供 `PlatformDrainCoordinator`
(begin / waitUntilDrained / release,基于 updater client)。

`update` / `rollback` 的 `activate()` 序列改为:

```
report(pulling)  → writeImageEnv → docker compose pull        # 镜像先拉,不等 Drain
report(draining) → drain.begin(operationId)
                 → waitUntilDrained: 每 5s renew(续租+取进度+取消标志)
                     · 每次把 {online, acked, active_tasks, waited_ms} 写进
                       operation.progress.drain 并 report(draining)
                     · cancel_requested → release → 终态 cancelled
                     · 超时(默认 15min,MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS)
                       → release → 抛 DrainTimeoutError → 终态 failed
                       (error 明确写"等待运行中任务结束超时,未执行切换",不切换容器)
report(switching) → docker compose up -d --no-deps api web ssh-mesh-control-plane
report(verifying) → verify()
finally           → drain.release(operationId)   # 成功/失败/健康检查失败/自动回滚后都释放,幂等
```

catch 内的自动回滚(恢复旧镜像 + `compose up` + verify)在 Drain 仍持有期间执行
(此时活跃任务已归零,回滚切换同样安全),随后 finally 释放。

`check_updates` / `restart` 不做 Drain(restart 的短暂中断由 Outbox 层兜底)。

失败恢复路径:

| 场景 | 结果 |
|---|---|
| Updater 在 wait 中崩溃 | 停止续租 → lease 到期 → API 惰性恢复 normal → daemon 恢复领取;operation 卡在 active_slot 由 Updater 重启后 claim-resume(现有行为) |
| API 在 Drain 期间重启 | maintenance 在 DB,状态不丢;updater report/renew 有重试 |
| Drain 超时 | 不执行 `compose up`,operation=failed,release 恢复调度 |
| 用户取消 | 仅限进入 switching 之前;operation=cancelled,release 恢复调度 |
| 本期不做"超时强制升级" | 保留人工路径:操作者可取消卡住的任务后重试升级 |

### 1.6 平台 operation 扩展

- `MultiremiPlatformOperationStatus` 新增 `draining`(非终态)、`cancelled`(终态);
  repo `TERMINAL_STATUSES` 加 `cancelled`。
- `multiremi_platform_operations` 增列 `cancel_requested INTEGER NOT NULL DEFAULT 0`
  (`addColumnIfMissing`)。
- 新操作端点 `POST /api/multiremi/platform/operations/:id/cancel`(owner/admin):
  - `queued`:直接置终态 `cancelled`(释放 active_slot)+ releaseDrain(幂等);
  - `preparing/pulling/draining`:置 `cancel_requested=1`,由 Updater 在 renew 时
    发现并自行收尾(release + report cancelled);
  - `switching/verifying/restarting/终态`:409 拒绝(已进入切换,不可取消)。
- `GET /api/multiremi/platform/status` 响应新增 `maintenance`(mode/generation/
  operation_id/expires_at/reason + 聚合 drain 进度)与 `lastOperation`(最近一条,
  用于终态后展示"已恢复任务调度 / Drain 超时,升级未执行")。

---

## 二、daemon Outbox

### 2.1 存储

位置:`~/.multiremi/outbox/<sha256(serverUrl|workspaceId|daemonId|provider).slice(16)>.db`
(`MULTIREMI_STATE_DIR`/`MULTIREMI_OUTBOX_DIR` 可覆盖;在 daemon 自己的状态目录,
不在 Git worktree;bun:sqlite,WAL,0600)。

```sql
CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,   -- 见 2.3
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- start|prompt|session_pin|progress|messages|usage|workspace|complete|fail
  payload TEXT NOT NULL,     -- JSON(不含 secret;只含已有上报接口的 body)
  seq INTEGER NOT NULL,      -- 任务内单调递增(入队顺序 = 提交顺序)
  terminal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | blocked
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_task_seq ON outbox_events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, next_attempt_at);
```

投递成功即删行(交付记录不保留)。

### 2.2 发送模型

新模块 `packages/server/src/worker/outbox.ts`(`TaskReportOutbox`)+ daemon 内每任务
一个投递泵(per-task 串行,任务间并行):

- `enqueue(taskId, kind, payload, {terminal})`:同步写库后立刻唤醒泵。健康网络下
  投递延迟 ≈ 一次事件循环,不影响消息展示时延。
- 泵按 `seq` 升序逐条投递:成功 → 删行;网络错误/连接拒绝/超时/5xx → `attempts++`,
  有限指数退避(1s,2s,5s,10s,30s,max 60s)持续重试,**不终止 Agent**;
  401/403/410 等永久权限错误 → 该任务队列整体 `blocked`,记录诊断,停止重试
  (daemon 现有 terminal-authority 处理不变);404(任务已被服务端删除)同样 blocked。
- **顺序保证**:同任务严格按 seq 提交;terminal 事件(complete/fail)总是最后入队,
  因此必然在 messages/usage/pin 之后提交。跨任务无顺序约束。

### 2.3 幂等键与服务端幂等(现状已具备,逐项核对)

| kind | 幂等键 | 服务端幂等机制(已存在) |
|---|---|---|
| messages | `taskId:msg:<首条 seq>-<末条 seq>` | `multiremi_task_messages` `ON CONFLICT(task_id, seq) DO UPDATE`(daemon 始终携带 seq) |
| complete | `taskId:complete` | router 守卫:非 `running` 直接返回现有任务,**不重复触发**评论/委派回流/自动化 |
| fail | `taskId:fail` | router 守卫:非活跃状态直接返回现有任务 |
| start | `taskId:start` | 仅 `dispatched/waiting_local_directory` 可转移,重放返回 400→按已达成处理 |
| prompt | `taskId:prompt` | `INSERT OR IGNORE` + 不可变校验 |
| usage | `taskId:usage:<n>` | 按 `provider+model` 合并 upsert |
| progress | `taskId:progress:<n>` | last-write-wins,重放无害 |
| session_pin | `taskId:pin:<n>` | `COALESCE` 更新,重放无害 |
| workspace | `taskId:ws:<n>` | issue workspace 整行 upsert |

即服务端**无需新增幂等机制**,仅需保持 router 守卫语义;新增测试固化该契约
(complete/fail 重放不得产生第二条评论/委派回流)。

### 2.4 daemon 执行路径改造

- `runAgent()` 流式循环里的 `await client.reportTaskMessages(...)` → `outbox.enqueue`
  (非阻塞)。**网络故障不再使 `runAgent()` 抛错退出、不再关闭 provider。**
  `reportTaskPrompt`、`pinTaskSession`、`reportIssueWorkspace`、human-request 的
  transcript message 同样入队。
- `handleTask()`:`startTask`、`reportProgress`、`reportTaskUsage`、
  `completeTask`/`failTask` 全部入队;terminal 入队后 `handleTask` 等待该任务队列
  排空(不影响 provider,已关闭;保证 `once` 模式、inflight drain、本地并发计数与
  服务端一致)。`stop()` 时中断等待,未投递记录留盘。
- 交互式调用不变(仍走直连,失败按现状降级):claim、human-request 创建/轮询、
  cancel 轮询、GC 等。
- **重启恢复**:`start()` 里 register 成功后、`recoverOrphans` **之前**,先重放
  Outbox 遗留记录(重点是 terminal)——否则实际已完成的任务会被 recoverOrphans
  误标 failed。blocked 记录跳过并计数。
- 上限与保留:`MULTIREMI_OUTBOX_MAX_BYTES`(默认 256MB)。超限时按序丢弃最老的
  **非 terminal** 记录并计数告警;terminal 事件永不丢弃。指标经 daemon 本地
  `/health` 暴露:pending/blocked 数、最老记录年龄、丢弃计数。

---

## 三、升级 UX(版本与服务页)

数据源:现有 2s/30s 自适应轮询的 `GET /api/multiremi/platform/status`(新增
`maintenance` + `lastOperation` 字段);刷新页面天然从服务端恢复真实进度。

阶段展示(由 `activeOperation.status` + `progress.drain` 推导):

| 状态 | 文案 |
|---|---|
| queued/preparing | 正在准备升级 |
| pulling | 正在拉取镜像 |
| draining + acked<online | 正在暂停新任务(N/M 个 daemon 已确认) |
| draining + active>0 | 等待 N 个运行中任务结束(已等待 X 分钟) |
| switching | 正在切换服务 |
| verifying | 正在验证 |
| lastOperation=succeeded | 已恢复任务调度 |
| lastOperation=failed(drain_timeout) | Drain 超时,升级未执行(任务继续运行,调度已恢复) |
| lastOperation=cancelled | 升级已取消,调度已恢复 |

- "取消升级"按钮:`queued/preparing/pulling/draining` 时可用 → cancel 端点;
  switching 及之后禁用。
- 长时间等待展示为"等待任务结束",不展示为失败;自动升级同样走 Drain 等待。
- i18n:zh-Hans + en 补 `platform.*` 键。

---

## 四、测试计划(对应 issue 11 项)

后端 `tests/unit/multiremi/`(`createMultiremiApp` + `app.request` 范式)、
`tests/unit/platform-updater/`(fake CommandRunner 范式)、
`tests/unit/daemon/` 或 worker 层(fetch 注入范式):

1. Drain 开启 → 心跳 ack 带 draining → daemon 不再 claim(worker 单测,fetch mock)
2. 已领取任务 Drain 期间继续执行至 complete(worker 单测)
3. `drainStatus()` 门:全部在线 runtime ack 当前 generation 且服务端 in-flight=0 才 ready(store/API 单测)
4. Drain 超时:fake runner 断言未执行 `compose up`,drain released,operation failed(driver 单测)
5. lease 过期:`get()` 惰性恢复 normal;心跳 ack 变回 normal(repo/API 单测)
6. runAgent 流式期间 fetch 连续失败 10~30s(模拟 API 重启)→ provider 不退出、任务最终 complete(worker 单测,短退避注入)
7. API 恢复后消息按原 seq 顺序补交(outbox 单测 + 服务端顺序断言)
8. complete/fail 重放:仅一条 issue 评论、仅一次委派回流(API 单测)
9. outbox 重启恢复:落盘 → 新实例重放(outbox 单测)
10. 更新失败自动回滚后 drain released、daemon 恢复领取(driver + API 单测)
11. 回归:`bun test` 全量、`bunx tsc --noEmit`、frontend vitest、
    `tests/arch/release-workflows.test.ts`、API 快照黄金重生成
    (`bun run scripts/snapshot-api-routes.ts`)

---

## 五、安全与运维

- Drain API 沿用 updater 双凭证(master token + `X-Multiremi-Updater-Token`);
  cancel 端点沿用 owner/admin 校验;daemon 心跳新字段走既有 daemon token 门。
- Outbox payload 仅含既有上报接口 body,不含 token/env;文件 0600。
- 运维文档:`deploy/README.md` 增补 Drain 流程说明、超时/取消行为、
  `MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS` 等环境变量。
- 平台部署与 daemon CLI 发版仍是两个流程;旧 daemon 不 ack Drain 时升级安全失败。
