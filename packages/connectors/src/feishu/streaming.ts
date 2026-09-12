/**
 * One patch-only card session for interactive replies and proactive reports.
 * Events update local state; a coalesced, serialized queue patches the message.
 * The historical class name is retained for connector and adapter callers.
 */
import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain } from "./types.js";
import type { ToolEntry } from "./tool-formatters.js";
import type { PermissionFormElements } from "./permission-ui.js";
import {
  type RetainedPermissionPanel,
  type StepInfo,
  buildProgressCard,
  buildFinalCard,
  buildLegacyPlanReviewCard,
  buildInitialCardJson,
} from "./streaming/card-elements.js";
import { PATCH_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, SAFETY_TIMEOUT_MS, TimerSlot } from "./streaming/throttle.js";
import { PermissionFormStore } from "./streaming/permission-form.js";
import { uploadImageFeishu } from "./media.js";
import { createFeishuImageResolver } from "./outbound-images.js";
import { degradeMarkdownImages, rewriteMarkdownImages, type MarkdownImageResolver } from "@shared/feishu-markdown-images.js";
import type { AgentExecutionDisplay, ContextUsage } from "@shared/agent-execution.js";
import { formatCardStats, formatExecutionSubtitle } from "./card-metadata.js";

export { buildFinalCard };
export type { StepInfo };
/** Retained for callers; patch-only messages use the SDK client's credentials. */
export type TokenProvider = () => Promise<string>;

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = { messageId: string; currentText: string; currentStatus: string };

export interface StreamingCloseOptions {
  finalText?: string;
  thinking?: string | null;
  toolEntries?: ToolEntry[];
  aborted?: boolean;
  trailingThinking?: string | null;
  toolCount?: number;
  stats?: string | null;
  mentionOpenId?: string;
  sessionId?: string | null;
  displayName?: string | null;
  permissionDenials?: Array<Record<string, unknown>>;
  askQuestions?: { actionId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> };
  planReview?: { actionId: string; planContent?: string };
  retainedPermissionPanels?: RetainedPermissionPanel[];
}

class CardPatchError extends Error {}

export class FeishuStreamingSession {
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly log: (msg: string) => void;
  private readonly imageResolver: MarkdownImageResolver;
  private currentRawText = "";
  private header: unknown;
  private taskOwnsLifetime = false;
  private readonly timers = { safety: new TimerSlot(), heartbeat: new TimerSlot(), patch: new TimerSlot() };
  private startTime = 0;
  private lastStatusText = "";
  private heartbeatRenderer: ((elapsed: number) => string) | null = null;
  private readonly abortController = new AbortController();
  private readonly steps: StepInfo[] = [];
  private fullThinking = "";
  private nameSuffix: string | undefined;
  private subtitle: string | null = null;
  private sessionId: string | null | undefined;
  private displayName: string | null | undefined;
  private mentionOpenId: string | undefined;
  private execution: AgentExecutionDisplay = {};
  private contextUsage: ContextUsage | null = null;
  private readonly permissions = new PermissionFormStore();

  constructor(private readonly client: Client, _credentials: Credentials,
    options?: { log?: (msg: string) => void; tokenProvider?: TokenProvider }) {
    this.log = options?.log ?? (message => console.log(`[feishu-card] ${message}`));
    this.imageResolver = createFeishuImageResolver({
      uploadImage: async image => (await uploadImageFeishu(this.client, image.buffer)).imageKey,
    });
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: { replyToMessageId?: string; sessionId?: string | null; displayName?: string | null;
      nameSuffix?: string; subtitle?: string | null; mentionOpenId?: string;
      durable?: { idempotencyKey: string; messageId?: string | null } },
  ): Promise<void> {
    if (this.state) return;
    this.abortController.signal.throwIfAborted();
    this.nameSuffix = options?.nameSuffix;
    this.subtitle = options?.subtitle ?? null;
    this.sessionId = options?.sessionId;
    this.displayName = options?.displayName;
    this.execution = { agentName: options?.displayName };
    this.mentionOpenId = options?.mentionOpenId;
    this.taskOwnsLifetime = Boolean(options?.durable);
    const card = buildInitialCardJson(options);
    this.header = card.header;
    let messageId = options?.durable?.messageId;
    if (!messageId) {
      const data = { msg_type: "interactive" as const, content: JSON.stringify(card),
        ...(options?.durable ? { uuid: options.durable.idempotencyKey } : {}) };
      const sent = options?.replyToMessageId
        ? await this.client.im.message.reply({ path: { message_id: options.replyToMessageId }, data: { ...data, reply_in_thread: true } })
        : await this.client.im.message.create({ params: { receive_id_type: receiveIdType }, data: { ...data, receive_id: receiveId } });
      if (sent.code !== 0 || !sent.data?.message_id) throw new Error(`Send card failed: ${sent.msg}`);
      messageId = sent.data.message_id;
    }
    this.state = { messageId, currentText: "", currentStatus: "" };
    this.startTime = Date.now();
    this.resetSafetyTimer();
    this.resetHeartbeat();
  }

