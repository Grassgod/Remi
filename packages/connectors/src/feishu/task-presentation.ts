import { createHash } from "node:crypto";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuPresentationCheckpoint, MultiremiTaskHumanRequest, MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import type { TaskStreamEvent, TaskStreamMeta } from "../base.js";
import { executionModel, readContextUsage, type AgentExecutionDisplay, type ContextUsage } from "@shared/agent-execution.js";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import { buildFinalCard } from "./streaming/card-elements.js";
import { formatCardStats, formatExecutionSubtitle } from "./card-metadata.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";
import { FeishuCotTransport, feishuTransportError, type CotSample } from "./native-cot.js";
import { FeishuCotTimeline } from "./cot-timeline.js";
import { buildTaskInteractionCard, registerTaskInteraction } from "./task-interaction.js";
import { createFeishuImageResolver } from "./outbound-images.js";
import { uploadImageFeishu } from "./media.js";
import { rewriteMarkdownImages } from "@shared/feishu-markdown-images.js";

export interface TaskPresentationOptions {
  appId: string;
  replyToMessageId?: string;
  mentionOpenId?: string;
  interactionOpenId?: string;
  displayName?: string | null;
  idempotencyKey: string;
  checkpoint?: FeishuPresentationCheckpoint;
  save?: (state: FeishuPresentationCheckpoint) => Promise<void>;
  log?: (message: string) => void;
}

const stableId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
});

/** Canonical Task presentation, shared by inbound chats and proactive delivery.
 * No Provider calls, CardKit stream, or ordinary "CoT card" lives here. */
export class FeishuTaskPresentation {
  private readonly cot: FeishuCotTransport;
  private readonly state: FeishuPresentationCheckpoint;
  private readonly abortController = new AbortController();
  private active = true;
  private readonly signal: AbortSignal;
  private readonly timeline: FeishuCotTimeline;
  private execution: AgentExecutionDisplay;
  private context: ContextUsage | null = null;
  private lastFlush = Date.now();
  private lastBatch = 0;

  constructor(private readonly client: Lark.Client, private readonly chatId: string,
    private readonly meta: TaskStreamMeta, private readonly options: TaskPresentationOptions) {
    this.cot = new FeishuCotTransport(client);
    this.state = structuredClone(options.checkpoint ?? { version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactions: {} });
    this.timeline = new FeishuCotTimeline(meta.taskId, this.state.throughSeq);
    this.state.interactionOpenId ??= options.interactionOpenId ?? options.mentionOpenId;
    this.signal = meta.signal ? AbortSignal.any([meta.signal, this.abortController.signal]) : this.abortController.signal;
    this.execution = { agentName: options.displayName ?? meta.displayName };
  }

  isActive(): boolean { return this.active; }
  async abort(): Promise<void> { this.abortController.abort(new Error("Task delivery interrupted")); }
  detach(): void { this.active = false; }

