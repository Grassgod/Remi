import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { resolveRepositoryWikiRef, tokenizeWikiLinks } from "@multiremi/contracts/wiki-links";
import { configureRepositoryWikiAutomation, createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.updateWorkspaceRepositories("local", [{ id: "repo_migration", name: "migration", url: "https://github.com/acme/migration.git", source: "github", default_branch: "main" }]);
  const service = new RepositoryWikiService(store, null, "sql");
  return { store, service };
}

describe("Repository Wiki atomic migrations", () => {
  it("moves incoming and outgoing relative references without changing stable identities", async () => {
    const { store, service } = fixture();
    const sibling = store.createRepositoryWikiDoc("local", "repo_migration", { path: "old/sibling.md", title: "Sibling", body: "Facts" });
    store.createRepositoryWikiDoc("local", "repo_migration", { path: "new/sibling.md", title: "Other sibling", body: "Other facts" });
    const moved = store.createRepositoryWikiDoc("local", "repo_migration", { path: "old/guide.md", title: "Guide", body: "[[./sibling#usage|Read sibling]] [[#local]] `[[./sibling]]`" });
    const incoming = store.createRepositoryWikiDoc("local", "repo_migration", { path: "index.md", title: "Index", body: "[[old/guide#usage|Guide]]" });
    await service.move("local", "repo_migration", moved.id, "new/guide.md", { expectedVersion: 1 });
    const after = await service.list("local", "repo_migration");
    const guide = after.find(doc => doc.id === moved.id)!;
    expect(guide).toMatchObject({ id: moved.id, path: "new/guide.md", version: 2 });
    expect(guide.body).toContain("[[old/sibling.md#usage|Read sibling]]");
    expect(guide.body).toContain("[[#local]] `[[./sibling]]`");
    expect(after.find(doc => doc.id === incoming.id)?.body).toBe("[[new/guide.md#usage|Guide]]");
    expect((await service.backlinks("local", "repo_migration", sibling.id)).map(doc => doc.id)).toEqual([moved.id]);
    expect((await service.backlinks("local", "repo_migration", moved.id)).map(doc => doc.id)).toEqual([incoming.id]);
    await expect(service.move("local", "repo_migration", moved.id, "archive/guide.md", { expectedVersion: 1 })).rejects.toThrow("version conflict");
    await expect(service.move("local", "repo_migration", moved.id, sibling.path)).rejects.toThrow("already exists");
    expect((await service.get("local", "repo_migration", moved.id))?.version).toBe(2);
  });

  it("merges content, tags and provenance references into the stable target and rewrites source-ID links", async () => {
    const { store, service } = fixture();
    const target = store.createRepositoryWikiDoc("local", "repo_migration", { path: "guide.md", title: "Guide", body: "Authoritative", tags: ["target"], refs: [{ type: "url", value: "https://example.test/target" }] });
    const sibling = store.createRepositoryWikiDoc("local", "repo_migration", { path: "old/sibling.md", title: "Sibling", body: "Facts" });
    const source = store.createRepositoryWikiDoc("local", "repo_migration", { path: "old/source.md", title: "Extra", body: "More [[./sibling#usage|Sibling]]", tags: ["source"], refs: [{ type: "url", value: "https://example.test/source" }] });
    const incoming = store.createRepositoryWikiDoc("local", "repo_migration", { path: "index.md", title: "Index", body: `[[${source.id}#usage|Extra]] [[old/source]] [[guide]]` });
    await service.merge("local", "repo_migration", target.id, [source.path], { expectedVersion: 1 });
    const after = await service.list("local", "repo_migration");
    const merged = after.find(doc => doc.id === target.id)!;
    expect(merged).toMatchObject({ id: target.id, path: "guide.md", version: 2, tags: ["target", "source"] });
    expect(merged.refs).toHaveLength(2);
    expect(merged.body).toContain("## Extra\n\nMore [[old/sibling.md#usage|Sibling]]");
    expect(after.some(doc => doc.id === source.id)).toBe(false);
    expect(after.find(doc => doc.id === incoming.id)?.body).toBe("[[guide.md#usage|Extra]] [[guide.md]] [[guide]]");
    expect((await service.backlinks("local", "repo_migration", target.id)).map(doc => doc.id)).toEqual([incoming.id]);
    expect((await service.backlinks("local", "repo_migration", sibling.id)).map(doc => doc.id)).toEqual([target.id]);
    expect(store.listRepositoryWikiDocRevisions(target.id).map(doc => doc.version)).toEqual([2, 1]);
  });

  it("publishes an 84-page connected component atomically and rejects 257 outputs", async () => {
    const { store } = fixture();
    const { agent, autopilot } = configureRepositoryWikiAutomation(store);
    const run = store.runAutopilot(autopilot.id, { source: "scm_event", repositoryId: "repo_migration", dedupeKey: "repo_migration:incremental_update:test", payload: { repository_wiki_repository_id: "repo_migration" } });
    const task = store.getTask(run.taskId!)!;
    const credential = await store.createTaskAccessToken(task, "local");
    const submission = store.createKnowledgeSubmission({ workspaceId: "local", repositoryId: "repo_migration", scope: "repository_wiki", sourceType: "agent", body: "Regroup the connected section", sourceTaskId: task.id, authorAgentId: agent.id }).submission;
    const docs = Array.from({ length: 84 }, (_, index) => store.createRepositoryWikiDoc("local", "repo_migration", {
      path: `old/page-${index}.md`, title: `Page ${index}`, body: `[[old/page-${(index + 1) % 84}]]`,
    }));
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const request = (outputs: unknown[], key: string) => app.request("/api/workspaces/local/repos/repo_migration/wiki/publish", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ submission_ids: [submission.id], dedupe_key: key, outputs }),
    });
    const outputs = docs.map((doc, index) => ({ action: "update", ref: doc.id, expected_version: 1, path: `concepts/domain-${Math.floor(index / 20)}/page-${index}.md`, body: `[[concepts/domain-${Math.floor(((index + 1) % 84) / 20)}/page-${(index + 1) % 84}]]` }));
    const split = await request(outputs.slice(0, 50), "split-migration");
    expect(split.status).toBe(409);
    expect(store.listRepositoryWikiDocs("local", "repo_migration").every(doc => doc.version === 1)).toBe(true);
    const tooLarge = await request(Array.from({ length: 257 }, () => ({ action: "noop" })), "oversized");
    expect(tooLarge.status).toBe(400);
    expect((await tooLarge.json() as any).error).toContain("256");
    const response = await request(outputs, "whole-migration");
    expect(response.status).toBe(200);
    expect((await response.json() as any).run.status).toBe("published");
    const after = store.listRepositoryWikiDocs("local", "repo_migration");
    expect(after.map(doc => doc.id).sort()).toEqual(docs.map(doc => doc.id).sort());
    expect(after.every(doc => doc.version === 2)).toBe(true);
    for (const doc of after) {
      const token = tokenizeWikiLinks(doc.body)[0]!;
      expect(resolveRepositoryWikiRef(token.ref, doc.path, after).status).toBe("resolved");
    }
  });

  it("serves move/merge to members with provenance and rejects ordinary task publication", async () => {
    const { store } = fixture();
    const one = store.createRepositoryWikiDoc("local", "repo_migration", { path: "one.md", title: "One", body: "One" });
    const two = store.createRepositoryWikiDoc("local", "repo_migration", { path: "two.md", title: "Two", body: "Two" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const post = (action: string, body: unknown, token = "root-secret") => app.request(`/api/workspaces/local/repos/repo_migration/wiki/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    const moved = await post("move", { ref: one.id, path: "guides/one.md", expected_version: 1 });
    expect(moved.status).toBe(200);
    const movedRun = (await moved.json() as any).run;
    expect(store.listRepositoryWikiDocRevisions(one.id)[0]?.compilationRunId).toBe(movedRun.id);
    const merged = await post("merge", { target: one.id, sources: [two.id], expected_version: 2 });
    expect(merged.status).toBe(200);
    expect(store.getRepositoryWikiDocByRef("local", "repo_migration", one.id)?.version).toBe(3);
    expect(store.getRepositoryWikiDocByRef("local", "repo_migration", two.id)).toBeNull();
    const project = store.createProject({ title: "Migration", resources: [{ resourceType: "github_repo", resourceRef: { url: "https://github.com/acme/migration.git" } }] });
    const issue = store.createIssue({ title: "Migration", projectId: project.id });
    const agent = store.createAgent({ name: "Ordinary", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "move" });
    const credential = await store.createTaskAccessToken(task, "local");
    expect((await post("move", { ref: one.id, path: "private/one.md" }, credential.token)).status).toBe(403);
  });
});
