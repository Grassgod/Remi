import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  MultiremiAttachment,
  MultiremiNotificationChannel,
  MultiremiNotificationDelivery,
  MultiremiWorkspaceMember,
} from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api/server.js";
import { uploadedAttachmentPath } from "@multiremi/api/helpers/uploads.js";
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

  it("mirrors a personal channel only for its own member", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent));
    const owner = current.listWorkspaceMembers("local")[0]!;
    const other = current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-other",
      name: "Other member",
      role: "member",
    });
    createChannel(current, { eventTypes: ["*"], memberId: owner.id, chatId: "oc_owner_group" });

    createAssignedIssue(current, "Someone else's item", other);
    await Bun.sleep(10);
    expect(current.listNotificationDeliveries({ workspaceId: "local" })).toEqual([]);
    expect(sent).toEqual([]);

    createAssignedIssue(current, "The owner's own item", owner);
    const pending = current.listNotificationDeliveries({ workspaceId: "local" });
    expect(pending).toHaveLength(1);
    await waitForDelivery(current, pending[0]!.id, "sent");
    expect(sent.map((notification) => notification.chatId)).toEqual(["oc_owner_group"]);
  });

  it("keeps mirroring a workspace-level channel for every member", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent));
    const other = current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-other",
      name: "Other member",
      role: "member",
    });
    createChannel(current, { eventTypes: ["*"] });

    createAssignedIssue(current, "Workspace-wide mirror", other);
    const pending = current.listNotificationDeliveries({ workspaceId: "local" });
    expect(pending).toHaveLength(1);
    await waitForDelivery(current, pending[0]!.id, "sent");
    expect(sent.map((notification) => notification.chatId)).toEqual(["oc_team_123"]);
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

  it("uploads a local inbox attachment and falls back to its link when upload fails", async () => {
    const uploadDir = mkdtempSync(join(tmpdir(), "multiremi-inbox-image-"));
    const originalUploadDir = process.env.MULTIREMI_UPLOAD_DIR;
    process.env.MULTIREMI_UPLOAD_DIR = uploadDir;
    const attachment: MultiremiAttachment = {
      id: "att_inbox_image",
      workspaceId: "local",
      issueId: "issue-inbox-image",
      commentId: null,
      chatSessionId: null,
      chatMessageId: null,
      uploaderType: "member",
      uploaderId: "local",
      filename: "capture.png",
      url: "/api/attachments/att_inbox_image/content",
      contentType: "image/png",
      sizeBytes: 3,
      createdAt: new Date().toISOString(),
    };
    const filePath = uploadedAttachmentPath(attachment);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from("png"));
    const notification = {
      chatId: "oc_inbox_images",
      card: {},
      channel: {},
      delivery: {},
      workspace: { slug: "local" },
      publicUrl: "https://remi.example.test",
      item: {
        id: "inbox-image",
        workspaceId: "local",
        issueId: "issue-inbox-image",
        type: "comment_created",
        severity: "info",
        title: "Image reply",
        body: "See ![capture](/api/attachments/att_inbox_image/content)",
        details: null,
        createdAt: "2026-09-05T08:00:00.000Z",
        issue: null,
      },
    } as OutboundNotification;

    try {
      const { createFeishuGroupSender } = await import("@multiremi/notifications/feishu-group-sender.js");
      const uploaded: Buffer[] = [];
      let sentCard: Record<string, unknown> | null = null;
      const dependencies = {
        createClient: (() => ({})) as any,
        getAttachment: (id: string) => id === attachment.id ? attachment : null,
        uploadImage: (async (_client: unknown, image: Buffer | string) => {
          if (Buffer.isBuffer(image)) uploaded.push(image);
          return { imageKey: "img_inbox_uploaded" };
        }) as any,
        sendCard: (async (_client: unknown, _chatId: string, card: Record<string, unknown>) => {
          sentCard = card;
          return { messageId: "om_inbox_image", chatId: "oc_inbox_images" };
        }) as any,
      };
      await createFeishuGroupSender({
        MULTIREMI_FEISHU_APP_ID: "app",
        MULTIREMI_FEISHU_APP_SECRET: "secret",
      }, dependencies).send(notification);

      expect(uploaded).toEqual([Buffer.from("png")]);
      expect(JSON.stringify(sentCard)).toContain("img_inbox_uploaded");

      dependencies.uploadImage = (async () => {
        throw new Error("upload unavailable");
      }) as any;
      await createFeishuGroupSender({
        MULTIREMI_FEISHU_APP_ID: "app",
        MULTIREMI_FEISHU_APP_SECRET: "secret",
      }, dependencies).send(notification);
      const fallback = JSON.stringify(sentCard);
      expect(fallback).toContain("[图片: capture](https://remi.example.test/api/attachments/att_inbox_image/content)");
      expect(fallback).not.toContain("![capture]");
    } finally {
      restoreEnv("MULTIREMI_UPLOAD_DIR", originalUploadDir);
      rmSync(uploadDir, { recursive: true, force: true });
    }
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
    const configuredSecret = "  qa+canary/secret?=value  ";
    const canarySecret = configuredSecret.trim();
    const encodedSecret = encodeURIComponent(canarySecret);
    const base64Secret = Buffer.from(canarySecret).toString("base64");
    process.env.MULTIREMI_FEISHU_APP_SECRET = configuredSecret;
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

  it("fails closed when an SDK error field getter throws", async () => {
    const getterDiagnostic = "UNBOUNDED_SDK_GETTER_DIAGNOSTIC";
    const sdkError = new Error("ordinary SDK failure");
    Object.defineProperty(sdkError, "code", {
      get(): never {
        throw new Error(getterDiagnostic);
      },
    });
    const { createFeishuGroupSender } = await import("@multiremi/notifications/feishu-group-sender.js");
    const sender = createFeishuGroupSender(
      {
        MULTIREMI_FEISHU_APP_ID: "qa-app-id",
        MULTIREMI_FEISHU_APP_SECRET: "qa-app-secret",
      },
      {
        async sendCard(): Promise<never> {
          throw sdkError;
        },
      },
    );
    const current = createTestStore(sender, { maxAttempts: 1 });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    createAssignedIssue(current, "Getter-safe Feishu failure");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const failed = await waitForDelivery(current, pending.id, "failed");

    expect(failed.lastError).toBe("feishu_send_failed category=unknown");
    expect(failed.lastError).not.toContain(getterDiagnostic);
  });

  it("does not derive provider codes from arbitrary SDK messages", async () => {
    const messageNumber = "1234567890";
    const { createFeishuGroupSender } = await import("@multiremi/notifications/feishu-group-sender.js");
    const sender = createFeishuGroupSender(
      {
        MULTIREMI_FEISHU_APP_ID: "qa-app-id",
        MULTIREMI_FEISHU_APP_SECRET: "qa-app-secret",
      },
      {
        async sendCard(): Promise<never> {
          throw new Error(`upstream diagnostic code ${messageNumber}`);
        },
      },
    );
    const current = createTestStore(sender, { maxAttempts: 1 });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    createAssignedIssue(current, "Message-code Feishu failure");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const failed = await waitForDelivery(current, pending.id, "failed");

    expect(failed.lastError).toBe("feishu_send_failed category=unknown");
    expect(failed.lastError).not.toContain(messageNumber);
  });

  it("drops structured numeric diagnostics that equal normalized credentials", async () => {
    const appId = " 1234567890 ";
    const appSecret = " 9876543210 ";
    const { createFeishuGroupSender } = await import("@multiremi/notifications/feishu-group-sender.js");
    const sender = createFeishuGroupSender(
      {
        MULTIREMI_FEISHU_APP_ID: appId,
        MULTIREMI_FEISHU_APP_SECRET: appSecret,
      },
      {
        async sendCard(): Promise<never> {
          throw Object.assign(new Error("structured SDK failure"), {
            code: appSecret.trim(),
            statusCode: appId.trim(),
          });
        },
      },
    );
    const current = createTestStore(sender, { maxAttempts: 1 });
    createChannel(current, { eventTypes: ["issue_assigned"] });
    createAssignedIssue(current, "Credential-code Feishu failure");
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;

    const failed = await waitForDelivery(current, pending.id, "failed");

    expect(failed.lastError).toBe("feishu_send_failed category=unknown");
    expect(failed.lastError).not.toContain(appId.trim());
    expect(failed.lastError).not.toContain(appSecret.trim());
  });

  it("forbids non-admin members from creating workspace-level outbound channels", async () => {
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
        scope: "workspace",
        kind: "feishu_group",
        name: "Forbidden target",
        target: { chatId: "oc_team_123" },
        eventTypes: ["*"],
      }),
    });

    expect(response.status).toBe(403);
    expect(current.listNotificationChannels("local")).toEqual([]);
  });

  it("lets a plain member own a personal channel and defaults to that scope", async () => {
    const current = createTestStore(capturingSender([]));
    const member = current.createWorkspaceMember({
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
        name: "My own group",
        target: { chatId: "oc_my_own_group" },
        eventTypes: ["*"],
      }),
    });

    expect(response.status).toBe(201);
    const { channel } = await response.json() as { channel: { memberId: string | null } };
    expect(channel.memberId).toBe(member.id);
  });

  it("rejects a scope that is only a scope after coercion", async () => {
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

    for (const scope of [["member"], ["workspace"], 1, { kind: "member" }, null]) {
      const response = await app.request("/api/multiremi/notification-channels", {
        method: "POST",
        headers: jsonHeaders(memberToken.token),
        body: JSON.stringify({
          workspaceId: "local",
          scope,
          kind: "feishu_group",
          name: "Coerced scope",
          target: { chatId: "oc_team_123" },
          eventTypes: ["*"],
        }),
      });
      expect(response.status).toBe(400);
    }
    expect(current.listNotificationChannels("local")).toEqual([]);
  });

  it("refuses to let a member name someone else as the channel owner", async () => {
    const current = createTestStore(capturingSender([]));
    const victim = current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-victim",
      name: "Victim",
      role: "member",
    });
    current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-attacker",
      name: "Attacker",
      role: "member",
    });
    const attackerToken = await current.createAccessToken({
      name: "Attacker token",
      type: "pat",
      workspaceId: "local",
      userId: "notification-attacker",
    });
    const app = createMultiremiApp({ store: current, authToken: "root-secret" });

    for (const field of ["memberId", "member_id", "ownerId", "owner_id"]) {
      const response = await app.request("/api/multiremi/notification-channels", {
        method: "POST",
        headers: jsonHeaders(attackerToken.token),
        body: JSON.stringify({
          workspaceId: "local",
          kind: "feishu_group",
          name: "Hijack",
          target: { chatId: "oc_attacker_group" },
          eventTypes: ["*"],
          [field]: victim.id,
        }),
      });
      expect(response.status).toBe(400);
    }
    expect(current.listNotificationChannels("local")).toEqual([]);
  });

  it("hides another member's personal channel and its delivery trail", async () => {
    const sent: OutboundNotification[] = [];
    const current = createTestStore(capturingSender(sent));
    const admin = current.listWorkspaceMembers("local")[0]!;
    const nosy = current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-nosy",
      name: "Nosy member",
      role: "member",
    });
    const nosyToken = await current.createAccessToken({
      name: "Nosy token",
      type: "pat",
      workspaceId: "local",
      userId: "notification-nosy",
    });
    createChannel(current, {
      eventTypes: ["*"],
      memberId: admin.id,
      chatId: "oc_private_group",
      name: "Admin private",
    });
    createChannel(current, { eventTypes: ["*"], name: "Shared" });
    createAssignedIssue(current, "Two mirrors", admin);
    await Bun.sleep(10);
    // The admin's item matched both channels; only the shared one is anyone else's business.
    expect(current.listNotificationDeliveries({ workspaceId: "local" })).toHaveLength(2);

    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const channelsResponse = await app.request(
      "/api/multiremi/notification-channels?workspaceId=local",
      { headers: jsonHeaders(nosyToken.token) },
    );
    const channels = await channelsResponse.json() as { channels: MultiremiNotificationChannel[] };
    expect(channels.channels.map((channel) => channel.name)).toEqual(["Shared"]);
    expect(JSON.stringify(channels)).not.toContain("oc_private_group");

    const deliveriesResponse = await app.request(
      "/api/multiremi/notification-deliveries?workspaceId=local",
      { headers: jsonHeaders(nosyToken.token) },
    );
    const deliveries = await deliveriesResponse.json() as { deliveries: MultiremiNotificationDelivery[] };
    expect(deliveries.deliveries.map((delivery) => delivery.targetLabel)).toEqual(["Shared"]);
    expect(nosy.id).not.toBe(admin.id);
  });

  it("shows a task token workspace-level channels and deliveries only", async () => {
    const current = createTestStore(capturingSender([]));
    const owner = current.listWorkspaceMembers("local")[0]!;
    // A task token carries userId=local, which resolves to the owner's membership.
    // Both endpoints have to refuse to treat that as "this agent is that member".
    const taskToken = await current.createAccessToken({
      name: "Notification reader",
      type: "task",
      workspaceId: "local",
      userId: "local",
      taskId: "tsk_notification_read",
      agentId: "agt_notification_read",
    });
    createChannel(current, { eventTypes: ["*"], memberId: owner.id, chatId: "oc_private_group", name: "Private" });
    createChannel(current, { eventTypes: ["*"], name: "Shared" });
    createAssignedIssue(current, "Task token visibility", owner);
    await Bun.sleep(10);

    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const channelsResponse = await app.request(
      "/api/multiremi/notification-channels?workspaceId=local",
      { headers: jsonHeaders(taskToken.token) },
    );
    const channels = await channelsResponse.json() as { channels: MultiremiNotificationChannel[] };
    expect(channels.channels.map((channel) => channel.name)).toEqual(["Shared"]);
    expect(JSON.stringify(channels)).not.toContain("oc_private_group");

    const response = await app.request(
      "/api/multiremi/notification-deliveries?workspaceId=local",
      { headers: jsonHeaders(taskToken.token) },
    );
    const body = await response.json() as { deliveries: MultiremiNotificationDelivery[] };

    // Failure visibility for shared routing stays available to agents; a member's own
    // outbound targets do not leak into anything an agent can read.
    expect(body.deliveries.map((delivery) => delivery.targetLabel)).toEqual(["Shared"]);
  });

  it("refuses a member retrying another member's personal delivery", async () => {
    const sender: OutboundNotificationSender = {
      async send(): Promise<void> {
        throw new PermanentNotificationDeliveryError("permanent outbound failure");
      },
    };
    const current = createTestStore(sender);
    const owner = current.listWorkspaceMembers("local")[0]!;
    current.createWorkspaceMember({
      workspaceId: "local",
      userId: "notification-outsider",
      name: "Outsider",
      role: "member",
    });
    const outsiderToken = await current.createAccessToken({
      name: "Outsider token",
      type: "pat",
      workspaceId: "local",
      userId: "notification-outsider",
    });
    createChannel(current, { eventTypes: ["*"], memberId: owner.id, chatId: "oc_owner_group" });
    createAssignedIssue(current, "Owner-only failure", owner);
    const pending = current.listNotificationDeliveries({ workspaceId: "local" })[0]!;
    const failed = await waitForDelivery(current, pending.id, "failed");

    const app = createMultiremiApp({ store: current, authToken: "root-secret" });
    const response = await app.request(
      `/api/multiremi/notification-deliveries/${failed.id}/retry`,
      { method: "POST", headers: jsonHeaders(outsiderToken.token) },
    );

    expect(response.status).toBe(403);
    expect(current.getNotificationDelivery(failed.id)!.status).toBe("failed");
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
  }, 15_000);

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
  }, 15_000);

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
  input: { enabled?: boolean; eventTypes: string[]; memberId?: string | null; chatId?: string; name?: string },
): MultiremiNotificationChannel {
  return current.createNotificationChannel({
    workspaceId: "local",
    memberId: input.memberId,
    kind: "feishu_group",
    name: input.name ?? "Team notifications",
    enabled: input.enabled,
    target: { chatId: input.chatId ?? "oc_team_123" },
    eventTypes: input.eventTypes,
    minSeverity: "info",
    createdBy: "local",
  });
}

function createAssignedIssue(current: MultiremiStore, title: string, assignee?: MultiremiWorkspaceMember) {
  const member = assignee ?? current.listWorkspaceMembers("local")[0]!;
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
