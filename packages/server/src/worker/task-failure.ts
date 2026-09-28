import { isCompactionOutput } from "@shared/contracts/compaction.js";

const providerHttpStatusRe = /(?:^|[\s:()[\]{},."'])([45][0-9]{2})(?=$|[\s:()[\]{},."'])/g;

const codexSemanticInactivityMarker = "codex semantic inactivity timeout";
const codexFirstTurnNoProgressMarker = "codex app-server no progress timeout";
const poisonedOutputMaxLen = 320;

import {
  TaskFailureReason,
  type TaskFailureReasonValue,
} from "@shared/contracts/task-failure-reasons.js";

// Re-exported so the reason catalog keeps its historical import path here.
export {
  TaskFailureReason,
  MODEL_FALLBACK_FAILURE_REASONS,
  TRANSIENT_RETRY_FAILURE_REASONS,
} from "@shared/contracts/task-failure-reasons.js";
export type { TaskFailureReasonValue } from "@shared/contracts/task-failure-reasons.js";

export function classifyTaskFailure(rawError: string): TaskFailureReasonValue {
  const trimmed = String(rawError ?? "").trim();
  if (!trimmed) return TaskFailureReason.AgentUnknown;
  const lower = trimmed.toLowerCase()
    .replace(/\brequest[\s_-]*id\s*[:=]\s*["']?[a-z0-9_-]+["']?/g, "")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, "");
  const statuses = [...lower.matchAll(providerHttpStatusRe)].map((match) => Number(match[1]));

  // Repository preparation happens before the agent starts; these markers only
  // occur in repo cache/sync errors, which may embed network phrases ("connection
  // refused", "timed out after") that later rules would misattribute to the
  // agent or its provider. Check first: these are infrastructure failures and
  // are safe to auto-retry.
  if (containsAny(
    lower,
    "repository sync timed out",
    "repository sync failed",
    "repository sync aborted",
    "intake workspace requires a fresh repository snapshot",
    "repo not found in cache",
  )) {
    return TaskFailureReason.RepoSyncFailed;
  }

  if (containsAny(lower, "stale provider session", "no conversation found")) {
    return TaskFailureReason.AgentStaleSession;
  }

  if (
    containsAny(lower, "context length", "context_length_exceeded", "maximum context", "prompt is too long", "context size has been exceeded") ||
    (lower.includes("token") && lower.includes("limit"))
  ) {
    return TaskFailureReason.AgentContextOverflow;
  }

  if (
    lower.includes("missing environment variable") ||
    (lower.includes("missing") && lower.includes("api_key")) ||
    (lower.includes("api key") && lower.includes("required")) ||
    containsAny(lower, "no llm provider configured", "no provider configured")
  ) {
    return TaskFailureReason.AgentMissingConfig;
  }

  if (
    (lower.includes("model") && containsAny(lower, "not found", "not supported", "not available")) ||
    containsAny(lower, "issue with the selected model", "is not supported by any configured account",
      "unknown model", "model_not_found", "acp_model_unsupported", "cannot select model", "http 404", "404 page not found")
  ) {
    return TaskFailureReason.AgentModelNotFoundOrUnavailable;
  }

  if (statuses.some((status) => status === 401 || status === 403) || containsAny(
    lower,
    "unauthorized",
    "login required",
    "not logged in",
    "please login again",
    "refresh token",
    "invalid api key",
    "access token",
    "subscription access",
    "does not have access",
    "you may not have access",
  )) {
    return TaskFailureReason.AgentProviderAuthOrAccess;
  }

  if (statuses.includes(402) || containsAny(
    lower,
    "insufficient_balance",
    "balance is too low",
    "monthly usage limit",
    "usage limit",
    "you've hit your limit",
    "you\u2019ve hit your limit",
    "credits",
    "quota",
  )) {
    return TaskFailureReason.AgentProviderQuotaLimit;
  }

  // The gateway's account pool is empty for this model. This is the marker
  // MUL-336 introduced model switching for this marker; keep it BEFORE the
  // generic 5xx rule so the switch record retains the specific cause. The phrases
  // are deliberately account-pool specific: a bare 503 stays ambiguous.
  if (containsAny(
    lower,
    "no available accounts",
    "no available account",
    "no accounts available",
    "account pool exhausted",
    "no available channel",
    "无可用账号",
  )) {
    return TaskFailureReason.AgentProviderNoAvailableAccount;
  }

  if (statuses.some((status) => status === 429 || status === 529)
    || containsAny(lower, "rate limit", "overloaded", "no capacity available")) {
    return TaskFailureReason.AgentProviderCapacityOrRateLimit;
  }

  if (
    containsAny(lower, "server had an error", "provider returned error", "internal error", "service unavailable", "bad gateway") ||
    statuses.some((status) => status >= 500)
  ) {
    return TaskFailureReason.AgentProviderServerError;
  }

  if (containsAny(lower, "stream disconnected", "error sending request", "unable to connect", "dial tcp", "connection refused", "connectionrefused", "dns", "i/o timeout")) {
    return TaskFailureReason.AgentProviderNetwork;
  }

  if (containsAny(lower, "returned empty output", "returned no parseable output")) {
    return TaskFailureReason.AgentEmptyOrUnparseableOutput;
  }

  if (lower.includes("timed out after")) return TaskFailureReason.AgentTimeout;
  if (lower.includes("executable not found")) return TaskFailureReason.AgentRuntimeMissingExecutable;
  if (containsAny(lower, "below the minimum supported version", "requires a newer version")) {
    return TaskFailureReason.AgentRuntimeVersionUnsupported;
  }
  if (containsAny(lower, "exit status", "signal", "panic", "sigsegv", "process exited", "pipe has been ended", "file already closed", "initialize failed")) {
    return TaskFailureReason.AgentProcessFailure;
  }

  return TaskFailureReason.AgentUnknown;
}

export function classifyPoisonedOutput(output: string): TaskFailureReasonValue | null {
  const trimmed = String(output ?? "").trim();
  if (!trimmed || trimmed.length > poisonedOutputMaxLen) return null;
  if (isCompactionOutput(trimmed)) return TaskFailureReason.AgentFallbackMessage;
  const lower = trimmed.toLowerCase();
  if (lower.includes("i reached the iteration limit")) return TaskFailureReason.IterationLimit;
  if (lower.includes("put your final update inside the content string")) return TaskFailureReason.AgentFallbackMessage;
  return null;
}

export function classifyPoisonedError(error: string): TaskFailureReasonValue | null {
  const lower = String(error ?? "").toLowerCase();
  if (lower.includes("invalid_request_error") && lower.includes("400")) return TaskFailureReason.ApiInvalidRequest;
  return null;
}

export function classifyResumeUnsafeTimeout(provider: string, error: string): TaskFailureReasonValue | null {
  if (String(provider ?? "").trim().toLowerCase() !== "codex") return null;
  const lower = String(error ?? "").toLowerCase();
  if (lower.includes(codexSemanticInactivityMarker) || lower.includes(codexFirstTurnNoProgressMarker)) {
    return TaskFailureReason.CodexSemanticInactivity;
  }
  return null;
}

export interface TaskFailureHint {
  category?: string;
  errorKind?: string;
  codexErrorInfo?: unknown;
}

function classifyFailureHint(hint?: TaskFailureHint): TaskFailureReasonValue | null {
  const kind = hint?.errorKind;
  switch (kind) {
    case "model_not_found": return TaskFailureReason.AgentModelNotFoundOrUnavailable;
    case "authentication_error":
    case "authentication_failed":
    case "permission_denied": return TaskFailureReason.AgentProviderAuthOrAccess;
    case "billing_error": return TaskFailureReason.AgentProviderQuotaLimit;
    case "rate_limit":
    case "overloaded": return TaskFailureReason.AgentProviderCapacityOrRateLimit;
    case "server_error": return TaskFailureReason.AgentProviderServerError;
    case "invalid_request": return TaskFailureReason.ApiInvalidRequest;
  }
  if (hint?.codexErrorInfo != null) {
    const info = hint.codexErrorInfo;
    if (info === "contextWindowExceeded") return TaskFailureReason.AgentContextOverflow;
    if (info === "usageLimitExceeded") return TaskFailureReason.AgentProviderQuotaLimit;
    if (typeof info === "object" && !Array.isArray(info)) {
      const connection = (info as Record<string, unknown>).httpConnectionFailed;
      if (connection && typeof connection === "object") {
        const status = (connection as Record<string, unknown>).httpStatusCode;
        if (status === 404) return TaskFailureReason.AgentModelNotFoundOrUnavailable;
        if (typeof status === "number") {
          const reason = classifyTaskFailure(`HTTP ${status}`);
          if (reason !== TaskFailureReason.AgentUnknown) return reason;
        }
      }
    }
  }
  switch (hint?.category) {
    case "quota": return TaskFailureReason.AgentProviderQuotaLimit;
    case "authentication": return TaskFailureReason.AgentProviderAuthOrAccess;
    default: return null;
  }
}

export function classifyDaemonTaskFailure(provider: string, error: string, hint?: TaskFailureHint): TaskFailureReasonValue {
  return classifyFailureHint(hint)
    ?? classifyPoisonedError(error)
    ?? classifyResumeUnsafeTimeout(provider, error)
    ?? classifyTaskFailure(error);
}

/** Only old bridges expose a terminal failure as their final assistant message. */
export function classifyLegacyProviderFailure(output: string): TaskFailureReasonValue | null {
  const text = output.trim();
  if (text.length > 600 || !/^(unexpected status |stream disconnected|error sending request|exceeded retry limit)/i.test(text)) return null;
  const reason = classifyTaskFailure(text);
  return reason.startsWith("agent_error.provider_") || reason === TaskFailureReason.AgentModelNotFoundOrUnavailable
    ? reason : null;
}

function containsAny(value: string, ...needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
