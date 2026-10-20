// Mid-run steering e2e against fake providers: a provider with native steering
// (ADR 0020) gets a steer injected into the streaming prompt; one without it,
// or whose native call does not inject, has the turn soft-interrupted and the
// steer sent as the next prompt on the same provider session. Turn wrap-up
// additionally arms a grace deadline after which the run completes with the
// output produced so far. The last cases drive the real AcpProvider against a
// scripted ACP agent that refuses an overlapping session/prompt.
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { openIntegrationDatabase, type IntegrationDatabase, useMigratedIntegrationDatabases } from "../helpers/integration-database.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResponse, SendOptions } from "@shared/contracts/provider-types.js";
import { startMultiremiServer } from "../fixtures/daemon-protocol.js";
import type { MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import type { TraceSteerResult } from "@multiremi/contracts/trace.js";
import type { ProviderEvent, SteerResult } from "@shared/contracts/provider-types.js";
import { AcpProvider, type AcpProviderOptions } from "@acp/provider.js";
import { agentTexts, traceItems } from "../helpers/turn-trace.js";
import type { FakeSteerConfig } from "../fixtures/acp/fake-steering-agent.js";

useMigratedIntegrationDatabases();

let database: IntegrationDatabase | null = null;
let fixtureStore: MultiremiStore | null = null;
let workDir: string | null = null;
let activeDaemon: MultiremiDaemon | null = null;
const activeServers = new Set<{ stop(closeActiveConnections?: boolean): unknown }>();

beforeEach(async () => {
  // Database provisioning and schema migration are environment setup. Keep
  // the unchanged 5s test budget focused on native steer delivery and completion.
  database = await openIntegrationDatabase();
  fixtureStore = new MultiremiStore(database.db);
  workDir = mkdtempSync(join(tmpdir(), 'multiremi-daemon-steer-'));
});

afterEach(async () => {
  await activeDaemon?.stopAndDrainTestWork();
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

async function testBed(_prefix: string): Promise<{ store: MultiremiStore; root: string }> {
  return { store: fixtureStore!, root: workDir! };
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

const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: [{ type: "text", text }],
}) as any;

const FAKE_AGENT = join(import.meta.dir, "../fixtures/acp/fake-steering-agent.ts");
const REPROMPT: TraceSteerResult = { via: "reprompt", native_outcome: null, error: null };
const NATIVE: TraceSteerResult = { via: "native", native_outcome: "injected", error: null };

/** One task, a registered runtime and a server, named after the case. */
async function steerBed(name: string, prompt: string) {
  const store = fixtureStore!;
  const agent = store.createAgent({ name: `${name} agent`, provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt });
  const token = (await store.createAccessToken({ name: `${name} daemon`, type: "daemon", workspaceId: "local" })).token;
  store.registerRuntime({ id: daemonRuntimeIdForTest(`daemon-${name}`, "claude"), name: `${name}-runtime`,
    provider: "claude", workspaceId: "local", ownerId: "local" });
  const server = startMultiremiServer({ store, scheduler: null, authToken: `root-${name}`, hostname: "127.0.0.1", port: 0 });
  activeServers.add(server);
  const daemon = (providerFactory: MultiremiDaemonProviderFactory, extra: Partial<ConstructorParameters<typeof MultiremiDaemon>[0]> = {}) =>
    activeDaemon = new MultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: `http://127.0.0.1:${server.port}`,
      token, daemonId: `daemon-${name}`, runtimeName: `${name}-runtime`, provider: "claude", workspaceId: "local",
      once: true, daemonPort: 0,
      workspacesRoot: join(workDir!, "workspaces"), repoCacheRoot: join(workDir!, ".repo-cache"),
      steerPollIntervalMs: 250, providerFactory, ...extra,
    });
  return { store, task, server, daemon };
}

/** `[steer_id, result]` of every steer the trace recorded, in order. */
function steerResults(daemon: MultiremiDaemon, taskId: string): Array<[string, TraceSteerResult | undefined]> {
  return traceItems(daemon.traceStore().read(taskId).events).flatMap((item) =>
    item.type === "user_message" && item.origin === "steer" && item.steer ? [[item.steer.steer_id, item.steer.result]] as const : []);
}

const response = (sessionId: string): AgentResponse => ({ text: "", sessionId, requestId: `req-${sessionId}`,
  inputTokens: 1, outputTokens: 1, totalTokens: 2, model: "claude-native" });

/** The real AcpProvider over the scripted agent, so the steer is created once the prompt streams. */
function scriptedAcp(config: FakeSteerConfig, logPath: string, agentType: "claude" | "codex",
  onFirstChunk: () => void, extra: { providerOptions?: Partial<AcpProviderOptions>; beforeFirstPrompt?: () => Promise<void> } = {},
): MultiremiDaemonProviderFactory {
  return (options) => {
    const acp = new AcpProvider({
      ...options, agentType, executable: process.execPath, args: [FAKE_AGENT], privateTmpDirectory: undefined,
      env: { ...options.env, FAKE_STEER_CONFIG: JSON.stringify(config), FAKE_STEER_LOG: logPath },
      ...extra.providerOptions,
    });
    let chunks = 0;
    let prompts = 0;
    return {
      async *sendStream(message, sendOptions) {
        if (++prompts === 1) await extra.beforeFirstPrompt?.();
        for await (const event of acp.sendStream(message, sendOptions)) {
          yield event as ProviderEvent;
          if (event.sessionUpdate === "agent_message_chunk" && ++chunks === 1) onFirstChunk();
        }
      },
      steer: (text, steerOptions) => acp.steer(text, steerOptions),
      getLastResponse: () => acp.getLastResponse(),
      get typedSessionFailures() { return acp.typedSessionFailures; },
      setPermissionHandler: (handler) => acp.setPermissionHandler(handler),
      setElicitationHandler: (handler) => acp.setElicitationHandler(handler),
      close: () => acp.close(),
    };
  };
}