  async consume(stream: AsyncIterable<TaskStreamEvent>): Promise<{ messageId: string }> {
    if (this.state.cot?.status === "creating" || this.state.cot?.writePending) {
      // The native API exposes no verified idempotency key. An unacknowledged
      // create/write is not replayed: preserve the known handle and final lane.
      this.state.cot = { ...this.state.cot, status: "disabled", writePending: false, error: "unconfirmed_native_write" };
      await this.save();
    } else if (this.state.cot?.status === "active" && !this.state.cot.presentation) {
      // An upgrade can resume an older renderer's delivery. Its open text IDs
      // cannot be reconstructed with the new grouping rules. Close that display
      // once; preserve the original Task, request cards and final result lane.
      const { cotId, messageId } = this.state.cot;
      try { await this.retry(() => this.cot.complete({ cotId: cotId!, messageId: messageId! }, "timeout"), true); }
      catch (error) { this.signal.throwIfAborted(); this.options.log?.(feishuTransportError("Close legacy CoT", error).message); }
      this.state.cot = { ...this.state.cot, status: "disabled", error: "legacy_cot_closed_on_upgrade" };
      await this.save();
    }
    let finalStatus = "running", error: string | null = null, snapshotText = "";
    let elapsed: number | undefined;
    const iterator = stream[Symbol.asyncIterator]();
    try {
      let next = iterator.next();
      for (;;) {
        this.signal.throwIfAborted();
        // Flush small deltas even if the provider is idle inside a long tool.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 500); });
        const item = await Promise.race([next, tick]).finally(() => clearTimeout(timer));
        if (!item) { await this.flush(); continue; }
        if (item.done) break;
        const event = item.value;
        if (event.kind === "message") {
          await this.message(event.message);
        } else {
          finalStatus = event.snapshot.status;
          error = event.snapshot.error;
          snapshotText = event.snapshot.result ?? "";
          const start = Date.parse(event.snapshot.startedAt ?? "");
          const end = Date.parse(event.snapshot.completedAt ?? "");
          if (Number.isFinite(start) && Number.isFinite(end) && end >= start) elapsed = Math.round((end - start) / 1000);
        }
        next = iterator.next();
      }
    } finally {
      // Don't wait indefinitely for a blocked upstream iterator on shutdown.
      void iterator.return?.().catch(() => {});
    }
    this.signal.throwIfAborted();
    if (!["completed", "failed", "cancelled"].includes(finalStatus)) throw new Error("Task stream ended before a terminal snapshot");
    await this.flush(true);
    await this.finishCot(finalStatus);
    const answer = this.timeline.answer(snapshotText);
    const text = finalStatus === "failed" ? `${answer}${answer ? "\n\n" : ""}**执行失败：** ${error || "请查看工作台任务详情"}`
      : finalStatus === "cancelled" ? `${answer}${answer ? "\n\n" : ""}任务已取消。` : answer || "任务已完成，未返回文字结果。";
    if (!this.state.resultMessageId) {
      const renderedText = await rewriteMarkdownImages(text, createFeishuImageResolver({
        uploadImage: async image => (await uploadImageFeishu(this.client, image.buffer)).imageKey,
      }));
      const card = buildFinalCard({ text: renderedText, displayName: this.execution.agentName,
        subtitle: formatExecutionSubtitle(this.execution), mentionOpenId: this.options.mentionOpenId,
        stats: formatCardStats(elapsed ?? Math.max(0, Math.round((Date.now() - this.state.startedAt) / 1000)), this.context, this.timeline.toolCount) });
      const sent = await this.retry(() => sendCardFeishu(this.client, this.chatId, card, {
        replyToMessageId: this.options.replyToMessageId,
        idempotencyKey: stableId(`${this.options.idempotencyKey}:${this.meta.taskId}:result`),
      }), true);
      if (!sent.messageId || sent.messageId === "unknown") throw new FeishuDeliveryError("Result acknowledgement missing", true);
      this.state.resultMessageId = sent.messageId;
      await this.save();
    }
    this.active = false;
    return { messageId: this.state.resultMessageId };
  }

  private async message(message: MultiremiTaskMessage): Promise<void> {
    this.timeline.accept(message);
    // Nested agent prose must never become the main agent's final answer.
    const nested = Boolean(message.meta?.parent_tool_call_id);
    if (message.type === "execution" && !nested) {
      const info = message.meta ?? {};
      const model = Object.hasOwn(info, "model") ? executionModel(info.model) : undefined;
      if (model !== undefined && this.execution.model !== undefined && model !== this.execution.model) this.context = null;
      this.execution = { ...this.execution,
        ...(typeof info.agentName === "string" ? { agentName: info.agentName } : {}),
        ...(typeof info.provider === "string" ? { provider: info.provider } : {}),
        ...(model !== undefined ? { model, modelName: typeof info.modelName === "string" ? info.modelName : null } : {}) };
      return;
    }
    if (message.type === "usage") {
      if (!nested) this.context = readContextUsage(message.meta) ?? this.context;
      return;
    }
    if (Date.now() - this.lastFlush >= 500) await this.flush();
    if (message.type === "permission_request" || message.type === "question_request") {
      await this.flush(true);
      await this.interaction(message);
    }
  }

