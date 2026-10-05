import type { TaskMessageInput } from "@multiremi/contracts/types.js";
import { taskMessageToTraceEvent, traceEventToTaskMessage } from "@multiremi/contracts/trace.js";
import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { createTraceSummaryAccumulator } from "@shared/trace-derive.js";
import { TraceFileStore } from "./trace-file-store.js";
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
  private readonly summaries = new Map<string, ReturnType<typeof createTraceSummaryAccumulator>>();
  private readonly completedSummaries = new Map<string, DaemonTaskCompletionFields>();
  private readonly detach: () => void;
  constructor(private readonly protocol: DaemonProtocolClient, store: TraceStore = new InMemoryTraceStore(),
    reportsHavePriority: () => boolean = () => false, onError: (error: unknown) => void = () => {},
    ownership: ReadonlyMap<string, string> = new Map()) {
    this.store = store;
    this.runtimeByTask = new Map([...(store instanceof TraceFileStore ? store.ownership() : []), ...ownership]);
    this.streamer = new TraceStreamer(protocol, store, reportsHavePriority, (_task, error) => onError(error));
    for (const [taskId, runtimeId] of this.runtimeByTask) {
      // Historical closed traces remain readable without replaying every turn
      // whenever the process boots. Active turns resume the live pump.
      if (!store.head(taskId)?.closed) this.streamer.track(taskId, runtimeId);
    }
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
      let page;
      try { page = store.read(taskId, after, limit, bytes); }
      catch (error) {
        onError(error);
        protocol.send({ t: "res", re: frame.id, p: { ok: false, code: "trace_not_hot", retryable: false } });
        return;
      }
      protocol.send({ t: "res", re: frame.id, p: { ok: true, ...page,
        next_after_seq: page.events.at(-1)?.seq ?? after, closed: head.closed } });
    });
  }

  ownership(): ReadonlyMap<string, string> { return this.runtimeByTask; }

  pruneMissing(): void {
    if (!(this.store instanceof TraceFileStore)) return;
    for (const taskId of this.store.pruneMissing()) {
      this.runtimeByTask.delete(taskId);
      this.summaries.delete(taskId);
      this.completedSummaries.delete(taskId);
      this.streamer.forget(taskId);
    }
  }

  track(taskId: string, runtimeId: string): void {
    const owner = this.runtimeByTask.get(taskId);
    if (owner && owner !== runtimeId) throw new Error("trace runtime ownership changed");
    if (this.store instanceof TraceFileStore) this.store.registerRuntime(taskId, runtimeId);
    this.runtimeByTask.set(taskId, runtimeId);
    this.store.append(taskId, []);
    this.streamer.track(taskId, runtimeId);
  }

  append(taskId: string, runtimeId: string, messages: TaskMessageInput[]): TaskMessageInput[] {
    this.track(taskId, runtimeId);
    if (this.store.head(taskId)?.closed) return [];
    const summary = this.summary(taskId);
    const appended = this.store.append(taskId, messages.map(message => {
      const { ts: _backfillTimestamp, ...event } = taskMessageToTraceEvent(message, "");
      return event;
    }));
    for (const event of appended.events) summary.add(event);
    this.streamer.wake();
    return appended.events.map(traceEventToTaskMessage);
  }

  private summary(taskId: string): ReturnType<typeof createTraceSummaryAccumulator> {
    const existing = this.summaries.get(taskId);
    if (existing) return existing;
    const summary = createTraceSummaryAccumulator();
    let after = 0;
    for (;;) {
      const page = this.store.read(taskId, after, 500, DAEMON_TRACE_READ_MAX_BYTES);
      for (const event of page.events) summary.add(event);
      if (page.eof || !page.events.length) break;
      after = page.events.at(-1)!.seq;
    }
    this.summaries.set(taskId, summary);
    return summary;
  }

  completion(taskId: string): DaemonTaskCompletionFields {
    const cached = this.completedSummaries.get(taskId);
    if (cached) {
      this.completedSummaries.delete(taskId);
      this.completedSummaries.set(taskId, cached);
      return cached;
    }
    const result = this.summary(taskId).completion(this.store.head(taskId)?.head ?? 0);
    const completion: DaemonTaskCompletionFields = { ...result, trace: { ...result.trace, closed: true } };
    if (this.store.head(taskId)?.closed) {
      this.summaries.delete(taskId);
      this.cacheCompletion(taskId, completion);
    }
    return completion;
  }

  private cacheCompletion(taskId: string, completion: DaemonTaskCompletionFields): void {
    this.completedSummaries.delete(taskId);
    this.completedSummaries.set(taskId, completion);
    while (this.completedSummaries.size > 128) this.completedSummaries.delete(this.completedSummaries.keys().next().value!);
  }

  close(taskId: string, status: TraceEndStatus): void {
    this.store.close(taskId, { status, ended_at: new Date().toISOString() });
    const summary = this.summaries.get(taskId);
    if (summary) {
      const result = summary.completion(this.store.head(taskId)?.head ?? 0);
      this.cacheCompletion(taskId, { ...result, trace: { ...result.trace, closed: true } });
      this.summaries.delete(taskId);
    }
    this.streamer.wake();
  }

  async stop(): Promise<void> {
    this.detach();
    this.summaries.clear();
    this.completedSummaries.clear();
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
export function acquireDaemonTrace(protocol: DaemonProtocolClient, store: TraceStore | (() => TraceStore) | undefined,
  reportsHavePriority: () => boolean, onError: (error: unknown) => void): DaemonTraceTransport {
  let entry = shared.get(protocol);
  const resolveStore = () => typeof store === "function" ? store() : store;
  if (!entry) shared.set(protocol, entry = { transport: new DaemonTraceTransport(protocol, resolveStore(), reportsHavePriority, onError), owners: 0 });
  else if (!entry.owners) entry.transport = new DaemonTraceTransport(protocol, resolveStore() ?? entry.transport.store,
    reportsHavePriority, onError, entry.transport.ownership());
  entry.owners++;
  return entry.transport;
}
export async function releaseDaemonTrace(protocol: DaemonProtocolClient): Promise<void> {
  const entry = shared.get(protocol);
  if (!entry || --entry.owners > 0) return;
  await entry.transport.stop();
}
