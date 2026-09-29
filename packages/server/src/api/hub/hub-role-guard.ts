/**
 * The per-role startup guard for the Live Hub (MUL-403 §1 item 7, ADR 0007
 * decision 1).
 *
 * ## What it protects
 *
 * "One hub per API process" is only a correct fan-out if a role has **one**
 * process. Two `runtime` processes would each serve half of a daemon's trace to
 * whichever browser happened to connect, and nothing in a ring would notice. The
 * guard is therefore an advisory lock **per role**, not one global lock:
 *
 * | role | keys taken |
 * |---|---|
 * | `ui` | `remi:hub:ui` |
 * | `runtime` | `remi:hub:runtime` |
 * | `all`, no peer configured | both keys |
 * | `all`, with `MULTIREMI_PEER_URL` set | only `remi:hub:ui` |
 *
 * The last row is the S10 transition: the split topology runs `api=all` beside
 * `api-runtime=runtime`, and an `all` process that insisted on the runtime lock
 * would fight the `runtime` container for it until one of them exited. With a peer
 * configured the `all` process is the `ui` half of that pair, so it takes the ui
 * lock and leaves runtime to its neighbour.
 *
 * ## How it takes them
 *
 * `pg_try_advisory_lock` on a **dedicated long-lived connection** — never the read
 * pool (read-only by construction, so it cannot hold a session lock) and never the
 * synchronous PgBridge. The key is `hashtext('remi:hub:<role>')`, which lives in a
 * namespace of its own: it must not collide with MUL-405's migration constants or
 * with `hashtext(<parent id>)` transaction locks.
 *
 * A failed attempt is retried once a second for {@link HUB_LOCK_TIMEOUT_MS}. Giving
 * up exits non-zero, by which time the updater's `up -d --no-deps` has stopped the
 * old container. A lock connection that dies mid-life takes its locks with it, and
 * the process can no longer prove it is the only one of its role, so that also logs
 * and exits non-zero — compose's `restart: unless-stopped` starts a fresh attempt.
 *
 * Only Postgres deployments lock, and only the API server's startup path calls
 * this: `ssh-mesh-control-plane` runs no hub, and the SQLite arm has no
 * cross-process fan-out to protect.
 */

import { scrubErrorForLog } from "@multiremi/store/db/dsn-redaction.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("hub-role-guard");

/** Lock namespace: `remi:hub:<role>`, distinct from every other advisory lock here. */
export const HUB_LOCK_KEY_PREFIX = "remi:hub:";
/** How long a process keeps retrying a taken lock before it gives up. */
export const HUB_LOCK_TIMEOUT_MS = 30_000;
/** Delay between attempts. */
export const HUB_LOCK_RETRY_MS = 1_000;

export type HubLockRole = "ui" | "runtime";

/** The API process role. MUL-461's `ApiRole` takes this name over when it reaches main. */
export type HubRole = "all" | "ui" | "runtime";

export interface HubRoleGuardLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface HubRoleGuardOptions {
  /** The Postgres URL. Anything else (empty, sqlite) means "no lock needed". */
  databaseUrl: string | null | undefined;
  /** The roles whose locks this process must hold. */
  locks: readonly HubLockRole[];
  timeoutMs?: number;
  retryMs?: number;
  /** Injected for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Injected for tests; defaults to the module logger. */
  logger?: HubRoleGuardLogger;
  /** Postgres backend pid of the locking connection, for logs and tests. */
  onAcquired?: (pid: number) => void;
}

export interface HubRoleGuard {
  /** The roles actually locked, in the order they were taken. */
  readonly held: readonly HubLockRole[];
  /** The locking connection's backend pid, or null when nothing was locked. */
  readonly pid: number | null;
  /** Release every lock and close the dedicated connection. */
  close(): Promise<void>;
}

/**
 * Resolve this process's role from the environment.
 *
 * **Deliberately a local parse, not a `config/api-role.ts` import.** That file
 * belongs to MUL-461, which is still in review; the sub-issue description is
 * explicit that until it reaches main the guard receives `role` as a parameter and
 * does not create the module itself. When MUL-461 merges, this function is replaced
 * by its `resolveApiRole` and the three call sites keep taking a value either way.
 *
 * Unset, empty and unrecognized values all mean `all`, which is the only safe
 * default: a typo must degrade to today's single-process behaviour rather than
 * silently splitting a deployment into roles nobody configured.
 */
export function resolveHubRole(env: string | null | undefined): HubRole {
  const raw = (env ?? "").trim().toLowerCase();
  return raw === "ui" || raw === "runtime" ? raw : "all";
}

