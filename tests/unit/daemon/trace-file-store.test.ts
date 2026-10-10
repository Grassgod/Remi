import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceFileStore, TRACE_FILE_MAX_EVENT_BYTES } from "@multiremi/worker/trace-file-store.js";
import { DAEMON_WS_MAX_PAYLOAD_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { encodeDaemonProtocolFrame, daemonFrameByteLimit } from "@multiremi/api/daemon-protocol/frames.js";
import { prepareSessionArchive, removePreparedSessionArchive } from "@daemon/agent-runtime/workspace/session-archive.js";
import { InMemoryTraceStore, traceEventBytes, sanitizeStoredEvent } from "@multiremi/worker/trace-store.js";
import type { TraceEventInput } from "@multiremi/contracts/trace.js";
import { TRACE_FILE_FORMAT } from "@multiremi/contracts/trace-file.js";
import { TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";
import { describeTraceStoreContract } from "./trace-store-contract.js";

const NOW = "2026-09-27T00:00:00.000Z";
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(sessionId: string | null = "ises_one") {
  const root = mkdtempSync(join(tmpdir(), "trace-file-store-"));
  roots.push(root);
  const warnings: string[] = [];
  const make = () => new TraceFileStore({
    workspacesRoot: root,
    resolveTask: () => ({ sessionId, agentId: "agt_one", provider: "codex", startedAt: NOW }),
    now: () => NOW,
    onWarning: (_path, reason) => warnings.push(reason),
  });
  const path = join(root, ".runtime", sessionId ?? "tsk_one", "traces", "tsk_one.jsonl");
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

  it("canonicalizes recovered duplicates before closing, restarting and archiving", async () => {
    const { make, path, root } = fixture();
    const store = make(); store.append("tsk_one", [row("first"), row("second")]);
    const duplicate = { ...store.read("tsk_one").events[0], content: "duplicate" };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(duplicate)}\n{"seq":3`);
    const recovered = make(); recovered.append("tsk_one", [row("third")]);
    recovered.close("tsk_one", { status: "completed", ended_at: NOW });
    const next = make();
    expect(next.head("tsk_one")).toEqual({ head: 3, closed: true });
    expect(next.read("tsk_one").events.map(event => event.content)).toEqual(["first", "second", "third"]);
    const sessionRoot = join(root, ".runtime", "ises_one");
    mkdirSync(join(sessionRoot, ".multiremi"));
    const prepared = await prepareSessionArchive(sessionRoot, { subject: { kind: "task", id: "tsk_one" },
      providerRoots: [{ sessionId: "ises_one", root: sessionRoot }], storageBoundary: root });
    expect(prepared.traceCount).toBe(1);
    await removePreparedSessionArchive(prepared.archivePath);
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
      resolveTask: () => ({ sessionId: "ises_large", agentId: "agt", provider: "codex", runtimeId: "rt_large", startedAt: NOW }),
      onReadBytes: bytes => { bytesRead += bytes; } });
    const original = make();
    for (let batch = 0; batch < 100; batch++) original.append("tsk_large", Array.from({ length: 100 }, () => row("x".repeat(1024))));
    original.close("tsk_large", { status: "completed", ended_at: NOW });
    const recovered = make();
    expect(recovered.ownership().get("tsk_large")).toBe("rt_large");
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
    const bad = join(root, ".runtime", "ises_other", "traces");
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
      const traces = join(root, ".runtime", "ises_one", "traces");
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
});
