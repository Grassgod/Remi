import type { MultiremiTaskHumanRequest, MultiremiTaskSteerMessage, MultiremiTaskStatus } from "@multiremi/contracts/types.js";
import { DaemonProtocolClient, DaemonProtocolRpcError } from "./daemon-protocol-client.js";
import type { TaskSteerSource } from "./steer.js";

type Terminal = Extract<MultiremiTaskStatus, "completed" | "failed" | "cancelled">;
const MAX_SETTLED_REQUESTS = 1024;

/** Per-runtime push inbox. The executing task owns cancellation and steer consumption. */
export class DaemonTaskDownlinks implements TaskSteerSource {
  private readonly steers = new Map<string, Map<string, MultiremiTaskSteerMessage>>();
  private readonly steerListeners = new Map<string, Set<(message: MultiremiTaskSteerMessage) => void>>();
  private readonly settled = new Map<string, MultiremiTaskHumanRequest>();
  private readonly humanListeners = new Map<string, Set<(request: MultiremiTaskHumanRequest) => void>>();
  private readonly cancelListeners = new Map<string, (status: Terminal) => void>();
  private readonly connectionWaiters = new Set<(error?: Error) => void>();

  constructor(private readonly client: DaemonProtocolClient, private readonly runtimeId: () => string | undefined) {
    client.registerFrameHandler("task.steer", frame => {
      if (!frame.rt || frame.rt !== runtimeId()) return;
      const message = frame.payload.steer as MultiremiTaskSteerMessage | undefined;
      if (!message?.id || typeof frame.payload.task_id !== "string" || message.taskId !== frame.payload.task_id) return;
      let messages = this.steers.get(message.taskId);
      if (!messages) { messages = new Map(); this.steers.set(message.taskId, messages); }
      if (messages.has(message.id)) return;
      messages.set(message.id, message);
      for (const listener of this.steerListeners.get(message.taskId) ?? []) listener(message);
    });
    client.registerFrameHandler("task.human_request.settled", frame => {
      if (!frame.rt || frame.rt !== runtimeId()) return;
      const request = frame.payload.request as MultiremiTaskHumanRequest | undefined;
      if (!request?.id || request.taskId !== frame.payload.task_id || request.status === "pending") return;
      if (this.settled.has(request.id)) return;
      this.settled.set(request.id, request);
      for (const listener of this.humanListeners.get(request.id) ?? []) listener(request);
      // A bot host receives other runtimes' requests and never calls release(taskId).
      while (this.settled.size > MAX_SETTLED_REQUESTS) this.settled.delete(this.settled.keys().next().value!);
    });
    client.registerFrameHandler("task.cancelled", frame => {
      if (frame.rt !== runtimeId() || typeof frame.payload.task_id !== "string") return;
      const status = frame.payload.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        // A terminal waiting in outbox is not an executing task. Leave that partition untouched.
        const listener = this.cancelListeners.get(frame.payload.task_id);
        this.cancelListeners.delete(frame.payload.task_id);
        listener?.(status);
      }
    });
  }

  connectionChanged(): void {
    const state = this.client.connectionState();
    if (state === "connected") for (const finish of this.connectionWaiters) finish();
    if (state === "stopped" || state === "terminal") {
      for (const finish of this.connectionWaiters) finish(new DaemonProtocolRpcError("authority_revoked", false));
    }
  }

  pendingTaskSteerMessages(taskId: string): MultiremiTaskSteerMessage[] {
    return [...(this.steers.get(taskId)?.values() ?? [])];
  }

  subscribeTaskSteerMessages(taskId: string, listener: (message: MultiremiTaskSteerMessage) => void): () => void {
    let listeners = this.steerListeners.get(taskId);
    if (!listeners) { listeners = new Set(); this.steerListeners.set(taskId, listeners); }
    listeners.add(listener);
    return () => { listeners!.delete(listener); if (!listeners!.size) this.steerListeners.delete(taskId); };
  }

  observeCancellation(taskId: string, onTerminal: (status: Terminal) => void): () => void {
    this.cancelListeners.set(taskId, onTerminal);
    return () => this.cancelListeners.delete(taskId);
  }

  release(taskId: string): void {
    this.steers.delete(taskId);
    for (const [id, request] of this.settled) if (request.taskId === taskId) this.settled.delete(id);
  }

  async consumeTaskSteerMessages(taskId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.rpc("steer.consume", { task_id: taskId, steer_ids: ids });
    for (const id of ids) this.steers.get(taskId)?.delete(id);
  }

  waitForSteer(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<MultiremiTaskSteerMessage[]> {
    const pending = this.pendingTaskSteerMessages(taskId);
    if (pending.length || signal?.aborted) return Promise.resolve(pending);
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", finish);
        resolve(this.pendingTaskSteerMessages(taskId));
      };
      const unsubscribe = this.subscribeTaskSteerMessages(taskId, finish);
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  waitForHumanDecision(requestId: string, signal: AbortSignal, timeoutMs: number): Promise<MultiremiTaskHumanRequest | null> {
    if (this.settled.has(requestId)) return Promise.resolve(this.settled.get(requestId)!);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const listeners = this.humanListeners.get(requestId) ?? new Set();
      this.humanListeners.set(requestId, listeners);
      const finish = (request: MultiremiTaskHumanRequest | null) => {
        clearTimeout(timer); listeners.delete(onSettled); signal.removeEventListener("abort", onAbort);
        if (!listeners.size) this.humanListeners.delete(requestId);
        resolve(request);
      };
      const onSettled = (request: MultiremiTaskHumanRequest) => finish(request);
      const onAbort = () => finish(null);
      listeners.add(onSettled);
      const timer = setTimeout(onAbort, Math.max(0, timeoutMs));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async rpc(type: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = performance.now() + timeoutMs;
    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new DaemonProtocolRpcError("daemon_timeout", true);
      if (["stopped", "terminal"].includes(this.client.connectionState())) throw new DaemonProtocolRpcError("authority_revoked", false);
      if (this.client.connectionState() !== "connected") {
        await new Promise<void>((resolve, reject) => {
          const ready = (error?: Error) => {
            clearTimeout(timer); this.connectionWaiters.delete(ready);
            if (error) reject(error); else resolve();
          };
          const timer = setTimeout(() => ready(new DaemonProtocolRpcError("daemon_timeout", true)), remaining);
          this.connectionWaiters.add(ready);
        });
      }
      try { return await this.client.rpc(type, payload, this.runtimeId(), Math.max(1, deadline - performance.now())); }
      catch (error) {
        if (!(error instanceof DaemonProtocolRpcError) || !error.retryable || this.client.connectionState() === "connected") throw error;
      }
    }
  }
}
