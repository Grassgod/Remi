# Scheduler JSONL Full-Stack Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dashboard Scheduler page show real data — job status with lastRun/nextRunAt, execution history, and 7-day trend — by fixing JSONL write format and implementing JSONL read in the dashboard.

**Architecture:** Fix the write side (cron-bridge) to include `jobId` in each JSONL entry and use per-job filenames. Migrate the old mixed `skill_run.jsonl` by inferring jobId from timestamps. Implement the read side (remi-data) to parse JSONL files, compute aggregates in memory, and calculate nextRunAt via the existing `croner` library.

**Tech Stack:** TypeScript, Bun runtime, JSONL files, croner (already in deps)

---

### Task 1: Add `jobId` to `CronJobData` and pass it through `setupSchedulers`

**Files:**
- Modify: `src/queue/queues.ts:27-30`
- Modify: `src/queue/index.ts:148`

- [ ] **Step 1: Add `jobId` field to `CronJobData` interface**

In `src/queue/queues.ts`, add `jobId` to the interface:

```typescript
/** remi:cron — 定时任务（Phase 2） */
export interface CronJobData {
  jobId: string;
  handler: string;
  handlerConfig?: Record<string, unknown>;
}
```

- [ ] **Step 2: Pass `jobId` in `setupSchedulers` data payloads**

In `src/queue/index.ts`, update both the repeating scheduler and the one-shot job to include `job.id` in the data object.

For the repeating scheduler (line ~148), change:

```typescript
data: { handler: job.handler, handlerConfig: job.handlerConfig },
```

to:

```typescript
data: { jobId: job.id, handler: job.handler, handlerConfig: job.handlerConfig },
```

For the one-shot delayed job (line ~164), change:

```typescript
await this.cronQueue.add("cron", { handler: job.handler, handlerConfig: job.handlerConfig }, {
```

to:

