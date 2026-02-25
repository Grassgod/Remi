/**
 * Feishu/Lark SDK client factory.
 * Adapted from OpenClaw feishu extension client.ts — stripped multi-account caching.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuDomain, FeishuProbeResult } from "./types.js";

type Credentials = {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
};

let cachedClient: { client: Lark.Client; key: string } | null = null;

function resolveDomain(domain: FeishuDomain | undefined): Lark.Domain | string {
  if (domain === "lark") return Lark.Domain.Lark;
  if (domain === "feishu" || !domain) return Lark.Domain.Feishu;
  return domain.replace(/\/+$/, "");
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
    domain: resolveDomain(creds.domain),
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
    domain: resolveDomain(creds.domain),
    loggerLevel: Lark.LoggerLevel.info,
  });
}

/** Create an event dispatcher for encrypting/verifying webhook events. */
export function createEventDispatcher(creds: {
  encryptKey?: string;
  verificationToken?: string;
}): Lark.EventDispatcher {
  return new Lark.EventDispatcher({
    encryptKey: creds.encryptKey ?? "",
    verificationToken: creds.verificationToken ?? "",
  });
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

/** Resolve API base URL from domain. */
export function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

/** Resolve receive_id_type from ID prefix. */
export function resolveReceiveIdType(id: string): "chat_id" | "open_id" | "user_id" {
  const trimmed = id.trim();
  if (trimmed.startsWith("oc_")) return "chat_id";
  if (trimmed.startsWith("ou_")) return "open_id";
  return "user_id";
}
