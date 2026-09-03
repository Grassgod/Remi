import { describe, expect, it } from "bun:test";
import {
  resolveProjectWikiRef,
  resolveRepositoryWikiRef,
  tokenizeWikiLinks,
} from "@multiremi/contracts/wiki-links";

describe("Wiki link contracts", () => {
  it("tokenizes refs, anchors, self anchors, and labels with source offsets", () => {
    const markdown = "See [[guide]], [[guide#setup|Setup]], and [[#local]].";
    const tokens = tokenizeWikiLinks(markdown);

    expect(tokens.map(({ raw, ref, anchor, label }) => ({ raw, ref, anchor, label }))).toEqual([
      { raw: "[[guide]]", ref: "guide", anchor: null, label: null },
      { raw: "[[guide#setup|Setup]]", ref: "guide", anchor: "setup", label: "Setup" },
      { raw: "[[#local]]", ref: null, anchor: "local", label: null },
    ]);
    for (const token of tokens) expect(markdown.slice(token.start, token.end)).toBe(token.raw);
  });

  it("ignores escaped markers, inline code, fenced code, and indented code blocks", () => {
    const markdown = [
      "\\[[escaped]] and `[[inline]]` and [[visible]].",
      "```ts",
      "const value = '[[fenced]]';",
      "```",
      "~~~",
      "[[also-fenced]]",
      "~~~",
      "    [[indented-with-spaces]]",
      "\t[[indented-with-tab]]",
      "[[visible-after-code]]",
    ].join("\n");

    expect(tokenizeWikiLinks(markdown).map((token) => token.ref)).toEqual(["visible", "visible-after-code"]);
  });

  it("keeps ./ references in the source directory without falling back to root", () => {
    const documents = [
      { id: "source", path: "guides/index.md" },
      { id: "local", path: "guides/nested/page.md" },
      { id: "root", path: "nested/page.md" },
    ];

    expect(resolveRepositoryWikiRef("./nested/page", "guides/index.md", documents)).toMatchObject({
      status: "resolved",
      document: { id: "local" },
    });
    expect(resolveRepositoryWikiRef("./root-only", "guides/index.md", [
      documents[0]!,
      { id: "root-only", path: "root-only.md" },
    ])).toEqual({ status: "missing", ref: "./root-only" });
  });

  it("resolves ids, explicit paths, sibling refs, unique basenames, and self anchors", () => {
    const documents = [
      { id: "source", path: "guides/start.md" },
      { id: "sibling", path: "guides/details.md" },
      { id: "architecture", path: "architecture/details.md" },
      { id: "unique", path: "operations/troubleshooting.md" },
    ];

    expect(resolveRepositoryWikiRef("sibling", "guides/start.md", documents)).toMatchObject({
      status: "resolved", document: { id: "sibling" },
    });
    expect(resolveRepositoryWikiRef("architecture/details", "guides/start.md", documents)).toMatchObject({
      status: "resolved", document: { id: "architecture" },
    });
    expect(resolveRepositoryWikiRef("details", "guides/start.md", documents)).toMatchObject({
      status: "resolved", document: { id: "sibling" },
    });
    expect(resolveRepositoryWikiRef("troubleshooting", "guides/start.md", documents)).toMatchObject({
      status: "resolved", document: { id: "unique" },
    });
    expect(resolveRepositoryWikiRef(null, "guides/start.md", documents)).toMatchObject({
      status: "resolved", document: { id: "source" },
    });
  });

  it("reports ambiguous basenames instead of selecting one", () => {
    const documents = [
      { id: "source", path: "index.md" },
      { id: "one", path: "one/setup.md" },
      { id: "two", path: "two/setup.md" },
    ];

    expect(resolveRepositoryWikiRef("setup", "index.md", documents)).toEqual({
      status: "ambiguous",
      ref: "setup",
      candidates: [documents[1], documents[2]],
    });
    expect(resolveRepositoryWikiRef("missing", "index.md", documents)).toEqual({
      status: "missing",
      ref: "missing",
    });
  });

  it("resolves Project Wiki refs by id, stable slug, exact path, and self anchor", () => {
    const documents = [
      { id: "source", slug: "start", path: "guides/start.md" },
      { id: "target", slug: "release-runbook", path: "operations/runbook.md" },
    ];

    for (const ref of ["target", "release-runbook", "operations/runbook.md"]) {
      expect(resolveProjectWikiRef(ref, "guides/start.md", documents)).toMatchObject({
        status: "resolved",
        document: { id: "target" },
      });
    }
    expect(resolveProjectWikiRef(null, "guides/start.md", documents)).toMatchObject({
      status: "resolved",
      document: { id: "source" },
    });
  });
});
