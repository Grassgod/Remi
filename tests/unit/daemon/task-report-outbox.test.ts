// MUL-74 outbox invariants: per-task seq ordering across an API outage,
// durable restart recovery, permanent-error blocking, droppable-kind
// tolerance, and the "terminal events are never dropped" size-cap rule.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemonHttpError } from "@multiremi/worker/client.js";
import {
  MultiremiTaskReportOutbox,
  type MultiremiOutboxRecord,
} from "@multiremi/worker/outbox.js";

let tempDirs: string[] = [];
let outboxes: MultiremiTaskReportOutbox[] = [];

afterEach(async () => {
  for (const outbox of outboxes) await outbox.close().catch(() => {});
  outboxes = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
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
    expect(outbox.stats()).toMatchObject({ pending: 4, pendingTerminal: 1 });

    apiDown = false;
    expect(await outbox.waitForTaskDrain("tsk_1")).toBe("delivered");
    expect(delivered).toEqual(["messages:1", "messages:2", "usage:3", "complete:4"]);
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
    outbox.enqueue("tsk_stuck", "messages", { messages: [] });
    outbox.enqueue("tsk_ok", "complete", { output: "done" });
    expect(await outbox.waitForTaskDrain("tsk_ok")).toBe("delivered");
    expect(delivered).toEqual(["tsk_ok:1"]);
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

  it("enforces the size cap by dropping oldest non-terminal rows but never terminal events", async () => {
    let apiDown = true;
    const delivered: string[] = [];
    const outbox = track(new MultiremiTaskReportOutbox({
      path: tempPath(),
      maxBytes: 200_000,
      backoffScheduleMs: [5, 5],
      deliver: async (record) => {
        if (apiDown) throw new Error("connection refused");
        delivered.push(`${record.kind}:${record.seq}`);
      },
    }));
    const bigChunk = "x".repeat(10_000);
    outbox.enqueue("tsk_cap", "complete", { output: "terminal early" });
    for (let index = 0; index < 60; index += 1) {
      outbox.enqueue("tsk_cap2", "messages", { messages: [{ seq: index + 1, type: "text", content: bigChunk }] });
    }
    const stats = outbox.stats();
    expect(stats.droppedTotal).toBeGreaterThan(0);
    // The terminal event survived the cap.
    expect(stats.pendingTerminal).toBe(1);
    apiDown = false;
    expect(await outbox.waitForTaskDrain("tsk_cap")).toBe("delivered");
    expect(delivered).toContain("complete:1");
  });
});
