import { type SqlDatabase } from "@multiremi/store/db/postgres.js";
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

    CREATE TABLE IF NOT EXISTS multiremi_agent_plugins (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'manifest',
      source_url TEXT,
      source_ref TEXT,
      source_subdir TEXT,
      active_version_id TEXT,
      candidate_version_id TEXT,
      created_by TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, provider, name)
    );

    CREATE TABLE IF NOT EXISTS multiremi_agent_plugin_versions (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      manifest TEXT NOT NULL DEFAULT '{}',
      artifact_files TEXT NOT NULL DEFAULT '[]',
      artifact_json TEXT NOT NULL,
      artifact_digest TEXT NOT NULL,
      artifact_size INTEGER NOT NULL DEFAULT 0,
      source_revision TEXT,
      requirements TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(plugin_id, version),
      FOREIGN KEY(plugin_id) REFERENCES multiremi_agent_plugins(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS multiremi_agent_plugin_bindings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      version_policy TEXT NOT NULL DEFAULT 'follow_active',
      version_id TEXT,
      connection_id TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, plugin_id),
      FOREIGN KEY(agent_id) REFERENCES multiremi_agents(id) ON DELETE CASCADE,
      FOREIGN KEY(plugin_id) REFERENCES multiremi_agent_plugins(id) ON DELETE CASCADE,
      FOREIGN KEY(version_id) REFERENCES multiremi_agent_plugin_versions(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_plugins_workspace
      ON multiremi_agent_plugins(workspace_id, provider, archived_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_plugin_versions_plugin
      ON multiremi_agent_plugin_versions(plugin_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_plugin_versions_digest
      ON multiremi_agent_plugin_versions(artifact_digest);
    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_plugin_bindings_agent
      ON multiremi_agent_plugin_bindings(agent_id, enabled, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_plugin_bindings_plugin
      ON multiremi_agent_plugin_bindings(plugin_id, enabled, updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_agent_plugin_workspace_locks (
      workspace_id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS multiremi_daemon_retirements (
      workspace_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      retired_by TEXT,
      retired_at TEXT NOT NULL,
      runtime_ids TEXT NOT NULL DEFAULT '[]',
      impact TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(workspace_id, daemon_id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_daemon_retirements_daemon
      ON multiremi_daemon_retirements(daemon_id, retired_at);

    CREATE TABLE IF NOT EXISTS multiremi_daemon_lifecycle_locks (
      workspace_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      owner_user_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, daemon_id)
    );

    CREATE TABLE IF NOT EXISTS multiremi_agent_plugin_runtime_states (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      runtime_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version_id TEXT NOT NULL,
      desired INTEGER NOT NULL DEFAULT 1,
      desired_reason TEXT NOT NULL DEFAULT 'active_binding',
      status TEXT NOT NULL DEFAULT 'pending',
      observed_digest TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_generation INTEGER NOT NULL DEFAULT 0,
      pending_heartbeat_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error_code TEXT,
      last_error TEXT,
      last_attempt_at TEXT,
      last_ready_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(runtime_id, plugin_version_id),
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE,
      FOREIGN KEY(plugin_id) REFERENCES multiremi_agent_plugins(id) ON DELETE CASCADE,
      FOREIGN KEY(plugin_version_id) REFERENCES multiremi_agent_plugin_versions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_plugin_runtime_desired
      ON multiremi_agent_plugin_runtime_states(runtime_id, desired, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_plugin_runtime_plugin
      ON multiremi_agent_plugin_runtime_states(plugin_id, plugin_version_id, desired, status);

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

    -- Model gateway: fleet-wide relay config per workspace × engine (deep-merge fragment + secret token).
    CREATE TABLE IF NOT EXISTS multiremi_relay_config (
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      fragment TEXT NOT NULL DEFAULT '',
      auth_token TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY(workspace_id, engine)
    );

    -- Model gateway: server-side model discovery cache (one JSON snapshot per workspace × engine).
    CREATE TABLE IF NOT EXISTS multiremi_gateway_models (
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
      source_revision INTEGER NOT NULL DEFAULT 0,
      last_success_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, engine)
    );

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
      purpose TEXT NOT NULL DEFAULT 'personal',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_access_tokens_workspace ON multiremi_access_tokens(workspace_id, type);
    CREATE INDEX IF NOT EXISTS idx_multiremi_access_tokens_hash ON multiremi_access_tokens(token_hash);

    CREATE TABLE IF NOT EXISTS multiremi_issue_shares (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      created_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      view_count INTEGER NOT NULL DEFAULT 0,
      last_viewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_shares_issue
      ON multiremi_issue_shares(issue_id, revoked_at, expires_at);

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
      issue_kind TEXT NOT NULL DEFAULT 'execution',
      source_issue_id TEXT,
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

    -- Product-level collaboration sessions. These are intentionally distinct
    -- from ACP/provider session ids stored on tasks and agent lanes.
    CREATE TABLE IF NOT EXISTS multiremi_issue_sessions (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      title TEXT NOT NULL DEFAULT 'Main',
      status TEXT NOT NULL DEFAULT 'active',
      is_default INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_by_type TEXT NOT NULL DEFAULT 'member',
      created_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_sessions_issue
      ON multiremi_issue_sessions(issue_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_sessions_workspace
      ON multiremi_issue_sessions(workspace_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_issue_sessions_default
      ON multiremi_issue_sessions(issue_id) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS multiremi_session_participants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      participant_type TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant',
      status TEXT NOT NULL DEFAULT 'active',
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, participant_type, participant_id),
      FOREIGN KEY(session_id) REFERENCES multiremi_issue_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_session_participants_session
      ON multiremi_session_participants(session_id, status, joined_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_session_participants_actor
      ON multiremi_session_participants(participant_type, participant_id, status);

    -- Canonical append-only source of truth for a product session. Rows are
    -- never edited in place; corrections and summaries are appended events.
    CREATE TABLE IF NOT EXISTS multiremi_session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      author_type TEXT NOT NULL,
      author_id TEXT,
      kind TEXT NOT NULL DEFAULT 'message',
      body TEXT NOT NULL DEFAULT '',
      task_id TEXT,
      source_comment_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(session_id, seq),
      UNIQUE(source_comment_id),
      FOREIGN KEY(session_id) REFERENCES multiremi_issue_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_session_events_session
      ON multiremi_session_events(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_multiremi_session_events_task
      ON multiremi_session_events(task_id, seq);

    -- One provider/ACP lineage per (product session, agent). provider_session_id
    -- and cursor_seq form one atomic cache checkpoint.
    CREATE TABLE IF NOT EXISTS multiremi_session_agent_lanes (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider_session_id TEXT,
      runtime_id TEXT,
      provider TEXT,
      work_dir TEXT,
      cursor_seq INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      last_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, agent_id),
      FOREIGN KEY(session_id) REFERENCES multiremi_issue_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(agent_id) REFERENCES multiremi_agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_session_agent_lanes_runtime
      ON multiremi_session_agent_lanes(runtime_id, status);
    CREATE INDEX IF NOT EXISTS idx_multiremi_session_agent_lanes_agent
      ON multiremi_session_agent_lanes(agent_id, updated_at);

    -- Cross-session output is explicit and immutable. Other sessions see
    -- published results/summaries, not the source session's private event log.
    CREATE TABLE IF NOT EXISTS multiremi_session_results (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      published_by_type TEXT NOT NULL DEFAULT 'agent',
      published_by_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(source_session_id) REFERENCES multiremi_issue_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_session_results_issue
      ON multiremi_session_results(issue_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_session_results_source
      ON multiremi_session_results(source_session_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_session_id TEXT,
      author_type TEXT NOT NULL DEFAULT 'member',
      author_id TEXT,
      task_id TEXT,
      parent_id TEXT,
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'comment',
      resolved_at TEXT,
      resolved_by_type TEXT,
      resolved_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_session_id) REFERENCES multiremi_issue_sessions(id) ON DELETE CASCADE,
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
      status TEXT NOT NULL DEFAULT 'in_progress',
      priority TEXT NOT NULL DEFAULT 'none',
      workspace_id TEXT NOT NULL DEFAULT 'local',
      lead_type TEXT,
      lead_id TEXT,
      default_assignee_type TEXT,
      default_assignee_id TEXT,
      archived_at TEXT,
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

    CREATE TABLE IF NOT EXISTS multiremi_project_docs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      kind TEXT NOT NULL DEFAULT 'wiki',
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      refs TEXT NOT NULL DEFAULT '[]',
      source_task_id TEXT,
      source_issue_id TEXT,
      author_type TEXT,
      author_id TEXT,
      updated_by_type TEXT,
      updated_by_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, slug),
      FOREIGN KEY(project_id) REFERENCES multiremi_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_project_docs_project ON multiremi_project_docs(project_id, kind, pinned, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_project_docs_workspace ON multiremi_project_docs(workspace_id);

    CREATE TABLE IF NOT EXISTS multiremi_project_doc_revisions (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      body TEXT NOT NULL DEFAULT '',
      author_type TEXT,
      author_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(doc_id, version),
      FOREIGN KEY(doc_id) REFERENCES multiremi_project_docs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_project_doc_revisions_doc ON multiremi_project_doc_revisions(doc_id, version);

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
      task_kind TEXT NOT NULL DEFAULT 'direct',
      agent_id TEXT NOT NULL,
      runtime_id TEXT,
      issue_id TEXT,
      issue_session_id TEXT,
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
      assignment_event_id TEXT,
      projection_from_seq INTEGER,
      projection_to_seq INTEGER,
      projection_mode TEXT,
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
      FOREIGN KEY(issue_session_id) REFERENCES multiremi_issue_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY(trigger_comment_id) REFERENCES multiremi_issue_comments(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_status ON multiremi_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_runtime ON multiremi_tasks(runtime_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_issue ON multiremi_tasks(issue_id);
    -- trigger_comment_id index is created after addColumnIfMissing (below); the column is
    -- added by an upgrade migration on pre-existing DBs.
    CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_workspace ON multiremi_tasks(workspace_id);

    -- Normalized execution snapshot rows make exact Plugin readiness usable in
    -- the cross-database task-claim query. 'multiremi_tasks.plugin_snapshot'
    -- remains the canonical wire payload; these rows are its scheduling index.
    CREATE TABLE IF NOT EXISTS multiremi_task_plugin_snapshots (
      task_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      digest TEXT NOT NULL,
      artifact_url TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, binding_id),
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(plugin_id) REFERENCES multiremi_agent_plugins(id) ON DELETE RESTRICT,
      FOREIGN KEY(version_id) REFERENCES multiremi_agent_plugin_versions(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_task_plugin_snapshots_version
      ON multiremi_task_plugin_snapshots(version_id, task_id);

    CREATE TABLE IF NOT EXISTS multiremi_task_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      tool TEXT,
      content TEXT,
      input TEXT,
      output TEXT,
      tool_call_id TEXT,
      status TEXT,
      meta TEXT,
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
    CREATE TABLE IF NOT EXISTS multiremi_issue_workspaces (
      issue_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_key TEXT NOT NULL,
      runtime_id TEXT,
      root_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'preparing',
      repos TEXT NOT NULL DEFAULT '[]',
      last_task_id TEXT,
      cleaned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_workspaces_runtime
      ON multiremi_issue_workspaces(runtime_id, status, updated_at);
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
  addColumnIfMissing(db, "multiremi_agent_plugins", "source_subdir TEXT");
  addColumnIfMissing(
    db,
    "multiremi_agent_plugin_runtime_states",
    "pending_heartbeat_count INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "multiremi_runtimes", "daemon_id TEXT");
  addColumnIfMissing(db, "multiremi_runtimes", "legacy_daemon_id TEXT");
  addColumnIfMissing(db, "multiremi_runtimes", "runtime_mode TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_runtimes", "device_info TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "multiremi_runtimes", "metadata TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "multiremi_runtimes", "owner_id TEXT");
  addColumnIfMissing(db, "multiremi_runtimes", "visibility TEXT NOT NULL DEFAULT 'private'");
  addColumnIfMissing(db, "multiremi_runtimes", "name_customized INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_daemon_lifecycle_locks", "owner_user_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "daemon_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "task_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "agent_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "user_id TEXT NOT NULL DEFAULT 'local'");
  const accessTokenPurposeAdded = addColumnIfMissing(
    db,
    "multiremi_access_tokens",
    "purpose TEXT NOT NULL DEFAULT 'personal'",
  );
  if (accessTokenPurposeAdded) {
    db.run("UPDATE multiremi_access_tokens SET purpose = 'daemon' WHERE type = 'daemon'");
    db.run("UPDATE multiremi_access_tokens SET purpose = 'task' WHERE type = 'task'");
    db.run("UPDATE multiremi_access_tokens SET purpose = 'session' WHERE type = 'pat' AND name LIKE 'Login for %'");
    db.run(
      "UPDATE multiremi_access_tokens SET purpose = 'cli' WHERE type = 'pat' AND (name = 'CLI token' OR name = 'Multiremi daemon' OR name LIKE 'Remi daemon %')",
    );
  }
  backfillDaemonIdentityOwners(db);
  addColumnIfMissing(db, "multiremi_issues", "assignee_type TEXT");
  addColumnIfMissing(db, "multiremi_issues", "assignee_id TEXT");
  addColumnIfMissing(db, "multiremi_issues", "metadata TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "multiremi_issues", "issue_number INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_issues", "issue_key TEXT");
  addColumnIfMissing(db, "multiremi_issues", "priority TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(db, "multiremi_issues", "parent_issue_id TEXT");
  addColumnIfMissing(db, "multiremi_issues", "issue_kind TEXT NOT NULL DEFAULT 'execution'");
  addColumnIfMissing(db, "multiremi_issues", "source_issue_id TEXT");
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
  addColumnIfMissing(db, "multiremi_issue_comments", "issue_session_id TEXT");
  // Agent auto-reply comments point back at the run that produced them, so the
  // chat stream can open that task's transcript. Forward-only: no backfill.
  addColumnIfMissing(db, "multiremi_issue_comments", "task_id TEXT");
  addColumnIfMissing(db, "multiremi_attachments", "chat_session_id TEXT");
  addColumnIfMissing(db, "multiremi_attachments", "chat_message_id TEXT");
  ensureIssueSubscriberTypedSchema(db);
  addColumnIfMissing(db, "multiremi_chat_sessions", "creator_id TEXT");
  addColumnIfMissing(db, "multiremi_chat_sessions", "unread_since TEXT");
  // Pool scheduling records the machine + engine that produced the promoted
  // provider session as atomic metadata on the session itself, so follow-ups
  // don't have to (mis)infer them from "the latest task with a runtime_id".
  addColumnIfMissing(db, "multiremi_chat_sessions", "session_runtime_id TEXT");
  addColumnIfMissing(db, "multiremi_chat_sessions", "session_provider TEXT");
  addColumnIfMissing(db, "multiremi_chat_sessions", "session_execution_fingerprint TEXT");
  addColumnIfMissing(db, "multiremi_chat_messages", "failure_reason TEXT");
  addColumnIfMissing(db, "multiremi_chat_messages", "elapsed_ms INTEGER");
  addColumnIfMissing(db, "multiremi_tasks", "chat_session_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "task_kind TEXT NOT NULL DEFAULT 'direct'");
  addColumnIfMissing(db, "multiremi_tasks", "wait_reason TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "failure_reason TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "attempt INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "multiremi_tasks", "max_attempts INTEGER NOT NULL DEFAULT 3");
  addColumnIfMissing(db, "multiremi_tasks", "parent_task_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "trigger_comment_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "trigger_summary TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "issue_session_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "assignment_event_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "projection_from_seq INTEGER");
  addColumnIfMissing(db, "multiremi_tasks", "projection_to_seq INTEGER");
  addColumnIfMissing(db, "multiremi_tasks", "projection_mode TEXT");
  addColumnIfMissing(db, "multiremi_task_messages", "tool_call_id TEXT");
  addColumnIfMissing(db, "multiremi_task_messages", "status TEXT");
  addColumnIfMissing(db, "multiremi_task_messages", "meta TEXT");
  // Engine the task actually EXECUTED under, snapshotted at claim time. The
  // agent's provider can change mid-run, so the promoted session's engine must
  // come from this snapshot, not the agent's current provider.
  addColumnIfMissing(db, "multiremi_tasks", "provider TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "plugin_snapshot TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "multiremi_tasks", "execution_fingerprint TEXT");
  addColumnIfMissing(db, "multiremi_session_agent_lanes", "execution_fingerprint TEXT");
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
  // Source references on wiki/memory docs. The table itself is new enough that
  // only dev databases predate the column, but CREATE TABLE IF NOT EXISTS never
  // revisits an existing table — so it gets patched in like every other column.
  addColumnIfMissing(db, "multiremi_project_docs", "refs TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "multiremi_projects", "archived_at TEXT");
  // Per-project default assignee: prefills the group/agent/member on new issues
  // created under the project so users stop re-picking the same squad each time.
  addColumnIfMissing(db, "multiremi_projects", "default_assignee_type TEXT");
  addColumnIfMissing(db, "multiremi_projects", "default_assignee_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issues_source ON multiremi_issues(source_issue_id, created_at)");
  db.run(
    "UPDATE multiremi_projects SET archived_at = updated_at WHERE archived_at IS NULL AND status IN ('completed', 'cancelled')",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_projects_archive ON multiremi_projects(workspace_id, archived_at, updated_at)");
  // Multi-user auth: stable external identity (Feishu open_id) on users, and an
  // explicit user↔member link so membership no longer relies solely on the
  // legacy `mem_<ws>_<userId>` id convention.
  addColumnIfMissing(db, "multiremi_users", "external_id TEXT");
  addColumnIfMissing(db, "multiremi_workspace_members", "user_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_users_external_id ON multiremi_users(external_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_members_user ON multiremi_workspace_members(user_id, workspace_id)");
  backfillMemberUserIds(db);
  backfillOwnerExternalId(db);
  normalizeSquadLeaderRoles(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_trigger_comment ON multiremi_tasks(trigger_comment_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_issue_session ON multiremi_tasks(issue_session_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issue_comments_session ON multiremi_issue_comments(issue_session_id, created_at)");
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
  // NOTE: we deliberately do NOT unpin existing queued TASKS here. This
  // migration runs on every startup, and a task's runtime_id can legitimately
  // be an explicit pin, a resume-safe retry pin, or a session/local_directory
  // affinity — none distinguishable from a pre-pool agent-inherited pin at the
  // SQL level, so a blanket unpin would keep clobbering valid pins on every
  // boot. Pre-pool tasks keep their pin (claimable by their original machine);
  // new tasks are already unbound by createTask. Only the agent binding above
  // is cleared, which is the invariant the pool model needs.
  backfillDefaultIssueSessions(db);
  backfillIssueKeys(db);
}

function normalizeSquadLeaderRoles(db: SqlDatabase): void {
  // `leader_id` is the squad's source of truth. Older leader changes updated
  // that column but left the previous membership row as `leader`, so repair
  // those rows before enforcing one leader role per squad.
  db.run(
    `UPDATE multiremi_squad_members
     SET role = 'member'
     WHERE role = 'leader'
       AND NOT EXISTS (
         SELECT 1 FROM multiremi_squads s
         WHERE s.id = multiremi_squad_members.squad_id
           AND multiremi_squad_members.member_type = 'agent'
           AND s.leader_id = multiremi_squad_members.member_id
       )`,
  );
  db.run(
    `UPDATE multiremi_squad_members
     SET role = 'leader'
     WHERE member_type = 'agent'
       AND EXISTS (
         SELECT 1 FROM multiremi_squads s
         WHERE s.id = multiremi_squad_members.squad_id
           AND s.leader_id = multiremi_squad_members.member_id
       )`,
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_squad_members_one_leader ON multiremi_squad_members(squad_id) WHERE role = 'leader'",
  );
}

function backfillDefaultIssueSessions(db: SqlDatabase): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO multiremi_issue_sessions (
       id, issue_id, workspace_id, title, status, is_default,
       created_by_type, created_by_id, created_at, updated_at
     )
     SELECT 'ises_' || i.id, i.id, i.workspace_id, 'Main', 'active', 1,
            'system', NULL, i.created_at, i.updated_at
     FROM multiremi_issues i
     WHERE NOT EXISTS (
       SELECT 1 FROM multiremi_issue_sessions s
       WHERE s.issue_id = i.id AND s.is_default = 1
     )
     ON CONFLICT DO NOTHING`,
  );
  db.run(
    `UPDATE multiremi_issue_comments
     SET issue_session_id = (
       SELECT s.id FROM multiremi_issue_sessions s
       WHERE s.issue_id = multiremi_issue_comments.issue_id AND s.is_default = 1
       LIMIT 1
     )
     WHERE issue_session_id IS NULL`,
  );
  db.run(
    `UPDATE multiremi_tasks
     SET issue_session_id = (
       SELECT s.id FROM multiremi_issue_sessions s
       WHERE s.issue_id = multiremi_tasks.issue_id AND s.is_default = 1
       LIMIT 1
     )
     WHERE issue_id IS NOT NULL AND issue_session_id IS NULL`,
  );
  db.run(
    `INSERT INTO multiremi_session_events (
       id, session_id, seq, author_type, author_id, kind, body,
       source_comment_id, metadata, created_at
     )
     SELECT
       'sevt_' || c.id,
       c.issue_session_id,
       COALESCE((
         SELECT MAX(existing.seq)
         FROM multiremi_session_events existing
         WHERE existing.session_id = c.issue_session_id
       ), 0) + (
         SELECT COUNT(*)
         FROM multiremi_issue_comments prior
         WHERE prior.issue_session_id = c.issue_session_id
           AND (prior.created_at < c.created_at OR (prior.created_at = c.created_at AND prior.id <= c.id))
       ),
       c.author_type,
       c.author_id,
       CASE WHEN c.type = 'system' THEN 'system' ELSE 'message' END,
       c.body,
       c.id,
       '{}',
       c.created_at
     FROM multiremi_issue_comments c
     WHERE c.issue_session_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM multiremi_session_events e WHERE e.source_comment_id = c.id
       )
     ON CONFLICT DO NOTHING`,
  );
  db.run(
    `INSERT INTO multiremi_session_participants (
       id, session_id, participant_type, participant_id, role, status, joined_at, updated_at
     )
     SELECT
       'spart_' || e.session_id || '_' || e.author_type || '_' || e.author_id,
       e.session_id,
       e.author_type,
       e.author_id,
       'participant',
       'active',
       MIN(e.created_at),
       ?
     FROM multiremi_session_events e
     WHERE e.author_id IS NOT NULL AND e.author_type IN ('agent', 'member')
     GROUP BY e.session_id, e.author_type, e.author_id
     ON CONFLICT DO NOTHING`,
    [now],
  );
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

function addColumnIfMissing(db: SqlDatabase, table: string, definition: string): boolean {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    return true;
  } catch (err) {
    const message = String((err as Error).message ?? err).toLowerCase();
    // Idempotency: the column already exists. SQLite says "duplicate column name",
    // Postgres says "column ... already exists". Any other ALTER failure is real.
    const alreadyExists = message.includes("duplicate column") || message.includes("already exists");
    if (!alreadyExists) {
      log.error(`addColumnIfMissing failed for ${table}.${definition}`, err);
      throw err;
    }
    return false;
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

// Older databases stored the machine owner independently on Runtime and daemon-token
// rows. Persist the claim on the lifecycle row when every active identity agrees.
// Conflicting legacy data is deliberately left unclaimed: the runtime claim guard
// will reject every future mutation until an administrator resolves the bad rows.
function backfillDaemonIdentityOwners(db: SqlDatabase): void {
  const now = new Date().toISOString();
  const rows = db.query(
    `SELECT workspace_id, daemon_id, owner_user_id
     FROM (
       SELECT COALESCE(workspace_id, 'local') AS workspace_id,
              daemon_id,
              owner_id AS owner_user_id
       FROM multiremi_runtimes
       WHERE daemon_id IS NOT NULL AND daemon_id != ''
         AND owner_id IS NOT NULL AND owner_id != ''
       UNION ALL
       SELECT workspace_id,
              daemon_id,
              user_id AS owner_user_id
       FROM multiremi_access_tokens
       WHERE type = 'daemon'
         AND daemon_id IS NOT NULL AND daemon_id != ''
         AND user_id IS NOT NULL AND user_id != ''
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
     ) daemon_identities
     ORDER BY workspace_id, daemon_id, owner_user_id`,
  ).all(now) as Array<{ workspace_id: string; daemon_id: string; owner_user_id: string }>;

  const ownersByDaemon = new Map<string, {
    workspaceId: string;
    daemonId: string;
    owners: Set<string>;
  }>();
  for (const row of rows) {
    const workspaceId = String(row.workspace_id ?? "local").trim() || "local";
    const daemonId = String(row.daemon_id ?? "").trim();
    const ownerUserId = String(row.owner_user_id ?? "").trim();
    if (!daemonId || !ownerUserId) continue;
    const key = `${workspaceId}\u0000${daemonId}`;
    const entry = ownersByDaemon.get(key) ?? { workspaceId, daemonId, owners: new Set<string>() };
    entry.owners.add(ownerUserId);
    ownersByDaemon.set(key, entry);
  }

  for (const { workspaceId, daemonId, owners } of ownersByDaemon.values()) {
    if (owners.size !== 1) continue;
    const ownerUserId = [...owners][0]!;
    db.run(
      `INSERT INTO multiremi_daemon_lifecycle_locks (workspace_id, daemon_id, owner_user_id, updated_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, daemon_id) DO NOTHING`,
      [workspaceId, daemonId, ownerUserId, now],
    );
    db.run(
      `UPDATE multiremi_daemon_lifecycle_locks
       SET owner_user_id = ?, updated_at = ?
       WHERE workspace_id = ? AND daemon_id = ?
         AND (owner_user_id IS NULL OR owner_user_id = '')`,
      [ownerUserId, now, workspaceId, daemonId],
    );
  }
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
