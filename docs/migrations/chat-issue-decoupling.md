# MUL-301: Chat / Issue ownership migration

Migration `20260916_chat_issue_decoupling` moves Issue ownership from
`multiremi_chat_sessions.issue_id` to
`multiremi_feishu_bot_chat_bindings.issue_id`. Ordinary Chat create/update APIs no
longer accept Issue ownership. Existing Web/Feishu private conversations retain
their messages and working directories.

## Data transformation

- First consult synchronized Feishu messages for the same workspace and chat,
  with a source belonging to that workspace. Explicit `p2p` evidence prevents
  retaining an Issue association, even if other records claim `group`.
  Uncontradicted `group` evidence preserves the old association. No thread ID or
  `:thread:` key is a conversation-type signal.
- Without synchronized type evidence, preserve canonical
  `chat_issue_topic_<issueId>` bindings (including undelivered roots), or an
  automatic group Issue whose `feishu_bot_message` creation source matches the
  exact binding's destination and inbound delivery in the same workspace.
- Write every evaluated Feishu association, both preserved and discarded, to
  `multiremi_feishu_bot_issue_link_audit`. This permanent operator-only record
  contains the original Issue, complete identity/destination and subscription
  snapshots, disposition, independent canonical/marker/synchronized-type evidence
  flags, and the precedence-ordered decision reason. Evidence flags can overlap;
  `p2p_evidence` always overrides preservation. Other associations use reasons
  `canonical_topic`, `creation_provenance`, `synced_group` or `unproven_ownership`.
  Discarded associations have no active Issue binding. The audit table has **no runtime readers**: incoming messages never
  restore ownership, create summaries or replay old notifications from it.
  Private Web associations are discarded. No live Feishu lookup is required.
- A proactive destination is valid only when binding, push and task have the
  same non-null Issue and agree on workspace, Chat and Agent identity. Missing
  bindings and all mismatches fail closed. In the migration transaction, cancel
  invalid queued/dispatched wake tasks, revoke their task access tokens, delete
  unsent proactive work-round/human-request outbox entries, and remove unconsumed
  work-round system steering for those invalid destinations. This also settles
  Issue A's old notifications after the topic was rebound to Issue B; keeping B's
  valid binding does not authorize A's pending work. Valid tasks/queues survive.
- Keep ordinary user tasks, steering, replies and attachments. Clear surviving
  outbox dependencies on deleted notifications so ordinary attachments can
  proceed. Sent history remains unchanged. Runtime claim, payload and completion
  use the same destination consistency guard, and new notices cannot coalesce
  into an incompatible existing task.
- Cold-start ordinary Chat provider lineage once during migration, independently
  of old Issue fields or push records. This covers an explicitly unbound Chat
  that never produced a push. Clear provider/fingerprint/session pointers and
  clear runtime ownership when no working directory remains; retain `work_dir`
  with its origin runtime when one exists. Keep ordinary user/assistant history.
  Also clear provider pointers on retained topics carrying invalid historical
  work. Retained topics with consistent work keep their resumable provider.
- Clear inherited Issue/session pointers from other queued/dispatched ordinary
  Chat tasks. Running, awaiting-human and waiting-for-local-directory tasks keep
  an upgrade invalidation marker, so late completion or retries cannot promote
  their old provider lineage. The marker is task execution metadata; the audit
  table has no runtime readers. Payloads, CLI context, Issue creation and request
  provenance resolve effective Chat scope, preventing old private ownership
  from becoming new context.
- Remove non-topic notification channels and pending Issue update state, clear
  pending delivery flags, and remove only system messages starting with
  `Bound Issue update:` from non-topic Chats. Preserved topics retain their
  enabled/disabled subscription choices.
- Clear erroneous Issue Session pointers/generations from queued/dispatched Chat
  tasks, including topics. Startup backfills Issue Sessions only for non-Chat
  tasks. Drop `multiremi_chat_sessions.issue_id` and index binding ownership.
  No UI session management columns are removed.

