import { describe, expect, it } from "bun:test";
import { DAEMON_FRAME_MAX_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import type { StorageReport } from "@multiremi/contracts/storage.js";
import { boundStorageReport } from "@multiremi/client.js";

function report(overrides: Partial<StorageReport>): StorageReport {
  return {
    version: 1,
    generated_at: "2026-01-01T00:00:00.000Z",
    mode: "run",
    root: "/root",
    bytes: null,
    bytes_measured_at: null,
    subjects: { total: 0, active: 0, ended: 0, reclaimed: 0 },
    retained: {},
    reclaimed_this_round: 0,
    forgotten_this_round: 0,
    freed_bytes: 0,
    plan: [],
    errors: [],
    ...overrides,
  };
}

describe("a gc run result stays below the outbox frame limit", () => {
  it("keeps a small report as it is", () => {
    const small = report({ plan: [{ subject: { kind: "issue", id: "iss_1" }, action: "keep", reason: "within_ttl", bytes: 1, unsaved_work: false }] });
    expect(boundStorageReport(small)).toEqual(small);
  });

  it("keeps every change before the largest keep items and cuts errors", () => {
    const keeps = Array.from({ length: 2500 }, (_, index) => ({
      subject: { kind: "issue" as const, id: `iss_${index}` }, action: "keep" as const, reason: "within_ttl", bytes: index, unsaved_work: false,
    }));
    const reclaim = { subject: { kind: "issue" as const, id: "iss_r" }, action: "reclaim" as const, reason: "ended_ttl", bytes: 0, unsaved_work: true };
    const errors = Array.from({ length: 150 }, (_, index) => ({ subject_id: `iss_${index}`, message: "x".repeat(5000) }));

    const bounded = boundStorageReport(report({ plan: [...keeps, reclaim], errors }));

    expect(bounded.plan).toHaveLength(2000);
    expect(bounded.plan[0]).toEqual(reclaim);
    expect(bounded.plan[1]!.bytes).toBe(2499);
    expect(bounded.errors).toHaveLength(100);
    expect(bounded.errors[0]!.message).toHaveLength(1000);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThan(DAEMON_FRAME_MAX_BYTES);
  });

  it("stays below the frame limit in bytes when the messages are not ASCII", () => {
    // Paths and git output carry any script: one UTF-16 unit of CJK text takes three bytes on the wire, an emoji two.
    const errors = Array.from({ length: 150 }, (_, index) => ({
      subject_id: `iss_${index}`,
      message: index % 2 === 0 ? "存储报告里的路径与错误".repeat(500) : "\u{1F4BE}".repeat(2500),
    }));
    const keeps = Array.from({ length: 2500 }, (_, index) => ({
      subject: { kind: "issue" as const, id: `iss_${index}` }, action: "keep" as const, reason: "within_ttl", bytes: index, unsaved_work: false,
    }));

    const bounded = boundStorageReport(report({ plan: keeps, errors, root: "/数据/工作区" }));
    const wire = JSON.stringify(bounded);

    expect(bounded.errors).toHaveLength(100);
    expect(bounded.errors[0]!.message).toHaveLength(1000);
    // The cut counts UTF-16 units, so the bytes are what the limit has to be checked against.
    expect(Buffer.byteLength(wire, "utf8")).toBeGreaterThan(wire.length);
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThan(DAEMON_FRAME_MAX_BYTES);
  });
});
