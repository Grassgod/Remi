/**
 * Agent Plugin runtime contracts.
 *
 * These are intentionally separate from `plugins/registry.ts`: that registry
 * loads Remi host extensions, while the types below describe provider-native
 * Claude/Codex capability bundles attached to a Multiremi Agent.
 */

export type AgentPluginProvider = "claude" | "codex";

/** Immutable provider artifact desired on every enabled Runtime. */
export interface AgentPluginArtifactSpec {
  stateId?: string;
  pluginId: string;
  versionId: string;
  name: string;
  provider: AgentPluginProvider;
  version: string;
  /** SHA-256 of the exact canonical Artifact JSON bytes, with or without `sha256:`. */
  digest: string;
  /** Artifact Store URL. May be relative to the Multiremi server URL. */
  artifactUrl: string;
  sourceRevision?: string | null;
  requirements?: Record<string, unknown> | null;
  /** Server generation incremented by a manual Runtime retry action. */
  retryGeneration?: number;
}

/** Immutable plugin binding frozen into a task at claim time. */
export interface AgentPluginSnapshot extends AgentPluginArtifactSpec {
  bindingId: string;
  /** Non-secret binding configuration. Credentials are referenced separately. */
  config?: Record<string, unknown> | null;
  connectionId?: string | null;
}

export type PluginInstallPhase = "downloading" | "verifying" | "installing";

export type RuntimePluginStatus =
  | "pending"
  | PluginInstallPhase
  | "preflight"
  | "ready"
  | "retry_scheduled"
  | "setup_required"
  | "blocked";

/** State reported by a daemon for one desired immutable Plugin version. */
export interface RuntimePluginState {
  stateId?: string;
  pluginId: string;
  versionId: string;
  provider: AgentPluginProvider;
  desiredVersion: string;
  desiredDigest: string;
  installedVersion: string | null;
  installedDigest: string | null;
  status: RuntimePluginStatus;
  attempts: number;
  retryGeneration: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface PreparedAgentPluginRuntime {
  runtimeRoot: string;
  pluginPaths: string[];
  pluginFingerprint: string;
  executionFingerprint: string;
  codexHome?: string;
  codexMarketplaceRoot?: string;
  codexMarketplaceName?: string;
  codexPluginNames?: string[];
}

export class AgentPluginError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryKind: "transient" | "setup_required" | "blocked",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentPluginError";
  }
}

export class PluginCacheMissError extends AgentPluginError {
  constructor(digest: string) {
    super(
      `Agent Plugin ${digest} is not ready in this Runtime cache`,
      "plugin_cache_miss",
      "transient",
    );
    this.name = "PluginCacheMissError";
  }
}

export function asAgentPluginError(error: unknown): AgentPluginError {
  if (error instanceof AgentPluginError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AgentPluginError(message, "plugin_install_failed", "transient", {
    cause: error,
  });
}
