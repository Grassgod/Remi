/**
 * "Test connection" for the Workspace Feishu bot (MUL-206).
 *
 * Exchanges the app id/secret for a tenant access token and reads the bot
 * profile, so the settings page can tell an admin *before* deploying whether
 * the credentials work and which bot they belong to.
 *
 * Nothing here persists or logs a credential: the caller passes plaintext in,
 * gets a profile or a redacted failure out.
 */

import type { FeishuBotDomain, FeishuBotErrorCode } from "@multiremi/contracts/types.js";
import { feishuBotErrorCodeForOpenApi, redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";

const REQUEST_TIMEOUT_MS = 10_000;

export interface FeishuBotVerifyInput {
  appId: string;
  appSecret: string;
  domain: FeishuBotDomain;
  /** Injected by tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface FeishuBotChat {
  chatId: string;
  name: string;
  memberCount: number | null;
  chatMode: string | null;
}

export class FeishuBotOpenApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "FeishuBotOpenApiError";
  }
}

export interface FeishuBotVerifyResult {
  ok: boolean;
  botName: string | null;
  botOpenId: string | null;
  appName: string | null;
  errorCode: FeishuBotErrorCode | null;
  errorMessage: string | null;
}

/** Same mapping the Feishu connector uses, kept local so server does not depend on connectors. */
export function feishuBotApiBase(domain: FeishuBotDomain): string {
  if (domain === "bytedance") return "https://fsopen.bytedance.net/open-apis";
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  return "https://open.feishu.cn/open-apis";
}

export async function verifyFeishuBotCredentials(input: FeishuBotVerifyInput): Promise<FeishuBotVerifyResult> {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  if (!appId || !appSecret) {
    return failure("invalid_credentials", "app_id and app_secret are both required");
  }
  const base = feishuBotApiBase(input.domain);
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;

  let token: string;
  try {
    const response = await withTimeout(
      (signal) => doFetch(`${base}/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal,
      }),
      timeoutMs,
    );
    const payload = await readJson(response);
    const code = Number(payload.code ?? -1);
    if (code !== 0) {
      return failure(
        feishuBotErrorCodeForOpenApi(code),
        `Feishu rejected the credentials (code ${code}): ${redactFeishuBotError(String(payload.msg ?? ""), [appSecret, appId])}`,
      );
    }
    token = String(payload.tenant_access_token ?? "");
    if (!token) return failure("invalid_credentials", "Feishu returned no tenant access token");
  } catch (error) {
    return failure("network_unreachable", redactFeishuBotError(error, [appSecret, appId]));
  }

  // The token proves the credentials; the profile is best-effort context. A bot
  // that has not been published yet answers with a non-zero code here while the
  // credentials themselves are perfectly valid, so this must not fail the test.
  try {
    const response = await withTimeout(
      (signal) => doFetch(`${base}/bot/v3/info`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      }),
      timeoutMs,
    );
    const payload = await readJson(response);
    if (Number(payload.code ?? -1) !== 0) {
      return { ok: true, botName: null, botOpenId: null, appName: null, errorCode: null, errorMessage: null };
    }
    const bot = isRecord(payload.bot) ? payload.bot : {};
    const appName = optionalString(bot.app_name);
    return {
      ok: true,
      botName: appName,
      botOpenId: optionalString(bot.open_id),
      appName,
      errorCode: null,
      errorMessage: null,
    };
  } catch {
    return { ok: true, botName: null, botOpenId: null, appName: null, errorCode: null, errorMessage: null };
  }
}

export async function listFeishuBotChats(input: FeishuBotVerifyInput): Promise<FeishuBotChat[]> {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  if (!appId || !appSecret) {
    throw new FeishuBotOpenApiError(
      "app_id and app_secret are both required",
      422,
      "credentials_unavailable",
    );
  }
  const base = feishuBotApiBase(input.domain);
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const token = await fetchTenantAccessToken({ appId, appSecret, base, doFetch, timeoutMs });
  const chats: FeishuBotChat[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`${base}/im/v1/chats`);
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    let payload: Record<string, unknown>;
    try {
      const response = await withTimeout(
        (signal) => doFetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal,
        }),
        timeoutMs,
      );
      payload = await readJson(response);
    } catch (error) {
      throw new FeishuBotOpenApiError(
        redactFeishuBotError(error, [appSecret, appId]),
        502,
        "network_unreachable",
      );
    }
    const code = Number(payload.code ?? -1);
    if (code !== 0) {
      const normalized = feishuBotErrorCodeForOpenApi(code);
      throw new FeishuBotOpenApiError(
        `Feishu chat listing failed (code ${code}): ${redactFeishuBotError(String(payload.msg ?? ""), [appSecret, appId])}`,
        normalized === "invalid_credentials" ? 422 : normalized === "insufficient_permissions" ? 403 : 502,
        normalized,
      );
    }
    const data = isRecord(payload.data) ? payload.data : {};
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const chatId = optionalString(item.chat_id);
      if (!chatId) continue;
      const memberCount = Number(item.member_count);
      chats.push({
        chatId,
        name: optionalString(item.name) ?? chatId,
        memberCount: Number.isSafeInteger(memberCount) && memberCount >= 0 ? memberCount : null,
        chatMode: optionalString(item.chat_mode),
      });
    }
    if (data.has_more !== true) break;
    const next = optionalString(data.page_token);
    if (!next || next === pageToken) break;
    pageToken = next;
  }
  return [...new Map(chats.map((chat) => [chat.chatId, chat])).values()];
}

async function fetchTenantAccessToken(input: {
  appId: string;
  appSecret: string;
  base: string;
  doFetch: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  try {
    const response = await withTimeout(
      (signal) => input.doFetch(`${input.base}/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
        signal,
      }),
      input.timeoutMs,
    );
    const payload = await readJson(response);
    const code = Number(payload.code ?? -1);
    if (code !== 0) {
      throw new FeishuBotOpenApiError(
        `Feishu rejected the credentials (code ${code}): ${redactFeishuBotError(String(payload.msg ?? ""), [input.appSecret, input.appId])}`,
        422,
        feishuBotErrorCodeForOpenApi(code),
      );
    }
    const token = String(payload.tenant_access_token ?? "");
    if (!token) {
      throw new FeishuBotOpenApiError("Feishu returned no tenant access token", 422, "invalid_credentials");
    }
    return token;
  } catch (error) {
    if (error instanceof FeishuBotOpenApiError) throw error;
    throw new FeishuBotOpenApiError(
      redactFeishuBotError(error, [input.appSecret, input.appId]),
      502,
      "network_unreachable",
    );
  }
}

function failure(errorCode: FeishuBotErrorCode, errorMessage: string): FeishuBotVerifyResult {
  return { ok: false, botName: null, botOpenId: null, appName: null, errorCode, errorMessage };
}

async function withTimeout(
  run: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}
