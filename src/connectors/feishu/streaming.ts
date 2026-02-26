/**
 * Feishu streaming card session for real-time AI response updates.
 * Adapted from OpenClaw feishu extension streaming-card.ts — zero OpenClaw dependency.
 *
 * Flow: AI starts → create streaming card → throttled updates → close card
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuDomain } from "./types.js";
import { resolveApiBase } from "./client.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = { cardId: string; messageId: string; sequence: number; currentText: string; currentThinking: string };

export interface StreamingCloseOptions {
  finalText?: string;
  thinking?: string | null;
  stats?: string | null;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const res = await fetch(`${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
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

export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private updateThrottleMs = 100;

  constructor(client: Client, creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log;
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
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 2 } },
      },
      body: {
        elements: [
          {
            tag: "collapsible_panel",
            expanded: false,
            background_style: "default",
            header: { title: { tag: "plain_text", content: "💭 Thinking..." } },
            vertical_spacing: "2px",
            element_id: "thinking_panel",
            elements: [
              { tag: "markdown", content: "", element_id: "thinking_content" },
            ],
          },
          { tag: "markdown", content: "Thinking...", element_id: "content" },
          { tag: "hr", element_id: "stats_hr" },
          {
            tag: "note",
            element_id: "stats",
            elements: [
              { tag: "plain_text", content: "", element_id: "stats_text" },
            ],
          },
        ],
      },
    };

    const createRes = await fetch(`${apiBase}/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getToken(this.creds)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
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

    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Reply to original message if specified, otherwise send as new message
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

    this.state = { cardId, messageId: sendRes.data.message_id, sequence: 1, currentText: "", currentThinking: "" };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  async updateElement(elementId: string, content: string): Promise<void> {
    if (!this.state || this.closed) return;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return;
      this.state.sequence += 1;
      const apiBase = resolveApiBase(this.creds.domain);
      await fetch(`${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}/content`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        }),
      }).catch((e) => this.log?.(`Update ${elementId} failed: ${String(e)}`));
    });
    await this.queue;
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) return;

    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = text;
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;

    this.state.currentText = text;
    await this.updateElement("content", text);
  }

  async updateThinking(text: string): Promise<void> {
    if (!this.state || this.closed) return;
    this.state.currentThinking = text;
    await this.updateElement("thinking_content", text);
  }

  async close(finalTextOrOptions?: string | StreamingCloseOptions): Promise<void> {
    if (!this.state || this.closed) return;
    this.closed = true;
    await this.queue;

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

    const text = finalText ?? this.pendingText ?? this.state.currentText;
    const thinkingText = thinking ?? this.state.currentThinking;
    const apiBase = resolveApiBase(this.creds.domain);

    // Build final card elements
    const elements: Array<Record<string, unknown>> = [];

    // Only include thinking panel if there's thinking content
    if (thinkingText) {
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        background_style: "default",
        header: { title: { tag: "plain_text", content: "💭 Thinking" } },
        vertical_spacing: "2px",
        element_id: "thinking_panel",
        elements: [
          { tag: "markdown", content: thinkingText, element_id: "thinking_content" },
        ],
      });
    }

    // Main content
    elements.push({ tag: "markdown", content: text, element_id: "content" });

    // Stats footer
    if (stats) {
      elements.push({ tag: "hr", element_id: "stats_hr" });
      elements.push({
        tag: "note",
        element_id: "stats",
        elements: [
          { tag: "plain_text", content: stats, element_id: "stats_text" },
        ],
      });
    }

    // Update the full card with final content + close streaming
    this.state.sequence += 1;
    await fetch(`${apiBase}/cardkit/v1/cards/${this.state.cardId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await getToken(this.creds)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        card: JSON.stringify({
          schema: "2.0",
          config: {
            streaming_mode: false,
            summary: { content: truncateSummary(text) },
          },
          body: { elements },
        }),
        sequence: this.state.sequence,
        uuid: `c_${this.state.cardId}_${this.state.sequence}`,
      }),
    }).catch((e) => this.log?.(`Close failed: ${String(e)}`));

    this.log?.(`Closed streaming: cardId=${this.state.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  getMessageId(): string | null {
    return this.state?.messageId ?? null;
  }
}
