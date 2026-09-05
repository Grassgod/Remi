import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { TimelineEntry, TimelinePage } from "../types";
import {
  appendTimelineEntry,
  mapTimelineEntries,
  isIssueTimelineDirty,
  markIssueTimelineDirty,
  mergeTimelineLatestPage,
  removeTimelineCommentTree,
  seedIssueTimelinePage,
  timelineEntries,
  type IssueTimelineData,
} from "./timeline-cache";

function entry(id: string, second: number, parentId?: string): TimelineEntry {
  return {
    type: "comment",
    id,
    actor_type: "member",
    actor_id: "member-1",
    content: id,
    parent_id: parentId ?? null,
    created_at: `2026-09-05T10:00:${String(second).padStart(2, "0")}.000Z`,
    reactions: [],
  };
}

function page(
  entries: TimelineEntry[],
  options: { hasMore?: boolean; cursor?: string | null } = {},
): TimelinePage {
  return {
    entries,
    limit: 2,
    has_more: options.hasMore ?? false,
    has_more_before: options.hasMore ?? false,
    has_more_after: false,
    next_cursor: options.cursor ?? null,
    prev_cursor: null,
    issue_session_id: "session-1",
  };
}

function data(pages: TimelinePage[]): IssueTimelineData {
  return {
    pages,
    pageParams: pages.map((_page, index) => index === 0 ? null : `cursor-${index}`),
  };
}

