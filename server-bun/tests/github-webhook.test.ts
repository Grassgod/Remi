/**
 * GitHub webhook: a signed pull_request event resolves its installation and
 * upserts a PR mirror row; a bad signature is rejected with 401.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { githubWebhookRoutes } from "../src/http/routes/githubWebhook.js";
import { workspace, githubInstallation, githubPullRequest } from "../src/db/schema.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const SECRET = "test-webhook-secret";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

test.skipIf(!reachable)("a signed pull_request event upserts the PR; a bad signature is 401", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const installationId = stamp; // unique bigint
  const [ws] = await db
    .insert(workspace)
    .values({ name: "GH WS", slug: `bun-gh-${stamp}`, issuePrefix: "GH", issueCounter: 0 })
    .returning();
  await db.insert(githubInstallation).values({
    workspaceId: ws!.id,
    installationId,
    accountLogin: "octocat",
  });

  const app = new Hono();
  app.route("/", githubWebhookRoutes(db));

  const body = JSON.stringify({
    action: "opened",
    installation: { id: installationId },
    repository: { name: "demo", owner: { login: "octocat" } },
    pull_request: {
      number: 7,
      title: "Add feature",
      state: "open",
      html_url: "https://github.com/octocat/demo/pull/7",
      head: { ref: "feat/x", sha: "abc123" },
      user: { login: "octocat", avatar_url: "https://avatars/octocat" },
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    },
  });

  try {
    // Wrong signature → 401.
    const bad = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": "sha256=deadbeef" },
      body,
    });
    expect(bad.status).toBe(401);

    // Correct signature → 200 + upserted PR row.
    const ok = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": sign(body) },
      body,
    });
    expect(ok.status).toBe(200);
    const out = (await ok.json()) as { ok: boolean; pull_request_id?: string };
    expect(out.ok).toBe(true);

    const [pr] = await db
      .select()
      .from(githubPullRequest)
      .where(and(eq(githubPullRequest.workspaceId, ws!.id), eq(githubPullRequest.prNumber, 7)));
    expect(pr!.title).toBe("Add feature");
    expect(pr!.state).toBe("open");
    expect(pr!.branch).toBe("feat/x");
    expect(pr!.authorLogin).toBe("octocat");
  } finally {
    await db.delete(githubPullRequest).where(eq(githubPullRequest.workspaceId, ws!.id));
    await db.delete(githubInstallation).where(eq(githubInstallation.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await close();
  }
});
