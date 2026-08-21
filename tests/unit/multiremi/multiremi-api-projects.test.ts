// Workspace object updates/archival, project resource endpoints, and the original
// project/squad/autopilot compatibility routes.
import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — projects, squads, and workspace objects", () => {
  it("updates and archives workspace objects", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Ops" });
    const squad = store.createSquad({ name: "Ops squad", leaderId: agent.id });
    const autopilot = store.createAutopilot({
      title: "Ops auto",
      projectId: project.id,
      assigneeType: "squad",
      assigneeId: squad.id,
    });

    expect(store.updateSquad(squad.id, { name: "Ops team" }).name).toBe("Ops team");
    store.removeSquadMember(squad.id, { memberType: "agent", memberId: agent.id });
    expect(store.listSquadMembers(squad.id)).toHaveLength(0);
    expect(store.getSquad(squad.id)?.leaderId).toBeNull();

    expect(store.updateAutopilot(autopilot.id, { status: "paused" }).status).toBe("paused");
    expect(store.archiveAutopilot(autopilot.id).status).toBe("archived");
    expect(store.listAutopilots()).toHaveLength(0);

    const archivedProject = store.archiveProject(project.id);
    expect(archivedProject.archivedAt).toBeString();
    expect(archivedProject.status).toBe("cancelled");
    const restoredProject = store.restoreProject(project.id);
    expect(restoredProject.archivedAt).toBeNull();
    expect(restoredProject.status).toBe("in_progress");
    expect(store.archiveSquad(squad.id).archivedAt).toBeString();
    expect(store.listSquads()).toHaveLength(0);
  });

  it("serves project resource endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Resources" });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const invalidNativeResourceCreate = await app.request(`/api/multiremi/projects/${project.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeResourceCreate.status).toBe(400);
    expect(await invalidNativeResourceCreate.json()).toEqual({ error: "invalid request body" });

    const created = await app.request(`/api/multiremi/projects/${project.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_type: "github_repo",
        resource_ref: { url: "git@github.com:example/repo.git", default_branch_hint: "main" },
        label: "ssh repo",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.resource.resourceRef.url).toBe("git@github.com:example/repo.git");
    expect(events.find((event) => event.type === "project_resource:created")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        project_id: project.id,
        resource: {
          id: createdBody.resource.id,
          resource_type: "github_repo",
          resource_ref: { url: "git@github.com:example/repo.git", default_branch_hint: "main" },
        },
      },
    });

    const invalidNativeResourceUpdate = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeResourceUpdate.status).toBe(400);
    expect(await invalidNativeResourceUpdate.json()).toEqual({ error: "invalid request body" });

    const updated = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_ref: { url: "git@github.com:example/repo-updated.git", default_branch_hint: "develop" },
        label: "",
        position: 2,
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.resource.resourceRef.url).toBe("git@github.com:example/repo-updated.git");
    expect(updatedBody.resource.label).toBeNull();
    expect(updatedBody.resource.position).toBe(2);
    expect(events.find((event) => event.type === "project_resource:updated")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        project_id: project.id,
        resource: {
          id: createdBody.resource.id,
          resource_type: "github_repo",
          resource_ref: { url: "git@github.com:example/repo-updated.git", default_branch_hint: "develop" },
          label: null,
          position: 2,
        },
      },
    });

    const listed = await app.request(`/api/multiremi/projects/${project.id}/resources`);
    expect((await listed.json()).total).toBe(1);

    const detail = await app.request(`/api/multiremi/projects/${project.id}`);
    expect((await detail.json()).resources).toHaveLength(1);

    const deleted = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(store.listProjectResources(project.id)).toHaveLength(0);
    expect(events.find((event) => event.type === "project_resource:deleted")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        project_id: project.id,
        resource_id: createdBody.resource.id,
      },
    });

    const missingDelete = await app.request(`/api/multiremi/projects/${project.id}/resources/${createdBody.resource.id}`, {
      method: "DELETE",
    });
    expect(missingDelete.status).toBe(404);
    expect(await missingDelete.json()).toEqual({ error: "project resource not found" });
  });

  it("round-trips the project default assignee over the compat API", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Ops Leader", provider: "claude" });
    const squad = store.createSquad({ name: "Ops squad", leaderId: agent.id });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Squad Project", default_assignee_type: "squad", default_assignee_id: squad.id }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.default_assignee_type).toBe("squad");
    expect(createdBody.default_assignee_id).toBe(squad.id);

    // An unrelated PUT must not clobber the binding (whitelisted merge).
    const renamed = await app.request(`/api/projects/${createdBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Squad Project Renamed" }),
    });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json();
    expect(renamedBody.default_assignee_type).toBe("squad");
    expect(renamedBody.default_assignee_id).toBe(squad.id);

    // Explicit nulls clear it.
    const cleared = await app.request(`/api/projects/${createdBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_assignee_type: null, default_assignee_id: null }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json();
    expect(clearedBody.default_assignee_type).toBeNull();
    expect(clearedBody.default_assignee_id).toBeNull();

    // Unknown refs are a 400, not a 500.
    const invalid = await app.request(`/api/projects/${createdBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_assignee_type: "squad", default_assignee_id: "sqd_missing" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Squad not found: sqd_missing" });
  });

  it("round-trips bounded project instructions with audited optimistic revisions", async () => {
    const store = createStore();
    const userId = "usr_project_instructions_editor";
    store.createWorkspaceMember({
      id: "mem_project_instructions_editor",
      userId,
      name: "Project instructions editor",
      role: "member",
    });
    const token = await store.createAccessToken({
      name: "Project instructions editor",
      type: "pat",
      workspaceId: "local",
      userId,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    };

    const created = await app.request("/api/multiremi/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Directed project",
        description: "Visible summary",
        instructions: "Use Bun.\r\nRun focused tests.",
        instructionsRevision: 99,
        instructionsUpdatedBy: "usr_spoofed",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.project).toMatchObject({
      description: "Visible summary",
      instructions: "Use Bun.\nRun focused tests.",
      instructionsRevision: 1,
      instructionsUpdatedBy: userId,
    });
    expect(createdBody.project.instructionsUpdatedAt).toBeString();

    const compatibilityDetail = await app.request(`/api/projects/${createdBody.project.id}`, { headers });
    expect(compatibilityDetail.status).toBe(200);
    expect(await compatibilityDetail.json()).toMatchObject({
      instructions: "Use Bun.\nRun focused tests.",
      instructions_revision: 1,
      instructions_updated_at: createdBody.project.instructionsUpdatedAt,
      instructions_updated_by: userId,
    });

    const missingExpectedRevision = await app.request(`/api/multiremi/projects/${createdBody.project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructions: "Missing revision" }),
    });
    expect(missingExpectedRevision.status).toBe(400);
    expect(await missingExpectedRevision.json()).toEqual({
      error: "expected_instructions_revision is required when instructions is provided",
    });

    const missingCompatibilityExpectedRevision = await app.request(`/api/projects/${createdBody.project.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ instructions: "Missing compat revision" }),
    });
    expect(missingCompatibilityExpectedRevision.status).toBe(400);
    expect(await missingCompatibilityExpectedRevision.json()).toEqual({
      error: "expected_instructions_revision is required when instructions is provided",
    });

    const invalidExpectedRevision = await app.request(`/api/projects/${createdBody.project.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ instructions: "Invalid revision", expected_instructions_revision: -1 }),
    });
    expect(invalidExpectedRevision.status).toBe(400);
    expect(await invalidExpectedRevision.json()).toEqual({
      error: "expected_instructions_revision must be a non-negative integer",
    });

    for (const [path, method] of [
      [`/api/multiremi/projects/${createdBody.project.id}`, "PATCH"],
      [`/api/projects/${createdBody.project.id}`, "PUT"],
    ] as const) {
      const mismatchedExpectedRevisions = await app.request(path, {
        method,
        headers,
        body: JSON.stringify({
          instructions: "Ambiguous revision",
          expectedInstructionsRevision: 1,
          expected_instructions_revision: 2,
        }),
      });
      expect(mismatchedExpectedRevisions.status).toBe(400);
      expect(await mismatchedExpectedRevisions.json()).toEqual({
        error: "expected instructions revisions must match",
      });
    }

    const nativeUpdated = await app.request(`/api/multiremi/projects/${createdBody.project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        instructions: "Prefer focused tests.",
        expectedInstructionsRevision: 1,
        instructionsUpdatedBy: "usr_spoofed_update",
        instructions_updated_by: "usr_spoofed_update",
      }),
    });
    expect(nativeUpdated.status).toBe(200);
    const nativeUpdatedBody = await nativeUpdated.json();
    expect(nativeUpdatedBody.project).toMatchObject({
      instructions: "Prefer focused tests.",
      instructionsRevision: 2,
      instructionsUpdatedBy: userId,
    });

    const expectedConflict = {
      error: "project instructions changed after they were loaded",
      code: "project_instructions_revision_conflict",
      expected_revision: 1,
      current_revision: 2,
    };
    const staleNativeUpdate = await app.request(`/api/multiremi/projects/${createdBody.project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructions: "Stale native overwrite", expectedInstructionsRevision: 1 }),
    });
    expect(staleNativeUpdate.status).toBe(409);
    expect(await staleNativeUpdate.json()).toEqual(expectedConflict);

    const staleCompatibilityUpdate = await app.request(`/api/projects/${createdBody.project.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ instructions: "Stale compat overwrite", expected_instructions_revision: 1 }),
    });
    expect(staleCompatibilityUpdate.status).toBe(409);
    expect(await staleCompatibilityUpdate.json()).toEqual(expectedConflict);

    const staleCamelCompatibilityUpdate = await app.request(`/api/projects/${createdBody.project.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ instructions: "Stale camel compat overwrite", expectedInstructionsRevision: 1 }),
    });
    expect(staleCamelCompatibilityUpdate.status).toBe(409);
    expect(await staleCamelCompatibilityUpdate.json()).toEqual(expectedConflict);

    const unchanged = await app.request(`/api/projects/${createdBody.project.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ instructions: "Prefer focused tests.", expected_instructions_revision: 2 }),
    });
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()).instructions_revision).toBe(2);

    const unrelatedUpdate = await app.request(`/api/projects/${createdBody.project.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "Directed project renamed", expected_instructions_revision: 0 }),
    });
    expect(unrelatedUpdate.status).toBe(200);
    expect(await unrelatedUpdate.json()).toMatchObject({
      title: "Directed project renamed",
      instructions: "Prefer focused tests.",
      instructions_revision: 2,
    });

    const maxLengthUpdate = await app.request(`/api/multiremi/projects/${createdBody.project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructions: "\u{20000}".repeat(4_000), expectedInstructionsRevision: 2 }),
    });
    expect(maxLengthUpdate.status).toBe(200);
    expect((await maxLengthUpdate.json()).project.instructionsRevision).toBe(3);

    const tooLongUpdate = await app.request(`/api/projects/${createdBody.project.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ instructions: "\u{20000}".repeat(4_001), expected_instructions_revision: 3 }),
    });
    expect(tooLongUpdate.status).toBe(400);
    expect(await tooLongUpdate.json()).toEqual({ error: "instructions must be 4000 characters or fewer" });

    const compatibilityCreated = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Compatibility directed", instructions: "Ship carefully." }),
    });
    expect(compatibilityCreated.status).toBe(201);
    expect(await compatibilityCreated.json()).toMatchObject({
      instructions: "Ship carefully.",
      instructions_revision: 1,
      instructions_updated_at: expect.any(String),
      instructions_updated_by: userId,
    });

    const tooLongCreate = await app.request("/api/multiremi/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Too long", instructions: "x".repeat(4_001) }),
    });
    expect(tooLongCreate.status).toBe(400);
    expect(await tooLongCreate.json()).toEqual({ error: "instructions must be 4000 characters or fewer" });
  });

  it("scopes instruction reads to the Project and allows only human members to update them", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({
      id: "ws_project_instructions_guard",
      name: "Instructions Guard",
      slug: "instructions-guard",
    });
    const project = store.createProject({
      title: "Guarded project",
      workspaceId: workspace.id,
      instructions: "Private project guidance",
    });
    const siblingProject = store.createProject({
      title: "Sibling project",
      workspaceId: workspace.id,
      instructions: "Sibling private guidance",
    });
    const outsider = store.getOrCreateUser({
      externalId: "ou_project_instructions_outsider",
      email: "project-instructions-outsider@example.test",
      name: "Project instructions outsider",
    });
    const outsiderToken = await store.createAccessToken({
      name: "Outsider session",
      type: "pat",
      purpose: "session",
      workspaceId: "local",
      userId: outsider.id,
    });
    const agent = store.createAgent({
      name: "Scoped project agent",
      provider: "claude",
      workspaceId: workspace.id,
    });
    const issue = store.createIssue({
      title: "Scoped task",
      workspaceId: workspace.id,
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      workspaceId: workspace.id,
      prompt: "work",
    });
    const taskToken = await store.createTaskAccessToken(task, workspace.id);
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const outsiderHeaders = {
      Authorization: `Bearer ${outsiderToken.token}`,
      "Content-Type": "application/json",
    };
    const taskHeaders = {
      Authorization: `Bearer ${taskToken.token}`,
      "Content-Type": "application/json",
    };

    for (const path of [
      `/api/multiremi/projects/${project.id}`,
      `/api/projects/${project.id}`,
    ]) {
      expect((await app.request(path, { headers: outsiderHeaders })).status).toBe(404);
    }
    expect((await app.request(`/api/multiremi/projects/${project.id}`, {
      method: "PATCH",
      headers: outsiderHeaders,
      body: JSON.stringify({ instructions: "Injected", expectedInstructionsRevision: 1 }),
    })).status).toBe(404);
    expect((await app.request(`/api/projects/${project.id}`, {
      method: "PUT",
      headers: outsiderHeaders,
      body: JSON.stringify({ instructions: "Injected", expected_instructions_revision: 1 }),
    })).status).toBe(404);

    expect((await app.request(`/api/multiremi/projects/${project.id}`, { headers: taskHeaders })).status).toBe(200);
    expect((await app.request(`/api/projects/${project.id}`, { headers: taskHeaders })).status).toBe(200);
    expect((await app.request(`/api/projects/${siblingProject.id}`, { headers: taskHeaders })).status).toBe(404);
    expect((await app.request(`/api/multiremi/projects/${project.id}`, {
      method: "PATCH",
      headers: taskHeaders,
      body: JSON.stringify({ instructions: "Task injection", expectedInstructionsRevision: 1 }),
    })).status).toBe(403);
    expect((await app.request(`/api/projects/${project.id}`, {
      method: "PUT",
      headers: taskHeaders,
      body: JSON.stringify({ instructions: "Task injection", expected_instructions_revision: 1 }),
    })).status).toBe(403);

    const compatList = await (await app.request(
      `/api/projects?workspace_id=${workspace.id}`,
      { headers: taskHeaders },
    )).json();
    expect(compatList.projects).toHaveLength(2);
    expect(compatList.projects[0]).not.toHaveProperty("instructions");
    const nativeList = await (await app.request(
      `/api/multiremi/projects?workspaceId=${workspace.id}`,
      { headers: taskHeaders },
    )).json();
    expect(nativeList.projects).toHaveLength(2);
    expect(nativeList.projects[0]).not.toHaveProperty("instructions");

    const nativeSearch = await (await app.request(
      `/api/multiremi/projects/search?workspaceId=${workspace.id}&q=Sibling`,
      { headers: taskHeaders },
    )).json();
    expect(nativeSearch.projects).toHaveLength(1);
    expect(nativeSearch.projects[0]).toMatchObject({
      id: siblingProject.id,
      matchSource: "title",
    });
    expect(nativeSearch.projects[0]).not.toHaveProperty("instructions");
    expect(nativeSearch.projects[0]).not.toHaveProperty("instructionsRevision");
    expect(nativeSearch.projects[0]).not.toHaveProperty("instructionsUpdatedAt");
    expect(nativeSearch.projects[0]).not.toHaveProperty("instructionsUpdatedBy");

    const compatSearch = await (await app.request(
      `/api/projects/search?workspace_id=${workspace.id}&q=Sibling`,
      { headers: taskHeaders },
    )).json();
    expect(compatSearch.projects).toHaveLength(1);
    expect(compatSearch.projects[0]).toMatchObject({
      id: siblingProject.id,
      match_source: "title",
    });
    expect(compatSearch.projects[0]).not.toHaveProperty("instructions");
    expect(compatSearch.projects[0]).not.toHaveProperty("instructions_revision");
    expect(compatSearch.projects[0]).not.toHaveProperty("instructions_updated_at");
    expect(compatSearch.projects[0]).not.toHaveProperty("instructions_updated_by");
    expect(store.getProject(project.id)?.instructions).toBe("Private project guidance");
  });

  it("serves original project, squad, and autopilot compatibility endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Original Codex", provider: "codex" });
    const app = createMultiremiApp({ store });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const invalidNativeProjectCreate = await app.request("/api/multiremi/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeProjectCreate.status).toBe(400);
    expect(await invalidNativeProjectCreate.json()).toEqual({ error: "invalid request body" });

    const invalidProjectCreate = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidProjectCreate.status).toBe(400);
    expect(await invalidProjectCreate.json()).toEqual({ error: "invalid request body" });

    const project = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original Project", priority: "high", lead_type: "agent", lead_id: agent.id }),
    });
    const projectBody = await project.json();
    expect(project.status).toBe(201);
    expect(projectBody.title).toBe("Original Project");
    expect(projectBody.workspace_id).toBe("local");
    expect(projectBody.lead_type).toBe("agent");
    expect(projectBody.lead_id).toBe(agent.id);
    expect(projectBody.issue_count).toBe(0);
    expect(projectBody.resource_count).toBe(0);
    expect(projectBody.archived_at).toBeNull();
    expect(projectBody.workspaceId).toBeUndefined();
    expect(events.find((event) => event.type === "project:created")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: { project: { id: projectBody.id, workspace_id: "local", lead_type: "agent", lead_id: agent.id } },
    });

    const remoteProject = store.createProject({ title: "Remote Compatibility Project", workspaceId: "remote" });
    const projectListBody = await (await app.request("/api/projects")).json();
    expect(projectListBody.projects[0].id).toBe(projectBody.id);
    expect(projectListBody.total).toBe(1);
    const camelWorkspaceProjects = await (await app.request("/api/projects?workspaceId=remote")).json();
    expect(camelWorkspaceProjects.projects.some((item: any) => item.id === remoteProject.id)).toBe(false);
    const snakeWorkspaceProjects = await (await app.request("/api/projects?workspace_id=remote")).json();
    expect(snakeWorkspaceProjects.projects.map((item: any) => item.id)).toEqual([remoteProject.id]);

    const invalidNativeProjectUpdate = await app.request(`/api/multiremi/projects/${projectBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeProjectUpdate.status).toBe(400);
    expect(await invalidNativeProjectUpdate.json()).toEqual({ error: "invalid request body" });

    const invalidProjectUpdate = await app.request(`/api/projects/${projectBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidProjectUpdate.status).toBe(400);
    expect(await invalidProjectUpdate.json()).toEqual({ error: "invalid request body" });

    const updatedProject = await app.request(`/api/projects/${projectBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original Project Updated", lead_type: null, lead_id: null }),
    });
    const updatedProjectBody = await updatedProject.json();
    expect(updatedProject.status).toBe(200);
    expect(updatedProjectBody.title).toBe("Original Project Updated");
    expect(updatedProjectBody.lead_type).toBeNull();
    expect(updatedProjectBody.lead_id).toBeNull();
    expect(updatedProjectBody.updated_at).toBeString();

    const camelProjectUpdate = await app.request(`/api/projects/${projectBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadType: "agent", leadId: agent.id }),
    });
    expect(camelProjectUpdate.status).toBe(200);
    const camelProjectUpdateBody = await camelProjectUpdate.json();
    expect(camelProjectUpdateBody.lead_type).toBeNull();
    expect(camelProjectUpdateBody.lead_id).toBeNull();
    expect(events.find((event) => event.type === "project:updated")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: { project: { id: projectBody.id, title: "Original Project Updated", lead_type: null, lead_id: null } },
    });

    const camelProjectCreate = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Camel Project", workspaceId: "remote", leadType: "agent", leadId: agent.id }),
    });
    const camelProjectCreateBody = await camelProjectCreate.json();
    expect(camelProjectCreate.status).toBe(201);
    expect(camelProjectCreateBody.workspace_id).toBe("local");
    expect(camelProjectCreateBody.lead_type).toBe("member");
    expect(camelProjectCreateBody.lead_id).toBe("local");

    const invalidResourceCreate = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidResourceCreate.status).toBe(400);
    expect(await invalidResourceCreate.json()).toEqual({ error: "invalid request body" });

    const resource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "github_repo", resource_ref: { url: "https://github.com/example/repo" } }),
    });
    const resourceBody = await resource.json();
    expect(resource.status).toBe(201);
    expect(resourceBody.resource_type).toBe("github_repo");
    expect(resourceBody.resource_ref.url).toBe("https://github.com/example/repo");

    const duplicateResource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource_type: "github_repo", resource_ref: { url: "https://github.com/example/repo" } }),
    });
    expect(duplicateResource.status).toBe(409);
    expect(await duplicateResource.json()).toEqual({ error: "this resource is already attached to the project" });

    const invalidResourceUpdate = await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidResourceUpdate.status).toBe(400);
    expect(await invalidResourceUpdate.json()).toEqual({ error: "invalid request body" });

    const updatedResource = await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_ref: { url: "https://github.com/example/repo-updated", default_branch_hint: "develop" },
        label: "",
        position: 3,
      }),
    });
    expect(updatedResource.status).toBe(200);
    const updatedResourceBody = await updatedResource.json();
    expect(updatedResourceBody.resource_ref).toEqual({
      url: "https://github.com/example/repo-updated",
      default_branch_hint: "develop",
    });
    expect(updatedResourceBody.label).toBeNull();
    expect(updatedResourceBody.position).toBe(3);

    const listedResourcesBody = await (await app.request(`/api/projects/${projectBody.id}/resources`)).json();
    expect(listedResourcesBody.total).toBe(1);
    expect(listedResourcesBody.resources[0].id).toBe(resourceBody.id);

    const localResource = await app.request(`/api/projects/${projectBody.id}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource_type: "local_directory",
        resource_ref: { local_path: "/tmp/multiremi-local-project-api", daemon_id: "daemon-api" },
      }),
    });
    expect(localResource.status).toBe(400);
    expect(await localResource.json()).toEqual({
      error: "local_directory resources are no longer supported; import a Git repository instead",
    });

    const camelSquad = await app.request("/api/squads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Camel Squad", leaderId: agent.id }),
    });
    expect(camelSquad.status).toBe(400);
    expect(await camelSquad.json()).toEqual({ error: "leader_id is required" });

    const remoteAgent = store.createAgent({ name: "Remote Squad Agent", provider: "codex", workspaceId: "remote" });
    const remoteSquad = store.createSquad({ name: "Remote Squad", leaderId: remoteAgent.id, workspaceId: "remote" });

    const squad = await app.request("/api/squads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Original Squad", leader_id: agent.id }),
    });
    const squadBody = await squad.json();
    expect(squad.status).toBe(201);
    expect(squadBody).toMatchObject({
      workspace_id: "local",
      leader_id: agent.id,
      member_count: 1,
      member_preview: [{ member_type: "agent", member_id: agent.id, role: "leader" }],
    });
    expect(squadBody.leaderId).toBeUndefined();
    const localSquads = await (await app.request("/api/squads?workspaceId=remote")).json();
    expect(localSquads.some((item: any) => item.id === remoteSquad.id)).toBe(false);
    const remoteSquads = await (await app.request("/api/squads?workspace_id=remote")).json();
    expect(remoteSquads.some((item: any) => item.id === remoteSquad.id)).toBe(true);
    expect(remoteSquads[0].workspaceId).toBeUndefined();
    expect((await (await app.request(`/api/squads/${squadBody.id}/members/status`)).json())[0].status).toBe("available");
    const squadMember = store.createWorkspaceMember({ name: "Squad API Member" });
    const camelSquadMember = await app.request(`/api/squads/${squadBody.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberType: "member", memberId: squadMember.id }),
    });
    expect(camelSquadMember.status).toBe(400);
    expect(await camelSquadMember.json()).toEqual({ error: "member_type must be 'agent' or 'member'" });
    const addedSquadMember = await app.request(`/api/squads/${squadBody.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_type: "member", member_id: squadMember.id, role: "reviewer" }),
    });
    expect(addedSquadMember.status).toBe(201);
    const addedSquadMemberBody = await addedSquadMember.json();
    expect(addedSquadMemberBody).toMatchObject({ member_type: "member", member_id: squadMember.id, role: "reviewer" });
    expect(addedSquadMemberBody.memberId).toBeUndefined();
    const listedSquadMembers = await (await app.request(`/api/squads/${squadBody.id}/members`)).json();
    expect(listedSquadMembers.some((member: any) => member.member_id === squadMember.id)).toBe(true);
    expect((await app.request(`/api/squads/${squadBody.id}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_type: "member", member_id: squadMember.id }),
    })).status).toBe(204);

    const autopilot = await app.request("/api/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Original Autopilot",
        project_id: projectBody.id,
        assignee_id: agent.id,
        execution_mode: "create_issue",
      }),
    });
    const autopilotBody = await autopilot.json();
    expect(autopilot.status).toBe(201);
    expect(autopilotBody.title).toBe("Original Autopilot");
    expect(autopilotBody.project_id).toBe(projectBody.id);
    expect(autopilotBody.assignee_id).toBe(agent.id);
    expect(autopilotBody.execution_mode).toBe("create_issue");
    expect(autopilotBody.projectId).toBeUndefined();

    const remoteAutopilot = store.createAutopilot({
      title: "Remote Autopilot",
      workspaceId: "remote",
      assigneeId: remoteAgent.id,
      executionMode: "run_only",
    });
    const camelWorkspaceAutopilots = await (await app.request("/api/autopilots?workspaceId=remote")).json();
    expect(camelWorkspaceAutopilots.autopilots.some((item: any) => item.id === remoteAutopilot.id)).toBe(false);
    const snakeWorkspaceAutopilots = await (await app.request("/api/autopilots?workspace_id=remote")).json();
    expect(snakeWorkspaceAutopilots.autopilots.map((item: any) => item.id)).toEqual([remoteAutopilot.id]);
    expect(snakeWorkspaceAutopilots.autopilots[0].workspaceId).toBeUndefined();

    const camelAutopilotCreate = await app.request("/api/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Camel Autopilot",
        projectId: projectBody.id,
        assigneeId: agent.id,
        executionMode: "create_issue",
      }),
    });
    expect(camelAutopilotCreate.status).toBe(400);
    expect(await camelAutopilotCreate.json()).toEqual({ error: "assignee_id is required" });

    const camelProjectAutopilot = await app.request("/api/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Camel Project Autopilot",
        workspaceId: "remote",
        projectId: projectBody.id,
        assignee_id: agent.id,
        execution_mode: "create_issue",
        issueTitleTemplate: "Camel {{title}}",
      }),
    });
    const camelProjectAutopilotBody = await camelProjectAutopilot.json();
    expect(camelProjectAutopilot.status).toBe(201);
    expect(camelProjectAutopilotBody.workspace_id).toBe("local");
    expect(camelProjectAutopilotBody.project_id).toBeNull();
    expect(camelProjectAutopilotBody.issue_title_template).toBeNull();

    const camelAutopilotUpdate = await app.request(`/api/autopilots/${camelProjectAutopilotBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: projectBody.id,
        executionMode: "run_only",
        issueTitleTemplate: "Updated {{title}}",
      }),
    });
    const camelAutopilotUpdateBody = await camelAutopilotUpdate.json();
    expect(camelAutopilotUpdate.status).toBe(200);
    expect(camelAutopilotUpdateBody.project_id).toBeNull();
    expect(camelAutopilotUpdateBody.execution_mode).toBe("create_issue");
    expect(camelAutopilotUpdateBody.issue_title_template).toBeNull();

    const run = await app.request(`/api/autopilots/${autopilotBody.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Run original autopilot" }),
    });
    const runBody = await run.json();
    expect(run.status).toBe(200);
    expect(runBody.source).toBe("manual");
    expect(runBody.autopilot_id).toBe(autopilotBody.id);
    expect(runBody.trigger_payload).toBeNull();
    expect(runBody.autopilotId).toBeUndefined();

    const runsBody = await (await app.request(`/api/autopilots/${autopilotBody.id}/runs`)).json();
    expect(runsBody.runs[0]).toMatchObject({ id: runBody.id, autopilot_id: autopilotBody.id, trigger_payload: null });
    expect(runsBody.total).toBe(1);

    const runDetailBody = await (await app.request(`/api/autopilots/${autopilotBody.id}/runs/${runBody.id}`)).json();
    expect(runDetailBody.id).toBe(runBody.id);
    expect(runDetailBody.trigger_payload).toBeNull();

    const trigger = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", label: "Original Webhook" }),
    });
    const triggerBody = await trigger.json();
    expect(trigger.status).toBe(201);
    expect(triggerBody.autopilot_id).toBe(autopilotBody.id);
    expect(triggerBody.webhook_token).toStartWith("awt_");
    expect(triggerBody.webhook_path).toBe(`/api/webhooks/autopilots/${triggerBody.webhook_token}`);
    expect(triggerBody.provider).toBe("generic");
    expect(triggerBody.has_signing_secret).toBe(false);
    expect(triggerBody.signing_secret_hint).toBeNull();
    expect(triggerBody.autopilotId).toBeUndefined();

    const camelWebhookFilters = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", label: "Camel Filters", eventFilters: [{ event: "push" }] }),
    });
    expect(camelWebhookFilters.status).toBe(201);
    expect((await camelWebhookFilters.json()).event_filters).toBeUndefined();

    const camelWebhookFilterPatch = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventFilters: [{ event: "push" }] }),
    });
    expect(camelWebhookFilterPatch.status).toBe(200);
    expect((await camelWebhookFilterPatch.json()).event_filters).toBeUndefined();

    const invalidTriggerKind = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "api" }),
    });
    expect(invalidTriggerKind.status).toBe(400);
    expect(await invalidTriggerKind.json()).toEqual({ error: "kind must be schedule, webhook, system_event, or scm_event" });

    const webhookTimezone = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", timezone: "UTC" }),
    });
    expect(webhookTimezone.status).toBe(400);
    expect(await webhookTimezone.json()).toEqual({ error: "timezone is not valid for webhook triggers" });

    const scheduleProvider = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "schedule", cron_expression: "*/5 * * * *", provider: "generic" }),
    });
    expect(scheduleProvider.status).toBe(400);
    expect(await scheduleProvider.json()).toEqual({ error: "provider is only valid for webhook triggers" });

    const invalidProvider = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook", provider: "slack" }),
    });
    expect(invalidProvider.status).toBe(400);
    expect(await invalidProvider.json()).toEqual({ error: "provider must be generic, github, or codebase" });

    const camelSchedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "schedule", cronExpression: "*/5 * * * *" }),
    });
    expect(camelSchedule.status).toBe(400);
    expect(await camelSchedule.json()).toEqual({ error: "cron_expression is required for schedule triggers" });

    const schedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "schedule", cron_expression: "*/5 * * * *", timezone: "UTC", label: "Every 5" }),
    });
    const scheduleBody = await schedule.json();
    expect(schedule.status).toBe(201);
    expect(scheduleBody.provider).toBeNull();
    expect(scheduleBody.next_run_at).toBeString();

    const camelSchedulePatch = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cronExpression: "*/10 * * * *" }),
    });
    const camelSchedulePatchBody = await camelSchedulePatch.json();
    expect(camelSchedulePatch.status).toBe(200);
    expect(camelSchedulePatchBody.cron_expression).toBe("*/5 * * * *");

    const scheduleEventFilters = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_filters: [{ event: "push" }] }),
    });
    expect(scheduleEventFilters.status).toBe(400);
    expect(await scheduleEventFilters.json()).toEqual({ error: "event_filters is only valid for webhook triggers" });

    const rotateSchedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}/rotate-webhook-token`, { method: "POST" });
    expect(rotateSchedule.status).toBe(400);
    expect(await rotateSchedule.json()).toEqual({ error: "trigger is not a webhook trigger" });

    const signSchedule = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${scheduleBody.id}/signing-secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signing_secret: "0123456789abcdef" }),
    });
    expect(signSchedule.status).toBe(400);
    expect(await signSchedule.json()).toEqual({ error: "trigger is not a webhook trigger" });

    const webhookCronPatch = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "*/5 * * * *" }),
    });
    expect(webhookCronPatch.status).toBe(400);
    expect(await webhookCronPatch.json()).toEqual({ error: "cron_expression is only valid for schedule triggers" });

    const shortSecret = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}/signing-secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signing_secret: "short" }),
    });
    expect(shortSecret.status).toBe(400);
    expect(await shortSecret.json()).toEqual({ error: "signing_secret must be at least 16 characters" });

    const signingSecret = "0123456789abcdef";
    const signedTrigger = await app.request(`/api/autopilots/${autopilotBody.id}/triggers/${triggerBody.id}/signing-secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signing_secret: signingSecret }),
    });
    const signedTriggerBody = await signedTrigger.json();
    expect(signedTrigger.status).toBe(200);
    expect(signedTriggerBody.has_signing_secret).toBe(true);
    expect(signedTriggerBody.signing_secret_hint).toBe("cdef");

    const missingSignatureWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Missing signature" }),
    });
    expect(missingSignatureWebhook.status).toBe(401);
    expect(await missingSignatureWebhook.json()).toMatchObject({ status: "rejected", reason: "missing_signature" });

    const signedPayload = JSON.stringify({ prompt: "Signed original autopilot" });
    const signedSignature = `sha256=${createHmac("sha256", signingSecret).update(signedPayload).digest("hex")}`;
    const signedWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signedSignature, "Idempotency-Key": "original-signed" },
      body: signedPayload,
    });
    expect(signedWebhook.status).toBe(200);
    expect(await signedWebhook.json()).toMatchObject({
      status: "accepted",
      autopilot_id: autopilotBody.id,
      trigger_id: triggerBody.id,
      delivery_id: expect.any(String),
      run_id: expect.any(String),
    });

    const triggerDetail = await app.request(`/api/autopilots/${autopilotBody.id}`);
    const triggerDetailBody = await triggerDetail.json();
    expect(triggerDetailBody.triggers[0].id).toBe(triggerBody.id);
    expect(triggerDetailBody.triggers[0].autopilotId).toBeUndefined();

    expect((await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, { method: "DELETE" })).status).toBe(204);
    const missingCompatibilityDelete = await app.request(`/api/projects/${projectBody.id}/resources/${resourceBody.id}`, { method: "DELETE" });
    expect(missingCompatibilityDelete.status).toBe(404);
    expect(await missingCompatibilityDelete.json()).toEqual({ error: "project resource not found" });
    expect((await app.request(`/api/squads/${squadBody.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/api/autopilots/${autopilotBody.id}`, { method: "DELETE" })).status).toBe(204);
    const deletedProject = await app.request(`/api/projects/${projectBody.id}`, { method: "DELETE" });
    expect(deletedProject.status).toBe(204);
    expect(events.find((event) =>
      event.type === "project:updated"
      && typeof event.payload.project === "object"
      && event.payload.project !== null
      && "archived_at" in event.payload.project
      && event.payload.project.archived_at !== null
    )).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: { project: { id: projectBody.id, status: "cancelled", archived_at: expect.any(String) } },
    });
    const archivedProjectBody = await (await app.request(`/api/projects/${projectBody.id}`)).json();
    expect(archivedProjectBody.archived_at).toBeString();
    const restoredProjectResponse = await app.request(`/api/projects/${projectBody.id}/restore`, { method: "POST" });
    expect(restoredProjectResponse.status).toBe(200);
    expect((await restoredProjectResponse.json()).archived_at).toBeNull();
    const missingProjectDelete = await app.request("/api/projects/missing-project", { method: "DELETE" });
    expect(missingProjectDelete.status).toBe(404);
    expect(await missingProjectDelete.json()).toEqual({ error: "project not found" });
  });
});
