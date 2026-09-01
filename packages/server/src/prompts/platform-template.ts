import type { AgentTask } from "@daemon/contracts/types.js";
import {
  buildTaskPromptArtifact,
  type BuildTaskPromptOptions,
  type TaskPromptMode,
} from "@multiremi/prompt.js";

export interface PlatformPromptTemplatePreview {
  bootstrap: string;
  delta: string;
  sha256: {
    bootstrap: string;
    delta: string;
  };
}

const placeholder = (name: string): string => `{{${name}}}`;

export function buildPlatformPromptTemplatePreview(): PlatformPromptTemplatePreview {
  const bootstrap = buildPreviewArtifact("bootstrap");
  const delta = buildPreviewArtifact("delta");
  return {
    bootstrap: bootstrap.prompt,
    delta: delta.prompt,
    sha256: {
      bootstrap: bootstrap.sha256,
      delta: delta.sha256,
    },
  };
}

function buildPreviewArtifact(mode: TaskPromptMode) {
  const repoUrl = placeholder("repository_url");
  const task: AgentTask = {
    id: placeholder("task_id"),
    workspaceId: placeholder("workspace_id"),
    prompt: placeholder("current_request"),
    issueId: placeholder("issue_id"),
    issueSessionId: placeholder("issue_session_id"),
    chatSessionId: placeholder("chat_session_id"),
    autopilotRunId: placeholder("autopilot_run_id"),
    completedAt: null,
    createdAt: placeholder("created_at"),
    agent: {
      id: placeholder("agent_id"),
      name: placeholder("agent_name"),
      provider: "codex",
      model: placeholder("agent_model"),
      thinkingLevel: placeholder("thinking_level"),
      instructions: placeholder("agent_instructions"),
      skills: [{
        name: placeholder("skill_name"),
        description: placeholder("skill_description"),
        content: placeholder("skill_content"),
        files: [{ path: placeholder("skill_supporting_file_path") }],
      }],
      executable: placeholder("agent_executable"),
      allowedTools: [placeholder("allowed_tool")],
      customEnv: {},
    },
    issue: {
      id: placeholder("issue_id"),
      key: placeholder("issue_key"),
      title: placeholder("issue_title"),
      description: placeholder("issue_description"),
      metadata: { [placeholder("issue_metadata_key")]: placeholder("issue_metadata_value") },
    },
    issueSession: {
      id: placeholder("issue_session_id"),
      issueId: placeholder("issue_id"),
      title: placeholder("issue_session_title"),
    },
    sessionProjection: {
      sessionId: placeholder("provider_session_id"),
      targetAgentId: placeholder("agent_id"),
      mode,
      jsonl: placeholder("session_jsonl"),
    },
    issueSessionResults: [{
      id: placeholder("published_result_id"),
      title: placeholder("published_result_title"),
      body: placeholder("published_result_body"),
    }],
    project: {
      id: placeholder("project_id"),
      title: placeholder("project_title"),
      description: placeholder("project_description"),
      instructions: placeholder("project_instructions"),
      deltaInstructions: placeholder("project_delta_instructions"),
    },
    projectResources: [{
      id: placeholder("project_resource_id"),
      resourceType: "github_repo",
      resourceRef: {
        url: placeholder("project_repository_url"),
        defaultBranchHint: placeholder("project_repository_default_branch"),
      },
      label: placeholder("project_resource_label"),
    }],
    squadContext: {
      id: placeholder("squad_id"),
      name: placeholder("squad_name"),
      leaderAgentId: placeholder("agent_id"),
      members: [{
        agentId: placeholder("teammate_agent_id"),
        name: placeholder("teammate_name"),
        role: placeholder("teammate_role"),
        description: placeholder("teammate_description"),
      }],
    },
    repos: [
      { url: repoUrl, description: placeholder("repository_description") },
      { url: placeholder("additional_repository_url") },
    ],
    workDir: placeholder("work_dir"),
    runtimeId: placeholder("runtime_id"),
    workspaceContext: placeholder("workspace_context"),
    workspaceBootstrapPrompt: placeholder("workspace_bootstrap_prompt"),
    workspaceDeltaPrompt: placeholder("workspace_delta_prompt"),
    requestingUserName: placeholder("requesting_user_name"),
    requestingUserProfileDescription: placeholder("requesting_user_profile"),
    chatMessage: placeholder("chat_message"),
    chatMessageAttachments: [{
      id: placeholder("chat_attachment_id"),
      filename: placeholder("chat_attachment_filename"),
      content_type: placeholder("chat_attachment_content_type"),
    }],
    autopilotTitle: placeholder("autopilot_title"),
    autopilotDescription: placeholder("autopilot_description"),
    autopilotSource: placeholder("autopilot_source"),
    autopilotTriggerPayload: { payload: placeholder("autopilot_trigger_payload") },
    quickCreatePrompt: placeholder("quick_create_prompt"),
    triggerCommentId: placeholder("trigger_comment_id"),
    triggerThreadId: placeholder("trigger_thread_id"),
    triggerCommentContent: placeholder("trigger_comment_content"),
    triggerSummary: placeholder("trigger_summary"),
    triggerAuthorType: "agent",
    triggerAuthorName: placeholder("trigger_author_name"),
    newCommentsSince: placeholder("new_comments_since"),
    newCommentCount: 1,
    priorSessionId: placeholder("prior_session_id"),
    sessionId: placeholder("provider_session_id"),
  };
  const options: BuildTaskPromptOptions = {
    repoCheckouts: [{
      repoUrl,
      path: `/workspace/${placeholder("repository_checkout_path")}`,
      branch: placeholder("repository_checkout_branch"),
    }],
    repoWarnings: [
      {
        repoUrl: placeholder("stale_repository_url"),
        kind: "stale_cache",
        message: placeholder("stale_repository_diagnostic"),
      },
      {
        repoUrl: placeholder("unavailable_repository_url"),
        kind: "unavailable",
        message: placeholder("unavailable_repository_diagnostic"),
      },
    ],
  };
  return buildTaskPromptArtifact(task, options);
}
