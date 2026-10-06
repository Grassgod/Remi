import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { AcpProvider } from "@acp/provider.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer, TestMultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { InjectedSocket } from "./daemon-protocol-v2/harness.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";

let database: Database | null = null;
let directory: string | null = null;
let daemon: TestMultiremiDaemon | null = null;
let server: ReturnType<typeof startMultiremiServer> | null = null;
afterEach(async () => {
  await daemon?.stopAndDrainTestWork();
  daemon = null;
  server?.stop(true);
  server = null;
  database?.close();
  database = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

async function until(check: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 150; attempts++) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Usage did not become durable during the active prompt");
}

describe("daemon consumption reports over the real server protocol", () => {
  it("delivers progress-summary consumption after terminal status under the same accepted run", async () => {
    database = openSqliteDatabase(":memory:");
    directory = mkdtempSync(join(tmpdir(), "remi-daemon-usage-"));
    const store = new MultiremiStore(database);
    const agent = store.createAgent({ name: "Summary consumption", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "main", maxAttempts: 1 });
    const token = await store.createAccessToken({ name: "Usage daemon", type: "daemon", workspaceId: "local" });
    server = startMultiremiServer({ store, scheduler: null, authToken: "usage-root", hostname: "127.0.0.1", port: 0 });
    let observedIncomplete = false;
    const modelApi = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      expect((await request.json() as any).model).toBe("requested-luna");
      await until(() => store.getTask(task.id)?.status === "completed"
        && Number((database!.query("SELECT COUNT(*) AS n FROM multiremi_usage_units WHERE task_id=? AND purpose='progress_summary'").get(task.id) as any).n) > 0);
      observedIncomplete = Number((database!.query("SELECT complete FROM multiremi_usage_runs WHERE task_id=?").get(task.id) as any).complete) === 0;
      return Response.json({ model: "actual-luna", usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } },
        choices: [{ message: { content: '{"summary":"task finished"}' } }] });
    } });
    const names = ["MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL", "MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY", "MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL", "MULTIREMI_PROGRESS_SUMMARY_TRANSPORT", "MULTIREMI_PROGRESS_SUMMARY_DISABLED"] as const;
    const original = new Map(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, { MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL: `http://127.0.0.1:${modelApi.port}`,
      MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY: "fixture", MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL: "requested-luna", MULTIREMI_PROGRESS_SUMMARY_TRANSPORT: "openai", MULTIREMI_PROGRESS_SUMMARY_DISABLED: "0" });
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      client._options.onSessionUpdate({ sessionId: "native", update: { sessionUpdate: "usage_update", used: 100, size: 200000,
        _meta: { remiTokenUsage: { id: "main-request", model: "opus", scope: "request_snapshot", accuracy: "exact", inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 } } } });
      client._options.onSessionUpdate({ sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "main done" } } });
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
    } };
    daemon = new TestMultiremiDaemon({ sshMeshManager: disabledSshMeshRuntime(), serverUrl: `http://127.0.0.1:${server.port}`,
      token: token.token, daemonId: "summary-accounting", runtimeName: "summary-runtime", provider: "claude", workspaceId: "local", once: true, daemonPort: 0,
      workspacesRoot: join(directory, "workspaces"), repoCacheRoot: join(directory, "cache"), providerFactory: () => {
        const provider = new AcpProvider({ agentType: "claude" });
        (provider as any)._ensureSession = async () => ({ client, acpSessionId: "native" });
        return provider;
      } });
    try {
      await daemon.start();
      expect(observedIncomplete).toBe(true);
      const report = store.getUsageReport({ workspaceId: "local", days: null });
      expect(report.summary.actual_total_tokens).toBe(32);
      expect(report.by_model.filter(row => row.actual_total_tokens > 0).map(row => [row.purpose, row.model, row.actual_total_tokens]).sort()).toEqual([
        ["agent", "opus", 12], ["progress_summary", "actual-luna", 20],
      ]);
      const helper = database.query("SELECT connection_id,input_tokens,cache_read_tokens,output_tokens FROM multiremi_usage_units WHERE task_id=? AND purpose='progress_summary'").get(task.id) as any;
      expect(helper).toMatchObject({ input_tokens: 5, cache_read_tokens: 10, output_tokens: 5 });
      expect(helper.connection_id).toMatch(/^runtime:rt_.+:progress-summary:openai$/);
      expect(database.query("SELECT COUNT(*) AS n FROM multiremi_usage_runs WHERE task_id=? AND complete=1").get(task.id)).toEqual({ n: 1 });
    } finally {
      modelApi.stop(true);
      for (const name of names) { const value = original.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  }, 20_000);

  it.each(["before-accept", "after-accept-ack-lost"])("never enters the provider when execution is reassigned %s", async (fault) => {
    database = openSqliteDatabase(":memory:");
    directory = mkdtempSync(join(tmpdir(), "remi-daemon-usage-"));
    const store = new MultiremiStore(database);
    const agent = store.createAgent({ name: "Execution authority", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Must be authorized", maxAttempts: 2 });
    const replacement = store.registerRuntime({ name: "replacement", provider: "claude", workspaceId: "local" });
    const token = await store.createAccessToken({ name: "Usage daemon", type: "daemon", workspaceId: "local" });
    let layer!: DaemonProtocolLayer;
    server = startMultiremiServer({ store, scheduler: null, authToken: "usage-root", hostname: "127.0.0.1", port: 0,
      onDaemonProtocol: value => { layer = value; } });
    let dropped = false, starts = 0, providerCalls = 0;
    let replySpy: ReturnType<typeof spyOn> | undefined;
    const reassign = () => database!.run("UPDATE multiremi_tasks SET runtime_id=?,status='dispatched',attempt=attempt+1 WHERE id=?", [replacement.id, task.id]);
    daemon = new TestMultiremiDaemon({ sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: `http://127.0.0.1:${server.port}`, token: token.token, daemonId: `authority-${fault}`, runtimeName: "original",
      provider: "claude", workspaceId: "local", once: true, daemonPort: 0, taskDrainTimeoutMs: 5000, outboxBackoffMs: [5],
      workspacesRoot: join(directory, "workspaces"), repoCacheRoot: join(directory, "cache"),
      protocolClientOptions: { random: () => 0, connect: (url, init) => new InjectedSocket(url, init, (frame, socket) => {
        if (frame.t !== "task.start" || frame.p.task_id !== task.id) return;
        starts++;
        if (dropped) return;
        if (fault === "before-accept") { dropped = true; reassign(); return; }
        const session = layer.registry.sessionForRuntime(frame.rt)! as DaemonProtocolSession;
        const real = session.sendReply.bind(session);
        replySpy = spyOn(session, "sendReply").mockImplementation((id, body) => {
          if (!dropped && id === String(frame.seq) && (body as any).ok === true) {
            dropped = true;
            reassign();
            socket.close(4001);
            return false;
          }
          return real(id, body);
        });
      }) },
      providerFactory: () => {
        const provider = new AcpProvider({ agentType: "claude" });
        (provider as any)._ensureSession = async () => { providerCalls++; throw new Error("Unauthorized provider entry"); };
        return provider;
      },
    });
    try {
      await daemon.start();
      expect(dropped).toBe(true);
      expect(providerCalls).toBe(0);
      expect(store.getTask(task.id)?.runtimeId).toBe(replacement.id);
      expect(store.getTask(task.id)?.status).toBe("dispatched");
      if (fault === "after-accept-ack-lost") expect(starts).toBeGreaterThan(1);
      expect((database.query("SELECT COUNT(*) AS n FROM multiremi_usage_units WHERE task_id=?").get(task.id) as any).n).toBe(0);
    } finally { replySpy?.mockRestore(); }
  }, 20_000);

  it.each(["failure", "cancel", "steer"])("durably checkpoints actual requests before %s and preserves final task accounting", async (outcome) => {
    database = openSqliteDatabase(":memory:");
    directory = mkdtempSync(join(tmpdir(), "remi-daemon-usage-"));
    const store = new MultiremiStore(database);
    const agent = store.createAgent({ name: "Usage worker", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Do work", maxAttempts: 1 });
    const token = await store.createAccessToken({ name: "Usage daemon", type: "daemon", workspaceId: "local" });
    server = startMultiremiServer({ store, scheduler: null, authToken: "usage-root", hostname: "127.0.0.1", port: 0 });
    let turn = 0;
    let interrupt: (() => void) | null = null;
    let observedWhileRunning = false;
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: any) => {} },
      cancel: async () => { interrupt?.(); },
      prompt: async () => {
        turn++;
        const notify = (update: any) => client._options.onSessionUpdate({ sessionId: "native-session", update });
        const usage = (id: string, model: string, input: number, output: number) => ({
          sessionUpdate: "usage_update", used: 70000, size: 200000,
          _meta: { remiTokenUsage: { id, model, scope: "request_snapshot", source: "claude_assistant_usage", accuracy: "exact",
            inputTokens: input, outputTokens: output, cachedInputTokens: 0, totalTokens: input + output } },
        });
        if (turn === 1) {
          notify(usage("request-main", "opus", 10, 8));
          notify(usage("request-child", "haiku", 5, 2));
          notify(usage("request-main", "opus", 10, 8)); // replay
          notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First findings" } });
          await until(() => Number((database!.query("SELECT SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS n FROM multiremi_usage_units WHERE task_id=?").get(task.id) as any)?.n) === 25);
          observedWhileRunning = store.getTask(task.id)?.status === "running";
          if (outcome === "failure") throw new Error("Provider model request failed after consuming tokens");
          if (outcome === "cancel") {
            const cancelled = new Promise<void>(resolve => { interrupt = resolve; });
            store.cancelTask(task.id);
            await cancelled;
            return { stopReason: "cancelled", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
          }
          const cancelled = new Promise<void>(resolve => { interrupt = resolve; });
          store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "Continue in Chinese" });
          await cancelled;
          return { stopReason: "cancelled", usage: { totalTokens: 0 } };
        }
        notify(usage("request-next-turn", "sonnet", 4, 3));
        notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "中文结论" } });
        return { stopReason: "end_turn", usage: { totalTokens: 7 } };
      },
    };
    daemon = new TestMultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(), serverUrl: `http://127.0.0.1:${server.port}`, token: token.token,
      daemonId: `usage-${outcome}`, runtimeName: "usage-runtime", provider: "claude", workspaceId: "local", once: true,
      daemonPort: 0, workspacesRoot: join(directory, "workspaces"), repoCacheRoot: join(directory, "cache"),
      providerFactory: () => {
        const provider = new AcpProvider({ agentType: "claude" });
        (provider as any)._ensureSession = async () => ({ client, acpSessionId: "native-session" });
        return provider;
      },
    });
    await daemon.start();
    expect(observedWhileRunning).toBe(true);
    expect(store.getTask(task.id)?.status).toBe(outcome === "failure" ? "failed" : outcome === "cancel" ? "cancelled" : "completed");
    const report = store.getUsageReport({ workspaceId: "local", days: null });
    expect(report.summary).toMatchObject({ actual_total_tokens: outcome === "steer" ? 32 : 25, context_peak_tokens: 70000, task_count: 1 });
    expect(report.by_model.filter(row => row.actual_total_tokens > 0).map(row => [row.model, row.actual_total_tokens]).sort()).toEqual(
      outcome === "steer" ? [["haiku", 7], ["opus", 18], ["sonnet", 7]] : [["haiku", 7], ["opus", 18]],
    );
    expect(database.query("SELECT COUNT(*) AS n FROM multiremi_usage_runs WHERE task_id=? AND complete=1").get(task.id)).toEqual({ n: 1 });
  }, 20_000);
});
