/**
 * Native steering on the ACP client and provider (ADR 0020), against a scripted
 * agent that speaks real JSON-RPC over stdio (tests/fixtures/acp/
 * fake-steering-agent.ts). Ground truth for the bridge behaviour is the pinned
 * dist: claude-agent-acp 0.90.0 dist/acp-agent.js:203, 233-257, 1427-1429,
 * 2380-2451; codex-acp 2.2.2 dist/index.js:39759, 42474-42477, 43787-43998.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "@acp/client.js";
import { AcpProvider } from "@acp/provider.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import type { FakeSteerConfig } from "../../fixtures/acp/fake-steering-agent.js";

const AGENT = join(import.meta.dir, "../../fixtures/acp/fake-steering-agent.ts");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Logged { kind: string; method?: string; params?: Record<string, any>; at: number }

function fakeAgent(agentType: "claude" | "codex", config: FakeSteerConfig,
  options: { steerTimeoutMs?: number; toolCallWaitMs?: number; steerRetryWindowMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acp-steering-"));
  const logPath = join(dir, "frames.jsonl");
  const provider = new AcpProvider({
    agentType, executable: process.execPath, args: [AGENT], cwd: dir, getMcpServers: () => [],
    env: { FAKE_STEER_CONFIG: JSON.stringify(config), FAKE_STEER_LOG: logPath, REMI_TEST_TOKEN: "sk-fake-secret" },
    ...options,
  });
  cleanups.push(async () => { await provider.close(); rmSync(dir, { recursive: true, force: true }); });
  const frames = (): Logged[] => existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    provider,
    frames,
    requests: (method: string) => frames().filter((frame) => frame.kind === "request" && frame.method === method),
  };
}

/** Run one prompt in the background, collecting its events. */
function stream(provider: AcpProvider, prompt: string, chatId = "chat", sessionId?: string) {
  const events: ProviderEvent[] = [];
  let started = false;
  const done = (async () => {
    for await (const event of provider.sendStream(prompt, { chatId, sessionId, onPromptStarted: () => { started = true; } })) {
      events.push(event);
    }
  })();
  return { events, done, get started() { return started; } };
}

const texts = (events: ProviderEvent[]) => events.flatMap((event) => event.sessionUpdate === "agent_message_chunk"
  ? [(event.content as { text?: string }).text ?? ""] : []);
/** The billed request units the stream reported (context snapshots excluded). */
const usageUnitIds = (events: ProviderEvent[]) => events.flatMap((event) => event.sessionUpdate === "usage_update"
  ? (((event._meta as Record<string, unknown> | undefined)?.remiUsageUnits ?? []) as Array<{ unitId: string; source: string }>)
    .filter((unit) => unit.source === "provider_request").map((unit) => unit.unitId) : []);

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

describe("AcpClient steering capability", () => {
  const client = (meta: unknown, agentCapabilities?: unknown) => {
    const value = new AcpClient();
    (value as unknown as { _initializeResult: unknown })._initializeResult = { protocolVersion: 1, agentCapabilities, _meta: meta };
    return value;
  };

  it("reads the top-level advertisement in both bridges' shapes", () => {
    // claude-agent-acp 0.90 puts it after the AIR block, codex-acp 2.2.2 before it.
    expect(client({ jetbrains: { air: { version: 1 } }, steering: { supported: true } }).steeringSupported).toBe(true);
    expect(client({ steering: { supported: true }, jetbrains: { air: { version: 1 } } }).steeringSupported).toBe(true);
  });

  it("treats anything else as unsupported", () => {
    expect(new AcpClient().steeringSupported).toBe(false);
    expect(client(undefined).steeringSupported).toBe(false);
    expect(client({ steering: { supported: false } }).steeringSupported).toBe(false);
    expect(client({ steering: { supported: "true" } }).steeringSupported).toBe(false);
    expect(client({ steering: true }).steeringSupported).toBe(false);
    // Not the advertised place: the bridges never nest it under agentCapabilities.
    expect(client({}, { _meta: { steering: { supported: true } } }).steeringSupported).toBe(false);
  });
});

