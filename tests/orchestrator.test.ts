/**
 * Characterization tests for the daemon orchestration primitives extracted
 * from core.ts in D6. Locks AsyncLock mutual exclusion + resolveSessionKey
 * thread/group/p2p derivation directly in their new home.
 */

import { test, expect } from "bun:test";
import { AsyncLock, resolveSessionKey } from "../src/daemon/orchestrator.js";
import type { IncomingMessage } from "../src/connectors/base.js";

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
