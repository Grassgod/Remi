// MUL-74 / MUL-197 end-to-end: a real server + worker daemon + fake provider.
// Covers: drain pauses new claims while heartbeats continue and ack the
// generation; an already-claimed task keeps running through a drain; a 10-30s
// API outage mid-stream neither kills the provider session nor loses/reorders
// messages; release restores claiming.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResponse } from "@shared/contracts/provider-types.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon, type MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";

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

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface StreamGate {
  yielded: Promise<void>;
  release: () => void;
}

function gate(): StreamGate {
  let release!: () => void;
  const yielded = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { yielded, release };
}

type ApiProxyInterceptor = (request: Request, url: URL) => Response | null | Promise<Response | null>;

function apiProxy(
  serverPort: number | undefined,
  intercept: ApiProxyInterceptor,
): ReturnType<typeof Bun.serve> {
  if (serverPort === undefined) throw new Error("test server did not bind a port");
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const intercepted = await intercept(request, url);
      if (intercepted) return intercepted;
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
      return await fetch(`http://127.0.0.1:${serverPort}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body !== undefined ? { body } : {}),
      });
    },
  });
}

function taskReportOutageProxy(serverPort: number | undefined): ReturnType<typeof Bun.serve> {
  return apiProxy(serverPort, (request, url) => {
    if (request.method === "POST" && url.pathname.startsWith("/api/daemon/tasks/")) {
      return new Response("report API unavailable", { status: 503 });
    }
    return null;
  });
}

const RESPONSE: AgentResponse = {
  text: "",
  sessionId: "sess-drain",
  requestId: "req-drain",
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  model: "claude-test",
};

describe("MUL-74 / MUL-197 drain + outbox end to end", () => {
  it("pauses claims while draining, acks the generation over heartbeats, and resumes on release", async () => {
    const { store, root } = testBed("multiremi-drain-claims-");
    const agent = store.createAgent({ name: "Drain Claim Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "wait out the drain" });
    const daemonToken = await store.createAccessToken({ name: "drain daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-drain-secret", hostname: "127.0.0.1", port: 0 });

    // Drain is active BEFORE the daemon comes online.
    store.beginPlatformDrain({ operationId: "pop_e2e", reason: "e2e", ttlMs: 120_000 });

    let ran = false;
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream() {
        ran = true;
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "done" }] } as any;
      },
      getLastResponse: () => RESPONSE,
      close: async () => {},
    });

    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      daemonId: "daemon-drain-claims",
      provider: "claude",
      workspaceId: "local",
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath: join(root, "outbox.db"),
      outboxBackoffMs: [20, 20],
      providerFactory,
    });
    const run = daemon.start().catch(() => {});
    try {
      // The daemon heartbeats, acks the drain generation, and does NOT claim.
      await until(() => store.getPlatformDrainStatus().ackedDaemons === 1, 5_000, "drain ack");
      await Bun.sleep(150);
      expect(store.getTask(task.id)?.status).toBe("queued");
      expect(ran).toBe(false);
      // All daemons acked and nothing is in flight: the switch gate is open.
      expect(store.getPlatformDrainStatus()).toMatchObject({ activeTasks: 0, ready: true });

      // Release restores claiming without a daemon restart.
      store.releasePlatformDrain("pop_e2e");
      await until(() => store.getTask(task.id)?.status === "completed", 8_000, "post-release completion");
      expect(ran).toBe(true);
    } finally {
      daemon.stop();
      await run;
      server.stop(true);
    }
  }, 15_000);

  it("lets an already-claimed task run to completion while a drain waits for it", async () => {
    const { store, root } = testBed("multiremi-drain-running-");
    const agent = store.createAgent({ name: "Drain Run Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "keep running through the drain" });
    const daemonToken = await store.createAccessToken({ name: "drain-run daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-drain-run-secret", hostname: "127.0.0.1", port: 0 });

    const firstChunk = gate();
    const finish = gate();
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream() {
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "started " }] } as any;
        firstChunk.release();
        await finish.yielded;
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "and finished" }] } as any;
      },
      getLastResponse: () => RESPONSE,
      close: async () => {},
    });

    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      daemonId: "daemon-drain-running",
      provider: "claude",
      workspaceId: "local",
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath: join(root, "outbox.db"),
      outboxBackoffMs: [20, 20],
      providerFactory,
    });
    const run = daemon.start().catch(() => {});
    try {
      await firstChunk.yielded;
      // The start report travels through the outbox, so "running" lands async.
      await until(() => store.getTask(task.id)?.status === "running", 5_000, "task running");

      // Drain begins mid-task: the daemon acks but the gate stays closed while
      // the task is in flight, and the task is NOT interrupted.
      store.beginPlatformDrain({ operationId: "pop_running", ttlMs: 120_000 });
      await until(() => store.getPlatformDrainStatus().ackedDaemons === 1, 8_000, "drain ack");
      expect(store.getPlatformDrainStatus()).toMatchObject({ activeTasks: 1, ready: false });
      await Bun.sleep(100);
      expect(store.getTask(task.id)?.status).toBe("running");

      finish.release();
      await until(() => store.getTask(task.id)?.status === "completed", 8_000, "completion during drain");
      expect(store.getTask(task.id)?.result).toBe("started and finished");
      // With the task finished, the drain gate opens.
      await until(() => store.getPlatformDrainStatus().ready, 5_000, "drain ready");
      store.releasePlatformDrain("pop_running");
    } finally {
      daemon.stop();
      await run;
      server.stop(true);
    }
  }, 20_000);

  it("keeps pre-terminal report drain active so a CLI update remains blocked", async () => {
    const { store, root } = testBed("multiremi-preterminal-active-");
    const agent = store.createAgent({ name: "Pre-terminal Active Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "finish after reports catch up" });
    const daemonToken = await store.createAccessToken({ name: "pre-terminal daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-preterminal-secret", hostname: "127.0.0.1", port: 0 });
    let rejectMessages = true;
    let messageAttempts = 0;
    const proxy = apiProxy(server.port, (request, url) => {
      if (request.method === "POST" && url.pathname === `/api/daemon/tasks/${task.id}/messages`) {
        messageAttempts++;
        if (rejectMessages) return new Response("messages unavailable", { status: 503 });
      }
      return null;
    });
    const outboxPath = join(root, "outbox.db");
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      daemonId: "daemon-preterminal-active",
      provider: "claude",
      workspaceId: "local",
      once: true,
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath,
      outboxBackoffMs: [100],
      taskDrainTimeoutMs: 5_000,
      providerFactory: () => ({
        async *sendStream() {
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "finished" }] } as any;
        },
        getLastResponse: () => RESPONSE,
        close: async () => {},
      }),
    });
    const daemonRun = daemon.start();
    try {
      await until(() => messageAttempts > 0, 5_000, "pre-terminal message delivery attempt");
      const state = daemon as unknown as {
        activeTaskCount: number;
        drainingTaskCount: number;
        tryPauseClaimsForUpdate(scope: "cli"): { ok: boolean; error?: string };
      };
      expect(state.activeTaskCount).toBe(1);
      expect(state.drainingTaskCount).toBe(0);
      expect(state.tryPauseClaimsForUpdate("cli")).toEqual({
        ok: false,
        error: "daemon is busy; retry update when idle",
      });

      rejectMessages = false;
      await daemonRun;
      expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "finished" });
    } finally {
      daemon.stop();
      await daemonRun.catch(() => {});
      proxy.stop(true);
      server.stop(true);
    }
  }, 10_000);

  it("purges stale reports after their task reaches a terminal state", async () => {
    const { store, root } = testBed("multiremi-terminal-report-purge-");
    const agent = store.createAgent({ name: "Terminal Purge Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "finish despite stale transcript reports" });
    const daemonToken = await store.createAccessToken({ name: "terminal purge daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-terminal-purge-secret", hostname: "127.0.0.1", port: 0 });
    const proxy = apiProxy(server.port, (request, url) => {
      if (request.method === "POST" && url.pathname === `/api/daemon/tasks/${task.id}/messages`) {
        return new Response("messages unavailable", { status: 503 });
      }
      return null;
    });
    const outboxPath = join(root, "outbox.db");
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      daemonId: "daemon-terminal-report-purge",
      provider: "claude",
      workspaceId: "local",
      once: true,
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath,
      outboxBackoffMs: [20],
      taskDrainTimeoutMs: 50,
      providerFactory: () => ({
        async *sendStream() {
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "done" }] } as any;
        },
        getLastResponse: () => RESPONSE,
        close: async () => {},
      }),
    });
    try {
      await daemon.start();

      expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "done" });
      const persisted = new MultiremiTaskReportOutbox({ path: outboxPath, deliver: async () => {} });
      expect(persisted.stats()).toMatchObject({ pending: 0, pendingTasks: 0 });
      await persisted.close();
    } finally {
      daemon.stop();
      proxy.stop(true);
      server.stop(true);
    }
  }, 10_000);

  it("survives an API outage mid-stream: provider session lives on, messages land in order", async () => {
    const { store, root } = testBed("multiremi-outage-");
    const agent = store.createAgent({ name: "Outage Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "stream through the outage" });
    const daemonToken = await store.createAccessToken({ name: "outage daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-outage-secret", hostname: "127.0.0.1", port: 0 });

    // Reverse proxy that can simulate the API container being replaced.
    let apiDown = false;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (apiDown) return new Response("upstream restarting", { status: 503 });
        const url = new URL(request.url);
        const body = request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
        return await fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(body !== undefined ? { body } : {}),
        });
      },
    });

    let providerClosedDuringOutage = false;
    let streamCompleted = false;
    const providerFactory: MultiremiDaemonProviderFactory = () => {
      let closed = false;
      return {
        async *sendStream() {
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "before " }] } as any;
          // The API "container" goes away mid-session (simulates the update
          // window). Reports fail with 503 and must be queued, not thrown.
          apiDown = true;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "during " }] } as any;
          yield { sessionUpdate: "tool_call", title: "Read", rawInput: "{\"path\":\"x\"}", rawOutput: { ok: true } } as any;
          // Several outbox retry cycles elapse while the API is down.
          await Bun.sleep(250);
          providerClosedDuringOutage = closed;
          apiDown = false;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "after" }] } as any;
          streamCompleted = true;
        },
        getLastResponse: () => RESPONSE,
        close: async () => {
          closed = true;
        },
      };
    };

    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      daemonId: "daemon-outage",
      provider: "claude",
      workspaceId: "local",
      once: true,
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath: join(root, "outbox.db"),
      outboxBackoffMs: [30, 30, 60],
      providerFactory,
    });
    try {
      await daemon.start();

      // The stream ran to its natural end and was never torn down mid-outage.
      expect(streamCompleted).toBe(true);
      expect(providerClosedDuringOutage).toBe(false);

      const completed = store.getTask(task.id)!;
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("before during after");

      // Replayed messages arrive complete and in the original seq order.
      const messages = store.listTaskMessages(task.id);
      expect(messages.map((message) => [message.seq, message.type, message.content ?? ""])).toEqual([
        [1, "text", "before during "],
        [2, "tool_use", ""],
        [3, "tool_result", ""],
        [4, "text", "after"],
      ]);
    } finally {
      daemon.stop();
      proxy.stop(true);
      server.stop(true);
    }
  }, 20_000);

  it("purges queued reports and releases active execution when the server cancels a task", async () => {
    const { store, root } = testBed("multiremi-outbox-cancel-");
    const agent = store.createAgent({ name: "Cancelled Outbox Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "wait to be cancelled" });
    const daemonToken = await store.createAccessToken({ name: "cancel daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-cancel-secret", hostname: "127.0.0.1", port: 0 });

    // Keep task status reads and claims available while every task report is
    // rejected transiently, creating the historical backlog from the incident.
    const proxy = taskReportOutageProxy(server.port);

    const providerStarted = gate();
    const providerFactory: MultiremiDaemonProviderFactory = () => ({
      async *sendStream(_message, options) {
        providerStarted.release();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("Cancelled");
      },
      getLastResponse: () => null,
      close: async () => {},
    });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      daemonId: "daemon-outbox-cancel",
      provider: "claude",
      workspaceId: "local",
      once: true,
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath: join(root, "outbox.db"),
      outboxBackoffMs: [60_000],
      taskDrainTimeoutMs: 500,
      providerFactory,
    });
    const daemonRun = daemon.start();
    try {
      await providerStarted.yielded;
      expect((daemon as unknown as { activeTaskCount: number }).activeTaskCount).toBe(1);
      expect(daemon.outboxStats()?.pendingNonTerminal).toBeGreaterThan(0);

      store.cancelTask(task.id);
      await until(
        () => (daemon as unknown as { activeTaskCount: number }).activeTaskCount === 0,
        5_000,
        "cancelled task execution release",
      );
      await daemonRun;
      expect(store.getTask(task.id)?.status).toBe("cancelled");
      const persisted = new MultiremiTaskReportOutbox({
        path: join(root, "outbox.db"),
        deliver: async () => {},
      });
      expect(persisted.stats()).toMatchObject({ pending: 0, pendingTasks: 0 });
      await persisted.close();
    } finally {
      daemon.stop();
      await daemonRun.catch(() => {});
      proxy.stop(true);
      server.stop(true);
    }
  }, 10_000);

  it("requires a second status check before a transient watcher 404 can purge reports", async () => {
    const { store, root } = testBed("multiremi-outbox-transient-404-");
    const agent = store.createAgent({ name: "Transient 404 Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "survive one missing response" });
    const daemonToken = await store.createAccessToken({ name: "transient 404 daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-transient-404-secret", hostname: "127.0.0.1", port: 0 });
    let returnMissingOnce = true;
    let statusReads = 0;
    const proxy = apiProxy(server.port, (request, url) => {
      if (request.method === "GET" && url.pathname === `/api/daemon/tasks/${task.id}/status`) {
        statusReads++;
        if (returnMissingOnce) {
          returnMissingOnce = false;
          return new Response("task temporarily not routed", { status: 404 });
        }
      }
      return null;
    });
    const providerStarted = gate();
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      daemonId: "daemon-transient-404",
      provider: "claude",
      workspaceId: "local",
      once: true,
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath: join(root, "outbox.db"),
      outboxBackoffMs: [20],
      providerFactory: () => ({
        async *sendStream(_message, options) {
          providerStarted.release();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("provider interrupted after transient 404");
        },
        getLastResponse: () => null,
        close: async () => {},
      }),
    });
    const daemonRun = daemon.start();
    try {
      await providerStarted.yielded;
      await daemonRun;
      expect(statusReads).toBeGreaterThanOrEqual(2);
      expect(store.getTask(task.id)).toMatchObject({
        status: "failed",
        error: "provider interrupted after transient 404",
      });
      const persisted = new MultiremiTaskReportOutbox({
        path: join(root, "outbox.db"),
        deliver: async () => {},
      });
      expect(persisted.stats()).toMatchObject({ pending: 0, pendingTasks: 0 });
      await persisted.close();
    } finally {
      daemon.stop();
      await daemonRun.catch(() => {});
      proxy.stop(true);
      server.stop(true);
    }
  }, 10_000);

  it("reconciles missing historical tasks before replay and reaches ready without draining them", async () => {
    const { store, root } = testBed("multiremi-outbox-restart-");
    const outboxPath = join(root, "outbox.db");
    const historical = new MultiremiTaskReportOutbox({
      path: outboxPath,
      backoffScheduleMs: [60_000],
      deliver: async () => { throw new Error("old API unavailable"); },
    });
    for (let index = 0; index < 100; index += 1) {
      historical.enqueue("tsk_deleted_history", "messages", {
        messages: [{ seq: index + 1, type: "text", content: `old-${index}` }],
      });
    }
    await Bun.sleep(20);
    await historical.close();

    const daemonToken = await store.createAccessToken({ name: "restart daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-restart-secret", hostname: "127.0.0.1", port: 0 });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`,
      token: daemonToken.token,
      daemonId: "daemon-outbox-restart",
      provider: "claude",
      workspaceId: "local",
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath,
      outboxBackoffMs: [60_000],
      outboxStartupFlushTimeoutMs: 5_000,
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
      }),
    });
    const daemonRun = daemon.start();
    try {
      await until(async () => {
        const port = daemon.localPort();
        if (!port) return false;
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()) as {
          status?: string;
          outbox?: { pending?: number; pendingTasks?: number };
        };
        return health.status === "running" && health.outbox?.pending === 0 && health.outbox.pendingTasks === 0;
      }, 5_000, "daemon ready after historical outbox reconciliation");
      expect(daemon.outboxStats()).toMatchObject({ pending: 0, pendingTasks: 0 });
    } finally {
      daemon.stop();
      await daemonRun.catch(() => {});
      server.stop(true);
    }
  }, 10_000);

  it("moves a finished agent into bounded drain accounting without losing its terminal report", async () => {
    const { store, root } = testBed("multiremi-outbox-drain-accounting-");
    const agent = store.createAgent({ name: "Drain Accounting Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "finish while reports are offline" });
    const daemonToken = await store.createAccessToken({ name: "drain accounting daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-drain-accounting-secret", hostname: "127.0.0.1", port: 0 });
    const proxy = taskReportOutageProxy(server.port);
    const outboxPath = join(root, "outbox.db");
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      daemonId: "daemon-outbox-drain-accounting",
      provider: "claude",
      workspaceId: "local",
      once: true,
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath,
      outboxBackoffMs: [60_000],
      taskDrainTimeoutMs: 250,
      providerFactory: () => ({
        async *sendStream() {
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "done" }] } as any;
        },
        getLastResponse: () => RESPONSE,
        close: async () => {},
      }),
    });
    const daemonRun = daemon.start();
    try {
      await until(() => {
        const state = daemon as unknown as { activeTaskCount: number; drainingTaskCount: number };
        return state.activeTaskCount === 0 && state.drainingTaskCount === 1;
      }, 5_000, "task report drain accounting");
      expect((daemon as unknown as { activeTaskCount: number }).activeTaskCount).toBe(0);
      const health = await fetch(`http://127.0.0.1:${daemon.localPort()}/health`).then((response) => response.json()) as {
        active_task_count?: number;
        draining_task_count?: number;
        outbox?: { pendingNonTerminal?: number; pendingTasks?: number };
      };
      expect(health).toMatchObject({
        active_task_count: 0,
        draining_task_count: 1,
        outbox: {
          pendingNonTerminal: expect.any(Number),
          pendingTasks: 1,
        },
      });

      await daemonRun;
      const persisted = new MultiremiTaskReportOutbox({ path: outboxPath, deliver: async () => {} });
      expect(persisted.stats()).toMatchObject({
        pendingTerminal: 1,
        pendingNonTerminal: expect.any(Number),
        pendingTasks: 1,
      });
      expect(persisted.stats().pendingNonTerminal).toBeGreaterThan(0);
      expect(persisted.taskIdsWithPendingTerminal()).toEqual([task.id]);
      await persisted.close();
    } finally {
      daemon.stop();
      await daemonRun.catch(() => {});
      proxy.stop(true);
      server.stop(true);
    }
  }, 10_000);

  it("delivers a persisted terminal result before orphan recovery despite the history timeout", async () => {
    const { store, root } = testBed("multiremi-outbox-terminal-replay-");
    const daemonId = "daemon-terminal-replay";
    const runtime = store.registerRuntime({
      id: "rt_terminal_replay",
      name: "Terminal replay runtime",
      provider: "claude",
      daemonId,
      workspaceId: "local",
      ownerId: "local",
    });
    const agent = store.createAgent({ name: "Terminal Replay Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "already finished locally" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    const outboxPath = join(root, "outbox.db");
    const historical = new MultiremiTaskReportOutbox({
      path: outboxPath,
      backoffScheduleMs: [60_000],
      deliver: async () => { throw new Error("old API unavailable"); },
    });
    historical.enqueue(task.id, "messages", {
      messages: [{ seq: 1, type: "text", content: "last buffered message" }],
    });
    historical.enqueue(task.id, "complete", {
      output: "replayed completion",
      sessionId: "sess-terminal-replay",
      workDir: root,
    });
    await Bun.sleep(20);
    await historical.close();

    const daemonToken = await store.createAccessToken({
      name: "terminal replay daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId,
    });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-terminal-replay-secret", hostname: "127.0.0.1", port: 0 });
    let delayedMessages = 0;
    const proxy = apiProxy(server.port, async (request, url) => {
      if (request.method === "POST" && url.pathname === `/api/daemon/tasks/${task.id}/messages`) {
        delayedMessages++;
        await Bun.sleep(300);
      }
      return null;
    });
    store.beginPlatformDrain({ operationId: "pop_terminal_replay", ttlMs: 120_000 });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      runtimeId: runtime.id,
      daemonId,
      provider: "claude",
      workspaceId: "local",
      once: true,
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath,
      outboxBackoffMs: [20],
      outboxStartupFlushTimeoutMs: 50,
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
      }),
    });
    try {
      await daemon.start();
      expect(delayedMessages).toBe(1);
      expect(store.getTask(task.id)).toMatchObject({
        status: "completed",
        result: "replayed completion",
      });
      expect(store.listTasks().filter((candidate) => candidate.parentTaskId === task.id)).toHaveLength(0);
      const persisted = new MultiremiTaskReportOutbox({ path: outboxPath, deliver: async () => {} });
      expect(persisted.stats()).toMatchObject({ pending: 0, pendingTerminal: 0, pendingTasks: 0 });
      await persisted.close();
    } finally {
      daemon.stop();
      proxy.stop(true);
      server.stop(true);
    }
  }, 10_000);

  it("bounds startup replay while preserving reports for a non-terminal task", async () => {
    const { store, root } = testBed("multiremi-outbox-startup-timeout-");
    const agent = store.createAgent({ name: "Startup Replay Bot", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "stay queued during startup" });
    const outboxPath = join(root, "outbox.db");
    const historical = new MultiremiTaskReportOutbox({
      path: outboxPath,
      backoffScheduleMs: [60_000],
      deliver: async () => { throw new Error("old API unavailable"); },
    });
    historical.enqueue(task.id, "messages", {
      messages: [{ seq: 1, type: "text", content: "must survive" }],
    });
    await Bun.sleep(20);
    await historical.close();

    const daemonToken = await store.createAccessToken({ name: "startup timeout daemon", type: "daemon", workspaceId: "local" });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "root-startup-timeout-secret", hostname: "127.0.0.1", port: 0 });
    const proxy = taskReportOutageProxy(server.port);
    store.beginPlatformDrain({ operationId: "pop_startup_timeout", ttlMs: 120_000 });
    const daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${proxy.port}`,
      token: daemonToken.token,
      daemonId: "daemon-outbox-startup-timeout",
      provider: "claude",
      workspaceId: "local",
      pollIntervalMs: 25,
      daemonPort: 0,
      workspacesRoot: join(root, "workspaces"),
      repoCacheRoot: join(root, ".repo-cache"),
      outboxPath,
      outboxBackoffMs: [60_000],
      outboxStartupFlushTimeoutMs: 100,
      providerFactory: () => ({
        async *sendStream() {},
        getLastResponse: () => null,
      }),
    });
    const daemonRun = daemon.start();
    try {
      await until(async () => {
        const port = daemon.localPort();
        if (!port) return false;
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()) as {
          status?: string;
          outbox?: { pending?: number; pendingTasks?: number };
        };
        return health.status === "running" && health.outbox?.pending === 1 && health.outbox.pendingTasks === 1;
      }, 5_000, "daemon ready after bounded startup replay");
      expect(store.getTask(task.id)?.status).toBe("queued");
      expect(daemon.outboxStats()).toMatchObject({ pending: 1, pendingNonTerminal: 1, pendingTasks: 1 });
    } finally {
      daemon.stop();
      await daemonRun.catch(() => {});
      proxy.stop(true);
      server.stop(true);
    }
  }, 10_000);
});
