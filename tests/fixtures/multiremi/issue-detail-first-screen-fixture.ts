// MUL-385: deterministic fixture for the Issue detail first-screen routes.
//
// `GET /api/issues/:id`, `/sessions` and `/timeline?issue_session_id=@default&limit=40`
// are the three requests the detail page fires on open. The perf harness and the
// unit assertions must measure the same dataset, so the seed lives here once and
// both call it.
//
// Scale follows MUL-307: one long Issue with 173 comments (105 roots + 68 replies),
// 6~9 sessions with 2-4 participants each, 50+ tasks carrying production-sized
// prompt/result bodies, plus reactions, attachments, labels, children and
// dependencies. Every id is explicit so two runs over the same fixture version are
// byte-comparable.
import { performance } from "node:perf_hooks";
import type { MultiremiStore } from "@multiremi/store.js";

export interface IssueDetailFixtureOptions {
  /** Root comments on the long Issue. Replies are added on top. */
  rootComments?: number;
  /** Replies spread across the root comments. */
  replies?: number;
  /** Issue sessions in addition to the default one (default: 5 → 6 total). */
  sideSessions?: number;
  /** Tasks attached to the long Issue. */
  tasks?: number;
  /** Bytes of filler in each task `prompt` / `result` body. */
  taskPromptBytes?: number;
  taskResultBytes?: number;
  /** Root comments that get a reaction, an attachment and an extra agent reply. */
  decoratedComments?: number;
  commentsPerSession?: number;
  /**
   * Raw SQL executor for the caller's database. Used only to pin the
   * participants' `joined_at` to distinct timestamps: `addSessionParticipant`
   * stamps wall-clock milliseconds, and ties would make the per-session and
   * batched `ORDER BY joined_at ASC` shapes non-comparable.
   */
  run?: (sql: string, params: unknown[]) => void;
}

export interface IssueDetailFixture {
  workspaceId: string;
  issueId: string;
  issueKey: string;
  /** Session that `issue_session_id=@default` resolves to. */
  defaultSessionId: string;
  /** Every session of the long Issue, default first. */
  sessionIds: string[];
  /** Sessions with their participant counts, as seeded. */
  participantCountBySession: Record<string, number>;
  taskIds: string[];
  childIssueIds: string[];
  dependencyIssueIds: string[];
  counts: {
    rootComments: number;
    replies: number;
    comments: number;
    sessions: number;
    participants: number;
    tasks: number;
    reactions: number;
    commentReactions: number;
    attachments: number;
    labels: number;
    children: number;
    dependencies: number;
    activity: number;
  };
  /** Simulated Postgres-bridge payload for the seed itself, for reference only. */
  seedMs: number;
}

const WORKSPACE_ID = "local";
const FIXTURE_EPOCH_MS = Date.UTC(2026, 8, 20, 12, 0, 0);
const NOW = FIXTURE_EPOCH_MS;

/**
 * Re-anchors the pinned clock, when one is installed.
 *
 * `installDeterministicIds` ticks once per clock read, so anything that reads
 * the clock between installing the pin and seeding — store construction, schema
 * migrations — would otherwise shift every fixture timestamp and invalidate the
 * golden. Seeding therefore resets the clock to a fixed epoch first.
 */
let activeClockReset: (() => void) | null = null;

/** Stable filler so the fixture body sizes do not drift between runs. */
function filler(prefix: string, index: number, bytes: number): string {
  const head = `${prefix} #${index} `;
  const chunk = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  return head + chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, Math.max(0, bytes - head.length));
}

