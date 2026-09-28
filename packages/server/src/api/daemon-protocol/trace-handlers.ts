import { DAEMON_TRACE_APPEND_MAX_BYTES, DAEMON_TRACE_APPEND_MAX_EVENTS } from "@multiremi/contracts/daemon-protocol.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { InMemoryTraceSink, type TraceSink, type TraceSinkSubscription } from "@multiremi/api/trace/trace-sink.js";
import { SocketDaemonTraceReader } from "../trace/socket-trace-reader.js";
import type { DaemonProtocolLayer } from "./index.js";
import type { DaemonParsedFrame } from "./frames.js";
import { encodeDaemonProtocolFrame } from "./frames.js";
import type { DaemonProtocolSession } from "./session.js";
import { authorizeReportRuntime } from "./report-handlers.js";

interface Subscription { sink: TraceSinkSubscription; cursor: number; closed: boolean }
const failure = (code = "invalid_report") => ({ ok: false, code, retryable: false });
function reject(code = "invalid_report"): never { throw Object.assign(new Error(code), { code }); }
function traceRejection(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  if (["invalid_report", "authority_revoked", "task_not_found"].includes(String(code))) return failure(String(code));
  throw error;
}

/** PR 1 uses the A-0 memory sink; B's readTrace and C's Live Hub attach in PR 2. */
export class DaemonTraceService {
  readonly reader: SocketDaemonTraceReader;
  readonly sink: TraceSink;
  private readonly runtimes = new Map<string, string>();
  private readonly closingHeads = new Map<string, number>();
  private readonly subscribers = new Map<DaemonProtocolSession, Map<string, Subscription>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(layer: DaemonProtocolLayer, private readonly store: MultiremiStore, sink: TraceSink = new InMemoryTraceSink()) {
    this.sink = sink;
    this.reader = new SocketDaemonTraceReader(layer, runtimeId => store.getRuntimeLite(runtimeId)?.lastHeartbeatAt ?? null);
    layer.setTraceHeads(session => Object.fromEntries([...this.runtimes]
      .filter(([, runtimeId]) => session.runtimeIds.includes(runtimeId))
      .map(([taskId]) => [taskId, sink.head(taskId) ?? 0])));
    layer.registerEventHandler("trace.append", (frame, session) => this.append(frame, session));
    layer.registerRpcHandler("trace.head", (frame, session) => this.head(frame, session));
    layer.registerRpcHandler("trace.subscribe", (frame, session) => this.subscribe(frame, session));
    layer.registerRpcHandler("trace.unsubscribe", (frame, session) => this.unsubscribe(frame, session));
    layer.registerRpcHandler("trace.fetch", (frame, session) => this.fetch(frame, session));
    layer.onClose(session => {
      for (const sub of this.subscribers.get(session)?.values() ?? []) sub.sink.unsubscribe();
      this.subscribers.delete(session);
      if (!this.subscribers.size && this.timer) { clearTimeout(this.timer); this.timer = null; }
    });
  }

  private task(frame: DaemonParsedFrame, session: DaemonProtocolSession, write = false) {
    const id = frame.payload.task_id;
    if (typeof id !== "string" || !id) reject();
    if (!write) return this.readTask(id, session, frame.rt);
    const task = this.store.getTaskIdentity(id);
    if (!task) reject("task_not_found");
    if (!task.runtimeId) reject("authority_revoked");
    if (frame.rt && frame.rt !== task.runtimeId) reject("authority_revoked");
    authorizeReportRuntime(this.store, session, task.runtimeId);
    return task;
  }

  private readTask(taskId: string, session: DaemonProtocolSession, senderRuntimeId?: string | null) {
    const task = this.store.getTaskIdentity(taskId);
    if (!task) reject("task_not_found");
    if (!task.runtimeId) reject("authority_revoked");
    // Concierge reads retain GET messages' host exception, never execution authority.
    if (senderRuntimeId) authorizeReportRuntime(this.store, session, senderRuntimeId);
    const runtime = this.store.getRuntimeLite(task.runtimeId);
    const token = session.ownerAccessToken;
    if (!runtime || (runtime.workspaceId ?? "local") !== task.workspaceId) reject("authority_revoked");
    if (token && (token.workspaceId !== task.workspaceId || token.daemonId !== session.daemonId)) reject("authority_revoked");
    if (token?.userId && token.userId !== "local" && !this.store.getUserRoleInWorkspace(token.userId, task.workspaceId)) reject("authority_revoked");
    if (this.store.isDaemonRetired(task.workspaceId, session.daemonId)) reject("authority_revoked");
    if (token && runtime.daemonId !== session.daemonId
      && !this.store.canFeishuBotDaemonAccessTask(task.workspaceId, session.daemonId, task.id)) reject("authority_revoked");
    return task;
  }

  private append(frame: DaemonParsedFrame, session: DaemonProtocolSession) {
    try {
      const task = this.task(frame, session, true);
      const events = frame.payload.events as TraceEvent[];
      if (!Array.isArray(events) || !events.length || events.length > DAEMON_TRACE_APPEND_MAX_EVENTS
        || typeof frame.payload.closed !== "boolean"
        || events.some(event => !event || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== "string" || typeof event.ts !== "string")) return failure();
      const bytes = Buffer.byteLength(JSON.stringify(frame.raw));
      if (events.length > 1 && bytes > DAEMON_TRACE_APPEND_MAX_BYTES) return failure();
      for (let i = 1; i < events.length; i++) if (events[i]!.seq !== events[i - 1]!.seq + 1) return failure();
      const previous = this.sink.head(task.id) ?? 0;
      const fresh = events.filter(event => event.seq > previous);
      if (previous > 0 && fresh.length && fresh[0]!.seq !== previous + 1) return failure();
      // Memory's reference sink has a retention helper; the real Hub owns this.
      if (previous === 0 && this.sink instanceof InMemoryTraceSink) {
        this.sink.append(task.id, []);
        this.sink.dropBefore(task.id, events[0]!.seq);
      }
      this.runtimes.set(task.id, task.runtimeId!);
      const result = this.sink.append(task.id, events);
      if (frame.payload.closed || result.head >= (this.closingHeads.get(task.id) ?? Infinity)) {
        this.sink.close?.(task.id);
        this.closingHeads.delete(task.id);
      }
      this.wake();
      return { ok: true, hub_head: result.head };
    } catch (error) { return traceRejection(error); }
  }

