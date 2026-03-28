# Scheduler 全链路修复 — SQLite 迁移设计

**日期**: 2026-03-27
**分支**: dashboard-redesign
**范围**: 写入端（cron-bridge）+ 存储层（SQLite）+ 读取端（remi-data）+ nextRunAt 计算

## 问题分析

Dashboard Scheduler 模块当前有 4 个问题：

1. **History/Summary 返回空数据** — `remi-data.ts` 的 `getSchedulerHistory()` 返回 `[]`，`getSchedulerSummary()` 返回全 0
2. **Status 缺少运行时状态** — `lastRun: null`、`nextRunAt: null`、`consecutiveErrors: 0`（硬编码）
3. **JSONL 日志无 jobId** — `appendRunLog()` 用 `handler` 做文件名，5 个 skill 共用 `skill:run` handler → 全混在 `skill_run.jsonl` 中无法区分
4. **nextRunAt 未计算** — 前端有展示位但后端返回 null

## 方案：SQLite 全链路

### 新建 `cron_runs` 表

在 `src/db/index.ts` 的 `getDb()` 建表区域添加：

```sql
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,          -- remi.toml 中的 id，如 "skill:ai-daily-briefing"
  handler TEXT NOT NULL,         -- handler 函数名，如 "skill:run"
  status TEXT NOT NULL,          -- "ok" | "error" | "skipped"
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,                    -- 错误信息（截断 500 字符）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_cron_runs_date ON cron_runs(created_at);
```

### 写入端改造

**`src/queue/queues.ts`** — `CronJobData` 增加 `jobId`：

```typescript
export interface CronJobData {
  jobId: string;                    // 新增：来自 remi.toml 的 job id
  handler: string;
  handlerConfig?: Record<string, unknown>;
}
```

**`src/queue/index.ts`** — `setupSchedulers()` 传入 `jobId`：

```typescript
data: { jobId: job.id, handler: job.handler, handlerConfig: job.handlerConfig },
```

**`src/queue/handlers/cron-bridge.ts`** — `appendRunLog` 改为 SQLite INSERT：

```typescript
function recordRun(jobId: string, handler: string, status: "ok" | "error", durationMs: number, error?: string): void {
  try {
    const db = getDb();
    db.run(
      `INSERT INTO cron_runs (job_id, handler, status, duration_ms, error) VALUES (?, ?, ?, ?, ?)`,
      [jobId, handler, status, durationMs, error ? error.slice(0, 500) : null]
    );
  } catch {
    // non-critical
  }
}
```

`handleCronJob` 中从 `job.data.jobId` 获取 jobId 并传给 `recordRun`。

移除 `appendFileSync` / JSONL 相关 import 和逻辑。

### 读取端改造（`web/remi-data.ts`）

**`getSchedulerStatus()`** — 填充 lastRun / nextRunAt / consecutiveErrors：

```typescript
getSchedulerStatus() {
  const db = getDb();
  const jobs = this._loadCronJobs().map((job) => {
    // 最近一次执行
    const lastRow = db.query(
      `SELECT status, created_at, duration_ms, error FROM cron_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(job.id);

    // 连续错误数
    const errCount = db.query(
      `SELECT COUNT(*) as cnt FROM (
        SELECT status FROM cron_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT 20
      ) WHERE status = 'error'`
    ).get(job.id);
    // 精确版：从最近一条 ok 之后连续计数
    const consecutiveErrors = this._countConsecutiveErrors(db, job.id);

    // 下次执行时间（用 croner 计算）
    const nextRunAt = this._calcNextRun(job);

    return {
      jobId: job.id,
      jobName: job.name ?? job.id,
      enabled: job.enabled,
      handler: job.handler,
      schedule: this._formatSchedule(job),
      lastRun: lastRow ? {
        status: lastRow.status,
        finishedAt: lastRow.created_at,
        durationMs: lastRow.duration_ms,
        error: lastRow.error ?? undefined,
      } : null,
      nextRunAt,
      consecutiveErrors,
    };
  });
  return { jobs };
}
```

**`_countConsecutiveErrors(db, jobId)`** — 从最近的记录向前扫描，遇到非 error 停止：

```sql
SELECT status FROM cron_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT 50
```
遍历结果直到 `status !== 'error'`。

**`_calcNextRun(job)`** — 用已有的 `croner` 库：

```typescript
import { Cron } from "croner";

private _calcNextRun(job: CronJobConfig): string | null {
  if (job.cron) {
    const c = new Cron(job.cron, { timezone: job.tz ?? "Asia/Shanghai" });
    const next = c.nextRun();
    return next?.toISOString() ?? null;
  }
  if (job.every) {
    // interval 类型：lastRun + intervalMs
    // 如果无 lastRun，返回 null
    return null;
  }
  return null;
}
```

**`getSchedulerHistory(jobId?, limit)`**：

```sql
SELECT job_id, status, duration_ms, error, created_at as ts
FROM cron_runs
WHERE (? IS NULL OR job_id = ?)
ORDER BY created_at DESC
LIMIT ?
```

**`getSchedulerSummary(days)`**：

```sql
SELECT DATE(created_at) as date,
  COUNT(*) as total,
  SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) as ok,
  SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as error,
  SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) as skipped
FROM cron_runs
WHERE created_at >= datetime('now', ? || ' days')
GROUP BY DATE(created_at)
ORDER BY date DESC
```

对于查询结果中缺少的日期，前端已经会填 0（或后端补零）。

### JSONL 历史数据迁移

在 `getDb()` 建表之后，添加一次性迁移：

```typescript
// 迁移条件：cron_runs 表为空 + ~/.remi/cron/runs/ 目录存在
const count = db.query("SELECT COUNT(*) as c FROM cron_runs").get();
if (count.c === 0) {
  migrateCronRunsFromJsonl(db);
}
```

迁移逻辑：
- 遍历 `~/.remi/cron/runs/*.jsonl`
- 文件名推导 handler：`skill_run.jsonl` → handler = `skill:run`
- 对于 `skill_run.jsonl`：没有 jobId 信息 → `job_id = "skill:run:unknown"`
- 其他文件（如 `agent_memory-audit.jsonl`）：文件名即 handler = job_id
- 每行解析为 `{ts, status, durationMs, error?}` → INSERT

### 前端

**零改动**。现有类型定义完全匹配：
- `SchedulerJobStatus.lastRun` → `{ status, finishedAt, durationMs, error }`
- `CronRunEntry` → `{ ts, status, durationMs, error, jobId }`
- `DailySchedulerSummary` → `{ date, total, ok, error, skipped }`

### 涉及文件清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/db/index.ts` | 新增建表 + JSONL 迁移 | `cron_runs` 表 + 一次性迁移函数 |
| `src/queue/queues.ts` | 修改 | `CronJobData` 加 `jobId` |
| `src/queue/index.ts` | 修改 | `setupSchedulers` data 中传 `jobId` |
| `src/queue/handlers/cron-bridge.ts` | 重写写入逻辑 | `appendRunLog` → `recordRun`（SQLite），移除 JSONL |
| `web/remi-data.ts` | 重写 3 个方法 | `getSchedulerStatus/History/Summary` 改为 SQL 查询 |

### 不涉及

- 前端组件（`Scheduler.tsx`、`stores/scheduler.ts`、`api/`）— 零改动
- API handler（`web/handlers/scheduler.ts`）— 零改动
- `remi.toml` 配置格式 — 不变

### 数据保留策略

- `cron_runs` 表不设自动清理（cron 执行频率低，一年估算 ~5000 行，占用 <1MB）
- 迁移完成后，JSONL 文件不删除（自然废弃，不再写入）
