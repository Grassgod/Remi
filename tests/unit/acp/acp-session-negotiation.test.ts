/**
 * What AcpProvider actually puts on the wire when it opens a session, and what
 * it does with what the agent advertises back.
 *
 * The fake agent records every request it receives to a log file, so each test
 * asserts against the real JSON-RPC frames rather than internal state. Ground
 * truth for every expectation is the pinned bridge source
 * (@agentclientprotocol/claude-agent-acp 0.66.0, codex-acp 1.11.0).
 */
import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpProvider } from "@acp/index.js";
import { probeRuntimeModels } from "@multiremi/worker/runtime-model-probe.js";
import { runtimeClaudeProfileRouting } from "@daemon/agent-runtime/claude-profile.js";
import { identityBlock } from "@daemon/agent-runtime/capabilities/identity.js";
import type { RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import type { McpServerConfig, SessionConfigOption, SessionModeState, SessionModelState } from "@shared/contracts/acp-protocol.js";

interface AgentProfile {
  initialize: Record<string, unknown>;
  modes: SessionModeState;
  configOptions: SessionConfigOption[];
  models?: SessionModelState;
  /**
   * Effort the agent re-derives for itself when a given model is selected.
   * Both bridges do this: codex takes the new model's supported/default effort
   * (dist/index.js:29372-29374) and claude rebuilds+clamps the effort option
   * (dist/acp-agent.js:4084-4100).
   */
  effortAfterModel?: Record<string, string>;
  /** Model-specific effort selector contents returned after a model switch. */
  effortOptionsAfterModel?: Record<string, Array<{ value: string; name: string; description?: string }>>;
  /** Codex 1.12 keeps current effort and advertises the model default separately. */
  effortRecommendationAfterModel?: Record<string, string>;
  /** Claude resolves full IDs to picker aliases; missing aliases must fail. */
  modelAliases?: Record<string, string>;
  rejectUnknownModels?: boolean;
  modelErrors?: Record<string, { code: number; message: string }>;
  exitOnModel?: string;
  selectedModelOverride?: string;
  ignoreCustomModelOption?: boolean;
  normalizeCustomModelOption?: boolean;
  synthesizeStartupModel?: boolean;
  archivedModels?: Record<string, string>;
  settingsModel?: string;
  resumeReassertFails?: boolean;
  /** Simulate a bridge that does not acknowledge the startup env in its picker. */
  ignoreStartupModelEnv?: boolean;
  ignoreEffortChange?: boolean;
}

interface LoggedRequest {
  kind: "request";
  method: string;
  params: Record<string, any>;
}

interface LoggedEnv {
  kind: "env";
  ANTHROPIC_API_KEY: string | null;
  ANTHROPIC_BASE_URL: string | null;
  ANTHROPIC_MODEL: string | null;
  CODEX_HOME: string | null;
}

const CLAUDE_MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "plan", name: "Plan Mode" },
    { id: "dontAsk", name: "Don't Ask" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ],
};

const CODEX_MODES: SessionModeState = {
  currentModeId: "agent",
  availableModes: [
    { id: "read-only", name: "Read-only" },
    { id: "agent", name: "Agent" },
    { id: "agent-full-access", name: "Agent (full access)" },
  ],
};

/** claude-agent-acp dist/acp-agent.js:5110-5156 (ids `model` / `effort`). */
const CLAUDE_CONFIG_OPTIONS: SessionConfigOption[] = [
  {
    id: "model", name: "Model", category: "model", type: "select",
    currentValue: "claude-sonnet-4-6",
    options: [{ value: "claude-sonnet-4-6", name: "Sonnet" }, { value: "claude-opus-4-6", name: "Opus" }],
  },
  {
    id: "effort", name: "Effort", category: "thought_level", type: "select",
    currentValue: "default",
    options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }],
  },
];

/** codex-acp dist/index.js:27160-27197 (ids `model` / `reasoning_effort`). */
const CODEX_CONFIG_OPTIONS: SessionConfigOption[] = [
  {
    id: "model", name: "Model", category: "model", type: "select",
    currentValue: "gpt-5.4",
    options: [{ value: "gpt-5.4", name: "GPT-5.4" }, { value: "gpt-5.5", name: "GPT-5.5" }],
  },
  {
    id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
    currentValue: "medium",
    options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "xhigh", name: "Extra high" }],
  },
];

/** codex-only; `modelId` is its `model[effort]` bracket form (index.js:29717-29729). */
const CODEX_MODEL_CATALOG: SessionModelState = {
  currentModelId: "gpt-5.4[medium]",
  availableModels: [
    { modelId: "gpt-5.4[medium]", name: "GPT-5.4 (medium)" },
    { modelId: "gpt-5.5[xhigh]", name: "GPT-5.5 (xhigh)" },
  ],
};

/** Both pinned bridges advertise this — acp-agent.js:715-722, index.js:28800. */
const WITH_ADDITIONAL_DIRECTORIES = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true },
    sessionCapabilities: { additionalDirectories: {}, resume: {}, close: {} },
  },
};

function claudeProfile(initialize: Record<string, unknown> = WITH_ADDITIONAL_DIRECTORIES): AgentProfile {
  return { initialize, modes: CLAUDE_MODES, configOptions: CLAUDE_CONFIG_OPTIONS };
}

function codexProfile(): AgentProfile {
  return {
    initialize: WITH_ADDITIONAL_DIRECTORIES,
    modes: CODEX_MODES,
    configOptions: CODEX_CONFIG_OPTIONS,
    models: CODEX_MODEL_CATALOG,
  };
}

interface FakeAgent {
  executable: string;
  requests(): LoggedRequest[];
  env(): LoggedEnv;
  envs(): LoggedEnv[];
}

