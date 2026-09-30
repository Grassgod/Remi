import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Hono } from "hono";
import { Hono as ProbeApp } from "hono";
import { createRequestMetricsMiddleware, currentDbReplyOrigin } from "../../packages/server/src/observability/request-metrics.js";
import { resetDbReplyLimitForTest, type PostgresSyncDatabase } from "../../packages/server/src/store/db/postgres.js";
import type { MultiremiStore } from "../../packages/server/src/store/store.js";

const MIB = 1_048_576;
const metrics = { enabled: true, slowRequestMs: 500, summaryIntervalMs: 60_000,
  summaryTopRoutes: 10, bufferCapacity: 512, role: "all" as const };

export function prepareC1WorkerClock(): () => void {
  const RealDate = Date;
  // Freeze response timestamps; latency still uses the real performance clock.
  globalThis.Date = class extends RealDate {
    constructor(...args: unknown[]) { super(...(args.length ? args : [Date.UTC(2026, 8, 28, 0)]) as [string]); }
    static now(): number { return Date.UTC(2026, 8, 28, 0); }
  } as DateConstructor;
  return () => { globalThis.Date = RealDate; };
}

export async function runC1Worker(input: {
  store: MultiremiStore; db: PostgresSyncDatabase; app: Hono;
  taskId: string; agentId: string; token: string;
}): Promise<void> {
  const { store, db, app, taskId, agentId, token } = input;
  const before = process.env.MUL398_C1_STAGE === "before";
  if (before) process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "0";
  else delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  resetDbReplyLimitForTest();
  const replies: Array<{ event: string; method: string; route: string; bytes: number; max_bytes?: number }> = [];
  const realLog = console.log;
  console.log = (line: unknown) => {
    try {
      const parsed = JSON.parse(String(line));
      if (["api_large_db_reply", "api_db_reply_rejected"].includes(parsed.event)) replies.push(parsed);
    } catch { /* Only bridge evidence is collected; no request bodies or secrets. */ }
  };
  const realQuery = db.query.bind(db);
  let calls = 0;
  let messageSelects = 0;
  db.query = (sql: string) => {
    const statement = realQuery(sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? (...args: unknown[]) => {
        calls++;
        if (key === "all" && /^SELECT \* FROM multiremi_task_messages/.test(sql)) messageSelects++;
        return value.apply(target, args);
      } : value;
    } });
  };
  const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  // Register the probe before Hono builds its matcher on the first request.
  app.get("/api/c1/nonexception", c => c.json(db.query("SELECT repeat('x', ?) AS body").get(9 * MIB)));
  const browserAccess = await store.createAccessToken({ name: "C1 local browser probe", type: "pat", userId: "local", workspaceId: "local" });
  const browserAuth = { Authorization: `Bearer ${browserAccess.token}` };
  const timing = (response: Response, metric: string) => {
    const match = response.headers.get("Server-Timing")?.match(new RegExp(`${metric};desc="(\\d+)"`));
    if (!match) throw new Error(`Missing ${metric} counter`);
    return Number(match[1]);
  };
  let issueId: string | undefined;
  let longTaskId: string | undefined;
  let shareToken: string | undefined;
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    emit({ ready: true, stage: before ? "before" : "after" });
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      const command = JSON.parse(line) as { kind: string; count?: number; index?: number };
      const count = command.count ?? 1;
      const replyStart = replies.length;
      calls = 0;
      if (command.kind === "stop") break;
      if (command.kind === "daemon") {
        const started = performance.now();
        const response = await app.request(`/api/daemon/tasks/${taskId}/messages`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ messages: Array.from({ length: count }, (_, offset) => ({
            seq: offset + 1, type: "text", content: `${command.index}/${offset} ${"x".repeat(1024)}`,
          })) }),
        });
        await response.arrayBuffer();
        const ms = performance.now() - started;
        if (response.status !== 200) throw new Error(`Daemon batch status ${response.status}`);
        emit({ ms, queries: timing(response, "dbq") });
      } else if (command.kind === "peer" || command.kind === "peer-http") {
        throw new Error("The browser task-message peer frame was retired; this historical benchmark is unavailable");
      } else if (command.kind === "long") {
        if (!longTaskId) {
          store.completeTask(taskId, { output: "C1 batch measurements complete" });
          const issue = store.createIssue({ title: "C1 long messages", workspaceId: "local" });
          issueId = issue.id;
          const task = store.createTask({ id: "tsk_c1_long", agentId, issueId, workspaceId: "local", prompt: "C1 long sample" });
          longTaskId = task.id;
          if (store.claimTask("rt_c1_probe")?.id !== task.id) throw new Error("Long task was not claimed");
          store.startTask(task.id);
          store.appendTaskMessages(task.id, Array.from({ length: 96 }, (_, index) => ({
            seq: index + 1, type: "text", content: "x".repeat(256 * 1024),
          })));
          const share = await app.request(`/api/issues/${issueId}/share`, { method: "POST", headers: browserAuth });
          const body = await share.json() as { share: { token: string } };
          if (share.status !== 201) throw new Error(`Share creation status ${share.status}`);
          shareToken = body.share.token;
        }
        const paths = [
          [`/api/tasks/${longTaskId}/messages`, "GET /api/tasks/:taskId/messages"],
          [`/api/multiremi/tasks/${longTaskId}/messages`, "GET /api/multiremi/tasks/:id/messages"],
          [`/api/daemon/tasks/${longTaskId}/messages`, "GET /api/daemon/tasks/:taskId/messages"],
          [`/api/shares/${shareToken}`, "GET /api/shares/:token"],
        ];
        const results: unknown[] = [];
        for (const [path, pattern] of paths) {
          const start = replies.length;
          const response = await app.request(path!, { headers: pattern!.includes("/api/daemon/") ? auth : browserAuth });
          const body = new Uint8Array(await response.arrayBuffer());
          results.push({ route: pattern, status: response.status, bytes: body.length,
            sha256: createHash("sha256").update(body).digest("hex"), dbBytes: timing(response, "dbb"),
            queries: timing(response, "dbq"), maxSingleBytes: Math.max(0, ...replies.slice(start).map(reply => reply.bytes)) });
        }
        emit({ routes: results, messageContentBytes: 24 * MIB });
      } else if (command.kind === "reject") {
        // An HTTP fixture route isolates the guard from product authorization.
        const response = await app.request("/api/c1/nonexception", { headers: browserAuth });
        await response.arrayBuffer();
        emit({ status: response.status, dbBytes: timing(response, "dbb"), events: replies.slice(replyStart) });
      } else if (command.kind === "queued") {
        const autopilot = store.createAutopilot({ id: "aut_c1_probe", title: "C1 background probe",
          workspaceId: "local", assigneeId: agentId, status: "active", executionMode: "run_only" });
        const insert = db.prepare(`INSERT INTO multiremi_autopilot_runs
          (id, autopilot_id, source, status, triggered_at, created_at, schedule_batch_id, schedule_prompt, payload)
          VALUES (?, ?, 'schedule', 'queued', ?, ?, 'batch_c1', ?, '{}')`);
        db.transaction(() => {
          for (let index = 0; index < 20; index++) insert.run(`run_c1_${index}`, autopilot.id,
            "2026-09-28T00:00:00.000Z", "2026-09-28T00:00:00.000Z", "x".repeat(512 * 1024));
        })();
        store.advanceScheduledTargetRuns();
        emit({ completed: true, events: replies.slice(replyStart), rows: store.getTaskMessagePageRows() });
      } else throw new Error("Unknown probe command");
    }
  } finally {
    db.query = realQuery; console.log = realLog;
  }
}
