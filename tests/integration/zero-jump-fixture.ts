#!/usr/bin/env bun
/**
 * Deterministic fixture for the MUL-394 zero-jump check.
 *
 * The plan (§5) fixes the shapes the check must exercise, so this file owns them
 * in one place and the check itself stays about measurement and verdicts:
 *
 *  - a short issue with 3 comments;
 *  - the F398 assignment with a long description, 20 queued runs and 60 updates;
 *  - a long issue with 250 comments carrying ~20 code blocks, 5 images, replies
 *    and activity, spread over 3 sessions (one of them the default);
 *  - one running task with messages, so the agent stream row renders;
 *  - the long issue's 40th message addressed to the reader, which is what the
 *    inbox deep-link round follows.
 *
 * Everything is written through the store API except where the store has no
 * path for the running state a daemon would have produced.
 */
import type { MultiremiStore } from "@multiremi/store.js";

/** The plan's numbers, named so the report and the assertion cannot drift. */
export const FIXTURE = {
  shortComments: 3,
  longComments: 250,
  /** 1-based index of the comment the inbox deep link targets. */
  deepLinkCommentIndex: 40,
  codeBlocks: 20,
  images: 5,
  sessions: 3,
  f398Comments: 4,
  f398QueuedTasks: 20,
  f398Updates: 60,
} as const;

export interface ZeroJumpFixture {
  workspaceId: string;
  workspaceSlug: string;
  memberId: string;
  userId: string;
  shortIssueId: string;
  f398IssueId: string;
  parentIssueId: string;
  waitingChildIssueId: string;
  ungrantedParentIssueId: string;
  ineffectiveParentIssueId: string;
  disabledParentIssueId: string;
  decisionActivityIssueId: string;
  parentOwnerAgentId: string;
  replacementAgentId: string;
  xlongIssueId: string;
  htmlAttachmentId: string;
  longIssueId: string;
  longDefaultSessionId: string;
  longSessionIds: string[];
  /** The 40th comment of the long issue, in creation order. */
  deepLinkCommentId: string;
  deepLinkCommentSessionId: string;
  runningIssueId: string;
  runningTaskId: string;
  inboxItemId: string;
  counts: {
    longComments: number;
    longCodeBlocks: number;
    longImages: number;
    sessions: number;
    runningMessages: number;
    f398Comments: number;
    f398QueuedTasks: number;
    f398Updates: number;
  };
}

/**
 * Flips a task to `running` the way a daemon's dispatch would.
 *
 * The schema fields written here are the ones the issue detail's agent-stream
 * row reads; there is no store method that performs a dispatch, and calling the
 * real scheduler would need a runtime this fixture must not have.
 */