## Historical group association exception

Starting with `421413f4` (2026-09-04 11:30, UTC+08:00), an Agent creating an Issue
inside Chat automatically linked that conversation. This included genuine
Feishu group topics; `747f2d1` tested reusing their original group topic. Those
records need not have a canonical ID or a `feishu_bot_message` source. The
separate group-only `autoCreateGroupIssue` path and its marker arrived together
in `bd9f8083` (2026-09-05 21:46, UTC+08:00), approximately 34 hours later.
**This is the origin window, not a safe date filter:** the generic path remained
possible afterward. Audit all old links, including more recent ones.

If a real group association has none of the three deterministic proofs above,
it is removed from active ownership. The group stops receiving Issue updates,
work-round reports and human-request notifications until an operator restores
that binding. Issue, Chat, ordinary message/task history, published results and
human requests remain; cancelled wake tasks and deleted notification deliveries
are not revived. There is no delayed recovery state or catch-up summary.

The affected production count is **not yet measured**. Unknown conversation type
must not be counted as a confirmed group, or inferred from a thread/key. Before
requesting deployment authorization, enumerate every dropped binding, confirm
unknown types through authoritative Feishu chat metadata, and report the actual
confirmed-group count, remaining unknown count, and recent activity. If there
are more than 10 affected group topics, an active topic in the past 7 days whose
interruption is unacceptable, or no deterministic coverage of active topics,
return those facts for a new decision before deployment.

## Audit before deployment authorization

1. Take and verify a consistent database backup. Restore it to an isolated copy
   with no daemon, bot credentials, traffic or outbound network delivery. Run the
   pre-migration multiplicity queries below before running the candidate migration
   there. This uses the actual migration's provenance checks
   rather than a second SQL implementation that could disagree with them.
2. On that migrated copy, run the queries below. Keep an export of audit records
   and type-verification evidence with the upgrade record. Inspect all dates.
   Do not print message bodies, task results or credentials in the report.
3. Record authoritative group/p2p decisions in the temporary review table. An
   unknown type remains unresolved until verified; SQL cannot infer it safely.
   Report counts to 贺华杰 before obtaining production deployment authorization.
4. After authorization, pause writes and inbound/daemon traffic, take the final
   backup, run the migration, and compare its audit set with the reviewed set.
   Investigate any new or changed row before resuming traffic.

These queries work on SQLite and PostgreSQL. Run the following two queries on
the isolated copy **before migration**; they need only the legacy binding table.
They group globally by Chat ID, including anomalous cross-workspace bindings.
The detail query returns every participating binding; `conflict_bindings` counts
all bindings in shared Chats, while `excess_bindings` counts only those beyond one
per Chat. An empty data set yields an empty detail list and zero summary counts.

```sql
-- mul301-audit-multiplicity-detail
WITH shared AS (
  SELECT chat_session_id, COUNT(*) AS binding_count
  FROM multiremi_feishu_bot_chat_bindings
  GROUP BY chat_session_id HAVING COUNT(*) > 1
)
SELECT b.chat_session_id, s.binding_count, b.id AS binding_id, b.workspace_id,
       b.app_id, b.agent_id, b.external_session_key
FROM multiremi_feishu_bot_chat_bindings b
JOIN shared s ON s.chat_session_id = b.chat_session_id
ORDER BY b.chat_session_id, b.workspace_id, b.id;
```

```sql
-- mul301-audit-multiplicity-summary
WITH shared AS (
  SELECT chat_session_id, COUNT(*) AS binding_count
  FROM multiremi_feishu_bot_chat_bindings
  GROUP BY chat_session_id HAVING COUNT(*) > 1
)
SELECT COUNT(*) AS affected_chats,
       COALESCE(SUM(binding_count), 0) AS conflict_bindings,
       COALESCE(SUM(binding_count - 1), 0) AS excess_bindings
FROM shared;
```

