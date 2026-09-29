// MUL-473: deterministic fixture for the first-screen hotspot routes.
//
// The four routes the issue covers (`GET /api/chat/pending-tasks`,
// `GET /api/issues` for my-issues, `GET /api/inbox/summary`,
// `GET /api/attachments/:id/content`) were slow because they walked one row at
// a time, not because of a slow statement. The unit assertions and the manual
// harness have to measure the same dataset, so the seed lives here once and both
// call it.
//
// Scale follows the issue's acceptance bar: at least 50 Chats, at least 20
// Agents and at least 300 inbox rows, so a per-row loop is visibly different
// from a batched read. Every id is explicit and every ordering-relevant
// timestamp is pinned through `run`, so two runs over the same fixture version
// produce byte-comparable responses.
import { performance } from "node:perf_hooks";
import type { MultiremiStore } from "@multiremi/store.js";

export interface FirstScreenHotspotsFixtureOptions {
  /** Chats owned by the reader. The issue's bar is 50. */
  sessions?: number;
  /** Additional workspace Agents, each carrying a Skill with a body. */
  agents?: number;
  /** Unarchived inbox rows addressed to the reader. The issue's bar is 300. */
  inboxRows?: number;
  /** Issues in the workspace. */
  issues?: number;
  /**
   * Make Agent 0 private and owned by the workspace owner (default). The
   * response golden locks the rule that a plain member never sees that Agent's
   * Sessions in `pending-tasks`; a caller that only counts statements sets this
   * to false so every Chat it seeds yields a task.
   */
  privatePrimaryAgent?: boolean;
  /** Bytes of the `reference.md` body every fixture Skill carries. */
  skillBodyBytes?: number;
  /** Bytes of filler in each task's `prompt`. */
  taskPromptBytes?: number;
  /** Raw SQL executor, used to pin timestamps and ordering columns. */
  run?: (sql: string, params: unknown[]) => void;
}

export interface FirstScreenHotspotsFixture {
  workspaceId: string;
  readerUserId: string;
  readerMemberId: string;
  ownerUserId: string;
  runtimeId: string;
  agentIds: string[];
  /** The Agent that owns most of the reader's Chats. */
  primaryAgentId: string;
  sessionIds: string[];
  /**
   * Sessions whose pending-task winner is decided by a non-FIFO rule. Null when
   * the fixture was seeded with fewer than three Sessions.
   */
  ranking: {
    /** Session with a running task created after its queued siblings. */
    runningBeatsQueuedSessionId: string | null;
    runningBeatsQueuedWinnerTaskId: string | null;
    /** Session where the second queued task was prioritized. */
    prioritizedSessionId: string | null;
    prioritizedWinnerTaskId: string | null;
  };
  issueIds: string[];
  taskIds: string[];
  counts: {
    sessions: number;
    agents: number;
    inboxRows: number;
    inboxAttention: number;
    inboxUnread: number;
    issues: number;
    tasks: number;
    skillBodyBytes: number;
  };
  seedMs: number;
}

const WORKSPACE_ID = "local";
const NOW = Date.UTC(2026, 8, 26, 9, 0, 0);
const READER_EXTERNAL_ID = "hotspot-reader";

function stamp(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

/** Stable filler so fixture body sizes do not drift between runs. */
export function hotspotFiller(prefix: string, index: number, bytes: number): string {
  const head = `${prefix} #${index} `;
  const chunk = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  return head + chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, Math.max(0, bytes - head.length));
}

/**
 * Seed the reader, their Chats, the workspace Agents and the inbox. The caller
 * owns the store and the database lifetime; this function only writes rows.
 */
