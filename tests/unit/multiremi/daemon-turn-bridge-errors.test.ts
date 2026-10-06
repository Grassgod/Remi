import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { DAEMON_MIN_CLI_VERSION, daemonFrameCategory } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { registerDaemonReportHandlers } from "@multiremi/api/daemon-protocol/report-handlers.js";
import { registerTaskInputRpcs } from "@multiremi/api/daemon-protocol/task-input-rpcs.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";

const backends = await traceBackfillBackends("turnerrors");
afterAll(async () => { for (const backend of backends) await backend.dispose(); });

async function withTurn(backend: (typeof backends)[number], body: (world: Awaited<ReturnType<typeof openTurn>>) => Promise<void>) {
  const world = await openTurn(backend);
  try { await body(world); } finally { await world.close(); }
}

async function openTurn(backend: (typeof backends)[number]) {
  const opened = await backend.open();
  const { store, db } = opened;
  const runtime = store.registerRuntime({ daemonId: "turn-errors-daemon", name: "Turn errors", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "Turn errors", provider: "claude", runtimeId: runtime.id, workspaceId: "local" });
  const bridge = store.getDaemonTurnBridge();
  const layer = new DaemonProtocolLayer({ store });
  registerDaemonReportHandlers(layer, store, undefined, bridge);
  registerTaskInputRpcs(layer, store, () => {}, bridge);
  const frames: Array<Record<string, any>> = [];
  const session = layer.openSession({ bufferedAmount: 0,
    send(text) { frames.push(JSON.parse(text)); return Buffer.byteLength(text); }, close() {},
  }, { accessToken: null, masterToken: true });
  const close = async () => { session.handleSocketClose(); layer.stop(); await opened.close(); };
  try {
    const issue = store.createIssue({ title: "Turn rejection", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Short input" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: runtime.daemonId,
      runtimes: [{ runtime_id: runtime.id, provider: "claude", max_concurrency: 1, active_task_ids: [task.id] }],
    } }));
    const offer = bridge.offerInput(store.getTaskWithAgent(task.id)!);
    const scope = { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: "local" };
    const input = { turn_id: offer.turn_id, attempt_id: task.id, input_to_seq: offer.input_to_seq,
      message_ids: offer.input_messages.map(message => message.id) };
    const completion = { turn_id: offer.turn_id, attempt_id: task.id, input_to_seq: offer.input_to_seq,
      reply: { body_md: "Done", message_kind: "final" as const } };
    let counter = 0;
    const report = async (type: string, payload: Record<string, unknown>) => {
      const seq = ++counter, event = daemonFrameCategory(type) === "event", re = String(seq);
      await session.handleMessage(JSON.stringify({ v: 2, t: type, rt: runtime.id, ...(event ? { seq } : { id: re }), p: payload }));
      const reply = frames.find(frame => frame.t === "res" && frame.re === re);
      if (!reply) throw new Error(`Missing ${type} response`);
      return reply.p as Record<string, unknown>;
    };
    return { store, db, runtime, task, offer, scope, bridge, input, completion, report, close };
  } catch (error) { await close(); throw error; }
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`daemon turn error classification (${backend.name})`, () => {
    it("keeps stale bindings, input gaps and invalid reports permanent", async () => {
      await withTurn(backend, async world => {
        const { bridge, scope, input, completion, report, store, task } = world;
        for (const override of [{ runtimeId: "rt_other" }, { daemonId: "other" }, { workspaceId: "other" }]) {
          expect(bridge.rpc("turn.input", input, { ...scope, ...override }))
            .toMatchObject({ ok: false, code: "stale_attempt", retryable: false });
          expect(bridge.complete({ payload: completion, completionFields: null }, { ...scope, ...override }))
            .toMatchObject({ ok: false, code: "stale_attempt", retryable: false });
        }
        expect(await report("turn.complete", { ...completion, attempt_id: "missing" }))
          .toMatchObject({ ok: false, code: "stale_attempt", retryable: false });
        expect(await report("turn.input", { ...input, input_to_seq: input.input_to_seq + 1 }))
          .toMatchObject({ ok: false, code: "input_gap", retryable: false });
        expect(await report("turn.decision.get", { ...input, message_id: "missing" }))
          .toMatchObject({ ok: false, code: "invalid_report", retryable: false });
        const members = spyOn(store, "listWorkspaceMembers").mockReturnValue([]);
        try {
          expect(await report("turn.decision", { ...input, body_md: "Pick", dedupe_key: "no-owner",
            options: [{ label: "A", value: "a" }], metadata: {} }))
            .toMatchObject({ ok: false, code: "invalid_report", retryable: false });
        } finally { members.mockRestore(); }
        store.cancelTask(task.id);
        expect(await report("turn.complete", completion))
          .toMatchObject({ ok: false, code: "invalid_report", retryable: false });
      });
    }, 60_000);

    it("keeps completeTask's explicit destination and lifecycle refusals permanent", async () => {
      await withTurn(backend, async world => {
        const refuse = spyOn(world.store, "completeTask");
        try {
          for (const message of [`Task not found or terminal: ${world.task.id}`, `Runtime not found: ${world.runtime.id}`,
            `Chat task destination no longer matches its Issue: ${world.task.id}`,
            "Turn not found", "Input acknowledgement must be contiguous and bounded by the log head",
            "Message conversation not found", "Source turn not found", "Source turn does not belong to the sender workspace",
            "Message sender belongs to another workspace", "Message recipient belongs to another workspace"]) {
            refuse.mockImplementation(() => { throw new Error(message); });
            expect(await world.report("turn.complete", world.completion))
              .toMatchObject({ ok: false, code: "invalid_report", retryable: false });
          }
          for (const code of ["stale_attempt", "input_gap", "invalid_report"]) {
            refuse.mockImplementation(() => { throw new Error(code); });
            expect(await world.report("turn.complete", world.completion))
              .toMatchObject({ ok: false, code: code === "stale_attempt" ? code : "invalid_report", retryable: false });
          }
        } finally { refuse.mockRestore(); }
        expect(world.store.getTask(world.task.id)?.status).toBe("running");
      });
    }, 60_000);

    it("returns retryable server errors for unknown completion failures, including non-Errors", async () => {
      await withTurn(backend, async world => {
        const write = spyOn(world.store, "completeTask");
        try {
          // Similar text must not accidentally match a known rejection prefix.
          for (const error of [new Error(`Runtime not found: ${world.runtime.id}; connection reset`), "write unavailable"]) {
            write.mockImplementation(() => { throw error; });
            expect(await world.report("turn.complete", world.completion))
              .toMatchObject({ ok: false, code: "server_error", retryable: true });
          }
        } finally { write.mockRestore(); }
        expect(world.store.getTask(world.task.id)?.status).toBe("running");
        expect(await world.report("turn.complete", world.completion)).toMatchObject({ ok: true });
      });
    }, 60_000);

    it("rolls back a failed decision RPC and allows the same request to replay", async () => {
      await withTurn(backend, async world => {
        const before = world.store.listConversationLogEntries(world.task.issueSessionId!);
        const payload = { ...world.input, body_md: "Pick", dedupe_key: "replay-decision",
          options: [{ label: "A", value: "a" }], metadata: {} };
        const run = world.db.run.bind(world.db);
        const write = spyOn(world.db, "run").mockImplementation((sql, params) => {
          // Fail after the decision insert, while still inside the RPC transaction.
          if (sql.startsWith("UPDATE multiremi_turn_attempts SET projection_to_seq=CASE")) throw new Error("injected decision write failure");
          return run(sql, params);
        });
        let reply: Record<string, unknown>;
        try { reply = await world.report("turn.decision", payload); } finally { write.mockRestore(); }
        expect(world.store.listConversationLogEntries(world.task.issueSessionId!)).toEqual(before);
        expect(world.store.getTask(world.task.id)?.status).toBe("running");
        expect(reply!).toMatchObject({ ok: false, code: "server_error", retryable: true });
        const replay = await world.report("turn.decision", payload);
        expect(replay).toMatchObject({ ok: true, message: { message_kind: "decision" } });
        expect((await world.report("turn.decision", payload)).message_id).toBe(replay.message_id);
        expect(world.store.listConversationLogEntries(world.task.issueSessionId!)
          .filter(entry => entry.kind === "message" && world.store.getMessage(entry.id)?.message_kind === "decision")).toHaveLength(1);
      });
    }, 60_000);
  });
}
