// Mid-run steering e2e against a fake ACP provider: a steer message posted
// while a turn is streaming soft-interrupts it and is injected as the next
// prompt on the same provider session; force_answer additionally arms a grace
// deadline after which the run completes with the output produced so far.
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResponse, SendOptions } from "@shared/contracts/provider-types.js";
import { startMultiremiServer } from "../fixtures/daemon-protocol.js";
import type { MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";

let db: Database | null = null;
let workDir: string | null = null;
let activeDaemon: MultiremiDaemon | null = null;
const activeServers = new Set<{ stop(closeActiveConnections?: boolean): unknown }>();

afterEach(async () => {
  await activeDaemon?.stopAndDrainTestWork();
  activeDaemon = null;
  for (const server of activeServers) server.stop(true);
  activeServers.clear();
  db?.close();
  db = null;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

function testBed(prefix: string): { store: MultiremiStore; root: string } {
  db = openSqliteDatabase(":memory:");
  workDir = mkdtempSync(join(tmpdir(), prefix));
  return { store: new MultiremiStore(db), root: workDir };
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

describe("Bun Multiremi daemon steering", () => {
  it("injects a mid-run steer into the same provider session and completes", async () => {
    const { store, root } = testBed("multiremi-daemon-steer-");
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
      expect(daemon.traceStore().read(task.id).events).toContainEqual(expect.objectContaining({ type: "text", content: "English draft. " }));

      // The injected prompt carries the user's directive on the same session.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("改用中文输出");
      expect(prompts[1]).toContain("Mid-run user steering");
      expect(sendOptions[1]?.sessionId).toBe("sess-steer");

      // Consumed server-side, and auditable in the run's message stream.
      expect(steerId).toBeTruthy();
      expect(store.getTaskSteerMessage(steerId!)?.consumedAt).toBeTruthy();
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
      const steerMessages = daemon.traceStore().read(task.id).events.filter((m) => m.type === "steer");
      expect(steerMessages).toHaveLength(1);
      expect(steerMessages[0]?.content).toBe("改用中文输出");
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });

  it("a steer accepted just before natural turn end is injected, not stranded", async () => {
    const { store, root } = testBed("multiremi-daemon-steer-late-");
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
      expect(daemon.traceStore().read(task.id).events).toContainEqual(expect.objectContaining({ type: "text", content: "old answer. " }));
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
    const { store, root } = testBed("multiremi-steer-completion-rpc-");
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
      expect(daemon.traceStore().read(task.id).events).toContainEqual(expect.objectContaining({ type: "text", content: "draft. " }));
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
    const { store, root } = testBed("multiremi-daemon-steer-duppoll-");
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
          await Bun.sleep(450);
          return;
        }
        yield chunk("中文结论");
        const replay = setTimeout(() => {
          const session = layer.registry.sessionForRuntime(runtimeId);
          if (session instanceof DaemonProtocolSession) session.sendEvent({ t: "task.steer", rt: runtimeId,
            p: { task_id: task.id, steer: store.getTaskSteerMessage(steerId)! } });
        }, 200);
        // Keep turn 2 running while the stale push lands. Like the
        // real ACP provider, an abort cancels the turn — a duplicate-triggered
        // interrupt here is exactly the bug this test guards against.
        const deadline = Date.now() + 900;
        try {
          while (Date.now() < deadline) {
            if (options?.signal?.aborted) throw new Error("Cancelled");
            await Bun.sleep(20);
          }
        } finally { clearTimeout(replay); }
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
        protocolClientOptions: { onFrame: frame => { if (frame.type === "task.steer") steerPushes++; } },
        providerFactory,
      });
      await daemon.start();

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("中文结论");
      expect(daemon.traceStore().read(task.id).events).toContainEqual(expect.objectContaining({ type: "text", content: "english draft. " }));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("改用中文输出");
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
      expect(steerPushes).toBeGreaterThanOrEqual(2);
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });

  it("force answer wraps up within the grace window even if the agent keeps going", async () => {
    const { store, root } = testBed("multiremi-daemon-force-answer-");
    const agent = store.createAgent({ name: "Force Agent", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Research deeply" });
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
          store.createTaskSteerMessage({ taskId: task.id, kind: "force_answer", content: "先给结论" });
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
      expect(daemon.traceStore().read(task.id).events).toContainEqual(expect.objectContaining({ type: "text", content: "Partial findings. " }));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Deliver now");
      expect(prompts[1]).toContain("先给结论");
    } finally {
      await activeDaemon?.stopAndDrainTestWork();
      server.stop(true);
    }
  });

  it("cancel still cancels: no steer, no resurrection of the run", async () => {
    const { store, root } = testBed("multiremi-daemon-steer-cancel-");
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
