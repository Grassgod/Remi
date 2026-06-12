/**
 * Squad member READ routes — port of the Go squad handler's
 *   GET /api/squads/{id}/members         (h.ListSquadMembers)
 *   GET /api/squads/{id}/members/status  (h.ListSquadMemberStatus)
 *
 * Both declare absolute paths (like memberRoutes) → mount at "/". Behind the
 * /api/* JWT gate; member-level workspace access via the X-Workspace-ID
 * header (or the resolved wsId context). The member WRITE paths — POST and
 * DELETE /api/squads/:id/members — already live in squads.ts behind the
 * owner/admin gate; they are intentionally not duplicated here.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../../db/client.js";
import type { AppEnv } from "../types.js";
import { getMembership } from "../../db/queries/issues.js";
import { getSquadInWorkspace, type Squad } from "../../db/queries/squads.js";
import {
  getIssuePrefixForWorkspace,
  listSquadMembers,
  listSquadMemberStatusRows,
  type SquadMemberRow,
} from "../../db/queries/squadMembers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Mirrors the Go SquadMemberResponse struct (snake_case JSON). */
function squadMemberToResponse(m: SquadMemberRow) {
  return {
    id: m.id,
    squad_id: m.squadId,
    member_type: m.memberType,
    member_id: m.memberId,
    role: m.role,
    created_at: m.createdAt,
  };
}

/** Mirrors the Go SquadActiveIssueBrief struct (snake_case JSON). */
interface SquadActiveIssueBrief {
  issue_id: string;
  identifier: string;
  title: string;
  issue_status: string;
}

/** Mirrors the Go SquadMemberStatusResponse struct. Agent members carry a
 * derived status; human members keep status/last_active_at null so the
 * front-end renders them in the same list without reordering. */
interface SquadMemberStatusResponse {
  member_type: string;
  member_id: string;
  status: string | null;
  active_issues: SquadActiveIssueBrief[];
  last_active_at: string | null;
}

/**
 * Collapse runtime + task signals into the five status buckets used by the
 * squad UI (mirrors Go deriveSquadMemberStatus): archived wins outright;
 * working (any dispatched/running task) wins over runtime health; an online
 * runtime is idle; an offline runtime seen within the last 5 minutes is
 * "unstable"; everything else is offline.
 */
function deriveSquadMemberStatus(
  archived: boolean,
  runtimeStatus: string | null,
  lastSeenAt: string | null,
  hasActiveTask: boolean,
  nowMs: number,
): string {
  if (archived) return "archived";
  if (hasActiveTask) return "working";
  if (!runtimeStatus) return "offline";
  if (runtimeStatus === "online") return "idle";
  if (!lastSeenAt) return "offline";
  if (nowMs - new Date(lastSeenAt).getTime() < FIVE_MINUTES_MS) return "unstable";
  return "offline";
}

/**
 * Resolve + authorize the workspace for this request. Returns the validated
 * workspace UUID, or a Response to short-circuit with (400 missing/malformed
 * header, 404 not-a-member — mirrors the Go workspace-member gate).
 */
async function requireWorkspace(c: Context<AppEnv>, db: Db): Promise<string | Response> {
  const wsId = c.req.header("X-Workspace-ID") ?? c.get("wsId");
  if (!wsId || !UUID_RE.test(wsId)) {
    return c.json({ error: "X-Workspace-ID header required" }, 400);
  }
  const m = await getMembership(db, c.get("user").sub, wsId);
  if (!m) return c.json({ error: "workspace not found" }, 404);
  return wsId;
}

/** Load the squad scoped to the workspace (mirrors Go loadSquadInWorkspace). */
async function requireSquad(c: Context<AppEnv>, db: Db, wsId: string): Promise<Squad | Response> {
  const id = c.req.param("id");
  if (!id || !UUID_RE.test(id)) return c.json({ error: "invalid squad id" }, 400);
  const found = await getSquadInWorkspace(db, wsId, id);
  if (!found) return c.json({ error: "squad not found" }, 404);
  return found;
}

