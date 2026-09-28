import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DAEMON_HEARTBEAT_INTERVAL_MS,
} from "@multiremi/contracts/daemon-protocol.js";
import {
  FEISHU_CONCIERGE_ATTACHMENT_PROTOCOL_VERSION,
  FEISHU_DECISION_CARD_PROTOCOL_VERSION,
  FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION,
  MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
} from "@multiremi/contracts/types.js";
import { runtimeCapabilitiesInFrame } from "../../fixtures/daemon-protocol.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
const savedEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [key, value] of Object.entries({
    MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
    MULTIREMI_PUBLIC_URL: "https://remi.example.com",
    MULTIREMI_LARK_APP_ID: "capability_fixture",
    MULTIREMI_LARK_APP_SECRET: "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA",
  })) {
    savedEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.dispose();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
});

async function fixture() {
  const h = await DaemonProtocolHarness.create();
  fixtures.push(h);
  return h;
}

function runtimeId(h: DaemonProtocolHarness): string {
  return h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
}

function latestFrame(h: DaemonProtocolHarness, type: string) {
  return h.ledger.filter(entry => entry.type === type).at(-1)!.frame;
}

function attachHost(h: DaemonProtocolHarness): void {
  h.daemon.setFeishuConciergeHost({
    start: async () => ({}),
    stop: async () => {},
  });
  h.daemon.setBotMenuPublisher(async (_, dryRun) => ({ dryRun, defaultPublished: true, userMenuCount: 0 }));
}

function assertHostedCapabilities(h: DaemonProtocolHarness, type: "hello" | "hb"): void {
  const id = runtimeId(h);
  expect(runtimeCapabilitiesInFrame(latestFrame(h, type), id)).toEqual({
    supports_batch_import: true,
    supports_directory_scan: true,
    supports_skill_directory: true,
    supports_bot_menu: true,
    agent_plugin_protocol: MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
    feishu_concierge_protocol: FEISHU_CONCIERGE_ATTACHMENT_PROTOCOL_VERSION,
    feishu_decision_card: FEISHU_DECISION_CARD_PROTOCOL_VERSION,
    feishu_issue_decision_card: FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION,
  });
  expect(h.store.getRuntime(id)!.metadata).toMatchObject({
    supports_batch_import: true,
    supports_directory_scan: true,
    supports_skill_directory: true,
    feishu_bot_menu: true,
    agent_plugin_protocol: MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
    feishu_concierge_config_v1: true,
    feishu_decision_card: 1,
    feishu_issue_decision_card: 1,
  });
}

