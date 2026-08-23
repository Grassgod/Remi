// MUL-74 end-to-end: a real server + a worker daemon with a fake provider.
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

async function until(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
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

const RESPONSE: AgentResponse = {
  text: "",
  sessionId: "sess-drain",
  requestId: "req-drain",
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  model: "claude-test",
};

describe("MUL-74 drain + outbox end to end", () => {
  it("pauses claims while draining, acks the generation over heartbeats, and resumes on release", async () => {
    const { store, root } = testBed("multiremi-drain-claims-");
    const agent = store.createAgent({ name: "Drain Claim Bot", provider: "claude", cwd: root });
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
    const agent = store.createAgent({ name: "Drain Run Bot", provider: "claude", cwd: root });
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

  it("survives an API outage mid-stream: provider session lives on, messages land in order", async () => {
    const { store, root } = testBed("multiremi-outage-");
    const agent = store.createAgent({ name: "Outage Bot", provider: "claude", cwd: root });
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
        [1, "text", "before "],
        [2, "text", "during "],
        [3, "tool_use", ""],
        [4, "tool_result", ""],
        [5, "text", "after"],
      ]);
    } finally {
      daemon.stop();
      proxy.stop(true);
      server.stop(true);
    }
  }, 20_000);
});
