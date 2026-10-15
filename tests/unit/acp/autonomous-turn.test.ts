/**
 * Autonomous rounds in the ACP provider (PR 5 §2.3): the frames of a model
 * cycle claude-agent-acp starts after `session/prompt` resolved (a background
 * subagent's task-notification follow-up) are captured and replayed by
 * `listenAutonomous`, which ends at the cycle's `_claude/origin` result marker.
 * Shapes from the live capture claude-090-native-subagent-bg-fast.json and the
 * 0.89 probe recording of the race (the child ends before the human turn's
 * result, so the bridge does not hold the prompt).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProvider, type AcpProviderOptions } from "@acp/provider.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import type { TaskUsageUnit } from "@shared/contracts/usage-accounting.js";
import type { FakeSubagentConfig, FakeSubagentStep } from "../../fixtures/acp/fake-subagent-agent.js";

const AGENT = join(import.meta.dir, "../../fixtures/acp/fake-subagent-agent.ts");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeAgent(agentType: "claude" | "codex", config: FakeSubagentConfig, options: Partial<AcpProviderOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acp-autonomous-"));
  const logPath = join(dir, "frames.jsonl");
  const provider = new AcpProvider({
    agentType, executable: process.execPath, args: [AGENT], cwd: dir, getMcpServers: () => [],
    env: { FAKE_SUBAGENT_CONFIG: JSON.stringify(config), FAKE_SUBAGENT_LOG: logPath },
    nativeSubagentSessions: true, captureAutonomousRounds: true,
    ...options,
  });
  cleanups.push(async () => { await provider.close(); rmSync(dir, { recursive: true, force: true }); });
  const frames = () => existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; at: number }) : [];
  return { provider, frames };
}

async function collect(stream: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const chunk = (text: string): FakeSubagentStep => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
/** Root text only: a child's frames are stamped `_meta.remiSessionId`. */
const texts = (events: ProviderEvent[]) => events.flatMap((event) => event.sessionUpdate === "agent_message_chunk"
  && !(event as { _meta?: { remiSessionId?: string } })._meta?.remiSessionId
  ? [(event.content as unknown as { text: string }).text] : []);
const requestUnits = (events: ProviderEvent[]) => events.flatMap((event) => event.sessionUpdate === "usage_update"
  ? (((event as { _meta?: Record<string, unknown> })._meta?.remiUsageUnits ?? []) as TaskUsageUnit[])
    .filter((unit) => unit.source === "provider_request").map((unit) => unit.unitId) : []);
const CHILD = "a0000000000000001";

/** Wait until the provider buffered the follow-up's result marker (frames arrived while nothing listened). */
async function bufferedMarker(provider: AcpProvider, chatId = "chat"): Promise<void> {
  const buffered = () => (provider as unknown as { _pool: Map<string, { idleFrames: Array<{ update: Record<string, any> }> }> })
    ._pool.get(chatId)?.idleFrames.some((frame) => frame.update._meta?.["_claude/origin"]?.kind === "task-notification");
  const deadline = Date.now() + 10_000;
  while (!buffered()) {
    if (Date.now() > deadline) throw new Error("the follow-up never arrived");
    await Bun.sleep(20);
  }
}

/** The race (0.89 probe): the child ends before the human turn's result, then the follow-up runs after it resolved. */
const RACE: FakeSubagentStep[] = [
  { update: { sessionUpdate: "subagent_spawned", subagentSessionId: CHILD, name: "Count files", task: "List the files",
    prompt: "List the files", capabilities: {} } },
  { session: CHILD, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "There are 3 files." },
    _meta: { claudeCode: { parentToolUseId: "toolu_01" } } } },
  { update: { sessionUpdate: "subagent_state_update", subagentSessionId: CHILD, state: "completed" } },
  chunk("I started a background agent; I'll reply once it reports back."),
  { billing: { cost: 0.1245, used: 27_441, size: 1_000_000, origin: "human" } },
  { resolve: "end_turn" },
  { delayMs: 150, ...chunk("3") },
  { billing: {} },
  { billing: { cost: 0.1329, used: 27_993, size: 1_000_000, origin: "task-notification" } },
];

