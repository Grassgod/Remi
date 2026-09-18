import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  isQueuedCapabilityAlert,
  isQueuedCapabilityWaitReason,
  queuedCapabilityWait,
  QUEUED_CAPABILITY_ALERT_MS,
  QUEUED_CAPABILITY_GRACE_MS,
} from "@multiremi/store/task-wait-reason.js";
import { TaskCapabilityMonitor, QUEUED_CAPABILITY_SWEEP_MS } from "@multiremi/store/task-capability-monitor.js";

afterEach(() => mock.restore());

const createdAt = "2026-09-18T12:00:00.000Z";
const created = Date.parse(createdAt);
const input = {
  candidateSupportsModel: [false, false],
  model: "claude-opus-5",
  thinkingLevel: "high",
  createdAt,
  now: created + QUEUED_CAPABILITY_GRACE_MS,
};

describe("queued capability wait decision", () => {
  it("requires grace and at least one candidate, with no capable candidates", () => {
    expect(queuedCapabilityWait({ ...input, now: input.now - 1 })).toBeNull();
    expect(queuedCapabilityWait({ ...input, candidateSupportsModel: [] })).toBeNull();
    expect(queuedCapabilityWait({ ...input, candidateSupportsModel: [false, true] })).toBeNull();
    expect(queuedCapabilityWait({ ...input, createdAt: "invalid" })).toBeNull();
    expect(queuedCapabilityWait(input)).toEqual({
      reason: "等待模型能力恢复：2 个候选 Runtime 均无法执行 claude-opus-5（thinking: high）",
      alerted: false,
    });
  });

  it("uses stable escalation text across repeated scans", () => {
    const before = queuedCapabilityWait({ ...input, now: created + QUEUED_CAPABILITY_ALERT_MS - 1 });
    const alert = queuedCapabilityWait({ ...input, now: created + QUEUED_CAPABILITY_ALERT_MS });
    const later = queuedCapabilityWait({ ...input, now: created + 24 * 60 * 60_000 });
    expect(before?.alerted).toBe(false);
    expect(alert?.alerted).toBe(true);
    expect(alert?.reason).toContain("15 分钟");
    expect(later).toEqual(alert);
    expect(isQueuedCapabilityWaitReason(before?.reason)).toBe(true);
    expect(isQueuedCapabilityAlert(before?.reason)).toBe(false);
    expect(isQueuedCapabilityAlert(alert?.reason)).toBe(true);
    expect(isQueuedCapabilityWaitReason("waiting for human input")).toBe(false);
    expect(isQueuedCapabilityAlert(null)).toBe(false);
  });

  it("describes a default model with an explicit thinking requirement", () => {
    expect(queuedCapabilityWait({ ...input, model: null })?.reason).toContain("默认模型（thinking: high）");
    expect(queuedCapabilityWait({ ...input, thinkingLevel: null })?.reason).not.toContain("thinking:");
  });
});

describe("task capability monitor lifecycle", () => {
  it("starts one unref'd 60-second timer, sweeps immediately, and stops it", () => {
    const refresh = mock(() => {});
    const unref = mock(() => {});
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const set = spyOn(globalThis, "setInterval").mockReturnValue(timer);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const monitor = new TaskCapabilityMonitor(refresh);
    monitor.start();
    monitor.start();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[1]).toBe(QUEUED_CAPABILITY_SWEEP_MS);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    monitor.stop();
    monitor.stop();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(timer);
    monitor.start();
    expect(refresh).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("guards reentry and releases the guard after a failed sweep", () => {
    let calls = 0;
    const monitor = new TaskCapabilityMonitor(() => {
      calls++;
      monitor.sweep();
      if (calls === 1) throw new Error("database temporarily unavailable");
    });
    expect(() => monitor.sweep()).not.toThrow();
    monitor.sweep();
    expect(calls).toBe(2);
  });
});
