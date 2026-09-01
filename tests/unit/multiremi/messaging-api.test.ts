import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { CanonicalMessage } from "@multiremi/contracts/messaging.js";
import {
  MessageProviderError,
  type ConversationProvider,
  type ConversationSearchResult,
  type MessageConversation,
  type MessageAuthorizationSession,
  type MessageConnectionProvisioningInput,
  type MessageConnectionProvisioningProvider,
  type MessageInteractiveAuthorizationProvider,
  type MessageProviderContext,
  type MessageProviderHealth,
  type MessageProviderManifest,
} from "@multiremi/contracts/messaging.js";
import { MessageProviderRegistry } from "@multiremi/messaging/index.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const MANIFEST: MessageProviderManifest = {
  provider: "test_provider",
  channels: ["test_channel", "second_channel"],
  displayName: "Test provider",
  authMethods: ["external_tool"],
  capabilities: {
    pull: true,
    push: false,
    searchConversations: true,
    readConversations: true,
    send: false,
    reply: false,
    attachmentDownload: false,
    attachmentUpload: false,
    mention: false,
    reaction: false,
    edit: false,
    recall: false,
    connectionProvisioning: true,
    interactiveAuthorization: true,
  },
};

function conversation(id: string, name: string): MessageConversation {
  return { externalConversationId: id, name, kind: "group", url: null, memberCount: null, metadata: {} };
}

/** Stands in for a channel: it answers health and conversation search, nothing else. */
class TestProvider implements
  ConversationProvider,
  MessageConnectionProvisioningProvider,
  MessageInteractiveAuthorizationProvider {
  readonly manifest = MANIFEST;
  health: MessageProviderHealth = {
    status: "ready",
    version: "1.0.0",
    externalAccountId: "account_1",
    externalAccountName: "Test Account",
    errorCode: null,
    detail: null,
    checkedAt: "2026-08-31T09:00:00.000Z",
  };
  provisioned: MessageConnectionProvisioningInput[] = [];
  removedConnectionIds: string[] = [];
  authorization: MessageAuthorizationSession = {
    id: "authorization_1",
    status: "pending",
    verificationUrl: "https://example.test/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-08-31T09:10:00.000Z",
    errorCode: null,
  };

  async checkHealth(_context: MessageProviderContext): Promise<MessageProviderHealth> {
    return this.health;
  }

  async searchConversations(): Promise<ConversationSearchResult> {
    return {
      conversations: [conversation("conversation_1", "Product chat"), conversation("conversation_2", "Random")],
      cursor: null,
      done: true,
    };
  }

  async getConversation(
    _context: MessageProviderContext,
    externalConversationId: string,
  ): Promise<MessageConversation | null> {
    return conversation(externalConversationId, "Product chat");
  }

  async provisionConnection(
    _context: MessageProviderContext,
    input: MessageConnectionProvisioningInput,
  ) {
    this.provisioned.push(input);
    return { config: { profile: "isolated_profile", managedProfile: true } };
  }

  async removeConnection(context: MessageProviderContext): Promise<void> {
    this.removedConnectionIds.push(context.connection.id);
  }

  async beginAuthorization(): Promise<MessageAuthorizationSession> {
    return { ...this.authorization };
  }

  async getAuthorizationSession(
    _context: MessageProviderContext,
    sessionId: string,
  ): Promise<MessageAuthorizationSession | null> {
    return sessionId === this.authorization.id ? { ...this.authorization } : null;
  }
}

const AUTH = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };

function createApp(provider = new TestProvider()): {
  app: ReturnType<typeof createMultiremiApp>;
  store: MultiremiStore;
  provider: TestProvider;
} {
  const store = createStore();
  store.ensureLocalWorkspace();
  const app = createMultiremiApp({
    store,
    authToken: "root-secret",
    messagingProviders: new MessageProviderRegistry([provider]),
  });
  return { app, store, provider };
}

function message(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    externalMessageId: "external_1",
    externalConversationId: "conversation_1",
    conversationName: "Product chat",
    conversationKind: "group",
    externalThreadId: null,
    externalRootId: null,
    externalParentId: null,
    sender: { externalSenderId: "sender_1", displayName: "Sender", kind: "user", isSelf: false },
    text: "the deploy is stuck",
    attachments: [],
    mentions: [],
    reactions: [],
    url: null,
    sentAt: "2026-08-31T10:00:00.000Z",
    editedAt: null,
    recalled: false,
    raw: {},
    ...overrides,
  };
}

