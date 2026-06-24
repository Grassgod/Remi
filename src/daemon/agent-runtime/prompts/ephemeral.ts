import type { AgentTask } from "@daemon/contracts/types.js";

export function buildTaskPrompt(task: AgentTask): string {
  const sections: string[] = [];

  sections.push("# Task");
  sections.push(task.prompt.trim());

  appendClaimContextSections(sections, task);

  if (task.issue) {
    sections.push("");
    sections.push("## Issue");
    sections.push(`Key: ${task.issue.key}`);
    sections.push(`Title: ${task.issue.title}`);
    if (task.issue.description) sections.push(task.issue.description);
    const metadata = Object.entries(task.issue.metadata).sort(([left], [right]) => left.localeCompare(right));
    if (metadata.length) {
      sections.push("");
      sections.push("## Issue Metadata");
      sections.push("Pinned facts for this issue:");
      for (const [key, value] of metadata) {
        sections.push(`- ${key}: ${String(value)}`);
      }
    }
  }

  appendTriggerCommentSection(sections, task);

  if (task.project) {
    sections.push("");
    sections.push("## Project Context");
    sections.push(`This issue belongs to project: ${task.project.title}`);
    if (task.project.description) sections.push(task.project.description);
    if (task.projectResources.length) {
      sections.push("");
      sections.push("Project resources:");
      for (const resource of task.projectResources) {
        sections.push(formatProjectResource(resource));
      }
    }
  }

  if (task.repos.length) {
    sections.push("");
    sections.push("## Available Repositories");
    sections.push("Use `multiremi repo checkout <url> [--ref <branch-or-sha>]` to check out repositories into the working directory.");
    for (const repo of task.repos) {
      sections.push(repo.description ? `- ${repo.url} - ${repo.description}` : `- ${repo.url}`);
    }
  }

  if (task.agent?.instructions) {
    sections.push("");
    sections.push("## Agent Instructions");
    sections.push(task.agent.instructions);
  }

  if (task.agent?.skills.length) {
    sections.push("");
    sections.push("## Skills");
    for (const skill of task.agent.skills) {
      sections.push(`### ${skill.name}`);
      if (skill.description) sections.push(skill.description);
      sections.push(skill.content);
      if (skill.files?.length) {
        sections.push("Supporting files:");
        for (const file of skill.files) {
          sections.push(`- ${file.path}`);
        }
      }
    }
  }

  sections.push("");
  sections.push("## Output");
  sections.push("When finished, summarize what changed, how it was verified, and any remaining risks.");

  return sections.join("\n");
}

function appendClaimContextSections(sections: string[], task: AgentTask): void {
  const workspaceContext = stringField(task, "workspaceContext", "workspace_context");
  if (workspaceContext) {
    sections.push("");
    sections.push("## Workspace Context");
    sections.push(workspaceContext);
  }

  const requestingUserName = stringField(task, "requestingUserName", "requesting_user_name");
  const requestingUserProfile = stringField(task, "requestingUserProfileDescription", "requesting_user_profile_description");
  if (requestingUserName || requestingUserProfile) {
    sections.push("");
    sections.push("## Requesting User");
    if (requestingUserName) sections.push(`Name: ${requestingUserName}`);
    if (requestingUserProfile) sections.push(requestingUserProfile);
  }

  const chatMessage = stringField(task, "chatMessage", "chat_message");
  if (chatMessage) {
    sections.push("");
    sections.push("## Chat Message");
    sections.push(chatMessage);
    const attachments = arrayField(task, "chatMessageAttachments", "chat_message_attachments");
    if (attachments.length) {
      sections.push("");
      sections.push("Attachments:");
      for (const attachment of attachments) sections.push(formatChatAttachment(attachment));
    }
  }

  const autopilotTitle = stringField(task, "autopilotTitle", "autopilot_title");
  const autopilotDescription = stringField(task, "autopilotDescription", "autopilot_description");
  const autopilotSource = stringField(task, "autopilotSource", "autopilot_source");
  const autopilotPayload = unknownField(task, "autopilotTriggerPayload", "autopilot_trigger_payload");
  if (autopilotTitle || autopilotDescription || autopilotSource || autopilotPayload != null) {
    sections.push("");
    sections.push("## Autopilot Context");
    if (autopilotTitle) sections.push(`Title: ${autopilotTitle}`);
    if (autopilotSource) sections.push(`Source: ${autopilotSource}`);
    if (autopilotDescription) {
      sections.push("");
      sections.push(autopilotDescription);
    }
    if (autopilotPayload != null) {
      sections.push("");
      sections.push("Trigger payload:");
      sections.push(formatJsonBlock(autopilotPayload));
    }
  }

  const quickCreatePrompt = stringField(task, "quickCreatePrompt", "quick_create_prompt");
  if (quickCreatePrompt) {
    sections.push("");
    sections.push("## Quick Create Request");
    sections.push(quickCreatePrompt);
  }
}

