import { afterEach, describe, expect, it } from "bun:test";
import {
  createScmAuthenticatedAgentPluginGitSourceResolver,
} from "@multiremi/agent-plugins/scm-git-auth.js";
import {
  createScmGitCredentialEnvironment,
  scmGitCredentialArguments,
} from "@multiremi/agent-plugins/scm-git-environment.js";
import type {
  ResolveAgentPluginGitSourceInput,
  ResolvedAgentPluginGitSource,
} from "@multiremi/agent-plugins/git-import.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

const originalEncryptionKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalEncryptionKey;
  resetMultiremiTestEnv();
});

describe("Agent Plugin SCM Git authentication", () => {
  it("uses the workspace default connection without putting its secret in the URL or Git config", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createScmConnection({
      workspaceId: "local",
      name: "Codebase",
      provider: "codebase",
      mode: "poll",
      accessToken: "jwt:codebase-secret",
    });
    const calls: ResolveAgentPluginGitSourceInput[] = [];
    const resolver = createScmAuthenticatedAgentPluginGitSourceResolver(store, async (input) => {
      calls.push(input);
      return resolvedSource(input.sourceUrl);
    });

    const sourceUrl = "git@code.byted.org:bytedance/codeToWiki.git";
    const resolved = await resolver({ workspaceId: "local", sourceUrl });

    expect(resolved.sourceUrl).toBe(sourceUrl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sourceUrl).toBe("https://code.byted.org/bytedance/codeToWiki.git");
    expect(calls[0]?.gitEnvironment).toMatchObject({
      MULTIREMI_SCM_GIT_USERNAME: "oauth2",
      MULTIREMI_SCM_GIT_PASSWORD: "codebase-secret",
    });
    expect(JSON.stringify({
      url: calls[0]?.sourceUrl,
      args: scmGitCredentialArguments(calls[0]?.gitEnvironment ?? {}),
    })).not.toContain("codebase-secret");
  });

  it("provides credentials to Git through the process environment", () => {
    const env = createScmGitCredentialEnvironment("x-access-token", "github-secret");
    const result = Bun.spawnSync([
      "git",
      ...scmGitCredentialArguments(env),
      "credential",
      "fill",
    ], {
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
      stdin: Buffer.from("url=https://github.com/example/private.git\n\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString("utf8")).toContain("username=x-access-token");
    expect(Buffer.from(result.stdout).toString("utf8")).toContain("password=github-secret");
  });

  it("leaves unrelated public remotes unchanged", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString("base64");
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createScmConnection({
      workspaceId: "local",
      name: "Codebase",
      provider: "codebase",
      mode: "poll",
      accessToken: "codebase-secret",
    });
    const calls: ResolveAgentPluginGitSourceInput[] = [];
    const resolver = createScmAuthenticatedAgentPluginGitSourceResolver(store, async (input) => {
      calls.push(input);
      return resolvedSource(input.sourceUrl);
    });

    await resolver({ workspaceId: "local", sourceUrl: "https://github.com/example/public.git" });

    expect(calls[0]?.sourceUrl).toBe("https://github.com/example/public.git");
    expect(calls[0]?.gitEnvironment).toBeUndefined();
  });
});

function resolvedSource(sourceUrl: string): ResolvedAgentPluginGitSource {
  return {
    sourceUrl,
    sourceRef: "main",
    defaultBranch: "main",
    branches: ["main"],
    sourceRevision: "1234567890abcdef1234567890abcdef12345678",
    candidates: [],
  };
}