Retain the conflict inventory for review. MUL-304 adds runtime guards to both
binding creation paths, but deliberately adds no UNIQUE constraint and does not
repair existing conflicts. Direct SQL/imports still require operator review.
The migration continues to cold-start a shared Chat if any binding is discarded.

The remaining queries use the audit table, which exists only after migration;
before deployment, run them on the isolated migrated copy.

`last_inbound_at` and `active_last7d` are immutable observations as of each
row's `audited_at`. Activity uses the first receipt (`created_at`) of deliveries
for the exact workspace/binding, or the original creation time of synchronized
human messages for the same workspace, owned source, chat and exact thread/root.
Unknown senders, bots, another thread, metadata updates, retries, ingestion time,
and future/invalid timestamps cannot count as activity. An absent timestamp
means **no recorded inbound evidence**, not proof that the real group is inactive.
The seven-day window is inclusive, ending at `audited_at`; rerun the rehearsal on
a fresh backup if the report is stale. Do not use `chat_sessions.updated_at`.

```sql
-- mul301-audit-detail
SELECT workspace_id, binding_id, chat_session_id, issue_id, disposition, reason,
       classification_version, hit_canonical, hit_marker,
       hit_synced_group, hit_synced_p2p, audited_at,
       last_inbound_at, active_last7d, binding_snapshot
FROM multiremi_feishu_bot_issue_link_audit
ORDER BY workspace_id, binding_id;
```

Create this temporary review table and add verified decisions. Use the audited
workspace/binding, and retain the authority/source of the exact chat-type check.
Do not infer group type from thread/key, activity or dates. A blank table is
valid and leaves unproven links unresolved.

```sql
-- mul301-audit-review
CREATE TEMP TABLE mul301_type_review (
  workspace_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  confirmed_type TEXT NOT NULL CHECK (confirmed_type IN ('group', 'p2p')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) > 0),
  PRIMARY KEY(workspace_id, binding_id)
);
```

```sql
INSERT INTO mul301_type_review VALUES
  ('<workspace-id>', '<verified-binding-id>', 'group', '<retained-evidence-reference>');
```

The following **single query** gives the decision inputs, including overlap-safe
coverage and authoritative recent activity. Run it after populating the review
rows (or with the empty review table to expose remaining unknowns).

