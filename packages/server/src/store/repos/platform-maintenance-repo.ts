import { nowIso } from "@multiremi/ids.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type {
  MultiremiPlatformDrainStatus,
  MultiremiPlatformMaintenance,
} from "@multiremi/contracts/types.js";
import { RUNTIME_HEARTBEAT_STALE_MS } from "./runtimes-repo.js";

type Row = Record<string, unknown>;

export const PLATFORM_DRAIN_DEFAULT_TTL_MS = 120_000;
export const PLATFORM_DRAIN_MIN_TTL_MS = 30_000;
export const PLATFORM_DRAIN_MAX_TTL_MS = 10 * 60_000;

export class PlatformDrainConflictError extends Error {
  readonly code = "platform_drain_conflict";
}

/**
 * Persistent platform maintenance (drain) state. One row, survives API
 * restarts. The lease expiry is enforced lazily on every read: if the updater
 * stops renewing (crash), the next reader observes `normal` and daemons resume
 * claiming on their next heartbeat — no background sweeper required.
 */
export class PlatformMaintenanceRepo {
  constructor(private readonly db: SqlDatabase) {}

  get(nowMs = Date.now()): MultiremiPlatformMaintenance {
    this.ensureRow();
    const maintenance = this.read();
    if (maintenance.mode !== "draining") return maintenance;
    const expiresAt = maintenance.expiresAt ? Date.parse(maintenance.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt > nowMs) return maintenance;
    // Lease expired (or unparsable): auto-recover so a crashed updater can
    // never freeze the platform in draining.
    this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET mode = 'normal', operation_id = NULL, started_at = NULL, expires_at = NULL, reason = NULL, updated_at = ?
       WHERE id = 'platform' AND mode = 'draining'`,
      [nowIso()],
    );
    return this.read();
  }

  /**
   * normal → draining bumps the generation; re-beginning for the same
   * operation is an idempotent lease renewal. A different operation while
   * draining is a conflict (operations are already serialized by active_slot,
   * so this only guards buggy callers).
   */
  beginDrain(input: { operationId: string; reason?: string | null; ttlMs?: number }): MultiremiPlatformMaintenance {
    const current = this.get();
    const ttl = clampTtl(input.ttlMs);
    const now = Date.now();
    const nowStr = nowIso();
    const expiresAt = new Date(now + ttl).toISOString();
    if (current.mode === "draining") {
      if (current.operationId !== input.operationId) {
        throw new PlatformDrainConflictError(
          `platform is already draining for operation ${current.operationId ?? "unknown"}`,
        );
      }
      this.db.run(
        `UPDATE multiremi_platform_maintenance SET expires_at = ?, updated_at = ? WHERE id = 'platform' AND mode = 'draining'`,
        [expiresAt, nowStr],
      );
      return this.read();
    }
    this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET mode = 'draining', generation = generation + 1, operation_id = ?, started_at = ?, expires_at = ?, reason = ?, updated_at = ?
       WHERE id = 'platform' AND mode = 'normal'`,
      [input.operationId, nowStr, expiresAt, input.reason ?? null, nowStr],
    );
    return this.read();
  }

  /** Returns null when the lease is no longer held by this operation. */
  renewDrain(operationId: string, ttlMs?: number): MultiremiPlatformMaintenance | null {
    const current = this.get();
    if (current.mode !== "draining" || current.operationId !== operationId) return null;
    const expiresAt = new Date(Date.now() + clampTtl(ttlMs)).toISOString();
    const result = this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET expires_at = ?, updated_at = ?
       WHERE id = 'platform' AND mode = 'draining' AND operation_id = ?`,
      [expiresAt, nowIso(), operationId],
    );
    return result.changes > 0 ? this.read() : null;
  }

  /** Idempotent: releasing an already-released (or foreign) drain is a no-op. */
  releaseDrain(operationId: string): MultiremiPlatformMaintenance {
    this.ensureRow();
    this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET mode = 'normal', operation_id = NULL, started_at = NULL, expires_at = NULL, reason = NULL, updated_at = ?
       WHERE id = 'platform' AND mode = 'draining' AND operation_id = ?`,
      [nowIso(), operationId],
    );
    return this.get();
  }

  recordRuntimeDrainAck(runtimeId: string, generation: number, activeTasks: number | null): void {
    this.db.run(
      `UPDATE multiremi_runtimes
       SET drain_ack_generation = ?, drain_ack_at = ?, drain_reported_active_tasks = ?
       WHERE id = ?`,
      [Math.max(0, Math.floor(generation)), nowIso(), activeTasks == null ? null : Math.max(0, Math.floor(activeTasks)), runtimeId],
    );
  }

  /**
   * Aggregated drain gate. `ready` requires every effectively-online runtime
   * to have acknowledged the current generation AND the server-authoritative
   * in-flight task count to be zero. Offline runtimes are excluded from the
   * ack quorum, but their unrecovered in-flight tasks still hold the gate —
   * failing safe toward the drain timeout instead of switching under load.
   */
  drainStatus(nowMs = Date.now()): MultiremiPlatformDrainStatus {
    const maintenance = this.get(nowMs);
    const runtimes = this.db.query(
      "SELECT id, name, daemon_id, status, last_heartbeat_at, drain_ack_generation FROM multiremi_runtimes",
    ).all() as Row[];
    const online = runtimes.filter((row) => {
      if (String(row.status ?? "") === "offline") return false;
      const heartbeat = row.last_heartbeat_at ? Date.parse(String(row.last_heartbeat_at)) : Number.NaN;
      return Number.isFinite(heartbeat) && nowMs - heartbeat <= RUNTIME_HEARTBEAT_STALE_MS;
    });
    const acked = online.filter(
      (row) => Number(row.drain_ack_generation ?? -1) >= maintenance.generation,
    );
    const pendingRuntimes = online
      .filter((row) => Number(row.drain_ack_generation ?? -1) < maintenance.generation)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
        daemonId: row.daemon_id ? String(row.daemon_id) : null,
      }));
    const activeRow = this.db.query(
      `SELECT COUNT(*) AS n FROM multiremi_tasks
       WHERE status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')`,
    ).get() as { n?: number } | null;
    const activeTasks = Number(activeRow?.n ?? 0);
    return {
      maintenance,
      onlineDaemons: online.length,
      ackedDaemons: acked.length,
      activeTasks,
      pendingRuntimes,
      ready: maintenance.mode === "draining" && pendingRuntimes.length === 0 && activeTasks === 0,
    };
  }

  private read(): MultiremiPlatformMaintenance {
    const row = this.db.query(
      "SELECT * FROM multiremi_platform_maintenance WHERE id = 'platform'",
    ).get() as Row;
    return {
      mode: String(row.mode ?? "normal") === "draining" ? "draining" : "normal",
      generation: Number(row.generation ?? 0),
      operationId: row.operation_id ? String(row.operation_id) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      reason: row.reason ? String(row.reason) : null,
    };
  }

  private ensureRow(): void {
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_platform_maintenance (id, mode, generation, created_at, updated_at)
       VALUES ('platform', 'normal', 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
      [now, now],
    );
  }
}

function clampTtl(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || ttlMs == null) return PLATFORM_DRAIN_DEFAULT_TTL_MS;
  return Math.max(PLATFORM_DRAIN_MIN_TTL_MS, Math.min(PLATFORM_DRAIN_MAX_TTL_MS, Math.floor(ttlMs)));
}