describe("v2 runtime capability advertisement", () => {
  it("declares all host capabilities in hello and hb, creates an Issue decision delivery, and recovers its card", async () => {
    const h = await fixture();
    attachHost(h);
    let atHello: Record<string, unknown> | null = null;
    h.layer.registerSessionHooks({ hello: (_session, hello) => {
      atHello = { ...h.store.getRuntime(hello.runtimes[0]!.runtimeId)!.metadata };
    } });
    await h.startDaemon();
    await h.settleHeartbeat();
    await waitFor(() => h.ledger.some(entry => entry.type === "hb"), "capability heartbeat");
    assertHostedCapabilities(h, "hello");
    assertHostedCapabilities(h, "hb");
    expect(atHello).toMatchObject({ feishu_concierge_config_v1: true, feishu_issue_decision_card: 1 });

    const id = runtimeId(h);
    const member = h.store.findWorkspaceMemberForUser("local", "local")!;
    const user = h.store.getOrCreateUser({ externalId: "ou_capability_fixture", name: "Card recipient", email: "capability@example.com" });
    h.db.run("UPDATE multiremi_workspace_members SET user_id = ? WHERE id = ?", [user.id, member.id]);
    const agent = h.store.createAgent({ name: "Card owner", provider: "claude", workspaceId: "local", runtimeId: id });
    const config = h.store.upsertFeishuBotConfig("local", {
      agentId: agent.id, runtimeId: id, appId: "capability_fixture", appSecretOp: "set",
      appSecret: process.env.MULTIREMI_LARK_APP_SECRET!, domain: "feishu", enabled: true,
    });
    h.store.reportFeishuBotRuntimeStatus("local", id, { appliedRevision: config.revision, state: "online" });
    const workspace = h.store.getWorkspace("local")!;
    h.store.updateWorkspace("local", { settings: {
      ...workspace.settings, issueTopics: { enabled: true, chatId: "oc_capability_fixture" },
    } });
    const parent = h.store.createIssue({ title: "Capability parent", workspaceId: "local", assigneeType: "agent", assigneeId: agent.id });
    h.store.prepareFeishuIssueTopicWithinTransaction(parent);
    const root = h.store.claimFeishuBotOutbound("local", id)!;
    h.store.reportFeishuBotOutbound("local", id, root.id, {
      claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${parent.id}`,
    });
    const child = h.store.createIssue({ title: "Capability child", workspaceId: "local", parentIssueId: parent.id,
      assigneeType: "agent", assigneeId: agent.id });
    const task = h.store.createTask({ agentId: agent.id, issueId: child.id, workspaceId: "local", prompt: "Decision" });
    const decision = h.store.createIssueDecision(child.id, {
      kind: "production_change", title: "Deploy?", body: "A decision requiring a card",
    }, { type: "agent", id: agent.id, taskId: task.id });
    const card = h.store.claimFeishuBotOutbound("local", id)!;
    expect(card.kind).toBe("decision_card");
    expect(card.decisionId).toBe(decision.id);
    h.store.reportFeishuBotOutbound("local", id, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_capability_card",
      interactionOpenId: "ou_capability_fixture",
    });
    expect(h.store.listFeishuIssueDecisionCards("local", id)).toMatchObject([{
      decision_id: decision.id, issue_id: parent.id, message_id: "om_capability_card",
    }]);
  });

  it("clears stale host flags on hello when the daemon has no concierge host", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    const id = runtimeId(h);
    h.store.heartbeatRuntime(id, { supportsBotMenu: true, supportsFeishuBotConfig: true,
      supportsDecisionCard: true, supportsIssueDecisionCard: true });
    expect(h.store.getRuntime(id)!.metadata.feishu_issue_decision_card).toBe(1);
    let atHello: Record<string, unknown> | null = null;
    h.layer.registerSessionHooks({ hello: (_session, hello) => {
      atHello = { ...h.store.getRuntime(hello.runtimes[0]!.runtimeId)!.metadata };
    } });
    await h.disconnect();
    await h.reconnect();
    expect(atHello).toMatchObject({ feishu_concierge_config_v1: false, feishu_issue_decision_card: 0 });
    expect(runtimeCapabilitiesInFrame(latestFrame(h, "hello"), id)).toMatchObject({
      supports_bot_menu: false, feishu_concierge_protocol: 0,
      feishu_decision_card: 0, feishu_issue_decision_card: 0,
    });
    expect(h.store.getRuntime(id)!.metadata).toMatchObject({
      feishu_bot_menu: false, feishu_concierge_config_v1: false,
      feishu_decision_card: 0, feishu_issue_decision_card: 0,
    });
  });

  it("advertises a concierge host added after connection on the next hb", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    expect(h.store.getRuntime(runtimeId(h))!.metadata.feishu_issue_decision_card).toBe(0);
    attachHost(h);
    h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => h.ledger.filter(entry => entry.type === "hb").length >= 2, "updated capability heartbeat");
    await h.settleHeartbeat();
    assertHostedCapabilities(h, "hb");
  });

  it("redeclares capabilities on reconnect and does not clear them on an upgrade probe", async () => {
    const h = await fixture();
    attachHost(h);
    await h.startDaemon();
    await h.settleHeartbeat();
    await h.disconnect();
    await h.reconnect();
    assertHostedCapabilities(h, "hello");
    assertHostedCapabilities(h, "hb");
    const lane = (h.daemon as unknown as { protocolLane: { probeUpgrade: () => Promise<void> } }).protocolLane;
    await lane.probeUpgrade();
    assertHostedCapabilities(h, "hb");
  });
});
