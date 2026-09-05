import { describe, expect, it } from "vitest";

import {
  appendLoadedPage,
  findIssueLocation,
  findIssueLocations,
  patchIssueInBuckets,
  removeIssueFromBuckets,
} from "./cache-helpers";
import { reconcileIssueBuckets } from "./queries";
import type { Issue, IssueStatus, ListIssuesCache } from "../types";

/**
 * Regression coverage for MUL-253 symptom B: an Issue whose `status` is
 * `in_progress` rendering under 审核中 on the board.
 *
 * The board reads `flattenIssueBuckets` → `issueMap` (a Map keyed by id, so
 * last write wins in `BOARD_STATUSES` order, where `in_review` follows
 * `in_progress`). Any path that lets one id sit in two status buckets
 * therefore draws the card in the wrong column AND labels it with the wrong
 * status, while the detail page — which uses its own `issueKeys.detail`
 * query — keeps showing the right one.
 */

function issue(id: string, status: IssueStatus): Issue {
  return {
    id,
    workspace_id: "ws1",
    number: 1,
    identifier: `MUL-${id}`,
    title: `Issue ${id}`,
    description: null,
    status,
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
  } as Issue;
}

/** Shape of one `api.listIssues({ status })` response in the fan-out. */
function response(status: IssueStatus, issues: Issue[], total = issues.length) {
  return { status, issues, total };
}

function ids(cache: ListIssuesCache, status: IssueStatus) {
  return (cache.byStatus[status]?.issues ?? []).map((i) => i.id);
}

describe("reconcileIssueBuckets", () => {
  it("buckets each issue by its own status, not by the status that was requested", () => {
    // `iss-a` was still `in_progress` when the in_progress request was
    // served, and had flipped to `in_review` by the time that request was
    // served — so it comes back from both.
    const cache = reconcileIssueBuckets([
      response("in_progress", [issue("iss-a", "in_review"), issue("iss-b", "in_progress")]),
      response("in_review", [issue("iss-a", "in_review")]),
    ]);

    expect(ids(cache, "in_progress")).toEqual(["iss-b"]);
    expect(ids(cache, "in_review")).toEqual(["iss-a"]);
  });

  it("never leaves the same id in two buckets", () => {
    const cache = reconcileIssueBuckets([
      response("in_progress", [issue("iss-a", "in_progress")]),
      response("in_review", [issue("iss-a", "in_review")]),
      response("todo", [issue("iss-a", "todo")]),
    ]);

    const seen = Object.values(cache.byStatus).flatMap((b) => b?.issues ?? []);
    expect(seen.map((i) => i.id)).toEqual(["iss-a"]);
  });

  it("keeps the server total for each requested status so load-more still works", () => {
    // Regression: overwriting `total` with the reconciled length makes
    // `hasMore = loaded < total` permanently false in useLoadMoreByStatus,
    // silently capping every column at its first page of 50.
    const page = Array.from({ length: 50 }, (_, i) => issue(`p-${i}`, "in_progress"));
    const cache = reconcileIssueBuckets([response("in_progress", page, 137)]);

    expect(cache.byStatus.in_progress?.issues).toHaveLength(50);
    expect(cache.byStatus.in_progress?.total).toBe(137);
  });

  it("reports zero for a status that was requested and came back empty", () => {
    const cache = reconcileIssueBuckets([response("blocked", [], 0)]);
    expect(cache.byStatus.blocked).toEqual({ issues: [], total: 0 });
  });

  it("drops an issue that moved to a status the board does not paginate", () => {
    // `cancelled` is deliberately excluded from PAGINATED_STATUSES.
    const cache = reconcileIssueBuckets([
      response("todo", [issue("iss-a", "cancelled"), issue("iss-b", "todo")]),
    ]);

    expect(ids(cache, "todo")).toEqual(["iss-b"]);
    expect(Object.values(cache.byStatus).flatMap((b) => b?.issues ?? [])).toHaveLength(1);
  });

  it("preserves server order within a bucket", () => {
    const cache = reconcileIssueBuckets([
      response("todo", [issue("c", "todo"), issue("a", "todo"), issue("b", "todo")]),
    ]);
    expect(ids(cache, "todo")).toEqual(["c", "a", "b"]);
  });
});

describe("findIssueLocations", () => {
  it("returns every bucket holding the id, not just the first", () => {
    const cache: ListIssuesCache = {
      byStatus: {
        in_progress: { issues: [issue("iss-a", "in_progress")], total: 1 },
        in_review: { issues: [issue("iss-a", "in_review")], total: 1 },
      },
    };

    expect(findIssueLocations(cache, "iss-a").map((l) => l.status)).toEqual([
      "in_progress",
      "in_review",
    ]);
    expect(findIssueLocation(cache, "iss-a")?.status).toBe("in_progress");
  });

  it("returns nothing for an unknown id", () => {
    const cache: ListIssuesCache = { byStatus: {} };
    expect(findIssueLocations(cache, "nope")).toEqual([]);
    expect(findIssueLocation(cache, "nope")).toBeNull();
  });
});

describe("removeIssueFromBuckets", () => {
  it("clears every stale copy and decrements each bucket's total", () => {
    const cache: ListIssuesCache = {
      byStatus: {
        in_progress: { issues: [issue("iss-a", "in_progress"), issue("iss-b", "in_progress")], total: 2 },
        in_review: { issues: [issue("iss-a", "in_review")], total: 1 },
      },
    };

    const next = removeIssueFromBuckets(cache, "iss-a");

    expect(ids(next, "in_progress")).toEqual(["iss-b"]);
    expect(ids(next, "in_review")).toEqual([]);
    expect(next.byStatus.in_progress?.total).toBe(1);
    expect(next.byStatus.in_review?.total).toBe(0);
  });
});

