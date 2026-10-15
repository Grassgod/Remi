import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import { DAEMON_TRACE_READ_MAX_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import type { TraceEvent, TraceEventInput, TraceItem, TraceTurn } from "@multiremi/contracts/trace.js";
import {
  closeOpenItems,
  completeTurn,
  turnCompletionFields,
  turnTraceSnapshot,
  type TurnTraceFold,
  type TurnTraceState,
} from "@shared/turn-trace.js";
import { TraceFileStore } from "./trace-file-store.js";
import { InMemoryTraceStore, type TraceStore, type TraceEndStatus } from "@multiremi/worker/trace-store.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";
import { TraceStreamer } from "./trace-streamer.js";
import { DaemonTraceSubscriptions } from "./trace-subscriptions.js";
import { foldStoredTrace, readEventPage, readTurnPage } from "./trace-pages.js";

/** Completion summaries of closed traces kept for a repeated terminal report. */
const COMPLETED_CACHE_LIMIT = 128;
/** Per-trace snapshot part sizes kept for `view=turn` paging of closed traces. */
const SNAPSHOT_INDEX_LIMIT = 128;
const READ_DEFAULT_LIMIT = 200;
const READ_MAX_LIMIT = 500;

/** The turn error `close` records: the failure text and its classified reason. */
export interface TraceCloseError {
  message: string;
  reason?: string | null;
}

interface FoldEntry {
  fold: TurnTraceFold;
  /** Event lines stored, valid or not; equals `head` for a dense trace. */
  eventCount: number;
}

/**
 * The daemon's trace owner: appends go to the store and then into one fold per
 * running attempt (`@shared/turn-trace.js`), which answers `completion()` and
 * `trace.read view=turn` without reading the file. Runtime ownership lives here
 * rather than in `TraceStore` so its A-0/file contract stays small.
 */
export class DaemonTraceTransport {
  readonly store: TraceStore;
  readonly streamer: TraceStreamer;
  readonly subscriptions: DaemonTraceSubscriptions;
  private readonly runtimeByTask: Map<string, string>;
  private readonly folds = new Map<string, FoldEntry>();
  private readonly completed = new Map<string, DaemonTaskCompletionFields>();
  private readonly snapshotIndex = new Map<string, number[]>();
  private readonly detach: () => void;
  private stopped = false;
  constructor(private readonly protocol: DaemonProtocolClient, store: TraceStore = new InMemoryTraceStore(),
    reportsHavePriority: () => boolean = () => false, private readonly onError: (error: unknown) => void = () => {},
    ownership: ReadonlyMap<string, string> = new Map(), private readonly now: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.runtimeByTask = new Map([...(store instanceof TraceFileStore ? store.ownership() : []), ...ownership]);
    this.streamer = new TraceStreamer(protocol, store, reportsHavePriority, (_task, error) => onError(error));
    for (const [taskId, runtimeId] of this.runtimeByTask) {
      // Historical closed traces remain readable without replaying every turn
      // whenever the process boots, and a v1 trace is read-only history. Active
      // v2 turns resume the live pump.
      if (store.format(taskId) === "v2" && !store.head(taskId)?.closed) this.streamer.track(taskId, runtimeId);
    }
    this.subscriptions = new DaemonTraceSubscriptions(protocol, () => undefined, onError);
    if (store instanceof TraceFileStore) void this.resumeUnclosed(store, onError);
    this.detach = protocol.onFrame(frame => {
      if (frame.type !== "trace.read" || !frame.id) return;
      const requestId = frame.id;
      const notHot = () => protocol.send({ t: "res", re: requestId, p: { ok: false, code: "trace_not_hot", retryable: false } });
      const p = frame.payload;
      const taskId = typeof p.task_id === "string" ? p.task_id : "";
      const head = store.head(taskId);
      if (!head || !frame.rt || this.ownerOf(taskId) !== frame.rt) {
        notHot();
        return;
      }
      if (p.view !== "turn" && p.view !== "events") {
        // Every server past the release gate names a view; nothing else is answered.
        protocol.send({ t: "res", re: requestId, p: { ok: false, code: "protocol_violation", retryable: false } });
        return;
      }
      const limit = typeof p.limit === "number" ? Math.max(1, Math.min(READ_MAX_LIMIT, Math.floor(p.limit))) : READ_DEFAULT_LIMIT;
      const bytes = typeof p.max_bytes === "number" ? Math.max(1, Math.min(DAEMON_TRACE_READ_MAX_BYTES - 1024, Math.floor(p.max_bytes))) : DAEMON_TRACE_READ_MAX_BYTES - 1024;
      let reply: Record<string, unknown>;
      try {
        const page = p.view === "turn"
          ? this.readTurn(taskId, typeof p.item_cursor === "number" ? Math.max(0, Math.floor(p.item_cursor)) : 0, limit, bytes)
          : readEventPage(store, taskId, { afterSeq: typeof p.after_seq === "number" ? Math.max(0, Math.floor(p.after_seq)) : 0, limit, maxBytes: bytes });
        if (!page) {
          notHot();
          return;
        }
        reply = { ok: true, ...page };
      } catch (error) {
        onError(error);
        notHot();
        return;
      }
      protocol.send({ t: "res", re: requestId, p: reply });
    });
  }

  ownership(): ReadonlyMap<string, string> { return this.runtimeByTask; }

  /** Traces a crash left open resume their upload to the hub; closed history is never replayed. */
  private async resumeUnclosed(store: TraceFileStore, onError: (error: unknown) => void): Promise<void> {
    try {
      for (const [taskId, runtimeId] of await store.findUnclosed()) {
        if (this.stopped || this.runtimeByTask.has(taskId)) continue;
        this.runtimeByTask.set(taskId, runtimeId);
        this.streamer.track(taskId, runtimeId);
      }
    } catch (error) {
      onError(error);
    }
  }

  /** Owner of a trace; a file nobody touched since the daemon started is indexed on demand. */
  private ownerOf(taskId: string): string | undefined {
    return this.runtimeByTask.get(taskId) ?? (this.store instanceof TraceFileStore ? this.store.owner(taskId) : undefined);
  }

  pruneMissing(): void {
    if (!(this.store instanceof TraceFileStore)) return;
    for (const taskId of this.store.pruneMissing()) {
      this.runtimeByTask.delete(taskId);
      this.forgetCaches(taskId);
      this.streamer.forget(taskId);
    }
  }

  private forgetCaches(taskId: string): void {
    this.folds.delete(taskId);
    this.completed.delete(taskId);
    this.snapshotIndex.delete(taskId);
  }

  track(taskId: string, runtimeId: string): void {
    const owner = this.runtimeByTask.get(taskId);
    if (owner && owner !== runtimeId) throw new Error("trace runtime ownership changed");
    if (this.store instanceof TraceFileStore) this.store.registerRuntime(taskId, runtimeId);
    this.runtimeByTask.set(taskId, runtimeId);
    if (this.store.format(taskId) === "v1") return;
    this.store.append(taskId, []);
    this.streamer.track(taskId, runtimeId);
  }

  /** Append bodies, apply what the store kept to the fold, and wake the hub pump. */
  append(taskId: string, runtimeId: string, events: TraceEventInput[]): TraceEvent[] {
    this.track(taskId, runtimeId);
    if (this.store.head(taskId)?.closed) return [];
    const entry = this.fold(taskId);
    const appended = this.store.append(taskId, events);
    entry.fold.apply(appended.events);
    entry.eventCount += appended.events.length;
    this.streamer.wake();
    return appended.events;
  }

  /** The fold of a trace, rebuilt from the store once when it is not resident (restart, eviction). */
  private fold(taskId: string): FoldEntry {
    const existing = this.folds.get(taskId);
    if (existing) return existing;
    const entry: FoldEntry = foldStoredTrace(this.store, taskId);
    this.folds.set(taskId, entry);
    return entry;
  }

  /**
   * `task.complete` / `task.fail` fields (spec §3.5) from the fold. Before the
   * trace is closed they describe the close that will follow: the open items it
   * completes and its `turn.completed` are counted in `head` / `event_count`, and
   * the final item and `worked_ms` are what `turn.completed` will record. The
   * report is sent before `close()` so a rejected `completeTurn` (steer pending)
   * can keep appending to the turn.
   */
  completion(taskId: string, status: Exclude<TraceEndStatus, "cancelled"> = "completed"): DaemonTaskCompletionFields {
    const cached = this.completed.get(taskId);
    if (cached) {
      this.completed.delete(taskId);
      this.completed.set(taskId, cached);
      return cached;
    }
    const entry = this.fold(taskId);
    const head = this.store.head(taskId);
    if (head?.closed) {
      const fields = turnCompletionFields(entry.fold.state(), { eventCount: entry.eventCount });
      this.cacheCompletion(taskId, fields);
      this.folds.delete(taskId);
      return fields;
    }
    const closing = this.closingEvents(entry.fold.state(), status);
    const prospective = { ...closing.state, head: (head?.head ?? 0) + closing.events.length };
    return turnCompletionFields(prospective, { eventCount: entry.eventCount + closing.events.length });
  }

  /** The events `close` appends (open items, then `turn.completed`) and the fold they lead to. */
  private closingEvents(state: TurnTraceState, status: TraceEndStatus, error?: TraceCloseError | null): {
    events: TraceEventInput[]; state: Pick<TurnTraceState, "turn" | "items">;
  } {
    const at = this.now();
    const open = closeOpenItems(state.items, status, at);
    let items: readonly TraceItem[] = state.items;
    if (open.length) {
      const replaced = new Map(open.map((body) => [(body as { item: TraceItem }).item.id, (body as { item: TraceItem }).item]));
      items = state.items.map((item) => replaced.get(item.id) ?? item);
    }
    const events: TraceEventInput[] = [...open];
    let turn: TraceTurn | null = state.turn;
    if (turn && turn.status === "running") {
      turn = completeTurn({ turn, items }, {
        status, completedAt: at, error: error ? { message: error.message, reason: error.reason ?? null } : null,
      });
      if (turn) events.push({ type: "turn.completed", turn });
    }
    return { events, state: { turn, items } };
  }

  private cacheCompletion(taskId: string, completion: DaemonTaskCompletionFields): void {
    this.completed.delete(taskId);
    this.completed.set(taskId, completion);
    while (this.completed.size > COMPLETED_CACHE_LIMIT) this.completed.delete(this.completed.keys().next().value!);
  }

  /**
   * Seal a trace (spec §3.1): `item.completed` for every open item, then
   * `turn.completed`, then the snapshot framing and the trailer. Idempotent; a
   * v1 trace is read-only history and is left as it is.
   */
  close(taskId: string, status: TraceEndStatus, error?: TraceCloseError | null): void {
    const head = this.store.head(taskId);
    if (head?.closed || this.store.format(taskId) === "v1") return;
    const entry = this.fold(taskId);
    const closing = this.closingEvents(entry.fold.state(), status, error);
    if (closing.events.length) {
      const appended = this.store.append(taskId, closing.events);
      entry.fold.apply(appended.events);
      entry.eventCount += appended.events.length;
    }
    const state = entry.fold.state();
    this.store.close(taskId, { status, ended_at: this.now(), snapshot: turnTraceSnapshot(state, true) });
    this.cacheCompletion(taskId, turnCompletionFields(state, { eventCount: entry.eventCount }));
    this.folds.delete(taskId);
    this.streamer.wake();
  }

  /** One `view=turn` page: the running fold, the closed snapshot, or a legacy (v1) answer. */
  private readTurn(taskId: string, cursor: number, limit: number, maxBytes: number) {
    // Part item counts are remembered per closed trace, so a later page reads only the parts it returns.
    const sizes = this.snapshotIndex.get(taskId) ?? [];
    const page = readTurnPage(this.store, taskId, { itemCursor: cursor, limit, maxBytes },
      () => this.fold(taskId).fold.state(), sizes);
    if (page?.format === "v2" && page.closed) {
      this.snapshotIndex.delete(taskId);
      this.snapshotIndex.set(taskId, sizes);
      while (this.snapshotIndex.size > SNAPSHOT_INDEX_LIMIT) this.snapshotIndex.delete(this.snapshotIndex.keys().next().value!);
    }
    return page;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.detach();
    this.folds.clear();
    this.completed.clear();
    this.snapshotIndex.clear();
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
