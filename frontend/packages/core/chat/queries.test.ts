import { describe, expect, it } from "vitest";

import {
  CHAT_PENDING_REFETCH_INTERVAL_MS,
  isTaskMessageTaskId,
  pendingChatTaskRefetchInterval,
  pendingChatTasksRefetchInterval,
  taskMessagesOptions,
} from "./queries";

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
