import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiProjectDoc } from "@multiremi/contracts/types.js";
import {
  projectKnowledgeDocUri,
  projectKnowledgeSlugFromUri,
  sha256Text,
} from "@multiremi/project-knowledge/codec.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { repositoryWikiDocUri } from "@multiremi/repository-wiki/codec.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import type {
  OpenVikingClientContract,
  OpenVikingFindHit,
  OpenVikingSnapshotCommit,
} from "@multiremi/project-knowledge/types.js";
import { createLocalStore, createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

class FakeOpenViking implements OpenVikingClientContract {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly tags = new Map<string, string[]>();
  readonly commits: Array<{ oid: string; message: string; files: Map<string, string> }> = [];
  failWrites = 0;
  failCommits = 0;
  failRemoves = 0;
  failRemovesAfterDelete = 0;
  failHealth = false;
  findTargets: Array<string | string[]> = [];

  async health(): Promise<void> { if (this.failHealth) throw new Error("unavailable"); }
  async ensureDirectory(uri: string): Promise<void> { this.directories.add(uri); }
  async read(uri: string): Promise<string> {
    const value = this.files.get(uri);
    if (value === undefined) throw new Error(`not found: ${uri}`);
    return value;
  }
  async exists(uri: string): Promise<boolean> { return this.files.has(uri); }
  async create(uri: string, _rootUri: string, content: string): Promise<void> {
    this.maybeFail();
    if (this.files.has(uri)) throw new Error("already exists");
    this.files.set(uri, content);
  }
  async replace(uri: string, _rootUri: string, content: string, baseHash: string): Promise<void> {
    this.maybeFail();
    const current = await this.read(uri);
    if (sha256Text(current) !== baseHash) throw new Error("precondition failed");
    this.files.set(uri, content);
  }
  async remove(uri: string): Promise<void> {
    if (this.failRemovesAfterDelete > 0) {
      this.failRemovesAfterDelete--;
      this.files.delete(uri);
      throw new Error("planned ambiguous OpenViking remove failure");
    }
    if (this.failRemoves > 0) {
      this.failRemoves--;
      throw new Error("planned OpenViking remove failure");
    }
    this.files.delete(uri);
  }
  async setTags(uri: string, tags: string[]): Promise<void> { this.tags.set(uri, [...tags]); }
  async find(query: string, targetUri: string | string[], limit: number): Promise<OpenVikingFindHit[]> {
    this.findTargets.push(targetUri);
    const roots = Array.isArray(targetUri) ? targetUri : [targetUri];
    return [...this.files.entries()]
      .filter(([uri, content]) => roots.some((root) => uri.startsWith(root)) && content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit)
      .map(([uri]) => ({ uri, score: 0.9, abstract: `match:${query}`, tags: this.tags.get(uri) ?? [] }));
  }
  async commit(message: string): Promise<string> {
    if (this.failCommits > 0) {
      this.failCommits--;
      throw new Error("planned OpenViking snapshot failure");
    }
    const oid = `oid_${this.commits.length + 1}`;
    this.commits.push({ oid, message, files: new Map(this.files) });
    return oid;
  }
  async log(paths: string[], limit = 100): Promise<OpenVikingSnapshotCommit[]> {
    return this.commits
      .filter((commit) => paths.some((path) => commit.files.has(path)))
      .slice(-limit)
      .reverse()
      .map((commit) => ({ oid: commit.oid, message: commit.message, createdAt: null }));
  }
  async show(targetRef: string, path: string): Promise<string> {
    const commit = this.commits.find((entry) => entry.oid === targetRef);
    const content = commit?.files.get(path);
    if (content === undefined) throw new Error("snapshot content not found");
    return content;
  }
  private maybeFail(): void {
    if (this.failWrites <= 0) return;
    this.failWrites--;
    throw new Error("planned OpenViking write failure");
  }
}

describe("project knowledge URIs", () => {
  it("rejects path traversal and cross-project URI decoding", () => {
    expect(() => projectKnowledgeDocUri({ workspaceId: "../foreign", projectId: "p1", kind: "wiki", slug: "page" }))
      .toThrow("invalid workspaceId");
    expect(() => projectKnowledgeDocUri({ workspaceId: "ws", projectId: "p1", kind: "wiki", slug: "../../page" }))
      .toThrow("invalid slug");
    const uri = projectKnowledgeDocUri({ workspaceId: "ws", projectId: "p1", kind: "wiki", slug: "page" });
    expect(projectKnowledgeSlugFromUri(uri, { workspaceId: "ws", projectId: "p1", kind: "wiki" })).toBe("page");
    expect(() => projectKnowledgeSlugFromUri(uri, { workspaceId: "ws", projectId: "p2", kind: "wiki" }))
      .toThrow("outside the expected project scope");
  });
});

describe("ProjectKnowledgeService OpenViking mode", () => {
  it("stores bodies and revisions only in OpenViking and keeps project-scoped search", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const alpha = store.createProject({ title: "Alpha" });
    const beta = store.createProject({ title: "Beta" });

    const memory = await service.createProjectDoc(alpha.id, {
      kind: "memory",
      title: "Deploy owner",
      body: "The platform team owns Phoenix rollback.",
      tags: ["ops"],
      refs: [{ type: "issue", value: "MUL-7" }],
    });
    await service.createProjectDoc(beta.id, {
      kind: "memory",
      title: "Foreign deploy owner",
      body: "The other workspace text also says Phoenix rollback.",
    });

    const sqlRows = db!.query("SELECT slug, body, storage_backend, sync_status FROM multiremi_project_docs ORDER BY slug").all() as any[];
    expect(sqlRows.every((row) => row.body === "")).toBe(true);
    expect(sqlRows.every((row) => row.storage_backend === "openviking" && row.sync_status === "ready")).toBe(true);
    expect((await service.getProjectDocByRef(alpha.id, memory.slug))?.body).toBe("The platform team owns Phoenix rollback.");

    const hits = await service.recallProjectDocs(alpha.id, "Phoenix rollback", { kind: "memory" });
    expect(hits.map((hit) => hit.doc.id)).toEqual([memory.id]);
    expect(hits[0]).toMatchObject({ score: 0.9, snippet: "match:Phoenix rollback" });
    expect(client.findTargets.at(-1)).toBe(`viking://resources/multiremi/workspaces/local/projects/${alpha.id}/knowledge/memory`);

    const updated = await service.updateProjectDoc(alpha.id, memory.slug, {
      body: "Phoenix rollback belongs to Release Engineering.",
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(updated.body).toContain("Release Engineering");
    await expect(service.updateProjectDoc(alpha.id, memory.slug, { body: "stale", expectedVersion: 1 }))
      .rejects.toThrow("project doc version conflict");

    const revisions = await service.listProjectDocRevisions(alpha.id, memory.slug);
    expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);
    expect(revisions[0]!.body).toContain("Release Engineering");
    expect(revisions[1]!.body).toContain("platform team");
    expect(revisions.every((revision) => revision.snapshotOid && revision.contentUri)).toBe(true);
    expect(db!.query("SELECT body FROM multiremi_project_doc_revisions WHERE doc_id = ?").all(memory.id))
      .toEqual([{ body: "" }, { body: "" }]);

    client.failCommits = 1;
    await expect(service.updateProjectDoc(alpha.id, memory.slug, { body: "must roll back", tags: ["broken"] }))
      .rejects.toThrow("planned OpenViking snapshot failure");
    expect(await service.getProjectDocByRef(alpha.id, memory.slug)).toMatchObject({
      body: "Phoenix rollback belongs to Release Engineering.",
      tags: ["ops"],
      version: 2,
    });
  });

  it("supports backlinks, slug moves and deletion without losing old revision paths", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Links" });
    const target = await service.createProjectDoc(project.id, { kind: "wiki", title: "Runbook", body: "v1" });
    await service.createProjectDoc(project.id, { kind: "wiki", title: "Index", body: "See [[runbook]]." });
    expect((await service.backlinks(project.id, target.slug)).map((doc) => doc.slug)).toEqual(["index"]);

    const moved = await service.updateProjectDoc(project.id, target.slug, { slug: "release-runbook", body: "v2" });
    expect(moved.slug).toBe("release-runbook");
    const revisions = await service.listProjectDocRevisions(project.id, moved.slug);
    expect(revisions.map((revision) => revision.body)).toEqual(["v2", "v1"]);
    expect([...client.files.keys()].some((uri) => uri.endsWith("/runbook.md"))).toBe(false);

    await expect(service.deleteProjectDoc(project.id, moved.slug, { expectedVersion: moved.version - 1 }))
      .rejects.toThrow("project doc version conflict");
    await service.deleteProjectDoc(project.id, moved.slug, { expectedVersion: moved.version });
    expect(store.getProjectDoc(moved.id)).toBeNull();
    expect([...client.files.keys()].some((uri) => uri.endsWith("/release-runbook.md"))).toBe(false);
  });

  it("finishes idempotent deletion after ambiguous remote and snapshot failures", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Delete recovery" });

    const ambiguous = await service.createProjectDoc(project.id, {
      kind: "memory",
      title: "Ambiguous delete",
      body: "durable fact",
    });
    client.failRemovesAfterDelete = 1;
    client.failCommits = 1;
    await expect(service.deleteProjectDoc(project.id, ambiguous.id)).resolves.toMatchObject({ id: ambiguous.id });
    expect(store.getProjectDoc(ambiguous.id)).toBeNull();

    const resumed = await service.createProjectDoc(project.id, {
      kind: "memory",
      title: "Interrupted delete",
      body: "another durable fact",
    });
    store.setProjectDocSyncState(resumed.id, { syncStatus: "deleting" });
    client.files.delete(resumed.contentUri!);
    await expect(service.deleteProjectDoc(project.id, resumed.id)).resolves.toMatchObject({ id: resumed.id });
    expect(store.getProjectDoc(resumed.id)).toBeNull();
  });

  it("records a removable failure and allows a later delete retry", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Delete retry" });
    const doc = await service.createProjectDoc(project.id, {
      kind: "memory",
      title: "Retry delete",
      body: "durable fact",
    });

    client.failRemoves = 1;
    await expect(service.deleteProjectDoc(project.id, doc.id)).rejects.toThrow("planned OpenViking remove failure");
    expect(store.getProjectDoc(doc.id)).toMatchObject({
      syncStatus: "failed",
      syncError: "planned OpenViking remove failure",
    });
    await expect(service.deleteProjectDoc(project.id, doc.id)).resolves.toMatchObject({ id: doc.id });
    expect(store.getProjectDoc(doc.id)).toBeNull();
  });

  it("excludes non-ready documents from lists and task hydration", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Knowledge isolation" });
    const healthy = await service.createProjectDoc(project.id, {
      kind: "memory",
      title: "Healthy memory",
      body: "usable knowledge",
    });
    const deleting = await service.createProjectDoc(project.id, {
      kind: "memory",
      title: "Deleting memory",
      body: "being removed",
    });
    store.setProjectDocSyncState(deleting.id, { syncStatus: "deleting" });
    client.files.delete(deleting.contentUri!);

    expect((await service.listProjectDocs(project.id)).map((doc) => doc.id)).toContain(healthy.id);
    expect((await service.listProjectDocs(project.id)).map((doc) => doc.id)).not.toContain(deleting.id);
    const hydrated = await service.hydrateTaskKnowledge({
      project,
      projectContexts: [],
    } as any);
    expect(hydrated.projectDocs?.memory.map((doc) => doc.id)).toContain(healthy.id);
    expect(hydrated.projectDocs?.memory.map((doc) => doc.id)).not.toContain(deleting.id);
  });

  it("rejects empty memory bodies before writing OpenViking metadata", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Memory validation" });

    await expect(service.createProjectDoc(project.id, { kind: "memory", title: "Empty", body: "  " }))
      .rejects.toThrow("memory body is required");
    expect(store.listProjectDocs(project.id).filter((doc) => doc.kind === "memory")).toHaveLength(0);
  });
});

