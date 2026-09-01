import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

interface DocState {
  id: string;
  slug: string;
  path?: string;
  title: string;
  body: string;
  version: number;
}

interface WikiServerHooks {
  afterUpdate?: (slug: string) => void;
  failUpdate?: (slug: string) => boolean;
  repositoryDocs?: Map<string, RepositoryDocState>;
  rawSubmissions?: boolean;
}

interface RepositoryDocState {
  id: string;
  path: string;
  title: string;
  body: string;
  version: number;
}

const tempDirs: string[] = [];
let previousWorkspaceRoot: string | undefined;
let previousProjectId: string | undefined;
let previousTaskId: string | undefined;

beforeEach(() => {
  previousProjectId = process.env.MULTIREMI_PROJECT_ID;
  previousTaskId = process.env.MULTIREMI_TASK_ID;
  delete process.env.MULTIREMI_PROJECT_ID;
  delete process.env.MULTIREMI_TASK_ID;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.MULTIREMI_WORKSPACE_ROOT;
  else process.env.MULTIREMI_WORKSPACE_ROOT = previousWorkspaceRoot;
  previousWorkspaceRoot = undefined;
  if (previousProjectId === undefined) delete process.env.MULTIREMI_PROJECT_ID;
  else process.env.MULTIREMI_PROJECT_ID = previousProjectId;
  if (previousTaskId === undefined) delete process.env.MULTIREMI_TASK_ID;
  else process.env.MULTIREMI_TASK_ID = previousTaskId;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Wiki working copy", () => {
  test("pulls a local Wiki and three-way merges non-overlapping changes on push", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_guide",
      slug: "guide",
      title: "Guide",
      body: "# Guide\n\nowner: platform\n\n## Notes\n\nKeep this section stable.\n\n## Region\n\nregion: cn",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl, requests) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toContain("owner: platform");
      expect(JSON.parse(readFileSync(join(root, ".multiremi", "wiki-base", "manifest.json"), "utf8"))).toMatchObject({
        version: 1,
        projectId: "prj_1",
        docs: [{ slug: "guide", version: 1 }],
      });

      writeFileSync(join(root, "wiki", "guide.md"), "# Guide\n\nowner: runtime\n\n## Notes\n\nKeep this section stable.\n\n## Region\n\nregion: cn\n");
      docs.set("guide", { ...docs.get("guide")!, body: "# Guide\n\nowner: platform\n\n## Notes\n\nKeep this section stable.\n\n## Region\n\nregion: sg", version: 2 });
      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });

      expect(docs.get("guide")).toMatchObject({
        body: "# Guide\n\nowner: runtime\n\n## Notes\n\nKeep this section stable.\n\n## Region\n\nregion: sg",
        version: 3,
      });
      const update = requests.find((request) => request.method === "PUT");
      expect(update?.body).toMatchObject({ expected_version: 2 });
      expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toContain("region: sg");
    });
  });

  test("blocks push and writes a conflict artifact when both sides edit the same lines", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_guide",
      slug: "guide",
      title: "Guide",
      body: "# Guide\n\nowner: platform",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl, requests) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      writeFileSync(join(root, "wiki", "guide.md"), "# Guide\n\nowner: runtime\n");
      docs.set("guide", { ...docs.get("guide")!, body: "# Guide\n\nowner: docs", version: 2 });

      await expect(runMultiremi(["wiki", "push", ...base], { programName: "multiremi" }))
        .rejects.toThrow("local and remote versions conflict");
      expect(readFileSync(join(root, ".multiremi", "wiki-conflicts", "guide.md"), "utf8")).toContain("<<<<<<< local");
      expect(requests.some((request) => request.method === "PUT")).toBe(false);
      expect(docs.get("guide")?.version).toBe(2);
    });
  });

  test("creates and deletes pages from filesystem changes", async () => {
    const docs = new Map<string, DocState>([["old-page", {
      id: "pdoc_old",
      slug: "old-page",
      title: "Old page",
      body: "obsolete",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      rmSync(join(root, "wiki", "old-page.md"));
      writeFileSync(join(root, "wiki", "new-page.md"), "# New page\n\nCurrent guidance.\n");
      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });
      expect(docs.has("old-page")).toBe(false);
      expect(docs.get("new-page")).toMatchObject({ title: "New page", body: "# New page\n\nCurrent guidance." });
    });
  });

  test("keeps local changes unsynced when push creates Raw submissions", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_guide",
      slug: "guide",
      title: "Guide",
      body: "formal body",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl, requests, logs) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "task-token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      const manifestPath = join(root, ".multiremi", "wiki-base", "manifest.json");
      const manifestBefore = readFileSync(manifestPath, "utf8");
      writeFileSync(join(root, "wiki", "guide.md"), "local proposal\n");

      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });

      expect(docs.get("guide")).toMatchObject({ body: "formal body", version: 1 });
      expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toBe("local proposal\n");
      expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
      expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        pushed: true,
        submitted: true,
        submission_ids: ["ksub_test_1"],
        status: "pending",
        message: "等待 Atlas 加工",
      });
    }, { rawSubmissions: true });
  });

  test("moves a Project Wiki page without changing its id or slug", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_guide",
      slug: "guide",
      path: "guide.md",
      title: "Guide",
      body: "# Guide\n\nOriginal",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl, requests) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      await runMultiremi(["wiki", "mv", "guide", "architecture/guide.md", ...base], { programName: "multiremi" });
      writeFileSync(join(root, "wiki", "architecture", "guide.md"), "# Guide\n\nMoved and edited\n");
      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });

      expect(docs.get("guide")).toMatchObject({
        id: "pdoc_guide",
        slug: "guide",
        path: "architecture/guide.md",
        body: "# Guide\n\nMoved and edited",
        version: 2,
      });
      expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
      expect(requests.some((request) => request.method === "POST" || request.method === "DELETE")).toBe(false);
      expect(existsSync(join(root, "wiki", "guide.md"))).toBe(false);
      expect(readFileSync(join(root, ".multiremi", "wiki-base", "files", "architecture", "guide.md"), "utf8"))
        .toContain("Moved and edited");
      const manifest = JSON.parse(readFileSync(join(root, ".multiremi", "wiki-base", "manifest.json"), "utf8"));
      expect(manifest.docs[0]).toMatchObject({ id: "pdoc_guide", slug: "guide", path: "architecture/guide.md", version: 2 });
      expect(manifest.docs[0].movedTo).toBeUndefined();
    });
  });

  test("recognizes a same-content filesystem rename as a move", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_guide",
      slug: "guide",
      path: "guide.md",
      title: "Guide",
      body: "same content",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl, requests) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      mkdirSync(join(root, "wiki", "guides"));
      renameSync(join(root, "wiki", "guide.md"), join(root, "wiki", "guides", "guide.md"));
      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });

      expect(docs.get("guide")).toMatchObject({ id: "pdoc_guide", slug: "guide", path: "guides/guide.md", version: 2 });
      expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
      expect(requests.some((request) => request.method === "POST" || request.method === "DELETE")).toBe(false);
    });
  });

  test("recursively creates nested pages with basename-derived unique slugs", async () => {
    const docs = new Map<string, DocState>();
    await withWikiServer(docs, async (serverUrl) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      mkdirSync(join(root, "wiki", "architecture"), { recursive: true });
      mkdirSync(join(root, "wiki", "operations"), { recursive: true });
      writeFileSync(join(root, "wiki", "architecture", "overview.md"), "# Architecture overview\n");
      writeFileSync(join(root, "wiki", "operations", "overview.md"), "# Operations overview\n");
      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });

      expect(docs.get("overview")).toMatchObject({ path: "architecture/overview.md" });
      expect(docs.get("overview-2")).toMatchObject({ path: "operations/overview.md" });
    });
  });

  test("does not overwrite a local edit made while push is in flight", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_guide",
      slug: "guide",
      title: "Guide",
      body: "# Guide\n\nowner: platform\n\n## Notes\n\nbase",
      version: 1,
    }]]);
    let root = "";
    let editInjected = false;
    await withWikiServer(docs, async (serverUrl) => {
      root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      writeFileSync(join(root, "wiki", "guide.md"), "# Guide\n\nowner: runtime\n\n## Notes\n\nbase\n");
      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });

      expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toContain("concurrent edit");
      expect(readFileSync(join(root, ".multiremi", "wiki-base", "files", "guide.md"), "utf8"))
        .toContain("owner: platform");

      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });
      expect(docs.get("guide")?.body).toContain("owner: runtime");
      expect(docs.get("guide")?.body).toContain("concurrent edit");
    }, {
      afterUpdate: () => {
        if (editInjected) return;
        editInjected = true;
        writeFileSync(
          join(root, "wiki", "guide.md"),
          "# Guide\n\nowner: runtime\n\n## Notes\n\nbase\n\nconcurrent edit\n",
        );
      },
    });
  });

  test("handles a page recreated under the same slug without losing local edits", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_old",
      slug: "guide",
      title: "Guide",
      body: "# Guide\n\nowner: platform\n\nregion: cn",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      writeFileSync(join(root, "wiki", "guide.md"), "# Guide\n\nowner: runtime\n\nregion: cn\n");
      docs.set("guide", {
        ...docs.get("guide")!,
        id: "pdoc_new",
        body: "# Guide\n\nowner: platform\n\nregion: sg",
        version: 1,
      });

      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      expect(readFileSync(join(root, "wiki", "guide.md"), "utf8")).toContain("owner: runtime");
      expect(readFileSync(join(root, ".multiremi", "wiki-base", "files", "guide.md"), "utf8")).toContain("region: cn");
      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });
      expect(docs.get("guide")).toMatchObject({ id: "pdoc_new", version: 2 });
      expect(docs.get("guide")?.body).toContain("owner: runtime");
      expect(docs.get("guide")?.body).toContain("region: sg");
    });
  });

  test("retries safely after an earlier delete in a partial push already succeeded", async () => {
    const docs = new Map<string, DocState>([
      ["a-delete", { id: "pdoc_delete", slug: "a-delete", title: "Delete", body: "old", version: 1 }],
      ["z-update", { id: "pdoc_update", slug: "z-update", title: "Update", body: "before", version: 1 }],
    ]);
    let failOnce = true;
    await withWikiServer(docs, async (serverUrl) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      rmSync(join(root, "wiki", "a-delete.md"));
      writeFileSync(join(root, "wiki", "z-update.md"), "after\n");

      await expect(runMultiremi(["wiki", "push", ...base], { programName: "multiremi" }))
        .rejects.toThrow("version conflict");
      expect(docs.has("a-delete")).toBe(false);

      await runMultiremi(["wiki", "push", ...base], { programName: "multiremi" });
      expect(docs.has("a-delete")).toBe(false);
      expect(docs.get("z-update")?.body).toBe("after");
    }, {
      failUpdate: (slug) => {
        if (slug !== "z-update" || !failOnce) return false;
        failOnce = false;
        return true;
      },
    });
  });

  test("rejects baseline tampering and Wiki directory symlinks", async () => {
    const docs = new Map<string, DocState>([["guide", {
      id: "pdoc_guide", slug: "guide", title: "Guide", body: "safe", version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      const baseline = join(root, ".multiremi", "wiki-base", "files", "guide.md");
      chmodSync(baseline, 0o644);
      writeFileSync(baseline, "forged\n");
      await expect(runMultiremi(["wiki", "status", ...base], { programName: "multiremi" }))
        .rejects.toThrow("baseline checksum mismatch");

      rmSync(join(root, "wiki"), { recursive: true });
      const outside = mkdtempSync(join(tmpdir(), "multiremi-wiki-outside-"));
      tempDirs.push(outside);
      symlinkSync(outside, join(root, "wiki"), "dir");
      await expect(runMultiremi(["wiki", "pull", ...base, "--force"], { programName: "multiremi" }))
        .rejects.toThrow(/unsafe directory|directory is unsafe/);
    });
  });

  test("waits for another Wiki process to release the workspace lock", async () => {
    const docs = new Map<string, DocState>();
    await withWikiServer(docs, async (serverUrl) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      const lock = join(root, ".multiremi", "wiki.lock");
      mkdirSync(lock);
      const release = setTimeout(() => rmdirSync(lock), 40);
      try {
        const started = Date.now();
        await runMultiremi(["wiki", "status", ...base], { programName: "multiremi" });
        expect(Date.now() - started).toBeGreaterThanOrEqual(30);
      } finally {
        clearTimeout(release);
        if (existsSync(lock)) rmdirSync(lock);
      }
    });
  });

  test("pushes repository Wiki updates and creates the first page for an empty repository", async () => {
    const docs = new Map<string, DocState>();
    const repositoryDocs = new Map<string, RepositoryDocState>([["architecture/overview.md", {
      id: "rwdoc_overview",
      path: "architecture/overview.md",
      title: "Architecture",
      body: "before",
      version: 1,
    }]]);
    await withWikiServer(docs, async (serverUrl, requests) => {
      const root = workspaceRoot();
      const base = ["--project", "prj_1", "--server", serverUrl, "--token", "token"];
      await runMultiremi(["wiki", "pull", ...base], { programName: "multiremi" });
      const repositoryRoot = join(root, "wiki", "repositories", "alpha-po_alpha");
      const baseRoot = join(root, ".multiremi", "wiki-base", "repositories");
      mkdirSync(join(repositoryRoot, "architecture"), { recursive: true });
      mkdirSync(join(baseRoot, "files", "alpha-po_alpha", "architecture"), { recursive: true });
      writeFileSync(join(repositoryRoot, "architecture", "overview.md"), "before\n");
      writeFileSync(join(baseRoot, "files", "alpha-po_alpha", "architecture", "overview.md"), "before\n");
      writeFileSync(join(baseRoot, "manifest.json"), `${JSON.stringify({
        version: 1,
        workspaceId: "local",
        pulledAt: "2026-08-18T00:00:00.000Z",
        repositories: [{ id: "repo_alpha", name: "alpha", directory: "alpha-po_alpha" }],
        docs: [{
          id: "rwdoc_overview",
          repositoryId: "repo_alpha",
          repositoryName: "alpha",
          path: "alpha-po_alpha/architecture/overview.md",
          version: 1,
          sourceRevision: "abc123",
          sha256: createHash("sha256").update("before\n").digest("hex"),
          updatedAt: "2026-08-18T00:00:00.000Z",
        }],
      }, null, 2)}\n`);

      await runMultiremi(["wiki", "mv", "rwdoc_overview", "design/overview.md", ...base], { programName: "multiremi" });
      writeFileSync(join(repositoryRoot, "design", "overview.md"), "after\n");
      writeFileSync(join(repositoryRoot, "getting-started.md"), "# Getting started\n\nFirst page.\n");
      rmSync(join(root, ".multiremi", "wiki-base", "manifest.json"));
      await runMultiremi([
        "wiki",
        "push",
        "--server",
        serverUrl,
        "--token",
        "token",
        "--source-revision",
        "deadbeef",
      ], { programName: "multiremi" });

      expect(repositoryDocs.has("architecture/overview.md")).toBe(false);
      expect(repositoryDocs.get("design/overview.md")).toMatchObject({ id: "rwdoc_overview", body: "after", version: 2 });
      expect(repositoryDocs.get("getting-started.md")).toMatchObject({ title: "Getting started", body: "# Getting started\n\nFirst page." });
      expect(requests.filter((request) => request.method === "PUT" || request.method === "POST")
        .every((request) => request.body?.source_revision === "deadbeef")).toBe(true);
      expect(requests.filter((request) => request.path.includes("/repos/repo_alpha/wiki")).map((request) => request.method))
        .toEqual(["GET", "PUT", "POST", "GET"]);
    }, { repositoryDocs });
  });
});

