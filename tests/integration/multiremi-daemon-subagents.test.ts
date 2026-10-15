// Native subagent sessions end to end (PR 5 §8): a real daemon and server, the
// real AcpProvider, and a scripted ACP agent (tests/fixtures/acp/
// fake-subagent-agent.ts) speaking the pinned bridges' wire shapes.
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { openIntegrationDatabase, type IntegrationDatabase } from "../helpers/integration-database.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMultiremiServer } from "../fixtures/daemon-protocol.js";
import type { MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import { AcpProvider, type AcpProviderOptions } from "@acp/provider.js";
import { createResponsibleTestIssue } from "../unit/multiremi/helpers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { foldTraceLines, traceItems } from "../helpers/turn-trace.js";
import type { FakeSubagentConfig, FakeSubagentStep } from "../fixtures/acp/fake-subagent-agent.js";

let database: IntegrationDatabase | null = null;
let fixtureStore: MultiremiStore | null = null;
let workDir: string | null = null;
let activeDaemon: MultiremiDaemon | null = null;
const activeServers = new Set<{ stop(closeActiveConnections?: boolean): unknown }>();
const cleanupsAfter: Array<() => void> = [];

beforeEach(async () => {
  database = await openIntegrationDatabase();
  fixtureStore = new MultiremiStore(database.db);
  workDir = mkdtempSync(join(tmpdir(), "multiremi-daemon-subagents-"));
});

afterEach(async () => {
  await activeDaemon?.stopAndDrainTestWork();
  for (const cleanup of cleanupsAfter.splice(0)) cleanup();
  activeDaemon = null;
  for (const server of activeServers) server.stop(true);
  activeServers.clear();
  await database?.close();
  database = null;
  fixtureStore = null;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

const FAKE_AGENT = join(import.meta.dir, "../fixtures/acp/fake-subagent-agent.ts");
const CHILD = "a0000000000000001";

const chunk = (text: string, extra: Record<string, unknown> = {}): FakeSubagentStep =>
  ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...extra } });
const spawned = (subagentSessionId: string, name = "Count files"): FakeSubagentStep =>
  ({ update: { sessionUpdate: "subagent_spawned", subagentSessionId, name, task: "List the files", prompt: "List the files", capabilities: {} } });
const ended = (subagentSessionId: string, state = "completed"): FakeSubagentStep =>
  ({ update: { sessionUpdate: "subagent_state_update", subagentSessionId, state } });

/** One task (a Chat-less Issue session task in ask mode), a registered runtime and a server, named after the case. */
async function bed(name: string, options: { provider?: "claude" | "codex"; ask?: boolean } = {}) {
  const store = fixtureStore!;
  const provider = options.provider ?? "claude";
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: `${name} agent`, provider });
  const task = options.ask
    ? store.createSessionTask(store.getOrCreateDefaultIssueSession(createResponsibleTestIssue(store, { title: `${name} issue`,
      assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: "mem_local_local" }).id).id, { agentId: agent.id, prompt: "Count the files" })
    : store.createTask({ agentId: agent.id, prompt: "Count the files" });
  // The decision RPCs need a daemon-bound token (as multiremi-approval-e2e.test.ts).
  const token = (await store.createAccessToken({ name: `${name} daemon`, type: "daemon", workspaceId: "local",
    daemonId: `daemon-${name}` })).token;
  // As multiremi-approval-e2e.test.ts: the daemon registers its own runtime, and the server takes no root token.
  const server = startMultiremiServer({ store, scheduler: null, hostname: "127.0.0.1", port: 0 });
  activeServers.add(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const daemon = (providerFactory: MultiremiDaemonProviderFactory, extra: Partial<ConstructorParameters<typeof MultiremiDaemon>[0]> = {}) =>
    activeDaemon = new MultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: baseUrl,
      token, daemonId: `daemon-${name}`, runtimeName: `${name}-runtime`, provider, workspaceId: "local",
      once: true, daemonPort: 0, protocolClientOptions: { cliVersion: DAEMON_MIN_CLI_VERSION },
      workspacesRoot: join(workDir!, "workspaces"), repoCacheRoot: join(workDir!, ".repo-cache"),
      steerPollIntervalMs: 250, approvalMode: options.ask ? "ask" : "auto", humanRequestTimeoutMs: 60_000, taskDrainTimeoutMs: 1_000,
      providerFactory, ...extra,
    });
  return { store, task, server, baseUrl, daemon };
}