describe("RepositoryWikiService OpenViking mode", () => {
  it("keeps repository bodies scoped in OpenViking and preserves generated document ids", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");

    const first = await service.create("local", "repo_alpha", {
      title: "Architecture",
      path: "architecture/overview.md",
      body: "Alpha service graph",
      sourceRevision: "abc123",
    });
    await service.create("local", "repo_beta", {
      title: "Architecture",
      path: "architecture/overview.md",
      body: "Beta service graph",
      sourceRevision: "def456",
    });

    expect(first.id).toStartWith("rwdoc_");
    expect(await service.get("local", "repo_alpha", first.id)).toMatchObject({
      id: first.id,
      body: "Alpha service graph",
      sourceRevision: "abc123",
    });
    expect(client.files.get(repositoryWikiDocUri("local", "repo_alpha", "architecture/overview.md"))).toContain(`id: ${first.id}`);
    expect((await service.search("local", "repo_alpha", "service graph")).map((doc) => doc.repositoryId)).toEqual(["repo_alpha"]);
    expect(db!.query("SELECT body, storage_backend, sync_status FROM multiremi_repository_wiki_docs ORDER BY repository_id").all())
      .toEqual([
        { body: "", storage_backend: "openviking", sync_status: "ready" },
        { body: "", storage_backend: "openviking", sync_status: "ready" },
      ]);

    const updated = await service.update("local", "repo_alpha", first.id, {
      body: "Alpha graph v2",
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    await expect(service.update("local", "repo_alpha", first.id, { body: "stale", expectedVersion: 1 }))
      .rejects.toThrow("repository wiki version conflict");
    expect((await service.revisions("local", "repo_alpha", first.id)).map((revision) => revision.body))
      .toEqual(["Alpha graph v2", "Alpha service graph"]);
  });

  it("hydrates an SCM automation task with its trusted repository checkout and Wiki", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_atlas",
        name: "atlas",
        url: "git@github.com:example/atlas.git",
        default_branch: "main",
      }],
    });
    await service.create("local", "repo_atlas", {
      title: "Architecture",
      path: "architecture.md",
      body: "Atlas architecture facts",
    });
    store.getScmCanonicalEvent = ((id: string) => id === "sce_atlas" ? ({
      id,
      workspaceId: "local",
      repositoryId: "repo_atlas",
    }) : null) as typeof store.getScmCanonicalEvent;

    const hydrated = await service.hydrateTaskWiki({
      workspaceId: "local",
      assignmentSourceEventId: "sce_atlas",
      project: null,
      projectResources: [],
      repos: [],
    } as any);

    expect(hydrated.repos).toEqual([{ url: "git@github.com:example/atlas.git" }]);
    expect(hydrated.repositoryWikiContexts).toHaveLength(1);
    expect(hydrated.repositoryWikiContexts?.[0]).toMatchObject({
      repository: { id: "repo_atlas", name: "atlas", defaultBranch: "main" },
      docs: [{ path: "architecture.md", body: "Atlas architecture facts" }],
    });
  });

  it("keeps the new repository Wiki path readable when old-path cleanup fails", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const created = await service.create("local", "repo_alpha", {
      title: "Architecture",
      path: "architecture.md",
      body: "Version one",
    });

    client.failRemoves = 1;
    const moved = await service.update("local", "repo_alpha", created.id, {
      path: "design/architecture.md",
      body: "Version two",
      expectedVersion: created.version,
    });

    expect(moved.path).toBe("design/architecture.md");
    expect((await service.get("local", "repo_alpha", created.id))?.body).toBe("Version two");
    expect(client.files.has(repositoryWikiDocUri("local", "repo_alpha", "design/architecture.md"))).toBeTrue();
  });

  it("hydrates a manual Atlas bootstrap run with only its workspace repository", async () => {
    const store = createLocalStore();
    const service = new RepositoryWikiService(store, new FakeOpenViking(), "openviking");
    store.updateWorkspace("local", {
      repos: [{ id: "repo_bootstrap", name: "bootstrap", url: "git@github.com:example/bootstrap.git" }],
    });
    store.getAutopilotRun = ((id: string) => id === "run_atlas" ? ({
      id,
      autopilotId: "auto_atlas",
      payload: { atlas_repository_id: "repo_bootstrap" },
    }) : null) as typeof store.getAutopilotRun;
    store.getAutopilot = ((id: string) => id === "auto_atlas" ? ({
      id,
      workspaceId: "local",
      title: "Atlas · Repository Wiki",
    }) : null) as typeof store.getAutopilot;

    const hydrated = await service.hydrateTaskWiki({
      workspaceId: "local",
      autopilotRunId: "run_atlas",
      assignmentSourceEventId: null,
      projectResources: [],
      repos: [],
    } as any);

    expect(hydrated.repos).toEqual([{ url: "git@github.com:example/bootstrap.git" }]);
    expect(hydrated.repositoryWikiContexts).toMatchObject([{
      repository: { id: "repo_bootstrap", name: "bootstrap" },
      docs: [],
    }]);
  });
});

