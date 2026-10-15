import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceFileStore } from "@multiremi/worker/trace-file-store.js";
import { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import { parseDaemonProtocolFrame, type DaemonParsedFrame } from "@multiremi/api/daemon-protocol/frames.js";
import { checkTraceFileLines, TRACE_FILE_FORMAT_V1 } from "@multiremi/contracts/trace-file.js";
import type { TraceEventInput, TraceItem, TraceTurn } from "@multiremi/contracts/trace.js";

const NOW = "2026-09-28T12:00:00.000Z";
const LATER = "2026-09-28T12:00:09.000Z";

function peer() {
  let handler!: (frame: DaemonParsedFrame) => void;
  const replies: Array<{ p: any }> = [];
  const client = { onWelcome: () => () => {}, onFrame: (listener: typeof handler) => { handler = listener; return () => {}; },
    connectionState: () => "disconnected", send: (frame: { p: any }) => replies.push(frame) };
  return { client: client as unknown as DaemonProtocolClient, replies,
    read: (rt: string, taskId: string, extra: Record<string, unknown> = {}) => {
      const parsed = parseDaemonProtocolFrame(JSON.stringify({ v: 2, t: "trace.read", id: "read", rt, p: { task_id: taskId, view: "events", ...extra } }));
      if (!parsed.ok) throw new Error(parsed.reason);
      handler(parsed.frame);
      return replies.at(-1)!.p;
    } };
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await Bun.sleep(5);
  }
}

function turn(id = "task"): TraceTurn {
  return { id, turn_id: "turn", agent_id: "agt", agent_name: "Remi", provider: "claude", requested_model: null, model: null,
    status: "running", error: null, started_at: NOW, completed_at: null, duration_ms: null, final_item_id: null,
    final_started_at: null, context_usage: null, stats: { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] } };
}

const base = (id: string, status: TraceItem["status"] = "completed") =>
  ({ id, parent_id: null, status, started_at: NOW, completed_at: status === "in_progress" ? null : NOW });

function message(id: string, text: string, patch: Record<string, unknown> = {}): TraceItem {
  return { ...base(id), type: "agent_message", text, phase: "unknown", ...patch } as TraceItem;
}

function command(id: string, status: TraceItem["status"] = "completed"): TraceItem {
  return { ...base(id, status), type: "command", tool: "Bash", source: "shell", command: "ls", cwd: null,
    actions: [{ type: "list_files", command: "ls", path: null }], output: null, exit_code: null, duration_ms: null };
}

const started = (id = "task"): TraceEventInput => ({ type: "turn.started", turn: turn(id) });
const done = (item: TraceItem): TraceEventInput => ({ type: "item.completed", item });
const open = (item: TraceItem): TraceEventInput =>
  ({ type: "item.started", item: { ...item, status: "in_progress", completed_at: null } as TraceItem });
const textOf = (event: any) => event?.item?.text;

