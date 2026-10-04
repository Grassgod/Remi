-- Restores only outbound delivery lanes. The unified message/turn model stays in place.
-- task_id is a turn attempt ID. This is not a rollback to the retired task tables.
-- Replace __C5_STAMP__ with a unique UTC YYYYMMDDHHMMSS value before running.
-- The three queries below must return zero rows. Stop writers and back up first.
SELECT task_id FROM multiremi_feishu_bot_outbound_deliveries
WHERE delivery_mode = 'split' AND task_id IS NOT NULL GROUP BY task_id
HAVING SUM(CASE WHEN kind = 'result_card' AND status IN ('sent', 'failed') THEN 1 ELSE 0 END) <> 1
    OR SUM(CASE WHEN kind = 'cot' AND unit_key = '' THEN 1 ELSE 0 END) <> 1;
SELECT id FROM multiremi_feishu_bot_outbound_deliveries
WHERE delivery_mode = 'split' AND status NOT IN ('sent', 'failed');
SELECT id FROM multiremi_feishu_bot_outbound_operations WHERE status <> 'done';

-- TRANSACTION
.bail on
BEGIN IMMEDIATE;
CREATE TEMP TABLE c5_restore_schema_guard (
  passed INTEGER CONSTRAINT c5_restore_requires_split_schema CHECK (passed = 1)
);
INSERT INTO c5_restore_schema_guard
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('multiremi_feishu_bot_outbound_deliveries')
  WHERE name = 'delivery_mode') THEN 1 ELSE 0 END;
CREATE TEMP TABLE c5_restore_archive_guard (
  passed INTEGER CONSTRAINT c5_restore_archive_must_be_new CHECK (passed = 1)
);
INSERT INTO c5_restore_archive_guard
SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'fbo_c5_archive___C5_STAMP__')
  THEN 0 ELSE 1 END;
CREATE TEMP TABLE c5_restore_drain_guard (
  passed INTEGER CONSTRAINT c5_restore_requires_drained_rows CHECK (passed = 1)
);
INSERT INTO c5_restore_drain_guard
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries
  WHERE delivery_mode = 'split' AND status NOT IN ('sent', 'failed')
) OR EXISTS (
  SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries
  WHERE delivery_mode = 'split' AND task_id IS NOT NULL GROUP BY task_id
  HAVING SUM(CASE WHEN kind = 'result_card' AND status IN ('sent', 'failed') THEN 1 ELSE 0 END) <> 1
      OR SUM(CASE WHEN kind = 'cot' AND unit_key = '' THEN 1 ELSE 0 END) <> 1
) OR EXISTS (
  SELECT 1 FROM multiremi_feishu_bot_outbound_operations WHERE status <> 'done'
) THEN 0 ELSE 1 END;

ALTER TABLE multiremi_feishu_bot_outbound_deliveries RENAME TO fbo_c5_archive___C5_STAMP__;
-- SQLite index names are database-wide. The pre-C5 backup owns these two names.
DROP INDEX IF EXISTS idx_multiremi_feishu_bot_outbound_pending;
DROP INDEX IF EXISTS idx_multiremi_feishu_bot_outbound_previous;
CREATE INDEX idx_fbo_pre_c5_pending___C5_STAMP__
  ON multiremi_feishu_bot_outbound_deliveries_c5_backup(status, available_at, leased_until, created_at);
CREATE INDEX idx_fbo_pre_c5_previous___C5_STAMP__
  ON multiremi_feishu_bot_outbound_deliveries_c5_backup(previous_delivery_id);
DROP INDEX IF EXISTS idx_multiremi_feishu_bot_outbound_kind;
CREATE INDEX idx_fbo_c5_kind___C5_STAMP__
  ON fbo_c5_archive___C5_STAMP__(kind, status, available_at);
DROP INDEX IF EXISTS idx_multiremi_feishu_bot_outbound_decision;
CREATE INDEX idx_fbo_c5_decision___C5_STAMP__
  ON fbo_c5_archive___C5_STAMP__(decision_id, status, available_at);

