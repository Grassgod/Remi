// Background tasks with keep-alive on demand (PR 6 §2), end to end through a
// real daemon, server and AcpProvider over the scripted ACP agent
// (tests/fixtures/acp/fake-subagent-agent.ts).
//
// Phase D (the server's `lane.background` cap, the `lane.background_wake` RPC
// and the downlinks) runs in another worktree, so this harness plays its part
// on the daemon's socket: the welcome carries the cap, a doorbell RPC writes
// the platform `status` message to the agent the way §2.5 specifies (the
// ordinary lane machine then makes the turn), and lane snapshots are recorded.
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openIntegrationDatabase, type IntegrationDatabase } from "../helpers/integration-database.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMultiremiServer, TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import type { MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import { AcpProvider, type AcpProviderOptions } from "@acp/provider.js";
import { DAEMON_MIN_CLI_VERSION, type DaemonLaneBackgroundTasksPayload, type DaemonLaneBackgroundWakePayload } from "@multiremi/contracts/daemon-protocol.js";
import type { DaemonProtocolConnect, DaemonProtocolSocketLike } from "@multiremi/worker/daemon-protocol-client.js";
import { backgroundDoorbellBody, backgroundDoorbellDedupeKey } from "@shared/background-tasks.js";
import { traceItems } from "../helpers/turn-trace.js";
import { createResponsibleTestIssue } from "../unit/multiremi/helpers.js";
import type { FakeAsyncTaskStep, FakeSubagentConfig, FakeSubagentStep } from "../fixtures/acp/fake-subagent-agent.js";

let database: IntegrationDatabase | null = null;
let workDir: string | null = null;
let activeDaemons: MultiremiDaemon[] = [];
const activeServers = new Set<{ stop(closeActiveConnections?: boolean): unknown }>();
const cleanupsAfter: Array<() => void> = [];

beforeEach(async () => {
  database = await openIntegrationDatabase();
  workDir = mkdtempSync(join(tmpdir(), "claude-pr6b-bg-"));
});

