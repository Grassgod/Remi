import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !adminUrl)(`Project execution defaults (${backend})`, () => {
    async function run(check: (store: MultiremiStore, db: SqlDatabase) => Promise<void>) {
      let db: SqlDatabase | undefined;
      const admin = backend === "postgres" ? new Bun.SQL(adminUrl!, { max: 1 }) : null;
      const databaseName = `project_defaults_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
      let created = false;
      try {
        if (admin) {
          await admin.unsafe(`CREATE DATABASE ${databaseName}`);
          created = true;
          const url = new URL(adminUrl!);
          url.pathname = `/${databaseName}`;
          db = new PostgresSyncDatabase(url.toString());
        } else db = openSqliteDatabase(":memory:") as unknown as SqlDatabase;
        const store = new MultiremiStore(db);
        store.ensureLocalWorkspace();
        await check(store, db);
      } finally {
        db?.close();
        if (created) await admin!.unsafe(`DROP DATABASE ${databaseName}`);
        await admin?.end();
      }
    }

    async function fixture(store: MultiremiStore) {
      const user = store.getOrCreateUser({ email: "project-human@example.test", name: "Project human" });
      const human = store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
      const { token } = await store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Project member", type: "pat", purpose: "session" });
      const agent = store.createAgent({ name: "Execution Agent", provider: "claude" });
      const squad = store.createSquad({ name: "Execution Squad", leaderId: agent.id });
      const app = createMultiremiApp({ store, authToken: "synthetic-project-defaults-master" });
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const request = (path: string, method: string, body?: unknown) => app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { human, agent, squad, request };
    }

    it("rejects explicit and inferred member defaults on both APIs, while Agent/Squad defaults reach real Issue creation", () => run(async (store) => {
      const f = await fixture(store);
      for (const prefix of ["/api", "/api/multiremi"]) {
        for (const fields of [
          { default_assignee_type: "member", default_assignee_id: f.human.id },
          prefix === "/api" ? { default_assignee_id: f.human.id } : { defaultAssigneeId: f.human.id },
        ]) {
          const before = store.listProjects().length;
          const rejected = await f.request(`${prefix}/projects`, "POST", { title: "Rejected member default", ...fields });
          expect(rejected.status).toBe(409);
          expect(await rejected.json()).toMatchObject({ code: "project_execution_owner_required" });
          expect(store.listProjects()).toHaveLength(before);
        }
        for (const [type, id] of [["agent", f.agent.id], ["squad", f.squad.id]] as const) {
          const created = await f.request(`${prefix}/projects`, "POST", { title: `${type} default`, default_assignee_type: type, default_assignee_id: id });
          expect(created.status).toBe(201);
          const body = await created.json() as any;
          const projectId = body.id ?? body.project.id;
          const issueResponse = await f.request("/api/issues", "POST", { title: `${type} project Issue`, project_id: projectId, status: "backlog" });
          expect(issueResponse.status).toBe(201);
          const issue = await issueResponse.json() as any;
          expect(issue).toMatchObject({ assignee_type: type, assignee_id: id, responsible_member_id: f.human.id });
          expect(store.resolveIssueResponsibility(issue.id).executionOwner?.id).toBe(f.agent.id);
        }
      }
    }));

    it("retains historical member facts during unrelated edits, then permits explicit clear or Agent replacement", () => run(async (store, db) => {
      const f = await fixture(store);
      for (const prefix of ["/api", "/api/multiremi"]) {
        const project = store.createProject({ title: "Historical project" });
        db.run("UPDATE multiremi_projects SET default_assignee_type='member', default_assignee_id=? WHERE id=?", [f.human.id, project.id]);
        const method = prefix === "/api" ? "PUT" : "PATCH";
        const path = `${prefix}/projects/${project.id}`;
        const read = await f.request(path, "GET");
        expect(read.status).toBe(200);
        const readBody = await read.json() as any;
        expect(readBody.project ?? readBody).toMatchObject(prefix === "/api"
          ? { default_assignee_type: "member", default_assignee_id: f.human.id }
          : { defaultAssigneeType: "member", defaultAssigneeId: f.human.id });
        const renamed = await f.request(path, method, { title: "Historical facts retained" });
        expect(renamed.status).toBe(200);
        expect(store.getProject(project.id)).toMatchObject({ title: "Historical facts retained", defaultAssigneeType: "member", defaultAssigneeId: f.human.id });
        const rejected = await f.request(path, method, { title: "Must roll back", default_assignee_type: "member", default_assignee_id: f.human.id });
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ code: "project_execution_owner_required" });
        expect(store.getProject(project.id)?.title).toBe("Historical facts retained");
        const inherited = await f.request("/api/issues", "POST", { title: "Legacy default needs configuration", project_id: project.id, status: "backlog" });
        expect(inherited.status).toBe(201);
        const issue = await inherited.json() as any;
        expect(issue).toMatchObject({ assignee_type: null, assignee_id: null, responsible_member_id: f.human.id });
        expect(store.resolveIssueResponsibility(issue.id).unresolved).toContainEqual({ issueId: issue.id, reason: "execution_owner_missing" });
        const cleared = await f.request(path, method, { default_assignee_type: null, default_assignee_id: null });
        expect(cleared.status).toBe(200);
        expect(store.getProject(project.id)).toMatchObject({ defaultAssigneeType: null, defaultAssigneeId: null });
        const configured = await f.request(path, method, { default_assignee_type: "agent", default_assignee_id: f.agent.id });
        expect(configured.status).toBe(200);
        const restored = await f.request("/api/issues", "POST", { title: "Configured execution", project_id: project.id, status: "backlog" });
        expect(restored.status).toBe(201);
        expect(await restored.json()).toMatchObject({ assignee_type: "agent", assignee_id: f.agent.id, responsible_member_id: f.human.id });
      }
    }));
  });
}