function stamp(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

/**
 * Seed the long Issue and its neighbourhood. Caller owns the `store` and the
 * database lifetime; the function only writes rows.
 */
export function seedIssueDetailFirstScreenFixture(
  store: MultiremiStore,
  options: IssueDetailFixtureOptions = {},
): IssueDetailFixture {
  activeClockReset?.();
  const startedAt = performance.now();
  const rootComments = options.rootComments ?? 105;
  const replies = options.replies ?? 68;
  const sideSessions = options.sideSessions ?? 5;
  const taskCount = options.tasks ?? 54;
  const taskPromptBytes = options.taskPromptBytes ?? 1200;
  const taskResultBytes = options.taskResultBytes ?? 2400;
  const decoratedComments = options.decoratedComments ?? 24;
  const commentsPerSession = options.commentsPerSession ?? 24;

  store.ensureLocalWorkspace();
  const owner = store.getCurrentUser();
  if (!store.getWorkspaceMember("mem_local_local")) {
    store.createWorkspaceMember({
      id: "mem_local_local",
      workspaceId: WORKSPACE_ID,
      userId: owner.id,
      name: owner.name ?? "Owner",
      role: "owner",
    });
  }
  const agent = store.createAgent({
    id: "agt_mul385",
    name: "MUL-385 fixture agent",
    provider: "codex",
    workspaceId: WORKSPACE_ID,
    ownerId: owner.id,
    visibility: "workspace",
  });
  // Distinct participants per session: `addSessionParticipant` upserts on
  // (session, participant type, participant id), so reusing one agent would
  // collapse the lane instead of producing a 2-4 participant session.
  const contributorAgents = [1, 2, 3, 4].map((slot) => store.createAgent({
    id: `agt_mul385_p${slot}`,
    name: `MUL-385 participant agent ${slot}`,
    provider: "codex",
    workspaceId: WORKSPACE_ID,
    ownerId: owner.id,
    visibility: "workspace",
  }));

  const issue = store.createIssue({
    id: "iss_mul385_long",
    workspaceId: WORKSPACE_ID,
    title: "MUL-385 long issue fixture",
    description: filler("issue description", 0, 900),
    status: "in_progress",
    priority: "high",
    assigneeType: "agent",
    assigneeId: agent.id,
    createdBy: owner.id,
  });
  const defaultSession = store.getOrCreateDefaultIssueSession(issue.id, owner.id);

  // ── sessions + participants ────────────────────────────────────────────────
  const sessionIds = [defaultSession.id];
  const participantCountBySession: Record<string, number> = {};
  let participantTotal = 0;
  // Replaced below with the store's real counts; kept for the intermediate sum.
  // `addSessionParticipant` stamps `joined_at` from the wall clock at
  // millisecond resolution, so two inserts in the same tick are ties and the
  // `ORDER BY joined_at ASC` contract becomes plan-dependent. Pin the column at
  // insert time, in the order the participants are meant to appear.
  const pinJoinedAt = (sessionId: string, type: string, id: string, tick: number): void => {
    if (!options.run) return;
    options.run(
      "UPDATE multiremi_session_participants SET joined_at = ? WHERE session_id = ? AND participant_type = ? AND participant_id = ?",
      [stamp(tick * 1_000), sessionId, type, id],
    );
  };
  let participantTick = 0;
  const seedParticipants = (sessionId: string, count: number): void => {
    store.addSessionParticipant(sessionId, {
      participantType: "member",
      participantId: "mem_local_local",
      role: "owner",
    });
    // `addSessionParticipant` normalizes a member reference to its user id.
    pinJoinedAt(sessionId, "member", owner.id, participantTick++);
    for (let slot = 0; slot < count - 1; slot += 1) {
      store.addSessionParticipant(sessionId, {
        participantType: "agent",
        participantId: contributorAgents[slot]!.id,
        role: slot === 0 ? "leader" : "participant",
      });
      pinJoinedAt(sessionId, "agent", contributorAgents[slot]!.id, participantTick++);
    }
    participantCountBySession[sessionId] = count;
    participantTotal += count;
  };

  seedParticipants(defaultSession.id, 2);
  for (let index = 0; index < sideSessions; index += 1) {
    const session = store.createIssueSession(issue.id, {
      id: `ises_mul385_${String(index).padStart(2, "0")}`,
      title: `MUL-385 side session ${index + 1}`,
      createdByType: "member",
      createdById: owner.id,
    });
    sessionIds.push(session.id);
    seedParticipants(session.id, 2 + (index % 3)); // 2, 3, 4, 2, 3 …
  }

  // ── comments ───────────────────────────────────────────────────────────────
  const rootIds: string[] = [];
  const commentIds: string[] = [];
  let commentReactions = 0;
  let attachments = 0;
  for (let index = 0; index < rootComments; index += 1) {
    const sessionId = sessionIds[Math.floor(index / commentsPerSession) % sessionIds.length]!;
    const comment = store.createIssueComment(issue.id, {
      issueSessionId: sessionId,
      authorType: index % 5 === 0 ? "agent" : "member",
      authorId: index % 5 === 0 ? agent.id : owner.id,
      body: filler("comment", index, index % 7 === 0 ? 1400 : 320),
    });
    rootIds.push(comment.id);
    commentIds.push(comment.id);
    if (index < decoratedComments) {
      store.addCommentReaction(comment.id, { actorType: "member", actorId: owner.id, emoji: "👍" });
      commentReactions += 1;
      if (index % 3 === 0) {
        store.addCommentReaction(comment.id, { actorType: "agent", actorId: agent.id, emoji: "🎉" });
        commentReactions += 1;
      }
      store.createAttachment({
        id: `att_mul385_cmt_${String(index).padStart(3, "0")}`,
        workspaceId: WORKSPACE_ID,
        issueId: issue.id,
        commentId: comment.id,
        uploaderType: "member",
        uploaderId: owner.id,
        filename: `comment-${index}.txt`,
        url: `https://example.invalid/comment-${index}.txt`,
        contentType: "text/plain",
        sizeBytes: 1024 + index,
      });
      attachments += 1;
    }
  }

  for (let index = 0; index < replies; index += 1) {
    const parentId = rootIds[index % rootIds.length]!;
    const sessionId = sessionIds[Math.floor(index / commentsPerSession) % sessionIds.length]!;
    const reply = store.createIssueComment(issue.id, {
      issueSessionId: sessionId,
      parentId,
      authorType: index % 4 === 0 ? "agent" : "member",
      authorId: index % 4 === 0 ? agent.id : owner.id,
      body: filler("reply", index, 260),
    });
    commentIds.push(reply.id);
  }

  // ── issue-level decorated data ─────────────────────────────────────────────
  let reactions = 0;
  for (let index = 0; index < 6; index += 1) {
    store.addIssueReaction(issue.id, {
      actorType: index % 2 === 0 ? "member" : "agent",
      actorId: index % 2 === 0 ? owner.id : agent.id,
      emoji: ["👍", "🎉", "🚀"][index % 3]!,
    });
    reactions += 1;
  }
  for (let index = 0; index < 4; index += 1) {
    store.createAttachment({
      id: `att_mul385_issue_${String(index).padStart(2, "0")}`,
      workspaceId: WORKSPACE_ID,
      issueId: issue.id,
      uploaderType: "member",
      uploaderId: owner.id,
      filename: `issue-file-${index}.bin`,
      url: `https://example.invalid/issue-file-${index}.bin`,
      contentType: "application/octet-stream",
      sizeBytes: 20_000 + index,
    });
    attachments += 1;
  }

  const labelIds: string[] = [];
  for (const [index, name] of ["perf", "server", "MUL-385"].entries()) {
    const label = store.createLabel({
      id: `lbl_mul385_${index}`,
      workspaceId: WORKSPACE_ID,
      name,
      color: ["#0ea5e9", "#f97316", "#22c55e"][index]!,
    });
    store.attachLabelToIssue(issue.id, label.id, { actorType: "member", actorId: owner.id });
    labelIds.push(label.id);
  }

  // ── children + dependencies ────────────────────────────────────────────────
  const childIssueIds: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const child = store.createIssue({
      id: `iss_mul385_child_${index}`,
      workspaceId: WORKSPACE_ID,
      parentIssueId: issue.id,
      title: `MUL-385 child ${index}`,
      description: filler("child description", index, 400),
      status: index % 2 === 0 ? "done" : "in_progress",
      createdBy: owner.id,
    });
    store.getOrCreateDefaultIssueSession(child.id, owner.id);
    childIssueIds.push(child.id);
  }
  const dependencyIssueIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const other = store.createIssue({
      id: `iss_mul385_dep_${index}`,
      workspaceId: WORKSPACE_ID,
      title: `MUL-385 dependency ${index}`,
      createdBy: owner.id,
    });
    store.getOrCreateDefaultIssueSession(other.id, owner.id);
    dependencyIssueIds.push(other.id);
    store.createIssueDependency(issue.id, {
      id: `dep_mul385_${index}`,
      dependsOnIssueId: other.id,
      type: index === 0 ? "blocks" : "related",
    }, { actorType: "member", actorId: owner.id });
  }

  // ── tasks ──────────────────────────────────────────────────────────────────
  const taskIds: string[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const sessionId = sessionIds[index % sessionIds.length]!;
    const task = store.createTask({
      id: `tsk_mul385_${String(index).padStart(3, "0")}`,
      agentId: agent.id,
      issueId: issue.id,
      issueSessionId: sessionId,
      prompt: filler("task prompt", index, taskPromptBytes),
      requestingUserName: owner.name ?? "Owner",
    });
    taskIds.push(task.id);
  }

  // `createIssueComment` auto-joins the authoring agent to the session, so the
  // seeded counts are a lower bound. Report what the store actually holds.
  for (const sessionId of sessionIds) {
    participantCountBySession[sessionId] = store.listSessionParticipants(sessionId, true).length;
  }
  participantTotal = Object.values(participantCountBySession).reduce((sum, count) => sum + count, 0);

  return {
    workspaceId: WORKSPACE_ID,
    issueId: issue.id,
    issueKey: issue.key,
    defaultSessionId: defaultSession.id,
    sessionIds,
    participantCountBySession,
    taskIds,
    childIssueIds,
    dependencyIssueIds,
    counts: {
      rootComments,
      replies,
      comments: commentIds.length,
      sessions: sessionIds.length,
      participants: participantTotal,
      tasks: taskIds.length,
      reactions,
      commentReactions,
      attachments,
      labels: labelIds.length,
      children: childIssueIds.length,
      dependencies: dependencyIssueIds.length,
      activity: store.listIssueActivity(issue.id).length,
    },
    seedMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

/** Task rows carry large `result` bodies; the fixture writes them directly. */
export function fillTaskBodies(
  run: (sql: string, params: unknown[]) => void,
  taskIds: string[],
  resultBytes: number,
): void {
  taskIds.forEach((taskId, index) => {
    const createdAt = stamp(index * -60_000);
    run(
      "UPDATE multiremi_tasks SET status = ?, result = ?, created_at = ?, updated_at = ? WHERE id = ?",
      [
        index % 7 === 0 ? "running" : "completed",
        filler("task result", index, resultBytes),
        createdAt,
        createdAt,
        taskId,
      ],
    );
  });
}

// ── golden comparison ────────────────────────────────────────────────────────

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})/g;
/** Same shape without the `g` flag, so `.test` keeps no `lastIndex` state. */
const ISO_PROBE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Replace wall-clock timestamps with a placeholder of the same type so the
 * pre- and post-optimization bodies can be compared with `toEqual`.
 *
 * Only `created_at` / `updated_at` / `joined_at` / `resolved_at`-shaped strings
 * are rewritten: ids, bodies, counts and field presence stay exactly as the
 * route produced them, which is what the shape guard has to catch.
 */
