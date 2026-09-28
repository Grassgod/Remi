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
  // MUL-400 E2: a child issue reached a terminal/parked state while the parent
  // is owned by a human, so the parent owner hears about it directly instead
  // of only through the parent's activity feed.
  child_issue_terminal: "inbox_action",
  // MUL-400 E3: a prerequisite of this issue failed or was cancelled, or all of
  // its prerequisites finished while the owner is a human. Either way the human
  // owns the next decision, so it belongs in the actionable inbox rather than
  // only in the issue activity feed.
  dependency_prerequisite_failed: "inbox_action",
  dependency_satisfied: "inbox_action",
  decision_requested: "inbox_action",
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

export type EnvelopeKind =
  | "request"
  | "reply"
  | "report"
  | "decision_needed"
  | "lifecycle"
  | "final";
export type EnvelopeWake = "now" | "next_turn" | "inbox_only";
export type EnvelopePriority = 1 | 2 | 3 | 4;

export type EnvelopeAddress =
  | { role: "issue_owner"; issueId: string }
  | { role: "parent_owner"; childIssueId: string }
  | { role: "delegator"; delegationId: string }
  | { role: "relay"; issueId: string }
  | { role: "agent"; agentId: string; issueSessionId: string }
  | { role: "chat"; chatSessionId: string; agentId: string };

export interface Envelope {
  to: EnvelopeAddress;
  kind: EnvelopeKind;
  wake: EnvelopeWake;
  dedupeKey?: string;
  replyTo?: string;
  grantRef?: string;
  body: string;
  outcome?: "done" | "failed" | "blocked" | "cancelled";
  source: { issueId?: string; taskId?: string; commentId?: string; decisionId?: string };
}

export interface EnvelopeMetadata {
  envelope: Omit<Envelope, "body" | "to"> & {
    to: EnvelopeAddress;
    priority: EnvelopePriority;
  };
}

export type EnvelopePriorityEntry = Pick<Envelope, "kind" | "wake" | "outcome"> & {
  /** Source author, before an envelope is persisted as a system log entry. */
  senderType?: string;
  /** Lifecycle event name when it is not represented by outcome. */
  lifecycleEvent?: string;
};

export function envelopePriority(entry: EnvelopePriorityEntry): EnvelopePriority {
  if (entry.wake === "inbox_only") return 4;
  if (entry.kind === "decision_needed" ||
    (entry.kind === "request" && entry.senderType === "member")) return 1;
  if (
    (entry.kind === "report" || entry.kind === "final") &&
    (entry.outcome === "failed" || entry.outcome === "blocked" || entry.outcome === "cancelled")
  ) return 2;
  if (
    entry.kind === "lifecycle" &&
    (entry.lifecycleEvent === "task_failed" || entry.lifecycleEvent === "task_cancelled")
  ) return 2;
  if (
    entry.kind === "report" || entry.kind === "final" ||
    entry.kind === "reply" || entry.kind === "request"
  ) return 3;
  return 4;
}
