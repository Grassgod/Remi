import { describe, expect, test } from "bun:test";
import {
  lintWikiDocuments,
  mergeWikiDocuments,
  wikiLint,
  type LibrarianWikiDocument,
} from "../../../apps/remi/cli/multiremi/commands/wiki-librarian.js";

describe("Wiki librarian", () => {
  test("reports duplicate, contradiction, orphan, and broken-link findings", () => {
    const duplicateBody = "The deployment pipeline builds the application, verifies the release artifact, and publishes the immutable image for production use.";
    const docs: LibrarianWikiDocument[] = [
      doc("overview", "overview.md", "[[service-a]] [[missing-page]]"),
      doc("service-a", "services/a.md", `${duplicateBody}\nRuntime version: 20`),
      doc("service-copy", "services/copy.md", `${duplicateBody}\nRuntime version: 20`, "repository", "repo_1"),
      doc("service-b", "services/b.md", "Runtime version: 22"),
      doc("lonely", "notes/lonely.md", "This page has no incoming links and remains isolated from navigation."),
    ];

    const report = lintWikiDocuments(docs);

    expect(report.clean).toBe(false);
    expect(report.documents_scanned).toBe(5);
    expect(report.counts.duplicate).toBeGreaterThanOrEqual(1);
    expect(report.counts.contradiction).toBeGreaterThanOrEqual(1);
    expect(report.counts.orphan).toBeGreaterThanOrEqual(1);
    expect(report.counts.broken_link).toBe(1);
    expect(report.findings.find((finding) => finding.type === "duplicate")).toMatchObject({
      document: { slug: "service-a" },
      related_document: { slug: "service-copy", scope: "repository" },
    });
    expect(report.findings.find((finding) => finding.type === "contradiction")).toMatchObject({
      fact: "Runtime version",
      values: ["20", "22"],
    });
    expect(report.findings.find((finding) => finding.type === "broken_link")).toMatchObject({
      document: { slug: "overview" },
      target: "missing-page",
    });
    expect(report.findings.some((finding) => finding.type === "orphan" && finding.document.slug === "lonely")).toBe(true);
    expect(report.diagnostics).toEqual([]);
  });

  test("requires a subject and supported property before reporting contradictions", () => {
    const report = lintWikiDocuments([
      doc("first", "first.md", "file: src/first.ts\ncommit: abc\npath: src/first.ts\nRuntime version: 20"),
      doc("second", "second.md", "file: src/second.ts\ncommit: def\npath: src/second.ts\nRuntime version: 22"),
      doc("repository", "repository.md", "Runtime version: 18", "repository", "repo_1"),
    ]);

    expect(report.counts.contradiction).toBe(1);
    expect(report.findings.filter((finding) => finding.type === "contradiction")).toEqual([
      expect.objectContaining({ fact: "Runtime version", values: ["20", "22"] }),
    ]);
  });

  test("deduplicates broken links, ignores schema examples, and resolves materialized repository paths", () => {
    const repository = {
      ...doc("runbook", "guides/runbook.md", "# Runbook", "repository", "repo_bound"),
      repositoryDirectory: "Remi-po_bound",
    };
    const report = lintWikiDocuments([
      doc("overview", "overview.md", "[[missing]] and again [[missing]]\n[[repositories/Remi-po_bound/guides/runbook]]"),
      doc("_schema", "_schema.md", "Use [[slug]] as an example."),
      repository,
    ]);

    expect(report.counts.broken_link).toBe(1);
    expect(report.findings.filter((finding) => finding.type === "broken_link")).toHaveLength(1);
    expect(report.findings.find((finding) => finding.type === "broken_link")).toMatchObject({
      document: { slug: "overview" },
      target: "missing",
    });
  });

  test("resolves Project Memory links without scanning Memory as Wiki pages", () => {
    const report = lintWikiDocuments([
      doc("overview", "overview.md", "See [[known-memory]] and [[missing]]."),
    ], ["known-memory"]);

    expect(report.documents_scanned).toBe(1);
    expect(report.counts.broken_link).toBe(1);
    expect(report.findings.find((finding) => finding.type === "broken_link")).toMatchObject({ target: "missing" });
  });

  test("reports oversized contradiction buckets instead of silently truncating them", () => {
    const report = lintWikiDocuments(Array.from({ length: 65 }, (_, index) =>
      doc(`runtime-${index}`, `runtime-${index}.md`, `Runtime version: ${index}`)
    ));

    expect(report.counts.contradiction).toBe(0);
    expect(report.diagnostics).toEqual([
      expect.stringContaining("65 facts exceed the 64-fact limit"),
    ]);
    expect(report.clean).toBe(false);
  });

  test("fetches only repositories associated with the selected project", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        paths.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/api/cli/context") {
          return Response.json({
            current: { project: { id: "prj_selected", repository_ids: ["repo_bound"] } },
            catalog: {
              projects: [],
              repositories: [
                { id: "repo_bound", name: "Remi" },
                { id: "repo_unrelated", name: "Unrelated" },
              ],
              next_cursor: null,
            },
          });
        }
        if (url.pathname === "/api/projects/prj_selected/docs" && url.searchParams.get("kind") === "wiki") {
          return Response.json({ docs: [apiDoc("project-page", "project-page.md")] });
        }
        if (url.pathname === "/api/projects/prj_selected/docs" && url.searchParams.get("kind") === "memory") {
          return Response.json({ docs: [apiDoc("known-memory", "known-memory.md")] });
        }
        if (url.pathname === "/api/workspaces/ws_1/repos/repo_bound/wiki") {
          return Response.json({ docs: [apiDoc("repository-page", "guides/repository-page.md")] });
        }
        return Response.json({ error: "unexpected request" }, { status: 500 });
      },
    });
    const originalLog = console.log;
    try {
      console.log = () => {};
      const report = await wikiLint({
        server: `http://127.0.0.1:${server.port}`,
        token: "token",
        workspace: "ws_1",
      }, "prj_selected");

      expect(report.documents_scanned).toBe(2);
      expect(paths).toContain("/api/cli/context?limit=200");
      expect(paths).toContain("/api/workspaces/ws_1/repos/repo_bound/wiki");
      expect(paths.some((path) => path.includes("repo_unrelated/wiki"))).toBe(false);
      expect(paths.some((path) => path === "/api/workspaces/ws_1/repos")).toBe(false);
    } finally {
      console.log = originalLog;
      server.stop(true);
    }
  });

  test("merges source content and preserves source references", () => {
    const target = { ...doc("target", "target.md", "# Target"), refs: [{ type: "issue", value: "MUL-1" }] };
    const source = { ...doc("source", "source.md", "Source facts."), refs: [{ type: "url", value: "https://example.test/fact" }] };

    const merged = mergeWikiDocuments("prj_1", target, [source]);

    expect(merged.body).toContain("<!-- merged-from:project_source -->");
    expect(merged.body).toContain("Source facts.");
    expect(merged.refs).toEqual([
      { type: "issue", value: "MUL-1" },
      { type: "url", value: "https://example.test/fact" },
      { type: "wiki", value: "project:prj_1/source" },
    ]);
  });
});

function doc(
  slug: string,
  path: string,
  body: string,
  scope: LibrarianWikiDocument["scope"] = "project",
  repositoryId: string | null = null,
): LibrarianWikiDocument {
  return {
    id: `${scope}_${slug}`,
    scope,
    repositoryId,
    slug,
    path,
    title: slug,
    body,
    refs: [],
    version: 1,
  };
}

function apiDoc(slug: string, path: string): Record<string, unknown> {
  return {
    id: `doc_${slug}`,
    slug,
    path,
    title: slug,
    body: `# ${slug}`,
    refs: [],
    version: 1,
  };
}
