import { randomUUID } from "node:crypto";
import { createLogger } from "@shared/logger.js";
import type { MultiremiFeishuSource, MultiremiFeishuSyncCursor } from "@multiremi/contracts/types.js";
import { PersonalAutomationFeishuAdapter, PersonalAutomationFeishuError } from "./personal-automation.js";
import type { FeishuIngestionStore, FeishuSourceAdapter } from "./types.js";

const log = createLogger("multiremi-feishu-ingest");
const STREAM = "messages";
const DEFAULT_TICK_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PAGES_PER_SOURCE = 25;
const OVERLAP_MS = 2 * 60 * 1_000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;

export interface FeishuIngestSchedulerOptions {
  store: FeishuIngestionStore;
  adapters?: FeishuSourceAdapter[];
  tickIntervalMs?: number;
  leaseMs?: number;
  maxPagesPerSource?: number;
  leaseOwner?: string;
  now?: () => Date;
}

export interface FeishuIngestRunResult {
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  inserted: number;
  updated: number;
  eventsCreated: number;
  deleted: number;
}

export class FeishuIngestScheduler {
  private readonly store: FeishuIngestionStore;
  private readonly adapters: Map<string, FeishuSourceAdapter>;
  private readonly tickIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxPagesPerSource: number;
  private readonly leaseOwner: string;
  private readonly now: () => Date;
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<FeishuIngestRunResult> | null = null;

