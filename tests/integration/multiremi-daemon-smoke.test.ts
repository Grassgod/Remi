import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AcpProviderOptions } from "@acp/index.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import type { AgentResponse, SendOptions } from "@shared/contracts/provider-types.js";
import { startMultiremiServer } from "@multiremi/api.js";
import {
  MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS,
  MultiremiDaemon,
  MultiremiRuntimeReregisterGate,
  installCodexPluginReadinessHome,
  preflightAgentPluginProvider,
  runtimeModelsFromAcpCapabilities,
  type MultiremiDaemonProviderFactory,
} from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiRepoCache } from "@multiremi/repo-cache.js";

let db: Database | null = null;
let workDir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (workDir) {
    try {
      // Intake snapshots are materialized read-only (0555 dirs); restore write
      // permission or rmSync fails with EACCES.
      execFileSync("chmod", ["-R", "u+w", workDir], { stdio: "ignore" });
    } catch {
      // The directory may already be gone.
    }
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe("Bun Multiremi daemon smoke", () => {
  it("keeps the unsafe in-process model probe restricted to injected test providers", () => {
    workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-model-probe-guard-"));
    expect(() => new MultiremiDaemon({
      serverUrl: "http://127.0.0.1:1",
      workspaceId: "local",
      daemonPort: 0,
      workspacesRoot: join(workDir!, "workspaces"),
      repoCacheRoot: join(workDir!, ".repo-cache"),
      inProcessRuntimeModelDiscoveryEnabled: true,
    })).toThrow("In-process Runtime model discovery may only be enabled with an injected test provider");
  });

  it("maps ACP model-specific effort capabilities to runtime model metadata", () => {
    expect(runtimeModelsFromAcpCapabilities("codex", [
      {
        id: "gpt-probe",
        label: "GPT Probe",
        default: true,
        effort: {
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "xhigh", label: "Extra high", description: "More reasoning" },
          ],
        },
      },
      { id: "gpt-fast", label: "GPT Fast", default: false },
    ])).toEqual([
      {
        id: "gpt-probe",
        label: "GPT Probe",
        provider: "openai",
        default: true,
        thinking: {
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "xhigh", label: "Extra high", description: "More reasoning" },
          ],
        },
      },
      { id: "gpt-fast", label: "GPT Fast", provider: "openai", default: false },
    ]);
  });

  it("discovers Claude and Codex gateway models from isolated daemon-owned probe homes", async () => {
    const { store, workDir: root } = daemonTestBed("multiremi-daemon-relay-model-probe-");
    const workspacesRoot = join(root, "workspaces");
    const globalClaudeHome = join(root, "global-claude");
    const globalCodexHome = join(root, "global-codex");
    mkdirSync(globalClaudeHome, { recursive: true });
    mkdirSync(globalCodexHome, { recursive: true });
    const globalClaudeSettings = JSON.stringify({
      model: "global-claude-model",
      env: {
        ANTHROPIC_BASE_URL: "https://global-claude.invalid",
        ANTHROPIC_AUTH_TOKEN: "global-claude-secret",
      },
    }, null, 2);
    const globalCodexConfig = [
      'model_provider = "Global"',
      "[model_providers.Global]",
      'base_url = "https://global-codex.invalid/v1"',
      'experimental_bearer_token = "global-inline-codex-secret"',
    ].join("\n");
    writeFileSync(join(globalClaudeHome, "settings.json"), globalClaudeSettings);
    writeFileSync(join(globalCodexHome, "config.toml"), globalCodexConfig);
    store.upsertRelayConfig("local", "claude", {
      fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway-claude.example" } }),
      tokenOp: "set",
      authToken: "claude-probe-secret",
    });
    store.upsertRelayConfig("local", "codex", {
      fragment: [
        'model_provider = "OpenAI"',
        "[model_providers.OpenAI]",
        'base_url = "https://gateway-codex.example/v1"',
        'wire_api = "responses"',
      ].join("\n"),
      tokenOp: "set",
      authToken: "codex-probe-secret",
    });
    const claudeDaemonToken = await store.createAccessToken({
      name: "Claude Relay model probe daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-relay-probe-claude",
    });
    const codexDaemonToken = await store.createAccessToken({
      name: "Codex Relay model probe daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-relay-probe-codex",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-relay-model-probe-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const captured = new Map<string, AcpProviderOptions>();
    const providerFactory = (provider: "claude" | "codex"): MultiremiDaemonProviderFactory => (options) => {
      captured.set(provider, options);
      return {
        async *sendStream() {},
        getLastResponse: () => null,
        discoverModelCapabilities: async () => [{
          id: `${provider}-gateway-model`,
          label: `${provider} gateway model`,
          default: true,
        }],
      };
    };
    const claudeDaemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: claudeDaemonToken.token,
      daemonId: "daemon-relay-probe-claude",
      runtimeName: "relay-probe-claude",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 25,
      gcEnabled: false,
      inProcessRuntimeModelDiscoveryEnabled: true,
      workspacesRoot,
      repoCacheRoot: join(root, ".repo-cache-claude"),
      providerFactory: providerFactory("claude"),
    });
    const codexDaemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: codexDaemonToken.token,
      daemonId: "daemon-relay-probe-codex",
      runtimeName: "relay-probe-codex",
      provider: "codex",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 25,
      gcEnabled: false,
      inProcessRuntimeModelDiscoveryEnabled: true,
      workspacesRoot,
      repoCacheRoot: join(root, ".repo-cache-codex"),
      providerFactory: providerFactory("codex"),
    });
    const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = globalClaudeHome;
    process.env.CODEX_HOME = globalCodexHome;
    let claudeRun: Promise<void> | null = null;
    let codexRun: Promise<void> | null = null;
    try {
      claudeRun = claudeDaemon.start();
      codexRun = codexDaemon.start();
      await waitForCondition(() => {
        const runtimes = store.listRuntimes();
        return runtimes.some((runtime) => runtime.provider === "claude"
          && store.listRuntimeModels(runtime.id).some((model) => model.id === "claude-gateway-model"))
          && runtimes.some((runtime) => runtime.provider === "codex"
            && store.listRuntimeModels(runtime.id).some((model) => model.id === "codex-gateway-model"));
      }, 5_000);

      const claudeOptions = captured.get("claude")!;
      const codexOptions = captured.get("codex")!;
      expect(claudeOptions.cwd).toStartWith(join(workspacesRoot, ".runtime-probe"));
      expect(codexOptions.cwd).toStartWith(join(workspacesRoot, ".runtime-probe"));
      expect(claudeOptions.env).toMatchObject({
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "claude-probe-secret",
        ANTHROPIC_BASE_URL: "https://gateway-claude.example",
      });
      expect(codexOptions.env).toMatchObject({ OPENAI_API_KEY: "codex-probe-secret" });
      expect(claudeOptions.env?.CLAUDE_CONFIG_DIR).toStartWith(join(workspacesRoot, ".runtime-probe"));
      expect(codexOptions.env?.CODEX_HOME).toStartWith(join(workspacesRoot, ".runtime-probe"));
      const claudeSettings = readFileSync(join(claudeOptions.env!.CLAUDE_CONFIG_DIR!, "settings.json"), "utf8");
      const codexConfig = readFileSync(join(codexOptions.env!.CODEX_HOME!, "config.toml"), "utf8");
      expect(claudeSettings).toContain("https://gateway-claude.example");
      expect(claudeSettings).not.toContain("claude-probe-secret");
      expect(codexConfig).toContain('env_key = "OPENAI_API_KEY"');
      expect(codexConfig).toContain("requires_openai_auth = false");
      expect(codexConfig).not.toContain("codex-probe-secret");
      expect(codexConfig).not.toContain("global-inline-codex-secret");
      expect(existsSync(join(codexOptions.env!.CODEX_HOME!, "auth.json"))).toBe(false);
      expect(readFileSync(join(globalClaudeHome, "settings.json"), "utf8")).toBe(globalClaudeSettings);
      expect(readFileSync(join(globalCodexHome, "config.toml"), "utf8")).toBe(globalCodexConfig);
    } finally {
      claudeDaemon.stop();
      codexDaemon.stop();
      await Promise.all([claudeRun?.catch(() => {}), codexRun?.catch(() => {})]);
      if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      server.stop(true);
    }
  });

  it("runs production tasks without starting in-process Runtime model discovery", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-model-probe-disabled-task-");
    const agent = store.createAgent({ name: "Probe-disabled Claude", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Run without a model probe" });
    const daemonToken = await store.createAccessToken({
      name: "Probe-disabled daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-model-probe-disabled-task-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const taskProviderFactory = messageProviderFactory({
      text: "completed without probing",
      sessionId: "sess-model-probe-disabled",
      requestId: "req-model-probe-disabled",
    });
    let modelProbeCount = 0;
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "model-probe-disabled-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 10,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory: (options) => ({
        ...taskProviderFactory(options),
        discoverModelCapabilities: async () => {
          modelProbeCount++;
          return [{ id: "must-not-probe", label: "Must Not Probe", default: true }];
        },
      }),
    });

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      await waitForCondition(() => store.getTask(task.id)?.status === "completed", 5_000);
      const runtime = store.listRuntimes()[0]!;

      expect(runtime.status).toBe("online");
      expect(modelProbeCount).toBe(0);
      expect(store.listRuntimeModels(runtime.id)).toEqual([]);
    } finally {
      daemon.stop();
      await daemonRun?.catch(() => {});
      server.stop(true);
    }
  });

  it("loads workspace repository metadata without eagerly cloning every repository", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-lazy-repo-cache-");
    const unavailableRepo = join(workDir, "unavailable-source.git");
    const repoCacheRoot = join(workDir, ".repo-cache");
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [{ url: unavailableRepo, description: "must remain lazy" }],
    });
    const daemonToken = await store.createAccessToken({
      name: "Lazy repo cache daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-lazy-repo-cache-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "lazy-repo-cache-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot,
        providerFactory: () => {
          throw new Error("startup must not create a task provider");
        },
      });

      await daemon.start();

      const allowed = (daemon as unknown as {
        workspaceRepoUrls: Map<string, Set<string>>;
      }).workspaceRepoUrls.get("local");
      expect([...allowed ?? []]).toEqual([unavailableRepo]);
      expect(existsSync(repoCacheRoot)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  for (const kind of ["quick", "chat", "issue"] as const) {
    it(`rejects a symlinked ${kind} Provider parent before writing external GC state`, async () => {
      await runProviderHomeSymlinkProof(kind);
    });
  }

  it("requires provider-native Plugin support during preflight", async () => {
    await expect(preflightAgentPluginProvider("codex", {
      which: () => "/opt/bin/codex",
      commandSucceeds: async () => false,
      bridgeHealthy: async () => true,
    })).rejects.toMatchObject({
      code: "plugin_codex_cli_unsupported",
      retryKind: "setup_required",
    });
    await expect(preflightAgentPluginProvider("claude", {
      which: () => "/opt/bin/claude",
      bridgeHealthy: async () => false,
    })).rejects.toMatchObject({
      code: "plugin_claude_bridge_missing",
      retryKind: "setup_required",
    });
  });

  it("preflights a Codex Plugin with a gateway-only Relay and no base auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-codex-readiness-relay-"));
    workDir = root;
    const payload = join(root, "payload");
    mkdirSync(join(payload, ".codex-plugin"), { recursive: true });
    writeFileSync(join(payload, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "gateway-proof",
      version: "1.0.0",
    }));
    const commands: Array<{ env: Record<string, string>; config: string }> = [];
    const token = "gateway-readiness-secret";

    const home = await installCodexPluginReadinessHome({
      pluginId: "plg_gateway",
      versionId: "plgv_gateway",
      name: "gateway-proof",
      provider: "codex",
      version: "1.0.0",
      digest: "a".repeat(64),
      artifactUrl: "/artifact",
    }, payload, {
      readinessRoot: join(root, "readiness"),
      baseHome: join(root, "base-without-auth"),
      relayAuthoritative: true,
      relay: {
        fragment: [
          'model_provider = "OpenAI"',
          "[model_providers.OpenAI]",
          'base_url = "https://gateway.example/v1"',
          'wire_api = "responses"',
        ].join("\n"),
        auth_token: token,
        revision: 1,
      },
      runCommand: async (command) => {
        commands.push({
          env: command.env,
          config: readFileSync(join(command.env.CODEX_HOME!, "config.toml"), "utf8"),
        });
      },
    });

    expect(home).not.toBeNull();
    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command.env.OPENAI_API_KEY === token)).toBe(true);
    expect(commands.every((command) => command.config.includes('env_key = "OPENAI_API_KEY"'))).toBe(true);
    expect(commands.every((command) => command.config.includes("requires_openai_auth = false"))).toBe(true);
    expect(commands.every((command) => !command.config.includes(token))).toBe(true);
    expect(existsSync(join(home!, "auth.json"))).toBe(false);
    expect(readFileSync(join(home!, "config.toml"), "utf8")).not.toContain(token);
    expect(readFileSync(join(home!, ".remi-plugins.json"), "utf8")).not.toContain(token);
  });

  it("uses an empty key tombstone and native OAuth after an authoritative Relay clear", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-codex-readiness-clear-"));
    workDir = root;
    const payload = join(root, "payload");
    const baseHome = join(root, "base");
    mkdirSync(join(payload, ".codex-plugin"), { recursive: true });
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(payload, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "clear-proof",
      version: "1.0.0",
    }));
    writeFileSync(join(baseHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "native-oauth-secret" },
    }), { mode: 0o600 });
    writeFileSync(join(baseHome, "config.toml"), [
      'model_provider = "StaleRelay"',
      "[model_providers.StaleRelay]",
      'base_url = "https://stale.example/v1"',
    ].join("\n"));
    const observedKeys: string[] = [];

    const home = await installCodexPluginReadinessHome({
      pluginId: "plg_clear",
      versionId: "plgv_clear",
      name: "clear-proof",
      provider: "codex",
      version: "1.0.0",
      digest: "b".repeat(64),
      artifactUrl: "/artifact",
    }, payload, {
      readinessRoot: join(root, "readiness"),
      baseHome,
      relayAuthoritative: true,
      relay: null,
      runCommand: async (command) => {
        observedKeys.push(command.env.OPENAI_API_KEY ?? "missing");
      },
    });

    expect(observedKeys).toEqual(["", ""]);
    expect(lstatSync(join(home!, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home!, "auth.json"))).toBe(join(baseHome, "auth.json"));
    const config = readFileSync(join(home!, "config.toml"), "utf8");
    expect(config).not.toContain("StaleRelay");
    expect(config).not.toContain("stale.example");
    expect(config).not.toContain("native-oauth-secret");
  });

  it("does not reuse native Codex Plugin readiness after a workspace switches to Relay", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-codex-readiness-scope-"));
    workDir = root;
    const payload = join(root, "payload");
    const baseHome = join(root, "base");
    const readinessRoot = join(root, "readiness");
    mkdirSync(join(payload, ".codex-plugin"), { recursive: true });
    mkdirSync(baseHome, { recursive: true });
    writeFileSync(join(payload, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "scope-proof",
      version: "1.0.0",
    }));
    writeFileSync(join(baseHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "native-oauth-secret" },
    }), { mode: 0o600 });
    const snapshot = {
      pluginId: "plg_scope",
      versionId: "plgv_scope",
      name: "scope-proof",
      provider: "codex" as const,
      version: "1.0.0",
      digest: "c".repeat(64),
      artifactUrl: "/artifact",
    };
    let nativeCommands = 0;
    const nativeHome = await installCodexPluginReadinessHome(snapshot, payload, {
      readinessRoot,
      scopeIdentity: "workspace-a",
      baseHome,
      relayAuthoritative: false,
      relay: null,
      runCommand: async () => { nativeCommands++; },
    });
    const relayConfigs: string[] = [];
    const relayHome = await installCodexPluginReadinessHome(snapshot, payload, {
      readinessRoot,
      scopeIdentity: "workspace-a",
      baseHome,
      relayAuthoritative: true,
      relay: {
        fragment: [
          'model_provider = "OpenAI"',
          "[model_providers.OpenAI]",
          'base_url = "https://gateway.example/v1"',
        ].join("\n"),
        auth_token: "workspace-relay-secret",
        revision: 2,
      },
      runCommand: async (command) => {
        relayConfigs.push(readFileSync(join(command.env.CODEX_HOME, "config.toml"), "utf8"));
      },
    });

    expect(nativeCommands).toBe(2);
    expect(relayConfigs).toHaveLength(2);
    expect(relayHome).not.toBe(nativeHome);
    expect(relayConfigs.every((config) => config.includes('env_key = "OPENAI_API_KEY"'))).toBe(true);
    expect(relayConfigs.every((config) => !config.includes("workspace-relay-secret"))).toBe(true);
    expect(existsSync(join(relayHome!, "auth.json"))).toBe(false);
  });

  it("coalesces runtime_gone re-register attempts like the Go daemon", () => {
    const gate = new MultiremiRuntimeReregisterGate();
    const t0 = 1_000_000;

    expect(gate.tryClaimRegisterSlot("local", t0, t0)).toBe(true);
    expect(gate.tryClaimRegisterSlot("local", t0 + 1, t0 + 1)).toBe(false);
    gate.recordRegisterCompletion("local", t0 + 50);
    expect(gate.tryClaimRegisterSlot("local", t0 + 10, t0 + 60)).toBe(false);
    expect(gate.tryClaimRegisterSlot("local", t0 + 100, t0 + 100)).toBe(true);

    const failedGate = new MultiremiRuntimeReregisterGate();
    expect(failedGate.tryClaimRegisterSlot("local", t0, t0)).toBe(true);
    failedGate.recordRegisterCompletion("local", t0 + 50, new Error("boom"));
    expect(failedGate.tryClaimRegisterSlot("local", t0 + 60, t0 + 50 + MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS / 2)).toBe(false);
    expect(failedGate.tryClaimRegisterSlot("local", t0 + 60, t0 + 50 + MULTIREMI_REREGISTER_FAILURE_BACKOFF_MS + 1)).toBe(true);
  });

  it("runs one claimed task through the local API lifecycle", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-smoke-");
    store.upsertRelayConfig("local", "claude", {
      fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
      tokenOp: "set",
      authToken: "quick-task-provider-key",
    });
    const workspacesRoot = join(workDir, "workspaces");
    const agent = store.createAgent({
      name: "Claude Smoke",
      provider: "claude",
      model: "claude-smoke",
      allowedTools: ["Read"],
      customEnv: { SMOKE_ENV: "1" },
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Say smoke from the daemon" });
    const daemonToken = await store.createAccessToken({
      name: "Smoke daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const expectedRuntimeId = daemonRuntimeIdForTest("daemon-smoke", "claude");
    store.registerRuntime({
      id: expectedRuntimeId,
      name: "smoke-runtime",
      provider: "claude",
      workspaceId: "local",
      ownerId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-smoke-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const providerOptions: AcpProviderOptions[] = [];
    const prompts: string[] = [];
    const sendOptions: SendOptions[] = [];
    let closed = false;
    const response: AgentResponse = {
      // The real ACP provider always returns text: "" (buildAgentResponse) —
      // the task result must come from the streamed agent_message_chunk events,
      // so keep this empty to exercise that path.
      text: "",
      sessionId: "sess-smoke",
      requestId: "req-smoke",
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 2,
      cacheCreateInputTokens: 1,
      totalTokens: 11,
      model: "claude-smoke",
    };
    const providerFactory: MultiremiDaemonProviderFactory = (options) => {
      providerOptions.push(options);
      return {
        async *sendStream(message, options) {
          prompts.push(message);
          sendOptions.push(options ?? {});
          yield {
            sessionUpdate: "agent_thought_chunk",
            content: [{ type: "text", text: "Thinking" }],
          } as any;
          yield {
            sessionUpdate: "tool_call",
            title: "Read",
            rawInput: JSON.stringify({ path: "README.md" }),
            rawOutput: { content: "file body" },
          } as any;
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "Smoke " }],
          } as any;
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text: "completed" }],
          } as any;
          yield {
            sessionUpdate: "usage_update",
            model: "claude-smoke",
            inputTokens: 7,
            outputTokens: 3,
          } as any;
        },
        getLastResponse: () => response,
        close: async () => {
          closed = true;
        },
      };
    };

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-smoke",
        runtimeName: "smoke-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory,
      });

      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      expect(completed.runtimeId).toBe(expectedRuntimeId);
      expect(completed.result).toBe("Smoke completed");
      expect(completed.sessionId).toBe("sess-smoke");
      const expectedWorkDir = join(workspacesRoot, "tasks", task.id);
      expect(completed.workDir).toBe(expectedWorkDir);
      expect(store.getRuntime(expectedRuntimeId)?.daemonId).toBe("daemon-smoke");
      expect(providerOptions).toHaveLength(1);
      expect(providerOptions[0]).toMatchObject({
        agentType: "claude",
        model: "claude-smoke",
        allowedTools: ["Read"],
        cwd: expectedWorkDir,
        env: {
          SMOKE_ENV: "1",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "quick-task-provider-key",
          ANTHROPIC_BASE_URL: "https://gateway.example",
        },
      });
      const temporaryProviderHome = join(
        workspacesRoot,
        ".runtime",
        task.id,
        agent.id,
        "1",
        "home",
      );
      expect(providerOptions[0]?.env?.CLAUDE_CONFIG_DIR).toBe(temporaryProviderHome);
      expect(existsSync(temporaryProviderHome)).toBe(false);
      const injectedToken = providerOptions[0].env?.MULTIREMI_TOKEN;
      expect(injectedToken).toStartWith("mat_");
      expect(injectedToken).not.toBe(daemonToken.token);
      expect(await store.verifyAccessToken(injectedToken!)).toBeNull();
      expect(prompts[0]).toContain("Say smoke from the daemon");
      expect(JSON.parse(readFileSync(join(expectedWorkDir, ".multiremi", "task.json"), "utf-8"))).toMatchObject({
        task_id: task.id,
        workspace_id: "local",
        agent: {
          id: agent.id,
          provider: "claude",
        },
        prompt: "Say smoke from the daemon",
        repos: [],
      });
      expect(sendOptions[0]).toMatchObject({
        cwd: expectedWorkDir,
        chatId: task.id,
        allowedTools: ["Read"],
        permissionMode: "bypassPermissions",
      });
      const messages = store.listTaskMessages(task.id);
      // The initial tool_call already carries rawOutput and no follow-up update,
      // so the stateful mapper emits BOTH a tool_use and its paired tool_result
      // (each with its own seq). Output lives on the result, not the use.
      expect(messages.map((message) => ({
        seq: message.seq,
        type: message.type,
        tool: message.tool,
        content: message.content,
        input: message.input,
        output: message.output,
      }))).toEqual([
        { seq: 1, type: "thinking", tool: null, content: "Thinking", input: null, output: null },
        { seq: 2, type: "tool_use", tool: "Read", content: null, input: { path: "README.md" }, output: null },
        { seq: 3, type: "tool_result", tool: "Read", content: null, input: null, output: "{\"content\":\"file body\"}" },
        { seq: 4, type: "text", tool: null, content: "Smoke completed", input: null, output: null },
        { seq: 5, type: "usage", tool: null, content: null, input: null, output: null },
      ]);
      // tool_use and tool_result pair on a shared (synthetic) tool_call_id.
      expect(messages[1]?.toolCallId).toBeTruthy();
      expect(messages[2]?.toolCallId).toBe(messages[1]?.toolCallId);
      // usage numbers now live in meta, not a content JSON string.
      expect(messages[4]?.meta).toMatchObject({ model: "claude-smoke", inputTokens: 7, outputTokens: 3 });
      const transcriptResponse = await fetch(`http://127.0.0.1:${server.port}/api/daemon/tasks/${task.id}/messages`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      });
      expect(transcriptResponse.status).toBe(200);
      const transcriptBody = await transcriptResponse.json() as any[];
      expect(transcriptBody.map((m) => ({ seq: m.seq, type: m.type, tool: m.tool, content: m.content, output: m.output }))).toEqual([
        { seq: 1, type: "thinking", tool: undefined, content: "Thinking", output: undefined },
        { seq: 2, type: "tool_use", tool: "Read", content: undefined, output: undefined },
        { seq: 3, type: "tool_result", tool: "Read", content: undefined, output: "{\"content\":\"file body\"}" },
        { seq: 4, type: "text", tool: undefined, content: "Smoke completed", output: undefined },
        { seq: 5, type: "usage", tool: undefined, content: undefined, output: undefined },
      ]);
      // wire carries created_at + the paired tool_call_id
      expect(transcriptBody[0].created_at).toBeTruthy();
      expect(transcriptBody[2].tool_call_id).toBe(transcriptBody[1].tool_call_id);
      expect(store.getTask(task.id)?.usage[0]).toMatchObject({
        provider: "claude",
        model: "claude-smoke",
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 11,
      });
      // Runtime identity and machine display name are separate fields.
      const registeredRuntime = store.listRuntimes()[0]!;
      expect(registeredRuntime).toMatchObject({
        name: "claude",
        provider: "claude",
        status: "online",
      });
      expect(registeredRuntime.daemonDisplayName).toBe(
        registeredRuntime.deviceInfo.split(" · ", 1)[0],
      );
      expect(closed).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("keeps a real answer when compaction status arrives at the turn tail", async () => {
    const { store, taskId, issueId } = await runCompactionFinalizeCase({
      id: "answer-tail",
      chunks: [
        "Implemented the fix and verified it.",
        "Compacting...",
        "\n\nCompacting completed.",
      ],
      lastText: "Implemented the fix and verified it.",
    });

    expect(store.getTask(taskId)).toMatchObject({
      status: "completed",
      result: "Implemented the fix and verified it.",
    });
    expect(store.listIssueComments(issueId).map((comment) => comment.body)).toEqual([
      "Implemented the fix and verified it.",
    ]);
    expect(store.listTaskMessages(taskId).map((message) => message.type)).toEqual([
      "text",
      "compaction",
      "compaction",
    ]);
  });

  it("fails a compaction-only run after the provider filters its fallback text", async () => {
    const { store, taskId, issueId } = await runCompactionFinalizeCase({
      id: "compaction-only",
      chunks: ["Compacting...", "\n\nCompacting completed."],
      lastText: "",
    });

    expect(store.getTask(taskId)).toMatchObject({
      status: "failed",
      error: "Agent returned empty output after compaction.",
      failureReason: "agent_error.empty_or_unparseable_output",
    });
    expect(store.listIssueComments(issueId)).toEqual([]);
    expect(store.listTaskMessages(taskId).map((message) => message.type)).toEqual([
      "compaction",
      "compaction",
    ]);
  });

  it("preserves the existing placeholder for empty output without compaction", async () => {
    const { store, taskId, issueId } = await runCompactionFinalizeCase({
      id: "ordinary-empty",
      chunks: [],
      lastText: "",
    });

    expect(store.getTask(taskId)).toMatchObject({
      status: "completed",
      result: "Task completed.",
    });
    expect(store.listIssueComments(issueId)).toEqual([]);
    expect(store.listTaskMessages(taskId)).toEqual([]);
  });

  it("reconciles, materializes and cleans a direct task Agent Plugin runtime", async () => {
    const { store, workDir: root } = daemonTestBed("multiremi-daemon-plugin-");
    const userRepo = join(root, "user-repo");
    const workspacesRoot = join(root, "workspaces");
    mkdirSync(userRepo, { recursive: true });
    const agent = store.createAgent({ name: "Plugin Claude", provider: "claude" });
    const plugin = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "runtime-proof", version: "1.0.0" },
      files: [{ path: "skills/runtime-proof/SKILL.md", content: "# Runtime proof\n" }],
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id, config: { scope: "docs" } });
    const task = store.createTask({ agentId: agent.id, prompt: "Use the runtime Plugin" });
    const daemonToken = await store.createAccessToken({
      name: "Plugin daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-plugin-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const expectedRuntimeId = daemonRuntimeIdForTest("daemon-plugin", "claude");
    let pluginBody = "";
    let providerPluginPaths: string[] = [];
    let sendPluginFingerprint = "";

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-plugin",
        runtimeName: "plugin-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot,
        repoCacheRoot: join(root, ".repo-cache"),
        pluginCacheRoot: join(root, ".plugin-cache"),
        agentPluginProviderPreflight: async () => {},
        providerFactory: (options) => {
          providerPluginPaths = options.pluginPaths ?? [];
          return {
            async *sendStream(_message, rawOptions) {
              const pluginOptions = rawOptions as SendOptions & {
                pluginPaths?: string[];
                pluginFingerprint?: string;
              };
              sendPluginFingerprint = pluginOptions.pluginFingerprint ?? "";
              pluginBody = readFileSync(
                join(pluginOptions.pluginPaths![0]!, "skills", "runtime-proof", "SKILL.md"),
                "utf8",
              );
              yield {
                sessionUpdate: "agent_message_chunk",
                content: [{ type: "text", text: "Plugin completed" }],
              } as any;
            },
            getLastResponse: () => ({
              text: "Plugin completed",
              sessionId: "sess-plugin",
              requestId: "req-plugin",
            }),
          };
        },
      });

      await daemon.start();

      expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "Plugin completed" });
      expect(store.listAgentPluginRuntimeStates({ runtimeId: expectedRuntimeId })).toMatchObject([{
        status: "ready",
        observedDigest: plugin.activeVersion!.artifactDigest,
      }]);
      expect(providerPluginPaths).toHaveLength(1);
      expect(sendPluginFingerprint).toBe(store.getTask(task.id)?.executionFingerprint!);
      expect(pluginBody).toBe("# Runtime proof\n");
      expect(existsSync(join(userRepo, ".remi-runtime"))).toBe(false);
      expect(existsSync(join(workspacesRoot, ".runtime", task.id))).toBe(false);
      expect(existsSync(join(root, ".plugin-cache", plugin.activeVersion!.artifactDigest, "payload"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("reports Plugin preflight setup_required and leaves the task queued", async () => {
    const { store, workDir: root } = daemonTestBed("multiremi-daemon-plugin-preflight-");
    const userRepo = join(root, "user-repo");
    mkdirSync(userRepo, { recursive: true });
    const agent = store.createAgent({ name: "Preflight Claude", provider: "claude" });
    const plugin = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "preflight-proof", version: "1.0.0" },
      files: [{ path: "skills/preflight-proof/SKILL.md", content: "# Preflight\n" }],
      requirements: { binaries: ["multiremi-binary-that-does-not-exist"] },
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Do not claim until ready" });
    const daemonToken = await store.createAccessToken({
      name: "Preflight daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-preflight-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const expectedRuntimeId = daemonRuntimeIdForTest("daemon-plugin-preflight", "claude");

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-plugin-preflight",
        runtimeName: "plugin-preflight-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(root, "workspaces"),
        repoCacheRoot: join(root, ".repo-cache"),
        pluginCacheRoot: join(root, ".plugin-cache"),
        agentPluginProviderPreflight: async () => {},
        providerFactory: () => {
          throw new Error("setup-required task must not reach the provider");
        },
      });

      await daemon.start();

      expect(store.getTask(task.id)?.status).toBe("queued");
      expect(store.listAgentPluginRuntimeStates({ runtimeId: expectedRuntimeId })).toMatchObject([{
        status: "setup_required",
        retryCount: 1,
        lastErrorCode: "plugin_binary_missing",
      }]);
    } finally {
      server.stop(true);
    }
  });

  it("runs tasks concurrently up to maxConcurrency", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-concurrency-");
    // Two distinct agents → no shared issue/chat, so the server's per-context
    // serialization does not force these to run one at a time.
    const agentA = store.createAgent({ name: "Concurrent A", provider: "claude" });
    const agentB = store.createAgent({ name: "Concurrent B", provider: "claude" });
    const taskA = store.createTask({ agentId: agentA.id, prompt: "Task A" });
    const taskB = store.createTask({ agentId: agentB.id, prompt: "Task B" });
    const daemonToken = await store.createAccessToken({ name: "Concurrency daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-concurrency-secret", hostname: "127.0.0.1", port: 0 });

    let started = 0;
    const bothStarted = deferred<void>();
    const release = deferred<void>();
    const taskProviderFactory = messageProviderFactory({
      text: "done",
      sessionId: "sess-concurrent",
      requestId: "req-concurrent",
      onSend: async () => {
        started += 1;
        if (started >= 2) bothStarted.resolve();
        await release.promise; // hold the task open until both are confirmed in flight
      },
    });
    let modelProbeCount = 0;
    const providerFactory: MultiremiDaemonProviderFactory = (options) => ({
      ...taskProviderFactory(options),
      discoverModelCapabilities: async () => {
        modelProbeCount++;
        return [{
          id: "claude-concurrent",
          label: "Claude Concurrent",
          default: true,
          effort: { supportedLevels: [{ value: "high", label: "High" }] },
        }];
      },
    });

    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "concurrency-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 25,
      maxConcurrency: 2,
      inProcessRuntimeModelDiscoveryEnabled: true,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory,
    });

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      await withTimeout(bothStarted.promise, 5_000, "two tasks did not start concurrently");
      // Both tasks are in flight at once — proving the daemon is no longer serial.
      expect((daemon as unknown as { activeTaskCount: number }).activeTaskCount).toBe(2);
      // The configured cap reached the server via the daemon-register path.
      expect(store.listRuntimes()[0]?.maxConcurrency).toBe(2);
      await waitForCondition(
        () => store.listRuntimeModels(store.listRuntimes()[0]!.id).some((model) => model.id === "claude-concurrent"),
        5_000,
      );
      expect(modelProbeCount).toBe(1);
      expect(store.listRuntimeModels(store.listRuntimes()[0]!.id)[0]).toMatchObject({
        id: "claude-concurrent",
        provider: "anthropic",
        thinking: { supportedLevels: [{ value: "high", label: "High" }] },
      });

      release.resolve();
      await waitForCondition(
        () => store.getTask(taskA.id)?.status === "completed" && store.getTask(taskB.id)?.status === "completed",
        5_000,
      );
    } finally {
      release.resolve();
      daemon.stop();
      await daemonRun?.catch(() => {}); // drain-on-shutdown: resolves once in-flight tasks finish
      server.stop(true);
    }
  });

  it("cancels and drains the background model probe during shutdown", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-model-probe-stop-");
    const daemonToken = await store.createAccessToken({
      name: "Model probe shutdown daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-model-probe-stop-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const probeStarted = deferred<void>();
    let closeCount = 0;
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "model-probe-stop-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 25,
      inProcessRuntimeModelDiscoveryEnabled: true,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
        discoverModelCapabilities: async () => {
          probeStarted.resolve();
          return await new Promise<never>(() => {});
        },
        close: async () => {
          closeCount++;
        },
      }),
    });

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      await withTimeout(probeStarted.promise, 2_000, "background model probe did not start");
      daemon.stop();
      await withTimeout(daemonRun, 2_000, "daemon did not drain the background model probe");

      expect(closeCount).toBe(1);
      expect((daemon as unknown as { runtimeModelProbe: unknown }).runtimeModelProbe).toBeNull();
      expect((daemon as unknown as { runtimeModelRefreshTask: unknown }).runtimeModelRefreshTask).toBeNull();
      expect(store.listRuntimeModels(store.listRuntimes()[0]!.id)).toEqual([]);
    } finally {
      daemon.stop();
      await daemonRun?.catch(() => {});
      server.stop(true);
    }
  });

  it("retries a failed startup model report without blocking task claims", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-model-retry-");
    const agent = store.createAgent({ name: "Retry Claude", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Run while model reporting retries" });
    const daemonToken = await store.createAccessToken({
      name: "Model retry daemon",
      type: "daemon",
      workspaceId: "local",
    });
    let taskRan = false;
    let updateAttempts = 0;
    const originalUpdateRuntimeModels = store.updateRuntimeModels.bind(store);
    store.updateRuntimeModels = ((runtimeId, models) => {
      updateAttempts++;
      if (!taskRan) throw new Error("transient model report failure");
      return originalUpdateRuntimeModels(runtimeId, models);
    }) as typeof store.updateRuntimeModels;
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-model-retry-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const taskProviderFactory = messageProviderFactory({
      text: "task completed during retry",
      sessionId: "sess-model-retry",
      requestId: "req-model-retry",
      onSend: async () => {
        taskRan = true;
      },
    });
    let modelProbeCount = 0;
    const providerFactory: MultiremiDaemonProviderFactory = (options) => ({
      ...taskProviderFactory(options),
      discoverModelCapabilities: async () => {
        modelProbeCount++;
        return [{ id: "claude-retry", label: "Claude Retry", default: true }];
      },
    });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "model-retry-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 10,
      runtimeModelRetryBaseMs: 10,
      runtimeModelRetryMaxMs: 20,
      inProcessRuntimeModelDiscoveryEnabled: true,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory,
    });

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      await waitForCondition(() => store.getTask(task.id)?.status === "completed", 5_000);
      await waitForCondition(() => {
        const runtime = store.listRuntimes()[0];
        return !!runtime && store.listRuntimeModels(runtime.id).some((model) => model.id === "claude-retry");
      }, 5_000);

      expect(taskRan).toBe(true);
      expect(updateAttempts).toBeGreaterThanOrEqual(2);
      // The successful ACP result is cached; a failed PUT retries the report,
      // not the more expensive provider probe.
      expect(modelProbeCount).toBe(1);
    } finally {
      daemon.stop();
      await daemonRun?.catch(() => {});
      server.stop(true);
    }
  });

  it("retries ACP model discovery after an initial startup failure", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-model-probe-retry-");
    const daemonToken = await store.createAccessToken({
      name: "Model probe retry daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-model-probe-retry-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    let modelProbeCount = 0;
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "model-probe-retry-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 10,
      runtimeModelRetryBaseMs: 10,
      runtimeModelRetryMaxMs: 20,
      inProcessRuntimeModelDiscoveryEnabled: true,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
        discoverModelCapabilities: async () => {
          modelProbeCount++;
          if (modelProbeCount === 1) throw new Error("transient ACP probe failure");
          return [{ id: "claude-probe-recovered", label: "Claude Probe Recovered", default: true }];
        },
      }),
    });

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      await waitForCondition(() => {
        const runtime = store.listRuntimes()[0];
        return !!runtime && store.listRuntimeModels(runtime.id).some((model) => model.id === "claude-probe-recovered");
      }, 5_000);
      expect(modelProbeCount).toBe(2);
    } finally {
      daemon.stop();
      await daemonRun?.catch(() => {});
      server.stop(true);
    }
  });

  it("serves repo checkout from the daemon cache to a running provider", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-repo-");
    const sourceRepo = createSourceRepo(join(workDir, "_source", "repo"));
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { github_enabled: false, co_authored_by_enabled: true },
      repos: [{ url: sourceRepo, description: "local source repo" }],
    });
    const agent = store.createAgent({
      name: "Repo Claude",
      provider: "claude",
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Check out the workspace repo" });
    const daemonToken = await store.createAccessToken({
      name: "Repo daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-repo-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    let checkoutPath = "";
    const prompts: string[] = [];
    const providerFactory: MultiremiDaemonProviderFactory = (options) => ({
      async *sendStream(message) {
        prompts.push(message);
        const env = options.env ?? {};
        const response = await fetch(`http://127.0.0.1:${env.MULTIREMI_DAEMON_PORT}/repo/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: sourceRepo,
            workspace_id: env.MULTIREMI_WORKSPACE_ID,
            workdir: options.cwd,
            agent_name: env.MULTIREMI_AGENT_NAME,
            task_id: env.MULTIREMI_TASK_ID,
          }),
        });
        expect(response.status).toBe(200);
        const result = await response.json() as { path: string; branch_name: string };
        checkoutPath = result.path;
        yield {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text: `Checked out ${result.path}` }],
        } as any;
      },
      getLastResponse: () => ({
        text: `Checked out ${checkoutPath}`,
        sessionId: "sess-repo",
        requestId: "req-repo",
      }),
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "repo-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory,
      });

      await daemon.start();

      expect(checkoutPath).toBeTruthy();
      expect(existsSync(join(checkoutPath, "README.md"))).toBe(true);
      expect(readFileSync(join(checkoutPath, "README.md"), "utf8")).toContain("hello from repo");
      expect(execFileSync("git", ["-C", checkoutPath, "branch", "--show-current"], { encoding: "utf8" }).trim().startsWith("agent/repo-claude/")).toBe(true);
      expect(existsSync(prepareCommitMsgHookPath(checkoutPath))).toBe(true);
      expect(prompts[0]).toContain("## Available Repositories");
      expect(prompts[0]).toContain("remi repo checkout <url>");
      expect(prompts[0]).toContain(sourceRepo);
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(store.getTask(task.id)?.result).toContain("Checked out");
    } finally {
      server.stop(true);
    }
  });

  it("starts homepage Chat with zero Git work while preserving Issue auto-checkout", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-chat-no-git-");
    const sourceRepo = createSourceRepo(join(workDir, "_source", "repo"));
    const otherRepo = createSourceRepo(join(workDir, "_source", "other"));
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { github_enabled: false },
      repos: [
        { url: sourceRepo, description: "must stay lazy in Chat" },
        { url: otherRepo, description: "must not be pulled by one checkout" },
      ],
    });
    const agent = store.createAgent({ name: "Lazy Chat Claude", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id, title: "No Git" });
    const hello = store.sendChatMessage(chat.id, { body: "你好" });
    db!.run("UPDATE multiremi_tasks SET priority = 100 WHERE id = ?", [hello.task.id]);
    const issue = store.createIssue({ title: "Still checkout" });
    const issueTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Use the repository", priority: 50 });
    const daemonToken = await store.createAccessToken({
      name: "Chat no-git daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-chat-no-git-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const prompts: string[] = [];
    let checkoutPath = "";
    let turn = 0;
    const providerFactory: MultiremiDaemonProviderFactory = (options) => {
      const current = turn++;
      const text = current === 0
        ? "Hello without Git"
        : current === 1
          ? "Checked out one repository"
          : "Issue used checkout";
      return {
        async *sendStream(message) {
          prompts.push(message);
          if (current === 1) {
            const response = await fetch(`http://127.0.0.1:${options.env?.MULTIREMI_DAEMON_PORT}/repo/checkout`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: sourceRepo,
                workspace_id: "local",
                workdir: options.cwd,
                agent_name: "Lazy Chat Claude",
                task_id: options.env?.MULTIREMI_TASK_ID,
              }),
            });
            expect(response.status).toBe(200);
            checkoutPath = String((await response.json() as { path: string }).path);
          }
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text }],
          } as any;
        },
        getLastResponse: () => ({ text, sessionId: `sess-lazy-${current}`, requestId: `req-lazy-${current}` }),
      };
    };
    const repoCacheRoot = join(workDir, ".repo-cache");
    const runDaemonOnce = () => new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "chat-no-git-runtime",
      provider: "claude",
      workspaceId: "local",
      once: true,
      daemonPort: 0,
      workspacesRoot: join(workDir, "workspaces"),
      repoCacheRoot,
      providerFactory,
    }).start();

    try {
      await runDaemonOnce();
      expect(store.getTask(hello.task.id)?.status).toBe("completed");
      expect(existsSync(join(repoCacheRoot, "local"))).toBe(false);
      expect(prompts[0]).toContain("## Remi Context");
      expect(prompts[0]).toContain("`remi context`");
      expect(prompts[0]).toContain("`remi repo list|get|search`");
      expect(prompts[0]).not.toContain("## Available Repositories");
      expect(prompts[0]).not.toContain(sourceRepo);
      expect(prompts[0]).not.toContain(otherRepo);

      const checkout = store.sendChatMessage(chat.id, { body: "Check out only the primary repository" });
      db!.run("UPDATE multiremi_tasks SET priority = 90 WHERE id = ?", [checkout.task.id]);
      await runDaemonOnce();
      expect(store.getTask(checkout.task.id)?.status).toBe("completed");
      expect(existsSync(join(checkoutPath, "README.md"))).toBe(true);
      const cache = new MultiremiRepoCache(repoCacheRoot);
      expect(cache.lookup("local", sourceRepo)).not.toBeNull();
      expect(cache.lookup("local", otherRepo)).toBeNull();

      await runDaemonOnce();
      expect(store.getTask(issueTask.id)?.status).toBe("completed");
      expect(existsSync(join(repoCacheRoot, "local"))).toBe(true);
      expect(prompts[2]).toContain("## Available Repositories");
      expect(prompts[2]).toContain(sourceRepo);
      expect(store.getIssueWorkspace(issue.id)?.repos[0]).toMatchObject({ status: "ready" });
    } finally {
      server.stop(true);
    }
  });

  it("auto-checks out repos into the stable Issue workspace and reports it", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-autorepo-");
    const sourceRepo = createSourceRepo(join(workDir, "_source", "repo"));
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { github_enabled: false, co_authored_by_enabled: false },
      repos: [{ url: sourceRepo, description: "local source repo" }],
    });
    // Issue work is always materialized in the canonical Issue workspace.
    const agent = store.createAgent({ name: "Repo Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Auto checkout issue" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Work in the repo" });
    const daemonToken = await store.createAccessToken({
      name: "Auto repo daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-repo-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const prompts: string[] = [];
    const providerFactory = messageProviderFactory({
      text: "worked in checked-out repo",
      sessionId: "sess-auto-repo",
      requestId: "req-auto-repo",
      onSend: (message) => { prompts.push(message); },
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "auto-repo-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(workDir, "workspaces"),
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory,
      });

      await daemon.start();

      expect(store.getTask(task.id)?.status).toBe("completed");
      const worktree = join(workDir, "workspaces", "issues", issue.key, "repo");
      expect(existsSync(join(worktree, "README.md"))).toBe(true);
      const branch = gitOutput(worktree, ["branch", "--show-current"]);
      expect(branch).toBe(`agent/${issue.key}`);
      expect(prompts[0]).toContain("already checked out into the working directory");
      expect(prompts[0]).toContain(`on branch \`${branch}\``);
      expect(prompts[0]).not.toContain("For repositories without a path above");

      expect(store.listIssueSessionResults(issue.id)).toHaveLength(0);
      expect(store.getIssueWorkspace(issue.id)).toMatchObject({
        issueId: issue.id,
        rootPath: join(workDir, "workspaces", "issues", issue.key),
        branchName: branch,
        status: "ready",
        repos: [{ repoName: "repo", worktreePath: worktree, branchName: branch }],
      });
    } finally {
      server.stop(true);
    }
  });

  it("continues an Issue task and tells the agent about stale and unavailable repositories", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-repo-warning-");
    const sourceRepo = createSourceRepo(join(workDir, "_source", "cached-repo"));
    const repoCacheRoot = join(workDir, ".repo-cache");
    const cache = new MultiremiRepoCache(repoCacheRoot);
    await cache.sync("local", [{ url: sourceRepo }]);
    rmSync(sourceRepo, { recursive: true, force: true });
    const unavailableRepo = join(workDir, "missing", "repo.git");
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { github_enabled: false, co_authored_by_enabled: false },
      repos: [
        { url: sourceRepo, description: "cached source repo" },
        { url: unavailableRepo, description: "unavailable source repo" },
      ],
    });
    const agent = store.createAgent({ name: "Repo Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Unavailable checkout issue" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Inspect the repo" });
    const daemonToken = await store.createAccessToken({
      name: "Repo warning daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-repo-warning-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const prompts: string[] = [];

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "repo-warning-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(workDir, "workspaces"),
        repoCacheRoot,
        providerFactory: messageProviderFactory({
          text: "reported unavailable repo",
          sessionId: "sess-repo-warning",
          requestId: "req-repo-warning",
          onSend: (message) => { prompts.push(message); },
        }),
      });

      await daemon.start();

      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(prompts[0]).toContain("## Repository Availability Warnings");
      expect(prompts[0]).toContain(sourceRepo);
      expect(prompts[0]).toContain(unavailableRepo);
      expect(prompts[0]).toContain("may use stale cached data");
      expect(prompts[0]).toContain("checkout is unavailable");
      expect(prompts[0]).toContain("Do not claim that you inspected its source code");
    } finally {
      server.stop(true);
    }
  });

  it("degrades an intake task to repo warnings and keeps the error workspace status after the run", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-intake-degraded-");
    // github_repo project resources require remote-looking URLs; .invalid never
    // resolves, so every refresh attempt fails fast and deterministically.
    const cachedRepo = "git@invalid.invalid:intake/cached-repo.git";
    const unavailableRepo = "git@invalid.invalid:intake/missing-repo.git";
    const sourceRepo = createSourceRepo(join(workDir, "_source", "cached-repo"));
    const repoCacheRoot = join(workDir, ".repo-cache");
    // Seed the daemon cache for cachedRepo by hand (its remote is unreachable):
    // a bare mirror at the cache path the daemon derives from the URL, with the
    // remote-tracking layout sync would have produced.
    const cachedDigest = createHash("sha256").update(cachedRepo).digest("hex").slice(0, 16);
    const cachedBarePath = join(repoCacheRoot, "local", `cached-repo-${cachedDigest}.git`);
    mkdirSync(join(repoCacheRoot, "local"), { recursive: true });
    execFileSync("git", ["clone", "--bare", sourceRepo, cachedBarePath], { stdio: "pipe" });
    execFileSync("git", ["--git-dir", cachedBarePath, "fetch", sourceRepo, "+refs/heads/*:refs/remotes/origin/*"], { stdio: "pipe" });
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      settings: { github_enabled: false, co_authored_by_enabled: false },
      repos: [
        { url: cachedRepo, description: "cached source repo" },
        { url: unavailableRepo, description: "unavailable source repo" },
      ],
    });
    const project = store.createProject({
      title: "Intake project",
      resources: [
        { resourceType: "github_repo", resourceRef: { url: cachedRepo } },
        { resourceType: "github_repo", resourceRef: { url: unavailableRepo } },
      ],
    });
    const agent = store.createAgent({ name: "Intake Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Degraded intake", issueKind: "intake", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Triage the request" });
    const daemonToken = await store.createAccessToken({
      name: "Intake degraded daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-intake-degraded-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const prompts: string[] = [];

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "intake-degraded-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(workDir, "workspaces"),
        repoCacheRoot,
        providerFactory: messageProviderFactory({
          text: "triaged with degraded repos",
          sessionId: "sess-intake-degraded",
          requestId: "req-intake-degraded",
          onSend: (message) => { prompts.push(message); },
        }),
      });

      await daemon.start();

      // The intake round completes on the cached snapshot instead of failing.
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(prompts[0]).toContain("## Repository Availability Warnings");
      expect(prompts[0]).toContain("may use stale cached data");
      expect(prompts[0]).toContain("checkout is unavailable");
      const workspace = store.getIssueWorkspace(issue.id);
      expect(workspace?.status).toBe("error");
      const statusByUrl = new Map((workspace?.repos ?? []).map((repo) => [repo.repoUrl, repo.status]));
      expect(statusByUrl.get(cachedRepo)).toBe("ready");
      expect(statusByUrl.get(unavailableRepo)).toBe("error");
    } finally {
      server.stop(true);
    }
  }, 120_000);

  it("resumes chat tasks with the pinned provider session after daemon restart", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-chat-resume-");
    const workspacesRoot = join(workDir, "workspaces");
    const agent = store.createAgent({
      name: "Chat Claude",
      provider: "claude",
      model: "claude-chat",
      thinkingLevel: "xhigh",
      mcpConfig: { mcpServers: { recall: { command: "/bin/recall", env: { TOKEN: "t" } } } },
    });
    const session = store.createChatSession({ agentId: agent.id, title: "Resume chat" });
    const first = store.sendChatMessage(session.id, { body: "Start the chat" });
    const daemonToken = await store.createAccessToken({
      name: "Chat resume daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-chat-resume-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const prompts: string[] = [];
    const providerCwds: string[] = [];
    const providerHomes: Array<string | undefined> = [];
    const injectedMcpServers: unknown[] = [];
    const sendOptions: SendOptions[] = [];
    let providerIndex = 0;
    const providerFactory: MultiremiDaemonProviderFactory = (options) => {
      const turn = providerIndex++;
      providerCwds.push(options.cwd!);
      providerHomes.push(options.env?.CLAUDE_CONFIG_DIR);
      injectedMcpServers.push(options.getMcpServers?.() ?? []);
      const text = turn === 0
        ? "First answer"
        : turn === 1
          ? "Second answer"
          : "Recovered answer";
      return {
        async *sendStream(message, options) {
          prompts.push(message);
          sendOptions.push(options ?? {});
          if (turn === 2) throw new Error("no conversation found for session sess-chat-2");
          yield {
            sessionUpdate: "agent_message_chunk",
            content: [{ type: "text", text }],
          } as any;
        },
        getLastResponse: () => turn === 2
          ? null
          : ({
              text,
              sessionId: turn === 0 ? "sess-chat-1" : turn === 1 ? "sess-chat-2" : "sess-chat-3",
              requestId: `req-chat-${turn + 1}`,
            }),
      };
    };
    const runDaemonOnce = () => new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "chat-resume-runtime",
      provider: "claude",
      workspaceId: "local",
      once: true,
      daemonPort: 0,
      workspacesRoot,
      repoCacheRoot: join(workDir!, ".repo-cache"),
      providerFactory,
    }).start();

    try {
      await runDaemonOnce();
      const chatWorkDir = join(workspacesRoot, "chats", session.id);

      expect(store.getTask(first.task.id)?.status).toBe("completed");
      expect(store.getChatSession(session.id)).toMatchObject({
        sessionId: "sess-chat-1",
        workDir: chatWorkDir,
        latestTaskId: first.task.id,
      });

      const second = store.sendChatMessage(session.id, { body: "Continue with the same provider session" });
      expect(second.task.sessionId).toBe("sess-chat-1");
      expect(second.task.workDir).toBe(chatWorkDir);

      await runDaemonOnce();

      expect(store.getTask(second.task.id)).toMatchObject({
        status: "completed",
        result: "Second answer",
        sessionId: "sess-chat-2",
        workDir: chatWorkDir,
      });
      expect(sendOptions).toHaveLength(2);
      expect(sendOptions[0].sessionId ?? null).toBeNull();
      expect(sendOptions[0]).toMatchObject({
        cwd: chatWorkDir,
        chatId: first.task.id,
      });
      expect(sendOptions[1]).toMatchObject({
        cwd: chatWorkDir,
        sessionId: "sess-chat-1",
        chatId: second.task.id,
      });
      expect(providerCwds).toEqual([chatWorkDir, chatWorkDir]);
      const chatProviderHome = join(
        workspacesRoot,
        ".runtime",
        session.id,
        agent.id,
        "1",
        "home",
      );
      expect(providerHomes).toEqual([chatProviderHome, chatProviderHome]);
      expect(existsSync(chatProviderHome)).toBe(true);
      expect(JSON.parse(readFileSync(
        join(workspacesRoot, ".runtime", session.id, ".multiremi", "gc.json"),
        "utf8",
      ))).toMatchObject({
        kind: "chat",
        chat_session_id: session.id,
        task_id: second.task.id,
      });
      // The continued turn re-sends everything session/resume needs: the agent's
      // model + thinking_level (claim → SendOptions) and the MCP servers, in the
      // ACP wire shape (args/env required, env an EnvVariable[]).
      expect(sendOptions.map((options) => [options.model, options.effort])).toEqual([
        ["claude-chat", "xhigh"],
        ["claude-chat", "xhigh"],
      ]);
      expect(JSON.stringify(injectedMcpServers)).toBe(
        '[[{"name":"recall","command":"/bin/recall","args":[],"env":[{"name":"TOKEN","value":"t"}]}],'
        + '[{"name":"recall","command":"/bin/recall","args":[],"env":[{"name":"TOKEN","value":"t"}]}]]',
      );
      expect(prompts[0]).toContain("Start the chat");
      expect(prompts[1]).toContain("Continue with the same provider session");
      expect(store.listChatMessages(session.id).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(store.getChatSession(session.id)).toMatchObject({
        sessionId: "sess-chat-2",
        workDir: chatWorkDir,
        latestTaskId: second.task.id,
      });

      const stale = store.sendChatMessage(session.id, { body: "Recover from product history" });
      await runDaemonOnce();
      expect(store.getTask(stale.task.id)).toMatchObject({
        status: "failed",
        failureReason: "agent_error.stale_session",
      });
      expect(store.getChatSession(session.id)).toMatchObject({
        sessionId: null,
        workDir: null,
        sessionRuntimeId: null,
        sessionProvider: null,
        sessionExecutionFingerprint: null,
      });
      const retry = store.listTasks().find((task) => task.parentTaskId === stale.task.id)!;
      expect(retry).toMatchObject({ attempt: 2, sessionId: null, workDir: null, runtimeId: null });

      await runDaemonOnce();
      expect(store.getTask(retry.id)).toMatchObject({
        status: "completed",
        result: "Recovered answer",
        sessionId: "sess-chat-3",
      });
      expect(sendOptions).toHaveLength(4);
      expect(sendOptions[2]?.sessionId).toBe("sess-chat-2");
      expect(sendOptions[3]?.sessionId ?? null).toBeNull();
      expect(prompts[3]).toContain("## Current Session Context");
      expect(prompts[3]).toContain(`"body":"Start the chat"`);
      expect(prompts[3]).toContain(`"body":"Second answer"`);
      expect(prompts[3]?.match(/Recover from product history/g)).toHaveLength(1);
      expect(prompts[3]).toContain("`remi context`");
      expect(prompts[3]).not.toContain("## Available Repositories");
      expect(store.listChatMessages(session.id).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(store.getChatSession(session.id)).toMatchObject({
        sessionId: "sess-chat-3",
        latestTaskId: retry.id,
      });
    } finally {
      server.stop(true);
    }
  });

  it("ignores a legacy local_directory when resolving an Issue workspace", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-local-dir-");
    store.upsertRelayConfig("local", "claude", {
      fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://ai.openremi.fun" } }),
      tokenOp: "set",
      authToken: "test-provider-key",
    });
    const localDir = join(workDir, "local-project");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "README.md"), "local project\n");
    const project = store.createProject({
      title: "Local project",
      resources: [{
        resourceType: "local_directory",
        resourceRef: { localPath: localDir, daemonId: "daemon-local", label: "local project" },
      }],
    });
    const agent = store.createAgent({
      name: "Local Claude",
      provider: "claude",
    });
    const issue = store.createIssue({ title: "Use local directory", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Read the local project" });
    const daemonToken = await store.createAccessToken({
      name: "Local directory daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-local-dir-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    let providerCwd = "";
    let providerPrompt = "";
    let providerOptions: AcpProviderOptions | null = null;
    let workspaceAtProviderStart: ReturnType<typeof store.getIssueWorkspace> = null;
    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "local-dir-runtime",
        provider: "claude",
        workspaceId: "local",
        daemonId: "daemon-local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(workDir, "workspaces"),
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: (options) => {
          providerOptions = options;
          workspaceAtProviderStart = store.getIssueWorkspace(issue.id);
          return messageProviderFactory({
            text: () => `cwd=${providerCwd}`,
            sessionId: "sess-local-dir",
            requestId: "req-local-dir",
            onSend: (message, sendOptions) => {
              providerCwd = sendOptions.cwd!;
              providerPrompt = message;
            },
          })(options);
        },
      });

      await daemon.start();

      const completed = store.getTask(task.id)!;
      const issueWorkDir = join(workDir, "workspaces", "issues", issue.key);
      expect(providerCwd).toBe(issueWorkDir);
      expect(workspaceAtProviderStart).toMatchObject({
        issueId: issue.id,
        rootPath: issueWorkDir,
        status: "preparing",
        repos: [],
      });
      expect(completed.status).toBe("completed");
      expect(completed.workDir).toBe(issueWorkDir);
      const laneGeneration = completed.issueSessionGeneration ?? completed.issue_session_generation;
      const expectedProviderHome = join(
        workDir,
        "workspaces",
        ".runtime",
        completed.issueSessionId!,
        agent.id,
        String(laneGeneration),
        "home",
      );
      const capturedProviderOptions = providerOptions as AcpProviderOptions | null;
      expect(capturedProviderOptions?.env?.CLAUDE_CONFIG_DIR).toBe(expectedProviderHome);
      expect(capturedProviderOptions?.env?.ANTHROPIC_API_KEY).toBe("");
      expect(capturedProviderOptions?.env?.ANTHROPIC_AUTH_TOKEN).toBe("test-provider-key");
      expect(capturedProviderOptions?.env?.ANTHROPIC_BASE_URL).toBe("https://ai.openremi.fun");
      expect(existsSync(join(expectedProviderHome, ".multiremi-session-home.json"))).toBe(true);
      expect(providerPrompt).not.toContain(localDir);
      expect(existsSync(join(localDir, ".multiremi"))).toBe(false);
      expect(JSON.parse(readFileSync(join(issueWorkDir, ".multiremi", "gc.json"), "utf8"))).toMatchObject({
        kind: "issue",
        task_id: task.id,
        issue_id: issue.id,
        version: 2,
      });
      expect(JSON.parse(readFileSync(join(issueWorkDir, ".multiremi", "project", "resources.json"), "utf8")).resources).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  it("passes an Issue-scoped CODEX_HOME and in-memory key to the ACP provider", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-codex-home-");
    store.upsertRelayConfig("local", "codex", {
      fragment: [
        'model_provider = "OpenAI"',
        "",
        "[model_providers.OpenAI]",
        'base_url = "https://ai.openremi.fun/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
      ].join("\n"),
      tokenOp: "set",
      authToken: "test-openai-key",
    });
    const workspacesRoot = join(workDir, "workspaces");
    const agent = store.createAgent({
      name: "Issue Codex",
      provider: "codex",
    });
    const issue = store.createIssue({ title: "Capture Codex home", workspaceId: "local" });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      workspaceId: "local",
      prompt: "Capture the provider environment",
    });
    const daemonToken = await store.createAccessToken({
      name: "Codex home daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-codex-home-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    let providerOptions: AcpProviderOptions | null = null;
    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "codex-home-runtime",
        provider: "codex",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: (options) => {
          providerOptions = options;
          return messageProviderFactory({
            text: "Codex home captured",
            sessionId: "sess-codex-home",
            requestId: "req-codex-home",
          })(options);
        },
      });

      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      const expectedHome = join(
        workspacesRoot,
        ".runtime",
        completed.issueSessionId!,
        agent.id,
        String(completed.issueSessionGeneration ?? completed.issue_session_generation),
        "executions",
        completed.executionFingerprint!,
        "home",
      );
      const captured = providerOptions as AcpProviderOptions | null;
      expect(captured?.env?.CODEX_HOME).toBe(expectedHome);
      expect(captured?.env?.OPENAI_API_KEY).toBe("test-openai-key");
      expect(captured?.codexHome).toBe(expectedHome);
      expect(existsSync(join(expectedHome, "auth.json"))).toBe(false);
      expect(existsSync(join(expectedHome, ".multiremi-session-home.json"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("reclaims daemon-owned workspace dirs from gc metadata", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-gc-");
    const workspacesRoot = join(workDir, "workspaces");
    const agent = store.createAgent({
      name: "GC Claude",
      provider: "claude",
    });
    const completedIssue = store.createIssue({ title: "GC completed issue", workspaceId: "local" });
    const completedTask = store.createTask({
      agentId: agent.id,
      issueId: completedIssue.id,
      workspaceId: "local",
      prompt: "Create a daemon-owned directory",
    });
    const activeIssue = store.createIssue({ title: "GC active issue", workspaceId: "local" });
    const deletedChat = store.createChatSession({ agentId: agent.id, workspaceId: "local", title: "Deleted GC chat" });
    const daemonToken = await store.createAccessToken({
      name: "GC daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-gc-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "gc-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot,
        repoCacheRoot: join(workDir, ".repo-cache"),
        gcEnabled: false,
        gcTtlMs: 0,
        gcOrphanTtlMs: 1,
        providerFactory: messageProviderFactory({
          text: "GC completed",
          sessionId: "sess-gc",
          requestId: "req-gc",
        }),
      });

      await daemon.start();

      const completedDir = join(workspacesRoot, "issues", completedIssue.key);
      expect(existsSync(completedDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(completedDir, ".multiremi", "gc.json"), "utf8"))).toMatchObject({
        kind: "issue",
        task_id: completedTask.id,
        issue_id: completedIssue.id,
        workspace_id: "local",
      });

      const oldIso = new Date(Date.now() - 10_000).toISOString();
      db!.run("UPDATE multiremi_issues SET status = 'done', updated_at = ? WHERE id = ?", [oldIso, completedIssue.id]);

      const activeDir = join(workspacesRoot, "issues", "active-issue");
      writeGcFixture(activeDir, {
        kind: "issue",
        task_id: "task-active",
        issue_id: activeIssue.id,
        workspace_id: "local",
      });

      const chatDir = join(workspacesRoot, "chats", "deleted-chat");
      writeGcFixture(chatDir, {
        kind: "chat",
        task_id: "task-chat",
        chat_session_id: deletedChat.id,
        workspace_id: "local",
      });
      db!.run("DELETE FROM multiremi_chat_sessions WHERE id = ?", [deletedChat.id]);

      const orphanDir = join(workspacesRoot, "tasks", "old-orphan");
      mkdirSync(orphanDir, { recursive: true });
      writeFileSync(join(orphanDir, "note.txt"), "stale orphan\n");
      const oldDate = new Date(Date.now() - 10_000);
      utimesSync(orphanDir, oldDate, oldDate);

      expect(await daemon.runGcOnce()).toEqual({ cleaned: 2, orphaned: 1, skipped: 1 });
      expect(existsSync(completedDir)).toBe(false);
      expect(existsSync(chatDir)).toBe(false);
      expect(existsSync(orphanDir)).toBe(false);
      expect(existsSync(activeDir)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("writes autopilot run metadata and reclaims terminal autopilot workdirs", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-autopilot-gc-");
    const workspacesRoot = join(workDir, "workspaces");
    const agent = store.createAgent({
      name: "Autopilot GC Claude",
      provider: "claude",
    });
    const autopilot = store.createAutopilot({
      title: "Autopilot GC",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const run = store.runAutopilot(autopilot.id);
    const daemonToken = await store.createAccessToken({
      name: "Autopilot GC daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-autopilot-gc-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "autopilot-gc-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot,
        repoCacheRoot: join(workDir, ".repo-cache"),
        gcEnabled: false,
        gcTtlMs: 0,
        providerFactory: messageProviderFactory({
          text: "Autopilot GC completed",
          sessionId: "sess-autopilot-gc",
          requestId: "req-autopilot-gc",
        }),
      });

      await daemon.start();

      const taskDir = join(workspacesRoot, "tasks", run.taskId!);
      expect(existsSync(taskDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(taskDir, ".multiremi", "gc.json"), "utf8"))).toMatchObject({
        kind: "autopilot_run",
        task_id: run.taskId,
        autopilot_run_id: run.id,
        workspace_id: "local",
      });

      const oldIso = new Date(Date.now() - 10_000).toISOString();
      db!.run("UPDATE multiremi_autopilot_runs SET completed_at = ? WHERE id = ?", [oldIso, run.id]);

      expect(await daemon.runGcOnce()).toEqual({ cleaned: 1, orphaned: 0, skipped: 0 });
      expect(existsSync(taskDir)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("handles heartbeat maintenance requests for update, models, and local skills", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-maintenance-");
    const skillsRoot = join(workDir, "skills");
    const skillDir = join(skillsRoot, "review-helper");
    const linkedSkillSource = join(workDir, "shared-skills", "linked-helper");
    const linkedSkillPath = join(skillsRoot, "linked-helper");
    const nestedSkillDir = join(skillsRoot, "team", "review", "deep", "helper");
    const tooDeepSkillDir = join(skillsRoot, "team", "review", "deep", "too", "far");
    mkdirSync(join(skillDir, "notes"), { recursive: true });
    mkdirSync(linkedSkillSource, { recursive: true });
    mkdirSync(nestedSkillDir, { recursive: true });
    mkdirSync(tooDeepSkillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Review Helper\ndescription: Review local changes\n---\n# Review Helper\n");
    writeFileSync(join(skillDir, "notes", "check.md"), "Check carefully\n");
    writeFileSync(join(skillDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]));
    writeFileSync(join(skillDir, "LICENSE"), "ignored\n");
    writeFileSync(join(linkedSkillSource, "SKILL.md"), "---\nname: Linked Helper\n---\n# Linked Helper\n");
    writeFileSync(join(nestedSkillDir, "SKILL.md"), "---\nname: Nested Helper\ndescription: Four level skill\n---\n# Nested Helper\n");
    writeFileSync(join(tooDeepSkillDir, "SKILL.md"), "---\nname: Too Deep Helper\n---\n# Too Deep Helper\n");
    symlinkSync(linkedSkillSource, linkedSkillPath, "dir");

    const runtimeId = "rt_daemon_maintenance";
    store.registerRuntime({ id: runtimeId, name: "maintenance-runtime", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({
      name: "Maintenance Claude",
      provider: "claude",
    });
    const queuedTask = store.createTask({ agentId: agent.id, prompt: "Do not claim before restart" });
    const updateRequest = store.createRuntimeUpdateRequest(runtimeId, { target_version: "v9.9.9" });
    const modelRequest = store.createRuntimeModelListRequest(runtimeId);
    const localSkillRequest = store.createRuntimeLocalSkillListRequest(runtimeId);
    const importRequest = store.createRuntimeLocalSkillImportRequest(runtimeId, {
      skill_key: "review-helper",
      name: "Imported Review Helper",
    });
    const nestedImportRequest = store.createRuntimeLocalSkillImportRequest(runtimeId, {
      skill_key: "team/review/deep/helper",
    });
    const tooDeepImportRequest = store.createRuntimeLocalSkillImportRequest(runtimeId, {
      skill_key: "team/review/deep/too/far",
    });
    const daemonToken = await store.createAccessToken({
      name: "Maintenance daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-maintenance-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    const updateTargets: string[] = [];
    let modelProbeCount = 0;
    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeId,
        runtimeName: "maintenance-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        inProcessRuntimeModelDiscoveryEnabled: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        localSkillRoots: { claude: skillsRoot },
        updateRunner: async (targetVersion) => {
          updateTargets.push(targetVersion);
          return `Updated to ${targetVersion}`;
        },
        providerFactory: () => ({
          async *sendStream() {},
          getLastResponse: () => null,
          discoverModelCapabilities: async () => {
            modelProbeCount++;
            return [
              {
                id: "claude-dynamic",
                label: "Claude Dynamic",
                default: true,
                effort: {
                  supportedLevels: [
                    { value: "low", label: "Low" },
                    { value: "xhigh", label: "Extra high" },
                  ],
                },
              },
            ];
          },
        }),
      });

      await daemon.start();

      expect(updateTargets).toEqual(["v9.9.9"]);
      expect(daemon.restartRequested()).toBe(true);
      expect(store.getTask(queuedTask.id)?.status).toBe("queued");
      expect(store.getRuntimeUpdateRequest(runtimeId, updateRequest.id)).toMatchObject({
        status: "completed",
        output: "Updated to v9.9.9",
      });
      expect(store.getRuntimeModelListRequest(runtimeId, modelRequest.id)).toMatchObject({
        status: "completed",
        supported: true,
      });
      expect(modelProbeCount).toBe(1);
      expect(store.listRuntimeModels(runtimeId)).toEqual([
        expect.objectContaining({
          id: "claude-dynamic",
          label: "Claude Dynamic",
          provider: "anthropic",
          default: true,
          thinking: {
            supportedLevels: [
              { value: "low", label: "Low" },
              { value: "xhigh", label: "Extra high" },
            ],
          },
        }),
      ]);

      const localSkillList = store.getRuntimeLocalSkillListRequest(runtimeId, localSkillRequest.id)!;
      expect(localSkillList.status).toBe("completed");
      expect(localSkillList.skills).toHaveLength(3);
      const skillsByKey = new Map(localSkillList.skills.map((skill) => [skill.key, skill]));
      expect(skillsByKey.get("review-helper")).toMatchObject({
        key: "review-helper",
        name: "Review Helper",
        description: "Review local changes",
        provider: "claude",
        fileCount: 2,
      });
      expect(skillsByKey.get("linked-helper")).toMatchObject({
        key: "linked-helper",
        name: "Linked Helper",
        provider: "claude",
        fileCount: 1,
      });
      expect(skillsByKey.get("team/review/deep/helper")).toMatchObject({
        key: "team/review/deep/helper",
        name: "Nested Helper",
        description: "Four level skill",
        provider: "claude",
        fileCount: 1,
      });
      expect(skillsByKey.has("team/review/deep/too/far")).toBe(false);

      const imported = store.getRuntimeLocalSkillImportRequest(runtimeId, importRequest.id)!;
      expect(imported.status).toBe("completed");
      expect(imported.skill?.name).toBe("Imported Review Helper");
      expect(imported.skill?.config?.origin).toMatchObject({
        type: "runtime_local",
        runtime_id: runtimeId,
        provider: "claude",
        source_path: skillDir,
      });
      expect(imported.skill?.files?.map((file) => file.path)).toEqual(["notes/check.md"]);
      const nestedImported = store.getRuntimeLocalSkillImportRequest(runtimeId, nestedImportRequest.id)!;
      expect(nestedImported.status).toBe("completed");
      expect(nestedImported.skill?.name).toBe("Nested Helper");
      expect(nestedImported.skill?.config?.origin).toMatchObject({
        type: "runtime_local",
        runtime_id: runtimeId,
        provider: "claude",
        source_path: nestedSkillDir,
      });
      const tooDeepImported = store.getRuntimeLocalSkillImportRequest(runtimeId, tooDeepImportRequest.id)!;
      expect(tooDeepImported.status).toBe("failed");
      expect(tooDeepImported.error).toBe("local skill key exceeds 4 directory levels");
      expect(tooDeepImported.skill).toBeNull();
      const metadata = store.getRuntime(runtimeId)?.metadata ?? {};
      expect(metadata.launched_by).toBe("manual");
      expect(typeof metadata.cli_version).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  it("keeps the last runtime model snapshot when ACP discovery fails", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-model-probe-failure-");
    const runtimeId = "rt_model_probe_failure";
    store.registerRuntime({
      id: runtimeId,
      name: "model-probe-failure-runtime",
      provider: "claude",
      workspaceId: "local",
      models: [{
        id: "claude-known-good",
        label: "Claude Known Good",
        provider: "anthropic",
        default: true,
      }],
    });
    const request = store.createRuntimeModelListRequest(runtimeId);
    const daemonToken = await store.createAccessToken({
      name: "Model probe failure daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-model-probe-failure-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeId,
        runtimeName: "model-probe-failure-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        inProcessRuntimeModelDiscoveryEnabled: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: () => ({
          async *sendStream() {},
          getLastResponse: () => null,
          discoverModelCapabilities: async () => {
            throw new Error("probe unavailable");
          },
        }),
      });

      await daemon.start();

      expect(store.getRuntimeModelListRequest(runtimeId, request.id)).toMatchObject({
        status: "failed",
        error: "probe unavailable",
      });
      expect(store.listRuntimeModels(runtimeId).map((model) => model.id)).toEqual(["claude-known-good"]);
    } finally {
      server.stop(true);
    }
  });

  it("fails Runtime model-list requests closed without probing or clearing the last snapshot", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-model-probe-disabled-request-");
    const runtimeId = "rt_model_probe_disabled_request";
    store.registerRuntime({
      id: runtimeId,
      name: "model-probe-disabled-request-runtime",
      provider: "claude",
      workspaceId: "local",
      models: [{
        id: "claude-known-good",
        label: "Claude Known Good",
        provider: "anthropic",
        default: true,
      }],
    });
    const request = store.createRuntimeModelListRequest(runtimeId);
    const daemonToken = await store.createAccessToken({
      name: "Model probe disabled request daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-model-probe-disabled-request-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    let providerFactoryCalls = 0;

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeId,
        runtimeName: "model-probe-disabled-request-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: () => {
          providerFactoryCalls++;
          return {
            async *sendStream() {},
            getLastResponse: () => null,
            discoverModelCapabilities: async () => [{
              id: "must-not-probe",
              label: "Must Not Probe",
              default: true,
            }],
          };
        },
      });

      await daemon.start();

      expect(store.getRuntimeModelListRequest(runtimeId, request.id)).toMatchObject({
        status: "failed",
        supported: true,
        error: "Runtime model discovery is temporarily disabled in the daemon process; gateway models remain available",
      });
      expect(providerFactoryCalls).toBe(0);
      expect(store.listRuntimeModels(runtimeId).map((model) => model.id)).toEqual(["claude-known-good"]);
    } finally {
      server.stop(true);
    }
  });

  it("refuses runtime update requests when the daemon is managed by Desktop", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-desktop-update-");
    const runtimeId = "rt_daemon_desktop";
    store.registerRuntime({ id: runtimeId, name: "desktop-runtime", provider: "claude", workspaceId: "local" });
    const updateRequest = store.createRuntimeUpdateRequest(runtimeId, { target_version: "v9.9.10" });
    const daemonToken = await store.createAccessToken({
      name: "Desktop daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-desktop-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeId,
        runtimeName: "desktop-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        launchedBy: "desktop",
        updateRunner: () => {
          throw new Error("desktop-managed daemon should not self-update");
        },
      });

      await daemon.start();

      const failed = store.getRuntimeUpdateRequest(runtimeId, updateRequest.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("CLI is managed by Multiremi Desktop - update the Desktop app to upgrade the CLI");
      expect(store.getRuntime(runtimeId)?.metadata).toMatchObject({ launched_by: "desktop" });
    } finally {
      server.stop(true);
    }
  });

  it("serves local daemon health and shutdown for background lifecycle control", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-health-");
    const daemonToken = await store.createAccessToken({
      name: "Lifecycle daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-lifecycle-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeName: "lifecycle-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 25,
      gcIntervalMs: 10,
      repoCacheRoot: join(workDir, ".repo-cache"),
    });
    const gcStarted = deferred<void>();
    const releaseGc = deferred<void>();
    const topicActions: string[] = [];
    Object.assign(daemon, {
      executeGcOnce: async () => {
        gcStarted.resolve();
        await releaseGc.promise;
        return { cleaned: 0, orphaned: 0, skipped: 0 };
      },
      topicWorkspaces: {
        prepareMigration: async (cwd: string) => {
          topicActions.push(`prepare:${cwd}`);
          return { bound: true, migration_id: "mig_http" };
        },
        commitMigration: async (input: { issueKey: string }) => {
          topicActions.push(`commit:${input.issueKey}`);
          return {
            migrated: true,
            issue_id: "iss_http",
            issue_key: input.issueKey,
            path: join(workDir, "workspaces", input.issueKey),
            session_key: "session-http",
            topic_id: "om_http",
          };
        },
      },
    });

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      const port = await waitForLocalPort(daemon);
      const health = await waitForRunningHealth(port);
      await withTimeout(gcStarted.promise, 5_000, "scheduled GC did not begin");

      expect(health).toMatchObject({
        status: "running",
        pid: process.pid,
        runtime_name: "lifecycle-runtime",
        provider: "claude",
        workspace_id: "local",
        workspace_cleanup_capability: process.platform === "linux" ? "available" : "blocked",
      });
      if (process.platform === "linux") expect(health.workspace_cleanup_error).toBeNull();
      else expect(health.workspace_cleanup_error).toEqual(expect.any(String));
      expect(typeof health.runtime_id).toBe("string");
      expect(typeof health.cli_version).toBe("string");

      const topicCwd = join(workDir, "workspaces", "_topics", "om_http");
      const prepare = await fetch(`http://127.0.0.1:${port}/topic/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", cwd: topicCwd }),
      });
      expect(prepare.status).toBe(200);
      expect(await prepare.json()).toMatchObject({ bound: true, migration_id: "mig_http" });
      const commit = await fetch(`http://127.0.0.1:${port}/topic/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit",
          cwd: topicCwd,
          migration_id: "mig_http",
          issue_id: "iss_http",
          issue_key: "MUL-204",
        }),
      });
      expect(commit.status).toBe(200);
      expect(await commit.json()).toMatchObject({ migrated: true, issue_key: "MUL-204" });
      expect(topicActions).toEqual([`prepare:${topicCwd}`, "commit:MUL-204"]);

      const shutdown = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
      expect(shutdown.status).toBe(200);
      expect(await shutdown.json()).toEqual({ status: "shutting_down" });
      await new Promise((resolve) => setTimeout(resolve, 75));

      // The control port is the restart fence. It stays bound until the old
      // process has drained its active archive/delete sweep.
      const drainingHealth = await fetch(`http://127.0.0.1:${port}/health`);
      expect(drainingHealth.status).toBe(200);
      expect(["running", "starting"]).toContain((await drainingHealth.json() as { status: string }).status);
      let daemonStopped = false;
      void daemonRun.then(() => {
        daemonStopped = true;
      });
      await Promise.resolve();
      expect(daemonStopped).toBe(false);

      releaseGc.resolve();
      await daemonRun;
      expect(daemon.localPort()).toBe(0);
    } finally {
      releaseGc.resolve();
      daemon.stop();
      await daemonRun?.catch(() => {});
      server.stop(true);
    }
  });

  it("re-registers and continues when heartbeat reports runtime_gone", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-runtime-gone-");
    const agent = store.createAgent({
      name: "Recovered Claude",
      provider: "claude",
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Recover and continue" });
    const daemonToken = await store.createAccessToken({
      name: "Runtime gone daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const originalHeartbeat = store.heartbeatRuntime.bind(store);
    let injectedRuntimeGone = false;
    store.heartbeatRuntime = ((runtimeId, options) => {
      if (!injectedRuntimeGone) {
        injectedRuntimeGone = true;
        // Simulate the server losing the row unexpectedly. The product delete
        // path intentionally protects a daemon's last Runtime and therefore is
        // not the right primitive for a runtime_gone recovery test.
        db!.run("DELETE FROM multiremi_runtimes WHERE id = ?", [runtimeId]);
      }
      return originalHeartbeat(runtimeId, options);
    }) as typeof store.heartbeatRuntime;
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-runtime-gone-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "runtime-gone-daemon",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        providerFactory: messageProviderFactory({
          text: "Recovered",
          sessionId: "sess-runtime-gone",
          requestId: "req-runtime-gone",
          response: { inputTokens: 1, outputTokens: 1, model: "claude-recovered" },
        }),
      });

      await daemon.start();

      expect(injectedRuntimeGone).toBe(true);
      expect(store.getTask(task.id)?.status).toBe("completed");
      expect(store.getTask(task.id)?.result).toBe("Recovered");
      expect(store.getTask(task.id)?.sessionId).toBe("sess-runtime-gone");
      const registeredEvents = store.listAnalyticsEvents({ name: "runtime_registered" });
      expect(registeredEvents).toHaveLength(2);
      expect(new Set(registeredEvents.map((event) => event.properties.runtime_id))).toHaveLength(1);
      expect(store.listRuntimes()).toHaveLength(1);
      expect(store.listRuntimes()[0]?.status).toBe("online");
    } finally {
      server.stop(true);
    }
  });

  it("retries SSH Mesh cleanup and waits for success before stopping after daemon authority is revoked", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-authority-cleanup-");
    const daemonToken = await store.createAccessToken({
      name: "Authority cleanup daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-authority-cleanup-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    let cleanupCalls = 0;
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolveCleanup) => { releaseCleanup = resolveCleanup; });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      daemonId: "daemon-authority-cleanup",
      runtimeName: "authority-cleanup-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 10,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
        discoverModelCapabilities: async () => [{ id: "claude-test", label: "Claude Test", default: true }],
      }),
      sshMeshManager: {
        getHeartbeatStatus: () => ({ status: "disabled" }),
        reconcile: async () => {},
        cleanupForRetirement: async () => {
          cleanupCalls++;
          if (cleanupCalls === 1) throw new Error("temporary SSH Mesh cleanup lock timeout");
          await cleanupBlocked;
        },
      },
      terminalAuthorityCleanupRetryDelaysMs: [10],
    });
    let settled = false;
    const daemonRun = daemon.start().finally(() => { settled = true; });

    try {
      const port = await waitForLocalPort(daemon);
      await waitForRunningHealth(port);
      const retirementPlan = store.getDaemonRetirementPlan("local", "daemon-authority-cleanup");
      expect(store.retireDaemon(
        "local",
        "daemon-authority-cleanup",
        retirementPlan.snapshot,
        "local",
      )).toMatchObject({ status: "retired" });
      await waitForCondition(() => cleanupCalls === 2, 5_000);
      await Bun.sleep(20);
      expect(settled).toBe(false);

      releaseCleanup();
      await daemonRun;
      expect(cleanupCalls).toBe(2);
      expect(settled).toBe(true);
    } finally {
      releaseCleanup();
      daemon.stop();
      await daemonRun.catch(() => {});
      server.stop(true);
    }
  });

  it("stays cleanup-only and stops claiming while terminal SSH Mesh cleanup keeps failing", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-authority-cleanup-failure-");
    const daemonToken = await store.createAccessToken({
      name: "Authority cleanup failure daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-authority-cleanup-failure-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    let cleanupCalls = 0;
    let claimCalls = 0;
    let claimCallsAtCleanup = -1;
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      daemonId: "daemon-authority-cleanup-failure",
      runtimeName: "authority-cleanup-failure-runtime",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 10,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
        discoverModelCapabilities: async () => [{ id: "claude-test", label: "Claude Test", default: true }],
      }),
      sshMeshManager: {
        getHeartbeatStatus: () => ({ status: "disabled" }),
        reconcile: async () => {},
        cleanupForRetirement: async () => {
          cleanupCalls++;
          if (claimCallsAtCleanup < 0) claimCallsAtCleanup = claimCalls;
          throw new Error("persistent SSH Mesh cleanup failure");
        },
      },
      terminalAuthorityCleanupRetryDelaysMs: [10],
    });
    const daemonClient = (daemon as unknown as {
      client: { claimTask: (runtimeId: string) => Promise<unknown> };
    }).client;
    const originalClaimTask = daemonClient.claimTask.bind(daemonClient);
    daemonClient.claimTask = async (runtimeId) => {
      claimCalls++;
      return await originalClaimTask(runtimeId);
    };
    let settled = false;
    const daemonRun = daemon.start().finally(() => { settled = true; });

    try {
      const port = await waitForLocalPort(daemon);
      await waitForRunningHealth(port);
      const retirementPlan = store.getDaemonRetirementPlan("local", "daemon-authority-cleanup-failure");
      expect(store.retireDaemon(
        "local",
        "daemon-authority-cleanup-failure",
        retirementPlan.snapshot,
        "local",
      )).toMatchObject({ status: "retired" });
      await waitForCondition(() => cleanupCalls >= 3, 5_000);
      const claimsAfterTerminal = claimCalls;
      await Bun.sleep(30);
      const cleanupHealth = await fetch(`http://127.0.0.1:${port}/health`).then(
        (response) => response.json() as Promise<Record<string, unknown>>,
      );
      const checkoutResponse = await fetch(`http://127.0.0.1:${port}/repo/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(claimCallsAtCleanup).toBe(claimsAfterTerminal);
      expect(claimCalls).toBe(claimsAfterTerminal);
      expect(checkoutResponse.status).toBe(503);
      expect(cleanupHealth).toMatchObject({
        status: "starting",
        mode: "cleanup_only",
      });
      expect(Number(cleanupHealth.ssh_mesh_cleanup_attempts)).toBeGreaterThanOrEqual(3);
      expect(settled).toBe(false);
    } finally {
      daemon.stop();
      await daemonRun.catch(() => {});
      server.stop(true);
    }
  });

  it("re-uploads the cached model snapshot to a replacement Runtime after runtime_gone", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-runtime-gone-models-");
    const oldRuntimeId = "rt_runtime_gone_models_old";
    const newRuntimeId = "rt_runtime_gone_models_new";
    const daemonToken = await store.createAccessToken({
      name: "Runtime gone model daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const originalHeartbeat = store.heartbeatRuntime.bind(store);
    let injectedRuntimeGone = false;
    store.heartbeatRuntime = ((runtimeId, options) => {
      if (
        !injectedRuntimeGone &&
        runtimeId === oldRuntimeId &&
        store.listRuntimeModels(runtimeId).some((model) => model.id === "claude-cached")
      ) {
        injectedRuntimeGone = true;
        db!.run("DELETE FROM multiremi_runtime_models WHERE runtime_id = ?", [runtimeId]);
        db!.run("DELETE FROM multiremi_runtimes WHERE id = ?", [runtimeId]);
      }
      return originalHeartbeat(runtimeId, options);
    }) as typeof store.heartbeatRuntime;
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-runtime-gone-models-secret",
      hostname: "127.0.0.1",
      port: 0,
    });
    let modelProbeCount = 0;
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      runtimeId: oldRuntimeId,
      daemonId: "daemon-runtime-gone-models",
      runtimeName: "runtime-gone-models",
      provider: "claude",
      workspaceId: "local",
      daemonPort: 0,
      pollIntervalMs: 10,
      runtimeModelRetryBaseMs: 10,
      runtimeModelRetryMaxMs: 20,
      inProcessRuntimeModelDiscoveryEnabled: true,
      repoCacheRoot: join(workDir, ".repo-cache"),
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
        discoverModelCapabilities: async () => {
          modelProbeCount++;
          return [{ id: "claude-cached", label: "Claude Cached", default: true }];
        },
      }),
    });
    const internal = daemon as unknown as {
      client: {
        registerRuntime: (input: Record<string, unknown>) => Promise<{ runtime: { id: string } }>;
        updateRuntimeModels: (
          runtimeId: string,
          models: MultiremiRuntimeModel[],
          signal?: AbortSignal,
        ) => Promise<MultiremiRuntimeModel[]>;
      };
    };
    const originalRegisterRuntime = internal.client.registerRuntime.bind(internal.client);
    let registerCount = 0;
    internal.client.registerRuntime = async (input) => {
      registerCount++;
      if (registerCount === 1) return originalRegisterRuntime(input);
      // Force a genuinely new Runtime id and omit registration-time models so
      // only the daemon's post-registration PUT can restore the snapshot.
      const { models: _models, ...withoutModels } = input;
      return originalRegisterRuntime({ ...withoutModels, id: newRuntimeId });
    };
    const originalUpdateModels = internal.client.updateRuntimeModels.bind(internal.client);
    const updateTargets: string[] = [];
    internal.client.updateRuntimeModels = async (runtimeId, models, signal) => {
      updateTargets.push(runtimeId);
      return originalUpdateModels(runtimeId, models, signal);
    };

    let daemonRun: Promise<void> | null = null;
    try {
      daemonRun = daemon.start();
      await waitForCondition(() => {
        if (!injectedRuntimeGone || !store.getRuntime(newRuntimeId)) return false;
        return store.listRuntimeModels(newRuntimeId).some((model) => model.id === "claude-cached");
      }, 5_000);

      expect(store.getRuntime(oldRuntimeId)).toBeNull();
      expect(store.getRuntime(newRuntimeId)?.status).toBe("online");
      expect(modelProbeCount).toBe(1);
      expect(updateTargets).toContain(oldRuntimeId);
      expect(updateTargets).toContain(newRuntimeId);
      const firstNewTarget = updateTargets.indexOf(newRuntimeId);
      expect(updateTargets.slice(firstNewTarget + 1)).not.toContain(oldRuntimeId);
    } finally {
      daemon.stop();
      await daemonRun?.catch(() => {});
      server.stop(true);
    }
  });

  it("fails a claimed task when provider execution times out", async () => {
    const { store, workDir } = daemonTestBed("multiremi-daemon-timeout-");
    const agent = store.createAgent({
      name: "Timeout Claude",
      provider: "claude",
    });
    const task = store.createTask({ agentId: agent.id, prompt: "Hang forever" });
    const daemonToken = await store.createAccessToken({
      name: "Timeout daemon",
      type: "daemon",
      workspaceId: "local",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-timeout-secret",
      hostname: "127.0.0.1",
      port: 0,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        runtimeName: "timeout-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        repoCacheRoot: join(workDir, ".repo-cache"),
        taskTimeoutMs: 10,
        providerFactory: () => ({
          async *sendStream(_message, options) {
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("Cancelled");
          },
          getLastResponse: () => null,
        }),
      });

      await daemon.start();

      const failed = store.getTask(task.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("Agent timed out after 10ms");
      expect(failed.failureReason).toBe("agent_error.agent_timeout");
    } finally {
      server.stop(true);
    }
  });
});

/**
 * The opening every daemon test shares: a fresh in-memory store and a temp work
 * dir, both registered with the module-level `afterEach` teardown. The returned
 * `workDir` shadows the nullable module-level one so call sites keep a plain
 * `string`.
 */
function daemonTestBed(tmpPrefix: string): { store: MultiremiStore; workDir: string } {
  db = new Database(":memory:");
  workDir = mkdtempSync(join(tmpdir(), tmpPrefix));
  return { store: new MultiremiStore(db), workDir };
}

async function runCompactionFinalizeCase(spec: {
  id: string;
  chunks: string[];
  lastText: string;
}): Promise<{ store: MultiremiStore; taskId: string; issueId: string }> {
  const { store, workDir: root } = daemonTestBed(`multiremi-daemon-${spec.id}-`);
  const agent = store.createAgent({
    name: `Claude ${spec.id}`,
    provider: "claude",
  });
  const issue = store.createIssue({ title: `Compaction finalize ${spec.id}`, workspaceId: "local" });
  const task = store.createTask({
    agentId: agent.id,
    issueId: issue.id,
    prompt: "Finish the task",
  });
  const daemonToken = await store.createAccessToken({
    name: `Compaction finalize ${spec.id} daemon`,
    type: "daemon",
    workspaceId: "local",
  });
  const server = startMultiremiServer({
    store,
    scheduler: null,
    authToken: `root-${spec.id}-secret`,
    hostname: "127.0.0.1",
    port: 0,
  });
  const providerFactory: MultiremiDaemonProviderFactory = () => ({
    async *sendStream() {
      for (const text of spec.chunks) {
        yield {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "text", text }],
        } as any;
      }
    },
    getLastResponse: () => ({
      text: spec.lastText,
      sessionId: `sess-${spec.id}`,
      requestId: `req-${spec.id}`,
    }),
  });

  try {
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      daemonId: `daemon-${spec.id}`,
      runtimeName: `compaction-${spec.id}-runtime`,
      provider: "claude",
      workspaceId: "local",
      once: true,
      daemonPort: 0,
      gcEnabled: false,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      providerFactory,
    });
    await daemon.start();
  } finally {
    server.stop(true);
  }

  return { store, taskId: task.id, issueId: issue.id };
}

async function runProviderHomeSymlinkProof(kind: "quick" | "chat" | "issue"): Promise<void> {
  const { store, workDir: root } = daemonTestBed(`multiremi-${kind}-provider-symlink-`);
  const workspacesRoot = join(root, "workspaces");
  const outside = join(root, "outside");
  mkdirSync(workspacesRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(workspacesRoot, ".runtime"), "dir");
  const agent = store.createAgent({ name: `${kind} symlink proof`, provider: "claude" });
  let task: ReturnType<typeof store.createTask>;
  let externalGc: string;
  let receipt: string | null = null;
  if (kind === "quick") {
    task = store.createTask({ agentId: agent.id, prompt: "must fail before GC" });
    externalGc = join(workspacesRoot, "tasks", task.id, ".multiremi", "gc.json");
  } else if (kind === "chat") {
    const session = store.createChatSession({ agentId: agent.id, title: "Symlink proof" });
    task = store.sendChatMessage(session.id, { body: "must fail before GC" }).task;
    externalGc = join(workspacesRoot, "chats", session.id, ".multiremi", "gc.json");
  } else {
    const issue = store.createIssue({ title: "Issue symlink proof", workspaceId: "local" });
    receipt = join(outside, "session-archive-receipt.json");
    writeFileSync(receipt, "keep-receipt\n");
    task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "must fail before GC" });
    externalGc = join(workspacesRoot, "issues", issue.key, ".multiremi", "gc.json");
  }
  const daemonId = `daemon-${kind}-provider-symlink`;
  const daemonToken = await store.createAccessToken({
    name: `${kind} Provider symlink daemon`,
    type: "daemon",
    workspaceId: "local",
    daemonId,
  });
  const server = startMultiremiServer({
    store,
    scheduler: null,
    authToken: `root-${kind}-provider-symlink-secret`,
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      daemonId,
      runtimeName: `${kind}-provider-symlink-runtime`,
      provider: "claude",
      workspaceId: "local",
      once: true,
      daemonPort: 0,
      gcEnabled: false,
      workspacesRoot,
      repoCacheRoot: join(root, ".repo-cache"),
      providerFactory: () => {
        throw new Error("symlinked Provider Home must fail before provider creation");
      },
    });
    await daemon.start();

    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("must be a real directory"),
    });
    expect(existsSync(externalGc)).toBe(false);
    if (receipt) expect(readFileSync(receipt, "utf8")).toBe("keep-receipt\n");
  } finally {
    server.stop(true);
  }
}

/**
 * The stub most of these tests want from a provider: stream exactly one
 * agent_message_chunk and report that same text as the final response.
 *
 * `onSend` runs before the chunk is streamed, for tests that need to observe the
 * prompt or hold the turn open; `text` may be a thunk when the answer is only
 * known once `onSend` has run. Tests whose provider does something structurally
 * different (multi-turn, tool calls, abort handling) still build their own.
 */
function messageProviderFactory(spec: {
  text: string | (() => string);
  sessionId: string;
  requestId: string;
  response?: Partial<AgentResponse>;
  onSend?: (message: string, options: AcpProviderOptions) => void | Promise<void>;
}): MultiremiDaemonProviderFactory {
  const text = () => (typeof spec.text === "function" ? spec.text() : spec.text);
  return (options) => ({
    async *sendStream(message) {
      await spec.onSend?.(message, options);
      yield {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: text() }],
      } as any;
    },
    getLastResponse: () => ({
      text: text(),
      sessionId: spec.sessionId,
      requestId: spec.requestId,
      ...spec.response,
    }),
  });
}

function daemonRuntimeIdForTest(daemonId: string, provider: string): string {
  const key = `${daemonId}:${provider}`.toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rt_${(hash >>> 0).toString(36)}`;
}

function createSourceRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  runGit(path, ["init", "-b", "main"]);
  runGit(path, ["config", "user.email", "multiremi@example.com"]);
  runGit(path, ["config", "user.name", "Multiremi Test"]);
  writeFileSync(join(path, "README.md"), "hello from repo\n");
  runGit(path, ["add", "README.md"]);
  runGit(path, ["commit", "-m", "initial"]);
  return path;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    },
  });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    },
  }).trim();
}

function prepareCommitMsgHookPath(worktreePath: string): string {
  const commonDir = gitOutput(worktreePath, ["rev-parse", "--git-common-dir"]);
  return join(isAbsolute(commonDir) ? commonDir : join(worktreePath, commonDir), "hooks", "prepare-commit-msg");
}

function writeGcFixture(dir: string, payload: Record<string, unknown>): void {
  mkdirSync(join(dir, ".multiremi"), { recursive: true });
  writeFileSync(join(dir, ".multiremi", "gc.json"), JSON.stringify({ version: 1, ...payload }, null, 2));
}

async function waitForLocalPort(daemon: MultiremiDaemon): Promise<number> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const port = daemon.localPort();
    if (port > 0) return port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("daemon local port did not open");
}

async function waitForRunningHealth(port: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 1_500;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    last = await response.json() as Record<string, unknown>;
    if (last.status === "running") return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon did not report running health: ${JSON.stringify(last)}`);
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve as (value?: T | PromiseLike<T>) => void;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before timeout");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
