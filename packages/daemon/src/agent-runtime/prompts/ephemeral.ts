import type { AgentTask, AgentTaskProjectDocEntry } from "@daemon/contracts/types.js";

export function buildTaskPrompt(task: AgentTask): string {
  const sections: string[] = [];

  sections.push("# Task");
  sections.push(task.prompt.trim());

  appendClaimContextSections(sections, task);
  appendSessionContextSections(sections, task);

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
    appendProjectKnowledgeSections(sections, task, task.project.id);
  }

  if (task.repos.length) {
    sections.push("");
    sections.push("## Available Repositories");
    sections.push("Use `remi repo checkout <url> [--ref <branch-or-sha>]` to check out repositories into the working directory.");
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

function appendSessionContextSections(sections: string[], task: AgentTask): void {
  const issueSession = task.issueSession ?? task.issue_session ?? null;
  const projection = task.sessionProjection ?? task.session_projection ?? null;
  if (projection?.jsonl?.trim()) {
    sections.push("");
    sections.push("## Current Session Context");
    if (issueSession?.title) sections.push(`Session: ${issueSession.title}`);
    sections.push(
      projection.mode === "bootstrap"
        ? "This is your first turn on this provider-session lineage. The JSONL below is the complete canonical session history from your perspective."
        : "You are resuming your own provider session. The JSONL below contains only canonical events added since your last committed cursor.",
    );
    sections.push("`assistant_history` means your own earlier output; `external_agent` means a named peer; `user` means a human; `operator` means authoritative orchestration state.");
    sections.push("Treat event order and author labels as authoritative. Do not claim another participant's words as your own.");
    sections.push("");
    sections.push(`\`\`\`jsonl\n${projection.jsonl.trim()}\n\`\`\``);
  }

  const results = task.issueSessionResults ?? task.issue_session_results ?? [];
  if (results.length) {
    sections.push("");
    sections.push("## Published Results From Other Sessions");
    sections.push("These are read-only published outputs. They do not include the other sessions' private working transcripts.");
    for (const result of results) {
      const title = result.title?.trim() || result.id;
      sections.push("");
      sections.push(`### ${title}`);
      sections.push(result.body);
    }
  }

  const issueId = stringField(task, "issueId", "issue_id") ?? task.issue?.id ?? "";
  const sessionId = issueSession?.id ?? "";
  if (issueId && sessionId) {
    sections.push("");
    sections.push("## Sharing Results Across Sessions");
    sections.push("Sibling Session transcripts are private. If you produce a durable decision, artifact, or finding that other Sessions should reuse, explicitly publish only that result. Do not republish an unchanged result.");
    if (process.platform === "win32") {
      sections.push(`Write the result body to a UTF-8 file, then run: \`remi issue session result publish ${issueId} --session ${sessionId} --title "Short title" --type decision --content-file ./session-result.md\`.`);
    } else {
      sections.push([
        "Use a quoted HEREDOC so the shell cannot rewrite the result:",
        "",
        `    cat <<'RESULT' | remi issue session result publish ${issueId} --session ${sessionId} --title "Short title" --type decision --content-stdin`,
        "    Reusable result only; omit private working notes.",
        "    RESULT",
      ].join("\n"));
    }
    sections.push("Tag the result with `--type mr|report|deploy|decision|doc|other` so it is filed under the right icon, and link what it points at with repeatable `--ref issue:<id>` / `--ref task:<id>` / `--ref url:https://…` (a merge request, a document, a task).");
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

  const projection = task.sessionProjection ?? task.session_projection ?? null;
  if (projection?.jsonl?.trim()) {
    sections.push("");
    sections.push("The current product Session history is already injected above. Do not re-read the whole Issue comment history merely to reconstruct context.");
  } else {
    const readHint = buildCommentReadHint(issueId, triggerCommentId, triggerThreadId, newCommentsSince, newCommentCount, Boolean(priorSessionId));
    if (readHint) {
      sections.push("");
      sections.push(readHint);
    }
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
    return `${newCommentCount} new comment(s) on this issue since your last run. Start with the thread your triggering comment is in: \`remi issue comment list ${issueId} --thread ${threadId} --since ${newCommentsSince} --output json\` (swap \`--since\` for \`--tail 30\` if you need the full thread). Only if you need context from other threads, catch up issue-wide: \`remi issue comment list ${issueId} --since ${newCommentsSince} --output json\`.`;
  }
  if (hasPriorSession) {
    return `You are resuming a prior session, and the triggering comment is already included above. Use active thread anchor \`${threadId}\` and triggering comment ID \`${triggerCommentId}\`. If your reply depends on thread context, refresh the triggering conversation first: \`remi issue comment list ${issueId} --thread ${threadId} --tail 30 --output json\`.`;
  }
  return `Read the triggering conversation first: \`remi issue comment list ${issueId} --thread ${threadId} --tail 30 --output json\`. Need cross-thread background? \`remi issue comment list ${issueId} --recent 20 --output json\`.`;
}

function buildCommentReplyInstructions(issueId: string, triggerCommentId: string): string {
  if (!issueId || !triggerCommentId) return "";
  if (process.platform === "win32") {
    return [
      "If you decide to reply, post it as a comment. Always use the trigger comment ID below, and do not reuse --parent values from previous turns.",
      "",
      `On Windows, write the reply body to a UTF-8 file, then run: \`remi issue comment add ${issueId} --parent ${triggerCommentId} --content-file ./reply.md\`.`,
      "Do not pipe via --content-stdin on Windows, and do not use inline --content.",
    ].join("\n");
  }
  return [
    "If you decide to reply, post it as a comment. Always use the trigger comment ID below, and do not reuse --parent values from previous turns.",
    "",
    "Use --content-stdin with a quoted HEREDOC so the shell cannot rewrite backticks, $(), variables, quotes, or formatting:",
    "",
    `    cat <<'COMMENT' | remi issue comment add ${issueId} --parent ${triggerCommentId} --content-stdin`,
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

const PROJECT_MEMORY_BUDGET = 4000;
const PROJECT_MEMORY_BODY_LIMIT = 200;
const PROJECT_WIKI_BUDGET = 2000;
const PROJECT_WIKI_SUMMARY_LIMIT = 120;
const PROJECT_ENTRY_TITLE_LIMIT = 200;

function appendProjectKnowledgeSections(sections: string[], task: AgentTask, projectId: string): void {
  const docs = task.projectDocs ?? task.project_docs ?? null;

  const memoryLines = budgetedEntryLines((docs?.memory ?? []).map(formatProjectMemoryEntry), PROJECT_MEMORY_BUDGET);
  if (memoryLines.length) {
    sections.push("");
    sections.push("## Project Memory");
    sections.push("Durable facts recorded by earlier work on this project:");
    for (const line of memoryLines) sections.push(line);
  }

  const wikiLines = budgetedEntryLines((docs?.wiki ?? []).map(formatProjectWikiEntry), PROJECT_WIKI_BUDGET);
  if (wikiLines.length) {
    sections.push("");
    sections.push("## Project Wiki");
    sections.push("Wiki pages for this project (titles only — read a page before relying on it):");
    for (const line of wikiLines) sections.push(line);
  }

  sections.push("");
  sections.push("## Project Knowledge Commands");
  sections.push(`Read a page: \`remi project doc get ${projectId} <slug-or-id>\``);
  sections.push(`Search project knowledge: \`remi project doc search ${projectId} "<query>"\``);
  sections.push("");
  sections.push("When you finish, write back what you learned that other issues in this project will reuse — build/test commands, architecture decisions, pitfalls. Integrate it into what is already here instead of piling up new entries:");
  sections.push(`1. Search first: \`remi project doc search ${projectId} "<query>"\`, then \`remi project doc get ${projectId} <slug-or-id>\` on anything related.`);
  sections.push(`2. Update, do not create: when a related entry exists, revise it with \`remi project doc update ${projectId} <slug-or-id> --content-stdin\`. If your finding contradicts it, say in the body what changed and on what evidence — never leave both versions standing.`);
  sections.push(`3. Only genuinely new facts get a new entry: \`remi project memory add ${projectId} --title 'One-sentence fact'\` (template below).`);
  sections.push(`4. Durable syntheses — architecture notes, runbooks — belong in a wiki page: \`remi project doc create ${projectId} --kind wiki --title "<title>" --content-stdin\`.`);
  sections.push("5. Cite sources on every write with `--ref issue:<id>` / `--ref task:<id>` / `--ref url:<url>`, and cross-link related pages with `[[slug]]` links in the body.");
  sections.push("6. Do not record one-off details that only matter for this issue.");
  sections.push("");
  sections.push([
    "Use --content-stdin with a quoted HEREDOC for the body, and single-quote the title, so the shell cannot rewrite backticks, $(), variables, quotes, or formatting:",
    "",
    `    cat <<'MEMORY' | remi project memory add ${projectId} --title 'One-sentence fact' --content-stdin`,
    "    Supporting detail worth keeping.",
    "    MEMORY",
  ].join("\n"));

  const schema = typeof docs?.schema === "string" ? docs.schema.trim() : "";
  if (schema) {
    sections.push("");
    sections.push("Maintenance rules for this project's wiki (from _schema):");
    sections.push(schema);
    sections.push(`Revise these rules with \`remi project doc update ${projectId} _schema --content-stdin\` when the project's conventions change.`);
  }
}

function budgetedEntryLines(lines: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length && used + line.length > budget) {
      kept.push("(more entries exist — use search)");
      break;
    }
    kept.push(line);
    used += line.length;
  }
  return kept;
}

/**
 * Titles are agent-written free text landing verbatim in the prompt. Flattening
 * whitespace stops an embedded newline from forging a `##` section of its own,
 * and the cap stops one title from eating a whole section: budgetedEntryLines
 * always keeps the first line, so an unbounded title bypasses the budget.
 */
function entryTitle(entry: AgentTaskProjectDocEntry): string {
  const flattened = entry.title.replace(/\s+/g, " ").trim();
  return truncateText(flattened || entry.slug, PROJECT_ENTRY_TITLE_LIMIT);
}

function formatProjectMemoryEntry(entry: AgentTaskProjectDocEntry): string {
  const title = entryTitle(entry);
  // `memory add --summary` is stored and shipped but has no other rendering, so
  // it stands in for a missing body rather than being dropped on the floor.
  const detail = firstLine(entry.body) || firstLine(entry.summary);
  return detail ? `- ${title}: ${truncateText(detail, PROJECT_MEMORY_BODY_LIMIT)}` : `- ${title}`;
}

function formatProjectWikiEntry(entry: AgentTaskProjectDocEntry): string {
  const head = `- ${entryTitle(entry)} (slug: ${entry.slug})`;
  const summary = firstLine(entry.summary);
  return summary ? `${head} - ${truncateText(summary, PROJECT_WIKI_SUMMARY_LIMIT)}` : head;
}

function firstLine(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
