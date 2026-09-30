import { reportFrame, reportTraceSink } from "../../fixtures/report-session.js";
/**
 * Control-plane delivery of the Feishu concierge assignment (MUL-206).
 *
 * The daemon learns about the bot in two steps: a heartbeat directive that says
 * only "revision N, please be running", and a runtime-scoped fetch that returns
 * the credentials. Splitting them is the whole point — a heartbeat ack is
 * logged and cached in more places than a credential should ever reach.
 *
 * The other half of this file is the handover. One workspace's bot may run in
 * exactly one place; a Runtime switch has to be a baton pass, not a moment when
 * two connectors answer the same Feishu app.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { openRuntimeDownlinks, receiveRuntimeInputs, requestRuntimeRpc } from "../../fixtures/runtime-downlinks.js";
import { startMultiremiServer } from "../../fixtures/daemon-protocol.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { outboxRecordFrame } from "@multiremi/worker/report-frames.js";
import { DaemonProtocolRpcError } from "@multiremi/worker/daemon-protocol-client.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { daemonReportTransport } from "@multiremi/worker/report-transport.js";
import { deliverFeishuOutbound } from "@multiremi/worker/feishu-outbound.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { DAEMON_PROTOCOL_MIN } from "@multiremi/contracts/daemon-protocol.js";
import { createLocalStore, db, resetMultiremiTestEnv, useUploadDir } from "./helpers.js";
import { deriveStatus } from "@multiremi/store/repos/feishu-bot-repo.js";
import { degradeMarkdownImages } from "@shared/feishu-markdown-images.js";
import { questionCardAction } from "@shared/feishu-task-card.js";
import {
  FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER,
  FEISHU_CONCIERGE_OUTBOUND_LEGACY_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_TASK_STREAM_PROTOCOL_VERSION,
  FEISHU_CONCIERGE_NATIVE_COT_PROTOCOL_VERSION,
  type MultiremiFeishuBotRuntimeStatus,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { uploadedAttachmentPath } from "@multiremi/api/helpers/uploads.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

let previousEncryptionKey: string | undefined;
let previousPublicUrl: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  previousPublicUrl = process.env.MULTIREMI_PUBLIC_URL;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  delete process.env.MULTIREMI_PUBLIC_URL;
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousPublicUrl === undefined) delete process.env.MULTIREMI_PUBLIC_URL;
  else process.env.MULTIREMI_PUBLIC_URL = previousPublicUrl;
  resetMultiremiTestEnv();
});

interface Scaffold {
  store: MultiremiStore;
  app: ReturnType<typeof createMultiremiApp>;
  agentId: string;
  /** Daemon tokens, keyed by the Runtime they are bound to. */
  tokens: Record<string, string>;
}

/**
 * A configured workspace with two concierge-capable Runtimes, each with its own
 * daemon token, so cross-Runtime access can actually be attempted.
 */
async function scaffold(): Promise<Scaffold> {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  const tokens: Record<string, string> = {};
  for (const suffix of ["a", "b"]) {
    store.registerRuntime({
      id: `rt_${suffix}`,
      name: `Host ${suffix}`,
      provider: "codex",
      workspaceId: "local",
      daemonId: `daemon-${suffix}`,
    });
    store.heartbeatRuntime(`rt_${suffix}`, { supportsFeishuBotConfig: true });
    const token = await store.createAccessToken({
      name: `daemon-${suffix}`,
      type: "daemon",
      workspaceId: "local",
      daemonId: `daemon-${suffix}`,
    });
    tokens[`rt_${suffix}`] = token.token;
  }
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  const saved = await app.request("/api/workspaces/local/feishu-bot", {
    method: "PUT",
    headers: MASTER,
    body: JSON.stringify({
      agent_id: agent.id,
      runtime_id: "rt_a",
      app_id: "cli_a1b2c3d4e5f6g7h8",
      domain: "feishu",
      enabled: true,
      app_secret: APP_SECRET,
    }),
  });
  if (saved.status !== 200) throw new Error(`scaffold config failed: ${saved.status}`);
  return { store, app, agentId: agent.id, tokens };
}

function daemonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function heartbeat(scaffolded: Scaffold, runtimeId: string, body: Record<string, unknown> = {}) {
  const ack = await scaffolded.app.request("/api/daemon/heartbeat", {
    method: "POST",
    headers: daemonHeaders(scaffolded.tokens[runtimeId]!),
    body: JSON.stringify({
      runtime_id: runtimeId,
      feishu_concierge_protocol: FEISHU_CONCIERGE_OUTBOUND_PROTOCOL_VERSION,
      ...body,
    }),
  });
  if (!ack.ok) return ack;
  expect((await ack.json()).pending_feishu_outbound).toBeUndefined();
  const input = await receiveRuntimeInputs(scaffolded.store, runtimeId, { identity: {
    accessToken: await scaffolded.store.verifyAccessToken(scaffolded.tokens[runtimeId]!), masterToken: false,
  } });
  return Response.json(input);
}

async function report(
  scaffolded: Scaffold,
  runtimeId: string,
  body: Record<string, unknown>,
) {
  return reportFrame(scaffolded.store, "concierge.status", { runtime_id: runtimeId, ...body }, { headers: daemonHeaders(scaffolded.tokens[runtimeId]!), authToken: "MASTER" });
}

function queuedClient(test: Scaffold, canSend = () => true, timeoutMs = 30_000) {
  const box = new MultiremiTaskReportOutbox({ path: ":memory:", canSend, deliver: async row => {
    const frame = outboxRecordFrame(row);
    const result = await reportFrame(test.store, frame.t, frame.p as Record<string, unknown>, {
      headers: daemonHeaders(test.tokens.rt_a!), authToken: "MASTER",
    });
    if (result.ok === false) throw new DaemonProtocolRpcError(result.code, result.retryable);
    return result;
  } });
  const client = new MultiremiDaemonClient("http://unused", "unused", { requestTimeoutMs: timeoutMs });
  client.setReportTransport(daemonReportTransport({} as never, () => "rt_a", () => box));
  return { client, box };
}

