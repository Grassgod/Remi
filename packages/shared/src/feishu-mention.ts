import type { FeishuBotOutboundMention } from "@multiremi/contracts/types.js";

export function isFeishuOpenId(value: unknown): value is string {
  return typeof value === "string" && /^ou_[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Fail closed at the API boundary: unknown policies never become group_owner. */
export function parseOutboundMention(value: unknown): FeishuBotOutboundMention | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!["group_owner", "person", "none"].includes(String(raw.mode))) return undefined;
  if (raw.mode === "person" && !isFeishuOpenId(raw.openId)) return undefined;
  if (raw.resolvedOpenId !== undefined && raw.resolvedOpenId !== null && !isFeishuOpenId(raw.resolvedOpenId)) return undefined;
  return {
    mode: raw.mode as FeishuBotOutboundMention["mode"],
    ...(raw.mode === "person" ? { openId: raw.openId as string } : {}),
    ...(raw.resolvedOpenId !== undefined ? { resolvedOpenId: raw.resolvedOpenId as string | null } : {}),
  };
}
