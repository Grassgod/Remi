import type { InboxItem } from "../types";
import { isInboxLedgerType } from "@multiremi/contracts";

export type InboxSourceFilter = "all" | "automation" | "mentions" | "assignments";
export type InboxDateGroup = "today" | "yesterday" | "this_week" | "earlier";

export interface InboxItemGroup {
  key: InboxDateGroup;
  items: InboxItem[];
}

export type InboxItemSelectionKind = "item" | "issue";

const MENTION_TYPES = new Set(["comment_mention", "mentioned"]);
const ASSIGNMENT_TYPES = new Set(["issue_assigned", "unassigned", "assignee_changed"]);

export function inboxItemSelectionKey(item: InboxItem): string {
  return inboxItemSelectionKind(item) === "item" ? item.id : item.issue_id ?? item.id;
}

// Selecting by issue id is only safe when the row actually has one. Ledger
// rows never do by design, and issue-less types such as quick_create_failed
// render a self-contained detail too — both must select by inbox-row id so the
// URL never claims an inbox id is an issue id.
export function inboxItemSelectionKind(item: InboxItem): InboxItemSelectionKind {
  return isInboxLedgerType(item.type) || !item.issue_id ? "item" : "issue";
}

/**
 * Preserve ledger events as individual rows while retaining the existing
 * Linear-style issue grouping for actionable notifications.
 */
export function deduplicateInboxItems(items: InboxItem[]): InboxItem[] {
  const active = items.filter((item) => !item.archived);
  const groups = new Map<string, InboxItem[]>();
  for (const item of active) {
    const key = inboxItemSelectionKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const visible: InboxItem[] = [];
  for (const group of groups.values()) {
    group.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    if (group[0]) visible.push(group[0]);
  }
  return visible.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export function filterInboxItemsBySource(
  items: InboxItem[],
  source: InboxSourceFilter,
): InboxItem[] {
  if (source === "all") return items;
  if (source === "automation") return items.filter((item) => item.type.startsWith("autopilot_"));
  if (source === "mentions") return items.filter((item) => MENTION_TYPES.has(item.type));
  return items.filter((item) => ASSIGNMENT_TYPES.has(item.type));
}

export function groupInboxItemsByDate(items: InboxItem[], now = new Date()): InboxItemGroup[] {
  const startToday = startOfDay(now);
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startYesterday.getDate() - 1);
  const startWeek = new Date(startToday);
  const daySinceMonday = (startWeek.getDay() + 6) % 7;
  startWeek.setDate(startWeek.getDate() - daySinceMonday);

  const grouped: Record<InboxDateGroup, InboxItem[]> = {
    today: [],
    yesterday: [],
    this_week: [],
    earlier: [],
  };
  for (const item of items) {
    const createdAt = new Date(item.created_at);
    const group = createdAt >= startToday
      ? "today"
      : createdAt >= startYesterday
        ? "yesterday"
        : createdAt >= startWeek
          ? "this_week"
          : "earlier";
    grouped[group].push(item);
  }

  return (["today", "yesterday", "this_week", "earlier"] as const)
    .map((key) => ({ key, items: grouped[key] }))
    .filter((group) => group.items.length > 0);
}

export function countAttentionUnreadInboxItems(items: InboxItem[]): number {
  return deduplicateInboxItems(items).filter((item) =>
    !item.read
    && (item.severity === "attention" || item.severity === "action_required")
  ).length;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
