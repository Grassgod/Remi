import { createHmac, timingSafeEqual } from "node:crypto";
import type { MultiremiIssueShare } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

export function signIssueShareId(id: string, secret: string): string {
  return `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
}

export function resolveActiveIssueShareToken(
  token: string,
  store: MultiremiStore,
  secret: string,
): MultiremiIssueShare | null {
  const separator = token.indexOf(".");
  if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return null;
  const id = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = createHmac("sha256", secret).update(id).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const share = store.getIssueShare(id);
  if (!share || share.revokedAt || Date.parse(share.expiresAt) <= Date.now()) return null;
  return share;
}
