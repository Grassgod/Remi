import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  isKnownTraceEventType,
  KNOWN_TRACE_EVENT_TYPES,
  TRACE_ITEM_TYPES,
} from "@multiremi/contracts/trace.js";
import {
  LEGACY_TRACE_STATUSES,
  normalizeTraceStatus,
  sanitizeTraceEventFields,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_EVENT_MAX_BYTES,
  TRACE_INPUT_MAX_BYTES,
  TRACE_ITEM_DIFF_MAX_BYTES,
  TRACE_ITEM_DIFFS_MAX_BYTES,
  TRACE_ITEM_INPUT_MAX_BYTES,
  TRACE_ITEM_LABEL_MAX_BYTES,
  TRACE_ITEM_OUTPUT_HEAD_BYTES,
  TRACE_ITEM_OUTPUT_TAIL_BYTES,
  TRACE_ITEM_REASONING_MAX_BYTES,
  TRACE_ITEM_TEXT_MAX_BYTES,
  TRACE_META_MAX_BYTES,
  TRACE_OUTPUT_MAX_BYTES,
  TRACE_STATUSES,
  TRACE_TOOL_MAX_BYTES,
  TRACE_TRUNCATION_MARKER,
} from "@shared/trace-sanitize.js";

const REPO_ROOT = join(import.meta.dir, "../../..");

/**
 * Drift guards for the trace vocabulary (PR 2): the event types and item types
 * the contract declares must be exactly the ones the daemon's producers write,
 * and the caps must stay what the spec states.
 *
 * Producers are discovered by type, not by filename: a module that builds trace
 * events has to type them as `TraceEventInput` / `TraceEventBody` (the store's
 * input), so any file in a producer directory naming either is scanned. Its
 * object-literal `type: "..."` values are then classified: dotted ones are event
 * types, the rest must be item types or belong to a type space the file
 * declares below.
 */

const PRODUCER_DIRS = [
  join(REPO_ROOT, "packages/server/src/worker"),
  join(REPO_ROOT, "packages/acp/src"),
  join(REPO_ROOT, "packages/shared/src"),
];

let filesSnapshot: string[] | undefined;
const textSnapshot = new Map<string, string>();
const sourceText = (file: string): string => {
  if (!textSnapshot.has(file)) textSnapshot.set(file, readFileSync(file, "utf8"));
  return textSnapshot.get(file)!;
};
const rel = (file: string): string => file.replace(`${REPO_ROOT}/`, "");

function sourceFiles(): readonly string[] {
  if (filesSnapshot) return filesSnapshot;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) out.push(full);
    }
  };
  for (const dir of PRODUCER_DIRS) walk(dir);
  return filesSnapshot = out;
}

/** Files that build trace event bodies. */
function producerFiles(): string[] {
  return sourceFiles().filter((file) => /\bTraceEvent(Input|Body)\b/.test(sourceText(file)));
}

/**
 * `type: "..."` values outside type declarations (which describe shapes and emit
 * nothing) and outside ACP content blocks (`{ type: "text", text }` is the
 * prompt/content vocabulary, not a trace type).
 */
function literalTypes(file: string): string[] {
  const src = sourceText(file);
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const skipped: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      skipped.push([node.getStart(source), node.end]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const out: string[] = [];
  const outside = (index: number) => !skipped.some(([start, end]) => index >= start && index < end);
  for (const match of src.matchAll(/(?<![A-Za-z0-9_$])type:\s*"([a-z_.]+)"/g)) {
    if (outside(match.index!)) out.push(match[1]!);
  }
  // Event types also travel as arguments (the translator's `write("item.updated", …)`).
  for (const match of src.matchAll(/"((?:turn|item)\.[a-z]+)"/g)) {
    if (outside(match.index!)) out.push(match[1]!);
  }
  return out;
}

function inventory(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of producerFiles()) {
    for (const type of literalTypes(file)) {
      const files = found.get(type) ?? [];
      if (!files.includes(rel(file))) files.push(rel(file));
      found.set(type, files);
    }
  }
  return found;
}

/** Literal `type` values a producer file uses in another vocabulary, with the reason. */
const OTHER_TYPE_SPACES: Record<string, string> = {
  text: "ACP content blocks ({ type: \"text\", text }) the vendor reader skips past",
  diff: "ACP tool-call content blocks the vendor reader recognises",
  terminal: "ACP tool-call content blocks the vendor reader recognises",
  read: "CommandAction variants of a command item",
  list_files: "CommandAction variants of a command item",
  search: "CommandAction variants of a command item",
  unknown: "CommandAction variants of a command item",
};

