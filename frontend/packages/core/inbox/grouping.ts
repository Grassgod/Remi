import type { InboxItem } from "../types";

export type InboxSourceFilter = "all" | "automation" | "mentions" | "assignments";
export type InboxDateGroup = "today" | "yesterday" | "this_week" | "earlier";

export interface InboxItemGroup {
  key: InboxDateGroup;
  items: InboxItem[];
}

const MENTION_TYPES = new Set(["comment_mention", "mentioned"]);
const ASSIGNMENT_TYPES = new Set(["issue_assigned", "unassigned", "assignee_changed"]);

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
  return items.filter((item) =>
    !item.archived
    && !item.read
    && (item.severity === "attention" || item.severity === "action_required")
  ).length;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
