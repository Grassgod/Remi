// Session log window fixture: the Chat and Issue session windows read by
// `GET /api/sessions/:sessionId/log`.
//
// Chat switches fire `?before=30` (10 completed turns: request, turn card,
// reply) and the `?anchor=0&before=1` head read. Issue sessions read the same
// route with comments, reactions, attachments and `with_activity=1`. The golden
// capture and the query-count regression must see the same rows, so the seed
// lives here once.
//
// Every row comes from the production store writers. The capture installs the
// deterministic id/clock pin from `issue-detail-first-screen-fixture.ts` after
// the store migrated, so two captures over the same writers are byte-comparable.
import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export const SESSION_LOG_WINDOW_CHAT_TURNS = 40;

export interface SessionLogWindowFixture {
  chatId: string;
  /** A second member's Chat with the same Agent; the first member must not read it. */
  otherChatId: string;
  issueId: string;
  issueSessionId: string;
  /** Running Chat attempt whose task credential reads `chatId`. */
  runningTaskId: string;
  runningTurnId: string;
  /** Attempt id that replaced a failed first attempt (turn id != attempt id). */
  retriedTaskId: string;
  tokens: {
    /** Chat creator and Issue owner (workspace owner). */
    owner: string;
    /** Plain workspace member: cannot see the private Agent's Issue turns. */
    member: string;
    /** Task credential of `runningTaskId`. */
    task: string;
  };
}

function completeTurn(store: MultiremiStore, runtimeId: string, taskId: string, output: string,
  usage?: { inputTokens: number; outputTokens: number }): void {
  const claimed = store.claimTask(runtimeId);
  if (claimed?.id !== taskId) throw new Error(`fixture claimed ${claimed?.id ?? "nothing"} instead of ${taskId}`);
  store.startTask(taskId);
  if (usage) {
    store.reportTaskUsage(taskId, [{ provider: "codex", model: "gpt-fixture", inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: usage.inputTokens + usage.outputTokens }]);
  }
  store.completeTask(taskId, { output });
}