CREATE TABLE multiremi_feishu_bot_outbound_deliveries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  task_id TEXT UNIQUE, chat_id TEXT NOT NULL, thread_id TEXT, reply_to_message_id TEXT,
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', claim_token TEXT,
  leased_until TEXT, available_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  external_message_id TEXT, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, mention_snapshot TEXT, presentation_checkpoint TEXT,
  interaction_open_id TEXT, attachments TEXT, previous_delivery_id TEXT, kind TEXT,
  human_request_id TEXT, human_request_task_id TEXT, expires_at TEXT,
  target_message_id TEXT, degraded TEXT, decision_id TEXT, decision_issue_id TEXT,
  FOREIGN KEY(binding_id) REFERENCES multiremi_feishu_bot_chat_bindings(id) ON DELETE CASCADE,
  FOREIGN KEY(task_id) REFERENCES multiremi_turn_attempts(id) ON DELETE SET NULL
);
INSERT INTO multiremi_feishu_bot_outbound_deliveries (
  id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id,
  body, status, claim_token, leased_until, available_at, attempt_count,
  external_message_id, last_error, sent_at, created_at, updated_at, mention_snapshot,
  presentation_checkpoint, interaction_open_id, attachments, previous_delivery_id,
  kind, human_request_id, human_request_task_id, expires_at, target_message_id,
  degraded, decision_id, decision_issue_id
)
SELECT c.id, c.workspace_id, c.binding_id, c.task_id, c.chat_id, c.thread_id,
  c.reply_to_message_id, c.body,
  CASE WHEN c.delivery_mode = 'split' THEN r.status ELSE c.status END,
  c.claim_token, c.leased_until, c.available_at, c.attempt_count,
  CASE WHEN c.delivery_mode = 'split' THEN r.external_message_id ELSE c.external_message_id END,
  c.last_error, c.sent_at, c.created_at, c.updated_at, c.mention_snapshot,
  c.presentation_checkpoint, c.interaction_open_id, c.attachments,
  c.previous_delivery_id,
  CASE WHEN c.delivery_mode = 'split' THEN NULL ELSE c.kind END,
  c.human_request_id, c.human_request_task_id, c.expires_at, c.target_message_id,
  c.degraded, c.decision_id, c.decision_issue_id
FROM fbo_c5_archive___C5_STAMP__ AS c
LEFT JOIN fbo_c5_archive___C5_STAMP__ AS r
  ON c.delivery_mode = 'split' AND r.task_id = c.task_id AND r.kind = 'result_card'
WHERE c.task_id IS NULL OR (c.unit_key = '' AND (c.kind IS NULL OR c.kind = 'cot'));
CREATE INDEX idx_multiremi_feishu_bot_outbound_pending
  ON multiremi_feishu_bot_outbound_deliveries(status, available_at, leased_until, created_at);
CREATE INDEX idx_multiremi_feishu_bot_outbound_previous
  ON multiremi_feishu_bot_outbound_deliveries(previous_delivery_id);
CREATE INDEX idx_multiremi_feishu_bot_outbound_kind
  ON multiremi_feishu_bot_outbound_deliveries(kind, status, available_at);
CREATE INDEX idx_multiremi_feishu_bot_outbound_decision
  ON multiremi_feishu_bot_outbound_deliveries(decision_id, status, available_at);

CREATE TEMP TABLE c5_restore_post_guard (
  passed INTEGER CONSTRAINT c5_restore_postcheck_failed CHECK (passed = 1)
);
INSERT INTO c5_restore_post_guard SELECT CASE WHEN
  (SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries) =
    (SELECT COUNT(*) FROM fbo_c5_archive___C5_STAMP__ WHERE task_id IS NULL
       OR (unit_key = '' AND (kind IS NULL OR kind = 'cot')))
  AND (SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id IS NULL) =
    (SELECT COUNT(*) FROM fbo_c5_archive___C5_STAMP__ WHERE task_id IS NULL)
  AND EXISTS (SELECT 1 FROM pragma_index_list('multiremi_feishu_bot_outbound_deliveries') AS i
    WHERE i."unique" = 1 AND i.partial = 0
      AND (SELECT group_concat(name) FROM pragma_index_info(i.name)) = 'task_id')
  THEN 1 ELSE 0 END;
DROP TABLE c5_restore_schema_guard;
DROP TABLE c5_restore_archive_guard;
DROP TABLE c5_restore_drain_guard;
DROP TABLE c5_restore_post_guard;
COMMIT;