afterEach(async () => {
  for (const daemon of activeDaemons.splice(0)) await daemon.stopAndDrainTestWork();
  for (const cleanup of cleanupsAfter.splice(0)) cleanup();
  for (const server of activeServers) server.stop(true);
  activeServers.clear();
  await database?.close();
  database = null;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

const FAKE_AGENT = join(import.meta.dir, "../fixtures/acp/fake-subagent-agent.ts");
const chunk = (text: string): FakeSubagentStep => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const task = (step: FakeAsyncTaskStep): FakeSubagentStep => ({ asyncTask: step });
const bash = (id: string, toolCallId: string, command: string): FakeSubagentStep[] => [
  { update: { sessionUpdate: "tool_call", toolCallId, kind: "execute", status: "pending", title: command,
    rawInput: { command, run_in_background: true }, _meta: { claudeCode: { toolName: "Bash" } } } },
  task({ id, event: "spawned", name: command, toolCallId }),
  { update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: `Command running in background with ID: ${id}`,
    _meta: { claudeCode: { toolName: "Bash" }, jetbrains: { air: { asyncTasks: { backgrounded: true } } } } } },
];

interface LogEntry { kind: string; method?: string; params?: Record<string, any>; pid: number; at: number; id?: string; stopped?: boolean }
const agentLog = (path: string): LogEntry[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry) : [];
const processes = (path: string) => new Set(agentLog(path).filter((entry) => entry.kind === "started").map((entry) => entry.pid));

/** No two processes of the agent ever ran at the same time (one process per provider session, §2.4). */
function expectNoOverlap(path: string): void {
  const log = agentLog(path);
  const lives = [...processes(path)].map((pid) => {
    const entries = log.filter((entry) => entry.pid === pid);
    return { pid, from: Math.min(...entries.map((entry) => entry.at)), to: Math.max(...entries.map((entry) => entry.at)) };
  }).sort((a, b) => a.from - b.from);
  for (let index = 1; index < lives.length; index++) expect(lives[index]!.from).toBeGreaterThanOrEqual(lives[index - 1]!.to);
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

interface PhaseD {
  snapshots: DaemonLaneBackgroundTasksPayload[];
  wakes: DaemonLaneBackgroundWakePayload[];
  connect: DaemonProtocolConnect;
}

/**
 * Phase D's server half on the daemon's socket: `lane.background` in the welcome (unless `cap: false`),
 * `lane.background_wake` writes the doorbell (or rejects with `reject`), snapshots are recorded.
 */
function phaseD(store: MultiremiStore, options: { cap?: boolean; reject?: "session_closed" | "lane_moved";
  /** A person's message sent in the same instant as the doorbell, so the two share one pending turn (§2.6). */
  alongside?: string } = {}): PhaseD {
  const snapshots: DaemonLaneBackgroundTasksPayload[] = [];
  const wakes: DaemonLaneBackgroundWakePayload[] = [];
  const connect: DaemonProtocolConnect = (url, init) => {
    const socket = new WebSocket(url, init as never);
    const wrapped = new Map<(event: any) => void, (event: any) => void>();
    const messageListeners = new Set<(event: any) => void>();
    const deliver = (frame: Record<string, unknown>) => {
      for (const listener of messageListeners) listener({ data: JSON.stringify(frame) });
    };
    const wake = (frame: { id: string; p: DaemonLaneBackgroundWakePayload }) => {
      wakes.push(frame.p);
      if (options.reject) return { ok: false, code: options.reject, retryable: false };
      const p = frame.p;
      if (options.alongside) store.sendChatMessage(p.session_id, { body: options.alongside });
      const sent = store.sendMessage({
        session_id: p.session_id, sender: { type: "platform", id: null }, to: { type: "agent", ref: p.agent_id },
        message_kind: "status", wake_requested: "now", body_md: backgroundDoorbellBody(p.task),
        dedupe_key: backgroundDoorbellDedupeKey(p, p.task.task_id), execution_scope: p.execution_scope,
        metadata: { background_task: { task_id: p.task.task_id, name: p.task.name, task_type: p.task.task_type, status: p.task.status,
          origin_attempt_id: p.task.origin_attempt_id, origin_turn_id: null, provider_session_id: p.provider_session_id } },
      });
      return { ok: true, outcome: "created", turn_id: sent.turn_id ?? null, attempt_id: null };
    };
    const shim: DaemonProtocolSocketLike = {
      get bufferedAmount() { return socket.bufferedAmount; },
      send(data: string) {
        const frame = JSON.parse(data) as { t: string; id?: string; p?: any };
        if (frame.t === "lane.background_tasks") { snapshots.push(frame.p); return; }
        if (frame.t === "lane.background_wake") {
          const reply = wake(frame as { id: string; p: DaemonLaneBackgroundWakePayload });
          queueMicrotask(() => deliver({ v: 2, t: "res", re: frame.id, ts: Date.now(), p: reply }));
          return;
        }
        socket.send(data);
      },
      close(code?: number, reason?: string) { socket.close(code, reason); },
      addEventListener(type: string, listener: (event: any) => void) {
        if (type !== "message") { socket.addEventListener(type, listener); return; }
        const inner = (event: any) => {
          const text = String(event.data);
          const frame = JSON.parse(text);
          if (frame.t === "welcome" && options.cap !== false) {
            listener({ data: JSON.stringify({ ...frame, p: { ...frame.p, caps: [...(frame.p.caps ?? []), "lane.background"] } }) });
            return;
          }
          listener(event);
        };
        wrapped.set(listener, inner);
        messageListeners.add(listener);
        socket.addEventListener("message", inner);
      },
      removeEventListener(type: string, listener: (event: any) => void) {
        if (type !== "message") { socket.removeEventListener(type, listener); return; }
        messageListeners.delete(listener);
        const inner = wrapped.get(listener);
        if (inner) socket.removeEventListener("message", inner);
      },
    };
    return shim;
  };
  return { snapshots, wakes, connect };
}

/** The real AcpProvider over the scripted agent, with everything the daemon may call on it. */
function scriptedAcp(config: FakeSubagentConfig, logPath: string, agentType: "claude" | "codex",
  extra: Partial<AcpProviderOptions> = {}): MultiremiDaemonProviderFactory {
  return (options) => {
    const acp = new AcpProvider({
      ...options, agentType, executable: process.execPath, args: [FAKE_AGENT], privateTmpDirectory: undefined,
      env: { ...options.env, FAKE_SUBAGENT_CONFIG: JSON.stringify({ advertise: agentType, ...config }), FAKE_SUBAGENT_LOG: logPath },
      ...extra,
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
      listAsyncTasks: (listOptions) => acp.listAsyncTasks(listOptions),
      stopAsyncTask: (taskId, stopOptions) => acp.stopAsyncTask(taskId, stopOptions),
      settleAsyncTasks: (settleOptions) => acp.settleAsyncTasks(settleOptions),
      reuseCheck: (chatId, sendOptions) => acp.reuseCheck(chatId, sendOptions),
      adoptSession: (from, to) => acp.adoptSession(from, to),
      park: (chatId, on) => acp.park(chatId, on),
      processGroupId: (chatId) => acp.processGroupId(chatId),
      sessionAlive: (chatId) => acp.sessionAlive(chatId),
      cancelIdle: (chatId) => acp.cancelIdle(chatId),
      close: () => acp.close(),
    };
  };
}

async function bed(name: string, options: { provider?: "claude" | "codex"; phaseD?: Parameters<typeof phaseD>[1] } = {}) {
  const store = new MultiremiStore(database!.db);
  const provider = options.provider ?? "claude";
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: `${name} agent`, provider });
  const token = (await store.createAccessToken({ name: `${name} daemon`, type: "daemon", workspaceId: "local", daemonId: `daemon-${name}` })).token;
  const server = startMultiremiServer({ store, scheduler: null, hostname: "127.0.0.1", port: 0 });
  activeServers.add(server);
  const d = phaseD(store, options.phaseD);
  const daemon = (providerFactory: MultiremiDaemonProviderFactory, extra: Partial<ConstructorParameters<typeof MultiremiDaemon>[0]> = {}) => {
    const run = new MultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: `http://127.0.0.1:${server.port}`,
      token, daemonId: `daemon-${name}`, runtimeName: `${name}-runtime`, provider, workspaceId: "local",
      daemonPort: 0, pollIntervalMs: 50, gcEnabled: false,
      protocolClientOptions: { cliVersion: DAEMON_MIN_CLI_VERSION, connect: d.connect },
      workspacesRoot: join(workDir!, "workspaces"), repoCacheRoot: join(workDir!, ".repo-cache"),
      steerPollIntervalMs: 250, taskDrainTimeoutMs: 1_000, autonomousIdleMs: 5_000, backgroundDrainMs: 300,
      parkedLaneOptions: { debounceMs: 20, closedRepeats: 1, idleCloseMs: 500, stopTimeoutMs: 2_000 },
      providerFactory, ...extra,
    });
    activeDaemons.push(run);
    void run.start().catch(() => {});
    return run;
  };
  return { store, agent, daemon, d };
}