export async function seedSessionLogWindowFixture(store: MultiremiStore): Promise<SessionLogWindowFixture> {
  const workspace = store.ensureLocalWorkspace();
  const owner = store.getCurrentUser();
  const memberUser = store.getOrCreateUser({ email: "log-window-member@example.test", name: "Log window member" });
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: memberUser.id, name: memberUser.name, role: "member" });
  const runtime = store.registerRuntime({ name: "log-window-codex", provider: "codex", ownerId: owner.id,
    daemonId: "log-window", maxConcurrency: 1 });
  const agent = store.createAgent({ name: "Log window agent", provider: "codex", workspaceId: workspace.id,
    runtimeId: runtime.id, visibility: "workspace" });
  const privateAgent = store.createAgent({ name: "Log window private agent", provider: "codex", workspaceId: workspace.id,
    runtimeId: runtime.id, visibility: "private", ownerId: owner.id });

  // ── Chat: 40 finished turns, one retried, some with usage and attachments ──
  const chat = store.createChatSession({ agentId: agent.id, workspaceId: workspace.id, creatorId: owner.id, title: "Log window chat" });
  let retriedTaskId = "";
  for (let turn = 1; turn <= SESSION_LOG_WINDOW_CHAT_TURNS; turn++) {
    const attachment = turn % 9 === 0
      ? store.createAttachment({ workspaceId: workspace.id, chatSessionId: chat.id, uploaderType: "member", uploaderId: owner.id,
        filename: `chat-${turn}.txt`, url: `https://files.example.test/chat-${turn}.txt`, contentType: "text/plain", sizeBytes: turn })
      : null;
    const sent = store.sendChatMessage(chat.id, { body: `Question ${turn}`, ...(attachment ? { attachmentIds: [attachment.id] } : {}) });
    if (turn === 36) {
      const claimed = store.claimTask(runtime.id);
      if (claimed?.id !== sent.task.id) throw new Error("fixture failed to claim the retried turn");
      store.startTask(sent.task.id);
      store.failTask(sent.task.id, { error: "fixture transient failure" });
      const retried = store.retryTurn(store.getTurnForAttempt(sent.task.id)!.id);
      if (!retried.current_attempt_id || retried.current_attempt_id === sent.task.id) throw new Error("fixture turn was not retried");
      retriedTaskId = retried.current_attempt_id;
      completeTurn(store, runtime.id, retriedTaskId, `Answer ${turn} after retry`);
      continue;
    }
    completeTurn(store, runtime.id, sent.task.id, `Answer ${turn}`,
      turn % 4 === 0 ? { inputTokens: 100 * turn, outputTokens: 10 * turn } : undefined);
  }

  const otherChat = store.createChatSession({ agentId: agent.id, workspaceId: workspace.id, creatorId: memberUser.id, title: "Someone else's chat" });

  // ── Issue: comments with reactions/attachments, public and private Agent turns, activity ──
  const issue = store.createIssue({ title: "Log window issue", description: "Session log window fixture" });
  const session = store.getOrCreateDefaultIssueSession(issue.id, owner.id);
  const ownerMember = store.listWorkspaceMembers(workspace.id).find(member => member.userId === owner.id)!;
  for (let round = 1; round <= 12; round++) {
    const comment = store.createIssueComment(issue.id, { body: `Round ${round} note`, authorType: "member", authorId: ownerMember.id });
    if (round % 3 === 0) store.addCommentReaction(comment.id, { actorType: "member", actorId: ownerMember.id, emoji: "+1" });
    if (round % 4 === 0) {
      store.createAttachment({ workspaceId: workspace.id, issueId: issue.id, commentId: comment.id, uploaderType: "member",
        uploaderId: ownerMember.id, filename: `issue-${round}.txt`, url: `https://files.example.test/issue-${round}.txt`,
        contentType: "text/plain", sizeBytes: round });
    }
    const target = round % 3 === 1 ? privateAgent : agent;
    const sent = store.sendMessage({
      session_id: session.id, sender: { type: "member", id: ownerMember.id },
      to: { type: "agent", ref: target.id }, message_kind: "request", wake_requested: "now",
      execution_scope: `log_window_${round}`, body_md: `Round ${round} request`,
    });
    const attempt = store.getTurn(sent.turn_id!)!.current_attempt_id!;
    completeTurn(store, runtime.id, attempt, `Round ${round} reply`,
      round % 5 === 0 ? { inputTokens: 7 * round, outputTokens: round } : undefined);
    if (round === 6) store.updateIssue(issue.id, { status: "in_progress", actorType: "member", actorId: ownerMember.id });
  }

  // The last Chat request is still running (it holds the runtime's only slot,
  // so it is seeded last); its card stays hidden until it finishes.
  const running = store.sendChatMessage(chat.id, { body: "Still running" });
  const claimedRunning = store.claimTask(runtime.id);
  if (claimedRunning?.id !== running.task.id) throw new Error("fixture failed to claim the running turn");
  store.startTask(running.task.id);
  const runningTask = store.getTask(running.task.id)!;
  const taskCredential = await store.createTaskAccessToken(runningTask, owner.id);
  const runningTurnId = store.getTurnForAttempt(running.task.id)!.id;

  const ownerToken = await store.createAccessToken({ type: "pat", name: "Log window owner", userId: owner.id, workspaceId: workspace.id });
  const memberToken = await store.createAccessToken({ type: "pat", name: "Log window member", userId: memberUser.id, workspaceId: workspace.id });
  return {
    chatId: chat.id,
    otherChatId: otherChat.id,
    issueId: issue.id,
    issueSessionId: session.id,
    runningTaskId: running.task.id,
    runningTurnId,
    retriedTaskId,
    tokens: { owner: ownerToken.token, member: memberToken.token, task: taskCredential.token },
  };
}