  private async flush(force = false): Promise<void> {
    const { samples, throughSeq } = this.timeline.drain(force);
    if (!samples.length) return;
    this.lastFlush = Date.now();
    await this.writeProcess(samples, throughSeq);
  }

  private async writeProcess(samples: CotSample[], throughSeq: number): Promise<void> {
    if (!samples.length) return;
    if (["disabled", "finished"].includes(this.state.cot?.status ?? "")) return;
    if (!this.state.cot) {
      this.state.cot = { status: "creating", presentation: "semantic_v1" };
      await this.save(); // write-ahead creation intent, even before we know either ID
      let handle;
      try { handle = await this.retry(() => this.cot.create(this.chatId, this.options.replyToMessageId), false); }
      catch (error) { await this.disableCot(error); return; }
      this.state.cot = { ...handle, status: "active", presentation: "semantic_v1" };
      await this.save(); // Never let a failed checkpoint get swallowed as an API error.
    }
    if (!this.state.cot.runStarted) samples = [["RUN_STARTED", { threadId: this.chatId, runId: this.meta.taskId }], ...samples];
    await this.writeSamples(samples);
    if (this.state.cot.status === "active") {
      this.state.cot.runStarted = true;
      this.state.cot.writePending = false;
    }
    this.state.throughSeq = Math.max(this.state.throughSeq, throughSeq);
    await this.save();
  }

  private async writeSamples(samples: CotSample[]): Promise<void> {
    const cot = this.state.cot;
    if (!cot?.cotId || !cot.messageId || cot.status !== "active") return;
    for (let i = 0; i < samples.length; i += 50) {
      const wait = 65 - (Date.now() - this.lastBatch);
      if (wait > 0) await delay(wait, this.signal);
      this.lastBatch = Date.now();
      let timestamp = Math.max(Date.now(), (cot.lastTimestamp ?? 0) + 1);
      const events = samples.slice(i, i + 50).map(([event_type, content]) => ({ event_type, content: JSON.stringify(content), timestamp: String(timestamp++) }));
      cot.writePending = true;
      await this.save();
      try { await this.retry(() => this.cot.write({ cotId: cot.cotId!, messageId: cot.messageId! }, events), false); }
      catch (error) { await this.disableCot(error); return; }
      cot.lastTimestamp = timestamp - 1;
      // Keep the write intent until the caller atomically checkpoints its
      // Task seq (or terminal state). A restart in this window is ambiguous.
    }
  }

  private async finishCot(status: string): Promise<void> {
    if (this.state.cot?.status !== "active") return;
    const ending: CotSample[] = status === "failed"
      ? [["RUN_ERROR", { code: "TASK_FAILED", message: "执行失败，详情见结果卡" }]]
      : [["RUN_FINISHED", { threadId: this.chatId, runId: this.meta.taskId, status: status === "cancelled" ? "interrupted" : "done" }]];
    await this.writeSamples([...this.timeline.finish(status), ...ending]);
    if (status === "failed" && this.state.cot?.status === "active") {
      const { cotId, messageId } = this.state.cot;
      try { await this.retry(() => this.cot.complete({ cotId: cotId!, messageId: messageId! }, "error"), true); }
      catch (failure) { await this.disableCot(failure); }
    }
    if (this.state.cot?.status === "active") {
      this.state.cot.status = "finished";
      this.state.cot.writePending = false;
      await this.save();
    }
  }

  private async disableCot(error: unknown): Promise<void> {
    this.signal.throwIfAborted();
    const failure = feishuTransportError("CoT", error);
    this.state.cot = { ...this.state.cot, status: "disabled", writePending: false, error: failure.message.slice(0, 500) };
    this.options.log?.(failure.message);
    await this.save();
  }

