import { createHash } from "node:crypto";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuPresentationCheckpoint, MultiremiTaskHumanRequest, MultiremiTaskMessage } from "@multiremi/contracts/types.js";
import type { TaskStreamEvent, TaskStreamMeta } from "../base.js";
import { executionModel, readContextUsage, type AgentExecutionDisplay, type ContextUsage } from "@shared/agent-execution.js";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import { buildFinalCard } from "./streaming/card-elements.js";
import { formatCardStats, formatExecutionSubtitle } from "./card-metadata.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";
import { cotTextEvents, FeishuCotTransport, feishuTransportError, type CotSample } from "./native-cot.js";
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
  private candidate = "";
  private explicitFinal = "";
  private execution: AgentExecutionDisplay;
  private context: ContextUsage | null = null;
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown>; ended: boolean }>();
  private seq = 0;
  private pendingSamples: CotSample[] = [];
  private pendingSeq = 0;
  private lastFlush = 0;
  private openText?: { id: string; key: string; reasoning: boolean };

  constructor(private readonly client: Lark.Client, private readonly chatId: string,
    private readonly meta: TaskStreamMeta, private readonly options: TaskPresentationOptions) {
    this.cot = new FeishuCotTransport(client);
    this.state = structuredClone(options.checkpoint ?? { version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactions: {} });
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
          this.seq = Math.max(this.seq, event.message.seq);
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
    await this.flush();
    await this.finishCot(finalStatus, error);
    const answer = this.explicitFinal.trim() || this.candidate.trim() || snapshotText.trim();
    const text = finalStatus === "failed" ? `${answer}${answer ? "\n\n" : ""}**执行失败：** ${error || "请查看工作台任务详情"}`
      : finalStatus === "cancelled" ? `${answer}${answer ? "\n\n" : ""}任务已取消。` : answer || "任务已完成，未返回文字结果。";
    if (!this.state.resultMessageId) {
      const renderedText = await rewriteMarkdownImages(text, createFeishuImageResolver({
        uploadImage: async image => (await uploadImageFeishu(this.client, image.buffer)).imageKey,
      }));
      const card = buildFinalCard({ text: renderedText, displayName: this.execution.agentName,
        subtitle: formatExecutionSubtitle(this.execution), mentionOpenId: this.options.mentionOpenId,
        stats: formatCardStats(elapsed ?? Math.max(0, Math.round((Date.now() - this.state.startedAt) / 1000)), this.context, this.tools.size) });
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
    const seq = message.seq;
    const id = (suffix: string) => stableId(`${this.meta.taskId}:${seq}:${suffix}`);
    const samples: CotSample[] = [];
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
    const isProcessText = message.type === "thinking" || (message.type === "text" && (nested || message.meta?.phase === "commentary"));
    if (!isProcessText) samples.push(...this.closeProcessText());
    if (message.type === "text") {
      const text = message.content ?? "";
      if (nested || message.meta?.phase === "commentary") samples.push(...this.processText(id("text"), text, false, String(message.meta?.parent_tool_call_id ?? "main")));
      else if (message.meta?.phase === "final") this.explicitFinal += text;
      else this.candidate += text; // ACP without phases: hold until a tool/thought proves it is commentary.
    } else if (["thinking", "tool_use", "permission_request", "question_request", "plan", "compaction"].includes(message.type)) {
      if (!nested && this.candidate) {
        samples.push(...cotTextEvents(id("commentary"), this.candidate));
        this.candidate = "";
      }
      if (message.type === "thinking") samples.push(...this.processText(id("reasoning"), message.content ?? "", true, String(message.meta?.parent_tool_call_id ?? "main")));
      if (message.type === "compaction") samples.push(...cotTextEvents(id("compaction"), message.content || "上下文已整理"));
      if (message.type === "plan" && message.content) samples.push(...cotTextEvents(id("plan"), message.content));
      if (message.type === "tool_use") {
        const key = message.toolCallId || id("tool");
        const existing = this.tools.get(key);
        if (existing) existing.input = { ...existing.input, ...message.input };
        else {
          const name = message.tool || String(message.meta?.title ?? "Tool");
          this.tools.set(key, { name, input: message.input ?? {}, ended: false });
          samples.push(["TOOL_CALL_START", { toolCallId: stableId(key), icon: "default", title: name.slice(0, 120), toolCallName: name.slice(0, 120) }]);
        }
      }
    } else if (message.type === "tool_result") {
      const key = message.toolCallId ?? [...this.tools.keys()].findLast(k => !this.tools.get(k)!.ended);
      const tool = key ? this.tools.get(key) : undefined;
      if (key && tool && !tool.ended) {
        tool.ended = true;
        const toolCallId = stableId(key);
        const args = JSON.stringify(tool.input);
        samples.push(["TOOL_CALL_ARGS", { toolCallId, delta: args.length <= 800 ? args : JSON.stringify({ preview: args.slice(0, 600), truncated: true }) }],
          ["TOOL_CALL_END", { toolCallId }],
          ["TOOL_CALL_RESULT", { messageId: id("result"), toolCallId, role: "tool",
            content: { type: "code", code: (message.output ?? message.content ?? message.status ?? "").slice(0, 800) } }]);
      }
    }
    await this.emit(seq, samples);
    if (message.type === "permission_request" || message.type === "question_request") {
      await this.flush();
      await this.interaction(message);
    }
  }

  private processText(id: string, text: string, reasoning: boolean, key: string): CotSample[] {
    if (!text) return [];
    const samples: CotSample[] = [];
    if (this.openText && (this.openText.reasoning !== reasoning || this.openText.key !== key)) samples.push(...this.closeProcessText());
    const opening = !this.openText;
    this.openText ??= { id, key, reasoning };
    // Consecutive chunks append to one native message rather than opening a
    // new paragraph for every token. Full replay reconstructs the same ID.
    const events = cotTextEvents(this.openText.id, text, reasoning);
    samples.push(...events.slice(opening ? 0 : 1, -1));
    return samples;
  }

  private closeProcessText(): CotSample[] {
    if (!this.openText) return [];
    const { id, reasoning } = this.openText;
    this.openText = undefined;
    return [[`${reasoning ? "REASONING_MESSAGE" : "TEXT_MESSAGE"}_END`, { messageId: id }]];
  }

  private async emit(seq: number, samples: CotSample[]): Promise<void> {
    if (!samples.length || seq <= this.state.throughSeq || ["disabled", "finished"].includes(this.state.cot?.status ?? "")) return;
    this.pendingSamples.push(...samples);
    this.pendingSeq = seq;
    if (this.pendingSamples.length >= 40 || Date.now() - this.lastFlush >= 500) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.pendingSamples.length) return;
    let samples = this.pendingSamples;
    this.pendingSamples = [];
    this.lastFlush = Date.now();
    if (["disabled", "finished"].includes(this.state.cot?.status ?? "")) return;
    if (!this.state.cot) {
      this.state.cot = { status: "creating" };
      await this.save(); // write-ahead creation intent, even before we know either ID
      let handle;
      try { handle = await this.retry(() => this.cot.create(this.chatId, this.options.replyToMessageId), false); }
      catch (error) { await this.disableCot(error); return; }
      this.state.cot = { ...handle, status: "active" };
      await this.save(); // Never let a failed checkpoint get swallowed as an API error.
    }
    if (!this.state.cot.runStarted) samples = [["RUN_STARTED", { threadId: this.chatId, runId: this.meta.taskId }], ...samples];
    await this.writeSamples(samples);
    if (this.state.cot.status === "active") {
      this.state.cot.runStarted = true;
      this.state.cot.writePending = false;
    }
    this.state.throughSeq = this.pendingSeq;
    await this.save();
  }

  private async writeSamples(samples: CotSample[]): Promise<void> {
    const cot = this.state.cot;
    if (!cot?.cotId || !cot.messageId || cot.status !== "active") return;
    for (let i = 0; i < samples.length; i += 50) {
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

  private async finishCot(status: string, error: string | null): Promise<void> {
    if (this.state.cot?.status !== "active") return;
    const ending: CotSample[] = status === "failed" || status === "cancelled"
      ? [["RUN_ERROR", { code: status === "cancelled" ? "TASK_CANCELLED" : "TASK_FAILED", message: error?.slice(0, 500) || (status === "cancelled" ? "任务已取消" : "Task failed") }]]
      : [["RUN_FINISHED", { threadId: this.chatId, runId: this.meta.taskId, status: "done" }]];
    await this.writeSamples([...this.closeProcessText(), ...ending]);
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
    if (entry.receiptStatus === request.status) return;
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
      while (request.status === "pending") {
        await delay(750, this.signal);
        request = registered.current() ?? await this.meta.getHumanRequest?.(requestId) ?? request;
      }
      await this.retry(() => updateCardFeishu(this.client, entry!.messageId,
        buildTaskInteractionCard(request!, { displayName: this.execution.agentName, receipt: true })), true);
      entry.receiptStatus = request.status;
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
