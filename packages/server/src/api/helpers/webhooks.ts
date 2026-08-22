// Inbound webhook plumbing: the size-capped raw body reader, HMAC signature verification and the
// in-memory per-workspace / per-IP rate limiters.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isObjectRecord } from "../wire/index.js";
import type {
  MultiremiWebhookProvider,
  MultiremiWebhookSignatureStatus,
  RunAutopilotInput,
} from "@multiremi/contracts/types.js";
import { stripUtf8Bom } from "./common.js";
import { remoteAddrHost, requestRemoteAddress } from "./request.js";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export const DEFAULT_WEBHOOK_RATE_LIMIT: WebhookRateLimitConfig = { limit: 60, windowMs: 60 * 1000 };

export const DEFAULT_WEBHOOK_IP_RATE_LIMIT: WebhookRateLimitConfig = { limit: 30, windowMs: 60 * 1000 };

export interface WebhookRateLimitConfig {
  limit: number;
  windowMs: number;
}

export type LimitedRequestBody =
  | { bytes: Uint8Array }
  | { apiError: "failed to read request body" | "payload too large"; statusCode: 400 | 413 };

const webhookClientIps = new WeakMap<Request, string>();

/** Record Bun's socket address before the Request enters Hono. */
export function setWebhookClientIpAddress(request: Request, address: string | null | undefined): void {
  const host = remoteAddrHost(String(address ?? "").trim());
  if (isIP(host)) webhookClientIps.set(request, host);
}

/** Resolve proxy headers only when the immediate peer is trusted. */
export function resolveWebhookClientIpAddress(
  request: Request,
  socketAddress: string | null | undefined,
  trustedProxyIps = process.env.MULTIREMI_TRUSTED_PROXY_IPS ?? "",
): string {
  const socketHost = remoteAddrHost(String(socketAddress ?? "").trim());
  if (!isIP(socketHost)) return "";
  if (!isTrustedWebhookProxy(socketHost, trustedProxyIps)) return socketHost;

  // nginx-remi.conf overwrites X-Real-IP with the direct client address, while an inbound
  // X-Forwarded-For value may already contain caller-controlled entries.
  const forwarded = request.headers.get("x-real-ip")?.trim()
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "";
  const forwardedHost = remoteAddrHost(forwarded.replace(/^"|"$/gu, ""));
  return isIP(forwardedHost) ? forwardedHost : socketHost;
}

/** Read at most maxBytes without first buffering an unbounded request body. */
export async function readRequestBodyLimited(request: Request, maxBytes: number): Promise<LimitedRequestBody> {
  const limit = Math.max(0, Math.floor(maxBytes));
  const declaredLength = request.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/u.test(declaredLength) && Number(declaredLength) > limit) {
    try {
      await request.body?.cancel();
    } catch {
      // The response is still 413 if the peer closes while its body is cancelled.
    }
    return { apiError: "payload too large", statusCode: 413 };
  }

  if (!request.body) return { bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // Limit enforcement has already succeeded; cancellation is best effort.
        }
        return { apiError: "payload too large", statusCode: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { apiError: "failed to read request body", statusCode: 400 };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

export async function readPublicWebhookBody(c: {
  req: {
    raw: Request;
  };
}): Promise<{
  rawBody: string;
  body: (RunAutopilotInput & { payload?: unknown }) | unknown[];
} | { apiError: string; statusCode: 400 | 413 }> {
  const result = await readRequestBodyLimited(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
  if ("apiError" in result) return result;
  const rawBody = Buffer.from(result.bytes).toString("utf8");
  const bodyText = stripUtf8Bom(rawBody);
  if (!bodyText.trim()) return { apiError: "empty body", statusCode: 400 };
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { apiError: `invalid json: ${message}`, statusCode: 400 };
  }
  if (!isObjectRecord(body) && !Array.isArray(body)) {
    return { apiError: "body must be a JSON object or array", statusCode: 400 };
  }
  return {
    rawBody,
    body: body as (RunAutopilotInput & { payload?: unknown }) | unknown[],
  };
}

export function createWebhookRateLimiter(
  override: Partial<WebhookRateLimitConfig> | false | undefined,
  defaults: WebhookRateLimitConfig,
): MemoryWebhookRateLimiter {
  const config = override === false ? { limit: 0, windowMs: defaults.windowMs } : { ...defaults, ...(override ?? {}) };
  return new MemoryWebhookRateLimiter(config);
}

export class MemoryWebhookRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly config: WebhookRateLimitConfig) {}

  allow(key: string): boolean {
    if (this.config.limit <= 0) return true;
    const now = Date.now();
    const cutoff = now - Math.max(1, this.config.windowMs);
    const kept = (this.hits.get(key) ?? []).filter((hit) => hit > cutoff);
    if (kept.length >= this.config.limit) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    return true;
  }
}

export function webhookClientIpKey(request: Request): string {
  const remote = webhookClientIps.get(request) ?? requestRemoteAddress(request);
  return remoteAddrHost(remote) || "unknown";
}

function isTrustedWebhookProxy(socketHost: string, configured: string): boolean {
  const normalized = socketHost.toLowerCase();
  if (
    normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.")
  ) return true;
  return configured
    .split(",")
    .map((value) => remoteAddrHost(value.trim()).toLowerCase())
    .filter((value) => Boolean(isIP(value)))
    .includes(normalized);
}

export function webhookSignatureStatus(
  provider: MultiremiWebhookProvider,
  headers: Record<string, string>,
  rawBody: string,
  signingSecret?: string | null,
): MultiremiWebhookSignatureStatus {
  const secret = signingSecret === undefined ? process.env.MULTIREMI_WEBHOOK_SECRET ?? "" : signingSecret ?? "";
  if (!secret) return "not_required";
  const signature = headers["x-hub-signature-256"] ?? "";
  if (!signature) return "missing";
  return verifyWebhookSignature(secret, signature, rawBody) ? "valid" : "invalid";
}

export function verifyWebhookSignature(secret: string, signature: string, rawBody: string): boolean {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const actualHex = signature.slice(prefix.length);
  if (!/^[0-9a-fA-F]+$/.test(actualHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
