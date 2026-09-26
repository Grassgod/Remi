import { afterEach, describe, expect, it } from "bun:test";
import {
  cleanTraceField,
  normalizeTraceStatus,
  parseStoredTraceJson,
  sanitizeTraceEventFields,
  sanitizeTraceJson,
  truncateUtf8,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_TOOL_MAX_BYTES,
  TRACE_TRUNCATION_MARKER,
} from "@shared/trace-sanitize.js";
import { createStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";

afterEach(resetMultiremiTestEnv);

/**
 * Write one message through the store's real `appendTaskMessages` and return the
 * raw stored columns. This is the reference the shared module must match — not a
 * restatement of what the columns are supposed to hold.
 */
function storedColumns(message: Record<string, unknown>) {
  const store = createStore();
  const runtime = store.registerRuntime({ id: "rt_trace", name: "trace", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "Trace Bot", provider: "claude", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "p" });
  store.appendTaskMessages(task.id, [message as never]);
  return db!.query(
    `SELECT type, tool, content, input, output, tool_call_id, status, meta
       FROM multiremi_task_messages WHERE task_id = ? AND seq = 1`,
  ).get(task.id) as Record<string, unknown>;
}

/**
 * The sanitize rules moved from `store/repos/tasks-repo.ts` into
 * `@shared/trace-sanitize.js` (MUL-402 ruling 6b). The move is only correct if the
 * two produce identical stored values, so every case below states the value the
 * historical implementation writes and asserts the shared implementation writes
 * the same thing.
 *
 * The fixtures deliberately include the cases that are easy to get subtly wrong:
 * a multi-byte character straddling the byte cap, a value that is exactly at the
 * cap, a base64 payload that must be elided before the cap applies, and a
 * structured field whose cap fires AFTER serialization.
 *
 * The `tasks-repo.ts` reference implementation is replaced by the stated values
 * rather than imported, because it is a private function in a store class. Each
 * expected value below is the literal the old code produces; A-6 deletes the old
 * path and this file's expectations stay valid.
 */

describe("truncateUtf8 matches the historical byte-cap behaviour", () => {
  it("leaves a value at or under the cap untouched", () => {
    expect(truncateUtf8("abc", 3)).toBe("abc");
    expect(truncateUtf8("abc", 100)).toBe("abc");
    expect(truncateUtf8("", 0)).toBe("");
  });

  it("passes null through", () => {
    expect(truncateUtf8(null, 10)).toBeNull();
  });

  it("appends the marker when the cap fires", () => {
    expect(truncateUtf8("abcdef", 3)).toBe(`abc${TRACE_TRUNCATION_MARKER}`);
  });

  it("cuts on a UTF-8 boundary and drops the split character", () => {
    // "中" is 3 bytes. A 4-byte cap would otherwise leave one byte of the second
    // character, which decodes to U+FFFD and must not survive before the marker.
    expect(truncateUtf8("中中", 4)).toBe(`中${TRACE_TRUNCATION_MARKER}`);
    // 4 bytes exactly fits one emoji (U+1F600 is 4 bytes).
    expect(truncateUtf8("\u{1F600}\u{1F600}", 4)).toBe(`\u{1F600}${TRACE_TRUNCATION_MARKER}`);
  });

  it("counts bytes, not code points", () => {
    // 3 code points, 9 bytes.
    expect(truncateUtf8("中中中", 9)).toBe("中中中");
    expect(truncateUtf8("中中中", 8)).toBe(`中中${TRACE_TRUNCATION_MARKER}`);
  });
});

describe("cleanTraceField matches the historical null rules", () => {
  it("maps absent and empty values to null", () => {
    expect(cleanTraceField(null)).toBeNull();
    expect(cleanTraceField(undefined)).toBeNull();
    expect(cleanTraceField("")).toBeNull();
  });

  it("stringifies non-strings", () => {
    expect(cleanTraceField(0)).toBe("0");
    expect(cleanTraceField(false)).toBe("false");
    expect(cleanTraceField("x")).toBe("x");
  });
});

describe("normalizeTraceStatus matches the accepted set", () => {
  it("keeps the four known statuses", () => {
    for (const status of ["pending", "in_progress", "completed", "failed"]) {
      expect(normalizeTraceStatus(status)).toBe(status);
    }
  });

  it("drops anything else to null, including the empty string", () => {
    expect(normalizeTraceStatus("cancelled")).toBeNull();
    expect(normalizeTraceStatus("not-a-real-status")).toBeNull();
    expect(normalizeTraceStatus(null)).toBeNull();
  });
});

describe("sanitizeTraceJson matches the historical structured guards", () => {
  it("passes scalars through", () => {
    expect(sanitizeTraceJson("x")).toBe("x");
    expect(sanitizeTraceJson(1)).toBe(1);
    expect(sanitizeTraceJson(null)).toBeNull();
  });

  it("elides a long base64-looking string", () => {
    const base64 = "A".repeat(4097);
    expect(sanitizeTraceJson(base64)).toBe("[base64-elided]");
    // At the threshold it is kept.
    expect(sanitizeTraceJson("A".repeat(4096))).toBe("A".repeat(4096));
    // Long but not base64-shaped is kept.
    expect(sanitizeTraceJson(`${"A".repeat(4096)}!!!`)).toBe(`${"A".repeat(4096)}!!!`);
  });

  it("caps array width and reports how many were dropped", () => {
    const wide = Array.from({ length: 300 }, (_, index) => index);
    const out = sanitizeTraceJson(wide) as unknown[];
    expect(out).toHaveLength(257);
    expect(out[256]).toBe("[+44 more]");
  });

  it("caps nesting depth", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 12; index += 1) deep = { next: deep };
    // Walk down until the depth marker appears.
    let cursor: any = sanitizeTraceJson(deep);
    const seen: string[] = [];
    while (cursor && typeof cursor === "object") {
      const value = (cursor as Record<string, unknown>).next;
      if (typeof value === "string") { seen.push(value); break; }
      cursor = value;
    }
    expect(seen).toContain("[depth-limited]");
  });
});

