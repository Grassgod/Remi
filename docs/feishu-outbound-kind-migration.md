# Feishu outbound kind migration (MUL-440)

## Delivery and rollout contract

The daemon declares `feishu_outbound_kinds: 1` on the heartbeat that claims
deliveries. An absent declaration retains the existing single-delivery response
and Task presentation, including the existing checkpoint and message-ID meanings.
A capable daemon receives `pending_feishu_outbounds`, with an independent claim
token and lease for every delivery.

The Task's primary delivery pins `delivery_mode` on its first successful claim.
`legacy` remains legacy through retries and connector handover; `split` is only
claimable by a capable daemon. Previously attempted deliveries and NULL-kind
carriers are always legacy. E5 and other legacy lanes keep their one-row heartbeat
cadence; the upgraded client retains the singular accessor for those rows as an
alias of the same delivery, deduplicated by the daemon's delivery-ID run map.
This prevents a rolling upgrade from presenting the same Task twice. E5 decision
cards and their checkpoint fields are independent of this negotiation.

All rows are written by the server. Split Tasks use `cot`, `interaction_card`,
`result_card`, and `receipt` handlers. Result cards wait for their CoT predecessor
to reach a terminal delivery state; they do not inherit its failure. Receipts are
never predecessors. A receipt's final failure writes audit evidence and a log,
without changing the binding or other deliveries. Each row has the existing
six-attempt limit and its own backoff.

Writers and claims are gated by `MULTIREMI_BACKGROUND_JOBS` (default enabled).
When process roles are introduced, ui runs these jobs and api-runtime explicitly
sets this variable to `0`; the code does not select a role. Background claims
reconcile lifecycle writes missed by a process with jobs disabled. Existing
topic, E5, round and attachment entry points persist their original operation in
`multiremi_feishu_bot_outbound_operations` while jobs are disabled. The background
process replays each under a separate operation lease, using stable delivery IDs
and established idempotent writers. This avoids silently dropping attachments
or topic/round operations during process handover. No Hub or
peer-channel dependency is introduced.

## Schema and retained data

The migration adds `unit_key`, `cascade_failure`, and `delivery_mode`, plus an
`outbound_requested`, nullable `outbound_context` and `outbound_task_id` on inbound deliveries for
background reconciliation (including the original recipient and checkpoint).
`outbound_task_id` follows a recovery retry for split receipts and reconciliation;
the original inbound `task_id` and the legacy receipt-ID lookup retain their
existing meaning. The deferred-operation table above is also additive. It keeps
existing NULL kinds and uses an expression unique index on
`(task_id, COALESCE(kind, ''), COALESCE(unit_key, ''))`. NULL Task IDs remain
distinct, so E5 decision cards are unaffected. The obsolete single-Task unique
constraint must be relaxed to allow split rows. No delivery data is deleted.
SQLite performs an atomic copy into the new table and retains the original table
as `multiremi_feishu_bot_outbound_deliveries_c5_backup`; PostgreSQL relaxes the
constraint in place. Repeating the migration does not repeat the copy.
If an operator has restored a legacy live table beside an existing backup,
SQLite retains another numbered backup instead of overwriting the first one;
index creation checks the live table, not merely a globally occupied name.
PostgreSQL checks `pg_index.indrelid` and the valid, ready btree index's key
expressions, uniqueness and predicate on the live table. An equivalent index is
reused even if renamed. When an archive or another relation occupies a preferred
name, C5 creates the missing index with an available numbered suffix and retains
the archive indexes. It verifies all live definitions before completing the
transaction; a name collision cannot silently satisfy the migration. Repeated
migrations reuse these definitions without creating additional indexes.

## Rollback

The supported behavior rollback is `MULTIREMI_FEISHU_OUTBOUND_KINDS=0` on the
background-writing process. This pins newly claimed Tasks to `legacy`, including
claims by upgraded daemons. Keep capable daemons online until already pinned
split Tasks and their interaction/result/receipt rows reach terminal delivery
states. Their existing IDs, leases and checkpoints do not change. The added
columns and indexes remain; switching the flag back on affects only unclaimed
Tasks. The rollback/drain test exercises this path on real stored rows.

