import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceFileStore, TRACE_FILE_MAX_EVENT_BYTES } from "@multiremi/worker/trace-file-store.js";
import { DAEMON_WS_MAX_PAYLOAD_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { encodeDaemonProtocolFrame, daemonFrameByteLimit } from "@multiremi/api/daemon-protocol/frames.js";
import { InMemoryTraceStore, traceEventBytes, sanitizeStoredEvent } from "@multiremi/worker/trace-store.js";
import type { TraceEventInput } from "@multiremi/contracts/trace.js";
import { TRACE_FILE_FORMAT } from "@multiremi/contracts/trace-file.js";
import { TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";
import { describeTraceStoreContract } from "./trace-store-contract.js";

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

function row(content: string): TraceEventInput { return { type: "text", content }; }

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
  it("reserves envelope space for every maximum-size stored event", () => {
    const store = fixture().make();
    const overhead = traceEventBytes({ ...sanitizeStoredEvent({ type: "x" }, NOW), seq: 1 }) - 1;
    const type = "x".repeat(TRACE_FILE_MAX_EVENT_BYTES - overhead);
    const event = store.append("tsk_one", [{ type }]).events[0]!;
    expect(traceEventBytes(event)).toBe(TRACE_FILE_MAX_EVENT_BYTES);
    for (const frameType of ["trace.append", "trace.push", "res"]) {
      const payload = { task_id: "tsk_one", events: [event], head: 1, eof: true, closed: false, next_after_seq: 1, ok: true };
      const frame = encodeDaemonProtocolFrame({ t: frameType, id: "id", re: "read", rt: "rt", p: payload }, 1);
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(DAEMON_WS_MAX_PAYLOAD_BYTES);
      expect(daemonFrameByteLimit(frameType, payload)).toBe(DAEMON_WS_MAX_PAYLOAD_BYTES);
    }
    expect(() => store.append("tsk_one", [{ type: `${type}x` }])).toThrow("trace line exceeds");
    expect(store.head("tsk_one")!.head).toBe(1);
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
    const duplicate = { ...store.read("tsk_one").events[0], content: "duplicate" };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(duplicate)}\n{"seq":3`);
    const recovered = make(); recovered.append("tsk_one", [row("third")]);
    recovered.close("tsk_one", { status: "completed", ended_at: NOW });
    const next = make();
    expect(next.head("tsk_one")).toEqual({ head: 3, closed: true });
    expect(next.read("tsk_one").events.map(event => event.content)).toEqual(["first", "second", "third"]);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => JSON.parse(line)).filter((row) => row.seq !== undefined).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("recovers normalized strings whose JSON escaping expands beyond two MiB", () => {
    const { make } = fixture();
    const original = make();
    const expected = original.append("tsk_one", [{ type: "text", content: "\u0001".repeat(256 * 1024), output: "\u0001".repeat(64 * 1024),
      input: { body: "!".repeat(250_000) }, meta: { body: "!".repeat(60_000) } }]).events;
    expect(traceEventBytes(expected[0]!)).toBeGreaterThan(2 * 1024 * 1024);
    expect(make().read("tsk_one").events).toEqual(expected);
  });

  it("rejects an oversized record before any row of its batch reaches disk", () => {
    const { make } = fixture();
    const store = make();
    expect(() => store.append("tsk_one", [row("first"), { type: "x".repeat(4 * 1024 * 1024) }]))
      .toThrow("trace line exceeds normalized event budget");
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

  it("writes framing without seq and keeps the in-memory contract across restart", () => {
    const { path, make } = fixture();
    const file = make();
    const memory = new InMemoryTraceStore(() => NOW);
    const batch = [row("one"), { type: "tool_use", tool: "Bash", input: { command: "pwd" } }];
    expect(file.append("tsk_one", batch)).toEqual(memory.append("tsk_one", batch));
    expect(file.append("tsk_one", [row("three")])).toEqual(memory.append("tsk_one", [row("three")]));
    expect(file.read("tsk_one", 1, 1)).toEqual(memory.read("tsk_one", 1, 1));
    file.close("tsk_one", { status: "failed", ended_at: NOW });
    memory.close("tsk_one", { status: "failed", ended_at: NOW });
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ format: TRACE_FILE_FORMAT, task_id: "tsk_one", session_id: "ises_one", agent_id: "agt_one", provider: "codex", started_at: NOW });
    expect(lines[0]).not.toHaveProperty("seq");
    expect(lines.slice(1, -1).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(lines.at(-1)).toEqual({ end: { status: "failed", head: 3, event_count: 3, ended_at: NOW } });
    expect(lines.at(-1)).not.toHaveProperty("seq");
    const recovered = make();
    expect(recovered.head("tsk_one")).toEqual(memory.head("tsk_one"));
    expect(recovered.read("tsk_one")).toEqual(memory.read("tsk_one"));
    expect(recovered.append("tsk_one", [row("late")])).toEqual({ head: 3, events: [] });
    recovered.close("tsk_one", { status: "completed", ended_at: NOW });
    expect(JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!)).toEqual(lines.at(-1));
  });

  it("uses task-owned roots for one-shot tasks and closes unseen tasks", () => {
    const { path, make } = fixture(null);
    const store = make();
    expect(store.head("tsk_one")).toBeNull();
    expect(store.read("tsk_one")).toEqual({ events: [], head: 0, eof: true });
    store.close("tsk_one", { status: "cancelled", ended_at: NOW });
    expect(store.head("tsk_one")).toEqual({ head: 0, closed: true });
    expect(JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!)).toMatchObject({ end: { status: "cancelled", event_count: 0 } });
  });

  it("shares byte caps, structured guards and base64 elision with memory", () => {
    const { make } = fixture();
    const file = make();
    const memory = new InMemoryTraceStore(() => NOW);
    const input: TraceEventInput = {
      type: "tool_use", tool: "t".repeat(600), content: "c".repeat(270_000),
      input: { payload: "A".repeat(5000), items: Array.from({ length: 300 }, (_, i) => i) },
      output: "o".repeat(70_000), meta: { nested: { payload: "A".repeat(5000) } },
    };
    const stored = file.append("tsk_one", [input]);
    expect(stored).toEqual(memory.append("tsk_one", [input]));
    expect(stored.events[0]!.tool!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(stored.events[0]!.content!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(stored.events[0]!.output!.endsWith(TRACE_TRUNCATION_MARKER)).toBe(true);
    expect(stored.events[0]!.input).toMatchObject({ payload: "[base64-elided]" });
    expect((stored.events[0]!.input!.items as unknown[]).at(-1)).toBe("[+44 more]");
    const capped = file.append("tsk_one", [{
      type: "tool_use", input: { payload: "!".repeat(270_000) }, meta: { payload: "!".repeat(70_000) },
    }]).events[0]!;
    expect(capped.input).toBeNull();
    expect(capped.meta).toBeNull();
    const depth = file.append("tsk_one", [{
      type: "tool_use", input: { a: { b: { c: { d: { e: { f: { g: { h: { i: "deep" } } } } } } } } },
    }]).events[0]!;
    expect(JSON.stringify(depth.input)).toContain("[depth-limited]");
  });

  it("discards an incomplete tail, retains the first duplicate seq and resumes at max seq", () => {
    const { path, make, warnings } = fixture();
    const store = make();
    store.append("tsk_one", [row("first"), row("second")]);
    const duplicate = { ...store.read("tsk_one").events[0], content: "duplicate" };
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}${JSON.stringify(duplicate)}\n{"seq":3`);
    const recovered = make();
    expect(recovered.read("tsk_one").events.map((event) => event.content)).toEqual(["first", "second"]);
    expect(warnings.some((warning) => warning.includes("duplicate seq 1"))).toBe(true);
    expect(recovered.append("tsk_one", [row("third")]).events[0]!.seq).toBe(3);
    expect(readFileSync(path, "utf8")).not.toContain('{"seq":3{"');
  });

  it("reads a sparse recovered trace by seq and rejects out-of-order corruption", () => {
    const { path, make, warnings } = fixture();
    const store = make();
    store.append("tsk_one", [row("one")]);
    const event = { ...store.read("tsk_one").events[0], seq: 10, content: "ten" };
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
    expect(recovered.read("tsk_one").events.map((event) => event.content)).toEqual(["done"]);
    expect(JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!)).toEqual({
      end: { status: "completed", head: 1, event_count: 1, ended_at: NOW },
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
      expect(recovered.read("tsk_1").events.map((event) => event.content)).toEqual(["event 1"]);
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
      expect(recovered.read("tsk_0").events.map((event) => event.content)).toEqual(["event 0"]);
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
      expect(store.read("tsk_a").events.map((event) => event.content)).toEqual(["a"]);
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
      expect(recovered.read("tsk_one").events.map((event) => event.content)).toEqual(["original"]);
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
});
