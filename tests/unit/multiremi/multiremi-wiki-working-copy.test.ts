import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

interface DocState {
  id: string;
  slug: string;
  title: string;
  body: string;
  version: number;
}

interface WikiServerHooks {
  afterUpdate?: (slug: string) => void;
  failUpdate?: (slug: string) => boolean;
}

const tempDirs: string[] = [];
let previousWorkspaceRoot: string | undefined;

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.MULTIREMI_WORKSPACE_ROOT;
  else process.env.MULTIREMI_WORKSPACE_ROOT = previousWorkspaceRoot;
  previousWorkspaceRoot = undefined;
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
});

async function withWikiServer(
  docs: Map<string, DocState>,
  run: (serverUrl: string, requests: Array<{ method: string; path: string; body?: any }>) => Promise<void>,
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
      if (url.pathname === "/api/projects/prj_1/docs" && request.method === "GET") {
        return Response.json({ docs: [...docs.values()].map(wireDoc) });
      }
      if (url.pathname === "/api/projects/prj_1/docs" && request.method === "POST") {
        const slug = String(body.slug);
        if (docs.has(slug)) return Response.json({ error: "already exists" }, { status: 409 });
        const created: DocState = {
          id: `pdoc_${slug}`,
          slug,
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
        if (request.method === "PUT") {
          if (Number(body.expected_version) !== current.version) return Response.json({ error: "version conflict" }, { status: 409 });
          if (hooks.failUpdate?.(slug)) return Response.json({ error: "version conflict" }, { status: 409 });
          const updated = { ...current, body: String(body.body ?? current.body), version: current.version + 1 };
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
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    await run(`http://127.0.0.1:${server.port}`, requests);
  } finally {
    console.log = originalLog;
    server.stop(true);
  }
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
