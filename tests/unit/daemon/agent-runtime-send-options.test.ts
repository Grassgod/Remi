/**
 * AgentRuntime → AgentSession → SendOptions plumbing.
 *
 * Everything the assembly layer resolves (model, reasoning effort, cwd,
 * resumed session id, system prompt) only reaches the ACP provider through
 * AgentSession.buildSendOptions(); anything it forgets to copy is silently
 * dropped for every caller that does not reach around the session layer.
 */

import { test, expect } from "bun:test";
import { AgentRuntime } from "@daemon/agent-runtime/runtime.js";
import { AgentSession } from "@daemon/agent-runtime/session.js";
import type { AgentSessionConfig, EphemeralContext, PersistentContext } from "@daemon/agent-runtime/types.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { Provider, ProviderEvent, SendOptions } from "@shared/contracts/provider-types.js";

function ephemeralContext(agent: Partial<NonNullable<AgentTask["agent"]>>, task: Partial<AgentTask> = {}): EphemeralContext {
  return {
    kind: "ephemeral",
    task: {
      id: "tsk_1",
      workspaceId: "local",
      prompt: "do it",
      repos: [],
      projectResources: [],
      agent: {
        id: "agt_1",
        name: "Agent",
        provider: "claude",
        model: null,
        instructions: "",
        skills: [],
        cwd: null,
        executable: null,
        allowedTools: [],
        customEnv: {},
        ...agent,
      },
      ...task,
    } as unknown as AgentTask,
    daemonOptions: { daemonPort: 0, serverUrl: "http://127.0.0.1:1", workspacesRoot: "/tmp" },
    workDir: "/tmp/work",
    signal: new AbortController().signal,
  };
}

function persistentContext(overrides: { model?: string; provider?: string; sessionProvider?: string } = {}): PersistentContext {
  return {
    kind: "persistent",
    message: { chatId: "c1", text: "hi", metadata: {} } as any,
    config: {
      provider: {
        default: "claude",
        claude: { timeout: 300, allowedTools: [], model: overrides.model },
        codex: { timeout: 300, allowedTools: [], model: "gpt-codex-cfg" },
      },
      mcp: [
        { name: "recall", command: "/bin/recall", args: ["--stdio"], env: { TOKEN: "t" } },
        { name: "bare", command: "/bin/bare" },
        { name: "codex-only", command: "/bin/codex-mcp", agents: ["codex"] },
      ],
    } as any,
    groupConfig: overrides.provider ? ({ provider: overrides.provider, systemPrompt: "group rules" } as any) : null,
    memory: { readMemory: () => "remembered facts" } as any,
    sessionRow: overrides.sessionProvider ? ({ provider: overrides.sessionProvider } as any) : null,
    sessionKey: "c1",
  };
}

/** Captures the SendOptions the session hands the provider. */
function capturingProvider(): { provider: Provider; seen: SendOptions[] } {
  const seen: SendOptions[] = [];
  const provider: Provider = {
    name: "fake",
    async send() { return { text: "" }; },
    async *sendStream(_message: string, options?: SendOptions): AsyncGenerator<ProviderEvent> {
      seen.push(options ?? {});
      yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "ok" }] } as ProviderEvent;
    },
    getLastResponse: () => null,
    async healthCheck() { return true; },
  };
  return { provider, seen };
}

async function runOnce(config: AgentSessionConfig): Promise<SendOptions> {
  const { provider, seen } = capturingProvider();
  const session = new AgentSession(provider, config);
  const iter = session.run("prompt");
  while (!(await iter.next()).done) { /* drain */ }
  return seen[0]!;
}

test("ephemeral identity turns the agent's thinking_level into an effort override", () => {
  const config = new AgentRuntime().assemble(ephemeralContext({ thinkingLevel: "xhigh" }));
  expect(config.effort).toBe("xhigh");
});

test('ephemeral identity treats an empty/absent thinking_level as "no override"', () => {
  expect(new AgentRuntime().assemble(ephemeralContext({ thinkingLevel: "" })).effort).toBeNull();
  expect(new AgentRuntime().assemble(ephemeralContext({})).effort).toBeNull();
});