describe("messaging API", () => {
  it("creates a Connection and a Source, and refuses a Provider or channel it does not serve", async () => {
    const { app } = createApp();

    const providers = await app.request("/api/workspaces/local/messaging/providers", { headers: AUTH });
    expect(await providers.json()).toMatchObject({
      providers: [{ provider: "test_provider", capabilities: { pull: true, send: false } }],
      channels: ["second_channel", "test_channel"],
    });

    const unknown = await app.request("/api/workspaces/local/messaging/connections", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ provider: "nope", channel: "test_channel", name: "X" }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: expect.stringContaining("not registered") });

    // A Provider serving more than one channel must be told which one.
    const ambiguous = await app.request("/api/workspaces/local/messaging/connections", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ provider: "test_provider", name: "X" }),
    });
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ error: expect.stringContaining("channel is required") });

    const wrongChannel = await app.request("/api/workspaces/local/messaging/connections", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ provider: "test_provider", channel: "slack", name: "X" }),
    });
    expect(wrongChannel.status).toBe(400);

    const created = await app.request("/api/workspaces/local/messaging/connections", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ provider: "test_provider", channel: "test_channel", name: "Work account" }),
    });
    expect(created.status).toBe(201);
    const { connection } = await created.json();
    expect(connection).toMatchObject({ provider: "test_provider", channel: "test_channel", status: "unknown" });

    // Provider and channel are identity: a PATCH cannot reinterpret stored history.
    const patched = await app.request(`/api/workspaces/local/messaging/connections/${connection.id}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ provider: "other", channel: "second_channel", name: "Renamed" }),
    });
    expect(await patched.json()).toMatchObject({
      connection: { provider: "test_provider", channel: "test_channel", name: "Renamed" },
    });

    const source = await app.request("/api/workspaces/local/messaging/sources", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ connectionId: connection.id, name: "Work source" }),
    });
    expect(source.status).toBe(201);
    // Nothing is ingested until somebody consents to a conversation.
    expect((await source.json()).source.allowlist).toEqual([]);
  });

  it("provisions credentials ephemerally and drives authorization through an opaque session", async () => {
    const { app, store, provider } = createApp();
    const createdResponse = await app.request("/api/workspaces/local/messaging/connections", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        provider: "test_provider",
        channel: "test_channel",
        name: "Work account",
        configuration: { appId: "cli_app", appSecret: "must-not-persist" },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const createdBody = await createdResponse.json();
    const connectionId = createdBody.connection.id as string;
    expect(JSON.stringify(createdBody)).not.toContain("must-not-persist");
    expect(provider.provisioned).toEqual([{ appId: "cli_app", appSecret: "must-not-persist" }]);
    expect(store.messaging.getConnection(connectionId)?.config).toEqual({
      profile: "isolated_profile",
      managedProfile: true,
    });

    const beginResponse = await app.request(
      `/api/workspaces/local/messaging/connections/${connectionId}/authorization-sessions`,
      { method: "POST", headers: AUTH },
    );
    expect(beginResponse.status).toBe(201);
    const beginBody = await beginResponse.json();
    expect(beginBody).toMatchObject({
      authorization: {
        id: "authorization_1",
        status: "pending",
        verificationUrl: "https://example.test/device",
      },
      connection: { status: "unauthenticated" },
    });

    provider.authorization = { ...provider.authorization, status: "ready" };
    const statusResponse = await app.request(
      `/api/workspaces/local/messaging/connections/${connectionId}/authorization-sessions/authorization_1`,
      { headers: AUTH },
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      authorization: { status: "ready" },
      connection: { status: "ready", externalAccountId: "account_1" },
    });

    const deleted = await app.request(`/api/workspaces/local/messaging/connections/${connectionId}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(deleted.status).toBe(200);
    expect(provider.removedConnectionIds).toEqual([connectionId]);
  });

  it("stores what the health check found, and says when no Provider is registered", async () => {
    const { app, store, provider } = createApp();
    const connection = store.messaging.upsertConnection({
      id: "mconn_1",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: "Work account",
      status: "unknown",
    });

    const ready = await app.request(`/api/workspaces/local/messaging/connections/${connection.id}/check`, {
      method: "POST",
      headers: AUTH,
    });
    expect(await ready.json()).toMatchObject({
      connection: { status: "ready", externalAccountName: "Test Account", lastErrorCode: null },
    });

    provider.health = {
      status: "unauthenticated",
      version: "1.0.0",
      externalAccountId: null,
      externalAccountName: null,
      errorCode: "unauthenticated",
      detail: "log in again",
      checkedAt: "2026-08-31T09:05:00.000Z",
    };
    const expired = await app.request(`/api/workspaces/local/messaging/connections/${connection.id}/check`, {
      method: "POST",
      headers: AUTH,
    });
    // The verdict lands on the Connection, so the UI can say what to fix.
    expect(await expired.json()).toMatchObject({
      connection: { status: "unauthenticated", lastErrorCode: "unauthenticated" },
    });

    const orphan = store.messaging.upsertConnection({
      id: "mconn_orphan",
      workspaceId: "local",
      provider: "uninstalled_provider",
      channel: "test_channel",
      name: "Orphan",
      status: "ready",
    });
    const missing = await app.request(`/api/workspaces/local/messaging/connections/${orphan.id}/check`, {
      method: "POST",
      headers: AUTH,
    });
    expect(await missing.json()).toMatchObject({
      connection: { status: "unavailable", lastErrorCode: "provider_unavailable" },
      health: null,
    });
    const listed = await app.request("/api/workspaces/local/messaging/connections", { headers: AUTH });
    expect((await listed.json()).connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "mconn_orphan", providerRegistered: false }),
      expect.objectContaining({ id: "mconn_1", providerRegistered: true }),
    ]));
  });

  it("lists messages, conversations and sync health from what was actually ingested", async () => {
    const { app, store } = createApp();
    store.messaging.upsertConnection({
      id: "mconn_1",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: "Work account",
      status: "ready",
    });
    const source = store.messaging.upsertSource({
      id: "msrc_1",
      workspaceId: "local",
      connectionId: "mconn_1",
      name: "Work source",
      allowlist: [
        { externalConversationId: "conversation_1", addedAt: "2026-08-31T09:00:00.000Z" },
        { externalConversationId: "conversation_2", addedAt: "2026-08-31T09:00:00.000Z" },
      ],
    });
    store.messaging.ingestMessages({
      connectionId: "mconn_1",
      sourceId: source.id,
      messages: [
        message(),
        message({
          externalMessageId: "external_2",
          externalConversationId: "conversation_2",
          conversationName: "Random",
          text: "lunch?",
          sentAt: "2026-08-31T11:00:00.000Z",
        }),
      ],
    });

    const all = await app.request("/api/workspaces/local/messaging/messages", { headers: AUTH });
    const allBody = await all.json();
    expect(allBody.total).toBe(2);
    // Newest first, so a reader sees the latest without paging.
    expect(allBody.messages.map((m: { externalMessageId: string }) => m.externalMessageId))
      .toEqual(["external_2", "external_1"]);

    const searched = await app.request("/api/workspaces/local/messaging/messages?q=deploy", { headers: AUTH });
    expect((await searched.json()).messages).toHaveLength(1);
    const filtered = await app.request(
      "/api/workspaces/local/messaging/messages?conversation=conversation_2",
      { headers: AUTH },
    );
    expect((await filtered.json()).messages).toHaveLength(1);
    const conflicting = await app.request(
      "/api/workspaces/local/messaging/messages?processed=true&unprocessed=true",
      { headers: AUTH },
    );
    expect(conflicting.status).toBe(400);

    const conversations = await app.request("/api/workspaces/local/messaging/conversations", { headers: AUTH });
    expect((await conversations.json()).conversations).toEqual([
      expect.objectContaining({ externalConversationId: "conversation_2", messageCount: 1, inAllowlist: true }),
      expect.objectContaining({ externalConversationId: "conversation_1", messageCount: 1, inAllowlist: true }),
    ]);

    store.messaging.recordSourceFailure(source.id, "rate_limited", "2026-08-31T12:00:00.000Z");
    const status = await app.request(`/api/workspaces/local/messaging/sources/${source.id}/status`, {
      headers: AUTH,
    });
    expect(await status.json()).toMatchObject({
      status: {
        messageCount: 2,
        unprocessedCount: 2,
        allowlistCount: 2,
        lastErrorCode: "rate_limited",
        consecutiveFailures: 1,
        syncing: false,
      },
    });

    const candidates = await app.request(
      `/api/workspaces/local/messaging/sources/${source.id}/available-conversations`,
      { headers: AUTH },
    );
    expect((await candidates.json()).conversations).toEqual([
      expect.objectContaining({ externalConversationId: "conversation_1", inAllowlist: true }),
      expect.objectContaining({ externalConversationId: "conversation_2", inAllowlist: true }),
    ]);
  });

  it("carries outcomes through the composite message key and keeps approval human", async () => {
    const { app, store } = createApp();
    store.messaging.upsertConnection({
      id: "mconn_1",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: "Work account",
      status: "ready",
    });
    store.messaging.upsertSource({
      id: "msrc_1",
      workspaceId: "local",
      connectionId: "mconn_1",
      name: "Work source",
      allowlist: [{ externalConversationId: "conversation_1", addedAt: "2026-08-31T09:00:00.000Z" }],
    });
    store.messaging.ingestMessages({
      connectionId: "mconn_1",
      sourceId: "msrc_1",
      messages: [message(), message({ externalMessageId: "external_2", text: "second" })],
    });
    const agent = store.createAgent({ name: "Watcher", provider: "codex", issueCreationRequiresProposal: true });
    const task = store.createTask({ agentId: agent.id, prompt: "triage" });
    const credential = await store.createTaskAccessToken(task, "local");
    const taskHeaders = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
    const base = "/api/workspaces/local/messaging/connections/mconn_1/messages";

    const forged = await app.request(`${base}/external_1/resolve`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ outcome: "issue_created" }),
    });
    expect(forged.status).toBe(400);

    const ignored = await app.request(`${base}/external_1/resolve`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ outcome: "ignored", reason: "chatter" }),
    });
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toMatchObject({
      outcome: { outcomeKind: "ignored", reason: "chatter", taskId: task.id },
    });

    // An unknown message under a real Connection is a 404, not a silent no-op.
    const missing = await app.request(`${base}/external_missing/resolve`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ outcome: "ignored", reason: "chatter" }),
    });
    expect(missing.status).toBe(404);

    const directCreate = await app.request(`${base}/external_2/create-issue`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ title: "Bypass approval" }),
    });
    expect(directCreate.status).toBe(403);
    expect(await directCreate.json()).toMatchObject({ code: "human_approval_required" });

    const proposed = await app.request(`${base}/external_2/propose-issue`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ title: "Deploy is stuck", priority: "high" }),
    });
    expect(proposed.status).toBe(201);
    const proposedBody = await proposed.json();
    expect(proposedBody).toMatchObject({
      delivered: true,
      created: true,
      proposal: { proposalStatus: "pending", connectionId: "mconn_1", externalMessageId: "external_2" },
    });

    const pending = await app.request(
      "/api/workspaces/local/messaging/proposals?status=pending",
      { headers: AUTH },
    );
    expect(await pending.json()).toMatchObject({ total: 1, proposals: [{ id: proposedBody.proposal.id }] });

    const taskApproval = await app.request(
      `/api/workspaces/local/messaging/proposals/${proposedBody.proposal.id}/approve`,
      { method: "POST", headers: taskHeaders },
    );
    expect(taskApproval.status).toBe(403);

    const approved = await app.request(
      `/api/workspaces/local/messaging/proposals/${proposedBody.proposal.id}/approve`,
      { method: "POST", headers: AUTH },
    );
    expect(approved.status).toBe(201);
    const approvedBody = await approved.json();
    expect(approvedBody).toMatchObject({
      created: true,
      proposal: { proposalStatus: "approved" },
      outcome: { outcomeKind: "issue_created", ref: `issue:${approvedBody.issue.id}` },
      issue: { title: "Deploy is stuck" },
    });

    const detail = await app.request(`${base}/external_2`, { headers: AUTH });
    expect((await detail.json()).outcomes.map((o: { outcomeKind: string }) => o.outcomeKind))
      .toEqual(["issue_proposed", "issue_created"]);
  });

  it("keeps message text and the caller's token out of the logs", async () => {
    const { app, store } = createApp();
    store.messaging.upsertConnection({
      id: "mconn_1",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: "Work account",
      status: "ready",
    });
    store.messaging.upsertSource({
      id: "msrc_1",
      workspaceId: "local",
      connectionId: "mconn_1",
      name: "Work source",
      allowlist: [{ externalConversationId: "conversation_1", addedAt: "2026-08-31T09:00:00.000Z" }],
    });
    const secret = "board-deck-passphrase-hunter2";
    store.messaging.ingestMessages({
      connectionId: "mconn_1",
      sourceId: "msrc_1",
      messages: [message({ text: secret })],
    });
    const agent = store.createAgent({ name: "Watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "triage" });
    const credential = await store.createTaskAccessToken(task, "local");

    const written: string[] = [];
    // Structured logs pass an object as the payload, so serialize rather than
    // stringify — `String(obj)` would hide exactly what this test looks for.
    const capture = (...args: unknown[]) =>
      void written.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    Object.assign(console, { log: capture, info: capture, warn: capture, error: capture });
    try {
      await app.request("/api/workspaces/local/messaging/connections/mconn_1/messages/external_1/propose-issue", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Rotate the credential", description: secret }),
      });
      await app.request("/api/workspaces/local/messaging/messages?q=board-deck", { headers: AUTH });
    } finally {
      Object.assign(console, original);
    }

    const log = written.join("\n");
    // The request is logged for audit, but the message body and the bearer are not.
    expect(log).toContain("propose-issue");
    expect(log).not.toContain(secret);
    expect(log).not.toContain(credential.token);
    expect(log).not.toContain("root-secret");
  });

  it("keeps a task token from widening what is ingested", async () => {
    const { app, store } = createApp();
    store.messaging.upsertConnection({
      id: "mconn_1",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: "Work account",
      status: "ready",
    });
    const source = store.messaging.upsertSource({
      id: "msrc_1",
      workspaceId: "local",
      connectionId: "mconn_1",
      name: "Work source",
      allowlist: [],
    });
    const agent = store.createAgent({ name: "Watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "triage" });
    const credential = await store.createTaskAccessToken(task, "local");
    const taskHeaders = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

    for (const [method, path, body] of [
      ["POST", "/api/workspaces/local/messaging/connections", { provider: "test_provider", name: "New" }],
      ["PATCH", `/api/workspaces/local/messaging/sources/${source.id}`, { allowlist: ["conversation_1"] }],
      ["DELETE", `/api/workspaces/local/messaging/sources/${source.id}`, undefined],
    ] as const) {
      const denied = await app.request(path, {
        method,
        headers: taskHeaders,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "human_admin_required" });
    }
    expect(store.messaging.getSource(source.id)?.allowlist).toEqual([]);

    // Consent is stamped by the server, so a caller cannot backdate it to
    // sweep in messages sent before anybody agreed.
    const widened = await app.request(`/api/workspaces/local/messaging/sources/${source.id}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({
        allowlist: [{ externalConversationId: "conversation_1", addedAt: "not-a-date" }],
      }),
    });
    const entry = (await widened.json()).source.allowlist[0];
    expect(entry.externalConversationId).toBe("conversation_1");
    expect(Date.parse(entry.addedAt)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("maps a Provider failure to a status that says whose problem it is", async () => {
    class FailingProvider extends TestProvider {
      override async searchConversations(): Promise<never> {
        throw new MessageProviderError("rate_limited", "slow down");
      }
    }
    const { app, store } = createApp(new FailingProvider());
    store.messaging.upsertConnection({
      id: "mconn_1",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: "Work account",
      status: "ready",
    });
    const source = store.messaging.upsertSource({
      id: "msrc_1",
      workspaceId: "local",
      connectionId: "mconn_1",
      name: "Work source",
      allowlist: [],
    });

    const throttled = await app.request(
      `/api/workspaces/local/messaging/sources/${source.id}/available-conversations`,
      { headers: AUTH },
    );
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: "rate_limited" });
  });

  it("removes a Connection's messages and outcomes with it", async () => {
    const { app, store } = createApp();
    store.messaging.upsertConnection({
      id: "mconn_1",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      name: "Work account",
      status: "ready",
    });
    store.messaging.upsertSource({
      id: "msrc_1",
      workspaceId: "local",
      connectionId: "mconn_1",
      name: "Work source",
      allowlist: [{ externalConversationId: "conversation_1", addedAt: "2026-08-31T09:00:00.000Z" }],
    });
    store.messaging.ingestMessages({
      connectionId: "mconn_1",
      sourceId: "msrc_1",
      messages: [message()],
    });
    store.messagingOutcomes.record(
      { connectionId: "mconn_1", externalMessageId: "external_1" },
      { workspaceId: "local", outcome: "ignored", reason: "chatter" },
    );

    const deleted = await app.request("/api/workspaces/local/messaging/connections/mconn_1", {
      method: "DELETE",
      headers: AUTH,
    });
    expect(deleted.status).toBe(200);
    // The credential's whole history goes with it: no orphaned messages.
    expect(store.messaging.listMessages({ workspaceId: "local" }).total).toBe(0);
    expect(store.messaging.listSources({ workspaceId: "local" })).toEqual([]);
    expect(store.messaging.listOutcomes("mconn_1", "external_1")).toEqual([]);
  });
});
