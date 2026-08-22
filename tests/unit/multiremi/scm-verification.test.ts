import { describe, expect, it } from "bun:test";
import { createScmConnectionVerifier } from "@multiremi/scm/verification.js";
import { scmBinding, scmConnection } from "./scm-test-helpers.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe("SCM connection verification", () => {
  it("verifies GitHub identity and repository access without exposing the token", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const verifier = createScmConnectionVerifier((async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/user")) return Response.json({ login: "octocat" });
      return Response.json({ id: 42, full_name: "acme/widgets" });
    }) as unknown as typeof fetch);

    const result = await verifier({
      connection: scmConnection(),
      credential: { accessToken: "github-secret", webhookSecret: null },
      bindings: [scmBinding()],
    });
    expect(result).toEqual({
      status: "valid",
      verifiedAt: expect.any(String),
      identity: "octocat",
      repositoryCount: 1,
      repositoryTotal: 1,
      errorCode: null,
      error: null,
    });
    expect(requests).toEqual([
      { url: "https://api.github.com/user", authorization: "Bearer github-secret" },
      { url: "https://api.github.com/repos/acme/widgets", authorization: "Bearer github-secret" },
    ]);
    expect(JSON.stringify(result)).not.toContain("github-secret");
  });

  it("distinguishes invalid credentials from partial repository access", async () => {
    const invalid = createScmConnectionVerifier(
      (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    );
    expect(await invalid({
      connection: scmConnection(),
      credential: { accessToken: "bad-token", webhookSecret: null },
      bindings: [scmBinding()],
    })).toMatchObject({
      status: "invalid",
      errorCode: "authentication_failed",
      repositoryCount: 0,
      repositoryTotal: 1,
    });

    const partial = createScmConnectionVerifier((async (input: FetchInput) => {
      return String(input).endsWith("/user")
        ? Response.json({ login: "octocat" })
        : new Response("missing", { status: 404 });
    }) as unknown as typeof fetch);
    expect(await partial({
      connection: scmConnection(),
      credential: { accessToken: "valid-token", webhookSecret: null },
      bindings: [scmBinding()],
    })).toMatchObject({
      status: "partial",
      identity: "octocat",
      errorCode: "repository_not_found",
      repositoryCount: 0,
      repositoryTotal: 1,
    });
  });

  it("uses Codebase user and repository actions with its JWT credential form", async () => {
    const actions: string[] = [];
    const headers: Array<string | null> = [];
    const verifier = createScmConnectionVerifier((async (input: FetchInput, init?: FetchInit) => {
      const url = new URL(String(input));
      const action = url.searchParams.get("Action") ?? "";
      actions.push(action);
      headers.push(new Headers(init?.headers).get("x-code-user-jwt"));
      if (action === "GetCurrentUser") {
        return Response.json({ ResponseMetadata: {}, Result: { User: { Username: "alice" } } });
      }
      return Response.json({ ResponseMetadata: {}, Result: { Repository: { Id: "repo-1" } } });
    }) as unknown as typeof fetch);

    const result = await verifier({
      connection: scmConnection({
        provider: "codebase",
        baseUrl: "https://code.byted.org",
        apiBaseUrl: "https://codebase-api.byted.org/v2",
      }),
      credential: { accessToken: "jwt:codebase-secret", webhookSecret: null },
      bindings: [scmBinding({ repositoryUrl: "git@code.byted.org:acme/widgets.git" })],
    });
    expect(result).toMatchObject({ status: "valid", identity: "alice", repositoryCount: 1 });
    expect(actions).toEqual(["GetCurrentUser", "GetRepository"]);
    expect(headers).toEqual(["codebase-secret", "codebase-secret"]);
  });

  it("verifies Codebase bearer PATs through repository access", async () => {
    const actions: string[] = [];
    const authorizations: Array<string | null> = [];
    const verifier = createScmConnectionVerifier((async (input: FetchInput, init?: FetchInit) => {
      const url = new URL(String(input));
      actions.push(url.searchParams.get("Action") ?? "");
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ ResponseMetadata: {}, Result: { Repository: { Id: "repo-1" } } });
    }) as unknown as typeof fetch);

    const result = await verifier({
      connection: scmConnection({
        provider: "codebase",
        baseUrl: "https://code.byted.org",
        apiBaseUrl: "https://codebase-api.byted.org/v2",
      }),
      credential: { accessToken: "code_pat_secret", webhookSecret: null },
      bindings: [scmBinding({ repositoryUrl: "git@code.byted.org:acme/widgets.git" })],
    });

    expect(result).toMatchObject({
      status: "valid",
      identity: null,
      repositoryCount: 1,
      repositoryTotal: 1,
    });
    expect(actions).toEqual(["GetRepository"]);
    expect(authorizations).toEqual(["Bearer code_pat_secret"]);
  });

  it("rejects a Codebase bearer PAT when every repository denies authentication", async () => {
    const verifier = createScmConnectionVerifier(
      (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    );

    const result = await verifier({
      connection: scmConnection({
        provider: "codebase",
        baseUrl: "https://code.byted.org",
        apiBaseUrl: "https://codebase-api.byted.org/v2",
      }),
      credential: { accessToken: "bad-codebase-pat", webhookSecret: null },
      bindings: [scmBinding({ repositoryUrl: "git@code.byted.org:acme/widgets.git" })],
    });

    expect(result).toMatchObject({
      status: "invalid",
      errorCode: "authentication_failed",
      repositoryCount: 0,
      repositoryTotal: 1,
    });
  });

  it("does not report an untested Codebase bearer PAT as valid", async () => {
    let called = false;
    const verifier = createScmConnectionVerifier((async () => {
      called = true;
      throw new Error("unexpected request");
    }) as unknown as typeof fetch);

    const result = await verifier({
      connection: scmConnection({
        provider: "codebase",
        baseUrl: "https://code.byted.org",
        apiBaseUrl: "https://codebase-api.byted.org/v2",
      }),
      credential: { accessToken: "code_pat_secret", webhookSecret: null },
      bindings: [],
    });

    expect(result).toMatchObject({
      status: "partial",
      errorCode: "repository_verification_required",
      repositoryCount: 0,
      repositoryTotal: 0,
    });
    expect(called).toBe(false);
  });
});