describe("AcpProvider.listenAutonomous", () => {
  it("replays a follow-up that started before anyone listened and ends at its result marker", async () => {
    const agent = fakeAgent("claude", { prompts: [RACE] });
    const prompt = await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    expect(texts(prompt)).toEqual(["I started a background agent; I'll reply once it reports back."]);
    await bufferedMarker(agent.provider);
    const round = await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 2_000 }));
    expect(texts(round)).toEqual(["3"]);
    const marker = round.at(-1)!;
    expect(marker.sessionUpdate).toBe("usage_update");
    expect((marker as { _meta?: Record<string, unknown> })._meta?.["_claude/origin"]).toEqual({ kind: "task-notification" });
    // The response covers the prompt and the round: text, requests and the replaced cost estimate.
    const response = agent.provider.getLastResponse()!;
    expect(response.text).toBe("I started a background agent; I'll reply once it reports back.3");
    expect(response.metadata?.stopReason).toBe("end_turn");
    const units = response.metadata!.usageUnits as TaskUsageUnit[];
    for (const id of [...requestUnits(prompt), ...requestUnits(round)]) expect(units.map((unit) => unit.unitId)).toContain(id);
    expect(requestUnits(round)).toHaveLength(2);
    // R6: one turn-scope SDK estimate, its cumulative amount replaced once.
    const costs = units.filter((unit) => unit.unitId.startsWith("cost:"));
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ costAmount: 0.1329, costSource: "sdk_estimate", scope: "turn", revision: 2 });
    expect(response.contextWindow).toBe(1_000_000);
  });

  it("streams a follow-up that starts while it listens", async () => {
    const agent = fakeAgent("claude", { prompts: [RACE.map((step) => "delayMs" in step && step.delayMs ? { ...step, delayMs: 500 } : step)] });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    const started = Date.now();
    const round = await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 3_000 }));
    expect(texts(round)).toEqual(["3"]);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("ends after idleMs when no round comes, with the prompt's response rebuilt", async () => {
    const agent = fakeAgent("claude", { prompts: [[chunk("All done."), { billing: { origin: "human", used: 100, size: 1_000 } }]] });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    const before = agent.provider.getLastResponse()!;
    const started = Date.now();
    const round = await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 200 }));
    expect(round).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    const after = agent.provider.getLastResponse()!;
    expect(after.text).toBe("All done.");
    expect((after.metadata!.usageUnits as TaskUsageUnit[]).map((unit) => unit.unitId).sort())
      .toEqual((before.metadata!.usageUnits as TaskUsageUnit[]).map((unit) => unit.unitId).sort());
  });

  it("a title update alone does not start the round (it would wait for a marker that never comes)", async () => {
    const agent = fakeAgent("claude", { prompts: [[chunk("Done."), { resolve: "end_turn" },
      { delayMs: 50, update: { sessionUpdate: "session_info_update", title: "Background subagent file count" } }]] });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    const started = Date.now();
    const round = await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 300 }));
    expect(round.map((event) => event.sessionUpdate)).toEqual(["session_info_update"]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("stops on abort", async () => {
    const agent = fakeAgent("claude", { prompts: [[chunk("Done.")]] });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const started = Date.now();
    await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 10_000, signal: abort.signal }));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops when the agent process dies", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = fakeAgent("claude", { prompts: [[chunk("Done."), { resolve: "end_turn" }, { delayMs: 150, exit: 1 }]] });
      await collect(agent.provider.sendStream("count", { chatId: "chat" }));
      const started = Date.now();
      await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 10_000 }));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(agent.provider.getLastResponse()?.text).toBe("Done.");
    } finally {
      error.mockRestore();
    }
  });

  it("gives up at the cap when frames flow but no result comes", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agent = fakeAgent("claude", { prompts: [[chunk("Done."), { resolve: "end_turn" }, { delayMs: 50, ...chunk("thinking…") }]] },
        { autonomousRoundCapMs: 300 });
      await collect(agent.provider.sendStream("count", { chatId: "chat" }));
      const started = Date.now();
      const round = await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 5_000 }));
      expect(texts(round)).toEqual(["thinking…"]);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(warn.mock.calls.some(([line]) => String(line).includes("without its result"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts a child announced during the round and stamps its frames", async () => {
    const agent = fakeAgent("claude", { prompts: [[chunk("Done."), { resolve: "end_turn" },
      { delayMs: 50, update: { sessionUpdate: "subagent_spawned", subagentSessionId: CHILD, name: "Late", task: "x", capabilities: {} } },
      { session: CHILD, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child" } } },
      { update: { sessionUpdate: "subagent_state_update", subagentSessionId: CHILD, state: "completed" } },
      chunk("3"),
      { billing: { origin: "task-notification" } },
    ]] });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    const round = await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 2_000 }));
    expect(round.map((event) => `${(event as { _meta?: { remiSessionId?: string } })._meta?.remiSessionId ?? "root"}:${event.sessionUpdate}`))
      .toEqual(["root:subagent_spawned", `${CHILD}:agent_message_chunk`, "root:subagent_state_update", "root:agent_message_chunk",
        "root:usage_update"]);
    // A child's prose is not the reply.
    expect(agent.provider.getLastResponse()!.text).toBe("Done.3");
  });

  it("a steer that stopped the wait re-prompts, and the captured follow-up replays into that prompt first", async () => {
    const agent = fakeAgent("claude", { prompts: [RACE, [chunk("Steered reply.")]] });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    await bufferedMarker(agent.provider);
    const next = await collect(agent.provider.sendStream("[Mid-run user steering] in Chinese", { chatId: "chat" }));
    expect(texts(next)).toEqual(["3", "Steered reply."]);
  });

  it("caps the buffer at 2,000 frames, dropping the oldest non-usage ones first", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const flood: FakeSubagentStep[] = Array.from({ length: 2_100 }, (_, index) => chunk(`c${index} `));
      // After a pause, so the flood arrives once the prompt stream ended (frames read with the result belong to it).
      const agent = fakeAgent("claude", { prompts: [[chunk("Done."), { resolve: "end_turn" }, { delayMs: 300, billing: {} }, ...flood,
        { billing: { origin: "task-notification" } }]] });
      await collect(agent.provider.sendStream("count", { chatId: "chat" }));
      await bufferedMarker(agent.provider);
      const round = await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 2_000 }));
      expect(round).toHaveLength(2_000);
      // Both usage frames survived; the 102 oldest chunks went.
      expect(round.filter((event) => event.sessionUpdate === "usage_update")).toHaveLength(2);
      expect(texts(round)[0]).toBe("c102 ");
      expect(warn.mock.calls.some(([line]) => String(line).includes("buffer full"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  it("Codex never captures: only the usage of a bridge-started turn replays", async () => {
    const agent = fakeAgent("codex", { advertise: "codex", prompts: [[chunk("Done."), { resolve: "end_turn" },
      { delayMs: 50, ...chunk("bridge-started text") }, { billing: {} }], [chunk("Next.")]] });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    const pool = (agent.provider as unknown as { _pool: Map<string, { idleFrames: unknown[] }> })._pool;
    const deadline = Date.now() + 10_000;
    while (!pool.get("chat")?.idleFrames.length && Date.now() < deadline) await Bun.sleep(20);
    expect(await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 100 }))).toEqual([]);
    const next = await collect(agent.provider.sendStream("next", { chatId: "chat" }));
    expect(texts(next)).toEqual(["Next."]);
    expect(requestUnits(next)).toHaveLength(1);
  });

  it("without the capture option Claude keeps PR 3's usage-only buffer", async () => {
    const agent = fakeAgent("claude", { prompts: [RACE, [chunk("Next.")]] }, { captureAutonomousRounds: false });
    await collect(agent.provider.sendStream("count", { chatId: "chat" }));
    await bufferedMarker(agent.provider);
    expect(await collect(agent.provider.listenAutonomous({ chatId: "chat", idleMs: 100 }))).toEqual([]);
    const next = await collect(agent.provider.sendStream("next", { chatId: "chat" }));
    expect(texts(next)).toEqual(["Next."]);
    // The follow-up's two requests are still billed.
    expect(requestUnits(next)).toHaveLength(2);
  });
});