test("persistent identity resolves the model of the provider that will run the turn", () => {
  expect(new AgentRuntime().assemble(persistentContext({ model: "claude-cfg" })).model).toBe("claude-cfg");
  // Group config and the session's own P2P choice both steer which agent runs,
  // so the assembled model has to follow them instead of the global default.
  expect(new AgentRuntime().assemble(persistentContext({ provider: "codex" })).model).toBe("gpt-codex-cfg");
  expect(new AgentRuntime().assemble(persistentContext({ sessionProvider: "codex" })).model).toBe("gpt-codex-cfg");
});

test("persistent mcp block emits the ACP McpServerStdio wire shape from remi.toml", () => {
  const config = new AgentRuntime().assemble(persistentContext());
  // args + env are required and env is an EnvVariable[]; a Record env or a
  // missing args key is dropped silently by both bridges (vecSkipError).
  expect(JSON.stringify(config.mcpServers)).toBe(
    '[{"name":"recall","command":"/bin/recall","args":["--stdio"],"env":[{"name":"TOKEN","value":"t"}]},'
    + '{"name":"bare","command":"/bin/bare","args":[],"env":[]}]',
  );
});

test("AgentSession forwards model and effort to the provider", async () => {
  const config = new AgentRuntime().assemble(ephemeralContext({ model: "claude-sonnet-4-5", thinkingLevel: "high" }));
  const options = await runOnce(config);
  expect(options.model).toBe("claude-sonnet-4-5");
  expect(options.effort).toBe("high");
});

test("ephemeral Agent Plugin preparation reaches ACP without changing cwd", async () => {
  const ctx = ephemeralContext({ provider: "codex" });
  ctx.pluginRuntime = {
    runtimeRoot: "/daemon/workspaces/.task-runtime/tsk_1/.remi-runtime",
    pluginPaths: ["/daemon/cache/plugin-v1"],
    pluginFingerprint: "sha256:plugin-v1",
    executionFingerprint: "sha256:execution-v1",
    codexHome: "/daemon/workspaces/.task-runtime/tsk_1/.remi-runtime/codex-home/execution-v1",
  };
  const config = new AgentRuntime().assemble(ctx);
  const options = await runOnce(config) as SendOptions & {
    pluginPaths?: string[];
    pluginFingerprint?: string;
    codexHome?: string;
  };

  expect(options.cwd).toBe("/tmp/work");
  expect(options.pluginPaths).toEqual(["/daemon/cache/plugin-v1"]);
  expect(options.pluginFingerprint).toBe("sha256:execution-v1");
  expect(options.codexHome).toContain("/.remi-runtime/codex-home/");
});

test("a continued turn forwards the pinned session id and the current cwd", async () => {
  const config = new AgentRuntime().assemble(ephemeralContext({}, { sessionId: "sess-resumed" }));
  const options = await runOnce(config);
  expect(options.sessionId).toBe("sess-resumed");
  expect(options.cwd).toBe("/tmp/work");
});

test("ephemeral stale sessions report once and never replay inside the daemon", async () => {
  let sends = 0;
  let clears = 0;
  const provider = {
    name: "stale",
    async send() { return { text: "" }; },
    async *sendStream(): AsyncGenerator<ProviderEvent> {
      sends += 1;
      throw new Error("no conversation found for session");
    },
    getLastResponse: () => null,
    clearSession: async () => { clears += 1; },
    async healthCheck() { return true; },
  } as Provider & { clearSession: () => Promise<void> };
  const config = new AgentRuntime().assemble(ephemeralContext({}, { sessionId: "sess_stale" }));
  expect(config.recovery).toBeUndefined();
  const drain = async () => {
    for await (const _event of new AgentSession(provider, config).run("resume")) {
      // A stale provider emits no useful events before the stable error.
    }
  };
  await expect(drain()).rejects.toThrow("Stale provider session: no conversation found");
  expect(sends).toBe(1);
  expect(clears).toBe(0);
});

test("AgentSession forwards the assembled system prompt and memory context", async () => {
  const config = new AgentRuntime().assemble(persistentContext({ provider: "claude" }));
  const options = await runOnce(config);
  expect(options.systemPrompt).toContain("group rules");
  expect(options.systemPrompt).toContain("remembered facts");
  expect(options.context).toBe("remembered facts");
});
