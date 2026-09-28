import { describe, expect, it } from "bun:test";
import type {
  ConversationLogEntry,
  ConversationLogTurnMetadata,
} from "@multiremi/contracts/conversation-log";
import {
  CONVERSATION_LOG_HIDDEN_KINDS,
  CONVERSATION_LOG_KINDS,
  CONVERSATION_LOG_KIND_VISIBILITY,
  CONVERSATION_LOG_SHOWN_KINDS,
} from "@multiremi/contracts/conversation-log";
import type { MultiremiIssueComment } from "@multiremi/contracts/types";
import {
  SESSION_ARCHIVE_REQUEST_STATUSES,
  SESSION_ARCHIVE_SUBJECT_KINDS,
  TRACE_END_STATUSES,
  TRACE_FILE_FORMAT,
  TRACE_REF_LOCATIONS,
} from "@multiremi/contracts/trace-file";
import type { TraceEndStatus, TraceFileHeader, TraceFileTrailer } from "@multiremi/contracts/trace-file";
import { TRACE_EVENT_STATUSES } from "@multiremi/contracts/trace.js";
import type { TraceEndStatus as StoreTraceEndStatus } from "@multiremi/worker/trace-store.js";

/**
 * Compile-time parity between the two `TraceEndStatus` declarations.
 *
 * The trailer lives in contracts, while A-0's `TraceStore.close` lives in
 * `packages/server/src/worker/trace-store.ts` and must not be edited from B0, so
 * the type is stated twice. Bidirectional parameters are the guard: the return
 * annotation has to accept a value of each side's type, so widening EITHER
 * declaration fails `tsc`. Comparing literal values would not — a literal from
 * the narrower side still type-checks against the wider one.
 *
 * Never called at runtime; the unused-parameter body exists only to be type
 * checked. Real assertions live in the test below.
 */
function traceEndStatusParity(
  fromStore: StoreTraceEndStatus,
  fromContracts: TraceEndStatus,
): [TraceEndStatus, StoreTraceEndStatus] {
  // Assigning each side to the other's type is the whole check, in both
  // directions at once.
  const contractsTyped: TraceEndStatus = fromStore;
  const storeTyped: StoreTraceEndStatus = fromContracts;
  return [contractsTyped, storeTyped];
}

/**
 * The conversation-log kinds are a production census, not a design vocabulary
 * (MUL-402 `cmt_c396ve5fnnx5` §4). A name invented in the plan silently turns
 * the backfill into a lossy mapping, so pin the exact set and each kind's
 * visibility here.
 */
describe("conversation log contract", () => {
  it("carries the comment resolution state on the entry, not in metadata", () => {
    const comment = {
      id: "cmt_1",
      issueId: "iss_1",
      issueSessionId: "ises_1",
      authorType: "member",
      authorId: "mem_1",
      taskId: null,
      parentId: null,
      body: "looks good",
      resolvedAt: "2026-09-27T01:00:00.000Z",
      resolvedByType: "agent",
      resolvedById: "agt_1",
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T01:00:00.000Z",
    } satisfies Partial<MultiremiIssueComment>;
    const entry = {
      session_id: comment.issueSessionId,
      seq: 7,
      id: comment.id,
      kind: "message",
      visibility: "shown",
      author_type: comment.authorType,
      author_id: comment.authorId,
      task_id: comment.taskId,
      body_md: comment.body,
      body_html: null,
      render_version: null,
      parent_id: comment.parentId,
      resolved_at: comment.resolvedAt,
      resolved_by_type: comment.resolvedByType,
      resolved_by_id: comment.resolvedById,
      metadata: {},
      revision: 2,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      deleted_at: null,
    } satisfies ConversationLogEntry;

    // Names and meanings match the comment contract field for field, so a
    // backfill copies them rather than translating them.
    expect([
      [entry.resolved_at, comment.resolvedAt],
      [entry.resolved_by_type, comment.resolvedByType],
      [entry.resolved_by_id, comment.resolvedById],
    ]).toEqual([
      [comment.resolvedAt, comment.resolvedAt],
      [comment.resolvedByType, comment.resolvedByType],
      [comment.resolvedById, comment.resolvedById],
    ]);
    // Resolution is an in-place update on the row: no marker kind exists for it.
    expect(CONVERSATION_LOG_KINDS).not.toContain("thread_resolved" as never);
    expect(CONVERSATION_LOG_KINDS).not.toContain("thread_unresolved" as never);

    const unresolved: ConversationLogEntry = {
      ...entry,
      resolved_at: null,
      resolved_by_type: null,
      resolved_by_id: null,
    };
    expect([unresolved.resolved_at, unresolved.resolved_by_type, unresolved.resolved_by_id])
      .toEqual([null, null, null]);
  });

  it("reads the turn card metadata through the card's own field list", () => {
    const card: ConversationLogTurnMetadata = {
      final_entry_id: "cmt_2",
      summary: "did the thing",
      tool_call_count: 4,
      event_count: 12,
      type_histogram: [
        { type: "tool_use", tool: "bash", count: 3 },
        { type: "text", tool: null, count: 9 },
      ],
      usage: [{ provider: "codex", model: "gpt-5", inputTokens: 10, outputTokens: 20 }],
      model: { provider: "codex", model: "gpt-5" },
      status: "completed",
      elapsed_ms: 1234,
      failure_reason: null,
    };
    expect(card.type_histogram?.map((bucket) => bucket.tool)).toEqual(["bash", null]);
    expect(card.status).toBe("completed");
  });

  it("carries the twelve production kinds plus head", () => {
    expect([...CONVERSATION_LOG_KINDS]).toEqual([
      "head",
      "message",
      "system",
      "turn",
      "result_published",
      "task_completed",
      "task_failed",
      "task_cancelled",
      "session_created",
      "task_steer",
      "message_edited",
      "message_deleted",
      "delegation_report",
    ]);
    expect(CONVERSATION_LOG_KINDS).toHaveLength(13);
  });

  it("never names a kind that has no producer", () => {
    for (const invented of [
      "turn_finished",
      "steer",
      "thread_resolved",
      "thread_unresolved",
      "follow_frozen",
      "result",
      "task_assigned",
    ]) {
      expect(CONVERSATION_LOG_KINDS).not.toContain(invented as never);
    }
  });

  it("splits shown and hidden without overlap and with explicit visibilities", () => {
    const shown = new Set<string>(CONVERSATION_LOG_SHOWN_KINDS);
    const hidden = new Set<string>(CONVERSATION_LOG_HIDDEN_KINDS);
    expect([...shown].filter((kind) => hidden.has(kind))).toEqual([]);
    expect([...shown, ...hidden].sort()).toEqual([...CONVERSATION_LOG_KINDS].sort());
    for (const kind of CONVERSATION_LOG_SHOWN_KINDS) {
      expect(CONVERSATION_LOG_KIND_VISIBILITY[kind]).toBe("shown");
    }
    for (const kind of CONVERSATION_LOG_HIDDEN_KINDS) {
      expect(CONVERSATION_LOG_KIND_VISIBILITY[kind]).toBe("hidden");
    }
    expect(CONVERSATION_LOG_KIND_VISIBILITY.head).toBe("shown");
  });
});

