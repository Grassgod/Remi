import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createPeerChannel, type PeerFetch } from "../../../packages/server/src/api/peer/peer-channel.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

interface UiReply {
  ready?: boolean;
  op?: string;
  port?: number;
  taskId?: string;
  requestId?: string;
  steerId?: string;
  daemonHookCalls?: number;
  daemonSessions?: number;
  stopped?: boolean;
  error?: string;
}

async function startUiProcess(databasePath: string, runtimePort: number, secret: string) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../../fixtures/daemon-protocol-v2/ui-process.ts"),
    databasePath, String(runtimePort), secret], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const queued: UiReply[] = [];
  const waiting: Array<(reply: UiReply) => void> = [];
  let output = "";
  const reader = child.stdout.getReader();
  const readLoop = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      output += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (!line.startsWith("MUL419 ")) continue;
        const reply = JSON.parse(line.slice(7)) as UiReply;
        const resolve = waiting.shift();
        if (resolve) resolve(reply); else queued.push(reply);
      }
    }
  })();
  const next = async (): Promise<UiReply> => {
    if (queued.length) return queued.shift()!;
    return await Promise.race([
      new Promise<UiReply>(resolve => waiting.push(resolve)),
      Bun.sleep(10_000).then(() => { throw new Error("ui process control response timed out"); }),
    ]);
  };
  const ready = await next();
  if (!ready.ready || !ready.port) throw new Error(`ui process did not start: ${ready.error ?? "no ready frame"}`);
  return {
    port: ready.port,
    async command(command: { op: string; runtimeId?: string; taskId?: string; agentId?: string }): Promise<UiReply> {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      await child.stdin.flush();
      const reply = await next();
      if (reply.error) throw new Error(`ui process ${command.op}: ${reply.error}`);
      expect(reply.op).toBe(command.op);
      return reply;
    },
    async close(): Promise<void> {
      if (!child.killed) {
        try {
          await this.command({ op: "stop" });
        }
        catch { child.kill(); }
      }
      child.stdin.end();
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
      if (!exited) child.kill();
      await child.exited;
      await readLoop;
    },
  };
}

const harnesses: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.dispose(); });

describe("MUL-419 ui to runtime fanout across OS processes", () => {
  it("offers a ui-created task and pushes a command and steer only from runtime", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    let uiPort: number | null = null;
    const secret = "mul419-local-peer-fixture";
    const peer = createPeerChannel({
      url: "http://127.0.0.1:0", secret, origin: "mul419-runtime-process",
      minBackoffMs: 20, maxBackoffMs: 100,
      fetchImpl: ((url: string, init: RequestInit) => {
        if (uiPort === null) return Promise.reject(new Error("ui peer not ready"));
        return fetch(url.replace(":0", `:${uiPort}`), init);
      }) as PeerFetch,
    });
    const h = await DaemonProtocolHarness.create({
      apiRole: "runtime", peerChannel: peer, peerSecret: secret,
      daemonOptions: { providerFactory: () => ({
        async *sendStream() {
          await providerGate;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "fixture" }] } as any;
        },
        getLastResponse: () => ({ text: "fixture", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }) },
    });
    harnesses.push(h);
    h.db.exec("PRAGMA journal_mode = WAL");
    h.db.exec("PRAGMA busy_timeout = 5000");
    let ui: Awaited<ReturnType<typeof startUiProcess>> | null = null;
    let stage = "daemon startup";
    try {
      await h.startDaemon();
      await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
      const agent = h.store.createAgent({ name: "Cross-process agent", provider: "claude",
        workspaceId: "local", runtimeId });
      await h.layer.drain();
      stage = "ui startup";
      ui = await startUiProcess(join(h.root, "server.db"), h.server.port!, secret);
      uiPort = ui.port;
      stage = "task offer";
      const taskId = (await ui.command({ op: "create_task", agentId: agent.id })).taskId!;
      await waitFor(() => h.received.some(frame => frame.t === "task.offer" && frame.p.id === taskId),
        "peer-delivered offer", 10_000);
      await waitFor(() => h.store.getTask(taskId)?.status === "running", "running task", 10_000);

      stage = "command and steer";
      const requestId = (await ui.command({ op: "create_command", runtimeId })).requestId!;
      const steerId = (await ui.command({ op: "create_steer", taskId })).steerId!;
      stage = "command frame";
      await waitFor(() => h.received.some(frame => frame.t === "runtime.command" && frame.p.id === requestId),
        "peer-delivered runtime command", 10_000);
      stage = "steer frame";
      await waitFor(() => h.received.some(frame => frame.t === "task.steer" && frame.p.steer?.id === steerId),
        "peer-delivered steer", 10_000);

      const stats = await ui.command({ op: "stats" });
      expect(stats).toMatchObject({ daemonHookCalls: 0, daemonSessions: 0 });
      const refused = await fetch(`http://127.0.0.1:${ui.port}/api/daemon/ws?protocol=2`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13" },
      });
      expect(refused.status).toBe(421);
      expect(await refused.json()).toEqual({ error: "misdirected", role: "ui" });

      releaseProvider();
      await waitFor(() => h.store.getTask(taskId)?.status === "completed", "completed task", 10_000);
      expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.id === taskId)).toHaveLength(1);
      expect(h.errors).toEqual([]);
    } catch (error) {
      console.error(`cross-process stage=${stage} frames=${h.received.map(frame => frame.t).join(",")}`);
      throw error;
    } finally {
      releaseProvider();
      await h.stopDaemon();
      await h.layer.drain();
      if (ui) await ui.close();
    }
  }, 45_000);
});
