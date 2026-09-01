/**
 * Redacted diagnostics for the Workspace Feishu bot (MUL-206).
 *
 * Everything a browser or an audit event can see about a failure goes through
 * here. The vocabulary is closed: a Runtime cannot invent a new `error_code`,
 * and free-text detail is both length-capped and stripped of anything that
 * looks like a credential, so a connector stack trace containing an app secret
 * cannot reach the settings page.
 */

import type { FeishuBotErrorCode } from "@multiremi/contracts/types.js";
import { redactNotificationError } from "@multiremi/notifications/error-redaction.js";

const ERROR_CODES: ReadonlySet<FeishuBotErrorCode> = new Set<FeishuBotErrorCode>([
  "invalid_credentials",
  "insufficient_permissions",
  "agent_unavailable",
  "runtime_unavailable",
  "connector_start_failed",
  "network_unreachable",
  "unknown",
]);

const MAX_ERROR_MESSAGE_LENGTH = 300;

// Feishu app ids and secrets are stable shapes; matching them directly means a
// message is scrubbed even when the value never passed through an env var (for
// example a secret typed into the test form and echoed back by the platform).
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bcli_[A-Za-z0-9]{8,}\b/gu,
  /\bcli-[A-Za-z0-9]{8,}\b/gu,
  /\b[A-Za-z0-9]{28,}\b/gu,
];

export function normalizeFeishuBotErrorCode(value: unknown): FeishuBotErrorCode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return ERROR_CODES.has(trimmed as FeishuBotErrorCode) ? (trimmed as FeishuBotErrorCode) : "unknown";
}

/**
 * Reduce arbitrary error text to something safe to persist and display.
 * `secrets` are the plaintext values in play for this operation; they are
 * removed even if they never appear in the process environment.
 */
export function redactFeishuBotError(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  const raw = redactNotificationError(error, process.env, secrets.filter((value) => value.length >= 6));
  let message = raw.replace(/\s+/gu, " ").trim();
  for (const shape of CREDENTIAL_SHAPES) message = message.replace(shape, "***");
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

/** Map a Feishu open-platform response code to the closed vocabulary. */
export function feishuBotErrorCodeForOpenApi(code: number): FeishuBotErrorCode {
  // 10003/10012/10013 cover the app-id/app-secret rejection family; 99991663 is
  // "app ticket invalid", which in practice also means the credentials are wrong.
  if (code === 10003 || code === 10012 || code === 10013 || code === 99991663) return "invalid_credentials";
  if (code === 99991672 || code === 99991679 || code === 19001) return "insufficient_permissions";
  return "unknown";
}
