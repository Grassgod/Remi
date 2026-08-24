import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { signIssueShareId } from "@multiremi/api/helpers/issue-share-tokens.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("collaboration CLI authorization boundaries", () => {
  it("lets a task token mutate its current issue but not a sibling issue", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const agent = store.createAgent({ name: "Scoped CLI agent", provider: "claude" });
    const current = store.createIssue({ title: "Current issue", workspaceId: "local" });
    const sibling = store.createIssue({ title: "Sibling issue", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: current.id, prompt: "Work current" });
    const token = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };

    const currentUpdate = await app.request(`/api/issues/${current.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ priority: "high" }),
    });
    expect(currentUpdate.status).toBe(200);

    for (const [method, path, body] of [
      ["PUT", `/api/issues/${sibling.id}`, { priority: "urgent" }],
      ["PATCH", `/api/multiremi/issues/${sibling.id}`, { priority: "urgent" }],
      ["POST", `/api/multiremi/issues/${sibling.id}/assign`, { assigneeType: "agent", assigneeId: agent.id }],
      ["DELETE", `/api/issues/${sibling.id}`, undefined],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    const crossIssueComment = await app.request(`/api/issues/${sibling.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "Cross-issue coordination remains allowed" }),
    });
    expect(crossIssueComment.status).toBe(201);
    const child = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Delegated child", parent_issue_id: sibling.id }),
    });
    expect(child.status).toBe(201);
  });

  it("allows a signed Share header to read only its own shared bundle", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const secret = "share-cli-secret";
    const app = createMultiremiApp({ store, authToken: "root-secret", shareSecret: secret });
    const first = store.createIssue({ title: "First shared issue", workspaceId: "local" });
    const second = store.createIssue({ title: "Second shared issue", workspaceId: "local" });
    const firstToken = signIssueShareId(store.ensureIssueShare(first.id, "local", "local", 60).id, secret);
    const secondToken = signIssueShareId(store.ensureIssueShare(second.id, "local", "local", 60).id, secret);

    const own = await app.request(`/api/shares/${encodeURIComponent(firstToken)}`, {
      headers: { "X-Remi-Share": firstToken },
    });
    expect(own.status).toBe(200);
    expect((await own.json()).issue.title).toBe("First shared issue");

    const mismatched = await app.request(`/api/shares/${encodeURIComponent(secondToken)}`, {
      headers: { "X-Remi-Share": firstToken },
    });
    expect(mismatched.status).toBe(401);
    expect((await app.request(`/api/shares/${encodeURIComponent(firstToken)}`)).status).toBe(401);
  });
});
