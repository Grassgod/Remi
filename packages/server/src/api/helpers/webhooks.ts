// Inbound webhook plumbing: the size-capped raw body reader, HMAC signature verification and the
// in-memory per-workspace / per-IP rate limiters.
import { createHmac, timingSafeEqual } from "node:crypto";
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

export async function readPublicWebhookBody(c: {
  req: {
    raw: Request;
  };
}): Promise<{
  rawBody: string;
  body: (RunAutopilotInput & { payload?: unknown }) | unknown[];
} | { apiError: string; statusCode: 400 | 413 }> {
  let bytes: ArrayBuffer;
  try {
    bytes = await c.req.raw.arrayBuffer();
  } catch {
    return { apiError: "failed to read request body", statusCode: 400 };
  }
  if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) return { apiError: "payload too large", statusCode: 413 };
  const rawBody = Buffer.from(bytes).toString("utf8");
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
  const remote = requestRemoteAddress(request);
  return remoteAddrHost(remote) || "unknown";
}

export function webhookSignatureStatus(
  provider: MultiremiWebhookProvider,
  headers: Record<string, string>,
  rawBody: string,
  signingSecret?: string | null,
): MultiremiWebhookSignatureStatus {
  const secret = signingSecret === undefined ? process.env.MULTIREMI_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET ?? "" : signingSecret ?? "";
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
