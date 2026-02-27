/**
 * Feishu streaming card session for real-time AI response updates.
 *
 * Flow: AI starts -> create streaming card -> throttled element updates -> close card
 *
 * Key design decisions (learned from Tika bot_stream patterns):
 * - Independent throttle per element (thinking vs content don't block each other)
 * - Fire-and-forget updates (don't block the event consumption loop)
 * - Guaranteed flush before close (no lost pending updates)
 * - Safety timeout to auto-close abandoned cards (5 min)
 * - Retry on transient 5xx API failures
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain } from "./types.js";
import { resolveApiBase } from "./client.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  currentThinking: string;
};

export interface StreamingCloseOptions {
  finalText?: string;
  thinking?: string | null;
  stats?: string | null;
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

/** Build the final static card JSON (thinking panel collapsed). */
function buildFinalCard(opts: {
  text: string;
  thinking?: string | null;
  stats?: string | null;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  if (opts.thinking) {
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: { title: { tag: "plain_text", content: "💭 Thinking" } },
      vertical_spacing: "2px",
      elements: [{ tag: "markdown", content: opts.thinking }],
    });
  }

  elements.push({ tag: "markdown", content: opts.text || "" });

  if (opts.stats) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: opts.stats });
  }

  return {
    schema: "2.0",
    config: { summary: { content: truncateSummary(opts.text) } },
    body: { elements },
  };
}

// ── Per-element throttle state ──────────────────────────────

interface ElementThrottle {
  lastSendTime: number;
  pending: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log: (msg: string) => void;

  // Independent throttle per element — thinking and content don't interfere
  private throttles = new Map<string, ElementThrottle>();
  private throttleMs = 300;

  // Safety timeout: auto-close if no updates for 5 minutes
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private static SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(client: Client, creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log ?? ((msg) => console.log(`[streaming] ${msg}`));
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    if (this.state) return;

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
        },
      },
      body: {
        elements: [
          {
            tag: "collapsible_panel",
            expanded: true,
            background_style: "default",
            header: {
              title: { tag: "plain_text", content: "💭 Thinking..." },
            },
            vertical_spacing: "2px",
            element_id: "thinking_panel",
            elements: [
              { tag: "markdown", content: "", element_id: "thinking_content" },
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
        Authorization: `Bearer ${await getToken(this.creds)}`,
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
        data: { msg_type: "interactive", content: cardContent },
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
    };
    this._resetSafetyTimer();
    this.log(
      `Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`,
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
              Authorization: `Bearer ${await getToken(this.creds)}`,
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
    stateField: "currentText" | "currentThinking",
  ): void {
    if (!this.state || this.closed) return;
    this._resetSafetyTimer();

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
    this._throttledUpdate("content", text, "currentText");
  }

  async updateThinking(text: string): Promise<void> {
    this._throttledUpdate("thinking_content", text, "currentThinking");
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
          elementId === "content" ? "currentText" : "currentThinking";
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

  private _resetSafetyTimer(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => {
      if (this.state && !this.closed) {
        this.log(
          `Safety timeout: closing abandoned streaming card ${this.state.cardId}`,
        );
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

  // ── Close streaming card ───────────────────────────────────

  async close(finalTextOrOptions?: string | StreamingCloseOptions): Promise<void> {
    if (!this.state || this.closed) return;

    this._clearSafetyTimer();

    // Flush all pending throttled updates first
    await this._flushAll();

    // Normalize arguments
    let finalText: string | undefined;
    let thinking: string | null | undefined;
    let stats: string | null | undefined;

    if (typeof finalTextOrOptions === "string") {
      finalText = finalTextOrOptions;
    } else if (finalTextOrOptions) {
      finalText = finalTextOrOptions.finalText;
      thinking = finalTextOrOptions.thinking;
      stats = finalTextOrOptions.stats;
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
      await this._updateElementRaw("thinking_content", thinkingText);
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
            Authorization: `Bearer ${await getToken(this.creds)}`,
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

    // Replace with static card — thinking panel collapsed
    try {
      const finalCard = buildFinalCard({ text, thinking: thinkingText, stats });
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
