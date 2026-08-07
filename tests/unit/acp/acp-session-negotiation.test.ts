/**
 * What AcpProvider actually puts on the wire when it opens a session, and what
 * it does with what the agent advertises back.
 *
 * The fake agent records every request it receives to a log file, so each test
 * asserts against the real JSON-RPC frames rather than internal state. Ground
 * truth for every expectation is the pinned bridge source
 * (@agentclientprotocol/claude-agent-acp 0.66.0, codex-acp 1.1.14).
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpProvider } from "@acp/index.js";
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
log({ kind: "env", ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let sessionSeq = 0;
let configOptions = PROFILE.configOptions;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  log({ kind: "request", method: msg.method, params: msg.params });
  if (msg.id == null) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": return ok(PROFILE.initialize);
    case "session/new": return ok({ sessionId: "sess-" + (++sessionSeq), modes: PROFILE.modes, configOptions, models: PROFILE.models });
    case "session/resume":
    case "session/load": return ok({ sessionId: msg.params.sessionId, modes: PROFILE.modes, configOptions, models: PROFILE.models });
    case "session/set_mode": return ok({});
    case "session/set_config_option": {
      configOptions = configOptions.map((o) => o.id === msg.params.configId ? { ...o, currentValue: msg.params.value } : o);
      const forcedEffort = msg.params.configId === "model" ? (PROFILE.effortAfterModel || {})[msg.params.value] : undefined;
      if (forcedEffort) {
        configOptions = configOptions.map((o) => o.category === "thought_level" ? { ...o, currentValue: forcedEffort } : o);
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
    // codex-acp reads only `terminal_output` from client capability _meta
    // (dist/index.js:22754-22760).
    expect(initialize.params.clientCapabilities._meta).toEqual({ terminal_output: true });
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
});

describe("AcpProvider model and effort", () => {
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

  it("skips a model the agent does not advertise instead of failing the turn", async () => {
    const agent = fakeAgent(codexProfile());
    const provider = new AcpProvider({
      agentType: "codex",
      executable: agent.executable,
      cwd: tempCwd(),
      getMcpServers: () => [],
    });

    await drain(provider.sendStream("hi", { chatId: "c1", model: "o3-not-offered", effort: "nonsense" }));
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
});
