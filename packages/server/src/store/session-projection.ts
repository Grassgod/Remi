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
  const headerJson = JSON.stringify(header);
  const prepared = prepareProjectionEvents(projected, input);
  const eventBodyMaxChars = projectionEventBodyMaxChars();
  const full = assembleProjection(
    headerJson,
    prepared,
    new Set(prepared.map((_, index) => index)),
    null,
  );
  if (full.estimatedTokens <= tokenBudget) {
    return projectionResult(input, mode, fromSeq, toSeq, full);
  }

  const pinned = new Set<number>();
  prepared.forEach(({ event }, index) => {
    if (event.kind === "result_published") pinned.add(index);
  });
  if (prepared.length > 0) pinned.add(prepared.length - 1);

  const recentCandidates = prepared
    .map((_, index) => index)
    .filter((index) => !pinned.has(index));
  let recentCount = recentCandidates.length;
  let assembled = full;
  while (assembled.estimatedTokens > tokenBudget && recentCount > 0) {
    recentCount = Math.floor(recentCount / 2);
    const selected = new Set(pinned);
    const recent = recentCount > 0 ? recentCandidates.slice(-recentCount) : [];
    for (const index of recent) selected.add(index);
    assembled = assembleProjection(headerJson, prepared, selected, null);
  }

  if (assembled.estimatedTokens > tokenBudget) {
    let lower = 0;
    let upper = eventBodyMaxChars;
    let fitting: AssembledProjection | null = null;
    while (lower <= upper) {
      const bodyLimit = Math.floor((lower + upper) / 2);
      const candidate = assembleProjection(headerJson, prepared, pinned, bodyLimit);
      if (candidate.estimatedTokens <= tokenBudget) {
        fitting = candidate;
        lower = bodyLimit + 1;
      } else {
        upper = bodyLimit - 1;
      }
    }
    assembled = fitting ?? assembleProjection(headerJson, prepared, pinned, 0);
  }

  if (assembled.estimatedTokens > tokenBudget) {
    const lastIndex = prepared.length > 0 ? prepared.length - 1 : null;
    const published = prepared
      .map(({ event }, index) => ({ event, index }))
      .filter(({ event, index }) => event.kind === "result_published" && index !== lastIndex)
      .map(({ index }) => index);
    let lower = 0;
    let upper = published.length;
    let fitting: AssembledProjection | null = null;
    while (lower <= upper) {
      const publishedCount = Math.floor((lower + upper) / 2);
      const selected = new Set<number>();
      if (lastIndex !== null) selected.add(lastIndex);
      if (publishedCount > 0) {
        for (const index of published.slice(-publishedCount)) selected.add(index);
      }
      const candidate = assembleProjection(headerJson, prepared, selected, 0);
      if (candidate.estimatedTokens <= tokenBudget) {
        fitting = candidate;
        lower = publishedCount + 1;
      } else {
        upper = publishedCount - 1;
      }
    }
    assembled = fitting ?? assembleProjection(
      headerJson,
      prepared,
      lastIndex === null ? new Set() : new Set([lastIndex]),
      0,
    );
  }

  if (assembled.estimatedTokens > tokenBudget && prepared.length > 0) {
    assembled = assembleProjection(headerJson, prepared, new Set(), 0);
  }

  if (assembled.estimatedTokens > tokenBudget) {
    assembled = {
      jsonl: headerJson,
      truncated: prepared.length > 0,
      omittedEvents: prepared.length,
      estimatedTokens: estimateProjectionTokens(headerJson),
    };
  }

  return projectionResult(input, mode, fromSeq, toSeq, assembled);
}

interface AssembledProjection {
  jsonl: string;
  truncated: boolean;
  omittedEvents: number;
  estimatedTokens: number;
}

interface PreparedProjectionEvent {
  event: MultiremiSessionEvent;
  perspective: "assistant_history" | "external_agent" | "user" | "operator";
  authorName: string | null;
  metadata: unknown;
  fullJson: string;
  fullJsonLength: number;
}

