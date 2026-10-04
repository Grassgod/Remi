import type { MultiremiTaskSteerMessage, MultiremiTaskStatus } from "@multiremi/contracts/types.js";
import { DaemonProtocolClient, DaemonProtocolRpcError } from "./daemon-protocol-client.js";
import type { TaskSteerSource } from "./steer.js";
import type { DaemonTurnInput } from "@multiremi/contracts/daemon-protocol.js";
import type { UnifiedMessage } from "@multiremi/contracts/unified-model.js";

type Terminal = Extract<MultiremiTaskStatus, "completed" | "failed" | "cancelled">;
const MAX_SETTLED_REQUESTS = 1024;

/** Per-runtime push inbox. The executing task owns cancellation and steer consumption. */
export class DaemonTaskDownlinks implements TaskSteerSource {
  private readonly turns = new Map<string, { turnId: string; inputToSeq: number; wrapUpAt: string | null }>();
  private readonly inputSeqs = new Map<string, number>();
  private readonly decisions = new Map<string, UnifiedMessage>();
  private readonly decisionAttempts = new Map<string, string>();
  private readonly decisionReplies = new Map<string, UnifiedMessage>();
  private readonly decisionCreates = new Set<string>();
  private readonly inputReplyTo = new Map<string, string>();
  private readonly confirmedDecisionInputs = new Map<string, Set<string>>();
  private readonly decisionListeners = new Map<string, Set<(message: UnifiedMessage) => void>>();
  private readonly steers = new Map<string, Map<string, MultiremiTaskSteerMessage>>();
  private readonly steerListeners = new Map<string, Set<(message: MultiremiTaskSteerMessage) => void>>();
  private readonly cancelListeners = new Map<string, (status: Terminal) => void>();
  private readonly connectionWaiters = new Set<(error?: Error) => void>();

