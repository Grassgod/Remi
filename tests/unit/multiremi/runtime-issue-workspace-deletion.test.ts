import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !pgUrl)(`MUL-467 Runtime Issue workspace lifecycle (${dialect})`, () => {
    let db: Database | PostgresSyncDatabase;
    let store: MultiremiStore;
    let workspaceId: string;
    let sequence = 0;
    let admin: Bun.SQL | undefined;
    const databaseName = `mul467_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

    beforeAll(async () => {
      if (dialect === "postgres") {
        admin = new Bun.SQL(pgUrl!, { max: 1 });
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(pgUrl!);
        url.pathname = `/${databaseName}`;
        db = new PostgresSyncDatabase(url.toString());
      } else {
        db = new Database(":memory:");
      }
      store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
    });

    beforeEach(() => {
      workspaceId = store.createWorkspace({
        name: `MUL-467 ${dialect} ${++sequence}`,
        slug: `mul467-${dialect}-${sequence}`,
      }).id;
    });

    afterAll(async () => {
      db?.close();
      await admin?.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin?.end();
    });

    function runtime(suffix = "source") {
      return store.registerRuntime({
        id: `rt_${workspaceId}_${suffix}`, name: suffix, provider: "codex", workspaceId,
      });
    }

    function issueOn(runtimeId: string) {
      const issue = store.createIssue({ title: "Workspace at risk", workspaceId });
      store.reportIssueWorkspace({
        issueId: issue.id, runtimeId, rootPath: `/work/${issue.key}`,
        branchName: `agent/${issue.key}`, status: "ready",
      });
      return issue;
    }

    function assertNoOrphanedWorkspaces() {
      expect(db.query(
        "SELECT issue_id FROM multiremi_issue_workspaces WHERE workspace_id = ? AND runtime_id IS NULL AND status != 'cleaned'",
      ).all(workspaceId)).toEqual([]);
    }

    function request(path: string, method: string, body?: unknown) {
      return createMultiremiApp({ store, authToken: "mul467-root" }).request(path, {
        method, headers: { Authorization: "Bearer mul467-root", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    it.each(["preparing", "ready", "in_use", "dirty", "error", "runtime_offline"])(
      "blocks every uncleaned %s workspace without changing the Runtime graph",
      async (status) => {
        const source = runtime();
        const issue = issueOn(source.id);
        db.run("UPDATE multiremi_issue_workspaces SET status = ? WHERE issue_id = ?", [status, issue.id]);
        const archived = store.createAgent({ name: "Archived", provider: "codex", runtimeId: source.id, workspaceId });
        const project = store.createProject({ title: "Keep defaults", workspaceId,
          defaultAssigneeType: "agent", defaultAssigneeId: archived.id });
        const autopilot = store.createAutopilot({ title: "Keep automation", workspaceId,
          assigneeId: archived.id, executionMode: "run_only", status: "active" });
        store.archiveAgent(archived.id);
        const before = {
          runtime: store.getRuntime(source.id), agent: store.getAgent(archived.id),
          project: store.getProject(project.id), autopilot: store.getAutopilot(autopilot.id),
          workspace: store.getIssueWorkspace(issue.id),
        };
        expect(store.deleteRuntime(source.id)).toBe(false);
        const response = await request(`/api/runtimes/${source.id}`, "DELETE");
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "runtime_has_active_issue_workspaces",
          issues: [{ id: issue.id, key: issue.key, title: issue.title, status }],
        });
        expect({
          runtime: store.getRuntime(source.id), agent: store.getAgent(archived.id),
          project: store.getProject(project.id), autopilot: store.getAutopilot(autopilot.id),
          workspace: store.getIssueWorkspace(issue.id),
        }).toEqual(before);
        assertNoOrphanedWorkspaces();
      },
    );

    it("explicitly abandons active records and only detaches already cleaned records", async () => {
      const source = runtime();
      const active = issueOn(source.id);
      const cleaned = issueOn(source.id);
      const cleanedAt = "2026-01-01T00:00:00.000Z";
      db.run("UPDATE multiremi_issue_workspaces SET status = 'cleaned', cleaned_at = ? WHERE issue_id = ?", [cleanedAt, cleaned.id]);
      const invalid = await request(`/api/runtimes/${source.id}?abandon_issue_workspaces=1`, "DELETE");
      expect(invalid.status).toBe(400);
      expect(store.getIssueWorkspace(active.id)?.status).toBe("ready");
      const response = await request(`/api/runtimes/${source.id}?abandon_issue_workspaces=true`, "DELETE");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", issue_workspaces_abandoned: 1 });
      expect(store.getRuntime(source.id)).toBeNull();
      expect(store.getIssueWorkspace(active.id)).toMatchObject({ runtimeId: null, status: "cleaned" });
      expect(store.getIssueWorkspace(active.id)?.cleanedAt).not.toBeNull();
      expect(store.getIssueWorkspace(cleaned.id)).toMatchObject({ runtimeId: null, status: "cleaned", cleanedAt });
      assertNoOrphanedWorkspaces();
    });

    it("keeps the active-task guard ahead of abandonment and all mutations", async () => {
      const source = runtime();
      const issue = issueOn(source.id);
      const agent = store.createAgent({ name: "Worker", provider: "codex", workspaceId });
      const task = store.createTask({ agentId: agent.id, runtimeId: source.id, prompt: "In flight" });
      expect(store.claimTask(source.id)?.id).toBe(task.id);
      store.startTask(task.id);
      const response = await request(`/api/runtimes/${source.id}?abandon_issue_workspaces=true`, "DELETE");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "runtime_has_active_tasks" });
      expect(store.getTask(task.id)?.status).toBe("running");
      expect(store.getIssueWorkspace(issue.id)).toMatchObject({ status: "ready", runtimeId: source.id, cleanedAt: null });
      assertNoOrphanedWorkspaces();
    });

    it("refuses the cascade before archiving or cancelling, then abandons on explicit confirmation", async () => {
      const source = runtime();
      const issue = issueOn(source.id);
      const agent = store.createAgent({ name: "Bound worker", provider: "codex", runtimeId: source.id, workspaceId });
      const task = store.createTask({ agentId: agent.id, runtimeId: source.id, prompt: "Queued work" });
      const path = `/api/runtimes/${source.id}/archive-agents-and-delete`;
      const body = { expected_active_agent_ids: [agent.id] };
      const invalid = await request(path, "POST", { ...body, abandon_issue_workspaces: "true" });
      expect(invalid.status).toBe(400);
      const refused = await request(path, "POST", body);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "runtime_has_active_issue_workspaces" });
      expect(store.getAgent(agent.id)).toMatchObject({ runtimeId: source.id, archivedAt: null });
      expect(store.getTask(task.id)?.status).toBe("queued");
      expect(store.getIssueWorkspace(issue.id)?.status).toBe("ready");
      const response = await request(path, "POST", { ...body, abandon_issue_workspaces: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", agents_archived: 1, tasks_cancelled: 1, issue_workspaces_abandoned: 1 });
      expect(store.getAgent(agent.id)?.archivedAt).not.toBeNull();
      expect(store.getTask(task.id)?.status).toBe("cancelled");
      expect(store.getIssueWorkspace(issue.id)).toMatchObject({ runtimeId: null, status: "cleaned" });
      assertNoOrphanedWorkspaces();
    });

    it("moves active workspaces before deleting a migrated Runtime and preserves task eligibility", () => {
      const source = runtime();
      const target = runtime("target");
      const issue = issueOn(source.id);
      const agent = store.createAgent({ name: "Migration worker", provider: "codex", workspaceId });
      const task = store.createTask({ issueId: issue.id, agentId: agent.id, runtimeId: source.id, prompt: "Migrate" });
      const before = store.getIssueWorkspace(issue.id)!;
      expect(store.mergeRuntimeInto(source.id, target.id).deleted).toBe(true);
      expect(store.getRuntime(source.id)).toBeNull();
      expect(store.getIssueWorkspace(issue.id)).toMatchObject({
        runtimeId: target.id, status: "ready", cleanedAt: null, rootPath: before.rootPath, branchName: before.branchName,
      });
      expect(store.claimTask(target.id)?.id).toBe(task.id);
      assertNoOrphanedWorkspaces();
    });

    it("recovers a historical orphan through the API so its queued task can be claimed", async () => {
      const source = runtime();
      const issue = issueOn(source.id);
      // Seed the pre-fix deletion outcome; guarded deletion can no longer produce it.
      db.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL, status = 'runtime_offline' WHERE issue_id = ?", [issue.id]);
      db.run("DELETE FROM multiremi_runtimes WHERE id = ?", [source.id]);
      const target = runtime("recovery");
      const agent = store.createAgent({ name: "Recovery worker", provider: "codex", workspaceId });
      const task = store.createTask({ issueId: issue.id, agentId: agent.id, prompt: "Recover original request" });
      expect(store.claimTask(target.id)).toBeNull();
      const before = store.getIssueWorkspace(issue.id)!;
      const response = await request(`/api/issues/${issue.id}/workspace/abandon`, "POST");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", issue_workspaces_abandoned: 1,
        workspace: { runtime_id: null, status: "cleaned" } });
      expect(store.getIssueWorkspace(issue.id)).toMatchObject({ rootPath: before.rootPath, repos: before.repos });
      const repeated = await request(`/api/issues/${issue.key}/workspace/abandon?workspace_id=${workspaceId}`, "POST");
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ issue_workspaces_abandoned: 0 });
      expect(store.getIssueWorkspace(issue.id)?.cleanedAt).toBe(store.getIssueWorkspace(issue.id)?.updatedAt);
      expect(store.claimTask(target.id)?.id).toBe(task.id);
      expect(store.getTask(task.id)?.prompt).toBe("Recover original request");
      assertNoOrphanedWorkspaces();
    });

    it("rejects attached workspaces even when their Runtime is offline", async () => {
      const source = runtime();
      const issue = issueOn(source.id);
      store.setRuntimeOffline(source.id);
      const response = await request(`/api/issues/${issue.id}/workspace/abandon`, "POST");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "issue_workspace_runtime_attached", runtime_id: source.id });
      expect(store.getIssueWorkspace(issue.id)).toMatchObject({ status: "ready", runtimeId: source.id, cleanedAt: null });
      db.run("UPDATE multiremi_issue_workspaces SET runtime_id = '' WHERE issue_id = ?", [issue.id]);
      expect(store.abandonIssueWorkspace(issue.id, workspaceId)).toEqual({ status: "runtime_attached", runtimeId: "" });
      expect(store.getIssueWorkspace(issue.id)?.status).toBe("ready");
    });

    it("enforces Issue write permissions for cross-workspace credentials, nonmembers and daemons", async () => {
      const source = runtime();
      const issue = issueOn(source.id);
      db.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL, status = 'runtime_offline' WHERE issue_id = ?", [issue.id]);
      const owner = store.getOrCreateUser({ email: `owner-${workspaceId}@example.test`, name: "Issue member" });
      const outsider = store.getOrCreateUser({ email: `outsider-${workspaceId}@example.test`, name: "Nonmember" });
      store.createWorkspaceMember({ workspaceId, userId: owner.id, name: owner.name, role: "member" });
      const allowed = await store.createAccessToken({ type: "pat", purpose: "session", userId: owner.id, workspaceId, name: "Member" });
      const deniedUser = await store.createAccessToken({ type: "pat", purpose: "session", userId: outsider.id, workspaceId, name: "Outsider" });
      const crossWorkspace = await store.createAccessToken({ type: "pat", workspaceId: "local", name: "Other workspace" });
      const daemon = await store.createAccessToken({ type: "daemon", workspaceId, daemonId: "other-daemon", name: "Daemon" });
      const app = createMultiremiApp({ store, authToken: "mul467-root" });
      const path = `/api/issues/${issue.id}/workspace/abandon`;
      for (const [credential, expectedStatus] of [[deniedUser, 404], [crossWorkspace, 404], [daemon, 403]] as const) {
        const response = await app.request(path, { method: "POST", headers: { Authorization: `Bearer ${credential.token}` } });
        expect(response.status).toBe(expectedStatus);
        expect(store.getIssueWorkspace(issue.id)?.status).toBe("runtime_offline");
      }
      expect(store.abandonIssueWorkspace(issue.id, "local")).toEqual({ status: "not_found" });
      const response = await app.request(path, { method: "POST", headers: { Authorization: `Bearer ${allowed.token}` } });
      expect(response.status).toBe(200);
      assertNoOrphanedWorkspaces();
    });
  });
}
