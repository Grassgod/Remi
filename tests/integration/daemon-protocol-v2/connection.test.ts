import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { join } from "node:path";
import { DAEMON_HEARTBEAT_INTERVAL_MS } from "@multiremi/contracts/daemon-protocol.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { MultiremiDaemonHttpError } from "@multiremi/worker/client.js";
import { DaemonProtocolRpcError } from "@multiremi/worker/daemon-protocol-client.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
async function fixture(options: Parameters<typeof DaemonProtocolHarness.create>[0] = {}) {
  const h = await DaemonProtocolHarness.create(options);
  fixtures.push(h);
  return h;
}
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.dispose();
});

function localProgressSummary() {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return Response.json({ model: "shutdown-summary-model", usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
      choices: [{ message: { content: '{"summary":"provider drained","step":3,"total":3}' } }] });
  } });
  const settings = {
    MULTIREMI_PROGRESS_SUMMARY_DISABLED: "0",
    MULTIREMI_PROGRESS_SUMMARY_TRANSPORT: "openai",
    MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL: `http://127.0.0.1:${server.port}`,
    MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL: "shutdown-summary-model",
    MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY: "local-fixture-key",
    MULTIREMI_PROGRESS_SUMMARY_MESSAGES: "1000",
    MULTIREMI_PROGRESS_SUMMARY_INTERVAL_MS: "45000",
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  return { requests: () => requests, close() {
    server.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  } };
}

