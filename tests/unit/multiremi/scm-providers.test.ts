import { afterEach, describe, expect, it } from "bun:test";
import { CODEBASE_SCM_CAPABILITIES, GITHUB_SCM_CAPABILITIES } from "@multiremi/scm/capabilities.js";
import { CodebaseScmProviderAdapter } from "@multiremi/scm/codebase.js";
import { GitHubScmProviderAdapter } from "@multiremi/scm/github.js";
import type { ScmPollContext } from "@multiremi/scm/types.js";
import { scmBinding, scmConnection } from "./scm-test-helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SCM provider adapters", () => {
  it("publishes provider differences instead of pretending webhook parity", () => {
    expect(GITHUB_SCM_CAPABILITIES.streams.pipelines.webhook).toBe(true);
    expect(CODEBASE_SCM_CAPABILITIES.streams.pipelines.poll).toBe(true);
    expect(CODEBASE_SCM_CAPABILITIES.streams.pipelines.webhook).toBe(false);
    expect(GITHUB_SCM_CAPABILITIES.supportsDeleteTombstones).toBe(false);
    expect(CODEBASE_SCM_CAPABILITIES.supportsDeleteTombstones).toBe(false);
  });

  it("polls GitHub pull requests with authenticated pagination", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify([{
        id: 9001,
        number: 42,
        title: "Ship it",
        state: "open",
        draft: false,
        html_url: "https://github.com/acme/widgets/pull/42",
        created_at: "2026-08-21T07:00:00.000Z",
        updated_at: "2026-08-21T07:59:00.000Z",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main", sha: "def" },
        user: { login: "octocat" },
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await new GitHubScmProviderAdapter().poll(context("change_requests"));
    expect(result.done).toBe(true);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.payload).toMatchObject({ state: "open", source_branch: "feature", target_branch: "main" });
    expect(requests[0]?.url).toContain("/repos/acme/widgets/pulls");
    expect(requests[0]?.url).toContain("per_page=100");
    expect(requests[0]?.authorization).toBe("Bearer token");
  });

  it("calls the Codebase action API with its updated-since cursor", async () => {
    const requests: Array<{ action: string | null; body: Record<string, unknown>; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        action: url.searchParams.get("Action"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({
        ResponseMetadata: { RequestId: "req-1", Action: "ListRepoMergeRequests" },
        Result: {
          MergeRequests: [{
            Id: "mr-9",
            Number: 9,
            Title: "Codebase change",
            Status: "merged",
            SourceBranchName: "feature",
            TargetBranchName: "main",
            UpdatedAt: "2026-08-21T07:58:00.000Z",
            MergedAt: "2026-08-21T07:58:00.000Z",
            MergeCommitId: "abc",
          }],
          PageNumber: 1,
          PageSize: 100,
          TotalCount: 1,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const codebaseContext: ScmPollContext = {
      ...context("change_requests"),
      connection: scmConnection({
        provider: "codebase",
        baseUrl: "https://code.byted.org",
        apiBaseUrl: "https://codebase-api.byted.org/v2/",
      }),
      binding: scmBinding({ externalId: "repo-101", repositoryUrl: "https://code.byted.org/acme/widgets.git" }),
      cursor: {
        connectionId: "scm_1",
        repositoryId: "repo_1",
        stream: "change_requests",
        cursor: null,
        watermark: "2026-08-21T07:55:00.000Z",
        baselineCompletedAt: "2026-08-21T07:00:00.000Z",
        lastStartedAt: null,
        lastCompletedAt: null,
        lastError: null,
        updatedAt: "2026-08-21T07:55:00.000Z",
      },
    };
    const result = await new CodebaseScmProviderAdapter().poll(codebaseContext);
    expect(result.observations[0]?.payload).toMatchObject({ state: "merged", merge_sha: "abc" });
    expect(requests[0]?.action).toBe("ListRepoMergeRequests");
    expect(requests[0]?.body.TargetRepoId).toBe("repo-101");
    expect(requests[0]?.body.Since).toBe("2026-08-21T07:53:00.000Z");
    expect(requests[0]?.authorization).toBe("Bearer token");
  });
});

function context(stream: ScmPollContext["stream"]): ScmPollContext {
  return {
    connection: scmConnection(),
    credential: { accessToken: "token", webhookSecret: "secret" },
    binding: scmBinding(),
    stream,
    cursor: null,
    now: new Date("2026-08-21T08:00:00.000Z"),
  };
}

