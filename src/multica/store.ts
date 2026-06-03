import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.js";
import { createId, nowIso } from "./ids.js";
import type {
  AddSquadMemberInput,
  AssignIssueInput,
  AssignIssueResult,
  CreateAccessTokenInput,
  CreateAgentInput,
  CreateAutopilotInput,
  CreateAutopilotTriggerInput,
  CreateCloudRuntimeNodeInput,
  CreateChatSessionInput,
  CreateAttachmentInput,
  CreateFeedbackInput,
  CreateIssueDependencyInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  BatchDeleteIssuesInput,
  BatchUpdateIssuesInput,
  CreateLabelInput,
  CreatePinnedItemInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  CreateRuntimeUpdateInput,
  CreateRuntimeLocalSkillImportInput,
  CreateSkillInput,
  CreateSquadInput,
  CreateTaskInput,
  CreateWorkspaceInvitationInput,
  CreateWorkspaceInput,
  CreateWorkspaceMemberInput,
  MulticaAutopilot,
  MulticaAutopilotRun,
  MulticaAutopilotTrigger,
  MulticaWebhookDelivery,
  MulticaWebhookDeliveryResult,
  MulticaWebhookDeliveryStatus,
  MulticaWebhookProvider,
  MulticaWebhookSignatureStatus,
  MulticaAccessToken,
  MulticaCreatedAccessToken,
  MulticaAccessTokenType,
  MulticaAgent,
  MulticaAgentActivityBucket,
  MulticaAgentRunCount,
  MulticaAssigneeType,
  MulticaAssigneeFrequencyEntry,
  MulticaAttachment,
  MulticaChatMessage,
  MulticaChatSession,
  MulticaCloudRuntimeNode,
  MulticaCommentReaction,
  MulticaDaemonHeartbeatAck,
  MulticaInboxItem,
  MulticaIssueActivity,
  MulticaIssueChildProgress,
  MulticaIssueComment,
  MulticaIssueDependency,
  MulticaIssueDependencyType,
  MulticaIssue,
  MulticaIssueAssigneeGroup,
  MulticaIssuePriority,
  MulticaIssueSearchResult,
  MulticaGitHubChecksConclusion,
  MulticaFeedback,
  MulticaGitHubPullRequest,
  MulticaGitHubPullRequestState,
  MulticaGitHubSettings,
  MulticaLabel,
  MulticaNotificationGroupKey,
  MulticaNotificationPreferences,
  MulticaNotificationPreferenceResponse,
  MulticaPinnedItem,
  MulticaPinnedItemType,
  MulticaIssueReaction,
  MulticaIssueSubscriber,
  MulticaIssueWithTasks,
  ListIssuesInput,
  MulticaProject,
  MulticaProjectResource,
  MulticaProjectSearchResult,
  MulticaRuntimeLocalSkillImportRequest,
  MulticaRuntimeLocalSkillListRequest,
  MulticaRuntimeLocalSkillRequestStatus,
  MulticaRuntimeLocalSkillSummary,
  MulticaRuntimeModelListRequest,
  MulticaRuntimeModelListRequestStatus,
  MulticaRuntimeUpdateRequest,
  MulticaRuntimeUpdateRequestStatus,
  QuickCreateIssueInput,
  ReportRuntimeModelListInput,
  QuickCreateIssueResult,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
  ReportRuntimeUpdateInput,
  MulticaRuntime,
  MulticaRuntimeDaily,
  MulticaRuntimeModel,
  MulticaRuntimeVisibility,
  MulticaRuntimeUsage,
  MulticaSkill,
  MulticaSkillFile,
  MulticaSquad,
  MulticaSquadMember,
  MulticaTask,
  MulticaTaskActivityByHour,
  MulticaTaskMessage,
  MulticaTaskStatus,
  MulticaTaskWithAgent,
  MulticaTimelineEntry,
  MulticaSubscriptionReason,
  MulticaUsageByAgent,
  MulticaUsageByHour,
  MulticaUsageDaily,
  MulticaUser,
  MulticaWorkspace,
  MulticaWorkspaceInvitation,
  MulticaWorkspaceMember,
  RegisterRuntimeInput,
  ReorderPinnedItemInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  SendChatMessageResult,
  SetAgentSkillsInput,
  TaskMessageInput,
  TaskUsageEntry,
  UpdateAgentInput,
  UpdateAutopilotInput,
  UpdateAutopilotTriggerInput,
  UpdateChatSessionInput,
  UpdateIssueInput,
  UpdateIssueCommentInput,
  UpdateLabelInput,
  UpdateMulticaUserInput,
  UpdateProjectInput,
  UpdateRuntimeInput,
  UpdateSkillInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "./types.js";

const TERMINAL_STATUSES: MulticaTaskStatus[] = ["completed", "failed", "cancelled"];
const RUNTIME_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const MAX_ISSUE_METADATA_KEYS = 50;
const ISSUE_METADATA_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
const FEEDBACK_MAX_MESSAGE_LENGTH = 10_000;
const FEEDBACK_HOURLY_RATE_LIMIT = 10;

export class MulticaStore {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDb();
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS multica_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        skills TEXT NOT NULL DEFAULT '[]',
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

      CREATE TABLE IF NOT EXISTS multica_skills (
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

      CREATE TABLE IF NOT EXISTS multica_skill_files (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(skill_id, path),
        FOREIGN KEY(skill_id) REFERENCES multica_skills(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS multica_agent_skills (
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(agent_id, skill_id),
        FOREIGN KEY(agent_id) REFERENCES multica_agents(id) ON DELETE CASCADE,
        FOREIGN KEY(skill_id) REFERENCES multica_skills(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_skills_workspace ON multica_skills(workspace_id, archived_at);
      CREATE INDEX IF NOT EXISTS idx_multica_skill_files_skill ON multica_skill_files(skill_id);
      CREATE INDEX IF NOT EXISTS idx_multica_agent_skills_agent ON multica_agent_skills(agent_id);
      CREATE INDEX IF NOT EXISTS idx_multica_agent_skills_skill ON multica_agent_skills(skill_id);

      CREATE TABLE IF NOT EXISTS multica_runtimes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        workspace_id TEXT,
        owner_id TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        status TEXT NOT NULL DEFAULT 'online',
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS multica_cloud_runtime_nodes (
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

      CREATE INDEX IF NOT EXISTS idx_multica_cloud_runtime_nodes_owner
        ON multica_cloud_runtime_nodes(owner_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_runtime_models (
        runtime_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        label TEXT NOT NULL,
        provider TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        thinking TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(runtime_id, model_id),
        FOREIGN KEY(runtime_id) REFERENCES multica_runtimes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_runtime_models_runtime ON multica_runtime_models(runtime_id, is_default);

      CREATE TABLE IF NOT EXISTS multica_runtime_model_list_requests (
        id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        models TEXT NOT NULL DEFAULT '[]',
        supported INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        run_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(runtime_id) REFERENCES multica_runtimes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_runtime_model_list_runtime ON multica_runtime_model_list_requests(runtime_id, status, created_at);

      CREATE TABLE IF NOT EXISTS multica_runtime_update_requests (
        id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        target_version TEXT NOT NULL,
        output TEXT,
        error TEXT,
        run_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(runtime_id) REFERENCES multica_runtimes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_runtime_update_runtime ON multica_runtime_update_requests(runtime_id, status, created_at);

      CREATE TABLE IF NOT EXISTS multica_runtime_local_skill_list_requests (
        id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        skills TEXT NOT NULL DEFAULT '[]',
        supported INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        run_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(runtime_id) REFERENCES multica_runtimes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_runtime_local_skill_list_runtime ON multica_runtime_local_skill_list_requests(runtime_id, status, created_at);

      CREATE TABLE IF NOT EXISTS multica_runtime_local_skill_import_requests (
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
        FOREIGN KEY(runtime_id) REFERENCES multica_runtimes(id) ON DELETE CASCADE,
        FOREIGN KEY(skill_id) REFERENCES multica_skills(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_runtime_local_skill_import_runtime ON multica_runtime_local_skill_import_requests(runtime_id, status, created_at);

      CREATE TABLE IF NOT EXISTS multica_users (
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

      CREATE TABLE IF NOT EXISTS multica_workspaces (
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

      CREATE TABLE IF NOT EXISTS multica_workspace_invitations (
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

      CREATE INDEX IF NOT EXISTS idx_multica_workspace_invitations_workspace ON multica_workspace_invitations(workspace_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_multica_workspace_invitations_invitee ON multica_workspace_invitations(invitee_email, invitee_user_id, status);

      CREATE TABLE IF NOT EXISTS multica_workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_workspace_members_workspace ON multica_workspace_members(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_access_tokens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'pat',
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_access_tokens_workspace ON multica_access_tokens(workspace_id, type);
      CREATE INDEX IF NOT EXISTS idx_multica_access_tokens_hash ON multica_access_tokens(token_hash);

      CREATE TABLE IF NOT EXISTS multica_notification_preferences (
        workspace_id TEXT NOT NULL DEFAULT 'local',
        member_id TEXT NOT NULL DEFAULT '',
        preferences TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS multica_feedback (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        user_id TEXT NOT NULL DEFAULT 'local',
        member_id TEXT,
        message TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_feedback_user_created ON multica_feedback(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_multica_feedback_workspace_created ON multica_feedback(workspace_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_github_settings (
        workspace_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        pr_sidebar INTEGER NOT NULL DEFAULT 1,
        co_author INTEGER NOT NULL DEFAULT 1,
        auto_link_prs INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS multica_github_pull_requests (
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

      CREATE INDEX IF NOT EXISTS idx_multica_github_prs_issue ON multica_github_pull_requests(issue_id, pr_updated_at);
      CREATE INDEX IF NOT EXISTS idx_multica_github_prs_workspace ON multica_github_pull_requests(workspace_id, pr_updated_at);

      CREATE TABLE IF NOT EXISTS multica_issues (
        id TEXT PRIMARY KEY,
        issue_number INTEGER NOT NULL DEFAULT 0,
        issue_key TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open',
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
        FOREIGN KEY(parent_issue_id) REFERENCES multica_issues(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS multica_issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        author_type TEXT NOT NULL DEFAULT 'member',
        author_id TEXT,
        parent_id TEXT,
        body TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by_type TEXT,
        resolved_by_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_id) REFERENCES multica_issue_comments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_comments_issue ON multica_issue_comments(issue_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_issue_activity (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        type TEXT NOT NULL,
        body TEXT,
        data TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_activity_issue ON multica_issue_activity(issue_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_issue_dependencies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT NOT NULL,
        depends_on_issue_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, depends_on_issue_id, type),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(depends_on_issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_dependencies_issue ON multica_issue_dependencies(issue_id, type);
      CREATE INDEX IF NOT EXISTS idx_multica_issue_dependencies_depends_on ON multica_issue_dependencies(depends_on_issue_id, type);
      CREATE INDEX IF NOT EXISTS idx_multica_issue_dependencies_workspace ON multica_issue_dependencies(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_issue_subscribers (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, member_id),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(member_id) REFERENCES multica_workspace_members(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_subscribers_issue ON multica_issue_subscribers(issue_id);
      CREATE INDEX IF NOT EXISTS idx_multica_issue_subscribers_member ON multica_issue_subscribers(member_id);

      CREATE TABLE IF NOT EXISTS multica_inbox_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(member_id) REFERENCES multica_workspace_members(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_inbox_member ON multica_inbox_items(member_id, archived, read, created_at);

      CREATE TABLE IF NOT EXISTS multica_issue_labels (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_multica_issue_labels_workspace_name
        ON multica_issue_labels(workspace_id, lower(name));
      CREATE INDEX IF NOT EXISTS idx_multica_issue_labels_workspace
        ON multica_issue_labels(workspace_id, name);

      CREATE TABLE IF NOT EXISTS multica_issue_to_labels (
        issue_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY(issue_id, label_id),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(label_id) REFERENCES multica_issue_labels(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_to_labels_label ON multica_issue_to_labels(label_id);

      CREATE TABLE IF NOT EXISTS multica_issue_reactions (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(issue_id, actor_type, actor_id, emoji),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_issue_reactions_issue ON multica_issue_reactions(issue_id);

      CREATE TABLE IF NOT EXISTS multica_comment_reactions (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(comment_id, actor_type, actor_id, emoji),
        FOREIGN KEY(comment_id) REFERENCES multica_issue_comments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_comment_reactions_comment ON multica_comment_reactions(comment_id);

      CREATE TABLE IF NOT EXISTS multica_attachments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT,
        comment_id TEXT,
        uploader_type TEXT NOT NULL DEFAULT 'member',
        uploader_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        url TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id) ON DELETE CASCADE,
        FOREIGN KEY(comment_id) REFERENCES multica_issue_comments(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_attachments_issue ON multica_attachments(issue_id);
      CREATE INDEX IF NOT EXISTS idx_multica_attachments_comment ON multica_attachments(comment_id);
      CREATE INDEX IF NOT EXISTS idx_multica_attachments_workspace ON multica_attachments(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_projects (
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

      CREATE INDEX IF NOT EXISTS idx_multica_projects_workspace ON multica_projects(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_project_resources (
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
        FOREIGN KEY(project_id) REFERENCES multica_projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_project_resources_project ON multica_project_resources(project_id, position);

      CREATE TABLE IF NOT EXISTS multica_pinned_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        user_id TEXT NOT NULL DEFAULT 'local',
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        position REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, user_id, item_type, item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_pinned_items_user_ws
        ON multica_pinned_items(workspace_id, user_id, position, created_at);

      CREATE TABLE IF NOT EXISTS multica_squads (
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

      CREATE INDEX IF NOT EXISTS idx_multica_squads_workspace ON multica_squads(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_squad_members (
        id TEXT PRIMARY KEY,
        squad_id TEXT NOT NULL,
        member_type TEXT NOT NULL,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        UNIQUE(squad_id, member_type, member_id),
        FOREIGN KEY(squad_id) REFERENCES multica_squads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_squad_members_squad ON multica_squad_members(squad_id);

      CREATE TABLE IF NOT EXISTS multica_autopilots (
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
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES multica_projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_autopilots_workspace ON multica_autopilots(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_multica_autopilots_assignee ON multica_autopilots(assignee_type, assignee_id);

      CREATE TABLE IF NOT EXISTS multica_autopilot_triggers (
        id TEXT PRIMARY KEY,
        autopilot_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'webhook',
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT,
        timezone TEXT,
        next_run_at TEXT,
        webhook_token TEXT UNIQUE,
        webhook_url TEXT,
        label TEXT,
        signing_secret_hash TEXT,
        last_fired_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(autopilot_id) REFERENCES multica_autopilots(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_autopilot_triggers_autopilot
        ON multica_autopilot_triggers(autopilot_id, enabled, kind);
      CREATE INDEX IF NOT EXISTS idx_multica_autopilot_triggers_token
        ON multica_autopilot_triggers(webhook_token);

      CREATE TABLE IF NOT EXISTS multica_autopilot_runs (
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
        FOREIGN KEY(autopilot_id) REFERENCES multica_autopilots(id) ON DELETE CASCADE,
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id),
        FOREIGN KEY(task_id) REFERENCES multica_tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_autopilot_runs_autopilot ON multica_autopilot_runs(autopilot_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_webhook_deliveries (
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
        FOREIGN KEY(autopilot_id) REFERENCES multica_autopilots(id) ON DELETE CASCADE,
        FOREIGN KEY(autopilot_run_id) REFERENCES multica_autopilot_runs(id) ON DELETE SET NULL,
        FOREIGN KEY(replayed_from_delivery_id) REFERENCES multica_webhook_deliveries(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_webhook_deliveries_autopilot
        ON multica_webhook_deliveries(autopilot_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_multica_webhook_deliveries_run
        ON multica_webhook_deliveries(autopilot_run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_multica_webhook_deliveries_dedupe
        ON multica_webhook_deliveries(trigger_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status NOT IN ('rejected', 'failed');

      CREATE TABLE IF NOT EXISTS multica_chat_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        session_id TEXT,
        work_dir TEXT,
        latest_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(agent_id) REFERENCES multica_agents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_multica_chat_sessions_workspace ON multica_chat_sessions(workspace_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_multica_chat_sessions_agent ON multica_chat_sessions(agent_id);

      CREATE TABLE IF NOT EXISTS multica_chat_messages (
        id TEXT PRIMARY KEY,
        chat_session_id TEXT NOT NULL,
        task_id TEXT,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_session_id) REFERENCES multica_chat_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES multica_tasks(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_chat_messages_session ON multica_chat_messages(chat_session_id, created_at);

      CREATE TABLE IF NOT EXISTS multica_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        runtime_id TEXT,
        issue_id TEXT,
        chat_session_id TEXT,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        result TEXT,
        error TEXT,
        branch_name TEXT,
        session_id TEXT,
        work_dir TEXT,
        progress_summary TEXT,
        progress_step INTEGER,
        progress_total INTEGER,
        usage TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatched_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY(agent_id) REFERENCES multica_agents(id),
        FOREIGN KEY(issue_id) REFERENCES multica_issues(id),
        FOREIGN KEY(chat_session_id) REFERENCES multica_chat_sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_multica_tasks_status ON multica_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_multica_tasks_runtime ON multica_tasks(runtime_id);
      CREATE INDEX IF NOT EXISTS idx_multica_tasks_issue ON multica_tasks(issue_id);
      CREATE INDEX IF NOT EXISTS idx_multica_tasks_workspace ON multica_tasks(workspace_id);

      CREATE TABLE IF NOT EXISTS multica_task_messages (
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
        FOREIGN KEY(task_id) REFERENCES multica_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_multica_messages_task ON multica_task_messages(task_id, seq);
    `);
    this.addColumnIfMissing("multica_agents", "archived_at TEXT");
    this.addColumnIfMissing("multica_runtimes", "owner_id TEXT");
    this.addColumnIfMissing("multica_runtimes", "visibility TEXT NOT NULL DEFAULT 'private'");
    this.addColumnIfMissing("multica_issues", "assignee_type TEXT");
    this.addColumnIfMissing("multica_issues", "assignee_id TEXT");
    this.addColumnIfMissing("multica_issues", "metadata TEXT NOT NULL DEFAULT '{}'");
    this.addColumnIfMissing("multica_issues", "issue_number INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("multica_issues", "issue_key TEXT");
    this.addColumnIfMissing("multica_issues", "priority TEXT NOT NULL DEFAULT 'none'");
    this.addColumnIfMissing("multica_issues", "parent_issue_id TEXT");
    this.addColumnIfMissing("multica_issues", "position REAL NOT NULL DEFAULT 0");
    this.addColumnIfMissing("multica_issues", "start_date TEXT");
    this.addColumnIfMissing("multica_issues", "due_date TEXT");
    this.addColumnIfMissing("multica_issues", "acceptance_criteria TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("multica_issues", "context_refs TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("multica_issue_comments", "parent_id TEXT");
    this.addColumnIfMissing("multica_issue_comments", "resolved_at TEXT");
    this.addColumnIfMissing("multica_issue_comments", "resolved_by_type TEXT");
    this.addColumnIfMissing("multica_issue_comments", "resolved_by_id TEXT");
    this.addColumnIfMissing("multica_tasks", "chat_session_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issues_parent ON multica_issues(parent_issue_id, position, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issues_scheduled ON multica_issues(workspace_id, start_date, due_date)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issue_comments_parent ON multica_issue_comments(parent_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_multica_issue_comments_resolved ON multica_issue_comments(issue_id, resolved_at)");
    this.backfillIssueKeys();
  }

  createAgent(input: CreateAgentInput): MulticaAgent {
    const id = input.id ?? createId("agt");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_agents (
        id, name, provider, instructions, skills, cwd, executable, model,
        allowed_tools, custom_env, custom_args, mcp_config, thinking_level,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.provider,
        input.instructions ?? "",
        toJson(input.skills ?? []),
        input.cwd ?? null,
        input.executable ?? null,
        input.model ?? null,
        toJson(input.allowedTools ?? []),
        toJson(input.customEnv ?? {}),
        toJson(input.customArgs ?? []),
        input.mcpConfig == null ? null : toJson(input.mcpConfig),
        input.thinkingLevel ?? null,
        now,
        now,
      ],
    );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, input: UpdateAgentInput): MulticaAgent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_agents SET
        name = ?,
        provider = ?,
        instructions = ?,
        skills = ?,
        cwd = ?,
        executable = ?,
        model = ?,
        allowed_tools = ?,
        custom_env = ?,
        custom_args = ?,
        mcp_config = ?,
        thinking_level = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        input.provider ?? current.provider,
        input.instructions ?? current.instructions,
        input.skills === undefined ? toJson(current.skills) : toJson(input.skills),
        input.cwd === undefined ? current.cwd : input.cwd,
        input.executable === undefined ? current.executable : input.executable,
        input.model === undefined ? current.model : input.model,
        input.allowedTools === undefined ? toJson(current.allowedTools) : toJson(input.allowedTools),
        input.customEnv === undefined ? toJson(current.customEnv) : toJson(input.customEnv),
        input.customArgs === undefined ? toJson(current.customArgs) : toJson(input.customArgs),
        input.mcpConfig === undefined ? current.mcpConfig == null ? null : toJson(current.mcpConfig) : input.mcpConfig == null ? null : toJson(input.mcpConfig),
        input.thinkingLevel === undefined ? current.thinkingLevel : input.thinkingLevel,
        now,
        id,
      ],
    );
    return this.getAgent(id)!;
  }

  archiveAgent(id: string): MulticaAgent {
    if (!this.getAgent(id)) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_agents SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getAgent(id)!;
  }

  restoreAgent(id: string): MulticaAgent {
    const row = this.db.query("SELECT id FROM multica_agents WHERE id = ?").get(id) as Row | null;
    if (!row) throw new Error(`Agent not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_agents SET archived_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
    return this.getAgent(id)!;
  }

  cancelAgentTasks(agentId: string): number {
    if (!this.db.query("SELECT id FROM multica_agents WHERE id = ?").get(agentId)) throw new Error(`Agent not found: ${agentId}`);
    let cancelled = 0;
    for (const task of this.listAgentTasks(agentId)) {
      if (task.status === "queued" || task.status === "dispatched" || task.status === "running") {
        this.cancelTask(task.id);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  createSkill(input: CreateSkillInput): MulticaSkill {
    const name = input.name?.trim();
    if (!name) throw new Error("Skill name is required");
    const id = input.id ?? createId("skl");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const now = nowIso();
    const files = normalizeSkillFiles(input.files ?? []);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO multica_skills (
          id, workspace_id, name, description, content, config, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspaceId,
          name,
          input.description ?? "",
          input.content ?? "",
          toJson(input.config ?? {}),
          input.createdBy ?? input.created_by ?? null,
          now,
          now,
        ],
      );
      this.replaceSkillFiles(id, files, now);
    })();
    return this.getSkill(id)!;
  }

  updateSkill(id: string, input: UpdateSkillInput): MulticaSkill {
    const current = this.getSkill(id);
    if (!current) throw new Error(`Skill not found: ${id}`);
    const now = nowIso();
    const nextName = input.name === undefined ? current.name : input.name.trim();
    if (!nextName) throw new Error("Skill name is required");
    this.db.transaction(() => {
      this.db.run(
        `UPDATE multica_skills SET
          workspace_id = ?,
          name = ?,
          description = ?,
          content = ?,
          config = ?,
          created_by = ?,
          updated_at = ?
         WHERE id = ?`,
        [
          input.workspaceId ?? input.workspace_id ?? current.workspaceId ?? "local",
          nextName,
          input.description ?? current.description ?? "",
          input.content ?? current.content ?? "",
          input.config === undefined ? toJson(current.config ?? {}) : toJson(input.config ?? {}),
          input.createdBy ?? input.created_by ?? current.createdBy ?? null,
          now,
          id,
        ],
      );
      if (input.files !== undefined) this.replaceSkillFiles(id, normalizeSkillFiles(input.files), now);
    })();
    return this.getSkill(id)!;
  }

  archiveSkill(id: string): MulticaSkill {
    const current = this.getSkill(id);
    if (!current) throw new Error(`Skill not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_skills SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getSkill(id)!;
  }

  listSkills(workspaceId?: string | null, options: { includeArchived?: boolean; includeFiles?: boolean } = {}): MulticaSkill[] {
    const archivedFilter = options.includeArchived ? "" : " AND archived_at IS NULL";
    const rows = workspaceId
      ? this.db.query(`SELECT * FROM multica_skills WHERE workspace_id = ?${archivedFilter} ORDER BY created_at DESC`).all(workspaceId) as Row[]
      : this.db.query(`SELECT * FROM multica_skills WHERE 1 = 1${archivedFilter} ORDER BY created_at DESC`).all() as Row[];
    return rows.map((row) => toSkill(row, options.includeFiles ? this.listSkillFiles(String(row.id)) : []));
  }

  getSkill(id: string, options: { includeArchived?: boolean; includeFiles?: boolean } = { includeFiles: true }): MulticaSkill | null {
    const row = this.db.query(
      `SELECT * FROM multica_skills WHERE id = ?${options.includeArchived ? "" : " AND archived_at IS NULL"}`,
    ).get(id) as Row | null;
    return row ? toSkill(row, options.includeFiles === false ? [] : this.listSkillFiles(id)) : null;
  }

  listSkillFiles(skillId: string): MulticaSkillFile[] {
    if (!this.db.query("SELECT id FROM multica_skills WHERE id = ? AND archived_at IS NULL").get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const rows = this.db.query("SELECT * FROM multica_skill_files WHERE skill_id = ? ORDER BY path ASC").all(skillId) as Row[];
    return rows.map(toSkillFile);
  }

  upsertSkillFile(skillId: string, file: MulticaSkillFile): MulticaSkillFile {
    if (!this.db.query("SELECT id FROM multica_skills WHERE id = ? AND archived_at IS NULL").get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const normalized = normalizeSkillFiles([file])[0]!;
    const existing = this.db.query(
      "SELECT * FROM multica_skill_files WHERE skill_id = ? AND path = ?",
    ).get(skillId, normalized.path) as Row | null;
    const id = existing ? String(existing.id) : file.id ?? createId("skf");
    const createdAt = existing ? String(existing.created_at) : nowIso();
    const updatedAt = nowIso();
    this.db.run(
      `INSERT INTO multica_skill_files (id, skill_id, path, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      [id, skillId, normalized.path, normalized.content, createdAt, updatedAt],
    );
    const row = this.db.query("SELECT * FROM multica_skill_files WHERE skill_id = ? AND path = ?")
      .get(skillId, normalized.path) as Row | null;
    return toSkillFile(row!);
  }

  deleteSkillFile(skillId: string, fileId: string): boolean {
    if (!this.db.query("SELECT id FROM multica_skills WHERE id = ? AND archived_at IS NULL").get(skillId)) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const result = this.db.run("DELETE FROM multica_skill_files WHERE skill_id = ? AND id = ?", [skillId, fileId]);
    return result.changes > 0;
  }

  listAgentSkills(agentId: string, options: { includeFiles?: boolean } = { includeFiles: true }): MulticaSkill[] {
    const row = this.db.query("SELECT * FROM multica_agents WHERE id = ?").get(agentId) as Row | null;
    if (!row) throw new Error(`Agent not found: ${agentId}`);
    const agent = toAgent(row);
    const rows = this.db.query(
      `SELECT s.*
       FROM multica_skills s
       JOIN multica_agent_skills aks ON aks.skill_id = s.id
       WHERE aks.agent_id = ? AND s.archived_at IS NULL
       ORDER BY aks.created_at ASC, s.name ASC`,
    ).all(agentId) as Row[];
    const structured = rows.map((row) => toSkill(row, options.includeFiles === false ? [] : this.listSkillFiles(String(row.id))));
    return mergeAgentSkills(agent.skills, structured);
  }

  setAgentSkills(agentId: string, input: SetAgentSkillsInput | string[]): MulticaSkill[] {
    if (!this.db.query("SELECT id FROM multica_agents WHERE id = ?").get(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const skillIds = Array.isArray(input) ? input : input.skillIds ?? input.skill_ids ?? [];
    const now = nowIso();
    this.db.transaction(() => {
      this.db.run("DELETE FROM multica_agent_skills WHERE agent_id = ?", [agentId]);
      for (const skillId of skillIds) {
        const skill = this.getSkill(skillId);
        if (!skill) throw new Error(`Skill not found: ${skillId}`);
        this.db.run(
          "INSERT OR IGNORE INTO multica_agent_skills (agent_id, skill_id, created_at) VALUES (?, ?, ?)",
          [agentId, skillId, now],
        );
      }
    })();
    return this.listAgentSkills(agentId);
  }

  ensureDefaultAgent(provider = "claude"): MulticaAgent {
    const id = `agt_default_${provider}`;
    const existing = this.getAgent(id);
    if (existing) {
      if (existing.archivedAt) {
        const now = nowIso();
        this.db.run("UPDATE multica_agents SET archived_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
        return this.getAgent(id)!;
      }
      return existing;
    }
    return this.createAgent({
      id,
      name: provider === "codex" ? "Codex" : "Claude",
      provider,
      instructions: "You are an autonomous coding agent. Complete the task and report the result clearly.",
    });
  }

  getAgent(id: string): MulticaAgent | null {
    const row = this.db.query("SELECT * FROM multica_agents WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateAgent(toAgent(row)) : null;
  }

  listAgents(): MulticaAgent[] {
    const rows = this.db.query("SELECT * FROM multica_agents WHERE archived_at IS NULL ORDER BY created_at ASC").all() as Row[];
    return rows.map((row) => this.hydrateAgent(toAgent(row)));
  }

  private hydrateAgent(agent: MulticaAgent): MulticaAgent {
    return {
      ...agent,
      skills: this.listAgentSkillsForExistingAgent(agent),
    };
  }

  private listAgentSkillsForExistingAgent(agent: MulticaAgent): MulticaSkill[] {
    const rows = this.db.query(
      `SELECT s.*
       FROM multica_skills s
       JOIN multica_agent_skills aks ON aks.skill_id = s.id
       WHERE aks.agent_id = ? AND s.archived_at IS NULL
       ORDER BY aks.created_at ASC, s.name ASC`,
    ).all(agent.id) as Row[];
    const structured = rows.map((row) => toSkill(row, this.listSkillFiles(String(row.id))));
    return mergeAgentSkills(agent.skills, structured);
  }

  private replaceSkillFiles(skillId: string, files: MulticaSkillFile[], now = nowIso()): void {
    this.db.run("DELETE FROM multica_skill_files WHERE skill_id = ?", [skillId]);
    for (const file of files) {
      this.db.run(
        `INSERT INTO multica_skill_files (
          id, skill_id, path, content, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [file.id ?? createId("skf"), skillId, file.path, file.content, now, now],
      );
    }
  }

  createWorkspaceMember(input: CreateWorkspaceMemberInput): MulticaWorkspaceMember {
    if (!input.name?.trim()) throw new Error("Member name is required");
    const id = input.id ?? createId("mem");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_workspace_members (
        id, workspace_id, name, email, role, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.workspaceId ?? "local",
        input.name.trim(),
        input.email ?? null,
        input.role ?? "member",
        now,
        now,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  getWorkspaceMember(id: string): MulticaWorkspaceMember | null {
    const row = this.db.query("SELECT * FROM multica_workspace_members WHERE id = ?").get(id) as Row | null;
    return row ? toWorkspaceMember(row) : null;
  }

  listWorkspaceMembers(workspaceId?: string | null): MulticaWorkspaceMember[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_workspace_members WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_workspace_members WHERE archived_at IS NULL ORDER BY workspace_id ASC, name ASC").all() as Row[];
    return rows.map(toWorkspaceMember);
  }

  updateWorkspaceMember(id: string, input: UpdateWorkspaceMemberInput): MulticaWorkspaceMember {
    const current = this.getWorkspaceMember(id);
    if (!current) throw new Error(`Member not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_workspace_members SET
        workspace_id = ?,
        name = ?,
        email = ?,
        role = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.workspaceId ?? current.workspaceId,
        input.name ?? current.name,
        input.email === undefined ? current.email : input.email,
        input.role ?? current.role,
        now,
        id,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  archiveWorkspaceMember(id: string): MulticaWorkspaceMember {
    if (!this.getWorkspaceMember(id)) throw new Error(`Member not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_workspace_members SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getWorkspaceMember(id)!;
  }

  getCurrentUser(): MulticaUser {
    const existing = this.getUser("local");
    if (existing) return existing;
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_users (
        id, name, email, avatar_url, language, timezone, onboarded_at,
        onboarding_questionnaire, starter_content_state, profile_description,
        created_at, updated_at
      ) VALUES ('local', 'Local User', 'local@multica.local', NULL, NULL, NULL, NULL, '{}', NULL, '', ?, ?)`,
      [now, now],
    );
    return this.getUser("local")!;
  }

  getUser(id: string): MulticaUser | null {
    const row = this.db.query("SELECT * FROM multica_users WHERE id = ?").get(id) as Row | null;
    return row ? toUser(row) : null;
  }

  updateCurrentUser(input: UpdateMulticaUserInput): MulticaUser {
    const current = this.getCurrentUser();
    const name = input.name === undefined ? current.name : String(input.name).trim();
    if (!name) throw new Error("name is required");
    const email = input.email === undefined ? current.email : normalizeEmail(input.email);
    const language = hasAnyField(input, "language")
      ? normalizeOptionalLanguage(input.language)
      : current.language;
    const timezone = hasAnyField(input, "timezone")
      ? normalizeOptionalTimezone(input.timezone)
      : current.timezone;
    const profileDescription = hasAnyField(input, "profileDescription", "profile_description")
      ? String(input.profileDescription ?? input.profile_description ?? "").trim()
      : current.profileDescription;
    if ([...profileDescription].length > 2000) throw new Error("profile_description exceeds 2000 characters");
    const onboardingQuestionnaire = input.onboardingQuestionnaire ?? input.onboarding_questionnaire ?? current.onboardingQuestionnaire;
    const starterContentState = hasAnyField(input, "starterContentState", "starter_content_state")
      ? cleanOptionalString(input.starterContentState ?? input.starter_content_state)
      : current.starterContentState;
    const avatarUrl = hasAnyField(input, "avatarUrl", "avatar_url")
      ? cleanOptionalString(input.avatarUrl ?? input.avatar_url)
      : current.avatarUrl;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_users SET
        name = ?,
        email = ?,
        avatar_url = ?,
        language = ?,
        timezone = ?,
        onboarding_questionnaire = ?,
        starter_content_state = ?,
        profile_description = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        name,
        email,
        avatarUrl,
        language,
        timezone,
        toJson(onboardingQuestionnaire ?? {}),
        starterContentState,
        profileDescription,
        now,
        current.id,
      ],
    );
    return this.getUser(current.id)!;
  }

  patchCurrentUserOnboarding(questionnaire: Record<string, unknown>): MulticaUser {
    return this.updateCurrentUser({ onboardingQuestionnaire: questionnaire });
  }

  markCurrentUserOnboarded(): MulticaUser {
    const current = this.getCurrentUser();
    const now = nowIso();
    this.db.run(
      "UPDATE multica_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?",
      [now, now, current.id],
    );
    return this.getUser(current.id)!;
  }

  listWorkspaces(): MulticaWorkspace[] {
    const rows = this.db.query("SELECT * FROM multica_workspaces ORDER BY created_at ASC").all() as Row[];
    if (!rows.length) return [this.ensureLocalWorkspace()];
    return rows.map(toWorkspace);
  }

  getWorkspace(id: string): MulticaWorkspace | null {
    const row = this.db.query("SELECT * FROM multica_workspaces WHERE id = ?").get(id) as Row | null;
    return row ? toWorkspace(row) : null;
  }

  createWorkspace(input: CreateWorkspaceInput): MulticaWorkspace {
    const name = String(input.name ?? "").trim();
    const slug = normalizeWorkspaceSlug(input.slug ?? slugifyWorkspaceName(name));
    if (!name || !slug) throw new Error("name and slug are required");
    const id = input.id ?? (slug === "local" ? "local" : createId("ws"));
    const now = nowIso();
    const issuePrefix = String(input.issuePrefix ?? input.issue_prefix ?? generateIssuePrefix(name)).trim().toUpperCase() || "MUL";
    this.db.run(
      `INSERT INTO multica_workspaces (
        id, name, slug, description, context, settings, repos, issue_prefix, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        slug,
        input.description ?? null,
        input.context ?? null,
        toJson(input.settings ?? {}),
        toJson(input.repos ?? []),
        issuePrefix,
        now,
        now,
      ],
    );
    const user = this.getCurrentUser();
    const memberId = `mem_${id}_${user.id}`;
    if (!this.getWorkspaceMember(memberId)) {
      this.createWorkspaceMember({
        id: memberId,
        workspaceId: id,
        name: user.name,
        email: user.email,
        role: "owner",
      });
    }
    this.markCurrentUserOnboarded();
    return this.getWorkspace(id)!;
  }

  updateWorkspace(id: string, input: Partial<CreateWorkspaceInput>): MulticaWorkspace {
    const current = this.getWorkspace(id);
    if (!current) throw new Error(`Workspace not found: ${id}`);
    const nextName = input.name === undefined ? current.name : String(input.name ?? "").trim();
    if (!nextName) throw new Error("name is required");
    const nextSlug = input.slug === undefined ? current.slug : normalizeWorkspaceSlug(input.slug);
    const issuePrefix = input.issuePrefix ?? input.issue_prefix ?? current.issuePrefix;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_workspaces SET
        name = ?,
        slug = ?,
        description = ?,
        context = ?,
        settings = ?,
        repos = ?,
        issue_prefix = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        nextName,
        nextSlug,
        input.description === undefined ? current.description : input.description,
        input.context === undefined ? current.context : input.context,
        input.settings === undefined ? toJson(current.settings) : toJson(input.settings),
        input.repos === undefined ? toJson(current.repos) : toJson(input.repos),
        String(issuePrefix ?? "MUL").trim().toUpperCase() || "MUL",
        now,
        id,
      ],
    );
    return this.getWorkspace(id)!;
  }

  deleteWorkspace(id: string): boolean {
    if (id === "local") throw new Error("local workspace cannot be deleted");
    const result = this.db.run("DELETE FROM multica_workspaces WHERE id = ?", [id]);
    if (result.changes === 0) return false;
    const now = nowIso();
    this.db.run("UPDATE multica_workspace_members SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE workspace_id = ?", [
      now,
      now,
      id,
    ]);
    return true;
  }

  leaveWorkspace(id: string, memberId = `mem_${id}_local`): boolean {
    const member = this.getWorkspaceMember(memberId) ?? this.listWorkspaceMembers(id).find((item) => item.email === this.getCurrentUser().email);
    if (!member || member.workspaceId !== id) return false;
    this.archiveWorkspaceMember(member.id);
    return true;
  }

  ensureLocalWorkspace(): MulticaWorkspace {
    const existing = this.getWorkspace("local");
    if (existing) return existing;
    return this.createWorkspace({ id: "local", name: "Local Workspace", slug: "local", issuePrefix: "MUL" });
  }

  createWorkspaceInvitation(workspaceId: string, input: CreateWorkspaceInvitationInput): MulticaWorkspaceInvitation {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const email = String(input.email ?? input.inviteeEmail ?? input.invitee_email ?? "").trim().toLowerCase();
    if (!email) throw new Error("email is required");
    const role = normalizeWorkspaceInvitationRole(input.role ?? "member");
    if (role === "owner") throw new Error("cannot invite as owner");
    const currentUser = this.getCurrentUser();
    if (email === currentUser.email.toLowerCase()) {
      const existingMember = this.listWorkspaceMembers(workspaceId).find((member) => member.email?.toLowerCase() === email);
      if (existingMember) throw new Error("user is already a member");
    }
    const pending = this.db.query(
      "SELECT * FROM multica_workspace_invitations WHERE workspace_id = ? AND invitee_email = ? AND status = 'pending'",
    ).get(workspaceId, email) as Row | null;
    if (pending) throw new Error("invitation already pending for this email");
    const id = createId("inv");
    const now = nowIso();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.run(
      `INSERT INTO multica_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        workspaceId,
        currentUser.id,
        email,
        email === currentUser.email.toLowerCase() ? currentUser.id : null,
        role,
        expiresAt,
        now,
        now,
      ],
    );
    return this.hydrateInvitation(this.getInvitation(id)!)!;
  }

  listWorkspaceInvitations(workspaceId: string): MulticaWorkspaceInvitation[] {
    const rows = this.db.query(
      "SELECT * FROM multica_workspace_invitations WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC",
    ).all(workspaceId) as Row[];
    return rows.map((row) => this.hydrateInvitation(toInvitation(row))!);
  }

  listCurrentUserInvitations(): MulticaWorkspaceInvitation[] {
    const user = this.getCurrentUser();
    const rows = this.db.query(
      `SELECT * FROM multica_workspace_invitations
       WHERE status = 'pending' AND (invitee_user_id = ? OR invitee_email = ?)
       ORDER BY created_at DESC`,
    ).all(user.id, user.email.toLowerCase()) as Row[];
    return rows.map((row) => this.hydrateInvitation(toInvitation(row))!);
  }

  getInvitation(id: string): MulticaWorkspaceInvitation | null {
    const row = this.db.query("SELECT * FROM multica_workspace_invitations WHERE id = ?").get(id) as Row | null;
    return row ? toInvitation(row) : null;
  }

  revokeWorkspaceInvitation(workspaceId: string, invitationId: string): boolean {
    const invitation = this.getInvitation(invitationId);
    if (!invitation || invitation.workspaceId !== workspaceId || invitation.status !== "pending") return false;
    this.updateInvitationStatus(invitationId, "revoked");
    return true;
  }

  acceptInvitation(invitationId: string): MulticaWorkspaceInvitation | null {
    const invitation = this.hydrateInvitation(this.getInvitation(invitationId));
    if (!invitation || invitation.status !== "pending") return null;
    const user = this.getCurrentUser();
    if (invitation.inviteeEmail !== user.email.toLowerCase() && invitation.inviteeUserId !== user.id) {
      throw new Error("invitation does not belong to you");
    }
    const accepted = this.updateInvitationStatus(invitationId, "accepted");
    const memberId = `mem_${invitation.workspaceId}_${user.id}`;
    if (!this.getWorkspaceMember(memberId)) {
      this.createWorkspaceMember({
        id: memberId,
        workspaceId: invitation.workspaceId,
        name: user.name,
        email: user.email,
        role: invitation.role,
      });
    }
    this.markCurrentUserOnboarded();
    return this.hydrateInvitation(accepted)!;
  }

  declineInvitation(invitationId: string): MulticaWorkspaceInvitation | null {
    const invitation = this.getInvitation(invitationId);
    if (!invitation || invitation.status !== "pending") return null;
    const user = this.getCurrentUser();
    if (invitation.inviteeEmail !== user.email.toLowerCase() && invitation.inviteeUserId !== user.id) {
      throw new Error("invitation does not belong to you");
    }
    return this.hydrateInvitation(this.updateInvitationStatus(invitationId, "declined"))!;
  }

  private updateInvitationStatus(invitationId: string, status: MulticaWorkspaceInvitation["status"]): MulticaWorkspaceInvitation {
    const now = nowIso();
    this.db.run("UPDATE multica_workspace_invitations SET status = ?, updated_at = ? WHERE id = ?", [status, now, invitationId]);
    return this.getInvitation(invitationId)!;
  }

  private hydrateInvitation(invitation: MulticaWorkspaceInvitation | null): MulticaWorkspaceInvitation | null {
    if (!invitation) return null;
    const inviter = this.getUser(invitation.inviterId);
    const workspace = this.getWorkspace(invitation.workspaceId);
    return {
      ...invitation,
      inviterName: inviter?.name,
      inviter_name: inviter?.name,
      inviterEmail: inviter?.email,
      inviter_email: inviter?.email,
      workspaceName: workspace?.name,
      workspace_name: workspace?.name,
    };
  }

  getNotificationPreferences(input: { workspaceId?: string | null; memberId?: string | null } = {}): MulticaNotificationPreferenceResponse {
    const workspaceId = input.workspaceId ?? "local";
    const memberId = input.memberId ?? null;
    const row = this.db.query(
      "SELECT * FROM multica_notification_preferences WHERE workspace_id = ? AND member_id = ?",
    ).get(workspaceId, memberId ?? "") as Row | null;
    return {
      workspaceId,
      memberId,
      preferences: row ? normalizeNotificationPreferences(parseJson(row.preferences, {})) : {},
      updatedAt: row ? String(row.updated_at ?? "") : null,
    };
  }

  updateNotificationPreferences(input: {
    workspaceId?: string | null;
    memberId?: string | null;
    preferences: MulticaNotificationPreferences;
  }): MulticaNotificationPreferenceResponse {
    const workspaceId = input.workspaceId ?? "local";
    const memberId = input.memberId ?? null;
    const preferences = normalizeNotificationPreferences(input.preferences);
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_notification_preferences (workspace_id, member_id, preferences, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, member_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`,
      [workspaceId, memberId ?? "", toJson(preferences), now],
    );
    return this.getNotificationPreferences({ workspaceId, memberId });
  }

  createFeedback(input: CreateFeedbackInput): MulticaFeedback {
    const message = String(input.message ?? "").trim();
    if (!message) throw new Error("message is required");
    if (message.length > FEEDBACK_MAX_MESSAGE_LENGTH) throw new Error("message too long");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const memberId = cleanOptionalString(input.memberId ?? input.member_id);
    const userId = cleanOptionalString(input.userId ?? input.user_id) ?? memberId ?? "local";
    const recentCount = this.countRecentFeedbackByUser(userId);
    if (recentCount >= FEEDBACK_HOURLY_RATE_LIMIT) {
      throw new Error("too many feedback submissions, please try again later");
    }
    const metadata = normalizeFeedbackMetadata({
      ...(input.metadata ?? {}),
      ...(input.url != null ? { url: input.url } : {}),
    });
    const id = input.id ?? createId("fdb");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_feedback (
        id, workspace_id, user_id, member_id, message, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, userId, memberId, message, toJson(metadata), now],
    );
    return this.getFeedback(id)!;
  }

  getFeedback(id: string): MulticaFeedback | null {
    const row = this.db.query("SELECT * FROM multica_feedback WHERE id = ?").get(id) as Row | null;
    return row ? toFeedback(row) : null;
  }

  listFeedback(workspaceId?: string | null): MulticaFeedback[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_feedback WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_feedback ORDER BY created_at DESC").all() as Row[];
    return rows.map(toFeedback);
  }

  countRecentFeedbackByUser(userId: string, since = new Date(Date.now() - 60 * 60 * 1000).toISOString()): number {
    const row = this.db.query(
      "SELECT COUNT(*) AS count FROM multica_feedback WHERE user_id = ? AND created_at >= ?",
    ).get(userId, since) as Row | null;
    return Number(row?.count ?? 0);
  }

  getGitHubSettings(workspaceId = "local"): MulticaGitHubSettings {
    const row = this.db.query("SELECT * FROM multica_github_settings WHERE workspace_id = ?").get(workspaceId) as Row | null;
    return row ? toGitHubSettings(row) : {
      workspaceId,
      enabled: true,
      prSidebar: true,
      coAuthor: true,
      autoLinkPRs: true,
      updatedAt: null,
    };
  }

  updateGitHubSettings(input: {
    workspaceId?: string | null;
    enabled?: boolean;
    prSidebar?: boolean;
    coAuthor?: boolean;
    autoLinkPRs?: boolean;
  }): MulticaGitHubSettings {
    const workspaceId = input.workspaceId ?? "local";
    const current = this.getGitHubSettings(workspaceId);
    const enabled = input.enabled ?? current.enabled;
    const prSidebar = input.prSidebar ?? current.prSidebar;
    const coAuthor = input.coAuthor ?? current.coAuthor;
    const autoLinkPRs = input.autoLinkPRs ?? current.autoLinkPRs;
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_github_settings (
        workspace_id, enabled, pr_sidebar, co_author, auto_link_prs, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        enabled = excluded.enabled,
        pr_sidebar = excluded.pr_sidebar,
        co_author = excluded.co_author,
        auto_link_prs = excluded.auto_link_prs,
        updated_at = excluded.updated_at`,
      [
        workspaceId,
        enabled ? 1 : 0,
        prSidebar ? 1 : 0,
        coAuthor ? 1 : 0,
        autoLinkPRs ? 1 : 0,
        now,
      ],
    );
    return this.getGitHubSettings(workspaceId);
  }

  listGitHubPullRequests(input: { workspaceId?: string | null; issueId?: string | null } = {}): MulticaGitHubPullRequest[] {
    const workspaceId = input.workspaceId ?? "local";
    const rows = input.issueId
      ? this.db.query("SELECT * FROM multica_github_pull_requests WHERE workspace_id = ? AND issue_id = ? ORDER BY pr_updated_at DESC").all(workspaceId, input.issueId) as Row[]
      : this.db.query("SELECT * FROM multica_github_pull_requests WHERE workspace_id = ? ORDER BY pr_updated_at DESC").all(workspaceId) as Row[];
    return rows.map(toGitHubPullRequest);
  }

  listGitHubPullRequestsForIssue(issueId: string): MulticaGitHubPullRequest[] | null {
    const issue = this.getIssue(issueId);
    if (!issue) return null;
    return this.listGitHubPullRequests({ workspaceId: issue.workspaceId, issueId });
  }

  upsertGitHubPullRequest(input: {
    id?: string;
    workspaceId?: string | null;
    issueId?: string | null;
    repoOwner: string;
    repoName: string;
    number: number;
    title: string;
    state?: MulticaGitHubPullRequestState | string;
    htmlUrl?: string | null;
    branch?: string | null;
    authorLogin?: string | null;
    authorAvatarUrl?: string | null;
    mergedAt?: string | null;
    closedAt?: string | null;
    prCreatedAt?: string | null;
    prUpdatedAt?: string | null;
    mergeableState?: string | null;
    checksConclusion?: string | null;
    checksPassed?: number;
    checksFailed?: number;
    checksPending?: number;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
  }): MulticaGitHubPullRequest {
    const workspaceId = input.workspaceId ?? "local";
    if (!input.repoOwner?.trim()) throw new Error("GitHub repo owner is required");
    if (!input.repoName?.trim()) throw new Error("GitHub repo name is required");
    if (!Number.isFinite(Number(input.number)) || Number(input.number) < 1) throw new Error("GitHub PR number is required");
    const issueId = input.issueId ?? this.findIssueIdForGitHubPullRequest(workspaceId, input);
    if (issueId && !this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const now = nowIso();
    const state = normalizeGitHubPullRequestState(input.state);
    const htmlUrl = input.htmlUrl || `https://github.com/${input.repoOwner}/${input.repoName}/pull/${input.number}`;
    const id = input.id ?? createId("ghp");
    this.db.run(
      `INSERT INTO multica_github_pull_requests (
        id, workspace_id, issue_id, repo_owner, repo_name, number, title, state, html_url, branch,
        author_login, author_avatar_url, merged_at, closed_at, pr_created_at, pr_updated_at,
        mergeable_state, checks_conclusion, checks_passed, checks_failed, checks_pending,
        additions, deletions, changed_files, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, repo_owner, repo_name, number) DO UPDATE SET
        issue_id = excluded.issue_id,
        title = excluded.title,
        state = excluded.state,
        html_url = excluded.html_url,
        branch = excluded.branch,
        author_login = excluded.author_login,
        author_avatar_url = excluded.author_avatar_url,
        merged_at = excluded.merged_at,
        closed_at = excluded.closed_at,
        pr_created_at = excluded.pr_created_at,
        pr_updated_at = excluded.pr_updated_at,
        mergeable_state = excluded.mergeable_state,
        checks_conclusion = excluded.checks_conclusion,
        checks_passed = excluded.checks_passed,
        checks_failed = excluded.checks_failed,
        checks_pending = excluded.checks_pending,
        additions = excluded.additions,
        deletions = excluded.deletions,
        changed_files = excluded.changed_files,
        updated_at = excluded.updated_at`,
      [
        id,
        workspaceId,
        issueId,
        input.repoOwner,
        input.repoName,
        input.number,
        input.title,
        state,
        htmlUrl,
        input.branch ?? null,
        input.authorLogin ?? null,
        input.authorAvatarUrl ?? null,
        input.mergedAt ?? null,
        input.closedAt ?? null,
        input.prCreatedAt ?? now,
        input.prUpdatedAt ?? now,
        input.mergeableState ?? null,
        normalizeGitHubChecksConclusion(input.checksConclusion),
        Math.max(0, Number(input.checksPassed ?? 0)),
        Math.max(0, Number(input.checksFailed ?? 0)),
        Math.max(0, Number(input.checksPending ?? 0)),
        Math.max(0, Number(input.additions ?? 0)),
        Math.max(0, Number(input.deletions ?? 0)),
        Math.max(0, Number(input.changedFiles ?? 0)),
        now,
        now,
      ],
    );
    const pr = this.db.query(
      "SELECT * FROM multica_github_pull_requests WHERE workspace_id = ? AND repo_owner = ? AND repo_name = ? AND number = ?",
    ).get(workspaceId, input.repoOwner, input.repoName, input.number) as Row;
    const result = toGitHubPullRequest(pr);
    if (result.issueId && state === "merged" && this.getGitHubSettings(workspaceId).autoLinkPRs) {
      const issue = this.getIssue(result.issueId);
      if (issue && issue.status !== "done") this.updateIssue(issue.id, { status: "done" });
    }
    return result;
  }

  async createAccessToken(input: CreateAccessTokenInput): Promise<MulticaCreatedAccessToken> {
    const name = input.name?.trim();
    if (!name) throw new Error("Token name is required");
    const type = normalizeAccessTokenType(input.type);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const token = generateAccessToken(type);
    const hash = await hashAccessToken(token);
    const id = input.id ?? createId(type === "daemon" ? "dtk" : "pat");
    const now = nowIso();
    const expiresAt = normalizeAccessTokenExpiry(input.expiresInDays ?? input.expires_in_days ?? null);
    this.db.run(
      `INSERT INTO multica_access_tokens (
        id, workspace_id, name, type, token_hash, token_prefix, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, name, type, hash, token.slice(0, 12), expiresAt, now],
    );
    return {
      ...this.getAccessToken(id)!,
      token,
    };
  }

  listAccessTokens(workspaceId?: string | null): MulticaAccessToken[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_access_tokens WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_access_tokens ORDER BY created_at DESC").all() as Row[];
    return rows.map(toAccessToken);
  }

  getAccessToken(id: string): MulticaAccessToken | null {
    const row = this.db.query("SELECT * FROM multica_access_tokens WHERE id = ?").get(id) as Row | null;
    return row ? toAccessToken(row) : null;
  }

  revokeAccessToken(id: string): MulticaAccessToken | null {
    const current = this.getAccessToken(id);
    if (!current) return null;
    if (!current.revokedAt) {
      this.db.run("UPDATE multica_access_tokens SET revoked_at = ? WHERE id = ?", [nowIso(), id]);
    }
    return this.getAccessToken(id);
  }

  async verifyAccessToken(rawToken: string, allowedTypes?: MulticaAccessTokenType[]): Promise<MulticaAccessToken | null> {
    const token = rawToken.trim();
    if (!token) return null;
    const hash = await hashAccessToken(token);
    const row = this.db.query("SELECT * FROM multica_access_tokens WHERE token_hash = ?").get(hash) as Row | null;
    if (!row) return null;
    const accessToken = toAccessToken(row);
    if (allowedTypes?.length && !allowedTypes.includes(accessToken.type)) return null;
    if (accessToken.revokedAt) return null;
    if (accessToken.expiresAt && Date.parse(accessToken.expiresAt) <= Date.now()) return null;
    this.db.run("UPDATE multica_access_tokens SET last_used_at = ? WHERE id = ?", [nowIso(), accessToken.id]);
    return this.getAccessToken(accessToken.id);
  }

  registerRuntime(input: RegisterRuntimeInput): MulticaRuntime {
    const id = input.id ?? createId("rt");
    const now = nowIso();
    const currentRow = this.db.query("SELECT * FROM multica_runtimes WHERE id = ?").get(id) as Row | null;
    const current = currentRow ? toRuntime(currentRow) : null;
    const ownerId = hasAnyField(input, "ownerId", "owner_id")
      ? resolveOptionalStringField(input, "ownerId", "owner_id", current?.ownerId ?? null)
      : current?.ownerId ?? null;
    const visibility = hasAnyField(input, "visibility")
      ? normalizeRuntimeVisibility(input.visibility)
      : current?.visibility ?? "private";
    const maxConcurrency = normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency ?? current?.maxConcurrency ?? 1);
    this.db.run(
      `INSERT INTO multica_runtimes (
        id, name, provider, workspace_id, owner_id, visibility, status, max_concurrency,
        last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        workspace_id = excluded.workspace_id,
        owner_id = excluded.owner_id,
        visibility = excluded.visibility,
        status = 'online',
        max_concurrency = excluded.max_concurrency,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at`,
      [
        id,
        input.name,
        input.provider,
        input.workspaceId ?? input.workspace_id ?? null,
        ownerId,
        visibility,
        maxConcurrency,
        now,
        now,
        now,
      ],
    );
    if (input.models !== undefined) this.replaceRuntimeModels(id, input.models, input.provider, now);
    return this.getRuntime(id)!;
  }

  getRuntime(id: string): MulticaRuntime | null {
    const row = this.db.query("SELECT * FROM multica_runtimes WHERE id = ?").get(id) as Row | null;
    return row ? withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))) : null;
  }

  listRuntimes(): MulticaRuntime[] {
    const rows = this.db.query("SELECT * FROM multica_runtimes ORDER BY updated_at DESC").all() as Row[];
    return rows.map((row) => withRuntimeLiveness(this.hydrateRuntime(toRuntime(row))));
  }

  updateRuntime(id: string, input: UpdateRuntimeInput): MulticaRuntime {
    const current = this.getRuntime(id);
    if (!current) throw new Error(`Runtime not found: ${id}`);
    const ownerId = resolveOptionalStringField(input, "ownerId", "owner_id", current.ownerId);
    const visibility = hasAnyField(input, "visibility")
      ? normalizeRuntimeVisibility(input.visibility)
      : current.visibility;
    const maxConcurrency = hasAnyField(input, "maxConcurrency", "max_concurrency")
      ? normalizeRuntimeConcurrency(input.maxConcurrency ?? input.max_concurrency)
      : current.maxConcurrency;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_runtimes SET
        name = ?,
        owner_id = ?,
        visibility = ?,
        max_concurrency = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        ownerId,
        visibility,
        maxConcurrency,
        now,
        id,
      ],
    );
    if (input.models !== undefined) this.replaceRuntimeModels(id, input.models, current.provider, now);
    return this.getRuntime(id)!;
  }

  setRuntimeOffline(id: string): MulticaRuntime | null {
    const current = this.getRuntime(id);
    if (!current) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtimes SET status = 'offline', updated_at = ? WHERE id = ?",
      [now, id],
    );
    return this.getRuntime(id);
  }

  deleteRuntime(id: string): boolean {
    const result = this.db.run("DELETE FROM multica_runtimes WHERE id = ?", [id]);
    return result.changes > 0;
  }

  listCloudRuntimeNodes(options: { limit?: number; offset?: number; ownerId?: string | null } = {}): MulticaCloudRuntimeNode[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const rows = options.ownerId
      ? this.db.query("SELECT * FROM multica_cloud_runtime_nodes WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(options.ownerId, limit, offset) as Row[]
      : this.db.query("SELECT * FROM multica_cloud_runtime_nodes ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Row[];
    return rows.map(toCloudRuntimeNode);
  }

  createCloudRuntimeNode(input: CreateCloudRuntimeNodeInput, ownerId = "local"): MulticaCloudRuntimeNode {
    const instanceType = String(input.instanceType ?? input.instance_type ?? "").trim();
    if (!instanceType) throw new Error("instance_type is required");
    const id = createId("crn");
    const now = nowIso();
    const name = String(input.name ?? "").trim() || `local-${instanceType}`;
    this.db.run(
      `INSERT INTO multica_cloud_runtime_nodes (
        id, owner_id, instance_id, region, instance_type, image_id, subnet_id,
        name, status, tags, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'launching', ?, ?, ?, ?)`,
      [
        id,
        ownerId,
        `local-${id}`,
        String(input.region ?? "local").trim() || "local",
        instanceType,
        String(input.imageId ?? input.image_id ?? "").trim(),
        String(input.subnetId ?? input.subnet_id ?? "").trim(),
        name,
        toJson(input.tags ?? {}),
        toJson(input.metadata ?? { local: true }),
        now,
        now,
      ],
    );
    return this.getCloudRuntimeNode(id)!;
  }

  getCloudRuntimeNode(id: string): MulticaCloudRuntimeNode | null {
    const row = this.db.query("SELECT * FROM multica_cloud_runtime_nodes WHERE id = ?").get(id) as Row | null;
    return row ? toCloudRuntimeNode(row) : null;
  }

  deleteCloudRuntimeNode(id: string): boolean {
    const result = this.db.run("DELETE FROM multica_cloud_runtime_nodes WHERE id = ?", [id]);
    return result.changes > 0;
  }

  setCloudRuntimeNodeStatus(id: string, status: string): MulticaCloudRuntimeNode | null {
    const current = this.getCloudRuntimeNode(id);
    if (!current) return null;
    this.db.run("UPDATE multica_cloud_runtime_nodes SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
    return this.getCloudRuntimeNode(id);
  }

  execCloudRuntimeNode(id: string, command: string): { node: MulticaCloudRuntimeNode; exit_code: number; stdout: string; stderr: string } | null {
    const node = this.getCloudRuntimeNode(id);
    if (!node) return null;
    const output = command.trim() ? `local cloud runtime node ${id}: ${command.trim()}` : `local cloud runtime node ${id}`;
    return { node, exit_code: 0, stdout: output, stderr: "" };
  }

  listRuntimeModels(runtimeId: string): MulticaRuntimeModel[] {
    if (!this.db.query("SELECT id FROM multica_runtimes WHERE id = ?").get(runtimeId)) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
    return this.listRuntimeModelsForExistingRuntime(runtimeId);
  }

  updateRuntimeModels(runtimeId: string, models: MulticaRuntimeModel[]): MulticaRuntimeModel[] {
    const row = this.db.query("SELECT * FROM multica_runtimes WHERE id = ?").get(runtimeId) as Row | null;
    if (!row) throw new Error(`Runtime not found: ${runtimeId}`);
    this.replaceRuntimeModels(runtimeId, models, String(row.provider), nowIso());
    return this.listRuntimeModels(runtimeId);
  }

  createRuntimeModelListRequest(runtimeId: string): MulticaRuntimeModelListRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const id = createId("rml");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_runtime_model_list_requests (
        id, runtime_id, status, models, supported, created_at, updated_at
      ) VALUES (?, ?, 'pending', '[]', 1, ?, ?)`,
      [id, runtimeId, now, now],
    );
    return this.getRuntimeModelListRequest(runtimeId, id)!;
  }

  getRuntimeModelListRequest(runtimeId: string, requestId: string): MulticaRuntimeModelListRequest | null {
    const row = this.db.query(
      "SELECT * FROM multica_runtime_model_list_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? toRuntimeModelListRequest(row) : null;
  }

  claimRuntimeModelListRequest(runtimeId: string): MulticaRuntimeModelListRequest | null {
    const row = this.db.query(
      `SELECT * FROM multica_runtime_model_list_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtime_model_list_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
      [now, now, String(row.id)],
    );
    return this.getRuntimeModelListRequest(runtimeId, String(row.id));
  }

  reportRuntimeModelListResult(runtimeId: string, requestId: string, input: ReportRuntimeModelListInput): MulticaRuntimeModelListRequest {
    const current = this.getRuntimeModelListRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    const status = normalizeRuntimeModelListStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      const runtime = this.getRuntime(runtimeId);
      if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
      const models = normalizeRuntimeModels(input.models ?? [], runtime.provider);
      this.db.transaction(() => {
        this.replaceRuntimeModels(runtimeId, models, runtime.provider, now);
        this.db.run(
          `UPDATE multica_runtime_model_list_requests
           SET status = 'completed', models = ?, supported = ?, error = NULL, updated_at = ?
           WHERE id = ?`,
          [toJson(models), input.supported === false ? 0 : 1, now, requestId],
        );
      })();
    } else {
      this.db.run(
        `UPDATE multica_runtime_model_list_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime model list failed", now, requestId],
      );
    }
    return this.getRuntimeModelListRequest(runtimeId, requestId)!;
  }

  createRuntimeUpdateRequest(runtimeId: string, input: CreateRuntimeUpdateInput): MulticaRuntimeUpdateRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const targetVersion = String(input.targetVersion ?? input.target_version ?? "").trim();
    if (!targetVersion) throw new Error("target_version is required");
    const active = this.db.query(
      `SELECT id FROM multica_runtime_update_requests
       WHERE runtime_id = ? AND status IN ('pending', 'running')
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (active) throw new Error("an update is already in progress for this runtime");
    const id = createId("rup");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_runtime_update_requests (
        id, runtime_id, status, target_version, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, ?, ?)`,
      [id, runtimeId, targetVersion, now, now],
    );
    return this.getRuntimeUpdateRequest(runtimeId, id)!;
  }

  getRuntimeUpdateRequest(runtimeId: string, requestId: string): MulticaRuntimeUpdateRequest | null {
    const row = this.db.query(
      "SELECT * FROM multica_runtime_update_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? toRuntimeUpdateRequest(row) : null;
  }

  claimRuntimeUpdateRequest(runtimeId: string): MulticaRuntimeUpdateRequest | null {
    const row = this.db.query(
      `SELECT * FROM multica_runtime_update_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtime_update_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
      [now, now, String(row.id)],
    );
    return this.getRuntimeUpdateRequest(runtimeId, String(row.id));
  }

  reportRuntimeUpdateResult(runtimeId: string, requestId: string, input: ReportRuntimeUpdateInput): MulticaRuntimeUpdateRequest {
    const current = this.getRuntimeUpdateRequest(runtimeId, requestId);
    if (!current) throw new Error("update not found");
    const status = normalizeRuntimeUpdateStatus(input.status);
    const now = nowIso();
    if (current.status === "completed" || current.status === "failed" || current.status === "timeout") return current;
    if (status === "completed") {
      this.db.run(
        "UPDATE multica_runtime_update_requests SET status = 'completed', output = ?, error = NULL, updated_at = ? WHERE id = ?",
        [input.output ?? "", now, requestId],
      );
    } else if (status === "running") {
      this.db.run(
        "UPDATE multica_runtime_update_requests SET status = 'running', updated_at = ? WHERE id = ?",
        [now, requestId],
      );
    } else {
      this.db.run(
        "UPDATE multica_runtime_update_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        [input.error ?? "runtime update failed", now, requestId],
      );
    }
    return this.getRuntimeUpdateRequest(runtimeId, requestId)!;
  }

  createRuntimeLocalSkillListRequest(runtimeId: string): MulticaRuntimeLocalSkillListRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const id = createId("rls");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_runtime_local_skill_list_requests (
        id, runtime_id, status, skills, supported, created_at, updated_at
      ) VALUES (?, ?, 'pending', '[]', 1, ?, ?)`,
      [id, runtimeId, now, now],
    );
    return this.getRuntimeLocalSkillListRequest(runtimeId, id)!;
  }

  getRuntimeLocalSkillListRequest(runtimeId: string, requestId: string): MulticaRuntimeLocalSkillListRequest | null {
    const row = this.db.query(
      "SELECT * FROM multica_runtime_local_skill_list_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? toRuntimeLocalSkillListRequest(row) : null;
  }

  claimRuntimeLocalSkillListRequest(runtimeId: string): MulticaRuntimeLocalSkillListRequest | null {
    const row = this.db.query(
      `SELECT * FROM multica_runtime_local_skill_list_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(runtimeId) as Row | null;
    if (!row) return null;
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtime_local_skill_list_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
      [now, now, String(row.id)],
    );
    return this.getRuntimeLocalSkillListRequest(runtimeId, String(row.id));
  }

  reportRuntimeLocalSkillListResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillListInput): MulticaRuntimeLocalSkillListRequest {
    const current = this.getRuntimeLocalSkillListRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    const status = normalizeRuntimeLocalSkillStatus(input.status);
    const now = nowIso();
    if (status === "completed") {
      this.db.run(
        `UPDATE multica_runtime_local_skill_list_requests
         SET status = 'completed', skills = ?, supported = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
        [toJson(normalizeRuntimeLocalSkillSummaries(input.skills ?? [])), input.supported === false ? 0 : 1, now, requestId],
      );
    } else {
      this.db.run(
        `UPDATE multica_runtime_local_skill_list_requests
         SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ?`,
        [input.error ?? "runtime local skill list failed", now, requestId],
      );
    }
    return this.getRuntimeLocalSkillListRequest(runtimeId, requestId)!;
  }

  createRuntimeLocalSkillImportRequest(runtimeId: string, input: CreateRuntimeLocalSkillImportInput): MulticaRuntimeLocalSkillImportRequest {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
    if (runtime.status !== "online") throw new Error("runtime is offline");
    const skillKey = String(input.skillKey ?? input.skill_key ?? "").trim();
    if (!skillKey) throw new Error("skill_key is required");
    const id = createId("rli");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_runtime_local_skill_import_requests (
        id, runtime_id, skill_key, name, description, status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        runtimeId,
        skillKey,
        cleanOptionalLocalSkillString(input.name),
        cleanOptionalLocalSkillString(input.description),
        input.createdBy ?? input.created_by ?? null,
        now,
        now,
      ],
    );
    return this.getRuntimeLocalSkillImportRequest(runtimeId, id)!;
  }

  getRuntimeLocalSkillImportRequest(runtimeId: string, requestId: string): MulticaRuntimeLocalSkillImportRequest | null {
    const row = this.db.query(
      "SELECT * FROM multica_runtime_local_skill_import_requests WHERE id = ? AND runtime_id = ?",
    ).get(requestId, runtimeId) as Row | null;
    return row ? this.hydrateRuntimeLocalSkillImportRequest(toRuntimeLocalSkillImportRequest(row)) : null;
  }

  claimRuntimeLocalSkillImportRequests(runtimeId: string, limit = 10): MulticaRuntimeLocalSkillImportRequest[] {
    const rows = this.db.query(
      `SELECT * FROM multica_runtime_local_skill_import_requests
       WHERE runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(runtimeId, Math.max(1, Math.floor(limit))) as Row[];
    if (!rows.length) return [];
    const now = nowIso();
    for (const row of rows) {
      this.db.run(
        "UPDATE multica_runtime_local_skill_import_requests SET status = 'running', run_started_at = ?, updated_at = ? WHERE id = ?",
        [now, now, String(row.id)],
      );
    }
    return rows.map((row) => this.getRuntimeLocalSkillImportRequest(runtimeId, String(row.id))!).filter(Boolean);
  }

  reportRuntimeLocalSkillImportResult(runtimeId: string, requestId: string, input: ReportRuntimeLocalSkillImportInput): MulticaRuntimeLocalSkillImportRequest {
    const current = this.getRuntimeLocalSkillImportRequest(runtimeId, requestId);
    if (!current) throw new Error("request not found");
    const status = normalizeRuntimeLocalSkillStatus(input.status);
    const now = nowIso();
    if (status !== "completed") {
      this.db.run(
        "UPDATE multica_runtime_local_skill_import_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        [input.error ?? "runtime local skill import failed", now, requestId],
      );
      return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
    }
    if (!input.skill) throw new Error("daemon returned an empty skill bundle");
    const skillName = cleanOptionalLocalSkillString(current.name) ?? String(input.skill.name ?? current.skillKey).trim();
    const description = cleanOptionalLocalSkillString(current.description) ?? String(input.skill.description ?? "");
    const runtime = this.getRuntime(runtimeId);
    const skill = this.createSkill({
      workspaceId: runtime?.workspaceId ?? "local",
      name: skillName,
      description,
      content: input.skill.content ?? "",
      createdBy: current.createdBy,
      files: input.skill.files ?? [],
      config: {
        origin: {
          type: "runtime_local",
          runtime_id: runtimeId,
          provider: input.skill.provider ?? runtime?.provider ?? "unknown",
          source_path: input.skill.sourcePath ?? input.skill.source_path ?? "",
        },
      },
    });
    const skillId = skill.id ?? "";
    this.db.run(
      `UPDATE multica_runtime_local_skill_import_requests
       SET status = 'completed', skill_id = ?, skill = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
      [skillId, toJson(skill), now, requestId],
    );
    return this.getRuntimeLocalSkillImportRequest(runtimeId, requestId)!;
  }

  listRuntimeUsage(runtimeId?: string | null): MulticaRuntimeUsage[] {
    if (runtimeId !== undefined && runtimeId !== null && !this.getRuntime(runtimeId)) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
    const rows = runtimeId === undefined
      ? this.db.query("SELECT id, runtime_id, usage FROM multica_tasks WHERE runtime_id IS NOT NULL").all() as Row[]
      : runtimeId === null
        ? this.db.query("SELECT id, runtime_id, usage FROM multica_tasks WHERE runtime_id IS NULL").all() as Row[]
        : this.db.query("SELECT id, runtime_id, usage FROM multica_tasks WHERE runtime_id = ?").all(runtimeId) as Row[];
    const usage = new Map<string, MulticaRuntimeUsage & { taskIds: Set<string> }>();
    for (const row of rows) {
      const rowRuntimeId = nullableString(row.runtime_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [rowRuntimeId ?? "", entry.provider, entry.model].join("\u0000");
        const current = usage.get(key) ?? {
          runtimeId: rowRuntimeId,
          provider: entry.provider,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        current.inputTokens += entry.inputTokens;
        current.outputTokens += entry.outputTokens;
        current.cacheReadTokens += entry.cacheReadTokens;
        current.cacheWriteTokens += entry.cacheWriteTokens;
        current.taskIds.add(String(row.id));
        usage.set(key, current);
      }
    }
    return [...usage.values()]
      .map(({ taskIds, ...entry }) => ({ ...entry, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaUsageDaily[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MulticaUsageDaily & { taskIds: Set<string> }>();
    for (const row of rows) {
      const date = usageDate(row);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [date, nullableString(row.runtime_id) ?? "", entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          date,
          runtimeId: nullableString(row.runtime_id),
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model));
  }

  listUsageByAgent(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaUsageByAgent[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MulticaUsageByAgent & { taskIds: Set<string> }>();
    for (const row of rows) {
      const agentId = String(row.agent_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [agentId, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          agentId,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.agentId.localeCompare(right.agentId) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaUsageByHour[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MulticaUsageByHour & { taskIds: Set<string> }>();
    for (const row of rows) {
      const hour = usageHour(row);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [hour, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          hour,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.hour - right.hour || left.model.localeCompare(right.model));
  }

  listTaskActivityByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaTaskActivityByHour[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const counts = new Map<number, number>();
    for (const row of rows) {
      const hour = usageHour(row);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((left, right) => left.hour - right.hour);
  }

  listRuntimeDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  } = {}): MulticaRuntimeDaily[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const buckets = new Map<string, MulticaRuntimeDaily>();
    for (const row of rows) {
      const date = usageDate(row);
      const current = buckets.get(date) ?? { date, totalSeconds: 0, taskCount: 0, failedCount: 0 };
      current.taskCount += 1;
      if (String(row.status ?? "") === "failed") current.failedCount += 1;
      current.totalSeconds += taskRunSeconds(row);
      buckets.set(date, current);
    }
    return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  heartbeatRuntime(runtimeId: string, options: { claimPending?: boolean; supportsBatchImport?: boolean } = {}): MulticaDaemonHeartbeatAck {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) {
      return { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true };
    }
    const now = nowIso();
    this.db.run(
      "UPDATE multica_runtimes SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      [now, now, runtimeId],
    );
    const ack: MulticaDaemonHeartbeatAck = { runtime_id: runtimeId, status: "ok" };
    if (options.claimPending === false) return ack;

    const pendingUpdate = this.claimRuntimeUpdateRequest(runtimeId);
    if (pendingUpdate) {
      ack.pending_update = {
        id: pendingUpdate.id,
        target_version: pendingUpdate.targetVersion,
      };
    }
    const pendingModelList = this.claimRuntimeModelListRequest(runtimeId);
    if (pendingModelList) {
      ack.pending_model_list = { id: pendingModelList.id };
    }
    const pendingLocalSkills = this.claimRuntimeLocalSkillListRequest(runtimeId);
    if (pendingLocalSkills) {
      ack.pending_local_skills = { id: pendingLocalSkills.id };
    }
    const importLimit = options.supportsBatchImport === false ? 1 : 10;
    const pendingImports = this.claimRuntimeLocalSkillImportRequests(runtimeId, importLimit);
    if (pendingImports.length > 0) {
      ack.pending_local_skill_import = {
        id: pendingImports[0].id,
        skill_key: pendingImports[0].skillKey,
      };
      if (options.supportsBatchImport !== false) {
        ack.pending_local_skill_imports = pendingImports.map((request) => ({
          id: request.id,
          skill_key: request.skillKey,
        }));
      }
    }
    return ack;
  }

  createIssue(input: CreateIssueInput): MulticaIssue {
    const parentIssueId = input.parentIssueId ?? input.parent_issue_id ?? null;
    const explicitWorkspaceId = input.workspaceId ?? input.workspace_id ?? null;
    const workspaceId = explicitWorkspaceId ?? "local";
    const parent = parentIssueId ? this.getIssue(parentIssueId) : null;
    if (parentIssueId && !parent) throw new Error(`Parent issue not found: ${parentIssueId}`);
    if (parent && parent.workspaceId !== workspaceId) throw new Error("Parent issue belongs to another workspace");

    const projectId = input.projectId ?? input.project_id ?? (parent ? parent.projectId : null);
    if (projectId) {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
    }

    const assigneeType = input.assigneeType ?? input.assignee_type ?? null;
    const assigneeId = input.assigneeId ?? input.assignee_id ?? null;
    if (assigneeType || assigneeId) {
      this.validateIssueAssignee(assigneeType, assigneeId);
    }
    const id = input.id ?? createId("iss");
    const now = nowIso();
    const issueNumber = this.nextIssueNumber(workspaceId);
    const issueKey = formatIssueKey(issueNumber);
    const priority = normalizeIssuePriority(input.priority);
    const position = normalizeIssuePosition(input.position);
    const startDate = normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date");
    const dueDate = normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date");
    const acceptanceCriteria = normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? []);
    const contextRefs = normalizeJsonArray(input.contextRefs ?? input.context_refs ?? []);
    this.db.run(
      `INSERT INTO multica_issues (
        id, issue_number, issue_key, title, description, status, priority, workspace_id, project_id,
        parent_issue_id, assignee_type, assignee_id, position, start_date, due_date,
        acceptance_criteria, context_refs, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        issueNumber,
        issueKey,
        input.title,
        input.description ?? null,
        input.status ?? "open",
        priority,
        workspaceId,
        projectId,
        parentIssueId,
        assigneeType,
        assigneeId,
        position,
        startDate,
        dueDate,
        toJson(acceptanceCriteria),
        toJson(contextRefs),
        input.createdBy ?? null,
        now,
        now,
      ],
    );
    if (projectId) {
      this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    }
    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: input.createdBy ?? null,
      type: "issue_created",
      body: input.title,
      data: { projectId, parentIssueId, priority, startDate, dueDate },
    });
    if (input.createdBy) {
      const creator = this.getWorkspaceMember(input.createdBy);
      if (creator && !creator.archivedAt) this.addIssueSubscriber(id, input.createdBy, "created");
    }
    return this.getIssue(id)!;
  }

  getIssue(id: string): MulticaIssue | null {
    const row = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssue(toIssue(row)) : null;
  }

  getIssueWithTasks(id: string): MulticaIssueWithTasks | null {
    const issue = this.getIssue(id);
    if (!issue) return null;
    return {
      ...issue,
      tasks: this.listTasksForIssue(id),
      reactions: this.listIssueReactions(id),
      attachments: this.listAttachmentsForIssue(id),
      children: this.listChildIssues(id),
      childProgress: this.getChildIssueProgress(id),
      dependencies: this.listIssueDependencies(id),
    };
  }

  listIssues(input: ListIssuesInput = {}): MulticaIssue[] {
    const rows = this.db.query("SELECT * FROM multica_issues ORDER BY updated_at DESC").all() as Row[];
    const offset = normalizeListOffset(input.offset);
    const limit = input.limit === undefined ? Number.POSITIVE_INFINITY : normalizeListLimit(input.limit);
    return rows
      .map((row) => this.hydrateIssue(toIssue(row)))
      .filter((issue) => issueMatchesListFilter(issue, input))
      .slice(offset, offset + limit);
  }

  listGroupedIssues(input: ListIssuesInput = {}): { groups: MulticaIssueAssigneeGroup[] } {
    const limit = normalizeListLimit(input.limit, 50, 100);
    const offset = normalizeListOffset(input.offset);
    const issues = this.listIssues({ ...input, limit: undefined, offset: undefined })
      .sort((left, right) => {
        const typeRank = assigneeGroupRank(left.assigneeType) - assigneeGroupRank(right.assigneeType);
        if (typeRank !== 0) return typeRank;
        return String(left.assigneeId ?? "").localeCompare(String(right.assigneeId ?? ""))
          || left.position - right.position
          || Date.parse(right.createdAt) - Date.parse(left.createdAt);
      });
    const groups = new Map<string, MulticaIssueAssigneeGroup>();
    for (const issue of issues) {
      const id = assigneeGroupId(issue.assigneeType, issue.assigneeId);
      const group = groups.get(id) ?? {
        id,
        assigneeType: issue.assigneeType,
        assigneeId: issue.assigneeId,
        issues: [],
        total: 0,
      };
      group.total += 1;
      if (group.total > offset && group.issues.length < limit) group.issues.push(issue);
      groups.set(id, group);
    }
    return { groups: [...groups.values()] };
  }

  listAssigneeFrequency(input: {
    workspaceId?: string | null;
    actorId?: string | null;
    actor_id?: string | null;
    memberId?: string | null;
    member_id?: string | null;
    userId?: string | null;
    user_id?: string | null;
  } = {}): MulticaAssigneeFrequencyEntry[] {
    const workspaceId = input.workspaceId ?? "local";
    const actorId = input.actorId ?? input.actor_id ?? input.memberId ?? input.member_id ?? input.userId ?? input.user_id ?? null;
    const frequency = new Map<string, { assigneeType: MulticaAssigneeType; assigneeId: string; frequency: number }>();
    const add = (assigneeType: unknown, assigneeId: unknown, count = 1) => {
      const type = nullableString(assigneeType) as MulticaAssigneeType | null;
      const id = nullableString(assigneeId);
      if (!type || !id) return;
      if (type !== "agent" && type !== "member" && type !== "squad") return;
      const key = `${type}:${id}`;
      const current = frequency.get(key) ?? { assigneeType: type, assigneeId: id, frequency: 0 };
      current.frequency += count;
      frequency.set(key, current);
    };

    const issueRows = actorId
      ? this.db.query(`
          SELECT assignee_type, assignee_id, COUNT(*) AS frequency
          FROM multica_issues
          WHERE workspace_id = ? AND created_by = ? AND assignee_type IS NOT NULL AND assignee_id IS NOT NULL
          GROUP BY assignee_type, assignee_id
        `).all(workspaceId, actorId) as Row[]
      : this.db.query(`
          SELECT assignee_type, assignee_id, COUNT(*) AS frequency
          FROM multica_issues
          WHERE workspace_id = ? AND assignee_type IS NOT NULL AND assignee_id IS NOT NULL
          GROUP BY assignee_type, assignee_id
        `).all(workspaceId) as Row[];
    for (const row of issueRows) add(row.assignee_type, row.assignee_id, Number(row.frequency ?? 0));

    const activityRows = actorId
      ? this.db.query(`
          SELECT a.data
          FROM multica_issue_activity a
          JOIN multica_issues i ON i.id = a.issue_id
          WHERE i.workspace_id = ? AND a.actor_type = 'member' AND a.actor_id = ?
            AND a.type IN ('assignee_changed', 'issue_assigned')
        `).all(workspaceId, actorId) as Row[]
      : this.db.query(`
          SELECT a.data
          FROM multica_issue_activity a
          JOIN multica_issues i ON i.id = a.issue_id
          WHERE i.workspace_id = ? AND a.type IN ('assignee_changed', 'issue_assigned')
        `).all(workspaceId) as Row[];
    for (const row of activityRows) {
      const data = parseJson<Record<string, unknown>>(row.data, {});
      add(data.to_type ?? data.toType ?? data.assignee_type ?? data.assigneeType, data.to_id ?? data.toId ?? data.assignee_id ?? data.assigneeId);
    }

    return [...frequency.values()]
      .map((entry) => ({
        assigneeType: entry.assigneeType,
        assignee_type: entry.assigneeType,
        assigneeId: entry.assigneeId,
        assignee_id: entry.assigneeId,
        frequency: entry.frequency,
      }))
      .sort((left, right) => right.frequency - left.frequency || left.assigneeType.localeCompare(right.assigneeType) || left.assigneeId.localeCompare(right.assigneeId));
  }

  batchUpdateIssues(input: BatchUpdateIssuesInput): { updated: number; issues: MulticaIssue[] } {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    const updates = input.updates ?? {};
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    if (!hasIssueMutation(updates)) return { updated: 0, issues: [] };
    const issues: MulticaIssue[] = [];
    for (const issueId of issueIds) {
      try {
        issues.push(this.updateIssue(issueId, updates));
      } catch {
        // Match Multica's batch behavior: skip invalid or inaccessible rows.
      }
    }
    return { updated: issues.length, issues };
  }

  deleteIssue(id: string): boolean {
    const issue = this.getIssue(id);
    if (!issue) return false;
    this.db.transaction(() => {
      this.cancelActiveIssueTasks(id, "issue_deleted");
      this.db.run("UPDATE multica_autopilot_runs SET status = 'failed', completed_at = ?, failure_reason = ? WHERE issue_id = ? AND completed_at IS NULL", [
        nowIso(),
        "issue deleted",
        id,
      ]);
      this.db.run("UPDATE multica_autopilot_runs SET issue_id = NULL WHERE issue_id = ?", [id]);
      this.db.run("DELETE FROM multica_issues WHERE id = ?", [id]);
      if (issue.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [nowIso(), issue.projectId]);
    })();
    return true;
  }

  batchDeleteIssues(input: BatchDeleteIssuesInput): { deleted: number } {
    const issueIds = input.issueIds ?? input.issue_ids ?? [];
    if (issueIds.length === 0) throw new Error("issue_ids is required");
    let deleted = 0;
    for (const issueId of issueIds) {
      if (this.deleteIssue(issueId)) deleted += 1;
    }
    return { deleted };
  }

  searchIssues(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { issues: MulticaIssueSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listIssues().filter((issue) => {
      if (issue.workspaceId !== workspaceId) return false;
      if (!includeClosed && ["done", "failed", "cancelled"].includes(issue.status)) return false;
      return searchMatch(issue.key, query) || searchMatch(issue.title, query) || searchMatch(issue.description ?? "", query);
    }).map((issue) => {
      const matchSource = searchMatch(issue.key, query) ? "key" : searchMatch(issue.title, query) ? "title" : "description";
      const result: MulticaIssueSearchResult = {
        ...issue,
        matchSource,
      };
      if (matchSource === "description" && issue.description) result.matchedDescriptionSnippet = extractSearchSnippet(issue.description, query);
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { issues: rows.slice(offset, offset + limit), total: rows.length };
  }

  listTasksForIssue(issueId: string): MulticaTask[] {
    const rows = this.db.query(
      "SELECT * FROM multica_tasks WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Row[];
    return rows.map(toTask);
  }

  listChildIssues(parentIssueId: string): MulticaIssue[] {
    const parent = this.getIssue(parentIssueId);
    if (!parent) throw new Error(`Issue not found: ${parentIssueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_issues WHERE parent_issue_id = ? ORDER BY position ASC, created_at DESC",
    ).all(parentIssueId) as Row[];
    return rows.map((row) => this.hydrateIssue(toIssue(row)));
  }

  listChildIssueProgress(workspaceId = "local"): MulticaIssueChildProgress[] {
    const rows = this.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multica_issues
       WHERE workspace_id = ? AND parent_issue_id IS NOT NULL
       GROUP BY parent_issue_id
       ORDER BY parent_issue_id ASC`,
    ).all(workspaceId) as Row[];
    return rows.map(toChildIssueProgress);
  }

  getChildIssueProgress(parentIssueId: string): MulticaIssueChildProgress {
    const row = this.db.query(
      `SELECT parent_issue_id, COUNT(*) AS total,
              SUM(CASE WHEN status IN ('done', 'completed', 'closed', 'cancelled') THEN 1 ELSE 0 END) AS done
       FROM multica_issues
       WHERE parent_issue_id = ?
       GROUP BY parent_issue_id`,
    ).get(parentIssueId) as Row | null;
    return row ? toChildIssueProgress(row) : { parentIssueId, total: 0, done: 0 };
  }

  listIssueDependencies(issueId: string): MulticaIssueDependency[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      `SELECT * FROM multica_issue_dependencies
       WHERE issue_id = ? OR depends_on_issue_id = ?
       ORDER BY created_at ASC`,
    ).all(issueId, issueId) as Row[];
    return rows.map((row) => this.hydrateIssueDependency(toIssueDependency(row)));
  }

  createIssueDependency(issueId: string, input: CreateIssueDependencyInput): MulticaIssueDependency {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const dependsOnIssueId = input.dependsOnIssueId ?? input.depends_on_issue_id ?? "";
    const dependsOnIssue = this.getIssue(dependsOnIssueId);
    if (!dependsOnIssue) throw new Error(`Dependent issue not found: ${dependsOnIssueId}`);
    if (issue.id === dependsOnIssue.id) throw new Error("An issue cannot depend on itself");
    if (issue.workspaceId !== dependsOnIssue.workspaceId) throw new Error("Issue dependency must stay within a workspace");
    const type = normalizeIssueDependencyType(input.type);
    const id = input.id ?? createId("dep");
    const now = nowIso();
    const existing = this.db.query(
      `SELECT * FROM multica_issue_dependencies
       WHERE issue_id = ? AND depends_on_issue_id = ? AND type = ?`,
    ).get(issue.id, dependsOnIssue.id, type) as Row | null;
    if (existing) return this.hydrateIssueDependency(toIssueDependency(existing));
    this.db.run(
      `INSERT INTO multica_issue_dependencies (
        id, workspace_id, issue_id, depends_on_issue_id, type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, issue.workspaceId, issue.id, dependsOnIssue.id, type, now],
    );
    this.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_added",
      body: `${type} ${dependsOnIssue.key}`,
      data: { dependencyId: id, dependsOnIssueId: dependsOnIssue.id, type },
    });
    return this.getIssueDependency(id)!;
  }

  getIssueDependency(id: string): MulticaIssueDependency | null {
    const row = this.db.query("SELECT * FROM multica_issue_dependencies WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueDependency(toIssueDependency(row)) : null;
  }

  deleteIssueDependency(issueId: string, dependencyId: string): void {
    const dependency = this.getIssueDependency(dependencyId);
    if (!dependency) return;
    if (dependency.issueId !== issueId && dependency.dependsOnIssueId !== issueId) {
      throw new Error(`Dependency not found for issue: ${issueId}`);
    }
    this.db.run("DELETE FROM multica_issue_dependencies WHERE id = ?", [dependencyId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_dependency_removed",
      body: dependency.type,
      data: { dependencyId, issueId: dependency.issueId, dependsOnIssueId: dependency.dependsOnIssueId, type: dependency.type },
    });
  }

  updateIssue(id: string, input: UpdateIssueInput): MulticaIssue {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const nextWorkspaceId = resolveOptionalStringField(input, "workspaceId", "workspace_id", current.workspaceId) ?? "local";
    const nextProjectId = resolveOptionalStringField(input, "projectId", "project_id", current.projectId);
    const nextParentIssueId = resolveOptionalStringField(input, "parentIssueId", "parent_issue_id", current.parentIssueId);
    const nextAssigneeType = resolveOptionalStringField(input, "assigneeType", "assignee_type", current.assigneeType) as MulticaAssigneeType | null;
    const nextAssigneeId = resolveOptionalStringField(input, "assigneeId", "assignee_id", current.assigneeId);
    const nextStartDate = hasAnyField(input, "startDate", "start_date")
      ? normalizeIssueDate(input.startDate ?? input.start_date ?? null, "start_date")
      : current.startDate;
    const nextDueDate = hasAnyField(input, "dueDate", "due_date")
      ? normalizeIssueDate(input.dueDate ?? input.due_date ?? null, "due_date")
      : current.dueDate;
    const nextAcceptanceCriteria = hasAnyField(input, "acceptanceCriteria", "acceptance_criteria")
      ? normalizeJsonArray(input.acceptanceCriteria ?? input.acceptance_criteria ?? [])
      : current.acceptanceCriteria;
    const nextContextRefs = hasAnyField(input, "contextRefs", "context_refs")
      ? normalizeJsonArray(input.contextRefs ?? input.context_refs ?? [])
      : current.contextRefs;

    if (nextProjectId) {
      const project = this.getProject(nextProjectId);
      if (!project) throw new Error(`Project not found: ${nextProjectId}`);
      if (project.workspaceId !== nextWorkspaceId) throw new Error("Project belongs to another workspace");
    }
    if (nextParentIssueId) {
      const parent = this.getIssue(nextParentIssueId);
      if (!parent) throw new Error(`Parent issue not found: ${nextParentIssueId}`);
      if (parent.workspaceId !== nextWorkspaceId) throw new Error("Parent issue belongs to another workspace");
      this.validateIssueParent(id, nextParentIssueId);
    }
    if (hasAnyField(input, "assigneeType", "assignee_type", "assigneeId", "assignee_id")) {
      this.validateIssueAssignee(nextAssigneeType, nextAssigneeId);
    }

    const now = nowIso();
    this.db.run(
      `UPDATE multica_issues SET
        title = ?,
        description = ?,
        status = ?,
        priority = ?,
        workspace_id = ?,
        project_id = ?,
        parent_issue_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        position = ?,
        start_date = ?,
        due_date = ?,
        acceptance_criteria = ?,
        context_refs = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.status ?? current.status,
        normalizeIssuePriority(input.priority ?? current.priority),
        nextWorkspaceId,
        nextProjectId,
        nextParentIssueId,
        nextAssigneeType,
        nextAssigneeId,
        input.position === undefined || input.position === null ? current.position : normalizeIssuePosition(input.position),
        nextStartDate,
        nextDueDate,
        toJson(nextAcceptanceCriteria),
        toJson(nextContextRefs),
        now,
        id,
      ],
    );
    this.appendIssueActivity(id, {
      actorType: "system",
      actorId: null,
      type: "issue_updated",
      body: null,
      data: input,
    });
    if (current.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    if (nextProjectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, nextProjectId]);
    return this.getIssue(id)!;
  }

  assignIssue(id: string, input: AssignIssueInput): AssignIssueResult {
    const current = this.getIssue(id);
    if (!current) throw new Error(`Issue not found: ${id}`);
    const assigneeType = input.assigneeType ?? input.assignee_type ?? null;
    const assigneeId = input.assigneeId ?? input.assignee_id ?? null;
    const actorType = input.actorType ?? input.actor_type ?? "system";
    const actorId = input.actorId ?? input.actor_id ?? null;
    const now = nowIso();

    if (Boolean(assigneeType) !== Boolean(assigneeId)) {
      throw new Error("Assignee type and id are required together");
    }
    if (!assigneeType || !assigneeId) {
      const cancelled = this.cancelActiveIssueTasks(id, "issue_unassigned");
      this.db.run(
        "UPDATE multica_issues SET assignee_type = NULL, assignee_id = NULL, updated_at = ? WHERE id = ?",
        [now, id],
      );
      this.appendIssueActivity(id, {
        actorType,
        actorId,
        type: "issue_unassigned",
        body: null,
        data: { cancelled },
      });
      return { issue: this.getIssue(id)!, task: null };
    }

    this.validateIssueAssignee(assigneeType, assigneeId);
    const taskAgent = assigneeType === "member" ? null : this.resolveRunnableAgentForAssignee(assigneeType, assigneeId);
    if (assigneeType !== "member" && !taskAgent) {
      throw new Error(`No runnable agent for ${assigneeType}: ${assigneeId}`);
    }
    const cancelled = this.cancelActiveIssueTasks(id, "issue_reassigned");
    this.db.run(
      `UPDATE multica_issues
       SET assignee_type = ?, assignee_id = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        assigneeType,
        assigneeId,
        taskAgent ? "in_progress" : current.status,
        now,
        id,
      ],
    );

    let task: MulticaTask | null = null;
    if (taskAgent) {
      task = this.createTask({
        agentId: taskAgent.id,
        issueId: id,
        workspaceId: current.workspaceId,
        prompt: input.prompt?.trim() || current.title,
      });
    }
    if (assigneeType === "member") {
      this.addIssueSubscriber(id, assigneeId, "assigned");
      this.createInboxItem({
        issueId: id,
        memberId: assigneeId,
        type: "issue_assigned",
        title: `${current.key} assigned to you`,
        body: current.title,
        actorType: "system",
        actorId: null,
      });
    }

    this.appendIssueActivity(id, {
      actorType,
      actorId,
      type: "issue_assigned",
      body: taskAgent ? `Queued ${taskAgent.name}` : null,
      data: {
        assigneeType,
        assignee_type: assigneeType,
        assigneeId,
        assignee_id: assigneeId,
        toType: assigneeType,
        to_type: assigneeType,
        toId: assigneeId,
        to_id: assigneeId,
        taskId: task?.id ?? null,
        task_id: task?.id ?? null,
        cancelled,
      },
    });
    if (current.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, current.projectId]);
    return { issue: this.getIssue(id)!, task };
  }

  quickCreateIssue(input: QuickCreateIssueInput): QuickCreateIssueResult {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("prompt is required");
    const agentId = input.agentId ?? input.agent_id ?? null;
    const squadId = input.squadId ?? input.squad_id ?? null;
    if (Boolean(agentId) === Boolean(squadId)) throw new Error("exactly one of agent_id or squad_id is required");

    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const projectId = input.projectId ?? input.project_id ?? null;
    if (projectId) {
      const project = this.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (project.workspaceId !== workspaceId) throw new Error("Project belongs to another workspace");
    }

    const assigneeType: MulticaAssigneeType = squadId ? "squad" : "agent";
    const assigneeId = squadId ?? agentId!;
    this.validateIssueAssignee(assigneeType, assigneeId);
    const taskAgent = this.resolveRunnableAgentForAssignee(assigneeType, assigneeId);
    if (!taskAgent) throw new Error(`No runnable agent for ${assigneeType}: ${assigneeId}`);

    const issue = this.createIssue({
      title: quickCreateTitle(prompt),
      description: prompt,
      workspaceId,
      projectId,
      assigneeType,
      assigneeId,
      status: "in_progress",
      createdBy: input.requesterId ?? input.requester_id ?? null,
      contextRefs: [{ type: "quick_create", prompt }],
    });
    const task = this.createTask({
      agentId: taskAgent.id,
      issueId: issue.id,
      workspaceId,
      prompt: quickCreateTaskPrompt(prompt, projectId),
    });
    this.appendIssueActivity(issue.id, {
      actorType: "system",
      actorId: input.requesterId ?? input.requester_id ?? null,
      type: "quick_create_queued",
      body: prompt,
      data: { taskId: task.id, assigneeType, assigneeId, projectId },
    });
    return { issue: this.getIssue(issue.id)!, task };
  }

  createIssueComment(issueId: string, input: CreateIssueCommentInput): MulticaIssueComment {
    if (!input.body?.trim()) throw new Error("Comment body is required");
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const parentId = input.parentId ?? input.parent_id ?? null;
    if (parentId) {
      const parent = this.getIssueComment(parentId);
      if (!parent || parent.issueId !== issueId) throw new Error(`Parent comment not found: ${parentId}`);
    }
    const id = createId("cmt");
    const now = nowIso();
    const body = input.body.trim();
    this.db.run(
      `INSERT INTO multica_issue_comments (id, issue_id, author_type, author_id, parent_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, issueId, input.authorType ?? "member", input.authorId ?? null, parentId, body, now, now],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, issueId, attachmentIds);
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    if (parentId) this.unresolveThreadRoot(parentId);
    const authorType = input.authorType ?? "member";
    if (authorType === "member" && input.authorId) {
      this.addIssueSubscriber(issueId, input.authorId, "commented");
    }
    this.appendIssueActivity(issueId, {
      actorType: authorType,
      actorId: input.authorId ?? null,
      type: "comment_created",
      body,
      data: { commentId: id },
    });
    const comment = this.getIssueComment(id)!;
    const mentionedMemberIds = this.triggerMemberMentions(issue, comment);
    this.notifySubscribedMembers(issue, "comment_created", "New comment", body, authorType, input.authorId ?? null, mentionedMemberIds);
    this.triggerCommentMentions(issue, comment);
    return comment;
  }

  updateIssueComment(id: string, input: UpdateIssueCommentInput): MulticaIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const body = (input.body ?? input.content ?? "").trim();
    if (!body) throw new Error("Comment body is required");
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issue_comments SET body = ?, updated_at = ? WHERE id = ?",
      [body, now, id],
    );
    const attachmentIds = input.attachmentIds ?? input.attachment_ids ?? [];
    if (attachmentIds.length) this.linkAttachmentsToComment(id, current.issueId, attachmentIds);
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_updated",
      body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  deleteIssueComment(id: string): void {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    const ids = this.collectCommentTreeIds(id);
    const now = nowIso();
    for (const commentId of ids) {
      this.db.run("DELETE FROM multica_comment_reactions WHERE comment_id = ?", [commentId]);
      this.db.run("DELETE FROM multica_attachments WHERE comment_id = ?", [commentId]);
    }
    for (const commentId of ids.slice().reverse()) {
      this.db.run("DELETE FROM multica_issue_comments WHERE id = ?", [commentId]);
    }
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_deleted",
      body: current.body,
      data: { commentId: id, deletedCommentIds: ids },
    });
  }

  resolveIssueComment(id: string, input: { actorType?: string; actorId?: string | null } = {}): MulticaIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_issue_comments
       SET resolved_at = ?, resolved_by_type = ?, resolved_by_id = ?, updated_at = ?
       WHERE id = ?`,
      [now, input.actorType ?? "member", input.actorId ?? "local", now, id],
    );
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: input.actorType ?? "member",
      actorId: input.actorId ?? "local",
      type: "comment_resolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  unresolveIssueComment(id: string): MulticaIssueComment {
    const current = this.getRawIssueComment(id);
    if (!current) throw new Error(`Comment not found: ${id}`);
    if (current.parentId) throw new Error("Only root comments can be resolved");
    if (!current.resolvedAt) return this.getIssueComment(id)!;
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [now, id],
    );
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, current.issueId]);
    this.appendIssueActivity(current.issueId, {
      actorType: "system",
      actorId: null,
      type: "comment_unresolved",
      body: current.body,
      data: { commentId: id },
    });
    return this.getIssueComment(id)!;
  }

  getIssueComment(id: string): MulticaIssueComment | null {
    const row = this.db.query("SELECT * FROM multica_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? this.hydrateIssueComment(toIssueComment(row)) : null;
  }

  listIssueComments(issueId: string): MulticaIssueComment[] {
    const rows = this.db.query(
      "SELECT * FROM multica_issue_comments WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map((row) => this.hydrateIssueComment(toIssueComment(row)));
  }

  listIssueActivity(issueId: string): MulticaIssueActivity[] {
    const rows = this.db.query(
      "SELECT * FROM multica_issue_activity WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueActivity);
  }

  listIssueTimeline(issueId: string, options: { ascending?: boolean } = {}): MulticaTimelineEntry[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const entries: MulticaTimelineEntry[] = [
      ...this.listIssueComments(issueId).map(commentToTimelineEntry),
      ...this.listIssueActivity(issueId).map(activityToTimelineEntry),
    ];
    const ascending = options.ascending !== false;
    return entries.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return ascending ? left.createdAt.localeCompare(right.createdAt) : right.createdAt.localeCompare(left.createdAt);
      }
      return ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id);
    });
  }

  listIssueSubscribers(issueId: string): MulticaIssueSubscriber[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_issue_subscribers WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueSubscriber);
  }

  addIssueSubscriber(issueId: string, memberId: string, reason: MulticaSubscriptionReason = "manual"): MulticaIssueSubscriber {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const member = this.getWorkspaceMember(memberId);
    if (!member) throw new Error(`Member not found: ${memberId}`);
    if (member.archivedAt) throw new Error(`Member is archived: ${memberId}`);
    const now = nowIso();
    const id = createId("sub");
    this.db.run(
      `INSERT INTO multica_issue_subscribers (id, issue_id, member_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, member_id) DO UPDATE SET reason = excluded.reason`,
      [id, issueId, memberId, reason, now],
    );
    const row = this.db.query(
      "SELECT * FROM multica_issue_subscribers WHERE issue_id = ? AND member_id = ?",
    ).get(issueId, memberId) as Row | null;
    return toIssueSubscriber(row!);
  }

  removeIssueSubscriber(issueId: string, memberId: string): void {
    this.db.run("DELETE FROM multica_issue_subscribers WHERE issue_id = ? AND member_id = ?", [issueId, memberId]);
  }

  listLabels(workspaceId?: string | null): MulticaLabel[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_issue_labels WHERE workspace_id = ? ORDER BY lower(name) ASC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_issue_labels ORDER BY workspace_id ASC, lower(name) ASC").all() as Row[];
    return rows.map(toLabel);
  }

  getLabel(id: string): MulticaLabel | null {
    const row = this.db.query("SELECT * FROM multica_issue_labels WHERE id = ?").get(id) as Row | null;
    return row ? toLabel(row) : null;
  }

  createLabel(input: CreateLabelInput): MulticaLabel {
    const name = normalizeLabelName(input.name);
    const color = normalizeLabelColor(input.color);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const existing = this.db.query(
      "SELECT id FROM multica_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?)",
    ).get(workspaceId, name) as Row | null;
    if (existing) throw new Error(`Label already exists in workspace: ${name}`);
    const id = input.id ?? createId("lbl");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_issue_labels (id, workspace_id, name, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, name, color, now, now],
    );
    return this.getLabel(id)!;
  }

  updateLabel(id: string, input: UpdateLabelInput): MulticaLabel {
    const current = this.getLabel(id);
    if (!current) throw new Error(`Label not found: ${id}`);
    const name = input.name === undefined ? current.name : normalizeLabelName(input.name);
    const color = input.color === undefined ? current.color : normalizeLabelColor(input.color);
    const duplicate = this.db.query(
      "SELECT id FROM multica_issue_labels WHERE workspace_id = ? AND lower(name) = lower(?) AND id != ?",
    ).get(current.workspaceId, name, id) as Row | null;
    if (duplicate) throw new Error(`Label already exists in workspace: ${name}`);
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issue_labels SET name = ?, color = ?, updated_at = ? WHERE id = ?",
      [name, color, now, id],
    );
    return this.getLabel(id)!;
  }

  deleteLabel(id: string): MulticaLabel {
    const label = this.getLabel(id);
    if (!label) throw new Error(`Label not found: ${id}`);
    this.db.run("DELETE FROM multica_issue_labels WHERE id = ?", [id]);
    return label;
  }

  listLabelsForIssue(issueId: string): MulticaLabel[] {
    const issue = this.db.query("SELECT id FROM multica_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      `SELECT l.*
       FROM multica_issue_labels l
       JOIN multica_issue_to_labels il ON il.label_id = l.id
       WHERE il.issue_id = ?
       ORDER BY lower(l.name) ASC`,
    ).all(issueId) as Row[];
    return rows.map(toLabel);
  }

  attachLabelToIssue(issueId: string, labelId: string): MulticaLabel[] {
    const issueRow = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.db.query(
      "SELECT 1 FROM multica_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (existing) return this.listLabelsForIssue(issueId);
    this.db.run(
      "INSERT OR IGNORE INTO multica_issue_to_labels (issue_id, label_id) VALUES (?, ?)",
      [issueId, labelId],
    );
    const now = nowIso();
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_attached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  detachLabelFromIssue(issueId: string, labelId: string): MulticaLabel[] {
    const issueRow = this.db.query("SELECT * FROM multica_issues WHERE id = ?").get(issueId) as Row | null;
    if (!issueRow) throw new Error(`Issue not found: ${issueId}`);
    const issue = toIssue(issueRow);
    const label = this.getLabel(labelId);
    if (!label) throw new Error(`Label not found: ${labelId}`);
    if (label.workspaceId !== issue.workspaceId) throw new Error("Label belongs to another workspace");
    const existing = this.db.query(
      "SELECT 1 FROM multica_issue_to_labels WHERE issue_id = ? AND label_id = ?",
    ).get(issueId, labelId) as Row | null;
    if (!existing) return this.listLabelsForIssue(issueId);
    this.db.run("DELETE FROM multica_issue_to_labels WHERE issue_id = ? AND label_id = ?", [issueId, labelId]);
    const now = nowIso();
    this.db.run("UPDATE multica_issues SET updated_at = ? WHERE id = ?", [now, issueId]);
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "label_detached",
      body: label.name,
      data: { labelId, color: label.color },
    });
    return this.listLabelsForIssue(issueId);
  }

  listInboxItems(memberId?: string | null): MulticaInboxItem[] {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return [];
    const rows = this.db.query(
      "SELECT * FROM multica_inbox_items WHERE member_id = ? AND archived = 0 ORDER BY created_at DESC",
    ).all(resolvedMemberId) as Row[];
    return rows.map((row) => toInboxItem(row, this.getIssue(String(row.issue_id))));
  }

  markInboxItemRead(id: string): MulticaInboxItem {
    const existing = this.db.query("SELECT issue_id FROM multica_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!existing) throw new Error(`Inbox item not found: ${id}`);
    this.db.run("UPDATE multica_inbox_items SET read = 1 WHERE id = ?", [id]);
    const row = this.db.query("SELECT * FROM multica_inbox_items WHERE id = ?").get(id) as Row | null;
    return toInboxItem(row!, this.getIssue(String(row!.issue_id)));
  }

  archiveInboxItem(id: string): MulticaInboxItem {
    const rowBefore = this.db.query("SELECT issue_id FROM multica_inbox_items WHERE id = ?").get(id) as { issue_id: string } | null;
    if (!rowBefore) throw new Error(`Inbox item not found: ${id}`);
    this.db.run("UPDATE multica_inbox_items SET archived = 1, read = 1 WHERE id = ?", [id]);
    const row = this.db.query("SELECT * FROM multica_inbox_items WHERE id = ?").get(id) as Row | null;
    return toInboxItem(row!, this.getIssue(String(row!.issue_id)));
  }

  countUnreadInboxItems(memberId?: string | null): number {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const row = this.db.query(
      "SELECT COUNT(*) AS count FROM multica_inbox_items WHERE member_id = ? AND archived = 0 AND read = 0",
    ).get(resolvedMemberId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  markAllInboxItemsRead(memberId?: string | null): number {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    const result = this.db.run(
      "UPDATE multica_inbox_items SET read = 1 WHERE member_id = ? AND archived = 0 AND read = 0",
      [resolvedMemberId],
    );
    return result.changes;
  }

  archiveAllInboxItems(memberId?: string | null, mode: "all" | "read" | "completed" = "all"): number {
    const resolvedMemberId = memberId ?? this.listWorkspaceMembers()[0]?.id ?? null;
    if (!resolvedMemberId) return 0;
    if (mode === "read") {
      return this.db.run(
        "UPDATE multica_inbox_items SET archived = 1, read = 1 WHERE member_id = ? AND archived = 0 AND read = 1",
        [resolvedMemberId],
      ).changes;
    }
    if (mode === "completed") {
      return this.db.run(
        `UPDATE multica_inbox_items
         SET archived = 1, read = 1
         WHERE member_id = ?
           AND archived = 0
           AND issue_id IN (
             SELECT id FROM multica_issues WHERE status IN ('done', 'completed', 'closed', 'cancelled')
           )`,
        [resolvedMemberId],
      ).changes;
    }
    return this.db.run(
      "UPDATE multica_inbox_items SET archived = 1, read = 1 WHERE member_id = ? AND archived = 0",
      [resolvedMemberId],
    ).changes;
  }

  listIssueReactions(issueId: string): MulticaIssueReaction[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_issue_reactions WHERE issue_id = ? ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toIssueReaction);
  }

  addIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MulticaIssueReaction {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      `INSERT INTO multica_issue_reactions (id, issue_id, workspace_id, actor_type, actor_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, actor_type, actor_id, emoji) DO NOTHING`,
      [createId("rxn"), issueId, issue.workspaceId, actorType, actorId, emoji, nowIso()],
    );
    const row = this.db.query(
      "SELECT * FROM multica_issue_reactions WHERE issue_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
    ).get(issueId, actorType, actorId, emoji) as Row | null;
    return toIssueReaction(row!);
  }

  removeIssueReaction(issueId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      "DELETE FROM multica_issue_reactions WHERE issue_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
      [issueId, actorType, actorId, emoji],
    );
  }

  listCommentReactions(commentId: string): MulticaCommentReaction[] {
    if (!this.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_comment_reactions WHERE comment_id = ? ORDER BY created_at ASC",
    ).all(commentId) as Row[];
    return rows.map(toCommentReaction);
  }

  addCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): MulticaCommentReaction {
    const comment = this.getRawIssueComment(commentId);
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    const issue = this.getIssue(comment.issueId);
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      `INSERT INTO multica_comment_reactions (id, comment_id, workspace_id, actor_type, actor_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(comment_id, actor_type, actor_id, emoji) DO NOTHING`,
      [createId("rxn"), commentId, issue?.workspaceId ?? "local", actorType, actorId, emoji, nowIso()],
    );
    const row = this.db.query(
      "SELECT * FROM multica_comment_reactions WHERE comment_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
    ).get(commentId, actorType, actorId, emoji) as Row | null;
    return toCommentReaction(row!);
  }

  removeCommentReaction(commentId: string, input: { actorType?: string; actorId?: string | null; emoji: string }): void {
    const actorType = input.actorType ?? "member";
    const actorId = input.actorId ?? "local";
    const emoji = input.emoji?.trim();
    if (!emoji) throw new Error("emoji is required");
    this.db.run(
      "DELETE FROM multica_comment_reactions WHERE comment_id = ? AND actor_type = ? AND actor_id = ? AND emoji = ?",
      [commentId, actorType, actorId, emoji],
    );
  }

  createAttachment(input: CreateAttachmentInput): MulticaAttachment {
    if (!input.filename?.trim()) throw new Error("filename is required");
    if (!input.url?.trim()) throw new Error("url is required");
    const issueId = input.issueId ?? input.issue_id ?? null;
    const commentId = input.commentId ?? input.comment_id ?? null;
    const issue = issueId ? this.getIssue(issueId) : null;
    const comment = commentId ? this.getRawIssueComment(commentId) : null;
    if (issueId && !issue) throw new Error(`Issue not found: ${issueId}`);
    if (commentId && !comment) throw new Error(`Comment not found: ${commentId}`);
    const workspaceId = input.workspaceId ?? input.workspace_id ?? issue?.workspaceId ?? (comment ? this.getIssue(comment.issueId)?.workspaceId : null) ?? "local";
    const id = input.id ?? createId("att");
    const uploaderType = input.uploaderType ?? input.uploader_type ?? "member";
    const uploaderId = input.uploaderId ?? input.uploader_id ?? "local";
    this.db.run(
      `INSERT INTO multica_attachments (
        id, workspace_id, issue_id, comment_id, uploader_type, uploader_id, filename, url, content_type, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        issueId,
        commentId,
        uploaderType,
        uploaderId,
        input.filename.trim(),
        input.url.trim(),
        input.contentType ?? input.content_type ?? "application/octet-stream",
        Math.max(0, Number(input.sizeBytes ?? input.size_bytes ?? 0)),
        nowIso(),
      ],
    );
    return this.getAttachment(id)!;
  }

  getAttachment(id: string): MulticaAttachment | null {
    const row = this.db.query("SELECT * FROM multica_attachments WHERE id = ?").get(id) as Row | null;
    return row ? toAttachment(row) : null;
  }

  deleteAttachment(id: string): MulticaAttachment | null {
    const attachment = this.getAttachment(id);
    if (!attachment) return null;
    this.db.run("DELETE FROM multica_attachments WHERE id = ?", [id]);
    return attachment;
  }

  listAttachmentsForIssue(issueId: string): MulticaAttachment[] {
    if (!this.getIssue(issueId)) throw new Error(`Issue not found: ${issueId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_attachments WHERE issue_id = ? AND comment_id IS NULL ORDER BY created_at ASC",
    ).all(issueId) as Row[];
    return rows.map(toAttachment);
  }

  listAttachmentsForComment(commentId: string): MulticaAttachment[] {
    if (!this.getRawIssueComment(commentId)) throw new Error(`Comment not found: ${commentId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_attachments WHERE comment_id = ? ORDER BY created_at ASC",
    ).all(commentId) as Row[];
    return rows.map(toAttachment);
  }

  linkAttachmentsToIssue(issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      this.db.run(
        "UPDATE multica_attachments SET issue_id = ?, workspace_id = ? WHERE id = ? AND issue_id IS NULL",
        [issueId, issue.workspaceId, attachmentId],
      );
    }
  }

  listIssueMetadata(issueId: string): Record<string, string | number | boolean> {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    return issue.metadata;
  }

  setIssueMetadataKey(issueId: string, key: string, value: unknown): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const normalized = validateIssueMetadataValue(value);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    if (!(key in metadata) && Object.keys(metadata).length >= MAX_ISSUE_METADATA_KEYS) {
      throw new Error(`metadata cannot exceed ${MAX_ISSUE_METADATA_KEYS} keys`);
    }
    metadata[key] = normalized;
    validateIssueMetadataSize(metadata);
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_set",
      body: `${key}=${String(normalized)}`,
      data: { key, value: normalized },
    });
    return this.listIssueMetadata(issueId);
  }

  deleteIssueMetadataKey(issueId: string, key: string): Record<string, string | number | boolean> {
    validateIssueMetadataKey(key);
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const metadata = { ...issue.metadata };
    delete metadata[key];
    const now = nowIso();
    this.db.run(
      "UPDATE multica_issues SET metadata = ?, updated_at = ? WHERE id = ?",
      [toJson(metadata), now, issueId],
    );
    this.appendIssueActivity(issueId, {
      actorType: "system",
      actorId: null,
      type: "issue_metadata_deleted",
      body: key,
      data: { key },
    });
    return this.listIssueMetadata(issueId);
  }

  private appendIssueActivity(issueId: string, input: {
    actorType: string;
    actorId?: string | null;
    type: string;
    body?: string | null;
    data?: unknown | null;
  }): void {
    this.db.run(
      `INSERT INTO multica_issue_activity (id, issue_id, actor_type, actor_id, type, body, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId("act"),
        issueId,
        input.actorType,
        input.actorId ?? null,
        input.type,
        input.body ?? null,
        input.data == null ? null : toJson(input.data),
        nowIso(),
      ],
    );
  }

  createProject(input: CreateProjectInput): MulticaProject {
    if (!input.title?.trim()) throw new Error("Project title is required");
    const id = input.id ?? createId("prj");
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO multica_projects (
          id, title, description, icon, status, priority, workspace_id,
          lead_type, lead_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title.trim(),
          input.description ?? null,
          input.icon ?? null,
          input.status ?? "planned",
          input.priority ?? "none",
          input.workspaceId ?? "local",
          input.leadType ?? null,
          input.leadId ?? null,
          now,
          now,
        ],
      );
      for (const resource of input.resources ?? []) {
        this.createProjectResource(id, resource);
      }
      return this.getProject(id)!;
    });
    return tx();
  }

  getProject(id: string): MulticaProject | null {
    const row = this.db.query(projectSelect("WHERE p.id = ?")).get(id) as Row | null;
    return row ? toProject(row) : null;
  }

  listProjects(workspaceId?: string | null): MulticaProject[] {
    const rows = workspaceId
      ? this.db.query(projectSelect("WHERE p.workspace_id = ? ORDER BY p.updated_at DESC")).all(workspaceId) as Row[]
      : this.db.query(projectSelect("ORDER BY p.updated_at DESC")).all() as Row[];
    return rows.map(toProject);
  }

  searchProjects(input: { q: string; workspaceId?: string | null; includeClosed?: boolean; limit?: number; offset?: number }): { projects: MulticaProjectSearchResult[]; total: number } {
    const query = normalizeSearchQuery(input.q);
    if (!query) throw new Error("q parameter is required");
    const workspaceId = input.workspaceId ?? "local";
    const includeClosed = Boolean(input.includeClosed);
    const limit = clampSearchLimit(input.limit);
    const offset = Math.max(0, Number(input.offset ?? 0));
    const rows = this.listProjects(workspaceId).filter((project) => {
      if (!includeClosed && ["completed", "cancelled"].includes(project.status)) return false;
      return searchMatch(project.title, query) || searchMatch(project.description ?? "", query);
    }).map((project) => {
      const matchSource = searchMatch(project.title, query) ? "title" : "description";
      const result: MulticaProjectSearchResult = {
        ...project,
        matchSource,
      };
      if (matchSource === "description" && project.description) result.matchedSnippet = extractSearchSnippet(project.description, query);
      return result;
    }).sort((left, right) => searchRank(left.matchSource) - searchRank(right.matchSource) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { projects: rows.slice(offset, offset + limit), total: rows.length };
  }

  updateProject(id: string, input: UpdateProjectInput): MulticaProject {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_projects SET
        title = ?,
        description = ?,
        icon = ?,
        status = ?,
        priority = ?,
        lead_type = ?,
        lead_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.icon === undefined ? current.icon : input.icon,
        input.status ?? current.status,
        input.priority ?? current.priority,
        input.leadType === undefined ? current.leadType : input.leadType,
        input.leadId === undefined ? current.leadId : input.leadId,
        now,
        id,
      ],
    );
    return this.getProject(id)!;
  }

  archiveProject(id: string): MulticaProject {
    return this.updateProject(id, { status: "cancelled" });
  }

  listPinnedItems(workspaceId?: string | null, userId?: string | null): MulticaPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const rows = this.db.query(
      `SELECT * FROM multica_pinned_items
       WHERE workspace_id = ? AND user_id = ?
       ORDER BY position ASC, created_at ASC`,
    ).all(resolvedWorkspaceId, resolvedUserId) as Row[];
    return rows.map(toPinnedItem);
  }

  createPinnedItem(input: CreatePinnedItemInput): MulticaPinnedItem {
    const itemType = normalizePinnedItemType(input.itemType ?? input.item_type);
    const itemId = String(input.itemId ?? input.item_id ?? "").trim();
    if (!itemId) throw new Error("item_id is required");
    const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
    const userId = input.userId ?? input.user_id ?? "local";
    this.validatePinnedItemTarget(workspaceId, itemType, itemId);
    const existing = this.db.query(
      "SELECT id FROM multica_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
    ).get(workspaceId, userId, itemType, itemId) as Row | null;
    if (existing) throw new Error("Item already pinned");
    const maxRow = this.db.query(
      "SELECT COALESCE(MAX(position), 0) AS max_position FROM multica_pinned_items WHERE workspace_id = ? AND user_id = ?",
    ).get(workspaceId, userId) as Row | null;
    const id = input.id ?? createId("pin");
    const position = Number(maxRow?.max_position ?? 0) + 1;
    this.db.run(
      `INSERT INTO multica_pinned_items (id, workspace_id, user_id, item_type, item_id, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, userId, itemType, itemId, position, nowIso()],
    );
    return this.getPinnedItem(id)!;
  }

  getPinnedItem(id: string): MulticaPinnedItem | null {
    const row = this.db.query("SELECT * FROM multica_pinned_items WHERE id = ?").get(id) as Row | null;
    return row ? toPinnedItem(row) : null;
  }

  deletePinnedItem(workspaceId: string | null | undefined, userId: string | null | undefined, itemType: string, itemId: string): void {
    const normalizedType = normalizePinnedItemType(itemType);
    this.db.run(
      "DELETE FROM multica_pinned_items WHERE workspace_id = ? AND user_id = ? AND item_type = ? AND item_id = ?",
      [workspaceId ?? "local", userId ?? "local", normalizedType, itemId],
    );
  }

  reorderPinnedItems(workspaceId: string | null | undefined, userId: string | null | undefined, items: ReorderPinnedItemInput[]): MulticaPinnedItem[] {
    const resolvedWorkspaceId = workspaceId ?? "local";
    const resolvedUserId = userId ?? "local";
    const tx = this.db.transaction(() => {
      for (const item of items) {
        if (!item.id) throw new Error("items[].id is required");
        const position = Number(item.position);
        if (!Number.isFinite(position)) throw new Error("items[].position must be a finite number");
        this.db.run(
          "UPDATE multica_pinned_items SET position = ? WHERE id = ? AND workspace_id = ? AND user_id = ?",
          [position, item.id, resolvedWorkspaceId, resolvedUserId],
        );
      }
      return this.listPinnedItems(resolvedWorkspaceId, resolvedUserId);
    });
    return tx();
  }

  listProjectResources(projectId: string): MulticaProjectResource[] {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_project_resources WHERE project_id = ? ORDER BY position ASC, created_at ASC",
    ).all(projectId) as Row[];
    return rows.map(toProjectResource);
  }

  createProjectResource(projectId: string, input: CreateProjectResourceInput): MulticaProjectResource {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const resourceType = String(input.resourceType ?? input.resource_type ?? "").trim();
    const rawRef = input.resourceRef ?? input.resource_ref ?? {};
    const resourceRef = normalizeProjectResourceRef(resourceType, rawRef);
    const id = input.id ?? createId("res");
    const now = nowIso();
    const position = input.position ?? this.countProjectResources(projectId);
    this.db.run(
      `INSERT INTO multica_project_resources (
        id, project_id, workspace_id, resource_type, resource_ref, label, position, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        project.workspaceId,
        resourceType,
        toJson(resourceRef),
        input.label ?? null,
        position,
        now,
        input.createdBy ?? null,
      ],
    );
    this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
    return this.getProjectResource(id)!;
  }

  getProjectResource(id: string): MulticaProjectResource | null {
    const row = this.db.query("SELECT * FROM multica_project_resources WHERE id = ?").get(id) as Row | null;
    return row ? toProjectResource(row) : null;
  }

  deleteProjectResource(projectId: string, resourceId: string): void {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const now = nowIso();
    const result = this.db.run(
      "DELETE FROM multica_project_resources WHERE project_id = ? AND id = ?",
      [projectId, resourceId],
    );
    if (result.changes === 0) throw new Error(`Project resource not found: ${resourceId}`);
    this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, projectId]);
  }

  createSquad(input: CreateSquadInput): MulticaSquad {
    if (!input.name?.trim()) throw new Error("Squad name is required");
    if (input.leaderId && !this.getAgent(input.leaderId)) throw new Error(`Agent not found: ${input.leaderId}`);
    const id = input.id ?? createId("sqd");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_squads (
        id, name, description, instructions, workspace_id, leader_id,
        creator_id, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.description ?? "",
        input.instructions ?? "",
        input.workspaceId ?? "local",
        input.leaderId ?? null,
        input.creatorId ?? null,
        now,
        now,
      ],
    );
    if (input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId: input.leaderId, role: "leader" });
    for (const memberId of input.memberIds ?? []) {
      if (memberId !== input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId, role: "member" });
    }
    return this.getSquad(id)!;
  }

  getSquad(id: string): MulticaSquad | null {
    const row = this.db.query(squadSelect("WHERE s.id = ?")).get(id) as Row | null;
    return row ? toSquad(row) : null;
  }

  listSquads(workspaceId?: string | null): MulticaSquad[] {
    const rows = workspaceId
      ? this.db.query(squadSelect("WHERE s.workspace_id = ? AND s.archived_at IS NULL ORDER BY s.updated_at DESC")).all(workspaceId) as Row[]
      : this.db.query(squadSelect("WHERE s.archived_at IS NULL ORDER BY s.updated_at DESC")).all() as Row[];
    return rows.map(toSquad);
  }

  updateSquad(id: string, input: UpdateSquadInput): MulticaSquad {
    const current = this.getSquad(id);
    if (!current) throw new Error(`Squad not found: ${id}`);
    if (input.leaderId && !this.getAgent(input.leaderId)) throw new Error(`Agent not found: ${input.leaderId}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_squads SET
        name = ?,
        description = ?,
        instructions = ?,
        leader_id = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.name ?? current.name,
        input.description === undefined ? current.description : input.description ?? "",
        input.instructions === undefined ? current.instructions : input.instructions ?? "",
        input.leaderId === undefined ? current.leaderId : input.leaderId,
        now,
        id,
      ],
    );
    if (input.leaderId) this.addSquadMember(id, { memberType: "agent", memberId: input.leaderId, role: "leader" });
    return this.getSquad(id)!;
  }

  archiveSquad(id: string): MulticaSquad {
    if (!this.getSquad(id)) throw new Error(`Squad not found: ${id}`);
    const now = nowIso();
    this.db.run("UPDATE multica_squads SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    return this.getSquad(id)!;
  }

  addSquadMember(squadId: string, input: AddSquadMemberInput): MulticaSquadMember {
    const squad = this.getSquad(squadId);
    if (!squad) throw new Error(`Squad not found: ${squadId}`);
    if (input.memberType === "agent") {
      const agent = this.getAgent(input.memberId);
      if (!agent) throw new Error(`Agent not found: ${input.memberId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${input.memberId}`);
    } else if (input.memberType === "member") {
      const member = this.getWorkspaceMember(input.memberId);
      if (!member) throw new Error(`Member not found: ${input.memberId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${input.memberId}`);
    }
    const now = nowIso();
    const existing = this.db.query(
      "SELECT * FROM multica_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
    ).get(squadId, input.memberType, input.memberId) as Row | null;
    if (existing) {
      this.db.run(
        "UPDATE multica_squad_members SET role = ? WHERE id = ?",
        [input.role ?? "member", String(existing.id)],
      );
      return this.getSquadMember(String(existing.id))!;
    }
    const id = createId("sqm");
    this.db.run(
      `INSERT INTO multica_squad_members (id, squad_id, member_type, member_id, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, squadId, input.memberType, input.memberId, input.role ?? "member", now],
    );
    this.db.run("UPDATE multica_squads SET updated_at = ? WHERE id = ?", [now, squadId]);
    return this.getSquadMember(id)!;
  }

  removeSquadMember(squadId: string, input: RemoveSquadMemberInput): void {
    const now = nowIso();
    this.db.run(
      "DELETE FROM multica_squad_members WHERE squad_id = ? AND member_type = ? AND member_id = ?",
      [squadId, input.memberType, input.memberId],
    );
    const squad = this.getSquad(squadId);
    if (squad?.leaderId === input.memberId && input.memberType === "agent") {
      this.db.run("UPDATE multica_squads SET leader_id = NULL, updated_at = ? WHERE id = ?", [now, squadId]);
    } else {
      this.db.run("UPDATE multica_squads SET updated_at = ? WHERE id = ?", [now, squadId]);
    }
  }

  getSquadMember(id: string): MulticaSquadMember | null {
    const row = this.db.query("SELECT * FROM multica_squad_members WHERE id = ?").get(id) as Row | null;
    return row ? toSquadMember(row) : null;
  }

  listSquadMembers(squadId: string): MulticaSquadMember[] {
    const rows = this.db.query(
      "SELECT * FROM multica_squad_members WHERE squad_id = ? ORDER BY role = 'leader' DESC, created_at ASC",
    ).all(squadId) as Row[];
    return rows.map(toSquadMember);
  }

  createAutopilot(input: CreateAutopilotInput): MulticaAutopilot {
    if (!input.title?.trim()) throw new Error("Autopilot title is required");
    const assigneeType = input.assigneeType ?? "agent";
    if (assigneeType === "agent" && !this.getAgent(input.assigneeId)) throw new Error(`Agent not found: ${input.assigneeId}`);
    if (assigneeType === "squad" && !this.getSquad(input.assigneeId)) throw new Error(`Squad not found: ${input.assigneeId}`);
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    const id = input.id ?? createId("aut");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_autopilots (
        id, title, description, project_id, workspace_id, assignee_type,
        assignee_id, status, execution_mode, issue_title_template,
        trigger_kind, trigger_label, cron_expression, last_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.title.trim(),
        input.description ?? null,
        input.projectId ?? null,
        input.workspaceId ?? "local",
        assigneeType,
        input.assigneeId,
        input.status ?? "active",
        input.executionMode ?? "create_issue",
        input.issueTitleTemplate ?? null,
        input.triggerKind ?? "manual",
        input.triggerLabel ?? null,
        input.cronExpression ?? null,
        now,
        now,
      ],
    );
    return this.getAutopilot(id)!;
  }

  getAutopilot(id: string): MulticaAutopilot | null {
    const row = this.db.query("SELECT * FROM multica_autopilots WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilot(row) : null;
  }

  listAutopilots(workspaceId?: string | null): MulticaAutopilot[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_autopilots WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_autopilots WHERE status != 'archived' ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toAutopilot);
  }

  updateAutopilot(id: string, input: UpdateAutopilotInput): MulticaAutopilot {
    const current = this.getAutopilot(id);
    if (!current) throw new Error(`Autopilot not found: ${id}`);
    const nextAssigneeType = input.assigneeType ?? current.assigneeType;
    const nextAssigneeId = input.assigneeId ?? current.assigneeId;
    if (nextAssigneeType === "agent" && !this.getAgent(nextAssigneeId)) throw new Error(`Agent not found: ${nextAssigneeId}`);
    if (nextAssigneeType === "squad" && !this.getSquad(nextAssigneeId)) throw new Error(`Squad not found: ${nextAssigneeId}`);
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_autopilots SET
        title = ?,
        description = ?,
        project_id = ?,
        assignee_type = ?,
        assignee_id = ?,
        status = ?,
        execution_mode = ?,
        issue_title_template = ?,
        trigger_kind = ?,
        trigger_label = ?,
        cron_expression = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.title ?? current.title,
        input.description === undefined ? current.description : input.description,
        input.projectId === undefined ? current.projectId : input.projectId,
        nextAssigneeType,
        nextAssigneeId,
        input.status ?? current.status,
        input.executionMode ?? current.executionMode,
        input.issueTitleTemplate === undefined ? current.issueTitleTemplate : input.issueTitleTemplate,
        input.triggerKind ?? current.triggerKind,
        input.triggerLabel === undefined ? current.triggerLabel : input.triggerLabel,
        input.cronExpression === undefined ? current.cronExpression : input.cronExpression,
        now,
        id,
      ],
    );
    return this.getAutopilot(id)!;
  }

  archiveAutopilot(id: string): MulticaAutopilot {
    return this.updateAutopilot(id, { status: "archived" });
  }

  listAutopilotTriggers(autopilotId: string): MulticaAutopilotTrigger[] {
    const rows = this.db.query(
      "SELECT * FROM multica_autopilot_triggers WHERE autopilot_id = ? ORDER BY created_at ASC",
    ).all(autopilotId) as Row[];
    return rows.map(toAutopilotTrigger);
  }

  getAutopilotTrigger(id: string): MulticaAutopilotTrigger | null {
    const row = this.db.query("SELECT * FROM multica_autopilot_triggers WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilotTrigger(row) : null;
  }

  getAutopilotTriggerByWebhookToken(token: string): MulticaAutopilotTrigger | null {
    const row = this.db.query("SELECT * FROM multica_autopilot_triggers WHERE webhook_token = ?").get(token) as Row | null;
    return row ? toAutopilotTrigger(row) : null;
  }

  createAutopilotTrigger(autopilotId: string, input: CreateAutopilotTriggerInput = {}): MulticaAutopilotTrigger {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const kind = input.kind ?? (input.cronExpression || input.cron_expression ? "schedule" : "webhook");
    const id = createId("trg");
    const now = nowIso();
    const webhookToken = kind === "webhook" ? createId("awt", 18) : null;
    this.db.run(
      `INSERT INTO multica_autopilot_triggers (
        id, autopilot_id, kind, enabled, cron_expression, timezone, next_run_at,
        webhook_token, webhook_url, label, signing_secret_hash, last_fired_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, ?)`,
      [
        id,
        autopilotId,
        kind,
        input.enabled === false ? 0 : 1,
        input.cronExpression ?? input.cron_expression ?? null,
        input.timezone ?? null,
        webhookToken,
        input.label ?? null,
        now,
        now,
      ],
    );
    this.db.run(
      "UPDATE multica_autopilots SET trigger_kind = ?, trigger_label = ?, cron_expression = ?, updated_at = ? WHERE id = ?",
      [kind, input.label ?? autopilot.triggerLabel, input.cronExpression ?? input.cron_expression ?? autopilot.cronExpression, now, autopilotId],
    );
    return this.getAutopilotTrigger(id)!;
  }

  updateAutopilotTrigger(autopilotId: string, triggerId: string, input: UpdateAutopilotTriggerInput): MulticaAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_autopilot_triggers SET
        enabled = ?,
        cron_expression = ?,
        timezone = ?,
        label = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        input.cronExpression ?? input.cron_expression ?? current.cronExpression,
        input.timezone === undefined ? current.timezone : input.timezone,
        input.label === undefined ? current.label : input.label,
        now,
        triggerId,
      ],
    );
    this.db.run(
      "UPDATE multica_autopilots SET trigger_label = ?, cron_expression = ?, updated_at = ? WHERE id = ?",
      [
        input.label === undefined ? current.label : input.label,
        input.cronExpression ?? input.cron_expression ?? current.cronExpression,
        now,
        autopilotId,
      ],
    );
    return this.getAutopilotTrigger(triggerId)!;
  }

  deleteAutopilotTrigger(autopilotId: string, triggerId: string): boolean {
    const result = this.db.run("DELETE FROM multica_autopilot_triggers WHERE id = ? AND autopilot_id = ?", [triggerId, autopilotId]);
    return result.changes > 0;
  }

  rotateAutopilotTriggerWebhookToken(autopilotId: string, triggerId: string): MulticaAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    const token = createId("awt", 18);
    this.db.run(
      "UPDATE multica_autopilot_triggers SET webhook_token = ?, updated_at = ? WHERE id = ?",
      [token, nowIso(), triggerId],
    );
    return this.getAutopilotTrigger(triggerId)!;
  }

  setAutopilotTriggerSigningSecret(autopilotId: string, triggerId: string, secret: string | null | undefined): MulticaAutopilotTrigger {
    const current = this.getAutopilotTrigger(triggerId);
    if (!current || current.autopilotId !== autopilotId) throw new Error(`Autopilot trigger not found: ${triggerId}`);
    this.db.run(
      "UPDATE multica_autopilot_triggers SET signing_secret_hash = ?, updated_at = ? WHERE id = ?",
      [secret ? "local-secret-set" : null, nowIso(), triggerId],
    );
    return this.getAutopilotTrigger(triggerId)!;
  }

  listAutopilotRuns(autopilotId: string): MulticaAutopilotRun[] {
    const rows = this.db.query(
      "SELECT * FROM multica_autopilot_runs WHERE autopilot_id = ? ORDER BY created_at DESC LIMIT 20",
    ).all(autopilotId) as Row[];
    return rows.map(toAutopilotRun);
  }

  runAutopilot(autopilotId: string, input: RunAutopilotInput = {}): MulticaAutopilotRun {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const now = nowIso();
    const runId = createId("run");
    const source = input.source ?? "manual";
    const prompt = (input.prompt || autopilot.issueTitleTemplate || autopilot.title).trim();
    const agent = this.resolveAutopilotAgent(autopilot);
    if (!agent || autopilot.status !== "active") {
      this.db.run(
        `INSERT INTO multica_autopilot_runs (
          id, autopilot_id, source, status, issue_id, task_id, triggered_at,
          completed_at, failure_reason, payload, result, created_at
        ) VALUES (?, ?, ?, 'skipped', NULL, NULL, ?, ?, ?, ?, NULL, ?)`,
        [
          runId,
          autopilotId,
          source,
          now,
          now,
          agent ? "Autopilot is not active" : "No runnable agent",
          input.payload == null ? null : toJson(input.payload),
          now,
        ],
      );
      this.db.run("UPDATE multica_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
      return this.getAutopilotRun(runId)!;
    }

    let issue: MulticaIssue | null = null;
    if (autopilot.executionMode === "create_issue") {
      issue = this.createIssue({
        title: prompt,
        description: autopilot.description,
        workspaceId: autopilot.workspaceId,
        projectId: autopilot.projectId,
        createdBy: autopilot.id,
      });
    }
    const task = this.createTask({
      agentId: agent.id,
      issueId: issue?.id ?? null,
      workspaceId: autopilot.workspaceId,
      prompt,
    });
    this.db.run(
      `INSERT INTO multica_autopilot_runs (
        id, autopilot_id, source, status, issue_id, task_id, triggered_at,
        completed_at, failure_reason, payload, result, created_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        runId,
        autopilotId,
        source,
        issue?.id ?? null,
        task.id,
        now,
        input.payload == null ? null : toJson(input.payload),
        toJson({ taskId: task.id, issueId: issue?.id ?? null }),
        now,
      ],
    );
    this.db.run("UPDATE multica_autopilots SET last_run_at = ?, updated_at = ? WHERE id = ?", [now, now, autopilotId]);
    return this.getAutopilotRun(runId)!;
  }

  getAutopilotRun(id: string): MulticaAutopilotRun | null {
    const row = this.db.query("SELECT * FROM multica_autopilot_runs WHERE id = ?").get(id) as Row | null;
    return row ? toAutopilotRun(row) : null;
  }

  listWebhookDeliveries(autopilotId: string, options: { includeRawBody?: boolean; limit?: number } = {}): MulticaWebhookDelivery[] {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const rawBodyColumn = options.includeRawBody ? "raw_body" : "NULL AS raw_body";
    const rows = this.db.query(
      `SELECT id, workspace_id, autopilot_id, trigger_id, provider, event, dedupe_key, dedupe_source,
        signature_status, status, attempt_count, selected_headers, content_type, ${rawBodyColumn},
        response_status, response_body, autopilot_run_id, replayed_from_delivery_id, error,
        received_at, last_attempt_at, created_at
       FROM multica_webhook_deliveries
       WHERE autopilot_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(autopilotId, limit) as Row[];
    return rows.map(toWebhookDelivery);
  }

  getWebhookDelivery(id: string): MulticaWebhookDelivery | null {
    const row = this.db.query("SELECT * FROM multica_webhook_deliveries WHERE id = ?").get(id) as Row | null;
    return row ? toWebhookDelivery(row) : null;
  }

  handleAutopilotWebhook(autopilotId: string, input: {
    payload?: unknown | null;
    rawBody?: string | null;
    headers?: Record<string, string | null | undefined>;
    prompt?: string | null;
    provider?: MulticaWebhookProvider | string | null;
    signatureStatus?: MulticaWebhookSignatureStatus | string | null;
    replayedFromDeliveryId?: string | null;
    triggerId?: string | null;
  } = {}): MulticaWebhookDeliveryResult {
    const autopilot = this.getAutopilot(autopilotId);
    if (!autopilot) throw new Error(`Autopilot not found: ${autopilotId}`);
    const trigger = input.triggerId ? this.getAutopilotTrigger(input.triggerId) : null;
    if (input.triggerId && (!trigger || trigger.autopilotId !== autopilotId)) throw new Error(`Autopilot trigger not found: ${input.triggerId}`);
    const provider = normalizeWebhookProvider(input.provider);
    const headers = normalizeWebhookHeaders(input.headers ?? {});
    const event = inferWebhookEvent(provider, headers, input.payload);
    const [dedupeKey, dedupeSource] = webhookDedupeKey(provider, headers);
    const signatureStatus = normalizeWebhookSignatureStatus(input.signatureStatus);
    const triggerId = trigger?.id ?? autopilot.id;
    const now = nowIso();
    if (dedupeKey) {
      const duplicate = this.db.query(
        `SELECT * FROM multica_webhook_deliveries
         WHERE trigger_id = ? AND dedupe_key = ? AND status NOT IN ('rejected', 'failed')
         ORDER BY created_at ASC LIMIT 1`,
      ).get(triggerId, dedupeKey) as Row | null;
      if (duplicate) {
        this.db.run(
          "UPDATE multica_webhook_deliveries SET attempt_count = attempt_count + 1, last_attempt_at = ? WHERE id = ?",
          [now, String(duplicate.id)],
        );
        const delivery = this.getWebhookDelivery(String(duplicate.id))!;
        const run = delivery.autopilotRunId ? this.getAutopilotRun(delivery.autopilotRunId) : null;
        return { status: "duplicate", duplicate: true, delivery, run };
      }
    }

    const deliveryId = createId("whd");
    this.db.run(
      `INSERT INTO multica_webhook_deliveries (
        id, workspace_id, autopilot_id, trigger_id, provider, event, dedupe_key, dedupe_source,
        signature_status, status, attempt_count, selected_headers, content_type, raw_body,
        response_status, response_body, autopilot_run_id, replayed_from_delivery_id, error,
        received_at, last_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
      [
        deliveryId,
        autopilot.workspaceId,
        autopilot.id,
        triggerId,
        provider,
        event,
        dedupeKey || null,
        dedupeSource || null,
        signatureStatus,
        toJson(selectedWebhookHeaders(headers)),
        headers["content-type"] ?? null,
        input.rawBody ?? (input.payload == null ? null : toJson(input.payload)),
        input.replayedFromDeliveryId ?? null,
        now,
        now,
        now,
      ],
    );

    if (signatureStatus === "invalid" || signatureStatus === "missing") {
      const reason = signatureStatus === "missing" ? "signature missing" : "signature invalid";
      const responseBody = { status: "rejected", deliveryId, reason };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "rejected",
        responseStatus: 401,
        responseBody,
        error: reason,
      });
      return { status: "rejected", duplicate: false, delivery, run: null };
    }

    if (autopilot.status !== "active" || (trigger && !trigger.enabled) || (trigger && trigger.kind !== "webhook") || (!trigger && autopilot.triggerKind !== "webhook")) {
      const reason = autopilot.status !== "active"
        ? `autopilot_${autopilot.status}`
        : trigger && !trigger.enabled
          ? "trigger_disabled"
          : "trigger_not_webhook";
      const responseBody = { status: "ignored", deliveryId, reason };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "ignored",
        responseStatus: 200,
        responseBody,
        error: reason,
      });
      return { status: "ignored", duplicate: false, delivery, run: null };
    }

    try {
      const run = this.runAutopilot(autopilot.id, {
        prompt: input.prompt ?? null,
        payload: input.payload ?? null,
        source: "webhook",
      });
      if (trigger) {
        this.db.run("UPDATE multica_autopilot_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?", [now, now, trigger.id]);
      }
      const responseStatus = run.status === "skipped" ? 200 : 201;
      const responseBody = { status: run.status === "skipped" ? "skipped" : "accepted", deliveryId, runId: run.id };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "dispatched",
        responseStatus,
        responseBody,
        autopilotRunId: run.id,
      });
      return { status: run.status === "skipped" ? "skipped" : "accepted", duplicate: false, delivery, run };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const responseBody = { status: "failed", deliveryId, error: message };
      const delivery = this.finalizeWebhookDelivery(deliveryId, {
        status: "failed",
        responseStatus: 500,
        responseBody,
        error: message,
      });
      return { status: "failed", duplicate: false, delivery, run: null };
    }
  }

  replayWebhookDelivery(autopilotId: string, deliveryId: string): MulticaWebhookDeliveryResult {
    const delivery = this.getWebhookDelivery(deliveryId);
    if (!delivery || delivery.autopilotId !== autopilotId) throw new Error(`Webhook delivery not found: ${deliveryId}`);
    if (delivery.status === "rejected" || delivery.signatureStatus === "invalid" || delivery.signatureStatus === "missing") {
      throw new Error("Cannot replay a rejected delivery");
    }
    const payload = delivery.rawBody ? parseJson(delivery.rawBody, null) : null;
    return this.handleAutopilotWebhook(autopilotId, {
      payload,
      rawBody: delivery.rawBody,
      headers: replayHeadersFromDelivery(delivery),
      provider: delivery.provider,
      signatureStatus: delivery.signatureStatus,
      replayedFromDeliveryId: delivery.id,
    });
  }

  handleAutopilotWebhookByToken(token: string, input: {
    payload?: unknown | null;
    rawBody?: string | null;
    headers?: Record<string, string | null | undefined>;
    prompt?: string | null;
    provider?: MulticaWebhookProvider | string | null;
    signatureStatus?: MulticaWebhookSignatureStatus | string | null;
  } = {}): MulticaWebhookDeliveryResult | null {
    const trigger = this.getAutopilotTriggerByWebhookToken(token);
    if (!trigger) return null;
    return this.handleAutopilotWebhook(trigger.autopilotId, { ...input, triggerId: trigger.id });
  }

  private finalizeWebhookDelivery(id: string, input: {
    status: MulticaWebhookDeliveryStatus;
    responseStatus: number;
    responseBody: unknown;
    autopilotRunId?: string | null;
    error?: string | null;
  }): MulticaWebhookDelivery {
    this.db.run(
      `UPDATE multica_webhook_deliveries SET
        status = ?,
        response_status = ?,
        response_body = ?,
        autopilot_run_id = ?,
        error = ?,
        last_attempt_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.responseStatus,
        typeof input.responseBody === "string" ? input.responseBody : toJson(input.responseBody),
        input.autopilotRunId ?? null,
        input.error ?? null,
        nowIso(),
        id,
      ],
    );
    return this.getWebhookDelivery(id)!;
  }

  createChatSession(input: CreateChatSessionInput): MulticaChatSession {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${input.agentId}`);
    const id = input.id ?? createId("chat");
    const now = nowIso();
    const title = input.title?.trim() || `Chat with ${agent.name}`;
    this.db.run(
      `INSERT INTO multica_chat_sessions (
        id, workspace_id, agent_id, title, status, session_id, work_dir, latest_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      [id, input.workspaceId ?? "local", input.agentId, title, now, now],
    );
    return this.getChatSession(id)!;
  }

  listChatSessions(workspaceId?: string | null): MulticaChatSession[] {
    const rows = workspaceId
      ? this.db.query("SELECT * FROM multica_chat_sessions WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC").all(workspaceId) as Row[]
      : this.db.query("SELECT * FROM multica_chat_sessions WHERE status != 'archived' ORDER BY updated_at DESC").all() as Row[];
    return rows.map(toChatSession);
  }

  getChatSession(id: string): MulticaChatSession | null {
    const row = this.db.query("SELECT * FROM multica_chat_sessions WHERE id = ?").get(id) as Row | null;
    return row ? toChatSession(row) : null;
  }

  updateChatSession(id: string, input: UpdateChatSessionInput): MulticaChatSession {
    const current = this.getChatSession(id);
    if (!current) throw new Error(`Chat session not found: ${id}`);
    const now = nowIso();
    this.db.run(
      `UPDATE multica_chat_sessions
       SET title = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [input.title?.trim() || current.title, input.status ?? current.status, now, id],
    );
    return this.getChatSession(id)!;
  }

  deleteChatSession(id: string): boolean {
    const current = this.getChatSession(id);
    if (!current) return false;
    for (const task of this.listTasks().filter((task) => task.chatSessionId === id)) {
      if (task.status === "queued" || task.status === "dispatched" || task.status === "running") {
        this.cancelTask(task.id);
      }
    }
    this.updateChatSession(id, { status: "archived" });
    return true;
  }

  markChatSessionRead(id: string): void {
    if (!this.getChatSession(id)) throw new Error(`Chat session not found: ${id}`);
    this.db.run("UPDATE multica_chat_sessions SET updated_at = ? WHERE id = ?", [nowIso(), id]);
  }

  getPendingChatTask(chatSessionId: string): MulticaTask | null {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    return this.listTasks()
      .filter((task) =>
        task.chatSessionId === chatSessionId &&
        (task.status === "queued" || task.status === "dispatched" || task.status === "running")
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  }

  listPendingChatTasks(workspaceId?: string | null): MulticaTask[] {
    return this.listTasks()
      .filter((task) =>
        task.chatSessionId &&
        (workspaceId ? task.workspaceId === workspaceId : true) &&
        (task.status === "queued" || task.status === "dispatched" || task.status === "running")
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  listChatMessages(chatSessionId: string): MulticaChatMessage[] {
    if (!this.getChatSession(chatSessionId)) throw new Error(`Chat session not found: ${chatSessionId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC",
    ).all(chatSessionId) as Row[];
    return rows.map(toChatMessage);
  }

  sendChatMessage(chatSessionId: string, input: SendChatMessageInput): SendChatMessageResult {
    const session = this.getChatSession(chatSessionId);
    if (!session) throw new Error(`Chat session not found: ${chatSessionId}`);
    if (session.status === "archived") throw new Error(`Chat session is archived: ${chatSessionId}`);
    const body = input.body?.trim();
    if (!body) throw new Error("Chat message body is required");
    const now = nowIso();
    const messageId = createId("msg");
    const task = this.createTask({
      agentId: session.agentId,
      chatSessionId: session.id,
      workspaceId: session.workspaceId,
      prompt: body,
      sessionId: session.sessionId,
      workDir: session.workDir,
    });
    this.db.run(
      `INSERT INTO multica_chat_messages (id, chat_session_id, task_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
      [messageId, session.id, task.id, body, now],
    );
    this.db.run(
      "UPDATE multica_chat_sessions SET latest_task_id = ?, updated_at = ? WHERE id = ?",
      [task.id, now, session.id],
    );
    return {
      session: this.getChatSession(session.id)!,
      message: this.getChatMessage(messageId)!,
      task,
    };
  }

  getChatMessage(id: string): MulticaChatMessage | null {
    const row = this.db.query("SELECT * FROM multica_chat_messages WHERE id = ?").get(id) as Row | null;
    return row ? toChatMessage(row) : null;
  }

  createTask(input: CreateTaskInput): MulticaTask {
    const agent = this.getAgent(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (agent.archivedAt) throw new Error(`Agent is archived: ${input.agentId}`);
    const issue = input.issueId ? this.getIssue(input.issueId) : null;
    if (input.issueId && !issue) throw new Error(`Issue not found: ${input.issueId}`);
    const chatSession = input.chatSessionId ? this.getChatSession(input.chatSessionId) : null;
    if (input.chatSessionId && !chatSession) throw new Error(`Chat session not found: ${input.chatSessionId}`);
    if (chatSession && chatSession.agentId !== input.agentId) throw new Error("Chat session agent does not match task agent");

    const id = input.id ?? createId("tsk");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_tasks (
        id, agent_id, issue_id, chat_session_id, workspace_id, status, priority, prompt,
        session_id, work_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.agentId,
        input.issueId ?? null,
        input.chatSessionId ?? null,
        input.workspaceId ?? issue?.workspaceId ?? chatSession?.workspaceId ?? "local",
        input.priority ?? 0,
        input.prompt,
        input.sessionId ?? chatSession?.sessionId ?? null,
        input.workDir ?? chatSession?.workDir ?? agent.cwd ?? null,
        now,
        now,
      ],
    );
    return this.getTask(id)!;
  }

  getTask(id: string): MulticaTask | null {
    const row = this.db.query("SELECT * FROM multica_tasks WHERE id = ?").get(id) as Row | null;
    return row ? toTask(row) : null;
  }

  getTaskWithAgent(id: string): MulticaTaskWithAgent | null {
    const task = this.getTask(id);
    if (!task) return null;
    const issue = task.issueId ? this.getIssue(task.issueId) : null;
    const project = issue?.projectId ? this.getProject(issue.projectId) : null;
    return {
      ...task,
      agent: this.getAgent(task.agentId),
      issue,
      project,
      projectResources: project ? this.listProjectResources(project.id) : [],
    };
  }

  listTasks(status?: MulticaTaskStatus): MulticaTask[] {
    const rows = status
      ? this.db.query("SELECT * FROM multica_tasks WHERE status = ? ORDER BY created_at DESC").all(status) as Row[]
      : this.db.query("SELECT * FROM multica_tasks ORDER BY created_at DESC").all() as Row[];
    return rows.map(toTask);
  }

  listAgentTasks(agentId: string): MulticaTask[] {
    if (!this.getAgent(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const rows = this.db.query(
      "SELECT * FROM multica_tasks WHERE agent_id = ? ORDER BY created_at DESC",
    ).all(agentId) as Row[];
    return rows.map(toTask);
  }

  listWorkspaceAgentTaskSnapshot(workspaceId = "local"): MulticaTask[] {
    const tasks = this.listTasks().filter((task) => task.workspaceId === workspaceId);
    const snapshot = new Map<string, MulticaTask>();
    for (const task of tasks) {
      if (task.status === "queued" || task.status === "dispatched" || task.status === "running") {
        snapshot.set(task.id, task);
      }
    }
    const latestOutcomeByAgent = new Map<string, MulticaTask>();
    for (const task of tasks.filter((item) => item.status === "completed" || item.status === "failed")) {
      const current = latestOutcomeByAgent.get(task.agentId);
      if (!current || outcomeTime(task) > outcomeTime(current)) latestOutcomeByAgent.set(task.agentId, task);
    }
    for (const task of latestOutcomeByAgent.values()) snapshot.set(task.id, task);
    return [...snapshot.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  listWorkspaceAgentRunCounts(workspaceId = "local", days = 30): MulticaAgentRunCount[] {
    const since = trailingWindowStart(days);
    const rows = this.db.query(
      `SELECT agent_id, COUNT(*) AS run_count
       FROM multica_tasks
       WHERE workspace_id = ? AND created_at > ?
       GROUP BY agent_id
       ORDER BY agent_id ASC`,
    ).all(workspaceId, since) as Row[];
    return rows.map((row) => {
      const agentId = String(row.agent_id);
      const runCount = Number(row.run_count ?? 0);
      return { agentId, agent_id: agentId, runCount, run_count: runCount };
    });
  }

  listWorkspaceAgentActivity30d(workspaceId = "local"): MulticaAgentActivityBucket[] {
    const since = trailingWindowStart(30);
    const rows = this.db.query(
      `SELECT
         agent_id,
         substr(completed_at, 1, 10) AS bucket_date,
         COUNT(*) AS task_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
       FROM multica_tasks
       WHERE workspace_id = ?
         AND completed_at IS NOT NULL
         AND completed_at > ?
       GROUP BY agent_id, bucket_date
       ORDER BY agent_id ASC, bucket_date ASC`,
    ).all(workspaceId, since) as Row[];
    return rows.map((row) => {
      const agentId = String(row.agent_id);
      const bucketAt = `${String(row.bucket_date)}T00:00:00.000Z`;
      const taskCount = Number(row.task_count ?? 0);
      const failedCount = Number(row.failed_count ?? 0);
      return {
        agentId,
        agent_id: agentId,
        bucketAt,
        bucket_at: bucketAt,
        taskCount,
        task_count: taskCount,
        failedCount,
        failed_count: failedCount,
      };
    });
  }

  claimTask(runtimeId: string): MulticaTaskWithAgent | null {
    const tx = this.db.transaction(() => {
      const runtime = this.getRuntime(runtimeId);
      if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);
      this.heartbeatRuntime(runtimeId, { claimPending: false });

      const active = this.db.query(
        "SELECT COUNT(*) AS count FROM multica_tasks WHERE runtime_id = ? AND status IN ('dispatched', 'running')",
      ).get(runtimeId) as { count: number } | null;
      if (Number(active?.count ?? 0) >= runtime.maxConcurrency) return null;

      const workspaceFilter = runtime.workspaceId ? "AND t.workspace_id = ?" : "";
      const params = runtime.workspaceId
        ? [runtime.workspaceId, runtime.provider, runtime.provider]
        : [runtime.provider, runtime.provider];
      const row = this.db.query(
        `SELECT t.*
         FROM multica_tasks t
         JOIN multica_agents a ON a.id = t.agent_id
         WHERE t.status = 'queued'
           AND a.archived_at IS NULL
           ${workspaceFilter}
           AND (? = 'any' OR a.provider = ?)
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT 1`,
      ).get(...params) as Row | null;

      if (!row) return null;

      const now = nowIso();
      const result = this.db.run(
        `UPDATE multica_tasks
         SET status = 'dispatched', runtime_id = ?, dispatched_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        [runtimeId, now, now, String(row.id)],
      );
      if (result.changes === 0) return null;
      return this.getTaskWithAgent(String(row.id));
    });
    return tx();
  }

  startTask(taskId: string): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('queued', 'dispatched', 'running')`,
      [now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    return this.getTask(taskId)!;
  }

  reportProgress(taskId: string, summary: string, step?: number | null, total?: number | null): void {
    this.db.run(
      `UPDATE multica_tasks
       SET progress_summary = ?, progress_step = ?, progress_total = ?, updated_at = ?
       WHERE id = ?`,
      [summary, step ?? null, total ?? null, nowIso(), taskId],
    );
  }

  pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): void {
    this.db.run(
      `UPDATE multica_tasks
       SET session_id = COALESCE(?, session_id), work_dir = COALESCE(?, work_dir), updated_at = ?
       WHERE id = ?`,
      [sessionId ?? null, workDir ?? null, nowIso(), taskId],
    );
  }

  appendTaskMessages(taskId: string, messages: TaskMessageInput[]): MulticaTaskMessage[] {
    if (messages.length === 0) return [];
    const current = this.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM multica_task_messages WHERE task_id = ?")
      .get(taskId) as { seq: number } | null;
    let nextSeq = Number(current?.seq ?? 0) + 1;
    const insertedSeqs: number[] = [];
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO multica_task_messages (
        id, task_id, seq, type, tool, content, input, output, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const message of messages) {
        const seq = message.seq ?? nextSeq++;
        insertedSeqs.push(seq);
        const id = createId("msg");
        insert.run(
          id,
          taskId,
          seq,
          message.type,
          message.tool ?? null,
          message.content ?? null,
          message.input == null ? null : toJson(message.input),
          message.output ?? null,
          nowIso(),
        );
      }
      this.db.run("UPDATE multica_tasks SET updated_at = ? WHERE id = ?", [nowIso(), taskId]);
    });
    tx();
    const inserted: MulticaTaskMessage[] = [];
    for (const seq of insertedSeqs) {
      const row = this.db.query(
        "SELECT * FROM multica_task_messages WHERE task_id = ? AND seq = ?",
      ).get(taskId, seq) as Row | null;
      if (row) inserted.push(toTaskMessage(row));
    }
    return inserted;
  }

  listTaskMessages(taskId: string): MulticaTaskMessage[] {
    const rows = this.db.query(
      "SELECT * FROM multica_task_messages WHERE task_id = ? ORDER BY seq ASC",
    ).all(taskId) as Row[];
    return rows.map(toTaskMessage);
  }

  completeTask(taskId: string, input: {
    output: string;
    branchName?: string | null;
    sessionId?: string | null;
    workDir?: string | null;
  }): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'completed',
           result = ?,
           branch_name = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           completed_at = ?,
           updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [input.output, input.branchName ?? null, input.sessionId ?? null, input.workDir ?? null, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "completed", input.output);
    return task;
  }

  failTask(taskId: string, input: {
    error: string;
    sessionId?: string | null;
    workDir?: string | null;
  }): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'failed',
           error = ?,
           session_id = COALESCE(?, session_id),
           work_dir = COALESCE(?, work_dir),
           failed_at = ?,
           updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [input.error, input.sessionId ?? null, input.workDir ?? null, now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "failed", input.error);
    return task;
  }

  cancelTask(taskId: string): MulticaTask {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, taskId],
    );
    if (result.changes === 0) throw new Error(`Task not found or terminal: ${taskId}`);
    const task = this.getTask(taskId)!;
    this.afterTaskTerminal(task, "cancelled", null);
    return task;
  }

  getTaskStatus(taskId: string): MulticaTaskStatus {
    const row = this.db.query("SELECT status FROM multica_tasks WHERE id = ?").get(taskId) as { status: string } | null;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row.status as MulticaTaskStatus;
  }

  reportTaskUsage(taskId: string, usage: TaskUsageEntry[]): void {
    this.db.run(
      "UPDATE multica_tasks SET usage = ?, updated_at = ? WHERE id = ?",
      [toJson(usage), nowIso(), taskId],
    );
  }

  recoverOrphans(runtimeId: string): number {
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multica_tasks
       SET status = 'queued',
           runtime_id = NULL,
           error = NULL,
           dispatched_at = NULL,
           started_at = NULL,
           updated_at = ?
       WHERE runtime_id = ? AND status IN ('dispatched', 'running')`,
      [now, runtimeId],
    );
    return result.changes;
  }

  private resolveRunnableAgentForAssignee(assigneeType: MulticaAssigneeType, assigneeId: string): MulticaAgent | null {
    if (assigneeType === "agent") {
      const agent = this.getAgent(assigneeId);
      return agent?.archivedAt ? null : agent;
    }
    if (assigneeType !== "squad") return null;
    const squad = this.getSquad(assigneeId);
    if (!squad) return null;
    if (squad.archivedAt) return null;
    if (squad.leaderId) {
      const leader = this.getAgent(squad.leaderId);
      if (leader && !leader.archivedAt) return leader;
    }
    for (const member of this.listSquadMembers(squad.id).filter((m) => m.memberType === "agent")) {
      const agent = this.getAgent(member.memberId);
      if (agent && !agent.archivedAt) return agent;
    }
    return null;
  }

  private resolveAutopilotAgent(autopilot: MulticaAutopilot): MulticaAgent | null {
    return this.resolveRunnableAgentForAssignee(autopilot.assigneeType, autopilot.assigneeId);
  }

  private validateIssueAssignee(assigneeType: MulticaAssigneeType | null, assigneeId: string | null): void {
    if (!assigneeType && !assigneeId) return;
    if (!assigneeType || !assigneeId) throw new Error("Assignee type and id are required together");
    if (assigneeType === "agent") {
      const agent = this.getAgent(assigneeId);
      if (!agent) throw new Error(`Agent not found: ${assigneeId}`);
      if (agent.archivedAt) throw new Error(`Agent is archived: ${assigneeId}`);
    } else if (assigneeType === "member") {
      const member = this.getWorkspaceMember(assigneeId);
      if (!member) throw new Error(`Member not found: ${assigneeId}`);
      if (member.archivedAt) throw new Error(`Member is archived: ${assigneeId}`);
    } else if (assigneeType === "squad") {
      const squad = this.getSquad(assigneeId);
      if (!squad) throw new Error(`Squad not found: ${assigneeId}`);
      if (squad.archivedAt) throw new Error(`Squad is archived: ${assigneeId}`);
    } else {
      throw new Error(`Unsupported assignee type: ${assigneeType}`);
    }
  }

  private validateIssueParent(issueId: string, parentIssueId: string): void {
    if (issueId === parentIssueId) throw new Error("An issue cannot be its own parent");
    let cursor: string | null = parentIssueId;
    const seen = new Set<string>();
    for (let depth = 0; cursor && depth < 100; depth++) {
      if (cursor === issueId) throw new Error("Circular parent issue relationship detected");
      if (seen.has(cursor)) throw new Error("Circular parent issue relationship detected");
      seen.add(cursor);
      cursor = this.getIssue(cursor)?.parentIssueId ?? null;
    }
  }

  private cancelActiveIssueTasks(issueId: string, reason: string): number {
    const active = this.db.query(
      "SELECT * FROM multica_tasks WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')",
    ).all(issueId) as Row[];
    if (!active.length) return 0;
    const now = nowIso();
    this.db.run(
      `UPDATE multica_tasks
       SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE issue_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [now, now, issueId],
    );
    for (const row of active) {
      this.appendIssueActivity(issueId, {
        actorType: "system",
        actorId: null,
        type: "task_cancelled",
        body: reason,
        data: { taskId: String(row.id), agentId: nullableString(row.agent_id) },
      });
    }
    return active.length;
  }

  private createInboxItem(input: {
    issueId: string;
    memberId: string;
    type: string;
    title: string;
    body?: string | null;
    actorType?: string;
    actorId?: string | null;
  }): MulticaInboxItem | null {
    const issue = this.getIssue(input.issueId);
    if (!issue) throw new Error(`Issue not found: ${input.issueId}`);
    const member = this.getWorkspaceMember(input.memberId);
    if (!member || member.archivedAt) return null;
    if (this.isNotificationMuted(issue.workspaceId, input.memberId, input.type)) return null;
    const id = createId("inb");
    const now = nowIso();
    this.db.run(
      `INSERT INTO multica_inbox_items (
        id, workspace_id, issue_id, member_id, actor_type, actor_id, type, title, body, read, archived, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        id,
        issue.workspaceId,
        issue.id,
        input.memberId,
        input.actorType ?? "system",
        input.actorId ?? null,
        input.type,
        input.title,
        input.body ?? null,
        now,
      ],
    );
    const row = this.db.query("SELECT * FROM multica_inbox_items WHERE id = ?").get(id) as Row | null;
    return toInboxItem(row!, issue);
  }

  private getRawIssueComment(id: string): MulticaIssueComment | null {
    const row = this.db.query("SELECT * FROM multica_issue_comments WHERE id = ?").get(id) as Row | null;
    return row ? toIssueComment(row) : null;
  }

  private hydrateIssue(issue: MulticaIssue): MulticaIssue {
    return {
      ...issue,
      labels: this.listLabelsForIssue(issue.id),
    };
  }

  private hydrateRuntime(runtime: MulticaRuntime): MulticaRuntime {
    const stats = this.runtimeUsageSummary(runtime.id);
    return {
      ...runtime,
      ...stats,
      models: this.listRuntimeModelsForExistingRuntime(runtime.id),
    };
  }

  private hydrateRuntimeLocalSkillImportRequest(request: MulticaRuntimeLocalSkillImportRequest): MulticaRuntimeLocalSkillImportRequest {
    return {
      ...request,
      skill: request.skill ?? (request.skillId ? this.getSkill(request.skillId) : null),
    };
  }

  private listRuntimeModelsForExistingRuntime(runtimeId: string): MulticaRuntimeModel[] {
    const rows = this.db.query("SELECT * FROM multica_runtime_models WHERE runtime_id = ? ORDER BY is_default DESC, label ASC").all(runtimeId) as Row[];
    return rows.map(toRuntimeModel);
  }

  private replaceRuntimeModels(runtimeId: string, models: MulticaRuntimeModel[], provider: string, now = nowIso()): void {
    const normalized = normalizeRuntimeModels(models, provider);
    this.db.transaction(() => {
      this.db.run("DELETE FROM multica_runtime_models WHERE runtime_id = ?", [runtimeId]);
      for (const model of normalized) {
        this.db.run(
          `INSERT INTO multica_runtime_models (
            runtime_id, model_id, label, provider, is_default, thinking, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runtimeId,
            model.id,
            model.label,
            model.provider,
            model.default ? 1 : 0,
            model.thinking ? toJson(model.thinking) : null,
            now,
            now,
          ],
        );
      }
    })();
  }

  private hydrateIssueComment(comment: MulticaIssueComment): MulticaIssueComment {
    return {
      ...comment,
      reactions: this.listCommentReactions(comment.id),
      attachments: this.listAttachmentsForComment(comment.id),
    };
  }

  private hydrateIssueDependency(dependency: MulticaIssueDependency): MulticaIssueDependency {
    return {
      ...dependency,
      issue: this.getIssue(dependency.issueId),
      dependsOnIssue: this.getIssue(dependency.dependsOnIssueId),
    };
  }

  private collectCommentTreeIds(commentId: string): string[] {
    const ids: string[] = [];
    const visit = (id: string) => {
      ids.push(id);
      const rows = this.db.query("SELECT id FROM multica_issue_comments WHERE parent_id = ? ORDER BY created_at ASC").all(id) as Row[];
      for (const row of rows) visit(String(row.id));
    };
    visit(commentId);
    return ids;
  }

  private unresolveThreadRoot(commentId: string): void {
    let current = this.getRawIssueComment(commentId);
    while (current?.parentId) current = this.getRawIssueComment(current.parentId);
    if (!current?.resolvedAt) return;
    this.db.run(
      "UPDATE multica_issue_comments SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL, updated_at = ? WHERE id = ?",
      [nowIso(), current.id],
    );
  }

  private validatePinnedItemTarget(workspaceId: string, itemType: MulticaPinnedItemType, itemId: string): void {
    if (itemType === "issue") {
      const row = this.db.query("SELECT id FROM multica_issues WHERE id = ? AND workspace_id = ?").get(itemId, workspaceId) as Row | null;
      if (!row) throw new Error(`Issue not found: ${itemId}`);
      return;
    }
    const project = this.getProject(itemId);
    if (!project || project.workspaceId !== workspaceId) throw new Error(`Project not found: ${itemId}`);
  }

  private linkAttachmentsToComment(commentId: string, issueId: string, attachmentIds: string[]): void {
    const issue = this.getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
      if (attachment.issueId && attachment.issueId !== issueId) throw new Error(`Attachment belongs to another issue: ${attachmentId}`);
      this.db.run(
        `UPDATE multica_attachments
         SET issue_id = ?, comment_id = ?, workspace_id = ?
         WHERE id = ? AND comment_id IS NULL`,
        [issueId, commentId, issue.workspaceId, attachmentId],
      );
    }
  }

  private notifySubscribedMembers(
    issue: MulticaIssue,
    type: string,
    title: string,
    body: string | null,
    actorType: string,
    actorId: string | null,
    excludedMemberIds: string[] = [],
  ): void {
    const subscribers = this.listIssueSubscribers(issue.id);
    const excluded = new Set(excludedMemberIds);
    for (const subscriber of subscribers) {
      if (actorType === "member" && actorId === subscriber.memberId) continue;
      if (excluded.has(subscriber.memberId)) continue;
      this.createInboxItem({
        issueId: issue.id,
        memberId: subscriber.memberId,
        type,
        title: `${issue.key}: ${title}`,
        body,
        actorType,
        actorId,
      });
    }
  }

  private isNotificationMuted(workspaceId: string, memberId: string, type: string): boolean {
    const group = notificationGroupForInboxType(type);
    if (!group) return false;
    const memberPreferences = this.getNotificationPreferences({ workspaceId, memberId }).preferences;
    if (memberPreferences[group] === "muted") return true;
    const workspacePreferences = this.getNotificationPreferences({ workspaceId }).preferences;
    return workspacePreferences[group] === "muted";
  }

  private findIssueIdForGitHubPullRequest(workspaceId: string, input: { title: string; branch?: string | null }): string | null {
    const settings = this.getGitHubSettings(workspaceId);
    if (!settings.enabled || !settings.autoLinkPRs) return null;
    const haystack = [input.title, input.branch ?? ""].join(" ");
    const issues = this.listIssues().filter((issue) => issue.workspaceId === workspaceId);
    const match = issues.find((issue) => issue.key && new RegExp("\\b" + escapeRegExp(issue.key) + "\\b", "i").test(haystack));
    return match?.id ?? null;
  }

  private triggerMemberMentions(issue: MulticaIssue, comment: MulticaIssueComment): string[] {
    const targets = this.resolveCommentMemberMentionTargets(comment.body, issue.workspaceId);
    const notified: string[] = [];
    for (const memberId of targets) {
      if (comment.authorType === "member" && comment.authorId === memberId) continue;
      this.addIssueSubscriber(issue.id, memberId, "mentioned");
      this.createInboxItem({
        issueId: issue.id,
        memberId,
        type: "comment_mention",
        title: `${issue.key}: mentioned you`,
        body: comment.body,
        actorType: comment.authorType,
        actorId: comment.authorId,
      });
      notified.push(memberId);
    }
    return notified;
  }

  private triggerCommentMentions(issue: MulticaIssue, comment: MulticaIssueComment): MulticaTask[] {
    const targets = this.resolveCommentMentionTargets(comment.body);
    if (!targets.length) return [];

    const tasks: MulticaTask[] = [];
    const seenAgents = new Set<string>();
    for (const target of targets) {
      const agent = this.resolveRunnableAgentForAssignee(target.assigneeType, target.assigneeId);
      if (!agent || seenAgents.has(agent.id)) continue;
      if (comment.authorType === "agent" && comment.authorId === agent.id) continue;
      seenAgents.add(agent.id);
      const task = this.createTask({
        agentId: agent.id,
        issueId: issue.id,
        workspaceId: issue.workspaceId,
        prompt: commentMentionPrompt(comment),
      });
      tasks.push(task);
      this.appendIssueActivity(issue.id, {
        actorType: "system",
        actorId: null,
        type: "comment_mention_triggered",
        body: `Queued ${agent.name}`,
        data: {
          commentId: comment.id,
          assigneeType: target.assigneeType,
          assigneeId: target.assigneeId,
          agentId: agent.id,
          taskId: task.id,
        },
      });
    }
    return tasks;
  }

  private resolveCommentMentionTargets(body: string): Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> {
    const targets: Array<{ assigneeType: "agent" | "squad"; assigneeId: string }> = [];
    const seen = new Set<string>();
    const addTarget = (assigneeType: "agent" | "squad", assigneeId: string) => {
      const key = `${assigneeType}:${assigneeId}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ assigneeType, assigneeId });
    };

    const markdownMention = /mention:\/\/(agent|squad)\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      addTarget(match[1] as "agent" | "squad", match[2]);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    for (const agent of this.listAgents()) {
      if (hasPlainMention(withoutLinks, agent.name)) addTarget("agent", agent.id);
    }
    for (const squad of this.listSquads()) {
      if (hasPlainMention(withoutLinks, squad.name)) addTarget("squad", squad.id);
    }
    return targets;
  }

  private resolveCommentMemberMentionTargets(body: string, workspaceId: string): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    const addTarget = (memberId: string) => {
      if (seen.has(memberId)) return;
      seen.add(memberId);
      targets.push(memberId);
    };

    const markdownMention = /mention:\/\/member\/([A-Za-z0-9_-]+)/g;
    for (const match of body.matchAll(markdownMention)) {
      const member = this.getWorkspaceMember(match[1]);
      if (member && !member.archivedAt) addTarget(member.id);
    }

    const withoutLinks = body.replace(/\[[^\]]+\]\(mention:\/\/[^)]+\)/g, " ");
    if (/(^|\s)@all(?=$|\s|[.,:;!?])/i.test(withoutLinks)) {
      for (const member of this.listWorkspaceMembers(workspaceId)) addTarget(member.id);
      return targets;
    }

    for (const member of this.listWorkspaceMembers(workspaceId)) {
      if (hasPlainMention(withoutLinks, member.name)) addTarget(member.id);
    }
    return targets;
  }

  private afterTaskTerminal(task: MulticaTask, status: "completed" | "failed" | "cancelled", body: string | null): void {
    const now = nowIso();
    if (task.chatSessionId) {
      const role = status === "completed" ? "assistant" : "system";
      const messageBody = status === "completed" ? (body || "Task completed.") : (body || `Task ${status}`);
      this.db.run(
        `INSERT INTO multica_chat_messages (id, chat_session_id, task_id, role, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [createId("msg"), task.chatSessionId, task.id, role, messageBody, now],
      );
      this.db.run(
        `UPDATE multica_chat_sessions
         SET session_id = COALESCE(?, session_id),
             work_dir = COALESCE(?, work_dir),
             latest_task_id = ?,
             updated_at = ?
         WHERE id = ?`,
        [task.sessionId ?? null, task.workDir ?? null, task.id, now, task.chatSessionId],
      );
    }

    if (task.issueId) {
      const issueStatus = status === "completed" ? "done" : status;
      this.db.run(
        "UPDATE multica_issues SET status = ?, updated_at = ? WHERE id = ?",
        [issueStatus, now, task.issueId],
      );
      this.appendIssueActivity(task.issueId, {
        actorType: "agent",
        actorId: task.agentId,
        type: `task_${status}`,
        body,
        data: { taskId: task.id, runtimeId: task.runtimeId },
      });
      const issue = this.getIssue(task.issueId);
      if (issue?.projectId) this.db.run("UPDATE multica_projects SET updated_at = ? WHERE id = ?", [now, issue.projectId]);
    }

    const runRow = this.db.query(
      "SELECT id FROM multica_autopilot_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string } | null;
    if (runRow) {
      const runStatus = status === "completed" ? "completed" : "failed";
      this.db.run(
        `UPDATE multica_autopilot_runs
         SET status = ?, completed_at = ?, failure_reason = ?, result = ?
         WHERE id = ?`,
        [
          runStatus,
          now,
          status === "failed" ? task.error : status === "cancelled" ? "Task cancelled" : null,
          toJson({ taskId: task.id, status, output: task.result, error: task.error }),
          runRow.id,
        ],
      );
    }
  }

  private addColumnIfMissing(table: string, definition: string): void {
    try {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch (err) {
      if (!String((err as Error).message ?? err).toLowerCase().includes("duplicate column")) throw err;
    }
  }

  private countProjectResources(projectId: string): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM multica_project_resources WHERE project_id = ?")
      .get(projectId) as { count: number } | null;
    return Number(row?.count ?? 0);
  }

  private nextIssueNumber(workspaceId: string): number {
    const row = this.db.query(
      "SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multica_issues WHERE workspace_id = ?",
    ).get(workspaceId) as { next: number } | null;
    return Number(row?.next ?? 1);
  }

  private backfillIssueKeys(): void {
    const rows = this.db.query(
      "SELECT id, workspace_id FROM multica_issues WHERE issue_number = 0 OR issue_key IS NULL OR issue_key = '' ORDER BY created_at ASC",
    ).all() as Array<{ id: string; workspace_id?: string }>;
    for (const row of rows) {
      const workspaceId = String(row.workspace_id ?? "local");
      const number = this.nextIssueNumber(workspaceId);
      this.db.run(
        "UPDATE multica_issues SET issue_number = ?, issue_key = ? WHERE id = ?",
        [number, formatIssueKey(number), row.id],
      );
    }
  }

  private runtimeUsageSummary(runtimeId: string): Pick<MulticaRuntime,
    "taskCount" |
    "activeTaskCount" |
    "completedTaskCount" |
    "failedTaskCount" |
    "inputTokens" |
    "outputTokens" |
    "cacheReadTokens" |
    "cacheWriteTokens"
  > {
    const rows = this.db.query(
      "SELECT id, status, usage FROM multica_tasks WHERE runtime_id = ?",
    ).all(runtimeId) as Row[];
    const stats = {
      taskCount: rows.length,
      activeTaskCount: 0,
      completedTaskCount: 0,
      failedTaskCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    for (const row of rows) {
      const status = String(row.status ?? "");
      if (status === "dispatched" || status === "running") stats.activeTaskCount += 1;
      if (status === "completed") stats.completedTaskCount += 1;
      if (status === "failed") stats.failedTaskCount += 1;
      for (const entry of parseTaskUsageEntries(row.usage)) {
        stats.inputTokens += entry.inputTokens;
        stats.outputTokens += entry.outputTokens;
        stats.cacheReadTokens += entry.cacheReadTokens;
        stats.cacheWriteTokens += entry.cacheWriteTokens;
      }
    }
    return stats;
  }

  private filteredUsageTaskRows(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
  }, options: { includeTasksWithoutUsage?: boolean } = {}): Row[] {
    const clauses = ["1 = 1"];
    const params: Array<string | number | null> = [];
    const workspaceId = input.workspaceId ?? "local";
    if (workspaceId) {
      clauses.push("t.workspace_id = ?");
      params.push(workspaceId);
    }
    if (input.projectId) {
      clauses.push("i.project_id = ?");
      params.push(input.projectId);
    }
    if (input.runtimeId !== undefined) {
      if (input.runtimeId === null) {
        clauses.push("t.runtime_id IS NULL");
      } else {
        if (!this.getRuntime(input.runtimeId)) throw new Error(`Runtime not found: ${input.runtimeId}`);
        clauses.push("t.runtime_id = ?");
        params.push(input.runtimeId);
      }
    }
    const since = usageSince(input.days);
    if (since) {
      clauses.push("COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) >= ?");
      params.push(since);
    }
    if (!options.includeTasksWithoutUsage) {
      clauses.push("t.usage IS NOT NULL AND t.usage != '[]' AND t.usage != ''");
    }
    return this.db.query(
      `SELECT t.*
       FROM multica_tasks t
       LEFT JOIN multica_issues i ON i.id = t.issue_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) ASC`,
    ).all(...params) as Row[];
  }
}

type Row = Record<string, unknown>;

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const NOTIFICATION_GROUPS: MulticaNotificationGroupKey[] = [
  "assignments",
  "status_changes",
  "comments",
  "updates",
  "agent_activity",
  "system_notifications",
];

function normalizeNotificationPreferences(value: unknown): MulticaNotificationPreferences {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const normalized: MulticaNotificationPreferences = {};
  for (const group of NOTIFICATION_GROUPS) {
    const pref = raw[group];
    if (pref === "all" || pref === "muted") normalized[group] = pref;
  }
  return normalized;
}

function notificationGroupForInboxType(type: string): MulticaNotificationGroupKey | null {
  if (type === "issue_assigned" || type === "unassigned") return "assignments";
  if (type === "comment_created" || type === "comment_mention") return "comments";
  if (type === "status_changed") return "status_changes";
  if (type.startsWith("agent_")) return "agent_activity";
  if (type.startsWith("system_")) return "system_notifications";
  return "updates";
}

function normalizeGitHubPullRequestState(value: unknown): MulticaGitHubPullRequestState {
  if (value === "closed" || value === "merged" || value === "draft") return value;
  return "open";
}

function normalizeGitHubChecksConclusion(value: unknown): MulticaGitHubChecksConclusion {
  if (value === "passed" || value === "failed" || value === "pending") return value;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWebhookProvider(value: unknown): MulticaWebhookProvider {
  return value === "github" ? "github" : "generic";
}

function normalizeWebhookSignatureStatus(value: unknown): MulticaWebhookSignatureStatus {
  if (value === "valid" || value === "invalid" || value === "missing") return value;
  return "not_required";
}

function normalizeWebhookDeliveryStatus(value: unknown): MulticaWebhookDeliveryStatus {
  if (value === "dispatched" || value === "rejected" || value === "ignored" || value === "failed") return value;
  return "queued";
}

function normalizeWebhookHeaders(headers: Record<string, string | null | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

function webhookDedupeKey(provider: MulticaWebhookProvider, headers: Record<string, string>): [string, string] {
  if (provider === "github" && headers["x-github-delivery"]?.trim()) {
    return [headers["x-github-delivery"].trim(), "x-github-delivery"];
  }
  if (headers["idempotency-key"]?.trim()) return [headers["idempotency-key"].trim(), "idempotency-key"];
  if (headers["x-github-delivery"]?.trim()) return [headers["x-github-delivery"].trim(), "x-github-delivery"];
  return ["", ""];
}

function inferWebhookEvent(provider: MulticaWebhookProvider, headers: Record<string, string>, payload: unknown): string {
  if (provider === "github" && headers["x-github-event"]) {
    const action = isRecord(payload) && typeof payload.action === "string" ? "." + payload.action : "";
    return "github." + headers["x-github-event"] + action;
  }
  if (headers["x-github-event"]) return "github." + headers["x-github-event"];
  if (headers["x-gitlab-event"]) return "gitlab." + headers["x-gitlab-event"].toLowerCase().replace(/\s+/g, "_");
  if (isRecord(payload) && typeof payload.event === "string") return payload.event;
  if (isRecord(payload) && typeof payload.action === "string") return "webhook." + payload.action;
  return "webhook.received";
}

function selectedWebhookHeaders(headers: Record<string, string>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of ["user-agent", "content-type", "x-github-event", "x-github-delivery", "idempotency-key", "x-gitlab-event"]) {
    if (headers[key]) selected[key] = headers[key];
  }
  selected["x-hub-signature-256"] = Boolean(headers["x-hub-signature-256"]);
  return selected;
}

function replayHeadersFromDelivery(delivery: MulticaWebhookDelivery): Record<string, string> {
  const headers: Record<string, string> = {};
  if (delivery.contentType) headers["content-type"] = delivery.contentType;
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSkillFiles(files: MulticaSkillFile[]): MulticaSkillFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    const path = normalizeSkillFilePath(file.path);
    if (seen.has(path)) throw new Error(`Duplicate skill file path: ${path}`);
    seen.add(path);
    return { path, content: String(file.content ?? "") };
  });
}

function normalizeSkillFilePath(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!normalized || normalized.startsWith("/") || normalized === "." || normalized.includes("..")) {
    throw new Error(`Invalid skill file path: ${path}`);
  }
  if (normalized === "SKILL.md") throw new Error("Skill files should not include SKILL.md");
  return normalized;
}

function mergeAgentSkills(inlineSkills: MulticaSkill[], structuredSkills: MulticaSkill[]): MulticaSkill[] {
  const seen = new Set<string>();
  const merged: MulticaSkill[] = [];
  for (const skill of [...structuredSkills, ...inlineSkills]) {
    const key = skill.id ?? skill.name;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(skill);
  }
  return merged;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function usageTimestamp(row: Row): string {
  return String(
    row.completed_at ??
    row.failed_at ??
    row.cancelled_at ??
    row.started_at ??
    row.dispatched_at ??
    row.updated_at ??
    row.created_at,
  );
}

function usageDate(row: Row): string {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return String(row.created_at ?? "").slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function usageHour(row: Row): number {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return 0;
  return date.getUTCHours();
}

function usageSince(days: number | undefined): string | null {
  const value = Number(days ?? 30);
  if (!Number.isFinite(value) || value <= 0) return null;
  const capped = Math.min(365, Math.floor(value));
  return new Date(Date.now() - capped * 24 * 60 * 60 * 1000).toISOString();
}

function trailingWindowStart(days: number): string {
  const capped = Math.max(1, Math.min(365, Math.floor(days)));
  return new Date(Date.now() - capped * 24 * 60 * 60 * 1000).toISOString();
}

function taskRunSeconds(row: Row): number {
  const start = Date.parse(String(row.started_at ?? row.dispatched_at ?? row.created_at));
  const end = Date.parse(String(row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.floor((end - start) / 1000);
}

type RuntimeUsageEntry = Required<Pick<TaskUsageEntry,
  "provider" |
  "model" |
  "inputTokens" |
  "outputTokens" |
  "cacheReadTokens" |
  "cacheWriteTokens"
>>;

function parseTaskUsageEntries(value: unknown): RuntimeUsageEntry[] {
  const raw = parseJson<unknown[]>(value, []);
  if (!Array.isArray(raw)) return [];
  const entries: RuntimeUsageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    entries.push({
      provider: String(record.provider ?? "unknown"),
      model: String(record.model ?? "unknown"),
      inputTokens: normalizeUsageNumber(record.inputTokens ?? record.input_tokens),
      outputTokens: normalizeUsageNumber(record.outputTokens ?? record.output_tokens),
      cacheReadTokens: normalizeUsageNumber(record.cacheReadTokens ?? record.cache_read_tokens),
      cacheWriteTokens: normalizeUsageNumber(record.cacheWriteTokens ?? record.cache_write_tokens),
    });
  }
  return entries;
}

function addUsageTotals(
  target: Pick<RuntimeUsageEntry, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  entry: RuntimeUsageEntry,
): void {
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.cacheReadTokens += entry.cacheReadTokens;
  target.cacheWriteTokens += entry.cacheWriteTokens;
}

function normalizeUsageNumber(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function formatIssueKey(number: number): string {
  return `MUL-${number}`;
}

function commentMentionPrompt(comment: MulticaIssueComment): string {
  return [
    "A teammate mentioned you in an issue comment.",
    "",
    "## Triggering Comment",
    comment.body,
  ].join("\n");
}

function hasPlainMention(body: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,:;!?])`, "i").test(body);
}

function validateIssueMetadataKey(key: string): void {
  if (!key) throw new Error("key is required");
  if (!ISSUE_METADATA_KEY_RE.test(key)) {
    throw new Error("key must match ^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$");
  }
}

function validateIssueMetadataValue(value: unknown): string | number | boolean {
  if (!isIssueMetadataPrimitive(value)) {
    if (value === null) throw new Error("value cannot be null");
    throw new Error("value must be a primitive: string, number, or bool");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("value must be a finite number");
  }
  return value;
}

function isIssueMetadataPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function validateIssueMetadataSize(metadata: Record<string, string | number | boolean>): void {
  if (Buffer.byteLength(toJson(metadata), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
}

function normalizeIssuePriority(value: string | undefined): MulticaIssuePriority {
  const priority = String(value ?? "none").trim().toLowerCase();
  if (priority === "urgent" || priority === "high" || priority === "medium" || priority === "low" || priority === "none") {
    return priority;
  }
  throw new Error("priority must be one of urgent, high, medium, low, or none");
}

function normalizeIssueDependencyType(value: string | undefined): MulticaIssueDependencyType {
  const type = String(value ?? "related").trim().toLowerCase();
  if (type === "blocks" || type === "blocked_by" || type === "related") return type;
  throw new Error("dependency type must be one of blocks, blocked_by, or related");
}

function normalizeRuntimeVisibility(value: string | undefined): MulticaRuntimeVisibility {
  const visibility = String(value ?? "private").trim().toLowerCase();
  if (visibility === "private" || visibility === "public") return visibility;
  throw new Error("visibility must be private or public");
}

function normalizeRuntimeConcurrency(value: number | null | undefined): number {
  const concurrency = Number(value ?? 1);
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("maxConcurrency must be at least 1");
  return Math.floor(concurrency);
}

const SUPPORTED_USER_LANGUAGES = new Set(["en", "zh-Hans", "zh-Hant", "ja", "ko"]);
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeOptionalLanguage(value: unknown): string | null {
  const language = String(value ?? "").trim();
  if (!language) return null;
  if (!SUPPORTED_USER_LANGUAGES.has(language)) throw new Error("unsupported language");
  return language;
}

function normalizeOptionalTimezone(value: unknown): string | null {
  const timezone = String(value ?? "").trim();
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new Error("invalid timezone");
  }
}

function normalizeWorkspaceSlug(value: unknown): string {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!slug) return "";
  if (!WORKSPACE_SLUG_RE.test(slug)) throw new Error("slug must contain only lowercase letters, numbers, and hyphens");
  return slug;
}

function slugifyWorkspaceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function generateIssuePrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (!letters) return "WS";
  return letters.slice(0, Math.min(letters.length, 3));
}

function normalizeWorkspaceInvitationRole(value: unknown): string {
  const role = String(value ?? "member").trim().toLowerCase() || "member";
  if (role === "owner" || role === "admin" || role === "member") return role;
  throw new Error("invalid member role");
}

function normalizeRuntimeModels(models: MulticaRuntimeModel[], provider: string): MulticaRuntimeModel[] {
  const seen = new Set<string>();
  return (models ?? []).map((model) => {
    const id = String(model.id ?? "").trim();
    if (!id) throw new Error("model id is required");
    if (seen.has(id)) throw new Error(`Duplicate runtime model: ${id}`);
    seen.add(id);
    return {
      id,
      label: String(model.label ?? id).trim() || id,
      provider: String(model.provider ?? provider ?? "").trim() || provider,
      default: Boolean(model.default),
      thinking: normalizeRuntimeModelThinking(model.thinking),
    };
  });
}

function normalizeRuntimeModelThinking(value: MulticaRuntimeModel["thinking"]): MulticaRuntimeModel["thinking"] | undefined {
  if (!value) return undefined;
  const supportedLevels = (value.supportedLevels ?? value.supported_levels ?? []).map((level) => ({
    value: String(level.value ?? "").trim(),
    label: String(level.label ?? level.value ?? "").trim(),
    ...(level.description ? { description: String(level.description) } : {}),
  })).filter((level) => level.value);
  if (!supportedLevels.length) return undefined;
  return {
    supportedLevels,
    ...(value.defaultLevel || value.default_level ? { defaultLevel: String(value.defaultLevel ?? value.default_level) } : {}),
  };
}

function normalizeAccessTokenType(value: string | undefined): MulticaAccessTokenType {
  const type = String(value ?? "pat").trim().toLowerCase();
  if (type === "pat" || type === "daemon") return type;
  throw new Error("token type must be pat or daemon");
}

function normalizeAccessTokenExpiry(days: number | null | undefined): string | null {
  if (days == null) return null;
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(Date.now() + Math.floor(value) * 24 * 60 * 60 * 1000).toISOString();
}

function generateAccessToken(type: MulticaAccessTokenType): string {
  const prefix = type === "daemon" ? "mdt" : "mul";
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

async function hashAccessToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function issueMatchesListFilter(issue: MulticaIssue, input: ListIssuesInput): boolean {
  const workspaceId = input.workspaceId ?? input.workspace_id;
  if (workspaceId && issue.workspaceId !== workspaceId) return false;
  const statuses = normalizeStringList(input.statuses ?? input.status);
  if (statuses.length && !statuses.includes(issue.status)) return false;
  const priorities = normalizeStringList(input.priorities ?? input.priority);
  if (priorities.length && !priorities.includes(issue.priority)) return false;
  const assigneeTypes = normalizeStringList(input.assigneeTypes ?? input.assignee_types);
  if (assigneeTypes.length && (!issue.assigneeType || !assigneeTypes.includes(issue.assigneeType))) return false;
  const assigneeId = input.assigneeId ?? input.assignee_id;
  if (assigneeId && issue.assigneeId !== assigneeId) return false;
  const assigneeIds = normalizeStringList(input.assigneeIds ?? input.assignee_ids);
  if (assigneeIds.length && (!issue.assigneeId || !assigneeIds.includes(issue.assigneeId))) return false;
  if (input.includeNoAssignee && issue.assigneeId !== null) return false;
  const projectId = input.projectId ?? input.project_id;
  if (projectId && issue.projectId !== projectId) return false;
  const projectIds = normalizeStringList(input.projectIds ?? input.project_ids);
  if (projectIds.length && (!issue.projectId || !projectIds.includes(issue.projectId))) return false;
  if (input.includeNoProject && issue.projectId !== null) return false;
  return true;
}

function normalizeStringList(value: string[] | string | undefined | null): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeListOffset(value: number | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeListLimit(value: number | undefined, fallback = 200, max = 500): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(number)));
}

function assigneeGroupId(type: MulticaAssigneeType | null, id: string | null): string {
  return type && id ? `${type}:${id}` : "none";
}

function assigneeGroupRank(type: MulticaAssigneeType | null): number {
  if (type === "member") return 0;
  if (type === "agent") return 1;
  if (type === "squad") return 2;
  return 3;
}

function hasIssueMutation(input: UpdateIssueInput): boolean {
  return hasAnyField(
    input,
    "title",
    "description",
    "status",
    "priority",
    "projectId",
    "project_id",
    "workspaceId",
    "workspace_id",
    "parentIssueId",
    "parent_issue_id",
    "assigneeType",
    "assignee_type",
    "assigneeId",
    "assignee_id",
    "position",
    "startDate",
    "start_date",
    "dueDate",
    "due_date",
    "acceptanceCriteria",
    "acceptance_criteria",
    "contextRefs",
    "context_refs",
  );
}

function quickCreateTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? prompt.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function quickCreateTaskPrompt(prompt: string, projectId: string | null): string {
  return [
    "Create or refine a Multica issue from this quick-create request.",
    projectId ? `Project ID: ${projectId}` : "Project ID: none",
    "",
    prompt,
  ].join("\n");
}

function outcomeTime(task: MulticaTask): number {
  return Date.parse(task.completedAt ?? task.failedAt ?? task.updatedAt ?? task.createdAt);
}

function normalizeIssuePosition(value: number | null | undefined): number {
  const position = Number(value ?? 0);
  if (!Number.isFinite(position)) throw new Error("position must be a finite number");
  return position;
}

function normalizeIssueDate(value: string | null | undefined, field: string): string | null {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid date`);
  return date.toISOString();
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("value must be an array");
  return value;
}

function hasAnyField(target: object, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(target, key));
}

function resolveOptionalStringField(
  target: object,
  camelKey: string,
  snakeKey: string,
  current: string | null,
): string | null {
  const values = target as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(values, camelKey)) return values[camelKey] == null ? null : String(values[camelKey]);
  if (Object.prototype.hasOwnProperty.call(values, snakeKey)) return values[snakeKey] == null ? null : String(values[snakeKey]);
  return current;
}

function normalizeLabelName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name) throw new Error("Label name is required");
  if (name.length > 32) throw new Error("Label name cannot exceed 32 characters");
  return name;
}

function normalizeLabelColor(value: string | undefined): string {
  const color = value?.trim() ?? "";
  if (!/^#?[0-9a-fA-F]{6}$/.test(color)) throw new Error("Label color must be a 6-digit hex color");
  return (color.startsWith("#") ? color : `#${color}`).toLowerCase();
}

function normalizePinnedItemType(value: string | undefined): MulticaPinnedItemType {
  if (value === "issue" || value === "project") return value;
  throw new Error("item_type must be 'issue' or 'project'");
}

function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim();
}

function clampSearchLimit(value: number | undefined): number {
  const limit = Number(value ?? 20);
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(50, Math.floor(limit));
}

function searchMatch(value: string, query: string): boolean {
  const haystack = value.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => haystack.includes(term));
}

function searchRank(matchSource: string): number {
  if (matchSource === "key") return 0;
  if (matchSource === "title") return 1;
  return 2;
}

function extractSearchSnippet(value: string, query: string): string {
  const text = String(value);
  const term = query.toLowerCase().split(/\s+/).filter(Boolean).find((item) => text.toLowerCase().includes(item)) ?? "";
  if (!term) return text.slice(0, 160);
  const index = text.toLowerCase().indexOf(term);
  const start = Math.max(0, index - 50);
  const end = Math.min(text.length, index + term.length + 80);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function normalizeProjectResourceRef(resourceType: string, rawRef: Record<string, unknown>): Record<string, unknown> {
  if (!resourceType) throw new Error("resourceType is required");
  if (resourceType !== "github_repo") throw new Error(`Unknown project resource type: ${resourceType}`);
  const url = String(rawRef.url ?? "").trim();
  if (!url) throw new Error("github_repo url is required");
  if (!isValidGitRepoUrl(url)) throw new Error("github_repo url must be a valid http(s), ssh, git, or scp-like URL");
  const defaultBranchHint = String(rawRef.defaultBranchHint ?? rawRef.default_branch_hint ?? "").trim();
  return defaultBranchHint
    ? { url, defaultBranchHint, default_branch_hint: defaultBranchHint }
    : { url };
}

function isValidGitRepoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.host) && ["http", "https", "ssh", "git"].includes(url.protocol.replace(":", ""));
  } catch {
    if (value.includes(" ") || value.includes("://")) return false;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) return false;
    const at = value.indexOf("@");
    if (at >= colon) return false;
    const host = value.slice(at >= 0 ? at + 1 : 0, colon);
    const path = value.slice(colon + 1);
    return Boolean(host && path);
  }
}

function projectSelect(suffix: string): string {
  return `
    SELECT p.*,
      COUNT(i.id) AS issue_count,
      COALESCE(SUM(CASE WHEN i.status IN ('done', 'completed', 'closed') THEN 1 ELSE 0 END), 0) AS done_count,
      (
        SELECT COUNT(*)
        FROM multica_project_resources pr
        WHERE pr.project_id = p.id
      ) AS resource_count
    FROM multica_projects p
    LEFT JOIN multica_issues i ON i.project_id = p.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY p.id ORDER BY") : `${suffix} GROUP BY p.id`}
  `;
}

function squadSelect(suffix: string): string {
  return `
    SELECT s.*, COUNT(m.id) AS member_count
    FROM multica_squads s
    LEFT JOIN multica_squad_members m ON m.squad_id = s.id
    ${suffix.includes("ORDER BY") ? suffix.replace("ORDER BY", "GROUP BY s.id ORDER BY") : `${suffix} GROUP BY s.id`}
  `;
}

function toAgent(row: Row): MulticaAgent {
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider),
    instructions: String(row.instructions ?? ""),
    skills: parseJson(row.skills, []),
    cwd: nullableString(row.cwd),
    executable: nullableString(row.executable),
    model: nullableString(row.model),
    allowedTools: parseJson(row.allowed_tools, []),
    customEnv: parseJson(row.custom_env, {}),
    customArgs: parseJson(row.custom_args, []),
    mcpConfig: row.mcp_config == null ? null : parseJson(row.mcp_config, null),
    thinkingLevel: nullableString(row.thinking_level),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRuntime(row: Row): MulticaRuntime {
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider),
    workspaceId: nullableString(row.workspace_id),
    ownerId: nullableString(row.owner_id),
    visibility: normalizeRuntimeVisibility(String(row.visibility ?? "private")),
    status: String(row.status) as MulticaRuntime["status"],
    maxConcurrency: Number(row.max_concurrency ?? 1),
    taskCount: 0,
    activeTaskCount: 0,
    completedTaskCount: 0,
    failedTaskCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    lastHeartbeatAt: nullableString(row.last_heartbeat_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toCloudRuntimeNode(row: Row): MulticaCloudRuntimeNode {
  const createdAt = String(row.created_at);
  const updatedAt = String(row.updated_at);
  const ownerId = String(row.owner_id ?? "local");
  const instanceId = String(row.instance_id ?? "");
  const instanceType = String(row.instance_type ?? "");
  const imageId = String(row.image_id ?? "");
  const subnetId = String(row.subnet_id ?? "");
  return {
    id: String(row.id),
    ownerId,
    owner_id: ownerId,
    instanceId,
    instance_id: instanceId,
    region: String(row.region ?? "local"),
    instanceType,
    instance_type: instanceType,
    imageId,
    image_id: imageId,
    subnetId,
    subnet_id: subnetId,
    name: String(row.name ?? ""),
    status: String(row.status ?? "unknown"),
    tags: parseJson<Record<string, string>>(row.tags, {}),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
  };
}

function toRuntimeLocalSkillListRequest(row: Row): MulticaRuntimeLocalSkillListRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeLocalSkillStatus(row.status),
    skills: normalizeRuntimeLocalSkillSummaries(parseJson(row.skills, [])),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function toRuntimeLocalSkillImportRequest(row: Row): MulticaRuntimeLocalSkillImportRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    skillKey: String(row.skill_key),
    name: nullableString(row.name),
    description: nullableString(row.description),
    status: normalizeRuntimeLocalSkillStatus(row.status),
    skill: row.skill == null ? null : parseJson(row.skill, null),
    skillId: nullableString(row.skill_id),
    error: nullableString(row.error),
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function toRuntimeModelListRequest(row: Row): MulticaRuntimeModelListRequest {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeModelListStatus(row.status),
    models: parseJson(row.models, []),
    supported: Number(row.supported ?? 1) !== 0,
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function normalizeRuntimeModelListStatus(value: unknown): MulticaRuntimeModelListRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function toRuntimeUpdateRequest(row: Row): MulticaRuntimeUpdateRequest {
  const targetVersion = String(row.target_version ?? "");
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    status: normalizeRuntimeUpdateStatus(row.status),
    targetVersion,
    target_version: targetVersion,
    output: nullableString(row.output),
    error: nullableString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runStartedAt: nullableString(row.run_started_at),
  };
}

function normalizeRuntimeUpdateStatus(value: unknown): MulticaRuntimeUpdateRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function normalizeRuntimeLocalSkillStatus(value: unknown): MulticaRuntimeLocalSkillRequestStatus {
  const status = String(value ?? "failed").trim();
  if (status === "pending" || status === "running" || status === "completed" || status === "failed" || status === "timeout") return status;
  return "failed";
}

function normalizeRuntimeLocalSkillSummaries(value: unknown): MulticaRuntimeLocalSkillSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    const sourcePath = String(record.sourcePath ?? record.source_path ?? "");
    const fileCount = Number(record.fileCount ?? record.file_count ?? 0);
    return {
      key: String(record.key ?? record.name ?? "").trim(),
      name: String(record.name ?? record.key ?? "").trim(),
      description: String(record.description ?? ""),
      sourcePath,
      source_path: sourcePath,
      provider: String(record.provider ?? "unknown"),
      fileCount,
      file_count: fileCount,
    };
  }).filter((skill) => skill.key && skill.name);
}

function cleanOptionalLocalSkillString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function cleanOptionalString(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) throw new Error("email is required");
  if (email.length > 254) throw new Error("email is too long");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid");
  return email;
}

function normalizeFeedbackMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;
    if (
      typeof rawValue === "string"
      || typeof rawValue === "number"
      || typeof rawValue === "boolean"
      || rawValue === null
    ) {
      metadata[cleanKey] = rawValue;
    }
  }
  if (Buffer.byteLength(toJson(metadata), "utf8") > 8 * 1024) {
    throw new Error("metadata exceeds the 8KB size limit");
  }
  return metadata;
}

function withRuntimeLiveness(runtime: MulticaRuntime): MulticaRuntime {
  if (runtime.status === "offline") return runtime;
  if (!runtime.lastHeartbeatAt) return { ...runtime, status: "offline" };
  const heartbeat = Date.parse(runtime.lastHeartbeatAt);
  if (!Number.isFinite(heartbeat)) return { ...runtime, status: "offline" };
  return Date.now() - heartbeat > RUNTIME_HEARTBEAT_STALE_MS ? { ...runtime, status: "offline" } : runtime;
}

function toRuntimeModel(row: Row): MulticaRuntimeModel {
  return {
    id: String(row.model_id),
    label: String(row.label ?? row.model_id),
    provider: String(row.provider ?? ""),
    default: Boolean(Number(row.is_default ?? 0)),
    thinking: row.thinking == null ? undefined : parseJson(row.thinking, undefined),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toWorkspaceMember(row: Row): MulticaWorkspaceMember {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name),
    email: nullableString(row.email),
    role: String(row.role ?? "member"),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toUser(row: Row): MulticaUser {
  const onboardingQuestionnaire = parseJson<Record<string, unknown>>(row.onboarding_questionnaire, {});
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    avatarUrl: nullableString(row.avatar_url),
    avatar_url: nullableString(row.avatar_url),
    language: nullableString(row.language),
    timezone: nullableString(row.timezone),
    onboardedAt: nullableString(row.onboarded_at),
    onboarded_at: nullableString(row.onboarded_at),
    onboardingQuestionnaire,
    onboarding_questionnaire: onboardingQuestionnaire,
    starterContentState: nullableString(row.starter_content_state),
    starter_content_state: nullableString(row.starter_content_state),
    profileDescription: String(row.profile_description ?? ""),
    profile_description: String(row.profile_description ?? ""),
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
  };
}

function toWorkspace(row: Row): MulticaWorkspace {
  const settings = parseJson<Record<string, unknown>>(row.settings, {});
  const repos = parseJson<unknown[]>(row.repos, []);
  const issuePrefix = String(row.issue_prefix ?? "MUL");
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: nullableString(row.description),
    context: nullableString(row.context),
    settings,
    repos,
    issuePrefix,
    issue_prefix: issuePrefix,
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
  };
}

function toInvitation(row: Row): MulticaWorkspaceInvitation {
  const status = String(row.status ?? "pending") as MulticaWorkspaceInvitation["status"];
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspace_id: String(row.workspace_id),
    inviterId: String(row.inviter_id),
    inviter_id: String(row.inviter_id),
    inviteeEmail: String(row.invitee_email),
    invitee_email: String(row.invitee_email),
    inviteeUserId: nullableString(row.invitee_user_id),
    invitee_user_id: nullableString(row.invitee_user_id),
    role: String(row.role ?? "member"),
    status,
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
    expiresAt: String(row.expires_at),
    expires_at: String(row.expires_at),
  };
}

function toGitHubSettings(row: Row): MulticaGitHubSettings {
  const enabled = Boolean(Number(row.enabled ?? 1));
  return {
    workspaceId: String(row.workspace_id ?? "local"),
    enabled,
    prSidebar: Boolean(Number(row.pr_sidebar ?? 1)),
    coAuthor: Boolean(Number(row.co_author ?? 1)),
    autoLinkPRs: Boolean(Number(row.auto_link_prs ?? 1)),
    updatedAt: nullableString(row.updated_at),
  };
}

function toGitHubPullRequest(row: Row): MulticaGitHubPullRequest {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    repoOwner: String(row.repo_owner ?? ""),
    repoName: String(row.repo_name ?? ""),
    number: Number(row.number ?? 0),
    title: String(row.title ?? ""),
    state: normalizeGitHubPullRequestState(row.state),
    htmlUrl: String(row.html_url ?? ""),
    branch: nullableString(row.branch),
    authorLogin: nullableString(row.author_login),
    authorAvatarUrl: nullableString(row.author_avatar_url),
    mergedAt: nullableString(row.merged_at),
    closedAt: nullableString(row.closed_at),
    prCreatedAt: String(row.pr_created_at),
    prUpdatedAt: String(row.pr_updated_at),
    mergeableState: nullableString(row.mergeable_state),
    checksConclusion: normalizeGitHubChecksConclusion(row.checks_conclusion),
    checksPassed: Number(row.checks_passed ?? 0),
    checksFailed: Number(row.checks_failed ?? 0),
    checksPending: Number(row.checks_pending ?? 0),
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    changedFiles: Number(row.changed_files ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAccessToken(row: Row): MulticaAccessToken {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    type: normalizeAccessTokenType(String(row.type ?? "pat")),
    tokenPrefix: String(row.token_prefix ?? ""),
    lastUsedAt: nullableString(row.last_used_at),
    expiresAt: nullableString(row.expires_at),
    revokedAt: nullableString(row.revoked_at),
    createdAt: String(row.created_at),
  };
}

function toFeedback(row: Row): MulticaFeedback {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: String(row.user_id ?? "local"),
    memberId: nullableString(row.member_id),
    message: String(row.message ?? ""),
    metadata: parseJson(row.metadata, {}),
    createdAt: String(row.created_at),
  };
}

function toSkill(row: Row, files: MulticaSkillFile[] = []): MulticaSkill {
  const config = parseJson<Record<string, unknown>>(row.config, {});
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    content: String(row.content ?? ""),
    config,
    files,
    createdBy: nullableString(row.created_by),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSkillFile(row: Row): MulticaSkillFile {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    path: String(row.path ?? ""),
    content: String(row.content ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProject(row: Row): MulticaProject {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    title: String(row.title),
    description: nullableString(row.description),
    icon: nullableString(row.icon),
    status: String(row.status ?? "planned") as MulticaProject["status"],
    priority: String(row.priority ?? "none") as MulticaProject["priority"],
    leadType: nullableString(row.lead_type) as MulticaProject["leadType"],
    leadId: nullableString(row.lead_id),
    issueCount: Number(row.issue_count ?? 0),
    doneCount: Number(row.done_count ?? 0),
    resourceCount: Number(row.resource_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toProjectResource(row: Row): MulticaProjectResource {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id ?? "local"),
    resourceType: String(row.resource_type),
    resourceRef: parseJson(row.resource_ref, {}),
    label: nullableString(row.label),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
    createdBy: nullableString(row.created_by),
  };
}

function toIssue(row: Row): MulticaIssue {
  const number = Number(row.issue_number ?? 0);
  return {
    id: String(row.id),
    key: String(row.issue_key || (number > 0 ? formatIssueKey(number) : row.id)),
    number,
    title: String(row.title),
    description: nullableString(row.description),
    status: String(row.status),
    priority: normalizeIssuePriority(String(row.priority ?? "none")),
    workspaceId: String(row.workspace_id ?? "local"),
    projectId: nullableString(row.project_id),
    parentIssueId: nullableString(row.parent_issue_id),
    assigneeType: nullableString(row.assignee_type) as MulticaIssue["assigneeType"],
    assigneeId: nullableString(row.assignee_id),
    position: Number(row.position ?? 0),
    startDate: nullableString(row.start_date),
    dueDate: nullableString(row.due_date),
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    contextRefs: parseJson(row.context_refs, []),
    metadata: parseIssueMetadata(row.metadata),
    labels: [],
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChildIssueProgress(row: Row): MulticaIssueChildProgress {
  return {
    parentIssueId: String(row.parent_issue_id),
    total: Number(row.total ?? 0),
    done: Number(row.done ?? 0),
  };
}

function toIssueDependency(row: Row): MulticaIssueDependency {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: String(row.issue_id),
    dependsOnIssueId: String(row.depends_on_issue_id),
    type: normalizeIssueDependencyType(String(row.type ?? "related")),
    issue: null,
    dependsOnIssue: null,
    createdAt: String(row.created_at),
  };
}

function parseIssueMetadata(value: unknown): Record<string, string | number | boolean> {
  const raw = parseJson<Record<string, unknown>>(value, {});
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (ISSUE_METADATA_KEY_RE.test(key) && isIssueMetadataPrimitive(item)) {
      metadata[key] = item;
    }
  }
  return metadata;
}

function toIssueComment(row: Row): MulticaIssueComment {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    authorType: String(row.author_type ?? "member"),
    authorId: nullableString(row.author_id),
    parentId: nullableString(row.parent_id),
    body: String(row.body ?? ""),
    resolvedAt: nullableString(row.resolved_at),
    resolvedByType: nullableString(row.resolved_by_type),
    resolvedById: nullableString(row.resolved_by_id),
    reactions: [],
    attachments: [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toIssueActivity(row: Row): MulticaIssueActivity {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    actorType: String(row.actor_type ?? "system"),
    actorId: nullableString(row.actor_id),
    type: String(row.type),
    body: nullableString(row.body),
    data: row.data == null ? null : parseJson(row.data, null),
    createdAt: String(row.created_at),
  };
}

function commentToTimelineEntry(comment: MulticaIssueComment): MulticaTimelineEntry {
  return {
    type: "comment",
    id: comment.id,
    actorType: comment.authorType,
    actor_type: comment.authorType,
    actorId: comment.authorId,
    actor_id: comment.authorId,
    createdAt: comment.createdAt,
    created_at: comment.createdAt,
    content: comment.body,
    parentId: comment.parentId,
    parent_id: comment.parentId,
    updatedAt: comment.updatedAt,
    updated_at: comment.updatedAt,
    commentType: "comment",
    comment_type: "comment",
    reactions: comment.reactions,
    attachments: comment.attachments,
    resolvedAt: comment.resolvedAt,
    resolved_at: comment.resolvedAt,
    resolvedByType: comment.resolvedByType,
    resolved_by_type: comment.resolvedByType,
    resolvedById: comment.resolvedById,
    resolved_by_id: comment.resolvedById,
  };
}

function activityToTimelineEntry(activity: MulticaIssueActivity): MulticaTimelineEntry {
  return {
    type: "activity",
    id: activity.id,
    actorType: activity.actorType,
    actor_type: activity.actorType,
    actorId: activity.actorId,
    actor_id: activity.actorId,
    createdAt: activity.createdAt,
    created_at: activity.createdAt,
    action: activity.type,
    details: activity.data ?? (activity.body == null ? null : { body: activity.body }),
  };
}

function toIssueSubscriber(row: Row): MulticaIssueSubscriber {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    memberId: String(row.member_id),
    reason: String(row.reason ?? "manual") as MulticaSubscriptionReason,
    createdAt: String(row.created_at),
  };
}

function toInboxItem(row: Row, issue: MulticaIssue | null): MulticaInboxItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: String(row.issue_id),
    memberId: String(row.member_id),
    actorType: String(row.actor_type ?? "system"),
    actorId: nullableString(row.actor_id),
    type: String(row.type),
    title: String(row.title ?? ""),
    body: nullableString(row.body),
    read: Number(row.read ?? 0) === 1,
    archived: Number(row.archived ?? 0) === 1,
    createdAt: String(row.created_at),
    issue,
  };
}

function toIssueReaction(row: Row): MulticaIssueReaction {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toCommentReaction(row: Row): MulticaCommentReaction {
  return {
    id: String(row.id),
    commentId: String(row.comment_id),
    workspaceId: String(row.workspace_id ?? "local"),
    actorType: String(row.actor_type ?? "member"),
    actorId: String(row.actor_id ?? "local"),
    emoji: String(row.emoji ?? ""),
    createdAt: String(row.created_at),
  };
}

function toAttachment(row: Row): MulticaAttachment {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    issueId: nullableString(row.issue_id),
    commentId: nullableString(row.comment_id),
    uploaderType: String(row.uploader_type ?? "member"),
    uploaderId: String(row.uploader_id ?? "local"),
    filename: String(row.filename ?? ""),
    url: String(row.url ?? ""),
    contentType: String(row.content_type ?? "application/octet-stream"),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at),
  };
}

function toLabel(row: Row): MulticaLabel {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name ?? ""),
    color: String(row.color ?? "#6b7280"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPinnedItem(row: Row): MulticaPinnedItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: String(row.user_id ?? "local"),
    itemType: String(row.item_type ?? "issue") as MulticaPinnedItemType,
    itemId: String(row.item_id ?? ""),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
  };
}

function toSquad(row: Row): MulticaSquad {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    name: String(row.name),
    description: String(row.description ?? ""),
    instructions: String(row.instructions ?? ""),
    leaderId: nullableString(row.leader_id),
    creatorId: nullableString(row.creator_id),
    archivedAt: nullableString(row.archived_at),
    memberCount: Number(row.member_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSquadMember(row: Row): MulticaSquadMember {
  return {
    id: String(row.id),
    squadId: String(row.squad_id),
    memberType: String(row.member_type) as MulticaSquadMember["memberType"],
    memberId: String(row.member_id),
    role: String(row.role ?? "member"),
    createdAt: String(row.created_at),
  };
}

function toAutopilot(row: Row): MulticaAutopilot {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    title: String(row.title),
    description: nullableString(row.description),
    projectId: nullableString(row.project_id),
    assigneeType: String(row.assignee_type ?? "agent") as MulticaAutopilot["assigneeType"],
    assigneeId: String(row.assignee_id),
    status: String(row.status ?? "active") as MulticaAutopilot["status"],
    executionMode: String(row.execution_mode ?? "create_issue") as MulticaAutopilot["executionMode"],
    issueTitleTemplate: nullableString(row.issue_title_template),
    triggerKind: String(row.trigger_kind ?? "manual"),
    triggerLabel: nullableString(row.trigger_label),
    cronExpression: nullableString(row.cron_expression),
    lastRunAt: nullableString(row.last_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAutopilotTrigger(row: Row): MulticaAutopilotTrigger {
  const webhookToken = nullableString(row.webhook_token);
  const webhookPath = webhookToken ? `/api/webhooks/autopilots/${webhookToken}` : null;
  const webhookUrl = nullableString(row.webhook_url);
  return {
    id: String(row.id),
    autopilotId: String(row.autopilot_id),
    kind: String(row.kind ?? "webhook") as MulticaAutopilotTrigger["kind"],
    enabled: Boolean(Number(row.enabled ?? 1)),
    cronExpression: nullableString(row.cron_expression),
    timezone: nullableString(row.timezone),
    nextRunAt: nullableString(row.next_run_at),
    webhookToken,
    webhookPath,
    webhookUrl,
    label: nullableString(row.label),
    signingSecretSet: row.signing_secret_hash != null,
    lastFiredAt: nullableString(row.last_fired_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAutopilotRun(row: Row): MulticaAutopilotRun {
  return {
    id: String(row.id),
    autopilotId: String(row.autopilot_id),
    source: String(row.source ?? "manual") as MulticaAutopilotRun["source"],
    status: String(row.status ?? "running") as MulticaAutopilotRun["status"],
    issueId: nullableString(row.issue_id),
    taskId: nullableString(row.task_id),
    triggeredAt: String(row.triggered_at),
    completedAt: nullableString(row.completed_at),
    failureReason: nullableString(row.failure_reason),
    payload: row.payload == null ? null : parseJson(row.payload, null),
    result: row.result == null ? null : parseJson(row.result, null),
    createdAt: String(row.created_at),
  };
}

function toWebhookDelivery(row: Row): MulticaWebhookDelivery {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    autopilotId: String(row.autopilot_id),
    triggerId: String(row.trigger_id),
    provider: normalizeWebhookProvider(row.provider),
    event: String(row.event ?? "webhook.received"),
    dedupeKey: nullableString(row.dedupe_key),
    dedupeSource: nullableString(row.dedupe_source),
    signatureStatus: normalizeWebhookSignatureStatus(row.signature_status),
    status: normalizeWebhookDeliveryStatus(row.status),
    attemptCount: Number(row.attempt_count ?? 1),
    selectedHeaders: parseJson<Record<string, unknown>>(row.selected_headers, {}),
    contentType: nullableString(row.content_type),
    rawBody: nullableString(row.raw_body),
    responseStatus: row.response_status == null ? null : Number(row.response_status),
    responseBody: nullableString(row.response_body),
    autopilotRunId: nullableString(row.autopilot_run_id),
    replayedFromDeliveryId: nullableString(row.replayed_from_delivery_id),
    error: nullableString(row.error),
    receivedAt: String(row.received_at),
    lastAttemptAt: String(row.last_attempt_at),
    createdAt: String(row.created_at),
  };
}

function toChatSession(row: Row): MulticaChatSession {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    agentId: String(row.agent_id),
    title: String(row.title ?? ""),
    status: String(row.status ?? "active") as MulticaChatSession["status"],
    sessionId: nullableString(row.session_id),
    workDir: nullableString(row.work_dir),
    latestTaskId: nullableString(row.latest_task_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toChatMessage(row: Row): MulticaChatMessage {
  return {
    id: String(row.id),
    chatSessionId: String(row.chat_session_id),
    taskId: nullableString(row.task_id),
    role: String(row.role ?? "system") as MulticaChatMessage["role"],
    body: String(row.body ?? ""),
    createdAt: String(row.created_at),
  };
}

function toTask(row: Row): MulticaTask {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runtimeId: nullableString(row.runtime_id),
    issueId: nullableString(row.issue_id),
    chatSessionId: nullableString(row.chat_session_id),
    workspaceId: String(row.workspace_id ?? "local"),
    status: String(row.status) as MulticaTaskStatus,
    priority: Number(row.priority ?? 0),
    prompt: String(row.prompt ?? ""),
    result: nullableString(row.result),
    error: nullableString(row.error),
    branchName: nullableString(row.branch_name),
    sessionId: nullableString(row.session_id),
    workDir: nullableString(row.work_dir),
    progressSummary: nullableString(row.progress_summary),
    progressStep: row.progress_step == null ? null : Number(row.progress_step),
    progressTotal: row.progress_total == null ? null : Number(row.progress_total),
    usage: parseJson(row.usage, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    dispatchedAt: nullableString(row.dispatched_at),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    failedAt: nullableString(row.failed_at),
    cancelledAt: nullableString(row.cancelled_at),
  };
}

function toTaskMessage(row: Row): MulticaTaskMessage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    seq: Number(row.seq),
    type: String(row.type),
    tool: nullableString(row.tool),
    content: nullableString(row.content),
    input: row.input == null ? null : parseJson(row.input, null),
    output: nullableString(row.output),
    createdAt: String(row.created_at),
  };
}

export function isTerminalStatus(status: MulticaTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
