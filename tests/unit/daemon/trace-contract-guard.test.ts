import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isKnownTraceEventType,
  KNOWN_TRACE_EVENT_TYPES,
  taskMessageToTraceEvent,
  traceEventToTaskMessage,
} from "@multiremi/contracts/trace.js";
import {
  TRACE_CONTENT_MAX_BYTES,
  TRACE_INPUT_MAX_BYTES,
  TRACE_META_MAX_BYTES,
  TRACE_OUTPUT_MAX_BYTES,
  TRACE_TOOL_MAX_BYTES,
} from "@shared/trace-sanitize.js";

const REPO_ROOT = join(import.meta.dir, "../../..");
const MAPPER = join(REPO_ROOT, "packages/server/src/worker/acp-event-mapper.ts");
const DAEMON = join(REPO_ROOT, "packages/server/src/worker/daemon.ts");
const TASKS_REPO = join(REPO_ROOT, "packages/server/src/store/repos/tasks-repo.ts");

/**
 * Drift guards for the two things A-0 states about existing behaviour: the event
 * type inventory and the field byte caps. Both are restatements of code that
 * lives elsewhere, so both need a mechanical check - a comment would not notice
 * the day someone adds a fourteenth type or changes a cap.
 */
describe("trace contract drift guards", () => {
  /**
   * The producer inventory, read from the two files that build TaskMessageInput
   * objects. Three shapes count, and nothing else does - in particular
   * `status: "error"` on a workspace report is a different field and must not be
   * mistaken for an event type:
   *
   *   1. an object literal `type: "x"`
   *   2. the mapper's chunk ternary `? "thinking" : isCompaction ? "compaction" : "text"`
   *   3. a `reportHumanRequestMessage(..., "x", ...)` argument
   */
  function producerEventTypes(): Set<string> {
    const found = new Set<string>();

    // (1) Object literals. Scoped to `{ type:` / `, type:` / a `type:` line start
    // so an unrelated `status: "error"` or a nested option object cannot match.
    for (const file of [MAPPER, DAEMON]) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(/(?:^\s*|[{,]\s*)type:\s*"([a-z_]+)"/gm)) found.add(match[1]!);
    }

    // (2) The chunk ternary, which lives only in the mapper. Kept out of the
    // daemon: a 4.7k-line file is full of unrelated `? "a" : "b"` expressions.
    const mapperSrc = readFileSync(MAPPER, "utf8");
    for (const match of mapperSrc.matchAll(/\?\s*"([a-z_]+)"\s*:\s*isCompaction/g)) found.add(match[1]!);
    for (const match of mapperSrc.matchAll(/\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/g)) {
      found.add(match[1]!);
      found.add(match[2]!);
    }

    // (3) Human-request and steer reporters, which pass the type positionally.
    for (const match of readFileSync(DAEMON, "utf8").matchAll(
      // `[^,]+` rather than `[^,(]+`: the second argument is `nextSeq()`, and a
      // paren-blind class would skip every multi-line call in the file.
      /reportHumanRequestMessage\(\s*[^,]+,\s*[^,]+,\s*"([a-z_]+)"/g,
    )) {
      found.add(match[1]!);
    }
    return found;
  }

  it("names exactly the types the daemon's producers emit", () => {
    const literalTypes = producerEventTypes();

    // `assistant` and `error` are viewer-side unions, not producers; if either
    // ever gains a writer this guard should fail and force a decision.
    for (const viewerOnly of ["assistant", "error"]) {
      expect(literalTypes.has(viewerOnly), `${viewerOnly} now has a daemon writer`).toBe(false);
    }

    for (const type of literalTypes) {
      expect(isKnownTraceEventType(type), `producer emits "${type}" but KNOWN_TRACE_EVENT_TYPES does not list it`).toBe(true);
    }
    // Every claimed type except the three the mapper builds from a ternary must
    // appear literally; that keeps a typo from silently shrinking the contract.
    for (const type of KNOWN_TRACE_EVENT_TYPES) {
      if (type === "text" || type === "thinking" || type === "compaction") continue;
      expect(literalTypes.has(type), `KNOWN_TRACE_EVENT_TYPES claims "${type}" but no producer emits it`).toBe(true);
    }
  });

  it("finds all thirteen types, so the guard is not silently matching nothing", () => {
    const literalTypes = producerEventTypes();
    expect([...literalTypes].sort()).toEqual([...KNOWN_TRACE_EVENT_TYPES].sort());
    expect(literalTypes.size).toBe(13);
  });

  it("keeps the known-type list open: an unknown type is not a validation failure", () => {
    // MUL-402 ruling 1: the type is an open string, so this list enumerates and
    // buckets; it must never be used to reject a value.
    expect(isKnownTraceEventType("text")).toBe(true);
    expect(isKnownTraceEventType("assistant")).toBe(false);
    expect(isKnownTraceEventType("some_future_type")).toBe(false);
  });

  it("keeps the field byte caps equal to the write path it mirrors", () => {
    const src = readFileSync(TASKS_REPO, "utf8");
    // Evaluate the literal the same way the source does - a product of integers -
    // without handing an arbitrary string to eval.
    const read = (name: string): number => {
      const match = new RegExp(`const ${name} = ([0-9*\\s]+);`).exec(src);
      if (!match) throw new Error(`tasks-repo.ts no longer defines ${name}`);
      return match[1]!.split("*").reduce((total, factor) => total * Number(factor.trim()), 1);
    };
    expect(TRACE_TOOL_MAX_BYTES).toBe(read("TASK_MESSAGE_TOOL_MAX"));
    expect(TRACE_CONTENT_MAX_BYTES).toBe(read("TASK_MESSAGE_TEXT_MAX"));
    expect(TRACE_INPUT_MAX_BYTES).toBe(read("TASK_MESSAGE_INPUT_MAX"));
    expect(TRACE_OUTPUT_MAX_BYTES).toBe(read("TASK_MESSAGE_OUTPUT_MAX"));
    expect(TRACE_META_MAX_BYTES).toBe(read("TASK_MESSAGE_META_MAX"));
  });

  it("keeps the status set in step with the write path", () => {
    const src = readFileSync(TASKS_REPO, "utf8");
    const match = /const TASK_MESSAGE_STATUSES = new Set\(\[([^\]]+)\]\)/.exec(src);
    expect(match).not.toBeNull();
    const statuses = match![1]!.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
    expect(statuses).toEqual(["completed", "failed", "in_progress", "pending"]);
  });

  it("round-trips a TaskMessageInput without losing a field", () => {
    const message = {
      seq: 7,
      type: "tool_result",
      tool: "Bash",
      content: "done",
      input: { command: "ls" },
      output: "{\"ok\":true}",
      toolCallId: "tc_9",
      status: "completed",
      meta: { duration_ms: 42 },
    } as const;

    const ts = "2026-09-27T04:05:06.789Z";
    const event = taskMessageToTraceEvent(message, ts);
    expect(event.type).toBe("tool_result");
    expect(event.tool_call_id).toBe("tc_9");
    expect(event.ts).toBe(ts);

    const restored = traceEventToTaskMessage({ ...event, ts, seq: message.seq });
    expect(restored).toEqual(message);
  });

  it("passes an unknown legacy type through verbatim", () => {
    // MUL-402 ruling 1: the backfill must not lose or rewrite rows it does not
    // recognize. `assistant` is a real historical value with no current producer.
    for (const type of ["assistant", "error", "some_future_type"]) {
      const event = taskMessageToTraceEvent({ type, content: "legacy row" }, "2026-09-27T00:00:00.000Z");
      expect(event.type).toBe(type);
      expect(event.content).toBe("legacy row");
    }
  });

  it("keeps ts as an ISO string, equal to the row it backfills from", () => {
    const createdAt = "2026-09-27T04:05:06.789Z";
    const event = taskMessageToTraceEvent({ type: "text", content: "x" }, createdAt);
    expect(event.ts).toBe(createdAt);
    expect(typeof event.ts).toBe("string");
  });
});
