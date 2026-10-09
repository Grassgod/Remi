import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
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
import { createLocalStore, db, resetMultiremiTestEnv } from "./feishu-host-store-fixture.js";

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
  setSystemTime();
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

/** A real native Q in the original transport Chat, with one explicitly mapped human. */
function questionFlow() {
  const store = createLocalStore();
  const member = store.getWorkspaceMember("mem_local_local")!;
  const user = store.getOrCreateUser({ externalId: "ou_kind_owner", name: "Kind question human" });
  db!.run("UPDATE multiremi_workspace_members SET user_id=? WHERE id=?", [user.id, member.id]);
  db!.run("UPDATE multiremi_users SET feishu_union_id=? WHERE id=?", ["on_kind_owner", user.id]);
  const seen = new Date().toISOString();
  db!.run(`INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at)
    VALUES('fbs_kind_human','local','cli_kind_test','ou_kind_owner','on_kind_owner','Human',1,?,?)`, [seen, seen]);
  const f = configureKindBot(store, "local", "rt_kinds", member.id);
  store.registerRuntime({ id: f.runtimeId, name: "Kind question host", provider: "codex", workspaceId: "local",
    daemonId: `daemon_${f.runtimeId}`, maxConcurrency: 16 });
  store.heartbeatRuntime(f.runtimeId, { supportsFeishuBotConfig: true, supportsDecisionCard: true });
  const ask = (taskId: string) => {
    const turn = store.getTurnForAttempt(taskId)!;
    const created = store.getDaemonTurnBridge().rpc("turn.decision", {
      turn_id: turn.id, attempt_id: taskId, wait_id: `kind-wait:${taskId}`, dedupe_key: `kind-q:${taskId}`,
      body_md: "Continue?", options: [{ label: "Yes", value: "Yes" }],
      metadata: { kind: "question", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
    }, { runtimeId: f.runtimeId, daemonId: `daemon_${f.runtimeId}`, workspaceId: "local" });
    expect(created.ok).toBe(true);
    const request = store.getTaskHumanRequest(String(created.message_id))!;
    expect(store.getQuestion(request.id)).toMatchObject({ session_id: turn.session_id, wait_status: "waiting",
      current_handler: { type: "member", id: member.id } });
    return request;
  };
  const respond = (id: string) => store.respondTaskHumanRequest(id, {
    response: { answers: { "Continue?": "Yes" } }, respondedBy: member.id,
    expectedRouteRevision: store.getQuestion(id)!.route_revision,
  });
  const interaction = () => {
    // Native presentation starts as a durable operation. Its materialized row
    // may become available after the first drain's captured clock; the second
    // drain claims that ready row without sleeping or polling the answer.
    const rows = [...store.claimFeishuBotOutbounds("local", f.runtimeId),
      ...store.claimFeishuBotOutbounds("local", f.runtimeId)];
    expect(rows.filter(row => row.kind === "interaction_card")).toHaveLength(1);
    return rows.find(row => row.kind === "interaction_card")!;
  };
  return { ...f, ask, respond, interaction };
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
    expect(db!.query("SELECT CAST(COUNT(*) AS INTEGER) AS count FROM multiremi_task_messages WHERE task_id = ?").get(taskId)).toEqual({ count: 0 });
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
    const f = questionFlow();
    const taskId = f.inbound("interaction").taskId;
    for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
      { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
    const request = f.ask(taskId);
    const delivery = f.interaction();
    expect(delivery.humanRequestId).toBe(request.id);
    expect(delivery.interactionOpenId).toBe("ou_kind_owner");
    const cot = db!.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ? AND kind = 'cot'").get(taskId) as { id: string };
    expect(delivery.id).not.toBe(cot.id);
    const cards: any[] = [], patches: any[] = [];
    const handle = { appId: f.config.appId, resolveProactiveMention: async () => "ou_kind_owner",
      sendProactiveCard: async (input: any) => { cards.push(input); return { messageId: "om_question" }; },
      updateProactiveCard: async (id: string, card: any) => { patches.push({ id, card }); },
    } as unknown as FeishuChannelHandle;
    const daemon = { getFeishuBotHumanRequest: async () => f.store.getTaskHumanRequest(request.id),
      getFeishuBotTaskSnapshot: async () => ({ sessionId: "session_original" }),
      prepareTaskHumanRequestCard: async (requestId: string, recipientOpenId: string) =>
        f.store.prepareTaskStreamQuestionCard(requestId, recipientOpenId),
    } as unknown as MultiremiDaemon;
    await expect(sendInteractionCardLane(handle, { ...delivery, interactionOpenId: "ou_kind_sender" }, {
      signal: new AbortController().signal, onStarted: async () => { throw new Error("Must not checkpoint the wrong person's card"); },
    }, daemon)).rejects.toThrow("no longer authorized");
    expect(cards).toHaveLength(0);
    await expect(sendInteractionCardLane(handle, delivery, { signal: new AbortController().signal,
      onStarted: async id => {
        expect(f.store.reportFeishuBotOutbound("local", f.runtimeId, delivery.id,
          { claimToken: delivery.claimToken, status: "streaming", externalMessageId: id })).toBe(true);
        throw new Error("Simulated crash after checkpoint");
      } }, daemon)).rejects.toThrow("Simulated crash");
    f.respond(request.id);
    const resumed = f.store.claimFeishuBotOutbounds("local", f.runtimeId, new Date(Date.now() + 121_000)).find(row => row.id === delivery.id)!;
    expect(resumed.resumeMessageId).toBe("om_question");
    expect(await sendInteractionCardLane(handle, resumed, { signal: new AbortController().signal, onStarted: async () => {} }, daemon)).toEqual({ messageId: "om_question" });
    expect(cards).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("om_question");
    expect(JSON.stringify(cards[0].card)).toContain("Kind bot");
    expect(f.store.getTaskHumanRequest(request.id)?.status).toBe("responded");
    expect(f.store.getQuestion(request.id)?.answer?.actor).toEqual({ type: "member", id: "mem_local_local" });
  });

  for (const cached of [false, true]) {
    it(`settles an interaction from ${cached ? "a cached" : "a live"} downlink without polling`, async () => {
      const f = questionFlow();
      const taskId = f.inbound(`settled_${cached}`).taskId;
      for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) {
        f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
          { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
      }
      const request = f.ask(taskId);
      const delivery = f.interaction();
      expect(delivery.interactionOpenId).toBe("ou_kind_owner");
      const patches: unknown[] = [];
      let cardSent!: () => void;
      const sent = new Promise<void>(resolve => { cardSent = resolve; });
      const handle = { appId: f.config.appId, resolveProactiveMention: async () => null,
        sendProactiveCard: async (input: any) => { expect(input.card).not.toBeNull(); cardSent(); return { messageId: "om_settled" }; },
        updateProactiveCard: async (_id: string, card: unknown) => { patches.push(card); },
      } as unknown as FeishuChannelHandle;
      let getCount = 0;
      let release: (() => void) | undefined;
      const settled = new Promise<void>(resolve => { release = resolve; });
      const daemon = {
        getFeishuBotHumanRequest: async () => { getCount += 1; return f.store.getTaskHumanRequest(request.id); },
        getFeishuBotTaskSnapshot: async () => ({ sessionId: "session_original" }),
        prepareTaskHumanRequestCard: async (requestId: string, recipientOpenId: string) =>
          f.store.prepareTaskStreamQuestionCard(requestId, recipientOpenId),
        waitFeishuBotHumanRequestSettled: async () => { if (!cached) await settled; return f.store.getTaskHumanRequest(request.id); },
      } as unknown as MultiremiDaemon;
      const respond = () => f.respond(request.id);
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

  it("degrades an unmapped root human to the original Q without mentioning the transport sender", async () => {
    const f = questionFlow();
    const taskId = f.inbound("unmapped_human").taskId;
    for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
      { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
    db!.run("DELETE FROM multiremi_feishu_bot_senders WHERE id='fbs_kind_human'");
    const request = f.ask(taskId), delivery = f.interaction();
    expect(delivery.degraded).toBe("unresolved_recipient");
    expect(delivery.interactionOpenId).toBeUndefined();
    const text: string[] = [];
    const handle = { appId: f.config.appId,
      resolveProactiveMention: async () => { throw new Error("Must not guess the group owner"); },
      sendProactiveCard: async () => { throw new Error("Must not send an unauthorized card"); },
      sendProactiveThreadReply: async (input: any) => { text.push(input.body); return { messageId: "om_web_fallback" }; },
    } as unknown as FeishuChannelHandle;
    const daemon = { getFeishuBotHumanRequest: async () => f.store.getTaskHumanRequest(request.id) } as unknown as MultiremiDaemon;
    expect(await sendInteractionCardLane(handle, delivery, { signal: new AbortController().signal, onStarted: async () => {} }, daemon))
      .toEqual({ messageId: "om_web_fallback" });
    expect(text).toHaveLength(1);
    expect(text[0]).toContain(request.id); expect(text[0]).toContain("Continue?"); expect(text[0]).toContain("Yes");
    expect(text[0]).toContain("Remi 工作台"); expect(text[0]).not.toContain("<at"); expect(text[0]).not.toContain("ou_kind_sender");
    expect(f.store.getQuestion(request.id)?.status).toBe("pending");
  });

  it("waits for Remi presentation before a transport Chat card and only falls back at the summary deadline", () => {
    const f = questionFlow();
    const worker = f.store.createAgent({ name: "Chat worker", provider: "codex", runtimeId: f.runtimeId });
    f.store.replaceFeishuBotAgentRoutes("local", [{ scope: "chat", chatId: "oc_kind_summary_gate", agentId: worker.id }]);
    const taskId = f.inbound("summary_gate").taskId;
    for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
      { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
    const request = f.ask(taskId);
    const deadline = Date.parse(String(request.payload.question_summary_wait_until));
    expect(Number.isFinite(deadline)).toBe(true);
    for (let i = 0; i < 2; i++) expect(f.store.claimFeishuBotOutbounds("local", f.runtimeId).filter(row => row.kind === "interaction_card")).toEqual([]);
    expect(f.store.getQuestion(request.id)?.summary).toBeNull();
    setSystemTime(new Date(deadline + 1));
    const card = f.interaction();
    expect(card.humanRequestId).toBe(request.id); expect(card.interactionOpenId).toBe("ou_kind_owner");
    expect(f.store.getQuestion(request.id)?.original_message).toBe("Continue?");
  });

  it("authorizes Remi only in the notified Chat lane to read and present the same original worker Q", async () => {
    const f = questionFlow();
    const worker = f.store.createAgent({ name: "Private Chat worker", provider: "codex", runtimeId: f.runtimeId, visibility: "private" });
    f.store.replaceFeishuBotAgentRoutes("local", [{ scope: "chat", chatId: "oc_kind_present_lane", agentId: worker.id }]);
    const taskId = f.inbound("present_lane").taskId;
    for (const row of f.store.claimFeishuBotOutbounds("local", f.runtimeId)) f.store.reportFeishuBotOutbound("local", f.runtimeId, row.id,
      { claimToken: row.claimToken, status: "sent", externalMessageId: `om_${row.id}` });
    const request = f.ask(taskId), original = f.store.getQuestion(request.id)!;
    const record = f.store.getMessage(request.id)!.metadata.question as { presentation_session_id: string };
    const notification = f.store.listMessages(record.presentation_session_id).find(message => message.metadata.question_present_request === true)!;
    expect(notification.metadata.root_question_id).toBe(request.id); expect(notification.reply_to_id).toBeNull();
    expect(notification.session_id).not.toBe(original.session_id);
    const turn = f.store.getTurn(String(notification.metadata.delivery_turn_id))!;
    const claimed = f.store.claimTask(f.runtimeId)!;
    expect(claimed.id).toBe(turn.current_attempt_id!); f.store.startTask(claimed.id);
    const token = await f.store.createTaskAccessToken(f.store.getTask(claimed.id)!, "local");
    const app = createMultiremiApp({ store: f.store, authToken: "kind-question-master" });
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
    expect((await app.request(`/api/messages/${request.id}/question`, { headers })).status).toBe(200);
    expect((await app.request(`/api/messages/${request.id}`, { headers })).status).toBe(403);
    const unrelated = f.store.createChatSession({ agentId: f.agent.id, creatorId: "local", title: "Unrelated Remi work" });
    const other = f.store.createTask({ agentId: f.agent.id, chatSessionId: unrelated.id, prompt: "No Q notification", priority: 100 });
    expect(f.store.claimTask(f.runtimeId)?.id).toBe(other.id); f.store.startTask(other.id);
    const otherToken = await f.store.createTaskAccessToken(f.store.getTask(other.id)!, "local");
    const wrong = { Authorization: `Bearer ${otherToken.token}`, "Content-Type": "application/json" };
    expect((await app.request(`/api/messages/${request.id}/question`, { headers: wrong })).status).toBe(403);
    expect((await app.request(`/api/messages/${request.id}/question/present`, { method: "POST", headers: wrong,
      body: JSON.stringify({ expected_route_revision: original.route_revision, summary: "Wrong lane" }) })).status).toBe(403);
    const presented = await app.request(`/api/messages/${request.id}/question/present`, { method: "POST", headers,
      body: JSON.stringify({ expected_route_revision: original.route_revision, summary: "Read the worker's original options" }) });
    expect(presented.status, await presented.clone().text()).toBe(200);
    const card = f.interaction();
    expect(card.humanRequestId).toBe(request.id); expect(card.interactionOpenId).toBe("ou_kind_owner");
    expect(f.store.getQuestion(request.id)?.session_id).toBe(original.session_id);
    expect(f.store.getQuestion(request.id)?.summary?.body_md).toBe("Read the worker's original options");
    const nextUser = f.store.getOrCreateUser({ externalId: "kind-next-human", name: "New responsible human" });
    const next = f.store.createWorkspaceMember({ workspaceId: "local", userId: nextUser.id, name: nextUser.name, role: "member" });
    f.store.upsertFeishuBotConfig("local", { agentId: f.agent.id, runtimeId: f.runtimeId, appId: f.config.appId,
      appSecretOp: "keep", domain: "feishu", enabled: true, responsibleMemberId: next.id });
    const moved = f.store.getQuestion(request.id)!;
    expect(moved.current_handler).toEqual({ type: "member", id: next.id });
    expect(moved.session_id).toBe(original.session_id);
    const newRecord = f.store.getMessage(request.id)!.metadata.question as { presentation_session_id: string };
    expect(newRecord.presentation_session_id).not.toBe(record.presentation_session_id);
    expect(f.store.getChatSession(newRecord.presentation_session_id)).toMatchObject({ creatorId: nextUser.id, agentId: f.agent.id, workspaceId: "local" });
    expect((await app.request(`/api/messages/${request.id}/question`, { headers })).status).toBe(403);
    expect((await app.request(`/api/messages/${request.id}/question/present`, { method: "POST", headers,
      body: JSON.stringify({ expected_route_revision: moved.route_revision, summary: "Old notification" }) })).status).toBe(403);
    const oldHuman = await f.store.createAccessToken({ type: "pat", name: "Previous human", workspaceId: "local",
      userId: f.store.getWorkspaceMember("mem_local_local")!.userId! });
    expect((await app.request(`/api/sessions/${newRecord.presentation_session_id}/messages`,
      { headers: { Authorization: `Bearer ${oldHuman.token}` } })).status).toBe(403);
  });

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
