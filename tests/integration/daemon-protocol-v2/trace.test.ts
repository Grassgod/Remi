import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { daemonTraceService } from "@multiremi/api/daemon-protocol/trace-handlers.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { join } from "node:path";
import { EmptyLiveHub } from "@multiremi/api/hub/live-hub.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";

const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); });
async function fixture(options: Parameters<typeof DaemonProtocolHarness.create>[0] = {}) {
  // This suite pins A-0's memory retention contract (2000-event cold tails).
  // Default production Hub wiring is covered separately without an injection.
  const h = await DaemonProtocolHarness.create({ liveHub: new EmptyLiveHub(createLocalHubTransport()),
    onReady: daemon => { (daemon as any).claimsPaused = true; }, ...options });
  fixtures.push(h); await h.startDaemon(); return h;
}
const rt = (h: DaemonProtocolHarness) => (h.daemon as any).options.runtimeId as string;
const trace = (h: DaemonProtocolHarness) => (h.daemon as any).ensureTrace() as DaemonTraceTransport;
function task(h: DaemonProtocolHarness) {
  const agent = h.store.createAgent({ name: "Trace fixture", provider: "claude" });
  const task = h.store.createTask({ agentId: agent.id, prompt: "trace" });
  expect(h.store.claimTask(rt(h))?.id).toBe(task.id);
  return task;
}
function snapshot(h: DaemonProtocolHarness, id: string) {
  const events: TraceEvent[] = [];
  const sub = daemonTraceService(h.layer).sink.subscribe(id, 0, (_id, backlog) => events.push(...backlog));
  const result = { events, head: sub.head, first_seq: sub.first_seq, closed: sub.closed };
  sub.unsubscribe(); return result;
}

