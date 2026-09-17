import { describe, expect, it } from "bun:test";
import {
  introducedRepositoryWikiLinkProblems,
  repositoryWikiBacklinks,
  repositoryWikiGraphWithUpserts,
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