describe("patchIssueInBuckets", () => {
  it("patches in place without reordering the column", () => {
    // Regression: rebuilding the bucket on every WS `issue:updated` patch
    // sends the card to the bottom of its column mid-read.
    const cache: ListIssuesCache = {
      byStatus: {
        todo: {
          issues: [issue("a", "todo"), issue("b", "todo"), issue("c", "todo")],
          total: 3,
        },
      },
    };

    const next = patchIssueInBuckets(cache, "a", { title: "renamed" });

    expect(ids(next, "todo")).toEqual(["a", "b", "c"]);
    expect(next.byStatus.todo?.issues[0]?.title).toBe("renamed");
    expect(next.byStatus.todo?.total).toBe(3);
  });

  it("moves the issue and adjusts both totals on a status change", () => {
    const cache: ListIssuesCache = {
      byStatus: {
        in_review: { issues: [issue("a", "in_review"), issue("b", "in_review")], total: 2 },
        in_progress: { issues: [], total: 0 },
      },
    };

    const next = patchIssueInBuckets(cache, "a", { status: "in_progress" });

    expect(ids(next, "in_review")).toEqual(["b"]);
    expect(ids(next, "in_progress")).toEqual(["a"]);
    expect(next.byStatus.in_review?.total).toBe(1);
    expect(next.byStatus.in_progress?.total).toBe(1);
    expect(next.byStatus.in_progress?.issues[0]?.status).toBe("in_progress");
  });

  it("collapses a duplicated id down to the patched status", () => {
    // The self-healing property symptom B was missing: while
    // findIssueLocation only reported the first bucket, a WS patch repaired
    // the in_progress copy and left the in_review copy to keep winning in
    // the board's issueMap.
    const cache: ListIssuesCache = {
      byStatus: {
        in_progress: { issues: [issue("a", "in_progress")], total: 1 },
        in_review: { issues: [issue("a", "in_review"), issue("b", "in_review")], total: 2 },
      },
    };

    const next = patchIssueInBuckets(cache, "a", { status: "in_progress" });

    expect(ids(next, "in_progress")).toEqual(["a"]);
    expect(ids(next, "in_review")).toEqual(["b"]);
    expect(next.byStatus.in_review?.total).toBe(1);
    expect(next.byStatus.in_progress?.total).toBe(1);
  });

  it("keeps the destination slot when collapsing a duplicate that stays put", () => {
    const cache: ListIssuesCache = {
      byStatus: {
        in_progress: {
          issues: [issue("x", "in_progress"), issue("a", "in_progress"), issue("y", "in_progress")],
          total: 3,
        },
        in_review: { issues: [issue("a", "in_review")], total: 1 },
      },
    };

    const next = patchIssueInBuckets(cache, "a", { status: "in_progress", title: "renamed" });

    expect(ids(next, "in_progress")).toEqual(["x", "a", "y"]);
    expect(next.byStatus.in_progress?.issues[1]?.title).toBe("renamed");
    expect(next.byStatus.in_progress?.total).toBe(3);
    expect(ids(next, "in_review")).toEqual([]);
    expect(next.byStatus.in_review?.total).toBe(0);
  });

  it("is a no-op for an id the cache has never seen", () => {
    const cache: ListIssuesCache = {
      byStatus: { todo: { issues: [issue("a", "todo")], total: 1 } },
    };
    expect(patchIssueInBuckets(cache, "missing", { title: "x" })).toBe(cache);
  });
});

describe("appendLoadedPage", () => {
  it("appends the next page and keeps the server total", () => {
    const cache: ListIssuesCache = {
      byStatus: { todo: { issues: [issue("a", "todo")], total: 3 } },
    };

    const next = appendLoadedPage(cache, "todo", {
      issues: [issue("b", "todo"), issue("c", "todo")],
      total: 3,
    });

    expect(ids(next, "todo")).toEqual(["a", "b", "c"]);
    expect(next.byStatus.todo?.total).toBe(3);
  });

  it("evicts a stale copy from another bucket instead of duplicating the id", () => {
    // `iss-a` was in_review when page 1 loaded and has since moved to
    // in_progress. Page 2 of in_progress now returns it; appending without
    // eviction would leave it in both columns.
    const cache: ListIssuesCache = {
      byStatus: {
        in_progress: { issues: [issue("x", "in_progress")], total: 2 },
        in_review: { issues: [issue("iss-a", "in_review")], total: 1 },
      },
    };

    const next = appendLoadedPage(cache, "in_progress", {
      issues: [issue("iss-a", "in_progress")],
      total: 2,
    });

    expect(ids(next, "in_progress")).toEqual(["x", "iss-a"]);
    expect(ids(next, "in_review")).toEqual([]);
    expect(next.byStatus.in_review?.total).toBe(0);
    expect(next.byStatus.in_progress?.total).toBe(2);
  });

  it("does not re-append an issue already in the target bucket", () => {
    const cache: ListIssuesCache = {
      byStatus: { todo: { issues: [issue("a", "todo"), issue("b", "todo")], total: 2 } },
    };

    const next = appendLoadedPage(cache, "todo", {
      issues: [issue("b", "todo"), issue("c", "todo")],
      total: 3,
    });

    expect(ids(next, "todo")).toEqual(["a", "b", "c"]);
  });
});