describe("Feishu bot control-plane delivery", () => {
  it("pushes a new outbound immediately, replays pre-ACK work and applies the result once", async () => {
    const test = await scaffold();
    test.store.heartbeatRuntime("rt_a", { claimPending: false, supportsFeishuBotConfig: true });
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    let layer!: DaemonProtocolLayer;
    const server = startMultiremiServer({ store: test.store, authToken: "MASTER", hostname: "127.0.0.1", port: 0,
      onDaemonProtocol: value => { layer = value; } });
    const sockets = new Set<WebSocket>();
    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + 2_000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error("Feishu outbound push did not arrive");
        await Bun.sleep(1);
      }
    };
    const connect = async () => {
      const frames: Array<Record<string, any>> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
        { headers: { Authorization: `Bearer ${test.tokens.rt_a!}` } } as never);
      sockets.add(socket);
      socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Feishu socket failed")), { once: true });
      });
      socket.send(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: "daemon-a",
        cli_version: DAEMON_MIN_CLI_VERSION, caps: [], runtimes: [{ runtime_id: "rt_a", provider: "codex",
          max_concurrency: 1, active_task_ids: [] }] } }));
      await waitFor(() => frames.some(frame => frame.t === "welcome")); await layer.drain();
      return { socket, frames };
    };
    const close = async (socket: WebSocket) => {
      if (socket.readyState !== WebSocket.CLOSED) await new Promise<void>(resolve => {
        socket.addEventListener("close", () => resolve(), { once: true }); socket.close();
      });
      sockets.delete(socket); await waitFor(() => layer.registry.size === 0); await layer.drain();
    };
    const read = (id: string) => db!.query("SELECT status, attempt_count, external_message_id FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(id);
    try {
      const first = await connect();
      first.socket.send(JSON.stringify({ v: 2, t: "ack", ack: (layer.registry.sessionForRuntime("rt_a")! as DaemonProtocolSession).lastSentSeq, p: {} }));
      const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
        revision: 1, externalSessionKey: "oc_push_outbound", externalMessageId: "om_push_outbound",
        chatId: "oc_push_outbound", chatType: "p2p", text: "Push now", deliveryMode: "native_cot_v1",
      });
      await waitFor(() => first.frames.some(frame => frame.t === "feishu.outbound"));
      const offer = first.frames.find(frame => frame.t === "feishu.outbound")!;
      expect(offer.p).toMatchObject({ task_id: submitted.taskId, chat_id: "oc_push_outbound",
        receipt_message_ids: ["om_push_outbound"], presentation: { version: "native_cot_v1", throughSeq: 0 } });
      expect(read(offer.p.id)).toMatchObject({ status: "pending", attempt_count: 0 });
      await close(first.socket);
      expect(read(offer.p.id)).toMatchObject({ status: "pending", attempt_count: 0 });
      const second = await connect();
      await waitFor(() => second.frames.some(frame => frame.t === "feishu.outbound"));
      const replay = second.frames.find(frame => frame.t === "feishu.outbound")!;
      expect(replay.p).toMatchObject({ id: offer.p.id, task_id: submitted.taskId,
        body: offer.p.body, idempotency_key: offer.p.idempotency_key });
      expect(replay.p).toEqual(offer.p);
      const ack = JSON.stringify({ v: 2, t: "ack", ack: replay.seq, p: {} });
      second.socket.send(ack); second.socket.send(ack);
      await waitFor(() => (read(offer.p.id) as { status: string }).status === "sending");
      expect(read(offer.p.id)).toMatchObject({ status: "sending", attempt_count: 1 });
      const result = { claimToken: replay.p.claim_token, status: "sent" as const, externalMessageId: "om_native_outbound" };
      expect(test.store.reportFeishuBotOutbound("local", "rt_a", offer.p.id, result)).toBe(true);
      const settled = read(offer.p.id);
      expect(test.store.reportFeishuBotOutbound("local", "rt_a", offer.p.id, result)).toBe(false);
      expect(read(offer.p.id)).toEqual(settled);
      expect(settled).toMatchObject({ status: "sent", attempt_count: 1, external_message_id: "om_native_outbound" });
      await close(second.socket);
    } finally {
      for (const socket of sockets) await close(socket);
      layer.closeAll(); await layer.drain(); server.stop(true);
    }
  });

  it("absorbs a sent result replay without another write or activity and drains its runtime partition", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1, externalSessionKey: "oc_replay", externalMessageId: "om_replay", chatId: "oc_replay",
      text: "start", deliveryMode: "native_cot_v1",
    });
    const delivery = test.store.claimFeishuBotOutbound("local", "rt_a", undefined, true, true)!;
    const payload = { runtime_id: "rt_a", request_id: delivery.id, claim_token: delivery.claimToken,
      status: "sent", external_message_id: "om_result" };
    const send = (type: string, p: Record<string, unknown>) => reportFrame(test.store, type, p, {
      headers: daemonHeaders(test.tokens.rt_a!), authToken: "MASTER",
    });
    expect(await send("feishu.outbound_result", payload)).toEqual({ ok: true });
    const before = db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id);
    const activities = db!.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity").get();
    const received: string[] = [];
    const box = new MultiremiTaskReportOutbox({ path: ":memory:", deliver: async row => {
      const frame = outboxRecordFrame(row);
      const result = await send(frame.t, frame.p as Record<string, unknown>);
      if (!result.ok) throw new DaemonProtocolRpcError(result.code, result.retryable);
      received.push(frame.t);
    } });
    try {
      box.enqueue("rt:rt_a", "feishu.outbound_result", payload);
      box.enqueue("rt:rt_a", "runtime.model_list_result", { runtime_id: "rt_a", models: [{ id: "after-replay" }] });
      await box.flushAll();
      expect(received).toEqual(["feishu.outbound_result", "runtime.model_list_result"]);
      expect(box.stats()).toMatchObject({ pending: 0, blocked: 0 });
      expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id)).toEqual(before);
      expect(db!.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity").get()).toEqual(activities);
      expect(test.store.getTask(submitted.taskId!)).not.toBeNull();
    } finally { await box.close(); }
  });

  it("absorbs an old failed result after re-leasing and a wrong token without changing the current lease", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    test.store.submitFeishuBotMessage("local", "rt_a", { revision: 1, externalSessionKey: "oc_failed_replay",
      externalMessageId: "om_failed_replay", chatId: "oc_failed_replay", text: "start", deliveryMode: "native_cot_v1" });
    const first = test.store.claimFeishuBotOutbound("local", "rt_a", undefined, true, true)!;
    const payload = { runtime_id: "rt_a", request_id: first.id, claim_token: first.claimToken,
      status: "failed", error: "transient", retryable: true };
    const send = (p: Record<string, unknown>) => reportFrame(test.store, "feishu.outbound_result", p, {
      headers: daemonHeaders(test.tokens.rt_a!), authToken: "MASTER",
    });
    expect(await send(payload)).toEqual({ ok: true });
    const second = test.store.claimFeishuBotOutbound("local", "rt_a", new Date(Date.now() + 10_000), true, true)!;
    expect(second.claimToken).not.toBe(first.claimToken);
    const current = db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(first.id);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await send(payload)).toEqual({ ok: true, lease_lost: true });
      expect(await send({ ...payload, claim_token: "wrong-lease", status: "sent" })).toEqual({ ok: true, lease_lost: true });
      expect(warn.mock.calls).toHaveLength(2);
      expect(warn.mock.calls.every(call => JSON.stringify(call).includes(first.id))).toBe(true);
      expect(warn.mock.calls.every(call => JSON.stringify(call).includes('"status":"sending"'))).toBe(true);
      expect(warn.mock.calls.every(call => !JSON.stringify(call).includes("claim_token"))).toBe(true);
    } finally { warn.mockRestore(); }
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(first.id)).toEqual(current);
    expect(await send({ ...payload, status: "invalid" })).toMatchObject({ ok: false, code: "invalid_report", retryable: false });
    const removed = await test.app.request(`/api/daemon/runtimes/rt_a/feishu-bot/outbound/${first.id}/result`, {
      method: "POST", headers: daemonHeaders(test.tokens.rt_a!), body: JSON.stringify(payload),
    });
    expect(removed.status).toBe(426);
    expect(await removed.json()).toEqual({ code: "daemon_protocol_upgrade_required", min_version: DAEMON_PROTOCOL_MIN });
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(first.id)).toEqual(current);
  });

  it("stops a streaming sender when renewal loses the lease, without changing the current row or blocking", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    test.store.submitFeishuBotMessage("local", "rt_a", { revision: 1, externalSessionKey: "oc_renew_lost",
      externalMessageId: "om_renew_lost", chatId: "oc_renew_lost", text: "start", deliveryMode: "native_cot_v1" });
    const delivery = test.store.claimFeishuBotOutbound("local", "rt_a", undefined, true, true)!;
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET claim_token = 'replacement' WHERE id = ?", [delivery.id]);
    const before = db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id);
    const { client, box } = queuedClient(test);
    let apiSends = 0;
    try {
      await expect(deliverFeishuOutbound(delivery, { signal: new AbortController().signal, renewMs: 2,
        send: async ({ signal }) => {
          apiSends++;
          await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          apiSends++;
          return { messageId: "not-sent" };
        },
        report: input => client.reportFeishuBotOutboundResult("rt_a", delivery.id, input),
      })).rejects.toMatchObject({ name: "MultiremiDaemonHttpError", status: 409, code: "stale_lease" });
      expect(apiSends).toBe(1);
      expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id)).toEqual(before);
      expect(box.stats()).toMatchObject({ pending: 0, blocked: 0 });
    } finally { await box.close(); }
  });

  it("does not send after a prepared checkpoint loses its lease", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    test.store.submitFeishuBotMessage("local", "rt_a", { revision: 1, externalSessionKey: "oc_prepare_lost",
      externalMessageId: "om_prepare_lost", chatId: "oc_prepare_lost", text: "start", deliveryMode: "native_cot_v1" });
    const delivery = test.store.claimFeishuBotOutbound("local", "rt_a", undefined, true, true)!;
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET claim_token = 'replacement' WHERE id = ?", [delivery.id]);
    const before = db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id);
    const { client, box } = queuedClient(test);
    let apiSends = 0;
    try {
      await expect(deliverFeishuOutbound(delivery, { signal: new AbortController().signal,
        prepareMention: openId => client.prepareFeishuBotOutboundMention("rt_a", delivery.id, delivery.claimToken, openId),
        send: async ({ prepareMention }) => { await prepareMention!("ou_owner"); apiSends++; return { messageId: "not-sent" }; },
        report: input => client.reportFeishuBotOutboundResult("rt_a", delivery.id, input),
      })).rejects.toMatchObject({ name: "MultiremiDaemonHttpError", status: 409, code: "stale_lease" });
      expect(apiSends).toBe(0);
      expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id)).toEqual(before);
      expect(box.stats()).toMatchObject({ pending: 0, blocked: 0 });
    } finally { await box.close(); }
  });

  it("deletes restarted prepared and streaming checkpoints without a waiting sender and delivers the next runtime report", async () => {
    const test = await scaffold();
    const { box } = queuedClient(test);
    try {
      for (const status of ["prepared", "streaming"]) box.enqueue("rt:rt_a", "feishu.outbound_result", {
        runtime_id: "rt_a", request_id: "deleted-delivery", claim_token: "former-lease", status, mention_open_id: null,
      });
      box.enqueue("rt:rt_a", "runtime.model_list_result", { runtime_id: "rt_a", models: [{ id: "after-checkpoints" }] });
      await box.flushAll();
      expect(box.stats()).toMatchObject({ pending: 0, blocked: 0 });
      expect(test.store.listRuntimeModels("rt_a").map(model => model.id)).toEqual(["after-checkpoints"]);
    } finally { await box.close(); }
  });

  for (const status of ["prepared", "streaming"] as const) {
    it(`bounds ${status} checkpoint waiting by the former HTTP request timeout`, async () => {
      const test = await scaffold();
      const { client, box } = queuedClient(test, () => false, 5);
      try {
        const pending = status === "prepared" ? client.prepareFeishuBotOutboundMention("rt_a", "delivery", "lease", null)
          : client.reportFeishuBotOutboundResult("rt_a", "delivery", { status, claimToken: "lease" });
        await expect(pending).rejects.toMatchObject({ name: "MultiremiDaemonRequestTimeoutError", timeoutMs: 5 });
        expect(box.stats()).toMatchObject({ pending: 1, blocked: 0 });
      } finally { await box.close(); }
    });
  }

  it("lets only the selected transport stream and answer a Chat executed by another provider", async () => {
    const test = await scaffold();
    test.store.registerRuntime({ id: "rt_claude", name: "Claude executor", provider: "claude",
      workspaceId: "local", daemonId: "daemon-claude" });
    const executor = await test.store.createAccessToken({ name: "executor", type: "daemon",
      workspaceId: "local", daemonId: "daemon-claude" });
    test.store.updateAgent(test.agentId, { provider: "claude" });
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1, externalSessionKey: "oc_cross_provider", externalMessageId: "om_cross_provider",
      chatId: "oc_cross_provider", chatType: "p2p", text: "Hello", deliveryMode: "native_cot_v1",
    });
    const taskPath = `/api/daemon/tasks/${submitted.taskId}`;
    for (const endpoint of ["status", "messages"]) {
      const response = await test.app.request(`${taskPath}/${endpoint}`, {
        headers: daemonHeaders(test.tokens.rt_a!),
      });
      expect(response.status).toBe(endpoint === "messages" ? 426 : 200);
      if (endpoint === "messages") {
        expect(await response.json()).toEqual({ code: "daemon_protocol_upgrade_required", min_version: DAEMON_PROTOCOL_MIN });
      }
      expect((await test.app.request(`${taskPath}/${endpoint}`, {
        headers: daemonHeaders(test.tokens.rt_b!),
      })).status).toBe(403);
    }
    expect(test.store.claimTask("rt_a")).toBeNull();
    expect(test.store.claimTask("rt_claude")?.id).toBe(submitted.taskId);
    test.store.startTask(submitted.taskId);
    const sent = await reportFrame(test.store, "trace.append", { task_id: submitted.taskId, closed: false,
      events: [{ seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "Answer from Claude" }] },
      { runtimeId: "rt_claude", headers: daemonHeaders(executor.token), authToken: "MASTER" });
    expect(sent).toMatchObject({ ok: true, hub_head: 1 });
    const messages = await test.app.request(`${taskPath}/messages`, { headers: daemonHeaders(test.tokens.rt_a!) });
    expect(messages.status).toBe(426);
    expect(await messages.json()).toEqual({ code: "daemon_protocol_upgrade_required", min_version: DAEMON_PROTOCOL_MIN });
    expect(await reportFrame(test.store, "trace.head", { task_id: submitted.taskId },
      { runtimeId: "rt_a", headers: daemonHeaders(test.tokens.rt_a!), authToken: "MASTER" })).toMatchObject({ ok: true, head: 1 });
    const streamed: TraceEvent[] = [];
    const subscription = reportTraceSink(test.store).subscribe(submitted.taskId, 0, (_id, events) => streamed.push(...events));
    subscription.unsubscribe();
    expect(streamed).toEqual(expect.arrayContaining([expect.objectContaining({ content: "Answer from Claude" })]));
    expect(test.store.listTaskMessages(submitted.taskId)).toEqual([]);
    expect(await reportFrame(test.store, "trace.append", { task_id: submitted.taskId, closed: false,
      events: [{ seq: 2, ts: "2026-09-28T00:00:01Z", type: "text", content: "foreign write" }] },
      { runtimeId: "rt_a", headers: daemonHeaders(test.tokens.rt_a!), authToken: "MASTER" })).toMatchObject({ ok: false, code: "authority_revoked" });
    const question = test.store.createTaskHumanRequest({ taskId: submitted.taskId, kind: "question",
      payload: { questions: [{ question: "Continue?", options: [{ label: "yes" }] }] } });
    const cardPath = `${taskPath}/human-requests/${question.id}/card`;
    const cardInput = JSON.stringify({ recipient_open_id: "ou_cross_provider_recipient" });
    expect((await test.app.request(cardPath, { method: "POST", headers: daemonHeaders(test.tokens.rt_b!),
      body: cardInput })).status).toBe(403);
    const card = await test.app.request(cardPath, { method: "POST", headers: daemonHeaders(test.tokens.rt_a!),
      body: cardInput });
    expect(card.status).toBe(200);
    const credential = questionCardAction((await card.json() as any).card);
    expect(typeof credential?.t).toBe("string");
    const answer = await test.app.request(`${taskPath}/human-requests/${question.id}/respond`, {
      method: "POST", headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({ response: { answer: "yes" }, token: credential!.t, operator_open_id: "ou_cross_provider_recipient" }),
    });
    expect(answer.status).toBe(200);
    expect(test.store.getTaskHumanRequest(question.id)?.response).toEqual({ answer: "yes" });
    for (const endpoint of ["start", "messages", "progress", "complete", "fail"]) {
      expect((await test.app.request(`${taskPath}/${endpoint}`, {
        method: "POST", headers: daemonHeaders(test.tokens.rt_a!), body: "{}",
      })).status).toBe(403);
    }
    const privateChat = test.store.createChatSession({ agentId: test.agentId, creatorId: "local" });
    const unrelated = test.store.createTask({ agentId: test.agentId, chatSessionId: privateChat.id, prompt: "private" });
    for (const endpoint of ["status", "messages"]) {
      expect((await test.app.request(`/api/daemon/tasks/${unrelated.id}/${endpoint}`, {
        headers: daemonHeaders(test.tokens.rt_a!),
      })).status).toBe(403);
    }
    test.store.completeTask(submitted.taskId, { output: "Completed on Claude" });
    const snapshot = await test.app.request(`${taskPath}/status`, { headers: daemonHeaders(test.tokens.rt_a!) });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ status: "completed", result: "Completed on Claude" });
    // Reassigning the connector revokes the old transport's access immediately.
    test.store.heartbeatRuntime("rt_claude", { supportsFeishuBotConfig: true });
    test.store.upsertFeishuBotConfig("local", { agentId: test.agentId, runtimeId: "rt_claude",
      appId: "cli_a1b2c3d4e5f6g7h8", appSecretOp: "keep", enabled: true, domain: "feishu" });
    expect((await test.app.request(`${taskPath}/status`, { headers: daemonHeaders(test.tokens.rt_a!) })).status).toBe(403);
  });

  it("lets the bot host read, but not create or expire, human requests of a bound Chat on another daemon", async () => {
    const test = await scaffold();
    test.store.registerRuntime({ id: "rt_claude", name: "Claude executor", provider: "claude",
      workspaceId: "local", daemonId: "daemon-claude" });
    const executor = await test.store.createAccessToken({ name: "executor", type: "daemon",
      workspaceId: "local", daemonId: "daemon-claude" });
    test.store.updateAgent(test.agentId, { provider: "claude" });
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1, externalSessionKey: "oc_question", externalMessageId: "om_question",
      chatId: "oc_question", chatType: "p2p", text: "Ask me", deliveryMode: "native_cot_v1",
    });
    expect(test.store.claimTask("rt_claude")?.id).toBe(submitted.taskId);
    const privateChat = test.store.createChatSession({ agentId: test.agentId, creatorId: "local" });
    const unbound = test.store.createTask({ agentId: test.agentId, chatSessionId: privateChat.id, prompt: "private" });
    // Same executing daemon as the bound Task, so only the missing binding can refuse it.
    db!.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", ["rt_claude", unbound.id]);
    const question = test.store.createTaskHumanRequest({ taskId: submitted.taskId, kind: "question",
      payload: { question: "Continue?" } });
    const privateQuestion = test.store.createTaskHumanRequest({ taskId: unbound.id, kind: "question",
      payload: { question: "Private?" } });
    const read = (runtimeId: string, taskId: string, requestId: string, token: string) =>
      requestRuntimeRpc(test.store, runtimeId, "human_request.get", { task_id: taskId, request_id: requestId }, token, "MASTER");

    const hosted = await read("rt_a", submitted.taskId, question.id, test.tokens.rt_a!);
    expect(hosted).toMatchObject({ ok: true, request: { id: question.id, taskId: submitted.taskId, status: "pending" } });
    expect(await read("rt_claude", submitted.taskId, question.id, executor.token)).toMatchObject({ ok: true });
    expect(await read("rt_claude", unbound.id, privateQuestion.id, executor.token)).toMatchObject({ ok: true });
    // Not the bot host.
    expect(await read("rt_b", submitted.taskId, question.id, test.tokens.rt_b!)).toMatchObject({ ok: false, code: "authority_revoked", http_status: 403 });
    // Not a Chat bound to the bot.
    expect(await read("rt_a", unbound.id, privateQuestion.id, test.tokens.rt_a!)).toMatchObject({ ok: false, code: "authority_revoked", http_status: 403 });
    // Access to one bound Task does not reach another Task's request.
    expect(await read("rt_a", submitted.taskId, privateQuestion.id, test.tokens.rt_a!)).toMatchObject({ ok: false, code: "task_not_found", http_status: 404 });
    const create = (runtimeId: string, token: string) => requestRuntimeRpc(test.store, runtimeId, "human_request.create", {
      task_id: submitted.taskId, request_id: crypto.randomUUID(), kind: "question", payload: { question: "Another?" },
    }, token, "MASTER");
    const expire = (runtimeId: string, token: string) => requestRuntimeRpc(test.store, runtimeId, "human_request.expire", {
      task_id: submitted.taskId, request_id: question.id, status: "cancelled",
    }, token, "MASTER");
    expect(await create("rt_a", test.tokens.rt_a!)).toMatchObject({ ok: false, code: "authority_revoked" });
    expect(await expire("rt_a", test.tokens.rt_a!)).toMatchObject({ ok: false, code: "authority_revoked" });
    expect(test.store.getTaskHumanRequest(question.id)?.status).toBe("pending");
    expect(await create("rt_claude", executor.token)).toMatchObject({ ok: true, request: { taskId: submitted.taskId, kind: "question" } });
    expect(await expire("rt_claude", executor.token)).toMatchObject({ ok: true, request: { id: question.id, status: "cancelled" } });
    expect(test.store.getTaskHumanRequest(question.id)?.status).toBe("cancelled");
  });

  it("queues native inbound replies once and recovers CoT, interaction and result IDs through the daemon API", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    const input = { revision: 1, externalSessionKey: "oc_native:thread:om_root", externalMessageId: "om_question",
      replyToMessageId: "om_question", chatId: "oc_native", threadId: "om_root", chatType: "group" as const,
      senderOpenId: "ou_requester", text: "start", deliveryMode: "native_cot_v1" as const };
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", input);
    expect(submitted.deliveryQueued).toBe(true);
    expect(test.store.submitFeishuBotMessage("local", "rt_a", input)).toMatchObject({ duplicate: true, taskId: submitted.taskId });
    expect(db!.query("SELECT count(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id = ?").get(submitted.taskId)).toEqual({ n: 1 });
    expect(test.store.claimFeishuBotOutbound("local", "rt_a", undefined, true, false, true)).toBeNull();
    const next = async () => (await (await heartbeat(test, "rt_a", { feishu_concierge_protocol: FEISHU_CONCIERGE_NATIVE_COT_PROTOCOL_VERSION })).json()).pending_feishu_outbound;
    const delivery = await next();
    expect(delivery).toMatchObject({ task_id: submitted.taskId, chat_id: "oc_native", thread_id: "om_root",
      reply_to_message_id: "om_question", receipt_message_ids: ["om_question"], interaction_open_id: "ou_requester", presentation: { version: "native_cot_v1", throughSeq: 0 } });
    test.store.submitFeishuBotMessage("local", "rt_a", { ...input, externalMessageId: "om_followup", text: "also this" });
    const snapshot = await test.app.request(`/api/daemon/tasks/${submitted.taskId}/status`, {
      headers: daemonHeaders(test.tokens.rt_a!),
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ receipt_message_ids: ["om_question", "om_followup"] });
    const update = (claim: string, patch: object, runtimeToken = test.tokens.rt_a!) => reportFrame(test.store, "feishu.outbound_result", { runtime_id: "rt_a", request_id: delivery.id, status: "streaming", claim_token: claim, ...patch }, { headers: daemonHeaders(runtimeToken), authToken: "MASTER" });
    const presentation = { ...delivery.presentation, throughSeq: 9, interactionOpenId: "ou_requester",
      cot: { status: "active", cotId: "cot_native", messageId: "om_process", runStarted: true },
      interactions: { hr_1: { messageId: "om_approval", receiptStatus: "responded" } } };
    expect(await update(delivery.claim_token, { presentation }, test.tokens.rt_b!)).toMatchObject({ ok: false, code: "authority_revoked", retryable: false });
    expect(await update(delivery.claim_token, { presentation: { ...presentation, throughSeq: -1 } })).toMatchObject({ ok: false, code: "invalid_report", retryable: false });
    expect((await update(delivery.claim_token, { presentation })).ok).toBe(true);
    const saved = db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id);
    expect(await update(delivery.claim_token, { presentation: { ...presentation, throughSeq: 8 } })).toEqual({ ok: true });
    expect(await update(delivery.claim_token, { presentation: { ...presentation, interactions: {} } })).toEqual({ ok: true });
    expect(await update(delivery.claim_token, { presentation: { ...presentation, cot: { ...presentation.cot, cotId: "cot_other" } } })).toEqual({ ok: true });
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id)).toEqual(saved);
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET leased_until = ? WHERE id = ?", [new Date(Date.now() - 1).toISOString(), delivery.id]);
    expect(await update(delivery.claim_token, { presentation })).toEqual({ ok: true, lease_lost: true });
    const recovered = await next();
    expect(recovered.presentation).toEqual(presentation);
    expect(recovered.receipt_message_ids).toEqual(["om_question", "om_followup"]);
    expect(recovered.claim_token).not.toBe(delivery.claim_token);
    expect(await update(delivery.claim_token, { presentation })).toEqual({ ok: true, lease_lost: true });
    const final = { ...presentation, resultMessageId: "om_final", cot: { ...presentation.cot, status: "finished" } };
    expect((await update(recovered.claim_token, { presentation: final })).ok).toBe(true);
    expect((await update(recovered.claim_token, { status: "sent", external_message_id: "om_final" })).ok).toBe(true);
    expect(await next()).toBeUndefined();
    expect(db!.query("SELECT external_message_id, status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(delivery.id))
      .toEqual({ external_message_id: "om_final", status: "sent" });
    expect(db!.query("SELECT thread_id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?").get(submitted.chatSessionId))
      .toEqual({ thread_id: "om_root" });
  });

  it("stops permanent refusals immediately and transient delivery failures after six claims", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    for (const permanent of [true, false]) {
      test.store.submitFeishuBotMessage("local", "rt_a", { revision: 1, externalSessionKey: `oc_${permanent}`,
        externalMessageId: `om_${permanent}`, chatId: `oc_${permanent}`, text: "start", deliveryMode: "native_cot_v1" });
      let id = "";
      for (let attempt = 1; attempt <= (permanent ? 1 : 6); attempt++) {
        const delivery = test.store.claimFeishuBotOutbound("local", "rt_a", undefined, true, true)!;
        expect(delivery).toBeTruthy();
        id = delivery.id;
        const response = await reportFrame(test.store, "feishu.outbound_result", { runtime_id: "rt_a", request_id: id, claim_token: delivery.claimToken, status: "failed", error: "test refusal", retryable: !permanent }, { headers: daemonHeaders(test.tokens.rt_a!), authToken: "MASTER" });
        expect(response.ok).toBe(true);
        db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET available_at = ? WHERE id = ?", [new Date(Date.now() - 1).toISOString(), id]);
      }
      expect(test.store.claimFeishuBotOutbound("local", "rt_a", undefined, true, true)).toBeNull();
      expect(db!.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").get(id)).toEqual({ status: "failed" });
    }
  });
  it("puts a revision in the heartbeat and the credentials nowhere near it", async () => {
    const test = await scaffold();

    const ack = await heartbeat(test, "rt_a");

    expect(ack.status).toBe(200);
    const body = await ack.json();
    expect(body.feishu_bot).toEqual({ revision: 1, desired_state: "running", config_available: true, no_mention_chat_ids: [] });
    // The whole ack, not just the directive: a credential must not ride along
    // in `workspace_settings` or any other field either.
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
  });

  it("withholds the directive from a daemon that cannot host the bot", async () => {
    // Silence means the build is older, or the process is already running the
    // bot from its own environment. Either way it must stop being offered the
    // connector, including after a heartbeat that once claimed the capability.
    const test = await scaffold();

    const legacy = await test.app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({ runtime_id: "rt_a" }),
    });

    expect(legacy.status).toBe(200);
    expect(await legacy.json()).not.toHaveProperty("feishu_bot");
    expect(test.store.getRuntime("rt_a")?.metadata.feishu_concierge_config_v1).toBe(false);
    // And the Runtime stops being an offerable choice on the settings page.
    const candidates = await test.app.request("/api/workspaces/local/feishu-bot/candidates", { headers: MASTER });
    const listed = (await candidates.json()).runtimes as Array<{ id: string; supports_config: boolean }>;
    expect(listed.find((entry) => entry.id === "rt_a")?.supports_config).toBe(false);
  });

  it("serves the credentials with the Agent the channel needs", async () => {
    const test = await scaffold();

    const response = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_a!),
    });

    expect(response.status).toBe(200);
    // Never cached: this is the one response in the system that carries the
    // workspace's Feishu credentials.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toMatchObject({
      workspace_id: "local",
      runtime_id: "rt_a",
      agent_id: test.agentId,
      revision: 1,
      desired_state: "running",
      app_id: "cli_a1b2c3d4e5f6g7h8",
      app_secret: APP_SECRET,
      domain: "feishu",
    });
    // The Agent travels with the credentials so a start is consistent as of one
    // revision rather than mixing in whatever the last heartbeat carried.
    expect(payload.bot_agent).toMatchObject({ id: test.agentId, name: "Concierge" });
    expect(payload).not.toHaveProperty("bot_projects");
  });

  it("refuses a daemon token bound to a different Runtime", async () => {
    // Same workspace, wrong machine. Runtime B has no business holding the
    // credentials assigned to Runtime A.
    const test = await scaffold();

    const impersonated = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(impersonated.status).toBe(403);
    expect(await impersonated.text()).not.toContain(APP_SECRET);

    // And asking about itself gets nothing, because it is not the host.
    const ownScope = await test.app.request("/api/daemon/runtimes/rt_b/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(ownScope.status).toBe(404);
  });

  it("refuses a non-daemon caller even when that caller is an admin", async () => {
    const test = await scaffold();

    const asAdmin = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", { headers: MASTER });

    expect(asAdmin.status).toBe(403);
    expect(await asAdmin.json()).toMatchObject({ code: "daemon_token_required" });
  });

  it("bridges messages and session inspection only for the selected Runtime", async () => {
    const test = await scaffold();
    const submitted = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot/messages", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({
        revision: 1,
        external_session_key: "oc_chat_1",
        external_message_id: "om_1",
        sender_open_id: "ou_member",
        text: "hello",
      }),
    });
    expect(submitted.status).toBe(202);
    const lineage = await submitted.json();
    expect(lineage).toMatchObject({ status: "queued", duplicate: false, steered: false });

    const inspected = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot/session/inspect", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({ revision: 1, external_session_key: "oc_chat_1" }),
    });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({
      chat_session_id: lineage.chatSessionId,
      task: { task_id: lineage.taskId, status: "queued" },
    });

    const crossRuntime = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot/session/inspect", {
      method: "POST",
      headers: daemonHeaders(test.tokens.rt_b!),
      body: JSON.stringify({ revision: 1, external_session_key: "oc_chat_1" }),
    });
    expect(crossRuntime.status).toBe(403);
  });

  it("offers live Tasks only to v4 and persists a resumable card with a guarded renewal", async () => {
    const test = await scaffold();
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1, externalSessionKey: "oc_stream:thread:om_root", externalMessageId: "om_root",
      replyToMessageId: "om_root", chatId: "oc_stream", threadId: "om_root", text: "start",
    });
    const binding = db!.query("SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?")
      .get(submitted.chatSessionId) as { id: string };
    const now = new Date().toISOString();
    db!.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
      (id, workspace_id, binding_id, task_id, chat_id, thread_id, reply_to_message_id, body, status, available_at, created_at, updated_at)
      VALUES ('fbo_stream', 'local', ?, ?, 'oc_stream', 'om_root', 'om_root', '', 'pending', ?, ?, ?)`,
      [binding.id, submitted.taskId, now, now, now]);
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    expect(test.store.claimFeishuBotOutbound("local", "rt_a", undefined, false, false, true)).toBeNull();
    const current = await (await heartbeat(test, "rt_a", { feishu_concierge_protocol: FEISHU_CONCIERGE_TASK_STREAM_PROTOCOL_VERSION })).json();
    expect(current.pending_feishu_outbound).toMatchObject({ task_id: submitted.taskId, resume_message_id: null, body: "" });
    const renew = (token: string, runtimeToken = test.tokens.rt_a!) => reportFrame(test.store, "feishu.outbound_result", { runtime_id: "rt_a", request_id: "fbo_stream", status: "streaming", claim_token: token, external_message_id: "om_card" }, { headers: daemonHeaders(runtimeToken), authToken: "MASTER" });
    const saved = db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = 'fbo_stream'").get();
    expect(await renew("wrong")).toEqual({ ok: true, lease_lost: true });
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = 'fbo_stream'").get()).toEqual(saved);
    expect(await renew(current.pending_feishu_outbound.claim_token, test.tokens.rt_b!)).toMatchObject({ ok: false, code: "authority_revoked", retryable: false });
    expect((await renew(current.pending_feishu_outbound.claim_token)).ok).toBe(true);
    db!.run("UPDATE multiremi_feishu_bot_outbound_deliveries SET leased_until = ? WHERE id = 'fbo_stream'", [new Date(Date.now() - 1).toISOString()]);
    const expired = db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = 'fbo_stream'").get();
    expect(await renew(current.pending_feishu_outbound.claim_token)).toEqual({ ok: true, lease_lost: true });
    expect(db!.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE id = 'fbo_stream'").get()).toEqual(expired);
    const recovered = await (await heartbeat(test, "rt_a", { feishu_concierge_protocol: FEISHU_CONCIERGE_TASK_STREAM_PROTOCOL_VERSION })).json();
    expect(recovered.pending_feishu_outbound).toMatchObject({ task_id: submitted.taskId, resume_message_id: "om_card" });
  });

  it("leases one proactive reply in heartbeat and acknowledges it by claim token", async () => {
    const test = await scaffold();
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1,
      externalSessionKey: "oc_outbound:thread:omt_outbound",
      externalMessageId: "om_outbound_root",
      replyToMessageId: "om_outbound_root",
      chatId: "oc_outbound",
      threadId: "omt_outbound",
      text: "seed destination",
    });
    const binding = db!.query(
      "SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?",
    ).get(submitted.chatSessionId) as { id: string };
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at
       ) VALUES (?, 'local', ?, NULL, 'oc_outbound', 'omt_outbound',
         'om_outbound_root', 'Round completed.', 'pending', ?, ?, ?)`,
      ["fbo_http", binding.id, now, now, now],
    );
    await report(test, "rt_a", { applied_revision: 1, state: "online" });

    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET app_id = 'cli_stale' WHERE id = ?", [binding.id]);
    const wrongBot = await heartbeat(test, "rt_a");
    expect(await wrongBot.json()).not.toHaveProperty("pending_feishu_outbound");
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET app_id = 'cli_a1b2c3d4e5f6g7h8' WHERE id = ?", [binding.id]);

    const v1 = await test.app.request("/api/daemon/heartbeat", {
      method: "POST", headers: daemonHeaders(test.tokens.rt_a!),
      body: JSON.stringify({ runtime_id: "rt_a", feishu_concierge_protocol: FEISHU_CONCIERGE_PROTOCOL_VERSION }),
    });
    const v1Body = await v1.json();
    const connection = await openRuntimeDownlinks(test.store, "rt_a", { identity: {
      accessToken: await test.store.verifyAccessToken(test.tokens.rt_a!), masterToken: false,
    } });
    try {
      expect(connection.frames.find(frame => frame.t === "feishu.directive")?.p)
        .toMatchObject({ desired_state: "running", config_available: true });
    } finally { await connection.close(); }
    expect(v1Body).not.toHaveProperty("pending_feishu_outbound");

    const ack = await heartbeat(test, "rt_a");
    const body = await ack.json();
    expect(body.pending_feishu_outbound).toMatchObject({
      id: "fbo_http",
      chat_id: "oc_outbound",
      thread_id: "omt_outbound",
      reply_to_message_id: "om_outbound_root",
      body: "Round completed.",
      body_origin: "issue",
      idempotency_key: "fbo_http",
    });

    const result = await reportFrame(test.store, "feishu.outbound_result", { runtime_id: "rt_a", request_id: "fbo_http", claim_token: body.pending_feishu_outbound.claim_token,
          status: "sent",
          external_message_id: "om_outbound_sent", }, { headers: daemonHeaders(test.tokens.rt_a!), authToken: "" });
    expect(result.ok).toBe(true);
    expect((await (await heartbeat(test, "rt_a")).json())).not.toHaveProperty("pending_feishu_outbound");
  });

  it("degrades image syntax for v2 daemons while v3 daemons receive the resolvable body", async () => {
    process.env.MULTIREMI_PUBLIC_URL = "https://remi.example.test";
    const test = await scaffold();
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1,
      externalSessionKey: "oc_protocol:thread:omt_protocol",
      externalMessageId: "om_protocol_root",
      replyToMessageId: "om_protocol_root",
      chatId: "oc_protocol",
      threadId: "omt_protocol",
      text: "seed destination",
    });
    const binding = db!.query(
      "SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?",
    ).get(submitted.chatSessionId) as { id: string };
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at
       ) VALUES ('fbo_protocol', 'local', ?, NULL, 'oc_protocol', 'omt_protocol',
         'om_protocol_root', ?, 'pending', ?, ?, ?)`,
      [binding.id, "![capture](/api/attachments/att_protocol/content)", now, now, now],
    );
    await report(test, "rt_a", { applied_revision: 1, state: "online" });

    const legacy = test.store.claimFeishuBotOutbound("local", "rt_a", undefined, false, false, false)!;
    // v1 heartbeat no longer delivers outbound; retain its image-format oracle.
    const legacyBody = { ...legacy, body: degradeMarkdownImages(legacy.body,
      { publicUrl: process.env.MULTIREMI_PUBLIC_URL }) };
    expect(legacyBody).toMatchObject({
      body: "[图片: capture](https://remi.example.test/api/attachments/att_protocol/content)",
      bodyOrigin: "issue",
    });
    expect(legacyBody.body).not.toContain("![capture]");

    db!.run(
      `UPDATE multiremi_feishu_bot_outbound_deliveries
       SET status = 'pending', claim_token = NULL, leased_until = NULL
       WHERE id = ?`,
      [legacy.id],
    );
    const current = await heartbeat(test, "rt_a");
    expect((await current.json()).pending_feishu_outbound).toMatchObject({
      body: "![capture](/api/attachments/att_protocol/content)",
      body_origin: "issue",
    });
  });

  it("serves outbound attachment bytes only for the active runtime, lease, workspace, and body reference", async () => {
    useUploadDir();
    const test = await scaffold();
    const submitted = test.store.submitFeishuBotMessage("local", "rt_a", {
      revision: 1,
      externalSessionKey: "oc_images:thread:omt_images",
      externalMessageId: "om_images_root",
      replyToMessageId: "om_images_root",
      chatId: "oc_images",
      threadId: "omt_images",
      text: "seed destination",
    });
    const binding = db!.query(
      "SELECT id FROM multiremi_feishu_bot_chat_bindings WHERE chat_session_id = ?",
    ).get(submitted.chatSessionId) as { id: string };
    const now = new Date().toISOString();
    db!.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, available_at, created_at, updated_at
       ) VALUES ('fbo_images', 'local', ?, NULL, 'oc_images', 'omt_images',
         'om_images_root', ?, 'pending', ?, ?, ?)`,
      [
        binding.id,
        [
          "![allowed](/api/attachments/att_allowed/content)",
          "![remote](/api/attachments/att_remote/content)",
          "![text](/api/attachments/att_text/content)",
          "![large](/api/attachments/att_large/content)",
          "![cross](/api/attachments/att_cross_workspace/content)",
        ].join("\n"),
        now,
        now,
        now,
      ],
    );
    const allowed = test.store.createAttachment({
      id: "att_allowed",
      workspaceId: "local",
      filename: "allowed.png",
      url: "/api/attachments/att_allowed/content",
      contentType: "image/png",
      sizeBytes: 3,
      uploaderType: "member",
      uploaderId: "local",
    });
    test.store.createAttachment({
      id: "att_unreferenced",
      workspaceId: "local",
      filename: "unreferenced.png",
      url: "/api/attachments/att_unreferenced/content",
      contentType: "image/png",
      sizeBytes: 3,
      uploaderType: "member",
      uploaderId: "local",
    });
    test.store.createAttachment({
      id: "att_remote",
      workspaceId: "local",
      filename: "remote.png",
      url: "https://cdn.example/remote.png",
      contentType: "image/png",
      sizeBytes: 3,
      uploaderType: "member",
      uploaderId: "local",
    });
    test.store.createAttachment({
      id: "att_text",
      workspaceId: "local",
      filename: "not-image.txt",
      url: "/api/attachments/att_text/content",
      contentType: "text/plain",
      sizeBytes: 3,
      uploaderType: "member",
      uploaderId: "local",
    });
    test.store.createAttachment({
      id: "att_large",
      workspaceId: "local",
      filename: "large.png",
      url: "/api/attachments/att_large/content",
      contentType: "image/png",
      sizeBytes: 10 * 1024 * 1024 + 1,
      uploaderType: "member",
      uploaderId: "local",
    });
    const otherWorkspace = test.store.createWorkspace({
      id: "ws_outbound_other",
      name: "Outbound other",
      slug: "outbound-other",
    });
    test.store.createAttachment({
      id: "att_cross_workspace",
      workspaceId: otherWorkspace.id,
      filename: "cross.png",
      url: "/api/attachments/att_cross_workspace/content",
      contentType: "image/png",
      sizeBytes: 3,
      uploaderType: "member",
      uploaderId: "local",
    });
    const allowedPath = uploadedAttachmentPath(allowed);
    mkdirSync(dirname(allowedPath), { recursive: true });
    writeFileSync(allowedPath, Buffer.from("png"));
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    const claimed = await (await heartbeat(test, "rt_a")).json();
    const claimToken = claimed.pending_feishu_outbound.claim_token as string;
    db!.run(
      `INSERT INTO multiremi_feishu_bot_outbound_deliveries (
         id, workspace_id, binding_id, task_id, chat_id, thread_id,
         reply_to_message_id, body, status, claim_token, leased_until,
         available_at, attempt_count, created_at, updated_at
       ) VALUES ('fbo_other_claim', 'local', ?, NULL, 'oc_images', 'omt_images',
         'om_images_root', 'other delivery', 'sending', 'claim_other_delivery', ?,
         ?, 1, ?, ?)`,
      [
        binding.id,
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now,
        now,
      ],
    );
    const path = (runtimeId: string, attachmentId: string) =>
      `/api/daemon/runtimes/${runtimeId}/feishu-bot/outbound/fbo_images/attachments/${attachmentId}`;
    const authorizedHeaders = {
      ...daemonHeaders(test.tokens.rt_a!),
      [FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER]: claimToken,
    };
    const unavailableBody = { error: "attachment not available" };
    const expectUnavailable = async (response: Response, label: string) => {
      expect(response.status, label).toBe(404);
      expect(await response.json(), label).toEqual(unavailableBody);
    };

    const pat = await test.store.createAccessToken({
      name: "Attachment PAT",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const expired = await test.store.createAccessToken({
      name: "Expired attachment PAT",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    db!.run(
      "UPDATE multiremi_access_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      [expired.id],
    );
    const task = test.store.createTask({ agentId: test.agentId, prompt: "Attachment task credential" });
    const taskToken = await test.store.createTaskAccessToken(task, "local");

    for (const [label, headers] of [
      ["missing token", {}],
      ["invalid token", { Authorization: "Bearer invalid" }],
      ["expired token", { Authorization: `Bearer ${expired.token}` }],
    ] as const) {
      const denied = await test.app.request(path("rt_a", "att_allowed"), { headers });
      expect(denied.status, label).toBe(401);
      expect(await denied.json(), label).toEqual({ error: "unauthorized" });
    }
    for (const [label, headers, expected] of [
      ["master token", MASTER, { error: "daemon token required", code: "daemon_token_required" }],
      ["PAT", daemonHeaders(pat.token), { error: "daemon token required", code: "daemon_token_required" }],
      ["task token", daemonHeaders(taskToken.token), { error: "forbidden for task token", code: "task_token_hard_denied" }],
    ] as const) {
      const denied = await test.app.request(path("rt_a", "att_allowed"), { headers });
      expect(denied.status, label).toBe(403);
      expect(await denied.json(), label).toEqual(expected);
    }

    await expectUnavailable(await test.app.request(path("rt_a", "att_allowed"), {
      headers: {
        ...daemonHeaders(test.tokens.rt_b!),
        [FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER]: claimToken,
      },
    }), "wrong daemon identity");
    await expectUnavailable(await test.app.request(path("rt_b", "att_allowed"), {
      headers: {
        ...daemonHeaders(test.tokens.rt_b!),
        [FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER]: claimToken,
      },
    }), "wrong runtime");
    await expectUnavailable(await test.app.request(path("rt_a", "att_allowed"), {
      headers: daemonHeaders(test.tokens.rt_a!),
    }), "missing claim");
    await expectUnavailable(await test.app.request(path("rt_a", "att_allowed"), {
      headers: {
        ...daemonHeaders(test.tokens.rt_a!),
        [FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER]: "wrong-claim",
      },
    }), "wrong claim");
    await expectUnavailable(await test.app.request(path("rt_a", "att_allowed"), {
      headers: {
        ...daemonHeaders(test.tokens.rt_a!),
        [FEISHU_CONCIERGE_OUTBOUND_CLAIM_HEADER]: "claim_other_delivery",
      },
    }), "another delivery claim");
    await expectUnavailable(await test.app.request(path("rt_a", "att_cross_workspace"), {
      headers: authorizedHeaders,
    }), "cross-workspace attachment");
    await expectUnavailable(await test.app.request(path("rt_a", "att_unreferenced"), {
      headers: authorizedHeaders,
    }), "unreferenced attachment");
    for (const attachmentId of ["att_remote", "att_text", "att_large"]) {
      await expectUnavailable(await test.app.request(path("rt_a", attachmentId), {
        headers: authorizedHeaders,
      }), `invalid attachment ${attachmentId}`);
    }

    const response = await test.app.request(path("rt_a", "att_allowed"), { headers: authorizedHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("png"));

    for (const status of ["pending", "sent", "failed"] as const) {
      db!.run(
        "UPDATE multiremi_feishu_bot_outbound_deliveries SET status = ? WHERE id = ?",
        [status, "fbo_images"],
      );
      await expectUnavailable(await test.app.request(path("rt_a", "att_allowed"), {
        headers: authorizedHeaders,
      }), `delivery status ${status}`);
    }
  });

  it("names a deleted Agent instead of failing the start generically", async () => {
    const test = await scaffold();
    // Archiving disables the config, so only an outright delete reaches here.
    db!.run("DELETE FROM multiremi_agents WHERE id = ?", [test.agentId]);

    const response = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_a!),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "agent_unavailable" });
  });

  it("records a reported failure with the error the admin will read", async () => {
    const test = await scaffold();

    const reported = await report(test, "rt_a", {
      applied_revision: 1,
      state: "failed",
      error_code: "invalid_credentials",
      error_message: `Feishu rejected ${APP_SECRET}`,
    });

    expect(reported).toEqual({ sent: true });
    expect(test.store.feishuBotDirectiveForRuntime("local", "rt_a")).toMatchObject({ desired_state: "running" });
    const status = await (await test.app.request("/api/workspaces/local/feishu-bot/status", { headers: MASTER })).json();
    expect(status).toMatchObject({ status: "failed", error_code: "invalid_credentials", applied_revision: 1 });
    // The daemon redacts, and the control plane redacts again on the way in:
    // this string is rendered to admins verbatim.
    expect(status.error_message).not.toContain(APP_SECRET);
  });

  it("rejects a runtime state it does not recognise", async () => {
    const test = await scaffold();

    const before = test.store.feishuBotStatusSnapshot("local");
    const bogus = await report(test, "rt_a", { applied_revision: 1, state: "haunted" });
    expect(bogus).toEqual({ sent: true });
    const after = test.store.feishuBotStatusSnapshot("local");
    expect(after).toEqual({ ...before, lastHeartbeatAt: expect.any(String) });
    expect(test.store.listFeishuBotRuntimeStatuses("local")).toEqual([]);
  });
});

