import { type SqlDatabase } from "@multiremi/store/db/sql-database.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("multiremi-store");

// Stable Feishu open_id of the deployment owner (hehuajie / 贺华杰). The seed
// `local` user is tagged with this on migration so SSO login re-binds to it
// instead of creating a duplicate. Overridable via MULTIREMI_OWNER_OPEN_ID.
const DEFAULT_OWNER_OPEN_ID = "ou_e6b7ffc662b392317275b817295c0b44";

export function runMigrations(db: SqlDatabase): void {
  renameLegacyMulticaObjects(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      provider TEXT NOT NULL,
      owner_id TEXT NOT NULL DEFAULT 'local',
      visibility TEXT NOT NULL DEFAULT 'private',
      runtime_id TEXT,
      instructions TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '[]',
      max_concurrent_tasks INTEGER NOT NULL DEFAULT 6,
      cwd TEXT,
      executable TEXT,
      model TEXT,
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      custom_env TEXT NOT NULL DEFAULT '{}',
      custom_args TEXT NOT NULL DEFAULT '[]',
      mcp_config TEXT,
      thinking_level TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_skills (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, name)
    );

    CREATE TABLE IF NOT EXISTS multiremi_skill_files (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(skill_id, path),
      FOREIGN KEY(skill_id) REFERENCES multiremi_skills(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS multiremi_agent_skills (
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, skill_id),
      FOREIGN KEY(agent_id) REFERENCES multiremi_agents(id) ON DELETE CASCADE,
      FOREIGN KEY(skill_id) REFERENCES multiremi_skills(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_skills_workspace ON multiremi_skills(workspace_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_skill_files_skill ON multiremi_skill_files(skill_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_skills_agent ON multiremi_agent_skills(agent_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_skills_skill ON multiremi_agent_skills(skill_id);

    CREATE TABLE IF NOT EXISTS multiremi_runtimes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      daemon_id TEXT,
      legacy_daemon_id TEXT,
      runtime_mode TEXT NOT NULL DEFAULT 'local',
      device_info TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      workspace_id TEXT,
      owner_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      status TEXT NOT NULL DEFAULT 'online',
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_cloud_runtime_nodes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'local',
      instance_id TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT 'local',
      instance_type TEXT NOT NULL,
      image_id TEXT NOT NULL DEFAULT '',
      subnet_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'launching',
      tags TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_cloud_runtime_nodes_owner
      ON multiremi_cloud_runtime_nodes(owner_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_models (
      runtime_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      thinking TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(runtime_id, model_id),
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_models_runtime ON multiremi_runtime_models(runtime_id, is_default);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_model_list_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      models TEXT NOT NULL DEFAULT '[]',
      supported INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_model_list_runtime ON multiremi_runtime_model_list_requests(runtime_id, status, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_update_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      scope TEXT NOT NULL DEFAULT 'cli',
      target_version TEXT NOT NULL,
      output TEXT,
      error TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_update_runtime ON multiremi_runtime_update_requests(runtime_id, status, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_local_skill_list_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      skills TEXT NOT NULL DEFAULT '[]',
      supported INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_local_skill_list_runtime ON multiremi_runtime_local_skill_list_requests(runtime_id, status, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_local_skill_import_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      skill_key TEXT NOT NULL,
      name TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      skill_id TEXT,
      skill TEXT,
      error TEXT,
      created_by TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE,
      FOREIGN KEY(skill_id) REFERENCES multiremi_skills(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_local_skill_import_runtime ON multiremi_runtime_local_skill_import_requests(runtime_id, status, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_directory_scan_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      params TEXT NOT NULL DEFAULT '{}',
      candidates TEXT NOT NULL DEFAULT '[]',
      supported INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_directory_scan_runtime ON multiremi_runtime_directory_scan_requests(runtime_id, status, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      avatar_url TEXT,
      language TEXT,
      timezone TEXT,
      onboarded_at TEXT,
      onboarding_questionnaire TEXT NOT NULL DEFAULT '{}',
      starter_content_state TEXT,
      profile_description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      context TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      repos TEXT NOT NULL DEFAULT '[]',
      issue_prefix TEXT NOT NULL DEFAULT 'MUL',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_workspace_invitations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      inviter_id TEXT NOT NULL,
      invitee_email TEXT NOT NULL,
      invitee_user_id TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_invitations_workspace ON multiremi_workspace_invitations(workspace_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_invitations_invitee ON multiremi_workspace_invitations(invitee_email, invitee_user_id, status);

    CREATE TABLE IF NOT EXISTS multiremi_workspace_members (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_members_workspace ON multiremi_workspace_members(workspace_id);

    CREATE TABLE IF NOT EXISTS multiremi_access_tokens (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      daemon_id TEXT,
      task_id TEXT,
      agent_id TEXT,
      user_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'pat',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_access_tokens_workspace ON multiremi_access_tokens(workspace_id, type);
    CREATE INDEX IF NOT EXISTS idx_multiremi_access_tokens_hash ON multiremi_access_tokens(token_hash);

    CREATE TABLE IF NOT EXISTS multiremi_notification_preferences (
      workspace_id TEXT NOT NULL DEFAULT 'local',
      member_id TEXT NOT NULL DEFAULT '',
      preferences TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS multiremi_feedback (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      user_id TEXT NOT NULL DEFAULT 'local',
      member_id TEXT,
      message TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feedback_user_created ON multiremi_feedback(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_feedback_workspace_created ON multiremi_feedback(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_github_settings (
      workspace_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      pr_sidebar INTEGER NOT NULL DEFAULT 1,
      co_author INTEGER NOT NULL DEFAULT 1,
      auto_link_prs INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_github_pull_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      html_url TEXT NOT NULL,
      branch TEXT,
      author_login TEXT,
      author_avatar_url TEXT,
      merged_at TEXT,
      closed_at TEXT,
      pr_created_at TEXT NOT NULL,
      pr_updated_at TEXT NOT NULL,
      mergeable_state TEXT,
      checks_conclusion TEXT,
      checks_passed INTEGER NOT NULL DEFAULT 0,
      checks_failed INTEGER NOT NULL DEFAULT 0,
      checks_pending INTEGER NOT NULL DEFAULT 0,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      changed_files INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, repo_owner, repo_name, number)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_github_prs_issue ON multiremi_github_pull_requests(issue_id, pr_updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_github_prs_workspace ON multiremi_github_pull_requests(workspace_id, pr_updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_issues (
      id TEXT PRIMARY KEY,
      issue_number INTEGER NOT NULL DEFAULT 0,
      issue_key TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'none',
      workspace_id TEXT NOT NULL DEFAULT 'local',
      project_id TEXT,
      parent_issue_id TEXT,
      assignee_type TEXT,
      assignee_id TEXT,
      position REAL NOT NULL DEFAULT 0,
      start_date TEXT,
      due_date TEXT,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      context_refs TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(parent_issue_id) REFERENCES multiremi_issues(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      author_type TEXT NOT NULL DEFAULT 'member',
      author_id TEXT,
      parent_id TEXT,
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'comment',
      resolved_at TEXT,
      resolved_by_type TEXT,
      resolved_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_id) REFERENCES multiremi_issue_comments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_comments_issue ON multiremi_issue_comments(issue_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_issue_activity (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT,
      type TEXT NOT NULL,
      body TEXT,
      data TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_activity_issue ON multiremi_issue_activity(issue_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_issue_dependencies (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT NOT NULL,
      depends_on_issue_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(issue_id, depends_on_issue_id, type),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_dependencies_issue ON multiremi_issue_dependencies(issue_id, type);
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_dependencies_depends_on ON multiremi_issue_dependencies(depends_on_issue_id, type);
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_dependencies_workspace ON multiremi_issue_dependencies(workspace_id);

    CREATE TABLE IF NOT EXISTS multiremi_issue_subscribers (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      user_type TEXT NOT NULL DEFAULT 'member',
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      UNIQUE(issue_id, user_type, user_id),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_issue ON multiremi_issue_subscribers(issue_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_member ON multiremi_issue_subscribers(member_id);
    -- The (user_type, user_id) index is created by ensureIssueSubscriberTypedSchema(),
    -- which runs after this block and rebuilds pre-typed-column tables first. Creating
    -- it here would crash on an existing DB whose subscribers table lacks user_type.

    CREATE TABLE IF NOT EXISTS multiremi_inbox_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT,
      member_id TEXT NOT NULL,
      recipient_type TEXT NOT NULL DEFAULT 'member',
      recipient_id TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      details TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(member_id) REFERENCES multiremi_workspace_members(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_inbox_member ON multiremi_inbox_items(member_id, archived, read, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_issue_labels (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_issue_labels_workspace_name
      ON multiremi_issue_labels(workspace_id, lower(name));
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_labels_workspace
      ON multiremi_issue_labels(workspace_id, name);

    CREATE TABLE IF NOT EXISTS multiremi_issue_to_labels (
      issue_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY(issue_id, label_id),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(label_id) REFERENCES multiremi_issue_labels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_to_labels_label ON multiremi_issue_to_labels(label_id);

    CREATE TABLE IF NOT EXISTS multiremi_issue_reactions (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(issue_id, actor_type, actor_id, emoji),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_reactions_issue ON multiremi_issue_reactions(issue_id);

    CREATE TABLE IF NOT EXISTS multiremi_comment_reactions (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(comment_id, actor_type, actor_id, emoji),
      FOREIGN KEY(comment_id) REFERENCES multiremi_issue_comments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_comment_reactions_comment ON multiremi_comment_reactions(comment_id);

    CREATE TABLE IF NOT EXISTS multiremi_attachments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT,
      comment_id TEXT,
      chat_session_id TEXT,
      chat_message_id TEXT,
      uploader_type TEXT NOT NULL DEFAULT 'member',
      uploader_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(comment_id) REFERENCES multiremi_issue_comments(id) ON DELETE CASCADE,
      FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(chat_message_id) REFERENCES multiremi_chat_messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_attachments_issue ON multiremi_attachments(issue_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_attachments_comment ON multiremi_attachments(comment_id);
    -- chat_session_id / chat_message_id indexes are created after addColumnIfMissing (below);
    -- those columns are added by upgrade migrations on pre-existing DBs, so indexing them
    -- here would crash an old DB whose attachments table predates the columns.
    CREATE INDEX IF NOT EXISTS idx_multiremi_attachments_workspace ON multiremi_attachments(workspace_id);

    CREATE TABLE IF NOT EXISTS multiremi_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      priority TEXT NOT NULL DEFAULT 'none',
      workspace_id TEXT NOT NULL DEFAULT 'local',
      lead_type TEXT,
      lead_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_projects_workspace ON multiremi_projects(workspace_id);

    CREATE TABLE IF NOT EXISTS multiremi_project_resources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      resource_type TEXT NOT NULL,
      resource_ref TEXT NOT NULL DEFAULT '{}',
      label TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT,
      UNIQUE(project_id, resource_type, resource_ref),
      FOREIGN KEY(project_id) REFERENCES multiremi_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_project_resources_project ON multiremi_project_resources(project_id, position);

    CREATE TABLE IF NOT EXISTS multiremi_pinned_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      user_id TEXT NOT NULL DEFAULT 'local',
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, user_id, item_type, item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_pinned_items_user_ws
      ON multiremi_pinned_items(workspace_id, user_id, position, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_squads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT 'local',
      leader_id TEXT,
      creator_id TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_squads_workspace ON multiremi_squads(workspace_id);

    CREATE TABLE IF NOT EXISTS multiremi_squad_members (
      id TEXT PRIMARY KEY,
      squad_id TEXT NOT NULL,
      member_type TEXT NOT NULL,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      UNIQUE(squad_id, member_type, member_id),
      FOREIGN KEY(squad_id) REFERENCES multiremi_squads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_squad_members_squad ON multiremi_squad_members(squad_id);

    CREATE TABLE IF NOT EXISTS multiremi_autopilots (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      project_id TEXT,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      assignee_type TEXT NOT NULL DEFAULT 'agent',
      assignee_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      execution_mode TEXT NOT NULL DEFAULT 'create_issue',
      issue_title_template TEXT,
      trigger_kind TEXT NOT NULL DEFAULT 'manual',
      trigger_label TEXT,
      cron_expression TEXT,
      created_by_type TEXT NOT NULL DEFAULT 'member',
      created_by_id TEXT NOT NULL DEFAULT 'local',
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES multiremi_projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_autopilots_workspace ON multiremi_autopilots(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_autopilots_assignee ON multiremi_autopilots(assignee_type, assignee_id);

    CREATE TABLE IF NOT EXISTS multiremi_autopilot_triggers (
      id TEXT PRIMARY KEY,
      autopilot_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'webhook',
      enabled INTEGER NOT NULL DEFAULT 1,
      cron_expression TEXT,
      timezone TEXT,
      next_run_at TEXT,
      webhook_token TEXT UNIQUE,
      webhook_url TEXT,
      provider TEXT,
      label TEXT,
      event_filters TEXT,
      signing_secret_hash TEXT,
      signing_secret_hint TEXT,
      last_fired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(autopilot_id) REFERENCES multiremi_autopilots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_autopilot_triggers_autopilot
      ON multiremi_autopilot_triggers(autopilot_id, enabled, kind);
    CREATE INDEX IF NOT EXISTS idx_multiremi_autopilot_triggers_token
      ON multiremi_autopilot_triggers(webhook_token);

    CREATE TABLE IF NOT EXISTS multiremi_autopilot_runs (
      id TEXT PRIMARY KEY,
      autopilot_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      issue_id TEXT,
      task_id TEXT,
      triggered_at TEXT NOT NULL,
      completed_at TEXT,
      failure_reason TEXT,
      payload TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(autopilot_id) REFERENCES multiremi_autopilots(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id),
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_autopilot_runs_autopilot ON multiremi_autopilot_runs(autopilot_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_webhook_deliveries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      autopilot_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'generic',
      event TEXT NOT NULL DEFAULT 'webhook.received',
      dedupe_key TEXT,
      dedupe_source TEXT,
      signature_status TEXT NOT NULL DEFAULT 'not_required',
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 1,
      selected_headers TEXT NOT NULL DEFAULT '{}',
      content_type TEXT,
      raw_body TEXT,
      response_status INTEGER,
      response_body TEXT,
      autopilot_run_id TEXT,
      replayed_from_delivery_id TEXT,
      error TEXT,
      received_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(autopilot_id) REFERENCES multiremi_autopilots(id) ON DELETE CASCADE,
      FOREIGN KEY(autopilot_run_id) REFERENCES multiremi_autopilot_runs(id) ON DELETE SET NULL,
      FOREIGN KEY(replayed_from_delivery_id) REFERENCES multiremi_webhook_deliveries(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_webhook_deliveries_autopilot
      ON multiremi_webhook_deliveries(autopilot_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_webhook_deliveries_run
      ON multiremi_webhook_deliveries(autopilot_run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_webhook_deliveries_dedupe
      ON multiremi_webhook_deliveries(trigger_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status NOT IN ('rejected', 'failed');

    CREATE TABLE IF NOT EXISTS multiremi_chat_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      creator_id TEXT,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      session_id TEXT,
      work_dir TEXT,
      latest_task_id TEXT,
      unread_since TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(agent_id) REFERENCES multiremi_agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_chat_sessions_workspace ON multiremi_chat_sessions(workspace_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_chat_sessions_agent ON multiremi_chat_sessions(agent_id);

    CREATE TABLE IF NOT EXISTS multiremi_chat_messages (
      id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL,
      task_id TEXT,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      failure_reason TEXT,
      elapsed_ms INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_chat_messages_session ON multiremi_chat_messages(chat_session_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      runtime_id TEXT,
      issue_id TEXT,
      chat_session_id TEXT,
      trigger_comment_id TEXT,
      trigger_summary TEXT,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      prompt TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      parent_task_id TEXT,
      result TEXT,
      error TEXT,
      failure_reason TEXT,
      branch_name TEXT,
      session_id TEXT,
      work_dir TEXT,
      progress_summary TEXT,
      progress_step INTEGER,
      progress_total INTEGER,
      wait_reason TEXT,
      usage TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dispatched_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      cancelled_at TEXT,
      FOREIGN KEY(agent_id) REFERENCES multiremi_agents(id),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id),
      FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY(trigger_comment_id) REFERENCES multiremi_issue_comments(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_status ON multiremi_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_runtime ON multiremi_tasks(runtime_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_issue ON multiremi_tasks(issue_id);
    -- trigger_comment_id index is created after addColumnIfMissing (below); the column is
    -- added by an upgrade migration on pre-existing DBs.
    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_workspace ON multiremi_tasks(workspace_id);

    CREATE TABLE IF NOT EXISTS multiremi_task_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      tool TEXT,
      content TEXT,
      input TEXT,
      output TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, seq),
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_messages_task ON multiremi_task_messages(task_id, seq);

    CREATE TABLE IF NOT EXISTS multiremi_task_human_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      response TEXT,
      responded_by TEXT,
      created_at TEXT NOT NULL,
      responded_at TEXT,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_human_requests_task ON multiremi_task_human_requests(task_id, status);
  `);
  db.exec(`
    DELETE FROM multiremi_task_messages
    WHERE rowid NOT IN (
      SELECT MAX(rowid)
      FROM multiremi_task_messages
      GROUP BY task_id, seq
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_messages_task_seq_unique
      ON multiremi_task_messages(task_id, seq);
  `);
  addColumnIfMissing(db, "multiremi_agents", "workspace_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_agents", "description TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "multiremi_agents", "avatar_url TEXT");
  addColumnIfMissing(db, "multiremi_agents", "owner_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_agents", "visibility TEXT NOT NULL DEFAULT 'private'");
  addColumnIfMissing(db, "multiremi_agents", "archived_at TEXT");
  addColumnIfMissing(db, "multiremi_agents", "runtime_id TEXT");
  addColumnIfMissing(db, "multiremi_agents", "max_concurrent_tasks INTEGER NOT NULL DEFAULT 6");
  addColumnIfMissing(db, "multiremi_runtimes", "daemon_id TEXT");
  addColumnIfMissing(db, "multiremi_runtimes", "legacy_daemon_id TEXT");
  addColumnIfMissing(db, "multiremi_runtimes", "runtime_mode TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_runtimes", "device_info TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "multiremi_runtimes", "metadata TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "multiremi_runtimes", "owner_id TEXT");
  addColumnIfMissing(db, "multiremi_runtimes", "visibility TEXT NOT NULL DEFAULT 'private'");
  addColumnIfMissing(db, "multiremi_runtimes", "name_customized INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_access_tokens", "daemon_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "task_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "agent_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "user_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_issues", "assignee_type TEXT");
  addColumnIfMissing(db, "multiremi_issues", "assignee_id TEXT");
  addColumnIfMissing(db, "multiremi_issues", "metadata TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "multiremi_issues", "issue_number INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_issues", "issue_key TEXT");
  addColumnIfMissing(db, "multiremi_issues", "priority TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(db, "multiremi_issues", "parent_issue_id TEXT");
  addColumnIfMissing(db, "multiremi_issues", "position REAL NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_issues", "start_date TEXT");
  addColumnIfMissing(db, "multiremi_issues", "due_date TEXT");
  addColumnIfMissing(db, "multiremi_issues", "acceptance_criteria TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "multiremi_issues", "context_refs TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "multiremi_issue_comments", "parent_id TEXT");
  addColumnIfMissing(db, "multiremi_issue_comments", "type TEXT NOT NULL DEFAULT 'comment'");
  addColumnIfMissing(db, "multiremi_issue_comments", "resolved_at TEXT");
  addColumnIfMissing(db, "multiremi_issue_comments", "resolved_by_type TEXT");
  addColumnIfMissing(db, "multiremi_issue_comments", "resolved_by_id TEXT");
  addColumnIfMissing(db, "multiremi_attachments", "chat_session_id TEXT");
  addColumnIfMissing(db, "multiremi_attachments", "chat_message_id TEXT");
  ensureIssueSubscriberTypedSchema(db);
  addColumnIfMissing(db, "multiremi_chat_sessions", "creator_id TEXT");
  addColumnIfMissing(db, "multiremi_chat_sessions", "unread_since TEXT");
  addColumnIfMissing(db, "multiremi_chat_messages", "failure_reason TEXT");
  addColumnIfMissing(db, "multiremi_chat_messages", "elapsed_ms INTEGER");
  addColumnIfMissing(db, "multiremi_tasks", "chat_session_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "wait_reason TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "failure_reason TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "attempt INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "multiremi_tasks", "max_attempts INTEGER NOT NULL DEFAULT 3");
  addColumnIfMissing(db, "multiremi_tasks", "parent_task_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "trigger_comment_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "trigger_summary TEXT");
  addColumnIfMissing(db, "multiremi_inbox_items", "recipient_type TEXT NOT NULL DEFAULT 'member'");
  addColumnIfMissing(db, "multiremi_inbox_items", "recipient_id TEXT");
  addColumnIfMissing(db, "multiremi_inbox_items", "severity TEXT NOT NULL DEFAULT 'info'");
  addColumnIfMissing(db, "multiremi_inbox_items", "details TEXT");
  ensureInboxGenericSchema(db);
  addColumnIfMissing(db, "multiremi_autopilots", "created_by_type TEXT NOT NULL DEFAULT 'member'");
  addColumnIfMissing(db, "multiremi_autopilots", "created_by_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_autopilot_triggers", "event_filters TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_triggers", "provider TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_triggers", "signing_secret_hint TEXT");
  addColumnIfMissing(db, "multiremi_runtime_update_requests", "scope TEXT NOT NULL DEFAULT 'cli'");
  // Multi-user auth: stable external identity (Feishu open_id) on users, and an
  // explicit user↔member link so membership no longer relies solely on the
  // legacy `mem_<ws>_<userId>` id convention.
  addColumnIfMissing(db, "multiremi_users", "external_id TEXT");
  addColumnIfMissing(db, "multiremi_workspace_members", "user_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_users_external_id ON multiremi_users(external_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_members_user ON multiremi_workspace_members(user_id, workspace_id)");
  backfillMemberUserIds(db);
  backfillOwnerExternalId(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_trigger_comment ON multiremi_tasks(trigger_comment_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issues_parent ON multiremi_issues(parent_issue_id, position, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issues_scheduled ON multiremi_issues(workspace_id, start_date, due_date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issue_comments_parent ON multiremi_issue_comments(parent_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_attachments_chat_session ON multiremi_attachments(chat_session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_attachments_chat_message ON multiremi_attachments(chat_message_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issue_comments_resolved ON multiremi_issue_comments(issue_id, resolved_at)");
  db.run("UPDATE multiremi_issues SET status = 'todo' WHERE status = 'open'");
  // Pool scheduling: agents are logical workers and never bind to a machine.
  // Runs every startup so legacy pins converge back into the pool.
  db.run("UPDATE multiremi_agents SET runtime_id = NULL WHERE runtime_id IS NOT NULL");
  // Pre-pool, every queued task inherited its agent's runtime pin. Now that
  // agents are unbound, a plain pin would keep the task claimable only by the
  // original machine (stranding it when that machine is offline). Drop the pin
  // from queued tasks that carry NO real affinity — a promoted provider
  // session_id marks a chat task that must return to its machine, so those are
  // preserved; local_directory tasks re-pin on their next scheduling pass.
  db.run("UPDATE multiremi_tasks SET runtime_id = NULL WHERE status = 'queued' AND runtime_id IS NOT NULL AND (session_id IS NULL OR session_id = '')");
  backfillIssueKeys(db);
}

function renameLegacyMulticaObjects(db: SqlDatabase): void {
  // One-time rebrand migration: pre-existing multica_* tables in the shared
  // remi.db are renamed to multiremi_* so their data carries over instead of
  // being orphaned by the CREATE TABLE IF NOT EXISTS statements below. Stale
  // idx_multica_* indexes are dropped and recreated under idx_multiremi_*.
  // Idempotent: once renamed there is nothing left to migrate.
  const objects = db
    .query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')")
    .all() as Array<{ name: string; type: string }>;
  for (const { name, type } of objects) {
    if (type === "table" && name.startsWith("multica_")) {
      const renamed = "multiremi_" + name.slice("multica_".length);
      const exists = objects.some((o) => o.type === "table" && o.name === renamed);
      if (!exists) db.exec(`ALTER TABLE "${name}" RENAME TO "${renamed}"`);
    } else if (type === "index" && name.startsWith("idx_multica_")) {
      db.exec(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
}

function addColumnIfMissing(db: SqlDatabase, table: string, definition: string): void {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (err) {
    const message = String((err as Error).message ?? err).toLowerCase();
    // Idempotency: the column already exists. SQLite says "duplicate column name",
    // Postgres says "column ... already exists". Any other ALTER failure is real.
    const alreadyExists = message.includes("duplicate column") || message.includes("already exists");
    if (!alreadyExists) {
      log.error(`addColumnIfMissing failed for ${table}.${definition}`, err);
      throw err;
    }
  }
}

function ensureIssueSubscriberTypedSchema(db: SqlDatabase): void {
  const columns = db.query("PRAGMA table_info(multiremi_issue_subscribers)").all() as Array<{ name: string }>;
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'multiremi_issue_subscribers'")
    .get() as { sql?: string } | null;
  const names = new Set(columns.map((column) => column.name));
  const hasTypedColumns = names.has("user_type") && names.has("user_id");
  const hasLegacyUnique = /\bUNIQUE\s*\(\s*issue_id\s*,\s*member_id\s*\)/i.test(table?.sql ?? "");

  if (hasTypedColumns && !hasLegacyUnique) {
    db.run("UPDATE multiremi_issue_subscribers SET user_type = 'member' WHERE user_type IS NULL OR user_type = ''");
    db.run("UPDATE multiremi_issue_subscribers SET user_id = member_id WHERE user_id IS NULL OR user_id = ''");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_issue ON multiremi_issue_subscribers(issue_id);
      CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_member ON multiremi_issue_subscribers(member_id);
      CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_user ON multiremi_issue_subscribers(user_type, user_id);
    `);
    return;
  }

  db.exec(`
    ALTER TABLE multiremi_issue_subscribers RENAME TO multiremi_issue_subscribers_legacy;
    DROP INDEX IF EXISTS idx_multiremi_issue_subscribers_issue;
    DROP INDEX IF EXISTS idx_multiremi_issue_subscribers_member;
    DROP INDEX IF EXISTS idx_multiremi_issue_subscribers_user;
    CREATE TABLE multiremi_issue_subscribers (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      user_type TEXT NOT NULL DEFAULT 'member',
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      UNIQUE(issue_id, user_type, user_id),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );
    INSERT INTO multiremi_issue_subscribers (id, issue_id, member_id, user_type, user_id, reason, created_at)
    SELECT id, issue_id, member_id, 'member', member_id, reason, created_at
    FROM multiremi_issue_subscribers_legacy;
    DROP TABLE multiremi_issue_subscribers_legacy;
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_issue ON multiremi_issue_subscribers(issue_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_member ON multiremi_issue_subscribers(member_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_subscribers_user ON multiremi_issue_subscribers(user_type, user_id);
  `);
}

function ensureInboxGenericSchema(db: SqlDatabase): void {
  const columns = db.query("PRAGMA table_info(multiremi_inbox_items)").all() as Array<{ name: string; notnull: number }>;
  const issueColumn = columns.find((column) => column.name === "issue_id");
  if (!issueColumn || Number(issueColumn.notnull ?? 0) === 0) {
    db.run("UPDATE multiremi_inbox_items SET recipient_type = COALESCE(NULLIF(recipient_type, ''), 'member')");
    db.run("UPDATE multiremi_inbox_items SET recipient_id = COALESCE(NULLIF(recipient_id, ''), member_id)");
    db.run("UPDATE multiremi_inbox_items SET severity = COALESCE(NULLIF(severity, ''), 'info')");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_multiremi_inbox_recipient
        ON multiremi_inbox_items(workspace_id, recipient_type, recipient_id, archived, read, created_at);
    `);
    return;
  }

  db.exec(`
    ALTER TABLE multiremi_inbox_items RENAME TO multiremi_inbox_items_legacy;
    DROP INDEX IF EXISTS idx_multiremi_inbox_member;
    DROP INDEX IF EXISTS idx_multiremi_inbox_recipient;
    CREATE TABLE multiremi_inbox_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT,
      member_id TEXT NOT NULL,
      recipient_type TEXT NOT NULL DEFAULT 'member',
      recipient_id TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      details TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(member_id) REFERENCES multiremi_workspace_members(id) ON DELETE CASCADE
    );
    INSERT INTO multiremi_inbox_items (
      id, workspace_id, issue_id, member_id, recipient_type, recipient_id, severity,
      actor_type, actor_id, type, title, body, details, read, archived, created_at
    )
    SELECT
      id, workspace_id, issue_id, member_id,
      COALESCE(NULLIF(recipient_type, ''), 'member'),
      COALESCE(NULLIF(recipient_id, ''), member_id),
      COALESCE(NULLIF(severity, ''), 'info'),
      actor_type, actor_id, type, title, body, details, read, archived, created_at
    FROM multiremi_inbox_items_legacy;
    DROP TABLE multiremi_inbox_items_legacy;
    CREATE INDEX IF NOT EXISTS idx_multiremi_inbox_member
      ON multiremi_inbox_items(member_id, archived, read, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_inbox_recipient
      ON multiremi_inbox_items(workspace_id, recipient_type, recipient_id, archived, read, created_at);
  `);
}

function backfillIssueKeys(db: SqlDatabase): void {
  const rows = db.query(
    "SELECT id, workspace_id FROM multiremi_issues WHERE issue_number = 0 OR issue_key IS NULL OR issue_key = '' ORDER BY created_at ASC",
  ).all() as Array<{ id: string; workspace_id?: string }>;
  for (const row of rows) {
    const workspaceId = String(row.workspace_id ?? "local");
    const number = nextIssueNumber(db, workspaceId);
    db.run(
      "UPDATE multiremi_issues SET issue_number = ?, issue_key = ? WHERE id = ?",
      [number, formatIssueKey(number), row.id],
    );
  }
}

// Populate multiremi_workspace_members.user_id from the legacy `mem_<ws>_<userId>`
// id convention so pre-existing members (created before the user_id column) keep
// resolving to their user. The workspace_id column gives us the exact prefix to
// strip, so extraction is deterministic even when the user id contains `_`.
function backfillMemberUserIds(db: SqlDatabase): void {
  const rows = db.query(
    "SELECT id, workspace_id FROM multiremi_workspace_members WHERE user_id IS NULL OR user_id = ''",
  ).all() as Array<{ id: string; workspace_id?: string }>;
  for (const row of rows) {
    const workspaceId = String(row.workspace_id ?? "local");
    const prefix = `mem_${workspaceId}_`;
    const id = String(row.id);
    if (!id.startsWith(prefix)) continue;
    const userId = id.slice(prefix.length);
    if (!userId) continue;
    db.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [userId, id]);
  }
}

// Tag the seed `local` user with the deployment owner's stable Feishu open_id so
// that when they log in via SSO, getOrCreateUser matches this existing record
// (keeping their id="local" ownership + history) instead of minting a new user.
// Only ever touches the pre-existing local row; a fresh install has none.
function backfillOwnerExternalId(db: SqlDatabase): void {
  const ownerOpenId = (process.env.MULTIREMI_OWNER_OPEN_ID ?? DEFAULT_OWNER_OPEN_ID).trim();
  if (!ownerOpenId) return;
  db.run(
    "UPDATE multiremi_users SET external_id = ? WHERE id = 'local' AND (external_id IS NULL OR external_id = '')",
    [ownerOpenId],
  );
}

function nextIssueNumber(db: SqlDatabase, workspaceId: string): number {
  const row = db.query(
    "SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multiremi_issues WHERE workspace_id = ?",
  ).get(workspaceId) as { next: number } | null;
  return Number(row?.next ?? 1);
}

function formatIssueKey(number: number): string {
  return `MUL-${number}`;
}