describe("trace contract drift guards", () => {
  it("discovers the producers by the types they build", () => {
    const files = producerFiles().map(rel);
    expect(files).toContain("packages/server/src/worker/trace-translator.ts");
    expect(files).toContain("packages/server/src/worker/trace-transport.ts");
    expect(files).toContain("packages/shared/src/turn-trace.ts");
    // The retired fragment producers are gone.
    expect(files.some((file) => file.endsWith("acp-event-mapper.ts"))).toBe(false);
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("names exactly the event types the producers emit", () => {
    const events = [...inventory().keys()].filter((type) => type.includes("."));
    for (const type of events) expect(isKnownTraceEventType(type), `producer emits unknown event "${type}"`).toBe(true);
    for (const type of KNOWN_TRACE_EVENT_TYPES) expect(events, `nothing emits "${type}"`).toContain(type);
    expect(events.sort()).toEqual([...KNOWN_TRACE_EVENT_TYPES].sort());
  });

  it("emits turn.completed from the transport's close only, never from the translator", () => {
    const found = inventory().get("turn.completed") ?? [];
    expect(found).toContain("packages/server/src/worker/trace-transport.ts");
    expect(found).not.toContain("packages/server/src/worker/trace-translator.ts");
  });

  it("builds every item type in the translator, and nothing outside the contract", () => {
    const translator = literalTypes(join(REPO_ROOT, "packages/server/src/worker/trace-translator.ts"));
    for (const type of TRACE_ITEM_TYPES) expect(translator, `the translator never builds "${type}"`).toContain(type);
    for (const [type, files] of inventory()) {
      if (type.includes(".")) continue;
      const known = (TRACE_ITEM_TYPES as readonly string[]).includes(type) || OTHER_TYPE_SPACES[type] !== undefined;
      expect(known, `"${type}" (${files.join(", ")}) is neither an item type nor a declared other type space`).toBe(true);
    }
  });

  it("produces no legacy fragment event any more", () => {
    // The fragment types `multiremi.trace.v1` files hold; nothing may write them.
    const legacy = new Set<string>([
      "execution", "text", "thinking", "compaction", "usage", "plan", "tool_use", "tool_result",
      "permission_request", "permission_response", "question_request", "question_response", "steer",
    ]);
    const items = new Set<string>(TRACE_ITEM_TYPES);
    for (const [type, files] of inventory()) {
      // `text` is the ACP content-block type; `plan` / `compaction` are item types now.
      if (type === "text" || items.has(type)) continue;
      expect(legacy.has(type), `${files.join(", ")} still writes the fragment type "${type}"`).toBe(false);
    }
    expect(isKnownTraceEventType("tool_use")).toBe(false);
    expect(isKnownTraceEventType("item.future")).toBe(false);
  });

  it("pins the item caps the spec states", () => {
    expect(TRACE_ITEM_TEXT_MAX_BYTES).toBe(256 * 1024);
    expect(TRACE_ITEM_REASONING_MAX_BYTES).toBe(64 * 1024);
    expect(TRACE_ITEM_OUTPUT_HEAD_BYTES).toBe(16 * 1024);
    expect(TRACE_ITEM_OUTPUT_TAIL_BYTES).toBe(48 * 1024);
    expect(TRACE_ITEM_INPUT_MAX_BYTES).toBe(16 * 1024);
    expect(TRACE_ITEM_DIFF_MAX_BYTES).toBe(64 * 1024);
    expect(TRACE_ITEM_DIFFS_MAX_BYTES).toBe(256 * 1024);
    expect(TRACE_ITEM_LABEL_MAX_BYTES).toBe(512);
    expect(TRACE_EVENT_MAX_BYTES).toBe(1024 * 1024);
  });

  it("keeps the legacy fragment sanitizer's caps for the read-only legacy writer", () => {
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
      const value = " ".repeat(cap - (structured ? 2 : 0));
      const atCap = structured ? JSON.stringify(value) : value;
      expect(sanitizeTraceEventFields({ type: "text", [field]: value })[field]).toBe(atCap);
      const overCap = structured ? JSON.stringify(value + " ") : value + " ";
      expect(sanitizeTraceEventFields({ type: "text", [field]: value + " " })[field])
        .toBe(overCap.slice(0, cap) + TRACE_TRUNCATION_MARKER);
    }
    for (const status of LEGACY_TRACE_STATUSES) expect(normalizeTraceStatus(status)).toBe(status);
    expect(TRACE_STATUSES.size).toBe(LEGACY_TRACE_STATUSES.length);
    expect(normalizeTraceStatus("unsupported")).toBeNull();
  });
});
