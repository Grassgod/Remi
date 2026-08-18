import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiProjectDoc } from "@multiremi/contracts/types.js";
import {
  projectKnowledgeDocUri,
  projectKnowledgeSlugFromUri,
  sha256Text,
} from "@multiremi/project-knowledge/codec.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import type {
  OpenVikingClientContract,
  OpenVikingFindHit,
  OpenVikingSnapshotCommit,
} from "@multiremi/project-knowledge/types.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

class FakeOpenViking implements OpenVikingClientContract {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly tags = new Map<string, string[]>();
  readonly commits: Array<{ oid: string; message: string; files: Map<string, string> }> = [];
  failWrites = 0;
  failCommits = 0;
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
  async remove(uri: string): Promise<void> { this.files.delete(uri); }
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
