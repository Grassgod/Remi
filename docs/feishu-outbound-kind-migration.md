# Feishu outbound kind migration (MUL-440)

## Delivery and rollout contract

The daemon declares `feishu_outbound_kinds: 1` on the heartbeat that claims
deliveries. An absent declaration retains the existing single-delivery response
and Task presentation, including the existing checkpoint and message-ID meanings.
A capable daemon receives `pending_feishu_outbounds`, with an independent claim
token and lease for every delivery.

The Task's primary delivery pins `delivery_mode` on its first successful claim.
`legacy` remains legacy through retries and connector handover; `split` is only
claimable by a capable daemon. Previously attempted deliveries are always legacy.
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
reconcile lifecycle writes missed by a process with jobs disabled. No Hub or
peer-channel dependency is introduced.

## Schema and retained data

The migration adds `unit_key`, `cascade_failure`, and `delivery_mode`, plus an
`outbound_requested` marker on inbound deliveries for background reconciliation. It keeps
existing NULL kinds and uses an expression unique index on
`(task_id, COALESCE(kind, ''), COALESCE(unit_key, ''))`. NULL Task IDs remain
distinct, so E5 decision cards are unaffected. The obsolete single-Task unique
constraint must be relaxed to allow split rows. No delivery data is deleted.
SQLite performs an atomic copy into the new table and retains the original table
as `multiremi_feishu_bot_outbound_deliveries_c5_backup`; PostgreSQL relaxes the
constraint in place. Repeating the migration does not repeat the copy.

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
over the C5 schema. A physical restore requires a separate approved operation:

1. Pause writers and claimers, drain split Tasks as above, and take a database
   backup/export. Verify every split Task has a terminal result row and every
   split delivery is `sent` or `failed`; active Task streams must also be drained.
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
   distinct names on SQLite. Verify copied counts, E5 rows and unique keys.
4. Deploy the preceding server and daemon. To undo this restore, stop them and
   swap the retained C5 archive back before running C5. Any new deliveries on
   the legacy table must be exported/reconciled before the swap.

No step discards split history or removes added columns from persisted data.
This PR does not execute a production rollback or modify deployment roles.

Implementation and verification details are recorded in the PR as steps land.