```sql
-- mul301-audit-metrics
WITH classified AS (
  SELECT a.*,
    CASE WHEN a.hit_synced_p2p = 1 OR a.reason = 'p2p_evidence' OR r.confirmed_type = 'p2p' THEN 'p2p'
         WHEN a.disposition = 'preserved' OR r.confirmed_type = 'group' THEN 'group'
         ELSE 'unknown' END AS confirmed_type,
    CASE WHEN (a.hit_synced_p2p = 1 AND a.hit_synced_group = 1)
           OR ((a.hit_synced_p2p = 1 OR a.reason = 'p2p_evidence') AND r.confirmed_type = 'group')
           OR (a.disposition = 'preserved' AND r.confirmed_type = 'p2p')
         THEN 1 ELSE 0 END AS evidence_conflict
  FROM multiremi_feishu_bot_issue_link_audit a
  LEFT JOIN mul301_type_review r
    ON r.workspace_id = a.workspace_id AND r.binding_id = a.binding_id
), counts AS (
  SELECT COUNT(*) AS evaluated_links,
    COALESCE(SUM(CASE WHEN chat_session_id IS NULL THEN 1 ELSE 0 END), 0) AS missing_chat_identity_rows,
    COALESCE(SUM(CASE WHEN classification_version != 2 THEN 1 ELSE 0 END), 0) AS incomplete_audit_rows,
    COALESCE(SUM(hit_canonical), 0) AS canonical_hits,
    COALESCE(SUM(hit_marker), 0) AS marker_hits,
    COALESCE(SUM(hit_synced_group), 0) AS synced_group_hits,
    COALESCE(SUM(CASE WHEN hit_synced_p2p = 1 OR reason = 'p2p_evidence' THEN 1 ELSE 0 END), 0) AS p2p_overrides,
    COALESCE(SUM(CASE WHEN disposition = 'preserved' AND hit_canonical = 1 THEN 1 ELSE 0 END), 0) AS canonical_preserved,
    COALESCE(SUM(CASE WHEN disposition = 'preserved' AND hit_marker = 1 THEN 1 ELSE 0 END), 0) AS marker_preserved,
    COALESCE(SUM(CASE WHEN disposition = 'preserved' AND hit_synced_group = 1 THEN 1 ELSE 0 END), 0) AS synced_group_preserved,
    COALESCE(SUM(CASE WHEN disposition = 'preserved' THEN 1 ELSE 0 END), 0) AS preserved_links,
    COALESCE(SUM(CASE WHEN disposition = 'discarded' THEN 1 ELSE 0 END), 0) AS dropped_feishu_links,
    COALESCE(SUM(CASE WHEN confirmed_type = 'group' THEN 1 ELSE 0 END), 0) AS confirmed_group_topics,
    COALESCE(SUM(CASE WHEN disposition = 'discarded' AND confirmed_type = 'group' THEN 1 ELSE 0 END), 0) AS confirmed_affected_group_topics,
    COALESCE(SUM(CASE WHEN confirmed_type = 'p2p' THEN 1 ELSE 0 END), 0) AS confirmed_private_links,
    COALESCE(SUM(CASE WHEN confirmed_type = 'unknown' THEN 1 ELSE 0 END), 0) AS unresolved_links,
    COALESCE(SUM(CASE WHEN confirmed_type = 'group' AND active_last7d = 1 THEN 1 ELSE 0 END), 0) AS active_group_topics_last7d,
    COALESCE(SUM(CASE WHEN disposition = 'discarded' AND confirmed_type = 'group' AND active_last7d = 1 THEN 1 ELSE 0 END), 0) AS active_affected_group_topics_last7d,
    COALESCE(SUM(CASE WHEN disposition = 'preserved' AND confirmed_type = 'group' AND active_last7d = 1 THEN 1 ELSE 0 END), 0) AS active_preserved_group_topics_last7d,
    COALESCE(SUM(CASE WHEN confirmed_type = 'unknown' AND active_last7d = 1 THEN 1 ELSE 0 END), 0) AS active_unresolved_links_last7d,
    COALESCE(SUM(CASE WHEN last_inbound_at IS NULL THEN 1 ELSE 0 END), 0) AS inbound_unobserved_links,
    COALESCE(SUM(CASE WHEN disposition = 'discarded' AND confirmed_type = 'group' AND last_inbound_at IS NULL THEN 1 ELSE 0 END), 0) AS affected_group_inbound_unobserved,
    COALESCE(SUM(evidence_conflict), 0) AS evidence_conflicts
  FROM classified
), shared_chats AS (
  SELECT chat_session_id, COUNT(*) AS binding_count,
    SUM(CASE WHEN disposition = 'preserved' THEN 1 ELSE 0 END) AS preserved_count,
    SUM(CASE WHEN disposition = 'discarded' THEN 1 ELSE 0 END) AS discarded_count,
    SUM(CASE WHEN disposition = 'discarded' AND confirmed_type = 'p2p' THEN 1 ELSE 0 END) AS discarded_p2p_count
  FROM classified
  WHERE chat_session_id IS NOT NULL
  GROUP BY chat_session_id HAVING COUNT(*) > 1
), shared_counts AS (
  SELECT COUNT(*) AS shared_chat_count,
    COALESCE(SUM(binding_count), 0) AS shared_chat_binding_count,
    COALESCE(SUM(CASE WHEN preserved_count > 0 AND discarded_count > 0 THEN 1 ELSE 0 END), 0) AS mixed_disposition_chat_count,
    COALESCE(SUM(CASE WHEN preserved_count > 0 AND discarded_count > 0 THEN binding_count ELSE 0 END), 0) AS mixed_disposition_binding_count,
    COALESCE(SUM(CASE WHEN preserved_count > 0 AND discarded_p2p_count > 0 THEN 1 ELSE 0 END), 0) AS preserved_group_discarded_p2p_chat_count
  FROM shared_chats
)
SELECT counts.*,
  CASE WHEN missing_chat_identity_rows = 0 THEN shared_chat_count END AS shared_chat_count,
  CASE WHEN missing_chat_identity_rows = 0 THEN shared_chat_binding_count END AS shared_chat_binding_count,
  CASE WHEN missing_chat_identity_rows = 0 THEN mixed_disposition_chat_count END AS mixed_disposition_chat_count,
  CASE WHEN missing_chat_identity_rows = 0 THEN mixed_disposition_binding_count END AS mixed_disposition_binding_count,
  CASE WHEN missing_chat_identity_rows = 0 THEN preserved_group_discarded_p2p_chat_count END AS preserved_group_discarded_p2p_chat_count,
  CASE WHEN incomplete_audit_rows = 0 THEN 100.0 * canonical_preserved / NULLIF(evaluated_links, 0) END AS canonical_coverage_pct,
  CASE WHEN incomplete_audit_rows = 0 THEN 100.0 * marker_preserved / NULLIF(evaluated_links, 0) END AS marker_coverage_pct,
  CASE WHEN incomplete_audit_rows = 0 THEN 100.0 * synced_group_preserved / NULLIF(evaluated_links, 0) END AS synced_group_coverage_pct,
  CASE WHEN incomplete_audit_rows = 0 THEN 100.0 * preserved_links / NULLIF(evaluated_links, 0) END AS preservation_coverage_pct,
  CASE WHEN incomplete_audit_rows = 0 THEN 100.0 * active_preserved_group_topics_last7d / NULLIF(active_group_topics_last7d, 0) END AS active_group_preservation_coverage_pct
FROM counts CROSS JOIN shared_counts;
```

