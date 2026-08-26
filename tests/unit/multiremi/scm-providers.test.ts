import { afterEach, describe, expect, it } from "bun:test";
import { CODEBASE_SCM_CAPABILITIES, GITHUB_SCM_CAPABILITIES } from "@multiremi/scm/capabilities.js";
import { CodebaseScmProviderAdapter } from "@multiremi/scm/codebase.js";
import { GitHubScmProviderAdapter } from "@multiremi/scm/github.js";
import { ScmHttpError } from "@multiremi/scm/http.js";
import { deriveCanonicalCandidates } from "@multiremi/scm/reconcile.js";
import { ScmStreamUnavailableError, type ScmPollContext } from "@multiremi/scm/types.js";
import { scmBinding, scmConnection } from "./scm-test-helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SCM provider adapters", () => {
  it("publishes provider differences instead of pretending webhook parity", () => {
    expect(GITHUB_SCM_CAPABILITIES.streams.pipelines.webhook).toBe(true);
    expect(GITHUB_SCM_CAPABILITIES.streams.pipelines.limitations.join(" ")).toContain("workflow runs only");
    expect(GITHUB_SCM_CAPABILITIES.streams.pipelines.limitations.join(" ")).toContain("check_run");
    expect(CODEBASE_SCM_CAPABILITIES.streams.pipelines.poll).toBe(true);
    expect(CODEBASE_SCM_CAPABILITIES.streams.pipelines.webhook).toBe(false);
    expect(GITHUB_SCM_CAPABILITIES.supportsDeleteTombstones).toBe(false);
    expect(CODEBASE_SCM_CAPABILITIES.supportsDeleteTombstones).toBe(false);
  });

  it("polls GitHub pull requests with authenticated pagination", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    let heartbeats = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify([{
        id: 9001,
        number: 42,
        title: "Ship it",
        body: "Closes MUL-42",
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

    const result = await new GitHubScmProviderAdapter().poll({
      ...context("change_requests"),
      heartbeat: () => { heartbeats += 1; },
    });
    expect(result.done).toBe(true);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.payload).toMatchObject({
      body: "Closes MUL-42",
      state: "open",
      source_branch: "feature",
      target_branch: "main",
      head_sha: "abc",
      base_sha: "def",
    });
    expect(requests[0]?.url).toContain("/repos/acme/widgets/pulls");
    expect(requests[0]?.url).toContain("per_page=100");
    expect(requests[0]?.authorization).toBe("Bearer token");
    expect(heartbeats).toBe(2);
  });

  it("classifies unavailable GitHub pull-request and Actions endpoints", async () => {
    const cases = [
      { stream: "change_requests" as const, status: 404, path: "/repos/acme/widgets/pulls" },
      { stream: "reviews" as const, status: 410, path: "/repos/acme/widgets/pulls" },
      { stream: "pipelines" as const, status: 404, path: "/repos/acme/widgets/actions/runs" },
    ];
    const adapter = new GitHubScmProviderAdapter();

    for (const entry of cases) {
      globalThis.fetch = (async (_input, _init) => new Response(JSON.stringify({ message: "disabled" }), {
        status: entry.status,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
      const error = await capturedError(adapter.poll(context(entry.stream)));
      expect(error).toBeInstanceOf(ScmStreamUnavailableError);
      expect(error).toMatchObject({
        provider: "GitHub",
        stream: entry.stream,
        status: entry.status,
        url: entry.path,
      });
    }
  });

  it("keeps a GitHub repository 404 as a hard error but classifies a missing default branch", async () => {
    const adapter = new GitHubScmProviderAdapter();
    globalThis.fetch = (async (_input, _init) => new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    const repositoryError = await capturedError(adapter.poll(context("default_branch")));
    expect(repositoryError).toBeInstanceOf(ScmHttpError);
    expect(repositoryError).not.toBeInstanceOf(ScmStreamUnavailableError);

    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/repos/acme/widgets") {
        return new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "Gone" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const branchError = await capturedError(adapter.poll(context("default_branch")));
    expect(branchError).toBeInstanceOf(ScmStreamUnavailableError);
    expect(branchError).toMatchObject({
      stream: "default_branch",
      status: 410,
      url: "/repos/acme/widgets/branches/main",
      reason: "default branch unavailable",
    });
  });

  it("continues GitHub comments when only issue comments are unavailable", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/issues/comments")) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([{ id: 7, body: "review comment" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const page = await new GitHubScmProviderAdapter().poll(context("comments"));
    expect(requests).toEqual([
      "/repos/acme/widgets/issues/comments",
      "/repos/acme/widgets/pulls/comments",
    ]);
    expect(page.done).toBe(true);
    expect(page.observations.map((entry) => entry.externalId)).toEqual(["7"]);
  });

  it("classifies GitHub comments only when issue and review comments are unavailable", async () => {
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      const status = path.endsWith("/issues/comments") ? 404 : 410;
      return new Response(JSON.stringify({ message: "disabled" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const error = await capturedError(new GitHubScmProviderAdapter().poll(context("comments")));
    expect(error).toBeInstanceOf(ScmStreamUnavailableError);
    expect(error).toMatchObject({
      stream: "comments",
      status: 410,
      url: "/repos/acme/widgets/pulls/comments",
      reason: "issue and review comments unavailable",
    });
  });

  it("uses one logical identity for GitHub workflow runs from polling and webhooks", async () => {
    const workflowRun = {
      id: 501,
      run_attempt: 2,
      name: "build",
      status: "completed",
      conclusion: "success",
      head_sha: "abc",
      head_branch: "main",
      created_at: "2026-08-21T07:50:00.000Z",
      updated_at: "2026-08-21T07:59:00.000Z",
    };
    globalThis.fetch = (async (_input, _init) => new Response(JSON.stringify({ workflow_runs: [workflowRun] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    const adapter = new GitHubScmProviderAdapter();
    const page = await adapter.poll(context("pipelines"));
    const observation = page.observations[0]!;
    const polled = deriveCanonicalCandidates(observation, null)[0]!;
    const webhook = adapter.parseWebhook({
      connection: scmConnection(),
      credential: { accessToken: "token", webhookSecret: "secret" },
      headers: { "x-github-event": "workflow_run", "x-github-delivery": "delivery-1" },
      rawBody: "{}",
      body: {
        repository: { id: 101, name: "widgets", owner: { login: "acme" } },
        workflow_run: workflowRun,
      },
      observedAt: "2026-08-21T08:00:00.000Z",
    }).candidates[0]!;

    expect(webhook.subjectId).toBe("workflow_run:501:2");
    expect(webhook.subjectId).toBe(polled.subjectId);
    expect(webhook.logicalVersion).toBe(polled.logicalVersion);
    expect(webhook.payload.branch).toBe("main");

    const rerun = adapter.parseWebhook({
      connection: scmConnection(),
      credential: { accessToken: "token", webhookSecret: "secret" },
      headers: { "x-github-event": "workflow_run", "x-github-delivery": "delivery-2" },
      rawBody: "{}",
      body: {
        repository: { id: 101, name: "widgets", owner: { login: "acme" } },
        workflow_run: { ...workflowRun, run_attempt: 3, updated_at: "2026-08-21T08:05:00.000Z" },
      },
      observedAt: "2026-08-21T08:06:00.000Z",
    }).candidates[0]!;
    expect(rerun.subjectId).toBe("workflow_run:501:3");
    expect(rerun.subjectId).not.toBe(webhook.subjectId);
  });

  it("ignores GitHub Checks instead of creating a second pipeline identity", () => {
    const parsed = new GitHubScmProviderAdapter().parseWebhook({
      connection: scmConnection(),
      credential: { accessToken: "token", webhookSecret: "secret" },
      headers: { "x-github-event": "check_run", "x-github-delivery": "delivery-check" },
      rawBody: "{}",
      body: {
        repository: { id: 101, name: "widgets", owner: { login: "acme" } },
        check_run: {
          id: 7001,
          name: "build",
          status: "completed",
          conclusion: "success",
          head_sha: "abc",
        },
      },
      observedAt: "2026-08-21T08:00:00.000Z",
    });
    expect(parsed.candidates).toEqual([]);
    expect(parsed.ignoredReason).toContain("workflow_run only");
  });

  it("filters ordinary GitHub issue comments in webhook and polling ingestion", async () => {
    globalThis.fetch = (async (_input, _init) => new Response(JSON.stringify([
      { id: 1, html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1", body: "issue" },
      { id: 2, html_url: "https://github.com/acme/widgets/pull/8#issuecomment-2", body: "pull request" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const adapter = new GitHubScmProviderAdapter();
    const page = await adapter.poll(context("comments"));
    expect(page.observations.map((entry) => entry.externalId)).toEqual(["2"]);

    const parsed = adapter.parseWebhook({
      connection: scmConnection(),
      credential: { accessToken: "token", webhookSecret: "secret" },
      headers: { "x-github-event": "issue_comment" },
      rawBody: "{}",
      body: {
        action: "created",
        repository: { id: 101, name: "widgets", owner: { login: "acme" } },
        issue: { id: 7 },
        comment: { id: 1, body: "issue" },
      },
      observedAt: "2026-08-21T08:00:00.000Z",
    });
    expect(parsed.candidates).toHaveLength(0);
    expect(parsed.ignoredReason).toContain("not attached to a pull request");
  });

  it("paginates every GitHub review and resumes pull-request pages beyond the old cap", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.pathname.endsWith("/pulls")) {
        return new Response(JSON.stringify([{
          id: 9001,
          number: 42,
          updated_at: "2026-08-21T07:59:00.000Z",
        }]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: `<${url.origin}${url.pathname}?page=12>; rel="next"`,
          },
        });
      }
      const reviewPage = Number(url.searchParams.get("page"));
      const reviews = reviewPage === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, state: "approved" }))
        : [{ id: 101, state: "approved" }];
      return new Response(JSON.stringify(reviews), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...(reviewPage === 1 ? { Link: `<${url.origin}${url.pathname}?page=2>; rel="next"` } : {}),
        },
      });
    }) as typeof fetch;

    const result = await new GitHubScmProviderAdapter().poll({
      ...context("reviews"),
      cursor: syncCursor("reviews", { page: 11 }),
    });
    expect(result.observations).toHaveLength(101);
    expect(result.cursor).toEqual({ page: 12 });
    expect(requests.some((url) => url.includes("/pulls?state=all") && url.includes("page=11"))).toBe(true);
    expect(requests.some((url) => url.includes("/pulls/42/reviews") && url.includes("page=2"))).toBe(true);
  });

  it("continues GitHub pipeline pagination when updated timestamps are non-monotonic", async () => {
    const oldRuns = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      updated_at: "2026-08-20T00:00:00.000Z",
    }));
    globalThis.fetch = (async (_input, _init) => new Response(JSON.stringify({ workflow_runs: oldRuns }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    const result = await new GitHubScmProviderAdapter().poll({
      ...context("pipelines"),
      cursor: syncCursor("pipelines", { page: 1 }, "2026-08-21T07:55:00.000Z"),
    });
    expect(result.observations).toHaveLength(0);
    expect(result.done).toBe(false);
    expect(result.cursor).toEqual({ page: 2 });
  });

  it("polls Codebase merge requests in updated order without a created-since filter", async () => {
    const requests: Array<{ action: string | null; body: Record<string, unknown>; authorization: string | null }> = [];
    let heartbeats = 0;
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
            Description: "Fixes MUL-9",
            Status: "merged",
            SourceBranchName: "feature",
            TargetBranchName: "main",
            TargetCommitId: "base-commit",
            UpdatedAt: "2026-08-21T07:58:00.000Z",
            MergedAt: "2026-08-21T07:58:00.000Z",
            MergeCommitId: "abc",
            Versions: [
              { Number: 1, SourceCommitId: "commit-1" },
              { Number: 3, SourceCommitId: "commit-3" },
              { Number: 2, SourceCommitId: "commit-2" },
            ],
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
        consecutiveFailures: 0,
        suspendedUntil: null,
        leaseOwner: null,
        leaseUntil: null,
        leaseToken: null,
        updatedAt: "2026-08-21T07:55:00.000Z",
      },
      heartbeat: () => { heartbeats += 1; },
    };
    const result = await new CodebaseScmProviderAdapter().poll(codebaseContext);
    expect(result.observations[0]?.payload).toMatchObject({
      body: "Fixes MUL-9",
      state: "merged",
      source_branch: "feature",
      target_branch: "main",
      head_sha: "commit-3",
      base_sha: "base-commit",
      merge_sha: "abc",
    });
    expect(requests[0]?.action).toBe("ListRepoMergeRequests");
    expect(requests[0]?.body.TargetRepoId).toBe("repo-101");
    expect(requests[0]?.body).not.toHaveProperty("Since");
    expect(requests[0]?.body.SortBy).toBe("UpdatedAt");
    expect(requests[0]?.body.SortOrder).toBe("desc");
    expect(requests[0]?.body.Selector).toEqual({
      URL: true,
      ReviewStatus: true,
      CheckRunSummaryStatus: true,
      Branch: true,
      Version: true,
    });
    expect(requests[0]?.authorization).toBe("Bearer token");
    expect(heartbeats).toBe(2);
  });

  it("filters Codebase merge requests older than the overlap watermark and stops pagination", async () => {
    globalThis.fetch = (async (_input, _init) => new Response(JSON.stringify({
      ResponseMetadata: { Action: "ListRepoMergeRequests" },
      Result: {
        MergeRequests: [{
          Id: "mr-old",
          Number: 8,
          CreatedAt: "2026-08-20T00:00:00.000Z",
          UpdatedAt: "2026-08-21T07:52:59.000Z",
        }],
        TotalCount: 200,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await new CodebaseScmProviderAdapter().poll(codebaseContext(
      "change_requests",
      syncCursor("change_requests", { page: 1 }, "2026-08-21T07:55:00.000Z"),
    ));

    expect(result.observations).toHaveLength(0);
    expect(result.cursor).toBeNull();
    expect(result.done).toBe(true);
  });

  it("observes old Codebase merge requests updated after the overlap watermark", async () => {
    globalThis.fetch = (async (_input, _init) => new Response(JSON.stringify({
      ResponseMetadata: { Action: "ListRepoMergeRequests" },
      Result: {
        MergeRequests: [{
          Id: "mr-updated",
          Number: 7,
          Title: "Merged after creation",
          Status: "merged",
          CreatedAt: "2026-08-01T00:00:00.000Z",
          UpdatedAt: "2026-08-21T07:58:00.000Z",
          MergedAt: "2026-08-21T07:58:00.000Z",
        }],
        TotalCount: 1,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

    const result = await new CodebaseScmProviderAdapter().poll(codebaseContext(
      "change_requests",
      syncCursor("change_requests", { page: 1 }, "2026-08-21T07:55:00.000Z"),
    ));

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.externalId).toBe("mr-updated");
    expect(result.observations[0]?.payload.state).toBe("merged");
  });

  it("filters related Codebase merge requests by update time before polling comments", async () => {
    const requests: Array<{ action: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const action = new URL(String(input)).searchParams.get("Action");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ action, body });
      const result = action === "ListRepoMergeRequests"
        ? {
            MergeRequests: [
              { Id: "mr-new", UpdatedAt: "2026-08-21T07:54:00.000Z" },
              { Id: "mr-old", UpdatedAt: "2026-08-21T07:52:59.000Z" },
            ],
            TotalCount: 200,
          }
        : { Threads: [] };
      return new Response(JSON.stringify({ ResponseMetadata: { Action: action }, Result: result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await new CodebaseScmProviderAdapter().poll(codebaseContext(
      "comments",
      syncCursor("comments", { page: 1 }, "2026-08-21T07:55:00.000Z"),
    ));

    expect(requests[0]?.body).not.toHaveProperty("Since");
    expect(requests[0]?.body).toMatchObject({ SortBy: "UpdatedAt", SortOrder: "desc" });
    expect(requests.filter((request) => request.action === "ListThreads")).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ CommentableId: "mr-new" }) }),
    ]);
    expect(result.cursor).toBeNull();
    expect(result.done).toBe(true);
  });

  it("resumes Codebase related-MR and pipeline pages without timestamp cutoffs", async () => {
    const requests: Array<{ action: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const action = url.searchParams.get("Action");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ action, body });
      const result = action === "ListRepoMergeRequests"
        ? { MergeRequests: [{ Id: "mr-1101", Number: 1101 }], TotalCount: 1200 }
        : action === "ListThreads"
          ? { Threads: [] }
          : {
              CheckRuns: [{ Id: "run-old", UpdatedAt: "2026-08-20T00:00:00.000Z" }],
              TotalCount: 101,
            };
      return new Response(JSON.stringify({ ResponseMetadata: { Action: action }, Result: result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const codebaseConnection = scmConnection({
      provider: "codebase",
      baseUrl: "https://code.byted.org",
      apiBaseUrl: "https://codebase-api.byted.org/v2/",
    });
    const binding = scmBinding({ externalId: "repo-101", repositoryUrl: "https://code.byted.org/acme/widgets.git" });
    const adapter = new CodebaseScmProviderAdapter();

    const comments = await adapter.poll({
      ...context("comments"),
      connection: codebaseConnection,
      binding,
      cursor: syncCursor("comments", { page: 11 }),
    });
    expect(comments.cursor).toEqual({ page: 12 });
    expect(requests.find((entry) => entry.action === "ListRepoMergeRequests")?.body).toMatchObject({
      PageNumber: 11,
      SortBy: "UpdatedAt",
      SortOrder: "desc",
    });

    const pipelines = await adapter.poll({
      ...context("pipelines"),
      connection: codebaseConnection,
      binding,
      cursor: syncCursor("pipelines", { page: 1 }, "2026-08-21T07:55:00.000Z"),
    });
    expect(pipelines.observations).toHaveLength(0);
    expect(pipelines.cursor).toEqual({ page: 2 });
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

function codebaseContext(
  stream: ScmPollContext["stream"],
  cursor: ScmPollContext["cursor"] = null,
): ScmPollContext {
  return {
    ...context(stream),
    connection: scmConnection({
      provider: "codebase",
      baseUrl: "https://code.byted.org",
      apiBaseUrl: "https://codebase-api.byted.org/v2/",
    }),
    binding: scmBinding({
      externalId: "repo-101",
      repositoryUrl: "https://code.byted.org/acme/widgets.git",
    }),
    cursor,
  };
}

function syncCursor(
  stream: ScmPollContext["stream"],
  cursor: Record<string, unknown>,
  watermark: string | null = null,
): NonNullable<ScmPollContext["cursor"]> {
  return {
    connectionId: "scm_1",
    repositoryId: "repo_1",
    stream,
    cursor,
    watermark,
    baselineCompletedAt: "2026-08-21T07:00:00.000Z",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    consecutiveFailures: 0,
    suspendedUntil: null,
    leaseOwner: null,
    leaseUntil: null,
    leaseToken: null,
    updatedAt: "2026-08-21T07:55:00.000Z",
  };
}

async function capturedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected promise to reject");
  } catch (error) {
    return error;
  }
}
