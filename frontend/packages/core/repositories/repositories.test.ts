import { describe, expect, it } from "vitest";
import { parseWithFallback } from "../api/schema";
import {
  repositoryListResponseSchema,
  repositoryMutationResponseSchema,
} from "../api/schemas/repositories";
import type {
  RepositoryMutationResponse,
  WorkspaceRepositoryListResponse,
} from "../types";

describe("repository API schemas", () => {
  it("parses a repository list without trusting unknown source values", () => {
    const fallback: WorkspaceRepositoryListResponse = {
      repositories: [],
      total: 0,
    };
    const parsed = parseWithFallback(
      {
        repositories: [{
          id: "repo_1",
          name: "remi",
          url: "https://github.com/multimira-ai/remi.git",
          source: "github",
          description: null,
          default_branch: "main",
          imported_at: "2026-08-09T00:00:00.000Z",
          updated_at: "2026-08-09T00:00:00.000Z",
        }],
        total: 1,
      },
      repositoryListResponseSchema,
      fallback,
      { endpoint: "test repositories" },
    );

    expect(parsed.repositories[0]?.name).toBe("remi");
    expect(parsed.total).toBe(1);
  });

  it("falls back when a repository list drifts", () => {
    const fallback: WorkspaceRepositoryListResponse = {
      repositories: [],
      total: 0,
    };
    expect(parseWithFallback(
      { repositories: null, total: "one" },
      repositoryListResponseSchema,
      fallback,
      { endpoint: "test repositories" },
    )).toEqual(fallback);
  });

  it("downgrades future repository sources to the generic fallback", () => {
    const fallback: WorkspaceRepositoryListResponse = {
      repositories: [],
      total: 0,
    };
    const parsed = parseWithFallback(
      {
        repositories: [{
          id: "repo_2",
          name: "service",
          url: "ssh://git.example.test/team/service.git",
          source: "future-git-provider",
          description: null,
          default_branch: null,
          imported_at: null,
          updated_at: null,
        }],
        total: 1,
      },
      repositoryListResponseSchema,
      fallback,
      { endpoint: "test repository source drift" },
    );

    expect(parsed.repositories[0]?.source).toBe("unknown");
  });

  it("degrades a malformed mutation response to a null repository", () => {
    const fallback: RepositoryMutationResponse = { repository: null };
    expect(parseWithFallback(
      { repository: { id: 42 } },
      repositoryMutationResponseSchema,
      fallback,
      { endpoint: "test repository mutation" },
    )).toEqual(fallback);
  });
});
