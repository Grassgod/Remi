# Scheduler 全链路修复 — JSONL 完善方案

**日期**: 2026-03-28
**分支**: dashboard-redesign
**范围**: 写入端（cron-bridge）+ 存储层（JSONL 完善）+ 读取端（remi-data）+ nextRunAt 计算

## 问题分析

Dashboard Scheduler 模块当前有 4 个问题：

1. **History/Summary 返回空数据** — `remi-data.ts` 的 `getSchedulerHistory()` 返回 `[]`，`getSchedulerSummary()` 返回全 0
2. **Status 缺少运行时状态** — `lastRun: null`、`nextRunAt: null`、`consecutiveErrors: 0`（硬编码）
3. **JSONL 日志无 jobId** — `appendRunLog()` 用 `handler` 做文件名，5 个 skill 共用 `skill:run` handler → 全混在 `skill_run.jsonl` 中无法区分
4. **nextRunAt 未计算** — 前端有展示位但后端返回 null

## 方案：JSONL 全链路完善

保持 JSONL 作为存储层，修复写入格式 + 实现读取解析。

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

**`src/queue/handlers/cron-bridge.ts`** — 改造 `appendRunLog`：

1. **文件名改为按 jobId**：`skill:ai-daily-briefing` → `skill_ai-daily-briefing.jsonl`（冒号替换为下划线）
2. **每条记录加 jobId 字段**：

```typescript
function appendRunLog(jobId: string, handler: string, status: "ok" | "error", durationMs: number, error?: string): void {
  try {
    const runsDir = join(homedir(), ".remi", "cron", "runs");
    if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
    const safeId = jobId.replace(/[:/]/g, "_");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      jobId,           // 新增
      handler,         // 新增
      status,
      durationMs,
      ...(error && { error: error.slice(0, 500) }),
    });
    appendFileSync(join(runsDir, `${safeId}.jsonl`), entry + "\n", "utf-8");
  } catch {
    // non-critical
  }
}
```

`handleCronJob` 从 `job.data.jobId` 获取 jobId 传给 `appendRunLog`。

### 历史数据一次性迁移

启动时（或首次 API 调用时），检测 `skill_run.jsonl` 是否存在且未迁移 → 执行拆分迁移。

**迁移依据**：每个 skill 的 cron 时间在 UTC 维度上不重叠，通过 `ts` 的小时:分钟即可推断 jobId：

| UTC 时间范围 | 对应 Cron (CST) | jobId |
|-------------|----------------|-------|
| 02:10–02:25 | 10:15 | `skill:ai-daily-briefing` |
| 02:25–02:40 | 10:30 | `skill:feishu-insight` |
| 02:40–02:55 | 10:45 | `skill:memory-research` |
| 20:00–20:15 | 04:00 | `skill:repo-update` |
| 20:15–20:35 | 04:20 | `skill:larkparser-answer-maintain` |
| 其他 | — | 丢弃（无分析价值） |

**迁移流程**：
1. 读取 `skill_run.jsonl` 全部条目
2. 按时间范围推断 jobId，补充 `jobId` 和 `handler` 字段
3. 按 jobId 分组写入各自文件（`skill_ai-daily-briefing.jsonl` 等）
4. 将原 `skill_run.jsonl` 重命名为 `skill_run.jsonl.migrated`（标记已迁移 + 保留备份）

**幂等性**：检测 `skill_run.jsonl` 是否存在（非 `.migrated`）作为迁移条件。迁移完成后不会再触发。

### 读取端改造（`web/remi-data.ts`）

新增私有方法 `_loadAllRuns()` — 扫描 `~/.remi/cron/runs/*.jsonl`，解析所有条目到内存数组，按 `ts` 降序排列：

```typescript
interface RunEntry {
  ts: string;
  jobId: string;
  handler: string;
  status: "ok" | "error" | "skipped";
  durationMs: number;
  error?: string;
}

private _loadAllRuns(): RunEntry[] {
  const runsDir = join(this.remiDir, "cron", "runs");
  if (!existsSync(runsDir)) return [];
  const entries: RunEntry[] = [];
  for (const file of readdirSync(runsDir).filter(f => f.endsWith(".jsonl"))) {
    const lines = readFileSync(join(runsDir, file), "utf-8").trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      const raw = JSON.parse(line);
      entries.push({
        ts: raw.ts,
        jobId: raw.jobId ?? raw.handler ?? file.replace(".jsonl", "").replace(/_/g, ":"),
        handler: raw.handler ?? file.replace(".jsonl", "").replace(/_/g, ":"),
        status: raw.status,
        durationMs: raw.durationMs,
        error: raw.error,
      });
    }
  }
  return entries.sort((a, b) => b.ts.localeCompare(a.ts));
}
```

