import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
const TASKS_REPO = join(REPO_ROOT, "packages/server/src/store/repos/tasks-repo.ts");

/**
 * Drift guards for the two things A-0 states about existing behaviour: the event
 * type inventory and the field byte caps. Both are restatements of code that lives
 * elsewhere, so both need a mechanical check - a comment would not notice the day
 * someone adds a fourteenth type or changes a cap.
 *
 * The type inventory is discovered from the **write path**, not from a list of
 * filenames and not by scanning the tree for `type: "..."`. Both of those failed:
 *
 *   - a hardcoded file list missed a producer written in a new module;
 *   - scanning the tree for object-literal `type:` keys reports 134 distinct values
 *     across unrelated type spaces (ACL kinds, inbox ledger types, card element
 *     types, the CLI's own `{type: "string"}` JSON-schema outputs), and it also
 *     picks up `packages/remi/src/conversation/parser.ts`, which parses provider
 *     JSONL into `ChatMessage` objects - a different type space with its own
 *     `"assistant"` / `"thinking"` / `"tool"` vocabulary that never reaches a task
 *     message.
 *
 * So the scan is scoped by what a file can do:
 *
 *   1. find the files that can publish a trace event at all, by looking for a write
 *      call into a message sink (`messageBatcher.push`, the `messages` outbox
 *      report, the human-request reporter, the trace store). That set is small and
 *      is derived, not listed;
 *   2. within those files only, read the `type:` literals.
 *
 * A new producer therefore has to be in a file that writes to a sink to be a
 * producer at all, and if it writes to a sink without going through one of those
 * calls it cannot publish anything either.
 */

/** Every source file under the given roots, tests and build output excluded. */
function sourceFiles(): string[] {
  const roots = [
    join(REPO_ROOT, "packages"),
    join(REPO_ROOT, "apps"),
    join(REPO_ROOT, "frontend/packages"),
    join(REPO_ROOT, "frontend/apps"),
  ];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (/(^|\/)(tests?|__tests__|fixtures?)($|\/)/.test(full)) continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  for (const root of roots) {
    try {
      walk(root);
    } catch {
      // Absent in a trimmed checkout; the breadth check below proves the roots
      // that do exist are read.
    }
  }
  return out;
}

const rel = (file: string): string => file.replace(`${REPO_ROOT}/`, "");

/**
 * The call sites that can publish a trace event. Deliberately a set of call
 * patterns rather than filenames: this is what makes a producer in a brand-new
 * module discoverable, wherever in the tree it lives.
 */
