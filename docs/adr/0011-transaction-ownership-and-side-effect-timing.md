# ADR 0011: One outer BEGIN per entry point; savepoints only for cross-repo reuse; side effects after COMMIT

## Status

Accepted (MUL-402, message architecture v2-B; ruling `cmt_96e1yqxgifms`, relayed
to this branch in `cmt_vcepie11nqfp`). It settles the conflict between B1's
nested-transaction shape (MUL-426) and main's depth guards (MUL-400 S1 /
MUL-457, delivered by MUL-405): main's guards and main's `transaction()`
implementation stay, and B1's three nesting sites are reshaped.

It narrows the reading of MUL-402 rulings `cmt_78bx01xhb75x` §2 and
`cmt_gestk2r6imjh` (c) for the entry points listed below: they are not a licence
for a helper to add a transaction frame. `maxTransactionDepth` is main's counter
(MUL-405): it records the deepest nesting reached, every `SAVEPOINT` frame
included, and the depth-1 guards rely on that. MUL-400's ADR 0003 stays as
written; this ADR is the authority for the entry points named here.

## Context

Two independently merged changes disagreed about what a nested
`db.transaction()` means:

- MUL-405 (main) gives `PostgresSyncDatabase.transaction()` a real savepoint
  implementation (`multiremi_sp_N`), `afterCommitFrames`, the lock-order sentinel
  and `maxTransactionDepth`, and documents in its interface that paths with an
  explicit transaction owner **still assert that depth is 1**, "so their helpers
  cannot silently add transaction frames".
- B1 (MUL-426) wrapped best-effort work in savepoints: `queueAgentIssueUpdate`
  and `lookupWorkspace` in `StoreContext.appendIssueActivity`, and
  `getOrCreateDefaultIssueSession` opened its own transaction unconditionally.
  On MUL-444's merged tree that made guarded paths reach depth 2 and 3, and 20
  of the 34 depth guards failed.

A savepoint is not free. Each layer costs two `SAVEPOINT`/`RELEASE` bridge
round trips through `Atomics.wait`, and these entry points are on the hot path
of parent-status updates, task terminal states and comment dispatch. A savepoint
also solves "nesting is safe", not "nesting is free": the guarded entry points
below are exactly the ones whose transaction ownership has to stay greppable —
whoever runs `BEGIN` owns the unit.

## Decision

### 1. Depth 1 is a contract of the guarded entry points, on both backends

The guards (`multiremi-parent-status-tx-depth.test.ts`,
`multiremi-parent-status-pg-depth.test.ts`, 34 cases) keep asserting exactly one
outer `BEGIN`/`COMMIT` — with no extra frame of any kind for these paths — on
SQLite and on real PostgreSQL. Nothing is relaxed to depth 2, and no entry point
is removed from the guard list. This is a convention this codebase imposes, not
a limit of either backend; it holds after MUL-405 introduced savepoints, because
savepoints changed what a nested call *does*, not who is allowed to nest.

### 2. A savepoint has exactly one purpose: making a cross-repo entry point safe to reuse

`IssuesRepo.createIssue` is called both standalone and from
`FeishuBotRepo.submitMessage`, which already owns a transaction. Reuse like that
is what `transaction()`'s savepoint branch exists for: the inner call must not
end the outer unit early, and must not publish anything the outer `ROLLBACK`
would invalidate. A savepoint is a safety net for a caller that cannot know
whether it is already inside a transaction — not a general-purpose wrapper for
helpers that are called from a transaction they did not open.

Helpers that may be reached from inside a caller's transaction check
`db.inTransaction` and pick the flavour accordingly (`db.inTransaction ?
withinTx() : db.transaction(withinTx)()`), so the outside-the-transaction case
keeps its own atomic unit and the inside case adds no frame:

- `getOrCreateDefaultIssueSession` (public form; the `WithinTransaction` form is
  public for the callers that already own the unit, e.g.
  `childDoneReturnSessionId`);
- `createIssueComment`, whose body also writes the session event through
  `appendSessionEventWithinTransaction` rather than opening a second frame.

MUL-482 applies the same ownership rule to task claim/start/complete/fail/cancel,
Issue updates and system comments, messaging outcome Issue creation, and sender allow-list changes. Claim retries
that require candidate rollback are only performed by the transaction owner;
when claim joins an existing unit, errors propagate to its owner instead of
retrying partially written state. Comment edit/delete/resolve/unresolve append
their hidden Session markers with `appendSessionEventWithinTransaction`.

### 3. Best-effort side effects run after COMMIT, not inside a savepoint