export function squadMembersRoutes(db?: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // GET /api/squads/:id/members — the static member rows, insertion order.
  // Returns a bare array (mirrors Go ListSquadMembers).
  r.get("/api/squads/:id/members", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const squad = await requireSquad(c, db, ws);
    if (squad instanceof Response) return squad;

    const members = await listSquadMembers(db, squad.id);
    return c.json(members.map(squadMemberToResponse));
  });

  // GET /api/squads/:id/members/status — one entry per member with derived
  // status, the issues each agent member is currently running, and the last
  // observed activity (mirrors Go ListSquadMemberStatus). Read-only;
  // member-level access.
  r.get("/api/squads/:id/members/status", async (c) => {
    if (!db) return c.json({ error: "database not configured" }, 503);
    const ws = await requireWorkspace(c, db);
    if (ws instanceof Response) return ws;
    const squad = await requireSquad(c, db, ws);
    if (squad instanceof Response) return squad;

    const [rows, prefix] = await Promise.all([
      listSquadMemberStatusRows(db, squad.id),
      getIssuePrefixForWorkspace(db, squad.workspaceId),
    ]);
    const nowMs = Date.now();

    // Group rows by member_id while preserving the SQL ORDER BY (squad_member
    // insertion order). One member may appear in multiple rows when they have
    // more than one active task (mirrors the Go memberAcc aggregation).
    interface MemberAcc {
      response: SquadMemberStatusResponse;
      archived: boolean;
      hasActiveTask: boolean;
      runtimeStatus: string | null;
      runtimeSeenAt: string | null;
      latestActiveAt: string | null;
    }
    const order: string[] = [];
    const acc = new Map<string, MemberAcc>();

    for (const row of rows) {
      let entry = acc.get(row.memberId);
      if (!entry) {
        entry = {
          response: {
            member_type: row.memberType,
            member_id: row.memberId,
            status: null,
            active_issues: [],
            last_active_at: null,
          },
          archived: row.agentArchivedAt != null,
          hasActiveTask: false,
          runtimeStatus: row.runtimeStatus,
          runtimeSeenAt: row.runtimeLastSeenAt,
          latestActiveAt: null,
        };
        acc.set(row.memberId, entry);
        order.push(row.memberId);
      }

      if (row.memberType !== "agent") continue;

      // A dispatched/running task occupies an agent slot even when it has no
      // associated issue (chat / quick-create tasks have issue_id NULL): the
      // `working` bucket is defined by task presence, not issue presence.
      if (row.taskId) {
        entry.hasActiveTask = true;

        if (row.taskIssueId) {
          entry.response.active_issues.push({
            issue_id: row.taskIssueId,
            identifier: `${prefix}-${row.issueNumber ?? 0}`,
            title: row.issueTitle ?? "",
            issue_status: row.issueStatus ?? "",
          });
        }

        // last_active_at prefers the freshest active-task dispatch over the
        // runtime heartbeat — a working agent should not look stale because
        // the heartbeat is a few seconds behind.
        if (
          row.taskDispatchedAt &&
          (!entry.latestActiveAt ||
            new Date(row.taskDispatchedAt).getTime() > new Date(entry.latestActiveAt).getTime())
        ) {
          entry.latestActiveAt = row.taskDispatchedAt;
        }
      }
    }

    const members: SquadMemberStatusResponse[] = [];
    for (const id of order) {
      const entry = acc.get(id)!;
      if (entry.response.member_type === "agent") {
        entry.response.status = deriveSquadMemberStatus(
          entry.archived,
          entry.runtimeStatus,
          entry.runtimeSeenAt,
          entry.hasActiveTask,
          nowMs,
        );
        // Freshest active-task dispatch wins; falls back to the runtime
        // heartbeat; stays null when neither exists (mirrors Go).
        entry.response.last_active_at = entry.latestActiveAt ?? entry.runtimeSeenAt ?? null;
      }
      members.push(entry.response);
    }

    return c.json({ members });
  });

  return r;
}