**`getSchedulerStatus()`** — 填充 lastRun / nextRunAt / consecutiveErrors：

```typescript
getSchedulerStatus() {
  const allRuns = this._loadAllRuns();
  const jobs = this._loadCronJobs().map((job) => {
    const jobRuns = allRuns.filter(r => r.jobId === job.id);

    // lastRun：该 job 最近一条记录
    const last = jobRuns[0] ?? null;

    // consecutiveErrors：从最近记录向前数连续 error
    let consecutiveErrors = 0;
    for (const r of jobRuns) {
      if (r.status === "error") consecutiveErrors++;
      else break;
    }

    // nextRunAt：用 croner 计算
    const nextRunAt = this._calcNextRun(job);

    return {
      jobId: job.id,
      jobName: job.name ?? job.id,
      enabled: job.enabled !== false,
      handler: job.handler,
      schedule: this._formatSchedule(job),
      lastRun: last ? {
        status: last.status,
        finishedAt: last.ts,
        durationMs: last.durationMs,
        error: last.error,
      } : null,
      nextRunAt,
      consecutiveErrors,
    };
  });
  return { jobs };
}
```

**`_calcNextRun(job)`** — 用已有的 `croner` 库：

```typescript
import { Cron } from "croner";

private _calcNextRun(job: CronJobConfig): string | null {
  if (job.cron) {
    try {
      const c = new Cron(job.cron, { timezone: job.tz ?? "Asia/Shanghai" });
      const next = c.nextRun();
      return next?.toISOString() ?? null;
    } catch { return null; }
  }
  return null;  // interval/at 类型暂不计算
}
```

**`_formatSchedule(job)`** — 格式化 schedule 显示：

```typescript
private _formatSchedule(job: CronJobConfig): { kind: string; expr?: string; intervalMs?: number } {
  if (job.cron) return { kind: "cron", expr: job.cron };
  if (job.every) return { kind: "every", intervalMs: parseIntervalToMs(job.every) };
  if (job.at) return { kind: "at", expr: job.at };
  return { kind: "unknown" };
}
```

**`getSchedulerHistory(jobId?, limit)`**：

```typescript
getSchedulerHistory(jobId?: string, limit = 50) {
  let runs = this._loadAllRuns();
  if (jobId) runs = runs.filter(r => r.jobId === jobId);
  return runs.slice(0, Math.min(limit, 200)).map(r => ({
    ts: r.ts,
    jobId: r.jobId,
    status: r.status,
    durationMs: r.durationMs,
    error: r.error,
  }));
}
```

**`getSchedulerSummary(days)`**：

```typescript
getSchedulerSummary(days: number) {
  const allRuns = this._loadAllRuns();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const recentRuns = allRuns.filter(r => r.ts >= cutoff);

  // 按日期聚合
  const byDate = new Map<string, { total: number; ok: number; error: number; skipped: number }>();
  for (const r of recentRuns) {
    const date = r.ts.slice(0, 10);  // YYYY-MM-DD
    const bucket = byDate.get(date) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
    bucket.total++;
    bucket[r.status]++;
    byDate.set(date, bucket);
  }

  // 补零：确保每天都有条目
  const result = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const bucket = byDate.get(dateStr) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
    result.push({ date: dateStr, ...bucket });
  }
  return result;
}
```

### 前端

**零改动**。现有类型定义完全匹配：
- `SchedulerJobStatus.lastRun` → `{ status, finishedAt, durationMs, error }`
- `CronRunEntry` → `{ ts, status, durationMs, error, jobId }`
- `DailySchedulerSummary` → `{ date, total, ok, error, skipped }`

### 涉及文件清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/queue/queues.ts` | 修改 | `CronJobData` 加 `jobId` 字段 |
| `src/queue/index.ts` | 修改 | `setupSchedulers` data 中传 `jobId` |
| `src/queue/handlers/cron-bridge.ts` | 修改写入逻辑 | `appendRunLog` 加 `jobId` 参数，文件名按 jobId |
| `web/remi-data.ts` | 重写 3 个方法 + 新增辅助方法 | `_loadAllRuns` + `getSchedulerStatus/History/Summary` 读取 JSONL + croner 计算 nextRunAt |

### 不涉及

- 前端组件（`Scheduler.tsx`、`stores/scheduler.ts`、`api/`）— 零改动
- API handler（`web/handlers/scheduler.ts`）— 零改动
- `remi.toml` 配置格式 — 不变
- `src/db/index.ts` — 不改动，不建新表

### 性能考量

- JSONL 文件全量读取 + 内存聚合：一年 ~5000 行，每次请求解析耗时 < 5ms，无需缓存
- 如果未来数据量增长到性能瓶颈，可按需迁移到 SQLite（表结构已在旧 spec 中设计好）
