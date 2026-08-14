import type { ReportAgentPluginRuntimeStateInput } from "@multiremi/contracts/types.js";
import { normalizeSha256Digest } from "./cache.js";
import type { AgentPluginArtifactSpec, RuntimePluginState, RuntimePluginStatus } from "./types.js";
import { AgentPluginError } from "./types.js";

/** Parse the daemon desired-state wire (snake_case or internal camelCase). */
export function agentPluginArtifactSpecFromWire(value: unknown): AgentPluginArtifactSpec {
  return agentPluginDesiredFromWire(value).artifact;
}

export interface AgentPluginDesiredFromWire {
  artifact: AgentPluginArtifactSpec;
  state: RuntimePluginState;
}

/** Parse an immutable desired artifact together with its persisted observed state. */
export function agentPluginDesiredFromWire(value: unknown): AgentPluginDesiredFromWire {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentPluginError("Invalid Runtime Agent Plugin desired state", "plugin_desired_invalid", "blocked");
  }
  const row = value as Record<string, unknown>;
  const provider = stringField(row.provider)?.toLowerCase();
  if (provider !== "claude" && provider !== "codex") {
    throw new AgentPluginError("Invalid desired Plugin provider", "plugin_desired_invalid", "blocked");
  }
  const required = {
    pluginId: row.pluginId ?? row.plugin_id,
    versionId: row.versionId ?? row.version_id,
    name: row.name,
    version: row.version,
    digest: row.digest,
    artifactUrl: row.artifactUrl ?? row.artifact_url,
  };
  for (const [field, raw] of Object.entries(required)) {
    if (!stringField(raw)) {
      throw new AgentPluginError(
        `Runtime Agent Plugin desired state is missing ${field}`,
        "plugin_desired_invalid",
        "blocked",
      );
    }
  }
  normalizeSha256Digest(String(required.digest));
  const artifact: AgentPluginArtifactSpec = {
    stateId: stringField(row.stateId ?? row.state_id) ?? undefined,
    pluginId: String(required.pluginId).trim(),
    versionId: String(required.versionId).trim(),
    name: String(required.name).trim(),
    provider,
    version: String(required.version).trim(),
    digest: String(required.digest).trim(),
    artifactUrl: String(required.artifactUrl).trim(),
    sourceRevision: stringField(row.sourceRevision ?? row.source_revision),
    requirements: recordField(row.requirements),
    retryGeneration: nonNegativeInteger(row.retryGeneration ?? row.retry_generation),
  };
  const status = runtimeStatus(row.status);
  const observedDigest = stringField(row.observedDigest ?? row.observed_digest);
  const attempts = status === "retry_scheduled" || status === "setup_required" || status === "blocked"
    ? nonNegativeInteger(row.retryCount ?? row.retry_count)
    : 0;
  return {
    artifact,
    state: {
      stateId: artifact.stateId,
      pluginId: artifact.pluginId,
      versionId: artifact.versionId,
      provider: artifact.provider,
      desiredVersion: artifact.version,
      desiredDigest: `sha256:${normalizeSha256Digest(artifact.digest)}`,
      installedVersion: status === "ready" ? artifact.version : null,
      installedDigest: observedDigest ? `sha256:${normalizeSha256Digest(observedDigest)}` : null,
      status,
      attempts,
      retryGeneration: artifact.retryGeneration ?? 0,
      nextRetryAt: nullableIso(row.nextRetryAt ?? row.next_retry_at),
      lastErrorCode: stringField(row.lastErrorCode ?? row.last_error_code),
      lastError: stringField(row.lastError ?? row.last_error),
      updatedAt: nullableIso(row.updatedAt ?? row.updated_at) ?? new Date(0).toISOString(),
    },
  };
}

/** Exact server endpoint/body projection used by reportState. */
export function runtimePluginStateReport(state: RuntimePluginState): {
  versionId: string;
  input: ReportAgentPluginRuntimeStateInput;
} {
  return {
    versionId: state.versionId,
    input: {
      status: state.status,
      attempts: state.attempts,
      retryGeneration: state.retryGeneration,
      observedDigest: state.installedDigest ? normalizeSha256Digest(state.installedDigest) : null,
      nextRetryAt: state.nextRetryAt,
      lastErrorCode: state.lastErrorCode,
      lastError: state.lastError,
    },
  };
}

function runtimeStatus(value: unknown): RuntimePluginStatus {
  const status = stringField(value) ?? "pending";
  if (
    status === "pending" || status === "downloading" || status === "verifying" ||
    status === "installing" || status === "preflight" || status === "ready" ||
    status === "retry_scheduled" || status === "setup_required" || status === "blocked"
  ) return status;
  throw new AgentPluginError("Invalid Runtime Agent Plugin status", "plugin_desired_invalid", "blocked");
}

function nullableIso(value: unknown): string | null {
  const cleaned = stringField(value);
  if (!cleaned) return null;
  if (!Number.isFinite(Date.parse(cleaned))) {
    throw new AgentPluginError("Invalid Runtime Agent Plugin timestamp", "plugin_desired_invalid", "blocked");
  }
  return cleaned;
}

function stringField(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function recordField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
