import { afterEach, expect, test } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { taskPublicResponse } from "../../../packages/server/src/api/wire/tasks.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { seedFirstScreenHotspotsFixture } from "../../fixtures/multiremi/first-screen-hotspots-fixture.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

const databases: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
afterEach(async () => { for (const database of databases.splice(0)) await database.dispose(); });

async function fixture() {
  const database = await openHotspotDatabase();
  databases.push(database);
  let bytes = 0;
  const queries: string[] = [];
  const db = new Proxy(database.db, {
    get(target, key) {
      if (key === "query" || key === "prepare") return (sql: string) => {
        const statement = target[key](sql);
        return new Proxy(statement, { get(st, method) {
          const value = Reflect.get(st, method);
          if (method === "all" || method === "get") return (...args: unknown[]) => {
            const result = value.apply(st, args);
            bytes += Buffer.byteLength(JSON.stringify(result));
            queries.push(sql);
            return result;
          };
          return typeof value === "function" ? value.bind(st) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqlDatabase;
  const store = new MultiremiStore(db);
  const seed = seedFirstScreenHotspotsFixture(store, { sessions: 100, agents: 3, inboxRows: 0, issues: 0,
    taskPromptBytes: 2048, skillBodyBytes: 4096, run: (sql, params) => db.run(sql, params) });
  return { db, store, seed, queries, reset() { bytes = 0; queries.length = 0; }, bytes: () => bytes };
}

test("snapshot filters Chat before hydration and preserves complete public rows for both identities", async () => {
  const f = await fixture();
  const nonChat = f.store.createTask({ agentId: f.seed.primaryAgentId, prompt: "workspace task" });
  const all = f.store.listWorkspaceAgentTaskSnapshot("local");
  for (const userId of [f.seed.readerUserId, f.seed.ownerUserId, null]) {
    const expected = all.filter((task) => !task.chatSessionId ||
      (f.store.getChatSession(task.chatSessionId) != null &&
        (userId === null || f.store.getChatSession(task.chatSessionId)!.creatorId === userId))).map(taskPublicResponse);
    f.reset();
    const actual = f.store.listWorkspaceAgentTaskSnapshot("local", { userId }).map(taskPublicResponse);
    expect(actual).toEqual(expected);
    expect(actual.some((task) => task.id === nonChat.id)).toBe(true);
    expect(f.queries.some((sql) => /SELECT task\.\*/.test(sql))).toBe(false);
    expect(f.queries.some((sql) => /codex_profile|claude_profile|delegation_id/.test(sql))).toBe(false);
    if (userId === f.seed.ownerUserId) expect(f.bytes()).toBeLessThan(10_000);
  }
  const task = all.find((row) => row.chatSessionId)!;
  const own = f.store.listWorkspaceAgentTaskSnapshot("local", { userId: f.seed.ownerUserId,
    taskToken: { taskId: task.id, agentId: task.agentId, workspaceId: task.workspaceId } });
  expect(own.filter((row) => row.chatSessionId).map((row) => row.id)).toEqual([task.id]);
  const mismatch = f.store.listWorkspaceAgentTaskSnapshot("local", { userId: f.seed.readerUserId,
    taskToken: { taskId: task.id, agentId: "wrong", workspaceId: task.workspaceId } });
  expect(mismatch.filter((row) => row.chatSessionId)).toEqual([]);
  f.db.run("UPDATE multiremi_chat_sessions SET creator_id = NULL WHERE id = ?", [task.chatSessionId]);
  expect(f.store.listWorkspaceAgentTaskSnapshot("local", { userId: "local" }).some((row) => row.id === task.id)).toBe(true);
  f.db.run("UPDATE multiremi_tasks SET chat_session_id = 'missing' WHERE id = ?", [task.id]);
  expect(f.store.listWorkspaceAgentTaskSnapshot("local", { userId: null }).some((row) => row.id === task.id)).toBe(false);
  f.db.run("UPDATE multiremi_tasks SET chat_session_id = '' WHERE id = ?", [task.id]);
  expect(f.store.listWorkspaceAgentTaskSnapshot("local", { userId: f.seed.ownerUserId }).some((row) => row.id === task.id)).toBe(true);
  // Invisible prompt/result and private profiles cannot increase bridge bytes.
  f.reset();
  const baseline = f.store.listWorkspaceAgentTaskSnapshot("local", { userId: f.seed.ownerUserId }).map(taskPublicResponse);
  const baselineBytes = f.bytes();
  f.db.run("UPDATE multiremi_tasks SET prompt = ?, result = ?, codex_profile = ? WHERE chat_session_id IN (SELECT id FROM multiremi_chat_sessions WHERE creator_id = ?)",
    ["p".repeat(16_384), "r".repeat(16_384), JSON.stringify({ large: "x".repeat(16_384) }), f.seed.readerUserId]);
  f.reset();
  expect(f.store.listWorkspaceAgentTaskSnapshot("local", { userId: f.seed.ownerUserId }).map(taskPublicResponse)).toEqual(baseline);
  expect(f.bytes()).toBe(baselineBytes);
  f.reset();
  expect(f.store.listWorkspaceAgentTaskSnapshot("local", { userId: "no-chat-access" })).toHaveLength(2);
  expect(f.bytes()).toBeLessThan(10_000);
  f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE chat_session_id IS NULL OR chat_session_id = ''");
  f.reset();
  expect(f.store.listWorkspaceAgentTaskSnapshot("local", { userId: "no-chat-access" })).toEqual([]);
  expect(f.bytes()).toBeLessThan(100);
}, 20000);

test("invisible latest outcome does not promote older visible outcome; missing chats stay invisible", async () => {
  const f = await fixture();
  const visible = f.store.createTask({ agentId: f.seed.primaryAgentId, prompt: "older outcome" });
  const hidden = f.store.listWorkspaceAgentTaskSnapshot("local").find((row) =>
    row.agentId === f.seed.primaryAgentId && row.chatSessionId === f.seed.sessionIds[0])!;
  f.db.run("UPDATE multiremi_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
    ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", visible.id]);
  f.db.run("UPDATE multiremi_tasks SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ?",
    ["2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", hidden.id]);
  const snapshot = f.store.listWorkspaceAgentTaskSnapshot("local", { userId: f.seed.ownerUserId });
  expect(snapshot.some((task) => task.id === visible.id || task.id === hidden.id)).toBe(false);
  f.db.run("UPDATE multiremi_tasks SET chat_session_id = 'cht_missing' WHERE id = ?", [visible.id]);
  expect(f.store.listWorkspaceAgentTaskSnapshot("local", { userId: null }).some((task) => task.id === visible.id)).toBe(false);
}, 20000);

test("both snapshot routes return the same creator-scoped public contract", async () => {
  const f = await fixture();
  const app = createMultiremiApp({ store: f.store, authToken: "snapshot-fixture-master" });
  for (const userId of [f.seed.readerUserId, f.seed.ownerUserId]) {
    const credential = await f.store.createAccessToken({ name: "snapshot fixture", type: "pat", userId, workspaceId: "local" });
    const headers = { Authorization: `Bearer ${credential.token}`, "X-Workspace-ID": "local" };
    const expected = f.store.listWorkspaceAgentTaskSnapshot("local").filter((task) => !task.chatSessionId ||
      f.store.getChatSession(task.chatSessionId)?.creatorId === userId).map(taskPublicResponse);
    for (const path of ["/api/agent-task-snapshot", "/api/multiremi/agent-task-snapshot"]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(path.startsWith("/api/multiremi")
        ? { tasks: expected, total: expected.length } : expected);
    }
  }
  const ownTask = f.store.listWorkspaceAgentTaskSnapshot("local").find((task) => task.chatSessionId)!;
  for (const binding of [
    { taskId: ownTask.id, agentId: ownTask.agentId, workspaceId: "local" },
    { taskId: "missing", agentId: ownTask.agentId, workspaceId: "local" },
    { taskId: ownTask.id, agentId: "missing", workspaceId: "local" },
  ]) {
    const credential = await f.store.createAccessToken({ name: "task snapshot fixture", type: "task", userId: f.seed.ownerUserId, ...binding });
    const response = await app.request("/api/agent-task-snapshot", { headers: {
      Authorization: `Bearer ${credential.token}`, "X-Workspace-ID": "local",
    } });
    expect(response.status).toBe(200);
    const tasks = await response.json() as Array<{ id: string }>;
    expect(tasks.map((task) => task.id)).toEqual(binding.taskId === ownTask.id && binding.agentId === ownTask.agentId ? [ownTask.id] : []);
  }
  f.db.run("UPDATE multiremi_tasks SET status = 'cancelled'");
  const emptyCredential = await f.store.createAccessToken({ name: "empty snapshot fixture", type: "pat", userId: f.seed.readerUserId, workspaceId: "local" });
  for (const path of ["/api/agent-task-snapshot", "/api/multiremi/agent-task-snapshot"]) {
    const response = await app.request(path, { headers: {
      Authorization: `Bearer ${emptyCredential.token}`, "X-Workspace-ID": "local",
    } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(path.startsWith("/api/multiremi") ? { tasks: [], total: 0 } : []);
  }
}, 20000);
