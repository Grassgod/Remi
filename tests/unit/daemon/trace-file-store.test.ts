import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceFileStore, TRACE_FILE_MAX_EVENT_BYTES } from "@multiremi/worker/trace-file-store.js";
import { DAEMON_WS_MAX_PAYLOAD_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { encodeDaemonProtocolFrame, daemonFrameByteLimit } from "@multiremi/api/daemon-protocol/frames.js";
import { InMemoryTraceStore, traceEventBytes } from "@multiremi/worker/trace-store.js";
import type { TraceEventInput, TraceEventLine, TraceItem } from "@multiremi/contracts/trace.js";
import { checkTraceFileLines, TRACE_FILE_FORMAT_V1, TRACE_FILE_FORMAT_V2 } from "@multiremi/contracts/trace-file.js";
import { TRACE_EVENT_MAX_BYTES, TRACE_ITEM_INPUT_MAX_BYTES, TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";
import { contractMessage, contractSnapshot, describeTraceStoreContract } from "./trace-store-contract.js";

const NOW = "2026-09-27T00:00:00.000Z";
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(sessionId: string | null = "ises_one", subjectId = sessionId ? "iss_one" : "tsk_one") {
  const root = mkdtempSync(join(tmpdir(), "trace-file-store-"));
  roots.push(root);
  const warnings: string[] = [];
  const make = (extra: { residentClosedLimit?: number; onReadBytes?: (bytes: number) => void } = {}) => new TraceFileStore({
    workspacesRoot: root,
    resolveTask: () => ({ sessionId, subjectId, agentId: "agt_one", provider: "codex", startedAt: NOW }),
    now: () => NOW,
    onWarning: (_path, reason) => warnings.push(reason),
    ...extra,
  });
  const path = join(root, "traces", subjectId, "tsk_one.jsonl");
  return { root, path, make, warnings };
}

let rowCounter = 0;
/** One v2 event: a completed agent message carrying `text`. */
function row(text: string): TraceEventInput {
  return { type: "item.completed", item: contractMessage(`msg:${++rowCounter}`, text) };
}
/** The text of a stored `row()` event. */
function text(event: TraceEventLine | undefined): string | undefined {
  return (event as { item?: { text?: string } } | undefined)?.item?.text;
}
function withText(event: TraceEventLine, value: string): TraceEventLine {
  const item = (event as unknown as { item: TraceItem }).item;
  return { ...event, item: { ...item, text: value } } as TraceEventLine;
}
function fileLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

describeTraceStoreContract("TraceFileStore", () => fixture().make(), () => {
  const { path, make } = fixture();
  const store = make();
  store.append("tsk_one", [row("one"), row("ten"), row("twenty")]);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (const [index, seq] of [[2, 10], [3, 20]] as const) {
    const event = JSON.parse(lines[index]!);
    lines[index] = JSON.stringify({ ...event, seq });
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return make();
});

describe("TraceFileStore", () => {
  it("keeps every stored event under the frame budget and drops one over the event ceiling", () => {
    const store = fixture().make();
    // The largest body the store keeps: exactly the 1 MiB event ceiling.
    const base = Buffer.byteLength(JSON.stringify({ type: "x", pad: "" }), "utf8");
    const largest = { type: "x", pad: "p".repeat(TRACE_EVENT_MAX_BYTES - base) } as unknown as TraceEventInput;
    const event = store.append("tsk_one", [largest]).events[0]!;
    expect(traceEventBytes(event)).toBeLessThanOrEqual(TRACE_FILE_MAX_EVENT_BYTES);
    for (const frameType of ["trace.append", "trace.push", "res"]) {
      const payload = { task_id: "tsk_one", events: [event], head: 1, eof: true, closed: false, next_after_seq: 1, ok: true };
      const frame = encodeDaemonProtocolFrame({ t: frameType, id: "id", re: "read", rt: "rt", p: payload }, 1);
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(DAEMON_WS_MAX_PAYLOAD_BYTES);
      expect(daemonFrameByteLimit(frameType, payload)).toBe(DAEMON_WS_MAX_PAYLOAD_BYTES);
    }
    const over = { type: "x", pad: "p".repeat(TRACE_EVENT_MAX_BYTES - base + 1) } as unknown as TraceEventInput;
    expect(store.append("tsk_one", [row("kept"), over]).events.map((stored) => stored.seq)).toEqual([2]);
    expect(store.head("tsk_one")!.head).toBe(2);
  });
  it("bounds a page by bytes even when the caller omits or disables its budget", () => {
    const store = fixture().make();
    store.append("tsk_one", Array.from({ length: 16 }, () => row("!".repeat(200_000))));
    const page = store.read("tsk_one");
    expect(page.events).toHaveLength(10);
    expect(page.events.reduce((bytes, event) => bytes + traceEventBytes(event), 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(page.eof).toBe(false);
    expect(store.read("tsk_one", 0, 500, Infinity).events).toHaveLength(10);
    expect(store.read("tsk_one", 10).events).toHaveLength(6);
  });

  it("canonicalizes recovered duplicates before closing and restarting", () => {
    const { make, path } = fixture();
    const store = make(); store.append("tsk_one", [row("first"), row("second")]);
    const duplicate = withText(store.read("tsk_one").events[0]!, "duplicate");
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(duplicate)}\n{"seq":3`);
    const recovered = make(); recovered.append("tsk_one", [row("third")]);
    recovered.close("tsk_one", { status: "completed", ended_at: NOW });
    const next = make();
    expect(next.head("tsk_one")).toEqual({ head: 3, closed: true });
    expect(next.read("tsk_one").events.map(text)).toEqual(["first", "second", "third"]);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => JSON.parse(line)).filter((row) => row.seq !== undefined).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("recovers escaped strings at the event ceiling byte for byte", () => {
    const { make } = fixture();
    const original = make();
    // JSON escapes U+0001 as six bytes, so 160 Ki of them serialize near the 1 MiB ceiling.
    const expected = original.append("tsk_one", [row("\u0001".repeat(160 * 1024))]).events;
    expect(traceEventBytes(expected[0]!)).toBeGreaterThan(900 * 1024);
    expect(make().read("tsk_one").events).toEqual(expected);
  });

  it("drops an event over the ceiling before any row of its batch reaches disk", () => {
    const { make } = fixture();
    const store = make();
    const over = { type: "x", blob: "x".repeat(TRACE_EVENT_MAX_BYTES) } as unknown as TraceEventInput;
    expect(store.append("tsk_one", [over]).events).toEqual([]);
    expect(store.head("tsk_one")).toEqual({ head: 0, closed: false });
    expect(make().head("tsk_one")).toEqual({ head: 0, closed: false });
    expect(store.read("tsk_one").events).toEqual([]);
  });

  it("seeks directly to bounded pages of a large recovered file", () => {
    const { root } = fixture();
    let bytesRead = 0;
    const make = () => new TraceFileStore({ workspacesRoot: root,
      resolveTask: () => ({ sessionId: "ises_large", subjectId: "iss_large", agentId: "agt", provider: "codex", runtimeId: "rt_large", startedAt: NOW }),
      onReadBytes: bytes => { bytesRead += bytes; } });
    const original = make();
    for (let batch = 0; batch < 100; batch++) original.append("tsk_large", Array.from({ length: 100 }, () => row("x".repeat(1024))));
    original.close("tsk_large", { status: "completed", ended_at: NOW });
    const recovered = make();
    expect(recovered.owner("tsk_large")).toBe("rt_large");
    bytesRead = 0;
    expect(recovered.read("tsk_large", 9990, 2, 4096).events.map(event => event.seq)).toEqual([9991, 9992]);
    expect(bytesRead).toBeLessThanOrEqual(64 * 1024);
    bytesRead = 0;
    expect(recovered.read("tsk_large", 5000, 2, 4096).events.map(event => event.seq)).toEqual([5001, 5002]);
    expect(bytesRead).toBeLessThanOrEqual(64 * 1024);
    expect(recovered.head("tsk_large")).toEqual({ head: 10000, closed: true });
  });

  it("writes v2 framing without seq and keeps the in-memory contract across restart", () => {
    const { path, make } = fixture();
    const file = make();
    const memory = new InMemoryTraceStore(() => NOW);
    const batch: TraceEventInput[] = [row("one"), { type: "turn.updated", patch: { model: "gpt" } }];
    expect(file.append("tsk_one", batch)).toEqual(memory.append("tsk_one", batch));
    const three = [row("three")];
    expect(file.append("tsk_one", three)).toEqual(memory.append("tsk_one", three));
    expect(file.read("tsk_one", 1, 1)).toEqual(memory.read("tsk_one", 1, 1));
    const snapshot = contractSnapshot([contractMessage("msg:a", "one"), contractMessage("msg:b", "three")], 3);
    file.close("tsk_one", { status: "failed", ended_at: NOW, snapshot });
    memory.close("tsk_one", { status: "failed", ended_at: NOW, snapshot });
    const lines = fileLines(path);
    expect(lines[0]).toEqual({ format: TRACE_FILE_FORMAT_V2, task_id: "tsk_one", session_id: "ises_one", agent_id: "agt_one", provider: "codex", started_at: NOW });
    expect(lines.slice(1, 4).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(lines[4]).toEqual({ snapshot: { part: 0, parts: 1, head: 3, turn: snapshot.turn, items: snapshot.items } });
    expect(lines.at(-1)).toEqual({ end: { status: "failed", head: 3, event_count: 3, ended_at: NOW, snapshot_parts: 1 } });
    for (const framing of [lines[0], lines[4], lines.at(-1)]) expect(framing).not.toHaveProperty("seq");
    expect(checkTraceFileLines(readFileSync(path, "utf8").trimEnd().split("\n"))).toEqual({ ok: true,
      value: { head: 3, event_count: 3, closed: true, duplicate_seqs: [], format: "v2", snapshot_parts: 1 } });
    const recovered = make();
    expect(recovered.head("tsk_one")).toEqual(memory.head("tsk_one"));
    expect(recovered.read("tsk_one")).toEqual(memory.read("tsk_one"));
    expect(recovered.snapshotPart("tsk_one", 0)).toEqual(memory.snapshotPart("tsk_one", 0));
    expect(recovered.snapshotPart("tsk_one", 1)).toBeNull();
    expect(recovered.append("tsk_one", [row("late")])).toEqual({ head: 3, events: [] });
    recovered.close("tsk_one", { status: "completed", ended_at: NOW });
    expect(fileLines(path).at(-1)).toEqual(lines.at(-1));
  });

  it("uses task-owned roots for one-shot tasks and closes unseen tasks", () => {
    const { path, make } = fixture(null);
    const store = make();
    expect(store.head("tsk_one")).toBeNull();
    expect(store.read("tsk_one")).toEqual({ events: [], head: 0, eof: true });
    store.close("tsk_one", { status: "cancelled", ended_at: NOW });
    expect(store.head("tsk_one")).toEqual({ head: 0, closed: true });
    expect(JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!)).toMatchObject({ end: { status: "cancelled", event_count: 0, snapshot_parts: 0 } });
  });

  it("shares item caps, structured guards and base64 elision with memory", () => {
    const { make } = fixture();
    const file = make();
    const memory = new InMemoryTraceStore(() => NOW);
    const tool: TraceItem = {
      id: "call_1", parent_id: null, status: "completed", started_at: NOW, completed_at: NOW, type: "tool",
      tool: "t".repeat(600), server: null, kind: "other", title: "x".repeat(600),
      input: { payload: "A".repeat(5000), items: Array.from({ length: 300 }, (_, i) => i) },
      output: "o".repeat(70_000), duration_ms: 1,
    };
    const input: TraceEventInput = { type: "item.completed", item: tool };
    const stored = file.append("tsk_one", [input]);
    expect(stored).toEqual(memory.append("tsk_one", [input]));
    const item = (stored.events[0] as unknown as { item: Extract<TraceItem, { type: "tool" }> }).item;
    expect(item.tool.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(item.title!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(item.output).toContain(TRACE_TRUNCATION_MARKER);
    expect(item.output_truncated).toBe(true);
    expect(item.input).toMatchObject({ payload: "[base64-elided]" });
    expect((item.input!.items as unknown[]).at(-1)).toBe("[+44 more]");
    expect(item.input_truncated).toBe(true);
    const big = file.append("tsk_one", [{ type: "item.completed", item: { ...tool, id: "call_2", input: { body: "!".repeat(TRACE_ITEM_INPUT_MAX_BYTES * 2) } } }]).events[0]!;
    const bigInput = (big as unknown as { item: { input: Record<string, string> } }).item.input;
    expect(Buffer.byteLength(JSON.stringify(bigInput), "utf8")).toBeLessThanOrEqual(TRACE_ITEM_INPUT_MAX_BYTES);
    const depth = file.append("tsk_one", [{ type: "item.completed", item: { ...tool, id: "call_3",
      input: { a: { b: { c: { d: { e: { f: { g: { h: { i: "deep" } } } } } } } } } } }]).events[0]!;
    expect(JSON.stringify(depth)).toContain("[depth-limited]");
  });

  it("discards an incomplete tail, retains the first duplicate seq and resumes at max seq", () => {
    const { path, make, warnings } = fixture();
    const store = make();
    store.append("tsk_one", [row("first"), row("second")]);
    const duplicate = withText(store.read("tsk_one").events[0]!, "duplicate");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}${JSON.stringify(duplicate)}\n{"seq":3`);
    const recovered = make();
    expect(recovered.read("tsk_one").events.map(text)).toEqual(["first", "second"]);
    expect(warnings.some((warning) => warning.includes("duplicate seq 1"))).toBe(true);
    expect(recovered.append("tsk_one", [row("third")]).events[0]!.seq).toBe(3);
    expect(readFileSync(path, "utf8")).not.toContain('{"seq":3{"');
  });

  it("reads a sparse recovered trace by seq and rejects out-of-order corruption", () => {
    const { path, make, warnings } = fixture();
    const store = make();
    store.append("tsk_one", [row("one")]);
    const event = { ...withText(store.read("tsk_one").events[0]!, "ten"), seq: 10 };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(event)}\n`);
    const recovered = make();
    expect(recovered.head("tsk_one")).toEqual({ head: 10, closed: false });
    expect(recovered.read("tsk_one", 1).events.map((item) => item.seq)).toEqual([10]);
    const outOfOrder = { ...event, seq: 5 };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(outOfOrder)}\n`);
    expect(make().head("tsk_one")).toBeNull();
    expect(warnings.some((warning) => warning.includes("out-of-order seq"))).toBe(true);
  });

  it("skips corrupt files during index recovery without losing healthy tasks", () => {
    const { root, make, warnings } = fixture();
    make().append("tsk_one", [row("healthy")]);
    const bad = join(root, "traces", "iss_other");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "tsk_bad.jsonl"), "invalid header\n");
    const recovered = make();
    expect(recovered.head("tsk_one")).toEqual({ head: 1, closed: false });
    expect(recovered.head("tsk_bad")).toBeNull();
    expect(warnings.some((warning) => warning.includes("invalid header JSON"))).toBe(true);
  });

  it("does not follow a trace file replaced by a symlink", () => {
    const { root, path, make } = fixture();
    const store = make();
    store.append("tsk_one", [row("first")]);
    const target = join(root, "outside.txt");
    writeFileSync(target, "keep me");
    renameSync(path, `${path}.old`);
    symlinkSync(target, path);
    expect(() => store.append("tsk_one", [row("second")])).toThrow();
    expect(() => store.read("tsk_one")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("keep me");
  });

  for (const operation of ["append", "read", "close", "forget"] as const) {
    it(`rejects ${operation} when the traces parent is replaced by a symlink`, () => {
      const { root, path, make, warnings } = fixture();
      const store = make();
      store.append("tsk_one", [row("first")]);
      const outside = mkdtempSync(join(tmpdir(), "trace-outside-"));
      roots.push(outside);
      const traces = join(root, "traces", "iss_one");
      renameSync(traces, join(outside, "traces"));
      symlinkSync(join(outside, "traces"), traces);
      const outsideFile = join(outside, "traces", "tsk_one.jsonl");
      const original = readFileSync(outsideFile, "utf8");
      expect(() => {
        if (operation === "append") store.append("tsk_one", [row("second")]);
        else if (operation === "read") store.read("tsk_one");
        else if (operation === "close") store.close("tsk_one", { status: "completed", ended_at: NOW });
        else store.forget("tsk_one");
      }).toThrow();
      expect(readFileSync(outsideFile, "utf8")).toBe(original);
      expect(warnings.some((warning) => warning.includes("real directory"))).toBe(operation === "forget");
      expect(path).toBe(join(traces, "tsk_one.jsonl"));
    });
  }

  it("recovers a completed trailer after restart", () => {
    const { path, make } = fixture();
    const store = make();
    store.append("tsk_one", [row("done")]);
    store.close("tsk_one", { status: "completed", ended_at: NOW });
    const recovered = make();
    expect(recovered.head("tsk_one")).toEqual({ head: 1, closed: true });
    expect(recovered.read("tsk_one").events.map(text)).toEqual(["done"]);
    expect(JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!)).toEqual({
      end: { status: "completed", head: 1, event_count: 1, ended_at: NOW, snapshot_parts: 0 },
    });
  });

  describe("lazy index", () => {
    function writeClosedTraces(make: ReturnType<typeof fixture>["make"], count: number) {
      const writer = make();
      for (let i = 0; i < count; i++) {
        writer.append(`tsk_${i}`, [row(`event ${i}`)]);
        writer.close(`tsk_${i}`, { status: "completed", ended_at: NOW });
      }
    }

    it("starting the store lists trace files without opening any of them", () => {
      const { make } = fixture();
      writeClosedTraces(make, 5);
      let bytesRead = 0;
      const recovered = make({ onReadBytes: (bytes) => { bytesRead += bytes; } });
      expect(bytesRead).toBe(0);
      expect(recovered.ownership().size).toBe(0);
    });

    it("indexes a trace the first time it is read, appended to or asked about", () => {
      const { make } = fixture();
      writeClosedTraces(make, 3);
      let bytesRead = 0;
      const recovered = make({ onReadBytes: (bytes) => { bytesRead += bytes; } });
      expect(recovered.head("tsk_1")).toEqual({ head: 1, closed: true });
      expect(bytesRead).toBeGreaterThan(0);
      const afterOne = bytesRead;
      expect(recovered.read("tsk_1").events.map(text)).toEqual(["event 1"]);
      expect(recovered.head("tsk_1")).toEqual({ head: 1, closed: true });
      expect(bytesRead).toBeGreaterThanOrEqual(afterOne);
      expect(recovered.head("never_written")).toBeNull();
      expect(recovered.append("tsk_2", [row("late")])).toEqual({ head: 1, events: [] });
    });

    it("keeps only the most recently used closed indexes resident and re-reads an evicted one", () => {
      const { make } = fixture();
      writeClosedTraces(make, 5);
      let bytesRead = 0;
      const recovered = make({ residentClosedLimit: 2, onReadBytes: (bytes) => { bytesRead += bytes; } });
      for (let i = 0; i < 5; i++) recovered.head(`tsk_${i}`);
      expect(recovered.ownership().size).toBeLessThanOrEqual(2);
      bytesRead = 0;
      recovered.head("tsk_4");
      expect(bytesRead).toBe(0);
      recovered.head("tsk_0");
      expect(bytesRead).toBeGreaterThan(0);
      expect(recovered.read("tsk_0").events.map(text)).toEqual(["event 0"]);
    });

    it("never evicts an open trace, however many closed ones come and go", () => {
      const { make } = fixture();
      writeClosedTraces(make, 4);
      const store = make({ residentClosedLimit: 1 });
      store.registerTask("tsk_open", { sessionId: "ises_one", subjectId: "iss_one", agentId: "agt", provider: "codex", startedAt: NOW, runtimeId: "rt_open" });
      store.append("tsk_open", [row("live")]);
      for (let i = 0; i < 4; i++) store.head(`tsk_${i}`);
      expect(store.ownership().get("tsk_open")).toBe("rt_open");
      expect(store.append("tsk_open", [row("still live")]).events.map((event) => event.seq)).toEqual([2]);
    });

    it("closing a trace makes its index evictable", () => {
      const { make } = fixture();
      const store = make({ residentClosedLimit: 0 });
      store.registerTask("tsk_a", { sessionId: "ises_one", subjectId: "iss_one", agentId: "agt", provider: "codex", startedAt: NOW, runtimeId: "rt_a" });
      store.append("tsk_a", [row("a")]);
      expect(store.ownership().size).toBe(1);
      store.close("tsk_a", { status: "completed", ended_at: NOW });
      expect(store.ownership().size).toBe(0);
      expect(store.read("tsk_a").events.map(text)).toEqual(["a"]);
    });

    it("finds the traces a crash left open from the end of each file, indexing only those", async () => {
      const { root, make } = fixture();
      writeClosedTraces(make, 4);
      const writer = make();
      writer.registerTask("tsk_open", { sessionId: "ises_one", subjectId: "iss_one", agentId: "agt", provider: "codex", startedAt: NOW, runtimeId: "rt_open" });
      writer.append("tsk_open", [row("live"), row("more")]);
      // An interrupted final line is not part of the trace.
      appendFileSync(join(root, "traces", "iss_one", "tsk_open.jsonl"), '{"seq":3,"type":"te');
      let bytesRead = 0;
      const recovered = make({ onReadBytes: (bytes) => { bytesRead += bytes; } });

      expect([...await recovered.findUnclosed()]).toEqual([["tsk_open", "rt_open"]]);

      // The closed history stayed unindexed: only the open trace was read in full.
      expect(recovered.ownership().size).toBe(1);
      expect(bytesRead).toBeLessThan(2048);
      expect(recovered.append("tsk_open", [row("resumed")]).events.map((event) => event.seq)).toEqual([3]);
    });

    it("prunes the paths of files removed from disk, indexed or not", () => {
      const { root, make } = fixture();
      writeClosedTraces(make, 3);
      const store = make();
      store.head("tsk_0");
      rmSync(join(root, "traces", "iss_one", "tsk_0.jsonl"));
      rmSync(join(root, "traces", "iss_one", "tsk_1.jsonl"));
      expect(store.pruneMissing().sort()).toEqual(["tsk_0", "tsk_1"]);
      expect(store.head("tsk_0")).toBeNull();
      expect(store.head("tsk_1")).toBeNull();
      expect(store.head("tsk_2")).toEqual({ head: 1, closed: true });
      expect(store.pruneMissing()).toEqual([]);
    });

    it("warns about and ignores a task id found under two subjects", () => {
      const { root, path, make, warnings } = fixture();
      make().append("tsk_one", [row("original")]);
      const other = join(root, "traces", "iss_other");
      mkdirSync(other);
      writeFileSync(join(other, "tsk_one.jsonl"), readFileSync(path, "utf8"));
      const recovered = make();
      expect(warnings.some((warning) => warning.includes("duplicate task id"))).toBe(true);
      expect(recovered.read("tsk_one").events.map(text)).toEqual(["original"]);
    });

    it("creates traces below the subject directory and refuses an unsafe subject id", () => {
      const { root, make } = fixture();
      const store = make();
      store.registerTask("tsk_x", { sessionId: "chat_1", subjectId: "chat_1", agentId: "agt", provider: "claude", startedAt: NOW });
      store.append("tsk_x", [row("x")]);
      expect(readFileSync(join(root, "traces", "chat_1", "tsk_x.jsonl"), "utf8")).toContain('"session_id":"chat_1"');
      store.registerTask("tsk_y", { sessionId: "chat_1", subjectId: "../escape", agentId: "agt", provider: "claude", startedAt: NOW });
      expect(() => store.append("tsk_y", [row("y")])).toThrow("Invalid trace subject id");
    });
  });

  describe("format v1 (read-only legacy)", () => {
    function writeV1(path: string, options: { closed: boolean; taskId?: string }) {
      mkdirSync(join(path, ".."), { recursive: true });
      const taskId = options.taskId ?? "tsk_one";
      const header = { format: TRACE_FILE_FORMAT_V1, task_id: taskId, session_id: "ises_one", agent_id: "agt_one", provider: "codex",
        started_at: NOW, runtime_id: "rt_v1" };
      const events = [
        { seq: 1, ts: NOW, type: "text", content: "legacy answer" },
        { seq: 2, ts: NOW, type: "tool_use", tool: "Bash", tool_call_id: "tc", status: "completed" },
      ];
      const trailer = { end: { status: "completed", head: 2, event_count: 2, ended_at: NOW } };
      writeFileSync(path, [header, ...events, ...(options.closed ? [trailer] : [])].map((line) => `${JSON.stringify(line)}\n`).join(""));
      return events;
    }

    it("reads a v1 file's raw lines and reports its format", () => {
      const { path, make } = fixture();
      const events = writeV1(path, { closed: true });
      const store = make();
      expect(store.format("tsk_one")).toBe("v1");
      expect(store.head("tsk_one")).toEqual({ head: 2, closed: true });
      expect(store.read("tsk_one").events).toEqual(events);
      expect(store.snapshotPart("tsk_one", 0)).toBeNull();
    });

    it("never appends to or closes a v1 file", () => {
      const { path, make } = fixture();
      writeV1(path, { closed: false });
      const before = readFileSync(path, "utf8");
      const store = make();
      expect(() => store.append("tsk_one", [row("new")])).toThrow("v1 trace is read-only");
      expect(() => store.close("tsk_one", { status: "completed", ended_at: NOW })).toThrow("v1 trace is read-only");
      expect(readFileSync(path, "utf8")).toBe(before);
      // A closed v1 file's close stays the idempotent no-op it always was.
      const closed = fixture();
      writeV1(closed.path, { closed: true });
      expect(() => closed.make().close("tsk_one", { status: "failed", ended_at: NOW })).not.toThrow();
    });

    it("leaves an unclosed v1 file out of crash recovery", async () => {
      const { root, path, make } = fixture();
      writeV1(path, { closed: false });
      const writer = make();
      writer.registerTask("tsk_open", { sessionId: "ises_one", subjectId: "iss_one", agentId: "agt", provider: "codex", startedAt: NOW, runtimeId: "rt_open" });
      writer.append("tsk_open", [row("live")]);
      expect(readFileSync(join(root, "traces", "iss_one", "tsk_open.jsonl"), "utf8")).toContain(TRACE_FILE_FORMAT_V2);
      expect([...await make().findUnclosed()]).toEqual([["tsk_open", "rt_open"]]);
    });
  });

  describe("crash inside close() (decision Q2)", () => {
    function closedFile() {
      const f = fixture();
      const store = f.make();
      store.registerTask("tsk_one", { sessionId: "ises_one", subjectId: "iss_one", agentId: "agt_one", provider: "codex", startedAt: NOW, runtimeId: "rt_one" });
      store.append("tsk_one", [row("one"), row("two")]);
      const items = Array.from({ length: 4 }, (_, index) => contractMessage(`m${index}`, String(index).repeat(300 * 1024)));
      store.close("tsk_one", { status: "completed", ended_at: NOW, snapshot: contractSnapshot(items, 2) });
      const lines = readFileSync(f.path, "utf8").split("\n").filter(Boolean);
      return { ...f, lines, items };
    }

    for (const cut of ["after one snapshot part", "inside a snapshot part", "inside the trailer"] as const) {
      it(`truncates unsealed snapshot framing ${cut} and re-closes cleanly`, async () => {
        const { path, make, lines, warnings } = closedFile();
        const snapshotLines = lines.filter((line) => line.startsWith('{"snapshot"'));
        expect(snapshotLines.length).toBeGreaterThan(1);
        const eventsEnd = lines.slice(0, 3).join("\n").length + 1;
        const firstSnapshotEnd = eventsEnd + snapshotLines[0]!.length + 1;
        const total = readFileSync(path).length;
        const at = cut === "after one snapshot part" ? firstSnapshotEnd
          : cut === "inside a snapshot part" ? firstSnapshotEnd + 100
            : total - 10;
        truncateSync(path, at);
        const recovered = make();
        expect(recovered.head("tsk_one")).toEqual({ head: 2, closed: false });
        expect(recovered.snapshotPart("tsk_one", 0)).toBeNull();
        expect([...await make().findUnclosed()]).toEqual([["tsk_one", "rt_one"]]);
        if (cut !== "inside the trailer" || snapshotLines.length) {
          expect(warnings.some((warning) => warning.includes("unsealed snapshot framing"))).toBe(true);
        }
        recovered.close("tsk_one", { status: "completed", ended_at: NOW, snapshot: contractSnapshot([contractMessage("m", "again")], 2) });
        const check = checkTraceFileLines(readFileSync(path, "utf8").trimEnd().split("\n"));
        expect(check).toEqual({ ok: true, value: { head: 2, event_count: 2, closed: true, duplicate_seqs: [], format: "v2", snapshot_parts: 1 } });
        const reopened = make();
        expect(reopened.head("tsk_one")).toEqual({ head: 2, closed: true });
        expect(reopened.snapshotPart("tsk_one", 0)?.items.map((item) => item.id)).toEqual(["m"]);
        expect(reopened.read("tsk_one").events.map(text)).toEqual(["one", "two"]);
      });
    }

    it("serves every snapshot part of a large closed trace after restart", () => {
      const { make, items } = closedFile();
      const recovered = make();
      const ids: string[] = [];
      for (let part = 0; ; part++) {
        const snapshot = recovered.snapshotPart("tsk_one", part);
        if (!snapshot) break;
        ids.push(...snapshot.items.map((item) => item.id));
      }
      expect(ids).toEqual(items.map((item) => item.id));
    });
  });
});
