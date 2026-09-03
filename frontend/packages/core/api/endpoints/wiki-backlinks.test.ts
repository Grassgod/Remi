import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ProjectDocsEndpoints } from "./project-docs";
import { RepositoriesEndpoints } from "./repositories";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Wiki backlinks endpoint response compatibility", () => {
  it("degrades malformed Project Wiki backlinks to an empty list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: null }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new ProjectDocsEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.listProjectDocBacklinks("project-1", "architecture/overview#API surface"),
    ).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/projects/project-1/docs/architecture%2Foverview%23API%20surface/backlinks",
    );
  });

  it("degrades malformed Repository Wiki backlinks to an empty list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ docs: "invalid" }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new RepositoriesEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.listRepositoryWikiBacklinks(
        "workspace/1",
        "repository/1",
        "operations/deploy#Rollback",
      ),
    ).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/workspaces/workspace%2F1/repos/repository%2F1/wiki/operations%2Fdeploy%23Rollback/backlinks",
    );
  });
});
