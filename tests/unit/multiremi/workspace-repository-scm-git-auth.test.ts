import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type {
  MultiremiScmConnection,
  MultiremiScmRepositoryBinding,
} from "@multiremi/contracts/types.js";
import {
  createScmAwareGitRemoteInspector,
  WorkspaceRepositoryError,
} from "@multiremi/api/helpers/repositories.js";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

type ScmInspectorStore = Pick<
  MultiremiStore,
  "listScmConnections" | "getScmConnectionCredential" | "findScmRepositoryBindingByUrl"
>;

const originalEncryptionKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;

afterEach(() => {
  resetMultiremiTestEnv();
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("workspace repository SCM Git authentication", () => {
  it("inspects a matching SSH remote over HTTPS with credentials only in the process environment", async () => {
    const accessToken = "github-test-secret";
    const connection = scmConnection({ accessTokenSet: true, isDefault: true });
    const store = scmStore([connection], { [connection.id]: accessToken });
    let command: string[] = [];
    let environment: Record<string, string | undefined> = {};
    const spawn = spyOn(Bun, "spawn").mockImplementation(((args: string[], options: {
      env: Record<string, string | undefined>;
    }) => {
      command = [...args];
      environment = options.env;
      return {
        stdout: new Response([
          "ref: refs/heads/main\tHEAD",
          "1234567890abcdef\trefs/heads/main",
        ].join("\n")).body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as typeof Bun.spawn);

    try {
      const result = await createScmAwareGitRemoteInspector(store, "workspace_one")(
        "git@github.com:acme/private.git",
      );

      expect(result).toEqual({ default_branch: "main", branches: ["main"] });
      expect(command.slice(-5)).toEqual([
        "ls-remote",
        "--symref",
        "https://github.com/acme/private.git",
        "HEAD",
        "refs/heads/*",
      ]);
      expect(command.join("\0")).not.toContain(accessToken);
      expect(environment).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        MULTIREMI_SCM_GIT_USERNAME: "x-access-token",
        MULTIREMI_SCM_GIT_PASSWORD: accessToken,
      });
    } finally {
      spawn.mockRestore();
    }
  });

  it("falls back to the original remote when no token-backed connection matches its host", async () => {
    const connection = scmConnection({
      id: "scm_codebase",
      provider: "codebase",
      baseUrl: "https://code.byted.org",
      accessTokenSet: true,
      isDefault: true,
    });
    const store = scmStore([connection], { [connection.id]: "codebase-test-secret" });
    const calls: Array<{ url: string; environment?: Record<string, string> }> = [];
    const inspect = createScmAwareGitRemoteInspector(store, "workspace_one", async (url, gitEnvironment) => {
      calls.push({ url, environment: gitEnvironment });
      return { default_branch: "main", branches: ["main"] };
    });

    await inspect("git@github.com:acme/public.git");

    expect(calls).toEqual([{
      url: "git@github.com:acme/public.git",
      environment: undefined,
    }]);
  });

  it("prefers an explicit repository binding over the default matching connection", async () => {
    const defaultConnection = scmConnection({
      id: "scm_default",
      accessTokenSet: true,
      isDefault: true,
    });
    const boundConnection = scmConnection({
      id: "scm_bound",
      accessTokenSet: true,
      isDefault: false,
    });
    const store = scmStore(
      [defaultConnection, boundConnection],
      {
        [defaultConnection.id]: "default-test-secret",
        [boundConnection.id]: "bound-test-secret",
      },
      { connectionId: boundConnection.id } as MultiremiScmRepositoryBinding,
    );
    let environment: Record<string, string> | undefined;
    const inspect = createScmAwareGitRemoteInspector(store, "workspace_one", async (_url, gitEnvironment) => {
      environment = gitEnvironment;
      return { default_branch: "main", branches: ["main"] };
    });

    await inspect("git@github.com:acme/private.git");

    expect(environment?.MULTIREMI_SCM_GIT_PASSWORD).toBe("bound-test-secret");
  });

  it("returns a conflict when multiple token-backed connections match without a binding or default", async () => {
    const first = scmConnection({ id: "scm_first", accessTokenSet: true, isDefault: false });
    const second = scmConnection({ id: "scm_second", accessTokenSet: true, isDefault: false });
    const store = scmStore(
      [first, second],
      { [first.id]: "first-test-secret", [second.id]: "second-test-secret" },
    );
    const inspect = createScmAwareGitRemoteInspector(store, "workspace_one", async () => {
      throw new Error("inspector must not run for an ambiguous connection");
    });

    const inspection = inspect("git@github.com:acme/private.git");

    await expect(inspection).rejects.toBeInstanceOf(WorkspaceRepositoryError);
    await expect(inspection).rejects.toMatchObject({ status: 409 });
  });

  it("applies workspace SCM authentication to inspect, import, update, and default-branch backfill routes", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 25).toString("base64");
    const accessToken = "route-test-secret";
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_legacy",
        name: "legacy",
        url: "git@github.com:acme/legacy.git",
        source: "github",
        default_branch: null,
      }],
    });
    store.createScmConnection({
      workspaceId: "local",
      name: "GitHub",
      provider: "github",
      mode: "poll",
      accessToken,
    });
    const calls: Array<{ url: string; environment?: Record<string, string> }> = [];
    const app = createMultiremiApp({
      store,
      inspectGitRemoteRepository: async (url, gitEnvironment) => {
        calls.push({ url, environment: gitEnvironment });
        return { default_branch: "main", branches: ["main", "release"] };
      },
    });

    const listed = await app.request("/api/workspaces/local/repos");
    expect(listed.status).toBe(200);

    const inspected = await app.request("/api/workspaces/local/repos/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "git@github.com:acme/inspected.git" }),
    });
    expect(inspected.status).toBe(200);

    const imported = await app.request("/api/workspaces/local/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "git@github.com:acme/imported.git" }),
    });
    expect(imported.status).toBe(201);
    const importedBody = await imported.json() as { repository: { id: string } };

    const updated = await app.request(`/api/workspaces/local/repos/${importedBody.repository.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_branch: "release" }),
    });
    expect(updated.status).toBe(200);

    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/acme/legacy.git",
      "https://github.com/acme/inspected.git",
      "https://github.com/acme/imported.git",
      "https://github.com/acme/imported.git",
    ]);
    expect(calls.every((call) =>
      call.environment?.MULTIREMI_SCM_GIT_USERNAME === "x-access-token"
      && call.environment.MULTIREMI_SCM_GIT_PASSWORD === accessToken
    )).toBe(true);
  });
});

function scmConnection(overrides: Partial<MultiremiScmConnection> = {}): MultiremiScmConnection {
  return {
    id: "scm_github",
    workspaceId: "workspace_one",
    name: "GitHub",
    provider: "github",
    mode: "poll",
    baseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
    enabled: true,
    pollIntervalSeconds: 60,
    repositoryScope: "all",
    isDefault: false,
    accessTokenSet: false,
    accessTokenHint: null,
    webhookSecretSet: false,
    webhookSecretHint: null,
    verificationStatus: "unverified",
    verifiedAt: null,
    verificationIdentity: null,
    verifiedRepositoryCount: 0,
    verifiedRepositoryTotal: 0,
    verificationErrorCode: null,
    verificationError: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function scmStore(
  connections: MultiremiScmConnection[],
  accessTokens: Record<string, string>,
  binding: MultiremiScmRepositoryBinding | null = null,
): ScmInspectorStore {
  return {
    listScmConnections: ({ workspaceId, enabled } = {}) => connections.filter((connection) =>
      (workspaceId == null || connection.workspaceId === workspaceId)
      && (enabled == null || connection.enabled === enabled)
    ),
    getScmConnectionCredential: (connectionId) => ({
      accessToken: accessTokens[connectionId] ?? null,
      webhookSecret: null,
    }),
    findScmRepositoryBindingByUrl: () => binding,
  } as ScmInspectorStore;
}
