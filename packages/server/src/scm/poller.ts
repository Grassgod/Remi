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
import { reconcileObservation } from "./reconcile.js";
import type { ScmIngestionStore, ScmProviderAdapter } from "./types.js";
import { SCM_SYNC_STREAMS } from "./types.js";

const log = createLogger("multiremi-scm-poller");
const DEFAULT_TICK_INTERVAL_MS = 10_000;
const DEFAULT_MAX_PAGES_PER_TICK = 50;
const DEFAULT_STREAM_LEASE_MS = 5 * 60 * 1_000;

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
    let latestWatermark: string | null = null;
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
      latestWatermark = cursor.watermark;
      cursor = this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
        lastStartedAt: startedAt.toISOString(),
        lastError: null,
      }, startedAt);
      const credential = this.store.getConnectionCredential(connection.id);
      if (!credential) throw new Error("SCM connection credential is unavailable");
      for (let pageNumber = 0; pageNumber < this.maxPagesPerStream; pageNumber += 1) {
        const page = await adapter.poll({
          connection,
          credential,
          binding,
          stream,
          cursor: cursor ? { ...cursor, watermark: previousWatermark } : null,
          now: startedAt,
        });
        cursor = this.writeClaimedCursor(
          connection.id,
          binding.repositoryId,
          stream,
          leaseToken,
          cursor,
          {},
          startedAt,
        );
        latestWatermark = maxTimestamp(latestWatermark, page.watermark);
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
        cursor = this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
          cursor: page.cursor,
          watermark: previousWatermark,
          lastError: null,
        }, startedAt);
        if (page.done) {
          const completedAt = this.now().toISOString();
          cursor = this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
            cursor: null,
            watermark: latestWatermark ?? startedAt.toISOString(),
            baselineCompletedAt: cursor?.baselineCompletedAt ?? completedAt,
            lastCompletedAt: completedAt,
            lastError: null,
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
      const message = errorMessage(error).slice(0, 1_000);
      if (leaseToken) {
        try {
          this.writeClaimedCursor(connection.id, binding.repositoryId, stream, leaseToken, cursor, {
            watermark: previousWatermark,
            lastError: message,
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
      "cursor" | "watermark" | "baselineCompletedAt" | "lastStartedAt" | "lastCompletedAt" | "lastError"
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
    });
    if (!cursor) throw new ScmStreamLeaseLostError();
    return cursor;
  }

  private leaseExpiry(reference: Date): string {
    const base = Math.max(reference.getTime(), this.now().getTime());
    return new Date(base + this.streamLeaseMs).toISOString();
  }
}

class ScmStreamLeaseLostError extends Error {}

export function pollIsDue(
  connection: MultiremiScmConnection,
  cursor: MultiremiScmSyncCursor | null,
  now: Date,
): boolean {
  if (cursor?.leaseToken) {
    const leaseUntil = cursor.leaseUntil ? Date.parse(cursor.leaseUntil) : Number.NaN;
    return !Number.isFinite(leaseUntil) || leaseUntil <= now.getTime();
  }
  if (cursor?.cursor) return true;
  const latest = cursor?.lastStartedAt || cursor?.lastCompletedAt;
  if (!latest) return true;
  const timestamp = Date.parse(latest);
  if (!Number.isFinite(timestamp)) return true;
  const intervalSeconds = cursor?.lastError
    ? Math.min(30, Math.max(10, connection.pollIntervalSeconds))
    : Math.max(10, connection.pollIntervalSeconds);
  return now.getTime() - timestamp >= intervalSeconds * 1_000;
}

function maxTimestamp(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
