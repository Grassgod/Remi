// MUL-389: the claim caps total Wiki body bytes without ever sending an empty Project Wiki doc.
//
// The rule the daemon's working copy depends on:
//   - Project Wiki: a doc that does not fit is dropped WHOLE. If it arrived with an empty body,
//     the daemon would write that empty body into the local copy and the baseline, and the next
//     `remi wiki push` would merge from it. Dropping affects only the local working copy: an
//     unmodified file is removed there, an edited one is kept.
//   - Repository Wiki: the doc keeps its metadata, is marked `status: "unavailable"`, and has an
//     empty body. The daemon's `repositoryWikiDocUnavailable` check then keeps the prior copy.
//   - Under the cap, nothing changes at all.
import { afterEach, describe, expect, it } from "bun:test";
import { applyClaimKnowledgeByteCap, CLAIM_KNOWLEDGE_BYTE_CAP, hydrateClaimKnowledge } from "@multiremi/project-knowledge/claim-hydration.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const KIB = 1024;

function projectDoc(id: string, bytes: number, slug = id) {
  return {
    id, slug, path: `${slug}.md`, title: slug, summary: null, tags: [], pinned: false, refs: [],
    kind: "wiki" as const, projectId: "prj_cap", workspaceId: "local",
    body: "p".repeat(bytes), version: 1, updatedAt: "2026-09-26T00:00:00.000Z",
    storageBackend: "sql" as const, contentUri: null, contentSha256: null,
    syncStatus: "sql" as const, syncError: null, snapshotOid: null,
  };
}

function repositoryDoc(id: string, bytes: number, path = `${id}.md`) {
  return {
    id, repositoryId: "repo_cap", workspaceId: "local", path, slug: path.replace(/\.md$/, ""),
    title: id, summary: null, body: "r".repeat(bytes), tags: [], refs: [],
    status: "healthy" as const, version: 1, updatedAt: "2026-09-26T00:00:00.000Z",
  };
}

function taskWith(projectWikiDocs: unknown[], repositoryDocs: unknown[] = []) {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Cap agent", provider: "codex", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, prompt: "cap" });
  return {
    ...store.getTaskWithAgent(task.id)!,
    projectWikiDocs: projectWikiDocs as never,
    repositoryWikiContexts: repositoryDocs.length ? [{
      repository: { id: "repo_cap", name: "cap", url: "https://github.com/example/cap", defaultBranch: "main" },
      docs: repositoryDocs as never,
    }] : [],
  };
}