describe("memory trace over the real protocol", () => {
  for (const injection of ["socket", "daemon", "server"] as const) {
    it(`reconciles dense trace exactly once over 20 ${injection} injections`, async () => {
      let interrupt: string | null = null;
      const h = await fixture({ beforeSend(frame, socket) {
        if (frame.t === "trace.append") {
          expect(frame.id).toEqual(expect.any(String));
          expect(frame.seq).toBeUndefined();
          socket.native.send(JSON.stringify(frame));
        }
        if (injection === "socket" && frame.t === "trace.append" && frame.p.task_id === interrupt) {
          interrupt = null; socket.close(4001); return false;
        }
      } });
      for (let round = 0; round < 20; round++) {
        const t = task(h);
        h.store.startTask(t.id); h.store.completeTask(t.id, { output: "fixture done" });
        if (injection !== "socket") await h.disconnect();
        interrupt = t.id;
        trace(h).append(t.id, rt(h), Array.from({ length: 8 }, (_, i) => ({ seq: 100 + i * 2, type: "text", content: `round-${round}-${i}` })));
        trace(h).close(t.id, "completed");
        if (injection === "daemon") await h.restartDaemon();
        else if (injection === "server") await h.restartServer();
        else { await waitFor(() => h.client.connectionState() === "disconnected", "trace socket fault"); await h.reconnect(); }
        await waitFor(() => daemonTraceService(h.layer).sink.head(t.id) === 8, "trace hub head");
        const actual = snapshot(h, t.id);
        expect(actual.events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(actual.events.map(event => event.seq)).toEqual(h.daemon.traceStore().read(t.id).events.map(event => event.seq));
        expect(actual.first_seq).toBe(1); expect(actual.head).toBe(8);
        expect((h.daemon as any).ensureOutbox().stats().pending).toBe(0);
      }
      expect(h.errors).toEqual([]);
    }, 40_000);
  }

  it("rejects trace.append carrying an outer seq instead of an RPC id", async () => {
    const h = await fixture(); const t = task(h);
    h.sockets.at(-1)!.native.send(JSON.stringify({ v: 2, t: "trace.append", seq: 999_003,
      rt: rt(h), ts: Date.now(), p: { task_id: t.id, closed: false,
        events: [{ seq: 1, type: "text", ts: "2026-09-28T00:00:00Z", content: "invalid envelope" }] } }));
    await waitFor(() => h.sockets.at(-1)!.frames.some(frame => frame.t === "res"
      && frame.p?.code === "protocol_violation"), "RPC misuse rejection");
    expect(snapshot(h, t.id).head).toBe(0);
    expect(h.client.connectionState()).toBe("connected");
    trace(h).append(t.id, rt(h), [{ type: "text", content: "valid RPC" }]);
    await waitFor(() => daemonTraceService(h.layer).sink.head(t.id) === 1, "valid trace RPC after rejection");
    expect(snapshot(h, t.id).events.map(event => event.content)).toEqual(["valid RPC"]);
  });

  it("migrates both providers' legacy messages and completes their owned traces", async () => {
    const tasks: string[] = [];
    const providers = ["claude", "codex"];
    const runtimes = ["legacy-claude", "legacy-codex"];
    const h = await fixture({ providers, runtimeIds: runtimes, async beforeStart(h) {
      for (let i = 0; i < providers.length; i++) {
        h.store.registerRuntime({ id: runtimes[i]!, name: providers[i]!, provider: providers[i]!,
          workspaceId: "local", daemonId: "dmn_fixture" });
        const agent = h.store.createAgent({ name: providers[i]!, provider: providers[i]! });
        const t = h.store.createTask({ agentId: agent.id, prompt: "legacy" });
        expect(h.store.claimTask(runtimes[i]!)?.id).toBe(t.id);
        h.store.startTask(t.id); tasks.push(t.id);
        const old = new MultiremiTaskReportOutbox({ path: join(h.root, `${providers[i]}-outbox.db`),
          canSend: () => false, deliver: async () => {} });
        try {
          old.enqueue(t.id, "messages", { messages: [{ seq: 42, type: "text", content: providers[i] }] });
          old.enqueue(t.id, "complete", { output: providers[i] });
        } finally { await old.close(); }
      }
    } });
    await waitFor(() => tasks.every(id => h.store.getTask(id)?.status === "completed")
      && (h.daemon as any).ensureOutbox().stats().pending === 0, "legacy completions");
    await waitFor(() => tasks.every(id => daemonTraceService(h.layer).sink.head(id) === 1), "both legacy trace owners");
    for (let i = 0; i < tasks.length; i++) {
      expect(snapshot(h, tasks[i]!)).toMatchObject({ head: 1, first_seq: 1, closed: true });
      expect(await daemonTraceService(h.layer).reader.read({ runtimeId: runtimes[i]!, taskId: tasks[i]! }))
        .toMatchObject({ ok: true, head: 1, closed: true, events: [{ seq: 1, content: providers[i] }] });
    }
    expect(h.errors).toEqual([]);
  });

  it("records first_seq for a cold tail and backfills a subscription through reverse RPC", async () => {
    const h = await fixture(); const t = task(h);
    trace(h).append(t.id, rt(h), Array.from({ length: 2200 }, () => ({ type: "text", content: "x" })));
    await waitFor(() => daemonTraceService(h.layer).sink.head(t.id) === 2200, "initial full head");
    await h.restartServer();
    await waitFor(() => daemonTraceService(h.layer).sink.head(t.id) === 2200, "cold tail head");
    const state = snapshot(h, t.id);
    expect(state.first_seq).toBe(201); expect(state.events).toHaveLength(2000);
    const received: number[] = [];
    const unsubscribe = await h.daemon.subscribeTrace(t.id, 0, events => { received.push(...events.map(event => event.seq)); });
    await waitFor(() => received.length === 2200, "subscription gap backfill", 5000);
    expect(received).toEqual(Array.from({ length: 2200 }, (_, i) => i + 1));
    expect(h.ledger.some(entry => entry.type === "trace.fetch")).toBe(true);
    await unsubscribe();
  });

  it("waits for the declared completion head before closing a subscription, including empty turns", async () => {
    const h = await fixture(); const t = task(h);
    h.store.startTask(t.id);
    const closed: boolean[] = []; const received: number[] = [];
    const unsubscribe = await h.daemon.subscribeTrace(t.id, 0, (events, done) => {
      received.push(...events.map(event => event.seq)); closed.push(done);
    });
    const transport = trace(h);
    const completion = transport.completion(t.id);
    await h.client.event({ t: "task.complete", seq: 999_001, rt: rt(h), p: {
      task_id: t.id, output: "answer", ...completion, trace: { ...completion.trace, head: 2, event_count: 2 },
    } });
    expect(snapshot(h, t.id).closed).toBe(false);
    transport.append(t.id, rt(h), [{ type: "text", content: "answer" }, { type: "usage" }]);
    transport.close(t.id, "completed");
    await waitFor(() => closed.includes(true), "closed after final trace head");
    expect(received).toEqual([1, 2]);
    expect(closed.at(-1)).toBe(true);
    expect(snapshot(h, t.id)).toMatchObject({ head: 2, closed: true });
    await unsubscribe();

    const empty = task(h); h.store.startTask(empty.id);
    transport.track(empty.id, rt(h));
    await h.client.event({ t: "task.complete", seq: 999_002, rt: rt(h), p: {
      task_id: empty.id, output: "empty", ...transport.completion(empty.id),
    } });
    transport.close(empty.id, "completed");
    expect(snapshot(h, empty.id)).toMatchObject({ head: 0, closed: true });
    expect(await daemonTraceService(h.layer).reader.read({ runtimeId: rt(h), taskId: empty.id }))
      .toMatchObject({ ok: true, events: [], head: 0, eof: true, closed: true });
  });

  it("serializes unsubscribe and immediate resubscribe without cancelling the new listener", async () => {
    const h = await fixture(); const t = task(h);
    trace(h).append(t.id, rt(h), [{ type: "text" }]);
    const old: number[] = []; const next: number[] = [];
    const unsubscribe = await h.daemon.subscribeTrace(t.id, 0, events => { old.push(...events.map(event => event.seq)); });
    await waitFor(() => old.length === 1, "old subscription");
    const removing = unsubscribe();
    const newUnsubscribe = await h.daemon.subscribeTrace(t.id, 1, events => { next.push(...events.map(event => event.seq)); });
    await removing;
    trace(h).append(t.id, rt(h), [{ type: "thinking" }]);
    await waitFor(() => next.length === 1, "replacement subscription");
    expect(next).toEqual([2]); expect(old).toEqual([1]);
    await newUnsubscribe();
  });

  it("resumes subscriptions after reconnect, fetches a pushed gap, and stops after unsubscribe", async () => {
    const h = await fixture(); const t = task(h); const received: number[] = [];
    trace(h).append(t.id, rt(h), [{ type: "text" }, { type: "thinking" }]);
    await waitFor(() => daemonTraceService(h.layer).sink.head(t.id) === 2, "two events");
    const unsubscribe = await h.daemon.subscribeTrace(t.id, 0, events => { received.push(...events.map(event => event.seq)); });
    await waitFor(() => received.length === 2, "initial push");
    await h.disconnect(); trace(h).append(t.id, rt(h), [{ type: "text" }]); await h.reconnect();
    await waitFor(() => received.length === 3, "resumed push");
    const session = h.sessions.at(-1)!; const sendEvent = session.sendEvent.bind(session); let dropped = false;
    const gap = spyOn(session, "sendEvent").mockImplementation((frame, options) => {
      const p = frame.p as { task_id?: string; events?: TraceEvent[] };
      if (frame.t === "trace.push" && p.task_id === t.id && !dropped && p.events?.some(event => event.seq === 4)) {
        dropped = true; return sendEvent({ ...frame, p: { ...p, events: p.events.filter(event => event.seq > 5) } }, options);
      }
      return sendEvent(frame, options);
    });
    try {
      trace(h).append(t.id, rt(h), [{ type: "text" }, { type: "text" }, { type: "text" }]);
      await waitFor(() => received.length === 6, "pushed gap repaired");
      expect(received).toEqual([1, 2, 3, 4, 5, 6]);
      expect(h.ledger.some(entry => entry.type === "trace.fetch" && entry.frame.p.after_seq === 3)).toBe(true);
      await unsubscribe(); trace(h).append(t.id, rt(h), [{ type: "text" }]);
      await waitFor(() => daemonTraceService(h.layer).sink.head(t.id) === 7, "post-unsubscribe append");
      await Bun.sleep(50); expect(received).toEqual([1, 2, 3, 4, 5, 6]);
    } finally { gap.mockRestore(); }
  });

  it("reads paginated hot data and one event larger than max_bytes; offline is unreachable", async () => {
    const h = await fixture(); const t = task(h);
    trace(h).append(t.id, rt(h), [{ type: "text", content: " ".repeat(256 * 1024) }, ...Array.from({ length: 510 }, () => ({ type: "usage" }))]);
    const reader = daemonTraceService(h.layer).reader;
    const large = await reader.read({ runtimeId: rt(h), taskId: t.id, maxBytes: 8 });
    expect(large).toMatchObject({ ok: true, head: 511, eof: false, closed: false, next_after_seq: 1 });
    if (large.ok) { expect(large.events).toHaveLength(1); expect(large.events[0]!.content!.length).toBe(256 * 1024); }
    const page = await reader.read({ runtimeId: rt(h), taskId: t.id, afterSeq: 1, limit: 9999, maxBytes: 2 * 1024 * 1024 });
    expect(page).toMatchObject({ ok: true, eof: false, next_after_seq: 501 });
    if (page.ok) expect(page.events).toHaveLength(500);
    const end = await reader.read({ runtimeId: rt(h), taskId: t.id, afterSeq: 501 });
    expect(end).toMatchObject({ ok: true, eof: true, head: 511 });
    expect(await reader.read({ runtimeId: rt(h), taskId: "not-owned" })).toMatchObject({ ok: false, code: "trace_not_hot" });
    h.daemon.traceStore().forget(t.id);
    expect(await reader.read({ runtimeId: rt(h), taskId: t.id })).toMatchObject({ ok: false, code: "trace_not_hot" });
    const runtime = rt(h); await h.stopDaemon();
    const start = performance.now();
    expect(await reader.read({ runtimeId: runtime, taskId: t.id })).toMatchObject({ ok: false, code: "daemon_unreachable", runtime_id: runtime, last_seen_at: expect.any(String) });
    expect(performance.now() - start).toBeLessThan(10_000);
  });
});
