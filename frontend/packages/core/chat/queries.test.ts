import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMessagePayload } from "../types";

const listTaskMessages = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  api: { listTaskMessages },
}));

import {
  CHAT_PENDING_REFETCH_INTERVAL_MS,
  isTaskMessageTaskId,
  pendingChatTaskRefetchInterval,
  pendingChatTasksRefetchInterval,
  chatKeys,
  taskMessagesOptions,
} from "./queries";

function message(seq: number, content: string): TaskMessagePayload {
  return {
    task_id: "tsk_yp54h63yc7wx",
    issue_id: "issue-1",
    seq,
    type: "text",
    content,
  };
}

beforeEach(() => {
  listTaskMessages.mockReset();
});

describe("taskMessagesOptions", () => {
  it("fetches task messages for persisted UUID task ids", () => {
    const taskId = "4a2e8d1c-7f9b-4e2a-9c1d-123456789abc";

    expect(isTaskMessageTaskId(taskId)).toBe(true);
    expect(taskMessagesOptions(taskId).enabled).toBe(true);
  });

  it("does not fetch task messages for optimistic task ids", () => {
    const taskId = "optimistic-optimistic-1778739487737";

    expect(isTaskMessageTaskId(taskId)).toBe(false);
    expect(taskMessagesOptions(taskId).enabled).toBe(false);
  });

  it("fetches task messages for persisted prefixed task ids", () => {
    const taskId = "tsk_yp54h63yc7wx";

    expect(isTaskMessageTaskId(taskId)).toBe(true);
    expect(taskMessagesOptions(taskId).enabled).toBe(true);
  });

  it("merges fetched history with WS frames already in the cache", async () => {
    const taskId = "tsk_yp54h63yc7wx";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = chatKeys.taskMessages(taskId);
    qc.setQueryData<TaskMessagePayload[]>(key, [
      message(2, "cached two"),
      message(3, "cached three"),
    ], { updatedAt: 1 });
    listTaskMessages.mockResolvedValue([
      message(1, "fetched one"),
      message(3, "stale fetched three"),
    ]);

    const result = await qc.fetchQuery({
      ...taskMessagesOptions(taskId),
      staleTime: 0,
    });

    expect(listTaskMessages).toHaveBeenCalledWith(taskId);
    expect(result.map((item) => [item.seq, item.content])).toEqual([
      [1, "fetched one"],
      [2, "cached two"],
      [3, "cached three"],
    ]);
  });
});

describe("pending chat task polling", () => {
  it("polls only while a per-session task is pending", () => {
    expect(pendingChatTaskRefetchInterval({
      state: { data: { task_id: "tsk_1", status: "queued" } },
    })).toBe(CHAT_PENDING_REFETCH_INTERVAL_MS);
    expect(pendingChatTaskRefetchInterval({
      state: { data: {} },
    })).toBe(false);
  });

  it("polls the aggregate only while it contains pending tasks", () => {
    expect(pendingChatTasksRefetchInterval({
      state: {
        data: {
          tasks: [{
            task_id: "tsk_1",
            status: "running",
            chat_session_id: "chat-1",
          }],
        },
      },
    })).toBe(CHAT_PENDING_REFETCH_INTERVAL_MS);
    expect(pendingChatTasksRefetchInterval({
      state: { data: { tasks: [] } },
    })).toBe(false);
  });
});
