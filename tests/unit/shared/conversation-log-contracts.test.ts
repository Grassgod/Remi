import { describe, expect, it } from "bun:test";
import {
  CONVERSATION_LOG_HIDDEN_KINDS,
  CONVERSATION_LOG_KINDS,
  CONVERSATION_LOG_KIND_VISIBILITY,
  CONVERSATION_LOG_SHOWN_KINDS,
} from "@multiremi/contracts/conversation-log";
import {
  SESSION_ARCHIVE_REQUEST_STATUSES,
  SESSION_ARCHIVE_SUBJECT_KINDS,
  TRACE_FILE_FORMAT,
  TRACE_REF_LOCATIONS,
} from "@multiremi/contracts/trace-file";

/**
 * The conversation-log kinds are a production census, not a design vocabulary
 * (MUL-402 `cmt_c396ve5fnnx5` §4). A name invented in the plan silently turns
 * the backfill into a lossy mapping, so pin the exact set and each kind's
 * visibility here.
 */
describe("conversation log contract", () => {
  it("carries the eleven production kinds plus head", () => {
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
    ]);
    expect(CONVERSATION_LOG_KINDS).toHaveLength(12);
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