/** The real AcpProvider over the scripted agent, with everything the daemon may call on it. */
function scriptedAcp(config: FakeSubagentConfig, logPath: string, agentType: "claude" | "codex",
  extra: { providerOptions?: Partial<AcpProviderOptions> } = {}): MultiremiDaemonProviderFactory {
  return (options) => {
    const acp = new AcpProvider({
      ...options, agentType, executable: process.execPath, args: [FAKE_AGENT], privateTmpDirectory: undefined,
      env: { ...options.env, FAKE_SUBAGENT_CONFIG: JSON.stringify(config), FAKE_SUBAGENT_LOG: logPath },
      ...extra.providerOptions,
    });
    return {
      sendStream: (message, sendOptions) => acp.sendStream(message, sendOptions) as AsyncGenerator<ProviderEvent>,
      listenAutonomous: (listenOptions) => acp.listenAutonomous(listenOptions),
      steer: (text, steerOptions) => acp.steer(text, steerOptions),
      subagentSession: (sessionId) => acp.subagentSession(sessionId),
      getLastResponse: () => acp.getLastResponse(),
      getStreamedText: (chatId) => acp.getStreamedText(chatId),
      get typedSessionFailures() { return acp.typedSessionFailures; },
      setPermissionHandler: (handler) => acp.setPermissionHandler(handler),
      setElicitationHandler: (handler) => acp.setElicitationHandler(handler),
      close: () => acp.close(),
    };
  };
}

function agentLog(logPath: string): Array<{ kind: string; method?: string; params?: Record<string, any>; result?: any; at: number }> {
  return existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function waitFor<T>(probe: () => T | null | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function respond(store: MultiremiStore, baseUrl: string, requestId: string, optionId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/sessions/${store.getMessage(requestId)!.session_id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message_kind: "reply", reply_to_id: requestId, body_md: "Approval response", response: { option_id: optionId },
      expected_route_revision: store.getQuestion(requestId)!.route_revision }),
  });
}

/** A child that asks before it writes (claude-090-native-subagent-permission.json, in ask mode). */
const CHILD_WRITE: FakeSubagentStep[] = [
  spawned(CHILD, "Write count.txt"),
  { session: CHILD, update: { sessionUpdate: "tool_call", toolCallId: "toolu_w", name: "Write", kind: "edit", status: "pending",
    title: "Write count.txt", rawInput: { file_path: "/work/count.txt" }, _meta: { claudeCode: { toolName: "Write", parentToolUseId: "toolu_01" } } } },
  { permission: { session: CHILD, toolCallId: "toolu_w", title: "Write count.txt" } },
  { session: CHILD, update: { sessionUpdate: "tool_call_update", toolCallId: "toolu_w", status: "completed", rawOutput: "File created" } },
  { session: CHILD, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wrote it." },
    _meta: { claudeCode: { parentToolUseId: "toolu_01" } } } },
  ended(CHILD),
  chunk("done"),
];

