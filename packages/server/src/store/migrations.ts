import { createHash } from "node:crypto";
import { attachmentIdsFromText } from "@multiremi/contracts/attachments.js";
import { type SqlDatabase } from "@multiremi/store/db/postgres.js";
import {
  isSessionArchiveRetryExhausted,
  nextSessionArchiveRetryAt,
  resolveSessionArchiveRetryPolicy,
  resolveSessionArchiveUploadStallMs,
} from "@multiremi/session-archive/retry-policy.js";
import { createLogger } from "@shared/logger.js";
import { canonicalizeDaemonRoutingWithinTransaction } from "@multiremi/store/daemon-routing.js";
import { isPostgresConfigured } from "@multiremi/store/db/postgres.js";

const log = createLogger("multiremi-store");
const SCM_CONNECTION_ORIGIN_MIGRATION = "20260822_scm_connection_origins";
const SCM_DEFAULT_SCOPE_MIGRATION = "20260822_scm_default_repository_scope";
const FEISHU_INGEST_V2_MIGRATION = "20260825_feishu_ingest_v2";
const FEISHU_INGEST_ALERT_DELIVERY_V3_MIGRATION = "20260825_feishu_ingest_alert_delivery_v3";
const CODEBASE_CHANGE_REQUEST_CURSOR_RESET_MIGRATION = "20260825_codebase_change_request_cursor_reset";
const SESSION_ARCHIVE_RETRY_BUDGET_MIGRATION = "20260826_session_archive_retry_budget";
const FEISHU_ISSUE_PROPOSALS_V4_MIGRATION = "20260826_feishu_issue_proposals_v4";
const MESSAGING_CORE_V1_MIGRATION = "20260831_messaging_core_v1";
const MESSAGING_MIGRATION_BATCH_SIZE = 500;
const AGENT_ISSUE_PROPOSAL_POLICY_MIGRATION = "20260826_agent_issue_proposal_policy";
const TASK_ISSUE_PROPOSAL_POLICY_MIGRATION = "20260826_task_issue_proposal_policy";
const AUTOPILOT_ISSUE_PROPOSAL_POLICY_MIGRATION = "20260826_autopilot_issue_proposal_policy";
const DAEMON_PROFILES_MIGRATION = "20260827_daemon_profiles";
const MARKDOWN_ATTACHMENT_OWNERSHIP_MIGRATION = "20260827_markdown_attachment_ownership";
const AGENT_ROLE_MIGRATION = "20260827_agent_roles";
const PROJECT_DEVICE_DAEMON_CANONICALIZATION_MIGRATION = "20260831_project_device_daemon_canonicalization";
const FEISHU_ISSUE_TOPIC_OUTBOUND_MIGRATION = "20260904_feishu_issue_topic_outbound_nullable";

// Stable Feishu open_id of the deployment owner (hehuajie / 贺华杰). The seed
// `local` user is tagged with this on migration so SSO login re-binds to it
// instead of creating a duplicate. Overridable via MULTIREMI_OWNER_OPEN_ID.
const DEFAULT_OWNER_OPEN_ID = "ou_e6b7ffc662b392317275b817295c0b44";

