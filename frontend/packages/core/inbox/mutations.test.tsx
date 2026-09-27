/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { InboxItem, InboxPage } from "../types";
import {
  MARK_READ_MAX_RETRIES,
  MARK_READ_RETRY_DELAY_MS,
  MarkInboxItemsReadError,
  markInboxItemsReadBounded,
  useArchiveInbox,
  useArchiveInboxItems,
  useMarkInboxItemsRead,
} from "./mutations";
import { inboxKeys } from "./queries";

vi.mock("../hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

function makeItem(id: string, type: InboxItem["type"]): InboxItem {
  return {
    id,
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: null,
    actor_id: null,
    type,
    severity: "info",
    issue_id: "issue-1",
    title: id,
    body: null,
    issue_status: "done",
    read: false,
    archived: false,
    created_at: "2026-08-25T10:00:00.000Z",
    details: null,
  };
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useArchiveInbox", () => {
  let queryClient: QueryClient;
  const archiveInbox = vi.fn();

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    archiveInbox.mockResolvedValue(makeItem("ledger-selected", "autopilot_run_failed"));
    setApiInstance({ archiveInbox } as unknown as ApiClient);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("optimistically archives only the requested row when an issue has several notifications", async () => {
    const key = inboxKeys.list("ws-1");
    queryClient.setQueryData<InboxItem[]>(key, [
      makeItem("ledger-selected", "autopilot_run_failed"),
      makeItem("ledger-neighbor", "autopilot_run_completed"),
      makeItem("action-neighbor", "comment_mention"),
    ]);
    const { result } = renderHook(() => useArchiveInbox(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync("ledger-selected");
    });

    expect(archiveInbox).toHaveBeenCalledWith("ledger-selected");
    const after = queryClient.getQueryData<InboxItem[]>(key);
    expect(after?.map(({ id, archived, read }) => ({ id, archived, read }))).toEqual([
      { id: "ledger-selected", archived: true, read: true },
      { id: "ledger-neighbor", archived: false, read: false },
      { id: "action-neighbor", archived: false, read: false },
    ]);
  });

  it("archives every immutable row covered by a collapsed run entry", async () => {
    const key = inboxKeys.list("ws-1");
    queryClient.setQueryData<InboxItem[]>(key, [
      makeItem("run-latest", "autopilot_run_completed"),
      makeItem("run-earlier", "autopilot_run_completed"),
      makeItem("run-failed", "autopilot_run_failed"),
    ]);
    const { result } = renderHook(() => useArchiveInboxItems(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(["run-latest", "run-earlier"]);
    });

    expect(archiveInbox).toHaveBeenCalledTimes(2);
    expect(archiveInbox).toHaveBeenCalledWith("run-latest");
    expect(archiveInbox).toHaveBeenCalledWith("run-earlier");
    expect(queryClient.getQueryData<InboxItem[]>(key)?.map(({ id, archived }) => ({ id, archived })))
      .toEqual([
        { id: "run-latest", archived: true },
        { id: "run-earlier", archived: true },
        { id: "run-failed", archived: false },
      ]);
  });

  it("updates the paged inbox cache optimistically", async () => {
    const key = inboxKeys.pages("ws-1");
    queryClient.setQueryData<InfiniteData<InboxPage>>(key, {
      pages: [{
        items: [
          makeItem("run-latest", "autopilot_run_completed"),
          makeItem("run-earlier", "autopilot_run_completed"),
        ],
        limit: 50,
        has_more: false,
        next_cursor: null,
      }],
      pageParams: [null],
    });
    const { result } = renderHook(() => useArchiveInboxItems(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync(["run-latest"]);
    });

    const after = queryClient.getQueryData<InfiniteData<InboxPage>>(key);
    expect(after?.pages[0]?.items.map(({ id, archived }) => ({ id, archived }))).toEqual([
      { id: "run-latest", archived: true },
      { id: "run-earlier", archived: false },
    ]);
  });
});