A preceding server binary is **not** compatible with the expanded live table:
its `ON CONFLICT(task_id)` requires an unconditional single-column unique key;
a partial index does not satisfy that conflict target. Do not deploy it directly
over the C5 schema. A physical restore requires a separate approved operation.
The first response after release remains the flag above, without touching the
database or reverting a binary.

The restore target is the outbound table on `origin/main` at `a2ef6f6e7`:
it has the E5 kind, request, patch and degraded columns, plus the later
`decision_id` and `decision_issue_id` columns and decision index. `v0.2.83`
has only the base table and the mention/checkpoint/attachment columns; it lacks
those E5 and decision columns and indexes. The current main schema is the
preceding binary's actual write target and retains E5 rows, so there is no
separate `v0.2.83` restore script. The C5 source must have the two decision
columns before running these scripts (normal after the main migrations are
included in the release). Check this on the intended database first. On
PostgreSQL, main's migration bridge strips SQLite's decorative foreign keys;
the PG restore script follows that actual catalog and does not add them.

The SQL artifacts are [SQLite](feishu-outbound-restore-sqlite.sql) and
[PostgreSQL](feishu-outbound-restore-postgres.sql). Both use `__C5_STAMP__`
as a literal placeholder. Replace every occurrence with one fresh UTC
`YYYYMMDDHHMMSS` value, using only digits, and record that value with the
backup. The resulting archive is `fbo_c5_archive_<stamp>`. Use the same
rendered file for pre-checks and restore; do not maintain another SQL copy.
For example, after stopping writers/claimers and draining active streams, set
`C5_DB` to the local or approved target, `C5_SQLITE_BACKUP` or `C5_PG_BACKUP`
to a separate backup path, and use a fresh stamp. Use a `pg_dump` matching the
server major version:

```sh
C5_STAMP=20260930000000
case "$C5_STAMP" in *[!0-9]*|'') exit 1 ;; esac
test "${#C5_STAMP}" -eq 14 || exit 1

# Run the backup command for the database in use, not both.
sqlite3 "$C5_DB" ".backup '$C5_SQLITE_BACKUP'"
pg_dump -Fc -f "$C5_PG_BACKUP" "$C5_DB"

# SQLite: first inspect the three query results; each must be empty.
sed "s/__C5_STAMP__/$C5_STAMP/g" docs/feishu-outbound-restore-sqlite.sql |
  sed '/^-- TRANSACTION$/,$d' | sqlite3 "$C5_DB"
# Only after zero rows and the manual prerequisites below:
sed "s/__C5_STAMP__/$C5_STAMP/g" docs/feishu-outbound-restore-sqlite.sql |
  sed -n '/^-- TRANSACTION$/,$p' | sqlite3 -bail "$C5_DB"

# PostgreSQL: the script checks and aborts atomically inside BEGIN/COMMIT.
sed "s/__C5_STAMP__/$C5_STAMP/g" docs/feishu-outbound-restore-postgres.sql |
  psql -X -v ON_ERROR_STOP=1 "$C5_DB"

# Run the post-check for the chosen database, then test the old writer.
sqlite3 "$C5_DB" "SELECT (SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries),
  (SELECT COUNT(*) FROM fbo_c5_archive_$C5_STAMP);"
psql -X -v ON_ERROR_STOP=1 "$C5_DB" -c "SELECT
  (SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries) AS live_rows,
  (SELECT COUNT(*) FROM fbo_c5_archive_$C5_STAMP) AS archived_rows;"
```

Do not continue when any SQLite pre-check returns a row. A second check runs
under `BEGIN IMMEDIATE` to close the gap between inspection and writing.
SQLite errors leave the connection's transaction uncommitted; `sqlite3 -bail`
exits without committing it. The SQL transaction section also sets `.bail on`,
so the default `sqlite3 database < rendered.sql` stops on a failed guard.
The SQLite `_c5_backup` table must still exist: the script renames its
ordinary indexes before recreating their original names on the live table.
If using a persistent client, explicitly
`ROLLBACK` after an error. PostgreSQL raises inside its transaction and rolls
back. Reusing a stamp or running against an already-restored live table fails
without replacing an archive.

Physical restore sequence:

