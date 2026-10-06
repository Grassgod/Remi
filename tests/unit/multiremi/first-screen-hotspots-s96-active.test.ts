import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { canCurrentUserAccessChatTask, denyCurrentUserWorkspaceAccess, issueFromParam } from "@multiremi/api/helpers.js";
import { taskCompatibilityResponse } from "@multiremi/api/wire/tasks.js";
import { MultiremiStore } from "@multiremi/store.js";
import { ACTIVE_TASK_STATUSES } from "@multiremi/store/helpers.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database";
import { seedFirstScreenHotspotsFixture } from "../../fixtures/multiremi/first-screen-hotspots-fixture";
import { firstScreenTaskUsage, seedFirstScreenTaskUsage } from "../../fixtures/multiremi/first-screen-task-usage-fixture";

const resources: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
afterEach(async () => { for (const resource of resources.splice(0)) await resource.dispose(); });

describe("S9-6 active-task SQL selection / public projection", () => {
  it("matches the old full-task route for all states, Chat permissions, ordering and blockers", async () => {
    const resource = await openHotspotDatabase(); resources.push(resource);
    const store = new MultiremiStore(resource.db);
    const fixture = seedFirstScreenHotspotsFixture(store, { sessions: 3, agents: 3, issues: 2, inboxRows: 0, run: (sql, params) => resource.db.run(sql, params) });
    const issue = fixture.issueIds[0]!;
    const statuses = [...ACTIVE_TASK_STATUSES, "completed", "failed", "cancelled"];
    for (const [index, status] of statuses.entries()) {
      const task = store.createTask({ id: `tsk_active_${index}`, agentId: fixture.agentIds[1]!, issueId: issue, prompt: `full prompt ${index}` });
      resource.db.run("UPDATE multiremi_tasks SET status = ?, result = ?, codex_profile = ?, plugin_snapshot = ?, usage = ?, created_at = ? WHERE id = ?", [status, JSON.stringify({ full: index }), '{"private":"fixture"}', '[]', '[]', `2026-10-01T00:00:0${index}.000Z`, task.id]);
      seedFirstScreenTaskUsage(store, task.id);
    }
    for (const taskId of fixture.taskIds) resource.db.run("UPDATE multiremi_tasks SET issue_id = ? WHERE id = ?", [issue, taskId]);
    seedFirstScreenTaskUsage(store, fixture.taskIds[0]!);
    const foreign = store.createWorkspace({ id: "ws_active_foreign", name: "Foreign" });
    const foreignIssue = store.createIssue({ id: "iss_active_foreign", title: "Foreign", workspaceId: foreign.id });
    resource.db.run("UPDATE multiremi_tasks SET workspace_id = ? WHERE id = ?", [foreign.id, fixture.taskIds.at(-1)!]);
    const owner = await store.createAccessToken({ name: "active owner", type: "pat", userId: fixture.ownerUserId, workspaceId: "local" });
    const reader = await store.createAccessToken({ name: "active reader", type: "pat", userId: fixture.readerUserId, workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "active-fixture-root" });
    const optimized = store.listActiveTasksForIssue.bind(store);
    expect(optimized(issue, { userId: fixture.ownerUserId }).find(task => task.id === "tsk_active_0")?.usage).toEqual(firstScreenTaskUsage);
    app.get("/api/s96-legacy-active/:id", c => {
      const issue = issueFromParam(store, c, "id", "compat");
      if (!issue) return c.json({ error: "issue not found" }, 404);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId); if (denied) return denied;
      return c.json({ tasks: store.listTasksForIssue(issue.id)
        .filter(task => (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status) && canCurrentUserAccessChatTask(c, store, task))
        .map(task => taskCompatibilityResponse(task, null, task.status === "queued" || task.status === "dispatched" ? store.getTaskQueueBlocker(task.id) : null)) });
    });
    const chatTask = store.getTask(fixture.taskIds[0]!)!;
    const taskTokens: string[] = [];
    for (const binding of [
      { taskId: chatTask.id, agentId: chatTask.agentId, workspaceId: chatTask.workspaceId },
      { taskId: "missing", agentId: chatTask.agentId, workspaceId: chatTask.workspaceId },
      { taskId: chatTask.id, agentId: "missing", workspaceId: chatTask.workspaceId },
    ]) taskTokens.push((await store.createAccessToken({ name: "active task credential", type: "task", userId: fixture.ownerUserId, ...binding })).token);
    for (const token of [owner.token, reader.token, "active-fixture-root", ...taskTokens]) {
      for (const id of [issue, fixture.issueIds[1]!, foreignIssue.id, "iss_nonexistent"]) {
        const read = () => app.request(`/api/issues/${id}/active-task`, { headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": "local" } });
        const actual = await read();
        const legacy = await app.request(`/api/s96-legacy-active/${id}`, { headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": "local" } });
        expect(actual.status).toBe(legacy.status);
        expect(await actual.json()).toEqual(await legacy.json());
      }
    }
    // Large private payloads, obsolete usage JSON and terminal rows must not cross the task read.
    let taskBytes = 0;
    const originalQuery = resource.db.query.bind(resource.db);
    resource.db.query = ((sql: string) => {
      const statement = originalQuery(sql);
      if (!sql.includes("FROM multiremi_tasks task")) return statement;
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "all") return (...params: unknown[]) => { const rows = value.apply(target, params); taskBytes += Buffer.byteLength(JSON.stringify(rows)); return rows; };
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof resource.db.query;
    optimized(issue, { userId: fixture.ownerUserId }); const small = taskBytes;
    resource.db.run("UPDATE multiremi_tasks SET codex_profile = ?", [JSON.stringify({ padding: "x".repeat(65536) })]);
    resource.db.run("UPDATE multiremi_tasks SET usage = ?", [JSON.stringify([{ provider: "claude", model: "legacy-decoy",
      inputTokens: 999_999, outputTokens: 0, padding: "x".repeat(65_536) }])]);
    taskBytes = 0; optimized(issue, { userId: fixture.ownerUserId });
    expect(taskBytes).toBe(small);
    expect(optimized(issue, { userId: fixture.ownerUserId }).find(task => task.id === "tsk_active_0")?.usage).toEqual(firstScreenTaskUsage);
    resource.db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE issue_id = ?", [issue]);
    expect(optimized(issue, { userId: fixture.ownerUserId })).toEqual([]);
  }, 30_000);
});
