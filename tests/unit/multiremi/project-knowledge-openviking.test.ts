import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiProjectDoc } from "@multiremi/contracts/types.js";
import {
  projectKnowledgeDocUri,
  projectKnowledgeSlugFromUri,
  sha256Text,
} from "@multiremi/project-knowledge/codec.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { repositoryWikiDocUri, repositoryWikiStorageRootUri } from "@multiremi/repository-wiki/codec.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { resolveRepositoryWikiRef, tokenizeWikiLinks } from "@multiremi/contracts/wiki-links";
import { createMultiremiApp } from "@multiremi/api.js";
import type {
  OpenVikingClientContract,
  OpenVikingFindHit,
  OpenVikingSnapshotCommit,
} from "@multiremi/project-knowledge/types.js";
import { configureRepositoryWikiAutomation, createLocalStore, createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

class FakeOpenViking implements OpenVikingClientContract {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly tags = new Map<string, string[]>();
  readonly commits: Array<{ oid: string; message: string; files: Map<string, string> }> = [];
  failWrites = 0;
  failWriteAt: number | null = null;
  writeAttempts = 0;
  failCommits = 0;
  failRemoves = 0;
  failRemovesAfterDelete = 0;
  failHealth = false;
  findTargets: Array<string | string[]> = [];
  readCalls: string[] = [];
  failReadUris = new Set<string>();
  readDelayMs = 0;
  activeReads = 0;
  maxActiveReads = 0;

  async health(): Promise<void> { if (this.failHealth) throw new Error("unavailable"); }
  async ensureDirectory(uri: string): Promise<void> { this.directories.add(uri); }
  async read(uri: string): Promise<string> {
    this.readCalls.push(uri);
    this.activeReads++;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    try {
      if (this.readDelayMs > 0) await Bun.sleep(this.readDelayMs);
      if (this.failReadUris.has(uri)) throw new Error(`planned unreadable content: ${uri}`);
      const value = this.files.get(uri);
      if (value === undefined) throw new Error(`not found: ${uri}`);
      return value;
    } finally {
      this.activeReads--;
    }
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
    this.writeAttempts++;
    if (this.failWriteAt === this.writeAttempts) throw new Error("planned OpenViking write failure");
    if (this.failWrites <= 0) return;
    this.failWrites--;
    throw new Error("planned OpenViking write failure");
  }
}

describe("Repository Wiki snapshot restoration", () => {
  async function fixture() {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [
      { id: "repo_restore", name: "restore", url: "https://github.com/acme/restore.git", source: "github", default_branch: "main" },
      { id: "repo_other", name: "other", url: "https://github.com/acme/other.git", source: "github", default_branch: "main" },
    ]);
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const docs = (await service.applyBatch("local", "repo_restore", [
      { kind: "create", input: { path: "target.md", title: "Target", body: "恢复的正文" } },
      { kind: "create", input: { path: "source.md", title: "Source", body: "[[target]]" } },
    ])).map(result => result.doc);
    await service.runStorageJobs();
    const targets = docs.map(doc => {
      const current = store.getRepositoryWikiDocByRef("local", "repo_restore", doc.id)!;
      return { ref: current.id, expected_version: current.version, snapshot_oid: current.snapshotOid!, content_sha256: current.contentSha256! };
    });
    const before = store.listRepositoryWikiDocs("local", "repo_restore");
    const revisions = before.map(doc => store.listRepositoryWikiDocRevisions(doc.id));
    for (const doc of before) client.files.delete(doc.contentUri!);
    const app = createMultiremiApp({ store, repositoryWiki: service, authToken: "root-secret" });
    const request = (body: unknown, token = "root-secret") => app.request("/api/workspaces/local/repos/repo_restore/wiki/restore", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    return { store, client, service, docs, targets, before, revisions, app, request };
  }

  it("preflights without storage writes, restores exact bytes with audit, and unlocks strict reads and the next write", async () => {
    const f = await fixture();
    await expect(f.service.listStrict("local", "repo_restore")).rejects.toThrow("not found");
    const writes = f.client.writeAttempts;
    const tags = [...f.client.tags];
    const commits = f.client.commits.length;
    const dry = await f.request({ targets: f.targets });
    expect(dry.status).toBe(200);
    const plan = await dry.json() as any;
    expect(plan.dry_run).toBe(true);
    expect(plan.results.map((r: any) => r.state)).toEqual(["missing", "missing"]);
    expect(plan.repository_readable).toBe(false);
    expect(f.client.writeAttempts).toBe(writes);
    expect([...f.client.tags]).toEqual(tags);
    expect(f.client.commits.length).toBe(commits);
    const response = await f.request({ targets: f.targets, dry_run: false });
    expect(response.status).toBe(200);
    const report = await response.json() as any;
    expect(report.results.map((r: any) => r.state)).toEqual(["restored", "restored"]);
    expect(report.repository_readable).toBe(true);
    expect(report.unreadable).toEqual([]);
    expect(report.run.status).toBe("noop");
    const audit = JSON.parse(f.store.getKnowledgeCompilationRun(report.run.id)!.resultSummary!);
    expect(audit).toMatchObject({ operation: "repository_wiki_restore", dry_run: false, actor: { kind: "member" }, results: report.results });
    const inspected = await f.app.request(`/api/knowledge/runs/${report.run.id}`, { headers: { Authorization: "Bearer root-secret" } });
    expect(inspected.status).toBe(200);
    expect((await inspected.json() as any).run.result_summary).toContain("repository_wiki_restore");
    for (const doc of f.before) {
      expect(f.client.files.get(doc.contentUri!)).toBe(await f.client.show(doc.snapshotOid!, doc.contentUri!));
      expect(sha256Text(f.client.files.get(doc.contentUri!)!)).toBe(doc.contentSha256!);
    }
    expect(f.store.listRepositoryWikiDocs("local", "repo_restore")).toEqual(f.before);
    expect(f.before.map(doc => f.store.listRepositoryWikiDocRevisions(doc.id))).toEqual(f.revisions);
    expect((await f.service.listStrict("local", "repo_restore")).map(doc => doc.body).sort()).toEqual(["[[target]]", "恢复的正文"].sort());
    // Exercise the ordinary authenticated REST write, not only the restore API.
    const updated = await f.app.request(`/api/workspaces/local/repos/repo_restore/wiki/${f.docs[0]!.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
      body: JSON.stringify({ expected_version: 1, body: "恢复后正常写入" }),
    });
    expect(updated.status).toBe(200);
    expect((await f.service.get("local", "repo_restore", f.docs[0]!.id))?.version).toBe(2);
  });

  it("rejects any corrupt snapshot before creating even the first valid object, with a failed audit", async () => {
    const f = await fixture();
    const last = f.before.find(doc => doc.id === f.targets[1]!.ref)!;
    f.client.commits.find(commit => commit.oid === last.snapshotOid)!.files.set(last.contentUri!, "corrupt");
    const writes = f.client.writeAttempts;
    const directories = [...f.client.directories];
    const response = await f.request({ targets: f.targets, dry_run: false });
    expect(response.status).toBe(409);
    expect((await response.json() as any).error).toContain("Snapshot checksum mismatch");
    expect(f.client.writeAttempts).toBe(writes);
    expect([...f.client.directories]).toEqual(directories);
    for (const doc of f.before) expect(f.client.files.has(doc.contentUri!)).toBe(false);
    const audit = f.store.listKnowledgeCompilationRuns({ workspaceId: "local", repositoryId: "repo_restore" })[0]!;
    expect(audit.status).toBe("failed");
    expect(JSON.parse(audit.resultSummary!)).toMatchObject({ operation: "repository_wiki_restore", targets: f.targets });
    expect(f.store.listRepositoryWikiDocs("local", "repo_restore")).toEqual(f.before);
  });

  it("is idempotent and never overwrites an existing conflicting object", async () => {
    const f = await fixture();
    const first = f.before.find(doc => doc.id === f.targets[0]!.ref)!;
    f.client.files.set(first.contentUri!, "someone else's content");
    const writes = f.client.writeAttempts;
    expect((await f.request({ targets: f.targets, dry_run: false })).status).toBe(409);
    expect(f.client.writeAttempts).toBe(writes);
    expect(f.client.files.get(first.contentUri!)).toBe("someone else's content");
    f.client.files.delete(first.contentUri!);
    expect((await f.request({ targets: f.targets, dry_run: false })).status).toBe(200);
    const afterWrites = f.client.writeAttempts;
    const afterFiles = [...f.client.files];
    const retry = await f.request({ targets: f.targets, dry_run: false });
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).results.map((r: any) => r.state)).toEqual(["present", "present"]);
    expect(f.client.writeAttempts).toBe(afterWrites);
    expect([...f.client.files]).toEqual(afterFiles);
    expect(f.store.listRepositoryWikiDocs("local", "repo_restore")).toEqual(f.before);
  });

  it("preserves partial progress on transport failure and safely finishes on retry", async () => {
    const f = await fixture();
    f.client.failWriteAt = f.client.writeAttempts + 2;
    const failed = await f.request({ targets: f.targets, dry_run: false });
    expect(failed.status).toBe(400);
    const first = f.before.find(doc => doc.id === f.targets[0]!.ref)!;
    expect(f.client.files.has(first.contentUri!)).toBe(true);
    const audit = f.store.listKnowledgeCompilationRuns({ workspaceId: "local", repositoryId: "repo_restore" })[0]!;
    expect(audit.status).toBe("failed");
    expect(JSON.parse(audit.resultSummary!).results[0].state).toBe("restored");
    f.client.failWriteAt = null;
    const retry = await f.request({ targets: f.targets, dry_run: false });
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).results.map((r: any) => r.state)).toEqual(["present", "restored"]);
    expect(f.store.listRepositoryWikiDocs("local", "repo_restore")).toEqual(f.before);
  });

  it("rejects stale pins and malformed targets without storage writes", async () => {
    const f = await fixture();
    const writes = f.client.writeAttempts;
    for (const patch of [{ expected_version: 2 }, { snapshot_oid: "old-snapshot" }, { content_sha256: "0".repeat(64) }]) {
      expect((await f.request({ targets: [{ ...f.targets[0], ...patch }], dry_run: false })).status).toBe(409);
    }
    for (const targets of [[], [f.targets[0], f.targets[0]], [{ ...f.targets[0], content_sha256: "invalid" }], [null]]) {
      expect((await f.request({ targets, dry_run: false })).status).toBe(400);
    }
    expect(f.client.writeAttempts).toBe(writes);
  });

  it("does not overwrite an object created by another writer after preflight", async () => {
    const f = await fixture();
    const create = f.client.create.bind(f.client);
    let raced = false;
    f.client.create = async (uri, root, content) => {
      if (!raced) { raced = true; f.client.files.set(uri, "concurrent content"); }
      return create(uri, root, content);
    };
    const response = await f.request({ targets: f.targets, dry_run: false });
    expect(response.status).toBe(409);
    expect((await response.json() as any).error).toContain("Concurrent object checksum mismatch");
    const first = f.before.find(doc => doc.id === f.targets[0]!.ref)!;
    expect(f.client.files.get(first.contentUri!)).toBe("concurrent content");
    expect(f.store.listRepositoryWikiDocs("local", "repo_restore")).toEqual(f.before);
  });

  it("refuses recovery while canonical promotion/cleanup is pending", async () => {
    const f = await fixture();
    await f.request({ targets: f.targets, dry_run: false });
    await f.service.update("local", "repo_restore", f.docs[0]!.id, { body: "new content" });
    expect(f.store.listRepositoryWikiStorageJobs("local", "repo_restore").length).toBeGreaterThan(0);
    const writes = f.client.writeAttempts;
    const response = await f.request({ targets: f.targets, dry_run: false });
    expect(response.status).toBe(503);
    expect((await response.json() as any).error).toBe("Repository wiki storage repair is still pending");
    expect(f.client.writeAttempts).toBe(writes);
  });

  it("enforces admin human membership and scoped publishing tasks before accessing snapshots", async () => {
    const f = await fixture();
    const writes = f.client.writeAttempts;
    const user = f.store.getOrCreateUser({ email: "restore-member@example.test", name: "Reader" });
    f.store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: "Reader", role: "member" });
    const pat = await f.store.createAccessToken({ workspaceId: "local", userId: user.id, name: "Reader", type: "pat", purpose: "session" });
    expect((await f.request({ targets: f.targets, dry_run: false }, pat.token)).status).toBe(403);
    const outsider = f.store.getOrCreateUser({ email: "restore-outsider@example.test", name: "Outsider" });
    const outsidePat = await f.store.createAccessToken({ workspaceId: "local", userId: outsider.id, name: "Outsider", type: "pat", purpose: "session" });
    // Existing workspace middleware hides non-member workspace existence.
    expect((await f.request({ targets: f.targets, dry_run: false }, outsidePat.token)).status).toBe(404);
    expect((await f.request({ targets: f.targets, dry_run: false }, "invalid-token")).status).toBe(401);
    const { autopilot } = configureRepositoryWikiAutomation(f.store);
    const run = f.store.runAutopilot(autopilot.id, { source: "scm_event", repositoryId: "repo_other", dedupeKey: "repo_other:incremental_update:restore", payload: { repository_wiki_repository_id: "repo_other" } });
    const outOfScope = await f.store.createTaskAccessToken(f.store.getTask(run.taskId!)!, "local");
    const denied = await f.request({ targets: f.targets, dry_run: false }, outOfScope.token);
    expect(denied.status).toBe(403);
    expect((await denied.json() as any).error).toBe("task knowledge target does not match its repository scope");
    const project = f.store.createProject({ title: "Restore project" });
    f.store.createProjectResource(project.id, { resourceType: "github_repo", resourceRef: { url: "https://github.com/acme/restore.git" } });
    const issue = f.store.createIssue({ title: "Restore", projectId: project.id });
    const agent = f.store.createAgent({ name: "Non-publisher", provider: "claude" });
    const task = f.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "restore" });
    const ordinary = await f.store.createTaskAccessToken(task, "local");
    const noPublish = await f.request({ targets: f.targets, dry_run: false }, ordinary.token);
    expect(noPublish.status).toBe(403);
    expect((await noPublish.json() as any).error).toBe("knowledge publish capability is required");
    expect(f.client.writeAttempts).toBe(writes);
    expect(f.store.listKnowledgeCompilationRuns({ workspaceId: "local", repositoryId: "repo_restore" })).toEqual([]);
    const scopedRun = f.store.runAutopilot(autopilot.id, { source: "scm_event", repositoryId: "repo_restore", dedupeKey: "repo_restore:incremental_update:restore", payload: { repository_wiki_repository_id: "repo_restore" } });
    const scoped = await f.store.createTaskAccessToken(f.store.getTask(scopedRun.taskId!)!, "local");
    expect((await f.request({ targets: f.targets, dry_run: false }, scoped.token)).status).toBe(200);
    expect(await f.service.listStrict("local", "repo_restore")).toHaveLength(2);
    const admin = f.store.getOrCreateUser({ email: "restore-admin@example.test", name: "Admin" });
    f.store.createWorkspaceMember({ workspaceId: "local", userId: admin.id, name: "Admin", role: "admin" });
    const adminPat = await f.store.createAccessToken({ workspaceId: "local", userId: admin.id, name: "Admin", type: "pat", purpose: "session" });
    expect((await f.request({ targets: f.targets, dry_run: false }, adminPat.token)).status).toBe(200);
  });
});

describe("Repository Wiki availability and migration safeguards", () => {
  it("publishes an 84-page connected component through OpenViking, drains storage jobs and accepts the next batch", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [{ id: "repo_large", name: "large", url: "https://github.com/acme/large.git", source: "github", default_branch: "main" }]);
    const client = new FakeOpenViking();
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const create = client.create.bind(client);
    client.create = async (...args) => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      try { await Bun.sleep(1); await create(...args); }
      finally { activeWrites--; }
    };
    const service = new RepositoryWikiService(store, client, "openviking");
    const docs = (await service.applyBatch("local", "repo_large", Array.from({ length: 84 }, (_, i) => ({
      kind: "create" as const, input: { path: `old/page-${i}.md`, title: `Page ${i}`, body: `[[old/page-${(i + 1) % 84}]]` },
    })))).map(result => result.doc);
    await service.runStorageJobs();
    const { agent, autopilot } = configureRepositoryWikiAutomation(store);
    const run = store.runAutopilot(autopilot.id, { source: "scm_event", repositoryId: "repo_large", dedupeKey: "repo_large:incremental_update:test", payload: { repository_wiki_repository_id: "repo_large" } });
    const task = store.getTask(run.taskId!)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const submission = store.createKnowledgeSubmission({ workspaceId: "local", repositoryId: "repo_large", scope: "repository_wiki", sourceType: "agent", body: "Regroup the connected section", sourceTaskId: task.id, authorAgentId: agent.id }).submission;
    const app = createMultiremiApp({ store, repositoryWiki: service, authToken: "root-secret" });
    const path = (i: number) => `concepts/domain-${Math.floor(i / 20)}/page-${i}.md`;
    const response = await app.request("/api/workspaces/local/repos/repo_large/wiki/publish", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ submission_ids: [submission.id], dedupe_key: "whole-openviking-migration", outputs: docs.map((doc, i) => ({
        action: "update", ref: doc.id, expected_version: 1, path: path(i), body: `[[${path((i + 1) % 84)}]]`,
      })) }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).run.status).toBe("published");
    const after = await service.listStrict("local", "repo_large");
    expect(after.map(doc => doc.id).sort()).toEqual(docs.map(doc => doc.id).sort());
    for (const doc of after) {
      expect(doc.version).toBe(2);
      expect(doc.contentUri).toBe(repositoryWikiDocUri("local", "repo_large", doc.path));
      expect(sha256Text(client.files.get(doc.contentUri!)!)).toBe(doc.contentSha256!);
      expect(sha256Text(await client.show(doc.snapshotOid!, doc.contentUri!))).toBe(doc.contentSha256!);
      expect(resolveRepositoryWikiRef(tokenizeWikiLinks(doc.body)[0]!.ref, doc.path, after).status).toBe("resolved");
    }
    expect(maxActiveWrites).toBeGreaterThan(1);
    expect(maxActiveWrites).toBeLessThanOrEqual(4);
    expect(store.listRepositoryWikiStorageJobs("local", "repo_large").every(job => job.state === "cleanup")).toBe(true);
    await service.runStorageJobs();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_large")).toEqual([]);
    for (const doc of docs) expect(client.files.has(repositoryWikiDocUri("local", "repo_large", doc.path))).toBe(false);
    const next = await service.update("local", "repo_large", after[0]!.id, { body: `${after[0]!.body}\nNext batch`, expectedVersion: 2 });
    expect(next.version).toBe(3);
    expect(next.contentUri).toBe(repositoryWikiDocUri("local", "repo_large", next.path));
    await service.runStorageJobs();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_large")).toEqual([]);
    expect((await service.get("local", "repo_large", next.id))?.body).toContain("Next batch");
  });

  it("checkpoints promotion across repeated timeouts and restarts without replaying completed pages", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const docs = (await service.applyBatch("local", "repo_resume", Array.from({ length: 24 }, (_, i) => ({
      kind: "create" as const, input: { path: `old/page-${i}.md`, title: `Page ${i}`, body: `[[old/page-${(i + 1) % 24}]]` },
    })))).map(result => result.doc);
    await service.runStorageJobs();
    // Each attempt has enough time for one checkpoint, but its second
    // snapshot never responds (also exercises a client ignoring abort).
    const commit = client.commit.bind(client);
    let promotionCommits = 0;
    let releaseLateSnapshot!: () => void;
    client.commit = async (message) => {
      if (message.endsWith(":promote") && ++promotionCommits === 2) {
        await new Promise<void>(resolve => { releaseLateSnapshot = resolve; });
      }
      return commit(message);
    };
    const restartedService = () => new RepositoryWikiService(store, client, "openviking", { storageJobTimeoutMs: 100, writeTimeoutMs: 2_000 });
    const moved = await restartedService().applyBatch("local", "repo_resume", docs.map((doc, i) => ({
      kind: "update" as const, ref: doc.id, input: { path: `new/page-${i}.md`, body: `[[new/page-${(i + 1) % 24}]]`, expectedVersion: 1 },
    })));
    expect(moved.every(result => result.doc.version === 2)).toBe(true);
    for (const remaining of [16, 8]) {
      const job = store.listRepositoryWikiStorageJobs("local", "repo_resume")[0]!;
      expect(job.state).toBe("pending");
      expect(job.manifest.promotions).toHaveLength(remaining);
      expect(job.lastError).toContain("storage job deadline exceeded");
      const outstanding = new Set(job.manifest.promotions.map(entry => entry.docId));
      const readable = await service.listStrict("local", "repo_resume");
      const completed = readable.filter(doc => !outstanding.has(doc.id));
      expect(completed).toHaveLength(24 - remaining);
      for (const doc of readable) {
        expect(doc.version).toBe(2);
        expect(resolveRepositoryWikiRef(tokenizeWikiLinks(doc.body)[0]!.ref, doc.path, readable).status).toBe("resolved");
      }
      // A late snapshot must not publish another checkpoint after lease release.
      releaseLateSnapshot();
      await Bun.sleep(0);
      expect(store.listRepositoryWikiStorageJobs("local", "repo_resume")[0]!.manifest.promotions).toHaveLength(remaining);
      const completedUris = new Set(completed.map(doc => doc.contentUri!));
      client.readCalls.length = 0;
      promotionCommits = 0;
      await restartedService().runStorageJobs(undefined, Date.now() + 600_000);
      expect(client.readCalls.some(uri => completedUris.has(uri))).toBe(false);
    }
    expect(store.listRepositoryWikiStorageJobs("local", "repo_resume")).toEqual([]);
    const after = await service.listStrict("local", "repo_resume");
    expect(after.every(doc => doc.contentUri === repositoryWikiDocUri("local", "repo_resume", doc.path))).toBe(true);
    client.commit = commit;
    const next = await service.update("local", "repo_resume", after[0]!.id, { body: `${after[0]!.body}\nWritable`, expectedVersion: 2 });
    expect(next.version).toBe(3);
    await service.runStorageJobs();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_resume")).toEqual([]);
  });

  it("rolls back only the unfinished promotion chunk and retains durable checkpoints", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const commit = client.commit.bind(client);
    let promotions = 0;
    client.commit = async (message) => {
      if (message.endsWith(":promote") && ++promotions === 2) throw new Error("second promotion snapshot failed");
      return commit(message);
    };
    const service = new RepositoryWikiService(store, client, "openviking");
    const results = await service.applyBatch("local", "repo_checkpoint", Array.from({ length: 16 }, (_, i) => ({
      kind: "create" as const, input: { path: `page-${i}.md`, title: `Page ${i}`, body: `Facts ${i}` },
    })));
    const job = store.listRepositoryWikiStorageJobs("local", "repo_checkpoint")[0]!;
    expect(job.manifest.promotions).toHaveLength(8);
    for (const [i, result] of results.entries()) {
      const canonical = repositoryWikiDocUri("local", "repo_checkpoint", result.doc.path);
      expect(client.files.has(canonical)).toBe(i < 8);
      expect((await service.get("local", "repo_checkpoint", result.doc.id))?.body).toBe(`Facts ${i}`);
    }
    await service.runStorageJobs(undefined, Date.now() + 600_000);
    expect(store.listRepositoryWikiStorageJobs("local", "repo_checkpoint")).toEqual([]);
    expect((await service.listStrict("local", "repo_checkpoint")).every(doc => doc.contentUri === repositoryWikiDocUri("local", "repo_checkpoint", doc.path))).toBe(true);
  });

  it("fences promotion checkpoints after lease loss without releasing the successor lease", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const commit = client.commit.bind(client);
    let promotions = 0;
    client.commit = async (message) => {
      const oid = await commit(message);
      if (message.endsWith(":promote") && ++promotions === 2) {
        db!.run("UPDATE multiremi_repository_wiki_storage_jobs SET lease_token = 'successor' WHERE repository_id = 'repo_lease'");
      }
      return oid;
    };
    const service = new RepositoryWikiService(store, client, "openviking");
    const results = await service.applyBatch("local", "repo_lease", Array.from({ length: 16 }, (_, i) => ({
      kind: "create" as const, input: { path: `page-${i}.md`, title: `Page ${i}`, body: `Facts ${i}` },
    })));
    const job = store.listRepositoryWikiStorageJobs("local", "repo_lease")[0]!;
    expect(job.state).toBe("pending");
    expect(job.manifest.promotions).toHaveLength(8);
    expect(job.lastError).toContain("lease lost");
    expect(store.claimRepositoryWikiStorageJob(job.id, "outsider", new Date(Date.now() + 120_000).toISOString(), new Date().toISOString())).toBe(false);
    for (const [i, result] of results.entries()) {
      const doc = store.getRepositoryWikiDocByRef("local", "repo_lease", result.doc.id)!;
      expect(doc.contentUri === repositoryWikiDocUri("local", "repo_lease", doc.path)).toBe(i < 8);
      expect(store.listRepositoryWikiDocRevisions(doc.id)[0]!.contentUri).toBe(doc.contentUri);
    }
    store.releaseRepositoryWikiStorageJob(job.id, "successor");
    await new RepositoryWikiService(store, client, "openviking").runStorageJobs(undefined, Date.now() + 600_000);
    expect(store.listRepositoryWikiStorageJobs("local", "repo_lease")).toEqual([]);
  });

  it("publishes beside a missing object and marks a timed-out publication failed instead of validating", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspaceRepositories("local", [{ id: "repo_publish_degraded", name: "publish-degraded", url: "https://github.com/acme/publish-degraded.git", source: "github", default_branch: "main" }]);
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking", { writeTimeoutMs: 50 });
    const missing = await service.create("local", "repo_publish_degraded", { path: "missing.md", title: "Missing", body: "Original" });
    const target = await service.create("local", "repo_publish_degraded", { path: "target.md", title: "Target", body: "Original" });
    await service.runStorageJobs();
    client.files.delete(missing.contentUri!);
    const { agent, autopilot } = configureRepositoryWikiAutomation(store);
    const automation = store.runAutopilot(autopilot.id, { source: "scm_event", repositoryId: "repo_publish_degraded", dedupeKey: "repo_publish_degraded:incremental_update:test", payload: { repository_wiki_repository_id: "repo_publish_degraded" } });
    const task = store.getTask(automation.taskId!)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, repositoryWiki: service, authToken: "root-secret" });
    const publish = (key: string, version: number, pathInput: { path?: string; slug?: string } = {}) => {
      const source = store.createKnowledgeSubmission({ workspaceId: "local", repositoryId: "repo_publish_degraded", scope: "repository_wiki", sourceType: "agent", body: `New facts for ${key}`, sourceTaskId: task.id, authorAgentId: agent.id }).submission;
      return app.request("/api/workspaces/local/repos/repo_publish_degraded/wiki/publish", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
        body: JSON.stringify({ submission_ids: [source.id], dedupe_key: key, output: { action: "update", ref: target.id, expected_version: version, body: "New facts [[missing]]", ...pathInput } }),
      });
    };
    expect((await publish("degraded-publish", 1)).status).toBe(200);
    for (const pathInput of [{ path: "guides/target.md" }, { slug: "guides/target" }]) {
      const rejected = await publish(`degraded-move-${Object.keys(pathInput)[0]}`, 2, pathInput);
      expect(rejected.status).toBe(503);
      const error = (await rejected.json() as any).error;
      expect(error).toContain(missing.id);
      expect(error).toContain(missing.path);
      expect(store.getRepositoryWikiDocByRef("local", "repo_publish_degraded", target.id)).toMatchObject({ path: "target.md", version: 2 });
    }
    const create = client.create.bind(client);
    client.create = async () => new Promise(() => {});
    const response = await publish("timeout-publish", 2);
    expect(response.status).toBe(503);
    expect((await response.json() as any).error).toContain("deadline exceeded");
    const runs = store.listKnowledgeCompilationRunsPage({ workspaceId: "local", repositoryId: "repo_publish_degraded" }).items;
    expect(runs.find(run => run.dedupeKey === "timeout-publish")?.status).toBe("failed");
    expect(store.getRepositoryWikiDocByRef("local", "repo_publish_degraded", target.id)?.version).toBe(2);
    client.create = create;
    expect((await publish("after-timeout", 2)).status).toBe(200);
  });

  it("bounds a hung write, releases the repository lane and fences late metadata commits", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking", { writeTimeoutMs: 50 });
    const target = await service.create("local", "repo_deadline", { path: "target.md", title: "Target", body: "Original" });
    await service.runStorageJobs();
    const create = client.create.bind(client);
    let finishLate!: () => void;
    client.create = async (uri, root, content) => {
      await new Promise<void>(resolve => { finishLate = resolve; });
      await create(uri, root, content);
    };
    await expect(service.update("local", "repo_deadline", target.id, { body: "Timed out" })).rejects.toThrow("write deadline exceeded");
    expect(store.getRepositoryWikiDocByRef("local", "repo_deadline", target.id)?.version).toBe(1);
    client.create = create;
    const recovered = await service.update("local", "repo_deadline", target.id, { body: "Recovered" });
    expect(recovered).toMatchObject({ version: 2, body: "Recovered" });
    finishLate();
    await Bun.sleep(5);
    expect(await service.get("local", "repo_deadline", target.id)).toMatchObject({ version: 2, body: "Recovered" });
  });

  it("refuses migration when outgoing links are unknown and rolls back failed move/merge staging", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const target = await service.create("local", "repo_migrate", { path: "target.md", title: "Target", body: "Target" });
    const source = await service.create("local", "repo_migrate", { path: "source.md", title: "Source", body: "Source" });
    const incoming = await service.create("local", "repo_migrate", { path: "index.md", title: "Index", body: "[[./target]] [[source]]" });
    await service.runStorageJobs();
    client.failReadUris.add(incoming.contentUri!);
    await expect(service.move("local", "repo_migrate", target.id, "guides/target.md")).rejects.toThrow("unreadable");
    await expect(service.merge("local", "repo_migrate", target.id, [source.id])).rejects.toThrow("unreadable");
    client.failReadUris.clear();
    const before = new Map(client.files);
    client.failWriteAt = client.writeAttempts + 2;
    await expect(service.move("local", "repo_migrate", target.id, "guides/target.md")).rejects.toThrow("planned OpenViking write failure");
    expect(client.files).toEqual(before);
    expect(store.getRepositoryWikiDocByRef("local", "repo_migrate", target.id)?.path).toBe("target.md");
    client.failWriteAt = client.writeAttempts + 2;
    await expect(service.merge("local", "repo_migrate", target.id, [source.id])).rejects.toThrow("planned OpenViking write failure");
    expect(client.files).toEqual(before);
    expect(store.getRepositoryWikiDocByRef("local", "repo_migrate", source.id)?.version).toBe(1);
    client.failWriteAt = null;
    await service.move("local", "repo_migrate", target.id, "guides/target.md");
    await service.merge("local", "repo_migrate", target.id, [source.id]);
    expect(await service.get("local", "repo_migrate", target.id)).toMatchObject({ id: target.id, path: "guides/target.md", version: 3 });
    expect((await service.backlinks("local", "repo_migrate", target.id)).map(doc => doc.id)).toEqual([incoming.id]);
  });

  it("keeps content updates and backlinks available but requires readable bodies before deleting", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const missing = await service.create("local", "repo_degraded", { path: "missing.md", title: "Missing", body: "Old content" });
    const target = await service.create("local", "repo_degraded", { path: "target.md", title: "Target", body: "Target" });
    const source = await service.create("local", "repo_degraded", { path: "source.md", title: "Source", body: "[[target]] [[missing]]" });
    const original = client.files.get(missing.contentUri!)!;
    client.files.delete(missing.contentUri!);
    const updated = await service.update("local", "repo_degraded", source.id, { body: "Updated [[target]] [[missing]]" });
    expect(updated.version).toBe(2);
    expect((await service.backlinks("local", "repo_degraded", target.id)).map(doc => doc.id)).toEqual([source.id]);
    expect((await service.backlinks("local", "repo_degraded", missing.id)).map(doc => doc.id)).toEqual([source.id]);
    await expect(service.delete("local", "repo_degraded", target.id)).rejects.toThrow(missing.id);
    await expect(service.update("local", "repo_degraded", source.id, { body: "[[unknown]]" })).rejects.toThrow("unresolved repository wiki link");
    await expect(service.update("local", "repo_degraded", missing.id, { body: "must not overwrite missing data" })).rejects.toThrow("not found");
    await expect(service.delete("local", "repo_degraded", source.id)).rejects.toThrow(missing.id);
    expect(store.getRepositoryWikiDocByRef("local", "repo_degraded", source.id)?.version).toBe(2);
    expect((await service.list("local", "repo_degraded")).find(doc => doc.id === missing.id))
      .toMatchObject({ status: "failed", bodyUnavailable: true });
    client.files.set(missing.contentUri!, original);
    await expect(service.delete("local", "repo_degraded", target.id)).rejects.toThrow("unresolved repository wiki link");
    await service.delete("local", "repo_degraded", source.id);
    await service.delete("local", "repo_degraded", target.id);
    expect(store.getRepositoryWikiDocByRef("local", "repo_degraded", missing.id)?.version).toBe(1);
    expect((await service.list("local", "repo_degraded"))[0]).toMatchObject({ id: missing.id, status: "healthy" });
  });

  it.each(["missing", "corrupt"])("rejects path changes and deletes atomically when an untouched referrer is %s", async (failure) => {
    const store = createLocalStore();
    store.updateWorkspaceRepositories("local", [{ id: "repo_graph", name: "graph", url: "https://github.com/acme/graph.git", source: "github", default_branch: "main" }]);
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const target = await service.create("local", "repo_graph", { path: "target.md", title: "Target", body: "Original" });
    const hidden = await service.create("local", "repo_graph", { path: "hidden.md", title: "Hidden referrer", body: "[[./target]]" });
    await service.runStorageJobs();
    const raw = client.files.get(hidden.contentUri!)!;
    if (failure === "missing") client.files.delete(hidden.contentUri!);
    else client.files.set(hidden.contentUri!, `${raw}\ncorrupt`);

    // An explicit but unchanged normalized path is still a content edit.
    await service.update("local", "repo_graph", target.id, { path: "target", body: "Edited", expectedVersion: 1 });
    const added = await service.create("local", "repo_graph", { path: "added.md", title: "Added", body: "New facts" });
    expect(await service.backlinks("local", "repo_graph", target.id)).toEqual([]);
    await service.runStorageJobs();
    const metadata = store.listRepositoryWikiDocs("local", "repo_graph");
    const files = new Map(client.files);
    const writeAttempts = client.writeAttempts;
    const commits = client.commits.length;
    const app = createMultiremiApp({ store, repositoryWiki: service, authToken: "root-secret" });
    const requests = [
      { method: "PUT", path: `/${target.id}`, body: { path: "guides/target.md", expected_version: 2 } },
      { method: "POST", path: "/batch", body: { operations: [
        { kind: "create", input: { path: "must-not-exist.md", title: "Pending", body: "Pending" } },
        { kind: "update", ref: target.id, input: { slug: "guides/target", expected_version: 2 } },
      ] } },
      { method: "DELETE", path: `/${target.id}`, body: undefined },
      { method: "POST", path: "/batch", body: { operations: [
        { kind: "update", ref: added.id, input: { body: "Must roll back", expected_version: 1 } },
        { kind: "delete", ref: target.id, expected_version: 2 },
      ] } },
      { method: "POST", path: "/move", body: { ref: target.id, path: "guides/target.md", expected_version: 2 } },
      { method: "POST", path: "/merge", body: { target: target.id, sources: [added.id], expected_version: 2 } },
    ];
    for (const request of requests) {
      const response = await app.request(`/api/workspaces/local/repos/repo_graph/wiki${request.path}`, {
        method: request.method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer root-secret" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      expect(response.status).toBe(503);
      const error = (await response.json() as any).error;
      expect(error).toContain(hidden.id);
      expect(error).toContain(hidden.path);
      expect(store.listRepositoryWikiDocs("local", "repo_graph")).toEqual(metadata);
      expect(client.files).toEqual(files);
      expect(client.writeAttempts).toBe(writeAttempts);
      expect(client.commits).toHaveLength(commits);
      expect(store.listRepositoryWikiStorageJobs("local", "repo_graph")).toEqual([]);
    }

    // Recovery restores both the full graph and migration, without losing IDs.
    client.files.set(hidden.contentUri!, raw);
    await expect(service.delete("local", "repo_graph", target.id)).rejects.toThrow("unresolved repository wiki link");
    await service.move("local", "repo_graph", target.id, "guides/target.md");
    expect(await service.get("local", "repo_graph", target.id)).toMatchObject({ id: target.id, path: "guides/target.md", version: 3 });
    expect((await service.backlinks("local", "repo_graph", target.id)).map(doc => doc.id)).toEqual([hidden.id]);
    expect((await service.get("local", "repo_graph", hidden.id))?.body).toBe("[[guides/target.md]]");
  });

});

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

    const readsBeforeRecall = client.readCalls.length;
    const hits = await service.recallProjectDocs(alpha.id, "Phoenix rollback", { kind: "memory" });
    expect(hits.map((hit) => hit.doc.id)).toEqual([memory.id]);
    expect(hits[0]).toMatchObject({ score: 0.9, snippet: "match:Phoenix rollback" });
    expect(hits[0]!.doc.body).toBe("");
    expect(client.readCalls).toHaveLength(readsBeforeRecall);
    expect(client.findTargets.at(-1)).toBe(`viking://resources/multiremi/workspaces/local/projects/${alpha.id}/knowledge/memory`);

    const searched = await service.searchProjectDocs(alpha.id, "Phoenix rollback", { kind: "memory" });
    expect(searched).toHaveLength(1);
    expect(searched[0]!.body).toBe("The platform team owns Phoenix rollback.");
    expect(client.readCalls).toHaveLength(readsBeforeRecall + 1);

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
    await service.createProjectDoc(project.id, {
      kind: "wiki",
      title: "Index",
      body: "See [[runbook#deploy|deployment guide]] and [[#summary]].",
    });
    await service.createProjectDoc(project.id, {
      kind: "wiki",
      title: "Examples",
      body: "`[[runbook]]`\n```md\n[[runbook]]\n```",
    });
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

  it("hydrates only limited search hits with bounded failure-isolated concurrency", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Bounded search" });
    const docs = [];
    for (let index = 0; index < 6; index++) {
      docs.push(await service.createProjectDoc(project.id, {
        kind: "memory",
        title: `Search result ${index}`,
        body: `bounded hydration body ${index}`,
      }));
    }

    client.readCalls.length = 0;
    client.readDelayMs = 10;
    client.failReadUris.add(docs[1]!.contentUri!);
    const results = await service.searchProjectDocs(project.id, "bounded hydration", { limit: 4 });

    expect(results.map((doc) => doc.id)).toEqual([docs[0]!.id, docs[2]!.id, docs[3]!.id]);
    expect(results.every((doc) => doc.body.includes("bounded hydration body"))).toBe(true);
    expect(client.readCalls).toHaveLength(4);
    expect(client.maxActiveReads).toBe(4);
  });

  it("hydrates workspace search hits concurrently, only up to the limit, from one index snapshot", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Workspace search" });
    const docs = [];
    for (let index = 0; index < 9; index++) {
      docs.push(await service.createProjectDoc(project.id, {
        kind: "memory",
        title: `Workspace hit ${index}`,
        body: `workspace hydration body ${index}`,
      }));
    }

    let indexSnapshots = 0;
    const listForMigration = store.listProjectDocsForMigration.bind(store);
    (store as unknown as Record<string, unknown>).listProjectDocsForMigration = (...args: unknown[]) => {
      indexSnapshots++;
      return (listForMigration as (...a: unknown[]) => unknown)(...args);
    };

    client.readCalls.length = 0;
    client.readDelayMs = 10;
    client.failReadUris.add(docs[1]!.contentUri!);
    const results = await service.listWorkspaceDocs(project.workspaceId, { q: "workspace hydration", limit: 5 });

    // The index is read once for the whole request, not once per candidate hit.
    expect(indexSnapshots).toBe(1);
    // Only the 5 docs that survive the limit are hydrated — not all `limit * 3` candidates.
    expect(client.readCalls).toHaveLength(5);
    expect(client.maxActiveReads).toBe(5);
    // The unreadable doc is dropped instead of failing the whole listing.
    expect(results.map((doc) => doc.id)).toEqual([docs[0]!.id, docs[2]!.id, docs[3]!.id, docs[4]!.id]);
    expect(results.every((doc) => doc.body.includes("workspace hydration body"))).toBe(true);
    expect(results.every((doc) => doc.projectTitle === "Workspace search")).toBe(true);
  });

  it("lists workspace metadata without reading OpenViking document bodies", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Fast knowledge index" });
    await service.createProjectDoc(project.id, {
      kind: "wiki",
      title: "Architecture",
      summary: "System boundaries",
      body: "A deliberately remote document body.",
    });

    client.readCalls.length = 0;
    const results = await service.listWorkspaceDocs(project.workspaceId, { includeBody: false });

    expect(results.find((doc) => doc.title === "Architecture")).toMatchObject({
      title: "Architecture",
      summary: "System boundaries",
      body: "",
    });
    expect(results.every((doc) => doc.body === "")).toBe(true);
    expect(client.readCalls).toHaveLength(0);
  });

  it("caps hydration concurrency instead of fanning out one read per doc at once", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new ProjectKnowledgeService(store, client, "openviking");
    const project = store.createProject({ title: "Fan-out cap" });
    for (let index = 0; index < 20; index++) {
      await service.createProjectDoc(project.id, {
        kind: "memory",
        title: `Capped ${index}`,
        body: `capped fan-out body ${index}`,
      });
    }

    client.readCalls.length = 0;
    client.readDelayMs = 5;
    const results = await service.listWorkspaceDocs(project.workspaceId, { q: "capped fan-out", limit: 20 });

    expect(results).toHaveLength(20);
    expect(client.readCalls).toHaveLength(20);
    expect(client.maxActiveReads).toBeGreaterThan(1);
    expect(client.maxActiveReads).toBeLessThanOrEqual(16);
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
  it("also drains storage jobs in shadow mode", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "shadow");
    const doc = await service.create("local", "repo_alpha", { title: "Shadow", path: "shadow.md", body: "Facts" });
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toHaveLength(1);
    await service.runStorageJobs();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
    expect((await service.get("local", "repo_alpha", doc.id))?.body).toBe("Facts");
  });

  it("keeps reads and task hydration responsive behind 100 blocked cleanup paths", async () => {
    const store = createLocalStore();
    store.updateWorkspace("local", { repos: [{ id: "repo_alpha", name: "Alpha", url: "https://example.com/alpha.git" }] });
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const operations = Array.from({ length: 100 }, (_, i) => ({ kind: "create" as const,
      input: { title: `Page ${i}`, path: `page-${i}.md`, body: `Facts ${i}` } }));
    await service.applyBatch("local", "repo_alpha", operations);
    let active = 0;
    let maximum = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remove = client.remove.bind(client);
    client.remove = async (uri, options?: { wait?: boolean }) => {
      expect(options?.wait).toBe(false);
      active++;
      maximum = Math.max(maximum, active);
      if (active === 8) entered.resolve();
      await release.promise;
      await remove(uri);
      active--;
    };
    const cleaning = service.runStorageJobs();
    await entered.promise;
    try {
      await new RepositoryWikiService(store, client, "openviking").runStorageJobs();
      const task = { workspaceId: "local", projectResources: [{ resourceType: "github_repo",
        resourceRef: { url: "https://example.com/alpha.git" } }], repos: [] } as any;
      const hydrated = await Promise.race([service.hydrateTaskWiki(task),
        Bun.sleep(500).then(() => { throw new Error("cleanup blocked hydration"); })]);
      expect(hydrated.repositoryWikiContexts?.[0]?.docs).toHaveLength(100);
      expect(await service.list("local", "repo_alpha")).toHaveLength(100);
      expect(maximum).toBe(8);
    } finally {
      release.resolve();
      await cleaning;
    }
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
  });

  it("checkpoints successful deletes and retries only failed paths after restart", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking", { cleanupConcurrency: 2 });
    await service.applyBatch("local", "repo_alpha", [0, 1, 2].map(i => ({ kind: "create",
      input: { title: `Page ${i}`, path: `page-${i}.md`, body: "Facts" } })));
    client.failRemoves = 1;
    await service.runStorageJobs();
    const job = store.listRepositoryWikiStorageJobs("local", "repo_alpha")[0]!;
    expect(job.manifest.completedCleanupUris).toHaveLength(2);
    const visited: string[] = [];
    const exists = client.exists.bind(client);
    client.exists = async uri => { visited.push(uri); return exists(uri); };
    const restarted = new RepositoryWikiService(store, client, "openviking");
    await restarted.runStorageJobs();
    expect(visited).toEqual([]);
    await restarted.runStorageJobs(undefined, Date.now() + 600_000);
    expect(visited).toHaveLength(1);
    expect(job.manifest.completedCleanupUris).not.toContain(visited[0]);
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
  });

  it("retains progress when the cleanup snapshot fails and does not repeat deletes", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const doc = await service.create("local", "repo_alpha", { title: "Page", path: "page.md", body: "Facts" });
    client.failCommits = 1;
    await service.runStorageJobs();
    const job = store.listRepositoryWikiStorageJobs("local", "repo_alpha")[0]!;
    expect(job.manifest.completedCleanupUris).toEqual(job.manifest.cleanupUris);
    client.remove = async () => { throw new Error("completed path must not be deleted again"); };
    await new RepositoryWikiService(store, client, "openviking").runStorageJobs(undefined, Date.now() + 600_000);
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
    expect(client.files.has(doc.contentUri!)).toBe(true);
  });

  it("cancels background requests and releases the lease without losing the job", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    await service.create("local", "repo_alpha", { title: "Page", path: "page.md", body: "Facts" });
    const entered = Promise.withResolvers<void>();
    (client as OpenVikingClientContract).withSignal = signal => {
      const scoped = Object.create(client) as FakeOpenViking;
      scoped.remove = async () => {
        entered.resolve();
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      };
      return scoped;
    };
    const abort = new AbortController();
    const run = service.runStorageJobs(abort.signal);
    await entered.promise;
    abort.abort();
    await run;
    const job = store.listRepositoryWikiStorageJobs("local", "repo_alpha")[0]!;
    expect(job.manifest.completedCleanupUris).toEqual([]);
    expect(store.claimRepositoryWikiStorageJob(job.id, "next-worker", new Date(Date.now() + 120_000).toISOString(), new Date().toISOString())).toBe(true);
    store.releaseRepositoryWikiStorageJob(job.id, "next-worker");
  });

  it("refuses a cleanup manifest that points at live or out-of-scope content", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const doc = await service.create("local", "repo_alpha", { title: "Live", path: "live.md", body: "Facts" });
    const job = store.listRepositoryWikiStorageJobs("local", "repo_alpha")[0]!;
    for (const uri of [doc.contentUri!, "viking://resources/another-workspace/page.md"]) {
      db!.run("UPDATE multiremi_repository_wiki_storage_jobs SET manifest = ? WHERE id = ?",
        [JSON.stringify({ ...job.manifest, cleanupUris: [uri] }), job.id]);
      await service.runStorageJobs(undefined, Date.now() + 600_000);
      expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")[0]?.lastError).toContain("Unsafe Wiki cleanup target");
      expect(client.files.has(doc.contentUri!)).toBe(true);
    }
  });

  it("isolates unreadable pages in repository lists and marks their bodies unavailable", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const healthy = await service.create("local", "repo_alpha", {
      title: "Healthy page",
      path: "healthy.md",
      body: "Readable repository knowledge",
    });
    const missing = await service.create("local", "repo_alpha", {
      title: "Missing page",
      path: "missing.md",
      body: "This object will disappear",
    });
    const corrupt = await service.create("local", "repo_alpha", {
      title: "Corrupt page",
      path: "corrupt.md",
      body: "This object will fail its checksum",
    });
    client.files.delete(missing.contentUri!);
    client.files.set(corrupt.contentUri!, `${client.files.get(corrupt.contentUri!)}\ncorrupt`);

    const docs = await service.list("local", "repo_alpha");

    expect(docs).toHaveLength(3);
    expect(docs.find((doc) => doc.id === healthy.id)).toMatchObject({
      body: "Readable repository knowledge",
      status: "healthy",
      syncStatus: "ready",
    });
    for (const [unavailable, cause] of [[missing, "not found"], [corrupt, "checksum mismatch"]] as const) {
      const result = docs.find((doc) => doc.id === unavailable.id);
      expect(result).toMatchObject({
        body: "",
        status: "failed",
        syncStatus: "failed",
      });
      expect(result?.statusMessage)
        .toContain(`Repository wiki body unavailable for ${unavailable.id}`);
      expect(result?.statusMessage).toContain(cause);
      expect(result?.syncError).toBe(result?.statusMessage);
      expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", unavailable.id)).toMatchObject({
        status: "healthy",
        statusMessage: null,
        syncStatus: "ready",
        syncError: null,
      });
    }
  });

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
    expect(client.files.get(repositoryWikiDocUri("local", "repo_alpha", "architecture/overview.md")))
      .toContain(`id: ${first.id}`);
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

  it("resolves Repository Wiki backlinks with anchors while ignoring code examples", async () => {
    const store = createStore();
    const service = new RepositoryWikiService(store, new FakeOpenViking(), "openviking");
    const target = await service.create("local", "repo_alpha", {
      title: "Architecture",
      path: "guides/architecture.md",
      body: "Architecture",
    });
    const source = await service.create("local", "repo_alpha", {
      title: "Index",
      path: "guides/index.md",
      body: "Read [[architecture#overview|the overview]].",
    });
    await service.create("local", "repo_alpha", {
      title: "Examples",
      path: "guides/examples.md",
      body: "`[[architecture]]`\n```md\n[[architecture]]\n```",
    });

    expect((await service.backlinks("local", "repo_alpha", target.id)).map((doc) => doc.id))
      .toEqual([source.id]);
  });

  it("isolates unreadable graph sources while failing closed for touched bodies and new broken links", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const target = await service.create("local", "repo_alpha", {
      title: "Target", path: "target.md", body: "Target",
    });
    const source = await service.create("local", "repo_alpha", {
      title: "Source", path: "source.md", body: "Read [[target]].",
    });
    client.failReadUris.add(source.contentUri!);

    // MUL-316 changes the ordinary-write contract; listStrict and all writes
    // to the unreadable source must still fail closed.
    expect(await service.backlinks("local", "repo_alpha", target.id)).toEqual([]);
    await expect(service.listStrict("local", "repo_alpha")).rejects.toThrow("planned unreadable content");
    const result = await service.applyBatch("local", "repo_alpha", [{
      kind: "update",
      ref: target.id,
      input: { body: "Independent update", expected_version: target.version },
    }]);
    expect(result[0]?.doc).toMatchObject({ id: target.id, version: 2, body: "Independent update" });
    await expect(service.applyBatch("local", "repo_alpha", [{
      kind: "update", ref: source.id,
      input: { body: "Must not overwrite an unreadable source", expected_version: source.version },
    }])).rejects.toThrow("planned unreadable content");
    await expect(service.applyBatch("local", "repo_alpha", [{
      kind: "update", ref: target.id,
      input: { body: "[[new-broken]]", expected_version: 2 },
    }])).rejects.toThrow("unresolved repository wiki link");
    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", target.id)).toMatchObject({ version: 2 });
    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", source.id)).toMatchObject({ version: 1 });
  });

  it("compensates staged OpenViking writes when a repository batch fails before metadata commit", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const target = await service.create("local", "repo_alpha", {
      title: "Target", path: "guides/target.md", body: "Target v1",
    });
    const source = await service.create("local", "repo_alpha", {
      title: "Source", path: "guides/index.md", body: "Read [[target]].",
    });
    await service.runStorageJobs();
    const filesBefore = new Map(client.files);
    client.failWriteAt = client.writeAttempts + 2;

    await expect(service.applyBatch("local", "repo_alpha", [
      {
        kind: "update",
        ref: target.id,
        input: { path: "archive/target.md", expected_version: target.version },
      },
      {
        kind: "update",
        ref: source.id,
        input: { body: "Read [[archive/target]].", expected_version: source.version },
      },
    ])).rejects.toThrow("planned OpenViking write failure");

    expect(client.files).toEqual(filesBefore);
    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", target.id)).toMatchObject({
      path: "guides/target.md", version: 1,
    });
    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", source.id)).toMatchObject({ version: 1 });
  });

  it("reads committed staging content without repair and promotes it in the background", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const canonicalUri = repositoryWikiDocUri("local", "repo_alpha", "guides/target.md");
    client.failWriteAt = 2;

    const created = await service.create("local", "repo_alpha", {
      title: "Target", path: "guides/target.md", body: "Target v1",
    });

    expect(created.contentUri).toStartWith(`${repositoryWikiStorageRootUri("local", "repo_alpha")}/batches/`);
    expect(client.files.has(canonicalUri)).toBeFalse();
    const restarted = new RepositoryWikiService(store, client, "openviking");
    expect((await restarted.get("local", "repo_alpha", created.id))?.body).toBe("Target v1");
    expect(client.files.has(canonicalUri)).toBeFalse();
    await restarted.runStorageJobs(undefined, Date.now() + 600_000);
    const repaired = await restarted.get("local", "repo_alpha", created.id);
    expect(repaired).toMatchObject({ contentUri: canonicalUri, body: "Target v1", syncStatus: "ready" });
    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", created.id)?.contentUri).toBe(canonicalUri);
    expect(client.files.get(canonicalUri)).toContain("Target v1");
    expect(client.files.has(created.contentUri!)).toBeFalse();
  });

  it("returns workspace summaries without touching deferred OpenViking jobs", async () => {
    const store = createLocalStore();
    store.updateWorkspace("local", { repos: [{ id: "repo_alpha", name: "Alpha", url: "https://github.com/example/alpha.git", source: "github" }] });
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    client.failWriteAt = 2;
    const created = await service.create("local", "repo_alpha", {
      title: "Target", path: "guides/target.md", body: "Committed facts",
    });
    const jobs = store.listRepositoryWikiStorageJobs("local", "repo_alpha");
    expect(jobs).toHaveLength(1);
    client.readCalls.length = 0;
    const writes = client.writeAttempts;
    const commits = client.commits.length;
    const app = createMultiremiApp({ store, repositoryWiki: service, authToken: "summary-test" });
    const response = await app.request("/api/workspaces/local/repository-wikis", { headers: { Authorization: "Bearer summary-test" } });
    expect(response.status).toBe(200);
    const data = await response.json() as { repositories: Array<{ repository_id: string; page_count: number }> };
    expect(data.repositories).toMatchObject([{ repository_id: "repo_alpha", page_count: 1 }]);
    expect(client.readCalls).toEqual([]);
    expect(client.writeAttempts).toBe(writes);
    expect(client.commits).toHaveLength(commits);
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual(jobs);
    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", created.id)?.contentUri).toBe(created.contentUri);
    expect(await service.listWorkspace("another-workspace")).toEqual([]);
    // Target-specific reads also remain read-only; repair is owned by the worker.
    expect((await service.get("local", "repo_alpha", created.id))?.body).toBe("Committed facts");
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual(jobs);
    await service.runStorageJobs(undefined, Date.now() + 600_000);
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
  });

  it("does not wait for an in-flight canonical repair lock to list summaries", async () => {
    const store = createLocalStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    client.failWriteAt = 2;
    const created = await service.create("local", "repo_alpha", { title: "Target", path: "target.md", body: "Facts" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalRead = client.read.bind(client);
    client.read = async (uri) => { entered.resolve(); await release.promise; return originalRead(uri); };
    const repairing = service.get("local", "repo_alpha", created.id);
    await entered.promise;
    let settled = false;
    const listing = service.listWorkspace("local").then((docs) => { settled = true; return docs; });
    try {
      // listWorkspace is metadata-only and must settle without releasing the repair.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(settled).toBe(true);
    } finally {
      release.resolve();
      await repairing;
      await listing;
    }
  });

  it("repairs a moved page and removes its obsolete canonical URI after restart", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const oldUri = repositoryWikiDocUri("local", "repo_alpha", "old/target.md");
    const newUri = repositoryWikiDocUri("local", "repo_alpha", "new/target.md");
    const created = await service.create("local", "repo_alpha", {
      title: "Target", path: "old/target.md", body: "Target v1",
    });
    client.failWriteAt = client.writeAttempts + 2;

    const moved = await service.update("local", "repo_alpha", created.id, {
      path: "new/target.md", expectedVersion: created.version,
    });

    expect(moved.contentUri).toStartWith(`${repositoryWikiStorageRootUri("local", "repo_alpha")}/batches/`);
    expect(client.files.has(oldUri)).toBeTrue();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toHaveLength(1);
    const restarted = new RepositoryWikiService(store, client, "openviking");
    await restarted.runStorageJobs(undefined, Date.now() + 600_000);
    const repaired = await restarted.get("local", "repo_alpha", created.id);
    expect(repaired).toMatchObject({ path: "new/target.md", contentUri: newUri, body: "Target v1" });
    expect(client.files.has(oldUri)).toBeFalse();
    expect(client.files.has(newUri)).toBeTrue();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
  });

  it("does not start another repository batch while storage repair is failing", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const created = await service.create("local", "repo_alpha", {
      title: "Target", path: "target.md", body: "Version one",
    });
    client.failWriteAt = client.writeAttempts + 2;
    const deferred = await service.update("local", "repo_alpha", created.id, {
      path: "moved.md", expectedVersion: created.version,
    });
    client.failWrites = 10;

    await expect(service.update("local", "repo_alpha", created.id, {
      body: "Must not be committed", expectedVersion: deferred.version,
    })).rejects.toThrow("storage repair is still pending");

    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", created.id)).toMatchObject({
      path: "moved.md", version: 2,
    });
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toHaveLength(1);
  });

  it("retries delete-only canonical cleanup after restart", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const canonicalUri = repositoryWikiDocUri("local", "repo_alpha", "delete-me.md");
    const created = await service.create("local", "repo_alpha", {
      title: "Delete me", path: "delete-me.md", body: "Temporary",
    });
    await service.runStorageJobs();
    client.failRemoves = 1;

    await service.delete("local", "repo_alpha", created.id, created.version);
    await service.runStorageJobs();

    expect(store.getRepositoryWikiDocByRef("local", "repo_alpha", created.id)).toBeNull();
    expect(client.files.has(canonicalUri)).toBeTrue();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toHaveLength(1);
    const restarted = new RepositoryWikiService(store, client, "openviking");
    expect(await restarted.listWorkspace("local")).toEqual([]);
    expect(client.files.has(canonicalUri)).toBeTrue();
    // Neither overview nor target reads repair storage.
    expect(await restarted.list("local", "repo_alpha")).toEqual([]);
    expect(client.files.has(canonicalUri)).toBeTrue();
    await restarted.runStorageJobs(undefined, Date.now() + 600_000);
    expect(client.files.has(canonicalUri)).toBeFalse();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
  });

  it("does not confuse a public __revisions path with internal staging", async () => {
    const store = createStore();
    const client = new FakeOpenViking();
    const service = new RepositoryWikiService(store, client, "openviking");
    const canonicalUri = repositoryWikiDocUri("local", "repo_alpha", "__revisions/page.md");
    const created = await service.create("local", "repo_alpha", {
      title: "Public page", path: "__revisions/page.md", body: "Visible",
    });

    expect((await service.get("local", "repo_alpha", created.id))?.contentUri).toBe(canonicalUri);
    expect(client.files.has(canonicalUri)).toBeTrue();
    await service.runStorageJobs();
    expect(store.listRepositoryWikiStorageJobs("local", "repo_alpha")).toEqual([]);
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

    await service.runStorageJobs();
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

  it("hydrates a manual repository Wiki build with only its workspace repository", async () => {
    const store = createLocalStore();
    const service = new RepositoryWikiService(store, new FakeOpenViking(), "openviking");
    store.updateWorkspace("local", {
      repos: [{ id: "repo_bootstrap", name: "bootstrap", url: "git@github.com:example/bootstrap.git" }],
    });
    const { autopilot } = configureRepositoryWikiAutomation(store);
    const run = store.runAutopilot(autopilot.id, {
      payload: { repository_wiki_repository_id: "repo_bootstrap" },
    });

    const hydrated = await service.hydrateTaskWiki({
      workspaceId: "local",
      autopilotRunId: run.id,
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

  it("does not hydrate bootstrap context for a user-owned same-title autopilot", async () => {
    const store = createLocalStore();
    const service = new RepositoryWikiService(store, new FakeOpenViking(), "openviking");
    store.updateWorkspace("local", {
      repos: [{ id: "repo_private", name: "private", url: "git@github.com:example/private.git" }],
    });
    store.createAgent({ name: "Atlas · LLM Wiki", provider: "claude" });
    const userAgent = store.createAgent({ name: "User Wiki", provider: "claude" });
    const sameTitle = store.createAutopilot({
      title: "Atlas · Repository Wiki",
      workspaceId: "local",
      assigneeId: userAgent.id,
      executionMode: "run_only",
    });
    const run = store.runAutopilot(sameTitle.id, {
      payload: { repository_wiki_repository_id: "repo_private" },
    });

    const hydrated = await service.hydrateTaskWiki({
      workspaceId: "local",
      autopilotRunId: run.id,
      assignmentSourceEventId: null,
      projectResources: [],
      repos: [],
    } as any);

    expect(hydrated.repos).toEqual([]);
    expect(hydrated.repositoryWikiContexts).toBeUndefined();
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
