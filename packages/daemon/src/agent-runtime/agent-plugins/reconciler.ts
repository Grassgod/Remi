import type { AgentPluginCache } from "./cache.js";
import { normalizeSha256Digest } from "./cache.js";
import type {
  AgentPluginArtifactSpec,
  RuntimePluginState,
  RuntimePluginStatus,
} from "./types.js";
import { AgentPluginError, asAgentPluginError } from "./types.js";

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const DEFAULT_SETUP_RECHECK_MS = 30 * 60_000;

export interface AgentPluginRuntimeReconcilerOptions {
  cache: AgentPluginCache;
  /** Runtime dependency/provider check after the immutable payload is installed. */
  preflight?: (snapshot: AgentPluginArtifactSpec, payloadPath: string, signal?: AbortSignal) => Promise<void>;
  /** Persist/report every observed-state transition to the Multiremi server. */
  reportState?: (state: RuntimePluginState) => void | Promise<void>;
  retryDelaysMs?: number[];
  setupRecheckMs?: number;
  now?: () => number;
}

export interface ReconcileAgentPluginsOptions {
  signal?: AbortSignal;
  /** Ignore retry deadlines and retry blocked/setup-required entries now. */
  force?: boolean;
}

/**
 * Converges one Runtime to the server-provided desired Plugin version set.
 *
 * The worker owns transport: fetch desired state, pass every enabled version to
 * `reconcile()`, and forward `reportState` to the server. Repeated daemon
 * heartbeat/startup calls supply the retry loop; no task waits inside a long
 * sleep. `retryNow()` is the manual-retry hook used by Runtime/Plugin pages.
 */
export class AgentPluginRuntimeReconciler {
  private readonly states = new Map<string, RuntimePluginState>();
  private readonly verifiedReady = new Set<string>();
  private readonly cache: AgentPluginCache;
  private readonly preflight?: AgentPluginRuntimeReconcilerOptions["preflight"];
  private readonly reportState?: AgentPluginRuntimeReconcilerOptions["reportState"];
  private readonly retryDelaysMs: number[];
  private readonly setupRecheckMs: number;
  private readonly now: () => number;

  constructor(options: AgentPluginRuntimeReconcilerOptions) {
    this.cache = options.cache;
    this.preflight = options.preflight;
    this.reportState = options.reportState;
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? options.retryDelaysMs.map((value) => Math.max(0, value))
      : DEFAULT_RETRY_DELAYS_MS;
    this.setupRecheckMs = options.setupRecheckMs ?? DEFAULT_SETUP_RECHECK_MS;
    this.now = options.now ?? Date.now;
  }

  getStates(): RuntimePluginState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  /** Restore server-persisted observed state after a daemon restart. */
  restoreStates(states: RuntimePluginState[]): void {
    for (const state of states) {
      const key = stateKey(state);
      if (!this.states.has(key)) this.states.set(key, { ...state });
    }
  }

  /** Clear retry/blocked state so the next reconcile attempts this digest now. */
  async retryNow(digest: string): Promise<RuntimePluginState[]> {
    const normalized = normalizeSha256Digest(digest);
    const changed: RuntimePluginState[] = [];
    for (const [key, state] of this.states) {
      if (normalizeSha256Digest(state.desiredDigest) !== normalized) continue;
      const next = {
        ...state,
        status: "pending" as const,
        attempts: 0,
        nextRetryAt: null,
        lastErrorCode: null,
        lastError: null,
        installedVersion: null,
        installedDigest: null,
        updatedAt: this.isoNow(),
      };
      this.states.set(key, next);
      this.verifiedReady.delete(key);
      changed.push({ ...next });
      await this.emit(next);
    }
    return changed;
  }

  async reconcile(
    desiredSnapshots: AgentPluginArtifactSpec[],
    options: ReconcileAgentPluginsOptions = {},
  ): Promise<RuntimePluginState[]> {
    const desired = dedupeDesired(desiredSnapshots);
    await Promise.all(desired.map((snapshot) => this.reconcileOne(snapshot, options)));
    const desiredKeys = new Set(desired.map(snapshotKey));
    for (const key of this.states.keys()) {
      if (!desiredKeys.has(key)) {
        this.states.delete(key);
        this.verifiedReady.delete(key);
      }
    }
    return [...this.states.entries()]
      .filter(([key]) => desiredKeys.has(key))
      .map(([, state]) => ({ ...state }));
  }

