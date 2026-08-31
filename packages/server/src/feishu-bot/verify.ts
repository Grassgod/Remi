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
