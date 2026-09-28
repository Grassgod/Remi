import type { TaskMessageInput } from "@multiremi/contracts/types.js";
import { taskMessageToTraceEvent, traceEventToTaskMessage } from "@multiremi/contracts/trace.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { deriveFinalReply, deriveTraceModel, summarizeTrace } from "@shared/trace-derive.js";
import { InMemoryTraceStore, type TraceStore, type TraceEndStatus } from "@multiremi/worker/trace-store.js";
import { DAEMON_TRACE_READ_MAX_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";
import { TraceStreamer } from "./trace-streamer.js";
import { DaemonTraceSubscriptions } from "./trace-subscriptions.js";

/** Runtime ownership lives outside TraceStore so its A-0/file contract stays small. */
export class DaemonTraceTransport {
  readonly store: TraceStore;
  readonly streamer: TraceStreamer;
  readonly subscriptions: DaemonTraceSubscriptions;
  private readonly runtimeByTask: Map<string, string>;
  private readonly detach: () => void;
  constructor(private readonly protocol: DaemonProtocolClient, store: TraceStore = new InMemoryTraceStore(),
    reportsHavePriority: () => boolean = () => false, onError: (error: unknown) => void = () => {},
    ownership: ReadonlyMap<string, string> = new Map()) {
    this.store = store;
    this.runtimeByTask = new Map(ownership);
    this.streamer = new TraceStreamer(protocol, store, reportsHavePriority, (_task, error) => onError(error));
    for (const [taskId, runtimeId] of ownership) this.streamer.track(taskId, runtimeId);
    this.subscriptions = new DaemonTraceSubscriptions(protocol, () => undefined, onError);
    this.detach = protocol.onFrame(frame => {
      if (frame.type !== "trace.read" || !frame.id) return;
      const p = frame.payload;
      const taskId = typeof p.task_id === "string" ? p.task_id : "";
      const head = store.head(taskId);
      if (!head || !frame.rt || this.runtimeByTask.get(taskId) !== frame.rt) {
        protocol.send({ t: "res", re: frame.id, p: { ok: false, code: "trace_not_hot", retryable: false } });
        return;
      }
      const after = typeof p.after_seq === "number" ? Math.max(0, Math.floor(p.after_seq)) : 0;
      const limit = typeof p.limit === "number" ? Math.max(1, Math.min(500, Math.floor(p.limit))) : 200;
      const bytes = typeof p.max_bytes === "number" ? Math.max(1, Math.min(DAEMON_TRACE_READ_MAX_BYTES - 1024, Math.floor(p.max_bytes))) : DAEMON_TRACE_READ_MAX_BYTES - 1024;
      const page = store.read(taskId, after, limit, bytes);
      protocol.send({ t: "res", re: frame.id, p: { ok: true, ...page,
        next_after_seq: page.events.at(-1)?.seq ?? after, closed: head.closed } });
    });
  }

  ownership(): ReadonlyMap<string, string> { return this.runtimeByTask; }

  track(taskId: string, runtimeId: string): void {
    this.runtimeByTask.set(taskId, runtimeId);
    this.store.append(taskId, []);
    this.streamer.track(taskId, runtimeId);
  }

  append(taskId: string, runtimeId: string, messages: TaskMessageInput[]): TaskMessageInput[] {
    this.track(taskId, runtimeId);
    const appended = this.store.append(taskId, messages.map(message => {
      const { ts: _backfillTimestamp, ...event } = taskMessageToTraceEvent(message, "");
      return event;
    }));
    this.streamer.wake();
    return appended.events.map(traceEventToTaskMessage);
  }

  completion(taskId: string): DaemonTaskCompletionFields {
    const events = [] as ReturnType<TraceStore["read"]>["events"];
    let after = 0;
    for (;;) {
      const page = this.store.read(taskId, after, 500);
      events.push(...page.events);
      if (page.eof || !page.events.length) break;
      after = page.events.at(-1)!.seq;
    }
    return { trace: { ...summarizeTrace(events, this.store.head(taskId)?.head ?? 0), closed: true },
      final_reply_md: deriveFinalReply(events), model: deriveTraceModel(events) };
  }

  close(taskId: string, status: TraceEndStatus): void {
    this.store.close(taskId, { status, ended_at: new Date().toISOString() });
    this.streamer.wake();
  }

  async stop(): Promise<void> {
    this.detach();
    await Promise.all([this.streamer.stop(), this.subscriptions.stop()]);
  }
}

const shared = new WeakMap<DaemonProtocolClient, { transport: DaemonTraceTransport; owners: number }>();
export function daemonTraceTransport(protocol: DaemonProtocolClient): DaemonTraceTransport {
  const entry = shared.get(protocol);
  if (!entry) throw new Error("daemon trace transport is not initialized");
  return entry.transport;
}
export function daemonTraceStore(protocol: DaemonProtocolClient): TraceStore {
  return daemonTraceTransport(protocol).store;
}
export function acquireDaemonTrace(protocol: DaemonProtocolClient, store: TraceStore | undefined,
  reportsHavePriority: () => boolean, onError: (error: unknown) => void): DaemonTraceTransport {
  let entry = shared.get(protocol);
  if (!entry) shared.set(protocol, entry = { transport: new DaemonTraceTransport(protocol, store, reportsHavePriority, onError), owners: 0 });
  else if (!entry.owners) entry.transport = new DaemonTraceTransport(protocol, store ?? entry.transport.store,
    reportsHavePriority, onError, entry.transport.ownership());
  entry.owners++;
  return entry.transport;
}
export async function releaseDaemonTrace(protocol: DaemonProtocolClient): Promise<void> {
  const entry = shared.get(protocol);
  if (!entry || --entry.owners > 0) return;
  await entry.transport.stop();
}
