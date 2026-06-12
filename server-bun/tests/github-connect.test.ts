/**
 * GitHub install management: connect returns the App install URL when
 * configured (owner/admin) and { configured:false } otherwise; disconnect
 * removes an installation (owner/admin), 404 for an unknown id.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { githubRoutes } from "../src/http/routes/github.js";
import { user, member, workspace, githubInstallation } from "../src/db/schema.js";
import type { AppEnv } from "../src/http/types.js";
import type { Config } from "../src/config.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";
const cfg: Config = { port: 0, jwtSecret: "x", authTokenTtlSeconds: 3600, databaseUrl: DB_URL, allowedEmailDomains: [] };

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip */
}

test.skipIf(!reachable)("connect URL (configured/unconfigured) + disconnect", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const { user: u } = await findOrCreateUser(db, `bun-gc-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "GC WS", slug: `bun-gc-${stamp}`, issuePrefix: "GC", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });
  const [inst] = await db.insert(githubInstallation).values({ workspaceId: ws!.id, installationId: stamp, accountLogin: "octocat" }).returning();

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/", githubRoutes(db));

  const prevSlug = process.env.GITHUB_APP_SLUG;
  const prevSecret = process.env.GITHUB_WEBHOOK_SECRET;
  try {
    // Unconfigured → { configured: false }.
    delete process.env.GITHUB_APP_SLUG;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const off = await app.request(`/api/workspaces/${ws!.id}/github/connect`);
    expect(((await off.json()) as { configured: boolean }).configured).toBe(false);

    // Configured → an install URL with the slug + a state param.
    process.env.GITHUB_APP_SLUG = "multimira-test";
    process.env.GITHUB_WEBHOOK_SECRET = "whsec";
    const on = await app.request(`/api/workspaces/${ws!.id}/github/connect`);
    const onBody = (await on.json()) as { configured: boolean; install_url: string };
    expect(onBody.configured).toBe(true);
    expect(onBody.install_url).toContain("https://github.com/apps/multimira-test/installations/new?state=");

    // Disconnect an unknown installation → 404.
    const miss = await app.request(`/api/workspaces/${ws!.id}/github/installations/11111111-1111-1111-1111-111111111111`, { method: "DELETE" });
    expect(miss.status).toBe(404);

    // Disconnect the real one → 204, row gone.
    const del = await app.request(`/api/workspaces/${ws!.id}/github/installations/${inst!.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await db.select().from(githubInstallation).where(eq(githubInstallation.id, inst!.id))).length).toBe(0);
  } finally {
    if (prevSlug === undefined) delete process.env.GITHUB_APP_SLUG; else process.env.GITHUB_APP_SLUG = prevSlug;
    if (prevSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = prevSecret;
    await db.delete(githubInstallation).where(eq(githubInstallation.workspaceId, ws!.id));
    await db.delete(member).where(eq(member.workspaceId, ws!.id));
    await db.delete(workspace).where(eq(workspace.id, ws!.id));
    await db.delete(user).where(eq(user.id, u.id));
    await close();
  }
});
