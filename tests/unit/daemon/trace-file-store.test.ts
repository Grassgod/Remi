import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceFileStore } from "@multiremi/worker/trace-file-store.js";
import { InMemoryTraceStore, traceEventBytes, type TraceStore } from "@multiremi/worker/trace-store.js";
import type { TraceEventInput } from "@multiremi/contracts/trace.js";
import { TRACE_FILE_FORMAT } from "@multiremi/contracts/trace-file.js";
import { TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";

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

describe("TraceFileStore", () => {
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

  it("pages by seq and serialized bytes, returning one oversized event", () => {
    const { make } = fixture();
    const store: TraceStore = make();
    const events = store.append("tsk_one", [row("a"), row("b"), row("c")]).events;
    const budget = traceEventBytes(events[0]!) + traceEventBytes(events[1]!);
    expect(store.read("tsk_one", 0, 3, budget).events.map((event) => event.seq)).toEqual([1, 2]);
    expect(store.read("tsk_one", 2, 1, 1)).toEqual({ events: [events[2]], head: 3, eof: true });
    expect(store.read("tsk_one", 3)).toEqual({ events: [], head: 3, eof: true });
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
});
