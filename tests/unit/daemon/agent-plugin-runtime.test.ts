import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { AgentPluginCache } from "@daemon/agent-runtime/agent-plugins/cache.js";
import {
  AgentPluginRuntimeReconciler,
  pluginBlocked,
  pluginSetupRequired,
} from "@daemon/agent-runtime/agent-plugins/reconciler.js";
import {
  cleanupNonIssueTaskPluginRuntime,
  cleanupTaskPluginRuntime,
  materializeTaskPlugins,
  prepareCodexPluginReadinessRuntime,
  resolveTaskPluginRuntimeBase,
} from "@daemon/agent-runtime/agent-plugins/materialize.js";
import {
  installCodexPluginHome,
  seedCodexHomeFromBase,
  type CodexPluginCommand,
} from "@daemon/agent-runtime/agent-plugins/codex-home.js";
import type { AgentPluginSnapshot, RuntimePluginState } from "@daemon/agent-runtime/agent-plugins/types.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import {
  agentPluginArtifactSpecFromWire,
  agentPluginDesiredFromWire,
  runtimePluginStateReport,
} from "@daemon/agent-runtime/agent-plugins/wire.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()!;
    makeWritableSync(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentPluginCache canonical bundle", () => {
  it("authenticates, verifies raw bytes and every file, then deduplicates by digest", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let fetches = 0;
    let requestedUrl = "";
    let authorization = "";
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      serverUrl: "https://multiremi.example/api",
      getAuthToken: () => "daemon-token",
      fetch: async (input, init) => {
        fetches++;
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return artifactResponse(artifact.bytes);
      },
    });
    const snapshot = makeSnapshot("claude", artifact.digest);

    const [first, second] = await Promise.all([
      cache.ensure(snapshot),
      cache.ensure(snapshot),
    ]);

    expect(first).toBe(second);
    expect(fetches).toBe(1);
    expect(requestedUrl).toBe("https://multiremi.example/api/daemon/agent-plugin-artifacts/abc");
    expect(authorization).toBe("Bearer daemon-token");
    expect(readFileSync(join(first, "skills", "demo", "SKILL.md"), "utf8")).toBe("# Demo\n");
    expect(statSync(join(first, "skills", "demo", "run.sh")).mode & 0o222).toBe(0);
    expect(await cache.getReadyPath(snapshot)).toBe(first);
  });

  it("rejects an inner file whose declared digest does not match its bytes", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude", { corruptFileDigest: true });
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };

    await expect(cache.ensure(snapshot)).rejects.toMatchObject({
      code: "plugin_artifact_file_digest_mismatch",
      retryKind: "blocked",
    });
    expect(await cache.getReadyPath(snapshot)).toBeNull();
  });

  it("rejects a bundle path that is declared as both a file and a directory", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude", { pathCollision: true });
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };

    await expect(cache.ensure(snapshot)).rejects.toMatchObject({
      code: "plugin_artifact_path_collision",
      retryKind: "blocked",
    });
  });

  it("uses a cross-instance digest lock so two daemon callers download once", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let fetches = 0;
    let releaseFetch!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => { releaseFetch = resolveBlocked; });
    const fetchArtifact = async () => {
      fetches++;
      await blocked;
      return artifactResponse(artifact.bytes);
    };
    const options = {
      root: join(root, "cache"),
      fetch: fetchArtifact,
      lockPollMs: 1,
      lockWaitMs: 2_000,
    };
    const firstCache = new AgentPluginCache(options);
    const secondCache = new AgentPluginCache(options);
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };

    const first = firstCache.ensure(snapshot);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    const second = secondCache.ensure(snapshot);
    releaseFetch();

    expect(await first).toBe(await second);
    expect(fetches).toBe(1);
  });

  it("times out an artifact fetch and aborts its transport signal", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let transportSignal: AbortSignal | null = null;
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      downloadTimeoutMs: 15,
      fetch: async (_input, init) => {
        transportSignal = init?.signal ?? null;
        return await new Promise<Response>(() => {});
      },
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };

    await expect(cache.ensure(snapshot)).rejects.toMatchObject({
      code: "plugin_download_timeout",
      retryKind: "transient",
    });
    expect((transportSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(await cache.getReadyPath(snapshot)).toBeNull();
  });

  it("times out a stalled artifact response body", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let transportSignal: AbortSignal | null = null;
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      downloadTimeoutMs: 15,
      fetch: async (_input, init) => {
        transportSignal = init?.signal ?? null;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => await new Promise<ArrayBuffer>(() => {}),
        } as Response;
      },
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };

    await expect(cache.ensure(snapshot)).rejects.toMatchObject({
      code: "plugin_download_timeout",
      retryKind: "transient",
    });
    expect((transportSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(await cache.getReadyPath(snapshot)).toBeNull();
  });
});

