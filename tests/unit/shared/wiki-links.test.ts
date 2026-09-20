import { describe, expect, it } from "bun:test";
import {
  resolveProjectWikiRef,
  resolveRepositoryWikiMarkdownRef,
  resolveRepositoryWikiRef,
  resolveRepositoryWikiToken,
  tokenizeMarkdownWikiLinks,
  tokenizeRepositoryWikiLinks,
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

describe("Markdown Wiki link contracts", () => {
  it("tokenizes .md links with offsets while ignoring every other link shape", () => {
    const markdown = [
      "See [Runbook](concepts/runbook.md) and [Deploy](concepts/runbook.md#deploy).",
      "Skip ![shot](concepts/runbook.md), [site](https://example.com/a.md), [mail](mailto:a@b.c),",
      "[abs](/concepts/runbook.md), [anchor](#deploy), [source](packages/server/src/links.ts),",
      "and `[code](concepts/runbook.md)`.",
    ].join("\n");

    const tokens = tokenizeMarkdownWikiLinks(markdown);

    expect(tokens.map(({ raw, ref, anchor, label, syntax }) => ({ raw, ref, anchor, label, syntax }))).toEqual([
      { raw: "[Runbook](concepts/runbook.md)", ref: "concepts/runbook.md", anchor: null, label: "Runbook", syntax: "markdown" },
      { raw: "[Deploy](concepts/runbook.md#deploy)", ref: "concepts/runbook.md", anchor: "deploy", label: "Deploy", syntax: "markdown" },
    ]);
    for (const token of tokens) expect(markdown.slice(token.start, token.end)).toBe(token.raw);
  });

  it("keeps canonical tokens unchanged and merges Markdown tokens without overlap", () => {
    const markdown = "[a](a.md) then [[b|B]] then [[guide|[nested](nested.md)]] and [c](c.md).";

    expect(tokenizeWikiLinks(markdown).map(({ raw, syntax }) => ({ raw, syntax }))).toEqual([
      { raw: "[[b|B]]", syntax: undefined },
      { raw: "[[guide|[nested](nested.md)]]", syntax: undefined },
    ]);
    expect(tokenizeRepositoryWikiLinks(markdown).map(({ raw, syntax }) => ({ raw, syntax }))).toEqual([
      { raw: "[a](a.md)", syntax: "markdown" },
      { raw: "[[b|B]]", syntax: undefined },
      { raw: "[[guide|[nested](nested.md)]]", syntax: undefined },
      { raw: "[c](c.md)", syntax: "markdown" },
    ]);
  });

  it("prefers the page-relative reading, then falls back to a repository-root path", () => {
    const source = "concepts/run-observability/overview.md";
    const documents = [
      { id: "source", path: source },
      { id: "relative", path: "concepts/run-observability/concepts/loops.md" },
      { id: "root", path: "concepts/loops.md" },
    ];

    // Both readings exist — the browser-style page-relative one wins.
    expect(resolveRepositoryWikiMarkdownRef("concepts/loops.md", source, documents)).toMatchObject({
      status: "resolved",
      document: { id: "relative" },
    });
    // The shape that produced the dy-code-context breakage: only the
    // repository-root reading resolves.
    expect(resolveRepositoryWikiMarkdownRef("concepts/loops.md", source, [documents[0]!, documents[2]!]))
      .toMatchObject({ status: "resolved", document: { id: "root" } });
    // A sibling written the way the browser resolves it.
    expect(resolveRepositoryWikiMarkdownRef("./loops.md", source, [documents[0]!, documents[2]!]))
      .toEqual({ status: "missing", ref: "./loops.md" });
  });

  it("returns missing for source file paths, removed pages, and empty targets", () => {
    const documents = [{ id: "source", path: "index.md" }];

    for (const ref of ["packages/server/src/links.md", "concepts/gone.md", null, "   "]) {
      expect(resolveRepositoryWikiMarkdownRef(ref, "index.md", documents)).toMatchObject({ status: "missing" });
    }
  });

  it("dispatches by source syntax so canonical refs keep their own precedence", () => {
    const source = "concepts/run-observability/overview.md";
    const documents = [
      { id: "source", path: source },
      { id: "relative", path: "concepts/run-observability/concepts/loops.md" },
      { id: "root", path: "concepts/loops.md" },
    ];

    // Canonical refs read a directory-bearing ref as a repository-root path.
    expect(resolveRepositoryWikiToken({ ref: "concepts/loops.md", syntax: undefined }, source, documents))
      .toMatchObject({ status: "resolved", document: { id: "root" } });
    // Markdown links read it the way a browser would: relative to the page first.
    expect(resolveRepositoryWikiToken({ ref: "concepts/loops.md", syntax: "markdown" }, source, documents))
      .toMatchObject({ status: "resolved", document: { id: "relative" } });
    // Drop the page-relative page and the Markdown link falls back to the root path.
    expect(resolveRepositoryWikiToken(
      { ref: "concepts/loops.md", syntax: "markdown" },
      source,
      [documents[0]!, documents[2]!],
    )).toMatchObject({ status: "resolved", document: { id: "root" } });
  });
});