  private buildCurrentCard(): Record<string, unknown> {
    return { ...buildProgressCard({
      status: this.state?.currentStatus,
      steps: this.steps,
      text: this.state?.currentText,
      retainedPanels: this.permissions.retained(),
      pendingPermission: this.permissions.pending,
      nameSuffix: this.nameSuffix,
      subtitle: this.subtitle,
      stats: null,
      includeStats: false,
    }), header: this.header };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    // A failed patch must not poison subsequent updates or the final card.
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async patch(card: Record<string, unknown>, final = false): Promise<void> {
    const messageId = this.state?.messageId;
    if (!messageId || this.closed) throw new Error("Card session is closed");
    const content = JSON.stringify(card);
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new Error("Card session is closed");
      try {
        const response = await this.client.im.message.patch({ path: { message_id: messageId }, data: { content } });
        if (response.code !== 0) throw new CardPatchError(`${final ? "Final card" : "Card"} patch failed: ${response.msg}`);
        return;
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (error instanceof CardPatchError || attempt >= 2 || (status && status < 500 && status !== 429)) throw error;
        await Bun.sleep(200 * (attempt + 1));
      }
    }
  }

  private schedulePatch(): void {
    if (!this.isActive()) return;
    this.timers.patch.armIfIdle(PATCH_INTERVAL_MS, () => {
      this.timers.patch.clear();
      void this.flush().then(ok => { if (!ok) this.schedulePatch(); });
    });
  }

  private flush(): Promise<boolean> {
    this.timers.patch.clear();
    return this.enqueue(async () => {
      if (!this.isActive()) return false;
      try {
        await this.patch(this.buildCurrentCard());
        return true;
      } catch (error) {
        this.log(`Card patch failed: ${String(error)}`);
        return false;
      }
    });
  }

  async appendPermissionForm(form: PermissionFormElements): Promise<void> {
    if (!this.isActive()) throw new Error("Card session is closed");
    this.permissions.pending = form;
    if (!(await this.flush())) throw new Error("Failed to render permission form");
  }

  async removePermissionForm(actionId: string, options?: { preservePanel?: boolean }): Promise<void> {
    if (!this.isActive()) return;
    this.permissions.settle(actionId, options?.preservePanel === true);
    if (!(await this.flush())) this.schedulePatch();
  }

  getLastStatus(): string { return this.lastStatusText; }
  setHeartbeatRenderer(renderer: ((elapsed: number) => string) | null): void { this.heartbeatRenderer = renderer; }
  getElapsed(): number { return Math.round((Date.now() - this.startTime) / 1000); }

  private getStats(): string | null {
    return formatCardStats(this.getElapsed(), this.contextUsage, this.steps.filter(step => step.tool !== "_thinking").length);
  }

  updateContextUsage(usage: ContextUsage | null): void {
    if (!this.isActive()) return;
    this.contextUsage = usage;
    this.touch();
  }

  updateExecution(info: AgentExecutionDisplay): void {
    if (!this.isActive()) return;
    this.execution = { ...this.execution, ...info };
    this.subtitle = formatExecutionSubtitle(this.execution);
    const header = this.header as Record<string, unknown>;
    this.header = { ...header, subtitle: this.subtitle ? { tag: "plain_text", content: this.subtitle } : undefined };
    this.touch();
  }

  async update(text: string): Promise<void> {
    if (!text || !this.isActive()) return;
    this.currentRawText = text;
    this.state!.currentText = degradeMarkdownImages(text);
    this.touch();
  }

  async updateThinking(text: string): Promise<void> {
    if (!this.isActive()) return;
    this.fullThinking = text;
    this.resetSafetyTimer();
  }