const WRITE_SINK_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "TaskMessageBatcher.push", re: /\bmessageBatcher\.push\(|\bbatcher\.push\(/ },
  { label: "messages outbox report", re: /\benqueueTaskReport\([^)]*"messages"/ },
  { label: "human-request reporter", re: /\breportHumanRequestMessage\(/ },
  { label: "task-message report", re: /\breportTaskMessages\(/ },
  { label: "trace store / stream", re: /\bTraceStore\b|\btrace\.append\b/ },
];

/**
 * Directories where a task message is built, regardless of whether the file calls
 * a sink itself.
 *
 * This closes the gap the call-site rule leaves: a producer can be written as a
 * pure "event -> message[]" function and handed to a sink by its caller, so it
 * would carry a `type:` literal without naming any sink. `worker/` is where every
 * task-message producer lives today, and it is also where a reviewer would expect a
 * fourteenth type to appear. `packages/daemon/src` is deliberately absent: it holds
 * the provider-agnostic runtime and never builds a `TaskMessageInput`.
 */
const MESSAGE_PRODUCER_DIRS = [join(REPO_ROOT, "packages/server/src/worker")];

/**
 * Files inside a producer directory that speak a different type space, with the
 * reason. Kept explicit and short so it is auditable, and so a new entry is a
 * visible decision rather than a silently widened regex.
 */
const NON_EVENT_FILES: Record<string, string> = {
  "packages/server/src/worker/daemon-websocket.ts":
    "the wake-up socket's own control frames ({type: \"ping\"}), never a task message",
};

/** The files to read the type inventory from, and why each is in scope. */
function producerFiles(): Array<{ file: string; reason: string }> {
  const out = new Map<string, string>();

  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    const sink = WRITE_SINK_PATTERNS.find(({ re }) => re.test(src));
    if (sink) out.set(file, `calls ${sink.label}`);
  }

  for (const dir of MESSAGE_PRODUCER_DIRS) {
    for (const file of sourceFiles()) {
      if (!file.startsWith(`${dir}/`)) continue;
      if (NON_EVENT_FILES[rel(file)]) continue;
      if (!out.has(file)) out.set(file, `lives in ${rel(dir)}/`);
    }
  }

  return [...out.entries()].map(([file, reason]) => ({ file, reason }));
}

/**
 * The chunk ternary, written out exactly as the mapper writes it.
 *
 * Anchored on the whole expression rather than on a loose `? "a" : "b"` pair. The
 * loose version matched any ternary - an unrelated `random() > 0.5 ? "phase_alpha"
 * : "phase_beta"` turned the guard red - and an anchored-on-`isCompactionChunk`
 * neighbourhood version still pulled in unrelated `"thinking"` literals from a file
 * that merely mentions the helper. This only matches the real shape.
 */
const CHUNK_TERNARY_RE =
  /type:\s*[A-Za-z0-9_$]+\s*===\s*"agent_thought_chunk"\s*\?\s*"([a-z_]+)"\s*:\s*isCompactionChunk\([^)]*\)\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/;

/**
 * The producer inventory: which type strings each write-path file emits.
 *
 * Two shapes count, and nothing else does - in particular `status: "error"` on a
 * workspace report is a different key and must not be mistaken for an event type:
 *
 *   1. an object literal `type: "x"` inside a write-path file
 *   2. the mapper's chunk ternary
 *   3. a `reportHumanRequestMessage(..., "x", ...)` positional argument
 */
function producerEventTypes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (type: string, file: string): void => {
    const files = found.get(type) ?? [];
    if (!files.includes(rel(file))) files.push(rel(file));
    found.set(type, files);
  };

  for (const { file } of producerFiles()) {
    const src = readFileSync(file, "utf8");

    // (1) Object-literal `type: "..."`. The lookbehind excludes a longer key name
    // that merely ends in `type`.
    for (const match of src.matchAll(/(?<![A-Za-z0-9_$])type:\s*"([a-z_]+)"/g)) add(match[1]!, file);

    // (2) The chunk ternary.
    const chunk = CHUNK_TERNARY_RE.exec(src);
    if (chunk) {
      // Written `? "thinking" : isCompactionChunk(...) ? "compaction" : "text"`.
      add(chunk[1]!, file);
      add(chunk[2]!, file);
      add(chunk[3]!, file);
    }

    // (3) Positional type argument to the human-request / steer reporter.
    for (const match of src.matchAll(
      /reportHumanRequestMessage\(\s*[^,]+,\s*[^,]+,\s*"([a-z_]+)"/g,
    )) {
      add(match[1]!, file);
    }
  }
  return found;
}

