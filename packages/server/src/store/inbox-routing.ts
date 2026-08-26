import {
  INBOX_ROUTE_BY_TYPE,
  type InboxRoute,
  type RegisteredInboxRoute,
} from "@multiremi/contracts";

export type { InboxRoute } from "@multiremi/contracts";

export const WORKBENCH_VISIBLE_STATUSES = ["in_review", "blocked", "in_progress"] as const;

interface InboxRoutingEntry {
  rule: "R1" | "R2" | "R3";
  route: RegisteredInboxRoute;
  severity: "info" | "attention";
  why: string;
}

export const INBOX_ROUTING: Record<string, InboxRoutingEntry> = {
  issue_assigned: {
    rule: "R1",
    route: INBOX_ROUTE_BY_TYPE.issue_assigned,
    severity: "info",
    why: "A member was personally assigned work that may not be visible in the workbench.",
  },
  comment_mention: {
    rule: "R1",
    route: INBOX_ROUTE_BY_TYPE.comment_mention,
    severity: "info",
    why: "A comment explicitly addressed a member and cannot be represented at issue grain.",
  },
  comment_created: {
    rule: "R2",
    route: INBOX_ROUTE_BY_TYPE.comment_created,
    severity: "info",
    why: "Issue progress belongs only in the workbench while visible there; otherwise only human comments notify subscribers.",
  },
  feishu_message_notification: {
    rule: "R1",
    route: INBOX_ROUTE_BY_TYPE.feishu_message_notification,
    severity: "info",
    why: "A Feishu message reminder is a personal action surfaced outside the workbench.",
  },
  feishu_reply_draft: {
    rule: "R1",
    route: INBOX_ROUTE_BY_TYPE.feishu_reply_draft,
    severity: "attention",
    why: "A reply draft requires a human to review it and send from Feishu.",
  },
  feishu_issue_proposal: {
    rule: "R1",
    route: INBOX_ROUTE_BY_TYPE.feishu_issue_proposal,
    severity: "attention",
    why: "An Issue proposal requires an explicit human approval or rejection.",
  },
  feishu_ingest_connection_alert: {
    rule: "R3",
    route: INBOX_ROUTE_BY_TYPE.feishu_ingest_connection_alert,
    severity: "attention",
    why: "A deduplicated ingestion health failure must remain visible until recovery.",
  },
  autopilot_paused: {
    rule: "R3",
    route: INBOX_ROUTE_BY_TYPE.autopilot_paused,
    severity: "attention",
    why: "An automated workflow was paused and must remain available for periodic review.",
  },
  autopilot_run_completed: {
    rule: "R3",
    route: INBOX_ROUTE_BY_TYPE.autopilot_run_completed,
    severity: "info",
    why: "A completed automated run is a durable result, not a human processing queue item.",
  },
  autopilot_run_failed: {
    rule: "R3",
    route: INBOX_ROUTE_BY_TYPE.autopilot_run_failed,
    severity: "attention",
    why: "A failed automated run is a durable result that deserves periodic attention.",
  },
  autopilot_run_overdue: {
    rule: "R3",
    route: INBOX_ROUTE_BY_TYPE.autopilot_run_overdue,
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
