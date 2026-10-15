/**
 * Native subagent child sessions in the ACP provider (PR 5 §1), against a
 * scripted agent that speaks real JSON-RPC (tests/fixtures/acp/
 * fake-subagent-agent.ts). Wire shapes: claude-agent-acp 0.90 AIR form and
 * codex-acp 2.2.2 with `nativeSubagentSessions` (live captures
 * claude-090-native-subagent-*.json, codex-222-native-subagent-wait.json).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "@acp/client.js";
import { AcpProvider, type AcpProviderOptions } from "@acp/provider.js";
import type { PermissionOutcome, RequestPermissionParams } from "@shared/contracts/acp-protocol.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import type { FakeSubagentConfig, FakeSubagentStep } from "../../fixtures/acp/fake-subagent-agent.js";

const AGENT = join(import.meta.dir, "../../fixtures/acp/fake-subagent-agent.ts");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Logged { kind: string; method?: string; params?: Record<string, any>; result?: any; at: number }

function fakeAgent(agentType: "claude" | "codex" | "antigravity", config: FakeSubagentConfig, options: Partial<AcpProviderOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acp-native-subagents-"));
  const logPath = join(dir, "frames.jsonl");
  const provider = new AcpProvider({
    agentType, executable: process.execPath, args: [AGENT], cwd: dir, getMcpServers: () => [],
    env: { FAKE_SUBAGENT_CONFIG: JSON.stringify(config), FAKE_SUBAGENT_LOG: logPath },
    nativeSubagentSessions: true,
    ...options,
  });
  cleanups.push(async () => { await provider.close(); rmSync(dir, { recursive: true, force: true }); });
  const frames = (): Logged[] => existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { provider, frames, requests: (method: string) => frames().filter((frame) => frame.kind === "request" && frame.method === method) };
}

async function collect(provider: AcpProvider, prompt = "go", chatId = "chat", sessionId?: string): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.sendStream(prompt, { chatId, sessionId })) events.push(event);
  return events;
}

const meta = (event: ProviderEvent) => ((event as { _meta?: Record<string, any> })._meta ?? {}) as Record<string, any>;
const kinds = (events: ProviderEvent[]) => events.map((event) => `${meta(event).remiSessionId ?? "root"}:${event.sessionUpdate}`);
const chunk = (text: string, extra: Record<string, unknown> = {}) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...extra });
const spawned = (subagentSessionId: string, extra: Record<string, unknown> = {}): FakeSubagentStep =>
  ({ update: { sessionUpdate: "subagent_spawned", subagentSessionId, name: "Count files", task: "List the files", prompt: "List the files",
    capabilities: {}, ...extra } });
const ended = (subagentSessionId: string, state = "completed", session?: string): FakeSubagentStep =>
  ({ update: { sessionUpdate: "subagent_state_update", subagentSessionId, state }, ...(session ? { session } : {}) });
const childBash = (session: string, id: string): FakeSubagentStep[] => [
  { session, update: { sessionUpdate: "tool_call", toolCallId: id, name: "Bash", kind: "execute", status: "pending", title: "ls",
    rawInput: { command: "ls" }, _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "toolu_agent" } } } },
  { session, update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "a.txt" } },
];
const CHILD = "a0000000000000001";
const NESTED = "a0000000000000002";

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

const sessionMap = (provider: AcpProvider) => (provider as unknown as { _sessionToChatId: Map<string, string> })._sessionToChatId;

describe("AcpClient native subagent capabilities", () => {
  it("claude asks with `subagents: {}`; codex also with the AIR capability; the switch off asks for neither", async () => {
    const claude = fakeAgent("claude", { prompts: [[]] });
    await collect(claude.provider);
    const claudeCaps = claude.requests("initialize")[0]!.params!.clientCapabilities;
    expect(claudeCaps.subagents).toEqual({});
    expect(claudeCaps._meta.jetbrains.air.capabilities).toEqual(["sessionFailure"]);

    const codex = fakeAgent("codex", { advertise: "codex", prompts: [[]] });
    await collect(codex.provider);
    const codexCaps = codex.requests("initialize")[0]!.params!.clientCapabilities;
    expect(codexCaps.subagents).toEqual({});
    expect(codexCaps._meta.jetbrains.air.capabilities).toEqual(["recommendedValue", "sessionFailure", "nativeSubagentSessions"]);

    const off = fakeAgent("codex", { advertise: "codex", prompts: [[]] }, { nativeSubagentSessions: false });
    await collect(off.provider);
    const offCaps = off.requests("initialize")[0]!.params!.clientCapabilities;
    expect(offCaps.subagents).toBeUndefined();
    expect(offCaps._meta.jetbrains.air.capabilities).toEqual(["recommendedValue", "sessionFailure"]);
  });

  it("nativeSubagentsEnabled needs the request and either advertisement", () => {
    const client = (requested: boolean, result: unknown) => {
      const value = new AcpClient({ nativeSubagents: requested ? { airCapability: false } : null });
      (value as unknown as { _initializeResult: unknown })._initializeResult = result;
      return value;
    };
    expect(client(true, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { subagents: {} } } }).nativeSubagentsEnabled).toBe(true);
    expect(client(true, { protocolVersion: 1, _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } })
      .nativeSubagentsEnabled).toBe(true);
    expect(client(true, { protocolVersion: 1, agentCapabilities: {} }).nativeSubagentsEnabled).toBe(false);
    expect(client(false, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { subagents: {} } } }).nativeSubagentsEnabled).toBe(false);
    expect(new AcpClient({ nativeSubagents: { airCapability: true } }).nativeSubagentsEnabled).toBe(false);
  });

  it("antigravity declares no native subagents and never asks", async () => {
    const provider = new AcpProvider({ agentType: "antigravity", nativeSubagentSessions: true });
    expect(provider.adapter.nativeSubagents).toBeUndefined();
    expect(provider.adapter.autonomousRounds).toBeUndefined();
    expect(new AcpProvider({ agentType: "claude" }).adapter.nativeSubagents).toEqual({ airCapability: false });
    expect(new AcpProvider({ agentType: "codex" }).adapter.nativeSubagents).toEqual({ airCapability: true });
    expect(new AcpProvider({ agentType: "codex" }).adapter.autonomousRounds).toBeUndefined();
  });
});

describe("AcpProvider child-session registry (PR 5 §1.2)", () => {
  it("accepts announced children, nested ones too, stamps their frames and leaves root frames as sent", async () => {
    const agent = fakeAgent("claude", { prompts: [[
      { update: chunk("Delegating. ") },
      spawned(CHILD),
      ...childBash(CHILD, "toolu_c1"),
      { session: CHILD, update: { sessionUpdate: "subagent_spawned", subagentSessionId: NESTED, name: "Nested", task: "x", capabilities: {} } },
      { session: NESTED, update: chunk("nested work", { _meta: { claudeCode: { parentToolUseId: "toolu_nested" } } }) },
      { session: CHILD, update: { sessionUpdate: "subagent_state_update", subagentSessionId: NESTED, state: "completed" } },
      ended(CHILD),
      { update: chunk("Done.") },
    ]] });
    const events = await collect(agent.provider);
    expect(kinds(events).filter((kind) => !kind.endsWith("config_option_update"))).toEqual([
      "root:agent_message_chunk", "root:subagent_spawned", `${CHILD}:tool_call`, `${CHILD}:tool_call_update`,
      `${CHILD}:subagent_spawned`, `${NESTED}:agent_message_chunk`, `${CHILD}:subagent_state_update`, "root:subagent_state_update",
      "root:agent_message_chunk",
    ]);
    // Root frames carry no stamp at all; child frames keep their own _meta beside it.
    const root = events.find((event) => event.sessionUpdate === "subagent_spawned")!;
    expect(meta(root)).toEqual({});
    const nested = events.find((event) => meta(event).remiSessionId === NESTED)!;
    expect(meta(nested)).toEqual({ claudeCode: { parentToolUseId: "toolu_nested" }, remiSessionId: NESTED });
    // Both children route to the chat, and stay registered after their state update.
    expect(sessionMap(agent.provider).get(CHILD)).toBe("chat");
    expect(sessionMap(agent.provider).get(NESTED)).toBe("chat");
  });

  it("drops frames of unknown sessions, logging each id once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agent = fakeAgent("claude", { prompts: [[
        { session: "stranger", update: chunk("leak 1") },
        { session: "stranger", update: chunk("leak 2") },
        { update: chunk("Answer.") },
      ]] });
      const events = await collect(agent.provider);
      expect(events.flatMap((event) => event.sessionUpdate === "agent_message_chunk" ? [(event.content as unknown as { text: string }).text] : []))
        .toEqual(["Answer."]);
      expect(warn.mock.calls.filter(([line]) => String(line).includes("unknown session stranger"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps child config, model, text and context out of the root turn", async () => {
    const agent = fakeAgent("codex", { advertise: "codex", prompts: [[
      { update: { sessionUpdate: "usage_update", used: 14_000, size: 475_000 } },
      spawned(CHILD),
      { session: CHILD, update: { sessionUpdate: "config_option_update", id: "model", value: "child-model" } },
      { session: CHILD, update: chunk("child answer", { _meta: { jetbrains: { air: { version: 1, phase: "final_answer" } } } }) },
      // A child's context occupancy (codex-acp sends it on the child session).
      { session: CHILD, update: { sessionUpdate: "usage_update", used: 17_000, size: 300_000, _meta: { remiUsageMode: "request" } } },
      ended(CHILD),
      // Claude A-mode subagent prose stamped on the root is not the reply either (F5).
      { update: chunk("stamped prose", { _meta: { claudeCode: { parentToolUseId: "toolu_agent" } } }) },
      { update: chunk("3") },
    ]] });
    await collect(agent.provider);
    const response = agent.provider.getLastResponse()!;
    expect(response.text).toBe("3");
    expect(agent.provider.getStreamedText("chat")).toBe("3");
    expect(response.contextWindow).toBe(475_000);
    expect(response.metadata?.contextUsage).toMatchObject({ used: 14_000, size: 475_000 });
    const entry = (agent.provider as unknown as { _pool: Map<string, { models?: { currentModelId: string }; configOptions?: unknown }> })
      ._pool.get("chat")!;
    expect(JSON.stringify(entry.configOptions ?? null)).not.toContain("child-model");
  });

  it("bills a child's requests (context: false keeps only the billing)", async () => {
    const agent = fakeAgent("claude", { prompts: [[
      spawned(CHILD),
      { billing: { session: CHILD, used: 9_999, size: 9_999 } },
      ended(CHILD),
      { billing: {} },
    ]] });
    const events = await collect(agent.provider);
    const child = events.find((event) => event.sessionUpdate === "usage_update" && meta(event).remiSessionId === CHILD)!;
    const units = (meta(child).remiUsageUnits as Array<{ source: string }>).filter((unit) => unit.source === "provider_request");
    expect(units).toHaveLength(1);
    const billed = (agent.provider.getLastResponse()!.metadata!.usageUnits as Array<{ source: string }>)
      .filter((unit) => unit.source === "provider_request");
    expect(billed).toHaveLength(2);
    // Never the child's window or occupancy.
    expect(agent.provider.getLastResponse()!.contextWindow).toBeNull();
  });

  it("a child's session failure and compaction failure end only that child, never the root turn", async () => {
    const failure = { id: "child-fail", revision: 1, category: "unknown", severity: "error", title: "Child failed", details: "boom" };
    const agent = fakeAgent("claude", { prompts: [[
      spawned(CHILD),
      { session: CHILD, update: { sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { sessionFailure: failure } } } } },
      { session: CHILD, update: { sessionUpdate: "compaction_update", compactionId: "cmp1", status: "failed", error: "no room" } },
      ended(CHILD, "failed"),
      { update: chunk("Recovered.") },
    ]] });
    const events = await collect(agent.provider);
    expect(agent.provider.getLastResponse()?.metadata?.sessionFailure).toBeUndefined();
    const info = events.find((event) => event.sessionUpdate === "session_info_update")!;
    expect(meta(info)).toMatchObject({ remiSessionId: CHILD, jetbrains: { air: { sessionFailure: { id: "child-fail" } } } });

    // The same failure on the root fails the turn.
    const rootFailure = fakeAgent("claude", { prompts: [[
      { update: { sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { sessionFailure: failure } } } } },
    ]] });
    await expect(collect(rootFailure.provider)).rejects.toThrow();
  });

  it("child frames neither start the prompt for steering nor count as its tool calls", async () => {
    let started = false;
    const agent = fakeAgent("claude", { prompts: [[
      spawned(CHILD),
      { session: CHILD, update: { sessionUpdate: "tool_call", toolCallId: "toolu_c1", name: "Bash", status: "pending", kind: "execute" } },
      { delayMs: 150, update: chunk("Root speaks.") },
      { delayMs: 50, resolve: "end_turn" },
    ]] });
    const run = (async () => {
      for await (const _ of agent.provider.sendStream("go", { chatId: "chat", onPromptStarted: () => { started = true; } })) { /* drain */ }
    })();
    await until(() => sessionMap(agent.provider).has(CHILD), "child registered");
    await Bun.sleep(60);
    const entry = (agent.provider as unknown as { _pool: Map<string, { turnUpdates: number; openToolCalls: Set<string> }> })._pool.get("chat")!;
    expect(started).toBe(false);
    expect(entry.turnUpdates).toBe(0);
    expect(entry.openToolCalls.size).toBe(0);
    await run;
    expect(started).toBe(true);
  });
});