```typescript
await this.cronQueue.add("cron", { jobId: job.id, handler: job.handler, handlerConfig: job.handlerConfig }, {
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bun build src/queue/queues.ts --no-bundle 2>&1 | head -20`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add src/queue/queues.ts src/queue/index.ts
git commit -m "feat(scheduler): add jobId to CronJobData and pass through setupSchedulers"
```

---

### Task 2: Rewrite `appendRunLog` in cron-bridge to use jobId

**Files:**
- Modify: `src/queue/handlers/cron-bridge.ts:151-182`

- [ ] **Step 1: Update `handleCronJob` to extract and pass `jobId`**

In `src/queue/handlers/cron-bridge.ts`, update the `handleCronJob` function (lines 151-170):

```typescript
export async function handleCronJob(job: Job<CronJobData>, remi: Remi): Promise<void> {
  const { jobId, handler, handlerConfig } = job.data;
  const fn = handlers.get(handler);
  if (!fn) {
    throw new Error(`Unknown cron handler: ${handler}`);
  }
  log.info(`Executing cron job: ${jobId} (handler=${handler})`);
  const start = Date.now();
  try {
    await fn(remi, handlerConfig);
    const durationMs = Date.now() - start;
    log.info(`Cron job ${jobId} completed in ${durationMs}ms`);
    appendRunLog(jobId, handler, "ok", durationMs);
  } catch (e) {
    const durationMs = Date.now() - start;
    log.error(`Cron job ${jobId} failed after ${durationMs}ms:`, e);
    appendRunLog(jobId, handler, "error", durationMs, String(e));
    throw e; // re-throw so BunQueue records failure + retries
  }
}
```

- [ ] **Step 2: Rewrite `appendRunLog` to use jobId for filename and include jobId/handler in entry**

Replace the `appendRunLog` function (lines 172-182):

```typescript
function appendRunLog(jobId: string, handler: string, status: "ok" | "error", durationMs: number, error?: string): void {
  try {
    const runsDir = join(homedir(), ".remi", "cron", "runs");
    if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
    const safeId = jobId.replace(/[:/]/g, "_");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      jobId,
      handler,
      status,
      durationMs,
      ...(error && { error: error.slice(0, 500) }),
    });
    appendFileSync(join(runsDir, `${safeId}.jsonl`), entry + "\n", "utf-8");
  } catch {
    // non-critical, don't let logging failure break cron
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bun build src/queue/handlers/cron-bridge.ts --no-bundle 2>&1 | head -20`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add src/queue/handlers/cron-bridge.ts
git commit -m "feat(scheduler): write JSONL with jobId, filename per job"
```

---

### Task 3: Migrate old `skill_run.jsonl` into per-job files

**Files:**
- Modify: `web/remi-data.ts` (add migration method)

- [ ] **Step 1: Add the migration method to `RemiData`**

Add this method to the `RemiData` class, right before the `// ── Scheduler` comment block (around line 929):

```typescript
  /**
   * One-time migration: split mixed skill_run.jsonl into per-job files
   * by inferring jobId from UTC timestamp ranges.
   */
  private _migrateSkillRunJsonl(): void {
    const runsDir = join(this.root, "cron", "runs");
    const mixedFile = join(runsDir, "skill_run.jsonl");
    if (!existsSync(mixedFile)) return;

    const lines = readFileSync(mixedFile, "utf-8").trim().split("\n").filter(Boolean);
    const buckets = new Map<string, string[]>();

    for (const line of lines) {
      try {
        const raw = JSON.parse(line);
        const ts = raw.ts as string;
        const d = new Date(ts);
        const hh = d.getUTCHours();
        const mm = d.getUTCMinutes();

        let jobId: string | null = null;
        if (hh === 2 && mm >= 10 && mm < 25) jobId = "skill:ai-daily-briefing";
        else if (hh === 2 && mm >= 25 && mm < 40) jobId = "skill:feishu-insight";
        else if (hh === 2 && mm >= 40 && mm < 55) jobId = "skill:memory-research";
        else if (hh === 20 && mm >= 0 && mm < 15) jobId = "skill:repo-update";
        else if (hh === 20 && mm >= 15 && mm < 35) jobId = "skill:larkparser-answer-maintain";

        if (!jobId) continue; // discard unmatched entries

        const enriched = JSON.stringify({ ...raw, jobId, handler: "skill:run" });
        const arr = buckets.get(jobId) ?? [];
        arr.push(enriched);
        buckets.set(jobId, arr);
      } catch { /* skip malformed lines */ }
    }

    // Write per-job files (append, in case some already exist from new writes)
    for (const [jobId, entries] of buckets) {
      const safeId = jobId.replace(/[:/]/g, "_");
      appendFileSync(join(runsDir, `${safeId}.jsonl`), entries.join("\n") + "\n", "utf-8");
    }

    // Mark as migrated
    renameSync(mixedFile, mixedFile + ".migrated");
  }
```

- [ ] **Step 2: Add `renameSync` to the file's import list**

At the top of `web/remi-data.ts` (line 8), add `renameSync` to the existing `node:fs` import:

```typescript
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync, appendFileSync, renameSync } from "node:fs";
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bun build web/remi-data.ts --no-bundle 2>&1 | head -20`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add web/remi-data.ts
git commit -m "feat(scheduler): add skill_run.jsonl migration to per-job files"
```

---

### Task 4: Implement `_loadAllRuns` and `_calcNextRun` helpers

**Files:**
- Modify: `web/remi-data.ts` (add helper methods + import croner)

- [ ] **Step 1: Add `Cron` import from croner at the top of the file**

At the top of `web/remi-data.ts`, after the existing imports (around line 16), add:

```typescript
import { Cron } from "croner";
```

- [ ] **Step 2: Add the `_loadAllRuns` method**

Add this method to the `RemiData` class, after the `_migrateSkillRunJsonl` method:

```typescript
  private _loadAllRuns(): Array<{
    ts: string; jobId: string; handler: string;
    status: "ok" | "error" | "skipped"; durationMs: number; error?: string;
  }> {
    const runsDir = join(this.root, "cron", "runs");
    if (!existsSync(runsDir)) return [];

    // Run migration on first access
    this._migrateSkillRunJsonl();

    const entries: Array<{
      ts: string; jobId: string; handler: string;
      status: "ok" | "error" | "skipped"; durationMs: number; error?: string;
    }> = [];

    for (const file of readdirSync(runsDir).filter(f => f.endsWith(".jsonl"))) {
      const content = readFileSync(join(runsDir, file), "utf-8").trim();
      if (!content) continue;
      const fallbackId = file.replace(".jsonl", "").replace(/_/g, ":");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const raw = JSON.parse(line);
          // Skip entries without jobId that can't be identified
          const jobId = raw.jobId ?? fallbackId;
          entries.push({
            ts: raw.ts,
            jobId,
            handler: raw.handler ?? fallbackId,
            status: raw.status,
            durationMs: raw.durationMs,
            error: raw.error,
          });
        } catch { /* skip malformed lines */ }
      }
    }

    return entries.sort((a, b) => b.ts.localeCompare(a.ts));
  }
