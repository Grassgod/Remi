// Workspace member and notification-preference routes, feedback validation and
// rate limiting, GitHub settings/PR/webhook endpoints, and assignee frequency.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — members, feedback, and GitHub integration", () => {
  it("serves workspace member endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Grace Hopper", email: "grace@example.com", role: "admin" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json();

    const listed = await app.request("/api/multiremi/members");
    expect((await listed.json()).members[0].id).toBe(body.member.id);

    const updated = await app.request(`/api/multiremi/members/${body.member.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect((await updated.json()).member.role).toBe("reviewer");

    const archived = await app.request(`/api/multiremi/members/${body.member.id}`, { method: "DELETE" });
    expect((await archived.json()).member.archivedAt).toBeString();

    const owner = store.createWorkspaceMember({ name: "Native Owner", email: "native-owner@example.com", role: "owner" });
    const lastOwnerDelete = await app.request(`/api/multiremi/members/${owner.id}`, { method: "DELETE" });
    expect(lastOwnerDelete.status).toBe(400);
    expect(await lastOwnerDelete.json()).toEqual({ error: "workspace must have at least one owner" });
  });

  it("serves notification preference endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const updated = await app.request("/api/multiremi/notification-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { assignments: "muted", comments: "all" } }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).preferences.assignments).toBe("muted");

    const listed = await app.request("/api/multiremi/notification-preferences");
    expect((await listed.json()).preferences.assignments).toBe("muted");
  });

  it("serves feedback endpoints with validation and rate limiting", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "remi-test",
        "x-multiremi-platform": "desktop",
        "x-multiremi-version": "1.2.3",
      },
      body: JSON.stringify({
        message: "  Love the product, dark mode flashes on startup  ",
        url: "http://localhost:6130/issues",
        workspace_id: "local",
        member_id: "mem_feedback",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("fdb_");
    expect(createdBody.created_at).toBeString();

    const feedback = store.listFeedback("local")[0];
    expect(feedback.message).toBe("Love the product, dark mode flashes on startup");
    expect(feedback.memberId).toBe("mem_feedback");
    expect(feedback.userId).toBe("mem_feedback");
    expect(feedback.metadata.url).toBe("http://localhost:6130/issues");
    expect(feedback.metadata.platform).toBe("desktop");
    expect(feedback.metadata.version).toBe("1.2.3");
    expect(feedback.metadata.user_agent).toBe("remi-test");

    const multiremiFeedback = await app.request("/api/multiremi/feedback");
    const multiremiFeedbackBody = await multiremiFeedback.json();
    expect(multiremiFeedbackBody.total).toBe(1);
    expect(multiremiFeedbackBody.feedback[0].id).toBe(createdBody.id);

    const empty = await app.request("/api/multiremi/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(empty.status).toBe(400);

    for (let i = 0; i < 9; i++) {
      const response = await app.request("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `feedback #${i}`, member_id: "mem_feedback" }),
      });
      expect(response.status).toBe(201);
    }

    const overLimit = await app.request("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "one too many", member_id: "mem_feedback" }),
    });
    expect(overLimit.status).toBe(429);
  });

  it("serves GitHub settings, pull request, and webhook endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "GitHub API issue" });

    const unavailableConnect = await app.request("/api/workspaces/local/github/connect");
    expect(await unavailableConnect.json()).toEqual({ configured: false });

    const settings = await app.request("/api/multiremi/github/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prSidebar: false, coAuthor: false }),
    });
    expect(settings.status).toBe(200);
    const settingsBody = await settings.json();
    expect(settingsBody.settings.enabled).toBe(true);
    expect(settingsBody.settings.prSidebar).toBe(false);
    expect(settingsBody.settings.coAuthor).toBe(false);

    const created = await app.request("/api/multiremi/github/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_owner: "example",
        repo_name: "remi",
        number: 7,
        title: `${issue.key} API linked PR`,
        branch: `feature/${issue.key}-api-pr`,
        checksConclusion: "passed",
        checksPassed: 2,
        additions: 5,
        deletions: 1,
        changedFiles: 2,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.pullRequest.issueId).toBe(issue.id);
    expect(createdBody.pullRequest.checksPassed).toBe(2);

    const listed = await app.request(`/api/multiremi/github/pull-requests?issueId=${encodeURIComponent(issue.id)}`);
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(1);
    expect(listedBody.pullRequests[0].number).toBe(7);

    const issuePullRequests = await app.request(`/api/issues/${encodeURIComponent(issue.id)}/pull-requests`);
    const issuePullRequestsBody = await issuePullRequests.json();
    expect(issuePullRequests.status).toBe(200);
    expect(issuePullRequestsBody.pull_requests[0].repo_owner).toBe("example");
    expect(issuePullRequestsBody.pull_requests[0].html_url).toBe("https://github.com/example/remi/pull/7");
    expect(issuePullRequestsBody.pull_requests[0].checks_passed).toBe(2);

    const merged = await app.request("/api/multiremi/github/pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoOwner: "example",
        repoName: "remi",
        number: 7,
        title: `${issue.key} API linked PR`,
        state: "merged",
        mergedAt: "2026-06-03T00:00:00.000Z",
      }),
    });
    expect(merged.status).toBe(201);
    expect(store.getIssue(issue.id)?.status).toBe("done");

    const ping = await app.request("/api/multiremi/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zen: "Keep it logically awesome." }),
    });
    expect((await ping.json()).ok).toBe("pong");

    const webhookIssue = store.createIssue({ title: "GitHub webhook issue" });
    const webhook = await app.request("/api/multiremi/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: { name: "remi", owner: { login: "example" } },
        pull_request: {
          number: 8,
          title: `${webhookIssue.key} webhook linked PR`,
          state: "open",
          draft: false,
          merged: false,
          html_url: "https://github.com/example/remi/pull/8",
          head: { ref: `feature/${webhookIssue.key}-webhook` },
          user: { login: "octocat", avatar_url: "https://example.com/avatar.png" },
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T01:00:00.000Z",
          mergeable_state: "clean",
          additions: 3,
          deletions: 0,
          changed_files: 1,
        },
      }),
    });
    expect(webhook.status).toBe(202);
    expect((await webhook.json()).pullRequest.issueId).toBe(webhookIssue.id);

    const originalWebhookIssue = store.createIssue({ title: "GitHub original webhook issue" });
    const originalWebhook = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: { name: "remi", owner: { login: "example" } },
        pull_request: {
          number: 9,
          title: `${originalWebhookIssue.key} original webhook linked PR`,
          state: "closed",
          draft: false,
          merged: true,
          html_url: "https://github.com/example/remi/pull/9",
          head: { ref: `feature/${originalWebhookIssue.key}-original-webhook` },
          user: { login: "octocat" },
          merged_at: "2026-06-03T02:00:00.000Z",
          closed_at: "2026-06-03T02:00:00.000Z",
          created_at: "2026-06-03T00:00:00.000Z",
          updated_at: "2026-06-03T02:00:00.000Z",
        },
      }),
    });
    const originalWebhookBody = await originalWebhook.json();
    expect(originalWebhook.status).toBe(202);
    expect(originalWebhookBody.pullRequest.issueId).toBe(originalWebhookIssue.id);
    expect(originalWebhookBody.pullRequest.state).toBe("merged");
    expect(store.getIssue(originalWebhookIssue.id)?.status).toBe("done");
  });

  it("serves configured GitHub setup and connect compatibility responses", async () => {
    const previousSlug = process.env.GITHUB_APP_SLUG;
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    try {
      process.env.GITHUB_APP_SLUG = "multiremi-local";
      process.env.GITHUB_WEBHOOK_SECRET = "local-secret";
      const app = createMultiremiApp({ store: createStore() });

      const connect = await app.request("/api/workspaces/local/github/connect");
      const connectBody = await connect.json();
      expect(connect.status).toBe(200);
      expect(connectBody.configured).toBe(true);
      expect(connectBody.url).toStartWith("https://github.com/apps/multiremi-local/installations/new?state=");

      const installations = await app.request("/api/workspaces/local/github/installations");
      expect(await installations.json()).toMatchObject({
        configured: true,
        installations: [],
        can_manage: true,
      });

      const setup = await app.request("/api/github/setup?installation_id=123&state=local.state.sig");
      expect(await setup.json()).toMatchObject({
        configured: true,
        installation_id: "123",
        state: "local.state.sig",
      });
    } finally {
      if (previousSlug === undefined) delete process.env.GITHUB_APP_SLUG;
      else process.env.GITHUB_APP_SLUG = previousSlug;
      if (previousSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("serves assignee frequency through original Multiremi route", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const alice = store.createWorkspaceMember({ name: "Alice API", role: "member" });
    const bob = store.createWorkspaceMember({ name: "Bob API", role: "member" });
    const issue = store.createIssue({
      title: "Assigned on create",
      createdBy: alice.id,
      assigneeType: "member",
      assigneeId: bob.id,
    });
    store.assignIssue(issue.id, {
      assigneeType: "member",
      assigneeId: bob.id,
      actorType: "member",
      actorId: alice.id,
    });

    const response = await app.request(`/api/assignee-frequency?memberId=${encodeURIComponent(alice.id)}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0]).toMatchObject({
      assignee_type: "member",
      assignee_id: bob.id,
      frequency: 2,
    });
  });
});