Work that must not fail the caller's mutation is queued with
`afterCommit(db, fn)` (MUL-405): with a transaction open it runs after the
outermost `COMMIT` and is dropped by a `ROLLBACK`; with none open it runs
immediately. `queueAgentIssueUpdate` is the first user of it. A helper that only
*reads* (`lookupWorkspace` for the `activity:created` / `comment:created`
broadcast) is not wrapped at all: with B1's bridge-failure classification
(`abortsTransaction`) a failed bridge reply no longer aborts the surrounding
transaction, so what is left reaching the `catch` is a real SQL error — a broken
schema — which should fail the write.

Task event subscribers and Feishu task-delivery materialization, task-message
subscribers, and optional Inbox channel fan-out also use `afterCommit` (MUL-482).
Inbox route matching and pending channel-delivery insertion run after commit;
the existing microtask schedules only the subsequent asynchronous dispatch.
Rolled-back Inbox items therefore cannot dispatch a channel notification, and
optional fan-out SQL failures cannot abort the Inbox writer. Pending channel
delivery insertion remains best-effort: a process exit between the Inbox commit
and that insertion can lose an external notification. The committed Inbox item
remains available. Task terminal automatic replies and collected child follow-up
work likewise wait for the outermost commit.

Inbox envelopes and pending turns are part of the mutation itself, not §3 side effects.
Comment dispatch transaction ownership is classified by who can receive an error
and retry, rather than by caller name. Callers with a retry owner — HTTP/CLI
clients, Organizer action callers, delegation terminal reports retried by the
daemon outbox, and Feishu retries deduped by `external_message_id` — use D1:
dispatch and comment writes share one transaction and fail atomically.
When the platform writes for an agent under a must-not-fail contract with no
retry owner (currently only the two call sites of `postAgentReplyComment`),
402 F1 applies: the reply and its turn card's `final_entry_id` commit together,
while mention dispatch and member notifications run after COMMIT. A dispatch SQL
failure keeps the reply, completes the task and logs one warning. If automatic
replies move into the `task.complete` report with outbox retries, switch them
back to D1. Like the split assignee auto-response, a process exit between the
two commits can lose that wake; both gaps remain follow-ups.

### 4. A swallowed statement failure must surface before COMMIT

An application `catch` around a failed statement inside a transaction leaves
PostgreSQL's transaction aborted. Committing it then returns a `ROLLBACK`
label, and a client that treats that as success loses the whole unit silently.
So `execute()` has a single exit that records `failedAtDepth` (the depth at
which an aborting failure was seen, ignoring `PostgresReplyTooLargeError` and
non-aborting bridge failures), and the outer `COMMIT`:

1. throws `unrecovered statement failure` if `failedAtDepth` is set, before
   sending anything;
2. throws if the reply's command label is `ROLLBACK`;
3. only then runs the `afterCommit` frames.

An inner savepoint `ROLLBACK` clears the mark for depths deeper than the
savepoint it rolled back to. `ROLLBACK TO SAVEPOINT` ends that level as it does
on main; no `RELEASE` follows it.

### 5. SQLite takes the writer lock at the outer transaction boundary

The SQLite `transaction()` proxy uses bun:sqlite's `immediate` variant for the
outermost frame; nested calls remain savepoints. A deferred transaction can
read, then fail immediately on its first write if another connection writes in
between: SQLite calls the busy handler only while no transaction is open, and a
WAL read snapshot cannot be upgraded after another writer commits
(`SQLITE_BUSY_SNAPSHOT`). `busy_timeout` does not make that upgrade wait.

Taking the writer lock at `BEGIN IMMEDIATE` makes SQLite's no-op advisory locks
safe for cross-process read-then-write paths throughout the Store. It does not
add a transaction frame or change the depth-1 contract. PostgreSQL's
transaction function has no `immediate` variant and keeps its existing `BEGIN`
and savepoint behavior.

## Consequences

- The guarded entry points stay a single atomic unit at every nesting depth, and
  their globals (`err`, connection, sequence allocation) are the only ones in
  play. Reviewers can follow `BEGIN` ownership by grepping for `transaction(`.
- Paths that today "silently succeed" by swallowing a statement failure inside a
  transaction will start to throw. That is the bug being fixed; if the full PG
  suite surfaces more of them, each one is treated as a real defect rather than
  relaxed to pass the suite.
- `queueAgentIssueUpdate` moves outside the transaction: a process that dies
  between `COMMIT` and the queue insert loses one queue row. It was already
  warn-and-continue best-effort, and MUL-409's post-commit activity writes
  accepted the same window.
- The guard test headers cite this ADR instead of the superseded rulings. The
  guards count every transaction frame, a `SAVEPOINT` included, on both
  backends; a guard that counted only the outer `BEGIN` would pass a helper's
  extra frame as depth 1 (MUL-402 QA F2/F3, `cmt_1khg3kqww3q5`).
- On multi-process SQLite, even a read-only outer transaction holds the writer
  lock for its synchronous callback. Other writers may wait up to their
  `busy_timeout`; keep these callbacks short. PostgreSQL is unaffected.
