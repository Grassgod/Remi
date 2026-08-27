import { describe, expect, test } from "bun:test";
import {
  lintWikiDocuments,
  mergeWikiDocuments,
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