/** True when the URL points at Postgres, the only backend with cross-process fan-out. */
export function isPostgresUrl(url: string | null | undefined): boolean {
  return /^postgres(ql)?:\/\//i.test((url ?? "").trim());
}

/**
 * Which locks a role needs.
 *
 * `all` is the interesting row: with a peer configured it is the ui side of a
 * split topology and must leave the runtime lock to the runtime container.
 */
export function locksForRole(role: string, peerConfigured: boolean): HubLockRole[] {
  if (role === "ui") return ["ui"];
  if (role === "runtime") return ["runtime"];
  return peerConfigured ? ["ui"] : ["ui", "runtime"];
}

/** The advisory-lock key name for a role. */
export function hubLockKey(role: HubLockRole): string {
  return `${HUB_LOCK_KEY_PREFIX}${role}`;
}

interface LockingConnection {
  readonly pid: number;
  close(): Promise<void>;
}

/**
 * Open one dedicated connection and take `roles` on it.
 *
 * Every lock goes on the same connection: `pg_advisory_unlock(hashtext($1))`
 * without a backend pid releases the calling session's own locks, so one
 * connection means one release path and no way to leak a lock into a closed pool.
 */
async function takeLocks(
  url: string,
  roles: readonly HubLockRole[],
  timings: { timeoutMs: number; retryMs: number },
  logger: HubRoleGuardLogger,
  exit: (code: number) => void,
  onAcquired?: (pid: number) => void,
): Promise<LockingConnection | null> {
  let closed = false;
  let exitOnClose = false;
  const sql = new Bun.SQL(url, {
    max: 1,
    // A dropped lock connection is terminal: see the file header.
    onclose: (error) => {
      if (closed || !exitOnClose) return;
      logger.error(
        "hub lock connection closed; this process can no longer hold its role and will exit"
        + (error ? `: ${scrubErrorForLog(error)}` : ""),
      );
      exit(1);
    },
  });
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await sql.end({ timeout: 1 });
    } catch {
      // The process is going away; a close failure changes nothing.
    }
  };

  try {
    const rows = await sql.unsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
    const pid = Number(rows[0]?.pid ?? 0);
    const deadline = Date.now() + timings.timeoutMs;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const taken: HubLockRole[] = [];
      for (const role of roles) {
        const result = await sql.unsafe<{ locked: boolean }[]>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          [hubLockKey(role)],
        );
        if (result[0]?.locked !== true) break;
        taken.push(role);
      }
      if (taken.length === roles.length) {
        exitOnClose = true;
        onAcquired?.(pid);
        logger.info(`acquired ${roles.map(hubLockKey).join(", ")} on backend pid ${pid}`);
        return { pid, close };
      }
      // Give back whatever this attempt took, so a failing attempt never leaves a
      // lock behind that the process holding the other key is waiting on.
      for (const role of taken) {
        await sql.unsafe<unknown[]>("SELECT pg_advisory_unlock(hashtext($1)) AS released", [hubLockKey(role)])
          .catch(() => null);
      }
      if (Date.now() >= deadline) {
        logger.error(
          `could not acquire ${roles.map(hubLockKey).join(", ")} within ${timings.timeoutMs}ms `
          + `(attempt ${attempt}); another process of this role is running`,
        );
        await close();
        return null;
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, timings.retryMs); });
    }
  } catch (error) {
    logger.error(`role guard could not reach the database: ${scrubErrorForLog(error)}`);
    await close();
    return null;
  }
}

/**
 * Take the role's locks, or exit non-zero.
 *
 * Returns a guard whose `close()` releases them. A process that never gets them
 * does not return: it logs the reason and exits, which is what turns "two of the
 * same role" into a container restart instead of a silent split-brain.
 */
export async function startHubRoleGuard(options: HubRoleGuardOptions): Promise<HubRoleGuard | null> {
  const logger = options.logger ?? log;
  const exit = options.exit ?? ((code: number) => { process.exit(code); });
  if (!isPostgresUrl(options.databaseUrl)) {
    // The local SQLite arm is one process by construction: nothing to lock.
    return { held: [], pid: null, close: async () => {} };
  }
  if (options.locks.length === 0) return { held: [], pid: null, close: async () => {} };

  const locked = await takeLocks(
    options.databaseUrl!.trim(),
    options.locks,
    {
      timeoutMs: options.timeoutMs ?? HUB_LOCK_TIMEOUT_MS,
      retryMs: options.retryMs ?? HUB_LOCK_RETRY_MS,
    },
    logger,
    exit,
    options.onAcquired,
  );
  if (!locked) {
    logger.error("exiting: this deployment requires the hub role lock and it could not be taken");
    exit(1);
    return null;
  }
  return {
    held: [...options.locks],
    pid: locked.pid,
    close: () => locked.close(),
  };
}
