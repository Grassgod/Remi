import type { FeishuSidecarEndpointRegistry } from "./endpoints.js";

/** A chat the operator may add to a source allowlist. Resolved server-side from a
 *  registered sidecar endpoint name — the browser never supplies a URL. */
export interface FeishuCandidateChat {
  chatId: string;
  name: string | null;
  type: "group" | "p2p";
  memberCount: number | null;
  external: boolean;
  description: string | null;
}

export type FeishuChatDirectoryScope = "group" | "person";

export interface FeishuChatDirectorySearchInput {
  endpointName: string;
  scope: FeishuChatDirectoryScope;
  query: string;
  limit: number;
}

export interface FeishuChatDirectoryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Sanitized failure. `code` is a fixed vocabulary; it never carries the endpoint
 *  URL, the sidecar's raw message, or any credential material. */
export class FeishuChatDirectoryError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 502 | 504) {
    super(`Feishu chat directory lookup failed (${code})`);
  }
}

export const FEISHU_CHAT_QUERY_MAX_LENGTH = 50;
export const FEISHU_CHAT_SEARCH_MAX_RESULTS = 50;

const DEFAULT_TIMEOUT_MS = 5_000;
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]{1,120}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

export class FeishuChatDirectory {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly registry: FeishuSidecarEndpointRegistry,
    options: FeishuChatDirectoryOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async search(input: FeishuChatDirectorySearchInput): Promise<FeishuCandidateChat[]> {
    const endpoint = this.registry.get(input.endpointName);
    if (!endpoint) throw new FeishuChatDirectoryError("endpoint_not_configured", 400);
    const payload = await this.request(endpoint, {
      version: "v1",
      action: "target.search",
      input: { scope: input.scope, query: input.query },
    });
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const limit = Math.min(input.limit, FEISHU_CHAT_SEARCH_MAX_RESULTS);
    const chats: FeishuCandidateChat[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const chat = normalizeCandidate(target, input.scope);
      if (!chat || seen.has(chat.chatId)) continue;
      seen.add(chat.chatId);
      chats.push(chat);
      if (chats.length >= limit) break;
    }
    return chats;
  }

  private async request(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchFn(agentEndpoint(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      if (isAbort(error)) throw new FeishuChatDirectoryError("timeout", 504);
      throw new FeishuChatDirectoryError("sidecar_unreachable", 502);
    }
    if (!response.ok) throw new FeishuChatDirectoryError(`sidecar_http_${response.status}`, 502);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new FeishuChatDirectoryError("sidecar_invalid_json", 502);
    }
    const envelope = record(parsed);
    if (!envelope) throw new FeishuChatDirectoryError("sidecar_invalid_json", 502);
    if (envelope.ok !== true) {
      const code = safeErrorCode(record(envelope.error)?.code);
      // "no verified target" is an empty result for a picker, not a failure.
      if (code === "not_found") return { targets: [] };
      throw new FeishuChatDirectoryError(`sidecar_${code}`, 502);
    }
    return record(envelope.data) ?? {};
  }
}

/** `q` is forwarded to the sidecar, so it is validated here rather than trusted. */
export function normalizeFeishuChatQuery(value: string | undefined): string {
  const query = (value ?? "").trim();
  if (!query) throw new FeishuChatDirectoryError("query_required", 400);
  if ([...query].length > FEISHU_CHAT_QUERY_MAX_LENGTH) throw new FeishuChatDirectoryError("query_too_long", 400);
  if (CONTROL_CHARACTERS.test(query)) throw new FeishuChatDirectoryError("query_invalid", 400);
  return query;
}

export function normalizeFeishuChatScope(value: string | undefined): FeishuChatDirectoryScope {
  const scope = (value ?? "group").trim().toLowerCase();
  if (scope === "group" || scope === "person") return scope;
  throw new FeishuChatDirectoryError("scope_invalid", 400);
}

function normalizeCandidate(value: unknown, scope: FeishuChatDirectoryScope): FeishuCandidateChat | null {
  const target = record(value);
  if (!target) return null;
  // A person resolves to a chat only when a 1:1 conversation already exists.
  const chatId = stringValue(scope === "group" ? target.target_id : target.p2p_chat_id);
  if (!CHAT_ID_PATTERN.test(chatId)) return null;
  return {
    chatId,
    name: safeText(target.name, 128),
    type: scope === "group" ? "group" : "p2p",
    memberCount: safeCount(target.member_count),
    external: target.external === true,
    description: safeText(target.description, 256),
  };
}

function agentEndpoint(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/api/agent/feishu")) {
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/api/agent/feishu`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL_CHARACTERS_GLOBAL, " ").trim().slice(0, maxLength);
  return text ? text : null;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeErrorCode(value: unknown): string {
  const code = stringValue(value).toLowerCase();
  return /^[a-z0-9_.-]{1,64}$/u.test(code) ? code : "error";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
