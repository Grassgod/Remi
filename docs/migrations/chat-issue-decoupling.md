# MUL-301: Chat / Issue ownership migration

Migration `20260916_chat_issue_decoupling` moves Issue ownership from
`multiremi_chat_sessions.issue_id` to
`multiremi_feishu_bot_chat_bindings.issue_id`. Ordinary Chat create/update APIs no
longer accept Issue ownership. Existing Web/Feishu private conversations retain
their messages and working directories.

## Data transformation

- Preserve the Issue on canonical `chat_issue_topic_<issueId>` bindings,
  including roots whose outbound delivery is still pending, and on existing
  Feishu group topic bindings identified by their thread destination or
  `:thread:` session key. These are the stored topic markers used by the previous
  transport implementation; no live Feishu discovery is needed.
- Discard the other historical Chat/Issue associations. In those Chats, reset
  the provider resume pointer and its provider/fingerprint metadata so
  the next turn starts with a clean prompt. Keep `work_dir` and its origin
  `session_runtime_id` together so the retained directory is used on its owning
  machine. Keep user/assistant
  messages. Clear queued/dispatched tasks' inherited `issue_id` and frozen
  `session_id`; running task identities
  remain intact, with the task payload code rejecting old private ownership.
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
verified pre-upgrade SQLite backup. A PostgreSQL integration
case exercises upgrade and repeated startup on the real backend.

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
