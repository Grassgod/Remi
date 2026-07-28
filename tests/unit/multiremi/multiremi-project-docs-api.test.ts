import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { MultiremiStore } from "@multiremi/store.js";

let db: Database | null = null;
let previousFetch: typeof globalThis.fetch | null = null;

function createStore(): MultiremiStore {
  db = new Database(":memory:");
  return new MultiremiStore(db);
}

afterEach(() => {
  db?.close();
  db = null;
  if (previousFetch) {
    globalThis.fetch = previousFetch;
    previousFetch = null;
  }
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  previousFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof globalThis.fetch;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Bun Multiremi project docs API", () => {
  it("lists, searches, and reads docs by id or slug", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Docs API" });
    const wiki = store.createProjectDoc(project.id, { kind: "wiki", title: "Build guide", body: "run bun test" });
    store.createProjectDoc(project.id, { kind: "memory", title: "The CI box is arm64" });

    const listed = await app.request(`/api/projects/${project.id}/docs`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    // The first doc of a project seeds `_schema`, which is an ordinary wiki page.
    expect(listedBody.docs.map((doc: any) => doc.slug).sort()).toEqual(["_schema", "build-guide", "the-ci-box-is-arm64"]);

    const wikiOnly = await app.request(`/api/projects/${project.id}/docs?kind=wiki`);
    expect((await wikiOnly.json()).docs.map((doc: any) => doc.slug).sort()).toEqual(["_schema", "build-guide"]);

    const searched = await app.request(`/api/projects/${project.id}/docs?q=arm64`);
    expect((await searched.json()).docs.map((doc: any) => doc.title)).toEqual(["The CI box is arm64"]);

    const searchedLimit = await app.request(`/api/projects/${project.id}/docs?q=e&limit=1`);
    expect((await searchedLimit.json()).docs).toHaveLength(1);

    const bySlug = await app.request(`/api/projects/${project.id}/docs/build-guide`);
    expect(bySlug.status).toBe(200);
    expect((await bySlug.json()).doc).toMatchObject({
      id: wiki.id,
      project_id: project.id,
      workspace_id: "local",
      kind: "wiki",
      slug: "build-guide",
      title: "Build guide",
      body: "run bun test",
      tags: [],
      pinned: false,
      refs: [],
      source_task_id: null,
      source_issue_id: null,
      version: 1,
    });

    const byId = await app.request(`/api/projects/${project.id}/docs/${wiki.id}`);
    expect((await byId.json()).doc.slug).toBe("build-guide");

    expect((await app.request(`/api/projects/${project.id}/docs/nope`)).status).toBe(404);
    expect((await app.request("/api/projects/prj_missing/docs")).status).toBe(404);
  });

  it("creates docs with member provenance and round-trips refs", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Refs" });

    const created = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        kind: "wiki",
        title: "Deploy runbook",
        summary: "How production ships",
        body: "See [[build-guide]].",
        tags: ["ops", "runbook"],
        refs: [
          { type: "issue", value: "MUL-12" },
          { type: "url", value: "https://example.test/deploy" },
        ],
        // A member has no task, so agent-only provenance is dropped.
        source_task_id: "tsk_forged",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.doc).toMatchObject({
      kind: "wiki",
      slug: "deploy-runbook",
      title: "Deploy runbook",
      summary: "How production ships",
      tags: ["ops", "runbook"],
      pinned: false,
      refs: [
        { type: "issue", value: "MUL-12" },
        { type: "url", value: "https://example.test/deploy" },
      ],
      source_task_id: null,
      author_type: "member",
      author_id: "local",
      version: 1,
    });

    const fetched = await app.request(`/api/projects/${project.id}/docs/deploy-runbook`);
    expect((await fetched.json()).doc.refs).toEqual([
      { type: "issue", value: "MUL-12" },
      { type: "url", value: "https://example.test/deploy" },
    ]);
  });

  it("stamps agent provenance and backfills the issue behind the task", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const project = store.createProject({ title: "Agent writes" });
    const agent = store.createAgent({ name: "Scribe", provider: "claude" });
    const issue = store.createIssue({ title: "Ship it", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "work" });
    const taskToken = await store.createTaskAccessToken(task, "local");

    const created = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${taskToken.token}` },
      body: JSON.stringify({
        kind: "memory",
        title: "Node 18 breaks the build",
        source_task_id: task.id,
        author_type: "member",
        author_id: "forged-member",
      }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).doc).toMatchObject({
      kind: "memory",
      pinned: true,
      author_type: "agent",
      author_id: agent.id,
      source_task_id: task.id,
      source_issue_id: issue.id,
    });
  });

  it("ignores a caller-supplied id and mints its own", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Server-minted ids" });

    const created = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "wiki", title: "Chosen key", id: "pdoc_caller_chosen" }),
    });
    expect(created.status).toBe(201);
    const doc = (await created.json()).doc;
    expect(doc.id).not.toBe("pdoc_caller_chosen");
    expect(doc.id.startsWith("pdoc")).toBe(true);
    expect(store.getProjectDoc("pdoc_caller_chosen")).toBeNull();
  });

  it("takes doc provenance from the task token, never from the body", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const project = store.createProject({ title: "Own project" });
    const agent = store.createAgent({ name: "Scribe", provider: "claude" });
    const issue = store.createIssue({ title: "Own issue", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "work" });
    const taskToken = await store.createTaskAccessToken(task, "local");

    // A task in another workspace entirely — its id and its issue id must not
    // be reachable by writing them into the request body.
    const foreignWorkspace = store.createWorkspace({ name: "Foreign", slug: "foreign" });
    const foreignAgent = store.createAgent({ name: "Stranger", provider: "claude", workspaceId: foreignWorkspace.id });
    const foreignProject = store.createProject({ title: "Foreign project", workspaceId: foreignWorkspace.id });
    const foreignIssue = store.createIssue({ title: "Foreign issue", projectId: foreignProject.id, workspaceId: foreignWorkspace.id });
    const foreignTask = store.createTask({
      agentId: foreignAgent.id,
      issueId: foreignIssue.id,
      workspaceId: foreignWorkspace.id,
      prompt: "not yours",
    });

    const created = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${taskToken.token}` },
      body: JSON.stringify({
        kind: "memory",
        title: "Provenance is server-side",
        source_task_id: foreignTask.id,
        source_issue_id: foreignIssue.id,
      }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).doc).toMatchObject({
      source_task_id: task.id,
      source_issue_id: issue.id,
    });
  });

  it("confines a task token to the project of its own issue", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const agent = store.createAgent({ name: "Scribe", provider: "claude" });
    const ownProject = store.createProject({ title: "Own project" });
    const ownIssue = store.createIssue({ title: "Own issue", projectId: ownProject.id });
    const task = store.createTask({ agentId: agent.id, issueId: ownIssue.id, workspaceId: "local", prompt: "work" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    // Same workspace, different project: workspace membership alone is not the
    // boundary for project knowledge.
    const otherProject = store.createProject({ title: "Other project" });
    store.createProjectDoc(otherProject.id, { kind: "wiki", title: "Other secret" });

    const auth = { Authorization: `Bearer ${taskToken.token}` };

    // Read is confined.
    expect((await app.request(`/api/projects/${ownProject.id}/docs`, { headers: auth })).status).toBe(200);
    const foreignList = await app.request(`/api/projects/${otherProject.id}/docs`, { headers: auth });
    expect(foreignList.status).toBe(404);
    expect(await foreignList.json()).toEqual({ error: "project not found" });
    expect((await app.request(`/api/projects/${otherProject.id}/docs/other-secret`, { headers: auth })).status).toBe(404);
    expect((await app.request(`/api/projects/${otherProject.id}/docs/other-secret/revisions`, { headers: auth })).status).toBe(404);

    // Write is confined.
    const foreignCreate = await app.request(`/api/projects/${otherProject.id}/docs`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...auth },
      body: JSON.stringify({ kind: "memory", title: "Planted" }),
    });
    expect(foreignCreate.status).toBe(404);
    const foreignUpdate = await app.request(`/api/projects/${otherProject.id}/docs/other-secret`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, ...auth },
      body: JSON.stringify({ body: "overwritten" }),
    });
    expect(foreignUpdate.status).toBe(404);
    const foreignDelete = await app.request(`/api/projects/${otherProject.id}/docs/other-secret`, {
      method: "DELETE",
      headers: auth,
    });
    expect(foreignDelete.status).toBe(404);
    expect(store.getProjectDocByRef(otherProject.id, "other-secret")).not.toBeNull();
    expect(store.getProjectDocByRef(otherProject.id, "other-secret")!.body).toBe("");

    // A non-task caller reaching both projects is untouched by the rule.
    expect((await app.request(`/api/projects/${otherProject.id}/docs`, {
      headers: { Authorization: "Bearer root-secret" },
    })).status).toBe(200);
  });

  it("denies a task token whose task has no project behind it", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const agent = store.createAgent({ name: "Scribe", provider: "claude" });
    const project = store.createProject({ title: "Unreachable" });
    const looseIssue = store.createIssue({ title: "No project" });
    const looseTask = store.createTask({ agentId: agent.id, issueId: looseIssue.id, workspaceId: "local", prompt: "work" });
    const looseToken = await store.createTaskAccessToken(looseTask, "local");
    const chatTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "no issue at all" });
    const chatToken = await store.createTaskAccessToken(chatTask, "local");

    for (const token of [looseToken, chatToken]) {
      const listed = await app.request(`/api/projects/${project.id}/docs`, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      expect(listed.status).toBe(404);
      expect(await listed.json()).toEqual({ error: "project not found" });
    }
  });

  it("updates docs, bumps versions, and records revisions", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Updates" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Architecture", body: "v1 body" });

    const updated = await app.request(`/api/projects/${project.id}/docs/architecture`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: "Architecture notes",
        body: "v2 body",
        tags: ["design"],
        pinned: true,
        refs: [{ type: "task", value: "tsk_1" }],
        expected_version: 1,
      }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).doc).toMatchObject({
      title: "Architecture notes",
      body: "v2 body",
      tags: ["design"],
      pinned: true,
      refs: [{ type: "task", value: "tsk_1" }],
      updated_by_type: "member",
      updated_by_id: "local",
      version: 2,
    });

    const stale = await app.request(`/api/projects/${project.id}/docs/architecture`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: "v3 body", expected_version: 1 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "project doc version conflict" });

    const revisions = await app.request(`/api/projects/${project.id}/docs/architecture/revisions`);
    expect(revisions.status).toBe(200);
    const revisionsBody = await revisions.json();
    expect(revisionsBody.revisions.map((revision: any) => revision.version)).toEqual([2, 1]);
    expect(revisionsBody.revisions[0]).toMatchObject({
      title: "Architecture notes",
      body: "v2 body",
      author_type: "member",
      author_id: "local",
    });

    expect((await app.request(`/api/projects/${project.id}/docs/missing/revisions`)).status).toBe(404);
  });

  it("deletes docs and reports them gone afterwards", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Deletes" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Temporary" });

    const deleted = await app.request(`/api/projects/${project.id}/docs/temporary`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect((await app.request(`/api/projects/${project.id}/docs/temporary`)).status).toBe(404);

    const missing = await app.request(`/api/projects/${project.id}/docs/temporary`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "project doc not found" });
  });

  it("maps store validation failures onto status codes", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Errors" });

    const noTitle = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "wiki", title: "   " }),
    });
    expect(noTitle.status).toBe(400);
    expect(await noTitle.json()).toEqual({ error: "title is required" });

    const badKind = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "notes", title: "Whatever" }),
    });
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toEqual({ error: "unknown kind: notes" });

    const malformed = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid request body" });

    await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "wiki", title: "Duplicate" }),
    });
    const duplicate = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "wiki", title: "Duplicate" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "a doc with this slug already exists" });

    expect((await app.request("/api/projects/prj_missing/docs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "wiki", title: "Orphan" }),
    })).status).toBe(404);
  });

  it("broadcasts the project_doc created/updated/deleted trio", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Events" });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const created = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "wiki", title: "Broadcast" }),
    });
    const createdBody = await created.json();
    expect(events.find((event) => event.type === "project_doc:created" && (event.payload.doc as any)?.slug === "broadcast")).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        project_id: project.id,
        doc: { id: createdBody.doc.id, slug: "broadcast", kind: "wiki" },
      },
    });

    await app.request(`/api/projects/${project.id}/docs/broadcast`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: "changed" }),
    });
    expect(events.find((event) => event.type === "project_doc:updated")).toMatchObject({
      workspaceId: "local",
      payload: {
        project_id: project.id,
        doc: { id: createdBody.doc.id, body: "changed", version: 2 },
      },
    });

    await app.request(`/api/projects/${project.id}/docs/broadcast`, { method: "DELETE" });
    expect(events.find((event) => event.type === "project_doc:deleted")).toMatchObject({
      workspaceId: "local",
      payload: { project_id: project.id, doc_id: createdBody.doc.id },
    });
  });

  it("hides docs from non-members of the project workspace", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const workspace = store.createWorkspace({ name: "Private", slug: "private" });
    const project = store.createProject({ title: "Private docs", workspaceId: workspace.id });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Secret" });
    const outsider = store.getOrCreateUser({ externalId: "outsider", name: "Outsider" });
    const pat = await store.createAccessToken({ name: "outsider pat", type: "pat", userId: outsider.id });

    const listed = await app.request(`/api/projects/${project.id}/docs`, {
      headers: { Authorization: `Bearer ${pat.token}` },
    });
    expect(listed.status).toBe(404);
    expect(await listed.json()).toEqual({ error: "workspace not found" });
  });

  it("attaches the project knowledge index to a daemon claim", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "Claim docs" });
    const runtime = store.registerRuntime({ name: "rt", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Claimer", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Do work", projectId: project.id });
    store.createProjectDoc(project.id, { kind: "memory", title: "Build needs bun 1.2", body: "install via curl" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Architecture", summary: "Hub and spoke" });
    store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "go" });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()).task;
    expect(claimed.project_docs.memory).toEqual([
      expect.objectContaining({
        slug: "build-needs-bun-1-2",
        title: "Build needs bun 1.2",
        body: "install via curl",
        kind: "memory",
        pinned: true,
        source_issue_id: null,
      }),
    ]);
    // `_schema` rides the schema field instead of taking a wiki slot.
    expect(claimed.project_docs.wiki.map((entry: any) => entry.slug)).toEqual(["architecture"]);
    expect(claimed.project_docs.wiki[0]).toMatchObject({ summary: "Hub and spoke", body: null, kind: "wiki" });
    expect(claimed.project_docs.schema).toContain("Wiki Schema");

    // The daemon client normalizes the wire shape back to camelCase entries.
    store.completeTask(claimed.id, { output: "done" });
    store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "go again" });
    mockFetch((url, init) => {
      const parsed = new URL(url);
      return app.request(`${parsed.pathname}${parsed.search}`, init);
    });
    const normalized = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);
    const memoryEntry = normalized?.projectDocs?.memory[0];
    const wikiEntry = normalized?.projectDocs?.wiki[0];
    expect(memoryEntry).toMatchObject({
      slug: "build-needs-bun-1-2",
      title: "Build needs bun 1.2",
      body: "install via curl",
      kind: "memory",
      pinned: true,
      sourceIssueId: null,
    });
    expect(memoryEntry?.updatedAt).toBeString();
    expect(wikiEntry).toMatchObject({ slug: "architecture", summary: "Hub and spoke", body: null, kind: "wiki" });
    expect(normalized?.projectDocs?.schema).toContain("Wiki Schema");
  });
});