describe("markInboxItemsReadBounded (MUL-472 d)", () => {
  const markInboxRead = vi.fn();

  beforeEach(() => {
    markInboxRead.mockReset();
    setApiInstance({ markInboxRead } as unknown as ApiClient);
  });

  it("issues one request + two retries when the endpoint keeps returning 500", async () => {
    const waits: number[] = [];
    markInboxRead.mockRejectedValue(new ApiError("server exploded", 500, "Internal Server Error"));

    const result = await markInboxItemsReadBounded(["item-1"], {
      delayMs: 5,
      onDelay: (_id, waitMs) => waits.push(waitMs),
    });

    expect(markInboxRead).toHaveBeenCalledTimes(1 + MARK_READ_MAX_RETRIES);
    expect(waits).toEqual([5, 5]);
    expect(result.marked).toEqual([]);
    expect(result.failed).toEqual([
      {
        id: "item-1",
        error: expect.any(ApiError),
        attempts: 1 + MARK_READ_MAX_RETRIES,
        retryable: true,
      },
    ]);
  });

  it("defaults the retry wait to at least 5 s", async () => {
    const waits: number[] = [];
    markInboxRead.mockRejectedValue(new ApiError("nope", 503, "Service Unavailable"));
    await markInboxItemsReadBounded(["item-1"], {
      onDelay: (_id, waitMs) => waits.push(waitMs),
      // keep the test fast without touching the exported floor
    });
    expect(MARK_READ_RETRY_DELAY_MS).toBeGreaterThanOrEqual(5_000);
    expect(waits).toEqual([MARK_READ_RETRY_DELAY_MS, MARK_READ_RETRY_DELAY_MS]);
  }, 30_000);

  it("does not retry a 404", async () => {
    markInboxRead.mockRejectedValue(new ApiError("gone", 404, "Not Found"));
    const result = await markInboxItemsReadBounded(["item-1"], { delayMs: 1 });

    expect(markInboxRead).toHaveBeenCalledTimes(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: "item-1", attempts: 1, retryable: false });
  });

  it("stops after the first success and reports the id as marked", async () => {
    markInboxRead
      .mockRejectedValueOnce(new ApiError("flaky", 500, "Internal Server Error"))
      .mockResolvedValueOnce(makeItem("item-1", "autopilot_run_completed"));

    const result = await markInboxItemsReadBounded(["item-1"], { delayMs: 1 });

    expect(markInboxRead).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ marked: ["item-1"], failed: [] });
  });

  it("keeps a failing id and a healthy id independent", async () => {
    markInboxRead.mockImplementation(async (id: string) => {
      if (id === "bad") throw new ApiError("server exploded", 500, "Internal Server Error");
      return makeItem(id, "autopilot_run_completed");
    });

    const result = await markInboxItemsReadBounded(["bad", "good"], { delayMs: 1 });

    expect(markInboxRead).toHaveBeenCalledTimes((1 + MARK_READ_MAX_RETRIES) + 1);
    expect(result.marked).toEqual(["good"]);
    expect(result.failed.map((failure) => failure.id)).toEqual(["bad"]);
  });
});

describe("useMarkInboxItemsRead (MUL-472 d)", () => {
  let queryClient: QueryClient;
  const markInboxRead = vi.fn();

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    markInboxRead.mockReset();
    setApiInstance({ markInboxRead } as unknown as ApiClient);
    queryClient.setQueryData(inboxKeys.list("ws-1"), [makeItem("item-1", "autopilot_run_completed")]);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("surfaces the per-id failure ledger so the page can park the row", async () => {
    markInboxRead.mockRejectedValue(new ApiError("server exploded", 500, "Internal Server Error"));
    const { result } = renderHook(() => useMarkInboxItemsRead({ retryDelayMs: 1 }), {
      wrapper: createWrapper(queryClient),
    });

    await expect(
      act(async () => {
        await result.current.mutateAsync(["item-1"]);
      }),
    ).rejects.toThrow(MarkInboxItemsReadError);

    expect(markInboxRead).toHaveBeenCalledTimes(1 + MARK_READ_MAX_RETRIES);
  });
});
