import type {
  MultiremiSessionEvent,
  MultiremiSessionProjection,
  MultiremiSessionProjectionMode,
} from "@multiremi/contracts/types.js";

export interface BuildSessionProjectionInput {
  sessionId: string;
  targetAgentId: string;
  events: MultiremiSessionEvent[];
  cursorSeq: number;
  providerSessionId: string | null;
  /** The current request is rendered in its own prompt section, not replayed as history. */
  currentTaskId?: string | null;
  resolveAuthorName?: (authorType: string, authorId: string | null) => string | null;
}

/**
 * Project one canonical multi-author event log into a deterministic,
 * single-assistant transcript envelope.
 *
 * ACP accepts one user turn rather than an arbitrary message array, so the
 * role mapping is represented as stable JSONL. On a cold lane the complete log
 * is sent. On a warm lane only events after the provider lineage's cursor are
 * sent; the target agent's own historical messages are omitted because they
 * already exist as assistant turns inside that provider session.
 */
export function buildSessionProjection(input: BuildSessionProjectionInput): MultiremiSessionProjection {
  const sorted = [...input.events].sort((left, right) => left.seq - right.seq);
  const toSeq = sorted.at(-1)?.seq ?? 0;
  const warm = Boolean(input.providerSessionId) && input.cursorSeq > 0;
  const mode: MultiremiSessionProjectionMode = warm ? "delta" : "bootstrap";
  const fromSeq = warm ? input.cursorSeq : 0;
  const projected = sorted.filter((event) => {
    if (event.seq <= fromSeq) return false;
    if (input.currentTaskId && event.kind === "task_assigned" && event.taskId === input.currentTaskId) {
      return false;
    }
    if (mode === "delta" && event.authorType === "agent" && event.authorId === input.targetAgentId) {
      return false;
    }
    return true;
  });

  const lines: unknown[] = [{
    type: "session_projection",
    version: 1,
    mode,
    session_id: input.sessionId,
    target_agent_id: input.targetAgentId,
    from_seq: fromSeq,
    to_seq: toSeq,
  }];
  for (const event of projected) {
    lines.push({
      type: "session_event",
      seq: event.seq,
      kind: event.kind,
      perspective: eventPerspective(event, input.targetAgentId),
      author_type: event.authorType,
      author_id: event.authorId,
      author_name: input.resolveAuthorName?.(event.authorType, event.authorId) ?? null,
      body: event.body,
      task_id: event.taskId,
      source_comment_id: event.sourceCommentId,
      metadata: stableJsonValue(event.metadata),
      created_at: event.createdAt,
    });
  }

  return {
    sessionId: input.sessionId,
    targetAgentId: input.targetAgentId,
    mode,
    fromSeq,
    toSeq,
    jsonl: lines.map((line) => JSON.stringify(line)).join("\n"),
  };
}

function eventPerspective(
  event: MultiremiSessionEvent,
  targetAgentId: string,
): "assistant_history" | "external_agent" | "user" | "operator" {
  if (event.authorType === "agent") {
    return event.authorId === targetAgentId ? "assistant_history" : "external_agent";
  }
  if (event.authorType === "system") return "operator";
  return "user";
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = stableJsonValue(record[key]);
  return sorted;
}
