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
 * Guards allocation of the next number in a sequence.
 *
 * `scope` identifies the counter: the workspace for issue numbers
 * (`multiremi_issues.issue_number`), and the workspace plus owner for the
 * pinned-item position. Callers must hold it across their read-then-write, not
 * just around the read.
 */
export function numberAllocationLockKey(scope: string): string {
  return `multiremi:number:${scope}`;
}