const finished = (store: MultiremiStore, taskId: string) => ["completed", "failed", "cancelled"].includes(store.getTask(taskId)?.status ?? "");
const chatTasks = (store: MultiremiStore, chatId: string) =>
  (database!.db.query(`SELECT a.id FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id = a.turn_id
    WHERE t.session_id = ? ORDER BY t.seq, a.attempt_no`).all(chatId) as Array<{ id: string }>).map((row) => store.getTask(row.id)!);
const requestUnits = (taskId: string) => Number((database!.db.query(
  "SELECT COUNT(*) AS n FROM multiremi_usage_units WHERE task_id=? AND source='provider_request'").get(taskId) as { n: number }).n);

/** Claude: a background command that outlives the turn, then its task-notification cycle (claude-agent-acp 0.90). */
const OUTLIVES: FakeSubagentStep[] = [
  chunk("Running the tests in the background. "),
  ...bash("bash-1", "toolu_bash", "sleep 1; echo done"),
  chunk("I'll report when they finish."),
  { billing: { origin: "human", cost: 0.2 } },
  { resolve: "end_turn" },
  { delayMs: 1_500, ...task({ id: "bash-1", event: "completed", summary: "done", then: [
    { delayMs: 50, ...chunk("The tests passed.") },
    { billing: { origin: "task-notification", cost: 0.3 } },
  ] }) },
];