  private async reconcileOne(
    snapshot: AgentPluginArtifactSpec,
    options: ReconcileAgentPluginsOptions,
  ): Promise<void> {
    const key = snapshotKey(snapshot);
    let state = this.states.get(key) ?? initialState(snapshot, this.isoNow());
    this.states.set(key, state);

    const retryGeneration = Math.max(0, snapshot.retryGeneration ?? 0);
    const serverRequestedRetry = retryGeneration > state.retryGeneration;
    if (serverRequestedRetry) {
      this.verifiedReady.delete(key);
      state = await this.transition(snapshot, state, "pending", {
        attempts: 0,
        retryGeneration,
        nextRetryAt: null,
        lastErrorCode: null,
        lastError: null,
        installedVersion: null,
        installedDigest: null,
      });
    }

    if (!options.force && !serverRequestedRetry) {
      if (state.status === "ready" && this.verifiedReady.has(key) && await this.cache.getReadyPath(snapshot)) {
        await this.emit(state);
        return;
      }
      if (state.status === "blocked") {
        await this.emit(state);
        return;
      }
      if (state.nextRetryAt && Date.parse(state.nextRetryAt) > this.now()) {
        await this.emit(state);
        return;
      }
    }

    const attempt = state.attempts + 1;
    state = await this.transition(snapshot, state, "pending", {
      attempts: attempt,
      nextRetryAt: null,
      lastErrorCode: null,
      lastError: null,
    });

    try {
      const payloadPath = await this.cache.ensure(snapshot, {
        signal: options.signal,
        onPhase: async (phase) => {
          state = await this.transition(snapshot, state, phase);
        },
      });
      state = await this.transition(snapshot, state, "preflight");
      await this.preflight?.(snapshot, payloadPath, options.signal);
      this.verifiedReady.add(key);
      await this.transition(snapshot, state, "ready", {
        attempts: 0,
        installedVersion: snapshot.version,
        installedDigest: canonicalDigest(snapshot.digest),
        nextRetryAt: null,
        lastErrorCode: null,
        lastError: null,
      });
    } catch (error) {
      this.verifiedReady.delete(key);
      const failure = asAgentPluginError(error);
      const terminalDigestMismatch = failure.code === "plugin_digest_mismatch" && attempt >= 2;
      if (failure.retryKind === "blocked" || terminalDigestMismatch) {
        await this.transition(snapshot, state, "blocked", {
          attempts: attempt,
          nextRetryAt: null,
          lastErrorCode: failure.code,
          lastError: formatFailure(failure),
        });
        return;
      }
      if (failure.retryKind === "setup_required") {
        await this.transition(snapshot, state, "setup_required", {
          attempts: attempt,
          nextRetryAt: new Date(this.now() + this.setupRecheckMs).toISOString(),
          lastErrorCode: failure.code,
          lastError: formatFailure(failure),
        });
        return;
      }
      const delay = this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)]!;
      await this.transition(snapshot, state, "retry_scheduled", {
        attempts: attempt,
        nextRetryAt: new Date(this.now() + delay).toISOString(),
        lastErrorCode: failure.code,
        lastError: formatFailure(failure),
      });
    }
  }

  private async transition(
    snapshot: AgentPluginArtifactSpec,
    previous: RuntimePluginState,
    status: RuntimePluginStatus,
    patch: Partial<RuntimePluginState> = {},
  ): Promise<RuntimePluginState> {
    const next: RuntimePluginState = {
      ...previous,
      ...patch,
      pluginId: snapshot.pluginId,
      stateId: snapshot.stateId ?? previous.stateId,
      versionId: snapshot.versionId,
      provider: snapshot.provider,
      desiredVersion: snapshot.version,
      desiredDigest: canonicalDigest(snapshot.digest),
      status,
      updatedAt: this.isoNow(),
    };
    this.states.set(snapshotKey(snapshot), next);
    await this.emit(next);
    return next;
  }

  private async emit(state: RuntimePluginState): Promise<void> {
    if (!this.reportState) return;
    try {
      await this.reportState({ ...state });
    } catch (error) {
      // Deployment must not be reclassified as failed merely because reporting
      // briefly failed. The next heartbeat reports the latest observed state.
      console.warn(
        `[agent-plugins] failed to report ${state.pluginId}@${state.desiredVersion} ${state.status}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

/** Helper for preflight implementations to classify missing Runtime setup. */
export function pluginSetupRequired(message: string, code = "plugin_setup_required"): AgentPluginError {
  return new AgentPluginError(message, code, "setup_required");
}

/** Helper for preflight implementations to classify an incompatible artifact. */
export function pluginBlocked(message: string, code = "plugin_incompatible"): AgentPluginError {
  return new AgentPluginError(message, code, "blocked");
}

function initialState(snapshot: AgentPluginArtifactSpec, now: string): RuntimePluginState {
  return {
    stateId: snapshot.stateId,
    pluginId: snapshot.pluginId,
    versionId: snapshot.versionId,
    provider: snapshot.provider,
    desiredVersion: snapshot.version,
    desiredDigest: canonicalDigest(snapshot.digest),
    installedVersion: null,
    installedDigest: null,
    status: "pending",
    attempts: 0,
    retryGeneration: Math.max(0, snapshot.retryGeneration ?? 0),
    nextRetryAt: null,
    lastErrorCode: null,
    lastError: null,
    updatedAt: now,
  };
}

function dedupeDesired(snapshots: AgentPluginArtifactSpec[]): AgentPluginArtifactSpec[] {
  const unique = new Map<string, AgentPluginArtifactSpec>();
  for (const snapshot of snapshots) unique.set(snapshotKey(snapshot), snapshot);
  return [...unique.values()];
}

function snapshotKey(snapshot: Pick<AgentPluginArtifactSpec, "pluginId" | "versionId" | "provider" | "digest">): string {
  return `${snapshot.provider}:${snapshot.pluginId}:${snapshot.versionId}:${normalizeSha256Digest(snapshot.digest)}`;
}

function stateKey(state: RuntimePluginState): string {
  return `${state.provider}:${state.pluginId}:${state.versionId}:${normalizeSha256Digest(state.desiredDigest)}`;
}

function canonicalDigest(value: string): string {
  return `sha256:${normalizeSha256Digest(value)}`;
}

function formatFailure(error: AgentPluginError): string {
  return `${error.code}: ${error.message}`;
}
