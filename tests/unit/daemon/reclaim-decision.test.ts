import { describe, expect, test } from "bun:test";
import { STORAGE_SETTINGS_DEFAULTS, type StorageSubjectRef } from "@multiremi/contracts/storage.js";
import { classifySubject, isPermanentRejection, type ReclaimCheckReply, type SubjectProbe } from "@daemon/agent-runtime/workspace/reclaim.js";
import type { SubjectRecord } from "@daemon/agent-runtime/workspace/registry.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const policy = STORAGE_SETTINGS_DEFAULTS;

function record(subject: StorageSubjectRef, usedAgoMs: number): SubjectRecord {
  const used = new Date(NOW - usedAgoMs).toISOString();
  return {
    version: 1, subject, workspace_id: "local", issue_key: null, external_work_dir: null, repos: [],
    state: "active", last_used_at: used, created_at: used, reclaimed_at: null, snapshot: null,
  };
}

const known = (reply: ReclaimCheckReply): SubjectProbe => ({ kind: "known", reply });
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function classify(subject: StorageSubjectRef, probe: SubjectProbe, options: { usedAgoMs?: number; running?: boolean } = {}) {
  return classifySubject({
    record: record(subject, options.usedAgoMs ?? 200 * HOUR),
    probe,
    running: options.running ?? false,
    policy,
    now: NOW,
  });
}

const issue: StorageSubjectRef = { kind: "issue", id: "iss_1" };
const chat: StorageSubjectRef = { kind: "chat", id: "chat_1" };
const task: StorageSubjectRef = { kind: "task", id: "tsk_1" };