`evaluated_links` counts the migration's legacy Feishu Issue associations, not all
Chats. Per-rule raw hits include overlaps and p2p overrides; effective per-rule
coverage counts only preserved links. Their percentages must **not be added**.
Overall coverage counts each binding once. A zero denominator yields NULL, not
100% coverage. Review conflicts before relying on any type count. A claimed
`group` conflicting with `p2p_evidence` never authorizes restoration. Missing
activity must be checked externally where interruption could be unacceptable.
Record confirmed affected groups, unresolved links, active affected groups, and
both total/active preservation coverage with the deployment request.

`shared_chat_count` counts Chat IDs with multiple evaluated bindings, and
`shared_chat_binding_count` counts **all** evaluated bindings on those Chats.
`mixed_disposition_chat_count` and `mixed_disposition_binding_count` restrict
those counts to Chats containing both preserved and discarded decisions.
`preserved_group_discarded_p2p_chat_count` identifies the specific preserved-group
plus confirmed-discarded-p2p shape; review evidence conflicts before interpreting
the group label. These are overlapping counts, not additive categories.
They use the immutable `chat_session_id` audit column, independent of live
bindings or JSON functions. They cover evaluated legacy Issue links only;
the pre-migration inventory also catches bindings without a legacy Issue.
Older audit rows lack Chat identity: `missing_chat_identity_rows` exposes them
and makes all five shared-Chat metrics NULL, rather than claiming zero conflicts.
Rehearse from the pre-decoupling backup to fill that gap; do not backfill from
mutable live bindings. An empty audit gives zero conflict counts and NULL coverage.