async function withWikiServer(
  docs: Map<string, DocState>,
  run: (serverUrl: string, requests: Array<{ method: string; path: string; body?: any }>, logs: string[]) => Promise<void>,
  hooks: WikiServerHooks = {},
): Promise<void> {
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json();
      requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === "/api/workspaces/local/repos/repo_alpha/wiki" && request.method === "GET") {
        return Response.json({ docs: [...(hooks.repositoryDocs?.values() ?? [])].map(wireRepositoryDoc) });
      }
      if (url.pathname === "/api/workspaces/local/repos/repo_alpha/wiki" && request.method === "POST") {
        if (hooks.rawSubmissions) return rawSubmissionResponse(1);
        const path = String(body.path);
        if (hooks.repositoryDocs?.has(path)) return Response.json({ error: "already exists" }, { status: 409 });
        const created: RepositoryDocState = {
          id: `rwdoc_${path.replace(/[^a-z0-9]+/gi, "_")}`,
          path,
          title: String(body.title),
          body: String(body.body ?? ""),
          version: 1,
        };
        hooks.repositoryDocs?.set(path, created);
        return Response.json({ doc: wireRepositoryDoc(created) }, { status: 201 });
      }
      const repositoryMatch = url.pathname.match(/^\/api\/workspaces\/local\/repos\/repo_alpha\/wiki\/([^/]+)$/);
      if (repositoryMatch) {
        const id = decodeURIComponent(repositoryMatch[1]!);
        const current = [...(hooks.repositoryDocs?.values() ?? [])].find((doc) => doc.id === id);
        if (!current) return Response.json({ error: "not found" }, { status: 404 });
        if (hooks.rawSubmissions && (request.method === "PUT" || request.method === "DELETE")) return rawSubmissionResponse(1);
        if (request.method === "PUT") {
          if (Number(body.expected_version) !== current.version) return Response.json({ error: "version conflict" }, { status: 409 });
          const updated = { ...current, path: String(body.path ?? current.path), body: String(body.body ?? current.body), version: current.version + 1 };
          hooks.repositoryDocs?.delete(current.path);
          hooks.repositoryDocs?.set(updated.path, updated);
          return Response.json({ doc: wireRepositoryDoc(updated) });
        }
        if (request.method === "DELETE") {
          hooks.repositoryDocs?.delete(current.path);
          return Response.json({ doc: wireRepositoryDoc(current) });
        }
      }
      if (url.pathname === "/api/projects/prj_1/docs" && request.method === "GET") {
        return Response.json({ docs: [...docs.values()].map(wireDoc) });
      }
      if (url.pathname === "/api/projects/prj_1/docs" && request.method === "POST") {
        if (hooks.rawSubmissions) return rawSubmissionResponse(1);
        const slug = String(body.slug);
        if (docs.has(slug)) return Response.json({ error: "already exists" }, { status: 409 });
        const created: DocState = {
          id: `pdoc_${slug}`,
          slug,
          path: String(body.path ?? `${slug}.md`),
          title: String(body.title),
          body: String(body.body ?? ""),
          version: 1,
        };
        docs.set(slug, created);
        return Response.json({ doc: wireDoc(created) }, { status: 201 });
      }
      const match = url.pathname.match(/^\/api\/projects\/prj_1\/docs\/([^/]+)$/);
      if (match) {
        const slug = decodeURIComponent(match[1]!);
        const current = docs.get(slug);
        if (!current) return Response.json({ error: "not found" }, { status: 404 });
        if (hooks.rawSubmissions && (request.method === "PUT" || request.method === "DELETE")) return rawSubmissionResponse(1);
        if (request.method === "PUT") {
          if (Number(body.expected_version) !== current.version) return Response.json({ error: "version conflict" }, { status: 409 });
          if (hooks.failUpdate?.(slug)) return Response.json({ error: "version conflict" }, { status: 409 });
          const updated = { ...current, path: String(body.path ?? current.path ?? `${slug}.md`), body: String(body.body ?? current.body), version: current.version + 1 };
          docs.set(slug, updated);
          hooks.afterUpdate?.(slug);
          return Response.json({ doc: wireDoc(updated) });
        }
        if (request.method === "DELETE") {
          if (Number(url.searchParams.get("expected_version")) !== current.version) {
            return Response.json({ error: "version conflict" }, { status: 409 });
          }
          docs.delete(slug);
          return Response.json({ deleted: true });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { logs.push(String(value)); };
    await run(`http://127.0.0.1:${server.port}`, requests, logs);
  } finally {
    console.log = originalLog;
    server.stop(true);
  }
}