export function normalizeIssueDetailResponse(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeCursor(value).replace(ISO_RE, "<timestamp>");
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeIssueDetailResponse(entry));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeIssueDetailResponse(entry);
    }
    return out;
  }
  return value;
}

/**
 * Scrub the timestamp half of a `base64url([createdAt, id])` page cursor.
 *
 * Page cursors carry a timestamp, so they are time-derived exactly like the
 * `created_at` fields the ISO substitution already covers. Leaving them raw
 * would make this golden depend on how many times the pinned clock was read
 * before the fixture ran — schema migrations read it — instead of on the
 * response shape the test exists to protect.
 */
function normalizeCursor(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(value)) return value;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return value;
  }
  if (
    Array.isArray(decoded)
    && decoded.length === 2
    && typeof decoded[0] === "string"
    && ISO_PROBE_RE.test(decoded[0])
    && typeof decoded[1] === "string"
  ) {
    return Buffer.from(JSON.stringify(["<timestamp>", decoded[1]]), "utf8").toString("base64url");
  }
  return value;
}

/**
 * Pin id generation and the clock so two runs of the same fixture produce
 * byte-comparable responses. `createId` draws from `crypto.getRandomValues`,
 * and page cursors are `base64url([createdAt, id])`, so both the PRNG and
 * `Date` have to be fixed for a golden comparison to mean anything.
 *
 * Returns a restore function. Mirrors the technique the API route snapshot
 * harness uses (`scripts/snapshot-api-routes.ts`), scoped to this fixture.
 */
export function installDeterministicIds(): () => void {
  const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const RealDate = globalThis.Date;
  // One tick per read, like the route snapshot harness: stable ordering with no
  // ties, and no chance of two rows sharing a timestamp.
  let clock = FIXTURE_EPOCH_MS;
  class FixtureDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock++);
      else super(...(args as []));
    }
    static now(): number {
      return clock++;
    }
  }
  (globalThis as { Date: unknown }).Date = FixtureDate;
  // Seeding re-anchors the clock (see `seedIssueDetailFirstScreenFixture`), so a
  // migration that reads the clock before the fixture runs cannot shift every
  // timestamp the golden encodes.
  activeClockReset = () => {
    clock = FIXTURE_EPOCH_MS;
  };
  let state = 0x385_9a71;
  const nextByte = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 24) & 0xff;
  };
  (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = (array: ArrayLike<number> & { length: number }) => {
    for (let index = 0; index < array.length; index += 1) {
      (array as unknown as number[])[index] = nextByte();
    }
    return array;
  };
  return () => {
    activeClockReset = null;
    (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = realGetRandomValues;
    (globalThis as { Date: unknown }).Date = RealDate;
  };
}
