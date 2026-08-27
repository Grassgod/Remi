import { createId, nowIso } from "@multiremi/ids.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { parseJson, toJson } from "@multiremi/store/helpers.js";
import type {
  CreatePlatformOperationInput,
  MultiremiPlatformDeploymentDriver,
  MultiremiPlatformAutoUpdateResult,
  MultiremiPlatformOperation,
  MultiremiPlatformOperationStatus,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts/types.js";
import {
  computeDailyScheduleNextRun,
  DEFAULT_PLATFORM_UPDATE_TIME,
  DEFAULT_PLATFORM_UPDATE_TIMEZONE,
} from "@multiremi/store/schedule.js";

type Row = Record<string, unknown>;

const TERMINAL_STATUSES = new Set<MultiremiPlatformOperationStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** Cancellation is only honored before the container-switch phase begins. */
const CANCELLABLE_STATUSES = new Set<MultiremiPlatformOperationStatus>([
  "queued",
  "preparing",
  "pulling",
  "draining",
]);

export function isTerminalPlatformOperationStatus(status: MultiremiPlatformOperationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class PlatformOperationConflictError extends Error {
  readonly code = "platform_operation_active";
}

export class PlatformOperationNotCancellableError extends Error {
  readonly code = "platform_operation_not_cancellable";
}

export interface PlatformStateRecord {
  driver: MultiremiPlatformDeploymentDriver;
  currentRelease: MultiremiPlatformRelease | null;
  latestRelease: MultiremiPlatformRelease | null;
  recentReleases: MultiremiPlatformRelease[];
  services: MultiremiPlatformService[];
  autoUpdateStable: boolean;
  autoUpdateTime: string;
  autoUpdateTimezone: string;
  autoUpdateNextCheckAt: string | null;
  autoUpdateLastCheckedAt: string | null;
  autoUpdateLastResult: MultiremiPlatformAutoUpdateResult | null;
  updaterHeartbeatAt: string | null;
}

export interface PlatformAutoUpdateSettingsInput {
  enabled: boolean;
  time: string;
  timezone: string;
}

export class PlatformOperationsRepo {
  constructor(private readonly db: SqlDatabase) {}

  getState(): PlatformStateRecord {
    this.ensureState();
    const row = this.db.query("SELECT * FROM multiremi_platform_state WHERE id = 'platform'").get() as Row;
    return toState(row);
  }

  setAutoUpdateStable(enabled: boolean): PlatformStateRecord {
    const current = this.getState();
    return this.setAutoUpdateSettings({
      enabled,
      time: current.autoUpdateTime,
      timezone: current.autoUpdateTimezone,
    });
  }

  setAutoUpdateSettings(input: PlatformAutoUpdateSettingsInput, at: Date = new Date()): PlatformStateRecord {
    this.ensureState();
    const now = at.toISOString();
    const nextCheckAt = input.enabled
      ? computeDailyScheduleNextRun(input.time, input.timezone, at)
      : null;
    this.db.run(
      `UPDATE multiremi_platform_state
       SET auto_update_stable = ?, auto_update_time = ?, auto_update_timezone = ?,
           auto_update_next_check_at = ?, updated_at = ?
       WHERE id = 'platform'`,
      [input.enabled ? 1 : 0, input.time, input.timezone, nextCheckAt, now],
    );
    return this.getState();
  }

  claimDueAutoUpdateCheck(at: Date = new Date()): PlatformStateRecord | null {
    const current = this.getState();
    if (!current.autoUpdateStable) return null;
    const now = at.toISOString();
    const dueAt = current.autoUpdateNextCheckAt;
    if (!dueAt || !Number.isFinite(Date.parse(dueAt))) {
      const nextCheckAt = computeDailyScheduleNextRun(current.autoUpdateTime, current.autoUpdateTimezone, at);
      if (dueAt) {
        this.db.run(
          `UPDATE multiremi_platform_state
           SET auto_update_next_check_at = ?, updated_at = ?
           WHERE id = 'platform' AND auto_update_stable = 1 AND auto_update_next_check_at = ?`,
          [nextCheckAt, now, dueAt],
        );
      } else {
        this.db.run(
          `UPDATE multiremi_platform_state
           SET auto_update_next_check_at = ?, updated_at = ?
           WHERE id = 'platform' AND auto_update_stable = 1 AND auto_update_next_check_at IS NULL`,
          [nextCheckAt, now],
        );
      }
      return null;
    }
    if (Date.parse(dueAt) > at.getTime()) return null;
    const nextCheckAt = computeDailyScheduleNextRun(current.autoUpdateTime, current.autoUpdateTimezone, at);
    const result = this.db.run(
      `UPDATE multiremi_platform_state
       SET auto_update_next_check_at = ?, auto_update_last_checked_at = ?,
           auto_update_last_result = 'checking', updated_at = ?
       WHERE id = 'platform' AND auto_update_stable = 1 AND auto_update_next_check_at = ?`,
      [nextCheckAt, now, now, dueAt],
    );
    return result.changes > 0 ? this.getState() : null;
  }

  setAutoUpdateResult(result: MultiremiPlatformAutoUpdateResult): PlatformStateRecord {
    this.ensureState();
    this.db.run(
      "UPDATE multiremi_platform_state SET auto_update_last_result = ?, updated_at = ? WHERE id = 'platform'",
      [result, nowIso()],
    );
    return this.getState();
  }

  heartbeat(input: {
    driver: MultiremiPlatformDeploymentDriver;
    currentRelease?: MultiremiPlatformRelease | null;
    latestRelease?: MultiremiPlatformRelease | null;
    recentReleases?: MultiremiPlatformRelease[];
    services?: MultiremiPlatformService[];
  }): PlatformStateRecord {
    this.ensureState();
    const current = this.getState();
    const now = nowIso();
    this.db.run(
      `UPDATE multiremi_platform_state
       SET driver = ?, current_release = ?, latest_release = ?, recent_releases = ?, services = ?,
           updater_heartbeat_at = ?, updated_at = ?
       WHERE id = 'platform'`,
      [
        input.driver,
        toJson(input.currentRelease === undefined ? current.currentRelease : input.currentRelease),
        toJson(input.latestRelease === undefined ? current.latestRelease : input.latestRelease),
        toJson(input.recentReleases ?? current.recentReleases),
        toJson(input.services ?? current.services),
        now,
        now,
      ],
    );
    return this.getState();
  }

  create(input: CreatePlatformOperationInput, requestedBy: string): MultiremiPlatformOperation {
    const state = this.getState();
    const id = createId("pop");
    const now = nowIso();
    try {
      this.db.run(
        `INSERT INTO multiremi_platform_operations (
          id, kind, status, driver, active_slot, target_version, target_ref,
          target_manifest, progress, requested_by, created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, 1, ?, ?, ?, '{}', ?, ?, ?)`,
        [
          id,
          input.kind,
          state.driver,
          input.targetVersion ?? null,
          input.targetRef ?? null,
          toJson(input.targetManifest ?? {}),
          requestedBy,
          now,
          now,
        ],
      );
    } catch (error) {
      const message = String((error as Error).message ?? error).toLowerCase();
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new PlatformOperationConflictError("another platform operation is already active");
      }
      throw error;
    }
    return this.get(id)!;
  }

  get(id: string): MultiremiPlatformOperation | null {
    const row = this.db.query("SELECT * FROM multiremi_platform_operations WHERE id = ?").get(id) as Row | null;
    return row ? toOperation(row) : null;
  }

  active(): MultiremiPlatformOperation | null {
    const row = this.db.query(
      "SELECT * FROM multiremi_platform_operations WHERE active_slot = 1 ORDER BY created_at ASC LIMIT 1",
    ).get() as Row | null;
    return row ? toOperation(row) : null;
  }

  list(limit = 20): MultiremiPlatformOperation[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.query(
      "SELECT * FROM multiremi_platform_operations ORDER BY created_at DESC LIMIT ?",
    ).all(safeLimit) as Row[];
    return rows.map(toOperation);
  }

  claim(): MultiremiPlatformOperation | null {
    const pending = this.db.query(
      "SELECT id, status FROM multiremi_platform_operations WHERE active_slot = 1 ORDER BY created_at ASC LIMIT 1",
    ).get() as { id?: string; status?: string } | null;
    if (!pending?.id) return null;
    if (pending.status !== "queued") return this.get(pending.id);
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_platform_operations
       SET status = 'preparing', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      [now, now, pending.id],
    );
    return result.changes > 0 ? this.get(pending.id) : null;
  }

  /**
   * Operator-initiated cancellation. A queued operation cancels immediately;
   * a claimed pre-switch operation is flagged and the updater finalizes it
   * (releasing the drain lease it may hold). From `switching` on, cancellation
   * is rejected — the container swap is already in flight.
   */
  requestCancel(id: string): MultiremiPlatformOperation {
    const current = this.get(id);
    if (!current) throw new PlatformOperationNotCancellableError("operation not found");
    if (TERMINAL_STATUSES.has(current.status) || !CANCELLABLE_STATUSES.has(current.status)) {
      throw new PlatformOperationNotCancellableError(
        `operation is ${current.status} and can no longer be cancelled`,
      );
    }
    const now = nowIso();
    if (current.status === "queued") {
      const result = this.db.run(
        `UPDATE multiremi_platform_operations
         SET status = 'cancelled', cancel_requested = 1, active_slot = NULL, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'queued'`,
        [now, now, id],
      );
      if (result.changes > 0) return this.get(id)!;
      // Lost the race to the updater's claim — fall through to the flag path.
    }
    this.db.run(
      `UPDATE multiremi_platform_operations SET cancel_requested = 1, updated_at = ? WHERE id = ?`,
      [now, id],
    );
    return this.get(id)!;
  }

  report(id: string, input: ReportPlatformOperationInput): MultiremiPlatformOperation | null {
    const current = this.get(id);
    if (!current) return null;
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const now = nowIso();
    const terminal = TERMINAL_STATUSES.has(input.status);
    this.db.run(
      `UPDATE multiremi_platform_operations
       SET status = ?, progress = ?, output = ?, error = ?, previous_release = ?, result_release = ?,
           active_slot = ?, updated_at = ?, finished_at = ?
       WHERE id = ?`,
      [
        input.status,
        toJson(input.progress ?? current.progress),
        input.output === undefined ? current.output : input.output,
        input.error === undefined ? current.error : input.error,
        toJson(input.previousRelease === undefined ? current.previousRelease : input.previousRelease),
        toJson(input.resultRelease === undefined ? current.resultRelease : input.resultRelease),
        terminal ? null : 1,
        now,
        terminal ? now : null,
        id,
      ],
    );
    return this.get(id);
  }

  private ensureState(): void {
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_platform_state (id, driver, created_at, updated_at)
       VALUES ('platform', 'systemd_release', ?, ?) ON CONFLICT(id) DO NOTHING`,
      [now, now],
    );
  }
}

function toState(row: Row): PlatformStateRecord {
  return {
    driver: String(row.driver ?? "systemd_release") as MultiremiPlatformDeploymentDriver,
    currentRelease: parseNullableRelease(row.current_release),
    latestRelease: parseNullableRelease(row.latest_release),
    recentReleases: parseJson<MultiremiPlatformRelease[]>(row.recent_releases, []),
    services: parseJson<MultiremiPlatformService[]>(row.services, []),
    autoUpdateStable: Number(row.auto_update_stable ?? 0) === 1,
    autoUpdateTime: String(row.auto_update_time ?? DEFAULT_PLATFORM_UPDATE_TIME),
    autoUpdateTimezone: String(row.auto_update_timezone ?? DEFAULT_PLATFORM_UPDATE_TIMEZONE),
    autoUpdateNextCheckAt: row.auto_update_next_check_at ? String(row.auto_update_next_check_at) : null,
    autoUpdateLastCheckedAt: row.auto_update_last_checked_at ? String(row.auto_update_last_checked_at) : null,
    autoUpdateLastResult: row.auto_update_last_result
      ? String(row.auto_update_last_result) as MultiremiPlatformAutoUpdateResult
      : null,
    updaterHeartbeatAt: row.updater_heartbeat_at ? String(row.updater_heartbeat_at) : null,
  };
}

function toOperation(row: Row): MultiremiPlatformOperation {
  return {
    id: String(row.id),
    kind: String(row.kind) as MultiremiPlatformOperation["kind"],
    status: String(row.status) as MultiremiPlatformOperationStatus,
    driver: String(row.driver) as MultiremiPlatformDeploymentDriver,
    targetVersion: row.target_version ? String(row.target_version) : null,
    targetRef: row.target_ref ? String(row.target_ref) : null,
    targetManifest: parseJson<Record<string, unknown>>(row.target_manifest, {}),
    progress: parseJson<Record<string, unknown>>(row.progress, {}),
    requestedBy: String(row.requested_by),
    output: row.output ? String(row.output) : null,
    error: row.error ? String(row.error) : null,
    previousRelease: parseNullableRelease(row.previous_release),
    resultRelease: parseNullableRelease(row.result_release),
    cancelRequested: Number(row.cancel_requested ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

function parseNullableRelease(value: unknown): MultiremiPlatformRelease | null {
  return value === null || value === undefined || value === ""
    ? null
    : parseJson<MultiremiPlatformRelease | null>(value, null);
}
