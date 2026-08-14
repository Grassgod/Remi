import type {
  MultiremiAgentPluginRuntimeDesiredSnapshot,
  MultiremiAgentPluginRuntimeState,
} from "@multiremi/contracts/types.js";

export function daemonAgentPluginDesiredResponse(snapshot: MultiremiAgentPluginRuntimeDesiredSnapshot) {
  return {
    runtime_id: snapshot.runtimeId,
    revision: snapshot.revision,
    plugins: snapshot.plugins.map((plugin) => ({
      state_id: plugin.stateId,
      plugin_id: plugin.pluginId,
      version_id: plugin.versionId,
      name: plugin.name,
      provider: plugin.provider,
      version: plugin.version,
      digest: plugin.digest,
      artifact_url: plugin.artifactUrl,
      source_revision: plugin.sourceRevision,
      requirements: plugin.requirements,
      desired_reason: plugin.desiredReason,
      status: plugin.status,
      observed_digest: plugin.observedDigest,
      retry_count: plugin.retryCount,
      retry_generation: plugin.retryGeneration,
      next_retry_at: plugin.nextRetryAt,
      last_error_code: plugin.lastErrorCode,
      last_error: plugin.lastError,
      updated_at: plugin.updatedAt,
    })),
  };
}

export function daemonAgentPluginStateResponse(state: MultiremiAgentPluginRuntimeState) {
  return {
    id: state.id,
    runtime_id: state.runtimeId,
    plugin_id: state.pluginId,
    version_id: state.pluginVersionId,
    desired: state.desired,
    desired_reason: state.desiredReason,
    status: state.status,
    observed_digest: state.observedDigest,
    retry_count: state.retryCount,
    retry_generation: state.retryGeneration,
    next_retry_at: state.nextRetryAt,
    last_error_code: state.lastErrorCode,
    last_error: state.lastError,
    last_attempt_at: state.lastAttemptAt,
    last_ready_at: state.lastReadyAt,
    updated_at: state.updatedAt,
  };
}
