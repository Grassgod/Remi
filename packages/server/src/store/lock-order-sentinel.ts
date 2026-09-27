/**
 * Whole-suite enforcement of the MUL-405 lock order (W -> N -> D).
 *
 * The contract lives in `./advisory-locks.ts`: a transaction takes the
 * workspace lifecycle row lock (W), then any number-allocation advisory lock
 * (N), then domain row locks (D). Two earlier QA rounds found real inversions
 * only because a human searched the repository by hand — the enumerated
 * per-path tests in `tests/unit/multiremi/mul405-lock-order-paths.test.ts` are
 * good at pinning the paths they list, and blind to the paths they do not.
 *
 * This module closes that gap: the shared database wrapper classifies every
 * statement of every transaction and throws the moment a class is taken after a
 * higher one. It is therefore a check on the whole suite, not on a list.
 *
 * Rules, matching how a deadlock reads the trace:
 *
 *   - only the FIRST acquisition of each class is ordered; re-taking a lock the
 *     transaction already holds is free in PostgreSQL and the store relies on
 *     it (Feishu ingest takes W, then the Task writer takes W again);
 *   - a class whose first acquisition ranks below a class already acquired is a
 *     violation — `D -> W` and `D -> N` are the shapes that formed the cycle;
 *   - nothing is checked outside a transaction, where "first" has no meaning.
 *
 * Classification. W is the `updated_at = updated_at` workspace row lock. N is
 * any `advisoryXactLock` call. D is any other write: a transaction that writes a
 * domain row has taken a row lock on PostgreSQL, whether or not the statement
 * is a no-op whose only purpose is the lock. That breadth is deliberate — it is
 * what caught `archiveAgent` writing `UPDATE multiremi_agents` before the audit
 * number lock.
 *
 * SQLite has no advisory locks, so on SQLite N never appears and only the W/D
 * relation is enforced. PostgreSQL enforces all three.
 *
 * Enablement: `MULTIREMI_TEST_LOCK_ORDER_SENTINEL=1`, set by the `bun test`
 * preload (`tests/setup/hermetic-env-policy.ts`). It is refused under
 * `NODE_ENV=production` regardless of the variable, and the check is a single
 * cached boolean read when off, so production pays nothing.
 */

export type LockOrderClass = "W" | "N" | "D";

const RANK: Record<LockOrderClass, number> = { W: 0, N: 1, D: 2 };

/** The workspace lifecycle row lock (`StoreContext.lockWorkspaceRuntimeLifecycle`). */
const WORKSPACE_ROW_LOCK = /UPDATE\s+multiremi_workspaces\s+SET\s+updated_at\s*=\s*updated_at/i;

/** Statements that only read; anything else inside a transaction is a D write. */
const READ_ONLY_STATEMENT = /^\s*(?:SELECT|PRAGMA|EXPLAIN|WITH\s+[\s\S]*?SELECT)\b/i;

interface Frame {
  acquired: Set<LockOrderClass>;
  highest: number;
  trace: string[];
}

const frames: Frame[] = [];
let enabledCache: boolean | null = null;

/** True when the sentinel should classify statements. Cached: the env is read once. */
export function lockOrderSentinelEnabled(): boolean {
  if (enabledCache === null) {
    enabledCache = process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL === "1"
      && process.env.NODE_ENV !== "production";
  }
  return enabledCache;
}

/** Test-only escape hatch: forget the cached enablement (used by the guard test). */
export function resetLockOrderSentinelEnabledCache(): void {
  enabledCache = null;
}

/** Outermost transaction opened. Nested `transaction()` calls do not start a frame. */
export function lockOrderSentinelTransactionBegin(): void {
  if (!lockOrderSentinelEnabled()) return;
  frames.push({ acquired: new Set(), highest: -1, trace: [] });
}

/** Outermost transaction closed (commit or rollback). */
export function lockOrderSentinelTransactionEnd(): void {
  if (!lockOrderSentinelEnabled()) return;
  frames.pop();
}

/**
 * Classify one statement. W and D come from SQL; N cannot (it is an advisory
 * lock call, see {@link lockOrderSentinelNoteNumberLock}).
 */
export function lockOrderSentinelNoteStatement(sql: string): void {
  if (!lockOrderSentinelEnabled()) return;
  const frame = frames[frames.length - 1];
  if (!frame) return;
  if (WORKSPACE_ROW_LOCK.test(sql)) {
    record(frame, "W", sql);
    return;
  }
  if (READ_ONLY_STATEMENT.test(sql)) return;
  const translated = sql.replace(/\s+/g, " ").trim();
  if (!translated) return;
  record(frame, "D", translated);
}

/** The database took a number-allocation advisory lock. */
export function lockOrderSentinelNoteNumberLock(key: string): void {
  if (!lockOrderSentinelEnabled()) return;
  const frame = frames[frames.length - 1];
  if (!frame) return;
  record(frame, "N", `pg_advisory_xact_lock(${key})`);
}

function record(frame: Frame, cls: LockOrderClass, detail: string): void {
  const trimmed = detail.slice(0, 140);
  if (frame.acquired.has(cls)) return;
  const rank = RANK[cls];
  if (rank < frame.highest) {
    const order = [...frame.trace, `${cls} ${trimmed}`].join("\n  ");
    throw new Error(
      `MUL-405 lock order violated: first ${cls} acquisition comes after a higher class ` +
        `(W -> N -> D required).\nTrace:\n  ${order}\nStack:\n${new Error().stack ?? "(no stack)"}`,
    );
  }
  frame.acquired.add(cls);
  frame.highest = Math.max(frame.highest, rank);
  frame.trace.push(`${cls} ${trimmed}`);
}
