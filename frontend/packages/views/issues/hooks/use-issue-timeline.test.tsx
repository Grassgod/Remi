import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock @multiremi/core/issues/mutations to mimic TanStack Query v5's contract:
// useMutation returns a fresh result wrapper on every render, but the
// `mutate` / `mutateAsync` functions inside it are stable across renders.
// This is exactly the shape that previously fooled the original deps lists
// in useIssueTimeline — guarding against a regression here means future code
// can't accidentally pull the whole mutation result into a useCallback dep.
const stableHandles = vi.hoisted(() => ({
  createMutateAsync: vi.fn(async () => ({})),
  updateMutateAsync: vi.fn(async () => ({})),
  deleteMutateAsync: vi.fn(async () => ({})),
  resolveMutateAsync: vi.fn(async () => ({})),
  toggleMutate: vi.fn(),
}));

// WS event registry — captured handlers per event name so tests can simulate
// server pushes by invoking them directly.
const wsHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
const reconnectHandlers = vi.hoisted(() => [] as Array<() => void>);
const timelineCacheSpies = vi.hoisted(() => ({
  refreshLatest: vi.fn(async () => {}),
}));

vi.mock("@multiremi/core/issues/comment-mutations", () => ({
  useCreateComment: () => ({
    mutateAsync: stableHandles.createMutateAsync,
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateComment: () => ({
    mutateAsync: stableHandles.updateMutateAsync,
    mutate: vi.fn(),
    isPending: false,
  }),
  useDeleteComment: () => ({
    mutateAsync: stableHandles.deleteMutateAsync,
    mutate: vi.fn(),
    isPending: false,
  }),
  useResolveComment: () => ({
    mutateAsync: stableHandles.resolveMutateAsync,
    mutate: vi.fn(),
    isPending: false,
  }),
  useToggleCommentReaction: () => ({
    mutateAsync: vi.fn(),
    mutate: stableHandles.toggleMutate,
    isPending: false,
  }),
}));

vi.mock("@multiremi/core/issues/queries", () => ({
  issueTimelinePageOptions: (id: string, sessionId?: string) => ({
    queryKey: ["issues", "timeline", id, sessionId ?? "all"],
    queryFn: () => Promise.resolve({ pages: [], pageParams: [] }),
  }),
  issueKeys: {
    timeline: (id: string, sessionId?: string) => [
      "issues",
      "timeline",
      id,
      sessionId ?? "all",
    ],
    timelineSyncVersion: (id: string) => ["issues", "timeline-sync", id, "version"],
    timelineSyncApplied: (id: string, sessionId?: string) => [
      "issues",
      "timeline-sync",
      id,
      sessionId ?? "all",
    ],
  },
}));

vi.mock("@multiremi/core/issues/timeline-cache", async () => {
  const actual = await vi.importActual<typeof import("@multiremi/core/issues/timeline-cache")>(
    "@multiremi/core/issues/timeline-cache",
  );
  return {
    ...actual,
    refreshIssueTimelineLatestPage: timelineCacheSpies.refreshLatest,
  };
});

// Hoisted state controllable from tests — represents what useQuery would
// return for the current render.
const queryState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
}));

// Track the latest cache-update fn the hook hands to setQueryData so tests
// can assert what would have been written.
const cacheUpdates = vi.hoisted(() => ({
  last: null as unknown,
  raw: null as unknown,
}));

const queryClientSpies = vi.hoisted(() => ({
  getQueryState: vi.fn(),
  getQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useInfiniteQuery: () => ({
      data: Array.isArray(queryState.data)
        ? {
            pages: [{
              entries: queryState.data,
              limit: 40,
              has_more: false,
              has_more_before: false,
              has_more_after: false,
              next_cursor: null,
              prev_cursor: null,
              issue_session_id: null,
            }],
            pageParams: [null],
          }
        : queryState.data,
      isLoading: queryState.isLoading,
      fetchNextPage: vi.fn(async () => {}),
      hasNextPage: false,
      isFetchingNextPage: false,
    }),
    useQueryClient: () => ({
      invalidateQueries: queryClientSpies.invalidateQueries,
      setQueryData: vi.fn((_key: unknown, updater: unknown) => {
        const current = Array.isArray(queryState.data)
          ? {
              pages: [{
                entries: queryState.data,
                limit: 40,
                has_more: false,
                has_more_before: false,
                has_more_after: false,
                next_cursor: null,
                prev_cursor: null,
                issue_session_id: null,
              }],
              pageParams: [null],
            }
          : queryState.data;
        const updated = typeof updater === "function"
          ? (updater as (old: unknown) => unknown)(current)
          : updater;
        cacheUpdates.raw = updated;
        cacheUpdates.last = updated && typeof updated === "object" && "pages" in updated
          ? [...((updated as { pages: Array<{ entries: unknown[] }> }).pages)]
              .reverse()
              .flatMap((page) => page.entries)
          : updated;
      }),
      getQueryData: queryClientSpies.getQueryData,
      getQueryState: queryClientSpies.getQueryState,
      cancelQueries: vi.fn(),
    }),
    useMutationState: () => [],
  };
});

