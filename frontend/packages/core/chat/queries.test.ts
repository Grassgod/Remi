import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMessagePayload } from "../types";
import { createTaskHandlers } from "../realtime/sync/tasks";

const listTaskMessages = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  api: { listTaskMessages },
}));

import {
  appendTaskMessagesToHydratedCache,
  CHAT_PENDING_REFETCH_INTERVAL_MS,
  isTaskMessageTaskId,
  pendingChatTaskRefetchInterval,
  pendingChatTasksRefetchInterval,
  chatKeys,
  taskMessagesOptions,
} from "./queries";

function message(
  seq: number,
  content: string,
  taskId = "tsk_yp54h63yc7wx",
): TaskMessagePayload {
  return {
    task_id: taskId,
    issue_id: "issue-1",
    seq,
    type: "text",
    content,
  };
}

beforeEach(() => {
  listTaskMessages.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
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

  it("keeps WS frames that arrive while the initial history fetch is in flight", async () => {
    vi.useFakeTimers();
    const taskId = "tsk_race";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sync = createTaskHandlers({ qc } as Parameters<typeof createTaskHandlers>[0]);
    let resolveFetch!: (messages: TaskMessagePayload[]) => void;
    listTaskMessages.mockReturnValue(new Promise<TaskMessagePayload[]>((resolve) => {
      resolveFetch = resolve;
    }));

    const pending = qc.fetchQuery(taskMessagesOptions(taskId));
    sync.handlers["task:message"]?.(message(289, "live", taskId));
    vi.advanceTimersByTime(80);

    resolveFetch([
      message(287, "history 287", taskId),
      message(288, "history 288", taskId),
    ]);
    const result = await pending;

    expect(result.map((item) => item.seq)).toEqual([287, 288, 289]);
  });

  it("bounds the in-flight bridge buffer to the latest 200 frames per task", async () => {
    const taskId = "tsk_frame_bound";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveFetch!: (messages: TaskMessagePayload[]) => void;
    listTaskMessages.mockReturnValue(new Promise<TaskMessagePayload[]>((resolve) => {
      resolveFetch = resolve;
    }));

    const pending = qc.fetchQuery(taskMessagesOptions(taskId));
    appendTaskMessagesToHydratedCache(
      qc,
      taskId,
      Array.from({ length: 205 }, (_, index) => message(index + 1, "live", taskId)),
    );
    resolveFetch([]);

    const result = await pending;
    expect(result).toHaveLength(200);
    expect([result[0]?.seq, result.at(-1)?.seq]).toEqual([6, 205]);
  });

  it("bounds the in-flight bridge buffer to the 100 most recent tasks", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const resolvers = new Map<string, (messages: TaskMessagePayload[]) => void>();
    listTaskMessages.mockImplementation((taskId: string) =>
      new Promise<TaskMessagePayload[]>((resolve) => {
        resolvers.set(taskId, resolve);
      }));

    const taskIds = Array.from({ length: 101 }, (_, index) => `tsk_buffer_${index}`);
    const pending = taskIds.map((taskId) => {
      const query = qc.fetchQuery(taskMessagesOptions(taskId));
      appendTaskMessagesToHydratedCache(qc, taskId, [message(1, "live", taskId)]);
      return query;
    });
    for (const resolve of resolvers.values()) resolve([]);
    const results = await Promise.all(pending);

    expect(results[0]).toEqual([]);
    expect(results.at(-1)?.map((item) => item.seq)).toEqual([1]);
  });

  it("clears buffered frames when the history fetch fails", async () => {
    const taskId = "tsk_failed_fetch";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let rejectFetch!: (error: Error) => void;
    listTaskMessages
      .mockReturnValueOnce(new Promise<TaskMessagePayload[]>((_resolve, reject) => {
        rejectFetch = reject;
      }))
      .mockResolvedValueOnce([]);

    const failed = qc.fetchQuery(taskMessagesOptions(taskId));
    appendTaskMessagesToHydratedCache(qc, taskId, [message(1, "live", taskId)]);
    rejectFetch(new Error("network failed"));
    await expect(failed).rejects.toThrow("network failed");

    const retried = await qc.fetchQuery(taskMessagesOptions(taskId));
    expect(retried).toEqual([]);
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
