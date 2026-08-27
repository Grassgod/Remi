import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskMessagePayload } from "../../types";
import { createTaskHandlers } from "./tasks";

function createHandlers(qc: QueryClient) {
  return createTaskHandlers({ qc } as Parameters<typeof createTaskHandlers>[0]);
}

function message(seq: number): TaskMessagePayload {
  return {
    task_id: "tsk_cache123",
    issue_id: "issue-1",
    seq,
    type: "tool_use",
    tool: "Bash",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("task message realtime cache", () => {
  it("does not create an unhydrated cache entry from WS frames", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const sync = createHandlers(qc);

    sync.handlers["task:message"]?.(message(281));
    sync.handlers["task:message"]?.(message(283));
    vi.advanceTimersByTime(80);

    expect(qc.getQueryData(["task-messages", "tsk_cache123"])).toBeUndefined();
  });

  it("appends to an existing cache entry in sequence order without duplicates", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const key = ["task-messages", "tsk_cache123"] as const;
    qc.setQueryData<TaskMessagePayload[]>(key, [message(281)]);
    const sync = createHandlers(qc);

    sync.handlers["task:message"]?.(message(283));
    sync.handlers["task:message"]?.(message(282));
    sync.handlers["task:message"]?.(message(283));
    vi.advanceTimersByTime(80);

    expect(qc.getQueryData<TaskMessagePayload[]>(key)?.map((item) => item.seq)).toEqual([
      281,
      282,
      283,
    ]);
  });
});
