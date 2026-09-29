import { describe, expect, it } from "bun:test";
import { envelopePriority, type EnvelopePriorityEntry } from "@multiremi/contracts/inbox.js";

describe("envelopePriority", () => {
  it.each([
    [{ kind: "decision_needed", wake: "now" }, 1],
    [{ kind: "request", wake: "now", senderType: "member" }, 1],
    [{ kind: "request", wake: "now", senderType: "agent" }, 3],
    [{ kind: "report", wake: "now", outcome: "failed" }, 2],
    [{ kind: "final", wake: "now", outcome: "blocked" }, 2],
    [{ kind: "report", wake: "now", outcome: "cancelled" }, 2],
    [{ kind: "lifecycle", wake: "now", lifecycleEvent: "task_failed" }, 2],
    [{ kind: "lifecycle", wake: "now", lifecycleEvent: "task_cancelled" }, 2],
    [{ kind: "lifecycle", wake: "now", lifecycleEvent: "dependency_failed", outcome: "failed" }, 4],
    [{ kind: "lifecycle", wake: "now", outcome: "blocked" }, 4],
    [{ kind: "lifecycle", wake: "now", outcome: "cancelled" }, 4],
    [{ kind: "lifecycle", wake: "now", lifecycleEvent: "task_completed", outcome: "failed" }, 4],
    [{ kind: "lifecycle", wake: "now", lifecycleEvent: "task_failed", outcome: "done" }, 2],
    [{ kind: "reply", wake: "now", outcome: "failed" }, 3],
    [{ kind: "request", wake: "now", senderType: "agent", outcome: "failed" }, 3],
    [{ kind: "lifecycle", wake: "inbox_only", lifecycleEvent: "task_failed" }, 4],
    [{ kind: "report", wake: "now", outcome: "done" }, 3],
    [{ kind: "final", wake: "now", outcome: "done" }, 3],
    [{ kind: "reply", wake: "next_turn" }, 3],
    [{ kind: "lifecycle", wake: "next_turn" }, 4],
    [{ kind: "decision_needed", wake: "inbox_only" }, 4],
    [{ kind: "report", wake: "inbox_only", outcome: "failed" }, 4],
  ] as const satisfies ReadonlyArray<readonly [EnvelopePriorityEntry, 1 | 2 | 3 | 4]>)
    ("ranks %o at %i", (entry, priority) => {
      expect(envelopePriority(entry)).toBe(priority);
    });
});