Fresh migration records have `classification_version = 2`. Earlier unpublished
drafts lack retained decisions and authoritative activity; rows from them remain
version 1, and coverage is NULL whenever any is present. Rehearse from a verified
pre-decoupling backup to obtain a complete denominator; restarting a migrated
draft cannot reconstruct absent rows. Save review evidence outside the temporary
table; it is not application state. These metrics have no date filter.

## Restore a confirmed group before resuming traffic

Restore each reviewed binding individually, in a transaction, **before the daemon
accepts messages again**. Otherwise a new group message can trigger automatic
creation of a replacement Issue; investigate and reconcile that duplicate before
restoring. Never restore a private or unverified conversation. No backup is
needed to restore a link: the audit record contains the original identity and
subscription. Keep the audit row after restoration as an immutable record.

Read `binding_snapshot` and `channel_snapshot` for the one audited row. Verify
its Issue and Chat still exist in the same workspace, the bot/app/Agent/session
and every destination field are unchanged, and authoritative group evidence is
current. Do not recreate a missing/deleted Chat or transplant the link to another
thread. Substitute the exact snapshot values below, SQL-escaping strings; use SQL
`NULL` for null thread/reply values. Run one binding at a time. This is an offline
maintenance procedure, not a new public bind API.

```sql
-- mul301-audit-restore
BEGIN;
UPDATE multiremi_feishu_bot_chat_bindings
SET issue_id = (
  SELECT issue_id FROM multiremi_feishu_bot_issue_link_audit
  WHERE binding_id = '<binding-id>' AND workspace_id = '<workspace-id>'
    AND disposition = 'discarded' AND reason = 'unproven_ownership'
    AND classification_version = 2 AND hit_synced_p2p = 0
)
WHERE id = '<binding-id>' AND workspace_id = '<workspace-id>'
  AND issue_id IS NULL
  AND app_id = '<audited-app-id>' AND agent_id = '<audited-agent-id>'
  AND external_session_key = '<audited-external-session-key>'
  AND chat_session_id = '<audited-chat-session-id>'
  AND chat_id = '<authoritatively-verified-group-chat-id>'
  AND thread_id IS NOT DISTINCT FROM '<audited-thread-id-or-SQL-NULL>'
  AND reply_to_message_id IS NOT DISTINCT FROM '<audited-reply-id-or-SQL-NULL>'
  AND EXISTS (
    SELECT 1 FROM multiremi_chat_sessions c
    WHERE c.id = '<audited-chat-session-id>' AND c.workspace_id = '<workspace-id>'
  )
  AND EXISTS (
    SELECT 1 FROM multiremi_feishu_bot_issue_link_audit a
    JOIN multiremi_issues i ON i.id = a.issue_id AND i.workspace_id = a.workspace_id
    WHERE a.binding_id = '<binding-id>' AND a.workspace_id = '<workspace-id>'
      AND a.disposition = 'discarded' AND a.reason = 'unproven_ownership'
      AND a.classification_version = 2 AND a.hit_synced_p2p = 0
  )
RETURNING id, issue_id;
-- Require exactly one returned row; otherwise ROLLBACK and investigate.
```

If `channel_snapshot` is non-null, restore that exact row in the same transaction,
including `enabled`, `event_types`, `min_severity`, owner and target. Verify its
kind is `agent_chat`, its workspace matches, and `target.chatId` is the audited
Chat. Do not replace an existing channel or silently enable a disabled one. The
following parameters are copied from that snapshot, not new defaults:

```sql
-- mul301-audit-restore-channel
INSERT INTO multiremi_notification_channels
  (id, workspace_id, member_id, kind, name, enabled, target, event_types,
   min_severity, created_by, created_at, updated_at)
VALUES
  ('<channel-id>', '<workspace-id>', '<member-id-or-SQL-NULL>', 'agent_chat',
   '<name>', <enabled-0-or-1>, '<target-json>', '<event-types-json>',
   '<min-severity>', '<creator-or-SQL-NULL>', '<created-at>', '<updated-at>')
RETURNING id, enabled, event_types;
-- A conflicting ID is an error: ROLLBACK and inspect, never overwrite it.
COMMIT;
```

