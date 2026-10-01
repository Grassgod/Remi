export const RE_RING_SWEEP_LANE_LIMIT = 50;
export const RE_RING_SWEEP_ENTRY_LIMIT = 500;
export const RE_RING_SWEEP_MIN_AGE_MS = 60_000;
export const COMMENT_DISPATCH_REPLAY_DELAY_MS = 60_000;
export const COMMENT_DISPATCH_REPLAY_MAX_AGE_MS = 24 * 60 * 60_000;

export function reRingSweepEnabled(): boolean {
  return !["0", "false", "off", "disabled"].includes((process.env.MULTIREMI_RE_RING_SWEEP ?? "").trim().toLowerCase());
}

export function commentDispatchReplayEnabled(): boolean {
  return !["0", "false", "off", "disabled"].includes((process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY ?? "").trim().toLowerCase());
}

// Drive discovery from lanes and heads; never search the conversation log for
// candidates. The same predicate is rechecked after taking the workspace lock.
export const RE_RING_SWEEP_CANDIDATES_SQL = `SELECT l.session_id, l.agent_id, l.execution_scope,
  l.cursor_seq, l.swept_to_seq, l.last_task_id, h.head_seq, s.issue_id, s.workspace_id
FROM multiremi_session_agent_lanes l
JOIN multiremi_conversation_heads h ON h.session_id = l.session_id
JOIN multiremi_issue_sessions s ON s.id = l.session_id AND s.status = 'active'
JOIN multiremi_agents a ON a.id = l.agent_id AND a.archived_at IS NULL AND a.workspace_id = s.workspace_id
WHERE l.status = 'active' AND substr(l.execution_scope, 1, 6) <> 'relay:'
  AND h.head_seq > CASE WHEN l.cursor_seq > l.swept_to_seq THEN l.cursor_seq ELSE l.swept_to_seq END
  AND NOT EXISTS (
    SELECT 1 FROM multiremi_tasks t
    WHERE t.issue_session_id = l.session_id AND t.agent_id = l.agent_id AND t.execution_scope = l.execution_scope
      AND t.status IN ('queued','dispatched','running','waiting_local_directory','awaiting_human'))`;

// Bound discovery itself, not just its result: visit an indexed page before
// applying joins/eligibility. Rotate every visited lane, including blocked ones.
export const RE_RING_SWEEP_PAGE_SQL = `WITH lane_page AS (
  SELECT session_id, agent_id, execution_scope, last_task_id
  FROM multiremi_session_agent_lanes
  WHERE status = 'active' AND substr(execution_scope, 1, 6) <> 'relay:'
  ORDER BY COALESCE(swept_at, ''), session_id, agent_id, execution_scope LIMIT ?
)
SELECT p.*, s.issue_id, s.workspace_id FROM lane_page p
JOIN multiremi_issue_sessions s ON s.id = p.session_id`;

export interface ReRingSweepResult {
  lanes: number;
  examined: number;
  rang: number;
  coalesced: number;
  errors: number;
}
