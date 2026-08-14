import type {
  AgentPluginReadiness,
  AgentPluginReadinessState,
  AgentPluginReadinessSummary,
} from "./types";

const CHECKING_STATUSES = new Set([
  "pending",
  "downloading",
  "verifying",
  "installing",
  "preflight",
  "retry_scheduled",
]);

const INCOMPATIBLE_ERROR_CODES = new Set([
  "incompatible",
  "plugin_incompatible",
  "provider_mismatch",
  "unsupported_provider",
  "unsupported_runtime",
  "version_incompatible",
]);

export function deriveAgentPluginReadiness(
  states: readonly AgentPluginReadinessState[],
): AgentPluginReadiness {
  return summarizeAgentPluginReadiness(states).status;
}

export function summarizeAgentPluginReadiness(
  states: readonly AgentPluginReadinessState[],
): AgentPluginReadinessSummary {
  const desired = states.filter((state) => state.desired !== false);
  let ready = 0;
  let checking = 0;
  let setupRequired = 0;
  let blocked = 0;
  let unknown = 0;
  let incompatible = 0;

  for (const state of desired) {
    if (state.status === "ready") {
      ready += 1;
    } else if (CHECKING_STATUSES.has(state.status)) {
      checking += 1;
    } else if (state.status === "setup_required") {
      setupRequired += 1;
    } else if (state.status === "blocked") {
      blocked += 1;
      if (isIncompatibleError(state.lastErrorCode)) incompatible += 1;
    } else {
      unknown += 1;
    }
  }

  const total = desired.length;
  let status: AgentPluginReadiness;
  if (total === 0) status = "unknown";
  else if (ready === total) status = "ready";
  else if (ready > 0) status = "partial";
  else if (setupRequired > 0) status = "setup_required";
  else if (blocked > 0) {
    status = incompatible === blocked ? "incompatible" : "error";
  } else if (checking > 0 && unknown === 0) status = "checking";
  else status = "unknown";

  return {
    status,
    total,
    ready,
    checking,
    setupRequired,
    blocked,
    unknown,
  };
}

function isIncompatibleError(code: string | null | undefined): boolean {
  if (!code) return false;
  if (INCOMPATIBLE_ERROR_CODES.has(code)) return true;
  return code.includes("incompatible") || code.includes("unsupported");
}
