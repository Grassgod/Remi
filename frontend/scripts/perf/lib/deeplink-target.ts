/**
 * Deep-link target selection: which inbox notification the probe measures.
 *
 * Extracted from `page-speed.ts` so the ranking rules are unit-testable without a
 * browser, and so the third review round's "prefer unread" rule (MUL-384
 * `cmt_5857w2m9uiyi`) sits next to the code that applies it.
 */

// Deep import, not the package barrel: grouping.ts does the same, and the barrel
// pulls in NodeNext-specified protocol modules the probe has no use for.
import { isInboxLedgerType } from "@multiremi/contracts/inbox";

/** Inbox notification types that render `AutopilotRunReport` instead of a timeline. */
export const AUTOPILOT_INBOX_TYPES = ["autopilot_run", "autopilot_run_report", "autopilot"];

/**
 * Whether selecting this notification would win `?issue=<issueId>`.
 *
 * `inboxItemSelectionKind` sends ledger rows (autopilot runs, organizer actions) to
 * `?item=<id>` instead, so they never compete for an `?issue=` selection. Only rows
 * that resolve by issue can supersede the probe's chosen target.
 */
export function selectsByIssue(item: InboxCandidateInput): boolean {
  const type = String(item.type ?? "");
  return Boolean(item.issue_id) && !isInboxLedgerType(type);
}

/** The subset of an `/api/inbox/page` row this module reads. */
export interface InboxCandidateInput {
  id?: string;
  issue_id?: string | null;
  type?: string;
  read?: boolean;
  archived?: boolean;
  details?: { comment_id?: string | null; issue_session_id?: string | null } | null;
}

export interface DeepLinkCandidate {
  inboxItemId: string;
  commentId: string;
  sessionId: string;
  issueId: string;
  /** An issue with a running task can append comments inside the quiet window. */
  issueHasRunningTask: boolean;
  /** Read state of this notification, reported as `targetRead`. */
  read: boolean;
  /** True when any notification sharing this issue's rendered row is unread. */
  groupHasUnread: boolean;
  /** Position in the `/api/inbox/page` array; reported, never clicked. */
  apiIndex: number;
  type: string;
}

/**
 * One candidate per issue, newest first, with quiet and unread targets preferred.
 *
 * Ranking, in order:
 *  1. an issue with no running task, because a running one can append a comment
 *     inside the quiet window and that reads as a jump;
 *  2. a row that has an unread notification. Selecting one exercises the path a
 *     user almost always takes (unread inbox), and after the write guard gained an
 *     allow-list the probe can complete it. A read target skips the auto
 *     mark-read round trip entirely, so it measures a rarer path;
 *  3. API order, which is newest-first.
 */
export function rankDeepLinkCandidates(
  firstPage: readonly InboxCandidateInput[],
  runningIssueIds: ReadonlySet<string>,
): DeepLinkCandidate[] {
  const newestPerIssue = new Map<string, DeepLinkCandidate>();
  const unreadByIssue = collectUnreadByIssue(firstPage);
  firstPage.forEach((item, index) => {
    const candidate = toDeepLinkCandidate(item, item.id ?? "", index, runningIssueIds, unreadByIssue);
    if (!candidate) return;
    // The API is newest-first, so the first row for an issue is its newest.
    if (!newestPerIssue.has(candidate.issueId)) newestPerIssue.set(candidate.issueId, candidate);
  });
  return [...newestPerIssue.values()].sort((a, b) => {
    if (a.issueHasRunningTask !== b.issueHasRunningTask) return a.issueHasRunningTask ? 1 : -1;
    if (a.groupHasUnread !== b.groupHasUnread) return a.groupHasUnread ? -1 : 1;
    return a.apiIndex - b.apiIndex;
  });
}

/**
 * Which notifications share a rendered row with `item`.
 *
 * `inboxItemSelectionKind` sends every notification carrying an `issue_id` to
 * `?issue=<issueId>`, and `deduplicateInboxItems` keeps one row per selection key,
 * so every notification for one issue lands on the same row. The auto mark-read
 * effect marks the whole row (`selectedEntry.items`), which is why "does selecting
 * this trigger a write" is a property of the issue rather than of one item.
 */
export function toDeepLinkCandidate(
  item: InboxCandidateInput,
  inboxItemId: string,
  apiIndex: number,
  runningIssueIds: ReadonlySet<string>,
  unreadByIssue: ReadonlyMap<string, number> = new Map(),
): DeepLinkCandidate | null {
  if (!inboxItemId) return null;
  const type = String(item.type ?? "");
  if (AUTOPILOT_INBOX_TYPES.some((candidate) => type === candidate || type.startsWith(`${candidate}_`))) return null;
  const commentId = item.details?.comment_id ?? null;
  const sessionId = item.details?.issue_session_id ?? null;
  const issueId = item.issue_id ?? null;
  if (!commentId || !sessionId || !issueId) return null;
  const read = item.read === true;
  const unreadInRow = unreadByIssue.get(issueId);
  return {
    inboxItemId,
    commentId,
    sessionId,
    issueId,
    issueHasRunningTask: runningIssueIds.has(issueId),
    read,
    // With no group data (a direct call from a test) fall back to this item.
    groupHasUnread: unreadInRow === undefined ? !read : unreadInRow > 0,
    apiIndex,
    type,
  };
}

/** Unread notification count per issue, over one inbox page. */
export function collectUnreadByIssue(firstPage: readonly InboxCandidateInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of firstPage) {
    const issueId = item.issue_id ?? null;
    if (!issueId || item.read === true) continue;
    counts.set(issueId, (counts.get(issueId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Unread notification ids in the target's rendered row.
 *
 * This is the auto mark-read effect's working set (`selectedEntry.items.filter(!
 * read)`), so it is also the stub self-check's denominator: one stubbed POST per
 * id is expected, and `2 x` allows one retry each.
 */
export function unreadIdsInRow(
  firstPage: readonly InboxCandidateInput[],
  issueId: string,
): string[] {
  return firstPage
    .filter((item) => item.issue_id === issueId && item.read !== true)
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}
