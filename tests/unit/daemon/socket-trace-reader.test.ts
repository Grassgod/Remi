import { describe, expect, it } from "bun:test";
import { SocketDaemonTraceReader } from "@multiremi/api/trace/socket-trace-reader.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import type { DaemonParsedFrame } from "@multiremi/api/daemon-protocol/frames.js";

function fixture() {
  const sent: Array<{ id: string; frame: any }> = [];
  const pending = new Set<string>();
  const session = { isClosed: false, request: (id: string, frame: unknown) => { sent.push({ id, frame }); pending.add(id); return id; },
    settleRequest: (id: string) => pending.delete(id) };
  let live = true;
  let reply!: (frame: DaemonParsedFrame, session: DaemonProtocolSession) => void;
  let closed!: (session: DaemonProtocolSession) => void;
  const layer = { registry: { sessionForRuntime: () => live ? session : null },
    onReply: (listener: typeof reply) => { reply = listener; }, onClose: (listener: typeof closed) => { closed = listener; } };
  const reader = new SocketDaemonTraceReader(layer as unknown as DaemonProtocolLayer, () => "2026-09-28T00:00:00Z");
  return { reader, sent, pending, reply: (id: string, p: unknown) => reply({ re: id, payload: p } as DaemonParsedFrame, session as unknown as DaemonProtocolSession),
    close: () => { live = false; session.isClosed = true; closed(session as unknown as DaemonProtocolSession); } };
}

describe("socket trace reader admission and errors", () => {
  it("limits each connection to four in flight and 32 queued, then admits the oldest waiter", async () => {
    const f = fixture();
    const reads = Array.from({ length: 36 }, (_, i) => f.reader.read({ runtimeId: "rt", taskId: `task-${i}` }));
    expect(f.sent).toHaveLength(4); expect(f.pending.size).toBe(4);
    expect(await f.reader.read({ runtimeId: "rt", taskId: "overflow" })).toEqual({ ok: false, code: "daemon_busy", runtime_id: "rt" });
    f.reply(f.sent[0]!.id, { ok: true, events: [], next_after_seq: 0, head: 0, eof: true, closed: false });
    expect((await reads[0]!).ok).toBe(true);
    expect(f.sent).toHaveLength(5); expect(f.sent[4]!.frame.p.task_id).toBe("task-4");
    f.close();
    const results = await Promise.all(reads.slice(1));
    expect(results.every(result => !result.ok && result.code === "daemon_unreachable")).toBe(true);
    expect(f.pending.size).toBe(0);
  });

  it("defaults pages, clamps upper limits and keeps eof separate from closed", async () => {
    const f = fixture();
    const first = f.reader.read({ runtimeId: "rt", taskId: "task" });
    expect(f.sent[0]!.frame.p).toEqual({ task_id: "task", after_seq: 0, limit: 200, max_bytes: 1024 * 1024 });
    f.reply(f.sent[0]!.id, { ok: true, events: [], next_after_seq: 0, head: 7, eof: false, closed: true });
    expect(await first).toMatchObject({ eof: false, closed: true });
    const second = f.reader.read({ runtimeId: "rt", taskId: "task", limit: 1000, maxBytes: 2 * 1024 * 1024 });
    expect(f.sent[1]!.frame.p).toMatchObject({ limit: 500, max_bytes: 1024 * 1024 });
    f.reply(f.sent[1]!.id, { ok: false, code: "trace_not_hot", retryable: false });
    expect(await second).toEqual({ ok: false, code: "trace_not_hot", runtime_id: "rt" }); f.close();
  });

  it("times out and forgets the request; offline includes runtime and last observation", async () => {
    const f = fixture();
    const result = await f.reader.read({ runtimeId: "rt", taskId: "task", timeoutMs: 5 });
    expect(result).toEqual({ ok: false, code: "daemon_timeout", runtime_id: "rt" });
    expect(f.pending.size).toBe(0);
    f.reply(f.sent[0]!.id, { ok: true, events: [], head: 0, eof: true, closed: false });
    f.close();
    expect(await f.reader.read({ runtimeId: "rt", taskId: "task" })).toEqual({ ok: false, code: "daemon_unreachable", runtime_id: "rt", last_seen_at: "2026-09-28T00:00:00Z" });
  });
});