1. Pause all writers and claimers, drain active Task streams and split Tasks,
   and take a database backup/export **before** SQL execution. Drain pending
   deferred operations too. On SQLite, verify the C5 `_c5_backup` table exists.
   SQL checks delivery and operation rows, but cannot
   prove the application has stopped writing or that streams are drained.
   SQLite's three pre-check queries must all return zero rows; PostgreSQL
   raises if a split Task lacks one terminal result, any split delivery is not
   `sent`/`failed`, or any deferred operation is not `done`.
2. In one transaction rename the **current**, fully populated outbound table to
   a timestamped C5 archive. Retain the entire archive, including all split rows.
   The SQLite `_c5_backup` is only the pre-migration snapshot, not the latest
   data: restoring it alone would lose deliveries written after migration.
3. Create the live table using the preceding schema with `task_id TEXT UNIQUE`
   and all E5 columns/indexes. Copy all `task_id IS NULL` rows and each Task's
   carrier (`kind IS NULL OR kind='cot'`, `unit_key=''`) from the current archive.
   Project split carriers to legacy terminal state (`sent` when their result is
   sent, otherwise `failed`), final result message ID, and NULL `kind`; preserve
   all other rows and fields. Recreate the original ordinary index names on
   the live table; archive indexes must be renamed first on PostgreSQL, or use
   distinct names on SQLite. This still applies when restoring the preceding
   binary and its original index names. When upgrading the restored live table
   back to C5, renaming archive indexes is optional: C5 chooses available names
   and checks live definitions automatically. The scripts assert copied counts,
   E5 counts and a real unconditional `task_id` unique key on the live table.
   Test the old writer's `ON CONFLICT(task_id)` against new and existing Tasks
   before allowing normal traffic.
4. Deploy the preceding server and daemon. To undo this restore, stop them and
   export and reconcile **all** deliveries written to the temporary legacy
   live table since restoration. Do not discard these writes. Retain that
   table under a fresh `fbo_legacy_after_restore_<stamp>` name, rename the
   complete `fbo_c5_archive_<stamp>` back to the live name in one transaction,
   then run C5 migrations. Compare the exported rows to the resulting live
   table and reconcile missing writes before resuming claimers. C5 can reuse
   equivalent archive index definitions or create available numbered names.

## Restore drill record

On 2026-09-30, local temporary SQLite and PostgreSQL databases were seeded by
the C5 migration at `b688f0988` with one legacy Task, two split Tasks (sent and
failed result/receipt), two E5 NULL-Task rows, a completed deferred operation,
and the SQLite `_c5_backup`. The two `decision_*` columns were added to this
branch's fixture to model the `a2ef6f6e7` release schema. The actual SQL files
linked above were applied with stamp `20260930020202`; each retained **11**
complete C5 rows in `fbo_c5_archive_20260930020202` and copied **5** live rows,
including **2** E5 rows. No production or shared database was touched.

A separate detached `origin/main` checkout at `a2ef6f6e7` started the old
server against each restored database with background jobs off. SQLite logged
`old_server_started port=15933`; PostgreSQL logged
`old_server_started port=31127` under `NODE_ENV=test`. The old
`submitFeishuBotMessage` path created one outbound row for a new Task in each
database. A local-only Task-insert trigger then pre-populated an outbound row
for a second Task; the old writer's `ON CONFLICT(task_id) DO NOTHING` completed
and left exactly that one pre-existing row in each database. The test-only
trigger is not part of the restore artifacts.

The reverse swap was also rehearsed, not merely documented. After stopping the
old server, each database's **2** new legacy outbound rows were copied into
the C5 archive as `delivery_mode='legacy'`; the old live table was retained as
`fbo_legacy_after_restore_20260930020202` (**7** rows). The complete C5 archive
was swapped back, C5 migrations ran again, and both new IDs were found in the
live table: **13** rows on SQLite and **13** on PostgreSQL. The `7`-row old-live
archives remain in the temporary drill databases for inspection until cleanup.

These are local rehearsal results. A real operation still requires an approved
backup, stopped writers/claimers, drained Task streams, and reconciliation of
the actual legacy-period writes before the reverse swap.

No step discards split history or removes added columns from persisted data.
This PR does not execute a production rollback or modify deployment roles.

Implementation and verification details are recorded in the PR as steps land.
