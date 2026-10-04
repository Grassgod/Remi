/**
 * Stream subscription authorization for the browser WebSocket (MUL-438 / C3,
 * plan 2/6 §1's 三类订阅者接入 table).
 *
 * Two stream kinds, two rules:
 *
 * - `log:<session_id>` — the session decides. A chat session is creator-only; an
 *   issue session is visible to the workspace it belongs to. This is the same
 *   boundary the transcript routes draw (`denyCurrentUserWorkspaceAccess` plus
 *   `canUserViewTaskMessages`, `api/helpers/auth-guards.ts`), expressed here as
 *   one query per subscription instead of a hydrated store read, because C4's
 *   binding constraint is that new server-side read paths must not go through the
 *   synchronous Postgres bridge (MUL-383 `cmt_u3fltd47w6r0`).
 * - `trace:<task_id>` — `canUserViewTaskMessages`: a chat task is creator-only
 *   and a private agent's task is owner/admin-only.
 *
 * ## Two readers, one decision
 *
 * The rule itself is written once, as a pure function over facts plus the three
 * membership answers a subscription needs. Each backend supplies the facts its
 * own way:
 *
 * - Postgres → one `SELECT` per subscription through {@link ReadPool}, which is
 *   where C4's read-only pool and its SQL gate live.
 * - SQLite → the store's synchronous handles, which is what the local profile and
 *   the existing test suite use. `bun:sqlite` is in-process, so wrapping it in a
 *   queue would add latency without bounding anything.
 *
 * A denial and a missing row are deliberately indistinguishable: both answer
 * `forbidden`, so a socket cannot use `stream.error` to enumerate sessions or
 * tasks.
 */

import type { MultiremiStore } from "@multiremi/store/store.js";
import { createReadPool, type ReadPool } from "@multiremi/store/db/read-pool.js";
import { isPostgresConfigured } from "@multiremi/store/db/postgres.js";
import type { ApiRole } from "@multiremi/config/api-role.js";

/** The codes a refused `stream.subscribe` can carry (see the C0 contract). */
export type StreamSubscribeDenialCode = "invalid_payload" | "forbidden" | "wrong_endpoint" | "unavailable";

export type StreamSubscribeAuthorization =
  | { ok: true }
  | { ok: false; code: StreamSubscribeDenialCode };

/** Who is asking. `userId === null` is the master-token / open-mode identity. */
export interface StreamAuthSubject {
  userId: string | null;
  /** The workspace this socket was bound to at upgrade time. */
  workspaceId: string;
}

/**
 * What a `log:` subscription needs to know about its session.
 *
 * `requesterIsMember` is answered in the same query as the session row so the
 * Postgres path stays at one statement.
 */
export interface LogStreamAuthFacts {
  kind: "chat" | "issue";
  workspaceId: string;
  /** The chat session's creator; `null` for an issue session. */
  creatorId: string | null;
  requesterIsMember: boolean;
}

/** What a `trace:` subscription needs to know about its task. */
export interface TraceStreamAuthFacts {
  workspaceId: string;
  chatSessionId: string | null;
  /** Creator of the task's chat session; `null` when that session is gone. */
  chatCreatorId: string | null;
  agentId: string | null;
  agentVisibility: string | null;
  agentOwnerId: string | null;
  requesterIsWorkspaceAdmin: boolean;
}

/**
 * The facts a subscription needs, or `unavailable` when they could not be read.
 *
 * `ok: false` never means "denied" — that answer comes from the decision below,
 * and the client is allowed to retry an `unavailable`.
 */
export type StreamAuthFactsResult<T> =
  | { ok: true; facts: T }
  | { ok: false; code: "unavailable" };

export interface StreamAuthReader {
  readonly backend: "postgres" | "sqlite";
  logFacts(sessionId: string, subject: StreamAuthSubject): Promise<StreamAuthFactsResult<LogStreamAuthFacts | null>>;
  traceFacts(taskId: string, subject: StreamAuthSubject): Promise<StreamAuthFactsResult<TraceStreamAuthFacts | null>>;
}

/**
 * `log:` — a chat session is creator-only; an issue session is a workspace
 * resource, so any member of that workspace may read it.
 *
 * The `userId == null` case is the administrative identity the rest of the
 * server treats as local owner (`buildRequestAuth`); it keeps access, or an
 * operator holding the master token could not open their own socket. The
 * workspace comparison still applies to it: a socket bound to one workspace does
 * not read another workspace's sessions.
 */
export function decideLogSubscription(
  subject: StreamAuthSubject,
  facts: LogStreamAuthFacts | null,
): StreamSubscribeAuthorization {
  if (!facts) return { ok: false, code: "forbidden" };
  if (facts.workspaceId !== subject.workspaceId) return { ok: false, code: "forbidden" };
  if (subject.userId == null) return { ok: true };
  if (facts.kind === "chat") {
    return facts.creatorId === subject.userId ? { ok: true } : { ok: false, code: "forbidden" };
  }
  return facts.requesterIsMember ? { ok: true } : { ok: false, code: "forbidden" };
}