  close(taskId: string, head: number, runtimeId: string): void {
    this.runtimes.set(taskId, runtimeId);
    // Reports outrank trace: completion can arrive before its declared tail.
    if ((this.sink.head(taskId) ?? 0) >= head) this.sink.close?.(taskId);
    else this.closingHeads.set(taskId, head);
    this.wake();
  }

  private head(frame: DaemonParsedFrame, session: DaemonProtocolSession) {
    try {
      const task = this.task(frame, session);
      const sub = this.sink.subscribe(task.id, this.sink.head(task.id) ?? 0, () => {});
      const reply = { ok: true, first_seq: sub.first_seq, head: sub.head, closed: sub.closed, gap: sub.gap };
      sub.unsubscribe();
      return reply;
    } catch (error) { return traceRejection(error); }
  }

  private subscribe(frame: DaemonParsedFrame, session: DaemonProtocolSession) {
    try {
      const task = this.task(frame, session);
      const from = frame.payload.from_seq;
      if (!Number.isSafeInteger(from) || (from as number) < 0) return failure();
      let subscriptions = this.subscribers.get(session);
      if (!subscriptions) this.subscribers.set(session, subscriptions = new Map());
      subscriptions.get(task.id)?.sink.unsubscribe();
      const sink = this.sink.subscribe(task.id, from as number, () => this.wake());
      subscriptions.set(task.id, { sink, cursor: from as number, closed: false });
      this.wake();
      return { ok: true, first_seq: sink.first_seq, head: sink.head, closed: sink.closed, gap: sink.gap };
    } catch (error) { return traceRejection(error); }
  }

  private unsubscribe(frame: DaemonParsedFrame, session: DaemonProtocolSession) {
    const taskId = frame.payload.task_id;
    if (typeof taskId !== "string") return failure();
    const subscriptions = this.subscribers.get(session);
    subscriptions?.get(taskId)?.sink.unsubscribe();
    subscriptions?.delete(taskId);
    if (!subscriptions?.size) this.subscribers.delete(session);
    return { ok: true };
  }

  private fetch(frame: DaemonParsedFrame, session: DaemonProtocolSession) {
    try {
      const task = this.task(frame, session);
      if (!Number.isSafeInteger(frame.payload.after_seq) || (frame.payload.after_seq as number) < 0) return failure();
      return session.deferReply(frame.id ?? "", this.reader.read({ taskId: task.id, runtimeId: task.runtimeId!,
        afterSeq: frame.payload.after_seq as number, limit: typeof frame.payload.limit === "number" ? frame.payload.limit : undefined }));
    } catch (error) { return traceRejection(error); }
  }

  private wake(): void {
    if (this.timer || !this.subscribers.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
      if (this.subscribers.size) this.wake();
    }, 20);
    this.timer.unref?.();
  }

  private flush(): void {
    for (const [session, subscriptions] of this.subscribers) for (const [taskId, sub] of subscriptions) {
      if (session.isClosed || session.isPaused) continue;
      if (sub.cursor >= sub.sink.head && (!sub.sink.closed || sub.closed)) continue;
      try { this.readTask(taskId, session); }
      catch (error) {
        traceRejection(error);
        sub.sink.unsubscribe(); subscriptions.delete(taskId);
        if (!subscriptions.size) this.subscribers.delete(session);
        continue;
      }
      const events: TraceEvent[] = [];
      let bytes = 0;
      const envelopeBytes = Buffer.byteLength(encodeDaemonProtocolFrame({ t: "trace.push", seq: Number.MAX_SAFE_INTEGER,
        p: { task_id: taskId, events: [], closed: false } }, Number.MAX_SAFE_INTEGER));
      const snapshot = this.sink.subscribe(taskId, sub.cursor, (_id, backlog) => {
        for (const event of backlog) {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (events.length >= DAEMON_TRACE_APPEND_MAX_EVENTS || (events.length && envelopeBytes + bytes + size + events.length > DAEMON_TRACE_APPEND_MAX_BYTES)) break;
          events.push(event);
          bytes += size;
        }
      });
      snapshot.unsubscribe();
      const next = events.at(-1)?.seq ?? sub.cursor;
      const closed = sub.sink.closed && next >= sub.sink.head;
      const sent = session.sendEvent({ t: "trace.push", p: { task_id: taskId, events, closed } }, { pausable: true });
      if (sent.ok) { sub.cursor = next; sub.closed = closed; }
    }
  }
}

const services = new WeakMap<DaemonProtocolLayer, DaemonTraceService>();
export function registerDaemonTraceHandlers(layer: DaemonProtocolLayer, store: MultiremiStore, sink?: TraceSink): DaemonTraceService {
  const service = new DaemonTraceService(layer, store, sink);
  services.set(layer, service);
  return service;
}
export function daemonTraceService(layer: DaemonProtocolLayer): DaemonTraceService {
  const service = services.get(layer);
  if (!service) throw new Error("daemon trace handlers are not registered");
  return service;
}