When the snapshot is null, skip the INSERT and commit the verified binding
update without inventing a subscription. Null placeholders mean unquoted SQL
`NULL`, not the string `'NULL'`. For a repeat attempt where the binding already
has the audited Issue, verify all identity and channel fields before treating it
as already restored; never overwrite a different live Issue.

Read back binding and subscription fields before resuming traffic. Do not restore
old provider/session pointers, pending updates, cancelled wake tasks or deleted
outbox rows. Future events use the normal topic path; missed notifications are
not replayed. The retained Issue/task/human-request records remain queryable.
A claim-time binding check is an additional invariant, not a paused queue.
Messages already claimed by a daemon, currently sending or sent before upgrade
cannot be withdrawn by this migration.

Earlier PR #192 drafts that already discarded ambiguous links cannot reconstruct
them by restarting this revision. Rehearse from a verified pre-decoupling backup;
do not use a previously migrated draft database as evidence of this migration.

## SQLite and PostgreSQL

PostgreSQL and legacy SQLite schemas with an inline Issue foreign key use native
`ALTER TABLE ... DROP COLUMN`. A shipped SQLite schema instead has a table-level
Issue foreign key, which SQLite cannot remove by dropping its referenced
column. That schema is rebuilt inside the migration transaction:

1. Create a replacement from the original table definition, removing only the
   Issue column and its table-level foreign key.
2. Copy every remaining column using an explicit column list.
3. Drop the old table, rename the replacement, and recreate captured indexes and
   triggers. Keeping the original name until the old table is dropped avoids
   rewriting dependent foreign keys toward a temporary name.
4. Compare Chat, Chat message, and Feishu binding row counts before and after
   the rebuild. Any mismatch throws and rolls back the migration.

The SQLite foreign-key enforcement setting is saved and temporarily disabled
before this transaction only when a rebuild needs it, then restored in a
`finally` block. An initially disabled setting stays disabled. Deliberate
removal of private system update messages happens **after** the rebuild/count
check, independently from user/assistant history preservation.

The migration ledger entry and ownership transformation share one transaction.
Repeated startup does not repeat the migration or recreate Chat ownership.
Regression tests cover both SQLite schema shapes with enforcement on/off,
unknown extra columns/indexes/triggers, provider resume reset, queued/dispatched task
cleanup, rollback after injected dependent-row loss, and restoration of a
verified pre-upgrade SQLite backup. Both SQLite schema shapes and the real
PostgreSQL backend cover p2p conversations with thread/key combinations,
automatic group creation without thread markers, and missing, malformed or
mismatched creation provenance. These cases verify provider reset, pending task
isolation, message preservation, and update channel/state cleanup as well as
ownership and repeated startup.

## Rollback procedure

Take and verify a full database backup before upgrading, and pause writes for
the upgrade window. Use a consistent SQLite backup (including committed WAL
state) or a PostgreSQL database backup, not a copy of a live SQLite main file.

- **Migration failure:** its transaction rolls back the binding ownership copy,
  table rebuild/drop, cleanup, and migration ledger entry. Fix the cause and
  retry startup; tests exercise this path. Other earlier startup migrations may
  already have committed independently.
- **Rollback after successful migration:** stop the upgraded service, restore the
  verified pre-upgrade database backup, and run the prior application version.
  Do not merely start old code against the new schema. The intentionally
  discarded private associations/system broadcasts and provider resume pointers
  cannot be reconstructed from the new binding table. Restoring the backup also
  discards writes made since the backup, which is why the paused-write upgrade
  window matters.

This change supplies migration code and local verification only; it does not run
an upgrade or alter a production database.