describe("Bun Multiremi daemon background tasks (PR 6)", () => {
  it("(1) parks a Chat lane, rings the doorbell, and the doorbell turn attaches to the same process", async () => {
    const { store, agent, daemon, d } = await bed("doorbell");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [OUTLIVES] }, logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Run the tests in the background" }).task;
    await waitFor(() => finished(store, first.id), "the first turn");
    expect(store.getTask(first.id)).toMatchObject({ status: "completed", result: "I'll report when they finish." });
    // Parked: the process is alive and no session/close was sent.
    expect(agent && agentLog(logPath).some((entry) => entry.kind === "exited")).toBe(false);
    const firstTrace = traceItems(run.traceStore().read(first.id).events);
    expect(firstTrace.find((item) => item.id === "bg:bash-1")).toMatchObject({ type: "background_task", status: "completed", handed_off: true });
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.state === "parked"), "the parked snapshot");

    // The task ends while parked: the doorbell, a platform status message, a turn, an attaching offer.
    await waitFor(() => d.wakes.length === 1, "the doorbell");
    expect(d.wakes[0]).toMatchObject({ session_id: chat.id, agent_id: agent.id, task: { task_id: "bash-1", status: "completed",
      origin_attempt_id: first.id, summary: "done" } });
    const second = await waitFor(() => chatTasks(store, chat.id).find((candidate) => candidate.id !== first.id && finished(store, candidate.id)),
      "the doorbell turn");
    expect(second).toMatchObject({ status: "completed", result: "The tests passed." });
    const log = agentLog(logPath);
    expect(processes(logPath).size).toBe(1);
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    // Attached: the cycle was replayed; nothing was prompted again.
    expect(log.filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
    const secondTrace = traceItems(run.traceStore().read(second.id).events);
    // (The input's `background_tasks` needs Phase D's projection to keep `metadata.background_task`.)
    expect(secondTrace.find((item) => item.id === "bg:bash-1")).toMatchObject({ status: "completed", summary: "done" });
    // The cycle's request is billed in the attaching attempt.
    await waitFor(() => requestUnits(second.id) === 1, "the cycle billed in the new attempt");
    // Nothing runs any more: the process closed at the doorbell turn's end.
    await waitFor(() => agentLog(logPath).some((entry) => entry.kind === "exited"), "the process closing");
    await waitFor(() => d.snapshots.at(-1)?.state === "closed", "the closed snapshot");
    expect(d.snapshots.at(-1)!.tasks).toEqual([expect.objectContaining({ task_id: "bash-1", status: "completed" })]);
  }, 60_000);

  it("(2) a user message while parked adopts the process: one initialize, no second process", async () => {
    const { store, agent, daemon } = await bed("adopt");
    const logPath = join(workDir!, "agent.jsonl");
    daemon(scriptedAcp({ prompts: [
      [...bash("bash-1", "toolu_srv", "python3 -m http.server"), chunk("Server started."), { resolve: "end_turn" }],
      [chunk("It still runs.")],
    ] }, logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, first.id), "the first turn");
    const second = store.sendChatMessage(chat.id, { body: "Is it up?" }).task;
    await waitFor(() => finished(store, second.id), "the second turn");
    expect(store.getTask(second.id)).toMatchObject({ status: "completed", result: "It still runs." });
    const log = agentLog(logPath);
    expect(processes(logPath).size).toBe(1);
    expect(log.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry.method === "session/prompt")).toHaveLength(2);
    expect(log.filter((entry) => entry.method === "session/load" || entry.method === "session/resume")).toHaveLength(0);
    expect(log.some((entry) => entry.kind === "exited")).toBe(false);
  }, 60_000);

  it("(5) the keep-alive cap stops the tasks and closes the process", async () => {
    const { store, agent, daemon, d } = await bed("cap");
    const logPath = join(workDir!, "agent.jsonl");
    daemon(scriptedAcp({ prompts: [[...bash("bash-1", "toolu_srv", "python3 -m http.server"), chunk("Started."), { resolve: "end_turn" }]] },
      logPath, "claude"), { backgroundKeepAliveMs: 1_500 });
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, first.id), "the turn");
    await waitFor(() => agentLog(logPath).some((entry) => entry.kind === "exited"), "the cap closing the process");
    expect(agentLog(logPath).filter((entry) => entry.kind === "async_task_stop")).toEqual([expect.objectContaining({ id: "bash-1", stopped: true })]);
    await waitFor(() => d.snapshots.at(-1)?.state === "closed", "the closed snapshot");
    expect(d.snapshots.at(-1)!.tasks[0]).toMatchObject({ status: "stopped", stop_reason: "keepalive_cap" });
    expect(d.snapshots.find((snapshot) => snapshot.state === "parked")?.parked_until).toBeTruthy();
  }, 60_000);

  it("(6) with one parked lane at most, a second lane that parks evicts the first", async () => {
    const { store, agent, daemon, d } = await bed("evict");
    const logPath = join(workDir!, "agent.jsonl");
    daemon(scriptedAcp({ prompts: [[...bash("bash-1", "toolu_srv", "python3 -m http.server"), chunk("Started."), { resolve: "end_turn" }]] },
      logPath, "claude"), { maxParkedLanes: 1 });
    const one = store.createChatSession({ agentId: agent.id });
    const two = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(one.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, first.id), "the first lane's turn");
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.session_id === one.id && snapshot.state === "parked"), "the first lane parked");
    const second = store.sendChatMessage(two.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, second.id), "the second lane's turn");
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.session_id === one.id && snapshot.state === "closed"), "the eviction");
    expect(d.snapshots.filter((snapshot) => snapshot.session_id === one.id).at(-1)!.tasks[0]).toMatchObject({ status: "stopped", stop_reason: "evicted" });
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.session_id === two.id && snapshot.state === "parked"), "the second lane parked");
    expect(processes(logPath).size).toBe(2);
    expect(agentLog(logPath).filter((entry) => entry.kind === "exited")).toHaveLength(1);
  }, 60_000);

  it("(10) a changed agent config releases the parked process before a fresh one starts (config_changed)", async () => {
    const { store, agent, daemon, d } = await bed("config");
    const logPath = join(workDir!, "agent.jsonl");
    daemon(scriptedAcp({ prompts: [[...bash("bash-1", "toolu_srv", "python3 -m http.server"), chunk("Started."), { resolve: "end_turn" }],
      [chunk("Fresh process.")]] }, logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, first.id), "the first turn");
    store.updateAgent(agent.id, { customEnv: { PR6_TEST_SETTING: "changed" } });
    const second = store.sendChatMessage(chat.id, { body: "Again" }).task;
    await waitFor(() => finished(store, second.id), "the second turn");
    expect(store.getTask(second.id)?.status).toBe("completed");
    expect(processes(logPath).size).toBe(2);
    expectNoOverlap(logPath);
    expect(agentLog(logPath).filter((entry) => entry.kind === "async_task_stop")).toEqual([expect.objectContaining({ id: "bash-1", stopped: true })]);
    const closed = d.snapshots.find((snapshot) => snapshot.state === "closed")!;
    expect(closed.tasks[0]).toMatchObject({ status: "stopped", stop_reason: "config_changed" });
  }, 60_000);

  it("(11) Codex parks without a doorbell, and the next turn adopts the process", async () => {
    const codexHome = join(workDir!, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "fake" } }), { mode: 0o600 });
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanupsAfter.push(() => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });
    const { store, agent, daemon, d } = await bed("codex", { provider: "codex" });
    const logPath = join(workDir!, "agent.jsonl");
    daemon(scriptedAcp({ prompts: [
      [{ update: { sessionUpdate: "tool_call", toolCallId: "call_srv", kind: "execute", status: "in_progress",
        title: "python3 -m http.server", rawInput: { command: ["python3", "-m", "http.server"] } } },
      chunk("Server started."), { resolve: "end_turn" },
      // codex-acp announces the terminal after the prompt resolved (§1.2).
      { delayMs: 100, update: { sessionUpdate: "tool_call_update", toolCallId: "call_srv",
        _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } } },
      task({ id: "thr:call_srv", event: "spawned", name: "python3 -m http.server", toolCallId: "call_srv" }),
      { delayMs: 1_500, ...task({ id: "thr:call_srv", event: "completed" }) }],
      [chunk("Its log says it served 3 requests.")],
    ] }, logPath, "codex"), { backgroundDrainMs: 1_000 });
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, first.id), "the first turn");
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.state === "parked"), "parked");
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.tasks[0]?.status === "completed"), "the end reported while parked");
    await Bun.sleep(300);
    expect(d.wakes).toEqual([]);
    const second = store.sendChatMessage(chat.id, { body: "Check its log" }).task;
    await waitFor(() => finished(store, second.id), "the second turn");
    expect(store.getTask(second.id)).toMatchObject({ status: "completed", result: "Its log says it served 3 requests." });
    expect(processes(logPath).size).toBe(1);
    expect(agentLog(logPath).filter((entry) => entry.method === "initialize")).toHaveLength(1);
  }, 60_000);

  it("(12) a person's stop of a parked task stops it on the root session; the lane then closes", async () => {
    const { store, agent, daemon, d } = await bed("user-stop");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [[...bash("bash-1", "toolu_srv", "python3 -m http.server"), chunk("Started."), { resolve: "end_turn" }]] },
      logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, first.id), "the turn");
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.state === "parked"), "parked");
    // Phase D derives `lane.background_stop` from the registry; the daemon's handler takes it from here.
    await (run as unknown as { parkedLanes: { handleStop(payload: unknown): Promise<void> } }).parkedLanes.handleStop({
      session_id: chat.id, agent_id: agent.id, execution_scope: "", task_id: "*", requested_at: new Date().toISOString() });
    expect(agentLog(logPath).filter((entry) => entry.kind === "async_task_stop")).toEqual([expect.objectContaining({ id: "bash-1", stopped: true })]);
    expect(agentLog(logPath).find((entry) => entry.method === "_session/async_task/stop")!.params).toMatchObject({ asyncTaskId: "bash-1" });
    // A stop never rings; nothing runs, so the lane closes after its idle wait.
    await waitFor(() => agentLog(logPath).some((entry) => entry.kind === "exited"), "the process closing");
    expect(d.wakes).toEqual([]);
    await waitFor(() => d.snapshots.some((snapshot) => snapshot.state === "closed"), "the closed snapshot");
    const reported = d.snapshots.filter((snapshot) => snapshot.state === "closed").at(-1)!.tasks[0]!;
    expect(reported).toMatchObject({ status: "stopped", stop_reason: "user", stop_request: { by: "user", outcome: "stopped" } });
  }, 60_000);

  it("(13) a server without the cap: nothing parks, the task stops at the turn's end", async () => {
    const { store, agent, daemon, d } = await bed("no-cap", { phaseD: { cap: false } });
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [[...bash("bash-1", "toolu_srv", "python3 -m http.server"), chunk("Started."), { resolve: "end_turn" }]] },
      logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Start a server" }).task;
    await waitFor(() => finished(store, first.id), "the turn");
    await waitFor(() => agentLog(logPath).some((entry) => entry.kind === "exited"), "the process closing");
    expect(agentLog(logPath).filter((entry) => entry.kind === "async_task_stop")).toEqual([expect.objectContaining({ id: "bash-1", stopped: true })]);
    const item = traceItems(run.traceStore().read(first.id).events).find((candidate) => candidate.id === "bg:bash-1");
    expect(item).toMatchObject({ status: "stopped", stop_reason: "turn_end", stop_request: { by: "remi", outcome: "stopped" } });
    expect(d.snapshots).toEqual([]);
  }, 60_000);

  it("(3) a person steers into an attached doorbell turn: the listen stops and the steer is prompted on the same process", async () => {
    const { store, agent, daemon } = await bed("steer-attached");
    const logPath = join(workDir!, "agent.jsonl");
    const slowCycle: FakeSubagentStep[] = [
      ...bash("bash-1", "toolu_bash", "npm test"), chunk("Running."), { billing: { origin: "human" } }, { resolve: "end_turn" },
      { delayMs: 1_200, ...task({ id: "bash-1", event: "completed", then: [
        { delayMs: 50, ...chunk("Tests passed; writing the summary") },
        { delayMs: 8_000, ...chunk(" (late)") },
        { billing: { origin: "task-notification" } },
      ] }) },
    ];
    const run = daemon(scriptedAcp({ prompts: [slowCycle, [chunk("Summary in Chinese: 测试通过"), { billing: { origin: "human" } }]] }, logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Run the tests" }).task;
    await waitFor(() => finished(store, first.id), "the first turn");
    const second = await waitFor(() => chatTasks(store, chat.id).find((candidate) => candidate.id !== first.id
      && store.getTask(candidate.id)?.status === "running"), "the attached doorbell turn");
    await waitFor(() => traceItems(run.traceStore().read(second.id).events).some((item) => item.type === "agent_message"), "the cycle streaming");
    store.createTaskSteerMessage({ taskId: second.id, kind: "steer", content: "用中文总结" });
    await waitFor(() => finished(store, second.id), "the doorbell turn");
    expect(store.getTask(second.id)).toMatchObject({ status: "completed", result: "Summary in Chinese: 测试通过" });
    const log = agentLog(logPath);
    expect(processes(logPath).size).toBe(1);
    expect(log.filter((entry) => entry.method === "session/prompt")).toHaveLength(2);
    expect(log.some((entry) => entry.kind === "overlap")).toBe(false);
    expect(log.filter((entry) => entry.method === "session/prompt")[1]!.params!.prompt[0].text).toContain("用中文总结");
  }, 60_000);

  it("(4) a person's message merged into the pending doorbell turn: the cycle replays, then the message is prompted", async () => {
    const { store, agent, daemon } = await bed("merged", { phaseD: { alongside: "And what about lint?" } });
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [OUTLIVES, [chunk("Lint is clean too."), { billing: { origin: "human" } }]] }, logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Run the tests in the background" }).task;
    await waitFor(() => finished(store, first.id), "the first turn");
    const second = await waitFor(() => chatTasks(store, chat.id).find((candidate) => candidate.id !== first.id && finished(store, candidate.id)),
      "the merged turn");
    expect(chatTasks(store, chat.id)).toHaveLength(2);
    expect(second).toMatchObject({ status: "completed", result: "Lint is clean too." });
    const log = agentLog(logPath);
    expect(processes(logPath).size).toBe(1);
    const prompts = log.filter((entry) => entry.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.params!.prompt[0].text).toContain("And what about lint?");
    expect(prompts[1]!.params!.prompt[0].text).not.toContain("后台任务已结束");
    const items = traceItems(run.traceStore().read(second.id).events);
    expect(items.filter((item) => item.type === "agent_message").map((item) => (item as { text: string }).text))
      .toEqual(["The tests passed.", "Lint is clean too."]);
  }, 60_000);

  it("(D9) an Issue lane never parks: its task stops at the attempt's end", async () => {
    const { store, agent, daemon, d } = await bed("issue-lane");
    const logPath = join(workDir!, "agent.jsonl");
    const run = daemon(scriptedAcp({ prompts: [[...bash("bash-1", "toolu_srv", "python3 -m http.server"), chunk("Started."), { resolve: "end_turn" }]] },
      logPath, "claude"));
    const issue = createResponsibleTestIssue(store, { title: "Issue lane", assigneeType: "agent", assigneeId: agent.id,
      responsibleMemberId: "mem_local_local" });
    const attempt = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id, { agentId: agent.id, prompt: "Start a server" });
    await waitFor(() => finished(store, attempt.id), "the Issue turn");
    await waitFor(() => agentLog(logPath).some((entry) => entry.kind === "exited"), "the process closing");
    expect(agentLog(logPath).filter((entry) => entry.kind === "async_task_stop")).toEqual([expect.objectContaining({ id: "bash-1", stopped: true })]);
    expect(traceItems(run.traceStore().read(attempt.id).events).find((item) => item.id === "bg:bash-1"))
      .toMatchObject({ status: "stopped", stop_reason: "turn_end" });
    expect(d.snapshots).toEqual([]);
  }, 60_000);

  it("(14) a rejected doorbell (session_closed) cancels the cycle and closes the lane", async () => {
    const { store, agent, daemon, d } = await bed("rejected", { phaseD: { reject: "session_closed" } });
    const logPath = join(workDir!, "agent.jsonl");
    daemon(scriptedAcp({ prompts: [OUTLIVES] }, logPath, "claude"));
    const chat = store.createChatSession({ agentId: agent.id });
    const first = store.sendChatMessage(chat.id, { body: "Run the tests in the background" }).task;
    await waitFor(() => finished(store, first.id), "the turn");
    await waitFor(() => d.wakes.length === 1, "the doorbell");
    await waitFor(() => agentLog(logPath).some((entry) => entry.kind === "exited"), "the lane closing");
    expect(agentLog(logPath).some((entry) => entry.method === "session/cancel")).toBe(true);
    expect(chatTasks(store, chat.id)).toHaveLength(1);
  }, 60_000);
});
