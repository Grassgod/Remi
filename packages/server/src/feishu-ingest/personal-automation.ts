import { createHash } from "node:crypto";
import type { MultiremiFeishuAllowlistEntry } from "@multiremi/contracts/types.js";
import type { IngestedFeishuMessageInput } from "@multiremi/store/repos/feishu-ingest-repo.js";
import type { FeishuPollContext, FeishuPollPage, FeishuSourceAdapter } from "./types.js";

const MAX_CHAT_IDS_PER_REQUEST = 20;
const MAX_RETRIES = 2;

interface PersonalAutomationMessage {
  message_id?: unknown;
  root_id?: unknown;
  parent_id?: unknown;
  thread_id?: unknown;
  chat_id?: unknown;
  chat_type?: unknown;
  chat_name?: unknown;
  sender?: unknown;
  text?: unknown;
  create_time?: unknown;
  update_time?: unknown;
  message_app_link?: unknown;
  deleted?: unknown;
  [key: string]: unknown;
}

interface PersonalAutomationResponse {
  ok?: unknown;
  data?: unknown;
  error?: { code?: unknown; retryable?: unknown } | null;
}

interface PersonalAutomationPageCursor {
  chunkIndex: number;
  pageToken: string | null;
  allowlistKey: string;
}

export interface PersonalAutomationFeishuAdapterOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class PersonalAutomationFeishuAdapter implements FeishuSourceAdapter {
  readonly type = "personal_automation" as const;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PersonalAutomationFeishuAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async poll(context: FeishuPollContext): Promise<FeishuPollPage> {
    const entries = [...context.source.allowlist].sort((left, right) => left.chatId.localeCompare(right.chatId));
    if (entries.length === 0) return { messages: [], cursor: null, done: true };
    const chunks = chunk(entries, MAX_CHAT_IDS_PER_REQUEST);
    const allowlistKey = createHash("sha256")
      .update(entries.map((entry) => `${entry.chatId}\0${entry.addedAt}`).join("\n"))
      .digest("hex");
    const stored = pageCursor(context.cursor);
    const cursor = stored?.allowlistKey === allowlistKey
      ? stored
      : { chunkIndex: 0, pageToken: null, allowlistKey };
    const selected = chunks[cursor.chunkIndex];
    if (!selected) return { messages: [], cursor: null, done: true };

    const response = await this.request(context, {
      version: "v1",
      action: "message.search",
      input: {
        query: "",
        chat_ids: selected.map((entry) => entry.chatId),
        start: context.start.toISOString(),
        end: context.end.toISOString(),
        page_limit: 10,
        page_token: cursor.pageToken ?? "",
      },
    });
    const data = record(response.data);
    const rawMessages = Array.isArray(data?.messages) ? data.messages : [];
    const watermarkByChat = new Map(selected.map((entry) => [entry.chatId, entry.addedAt]));
    const messages = rawMessages.flatMap((value) => {
      const normalized = normalizeMessage(value, watermarkByChat);
      return normalized ? [normalized] : [];
    });
    const nextPageToken = stringValue(data?.next_page_token);
    if (nextPageToken) {
      return {
        messages,
        cursor: { chunkIndex: cursor.chunkIndex, pageToken: nextPageToken, allowlistKey },
        done: false,
      };
    }
    if (cursor.chunkIndex + 1 < chunks.length) {
      return {
        messages,
        cursor: { chunkIndex: cursor.chunkIndex + 1, pageToken: null, allowlistKey },
        done: false,
      };
    }
    return { messages, cursor: null, done: true };
  }

  private async request(context: FeishuPollContext, body: Record<string, unknown>): Promise<PersonalAutomationResponse> {
    const endpoint = agentEndpoint(context.endpoint);
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        context.heartbeat?.();
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
        const response = await this.fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal,
          redirect: "error",
        });
        if (!response.ok) {
          if (attempt < MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
            await this.sleep(250 * (2 ** attempt));
            continue;
          }
          throw new PersonalAutomationFeishuError(`sidecar_http_${response.status}`, response.status >= 500 || response.status === 429);
        }
        let payload: PersonalAutomationResponse;
        try {
          payload = await response.json() as PersonalAutomationResponse;
        } catch {
          throw new PersonalAutomationFeishuError("sidecar_invalid_json", false);
        }
        if (payload.ok !== true) {
          const code = safeErrorCode(payload.error?.code);
          const retryable = payload.error?.retryable === true;
          if (attempt < MAX_RETRIES && retryable) {
            await this.sleep(250 * (2 ** attempt));
            continue;
          }
          throw new PersonalAutomationFeishuError(code, retryable);
        }
        return payload;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof PersonalAutomationFeishuError ? error.retryable : true;
        if (attempt >= MAX_RETRIES || !retryable) break;
        await this.sleep(250 * (2 ** attempt));
      }
    }
    if (lastError instanceof PersonalAutomationFeishuError) throw lastError;
    throw new PersonalAutomationFeishuError("sidecar_unreachable", true);
  }
}

export class PersonalAutomationFeishuError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(`Feishu sidecar request failed (${code})`);
  }
}

function normalizeMessage(
  value: unknown,
  watermarkByChat: ReadonlyMap<string, string>,
): IngestedFeishuMessageInput | null {
  const message = record(value) as PersonalAutomationMessage | null;
  if (!message) return null;
  const messageId = stringValue(message?.message_id);
  const chatId = stringValue(message?.chat_id);
  const createdAt = timestampValue(message?.create_time);
  const addedAt = watermarkByChat.get(chatId);
  if (!messageId || !chatId || !createdAt || !addedAt) return null;
  // The stable sidecar view omits timestamp precision. Skip the whole activation
  // minute so a minute-precision search result can never predate consent.
  if (truncateMinute(createdAt) <= truncateMinute(addedAt)) return null;
  const content = message as Record<string, unknown>;
  return {
    messageId,
    chatId,
    chatType: stringValue(message.chat_type) || null,
    chatName: stringValue(message.chat_name) || null,
    threadId: stringValue(message.thread_id) || null,
    rootId: stringValue(message.root_id) || null,
    parentId: stringValue(message.parent_id) || null,
    sender: record(message.sender) ?? {},
    content,
    searchableText: stringValue(message.text),
    contentFingerprint: createHash("sha256").update(stableJson(content)).digest("hex"),
    messageAppLink: stringValue(message.message_app_link) || null,
    createdAt,
    updatedAt: timestampValue(message.update_time),
    recalled: message.deleted === true,
  };
}

function agentEndpoint(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/api/agent/feishu")) {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/api/agent/feishu`;
  }
  return url.toString();
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function pageCursor(value: Record<string, unknown> | null): PersonalAutomationPageCursor | null {
  if (!value) return null;
  const chunkIndex = Number(value.chunkIndex);
  const allowlistKey = stringValue(value.allowlistKey);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !allowlistKey) return null;
  return { chunkIndex, pageToken: stringValue(value.pageToken) || null, allowlistKey };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeErrorCode(value: unknown): string {
  const code = stringValue(value).toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/u.test(code) ? code : "sidecar_error";
}

function timestampValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function truncateMinute(value: string): number {
  const parsed = Date.parse(value);
  return Math.floor(parsed / 60_000);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
