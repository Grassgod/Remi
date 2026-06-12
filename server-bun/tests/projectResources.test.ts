/**
 * Project resource endpoint tests — DB-gated. Drives the standalone
 * projectResourcesRoutes(db) factory (absolute paths, mounted at "/"): the
 * full list -> create (github_repo + local_directory, normalization, 409s) ->
 * update (partial semantics, label clear, position keep-on-null) -> delete
 * cycle, plus the validation and multi-tenancy gates. Mirrors the Go
 * project_resource handler's behavior field-for-field.
 */

import { test, expect } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { projectResourcesRoutes } from "../src/http/routes/projectResources.js";
import type { AppEnv } from "../src/http/types.js";
import { user, member, workspace, project, projectResource } from "../src/db/schema.js";

const DB_URL = process.env.DATABASE_URL ?? "postgres://multimira:multimira@localhost:5432/multimira";

let reachable = false;
try {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  await probe`select 1`;
  await probe.end();
  reachable = true;
} catch {
  /* skip when no DB */
}

interface ResourceResponse {
  id: string;
  project_id: string;
  workspace_id: string;
  resource_type: string;
  resource_ref: Record<string, unknown>;
  label: string | null;
  position: number;
  created_at: string;
  created_by: string | null;
}

test.skipIf(!reachable)(
  "project resources: list -> create -> update -> delete cycle with normalization, conflicts and gates",
  async () => {
    const { db, close } = createDb(DB_URL);
    const stamp = Date.now();

    // FK order: user/workspace -> member -> project -> (resource leaf rows).
    const [u] = await db
      .insert(user)
      .values({ email: `bun-pres-${stamp}@bytedance.com`, name: "Resource Tester" })
      .returning();
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Resource WS", slug: `bun-pres-${stamp}`, issuePrefix: "RES" })
      .returning();
    await db.insert(member).values({ workspaceId: ws!.id, userId: u!.id, role: "owner" });
    const [p] = await db
      .insert(project)
      .values({ workspaceId: ws!.id, title: "Resource Project" })
      .returning();

    const app = new Hono<AppEnv>();
    app.use("*", async (c, n) => {
      c.set("user", { sub: u!.id } as AppEnv["Variables"]["user"]);
      await n();
    });
    app.route("/", projectResourcesRoutes(db));

    const headers = { "X-Workspace-ID": ws!.id, "Content-Type": "application/json" };
    const base = `/api/projects/${p!.id}/resources`;
    const post = (body: unknown) =>
      app.request(base, { method: "POST", headers, body: JSON.stringify(body) });
    const put = (id: string, body: unknown) =>
      app.request(`${base}/${id}`, { method: "PUT", headers, body: JSON.stringify(body) });

    try {
      // Empty list first — {resources: [], total: 0}, not an error.
      const empty = await app.request(base, { headers });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ resources: [], total: 0 });

      // ── Create github_repo: trims, drops unknown ref fields, appends ────
      const createA = await post({
        resource_type: "github_repo",
        resource_ref: {
          url: "  https://github.com/acme/app.git  ",
          default_branch_hint: " main ",
          junk: "dropped",
        },
        label: "  Repo  ",
      });
      expect(createA.status).toBe(201);
      const a = (await createA.json()) as ResourceResponse;
      expect(a.resource_type).toBe("github_repo");
      // Normalized: only known fields survive, trimmed.
      expect(a.resource_ref).toEqual({
        url: "https://github.com/acme/app.git",
        default_branch_hint: "main",
      });
      expect(a.label).toBe("Repo");
      expect(a.position).toBe(0);
      expect(a.project_id).toBe(p!.id);
      expect(a.workspace_id).toBe(ws!.id);
      expect(a.created_by).toBe(u!.id);
      expect(a.created_at).toBeTruthy();

      // Exact duplicate ref → DB unique violation mapped to 409.
      const dup = await post({
        resource_type: "github_repo",
        resource_ref: { url: "https://github.com/acme/app.git", default_branch_hint: "main" },
      });
      expect(dup.status).toBe(409);

      // ── Create local_directory (scp-style daemon pinning) ───────────────
      const createB = await post({
        resource_type: "local_directory",
        resource_ref: { local_path: " /Users/dev/proj ", daemon_id: " daemon-1 ", label: "Mac" },
      });
      expect(createB.status).toBe(201);
      const b = (await createB.json()) as ResourceResponse;
      expect(b.resource_ref).toEqual({
        local_path: "/Users/dev/proj",
        daemon_id: "daemon-1",
        label: "Mac",
      });
      expect(b.label).toBeNull(); // row-level label was not sent
      expect(b.position).toBe(1); // appended after existing

      // Second local_directory on the SAME daemon → app-level 409 (the DB
      // unique constraint wouldn't fire: different local_path).
      const sameDaemon = await post({
        resource_type: "local_directory",
        resource_ref: { local_path: "/Users/dev/other", daemon_id: "daemon-1" },
      });
      expect(sameDaemon.status).toBe(409);
      expect(((await sameDaemon.json()) as { error: string }).error).toContain(
        "already has a local_directory",
      );

      // A different daemon may carry its own local_directory.
      const createD = await post({
        resource_type: "local_directory",
        resource_ref: { local_path: "C:\\work\\proj", daemon_id: "daemon-2" },
      });
      expect(createD.status).toBe(201);
      const d = (await createD.json()) as ResourceResponse;
      expect(d.position).toBe(2);

      // scp-like git URL is accepted.
      const scp = await post({
        resource_type: "github_repo",
        resource_ref: { url: "git@github.com:acme/app.git" },
      });
      expect(scp.status).toBe(201);
      const scpRow = (await scp.json()) as ResourceResponse;
      expect(scpRow.resource_ref).toEqual({ url: "git@github.com:acme/app.git" });

      // ── Validation 400s ─────────────────────────────────────────────────
      const cases: Array<[unknown, string]> = [
        [{ resource_ref: { url: "https://x.com/r" } }, "resource_type is required"],
        [{ resource_type: "s3_bucket", resource_ref: {} }, 'unknown resource_type "s3_bucket"'],
        [{ resource_type: "github_repo" }, "resource_ref is required"],
        [{ resource_type: "github_repo", resource_ref: { url: "not-a-url" } }, "github_repo: url must be a valid http(s) or ssh git URL"],
        [{ resource_type: "github_repo", resource_ref: { url: 42 } }, "invalid github_repo payload"],
        [{ resource_type: "local_directory", resource_ref: { local_path: "relative/path", daemon_id: "d" } }, "local_directory: local_path must be an absolute path"],
        [{ resource_type: "local_directory", resource_ref: { local_path: "/abs/path" } }, "local_directory: daemon_id is required"],
      ];
      for (const [body, message] of cases) {
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe(message);
      }

      // List reflects all four rows ordered by position.
      const list = await app.request(base, { headers });
      const listBody = (await list.json()) as { resources: ResourceResponse[]; total: number };
      expect(listBody.total).toBe(4);
      expect(listBody.resources.map((r) => r.position)).toEqual([0, 1, 2, 3]);

      // ── Update semantics ────────────────────────────────────────────────
      // Patch label + position; ref untouched.
      const upd1 = await put(a.id, { label: "Pinned", position: 9 });
      expect(upd1.status).toBe(200);
      const upd1Body = (await upd1.json()) as ResourceResponse;
      expect(upd1Body.label).toBe("Pinned");
      expect(upd1Body.position).toBe(9);
      expect(upd1Body.resource_ref).toEqual({
        url: "https://github.com/acme/app.git",
        default_branch_hint: "main",
      });

      // Explicit null clears the label; null position keeps the current one.
      const upd2 = await put(a.id, { label: null, position: null });
      expect(upd2.status).toBe(200);
      const upd2Body = (await upd2.json()) as ResourceResponse;
      expect(upd2Body.label).toBeNull();
      expect(upd2Body.position).toBe(9);

      // Re-point the ref (re-validated under the EXISTING type; hint dropped).
      const upd3 = await put(a.id, { resource_ref: { url: "https://github.com/acme/other.git" } });
      expect(upd3.status).toBe(200);
      expect(((await upd3.json()) as ResourceResponse).resource_ref).toEqual({
        url: "https://github.com/acme/other.git",
      });

      // Type errors.
      const badLabel = await put(a.id, { label: 42 });
      expect(badLabel.status).toBe(400);
      expect(((await badLabel.json()) as { error: string }).error).toBe(
        "label must be a string or null",
      );
      const badPos = await put(a.id, { position: 1.5 });
      expect(badPos.status).toBe(400);
      expect(((await badPos.json()) as { error: string }).error).toBe(
        "position must be an integer",
      );

      // Moving B onto daemon-2 collides with D → 409.
      const moveB = await put(b.id, {
        resource_ref: { local_path: "/Users/dev/proj", daemon_id: "daemon-2" },
      });
      expect(moveB.status).toBe(409);
      expect(((await moveB.json()) as { error: string }).error).toContain(
        "another local_directory on this daemon",
      );

      // Unknown / malformed resource ids.
      const updMissing = await put("11111111-1111-4111-8111-111111111111", { label: "x" });
      expect(updMissing.status).toBe(404);
      const updBadId = await put("not-a-uuid", { label: "x" });
      expect(updBadId.status).toBe(400);

      // ── Delete ──────────────────────────────────────────────────────────
      const del = await app.request(`${base}/${d.id}`, { method: "DELETE", headers });
      expect(del.status).toBe(204);
      const afterDel = await app.request(base, { headers });
      expect(((await afterDel.json()) as { total: number }).total).toBe(3);
      const delAgain = await app.request(`${base}/${d.id}`, { method: "DELETE", headers });
      expect(delAgain.status).toBe(404);

      // ── Gates ───────────────────────────────────────────────────────────
      const noWs = await app.request(base);
      expect(noWs.status).toBe(400);
      const foreign = await app.request(base, {
        headers: { "X-Workspace-ID": "99999999-9999-4999-8999-999999999999" },
      });
      expect(foreign.status).toBe(404);
      const badProject = await app.request("/api/projects/not-a-uuid/resources", { headers });
      expect(badProject.status).toBe(400);
      const ghostProject = await app.request(
        "/api/projects/11111111-1111-4111-8111-111111111111/resources",
        { headers },
      );
      expect(ghostProject.status).toBe(404);
    } finally {
      await db.delete(projectResource).where(eq(projectResource.projectId, p!.id));
      await db.delete(project).where(eq(project.id, p!.id));
      await db.delete(member).where(eq(member.workspaceId, ws!.id));
      await db.delete(workspace).where(eq(workspace.id, ws!.id));
      await db.delete(user).where(eq(user.id, u!.id));
      await close();
    }
  },
);
