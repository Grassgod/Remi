import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareIssueWikiWorkspace } from "@daemon/agent-runtime/workspace/wiki.js";
import type { AgentTask } from "@daemon/contracts/types.js";

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
});

function task(
  body: string,
  version: number,
  overrides: { projectId?: string; docId?: string } = {},
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
