import { describe, expect, it } from "vitest";
import type { InboxItem, InboxItemType, InboxSeverity } from "../types";
import {
  countAttentionUnreadInboxItems,
  deduplicateInboxItems,
  filterInboxItemsBySource,
  groupInboxItemsByDate,
  inboxItemSelectionKey,
  inboxItemSelectionKind,
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

  it("gives every ingestion row its own tab and leaves automation to autopilot", () => {
    const at = new Date().toISOString();
    const items = [
      item("autopilot", "autopilot_run_failed", at),
      item("notification", "feishu_message_notification", at),
      item("proposal", "feishu_issue_proposal", at),
      item("draft", "feishu_reply_draft", at),
      item("alert", "feishu_ingest_connection_alert", at),
      item("comment", "comment_created", at),
    ];

    // The connection alert belongs with the messages: a reader whose stream
    // went quiet looks in this tab for the reason, not in automation.
    expect(filterInboxItemsBySource(items, "message_stream").map((entry) => entry.id)).toEqual([
      "notification",
      "proposal",
      "draft",
      "alert",
    ]);
    // Chat volume would otherwise bury the autopilot runs this tab is for.
    expect(filterInboxItemsBySource(items, "automation").map((entry) => entry.id)).toEqual([
      "autopilot",
    ]);
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

  it("keeps every ledger event while preserving issue-level action grouping", () => {
    const items = [
      item("mention-latest", "comment_mention", "2026-08-26T10:04:00.000Z", {
        issue_id: "issue-1",
        severity: "attention",
      }),
      item("assignment-hidden", "issue_assigned", "2026-08-26T10:03:00.000Z", {
        issue_id: "issue-1",
        severity: "attention",
      }),
      item("run-failed", "autopilot_run_failed", "2026-08-26T10:02:00.000Z", {
        issue_id: "issue-1",
        severity: "attention",
      }),
      item("run-completed", "autopilot_run_completed", "2026-08-26T10:01:00.000Z", {
        issue_id: "issue-1",
      }),
    ];

    const visible = deduplicateInboxItems(items);

    expect(visible.map((entry) => entry.id)).toEqual([
      "mention-latest",
      "run-failed",
      "run-completed",
    ]);
    expect(inboxItemSelectionKey(visible[0]!)).toBe("issue-1");
    expect(inboxItemSelectionKey(visible[1]!)).toBe("run-failed");
    expect(items.filter((entry) => entry.severity === "attention")).toHaveLength(3);
    expect(countAttentionUnreadInboxItems(items)).toBe(
      visible.filter((entry) => entry.severity === "attention" && !entry.read).length,
    );
  });

  it("selects issue-less rows by inbox id so no URL claims one is an issue id", () => {
    const legacy = item("legacy-failure", "quick_create_failed", "2026-08-26T10:00:00.000Z", {
      issue_id: null,
      severity: "attention",
    });
    const ledger = item("run-1", "autopilot_run_failed", "2026-08-26T10:00:00.000Z", {
      issue_id: "issue-1",
    });
    const action = item("mention-1", "comment_mention", "2026-08-26T10:00:00.000Z", {
      issue_id: "issue-1",
    });

    expect(inboxItemSelectionKind(legacy)).toBe("item");
    expect(inboxItemSelectionKey(legacy)).toBe("legacy-failure");
    expect(inboxItemSelectionKind(ledger)).toBe("item");
    expect(inboxItemSelectionKind(action)).toBe("issue");
    expect(inboxItemSelectionKey(action)).toBe("issue-1");
  });
});
