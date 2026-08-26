import { randomUUID } from "node:crypto";
import { createLogger } from "@shared/logger.js";
import type {
  MultiremiScmConnection,
  MultiremiScmRepositoryBinding,
  MultiremiScmSyncCursor,
  MultiremiScmSyncStream,
} from "@multiremi/contracts/types.js";
import { CodebaseScmProviderAdapter } from "./codebase.js";
import { GitHubScmProviderAdapter } from "./github.js";
import { ScmHttpError } from "./http.js";
import { reconcileObservation } from "./reconcile.js";
import type { ScmIngestionStore, ScmProviderAdapter } from "./types.js";
import { SCM_SYNC_STREAMS, ScmStreamUnavailableError } from "./types.js";

const log = createLogger("multiremi-scm-poller");
const DEFAULT_TICK_INTERVAL_MS = 10_000;
const DEFAULT_MAX_PAGES_PER_TICK = 50;
const DEFAULT_STREAM_LEASE_MS = 5 * 60 * 1_000;
const MAX_ERROR_BACKOFF_SECONDS = 30 * 60;
const STREAM_UNAVAILABLE_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const POLLING_CYCLE_CURSOR_KEY = "__multiremi_cycle";

export interface ScmPollingSchedulerOptions {
  store: ScmIngestionStore;
  adapters?: ScmProviderAdapter[];
  tickIntervalMs?: number;
  maxPagesPerStream?: number;
  streamLeaseMs?: number;
  leaseOwner?: string;
  now?: () => Date;
}

export interface ScmPollingRunResult {
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  eventsCreated: number;
}

export class ScmPollingScheduler {
  private readonly store: ScmIngestionStore;
  private readonly adapters: Map<string, ScmProviderAdapter>;
  private readonly tickIntervalMs: number;
  private readonly maxPagesPerStream: number;
  private readonly streamLeaseMs: number;
  private readonly leaseOwner: string;
  private readonly now: () => Date;
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickPromise: Promise<ScmPollingRunResult> | null = null;

