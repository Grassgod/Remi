/**
 * Advisory-lock keys, in one place so two processes cannot disagree about them.
 *
 * `SqlDatabase.advisoryLock` / `advisoryXactLock` hash their key on the Postgres
 * side, so the only thing that has to agree across processes is the literal
 * string. Keeping the literals here (rather than inline at each call site) is
 * what makes that agreement checkable by reading one file.
 *
 * Every key is prefixed by what it guards. That is not decoration: Postgres
 * derives a 32-bit lock id from the string, and the session form and the
 * transaction form share one lock space. Two unrelated subsystems hashing to the
 * same id would serialize against each other (and a process could wait on a lock
 * it already holds), so distinct prefixes keep the namespaces apart by
 * construction instead of by luck.
 */

/**
 * Guards the startup migration run itself (MUL-405).
 *
 * Every process that builds a `MultiremiStore` migrates the same database, and
 * compose starts `api` and `ssh-mesh-control-plane` with no ordering between
 * them, so two first-time runs race on catalog objects.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = "multiremi:migrations:startup";

/**
 * Global lock order (MUL-405). Every transaction that takes more than one of
 * these locks MUST take them in this order, from outermost to innermost:
 *
 *   1. the workspace lifecycle row lock
 *      (`StoreContext.lockWorkspaceRuntimeLifecycle`);
 *   2. a number-allocation advisory lock (this module);
 *   3. domain row locks (Issues, Tasks, Chat sessions, messages, Autopilot
 *      rows, ...).
 *
 * The reason this is written down, rather than only enforced at each call site:
 * `IssuesRepo.createIssue` allocates `issue_number` under the issue number lock
 * and later steps of the same transaction — Task creation, Feishu bindings,
 * Issue Sessions — take the workspace lifecycle row lock. The Feishu ingest path
 * takes that row lock first and the number lock second. Two transactions on
 * those two paths therefore formed a cycle:
 *
 *   Feishu:     workspace row lock  -> issue number lock
 *   Autopilot:  issue number lock   -> workspace row lock
 *
 * which PostgreSQL resolves by killing one of them (`deadlock detected`). The
 * fix is not a new lock: it is taking the workspace row lock before the number
 * lock on every path, which is the order above. `runAutopilot` and the
 * Autopilot schedule expansion now lock the workspace row up front, matching
 * `FeishuBotRepo.submitMessage`.
 *
 * A number lock must never be held while waiting for a workspace row lock.
 */

/**
 * Guards allocation of the next number in a sequence.
 *
 * `scope` identifies the counter: the workspace for issue numbers
 * (`multiremi_issues.issue_number`), the workspace for the Feishu audit trail,
 * and the workspace plus owner for the pinned-item position. Callers must hold
 * it across their read-then-write, not just around the read, and must have taken
 * the workspace lifecycle row lock first when their transaction also needs one
 * (see the lock order above).
 */
export function numberAllocationLockKey(scope: string): string {
  return `multiremi:number:${scope}`;
}
