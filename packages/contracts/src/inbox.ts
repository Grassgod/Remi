export type InboxRoute = "inbox_action" | "inbox_ledger" | "workbench_only" | "activity_only";
export type RegisteredInboxRoute = InboxRoute | "by_issue_status";

export const INBOX_ROUTE_BY_TYPE = {
  issue_assigned: "inbox_action",
  comment_mention: "inbox_action",
  comment_created: "by_issue_status",
  feishu_message_notification: "inbox_action",
  feishu_reply_draft: "inbox_action",
  feishu_issue_proposal: "inbox_action",
  feishu_ingest_connection_alert: "inbox_ledger",
  autopilot_paused: "inbox_ledger",
  autopilot_run_completed: "inbox_ledger",
  autopilot_run_failed: "inbox_ledger",
  autopilot_run_overdue: "inbox_ledger",
  organizer_action: "inbox_ledger",
} as const satisfies Record<string, RegisteredInboxRoute>;

export type RegisteredInboxType = keyof typeof INBOX_ROUTE_BY_TYPE;

export type InboxLedgerType = {
  [Type in RegisteredInboxType]: (typeof INBOX_ROUTE_BY_TYPE)[Type] extends "inbox_ledger"
    ? Type
    : never;
}[RegisteredInboxType];

export const INBOX_LEDGER_TYPES: readonly InboxLedgerType[] = Object.freeze(
  Object.entries(INBOX_ROUTE_BY_TYPE)
    .filter(([, route]) => route === "inbox_ledger")
    .map(([type]) => type as InboxLedgerType),
);

const INBOX_LEDGER_TYPE_SET: ReadonlySet<string> = new Set(
  INBOX_LEDGER_TYPES,
);

export function isInboxLedgerType(type: string): boolean {
  return INBOX_LEDGER_TYPE_SET.has(type);
}
