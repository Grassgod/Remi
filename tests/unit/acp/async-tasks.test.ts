/**
 * Background tasks in the ACP provider (PR 6 §3): the per-session registry fed
 * by AIR `async_task_*` frames (root and native child sessions, during a
 * prompt and while idle), `stopAsyncTask` on the root session, the
 * end-of-attempt `settleAsyncTasks`, and what a parked lane needs: `reuseCheck`
 * (the `_ensureSession` staleness rule), `adoptSession`, `park` and the cost
 * baseline. The agent is the scripted fake of tests/fixtures/acp.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProvider, type AcpProviderOptions } from "@acp/provider.js";
import type { AsyncTaskSnapshot, ProviderEvent } from "@shared/contracts/provider-types.js";
import type { TaskUsageUnit } from "@shared/contracts/usage-accounting.js";
import type { FakeAsyncTaskStep, FakeSubagentConfig, FakeSubagentStep } from "../../fixtures/acp/fake-subagent-agent.js";

const AGENT = join(import.meta.dir, "../../fixtures/acp/fake-subagent-agent.ts");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  setSystemTime();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface LogEntry { kind: string; method?: string; params?: Record<string, any>; id?: string; stopped?: boolean; pid: number; at: number }

function fakeAgent(agentType: "claude" | "codex", config: FakeSubagentConfig, options: Partial<AcpProviderOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acp-async-tasks-"));
  const logPath = join(dir, "frames.jsonl");
  const changes: Array<[string, AsyncTaskSnapshot]> = [];
  const lost: Array<[string, string, AsyncTaskSnapshot[]]> = [];
  const provider = new AcpProvider({
    agentType, executable: process.execPath, args: [AGENT], cwd: dir, getMcpServers: () => [],
    env: { FAKE_SUBAGENT_CONFIG: JSON.stringify({ advertise: agentType, ...config }), FAKE_SUBAGENT_LOG: logPath },
    nativeSubagentSessions: true, captureAutonomousRounds: agentType === "claude", asyncTasks: true,
    onAsyncTaskChange: (chatId, task) => changes.push([chatId, task]),
    onSessionLost: (chatId, reason, tasks) => lost.push([chatId, reason, tasks]),
    ...options,
  });
  cleanups.push(async () => { await provider.close(); rmSync(dir, { recursive: true, force: true }); });
  const log = (): LogEntry[] => existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry) : [];
  return { provider, log, changes, lost, dir };
}

async function collect(stream: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const task = (step: FakeAsyncTaskStep): FakeSubagentStep => ({ asyncTask: step });
const chunk = (text: string): FakeSubagentStep => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const CHILD = "a0000000000000001";
const kinds = (events: ProviderEvent[]) => events.map((event) => event.sessionUpdate);
const pool = (provider: AcpProvider) => (provider as unknown as { _pool: Map<string, any> })._pool;

describe("AcpProvider background-task registry", () => {
  it("folds root and child frames, during the prompt and after it resolved, and reports each change", async () => {
    const agent = fakeAgent("claude", { prompts: [[
      task({ id: "bash-1", event: "spawned", name: "npm test", toolCallId: "toolu_bash", outputFilePath: "/tmp/x/tasks/bash-1.output" }),
      { update: { sessionUpdate: "subagent_spawned", subagentSessionId: CHILD, name: "Child", task: "t", prompt: "t", capabilities: {} } },
      task({ id: "wf-1", session: CHILD, event: "spawned", name: "review", taskType: "workflow" }),
      task({ id: "wf-1", event: "progress", summary: "step 2", usage: { totalTokens: 100, toolUses: 2, durationMs: 900 } }),
      chunk("Started."),
      { resolve: "end_turn" },
      { delayMs: 50, ...task({ id: "bash-1", event: "completed", summary: "exit 0" }) },
    ]] });
    const events = await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    expect(kinds(events)).toContain("async_task_spawned");
    await waitFor(() => agent.provider.listAsyncTasks({ chatId: "chat" }).find((t) => t.id === "bash-1")?.state === "completed",
      "the end that arrived while nothing listened");
    const tasks = agent.provider.listAsyncTasks({ chatId: "chat" });
    expect(tasks.map((t) => t.id)).toEqual(["bash-1", "wf-1"]);
    expect(tasks[0]).toMatchObject({ sessionId: "sess_root", name: "npm test", taskType: "shell", toolCallId: "toolu_bash",
      outputFilePath: "/tmp/x/tasks/bash-1.output", state: "completed", summary: "exit 0", stop: null });
    expect(tasks[0]!.endedAt).toBeGreaterThanOrEqual(tasks[0]!.startedAt);
    expect(tasks[1]).toMatchObject({ sessionId: CHILD, taskType: "workflow", state: "running", summary: "step 2",
      usage: { totalTokens: 100, toolUses: 2, durationMs: 900 }, endedAt: null });
    expect(agent.changes.every(([chatId]) => chatId === "chat")).toBe(true);
    expect(agent.changes.map(([, t]) => `${t.id}:${t.state}`)).toEqual(["bash-1:running", "wf-1:running", "wf-1:running", "bash-1:completed"]);
  });

  it("corrects a level-closed stop once to the real end, and ignores a repeated end", async () => {
    const agent = fakeAgent("codex", { prompts: [[
      task({ id: "t1", event: "spawned" }),
      { update: { sessionUpdate: "async_task_state_update", asyncTaskId: "t1", state: "stopped" } },
      { update: { sessionUpdate: "async_task_state_update", asyncTaskId: "t1", state: "failed" } },
      { update: { sessionUpdate: "async_task_state_update", asyncTaskId: "t1", state: "completed" } },
      { update: { sessionUpdate: "async_task_state_update", asyncTaskId: "t1", state: "running" } },
    ]] });
    await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    expect(agent.provider.listAsyncTasks({ chatId: "chat" })[0]!.state).toBe("failed");
  });

  it("without capture (Codex), keeps task frames that arrive after the prompt for the next stream", async () => {
    const agent = fakeAgent("codex", { prompts: [[
      chunk("Started the server."),
      { resolve: "end_turn" },
      // codex-acp announces a terminal left running on `turn/completed`, after the prompt resolved (§1.2).
      { delayMs: 50, update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed",
        _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } } },
      task({ id: "thread:call_1", event: "spawned", name: "python3 -m http.server", toolCallId: "call_1" }),
      { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dropped: not captured" } } },
    ], [chunk("next")]] });
    await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    await waitFor(() => agent.provider.listAsyncTasks({ chatId: "chat" }).length === 1, "the late announcement");
    await Bun.sleep(100);
    const settled = await collect(agent.provider.settleAsyncTasks({ chatId: "chat", stopRunning: false, timeoutMs: 0 }));
    expect(kinds(settled)).toEqual(["tool_call_update", "async_task_spawned"]);
  });

  it("stops a child's task on the root session, and answers an unknown or ended task without a wire call", async () => {
    const agent = fakeAgent("claude", { prompts: [[
      { update: { sessionUpdate: "subagent_spawned", subagentSessionId: CHILD, name: "Child", task: "t", prompt: "t", capabilities: {} } },
      task({ id: "bash-c", session: CHILD, event: "spawned" }),
      task({ id: "bash-done", event: "spawned" }),
      task({ id: "bash-done", event: "completed" }),
      { resolve: "end_turn" },
    ]] });
    await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    expect(await agent.provider.stopAsyncTask("bash-c", { chatId: "chat", by: "user" })).toEqual({ stopped: true });
    expect(await agent.provider.stopAsyncTask("bash-done", { chatId: "chat" })).toEqual({ stopped: false });
    expect(await agent.provider.stopAsyncTask("nope", { chatId: "chat" })).toEqual({ stopped: false });
    const stops = agent.log().filter((entry) => entry.method === "_session/async_task/stop");
    expect(stops.map((entry) => entry.params)).toEqual([{ sessionId: "sess_root", asyncTaskId: "bash-c" }]);
    await waitFor(() => agent.provider.listAsyncTasks({ chatId: "chat" })[0]!.state === "stopped", "the bridge's stopped state");
    expect(agent.provider.listAsyncTasks({ chatId: "chat" })[0]!.stop).toMatchObject({ by: "user", outcome: "stopped" });
  });
});

describe("AcpProvider.settleAsyncTasks", () => {
  it("replays, stops every running task in parallel, and yields until none runs", async () => {
    const agent = fakeAgent("claude", { prompts: [[
      task({ id: "a", event: "spawned" }), task({ id: "b", event: "spawned" }), chunk("Two running."), { resolve: "end_turn" },
    ]] });
    await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    const started = Date.now();
    const events = await collect(agent.provider.settleAsyncTasks({ chatId: "chat", stopRunning: true, timeoutMs: 3_000 }));
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(events.filter((event) => event.sessionUpdate === "async_task_state_update")).toHaveLength(2);
    expect(events.filter((event) => event.sessionUpdate === "notice")).toHaveLength(2);
    expect(agent.provider.listAsyncTasks({ chatId: "chat" }).map((t) => [t.state, t.stop?.by, t.stop?.outcome]))
      .toEqual([["stopped", "remi", "stopped"], ["stopped", "remi", "stopped"]]);
  });

  it("waits drainMs for a late announcement, then ends at the timeout while it runs", async () => {
    const agent = fakeAgent("codex", { prompts: [[chunk("ok"), { resolve: "end_turn" }, { delayMs: 300, ...task({ id: "late", event: "spawned" }) }]] });
    await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    const started = Date.now();
    const events = await collect(agent.provider.settleAsyncTasks({ chatId: "chat", stopRunning: false, drainMs: 2_000, timeoutMs: 2_000 }));
    expect(kinds(events)).toEqual(["async_task_spawned"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(agent.provider.listAsyncTasks({ chatId: "chat" })[0]!.state).toBe("running");
  });

  it("yields nothing without a pooled session", async () => {
    const agent = fakeAgent("claude", { prompts: [[chunk("ok")]] });
    expect(await collect(agent.provider.settleAsyncTasks({ chatId: "none", stopRunning: true, timeoutMs: 100 }))).toEqual([]);
  });
});

describe("AcpProvider parked sessions", () => {
  it("reuseCheck applies the session staleness rule without touching the session", async () => {
    const agent = fakeAgent("claude", { prompts: [[chunk("ok")]] });
    const options = { chatId: "chat", cwd: agent.dir, model: "claude-sonnet-5" };
    await collect(agent.provider.sendStream("go", options));
    expect(agent.provider.reuseCheck("missing", options)).toEqual({ reuse: false, reason: "no_session" });
    expect(agent.provider.reuseCheck("chat", options)).toEqual({ reuse: true });
    // Effort is applied to the live session; it never makes it stale.
    expect(agent.provider.reuseCheck("chat", { ...options, effort: "high" })).toEqual({ reuse: true });
    const other = join(agent.dir, "other");
    mkdirSync(other);
    expect(agent.provider.reuseCheck("chat", { ...options, cwd: other })).toEqual({ reuse: false, reason: "cwd" });
    expect(agent.provider.reuseCheck("chat", { ...options, model: "claude-opus-5" })).toEqual({ reuse: false, reason: "startup_model" });
    expect(agent.provider.reuseCheck("chat", { ...options, pluginPaths: ["/plugins/a"] } as never))
      .toEqual({ reuse: false, reason: "plugins" });
    expect(agent.provider.reuseCheck("chat", { ...options, pluginPaths: ["relative"] } as never))
      .toEqual({ reuse: false, reason: "plugins" });
    expect(agent.log().filter((entry) => entry.method === "initialize")).toHaveLength(1);
    // The same rule `_ensureSession` applies: a changed cwd starts a second process.
    await collect(agent.provider.sendStream("go", { ...options, cwd: other }));
    expect(agent.log().filter((entry) => entry.method === "initialize")).toHaveLength(2);
    await agent.provider.close();
    expect(agent.provider.reuseCheck("chat", options)).toEqual({ reuse: false, reason: "no_session" });
  });

  it("adoptSession re-keys the session, its children, tasks and handlers, so the next attempt reuses the process", async () => {
    const agent = fakeAgent("claude", { prompts: [[
      { update: { sessionUpdate: "subagent_spawned", subagentSessionId: CHILD, name: "Child", task: "t", prompt: "t", capabilities: {} } },
      task({ id: "bash-1", session: CHILD, event: "spawned" }),
      chunk("parked"), { resolve: "end_turn" },
      { delayMs: 200, permission: { session: CHILD, toolCallId: "toolu_w" } },
    ], [chunk("adopted")]] });
    const asked: string[] = [];
    agent.provider.setPermissionHandler(async () => { asked.push("attempt-1"); return { outcome: "cancelled" }; }, "attempt-1");
    await collect(agent.provider.sendStream("go", { chatId: "attempt-1", sessionId: null }));
    expect(agent.provider.adoptSession("missing", "attempt-2")).toBe(false);
    expect(agent.provider.adoptSession("attempt-1", "attempt-2")).toBe(true);
    expect(pool(agent.provider).has("attempt-1")).toBe(false);
    expect(agent.provider.listAsyncTasks({ chatId: "attempt-2" }).map((t) => t.id)).toEqual(["bash-1"]);
    expect(agent.provider.subagentSession(CHILD)).toEqual({ agentId: CHILD, name: "Child" });
    // The child's later request finds the handler under the new key.
    await waitFor(() => asked.length === 1, "the child's permission request");
    // A task change after the move is reported under the new key.
    await agent.provider.stopAsyncTask("bash-1", { chatId: "attempt-2" });
    expect(agent.changes.at(-1)![0]).toBe("attempt-2");
    const events = await collect(agent.provider.sendStream("again", { chatId: "attempt-2", sessionId: "sess_root" }));
    expect(events.some((event) => event.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(agent.log().filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(agent.log().filter((entry) => entry.method === "session/load" || entry.method === "session/resume")).toHaveLength(0);
    expect(new Set(agent.log().map((entry) => entry.pid)).size).toBe(1);
  });

  it("park suspends the ten-minute idle cleanup and captures every frame; unparked sessions are still cleaned", async () => {
    const agent = fakeAgent("codex", { prompts: [[chunk("ok"), { resolve: "end_turn" },
      { delayMs: 300, ...chunk("captured while parked") }]] });
    await collect(agent.provider.sendStream("go", { chatId: "parked" }));
    agent.provider.park("parked", true);
    await collect(agent.provider.sendStream("go", { chatId: "idle" }));
    expect(agent.provider.processGroupId("parked")).toBeGreaterThan(0);
    await Bun.sleep(400);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    await (agent.provider as unknown as { _cleanupIdle(): Promise<void> })._cleanupIdle();
    expect(pool(agent.provider).has("parked")).toBe(true);
    expect(pool(agent.provider).has("idle")).toBe(false);
    setSystemTime();
    const frames = pool(agent.provider).get("parked").idleFrames as Array<{ update: Record<string, any> }>;
    expect(frames.map((frame) => frame.update.content?.text)).toContain("captured while parked");
    agent.provider.park("parked", false);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    await (agent.provider as unknown as { _cleanupIdle(): Promise<void> })._cleanupIdle();
    expect(pool(agent.provider).has("parked")).toBe(false);
  });

  it("an adopted Claude session counts its turn-cost estimate from the parked prompt's last cumulative cost", async () => {
    const agent = fakeAgent("claude", { prompts: [
      [chunk("first"), { billing: { cost: 0.5, origin: "human" } }],
      [chunk("second"), { billing: { cost: 0.8, origin: "human" } }],
    ] });
    await collect(agent.provider.sendStream("go", { chatId: "attempt-1" }));
    const first = agent.provider.getLastResponse()!;
    expect(first.costUsd).toBe(0.5);
    expect(agent.provider.adoptSession("attempt-1", "attempt-2")).toBe(true);
    await collect(agent.provider.sendStream("again", { chatId: "attempt-2", sessionId: "sess_root" }));
    const second = agent.provider.getLastResponse()!;
    expect(second.costUsd).toBeCloseTo(0.3, 10);
    const costs = (second.metadata!.usageUnits as TaskUsageUnit[]).filter((unit) => unit.unitId.startsWith("cost:"));
    expect(costs).toHaveLength(1);
    expect(costs[0]!.costAmount).toBeCloseTo(0.3, 10);
    expect(costs[0]!.unitId).not.toBe((first.metadata!.usageUnits as TaskUsageUnit[]).find((unit) => unit.unitId.startsWith("cost:"))!.unitId);
  });

  it("reports the tasks of a session whose process died", async () => {
    const agent = fakeAgent("claude", { prompts: [[task({ id: "bash-1", event: "spawned" }), chunk("ok"), { resolve: "end_turn" },
      { delayMs: 100, exit: 1 }]] });
    await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    await waitFor(() => agent.lost.length === 1, "the death report");
    expect(agent.lost[0]![0]).toBe("chat");
    expect(agent.lost[0]![2].map((t) => [t.id, t.state])).toEqual([["bash-1", "running"]]);
    expect(agent.provider.listAsyncTasks({ chatId: "chat" })).toEqual([]);
  });

  it("asks for nothing when the switch is off", async () => {
    const agent = fakeAgent("claude", { prompts: [[task({ id: "bash-1", event: "spawned" }), chunk("ok")]] }, { asyncTasks: false });
    await collect(agent.provider.sendStream("go", { chatId: "chat" }));
    const caps = agent.log().find((entry) => entry.method === "initialize")!.params!.clientCapabilities;
    expect(caps._meta.jetbrains.air.capabilities).not.toContain("asyncTasks");
    expect(agent.provider.listAsyncTasks({ chatId: "chat" })).toEqual([]);
    expect(await agent.provider.stopAsyncTask("bash-1", { chatId: "chat" })).toEqual({ stopped: false });
  });
});
