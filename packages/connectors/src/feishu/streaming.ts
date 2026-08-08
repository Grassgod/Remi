/**
 * Feishu streaming card session for real-time AI response updates.
 *
 * Flow: AI starts -> create streaming card -> throttled element updates -> close card
 *
 * Key design decisions (learned from Tika bot_stream patterns):
 * - Independent throttle per element (thinking vs content don't block each other)
 * - Fire-and-forget updates (don't block the event consumption loop)
 * - Guaranteed flush before close (no lost pending updates)
 * - Safety timeout to auto-close abandoned cards (2 hours)
 * - Heartbeat: periodic status update every 10s when idle to show liveness
 * - Retry on transient 5xx API failures
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain } from "./types.js";
import { resolveApiBase } from "@shared/feishu-domain.js";
import { type ToolEntry, buildStepDiv, formatToolInputSummary } from "./tool-formatters.js";
import type { PermissionFormElements } from "./permission-ui.js";
import {
  MAX_VISIBLE_STEPS,
  type RetainedPermissionPanel,
  type StepInfo,
  buildDegradedCard,
  buildFinalCard,
  buildLegacyPlanReviewCard,
  buildStreamingCardJson,
  buildSummary,
} from "./streaming/card-elements.js";
import {
  DEGRADED_FLUSH_MS,
  ElementThrottler,
  HEARTBEAT_INTERVAL_MS,
  PERMISSION_FLUSH_MS,
  SAFETY_TIMEOUT_MS,
  STREAMING_RENEW_MS,
  TimerSlot,
} from "./streaming/throttle.js";
import {
  PermissionFormStore,
  insertPermissionFormElements,
  permissionElementIds,
} from "./streaming/permission-form.js";
import { CardKitElements, type CardRef } from "./streaming/cardkit-elements.js";

export { buildFinalCard };
export type { StepInfo };

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  currentThinking: string;
  currentStatus: string;
};

export interface StreamingCloseOptions {
  finalText?: string;
  thinking?: string | null;
  /** Tool entries for building nested collapsible panels in the final card. */
  toolEntries?: ToolEntry[];
  /** Whether the session was aborted by user (/esc). */
  aborted?: boolean;
  /** Thinking text after the last tool call. */
  trailingThinking?: string | null;
  /** Number of tool calls for the process panel header. */
  toolCount?: number;
  stats?: string | null;
  /** Sender open ID — if provided, an @mention is embedded in the final card. */
  mentionOpenId?: string;
  /** Session ID for dynamic card header name (e.g. "好奇的 Remi·Vulpes"). */
  sessionId?: string | null;
  /** Display name from DB registry — takes precedence over sessionId-derived name. */
  displayName?: string | null;
  /** Legacy CLI permission denials retained for compatibility with older close-card callers. */
  permissionDenials?: Array<Record<string, unknown>>;
  /** Pre-built AskUserQuestion form data (actionId + questions). Set by index.ts after registerPendingAction. */
  askQuestions?: { actionId: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> };
  /** Pre-built ExitPlanMode data (actionId). Set by index.ts after registerPendingAction. */
  planReview?: { actionId: string; planContent?: string };
  /** Permission panels retained after their interactive form was submitted. */
  retainedPermissionPanels?: RetainedPermissionPanel[];
}