describe("daemon protocol v2 real connection", () => {
  it("handshakes all provider lanes on one socket and continuously heartbeats without HTTP heartbeats", async () => {
    const heartbeat = spyOn(MultiremiDaemonClient.prototype, "heartbeatRuntime");
    try {
      const h = await fixture({ providers: ["claude", "codex"] });
      await h.startDaemon();
      await h.settleHeartbeat();
      const token = h.store.listAccessTokens("local").find(value => value.daemonId === "dmn_fixture")!;
      const lastUsedAt = h.store.getAccessToken(token.id)!.lastUsedAt;
      expect(h.sockets).toHaveLength(1);
      expect(h.daemons[1]!.daemonProtocolClient()).toBe(h.client);
      const hello = h.ledger.find(entry => entry.type === "hello")!.frame;
      expect(hello.p.runtimes.map((rt: any) => rt.provider).sort()).toEqual(["claude", "codex"]);
      expect(h.layer.registry.size).toBe(1);
      for (let round = 0; round < 3; round++) {
        h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
        await waitFor(() => h.ledger.filter(entry => entry.type === "hb").length === round + 2, "heartbeat ingress");
        await h.settleHeartbeat();
      }
      expect(h.ledger.filter(entry => entry.type === "hb")).toHaveLength(4);
      expect(h.store.getAccessToken(token.id)!.lastUsedAt).toBe(lastUsedAt);
      expect(heartbeat).not.toHaveBeenCalled();
      expect((await h.health()).protocol).toMatchObject({ state: "ok", server_min: 2, self: 2, next_probe_at: null });
    } finally { heartbeat.mockRestore(); }
  });

  it("closes a retired daemon with 4410 on the next heartbeat", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    const closeCode = new Promise<number>(resolve => h.sockets[0]!.native.addEventListener("close", event => resolve(event.code), { once: true }));
    const plan = h.store.getDaemonRetirementPlan("local", "dmn_fixture");
    expect(h.store.retireDaemon("local", "dmn_fixture", plan.snapshot, "local").status).toBe("retired");
    h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
    expect(await closeCode).toBe(4410);
    await waitFor(() => h.client.connectionState() === "terminal", "retired daemon terminal state");
    expect(h.layer.registry.size).toBe(0);
  });

  it.each(["revoked", "expired"] as const)("closes a %s daemon credential with 4401 on the next heartbeat", async state => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    const token = h.store.listAccessTokens("local").find(value => value.daemonId === "dmn_fixture")!;
    const lastUsedAt = h.store.getAccessToken(token.id)!.lastUsedAt;
    const closeCode = new Promise<number>(resolve => h.sockets[0]!.native.addEventListener("close", event => resolve(event.code), { once: true }));
    h.db.run(`UPDATE multiremi_access_tokens SET ${state === "revoked" ? "revoked_at" : "expires_at"} = ? WHERE id = ?`,
      [new Date(Date.now() - 1_000).toISOString(), token.id]);
    h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
    expect(await closeCode).toBe(4401);
    await waitFor(() => h.client.connectionState() === "terminal", "revoked credential terminal state");
    expect(h.store.getAccessToken(token.id)!.lastUsedAt).toBe(lastUsedAt);
  });

  it("reads pending and settled decision messages through the card host's real HTTP client", async () => {
    const h = await fixture();
    await h.startDaemon();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const agent = h.store.createAgent({ name: "human request RPC", provider: "claude", runtimeId });
    const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "question" });
    const request = h.store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { question: "Continue?" } });
    const reads = spyOn(h.daemon, "getMessageHumanRequest");
    expect(await h.daemon.isFeishuBotHumanRequestPending(task.id, request.id)).toBe(true);
    expect(await h.daemon.getFeishuBotHumanRequest(task.id, request.id)).toEqual(request);
    expect(h.store.respondTaskHumanRequest(request.id, { response: { answer: "yes" }, respondedBy: "test" })).toBeTruthy();
    expect(await h.daemon.isFeishuBotHumanRequestPending(task.id, request.id)).toBe(false);
    expect(await h.daemon.getFeishuBotHumanRequest(task.id, request.id)).toMatchObject({ status: "responded", response: { answer: "yes" } });
    await expect(h.daemon.getFeishuBotHumanRequest(task.id, "hrq_missing")).rejects.toBeInstanceOf(MultiremiDaemonHttpError);
    await expect(h.daemon.getFeishuBotHumanRequest(task.id, "hrq_missing")).rejects.toMatchObject({ status: 404 });
    expect(reads.mock.calls.map(args => args[0])).toEqual([
      request.id, request.id, request.id, request.id, "hrq_missing", "hrq_missing",
    ]);
    expect(h.ledger.filter(entry => entry.type === "human_request.get")).toHaveLength(0);
    reads.mockRestore();
  });

  it("times out a decision RPC while the executing turn's socket is disconnected", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.disconnect();
    const error = await (h.daemon as any).taskDownlinks.rpc("turn.decision.get", {
      turn_id: "turn_unreachable", attempt_id: "tsk_unreachable", message_id: "msg_unreachable",
    }, 50)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DaemonProtocolRpcError);
    expect(error).toMatchObject({ code: "daemon_timeout", retryable: true });
  });

  it("stops within 1s while execution start is unacknowledged without calling the provider", async () => {
    let waitingForStart = false;
    let providerCalls = 0;
    const h = await fixture({
      beforeSend: frame => {
        if (frame.t === "task.start") { waitingForStart = true; return false; }
      },
      providerFactory: () => ({
        async *sendStream() { providerCalls++; }, getLastResponse: () => null,
      }),
    });
    await h.startDaemon();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    const agent = h.store.createAgent({ name: "unacknowledged start", provider: "claude", runtimeId });
    const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Never enter the provider" });
    await waitFor(() => waitingForStart, "execution start to await ACK");
    expect(h.store.getTask(task.id)?.status).toBe("dispatched");
    expect(providerCalls).toBe(0);
    let stopped = false;
    const stopping = h.stopDaemon().then(() => { stopped = true; });
    await waitFor(() => stopped, "shutdown to cancel unacknowledged start", 1_000);
    await stopping;
    expect(providerCalls).toBe(0);
    expect(h.client.diagnostics()).toEqual({ timers: 0, sockets: 0, pending_rpcs: 0, background: 0 });
  });

  it("keeps a committed start durable when its ACK is lost and shutdown cancels the waiter", async () => {
    let providerCalls = 0;
    let lostAck = false;
    let runId = "";
    const replies: Array<ReturnType<typeof spyOn>> = [];
    const h = await fixture({
      beforeSend(frame, _socket, harness) {
        if (frame.t !== "task.start") return;
        runId = frame.p.usage_run_id;
        const session = harness.sessions.at(-1)!;
        const real = session.sendReply.bind(session);
        replies.push(spyOn(session, "sendReply").mockImplementation((re, payload) => {
          if (re === String(frame.seq) && (payload as { ok?: unknown }).ok === true) {
            lostAck = true;
            return false;
          }
          return real(re, payload);
        }));
      },
      providerFactory: () => ({ async *sendStream() { providerCalls++; }, getLastResponse: () => null }),
    });
    try {
      await h.startDaemon();
      const runtimeId = h.store.listRuntimes()[0]!.id;
      const agent = h.store.createAgent({ name: "lost committed start ACK", provider: "claude", runtimeId });
      const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Await committed authority" });
      await waitFor(() => lostAck, "server start commit before lost ACK");
      expect(h.store.getTask(task.id)?.status).toBe("running");
      expect(h.db.query("SELECT runtime_id FROM multiremi_usage_run_scopes WHERE task_id=? AND run_id=?").get(task.id, runId))
        .toEqual({ runtime_id: runtimeId });
      let stopped = false;
      const stopping = h.stopDaemon().then(() => { stopped = true; });
      await waitFor(() => stopped, "shutdown of a committed start without ACK", 1_000);
      await stopping;
      expect(providerCalls).toBe(0);
      const persisted = openSqliteDatabase((h.daemon as unknown as { outboxPath: string }).outboxPath);
      try {
        const start = persisted.query("SELECT status,payload FROM outbox_events WHERE task_id=? AND kind='start'").get(task.id) as { status: string; payload: string };
        expect(start.status).toBe("pending");
        expect(JSON.parse(start.payload).usage_run_id).toBe(runId);
      } finally { persisted.close(); }
      expect(h.client.diagnostics()).toEqual({ timers: 0, sockets: 0, pending_rpcs: 0, background: 0 });
    } finally { for (const reply of replies) reply.mockRestore(); }
  });

  it("does not enter the provider when shutdown occurs during preparation after the start ACK", async () => {
    const summaryEndpoint = localProgressSummary();
    let providerCalls = 0;
    let preparing = false;
    let releasePreparation!: () => void;
    const released = new Promise<void>(resolve => { releasePreparation = resolve; });
    const h = await fixture({ providerFactory: () => ({
      async *sendStream() { providerCalls++; }, getLastResponse: () => null,
    }) });
    // Hold an actual awaited workspace preparation boundary, then run its
    // original implementation: authorization and workspace work stay real.
    const daemon = h.daemon as any;
    const realPrepare = daemon.prepareTaskWorkspace.bind(daemon);
    const prepare = spyOn(daemon, "prepareTaskWorkspace").mockImplementation(async (...args: any[]) => {
      preparing = true;
      await released;
      return realPrepare(...args);
    });
    try {
      await h.startDaemon();
      const runtimeId = h.store.listRuntimes()[0]!.id;
      const agent = h.store.createAgent({ name: "stop during authorized preparation", provider: "claude", runtimeId });
      const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Stop before provider entry", maxAttempts: 1 });
      await waitFor(() => preparing, "post-ACK workspace preparation");
      expect(h.store.getTask(task.id)?.status).toBe("running");
      expect(h.db.query("SELECT active_run_id FROM multiremi_usage_task_scopes WHERE task_id=?").get(task.id))
        .toMatchObject({ active_run_id: expect.any(String) });
      let stopped = false;
      const stopping = h.stopDaemon().then(() => { stopped = true; });
      releasePreparation();
      await waitFor(() => stopped, "shutdown after held preparation resumes", 1_000);
      await stopping;
      expect(providerCalls).toBe(0);
      expect(summaryEndpoint.requests()).toBe(0);
      const persisted = openSqliteDatabase((h.daemon as unknown as { outboxPath: string }).outboxPath);
      try {
        const pending = persisted.query("SELECT kind,payload FROM outbox_events WHERE task_id=? ORDER BY seq").all(task.id) as Array<{ kind: string; payload: string }>;
        expect(pending.some(row => row.kind === "fail")).toBe(true);
        const usage = pending.filter(row => row.kind === "usage").map(row => JSON.parse(row.payload).usageSnapshot);
        expect(usage.at(-1)).toMatchObject({ complete: true, units: [] });
      } finally { persisted.close(); }
      expect(h.client.diagnostics()).toEqual({ timers: 0, sockets: 0, pending_rpcs: 0, background: 0 });
      prepare.mockRestore();
      await h.recreateDaemon();
      await waitFor(() => h.store.getTask(task.id)?.status === "failed"
        && (h.db.query("SELECT complete FROM multiremi_usage_runs WHERE task_id=?").get(task.id) as { complete: number })?.complete === 1,
      "accepted run and closed summary scope to replay");
      expect(providerCalls).toBe(0);
      expect(summaryEndpoint.requests()).toBe(0);
      expect(h.db.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_usage_units WHERE task_id=?").get(task.id)).toEqual({ n: 0 });
    } finally { releasePreparation(); prepare.mockRestore(); summaryEndpoint.close(); }
  });

  it("drains an already-started provider on shutdown without aborting its execution", async () => {
    const summaryEndpoint = localProgressSummary();
    let providerCalls = 0;
    let executionSignal: AbortSignal | undefined;
    let releaseProvider!: () => void;
    const released = new Promise<void>(resolve => { releaseProvider = resolve; });
    const h = await fixture({
      providerFactory: () => ({
        async *sendStream(_message, options) {
          providerCalls++;
          executionSignal = options?.signal;
          await released;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "finished" }] } as any;
        },
        getLastResponse: () => ({ text: "finished", sessionId: "drained-session", usage: [], toolCalls: [] } as any),
      }),
    });
    await h.startDaemon();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    const agent = h.store.createAgent({ name: "graceful provider drain", provider: "claude", runtimeId });
    const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Finish after shutdown begins", maxAttempts: 1 });
    try {
      await waitFor(() => providerCalls === 1, "authorized provider execution");
      expect(executionSignal).toBeDefined();
      let stopped = false;
      const stopping = h.stopDaemon().then(() => { stopped = true; });
      await Bun.sleep(0);
      expect(stopped).toBe(false);
      expect(executionSignal!.aborted).toBe(false);
      releaseProvider();
      await waitFor(() => stopped, "provider completion and graceful shutdown", 1_000);
      await stopping;
      expect(providerCalls).toBe(1);
      expect(executionSignal!.aborted).toBe(false);
      expect(summaryEndpoint.requests()).toBe(1);
      const persisted = openSqliteDatabase((h.daemon as unknown as { outboxPath: string }).outboxPath);
      try {
        const pending = persisted.query("SELECT payload FROM outbox_events WHERE task_id=? AND kind='usage' ORDER BY seq").all(task.id) as Array<{ payload: string }>;
        const usage = pending.map(row => JSON.parse(row.payload).usageSnapshot);
        expect(usage.some(snapshot => snapshot.complete === false)).toBe(true);
        expect(usage.at(-1).complete).toBe(true);
        expect(usage.flatMap(snapshot => snapshot.units).find(unit => unit.purpose === "progress_summary" && unit.model === "shutdown-summary-model"))
          .toMatchObject({ model: "shutdown-summary-model", inputTokens: 6, outputTokens: 4 });
      } finally { persisted.close(); }
      expect(h.client.diagnostics()).toEqual({ timers: 0, sockets: 0, pending_rpcs: 0, background: 0 });
      await h.recreateDaemon();
      await waitFor(() => (h.db.query("SELECT complete FROM multiremi_usage_runs WHERE task_id=?").get(task.id) as { complete: number })?.complete === 1,
        "late helper usage and its completion to replay");
      expect(h.store.getUsageReport({ workspaceId: "local", days: null }).by_model
        .find(row => row.purpose === "progress_summary" && row.model === "shutdown-summary-model")?.actual_total_tokens).toBe(10);
      expect(summaryEndpoint.requests()).toBe(1);
    } finally { releaseProvider(); summaryEndpoint.close(); }
  });

  it("survives 20 injected disconnects without leaking sockets, listeners, timers or pending RPCs", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    let seed = 418;
    for (let round = 0; round < 20; round++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      h.clock.advance(seed % 1_000);
      await h.disconnect();
      await h.reconnect();
      expect(h.layer.registry.size).toBe(1);
      expect(h.client.diagnostics()).toEqual({ timers: 2, sockets: 1, pending_rpcs: 0, background: 0 });
      expect(h.clock.pendingTimerCount).toBe(2);
      for (const socket of h.sockets.slice(0, -1)) {
        expect(socket.closed).toBe(true);
        expect([...socket.listeners.values()].every(set => set.size === 0)).toBe(true);
      }
    }
    expect(h.ledger.filter(entry => entry.type === "hello")).toHaveLength(21);
    await h.stopDaemon();
    expect(h.client.diagnostics()).toEqual({ timers: 0, sockets: 0, pending_rpcs: 0, background: 0 });
    expect(h.clock.pendingTimerCount).toBe(0);
  }, 15_000);

  it("settles exchanges and subsequent lane callbacks from their completion promises", async () => {
    const h = await fixture();
    await h.startDaemon(); await h.settleHeartbeat();
    let releaseExchange!: () => void;
    let exchangeStarted!: () => void;
    let releaseCallback!: () => void;
    let callbackStarted!: () => void;
    const exchangeReady = new Promise<void>(resolve => { exchangeStarted = resolve; });
    const callbackReady = new Promise<void>(resolve => { callbackStarted = resolve; });
    const exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve; });
    const callbackGate = new Promise<void>(resolve => { releaseCallback = resolve; });
    h.layer.registerRpcHandler("gc.check_task", async () => {
      exchangeStarted(); await exchangeGate; return { ok: true };
    });
    const callback = spyOn((h.daemon as any).protocolLane, "onHeartbeatAck").mockImplementation(async () => {
      callbackStarted(); await callbackGate;
    });
    try {
      h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
      const exchange = h.client.rpc("gc.check_task", {});
      await exchangeReady;
      let settled = false;
      const settlement = h.settleHeartbeat().then(() => { settled = true; });
      await Bun.sleep(0);
      expect(settled).toBe(false);
      releaseExchange(); await exchange; await callbackReady;
      expect(settled).toBe(false);
      releaseCallback(); await settlement;
      expect(h.client.diagnostics()).toMatchObject({ pending_rpcs: 0, background: 0 });
      expect(callback).toHaveBeenCalledTimes(1);
    } finally { releaseExchange(); releaseCallback(); callback.mockRestore(); }
  });

  it("keeps a bounded diagnostic deadline when an exchange has not replied", async () => {
    const h = await fixture();
    await h.startDaemon(); await h.settleHeartbeat();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.layer.registerRpcHandler("gc.check_task", async () => { await gate; return { ok: true }; });
    const exchange = h.client.rpc("gc.check_task", {});
    try {
      await expect(h.settleHeartbeat(25)).rejects.toThrow("Timed out waiting for heartbeat and runtime callbacks");
      expect(h.client.diagnostics().pending_rpcs).toBe(1);
    } finally { release(); await exchange; await h.settleHeartbeat(); }
  });

  it("registers inert providers without probing installed agent or ACP binaries", async () => {
    const h = await fixture();
    const prototype = Object.getPrototypeOf(h.daemon);
    const bridge = spyOn(prototype, "acpVersion").mockImplementation(() => { throw new Error("Unexpected local ACP version probe"); });
    const agent = spyOn(prototype, "agentVersion").mockImplementation(() => { throw new Error("Unexpected local agent version probe"); });
    try {
      await h.startDaemon(); await h.settleHeartbeat();
      expect(bridge).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
      expect(h.store.listRuntimes()).toHaveLength(1);
      expect(h.client.connectionState()).toBe("connected");
    } finally { bridge.mockRestore(); agent.mockRestore(); }
  });

  it("commits fixture initialization without reducing file-backed SQLite durability", async () => {
    const h = await fixture({ database: "sqlite" });
    expect(h.db.inTransaction).toBe(false);
    expect(h.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(h.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    await h.startDaemon(); await h.settleHeartbeat();
    const persisted = openSqliteDatabase(join(h.root, "server.db"), { readonly: true });
    try {
      expect(persisted.query("SELECT id FROM multiremi_runtimes").all()).toEqual([
        { id: h.store.listRuntimes()[0]!.id },
      ]);
    } finally { persisted.close(); }
  });

  it("records task and runtime partition keys with sequence numbers at real API ingress", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    // Business dispatch remains A-3/A-5; this only checks the ingress ledger.
    h.client.send({ t: "task.progress", rt: runtimeId, seq: 1, p: { task_id: "tsk_ledger", step: 1 } });
    h.client.send({ t: "runtime.update_result", rt: runtimeId, seq: 2, p: { id: "update-ledger", status: "completed" } });
    await waitFor(() => h.ledger.filter(entry => entry.seq !== null).length === 2, "server ingress ledger");
    expect(h.ledger.filter(entry => entry.seq !== null).map(({ partition, seq }) => ({ partition, seq }))).toEqual([
      { partition: "tsk_ledger", seq: 1 }, { partition: `rt:${runtimeId}`, seq: 2 },
    ]);
  });

  it("supports daemon stop/start and real API restart on the same port", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    await h.restartDaemon();
    await h.settleHeartbeat();
    expect(h.layer.registry.size).toBe(1);
    const port = h.server.port;
    await h.restartServer();
    expect(h.server.port).toBe(port);
    expect(h.layer.registry.size).toBe(1);
    expect(h.ledger.filter(entry => entry.type === "hello")).toHaveLength(3);
  });

  it("stops all lane claims after 4426 and probes the HTTP upgrade channel once per 60 seconds", async () => {
    const heartbeat = spyOn(MultiremiDaemonClient.prototype, "heartbeatRuntime");
    const claim = spyOn(MultiremiDaemonClient.prototype, "claimTask");
    try {
      const h = await fixture({ providers: ["claude", "codex"] });
      await h.startDaemon();
      await h.settleHeartbeat();
      h.sockets[0]!.close(4426);
      await waitFor(() => h.client.connectionState() === "upgrade_wait", "upgrade_wait");
      // Let a claim already in flight before the rejection finish.
      await Bun.sleep(50);
      const claims = claim.mock.calls.length;
      h.clock.advance(59_999);
      expect(heartbeat).not.toHaveBeenCalled();
      expect((await h.health()).protocol).toEqual({ state: "rejected", server_min: 2, self: 2, next_probe_at: new Date(h.clock.now() + 1).toISOString() });
      h.clock.advance(1);
      await h.client.drain();
      expect(heartbeat.mock.calls).toHaveLength(2);
      h.clock.advance(60_000);
      await h.client.drain();
      expect(heartbeat.mock.calls).toHaveLength(4);
      expect(claim.mock.calls).toHaveLength(claims);
      expect(h.sockets).toHaveLength(1);
    } finally { heartbeat.mockRestore(); claim.mockRestore(); }
  });

  it("re-registers a runtime deleted before hello, reconnects with the new ID and receives an offer", async () => {
    const deletedId = "rt_deleted_previous_registration";
    const helloSockets: WebSocket[] = [];
    const registerRuntime = MultiremiDaemonClient.prototype.registerDaemonRuntime;
    let releaseRecovery!: () => void;
    const recovery = new Promise<void>(resolve => { releaseRecovery = resolve; });
    let recovering = false;
    let recoveries = 0;
    const register = spyOn(MultiremiDaemonClient.prototype, "registerDaemonRuntime").mockImplementation(async function (this: MultiremiDaemonClient, input) {
      if (++recoveries === 2) { recovering = true; await recovery; }
      return await registerRuntime.call(this, input);
    });
    const recover = spyOn(MultiremiDaemonClient.prototype, "recoverOrphans");
    const claim = spyOn(MultiremiDaemonClient.prototype, "claimTask");
    try {
      const h = await fixture({ beforeSend: (frame, socket) => {
        if (frame.t === "hello") helloSockets.push(socket.native);
      }, onReady: (daemon, h) => {
        // Simulate the stale cached ID of an older registration. Current register
        // deterministically returns a different canonical (daemon, provider) ID.
        h.store.registerRuntime({ id: deletedId, name: "previous", provider: "claude", workspaceId: "local", daemonId: "dmn_fixture" });
        expect(h.store.deleteRuntime(deletedId)).toBe(true);
        (daemon as unknown as { options: { runtimeId: string } }).options.runtimeId = deletedId;
      } });
      const runtimesChanged = spyOn(h.client, "runtimesChanged");
      await h.startDaemon();
      await waitFor(() => recovering, "orphan recovery after runtime_gone");
      // The new identity is registered, but the supervisor readiness barrier
      // keeps its hello and any offer behind the in-flight recovery callback.
      expect(h.ledger.filter(entry => entry.type === "hello")).toHaveLength(1);
      expect(h.received.filter(frame => frame.t === "task.offer")).toHaveLength(0);
      await Bun.sleep(50);
      const claims = claim.mock.calls.length;
      await Bun.sleep(50);
      expect(claim.mock.calls).toHaveLength(claims);
      releaseRecovery();
      await waitFor(() => h.ledger.filter(entry => entry.type === "hello").length === 2 && h.client.connectionState() === "connected", "runtime re-registration hello");
      await h.settleHeartbeat();
      const gone = h.sockets[0]!.frames.find(frame => frame.t === "res" && frame.p.runtime_acks?.some((ack: any) => ack.runtime_gone));
      expect(gone?.p.runtime_acks[0]).toMatchObject({ runtime_id: deletedId, status: "runtime_gone", runtime_gone: true });
      const newId = h.ledger.filter(entry => entry.type === "hello")[1]!.frame.p.runtimes[0].runtime_id;
      expect(newId).not.toBe(deletedId);
      expect(h.store.getRuntime(newId)?.daemonId).toBe("dmn_fixture");
      expect(h.layer.registry.sessionForRuntime(deletedId)).toBeNull();
      const session = h.layer.registry.sessionForRuntime(newId)! as typeof h.sessions[number];
      const agent = h.store.createAgent({ name: "offer after registration", provider: "claude", runtimeId: newId, workspaceId: "local" });
      const task = h.store.createTask({ agentId: agent.id, prompt: "offer after registration" });
      await waitFor(() => h.received.some(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id), "new runtime offer");
      expect(h.received.find(frame => frame.t === "task.offer")).toMatchObject({ rt: newId, p: { attempt_id: task.id } });
      h.clock.advance(100);
      await waitFor(() => session.unacknowledgedFrameCount === 0, "independent offer acknowledgement");
      expect(register).toHaveBeenCalledTimes(2);
      expect(recover).toHaveBeenCalledTimes(2);
      expect(claim).not.toHaveBeenCalled();
      await waitFor(() => h.store.getTask(task.id)?.status === "completed", "re-registered task completion");
      await h.settleHeartbeat();
      expect(runtimesChanged).toHaveBeenCalledTimes(2);
      expect(h.ledger.filter(entry => entry.type === "hello")).toHaveLength(2);
      expect(h.sockets).toHaveLength(2);
      expect(helloSockets).toEqual(h.sockets.map(socket => socket.native));
    } finally { releaseRecovery(); register.mockRestore(); recover.mockRestore(); claim.mockRestore(); }
  });

  it("recovers registry contention only after runtime_gone, registration and a fresh hello", async () => {
    let heldHeartbeat: { text: string; socket: WebSocket } | null = null;
    const helloSockets: WebSocket[] = [];
    let hold = true;
    const h = await fixture({ runtimeId: "rt_contended", beforeSend: (frame, socket) => {
      if (frame.t === "hello") helloSockets.push(socket.native);
      if (frame.t === "hb" && hold) { heldHeartbeat = { text: JSON.stringify(frame), socket: socket.native }; return false; }
    } });
    const runtimesChanged = spyOn(h.client, "runtimesChanged");
    h.store.registerRuntime({ id: "rt_contended", name: "contended", provider: "claude", workspaceId: "local" });
    const incumbent = new WebSocket(`${h.url.replace("http:", "ws:")}/api/daemon/ws?protocol=2`, { headers: { Authorization: "Bearer fixture-master" } } as never);
    try {
      await new Promise<void>((resolve, reject) => { incumbent.addEventListener("open", () => resolve(), { once: true }); incumbent.addEventListener("error", reject, { once: true }); });
      incumbent.send(JSON.stringify({ v: 2, t: "hello", ts: Date.now(), p: { protocol: 2, daemon_id: "dmn_incumbent", cli_version: DAEMON_MIN_CLI_VERSION, launched_by: null, runtimes: [{ runtime_id: "rt_contended", provider: "claude", max_concurrency: 1, active_task_ids: [] }], caps: [] } }));
      await waitFor(() => h.layer.registry.daemonIdForRuntime("rt_contended") === "dmn_incumbent", "incumbent runtime ownership");
      await h.startDaemon();
      const later = h.layer.registry.get("dmn_fixture")! as typeof h.sessions[number];
      expect(later.unavailableRuntimeIds).toEqual(["rt_contended"]);
      incumbent.close();
      await waitFor(() => h.layer.registry.get("dmn_incumbent") === null, "incumbent disconnect");
      expect(later.unavailableRuntimeIds).toEqual(["rt_contended"]);
      expect(h.layer.registry.sessionForRuntime("rt_contended")).toBeNull();
      expect(heldHeartbeat).not.toBeNull();
      hold = false;
      const held = heldHeartbeat as unknown as { text: string; socket: WebSocket };
      held.socket.send(held.text);
      await waitFor(() => h.ledger.filter(entry => entry.type === "hello" && entry.frame.p.daemon_id === "dmn_fixture").length === 2 && h.client.connectionState() === "connected", "contention recovery hello");
      await h.settleHeartbeat();
      expect(h.sockets[0]!.frames.some(frame => frame.p?.runtime_acks?.some((ack: any) => ack.runtime_gone))).toBe(true);
      const recovered = h.layer.registry.sessionForRuntime("rt_contended")! as typeof h.sessions[number];
      expect(recovered).not.toBe(later);
      expect(recovered.unavailableRuntimeIds).toEqual([]);
      expect(recovered.sendEvent({ t: "task.offer", rt: "rt_contended", p: { task_id: "offer-after-contention" } }).ok).toBe(true);
      await waitFor(() => h.received.some(frame => frame.p?.task_id === "offer-after-contention"), "contention recovery offer");
      await h.settleHeartbeat();
      expect(runtimesChanged).toHaveBeenCalledTimes(2);
      expect(h.ledger.filter(entry => entry.type === "hello" && entry.frame.p.daemon_id === "dmn_fixture")).toHaveLength(2);
      expect(h.sockets).toHaveLength(2);
      expect(helloSockets).toEqual(h.sockets.map(socket => socket.native));
    } finally { incumbent.close(); }
  });

  it("keeps teardown ordering even when an injected assertion or wait fails", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    try { throw new Error("injected test failure"); }
    catch { await h.dispose(); }
    expect(h.teardownSteps).toEqual(["stop daemon", "drain background", "stop server", "close Store"]);
    expect(h.clock.pendingTimerCount).toBe(0);
  });
});