function rawSubmissionResponse(index: number): Response {
  return Response.json({
    submission_id: `ksub_test_${index}`,
    status: "pending",
    scope: "project_wiki",
    deduplicated: false,
    message: "waiting for Atlas compilation",
  }, { status: 202 });
}

function workspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-wiki-workspace-"));
  tempDirs.push(root);
  previousWorkspaceRoot = process.env.MULTIREMI_WORKSPACE_ROOT;
  process.env.MULTIREMI_WORKSPACE_ROOT = root;
  return root;
}

function wireDoc(doc: DocState): Record<string, unknown> {
  return {
    ...doc,
    path: doc.path ?? `${doc.slug}.md`,
    project_id: "prj_1",
    workspace_id: "local",
    kind: "wiki",
    summary: null,
    tags: [],
    pinned: false,
    refs: [],
    updated_at: `2026-08-18T00:00:0${doc.version}.000Z`,
  };
}

function wireRepositoryDoc(doc: RepositoryDocState): Record<string, unknown> {
  return {
    ...doc,
    workspace_id: "local",
    repository_id: "repo_alpha",
    slug: doc.path.replace(/\.md$/i, ""),
    summary: null,
    tags: [],
    refs: [],
    source_revision: "abc123",
    status: "healthy",
    status_message: null,
    updated_at: `2026-08-18T00:00:0${doc.version}.000Z`,
  };
}
