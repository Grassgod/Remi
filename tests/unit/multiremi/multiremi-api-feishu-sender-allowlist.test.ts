import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

describe("Feishu sender allowlist Issue authorization", () => {
  it("restores the same task after approval and revokes its Issue APIs and CLI capabilities immediately", async () => {
    const fixture = await allowlistFixture();
    const requests = [
      ["/api/issues", { title: "compat create" }],
      ["/api/multiremi/issues", { title: "native create", workspaceId: "local" }],
      ["/api/issues/quick-create", { agent_id: fixture.worker.id, prompt: "compat quick create" }],
      ["/api/multiremi/issues/quick-create", { agentId: fixture.worker.id, prompt: "native quick create" }],
    ] as const;

    for (const [path, body] of requests) {
      const response = await fixture.app.request(path, {
        method: "POST", headers: fixture.headers, body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({
        code: "feishu_sender_approval_required",
        error: expect.stringContaining("Settings > Integrations > Feishu account allowlist"),
      });
    }
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(0);
    await expectIssueCapabilities(fixture, fixture.headers, false);

    fixture.allow(true);
    await expectIssueCapabilities(fixture, fixture.headers, true);
    const created = await createIssue(fixture, fixture.headers);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      chat_issue_binding: { status: "bound", chat_session_id: fixture.inbound.chatSessionId },
    });

    fixture.allow(false);
    await expectIssueCapabilities(fixture, fixture.headers, false);
    await expectApprovalRequired(await createIssue(fixture, fixture.headers));
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(1);
    expect(fixture.store.getTask(fixture.inbound.taskId)?.issueCreationRestricted).toBe(false);
  });

  it("applies approval changes to existing delegated and run-only Autopilot tasks without freezing their policy", async () => {
    const fixture = await allowlistFixture();
    fixture.allow(true);
    const delegated = await fixture.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ agentId: fixture.worker.id, prompt: "Delegate the requested Issue" }),
    });
    expect(delegated.status).toBe(201);
    const delegatedTaskId = (await delegated.json() as { task: { id: string } }).task.id;
    const autopilot = fixture.store.createAutopilot({
      title: "Existing run-only automation", assigneeId: fixture.worker.id, executionMode: "run_only",
    });
    const run = fixture.store.runAutopilot(autopilot.id, { sourceTaskId: fixture.inbound.taskId });
    const taskIds = [delegatedTaskId, run.taskId!];
    const credentials = [];
    for (const taskId of taskIds) {
      expect(fixture.store.getTask(taskId)).toMatchObject({
        parentTaskId: fixture.inbound.taskId, issueCreationRestricted: false,
      });
      const headers = await taskHeaders(fixture.store, taskId);
      credentials.push(headers);
      expect((await createIssue(fixture, headers)).status).toBe(201);
    }

    fixture.allow(false);
    for (const headers of credentials) await expectApprovalRequired(await createIssue(fixture, headers));
    fixture.allow(true);
    for (const headers of credentials) expect((await createIssue(fixture, headers)).status).toBe(201);
  });

  it("requires every sender contributing to the same Chat, including active steers and later turns", async () => {
    const fixture = await allowlistFixture();
    fixture.allow(true);
    const mixed = fixture.store.submitFeishuBotMessage("local", "rt_allowlist", {
      revision: fixture.config.revision,
      externalSessionKey: "oc_allowlist:thread:omt_allowlist",
      externalMessageId: "om_second_sender",
      senderOpenId: "ou_second_sender",
      senderName: "Second sender",
      text: "Include another Issue while this task is running.",
    });
    expect(mixed).toMatchObject({ steered: true, taskId: fixture.inbound.taskId });
    await expectApprovalRequired(await createIssue(fixture, fixture.headers));
    const second = fixture.store.listFeishuBotSenders("local").find((sender) => sender.id !== fixture.senderId)!;
    fixture.store.setFeishuBotSenderAllowed("local", second.id, true, "local");
    expect((await createIssue(fixture, fixture.headers)).status).toBe(201);

    fixture.allow(false);
    fixture.store.cancelTask(fixture.inbound.taskId);
    const nextTurn = fixture.store.submitFeishuBotMessage("local", "rt_allowlist", {
      revision: fixture.config.revision,
      externalSessionKey: "oc_allowlist:thread:omt_allowlist",
      externalMessageId: "om_second_sender_next_turn",
      senderOpenId: "ou_second_sender",
      text: "Continue in this Chat.",
    });
    expect(nextTurn.chatSessionId).toBe(fixture.inbound.chatSessionId);
    expect(nextTurn.taskId).not.toBe(fixture.inbound.taskId);
    const nextHeaders = await taskHeaders(fixture.store, nextTurn.taskId);
    await expectApprovalRequired(await createIssue(fixture, nextHeaders));
    fixture.allow(true);
    expect((await createIssue(fixture, nextHeaders)).status).toBe(201);
  });

  it("keeps explicit agent proposal policy authoritative before and after sender approval", async () => {
    const fixture = await allowlistFixture(true);
    for (const allowed of [false, true, false]) {
      fixture.allow(allowed);
      const response = await createIssue(fixture, fixture.headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "issue_creation_requires_proposal" });
      await expectIssueCapabilities(fixture, fixture.headers, false);
    }
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(0);
  });

  it("preserves dynamic sender authority through queued system-event tasks", async () => {
    const fixture = await allowlistFixture();
    fixture.allow(true);
    const issue = fixture.store.createIssue({ title: "Source work", workspaceId: "local", status: "todo" });
    const autopilot = fixture.store.createAutopilot({
      title: "Follow up source Issue", assigneeId: fixture.worker.id, executionMode: "trigger_issue",
    });
    fixture.store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue", event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
      },
    });
    const changed = await fixture.app.request(`/api/issues/${issue.id}`, {
      method: "PATCH", headers: fixture.headers, body: JSON.stringify({ status: "done" }),
    });
    expect(changed.status).toBe(200);

    fixture.allow(false);
    const runs = fixture.store.dispatchPendingSystemEvents();
    expect(runs).toHaveLength(1);
    expect(fixture.store.getTask(runs[0]!.taskId!)).toMatchObject({
      parentTaskId: fixture.inbound.taskId, issueCreationRestricted: false,
    });
    const eventTaskHeaders = await taskHeaders(fixture.store, runs[0]!.taskId!);
    await expectApprovalRequired(await createIssue(fixture, eventTaskHeaders));
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(1);
    fixture.allow(true);
    expect((await createIssue(fixture, eventTaskHeaders)).status).toBe(201);
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(2);
  });

  it("checks the source task again at Autopilot Issue creation instead of trusting its original approval", async () => {
    const fixture = await allowlistFixture();
    const autopilot = fixture.store.createAutopilot({
      title: "Create requested Issue", assigneeId: fixture.worker.id, executionMode: "create_issue",
    });
    const run = () => fixture.store.runAutopilot(autopilot.id, { sourceTaskId: fixture.inbound.taskId });
    expect(run).toThrow("feishu_sender_approval_required");
    fixture.allow(true);
    expect(run().issueId).toBeString();
    fixture.allow(false);
    expect(run).toThrow("feishu_sender_approval_required");
    expect(fixture.store.listAutopilotRuns(autopilot.id)).toHaveLength(1);
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(1);
  });

  it("does not authorize a message without a sender open_id through another allowed account", async () => {
    const fixture = await allowlistFixture();
    fixture.allow(true);
    const unknown = fixture.store.submitFeishuBotMessage("local", "rt_allowlist", {
      revision: fixture.config.revision,
      externalSessionKey: "oc_unknown_sender",
      externalMessageId: "om_unknown_sender",
      senderUnionId: "on_unknown_sender",
      text: "Create an Issue without a stable app-scoped sender identity.",
    });
    expect(fixture.store.listFeishuBotSenders("local")).toHaveLength(1);
    const unknownHeaders = await taskHeaders(fixture.store, unknown.taskId);
    await expectApprovalRequired(await createIssue(fixture, unknownHeaders));
    await expectIssueCapabilities(fixture, unknownHeaders, false);
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(0);
  });
});

