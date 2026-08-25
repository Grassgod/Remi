import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("POST /api/multiremi/issues/:id/retitle", () => {
  it("returns the manual retitle result and defaults apply to true", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Remi", description: "这是一个足够长的描述，用于验证一键自动命名路由。" });
    let received: Record<string, unknown> | null = null;
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      issueRetitle: async (_store, id, options) => {
        received = { id, ...options };
        return { title: "实现 Issue 自动命名", previousTitle: "Remi", applied: true, reason: "generated" };
      },
    });
    const response = await app.request(`/api/multiremi/issues/${issue.id}/retitle`, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      title: "实现 Issue 自动命名",
      previous_title: "Remi",
      applied: true,
      reason: "generated",
    });
    expect(received).toMatchObject({ id: issue.id, source: "manual", apply: true });
  });

  it("returns 422 for an unconfigured gateway", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Remi" });
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      issueRetitle: async () => ({
        title: "Remi",
        previousTitle: "Remi",
        applied: false,
        reason: "gateway_unconfigured",
      }),
    });
    const response = await app.request(`/api/multiremi/issues/${issue.id}/retitle`, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({ apply: false }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: "gateway_unconfigured", applied: false });
  });

  it("rejects a non-boolean apply value", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Remi" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const response = await app.request(`/api/multiremi/issues/${issue.id}/retitle`, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({ apply: "false" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "apply must be a boolean" });
  });

  it("returns 404 for a missing Issue and for a token outside the Issue workspace", async () => {
    const store = createLocalStore();
    store.createWorkspace({ id: "remote", name: "Remote", slug: "remote", issuePrefix: "REM" });
    const remote = store.createIssue({ title: "Remote issue", workspaceId: "remote" });
    const authIssue = store.createIssue({ title: "Task auth source", workspaceId: "local" });
    const agent = store.createAgent({ name: "Retitle auth agent", provider: "codex" });
    const task = store.createTask({ workspaceId: "local", issueId: authIssue.id, agentId: agent.id, prompt: "auth" });
    const token = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    expect((await app.request("/api/multiremi/issues/missing/retitle", {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "content-type": "application/json" },
      body: "{}",
    })).status).toBe(404);
    expect((await app.request(`/api/multiremi/issues/${remote.id}/retitle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: "{}",
    })).status).toBe(404);
  });

  it("locks automatic title changes after a human explicitly edits the title", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Remi" });
    store.setIssueAutoTitleMetadata(issue.id, {
      generated_at: "2026-08-25T10:00:00.000Z",
      model: "gpt-5.6-luna",
      source: "auto",
      content_hash: "hash-1",
      count: 1,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const response = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer root-secret", "content-type": "application/json" },
      body: JSON.stringify({ title: "人工编辑后的明确标题" }),
    });
    expect(response.status).toBe(200);
    expect(store.getIssueAutoTitleMetadata(issue.id)).toEqual({
      locked: true,
      generated_at: "2026-08-25T10:00:00.000Z",
      model: "gpt-5.6-luna",
      source: "auto",
      content_hash: "hash-1",
      count: 1,
    });
  });
});
