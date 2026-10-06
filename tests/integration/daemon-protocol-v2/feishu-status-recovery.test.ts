import { afterEach, expect, it } from "bun:test";
import { DAEMON_HEARTBEAT_INTERVAL_MS } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

it("recovers an unacknowledged online report and releases outbound without a new directive or reconnect", async () => {
  const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 77).toString("base64");
  try {
    let lostOnline = false;
    const h = await DaemonProtocolHarness.create({ beforeSend: frame => {
      if (!lostOnline && frame.t === "concierge.status_report" && frame.p?.state === "online") {
        lostOnline = true;
        return false; // Simulate a swallowed first write on the connected socket.
      }
    } });
    fixtures.push(h);
    const sent: string[] = [];
    h.daemon.setFeishuConciergeHost({
      start: async () => ({ botName: "Fixture" }),
      stop: async () => {},
      sendOutbound: async delivery => { sent.push(delivery.id); return { messageId: `om_sent_${delivery.id}` }; },
    });
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
    const agent = h.store.createAgent({ name: "Concierge", provider: "claude", workspaceId: "local", runtimeId });
    const config = h.store.upsertFeishuBotConfig("local", {
      agentId: agent.id, runtimeId, appId: "cli_status_recovery", appSecretOp: "set",
      appSecret: "fixture-only-secret", domain: "feishu", enabled: true,
    });
    const state = () => h.store.listFeishuBotRuntimeStatuses("local").find(row => row.runtimeId === runtimeId);
    await waitFor(() => lostOnline && state()?.state === "starting", "unacknowledged online status");

    const submitted = h.store.submitFeishuBotMessage("local", runtimeId, {
      revision: config.revision, externalSessionKey: "oc_status_recovery", externalMessageId: "om_status_recovery",
      chatId: "oc_status_recovery", chatType: "p2p", text: "Please answer", deliveryMode: "native_cot_v1",
    });
    expect(submitted.taskId).toBeTruthy();
    expect(h.store.pendingFeishuBotOutbound("local", runtimeId)).toBeNull();
    expect(sent).toHaveLength(0);
    const directives = h.received.filter(frame => frame.t === "feishu.directive").length;
    expect(directives).toBe(1);

    // This expires the unacknowledged RPC and triggers the next normal hb ack.
    h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => state()?.state === "online", "online status to be retried");
    await waitFor(() => sent.length > 0, "pending Feishu reply to be sent");
    await waitFor(() => sent.every(id => (h.db.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(id) as { status: string } | null)?.status === "sent"), "Feishu reply results to be acknowledged");
    expect(h.received.filter(frame => frame.t === "feishu.directive")).toHaveLength(directives);
    expect(h.sockets).toHaveLength(1);
    expect(new Set(sent).size).toBe(sent.length);
    expect(h.ledger.filter(entry => entry.type === "concierge.status_report" && entry.frame.p.state === "online")).toHaveLength(1);
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  }
}, 15_000);
