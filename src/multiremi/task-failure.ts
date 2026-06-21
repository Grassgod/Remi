const providerHttp5xxRe = /(^|[^0-9])5[0-9][0-9]([^0-9]|$)/;

const codexSemanticInactivityMarker = "codex semantic inactivity timeout";
const codexFirstTurnNoProgressMarker = "codex app-server no progress timeout";
const poisonedOutputMaxLen = 320;

export const TaskFailureReason = {
  QueuedExpired: "queued_expired",
  RuntimeOffline: "runtime_offline",
  RuntimeRecovery: "runtime_recovery",
  Timeout: "timeout",
  IterationLimit: "iteration_limit",
  AgentBlocked: "agent_blocked",
  ApiInvalidRequest: "api_invalid_request",
  AgentFallbackMessage: "agent_fallback_message",
  CodexSemanticInactivity: "codex_semantic_inactivity",
  AgentProviderAuthOrAccess: "agent_error.provider_auth_or_access",
  AgentProviderQuotaLimit: "agent_error.provider_quota_limit",
  AgentProviderCapacityOrRateLimit: "agent_error.provider_capacity_or_rate_limit",
  AgentProviderServerError: "agent_error.provider_server_error",
  AgentProviderNetwork: "agent_error.provider_network",
  AgentProcessFailure: "agent_error.process_failure",
  AgentEmptyOrUnparseableOutput: "agent_error.empty_or_unparseable_output",
  AgentTimeout: "agent_error.agent_timeout",
  AgentContextOverflow: "agent_error.context_overflow",
  AgentMissingConfig: "agent_error.missing_config",
  AgentModelNotFoundOrUnavailable: "agent_error.model_not_found_or_unavailable",
  AgentRuntimeVersionUnsupported: "agent_error.runtime_version_unsupported",
  AgentRuntimeMissingExecutable: "agent_error.runtime_missing_executable",
  AgentUnknown: "agent_error.unknown",
} as const;

export type TaskFailureReasonValue = typeof TaskFailureReason[keyof typeof TaskFailureReason];

export function classifyTaskFailure(rawError: string): TaskFailureReasonValue {
  const trimmed = String(rawError ?? "").trim();
  if (!trimmed) return TaskFailureReason.AgentUnknown;
  const lower = trimmed.toLowerCase();

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
