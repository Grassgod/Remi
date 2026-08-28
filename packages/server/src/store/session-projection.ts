import type {
  MultiremiSessionEvent,
  MultiremiSessionProjection,
  MultiremiSessionProjectionMode,
} from "@multiremi/contracts/types.js";
import { estimateProjectionTokens } from "@multiremi/store/session-projection-budget.js";

const DEFAULT_EVENT_BODY_MAX_CHARS = 4_000;
const ELISION_NOTE = "Earlier session events omitted to fit the projection token budget.";

export interface BuildSessionProjectionInput {
  sessionId: string;
  targetAgentId: string;
  events: MultiremiSessionEvent[];
  cursorSeq: number;
  providerSessionId: string | null;
  tokenBudget: number;
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

  const header = {
    type: "session_projection",
    version: 1,
    mode,
    session_id: input.sessionId,
    target_agent_id: input.targetAgentId,
    from_seq: fromSeq,
    to_seq: toSeq,
  };
  const tokenBudget = Math.floor(Number(input.tokenBudget));
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new Error("Session projection tokenBudget must be a positive number");
  }
  const eventBodyMaxChars = projectionEventBodyMaxChars();
  const full = assembleProjection(
    header,
    projected,
    input,
    new Set(projected.map((_, index) => index)),
    eventBodyMaxChars,
  );
  if (full.estimatedTokens <= tokenBudget) {
    return projectionResult(input, mode, fromSeq, toSeq, full);
  }

  const pinned = new Set<number>();
  projected.forEach((event, index) => {
    if (event.kind === "result_published") pinned.add(index);
  });
  if (projected.length > 0) pinned.add(projected.length - 1);

  const recentCandidates = projected
    .map((_, index) => index)
    .filter((index) => !pinned.has(index));
  let recentCount = recentCandidates.length;
  let assembled = full;
  while (assembled.estimatedTokens > tokenBudget && recentCount > 0) {
    recentCount = Math.floor(recentCount / 2);
    const selected = new Set(pinned);
    const recent = recentCount > 0 ? recentCandidates.slice(-recentCount) : [];
    for (const index of recent) selected.add(index);
    assembled = assembleProjection(header, projected, input, selected, eventBodyMaxChars);
  }

  if (assembled.estimatedTokens > tokenBudget) {
    let lower = 0;
    let upper = eventBodyMaxChars;
    let fitting: AssembledProjection | null = null;
    while (lower <= upper) {
      const bodyLimit = Math.floor((lower + upper) / 2);
      const candidate = assembleProjection(header, projected, input, pinned, bodyLimit);
      if (candidate.estimatedTokens <= tokenBudget) {
        fitting = candidate;
        lower = bodyLimit + 1;
      } else {
        upper = bodyLimit - 1;
      }
    }
    assembled = fitting ?? assembleProjection(header, projected, input, pinned, 0);
  }

  if (assembled.estimatedTokens > tokenBudget) {
    throw new Error(
      `Session projection minimum envelope exceeds token budget (${assembled.estimatedTokens} > ${tokenBudget})`,
    );
  }

  return projectionResult(input, mode, fromSeq, toSeq, assembled);
}

interface AssembledProjection {
  jsonl: string;
  truncated: boolean;
  omittedEvents: number;
  estimatedTokens: number;
}

function assembleProjection(
  header: Record<string, unknown>,
  events: MultiremiSessionEvent[],
  input: BuildSessionProjectionInput,
  selected: Set<number>,
  bodyLimit: number,
): AssembledProjection {
  const lines: unknown[] = [header];
  let omittedEvents = 0;
  let bodyTruncated = false;
  let index = 0;
  while (index < events.length) {
    if (selected.has(index)) {
      const rendered = renderEvent(events[index]!, input, bodyLimit);
      lines.push(rendered.line);
      bodyTruncated ||= rendered.bodyTruncated;
      index += 1;
      continue;
    }

    const start = index;
    let omittedChars = 0;
    while (index < events.length && !selected.has(index)) {
      omittedChars += JSON.stringify(renderEvent(events[index]!, input, Number.MAX_SAFE_INTEGER).line).length;
      index += 1;
    }
    const omitted = events.slice(start, index);
    omittedEvents += omitted.length;
    lines.push({
      type: "session_elision",
      omitted_events: omitted.length,
      from_seq: omitted[0]!.seq,
      to_seq: omitted.at(-1)!.seq,
      omitted_chars: omittedChars,
      note: ELISION_NOTE,
    });
  }
  const jsonl = lines.map((line) => JSON.stringify(line)).join("\n");
  return {
    jsonl,
    truncated: bodyTruncated || omittedEvents > 0,
    omittedEvents,
    estimatedTokens: estimateProjectionTokens(jsonl),
  };
}

function renderEvent(
  event: MultiremiSessionEvent,
  input: BuildSessionProjectionInput,
  bodyLimit: number,
): { line: Record<string, unknown>; bodyTruncated: boolean } {
  const body = event.body.slice(0, Math.max(0, bodyLimit));
  const bodyTruncated = body.length < event.body.length;
  const line: Record<string, unknown> = {
    type: "session_event",
    seq: event.seq,
    kind: event.kind,
    perspective: eventPerspective(event, input.targetAgentId),
    author_type: event.authorType,
    author_id: event.authorId,
    author_name: input.resolveAuthorName?.(event.authorType, event.authorId) ?? null,
    body,
  };
  if (bodyTruncated) {
    line.body_truncated = true;
    line.body_omitted_chars = event.body.length - body.length;
  }
  line.task_id = event.taskId;
  line.source_comment_id = event.sourceCommentId;
  line.metadata = stableJsonValue(event.metadata);
  line.created_at = event.createdAt;
  return { line, bodyTruncated };
}

function projectionResult(
  input: BuildSessionProjectionInput,
  mode: MultiremiSessionProjectionMode,
  fromSeq: number,
  toSeq: number,
  assembled: AssembledProjection,
): MultiremiSessionProjection {
  return {
    sessionId: input.sessionId,
    targetAgentId: input.targetAgentId,
    mode,
    fromSeq,
    toSeq,
    jsonl: assembled.jsonl,
    truncated: assembled.truncated,
    omittedEvents: assembled.omittedEvents,
    estimatedTokens: assembled.estimatedTokens,
  };
}

function projectionEventBodyMaxChars(): number {
  const configured = Number(process.env.MULTIREMI_SESSION_PROJECTION_EVENT_BODY_MAX_CHARS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_EVENT_BODY_MAX_CHARS;
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