describe("classifySubject", () => {
  test("a running subject is kept whatever the server says", () => {
    for (const probe of [known({ status: "done", updated_at: ago(500 * HOUR) }), { kind: "gone" } as const, { kind: "unreachable" } as const]) {
      expect(classify(issue, probe, { running: true }).outcome).toEqual({ action: "keep", reason: "running" });
    }
  });

  test("an unreachable server keeps everything", () => {
    expect(classify(issue, { kind: "unreachable" })).toEqual({ outcome: { action: "keep", reason: "server_unreachable" }, ended: false });
  });

  describe("hard-deleted subjects", () => {
    test("are forgotten once unused for the orphan TTL", () => {
      expect(classify(issue, { kind: "gone" }, { usedAgoMs: 73 * HOUR }).outcome).toEqual({ action: "forget", reason: "orphan" });
    });

    test("are kept while their last use is within the orphan TTL", () => {
      expect(classify(chat, { kind: "gone" }, { usedAgoMs: 71 * HOUR }).outcome).toEqual({ action: "keep", reason: "within_ttl" });
    });
  });

  describe("an Issue that moved to another workspace", () => {
    // The server answers `moved` only to a daemon that executed the Issue, and without any timestamp.
    const moved = known({ status: "moved" });

    test("has ended for this workspace and is reclaimed once unused for the TTL", () => {
      expect(classify(issue, moved, { usedAgoMs: 73 * HOUR })).toEqual({
        outcome: { action: "reclaim", reason: "ended_ttl" }, ended: true,
      });
    });

    test("is kept while its last use is within the TTL", () => {
      expect(classify(issue, moved, { usedAgoMs: 71 * HOUR })).toEqual({
        outcome: { action: "keep", reason: "within_ttl" }, ended: true,
      });
    });

    test("is reclaimed, never forgotten, however long it has been unused", () => {
      for (const usedAgoMs of [100 * HOUR, 500 * HOUR, 10_000 * HOUR]) {
        expect(classify(issue, moved, { usedAgoMs }).outcome).toEqual({ action: "reclaim", reason: "ended_ttl" });
      }
    });

    test("uses the Issue TTL of the policy", () => {
      const classified = classifySubject({
        record: record(issue, 10 * HOUR), probe: moved, running: false, policy: { ...policy, ttl_ms: 5 * HOUR }, now: NOW,
      });
      expect(classified.outcome).toEqual({ action: "reclaim", reason: "ended_ttl" });
    });

    test("is kept while an execution of it runs here", () => {
      expect(classify(issue, moved, { usedAgoMs: 500 * HOUR, running: true }).outcome).toEqual({ action: "keep", reason: "running" });
    });

    test("is still forgotten once the server deletes it", () => {
      expect(classify(issue, { kind: "gone" }, { usedAgoMs: 500 * HOUR }).outcome).toEqual({ action: "forget", reason: "orphan" });
    });

    test("is a status only an Issue can have: it does not end a Chat or a task", () => {
      expect(classify(chat, moved, { usedAgoMs: 500 * HOUR })).toEqual({ outcome: { action: "keep", reason: "not_ended" }, ended: false });
      expect(classify(task, moved, { usedAgoMs: 500 * HOUR })).toEqual({ outcome: { action: "keep", reason: "not_ended" }, ended: false });
    });
  });

  describe("Issues", () => {
    test.each(["backlog", "todo", "in_progress", "in_review", "blocked", "active"])("%s is not ended", (status) => {
      expect(classify(issue, known({ status, updated_at: ago(500 * HOUR) }))).toEqual({
        outcome: { action: "keep", reason: "not_ended" }, ended: false,
      });
    });

    test.each(["done", "completed", "closed", "cancelled"])("%s ended past the TTL is reclaimed", (status) => {
      expect(classify(issue, known({ status, updated_at: ago(100 * HOUR) }))).toEqual({
        outcome: { action: "reclaim", reason: "ended_ttl" }, ended: true,
      });
    });

    test("an Issue that ended within the TTL is kept", () => {
      expect(classify(issue, known({ status: "done", updated_at: ago(10 * HOUR) }), { usedAgoMs: 200 * HOUR })).toEqual({
        outcome: { action: "keep", reason: "within_ttl" }, ended: true,
      });
    });

    test("using the workspace after it ended restarts the clock", () => {
      expect(classify(issue, known({ status: "done", updated_at: ago(500 * HOUR) }), { usedAgoMs: HOUR }).outcome)
        .toEqual({ action: "keep", reason: "within_ttl" });
    });
  });

  describe("Chats", () => {
    test("an active Chat is not ended", () => {
      expect(classify(chat, known({ status: "active", updated_at: ago(500 * HOUR), pinned: false, origin: null })).outcome)
        .toEqual({ action: "keep", reason: "not_ended" });
    });

    test("an archived Chat is reclaimed after the TTL", () => {
      expect(classify(chat, known({ status: "archived", updated_at: ago(100 * HOUR), pinned: false, origin: null })).outcome)
        .toEqual({ action: "reclaim", reason: "ended_ttl" });
    });

    test("a pinned Chat is never reclaimed, archived or not", () => {
      expect(classify(chat, known({ status: "archived", updated_at: ago(500 * HOUR), pinned: true })))
        .toEqual({ outcome: { action: "keep", reason: "pinned" }, ended: true });
      expect(classify(chat, known({ status: "active", updated_at: ago(500 * HOUR), pinned: true })))
        .toEqual({ outcome: { action: "keep", reason: "pinned" }, ended: false });
    });

    test("a Chat opened by an automation run uses the shorter TTL", () => {
      const reply = (origin: ReclaimCheckReply["origin"]): ReclaimCheckReply => ({
        status: "archived", updated_at: ago(30 * HOUR), pinned: false, origin,
      });
      expect(classify(chat, known(reply({ autopilot_id: "ap_1", run_id: "run_1" }))).outcome)
        .toEqual({ action: "reclaim", reason: "ended_ttl" });
      expect(classify(chat, known(reply(null))).outcome).toEqual({ action: "keep", reason: "within_ttl" });
    });

    test("activity after archiving counts as use", () => {
      expect(classify(chat, known({ status: "archived", updated_at: ago(500 * HOUR), last_activity_at: ago(HOUR) })).outcome)
        .toEqual({ action: "keep", reason: "within_ttl" });
    });
  });

  describe("fallback tasks", () => {
    test.each(["completed", "failed", "cancelled"])("a %s task is reclaimed after the TTL", (status) => {
      expect(classify(task, known({ status, completed_at: ago(100 * HOUR) })).outcome).toEqual({ action: "reclaim", reason: "ended_ttl" });
    });

    test.each(["queued", "dispatched", "running", "awaiting_human"])("a %s task is not ended", (status) => {
      expect(classify(task, known({ status })).outcome).toEqual({ action: "keep", reason: "not_ended" });
    });
  });
});

describe("isPermanentRejection", () => {
  test("only a client error other than a timeout or throttle will never succeed", () => {
    expect(isPermanentRejection({ status: 404 })).toBe(true);
    expect(isPermanentRejection({ status: 400 })).toBe(true);
    expect(isPermanentRejection({ status: 408 })).toBe(false);
    expect(isPermanentRejection({ status: 429 })).toBe(false);
    expect(isPermanentRejection({ status: 503 })).toBe(false);
    expect(isPermanentRejection(new Error("connection lost"))).toBe(false);
  });
});