describe("trace contract drift guards", () => {
  it("discovers producers by call site, so a new module anywhere counts", () => {
    const files = producerFiles().map(({ file }) => rel(file));
    // The two files that actually build task messages today.
    expect(files).toContain("packages/server/src/worker/acp-event-mapper.ts");
    expect(files).toContain("packages/server/src/worker/daemon.ts");
    // The scan walked a real amount of the tree rather than a corner of it.
    expect(sourceFiles().length).toBeGreaterThan(500);
    // Every entry carries a stated reason, so scope is reviewable.
    for (const { reason } of producerFiles()) expect(reason.length).toBeGreaterThan(0);
  });

  it("covers the whole message-production directory, not just files that call a sink", () => {
    // A producer can be written as a pure function and handed to a sink by its
    // caller, so it would name no sink. Every non-excluded file in worker/ must be
    // in scope, otherwise such a producer escapes.
    const inScope = new Set(producerFiles().map(({ file }) => rel(file)));
    for (const file of sourceFiles()) {
      const path = rel(file);
      if (!path.startsWith("packages/server/src/worker/")) continue;
      if (NON_EVENT_FILES[path]) continue;
      expect(inScope, `${path} is in worker/ but not scanned`).toContain(path);
    }
  });

  it("keeps the non-event exclusion list short and justified", () => {
    // An exclusion is a hole in the guard, so each one must name a real file and a
    // reason. This is the only place a producer directory may be skipped.
    const excluded = Object.keys(NON_EVENT_FILES);
    expect(excluded).toContain("packages/server/src/worker/daemon-websocket.ts");
    for (const [path, reason] of Object.entries(NON_EVENT_FILES)) {
      expect(sourceFiles().map(rel), `${path} no longer exists`).toContain(path);
      expect(reason.length, `${path} has no justification`).toBeGreaterThan(20);
    }
  });

  it("names exactly the types the daemon's producers emit", () => {
    const producers = producerEventTypes();

    for (const type of producers.keys()) {
      expect(
        isKnownTraceEventType(type),
        `producer emits "${type}" (${producers.get(type)!.join(", ")}) but KNOWN_TRACE_EVENT_TYPES does not list it`,
      ).toBe(true);
    }
    for (const type of KNOWN_TRACE_EVENT_TYPES) {
      expect(
        producers.has(type),
        `KNOWN_TRACE_EVENT_TYPES claims "${type}" but no producer emits it`,
      ).toBe(true);
    }
  });

  it("finds all thirteen types, so the guard is not silently matching nothing", () => {
    const producers = producerEventTypes();
    expect([...producers.keys()].sort()).toEqual([...KNOWN_TRACE_EVENT_TYPES].sort());
    expect(producers.size).toBe(13);
  });

  it("keeps the known-type list open: an unknown type is not a validation failure", () => {
    // MUL-402 ruling 1: the type is an open string, so this list enumerates and
    // buckets; it must never be used to reject a value.
    expect(isKnownTraceEventType("text")).toBe(true);
    expect(isKnownTraceEventType("assistant")).toBe(false);
    expect(isKnownTraceEventType("some_future_type")).toBe(false);
  });

  it("does not treat a file from another type space as a producer", () => {
    // `parser.ts` parses provider JSONL into `ChatMessage` objects and has its own
    // `"assistant"` / `"thinking"` / `"tool"` vocabulary. It never writes a task
    // message, so it must not be scanned, and its `assistant` must not be read as
    // evidence that the daemon emits `assistant`.
    const files = producerFiles().map(({ file }) => rel(file));
    expect(files).not.toContain("packages/remi/src/conversation/parser.ts");
    expect(producerEventTypes().has("assistant")).toBe(false);
    expect(producerEventTypes().has("tool")).toBe(false);
  });

  it("attributes the ternary-produced types to the mapper alone", () => {
    const producers = producerEventTypes();
    for (const type of ["thinking", "text", "compaction"]) {
      const files = producers.get(type) ?? [];
      expect(
        files.every((file) => file.endsWith("acp-event-mapper.ts")),
        `${type} attributed to ${files.join(", ")}`,
      ).toBe(true);
    }
  });

  it("does not mistake an unrelated ternary or a status key for a type", () => {
    // Regression form of the two false positives that were measured: a bare
    // `? "phase_alpha" : "phase_beta"` in the mapper, and `status: "error"` in the
    // workspace reporter. Neither may appear in the inventory.
    const producers = producerEventTypes();
    expect(producers.has("phase_alpha")).toBe(false);
    expect(producers.has("phase_beta")).toBe(false);
    expect(producers.has("error")).toBe(false);
    // `in_use` / `ready` are workspace-report statuses, not event types.
    expect(producers.has("in_use")).toBe(false);
    expect(producers.has("ready")).toBe(false);
  });

  it("keeps the field byte caps equal to the write path it mirrors", () => {
    const src = readFileSync(TASKS_REPO, "utf8");
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
