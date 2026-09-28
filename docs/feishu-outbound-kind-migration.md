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

The migration adds `unit_key`, `cascade_failure`, and `delivery_mode`. It keeps
existing NULL kinds and uses an expression unique index on
`(task_id, COALESCE(kind, ''), COALESCE(unit_key, ''))`. NULL Task IDs remain
distinct, so E5 decision cards are unaffected. The obsolete single-Task unique
constraint must be relaxed to allow split rows. No delivery data is deleted.
SQLite performs an atomic copy into the new table and retains the original table
as `multiremi_feishu_bot_outbound_deliveries_c5_backup`; PostgreSQL relaxes the
constraint in place. Repeating the migration does not repeat the copy.

## Rollback

Stop background writers and claimers before rolling back; preserve a database
backup first. Do not restore the old `task_id UNIQUE` while split rows exist.
Drain already pinned split Tasks with a capable daemon, then deploy the preceding
server/daemon version with the expanded schema retained. Additive columns and the
expression index can stay. The preceding writers require a single-column conflict
target: add a partial compatibility index or use the documented compatibility
rollback patch rather than silently discarding split history. A physical schema
restore is a separate, approved operation after export and backup; never delete
split rows to force the old constraint to fit.

Implementation and verification details are recorded in the PR as steps land.