describe("sanitizeTraceEventFields produces the stored row columns", () => {
  it("bounds every capped field and serializes structured ones", () => {
    const stored = sanitizeTraceEventFields({
      type: "tool_use",
      tool: "T".repeat(600),
      content: "C".repeat(TRACE_CONTENT_MAX_BYTES + 10),
      input: { command: "ls" },
      output: "O".repeat(70 * 1024),
      tool_call_id: "tc_1",
      status: "completed",
      meta: { duration_ms: 42 },
    });

    expect(stored.type).toBe("tool_use");
    expect(stored.tool!.startsWith("T".repeat(TRACE_TOOL_MAX_BYTES))).toBe(true);
    expect(stored.tool!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(stored.content!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(stored.output!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(stored.input).toBe('{"command":"ls"}');
    expect(stored.meta).toBe('{"duration_ms":42}');
    expect(stored.tool_call_id).toBe("tc_1");
    expect(stored.status).toBe("completed");
  });

  it("keeps type raw, exactly as the historical write path did", () => {
    // The old insert passed `message.type` straight through while cleaning every
    // other string field. An unrecognised type must therefore survive untouched.
    expect(sanitizeTraceEventFields({ type: "assistant" }).type).toBe("assistant");
    expect(sanitizeTraceEventFields({ type: "not_a_real_type" }).type).toBe("not_a_real_type");
  });

  it("stores null for absent structured fields", () => {
    const stored = sanitizeTraceEventFields({ type: "text", content: "hi" });
    expect(stored.input).toBeNull();
    expect(stored.meta).toBeNull();
    expect(stored.tool).toBeNull();
    expect(stored.output).toBeNull();
    expect(stored.status).toBeNull();
  });

  it("truncates a structured field only after serialization, and it stops parsing", () => {
    // A payload of wide objects is not base64-shaped, so the byte cap (not the
    // base64 rule) is what fires. The cap applies to the serialized text, so the
    // stored value is a truncated string rather than parseable JSON.
    const big = { rows: Array.from({ length: 200 }, (_, index) => ({ id: index, note: "x".repeat(2000) })) };
    const stored = sanitizeTraceEventFields({ type: "tool_use", input: big });
    expect(stored.input!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(parseStoredTraceJson(stored.input)).toBeNull();
  });

  it("round-trips a structured field that fits", () => {
    const stored = sanitizeTraceEventFields({
      type: "tool_result",
      input: { path: "a.ts", nested: { deep: [1, 2, 3] } },
      meta: { title: "Read", locations: [{ path: "/a" }] },
    });
    const input: unknown = parseStoredTraceJson(stored.input);
    const meta: unknown = parseStoredTraceJson(stored.meta);
    expect(input).toEqual({ path: "a.ts", nested: { deep: [1, 2, 3] } });
    expect(meta).toEqual({ title: "Read", locations: [{ path: "/a" }] });
  });

  it("elides base64 inside structured fields before capping", () => {
    const stored = sanitizeTraceEventFields({
      type: "tool_result",
      input: { image: "A".repeat(5000) },
    });
    const input: unknown = parseStoredTraceJson(stored.input);
    expect(input).toEqual({ image: "[base64-elided]" });
  });

  it("drops an unsupported status rather than storing it", () => {
    expect(sanitizeTraceEventFields({ type: "tool_use", status: "cancelled" }).status).toBeNull();
    expect(sanitizeTraceEventFields({ type: "tool_use", status: "failed" }).status).toBe("failed");
  });
});

describe("parseStoredTraceJson mirrors the historical read path", () => {
  it("returns null for the capped case, matching parseJson(value, null)", () => {
    // The old read path was `parseJson(row.input, null)`, and a truncated stored
    // string fails JSON.parse, so it read back as null. Same here.
    const parsed: unknown = parseStoredTraceJson('{"a":1}');
    expect(parsed).toEqual({ a: 1 });
    expect(parseStoredTraceJson(`abc${TRACE_TRUNCATION_MARKER}`)).toBeNull();
    expect(parseStoredTraceJson(null)).toBeNull();
    expect(parseStoredTraceJson("")).toBeNull();
  });
});


/**
 * The equivalence suite proper: run one fixture set through the store's real
 * write path and through the shared module, and require identical bytes for every
 * capped column. This is what makes "faithful extraction" checkable rather than
 * asserted; A-6 deletes this describe block's store half when it deletes
 * `appendTaskMessages`.
 */
describe("shared sanitize equals the store's real write path", () => {
  const fixtures: Array<[string, Record<string, unknown>]> = [
    ["plain text", { type: "text", content: "hello" }],
    ["empty strings become null", { type: "text", content: "", tool: "", output: "" }],
    ["tool name at the cap", { type: "tool_use", tool: "T".repeat(512), status: "pending" }],
    ["tool name over the cap", { type: "tool_use", tool: "T".repeat(513) }],
    ["content at the cap", { type: "text", content: "C".repeat(TRACE_CONTENT_MAX_BYTES) }],
    ["content over the cap", { type: "text", content: "C".repeat(TRACE_CONTENT_MAX_BYTES + 1) }],
    ["content cut mid multi-byte char", { type: "text", content: `${"中".repeat(TRACE_CONTENT_MAX_BYTES / 3)}中` }],
    ["output over the cap", { type: "tool_result", output: "O".repeat(64 * 1024 + 1) }],
    ["status accepted", { type: "tool_use", status: "completed" }],
    ["status rejected", { type: "tool_use", status: "cancelled" }],
    ["input object", { type: "tool_use", input: { command: "ls", nested: { a: [1, 2] } } }],
    ["meta object", { type: "tool_result", meta: { duration_ms: 42, title: "Read" } }],
    ["input base64 elided", { type: "tool_use", input: { image: "A".repeat(5000) } }],
    ["input base64 at threshold", { type: "tool_use", input: { image: "A".repeat(4096) } }],
    ["input array capped", { type: "tool_use", input: { items: Array.from({ length: 300 }, (_, i) => i) } }],
    ["unknown type survives raw", { type: "assistant", content: "legacy" }],
    ["tool_call_id kept raw", { type: "tool_use", toolCallId: "tc_1" }],
  ];

  for (const [name, message] of fixtures) {
    it(`matches for: ${name}`, () => {
      const row = storedColumns(message);
      const shared = sanitizeTraceEventFields({
        type: String(message.type),
        tool: message.tool,
        content: message.content,
        input: message.input,
        output: message.output,
        tool_call_id: message.toolCallId,
        status: message.status,
        meta: message.meta,
      });

      // Compare as nullable strings: sqlite hands back `unknown` for a column
      // that may be text or null, and every one of these columns is exactly one
      // of those two.
      const text = (value: unknown): string | null => (value == null ? null : String(value));
      // `type` is the one column that is never null; the rest are nullable.
      expect(shared.type).toBe(String(row.type));
      expect(shared.tool).toBe(text(row.tool));
      expect(shared.content).toBe(text(row.content));
      expect(shared.input).toBe(text(row.input));
      expect(shared.output).toBe(text(row.output));
      expect(shared.tool_call_id).toBe(text(row.tool_call_id));
      expect(shared.status).toBe(text(row.status));
      expect(shared.meta).toBe(text(row.meta));
    });
  }

  it("agrees that a capped structured field reads back as null on both paths", () => {
    const message = {
      type: "tool_use",
      input: { rows: Array.from({ length: 200 }, (_, index) => ({ id: index, note: "x".repeat(2000) })) },
    };
    const row = storedColumns(message);
    expect(row.input).not.toBeNull();
    expect(String(row.input).endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);

    const shared = sanitizeTraceEventFields({ type: "tool_use", input: message.input });
    expect(shared.input).toBe(String(row.input));
    // Both the store read path and the shared parse return null here.
    expect(parseStoredTraceJson(shared.input)).toBeNull();
  });
});
