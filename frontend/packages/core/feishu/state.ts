// Pure state derivation for the Feishu messages settings tab. Kept out of the
// view layer so the state machines in design/MUL-155/spec.md can be tested
// without a DOM, and so web and desktop can never drift on what "blocked"
// means.
import type { FeishuEndpointHealth, FeishuMessage, FeishuSource, FeishuSourceStatus } from "../api/schemas/feishu";

export type FeishuEndpointState =
  | "not_configured"
  | "checking"
  | "ready"
  | "unreachable"
  | "stale"
  | "forbidden";

export interface DeriveEndpointStateInput {
  /** False when the caller is not a workspace admin. The panel then renders a
   *  placeholder and never issues the request — hiding the button alone would
   *  still leak health data to a Member through the network tab. */
  permitted: boolean;
  /** `configured: false` means the operator has registered no endpoint. It is a
   *  fail-closed deployment state, not an error to retry. */
  configured: boolean;
  endpoint: FeishuEndpointHealth | null;
  loading: boolean;
  /** A refresh that failed while a previous result is still on screen. */
  refreshFailed?: boolean;
}

export function deriveEndpointState(input: DeriveEndpointStateInput): FeishuEndpointState {
  if (!input.permitted) return "forbidden";
  if (input.loading && !input.endpoint) return "checking";
  if (!input.configured) return "not_configured";
  const endpoint = input.endpoint;
  if (!endpoint) return "not_configured";
  if (input.refreshFailed === true && endpoint.checkedAt !== null) return "stale";
  if (endpoint.status === "ready") return "ready";
  if (endpoint.status === "unreachable") return "unreachable";
  // "unknown" with a prior check is a refresh that never landed; without one
  // the endpoint has simply not been probed yet.
  return endpoint.checkedAt === null ? "checking" : "stale";
}

export type FeishuSourceState =
  | "active"
  | "paused"
  | "blocked_empty_allowlist"
  | "blocked_endpoint"
  | "degraded";

export interface DeriveSourceStateInput {
  source: Pick<FeishuSource, "enabled" | "allowlist" | "endpointName">;
  /** Health of the endpoint this source references, or null when the name is
   *  no longer in the registry — which is itself a blocked state. */
  endpoint: FeishuEndpointHealth | null;
  status?: Pick<FeishuSourceStatus, "consecutiveFailures" | "lastSuccessfulIngestAt"> | null;
}

/**
 * Priority order, most-blocking first. An unreachable endpoint outranks an
 * empty allowlist because one deployment fix unblocks every source at once,
 * while the allowlist is per-source and only the owner can decide it.
 *
 * The spec also lists a `syncing` state for an in-flight lease. The status API
 * deliberately exposes no lease fields (they carry an owner token), so there is
 * no signal to derive it from and the list shows the last settled state
 * instead.
 */
export function deriveSourceState(input: DeriveSourceStateInput): FeishuSourceState {
  if (!input.source.enabled) return "paused";
  if (input.endpoint === null || input.endpoint.status !== "ready") return "blocked_endpoint";
  if (input.source.allowlist.length === 0) return "blocked_empty_allowlist";
  if ((input.status?.consecutiveFailures ?? 0) > 0) return "degraded";
  return "active";
}

export type FeishuStateTone = "ok" | "warning" | "danger" | "neutral";

export function feishuSourceStateTone(state: FeishuSourceState): FeishuStateTone {
  switch (state) {
    case "active": return "ok";
    case "paused": return "neutral";
    case "blocked_empty_allowlist": return "warning";
    case "degraded": return "warning";
    case "blocked_endpoint": return "danger";
    // A server that grows a new state renders neutral rather than crashing.
    default: return "neutral";
  }
}

export function feishuEndpointStateTone(state: FeishuEndpointState): FeishuStateTone {
  switch (state) {
    case "ready": return "ok";
    case "stale": return "warning";
    case "unreachable": return "danger";
    default: return "neutral";
  }
}

/** Pending Issue proposals attached to a message, newest first. */
export function pendingProposalCount(message: Pick<FeishuMessage, "outcomes">): number {
  const proposed = message.outcomes.filter((outcome) => outcome.outcomeKind === "issue_proposed").length;
  const settled = message.outcomes.filter(
    (outcome) => outcome.outcomeKind === "issue_created"
      || (outcome.outcomeKind === "dismissed" && outcome.reason === "proposal_rejected"),
  ).length;
  return Math.max(0, proposed - settled);
}

export function isFeishuMessageProcessed(message: Pick<FeishuMessage, "processedAt">): boolean {
  return message.processedAt !== null && message.processedAt !== "";
}
