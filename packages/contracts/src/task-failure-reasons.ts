/**
 * Single source of truth for task failure reasons and the recovery policy that
 * keys off them (MUL-336).
 *
 * This lives in contracts — not in the worker or the store — because both
 * layers must agree on it: the worker classifies a raw provider error, the
 * store decides whether the resulting reason may retry the same model or spend
 * the recovery chain's single switch to the Agent's fallback model. Keeping the
 * strings in one place is what stops the two from drifting apart.
 *
 * Pure data: no imports, no side effects, safe for any layer.
 */
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
  AgentProviderNoAvailableAccount: "agent_error.provider_no_available_account",
  AgentProviderCapacityOrRateLimit: "agent_error.provider_capacity_or_rate_limit",
  AgentProviderServerError: "agent_error.provider_server_error",
  AgentProviderNetwork: "agent_error.provider_network",
  AgentProcessFailure: "agent_error.process_failure",
  AgentEmptyOrUnparseableOutput: "agent_error.empty_or_unparseable_output",
  AgentTimeout: "agent_error.agent_timeout",
  AgentContextOverflow: "agent_error.context_overflow",
  AgentStaleSession: "agent_error.stale_session",
  AgentMissingConfig: "agent_error.missing_config",
  AgentModelNotFoundOrUnavailable: "agent_error.model_not_found_or_unavailable",
  AgentRuntimeVersionUnsupported: "agent_error.runtime_version_unsupported",
  AgentRuntimeMissingExecutable: "agent_error.runtime_missing_executable",
  RepoSyncFailed: "repo_sync_failed",
  AgentUnknown: "agent_error.unknown",
} as const;

export type TaskFailureReasonValue = typeof TaskFailureReason[keyof typeof TaskFailureReason];

/**
 * Recoverable resource exhaustion of the primary model's gateway. The model has
 * no capacity left, so running the SAME model again cannot help — these are the
 * only reasons allowed to switch a task to its Agent's fallback model, and only
 * once per recovery chain. Auth, model-access, request-shape, context, tool and
 * business failures are deliberately absent: they are not resource problems and
 * switching models would hide a real misconfiguration instead of fixing it.
 */
export const MODEL_FALLBACK_FAILURE_REASONS: ReadonlySet<string> = new Set<string>([
  TaskFailureReason.AgentProviderNoAvailableAccount,
  TaskFailureReason.AgentProviderQuotaLimit,
]);

/**
 * Short-lived throttling/overload. The primary model itself is expected to
 * recover, so the recovery chain retries the SAME model with a bounded,
 * Retry-After-aware delay instead of spending its one model switch.
 */
export const TRANSIENT_RETRY_FAILURE_REASONS: ReadonlySet<string> = new Set<string>([
  TaskFailureReason.AgentProviderCapacityOrRateLimit,
]);

/**
 * Marker recorded on a switched task so the execution record can explain why it
 * ran a model other than the Agent's selection.
 */
export function modelFallbackSwitchReason(failureReason: string, providerSessionReset: boolean): string {
  return providerSessionReset
    ? `gateway_resource:${failureReason};provider_session_reset`
    : `gateway_resource:${failureReason}`;
}
