import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiProjectDocRef } from "@multiremi/contracts/types.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

// updated_at has millisecond resolution, so docs created back to back can tie.
// Ordering assertions pin the timestamps by hand.
function setUpdatedAt(docId: string, updatedAt: string): void {
  db!.run("UPDATE multiremi_project_docs SET updated_at = ? WHERE id = ?", [updatedAt, docId]);
}

// The first doc of a project seeds the reserved `_schema` page alongside it, so
// assertions about user-authored docs filter it back out.
function withoutSchema<T extends { slug: string }>(docs: T[]): T[] {
  return docs.filter((doc) => doc.slug !== "_schema");
}

describe("Bun Multiremi project docs", () => {
  it("creates docs with kind defaults and slugifies the title", () => {
    const store = createStore();
    const project = store.createProject({ title: "Docs project" });

    const wiki = store.createProjectDoc(project.id, { kind: "wiki", title: "Build & Deploy Guide" });
    expect(wiki.kind).toBe("wiki");
    expect(wiki.slug).toBe("build-deploy-guide");
    expect(wiki.path).toBe("build-deploy-guide.md");
    expect(wiki.pinned).toBe(false);
    expect(wiki.version).toBe(1);
    expect(wiki.body).toBe("");
    expect(wiki.summary).toBeNull();
    expect(wiki.tags).toEqual([]);
    expect(wiki.id.startsWith("pdoc_")).toBe(true);
    expect(wiki.workspaceId).toBe(project.workspaceId);

    const memory = store.createProjectDoc(project.id, { kind: "memory", title: "Tests run with bun test" });
    expect(memory.kind).toBe("memory");
    expect(memory.pinned).toBe(true);

    // Pure CJK titles slugify to nothing — the doc id is the fallback ref.
    const cjk = store.createProjectDoc(project.id, { kind: "wiki", title: "中文标题" });
    expect(cjk.slug).toBe(cjk.id);

    const explicit = store.createProjectDoc(project.id, { kind: "wiki", title: "Another page", slug: "Custom Slug" });
    expect(explicit.slug).toBe("custom-slug");

    const nested = store.createProjectDoc(project.id, {
      kind: "wiki",
      title: "API catalog",
      path: "sdma-server/aiproxy/catalog",
    });
    expect(nested.slug).toBe("api-catalog");
    expect(nested.path).toBe("sdma-server/aiproxy/catalog.md");

    // An explicit pinned flag overrides the per-kind default.
    const unpinned = store.createProjectDoc(project.id, { kind: "memory", title: "Not pinned", pinned: false });
    expect(unpinned.pinned).toBe(false);
  });

  it("stores summary, body, tags, source and author fields (camel or snake)", () => {
    const store = createStore();
    const project = store.createProject({ title: "Fields" });
    const doc = store.createProjectDoc(project.id, {
      kind: "memory",
      title: "Postgres needs MULTIREMI_DATABASE_URL",
      summary: "  server env  ",
      body: "Otherwise the server falls back to an empty sqlite file.",
      tags: ["ops", " deploy ", ""],
      source_task_id: "tsk_1",
      sourceIssueId: "iss_1",
      author_type: "agent",
      authorId: "agt_1",
    });

    expect(doc.summary).toBe("server env");
    expect(doc.body).toBe("Otherwise the server falls back to an empty sqlite file.");
    expect(doc.tags).toEqual(["ops", "deploy"]);
    expect(doc.sourceTaskId).toBe("tsk_1");
    expect(doc.sourceIssueId).toBe("iss_1");
    expect(doc.authorType).toBe("agent");
    expect(doc.authorId).toBe("agt_1");
    expect(doc.updatedByType).toBe("agent");
    expect(doc.updatedById).toBe("agt_1");
  });

  it("rejects an unknown kind, an empty title and a missing project", () => {
    const store = createStore();
    const project = store.createProject({ title: "Validation" });

    expect(() => store.createProjectDoc(project.id, { kind: "note", title: "Nope" })).toThrow("unknown kind: note");
    expect(() => store.createProjectDoc(project.id, { kind: "wiki", title: "   " })).toThrow("title is required");
    expect(() => store.createProjectDoc("prj_missing", { kind: "wiki", title: "Nope" })).toThrow("Project not found: prj_missing");
    expect(() => store.listProjectDocs("prj_missing")).toThrow("Project not found: prj_missing");
  });

  it("rejects unsafe, over-deep, and duplicate paths", () => {
    const store = createStore();
    const project = store.createProject({ title: "Paths" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "First", path: "guides/first.md" });

    for (const path of [
      "/absolute.md",
      "guides\\windows.md",
      "guides/../escape.md",
      "guides//empty.md",
      "a/b/c/d/e/f/page.md",
    ]) {
      expect(() => store.createProjectDoc(project.id, { kind: "wiki", title: path, path }))
        .toThrow("invalid project wiki path");
    }
    expect(() => store.createProjectDoc(project.id, { kind: "wiki", title: "Duplicate", path: "guides/first.md" }))
      .toThrow(/UNIQUE|duplicate key/i);
  });

  it("rejects a duplicate slug in the same project but allows it across projects", () => {
    const store = createStore();
    const project = store.createProject({ title: "Slugs" });
    const other = store.createProject({ title: "Other" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Runbook" });

    expect(() => store.createProjectDoc(project.id, { kind: "wiki", title: "Runbook" })).toThrow(/UNIQUE|duplicate key/i);
    // The failed insert rolled back — no orphan revision, no second doc
    // (the two surviving revisions are the seeded _schema and the runbook).
    expect(withoutSchema(store.listProjectDocs(project.id))).toHaveLength(1);
    expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_project_doc_revisions").get() as { n: number }).toEqual({ n: 2 });

    const twin = store.createProjectDoc(other.id, { kind: "wiki", title: "Runbook" });
    expect(twin.slug).toBe("runbook");
  });

  it("resolves a doc by id or by slug, scoped to its project", () => {
    const store = createStore();
    const project = store.createProject({ title: "Refs" });
    const other = store.createProject({ title: "Other" });
    const doc = store.createProjectDoc(project.id, { kind: "wiki", title: "Architecture" });

    expect(store.getProjectDocByRef(project.id, doc.id)?.id).toBe(doc.id);
    expect(store.getProjectDocByRef(project.id, "architecture")?.id).toBe(doc.id);
    expect(store.getProjectDocByRef(project.id, "missing")).toBeNull();
    expect(store.getProjectDocByRef(other.id, doc.id)).toBeNull();
    expect(store.getProjectDoc(doc.id)?.title).toBe("Architecture");
    expect(store.getProjectDoc("pdoc_missing")).toBeNull();
  });

  it("bumps the version, records a revision and touches the project on update", () => {
    const store = createStore();
    const project = store.createProject({ title: "Updates" });
    const beforeProject = store.getProject(project.id)!;
    const doc = store.createProjectDoc(project.id, { kind: "wiki", title: "Deploy", body: "v1 body" });

    const updated = store.updateProjectDoc(project.id, "deploy", {
      title: "Deploy (2026)",
      summary: "how we ship",
      body: "v2 body",
      tags: ["ops"],
      pinned: true,
      updated_by_type: "member",
      updatedById: "usr_1",
    });

    expect(updated.version).toBe(2);
    expect(updated.title).toBe("Deploy (2026)");
    expect(updated.summary).toBe("how we ship");
    expect(updated.body).toBe("v2 body");
    expect(updated.tags).toEqual(["ops"]);
    expect(updated.pinned).toBe(true);
    expect(updated.slug).toBe("deploy");
    expect(updated.updatedByType).toBe("member");
    expect(updated.updatedById).toBe("usr_1");
    expect(updated.authorType).toBeNull();
    expect(Date.parse(store.getProject(project.id)!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(beforeProject.updatedAt));

    const revisions = store.listProjectDocRevisions(doc.id);
    expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);
    expect(revisions[0]!.title).toBe("Deploy (2026)");
    expect(revisions[0]!.body).toBe("v2 body");
    expect(revisions[0]!.authorType).toBe("member");
    expect(revisions[1]!.body).toBe("v1 body");
    expect(revisions[1]!.docId).toBe(doc.id);

    // Untouched fields survive a partial update.
    const partial = store.updateProjectDoc(project.id, doc.id, { body: "v3 body" });
    expect(partial.version).toBe(3);
    expect(partial.title).toBe("Deploy (2026)");
    expect(partial.tags).toEqual(["ops"]);
    expect(partial.pinned).toBe(true);

    const moved = store.updateProjectDoc(project.id, doc.id, { path: "operations/deploy.md" });
    expect(moved.id).toBe(doc.id);
    expect(moved.slug).toBe("deploy");
    expect(moved.path).toBe("operations/deploy.md");
    expect(moved.version).toBe(4);
    expect(store.listProjectDocRevisions(doc.id).map((revision) => revision.version)).toEqual([4, 3, 2, 1]);
  });

  it("rejects an update whose expectedVersion is stale", () => {
    const store = createStore();
    const project = store.createProject({ title: "Locking" });
    const doc = store.createProjectDoc(project.id, { kind: "wiki", title: "Contract" });

    expect(() => store.updateProjectDoc(project.id, doc.slug, { title: "Nope", expectedVersion: 7 }))
      .toThrow("project doc version conflict");
    expect(() => store.updateProjectDoc(project.id, doc.slug, { title: "Nope", expected_version: 7 }))
      .toThrow("project doc version conflict");

    // The conflict left the doc untouched.
    expect(store.getProjectDoc(doc.id)!.version).toBe(1);
    expect(store.getProjectDoc(doc.id)!.title).toBe("Contract");
    expect(store.listProjectDocRevisions(doc.id)).toHaveLength(1);

    const ok = store.updateProjectDoc(project.id, doc.slug, { title: "Contract v2", expectedVersion: 1 });
    expect(ok.version).toBe(2);
    expect(() => store.updateProjectDoc(project.id, "missing", { title: "x" })).toThrow("Project doc not found: missing");
  });

  it("deletes a doc together with its revisions", () => {
    const store = createStore();
    const project = store.createProject({ title: "Deletes" });
    const doc = store.createProjectDoc(project.id, { kind: "wiki", title: "Temporary" });
    store.updateProjectDoc(project.id, doc.slug, { body: "still here" });

    store.deleteProjectDoc(project.id, "temporary");

    expect(store.getProjectDoc(doc.id)).toBeNull();
    expect(withoutSchema(store.listProjectDocs(project.id))).toHaveLength(0);
    expect(store.listProjectDocRevisions(doc.id)).toHaveLength(0);
    expect(() => store.deleteProjectDoc(project.id, "temporary")).toThrow("Project doc not found: temporary");
  });

  it("lists docs pinned first then newest, and filters by kind", () => {
    const store = createStore();
    const project = store.createProject({ title: "Listing" });
    const pinned = store.createProjectDoc(project.id, { kind: "memory", title: "Pinned memory" });
    const oldWiki = store.createProjectDoc(project.id, { kind: "wiki", title: "Old wiki" });
    const newWiki = store.createProjectDoc(project.id, { kind: "wiki", title: "New wiki" });
    setUpdatedAt(pinned.id, "2026-01-01T00:00:00.000Z");
    setUpdatedAt(oldWiki.id, "2026-02-01T00:00:00.000Z");
    setUpdatedAt(newWiki.id, "2026-03-01T00:00:00.000Z");

    expect(withoutSchema(store.listProjectDocs(project.id)).map((doc) => doc.id)).toEqual([pinned.id, newWiki.id, oldWiki.id]);
    expect(withoutSchema(store.listProjectDocs(project.id, { kind: "wiki" })).map((doc) => doc.id)).toEqual([newWiki.id, oldWiki.id]);
    expect(store.listProjectDocs(project.id, { kind: "memory" }).map((doc) => doc.id)).toEqual([pinned.id]);
    expect(withoutSchema(store.listProjectDocs(project.id, { kind: null })).map((doc) => doc.id)).toHaveLength(3);
  });

  it("searches case-insensitively across title, summary, body and tags", () => {
    const store = createStore();
    const project = store.createProject({ title: "Search" });
    const other = store.createProject({ title: "Elsewhere" });
    const byTitle = store.createProjectDoc(project.id, { kind: "wiki", title: "Release Checklist" });
    const bySummary = store.createProjectDoc(project.id, { kind: "wiki", title: "Onboarding", summary: "How to RELEASE a build" });
    const byBody = store.createProjectDoc(project.id, { kind: "memory", title: "Ship rule", body: "Never release on Friday." });
    const byTag = store.createProjectDoc(project.id, { kind: "memory", title: "Tagged", tags: ["Release", "ops"] });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Unrelated page" });
    store.createProjectDoc(other.id, { kind: "wiki", title: "Release notes elsewhere" });

    const hits = store.searchProjectDocs(project.id, "RELEASE").map((doc) => doc.id).sort();
    expect(hits).toEqual([byTitle.id, bySummary.id, byBody.id, byTag.id].sort());

    expect(store.searchProjectDocs(project.id, "release", { kind: "memory" }).map((doc) => doc.id).sort())
      .toEqual([byBody.id, byTag.id].sort());
    expect(store.searchProjectDocs(project.id, "release", { limit: 1 })).toHaveLength(1);
    expect(store.searchProjectDocs(project.id, "nothing-matches")).toHaveLength(0);
    expect(store.searchProjectDocs(project.id, "   ")).toHaveLength(0);
    expect(() => store.searchProjectDocs("prj_missing", "release")).toThrow("Project not found: prj_missing");
  });

  it("treats LIKE metacharacters in the term as literal text", () => {
    const store = createStore();
    const project = store.createProject({ title: "Escaping" });
    const percent = store.createProjectDoc(project.id, { kind: "memory", title: "Cache hit 90% on warm runs" });
    const underscore = store.createProjectDoc(project.id, { kind: "memory", title: "Set MAX_WORKERS before the run" });
    const backslash = store.createProjectDoc(project.id, { kind: "memory", title: "Windows path C:\\Users\\ci" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Unrelated page" });

    // `%` and `_` match themselves, not "anything".
    expect(store.searchProjectDocs(project.id, "90%").map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.searchProjectDocs(project.id, "MAX_WORKERS").map((doc) => doc.id)).toEqual([underscore.id]);
    expect(store.searchProjectDocs(project.id, "MAXaWORKERS")).toHaveLength(0);
    // A backslash is data too — not the start of an escape sequence.
    expect(store.searchProjectDocs(project.id, "C:\\Users").map((doc) => doc.id)).toEqual([backslash.id]);
    expect(store.searchProjectDocs(project.id, "\\")).toHaveLength(1);

    // A wildcard term no longer sweeps the whole project: it matches only the
    // docs that literally contain that character.
    expect(store.searchProjectDocs(project.id, "%").map((doc) => doc.id)).toEqual([percent.id]);
    expect(store.searchProjectDocs(project.id, "_").map((doc) => doc.id)).toEqual([underscore.id]);
    expect(store.searchProjectDocs(project.id, "%unrelated%")).toEqual([]);
  });

  it("builds a docs index that trims bodies and summaries and caps each kind", () => {
    const store = createStore();
    const project = store.createProject({ title: "Index" });
    const longBody = "b".repeat(900);
    const longSummary = "s".repeat(400);
    const memory = store.createProjectDoc(project.id, { kind: "memory", title: "Long memory", body: longBody, summary: longSummary });
    const wiki = store.createProjectDoc(project.id, { kind: "wiki", title: "Long wiki", body: longBody, summary: longSummary });

    const index = store.getProjectDocsIndex(project.id);
    const memoryEntry = index.memory.find((entry) => entry.id === memory.id)!;
    expect(memoryEntry.body).toHaveLength(500);
    expect(memoryEntry.body!.endsWith("…")).toBe(true);
    expect(memoryEntry.summary).toHaveLength(160);
    expect(memoryEntry.kind).toBe("memory");
    expect(memoryEntry.pinned).toBe(true);
    expect(memoryEntry.slug).toBe("long-memory");

    const wikiEntry = index.wiki.find((entry) => entry.id === wiki.id)!;
    expect(wikiEntry.body).toBeNull();
    expect(wikiEntry.summary).toHaveLength(160);

    // Short values pass through untouched.
    const short = store.createProjectDoc(project.id, { kind: "memory", title: "Short", body: "tiny", summary: "brief" });
    const shortEntry = store.getProjectDocsIndex(project.id).memory.find((entry) => entry.id === short.id)!;
    expect(shortEntry.body).toBe("tiny");
    expect(shortEntry.summary).toBe("brief");

    for (let i = 0; i < 60; i++) store.createProjectDoc(project.id, { kind: "memory", title: `Memory ${i}` });
    for (let i = 0; i < 110; i++) store.createProjectDoc(project.id, { kind: "wiki", title: `Wiki ${i}` });
    const capped = store.getProjectDocsIndex(project.id);
    expect(capped.memory).toHaveLength(50);
    expect(capped.wiki).toHaveLength(100);
    expect(capped.wiki.every((entry) => entry.body === null)).toBe(true);
  });

  it("puts pinned memory entries first in the index", () => {
    const store = createStore();
    const project = store.createProject({ title: "Pinning" });
    const unpinned = store.createProjectDoc(project.id, { kind: "memory", title: "Unpinned", pinned: false });
    const pinned = store.createProjectDoc(project.id, { kind: "memory", title: "Pinned" });
    setUpdatedAt(unpinned.id, "2026-03-01T00:00:00.000Z");
    setUpdatedAt(pinned.id, "2026-01-01T00:00:00.000Z");

    expect(store.getProjectDocsIndex(project.id).memory.map((entry) => entry.id)).toEqual([pinned.id, unpinned.id]);
  });

  it("attaches the docs index to getTaskWithAgent, or null without a project", () => {
    const store = createStore();
    const project = store.createProject({ title: "Task context" });
    store.createProjectDoc(project.id, { kind: "memory", title: "Build with bun", body: "bun install first" });
    store.createProjectDoc(project.id, { kind: "wiki", title: "Architecture" });
    const agent = store.createAgent({ name: "docs-agent", provider: "codex" });

    const issue = store.createIssue({ title: "Do the thing", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    const withProject = store.getTaskWithAgent(task.id)!;
    expect(withProject.projectDocs!.memory.map((entry) => entry.title)).toEqual(["Build with bun"]);
    expect(withProject.projectDocs!.memory[0]!.body).toBe("bun install first");
    expect(withProject.projectDocs!.wiki.map((entry) => entry.title)).toEqual(["Architecture"]);

    const looseIssue = store.createIssue({ title: "No project" });
    const looseTask = store.createTask({ agentId: agent.id, issueId: looseIssue.id, prompt: "work" });
    expect(store.getTaskWithAgent(looseTask.id)!.projectDocs).toBeNull();
  });

  it("normalizes refs on create and replaces them wholesale on update", () => {
    const store = createStore();
    const project = store.createProject({ title: "Citations" });
    const doc = store.createProjectDoc(project.id, {
      kind: "memory",
      title: "Deploys need MULTIREMI_DATABASE_URL",
      refs: [
        { type: " issue ", value: " iss_1 " },
        { type: "task", value: "tsk_1" },
        // No value — worthless as a citation, dropped.
        { type: "url", value: "   " },
        // Unknown types are a convention, not a constraint: kept as written.
        { type: "changelog", value: "2026-07-01" },
      ],
    });

    expect(doc.refs).toEqual([
      { type: "issue", value: "iss_1" },
      { type: "task", value: "tsk_1" },
      { type: "changelog", value: "2026-07-01" },
    ]);
    expect(store.getProjectDoc(doc.id)!.refs).toEqual(doc.refs);

    const replaced = store.updateProjectDoc(project.id, doc.slug, {
      refs: [{ type: "url", value: "https://example.com/runbook" }],
    });
    expect(replaced.refs).toEqual([{ type: "url", value: "https://example.com/runbook" }]);

    // A partial update leaves them alone; an explicit empty list clears them.
    expect(store.updateProjectDoc(project.id, doc.slug, { body: "detail" }).refs)
      .toEqual([{ type: "url", value: "https://example.com/runbook" }]);
    expect(store.updateProjectDoc(project.id, doc.slug, { refs: [] }).refs).toEqual([]);

    const many = store.createProjectDoc(project.id, {
      kind: "wiki",
      title: "Many refs",
      refs: Array.from({ length: 25 }, (_, i) => ({ type: "issue", value: `iss_${i}` })),
    });
    expect(many.refs).toHaveLength(20);
    expect(many.refs[19]).toEqual({ type: "issue", value: "iss_19" });
  });

  it("tolerates junk refs from the input and from the column", () => {
    const store = createStore();
    const project = store.createProject({ title: "Junk" });
    const doc = store.createProjectDoc(project.id, {
      kind: "wiki",
      title: "Loose refs",
      refs: ["iss_1", null, 7, { value: "iss_2" }] as unknown as MultiremiProjectDocRef[],
    });
    expect(doc.refs).toEqual([{ type: "", value: "iss_2" }]);

    db!.run("UPDATE multiremi_project_docs SET refs = ? WHERE id = ?", ["not json at all", doc.id]);
    expect(store.getProjectDoc(doc.id)!.refs).toEqual([]);
    db!.run("UPDATE multiremi_project_docs SET refs = ? WHERE id = ?", ['{"type":"issue"}', doc.id]);
    expect(store.getProjectDoc(doc.id)!.refs).toEqual([]);
    db!.run("UPDATE multiremi_project_docs SET refs = ? WHERE id = ?", ["", doc.id]);
    expect(store.getProjectDoc(doc.id)!.refs).toEqual([]);
  });

  it("seeds the reserved _schema doc before the project's first doc", () => {
    const store = createStore();
    const project = store.createProject({ title: "Schema seeding" });
    expect(store.getProjectDocByRef(project.id, "_schema")).toBeNull();

    store.createProjectDoc(project.id, { kind: "memory", title: "First fact" });
    const schema = store.getProjectDocByRef(project.id, "_schema")!;
    expect(schema.kind).toBe("wiki");
    expect(schema.slug).toBe("_schema");
    expect(schema.title).toBe("Wiki Schema");
    expect(schema.pinned).toBe(false);
    expect(schema.authorType).toBeNull();
    expect(schema.version).toBe(1);
    expect(schema.body).toContain("# Wiki Schema");
    expect(schema.body).toContain("能 update 就不要 create");

    // A second doc reuses the seeded one instead of seeding again.
    store.createProjectDoc(project.id, { kind: "wiki", title: "Second page" });
    expect(store.listProjectDocs(project.id).filter((doc) => doc.slug === "_schema")).toHaveLength(1);
    expect(store.getProjectDoc(schema.id)!.version).toBe(1);

    // It is an ordinary doc otherwise: editable and revisioned.
    const edited = store.updateProjectDoc(project.id, "_schema", { body: "our own rules" });
    expect(edited.version).toBe(2);
    expect(store.listProjectDocRevisions(schema.id)).toHaveLength(2);
  });

  it("respects a user-created _schema instead of seeding over it", () => {
    const store = createStore();
    const project = store.createProject({ title: "Own schema" });
    const own = store.createProjectDoc(project.id, {
      kind: "wiki",
      title: "House rules",
      slug: "_schema",
      body: "keep it short",
    });

    expect(own.slug).toBe("_schema");
    // Seeding a project that already has the slug is a no-op, even when the
    // next doc triggers the check.
    store.createProjectDoc(project.id, { kind: "memory", title: "A fact" });
    const docs = store.listProjectDocs(project.id).filter((doc) => doc.slug === "_schema");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("House rules");
    expect(docs[0]!.body).toBe("keep it short");
    expect(store.ensureProjectDocSchema(project.id).id).toBe(own.id);
  });

  it("lists workspace docs across projects, newest first, with project titles", () => {
    const store = createStore();
    const alpha = store.createProject({ title: "Alpha" });
    const beta = store.createProject({ title: "Beta" });
    const elsewhere = store.createWorkspace({ name: "Elsewhere", slug: "elsewhere" });
    const foreign = store.createProject({ title: "Foreign", workspaceId: elsewhere.id });

    const alphaMemory = store.createProjectDoc(alpha.id, { kind: "memory", title: "Build with bun" });
    const alphaWiki = store.createProjectDoc(alpha.id, { kind: "wiki", title: "Alpha runbook" });
    const betaWiki = store.createProjectDoc(beta.id, { kind: "wiki", title: "Beta notes" });
    store.createProjectDoc(foreign.id, { kind: "wiki", title: "Foreign page" });
    setUpdatedAt(alphaMemory.id, "2026-01-01T00:00:00.000Z");
    setUpdatedAt(betaWiki.id, "2026-02-01T00:00:00.000Z");
    setUpdatedAt(alphaWiki.id, "2026-03-01T00:00:00.000Z");

    const docs = withoutSchema(store.listWorkspaceDocs("local"));
    // Recency order, not pinned-first: this is a browse view. The pinned
    // memory entry sits last because it is oldest.
    expect(docs.map((doc) => doc.id)).toEqual([alphaWiki.id, betaWiki.id, alphaMemory.id]);
    expect(docs.map((doc) => doc.projectTitle)).toEqual(["Alpha", "Beta", "Alpha"]);
    expect(docs.every((doc) => doc.workspaceId === "local")).toBe(true);

    expect(withoutSchema(store.listWorkspaceDocs(elsewhere.id)).map((doc) => doc.title)).toEqual(["Foreign page"]);
    expect(store.listWorkspaceDocs("ws_missing")).toEqual([]);
  });

  it("filters and searches workspace docs with the same literal LIKE semantics", () => {
    const store = createStore();
    const alpha = store.createProject({ title: "Alpha" });
    const beta = store.createProject({ title: "Beta" });
    const memory = store.createProjectDoc(alpha.id, { kind: "memory", title: "Cache hit 90% on warm runs" });
    const wiki = store.createProjectDoc(beta.id, { kind: "wiki", title: "Release notes", summary: "how we RELEASE" });
    store.createProjectDoc(beta.id, { kind: "wiki", title: "Unrelated" });

    expect(store.listWorkspaceDocs("local", { kind: "memory" }).map((doc) => doc.id)).toEqual([memory.id]);
    expect(() => store.listWorkspaceDocs("local", { kind: "notes" })).toThrow("unknown kind: notes");

    // Search spans projects, stays case-insensitive, treats metacharacters as text.
    expect(store.listWorkspaceDocs("local", { q: "release" }).map((doc) => doc.id)).toEqual([wiki.id]);
    expect(store.listWorkspaceDocs("local", { q: "90%" }).map((doc) => doc.id)).toEqual([memory.id]);
    expect(store.listWorkspaceDocs("local", { q: "90a" })).toHaveLength(0);
    expect(store.listWorkspaceDocs("local", { q: "   " }).length).toBeGreaterThan(1);

    expect(store.listWorkspaceDocs("local", { limit: 1 })).toHaveLength(1);
    // A junk limit falls back to the default instead of throwing or returning nothing.
    expect(store.listWorkspaceDocs("local", { limit: -3 }).length).toBeGreaterThan(1);
  });

  it("keeps _schema out of the index wiki list and exposes it as schema", () => {
    const store = createStore();
    const project = store.createProject({ title: "Index schema" });
    expect(store.getProjectDocsIndex(project.id).schema).toBeNull();

    const page = store.createProjectDoc(project.id, { kind: "wiki", title: "Architecture" });
    const index = store.getProjectDocsIndex(project.id);
    expect(index.wiki.map((entry) => entry.id)).toEqual([page.id]);
    expect(index.schema).toContain("# Wiki Schema");

    store.updateProjectDoc(project.id, "_schema", { body: "r".repeat(2000) });
    const trimmed = store.getProjectDocsIndex(project.id).schema!;
    expect(trimmed).toHaveLength(1500);
    expect(trimmed.endsWith("…")).toBe(true);

    // Even at the wiki cap, the reserved page never takes a slot.
    for (let i = 0; i < 110; i++) store.createProjectDoc(project.id, { kind: "wiki", title: `Wiki ${i}` });
    const capped = store.getProjectDocsIndex(project.id);
    expect(capped.wiki).toHaveLength(100);
    expect(capped.wiki.every((entry) => entry.slug !== "_schema")).toBe(true);
  });
});
