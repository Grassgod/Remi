import { test, expect } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createApp } from "../src/http/app.js";
import { githubRoutes } from "../src/http/routes/github.js";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { issueJWT } from "../src/auth/jwt.js";
import {
  user,
  member,
  workspace,
  issue,
  githubInstallation,
  githubPullRequest,
  githubPullRequestCheckSuite,
  issuePullRequest,
} from "../src/db/schema.js";
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

test.skipIf(!reachable)(
  "github read path: installations list (role-gated) + issue pull-requests with check counts",
  async () => {
    const { db, close } = createDb(DB_URL);
    // The github routes declare absolute paths and are not wired into app.ts;
    // mount them onto the same app so they sit behind the /api/* JWT gate.
    const app = createApp(cfg, db);
    app.route("/", githubRoutes(db));

    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-gh-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "GitHub WS", slug: `bun-gh-${stamp}`, issuePrefix: "GH" })
      .returning();

    // Owner membership → can_manage true, installation_id surfaced.
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

    const [inst] = await db
      .insert(githubInstallation)
      .values({
        workspaceId: ws!.id,
        installationId: 424242,
        accountLogin: "acme",
        accountType: "Organization",
        accountAvatarUrl: "https://example.com/a.png",
        connectedById: u.id,
      })
      .returning();

    const [iss] = await db
      .insert(issue)
      .values({
        workspaceId: ws!.id,
        title: "Wire up CI",
        status: "in_progress",
        priority: "none",
        creatorType: "member",
        creatorId: u.id,
        number: 1,
      })
      .returning();

    const headSha = "abc123def456";
    const [pr] = await db
      .insert(githubPullRequest)
      .values({
        workspaceId: ws!.id,
        installationId: 424242,
        repoOwner: "acme",
        repoName: "widgets",
        prNumber: 42,
        title: "GH-1 add CI",
        state: "open", // CHECK (open|closed|merged|draft)
        htmlUrl: "https://github.com/acme/widgets/pull/42",
        branch: "feat/ci",
        authorLogin: "octocat",
        authorAvatarUrl: "https://example.com/o.png",
        prCreatedAt: new Date().toISOString(),
        prUpdatedAt: new Date().toISOString(),
        headSha,
        additions: 10,
        deletions: 2,
        changedFiles: 3,
      })
      .returning();

    // Link PR ↔ issue.
    await db.insert(issuePullRequest).values({ issueId: iss!.id, pullRequestId: pr!.id });

    // Two check suites on the current head: one passed, one pending → aggregate
    // conclusion is "pending" (any not-yet-completed suite wins over passed).
    await db.insert(githubPullRequestCheckSuite).values([
      {
        prId: pr!.id,
        suiteId: 1,
        headSha,
        appId: 100,
        conclusion: "success",
        status: "completed",
        updatedAt: new Date().toISOString(),
      },
      {
        prId: pr!.id,
        suiteId: 2,
        headSha,
        appId: 200,
        conclusion: null,
        status: "in_progress",
        updatedAt: new Date().toISOString(),
      },
    ]);

    const auth = { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id };

    try {
      // installations list (owner) → installation_id present, can_manage true.
      const listRes = await app.request(`/api/workspaces/${ws!.id}/github/installations`, {
        headers: auth,
      });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as {
        installations: Array<{
          id: string;
          workspace_id: string;
          installation_id?: number;
          account_login: string;
          account_type: string;
          account_avatar_url: string | null;
          created_at: string;
        }>;
        configured: boolean;
        can_manage: boolean;
      };
      expect(body.can_manage).toBe(true);
      expect(typeof body.configured).toBe("boolean");
      expect(body.installations).toHaveLength(1);
      const row = body.installations[0]!;
      expect(row.id).toBe(inst!.id);
      expect(row.workspace_id).toBe(ws!.id);
      expect(row.installation_id).toBe(424242);
      expect(row.account_login).toBe("acme");
      expect(row.account_type).toBe("Organization");
      expect(row.account_avatar_url).toBe("https://example.com/a.png");

      // issue pull-requests → linked PR with aggregated check counts.
      const prRes = await app.request(`/api/issues/${iss!.id}/pull-requests`, { headers: auth });
      expect(prRes.status).toBe(200);
      const prBody = (await prRes.json()) as {
        pull_requests: Array<{
          id: string;
          workspace_id: string;
          repo_owner: string;
          repo_name: string;
          number: number;
          title: string;
          state: string;
          html_url: string;
          branch: string | null;
          mergeable_state: string | null;
          checks_conclusion: string | null;
          checks_passed: number;
          checks_failed: number;
          checks_pending: number;
          additions: number;
          deletions: number;
          changed_files: number;
        }>;
      };
      expect(prBody.pull_requests).toHaveLength(1);
      const p = prBody.pull_requests[0]!;
      expect(p.id).toBe(pr!.id);
      expect(p.workspace_id).toBe(ws!.id);
      expect(p.repo_owner).toBe("acme");
      expect(p.repo_name).toBe("widgets");
      expect(p.number).toBe(42);
      expect(p.title).toBe("GH-1 add CI");
      expect(p.state).toBe("open");
      expect(p.html_url).toBe("https://github.com/acme/widgets/pull/42");
      expect(p.branch).toBe("feat/ci");
      expect(p.additions).toBe(10);
      expect(p.deletions).toBe(2);
      expect(p.changed_files).toBe(3);
      // 1 passed + 1 pending → pending wins.
      expect(p.checks_passed).toBe(1);
      expect(p.checks_pending).toBe(1);
      expect(p.checks_failed).toBe(0);
      expect(p.checks_conclusion).toBe("pending");

      // Resolve the issue by its human identifier too (GH-1).
      const byIdent = await app.request(`/api/issues/GH-1/pull-requests`, { headers: auth });
      expect(byIdent.status).toBe(200);
      const byIdentBody = (await byIdent.json()) as { pull_requests: unknown[] };
      expect(byIdentBody.pull_requests).toHaveLength(1);

      // missing workspace header on issue PRs → 400
      const noWs = await app.request(`/api/issues/${iss!.id}/pull-requests`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noWs.status).toBe(400);

      // a member of no/other workspace → 404 (multi-tenancy gate)
      const otherWsId = "99999999-9999-4999-8999-999999999999";
      const foreign = await app.request(`/api/workspaces/${otherWsId}/github/installations`, {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": otherWsId },
      });
      expect(foreign.status).toBe(404);

      // unknown issue → 404
      const missingIssue = await app.request(
        "/api/issues/11111111-1111-4111-8111-111111111111/pull-requests",
        { headers: auth },
      );
      expect(missingIssue.status).toBe(404);
    } finally {
      await db.delete(githubPullRequestCheckSuite).where(eq(githubPullRequestCheckSuite.prId, pr!.id));
      await db.delete(issuePullRequest).where(eq(issuePullRequest.issueId, iss!.id));
      await db.delete(githubPullRequest).where(eq(githubPullRequest.workspaceId, ws!.id));
      await db.delete(githubInstallation).where(eq(githubInstallation.workspaceId, ws!.id));
      await db.delete(issue).where(eq(issue.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);

test.skipIf(!reachable)(
  "github installations: non-admin member sees no installation_id and can_manage false",
  async () => {
    const { db, close } = createDb(DB_URL);
    const app = createApp(cfg, db);
    app.route("/", githubRoutes(db));

    const stamp = Date.now();
    const { user: u } = await findOrCreateUser(db, `bun-gh-mem-${stamp}@bytedance.com`, cfg);
    const token = await issueJWT({ sub: u.id, email: u.email, name: u.name }, SECRET);

    const [ws] = await db
      .insert(workspace)
      .values({ name: "GitHub WS2", slug: `bun-gh-mem-${stamp}`, issuePrefix: "GM" })
      .returning();
    // Plain member → can_manage false, installation_id stripped.
    await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "member" });
    await db.insert(githubInstallation).values({
      workspaceId: ws!.id,
      installationId: 555,
      accountLogin: "acme",
      accountType: "User",
    });

    try {
      const res = await app.request(`/api/workspaces/${ws!.id}/github/installations`, {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": ws!.id },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        installations: Array<{ installation_id?: number; account_avatar_url: string | null }>;
        can_manage: boolean;
      };
      expect(body.can_manage).toBe(false);
      expect(body.installations).toHaveLength(1);
      // Non-admin: numeric management handle omitted entirely (Go omitempty).
      expect(body.installations[0]!.installation_id).toBeUndefined();
      expect(body.installations[0]!.account_avatar_url).toBeNull();
    } finally {
      await db.delete(githubInstallation).where(eq(githubInstallation.workspaceId, ws!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u.id));
      await close();
    }
  },
);
