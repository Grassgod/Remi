// Byte-exact claim SELECT captured on a258b970. The MUL-449 refactor only moves
// these predicates into shared fragments; any textual difference is a bug.
export const MUL449_CLAIM_SQL_GOLDEN = String.raw`UPDATE multiremi_tasks
       SET status = 'dispatched', runtime_id = ?, dispatched_at = ?, wait_reason = NULL, updated_at = ?
       WHERE id = (
         SELECT t.id
         FROM multiremi_tasks t
         JOIN multiremi_agents a ON a.id = t.agent_id
         LEFT JOIN multiremi_chat_sessions project_chat ON project_chat.id = t.chat_session_id
         LEFT JOIN multiremi_issues project_issue ON project_issue.id = t.issue_id
         LEFT JOIN multiremi_issue_sessions code_session ON code_session.id = t.issue_session_id
         LEFT JOIN multiremi_runtimes code_runtime ON code_runtime.id = code_session.code_runtime_id
         WHERE t.status = 'queued'
           AND (t.next_retry_at IS NULL OR t.next_retry_at <= ?)
           AND a.archived_at IS NULL
           AND (t.chat_session_id IS NULL OR project_chat.status = 'active')
           AND NOT EXISTS (
             SELECT 1 FROM multiremi_tasks earlier WHERE earlier.chat_session_id = t.chat_session_id
               AND earlier.status = 'queued' AND (
                 earlier.priority > t.priority
                 OR (earlier.priority = t.priority AND earlier.chat_queue_order < t.chat_queue_order)
                 OR (earlier.priority = t.priority AND earlier.chat_queue_order = t.chat_queue_order AND earlier.created_at < t.created_at)
                 OR (earlier.priority = t.priority AND earlier.chat_queue_order = t.chat_queue_order AND earlier.created_at = t.created_at AND earlier.id < t.id)
               )
           )
           AND a.workspace_id = t.workspace_id
           AND (
             SELECT COUNT(*)
             FROM multiremi_tasks runtime_active
             WHERE runtime_active.runtime_id = ?
               AND runtime_active.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
           ) < ?
           AND COALESCE(t.workspace_id, 'local') = ?
           AND (t.issue_id IS NULL OR t.holds_workspace = 0 OR ? = 1)
           AND (t.issue_id IS NULL OR ? = 1)
           AND (t.runtime_workspace_id IS NULL OR (? = 1 AND EXISTS (
             SELECT 1 FROM multiremi_runtime_workspaces rw
             WHERE rw.id = t.runtime_workspace_id AND rw.workspace_id = t.workspace_id
               AND rw.daemon_id = ? AND rw.archived_at IS NULL
           )))
           AND (
             t.runtime_workspace_id IS NOT NULL OR t.issue_id IS NULL
             OR t.holds_workspace = 0
             OR NOT EXISTS (
               SELECT 1 FROM multiremi_issue_workspaces issue_workspace
               WHERE issue_workspace.issue_id = t.issue_id
                 AND issue_workspace.status <> 'cleaned'
             )
             OR EXISTS (
               SELECT 1 FROM multiremi_issue_workspaces issue_workspace
               LEFT JOIN multiremi_runtimes issue_workspace_runtime
                 ON issue_workspace_runtime.id = issue_workspace.runtime_id
               WHERE issue_workspace.issue_id = t.issue_id
                 AND issue_workspace.status <> 'cleaned'
                 AND (
                   issue_workspace.runtime_id IN (?, ?)
                   OR issue_workspace_runtime.daemon_id IN (?, ?)
                   OR issue_workspace_runtime.legacy_daemon_id IN (?, ?)
                 )
             )
           )
           AND (
  (
    CASE WHEN t.runtime_workspace_id IS NOT NULL THEN NULL ELSE COALESCE(project_issue.project_id, (
  SELECT chat_project.id FROM multiremi_projects chat_project
  WHERE chat_project.id = project_chat.project_id
    AND chat_project.workspace_id = t.workspace_id AND chat_project.archived_at IS NULL
)) END IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM multiremi_project_devices project_device
      WHERE project_device.project_id = CASE WHEN t.runtime_workspace_id IS NOT NULL THEN NULL ELSE COALESCE(project_issue.project_id, (
  SELECT chat_project.id FROM multiremi_projects chat_project
  WHERE chat_project.id = project_chat.project_id
    AND chat_project.workspace_id = t.workspace_id AND chat_project.archived_at IS NULL
)) END
    )
    OR EXISTS (
      SELECT 1 FROM multiremi_project_devices project_device
      WHERE project_device.project_id = CASE WHEN t.runtime_workspace_id IS NOT NULL THEN NULL ELSE COALESCE(project_issue.project_id, (
  SELECT chat_project.id FROM multiremi_projects chat_project
  WHERE chat_project.id = project_chat.project_id
    AND chat_project.workspace_id = t.workspace_id AND chat_project.archived_at IS NULL
)) END
        AND project_device.daemon_id = ?
    )
  )
  AND (
    ? = 0
    OR (
      CASE WHEN t.runtime_workspace_id IS NOT NULL THEN NULL ELSE COALESCE(project_issue.project_id, (
  SELECT chat_project.id FROM multiremi_projects chat_project
  WHERE chat_project.id = project_chat.project_id
    AND chat_project.workspace_id = t.workspace_id AND chat_project.archived_at IS NULL
)) END IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM multiremi_project_devices project_device
        WHERE project_device.project_id = CASE WHEN t.runtime_workspace_id IS NOT NULL THEN NULL ELSE COALESCE(project_issue.project_id, (
  SELECT chat_project.id FROM multiremi_projects chat_project
  WHERE chat_project.id = project_chat.project_id
    AND chat_project.workspace_id = t.workspace_id AND chat_project.archived_at IS NULL
)) END
          AND project_device.daemon_id = ?
      )
    )
  )
)
           AND (
             COALESCE(code_session.with_code, 0) = 0
             OR code_session.code_runtime_id IN (?, ?)
             OR code_runtime.daemon_id IN (?, ?)
             OR code_runtime.legacy_daemon_id IN (?, ?)
           )
           AND (t.runtime_id IS NULL OR t.runtime_id = ?)
           AND (a.runtime_id IS NULL OR a.runtime_id = ?)
           AND (a.execution_group_id IS NULL OR EXISTS (
             SELECT 1 FROM multiremi_execution_group_members gm
             WHERE gm.runtime_id = ? AND gm.provider = a.provider
               AND gm.workspace_id = a.workspace_id AND gm.group_id = a.execution_group_id
           ))
           AND (? = 'any' OR a.provider = ?)
           AND (? = 'public' OR COALESCE(CAST(? AS TEXT), 'local') = COALESCE(a.owner_id, 'local'))
           AND NOT EXISTS (
             SELECT 1
             FROM multiremi_task_plugin_snapshots task_plugin
             JOIN multiremi_agent_plugin_versions task_plugin_version
               ON task_plugin_version.id = task_plugin.version_id
             LEFT JOIN multiremi_agent_plugin_runtime_states task_plugin_state
               ON task_plugin_state.runtime_id = ?
              AND task_plugin_state.plugin_version_id = task_plugin.version_id
              AND task_plugin_state.desired = 1
             WHERE task_plugin.task_id = t.id
               AND (
                 task_plugin_state.id IS NULL
                 OR task_plugin_state.status <> 'ready'
                 OR task_plugin_state.observed_digest IS NULL
                 OR task_plugin_state.observed_digest <> task_plugin_version.artifact_digest
               )
           )
           AND (
             t.execution_fingerprint IS NOT NULL
             OR NOT EXISTS (
               SELECT 1
               FROM multiremi_agent_plugin_bindings agent_plugin
               JOIN multiremi_agent_plugins plugin ON plugin.id = agent_plugin.plugin_id
               LEFT JOIN multiremi_agent_plugin_versions plugin_version
                 ON plugin_version.id = CASE
                   WHEN agent_plugin.version_policy = 'pinned' THEN agent_plugin.version_id
                   ELSE plugin.active_version_id
                 END
               LEFT JOIN multiremi_agent_plugin_runtime_states plugin_state
                 ON plugin_state.runtime_id = ?
                AND plugin_state.plugin_version_id = plugin_version.id
                AND plugin_state.desired = 1
               WHERE agent_plugin.agent_id = a.id
                 AND agent_plugin.enabled = 1
                 AND plugin.archived_at IS NULL
                 AND (
                   plugin_version.id IS NULL
                   OR plugin_state.id IS NULL
                   OR plugin_state.status <> 'ready'
                   OR plugin_state.observed_digest IS NULL
                   OR plugin_state.observed_digest <> plugin_version.artifact_digest
                 )
             )
           )
           AND (
             SELECT COUNT(*)
             FROM multiremi_tasks running
             WHERE running.agent_id = t.agent_id
               AND running.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
           ) < a.max_concurrent_tasks
           AND NOT EXISTS (
             SELECT 1 FROM multiremi_tasks active
             WHERE active.status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')
               AND ((t.runtime_workspace_id IS NOT NULL AND active.runtime_workspace_id = t.runtime_workspace_id)
    OR (active.agent_id = t.agent_id AND (
    (t.issue_session_id IS NOT NULL AND active.issue_session_id = t.issue_session_id
      AND (CASE WHEN t.delegated_by_agent_id IS NOT NULL
    AND t.agent_id <> t.delegated_by_agent_id
    THEN COALESCE(t.delegation_id, '') ELSE '' END) = (CASE WHEN active.delegated_by_agent_id IS NOT NULL
    AND active.agent_id <> active.delegated_by_agent_id
    THEN COALESCE(active.delegation_id, '') ELSE '' END))
    OR (t.chat_session_id IS NOT NULL AND active.chat_session_id = t.chat_session_id)
    OR (t.issue_id IS NOT NULL AND t.issue_session_id IS NULL
      AND active.issue_id = t.issue_id AND active.issue_session_id IS NULL)
  )))
           )
           AND t.codex_profile IS NULL
           AND t.claude_profile IS NULL
           
           
           
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT 1
       )
       AND status = 'queued'
       RETURNING *`;
