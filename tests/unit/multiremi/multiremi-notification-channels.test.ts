import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { MultiremiNotificationDelivery } from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api/server.js";
import type { OutboundNotification, OutboundNotificationSender } from "@multiremi/notifications/types.js";
import { MultiremiStore } from "@multiremi/store.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;
const originalFeishuAppId = process.env.MULTIREMI_FEISHU_APP_ID;
const originalFeishuAppSecret = process.env.MULTIREMI_FEISHU_APP_SECRET;

afterEach(() => {
  store?.stopNotificationDeliverySweeper();
  store = null;
  db?.close();
  db = null;
  restoreEnv("MULTIREMI_FEISHU_APP_ID", originalFeishuAppId);
  restoreEnv("MULTIREMI_FEISHU_APP_SECRET", originalFeishuAppSecret);
});

describe("Multiremi notification channels", () => {
  it("keeps inbox-only behavior when no channel is configured", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent));
    const { issue, member } = createAssignedIssue(current, "Inbox only");

    await Bun.sleep(10);

    expect(current.listInboxItems(member.id).some((item) => item.issueId === issue.id)).toBe(true);
    expect(current.listNotificationDeliveries({ workspaceId: "local" })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("does not fan out through a disabled channel", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent));
    createChannel(current, { enabled: false, eventTypes: ["*"] });
    createAssignedIssue(current, "Disabled route");

    await Bun.sleep(10);

    expect(current.listNotificationDeliveries({ workspaceId: "local" })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("does not fan out when event_types do not match", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent));
    createChannel(current, { eventTypes: ["autopilot_paused"] });
    createAssignedIssue(current, "Mismatched route");

    await Bun.sleep(10);

    expect(current.listNotificationDeliveries({ workspaceId: "local" })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("records pending before sending a self-explanatory card to the configured group", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent), { publicUrl: "https://remi.example.test" });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    const { issue, member } = createAssignedIssue(current, "Card route result");

    const pending = current.listNotificationDeliveries({ workspaceId: "local" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");
    const delivered = await waitForDelivery(current, pending[0]!.id, "sent");

    expect(current.listInboxItems(member.id).some((item) => item.issueId === issue.id)).toBe(true);
    expect(delivered.attempts).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe("oc_team_123");
    const card = JSON.stringify(sent[0]!.card);
    expect(card).toContain("Issue assigned");
    expect(card).toContain(issue.key);
    expect(card).toContain("Card route result");
    expect(card).toContain("Occurred");
    expect(card).toContain("https://remi.example.test");
  });

  it("marks a throwing sender failed without losing the inbox item", async () => {
    const sender: OutboundNotificationSender = {
      async send(): Promise<void> {
        throw new Error("simulated outbound failure");
      },
    };
    const current = createTestStore(sender, { maxAttempts: 3, retryBaseDelayMs: 1 });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    const { issue, member } = createAssignedIssue(current, "Sender failure");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const failed = await waitForDelivery(current, pending.id, "failed");

    expect(failed.attempts).toBe(3);
    expect(failed.lastError).toContain("simulated outbound failure");
    expect(current.listInboxItems(member.id).some((item) => item.issueId === issue.id)).toBe(true);
  });

  it("surfaces missing Feishu credentials as a failed delivery without throwing", async () => {
    delete process.env.MULTIREMI_FEISHU_APP_ID;
    delete process.env.MULTIREMI_FEISHU_APP_SECRET;
    const current = createTestStore();
    createChannel(current, { eventTypes: ["issue_assigned"] });
    const { issue, member } = createAssignedIssue(current, "Missing credentials");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const failed = await waitForDelivery(current, pending.id, "failed");

    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("feishu credentials not configured");
    expect(current.listInboxItems(member.id).some((item) => item.issueId === issue.id)).toBe(true);
  });

  it("lets an owner create, list, update, and delete a channel through the API", async () => {
    const current = createTestStore(capturingSender([]));
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const owner = await current.createAccessToken({
      name: "Channel owner",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const headers = jsonHeaders(owner.token);

    const createdResponse = await app.request("/api/multiremi/notification-channels", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "local",
        kind: "feishu_group",
        name: "API group",
        target: { chatId: "oc_api_team" },
        eventTypes: ["issue_assigned"],
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    const channelId = created.channel.id as string;
    const listed = await (await app.request(
      "/api/multiremi/notification-channels?workspace_id=local",
      { headers },
    )).json();
    expect(listed.channels).toHaveLength(1);

    const updatedResponse = await app.request(`/api/multiremi/notification-channels/${channelId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: false, name: "Muted API group" }),
    });
    expect(updatedResponse.status).toBe(200);
    expect((await updatedResponse.json()).channel).toMatchObject({
      id: channelId,
      name: "Muted API group",
      enabled: false,
      target: { chatId: "oc_api_team" },
    });

    const deletedResponse = await app.request(`/api/multiremi/notification-channels/${channelId}`, {
      method: "DELETE",
      headers,
    });
    expect(deletedResponse.status).toBe(200);
    expect(current.listNotificationChannels("local")).toEqual([]);
  });

  it("rejects user and malformed Feishu targets at channel creation", async () => {
    const current = createTestStore(capturingSender([]));
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const owner = await current.createAccessToken({
      name: "Notification owner",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });

    for (const chatId of ["ou_user_123", "not-a-chat-id"]) {
      const response = await app.request("/api/multiremi/notification-channels", {
        method: "POST",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify({
          workspaceId: "local",
          kind: "feishu_group",
          name: "Invalid target",
          target: { chatId },
          eventTypes: ["*"],
        }),
      });
      expect(response.status).toBe(400);
    }
    expect(current.listNotificationChannels("local")).toEqual([]);
  });

  it("forbids non-admin members from creating outbound channels", async () => {
    const current = createTestStore(capturingSender([]));
    current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-member",
      name: "Notification member",
      role: "member",
    });
    const memberToken = await current.createAccessToken({
      name: "Member token",
      type: "pat",
      workspaceId: "local",
      userId: "notification-member",
    });
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });

    const response = await app.request("/api/multiremi/notification-channels", {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({
        workspaceId: "local",
        kind: "feishu_group",
        name: "Forbidden target",
        target: { chatId: "oc_team_123" },
        eventTypes: ["*"],
      }),
    });

    expect(response.status).toBe(403);
    expect(current.listNotificationChannels("local")).toEqual([]);
  });

  it("hard-denies task credentials from configuring an outbound target", async () => {
    const current = createTestStore(capturingSender([]));
    const taskToken = await current.createAccessToken({
      name: "Notification task",
      type: "task",
      workspaceId: "local",
      userId: "local",
      taskId: "tsk_notification_config",
      agentId: "agt_notification_config",
    });
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });

    const response = await app.request("/api/multiremi/notification-channels", {
      method: "POST",
      headers: jsonHeaders(taskToken.token),
      body: JSON.stringify({
        workspaceId: "local",
        kind: "feishu_group",
        name: "Task-controlled target",
        target: { chatId: "oc_team_123" },
        eventTypes: ["*"],
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "forbidden for task token",
      code: "task_token_hard_denied",
    });
    expect(current.listNotificationChannels("local")).toEqual([]);
  });

  it("re-drives a failed delivery through the retry endpoint", async () => {
    let shouldFail = true;
    const sent: OutboundNotification[] = [];
    const sender: OutboundNotificationSender = {
      async send(notification): Promise<void> {
        sent.push(notification);
        if (shouldFail) throw new Error("retryable test failure");
      },
    };
    const current = createTestStore(sender, { maxAttempts: 1 });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    createAssignedIssue(current, "Retry delivery");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;
    await waitForDelivery(current, pending.id, "failed");
    shouldFail = false;
    const owner = await current.createAccessToken({
      name: "Retry owner",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });

    const response = await app.request(`/api/multiremi/notification-deliveries/${pending.id}/retry`, {
      method: "POST",
      headers: jsonHeaders(owner.token),
    });
    expect(response.status).toBe(202);
    const delivered = await waitForDelivery(current, pending.id, "sent");

    expect(delivered.attempts).toBe(1);
    expect(delivered.lastError).toBeNull();
    expect(sent).toHaveLength(2);
  });
});

function createTestStore(
  sender?: OutboundNotificationSender,
  options: { maxAttempts?: number; retryBaseDelayMs?: number; publicUrl?: string } = {},
): MultiremiStore {
  db = new Database(":memory:");
  store = new MultiremiStore(db, {
    notificationSenders: sender ? { feishu_group: sender } : undefined,
    notificationMaxAttempts: options.maxAttempts,
    notificationRetryBaseDelayMs: options.retryBaseDelayMs,
    publicUrl: options.publicUrl,
  });
  store.ensureLocalWorkspace();
  return store;
}

function createChannel(
  current: MultiremiStore,
  input: { enabled?: boolean; eventTypes: string[] },
): void {
  current.createNotificationChannel({
    workspaceId: "local",
    kind: "feishu_group",
    name: "Team notifications",
    enabled: input.enabled,
    target: { chatId: "oc_team_123" },
    eventTypes: input.eventTypes,
    minSeverity: "info",
    createdBy: "local",
  });
}

function createAssignedIssue(current: MultiremiStore, title: string) {
  const member = current.listWorkspaceMembers("local")[0]!;
  const issue = current.createIssue({ title, workspaceId: "local" });
  current.assignIssue(issue.id, { assigneeType: "member", assigneeId: member.id });
  return { issue, member };
}

function capturingSender(sent: OutboundNotification[]): OutboundNotificationSender {
  return {
    async send(notification): Promise<void> {
      sent.push(notification);
    },
  };
}

async function waitForDelivery(
  current: MultiremiStore,
  id: string,
  status: MultiremiNotificationDelivery["status"],
  timeoutMs = 1_000,
): Promise<MultiremiNotificationDelivery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const delivery = current.getNotificationDelivery(id);
    if (delivery?.status === status) return delivery;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for notification delivery ${id} to become ${status}`);
}

function jsonHeaders(token: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
