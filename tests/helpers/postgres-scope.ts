import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dual-dialect suites whose PostgreSQL run is skipped. This list is the only
 * switch: a suite not listed here keeps both dialects, and a listed suite
 * still runs every case on SQLite. Rule and review checklist: TESTING.md
 * "PostgreSQL 覆盖范围"; tests/arch/postgres-scope.test.ts enforces the list.
 *
 * List a suite only when its PostgreSQL case is the same business scenario on
 * the fixed schema, with no dialect branch in its assertions, no locks,
 * transactions/rollback/fault injection, concurrency or extra processes, no
 * migrations, no clock control or stale/expiry/lease/reminder timestamps, no
 * read pool, no large-reply limits and no query/statement counts, and no
 * PostgreSQL bug fix in its history. The reason is one line.
 */
export const SQLITE_ONLY_SUITES: Readonly<Record<string, string>> = {
  "tests/unit/daemon/turn-offer-bootstrap.test.ts":
    "Cold offer accept/reject keeps or resets read progress; sequential Store calls only.",
  "tests/unit/multiremi/chat-turn-creator-retry.test.ts":
    "Chat creator retry rules; sequential Store calls, no rollback or timing.",
  "tests/unit/multiremi/conversation-log-delegation-report.test.ts":
    "Delegation report rows and a source scan of the report writers; identical rows on both dialects.",
  "tests/unit/multiremi/inbox-chat-terminal-rering.test.ts":
    "Chat terminal re-ring order by seq on one committed baseline; no locks, faults or timing.",
  "tests/unit/multiremi/inbox-dispatch-entrypoints.test.ts":
    "Unified dispatch entry points route to the same Store calls; no dialect-specific SQL asserted.",
  "tests/unit/multiremi/inbox-operations.test.ts":
    "Message edit/delete/dispatch business rules; sequential, no faults or timing.",
  "tests/unit/multiremi/issue-done-rule.test.ts":
    "Issue done-rule validation; application checks over ordinary rows.",
  "tests/unit/multiremi/issue-responsibility-resolver.test.ts":
    "Responsibility resolution over the parent chain; read-only, no dialect branch.",
  "tests/unit/multiremi/lane-background-wake.test.ts":
    "Background wake routing and outbound rows; no locks, faults or timing.",
  "tests/unit/multiremi/multiremi-api-chat-queue.test.ts":
    "Chat follow-up queue HTTP API; revision conflicts are sequential application checks.",
  "tests/unit/multiremi/multiremi-delegation-lineage-guard.test.ts":
    "MUL-456 lineage guard business rules; sequential Store and API calls.",
  "tests/unit/multiremi/multiremi-re-ring-delegation-lineage.test.ts":
    "Lineage carried through a re-ring; the sweep's PostgreSQL path stays in multiremi-re-ring-sweep.",
  "tests/unit/multiremi/multiremi-universal-delegation.test.ts":
    "MUL-510 delegation and return flows; sequential, the sweep's PostgreSQL path stays in multiremi-re-ring-sweep.",
  "tests/unit/multiremi/pending-turn-offer-requeue.test.ts":
    "Pending-turn offer rescind and requeue rules; sequential, no faults or timing.",
  "tests/unit/multiremi/project-execution-defaults.test.ts":
    "Project execution-default API; ordinary rows, no dialect branch.",
  "tests/unit/multiremi/task-activity-report.test.ts":
    "Task activity report projection; identical rows on both dialects.",
  "tests/unit/multiremi/task-offer-session-input.test.ts":
    "Offer input assembly and seq-cursor paging; the injected faults are in logging and services, not SQL.",
  "tests/unit/multiremi/turn-input-complete.test.ts":
    "Turn input acknowledgement by read cursor seq; sequential, no faults or timing.",
  "tests/unit/remi/cli-collaboration.test.ts":
    "CLI argument and HTTP shape tests; the one Store case reads delivery state with ordinary SQL.",
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The repository-relative path used as the list key (pass `import.meta.path`). */
export function postgresScopeKey(testFile: string): string {
  return relative(ROOT, testFile).split(sep).join("/");
}

function isPostgres(backend: string | { name: string }): boolean {
  const name = typeof backend === "string" ? backend : backend.name;
  return /^(pg|postgres|postgresql)$/i.test(name);
}

/** The backends this suite runs: all of them, minus PostgreSQL for a listed suite. */
export function backendsInScope<T extends string | { name: string }>(testFile: string, backends: readonly T[]): T[] {
  if (!Object.hasOwn(SQLITE_ONLY_SUITES, postgresScopeKey(testFile))) return [...backends];
  return backends.filter(backend => !isPostgres(backend));
}
