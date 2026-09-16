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
- Discard other Feishu associations and write a permanent, operator-only record
  to `multiremi_feishu_bot_issue_link_audit`. It contains the original Issue,
  complete binding identity/destination snapshot, subscription snapshot and
  decision reason (`p2p_evidence` or `unproven_ownership`). The active binding has
  no Issue. The audit table has **no runtime readers**: incoming messages never
  restore ownership, create summaries or replay old notifications from it.
  Private Web associations are discarded. No live Feishu lookup is required.
- For discarded associations, cancel queued/dispatched proactive Issue wake
  tasks and delete unsent proactive work-round/human-request outbox entries in
  the migration transaction. Remove unconsumed system-generated work-round
  steering tied to those dropped links; retain user steering and ordinary input
  tasks. Clear surviving outbox rows' references to deleted predecessors so
  ordinary replies/files/attachments can proceed. Sent delivery history and
  retained Issue bindings' tasks and queues are unchanged.
- Reset affected Chats' provider resume pointers and provider/fingerprint
  metadata. Keep `work_dir` and its origin `session_runtime_id` together. Keep
  user/assistant history. Clear inherited Issue/session pointers from other
  queued/dispatched Chat tasks; running task rows retain their audit identity.
  Payloads, CLI context, Issue creation and request provenance resolve effective
  Chat scope, preventing old private ownership from becoming new context.
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
   candidate migration there. This uses the actual migration's provenance checks
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

These queries work on SQLite and PostgreSQL. The audit table exists only after
the migration; before deployment, run them on the isolated migrated copy.

```sql
SELECT a.workspace_id, a.binding_id, a.issue_id, a.reason, a.audited_at,
       b.app_id, b.agent_id, b.external_session_key, b.chat_session_id,
       b.chat_id, b.thread_id, b.reply_to_message_id,
       c.updated_at AS chat_last_activity, a.binding_snapshot
FROM multiremi_feishu_bot_issue_link_audit a
LEFT JOIN multiremi_feishu_bot_chat_bindings b ON b.id = a.binding_id
  AND b.workspace_id = a.workspace_id
LEFT JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
  AND c.workspace_id = a.workspace_id
ORDER BY a.workspace_id, a.binding_id;

CREATE TEMP TABLE mul301_type_review (
  binding_id TEXT PRIMARY KEY,
  confirmed_type TEXT NOT NULL CHECK (confirmed_type IN ('group', 'p2p')),
  evidence_ref TEXT NOT NULL
);
-- Insert one row only after checking authoritative metadata for the exact chat.
-- Do not fill this from thread_id, external_session_key, or guessed dates.
INSERT INTO mul301_type_review VALUES
  ('<verified-binding-id>', 'group', '<retained-evidence-reference>');

SELECT COUNT(*) AS dropped_feishu_links,
       COALESCE(SUM(CASE WHEN a.reason = 'unproven_ownership'
         AND r.confirmed_type = 'group' THEN 1 ELSE 0 END), 0)
         AS confirmed_affected_group_topics,
       COALESCE(SUM(CASE WHEN a.reason = 'p2p_evidence'
         OR r.confirmed_type = 'p2p' THEN 1 ELSE 0 END), 0)
         AS confirmed_private_links,
       COALESCE(SUM(CASE WHEN a.reason = 'unproven_ownership'
         AND r.binding_id IS NULL THEN 1 ELSE 0 END), 0)
         AS unresolved_links
FROM multiremi_feishu_bot_issue_link_audit a
LEFT JOIN mul301_type_review r ON r.binding_id = a.binding_id;

SELECT a.binding_id, a.issue_id, c.updated_at AS chat_last_activity,
       r.confirmed_type, r.evidence_ref
FROM multiremi_feishu_bot_issue_link_audit a
JOIN mul301_type_review r ON r.binding_id = a.binding_id
JOIN multiremi_feishu_bot_chat_bindings b ON b.id = a.binding_id
  AND b.workspace_id = a.workspace_id
JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
  AND c.workspace_id = a.workspace_id
WHERE a.reason = 'unproven_ownership' AND r.confirmed_type = 'group'
ORDER BY c.updated_at DESC, a.binding_id;
```

`confirmed_affected_group_topics` counts binding/topic records, not distinct
Feishu groups. Review the activity timestamps against the seven-day boundary
and verify recent activity in the authoritative conversation as needed. A review
claiming `group` for an audit row marked `p2p_evidence` is a contradiction to
investigate, never permission to restore it. Save the review output externally;
the temporary table is not application state.

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
BEGIN;
UPDATE multiremi_feishu_bot_chat_bindings
SET issue_id = (
  SELECT issue_id FROM multiremi_feishu_bot_issue_link_audit
  WHERE binding_id = '<binding-id>' AND workspace_id = '<workspace-id>'
    AND reason = 'unproven_ownership'
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
      AND a.reason = 'unproven_ownership'
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
