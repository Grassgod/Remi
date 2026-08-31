import { randomUUID } from "node:crypto";
import {
  MessageProviderError,
  supportsSync,
  type MessageConnection,
  type MessageErrorCode,
  type MessageProvider,
  type MessageProviderContext,
  type MessageSource,
  type MessageSyncCursor,
} from "@multiremi/contracts/messaging.js";
import { createLogger } from "@shared/logger.js";
import type {
  ClaimMessageSyncStreamInput,
  IngestCanonicalMessagesInput,
  IngestCanonicalMessagesResult,
  ReconcileMessageUnprocessedResult,
  UpdateClaimedMessageSyncCursorInput,
  UpsertMessageConnectionInput,
} from "@multiremi/store/repos/messaging-repo.js";
import type { MessageProviderRegistry } from "./registry.js";

const log = createLogger("multiremi-messaging");
const STREAM = "messages";
const UNPROCESSED_STREAM = "unprocessed";
const DEFAULT_TICK_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PAGES_PER_SOURCE = 25;
const DEFAULT_HEALTH_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * How far before the watermark each cycle restarts.
 *
 * Channels order search results by their own clock, so a message can surface
 * slightly after the instant it claims to have been sent. Re-reading a couple
 * of minutes costs nothing — the composite key deduplicates — and it is what
 * stops a late arrival from being skipped for good.
 */
const OVERLAP_MS = 2 * 60 * 1_000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

/** The persistence the Core needs. `MessagingRepo` is the production implementation. */
export interface MessagingStore {
  listSources(input?: { workspaceId?: string | null; enabled?: boolean }): MessageSource[];
  getConnection(id: string): MessageConnection | null;
  upsertConnection(input: UpsertMessageConnectionInput): MessageConnection;
  getSyncCursor(sourceId: string, stream: string): MessageSyncCursor | null;
  claimSyncStream(input: ClaimMessageSyncStreamInput): MessageSyncCursor | null;
  updateClaimedSyncCursor(input: UpdateClaimedMessageSyncCursorInput): MessageSyncCursor | null;
  releaseSyncStream(sourceId: string, stream: string, leaseToken: string): boolean;
  ingestMessages(input: IngestCanonicalMessagesInput): IngestCanonicalMessagesResult;
  recordSourceSuccess(sourceId: string, completedAt: string): void;
  recordSourceFailure(sourceId: string, errorCode: MessageErrorCode, failedAt: string): void;
  hasDueUnprocessedMessages(sourceId: string, now: Date): boolean;
  reconcileUnprocessedMessages(sourceId: string, now: Date, limit?: number): ReconcileMessageUnprocessedResult;
  deleteExpiredMessages(now?: Date): number;
}

export interface MessagingSchedulerOptions {
  store: MessagingStore;
  registry: MessageProviderRegistry;
  tickIntervalMs?: number;
  leaseMs?: number;
  maxPagesPerSource?: number;
  healthIntervalMs?: number;
  leaseOwner?: string;
  now?: () => Date;
}

export interface MessagingRunResult {
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  inserted: number;
  updated: number;
  /** Returned by a Provider but refused by the Core for want of consent. */
  rejected: number;
  deleted: number;
  retried: number;
  dismissed: number;
}

/**
 * Polls every enabled Source through whichever Provider serves its Connection.
 *
 * The scheduler knows nothing about any channel: it resolves a Provider by id
 * from the registry, checks the capability it is about to use, and stores what
 * comes back. Adding a channel is a registration, never a change here.
 */
export class MessagingScheduler {
  private readonly store: MessagingStore;
  private readonly registry: MessageProviderRegistry;
  private readonly tickIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxPagesPerSource: number;
  private readonly healthIntervalMs: number;
  private readonly leaseOwner: string;
  private readonly now: () => Date;
  private readonly inFlight = new Set<string>();
  private readonly healthCheckedAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<MessagingRunResult> | null = null;