  private async interaction(message: MultiremiTaskMessage): Promise<void> {
    const requestId = String(message.input?.request_id ?? "");
    if (!requestId) return;
    let request = await this.meta.getHumanRequest?.(requestId);
    if (this.meta.getHumanRequest && !request) throw new Error("Task human request unavailable");
    request ??= { id: requestId, taskId: this.meta.taskId, kind: message.type === "question_request" ? "question" : "permission",
      payload: message.input ?? {}, status: "pending", response: null, respondedBy: null, createdAt: message.createdAt, respondedAt: null };
    if (request.taskId !== this.meta.taskId) throw new Error("Interaction Task mismatch");
    let entry = this.state.interactions[requestId];
    if (!entry && request.status !== "pending") return; // historical request already answered on web
    const recipientOpenId = this.state.interactionOpenId;
    if (!entry) {
      const card = buildTaskInteractionCard(request, { displayName: this.execution.agentName, recipientOpenId });
      const sent = await this.retry(() => sendCardFeishu(this.client, this.chatId, card, {
        replyToMessageId: this.options.replyToMessageId, idempotencyKey: stableId(`${this.options.idempotencyKey}:${this.meta.taskId}:request:${requestId}`),
      }), true);
      entry = this.state.interactions[requestId] = { messageId: sent.messageId };
      await this.save();
    }
    const finishWaiting = async () => {
      if (entry!.waitingStarted && !entry!.waitingFinished) {
        entry!.waitingFinished = true;
        await this.writeProcess(this.timeline.resume(requestId, request!.status), message.seq);
      }
    };
    if (entry.receiptStatus === request.status) { await finishWaiting(); await this.save(); return; }
    const registered = registerTaskInteraction({ appId: this.options.appId, chatId: this.chatId, messageId: entry.messageId,
      recipientOpenId, request, displayName: this.execution.agentName,
      submit: async response => {
        this.signal.throwIfAborted();
        try { return await this.meta.respondHumanRequest(requestId, response); }
        catch (error) {
          const latest = await this.meta.getHumanRequest?.(requestId);
          if (latest && latest.status !== "pending") return latest;
          throw error;
        }
      } });
    try {
      // Register the existing card callback before awaiting native transport;
      // a slow CoT update must not leave newly visible buttons unresponsive.
      if (request.status === "pending" && !entry.waitingStarted) {
        entry.waitingStarted = true;
        await this.writeProcess(this.timeline.waitForUser(requestId, request.kind, message.seq), message.seq);
        await this.save();
      }
      while (request.status === "pending") {
        await delay(750, this.signal);
        request = registered.current() ?? await this.meta.getHumanRequest?.(requestId) ?? request;
      }
      await this.retry(() => updateCardFeishu(this.client, entry!.messageId,
        buildTaskInteractionCard(request!, { displayName: this.execution.agentName, receipt: true })), true);
      entry.receiptStatus = request.status;
      await finishWaiting();
      await this.save();
    } finally { registered.dispose(); }
  }

  private async save(): Promise<void> {
    this.signal.throwIfAborted();
    await this.options.save?.(structuredClone(this.state));
  }

  private async retry<T>(operation: () => Promise<T>, idempotent: boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          abort = () => reject(this.signal.reason);
          this.signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => reject(new FeishuDeliveryError("Feishu request timed out", true, true)), 15_000);
        });
        return await Promise.race([operation(), deadline]);
      }
      catch (error) {
        this.signal.throwIfAborted();
        const failure = feishuTransportError("Feishu delivery", error);
        if (!failure.retryable || (failure.ambiguous && !idempotent) || attempt >= 2) throw failure;
        await delay(500 * 2 ** attempt, this.signal);
      } finally {
        clearTimeout(timer);
        if (abort) this.signal.removeEventListener("abort", abort);
      }
    }
  }
}