describe("issue timeline infinite cache", () => {
  it("renders older pages first and appends a live entry only to page zero", () => {
    const current = data([
      page([entry("c3", 3), entry("c4", 4)], { hasMore: true, cursor: "c3" }),
      page([entry("c1", 1), entry("c2", 2)]),
    ]);

    const appended = appendTimelineEntry(current, entry("c5", 5))!;
    expect(appended.pages[0]!.entries.map((item) => item.id)).toEqual(["c3", "c4", "c5"]);
    expect(appended.pages[1]).toBe(current.pages[1]);
    expect(timelineEntries(appended).map((item) => item.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);

    expect(appendTimelineEntry(appended, entry("c2", 2))).toBe(appended);
  });

  it("updates entries and reactions across every loaded page", () => {
    const current = data([
      page([entry("c3", 3), entry("c4", 4)]),
      page([entry("c1", 1), entry("c2", 2)]),
    ]);

    const updated = mapTimelineEntries(current, (item) => item.id === "c1"
      ? {
          ...item,
          content: "edited",
          reactions: [{
            id: "reaction-1",
            comment_id: item.id,
            actor_type: "member",
            actor_id: "member-1",
            emoji: "thumbsup",
            created_at: item.created_at,
          }],
        }
      : item)!;

    expect(updated.pages[0]).toBe(current.pages[0]);
    expect(updated.pages[1]!.entries[0]).toMatchObject({
      id: "c1",
      content: "edited",
      reactions: [{ id: "reaction-1" }],
    });
  });

  it("cascades a parent deletion through replies split across pages", () => {
    const current = data([
      page([entry("child", 3, "root"), entry("grandchild", 4, "child")]),
      page([entry("root", 1), entry("sibling", 2)]),
    ]);

    const updated = removeTimelineCommentTree(current, "root")!;
    expect(timelineEntries(updated).map((item) => item.id)).toEqual(["sibling"]);
  });

  it("merges a refreshed latest page without duplicates or lost loaded history", () => {
    const current = data([
      page([entry("c3", 3), entry("c4", 4)], { hasMore: true, cursor: "c3" }),
      page([entry("c1", 1), entry("c2", 2)], { hasMore: false }),
    ]);
    const refreshedC4 = { ...entry("c4", 4), content: "server edit" };
    const refreshed = page(
      [refreshedC4, entry("c5", 5)],
      { hasMore: true, cursor: "c4" },
    );

    const merged = mergeTimelineLatestPage(current, refreshed);
    expect(timelineEntries(merged).map((item) => item.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(timelineEntries(merged).find((item) => item.id === "c4")?.content).toBe("server edit");
    expect(new Set(timelineEntries(merged).map((item) => item.id)).size).toBe(5);
  });

  it("keeps loaded history stable when a reconnect slides the newest window", () => {
    const current = data([
      page([entry("c3", 3), entry("c4", 4)], { hasMore: true, cursor: "c3" }),
      page([entry("c1", 1), entry("c2", 2)], { hasMore: false }),
    ]);
    // Two entries were published while this client was disconnected, so the
    // refreshed window no longer reaches back to c3.
    const merged = mergeTimelineLatestPage(
      current,
      page([entry("c4", 4), entry("c5", 5), entry("c6", 6)], { hasMore: true, cursor: "c4" }),
    );

    expect(timelineEntries(merged).map((item) => item.id))
      .toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    // c3 stays in page zero. Virtuoso reads a shrinking page zero as a prepend
    // and would scroll a reader sitting in history.
    expect(merged.pages[0]!.entries.map((item) => item.id)).toEqual(["c3", "c4", "c5", "c6"]);
    expect(merged.pages[1]).toBe(current.pages[1]);
    expect(merged.pageParams).toEqual(current.pageParams);
  });

  it("restarts from the latest page when the refreshed window skips past loaded history", () => {
    const current = data([
      page([entry("c3", 3), entry("c4", 4)], { hasMore: true, cursor: "c3" }),
      page([entry("c1", 1), entry("c2", 2)], { hasMore: false }),
    ]);
    // More than a page landed while away: c5..c7 exist on the server but sit
    // between the loaded head and the refreshed window. Keeping both sides
    // would render a permanent hole, so history is dropped and re-fetched.
    const merged = mergeTimelineLatestPage(
      current,
      page([entry("c8", 8), entry("c9", 9)], { hasMore: true, cursor: "c8" }),
    );

    expect(timelineEntries(merged).map((item) => item.id)).toEqual(["c8", "c9"]);
    expect(merged.pages).toHaveLength(1);
  });

  it("adopts the refreshed cursor when deletions widen the newest window", () => {
    const current = data([
      page([entry("c3", 3), entry("c4", 4)], { hasMore: true, cursor: "c3" }),
    ]);
    // c3 was deleted, so the same-sized window now reaches back to c2.
    const merged = mergeTimelineLatestPage(
      current,
      page([entry("c2", 2), entry("c4", 4)], { hasMore: true, cursor: "c2" }),
    );

    expect(timelineEntries(merged).map((item) => item.id)).toEqual(["c2", "c4"]);
    expect(merged.pages[0]!.next_cursor).toBe("c2");
  });

  it("treats a short latest page as authoritative for reconnect deletions", () => {
    const current = data([
      page([entry("c3", 3), entry("c4", 4)], { hasMore: true }),
      page([entry("c1", 1), entry("c2", 2)]),
    ]);
    const merged = mergeTimelineLatestPage(current, page([entry("c4", 4)]));

    expect(timelineEntries(merged).map((item) => item.id)).toEqual(["c4"]);
    expect(merged.pages).toHaveLength(1);
  });

  it("tracks dirty generations separately from the infinite query cache", () => {
    const qc = new QueryClient();
    const timeline = data([page([entry("c1", 1)])]);
    qc.setQueryData(["issues", "timeline", "issue-1", "session-1"], timeline);

    expect(markIssueTimelineDirty(qc, "issue-1")).toBe(1);
    expect(markIssueTimelineDirty(qc, "issue-1")).toBe(2);
    expect(isIssueTimelineDirty(qc, "issue-1", "session-1")).toBe(true);
    expect(qc.getQueryData(["issues", "timeline", "issue-1", "session-1"])).toBe(timeline);

    qc.setQueryData(["issues", "timeline-sync", "issue-1", "session-1"], 2);
    expect(isIssueTimelineDirty(qc, "issue-1", "session-1")).toBe(false);
    qc.clear();
  });

  it("refreshes pre-mount cached history from a primer without overwriting a newer request", () => {
    const qc = new QueryClient();
    const queryKey = ["issues", "timeline", "issue-1", "session-1"];
    const cached = data([
      page([entry("c3", 3), entry("c4", 4)], { hasMore: true, cursor: "c3" }),
      page([entry("c1", 1), entry("c2", 2)]),
    ]);
    qc.setQueryData(queryKey, cached);

    seedIssueTimelinePage(
      qc,
      "issue-1",
      page([entry("c4", 4), entry("c5", 5)], { hasMore: true, cursor: "c4" }),
      Date.now() + 1,
    );
    expect(timelineEntries(qc.getQueryData<IssueTimelineData>(queryKey)).map((item) => item.id))
      .toEqual(["c1", "c2", "c3", "c4", "c5"]);

    const newer = data([page([entry("c5", 5), entry("c6", 6)])]);
    const newerRequestStartedAt = Date.now();
    qc.setQueryData(queryKey, newer);
    const storedNewer = qc.getQueryData(queryKey);
    seedIssueTimelinePage(
      qc,
      "issue-1",
      page([entry("c4", 4), entry("c5", 5)]),
      newerRequestStartedAt,
    );
    expect(qc.getQueryData(queryKey)).toBe(storedNewer);
    qc.clear();
  });
});