describe("claim knowledge byte cap", () => {
  it("keeps everything when the total body bytes are inside the cap", () => {
    const task = taskWith([projectDoc("a", 100 * KIB), projectDoc("b", 100 * KIB)], [repositoryDoc("r1", 100 * KIB)]);
    const { task: capped, warnings } = applyClaimKnowledgeByteCap(task);
    expect(warnings).toEqual([]);
    expect(capped.projectWikiDocs).toHaveLength(2);
    expect(capped.projectWikiDocs![0]!.body).toHaveLength(100 * KIB);
    expect(capped.repositoryWikiContexts![0]!.docs[0]!.body).toHaveLength(100 * KIB);
    expect(capped.repositoryWikiContexts![0]!.docs[0]!.status).toBe("healthy");
  });

  it("drops an over-cap Project Wiki doc whole, keeps the ones that fit, and warns", () => {
    // The cap is 512 KiB; the first doc fits, the second is larger than the remaining budget.
    const task = taskWith([projectDoc("small", 200 * KIB), projectDoc("huge", 400 * KIB), projectDoc("late", 100 * KIB)]);
    const { task: capped, warnings } = applyClaimKnowledgeByteCap(task);

    // `huge` does not fit and is dropped entirely — not truncated, and not sent empty.
    expect(capped.projectWikiDocs!.map((doc) => doc.id)).toEqual(["small", "late"]);
    for (const doc of capped.projectWikiDocs!) expect(doc.body.length).toBeGreaterThan(0);
    expect(capped.projectWikiDocs!.find((doc) => doc.id === "huge")).toBeUndefined();
    // The doc AFTER the dropped one is still considered: dropping is not a stop.
    expect(capped.projectWikiDocs!.find((doc) => doc.id === "late")!.body).toHaveLength(100 * KIB);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("huge.md");
    expect(warnings[0]).toContain("remi wiki");
  });

  it("never sends a dropped Project Wiki doc with an empty body", () => {
    const task = taskWith([projectDoc("huge", 600 * KIB), projectDoc("tiny", 1 * KIB)]);
    const { task: capped } = applyClaimKnowledgeByteCap(task);
    for (const doc of capped.projectWikiDocs!) {
      expect(doc.body).not.toBe("");
    }
    expect(capped.projectWikiDocs!.map((doc) => doc.id)).toEqual(["tiny"]);
  });

  it("removes a dropped Project Wiki doc from Intake project contexts too", () => {
    const task = taskWith([projectDoc("huge", 600 * KIB), projectDoc("tiny", 1 * KIB)]);
    const withContext = {
      ...task,
      projectContexts: [{
        project: { id: "prj_cap", title: "Cap", workspaceId: "local" },
        docs: [projectDoc("huge", 600 * KIB), projectDoc("tiny", 1 * KIB)],
        repos: [],
      }],
    } as unknown as typeof task;
    const { task: capped } = applyClaimKnowledgeByteCap(withContext);
    const contextDocs = (capped.projectContexts[0] as unknown as { docs: Array<{ id: string }> }).docs;
    expect(contextDocs.map((doc) => doc.id)).toEqual(["tiny"]);
  });

  it("marks an over-cap Repository Wiki doc unavailable with metadata intact and no body", () => {
    const task = taskWith([], [repositoryDoc("small", 100 * KIB, "small.md"), repositoryDoc("huge", 900 * KIB, "huge.md")]);
    const { task: capped, warnings } = applyClaimKnowledgeByteCap(task);
    const docs = capped.repositoryWikiContexts![0]!.docs;
    const small = docs.find((doc) => doc.id === "small")!;
    const huge = docs.find((doc) => doc.id === "huge")!;

    expect(small.status).toBe("healthy");
    expect(small.body).toHaveLength(100 * KIB);
    // Metadata survives, body does not, and the status is the marker the daemon checks.
    expect(huge).toMatchObject({ id: "huge", path: "huge.md", title: "huge" });
    expect(huge.body).toBe("");
    expect(String(huge.status)).toBe("unavailable");
    expect(warnings[0]).toContain("huge.md");
  });

  it("treats the cap as shared across both stores", () => {
    const task = taskWith([projectDoc("project", 400 * KIB)], [repositoryDoc("repo", 400 * KIB, "repo.md")]);
    const { task: capped } = applyClaimKnowledgeByteCap(task);
    // The Project Wiki doc is decided first and consumes most of the budget, so the Repository
    // Wiki doc cannot also fit; whichever way the order falls, the total stays bounded.
    const total = capped.projectWikiDocs!.reduce((sum, doc) => sum + doc.body.length, 0)
      + capped.repositoryWikiContexts!.reduce((sum, context) => sum + context.docs.reduce((inner, doc) => inner + doc.body.length, 0), 0);
    expect(total).toBeLessThanOrEqual(CLAIM_KNOWLEDGE_BYTE_CAP);
  });

  it("applies the cap through hydrateClaimKnowledge and appends the warning", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Cap agent", provider: "codex", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "cap" });
    const base = store.getTaskWithAgent(task.id)!;
    const project = new ProjectKnowledgeService(store, null, "sql");
    const repository = new RepositoryWikiService(store, null, "sql");
    project.hydrateTaskKnowledge = async (current) => ({
      ...current,
      projectWikiDocs: [projectDoc("small", 100 * KIB), projectDoc("huge", 600 * KIB)] as never,
    });
    repository.hydrateTaskWiki = async (current) => ({
      ...current,
      repositoryWikiContexts: [{
        repository: { id: "repo_cap", name: "cap", url: "https://github.com/example/cap", defaultBranch: "main" },
        docs: [repositoryDoc("hugeRepo", 900 * KIB, "huge-repo.md")] as never,
      }],
    });

    const hydrated = await hydrateClaimKnowledge(base, project, repository);
    expect(hydrated.projectWikiDocs!.map((doc) => doc.id)).toEqual(["small"]);
    expect(String(hydrated.repositoryWikiContexts![0]!.docs[0]!.status)).toBe("unavailable");
    expect(hydrated.repositoryWikiContexts![0]!.docs[0]!.body).toBe("");
    expect(hydrated.knowledgeWarnings).toHaveLength(1);
    expect(hydrated.knowledgeWarnings![0]).toContain("huge.md");
    expect(hydrated.knowledgeWarnings![0]).toContain("huge-repo.md");
  });

  it("honours a caller-supplied cap so tests and operators can lower it", async () => {
    const task = taskWith([projectDoc("a", 2 * KIB), projectDoc("b", 2 * KIB)]);
    const { task: capped, warnings } = applyClaimKnowledgeByteCap(task, 3 * KIB);
    expect(capped.projectWikiDocs!.map((doc) => doc.id)).toEqual(["a"]);
    expect(warnings[0]).toContain("b.md");
  });
});
