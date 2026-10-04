import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { normalizeDaemonRuntimeInput, MultiremiDaemonClient } from "@multiremi/worker/client.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { setFeishuMessageReceipt } from "@connectors/feishu/message-receipt.js";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import { controlPlaneConciergeHost, sendInteractionCardLane } from "../../../apps/remi/cli/multiremi.js";
import type { FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import { openRuntimeDownlinks } from "../../fixtures/runtime-downlinks.js";
import { completed, nativeHarness, transcript } from "../connectors/feishu-native-harness.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

let key: string | undefined, jobs: string | undefined;
let fetchBefore: typeof fetch;
beforeEach(() => {
  key = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  jobs = process.env.MULTIREMI_BACKGROUND_JOBS;
  fetchBefore = globalThis.fetch;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.MULTIREMI_BACKGROUND_JOBS = "1";
});
afterEach(() => {
  if (key === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = key;
  if (jobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS; else process.env.MULTIREMI_BACKGROUND_JOBS = jobs;
  globalThis.fetch = fetchBefore;
  resetMultiremiTestEnv();
});

function flow() {
  const f = configureKindBot(createLocalStore());
  const app = createMultiremiApp({ store: f.store, authToken: "local-test" });
  const inputs = async () => {
    const connection = await openRuntimeDownlinks(f.store, f.runtimeId, {
      activeTaskIds: f.store.listTasks().filter(task => task.status === "running").map(task => task.id),
      capabilities: { feishu_concierge_protocol: 6, feishu_decision_card: 1 },
    });
    try {
      let previous = -1;
      while (connection.frames.length !== previous) {
        previous = connection.frames.length;
        await connection.ack();
      }
      return connection.frames.filter(frame => frame.t === "feishu.outbound").map(frame =>
        normalizeDaemonRuntimeInput(f.runtimeId, { pending_feishu_outbound: frame.p as any }).pending_feishu_outbound!);
    } finally { await connection.close(); }
  };
  const h = nativeHarness();
  const daemon = Object.create(MultiremiDaemon.prototype) as any;
  const reports: any[] = [];
  let lane: string | undefined;
  const handle = {
    appId: f.config.appId,
    resolveProactiveMention: async () => null,
    streamProactiveTask: async (chatId: string, _sessionKey: string, _stream: unknown, meta: any, options: any) => {
      lane = options.lane;
      return new FeishuTaskPresentation(h.client as any, chatId, meta, { lane: options.lane,
        appId: f.config.appId, idempotencyKey: options.durable.idempotencyKey,
        checkpoint: options.durable.presentation, receiptMessageIds: options.receiptMessageIds,
        save: options.onCheckpoint }).consume(transcript());
    },
    sendProactiveCard: async (input: any) => {
      const sent = await h.client.im.message.create({ data: { content: JSON.stringify(input.card), uuid: input.idempotencyKey } });
      return { messageId: sent.data.message_id! };
    },
    sendProactiveReceipt: async (_id: string, state: string) => {
      if (state === "completed") throw new FeishuDeliveryError("Fake channel denies receipt cleanup", false);
    },
  } as unknown as FeishuChannelHandle;
  const host = controlPlaneConciergeHost({ daemon: () => daemon, current: () => handle,
    attach: () => {}, workspacesRoot: () => "/tmp/local-test" });
  Object.assign(daemon, { pollAbort: new AbortController(), options: { serverUrl: "https://remi.example" },
    subscribeTrace: async (_taskId: string, afterSeq: number, callback: (events: any[], closed: boolean) => void) => {
      expect(afterSeq).toBe(0);
      for await (const event of transcript()) if (event.kind === "message") callback([event.message], false);
      callback([], true);
      return async () => {};
    },
    getFeishuBotTaskSnapshot: async () => completed.kind === "snapshot" ? completed.snapshot : null,
    feishuConcierge: host, client: {
      prepareFeishuBotOutboundMention: async (_rt: string, id: string, token: string, openId: string | null) =>
        f.store.prepareFeishuBotOutboundMention("local", f.runtimeId, id, token, openId)?.openId ?? null,
      reportFeishuBotOutboundResult: async (_rt: string, id: string, input: any) => {
        reports.push({ id, ...input });
        if (!f.store.reportFeishuBotOutbound("local", f.runtimeId, id, input)) throw new Error("Test lost its delivery lease");
      },
    } });
  globalThis.fetch = ((input: any, init?: RequestInit) => app.request(new Request(String(input), init))) as typeof fetch;
  const client = new MultiremiDaemonClient("https://remi.example", "local-test");
  return { ...f, h, inputs, reports, lane: () => lane, daemon, client };
}

describe("C5 full fake-channel delivery", () => {
  it("leaves the result sent and binding unchanged when the receipt handler throws a permanent error", async () => {
    const f = flow();
    const taskId = f.inbound("splitflow").taskId;
    const first = await f.inputs();
    expect(first.map(row => row.kind).sort()).toEqual(["cot", "receipt"]);
    f.store.completeTask(taskId, { output: "Final answer", sessionId: "session_original" });
    const binding = db!.query("SELECT * FROM multiremi_feishu_bot_chat_bindings").all();
    for (const row of first) await f.daemon.handleFeishuBotOutbound(f.runtimeId, row);
    expect(f.lane()).toBe("cot");
    expect(f.h.cards()).toHaveLength(0);
    expect(f.h.calls.some(call => call.input.url?.includes("/reactions"))).toBe(false);
    const second = await f.inputs();
    expect(second.map(row => row.kind)).toEqual(["result_card"]);
    await f.daemon.handleFeishuBotOutbound(f.runtimeId, second[0]!);
    const third = await f.inputs();
    expect(third[0]?.receiptState).toBe("completed");
    await f.daemon.handleFeishuBotOutbound(f.runtimeId, third[0]!);
    expect(f.h.cards()).toHaveLength(1);
    expect(JSON.stringify(f.h.cards())).toContain("Final answer");
    expect(JSON.stringify(f.h.cards())).toContain("82k/1M");
    expect(JSON.stringify(f.h.cards())).toContain("1 tools");
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_task_messages WHERE task_id = ?").get(taskId)).toEqual({ count: 0 });
    expect(db!.query("SELECT kind, status FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? ORDER BY kind, unit_key").all(taskId))
      .toEqual([{ kind: "cot", status: "sent" }, { kind: "receipt", status: "failed" },
        { kind: "receipt", status: "sent" }, { kind: "result_card", status: "sent" }]);
    expect(f.reports.at(-1)).toMatchObject({ status: "failed", retryable: false });
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_chat_bindings").all()).toEqual(binding);
    expect(f.store.listFeishuBotAudit("local").filter(row => row.action === "receipt_failed")).toHaveLength(1);
    expect(await f.inputs()).toEqual([]);
  });

  it("recovers a completed reply through protocol v2 while the Runtime API scheduler remains disabled", async () => {
    const f = flow();
    process.env.MULTIREMI_BACKGROUND_JOBS = "0";
    const taskId = f.inbound("runtime_without_jobs").taskId;
    f.store.completeTask(taskId, { output: "Recovered reply", sessionId: "session_original" });
    for (let round = 0; round < 3; round++) {
      for (const row of await f.inputs()) await f.daemon.handleFeishuBotOutbound(f.runtimeId, row);
    }
    expect(f.h.cards()).toHaveLength(1);
    expect(JSON.stringify(f.h.cards())).toContain("Recovered reply");
    expect(JSON.stringify(f.h.cards())).toContain("82k/1M");
    expect(JSON.stringify(f.h.cards())).toContain("1 tools");
    expect(await f.inputs()).toEqual([]);
    expect(process.env.MULTIREMI_BACKGROUND_JOBS).toBe("0");
  });

  it("runs an undeclared daemon through the original bundled flow with unchanged wire fields and one final card", async () => {
    const f = flow();
    const taskId = f.inbound("legacyflow").taskId;
    const legacy = f.store.claimFeishuBotOutbound("local", f.runtimeId, undefined, true, true, true)!;
    expect(legacy).not.toHaveProperty("kind");
    expect(legacy).toMatchObject({ taskId, body: "", receiptMessageIds: ["om_kind_legacyflow"] });
    const reactions: any[] = [];
    const request = f.h.client.request;
    f.h.client.request = async input => {
      if (!input.url.includes("/reactions")) return request(input);
      if (input.method === "GET") return { code: 0, data: { items: reactions } } as any;
      if (input.method === "POST") reactions.push({ reaction_id: "thinking", operator: { operator_type: "app", operator_id: f.config.appId },
        reaction_type: input.data.reaction_type });
      if (input.method === "DELETE") reactions.splice(0);
      return { code: 0, data: input.method === "POST" ? reactions.at(-1) : {} } as any;
    };
    f.store.completeTask(taskId, { output: "Final answer" });
    const normalized = legacy;
    // The old binary's bundled renderer still owns both its result and receipts.
    await setFeishuMessageReceipt(f.h.client as any, f.config.appId, "om_kind_legacyflow", "received");
    expect(reactions).toHaveLength(1);
    await f.daemon.handleFeishuBotOutbound(f.runtimeId, normalized);
    expect(f.lane()).toBeUndefined();
    expect(reactions).toHaveLength(0);
    expect(f.h.cards()).toHaveLength(1);
    expect(f.reports.at(-1)).toMatchObject({ status: "sent", externalMessageId: "om_1" });
    expect(db!.query("SELECT delivery_mode, status FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ?").all(taskId))
      .toEqual([{ delivery_mode: "legacy", status: "sent" }]);
    expect(f.store.claimFeishuBotOutbound("local", f.runtimeId, undefined, true, true, true)).toBeNull();
  });

  it("checkpoints an interaction independently, restores its callback target after restart and patches the same card", async () => {
    const f = configureKindBot(createLocalStore());
    const taskId = f.inbound("interaction").taskId;
    for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
      { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
    const request = f.store.createTaskHumanRequest({ taskId, kind: "question", payload: { questions: [{ question: "Continue?" }] } });
    const delivery = f.store.claimFeishuBotOutbounds("local", f.runtimeId).find(row => row.kind === "interaction_card")!;
    expect(delivery.humanRequestId).toBe(request.id);
    const cot = db!.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = 'cot'").get(taskId) as { id: string };
    expect(delivery.id).not.toBe(cot.id);
    const cards: any[] = [], patches: any[] = [];
    const handle = { appId: f.config.appId,
      sendProactiveCard: async (input: any) => { cards.push(input); return { messageId: "om_question" }; },
      updateProactiveCard: async (id: string, card: any) => { patches.push({ id, card }); },
    } as unknown as FeishuChannelHandle;
    const daemon = { getFeishuBotHumanRequest: async () => f.store.getTaskHumanRequest(request.id),
      getFeishuBotTaskSnapshot: async () => ({ sessionId: "session_original" }),
      prepareTaskHumanRequestCard: async (_taskId: string, requestId: string, recipientOpenId: string) =>
        f.store.prepareTaskStreamQuestionCard(requestId, recipientOpenId),
    } as unknown as MultiremiDaemon;
    await expect(sendInteractionCardLane(handle, delivery, { signal: new AbortController().signal,
      onStarted: async id => {
        expect(f.store.reportFeishuBotOutbound("local", f.runtimeId, delivery.id,
          { claimToken: delivery.claimToken, status: "streaming", externalMessageId: id })).toBe(true);
        throw new Error("Simulated crash after checkpoint");
      } }, daemon)).rejects.toThrow("Simulated crash");
    f.store.respondTaskHumanRequest(request.id, { response: { answers: { "Continue?": "Yes" } }, respondedBy: "test" });
    const resumed = f.store.claimFeishuBotOutbounds("local", f.runtimeId, new Date(Date.now() + 121_000)).find(row => row.id === delivery.id)!;
    expect(resumed.resumeMessageId).toBe("om_question");
    expect(await sendInteractionCardLane(handle, resumed, { signal: new AbortController().signal, onStarted: async () => {} }, daemon)).toEqual({ messageId: "om_question" });
    expect(cards).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("om_question");
    expect(JSON.stringify(cards[0].card)).toContain("Kind bot");
    expect(f.store.getTaskHumanRequest(request.id)?.status).toBe("responded");
  });

  for (const cached of [false, true]) {
    it(`settles an interaction from ${cached ? "a cached" : "a live"} downlink without polling`, async () => {
      const f = configureKindBot(createLocalStore());
      const taskId = f.inbound(`settled_${cached}`).taskId;
      for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) {
        f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
          { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
      }
      const request = f.store.createTaskHumanRequest({ taskId, kind: "question", payload: { questions: [{ question: "Continue?" }] } });
      const delivery = f.store.claimFeishuBotOutbounds("local", f.runtimeId).find(row => row.kind === "interaction_card")!;
      const patches: unknown[] = [];
      let cardSent!: () => void;
      const sent = new Promise<void>(resolve => { cardSent = resolve; });
      const handle = { appId: f.config.appId, resolveProactiveMention: async () => null,
        sendProactiveCard: async () => { cardSent(); return { messageId: "om_settled" }; },
        updateProactiveCard: async (_id: string, card: unknown) => { patches.push(card); },
      } as unknown as FeishuChannelHandle;
      let getCount = 0;
      let release: (() => void) | undefined;
      const settled = new Promise<void>(resolve => { release = resolve; });
      const daemon = {
        getFeishuBotHumanRequest: async () => { getCount += 1; return f.store.getTaskHumanRequest(request.id); },
        getFeishuBotTaskSnapshot: async () => ({ sessionId: "session_original" }),
        prepareTaskHumanRequestCard: async (_taskId: string, requestId: string, recipientOpenId: string) =>
          f.store.prepareTaskStreamQuestionCard(requestId, recipientOpenId),
        waitFeishuBotHumanRequestSettled: async () => { if (!cached) await settled; return f.store.getTaskHumanRequest(request.id); },
      } as unknown as MultiremiDaemon;
      const respond = () => f.store.respondTaskHumanRequest(request.id,
        { response: { answers: { "Continue?": "Yes" } }, respondedBy: "test" });
      const run = sendInteractionCardLane(handle, delivery, { signal: new AbortController().signal,
        onStarted: async () => { if (cached) respond(); },
      }, daemon);
      await sent;
      if (!cached) {
        await Bun.sleep(30);
        expect(getCount).toBe(1);
        respond();
        release!();
      }
      expect(await run).toEqual({ messageId: "om_settled" });
      expect(getCount).toBe(2);
      expect(patches).toHaveLength(1);
      expect(JSON.stringify(patches[0])).toContain("Yes");
    });
  }

  it("records a permanently rejected native CoT as failed while the independent result handler still delivers", async () => {
    const f = flow();
    const taskId = f.inbound("cotrefusal").taskId;
    const initial = await f.inputs();
    f.store.completeTask(taskId, { output: "Final answer" });
    f.h.client.request = async () => ({ code: 230001, msg: "Permanent fake CoT refusal", data: {} }) as any;
    for (const row of initial) await f.daemon.handleFeishuBotOutbound(f.runtimeId, row);
    const cot = db!.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = 'cot'").get(taskId);
    expect(cot).toEqual({ status: "failed" });
    const next = await f.inputs();
    const result = next.find(row => row.kind === "result_card")!;
    expect(result).toBeDefined();
    await f.daemon.handleFeishuBotOutbound(f.runtimeId, result);
    expect(f.h.cards()).toHaveLength(1);
    expect(db!.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(result.id)).toEqual({ status: "sent" });
  });
});
