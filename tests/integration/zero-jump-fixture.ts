#!/usr/bin/env bun
/**
 * Deterministic fixture for the MUL-394 zero-jump check.
 *
 * The plan (§5) fixes the shapes the check must exercise, so this file owns them
 * in one place and the check itself stays about measurement and verdicts:
 *
 *  - a short issue with 3 comments;
 *  - a long issue with 250 comments carrying ~20 code blocks, 5 images, replies
 *    and activity, spread over 3 sessions (one of them the default);
 *  - one running task with messages, so the agent stream row renders;
 *  - one inbox row whose `details.comment_id` points at the long issue's 40th
 *    comment, which is what the deep-link round follows.
 *
 * Everything is written through the store API except where the store has no
 * path for the state a daemon would have produced (a running task, an inbox
 * row). Those two are noted at their call sites.
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
} as const;

export interface ZeroJumpFixture {
  workspaceId: string;
  workspaceSlug: string;
  memberId: string;
  userId: string;
  shortIssueId: string;
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
    "UPDATE multiremi_tasks SET status = 'running', dispatched_at = ?, started_at = ?, updated_at = ? WHERE id = ?",
    [startedAt, startedAt, startedAt, taskId],
  );
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
    const comment = store.createIssueComment(longIssue.id, {
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

  // `comment_mention` is the notification type that actually carries a comment
  // deep link: it routes to `inbox_action`, so the inbox resolves the row to
  // `?issue=`. A `comment_created` row would route through the issue status and,
  // on an in-progress issue, become workbench-only — no row and no deep link.
  //
  // Written as SQL because `createInboxItem` lives on the store context that the
  // mention/subscription flows use, not on the facade a fixture holds; the column
  // list is the same one `IssuesRepo.triggerCommentMentions` fills.
  const inboxItemId = "inb_zerojump_deeplink";
  const inboxDb = (store as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db;
  inboxDb.run(
    `INSERT INTO multiremi_inbox_items (
      id, workspace_id, issue_id, member_id, recipient_type, recipient_id, severity,
      actor_type, actor_id, type, title, body, details, read, archived, created_at
    ) VALUES (?, ?, ?, ?, 'member', ?, 'info', 'member', ?, 'comment_mention', ?, ?, ?, 0, 0, ?)`,
    [
      inboxItemId,
      workspace.id,
      longIssue.id,
      member.id,
      member.id,
      user.id,
      `${longIssue.key}: mentioned you`,
      "points at the 40th comment of the long issue",
      JSON.stringify({ comment_id: deepLinkCommentId, issue_session_id: deepLinkCommentSessionId }),
      new Date().toISOString(),
    ],
  );

  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug ?? "local",
    memberId: member.id,
    userId: user.id,
    shortIssueId: shortIssue.id,
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
    },
  };
}