/**
 * `trace:` — a chat task is creator-only; a private agent's task is readable by
 * its owner and by the workspace's owner/admin; everything else is a workspace
 * read.
 *
 * This is `canUserViewTaskMessages` (`api/helpers/auth-guards.ts:485`) with its
 * two store lookups folded into the facts. An agent that no longer exists does
 * not restrict the read there, so a missing agent row is treated as "not
 * private" here too.
 */
export function decideTraceSubscription(
  subject: StreamAuthSubject,
  facts: TraceStreamAuthFacts | null,
): StreamSubscribeAuthorization {
  if (!facts) return { ok: false, code: "forbidden" };
  if (facts.workspaceId !== subject.workspaceId) return { ok: false, code: "forbidden" };
  if (subject.userId == null) return { ok: true };
  if (facts.chatSessionId) {
    return facts.chatCreatorId === subject.userId ? { ok: true } : { ok: false, code: "forbidden" };
  }
  if (!facts.agentId) return { ok: true };
  if (facts.agentVisibility !== "private") return { ok: true };
  if (facts.agentOwnerId && facts.agentOwnerId === subject.userId) return { ok: true };
  return facts.requesterIsWorkspaceAdmin ? { ok: true } : { ok: false, code: "forbidden" };
}

/**
 * The one statement a `log:` subscription costs in Postgres, written in the
 * sqlite dialect the store uses (the pool translates it before it reaches the
 * server).
 *
 * A conversation log lives in exactly one of the two session tables, so this is
 * a `UNION ALL` of two projections rather than a join: either arm returns a row
 * or the id names no session. Membership is a subquery per arm, which keeps the
 * whole decision at one statement.
 *
 * Parameters, in order: `[userId, sessionId, userId, sessionId]`.
 */
export const LOG_STREAM_FACTS_SQL = `SELECT 'chat' AS kind, s.workspace_id AS workspace_id, s.creator_id AS creator_id,
       (SELECT count(*) FROM multiremi_workspace_members m
         WHERE m.workspace_id = s.workspace_id AND m.user_id = ? AND m.archived_at IS NULL) AS is_member
  FROM multiremi_chat_sessions s WHERE s.id = ?
UNION ALL
SELECT 'issue' AS kind, s.workspace_id AS workspace_id, NULL AS creator_id,
       (SELECT count(*) FROM multiremi_workspace_members m
         WHERE m.workspace_id = s.workspace_id AND m.user_id = ? AND m.archived_at IS NULL) AS is_member
  FROM multiremi_issue_sessions s WHERE s.id = ?`;

/**
 * The one statement a `trace:` subscription costs in Postgres.
 *
 * The task decides chat-ness, the chat session supplies the creator, and the
 * agent supplies the privacy rule. An archived agent is left out of the join so
 * its task reads as unrestricted, which is what the store-backed guard sees.
 *
 * Parameters, in order: `[userId, userId, taskId]`.
 */
export const TRACE_STREAM_FACTS_SQL = `SELECT t.workspace_id AS workspace_id, t.chat_session_id AS chat_session_id,
       c.creator_id AS chat_creator_id, t.agent_id AS agent_id,
       a.visibility AS agent_visibility, a.owner_id AS agent_owner_id,
       (SELECT count(*) FROM multiremi_workspace_members m
         WHERE m.workspace_id = t.workspace_id AND m.user_id = ? AND m.archived_at IS NULL
           AND m.role IN ('owner', 'admin')) AS is_admin
  FROM multiremi_turn_execution_records t
  LEFT JOIN multiremi_chat_sessions c ON c.id = t.chat_session_id
  LEFT JOIN multiremi_agents a ON a.id = t.agent_id AND a.archived_at IS NULL
 WHERE t.id = ?`;

interface LogFactsRow {
  kind?: unknown;
  workspace_id?: unknown;
  creator_id?: unknown;
  is_member?: unknown;
}

