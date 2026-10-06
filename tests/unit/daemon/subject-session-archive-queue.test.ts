import { expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubjectSessionArchiveQueue } from "@multiremi/worker/subject-session-archive.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

const tick = () => Bun.sleep(10);

it("bounds shutdown, aborts upload and keeps the intent even if an old callback later succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "subject-archive-shutdown-"));
  mkdirSync(join(root, ".runtime", "tsk_one"), { recursive: true });
  let finish!: () => void; let signal!: AbortSignal;
  const queue = new SubjectSessionArchiveQueue(root, "rt", () => {}, async (_subject, activeSignal) => {
    signal = activeSignal;
    return new Promise(resolve => { finish = () => resolve({ ready: true }); });
  });
  const marker = join(root, ".runtime", "tsk_one", ".multiremi", "archive-pending.json");
  try {
    queue.enqueue({ kind: "task", id: "tsk_one" }); await tick();
    queue.stop();
    expect(signal.aborted).toBe(true);
    const start = Date.now(); await queue.drain(20);
    expect(Date.now() - start).toBeLessThan(200);
    expect(existsSync(marker)).toBe(true);
    finish(); await queue.drain();
    expect(existsSync(marker)).toBe(true);
  } finally { queue.stop(); finish?.(); await queue.drain(); rmSync(root, { recursive: true, force: true }); }
});

it("a delayed archive does not hold handleTask or its active task slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "subject-archive-task-slot-"));
  mkdirSync(join(root, ".runtime", "tsk_slot"), { recursive: true });
  let finish!: () => void;
  const blocked = new Promise<null>(resolve => { finish = () => resolve(null); });
  let archiveEntered = false;
  const queue = new SubjectSessionArchiveQueue(root, "rt", () => {}, async () => { archiveEntered = true; return blocked; });
  const daemon = Object.assign(Object.create(MultiremiDaemon.prototype), {
    pollAbort: new AbortController(),
    options: { taskTimeoutMs: 0, workspacesRoot: root }, subjectArchiveQueue: queue,
    activeTaskCount: 0, activeTaskIds: new Set(), activeTaskAborts: new Set(),
    taskDownlinks: { observeCancellation: () => () => {}, release: () => {} },
    assertWorkspaceRootOwner: () => {}, ensureTrace: () => ({}),
    enqueueTaskReport: () => {}, awaitTaskReportDrain: async () => {},
    releaseActiveTaskSlot: () => { daemon.activeTaskCount--; },
    resolveTaskWorkDir: async () => { throw new Error("provider fixture stopped"); },
  });
  try {
    await daemon.handleTask({ id: "tsk_slot", agent: { provider: "codex" } });
    await tick();
    expect(archiveEntered).toBe(true);
    expect(daemon.activeTaskCount).toBe(0);
    expect(daemon.activeTaskIds.has("tsk_slot")).toBe(false);
    expect(existsSync(join(root, ".runtime", "tsk_slot", ".multiremi", "archive-pending.json"))).toBe(true);
  } finally { queue.stop(); finish(); await queue.drain(); rmSync(root, { recursive: true, force: true }); }
});

it("archives off the completion path, preserves retry intent, and recovers after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "subject-archive-queue-"));
  mkdirSync(join(root, ".runtime", "tsk_one"), { recursive: true });
  const marker = join(root, ".runtime", "tsk_one", ".multiremi", "archive-pending.json");
  let calls = 0;
  let finish!: () => void;
  const blocked = new Promise<null>(resolve => { finish = () => resolve(null); });
  const first = new SubjectSessionArchiveQueue(root, "rt_one", () => {}, async () => { calls++; return blocked; }, 10);
  first.enqueue({ kind: "task", id: "tsk_one" });
  expect(calls).toBe(0);
  expect(existsSync(marker)).toBe(true);
  await tick();
  expect(calls).toBe(1);
  // Stopping while upload is incomplete preserves the marker for replacement.
  first.stop(); finish(); await first.drain();
  expect(existsSync(marker)).toBe(true);
  const wrongOwner = new SubjectSessionArchiveQueue(root, "rt_other", () => {}, async () => { throw new Error("must not run"); }, 10);
  await tick(); wrongOwner.stop(); await wrongOwner.drain();
  expect(existsSync(marker)).toBe(true);
  const second = new SubjectSessionArchiveQueue(root, "rt_one", () => {}, async () => { calls++; return { archiveId: "ready" }; }, 10);
  try {
    await tick(); await second.drain();
    expect(calls).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, ".runtime", "tsk_one"))).toBe(true);
  } finally { second.stop(); await second.drain(); rmSync(root, { recursive: true, force: true }); }
});

it("re-enqueue during upload keeps intent until a fresh snapshot succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "subject-archive-reentry-"));
  mkdirSync(join(root, ".runtime", "tsk_one"), { recursive: true });
  const marker = join(root, ".runtime", "tsk_one", ".multiremi", "archive-pending.json");
  let finish!: () => void;
  const blocked = new Promise<object>(resolve => { finish = () => resolve({ ready: true }); });
  let calls = 0;
  const queue = new SubjectSessionArchiveQueue(root, "rt", () => {}, async () => ++calls === 1 ? blocked : { ready: true }, 40);
  try {
    queue.enqueue({ kind: "task", id: "tsk_one" }); await tick();
    queue.enqueue({ kind: "task", id: "tsk_one" }); finish(); await queue.drain();
    expect(existsSync(marker)).toBe(true);
    await Bun.sleep(60); await queue.drain();
    expect(calls).toBe(2);
    expect(existsSync(marker)).toBe(false);
  } finally { queue.stop(); finish(); await queue.drain(); rmSync(root, { recursive: true, force: true }); }
});
