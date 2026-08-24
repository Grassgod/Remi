import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { parseWithFallback } from "../api/schema";
import { repositoryWikiSummariesResponseSchema } from "../api/schemas/repositories";
import type { RepositoryWikiSummary } from "../types";
import {
  isWikiBuildActive,
  WIKI_BUILD_POLL_INTERVAL_MS,
  wikiSummariesRefetchInterval,
} from "./queries";
import {
  isWikiBuildInProgressError,
  REPOSITORY_WIKI_BUILD_IN_PROGRESS_CODE,
} from "./mutations";

function summary(overrides: Partial<RepositoryWikiSummary> = {}): RepositoryWikiSummary {
  return {
    repository_id: "repo-1",
    repository_name: "web",
    status: "healthy",
    status_message: null,
    source_revision: null,
    page_count: 3,
    updated_at: null,
    build: null,
    ...overrides,
  };
}

function build(overrides: Partial<NonNullable<RepositoryWikiSummary["build"]>> = {}) {
  return {
    status: "idle" as const,
    run_id: null,
    task_id: null,
    failure_reason: null,
    started_at: null,
    updated_at: null,
    source_revision: null,
    ...overrides,
  };
}

describe("repository wiki summary build schema", () => {
  const parse = (raw: unknown) =>
    parseWithFallback(raw, repositoryWikiSummariesResponseSchema, { repositories: [] as RepositoryWikiSummary[] }, {
      endpoint: "test wiki summaries",
    }).repositories;

  const base = {
    repository_id: "repo-1",
    repository_name: "web",
    status: "building",
    page_count: 0,
  };

  it("parses the build block when the server sends one", () => {
    const [parsed] = parse({
      repositories: [{
        ...base,
        build: {
          status: "building",
          run_id: "run-1",
          task_id: "task-1",
          failure_reason: null,
          started_at: "2026-08-24T00:00:00Z",
          updated_at: "2026-08-24T00:01:00Z",
          source_revision: "abc1234def",
        },
      }],
    });
    expect(parsed?.build?.status).toBe("building");
    expect(parsed?.build?.run_id).toBe("run-1");
    expect(parsed?.build?.task_id).toBe("task-1");
  });

  it("defaults build to null for older servers that omit it", () => {
    const [parsed] = parse({ repositories: [base] });
    expect(parsed?.build).toBeNull();
  });

  it("downgrades an unknown build status to idle", () => {
    const [parsed] = parse({
      repositories: [{ ...base, build: { status: "canceled" } }],
    });
    expect(parsed?.build?.status).toBe("idle");
  });

  it("degrades a malformed build block to null without dropping the summary", () => {
    const [parsed] = parse({
      repositories: [{ ...base, build: "definitely-not-an-object" }],
    });
    expect(parsed?.repository_id).toBe("repo-1");
    expect(parsed?.build).toBeNull();
  });
});

describe("isWikiBuildActive", () => {
  it("is inactive without a summary or an active build", () => {
    expect(isWikiBuildActive(undefined)).toBe(false);
    expect(isWikiBuildActive(summary())).toBe(false);
    expect(isWikiBuildActive(summary({ build: build({ status: "failed" }) }))).toBe(false);
  });

  it("is active for queued and building build states", () => {
    expect(isWikiBuildActive(summary({ build: build({ status: "queued" }) }))).toBe(true);
    expect(isWikiBuildActive(summary({ build: build({ status: "building" }) }))).toBe(true);
  });

  it("falls back to the top-level building status for older servers", () => {
    expect(isWikiBuildActive(summary({ status: "building", build: null }))).toBe(true);
  });
});

describe("wikiSummariesRefetchInterval", () => {
  it("does not poll without data or without an active build", () => {
    expect(wikiSummariesRefetchInterval(undefined)).toBe(false);
    expect(wikiSummariesRefetchInterval([])).toBe(false);
    expect(wikiSummariesRefetchInterval([
      summary(),
      summary({ repository_id: "repo-2", build: build({ status: "failed" }) }),
    ])).toBe(false);
  });

  it("polls at the build cadence while any repository is queued or building", () => {
    expect(wikiSummariesRefetchInterval([
      summary(),
      summary({ repository_id: "repo-2", build: build({ status: "queued" }) }),
    ])).toBe(WIKI_BUILD_POLL_INTERVAL_MS);
    expect(wikiSummariesRefetchInterval([
      summary({ status: "building" }),
    ])).toBe(WIKI_BUILD_POLL_INTERVAL_MS);
  });
});

describe("isWikiBuildInProgressError", () => {
  it("recognises the structured 409 conflict", () => {
    const error = new ApiError("wiki build already running", 409, "Conflict", {
      error: "wiki build already running",
      code: REPOSITORY_WIKI_BUILD_IN_PROGRESS_CODE,
      run_id: "run-1",
      task_id: "task-1",
    });
    expect(isWikiBuildInProgressError(error)).toBe(true);
  });

  it("treats a bare 409 without a code as in-progress", () => {
    expect(isWikiBuildInProgressError(new ApiError("conflict", 409, "Conflict"))).toBe(true);
  });

  it("rejects other statuses, other codes and non-ApiError values", () => {
    expect(isWikiBuildInProgressError(new ApiError("boom", 500, "Internal Server Error"))).toBe(false);
    expect(isWikiBuildInProgressError(new ApiError("conflict", 409, "Conflict", { code: "something_else" }))).toBe(false);
    expect(isWikiBuildInProgressError(new Error("conflict"))).toBe(false);
    expect(isWikiBuildInProgressError(undefined)).toBe(false);
  });
});
