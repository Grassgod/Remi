/**
 * GitHub App setup callback: a signed state from /connect is verified, the
 * account is fetched (injected client), and the installation row is upserted;
 * a forged/invalid state is rejected without writing.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { findOrCreateUser } from "../src/auth/users.js";
import { githubRoutes, type GithubAppClient } from "../src/http/routes/github.js";
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

test.skipIf(!reachable)("setup callback verifies signed state + upserts the installation; bad state rejected", async () => {
  const { db, close } = createDb(DB_URL);
  const stamp = Date.now();
  const installationId = stamp;
  const { user: u } = await findOrCreateUser(db, `bun-gs-${stamp}@bytedance.com`, cfg);
  const [ws] = await db.insert(workspace).values({ name: "GS WS", slug: `bun-gs-${stamp}`, issuePrefix: "GS", issueCounter: 0 }).returning();
  await db.insert(member).values({ workspaceId: ws!.id, userId: u.id, role: "owner" });

  const fakeClient: GithubAppClient = {
    async fetchInstallationAccount(id) {
      expect(id).toBe(installationId);
      return { login: "acme-co", accountType: "Organization", avatarUrl: "https://avatars/acme" };
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", async (c, n) => { c.set("user", { sub: u.id } as never); await n(); });
  app.route("/", githubRoutes(db, fakeClient));

  const prevSlug = process.env.GITHUB_APP_SLUG;
  const prevSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_APP_SLUG = "multimira-test";
  process.env.GITHUB_WEBHOOK_SECRET = "whsec-setup";
  try {
    // Get a real signed state from /connect.
    const connect = await app.request(`/api/workspaces/${ws!.id}/github/connect`);
    const { install_url } = (await connect.json()) as { install_url: string };
    const state = new URL(install_url).searchParams.get("state")!;
    expect(state.split(".").length).toBe(3);

    // Callback with the valid state → 302 connected + installation row.
    const ok = await app.request(`/api/github/setup?installation_id=${installationId}&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("Location")).toContain("github_connected=1");
    const [inst] = await db.select().from(githubInstallation).where(eq(githubInstallation.installationId, installationId));
    expect(inst!.workspaceId).toBe(ws!.id);
    expect(inst!.accountLogin).toBe("acme-co");
    expect(inst!.accountType).toBe("Organization");

    // A forged state → invalid_state redirect, no extra row.
    const bad = await app.request(`/api/github/setup?installation_id=${installationId + 1}&state=${ws!.id}.deadbeef.forged`);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("Location")).toContain("github_error=invalid_state");
    expect((await db.select().from(githubInstallation).where(eq(githubInstallation.installationId, installationId + 1))).length).toBe(0);
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
