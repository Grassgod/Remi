import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  isKnownTraceEventType,
  KNOWN_TRACE_EVENT_TYPES,
  TRACE_EVENT_STATUSES,
  taskMessageToTraceEvent,
  traceEventToTaskMessage,
} from "@multiremi/contracts/trace.js";
import {
  normalizeTraceStatus,
  sanitizeTraceEventFields,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_INPUT_MAX_BYTES,
  TRACE_META_MAX_BYTES,
  TRACE_OUTPUT_MAX_BYTES,
  TRACE_STATUSES,
  TRACE_TOOL_MAX_BYTES,
  TRACE_TRUNCATION_MARKER,
} from "@shared/trace-sanitize.js";

const REPO_ROOT = join(import.meta.dir, "../../..");

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
 * Scan sink callers anywhere, plus all worker and ACP producer sources. A pure
 * producer need not reference a sink or TaskMessageInput to be in scope.
 */

// All cases inspect the same immutable checkout. Cache discovery/source/inventory,
// not assertions, so positive controls and every drift check still execute.
let sourceFilesSnapshot: string[] | undefined;
const sourceTextSnapshot = new Map<string, string>();
const sourceText = (file: string): string => {
  if (!sourceTextSnapshot.has(file)) sourceTextSnapshot.set(file, readFileSync(file, "utf8"));
  return sourceTextSnapshot.get(file)!;
};
let producerFilesSnapshot: Array<{ file: string; reason: string }> | undefined;
let producerTypesSnapshot: Map<string, string[]> | undefined;

/** Every source file under the given roots, tests and build output excluded. */
function sourceFiles(): readonly string[] {
  if (sourceFilesSnapshot) return sourceFilesSnapshot;
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
  return sourceFilesSnapshot = out;
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
 * task-message producer lives today; ACP adapters can also produce messages without
 * calling a sink themselves. `packages/daemon/src` is deliberately absent: it holds
 * the provider-agnostic runtime and never builds a `TaskMessageInput`.
 */
const MESSAGE_PRODUCER_DIRS = [join(REPO_ROOT, "packages/server/src/worker"), join(REPO_ROOT, "packages/acp/src")];

/**
 * Files inside a producer directory that speak a different type space, with the
 * reason. Kept explicit and short so it is auditable, and so a new entry is a
 * visible decision rather than a silently widened regex.
 */
const NON_EVENT_FILES: Record<string, string> = {
  "packages/server/src/worker/daemon-protocol-client.ts":
    "protocol control frames use t and ts, never a TaskMessageInput",
  "packages/acp/src/client.ts":
    "ACP prompt input content uses text/image, not the outgoing task trace type space",
  "packages/acp/src/provider.ts":
    "ACP config select types and prompt image attachments are not outgoing trace events",
  "packages/acp/src/adapters/claude-code/index.ts":
    "Claude plugin configuration uses local as a plugin source type, not an event type",
  "packages/acp/src/antigravity.ts":
    "ACP content/text wrapper types belong to SessionUpdate content, mapped by acp-event-mapper",
};

/** The files to read the type inventory from, and why each is in scope. */
function producerFiles(): ReadonlyArray<{ readonly file: string; readonly reason: string }> {
  if (producerFilesSnapshot) return producerFilesSnapshot;
  const out = new Map<string, string>();

  for (const file of sourceFiles()) {
    const src = sourceText(file);
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

  return producerFilesSnapshot = [...out.entries()].map(([file, reason]) => ({ file, reason }));
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
function producerEventTypes(): ReadonlyMap<string, readonly string[]> {
  if (producerTypesSnapshot) return producerTypesSnapshot;
  const found = new Map<string, string[]>();
  const add = (type: string, file: string): void => {
    const files = found.get(type) ?? [];
    if (!files.includes(rel(file))) files.push(rel(file));
    found.set(type, files);
  };

  for (const { file } of producerFiles()) {
    const src = sourceText(file);
    const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const controls: Array<[number, number]> = [];
    const visit = (node: ts.Node): void => {
      // queueInput carries conversation/control messages, not trace events.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "queueInput") {
        for (const argument of node.arguments) controls.push([argument.getStart(source), argument.end]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // (1) Object-literal `type: "..."`. The lookbehind excludes a longer key name
    // that merely ends in `type`.
    for (const match of src.matchAll(/(?<![A-Za-z0-9_$])type:\s*"([a-z_]+)"/g)) {
      if (!controls.some(([start, end]) => match.index >= start && match.index < end)) add(match[1]!, file);
    }

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
  return producerTypesSnapshot = found;
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
      if (!MESSAGE_PRODUCER_DIRS.some(dir => file.startsWith(`${dir}/`))) continue;
      if (NON_EVENT_FILES[path]) continue;
      expect(inScope, `${path} is in a message-production directory but not scanned`).toContain(path);
    }
  });

  it("keeps the non-event exclusion list short and justified", () => {
    // An exclusion is a hole in the guard, so each one must name a real file and a
    // reason. This is the only place a producer directory may be skipped.
    const excluded = Object.keys(NON_EVENT_FILES);
    expect(excluded.length).toBeLessThanOrEqual(5);
    expect(excluded).toContain("packages/server/src/worker/daemon-protocol-client.ts");
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

  it("pins the shared sanitizer byte caps and tests both sides of each boundary", () => {
    const fields = [
      ["tool", TRACE_TOOL_MAX_BYTES, 512],
      ["content", TRACE_CONTENT_MAX_BYTES, 256 * 1024],
      ["input", TRACE_INPUT_MAX_BYTES, 256 * 1024],
      ["output", TRACE_OUTPUT_MAX_BYTES, 64 * 1024],
      ["meta", TRACE_META_MAX_BYTES, 64 * 1024],
    ] as const;
    for (const [field, cap, expectedCap] of fields) {
      expect(cap).toBe(expectedCap);
      const structured = field === "input" || field === "meta";
      // Spaces avoid the base64 guard; quotes count toward the structured cap.
      const value = " ".repeat(cap - (structured ? 2 : 0));
      const atCap = structured ? JSON.stringify(value) : value;
      expect(sanitizeTraceEventFields({ type: "text", [field]: value })[field]).toBe(atCap);
      const overCap = structured ? JSON.stringify(value + " ") : value + " ";
      expect(sanitizeTraceEventFields({ type: "text", [field]: value + " " })[field])
        .toBe(overCap.slice(0, cap) + TRACE_TRUNCATION_MARKER);
    }
  });

  it("derives the sanitizer's status set from the contract, so they cannot drift", () => {
    // `TRACE_EVENT_STATUSES` (contracts) is the single definition; the sanitizer's
    // lookup set is built from it rather than restating the values. Assert the
    // derivation is live: every contract status must be accepted by the sanitizer,
    // and the two sets must have the same size. A status added to the contract but
    // not picked up by the sanitizer would fail here.
    for (const status of TRACE_EVENT_STATUSES) {
      expect(normalizeTraceStatus(status), `sanitizer rejects contract status "${status}"`).toBe(status);
      expect(TRACE_STATUSES.has(status), `TRACE_STATUSES is missing "${status}"`).toBe(true);
    }
    expect(TRACE_STATUSES.size).toBe(TRACE_EVENT_STATUSES.length);
    // And nothing outside the contract set is accepted.
    expect(normalizeTraceStatus("cancelled")).toBe("cancelled");
    expect(normalizeTraceStatus("unsupported")).toBeNull();
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