function prepareProjectionEvents(
  events: MultiremiSessionEvent[],
  input: BuildSessionProjectionInput,
): PreparedProjectionEvent[] {
  const authorNames = new Map<string, string | null>();
  return events.map((event) => {
    const authorKey = JSON.stringify([event.authorType, event.authorId]);
    let authorName = authorNames.get(authorKey);
    if (!authorNames.has(authorKey)) {
      authorName = input.resolveAuthorName?.(event.authorType, event.authorId) ?? null;
      authorNames.set(authorKey, authorName);
    }
    const metadata = stableJsonValue(event.metadata);
    const perspective = eventPerspective(event, input.targetAgentId);
    const fullLine = eventLine(event, perspective, authorName ?? null, metadata, event.body, 0);
    const fullJson = JSON.stringify(fullLine);
    return {
      event,
      perspective,
      authorName: authorName ?? null,
      metadata,
      fullJson,
      fullJsonLength: fullJson.length,
    };
  });
}

function assembleProjection(
  headerJson: string,
  events: PreparedProjectionEvent[],
  selected: Set<number>,
  bodyLimit: number | null,
): AssembledProjection {
  const lines: string[] = [headerJson];
  let omittedEvents = 0;
  let bodyTruncated = false;
  let index = 0;
  while (index < events.length) {
    if (selected.has(index)) {
      const rendered = renderPreparedEvent(events[index]!, bodyLimit);
      lines.push(rendered.json);
      bodyTruncated ||= rendered.bodyTruncated;
      index += 1;
      continue;
    }

    const start = index;
    let omittedChars = 0;
    let omittedPublishedResults = 0;
    while (index < events.length && !selected.has(index)) {
      omittedChars += events[index]!.fullJsonLength;
      if (events[index]!.event.kind === "result_published") omittedPublishedResults += 1;
      index += 1;
    }
    const omitted = events.slice(start, index);
    omittedEvents += omitted.length;
    const elision: Record<string, unknown> = {
      type: "session_elision",
      omitted_events: omitted.length,
      from_seq: omitted[0]!.event.seq,
      to_seq: omitted.at(-1)!.event.seq,
      omitted_chars: omittedChars,
    };
    if (omittedPublishedResults > 0) {
      elision.omitted_published_results = omittedPublishedResults;
    }
    elision.note = ELISION_NOTE;
    lines.push(JSON.stringify(elision));
  }
  const jsonl = lines.join("\n");
  return {
    jsonl,
    truncated: bodyTruncated || omittedEvents > 0,
    omittedEvents,
    estimatedTokens: estimateProjectionTokens(jsonl),
  };
}

function renderPreparedEvent(
  prepared: PreparedProjectionEvent,
  bodyLimit: number | null,
): { json: string; bodyTruncated: boolean } {
  if (bodyLimit === null || prepared.event.body.length <= bodyLimit) {
    return { json: prepared.fullJson, bodyTruncated: false };
  }
  const body = prepared.event.body.slice(0, Math.max(0, bodyLimit));
  const omittedChars = prepared.event.body.length - body.length;
  const line = eventLine(
    prepared.event,
    prepared.perspective,
    prepared.authorName,
    prepared.metadata,
    body,
    omittedChars,
  );
  return { json: JSON.stringify(line), bodyTruncated: true };
}

function eventLine(
  event: MultiremiSessionEvent,
  perspective: "assistant_history" | "external_agent" | "user" | "operator",
  authorName: string | null,
  metadata: unknown,
  body: string,
  bodyOmittedChars: number,
): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: "session_event",
    seq: event.seq,
    kind: event.kind,
    perspective,
    author_type: event.authorType,
    author_id: event.authorId,
    author_name: authorName,
    body,
  };
  if (bodyOmittedChars > 0) {
    line.body_truncated = true;
    line.body_omitted_chars = bodyOmittedChars;
  }
  line.task_id = event.taskId;
  line.source_comment_id = event.sourceCommentId;
  line.metadata = metadata;
  line.created_at = event.createdAt;
  return line;
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
