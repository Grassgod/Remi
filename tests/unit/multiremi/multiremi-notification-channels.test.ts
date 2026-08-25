import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { MultiremiNotificationDelivery } from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api/server.js";
import {
  PermanentNotificationDeliveryError,
  type OutboundNotification,
  type OutboundNotificationSender,
} from "@multiremi/notifications/types.js";
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

  it("rejects coerced, padded, user, and malformed Feishu targets on create and update", async () => {
    const current = createTestStore(capturingSender([]));
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const owner = await current.createAccessToken({
      name: "Notification owner",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const valid = current.createNotificationChannel({
      workspaceId: "local",
      kind: "feishu_group",
      name: "Valid target",
      target: { chatId: "oc_valid_target" },
      eventTypes: ["*"],
      createdBy: "local",
    });

    for (const chatId of [["oc_array"], "  oc_space  ", "ou_user_123", "not-a-chat-id"]) {
      const createResponse = await app.request("/api/multiremi/notification-channels", {
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
      expect(createResponse.status).toBe(400);

      const updateResponse = await app.request(`/api/multiremi/notification-channels/${valid.id}`, {
        method: "PATCH",
        headers: jsonHeaders(owner.token),
        body: JSON.stringify({ target: { chatId } }),
      });
      expect(updateResponse.status).toBe(400);
    }
    expect(current.listNotificationChannels("local")).toEqual([valid]);
  });

  it("redacts known credential values before recording or listing sender errors", async () => {
    const canarySecret = "qa+canary/secret?=value";
    const encodedSecret = encodeURIComponent(canarySecret);
    const base64Secret = Buffer.from(canarySecret).toString("base64");
    process.env.MULTIREMI_FEISHU_APP_SECRET = canarySecret;
    const sender: OutboundNotificationSender = {
      async send(): Promise<void> {
        throw new Error(`raw=${canarySecret} query=${encodedSecret} b64=${base64Secret}`);
      },
    };
    const current = createTestStore(sender, { maxAttempts: 1 });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    createAssignedIssue(current, "Redacted failure");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const failed = await waitForDelivery(current, pending.id, "failed");
    expect(failed.lastError).toContain("***");
    for (const representation of [canarySecret, encodedSecret, base64Secret]) {
      expect(failed.lastError).not.toContain(representation);
    }

    current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-reader",
      name: "Notification reader",
      role: "member",
    });
    const memberToken = await current.createAccessToken({
      name: "Notification reader token",
      type: "pat",
      workspaceId: "local",
      userId: "notification-reader",
    });
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const response = await app.request(
      "/api/multiremi/notification-deliveries?workspace_id=local",
      { headers: jsonHeaders(memberToken.token) },
    );

    expect(response.status).toBe(200);
    const responseBody = JSON.stringify(await response.json());
    for (const representation of [canarySecret, encodedSecret, base64Secret]) {
      expect(responseBody).not.toContain(representation);
    }
  });

  it("maps arbitrary Feishu SDK diagnostics to a controlled error category", async () => {
    const appId = "qa+canary/app?id";
    const appSecret = "qa+canary/secret?=value";
    const encodedSecret = encodeURIComponent(appSecret);
    const base64Secret = Buffer.from(appSecret).toString("base64");
    const arbitrarySdkText = `raw=${appSecret} query=${encodedSecret} b64=${base64Secret}`;
    const { createFeishuGroupSender } = await import("@multiremi/notifications/feishu-group-sender.js");
    const sender = createFeishuGroupSender(
      {
        MULTIREMI_FEISHU_APP_ID: appId,
        MULTIREMI_FEISHU_APP_SECRET: appSecret,
      },
      {
        async sendCard(): Promise<never> {
          throw Object.assign(new Error(arbitrarySdkText), { code: 90001 });
        },
      },
    );
    const current = createTestStore(sender, { maxAttempts: 1 });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    createAssignedIssue(current, "Controlled Feishu failure");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const failed = await waitForDelivery(current, pending.id, "failed");

    expect(failed.lastError).toBe("feishu_send_failed category=unknown provider_code=90001");
    expect(failed.lastError).not.toContain(arbitrarySdkText);
    for (const representation of [appId, appSecret, encodedSecret, base64Secret]) {
      expect(failed.lastError).not.toContain(representation);
    }

    current.createWorkspaceMember({
      workspaceId: "local",
      userId: "controlled-error-reader",
      name: "Controlled error reader",
      role: "member",
    });
    const memberToken = await current.createAccessToken({
      name: "Controlled error reader token",
      type: "pat",
      workspaceId: "local",
      userId: "controlled-error-reader",
    });
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const response = await app.request(
      "/api/multiremi/notification-deliveries?workspace_id=local",
      { headers: jsonHeaders(memberToken.token) },
    );
    const responseBody = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(responseBody).toContain("feishu_send_failed category=unknown provider_code=90001");
    for (const representation of [appId, appSecret, encodedSecret, base64Secret, arbitrarySdkText]) {
      expect(responseBody).not.toContain(representation);
    }
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

  it("uses a database lease to prevent two dispatchers from sending the same delivery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "multiremi-notification-lease-"));
    const databasePath = join(directory, "shared.sqlite");
    const firstDb = new Database(databasePath, { create: true });
    const secondDb = new Database(databasePath, { create: true });
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCalls = 0;
    let secondCalls = 0;
    const firstStore = new MultiremiStore(firstDb, {
      notificationSenders: {
        feishu_group: {
          async send(): Promise<void> {
            firstCalls += 1;
            reportFirstStarted();
            await firstReleased;
          },
        },
      },
      notificationLeaseMs: 1_000,
      notificationSendTimeoutMs: 500,
    });
    const secondStore = new MultiremiStore(secondDb, {
      notificationSenders: {
        feishu_group: {
          async send(): Promise<void> {
            secondCalls += 1;
          },
        },
      },
      notificationLeaseMs: 1_000,
      notificationSendTimeoutMs: 500,
    });
    try {
      firstStore.ensureLocalWorkspace();
      createChannel(firstStore, { eventTypes: ["issue_assigned"] });
      createAssignedIssue(firstStore, "Shared delivery lease");
      const delivery = firstStore.listNotificationDeliveries({ workspaceId: "local" })[0]!;
      await firstStarted;

      const owner = await firstStore.createAccessToken({
        name: "Active delivery owner",
        type: "pat",
        workspaceId: "local",
        userId: "local",
      });
      const app = createMultiremiApp({ store: firstStore, authToken: "root-secret" });
      const beforeRetry = firstStore.getNotificationDelivery(delivery.id)!;
      const retryResponse = await app.request(
        `/api/multiremi/notification-deliveries/${delivery.id}/retry`,
        { method: "POST", headers: jsonHeaders(owner.token) },
      );
      expect(retryResponse.status).toBe(409);
      expect(await retryResponse.json()).toEqual({
        error: "notification delivery is currently being sent",
      });
      expect(firstStore.getNotificationDelivery(delivery.id)).toEqual(beforeRetry);
      expect(firstStore.retryNotificationDelivery(delivery.id)).toBeNull();
      expect(firstStore.getNotificationDelivery(delivery.id)).toEqual(beforeRetry);

      await secondStore.dispatchNotificationDelivery(delivery.id);
      expect(firstCalls).toBe(1);
      expect(secondCalls).toBe(0);

      releaseFirst();
      const sent = await waitForDelivery(firstStore, delivery.id, "sent");
      expect(sent.attempts).toBe(1);
      expect(firstCalls + secondCalls).toBe(1);
    } finally {
      releaseFirst?.();
      firstStore.stopNotificationDeliverySweeper();
      secondStore.stopNotificationDeliverySweeper();
      firstDb.close();
      secondDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses a monotonic claim sequence to fence an old worker across manual retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "multiremi-notification-fence-"));
    const databasePath = join(directory, "shared.sqlite");
    const firstDb = new Database(databasePath, { create: true });
    const secondDb = new Database(databasePath, { create: true });
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    let releaseSecond!: () => void;
    let reportSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      reportSecondStarted = resolve;
    });
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstStore = new MultiremiStore(firstDb, {
      notificationMaxAttempts: 1,
      notificationSenders: {
        feishu_group: {
          async send(): Promise<void> {
            reportFirstStarted();
            await firstReleased;
          },
        },
      },
    });
    const secondStore = new MultiremiStore(secondDb, {
      notificationMaxAttempts: 1,
      notificationSenders: {
        feishu_group: {
          async send(): Promise<void> {
            reportSecondStarted();
            await secondReleased;
            throw new PermanentNotificationDeliveryError("new generation failure");
          },
        },
      },
    });
    try {
      firstStore.ensureLocalWorkspace();
      const { issue, member } = createAssignedIssue(firstStore, "Manual retry fencing");
      const item = firstStore.listInboxItems(member.id).find((entry) => entry.issueId === issue.id)!;
      const channel = firstStore.createNotificationChannel({
        workspaceId: "local",
        kind: "feishu_group",
        name: "Fenced retry channel",
        target: { chatId: "oc_team_123" },
        eventTypes: ["issue_assigned"],
        createdBy: "local",
      });
      const delivery = firstStore.recordPendingNotificationDelivery(item, channel);
      const oldDispatch = firstStore.dispatchNotificationDelivery(delivery.id);
      await firstStarted;
      const oldClaim = firstStore.getNotificationDelivery(delivery.id)!;
      expect(oldClaim).toMatchObject({ attempts: 1, claimSeq: 1, status: "pending" });

      firstDb.run(
        "UPDATE multiremi_notification_deliveries SET leased_until = ? WHERE id = ?",
        ["2000-01-01T00:00:00.000Z", delivery.id],
      );
      const reset = firstStore.retryNotificationDelivery(delivery.id)!;
      expect(reset).toMatchObject({ attempts: 0, claimSeq: 2, status: "pending" });

      const newDispatch = secondStore.dispatchNotificationDelivery(delivery.id);
      await secondStarted;
      expect(secondStore.getNotificationDelivery(delivery.id)).toMatchObject({
        attempts: 1,
        claimSeq: 3,
        status: "pending",
      });

      releaseFirst();
      await oldDispatch;
      expect(firstStore.getNotificationDelivery(delivery.id)).toMatchObject({
        attempts: 1,
        claimSeq: 3,
        status: "pending",
      });

      releaseSecond();
      await newDispatch;
      expect(secondStore.getNotificationDelivery(delivery.id)).toMatchObject({
        attempts: 1,
        claimSeq: 3,
        status: "failed",
        lastError: "new generation failure",
      });
    } finally {
      releaseFirst?.();
      releaseSecond?.();
      firstStore.stopNotificationDeliverySweeper();
      secondStore.stopNotificationDeliverySweeper();
      firstDb.close();
      secondDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("times out a hung sender and re-drives the pending delivery", async () => {
    let calls = 0;
    const sender: OutboundNotificationSender = {
      async send(): Promise<void> {
        calls += 1;
        if (calls === 1) await new Promise<void>(() => undefined);
      },
    };
    const current = createTestStore(sender, {
      maxAttempts: 3,
      retryBaseDelayMs: 1,
      leaseMs: 20,
      sendTimeoutMs: 10,
    });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    createAssignedIssue(current, "Hung sender recovery");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const sent = await waitForDelivery(current, pending.id, "sent");
    expect(sent.attempts).toBe(2);
    expect(sent.leasedUntil).toBeNull();
    expect(calls).toBe(2);
  });

  it("moves an attempts-exhausted pending delivery to failed after its lease expires", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent), { maxAttempts: 3 });
    const { issue, member } = createAssignedIssue(current, "Exhausted delivery lease");
    const item = current.listInboxItems(member.id).find((entry) => entry.issueId === issue.id)!;
    const channel = current.createNotificationChannel({
      workspaceId: "local",
      kind: "feishu_group",
      name: "Exhausted lease channel",
      target: { chatId: "oc_team_123" },
      eventTypes: ["issue_assigned"],
      createdBy: "local",
    });
    const pending = current.recordPendingNotificationDelivery(item, channel);
    db!.run(
      `UPDATE multiremi_notification_deliveries
       SET attempts = 3, leased_until = ? WHERE id = ?`,
      ["2000-01-01T00:00:00.000Z", pending.id],
    );

    current.startNotificationDeliverySweeper();
    const failed = await waitForDelivery(current, pending.id, "failed");

    expect(failed.attempts).toBe(3);
    expect(failed.leasedUntil).toBeNull();
    expect(failed.lastError).toContain("attempts exhausted");
    expect(sent).toEqual([]);
  });
});

function createTestStore(
  sender?: OutboundNotificationSender,
  options: {
    maxAttempts?: number;
    retryBaseDelayMs?: number;
    leaseMs?: number;
    sendTimeoutMs?: number;
    publicUrl?: string;
  } = {},
): MultiremiStore {
  db = new Database(":memory:");
  store = new MultiremiStore(db, {
    notificationSenders: sender ? { feishu_group: sender } : undefined,
    notificationMaxAttempts: options.maxAttempts,
    notificationRetryBaseDelayMs: options.retryBaseDelayMs,
    notificationLeaseMs: options.leaseMs,
    notificationSendTimeoutMs: options.sendTimeoutMs,
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
