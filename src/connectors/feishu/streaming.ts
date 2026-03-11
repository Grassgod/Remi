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
import { resolveApiBase } from "./client.js";
import { type ToolEntry, buildToolCollapsible, buildStepDiv, TOOL_EMOJI } from "./tool-formatters.js";

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
  /** Thinking text after the last tool call. */
  trailingThinking?: string | null;
  /** Number of tool calls for the process panel header. */
  toolCount?: number;
  stats?: string | null;
  /** Sender open ID — if provided, an @mention is embedded in the final card. */
  mentionOpenId?: string;
  /** Session ID for dynamic card header name (e.g. "好奇的 Remi"). */
  sessionId?: string | null;
}

/** Step data for process panel rendering. */
export interface StepInfo {
  tool: string;
  desc: string;
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

function truncateSummary(text: string, max = 50): string {
  if (!text) return "";
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

import { buildCardHeader, sanitizeHeadings } from "./send.js";

/**
 * Build the final static card JSON.
 *
 * Process panel uses two layers:
 * 1. Outer: icon step divs (grey, notation size) — quick overview
 * 2. Inner: each step is a collapsible_panel with input/output details on click
 */
function buildFinalCard(opts: {
  text: string;
  thinking?: string | null;
  toolEntries?: ToolEntry[];
  /** Step descriptions collected during streaming (tool + desc pairs). */
  steps?: Array<{ tool: string; desc: string }>;
  trailingThinking?: string | null;
  toolCount?: number;
  stats?: string | null;
  mentionOpenId?: string;
  sessionId?: string | null;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  const hasTools = opts.toolEntries && opts.toolEntries.length > 0;
  const hasSteps = opts.steps && opts.steps.length > 0;
  const hasThinking = opts.thinking || hasTools || hasSteps;

  if (hasThinking) {
    // Build step elements for the collapsed panel
    const panelElements: Record<string, unknown>[] = [];

    if (hasTools) {
      // Rich mode: each tool entry becomes an icon div, clickable for details via nested collapsible
      for (const entry of opts.toolEntries!) {
        panelElements.push(buildToolCollapsible(entry));
      }
    } else if (hasSteps) {
      // Lightweight mode: icon divs from step descriptions
      for (const step of opts.steps!) {
        panelElements.push(buildStepDiv(step.tool, step.desc));
      }
    } else if (opts.thinking) {
      // No tools/steps — fallback to raw thinking markdown
      panelElements.push({ tag: "markdown", content: opts.thinking });
    }

    if (panelElements.length > 0) {
      const stepCount = opts.toolCount ?? opts.steps?.length ?? panelElements.length;
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        border: { color: "grey-300", corner_radius: "6px" },
        header: {
          title: {
            tag: "plain_text",
            content: `${stepCount} steps`,
            text_color: "grey",
            text_size: "notation",
          },
          icon: { tag: "standard_icon", token: "right_outlined", color: "grey" },
          icon_position: "right",
          icon_expanded_angle: 90,
        },
        vertical_spacing: "2px",
        elements: panelElements,
      });
    }
  }

  elements.push({ tag: "markdown", content: sanitizeHeadings(opts.text || "") });

  // Stats bar with optional @mention
  const statsContent = opts.mentionOpenId
    ? `<at id=${opts.mentionOpenId}></at> ${opts.stats ?? "✅"}`
    : opts.stats;

  if (statsContent) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: statsContent });
  }

  return {
    schema: "2.0",
    header: buildCardHeader(opts.sessionId),
    config: { width_mode: "fill", summary: { content: truncateSummary(opts.text) } },
    body: { elements },
  };
}

// ── Per-element throttle state ──────────────────────────────

interface ElementThrottle {
  lastSendTime: number;
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | null;
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

  // Independent throttle per element — thinking and content don't interfere
  private throttles = new Map<string, ElementThrottle>();
  private throttleMs = 300;

  // Safety timeout: auto-close if no updates for 10 minutes
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private static SAFETY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

  // Heartbeat: periodic status update when no events arrive
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private static HEARTBEAT_INTERVAL_MS = 10_000;
  private _startTime = 0;
  private _lastStatusText = "";

  // Overflow protection: max bytes for process content (~10KB)
  private static PROCESS_BUDGET = 10000;

  // AbortController for signalling upstream when safety timeout fires
  private _abortController: AbortController | null = null;