export function seedFirstScreenHotspotsFixture(
  store: MultiremiStore,
  options: FirstScreenHotspotsFixtureOptions = {},
): FirstScreenHotspotsFixture {
  const startedAt = performance.now();
  const sessionCount = options.sessions ?? 50;
  const agentCount = options.agents ?? 20;
  const inboxRowCount = options.inboxRows ?? 300;
  const issueCount = options.issues ?? 60;
  const skillBodyBytes = options.skillBodyBytes ?? 4096;
  const taskPromptBytes = options.taskPromptBytes ?? 1024;
  const run = options.run ?? (() => {});
  const privatePrimaryAgent = options.privatePrimaryAgent ?? true;

  store.ensureLocalWorkspace();
  const owner = store.getCurrentUser();
  if (!store.getWorkspaceMember(`mem_${WORKSPACE_ID}_${owner.id}`)) {
    store.createWorkspaceMember({
      id: `mem_${WORKSPACE_ID}_${owner.id}`,
      workspaceId: WORKSPACE_ID,
      userId: owner.id,
      name: owner.name ?? "Owner",
      role: "owner",
    });
  }
  // The user id is pinned through `external_id` so the member row's `user_id`
  // (and therefore a `usr_`-shaped assignee filter) is deterministic.
  const reader = store.getOrCreateUser({
    externalId: READER_EXTERNAL_ID,
    name: "Hotspot reader",
    email: "hotspot-reader@example.test",
  });
  const readerUserId = reader.id;
  store.createWorkspaceMember({
    id: `mem_${WORKSPACE_ID}_${readerUserId}`,
    workspaceId: WORKSPACE_ID,
    userId: readerUserId,
    name: "Hotspot reader",
    role: "member",
  });

  const runtime = store.registerRuntime({
    id: "rt_hotspot",
    name: "Hotspot runtime",
    provider: "codex",
    workspaceId: WORKSPACE_ID,
    maxConcurrency: 8,
  });

  const skillBody = hotspotFiller("skill reference", 0, skillBodyBytes);
  const agentIds: string[] = [];
  for (let index = 0; index < agentCount; index += 1) {
    const agent = store.createAgent({
      id: `agt_hotspot_${index}`,
      name: `Hotspot agent ${index}`,
      provider: "codex",
      workspaceId: WORKSPACE_ID,
      runtimeId: runtime.id,
      // Agent 0 is private and owned by the workspace owner, so only an
      // owner/admin caller may see its Sessions' pending tasks.
      ownerId: owner.id,
      visibility: index === 0 && privatePrimaryAgent ? "private" : "workspace",
    });
    agentIds.push(agent.id);
    const skill = store.createSkill({
      id: `skl_hotspot_${index}`,

      workspaceId: WORKSPACE_ID,
      name: `hotspot-skill-${index}`,
      description: "Fixture Skill",
      files: [{ path: "reference.md", content: skillBody }],
    });
    store.setAgentSkills(agent.id, [skill.id!]);
  }
  const primaryAgentId = agentIds[0]!;

  const readerMemberId = `mem_${WORKSPACE_ID}_${readerUserId}`;
  const sessionIds: string[] = [];
  const taskIds: string[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const session = store.createChatSession({
      id: `chat_hotspot_${index}`,
      agentId: agentIds[index % agentIds.length]!,
      creatorId: readerUserId,
      title: `Hotspot chat ${index}`,
    });
    sessionIds.push(session.id);
    const sent = store.sendChatMessage(session.id, { body: hotspotFiller("turn", index, 64) });
    taskIds.push(sent.task.id);
  }

  // Ranking case 1: a task already in flight wins even when three queued turns
  // were created after it, because `pendingTasks()` orders `queued` last. The
  // status is written directly: driving a real claim would make the fixture
  // depend on the claimant's own queue ordering, which this case is not about.
  //
  // The ranking cases need three Sessions; a caller that seeds fewer (the
  // query-count scans) gets a plain fixture instead of a broken one.
  const rankingSessionId = sessionIds[1] ?? sessionIds[0]!;
  const prioritizedSessionId = sessionIds[2] ?? rankingSessionId;
  let runningWinnerTaskId: string | null = null;
  let prioritizedWinnerTaskId: string | null = null;
  if (sessionIds.length >= 3) {
    const runningTask = store.sendChatMessage(rankingSessionId, { body: "running turn" }).task;
    for (let index = 0; index < 3; index += 1) {
      taskIds.push(store.sendChatMessage(rankingSessionId, { body: `queued after running ${index}` }).task.id);
    }
    run("UPDATE multiremi_tasks SET status = 'running', started_at = ?, attempt = 1 WHERE id = ?", [
      stamp(taskIds.length * 1000),
      runningTask.id,
    ]);
    taskIds.push(runningTask.id);
    runningWinnerTaskId = runningTask.id;

    // Ranking case 2: the second queued turn was prioritized, so it wins over the
    // earlier one on `priority` — not on creation order.
    const prioritizedWinner = store.sendChatMessage(prioritizedSessionId, { body: "prioritized turn" }).task;
    const loser = store.sendChatMessage(prioritizedSessionId, { body: "ordinary turn" }).task;
    store.prioritizeQueuedChatTask(prioritizedSessionId, prioritizedWinner.id);
    taskIds.push(prioritizedWinner.id, loser.id);
    prioritizedWinnerTaskId = prioritizedWinner.id;
  }

  // A pending turn on a Session the reader does not own must never appear.
  const foreignSession = store.createChatSession({
    id: "chat_hotspot_foreign",
    agentId: primaryAgentId,
    creatorId: owner.id,
    title: "Someone else's chat",
  });
  taskIds.push(store.sendChatMessage(foreignSession.id, { body: "not mine" }).task.id);

  const issueIds: string[] = [];
  for (let index = 0; index < issueCount; index += 1) {
    const assignedToMember = index % 4 === 0;
    const issue = store.createIssue({
      id: `iss_hotspot_${index}`,
      workspaceId: WORKSPACE_ID,
      title: `Hotspot issue ${index}`,
      assigneeType: assignedToMember ? "member" : "agent",
      assigneeId: assignedToMember ? readerMemberId : agentIds[index % agentIds.length]!,
      createdBy: readerUserId,
    });
    issueIds.push(issue.id);
  }

  // 300 unarchived rows with a mixed shape: plain rows, ledger rows (which never
  // merge by issue), read rows, and attention rows. The summary asserts on this
  // exact mix, so it has to be pinned rather than random.
  let attention = 0;
  let unread = 0;
  for (let index = 0; index < inboxRowCount; index += 1) {
    const kind = index % 5;
    const severity: "info" | "attention" = kind === 1 || kind === 3 ? "attention" : "info";
    const read = kind === 2 || kind === 4;
    const type = kind === 0
      ? "autopilot_run_completed"
      : kind === 1
        ? "autopilot_paused"
        : kind === 3
          ? "issue_assigned"
          : "issue_comment";
    const details = type === "autopilot_run_completed"
      ? { autopilot_id: `atp_hotspot_${index % 3}`, run_status: "completed" }
      : { note: `row ${index}` };
    run(
      `INSERT INTO multiremi_inbox_items (
         id, workspace_id, issue_id, member_id, recipient_type, recipient_id,
         severity, actor_type, actor_id, type, title, body, details, read, archived, created_at
       ) VALUES (?, ?, ?, ?, 'member', ?, ?, 'system', NULL, ?, ?, ?, ?, ?, 0, ?)`,
      [
        `inb_hotspot_${index}`,
        WORKSPACE_ID,
        issueIds[index % issueIds.length]!,
        readerMemberId,
        readerMemberId,
        severity,
        type,
        `Hotspot inbox ${index}`,
        "body",
        JSON.stringify(details),
        read ? 1 : 0,
        stamp(index * 1000),
      ],
    );
    if (!read && severity === "attention") attention += 1;
    if (!read) unread += 1;
  }

  // Pin Chat ordering so `ORDER BY updated_at DESC` cannot depend on how fast the
  // seed ran, and pin the task/queue columns the ranking reads.
  for (let index = 0; index < sessionIds.length; index += 1) {
    run("UPDATE multiremi_chat_sessions SET updated_at = ?, created_at = ? WHERE id = ?", [
      stamp(index * 60_000),
      stamp(index * 60_000),
      sessionIds[index]!,
    ]);
  }
  run("UPDATE multiremi_chat_sessions SET updated_at = ? WHERE id = ?", [stamp(10_000_000), sessionIds[0]!]);
  for (let index = 0; index < taskIds.length; index += 1) {
    run("UPDATE multiremi_tasks SET created_at = ?, chat_queue_order = ? WHERE id = ?", [
      stamp(index * 1000),
      index,
      taskIds[index]!,
    ]);
    run("UPDATE multiremi_tasks SET prompt = ? WHERE id = ?", [
      hotspotFiller("prompt", index, taskPromptBytes),
      taskIds[index]!,
    ]);
  }
  run("UPDATE multiremi_chat_sessions SET pinned = 1 WHERE id = ?", [sessionIds[3]!]);

  // `taskIds` is the fixture's creation-order index, used for the golden's
  // stable `<task:N>` placeholders. The two ranking cases re-append their
  // winner, so dedupe while keeping first-seen order.
  const uniqueTaskIds = [...new Set(taskIds)];

  return {
    workspaceId: WORKSPACE_ID,
    readerUserId,
    readerMemberId,
    ownerUserId: owner.id,
    runtimeId: runtime.id,
    agentIds,
    primaryAgentId,
    sessionIds,
    ranking: {
      runningBeatsQueuedSessionId: runningWinnerTaskId ? rankingSessionId : null,
      runningBeatsQueuedWinnerTaskId: runningWinnerTaskId,
      prioritizedSessionId: prioritizedWinnerTaskId ? prioritizedSessionId : null,
      prioritizedWinnerTaskId,
    },
    issueIds,
    taskIds: uniqueTaskIds,
    counts: {
      sessions: sessionCount,
      agents: agentCount,
      inboxRows: inboxRowCount,
      inboxAttention: attention,
      inboxUnread: unread,
      issues: issueCount,
      tasks: uniqueTaskIds.length,
      skillBodyBytes,
    },
    seedMs: Number((performance.now() - startedAt).toFixed(3)),
  };
}