describe("Feishu bot Runtime handover", () => {
  it("never lets two Runtimes hold the bot at once", async () => {
    const test = await scaffold();
    // Runtime A is live and answering.
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    expect((await (await heartbeat(test, "rt_a")).json()).feishu_bot).toMatchObject({ desired_state: "running" });

    // The admin repoints the bot at Runtime B.
    const moved = await test.app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        agent_id: test.agentId,
        runtime_id: "rt_b",
        app_id: "cli_a1b2c3d4e5f6g7h8",
        domain: "feishu",
        enabled: true,
      }),
    });
    expect(moved.status).toBe(200);

    // B is told to wait: A still claims the connector.
    const held = await heartbeat(test, "rt_b");
    expect((await held.json()).feishu_bot).toMatchObject({ desired_state: "stopped", config_available: false });
    // And it cannot fetch the credentials to start on its own initiative.
    const early = await test.app.request("/api/daemon/runtimes/rt_b/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(early.status).toBe(404);

    // A is told to let go, and says it has.
    const stopA = await heartbeat(test, "rt_a");
    expect((await stopA.json()).feishu_bot).toMatchObject({ desired_state: "stopped" });
    await report(test, "rt_a", { applied_revision: 2, state: "stopped" });

    // Only now is B cleared to run.
    const cleared = await heartbeat(test, "rt_b");
    expect((await cleared.json()).feishu_bot).toMatchObject({ desired_state: "running", config_available: true });
    const payload = await test.app.request("/api/daemon/runtimes/rt_b/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_b!),
    });
    expect(payload.status).toBe(200);
    expect((await payload.json()).app_secret).toBe(APP_SECRET);
  });

  it("shows the overlap as degraded rather than online while it lasts", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    await test.app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        agent_id: test.agentId,
        runtime_id: "rt_b",
        app_id: "cli_a1b2c3d4e5f6g7h8",
        domain: "feishu",
        enabled: true,
      }),
    });

    const status = await (await test.app.request("/api/workspaces/local/feishu-bot/status", { headers: MASTER })).json();

    expect(status).toMatchObject({ status: "degraded", stale_runtime_ids: ["rt_a"], desired_state: "stopped" });
  });

  it("stops waiting on a Runtime whose report has gone stale", async () => {
    // A machine unplugged mid-connector would otherwise block its replacement
    // forever, which turns one dead host into an outage with no way out.
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });
    db!.run(
      "UPDATE multiremi_feishu_bot_runtime_states SET reported_at = ? WHERE runtime_id = ?",
      [new Date(Date.now() - 10 * 60_000).toISOString(), "rt_a"],
    );
    await test.app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT",
      headers: MASTER,
      body: JSON.stringify({
        agent_id: test.agentId,
        runtime_id: "rt_b",
        app_id: "cli_a1b2c3d4e5f6g7h8",
        domain: "feishu",
        enabled: true,
      }),
    });

    const cleared = await heartbeat(test, "rt_b");
    expect((await cleared.json()).feishu_bot).toMatchObject({ desired_state: "running", config_available: true });
  });

  it("tells the host to stop as soon as the bot is disabled", async () => {
    const test = await scaffold();
    await report(test, "rt_a", { applied_revision: 1, state: "online" });

    await test.app.request("/api/workspaces/local/feishu-bot/stop", {
      method: "POST",
      headers: MASTER,
      body: "{}",
    });

    const ack = await heartbeat(test, "rt_a");
    expect((await ack.json()).feishu_bot).toMatchObject({ desired_state: "stopped", config_available: false });
    // Credentials go with the intent: a stopped bot has no reason to hold them.
    const fetched = await test.app.request("/api/daemon/runtimes/rt_a/feishu-bot", {
      headers: daemonHeaders(test.tokens.rt_a!),
    });
    expect(fetched.status).toBe(404);
  });
});

