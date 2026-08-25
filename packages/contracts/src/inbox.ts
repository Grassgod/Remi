export type InboxRoute = "inbox_action" | "inbox_ledger" | "workbench_only" | "activity_only";
export type RegisteredInboxRoute = InboxRoute | "by_issue_status";

export const INBOX_ROUTE_BY_TYPE = {
  issue_assigned: "inbox_action",
  comment_mention: "inbox_action",
  comment_created: "by_issue_status",
  autopilot_paused: "inbox_ledger",
  autopilot_run_completed: "inbox_ledger",
  autopilot_run_failed: "inbox_ledger",
  autopilot_run_overdue: "inbox_ledger",
} as const satisfies Record<string, RegisteredInboxRoute>;

export type RegisteredInboxType = keyof typeof INBOX_ROUTE_BY_TYPE;

const INBOX_LEDGER_TYPE_SET: ReadonlySet<string> = new Set(
  Object.entries(INBOX_ROUTE_BY_TYPE)
    .filter(([, route]) => route === "inbox_ledger")
    .map(([type]) => type),
);

export function isInboxLedgerType(type: string): boolean {
  return INBOX_LEDGER_TYPE_SET.has(type);
}
