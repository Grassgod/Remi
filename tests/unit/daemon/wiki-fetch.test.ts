import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { fetchTaskWikiBodies } from "@daemon/agent-runtime/workspace/wiki-fetch.js";
import { prepareIssueWikiWorkspace, readWikiFetchCache } from "@daemon/agent-runtime/workspace/wiki.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
function task(version = 1, body = "project body"): AgentTask {
  return {
    id: "task", workspaceId: "local", prompt: "request", issueId: "issue", issueSessionId: "session",
    chatSessionId: null, autopilotRunId: null, completedAt: null, createdAt: "", agent: null,
    issue: { id: "issue", key: "MUL-498", title: "Wiki fetch", description: null, metadata: {} },
    project: { id: "project", title: "Project", description: null }, projectResources: [],
    projectWikiDocs: [{ id: "project_doc", projectId: "project", workspaceId: "local", kind: "wiki",
      slug: "guide", path: "guide.md", title: "Guide", summary: null, body: "", tags: [], pinned: false,
      version, content_sha256: sha(body), updatedAt: "" }],
    repositoryWikiContexts: [{ repository: { id: "repo", name: "app", url: "https://example.com/app", defaultBranch: "main" },
      docs: [{ id: "repo_doc", path: "concepts/guide.md", slug: "concepts/guide", title: "Guide",
        summary: null, body: "", tags: [], version, content_sha256: sha("repo body"), status: "healthy", updatedAt: "" }] }],
    projectContexts: [], repos: [], workDir: null, runtimeId: null, triggerCommentId: null, triggerSummary: null, sessionId: null,
  };
}
function root() { const path = mkdtempSync(join(tmpdir(), "mul498-wiki-fetch-")); roots.push(path); return path; }

test("fetches Wiki before a lazy workspace exists without creating that directory", async () => {
  const dir = join(root(), "discussions", "MUL-2", "session");
  const current = task(); const calls: string[] = [];
  expect(readWikiFetchCache(dir).size).toBe(0);
  await fetchTaskWikiBodies(dir, current, async path => {
    calls.push(path);
    return { doc: { id: path.endsWith("project_doc") ? "project_doc" : "repo_doc",
      body: path.endsWith("project_doc") ? "project body" : "repo body", version: 1 } };
  });
  expect(calls).toHaveLength(2);
  expect(current.projectWikiDocs![0]!.body).toBe("project body");
  expect(current.repositoryWikiContexts![0]!.docs[0]!.body).toBe("repo body");
  expect(existsSync(dir)).toBe(false);
});

test("a lazy workspace without Wiki needs neither a directory nor downloads", async () => {
  const dir = join(root(), "chats", "session");
  const current = task(); current.projectWikiDocs = []; current.repositoryWikiContexts = [];
  await fetchTaskWikiBodies(dir, current, async () => { throw new Error("unexpected download"); });
  expect(existsSync(dir)).toBe(false);
  expect(current.knowledgeWarnings).toEqual([]);
});

test("missing-cache handling still rejects symlink and regular-file workspace roots", () => {
  const dir = root(); const alias = join(dir, "alias"); const file = join(dir, "file");
  symlinkSync(dir, alias); writeFileSync(file, "file");
  expect(() => readWikiFetchCache(alias)).toThrow("unsafe");
  expect(() => readWikiFetchCache(file)).toThrow("unsafe");
});

