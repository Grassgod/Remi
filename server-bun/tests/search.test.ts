import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import { user, member, workspace, issue } from "../src/db/schema.js";
import type { Config } from "../src/config.js";

const SECRET = "test-secret-0123456789";
const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = {
  port: 0,
  jwtSecret: SECRET,
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

interface SearchIssue {
  id: string;
  workspace_id: string;
  number: number;
  identifier: string;
  title: string;
  status: string;
  match_source: string;
}

test.skipIf(!reachable)(
  "search read path: title/identifier ILIKE, workspace-scoped, closed excluded by default",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-search-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "Search WS", slug: `bun-search-${stamp}`, issuePrefix: "SRC" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    // Four issues: two title-matching ("Deploy ..."), one of which is done
    // (terminal → excluded by default), one non-matching, and one for the
    // identifier-number lookup.
    await db.insert(issue).values([
      {
        workspaceId: ws!.id,
        title: "Deploy the gateway",
        status: "in_progress",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      },
      {
        workspaceId: ws!.id,
        title: "Deploy is finished",
        status: "done", // terminal — excluded unless include_closed=true
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 2,
      },
      {
        workspaceId: ws!.id,
        title: "Unrelated chore",
        status: "backlog",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 3,
      },
      {
        workspaceId: ws!.id,
        title: "Refactor parser",
        status: "todo",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 42,
      },
    ]);

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // title search "deploy" → only the active "Deploy the gateway" (done one excluded)
      const res = await app.request("/api/search?q=deploy", { headers: auth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { issues: SearchIssue[]; total: number };
      expect(body.total).toBe(1);
      expect(body.issues).toHaveLength(1);
      const hit = body.issues[0]!;
      expect(hit.title).toBe("Deploy the gateway");
      expect(hit.workspace_id).toBe(ws!.id);
      expect(hit.identifier).toBe("SRC-1");
      expect(hit.match_source).toBe("title");
      expect(res.headers.get("X-Total-Count")).toBe("1");

      // include_closed=true → both "Deploy" issues
      const withClosed = await app.request("/api/search?q=deploy&include_closed=true", {
        headers: auth,
      });
      expect(withClosed.status).toBe(200);
      const cbody = (await withClosed.json()) as { issues: SearchIssue[]; total: number };
      expect(cbody.total).toBe(2);

      // identifier-style query "SRC-42" → the number-42 issue
      const byId = await app.request("/api/search?q=SRC-42", { headers: auth });
      expect(byId.status).toBe(200);
      const idbody = (await byId.json()) as { issues: SearchIssue[]; total: number };
      expect(idbody.total).toBe(1);
      expect(idbody.issues[0]!.number).toBe(42);
      expect(idbody.issues[0]!.identifier).toBe("SRC-42");

      // bare number "3" → that issue by number
      const byNum = await app.request("/api/search?q=3", { headers: auth });
      expect(byNum.status).toBe(200);
      const numbody = (await byNum.json()) as { issues: SearchIssue[]; total: number };
      expect(numbody.total).toBe(1);
      expect(numbody.issues[0]!.number).toBe(3);

      // no matches → empty
      const none = await app.request("/api/search?q=zzznomatch", { headers: auth });
      expect(none.status).toBe(200);
      const nbody = (await none.json()) as { issues: SearchIssue[]; total: number };
      expect(nbody.total).toBe(0);
      expect(nbody.issues).toHaveLength(0);

      // missing q → 400
      const noQ = await app.request("/api/search", { headers: auth });
      expect(noQ.status).toBe(400);

      // missing workspace header → 400
      const noWs = await app.request("/api/search?q=deploy", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request("/api/search?q=deploy", {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);

      // unauthenticated → 401
      const noAuth = await app.request("/api/search?q=deploy", {
        headers: { "X-Workspace-ID": ws!.id },
      });
      expect(noAuth.status).toBe(401);
    } finally {
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
