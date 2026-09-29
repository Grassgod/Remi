import {
  DAEMON_TRACE_APPEND_MAX_BYTES, DAEMON_TRACE_APPEND_MAX_EVENTS,
  DAEMON_TRACE_REPLAY_MAX_BYTES, DAEMON_TRACE_REPLAY_MAX_EVENTS,
} from "@multiremi/contracts/daemon-protocol.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";
import { traceEventBytes, type TraceStore } from "@multiremi/worker/trace-store.js";
import { encodeDaemonProtocolFrame } from "../api/daemon-protocol/frames.js";

/** The cold replay budget is a tail budget, not a prefix of the last 2,000 rows. */
export function coldTraceCursor(store: TraceStore, taskId: string): number {
  const head = store.head(taskId)?.head ?? 0;
  const events: TraceEvent[] = [];
  let cursor = Math.max(0, head - DAEMON_TRACE_REPLAY_MAX_EVENTS);
  while (cursor < head) {
    const page = store.read(taskId, cursor, 500);
    if (!page.events.length) break;
    events.push(...page.events);
    cursor = page.events.at(-1)!.seq;
  }
  let bytes = 0;
  let first = events.length;
  while (first > 0) {
    const size = traceEventBytes(events[first - 1]!);
    if (bytes + size > DAEMON_TRACE_REPLAY_MAX_BYTES) break;
    bytes += size;
    first--;
  }
  return first < events.length ? events[first]!.seq - 1 : head;
}

interface StreamCursor { runtimeId: string; afterSeq: number; closed: boolean; blocked: boolean }

/** One process-wide, lower-priority pump; trace cursors never occupy outbox rows. */
export class TraceStreamer {
  private readonly tasks = new Map<string, StreamCursor>();
  private heads: Record<string, number> = {};
  private generation = 0;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly protocol: DaemonProtocolClient, private readonly store: TraceStore,
    private readonly reportsHavePriority: () => boolean = () => false,
    private readonly onError: (taskId: string, error: unknown) => void = () => {}) {
    this.unsubscribe = protocol.onWelcome(welcome => {
      this.generation++;
      this.heads = welcome.trace_heads;
      for (const [taskId, cursor] of this.tasks) this.reset(taskId, cursor);
      this.wake();
    });
  }

  track(taskId: string, runtimeId: string): void {
    if (!this.tasks.has(taskId)) {
      const cursor = { runtimeId, afterSeq: 0, closed: false, blocked: false };
      this.reset(taskId, cursor);
      this.tasks.set(taskId, cursor);
    }
    this.wake();
  }

  private reset(taskId: string, cursor: StreamCursor): void {
    cursor.afterSeq = this.heads[taskId] || coldTraceCursor(this.store, taskId);
    cursor.closed = false;
    cursor.blocked = false;
  }

  wake(): void {
    if (this.stopped || this.running || this.timer) return;
    // Yield to the reliable report pump even when both were woken by welcome.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.pump().finally(() => {
        this.running = null;
        if (!this.stopped && this.hasWork()) this.wake();
      });
    }, 10);
    this.timer.unref?.();
  }

  private hasWork(): boolean {
    return [...this.tasks].some(([id, cursor]) => {
      const head = this.store.head(id);
      return !cursor.blocked && head && (head.head > cursor.afterSeq || (head.head > 0 && head.closed && !cursor.closed));
    });
  }

  private async pump(): Promise<void> {
    if (this.protocol.connectionState() !== "connected" || this.protocol.uplinkPaused() || this.reportsHavePriority()) return;
    const generation = this.generation;
    for (const [taskId, cursor] of this.tasks) {
      if (this.stopped || this.reportsHavePriority() || this.protocol.uplinkPaused()) break;
      if (cursor.blocked) continue;
      const head = this.store.head(taskId);
      if (!head || (head.head <= cursor.afterSeq && (!head.closed || cursor.closed || head.head === 0))) continue;
      // A late close replays the last event with closed=true; never an empty batch.
      const afterSeq = head.head <= cursor.afterSeq ? head.head - 1 : cursor.afterSeq;
      const envelopeBytes = Buffer.byteLength(encodeDaemonProtocolFrame({ t: "trace.append", id: "x".repeat(36),
        rt: cursor.runtimeId, ack: Number.MAX_SAFE_INTEGER, p: { task_id: taskId, events: [], closed: false } }, Number.MAX_SAFE_INTEGER));
      const page = this.store.read(taskId, afterSeq, DAEMON_TRACE_APPEND_MAX_EVENTS,
        Math.max(1, DAEMON_TRACE_APPEND_MAX_BYTES - envelopeBytes - DAEMON_TRACE_APPEND_MAX_EVENTS));
      if (!page.events.length) continue;
      const closed = head.closed && page.events.at(-1)!.seq >= head.head;
      try {
        const reply = await this.protocol.rpc("trace.append", { task_id: taskId, events: page.events, closed }, cursor.runtimeId);
        if (generation !== this.generation) return;
        const hubHead = reply.hub_head;
        if (!Number.isSafeInteger(hubHead) || (hubHead as number) < page.events.at(-1)!.seq) throw new Error("trace.append did not acknowledge its head");
        cursor.afterSeq = hubHead as number;
        cursor.closed = closed;
      } catch (error) {
        if (generation !== this.generation || this.stopped) return;
        if ((error as { retryable?: boolean }).retryable === false) cursor.blocked = true;
        this.onError(taskId, error);
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }
}