function agentFrames(logPath: string): Array<{ kind: string; method?: string; params?: Record<string, any>; at: number }> {
  return existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

describe("Bun Multiremi daemon steering", () => {
  it("injects a mid-run steer into the same provider session and completes", async () => {
    const { store, root } = await testBed("multiremi-daemon-steer-");
    const agent = store.createAgent({ name: "Steer Agent", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Write the summary in English" });
    const daemonToken = await store.createAccessToken({ name: "Steer daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer", "claude");
    store.registerRuntime({ id: runtimeId, name: "steer-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-steer", hostname: "127.0.0.1", port: 0 });
    activeServers.add(server);

    const prompts: string[] = [];
    const sendOptions: SendOptions[] = [];
    let steerId: string | null = null;
    const response: AgentResponse = {
      text: "",
      sessionId: "sess-steer",
      requestId: "req-steer",
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      model: "claude-steer",
    };
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream(message, options) {
        prompts.push(message);
        sendOptions.push(options ?? {});
        if (prompts.length === 1) {
          yield chunk("English draft. ");
          // User steers while the turn is still streaming.
          steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
          while (!options?.signal?.aborted) await Bun.sleep(20);
          throw new Error("Cancelled");
        }
        yield chunk("中文结论");
      },
      getLastResponse: () => response,
    });

    try {
      const daemon = activeDaemon = new MultiremiDaemon({
        sshMeshManager: disabledSshMeshRuntime(),
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-steer",
        runtimeName: "steer-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(root, "workspaces"),
        repoCacheRoot: join(root, ".repo-cache"),
        steerPollIntervalMs: 250,
        providerFactory,
      });
      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      // The result contains only the post-steer segment; earlier output remains in the trace.
      expect(completed.result).toBe("中文结论");
      expect(agentTexts(daemon.traceStore().read(task.id).events)).toContain("English draft. ");

      // ADR 0023: the injected prompt is the directive itself, labelled as the turn input labels it, on the same session.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toBe("[Remi] 改用中文输出");
      expect(sendOptions[1]?.sessionId).toBe("sess-steer");

      // Consumed server-side, and auditable in the run's message stream.
      expect(steerId).toBeTruthy();
      expect(store.getTaskSteerMessage(steerId!)?.consumedAt).toBeTruthy();
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
      const steerMessages = traceItems(daemon.traceStore().read(task.id).events)
        .filter((item) => item.type === "user_message" && item.origin === "steer");
      expect(steerMessages).toHaveLength(1);
      // A provider without native steering: interrupt, then re-prompt; no native call was made.
      expect(steerMessages[0]).toMatchObject({ steer: { steer_id: steerId, kind: "steer", injected: true,
        result: { via: "reprompt", native_outcome: null, error: null } } });
      // The original request and the steer are the whole unread input, both inline: the range is complete,
      // so neither the trace nor the injected prompt carries the range record or an unread sentence.
      expect((steerMessages[0] as { text: string }).text).toBe("改用中文输出");
      expect(prompts[1]).not.toContain("unread_range");
      expect(prompts[1]).not.toContain("remi message list");
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });

  it("a steer accepted just before natural turn end is injected, not stranded", async () => {
    const { store, root } = await testBed("multiremi-daemon-steer-late-");
    const agent = store.createAgent({ name: "Late Steer Agent", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Answer briefly" });
    const daemonToken = await store.createAccessToken({ name: "Late steer daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer-late", "claude");
    store.registerRuntime({ id: runtimeId, name: "late-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-late", hostname: "127.0.0.1", port: 0 });
    activeServers.add(server);

    const prompts: string[] = [];
    let steerId: string | null = null;
    const response: AgentResponse = {
      text: "",
      sessionId: "sess-late",
      requestId: "req-late",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      model: "claude-late",
    };
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream(message) {
        prompts.push(message);
        if (prompts.length === 1) {
          yield chunk("old answer. ");
          // Steer lands while the turn is finishing — and the turn returns
          // immediately, before any feed poll can observe it.
          steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
          return;
        }
        yield chunk("中文结论");
      },
      getLastResponse: () => response,
    });

    try {
      const daemon = activeDaemon = new MultiremiDaemon({
        sshMeshManager: disabledSshMeshRuntime(),
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-steer-late",
        runtimeName: "late-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(root, "workspaces"),
        repoCacheRoot: join(root, ".repo-cache"),
        // Interval far beyond the test runtime: only the natural-end
        // authoritative check can save this steer.
        steerPollIntervalMs: 600_000,
        providerFactory,
      });
      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("中文结论");
      expect(agentTexts(daemon.traceStore().read(task.id).events)).toContain("old answer. ");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("改用中文输出");
      expect(steerId).toBeTruthy();
      expect(store.getTaskSteerMessage(steerId!)?.consumedAt).toBeTruthy();
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });

  it("consumes a pushed steer after the completion barrier without HTTP steer calls", async () => {
    const { store, root } = await testBed("multiremi-steer-completion-rpc-");
    const agent = store.createAgent({ name: "Completion race", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Answer briefly" });
    const token = await store.createAccessToken({ name: "Completion race daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "completion-race-test",
      hostname: "127.0.0.1", port: 0 });
    activeServers.add(server);
    const prompts: string[] = [];
    let steerId = "";
    let conflicts = 0;
    const originalComplete = store.completeTask.bind(store);
    const complete = spyOn(store, "completeTask").mockImplementation((id, input, authority) => {
      if (id === task.id && !steerId) {
        steerId = store.createTaskSteerMessage({ taskId: id, kind: "steer", content: "Include the final directive" }).id;
        store.getDaemonTurnBridge().snapshot({ runtimeId: authority!.runtimeId, daemonId: authority!.daemonId,
          workspaceId: authority!.workspaceId }, new Set([id]));
        conflicts++;
      }
      return originalComplete(id, input, authority);
    });
    const daemon = activeDaemon = new MultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: `http://127.0.0.1:${server.port}`, token: token.token, daemonId: "daemon-completion-race",
      runtimeName: "Completion race", provider: "claude", workspaceId: "local", once: true, daemonPort: 0,
      workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, "repos"),
      providerFactory: () => ({
        async *sendStream(prompt) { prompts.push(prompt); yield chunk(prompts.length === 1 ? "draft. " : "final directive."); },
        getLastResponse: () => ({ text: "", sessionId: "completion-race-session", requestId: "completion-race-request" }),
      }),
    });
    const http = (daemon as unknown as { client: MultiremiDaemonClient }).client;
    const list = spyOn(http, "listPendingTaskSteerMessages").mockRejectedValue(new Error("HTTP steer read is forbidden"));
    const consume = spyOn(http, "consumeTaskSteerMessages").mockRejectedValue(new Error("HTTP steer consume is forbidden"));
    try {
      await daemon.start();
      expect(conflicts).toBe(1);
      expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "final directive." });
      expect(agentTexts(daemon.traceStore().read(task.id).events)).toContain("draft. ");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Include the final directive");
      expect(store.getTaskSteerMessage(steerId)?.consumedAt).toBeTruthy();
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
      expect(list).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    } finally {
      await daemon.stopAndDrainTestWork();
      complete.mockRestore(); list.mockRestore(); consume.mockRestore();
      server.stop(true);
    }
  });

  it("a delayed replayed steer push does not cancel the next turn", async () => {
    const { store, root } = await testBed("multiremi-daemon-steer-duppoll-");
    const agent = store.createAgent({ name: "Dup Poll Agent", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Answer in English" });
    const daemonToken = await store.createAccessToken({ name: "Dup poll daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer-duppoll", "claude");
    store.registerRuntime({ id: runtimeId, name: "duppoll-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    let layer!: DaemonProtocolLayer;
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-dup", hostname: "127.0.0.1", port: 0,
      onDaemonProtocol: value => { layer = value; } });
    activeServers.add(server);
    let steerPushes = 0;
    let steerId = "";
    let replayedMessage: Record<string, unknown> | null = null;
    let resolveReplay!: () => void;
    const replayReceived = new Promise<void>(resolve => { resolveReplay = resolve; });
    const prompts: string[] = [];
    const response: AgentResponse = {
      text: "",
      sessionId: "sess-dup",
      requestId: "req-dup",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      model: "claude-dup",
    };
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream(message, options) {
        prompts.push(message);
        if (prompts.length === 1) {
          yield chunk("english draft. ");
          steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
          await new Promise<void>(resolve => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield chunk("中文结论");
        expect(replayedMessage).not.toBeNull();
        const session = layer.registry.sessionForRuntime(runtimeId);
        expect(session).toBeInstanceOf(DaemonProtocolSession);
        (session as DaemonProtocolSession).sendEvent({ t: "turn.message", rt: runtimeId, p: replayedMessage! });
        // Hold turn 2 open until every handler for the replay has settled.
        await replayReceived;
        await activeDaemon!.daemonProtocolClient().drain();
        expect(options?.signal?.aborted).toBe(false);
      },
      getLastResponse: () => response,
    });

    try {
      const daemon = activeDaemon = new MultiremiDaemon({
        sshMeshManager: disabledSshMeshRuntime(),
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-steer-duppoll",
        runtimeName: "duppoll-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(root, "workspaces"),
        repoCacheRoot: join(root, ".repo-cache"),
        protocolClientOptions: { onFrame: frame => {
          if (frame.type === "turn.message" && (frame.payload.message as { id?: string })?.id === steerId) {
            steerPushes++;
            replayedMessage = frame.payload;
            if (steerPushes === 2) resolveReplay();
          }
        } },
        providerFactory,
      });
      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("中文结论");
      expect(agentTexts(daemon.traceStore().read(task.id).events)).toContain("english draft. ");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("改用中文输出");
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
      expect(steerPushes).toBeGreaterThanOrEqual(2);
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });

  it("turn wrap-up finishes within the grace window even if the agent keeps going", async () => {
    const { store, root } = await testBed("multiremi-daemon-force-answer-");
    const agent = store.createAgent({ name: "Force Agent", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Research deeply" });
    const turn = store.listTurns({ workspace_id: "local" }).find(value => value.current_attempt_id === task.id)!;
    const daemonToken = await store.createAccessToken({ name: "Force daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-force", "claude");
    store.registerRuntime({ id: runtimeId, name: "force-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-force", hostname: "127.0.0.1", port: 0 });
    activeServers.add(server);

    const prompts: string[] = [];
    const response: AgentResponse = {
      text: "",
      sessionId: "sess-force",
      requestId: "req-force",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      model: "claude-force",
    };
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream(message, options) {
        prompts.push(message);
        if (prompts.length === 1) {
          yield chunk("Partial findings. ");
          const messages = store.listConversationLogEntries(turn.session_id).filter(entry => entry.kind === "message");
          store.wrapUpTurn(turn.id);
          expect(store.listConversationLogEntries(turn.session_id).filter(entry => entry.kind === "message")).toEqual(messages);
          while (!options?.signal?.aborted) await Bun.sleep(20);
          throw new Error("Cancelled");
        }
        // The steered turn ignores the wrap-up ask and keeps exploring; the
        // daemon's grace deadline must end the run with the output so far.
        yield chunk("Still exploring…");
        while (!options?.signal?.aborted) await Bun.sleep(20);
        throw new Error("Cancelled");
      },
      getLastResponse: () => response,
    });

    try {
      const daemon = activeDaemon = new MultiremiDaemon({
        sshMeshManager: disabledSshMeshRuntime(),
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-force",
        runtimeName: "force-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(root, "workspaces"),
        repoCacheRoot: join(root, ".repo-cache"),
        steerPollIntervalMs: 250,
        forceAnswerGraceMs: 600,
        providerFactory,
      });
      await daemon.start();

      const completed = store.getTask(task.id)!;
      // Grace timeout is not a failure: the run completes with what exists.
      expect(completed.status).toBe("completed");
      // Even when force-answer grace expires, the result intentionally keeps only the last segment.
      expect(completed.result).toBe("Still exploring…");
      expect(agentTexts(daemon.traceStore().read(task.id).events)).toContain("Partial findings. ");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Deliver now");
      expect(prompts[1]).toBe("[Deliver now] The user asked for the result immediately. Stop exploring and stop making new changes. "
        + "Based on the work completed so far, produce your best final conclusion and wrap up the task now.\n\n"
        + "Close out directly: summarize what was done, state your conclusion, and finish.");
      expect(store.getTurn(turn.id)?.wrap_up_requested_at).toBeTruthy();
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });

  it("cancel still cancels: no steer, no resurrection of the run", async () => {
    const { store, root } = await testBed("multiremi-daemon-steer-cancel-");
    const agent = store.createAgent({ name: "Cancel Agent", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Long run" });
    const daemonToken = await store.createAccessToken({ name: "Cancel daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer-cancel", "claude");
    store.registerRuntime({ id: runtimeId, name: "cancel-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-cancel", hostname: "127.0.0.1", port: 0 });
    activeServers.add(server);

    const prompts: string[] = [];
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream(_message, options) {
        prompts.push(_message);
        yield chunk("Working… ");
        store.cancelTask(task.id);
        while (!options?.signal?.aborted) await Bun.sleep(20);
        throw new Error("Cancelled");
      },
      getLastResponse: () => null,
    });

    try {
      const daemon = activeDaemon = new MultiremiDaemon({
        sshMeshManager: disabledSshMeshRuntime(),
        serverUrl: `http://127.0.0.1:${server.port}`,
        token: daemonToken.token,
        daemonId: "daemon-steer-cancel",
        runtimeName: "cancel-runtime",
        provider: "claude",
        workspaceId: "local",
        once: true,
        daemonPort: 0,
        workspacesRoot: join(root, "workspaces"),
        repoCacheRoot: join(root, ".repo-cache"),
        steerPollIntervalMs: 250,
        providerFactory,
      });
      await daemon.start();

      expect(prompts).toHaveLength(1);
      expect(store.getTask(task.id)?.status).toBe("cancelled");
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });
});

describe("Bun Multiremi daemon native steering (ADR 0020)", () => {
  it("injects into the running prompt: no interrupt, one prompt, acknowledged after it ends", async () => {
    const { store, task, daemon } = await steerBed("native", "Write the summary in English");
    const prompts: string[] = [];
    const steers: string[] = [];
    const injected = Promise.withResolvers<void>();
    let steerId = "";
    let consumedWhileRunning: string | null | undefined = "unset";
    let abortedFirst: boolean | undefined;
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        options?.onPromptStarted?.();
        yield chunk("English draft. ");
        steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
        await injected.promise;
        // Still unacknowledged: the range hint must be readable while the prompt runs.
        consumedWhileRunning = store.getTaskSteerMessage(steerId)?.consumedAt;
        yield chunk("中文结论");
        abortedFirst = options?.signal?.aborted;
      },
      async steer(text) {
        steers.push(text);
        injected.resolve();
        return { outcome: "injected" };
      },
      getLastResponse: () => response("sess-native"),
    }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
    expect(prompts).toHaveLength(1);
    expect(abortedFirst).toBe(false);
    expect(steers).toHaveLength(1);
    // The same text as the re-prompt: the directive itself.
    expect(steers[0]).toBe("[Remi] 改用中文输出");
    expect(consumedWhileRunning).toBeFalsy();
    expect(store.getTaskSteerMessage(steerId)?.consumedAt).toBeTruthy();
    expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
    expect(steerResults(run, task.id)).toEqual([[steerId, NATIVE]]);
    expect(agentTexts(run.traceStore().read(task.id).events)).toEqual(["English draft. ", "中文结论"]);
  });

  it("promptRequired race: the prompt ends by itself and the steer is re-prompted, with no interrupt", async () => {
    const { store, task, daemon } = await steerBed("native-prompt-required", "Answer briefly");
    const prompts: string[] = [];
    const steered = Promise.withResolvers<void>();
    const aborted: boolean[] = [];
    let steerId = "";
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        options?.onPromptStarted?.();
        if (prompts.length === 1) {
          yield chunk("old answer. ");
          steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
          // The bridge had already settled the turn when the steer arrived.
          await steered.promise;
          aborted.push(options?.signal?.aborted ?? false);
          return;
        }
        yield chunk("中文结论");
      },
      // The bridge's noRunningTurn as the prompt answers; the provider reports it as the prompt ending.
      async steer() {
        steered.resolve();
        return { outcome: "promptRequired", reason: "noActivePrompt" };
      },
      getLastResponse: () => response("sess-prompt-required"),
    }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("改用中文输出");
    expect(aborted).toEqual([false]);
    expect(steerResults(run, task.id)).toEqual([[steerId, { via: "reprompt", native_outcome: "promptRequired", error: null }]]);
    expect(store.getTaskSteerMessage(steerId)?.consumedAt).toBeTruthy();
  });

  it("startedNewTurn race: re-prompts only once the provider has answered (D3)", async () => {
    const { store, task, daemon } = await steerBed("native-started-new-turn", "Answer briefly");
    const prompts: Array<{ message: string; at: number }> = [];
    const steerCalled = Promise.withResolvers<void>();
    let answeredAt = 0;
    let steerId = "";
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push({ message, at: Date.now() });
        options?.onPromptStarted?.();
        if (prompts.length === 1) {
          yield chunk("old answer. ");
          steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
          // The prompt completes while the steer is still with the bridge.
          await steerCalled.promise;
          return;
        }
        yield chunk("中文结论");
      },
      async steer() {
        steerCalled.resolve();
        // The provider cancels the bridge's own turn and waits for it to go quiet.
        await Bun.sleep(300);
        answeredAt = Date.now();
        return { outcome: "startedNewTurn" };
      },
      getLastResponse: () => response("sess-started-new-turn"),
    }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.message).toContain("改用中文输出");
    expect(prompts[1]!.at).toBeGreaterThanOrEqual(answeredAt);
    expect(steerResults(run, task.id)).toEqual([[steerId, { via: "reprompt", native_outcome: "startedNewTurn", error: null }]]);
  });

  it("a failed native steer falls back to interrupt + re-prompt; two in a row turn native off", async () => {
    const { store, task, daemon } = await steerBed("native-failed", "Long run");
    const prompts: string[] = [];
    const steers: string[] = [];
    const steerIds: string[] = [];
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        options?.onPromptStarted?.();
        if (prompts.length <= 3) {
          yield chunk(`round ${prompts.length}. `);
          steerIds.push(store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: `steer ${prompts.length}` }).id);
          while (!options?.signal?.aborted) await Bun.sleep(10);
          throw new Error("Cancelled");
        }
        yield chunk("done");
      },
      async steer(text) {
        steers.push(text);
        return { outcome: "failed", error: `bridge said no ${steers.length}` };
      },
      getLastResponse: () => response("sess-failed"),
    }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "done" });
    expect(steers).toHaveLength(2);
    expect(prompts).toHaveLength(4);
    expect(prompts.slice(1).map((prompt) => prompt.match(/steer \d/)?.[0])).toEqual(["steer 1", "steer 2", "steer 3"]);
    expect(steerResults(run, task.id)).toEqual([
      [steerIds[0]!, { via: "reprompt", native_outcome: "failed", error: "bridge said no 1" }],
      [steerIds[1]!, { via: "reprompt", native_outcome: "failed", error: "bridge said no 2" }],
      [steerIds[2]!, REPROMPT],
    ]);
  });

  it("force-answer injected natively starts the grace at once, with no re-prompt", async () => {
    const { store, task, daemon } = await steerBed("native-force", "Research deeply");
    const turn = store.listTurns({ workspace_id: "local" }).find((value) => value.current_attempt_id === task.id)!;
    const prompts: string[] = [];
    const steers: string[] = [];
    const steered = Promise.withResolvers<void>();
    let injectedAt = 0;
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        options?.onPromptStarted?.();
        yield chunk("Partial findings. ");
        store.wrapUpTurn(turn.id);
        await steered.promise;
        // The agent ignores the wrap-up and keeps going; the grace ends the run.
        yield chunk("Still exploring…");
        while (!options?.signal?.aborted) await Bun.sleep(20);
        throw new Error("Cancelled");
      },
      async steer(text) {
        steers.push(text);
        injectedAt = Date.now();
        steered.resolve();
        return { outcome: "injected" };
      },
      getLastResponse: () => response("sess-force"),
    }), { forceAnswerGraceMs: 600 });
    await run.start();
    const finishedAt = Date.now();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "Still exploring…" });
    expect(prompts).toHaveLength(1);
    expect(steers).toEqual(["[Deliver now] The user asked for the result immediately. Stop exploring and stop making new changes. "
      + "Based on the work completed so far, produce your best final conclusion and wrap up the task now.\n\n"
      + "Close out directly: summarize what was done, state your conclusion, and finish."]);
    expect(finishedAt - injectedAt).toBeGreaterThanOrEqual(550);
    expect(steerResults(run, task.id)).toEqual([[expect.stringMatching(/^wrap_up:/), NATIVE]]);
    expect(store.getTurn(turn.id)?.wrap_up_requested_at).toBeTruthy();
  });

  it("force-answer held behind a running tool call still ends within the grace", async () => {
    const { store, task, daemon } = await steerBed("native-force-held", "Build everything");
    const turn = store.listTurns({ workspace_id: "local" }).find((value) => value.current_attempt_id === task.id)!;
    const prompts: string[] = [];
    let signal: AbortSignal | undefined;
    let handedOffAt = 0;
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        signal = options?.signal;
        options?.onPromptStarted?.();
        yield chunk("Still running the build.");
        store.wrapUpTurn(turn.id);
        while (!options?.signal?.aborted) await Bun.sleep(20);
        throw new Error("Cancelled");
      },
      // A provider holding the steer until the running tool call ends; it never does.
      steer() {
        handedOffAt = Date.now();
        return new Promise<SteerResult>((resolve) => {
          signal!.addEventListener("abort", () => resolve({ outcome: "promptRequired", reason: "noActivePrompt" }), { once: true });
        });
      },
      getLastResponse: () => response("sess-force-held"),
    }), { forceAnswerGraceMs: 600 });
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "Still running the build." });
    expect(prompts).toHaveLength(1);
    expect(handedOffAt).toBeGreaterThan(0);
    // Recorded, never delivered: the transcript dialog labels it 未送达.
    expect(steerResults(run, task.id)).toEqual([[expect.stringMatching(/^wrap_up:/),
      { via: "none", native_outcome: "promptRequired", error: null }]]);
  });

  it("cancel still cancels while a native steer is unanswered", async () => {
    const { store, task, daemon } = await steerBed("native-cancel", "Long run");
    const prompts: string[] = [];
    const steerCalled = Promise.withResolvers<void>();
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        options?.onPromptStarted?.();
        yield chunk("Working… ");
        store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "also do b" });
        await steerCalled.promise;
        store.cancelTask(task.id);
        while (!options?.signal?.aborted) await Bun.sleep(20);
        throw new Error("Cancelled");
      },
      steer() {
        steerCalled.resolve();
        return new Promise<SteerResult>(() => {});
      },
      getLastResponse: () => null,
    }));
    const started = Date.now();
    await run.start();

    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(prompts).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("real ACP provider: a Claude turn held for a background subagent takes the steer natively", async () => {
    const { store, task, daemon } = await steerBed("native-acp-held", "Count the files in the background");
    const logPath = join(workDir!, "agent-held.jsonl");
    let steerId = "";
    const run = daemon(scriptedAcp({ advertise: "claude",
      prompts: [{ background: true, chunks: ["Started a background count. "], hold: "steer", answer: "中文结论" }] }, logPath, "claude",
      () => { steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id; }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
    const frames = agentFrames(logPath);
    expect(frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(1);
    expect(frames.filter((frame) => frame.method === "session/cancel")).toHaveLength(0);
    const steering = frames.filter((frame) => frame.method === "_session/steering");
    expect(steering).toHaveLength(1);
    expect(steering[0]!.params).toMatchObject({ _meta: { steering: { idleBehavior: "promptRequired" } } });
    expect(steering[0]!.params!.prompt[0].text).toContain("改用中文输出");
    expect(steerResults(run, task.id)).toEqual([[steerId, NATIVE]]);
    expect(store.getTaskSteerMessage(steerId)?.consumedAt).toBeTruthy();
  });

  it("real ACP provider: a Claude steer waits for the running tool call, then joins the prompt", async () => {
    const { store, task, daemon } = await steerBed("native-acp-tool", "Run the slow command");
    const logPath = join(workDir!, "agent-tool.jsonl");
    let steerId = "";
    const run = daemon(scriptedAcp({ advertise: "claude",
      prompts: [{ chunks: ["Running it. "], tool: { ms: 500 }, hold: "steer", answer: "ALPHA BETA" }] }, logPath, "claude",
      () => { steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "also write BETA" }).id; }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "ALPHA BETA" });
    const frames = agentFrames(logPath);
    expect(frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(1);
    const toolDone = frames.find((frame) => frame.kind === "tool_completed")!;
    const steering = frames.filter((frame) => frame.method === "_session/steering");
    expect(steering).toHaveLength(1);
    expect(steering[0]!.at).toBeGreaterThanOrEqual(toolDone.at);
    expect(steerResults(run, task.id)).toEqual([[steerId, NATIVE]]);
  });

  const fallbacks: Array<[string, "claude" | "codex", FakeSteerConfig, TraceSteerResult["native_outcome"]]> = [
    ["unsupported", "claude", { advertise: "none", prompts: [{ chunks: ["English draft. "], hold: "cancel" }, { chunks: ["中文结论"] }],
      cancelDelayMs: 300 }, "unsupported"],
    ["failed", "codex", { advertise: "codex", prompts: [{ chunks: ["English draft. "], hold: "cancel" }, { chunks: ["中文结论"] }],
      steers: ["error"], cancelDelayMs: 300 }, "failed"],
    ["startedNewTurn", "codex", { advertise: "codex", prompts: [{ chunks: ["English draft. "], hold: "cancel" }, { chunks: ["中文结论"] }],
      steers: ["race"] }, "startedNewTurn"],
  ];
  for (const [name, agentType, config, outcome] of fallbacks) {
    it(`real ACP provider: the ${name} fallback never sends an overlapping session/prompt`, async () => {
      const { store, task, daemon } = await steerBed(`native-acp-${name.toLowerCase()}`, "Write the summary in English");
      const logPath = join(workDir!, `agent-${name}.jsonl`);
      let steerId = "";
      const run = daemon(scriptedAcp(config, logPath, agentType,
        () => { steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id; }));
      await run.start();

      expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
      const frames = agentFrames(logPath);
      expect(frames.filter((frame) => frame.kind === "overlap")).toEqual([]);
      const prompts = frames.filter((frame) => frame.method === "session/prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]!.params!.prompt[0].text).toContain("改用中文输出");
      expect(frames.filter((frame) => frame.method === "_session/steering")).toHaveLength(outcome === "unsupported" ? 0 : 1);
      expect(frames.filter((frame) => frame.method === "session/cancel")).toHaveLength(1);
      const [[id, result]] = steerResults(run, task.id) as [[string, TraceSteerResult]];
      expect(id).toBe(steerId);
      expect(result).toMatchObject({ via: "reprompt", native_outcome: outcome });
      if (outcome === "failed") expect(result.error).toContain("steer refused");
      else expect(result.error).toBeNull();
      expect(store.getTaskSteerMessage(steerId)?.consumedAt).toBeTruthy();
    });
  }
});

describe("Bun Multiremi daemon native steering: review fixes", () => {
  for (const agentType of ["claude", "codex"] as const) {
    it(`real ACP provider (${agentType}): a steer queued before the prompt goes out joins the turn once the bridge starts it`, async () => {
      const { store, task, daemon } = await steerBed(`native-early-${agentType}`, "Write the summary in English");
      const logPath = join(workDir!, `agent-early-${agentType}.jsonl`);
      let steerId = "";
      const run = daemon(scriptedAcp({ advertise: agentType, turnStartDelayMs: 300,
        prompts: [{ chunks: ["English draft. "], hold: "steer", answer: "中文结论" }] }, logPath, agentType, () => {}, {
        beforeFirstPrompt: async () => {
          steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id;
          // The push reaches the run's feed before the prompt goes out.
          await Bun.sleep(150);
        },
      }));
      await run.start();

      expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
      const frames = agentFrames(logPath);
      expect(frames.filter((frame) => frame.kind === "overlap")).toEqual([]);
      expect(frames.filter((frame) => frame.method === "session/prompt")).toHaveLength(1);
      const registered = frames.find((frame) => frame.kind === "turn_registered")!;
      const steering = frames.filter((frame) => frame.method === "_session/steering");
      expect(steering).toHaveLength(1);
      expect(steering[0]!.at).toBeGreaterThanOrEqual(registered.at);
      expect(steerResults(run, task.id)).toEqual([[steerId, NATIVE]]);
      expect(store.getTaskSteerMessage(steerId)?.consumedAt).toBeTruthy();
    });
  }

  it("a wrap-up behind a steer the provider still holds starts its grace at once", async () => {
    const { store, task, daemon } = await steerBed("native-force-behind-held", "Build everything");
    const turn = store.listTurns({ workspace_id: "local" }).find((value) => value.current_attempt_id === task.id)!;
    const prompts: string[] = [];
    const held = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let steerId = "";
    let wrapUpAt = 0;
    let calls = 0;
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        signal = options?.signal;
        options?.onPromptStarted?.();
        yield chunk("Still building.");
        steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "also run the linter" }).id;
        await held.promise;
        wrapUpAt = Date.now();
        store.wrapUpTurn(turn.id);
        while (!options?.signal?.aborted) await Bun.sleep(20);
        throw new Error("Cancelled");
      },
      // Held behind a running tool call that never ends; answers when the round is cancelled.
      steer() {
        calls++;
        held.resolve();
        return new Promise<SteerResult>((resolve) => {
          signal!.addEventListener("abort", () => resolve({ outcome: "promptRequired", reason: "noActivePrompt" }), { once: true });
        });
      },
      getLastResponse: () => response("sess-force-behind-held"),
    }), { forceAnswerGraceMs: 600 });
    await run.start();
    const finishedAt = Date.now();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "Still building." });
    expect(prompts).toHaveLength(1);
    expect(calls).toBe(1);
    expect(finishedAt - wrapUpAt).toBeGreaterThanOrEqual(550);
    expect(finishedAt - wrapUpAt).toBeLessThan(5_000);
    expect(steerResults(run, task.id)).toEqual([
      [steerId, { via: "none", native_outcome: "promptRequired", error: null }],
      [expect.stringMatching(/^wrap_up:/), { via: "none", native_outcome: null, error: null }],
    ]);
  });

  it("a steer while a person-facing request is open goes through interrupt + re-prompt", async () => {
    const { store, task, daemon } = await steerBed("native-user-input", "Write it");
    const prompts: string[] = [];
    const aborted: boolean[] = [];
    let steerId = "";
    const run = daemon(() => ({
      async *sendStream(message, options) {
        prompts.push(message);
        options?.onPromptStarted?.();
        if (prompts.length === 1) {
          yield chunk("Waiting for approval. ");
          steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "use the staging bucket" }).id;
          while (!options?.signal?.aborted) await Bun.sleep(10);
          aborted.push(true);
          throw new Error("Cancelled");
        }
        yield chunk("Used staging.");
      },
      async steer() {
        return { outcome: "promptRequired", reason: "userInputPending" };
      },
      getLastResponse: () => response("sess-user-input"),
    }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "Used staging." });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("use the staging bucket");
    expect(aborted).toEqual([true]);
    expect(steerResults(run, task.id)).toEqual([[steerId,
      { via: "reprompt", native_outcome: "promptRequired", error: "userInputPending" }]]);
  });

  it("real ACP provider: a Claude tool call past the wait cap falls back to interrupt + re-prompt", async () => {
    const { store, task, daemon } = await steerBed("native-acp-tool-cap", "Run the endless command");
    const logPath = join(workDir!, "agent-tool-cap.jsonl");
    let steerId = "";
    const run = daemon(scriptedAcp({ advertise: "claude",
      prompts: [{ chunks: ["Running it. "], tool: { ms: null }, hold: "cancel" }, { chunks: ["中文结论"] }] }, logPath, "claude",
      () => { steerId = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" }).id; },
      { providerOptions: { toolCallWaitMs: 300 } }));
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "中文结论" });
    const frames = agentFrames(logPath);
    expect(frames.filter((frame) => frame.kind === "overlap")).toEqual([]);
    expect(frames.filter((frame) => frame.method === "_session/steering")).toHaveLength(0);
    expect(frames.filter((frame) => frame.method === "session/cancel")).toHaveLength(1);
    const prompts = frames.filter((frame) => frame.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.params!.prompt[0].text).toContain("改用中文输出");
    expect(steerResults(run, task.id)).toEqual([[steerId,
      { via: "reprompt", native_outcome: "promptRequired", error: "toolCallRunning" }]]);
  });

  it("force-answer expiry acknowledges a still-pending injected steer with one that arrived during the cancel", async () => {
    const { store, task, daemon } = await steerBed("native-force-gap", "Research deeply");
    const turn = store.listTurns({ workspace_id: "local" }).find((value) => value.current_attempt_id === task.id)!;
    const steers: string[] = [];
    const firstInjected = Promise.withResolvers<void>();
    let s1 = "";
    let s2 = "";
    const run = daemon(() => ({
      async *sendStream(message, options) {
        options?.onPromptStarted?.();
        yield chunk("Partial findings. ");
        s1 = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "also check b.ts" }).id;
        await firstInjected.promise;
        store.wrapUpTurn(turn.id);
        yield chunk("Still exploring…");
        while (!options?.signal?.aborted) await Bun.sleep(20);
        // S2 arrives while the expired round is being cancelled; S1 is still unacknowledged.
        s2 = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "one more thing" }).id;
        await Bun.sleep(200);
        throw new Error("Cancelled");
      },
      async steer(text) {
        steers.push(text);
        firstInjected.resolve();
        return { outcome: "injected" };
      },
      getLastResponse: () => response("sess-force-gap"),
    }), { forceAnswerGraceMs: 500 });
    await run.start();

    expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "Still exploring…" });
    expect(steers).toHaveLength(2);
    expect(store.getTaskSteerMessage(s1)?.consumedAt).toBeTruthy();
    expect(store.getTaskSteerMessage(s2)?.consumedAt).toBeTruthy();
    expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
    expect(steerResults(run, task.id)).toEqual([
      [s1, NATIVE],
      [expect.stringMatching(/^wrap_up:/), NATIVE],
      [s2, { via: "none", native_outcome: null, error: null }],
    ]);
  });
});