async function allowlistFixture(issueCreationRequiresProposal = false) {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Feishu bot", provider: "codex", issueCreationRequiresProposal });
  const worker = store.createAgent({ name: "Issue worker", provider: "codex" });
  store.registerRuntime({
    id: "rt_allowlist", name: "codex", provider: "codex", workspaceId: "local", daemonId: "daemon_allowlist",
  });
  store.heartbeatRuntime("rt_allowlist", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id, runtimeId: "rt_allowlist", appId: "cli_allowlist",
    appSecretOp: "set", appSecret: "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA", domain: "feishu", enabled: true,
  });
  const inbound = store.submitFeishuBotMessage("local", "rt_allowlist", {
    revision: config.revision,
    externalSessionKey: "oc_allowlist:thread:omt_allowlist",
    externalMessageId: "om_allowlist_first",
    senderOpenId: "ou_allowlist_sender",
    senderName: "Incoming sender",
    text: "Create an Issue for this request.",
  });
  const [sender] = store.listFeishuBotSenders("local");
  expect(sender).toBeDefined();
  const senderId = sender!.id;
  return {
    store, agent, worker, config, inbound, senderId,
    app: createMultiremiApp({ store, authToken: "root-secret" }),
    headers: await taskHeaders(store, inbound.taskId),
    allow: (allowed: boolean) => store.setFeishuBotSenderAllowed("local", senderId, allowed, "local"),
  };
}

async function taskHeaders(store: ReturnType<typeof createLocalStore>, taskId: string) {
  const credential = await store.createTaskAccessToken(store.getTask(taskId)!, "local");
  return { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
}

function createIssue(fixture: Awaited<ReturnType<typeof allowlistFixture>>, headers: Record<string, string>) {
  return fixture.app.request("/api/issues", {
    method: "POST", headers, body: JSON.stringify({ title: "Requested Issue" }),
  });
}

async function expectApprovalRequired(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "feishu_sender_approval_required" });
}

async function expectIssueCapabilities(
  fixture: Awaited<ReturnType<typeof allowlistFixture>>,
  headers: Record<string, string>,
  allowed: boolean,
) {
  const response = await fixture.app.request("/api/cli/capabilities", { headers });
  expect(response.status).toBe(200);
  const body = await response.json() as { commands: Array<{ id: string; allowed: boolean }> };
  const capabilities = new Map(body.commands.map((command) => [command.id, command.allowed]));
  expect(capabilities.get("issue.create")).toBe(allowed);
  expect(capabilities.get("issue.quick-create")).toBe(allowed);
}