function fakeAgent(profile: AgentProfile): FakeAgent {
  const dir = mkdtempSync(join(tmpdir(), "acp-session-test-"));
  const logPath = join(dir, "requests.jsonl");
  const executable = join(dir, "fake-agent.js");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const LOG = ${JSON.stringify(logPath)};
const PROFILE = ${JSON.stringify(profile)};
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
log({ kind: "env", ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let sessionSeq = 0;
let configOptions = PROFILE.configOptions;
const rl = readline.createInterface({ input: process.stdin });
const adoptSession = (params, loading = false) => {
  configOptions = PROFILE.configOptions.map(o => ({ ...o }));
  const startup = params._meta?.claudeCode?.options?.model;
  const model = startup || (loading ? (PROFILE.archivedModels || {})[params.sessionId] : undefined);
  if (model && PROFILE.synthesizeStartupModel) {
    configOptions = configOptions.map(o => o.id === "model" && !o.options.some(item => item.value === model)
      ? { ...o, options: [...o.options, { value: model, name: model }] } : o);
  }
  const archived = loading ? (PROFILE.archivedModels || {})[params.sessionId] || model : undefined;
  const custom = params._meta?.claudeCode?.options?.env?.ANTHROPIC_CUSTOM_MODEL_OPTION;
  if (custom && !PROFILE.ignoreCustomModelOption) {
    const value = PROFILE.normalizeCustomModelOption ? custom.replace(/\\[1m\\]$/i, "") : custom;
    configOptions = configOptions.map(o => o.id === "model" ? {
      ...o, options: [...o.options, { value, name: "Custom", description: "Custom model (" + custom + ")" }],
    } : o);
  }
  const processModel = PROFILE.ignoreStartupModelEnv ? undefined : process.env.ANTHROPIC_MODEL;
  configOptions = configOptions.map(o => {
    if (o.id !== "model") return o;
    const envRow = o.options.find(item => item.value === processModel);
    const settingsRow = o.options.find(item => item.value === PROFILE.settingsModel);
    const archiveValue = (PROFILE.modelAliases || {})[archived] || archived;
    const currentValue = loading && envRow && PROFILE.resumeReassertFails
      ? archiveValue || o.options[0]?.value
      : envRow?.value || settingsRow?.value || (loading ? archiveValue : o.options[0]?.value);
    return { ...o, currentValue: currentValue || o.currentValue };
  });
};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  log({ kind: "request", method: msg.method, params: msg.params });
  if (msg.id == null) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": return ok(PROFILE.initialize);
    case "session/new":
      adoptSession(msg.params);
      return ok({ sessionId: "sess-" + (++sessionSeq), modes: PROFILE.modes, configOptions, models: PROFILE.models });
    case "session/resume":
      adoptSession(msg.params, true);
      return ok({ sessionId: msg.params.sessionId, modes: PROFILE.modes, configOptions, models: PROFILE.models });
    case "session/load":
      adoptSession(msg.params, true);
      return ok({ sessionId: msg.params.sessionId, modes: PROFILE.modes, configOptions, models: PROFILE.models });
    case "session/set_mode": return ok({});
    case "session/set_config_option": {
      if (PROFILE.ignoreEffortChange && configOptions.some((o) => o.id === msg.params.configId && o.category === "thought_level")) {
        return ok({ configOptions });
      }
      let selectedValue = msg.params.value;
      if (msg.params.configId === "model") {
        if (PROFILE.exitOnModel === msg.params.value) return process.exit(1);
        const error = (PROFILE.modelErrors || {})[msg.params.value];
        if (error) return send({ jsonrpc: "2.0", id: msg.id, error });
        const option = configOptions.find((o) => o.id === "model");
        selectedValue = (PROFILE.modelAliases || {})[msg.params.value] || msg.params.value;
        const customRow = option.options.find(o => o.description === "Custom model (" + msg.params.value + ")");
        if (customRow) selectedValue = customRow.value;
        if (PROFILE.rejectUnknownModels && !option.options.some((o) => o.value === selectedValue)) {
          return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid value for config option model: " + msg.params.value } });
        }
        selectedValue = PROFILE.selectedModelOverride || selectedValue;
      }
      configOptions = configOptions.map((o) => o.id === msg.params.configId ? { ...o, currentValue: selectedValue } : o);
      const forcedEffort = msg.params.configId === "model" ? (PROFILE.effortAfterModel || {})[msg.params.value] : undefined;
      const forcedEffortOptions = msg.params.configId === "model" ? (PROFILE.effortOptionsAfterModel || {})[msg.params.value] : undefined;
      const recommendedEffort = msg.params.configId === "model" ? (PROFILE.effortRecommendationAfterModel || {})[msg.params.value] : undefined;
      if (forcedEffort || forcedEffortOptions || recommendedEffort) {
        configOptions = configOptions.map((o) => o.category === "thought_level" ? {
          ...o,
          ...(forcedEffort ? { currentValue: forcedEffort } : {}),
          ...(forcedEffortOptions ? { options: forcedEffortOptions } : {}),
          ...(recommendedEffort ? { _meta: { jetbrains: { air: { recommendedValue: recommendedEffort } } } } : {}),
        } : o);
      }
      return ok({ configOptions });
    }
    case "session/prompt": return ok({ stopReason: "end_turn" });
    case "session/close": return ok({});
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
});
`,
  );
  chmodSync(executable, 0o755);

  const entries = (): Array<LoggedRequest | LoggedEnv> =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];

  return {
    executable,
    requests: () => entries().filter((e): e is LoggedRequest => e.kind === "request"),
    env: () => entries().find((e): e is LoggedEnv => e.kind === "env")!,
    envs: () => entries().filter((e): e is LoggedEnv => e.kind === "env"),
  };
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "acp-session-cwd-"));
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

function only(requests: LoggedRequest[], method: string): LoggedRequest[] {
  return requests.filter((r) => r.method === method);
}

describe("AcpProvider session/new payload", () => {
  it("sends claude a preset-preserving system prompt and the official additionalDirectories", async () => {
    const agent = fakeAgent(claudeProfile());
    const cwd = tempCwd();
    const extraDir = tempCwd();
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      apiKey: "sk-test",
      baseUrl: "https://example.invalid",
      cwd,
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", {
      chatId: "c1",
      systemPrompt: "You are Remi.",
      allowedTools: ["Bash"],
      model: "claude-opus-4-6",
      addDirs: [extraDir, "relative/dir"],
    }));
    await provider.close();

    const [newSession] = only(agent.requests(), "session/new");
    expect(newSession.params.cwd).toBe(cwd);
    // permissionMode is gone: the bridge overwrites it at acp-agent.js:4454.
    expect(newSession.params._meta).toEqual({
      claudeCode: { options: { model: "claude-opus-4-6", allowedTools: ["Bash"] } },
      systemPrompt: { append: "You are Remi." },
    });
    // Official param (acp-agent.js:4549 prefers it), and the relative entry is
    // dropped rather than risking codex's -32602.
    expect(newSession.params.additionalDirectories).toEqual([extraDir]);
    expect(agent.env().ANTHROPIC_API_KEY).toBe("sk-test");
    expect(agent.env().ANTHROPIC_BASE_URL).toBe("https://example.invalid");
  });

  it("sends codex no _meta and no Anthropic credentials", async () => {
    const agent = fakeAgent(codexProfile());
    const cwd = tempCwd();
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      apiKey: "sk-test",
      baseUrl: "https://example.invalid",
      cwd,
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1", allowedTools: ["Bash"] }));
    await provider.close();

    const [newSession] = only(agent.requests(), "session/new");
    expect(newSession.params._meta).toBeUndefined();
    // Nothing injected: the child sees whatever this process already had.
    expect(agent.env().ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY ?? null);
    expect(agent.env().ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL ?? null);
    const [initialize] = only(agent.requests(), "initialize");
    // Request the bridge's model recommendation without changing its current effort.
    expect(initialize.params.clientCapabilities._meta).toEqual({
      terminal_output: true,
      jetbrains: { air: { version: 1, capabilities: ["recommendedValue"] } },
    });
  });

  it("keeps the claude subagent-transcript capability", async () => {
    const agent = fakeAgent(claudeProfile());
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });
    await drain(provider.sendStream("hi", { chatId: "c1" }));
    await provider.close();

    const [initialize] = only(agent.requests(), "initialize");
    expect(initialize.params.clientCapabilities._meta).toEqual({
      terminal_output: true,
      "subagent-transcript": true,
    });
  });

  it("falls back to _meta.additionalRoots when the agent does not advertise the param", async () => {
    const agent = fakeAgent(claudeProfile({ protocolVersion: 1, agentCapabilities: { loadSession: true } }));
    const extraDir = tempCwd();
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1", addDirs: [extraDir] }));
    await provider.close();

    const [newSession] = only(agent.requests(), "session/new");
    expect(newSession.params.additionalDirectories).toBeUndefined();
    // Both bridges still read this legacy key (acp-agent.js:4549,
    // codex index.js:27064-27070).
    expect(newSession.params._meta.additionalRoots).toEqual([extraDir]);
  });

  it("passes Claude native Plugin roots through session meta", async () => {
    const agent = fakeAgent(claudeProfile());
    const pluginDir = tempCwd();
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", {
      chatId: "c1",
      pluginPaths: [pluginDir],
      pluginFingerprint: "sha256:plugin-v1",
    } as any));
    await provider.close();

    const [newSession] = only(agent.requests(), "session/new");
    expect(newSession.params._meta).toEqual({
      claudeCode: { options: { plugins: [{ type: "local", path: pluginDir }] } },
    });
  });

  it("starts Codex ACP with the isolated CODEX_HOME and no plugin session meta", async () => {
    const agent = fakeAgent(codexProfile());
    const pluginDir = tempCwd();
    const codexHome = tempCwd();
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", {
      chatId: "c1",
      pluginPaths: [pluginDir],
      pluginFingerprint: "sha256:plugin-v1",
      codexHome,
    } as any));
    await provider.close();

    expect(agent.env().CODEX_HOME).toBe(codexHome);
    expect(only(agent.requests(), "session/new")[0]?.params._meta).toBeUndefined();
  });

  it("refuses Codex Plugins without an isolated CODEX_HOME", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await expect(drain(provider.sendStream("hi", {
      chatId: "c1",
      pluginPaths: [tempCwd()],
      pluginFingerprint: "sha256:plugin-v1",
    } as any))).rejects.toThrow("isolated CODEX_HOME");
    expect(agent.requests()).toHaveLength(0);
    await provider.close();
  });
});

describe("Claude bridge startup model", () => {
  function profile(): AgentProfile {
    return {
      ...claudeProfile(),
      configOptions: [{
        id: "model", name: "Model", category: "model", type: "select", currentValue: "opus[1m]",
        options: [
          { value: "opus[1m]", name: "Opus 5.5 (1M)" },
          { value: "claude-fable-5-1", name: "Fable 5.1" },
          { value: "claude-opus-5-5", name: "Opus 5.5" },
          { value: "claude-opus-5", name: "Opus 5" },
        ],
      }, CLAUDE_CONFIG_OPTIONS[1]!],
      archivedModels: { saved: "claude-fable-5-1", other: "claude-fable-5-1" },
      modelErrors: { "claude-fable-5-1": { code: -32603, message: "Model confirmation timed out" } },
    };
  }

  it("pins the requested new-session model without a model RPC and still applies effort", async () => {
    const model = "claude-fable-5-1";
    const agent = fakeAgent(profile());
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(), model,
      env: { ANTHROPIC_MODEL: "claude-opus-5-5" },
    });
    try {
      await drain(provider.sendStream("hi", { chatId: "startup", effort: "high" }));
      await drain(provider.sendStream("again", { chatId: "startup", effort: "high" }));
      expect(agent.env().ANTHROPIC_MODEL).toBe(model);
      expect((provider as any)._pool.get("startup").startupModel).toBe(model);
      expect((provider as any)._pool.get("startup").appliedModel).toBe(model);
      expect(only(agent.requests(), "session/set_config_option").map(r => [r.params.configId, r.params.value])).toEqual([["effort", "high"]]);
      expect(only(agent.requests(), "session/new")).toHaveLength(1);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
    } finally { await provider.close(); }
  });

  it("pins the resumed model ahead of settings and keeps matching archived models on load", async () => {
    const agent = fakeAgent({ ...profile(), settingsModel: "opus[1m]" });
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd(), model: "claude-fable-5-1" });
    try {
      await drain(provider.sendStream("resume", { chatId: "restore", sessionId: "saved" }));
      await drain(provider.sendStream("load", { chatId: "restore", sessionId: "other" }));
      expect(agent.env().ANTHROPIC_MODEL).toBe("claude-fable-5-1");
      expect((provider as any)._pool.get("restore").startupModel).toBe("claude-fable-5-1");
      expect(only(agent.requests(), "session/resume")).toHaveLength(1);
      expect(only(agent.requests(), "session/load")).toHaveLength(1);
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
    } finally { await provider.close(); }
  });

  it("continues when a resume reassertion fails but the archive already has the requested model", async () => {
    const model = "claude-fable-5-1";
    const agent = fakeAgent({ ...profile(), settingsModel: "opus[1m]", resumeReassertFails: true });
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd(), model });
    try {
      await drain(provider.sendStream("resume", { chatId: "restore", sessionId: "saved" }));
      expect(agent.env().ANTHROPIC_MODEL).toBe(model);
      expect((provider as any)._pool.get("restore").appliedModel).toBe(model);
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(1);
    } finally { await provider.close(); }
  });

  it("propagates a model confirmation error when a failed resume reassertion retains a different archive model", async () => {
    const model = "claude-fable-5-1";
    const agent = fakeAgent({ ...profile(), settingsModel: "opus[1m]", resumeReassertFails: true,
      archivedModels: { saved: "claude-opus-5-5" } });
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd(), model });
    try {
      await expect(drain(provider.sendStream("must not prompt", { chatId: "restore", sessionId: "saved" })))
        .rejects.toThrow("RPC error -32603: Model confirmation timed out");
      expect(agent.env().ANTHROPIC_MODEL).toBe(model);
      expect(only(agent.requests(), "session/set_config_option").map(r => [r.params.configId, r.params.value]))
        .toEqual([["model", model]]);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
      expect((provider as any)._pool.size).toBe(0);
    } finally { await provider.close(); }
  });

  it("recreates a model-pinned process when the requested model changes", async () => {
    const agent = fakeAgent(profile());
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd() });
    const models = ["claude-fable-5-1", "claude-opus-5-5", "claude-fable-5-1"];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const model of models) await drain(provider.sendStream("hi", { chatId: "switch", model }));
      expect(only(agent.requests(), "session/new")).toHaveLength(3);
      expect(agent.envs().map(env => env.ANTHROPIC_MODEL)).toEqual(models);
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("startup model"))).toHaveLength(2);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("recreates a resumed model-pinned process when a subsequent task changes model", async () => {
    const agent = fakeAgent({ ...profile(), settingsModel: "opus[1m]" });
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd() });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await drain(provider.sendStream("resume", { chatId: "restore", sessionId: "saved", model: "claude-fable-5-1" }));
      await drain(provider.sendStream("switch", { chatId: "restore", model: "claude-opus-5-5" }));
      expect(agent.envs().map(env => env.ANTHROPIC_MODEL)).toEqual(["claude-fable-5-1", "claude-opus-5-5"]);
      expect(only(agent.requests(), "session/resume")).toHaveLength(1);
      expect(only(agent.requests(), "session/new")).toHaveLength(1);
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("startup model"))).toHaveLength(1);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("selects exactly one declared 1M row after resuming the pinned ordinary model", async () => {
    const model = "claude-opus-5-5";
    const agent = fakeAgent({ ...profile(), settingsModel: "opus[1m]", archivedModels: { saved: model } });
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd(),
      model, claudeOneMillionModels: [model] });
    try {
      await drain(provider.sendStream("resume", { chatId: "restore", sessionId: "saved" }));
      await drain(provider.sendStream("again", { chatId: "restore" }));
      expect(agent.env().ANTHROPIC_MODEL).toBe(model);
      expect(only(agent.requests(), "session/set_config_option").map(r => [r.params.configId, r.params.value]))
        .toEqual([["model", model + "[1m]"]]);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
    } finally { await provider.close(); }
  });

  it("only selects the declared 1M row after pinning its ordinary startup model", async () => {
    const model = "claude-opus-5-5";
    const agent = fakeAgent(profile());
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd(), model, claudeOneMillionModels: [model] });
    try {
      await drain(provider.sendStream("hi"));
      expect(agent.env().ANTHROPIC_MODEL).toBe(model);
      expect(only(agent.requests(), "session/set_config_option").map(r => r.params.value)).toEqual([model + "[1m]"]);
    } finally { await provider.close(); }
  });

  it("does not inject ANTHROPIC_MODEL for Codex or model capability discovery", async () => {
    for (const agentType of ["codex", "claude"] as const) {
      const agent = fakeAgent(agentType === "codex" ? codexProfile() : { ...profile(), modelErrors: undefined });
      const provider = new AcpProvider({ agentType, executable: agent.executable, cwd: tempCwd() });
      try {
        if (agentType === "codex") {
          await drain(provider.sendStream("hi", { chatId: "codex", model: "gpt-5.5" }));
          await drain(provider.sendStream("switch", { chatId: "codex", model: "gpt-5.4" }));
          expect(agent.envs()).toHaveLength(1);
          expect(only(agent.requests(), "session/new")).toHaveLength(1);
        } else await provider.discoverModelCapabilities();
        expect(agent.env().ANTHROPIC_MODEL).toBeNull();
      } finally { await provider.close(); }
    }
  });

  it("preserves the Runtime profile model across identity assembly and bridge env", async () => {
    const connection: RuntimeClaudeProfile = {
      name: "fixture", base_url: "https://profile.example", model: "claude-fable-5-1",
      auth_mode: "env", auth_header: "bearer", env_key: "REMI_CLAUDE_FIXTURE",
    };
    const identity = identityBlock.ephemeral!({ task: {
      id: "profile", claudeProfile: connection,
      agent: { provider: "claude", model: "claude-opus-5-5" },
    }, signal: new AbortController().signal } as any);
    expect(identity.model).toBe(connection.model);
    const agent = fakeAgent({ ...profile(), settingsModel: "opus[1m]" });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(), model: connection.model,
      env: runtimeClaudeProfileRouting(connection),
    });
    try {
      await drain(provider.sendStream("hi", { chatId: "new-profile", model: identity.model }));
      await drain(provider.sendStream("resume", { chatId: "resumed-profile", sessionId: "saved", model: identity.model }));
      expect(agent.envs().map(env => env.ANTHROPIC_MODEL)).toEqual([connection.model, connection.model]);
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
    } finally { await provider.close(); }
  });
});

describe("Claude 1M session negotiation", () => {
  function profile(): AgentProfile {
    return {
      ...claudeProfile(),
      configOptions: [{
        id: "model", name: "Model", category: "model", type: "select", currentValue: "claude-fable-5-1",
        options: [
          { value: "claude-fable-5-1", name: "Fable 5.1" },
          { value: "opus", name: "Opus" },
          { value: "opus[1m]", name: "Opus 5.5 (1M)" },
          { value: "sonnet", name: "Sonnet 5" },
          { value: "sonnet[1m]", name: "Sonnet 5 (1M)" },
          { value: "haiku", name: "Haiku" },
        ],
      }, CLAUDE_CONFIG_OPTIONS[1]!],
      modelAliases: { "claude-opus-5-5[1m]": "opus[1m]", "claude-sonnet-5[1m]": "sonnet[1m]" },
      rejectUnknownModels: true,
      synthesizeStartupModel: true,
    };
  }

  it.each(["claude-opus-5-5", "claude-fable-5-1", "sonnet", "opus", "deepseek-flash", "gateway/claude-fable-5-1", "claude-opus-5[200k]"])(
    "uses the standard window without a declaration: %s", async model => {
      const agent = fakeAgent(profile());
      const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd() });
      try {
        await drain(provider.sendStream("hi", { model }));
        const meta = only(agent.requests(), "session/new")[0]!.params._meta.claudeCode.options;
        expect(meta.model).toBe(model);
        expect(meta.env).toBeUndefined();
        expect(only(agent.requests(), "session/set_config_option").every(r => !r.params.value.includes("[1m]"))).toBe(true);
        expect(only(agent.requests(), "session/prompt")).toHaveLength(1);
      } finally { await provider.close(); }
    },
  );

  it.each([
    { model: "claude-opus-5-5", ignoreCustomModelOption: true },
    { model: "claude-opus-5-5", ignoreCustomModelOption: false },
    { model: "claude-opus-5", ignoreCustomModelOption: false },
    { model: "claude-fable-5-1", normalizeCustomModelOption: true },
  ])("selects the declared 1M menu/custom row for $model", async params => {
    const agent = fakeAgent({ ...profile(), ...params });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(),
      model: params.model, claudeOneMillionModels: [params.model],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await drain(provider.sendStream("hi", { chatId: "one-million" }));
      await drain(provider.sendStream("again", { chatId: "one-million" }));
      const meta = only(agent.requests(), "session/new")[0]!.params._meta.claudeCode.options;
      expect(meta.model).toBe(params.model);
      expect(meta.env).toEqual({ ANTHROPIC_CUSTOM_MODEL_OPTION: params.model + "[1m]" });
      expect(only(agent.requests(), "session/set_config_option").map(r => r.params.value)).toEqual([params.model + "[1m]"]);
      expect(only(agent.requests(), "session/new")).toHaveLength(1);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
      expect(warn.mock.calls.some(([message]) => String(message).includes("[acp_model_context_fallback]"))).toBe(false);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("applies once after resume/load and recreates the process when the declared model changes", async () => {
    const agent = fakeAgent(profile());
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(),
      claudeOneMillionModels: ["claude-opus-5", "claude-sonnet-5"],
    });
    try {
      await drain(provider.sendStream("resume", { chatId: "c", sessionId: "saved-session", model: "claude-opus-5" }));
      await drain(provider.sendStream("again", { chatId: "c", model: "claude-opus-5" }));
      await drain(provider.sendStream("load", { chatId: "c", sessionId: "another-session", model: "claude-opus-5" }));
      await drain(provider.sendStream("switch", { chatId: "c", model: "claude-sonnet-5" }));
      await drain(provider.sendStream("again", { chatId: "c", model: "claude-sonnet-5" }));
      expect(only(agent.requests(), "session/resume")[0]!.params._meta.claudeCode.options.env).toEqual({
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-5[1m]",
      });
      expect(only(agent.requests(), "session/new")[0]!.params._meta.claudeCode.options.env).toEqual({
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-sonnet-5[1m]",
      });
      expect(only(agent.requests(), "session/new")).toHaveLength(1);
      expect(only(agent.requests(), "session/load")).toHaveLength(1);
      expect(agent.envs()).toHaveLength(2);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(5);
    } finally { await provider.close(); }
  });

  it("recreates a pooled session when the declaration is turned on or off", async () => {
    const models: string[] = [];
    const agent = fakeAgent(profile());
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(),
      model: "claude-opus-5", claudeOneMillionModels: models,
    });
    try {
      await drain(provider.sendStream("off", { chatId: "c" }));
      models.push("claude-opus-5");
      await drain(provider.sendStream("on", { chatId: "c" }));
      models.splice(0);
      await drain(provider.sendStream("off", { chatId: "c" }));
      expect(only(agent.requests(), "session/new").map(r => r.params._meta.claudeCode.options.env)).toEqual([
        undefined, { ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-5[1m]" }, undefined,
      ]);
      expect(agent.envs()).toHaveLength(3);
    } finally { await provider.close(); }
  });

  it("retains the requested custom model when a warm load rebuilds an archived Opus 5.5 session", async () => {
    const agent = fakeAgent({ ...profile(), archivedModels: { "saved-opus-5-5": "opus[1m]" } });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(),
      model: "claude-opus-5", claudeOneMillionModels: ["claude-opus-5"],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const initial = await (provider as any)._ensureSession("load");
      expect(initial.configOptions.find((o: SessionConfigOption) => o.category === "model").currentValue).toBe("claude-opus-5[1m]");
      const loaded = await (provider as any)._ensureSession("load", { sessionId: "saved-opus-5-5" });
      expect(loaded.configOptions.find((o: SessionConfigOption) => o.category === "model").currentValue).toBe("claude-opus-5[1m]");
      expect(loaded.appliedModel).toBe("claude-opus-5[1m]");
      expect(only(agent.requests(), "session/load")[0]!.params._meta).toEqual(only(agent.requests(), "session/new")[0]!.params._meta);
      expect(only(agent.requests(), "session/set_config_option").map(r => r.params.value)).toEqual([
        "claude-opus-5[1m]", "claude-opus-5[1m]",
      ]);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
      expect(warn.mock.calls.some(([message]) => String(message).includes("[acp_model_context_fallback]"))).toBe(false);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("reports an unavailable standard fallback honestly without retrying the declaration", async () => {
    const agent = fakeAgent({
      ...profile(), synthesizeStartupModel: false,
      configOptions: [{
        id: "model", name: "Model", category: "model", type: "select", currentValue: "opus[1m]",
        options: [{ value: "opus[1m]", name: "Opus 5.5" }],
      }, CLAUDE_CONFIG_OPTIONS[1]!],
      modelErrors: { "claude-opus-5[1m]": { code: -32603, message: "Internal error" } },
    });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(),
      model: "claude-opus-5", claudeOneMillionModels: ["claude-opus-5"],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await drain(provider.sendStream("hi", { chatId: "fallback" }));
      await drain(provider.sendStream("again", { chatId: "fallback" }));
      expect(only(agent.requests(), "session/set_config_option").map(r => r.params.value)).toEqual(["claude-opus-5[1m]"]);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
      expect((provider as any)._pool.get("fallback").appliedModel).toBe("opus[1m]");
      const fallbacks = warn.mock.calls.filter(([message]) => String(message).includes("[acp_model_context_fallback]"));
      expect(fallbacks).toHaveLength(1);
      expect(String(fallbacks[0]![0])).toContain('actual="opus[1m]"');
      expect(String(fallbacks[0]![0])).toContain("standard model not confirmed");
      expect(String(fallbacks[0]![0])).not.toContain("running with the standard context window");
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it.each([
    { code: -32602, message: "Invalid value for config option model" },
    { code: -32603, message: 'Could not confirm model "claude-opus-5" with the API' },
  ])("falls back once after a live bridge rejects 1M: $code", async error => {
    const agent = fakeAgent({ ...profile(), ignoreStartupModelEnv: true, modelErrors: { "claude-opus-5[1m]": error } });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(), claudeOneMillionModels: ["claude-opus-5"],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await drain(provider.sendStream("hi", { chatId: "fallback", model: "claude-opus-5" }));
      await drain(provider.sendStream("again", { chatId: "fallback", model: "claude-opus-5" }));
      expect(only(agent.requests(), "session/set_config_option").map(r => r.params.value)).toEqual([
        "claude-opus-5[1m]", "claude-opus-5",
      ]);
      const fallbacks = warn.mock.calls.filter(([message]) => String(message).includes("[acp_model_context_fallback]"));
      expect(fallbacks).toHaveLength(1);
      expect(String(fallbacks[0]![0])).toContain('model="claude-opus-5"');
      expect(String(fallbacks[0]![0])).toContain(error.message);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("falls back from a non-1M selection and re-reads effort", async () => {
    const agent = fakeAgent({
      ...profile(), selectedModelOverride: "haiku",
      configOptions: [profile().configOptions[0]!, { ...CLAUDE_CONFIG_OPTIONS[1]!, type: "select", currentValue: "high", options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }] }],
      effortAfterModel: { "claude-haiku-4-5-20251001[1m]": "default" },
    });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(),
      claudeOneMillionModels: ["claude-haiku-4-5-20251001"],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await drain(provider.sendStream("hi", { chatId: "haiku", model: "claude-haiku-4-5-20251001", effort: "high" }));
      await drain(provider.sendStream("again", { chatId: "haiku", model: "claude-haiku-4-5-20251001", effort: "high" }));
      expect(only(agent.requests(), "session/set_config_option").map(r => [r.params.configId, r.params.value])).toEqual([
        ["model", "claude-haiku-4-5-20251001[1m]"], ["model", "claude-haiku-4-5-20251001"], ["effort", "high"],
      ]);
      const fallbacks = warn.mock.calls.filter(([message]) => String(message).includes("[acp_model_context_fallback]"));
      expect(fallbacks).toHaveLength(1);
      expect(String(fallbacks[0]![0])).toContain("selected: haiku");
      expect(String(fallbacks[0]![0])).toContain('actual="haiku"');
      expect(String(fallbacks[0]![0])).toContain("standard model not confirmed");
      expect((provider as any)._pool.get("haiku").appliedModel).toBe("haiku");
      expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("does not swallow an agent death during declared 1M selection", async () => {
    const agent = fakeAgent({ ...profile(), exitOnModel: "claude-opus-5-5[1m]" });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(), claudeOneMillionModels: ["claude-opus-5-5"],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(drain(provider.sendStream("hi", { model: "claude-opus-5-5" }))).rejects.toThrow("ACP agent died unexpectedly");
      expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
      expect(warn.mock.calls.some(([message]) => String(message).includes("[acp_model_context_fallback]"))).toBe(false);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("preserves an explicit [1m] alias without injecting custom env", async () => {
    const agent = fakeAgent({ ...profile(), ignoreStartupModelEnv: true });
    const provider = new AcpProvider({
      agentType: "claude", executable: agent.executable, cwd: tempCwd(), claudeOneMillionModels: ["opus[1m]"],
    });
    try {
      await drain(provider.sendStream("hi", { model: "opus[1m]" }));
      expect(only(agent.requests(), "session/new")[0]!.params._meta.claudeCode.options).toEqual({ model: "opus[1m]" });
      expect(only(agent.requests(), "session/set_config_option")[0]!.params.value).toBe("opus[1m]");
    } finally { await provider.close(); }
  });

  it.each([
    { selectedModelOverride: undefined, model: "unknown[1m]", error: "Invalid value" },
    { selectedModelOverride: "haiku", model: "opus[1m]", error: "acp_model_context_unsupported" },
  ])("keeps explicit 1M strict: $model", async params => {
    const agent = fakeAgent({ ...profile(), ignoreStartupModelEnv: true, synthesizeStartupModel: false, selectedModelOverride: params.selectedModelOverride });
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd() });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(drain(provider.sendStream("hi", { model: params.model }))).rejects.toThrow(params.error);
      expect(only(agent.requests(), "session/new")[0]!.params._meta.claudeCode.options.model).toBe(params.model);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
      expect(warn.mock.calls.some(([message]) => String(message).includes("[acp_model_context_fallback]"))).toBe(false);
    } finally { await provider.close(); warn.mockRestore(); }
  });

  it("ignores the Claude declaration for Codex", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex", executable: agent.executable, cwd: tempCwd(), claudeOneMillionModels: ["gpt-5.5"],
    });
    try {
      await drain(provider.sendStream("hi", { model: "gpt-5.5" }));
      expect(only(agent.requests(), "session/new")[0]!.params._meta).toBeUndefined();
      expect(only(agent.requests(), "session/set_config_option").map(r => r.params.value)).toEqual(["gpt-5.5"]);
    } finally { await provider.close(); }
  });

  it("preserves a full Claude ID selected in metadata when the picker reports an alias", async () => {
    const agent = fakeAgent({
      ...claudeProfile(),
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Opus" }] },
        CLAUDE_CONFIG_OPTIONS[1]!,
      ],
    });
    const provider = new AcpProvider({ agentType: "claude", executable: agent.executable, cwd: tempCwd() });
    try {
      await drain(provider.sendStream("hi", { model: "claude-opus-4-8" }));
      expect(only(agent.requests(), "session/new")[0]!.params._meta.claudeCode.options.model).toBe("claude-opus-4-8");
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(1);
    } finally { await provider.close(); }
  });
});

describe("AcpProvider model and effort", () => {
  it("retains the default sentinel's own effort before probing concrete models", async () => {
    const agent = fakeAgent({
      ...claudeProfile(),
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [
          { value: "default", name: "Default" },
          { value: "claude-sonnet-4-6", name: "Sonnet" },
        ] },
        CLAUDE_CONFIG_OPTIONS[1]!,
      ],
      effortOptionsAfterModel: { "claude-sonnet-4-6": [{ value: "low", name: "Low" }] },
    });
    const models = await probeRuntimeModels({ agentType: "claude", executable: agent.executable, cwd: tempCwd() });
    expect(models).toEqual([
      { id: "default", label: "Default", default: true, providerDefault: true,
        effort: { status: "supported", supportedLevels: [{ value: "high", label: "High" }] } },
      { id: "claude-sonnet-4-6", label: "Sonnet", default: false,
        effort: { status: "supported", supportedLevels: [{ value: "low", label: "Low" }] } },
    ]);
    expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
  }, 15_000);

  it("discovers capabilities through the real isolated CLI entry without sending a prompt", async () => {
    const agent = fakeAgent(claudeProfile());
    const models = await probeRuntimeModels({ agentType: "claude", executable: agent.executable, cwd: tempCwd() });
    expect(models.map(m => m.id)).toContain("claude-sonnet-4-6");
    expect(models[0]?.effort?.supportedLevels).toEqual([{ value: "high", label: "High" }]);
    expect(agent.requests().some(r => r.method === "session/prompt")).toBe(false);
  }, 15_000);

  it("discovers each model's effort values after selecting that model", async () => {
    const agent = fakeAgent({
      ...claudeProfile(),
      settingsModel: "claude-sonnet-4-6",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "claude-sonnet-4-6",
          options: [
            { value: "default", name: "Default" },
            { value: "claude-sonnet-4-6", name: "Sonnet" },
            { value: "claude-opus-4-6", name: "Opus" },
          ],
        },
        CLAUDE_CONFIG_OPTIONS[1]!,
      ],
      effortAfterModel: { "claude-opus-4-6": "max" },
      effortOptionsAfterModel: {
        "claude-opus-4-6": [
          { value: "low", name: "Low" },
          { value: "max", name: "Max", description: "Deepest reasoning" },
        ],
      },
    });
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    const models = await provider.discoverModelCapabilities();
    await provider.close();

    expect(models).toEqual([
      {
        id: "claude-sonnet-4-6",
        label: "Sonnet",
        default: true,
        effort: {
          status: "supported",
          supportedLevels: [
            { value: "high", label: "High" },
          ],
        },
      },
      {
        id: "claude-opus-4-6",
        label: "Opus",
        default: false,
        effort: {
          status: "supported",
          defaultLevel: "max",
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "max", label: "Max", description: "Deepest reasoning" },
          ],
        },
      },
    ]);
    expect(only(agent.requests(), "session/set_config_option").map((request) => request.params)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "claude-opus-4-6" },
    ]);
    expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
    expect(only(agent.requests(), "session/close")).toHaveLength(1);
  });

  it("distinguishes absent reasoning metadata from an explicitly empty selector", async () => {
    const cases: Array<[SessionConfigOption[], "unknown" | "unsupported"]> = [
      [[CODEX_CONFIG_OPTIONS[0]!], "unknown"],
      [[CODEX_CONFIG_OPTIONS[0]!, {
        id: "reasoning_effort", name: "Reasoning effort", category: "thought_level",
        type: "select", options: [], currentValue: "",
      }], "unsupported"],
    ];
    for (const [configOptions, status] of cases) {
      const agent = fakeAgent({ ...codexProfile(), configOptions });
      const provider = new AcpProvider({ agentType: "codex", executable: agent.executable, cwd: tempCwd() });
      try {
        const models = await provider.discoverModelCapabilities();
        expect(models).toHaveLength(2);
        for (const model of models) {
          expect(model.effort).toEqual({ status, supportedLevels: [] });
        }
      } finally {
        await provider.close();
      }
      expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
    }
  });

  it("uses the recommended default when Codex preserves the previous model's current effort", async () => {
    const agent = fakeAgent({
      ...codexProfile(),
      effortRecommendationAfterModel: { "gpt-5.5": "xhigh" },
    });
    const provider = new AcpProvider({ agentType: "codex", executable: agent.executable, cwd: tempCwd() });
    try {
      const models = await provider.discoverModelCapabilities();
      expect(models[0]?.effort?.defaultLevel).toBe("medium");
      expect(models[1]?.effort?.defaultLevel).toBe("xhigh");
      const [initialize] = only(agent.requests(), "initialize");
      expect(initialize?.params.clientCapabilities._meta.jetbrains.air).toEqual({
        version: 1, capabilities: ["recommendedValue"],
      });
    } finally {
      await provider.close();
    }
  });

  it("does not report a retained effort as a model default without recommendation metadata", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({ agentType: "codex", executable: agent.executable, cwd: tempCwd() });
    try {
      const models = await provider.discoverModelCapabilities();
      expect(models[0]?.effort?.defaultLevel).toBe("medium");
      expect(models[1]?.effort?.defaultLevel).toBeUndefined();
      expect(models[1]?.effort?.status).toBe("supported");
    } finally {
      await provider.close();
    }
  });

  it("preserves model-specific defaults and sends arbitrary advertised effort before prompting", async () => {
    const agent = fakeAgent({
      ...codexProfile(),
      effortAfterModel: { "gpt-5.5": "deep" },
      effortOptionsAfterModel: {
        "gpt-5.5": [{ value: "deep", name: "Deep" }, { value: "thorough", name: "Thorough" }],
      },
    });
    const provider = new AcpProvider({ agentType: "codex", executable: agent.executable, cwd: tempCwd() });
    try {
      const models = await provider.discoverModelCapabilities();
      expect(models[0]?.effort?.defaultLevel).toBe("medium");
      expect(models[1]?.effort?.defaultLevel).toBe("deep");
      expect(models[1]?.effort?.supportedLevels.map((level) => level.value)).toEqual(["deep", "thorough"]);
      await drain(provider.sendStream("hi", { chatId: "custom-effort", model: "gpt-5.5", effort: "thorough" }));
    } finally {
      await provider.close();
    }
    const requests = agent.requests();
    const setEffortIndex = requests.findIndex((request) => request.method === "session/set_config_option"
      && request.params.configId === "reasoning_effort" && request.params.value === "thorough");
    expect(setEffortIndex).toBeGreaterThan(-1);
    expect(requests.findIndex((request) => request.method === "session/prompt")).toBeGreaterThan(setEffortIndex);
  });

  // codex-acp registers session/set_config_option (dist/index.js:29298) and
  // applies `model`/`reasoning_effort` to every turn; `_meta.codex.options.model`
  // was never read by anything.
  it("applies codex model then reasoning effort through set_config_option", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1", model: "gpt-5.5", effort: "xhigh" }));
    await provider.close();

    // Model first: changing it resets effort to the new model's default
    // (codex index.js:29369-29374).
    expect(only(agent.requests(), "session/set_config_option").map((r) => r.params)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "gpt-5.5" },
      { sessionId: "sess-1", configId: "reasoning_effort", value: "xhigh" },
    ]);
  });

  it("uses claude's own effort config id", async () => {
    const agent = fakeAgent(claudeProfile());
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1", effort: "high" }));
    await provider.close();

    expect(only(agent.requests(), "session/set_config_option").map((r) => r.params)).toEqual([
      { sessionId: "sess-1", configId: "effort", value: "high" },
    ]);
  });

  it("rejects an unavailable explicit model before applying effort or sending a prompt", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await expect(drain(provider.sendStream("hi", { chatId: "c1", model: "o3-not-offered", effort: "xhigh" }))).rejects.toMatchObject({
      name: "UnsupportedAcpModelError", code: "acp_model_unsupported", model: "o3-not-offered",
      selectedModel: "gpt-5.4",
    });
    await provider.close();

    expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
    expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
  });

  it("rejects an advertised model when the bridge acknowledges a different model", async () => {
    const agent = fakeAgent({ ...codexProfile(), selectedModelOverride: "gpt-5.4" });
    const provider = new AcpProvider({ agentType: "codex", executable: agent.executable, cwd: tempCwd() });
    try {
      await expect(drain(provider.sendStream("hi", { model: "gpt-5.5", effort: "xhigh" }))).rejects.toMatchObject({
        code: "acp_model_unsupported", model: "gpt-5.5", selectedModel: "gpt-5.4",
      });
      expect(only(agent.requests(), "session/set_config_option").map((request) => request.params.configId)).toEqual(["model"]);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("keeps an acknowledged legacy current model but rejects switching without a selector", async () => {
    const agent = fakeAgent({ ...codexProfile(), configOptions: [] });
    const provider = new AcpProvider({ agentType: "codex", executable: agent.executable, cwd: tempCwd() });
    try {
      await drain(provider.sendStream("first", { chatId: "legacy", model: "gpt-5.4" }));
      await expect(drain(provider.sendStream("must not run", { chatId: "legacy", model: "gpt-5.5" }))).rejects.toMatchObject({
        code: "acp_model_unsupported", model: "gpt-5.5",
      });
      expect(only(agent.requests(), "session/prompt")).toHaveLength(1);
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("does not prompt when the bridge silently retains a different effort", async () => {
    const agent = fakeAgent({ ...codexProfile(), ignoreEffortChange: true });
    const provider = new AcpProvider({ agentType: "codex", executable: agent.executable, cwd: tempCwd() });
    try {
      await expect(drain(provider.sendStream("must not run", { model: "gpt-5.4", effort: "xhigh" }))).rejects.toThrow("acp_effort_unacknowledged");
      expect(only(agent.requests(), "session/set_config_option")).toHaveLength(1);
      expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("rejects an explicitly requested effort the selected model does not advertise", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await expect(drain(provider.sendStream("hi", {
      chatId: "c1",
      model: "gpt-5.4",
      effort: "ultra",
    }))).rejects.toMatchObject({
      name: "UnsupportedAcpEffortError",
      code: "acp_effort_unsupported",
      model: "gpt-5.4",
      effort: "ultra",
      supportedEfforts: ["low", "medium", "xhigh"],
    });
    await provider.close();

    expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
  });

  it("validates an explicit effort even when it equals the agent's current value", async () => {
    const agent = fakeAgent(claudeProfile());
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    // `default` is an ACP selector sentinel, not a persisted effort choice.
    // It starts as current, so this catches implementations that skip validation
    // solely because requestedEffort === currentValue.
    await expect(drain(provider.sendStream("hi", {
      chatId: "c1",
      effort: "default",
    }))).rejects.toMatchObject({
      name: "UnsupportedAcpEffortError",
      effort: "default",
      supportedEfforts: ["high"],
    });
    await provider.close();

    expect(only(agent.requests(), "session/prompt")).toHaveLength(0);
  });

  it("leaves effort unset when the caller follows the agent default", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1", effort: "" }));
    await provider.close();

    expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
    expect(only(agent.requests(), "session/prompt")).toHaveLength(1);
  });

  // Selecting a model makes the agent re-derive the effort behind our back
  // (codex index.js:29372-29374, claude acp-agent.js:4084-4100). Tracking the
  // effort we last *asked for* instead of re-reading the refreshed option makes
  // the requested value look already-applied, and it is silently never sent.
  it("re-applies the effort the model switch reset behind our back", async () => {
    const agent = fakeAgent({ ...codexProfile(), effortAfterModel: { "gpt-5.5": "low" } });
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    // "medium" is what the session started on, so it only needs re-sending
    // because selecting gpt-5.5 knocked the agent down to "low".
    await drain(provider.sendStream("hi", { chatId: "c1", model: "gpt-5.5", effort: "medium" }));
    await provider.close();

    expect(only(agent.requests(), "session/set_config_option").map((r) => r.params)).toEqual([
      { sessionId: "sess-1", configId: "model", value: "gpt-5.5" },
      { sessionId: "sess-1", configId: "reasoning_effort", value: "medium" },
    ]);
  });

  it("does not re-send the model the agent already reports as current", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      model: "gpt-5.4",
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1" }));
    await provider.close();

    expect(only(agent.requests(), "session/set_config_option")).toHaveLength(0);
  });
});

describe("AcpProvider permission mode", () => {
  it("defaults a codex session to the agent's full-access mode", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1" }));
    await provider.close();

    expect(only(agent.requests(), "session/set_mode").map((r) => r.params.modeId)).toEqual(["agent-full-access"]);
  });

  // codex-acp returns a model catalog on session/new that claude never sends
  // (dist/index.js:29806-29810, built by createModelState at :29717-29729).
  it("retains everything the agent advertised for the session", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });
    await drain(provider.sendStream("hi", { chatId: "c1" }));

    const entry = (provider as unknown as { _pool: Map<string, any> })._pool.get("c1");
    expect(entry.configOptions.map((o: SessionConfigOption) => o.id)).toEqual(["model", "reasoning_effort"]);
    expect(entry.models).toEqual(CODEX_MODEL_CATALOG);
    expect(entry.client.initializeResult.agentCapabilities.sessionCapabilities.additionalDirectories).toEqual({});
    await provider.close();
  });

  it("exposes the agent's advertised modes for /switch", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    expect(provider.advertisedModes("c1")).toBeUndefined();
    await drain(provider.sendStream("hi", { chatId: "c1" }));
    expect(provider.advertisedModes("c1")?.availableModes.map((m) => m.id)).toEqual([
      "read-only", "agent", "agent-full-access",
    ]);
    await provider.close();
  });
});

describe("AcpProvider warm session reuse", () => {
  // Both bridges bind cwd at session creation (acp-agent.js:4447; codex
  // threadStart), so reusing the pooled session ran the turn in the previous
  // working directory.
  it("recreates the session when the cwd changes", async () => {
    const agent = fakeAgent(claudeProfile());
    const first = tempCwd();
    const second = tempCwd();
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: first,
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("one", { chatId: "c1" }));
    await drain(provider.sendStream("two", { chatId: "c1", cwd: second }));
    await provider.close();

    expect(only(agent.requests(), "session/new").map((r) => r.params.cwd)).toEqual([first, second]);
  });

  it("recreates the session when the MCP server set changes", async () => {
    const agent = fakeAgent(claudeProfile());
    const cwd = tempCwd();
    let servers: McpServerConfig[] = [];
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd,
      getMcpServers: () => servers,
    });

    await drain(provider.sendStream("one", { chatId: "c1" }));
    servers = [{ name: "recall", command: "/bin/recall", args: [], env: [] }];
    await drain(provider.sendStream("two", { chatId: "c1" }));
    await provider.close();

    const news = only(agent.requests(), "session/new");
    expect(news).toHaveLength(2);
    expect(news[1].params.mcpServers).toEqual(servers);
  });

  it("re-applies only model/effort/mode on an otherwise unchanged session", async () => {
    const agent = fakeAgent(codexProfile());
    const cwd = tempCwd();
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd,
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("one", { chatId: "c1", model: "gpt-5.5", effort: "low" }));
    await drain(provider.sendStream("two", { chatId: "c1", model: "gpt-5.5", effort: "xhigh" }));
    await provider.close();

    expect(only(agent.requests(), "session/new")).toHaveLength(1);
    expect(only(agent.requests(), "session/set_config_option").map((r) => r.params.value)).toEqual([
      "gpt-5.5", "low", "xhigh",
    ]);
    expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
  });

  it("discards a warm session when a model switch leaves an unsupported effort", async () => {
    const agent = fakeAgent({
      ...codexProfile(),
      effortAfterModel: { "gpt-5.5": "low" },
      effortOptionsAfterModel: {
        "gpt-5.5": [{ value: "low", name: "Low" }],
      },
    });
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("one", { chatId: "c1" }));
    await expect(drain(provider.sendStream("invalid", {
      chatId: "c1",
      model: "gpt-5.5",
      effort: "xhigh",
    }))).rejects.toMatchObject({
      name: "UnsupportedAcpEffortError",
      model: "gpt-5.5",
      effort: "xhigh",
      supportedEfforts: ["low"],
    });
    await drain(provider.sendStream("three", { chatId: "c1" }));
    await provider.close();

    expect(only(agent.requests(), "session/new")).toHaveLength(2);
    expect(only(agent.requests(), "session/close")).toHaveLength(2);
    expect(only(agent.requests(), "session/prompt")).toHaveLength(2);
  });

  it("recreates the ACP process/session when the Plugin fingerprint changes", async () => {
    const agent = fakeAgent(claudeProfile());
    const pluginDir = tempCwd();
    const provider = new AcpProvider({
      agentType: "claude",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("one", {
      chatId: "c1",
      pluginPaths: [pluginDir],
      pluginFingerprint: "sha256:v1",
    } as any));
    await drain(provider.sendStream("two", {
      chatId: "c1",
      pluginPaths: [pluginDir],
      pluginFingerprint: "sha256:v2",
    } as any));
    await provider.close();

    expect(only(agent.requests(), "session/new")).toHaveLength(2);
    expect(agent.envs()).toHaveLength(2);
  });
});
