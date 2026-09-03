import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeWikiHeadingAnchor,
  wikiBacklinkKeys,
  wikiBacklinksOptions,
} from "./wiki-links";

const { projectBacklinksMock, repositoryBacklinksMock } = vi.hoisted(() => ({
  projectBacklinksMock: vi.fn(),
  repositoryBacklinksMock: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    listProjectDocBacklinks: projectBacklinksMock,
    listRepositoryWikiBacklinks: repositoryBacklinksMock,
  },
}));

beforeEach(() => {
  projectBacklinksMock.mockReset().mockResolvedValue([]);
  repositoryBacklinksMock.mockReset().mockResolvedValue([]);
});

describe("wikiBacklinksOptions", () => {
  it("loads Project Wiki backlinks using a workspace-scoped cache key", async () => {
    const scope = { kind: "project" as const, projectId: "project-1" };
    const options = wikiBacklinksOptions("ws-1", scope, "doc-1");

    expect(options.queryKey).toEqual(wikiBacklinkKeys.detail("ws-1", scope, "doc-1"));
    await options.queryFn?.({} as never);
    expect(projectBacklinksMock).toHaveBeenCalledWith("project-1", "doc-1");
  });

  it("loads Repository Wiki backlinks with the repository identity", async () => {
    const scope = { kind: "repository" as const, repositoryId: "repo-1" };
    const options = wikiBacklinksOptions("ws-1", scope, "doc-1");

    await options.queryFn?.({} as never);
    expect(repositoryBacklinksMock).toHaveBeenCalledWith("ws-1", "repo-1", "doc-1");
  });
});

describe("normalizeWikiHeadingAnchor", () => {
  it("normalizes Latin and CJK headings without dropping meaningful text", () => {
    expect(normalizeWikiHeadingAnchor("  Deploy Checks!  ")).toBe("deploy-checks");
    expect(normalizeWikiHeadingAnchor("发布 流程")).toBe("发布-流程");
  });
});