interface TraceFactsRow {
  workspace_id?: unknown;
  chat_session_id?: unknown;
  chat_creator_id?: unknown;
  agent_id?: unknown;
  agent_visibility?: unknown;
  agent_owner_id?: unknown;
  is_admin?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

/** Project one row of {@link LOG_STREAM_FACTS_SQL}; `null` when the id is unknown. */
export function logFactsFromRow(row: LogFactsRow | null): LogStreamAuthFacts | null {
  if (!row) return null;
  const workspaceId = text(row.workspace_id);
  if (!workspaceId) return null;
  const kind = row.kind === "chat" ? "chat" : row.kind === "issue" ? "issue" : null;
  if (!kind) return null;
  return {
    kind,
    workspaceId,
    creatorId: kind === "chat" ? text(row.creator_id) : null,
    requesterIsMember: flag(row.is_member),
  };
}

/** Project one row of {@link TRACE_STREAM_FACTS_SQL}; `null` when the id is unknown. */
export function traceFactsFromRow(row: TraceFactsRow | null): TraceStreamAuthFacts | null {
  if (!row) return null;
  const workspaceId = text(row.workspace_id);
  if (!workspaceId) return null;
  return {
    workspaceId,
    chatSessionId: text(row.chat_session_id),
    chatCreatorId: text(row.chat_creator_id),
    agentId: text(row.agent_id),
    agentVisibility: text(row.agent_visibility),
    agentOwnerId: text(row.agent_owner_id),
    requesterIsWorkspaceAdmin: flag(row.is_admin),
  };
}

/**
 * The Postgres arm: one statement per subscription through the read-only pool.
 *
 * A pool refusal, timeout or saturation is `unavailable` rather than `forbidden`,
 * so a client retries instead of concluding it lost access, and the pool's own
 * error still reaches the log through its normal path.
 */
export function createPostgresStreamAuthReader(pool: ReadPool): StreamAuthReader {
  return {
    backend: "postgres",
    async logFacts(sessionId, subject) {
      try {
        const row = await pool.queryOne<LogFactsRow>(LOG_STREAM_FACTS_SQL, [
          subject.userId,
          sessionId,
          subject.userId,
          sessionId,
        ]);
        return { ok: true, facts: logFactsFromRow(row) };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    },
    async traceFacts(taskId, subject) {
      try {
        const row = await pool.queryOne<TraceFactsRow>(TRACE_STREAM_FACTS_SQL, [
          subject.userId,
          taskId,
        ]);
        return { ok: true, facts: traceFactsFromRow(row) };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    },
  };
}

/**
 * The synchronous arm: the store's own handles, for SQLite and for tests.
 *
 * It reads the same columns the SQL above does, through the accessors the rest of
 * the server uses, so a change to either arm's reading of "member" or "private"
 * shows up as a test failure rather than as a second definition of the rule.
 */
/**
 * Pick the reader for this process's backend.
 *
 * `MULTIREMI_DATABASE_URL` alone does not decide it: `bun test` seeds an
 * in-memory sqlite store while the ambient environment may still point at
 * Postgres, and a subscription check answered by a different database than the
 * one the test wrote would be a hole in exactly the acceptance case this file
 * exists for. The synchronous arm is therefore also the test arm.
 */
export function createStreamAuthReader(
  store: MultiremiStore,
  options: { pool?: ReadPool | null; role?: ApiRole } = {},
): StreamAuthReader {
  if (process.env.NODE_ENV === "test") return createSqliteStreamAuthReader(store);
  if (!isPostgresConfigured()) return createSqliteStreamAuthReader(store);
  const pool = options.pool ?? createReadPool({ databaseUrl: process.env.MULTIREMI_DATABASE_URL, role: options.role });
  return createPostgresStreamAuthReader(pool);
}

export function createSqliteStreamAuthReader(store: MultiremiStore): StreamAuthReader {
  const isMember = (userId: string | null, workspaceId: string): boolean =>
    userId != null && store.getUserRoleInWorkspace(userId, workspaceId) !== null;
  const isAdmin = (userId: string | null, workspaceId: string): boolean => {
    if (userId == null) return false;
    const role = store.getUserRoleInWorkspace(userId, workspaceId);
    return role === "owner" || role === "admin";
  };
  return {
    backend: "sqlite",
    async logFacts(sessionId, subject) {
      try {
        const chatSession = store.getChatSession(sessionId);
        if (chatSession) {
          const workspaceId = chatSession.workspaceId;
          return {
            ok: true,
            facts: {
              kind: "chat",
              workspaceId,
              creatorId: chatSession.creatorId ?? null,
              requesterIsMember: isMember(subject.userId, workspaceId),
            },
          };
        }
        const issueSession = store.getIssueSession(sessionId);
        if (!issueSession) return { ok: true, facts: null };
        return {
          ok: true,
          facts: {
            kind: "issue",
            workspaceId: issueSession.workspaceId,
            creatorId: null,
            requesterIsMember: isMember(subject.userId, issueSession.workspaceId),
          },
        };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    },
    async traceFacts(taskId, subject) {
      try {
        const task = store.getTask(taskId);
        if (!task) return { ok: true, facts: null };
        const chatSession = task.chatSessionId ? store.getChatSession(task.chatSessionId) : null;
        const agent = task.agentId ? store.getAgent(task.agentId) : null;
        return {
          ok: true,
          facts: {
            workspaceId: task.workspaceId,
            chatSessionId: task.chatSessionId ?? null,
            chatCreatorId: chatSession?.creatorId ?? null,
            agentId: task.agentId ?? null,
            agentVisibility: agent?.visibility ?? null,
            agentOwnerId: agent?.ownerId ?? null,
            requesterIsWorkspaceAdmin: isAdmin(subject.userId, task.workspaceId),
          },
        };
      } catch {
        return { ok: false, code: "unavailable" };
      }
    },
  };
}
