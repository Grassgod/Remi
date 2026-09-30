import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { DaemonProtocolClient, DaemonProtocolRpcError } from "./daemon-protocol-client.js";
import type { DaemonParsedFrame } from "../api/daemon-protocol/frames.js";

export type DaemonTraceListener = (events: TraceEvent[], closed: boolean) => void | Promise<void>;
interface Listener { cursor: number; callback: DaemonTraceListener }
interface Subscription { listeners: Set<Listener>; chain: Promise<void>; control: Promise<void> }

/** One wire subscription per task, with independent cursors for local consumers. */
export class DaemonTraceSubscriptions {
  private readonly tasks = new Map<string, Subscription>();
  private readonly detach: Array<() => void>;
  private stopped = false;
  constructor(private readonly protocol: DaemonProtocolClient,
    private readonly runtimeId: () => string | undefined,
    private readonly onError: (error: unknown) => void = () => {}) {
    this.detach = [protocol.onFrame(frame => this.frame(frame)), protocol.onWelcome(() => {
      for (const [taskId, sub] of this.tasks) void this.control(sub, () => this.connect(taskId, sub)).catch(() => {});
    })];
  }

  async subscribeTrace(taskId: string, fromSeq: number, callback: DaemonTraceListener): Promise<() => Promise<void>> {
    if (this.stopped) throw new DaemonProtocolRpcError("daemon_unreachable", true);
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new Error("invalid trace cursor");
    let sub = this.tasks.get(taskId);
    if (!sub) this.tasks.set(taskId, sub = { listeners: new Set(), chain: Promise.resolve(), control: Promise.resolve() });
    const listener = { cursor: fromSeq, callback };
    sub.listeners.add(listener);
    try {
      if (this.protocol.connectionState() === "connected") await this.control(sub, () => this.connect(taskId, sub!));
    } catch (error) {
      sub.listeners.delete(listener);
      if (!sub.listeners.size && this.tasks.get(taskId) === sub) this.tasks.delete(taskId);
      throw error;
    }
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      sub!.listeners.delete(listener);
      if (sub!.listeners.size) return;
      await this.control(sub!, async () => {
        if (sub!.listeners.size || this.tasks.get(taskId) !== sub) return;
        if (this.protocol.connectionState() === "connected") await this.protocol.rpc("trace.unsubscribe", { task_id: taskId }, this.runtimeId());
        if (!sub!.listeners.size) this.tasks.delete(taskId);
      });
    };
  }

  private cursor(sub: Subscription): number { return Math.min(...[...sub.listeners].map(listener => listener.cursor)); }
  private enqueue(sub: Subscription, work: () => Promise<void>): Promise<void> {
    const result = sub.chain.then(work);
    sub.chain = result.catch(error => this.onError(error));
    return result;
  }
  private control(sub: Subscription, work: () => Promise<void>): Promise<void> {
    const result = sub.control.then(work);
    sub.control = result.catch(error => this.onError(error));
    return result;
  }

  private async connect(taskId: string, sub: Subscription): Promise<void> {
    if (this.stopped || this.tasks.get(taskId) !== sub || !sub.listeners.size) return;
    const reply = await this.protocol.rpc("trace.subscribe", { task_id: taskId, from_seq: this.cursor(sub) }, this.runtimeId());
    if (reply.gap) void this.enqueue(sub, () => this.fill(taskId, sub, Number(reply.head))).catch(() => {});
  }

  private async frame(frame: DaemonParsedFrame): Promise<void> {
    if (frame.type !== "trace.push" || typeof frame.payload.task_id !== "string" || !Array.isArray(frame.payload.events)) return;
    const taskId = frame.payload.task_id;
    const sub = this.tasks.get(taskId);
    if (!sub) return;
    return this.enqueue(sub, async () => {
      if (this.stopped || !sub.listeners.size) return;
      const events = frame.payload.events as TraceEvent[];
      const first = events[0]?.seq;
      if (first !== undefined && first > this.cursor(sub) + 1) await this.fill(taskId, sub, first - 1);
      await this.deliver(sub, events, frame.payload.closed === true);
    });
  }

  private async fill(taskId: string, sub: Subscription, target: number): Promise<void> {
    while (!this.stopped && sub.listeners.size && this.cursor(sub) < target) {
      const after = this.cursor(sub);
      const page = await this.protocol.rpc("trace.fetch", { task_id: taskId, after_seq: after, limit: 500 }, this.runtimeId());
      if (!Array.isArray(page.events) || !page.events.length) throw new Error("trace.fetch could not fill the advertised gap");
      await this.deliver(sub, page.events as TraceEvent[], page.closed === true && page.eof === true);
      if (this.cursor(sub) <= after) throw new Error("trace.fetch did not advance the cursor");
    }
  }

  private async deliver(sub: Subscription, events: TraceEvent[], closed: boolean): Promise<void> {
    for (const listener of [...sub.listeners]) {
      if (!sub.listeners.has(listener) || this.stopped) continue;
      const fresh = events.filter(event => event.seq > listener.cursor);
      if (!fresh.length && !closed) continue;
      await listener.callback(fresh, closed);
      if (fresh.length) listener.cursor = fresh.at(-1)!.seq;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const detach of this.detach) detach();
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const sub of tasks) sub.listeners.clear();
    await Promise.allSettled(tasks.flatMap(sub => [sub.chain, sub.control]));
  }
}
