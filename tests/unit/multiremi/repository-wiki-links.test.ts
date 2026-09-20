import { describe, expect, it } from "bun:test";
import {
  introducedRepositoryWikiLinkProblems,
  repositoryWikiBacklinks,
  repositoryWikiGraphWithUpserts,
  rewriteRepositoryWikiLinks,
} from "@multiremi/repository-wiki/links.js";

describe("Repository Wiki link graph", () => {
  it("keeps unavailable identities resolvable without trusting their unknown outgoing links", () => {
    const before = [
      { id: "bad", path: "bad.md", body: "stale [[unknown]]", bodyUnavailable: true },
      { id: "known", path: "known.md", body: "[[bad]]" },
      { id: "target", path: "target.md", body: "Target" },
    ];
    expect(introducedRepositoryWikiLinkProblems([], before)).toEqual([]);
    const after = repositoryWikiGraphWithUpserts(before, [{ id: "known", path: "known.md", body: "[[bad]] [[new-broken]]" }]);
    expect(introducedRepositoryWikiLinkProblems(before, after)).toMatchObject([{ sourceId: "known", reason: "unresolved", token: { ref: "new-broken" } }]);
    expect(repositoryWikiBacklinks(before[0]!, before).map(doc => doc.id)).toEqual(["known"]);
    const deleted = before.filter(doc => doc.id !== "bad");
    expect(introducedRepositoryWikiLinkProblems(before, deleted)).toMatchObject([{ sourceId: "known", reason: "unresolved" }]);
  });

  it("rejects a move that leaves a formerly valid ref unresolved", () => {
    const before = [
      { id: "source", path: "guide.md", body: "Read [[architecture/details]]." },
      { id: "target", path: "architecture/details.md", body: "Details" },
    ];
    const after = repositoryWikiGraphWithUpserts(before, [
      { id: "target", path: "operations/details.md", body: "Details" },
    ]);

    expect(introducedRepositoryWikiLinkProblems(before, after)).toMatchObject([{
      sourceId: "source",
      reason: "unresolved",
      token: { ref: "architecture/details" },
    }]);
  });

  it("accepts a coherent move when the referrer is updated in the same graph", () => {
    const before = [
      { id: "source", path: "guide.md", body: "Read [[architecture/details]]." },
      { id: "target", path: "architecture/details.md", body: "Details" },
    ];
    const after = repositoryWikiGraphWithUpserts(before, [
      { id: "source", path: "guide.md", body: "Read [[operations/details]]." },
      { id: "target", path: "operations/details.md", body: "Details" },
    ]);

    expect(introducedRepositoryWikiLinkProblems(before, after)).toEqual([]);
  });

  it("allows unrelated edits when a repository already contains legacy broken links", () => {
    const before = [
      { id: "legacy", path: "legacy.md", body: "Old [[missing]]." },
      { id: "edited", path: "edited.md", body: "Before" },
    ];
    const after = repositoryWikiGraphWithUpserts(before, [
      { id: "edited", path: "edited.md", body: "After" },
    ]);

    expect(introducedRepositoryWikiLinkProblems(before, after)).toEqual([]);
  });

  it("detects ambiguous refs and silent retargeting after moves", () => {
    const ambiguousBefore = [
      { id: "source", path: "index.md", body: "[[setup]]" },
      { id: "one", path: "one/setup.md", body: "One" },
    ];
    const ambiguousAfter = [
      ...ambiguousBefore,
      { id: "two", path: "two/setup.md", body: "Two" },
    ];
    expect(introducedRepositoryWikiLinkProblems(ambiguousBefore, ambiguousAfter)).toMatchObject([{
      reason: "ambiguous",
      resolution: { status: "ambiguous" },
    }]);

    const before = [
      { id: "source", path: "guides/index.md", body: "[[details]]" },
      { id: "local", path: "guides/details.md", body: "Local" },
      { id: "other", path: "other/details.md", body: "Other" },
    ];
    const after = repositoryWikiGraphWithUpserts(before, [
      { id: "local", path: "archive/local-details.md", body: "Local" },
    ]);
    expect(introducedRepositoryWikiLinkProblems(before, after)).toMatchObject([{
      reason: "retargeted",
      previousTarget: { id: "local" },
      resolution: { status: "resolved", document: { id: "other" } },
    }]);
  });

  it("ignores code examples and resolves backlinks through the shared resolver", () => {
    const docs = [
      { id: "target", path: "guides/target.md", body: "Target" },
      { id: "source", path: "guides/source.md", body: "See [[target#usage|usage]]." },
      { id: "code", path: "guides/code.md", body: "`[[target]]`\n```md\n[[target]]\n```" },
    ];

    expect(repositoryWikiBacklinks(docs[0]!, docs).map((doc) => doc.id)).toEqual(["source"]);
    expect(introducedRepositoryWikiLinkProblems([], docs)).toEqual([]);
  });
});