describe("Feishu bot status derivation", () => {
  const reported = (
    overrides: Partial<MultiremiFeishuBotRuntimeStatus> = {},
  ): MultiremiFeishuBotRuntimeStatus => ({
    workspaceId: "local",
    runtimeId: "rt_a",
    appliedRevision: 3,
    state: "online",
    botName: "Concierge",
    botOpenId: null,
    errorCode: null,
    errorMessage: null,
    reportedAt: new Date().toISOString(),
    ...overrides,
  });
  const base = { enabled: true, revision: 3, runtimeOnline: true, staleRuntimeCount: 0 };

  it("reads the config's intent before anything a Runtime reports", () => {
    // A disabled bot is `stopped` even if a Runtime still claims it is online:
    // the admin's intent is the answer to "what is this bot doing".
    expect(deriveStatus({ ...base, enabled: false, reported: reported() })).toBe("stopped");
  });

  it("reports an overlap ahead of everything else", () => {
    // Two hosts is the one condition that silently produces duplicate replies,
    // so it outranks even an offline Runtime in what the admin is shown.
    expect(deriveStatus({ ...base, staleRuntimeCount: 1, reported: reported() })).toBe("degraded");
    expect(deriveStatus({ ...base, runtimeOnline: false, staleRuntimeCount: 1, reported: null })).toBe("degraded");
  });

  it("distinguishes a Runtime that is gone from a bot that has not started", () => {
    expect(deriveStatus({ ...base, runtimeOnline: false, reported: null })).toBe("runtime_offline");
    expect(deriveStatus({ ...base, reported: null })).toBe("deploying");
  });

  it("does not show a stale failure as the current state", () => {
    // The Runtime is alive but still on revision 2; its failure described the
    // config the admin has already replaced.
    expect(deriveStatus({
      ...base,
      reported: reported({ appliedRevision: 2, state: "failed", errorCode: "invalid_credentials" }),
    })).toBe("deploying");
  });

  it("passes through what the Runtime reports for the current revision", () => {
    expect(deriveStatus({ ...base, reported: reported({ state: "starting" }) })).toBe("connecting");
    expect(deriveStatus({ ...base, reported: reported({ state: "online" }) })).toBe("online");
    expect(deriveStatus({ ...base, reported: reported({ state: "failed" }) })).toBe("failed");
    expect(deriveStatus({ ...base, reported: reported({ state: "stopped" }) })).toBe("deploying");
  });
});