describe("AgentPluginRuntimeReconciler", () => {
  it("maps daemon desired/report wire without losing retry generation or errors", () => {
    const desired = agentPluginArtifactSpecFromWire({
      state_id: "state_1",
      plugin_id: "plugin_1",
      version_id: "version_1",
      name: "demo",
      provider: "claude",
      version: "1.2.3",
      digest: "a".repeat(64),
      artifact_url: "/api/daemon/agent-plugin-artifacts/abc",
      source_revision: "commit-1",
      requirements: { binaries: ["lark-cli"] },
      retry_generation: 3,
    });
    expect(desired).toMatchObject({
      stateId: "state_1",
      pluginId: "plugin_1",
      retryGeneration: 3,
      requirements: { binaries: ["lark-cli"] },
    });

    const report = runtimePluginStateReport({
      stateId: "state_1",
      pluginId: "plugin_1",
      versionId: "version_1",
      provider: "claude",
      desiredVersion: "1.2.3",
      desiredDigest: `sha256:${"a".repeat(64)}`,
      installedVersion: null,
      installedDigest: null,
      status: "setup_required",
      attempts: 2,
      retryGeneration: 3,
      nextRetryAt: "2026-08-14T01:00:00.000Z",
      lastErrorCode: "plugin_binary_missing",
      lastError: "lark-cli is missing",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(report).toEqual({
      versionId: "version_1",
      input: {
        status: "setup_required",
        attempts: 2,
        retryGeneration: 3,
        observedDigest: null,
        nextRetryAt: "2026-08-14T01:00:00.000Z",
        lastErrorCode: "plugin_binary_missing",
        lastError: "lark-cli is missing",
      },
    });
  });

  it("restores a future retry deadline after daemon restart without overwriting live state", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let now = Date.parse("2026-08-14T00:00:00.000Z");
    let fetches = 0;
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => {
        fetches++;
        return fetches === 1 ? new Response("temporary", { status: 503 }) : artifactResponse(artifact.bytes);
      },
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };
    const first = new AgentPluginRuntimeReconciler({ cache, now: () => now, retryDelaysMs: [1_000] });
    const failed = (await first.reconcile([snapshot]))[0]!;
    expect(failed.status).toBe("retry_scheduled");

    const restored = agentPluginDesiredFromWire({
      state_id: "state_1",
      plugin_id: snapshot.pluginId,
      version_id: snapshot.versionId,
      name: snapshot.name,
      provider: snapshot.provider,
      version: snapshot.version,
      digest: snapshot.digest,
      artifact_url: snapshot.artifactUrl,
      status: failed.status,
      observed_digest: null,
      retry_count: failed.attempts,
      retry_generation: 0,
      next_retry_at: failed.nextRetryAt,
      last_error_code: failed.lastErrorCode,
      last_error: failed.lastError,
      updated_at: failed.updatedAt,
    });
    const restarted = new AgentPluginRuntimeReconciler({ cache, now: () => now, retryDelaysMs: [1_000] });
    restarted.restoreStates([restored.state]);

    expect((await restarted.reconcile([restored.artifact]))[0]).toMatchObject({
      status: "retry_scheduled",
      attempts: 1,
      nextRetryAt: failed.nextRetryAt,
    });
    expect(fetches).toBe(1);

    now += 1_000;
    expect((await restarted.reconcile([restored.artifact]))[0]?.status).toBe("ready");
    expect(fetches).toBe(2);

    // A late server response from before the live transition cannot replace it.
    restarted.restoreStates([{ ...restored.state, status: "blocked" }]);
    expect(restarted.getStates()[0]?.status).toBe("ready");
  });

  it("persists retry deadlines and converges on a later heartbeat", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let now = Date.parse("2026-08-14T00:00:00.000Z");
    let fetches = 0;
    const reports: RuntimePluginState[] = [];
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => {
        fetches++;
        return fetches === 1 ? new Response("temporary", { status: 503 }) : artifactResponse(artifact.bytes);
      },
    });
    const reconciler = new AgentPluginRuntimeReconciler({
      cache,
      now: () => now,
      retryDelaysMs: [100],
      reportState: (state) => { reports.push(state); },
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };

    expect((await reconciler.reconcile([snapshot]))[0]).toMatchObject({
      status: "retry_scheduled",
      attempts: 1,
      nextRetryAt: "2026-08-14T00:00:00.100Z",
    });
    await reconciler.reconcile([snapshot]);
    expect(fetches).toBe(1);

    now += 100;
    expect((await reconciler.reconcile([snapshot]))[0]).toMatchObject({
      status: "ready",
      attempts: 0,
      installedDigest: `sha256:${artifact.digest}`,
    });
    expect(fetches).toBe(2);
    expect(reports.map((state) => state.status)).toContain("downloading");
    expect(reports.at(-1)?.status).toBe("ready");
  });

  it("classifies missing Runtime dependencies as setup_required and supports manual retry", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let failPreflight = true;
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const reconciler = new AgentPluginRuntimeReconciler({
      cache,
      setupRecheckMs: 60_000,
      preflight: async () => {
        if (failPreflight) throw pluginSetupRequired("lark-cli is missing", "plugin_binary_missing");
      },
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };

    expect((await reconciler.reconcile([snapshot]))[0]).toMatchObject({
      status: "setup_required",
      attempts: 1,
      lastError: "plugin_binary_missing: lark-cli is missing",
    });
    failPreflight = false;
    await reconciler.retryNow(snapshot.digest);
    expect((await reconciler.reconcile([snapshot]))[0]?.status).toBe("ready");
  });

  it("honors a server retry generation after a blocked install", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let incompatible = true;
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const reconciler = new AgentPluginRuntimeReconciler({
      cache,
      preflight: async () => {
        if (incompatible) throw pluginBlocked("provider is too old");
      },
    });
    const snapshot = {
      ...makeSnapshot("claude", artifact.digest),
      bindingId: undefined,
      artifactUrl: "https://example.test/a",
      retryGeneration: 0,
    };

    expect((await reconciler.reconcile([snapshot]))[0]?.status).toBe("blocked");
    incompatible = false;
    expect((await reconciler.reconcile([snapshot]))[0]?.status).toBe("blocked");
    expect((await reconciler.reconcile([{ ...snapshot, retryGeneration: 1 }]))[0]).toMatchObject({
      status: "ready",
      retryGeneration: 1,
    });
  });

  it("reports Codex ready only after an isolated native Plugin install", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("codex");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const baseHome = join(root, "base-codex");
    mkdirSync(baseHome);
    writeFileSync(join(baseHome, "auth.json"), '{"token":"test"}\n', { mode: 0o600 });
    const commands: CodexPluginCommand[] = [];
    const reports: RuntimePluginState[] = [];
    const reconciler = new AgentPluginRuntimeReconciler({
      cache,
      reportState: (state) => { reports.push(state); },
      preflight: async (snapshot, payloadPath, signal) => {
        const prepared = await prepareCodexPluginReadinessRuntime(
          snapshot,
          payloadPath,
          join(root, "readiness"),
          signal,
        );
        await installCodexPluginHome(prepared, {
          signal,
          seedHome: (targetHome) => seedCodexHomeFromBase({ baseHome, targetHome }),
          runCommand: async (command) => { commands.push(command); },
        });
      },
    });
    const snapshot = { ...makeSnapshot("codex", artifact.digest), artifactUrl: "https://example.test/a" };

    const state = (await reconciler.reconcile([snapshot]))[0]!;

    expect(state.status).toBe("ready");
    expect(commands.map((command) => command.args.slice(0, 3))).toEqual([
      ["plugin", "marketplace", "add"],
      ["plugin", "add", expect.stringContaining("demo@remi-")],
    ]);
    expect(commands.every((command) => command.env.CODEX_HOME.includes(".tmp"))).toBe(true);
    expect(reports.findIndex((report) => report.status === "ready")).toBeGreaterThan(
      reports.findIndex((report) => report.status === "preflight"),
    );
  });

  it("reports a stalled Codex native install as setup_required instead of ready", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("codex");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const reconciler = new AgentPluginRuntimeReconciler({
      cache,
      preflight: async (snapshot, payloadPath, signal) => {
        const prepared = await prepareCodexPluginReadinessRuntime(
          snapshot,
          payloadPath,
          join(root, "readiness"),
          signal,
        );
        await installCodexPluginHome(prepared, {
          signal,
          commandTimeoutMs: 15,
          runCommand: async () => await new Promise<void>(() => {}),
        });
      },
    });
    const snapshot = { ...makeSnapshot("codex", artifact.digest), artifactUrl: "https://example.test/a" };

    expect((await reconciler.reconcile([snapshot]))[0]).toMatchObject({
      status: "setup_required",
      lastErrorCode: "plugin_codex_install_timeout",
      installedDigest: null,
    });
  });

  it("reports a rejected Codex native install as blocked instead of ready", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("codex");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const reconciler = new AgentPluginRuntimeReconciler({
      cache,
      preflight: async (snapshot, payloadPath, signal) => {
        const prepared = await prepareCodexPluginReadinessRuntime(
          snapshot,
          payloadPath,
          join(root, "readiness"),
          signal,
        );
        await installCodexPluginHome(prepared, {
          signal,
          runCommand: async () => {
            throw new Error("native plugin rejected");
          },
        });
      },
    });
    const snapshot = { ...makeSnapshot("codex", artifact.digest), artifactUrl: "https://example.test/a" };

    expect((await reconciler.reconcile([snapshot]))[0]).toMatchObject({
      status: "blocked",
      lastErrorCode: "plugin_codex_install_failed",
      installedDigest: null,
    });
  });
});

