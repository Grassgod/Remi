/** SQLite SQL, translated by the existing PG bridge. No backend-specific JSON indexing. */
export const UNIFIED_MODEL_MIGRATION = "20261004_unified_message_turn_lane";
export const UNIFIED_MESSAGE_COLUMNS = [
  "to_type TEXT NOT NULL DEFAULT 'none'",
  "to_ref TEXT", "to_agent_id TEXT", "to_member_id TEXT",
  "message_kind TEXT NOT NULL DEFAULT 'status'",
  "wake_requested TEXT NOT NULL DEFAULT 'inbox_only'",
  "wake_applied TEXT NOT NULL DEFAULT 'inbox_only'",
  "wake_reason TEXT NOT NULL DEFAULT 'migration'",
  "dedupe_key TEXT", "options TEXT",
  "card_token_hash TEXT", "card_token_recipient TEXT", "card_token_consumed_at TEXT",
] as const;

export const UNIFIED_TURNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS multiremi_turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  agent_id TEXT NOT NULL, execution_scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','running','awaiting_human','completed','failed','cancelled')),
  wake_source TEXT, wake_seq INTEGER NOT NULL DEFAULT 0,
  input_from_seq INTEGER, input_to_seq INTEGER, waiting_on_message_id TEXT,
  reply_message_id TEXT, wrap_up_requested_at TEXT, current_attempt_id TEXT,
  delegation_id TEXT, delegated_by_agent_id TEXT, delegation_return_turn_id TEXT,
  delegated_from_issue_session_id TEXT, delegation_skip_reason TEXT,
  continued_from_turn_id TEXT, holds_workspace INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0, requesting_user_name TEXT,
  requesting_user_profile_description TEXT, issue_id TEXT, workspace_id TEXT NOT NULL,
  legacy_prompt TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, ended_reason TEXT,
  UNIQUE(session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_turns_pending_lane
 ON multiremi_turns(session_id, agent_id, execution_scope) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_multiremi_turns_issue ON multiremi_turns(issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_multiremi_turns_agent ON multiremi_turns(agent_id, status);
`;

export const UNIFIED_LANES_SCHEMA = `
CREATE TABLE IF NOT EXISTS multiremi_session_lanes (
  session_id TEXT NOT NULL, reader_type TEXT NOT NULL CHECK(reader_type IN ('agent','member')),
  reader_id TEXT NOT NULL, execution_scope TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT, runtime_id TEXT, provider TEXT, work_dir TEXT,
  execution_fingerprint TEXT, cursor_seq INTEGER NOT NULL DEFAULT 0,
  wake_hint_seq INTEGER NOT NULL DEFAULT 0, swept_to_seq INTEGER NOT NULL DEFAULT 0, swept_at TEXT,
  parent_cursor_seq INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', last_attempt_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, reader_type, reader_id, execution_scope),
  CHECK(reader_type = 'agent' OR (execution_scope = '' AND provider_session_id IS NULL
    AND runtime_id IS NULL AND provider IS NULL AND work_dir IS NULL AND execution_fingerprint IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_multiremi_session_lanes_runtime ON multiremi_session_lanes(runtime_id, status);
CREATE INDEX IF NOT EXISTS idx_multiremi_session_lanes_reader ON multiremi_session_lanes(reader_type, reader_id, updated_at);
`;

export const UNIFIED_ATTEMPTS_SCHEMA = `
CREATE TABLE multiremi_turn_attempts (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('offered','accepted','running','waiting_local_directory','completed','failed','cancelled','lost')),
  runtime_id TEXT, provider TEXT, session_id TEXT, work_dir TEXT,
  plugin_snapshot TEXT NOT NULL DEFAULT '[]', codex_profile TEXT, claude_profile TEXT,
  execution_fingerprint TEXT, execution_model TEXT, execution_thinking_level TEXT,
  fallback_switched INTEGER NOT NULL DEFAULT 0, switch_reason TEXT,
  projection_from_seq INTEGER, projection_to_seq INTEGER, projection_mode TEXT,
  projection_degrade_level INTEGER NOT NULL DEFAULT 0, projection_truncated INTEGER NOT NULL DEFAULT 0,
  projection_omitted_events INTEGER NOT NULL DEFAULT 0, projection_estimated_tokens INTEGER NOT NULL DEFAULT 0,
  usage TEXT NOT NULL DEFAULT '[]', progress_summary TEXT, progress_step INTEGER, progress_total INTEGER,
  wait_reason TEXT, failure_reason TEXT, error TEXT, next_retry_at TEXT, branch_name TEXT,
  event_count INTEGER, tool_call_count INTEGER, type_histogram TEXT, model TEXT, trace_ref TEXT,
  offered_at TEXT, accepted_at TEXT, started_at TEXT, ended_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(turn_id, attempt_no), FOREIGN KEY(turn_id) REFERENCES multiremi_turns(id)
);
CREATE INDEX idx_multiremi_turn_attempts_runtime ON multiremi_turn_attempts(runtime_id, status);
`;
