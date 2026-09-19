import { isCompactionOutput } from "@shared/contracts/compaction.js";

const providerHttp5xxRe = /(^|[^0-9])5[0-9][0-9]([^0-9]|$)/;

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
  const lower = trimmed.toLowerCase();

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

  if (containsAny(
    lower,
    "401",
    "403",
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

  if (containsAny(
    lower,
    "402",
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
  // MUL-336 switches models on, so it must be recognised BEFORE the generic
  // 5xx rule — "503 No available accounts" would otherwise degrade into an
  // ambiguous provider_server_error and never trigger a fallback. The phrases
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

  if (containsAny(lower, "429", "rate limit", "overloaded", "529", "no capacity available")) {
    return TaskFailureReason.AgentProviderCapacityOrRateLimit;
  }

  if (
    containsAny(lower, "server had an error", "provider returned error", "internal error", "service unavailable", "bad gateway") ||
    providerHttp5xxRe.test(lower)
  ) {
    return TaskFailureReason.AgentProviderServerError;
  }

  if (containsAny(lower, "stream disconnected", "error sending request", "unable to connect", "dial tcp", "connection refused", "connectionrefused", "dns", "i/o timeout")) {
    return TaskFailureReason.AgentProviderNetwork;
  }

  if (
    (lower.includes("model") && lower.includes("not found")) ||
    containsAny(lower, "unknown model", "selected model", "http 404", "404 page not found")
  ) {
    return TaskFailureReason.AgentModelNotFoundOrUnavailable;
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

export function classifyDaemonTaskFailure(provider: string, error: string): TaskFailureReasonValue {
  return classifyPoisonedError(error)
    ?? classifyResumeUnsafeTimeout(provider, error)
    ?? classifyTaskFailure(error);
}

function containsAny(value: string, ...needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