  constructor(private readonly client: DaemonProtocolClient, private readonly runtimeId: () => string | undefined) {
    client.registerFrameHandler("turn.message", frame => {
      if (!frame.rt || frame.rt !== runtimeId()) return;
      const attemptId = frame.payload.attempt_id;
      if (typeof attemptId !== "string") return;
      const turn = this.turns.get(attemptId);
      const message = frame.payload.message as UnifiedMessage | undefined;
      if (!turn || turn.turnId !== frame.payload.turn_id || !message?.id || message.kind !== "message"
        || typeof message.body_md !== "string" || !Number.isSafeInteger(message.seq) || message.seq <= turn.inputToSeq) return;
      if (message.reply_to_id) {
        this.inputReplyTo.set(`${attemptId}:${message.id}`, message.reply_to_id);
        this.decisionReplies.set(message.reply_to_id, message);
        for (const listener of this.decisionListeners.get(message.reply_to_id) ?? []) listener(message);
        while (this.decisionReplies.size > MAX_SETTLED_REQUESTS) this.decisionReplies.delete(this.decisionReplies.keys().next().value!);
      }
      this.inputSeqs.set(`${attemptId}:${message.id}`, message.seq);
      this.queueInput(attemptId, { id: message.id, taskId: attemptId, kind: "steer", content: message.body_md,
        authorType: message.sender_type === "member" ? "user" : message.sender_type === "agent" ? "agent" : "system",
        authorId: message.sender_id, createdAt: message.created_at, consumedAt: null,
        attachments: Array.isArray(frame.payload.attachments) ? frame.payload.attachments : [] },
      !(message.reply_to_id && (this.decisionCreates.has(attemptId) || this.decisionAttempts.get(message.reply_to_id) === attemptId)));
    });
    client.registerFrameHandler("turn.wrap_up", frame => {
      if (frame.rt !== runtimeId() || typeof frame.payload.attempt_id !== "string"
        || typeof frame.payload.requested_at !== "string") return;
      const attemptId = frame.payload.attempt_id;
      const turn = this.turns.get(attemptId);
      if (!turn || turn.turnId !== frame.payload.turn_id || turn.wrapUpAt === frame.payload.requested_at) return;
      turn.wrapUpAt = frame.payload.requested_at;
      this.queueInput(attemptId, { id: `wrap_up:${frame.payload.requested_at}`, taskId: attemptId,
        kind: "force_answer", content: "", authorType: "system", authorId: null,
        createdAt: frame.payload.requested_at, consumedAt: null });
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

  bindTurn(input: DaemonTurnInput): void {
    this.turns.set(input.attempt_id, { turnId: input.turn_id, inputToSeq: input.input_to_seq, wrapUpAt: null });
  }

  turnInput(attemptId: string): { turn_id: string; attempt_id: string; input_to_seq: number } {
    const turn = this.turns.get(attemptId);
    if (!turn) throw new Error("attempt has no bound turn");
    return { turn_id: turn.turnId, attempt_id: attemptId, input_to_seq: turn.inputToSeq };
  }

  private queueInput(attemptId: string, message: MultiremiTaskSteerMessage, notify = true): void {
    let messages = this.steers.get(attemptId);
    if (!messages) { messages = new Map(); this.steers.set(attemptId, messages); }
    if (messages.has(message.id)) return;
    messages.set(message.id, message);
    if (notify) for (const listener of this.steerListeners.get(attemptId) ?? []) listener(message);
  }

  connectionChanged(): void {
    const state = this.client.connectionState();
    if (state === "connected") for (const finish of this.connectionWaiters) finish();
    if (state === "stopped" || state === "terminal") {
      for (const finish of this.connectionWaiters) finish(new DaemonProtocolRpcError("authority_revoked", false));
    }
  }

  pendingTaskSteerMessages(taskId: string): MultiremiTaskSteerMessage[] {
    return [...(this.steers.get(taskId)?.values() ?? [])].filter(message => {
      const replyTo = this.inputReplyTo.get(`${taskId}:${message.id}`);
      return !replyTo || (!this.decisionCreates.has(taskId) && this.decisionAttempts.get(replyTo) !== taskId);
    }).sort((a, b) =>
      (this.inputSeqs.get(`${taskId}:${a.id}`) ?? Number.MAX_SAFE_INTEGER)
      - (this.inputSeqs.get(`${taskId}:${b.id}`) ?? Number.MAX_SAFE_INTEGER));
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
    this.turns.delete(taskId);
    this.decisionCreates.delete(taskId);
    this.confirmedDecisionInputs.delete(taskId);
    for (const [id, attemptId] of this.decisionAttempts) {
      if (attemptId !== taskId) continue;
      this.decisionAttempts.delete(id); this.decisions.delete(id); this.decisionReplies.delete(id);
    }
    for (const key of this.inputSeqs.keys()) if (key.startsWith(`${taskId}:`)) this.inputSeqs.delete(key);
    for (const key of this.inputReplyTo.keys()) if (key.startsWith(`${taskId}:`)) this.inputReplyTo.delete(key);
  }

  async consumeTaskSteerMessages(taskId: string, ids: string[]): Promise<void> {
    ids = [...new Set([...ids, ...(this.confirmedDecisionInputs.get(taskId) ?? [])])];
    if (!ids.length) return;
    const input = this.turnInput(taskId);
    const seqs = ids.map(id => this.inputSeqs.get(`${taskId}:${id}`)).filter((seq): seq is number => seq !== undefined);
    // Wrap-up is a control, so it never advances the conversation cursor.
    if (seqs.length) {
      const to = Math.max(input.input_to_seq, ...seqs);
      const confirmed = new Set(ids);
      for (const pending of this.steers.get(taskId)?.values() ?? []) {
        const seq = this.inputSeqs.get(`${taskId}:${pending.id}`);
        if (seq !== undefined && seq <= to && !confirmed.has(pending.id)) throw new Error("unconfirmed turn input gap");
      }
      await this.rpc("turn.input", { ...input, input_to_seq: to, message_ids: ids.filter(id => this.inputSeqs.has(`${taskId}:${id}`)) });
      const current = this.turns.get(taskId);
      if (current) current.inputToSeq = Math.max(current.inputToSeq, to);
    }
    for (const id of ids) {
      this.steers.get(taskId)?.delete(id);
      this.confirmedDecisionInputs.get(taskId)?.delete(id);
    }
  }

  beginDecision(attemptId: string): void { this.decisionCreates.add(attemptId); }

  finishDecision(attemptId: string): void {
    this.decisionCreates.delete(attemptId);
    for (const message of this.pendingTaskSteerMessages(attemptId)) {
      if (this.inputReplyTo.has(`${attemptId}:${message.id}`)) {
        for (const listener of this.steerListeners.get(attemptId) ?? []) listener(message);
      }
    }
  }

  confirmDecisionReply(attemptId: string, reply: UnifiedMessage): void {
    if (!reply.reply_to_id || this.decisionAttempts.get(reply.reply_to_id) !== attemptId) throw new Error("foreign decision reply");
    // The question/permission callback delivers this input to the provider. Confirm it
    // with the next contiguous receipt, without a second prompt/soft interrupt.
    this.inputSeqs.set(`${attemptId}:${reply.id}`, reply.seq);
    let ids = this.confirmedDecisionInputs.get(attemptId);
    if (!ids) this.confirmedDecisionInputs.set(attemptId, ids = new Set());
    ids.add(reply.id);
  }

  registerDecision(message: UnifiedMessage, attemptId: string): void {
    this.decisions.set(message.id, message); this.decisionAttempts.set(message.id, attemptId);
  }

  waitForDecisionReply(messageId: string, signal: AbortSignal, timeoutMs: number): Promise<UnifiedMessage | null> {
    const reply = this.decisionReplies.get(messageId);
    if (reply || signal.aborted) return Promise.resolve(reply ?? null);
    return new Promise(resolve => {
      const listeners = this.decisionListeners.get(messageId) ?? new Set();
      this.decisionListeners.set(messageId, listeners);
      const finish = (message: UnifiedMessage | null) => {
        clearTimeout(timer); listeners.delete(onReply); signal.removeEventListener("abort", onAbort);
        if (!listeners.size) this.decisionListeners.delete(messageId);
        resolve(message);
      };
      const onReply = (message: UnifiedMessage) => finish(message);
      const onAbort = () => finish(null);
      listeners.add(onReply);
      const timer = setTimeout(onAbort, Math.max(0, timeoutMs));
      signal.addEventListener("abort", onAbort, { once: true });
    });
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