test("fetches Wiki via existing endpoints, caches unchanged pages and refreshes only changed versions", async () => {
  const dir = root(); const calls: string[] = [];
  const read = async (path: string) => {
    calls.push(path);
    return { doc: { id: path.endsWith("project_doc") ? "project_doc" : "repo_doc",
      version: 1, body: path.endsWith("project_doc") ? "project body" : "repo body" } };
  };
  const first = task(); first.knowledgeWarnings = ["Wiki bodies omitted from task offer. Fetch them separately."];
  await fetchTaskWikiBodies(dir, first, read);
  expect(calls).toEqual(["/api/projects/project/docs/project_doc", "/api/workspaces/local/repos/repo/wiki/repo_doc"]);
  expect(first.knowledgeWarnings).toEqual([]);
  await prepareIssueWikiWorkspace(dir, first);
  expect(readFileSync(join(dir, "wiki", "guide.md"), "utf8")).toBe("project body\n");
  calls.length = 0;
  const metadataOnly = task();
  delete metadataOnly.projectWikiDocs![0]!.content_sha256;
  delete metadataOnly.repositoryWikiContexts![0]!.docs[0]!.content_sha256;
  await fetchTaskWikiBodies(dir, metadataOnly, read);
  expect(calls).toEqual([]);
  const changed = task(); changed.projectWikiDocs![0]!.version = 2;
  await fetchTaskWikiBodies(dir, changed, async path => { calls.push(path); return { doc: { id: "project_doc", version: 2, body: "changed" } }; });
  expect(calls).toEqual(["/api/projects/project/docs/project_doc"]);
  await prepareIssueWikiWorkspace(dir, changed);
  expect(readFileSync(join(dir, "wiki", "guide.md"), "utf8")).toBe("changed\n");
});

test("failed downloads preserve the last successful path, version, baseline and local edits", async () => {
  const dir = root(); const first = task();
  await fetchTaskWikiBodies(dir, first, async path => ({ doc: {
    id: path.endsWith("project_doc") ? "project_doc" : "repo_doc", body: path.endsWith("project_doc") ? "project body" : "repo body", version: 1,
  } }));
  await prepareIssueWikiWorkspace(dir, first);
  writeFileSync(join(dir, "wiki", "guide.md"), "local edit\n");
  const changed = task(2, "changed"); changed.projectWikiDocs![0]!.path = "renamed.md";
  changed.repositoryWikiContexts![0]!.docs[0]!.path = "renamed.md";
  await fetchTaskWikiBodies(dir, changed, async () => { throw new Error("offline"); });
  expect(changed.projectWikiDocs![0]).toMatchObject({ path: "guide.md", version: 1 });
  expect(changed.repositoryWikiContexts![0]!.docs[0]).toMatchObject({ path: "concepts/guide.md", version: 1 });
  expect(changed.knowledgeWarnings).toEqual([expect.stringContaining("2 页暂不可用")]);
  await prepareIssueWikiWorkspace(dir, changed);
  expect(readFileSync(join(dir, "wiki", "guide.md"), "utf8")).toBe("local edit\n");
  expect(readFileSync(join(dir, ".multiremi", "wiki-base", "files", "guide.md"), "utf8")).toBe("project body\n");
  expect(existsSync(join(dir, "wiki", "renamed.md"))).toBe(false);
  const noMetadata = task(); noMetadata.projectWikiDocs = [];
  noMetadata.knowledgeWarnings = ["Project Wiki loading failed or exceeded the startup budget."];
  await fetchTaskWikiBodies(dir, noMetadata, async () => { throw new Error("offline"); });
  expect(noMetadata.projectWikiDocs![0]).toMatchObject({ path: "guide.md", version: 1 });
});

test("accepts genuinely empty pages and never fabricates a body after a first-download failure", async () => {
  const dir = root(); const empty = task(1, "");
  await fetchTaskWikiBodies(dir, empty, async path => path.endsWith("project_doc")
    ? { doc: { id: "project_doc", body: "", version: 1 } } : { doc: { id: "repo_doc" } });
  expect(empty.projectWikiDocs![0]!.body).toBe("");
  expect(empty.repositoryWikiContexts![0]!.docs[0]!.status).toBe("unavailable");
  await prepareIssueWikiWorkspace(dir, empty);
  expect(readFileSync(join(dir, "wiki", "guide.md"), "utf8")).toBe("\n");
});