describe("task-private Agent Plugin runtime", () => {
  it("materializes beside Issue worktrees without fetching and cleans as one directory", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    let fetches = 0;
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => {
        fetches++;
        return artifactResponse(artifact.bytes);
      },
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a", config: { secret: "must-not-be-written" } };
    await cache.ensure(snapshot);
    const issueRoot = join(root, "MUL-42");
    mkdirSync(join(issueRoot, "remi", ".git"), { recursive: true });
    const task = makeTask("claude", snapshot, { issueId: "iss_42", issueKey: "MUL-42" });

    const prepared = await materializeTaskPlugins(task, issueRoot, cache);

    expect(prepared.runtimeRoot).toBe(join(issueRoot, ".remi-runtime", "executions", task.id));
    expect(prepared.pluginPaths[0]).toBe(
      join(issueRoot, ".remi-runtime", "executions", task.id, "plugins", artifact.digest),
    );
    expect(existsSync(join(issueRoot, "remi", ".remi-runtime"))).toBe(false);
    expect(readFileSync(join(prepared.pluginPaths[0]!, "skills", "demo", "SKILL.md"), "utf8")).toBe("# Demo\n");
    const execution = readFileSync(join(prepared.runtimeRoot, "execution.json"), "utf8");
    expect(execution).not.toContain("must-not-be-written");
    expect(execution).toContain("configDigest");
    expect(fetches).toBe(1);

    await cleanupTaskPluginRuntime(issueRoot);
    expect(existsSync(prepared.runtimeRoot)).toBe(false);
    expect(existsSync(join(issueRoot, "remi"))).toBe(true);
  });

  it("publishes concurrent calls for one task once and isolates later tasks using the same digest", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };
    await cache.ensure(snapshot);
    const originalGetReadyPath = cache.getReadyPath.bind(cache);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cache.getReadyPath = async (value) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
      return originalGetReadyPath(value);
    };
    const issueRoot = join(root, "MUL-44");
    mkdirSync(issueRoot);
    const task = makeTask("claude", snapshot, { issueId: "iss_44", issueKey: "MUL-44" });

    const [first, duplicate] = await Promise.all([
      materializeTaskPlugins(task, issueRoot, cache),
      materializeTaskPlugins(task, issueRoot, cache),
    ]);

    expect(first.pluginPaths).toEqual(duplicate.pluginPaths);
    expect(readFileSync(join(first.pluginPaths[0]!, "skills", "demo", "SKILL.md"), "utf8")).toBe("# Demo\n");
    writeFileSync(join(first.pluginPaths[0]!, "injected.txt"), "must not persist\n");

    const second = await materializeTaskPlugins({ ...task, id: "task_2" }, issueRoot, cache);

    expect(second.pluginPaths).not.toEqual(first.pluginPaths);
    expect(existsSync(join(second.pluginPaths[0]!, "injected.txt"))).toBe(false);
    expect(readFileSync(join(second.pluginPaths[0]!, "skills", "demo", "SKILL.md"), "utf8")).toBe("# Demo\n");
  });

  it("requires daemon-owned runtimeBase for non-Issue tasks and leaves ACP cwd untouched", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("claude");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("claude", artifact.digest), artifactUrl: "https://example.test/a" };
    await cache.ensure(snapshot);
    const userRepo = join(root, "user-repo");
    mkdirSync(userRepo);
    const task = makeTask("claude", snapshot);

    await expect(materializeTaskPlugins(task, userRepo, cache)).rejects.toMatchObject({
      code: "plugin_runtime_base_required",
    });
    const runtimeBase = resolveTaskPluginRuntimeBase(task, userRepo, join(root, "workspaces"));
    const prepared = await materializeTaskPlugins(task, userRepo, cache, { runtimeBase });
    expect(prepared.runtimeRoot).toBe(
      join(root, "workspaces", ".task-runtime", task.id, ".remi-runtime", "executions", task.id),
    );
    expect(existsSync(join(userRepo, ".remi-runtime"))).toBe(false);
    await cleanupNonIssueTaskPluginRuntime(task, join(root, "workspaces"));
    expect(existsSync(runtimeBase)).toBe(false);
  });

  it("uses a stable chat runtime and Codex home until the execution fingerprint changes", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("codex");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("codex", artifact.digest), artifactUrl: "https://example.test/a" };
    await cache.ensure(snapshot);
    const workspacesRoot = join(root, "workspaces");
    const userRepo = join(root, "user-repo");
    mkdirSync(userRepo);
    const firstTask = { ...makeTask("codex", snapshot), chatSessionId: "chat_1", executionFingerprint: "a".repeat(64) };
    const secondTask = { ...firstTask, id: "task_2" };
    const changedTask = {
      ...firstTask,
      id: "task_3",
      executionFingerprint: "b".repeat(64),
      pluginSnapshot: [{ ...snapshot, config: { scope: "changed" } }],
    };

    const firstBase = resolveTaskPluginRuntimeBase(firstTask, userRepo, workspacesRoot);
    const secondBase = resolveTaskPluginRuntimeBase(secondTask, userRepo, workspacesRoot);
    const changedBase = resolveTaskPluginRuntimeBase(changedTask, userRepo, workspacesRoot);
    const first = await materializeTaskPlugins(firstTask, userRepo, cache, { runtimeBase: firstBase });
    writeFileSync(join(first.codexMarketplaceRoot!, "injected.txt"), "must not persist\n");
    const second = await materializeTaskPlugins(secondTask, userRepo, cache, { runtimeBase: secondBase });
    const changed = await materializeTaskPlugins(changedTask, userRepo, cache, { runtimeBase: changedBase });

    expect(firstBase).toBe(join(workspacesRoot, ".session-runtime", "chat_1"));
    expect(secondBase).toBe(firstBase);
    expect(changedBase).toBe(firstBase);
    expect(second.codexHome).toBe(first.codexHome);
    expect(second.codexMarketplaceRoot).not.toBe(first.codexMarketplaceRoot);
    expect(existsSync(join(second.codexMarketplaceRoot!, "injected.txt"))).toBe(false);
    expect(changed.codexHome).not.toBe(first.codexHome);
  });

  it("builds and atomically installs a Codex marketplace in an isolated seeded home", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("codex");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("codex", artifact.digest), artifactUrl: "https://example.test/a" };
    await cache.ensure(snapshot);
    const issueRoot = join(root, "MUL-43");
    mkdirSync(issueRoot);
    const sessionCodexHome = join(issueRoot, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    const prepared = await materializeTaskPlugins(
      makeTask("codex", snapshot, { issueId: "iss_43", issueKey: "MUL-43" }),
      issueRoot,
      cache,
      { codexHome: sessionCodexHome },
    );
    const baseHome = join(root, "base-codex");
    mkdirSync(join(baseHome, "plugins", "cache"), { recursive: true });
    writeFileSync(join(baseHome, "auth.json"), '{"token":"test"}\n', { mode: 0o600 });
    writeFileSync(join(baseHome, "config.toml"), [
      'model = "gpt-5.6"',
      'model_provider = "Corp"',
      "unsafe_global = true",
      "",
      "[model_providers.Corp]",
      'base_url = "https://gateway.example/v1"',
      'experimental_bearer_token = "must-never-enter-plugin-home"',
      "",
    ].join("\n"));
    writeFileSync(join(baseHome, "plugins", "cache", "global.txt"), "do not copy\n");
    const commands: CodexPluginCommand[] = [];

    const installed = await installCodexPluginHome(prepared, {
      seedHome: (targetHome) => seedCodexHomeFromBase({
        baseHome,
        targetHome,
        copyAuth: false,
        linkAuth: true,
      }),
      runCommand: async (command) => {
        expect(readFileSync(join(command.env.CODEX_HOME, "config.toml"), "utf8"))
          .not.toContain("must-never-enter-plugin-home");
        commands.push(command);
      },
    });

    expect(prepared.codexHome).toBe(sessionCodexHome);
    expect(installed).toBe(sessionCodexHome);
    expect(commands.map((command) => command.args.slice(0, 3))).toEqual([
      ["plugin", "marketplace", "add"],
      ["plugin", "add", `demo@${prepared.codexMarketplaceName}`],
    ]);
    expect(commands.every((command) => command.env.CODEX_HOME.includes(".tmp"))).toBe(true);
    expect(lstatSync(join(installed!, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(installed!, "auth.json"))).toBe(join(baseHome, "auth.json"));
    expect(readFileSync(join(installed!, "auth.json"), "utf8")).toBe('{"token":"test"}\n');
    expect(readFileSync(join(installed!, "config.toml"), "utf8")).toContain('model = "gpt-5.6"');
    expect(readFileSync(join(installed!, "config.toml"), "utf8"))
      .not.toContain("must-never-enter-plugin-home");
    expect(existsSync(join(installed!, "plugins", "cache", "global.txt"))).toBe(false);
    expect(readFileSync(join(baseHome, "config.toml"), "utf8"))
      .toContain('experimental_bearer_token = "must-never-enter-plugin-home"');

    await installCodexPluginHome(prepared, { runCommand: async (command) => { commands.push(command); } });
    expect(commands).toHaveLength(2);
  });

  it("shares a concurrent Codex home installation for the same execution fingerprint", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("codex");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("codex", artifact.digest), artifactUrl: "https://example.test/a" };
    await cache.ensure(snapshot);
    const issueRoot = join(root, "MUL-45");
    mkdirSync(issueRoot);
    const prepared = await materializeTaskPlugins(
      makeTask("codex", snapshot, { issueId: "iss_45", issueKey: "MUL-45" }),
      issueRoot,
      cache,
    );
    let commands = 0;
    const options = {
      runCommand: async () => {
        commands += 1;
        await Bun.sleep(5);
      },
    };

    const [first, second] = await Promise.all([
      installCodexPluginHome(prepared, options),
      installCodexPluginHome(prepared, options),
    ]);

    expect(first).toBe(prepared.codexHome!);
    expect(second).toBe(first);
    expect(commands).toBe(2);
  });

  it("redacts provider credentials echoed by a failing Codex Plugin command", async () => {
    const root = tempRoot();
    const marketplaceRoot = join(root, "marketplace");
    mkdirSync(marketplaceRoot, { recursive: true });
    const prepared = {
      runtimeRoot: root,
      pluginPaths: [],
      pluginFingerprint: "plugins",
      executionFingerprint: "execution",
      codexHome: join(root, "codex-home"),
      codexMarketplaceRoot: marketplaceRoot,
      codexMarketplaceName: "local",
      codexPluginNames: ["demo"],
    };
    const token = "gateway-secret-value";

    const attempt = installCodexPluginHome(prepared, {
      env: { OPENAI_API_KEY: token },
      runCommand: async () => {
        throw new Error(`command leaked ${token}`);
      },
    });

    await expect(attempt).rejects.toMatchObject({
      message: "Codex Plugin install failed: command leaked [REDACTED]",
    });
    await expect(attempt).rejects.not.toThrow(token);
  });

  it("aborts a stalled native Codex CLI process at the command deadline", async () => {
    const root = tempRoot();
    const artifact = makeArtifact("codex");
    const cache = new AgentPluginCache({
      root: join(root, "cache"),
      fetch: async () => artifactResponse(artifact.bytes),
    });
    const snapshot = { ...makeSnapshot("codex", artifact.digest), artifactUrl: "https://example.test/a" };
    const payloadPath = await cache.ensure(snapshot);
    const prepared = await prepareCodexPluginReadinessRuntime(
      snapshot,
      payloadPath,
      join(root, "readiness"),
    );
    const executable = join(root, "stalled-codex");
    writeFileSync(executable, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });

    const started = Date.now();
    await expect(installCodexPluginHome(prepared, {
      codexExecutable: executable,
      commandTimeoutMs: 25,
    })).rejects.toMatchObject({
      code: "plugin_codex_install_timeout",
      retryKind: "setup_required",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("inherits only Codex execution settings when no workspace Relay overrides them", async () => {
    const root = tempRoot();
    const baseHome = join(root, "base-codex");
    const targetHome = join(root, "target-codex");
    mkdirSync(baseHome);
    writeFileSync(join(baseHome, "auth.json"), '{"token":"test"}\n');
    writeFileSync(join(baseHome, "config.toml"), [
      'model_provider = "Corp"',
      'model = "gpt-5.6"',
      'model_reasoning_effort = "high"',
      'unsafe_global = true',
      '',
      '[model_providers.Corp]',
      'base_url = "https://gateway.example/v1"',
      'experimental_bearer_token = "runtime-secret"',
      'env_key = "CORP_API_KEY"',
      'access_token = "access-secret"',
      'env_http_headers = { Authorization = "CORP_AUTH_TOKEN", "X-Api-Key" = "CORP_API_KEY", Unsafe = "literal-secret" }',
      '',
      '[model_providers.Corp.http_headers]',
      'Authorization = "Bearer header-secret"',
      'X-Custom-Auth = "opaque-header-secret"',
      '',
      '[model_providers.Corp.nested]',
      'client_secret = "nested-secret"',
      'enabled = true',
      '',
      '[marketplaces.global]',
      'source = "/global/marketplace"',
      '',
      '[plugins."global@global"]',
      'enabled = true',
      '',
      '[projects."/private/repo"]',
      'trust_level = "trusted"',
      '',
      '[mcp_servers.global]',
      'command = "global-mcp"',
      '',
    ].join("\n"));

    await seedCodexHomeFromBase({ baseHome, targetHome });

    const inherited = parseToml(readFileSync(join(targetHome, "config.toml"), "utf8")) as Record<string, unknown>;
    expect(inherited).toMatchObject({
      model_provider: "Corp",
      model: "gpt-5.6",
      model_reasoning_effort: "high",
      model_providers: {
        Corp: {
          base_url: "https://gateway.example/v1",
          env_key: "CORP_API_KEY",
          env_http_headers: {
            Authorization: "CORP_AUTH_TOKEN",
            "X-Api-Key": "CORP_API_KEY",
          },
          nested: { enabled: true },
        },
      },
    });
    const inheritedText = readFileSync(join(targetHome, "config.toml"), "utf8");
    expect(inheritedText).not.toContain("runtime-secret");
    expect(inheritedText).not.toContain("access-secret");
    expect(inheritedText).not.toContain("header-secret");
    expect(inheritedText).not.toContain("nested-secret");
    expect((inherited.model_providers as Record<string, Record<string, unknown>>).Corp.http_headers)
      .toBeUndefined();
    expect(inherited.unsafe_global).toBeUndefined();
    expect(inherited.marketplaces).toBeUndefined();
    expect(inherited.plugins).toBeUndefined();
    expect(inherited.projects).toBeUndefined();
    expect(inherited.mcp_servers).toBeUndefined();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-agent-plugin-"));
  roots.push(root);
  return root;
}

function makeArtifact(
  provider: "claude" | "codex",
  options: { corruptFileDigest?: boolean; pathCollision?: boolean } = {},
): { bytes: Uint8Array; digest: string } {
  const manifestPath = provider === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
  const manifest = { description: "Demo Plugin", name: "demo", version: "1.2.3" };
  const manifestContent = `${canonicalJson(manifest)}\n`;
  const files = [
    artifactFile(manifestPath, manifestContent),
    artifactFile("skills/demo/SKILL.md", "# Demo\n", options.corruptFileDigest),
    artifactFile("skills/demo/run.sh", "#!/bin/sh\necho demo\n", false, true),
    ...(options.pathCollision
      ? [artifactFile("collision", "file\n"), artifactFile("collision/child.txt", "child\n")]
      : []),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const json = canonicalJson({ provider, manifestPath, manifest, files });
  const bytes = Buffer.from(json, "utf8");
  return { bytes, digest: sha256(bytes) };
}

function artifactFile(path: string, content: string, corruptDigest = false, executable = false) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    encoding: "utf8" as const,
    content,
    size: bytes.byteLength,
    digest: corruptDigest ? "0".repeat(64) : sha256(bytes),
    ...(executable ? { executable: true } : {}),
  };
}

function makeSnapshot(provider: "claude" | "codex", digest: string): AgentPluginSnapshot {
  return {
    bindingId: "bind_1",
    pluginId: "plugin_1",
    versionId: "version_1",
    name: "demo",
    provider,
    version: "1.2.3",
    digest: `sha256:${digest}`,
    artifactUrl: "/api/daemon/agent-plugin-artifacts/abc",
  };
}

function makeTask(
  provider: "claude" | "codex",
  snapshot: AgentPluginSnapshot,
  issue: { issueId?: string; issueKey?: string } = {},
): AgentTask {
  return {
    id: "task_1",
    workspaceId: "workspace_1",
    prompt: "do it",
    issueId: issue.issueId ?? null,
    issue_id: issue.issueId ?? null,
    issueSessionId: null,
    chatSessionId: null,
    autopilotRunId: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    agent: {
      id: "agent_1",
      name: "Agent",
      provider,
      model: null,
      instructions: "",
      skills: [],
      cwd: null,
      executable: null,
      allowedTools: [],
      customEnv: {},
    },
    issue: issue.issueId ? {
      id: issue.issueId,
      key: issue.issueKey!,
      title: "Issue",
      description: null,
      metadata: {},
    } : null,
    project: null,
    projectResources: [],
    repos: [],
    workDir: null,
    runtimeId: null,
    triggerCommentId: null,
    triggerSummary: null,
    triggerAuthorType: null,
    triggerAuthorName: null,
    sessionId: null,
    pluginSnapshot: [snapshot],
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalClone(value));
}

function canonicalClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalClone((value as Record<string, unknown>)[key]);
  }
  return result;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit);
}

function makeWritableSync(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); } catch { return; }
  if (info.isSymbolicLink()) return;
  chmodSync(path, info.mode | (info.isDirectory() ? 0o700 : 0o600));
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) makeWritableSync(join(path, entry));
  }
}