vi.mock("@multiremi/core/realtime", () => ({
  useWSEvent: (event: string, handler: (payload: unknown) => void) => {
    wsHandlers.set(event, handler);
  },
  useWSReconnect: (handler: () => void) => {
    reconnectHandlers.push(handler);
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { useIssueTimeline } from "./use-issue-timeline";

describe("useIssueTimeline", () => {
  beforeEach(() => {
    wsHandlers.clear();
    reconnectHandlers.length = 0;
    queryState.data = [];
    queryState.isLoading = false;
    cacheUpdates.last = null;
    cacheUpdates.raw = null;
    queryClientSpies.getQueryState.mockReset();
    queryClientSpies.getQueryData.mockReset().mockReturnValue(0);
    queryClientSpies.invalidateQueries.mockReset();
    timelineCacheSpies.refreshLatest.mockClear();
  });

  // CommentCard is wrapped in React.memo (perf fix for long timelines, see
  // multimira#1968). The memo only pays off if the callbacks passed down keep
  // the same identity across unrelated parent re-renders. TanStack Query v5
  // returns a *new* mutation result wrapper on every render, so a useCallback
  // listing the whole mutation object as a dep flips its identity every time
  // — that is the exact regression this test guards against.
  it("submitReply / editComment / deleteComment / toggleReaction keep identity across unrelated re-renders", () => {
    const { result, rerender } = renderHook(() => useIssueTimeline("issue-1", "user-1"));

    const first = {
      submitComment: result.current.submitComment,
      submitReply: result.current.submitReply,
      editComment: result.current.editComment,
      deleteComment: result.current.deleteComment,
      toggleReaction: result.current.toggleReaction,
    };

    rerender();
    rerender();

    expect(result.current.submitReply).toBe(first.submitReply);
    expect(result.current.editComment).toBe(first.editComment);
    expect(result.current.deleteComment).toBe(first.deleteComment);
    expect(result.current.toggleReaction).toBe(first.toggleReaction);
    expect(result.current.submitComment).toBe(first.submitComment);
  });

  it("returns the timeline as a flat array directly from the query cache", () => {
    queryState.data = [
      { type: "comment", id: "c1", actor_type: "member", actor_id: "u", created_at: "2026-05-06T01:00:00Z" },
      { type: "comment", id: "c2", actor_type: "member", actor_id: "u", created_at: "2026-05-06T02:00:00Z" },
      { type: "comment", id: "c3", actor_type: "member", actor_id: "u", created_at: "2026-05-06T03:00:00Z" },
    ];
    const { result } = renderHook(() => useIssueTimeline("issue-1", "user-1"));
    expect(result.current.timeline.map((e) => e.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("refreshes only the latest page after local WS subscriptions mount", () => {
    queryClientSpies.getQueryState.mockReturnValue({
      isInvalidated: true,
      fetchStatus: "idle",
    });

    renderHook(() => useIssueTimeline("issue-1", "user-1", "session-main"));

    expect(timelineCacheSpies.refreshLatest).toHaveBeenCalledWith(
      expect.anything(),
      "issue-1",
      "session-main",
    );
  });

  it("does not refresh a fresh timeline during mount reconciliation", () => {
    queryClientSpies.getQueryState.mockReturnValue({
      isInvalidated: false,
      fetchStatus: "idle",
    });

    renderHook(() => useIssueTimeline("issue-1", "user-1", "session-main"));

    expect(timelineCacheSpies.refreshLatest).not.toHaveBeenCalled();
  });

  it("reconciles a global dirty generation without invalidating history pages", () => {
    queryClientSpies.getQueryState.mockReturnValue({
      isInvalidated: false,
      fetchStatus: "idle",
    });
    queryClientSpies.getQueryData.mockImplementation((key: unknown) =>
      Array.isArray(key) && key.at(-1) === "version" ? 2 : 1,
    );

    renderHook(() => useIssueTimeline("issue-1", "user-1", "session-main"));

    expect(timelineCacheSpies.refreshLatest).toHaveBeenCalledWith(
      expect.anything(),
      "issue-1",
      "session-main",
    );
    expect(queryClientSpies.invalidateQueries).not.toHaveBeenCalled();
  });

  it("does not turn a granular WS cache update into a latest-page refetch", () => {
    queryClientSpies.getQueryState.mockReturnValue({
      isInvalidated: false,
      fetchStatus: "idle",
    });
    const { rerender } = renderHook(() =>
      useIssueTimeline("issue-1", "user-1", "session-main"),
    );
    expect(timelineCacheSpies.refreshLatest).not.toHaveBeenCalled();

    queryClientSpies.getQueryData.mockImplementation((key: unknown) =>
      Array.isArray(key) && key.at(-1) === "version" ? 1 : 0,
    );
    act(() => wsHandlers.get("comment:created")!({
      comment: {
        id: "new-comment",
        issue_id: "issue-1",
        issue_session_id: "session-main",
        author_type: "member",
        author_id: "user-1",
        content: "new",
        parent_id: null,
        created_at: "2026-05-06T04:00:00Z",
        updated_at: "2026-05-06T04:00:00Z",
        type: "comment",
        reactions: [],
        attachments: [],
      },
    }));
    queryState.data = cacheUpdates.raw;
    rerender();

    expect(timelineCacheSpies.refreshLatest).not.toHaveBeenCalled();
  });

  it("refreshes only the latest page after a websocket reconnect", () => {
    renderHook(() => useIssueTimeline("issue-1", "user-1", "session-main"));

    act(() => reconnectHandlers[0]!());

    expect(timelineCacheSpies.refreshLatest).toHaveBeenCalledWith(
      expect.anything(),
      "issue-1",
      "session-main",
    );
  });

  it("comment:created appends the new entry to the cache", () => {
    queryState.data = [];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:created");
    act(() => {
      handler!({
        comment: {
          id: "new-c",
          issue_id: "issue-1",
          author_type: "member",
          author_id: "u",
          content: "hi",
          parent_id: null,
          created_at: "2026-05-06T05:00:00Z",
          updated_at: "2026-05-06T05:00:00Z",
          type: "comment",
          reactions: [],
          attachments: [],
        },
      });
    });
    const updated = cacheUpdates.last as Array<{ id: string }>;
    expect(updated.map((e) => e.id)).toEqual(["new-c"]);
  });

  it("preserves task_id on agent replies so the per-reply transcript entry survives", () => {
    queryState.data = [];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:created");
    act(() => {
      handler!({
        comment: {
          id: "agent-reply",
          issue_id: "issue-1",
          author_type: "agent",
          author_id: "agt_1",
          task_id: "tsk_run_1",
          content: "done",
          parent_id: null,
          created_at: "2026-05-06T05:00:00Z",
          updated_at: "2026-05-06T05:00:00Z",
          type: "comment",
          reactions: [],
          attachments: [],
        },
      });
    });
    const updated = cacheUpdates.last as Array<{ id: string; actor_type?: string; task_id?: string | null }>;
    expect(updated[0]?.actor_type).toBe("agent");
    expect(updated[0]?.task_id).toBe("tsk_run_1");
  });

  it("comment:created appends to the newest page without re-sorting", () => {
    queryState.data = [
      { type: "comment", id: "c1", actor_type: "member", actor_id: "u", created_at: "2026-05-06T01:00:00Z" },
      { type: "comment", id: "c3", actor_type: "member", actor_id: "u", created_at: "2026-05-06T03:00:00Z" },
    ];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:created");
    act(() => {
      handler!({
        comment: {
          id: "c2",
          issue_id: "issue-1",
          author_type: "member",
          author_id: "u",
          content: "",
          parent_id: null,
          created_at: "2026-05-06T02:00:00Z",
          updated_at: "2026-05-06T02:00:00Z",
          type: "comment",
          reactions: [],
          attachments: [],
        },
      });
    });
    const updated = cacheUpdates.last as Array<{ id: string }>;
    expect(updated.map((e) => e.id)).toEqual(["c1", "c3", "c2"]);
  });

  it("comment:created still appends when an event carries an older timestamp", () => {
    queryState.data = [
      { type: "comment", id: "c2", actor_type: "member", actor_id: "u", created_at: "2026-05-06T02:00:00Z" },
      { type: "comment", id: "c3", actor_type: "member", actor_id: "u", created_at: "2026-05-06T03:00:00Z" },
    ];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:created");
    act(() => {
      handler!({
        comment: {
          id: "c1",
          issue_id: "issue-1",
          author_type: "member",
          author_id: "u",
          content: "",
          parent_id: null,
          created_at: "2026-05-06T01:00:00Z",
          updated_at: "2026-05-06T01:00:00Z",
          type: "comment",
          reactions: [],
          attachments: [],
        },
      });
    });
    const updated = cacheUpdates.last as Array<{ id: string }>;
    expect(updated.map((e) => e.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("ignores WS events for other issues", () => {
    queryState.data = [];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:created");
    act(() => {
      handler!({
        comment: {
          id: "x",
          issue_id: "different-issue",
          author_type: "member",
          author_id: "u",
          content: "",
          parent_id: null,
          created_at: "",
          updated_at: "",
          type: "comment",
          reactions: [],
          attachments: [],
        },
      });
    });
    // setQueryData should not have been invoked for a non-matching issue.
    expect(cacheUpdates.last).toBeNull();
  });

  it("comment:updated traverses older loaded pages", () => {
    queryState.data = {
      pages: [
        { entries: [{ type: "comment", id: "newer", actor_type: "member", actor_id: "u", created_at: "2026-05-06T02:00:00Z" }] },
        { entries: [{ type: "comment", id: "older", actor_type: "member", actor_id: "u", content: "old", created_at: "2026-05-06T01:00:00Z" }] },
      ],
      pageParams: [null, "cursor"],
    };
    renderHook(() => useIssueTimeline("issue-1", "user-1", "session-main"));

    act(() => wsHandlers.get("comment:updated")!({
      comment: {
        id: "older",
        issue_id: "issue-1",
        issue_session_id: "session-main",
        author_type: "member",
        author_id: "u",
        content: "edited",
        parent_id: null,
        created_at: "2026-05-06T01:00:00Z",
        updated_at: "2026-05-06T03:00:00Z",
        type: "comment",
        reactions: [],
        attachments: [],
      },
    }));

    const updated = cacheUpdates.raw as { pages: Array<{ entries: Array<{ id: string; content?: string }> }> };
    expect(updated.pages[1]!.entries[0]).toMatchObject({ id: "older", content: "edited" });
  });

  it("comment:deleted cascades through parent and replies split across pages", () => {
    queryState.data = {
      pages: [
        { entries: [
          { type: "comment", id: "child", parent_id: "root", actor_type: "member", actor_id: "u", created_at: "2026-05-06T02:00:00Z" },
          { type: "comment", id: "grandchild", parent_id: "child", actor_type: "member", actor_id: "u", created_at: "2026-05-06T03:00:00Z" },
        ] },
        { entries: [
          { type: "comment", id: "root", actor_type: "member", actor_id: "u", created_at: "2026-05-06T01:00:00Z" },
          { type: "comment", id: "sibling", actor_type: "member", actor_id: "u", created_at: "2026-05-06T01:30:00Z" },
        ] },
      ],
      pageParams: [null, "cursor"],
    };
    renderHook(() => useIssueTimeline("issue-1", "user-1", "session-main"));

    act(() => wsHandlers.get("comment:deleted")!({
      issue_id: "issue-1",
      comment_id: "root",
    }));

    const updated = cacheUpdates.last as Array<{ id: string }>;
    expect(updated.map((entry) => entry.id)).toEqual(["sibling"]);
  });

  it("reaction:added updates a comment in an older page", () => {
    queryState.data = {
      pages: [
        { entries: [{ type: "comment", id: "newer", actor_type: "member", actor_id: "u", created_at: "2026-05-06T02:00:00Z" }] },
        { entries: [{ type: "comment", id: "older", actor_type: "member", actor_id: "u", reactions: [], created_at: "2026-05-06T01:00:00Z" }] },
      ],
      pageParams: [null, "cursor"],
    };
    renderHook(() => useIssueTimeline("issue-1", "user-1", "session-main"));

    act(() => wsHandlers.get("reaction:added")!({
      issue_id: "issue-1",
      reaction: {
        id: "reaction-1",
        comment_id: "older",
        actor_type: "member",
        actor_id: "user-1",
        emoji: "thumbsup",
        created_at: "2026-05-06T03:00:00Z",
      },
    }));

    const updated = cacheUpdates.raw as { pages: Array<{ entries: Array<{ id: string; reactions?: Array<{ id: string }> }> }> };
    expect(updated.pages[1]!.entries[0]?.reactions).toEqual([
      expect.objectContaining({ id: "reaction-1" }),
    ]);
  });

  // The global fallback only records a dirty generation, so useIssueTimeline
  // must own the immediate granular update for every event — including
  // comment:resolved / comment:unresolved. Without these handlers the bar or
  // expanded view would lag until the next page-zero reconciliation.
  it("comment:resolved updates the matching entry in place with the new resolved fields", () => {
    queryState.data = [
      {
        type: "comment",
        id: "c1",
        actor_type: "member",
        actor_id: "u",
        content: "hello",
        parent_id: null,
        created_at: "2026-05-06T01:00:00Z",
        updated_at: "2026-05-06T01:00:00Z",
        reactions: [],
        attachments: [],
        resolved_at: null,
        resolved_by_type: null,
        resolved_by_id: null,
      },
      {
        type: "comment",
        id: "c2",
        actor_type: "member",
        actor_id: "u",
        content: "untouched",
        parent_id: null,
        created_at: "2026-05-06T02:00:00Z",
        updated_at: "2026-05-06T02:00:00Z",
        reactions: [],
        attachments: [],
        resolved_at: null,
        resolved_by_type: null,
        resolved_by_id: null,
      },
    ];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:resolved");
    expect(handler).toBeDefined();
    act(() => {
      handler!({
        comment: {
          id: "c1",
          issue_id: "issue-1",
          author_type: "member",
          author_id: "u",
          content: "hello",
          parent_id: null,
          created_at: "2026-05-06T01:00:00Z",
          updated_at: "2026-05-06T01:00:00Z",
          type: "comment",
          reactions: [],
          attachments: [],
          resolved_at: "2026-05-06T03:00:00Z",
          resolved_by_type: "member",
          resolved_by_id: "u",
        },
      });
    });
    const updated = cacheUpdates.last as Array<{
      id: string;
      resolved_at: string | null;
      resolved_by_type: string | null;
      resolved_by_id: string | null;
    }>;
    expect(updated.map((e) => e.id)).toEqual(["c1", "c2"]);
    expect(updated[0]!.resolved_at).toBe("2026-05-06T03:00:00Z");
    expect(updated[0]!.resolved_by_type).toBe("member");
    expect(updated[0]!.resolved_by_id).toBe("u");
    // Sibling entry must not change (identity preserved by .map).
    expect(updated[1]!.resolved_at).toBeNull();
  });

  it("comment:unresolved clears the resolved fields on the matching entry", () => {
    queryState.data = [
      {
        type: "comment",
        id: "c1",
        actor_type: "member",
        actor_id: "u",
        content: "hello",
        parent_id: null,
        created_at: "2026-05-06T01:00:00Z",
        updated_at: "2026-05-06T01:00:00Z",
        reactions: [],
        attachments: [],
        resolved_at: "2026-05-06T03:00:00Z",
        resolved_by_type: "member",
        resolved_by_id: "u",
      },
    ];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:unresolved");
    expect(handler).toBeDefined();
    act(() => {
      handler!({
        comment: {
          id: "c1",
          issue_id: "issue-1",
          author_type: "member",
          author_id: "u",
          content: "hello",
          parent_id: null,
          created_at: "2026-05-06T01:00:00Z",
          updated_at: "2026-05-06T01:00:00Z",
          type: "comment",
          reactions: [],
          attachments: [],
          resolved_at: null,
          resolved_by_type: null,
          resolved_by_id: null,
        },
      });
    });
    const updated = cacheUpdates.last as Array<{
      id: string;
      resolved_at: string | null;
    }>;
    expect(updated[0]!.resolved_at).toBeNull();
  });

  it("comment:resolved ignores events from other issues", () => {
    queryState.data = [
      {
        type: "comment",
        id: "c1",
        actor_type: "member",
        actor_id: "u",
        content: "hello",
        parent_id: null,
        created_at: "2026-05-06T01:00:00Z",
        updated_at: "2026-05-06T01:00:00Z",
        reactions: [],
        attachments: [],
        resolved_at: null,
        resolved_by_type: null,
        resolved_by_id: null,
      },
    ];
    renderHook(() => useIssueTimeline("issue-1", "user-1"));
    const handler = wsHandlers.get("comment:resolved");
    act(() => {
      handler!({
        comment: {
          id: "c1",
          issue_id: "different-issue",
          author_type: "member",
          author_id: "u",
          content: "hello",
          parent_id: null,
          created_at: "2026-05-06T01:00:00Z",
          updated_at: "2026-05-06T01:00:00Z",
          type: "comment",
          reactions: [],
          attachments: [],
          resolved_at: "2026-05-06T03:00:00Z",
          resolved_by_type: "member",
          resolved_by_id: "u",
        },
      });
    });
    expect(cacheUpdates.last).toBeNull();
  });
});