describe("Bun Multiremi daemon native subagents", () => {
  for (const [decision, optionId, toolStatus, permissionStatus] of [
    ["approval", "allow", "completed", "completed"],
    ["decline", "deny", "declined", "declined"],
  ] as const) {
    it(`(4) a child's permission in ask mode reaches a person; the ${decision} applies to the child's tool`, async () => {
      const { store, task, baseUrl, daemon } = await bed(`child-perm-${decision}`, { ask: true });
      const logPath = join(workDir!, "agent.jsonl");
      const run = daemon(scriptedAcp({ prompts: [CHILD_WRITE] }, logPath, "claude"));
      const done = run.start();
      const pending = await waitFor(() => store.listTaskHumanRequests(task.id).find((request) => request.status === "pending"),
        "the child's permission request");
      expect(pending.kind).toBe("permission");
      // §1.3: the card names the subagent the request came from.
      expect(pending.payload).toMatchObject({ session_id: CHILD, subagent: { item_id: `sa:${CHILD}`, name: "Write count.txt" } });
      expect((await respond(store, baseUrl, pending.id, optionId)).status).toBe(200);
      await done;

      expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "done" });
      expect(agentLog(logPath).find((entry) => entry.kind === "permission_answer")?.result)
        .toEqual({ outcome: { outcome: "selected", optionId } });
      const items = traceItems(run.traceStore().read(task.id).events);
      const permission = items.find((item) => item.type === "permission")!;
      expect(permission).toMatchObject({ parent_id: null, tool_item_id: "toolu_w", status: permissionStatus });
      expect(items.find((item) => item.id === "toolu_w")).toMatchObject({ parent_id: `sa:${CHILD}`, status: toolStatus });
      expect(items.find((item) => item.id === `sa:${CHILD}`)).toMatchObject({ status: "completed", output: "Wrote it." });
    }, 30_000);
  }

  it("(5) a Codex child's context occupancy leaves the turn's context usage unchanged", async () => {
    // The Codex lane needs a native login without a workspace gateway; a fake one in a test-owned home.
    const codexHome = join(workDir!, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "fake" } }), { mode: 0o600 });
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanupsAfter.push(() => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });
    const { store, task, daemon } = await bed("codex-child-usage", { provider: "codex" });
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ advertise: "codex", prompts: [[
      { update: { sessionUpdate: "usage_update", used: 14_000, size: 475_000, _meta: { remiUsageMode: "request" } } },
      spawned("thread-child"),
      { session: "thread-child", update: { sessionUpdate: "usage_update", used: 17_210, size: 300_000, _meta: { remiUsageMode: "request" } } },
      { session: "thread-child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "3" },
        _meta: { jetbrains: { air: { version: 1, phase: "final_answer" } } } } },
      ended("thread-child"),
      { update: { sessionUpdate: "tool_call", toolCallId: "call_wait", kind: "other", title: "wait", status: "in_progress",
        rawInput: { prompt: null, senderThreadId: "sess_root", receiverThreadIds: [] } } },
      { update: { sessionUpdate: "tool_call_update", toolCallId: "call_wait", status: "completed" } },
      chunk("3", { _meta: { jetbrains: { air: { version: 1, phase: "final_answer" } } } }),
    ]] }, logPath, "codex"));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "3" });
    const caps = agentLog(logPath).find((entry) => entry.method === "initialize")!.params!.clientCapabilities;
    expect(caps._meta.jetbrains.air.capabilities).toContain("nativeSubagentSessions");
    const trace = foldTraceLines(run.traceStore().read(task.id).events);
    expect(trace.turn?.context_usage).toEqual({ used: 14_000, size: 475_000 });
    expect(trace.items.find((item) => item.id === "sa:thread-child")).toMatchObject({ status: "completed", output: "3" });
    expect(trace.items.find((item) => item.id === "call_wait")).toMatchObject({ type: "tool", tool: "wait" });
  }, 30_000);

  it("the kill switch asks for no child sessions", async () => {
    const { store, task, daemon } = await bed("kill-switch");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [[chunk("plain answer")]] }, logPath, "claude"), { nativeSubagents: false });
    await run.start();
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "plain answer" });
    const caps = agentLog(logPath).find((entry) => entry.method === "initialize")!.params!.clientCapabilities;
    expect(caps.subagents).toBeUndefined();
  }, 30_000);
  /** A background child that ends before the human turn's result (the 0.89 race): the bridge does not hold the prompt. */
  const RACE = (followUpDelayMs: number): FakeSubagentStep[] => [
    spawned(CHILD),
    chunk("I started a background agent; I'll reply once it reports back."),
    { session: CHILD, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "There are 3 files." },
      _meta: { claudeCode: { parentToolUseId: "toolu_01" } } } },
    ended(CHILD),
    { billing: { cost: 0.1245, used: 27_441, size: 1_000_000, origin: "human" } },
    { resolve: "end_turn" },
    { delayMs: followUpDelayMs, ...chunk("3") },
    { billing: {} },
    { billing: { cost: 0.1329, used: 27_993, size: 1_000_000, origin: "task-notification" } },
  ];
  const requestUnits = (taskId: string) => Number((database!.db.query(
    "SELECT COUNT(*) AS n FROM multiremi_usage_units WHERE task_id=? AND source='provider_request'").get(taskId) as { n: number }).n);

  it("(1) a late follow-up joins the same turn as its final reply, and its requests are billed", async () => {
    const { store, task, daemon } = await bed("late-answer");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [RACE(300)] }, logPath, "claude"), { autonomousIdleMs: 5_000 });
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "3" });
    expect(agentLog(logPath).filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
    const trace = foldTraceLines(run.traceStore().read(task.id).events);
    const messages = trace.items.filter((item) => item.type === "agent_message" && item.parent_id === null);
    expect(messages.map((item) => item.type === "agent_message" && [item.text, item.phase === "final"]))
      .toEqual([["I started a background agent; I'll reply once it reports back.", false], ["3", true]]);
    expect(trace.items.find((item) => item.id === `sa:${CHILD}`)).toMatchObject({ status: "completed", background: true });
    await waitFor(() => requestUnits(task.id) === 3, "the prompt's and the follow-up's requests billed");
  }, 30_000);

  /** The 0.89 race where the root says nothing while the child runs: only the patched verdict can tell. */
  const SILENT_RACE = (backgrounded: boolean): FakeSubagentStep[] => [
    { update: { sessionUpdate: "subagent_spawned", subagentSessionId: CHILD, name: "Count files", task: "List the files",
      prompt: "List the files", capabilities: {}, _meta: { remi: { backgrounded, subagentType: "general-purpose" } } } },
    { session: CHILD, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "There are 3 files." },
      _meta: { claudeCode: { parentToolUseId: "toolu_01" } } } },
    ended(CHILD),
    chunk(backgrounded ? "I started a background agent; I'll reply once it reports back." : "3 files."),
    { billing: { origin: "human" } },
    { resolve: "end_turn" },
    ...(backgrounded ? [{ delayMs: 300, ...chunk("3") }, { billing: { origin: "task-notification" } }] as FakeSubagentStep[] : []),
  ];

  it("the race with the bridge patch's verdict: the late answer is still the turn's reply", async () => {
    const { store, task, daemon } = await bed("silent-race");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [SILENT_RACE(true)] }, logPath, "claude"), { autonomousIdleMs: 5_000 });
    await run.start();
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "3" });
    const agent = traceItems(run.traceStore().read(task.id).events).find((item) => item.id === `sa:${CHILD}`);
    expect(agent).toMatchObject({ background: true, agent_type: "general-purpose", status: "completed" });
  }, 30_000);

  it("a foreground child with the verdict `false` completes without waiting", async () => {
    const { store, task, daemon } = await bed("silent-foreground");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [SILENT_RACE(false)] }, logPath, "claude"), { autonomousIdleMs: 20_000 });
    await run.start();
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "3 files." });
    const resolvedAt = agentLog(logPath).find((entry) => entry.kind === "resolved")!.at;
    expect(Date.now() - resolvedAt).toBeLessThan(5_000);
  }, 30_000);

  const patchedSpawn = (id: string): FakeSubagentStep => ({ update: { sessionUpdate: "subagent_spawned", subagentSessionId: id,
    name: `Agent ${id.slice(-1)}`, task: "Count", prompt: "Count", capabilities: {}, _meta: { remi: { backgrounded: true, subagentType: null } } } });

  it("review fix 1: a placeholder result does not end the wait; the shared follow-up is the reply, billed once", async () => {
    const { store, task, daemon } = await bed("placeholder");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [[
      patchedSpawn("a0000000000000001"), patchedSpawn("a0000000000000002"),
      ended("a0000000000000001"), ended("a0000000000000002"),
      chunk("Started two background agents."),
      { billing: { origin: "human" } },
      { resolve: "end_turn" },
      // CLI 2.1.274+: one model call answers both queued notifications; the first gets an empty placeholder result.
      { delayMs: 100, update: { sessionUpdate: "usage_update", used: 0, size: 0, cost: { amount: 0.1, currency: "USD" },
        _meta: { "_claude/origin": { kind: "task-notification" } } } },
      { delayMs: 300, ...chunk("3 and 4") },
      { billing: {} },
      { billing: { origin: "task-notification" } },
    ]] }, logPath, "claude"), { autonomousIdleMs: 5_000 });
    await run.start();
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "3 and 4" });
    await waitFor(() => requestUnits(task.id) === 3, "the prompt's and the follow-up's requests billed");
    await Bun.sleep(300);
    expect(requestUnits(task.id)).toBe(3);
  }, 30_000);

  it("review fix 2: a card raised during the wait and answered after the cap keeps the round, and the turn completes after it", async () => {
    const { store, task, baseUrl, daemon } = await bed("card-in-wait", { ask: true });
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [[
      patchedSpawn(CHILD), ended(CHILD),
      chunk("Started a background agent."), { billing: { origin: "human" } }, { resolve: "end_turn" },
      { delayMs: 100, ...chunk("Writing the report.") },
      { permission: { toolCallId: "toolu_report", title: "Write report.md" } },
      { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Report written." }, messageId: "msg_after" } },
      { billing: { origin: "task-notification" } },
    ]] }, logPath, "claude", { providerOptions: { autonomousRoundCapMs: 300 } }), { autonomousIdleMs: 5_000 });
    const done = run.start();
    const pending = await waitFor(() => store.listTaskHumanRequests(task.id).find((request) => request.status === "pending"),
      "the follow-up's permission request");
    await Bun.sleep(1_000);
    // Still waiting for the person, past the 300 ms budget.
    expect(store.getTask(task.id)?.status).not.toBe("completed");
    expect((await respond(store, baseUrl, pending.id, "allow")).status).toBe(200);
    await done;
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "Report written." });
    expect(agentLog(logPath).find((entry) => entry.kind === "permission_answer")?.result)
      .toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  }, 30_000);

  it("review fix 3: a wrap-up in effect bounds the wait by its grace deadline", async () => {
    const { store, task, daemon } = await bed("wrap-up-in-wait");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [
      [chunk("Working on it. "), { hold: "cancel" }],
      [patchedSpawn(CHILD), ended(CHILD), chunk("I started a background agent."), { billing: { origin: "human" } },
        { resolve: "end_turn" }, { delayMs: 60_000, ...chunk("too late") }],
    ] }, logPath, "claude"), { autonomousIdleMs: 30_000, forceAnswerGraceMs: 1_500 });
    const done = run.start();
    await waitFor(() => agentLog(logPath).some((entry) => entry.method === "session/prompt"), "the first prompt");
    store.createTaskSteerMessage({ taskId: task.id, kind: "force_answer", content: "" });
    const steeredAt = Date.now();
    await done;
    expect(Date.now() - steeredAt).toBeLessThan(10_000);
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "I started a background agent." });
    const prompts = agentLog(logPath).filter((entry) => entry.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.params!.prompt[0].text).toContain("[Deliver now]");
  }, 30_000);

  it("(2) with no follow-up the wait ends at idleMs and the turn completes with the original reply", async () => {
    const { store, task, daemon } = await bed("no-follow-up");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [RACE(60_000).slice(0, 6)] }, logPath, "claude"), { autonomousIdleMs: 400 });
    const started = Date.now();
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed",
      result: "I started a background agent; I'll reply once it reports back." });
    const resolvedAt = agentLog(logPath).find((entry) => entry.kind === "resolved")!.at;
    expect(Date.now() - resolvedAt).toBeGreaterThanOrEqual(400);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("REMI_ACP_AUTONOMOUS_ROUNDS=0 (the option): no capture and no wait, as before PR 5", async () => {
    const { store, task, daemon } = await bed("no-autonomous");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [RACE(2_000)] }, logPath, "claude"), { autonomousRounds: false, autonomousIdleMs: 10_000 });
    await run.start();
    expect(store.getTask(task.id)).toMatchObject({ status: "completed",
      result: "I started a background agent; I'll reply once it reports back." });
    const resolvedAt = agentLog(logPath).find((entry) => entry.kind === "resolved")!.at;
    expect(Date.now() - resolvedAt).toBeLessThan(5_000);
  }, 30_000);

  it("(3) a steer during the wait ends it, re-prompts on the same session and completes once", async () => {
    const { store, task, daemon } = await bed("steer-in-wait");
    const logPath = join(workDir!, "agent.jsonl");
    let steerId = "";
    // The re-prompt's own result (`human`) carried the pending notification: no second wait.
    const run = daemon(scriptedAcp({ prompts: [RACE(20_000), [chunk("中文结论"), { billing: { origin: "human" } }]] }, logPath, "claude"),
      { autonomousIdleMs: 15_000 });
    const done = run.start();
    await waitFor(() => agentLog(logPath).find((entry) => entry.kind === "resolved"), "the first prompt resolved");
    steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
    const steeredAt = Date.now();
    await done;

    expect(Date.now() - steeredAt).toBeLessThan(10_000);
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
    const log = agentLog(logPath);
    expect(log.filter((entry) => entry.method === "session/prompt")).toHaveLength(2);
    expect(log.some((entry) => entry.kind === "overlap")).toBe(false);
    expect(log.filter((entry) => entry.method === "session/prompt")[1]!.params!.prompt[0].text).toContain("改用中文输出");
    expect(store.getTaskSteerMessage(steerId)?.consumedAt).toBeTruthy();
  }, 30_000);

  it("(6) task.activity reports the running subagents, 1 then 0", async () => {
    const reports = spyOn(MultiremiDaemonClient.prototype, "reportTaskActivity");
    try {
      const { store, task, daemon } = await bed("activity");
      const logPath = join(workDir!, "agent.jsonl");
      const run = daemon(scriptedAcp({ prompts: [[
        spawned(CHILD),
        chunk("Started it; waiting."),
        { delayMs: 900, session: CHILD, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "3" } } },
        ended(CHILD),
        // The bridge held the prompt for the child; the follow-up is inside it.
        chunk("3"),
        { billing: { origin: "task-notification" } },
      ]] }, logPath, "claude"));
      await run.start();
      expect(store.getTask(task.id)?.status).toBe("completed");
      const values = reports.mock.calls.filter(([taskId]) => taskId === task.id).map(([, running]) => running);
      expect(values[0]).toBe(1);
      expect(values.at(-1)).toBe(0);
      expect(values.filter((value, index) => index === 0 || values[index - 1] !== value)).toEqual([1, 0]);
    } finally {
      reports.mockRestore();
    }
  }, 30_000);
});
