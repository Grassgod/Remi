-- Restores only outbound delivery lanes. The unified message/turn model stays in place.
-- task_id is a turn attempt ID. This is not a rollback to the retired task tables.
-- Replace __C5_STAMP__ with a unique UTC YYYYMMDDHHMMSS value before running.
BEGIN;
DO $c5$
BEGIN
  IF to_regclass('fbo_c5_archive___C5_STAMP__') IS NOT NULL THEN
    RAISE EXCEPTION 'C5 restore archive already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'multiremi_feishu_bot_outbound_deliveries'
      AND column_name = 'delivery_mode') THEN
    RAISE EXCEPTION 'C5 restore requires an expanded live table';
  END IF;
  IF EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries
    WHERE delivery_mode = 'split' AND status NOT IN ('sent', 'failed'))
  OR EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries
    WHERE delivery_mode = 'split' AND task_id IS NOT NULL GROUP BY task_id
    HAVING SUM(CASE WHEN kind = 'result_card' AND status IN ('sent', 'failed') THEN 1 ELSE 0 END) <> 1
       OR SUM(CASE WHEN kind = 'cot' AND unit_key = '' THEN 1 ELSE 0 END) <> 1)
  OR EXISTS (SELECT 1 FROM multiremi_feishu_bot_outbound_operations WHERE status <> 'done') THEN
    RAISE EXCEPTION 'C5 restore requires drained split deliveries and deferred operations';
  END IF;
END
$c5$;
ALTER TABLE multiremi_feishu_bot_outbound_deliveries RENAME TO fbo_c5_archive___C5_STAMP__;
-- PostgreSQL relation names are schema-wide, including indexes backing constraints.
DO $c5$
DECLARE old_name text; new_name text; ordinal integer := 0;
BEGIN
  FOR old_name IN SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'fbo_c5_archive___C5_STAMP__'
  LOOP
    ordinal := ordinal + 1;
    new_name := 'fbo_c5___C5_STAMP___' || ordinal;
    EXECUTE format('ALTER INDEX %I RENAME TO %I', old_name, new_name);
  END LOOP;
END
$c5$;
CREATE TABLE multiremi_feishu_bot_outbound_deliveries (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  task_id TEXT UNIQUE, chat_id TEXT NOT NULL, thread_id TEXT, reply_to_message_id TEXT,
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', claim_token TEXT,
  leased_until TEXT, available_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  external_message_id TEXT, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, mention_snapshot TEXT, presentation_checkpoint TEXT,
  interaction_open_id TEXT, attachments TEXT, previous_delivery_id TEXT, kind TEXT,
  human_request_id TEXT, human_request_task_id TEXT, expires_at TEXT,
  target_message_id TEXT, degraded TEXT, decision_id TEXT, decision_issue_id TEXT
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
DO $c5$
BEGIN
  IF (SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries) <>
    (SELECT COUNT(*) FROM fbo_c5_archive___C5_STAMP__ WHERE task_id IS NULL
      OR (unit_key = '' AND (kind IS NULL OR kind = 'cot')))
  OR (SELECT COUNT(*) FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id IS NULL) <>
    (SELECT COUNT(*) FROM fbo_c5_archive___C5_STAMP__ WHERE task_id IS NULL)
  OR NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'multiremi_feishu_bot_outbound_deliveries'
        AND c.contype = 'u' AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
          WHERE attrelid = t.oid AND attname = 'task_id')]::smallint[]) THEN
    RAISE EXCEPTION 'C5 restore post-check failed';
  END IF;
END
$c5$;
COMMIT;