  constructor(options: MessagingSchedulerOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.leaseMs = Math.max(30_000, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.maxPagesPerSource = Math.max(1, options.maxPagesPerSource ?? DEFAULT_MAX_PAGES_PER_SOURCE);
    this.healthIntervalMs = Math.max(0, options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
    this.leaseOwner = options.leaseOwner?.trim() || `messaging:${process.pid}:${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce().catch((error) => log.warn(`Initial message sync failed: ${errorLabel(error)}`));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => log.warn(`Message sync tick failed: ${errorLabel(error)}`));
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(now: Date = this.now()): Promise<MessagingRunResult> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.runOnceInternal(now).finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  private async runOnceInternal(now: Date): Promise<MessagingRunResult> {
    const result: MessagingRunResult = {
      attempted: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      inserted: 0,
      updated: 0,
      rejected: 0,
      deleted: this.store.deleteExpiredMessages(now),
      retried: 0,
      dismissed: 0,
    };

    for (const source of this.store.listSources()) {
      const reconciliation = this.reconcileUnprocessed(source, now);
      result.retried += reconciliation.retried;
      result.dismissed += reconciliation.dismissed;
      if (!source.enabled) {
        result.skipped += 1;
        continue;
      }
      const cursor = this.store.getSyncCursor(source.id, STREAM);
      if (source.allowlist.length === 0 || !pollIsDue(source, cursor, now)) {
        result.skipped += 1;
        continue;
      }
      result.attempted += 1;
      const outcome = await this.pollSource(source, cursor, now);
      if (outcome.error) result.failed += 1;
      else if (outcome.completed) result.completed += 1;
      else result.skipped += 1;
      result.inserted += outcome.inserted;
      result.updated += outcome.updated;
      result.rejected += outcome.rejected;
    }
    return result;
  }

  private reconcileUnprocessed(source: MessageSource, now: Date): ReconcileMessageUnprocessedResult {
    if (!this.store.hasDueUnprocessedMessages(source.id, now)) return { retried: 0, dismissed: 0 };
    const lease = this.store.claimSyncStream({
      sourceId: source.id,
      stream: UNPROCESSED_STREAM,
      owner: this.leaseOwner,
      now: now.toISOString(),
      leaseMs: this.leaseMs,
    });
    if (!lease?.leaseToken) return { retried: 0, dismissed: 0 };
    try {
      return this.store.reconcileUnprocessedMessages(source.id, now);
    } finally {
      this.store.releaseSyncStream(source.id, UNPROCESSED_STREAM, lease.leaseToken);
    }
  }

  private async pollSource(
    source: MessageSource,
    previous: MessageSyncCursor | null,
    startedAt: Date,
  ): Promise<{ completed: boolean; inserted: number; updated: number; rejected: number; error: string | null }> {
    if (this.inFlight.has(source.id)) {
      return { completed: false, inserted: 0, updated: 0, rejected: 0, error: null };
    }
    this.inFlight.add(source.id);
    let leaseToken: string | null = null;
    let cursor = previous;
    let inserted = 0;
    let updated = 0;
    let rejected = 0;
    try {
      cursor = this.store.claimSyncStream({
        sourceId: source.id,
        stream: STREAM,
        owner: this.leaseOwner,
        now: startedAt.toISOString(),
        leaseMs: this.leaseMs,
      });
      if (!cursor?.leaseToken) return { completed: false, inserted, updated, rejected, error: null };
      leaseToken = cursor.leaseToken;

      const connection = this.store.getConnection(source.connectionId);
      if (!connection) throw new MessageProviderError("not_found", "Message connection is missing");
      const provider = this.registry.get(connection.provider);
      if (!provider) throw new MessageProviderError("provider_unavailable", "No Provider is registered");
      // Capability is checked before the call, so a Provider that cannot pull is
      // reported as unsupported rather than surfacing as a runtime type error.
      if (!supportsSync(provider)) {
        throw new MessageProviderError("capability_unsupported", "Provider cannot pull messages");
      }

      const context: MessageProviderContext = { connection };
      await this.refreshHealth(provider, context, startedAt);

      const cycle = pollingCycle(source, cursor, startedAt);
      cursor = this.writeClaimedCursor(source.id, leaseToken, cursor, {
        lastStartedAt: startedAt.toISOString(),
        lastError: null,
      });

      let pageCursor = cycle.providerCursor;
      for (let page = 0; page < this.maxPagesPerSource; page += 1) {
        const result = await provider.syncMessages(context, {
          source,
          cursor: pageCursor,
          start: cycle.start,
          end: cycle.end,
        });
        this.renewLease(source.id, leaseToken);
        const ingested = this.store.ingestMessages({
          connectionId: connection.id,
          sourceId: source.id,
          messages: result.messages,
        });
        inserted += ingested.inserted;
        updated += ingested.updated;
        rejected += ingested.skipped;
        pageCursor = result.cursor;
        cursor = this.writeClaimedCursor(source.id, leaseToken, cursor, {
          cursor: result.done ? null : encodeCycle(cycle.start, cycle.end, pageCursor),
          lastError: null,
        });
        if (result.done) {
          const completedAt = this.now().toISOString();
          this.writeClaimedCursor(source.id, leaseToken, cursor, {
            cursor: null,
            // The watermark is the window end, not the newest message: an empty
            // window still means the Source is caught up to that instant.
            watermark: cycle.end.toISOString(),
            lastCompletedAt: completedAt,
            lastError: null,
          });
          this.store.recordSourceSuccess(source.id, completedAt);
          return { completed: true, inserted, updated, rejected, error: null };
        }
      }
      // Page budget spent. The cycle stays in the cursor, so the next tick
      // resumes this window rather than restarting it.
      return { completed: false, inserted, updated, rejected, error: null };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        log.warn(`Message sync lease was lost for source ${source.id}`);
        return { completed: false, inserted, updated, rejected, error: null };
      }
      const code = errorCode(error);
      if (leaseToken && cursor) {
        try {
          this.writeClaimedCursor(source.id, leaseToken, cursor, { lastError: code });
        } catch (writeError) {
          if (!(writeError instanceof LeaseLostError)) throw writeError;
        }
      }
      this.store.recordSourceFailure(source.id, code, this.now().toISOString());
      log.warn(`Message sync failed for source ${source.id}: ${code}`);
      return { completed: false, inserted, updated, rejected, error: code };
    } finally {
      if (leaseToken) this.store.releaseSyncStream(source.id, STREAM, leaseToken);
      this.inFlight.delete(source.id);
    }
  }

  /**
   * Refreshes Connection health at most once per interval, and stops the poll
   * when the Provider is not usable.
   *
   * Failing here rather than on the first page turns an expired login into one
   * clear Connection status instead of a stream of per-Source sync errors.
   */
  private async refreshHealth(
    provider: MessageProvider,
    context: MessageProviderContext,
    now: Date,
  ): Promise<void> {
    const connection = context.connection;
    const last = this.healthCheckedAt.get(connection.id) ?? 0;
    if (this.healthIntervalMs > 0 && now.getTime() - last < this.healthIntervalMs) return;
    this.healthCheckedAt.set(connection.id, now.getTime());

    const health = await provider.checkHealth(context);
    this.store.upsertConnection({
      id: connection.id,
      workspaceId: connection.workspaceId,
      provider: connection.provider,
      channel: connection.channel,
      name: connection.name,
      externalAccountId: health.externalAccountId,
      externalAccountName: health.externalAccountName,
      status: health.status,
      lastCheckedAt: health.checkedAt,
      lastErrorCode: health.errorCode,
      lastErrorAt: health.errorCode ? health.checkedAt : null,
    });
    if (health.status !== "ready") {
      throw new MessageProviderError(health.errorCode ?? "unknown", "Connection is not ready");
    }
  }

  private writeClaimedCursor(
    sourceId: string,
    leaseToken: string,
    current: MessageSyncCursor,
    patch: Partial<Pick<MessageSyncCursor, "cursor" | "watermark" | "lastStartedAt" | "lastCompletedAt" | "lastError">>,
  ): MessageSyncCursor {
    const has = (key: keyof typeof patch): boolean => Object.prototype.hasOwnProperty.call(patch, key);
    const cursor = this.store.updateClaimedSyncCursor({
      sourceId,
      stream: STREAM,
      leaseToken,
      leaseUntil: this.leaseExpiry(),
      cursor: has("cursor") ? patch.cursor ?? null : current.cursor,
      watermark: has("watermark") ? patch.watermark ?? null : current.watermark,
      lastStartedAt: has("lastStartedAt") ? patch.lastStartedAt ?? null : current.lastStartedAt,
      lastCompletedAt: has("lastCompletedAt") ? patch.lastCompletedAt ?? null : current.lastCompletedAt,
      lastError: has("lastError") ? patch.lastError ?? null : current.lastError,
    });
    if (!cursor) throw new LeaseLostError();
    return cursor;
  }

  private renewLease(sourceId: string, leaseToken: string): void {
    const cursor = this.store.updateClaimedSyncCursor({
      sourceId,
      stream: STREAM,
      leaseToken,
      leaseUntil: this.leaseExpiry(),
    });
    if (!cursor) throw new LeaseLostError();
  }

  private leaseExpiry(): string {
    return new Date(this.now().getTime() + this.leaseMs).toISOString();
  }
}

/** Raised when another instance took the lease mid-poll; the tick yields the Source. */
class LeaseLostError extends Error {}

function errorCode(error: unknown): MessageErrorCode {
  return error instanceof MessageProviderError ? error.code : "unknown";
}

function errorLabel(error: unknown): string {
  if (error instanceof MessageProviderError) return error.code;
  return error instanceof Error && error.name ? error.name : "messaging_error";
}

export function pollIsDue(source: MessageSource, cursor: MessageSyncCursor | null, now: Date): boolean {
  if (cursor?.leaseToken) {
    // Someone is polling. Only a lease that has expired may be taken over.
    const leaseUntil = cursor.leaseUntil ? Date.parse(cursor.leaseUntil) : Number.NaN;
    return !Number.isFinite(leaseUntil) || leaseUntil <= now.getTime();
  }
  if (cursor?.cursor) return true;
  const latest = cursor?.lastStartedAt ?? cursor?.lastCompletedAt;
  if (!latest) return true;
  const timestamp = Date.parse(latest);
  if (!Number.isFinite(timestamp)) return true;
  // Back off after a failure so a broken Connection is not retried every tick.
  const seconds = cursor?.lastError
    ? Math.min(60, Math.max(10, source.pollIntervalSeconds * 2))
    : source.pollIntervalSeconds;
  return now.getTime() - timestamp >= seconds * 1_000;
}

function pollingCycle(
  source: MessageSource,
  cursor: MessageSyncCursor | null,
  now: Date,
): { start: Date; end: Date; providerCursor: Record<string, unknown> | null } {
  const stored = cursor?.cursor;
  const startTimestamp = Date.parse(stringValue(stored?.cycleStart));
  const endTimestamp = Date.parse(stringValue(stored?.cycleEnd));
  // A half-finished cycle is resumed on exactly its original window, so paging
  // stays consistent even though `now` has moved on.
  if (Number.isFinite(startTimestamp) && Number.isFinite(endTimestamp)) {
    return {
      start: new Date(startTimestamp),
      end: new Date(endTimestamp),
      providerCursor: recordValue(stored?.providerCursor),
    };
  }
  const earliestAllowed = Math.min(...source.allowlist.map((entry) => Date.parse(entry.addedAt)));
  const watermark = cursor?.watermark ? Date.parse(cursor.watermark) : Number.NaN;
  const desiredStart = (Number.isFinite(watermark) ? watermark : earliestAllowed) - OVERLAP_MS;
  // Never ask a channel for more history than it will serve.
  const minimumStart = now.getTime() - MAX_WINDOW_MS + 60_000;
  return {
    start: new Date(Math.max(desiredStart, minimumStart)),
    end: now,
    providerCursor: null,
  };
}

function encodeCycle(start: Date, end: Date, providerCursor: Record<string, unknown> | null): Record<string, unknown> {
  return { cycleStart: start.toISOString(), cycleEnd: end.toISOString(), providerCursor };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