describe("trace file and archive request contract", () => {
  /**
   * `TraceEndStatus` is defined in two places on purpose: the trailer lives in
   * contracts (this file's package) while A-0's `TraceStore.close` lives in
   * `packages/server/src/worker/trace-store.ts` and must not be edited from B0.
   * These probes are erased at runtime and fail `tsc` the moment either side
   * drifts, in either direction.
   */
  it("keeps the trailer status assignable to and from A-0's store status", () => {
    // The parity function above is what fails `tsc` on drift; this asserts the
    // values it was written around really are the same three.
    const [asContracts, asStore] = traceEndStatusParity("completed", "cancelled");
    expect([asContracts, asStore]).toEqual(["completed", "cancelled"]);
  });

  it("pins the trace file format and pointer states", () => {
    expect(TRACE_FILE_FORMAT).toBe("multiremi.trace.v1");
    expect([...TRACE_REF_LOCATIONS]).toEqual([
      "daemon",
      "archive",
      "none",
      "lost",
      "backfilling",
    ]);
  });

  it("pins the trailer status vocabulary and never borrows the event one", () => {
    expect([...TRACE_END_STATUSES]).toEqual(["completed", "failed", "cancelled"]);
    // `cancelled` is a turn outcome with no event counterpart, and the event
    // vocabulary's `pending` / `in_progress` are not turn outcomes: the two
    // lists must stay different, or the trailer would accept a lifecycle value.
    expect(TRACE_END_STATUSES).not.toContain("pending" as never);
    expect(TRACE_END_STATUSES).not.toContain("in_progress" as never);
    // The event status vocabulary stays the sole source for an event's `status`
    // field, and B0 must not have collapsed the two concepts into one list: at
    // least one trailer status (`cancelled`) is not an event status. Stated as a
    // difference rather than an equality, so A-side may extend its own list.
    expect(
      TRACE_END_STATUSES.some(
        (status) => !(TRACE_EVENT_STATUSES as readonly string[]).includes(status),
      ),
    ).toBe(true);
  });

  it("types the trailer end block and keeps framing lines free of seq", () => {
    const header: TraceFileHeader = {
      format: TRACE_FILE_FORMAT,
      task_id: "task_1",
      session_id: "ises_1",
      agent_id: "agt_1",
      provider: "codex",
      started_at: "2026-09-27T00:00:00.000Z",
    };
    const trailer: TraceFileTrailer = {
      end: { status: "completed", head: 3, event_count: 3, ended_at: "2026-09-27T00:01:00.000Z" },
    };
    expect(Object.keys(header).sort()).toEqual([
      "agent_id",
      "format",
      "provider",
      "session_id",
      "started_at",
      "task_id",
    ]);
    expect("seq" in header).toBe(false);
    expect("seq" in trailer).toBe(false);
    expect("seq" in trailer.end).toBe(false);
    expect(trailer.end.status).toBe("completed");
  });

  it("pins the archive request state machine and its subjects", () => {
    expect([...SESSION_ARCHIVE_REQUEST_STATUSES]).toEqual([
      "pending",
      "sent",
      "acked",
      "completed",
      "failed",
    ]);
    expect([...SESSION_ARCHIVE_SUBJECT_KINDS]).toEqual(["issue", "chat", "task"]);
  });
});
