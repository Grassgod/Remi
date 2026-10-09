import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
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
const releaseProviders: Array<() => void> = [];
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
  for (const release of releaseProviders.splice(0)) release();
  for (const h of fixtures.splice(0)) await h.dispose();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
});

async function fixture(options: Parameters<typeof DaemonProtocolHarness.create>[0] = {}) {
  const h = await DaemonProtocolHarness.create(options);
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
  it("preserves registration metadata across hello and changing capability heartbeats", async () => {
    const h = await fixture();
    await h.startDaemon();
    await h.settleHeartbeat();
    const id = runtimeId(h);
    const metadata = h.store.getRuntime(id)!.metadata;
    const registrationFields = {
      parallel_agent_execution: 1,
      cli_version: expect.any(String),
      version: expect.any(String),
      runtime_workspaces: 1,
      launched_by: "manual",
    };
    expect(metadata).toMatchObject(registrationFields);
    const stable = { parallel_agent_execution: metadata.parallel_agent_execution,
      cli_version: metadata.cli_version, version: metadata.version,
      runtime_workspaces: metadata.runtime_workspaces, launched_by: metadata.launched_by };

    for (let count = 2; count <= 3; count++) {
      h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
      await waitFor(() => h.ledger.filter(entry => entry.type === "hb").length >= count, `capability heartbeat ${count}`);
      await h.settleHeartbeat();
      expect(h.store.getRuntime(id)!.metadata).toMatchObject(stable);
    }
    attachHost(h);
    h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => h.ledger.filter(entry => entry.type === "hb").length >= 4, "changed capability heartbeat");
    await h.settleHeartbeat();
    expect(h.store.getRuntime(id)!.metadata).toMatchObject({ ...stable,
      feishu_concierge_config_v1: true, feishu_issue_decision_card: 1 });
  });

  it("declares all host capabilities in hello and hb, creates an Issue decision delivery, and recovers its card", async () => {
    const released = new Promise<void>(resolve => releaseProviders.push(resolve));
    const h = await fixture({ providerFactory: () => ({ async *sendStream() { await released; }, getLastResponse: () => null }) });
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
    h.db.run('UPDATE multiremi_users SET feishu_union_id=? WHERE id=?', ['on_capability_fixture', user.id]);
    const seen = new Date().toISOString();
    h.db.run("INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at) VALUES('fbs_capability','local','capability_fixture','ou_capability_fixture','on_capability_fixture','Human',1,?,?)", [seen, seen]);
    const parent = createResponsibleTestIssue(h.store, { title: "Capability parent", workspaceId: "local", assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: member.id });
    h.store.prepareFeishuIssueTopicWithinTransaction(parent);
    const root = h.store.claimFeishuBotOutbound("local", id)!;
    h.store.reportFeishuBotOutbound("local", id, root.id, {
      claimToken: root.claimToken, status: "sent", externalMessageId: `om_root_${parent.id}`,
    });
    const child = createResponsibleTestIssue(h.store, { title: "Capability child", workspaceId: "local", parentIssueId: parent.id,
      assigneeType: "agent", assigneeId: agent.id });
    h.store.prepareFeishuIssueTopicWithinTransaction(child);
    const childTopic = h.store.claimFeishuBotOutbound('local', id)!;
    h.store.reportFeishuBotOutbound('local', id, childTopic.id, { claimToken: childTopic.claimToken,
      status: 'sent', externalMessageId: `om_root_${child.id}` });
    const task = h.store.createTask({ agentId: agent.id, issueId: child.id, workspaceId: "local", prompt: "Decision" });
    const turn = h.store.getTurnForAttempt(task.id)!;
    await waitFor(() => h.store.getTask(task.id)?.status === 'running', 'source provider execution');
    const created = h.store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id,
      wait_id: `capability-wait:${task.id}`, dedupe_key: `capability-question:${task.id}`, body_md: 'Deploy?', options: [],
      metadata: { kind: 'production_change', questions: [{ question: 'Deploy?' }] } },
      { runtimeId: id, daemonId: 'dmn_fixture', workspaceId: 'local' });
    expect(created.ok).toBeTrue();
    const decision = h.store.getQuestion(String(created.message_id))!;
    const card = h.store.claimFeishuBotOutbound("local", id)!;
    expect(card.kind).toBe("decision_card");
    expect(card.humanRequestId).toBe(decision.id);
    expect(card.degraded).toBeUndefined();
    h.store.reportFeishuBotOutbound("local", id, card.id, {
      claimToken: card.claimToken, status: "sent", externalMessageId: "om_capability_card",
      interactionOpenId: "ou_capability_fixture",
    });
    expect(h.store.listFeishuBotLiveDecisionCards("local", id)).toMatchObject([{
      request_id: decision.id, task_id: task.id, message_id: "om_capability_card",
    }]);
  }, 15_000);

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
  }, 15_000);

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
