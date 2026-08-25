export type InboxRoute = "inbox_action" | "inbox_ledger" | "workbench_only" | "activity_only";

export const WORKBENCH_VISIBLE_STATUSES = ["in_review", "blocked", "in_progress"] as const;

interface InboxRoutingEntry {
  rule: "R1" | "R2" | "R3";
  route: InboxRoute | "by_issue_status";
  severity: "info" | "attention";
  why: string;
}

export const INBOX_ROUTING: Record<string, InboxRoutingEntry> = {
  issue_assigned: {
    rule: "R1",
    route: "inbox_action",
    severity: "info",
    why: "A member was personally assigned work that may not be visible in the workbench.",
  },
  comment_mention: {
    rule: "R1",
    route: "inbox_action",
    severity: "info",
    why: "A comment explicitly addressed a member and cannot be represented at issue grain.",
  },
  comment_created: {
    rule: "R2",
    route: "by_issue_status",
    severity: "info",
    why: "Issue progress belongs only in the workbench while visible there; otherwise only human comments notify subscribers.",
  },
  autopilot_paused: {
    rule: "R3",
    route: "inbox_ledger",
    severity: "attention",
    why: "An automated workflow was paused and must remain available for periodic review.",
  },
  autopilot_run_completed: {
    rule: "R3",
    route: "inbox_ledger",
    severity: "info",
    why: "A completed automated run is a durable result, not a human processing queue item.",
  },
  autopilot_run_failed: {
    rule: "R3",
    route: "inbox_ledger",
    severity: "attention",
    why: "A failed automated run is a durable result that deserves periodic attention.",
  },
  autopilot_run_overdue: {
    rule: "R3",
    route: "inbox_ledger",
    severity: "attention",
    why: "An overdue automated run is a durable inspection result; its producer is implemented separately.",
  },
};

export function inboxRouteFor(
  type: string,
  ctx: { issueStatus?: string | null; actorType?: string } = {},
): InboxRoute {
  const entry = INBOX_ROUTING[type];
  if (!entry) return "activity_only";
  if (entry.route !== "by_issue_status") return entry.route;

  if (WORKBENCH_VISIBLE_STATUSES.some((status) => status === ctx.issueStatus)) {
    return "workbench_only";
  }
  return ctx.actorType === "member" ? "inbox_action" : "activity_only";
}