describe("AcpProvider child permissions and questions (PR 5 §1.3)", () => {
  it("routes a child's permission to the chat's own handler and counts it as a waiting person", async () => {
    const agent = fakeAgent("claude", { steering: true, prompts: [[
      spawned(CHILD),
      { session: CHILD, update: { sessionUpdate: "tool_call", toolCallId: "toolu_w", name: "Write", kind: "edit", status: "pending" } },
      { permission: { session: CHILD, toolCallId: "toolu_w" } },
      { session: CHILD, update: { sessionUpdate: "tool_call_update", toolCallId: "toolu_w", status: "completed" } },
      ended(CHILD),
      { update: chunk("done") },
    ]] });
    // packages/remi registers per chat: without routing a child request fell through to "cancelled".
    const seen: RequestPermissionParams[] = [];
    let release: (outcome: PermissionOutcome) => void = () => {};
    agent.provider.setPermissionHandler((params) => {
      seen.push(params);
      return new Promise((resolve) => { release = resolve; });
    }, "chat");
    const run = collect(agent.provider);
    await until(() => seen.length === 1, "permission request");
    expect(seen[0]!.sessionId).toBe(CHILD);
    const entry = (agent.provider as unknown as { _pool: Map<string, { userInputs: number }> })._pool.get("chat")!;
    expect(entry.userInputs).toBe(1);
    // PR 3's guard: no native steer while the child's card waits.
    expect(await agent.provider.steer("hurry", { chatId: "chat" })).toEqual({ outcome: "promptRequired", reason: "userInputPending" });
    expect(agent.requests("_session/steering")).toHaveLength(0);
    release({ outcome: "selected", optionId: "allow" });
    await run;
    expect(entry.userInputs).toBe(0);
    expect(agent.frames().find((frame) => frame.kind === "permission_answer")?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("routes a child's question to the chat's own elicitation handler", async () => {
    const agent = fakeAgent("claude", { prompts: [[
      spawned(CHILD),
      { elicitation: { session: CHILD, toolCallId: "toolu_q", message: "Which env?", options: ["staging", "production"] } },
      ended(CHILD),
    ]] });
    const asked: string[] = [];
    agent.provider.setElicitationHandler(async (params) => {
      asked.push(params.sessionId);
      return { action: "accept", content: { question_0: "staging" } };
    }, "chat");
    await collect(agent.provider);
    expect(asked).toEqual([CHILD]);
    expect(agent.frames().find((frame) => frame.kind === "elicitation_answer")?.result).toEqual({ action: "accept", content: { question_0: "staging" } });
  });

  it("forgets the children wherever it forgets the root", async () => {
    const agent = fakeAgent("claude", { prompts: [[spawned(CHILD), spawned(NESTED)]] });
    await collect(agent.provider);
    expect([...sessionMap(agent.provider).keys()].sort()).toEqual([CHILD, NESTED, "sess_root"].sort());
    await agent.provider.clearSession("chat");
    expect(sessionMap(agent.provider).size).toBe(0);
  });
});

describe("AcpProvider resume (PR 5 §1.5)", () => {
  it("a resumed process replays no earlier child into the next prompt", async () => {
    const agent = fakeAgent("claude", {
      prompts: [[spawned(CHILD), ended(CHILD), { update: chunk("first") }]],
      // The resumed bridge still talks about the earlier child: nothing announced it on this process.
      resumedPrompts: [[{ session: CHILD, update: chunk("stale child text") }, { update: chunk("second") }]],
    });
    await collect(agent.provider);
    await agent.provider.close();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await collect(agent.provider, "again", "chat", "sess_root");
      expect(agent.requests("session/resume")).toHaveLength(1);
      expect(events.some((event) => meta(event).remiSessionId)).toBe(false);
      expect(events.flatMap((event) => event.sessionUpdate === "agent_message_chunk" ? [(event.content as unknown as { text: string }).text] : []))
        .toEqual(["second"]);
    } finally {
      warn.mockRestore();
    }
  });
});