```

- [ ] **Step 3: Add the `_calcNextRun` method**

Add this method after `_loadAllRuns`:

```typescript
  private _calcNextRun(job: { cron?: string; every?: string | number; tz?: string }): string | null {
    if (job.cron) {
      try {
        const c = new Cron(job.cron, { timezone: job.tz ?? "Asia/Shanghai" });
        const next = c.nextRun();
        return next?.toISOString() ?? null;
      } catch { return null; }
    }
    return null; // interval/at types: not calculated
  }
```

- [ ] **Step 4: Add the `_formatSchedule` method**

Add this method after `_calcNextRun`:

```typescript
  private _formatSchedule(job: { cron?: string; every?: string | number; at?: string }): { kind: string; expr?: string; intervalMs?: number; at?: string } {
    if (job.cron) return { kind: "cron", expr: job.cron };
    if (job.every) {
      const val = job.every;
      if (typeof val === "number") return { kind: "every", intervalMs: val * 1000 };
      const match = String(val).match(/^(\d+)\s*(s|m|h|d)?$/i);
      if (!match) return { kind: "every", intervalMs: 300_000 };
      const num = parseInt(match[1], 10);
      const unit = (match[2] ?? "s").toLowerCase();
      const ms = unit === "m" ? num * 60_000 : unit === "h" ? num * 3_600_000 : unit === "d" ? num * 86_400_000 : num * 1000;
      return { kind: "every", intervalMs: ms };
    }
    if (job.at) return { kind: "at", at: job.at };
    return { kind: "unknown" };
  }
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bun build web/remi-data.ts --no-bundle 2>&1 | head -20`

Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add web/remi-data.ts
git commit -m "feat(scheduler): add _loadAllRuns, _calcNextRun, _formatSchedule helpers"
```

---

### Task 5: Rewrite `getSchedulerStatus`, `getSchedulerHistory`, `getSchedulerSummary`

**Files:**
- Modify: `web/remi-data.ts:961-988`

- [ ] **Step 1: Rewrite `getSchedulerStatus`**

Replace the existing `getSchedulerStatus` method (lines 961-973):

