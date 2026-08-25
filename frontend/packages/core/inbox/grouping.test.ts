import { describe, expect, it } from "vitest";
import type { InboxItem, InboxItemType, InboxSeverity } from "../types";
import {
  countAttentionUnreadInboxItems,
  filterInboxItemsBySource,
  groupInboxItemsByDate,
} from "./grouping";

function item(
  id: string,
  type: InboxItemType,
  createdAt: string,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id,
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "mem-1",
    actor_type: "system",
    actor_id: null,
    type,
    severity: "info",
    issue_id: null,
    title: id,
    body: null,
    issue_status: null,
    read: false,
    archived: false,
    created_at: createdAt,
    details: null,
    ...overrides,
  };
}

describe("inbox grouping", () => {
  it("groups rows into periodic review date buckets", () => {
    const now = new Date(2026, 7, 26, 12, 0, 0);
    const items = [
      item("today", "autopilot_run_completed", new Date(2026, 7, 26, 8).toISOString()),
      item("yesterday", "comment_mention", new Date(2026, 7, 25, 8).toISOString()),
      item("week", "issue_assigned", new Date(2026, 7, 24, 8).toISOString()),
      item("earlier", "comment_created", new Date(2026, 7, 23, 8).toISOString()),
    ];

    expect(groupInboxItemsByDate(items, now).map((group) => [group.key, group.items[0]?.id]))
      .toEqual([
        ["today", "today"],
        ["yesterday", "yesterday"],
        ["this_week", "week"],
        ["earlier", "earlier"],
      ]);
  });

  it("filters the ledger by automation, mentions, and assignments", () => {
    const at = new Date().toISOString();
    const items = [
      item("automation", "autopilot_run_failed", at),
      item("mention", "comment_mention", at),
      item("assignment", "issue_assigned", at),
      item("comment", "comment_created", at),
    ];

    expect(filterInboxItemsBySource(items, "automation").map((entry) => entry.id)).toEqual(["automation"]);
    expect(filterInboxItemsBySource(items, "mentions").map((entry) => entry.id)).toEqual(["mention"]);
    expect(filterInboxItemsBySource(items, "assignments").map((entry) => entry.id)).toEqual(["assignment"]);
    expect(filterInboxItemsBySource(items, "all")).toEqual(items);
  });

  it("counts only unread, unarchived attention-or-higher rows for badges", () => {
    const at = new Date().toISOString();
    const withSeverity = (
      id: string,
      severity: InboxSeverity,
      overrides: Partial<InboxItem> = {},
    ) => item(id, "autopilot_run_failed", at, { severity, ...overrides });
    const items = [
      withSeverity("info", "info"),
      withSeverity("attention", "attention"),
      withSeverity("action", "action_required"),
      withSeverity("read", "attention", { read: true }),
      withSeverity("archived", "attention", { archived: true }),
    ];

    expect(countAttentionUnreadInboxItems(items)).toBe(2);
  });
});