function appendTriggerCommentSection(sections: string[], task: AgentTask): void {
  const triggerCommentId = stringField(task, "triggerCommentId", "trigger_comment_id");
  if (!triggerCommentId) return;
  const issueId = stringField(task, "issueId", "issue_id") ?? task.issue?.id ?? "";
  const triggerThreadId = stringField(task, "triggerThreadId", "trigger_thread_id");
  const triggerContent = stringField(task, "triggerCommentContent", "trigger_comment_content")
    ?? stringField(task, "triggerSummary", "trigger_summary");
  const authorType = stringField(task, "triggerAuthorType", "trigger_author_type");
  const authorName = stringField(task, "triggerAuthorName", "trigger_author_name");
  const newCommentsSince = stringField(task, "newCommentsSince", "new_comments_since");
  const newCommentCount = numberField(task, "newCommentCount", "new_comment_count");
  const priorSessionId = stringField(task, "priorSessionId", "prior_session_id")
    ?? stringField(task, "sessionId", "session_id");

  sections.push("");
  sections.push("## Triggering Comment");
  sections.push(`${commentAuthorLabel(authorType, authorName)} just left a new comment. Focus on this comment and do not confuse it with previous comments.`);
  if (triggerContent) {
    sections.push("");
    sections.push(blockquote(triggerContent));
  }
  if (authorType === "agent") {
    sections.push("");
    sections.push("The triggering comment was posted by another agent. If it is only an acknowledgment, thanks, or sign-off and you produced no work this turn, do not reply. If you did real work, post the result as a normal reply. Do not mention the other agent as a sign-off.");
  }

  const readHint = buildCommentReadHint(issueId, triggerCommentId, triggerThreadId, newCommentsSince, newCommentCount, Boolean(priorSessionId));
  if (readHint) {
    sections.push("");
    sections.push(readHint);
  }
  const replyInstructions = buildCommentReplyInstructions(issueId, triggerCommentId);
  if (replyInstructions) {
    sections.push("");
    sections.push(replyInstructions);
  }
}

function buildCommentReadHint(
  issueId: string,
  triggerCommentId: string,
  triggerThreadId: string | null,
  newCommentsSince: string | null,
  newCommentCount: number,
  hasPriorSession: boolean,
): string {
  const threadId = triggerThreadId || triggerCommentId;
  if (!issueId || !threadId) return "";
  if (newCommentCount > 0 && newCommentsSince) {
    return `${newCommentCount} new comment(s) on this issue since your last run. Start with the thread your triggering comment is in: \`multiremi issue comment list ${issueId} --thread ${threadId} --since ${newCommentsSince} --output json\` (swap \`--since\` for \`--tail 30\` if you need the full thread). Only if you need context from other threads, catch up issue-wide: \`multiremi issue comment list ${issueId} --since ${newCommentsSince} --output json\`.`;
  }
  if (hasPriorSession) {
    return `You are resuming a prior session, and the triggering comment is already included above. Use active thread anchor \`${threadId}\` and triggering comment ID \`${triggerCommentId}\`. If your reply depends on thread context, refresh the triggering conversation first: \`multiremi issue comment list ${issueId} --thread ${threadId} --tail 30 --output json\`.`;
  }
  return `Read the triggering conversation first: \`multiremi issue comment list ${issueId} --thread ${threadId} --tail 30 --output json\`. Need cross-thread background? \`multiremi issue comment list ${issueId} --recent 20 --output json\`.`;
}

