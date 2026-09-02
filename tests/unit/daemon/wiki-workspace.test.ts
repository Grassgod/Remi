import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareIssueWikiWorkspace } from "@daemon/agent-runtime/workspace/wiki.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Issue Wiki workspace", () => {
  test("materializes Wiki bodies and fast-forwards only clean files", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-"));
    roots.push(root);
    await prepareIssueWikiWorkspace(root, task("remote v1", 1));
    expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toBe("remote v1\n");
    expect(JSON.parse(readFileSync(join(root, ".multiremi", "wiki-base", "manifest.json"), "utf8"))).toMatchObject({
      projectId: "prj_1",
      docs: [{ slug: "guide", version: 1 }],
    });

    await prepareIssueWikiWorkspace(root, task("remote v2", 2));
    expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toBe("remote v2\n");

    writeFileSync(join(root, "wiki", "guide.md"), "local edit\n");
    await prepareIssueWikiWorkspace(root, task("remote v3", 3));
    expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toBe("local edit\n");
    expect(readFileSync(join(root, ".multiremi", "wiki-base", "files", "guide.md"), "utf8")).toBe("remote v2\n");
  });

  test("materializes nested Project Wiki paths and rejects unsafe paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-nested-"));
    roots.push(root);
    await prepareIssueWikiWorkspace(root, task("nested", 1, { path: "architecture/components/guide.md" }));
    expect(readFileSync(join(root, "wiki", "architecture", "components", "guide.md"), "utf8")).toBe("nested\n");
    expect(JSON.parse(readFileSync(join(root, ".multiremi", "wiki-base", "manifest.json"), "utf8")).docs[0])
      .toMatchObject({ id: "pdoc_1", slug: "guide", path: "architecture/components/guide.md" });

    const unsafeRoot = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-unsafe-path-"));
    roots.push(unsafeRoot);
    await expect(prepareIssueWikiWorkspace(unsafeRoot, task("unsafe", 1, { path: "../escape.md" })))
      .rejects.toThrow("Project Wiki path is invalid");
  });

  test("fails closed when an Issue changes projects", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-project-"));
    roots.push(root);
    await prepareIssueWikiWorkspace(root, task("project one", 1));

    await expect(prepareIssueWikiWorkspace(root, task("project two", 1, { projectId: "prj_2" })))
      .rejects.toThrow("belongs to prj_1, not prj_2");
    expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toBe("project one\n");
  });

  test("rejects a tampered baseline and symbolic-link Wiki directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-integrity-"));
    roots.push(root);
    await prepareIssueWikiWorkspace(root, task("remote v1", 1));
    const base = join(root, ".multiremi", "wiki-base", "files", "guide.md");
    chmodSync(base, 0o644);
    writeFileSync(base, "forged base\n");
    await expect(prepareIssueWikiWorkspace(root, task("remote v2", 2)))
      .rejects.toThrow("baseline checksum mismatch");

    const symlinkRoot = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-outside-"));
    roots.push(symlinkRoot, outside);
    mkdirSync(join(symlinkRoot, ".multiremi"));
    symlinkSync(outside, join(symlinkRoot, "wiki"), "dir");
    await expect(prepareIssueWikiWorkspace(symlinkRoot, task("remote", 1)))
      .rejects.toThrow("Wiki directory is unsafe");
  });

  test("keeps local edits when a remote page is recreated with the same slug", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-issue-wiki-recreated-"));
    roots.push(root);
    await prepareIssueWikiWorkspace(root, task("remote v1", 1));
    writeFileSync(join(root, "wiki", "guide.md"), "local edit\n");
    await prepareIssueWikiWorkspace(root, task("remote replacement", 1, { docId: "pdoc_2" }));

    expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toBe("local edit\n");
    expect(readFileSync(join(root, ".multiremi", "wiki-base", "files", "guide.md"), "utf8")).toBe("remote v1\n");
    expect(JSON.parse(readFileSync(join(root, ".multiremi", "wiki-base", "manifest.json"), "utf8")).docs)
      .toHaveLength(1);
  });

  test("materializes repository Wiki pages and records empty repositories for first-page creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-repository-wiki-"));
    roots.push(root);
    const value = task("project", 1);
    value.repositoryWikiContexts = [
      {
        repository: {
          id: "repo_alpha",
          name: "alpha",
          url: "git@github.com:org/alpha.git",
          defaultBranch: "main",
        },
        docs: [{
          id: "rwdoc_1",
          workspaceId: "local",
          repositoryId: "repo_alpha",
          path: "architecture/overview.md",
          slug: "architecture/overview",
          title: "Architecture",
          summary: null,
          body: "repository facts",
          tags: [],
          refs: [],
          sourceRevision: "abc123",
          status: "healthy",
          version: 1,
          updatedAt: "2026-08-18T00:00:00.000Z",
        }],
      },
      {
        repository: {
          id: "repo_empty",
          name: "empty",
          url: "git@github.com:org/empty.git",
          defaultBranch: "main",
        },
        docs: [],
      },
    ];

    await prepareIssueWikiWorkspace(root, value);
    expect(readFileSync(join(root, "wiki", "repositories", "alpha-po_alpha", "architecture", "overview.md"), "utf8"))
      .toBe("repository facts\n");
    const manifest = JSON.parse(readFileSync(join(root, ".multiremi", "wiki-base", "repositories", "manifest.json"), "utf8"));
    expect(manifest.repositories).toEqual([
      { id: "repo_alpha", name: "alpha", directory: "alpha-po_alpha" },
      { id: "repo_empty", name: "empty", directory: "empty-po_empty" },
    ]);
    expect(manifest.docs).toMatchObject([{ id: "rwdoc_1", repositoryId: "repo_alpha", path: "alpha-po_alpha/architecture/overview.md" }]);
  });

  test("does not materialize unavailable repository Wiki bodies and reports them in the prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-unavailable-repository-wiki-"));
    roots.push(root);
    const value = task("project", 1);
    const repository = {
      id: "repo_alpha",
      name: "alpha",
      url: "git@github.com:org/alpha.git",
      defaultBranch: "main",
    };
    const prior = {
      id: "rwdoc_prior",
      workspaceId: "local",
      repositoryId: repository.id,
      path: "architecture/overview.md",
      slug: "architecture/overview",
      title: "Architecture",
      summary: null,
      body: "last known good facts",
      tags: [],
      refs: [],
      sourceRevision: "abc123",
      status: "healthy",
      syncStatus: "ready",
      version: 1,
      updatedAt: "2026-08-18T00:00:00.000Z",
    };
    value.repositoryWikiContexts = [{ repository, docs: [prior] }];
    await prepareIssueWikiWorkspace(root, value);

    value.repositoryWikiContexts = [{
      repository,
      docs: [{
        ...prior,
        body: "",
        status: "failed",
        statusMessage: "Repository wiki body unavailable: checksum mismatch",
        syncStatus: "failed",
        syncError: "Repository wiki body unavailable: checksum mismatch",
        version: 2,
      }, {
        ...prior,
        id: "rwdoc_missing",
        path: "operations/missing.md",
        slug: "operations/missing",
        title: "Missing runbook",
        body: "",
        status: "unavailable",
        statusMessage: "Repository wiki body unavailable: object not found",
        syncStatus: "failed",
        syncError: "Repository wiki body unavailable: object not found",
      }],
    }];
    await prepareIssueWikiWorkspace(root, value);

    const repositoryRoot = join(root, "wiki", "repositories", "alpha-po_alpha");
    expect(readFileSync(join(repositoryRoot, "architecture", "overview.md"), "utf8"))
      .toBe("last known good facts\n");
    expect(existsSync(join(repositoryRoot, "operations", "missing.md"))).toBeFalse();
    const manifest = JSON.parse(readFileSync(
      join(root, ".multiremi", "wiki-base", "repositories", "manifest.json"),
      "utf8",
    ));
    expect(manifest.docs).toMatchObject([{ id: "rwdoc_prior", version: 1 }]);
    expect(manifest.docs.some((doc: { id: string }) => doc.id === "rwdoc_missing")).toBeFalse();

    const prompt = buildTaskPrompt(value);
    expect(prompt).toContain("## Repository Wiki Availability Warnings");
    expect(prompt).toContain("were not materialized as empty files");
    expect(prompt).toContain("architecture/overview.md");
    expect(prompt).toContain("checksum mismatch");
    expect(prompt).toContain("operations/missing.md");
    expect(prompt).toContain("object not found");
    expect(prompt).toContain("report the page as blocked");
  });

  test("materializes repository Wiki for an SCM task without an Issue or Project", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-repository-only-wiki-"));
    roots.push(root);
    const value = task("unused", 1);
    value.issueId = null;
    value.issueSessionId = null;
    value.issue = null;
    value.project = null;
    value.projectWikiDocs = [];
    value.repositoryWikiContexts = [{
      repository: {
        id: "repo_atlas",
        name: "atlas",
        url: "git@github.com:org/atlas.git",
        defaultBranch: "main",
      },
      docs: [],
    }];

    expect(await prepareIssueWikiWorkspace(root, value)).toBeNull();
    const manifest = JSON.parse(readFileSync(
      join(root, ".multiremi", "wiki-base", "repositories", "manifest.json"),
      "utf8",
    ));
    expect(manifest).toMatchObject({
      workspaceId: "local",
      repositories: [{ id: "repo_atlas", name: "atlas", directory: "atlas-po_atlas" }],
      docs: [],
    });
  });
});

function task(
  body: string,
  version: number,
  overrides: { projectId?: string; docId?: string; path?: string } = {},
): AgentTask {
  const projectId = overrides.projectId ?? "prj_1";
  return {
    id: "tsk_1",
    workspaceId: "local",
    prompt: "maintain wiki",
    issueId: "iss_1",
    issueSessionId: "ises_1",
    chatSessionId: null,
    autopilotRunId: null,
    completedAt: null,
    createdAt: "",
    agent: null,
    issue: { id: "iss_1", key: "MUL-1", title: "Issue", description: null, metadata: {} },
    project: { id: projectId, title: "Project", description: null },
    projectResources: [],
    projectWikiDocs: [{
      id: overrides.docId ?? "pdoc_1",
      projectId,
      workspaceId: "local",
      kind: "wiki",
      slug: "guide",
      path: overrides.path,
      title: "Guide",
      summary: null,
      body,
      tags: [],
      pinned: false,
      refs: [],
      version,
      updatedAt: `2026-08-18T00:00:0${version}.000Z`,
    }],
    projectContexts: [],
    repos: [],
    workDir: null,
    runtimeId: null,
    triggerCommentId: null,
    triggerSummary: null,
    sessionId: null,
  };
}
