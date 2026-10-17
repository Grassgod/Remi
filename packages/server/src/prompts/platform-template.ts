import type { AgentTask } from "@daemon/contracts/types.js";
import { buildTaskPromptArtifact, type BuildTaskPromptOptions } from "@multiremi/prompt.js";
import { createHash } from "node:crypto";

/**
 * The platform template (ADR 0023): the `AGENTS.md` Remi writes into the
 * provider home, and one turn's input, with every field a placeholder.
 */
export interface PlatformPromptTemplatePreview {
  instructions: string;
  input: string;
  sha256: {
    instructions: string;
    input: string;
  };
}

const placeholder = (name: string): string => `{{${name}}}`;

export function buildPlatformPromptTemplatePreview(): PlatformPromptTemplatePreview {
  const artifact = buildPreviewArtifact();
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    instructions: artifact.instructions,
    input: artifact.prompt,
    sha256: { instructions: sha(artifact.instructions), input: sha(artifact.prompt) },
  };
}

function buildPreviewArtifact() {
  const repoUrl = placeholder("repository_url");
  const task: AgentTask = {
    id: placeholder("task_id"),
    workspaceId: placeholder("workspace_id"),
    prompt: placeholder("current_request"),
    issueId: placeholder("issue_id"),
    issueSessionId: placeholder("issue_session_id"),
    chatSessionId: placeholder("chat_session_id"),
    // The all-fields preview uses a Feishu Issue topic: ordinary Chat turns
    // intentionally discard Issue, Project, repository, and result context.
    boundIssue: {
      id: placeholder("issue_id"),
      key: placeholder("issue_key"),
      title: placeholder("issue_title"),
      status: placeholder("issue_status"),
    },
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
    // One turn's input: an earlier message the range only lists (so the unread note shows) and the triggering comment.
    input_messages: [
      previewMessage(1, placeholder("earlier_message_id"), `${JSON.stringify({ type: "unread_range",
        session_id: placeholder("chat_session_id"), from_seq: 0, to_seq: 2, unread_count: 2,
        instruction: placeholder("unread_instruction") })}\n`, false),
      previewMessage(2, placeholder("trigger_comment_id"), placeholder("message_body"), true),
    ] as never,
    project: {
      id: placeholder("project_id"),
      title: placeholder("project_title"),
      description: placeholder("project_description"),
      instructions: placeholder("project_instructions"),
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
    workspacePrompt: placeholder("workspace_prompt"),
    // AGENTS.md names who the session belongs to; a turn from someone else names its sender in the input.
    sessionOwnerName: placeholder("session_owner_name"),
    sessionOwnerProfileDescription: placeholder("session_owner_profile"),
    requestingUserName: placeholder("sender_name"),
    requestingUserProfileDescription: placeholder("sender_profile"),
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
  // This is a canonical template without a target Runtime. Actual daemon
  // prompts use the execution host's platform, not the API server's OS.
  return buildTaskPromptArtifact(task, { ...options, platform: "linux" });
}

function previewMessage(seq: number, id: string, body: string, trigger: boolean): Record<string, unknown> {
  return {
    id, session_id: placeholder("chat_session_id"), seq, kind: "message", visibility: "shown", task_id: null,
    sender_type: "member", sender_id: placeholder("member_id"),
    to_type: trigger ? "agent" : "none", to_ref: trigger ? placeholder("agent_id") : null,
    to_agent_id: trigger ? placeholder("agent_id") : null, to_member_id: null, message_kind: "request",
    wake_requested: trigger ? "now" : "inbox_only", wake_applied: trigger ? "now" : "inbox_only",
    wake_reason: trigger ? "human_sender" : "no_recipient", reply_to_id: null, dedupe_key: null, options: null,
    card_token_hash: null, card_token_recipient: null, card_token_consumed_at: null, body_md: body, body_html: null,
    render_version: null, resolved_at: null, resolved_by_type: null, resolved_by_id: null, metadata: {}, revision: 1,
    created_at: placeholder("created_at"), updated_at: placeholder("created_at"), deleted_at: null,
  };
}