export function runMigrations(db: SqlDatabase): void {
  renameLegacyMulticaObjects(db);
  const legacyGithubTables = existingTableNames(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

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
      executable TEXT,
      model TEXT,
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      custom_env TEXT NOT NULL DEFAULT '{}',
      custom_args TEXT NOT NULL DEFAULT '[]',
      mcp_config TEXT,
      thinking_level TEXT,
      issue_creation_requires_proposal INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'normal',
      supervisor INTEGER NOT NULL DEFAULT 0,
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
      ssh_mesh_rekey_status TEXT NOT NULL DEFAULT 'not_required',
      ssh_mesh_compromised_key_version INTEGER,
      ssh_mesh_replacement_key_version INTEGER,
      ssh_mesh_rekey_operation_id TEXT,
      ssh_mesh_rekey_updated_at TEXT,
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

    CREATE TABLE IF NOT EXISTS multiremi_workspace_ssh_mesh (
      workspace_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      active_key_version INTEGER NOT NULL DEFAULT 0,
      active_private_key_encrypted TEXT,
      active_public_key TEXT,
      active_fingerprint TEXT,
      active_operation_id TEXT,
      previous_key_version INTEGER,
      previous_private_key_encrypted TEXT,
      previous_public_key TEXT,
      previous_fingerprint TEXT,
      rotation_state TEXT NOT NULL DEFAULT 'stable',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_daemon_ssh_mesh_states (
      workspace_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      node_kind TEXT NOT NULL DEFAULT 'runtime',
      name TEXT,
      runtime_id TEXT,
      protocol_version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'setup_required',
      key_version INTEGER,
      config_revision TEXT,
      ssh_user TEXT,
      hostname TEXT,
      ssh_port INTEGER NOT NULL DEFAULT 22,
      addresses TEXT NOT NULL DEFAULT '[]',
      host_keys TEXT NOT NULL DEFAULT '[]',
      public_key_installed INTEGER NOT NULL DEFAULT 0,
      config_installed INTEGER NOT NULL DEFAULT 0,
      peer_tests TEXT NOT NULL DEFAULT '[]',
      probe_revision INTEGER NOT NULL DEFAULT 0,
      desired_probe_revision INTEGER NOT NULL DEFAULT 0,
      probe_target_daemon_ids TEXT NOT NULL DEFAULT '[]',
      last_error_code TEXT,
      last_error TEXT,
      last_reported_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, daemon_id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_daemon_ssh_mesh_status
      ON multiremi_daemon_ssh_mesh_states(workspace_id, status, updated_at);

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

    CREATE TABLE IF NOT EXISTS multiremi_runtime_command_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      redacted_command TEXT NOT NULL,
      redacted_args TEXT NOT NULL DEFAULT '[]',
      provision_id TEXT,
      timeout_ms INTEGER NOT NULL,
      created_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      duration_ms INTEGER,
      error TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_command_runtime ON multiremi_runtime_command_requests(runtime_id, status, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_bot_menu_publish_requests (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      dry_run INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      created_by TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_bot_menu_publish_runtime
      ON multiremi_bot_menu_publish_requests(runtime_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_bot_menu_publish_workspace
      ON multiremi_bot_menu_publish_requests(workspace_id, created_at);

    -- MUL-206: one Feishu concierge bot per workspace. workspace_id is the
    -- primary key rather than a UNIQUE index so a second config physically
    -- cannot exist. Secrets are stored only in the *_encrypted columns; the
    -- *_hint columns hold a non-reversible display prefix.
    CREATE TABLE IF NOT EXISTS multiremi_feishu_bot_configs (
      workspace_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      app_secret_encrypted TEXT NOT NULL,
      app_secret_hint TEXT,
      domain TEXT NOT NULL DEFAULT 'feishu',
      enabled INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      bot_name TEXT,
      bot_open_id TEXT,
      last_tested_at TEXT,
      last_test_error TEXT,
      last_test_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      FOREIGN KEY(workspace_id) REFERENCES multiremi_workspaces(id) ON DELETE CASCADE
    );

    -- Reported state per Runtime, not per workspace: keeping a row for a
    -- Runtime that is no longer selected is what lets the control plane see a
    -- stale connector and refuse to hand over until it confirms it stopped.
    CREATE TABLE IF NOT EXISTS multiremi_feishu_bot_runtime_states (
      workspace_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      applied_revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'stopped',
      bot_name TEXT,
      bot_open_id TEXT,
      error_code TEXT,
      error_message TEXT,
      reported_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, runtime_id),
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_bot_runtime_states_workspace
      ON multiremi_feishu_bot_runtime_states(workspace_id, state);

    -- Who changed the concierge, when, and what changed. The details column
    -- records which fields moved and whether a secret was replaced, never a value.
    CREATE TABLE IF NOT EXISTS multiremi_feishu_bot_audit (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      -- Per-workspace insertion order. created_at is millisecond-resolution
      -- and the id is random, so two entries written in the same millisecond
      -- (a stop immediately followed by a deploy) would otherwise come back in
      -- an arbitrary order — and the order is the whole point of an audit list.
      seq INTEGER NOT NULL DEFAULT 0,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'member',
      actor_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_bot_audit_workspace
      ON multiremi_feishu_bot_audit(workspace_id, seq);

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
      env TEXT NOT NULL DEFAULT '{}',
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

    CREATE TABLE IF NOT EXISTS multiremi_workspace_runtime_provisions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      package TEXT,
      version TEXT,
      version_check INTEGER NOT NULL DEFAULT 1,
      bin TEXT,
      registry TEXT,
      command TEXT,
      args TEXT NOT NULL DEFAULT '[]',
      redacted_command TEXT,
      redacted_args TEXT NOT NULL DEFAULT '[]',
      trigger_kinds TEXT NOT NULL DEFAULT '[]',
      cron_expression TEXT,
      timezone TEXT,
      next_run_at TEXT,
      last_fired_at TEXT,
      timeout_ms INTEGER NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES multiremi_workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_runtime_provisions_due
      ON multiremi_workspace_runtime_provisions(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_runtime_provisions_workspace
      ON multiremi_workspace_runtime_provisions(workspace_id, enabled, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_provision_audit (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      provision_id TEXT NOT NULL,
      action TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      actor_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_provision_audit_provision
      ON multiremi_runtime_provision_audit(provision_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_runtime_provision_states (
      provision_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      observed_version TEXT,
      last_command_request_id TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(provision_id, runtime_id),
      FOREIGN KEY(provision_id) REFERENCES multiremi_workspace_runtime_provisions(id) ON DELETE CASCADE,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_runtime_provision_states_runtime
      ON multiremi_runtime_provision_states(runtime_id, status);

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
      scopes TEXT NOT NULL DEFAULT '[]',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_access_tokens_workspace ON multiremi_access_tokens(workspace_id, type);
    CREATE INDEX IF NOT EXISTS idx_multiremi_access_tokens_hash ON multiremi_access_tokens(token_hash);

    CREATE TABLE IF NOT EXISTS multiremi_organizer_actions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      supervisor_task_id TEXT NOT NULL,
      supervisor_agent_id TEXT NOT NULL,
      target_task_id TEXT NOT NULL,
      target_issue_id TEXT,
      replacement_task_id TEXT,
      report_issue_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_organizer_actions_target
      ON multiremi_organizer_actions(target_task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_organizer_actions_supervisor
      ON multiremi_organizer_actions(supervisor_task_id, created_at);

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
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      created_by TEXT,
      completed_at TEXT,
      archived_at TEXT,
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
      holds_workspace INTEGER NOT NULL DEFAULT 1,
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
    CREATE INDEX IF NOT EXISTS idx_multiremi_inbox_page ON multiremi_inbox_items(member_id, archived, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS multiremi_notification_channels (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      member_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      target TEXT NOT NULL,
      event_types TEXT NOT NULL,
      min_severity TEXT NOT NULL DEFAULT 'info',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_notification_channels_workspace
      ON multiremi_notification_channels(workspace_id, enabled, updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_notification_deliveries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      inbox_item_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_kind TEXT NOT NULL,
      target_label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_seq INTEGER NOT NULL DEFAULT 0,
      leased_until TEXT,
      last_error TEXT,
      last_attempt_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(inbox_item_id) REFERENCES multiremi_inbox_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_notification_deliveries_workspace_status
      ON multiremi_notification_deliveries(workspace_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_notification_deliveries_inbox
      ON multiremi_notification_deliveries(inbox_item_id);

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
      instructions TEXT NOT NULL DEFAULT '',
      instructions_revision INTEGER NOT NULL DEFAULT 0,
      instructions_updated_at TEXT,
      instructions_updated_by TEXT,
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

    CREATE TABLE IF NOT EXISTS multiremi_project_devices (
      project_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY(project_id, daemon_id),
      FOREIGN KEY(project_id) REFERENCES multiremi_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_project_devices_daemon
      ON multiremi_project_devices(workspace_id, daemon_id);

    CREATE TABLE IF NOT EXISTS multiremi_project_docs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      kind TEXT NOT NULL DEFAULT 'wiki',
      slug TEXT NOT NULL,
      path TEXT NOT NULL,
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
      storage_backend TEXT NOT NULL DEFAULT 'sql',
      content_uri TEXT,
      content_sha256 TEXT,
      sync_status TEXT NOT NULL DEFAULT 'sql',
      sync_error TEXT,
      snapshot_oid TEXT,
      compilation_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, slug),
      UNIQUE(project_id, path),
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
      content_uri TEXT,
      content_sha256 TEXT,
      snapshot_oid TEXT,
      compilation_run_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(doc_id, version),
      FOREIGN KEY(doc_id) REFERENCES multiremi_project_docs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_project_doc_revisions_doc ON multiremi_project_doc_revisions(doc_id, version);

    CREATE TABLE IF NOT EXISTS multiremi_repository_wiki_docs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      refs TEXT NOT NULL DEFAULT '[]',
      source_task_id TEXT,
      source_issue_id TEXT,
      author_type TEXT,
      author_id TEXT,
      updated_by_type TEXT,
      updated_by_id TEXT,
      source_revision TEXT,
      status TEXT NOT NULL DEFAULT 'healthy',
      status_message TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      storage_backend TEXT NOT NULL DEFAULT 'sql',
      content_uri TEXT,
      content_sha256 TEXT,
      sync_status TEXT NOT NULL DEFAULT 'sql',
      sync_error TEXT,
      snapshot_oid TEXT,
      compilation_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, repository_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_repository_wiki_scope
      ON multiremi_repository_wiki_docs(workspace_id, repository_id, updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_repository_wiki_doc_revisions (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      body TEXT NOT NULL DEFAULT '',
      source_revision TEXT,
      author_type TEXT,
      author_id TEXT,
      content_uri TEXT,
      content_sha256 TEXT,
      snapshot_oid TEXT,
      compilation_run_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(doc_id, version),
      FOREIGN KEY(doc_id) REFERENCES multiremi_repository_wiki_docs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_repository_wiki_revisions_doc
      ON multiremi_repository_wiki_doc_revisions(doc_id, version);

    CREATE TABLE IF NOT EXISTS multiremi_repository_wiki_storage_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      manifest TEXT NOT NULL DEFAULT '{}',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, repository_id, batch_id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_repository_wiki_storage_jobs_scope
      ON multiremi_repository_wiki_storage_jobs(workspace_id, repository_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_repository_wiki_storage_jobs_active
      ON multiremi_repository_wiki_storage_jobs(workspace_id, repository_id);

    CREATE TABLE IF NOT EXISTS multiremi_knowledge_submissions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      repository_id TEXT,
      scope TEXT NOT NULL,
      source_type TEXT NOT NULL,
      proposed_path TEXT,
      proposed_slug TEXT,
      body TEXT NOT NULL DEFAULT '',
      patch TEXT,
      base_revision TEXT,
      source_task_id TEXT,
      source_issue_id TEXT,
      source_revision TEXT,
      author_agent_id TEXT,
      content_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_knowledge_submissions_scope
      ON multiremi_knowledge_submissions(workspace_id, scope, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_knowledge_submissions_target_hash
      ON multiremi_knowledge_submissions(workspace_id, scope, project_id, repository_id, content_sha256, status);
    CREATE INDEX IF NOT EXISTS idx_multiremi_knowledge_submissions_issue
      ON multiremi_knowledge_submissions(source_issue_id, source_type);

    CREATE TABLE IF NOT EXISTS multiremi_knowledge_compilation_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      repository_id TEXT,
      task_id TEXT,
      agent_id TEXT,
      autopilot_run_id TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'preparing',
      result_summary TEXT,
      dedupe_key TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_knowledge_runs_scope
      ON multiremi_knowledge_compilation_runs(workspace_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_knowledge_runs_dedupe
      ON multiremi_knowledge_compilation_runs(workspace_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS multiremi_knowledge_compilation_run_sources (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      submission_id TEXT,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES multiremi_knowledge_compilation_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(submission_id) REFERENCES multiremi_knowledge_submissions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_knowledge_run_sources_run
      ON multiremi_knowledge_compilation_run_sources(run_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_knowledge_run_sources_submission
      ON multiremi_knowledge_compilation_run_sources(run_id, submission_id)
      WHERE submission_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS multiremi_knowledge_compilation_outputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      artifact_scope TEXT NOT NULL,
      doc_id TEXT,
      revision_id TEXT,
      version INTEGER,
      action TEXT NOT NULL,
      content_sha256 TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES multiremi_knowledge_compilation_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_knowledge_outputs_run
      ON multiremi_knowledge_compilation_outputs(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_knowledge_outputs_doc
      ON multiremi_knowledge_compilation_outputs(artifact_scope, doc_id, version);

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
      managed_kind TEXT,
      description TEXT,
      project_id TEXT,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      assignee_type TEXT NOT NULL DEFAULT 'agent',
      assignee_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      execution_mode TEXT NOT NULL DEFAULT 'create_issue',
      session_policy TEXT NOT NULL DEFAULT 'new',
      workspace_policy TEXT NOT NULL DEFAULT 'reuse_issue',
      issue_title_template TEXT,
      trigger_kind TEXT NOT NULL DEFAULT 'manual',
      trigger_label TEXT,
      cron_expression TEXT,
      issue_creation_restricted INTEGER NOT NULL DEFAULT 0,
      issue_creation_restriction_reason TEXT,
      issue_creation_restricted_by_task_id TEXT,
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
      event_config TEXT,
      issue_creation_restricted INTEGER NOT NULL DEFAULT 0,
      issue_creation_restriction_reason TEXT,
      issue_creation_restricted_by_task_id TEXT,
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
      source_task_id TEXT,
      trigger_id TEXT,
      event_id TEXT,
      issue_session_id TEXT,
      repository_id TEXT,
      dedupe_key TEXT,
      triggered_at TEXT NOT NULL,
      completed_at TEXT,
      failure_reason TEXT,
      payload TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(autopilot_id) REFERENCES multiremi_autopilots(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id),
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id),
      FOREIGN KEY(source_task_id) REFERENCES multiremi_tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_autopilot_runs_autopilot ON multiremi_autopilot_runs(autopilot_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_system_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      resource TEXT NOT NULL,
      event TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      project_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_system_events_pending
      ON multiremi_system_events(status, available_at, lease_until, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_system_events_resource
      ON multiremi_system_events(workspace_id, resource, event, resource_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_feishu_sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'personal_automation',
      endpoint_name TEXT NOT NULL,
      allowlist TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 90,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 15,
      unprocessed_retry_seconds INTEGER NOT NULL DEFAULT 900,
      unprocessed_retry_limit INTEGER NOT NULL DEFAULT 3,
      last_successful_ingest_at TEXT,
      last_error_code TEXT,
      last_error_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      connection_alerted_at TEXT,
      connection_alert_delivery_failure_count INTEGER NOT NULL DEFAULT 0,
      connection_alert_delivery_error_code TEXT,
      connection_alert_delivery_failed_at TEXT,
      access_token_encrypted TEXT,
      access_token_hint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, endpoint_name)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_sources_poll
      ON multiremi_feishu_sources(enabled, workspace_id, updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_feishu_sync_cursors (
      source_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      cursor TEXT,
      watermark TEXT,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_error TEXT,
      lease_owner TEXT,
      lease_until TEXT,
      lease_token TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(source_id, stream),
      FOREIGN KEY(source_id) REFERENCES multiremi_feishu_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_sync_cursors_lease
      ON multiremi_feishu_sync_cursors(lease_until, source_id, stream);

    CREATE TABLE IF NOT EXISTS multiremi_feishu_messages (
      message_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      source_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_type TEXT,
      chat_name TEXT,
      thread_id TEXT,
      root_id TEXT,
      parent_id TEXT,
      sender TEXT NOT NULL DEFAULT '{}',
      content TEXT NOT NULL DEFAULT '{}',
      searchable_text TEXT NOT NULL DEFAULT '',
      content_fingerprint TEXT NOT NULL,
      message_app_link TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      recalled INTEGER NOT NULL DEFAULT 0,
      edited INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL,
      processed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_at TEXT,
      FOREIGN KEY(source_id) REFERENCES multiremi_feishu_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_messages_unprocessed
      ON multiremi_feishu_messages(workspace_id, processed_at, created_at, message_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_messages_chat
      ON multiremi_feishu_messages(workspace_id, chat_id, created_at, message_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_messages_source
      ON multiremi_feishu_messages(source_id, ingested_at, message_id);
    CREATE TABLE IF NOT EXISTS multiremi_feishu_message_outcomes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      message_id TEXT NOT NULL,
      outcome_kind TEXT NOT NULL,
      ref TEXT,
      reason TEXT,
      task_id TEXT,
      proposal_payload TEXT NOT NULL DEFAULT '{}',
      proposal_status TEXT NOT NULL DEFAULT 'not_applicable',
      proposal_resolved_at TEXT,
      proposal_resolved_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(message_id) REFERENCES multiremi_feishu_messages(message_id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_message_outcomes_message
      ON multiremi_feishu_message_outcomes(message_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_message_outcomes_task
      ON multiremi_feishu_message_outcomes(task_id, created_at)
      WHERE task_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS multiremi_message_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      provider TEXT NOT NULL,
      channel TEXT NOT NULL,
      name TEXT NOT NULL,
      external_account_id TEXT,
      external_account_name TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      config TEXT NOT NULL DEFAULT '{}',
      last_checked_at TEXT,
      last_error_code TEXT,
      last_error_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_message_connections_workspace
      ON multiremi_message_connections(workspace_id, provider, channel, updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_message_sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      connection_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      allowlist TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 90,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 15,
      unprocessed_retry_seconds INTEGER NOT NULL DEFAULT 900,
      unprocessed_retry_limit INTEGER NOT NULL DEFAULT 3,
      last_successful_ingest_at TEXT,
      last_error_code TEXT,
      last_error_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      connection_alerted_at TEXT,
      connection_alert_delivery_failure_count INTEGER NOT NULL DEFAULT 0,
      connection_alert_delivery_error_code TEXT,
      connection_alert_delivery_failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(connection_id) REFERENCES multiremi_message_connections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_message_sources_poll
      ON multiremi_message_sources(enabled, workspace_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_message_sources_connection
      ON multiremi_message_sources(connection_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_message_sync_cursors (
      source_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      cursor TEXT,
      watermark TEXT,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_error TEXT,
      lease_owner TEXT,
      lease_until TEXT,
      lease_token TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(source_id, stream),
      FOREIGN KEY(source_id) REFERENCES multiremi_message_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_message_sync_cursors_lease
      ON multiremi_message_sync_cursors(lease_until, source_id, stream);

    CREATE TABLE IF NOT EXISTS multiremi_message_messages (
      connection_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      source_id TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      conversation_kind TEXT NOT NULL DEFAULT 'unknown',
      conversation_name TEXT,
      external_thread_id TEXT,
      external_root_id TEXT,
      external_parent_id TEXT,
      sender TEXT NOT NULL DEFAULT '{}',
      searchable_text TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      mentions TEXT NOT NULL DEFAULT '[]',
      reactions TEXT NOT NULL DEFAULT '[]',
      raw TEXT NOT NULL DEFAULT '{}',
      content_fingerprint TEXT NOT NULL,
      message_url TEXT,
      sent_at TEXT NOT NULL,
      edited_at TEXT,
      recalled INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL,
      processed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_at TEXT,
      PRIMARY KEY(connection_id, external_message_id),
      FOREIGN KEY(connection_id) REFERENCES multiremi_message_connections(id) ON DELETE CASCADE,
      FOREIGN KEY(source_id) REFERENCES multiremi_message_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_message_messages_unprocessed
      ON multiremi_message_messages(workspace_id, processed_at, sent_at, connection_id, external_message_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_message_messages_conversation
      ON multiremi_message_messages(connection_id, external_conversation_id, sent_at, external_message_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_message_messages_source
      ON multiremi_message_messages(source_id, ingested_at, external_message_id);

    CREATE TABLE IF NOT EXISTS multiremi_message_outcomes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      connection_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      outcome_kind TEXT NOT NULL,
      ref TEXT,
      reason TEXT,
      task_id TEXT,
      proposal_payload TEXT NOT NULL DEFAULT '{}',
      proposal_status TEXT NOT NULL DEFAULT 'not_applicable',
      proposal_resolved_at TEXT,
      proposal_resolved_by TEXT,
      -- Per-message ordinal. created_at alone is not a stable sort: two outcomes
      -- recorded in the same millisecond would otherwise fall back to a random id.
      sequence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(connection_id, external_message_id)
        REFERENCES multiremi_message_messages(connection_id, external_message_id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_message_outcomes_message
      ON multiremi_message_outcomes(connection_id, external_message_id, sequence, id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_message_outcomes_task
      ON multiremi_message_outcomes(task_id, created_at)
      WHERE task_id IS NOT NULL;
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
      source_task_id TEXT,
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
      FOREIGN KEY(source_task_id) REFERENCES multiremi_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(replayed_from_delivery_id) REFERENCES multiremi_webhook_deliveries(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_webhook_deliveries_autopilot
      ON multiremi_webhook_deliveries(autopilot_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_webhook_deliveries_run
      ON multiremi_webhook_deliveries(autopilot_run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_webhook_deliveries_dedupe
      ON multiremi_webhook_deliveries(trigger_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status NOT IN ('rejected', 'failed');

    CREATE TABLE IF NOT EXISTS multiremi_scm_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'poll',
      base_url TEXT NOT NULL,
      api_base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
      repository_scope TEXT NOT NULL DEFAULT 'selected',
      is_default INTEGER NOT NULL DEFAULT 0,
      access_token_encrypted TEXT,
      access_token_hint TEXT,
      webhook_secret_encrypted TEXT,
      webhook_secret_hint TEXT,
      verification_status TEXT NOT NULL DEFAULT 'unverified',
      verified_at TEXT,
      verification_identity TEXT,
      verified_repository_count INTEGER NOT NULL DEFAULT 0,
      verified_repository_total INTEGER NOT NULL DEFAULT 0,
      verification_error_code TEXT,
      verification_error TEXT,
      verification_generation INTEGER NOT NULL DEFAULT 0,
      verification_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, provider, name)
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_connections_poll
      ON multiremi_scm_connections(enabled, mode, updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_scm_repository_bindings (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      connection_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      repository_url TEXT NOT NULL,
      external_id TEXT,
      owner TEXT,
      name TEXT NOT NULL,
      default_branch TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      assignment_origin TEXT NOT NULL DEFAULT 'explicit',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, repository_id),
      FOREIGN KEY(connection_id) REFERENCES multiremi_scm_connections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_repository_bindings_connection
      ON multiremi_scm_repository_bindings(connection_id, enabled, repository_id);
    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_repository_bindings_url
      ON multiremi_scm_repository_bindings(workspace_id, repository_url);

    CREATE TABLE IF NOT EXISTS multiremi_scm_sync_cursors (
      connection_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      cursor TEXT,
      watermark TEXT,
      baseline_completed_at TEXT,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      suspended_until TEXT,
      lease_owner TEXT,
      lease_until TEXT,
      lease_token TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(connection_id, repository_id, stream),
      FOREIGN KEY(connection_id) REFERENCES multiremi_scm_connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS multiremi_scm_entity_snapshots (
      connection_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      version TEXT,
      revision_at TEXT NOT NULL,
      revision TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(connection_id, repository_id, entity_type, external_id),
      FOREIGN KEY(connection_id) REFERENCES multiremi_scm_connections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_entity_snapshots_observed
      ON multiremi_scm_entity_snapshots(connection_id, repository_id, entity_type, observed_at);

    CREATE TABLE IF NOT EXISTS multiremi_scm_change_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      number INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      state TEXT NOT NULL,
      draft INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      source_branch TEXT,
      target_branch TEXT,
      head_sha TEXT,
      base_sha TEXT,
      author TEXT,
      provider_created_at TEXT,
      provider_updated_at TEXT,
      closed_at TEXT,
      merged_at TEXT,
      merge_sha TEXT,
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
      UNIQUE(connection_id, repository_id, external_id),
      FOREIGN KEY(connection_id) REFERENCES multiremi_scm_connections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_change_requests_workspace
      ON multiremi_scm_change_requests(workspace_id, provider_updated_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_change_requests_repository
      ON multiremi_scm_change_requests(repository_id, provider_updated_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_change_requests_number
      ON multiremi_scm_change_requests(connection_id, repository_id, number);

    CREATE TABLE IF NOT EXISTS multiremi_scm_issue_links (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      change_request_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      source TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      linked_at TEXT NOT NULL,
      unlinked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(change_request_id, issue_id),
      FOREIGN KEY(change_request_id) REFERENCES multiremi_scm_change_requests(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_issue_links_issue
      ON multiremi_scm_issue_links(issue_id, active, updated_at);

    CREATE TABLE IF NOT EXISTS multiremi_scm_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      connection_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      primary_source TEXT NOT NULL,
      fidelity TEXT NOT NULL,
      occurred_at TEXT,
      observed_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_until TEXT,
      last_error TEXT,
      processed_at TEXT,
      targets_initialized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(connection_id, logical_key),
      FOREIGN KEY(connection_id) REFERENCES multiremi_scm_connections(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_events_pending
      ON multiremi_scm_events(status, available_at, lease_until, observed_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_events_repository
      ON multiremi_scm_events(workspace_id, repository_id, observed_at, id);

    CREATE TABLE IF NOT EXISTS multiremi_scm_effects (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      effect_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      applied_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(event_id, issue_id, effect_type),
      FOREIGN KEY(event_id) REFERENCES multiremi_scm_events(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS multiremi_scm_event_evidence (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      source TEXT NOT NULL,
      provider_event_id TEXT,
      dedupe_key TEXT NOT NULL,
      payload TEXT,
      raw_body TEXT,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(event_id, source, dedupe_key),
      FOREIGN KEY(event_id) REFERENCES multiremi_scm_events(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_event_evidence_event
      ON multiremi_scm_event_evidence(event_id, observed_at);

    CREATE TABLE IF NOT EXISTS multiremi_scm_event_deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      autopilot_run_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_until TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(event_id, trigger_id),
      FOREIGN KEY(event_id) REFERENCES multiremi_scm_events(id) ON DELETE CASCADE,
      FOREIGN KEY(trigger_id) REFERENCES multiremi_autopilot_triggers(id) ON DELETE CASCADE,
      FOREIGN KEY(autopilot_run_id) REFERENCES multiremi_autopilot_runs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_event_deliveries_pending
      ON multiremi_scm_event_deliveries(status, available_at, lease_until, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_chat_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      creator_id TEXT,
      agent_id TEXT NOT NULL,
      issue_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      session_id TEXT,
      work_dir TEXT,
      latest_task_id TEXT,
      unread_since TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(agent_id) REFERENCES multiremi_agents(id),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE SET NULL
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
      pending_agent_delivery INTEGER NOT NULL DEFAULT 0,
      agent_delivery_task_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_chat_messages_session ON multiremi_chat_messages(chat_session_id, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_agent_issue_update_state (
      chat_session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      pending_count INTEGER NOT NULL DEFAULT 0,
      pending_since TEXT,
      deliver_after TEXT,
      latest_activity_id TEXT,
      latest_event_type TEXT,
      latest_actor_type TEXT,
      latest_actor_id TEXT,
      latest_body TEXT,
      latest_data TEXT,
      last_delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(channel_id) REFERENCES multiremi_notification_channels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_agent_issue_updates_due
      ON multiremi_agent_issue_update_state(deliver_after, pending_count);

    CREATE TABLE IF NOT EXISTS multiremi_tasks (
      id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL DEFAULT 'direct',
      agent_id TEXT NOT NULL,
      runtime_id TEXT,
      issue_id TEXT,
      issue_session_id TEXT,
      issue_session_generation INTEGER,
      holds_workspace INTEGER NOT NULL DEFAULT 1,
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
      issue_creation_restricted INTEGER NOT NULL DEFAULT 0,
      delegation_id TEXT,
      delegated_by_agent_id TEXT,
      assignment_event_id TEXT,
      assignment_source_event_id TEXT,
      projection_from_seq INTEGER,
      projection_to_seq INTEGER,
      projection_mode TEXT,
      projection_degrade_level INTEGER NOT NULL DEFAULT 0,
      projection_truncated INTEGER NOT NULL DEFAULT 0,
      projection_omitted_events INTEGER NOT NULL DEFAULT 0,
      projection_estimated_tokens INTEGER NOT NULL DEFAULT 0,
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

    -- Feishu events join the same Chat/Task lineage as the browser chat. The
    -- bot app and Agent own the binding: host changes, credential rotations
    -- and redeploys keep context, while changing the bot or Agent starts fresh.
    CREATE TABLE IF NOT EXISTS multiremi_feishu_bot_chat_bindings (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      external_session_key TEXT NOT NULL,
      chat_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, app_id, agent_id, external_session_key),
      FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_bot_chat_bindings_chat
      ON multiremi_feishu_bot_chat_bindings(chat_session_id);

    -- Feishu can redeliver one event. Persist the event id before returning so
    -- retries resolve to the original Task instead of starting duplicate work.
    CREATE TABLE IF NOT EXISTS multiremi_feishu_bot_deliveries (
      workspace_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      reply_to_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, external_message_id),
      FOREIGN KEY(binding_id) REFERENCES multiremi_feishu_bot_chat_bindings(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_bot_deliveries_task
      ON multiremi_feishu_bot_deliveries(task_id);

    -- A completed Issue-lead round may wake the bound Chat. The source-task
    -- uniqueness is the transaction-level idempotency boundary for retries of
    -- the same terminal report.
    CREATE TABLE IF NOT EXISTS multiremi_feishu_bot_round_pushes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      leader_task_id TEXT NOT NULL,
      wake_task_id TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(binding_id, leader_task_id),
      FOREIGN KEY(binding_id) REFERENCES multiremi_feishu_bot_chat_bindings(id) ON DELETE CASCADE,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(leader_task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(wake_task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_bot_round_pushes_wake
      ON multiremi_feishu_bot_round_pushes(wake_task_id, delivery_mode);

    -- The completed Chat reply is committed here before the daemon sends it.
    -- Leases make daemon crashes recoverable; id is also Feishu's stable uuid.
    CREATE TABLE IF NOT EXISTS multiremi_feishu_bot_outbound_deliveries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      task_id TEXT UNIQUE,
      chat_id TEXT NOT NULL,
      thread_id TEXT,
      reply_to_message_id TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      leased_until TEXT,
      available_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      external_message_id TEXT,
      last_error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(binding_id) REFERENCES multiremi_feishu_bot_chat_bindings(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_bot_outbound_pending
      ON multiremi_feishu_bot_outbound_deliveries(status, available_at, leased_until, created_at);

    CREATE TABLE IF NOT EXISTS multiremi_task_prompts (
      task_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      prompt TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      assembled_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );

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

    CREATE TABLE IF NOT EXISTS multiremi_task_steer_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author_type TEXT NOT NULL DEFAULT 'user',
      author_id TEXT,
      kind TEXT NOT NULL DEFAULT 'steer',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_multiremi_task_steer_task ON multiremi_task_steer_messages(task_id, consumed_at);

    CREATE TABLE IF NOT EXISTS multiremi_platform_state (
      id TEXT PRIMARY KEY,
      driver TEXT NOT NULL DEFAULT 'systemd_release',
      current_release TEXT,
      latest_release TEXT,
      recent_releases TEXT NOT NULL DEFAULT '[]',
      services TEXT NOT NULL DEFAULT '[]',
      auto_update_stable INTEGER NOT NULL DEFAULT 0,
      auto_update_time TEXT NOT NULL DEFAULT '05:00',
      auto_update_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      auto_update_next_check_at TEXT,
      auto_update_last_checked_at TEXT,
      auto_update_last_result TEXT,
      updater_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS multiremi_platform_operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      driver TEXT NOT NULL,
      active_slot INTEGER,
      target_version TEXT,
      target_ref TEXT,
      target_manifest TEXT NOT NULL DEFAULT '{}',
      progress TEXT NOT NULL DEFAULT '{}',
      requested_by TEXT NOT NULL,
      output TEXT,
      error TEXT,
      previous_release TEXT,
      result_release TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_platform_operations_active
      ON multiremi_platform_operations(active_slot);
    CREATE INDEX IF NOT EXISTS idx_multiremi_platform_operations_created
      ON multiremi_platform_operations(created_at);

    CREATE TABLE IF NOT EXISTS multiremi_platform_maintenance (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'normal',
      generation INTEGER NOT NULL DEFAULT 0,
      operation_id TEXT,
      started_at TEXT,
      expires_at TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
      cleaned_archive_id TEXT,
      cleaned_archive_source_revision TEXT,
      cleaned_archive_sha256 TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE,
      FOREIGN KEY(runtime_id) REFERENCES multiremi_runtimes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_issue_workspaces_runtime
      ON multiremi_issue_workspaces(runtime_id, status, updated_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_session_archives (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      issue_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      uploaded_size_bytes BIGINT NOT NULL DEFAULT 0,
      file_count INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      relative_path TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at TEXT,
      retry_exhausted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(issue_id, source_revision, sha256),
      FOREIGN KEY(issue_id) REFERENCES multiremi_issues(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_session_archives_issue
      ON multiremi_session_archives(issue_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_session_archives_workspace_status
      ON multiremi_session_archives(workspace_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_session_archives_runtime
      ON multiremi_session_archives(runtime_id, status, updated_at);
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
  addColumnIfMissing(db, "multiremi_workspaces", "env TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "multiremi_agents", "workspace_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_agents", "description TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "multiremi_agents", "avatar_url TEXT");
  addColumnIfMissing(db, "multiremi_agents", "owner_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_agents", "visibility TEXT NOT NULL DEFAULT 'private'");
  addColumnIfMissing(db, "multiremi_agents", "archived_at TEXT");
  addColumnIfMissing(db, "multiremi_agents", "runtime_id TEXT");
  addColumnIfMissing(db, "multiremi_agents", "max_concurrent_tasks INTEGER NOT NULL DEFAULT 6");
  dropColumnIfExists(db, "multiremi_agents", "cwd");
  dropColumnIfExists(db, "multiremi_feishu_bot_configs", "verification_token_encrypted");
  dropColumnIfExists(db, "multiremi_feishu_bot_configs", "encrypt_key_encrypted");
  runMigrationOnce(db, AGENT_ISSUE_PROPOSAL_POLICY_MIGRATION, () => {
    addColumnIfMissing(db, "multiremi_agents", "issue_creation_requires_proposal INTEGER NOT NULL DEFAULT 0");
  });
  runMigrationOnce(db, TASK_ISSUE_PROPOSAL_POLICY_MIGRATION, () => {
    addColumnIfMissing(db, "multiremi_tasks", "issue_creation_restricted INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "multiremi_autopilot_runs", "source_task_id TEXT");
  });
  runMigrationOnce(db, AUTOPILOT_ISSUE_PROPOSAL_POLICY_MIGRATION, () => {
    addColumnIfMissing(db, "multiremi_autopilots", "issue_creation_restricted INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "multiremi_autopilots", "issue_creation_restriction_reason TEXT");
    addColumnIfMissing(db, "multiremi_autopilots", "issue_creation_restricted_by_task_id TEXT");
    addColumnIfMissing(db, "multiremi_autopilot_triggers", "issue_creation_restricted INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "multiremi_autopilot_triggers", "issue_creation_restriction_reason TEXT");
    addColumnIfMissing(db, "multiremi_autopilot_triggers", "issue_creation_restricted_by_task_id TEXT");
    addColumnIfMissing(db, "multiremi_webhook_deliveries", "source_task_id TEXT");
  });
  addColumnIfMissing(db, "multiremi_agents", "supervisor INTEGER NOT NULL DEFAULT 0");
  runMigrationOnce(db, AGENT_ROLE_MIGRATION, () => {
    addColumnIfMissing(db, "multiremi_agents", "role TEXT NOT NULL DEFAULT 'normal'");
    addColumnIfMissing(db, "multiremi_autopilots", "managed_kind TEXT");
    // Legacy names are used only to classify existing platform-owned rows.
    // Preserve historical Atlas ownership data for downgrade compatibility;
    // current runtime authorization no longer reads this field.
    db.run(
      `UPDATE multiremi_agents
       SET role = CASE
         WHEN supervisor = 1 THEN 'supervisor'
         WHEN name = 'Atlas · LLM Wiki' THEN 'maintainer'
         ELSE 'normal'
       END`,
    );
    db.run(
      `UPDATE multiremi_autopilots
       SET managed_kind = CASE title
         WHEN 'Atlas · Project Knowledge' THEN 'atlas_project_knowledge'
         WHEN 'Atlas · Repository Wiki' THEN 'atlas_repository_wiki'
         ELSE managed_kind
       END
       WHERE assignee_type = 'agent'
         AND assignee_id IN (
           SELECT id FROM multiremi_agents WHERE name = 'Atlas · LLM Wiki'
         )`,
    );
  });
  addColumnIfMissing(db, "multiremi_squads", "avatar_url TEXT");
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
  runMigrationOnce(db, DAEMON_PROFILES_MIGRATION, () => {
    createDaemonProfilesAndBackfill(db);
  });
  addColumnIfMissing(db, "multiremi_daemon_profiles", "dedicated INTEGER NOT NULL DEFAULT 0");
  runMigrationOnce(db, PROJECT_DEVICE_DAEMON_CANONICALIZATION_MIGRATION, () => {
    backfillCanonicalDaemonRouting(db);
  });
  addColumnIfMissing(db, "multiremi_runtimes", "drain_ack_generation INTEGER");
  addColumnIfMissing(db, "multiremi_runtimes", "drain_ack_at TEXT");
  addColumnIfMissing(db, "multiremi_runtimes", "drain_reported_active_tasks INTEGER");
  addColumnIfMissing(db, "multiremi_platform_operations", "cancel_requested INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_platform_state", "auto_update_time TEXT NOT NULL DEFAULT '05:00'");
  addColumnIfMissing(
    db,
    "multiremi_platform_state",
    "auto_update_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'",
  );
  addColumnIfMissing(db, "multiremi_platform_state", "auto_update_next_check_at TEXT");
  addColumnIfMissing(db, "multiremi_platform_state", "auto_update_last_checked_at TEXT");
  addColumnIfMissing(db, "multiremi_platform_state", "auto_update_last_result TEXT");
  addColumnIfMissing(
    db,
    "multiremi_daemon_retirements",
    "ssh_mesh_rekey_status TEXT NOT NULL DEFAULT 'not_required'",
  );
  addColumnIfMissing(db, "multiremi_daemon_retirements", "ssh_mesh_compromised_key_version INTEGER");
  addColumnIfMissing(db, "multiremi_daemon_retirements", "ssh_mesh_replacement_key_version INTEGER");
  addColumnIfMissing(db, "multiremi_daemon_retirements", "ssh_mesh_rekey_operation_id TEXT");
  addColumnIfMissing(db, "multiremi_daemon_retirements", "ssh_mesh_rekey_updated_at TEXT");
  addColumnIfMissing(db, "multiremi_workspace_ssh_mesh", "active_operation_id TEXT");
  addColumnIfMissing(db, "multiremi_daemon_ssh_mesh_states", "node_kind TEXT NOT NULL DEFAULT 'runtime'");
  addColumnIfMissing(db, "multiremi_daemon_ssh_mesh_states", "name TEXT");
  addColumnIfMissing(db, "multiremi_daemon_lifecycle_locks", "owner_user_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "daemon_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "task_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "agent_id TEXT");
  addColumnIfMissing(db, "multiremi_access_tokens", "user_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_access_tokens", "scopes TEXT NOT NULL DEFAULT '[]'");
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
  normalizeActiveDaemonTokenExpiry(db);
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
  // Hard deletion spans a database commit and durable archive cleanup. Keep a
  // persisted fence on the Issue so daemon archive writers cannot race a
  // purge snapshot or resurrect archive bytes after the control-plane row is
  // removed.
  addColumnIfMissing(db, "multiremi_issues", "lifecycle_state TEXT NOT NULL DEFAULT 'active'");
  const issueCompletedAtAdded = addColumnIfMissing(db, "multiremi_issues", "completed_at TEXT");
  addColumnIfMissing(db, "multiremi_issues", "archived_at TEXT");
  addColumnIfMissing(db, "multiremi_issue_workspaces", "cleaned_archive_id TEXT");
  addColumnIfMissing(db, "multiremi_issue_workspaces", "cleaned_archive_source_revision TEXT");
  addColumnIfMissing(db, "multiremi_issue_workspaces", "cleaned_archive_sha256 TEXT");
  addColumnIfMissing(db, "multiremi_session_archives", "next_retry_at TEXT");
  addColumnIfMissing(db, "multiremi_session_archives", "retry_exhausted_at TEXT");
  runMigrationOnce(db, SESSION_ARCHIVE_RETRY_BUDGET_MIGRATION, () => {
    backfillSessionArchiveRetryBudget(db);
  });
  addColumnIfMissing(db, "multiremi_issue_comments", "parent_id TEXT");
  addColumnIfMissing(db, "multiremi_issue_comments", "type TEXT NOT NULL DEFAULT 'comment'");
  addColumnIfMissing(db, "multiremi_issue_comments", "resolved_at TEXT");
  addColumnIfMissing(db, "multiremi_issue_comments", "resolved_by_type TEXT");
  addColumnIfMissing(db, "multiremi_issue_comments", "resolved_by_id TEXT");
  addColumnIfMissing(db, "multiremi_issue_comments", "issue_session_id TEXT");
  // Existing Sessions and Tasks keep the historical Issue-wide workspace
  // lease. New discussion Sessions must opt out explicitly.
  addColumnIfMissing(db, "multiremi_issue_sessions", "holds_workspace INTEGER NOT NULL DEFAULT 1");
  // Agent auto-reply comments point back at the run that produced them, so the
  // chat stream can open that task's transcript. Forward-only: no backfill.
  addColumnIfMissing(db, "multiremi_issue_comments", "task_id TEXT");
  addColumnIfMissing(db, "multiremi_attachments", "chat_session_id TEXT");
  addColumnIfMissing(db, "multiremi_attachments", "chat_message_id TEXT");
  ensureIssueSubscriberTypedSchema(db);
  addColumnIfMissing(db, "multiremi_chat_sessions", "creator_id TEXT");
  addColumnIfMissing(db, "multiremi_chat_sessions", "unread_since TEXT");
  addColumnIfMissing(
    db,
    "multiremi_chat_sessions",
    "issue_id TEXT REFERENCES multiremi_issues(id) ON DELETE SET NULL",
  );
  // Pool scheduling records the machine + engine that produced the promoted
  // provider session as atomic metadata on the session itself, so follow-ups
  // don't have to (mis)infer them from "the latest task with a runtime_id".
  addColumnIfMissing(db, "multiremi_chat_sessions", "session_runtime_id TEXT");
  addColumnIfMissing(db, "multiremi_chat_sessions", "session_provider TEXT");
  addColumnIfMissing(db, "multiremi_chat_sessions", "session_execution_fingerprint TEXT");
  addColumnIfMissing(db, "multiremi_chat_messages", "failure_reason TEXT");
  addColumnIfMissing(db, "multiremi_chat_messages", "elapsed_ms INTEGER");
  addColumnIfMissing(db, "multiremi_chat_messages", "pending_agent_delivery INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_chat_messages", "agent_delivery_task_id TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_multiremi_chat_messages_agent_delivery
    ON multiremi_chat_messages(chat_session_id, pending_agent_delivery, created_at)`);
  dropColumnIfExists(db, "multiremi_agent_issue_update_state", "window_started_at");
  dropColumnIfExists(db, "multiremi_agent_issue_update_state", "deliveries_in_window");
  addColumnIfMissing(db, "multiremi_tasks", "chat_session_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "task_kind TEXT NOT NULL DEFAULT 'direct'");
  addColumnIfMissing(db, "multiremi_tasks", "wait_reason TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "failure_reason TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "attempt INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "multiremi_tasks", "max_attempts INTEGER NOT NULL DEFAULT 3");
  addColumnIfMissing(db, "multiremi_tasks", "parent_task_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "delegation_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "delegated_by_agent_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "trigger_comment_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "trigger_summary TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "issue_session_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "issue_session_generation INTEGER");
  addColumnIfMissing(db, "multiremi_tasks", "holds_workspace INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "multiremi_tasks", "assignment_event_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "assignment_source_event_id TEXT");
  // The audit table shipped inside MUL-206 before it had a seq; a branch
  // checkout that already created it needs the column added rather than the
  // CREATE TABLE above, which is a no-op once the table exists.
  addColumnIfMissing(db, "multiremi_feishu_bot_audit", "seq INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_feishu_bot_chat_bindings", "chat_id TEXT");
  addColumnIfMissing(db, "multiremi_feishu_bot_chat_bindings", "thread_id TEXT");
  addColumnIfMissing(db, "multiremi_feishu_bot_chat_bindings", "reply_to_message_id TEXT");
  backfillFeishuBotReplyDestinations(db);
  runMigrationOnce(db, FEISHU_ISSUE_TOPIC_OUTBOUND_MIGRATION, () => {
    allowNullableFeishuOutboundReplyToMessageId(db);
  });
  addColumnIfMissing(db, "multiremi_tasks", "projection_from_seq INTEGER");
  addColumnIfMissing(db, "multiremi_tasks", "projection_to_seq INTEGER");
  addColumnIfMissing(db, "multiremi_tasks", "projection_mode TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "projection_degrade_level INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_tasks", "projection_truncated INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_tasks", "projection_omitted_events INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_tasks", "projection_estimated_tokens INTEGER NOT NULL DEFAULT 0");
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
  addColumnIfMissing(db, "multiremi_notification_deliveries", "claim_seq INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_notification_deliveries", "leased_until TEXT");
  // NULL member_id = workspace-level channel (admin managed); non-NULL = a single
  // member's personal channel. Existing rows stay NULL, so channels created before
  // this column keep their workspace-wide routing.
  addColumnIfMissing(db, "multiremi_notification_channels", "member_id TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_multiremi_notification_deliveries_pending
      ON multiremi_notification_deliveries(status, leased_until, created_at);
    CREATE INDEX IF NOT EXISTS idx_multiremi_notification_channels_member
      ON multiremi_notification_channels(workspace_id, member_id, enabled);
  `);
  ensureInboxGenericSchema(db);
  runMigrationOnce(db, FEISHU_INGEST_V2_MIGRATION, () => ensureFeishuIngestV2Schema(db));
  runMigrationOnce(db, FEISHU_INGEST_ALERT_DELIVERY_V3_MIGRATION, () => ensureFeishuIngestAlertDeliveryV3Schema(db));
  runMigrationOnce(db, FEISHU_ISSUE_PROPOSALS_V4_MIGRATION, () => ensureFeishuIssueProposalsV4Schema(db));
  runMigrationOnce(db, MESSAGING_CORE_V1_MIGRATION, () => migrateLegacyFeishuMessagingData(db));
  runMigrationOnce(db, MARKDOWN_ATTACHMENT_OWNERSHIP_MIGRATION, () => backfillMarkdownAttachmentOwnership(db));
  addColumnIfMissing(db, "multiremi_autopilots", "created_by_type TEXT NOT NULL DEFAULT 'member'");
  addColumnIfMissing(db, "multiremi_autopilots", "created_by_id TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(db, "multiremi_autopilots", "session_policy TEXT NOT NULL DEFAULT 'new'");
  addColumnIfMissing(db, "multiremi_autopilots", "workspace_policy TEXT NOT NULL DEFAULT 'reuse_issue'");
  addColumnIfMissing(db, "multiremi_autopilot_triggers", "event_filters TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_triggers", "event_config TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_triggers", "provider TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_triggers", "signing_secret_hint TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_runs", "trigger_id TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_runs", "event_id TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_runs", "issue_session_id TEXT");
  // Repository-scoped Wiki build runs: the target repository plus an
  // idempotency key (`repo:mode:revision`) that runAutopilot uses to dedupe
  // concurrent and same-revision builds.
  addColumnIfMissing(db, "multiremi_autopilot_runs", "repository_id TEXT");
  addColumnIfMissing(db, "multiremi_autopilot_runs", "dedupe_key TEXT");
  addColumnIfMissing(db, "multiremi_scm_sync_cursors", "lease_owner TEXT");
  addColumnIfMissing(db, "multiremi_scm_sync_cursors", "lease_until TEXT");
  addColumnIfMissing(db, "multiremi_scm_sync_cursors", "lease_token TEXT");
  addColumnIfMissing(
    db,
    "multiremi_scm_sync_cursors",
    "consecutive_failures INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "multiremi_scm_sync_cursors", "suspended_until TEXT");
  addColumnIfMissing(
    db,
    "multiremi_scm_connections",
    "repository_scope TEXT NOT NULL DEFAULT 'selected'",
  );
  addColumnIfMissing(
    db,
    "multiremi_scm_connections",
    "is_default INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "multiremi_scm_connections", "verification_status TEXT NOT NULL DEFAULT 'unverified'");
  addColumnIfMissing(db, "multiremi_scm_connections", "verified_at TEXT");
  addColumnIfMissing(db, "multiremi_scm_connections", "verification_identity TEXT");
  addColumnIfMissing(db, "multiremi_scm_connections", "verified_repository_count INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_scm_connections", "verified_repository_total INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_scm_connections", "verification_error_code TEXT");
  addColumnIfMissing(db, "multiremi_scm_connections", "verification_error TEXT");
  addColumnIfMissing(db, "multiremi_scm_connections", "verification_generation INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_scm_connections", "verification_run_id TEXT");
  addColumnIfMissing(db, "multiremi_scm_repository_bindings", "assignment_origin TEXT NOT NULL DEFAULT 'explicit'");
  runMigrationOnce(db, SCM_CONNECTION_ORIGIN_MIGRATION, () => normalizeScmConnectionOrigins(db));
  runMigrationOnce(db, SCM_DEFAULT_SCOPE_MIGRATION, () => backfillSingleScmDefaults(db));
  runMigrationOnce(db, CODEBASE_CHANGE_REQUEST_CURSOR_RESET_MIGRATION, () => {
    db.run(
      `UPDATE multiremi_scm_sync_cursors
       SET cursor = NULL, watermark = NULL
       WHERE stream = 'change_requests'
         AND connection_id IN (
           SELECT id FROM multiremi_scm_connections WHERE provider = 'codebase'
         )`,
    );
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_multiremi_scm_sync_cursors_lease
      ON multiremi_scm_sync_cursors(lease_until, connection_id, repository_id, stream);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_scm_connections_default
      ON multiremi_scm_connections(workspace_id, provider, base_url)
      WHERE is_default = 1;
  `);
  addColumnIfMissing(db, "multiremi_scm_entity_snapshots", "revision_at TEXT");
  addColumnIfMissing(db, "multiremi_scm_entity_snapshots", "revision TEXT");
  addColumnIfMissing(db, "multiremi_scm_events", "targets_initialized INTEGER NOT NULL DEFAULT 0");
  db.run(
    `UPDATE multiremi_scm_entity_snapshots
     SET revision_at = COALESCE(revision_at, observed_at),
         revision = COALESCE(revision, version, content_hash)
     WHERE revision_at IS NULL OR revision IS NULL`,
  );
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_autopilot_runs_system_event
      ON multiremi_autopilot_runs(trigger_id, event_id)
      WHERE trigger_id IS NOT NULL AND event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_multiremi_autopilot_runs_repository
      ON multiremi_autopilot_runs(repository_id, created_at)
      WHERE repository_id IS NOT NULL;
  `);
  addColumnIfMissing(db, "multiremi_runtime_update_requests", "scope TEXT NOT NULL DEFAULT 'cli'");
  // Source references on wiki/memory docs. The table itself is new enough that
  // only dev databases predate the column, but CREATE TABLE IF NOT EXISTS never
  // revisits an existing table — so it gets patched in like every other column.
  addColumnIfMissing(db, "multiremi_project_docs", "refs TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "multiremi_project_docs", "path TEXT");
  db.run("UPDATE multiremi_project_docs SET path = slug || '.md' WHERE path IS NULL OR TRIM(path) = ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_project_docs_path ON multiremi_project_docs(project_id, path)");
  addColumnIfMissing(db, "multiremi_project_docs", "storage_backend TEXT NOT NULL DEFAULT 'sql'");
  addColumnIfMissing(db, "multiremi_project_docs", "content_uri TEXT");
  addColumnIfMissing(db, "multiremi_project_docs", "content_sha256 TEXT");
  addColumnIfMissing(db, "multiremi_project_docs", "sync_status TEXT NOT NULL DEFAULT 'sql'");
  addColumnIfMissing(db, "multiremi_project_docs", "sync_error TEXT");
  addColumnIfMissing(db, "multiremi_project_docs", "snapshot_oid TEXT");
  addColumnIfMissing(db, "multiremi_project_doc_revisions", "content_sha256 TEXT");
  addColumnIfMissing(db, "multiremi_project_doc_revisions", "snapshot_oid TEXT");
  addColumnIfMissing(db, "multiremi_project_doc_revisions", "content_uri TEXT");
  addColumnIfMissing(db, "multiremi_project_docs", "compilation_run_id TEXT");
  addColumnIfMissing(db, "multiremi_project_doc_revisions", "compilation_run_id TEXT");
  addColumnIfMissing(db, "multiremi_repository_wiki_docs", "compilation_run_id TEXT");
  addColumnIfMissing(db, "multiremi_repository_wiki_doc_revisions", "compilation_run_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_project_docs_sync ON multiremi_project_docs(workspace_id, sync_status, updated_at)");
  addColumnIfMissing(db, "multiremi_projects", "archived_at TEXT");
  addColumnIfMissing(db, "multiremi_projects", "instructions TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "multiremi_projects", "delta_instructions TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "multiremi_projects", "instructions_revision INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_projects", "instructions_updated_at TEXT");
  addColumnIfMissing(db, "multiremi_projects", "instructions_updated_by TEXT");
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
  addColumnIfMissing(db, "multiremi_users", "feishu_union_id TEXT");
  addColumnIfMissing(db, "multiremi_workspace_members", "user_id TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "requesting_user_name TEXT");
  addColumnIfMissing(db, "multiremi_tasks", "requesting_user_profile_description TEXT");
  addColumnIfMissing(db, "multiremi_runtime_command_requests", "provision_id TEXT");
  addColumnIfMissing(db, "multiremi_workspace_runtime_provisions", "version_check INTEGER NOT NULL DEFAULT 1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_users_external_id ON multiremi_users(external_id)");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_users_feishu_union_id
    ON multiremi_users(feishu_union_id)
    WHERE feishu_union_id IS NOT NULL AND feishu_union_id != ''`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_workspace_members_user ON multiremi_workspace_members(user_id, workspace_id)");
  backfillMemberUserIds(db);
  backfillBoundChatAgentChannels(db);
  backfillOwnerExternalId(db);
  normalizeSquadLeaderRoles(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_trigger_comment ON multiremi_tasks(trigger_comment_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_issue_session ON multiremi_tasks(issue_session_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_tasks_delegation ON multiremi_tasks(delegation_id, agent_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issue_comments_session ON multiremi_issue_comments(issue_session_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issues_parent ON multiremi_issues(parent_issue_id, position, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issues_scheduled ON multiremi_issues(workspace_id, start_date, due_date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issues_archive ON multiremi_issues(workspace_id, archived_at, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issue_comments_parent ON multiremi_issue_comments(parent_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_attachments_chat_session ON multiremi_attachments(chat_session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_attachments_chat_message ON multiremi_attachments(chat_message_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_multiremi_issue_comments_resolved ON multiremi_issue_comments(issue_id, resolved_at)");
  db.run("UPDATE multiremi_issues SET status = 'todo' WHERE status = 'open'");
  if (issueCompletedAtAdded) {
    db.run(
      "UPDATE multiremi_issues SET completed_at = updated_at WHERE completed_at IS NULL AND status IN ('done', 'cancelled')",
    );
  }
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
  migrateLegacyGithubProjection(db, legacyGithubTables);
}

function migrateLegacyGithubProjection(db: SqlDatabase, legacyTables: Set<string>): void {
  const now = new Date().toISOString();
  const settingsRows = legacyTables.has("multiremi_github_settings")
    ? db.query("SELECT * FROM multiremi_github_settings").all() as Array<Record<string, unknown>>
    : [];
  for (const row of settingsRows) {
    const workspaceId = String(row.workspace_id ?? "local");
    const workspace = db.query("SELECT settings FROM multiremi_workspaces WHERE id = ?").get(workspaceId) as { settings?: unknown } | null;
    if (!workspace) continue;
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(workspace.settings ?? "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    } catch {
      settings = {};
    }
    if (!("scm_change_sidebar_enabled" in settings)) settings.scm_change_sidebar_enabled = Boolean(Number(row.pr_sidebar ?? 1));
    if (!("scm_auto_link_enabled" in settings)) settings.scm_auto_link_enabled = Boolean(Number(row.auto_link_prs ?? 1));
    if (!("scm_complete_issue_on_merge_enabled" in settings)) settings.scm_complete_issue_on_merge_enabled = false;
    if (!("co_authored_by_enabled" in settings)) settings.co_authored_by_enabled = Boolean(Number(row.co_author ?? 1));
    db.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = ?", [JSON.stringify(settings), workspaceId]);
  }

  if (!legacyTables.has("multiremi_github_pull_requests")) return;
  const rows = db.query(
    `SELECT p.*, b.connection_id, b.repository_id
     FROM multiremi_github_pull_requests p
     JOIN multiremi_scm_repository_bindings b
       ON b.workspace_id = p.workspace_id
      AND LOWER(b.name) = LOWER(p.repo_name)
      AND LOWER(COALESCE(b.owner, '')) = LOWER(p.repo_owner)
     JOIN multiremi_scm_connections c
       ON c.id = b.connection_id AND c.provider = 'github'`,
  ).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const legacyId = String(row.id);
    const changeRequestId = `scr_legacy_${legacyId}`;
    db.run(
      `INSERT OR IGNORE INTO multiremi_scm_change_requests (
        id, workspace_id, connection_id, repository_id, provider, external_id,
        number, title, body, state, draft, url, source_branch, target_branch,
        head_sha, base_sha, author, provider_created_at, provider_updated_at,
        closed_at, merged_at, merge_sha, mergeable_state, checks_conclusion,
        checks_passed, checks_failed, checks_pending, additions, deletions,
        changed_files, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'github', ?, ?, ?, NULL, ?, ?, ?, ?, NULL,
        NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        changeRequestId,
        String(row.workspace_id ?? "local"),
        String(row.connection_id),
        String(row.repository_id),
        `legacy-number:${String(row.number)}`,
        Number(row.number),
        String(row.title ?? ""),
        String(row.state ?? "open"),
        row.state === "draft" ? 1 : 0,
        row.html_url == null ? null : String(row.html_url),
        row.branch == null ? null : String(row.branch),
        row.author_login == null ? null : String(row.author_login),
        row.pr_created_at == null ? null : String(row.pr_created_at),
        row.pr_updated_at == null ? null : String(row.pr_updated_at),
        row.closed_at == null ? null : String(row.closed_at),
        row.merged_at == null ? null : String(row.merged_at),
        row.mergeable_state == null ? null : String(row.mergeable_state),
        row.checks_conclusion == null ? null : String(row.checks_conclusion),
        Number(row.checks_passed ?? 0),
        Number(row.checks_failed ?? 0),
        Number(row.checks_pending ?? 0),
        Number(row.additions ?? 0),
        Number(row.deletions ?? 0),
        Number(row.changed_files ?? 0),
        String(row.created_at ?? now),
        String(row.updated_at ?? now),
      ],
    );
    const projected = db.query(
      "SELECT id FROM multiremi_scm_change_requests WHERE connection_id = ? AND repository_id = ? AND number = ?",
    ).get(String(row.connection_id), String(row.repository_id), Number(row.number)) as { id?: unknown } | null;
    const issueId = row.issue_id == null ? null : String(row.issue_id);
    if (!projected?.id || !issueId) continue;
    const issue = db.query("SELECT id FROM multiremi_issues WHERE id = ? AND workspace_id = ?").get(
      issueId,
      String(row.workspace_id ?? "local"),
    );
    if (!issue) continue;
    db.run(
      `INSERT OR IGNORE INTO multiremi_scm_issue_links (
        id, workspace_id, change_request_id, issue_id, source, active,
        linked_at, unlinked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'legacy', 1, ?, NULL, ?, ?)`,
      [`sil_legacy_${legacyId}`, String(row.workspace_id ?? "local"), String(projected.id), issueId, now, now, now],
    );
  }
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

function existingTableNames(db: SqlDatabase): Set<string> {
  return new Set((db
    .query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')")
    .all() as Array<{ name: string; type: string }>)
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name));
}

function addColumnIfMissing(db: SqlDatabase, table: string, definition: string): boolean {
  const columnName = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s/u.exec(definition.trim())?.[1];
  if (!columnName) throw new Error(`Invalid column definition for ${table}: ${definition}`);
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) return false;
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

function dropColumnIfExists(db: SqlDatabase, table: string, columnName: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(columnName)) {
    throw new Error(`Invalid table or column name: ${table}.${columnName}`);
  }
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) return false;
  db.run(`ALTER TABLE ${table} DROP COLUMN ${columnName}`);
  return true;
}

function ensureFeishuIngestV2Schema(db: SqlDatabase): void {
  addColumnIfMissing(db, "multiremi_feishu_sources", "endpoint_name TEXT");
  addColumnIfMissing(db, "multiremi_feishu_sources", "unprocessed_retry_seconds INTEGER NOT NULL DEFAULT 900");
  addColumnIfMissing(db, "multiremi_feishu_sources", "unprocessed_retry_limit INTEGER NOT NULL DEFAULT 3");
  addColumnIfMissing(db, "multiremi_feishu_sources", "last_successful_ingest_at TEXT");
  addColumnIfMissing(db, "multiremi_feishu_sources", "last_error_code TEXT");
  addColumnIfMissing(db, "multiremi_feishu_sources", "last_error_at TEXT");
  addColumnIfMissing(db, "multiremi_feishu_sources", "consecutive_failures INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_feishu_sources", "connection_alerted_at TEXT");
  // V1 stored arbitrary URLs. They cannot be trusted as V2 endpoint names, so
  // legacy sources are disabled and must be explicitly rebound by an admin.
  db.run(
    `UPDATE multiremi_feishu_sources
     SET endpoint_name = 'legacy_' || LOWER(id), enabled = 0
     WHERE endpoint_name IS NULL OR endpoint_name = ''`,
  );
  addColumnIfMissing(db, "multiremi_feishu_messages", "retry_count INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "multiremi_feishu_messages", "last_retry_at TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_feishu_sources_endpoint_name
      ON multiremi_feishu_sources(workspace_id, endpoint_name);
    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_messages_source_unprocessed
      ON multiremi_feishu_messages(source_id, processed_at, last_retry_at, ingested_at, message_id);
  `);
}

function ensureFeishuIngestAlertDeliveryV3Schema(db: SqlDatabase): void {
  addColumnIfMissing(
    db,
    "multiremi_feishu_sources",
    "connection_alert_delivery_failure_count INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(db, "multiremi_feishu_sources", "connection_alert_delivery_error_code TEXT");
  addColumnIfMissing(db, "multiremi_feishu_sources", "connection_alert_delivery_failed_at TEXT");
}

function ensureFeishuIssueProposalsV4Schema(db: SqlDatabase): void {
  addColumnIfMissing(
    db,
    "multiremi_feishu_message_outcomes",
    "proposal_payload TEXT NOT NULL DEFAULT '{}'",
  );
  addColumnIfMissing(
    db,
    "multiremi_feishu_message_outcomes",
    "proposal_status TEXT NOT NULL DEFAULT 'not_applicable'",
  );
  addColumnIfMissing(db, "multiremi_feishu_message_outcomes", "proposal_resolved_at TEXT");
  addColumnIfMissing(db, "multiremi_feishu_message_outcomes", "proposal_resolved_by TEXT");
  addColumnIfMissing(db, "multiremi_message_outcomes", "sequence INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_feishu_issue_proposals_message
      ON multiremi_feishu_message_outcomes(message_id)
      WHERE outcome_kind = 'issue_proposed';
    CREATE INDEX IF NOT EXISTS idx_multiremi_feishu_issue_proposals_status
      ON multiremi_feishu_message_outcomes(workspace_id, outcome_kind, proposal_status, created_at);
  `);
}

/**
 * The retired product name the legacy repo filled in for an unnamed source.
 *
 * It was never something an operator typed: `createSource` substituted it
 * whenever `name` was omitted, so carrying it over verbatim would put
 * "Personal Automation" back on screen in the new panel on every upgraded
 * install. Only this exact string is replaced — a name an operator did choose,
 * including one that merely contains these words, is their data and is left
 * alone.
 */
const LEGACY_DEFAULT_SOURCE_NAME = "Personal Automation";
const MIGRATED_DEFAULT_SOURCE_NAME = "飞书消息";

function migratedSourceName(value: unknown): string {
  const name = String(value ?? "");
  return name.trim() === LEGACY_DEFAULT_SOURCE_NAME ? MIGRATED_DEFAULT_SOURCE_NAME : name;
}

function migrateLegacyFeishuMessagingData(db: SqlDatabase): void {
  type LegacyRow = Record<string, unknown>;
  assertLegacyMessagingIntegrity(db);
  let lastSourceId = "";
  while (true) {
    const sources = db.query(
      `SELECT * FROM multiremi_feishu_sources
       WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(lastSourceId, MESSAGING_MIGRATION_BATCH_SIZE) as LegacyRow[];
    for (const source of sources) {
      const sourceId = String(source.id);
      const connectionId = legacyMessageConnectionId(sourceId);
      const workspaceId = String(source.workspace_id ?? "local");
      const createdAt = String(source.created_at ?? new Date().toISOString());
      const updatedAt = String(source.updated_at ?? createdAt);
      const endpointName = stringOrNull(source.endpoint_name);

      db.run(
        `INSERT OR IGNORE INTO multiremi_message_connections (
          id, workspace_id, provider, channel, name, external_account_id,
          external_account_name, status, config, last_checked_at,
          last_error_code, last_error_at, created_at, updated_at
        ) VALUES (?, ?, 'lark_cli', 'feishu', ?, NULL, NULL, 'unknown', ?, NULL, ?, ?, ?, ?)`,
        [
          connectionId,
          workspaceId,
          endpointName ?? migratedSourceName(source.name ?? sourceId),
          JSON.stringify({
            migrated_from: "multiremi_feishu_sources",
            ...(endpointName ? { legacy_endpoint_name: endpointName } : {}),
          }),
          stringOrNull(source.last_error_code),
          stringOrNull(source.last_error_at),
          createdAt,
          updatedAt,
        ],
      );

      db.run(
        `INSERT OR IGNORE INTO multiremi_message_sources (
          id, workspace_id, connection_id, name, allowlist, enabled,
          retention_days, poll_interval_seconds, unprocessed_retry_seconds,
          unprocessed_retry_limit, last_successful_ingest_at, last_error_code,
          last_error_at, consecutive_failures, connection_alerted_at,
          connection_alert_delivery_failure_count,
          connection_alert_delivery_error_code,
          connection_alert_delivery_failed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          workspaceId,
          connectionId,
          migratedSourceName(source.name),
          JSON.stringify(migrateLegacyAllowlist(source.allowlist, createdAt)),
          Number(source.enabled ?? 1),
          Number(source.retention_days ?? 90),
          Number(source.poll_interval_seconds ?? 15),
          Number(source.unprocessed_retry_seconds ?? 900),
          Number(source.unprocessed_retry_limit ?? 3),
          stringOrNull(source.last_successful_ingest_at),
          stringOrNull(source.last_error_code),
          stringOrNull(source.last_error_at),
          Number(source.consecutive_failures ?? 0),
          stringOrNull(source.connection_alerted_at),
          Number(source.connection_alert_delivery_failure_count ?? 0),
          stringOrNull(source.connection_alert_delivery_error_code),
          stringOrNull(source.connection_alert_delivery_failed_at),
          createdAt,
          updatedAt,
        ],
      );
      lastSourceId = sourceId;
    }
    if (sources.length < MESSAGING_MIGRATION_BATCH_SIZE) break;
  }

  let lastCursorSourceId = "";
  let lastCursorStream = "";
  while (true) {
    const cursors = db.query(
      `SELECT * FROM multiremi_feishu_sync_cursors
       WHERE source_id > ? OR (source_id = ? AND stream > ?)
       ORDER BY source_id ASC, stream ASC LIMIT ?`,
    ).all(
      lastCursorSourceId,
      lastCursorSourceId,
      lastCursorStream,
      MESSAGING_MIGRATION_BATCH_SIZE,
    ) as LegacyRow[];
    for (const cursor of cursors) {
      const sourceId = String(cursor.source_id);
      const stream = String(cursor.stream);
      db.run(
        `INSERT OR IGNORE INTO multiremi_message_sync_cursors (
          source_id, stream, cursor, watermark, last_started_at, last_completed_at,
          last_error, lease_owner, lease_until, lease_token, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          stream,
          stringOrNull(cursor.cursor),
          stringOrNull(cursor.watermark),
          stringOrNull(cursor.last_started_at),
          stringOrNull(cursor.last_completed_at),
          stringOrNull(cursor.last_error),
          stringOrNull(cursor.lease_owner),
          stringOrNull(cursor.lease_until),
          stringOrNull(cursor.lease_token),
          String(cursor.updated_at ?? new Date().toISOString()),
        ],
      );
      lastCursorSourceId = sourceId;
      lastCursorStream = stream;
    }
    if (cursors.length < MESSAGING_MIGRATION_BATCH_SIZE) break;
  }

  let lastMessageId = "";
  while (true) {
    const messages = db.query(
      `SELECT * FROM multiremi_feishu_messages
       WHERE message_id > ? ORDER BY message_id ASC LIMIT ?`,
    ).all(lastMessageId, MESSAGING_MIGRATION_BATCH_SIZE) as LegacyRow[];
    for (const message of messages) {
      const sourceId = String(message.source_id);
      const connectionId = legacyMessageConnectionId(sourceId);
      const externalMessageId = String(message.message_id);
      const raw = parseLegacyJsonRecord(message.content);
      const searchableText = String(message.searchable_text ?? "");
      const sentAt = String(message.created_at);
      db.run(
        `INSERT OR IGNORE INTO multiremi_message_messages (
          connection_id, external_message_id, workspace_id, source_id,
          external_conversation_id, conversation_kind, conversation_name,
          external_thread_id, external_root_id, external_parent_id, sender,
          searchable_text, attachments, mentions, reactions, raw,
          content_fingerprint, message_url, sent_at, edited_at, recalled,
          ingested_at, processed_at, retry_count, last_retry_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          connectionId,
          externalMessageId,
          String(message.workspace_id ?? "local"),
          sourceId,
          String(message.chat_id),
          migrateLegacyConversationKind(message.chat_type),
          stringOrNull(message.chat_name),
          stringOrNull(message.thread_id),
          stringOrNull(message.root_id),
          stringOrNull(message.parent_id),
          JSON.stringify(migrateLegacySender(message.sender)),
          searchableText,
          JSON.stringify(raw),
          String(message.content_fingerprint ?? createHash("sha256").update(JSON.stringify(raw)).digest("hex")),
          stringOrNull(message.message_app_link),
          sentAt,
          Number(message.edited ?? 0) === 1 ? stringOrNull(message.updated_at) : null,
          Number(message.recalled ?? 0),
          String(message.ingested_at ?? sentAt),
          stringOrNull(message.processed_at),
          Number(message.retry_count ?? 0),
          stringOrNull(message.last_retry_at),
        ],
      );
      lastMessageId = externalMessageId;
    }
    if (messages.length < MESSAGING_MIGRATION_BATCH_SIZE) break;
  }

  let lastOutcomeId = "";
  while (true) {
    const outcomes = db.query(
      `SELECT o.*, m.source_id AS legacy_source_id
       FROM multiremi_feishu_message_outcomes o
       JOIN multiremi_feishu_messages m ON m.message_id = o.message_id
       WHERE o.id > ? ORDER BY o.id ASC LIMIT ?`,
    ).all(lastOutcomeId, MESSAGING_MIGRATION_BATCH_SIZE) as LegacyRow[];
    for (const outcome of outcomes) {
      const externalMessageId = String(outcome.message_id);
      const connectionId = legacyMessageConnectionId(String(outcome.legacy_source_id));
      const outcomeId = String(outcome.id);
      db.run(
        `INSERT OR IGNORE INTO multiremi_message_outcomes (
          id, workspace_id, connection_id, external_message_id, outcome_kind,
          ref, reason, task_id, proposal_payload, proposal_status,
          proposal_resolved_at, proposal_resolved_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outcomeId,
          String(outcome.workspace_id ?? "local"),
          connectionId,
          externalMessageId,
          String(outcome.outcome_kind),
          stringOrNull(outcome.ref),
          stringOrNull(outcome.reason),
          stringOrNull(outcome.task_id),
          JSON.stringify(parseLegacyJsonRecord(outcome.proposal_payload)),
          String(outcome.proposal_status ?? "not_applicable"),
          stringOrNull(outcome.proposal_resolved_at),
          stringOrNull(outcome.proposal_resolved_by),
          String(outcome.created_at),
        ],
      );
      lastOutcomeId = outcomeId;
    }
    if (outcomes.length < MESSAGING_MIGRATION_BATCH_SIZE) break;
  }
}

function assertLegacyMessagingIntegrity(db: SqlDatabase): void {
  const checks: Array<{ label: string; sql: string }> = [
    {
      label: "cursor rows without a source",
      sql: `SELECT COUNT(*) AS count
            FROM multiremi_feishu_sync_cursors c
            LEFT JOIN multiremi_feishu_sources s ON s.id = c.source_id
            WHERE s.id IS NULL`,
    },
    {
      label: "message rows without a source",
      sql: `SELECT COUNT(*) AS count
            FROM multiremi_feishu_messages m
            LEFT JOIN multiremi_feishu_sources s ON s.id = m.source_id
            WHERE s.id IS NULL`,
    },
    {
      label: "outcome rows without a message",
      sql: `SELECT COUNT(*) AS count
            FROM multiremi_feishu_message_outcomes o
            LEFT JOIN multiremi_feishu_messages m ON m.message_id = o.message_id
            WHERE m.message_id IS NULL`,
    },
  ];
  for (const check of checks) {
    const row = db.query(check.sql).get() as { count?: unknown } | null;
    const count = Number(row?.count ?? 0);
    if (count > 0) {
      throw new Error(`Cannot migrate legacy messaging data: ${count} ${check.label}`);
    }
  }
}

function legacyMessageConnectionId(sourceId: string): string {
  return `mconn_${sourceId}`;
}

function migrateLegacyAllowlist(value: unknown, fallbackAddedAt: string): Array<{
  externalConversationId: string;
  addedAt: string;
}> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (typeof entry === "string") {
      const externalConversationId = entry.trim();
      return externalConversationId ? [{ externalConversationId, addedAt: fallbackAddedAt }] : [];
    }
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const externalConversationId = String(
      row.externalConversationId ?? row.external_conversation_id ?? row.chatId ?? row.chat_id ?? "",
    ).trim();
    const addedAt = String(row.addedAt ?? row.added_at ?? fallbackAddedAt).trim();
    return externalConversationId && addedAt ? [{ externalConversationId, addedAt }] : [];
  });
}

function migrateLegacyConversationKind(value: unknown): "direct" | "group" | "thread" | "unknown" {
  const kind = String(value ?? "").toLowerCase();
  if (kind === "p2p" || kind === "direct" || kind === "single") return "direct";
  if (kind === "group") return "group";
  if (kind === "thread" || kind === "topic") return "thread";
  return "unknown";
}

function migrateLegacySender(value: unknown): {
  externalSenderId: string | null;
  displayName: string | null;
  kind: "user" | "bot" | "system" | "unknown";
  isSelf: boolean;
} {
  const sender = parseLegacyJsonRecord(value);
  const senderType = String(sender.kind ?? sender.sender_type ?? sender.type ?? "").toLowerCase();
  const kind = senderType === "user"
    ? "user"
    : senderType === "bot" || senderType === "app"
      ? "bot"
      : senderType === "system"
        ? "system"
        : "unknown";
  return {
    externalSenderId: stringOrNull(
      sender.externalSenderId
      ?? sender.external_sender_id
      ?? sender.open_id
      ?? sender.user_id
      ?? sender.id,
    ),
    displayName: stringOrNull(sender.displayName ?? sender.display_name ?? sender.name),
    kind,
    isSelf: false,
  };
}

function parseLegacyJsonRecord(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function runMigrationOnce(db: SqlDatabase, id: string, migrate: () => void): void {
  db.transaction(() => {
    const claimed = db.run(
      "INSERT OR IGNORE INTO multiremi_schema_migrations (id, applied_at) VALUES (?, ?)",
      [id, new Date().toISOString()],
    ).changes;
    if (claimed !== 1) return;
    migrate();
  })();
}

function allowNullableFeishuOutboundReplyToMessageId(db: SqlDatabase): void {
  const column = (db.query("PRAGMA table_info(multiremi_feishu_bot_outbound_deliveries)").all() as Array<{
    name: string;
    notnull: number;
  }>).find((entry) => entry.name === "reply_to_message_id");
  if (!column || Number(column.notnull) === 0) return;
  if (isPostgresConfigured()) {
    db.exec("ALTER TABLE multiremi_feishu_bot_outbound_deliveries ALTER COLUMN reply_to_message_id DROP NOT NULL");
    return;
  }

  db.exec(`
    ALTER TABLE multiremi_feishu_bot_outbound_deliveries
      RENAME TO multiremi_feishu_bot_outbound_deliveries_legacy;
    CREATE TABLE multiremi_feishu_bot_outbound_deliveries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      task_id TEXT UNIQUE,
      chat_id TEXT NOT NULL,
      thread_id TEXT,
      reply_to_message_id TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      leased_until TEXT,
      available_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      external_message_id TEXT,
      last_error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(binding_id) REFERENCES multiremi_feishu_bot_chat_bindings(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES multiremi_tasks(id) ON DELETE SET NULL
    );
    INSERT INTO multiremi_feishu_bot_outbound_deliveries (
      id, workspace_id, binding_id, task_id, chat_id, thread_id,
      reply_to_message_id, body, status, claim_token, leased_until, available_at,
      attempt_count, external_message_id, last_error, sent_at, created_at, updated_at
    )
    SELECT
      id, workspace_id, binding_id, task_id, chat_id, thread_id,
      reply_to_message_id, body, status, claim_token, leased_until, available_at,
      attempt_count, external_message_id, last_error, sent_at, created_at, updated_at
    FROM multiremi_feishu_bot_outbound_deliveries_legacy;
    DROP TABLE multiremi_feishu_bot_outbound_deliveries_legacy;
    CREATE INDEX idx_multiremi_feishu_bot_outbound_pending
      ON multiremi_feishu_bot_outbound_deliveries(status, available_at, leased_until, created_at);
  `);
}

function backfillCanonicalDaemonRouting(db: SqlDatabase): void {
  const rows = db.query(
    `SELECT DISTINCT COALESCE(workspace_id, 'local') AS workspace_id,
            legacy_daemon_id, daemon_id, metadata
     FROM multiremi_runtimes
     WHERE daemon_id IS NOT NULL AND daemon_id != ''
       AND (
         (legacy_daemon_id IS NOT NULL AND legacy_daemon_id != '')
         OR metadata LIKE '%legacy_runtime_merges%'
       )`,
  ).all() as Array<{
    workspace_id: string;
    legacy_daemon_id: string | null;
    daemon_id: string;
    metadata: string | null;
  }>;
  const now = new Date().toISOString();
  for (const row of rows) {
    const legacyDaemonIds = new Set<string>();
    if (row.legacy_daemon_id?.trim()) legacyDaemonIds.add(row.legacy_daemon_id.trim());
    try {
      const metadata = JSON.parse(row.metadata ?? "{}");
      const merges = metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>).legacy_runtime_merges
        : null;
      if (Array.isArray(merges)) {
        for (const merge of merges) {
          if (!merge || typeof merge !== "object") continue;
          const legacyDaemonId = (merge as Record<string, unknown>).legacy_daemon_id;
          if (typeof legacyDaemonId === "string" && legacyDaemonId.trim()) {
            legacyDaemonIds.add(legacyDaemonId.trim());
          }
        }
      }
    } catch {
      // Runtime metadata is best-effort; the dedicated legacy column still migrates.
    }
    for (const legacyDaemonId of legacyDaemonIds) {
      canonicalizeDaemonRoutingWithinTransaction(
        db,
        String(row.workspace_id ?? "local"),
        legacyDaemonId,
        String(row.daemon_id),
        now,
      );
    }
  }
}

function createDaemonProfilesAndBackfill(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_daemon_profiles (
      workspace_id TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      display_name_customized INTEGER NOT NULL DEFAULT 0,
      dedicated INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, daemon_id)
    );
  `);

  const rows = db.query(
    `SELECT COALESCE(workspace_id, 'local') AS workspace_id,
            daemon_id, device_info, name, updated_at
     FROM multiremi_runtimes
     WHERE daemon_id IS NOT NULL AND daemon_id <> ''
     ORDER BY updated_at DESC`,
  ).all() as Array<{
    workspace_id: unknown;
    daemon_id: unknown;
    device_info: unknown;
    name: unknown;
    updated_at: unknown;
  }>;
  const candidates = new Map<string, {
    workspaceId: string;
    daemonId: string;
    deviceName: string | null;
    legacyName: string | null;
    updatedAt: string;
  }>();
  for (const row of rows) {
    const workspaceId = String(row.workspace_id ?? "local").trim() || "local";
    const daemonId = String(row.daemon_id ?? "").trim();
    if (!daemonId) continue;
    const key = `${workspaceId}\u0000${daemonId}`;
    const current = candidates.get(key) ?? {
      workspaceId,
      daemonId,
      deviceName: null,
      legacyName: null,
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    };
    const deviceName = String(row.device_info ?? "").split(" · ", 1)[0]?.trim() || null;
    const runtimeName = String(row.name ?? "").trim();
    const legacyName = runtimeName.match(/^(.+?)\s+\(([^)]+)\)$/)?.[2]?.trim() || null;
    if (!current.deviceName && deviceName) current.deviceName = deviceName;
    if (!current.legacyName && legacyName) current.legacyName = legacyName;
    candidates.set(key, current);
  }

  for (const candidate of candidates.values()) {
    const displayName = candidate.deviceName ?? candidate.legacyName;
    if (!displayName) continue;
    db.run(
      `INSERT OR IGNORE INTO multiremi_daemon_profiles (
        workspace_id, daemon_id, display_name, display_name_customized,
        updated_by, updated_at
      ) VALUES (?, ?, ?, 0, NULL, ?)`,
      [candidate.workspaceId, candidate.daemonId, displayName, candidate.updatedAt],
    );
  }
}

function backfillMarkdownAttachmentOwnership(db: SqlDatabase): void {
  const comments = db.query(
    `SELECT id, issue_id, body FROM multiremi_issue_comments
     WHERE body LIKE '%/api/attachments/att_%/%'
     ORDER BY created_at ASC, id ASC`,
  ).all() as Array<{ id: string; issue_id: string; body: string }>;
  for (const comment of comments) {
    for (const attachmentId of attachmentIdsFromText(comment.body)) {
      db.run(
        `UPDATE multiremi_attachments
         SET issue_id = ?, comment_id = ?
         WHERE id = ? AND issue_id IS NULL AND comment_id IS NULL`,
        [comment.issue_id, comment.id, attachmentId],
      );
    }
  }

  const issues = db.query(
    `SELECT id, description FROM multiremi_issues
     WHERE description LIKE '%/api/attachments/att_%/%'
     ORDER BY created_at ASC, id ASC`,
  ).all() as Array<{ id: string; description: string }>;
  for (const issue of issues) {
    for (const attachmentId of attachmentIdsFromText(issue.description)) {
      db.run(
        "UPDATE multiremi_attachments SET issue_id = ? WHERE id = ? AND issue_id IS NULL",
        [issue.id, attachmentId],
      );
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
    CREATE INDEX IF NOT EXISTS idx_multiremi_inbox_page
      ON multiremi_inbox_items(member_id, archived, created_at DESC, id DESC);
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

function backfillSingleScmDefaults(db: SqlDatabase): void {
  for (const rows of scmConnectionOriginGroups(db).values()) {
    if (rows.length !== 1) continue;
    const row = rows[0]!;
    db.run(
      `UPDATE multiremi_scm_connections
       SET repository_scope = 'all', is_default = 1
       WHERE id = ? AND is_default = 0 AND repository_scope = 'selected'`,
      [row.id],
    );
    const existingBindings = db.query(
      `SELECT repository_id, repository_url
       FROM multiremi_scm_repository_bindings WHERE connection_id = ?`,
    ).all(row.id) as Array<{ repository_id: string; repository_url: string }>;
    for (const binding of existingBindings) {
      if (scmRepositoryOrigin(binding.repository_url) !== scmRepositoryOrigin(row.base_url)) continue;
      db.run(
        `UPDATE multiremi_scm_repository_bindings SET assignment_origin = 'default'
         WHERE connection_id = ? AND repository_id = ?`,
        [row.id, binding.repository_id],
      );
    }

    const workspace = db.query("SELECT repos FROM multiremi_workspaces WHERE id = ?")
      .get(row.workspace_id) as { repos?: string } | null;
    const repositories = parseScmMigrationRepositories(workspace?.repos);
    const now = new Date().toISOString();
    for (const repository of repositories) {
      if (repository.provider !== row.provider) continue;
      if (scmRepositoryOrigin(repository.url) !== scmRepositoryOrigin(row.base_url)) continue;
      const coordinates = scmMigrationRepositoryCoordinates(repository.url);
      db.run(
        `INSERT INTO multiremi_scm_repository_bindings (
          id, workspace_id, connection_id, repository_id, repository_url, external_id,
          owner, name, default_branch, enabled, assignment_origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, 'default', ?, ?)
        ON CONFLICT(workspace_id, repository_id) DO NOTHING`,
        [
          `srb_migrated_${row.id}_${repository.id}`,
          row.workspace_id,
          row.id,
          repository.id,
          repository.url,
          coordinates.owner,
          repository.name || coordinates.name || "repository",
          repository.defaultBranch,
          now,
          now,
        ],
      );
    }
  }
}

interface ScmMigrationConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  base_url: string;
  repository_scope: string;
  is_default: number;
  created_at: string;
}

function scmConnectionOriginGroups(db: SqlDatabase): Map<string, ScmMigrationConnectionRow[]> {
  const rows = db.query(
    `SELECT id, workspace_id, provider, base_url, repository_scope, is_default, created_at
     FROM multiremi_scm_connections
     ORDER BY workspace_id, provider, created_at, id`,
  ).all() as ScmMigrationConnectionRow[];
  const groups = new Map<string, ScmMigrationConnectionRow[]>();
  for (const row of rows) {
    const origin = normalizeScmMigrationBaseUrl(row.base_url);
    const key = `${row.workspace_id}\u0000${row.provider}\u0000${origin}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function normalizeScmConnectionOrigins(db: SqlDatabase): void {
  for (const rows of scmConnectionOriginGroups(db).values()) {
    const defaultCandidates = rows.filter((row) => (
      Number(row.is_default) === 1 || row.repository_scope === "all"
    ));
    const winner = defaultCandidates[0] ?? null;

    // Demote duplicate defaults before normalizing URLs. An older deployment
    // may already have the partial unique index, and two path-shaped base URLs
    // can otherwise collide when both become the same origin.
    for (const row of rows) {
      if (winner && row.id === winner.id) {
        db.run(
          `UPDATE multiremi_scm_connections
           SET repository_scope = 'all', is_default = 1
           WHERE id = ? AND (repository_scope != 'all' OR is_default != 1)`,
          [row.id],
        );
        continue;
      }
      db.run(
        `UPDATE multiremi_scm_connections
         SET repository_scope = 'selected', is_default = 0
         WHERE id = ? AND (repository_scope != 'selected' OR is_default != 0)`,
        [row.id],
      );
      db.run(
        `UPDATE multiremi_scm_repository_bindings
         SET assignment_origin = 'explicit'
         WHERE connection_id = ? AND assignment_origin = 'default'`,
        [row.id],
      );
    }

    for (const row of rows) {
      const origin = normalizeScmMigrationBaseUrl(row.base_url);
      if (origin === row.base_url) continue;
      db.run("UPDATE multiremi_scm_connections SET base_url = ? WHERE id = ?", [origin, row.id]);
    }
  }
}

function normalizeScmMigrationBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(trimmed);
    return url.origin === "null" ? trimmed : url.origin;
  } catch {
    return trimmed;
  }
}

function parseScmMigrationRepositories(value: string | undefined): Array<{
  id: string;
  url: string;
  name: string | null;
  provider: "github" | "codebase" | "unknown";
  defaultBranch: string | null;
}> {
  let rows: unknown;
  try {
    rows = JSON.parse(value ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url) return [];
    const canonicalKey = scmMigrationCanonicalGitUrl(url);
    const source = row.source === "github" || row.source === "codebase" ? row.source : null;
    const host = scmRepositoryOrigin(url);
    const provider = source ?? (host === "github.com" ? "github" : host === "code.byted.org" ? "codebase" : "unknown");
    const coordinates = scmMigrationRepositoryCoordinates(url);
    return [{
      id: typeof row.id === "string" && row.id.trim()
        ? row.id.trim()
        : `repo_${createHash("sha256").update(canonicalKey).digest("hex").slice(0, 16)}`,
      url,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : coordinates.name,
      provider,
      defaultBranch: typeof (row.default_branch ?? row.defaultBranch) === "string"
        ? String(row.default_branch ?? row.defaultBranch).trim() || null
        : null,
    }];
  });
}

function scmRepositoryOrigin(value: string): string {
  const scpHost = value.trim().match(/^(?:ssh:\/\/)?[^@\s]+@([^:/\s]+)[:/]/u)?.[1];
  if (scpHost) return scpHost.toLowerCase();
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function scmMigrationCanonicalGitUrl(value: string): string {
  const coordinates = scmMigrationRepositoryCoordinates(value);
  return `${scmRepositoryOrigin(value)}/${coordinates.owner ?? ""}/${coordinates.name ?? ""}`.toLowerCase();
}

function scmMigrationRepositoryCoordinates(value: string): { owner: string | null; name: string | null } {
  const trimmed = value.trim();
  const scpPath = trimmed.match(/^(?:ssh:\/\/)?[^@\s]+@[^:/\s]+[:/](.+)$/u)?.[1];
  let path = scpPath ?? "";
  if (!path) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      path = trimmed;
    }
  }
  const parts = path.replace(/^\/+|\/+$/gu, "").split("/").filter(Boolean);
  if (!parts.length) return { owner: null, name: null };
  const name = parts.pop()!.replace(/\.git$/iu, "");
  return { owner: parts.join("/") || null, name: name || null };
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

function backfillBoundChatAgentChannels(db: SqlDatabase): void {
  db.run(
    `INSERT INTO multiremi_notification_channels (
       id, workspace_id, member_id, kind, name, enabled, target, event_types,
       min_severity, created_by, created_at, updated_at
     )
     SELECT
       'nch_agent_chat_' || chat.id,
       chat.workspace_id,
       (
         SELECT member.id
         FROM multiremi_workspace_members member
         WHERE member.workspace_id = chat.workspace_id AND member.user_id = chat.creator_id
         ORDER BY member.created_at ASC, member.id ASC
         LIMIT 1
       ),
       'agent_chat',
       chat.title || ' Issue updates',
       1,
       '{"chatId":"' || chat.id || '"}',
       '["*"]',
       'info',
       chat.creator_id,
       chat.created_at,
       chat.updated_at
     FROM multiremi_chat_sessions chat
     WHERE chat.issue_id IS NOT NULL
     ON CONFLICT(id) DO NOTHING`,
  );
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

// Daemon credentials represent machine trust and are revoked through daemon
// retirement, which also rotates SSH Mesh keys. Normalize only credentials
// that are still valid at migration time; expired or revoked credentials must
// never be revived by an upgrade.
function normalizeActiveDaemonTokenExpiry(db: SqlDatabase): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE multiremi_access_tokens
     SET expires_at = NULL
     WHERE type = 'daemon'
       AND daemon_id IS NOT NULL
       AND daemon_id != ''
       AND revoked_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at > ?`,
    [now],
  );
}

function backfillFeishuBotReplyDestinations(db: SqlDatabase): void {
  const rows = db.query(
    `SELECT id, external_session_key, chat_id, thread_id, reply_to_message_id
     FROM multiremi_feishu_bot_chat_bindings`,
  ).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const bindingId = String(row.id);
    const sessionKey = String(row.external_session_key ?? "");
    const threadMarker = ":thread:";
    const markerAt = sessionKey.indexOf(threadMarker);
    const parsedChatId = markerAt >= 0 ? sessionKey.slice(0, markerAt) : sessionKey.split(":closed:")[0];
    const parsedThreadId = markerAt >= 0
      ? sessionKey.slice(markerAt + threadMarker.length).split(":closed:")[0]
      : null;
    const latest = db.query(
      `SELECT COALESCE(reply_to_message_id, external_message_id) AS reply_to_message_id
       FROM multiremi_feishu_bot_deliveries
       WHERE binding_id = ?
       ORDER BY created_at DESC, external_message_id DESC
       LIMIT 1`,
    ).get(bindingId) as Record<string, unknown> | null;
    db.run(
      `UPDATE multiremi_feishu_bot_chat_bindings
       SET chat_id = COALESCE(chat_id, ?),
           thread_id = COALESCE(thread_id, ?),
           reply_to_message_id = COALESCE(reply_to_message_id, ?)
       WHERE id = ?`,
      [
        parsedChatId || null,
        parsedThreadId || null,
        stringOrNull(latest?.reply_to_message_id),
        bindingId,
      ],
    );
  }
}

function backfillSessionArchiveRetryBudget(db: SqlDatabase): void {
  const now = new Date();
  const nowIso = now.toISOString();
  const stallBefore = new Date(now.getTime() - resolveSessionArchiveUploadStallMs()).toISOString();
  const policy = resolveSessionArchiveRetryPolicy();
  const rows = db.query(
    `SELECT id, status, attempt_count, updated_at
     FROM multiremi_session_archives
     WHERE status = 'failed'
        OR (status = 'uploading' AND updated_at <= ?)`,
  ).all(stallBefore) as Array<{
    id: string;
    status: string;
    attempt_count: number;
    updated_at: string;
  }>;
  for (const row of rows) {
    const attemptCount = Number(row.attempt_count ?? 0);
    const exhausted = isSessionArchiveRetryExhausted(attemptCount, policy);
    const nextRetryAt = nextSessionArchiveRetryAt(row.id, attemptCount, policy, now);
    db.run(
      `UPDATE multiremi_session_archives
       SET status = 'failed',
           last_error = CASE
             WHEN status = 'uploading' THEN 'upload stalled'
             ELSE last_error
           END,
           next_retry_at = COALESCE(next_retry_at, ?),
           retry_exhausted_at = COALESCE(retry_exhausted_at, ?),
           updated_at = CASE WHEN status = 'uploading' THEN ? ELSE updated_at END,
           completed_at = NULL
       WHERE id = ?`,
      [nextRetryAt, exhausted ? nowIso : null, nowIso, row.id],
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
