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
- Preserve other Feishu associations in the internal
  `multiremi_feishu_bot_legacy_issue_links` quarantine table, containing the
  original Issue, subscription snapshot, and replay timestamp. The active
  binding remains unbound. This record is not Chat ownership and is never used
  by task context, Chat listing filters, or Issue notification routing. Web
  associations and proven p2p associations are discarded without a recovery
  marker. No live Feishu lookup is required during migration.
- Clear active ownership for discarded and quarantined associations. In those Chats, reset
  the provider resume pointer and its provider/fingerprint metadata so
  the next turn starts with a clean prompt. Keep `work_dir` and its origin
  `session_runtime_id` together so the retained directory is used on its owning
  machine. Keep user/assistant
  messages. Clear queued/dispatched tasks' inherited `issue_id` and frozen
  `session_id`; running task identities
  remain intact for auditing. Task payloads, CLI context, Issue creation and
  request provenance resolve the effective Chat scope and reject old private
  ownership, so upgrading does not depend on draining those tasks.
- Remove private Chat notification channels and pending Issue update state.
  Clear pending delivery flags and remove only system messages starting with
  `Bound Issue update:` from non-topic Chats, preventing their replay in the new
  bootstrap. Feishu topic messages and existing channel enabled/disabled choices
  are preserved.
- Remove erroneous Issue Session pointers and generations from queued/dispatched
  Chat tasks, including Feishu topic tasks. Startup only backfills Issue Sessions
  for tasks without a Chat owner, so restarting cannot restore dual ownership.
- Drop `multiremi_chat_sessions.issue_id` and create a binding ownership index.
  No UI session management columns are removed.

## Historical group conversations and deferred recovery

There are two shipped historical creation paths. Starting with `421413f4`
(2026-09-04), an Agent creating an Issue inside Chat automatically linked that
conversation. This included real Feishu group topics; `747f2d1` explicitly tested
reusing their original group topic instead of creating a canonical root. Those
records need not have a `feishu_bot_message` source. The separate group-only
`autoCreateGroupIssue` path and its source marker both arrived in `bd9f8083`
(2026-09-05). The generic path remained possible afterward, so September 4–5 is
not an upper bound on affected records.

Already queued proactive work-round and human-request deliveries are held while
the binding is unbound; a confirmed group resumes those queues, while p2p cannot
claim them. Ordinary inbound replies and attachments remain deliverable. A late
old-task completion cannot recreate a proactive Issue delivery for an unbound
conversation. This claim-time guard cannot recall a message already sent.

An unclassified old group conversation temporarily stops receiving Issue updates,
work-round reports, and human-request notifications. The Issue, tasks, published
results, and human requests themselves remain intact. Its next authenticated
bot message restores the original association only when the message explicitly
says `chatType: group`, its sender is allowed, and its workspace, app, agent,
external session key and chat destination match the binding. Recovery runs
before duplicate-message handling and automatic new-Issue creation, so a retry
can recover the old topic without creating a replacement Issue. An explicit
`p2p` message consumes the marker without restoring ownership; missing type
keeps it quarantined. A missing or mismatched Issue cannot be restored.

Recovery preserves subscription choices and consumes the marker in the same
transaction as restoring the binding. For an enabled subscription, it queues one
catch-up summary for the Agent and the original Feishu destination: current Issue
state, relevant activities since the replay timestamp, completed work and results,
and still-pending human requests. Category filters are respected. This is an
aggregate recovery notification, not a replay of each historical notification.
Bounded summaries identify omitted record counts and explain how to query the retained
Issue/task history. Disabled subscriptions remain disabled and receive no catch-up
broadcast. Other bindings receive no replay. Recovery does not copy old provider
pointers back into Chat. An already-running, now-confirmed group task can finish
and promote its session through the normal completion path. Existing queued or
running turns keep their frozen task identity; the catch-up and Bound Issue
lookup guide let them retrieve the restored Issue, and the next new turn carries
the restored Issue scope. Proven p2p tasks remain isolated.

Until a matching explicit-type message arrives, the association stays quarantined
indefinitely. An old daemon that omits `chatType` must be upgraded before recovery;
thread markers do not substitute for this field. A changed route/app or deleted
Issue requires operator investigation of the backup and binding identity; do not
copy quarantine IDs into active ownership without authoritative group evidence.

Before upgrading, audit a read-only backup for noncanonical Issue-linked Feishu
bindings without exact creation provenance. Join synced messages and sources by
workspace and chat ID to distinguish known group/p2p from unknown; count the latter
as potentially affected historical group topics. Save binding ID, workspace, app,
agent, external session key, chat ID and original Issue ID in the upgrade record.
After upgrading, compare these with active bindings and quarantine rows. To recover
an unknown real group, have an authorized participant send a message to its existing
conversation through a daemon that supplies explicit `chatType`; verify the same
Issue is restored and the quarantine record disappears. For p2p, verify the marker
disappears while active ownership stays null. Do not use removed Chat bind commands.

A read-only candidate query on the **pre-upgrade backup** is below. It lists
noncanonical links; the exact source/delivery check described above may still
prove some of these safe automatically. It intentionally returns identifiers,
not message bodies or credentials.

```sql
SELECT b.workspace_id, b.id AS binding_id, b.app_id, b.agent_id,
       b.external_session_key, b.chat_id, c.issue_id,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM multiremi_feishu_messages m
           JOIN multiremi_feishu_sources s ON s.id = m.source_id
             AND s.workspace_id = m.workspace_id
           WHERE m.workspace_id = b.workspace_id AND m.chat_id = b.chat_id
             AND m.chat_type = 'p2p'
         ) THEN 'p2p: discard'
         WHEN EXISTS (
           SELECT 1 FROM multiremi_feishu_messages m
           JOIN multiremi_feishu_sources s ON s.id = m.source_id
             AND s.workspace_id = m.workspace_id
           WHERE m.workspace_id = b.workspace_id AND m.chat_id = b.chat_id
             AND m.chat_type = 'group'
         ) THEN 'group: preserve'
         ELSE 'check creation provenance; otherwise quarantine'
       END AS migration_action
FROM multiremi_feishu_bot_chat_bindings b
JOIN multiremi_chat_sessions c ON c.id = b.chat_session_id
  AND c.workspace_id = b.workspace_id
JOIN multiremi_issues i ON i.id = c.issue_id AND i.workspace_id = b.workspace_id
WHERE c.issue_id IS NOT NULL
  AND c.id <> 'chat_issue_topic_' || c.issue_id
ORDER BY b.workspace_id, b.id;
```

After upgrading, this read-only query lists unresolved candidates:

```sql
SELECT q.workspace_id, q.binding_id, q.issue_id, q.quarantined_at,
       b.app_id, b.agent_id, b.external_session_key, b.chat_id
FROM multiremi_feishu_bot_legacy_issue_links q
JOIN multiremi_feishu_bot_chat_bindings b ON b.id = q.binding_id
  AND b.workspace_id = q.workspace_id
ORDER BY q.quarantined_at, q.binding_id;
```

This recovery requires upgrading from a pre-decoupling database. A database already
migrated by an earlier draft of PR #192 has lost ambiguous associations and cannot
reconstruct them merely by restarting this revision; restore a verified pre-upgrade
backup before testing the corrected migration.

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
