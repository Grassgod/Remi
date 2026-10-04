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

// Recheck eligibility by lane key after taking the workspace lock. Discovery
// uses the pending-hint index below, never the log or the full lane history.
export const RE_RING_SWEEP_CANDIDATES_SQL = `SELECT l.session_id, l.agent_id, l.execution_scope,
  l.cursor_seq, l.swept_to_seq, l.wake_hint_seq, l.last_task_id, h.head_seq, s.issue_id, s.workspace_id
FROM multiremi_agent_lane_records l
JOIN multiremi_conversation_heads h ON h.session_id = l.session_id
JOIN multiremi_issue_sessions s ON s.id = l.session_id AND s.status = 'active'
JOIN multiremi_agents a ON a.id = l.agent_id AND a.archived_at IS NULL AND a.workspace_id = s.workspace_id
WHERE l.status = 'active' AND substr(l.execution_scope, 1, 6) <> 'relay:'
  AND l.wake_hint_seq > l.swept_to_seq
  AND h.head_seq > CASE WHEN l.cursor_seq > l.swept_to_seq THEN l.cursor_seq ELSE l.swept_to_seq END
  AND NOT EXISTS (
    SELECT 1 FROM multiremi_turn_execution_records t
    WHERE t.issue_session_id = l.session_id AND t.agent_id = l.agent_id AND t.execution_scope = l.execution_scope
      AND t.status IN ('queued','dispatched','running','waiting_local_directory','awaiting_human'))`;

// Only lanes with unexamined now-envelope hints occupy the rotation. Archived
// recipients and relay scopes are visited once to retire their stale hints.
export const RE_RING_SWEEP_PAGE_SQL = `WITH lane_page AS (
  SELECT session_id, agent_id, execution_scope, last_task_id
  FROM multiremi_agent_lane_records
  WHERE status = 'active' AND wake_hint_seq > swept_to_seq
  ORDER BY COALESCE(swept_at, ''), session_id, agent_id, execution_scope LIMIT ?
)
SELECT p.*, s.issue_id, s.workspace_id FROM lane_page p
JOIN multiremi_issue_sessions s ON s.id = p.session_id`;

export interface ReRingSweepResult {
  /** Pending-hint page entries visited, including unavailable/blocked lanes. */
  visited: number;
  /** Visited lanes eligible for a log window, including failed attempts. */
  eligible: number;
  /** A full page suggests backlog; no unbounded COUNT is needed. */
  pageFull: boolean;
  lanes: number;
  examined: number;
  rang: number;
  coalesced: number;
  errors: number;
}
