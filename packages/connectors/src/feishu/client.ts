/**
 * Feishu/Lark SDK client factory.
 * Adapted from OpenClaw feishu extension client.ts — stripped multi-account caching.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { resolveApiOrigin } from "@shared/feishu-domain.js";
import type { FeishuDomain, FeishuProbeResult } from "./types.js";

type Credentials = {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
};

let cachedClient: { client: Lark.Client; key: string } | null = null;

export function resolveLarkSdkDomain(domain?: FeishuDomain): Lark.Domain | string {
  if (domain === "lark") return Lark.Domain.Lark;
  if (domain === "feishu" || !domain) return Lark.Domain.Feishu;
  return resolveApiOrigin(domain);
}

/** Create or get a cached Feishu HTTP client. */
export function createFeishuClient(creds: Credentials): Lark.Client {
  const key = `${creds.appId}:${creds.domain ?? "feishu"}`;
  if (cachedClient && cachedClient.key === key) {
    return cachedClient.client;
  }

  const client = new Lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveLarkSdkDomain(creds.domain),
  });

  cachedClient = { client, key };
  return client;
}

/** Create a new WebSocket client (not cached — each creates a connection). */
export function createFeishuWSClient(creds: Credentials): Lark.WSClient {
  if (!creds.appId || !creds.appSecret) {
    throw new Error("Feishu credentials not configured");
  }

  return new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    domain: resolveLarkSdkDomain(creds.domain),
    loggerLevel: Lark.LoggerLevel.info,
  });
}

type FeishuWSClientInternals = {
  wsConfig?: {
    getWSInstance?: () => { readyState?: number } | null;
  };
};

/**
 * The SDK's start() resolves before its initial WebSocket handshake. Keep the
 * version-specific readiness probe isolated here so callers cannot mistake a
 * scheduled connection attempt for an online connector.
 */
export async function waitForFeishuWSReady(
  client: Lark.WSClient,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const wsConfig = (client as unknown as FeishuWSClientInternals).wsConfig;
  if (typeof wsConfig?.getWSInstance !== "function") {
    throw new Error("Feishu SDK does not expose WebSocket readiness state");
  }

  const deadline = Date.now() + timeoutMs;
  do {
    if (wsConfig.getWSInstance()?.readyState === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);

  throw new Error(`Feishu WebSocket did not connect within ${timeoutMs}ms`);
}

/**
 * Create an event dispatcher for WS long-connection mode.
 * Per Feishu docs, encryptKey and verificationToken MUST be empty strings
 * for long-connection mode — passing actual values causes card callbacks
 * (card.action.trigger) to fail verification and be silently dropped.
 */
export function createEventDispatcher(_creds?: {
  encryptKey?: string;
  verificationToken?: string;
}): Lark.EventDispatcher {
  return new Lark.EventDispatcher({});
}

/** Probe the bot info to get botOpenId. Cached for 15 min. */
const probeCache = new Map<string, { result: FeishuProbeResult; ts: number }>();
const PROBE_TTL_MS = 15 * 60 * 1000;

export async function probeFeishu(creds: Credentials): Promise<FeishuProbeResult> {
  if (!creds.appId || !creds.appSecret) {
    return { ok: false, error: "missing credentials" };
  }

  const key = `${creds.appId}:${creds.domain ?? "feishu"}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.ts < PROBE_TTL_MS) {
    return cached.result;
  }

  try {
    const client = createFeishuClient(creds);
    const response = await (client as any).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    if (response.code !== 0) {
      const result: FeishuProbeResult = {
        ok: false,
        appId: creds.appId,
        error: `API error: ${response.msg || `code ${response.code}`}`,
      };
      probeCache.set(key, { result, ts: Date.now() });
      return result;
    }

    const bot = response.bot || response.data?.bot;
    const result: FeishuProbeResult = {
      ok: true,
      appId: creds.appId,
      botName: bot?.bot_name,
      botOpenId: bot?.open_id,
    };
    probeCache.set(key, { result, ts: Date.now() });
    return result;
  } catch (err) {
    const result: FeishuProbeResult = {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
    probeCache.set(key, { result, ts: Date.now() });
    return result;
  }
}

/** Resolve receive_id_type from ID prefix. */
export function resolveReceiveIdType(id: string): "chat_id" | "open_id" | "user_id" {
  const trimmed = id.trim();
  if (trimmed.startsWith("oc_")) return "chat_id";
  if (trimmed.startsWith("ou_")) return "open_id";
  return "user_id";
}
