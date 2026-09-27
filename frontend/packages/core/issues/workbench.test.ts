// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  partitionReviewIssues,
  useWorkbenchPendingCount,
  workbenchKeys,
} from "./workbench";
import type { AgentTask, Issue } from "../types";

const listIssues = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({
  api: { listIssues },
}));

function issue(id: string): Issue {
  return {
    id,
    workspace_id: "ws1",
    number: 1,
    identifier: `MUL-${id}`,
    title: `Issue ${id}`,
    description: null,
    status: "in_review",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u1",
    parent_issue_id: null,
    project_id: null,
    position: 0,
    start_date: null,
    due_date: null,
    metadata: {},
    completed_at: null,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function task(issueId: string, status: AgentTask["status"]): AgentTask {
  return {
    id: `task-${issueId}-${status}`,
    agent_id: "agent1",
    issue_id: issueId,
    status,
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
  } as AgentTask;
}

describe("partitionReviewIssues", () => {
  it("splits issues with an awaiting_human task from plain review issues", () => {
    const issues = [issue("a"), issue("b"), issue("c")];
    const snapshot = [task("b", "awaiting_human"), task("c", "completed")];
    const { awaitingInput, awaitingReview } = partitionReviewIssues(issues, snapshot);
    expect(awaitingInput.map((i) => i.id)).toEqual(["b"]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("ignores non-awaiting task statuses", () => {
    const issues = [issue("a")];
    const snapshot = [task("a", "running"), task("a", "queued"), task("a", "completed")];
    const { awaitingInput, awaitingReview } = partitionReviewIssues(issues, snapshot);
    expect(awaitingInput).toEqual([]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["a"]);
  });

  it("preserves input order within each bucket", () => {
    const issues = [issue("a"), issue("b"), issue("c"), issue("d")];
    const snapshot = [task("d", "awaiting_human"), task("a", "awaiting_human")];
    const { awaitingInput, awaitingReview } = partitionReviewIssues(issues, snapshot);
    expect(awaitingInput.map((i) => i.id)).toEqual(["a", "d"]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("handles an empty snapshot", () => {
    const { awaitingInput, awaitingReview } = partitionReviewIssues([issue("a")], []);
    expect(awaitingInput).toEqual([]);
    expect(awaitingReview).toHaveLength(1);
  });

  // MUL-253: the snapshot and the in_review list are two independent
  // queries, so they are routinely out of step. Neither direction may drop
  // an issue or move it out of 审核中 entirely.
  it("keeps an issue missing from the snapshot in the review bucket", () => {
    const { awaitingInput, awaitingReview } = partitionReviewIssues(
      [issue("a"), issue("b")],
      [task("b", "awaiting_human")],
    );
    expect(awaitingReview.map((i) => i.id)).toEqual(["a"]);
    expect(awaitingInput.map((i) => i.id)).toEqual(["b"]);
  });

  it("still routes to awaiting-input when the snapshot is stale", () => {
    // The human already answered and the task went back to `running`, but
    // this snapshot predates that. The issue stays in 待回复 until the
    // snapshot refetches — it must not vanish from the workbench.
    const { awaitingInput, awaitingReview } = partitionReviewIssues(
      [issue("a")],
      [task("a", "awaiting_human")],
    );
    expect(awaitingInput.map((i) => i.id)).toEqual(["a"]);
    expect(awaitingReview).toEqual([]);
  });

  it("ignores snapshot tasks for issues outside the in_review list", () => {
    const { awaitingInput, awaitingReview } = partitionReviewIssues(
      [issue("a")],
      [task("zzz", "awaiting_human"), task("a", "completed")],
    );
    expect(awaitingInput).toEqual([]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["a"]);
  });

  it("ignores an awaiting_human task with no issue", () => {
    const orphan = {
      ...task("a", "awaiting_human"),
      issue_id: null,
    } as unknown as AgentTask;
    const { awaitingInput, awaitingReview } = partitionReviewIssues([issue("a")], [orphan]);
    expect(awaitingInput).toEqual([]);
    expect(awaitingReview.map((i) => i.id)).toEqual(["a"]);
  });

  it("routes an issue with both an awaiting_human and a running task to awaiting-input", () => {
    // A squad issue can have several live tasks. One agent blocked on a
    // question is enough to need the human, regardless of the siblings.
    const { awaitingInput } = partitionReviewIssues(
      [issue("a")],
      [task("a", "running"), task("a", "awaiting_human")],
    );
    expect(awaitingInput.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("useWorkbenchPendingCount (MUL-472 c)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rolls both statuses into one statuses= request and equals the merged two-request result", async () => {
    // The old shape: two `limit=200` requests, one per status. The badge summed
    // their `total`s. Serve the same two totals through the new single request
    // and assert both the request shape and the number.
    const perStatusTotals: Record<string, number> = { in_review: 2, blocked: 3 };
    const mergedTwoRequestResult = (perStatusTotals.in_review ?? 0) + (perStatusTotals.blocked ?? 0);
    listIssues.mockImplementation(
      ({ statuses }: { statuses: string[] }) =>
        Promise.resolve({
          issues: [],
          total: statuses.reduce((sum, status) => sum + (perStatusTotals[status] ?? 0), 0),
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(
      () => [useWorkbenchPendingCount("ws1"), useWorkbenchPendingCount("ws1")],
      { wrapper },
    );

    await waitFor(() => expect(result.current).toEqual([5, 5]));
    expect(result.current[0]).toBe(mergedTwoRequestResult);
    // One request for the pair, however many components subscribe.
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith({
      statuses: ["in_review", "blocked"],
      limit: 1,
    });
  });

  it("resolves the badge from the combined key so a mounted page cannot double-fetch it", () => {
    expect(workbenchKeys.pendingCount("ws1")).toEqual([
      ...workbenchKeys.all("ws1"),
      "pending-count",
    ]);
  });

  it("does not query while the shell gate is closed", () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(
      () => useWorkbenchPendingCount("ws1", false),
      { wrapper },
    );

    expect(result.current).toBe(0);
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("does not query without a workspace", () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useWorkbenchPendingCount(null), { wrapper });

    expect(result.current).toBe(0);
    expect(listIssues).not.toHaveBeenCalled();
  });
});