  constructor(options: FeishuIngestSchedulerOptions) {
    this.store = options.store;
    this.adapters = new Map(
      (options.adapters ?? [new PersonalAutomationFeishuAdapter()]).map((adapter) => [adapter.type, adapter]),
    );
    this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.leaseMs = Math.max(30_000, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.maxPagesPerSource = Math.max(1, options.maxPagesPerSource ?? DEFAULT_MAX_PAGES_PER_SOURCE);
    this.leaseOwner = options.leaseOwner?.trim() || `feishu-ingest:${process.pid}:${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce().catch((error) => log.warn(`Initial Feishu ingest failed: ${errorMessage(error)}`));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => log.warn(`Feishu ingest tick failed: ${errorMessage(error)}`));
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(now: Date = this.now()): Promise<FeishuIngestRunResult> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.runOnceInternal(now).finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  private async runOnceInternal(now: Date): Promise<FeishuIngestRunResult> {
    const result: FeishuIngestRunResult = {
      attempted: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      inserted: 0,
      updated: 0,
      eventsCreated: 0,
      deleted: this.store.deleteExpiredMessages(now),
    };
    for (const source of this.store.listSources({ enabled: true })) {
      const adapter = this.adapters.get(source.type);
      const cursor = this.store.getSyncCursor(source.id, STREAM);
      if (!adapter || source.allowlist.length === 0 || !feishuPollIsDue(source, cursor, now)) {
        result.skipped += 1;
        continue;
      }
      result.attempted += 1;
      const sourceResult = await this.pollSource(source, cursor, adapter, now);
      if (sourceResult.error) result.failed += 1;
      else if (sourceResult.completed) result.completed += 1;
      else result.skipped += 1;
      result.inserted += sourceResult.inserted;
      result.updated += sourceResult.updated;
      result.eventsCreated += sourceResult.eventsCreated;
    }
    return result;
  }

  private async pollSource(
    source: MultiremiFeishuSource,
    previous: MultiremiFeishuSyncCursor | null,
    adapter: FeishuSourceAdapter,
    startedAt: Date,
  ): Promise<{ completed: boolean; inserted: number; updated: number; eventsCreated: number; error: string | null }> {
    if (this.inFlight.has(source.id)) {
      return { completed: false, inserted: 0, updated: 0, eventsCreated: 0, error: null };
    }
    this.inFlight.add(source.id);
    let leaseToken: string | null = null;
    let cursor = previous;
    let inserted = 0;
    let updated = 0;
    let eventsCreated = 0;
    try {
      cursor = this.store.claimSyncStream({
        sourceId: source.id,
        stream: STREAM,
        owner: this.leaseOwner,
        now: startedAt.toISOString(),
        leaseMs: this.leaseMs,
      });
      if (!cursor?.leaseToken) {
        return { completed: false, inserted, updated, eventsCreated, error: null };
      }
      leaseToken = cursor.leaseToken;
      const cycle = pollingCycle(source, cursor, startedAt);
      cursor = this.writeClaimedCursor(source.id, leaseToken, cursor, {
        lastStartedAt: startedAt.toISOString(),
        lastError: null,
      });
      let pageCursor = cycle.providerCursor;
      for (let page = 0; page < this.maxPagesPerSource; page += 1) {
        const result = await adapter.poll({
          source,
          cursor: pageCursor,
          start: cycle.start,
          end: cycle.end,
          heartbeat: () => this.renewLease(source.id, leaseToken!),
        });
        this.renewLease(source.id, leaseToken);
        const ingested = this.store.ingestBatch(source.id, result.messages);
        inserted += ingested.inserted;
        updated += ingested.updated;
        if (ingested.eventId) eventsCreated += 1;
        pageCursor = result.cursor;
        cursor = this.writeClaimedCursor(source.id, leaseToken, cursor, {
          cursor: result.done ? null : encodeCycle(cycle.start, cycle.end, pageCursor),
          lastError: null,
        });
        if (result.done) {
          const completedAt = this.now().toISOString();
          this.writeClaimedCursor(source.id, leaseToken, cursor, {
            cursor: null,
            watermark: cycle.end.toISOString(),
            lastCompletedAt: completedAt,
            lastError: null,
          });
          return { completed: true, inserted, updated, eventsCreated, error: null };
        }
      }
      return { completed: false, inserted, updated, eventsCreated, error: null };
    } catch (error) {
      if (error instanceof FeishuLeaseLostError) {
        log.warn(`Feishu ingest lease was lost for source ${source.id}`);
        return { completed: false, inserted, updated, eventsCreated, error: null };
      }
      const message = errorMessage(error).slice(0, 500);
      if (leaseToken && cursor) {
        try {
          this.writeClaimedCursor(source.id, leaseToken, cursor, { lastError: message });
        } catch (writeError) {
          if (!(writeError instanceof FeishuLeaseLostError)) throw writeError;
        }
      }
      log.warn(`Feishu ingest failed for source ${source.id}: ${message}`);
      return { completed: false, inserted, updated, eventsCreated, error: message };
    } finally {
      if (leaseToken) this.store.releaseSyncStream(source.id, STREAM, leaseToken);
      this.inFlight.delete(source.id);
    }
  }

  private writeClaimedCursor(
    sourceId: string,
    leaseToken: string,
    current: MultiremiFeishuSyncCursor,
    patch: Partial<Pick<MultiremiFeishuSyncCursor, "cursor" | "watermark" | "lastStartedAt" | "lastCompletedAt" | "lastError">>,
  ): MultiremiFeishuSyncCursor {
    const cursor = this.store.updateClaimedSyncCursor({
      sourceId,
      stream: STREAM,
      leaseToken,
      leaseUntil: this.leaseExpiry(),
      cursor: Object.prototype.hasOwnProperty.call(patch, "cursor") ? patch.cursor ?? null : current.cursor,
      watermark: Object.prototype.hasOwnProperty.call(patch, "watermark") ? patch.watermark ?? null : current.watermark,
      lastStartedAt: Object.prototype.hasOwnProperty.call(patch, "lastStartedAt")
        ? patch.lastStartedAt ?? null
        : current.lastStartedAt,
      lastCompletedAt: Object.prototype.hasOwnProperty.call(patch, "lastCompletedAt")
        ? patch.lastCompletedAt ?? null
        : current.lastCompletedAt,
      lastError: Object.prototype.hasOwnProperty.call(patch, "lastError") ? patch.lastError ?? null : current.lastError,
    });
    if (!cursor) throw new FeishuLeaseLostError();
    return cursor;
  }

  private renewLease(sourceId: string, leaseToken: string): void {
    const cursor = this.store.updateClaimedSyncCursor({
      sourceId,
      stream: STREAM,
      leaseToken,
      leaseUntil: this.leaseExpiry(),
    });
    if (!cursor) throw new FeishuLeaseLostError();
  }

  private leaseExpiry(): string {
    return new Date(this.now().getTime() + this.leaseMs).toISOString();
  }
}

class FeishuLeaseLostError extends Error {}

export function feishuPollIsDue(
  source: MultiremiFeishuSource,
  cursor: MultiremiFeishuSyncCursor | null,
  now: Date,
): boolean {
  if (cursor?.leaseToken) {
    const leaseUntil = cursor.leaseUntil ? Date.parse(cursor.leaseUntil) : Number.NaN;
    return !Number.isFinite(leaseUntil) || leaseUntil <= now.getTime();
  }
  if (cursor?.cursor) return true;
  const latest = cursor?.lastStartedAt ?? cursor?.lastCompletedAt;
  if (!latest) return true;
  const timestamp = Date.parse(latest);
  if (!Number.isFinite(timestamp)) return true;
  const seconds = cursor?.lastError
    ? Math.min(60, Math.max(10, source.pollIntervalSeconds * 2))
    : source.pollIntervalSeconds;
  return now.getTime() - timestamp >= seconds * 1_000;
}

function pollingCycle(
  source: MultiremiFeishuSource,
  cursor: MultiremiFeishuSyncCursor | null,
  now: Date,
): { start: Date; end: Date; providerCursor: Record<string, unknown> | null } {
  const stored = cursor?.cursor;
  const startValue = stringValue(stored?.cycleStart);
  const endValue = stringValue(stored?.cycleEnd);
  const startTimestamp = Date.parse(startValue);
  const endTimestamp = Date.parse(endValue);
  if (Number.isFinite(startTimestamp) && Number.isFinite(endTimestamp)) {
    return {
      start: new Date(startTimestamp),
      end: new Date(endTimestamp),
      providerCursor: recordValue(stored?.providerCursor),
    };
  }
  const earliestAllowed = Math.min(...source.allowlist.map((entry) => Date.parse(entry.addedAt)));
  const watermark = cursor?.watermark ? Date.parse(cursor.watermark) : Number.NaN;
  const desiredStart = Number.isFinite(watermark)
    ? watermark - OVERLAP_MS
    : earliestAllowed - OVERLAP_MS;
  const minimumStart = now.getTime() - MAX_WINDOW_MS + 60_000;
  return {
    start: new Date(Math.max(desiredStart, minimumStart)),
    end: now,
    providerCursor: null,
  };
}

function encodeCycle(start: Date, end: Date, providerCursor: Record<string, unknown> | null): Record<string, unknown> {
  return {
    cycleStart: start.toISOString(),
    cycleEnd: end.toISOString(),
    providerCursor,
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
  if (error instanceof PersonalAutomationFeishuError) return error.code;
  return error instanceof Error && error.name ? error.name : "feishu_ingest_error";
}
