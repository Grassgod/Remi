import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const headers = { Authorization: "Bearer MASTER", "Content-Type": "application/json" };

describe("side Session API", () => {
  it("accepts both parent input spellings and returns a frozen snapshot through all Session reads", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Side API", workspaceId: "local" });
    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    store.createIssueComment(issue.id, { issueSessionId: parent.id, body: "Earlier context" });
    const events = store.listSessionEvents(parent.id);
    const cutoff = events.at(-1)!.seq;
    const app = createMultiremiApp({ store, authToken: "MASTER" });

    for (const parentField of ["parentSessionId", "parent_session_id"]) {
      const created = await app.request(`/api/issues/${issue.id}/sessions`, {
        method: "POST", headers,
        body: JSON.stringify({ title: "Side", [parentField]: parent.id, inherit_mode: "snapshot" }),
      });
      expect(created.status).toBe(201);
      const side = await created.json();
      const expected = {
        parent_session_id: parent.id, inherit_mode: "snapshot", inherit_cutoff_seq: cutoff,
        inherited_event_count: events.length, holds_workspace: false,
      };
      expect(side).toMatchObject(expected);
      for (const path of [`/api/sessions/${side.id}`, `/api/issues/${issue.id}/sessions/${side.id}`]) {
        const read = await app.request(path, { headers });
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject(expected);
      }
    }

    store.createIssueComment(issue.id, { issueSessionId: parent.id, body: "After the snapshot" });
    const list = await app.request(`/api/issues/${issue.id}/sessions`, { headers });
    const sessions = await list.json();
    expect(sessions.find((session: { id: string }) => session.id === parent.id)).toMatchObject({
      parent_session_id: null, inherit_mode: "none", inherit_cutoff_seq: null, inherited_event_count: 0,
    });
    for (const session of sessions.filter((session: { id: string }) => session.id !== parent.id)) {
      expect(session).toMatchObject({ inherit_cutoff_seq: cutoff, inherited_event_count: events.length });
    }
  });

  it("rejects unsupported or contradictory inheritance modes without creating Sessions", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Invalid modes", workspaceId: "local" });
    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    for (const body of [
      { parent_session_id: parent.id, inherit_mode: "future" },
      { parentSessionId: parent.id, inheritMode: "none" },
      { inherit_mode: "snapshot" },
      { inherit_mode: "follow" },
      { inheritMode: "future" },
      { parent_session_id: parent.id, inherit_mode: "snapshot", inheritMode: "follow" },
    ]) {
      const response = await app.request(`/api/issues/${issue.id}/sessions`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("inherit_mode");
    }
    expect(store.listIssueSessions(issue.id)).toHaveLength(1);
  });

  it("accepts follow through both mode spellings and keeps its fork point immutable", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Follow API", workspaceId: "local" });
    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    const fork = store.appendSessionEvent(parent.id, { authorType: "member", body: "At fork" });
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    for (const modeField of ["inheritMode", "inherit_mode"]) {
      const created = await app.request(`/api/issues/${issue.id}/sessions`, {
        method: "POST", headers,
        body: JSON.stringify({ title: "Following", parent_session_id: parent.id, [modeField]: "follow", holds_workspace: true }),
      });
      expect(created.status).toBe(201);
      const side = await created.json();
      expect(side).toMatchObject({ inherit_mode: "follow", holds_workspace: false });
      const added = store.appendSessionEvent(parent.id, { authorType: "member", body: "After fork" });
      for (const path of [`/api/sessions/${side.id}`, `/api/issues/${issue.id}/sessions/${side.id}`]) {
        const response = await app.request(path, { headers });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          inherit_mode: "follow", inherit_cutoff_seq: side.inherit_cutoff_seq,
          inherited_event_count: store.listSessionEvents(parent.id).length,
        });
      }
      const context = await app.request(`/api/sessions/${side.id}/inherited-context`, { headers });
      expect(context.status).toBe(200);
      expect(await context.json()).toMatchObject({
        inherit_mode: "follow", parent_max_seq: added.seq, lanes: [],
        inherited_tokens_total: 0, follow_token_limit: 200_000, follow_frozen: false, follow_frozen_seq: null,
      });
      expect(side.inherit_cutoff_seq).toBeGreaterThanOrEqual(fork.seq);
      const chained = await app.request(`/api/issues/${issue.id}/sessions`, {
        method: "POST", headers,
        body: JSON.stringify({ parent_session_id: side.id, inherit_mode: "follow" }),
      });
      expect(chained.status).toBe(400);
    }
  });

  it("keeps inheritance fields immutable through update and rejects invalid parents", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Parent validation", workspaceId: "local" });
    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    const other = store.createIssue({ title: "Other issue", workspaceId: "local" });
    const otherParent = store.getOrCreateDefaultIssueSession(other.id);
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    const created = await app.request(`/api/issues/${issue.id}/sessions`, {
      method: "POST", headers, body: JSON.stringify({ parent_session_id: parent.id }),
    });
    expect(created.status).toBe(201);
    const side = await created.json();
    for (const parentId of [otherParent.id, side.id, "ises_missing"]) {
      const response = await app.request(`/api/issues/${issue.id}/sessions`, {
        method: "POST", headers, body: JSON.stringify({ parent_session_id: parentId }),
      });
      expect(response.status).toBe(400);
    }
    const updated = await app.request(`/api/issues/${issue.id}/sessions/${side.id}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ title: "Renamed", parent_session_id: otherParent.id, inherit_mode: "none", inherit_cutoff_seq: 99 }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      title: "Renamed", parent_session_id: parent.id, inherit_mode: "snapshot", inherit_cutoff_seq: side.inherit_cutoff_seq,
    });
  });

  it("authenticates direct Session reads and hides other workspaces from humans and task tokens", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Visible", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const workspace = store.createWorkspace({ name: "Private", slug: "private", issuePrefix: "PRI" });
    const privateIssue = store.createIssue({ title: "Hidden", workspaceId: workspace.id });
    const privateSession = store.getOrCreateDefaultIssueSession(privateIssue.id);
    store.createWorkspaceMember({ workspaceId: "local", userId: "reader", name: "Reader", role: "member" });
    const member = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "reader", userId: "reader" });
    const agent = store.createAgent({ name: "Reader", provider: "codex", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "Read" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "MASTER" });
    expect((await app.request(`/api/sessions/${session.id}`)).status).toBe(401);
    for (const token of [member.token, taskToken.token]) {
      const asReader = { Authorization: `Bearer ${token}` };
      expect((await app.request(`/api/sessions/${session.id}`, { headers: asReader })).status).toBe(200);
      const denied = await app.request(`/api/sessions/${privateSession.id}`, { headers: asReader });
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain("Hidden");
    }
    expect((await app.request("/api/sessions/ises_missing", { headers })).status).toBe(404);
  });
});
