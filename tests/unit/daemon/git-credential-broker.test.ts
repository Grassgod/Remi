import { describe, expect, it } from "bun:test";
import {
  appendGitCredentialBrokerEnv,
  defaultRemiGitCredentialHelperCommand,
  parseGitCredentialProtocolInput,
  preferredHttpsCloneUrl,
  redactGitCredentialError,
  runGitCredentialHelper,
} from "@daemon/agent-runtime/repo/credential-broker.js";

describe("Multiremi Git credential broker", () => {
  it("normalizes the common GitHub and Codebase SSH clone forms to HTTPS", () => {
    expect(preferredHttpsCloneUrl("git@github.com:owner/repo.git"))
      .toBe("https://github.com/owner/repo.git");
    expect(preferredHttpsCloneUrl("ssh://git@code.byted.org/team/repo.git"))
      .toBe("https://code.byted.org/team/repo.git");
    expect(preferredHttpsCloneUrl("ssh://git@host.example:2222/team/repo.git"))
      .toBe("ssh://git@host.example:2222/team/repo.git");
    expect(preferredHttpsCloneUrl("/tmp/local-repo"))
      .toBe("/tmp/local-repo");
  });

  it("installs a process-only helper after clearing local helpers without putting secrets in Git config", () => {
    const env = appendGitCredentialBrokerEnv({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    }, {
      serverUrl: "https://multiremi.example/",
      token: "daemon-secret",
      workspaceId: "wsp_1",
      repositoryUrl: "git@github.com:owner/repo.git",
      helperCommand: "'remi' git-credential",
      fallbackHelpers: ["cache --timeout=60"],
    });

    expect(env.GIT_CONFIG_COUNT).toBe("5");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_CONFIG_VALUE_2).toBe("!'remi' git-credential");
    expect(env.GIT_CONFIG_VALUE_3).toBe("cache --timeout=60");
    expect(env.GIT_CONFIG_KEY_4).toBe("credential.useHttpPath");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(env.MULTIREMI_TOKEN).toBe("daemon-secret");
    expect(Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_VALUE_"))
      .map(([, value]) => value)
      .join("\n"))
      .not.toContain("daemon-secret");
  });

  it("preserves an existing SSH command and only supplies BatchMode by default", () => {
    const custom = "ssh -F /etc/multiremi/ssh.conf -o ProxyCommand=custom-proxy";
    const preserved = appendGitCredentialBrokerEnv({ GIT_SSH_COMMAND: custom }, {
      serverUrl: "https://multiremi.example",
      workspaceId: "wsp_1",
      helperCommand: "'remi' git-credential",
      fallbackHelpers: [],
    });
    const defaulted = appendGitCredentialBrokerEnv({}, {
      serverUrl: "https://multiremi.example",
      workspaceId: "wsp_1",
      helperCommand: "'remi' git-credential",
      fallbackHelpers: [],
    });

    expect(preserved.GIT_SSH_COMMAND).toBe(custom);
    expect(defaulted.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  });

  it("requests a task-scoped JIT credential using the original repository identity", async () => {
    let request: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const output = await runGitCredentialHelper("get", {
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
      env: {
        MULTIREMI_SERVER_URL: "https://multiremi.example",
        MULTIREMI_WORKSPACE_ID: "wsp_1",
        MULTIREMI_TASK_ID: "tsk_1",
        MULTIREMI_TOKEN: "task-token",
        MULTIREMI_GIT_REPOSITORIES_JSON: JSON.stringify(["git@github.com:owner/repo.git"]),
      },
      fetchImpl: (async (url, init) => {
        request = {
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return Response.json({
          repositoryId: "repo_1",
          repositoryUrl: "git@github.com:owner/repo.git",
          cloneUrl: "https://github.com/owner/repo.git",
          username: "x-access-token",
          password: "git-access-token",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });
      }),
    });

    expect(request).not.toBeNull();
    expect(request!.url).toBe("https://multiremi.example/api/daemon/scm/git-credentials");
    expect(request!.headers.get("authorization")).toBe("Bearer task-token");
    expect(request!.body).toMatchObject({
      workspaceId: "wsp_1",
      repositoryUrl: "git@github.com:owner/repo.git",
      protocol: "https",
      host: "github.com",
      path: "owner/repo.git",
    });
    expect(output).toContain("username=x-access-token\n");
    expect(output).toContain("password=git-access-token\n");
    expect(output).toContain("password_expiry_utc=");
  });

  it("rejects credentials returned for a different repository", async () => {
    await expect(runGitCredentialHelper("get", {
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
      env: {
        MULTIREMI_SERVER_URL: "https://multiremi.example",
        MULTIREMI_WORKSPACE_ID: "wsp_1",
      },
      fetchImpl: (async () => Response.json({
        cloneUrl: "https://github.com/other/repo.git",
        username: "user",
        password: "secret",
      })),
    })).rejects.toThrow(/different repository/);
  });

  it("returns no fields so Git can fall back when the repository is not centrally configured", async () => {
    const output = await runGitCredentialHelper("get", {
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
      env: {
        MULTIREMI_SERVER_URL: "https://multiremi.example",
        MULTIREMI_WORKSPACE_ID: "wsp_1",
      },
      fetchImpl: async () => Response.json(
        { error: "repository credential not found" },
        { status: 404 },
      ),
    });
    expect(output).toBe("");
  });

  it("rejects credential-protocol field injection from a compromised upstream", async () => {
    await expect(runGitCredentialHelper("get", {
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
      env: {
        MULTIREMI_SERVER_URL: "https://multiremi.example",
        MULTIREMI_WORKSPACE_ID: "wsp_1",
      },
      fetchImpl: async () => Response.json({
        cloneUrl: "https://github.com/owner/repo.git",
        username: "user\npassword=attacker",
        password: "secret",
      }),
    })).rejects.toThrow(/invalid credential field/);
  });

  it("times out deterministically and never includes credential values in errors", async () => {
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("password=should-not-leak")), { once: true });
    }));
    await expect(runGitCredentialHelper("get", {
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
      env: {
        MULTIREMI_SERVER_URL: "https://multiremi.example",
        MULTIREMI_WORKSPACE_ID: "wsp_1",
      },
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    })).rejects.toThrow("Git credential broker timed out after 5ms");
    expect(redactGitCredentialError("https://user:pass@example.test password=abc token:xyz"))
      .toBe("https://[redacted]@example.test password=[redacted] token=[redacted]");
  });

  it("parses Git's protocol and builds source/compiled helper commands", () => {
    expect(parseGitCredentialProtocolInput("protocol=https\nhost=example.test\npath=a/b.git\n\n"))
      .toEqual({ protocol: "https", host: "example.test", path: "a/b.git" });
    expect(defaultRemiGitCredentialHelperCommand(["/usr/bin/remi"], "/usr/bin/remi"))
      .toBe("'/usr/bin/remi' git-credential");
    expect(defaultRemiGitCredentialHelperCommand(["/usr/bin/bun", "/repo/apps/remi/main.ts"], "/usr/bin/bun"))
      .toBe("'/usr/bin/bun' '/repo/apps/remi/main.ts' git-credential");
  });
});
