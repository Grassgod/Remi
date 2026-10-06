import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { canCurrentUserAccessChatTask, denyCurrentUserWorkspaceAccess, issueFromParam } from "@multiremi/api/helpers.js";
import { currentRequestUserId, currentTaskAccessToken } from "@multiremi/api/wire/index.js";
import { taskCompatibilityResponse } from "@multiremi/api/wire/tasks.js";
import { MultiremiStore } from "@multiremi/store.js";
import { ACTIVE_TASK_STATUSES } from "@multiremi/store/helpers.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database";
import { seedFirstScreenHotspotsFixture } from "../../fixtures/multiremi/first-screen-hotspots-fixture";
import { firstScreenTaskUsage, seedFirstScreenTaskUsage } from "../../fixtures/multiremi/first-screen-task-usage-fixture";

const resources: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
afterEach(async () => { for (const resource of resources.splice(0)) await resource.dispose(); });

describe("S9-6 active-task SQL selection / public projection", () => {
  it("preserves the active-task Store projection and advertises the retired HTTP route", async () => {
    const resource = await openHotspotDatabase(); resources.push(resource);
    const store = new MultiremiStore(resource.db);
    const mutateExecution = (sql: string, params: unknown[] = []) =>
      runTurnExecutionMutation((store as unknown as { db: SqlDatabase }).db, sql, ...params);
    const fixture = seedFirstScreenHotspotsFixture(store, { sessions: 3, agents: 3, issues: 2, inboxRows: 0, run: (sql, params) => resource.db.run(sql, params) });
    const issue = fixture.issueIds[0]!;
    const statuses = [...ACTIVE_TASK_STATUSES, ...(["completed", "failed", "cancelled"] as const)];
    const activeTaskIds: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const sent = store.sendMessage({ session_id: store.getOrCreateDefaultIssueSession(issue).id,
        sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: fixture.agentIds[1]! },
        message_kind: "request", wake_requested: "now", body_md: `full prompt ${index}`, execution_scope: `active:${index}` });
      const turn = store.getTurn(sent.turn_id!)!, task = store.getTask(turn.current_attempt_id!)!;
      activeTaskIds.push(task.id);
      const reply = store.sendMessage({ session_id: turn.session_id, source_turn_id: turn.id,
        sender: { type: "agent", id: task.agentId }, to: { type: "none" }, message_kind: "reply",
        wake_requested: "inbox_only", body_md: "", visibility: "hidden", metadata: { task_result: { full: index } } });
      resource.db.run("UPDATE multiremi_turns SET reply_message_id = ? WHERE id = ?", [reply.message.id, turn.id]);
      mutateExecution("UPDATE multiremi_turn_execution_records SET status = ?, codex_profile = ?, plugin_snapshot = ?, usage = ?, created_at = ? WHERE id = ?", [status, '{"private":"fixture"}', '[]', '[]', `2026-10-01T00:00:0${index}.000Z`, task.id]);
      seedFirstScreenTaskUsage(store, task.id);
    }
    expect(new Set(activeTaskIds).size).toBe(statuses.length);
    expect(activeTaskIds.map(id => store.getTask(id)!.status)).toEqual(statuses);
    for (const taskId of fixture.taskIds) mutateExecution("UPDATE multiremi_turn_execution_records SET issue_id = ? WHERE id = ?", [issue, taskId]);
    seedFirstScreenTaskUsage(store, fixture.taskIds[0]!);
    const foreign = store.createWorkspace({ id: "ws_active_foreign", name: "Foreign" });
    const foreignIssue = store.createIssue({ id: "iss_active_foreign", title: "Foreign", workspaceId: foreign.id });
    const foreignAgent = store.createAgent({ name: "Foreign worker", provider: "codex", workspaceId: foreign.id });
    const foreignTask = store.createTask({ agentId: foreignAgent.id, issueId: foreignIssue.id,
      prompt: "Foreign work", assignmentAuthorType: "system" });
    expect(store.listTasksForIssue(foreignIssue.id).map(task => task.id)).toEqual([foreignTask.id]);
    const owner = await store.createAccessToken({ name: "active owner", type: "pat", userId: fixture.ownerUserId, workspaceId: "local" });
    const reader = await store.createAccessToken({ name: "active reader", type: "pat", userId: fixture.readerUserId, workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "active-fixture-root" });
    const optimized = store.listActiveTasksForIssue.bind(store);
    expect(optimized(issue, { userId: fixture.ownerUserId }).find(task => task.id === activeTaskIds[0])?.usage).toEqual(firstScreenTaskUsage);
    app.get("/api/s96-store-projection/:id", c => {
      const issue = issueFromParam(store, c, "id", "compat");
      if (!issue) return c.json({ error: "issue not found" }, 404);
      const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId); if (denied) return denied;
      const expected = store.listTasksForIssue(issue.id)
        .filter(task => (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status) && canCurrentUserAccessChatTask(c, store, task))
        .map(task => taskCompatibilityResponse(task, null, task.status === "queued" || task.status === "dispatched" ? store.getTaskQueueBlocker(task.id) : null));
      const actual = optimized(issue.id, { userId: currentRequestUserId(c), taskToken: currentTaskAccessToken(c) ?? undefined })
        .map(task => taskCompatibilityResponse(task, null, task.status === "queued" || task.status === "dispatched" ? store.getTaskQueueBlocker(task.id) : null));
      expect(actual).toEqual(expected);
      return c.json({ tasks: actual });
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
        const headers = { Authorization: `Bearer ${token}`, "X-Workspace-ID": "local" };
        const invalidBinding = taskTokens.slice(1).includes(token);
        const workspaceId = id === foreignIssue.id ? foreign.id : "local";
        const projection = await app.request(`/api/s96-store-projection/${id}?workspace_id=${workspaceId}`, { headers });
        expect(projection.status).toBe(invalidBinding ? 401 : id === "iss_nonexistent" ? 404
          : id === foreignIssue.id && token !== "active-fixture-root" ? 404 : 200);
        const retired = await app.request(`/api/issues/${id}/active-task`, { headers });
        expect(retired.status).toBe(invalidBinding ? 401 : 410);
        expect(await retired.json()).toEqual(invalidBinding ? { error: "unauthorized" }
          : { code: "route_retired", replacement: "remi turn list --issue <issue>" });
      }
    }
    // Large private payloads, obsolete usage JSON and terminal rows must not cross the task read.
    let taskBytes = 0;
    const originalQuery = resource.db.query.bind(resource.db);
    resource.db.query = ((sql: string) => {
      const statement = originalQuery(sql);
      if (!sql.includes("FROM multiremi_turn_execution_records task")) return statement;
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "all") return (...params: unknown[]) => { const rows = value.apply(target, params); taskBytes += Buffer.byteLength(JSON.stringify(rows)); return rows; };
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof resource.db.query;
    optimized(issue, { userId: fixture.ownerUserId }); const small = taskBytes;
    expect(small).toBeGreaterThan(0);
    mutateExecution("UPDATE multiremi_turn_execution_records SET codex_profile = ? WHERE 1 = 1", [JSON.stringify({ padding: "x".repeat(65536) })]);
    mutateExecution("UPDATE multiremi_turn_execution_records SET usage = ? WHERE 1 = 1", [JSON.stringify([{ provider: "claude", model: "legacy-decoy",
      inputTokens: 999_999, outputTokens: 0, padding: "x".repeat(65_536) }])]);
    taskBytes = 0; optimized(issue, { userId: fixture.ownerUserId });
    expect(taskBytes).toBe(small);
    expect(optimized(issue, { userId: fixture.ownerUserId }).find(task => task.id === activeTaskIds[0])?.usage).toEqual(firstScreenTaskUsage);
    mutateExecution("UPDATE multiremi_turn_execution_records SET status = 'completed' WHERE issue_id = ?", [issue]);
    expect(optimized(issue, { userId: fixture.ownerUserId })).toEqual([]);
  }, 30_000);
});