```typescript
  getSchedulerStatus() {
    const allRuns = this._loadAllRuns();
    const jobs = this._loadCronJobs().map((job) => {
      const jobRuns = allRuns.filter(r => r.jobId === job.id);

      // lastRun: most recent entry for this job
      const last = jobRuns[0] ?? null;

      // consecutiveErrors: count from most recent backwards until non-error
      let consecutiveErrors = 0;
      for (const r of jobRuns) {
        if (r.status === "error") consecutiveErrors++;
        else break;
      }

      // nextRunAt: compute from cron expression
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

- [ ] **Step 2: Rewrite `getSchedulerHistory`**

Replace the existing `getSchedulerHistory` method (lines 975-978):

```typescript
  getSchedulerHistory(jobId?: string, limit = 50): Array<{ ts: string; status: string; durationMs: number; error?: string; jobId: string }> {
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

- [ ] **Step 3: Rewrite `getSchedulerSummary`**

Replace the existing `getSchedulerSummary` method (lines 980-988):

```typescript
  getSchedulerSummary(days: number) {
    const allRuns = this._loadAllRuns();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentRuns = allRuns.filter(r => r.ts >= cutoff);

    // Aggregate by date
    const byDate = new Map<string, { total: number; ok: number; error: number; skipped: number }>();
    for (const r of recentRuns) {
      const date = r.ts.slice(0, 10); // YYYY-MM-DD
      const bucket = byDate.get(date) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
      bucket.total++;
      if (r.status === "ok") bucket.ok++;
      else if (r.status === "error") bucket.error++;
      else if (r.status === "skipped") bucket.skipped++;
      byDate.set(date, bucket);
    }

    // Fill zero-days to ensure every day has an entry
    const result: Array<{ date: string; total: number; ok: number; error: number; skipped: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const dateStr = d.toISOString().slice(0, 10);
      const bucket = byDate.get(dateStr) ?? { total: 0, ok: 0, error: 0, skipped: 0 };
      result.push({ date: dateStr, ...bucket });
    }
    return result;
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bun build web/remi-data.ts --no-bundle 2>&1 | head -20`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
git add web/remi-data.ts
git commit -m "feat(scheduler): implement getSchedulerStatus/History/Summary from JSONL"
```

---

### Task 6: End-to-end verification via API

**Files:** None (testing only)

- [ ] **Step 1: Rebuild and restart the dashboard dev server**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign
# Kill old process on port 5199 if running
kill $(lsof -t -i:5199) 2>/dev/null || true
# Start dev server (adjust command to match project setup)
PORT=5199 bun run web/server.ts &
sleep 3
```

- [ ] **Step 2: Verify `/api/v1/scheduler/status` returns real data**

```bash
curl -s http://10.37.66.8:5199/api/v1/scheduler/status | bun -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const jobs = data.jobs;
  console.log('Jobs:', jobs.length);
  for (const j of jobs) {
    console.log(\`  \${j.jobId}: lastRun=\${j.lastRun?.status ?? 'null'}, nextRunAt=\${j.nextRunAt?.slice(0,16) ?? 'null'}, errors=\${j.consecutiveErrors}\`);
  }
"
```

Expected: 8 jobs listed, most with `lastRun.status = "ok"`, `nextRunAt` showing a future ISO timestamp, `consecutiveErrors = 0`.

- [ ] **Step 3: Verify `/api/v1/scheduler/history` returns entries**

```bash
curl -s "http://10.37.66.8:5199/api/v1/scheduler/history?limit=5" | bun -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('History entries:', data.length);
  for (const e of data) console.log(\`  \${e.ts} \${e.jobId} \${e.status} \${e.durationMs}ms\`);
"
```

Expected: 5 entries with distinct `jobId` values (not all `skill:run`).

- [ ] **Step 4: Verify `/api/v1/scheduler/summary` returns non-zero data**

```bash
curl -s "http://10.37.66.8:5199/api/v1/scheduler/summary?days=3" | bun -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  for (const d of data) console.log(\`  \${d.date}: total=\${d.total} ok=\${d.ok} error=\${d.error}\`);
"
```

Expected: At least some days with `total > 0`.

- [ ] **Step 5: Verify `skill_run.jsonl` was migrated**

```bash
ls -la ~/.remi/cron/runs/skill_run.jsonl* 2>/dev/null
ls -la ~/.remi/cron/runs/skill_ai-daily-briefing.jsonl 2>/dev/null
```

Expected: `skill_run.jsonl.migrated` exists, `skill_ai-daily-briefing.jsonl` exists.

- [ ] **Step 6: Verify `/api/v1/scheduler/history?jobId=skill:ai-daily-briefing` filters correctly**

```bash
curl -s "http://10.37.66.8:5199/api/v1/scheduler/history?jobId=skill:ai-daily-briefing" | bun -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('Entries for ai-daily-briefing:', data.length);
  const allMatch = data.every(e => e.jobId === 'skill:ai-daily-briefing');
  console.log('All jobIds match:', allMatch);
"
```

Expected: ~11 entries, all with `jobId = "skill:ai-daily-briefing"`.

- [ ] **Step 7: Commit verification results (no code changes)**

No commit needed — this is verification only.