describe("ProjectKnowledgeService migration", () => {
  it("a shadow write migrates every SQL revision before an explicit backfill", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Shadow history" });
    const doc = store.createProjectDoc(project.id, { kind: "wiki", title: "Runbook", body: "v1" });
    const client = new FakeOpenViking();
    const shadow = new ProjectKnowledgeService(store, client, "shadow");

    await shadow.updateProjectDoc(project.id, doc.id, { body: "v2" });

    expect(store.listProjectDocRevisions(doc.id).map((revision) => Boolean(revision.snapshotOid))).toEqual([true, true]);
    expect((await shadow.verify("local", project.id)).failures.some((failure) => failure.docId === doc.id)).toBe(false);
  });

  it("backfills all revisions idempotently, verifies checksums, and supports cutover reads", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Migration" });
    const original = store.createProjectDoc(project.id, { kind: "wiki", title: "发布手册", body: "第一版" });
    store.updateProjectDoc(project.id, original.id, { body: "第二版", refs: [{ type: "issue", value: "MUL-9" }] });
    const client = new FakeOpenViking();
    const shadow = new ProjectKnowledgeService(store, client, "shadow");

    const dryRun = await shadow.backfill("local", { dryRun: true, projectId: project.id });
    expect(dryRun.scanned).toBe(2); // _schema + the page
    expect(dryRun.migrated).toBe(2);
    const first = await shadow.backfill("local", { projectId: project.id });
    expect(first.failed).toBe(0);
    expect(first.migrated).toBe(2);
    expect((await shadow.verify("local", project.id)).failed).toBe(0);
    const second = await shadow.backfill("local", { projectId: project.id });
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(2);
    expect((await shadow.backfill("local", { projectId: project.id, resume: true })).skipped).toBe(2);
    expect((await shadow.migrationStatus("local")).openviking).toBe("ready");

    // SQL bodies remain only as the explicit rollback snapshot during shadow.
    expect(store.getProjectDoc(original.id)?.body).toBe("第二版");
    const cutover = new ProjectKnowledgeService(store, client, "openviking");
    expect((await cutover.getProjectDocByRef(project.id, original.id))?.body).toBe("第二版");
    expect((await cutover.listProjectDocRevisions(project.id, original.id)).map((revision) => revision.body))
      .toEqual(["第二版", "第一版"]);

    await cutover.updateProjectDoc(project.id, original.id, { body: "第三版", expectedVersion: 2 });
    expect((await cutover.getProjectDocByRef(project.id, original.id))?.body).toBe("第三版");
    // The pre-cutover SQL body is a frozen rollback snapshot; the new body and
    // new revision exist only in OpenViking.
    expect(store.getProjectDoc(original.id)?.body).toBe("第二版");
    expect(store.listProjectDocRevisions(original.id)[0]).toMatchObject({ version: 3, body: "" });

    const historical = client.commits.find((commit) => commit.message === `project_doc:${original.id}:v1`)!;
    const originalV1 = store.listProjectDocRevisions(original.id).find((revision) => revision.version === 1)!;
    historical.files.set(originalV1.contentUri!, "corrupt history");
    const corrupted = await cutover.verify("local", project.id);
    expect(corrupted.failures.some((failure) => failure.docId === original.id && failure.error.includes("revision 1 checksum"))).toBe(true);
  });

  it("records failed backfills and retries only failed documents", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Retry" });
    const doc = store.createProjectDoc(project.id, { kind: "memory", title: "Retry fact", body: "retry me" });
    const client = new FakeOpenViking();
    client.failWrites = 1;
    const service = new ProjectKnowledgeService(store, client, "shadow");

    const failed = await service.backfill("local", { projectId: project.id, statuses: ["sql"] });
    expect(failed.failed).toBe(1);
    const failedId = failed.failures[0]!.docId;
    expect(store.getProjectDoc(failedId)?.syncStatus).toBe("failed");
    const retried = await service.backfill("local", { projectId: project.id, statuses: ["failed"] });
    expect(retried.failed).toBe(0);
    expect(retried.migrated).toBe(1);
    expect(store.getProjectDoc(failedId)?.syncStatus).toBe("ready");
    expect(store.getProjectDoc(doc.id)?.syncStatus).toBe("ready");
  });

  it("reports whether the configured OpenViking dependency is reachable", async () => {
    const store = createStore();
    expect((await new ProjectKnowledgeService(store, null, "sql").migrationStatus("local")).openviking).toBe("not_configured");
    const client = new FakeOpenViking();
    client.failHealth = true;
    expect((await new ProjectKnowledgeService(store, client, "shadow").migrationStatus("local")).openviking).toBe("unavailable");
  });
});