  // Step tracking for icon-based process panel
  private _steps: StepInfo[] = [];

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
  }

  /** Get token via 1Passport provider or fall back to direct fetch. */
  private async _getToken(): Promise<string> {
    if (this._tokenProvider) return this._tokenProvider();
    return getToken(this.creds);
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: { replyToMessageId?: string; sessionId?: string | null },
  ): Promise<void> {
    if (this.state) return;

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson = {
      schema: "2.0",
      header: buildCardHeader(options?.sessionId),
      config: {
        width_mode: "fill",
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
        },
      },
      body: {
        elements: [
          { tag: "markdown", content: "", element_id: "status_bar" },
          {
            tag: "collapsible_panel",
            expanded: false,
            border: { color: "grey-300", corner_radius: "6px" },
            header: {
              title: {
                tag: "plain_text",
                content: "steps",
                text_color: "grey",
                text_size: "notation",
              },
              icon: { tag: "standard_icon", token: "right_outlined", color: "grey" },
              icon_position: "right",
              icon_expanded_angle: 90,
            },
            vertical_spacing: "2px",
            element_id: "process_panel",
            elements: [
              { tag: "markdown", content: "", element_id: "process_content" },
            ],
          },
          { tag: "markdown", content: "", element_id: "content" },
          { tag: "hr", element_id: "stats_hr" },
          { tag: "markdown", content: "", element_id: "stats_text" },
        ],
      },
    };

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
    this.log(
      `Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}` +
      (options?.replyToMessageId ? ` (thread reply to ${options.replyToMessageId})` : ` (direct message)`),
    );
  }

  // ── Element update (raw API call with retry on 5xx) ────────

  private async _updateElementRaw(
    elementId: string,
    content: string,
  ): Promise<void> {
    if (!this.state || this.closed) return;
    this.state.sequence += 1;
    const apiBase = resolveApiBase(this.creds.domain);
    const seq = this.state.sequence;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${await this._getToken()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content,
              sequence: seq,
              uuid: `s_${this.state.cardId}_${seq}`,
            }),
          },
        );
        if (res.ok) return;
        const body = await res.text().catch(() => "");
        if (attempt === 0 && res.status >= 500) {
          this.log(`Update ${elementId} HTTP ${res.status}, retrying...`);
          continue;
        }
        this.log(
          `Update ${elementId} HTTP ${res.status}: ${body.slice(0, 300)}`,
        );
        return;
      } catch (e) {
        if (attempt === 0) {
          this.log(`Update ${elementId} failed, retrying: ${String(e)}`);
          continue;
        }
        this.log(`Update ${elementId} failed: ${String(e)}`);
      }
    }
  }

  // ── Per-element throttle helpers ───────────────────────────

  private _getThrottle(elementId: string): ElementThrottle {
    if (!this.throttles.has(elementId)) {
      this.throttles.set(elementId, {
        lastSendTime: 0,
        pending: null,
        timer: null,
      });
    }
    return this.throttles.get(elementId)!;
  }

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
    // Track last status for heartbeat display context
    if (stateField === "currentStatus") {
      this._lastStatusText = content.replace(/[⏳✍️🤔⚙️📋🤖]/g, "").trim();
    }

    const throttle = this._getThrottle(elementId);
    const now = Date.now();

    if (now - throttle.lastSendTime >= this.throttleMs) {
      // Enough time passed — send immediately (fire-and-forget)
      throttle.pending = null;
      throttle.lastSendTime = now;
      this.state[stateField] = content;
      this.queue = this.queue.then(() =>
        this._updateElementRaw(elementId, content),
      );
    } else {
      // Within throttle window — store pending and schedule deferred flush
      throttle.pending = content;
      if (!throttle.timer) {
        const delay = this.throttleMs - (now - throttle.lastSendTime);
        throttle.timer = setTimeout(() => {
          throttle.timer = null;
          if (this.closed || !this.state) return;

          const text = throttle.pending;
          if (text === null) return;
          throttle.pending = null;
          throttle.lastSendTime = Date.now();
          this.state![stateField] = text;
          this.queue = this.queue.then(() =>
            this._updateElementRaw(elementId, text),
          );
        }, delay);
      }
    }
  }

  // ── Public update methods (fire-and-forget, don't block caller) ──

  async update(text: string): Promise<void> {
    this._throttledUpdate("content", sanitizeHeadings(text), "currentText");
  }

  async updateThinking(text: string): Promise<void> {
    this._throttledUpdate("process_content", this._truncateIfNeeded(text), "currentThinking");
  }

  async updateStatus(text: string): Promise<void> {
    this._throttledUpdate("status_bar", text, "currentStatus");
  }

  /**
   * Add a step to the process panel (icon + one-liner).
   * Uses emoji in streaming markdown; final card uses standard_icon divs.
   */
  addStep(toolName: string, desc: string): void {
    this._steps.push({ tool: toolName, desc });
    const stepLines = this._steps
      .map((s) => {
        const e = TOOL_EMOJI[s.tool] ?? TOOL_EMOJI._default ?? "⚙️";
        return `${e}  <font color='grey'>${s.desc}</font>`;
      })
      .join("\n");
    // Prepend step count since collapsible_panel header can't be updated via element API
    const stepsMarkdown = `**${this._steps.length} steps**\n${stepLines}`;
    this._throttledUpdate("process_content", this._truncateIfNeeded(stepsMarkdown), "currentThinking");
  }

  /** Get collected steps for final card rendering. */
  getSteps(): StepInfo[] {
    return this._steps;
  }


  // ── Flush all pending throttled updates ────────────────────

  private async _flushAll(): Promise<void> {
    for (const [elementId, throttle] of this.throttles) {
      // Cancel any scheduled timer
      if (throttle.timer) {
        clearTimeout(throttle.timer);
        throttle.timer = null;
      }
      // Send any pending content
      if (throttle.pending !== null && this.state) {
        const text = throttle.pending;
        throttle.pending = null;
        const field =
          elementId === "content" ? "currentText"
          : elementId === "status_bar" ? "currentStatus"
          : "currentThinking";
        this.state[field] = text;
        this.queue = this.queue.then(() =>
          this._updateElementRaw(elementId, text),
        );
      }
    }
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

  private _resetSafetyTimer(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => {
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
    }, FeishuStreamingSession.SAFETY_TIMEOUT_MS);
  }

  private _clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────

  private _startHeartbeat(): void {
    this._startTime = Date.now();
    this._resetHeartbeat();
  }

  private _resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this._sendHeartbeat();
    }, FeishuStreamingSession.HEARTBEAT_INTERVAL_MS);
  }

  private _sendHeartbeat(): void {
    if (!this.state || this.closed) return;
    const elapsed = Math.round((Date.now() - this._startTime) / 1000);
    const label = this._lastStatusText || "Running";
    const heartbeatText = `⏳ ${label} (${elapsed}s)`;
    // Bypass throttle — heartbeat is already rate-limited by its own timer
    this.queue = this.queue.then(() =>
      this._updateElementRaw("status_bar", heartbeatText),
    );
    // Schedule next heartbeat
    this.heartbeatTimer = setTimeout(() => {
      this._sendHeartbeat();
    }, FeishuStreamingSession.HEARTBEAT_INTERVAL_MS);
  }

  private _clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Overflow protection ────────────────────────────────────

  /**
   * Truncate process content from the head to stay within the 30KB card limit.
   * Keeps the most recent thinking + tool entries visible.
   */
  private _truncateIfNeeded(text: string): string {
    if (Buffer.byteLength(text, "utf-8") <= FeishuStreamingSession.PROCESS_BUDGET) {
      return text;
    }
    const marker = "... *(earlier content truncated)*\n\n---\n\n";
    let start = 0;
    while (
      Buffer.byteLength(marker + text.slice(start), "utf-8") >
      FeishuStreamingSession.PROCESS_BUDGET
    ) {
      const nextBreak = text.indexOf("\n---\n", start + 1);
      if (nextBreak === -1) {
        start += 500;
        break;
      }
      start = nextBreak + 5; // skip past "\n---\n"
    }
    return marker + text.slice(start);
  }

  // ── Close streaming card ───────────────────────────────────

  async close(finalTextOrOptions?: string | StreamingCloseOptions): Promise<void> {
    if (!this.state || this.closed) return;

    this._clearSafetyTimer();
    this._clearHeartbeat();

    // Flush all pending throttled updates first
    await this._flushAll();

    // Normalize arguments
    let finalText: string | undefined;
    let thinking: string | null | undefined;
    let toolEntries: ToolEntry[] | undefined;
    let trailingThinking: string | null | undefined;
    let toolCount: number | undefined;
    let stats: string | null | undefined;
    let mentionOpenId: string | undefined;
    let sessionId: string | null | undefined;

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
    }

    const text = finalText ?? this.state.currentText;
    const thinkingText = thinking ?? this.state.currentThinking;
    const apiBase = resolveApiBase(this.creds.domain);

    // Send final element updates BEFORE setting this.closed
    // (_updateElementRaw checks this.closed and bails out if true)
    if (text && text !== this.state.currentText) {
      await this._updateElementRaw("content", text);
    }
    if (thinkingText && thinkingText !== this.state.currentThinking) {
      await this._updateElementRaw("process_content", thinkingText);
    }
    if (stats) {
      await this._updateElementRaw("stats_text", stats);
    }

    // Now mark closed so no further updates slip through
    this.closed = true;

    // Close streaming mode via PATCH /settings
    this.state.sequence += 1;
    try {
      const res = await fetch(
        `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${await this._getToken()}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            settings: JSON.stringify({
              config: {
                streaming_mode: false,
                summary: { content: truncateSummary(text) },
              },
            }),
            sequence: this.state.sequence,
            uuid: `c_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.log(`Close settings HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
    } catch (e) {
      this.log(`Close failed: ${String(e)}`);
    }

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
      });
      await this.client.im.message.patch({
        path: { message_id: this.state.messageId },
        data: { content: JSON.stringify(finalCard) },
      });
    } catch (e) {
      this.log(`Final card patch failed: ${String(e)}`);
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