describe("AcpProvider.steer", () => {
  it("claude: injects into the running prompt with the promptRequired opt-in", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ chunks: ["Working. "], hold: "steer", answer: "Steered answer." }] });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    expect(await agent.provider.steer("[Mid-run user steering] use Chinese", { chatId: "chat" })).toEqual({ outcome: "injected" });
    await run.done;
    expect(texts(run.events)).toEqual(["Working. ", "Steered answer."]);
    expect(agent.requests("session/prompt")).toHaveLength(1);
    expect(agent.requests("session/cancel")).toHaveLength(0);
    expect(agent.requests("_session/steering").map((frame) => frame.params)).toEqual([{
      sessionId: "sess-steer",
      prompt: [{ type: "text", text: "[Mid-run user steering] use Chinese" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    }]);
  });

  it("codex: sends no _meta, which codex-acp would drop anyway", async () => {
    const agent = fakeAgent("codex", { advertise: "codex", prompts: [{ hold: "steer" }] });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "injected" });
    await run.done;
    expect(agent.requests("_session/steering").map((frame) => frame.params)).toEqual([
      { sessionId: "sess-steer", prompt: [{ type: "text", text: "go on" }] },
    ]);
  });

  it("injects into a turn Claude holds open for a background subagent", async () => {
    const agent = fakeAgent("claude", { advertise: "claude",
      prompts: [{ background: true, chunks: ["Started a background count. "], hold: "steer", answer: "Counted 3." }] });
    const run = stream(agent.provider, "count in the background");
    await until(() => texts(run.events).length === 1, "first reply");
    expect(await agent.provider.steer("also report the sizes", { chatId: "chat" })).toEqual({ outcome: "injected" });
    await run.done;
    expect(texts(run.events)).toEqual(["Started a background count. ", "Counted 3."]);
    expect(agent.requests("session/prompt")).toHaveLength(1);
  });

  it("claude: holds the steer while a top-level tool call runs, then injects between calls", async () => {
    const agent = fakeAgent("claude", { advertise: "claude",
      prompts: [{ chunks: ["Running it. "], tool: { ms: 400 }, hold: "steer", answer: "ALPHA BETA" }] });
    const run = stream(agent.provider, "run sleep");
    await until(() => run.events.some((event) => event.sessionUpdate === "tool_call"), "tool call");
    const result = await agent.provider.steer("also BETA", { chatId: "chat" });
    expect(result).toEqual({ outcome: "injected" });
    await run.done;
    const toolDone = agent.frames().find((frame) => frame.kind === "tool_completed")!;
    const steers = agent.requests("_session/steering");
    expect(steers).toHaveLength(1);
    // Sent only once the call ended, so the bridge never backgrounds it.
    expect(steers[0]!.at).toBeGreaterThanOrEqual(toolDone.at);
    expect(texts(run.events)).toEqual(["Running it. ", "ALPHA BETA"]);
  });

  it("claude: a subagent's own calls and a launched background agent do not hold the steer", async () => {
    const agent = fakeAgent("claude", { advertise: "claude",
      prompts: [{ background: true, childTool: true, chunks: ["Launched. "], hold: "steer" }] });
    const run = stream(agent.provider, "background");
    await until(() => texts(run.events).length === 1, "first reply");
    const started = Date.now();
    expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "injected" });
    expect(Date.now() - started).toBeLessThan(500);
    await run.done;
  });

  it("claude: a steer still held when the prompt ends goes back without a wire call", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ tool: { ms: null }, hold: "cancel" }] });
    const abort = new AbortController();
    const events: ProviderEvent[] = [];
    const done = (async () => {
      for await (const event of agent.provider.sendStream("long tool", { chatId: "chat", signal: abort.signal })) events.push(event);
    })().catch(() => {});
    await until(() => events.some((event) => event.sessionUpdate === "tool_call"), "tool call");
    const steer = agent.provider.steer("later", { chatId: "chat" });
    await Bun.sleep(100);
    abort.abort();
    expect(await steer).toEqual({ outcome: "promptRequired", reason: "noActivePrompt" });
    await done;
    expect(agent.requests("_session/steering")).toHaveLength(0);
  });

  it("codex: steers during a running command at once (turn/steer does not stop it)", async () => {
    const agent = fakeAgent("codex", { advertise: "codex", prompts: [{ tool: { ms: 600 }, hold: "steer" }] });
    const run = stream(agent.provider, "run sleep");
    await until(() => run.events.some((event) => event.sessionUpdate === "tool_call"), "tool call");
    expect(await agent.provider.steer("also BETA", { chatId: "chat" })).toEqual({ outcome: "injected" });
    await run.done;
    const toolDone = agent.frames().find((frame) => frame.kind === "tool_completed");
    expect(agent.requests("_session/steering")[0]!.at).toBeLessThan(toolDone?.at ?? Number.MAX_SAFE_INTEGER);
  });

  it("makes no wire call when no prompt is running", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ hold: "none" }] });
    expect(await agent.provider.steer("hello", { chatId: "chat" })).toEqual({ outcome: "promptRequired", reason: "noActivePrompt" });
    await stream(agent.provider, "original").done;
    // The prompt resolved: the session is idle again.
    expect(await agent.provider.steer("late", { chatId: "chat" })).toEqual({ outcome: "promptRequired", reason: "noActivePrompt" });
    expect(agent.requests("_session/steering")).toHaveLength(0);
  });

  it("a bridge promptRequired as the prompt ends reports the prompt ended, with no cancel", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ hold: "cancel" }], steers: ["race"] });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    // The turn settled just before our prompt answered: the round ends by itself.
    expect(await agent.provider.steer("late", { chatId: "chat" })).toEqual({ outcome: "promptRequired", reason: "noActivePrompt" });
    await run.done;
    expect(agent.requests("session/cancel")).toHaveLength(0);
  });

  it("is unsupported without the advertisement or an adapter that steers", async () => {
    const agent = fakeAgent("claude", { advertise: "none", prompts: [{ hold: "steer" }] });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    expect(await agent.provider.steer("hello", { chatId: "chat" })).toEqual({ outcome: "unsupported" });
    expect(agent.requests("_session/steering")).toHaveLength(0);
    const settled = run.done.catch(() => {});
    await agent.provider.close();
    await settled;

    const antigravity = new AcpProvider({ agentType: "antigravity" });
    (antigravity as unknown as { _pool: Map<string, unknown> })._pool.set("chat", {
      promptInFlight: {}, acpSessionId: "s", client: { alive: true, steeringSupported: true },
    });
    expect(await antigravity.steer("hello", { chatId: "chat" })).toEqual({ outcome: "unsupported" });
  });

  it("reports a JSON-RPC error, a failed answer and a timeout as failed, redacted", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ hold: "cancel" }], steers: ["error", "failed", "hang"] },
      { steerTimeoutMs: 200 });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    const error = await agent.provider.steer("a", { chatId: "chat" });
    expect(error.outcome).toBe("failed");
    expect(error.error).toContain("steer refused");
    expect(error.error).not.toContain("sk-fake-secret");
    expect(await agent.provider.steer("b", { chatId: "chat" })).toEqual({ outcome: "failed", error: "The agent could not apply the steer" });
    const started = Date.now();
    expect(await agent.provider.steer("c", { chatId: "chat" })).toEqual({ outcome: "failed", error: "Steer did not answer within 200ms" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(agent.requests("session/cancel")).toHaveLength(0);
    const settled = run.done.catch(() => {});
    await agent.provider.close();
    await settled;
  });

  it("startedNewTurn: cancels the bridge's own turn and waits until it is quiet", async () => {
    const agent = fakeAgent("codex", { advertise: "codex", prompts: [{ hold: "cancel" }, { hold: "none", chunks: ["Re-prompted."] }],
      steers: ["race"] });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    const started = Date.now();
    expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "startedNewTurn" });
    const steerAnswered = Date.now();
    await run.done;
    const cancels = agent.requests("session/cancel");
    expect(cancels).toHaveLength(1);
    // At least the quiet window after cancel, and well under the 5 s cap.
    expect(steerAnswered - cancels[0]!.at).toBeGreaterThanOrEqual(450);
    expect(steerAnswered - started).toBeLessThan(4_000);

    // The detached turn's billing frames reached no stream; the next one replays them.
    const next = stream(agent.provider, "re-prompt");
    await next.done;
    expect(texts(next.events)).toEqual(["Re-prompted."]);
    const replayed = usageUnitIds(next.events);
    const ownRequest = replayed.at(-1)!;
    expect(replayed.length).toBeGreaterThan(2);
    expect(replayed.slice(0, -1).every((id) => id !== ownRequest)).toBe(true);
    const billed = (agent.provider.getLastResponse()?.metadata?.usageUnits as Array<{ unitId: string }>).map((unit) => unit.unitId);
    for (const id of replayed) expect(billed).toContain(id);
    expect(agent.frames().some((frame) => frame.kind === "overlap")).toBe(false);
  });

  it("startedNewTurn: stops a bridge whose own turn never goes quiet, and still bills it", async () => {
    const agent = fakeAgent("codex", { advertise: "codex", prompts: [{ hold: "cancel" }],
      resumedPrompts: [{ hold: "none", chunks: ["Resumed."] }], steers: ["race"], detachedIgnoresCancel: true });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    const started = Date.now();
    expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "startedNewTurn" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    await run.done;
    const entry = (agent.provider as unknown as { _pool: Map<string, { client: AcpClient }> })._pool.get("chat");
    expect(entry?.client.alive ?? false).toBe(false);

    // The re-prompt resumes on a fresh process (the daemon passes the session id) and replays the stopped turn's frames.
    const next = stream(agent.provider, "re-prompt", "chat", "sess-steer");
    await next.done;
    expect(texts(next.events)).toEqual(["Resumed."]);
    expect(agent.requests("session/resume")).toHaveLength(1);
    expect(usageUnitIds(next.events).length).toBeGreaterThan(10);
    expect(agent.frames().some((frame) => frame.kind === "overlap")).toBe(false);
  }, 15_000);

  it("bills usage frames that arrive after the prompt resolved (a task-notification follow-up)", async () => {
    const agent = fakeAgent("claude", { advertise: "claude",
      prompts: [{ chunks: ["Done; the background task reports later."], hold: "none", afterResolve: { delayMs: 50, frames: 2 } },
        { chunks: ["Next."], hold: "none" }] });
    const first = stream(agent.provider, "original");
    await first.done;
    const firstUnits = usageUnitIds(first.events);
    await Bun.sleep(200);
    const second = stream(agent.provider, "next");
    await second.done;
    const secondUnits = usageUnitIds(second.events);
    // Two late frames first, then the second prompt's own request; none billed twice.
    expect(secondUnits).toHaveLength(3);
    for (const id of secondUnits) expect(firstUnits).not.toContain(id);
    const billed = (agent.provider.getLastResponse()?.metadata?.usageUnits as Array<{ unitId: string }>).map((unit) => unit.unitId);
    for (const id of secondUnits) expect(billed).toContain(id);
  });
});

