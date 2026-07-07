/**
 * Characterization tests for the daemon orchestration primitives extracted
 * from core.ts in D6. Locks AsyncLock mutual exclusion + resolveSessionKey
 * thread/group/p2p derivation directly in their new home.
 */

import { test, expect } from "bun:test";
import { AsyncLock, LaneScheduler, resolveSessionKey } from "../../../src/daemon/orchestrator.js";
import type { IncomingMessage } from "@connectors/base.js";

/** A promise plus its resolve handle, for building controllable barriers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function msg(chatId: string, metadata?: Record<string, unknown>): IncomingMessage {
  return { chatId, text: "", metadata } as unknown as IncomingMessage;
}

test("resolveSessionKey: thread message (rootId) → isolated thread key", () => {
  expect(resolveSessionKey(msg("c1", { rootId: "r1" }))).toBe("c1:thread:r1");
});

test("resolveSessionKey: group message without rootId → per-mention thread key by messageId", () => {
  expect(resolveSessionKey(msg("c1", { chatType: "group", messageId: "m9" }))).toBe("c1:thread:m9");
});

test("resolveSessionKey: p2p / no metadata → plain chatId", () => {
  expect(resolveSessionKey(msg("c1"))).toBe("c1");
  expect(resolveSessionKey(msg("c1", { chatType: "p2p" }))).toBe("c1");
});

test("AsyncLock: serializes — second acquire waits until first releases", async () => {
  const lock = new AsyncLock();
  const order: number[] = [];
  await lock.acquire();
  order.push(1);
  const second = lock.acquire().then(() => order.push(2));
  // second is queued, not yet run
  expect(order).toEqual([1]);
  lock.release();
  await second;
  expect(order).toEqual([1, 2]);
});

test("AsyncLock: isIdle reflects held/queued state", async () => {
  const lock = new AsyncLock();
  expect(lock.isIdle).toBe(true);
  await lock.acquire();
  expect(lock.isIdle).toBe(false);
  lock.release();
  expect(lock.isIdle).toBe(true);
});

test("LaneScheduler: same lane runs serially, different lanes run in parallel", async () => {
  const scheduler = new LaneScheduler();
  const order: string[] = [];
  const aGate = deferred();

  // Two tasks on lane "a": the first holds until aGate; the second must wait.
  const a1 = scheduler.run("a", async () => { order.push("a1-start"); await aGate.promise; order.push("a1-end"); });
  const a2 = scheduler.run("a", async () => { order.push("a2"); });
  // A task on a different lane "b" is free to run while a1 is held.
  const b1 = scheduler.run("b", async () => { order.push("b1"); });

  await b1;
  expect(order).toContain("b1");      // ran while a1 held its lane
  expect(order).not.toContain("a2");  // a2 still blocked behind a1

  aGate.resolve();
  await Promise.all([a1, a2]);
  expect(order.indexOf("a1-end")).toBeLessThan(order.indexOf("a2")); // a2 only after a1 finished
});

test("LaneScheduler: caps total concurrency across lanes", async () => {
  const scheduler = new LaneScheduler({ maxConcurrency: 2 });
  const gate = deferred();
  let running = 0;
  let peak = 0;
  const task = (lane: string) => scheduler.run(lane, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await gate.promise;
    running -= 1;
  });

  // Four distinct lanes, but the cap is 2 → only 2 may run at once.
  const all = [task("a"), task("b"), task("c"), task("d")];
  await Promise.resolve(); await Promise.resolve();
  expect(scheduler.activeCount).toBe(2);
  expect(peak).toBe(2);

  gate.resolve();
  await Promise.all(all);
  expect(scheduler.activeCount).toBe(0);
});

test("LaneScheduler: unbounded by default (no cap) and frees idle lanes", async () => {
  const scheduler = new LaneScheduler();
  const gate = deferred();
  let peak = 0;
  let running = 0;
  const tasks = ["a", "b", "c", "d", "e"].map((lane) => scheduler.run(lane, async () => {
    running += 1; peak = Math.max(peak, running); await gate.promise; running -= 1;
  }));
  await Promise.resolve(); await Promise.resolve();
  expect(peak).toBe(5); // no cap → all five distinct lanes run at once
  gate.resolve();
  await Promise.all(tasks);
  // After draining, internal lane map is empty (idle lanes are reclaimed).
  expect((scheduler as unknown as { _lanes: Map<string, unknown> })._lanes.size).toBe(0);
});