// ── Token cache (shared across sessions) ────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const res = await fetch(
    `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
  );
  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

export type TokenProvider = () => Promise<string>;

export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log: (msg: string) => void;
  private _tokenProvider: TokenProvider | null;
  private cardkit: CardKitElements;

  // Independent throttle per element — thinking and content don't interfere
  private throttler = new ElementThrottler();

  // Timer subsystems (intervals live in streaming/throttle.ts):
  // - safety: auto-close abandoned cards
  // - heartbeat: periodic status update when no events arrive
  // - renew: Feishu auto-closes streaming after 10 minutes → switch to degraded
  // - degradedFlush: coalesced im.message.patch rebuilds
  private _timers = {
    safety: new TimerSlot(),
    heartbeat: new TimerSlot(),
    renew: new TimerSlot(),
    degradedFlush: new TimerSlot(),
  };
  private _startTime = 0;
  private _lastStatusText = "";
  private _heartbeatRenderer: ((elapsed: number) => string) | null = null;

  // Degraded mode: when CardKit element updates fail (e.g. streaming expired),
  // fall back to im.message.patch full-card rebuilds
  private _degraded = false;
  private _consecutiveFailures = 0;
  private static DEGRADED_FAILURE_THRESHOLD = 2;

  // (PROCESS_BUDGET removed — steps are now individual div elements, no markdown accumulation)

  // AbortController for signalling upstream when safety timeout fires
  private _abortController: AbortController | null = null;

  // Timeline: thinking + steps interleaved
  private _steps: StepInfo[] = [];
  private _fullThinking = "";
  private _nameSuffix: string | undefined;
  private _subtitle: string | null = null;

  // Active + retained permission forms (for degraded mode card rebuild)
  private permissions = new PermissionFormStore();

  constructor(
    client: Client,
    creds: Credentials,
    options?: {
      log?: (msg: string) => void;
      tokenProvider?: TokenProvider;
    },
  ) {
    this.client = client;
    this.creds = creds;
    this.log = options?.log ?? ((msg) => console.log(`[streaming] ${msg}`));
    this._tokenProvider = options?.tokenProvider ?? null;
    this.cardkit = new CardKitElements({
      domain: creds.domain,
      getToken: () => this._getToken(),
      log: (msg) => this.log(msg),
      onSuccess: () => { this._consecutiveFailures = 0; },
      onFailure: () => this._onElementApiFailed(),
    });
  }

  /** Get token via 1Passport provider or fall back to direct fetch. */
  private async _getToken(): Promise<string> {
    if (this._tokenProvider) return this._tokenProvider();
    return getToken(this.creds);
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: { replyToMessageId?: string; sessionId?: string | null; displayName?: string | null; nameSuffix?: string; subtitle?: string | null },
  ): Promise<void> {
    if (this.state) return;
    this._nameSuffix = options?.nameSuffix;
    this._subtitle = options?.subtitle ?? null;

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson = buildStreamingCardJson(options);

    const createRes = await fetch(`${apiBase}/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this._getToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "card_json",
        data: JSON.stringify(cardJson),
      }),
    });
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;

    const cardContent = JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    });

    let sendRes;
    if (options?.replyToMessageId) {
      sendRes = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: { msg_type: "interactive", content: cardContent, reply_in_thread: true },
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: "",
      currentThinking: "",
      currentStatus: "",
    };
    this._resetSafetyTimer();
    this._startHeartbeat();
    this._startRenewTimer();
    this.log(
      `Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}` +
      (options?.replyToMessageId ? ` (thread reply to ${options.replyToMessageId})` : ` (direct message)`),
    );
  }

  // ── Element CRUD (sequence owned here, wire format in streaming/cardkit-elements.ts) ──

  /** Reserve the next CardKit sequence number, or null if there is no live card. */
  private _nextCardRef(): CardRef | null {
    if (!this.state || this.closed) return null;
    this.state.sequence += 1;
    return { cardId: this.state.cardId, seq: this.state.sequence };
  }

  private async _updateElementRaw(
    elementId: string,
    content: string,
  ): Promise<void> {
    const ref = this._nextCardRef();
    if (!ref) {
      this.log(`Update ${elementId} skipped (closed=${this.closed})`);
      return;
    }
    await this.cardkit.update(ref, elementId, content);
  }

  /**
   * Append a new element to a container (e.g. collapsible_panel) via CardKit insert element API.
   */
  private async _appendElement(
    targetElementId: string,
    element: Record<string, unknown>,
  ): Promise<void> {
    const ref = this._nextCardRef();
    if (!ref) return;
    await this.cardkit.append(ref, targetElementId, element);
  }

  private async _deleteElement(elementId: string): Promise<void> {
    const ref = this._nextCardRef();
    if (!ref) return;
    await this.cardkit.remove(ref, elementId);
  }

  // ── Degraded mode: fall back to im.message.patch ──────────

  private _onElementApiFailed(): void {
    this._consecutiveFailures++;
    if (!this._degraded && this._consecutiveFailures >= FeishuStreamingSession.DEGRADED_FAILURE_THRESHOLD) {
      this._degraded = true;
      this._timers.renew.clear();
      this.log(`Entering degraded mode after ${this._consecutiveFailures} consecutive failures — switching to im.message.patch`);
    }
  }

  isDegraded(): boolean {
    return this._degraded;
  }

  private _buildCurrentCard(): Record<string, unknown> {
    return buildDegradedCard({
      status: this.state?.currentStatus,
      steps: this._steps,
      text: this.state?.currentText,
      retainedPanels: this.permissions.retained(),
      pendingPermission: this.permissions.pending,
      nameSuffix: this._nameSuffix,
      subtitle: this._subtitle,
    });
  }

  private _scheduleDegradedFlush(delayMs = DEGRADED_FLUSH_MS): void {
    if (this.closed || !this.state) return;
    this._timers.degradedFlush.armIfIdle(delayMs, async () => {
      this._timers.degradedFlush.clear();
      if (this.closed || !this.state) return;
      await this._flushDegradedNow();
    });
  }

  private async _flushDegradedNow(): Promise<boolean> {
    if (!this.state || this.closed) return false;
    this._timers.degradedFlush.clear();
    try {
      const card = this._buildCurrentCard();
      await this.client.im.message.patch({
        path: { message_id: this.state.messageId },
        data: { content: JSON.stringify(card) },
      });
      return true;
    } catch (e: any) {
      const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : "";
      this.log(`Degraded flush failed: ${String(e)} ${detail}`);
      return false;
    }
  }

  // ── Permission form in streaming card ──────────────────────

  async appendPermissionForm(form: PermissionFormElements): Promise<void> {
    this.permissions.pending = form;
    if (this._degraded) {
      if (!(await this._flushDegradedNow())) {
        throw new Error("Failed to render permission form");
      }
      return;
    }
    // Streaming mode: use CardKit element API to insert form elements.
    // im.message.patch fails on cards with streaming_mode=true, so we
    // must stay within the CardKit element API while streaming is active.
    try {
      await insertPermissionFormElements(form, (afterElementId, element) =>
        this._insertElementOrThrow(afterElementId, element),
      );
    } catch (e) {
      this.log(`Permission form element insert failed: ${e}, falling back to degraded`);
      await this._closeStreamingMode();
      this._degraded = true;
      this._timers.renew.clear();
      if (!(await this._flushDegradedNow())) {
        throw new Error("Failed to render permission form");
      }
    }
  }

  /** Insert element via CardKit API, throwing on failure (unlike fire-and-forget _appendElementAfter). */
  private async _insertElementOrThrow(
    afterElementId: string,
    element: Record<string, unknown>,
  ): Promise<void> {
    const ref = this._nextCardRef();
    if (!ref) throw new Error("Session not active");
    await this.cardkit.insertAfterOrThrow(ref, afterElementId, element);
  }

  async removePermissionForm(actionId: string, options?: { preservePanel?: boolean }): Promise<void> {
    const preservePanel = options?.preservePanel === true;
    this.permissions.settle(actionId, preservePanel);
    if (this._degraded) {
      this._scheduleDegradedFlush(PERMISSION_FLUSH_MS);
      return;
    }
    const ids = permissionElementIds(actionId, preservePanel);
    for (const id of ids) {
      this.queue = this.queue.then(() => this._deleteElement(id).catch(() => {}));
    }
  }

  private async _appendElementAfter(
    afterElementId: string,
    element: Record<string, unknown>,
  ): Promise<void> {
    const ref = this._nextCardRef();
    if (!ref) return;
    await this.cardkit.insertAfter(ref, afterElementId, element);
  }

  // ── Per-element throttle helpers ───────────────────────────

  /**
   * Fire-and-forget throttled update for a specific element.
   * Does NOT await the HTTP call — enqueues it and returns immediately,
   * so the event consumption loop isn't blocked.
   */
  private _throttledUpdate(
    elementId: string,
    content: string,
    stateField: "currentText" | "currentThinking" | "currentStatus",
  ): void {
    if (!this.state || this.closed) return;
    this._resetSafetyTimer();
    this._resetHeartbeat();
    if (stateField === "currentStatus") {
      this._lastStatusText = content;
    }

    this.state[stateField] = content;

    if (this._degraded) {
      this._scheduleDegradedFlush();
      return;
    }

    this.throttler.schedule(
      elementId,
      content,
      () => this.closed || !this.state,
      (text) => {
        this.state![stateField] = text;
        if (this._degraded) {
          this._scheduleDegradedFlush();
        } else {
          this.queue = this.queue.then(() =>
            this._updateElementRaw(elementId, text),
          );
        }
      },
    );
  }

  getLastStatus(): string {
    return this._lastStatusText;
  }

  /** Register a custom renderer for heartbeat status (e.g. plan/agent mode). */
  setHeartbeatRenderer(renderer: ((elapsed: number) => string) | null): void {
    this._heartbeatRenderer = renderer;
  }

  /** Get elapsed seconds since session started. */
  getElapsed(): number {
    return Math.round((Date.now() - this._startTime) / 1000);
  }

  // ── Public update methods (fire-and-forget, don't block caller) ──

  async update(text: string): Promise<void> {
    if (!text) return;
    this._throttledUpdate("content", text, "currentText");
  }

  async updateThinking(text: string): Promise<void> {
    this._fullThinking = text;
    // Thinking text is accumulated for final card only — not rendered during streaming
    // (steps are now individual div elements with icons, not interleaved in markdown)
  }

  async updateStatus(text: string): Promise<void> {
    this._throttledUpdate("status_bar", text, "currentStatus");
  }

  /**
   * Add a step to the process panel by appending a div with standard_icon.
   */
  addStep(toolName: string, desc: string): void {
    const stepIndex = this._steps.length;
    this.log(`addStep #${stepIndex}: ${toolName} desc="${desc.slice(0, 80)}"`);
    this._steps.push({ tool: toolName, desc, thinkingOffset: this._fullThinking.length });

    if (this._degraded) {
      this._scheduleDegradedFlush();
      return;
    }

    const element = { ...buildStepDiv(toolName, desc), element_id: `step_${stepIndex}` };
    this._updateProcessHeader();

    const visibleCount = stepIndex - (this._oldestVisibleStep ?? 0);
    if (visibleCount >= MAX_VISIBLE_STEPS) {
      const deleteId = `step_${this._oldestVisibleStep ?? 0}`;
      this._oldestVisibleStep = (this._oldestVisibleStep ?? 0) + 1;
      this.queue = this.queue.then(() => this._deleteElement(deleteId));
    }
    this.queue = this.queue.then(() =>
      this._appendElement("process_panel", element),
    );
  }

  private _oldestVisibleStep: number | undefined;

  /** Update the last pending step with its duration. */
  updateStepDesc(desc: string): void {
    const step = this._steps.findLast((s) => !s.durationMs);
    if (!step) return;
    const stepIndex = this._steps.indexOf(step);
    step.desc = desc;
    if (this._degraded) {
      this._scheduleDegradedFlush();
    } else {
      this._updateElementRaw(`step_${stepIndex}`, desc);
    }
  }

  updateStepDuration(durationMs: number): void {
    const step = this._steps.findLast((s) => !s.durationMs);
    if (!step) return;
    const stepIndex = this._steps.indexOf(step);
    step.durationMs = durationMs;
    const dur = ` (${(durationMs / 1000).toFixed(1)}s)`;
    if (this._degraded) {
      this._scheduleDegradedFlush();
    } else {
      this._updateElementRaw(`step_${stepIndex}`, `${step.desc}${dur}`);
    }
  }

  /** Update the process panel header title with current step count. */
  private _updateProcessHeader(): void {
    const total = this._steps.length;
    // collapsible_panel header title can't be updated via element API,
    // so we keep it as-is ("steps"). The step count is visible from the divs inside.
  }

  // _renderTimeline removed — steps now use _appendElement (div + standard_icon)

  /** Get collected steps for final card rendering. */
  getSteps(): StepInfo[] {
    return this._steps;
  }

  /** Get the card ID (for card action routing). */
  getCardId(): string | null {
    return this.state?.cardId ?? null;
  }

  // ── DEPRECATED: Interactive cards moved to buildFinalCard embedded forms ──

  /** @deprecated — kept only for backwards compat, no longer called. */
  async sendPlanReviewCard(actionId: string, chatId: string): Promise<string | null> {
    const card = buildLegacyPlanReviewCard(actionId);

    const apiBase = resolveApiBase(this.creds.domain);
    try {
      const res = await fetch(`${apiBase}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this._getToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        }),
      });
      const body = await res.json() as Record<string, unknown>;
      if (body.code !== 0) {
        this.log(`sendPlanReviewCard failed: ${JSON.stringify(body).slice(0, 300)}`);
        return null;
      }
      const messageId = (body.data as Record<string, unknown>)?.message_id as string;
      this.log(`sendPlanReviewCard OK: messageId=${messageId}`);
      return messageId;
    } catch (e) {
      this.log(`sendPlanReviewCard error: ${String(e)}`);
      return null;
    }
  }



  // ── Flush all pending throttled updates ────────────────────

  private async _flushAll(): Promise<void> {
    this.throttler.flush(
      () => this.state !== null,
      (elementId, text) => {
        const field =
          elementId === "content" ? "currentText"
          : elementId === "status_bar" ? "currentStatus"
          : "currentThinking";
        this.state![field] = text;
        this.queue = this.queue.then(() =>
          this._updateElementRaw(elementId, text),
        );
      },
    );
    // Wait for all queued updates to complete
    await this.queue;
  }

  // ── Safety timeout ─────────────────────────────────────────

  /**
   * Get an AbortSignal that fires when the safety timeout closes the card.
   * Upstream consumers can use this to abort blocked iteration.
   */
  get abortSignal(): AbortSignal {
    if (!this._abortController) {
      this._abortController = new AbortController();
    }
    return this._abortController.signal;
  }

  /**
   * Abort the streaming session (triggered by user /esc command).
   * Signals upstream to break the stream loop, then closes the card with a notice.
   */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.log("User abort requested");
    this._abortController?.abort();
    // Update status bar to indicate interruption before closing
    try {
      await this.updateStatus("Interrupted");
    } catch { /* best-effort */ }
    await this.close({ aborted: true });
  }

  private _resetSafetyTimer(): void {
    this._timers.safety.arm(SAFETY_TIMEOUT_MS, () => {
      if (this.state && !this.closed) {
        this.log(
          `Safety timeout: closing abandoned streaming card ${this.state.cardId}`,
        );
        // Signal upstream to abort any blocked iteration
        this._abortController?.abort();
        this.close().catch((e) =>
          this.log(`Safety close failed: ${String(e)}`),
        );
      }
    });
  }

  // ── Heartbeat ───────────────────────────────────────────────

  private _startHeartbeat(): void {
    this._startTime = Date.now();
    this._resetHeartbeat();
  }

  private _resetHeartbeat(): void {
    this._timers.heartbeat.arm(HEARTBEAT_INTERVAL_MS, () => {
      this._sendHeartbeat();
    });
  }

  private _sendHeartbeat(): void {
    if (!this.state || this.closed) return;
    const elapsed = Math.round((Date.now() - this._startTime) / 1000);
    const heartbeatText = this._heartbeatRenderer
      ? this._heartbeatRenderer(elapsed)
      : `${this._lastStatusText || "Running"} (${elapsed}s)`;
    if (this.state) this.state.currentStatus = heartbeatText;
    if (this._degraded) {
      this._scheduleDegradedFlush();
    } else {
      this.queue = this.queue.then(() =>
        this._updateElementRaw("status_bar", heartbeatText),
      );
    }
    // Schedule next heartbeat
    this._timers.heartbeat.arm(HEARTBEAT_INTERVAL_MS, () => {
      this._sendHeartbeat();
    });
  }

  // ── Streaming mode renewal (Feishu 10-min hard limit) ─────

  private _startRenewTimer(): void {
    this._timers.renew.arm(STREAMING_RENEW_MS, () => {
      this._renewStreaming();
    });
  }

  private _renewStreaming(): void {
    if (!this.state || this.closed || this._degraded) return;
    this._degraded = true;
    const elapsed = Math.round((Date.now() - this._startTime) / 1000);
    this.log(`Entering degraded mode at ${elapsed}s — streaming window expired, switching to im.message.patch`);
    this._scheduleDegradedFlush();
  }

  // ── Close streaming mode (prerequisite for im.message.patch) ──

  private async _closeStreamingMode(summaryText?: string): Promise<void> {
    if (!this.state || this._degraded) return;
    this.state.sequence += 1;
    const ref: CardRef = { cardId: this.state.cardId, seq: this.state.sequence };
    await this.cardkit.closeStreamingMode(ref, () =>
      buildSummary(summaryText ?? this.state?.currentText ?? ""),
    );
  }

  // ── Close streaming card ───────────────────────────────────

  async close(finalTextOrOptions?: string | StreamingCloseOptions): Promise<void> {
    if (!this.state || this.closed) return;

    this._timers.safety.clear();
    this._timers.heartbeat.clear();
    this._timers.renew.clear();
    this._timers.degradedFlush.clear();

    // Flush all pending throttled updates first
    if (!this._degraded) {
      await this._flushAll();
    }

    // Normalize arguments
    let finalText: string | undefined;
    let thinking: string | null | undefined;
    let toolEntries: ToolEntry[] | undefined;
    let trailingThinking: string | null | undefined;
    let toolCount: number | undefined;
    let stats: string | null | undefined;
    let mentionOpenId: string | undefined;
    let sessionId: string | null | undefined;
    let displayName: string | null | undefined;

    if (typeof finalTextOrOptions === "string") {
      finalText = finalTextOrOptions;
    } else if (finalTextOrOptions) {
      finalText = finalTextOrOptions.finalText;
      thinking = finalTextOrOptions.thinking;
      toolEntries = finalTextOrOptions.toolEntries;
      trailingThinking = finalTextOrOptions.trailingThinking;
      toolCount = finalTextOrOptions.toolCount;
      stats = finalTextOrOptions.stats;
      mentionOpenId = finalTextOrOptions.mentionOpenId;
      sessionId = finalTextOrOptions.sessionId;
      displayName = finalTextOrOptions.displayName;
    }

    // Append abort notice to content if user interrupted
    const aborted = typeof finalTextOrOptions === "object" && finalTextOrOptions?.aborted;
    const rawText = finalText ?? this.state.currentText;
    const text = aborted ? (rawText ? rawText + "\n\n---\n⏹ *已被用户中断*" : "⏹ *已被用户中断*") : rawText;
    const thinkingText = thinking ?? this.state.currentThinking;
    const apiBase = resolveApiBase(this.creds.domain);

    if (!this._degraded) {
      // Send final element updates BEFORE marking closed (_updateElementRaw checks this.closed)
      if (text && text !== this.state.currentText) {
        await this._updateElementRaw("content", text);
      }
      if (stats) {
        await this._updateElementRaw("stats_text", stats);
      }
    }

    // Now mark closed so no further updates slip through
    this.closed = true;

    // Close streaming mode via PATCH /settings (skip if degraded — streaming already expired)
    if (!this._degraded) {
      await this._closeStreamingMode(text);
    } else {
      this.log(`Close: skipping settings PATCH (degraded mode)`);
    }

    // Extract interactive forms from permission_denials
    const permDenials = typeof finalTextOrOptions === "object" ? finalTextOrOptions?.permissionDenials : undefined;
    const askQuestions = typeof finalTextOrOptions === "object" ? (finalTextOrOptions as StreamingCloseOptions & { askQuestions?: Parameters<typeof buildFinalCard>[0]["askQuestions"] }).askQuestions : undefined;
    const planReview = typeof finalTextOrOptions === "object" ? (finalTextOrOptions as StreamingCloseOptions & { planReview?: Parameters<typeof buildFinalCard>[0]["planReview"] }).planReview : undefined;
    const retainedPermissionPanels = typeof finalTextOrOptions === "object"
      ? (finalTextOrOptions.retainedPermissionPanels ?? this.permissions.retained())
      : this.permissions.retained();

    // Replace with static card — process panel collapsed with icon divs
    try {
      const finalCard = buildFinalCard({
        text,
        thinking: thinkingText,
        toolEntries,
        steps: this._steps.length > 0 ? this._steps : undefined,
        trailingThinking,
        toolCount,
        stats,
        mentionOpenId,
        sessionId,
        displayName,
        askQuestions,
        planReview,
        retainedPermissionPanels,
        nameSuffix: this._nameSuffix,
        subtitle: this._subtitle,
      });
      const cardJson = JSON.stringify(finalCard);
      this.log(`Final card patch: msgId=${this.state.messageId} size=${(cardJson.length / 1024).toFixed(1)}KB steps=${this._steps.length}`);
      await this.client.im.message.patch({
        path: { message_id: this.state.messageId },
        data: { content: cardJson },
      });
      this.log(`Final card patch OK`);
    } catch (e: any) {
      const detail = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : "";
      this.log(`Final card patch failed: ${String(e)} ${detail}`);
    }

    this.log(`Closed streaming: cardId=${this.state.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  getMessageId(): string | null {
    return this.state?.messageId ?? null;
  }
}