function markTaskRunning(store: MultiremiStore, taskId: string): void {
  const startedAt = new Date().toISOString();
  const db = (store as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db;
  db.run(
    "UPDATE multiremi_turn_attempts SET status = 'running', accepted_at = ?, started_at = ?, updated_at = ? WHERE id = ?",
    [startedAt, startedAt, startedAt, taskId],
  );
  db.run("UPDATE multiremi_turns SET status = 'running', started_at = ? WHERE current_attempt_id = ?", [startedAt, taskId]);
}

/** A 1x1 PNG, so the image rows render a real attachment without a remote fetch. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function filler(prefix: string, index: number, repeats: number): string {
  const chunk = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  return `${prefix} #${index}\n\n${chunk.repeat(repeats)}`;
}

/**
 * Seeds the fixture into an in-memory store. Writes nothing outside the store;
 * the caller owns the database lifetime.
 */
export async function seedZeroJumpFixture(store: MultiremiStore): Promise<ZeroJumpFixture> {
  const workspace = store.ensureLocalWorkspace();
  const user = store.getCurrentUser();
  const member = store.getWorkspaceMember("mem_local_local")
    ?? store.createWorkspaceMember({
      id: "mem_local_local",
      workspaceId: workspace.id,
      userId: user.id,
      name: user.name ?? "Owner",
      role: "owner",
    });

  // ── short issue ───────────────────────────────────────────────────────────
  const shortIssue = store.createIssue({
    id: "iss_zerojump_short",
    title: "Zero-jump short issue",
    description: "Three comments. The smallest detail page the check measures.",
    status: "in_progress",
    priority: "medium",
  });
  const shortSession = store.getOrCreateDefaultIssueSession(shortIssue.id, user.id);
  for (let i = 1; i <= FIXTURE.shortComments; i += 1) {
    store.createIssueComment(shortIssue.id, {
      issueSessionId: shortSession.id,
      authorType: "member",
      authorId: user.id,
      body: `short comment ${i}`,
    });
  }

  // MUL-501 2a / MUL-519 F398: a long assignment with a heading, twenty
  // paragraphs and enough queued runs to exceed the deferred footer slot.
  const f398Description = "# F398 heading\n\n" + Array.from({ length: 10 }, (_, index) =>
    `## Stable section ${index + 1}\n\n` + "Synthetic QA dispatch content with explicit checks. ".repeat(10),
  ).join("\n\n");
  const f398Issue = store.createIssue({
    id: "iss_zerojump_f398", title: "Zero-jump F398 assignment", description: f398Description,
    status: "in_progress", priority: "medium",
  });
  const f398Session = store.getOrCreateDefaultIssueSession(f398Issue.id, user.id);
  for (let index = 0; index < FIXTURE.f398Comments; index += 1) {
    store.createIssueComment(f398Issue.id, {
      issueSessionId: f398Session.id, authorType: "member", authorId: user.id,
      body: `F398 comment ${index + 1}.`,
    });
  }
  for (let index = 0; index < FIXTURE.f398QueuedTasks; index += 1) {
    // A single agent/session lane coalesces requests into one pending turn.
    const f398Agent = store.createAgent({
      id: `agt_zerojump_f398_${index}`, name: `F398 unbound agent ${index + 1}`, provider: "codex",
    });
    store.createTask({ id: `tsk_zerojump_f398_${index}`, agentId: f398Agent.id, issueId: f398Issue.id,
      prompt: `F398 dispatch ${index + 1}\n\n${f398Description}` });
  }
  for (let index = 0; index < FIXTURE.f398Updates; index += 1) {
    store.updateIssue(f398Issue.id, {
      title: `F398 synthetic activity ${index + 1}`,
      priority: (["low", "high", "medium", "urgent"] as const)[index % 4],
      actorType: "member", actorId: user.id,
    });
  }

  const parentOwner = store.createAgent({
    id: "agt_zerojump_parent_owner",
    name: "Parent owner agent",
    provider: "codex",
    workspaceId: workspace.id,
    ownerId: user.id,
    visibility: "workspace",
  });
  const replacementAgent = store.createAgent({
    id: "agt_zerojump_parent_replacement",
    name: "Replacement owner agent",
    provider: "codex",
    workspaceId: workspace.id,
    ownerId: user.id,
    visibility: "workspace",
  });
  const sourceAgent = store.createAgent({
    id: "agt_zerojump_decision_source",
    name: "Decision source agent",
    provider: "codex",
    workspaceId: workspace.id,
    ownerId: user.id,
    visibility: "workspace",
  });
  const parentIssue = store.createIssue({
    id: "iss_zerojump_parent",
    title: "Parent issue with four sub-issues",
    description: "The child list belongs in the sidebar while this document stays still.",
    status: "in_progress",
    assigneeType: "agent",
    assigneeId: parentOwner.id,
  });
  const parentSession = store.getOrCreateDefaultIssueSession(parentIssue.id, user.id);
  store.createIssueComment(parentIssue.id, {
    issueSessionId: parentSession.id,
    authorType: "member",
    authorId: user.id,
    body: "The parent issue has a message anchor for the zero-jump measurement.",
  });
  store.createIssue({ title: "Blocked child", status: "blocked", parentIssueId: parentIssue.id });
  const waitingChild = store.createIssue({ title: "Waiting child", status: "backlog", parentIssueId: parentIssue.id });
  const waitingChildSession = store.getOrCreateDefaultIssueSession(waitingChild.id, user.id);
  store.createIssueComment(waitingChild.id, {
    issueSessionId: waitingChildSession.id, authorType: "member", authorId: user.id,
    body: "A child Issue with a parent and a real message anchor.",
  });
  const activeChild = store.createIssue({
    title: "Active child",
    status: "in_progress",
    parentIssueId: parentIssue.id,
    assigneeType: "agent",
    assigneeId: sourceAgent.id,
  });
  store.createIssue({ title: "Completed child", status: "done", parentIssueId: parentIssue.id });
  store.createIssueDependency(waitingChild.id, { dependsOnIssueId: activeChild.id, type: "blocked_by" });

  const parentOwnerTask = store.createTask({
    id: "tsk_zerojump_parent_owner",
    agentId: parentOwner.id,
    issueId: parentIssue.id,
    issueSessionId: parentSession.id,
    prompt: "Decide requests raised by child issues",
  });
  const sourceTask = store.createTask({
    id: "tsk_zerojump_decision_source",
    agentId: sourceAgent.id,
    issueId: activeChild.id,
    prompt: "Raise decisions for the parent",
  });
  const decisionActor = { type: "agent" as const, id: sourceAgent.id, taskId: sourceTask.id };
  const productionDecision = store.createIssueDecision(activeChild.id, {
    kind: "production_change",
    title: "Approve the production rollout",
    body: "May the child deploy the verified image during tonight's maintenance window?",
    options: ["Wait", "Approve rollout"],
  }, decisionActor);
  const answeredDecision = store.createIssueDecision(activeChild.id, {
    kind: "merge",
    title: "Merge after QA",
    body: "The owner answered this first; a member can review and change that answer.",
    options: ["Wait", "Merge after QA"],
  }, decisionActor);
  store.answerIssueDecision(parentIssue.id, answeredDecision.id, {
    answer: "Merge after QA",
    reason: "All required checks passed",
    overturn: "Change the answer if QA finds a regression",
  }, { type: "agent", id: parentOwner.id, taskId: parentOwnerTask.id });
  store.createIssueDecision(activeChild.id, {
    kind: "criteria",
    title: "Confirm the acceptance criteria",
    body: "The owner is still reviewing this item.",
    options: ["Keep reviewing", "Criteria accepted"],
  }, decisionActor);
  const humanRequestTask = store.createTask({
    id: "tsk_zerojump_human_request",
    agentId: sourceAgent.id,
    issueId: activeChild.id,
    prompt: "Ask a member to choose the rollout window",
  });
  store.createTaskHumanRequest({
    taskId: humanRequestTask.id,
    kind: "question",
    payload: {
      message: "Choose the rollout window",
      questions: [{
        fieldKey: "window",
        question: {
          question: "When should the rollout begin?",
          header: "Rollout window",
          options: [
            { label: "Tonight", description: "Use the scheduled maintenance window" },
            { label: "Tomorrow", description: "Wait for another review cycle" },
          ],
          multiSelect: false,
        },
      }],
    },
  });
  store.grantParentDone(parentIssue.id, member.id);

  const ungrantedParent = store.createIssue({
    id: "iss_zerojump_parent_ungranted",
    title: "Parent without done authorization",
    status: "in_progress",
    assigneeType: "agent",
    assigneeId: parentOwner.id,
  });
  store.createIssue({ title: "Ungrant parent child", parentIssueId: ungrantedParent.id, status: "in_progress" });

  const ineffectiveParent = store.createIssue({
    id: "iss_zerojump_parent_ineffective",
    title: "Parent with expired authorization",
    status: "in_progress",
    assigneeType: "agent",
    assigneeId: parentOwner.id,
  });
  store.createIssue({ title: "Expired grant child", parentIssueId: ineffectiveParent.id, status: "in_progress" });
  store.grantParentDone(ineffectiveParent.id, member.id);
  store.updateIssue(ineffectiveParent.id, { assigneeType: "agent", assigneeId: replacementAgent.id });

  const disabledOwner = store.createWorkspaceMember({
    id: "usr_zerojump_member_owner",
    workspaceId: workspace.id,
    userId: "usr_zerojump_member_owner",
    name: "Member owner",
    role: "member",
  });
  const disabledParent = store.createIssue({
    id: "iss_zerojump_parent_disabled",
    title: "Parent owned by a member",
    status: "in_progress",
    assigneeType: "member",
    assigneeId: disabledOwner.id,
  });
  store.createIssue({ title: "Member-owned parent child", parentIssueId: disabledParent.id, status: "in_progress" });

  const decisionActivityIssue = store.createIssue({
    id: "iss_zerojump_decision_activity",
    title: "Decision activity aggregate timeline fixture",
    status: "in_progress",
  });
  store.createIssueDecision(decisionActivityIssue.id, {
    kind: "question",
    title: "Choose the release channel",
    body: "This activity exercises the aggregate Issue timeline formatter.",
    options: ["Stable", "Preview"],
  }, { type: "member", id: member.id, taskId: null });
  if (productionDecision.status !== "escalated") {
    throw new Error("production decision fixture must wait on a member");
  }

  // ── long issue: 250 comments over three sessions ──────────────────────────
  // Agents give the sessions distinct participants; the store joins comment
  // authors to their session, so reusing one author would collapse the lanes.
  const longIssue = store.createIssue({
    id: "iss_zerojump_long",
    title: "Zero-jump long issue",
    description: "250 comments with code blocks, images and replies.",
    status: "in_progress",
    priority: "high",
  });
  const defaultSession = store.getOrCreateDefaultIssueSession(longIssue.id, user.id);
  const longSessionIds = [defaultSession.id];
  for (let i = 2; i <= FIXTURE.sessions; i += 1) {
    const side = store.createIssueSession(longIssue.id, { title: `Side session ${i}` });
    longSessionIds.push(side.id);
  }

  // One attachment per image, owned by the long issue: the markdown rows point
  // at `/api/attachments/<id>/content`, which the API serves off the upload dir.
  const imageAttachmentIds: string[] = [];
  for (let i = 0; i < FIXTURE.images; i += 1) {
    const attachment = store.createAttachment({
      id: `att_zerojump_img_${i}`,
      workspaceId: workspace.id,
      issueId: longIssue.id,
      uploaderType: "member",
      uploaderId: user.id,
      filename: `zero-jump-${i}.png`,
      url: `/api/attachments/att_zerojump_img_${i}/content`,
      contentType: "image/png",
      sizeBytes: Buffer.from(PNG_1X1, "base64").length,
    });
    imageAttachmentIds.push(attachment.id);
  }

  const commentIds: string[] = [];
  // Only root comments are reply candidates: a reply has to belong to its
  // parent's session, so `latestRoot` tracks the most recent root per session.
  const latestRootId: Array<string | null> = longSessionIds.map(() => null);
  const codeBlockEvery = Math.floor(FIXTURE.longComments / FIXTURE.codeBlocks);
  const imageEvery = Math.floor(FIXTURE.longComments / FIXTURE.images);
  for (let index = 1; index <= FIXTURE.longComments; index += 1) {
    // Rotation across the three sessions, the first of which is the default.
    const sessionSlot = (index - 1) % longSessionIds.length;
    const sessionId = longSessionIds[sessionSlot]!;
    const parts: string[] = [`long comment ${index}`];
    if (index % codeBlockEvery === 0) {
      parts.push([
        "```ts",
        `export function section${index}(input: string): string {`,
        `  return input.trim() + "${"x".repeat(24)}";`,
        "}",
        "```",
      ].join("\n"));
    }
    if (imageAttachmentIds.length > 0 && index % imageEvery === 0) {
      const attachmentId = imageAttachmentIds[(index / imageEvery - 1) % imageAttachmentIds.length]!;
      parts.push(`![zero-jump-${index}](/api/attachments/${attachmentId}/content)`);
    }
    // Replies carry the parent, which is what puts them on the reply lane. The
    // parent is the newest root *in this session*: a reply must belong to its
    // parent's session, so the rotating sessions cannot share one parent.
    const parentId = index % 7 === 0 ? latestRootId[sessionSlot] : null;
    parts.push(filler("body", index, index % 11 === 0 ? 40 : 6));
    const comment = index === FIXTURE.deepLinkCommentIndex ? store.sendMessage({
      session_id: sessionId, sender: { type: "member", id: member.id },
      to: { type: "member", ref: member.id }, message_kind: "reply", wake_requested: "inbox_only",
      body_md: parts.join("\n\n"), ...(parentId ? { reply_to_id: parentId } : {}),
    }).message : store.createIssueComment(longIssue.id, {
      issueSessionId: sessionId,
      authorType: "member",
      authorId: user.id,
      ...(parentId ? { parentId } : null),
      body: parts.join("\n\n"),
    });
    if (!parentId) latestRootId[sessionSlot] = comment.id;
    commentIds.push(comment.id);
  }

  const deepLinkCommentId = commentIds[FIXTURE.deepLinkCommentIndex - 1]!;
  const deepLinkComment = store.getIssueComment(deepLinkCommentId);
  const deepLinkCommentSessionId = deepLinkComment?.issueSessionId
    ?? store.getLatestActiveIssueSession(longIssue.id)?.id
    ?? defaultSession.id;

  // A separate ≥200-row session exercises the HTML preview without changing
  // the long issue used by D0's before/after profile.
  const xlongIssue = store.createIssue({ id: "iss_zerojump_xlong", title: "Zero-jump extra long HTML issue", description: "200 comments in one session", status: "in_progress" });
  const xlongSession = store.getOrCreateDefaultIssueSession(xlongIssue.id, user.id);
  const htmlAttachment = store.createAttachment({ id: "att_zerojump_html", workspaceId: workspace.id, issueId: xlongIssue.id,
    uploaderType: "member", uploaderId: user.id, filename: "zero-jump.html", url: "/api/attachments/att_zerojump_html/content",
    contentType: "text/html", sizeBytes: 45000 });
  for (let index = 0; index < 200; index++) store.createIssueComment(xlongIssue.id, {
    issueSessionId: xlongSession.id, authorType: "member", authorId: user.id, body: filler("extra long", index, 6),
    ...(index === 199 ? { attachmentIds: [htmlAttachment.id] } : {}),
  });

  // ── running task: the agent stream row's reason to exist ──────────────────
  const runningIssue = store.createIssue({
    id: "iss_zerojump_running",
    title: "Zero-jump running issue",
    description: "Carries a running task with messages.",
    status: "in_progress",
    priority: "medium",
  });
  const runningSession = store.getOrCreateDefaultIssueSession(runningIssue.id, user.id);
  store.createIssueComment(runningIssue.id, {
    issueSessionId: runningSession.id,
    authorType: "member",
    authorId: user.id,
    body: "trigger comment for the running agent",
  });
  const agent = store.createAgent({
    id: "agt_zerojump",
    name: "Zero-jump fixture agent",
    provider: "codex",
    workspaceId: workspace.id,
    ownerId: user.id,
    visibility: "workspace",
  });
  const runningTask = store.createTask({
    id: "tsk_zerojump_running",
    agentId: agent.id,
    issueId: runningIssue.id,
    issueSessionId: runningSession.id,
    prompt: "zero-jump fixture task",
  });

  // Task status only moves through the dispatch flow, which a fixture does not
  // run; write the state the daemon would have written so the issue renders its
  // SessionAgentStreamRow (the detail scenario's terminal element).
  markTaskRunning(store, runningTask.id);

  const runningMessages = 6;
  store.appendTaskMessages(runningTask.id, Array.from({ length: runningMessages }, (_, index) => ({
    type: index === 0 ? "text" : "tool_use",
    tool: index === 0 ? null : "Read",
    content: `zero-jump fixture message ${index + 1}`,
    status: "completed",
  })));

  const inboxItemId = deepLinkCommentId;

  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug ?? "local",
    memberId: member.id,
    userId: user.id,
    shortIssueId: shortIssue.id,
    f398IssueId: f398Issue.id,
    parentIssueId: parentIssue.id,
    waitingChildIssueId: waitingChild.id,
    ungrantedParentIssueId: ungrantedParent.id,
    ineffectiveParentIssueId: ineffectiveParent.id,
    disabledParentIssueId: disabledParent.id,
    decisionActivityIssueId: decisionActivityIssue.id,
    parentOwnerAgentId: parentOwner.id,
    replacementAgentId: replacementAgent.id,
    xlongIssueId: xlongIssue.id,
    htmlAttachmentId: htmlAttachment.id,
    longIssueId: longIssue.id,
    longDefaultSessionId: defaultSession.id,
    longSessionIds,
    deepLinkCommentId,
    deepLinkCommentSessionId,
    runningIssueId: runningIssue.id,
    runningTaskId: runningTask.id,
    inboxItemId,
    counts: {
      longComments: commentIds.length,
      longCodeBlocks: FIXTURE.codeBlocks,
      longImages: imageAttachmentIds.length,
      sessions: longSessionIds.length,
      runningMessages,
      f398Comments: FIXTURE.f398Comments,
      f398QueuedTasks: FIXTURE.f398QueuedTasks,
      f398Updates: FIXTURE.f398Updates,
    },
  };
}