function fileFixture(prefix: string, resolve: (taskId: string) => { runtimeId: string } = () => ({ runtimeId: "rt" })) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const make = () => new TraceFileStore({ workspacesRoot: root, now: () => NOW, resolveTask: (taskId) => ({
    sessionId: "ises_t", subjectId: "iss_t", agentId: "agent", provider: "codex", startedAt: NOW, ...resolve(taskId) }) });
  return { root, make, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("daemon trace transport ownership and reads", () => {
  it("answers unavailable files immediately and leaves healthy traces readable", async () => {
    const f = fileFixture("trace-read-gc-");
    const store = f.make();
    const p = peer(); const errors: unknown[] = [];
    const trace = new DaemonTraceTransport(p.client, store, undefined, error => errors.push(error));
    try {
      for (const id of ["gone", "corrupt", "healthy"]) trace.append(id, "rt", [done(message(`m:${id}`, id))]);
      unlinkSync(join(f.root, "traces", "iss_t", "gone.jsonl"));
      writeFileSync(join(f.root, "traces", "iss_t", "corrupt.jsonl"), "broken\n");
      for (const id of ["gone", "corrupt"]) {
        expect(() => p.read("rt", id)).not.toThrow();
        expect(p.replies.at(-1)!.p).toEqual({ ok: false, code: "trace_not_hot", retryable: false });
      }
      expect(p.read("rt", "healthy")).toMatchObject({ ok: true, view: "events", format: "v2", events: [{ item: { text: "healthy" } }] });
      expect(errors).toHaveLength(2);
      trace.pruneMissing();
      expect(trace.ownership().has("gone")).toBe(false);
      expect(store.head("gone")).toBe(null);
      expect(trace.ownership().has("corrupt")).toBe(true);
      expect(trace.ownership().has("healthy")).toBe(true);
    } finally { await trace.stop(); f.cleanup(); }
  });

  it("does not replay closed history on fresh transport boot", async () => {
    const f = fileFixture("trace-closed-restart-");
    const store = f.make();
    for (let i = 0; i < 100; i++) {
      store.append(`task_${i}`, [done(message("m", "history"))]);
      store.close(`task_${i}`, { status: "completed", ended_at: NOW });
    }
    const p = peer(); let calls = 0;
    Object.assign(p.client, { connectionState: () => "connected", uplinkPaused: () => false,
      rpc: async () => { calls++; return { hub_head: 1 }; } });
    const recovered = new DaemonTraceTransport(p.client, f.make());
    try {
      await Bun.sleep(30);
      expect(calls).toBe(0);
      expect(p.read("rt", "task_50")).toMatchObject({ ok: true, head: 1, closed: true });
      // Nothing is indexed or tracked at boot; the owner comes from the file on first use.
      expect(recovered.ownership().size).toBe(0);
    } finally { await recovered.stop(); f.cleanup(); }
  });

  it("resumes only the v2 traces a crash left open, without indexing the closed history", async () => {
    const f = fileFixture("trace-open-restart-");
    const store = f.make();
    for (let i = 0; i < 50; i++) {
      store.append(`task_${i}`, [done(message("m", "history"))]);
      store.close(`task_${i}`, { status: "completed", ended_at: NOW });
    }
    store.append("task_open", [done(message("m", "unfinished"))]);
    // The crash also cut the last line short.
    appendFileSync(join(f.root, "traces", "iss_t", "task_open.jsonl"), '{"seq":2,"type":"it');
    // An unclosed v1 trace is read-only history and is never resumed.
    writeFileSync(join(f.root, "traces", "iss_t", "task_v1.jsonl"), `${JSON.stringify({ format: TRACE_FILE_FORMAT_V1, task_id: "task_v1",
      session_id: "ises_t", agent_id: "agent", provider: "codex", started_at: NOW, runtime_id: "rt" })}\n${JSON.stringify({ seq: 1, ts: NOW, type: "text", content: "old" })}\n`);
    const p = peer(); let calls = 0;
    Object.assign(p.client, { connectionState: () => "connected", uplinkPaused: () => false,
      rpc: async () => { calls++; return { hub_head: 0 }; } });
    const recovered = new DaemonTraceTransport(p.client, f.make());
    try {
      await waitUntil(() => recovered.ownership().size > 0 && calls > 0);
      expect([...recovered.ownership()]).toEqual([["task_open", "rt"]]);
    } finally { await recovered.stop(); f.cleanup(); }
  });

  it("recovers two runtime owners in a fresh file store and transport", async () => {
    const f = fileFixture("trace-transport-restart-", (taskId) => ({ runtimeId: taskId === "task_one" ? "rt_one" : "rt_two" }));
    const p = peer();
    const first = new DaemonTraceTransport(p.client, f.make());
    first.append("task_one", "rt_one", [done(message("m1", "first"))]);
    first.close("task_one", "completed");
    first.append("task_two", "rt_two", [done(message("m2", "second"))]);
    await first.stop();
    const next = peer();
    const recovered = new DaemonTraceTransport(next.client, f.make());
    try {
      expect(next.read("rt_one", "task_one")).toMatchObject({ ok: true, head: 1, closed: true, events: [{ item: { text: "first" }, seq: 1 }] });
      expect(next.read("rt_two", "task_one")).toMatchObject({ ok: false, code: "trace_not_hot" });
      expect(next.read("rt_two", "task_two")).toMatchObject({ ok: true, closed: false, events: [{ item: { text: "second" } }] });
      expect(recovered.append("task_two", "rt_two", [done(message("m3", "third"))])[0]!.seq).toBe(2);
      expect(() => recovered.track("task_two", "rt_one")).toThrow("ownership changed");
    } finally { await recovered.stop(); f.cleanup(); }
  });

  it("reads an empty closed turn while rejecting another runtime and a forgotten turn", async () => {
    const p = peer(); const trace = new DaemonTraceTransport(p.client);
    try {
      trace.track("empty", "rt"); trace.close("empty", "failed");
      expect(p.read("rt", "empty")).toEqual({ ok: true, view: "events", format: "v2", events: [], next_after_seq: 0, head: 0, eof: true, closed: true });
      expect(p.read("rt", "empty", { view: "turn" })).toEqual({ ok: true, view: "turn", format: "v2", turn: null, items: [],
        next_item_cursor: null, head: 0, closed: true });
      expect(p.read("other", "empty")).toEqual({ ok: false, code: "trace_not_hot", retryable: false });
      trace.store.forget("empty");
      expect(p.read("rt", "empty")).toEqual({ ok: false, code: "trace_not_hot", retryable: false });
    } finally { await trace.stop(); }
  });
});

describe("daemon trace transport close and completion", () => {
  it("writes open items, then turn.completed, then the snapshot and the trailer", async () => {
    const f = fileFixture("trace-close-order-");
    const trace = new DaemonTraceTransport(peer().client, f.make(), undefined, undefined, undefined, () => LATER);
    try {
      trace.append("task", "rt", [started(), done(message("in", "input")), open(command("call_open", "in_progress")),
        open(message("msg:open", "partial answer"))]);
      trace.close("task", "completed");
      const lines = readFileSync(join(f.root, "traces", "iss_t", "task.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      const events = lines.filter((line) => typeof line.seq === "number");
      expect(events.slice(-3).map((event) => [event.type, event.item?.id ?? null, event.item?.status ?? event.turn?.status])).toEqual([
        ["item.completed", "call_open", "stopped"],
        ["item.completed", "msg:open", "completed"],
        ["turn.completed", null, "completed"],
      ]);
      const turnCompleted = events.at(-1)!.turn as TraceTurn;
      expect(turnCompleted).toMatchObject({ completed_at: LATER, duration_ms: 9000, final_item_id: null,
        stats: { item_count: 3, tool_call_count: 1 } });
      const snapshot = lines.find((line) => line.snapshot)!.snapshot;
      expect(snapshot).toMatchObject({ part: 0, parts: 1, head: events.length, turn: { status: "completed" } });
      expect(snapshot.items.map((item: TraceItem) => [item.id, item.status])).toEqual([
        ["in", "completed"], ["call_open", "stopped"], ["msg:open", "completed"],
      ]);
      expect(lines.at(-1)).toEqual({ end: { status: "completed", head: events.length, event_count: events.length, ended_at: LATER, snapshot_parts: 1 } });
      expect(checkTraceFileLines(lines.map((line) => JSON.stringify(line)))).toMatchObject({ ok: true, value: { closed: true, format: "v2" } });
      // Idempotent: a second close (outbox replay) writes nothing.
      const size = readFileSync(join(f.root, "traces", "iss_t", "task.jsonl")).length;
      trace.close("task", "failed");
      expect(readFileSync(join(f.root, "traces", "iss_t", "task.jsonl")).length).toBe(size);
    } finally { await trace.stop(); f.cleanup(); }
  });

  it("stops open text on a cancelled close and records the error of a failed one", async () => {
    const trace = new DaemonTraceTransport(peer().client, new InMemoryTraceStore(() => NOW), undefined, undefined, undefined, () => LATER);
    try {
      trace.append("cancelled", "rt", [started("cancelled"), open(message("msg:x", "half"))]);
      trace.close("cancelled", "cancelled");
      const part = trace.store.snapshotPart("cancelled", 0)!;
      expect(part.turn.status).toBe("cancelled");
      expect(part.items[0]).toMatchObject({ id: "msg:x", status: "stopped" });

      trace.append("failed", "rt", [started("failed")]);
      trace.close("failed", "failed", { message: "boom", reason: "agent_error" });
      expect(trace.store.snapshotPart("failed", 0)!.turn).toMatchObject({ status: "failed", error: { message: "boom", reason: "agent_error" } });
    } finally { await trace.stop(); }
  });

  it("reports before close exactly what the close then records", async () => {
    const trace = new DaemonTraceTransport(peer().client, new InMemoryTraceStore(() => NOW), undefined, undefined, undefined, () => LATER);
    try {
      trace.append("task", "rt", [
        started(),
        done(message("in", "do it", { type: "user_message", origin: "input", message_ids: [], attachments: [], steer: null })),
        { type: "turn.updated", patch: { model: "claude-opus-5-5", context_usage: { used: 10, size: 100 } } },
        done(command("call_1")),
        { type: "item.completed", item: { ...base("perm:d"), type: "permission", tool_item_id: "call_1", title: "ls", message_id: "d",
          options: [], decision: null, outcome: "cancelled", responded_by: null, reply_message_id: null } },
        open(command("call_2", "in_progress")),
        done(message("msg:final", " Done. ", { phase: "final", started_at: "2026-09-28T12:00:04.000Z" })),
      ]);
      const before = trace.completion("task");
      expect(before).toEqual({
        trace: { head: 9, event_count: 9, closed: true, tool_call_count: 2, type_histogram: [
          { type: "user_message", tool: null, count: 1 }, { type: "command", tool: "Bash", count: 2 },
          { type: "permission", tool: null, count: 1 }, { type: "agent_message", tool: null, count: 1 },
        ] },
        final_reply_md: "Done.",
        model: { provider: "claude", model: "claude-opus-5-5" },
        context_usage: { used: 10, size: 100 },
        worked_ms: 4000,
        // call_1 and call_2; not the input, the permission (decision Q1) or the final reply.
        process_item_count: 2,
      });
      // A rejected completion (steer pending) leaves the trace open and appendable.
      expect(trace.store.head("task")).toEqual({ head: 7, closed: false });
      trace.close("task", "completed");
      expect(trace.store.head("task")).toEqual({ head: 9, closed: true });
      expect(trace.completion("task")).toEqual(before);
    } finally { await trace.stop(); }
  });

  it("keeps a bounded completion cache and no resident fold after close", async () => {
    const trace = new DaemonTraceTransport(peer().client);
    for (let i = 0; i < 140; i++) {
      const id = `task_${i}`;
      trace.append(id, "rt", [started(id), done(command(`tool_${i}`))]);
      trace.completion(id); trace.close(id, "completed");
    }
    const cache = trace as unknown as { folds: Map<string, unknown>; completed: Map<string, unknown> };
    expect(cache.folds.size).toBe(0);
    expect(cache.completed.size).toBe(128);
    expect(trace.completion("task_139").trace.tool_call_count).toBe(1);
    expect(cache.folds.size).toBe(0);
    await trace.stop();
    expect(cache.completed.size).toBe(0);
  });

  it("folds incrementally and rebuilds a missing fold from the store only once", async () => {
    const store = new InMemoryTraceStore();
    let reads = 0; const read = store.read.bind(store);
    store.read = (...args) => { reads++; return read(...args); };
    const trace = new DaemonTraceTransport(peer().client, store);
    try {
      trace.append("task", "rt", [started()]);
      const baseline = reads;
      for (let i = 0; i < 10; i++) trace.append("task", "rt", [done(command(`tool_${i}`))]);
      expect(trace.completion("task").trace.event_count).toBe(12);
      trace.completion("task");
      expect(reads).toBe(baseline);
    } finally { await trace.stop(); }
    const next = new DaemonTraceTransport(peer().client, store, undefined, undefined, new Map([["task", "rt"]]));
    try {
      expect(next.completion("task").trace.tool_call_count).toBe(10);
      const baseline = reads;
      next.completion("task");
      expect(reads).toBe(baseline);
    } finally { await next.stop(); }
  });

  it("assigns live timestamps and dense sequences at TraceStore, not at producers", async () => {
    const store = new InMemoryTraceStore(() => NOW);
    const trace = new DaemonTraceTransport(peer().client, store);
    try {
      const stored = trace.append("task", "rt", [
        { ...started(), seq: 99, ts: "2020-01-01T00:00:00.000Z" } as unknown as TraceEventInput,
        done(message("m", "x")),
      ]);
      expect(stored.map((event) => [event.seq, event.ts])).toEqual([[1, NOW], [2, NOW]]);
      trace.close("task", "completed");
      expect(trace.append("task", "rt", [done(message("late", "late"))])).toEqual([]);
      expect(store.head("task")).toEqual({ head: 3, closed: true });
    } finally { await trace.stop(); }
  });

  it("leaves a v1 trace untouched by close and completion", async () => {
    const f = fileFixture("trace-v1-close-");
    const path = join(f.root, "traces", "iss_t", "legacy.jsonl");
    mkdirSync(join(f.root, "traces", "iss_t"), { recursive: true });
    const content = `${JSON.stringify({ format: TRACE_FILE_FORMAT_V1, task_id: "legacy", session_id: "ises_t", agent_id: "agent",
      provider: "codex", started_at: NOW, runtime_id: "rt" })}\n${JSON.stringify({ seq: 1, ts: NOW, type: "text", content: "old" })}\n`;
    writeFileSync(path, content);
    const p = peer();
    const trace = new DaemonTraceTransport(p.client, f.make());
    try {
      expect(trace.completion("legacy")).toMatchObject({ trace: { head: 1, event_count: 1 }, final_reply_md: null, process_item_count: 0 });
      trace.close("legacy", "completed");
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(p.read("rt", "legacy")).toMatchObject({ ok: true, view: "events", format: "legacy", events: [{ seq: 1, type: "text", content: "old" }] });
      expect(p.read("rt", "legacy", { view: "turn" })).toEqual({ ok: true, view: "turn", format: "legacy", turn: null, items: [],
        next_item_cursor: null, head: 1, closed: false });
    } finally { await trace.stop(); f.cleanup(); }
  });
});

describe("daemon trace transport view=turn", () => {
  it("pages the running fold by item cursor", async () => {
    const p = peer();
    const trace = new DaemonTraceTransport(p.client);
    try {
      trace.append("task", "rt", [started(), ...Array.from({ length: 5 }, (_, i) => done(message(`m${i}`, `text ${i}`)))]);
      const first = p.read("rt", "task", { view: "turn", item_cursor: 0, limit: 2 });
      expect(first).toMatchObject({ ok: true, view: "turn", format: "v2", head: 6, closed: false, next_item_cursor: 2,
        turn: { id: "task", status: "running" } });
      expect(first.items.map((item: TraceItem) => item.id)).toEqual(["m0", "m1"]);
      expect(first.items[0].seq).toBe(2);
      const last = p.read("rt", "task", { view: "turn", item_cursor: 4, limit: 2 });
      expect(last.items.map((item: TraceItem) => item.id)).toEqual(["m4"]);
      expect(last.next_item_cursor).toBeNull();
      // Every page's turn carries the live statistics of the whole fold, not the zeros of turn.started.
      expect(first.turn.stats).toMatchObject({ item_count: 5, process_item_count: 5, tool_call_count: 0 });
      expect(last.turn.stats).toEqual(first.turn.stats);
    } finally { await trace.stop(); }
  });

  it("answers a read without a known view with protocol_violation", async () => {
    const p = peer();
    const trace = new DaemonTraceTransport(p.client);
    try {
      trace.append("task", "rt", [started()]);
      // Servers past the release gate always name a view; the pre-PR 2 fallback is gone.
      for (const view of [undefined, "fragments"]) {
        expect(p.read("rt", "task", { view })).toEqual({ ok: false, code: "protocol_violation", retryable: false });
      }
      expect(p.read("rt", "task", { view: "events" })).toMatchObject({ ok: true, view: "events", head: 1 });
    } finally { await trace.stop(); }
  });

  it("pages a closed trace from its snapshot parts, across part boundaries", async () => {
    const f = fileFixture("trace-turn-closed-");
    const p = peer();
    const trace = new DaemonTraceTransport(p.client, f.make());
    try {
      const big = Array.from({ length: 6 }, (_, i) => done(message(`m${i}`, String(i).repeat(300 * 1024))));
      trace.append("task", "rt", [started(), ...big]);
      trace.close("task", "completed");
      expect(trace.store.snapshotPart("task", 1)).not.toBeNull();
      const ids: string[] = [];
      let cursor: number | null = 0;
      let pages = 0;
      while (cursor !== null && pages < 20) {
        const page: any = p.read("rt", "task", { view: "turn", item_cursor: cursor, limit: 500, max_bytes: 700 * 1024 });
        expect(page).toMatchObject({ ok: true, view: "turn", format: "v2", closed: true, head: 8, turn: { status: "completed" } });
        ids.push(...page.items.map((item: TraceItem) => item.id));
        cursor = page.next_item_cursor;
        pages++;
      }
      expect(ids).toEqual(big.map((_, i) => `m${i}`));
      expect(pages).toBeGreaterThan(1);
      // A fresh daemon serves the same pages from disk.
      const again = peer();
      const recovered = new DaemonTraceTransport(again.client, f.make());
      try {
        const page: any = again.read("rt", "task", { view: "turn", item_cursor: 5, limit: 10 });
        expect(page.items.map((item: TraceItem) => item.id)).toEqual(["m5"]);
        expect(page.next_item_cursor).toBeNull();
      } finally { await recovered.stop(); }
    } finally { await trace.stop(); f.cleanup(); }
  });
});

/** Keep TraceEventInput referenced for the helpers above. */
export type { TraceEventInput };