function buildCommentReplyInstructions(issueId: string, triggerCommentId: string): string {
  if (!issueId || !triggerCommentId) return "";
  if (process.platform === "win32") {
    return [
      "If you decide to reply, post it as a comment. Always use the trigger comment ID below, and do not reuse --parent values from previous turns.",
      "",
      `On Windows, write the reply body to a UTF-8 file, then run: \`multiremi issue comment add ${issueId} --parent ${triggerCommentId} --content-file ./reply.md\`.`,
      "Do not pipe via --content-stdin on Windows, and do not use inline --content.",
    ].join("\n");
  }
  return [
    "If you decide to reply, post it as a comment. Always use the trigger comment ID below, and do not reuse --parent values from previous turns.",
    "",
    "Use --content-stdin with a quoted HEREDOC so the shell cannot rewrite backticks, $(), variables, quotes, or formatting:",
    "",
    `    cat <<'COMMENT' | multiremi issue comment add ${issueId} --parent ${triggerCommentId} --content-stdin`,
    "    First paragraph.",
    "",
    "    Second paragraph.",
    "    COMMENT",
  ].join("\n");
}

function commentAuthorLabel(authorType: string | null, authorName: string | null): string {
  if (authorType === "agent") return authorName ? `Another agent (${authorName})` : "Another agent";
  if (authorName) return authorName;
  return "A user";
}

function blockquote(text: string): string {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function formatJsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function formatChatAttachment(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `- ${String(value)}`;
  const attachment = value as Record<string, unknown>;
  const id = typeof attachment.id === "string" ? attachment.id : "";
  const filename = typeof attachment.filename === "string" ? attachment.filename : "";
  const contentType = typeof attachment.content_type === "string"
    ? attachment.content_type
    : typeof attachment.contentType === "string"
      ? attachment.contentType
      : "";
  const label = [filename, contentType ? `(${contentType})` : ""].filter(Boolean).join(" ");
  return `- ${[id, label].filter(Boolean).join(" - ") || JSON.stringify(value)}`;
}

function stringField(task: AgentTask, camel: keyof AgentTask, snake: keyof AgentTask): string | null {
  const value = task[camel] ?? task[snake];
  return typeof value === "string" && value.trim() ? value : null;
}

function arrayField(task: AgentTask, camel: keyof AgentTask, snake: keyof AgentTask): unknown[] {
  const value = task[camel] ?? task[snake];
  return Array.isArray(value) ? value : [];
}

function unknownField(task: AgentTask, camel: keyof AgentTask, snake: keyof AgentTask): unknown | null {
  return task[camel] ?? task[snake] ?? null;
}

function numberField(task: AgentTask, camel: keyof AgentTask, snake: keyof AgentTask): number {
  const value = task[camel] ?? task[snake];
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function formatProjectResource(resource: AgentTask["projectResources"][number]): string {
  if (resource.resourceType === "github_repo") {
    const url = String(resource.resourceRef.url ?? "");
    const branch = String(resource.resourceRef.defaultBranchHint ?? resource.resourceRef.default_branch_hint ?? "");
    return branch ? `- GitHub repo: ${url} (default branch: ${branch})` : `- GitHub repo: ${url}`;
  }
  if (resource.resourceType === "local_directory") {
    const path = String(resource.resourceRef.localPath ?? resource.resourceRef.local_path ?? "");
    const label = String(resource.resourceRef.label ?? "").trim();
    return label ? `- Local directory: ${path} (${label})` : `- Local directory: ${path}`;
  }
  return `- ${resource.resourceType}: ${JSON.stringify(resource.resourceRef)}`;
}
