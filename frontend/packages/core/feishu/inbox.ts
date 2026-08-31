import type { InboxItem } from "../types";

/** The inbox rows the ingestion pipeline writes. Kept in sync with
 *  `INBOX_ROUTE_BY_TYPE` in `@multiremi/contracts/inbox` — the server routes
 *  the first three as `inbox_action` (they carry buttons) and the alert as
 *  `inbox_ledger` (it is a one-line event). */
export const FEISHU_INBOX_TYPES = [
  "feishu_message_notification",
  "feishu_reply_draft",
  "feishu_issue_proposal",
  "feishu_ingest_connection_alert",
] as const;

export type FeishuInboxType = (typeof FEISHU_INBOX_TYPES)[number];

const FEISHU_INBOX_TYPE_SET: ReadonlySet<string> = new Set(FEISHU_INBOX_TYPES);

export function isFeishuInboxType(type: string): type is FeishuInboxType {
  return FEISHU_INBOX_TYPE_SET.has(type);
}

/** Everything the inbox needs to act on a Feishu row, pulled out of the
 *  untyped `details` bag. `InboxItem.details` is declared as a string map but
 *  the server also puts an object (`proposed_issue`) and a number
 *  (`consecutive_failures`) in there, so every read goes through `unknown`. */
export interface FeishuInboxContext {
  kind: FeishuInboxType;
  messageId: string | null;
  sourceId: string | null;
  chatId: string | null;
  chatName: string | null;
  /** Only ever an `https:` URL — see `safeFeishuAppLink`. */
  appLink: string | null;
  proposalId: string | null;
  proposedTitle: string | null;
  sourceName: string | null;
  errorCode: string | null;
  consecutiveFailures: number | null;
}

function detailValue(item: InboxItem, key: string): unknown {
  const details: unknown = item.details;
  if (typeof details !== "object" || details === null) return undefined;
  return (details as Record<string, unknown>)[key];
}

function detailString(item: InboxItem, key: string): string | null {
  const value = detailValue(item, key);
  return typeof value === "string" && value !== "" ? value : null;
}

function detailCount(item: InboxItem, key: string): number | null {
  const value = detailValue(item, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // SQLite round-trips and JSON transports both hand back numeric strings.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * The message link is copied verbatim out of the Feishu payload during
 * ingestion, so it is attacker-influenced text that we are about to put in an
 * `href`. Anything that is not an absolute `https:` URL is dropped rather than
 * rendered, which closes `javascript:` and `data:` injection.
 */
export function safeFeishuAppLink(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? parsed.href : null;
}

function proposedIssueTitle(item: InboxItem): string | null {
  const proposed = detailValue(item, "proposed_issue");
  if (typeof proposed === "object" && proposed !== null) {
    const title = (proposed as Record<string, unknown>).title;
    if (typeof title === "string" && title !== "") return title;
  }
  // The proposal row also carries the proposed title as its body, so a server
  // that stops nesting `proposed_issue` still renders something meaningful.
  return item.body !== null && item.body !== "" ? item.body : null;
}

export function feishuInboxContext(item: InboxItem): FeishuInboxContext | null {
  if (!isFeishuInboxType(item.type)) return null;
  return {
    kind: item.type,
    messageId: detailString(item, "message_id"),
    sourceId: detailString(item, "source_id"),
    chatId: detailString(item, "chat_id"),
    chatName: detailString(item, "chat_name"),
    appLink: safeFeishuAppLink(detailString(item, "message_app_link")),
    proposalId: detailString(item, "proposal_id"),
    proposedTitle: item.type === "feishu_issue_proposal" ? proposedIssueTitle(item) : null,
    sourceName: detailString(item, "source_name"),
    errorCode: detailString(item, "error_code"),
    consecutiveFailures: detailCount(item, "consecutive_failures"),
  };
}

/**
 * Where the row came from, for the title line: the chat for an ingested
 * message, the source for a connection alert. The server writes `title` in one
 * hardcoded language and the proposal row's title ("建议创建 Issue") does not
 * name Feishu at all, so the inbox composes its own line from the localized
 * type label plus this — an ingested message is then always recognisable in a
 * mixed stream.
 */
export function feishuInboxOrigin(context: FeishuInboxContext): string | null {
  if (context.kind === "feishu_ingest_connection_alert") return context.sourceName;
  return context.chatName;
}

/** Which buttons a row gets. The connection alert is a ledger row with nothing
 *  to decide, and any row that lost its `message_id` can only be archived. */
export interface FeishuInboxActionSet {
  canApprove: boolean;
  canReject: boolean;
  canIgnore: boolean;
  canMarkProcessed: boolean;
}

export function feishuInboxActions(context: FeishuInboxContext): FeishuInboxActionSet {
  const hasMessage = context.messageId !== null;
  const isProposal = context.kind === "feishu_issue_proposal" && context.proposalId !== null;
  return {
    canApprove: isProposal,
    canReject: isProposal,
    canIgnore: hasMessage && context.kind !== "feishu_ingest_connection_alert",
    canMarkProcessed: hasMessage && context.kind !== "feishu_ingest_connection_alert",
  };
}