  async updateStatus(text: string): Promise<void> {
    if (!this.isActive()) return;
    this.lastStatusText = text;
    this.state!.currentStatus = text;
    this.touch();
  }

  addStep(toolName: string, desc: string): void {
    if (!this.isActive()) return;
    this.steps.push({ tool: toolName, desc, thinkingOffset: this.fullThinking.length });
    this.touch();
  }

  updateStepDesc(desc: string): void {
    if (!this.isActive()) return;
    const step = this.steps.findLast(s => !s.durationMs);
    if (!step) return;
    step.desc = desc;
    this.touch();
  }

  updateStepDuration(durationMs: number): void {
    if (!this.isActive()) return;
    const step = this.steps.findLast(s => !s.durationMs);
    if (!step) return;
    step.durationMs = durationMs;
    this.touch();
  }

  getSteps(): StepInfo[] { return this.steps; }
  /** @deprecated Patch-only messages do not have a CardKit card ID. */
  getCardId(): null { return null; }

  /** @deprecated Use the permission form in the existing message instead. */
  async sendPlanReviewCard(actionId: string, chatId: string): Promise<string | null> {
    try {
      const result = await this.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: {
        receive_id: chatId, msg_type: "interactive", content: JSON.stringify(buildLegacyPlanReviewCard(actionId)),
      } });
      return result.code === 0 ? result.data?.message_id ?? null : null;
    } catch (error) { this.log(`sendPlanReviewCard error: ${String(error)}`); return null; }
  }

  private touch(): void {
    this.resetSafetyTimer();
    this.resetHeartbeat();
    this.schedulePatch();
  }

  get abortSignal(): AbortSignal { return this.abortController.signal; }

  async abort(): Promise<void> {
    if (!this.isActive()) return;
    this.abortController.abort();
    await this.updateStatus("Interrupted");
    await this.close({ aborted: true });
  }

  private resetSafetyTimer(): void {
    if (this.taskOwnsLifetime) return;
    this.timers.safety.arm(SAFETY_TIMEOUT_MS, () => {
      if (!this.isActive()) return;
      this.abortController.abort();
      void this.close().catch(error => this.log(`Safety close failed: ${String(error)}`));
    });
  }

  private resetHeartbeat(): void {
    this.timers.heartbeat.arm(HEARTBEAT_INTERVAL_MS, () => {
      if (!this.isActive()) return;
      this.state!.currentStatus = this.heartbeatRenderer?.(this.getElapsed()) ?? `${this.lastStatusText || "Running"} (${this.getElapsed()}s)`;
      this.schedulePatch();
      this.resetHeartbeat();
    });
  }

  close(finalTextOrOptions?: string | StreamingCloseOptions): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.state || this.closed) return Promise.resolve();
    this.closing = true;
    for (const timer of Object.values(this.timers)) timer.clear();
    const options = typeof finalTextOrOptions === "string" ? { finalText: finalTextOrOptions } : finalTextOrOptions ?? {};
    // Queue the final patch behind in-flight writes; later events cannot alter it.
    this.closePromise = this.enqueue(async () => {
      try {
        const rawText = options.finalText ?? this.currentRawText;
        const text = options.aborted ? `${rawText}${rawText ? "\n\n---\n" : ""}*已被用户中断*` : rawText;
        const renderedText = await rewriteMarkdownImages(text, this.imageResolver);
        const card = buildFinalCard({
          ...options,
          text: renderedText,
          thinking: options.thinking ?? this.fullThinking,
          steps: this.steps.length ? this.steps : undefined,
          retainedPermissionPanels: options.retainedPermissionPanels ?? this.permissions.retained(),
          sessionId: options.sessionId ?? this.sessionId,
          displayName: options.displayName ?? this.displayName,
          mentionOpenId: options.mentionOpenId ?? this.mentionOpenId,
          stats: options.stats ?? this.getStats(),
          nameSuffix: this.nameSuffix,
          subtitle: this.subtitle,
        });
        await this.patch(card, true);
      } finally { this.closed = true; }
    });
    return this.closePromise;
  }

  isActive(): boolean { return this.state !== null && !this.closed && !this.closing; }

  /** Stop local writers without marking a durable Task as cancelled. */
  detach(): void {
    this.closed = true;
    for (const timer of Object.values(this.timers)) timer.clear();
    this.abortController.abort();
  }

  getMessageId(): string | null { return this.state?.messageId ?? null; }
}
