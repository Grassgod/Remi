import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { invitationRoutes } from "../src/http/routes/invitations.js";
import { user, member, workspace, workspaceInvitation } from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: "test-secret-0123456789",
  authTokenTtlSeconds: 3600,
  databaseUrl: DB_URL,
  allowedEmailDomains: [],
};

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

/** Mount invitationRoutes on a bare app whose c.get("user").sub is `userId`. */
function appForUser(db: ReturnType<typeof createDb>["db"], userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => {
    // The routes only read user.sub; email/name satisfy the AuthClaims type.
    c.set("user", { sub: userId, email: "", name: "" });
    await n();
  });
  app.route("/", invitationRoutes(db));
  return app;
}

type InvitationResp = {
  id: string;
  workspace_id: string;
  inviter_id: string;
  invitee_email: string;
  invitee_user_id: string | null;
  role: string;
  status: string;
  inviter_name?: string;
  workspace_name?: string;
};

type MemberResp = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  email: string;
};

test.skipIf(!reachable)(
  "invitations: create, list, accept (as invitee → inserts member), revoke",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    // Owner (the inviter) + a second user who is the invitee.
    const { user: owner } = await findOrCreateUser(db, `bun-inv-owner-${stamp}@bytedance.com`, cfg);
    const inviteeEmail = `bun-inv-invitee-${stamp}@bytedance.com`;
    const { user: invitee } = await findOrCreateUser(db, inviteeEmail, cfg);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Invite WS", slug: `bun-inv-${stamp}`, issuePrefix: "INV" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: owner.id, role: "owner" });

    const ownerApp = appForUser(db, owner.id);
    const inviteeApp = appForUser(db, invitee.id);

    let invId = "";
    try {
      // --- CREATE (owner) ---------------------------------------------------
      const createRes = await ownerApp.request(`/api/workspaces/${ws!.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Workspace-ID": ws!.id },
        body: JSON.stringify({ email: inviteeEmail, role: "member" }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as InvitationResp;
      expect(created.workspace_id).toBe(ws!.id);
      expect(created.invitee_email).toBe(inviteeEmail);
      expect(created.role).toBe("member");
      expect(created.status).toBe("pending");
      expect(created.inviter_id).toBe(owner.id);
      // Invitee already exists → invitee_user_id resolved.
      expect(created.invitee_user_id).toBe(invitee.id);
      expect(created.workspace_name).toBe("Invite WS");
      invId = created.id;

      // Duplicate pending invite → 409.
      const dupe = await ownerApp.request(`/api/workspaces/${ws!.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteeEmail }),
      });
      expect(dupe.status).toBe(409);

      // --- LIST (workspace-scoped, owner) ----------------------------------
      const listRes = await ownerApp.request(`/api/workspaces/${ws!.id}/invitations`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as InvitationResp[];
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe(invId);
      expect(list[0]!.inviter_name).toBe(owner.name);

      // --- LIST MINE (invitee) ---------------------------------------------
      const mineRes = await inviteeApp.request("/api/invitations");
      expect(mineRes.status).toBe(200);
      const mine = (await mineRes.json()) as InvitationResp[];
      expect(mine.length).toBe(1);
      expect(mine[0]!.id).toBe(invId);
      expect(mine[0]!.workspace_name).toBe("Invite WS");

      // --- GET ONE (invitee) -----------------------------------------------
      const getRes = await inviteeApp.request(`/api/invitations/${invId}`);
      expect(getRes.status).toBe(200);
      const one = (await getRes.json()) as InvitationResp;
      expect(one.id).toBe(invId);
      expect(one.inviter_email).toBeDefined;

      // Owner is NOT the invitee → 403 on the user-scoped get.
      const forbidden = await ownerApp.request(`/api/invitations/${invId}`);
      expect(forbidden.status).toBe(403);

      // --- ACCEPT (invitee) → inserts a member row -------------------------
      const acceptRes = await inviteeApp.request(`/api/invitations/${invId}/accept`, {
        method: "POST",
      });
      expect(acceptRes.status).toBe(200);
      const newMember = (await acceptRes.json()) as MemberResp;
      expect(newMember.workspace_id).toBe(ws!.id);
      expect(newMember.user_id).toBe(invitee.id);
      expect(newMember.role).toBe("member");
      expect(newMember.email).toBe(inviteeEmail);

      // Member row actually exists in that workspace.
      const memberRows = await db
        .select()
        .from(member)
        .where(eq(member.userId, invitee.id));
      expect(memberRows.some((m) => m.workspaceId === ws!.id)).toBe(true);

      // Invitation status flipped to 'accepted'.
      const [accepted] = await db
        .select()
        .from(workspaceInvitation)
        .where(eq(workspaceInvitation.id, invId));
      expect(accepted!.status).toBe("accepted");

      // Accepting a non-pending invitation again → 400.
      const reAccept = await inviteeApp.request(`/api/invitations/${invId}/accept`, {
        method: "POST",
      });
      expect(reAccept.status).toBe(400);

      // --- REVOKE: create a fresh pending invite, then revoke it -----------
      const secondEmail = `bun-inv-second-${stamp}@bytedance.com`;
      const create2 = await ownerApp.request(`/api/workspaces/${ws!.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: secondEmail, role: "admin" }),
      });
      expect(create2.status).toBe(201);
      const inv2 = (await create2.json()) as InvitationResp;
      expect(inv2.role).toBe("admin");

      const revokeRes = await ownerApp.request(
        `/api/workspaces/${ws!.id}/invitations/${inv2.id}`,
        { method: "DELETE" },
      );
      expect(revokeRes.status).toBe(204);

      const [revoked] = await db
        .select()
        .from(workspaceInvitation)
        .where(eq(workspaceInvitation.id, inv2.id));
      expect(revoked!.status).toBe("expired");

      // Revoking an already-revoked (non-pending) invitation → 404.
      const revokeAgain = await ownerApp.request(
        `/api/workspaces/${ws!.id}/invitations/${inv2.id}`,
        { method: "DELETE" },
      );
      expect(revokeAgain.status).toBe(404);
    } finally {
      await db.delete(workspaceInvitation).where(eq(workspaceInvitation.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, owner.id));
      await db.delete(user).where(eq(user.id, invitee.id));
      await close();
    }
  },
);