  constructor(options: ScmPollingSchedulerOptions) {
    this.store = options.store;
    this.adapters = new Map(
      (options.adapters ?? [new GitHubScmProviderAdapter(), new CodebaseScmProviderAdapter()])
        .map((adapter) => [adapter.provider, adapter]),
    );
    this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.maxPagesPerStream = Math.max(1, options.maxPagesPerStream ?? DEFAULT_MAX_PAGES_PER_TICK);
    this.streamLeaseMs = Math.max(30_000, options.streamLeaseMs ?? DEFAULT_STREAM_LEASE_MS);
    this.leaseOwner = options.leaseOwner?.trim() || `scm-poller:${process.pid}:${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runOnce().catch((error) => log.warn(`Initial SCM poll failed: ${errorMessage(error)}`));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => log.warn(`SCM polling tick failed: ${errorMessage(error)}`));
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(now: Date = this.now()): Promise<ScmPollingRunResult> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.runOnceInternal(now).finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  private async runOnceInternal(now: Date): Promise<ScmPollingRunResult> {
    const result: ScmPollingRunResult = { attempted: 0, completed: 0, failed: 0, skipped: 0, eventsCreated: 0 };
    const connections = this.store.listConnections({ enabled: true })
      .filter((connection) => connection.mode === "poll" || connection.mode === "hybrid");
    for (const connection of connections) {
      const adapter = this.adapters.get(connection.provider);
      if (!adapter) {
        result.skipped += 1;
        continue;
      }
      const bindings = this.store.listRepositoryBindings({ connectionId: connection.id, enabled: true });
      for (const binding of bindings) {
        for (const stream of SCM_SYNC_STREAMS) {
          if (!adapter.capabilities.streams[stream].poll) continue;
          const cursor = this.store.getSyncCursor(connection.id, binding.repositoryId, stream);
          if (!pollIsDue(connection, cursor, now)) {
            result.skipped += 1;
            continue;
          }
          result.attempted += 1;
          const streamResult = await this.pollStream(connection, binding, stream, adapter, now);
          if (streamResult.error) result.failed += 1;
          else if (streamResult.completed) result.completed += 1;
          else result.skipped += 1;
          result.eventsCreated += streamResult.eventsCreated;
        }
      }
    }
    return result;
  }

  private async pollStream(
    connection: MultiremiScmConnection,
    binding: MultiremiScmRepositoryBinding,
    stream: MultiremiScmSyncStream,
    adapter: ScmProviderAdapter,
    startedAt: Date,
  ): Promise<{ completed: boolean; eventsCreated: number; error: string | null }> {
    const key = `${connection.id}:${binding.repositoryId}:${stream}`;
    if (this.inFlight.has(key)) return { completed: false, eventsCreated: 0, error: null };
    this.inFlight.add(key);
    let cursor: MultiremiScmSyncCursor | null = null;
    let leaseToken: string | null = null;
    let previousWatermark: string | null = null;
    let baseline = false;
    let eventsCreated = 0;
    let completed = false;
    let cycleStartedAt = startedAt;
    let providerCursor: Record<string, unknown> | null = null;
    try {
      cursor = this.store.claimSyncStream({
        connectionId: connection.id,
        repositoryId: binding.repositoryId,
        stream,
        owner: this.leaseOwner,
        now: startedAt.toISOString(),
        leaseMs: this.streamLeaseMs,
      });
      if (!cursor?.leaseToken) return { completed: false, eventsCreated: 0, error: null };
      leaseToken = cursor.leaseToken;
      baseline = !cursor.baselineCompletedAt;
      previousWatermark = cursor.watermark;
      ({ cycleStartedAt, providerCursor } = pollingCycle(cursor, startedAt));
      cursor = this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
        lastStartedAt: startedAt.toISOString(),
      }, startedAt);
      const credential = this.store.getConnectionCredential(connection.id);
      if (!credential) throw new Error("SCM connection credential is unavailable");
      for (let pageNumber = 0; pageNumber < this.maxPagesPerStream; pageNumber += 1) {
        const page = await adapter.poll({
          connection,
          credential,
          binding,
          stream,
          cursor: cursor ? { ...cursor, cursor: providerCursor, watermark: previousWatermark } : null,
          now: startedAt,
          heartbeat: () => this.renewClaimedLease(
            connection.id,
            binding.repositoryId,
            stream,
            leaseToken!,
            startedAt,
          ),
        });
        this.renewClaimedLease(
          connection.id,
          binding.repositoryId,
          stream,
          leaseToken,
          startedAt,
        );
        for (const observation of page.observations) {
          const reconciliation = reconcileObservation({
            store: this.store,
            binding,
            observation,
            baseline,
            source: "poll",
            fidelity: adapter.capabilities.streams[stream].pollFidelity ?? "inferred",
          });
          eventsCreated += reconciliation.events.filter((event) => event.created).length;
        }
        providerCursor = page.cursor;
        cursor = this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
          cursor: page.done ? null : encodePollingCycle(cycleStartedAt, providerCursor),
          watermark: previousWatermark,
          lastError: null,
          consecutiveFailures: 0,
          suspendedUntil: null,
        }, startedAt);
        if (page.done) {
          const completedAt = this.now().toISOString();
          cursor = this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
            cursor: null,
            watermark: cycleStartedAt.toISOString(),
            baselineCompletedAt: cursor?.baselineCompletedAt ?? completedAt,
            lastCompletedAt: completedAt,
            lastError: null,
            consecutiveFailures: 0,
            suspendedUntil: null,
          }, startedAt);
          completed = true;
          break;
        }
      }
      return { completed, eventsCreated, error: null };
    } catch (error) {
      if (error instanceof ScmStreamLeaseLostError) {
        log.warn(`SCM poll lease was lost for ${key}; stale results were discarded`);
        return { completed: false, eventsCreated, error: null };
      }
      const message = pollErrorMessage(error, connection.provider, stream).slice(0, 1_000);
      if (leaseToken) {
        try {
          const consecutiveFailures = (cursor?.consecutiveFailures ?? 0) + 1;
          const suspendedUntil = error instanceof ScmStreamUnavailableError
            ? new Date(this.now().getTime() + STREAM_UNAVAILABLE_COOLDOWN_MS).toISOString()
            : null;
          this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
            watermark: previousWatermark,
            lastError: message,
            consecutiveFailures,
            suspendedUntil,
          }, startedAt);
        } catch (writeError) {
          if (!(writeError instanceof ScmStreamLeaseLostError)) throw writeError;
        }
      }
      log.warn(`SCM poll failed for ${key}: ${message}`);
      return { completed: false, eventsCreated, error: message };
    } finally {
      if (leaseToken) {
        this.store.releaseSyncStream({
          connectionId: connection.id,
          repositoryId: binding.repositoryId,
          stream,
          leaseToken,
        });
      }
      this.inFlight.delete(key);
    }
  }

  private writeClaimedCursor(
    connectionId: string,
    repositoryId: string,
    stream: MultiremiScmSyncStream,
    leaseToken: string,
    current: MultiremiScmSyncCursor | null,
    patch: Partial<Pick<
      MultiremiScmSyncCursor,
      | "cursor"
      | "watermark"
      | "baselineCompletedAt"
      | "lastStartedAt"
      | "lastCompletedAt"
      | "lastError"
      | "consecutiveFailures"
      | "suspendedUntil"
    >>,
    leaseReference: Date,
  ): MultiremiScmSyncCursor {
    const cursor = this.store.updateClaimedSyncCursor({
      connectionId,
      repositoryId,
      stream,
      leaseToken,
      leaseUntil: this.leaseExpiry(leaseReference),
      cursor: Object.prototype.hasOwnProperty.call(patch, "cursor") ? patch.cursor ?? null : current?.cursor ?? null,
      watermark: Object.prototype.hasOwnProperty.call(patch, "watermark") ? patch.watermark ?? null : current?.watermark ?? null,
      baselineCompletedAt: Object.prototype.hasOwnProperty.call(patch, "baselineCompletedAt")
        ? patch.baselineCompletedAt ?? null
        : current?.baselineCompletedAt ?? null,
      lastStartedAt: Object.prototype.hasOwnProperty.call(patch, "lastStartedAt")
        ? patch.lastStartedAt ?? null
        : current?.lastStartedAt ?? null,
      lastCompletedAt: Object.prototype.hasOwnProperty.call(patch, "lastCompletedAt")
        ? patch.lastCompletedAt ?? null
        : current?.lastCompletedAt ?? null,
      lastError: Object.prototype.hasOwnProperty.call(patch, "lastError") ? patch.lastError ?? null : current?.lastError ?? null,
      consecutiveFailures: Object.prototype.hasOwnProperty.call(patch, "consecutiveFailures")
        ? patch.consecutiveFailures ?? 0
        : current?.consecutiveFailures ?? 0,
      suspendedUntil: Object.prototype.hasOwnProperty.call(patch, "suspendedUntil")
        ? patch.suspendedUntil ?? null
        : current?.suspendedUntil ?? null,
    });
    if (!cursor) throw new ScmStreamLeaseLostError();
    return cursor;
  }

  private leaseExpiry(reference: Date): string {
    const base = Math.max(reference.getTime(), this.now().getTime());
    return new Date(base + this.streamLeaseMs).toISOString();
  }

  private renewClaimedLease(
    connectionId: string,
    repositoryId: string,
    stream: MultiremiScmSyncStream,
    leaseToken: string,
    leaseReference: Date,
  ): void {
    const cursor = this.store.updateClaimedSyncCursor({
      connectionId,
      repositoryId,
      stream,
      leaseToken,
      leaseUntil: this.leaseExpiry(leaseReference),
    });
    if (!cursor) throw new ScmStreamLeaseLostError();
  }
}

class ScmStreamLeaseLostError extends Error {}

export function pollIsDue(
  connection: MultiremiScmConnection,
  cursor: MultiremiScmSyncCursor | null,
  now: Date,
): boolean {
  let expiredLease = false;
  if (cursor?.leaseToken) {
    const leaseUntil = cursor.leaseUntil ? Date.parse(cursor.leaseUntil) : Number.NaN;
    if (Number.isFinite(leaseUntil) && leaseUntil > now.getTime()) return false;
    expiredLease = true;
  }
  if (cursor?.suspendedUntil) {
    const suspendedUntil = Date.parse(cursor.suspendedUntil);
    if (Number.isFinite(suspendedUntil) && suspendedUntil > now.getTime()) return false;
  }
  if (expiredLease) return true;
  if (cursor?.cursor) return true;
  const latest = cursor?.lastStartedAt || cursor?.lastCompletedAt;
  if (!latest) return true;
  const timestamp = Date.parse(latest);
  if (!Number.isFinite(timestamp)) return true;
  const baseIntervalSeconds = Math.max(10, connection.pollIntervalSeconds);
  const consecutiveFailures = Math.max(
    0,
    Math.floor(cursor?.consecutiveFailures ?? (cursor?.lastError ? 1 : 0)),
  );
  const backoffMultiplier = 2 ** Math.min(Math.max(0, consecutiveFailures - 1), 30);
  const intervalSeconds = consecutiveFailures > 0
    ? Math.min(Math.max(baseIntervalSeconds, MAX_ERROR_BACKOFF_SECONDS), baseIntervalSeconds * backoffMultiplier)
    : baseIntervalSeconds;
  return now.getTime() - timestamp >= intervalSeconds * 1_000;
}

function pollingCycle(
  cursor: MultiremiScmSyncCursor,
  fallbackStartedAt: Date,
): { cycleStartedAt: Date; providerCursor: Record<string, unknown> | null } {
  const storedCursor = cursor.cursor;
  const envelope = recordValue(storedCursor?.[POLLING_CYCLE_CURSOR_KEY]);
  const encodedStartedAt = stringValue(envelope?.startedAt);
  const encodedTimestamp = Date.parse(encodedStartedAt);
  if (Number.isFinite(encodedTimestamp)) {
    return {
      cycleStartedAt: new Date(encodedTimestamp),
      providerCursor: recordValue(envelope?.providerCursor),
    };
  }
  if (storedCursor) {
    const legacyTimestamp = cursor.lastStartedAt ? Date.parse(cursor.lastStartedAt) : Number.NaN;
    return {
      cycleStartedAt: Number.isFinite(legacyTimestamp) ? new Date(legacyTimestamp) : fallbackStartedAt,
      providerCursor: storedCursor,
    };
  }
  return { cycleStartedAt: fallbackStartedAt, providerCursor: null };
}

function encodePollingCycle(
  cycleStartedAt: Date,
  providerCursor: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    [POLLING_CYCLE_CURSOR_KEY]: {
      startedAt: cycleStartedAt.toISOString(),
      providerCursor,
    },
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pollErrorMessage(
  error: unknown,
  provider: MultiremiScmConnection["provider"],
  stream: MultiremiScmSyncStream,
): string {
  if (error instanceof ScmStreamUnavailableError) return error.message;
  if (error instanceof ScmHttpError) {
    const providerName = provider === "github" ? "GitHub" : "Codebase";
    return `${providerName} ${stream} poll failed: ${error.method} ${requestPath(error.url)} -> ${error.status}`;
  }
  return errorMessage(error);
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
