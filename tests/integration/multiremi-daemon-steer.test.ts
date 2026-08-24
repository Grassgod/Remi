// Mid-run steering e2e against a fake ACP provider: a steer message posted
// while a turn is streaming soft-interrupts it and is injected as the next
// prompt on the same provider session; force_answer additionally arms a grace
// deadline after which the run completes with the output produced so far.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResponse, SendOptions } from "@shared/contracts/provider-types.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon, type MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";

let db: Database | null = null;
let workDir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

function testBed(prefix: string): { store: MultiremiStore; root: string } {
  db = new Database(":memory:");
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
    const agent = store.createAgent({ name: "Steer Agent", provider: "claude", cwd: root });
    const task = store.createTask({ agentId: agent.id, prompt: "Write the summary in English" });
    const daemonToken = await store.createAccessToken({ name: "Steer daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer", "claude");
    store.registerRuntime({ id: runtimeId, name: "steer-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-steer", hostname: "127.0.0.1", port: 0 });

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
      const daemon = new MultiremiDaemon({
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
      // Output from before the steer survives; the steered turn appends.
      expect(completed.result).toBe("English draft. 中文结论");

      // The injected prompt carries the user's directive on the same session.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("改用中文输出");
      expect(prompts[1]).toContain("Mid-run user steering");
      expect(sendOptions[1]?.sessionId).toBe("sess-steer");

      // Consumed server-side, and auditable in the run's message stream.
      expect(steerId).toBeTruthy();
      expect(store.getTaskSteerMessage(steerId!)?.consumedAt).toBeTruthy();
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
      const steerMessages = store.listTaskMessages(task.id).filter((m) => m.type === "steer");
      expect(steerMessages).toHaveLength(1);
      expect(steerMessages[0]?.content).toBe("改用中文输出");
    } finally {
      server.stop();
    }
  });

  it("a steer accepted just before natural turn end is injected, not stranded", async () => {
    const { store, root } = testBed("multiremi-daemon-steer-late-");
    const agent = store.createAgent({ name: "Late Steer Agent", provider: "claude", cwd: root });
    const task = store.createTask({ agentId: agent.id, prompt: "Answer briefly" });
    const daemonToken = await store.createAccessToken({ name: "Late steer daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer-late", "claude");
    store.registerRuntime({ id: runtimeId, name: "late-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-late", hostname: "127.0.0.1", port: 0 });

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
      const daemon = new MultiremiDaemon({
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
      expect(completed.result).toBe("old answer. 中文结论");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("改用中文输出");
      expect(steerId).toBeTruthy();
      expect(store.getTaskSteerMessage(steerId!)?.consumedAt).toBeTruthy();
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  it("a delayed feed poll returning an already-handled steer does not cancel the next turn", async () => {
    const { store, root } = testBed("multiremi-daemon-steer-duppoll-");
    const agent = store.createAgent({ name: "Dup Poll Agent", provider: "claude", cwd: root });
    const task = store.createTask({ agentId: agent.id, prompt: "Answer in English" });
    const daemonToken = await store.createAccessToken({ name: "Dup poll daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer-duppoll", "claude");
    store.registerRuntime({ id: runtimeId, name: "duppoll-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-dup", hostname: "127.0.0.1", port: 0 });

    // Proxy that snapshots upstream responses immediately but delays delivery
    // of the second pending-steer GET (the feed poll that observed the steer
    // before the authoritative final fetch consumed it) until mid-turn-2.
    let steerGets = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const upstream = await fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        });
        const body = await upstream.arrayBuffer();
        if (request.method === "GET" && /^\/api\/daemon\/tasks\/[^/]+\/steer$/.test(url.pathname)) {
          steerGets += 1;
          if (steerGets === 2) await Bun.sleep(900);
        }
        return new Response(body, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" } });
      },
    });

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
          store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" });
          // Stay in the turn long enough for the 250ms feed tick to issue the
          // GET the proxy will hold, then end naturally — the authoritative
          // final fetch handles the steer first.
          await Bun.sleep(450);
          return;
        }
        yield chunk("中文结论");
        // Keep turn 2 running while the stale poll response lands. Like the
        // real ACP provider, an abort cancels the turn — a duplicate-triggered
        // interrupt here is exactly the bug this test guards against.
        const deadline = Date.now() + 900;
        while (Date.now() < deadline) {
          if (options?.signal?.aborted) throw new Error("Cancelled");
          await Bun.sleep(20);
        }
      },
      getLastResponse: () => response,
    });

    try {
      const daemon = new MultiremiDaemon({
        serverUrl: `http://127.0.0.1:${proxy.port}`,
        token: daemonToken.token,
        daemonId: "daemon-steer-duppoll",
        runtimeName: "duppoll-runtime",
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
      expect(completed.result).toBe("english draft. 中文结论");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("改用中文输出");
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
      // The held poll really did observe the steer before consumption.
      expect(steerGets).toBeGreaterThanOrEqual(2);
    } finally {
      proxy.stop(true);
      server.stop();
    }
  });

  it("force answer wraps up within the grace window even if the agent keeps going", async () => {
    const { store, root } = testBed("multiremi-daemon-force-answer-");
    const agent = store.createAgent({ name: "Force Agent", provider: "claude", cwd: root });
    const task = store.createTask({ agentId: agent.id, prompt: "Research deeply" });
    const daemonToken = await store.createAccessToken({ name: "Force daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-force", "claude");
    store.registerRuntime({ id: runtimeId, name: "force-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-force", hostname: "127.0.0.1", port: 0 });

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
      const daemon = new MultiremiDaemon({
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
      expect(completed.result).toBe("Partial findings. Still exploring…");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Deliver now");
      expect(prompts[1]).toContain("先给结论");
    } finally {
      server.stop();
    }
  });

  it("cancel still cancels: no steer, no resurrection of the run", async () => {
    const { store, root } = testBed("multiremi-daemon-steer-cancel-");
    const agent = store.createAgent({ name: "Cancel Agent", provider: "claude", cwd: root });
    const task = store.createTask({ agentId: agent.id, prompt: "Long run" });
    const daemonToken = await store.createAccessToken({ name: "Cancel daemon", type: "daemon", workspaceId: "local" });
    const runtimeId = daemonRuntimeIdForTest("daemon-steer-cancel", "claude");
    store.registerRuntime({ id: runtimeId, name: "cancel-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-cancel", hostname: "127.0.0.1", port: 0 });

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
      const daemon = new MultiremiDaemon({
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
      server.stop();
    }
  });
});