describe("Repository Wiki Markdown page links", () => {
  it("counts a Markdown link to exactly one page as a hard link", () => {
    const docs = [
      { id: "target", path: "concepts/target.md", body: "Target" },
      { id: "sibling", path: "concepts/sibling.md", body: "See [target](./target.md)." },
      { id: "rootpath", path: "concepts/rootpath.md", body: "See [target](concepts/target.md)." },
    ];

    expect(repositoryWikiBacklinks(docs[0]!, docs).map((doc) => doc.id)).toEqual(["sibling", "rootpath"]);
    expect(introducedRepositoryWikiLinkProblems([], docs)).toEqual([]);
  });

  it("treats Markdown links to source files, missing pages, and several pages as soft references", () => {
    const before = [
      { id: "target", path: "concepts/target.md", body: "Target" },
      { id: "one", path: "one/setup.md", body: "One" },
      { id: "two", path: "two/setup.md", body: "Two" },
      { id: "source", path: "concepts/source.md", body: "Before" },
    ];
    const after = repositoryWikiGraphWithUpserts(before, [{
      id: "source",
      path: "concepts/source.md",
      body: "Read [client](packages/server/src/client.ts), [gone](concepts/gone.md), and [setup](setup.md#usage).",
    }]);

    expect(introducedRepositoryWikiLinkProblems(before, after)).toEqual([]);
    expect(repositoryWikiBacklinks(before[0]!, after).map((doc) => doc.id)).toEqual([]);
    expect(repositoryWikiBacklinks(before[1]!, after).map((doc) => doc.id)).toEqual([]);
    expect(repositoryWikiBacklinks(before[2]!, after).map((doc) => doc.id)).toEqual([]);
  });

  it("still blocks a Markdown page link that stops resolving", () => {
    const before = [
      { id: "source", path: "concepts/source.md", body: "See [target](./target.md)." },
      { id: "target", path: "concepts/target.md", body: "Target" },
    ];
    const after = before.filter((doc) => doc.id !== "target");

    expect(introducedRepositoryWikiLinkProblems(before, after)).toMatchObject([{
      sourceId: "source",
      sourcePath: "concepts/source.md",
      reason: "unresolved",
      token: { syntax: "markdown", ref: "./target.md" },
    }]);
  });

  it("rewrites a root-path Markdown link into canonical form when its target moves", () => {
    const source = { id: "overview", path: "concepts/run-observability/overview.md", body: "Read [Loops](concepts/loops.md)." };
    const before = [source, { id: "loops", path: "concepts/loops.md", body: "Loops" }];
    const moved = { id: "loops", path: "concepts/motion/loops.md", body: "Loops" };

    const rewritten = rewriteRepositoryWikiLinks(source.body, source.path, source.path, before, [source, moved]);

    expect(rewritten).toBe("Read [[concepts/motion/loops.md|Loops]].");
    // The rewritten body keeps the link resolved, so the move passes the gate.
    const after = [{ ...source, body: rewritten }, moved];
    expect(introducedRepositoryWikiLinkProblems(before, after)).toEqual([]);
  });

  it("leaves soft Markdown references byte-identical when a page moves", () => {
    const body = "Read [client](packages/server/src/client.ts), [gone](concepts/gone.md), and [[architecture/b|B]].";
    const source = { id: "guide", path: "guide.md", body };
    const before = [source, { id: "b", path: "architecture/b.md", body: "B" }];
    const moved = { id: "b", path: "operations/b.md", body: "B" };

    expect(rewriteRepositoryWikiLinks(body, source.path, source.path, before, [source, moved]))
      .toBe("Read [client](packages/server/src/client.ts), [gone](concepts/gone.md), and [[operations/b.md|B]].");
  });
});
