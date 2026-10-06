// MUL-74 outbox invariants: per-task seq ordering across an API outage,
// durable restart recovery, permanent-error blocking, droppable-kind
// tolerance, and safe compaction of overwritten rows at the soft size cap.
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemonHttpError } from "@multiremi/worker/client.js";
import { DaemonProtocolRpcError } from "@multiremi/worker/daemon-protocol-client.js";
import { outboxRecordBytes } from "@multiremi/worker/report-frames.js";
import { DAEMON_FRAME_MAX_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { actualUnit } from "@acp/usage-collector.js";
import { createLocalStore, db as usageDb, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import {
  MultiremiTaskReportOutbox,
  type MultiremiOutboxKind,
  type MultiremiOutboxRecord,
} from "@multiremi/worker/outbox.js";

let tempDirs: string[] = [];
let outboxes: MultiremiTaskReportOutbox[] = [];

afterEach(async () => {
  for (const outbox of outboxes) await outbox.close().catch(() => {});
  outboxes = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  resetMultiremiTestEnv();
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "multiremi-outbox-"));
  tempDirs.push(dir);
  return join(dir, "outbox.db");
}

function track(outbox: MultiremiTaskReportOutbox): MultiremiTaskReportOutbox {
  outboxes.push(outbox);
  return outbox;
}

function httpError(status: number, path = "/api/daemon/tasks/x"): MultiremiDaemonHttpError {
  return new MultiremiDaemonHttpError(status, "POST", path, "{}", null);
}

describe("MultiremiTaskReportOutbox", () => {
  it("replays a turn charge whose 5000 request links exceed one frame, preserving exactly one billed amount", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "long-charge", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "long-charge", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Long billed turn", workspaceId: "local" });
    store.claimTask(runtime.id); store.startTask(task.id);
    store.setUsagePrice("local", { provider: "claude", model: "opus", connection_id: null, requested_model_alias: false,
      currency: "USD", input_per_million: 2, output_per_million: 0, cache_read_per_million: 0, cache_write_per_million: 0,
      unsplit_per_million: null, source: "configured", source_url: null, effective_from: "2026-01-01T00:00:00Z", effective_to: null });
    const units = Array.from({ length: 5000 }, (_, i) => ({ ...actualUnit({ unitId: String(i).padStart(6, "0") + "x".repeat(240),
      provider: "claude", model: "opus", scope: "request", source: "provider_request", inputTokens: 1_000_000,
      outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 }), occurredAt: "2026-10-01T01:00:00.000Z" }));
    const money = { ...actualUnit({ unitId: "provider-turn-charge", provider: "claude", scope: "turn", source: "provider_turn",
      costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported" }), occurredAt: "2026-10-01T01:00:00.000Z",
      coveredUnitIds: units.map(unit => unit.unitId) };
    const path = tempPath();
    const offline = track(new MultiremiTaskReportOutbox({ path, canSend: () => false, deliver: async () => {} }));
    offline.enqueue(task.id, "usage", { usageSnapshot: { version: 2, runId: "long-charge", revision: 1, complete: true, units: [...units, money] } });
    offline.enqueue(task.id, "complete", { output: "done" });
    expect(offline.stats().blocked).toBe(0);
    await offline.close();
    let chargeFrames = 0;
    let observedIncomplete = false;
    let loseChargeAcknowledgement = true;
    let maxFrameBytes = 0;
    const partialAmounts: Array<{ amount: number; complete: boolean }> = [];
    const kinds: string[] = [];
    const restarted = track(new MultiremiTaskReportOutbox({ path, backoffScheduleMs: [1], deliver: async record => {
      maxFrameBytes = Math.max(maxFrameBytes, outboxRecordBytes(record));
      kinds.push(record.kind);
      if (record.kind === "usage") {
        const snapshot = record.payload.usageSnapshot as any;
        chargeFrames += snapshot.units.filter((unit: any) => unit.unitId === money.unitId).length;
        store.reportTaskUsageSnapshot(task.id, snapshot);
        if (!observedIncomplete && snapshot.units.some((unit: any) => unit.unitId === money.unitId)
          && (usageDb!.query("SELECT cost_coverage_complete FROM multiremi_usage_units WHERE task_id=? AND unit_id=?")
            .get(task.id, money.unitId) as { cost_coverage_complete: number }).cost_coverage_complete === 0) {
          observedIncomplete = true;
          const partial = store.getUsageReport({ workspaceId: "local", days: null }).summary;
          partialAmounts.push({ amount: partial.known_cost_by_currency.USD ?? 0, complete: partial.complete });
          if (loseChargeAcknowledgement) {
            loseChargeAcknowledgement = false;
            throw new Error("charge fragment acknowledgement lost after persistence");
          }
        }
      } else if (record.kind === "complete") store.completeTask(task.id, { output: "done" });
    } }));
    expect(await restarted.waitForTaskDrain(task.id)).toBe("delivered");
    expect(chargeFrames).toBeGreaterThan(1);
    expect(observedIncomplete).toBe(true);
    expect(maxFrameBytes).toBeLessThanOrEqual(DAEMON_FRAME_MAX_BYTES);
    // No part of the unverified reported charge may enter known amounts.
    // Unrelated configured estimates remain whole USD 2 multiples.
    expect(partialAmounts).toHaveLength(1);
    expect(partialAmounts[0]!.complete).toBe(false);
    expect(partialAmounts[0]!.amount % 2).toBe(0);
    expect(kinds.at(-1)).toBe("complete");
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: 5_000_000_000, priced_tokens: 5_000_000_000,
      known_cost_by_currency: { USD: 0.25 }, complete: true });
    expect(store.getTask(task.id)?.status).toBe("completed");
  }, 30_000);
  it("replays over 3000 request facts after an outage with bounded final chunks and delivers terminal last", async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "long-usage", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "long-usage", provider: "claude", runtimeId: runtime.id, workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "Long task", workspaceId: "local" });
    store.claimTask(runtime.id); store.startTask(task.id);
    const path = tempPath();
    const first = track(new MultiremiTaskReportOutbox({ path, canSend: () => false, deliver: async () => {} }));
    const units = Array.from({ length: 3500 }, (_, i) => ({ ...actualUnit({ unitId: `request-${i}`, provider: "claude", model: i % 2 ? "opus" : "haiku",
      scope: "request", source: "provider_request", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 2, evidenceRef: "upstream_request" }), occurredAt: "2026-10-01T01:00:00.000Z" }));
    for (const [index, unit] of units.entries()) first.enqueue(task.id, "usage", { usageSnapshot: { version: 2, runId: "long-run", revision: index + 1, complete: false, units: [unit] } });
    first.enqueue(task.id, "usage", { usageSnapshot: { version: 2, runId: "long-run", revision: 3501, complete: true, units } });
    first.enqueue(task.id, "complete", { output: "done" });
    expect(first.stats().blocked).toBe(0);
    await first.close();
    const kinds: string[] = [];
    const reopened = track(new MultiremiTaskReportOutbox({ path, deliver: async record => {
      expect(outboxRecordBytes(record)).toBeLessThanOrEqual(DAEMON_FRAME_MAX_BYTES);
      kinds.push(record.kind);
      if (record.kind === "usage") store.reportTaskUsageSnapshot(task.id, record.payload.usageSnapshot as any);
      else if (record.kind === "complete") store.completeTask(task.id, { output: "done" });
    } }));
    expect(await reopened.waitForTaskDrain(task.id)).toBe("delivered");
    expect(kinds.at(-1)).toBe("complete");
    expect(store.getTask(task.id)?.status).toBe("completed");
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary.actual_total_tokens).toBe(7000);
    expect(report.by_model.map(row => row.actual_total_tokens).sort()).toEqual([3500, 3500]);
  }, 30_000);
  it("keeps v2 usage through cancellation and restart without discarding deltas behind a complete marker", async () => {
    const path = tempPath();
    const first = track(new MultiremiTaskReportOutbox({ path, backoffScheduleMs: [60_000],
      deliver: async () => { throw new Error("offline"); } }));
    const snapshot = (runId: string, revision: number, complete = false) => ({ usageSnapshot: { version: 2, runId, revision, complete, units: [] } });
    first.enqueue("task", "messages", { messages: [] });
    first.enqueue("task", "usage", snapshot("run1", 1));
    first.enqueue("task", "usage", snapshot("run1", 2));
    first.enqueue("task", "usage", snapshot("run2", 1));
    first.purgeTask("task", { keepUsage: true });
    expect(first.enqueue("task", "complete", {})).toBeNull();
    expect(first.enqueue("task", "usage", snapshot("run1", 3, true))).not.toBeNull();
    expect(first.stats().pending).toBe(4);
    await first.close();
    const delivered: Array<[unknown, unknown]> = [];
    const reopened = track(new MultiremiTaskReportOutbox({ path, deliver: async (record) => {
      const value = record.payload.usageSnapshot as any;
      delivered.push([value.runId, value.revision]);
    } }));
    expect(reopened.enqueue("task", "messages", { messages: [] })).toBeNull();
    expect(await reopened.waitForTaskDrain("task")).toBe("delivered");
    expect(delivered).toEqual([["run1", 1], ["run1", 2], ["run2", 1], ["run1", 3]]);
    reopened.purgeTask("task"); // deletion takes precedence over cancellation's allowance
    expect(reopened.enqueue("task", "usage", snapshot("run1", 4))).toBeNull();
  });
  it("retries through an API outage and delivers strictly in seq order, terminal last", async () => {
    const delivered: string[] = [];
    let apiDown = true;
    let failures = 0;
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [5, 5],
      deliver: async (record) => {
        if (apiDown) {
          failures += 1;
          throw new Error("fetch failed: connection refused");
        }
        delivered.push(`${record.kind}:${record.seq}`);
      },
    }));

    outbox.enqueue("tsk_1", "messages", { messages: [{ seq: 1, type: "text", content: "a" }] });
    outbox.enqueue("tsk_1", "messages", { messages: [{ seq: 2, type: "text", content: "b" }] });
    outbox.enqueue("tsk_1", "usage", { usage: [] });
    outbox.enqueue("tsk_1", "complete", { output: "done" });

    // The API stays down long enough for several retry cycles: nothing is
    // delivered and nothing is lost.
    await Bun.sleep(30);
    expect(failures).toBeGreaterThan(1);
    expect(delivered).toEqual([]);
    expect(outbox.stats()).toMatchObject({
      pending: 4,
      pendingNonTerminal: 3,
      pendingTerminal: 1,
      pendingTasks: 1,
    });
    expect(outbox.taskIdsWithPendingTerminal()).toEqual(["tsk_1"]);

    apiDown = false;
    expect(await outbox.waitForTaskDrain("tsk_1")).toBe("delivered");
    expect(delivered).toEqual(["messages:1", "usage:3", "complete:4"]);
    expect(outbox.stats()).toMatchObject({ pending: 0 });
  });

  it("keeps tasks independent: one task's outage does not stall another", async () => {
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [1_000],
      deliver: async (record) => {
        if (record.taskId === "tsk_stuck") throw new Error("connection refused");
        delivered.push(`${record.taskId}:${record.seq}`);
      },
    }));
    const stuckId = outbox.enqueue("tsk_stuck", "messages", { messages: [] });
    const okId = outbox.enqueue("tsk_ok", "complete", { output: "done" });
    expect([stuckId, okId]).toEqual([1, 2]);
    expect(await outbox.waitForTaskDrain("tsk_ok")).toBe("delivered");
    expect(delivered).toEqual([`tsk_ok:${okId}`]);
  });

  it("does not let new token reports bypass retry backoff", async () => {
    let attempts = 0;
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [100],
      deliver: async () => {
        attempts += 1;
        throw new Error("connection refused");
      },
    }));
    outbox.enqueue("tsk_backoff", "messages", { messages: [{ seq: 1, type: "text", content: "a" }] });
    await until(() => attempts === 1);

    for (let seq = 2; seq <= 20; seq += 1) {
      outbox.enqueue("tsk_backoff", "messages", { messages: [{ seq, type: "text", content: "x" }] });
    }
    await Bun.sleep(30);

    expect(attempts).toBe(1);
    expect(outbox.stats().pending).toBe(20);
  });

  it("batches and coalesces consecutive persisted message records on replay", async () => {
    const path = tempPath();
    const first = track(new MultiremiTaskReportOutbox({
      path,
      backoffScheduleMs: [60_000],
      deliver: async () => { throw new Error("api unavailable"); },
    }));
    for (let seq = 1; seq <= 100; seq += 1) {
      first.enqueue("tsk_batch", "messages", { messages: [{ seq, type: "thinking", content: "x" }] });
    }
    await Bun.sleep(20);
    await first.close();

    const delivered: MultiremiOutboxRecord[] = [];
    const second = track(new MultiremiTaskReportOutbox({
      path,
      deliver: async (record) => { delivered.push(record); },
    }));
    await second.flushAll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: "messages", seq: 1 });
    expect(delivered[0]?.payload.messages).toEqual([{
      seq: 1,
      type: "thinking",
      content: "x".repeat(100),
    }]);
    expect(second.stats().pending).toBe(0);
  });

  it("honors a shutdown signal that was already aborted before drain starts", async () => {
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [60_000],
      deliver: async () => { throw new Error("connection refused"); },
    }));
    outbox.enqueue("tsk_shutdown", "complete", { output: "keep on disk" });
    const shutdown = new AbortController();
    shutdown.abort();

    expect(await outbox.waitForTaskDrain("tsk_shutdown", shutdown.signal)).toBe("aborted");
    expect(outbox.stats()).toMatchObject({ pending: 1, pendingTerminal: 1 });
  });

  it("recovers undelivered records after a restart and replays them in order", async () => {
    const path = tempPath();
    const first = track(new MultiremiTaskReportOutbox({
      path,
      backoffScheduleMs: [10_000],
      deliver: async () => {
        throw new Error("api unavailable");
      },
    }));
    first.enqueue("tsk_r", "messages", { messages: [{ seq: 1, type: "text", content: "a" }] });
    first.enqueue("tsk_r", "usage", { usage: [] });
    first.enqueue("tsk_r", "complete", { output: "final" });
    // Give the pump one failed attempt, then simulate the daemon dying.
    await Bun.sleep(20);
    await first.close();

    const delivered: string[] = [];
    const second = track(new MultiremiTaskReportOutbox({
      path,
      deliver: async (record) => {
        delivered.push(`${record.kind}:${record.seq}`);
      },
    }));
    expect(second.pendingTaskIds()).toEqual(["tsk_r"]);
    await second.flushAll();
    expect(delivered).toEqual(["messages:1", "usage:2", "complete:3"]);
    expect(second.stats()).toMatchObject({ pending: 0 });
  });

  it("blocks the task queue on permanent authority errors instead of retrying forever", async () => {
    const blocked: string[] = [];
    let attempts = 0;
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [5],
      deliver: async () => {
        attempts += 1;
        throw httpError(401);
      },
      onTaskBlocked: (taskId) => blocked.push(taskId),
    }));
    outbox.enqueue("tsk_b", "messages", { messages: [] });
    outbox.enqueue("tsk_b", "complete", { output: "x" });
    expect(await outbox.waitForTaskDrain("tsk_b")).toBe("blocked");
    expect(blocked).toEqual(["tsk_b"]);
    expect(outbox.stats()).toMatchObject({ pending: 0, blocked: 2 });
    const before = attempts;
    await Bun.sleep(20);
    // No further attempts after blocking.
    expect(attempts).toBe(before);
  });

  it("treats a start replay 400 as delivered and drops rejected best-effort reports", async () => {
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [5],
      deliver: async (record: MultiremiOutboxRecord) => {
        if (record.kind === "start") throw httpError(400);
        if (record.kind === "workspace") throw httpError(403);
        delivered.push(`${record.kind}:${record.seq}`);
      },
    }));
    outbox.enqueue("tsk_s", "start", {});
    outbox.enqueue("tsk_s", "workspace", { runtimeId: "rt", rootPath: "/x", branchName: "b", status: "preparing", repos: [] });
    outbox.enqueue("tsk_s", "complete", { output: "done" });
    expect(await outbox.waitForTaskDrain("tsk_s")).toBe("delivered");
    // start + workspace were consumed without blocking; complete still landed.
    expect(delivered).toEqual(["complete:3"]);
  });

  it("retains reliable results and starts under a soft cap, compacting only each task's overwritten progress", async () => {
    let online = false;
    const delivered: MultiremiOutboxRecord[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({
      path: tempPath(),
      maxBytes: 4096,
      canSend: () => online,
      deliver: async (record) => { delivered.push(record); },
    }));
    const result = outbox.enqueue("rt:one", "feishu.outbound_result", { status: "sent" })!;
    expect(result).toBe(1);
    expect(outbox.stats()).toMatchObject({ pending: 1, droppedTotal: 0 });
    const command = outbox.enqueue("rt:one", "runtime.command_result", { status: "completed", request_id: "command" })!;
    const start = outbox.enqueue("tsk_cap", "start", {})!;
    for (let index = 0; index < 20; index++) {
      for (const taskId of ["tsk_cap", "tsk_other"]) {
        outbox.enqueue(taskId, "progress", { summary: `step-${index}`, padding: "x".repeat(10_000) });
      }
    }
    const stats = outbox.stats();
    expect(stats).toMatchObject({ pending: 5, blocked: 0, droppedTotal: 38 });
    expect(stats.overCapBytes).toBeGreaterThan(0);
    expect(stats.overCapBytes).toBe(stats.fileBytes - 4096);
    online = true;
    await outbox.flushAll();
    expect(delivered.filter((record) => record.kind !== "progress").map((record) => record.id).sort((a, b) => a - b)).toEqual([result, command, start]);
    expect(delivered.filter((record) => record.kind === "progress").sort((a, b) => a.taskId.localeCompare(b.taskId))
      .map((record) => [record.taskId, record.payload.summary])).toEqual([
      ["tsk_cap", "step-19"], ["tsk_other", "step-19"],
    ]);
    expect(outbox.stats().pending).toBe(0);
  });

  it.each(["progress", "session_pin", "workspace"] as const)("compacts only covered %s rows in the same partition and type", async (kind) => {
    let online = false;
    const delivered: MultiremiOutboxRecord[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: tempPath(), maxBytes: 4096, deliveryBatchSize: 1,
      canSend: () => online, deliver: async (record) => { delivered.push(record); } }));
    outbox.enqueue("task-a", kind, { value: "old" });
    const otherPartition = outbox.enqueue("task-b", kind, { value: "other partition" })!;
    const otherType = outbox.enqueue("task-a", kind === "workspace" ? "session_pin" : "workspace", { value: "other type" })!;
    const latest = outbox.enqueue("task-a", kind, { value: "latest" })!;
    expect(outbox.stats()).toMatchObject({ pending: 3, droppedTotal: 1 });
    online = true;
    await outbox.flushAll();
    expect(delivered.map((record) => record.id).sort((a, b) => a - b)).toEqual([otherPartition, otherType, latest]);
  });

  it("never evicts other reliable kinds or a final progress row under capacity pressure", async () => {
    const kinds: MultiremiOutboxKind[] = ["start", "prompt", "usage", "messages", "complete", "fail",
      "runtime.update_result", "runtime.command_result", "runtime.model_list_result", "runtime.local_skills_result",
      "runtime.directory_scan_result", "runtime.local_skill_import_result", "runtime.bot_menu_result",
      "feishu.outbound_result", "plugin.state"];
    let online = false;
    const delivered: MultiremiOutboxRecord[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: tempPath(), maxBytes: 4096, deliveryBatchSize: 1,
      canSend: () => online, deliver: async (record) => { delivered.push(record); } }));
    const ids: number[] = [];
    for (const kind of kinds) {
      for (let index = 0; index < 2; index++) ids.push(outbox.enqueue(kind, kind, { index })!);
    }
    ids.push(outbox.enqueue("final", "progress", { summary: "final", final: true })!);
    ids.push(outbox.enqueue("final", "progress", { summary: "later" })!);
    expect(outbox.stats()).toMatchObject({ pending: ids.length, droppedTotal: 0, blocked: 0 });
    online = true;
    await outbox.flushAll();
    expect(delivered.map((record) => record.id).sort((a, b) => a - b)).toEqual(ids);
  });

  it("purges a task, wakes its retry backoff, and settles drain waiters", async () => {
    let attempted = false;
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [60_000],
      deliver: async () => {
        attempted = true;
        throw new Error("api unavailable");
      },
    }));
    outbox.enqueue("tsk_purge", "messages", { messages: [] });
    await until(() => attempted);
    const drain = outbox.waitForTaskDrain("tsk_purge");

    expect(outbox.purgeTask("tsk_purge")).toBe(1);
    expect(await drain).toBe("delivered");
    expect(outbox.stats()).toMatchObject({ pending: 0, pendingTasks: 0 });
  });

  it("persists tombstones and discards reports enqueued after cancellation", async () => {
    const path = tempPath();
    const first = track(new MultiremiTaskReportOutbox({
      path,
      backoffScheduleMs: [60_000],
      deliver: async () => { throw new Error("api unavailable"); },
    }));
    first.enqueue("tsk_cancelled", "messages", { messages: [] });
    expect(first.purgeTask("tsk_cancelled")).toBe(1);
    first.enqueue("tsk_cancelled", "progress", { summary: "late" });
    expect(first.stats()).toMatchObject({ pending: 0, droppedTotal: 1 });
    await first.close();

    const second = track(new MultiremiTaskReportOutbox({ path, deliver: async () => {} }));
    second.enqueue("tsk_cancelled", "messages", { messages: [] });
    expect(second.pendingTaskIds()).toEqual([]);
    expect(second.stats()).toMatchObject({ pending: 0, droppedTotal: 2 });
  });

  it("keeps and accepts terminal reports behind a terminal-only tombstone", async () => {
    let apiDown = true;
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      backoffScheduleMs: [60_000],
      deliver: async (record) => {
        if (apiDown) throw new Error("api unavailable");
        delivered.push(`${record.kind}:${record.seq}`);
      },
    }));
    outbox.enqueue("tsk_terminal", "messages", { messages: [] });
    outbox.enqueue("tsk_terminal", "complete", { output: "done" });
    await until(() => outbox.stats().pending === 2);

    expect(outbox.purgeTask("tsk_terminal", { keepTerminal: true })).toBe(1);
    outbox.enqueue("tsk_terminal", "progress", { summary: "late" });
    outbox.enqueue("tsk_terminal", "fail", { error: "terminal retry" });
    expect(outbox.stats()).toMatchObject({ pending: 2, pendingNonTerminal: 0, pendingTerminal: 2 });

    apiDown = false;
    expect(await outbox.waitForTaskDrain("tsk_terminal")).toBe("delivered");
    expect(delivered).toEqual(["complete:2", "fail:3"]);
  });

  it("does not let a purged in-flight permanent error block a preserved terminal report", async () => {
    const deliveryStarted = deferred<void>();
    const rejectInFlight = deferred<void>();
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({
      path: ":memory:",
      deliver: async (record) => {
        if (record.kind === "messages") {
          deliveryStarted.resolve();
          await rejectInFlight.promise;
          throw httpError(403);
        }
        delivered.push(`${record.kind}:${record.seq}`);
      },
    }));
    outbox.enqueue("tsk_race", "messages", { messages: [] });
    outbox.enqueue("tsk_race", "complete", { output: "done" });
    await deliveryStarted.promise;

    expect(outbox.purgeTask("tsk_race", { keepTerminal: true })).toBe(1);
    rejectInFlight.resolve();
    expect(await outbox.waitForTaskDrain("tsk_race")).toBe("delivered");
    expect(delivered).toEqual(["complete:2"]);
    expect(outbox.stats()).toMatchObject({ pending: 0, blocked: 0 });
  });
  it("limits the single pump to 64 unacknowledged frames and deletes only acknowledged rows", async () => {
    const gates = new Map<number, ReturnType<typeof deferred<void>>>();
    const delivered: number[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", deliver: async record => {
      delivered.push(record.id);
      const gate = deferred<void>(); gates.set(record.id, gate);
      await gate.promise;
      return { ok: true };
    } }));
    for (let i = 0; i < 70; i++) outbox.enqueue(`task-${i}`, "progress", {});
    await until(() => delivered.length === 64);
    expect(delivered).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(outbox.stats().pending).toBe(70);
    gates.get(1)!.resolve();
    await until(() => delivered.length === 65);
    expect(outbox.stats().pending).toBe(69);
    gates.forEach(gate => gate.resolve());
    await until(() => delivered.length === 70);
    gates.forEach(gate => gate.resolve());
    await outbox.flushAll();
    expect(outbox.stats().pending).toBe(0);
  });

  it("bounds in-flight bytes to 1 MiB and pauses delivery under backpressure", async () => {
    let ready = false;
    let bytes = 0;
    let peak = 0;
    const delivered: number[] = [];
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", canSend: () => ready,
      deliver: async record => {
        delivered.push(record.id);
        bytes += outboxRecordBytes(record); peak = Math.max(peak, bytes);
        const gate = deferred<void>(); gates.push(gate);
        await gate.promise; bytes -= outboxRecordBytes(record);
      } }));
    outbox.enqueue("task", "complete", { output: "x".repeat(600 * 1024) });
    outbox.enqueue("rt:runtime", "runtime.command_result", { output: "x".repeat(600 * 1024) });
    await Bun.sleep(10);
    expect(delivered).toEqual([]);
    ready = true; outbox.pumpAll();
    await until(() => delivered.length === 1);
    await Bun.sleep(10);
    expect(delivered).toEqual([1]);
    gates[0]!.resolve();
    await until(() => delivered.length === 2);
    gates[1]!.resolve();
    await outbox.flushAll();
    expect(peak).toBeLessThanOrEqual(1024 * 1024);
  });

  it("blocks oversized complete before sending, survives restart, and leaves other partitions running", async () => {
    const path = tempPath();
    const delivered: string[] = [];
    const options = { path, deliver: async (record: MultiremiOutboxRecord) => { delivered.push(record.taskId); } };
    const first = track(new MultiremiTaskReportOutbox(options));
    first.enqueue("large", "complete", { runtime_id: "runtime", output: "x".repeat(1024 * 1024) });
    first.enqueue("ok", "complete", { runtime_id: "runtime", output: "done" });
    first.enqueue("rt:runtime", "runtime.command_result", { output: "done" });
    expect(await first.waitForTaskDrain("large")).toBe("blocked");
    await first.flushAll();
    expect(delivered).toEqual(["ok", "rt:runtime"]);
    expect(first.taskIdsWithPendingTerminal("runtime")).toEqual([]);
    await first.close();
    const second = track(new MultiremiTaskReportOutbox(options));
    second.enqueue("large", "progress", {});
    expect(await second.waitForTaskDrain("large")).toBe("blocked");
    expect(second.stats().blocked).toBe(2);
    expect(delivered).toEqual(["ok", "rt:runtime"]);
  });

  it("accounts for legacy wire adaptation before applying the in-flight byte window", async () => {
    let ready = false;
    let bytes = 0;
    let peak = 0;
    const delivered: number[] = [];
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", canSend: () => ready,
      prepareDelivery: record => ({ ...record, payload: { ...record.payload, output: "x".repeat(600 * 1024) } }),
      deliver: async record => {
        delivered.push(record.id);
        expect(record.payload.output).toHaveLength(600 * 1024);
        bytes += outboxRecordBytes(record); peak = Math.max(peak, bytes);
        const gate = deferred<void>(); gates.push(gate);
        await gate.promise; bytes -= outboxRecordBytes(record);
      } }));
    outbox.enqueue("first", "complete", {});
    outbox.enqueue("second", "complete", {});
    ready = true; outbox.pumpAll();
    await until(() => delivered.length === 1);
    await Bun.sleep(10);
    expect(delivered).toEqual([1]);
    gates[0]!.resolve();
    await until(() => delivered.length === 2);
    gates[1]!.resolve();
    await outbox.flushAll();
    expect(peak).toBeLessThanOrEqual(1024 * 1024);
    expect(outbox.stats()).toMatchObject({ pending: 0, blocked: 0 });
  });

  it("blocks a row that exceeds the frame limit after legacy wire adaptation", async () => {
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:",
      prepareDelivery: record => record.taskId === "large"
        ? { ...record, payload: { output: "x".repeat(1024 * 1024) } } : record,
      deliver: async record => { delivered.push(record.taskId); } }));
    outbox.enqueue("large", "complete", {});
    outbox.enqueue("ok", "progress", {});
    await outbox.flushAll();
    expect(await outbox.waitForTaskDrain("large")).toBe("blocked");
    expect(delivered).toEqual(["ok"]);
    expect(outbox.stats()).toMatchObject({ pending: 0, blocked: 1 });
  });

  it("purges a deleted task's entire partition instead of blocking or replaying it", async () => {
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", deliver: async record => {
      if (record.taskId === "deleted") throw new DaemonProtocolRpcError("task_not_found", false);
      delivered.push(record.taskId);
    } }));
    outbox.enqueue("deleted", "progress", {});
    const completion = outbox.enqueueAndWait("deleted", "complete", {});
    outbox.enqueue("ok", "complete", {});
    await outbox.flushAll();
    expect(await completion).toMatchObject({ ok: true, discarded: true });
    expect(outbox.stats()).toMatchObject({ pending: 0, blocked: 0 });
    expect(delivered).toEqual(["ok"]);
    expect(outbox.enqueue("deleted", "complete", {})).toBeNull();
  });

  it("returns an online steer conflict to its executor and unblocks later progress", async () => {
    const delivered: string[] = [];
    let steerPending = true;
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", deliver: async record => {
      if (record.kind === "complete" && steerPending) throw new DaemonProtocolRpcError("steer_pending", false);
      delivered.push(record.kind);
    } }));
    const completion = outbox.enqueueAndWait("task", "complete", { output: "before steer" });
    outbox.enqueue("task", "progress", { summary: "steer turn" });
    await expect(completion).rejects.toMatchObject({ code: "steer_pending", retryable: false });
    await outbox.waitForTaskDrain("task");
    steerPending = false;
    await outbox.enqueueAndWait("task", "complete", { output: "after steer" });
    expect(delivered).toEqual(["progress", "complete"]);
    expect(outbox.stats()).toMatchObject({ pending: 0, blocked: 0 });
  });

  it("turns a replayed steer conflict into runtime_recovery failure without blocking", async () => {
    const delivered: MultiremiOutboxRecord[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", deliver: async record => {
      if (record.kind === "complete") throw new DaemonProtocolRpcError("steer_pending", false);
      delivered.push(record);
    } }));
    outbox.enqueue("task", "complete", { runtime_id: "runtime", output: "old" });
    outbox.enqueue("task", "progress", { summary: "next" });
    await outbox.waitForTaskDrain("task");
    expect(delivered.map(record => record.kind)).toEqual(["progress", "fail"]);
    expect(delivered[1]?.payload).toMatchObject({ runtime_id: "runtime", failure_reason: "runtime_recovery" });
    expect(outbox.stats().blocked).toBe(0);
  });

  it("times out the executor wait but retains complete and handles a later steer rejection", async () => {
    const gate = deferred<void>();
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", deliver: async record => {
      if (record.kind === "complete") { await gate.promise; throw new DaemonProtocolRpcError("steer_pending", false); }
      delivered.push(record.kind);
    } }));
    expect(await outbox.enqueueAndWait("task", "complete", {}, 5)).toEqual({ ok: true, queued: true });
    expect(outbox.stats().pendingTerminal).toBe(1);
    gate.resolve();
    await outbox.waitForTaskDrain("task");
    expect(delivered).toEqual(["fail"]);
    expect(outbox.stats().blocked).toBe(0);
  });

  it("filters pending terminal activity by runtime and excludes blocked partitions", async () => {
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", canSend: () => false, deliver: async () => {} }));
    outbox.enqueue("claude", "complete", { runtime_id: "claude-runtime" });
    outbox.enqueue("codex", "fail", { runtime_id: "codex-runtime" });
    outbox.enqueue("blocked", "complete", { runtime_id: "claude-runtime", output: "x".repeat(1024 * 1024) });
    expect(outbox.taskIdsWithPendingTerminal("claude-runtime")).toEqual(["claude"]);
    expect(outbox.taskIdsWithPendingTerminal("codex-runtime")).toEqual(["codex"]);
  });

  it("releases a terminal result wait on shutdown while retaining the row for replay", async () => {
    const outbox = track(new MultiremiTaskReportOutbox({ path: ":memory:", canSend: () => false, deliver: async () => {} }));
    const stop = new AbortController();
    const waiting = outbox.enqueueAndWait("task", "complete", { output: "finished" }, 30_000, stop.signal);
    stop.abort();
    expect(await waiting).toEqual({ ok: true, queued: true });
    expect(outbox.stats()).toMatchObject({ pending: 1, pendingTerminal: 1, blocked: 0 });
  });

  it("imports two legacy provider files exactly once and preserves renamed sources", async () => {
    const paths = [tempPath(), tempPath()];
    for (const [i, path] of paths.entries()) {
      const old = track(new MultiremiTaskReportOutbox({ path, canSend: () => false, deliver: async () => {} }));
      old.enqueue(`provider-${i}`, "complete", { output: "done" });
      await old.close();
    }
    const sharedPath = tempPath();
    const delivered: MultiremiOutboxRecord[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({ path: sharedPath, deliver: async record => { delivered.push(record); } }));
    paths.forEach((path, i) => outbox.importLegacy(path, `runtime-${i}`));
    await outbox.flushAll();
    expect(delivered.map(record => [record.id, record.payload.runtime_id])).toEqual([[1, "runtime-0"], [2, "runtime-1"]]);
    for (const path of paths) {
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.migrated-v2`)).toBe(true);
    }
  });

  it("rolls back data and import markers together after a mid-import failure", async () => {
    const sourcePath = tempPath();
    const old = track(new MultiremiTaskReportOutbox({ path: sourcePath, canSend: () => false, deliver: async () => {} }));
    old.enqueue("task", "progress", {}); old.enqueue("task", "complete", {});
    await old.close();
    const path = tempPath();
    const first = track(new MultiremiTaskReportOutbox({ path, canSend: () => false, deliver: async () => {} }));
    const db = openSqliteDatabase(path);
    db.exec("CREATE TRIGGER crash_import BEFORE INSERT ON outbox_events WHEN NEW.kind = 'complete' BEGIN SELECT RAISE(ABORT, 'injected crash'); END");
    expect(() => first.importLegacy(sourcePath, "runtime")).toThrow("injected crash");
    expect(first.stats().pending).toBe(0);
    expect(existsSync(sourcePath)).toBe(true);
    db.exec("DROP TRIGGER crash_import"); db.close(); await first.close();
    const delivered: number[] = [];
    const second = track(new MultiremiTaskReportOutbox({ path, deliver: async record => { delivered.push(record.id); } }));
    second.importLegacy(sourcePath, "runtime");
    await second.flushAll();
    expect(delivered).toEqual([1, 2]);
    expect(existsSync(`${sourcePath}.migrated-v2`)).toBe(true);
  });

  it("preserves a crashed legacy WAL alongside its recoverable renamed database", async () => {
    const sourcePath = tempPath();
    const module = new URL("../../../packages/server/src/worker/outbox.ts", import.meta.url).href;
    const writer = Bun.spawn([process.execPath, "-e", `
      const { MultiremiTaskReportOutbox } = await import(Bun.argv.at(-2));
      const old = new MultiremiTaskReportOutbox({ path: Bun.argv.at(-1), canSend: () => false, deliver: async () => {} });
      old.enqueue("task", "progress", { progress: "before crash" });
      old.enqueue("task", "complete", { output: "after crash" });
      console.log("ready");
      setInterval(() => {}, 1000);
    `, module, sourcePath], { stdout: "pipe", stderr: "pipe" });
    try {
      const ready = await writer.stdout.getReader().read();
      expect(Buffer.from(ready.value ?? []).toString()).toContain("ready");
    } finally {
      writer.kill("SIGKILL");
      await writer.exited;
    }
    expect(existsSync(`${sourcePath}-wal`)).toBe(true);
    const delivered: string[] = [];
    const shared = track(new MultiremiTaskReportOutbox({ path: tempPath(),
      deliver: async record => { delivered.push(record.kind); } }));
    shared.importLegacy(sourcePath, "runtime");
    const backupPath = `${sourcePath}.migrated-v2`;
    expect(existsSync(`${backupPath}-wal`)).toBe(true);
    expect(existsSync(`${sourcePath}-wal`)).toBe(false);
    const backup = openSqliteDatabase(backupPath, { readonly: true });
    try {
      expect(backup.query("SELECT kind FROM outbox_events ORDER BY id").all()).toEqual([
        { kind: "progress" }, { kind: "complete" },
      ]);
    } finally { backup.close(); }
    await shared.flushAll();
    expect(delivered).toEqual(["progress", "complete"]);
    expect(shared.stats().pending).toBe(0);
  });

  it("skips a committed import after a pre-rename crash and does not lose a v1 rollback generation", async () => {
    const sourcePath = tempPath();
    const path = tempPath();
    const old = track(new MultiremiTaskReportOutbox({ path: sourcePath, canSend: () => false, deliver: async () => {} }));
    old.enqueue("first", "complete", {}); await old.close();
    const first = track(new MultiremiTaskReportOutbox({ path, canSend: () => false, deliver: async () => {} }));
    first.importLegacy(sourcePath, "runtime");
    const backup = `${sourcePath}.migrated-v2`;
    const preserved = readFileSync(backup);
    await first.close();
    copyFileSync(backup, sourcePath);
    const delivered: string[] = [];
    const restarted = track(new MultiremiTaskReportOutbox({ path, canSend: () => false,
      deliver: async record => { delivered.push(record.taskId); } }));
    restarted.importLegacy(sourcePath, "runtime");
    expect(restarted.stats().pending).toBe(1);
    const rollback = track(new MultiremiTaskReportOutbox({ path: sourcePath, canSend: () => false, deliver: async () => {} }));
    expect(rollback.enqueue("second", "complete", {})).toBe(1);
    await rollback.close();
    restarted.importLegacy(sourcePath, "runtime");
    expect(restarted.stats().pending).toBe(2);
    expect(readFileSync(backup)).toEqual(preserved);
    expect(readdirSync(join(sourcePath, "..")).filter(name => name.endsWith(".migrated-v2"))).toHaveLength(3);
    await restarted.close();
    const pump = track(new MultiremiTaskReportOutbox({ path, deliver: async record => { delivered.push(record.taskId); } }));
    await pump.flushAll();
    expect(delivered).toEqual(["first", "second"]);
  });
});

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for condition");
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
