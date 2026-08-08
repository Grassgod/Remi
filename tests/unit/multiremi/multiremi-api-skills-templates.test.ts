// Workspace skills, agent skill assignment, native skill wrappers, agent templates,
// and skill import from GitHub / skills.sh.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, jsonResponse, metricValue, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — skills and agent templates", () => {
  it("serves workspace skills and agent skill assignment endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "skl_api",
        workspace_id: "local",
        name: "API Skill",
        description: "API managed skill",
        content: "# API Skill",
        files: [{ path: "notes/guide.md", content: "Guide" }],
      }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).skill.files[0].path).toBe("notes/guide.md");

    const list = await app.request("/api/skills?workspace_id=local");
    const listBody = await list.json();
    expect(listBody[0].id).toBe("skl_api");
    expect(listBody[0].workspace_id).toBe("local");
    expect(Object.keys(listBody[0]).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(listBody[0].content).toBeUndefined();
    expect(listBody[0].files).toBeUndefined();
    expect(listBody[0].workspaceId).toBeUndefined();

    const multiremiList = await app.request("/api/multiremi/skills?workspace_id=local");
    expect((await multiremiList.json()).skills[0].content).toBeUndefined();

    const invalidCreateJson = await app.request("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCreateJson.status).toBe(400);
    expect(await invalidCreateJson.json()).toEqual({ error: "invalid request body" });

    const namelessCreate = await app.request("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Missing name" }),
    });
    expect(namelessCreate.status).toBe(400);
    expect(await namelessCreate.json()).toEqual({ error: "name is required" });

    const reservedSupportingFile = await app.request("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Reserved Skill",
        content: "# Reserved",
        files: [
          { path: "sub/../SKILL.md", content: "Duplicate primary content" },
          { path: "notes/a..b.md", content: "Safe dots" },
        ],
      }),
    });
    expect(reservedSupportingFile.status).toBe(201);
    const reservedBody = await reservedSupportingFile.json();
    expect(reservedBody.files.map((file: any) => file.path)).toEqual(["notes/a..b.md"]);

    const detail = await app.request("/api/skills/skl_api");
    const detailBody = await detail.json();
    expect(detailBody.content).toBe("# API Skill");
    expect(detailBody.workspace_id).toBe("local");
    expect(detailBody.files[0].content).toBe("Guide");
    expect(detailBody.files[0].skill_id).toBe("skl_api");
    expect(detailBody.files[0].skillId).toBeUndefined();
    expect(Object.keys(detailBody).filter((key) => /[A-Z]/.test(key))).toEqual([]);

    const invalidAssignJson = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidAssignJson.status).toBe(400);
    expect(await invalidAssignJson.json()).toEqual({ error: "invalid request body" });

    const missingAssign = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: ["skl_missing"] }),
    });
    expect(missingAssign.status).toBe(404);
    expect(await missingAssign.json()).toEqual({ error: "skill not found" });

    const assign = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_ids: ["skl_api"] }),
    });
    expect(assign.status).toBe(200);
    const assignBody = await assign.json();
    expect(assignBody[0].name).toBe("API Skill");
    expect(assignBody[0].workspace_id).toBe("local");
    expect(assignBody[0].content).toBeUndefined();
    expect(assignBody[0].files).toBeUndefined();
    expect(Object.keys(assignBody[0]).filter((key) => /[A-Z]/.test(key))).toEqual([]);

    const agentDetail = await app.request(`/api/multiremi/agents/${agent.id}`);
    const agentBody = await agentDetail.json();
    expect(agentBody.agent.skills[0].files[0].path).toBe("notes/guide.md");

    const deleted = await app.request("/api/skills/skl_api", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const afterDelete = await app.request(`/api/multiremi/agents/${agent.id}/skills`);
    expect((await afterDelete.json()).skills).toHaveLength(0);
  });

  it("gates Go-compatible skill mutations by creator/admin and emits workspace events", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ id: "ws_skill_guard", name: "Skill Guard", slug: "skill-guard" });
    store.createWorkspaceMember({
      id: "skill-admin",
      workspaceId: workspace.id,
      name: "Skill Admin",
      email: "skill-admin@example.com",
      role: "admin",
    });
    const creator = store.createWorkspaceMember({
      id: "skill-creator",
      workspaceId: workspace.id,
      name: "Skill Creator",
      email: "skill-creator@example.com",
      role: "member",
    });
    const plain = store.createWorkspaceMember({
      id: "skill-member",
      workspaceId: workspace.id,
      name: "Skill Member",
      email: "skill-member@example.com",
      role: "member",
    });
    const agent = store.createAgent({
      name: "Skill Guard Agent",
      provider: "claude",
      workspaceId: workspace.id,
      ownerId: creator.id,
      visibility: "workspace",
    });
    const ownerToken = await store.createAccessToken({ name: "Skill Owner", type: "pat", workspaceId: workspace.id, userId: "local" });
    const adminToken = await store.createAccessToken({ name: "Skill Admin", type: "pat", workspaceId: workspace.id, userId: "skill-admin" });
    const creatorToken = await store.createAccessToken({ name: "Skill Creator", type: "pat", workspaceId: workspace.id, userId: creator.id });
    const memberToken = await store.createAccessToken({ name: "Skill Member", type: "pat", workspaceId: workspace.id, userId: plain.id });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    const created = await app.request("/api/skills", {
      method: "POST",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({
        workspace_id: workspace.id,
        name: "Guarded Skill",
        content: "# Guarded",
        created_by: "forged",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.workspace_id).toBe(workspace.id);
    expect(createdBody.created_by).toBe(creator.id);

    const createdEvent = events.find((event) => event.type === "skill:created");
    expect(createdEvent).toMatchObject({
      workspaceId: workspace.id,
      actorId: creator.id,
      actorType: "member",
      payload: { skill: { id: createdBody.id, workspace_id: workspace.id, created_by: creator.id } },
    });

    const memberRead = await app.request(`/api/skills/${createdBody.id}`, { headers: authHeaders(memberToken.token) });
    expect(memberRead.status).toBe(200);

    const memberUpdate = await app.request(`/api/skills/${createdBody.id}`, {
      method: "PATCH",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ description: "Nope" }),
    });
    expect(memberUpdate.status).toBe(403);
    expect(await memberUpdate.json()).toEqual({ error: "only the skill creator can manage this skill" });

    const creatorUpdate = await app.request(`/api/skills/${createdBody.id}`, {
      method: "PATCH",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({ description: "Updated", workspace_id: "local", created_by: plain.id }),
    });
    expect(creatorUpdate.status).toBe(200);
    const updatedBody = await creatorUpdate.json();
    expect(updatedBody.workspace_id).toBe(workspace.id);
    expect(updatedBody.created_by).toBe(creator.id);
    expect(updatedBody.description).toBe("Updated");
    expect(events.some((event) =>
      event.type === "skill:updated" &&
      event.actorId === creator.id &&
      (event.payload.skill as any)?.id === createdBody.id
    )).toBe(true);

    const memberFilePut = await app.request(`/api/skills/${createdBody.id}/files`, {
      method: "PUT",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ path: "notes/nope.md", content: "Nope" }),
    });
    expect(memberFilePut.status).toBe(403);
    expect(await memberFilePut.json()).toEqual({ error: "only the skill creator can manage this skill" });

    const adminFilePut = await app.request(`/api/skills/${createdBody.id}/files`, {
      method: "PUT",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ path: "notes/admin.md", content: "Admin note" }),
    });
    expect(adminFilePut.status).toBe(200);
    const fileBody = await adminFilePut.json();
    expect(fileBody.skill_id).toBe(createdBody.id);

    const memberFileDelete = await app.request(`/api/skills/${createdBody.id}/files/${fileBody.id}`, {
      method: "DELETE",
      headers: authHeaders(memberToken.token),
    });
    expect(memberFileDelete.status).toBe(403);

    const adminFileDelete = await app.request(`/api/skills/${createdBody.id}/files/${fileBody.id}`, {
      method: "DELETE",
      headers: authHeaders(adminToken.token),
    });
    expect(adminFileDelete.status).toBe(204);

    const memberBind = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ skill_ids: [createdBody.id] }),
    });
    expect(memberBind.status).toBe(403);
    expect(await memberBind.json()).toEqual({ error: "only the agent owner can manage this agent" });

    const creatorBind = await app.request(`/api/agents/${agent.id}/skills`, {
      method: "PUT",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({ skill_ids: [createdBody.id] }),
    });
    expect(creatorBind.status).toBe(200);
    expect((await creatorBind.json())[0].id).toBe(createdBody.id);
    expect(events.some((event) =>
      event.type === "agent:status" &&
      event.actorId === creator.id &&
      event.workspaceId === workspace.id &&
      (event.payload.skills as any[])?.[0]?.id === createdBody.id
    )).toBe(true);

    const memberDelete = await app.request(`/api/skills/${createdBody.id}`, {
      method: "DELETE",
      headers: authHeaders(memberToken.token),
    });
    expect(memberDelete.status).toBe(403);

    const ownerDelete = await app.request(`/api/skills/${createdBody.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken.token),
    });
    expect(ownerDelete.status).toBe(204);
    expect(events.some((event) =>
      event.type === "skill:deleted" &&
      event.actorId === "local" &&
      event.workspaceId === workspace.id &&
      event.payload.skill_id === createdBody.id
    )).toBe(true);
  });

  it("gates native skill wrapper routes with workspace scope and Go-style events", async () => {
    const store = createStore();
    const workspace = store.createWorkspace({ id: "ws_native_skill_guard", name: "Native Skill Guard", slug: "native-skill-guard" });
    store.createWorkspaceMember({
      id: "native-skill-admin",
      workspaceId: workspace.id,
      name: "Native Skill Admin",
      email: "native-skill-admin@example.com",
      role: "admin",
    });
    const creator = store.createWorkspaceMember({
      id: "native-skill-creator",
      workspaceId: workspace.id,
      name: "Native Skill Creator",
      email: "native-skill-creator@example.com",
      role: "member",
    });
    const plain = store.createWorkspaceMember({
      id: "native-skill-member",
      workspaceId: workspace.id,
      name: "Native Skill Member",
      email: "native-skill-member@example.com",
      role: "member",
    });
    store.createSkill({ workspaceId: "local", name: "Local Only Skill", content: "# Local" });
    store.createSkill({ workspaceId: "ws_native_other", name: "Other Workspace Skill", content: "# Other" });
    const adminToken = await store.createAccessToken({ name: "Native Skill Admin", type: "pat", workspaceId: workspace.id, userId: "native-skill-admin" });
    const creatorToken = await store.createAccessToken({ name: "Native Skill Creator", type: "pat", workspaceId: workspace.id, userId: creator.id });
    const memberToken = await store.createAccessToken({ name: "Native Skill Member", type: "pat", workspaceId: workspace.id, userId: plain.id });
    const otherToken = await store.createAccessToken({ name: "Other Native Skill", type: "pat", workspaceId: "ws_native_other", userId: "local" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

    const created = await app.request("/api/multiremi/skills", {
      method: "POST",
      headers: jsonHeaders(creatorToken.token),
      body: JSON.stringify({
        workspace_id: workspace.id,
        name: "Native Guarded Skill",
        content: "# Native",
        createdBy: "forged-native",
        files: [{ path: "docs/native.md", content: "Native note" }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.skill.workspaceId).toBe(workspace.id);
    expect(createdBody.skill.createdBy).toBe(creator.id);
    expect(createdBody.skill.files[0].path).toBe("docs/native.md");
    expect(events.some((event) =>
      event.type === "skill:created" &&
      event.actorId === creator.id &&
      (event.payload.skill as any)?.workspace_id === workspace.id
    )).toBe(true);

    const scopedList = await app.request("/api/multiremi/skills", { headers: authHeaders(memberToken.token) });
    const scopedListBody = await scopedList.json();
    expect(scopedList.status).toBe(200);
    expect(scopedListBody.total).toBe(1);
    expect(scopedListBody.skills[0].name).toBe("Native Guarded Skill");
    expect(scopedListBody.skills[0].content).toBeUndefined();

    const scopedSearch = await app.request("/api/multiremi/skills/search?q=Skill", { headers: authHeaders(memberToken.token) });
    const scopedSearchBody = await scopedSearch.json();
    expect(scopedSearchBody.skills.map((skill: any) => skill.name)).toEqual(["Native Guarded Skill"]);

    const crossWorkspaceDetail = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, { headers: authHeaders(otherToken.token) });
    expect(crossWorkspaceDetail.status).toBe(404);
    expect(await crossWorkspaceDetail.json()).toEqual({ error: "skill not found" });

    const memberUpdate = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, {
      method: "PATCH",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ description: "Nope" }),
    });
    expect(memberUpdate.status).toBe(403);
    expect(await memberUpdate.json()).toEqual({ error: "only the skill creator can manage this skill" });

    const adminUpdate = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ description: "Native updated", workspaceId: "local", createdBy: plain.id }),
    });
    expect(adminUpdate.status).toBe(200);
    const updatedBody = await adminUpdate.json();
    expect(updatedBody.skill.workspaceId).toBe(workspace.id);
    expect(updatedBody.skill.createdBy).toBe(creator.id);
    expect(updatedBody.skill.description).toBe("Native updated");
    expect(events.some((event) =>
      event.type === "skill:updated" &&
      event.actorId === "native-skill-admin" &&
      (event.payload.skill as any)?.id === createdBody.skill.id
    )).toBe(true);

    const deleted = await app.request(`/api/multiremi/skills/${createdBody.skill.id}`, {
      method: "DELETE",
      headers: authHeaders(adminToken.token),
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).skill.archivedAt).toBeString();
    expect(events.some((event) =>
      event.type === "skill:deleted" &&
      event.actorId === "native-skill-admin" &&
      event.payload.skill_id === createdBody.skill.id
    )).toBe(true);
  });

  it("serves agent templates and creates agents from templates", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const codexRuntime = store.registerRuntime({ id: "rt_template_codex", name: "Template Codex", provider: "codex" });
    const claudeRuntime = store.registerRuntime({ id: "rt_template_claude", name: "Template Claude", provider: "claude" });
    const existingSkill = store.createSkill({
      workspaceId: "local",
      name: "root-cause-tracing",
      description: "Trace bugs",
      content: "# Root cause",
    });

    const templates = await app.request("/api/agent-templates");
    const templateBody = await templates.json();
    expect(templateBody.length).toBeGreaterThan(10);
    expect(templateBody.find((template: any) => template.slug === "bug-fixer")?.instructions).toBeUndefined();
    expect(templateBody.find((template: any) => template.slug === "bug-fixer")?.skills[0].cached_name).toBe("root-cause-tracing");

    const detail = await app.request("/api/agent-templates/bug-fixer");
    const detailBody = await detail.json();
    expect(detailBody.instructions).toContain("You debug systematically");

    const invalidTemplateCreate = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidTemplateCreate.status).toBe(400);
    expect(await invalidTemplateCreate.json()).toEqual({ error: "invalid request body" });

    const invalidNativeTemplateCreate = await app.request("/api/multiremi/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativeTemplateCreate.status).toBe(400);
    expect(await invalidNativeTemplateCreate.json()).toEqual({ error: "invalid request body" });

    const unknownProviderTemplate = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_slug: "summarizer", name: "No Runtime", provider: "gemini" }),
    });
    expect(unknownProviderTemplate.status).toBe(400);
    expect(await unknownProviderTemplate.json()).toMatchObject({ error: 'unknown provider "gemini"' });

    const multiremiTemplates = await app.request("/api/multiremi/agent-templates");
    const multiremiTemplatesBody = await multiremiTemplates.json();
    expect(multiremiTemplatesBody.total).toBe(templateBody.length);

    const created = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "bug-fixer",
        name: "Bug Fixer Agent",
        provider: "codex",
        runtime_id: codexRuntime.id,
        avatar_url: "https://example.com/template-bug-fixer.png",
        extra_skill_ids: [existingSkill.id],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.agent.name).toBe("Bug Fixer Agent");
    expect(createdBody.agent.provider).toBe("codex");
    expect(store.getAgent(createdBody.agent.id)?.provider).toBe("codex");
    expect(createdBody.agent.runtime_id).toBe("");
    expect(store.getAgent(createdBody.agent.id)?.runtimeId).toBeNull();
    expect(createdBody.agent.avatar_url).toBe("https://example.com/template-bug-fixer.png");
    expect(store.getAgent(createdBody.agent.id)?.avatarUrl).toBe("https://example.com/template-bug-fixer.png");
    expect(createdBody.agent.max_concurrent_tasks).toBe(6);
    expect(createdBody.agent.instructions).toContain("root cause");
    expect(createdBody.imported_skill_ids).toEqual([]);
    expect(createdBody.reused_skill_ids).toEqual([existingSkill.id]);
    expect(store.listAgentSkills(createdBody.agent.id).map((skill) => skill.id)).toEqual([existingSkill.id]);

    const duplicate = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "summarizer",
        name: "Bug Fixer Agent",
        runtime_id: codexRuntime.id,
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "an agent named \"Bug Fixer Agent\" already exists in this workspace" });

    const multiremiCreated = await app.request("/api/multiremi/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateSlug: "summarizer",
        name: "Summarizer Agent",
        provider: "claude",
        runtimeId: claudeRuntime.id,
      }),
    });
    expect(multiremiCreated.status).toBe(201);
    const multiremiCreatedBody = await multiremiCreated.json();
    expect(multiremiCreatedBody.agent.name).toBe("Summarizer Agent");
    expect(multiremiCreatedBody.importedSkillIds).toEqual([]);
    expect(multiremiCreatedBody.reusedSkillIds).toEqual([]);
    const agentCreatedEvents = store.listAnalyticsEvents({ name: "agent_created" });
    expect(agentCreatedEvents).toHaveLength(2);
    expect(agentCreatedEvents[0]!.properties).toMatchObject({
      agent_id: createdBody.agent.id,
      provider: "codex",
      runtime_mode: "local",
      template: "bug-fixer",
      is_first_agent_in_workspace: true,
      source: "manual",
    });
    expect(agentCreatedEvents[1]!.properties).toMatchObject({
      agent_id: multiremiCreatedBody.agent.id,
      provider: "claude",
      runtime_mode: "local",
      template: "summarizer",
      is_first_agent_in_workspace: false,
      source: "manual",
    });
    expect(metricValue(store, "multiremi_agent_created_total", { runtime_mode: "local", source: "manual" })).toBe(2);

    const missing = await app.request("/api/agent-templates/not-real");
    expect(missing.status).toBe(404);
  });

  it("reuses imported template skills by resolved skill name", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const runtime = store.registerRuntime({ id: "rt_template_reuse", name: "Template reuse", provider: "codex" });
    const existing = store.createSkill({
      workspaceId: "local",
      name: "vercel-react-best-practices",
      description: "Existing real frontmatter name",
      content: "# Existing",
    });
    mockFetch((url) => {
      if (url === "https://api.github.com/repos/vercel-labs/agent-skills") {
        return jsonResponse({ default_branch: "main" });
      }
      if (url === "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md") {
        return new Response("---\nname: vercel-react-best-practices\ndescription: React best practices\n---\n# Body");
      }
      if (url === "https://api.github.com/repos/vercel-labs/agent-skills/git/trees/main?recursive=1") {
        return jsonResponse({ tree: [{ path: "skills/react-best-practices/SKILL.md", type: "blob" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const response = await app.request("/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_slug: "code-reviewer",
        name: "Reviewer from Template",
        provider: "codex",
        runtime_id: runtime.id,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.imported_skill_ids).toEqual([]);
    expect(body.reused_skill_ids).toEqual([existing.id]);
    expect(store.listSkills("local")).toHaveLength(1);
    expect(store.listAgentSkills(body.agent.id).map((skill) => skill.id)).toEqual([existing.id]);
  });

  it("imports skills from GitHub and skills.sh URLs", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const skillMd = [
      "---",
      "name: review-helper",
      "description: Review imported pull requests",
      "---",
      "# Review Helper",
    ].join("\n");
    const requestedUrls: string[] = [];

    mockFetch((url) => {
      requestedUrls.push(url);
      if (url === "https://api.github.com/repos/example/skills/commits/main") return new Response("sha", { status: 200 });
      if (url === "https://raw.githubusercontent.com/example/skills/main/review-helper/SKILL.md") return new Response(skillMd);
      if (url === "https://api.github.com/repos/example/skills/contents/review-helper?ref=main") {
        return jsonResponse([
          { name: "SKILL.md", path: "review-helper/SKILL.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/SKILL.md" },
          { name: "templates", path: "review-helper/templates", type: "dir", url: "https://api.github.com/repos/example/skills/contents/review-helper/templates?ref=main" },
          { name: "logo.png", path: "review-helper/logo.png", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/logo.png" },
        ]);
      }
      if (url === "https://api.github.com/repos/example/skills/contents/review-helper/templates?ref=main") {
        return jsonResponse([
          { name: "check.md", path: "review-helper/templates/check.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/review-helper/templates/check.md" },
        ]);
      }
      if (url === "https://raw.githubusercontent.com/example/skills/main/review-helper/templates/check.md") return new Response("Check list");

      if (url === "https://api.github.com/repos/example/skills") return jsonResponse({ default_branch: "main" });
      if (url === "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/SKILL.md") return new Response(skillMd);
      if (url === "https://api.github.com/repos/example/skills/contents/skills/review-helper?ref=main") {
        return jsonResponse([
          { name: "SKILL.md", path: "skills/review-helper/SKILL.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/SKILL.md" },
          { name: "notes.md", path: "skills/review-helper/notes.md", type: "file", download_url: "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/notes.md" },
        ]);
      }
      if (url === "https://raw.githubusercontent.com/example/skills/main/skills/review-helper/notes.md") return new Response("Notes");
      return new Response("not found", { status: 404 });
    });

    const githubImport = await app.request("/api/multiremi/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://github.com/example/skills/tree/main/review-helper", workspaceId: "local" }),
    });
    expect(githubImport.status).toBe(201);
    const githubBody = await githubImport.json();
    expect(githubBody.source).toBe("github");
    expect(githubBody.skill.name).toBe("review-helper");
    expect(githubBody.skill.description).toBe("Review imported pull requests");
    expect(githubBody.skill.config.origin.type).toBe("github");
    expect(githubBody.skill.files).toHaveLength(1);
    expect(githubBody.skill.files[0].path).toBe("templates/check.md");
    expect(githubBody.skill.files[0].content).toBe("Check list");

    const skillsShImport = await app.request("/api/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://skills.sh/example/skills/review-helper", workspaceId: "local", name: "Imported Review" }),
    });
    expect(skillsShImport.status).toBe(201);
    const skillsShBody = await skillsShImport.json();
    expect(skillsShBody.name).toBe("Imported Review");
    expect(skillsShBody.workspace_id).toBe("local");
    expect(skillsShBody.config.origin.type).toBe("skills_sh");
    expect(skillsShBody.files[0].path).toBe("notes.md");
    expect(skillsShBody.files[0].skill_id).toBe(skillsShBody.id);
    expect(skillsShBody.files[0].skillId).toBeUndefined();
    expect(Object.keys(skillsShBody).filter((key) => /[A-Z]/.test(key))).toEqual([]);

    const duplicateSkillsShImport = await app.request("/api/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://skills.sh/example/skills/review-helper", workspaceId: "local", name: "Imported Review" }),
    });
    expect(duplicateSkillsShImport.status).toBe(409);
    expect(await duplicateSkillsShImport.json()).toEqual({
      error: "a skill with this name already exists",
      existing_skill: { id: skillsShBody.id, name: "Imported Review" },
    });
    expect(requestedUrls).toContain("https://api.github.com/repos/example/skills/contents/skills/review-helper?ref=main");
  });

  it("serves direct skill PUT compatibility endpoint", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const skill = store.createSkill({ name: "api-skill", content: "# API Skill" });

    const updated = await app.request(`/api/skills/${skill.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated through direct PUT" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).description).toBe("Updated through direct PUT");
  });
});