describe("AcpProvider.steer gating (review fixes)", () => {
  const entryOf = (provider: AcpProvider) =>
    (provider as unknown as { _pool: Map<string, { promptInFlight: object | null }> })._pool.get("chat");

  for (const agentType of ["claude", "codex"] as const) {
    it(`${agentType}: onPromptStarted waits for the turn, and an early steer joins it once it runs`, async () => {
      const agent = fakeAgent(agentType, { advertise: agentType, turnStartDelayMs: 300,
        prompts: [{ chunks: ["Working. "], hold: "steer", answer: "Steered." }] });
      const startedAt = Date.now();
      const run = stream(agent.provider, "original");
      await until(() => !!entryOf(agent.provider)?.promptInFlight, "prompt on the wire");
      // Steered in the gap between session/prompt and the bridge registering the turn.
      expect(run.started).toBe(false);
      expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "injected" });
      await run.done;
      const registered = agent.frames().find((frame) => frame.kind === "turn_registered")!;
      expect(registered.at - startedAt).toBeGreaterThanOrEqual(250);
      expect(agent.requests("_session/steering")[0]!.at).toBeGreaterThanOrEqual(registered.at);
      expect(texts(run.events)).toEqual(["Working. ", "Steered."]);
      expect(agent.requests("session/prompt")).toHaveLength(1);
      expect(agent.frames().some((frame) => frame.kind === "overlap")).toBe(false);
    });
  }

  it("retries a bridge promptRequired on the next turn-level update while the prompt runs", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ hold: "steer", tickMs: 60 }], steers: ["notYet", "notYet", "auto"] });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "injected" });
    await run.done;
    expect(agent.requests("_session/steering")).toHaveLength(3);
    expect(agent.requests("session/cancel")).toHaveLength(0);
  });

  it("gives up on a bridge that keeps answering promptRequired: interrupt and re-prompt", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ hold: "cancel", tickMs: 40 }], steers: ["notYet"] },
      { steerRetryWindowMs: 5_000 });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });
    // Bounded by attempts here (5); the time window bounds a bridge that goes quiet.
    expect(agent.requests("_session/steering")).toHaveLength(5);
    const settled = run.done.catch(() => {});
    await agent.provider.close();
    await settled;
  });

  it("gives up after the retry window when no turn-level update comes", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ hold: "cancel" }], steers: ["notYet"] },
      { steerRetryWindowMs: 250 });
    const run = stream(agent.provider, "original");
    await until(() => run.started, "prompt started");
    const started = Date.now();
    expect(await agent.provider.steer("go on", { chatId: "chat" })).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(agent.requests("_session/steering")).toHaveLength(1);
    const settled = run.done.catch(() => {});
    await agent.provider.close();
    await settled;
  });

  it("claude: caps the wait for a running tool call, then asks for interrupt and re-prompt", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ tool: { ms: null }, hold: "cancel" }] }, { toolCallWaitMs: 250 });
    const run = stream(agent.provider, "long tool");
    await until(() => run.events.some((event) => event.sessionUpdate === "tool_call"), "tool call");
    const started = Date.now();
    expect(await agent.provider.steer("later", { chatId: "chat" })).toEqual({ outcome: "promptRequired", reason: "toolCallRunning" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(agent.requests("_session/steering")).toHaveLength(0);
    const settled = run.done.catch(() => {});
    await agent.provider.close();
    await settled;
  });

  for (const agentType of ["claude", "codex"] as const) {
    it(`${agentType}: never steers while a permission waits for a person, held or fresh`, async () => {
      const agent = fakeAgent(agentType, { advertise: agentType, prompts: [{ tool: { ms: null }, permission: true, hold: "cancel" }] });
      const answer = Promise.withResolvers<{ outcome: "cancelled" }>();
      let asked = 0;
      agent.provider.setPermissionHandler(() => { asked++; return answer.promise; }, "chat");
      const run = stream(agent.provider, "write it");
      await until(() => asked === 1, "permission card");
      expect(await agent.provider.steer("do it differently", { chatId: "chat" }))
        .toEqual({ outcome: "promptRequired", reason: "userInputPending" });
      expect(agent.requests("_session/steering")).toHaveLength(0);
      answer.resolve({ outcome: "cancelled" });
      const settled = run.done.catch(() => {});
      await agent.provider.close();
      await settled;
    });
  }

  it("claude: a steer held for a tool call gives way when a permission opens", async () => {
    const agent = fakeAgent("claude", { advertise: "claude", prompts: [{ tool: { ms: null }, hold: "cancel" }] });
    const answer = Promise.withResolvers<{ outcome: "cancelled" }>();
    agent.provider.setPermissionHandler(() => answer.promise, "chat");
    const run = stream(agent.provider, "long tool");
    await until(() => run.events.some((event) => event.sessionUpdate === "tool_call"), "tool call");
    const held = agent.provider.steer("later", { chatId: "chat" });
    await Bun.sleep(100);
    // The card opens while the steer is held.
    const client = (agent.provider as unknown as { _pool: Map<string, { client: AcpClient }> })._pool.get("chat")!.client;
    void (client as unknown as { _options: { onPermissionRequest: (params: unknown) => Promise<unknown> } })._options
      .onPermissionRequest({ sessionId: "sess-steer", toolCall: { toolCallId: "toolu_perm" }, options: [] });
    expect(await held).toEqual({ outcome: "promptRequired", reason: "userInputPending" });
    expect(agent.requests("_session/steering")).toHaveLength(0);
    answer.resolve({ outcome: "cancelled" });
    const settled = run.done.catch(() => {});
    await agent.provider.close();
    await settled;
  });

  it("codex: a timed-out steer that becomes a bridge turn is cancelled before the re-prompt", async () => {
    const agent = fakeAgent("codex", { advertise: "codex",
      prompts: [{ hold: "cancel", chunks: ["Long run. "] }, { hold: "none", chunks: ["Re-prompted."] }], steers: ["afterPrompt"] },
      { steerTimeoutMs: 200 });
    const abort = new AbortController();
    let started = false;
    const first = (async () => {
      for await (const _ of agent.provider.sendStream("original", { chatId: "chat", signal: abort.signal,
        onPromptStarted: () => { started = true; } })) { /* drain */ }
    })().catch(() => {});
    await until(() => started, "prompt started");
    const result = await agent.provider.steer("go on", { chatId: "chat" });
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("did not answer within 200ms");
    // The pump's fallback: interrupt the round, then re-prompt.
    abort.abort();
    await first;
    const next = stream(agent.provider, "re-prompt");
    await next.done;
    expect(texts(next.events)).toEqual(["Re-prompted."]);
    // Our abort's cancel, then the D3 cancel of the bridge's own turn before the re-prompt.
    const cancels = agent.requests("session/cancel");
    const prompts = agent.requests("session/prompt");
    expect(cancels).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.at).toBeGreaterThan(cancels[1]!.at);
    expect(agent.frames().some((frame) => frame.kind === "overlap")).toBe(false);
  });
});