/**
 * Show the running turn's card while its credential stays live. Production
 * revokes the credential in the same transaction that finishes the attempt, so
 * only a direct turn-status write lets one request observe both: the task
 * credential must see its own card and still not see any other turn's card.
 */
export function revealRunningTurnCard(db: SqlDatabase, fixture: SessionLogWindowFixture): void {
  db.run("UPDATE multiremi_turns SET status = 'completed' WHERE id = ?", [fixture.runningTurnId]);
}

export interface SessionLogWindowProbe {
  name: string;
  path: string;
  auth: keyof SessionLogWindowFixture["tokens"];
}

/**
 * The reads a Chat switch and an Issue session open issue, plus the paging and
 * authorization variants. Large windows appear once; variants use small pages.
 */
export function sessionLogWindowProbes(fixture: SessionLogWindowFixture): SessionLogWindowProbe[] {
  const chat = `/api/sessions/${fixture.chatId}/log`;
  const issue = `/api/sessions/${fixture.issueSessionId}/log`;
  return [
    // Chat switch: the 30-row window and the head read.
    { name: "chat-window", path: `${chat}?before=30`, auth: "owner" },
    { name: "chat-head", path: `${chat}?anchor=0&before=1`, auth: "owner" },
    { name: "chat-around-anchor", path: `${chat}?anchor=30&before=4&after=4`, auth: "owner" },
    // The agent's range read shares the batched materialization.
    { name: "chat-message-range", path: `/api/sessions/${fixture.chatId}/messages?from=90&to=110`, auth: "owner" },
    // A task credential reads its own Chat but no other turn's card.
    { name: "chat-task-credential", path: `${chat}?before=9`, auth: "task" },
    { name: "chat-other-member", path: `/api/sessions/${fixture.otherChatId}/log?before=30`, auth: "owner" },
    { name: "chat-not-creator", path: `${chat}?before=30`, auth: "member" },
    // Issue session: what the Issue page opens, a plain page, and a member who
    // cannot see the private Agent's turns.
    { name: "issue-window", path: `${issue}?before=30&with_activity=1`, auth: "owner" },
    { name: "issue-window-plain", path: `${issue}?before=8`, auth: "owner" },
    { name: "issue-window-member", path: `${issue}?before=12&with_activity=1`, auth: "member" },
  ];
}

/** Probes read after {@link revealRunningTurnCard}. */
export function sessionLogWindowRevealedProbes(fixture: SessionLogWindowFixture): SessionLogWindowProbe[] {
  const chat = `/api/sessions/${fixture.chatId}/log`;
  return [
    { name: "chat-task-credential-own-card", path: `${chat}?before=6`, auth: "task" },
    { name: "chat-window-own-card", path: `${chat}?before=6`, auth: "owner" },
  ];
}

export interface SessionLogWindowResponse {
  name: string;
  path: string;
  status: number;
  /** The exact response body. */
  body: string;
}

/** Every probe in order: the base set, then the revealed set after the status write. */
export async function readSessionLogWindowResponses(
  request: (path: string, init: RequestInit) => Response | Promise<Response>,
  db: SqlDatabase,
  fixture: SessionLogWindowFixture,
): Promise<SessionLogWindowResponse[]> {
  const responses: SessionLogWindowResponse[] = [];
  const read = async (probes: SessionLogWindowProbe[]) => {
    for (const probe of probes) {
      const response = await request(probe.path, { headers: { Authorization: `Bearer ${fixture.tokens[probe.auth]}` } });
      responses.push({ name: probe.name, path: probe.path, status: response.status, body: await response.text() });
    }
  };
  await read(sessionLogWindowProbes(fixture));
  revealRunningTurnCard(db, fixture);
  await read(sessionLogWindowRevealedProbes(fixture));
  return responses;
}
