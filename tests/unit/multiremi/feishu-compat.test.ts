import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type {
  ConversationProvider,
  ConversationSearchResult,
  MessageConversation,
  MessageErrorCode,
  MessageProviderHealth,
  MessageProviderManifest,
} from "@multiremi/contracts/messaging.js";
import { MessageProviderError } from "@multiremi/contracts/messaging.js";
import { MessageProviderRegistry } from "@multiremi/messaging/index.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { IngestedFeishuMessageInput } from "@multiremi/store/repos/feishu-ingest-repo.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

/**
 * The `/feishu` API that shipped desktop builds still call.
 *
 * It is served by the Messaging Core now, and there is no sidecar behind it.
 * These tests hold the seam from the old side: legacy rows are seeded, the
 * upgrade is replayed, and every assertion is written the way a client from
 * before the refactor would read the response — legacy paths, legacy field
 * names, legacy ids. The Core's own API is covered in messaging-api.test.ts;
 * what is checked here is only that the translation between them is faithful.
 */

/** The migration that carries legacy rows into the Core, as `runMigrations` knows it. */
const MESSAGING_CORE_MIGRATION = "20260831_messaging_core_v1";

const MANIFEST: MessageProviderManifest = {
  provider: "lark_cli",
  channels: ["feishu"],
  displayName: "Lark CLI",
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
  },
};

/** Stands in for lark-cli: it answers health and conversation search, nothing else. */
class StubProvider implements ConversationProvider {
  readonly manifest = MANIFEST;
  health: MessageProviderHealth = {
    status: "ready",
    version: "0.9.1",
    externalAccountId: "ou_self",
    externalAccountName: "Test Account",
    errorCode: null,
    detail: null,
    checkedAt: "2026-08-31T09:00:00.000Z",
  };

  /** Set to make conversation search fail the way a real lark-cli would. */
  failure: MessageProviderError | null = null;

  async checkHealth(): Promise<MessageProviderHealth> {
    return this.health;
  }

  async searchConversations(): Promise<ConversationSearchResult> {
    if (this.failure) throw this.failure;
    return {
      conversations: [
        {
          externalConversationId: "oc_allowed1",
          name: "研发群",
          kind: "group",
          url: null,
          memberCount: 12,
          metadata: { external: false, description: "Engineering" },
        },
        {
          externalConversationId: "oc_other1",
          name: "Random",
          kind: "direct",
          url: null,
          memberCount: 2,
          metadata: {},
        },
      ],
      cursor: null,
      done: true,
    };
  }

  async getConversation(): Promise<MessageConversation | null> {
    return null;
  }
}

const AUTH = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
const BASE = "/api/workspaces/local/feishu";

function createApp(store: MultiremiStore, provider = new StubProvider()) {
  return createMultiremiApp({
    store,
    authToken: "root-secret",
    messagingProviders: new MessageProviderRegistry([provider]),
  });
}

function legacyMessage(
  messageId: string,
  chatId: string,
  createdAt: string,
  text: string,
  chat: { name?: string; type?: string } = {},
): IngestedFeishuMessageInput {
  return {
    messageId,
    chatId,
    chatName: chat.name ?? null,
    chatType: chat.type ?? null,
    sender: { id: "ou_sender", display_name: "Wang" },
    content: { message_id: messageId, chat_id: chatId, text, create_time: createdAt },
    searchableText: text,
    contentFingerprint: `fingerprint:${messageId}`,
    createdAt,
  };
}

/**
 * Seeds a store the way it looked before the refactor, then upgrades it.
 *
 * The migration marker is cleared rather than the store rebuilt, because that
 * is the real sequence: a server that has been running holds legacy rows and
 * has not applied the Core migration yet.
 */
function migratedStore(): { store: MultiremiStore; sourceId: string } {
  const store = createStore();
  store.ensureLocalWorkspace();
  const source = store.createFeishuSource({
    workspaceId: "local",
    name: "研发消息",
    endpointName: "local",
    allowlist: [
      { chatId: "oc_allowed1", addedAt: "2026-08-25T10:00:00.000Z" },
      { chatId: "oc_direct1", addedAt: "2026-08-25T10:00:00.000Z" },
    ],
  });
  store.ingestFeishuBatch(source.id, [
    legacyMessage("om_dm", "oc_direct1", "2026-08-25T10:00:30.000Z", "ping", { name: "Wang", type: "p2p" }),
    legacyMessage("om_kept", "oc_allowed1", "2026-08-25T10:01:00.000Z", "deploy is stuck", { name: "研发群", type: "group" }),
    legacyMessage("om_done", "oc_allowed1", "2026-08-25T10:02:00.000Z", "small talk", { name: "研发群", type: "group" }),
  ]);
  store.resolveFeishuMessage("om_done", {
    workspaceId: "local",
    outcome: "ignored",
    reason: "casual conversation",
  });
  db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [MESSAGING_CORE_MIGRATION]);
  runMigrations(db as unknown as SqlDatabase);
  return { store, sourceId: source.id };
}

describe("legacy /feishu API on the Messaging Core", () => {
  it("serves migrated data to an old client under the field names it knows", async () => {
    const { store, sourceId } = migratedStore();
    const app = createApp(store);

    const endpoints = await app.request(`${BASE}/endpoints`, { headers: AUTH });
    expect(endpoints.status).toBe(200);
    expect(await endpoints.json()).toMatchObject({
      configured: true,
      endpoints: [{
        name: "local",
        // Nothing has probed the migrated Connection yet, and saying "ready"
        // before anyone asked would be a guess.
        status: "unknown",
        sourceCount: 1,
        capabilities: expect.arrayContaining(["pull", "searchConversations"]),
      }],
    });

    const sources = await app.request(`${BASE}/sources`, { headers: AUTH });
    const sourcesBody = await sources.json();
    expect(sourcesBody.total).toBe(1);
    expect(sourcesBody.sources[0]).toMatchObject({
      id: sourceId,
      workspaceId: "local",
      name: "研发消息",
      endpointName: "local",
      allowlist: [
        { chatId: "oc_allowed1", addedAt: "2026-08-25T10:00:00.000Z" },
        { chatId: "oc_direct1", addedAt: "2026-08-25T10:00:00.000Z" },
      ],
      enabled: true,
      retentionDays: 90,
      // The credential moved to the Provider's own login, so there is no longer
      // a per-Source token for a client to believe in.
      accessTokenSet: false,
      accessTokenHint: null,
    });
    // "personal_automation" named a product this no longer depends on.
    expect(sourcesBody.sources[0].type).toBe("feishu");

    const status = await app.request(`${BASE}/sources/${sourceId}/status`, { headers: AUTH });
    expect(await status.json()).toMatchObject({
      status: {
        sourceId,
        unprocessedCount: 2,
        connectionAlertedAt: null,
        connectionAlertDeliveryFailureCount: 0,
        connectionAlertDeliveryErrorCode: null,
        connectionAlertDeliveryFailedAt: null,
      },
    });

    const messages = await app.request(`${BASE}/messages?unprocessed=true`, { headers: AUTH });
    const messagesBody = await messages.json();
    expect(messagesBody.total).toBe(2);
    expect(messagesBody.messages[0]).toMatchObject({
      messageId: "om_kept",
      sourceId,
      chatId: "oc_allowed1",
      chatName: "研发群",
      chatType: "group",
      searchableText: "deploy is stuck",
      processedAt: null,
      outcomes: [],
    });
    // Old clients read a display name through `name ?? senderName ?? sender_id`.
    expect(messagesBody.messages[0].sender.name).toBe("Wang");

    // The outcome recorded before the upgrade keeps its id, so an audit trail
    // written against the old API still resolves.
    const processed = await app.request(`${BASE}/messages?processed=true`, { headers: AUTH });
    const resolved = (await processed.json()).messages[0];
    expect(resolved.messageId).toBe("om_done");
    expect(resolved.outcomes).toEqual([
      expect.objectContaining({ messageId: "om_done", outcomeKind: "ignored", reason: "casual conversation" }),
    ]);
    expect(resolved.outcomes[0].id).toBe(store.listFeishuMessageOutcomes("om_done")[0]!.id);

    const chats = await app.request(`${BASE}/chats`, { headers: AUTH });
    // The Core normalized "p2p" to "direct" on the way in; an old client is
    // still answered in the channel's own vocabulary.
    expect((await chats.json()).chats).toEqual([
      expect.objectContaining({
        sourceId,
        chatId: "oc_allowed1",
        chatName: "研发群",
        chatType: "group",
        messageCount: 2,
        inAllowlist: true,
      }),
      expect.objectContaining({ chatId: "oc_direct1", chatType: "p2p", messageCount: 1, inAllowlist: true }),
    ]);
  });

  it("checks an endpoint by asking the Provider, and lists chats it can offer", async () => {
    const { store, sourceId } = migratedStore();
    const provider = new StubProvider();
    const app = createApp(store, provider);

    const missing = await app.request(`${BASE}/endpoints/nope/check`, { method: "POST", headers: AUTH });
    expect(missing.status).toBe(404);

    const checked = await app.request(`${BASE}/endpoints/local/check`, { method: "POST", headers: AUTH });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({
      endpoint: { name: "local", status: "ready", version: "0.9.1", sourceCount: 1 },
    });

    provider.health = {
      ...provider.health,
      status: "unauthenticated",
      errorCode: "unauthenticated",
      version: null,
    };
    const failing = await app.request(`${BASE}/endpoints/local/check`, { method: "POST", headers: AUTH });
    // Legacy only ever showed ready / unreachable / unknown. The precise reason
    // survives in errorCode, so nothing an operator needs is lost.
    expect(await failing.json()).toMatchObject({
      endpoint: { status: "unreachable", errorCode: "unauthenticated" },
    });

    const chats = await app.request(`${BASE}/sources/${sourceId}/available-chats`, { headers: AUTH });
    expect(await chats.json()).toMatchObject({
      chats: [
        { chatId: "oc_allowed1", name: "研发群", type: "group", memberCount: 12, inAllowlist: true },
        { chatId: "oc_other1", type: "p2p", inAllowlist: false },
      ],
      total: 2,
    });
  });

  it("creates and edits a Source, and refuses what the legacy id space cannot express", async () => {
    const { store, sourceId } = migratedStore();
    const app = createApp(store);

    const unknownEndpoint = await app.request(`${BASE}/sources`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ endpoint_name: "not-configured", name: "X" }),
    });
    expect(unknownEndpoint.status).toBe(400);

    const created = await app.request(`${BASE}/sources`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        endpoint_name: "local",
        name: "第二个来源",
        allowlist: [{ chatId: "oc_other1", addedAt: "2026-08-26T10:00:00.000Z" }],
        // An old client may still send this. It must never come back out.
        accessToken: "t-9c1f-do-not-echo",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.source).toMatchObject({
      endpointName: "local",
      name: "第二个来源",
      allowlist: [{ chatId: "oc_other1", addedAt: "2026-08-26T10:00:00.000Z" }],
      accessTokenSet: false,
      accessTokenHint: null,
    });
    expect(JSON.stringify(createdBody)).not.toContain("t-9c1f-do-not-echo");

    const renamed = await app.request(`${BASE}/sources/${createdBody.source.id}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ name: "改名", enabled: false }),
    });
    expect(await renamed.json()).toMatchObject({ source: { name: "改名", enabled: false } });

    // Legacy could move a Source between endpoints by rewriting a column.
    // Messages are keyed by (connection, message) now, so the move would strand
    // everything already ingested under the old Connection.
    const rebound = await app.request(`${BASE}/sources/${createdBody.source.id}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ endpoint_name: "somewhere-else" }),
    });
    expect(rebound.status).toBe(400);

    // Two accounts can now hold the same channel message, because a legacy id
    // was only ever unique while one sidecar owned the channel. Picking one
    // would record the outcome against the wrong copy without saying so.
    store.messaging.upsertConnection({
      id: "mconn_second_account",
      workspaceId: "local",
      provider: "lark_cli",
      channel: "feishu",
      name: "另一个账号",
      status: "ready",
    });
    store.messaging.upsertSource({
      id: "msrc_second_account",
      workspaceId: "local",
      connectionId: "mconn_second_account",
      name: "另一个账号的来源",
      allowlist: [{ externalConversationId: "oc_other1", addedAt: "2026-08-26T10:00:00.000Z" }],
    });
    store.messaging.ingestMessages({
      connectionId: "mconn_second_account",
      sourceId: "msrc_second_account",
      messages: [{
        externalMessageId: "om_kept",
        externalConversationId: "oc_other1",
        conversationName: "Random",
        conversationKind: "direct",
        externalThreadId: null,
        externalRootId: null,
        externalParentId: null,
        sender: { externalSenderId: "ou_sender", displayName: "Wang", kind: "user", isSelf: false },
        text: "same id, other account",
        attachments: [],
        mentions: [],
        reactions: [],
        url: null,
        sentAt: "2026-08-26T10:01:00.000Z",
        editedAt: null,
        recalled: false,
        raw: {},
      }],
    });
    const ambiguous = await app.request(`${BASE}/messages/om_kept/resolve`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ outcome: "ignored", reason: "which one?" }),
    });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ code: "ambiguous_message_id" });

    const deleted = await app.request(`${BASE}/sources/${sourceId}`, { method: "DELETE", headers: AUTH });
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(await (await app.request(`${BASE}/sources/${sourceId}`, { headers: AUTH })).status).toBe(404);
  });

  it("runs a task-scoped list and a transactional resolve end to end", async () => {
    const { store, sourceId } = migratedStore();
    const app = createApp(store);
    const agent = store.createAgent({ name: "API watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "process messages" });
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

    const list = await app.request(`${BASE}/messages?unprocessed=true`, { headers });
    expect(list.status).toBe(200);
    expect((await list.json()).messages.map((entry: { messageId: string }) => entry.messageId))
      .toEqual(["om_kept", "om_dm"]);

    const resolve = await app.request(`${BASE}/messages/om_kept/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ outcome: "ignored", reason: "test noise", task_id: "tsk_spoofed" }),
    });
    expect(resolve.status).toBe(200);
    // The token names the task; a body cannot claim to be a different one.
    expect((await resolve.json()).outcome).toMatchObject({ outcomeKind: "ignored", taskId: task.id });
    const after = await app.request(`${BASE}/messages?unprocessed=true`, { headers });
    expect((await after.json()).messages.map((entry: { messageId: string }) => entry.messageId))
      .toEqual(["om_dm"]);

    // Configuration stays a person's decision, whatever the token can read.
    const forbidden = await app.request(`${BASE}/sources/${sourceId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "human_admin_required" });
  });

  it("creates real Inbox reminders and drafts, and refuses a forged outcome reference", async () => {
    const { store } = migratedStore();
    const app = createApp(store);
    const agent = store.createAgent({ name: "Inbox watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "process messages" });
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

    const notification = await app.request(`${BASE}/messages/om_kept/notify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "Deployment window changed" }),
    });
    expect(notification.status).toBe(201);
    const notificationBody = await notification.json();
    expect(notificationBody.delivered).toBe(true);
    expect(notificationBody.outcome).toMatchObject({
      messageId: "om_kept",
      outcomeKind: "notified",
      ref: `inbox:${notificationBody.inboxItem.id}`,
      taskId: task.id,
    });
    expect(notificationBody.inboxItem).toMatchObject({ body: "Deployment window changed" });

    const draft = await app.request(`${BASE}/messages/om_done/draft-reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ draft_text: "I will check and reply today." }),
    });
    expect(draft.status).toBe(201);
    expect((await draft.json()).outcome).toMatchObject({ outcomeKind: "reply_drafted" });

    // An agent cannot mint an outcome that claims a reference it never created.
    for (const body of [{ outcome: "notified", ref: "inbox:fake" }, { outcome: "issue_created", ref: "issue:MUL-404" }]) {
      const forged = await app.request(`${BASE}/messages/om_kept/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(forged.status).toBe(400);
    }

    const missing = await app.request(`${BASE}/messages/om_nonexistent/notify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "nobody" }),
    });
    expect(missing.status).toBe(404);
  });

  it("audits a muted delivery instead of dropping it", async () => {
    const { store, sourceId } = migratedStore();
    store.updateNotificationPreferences({ preferences: { feishu_messages: "muted" } });
    const app = createApp(store);
    const agent = store.createAgent({ name: "Muted watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "process muted messages" });
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

    const notification = await app.request(`${BASE}/messages/om_kept/notify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "This reminder is muted" }),
    });
    // 200 rather than 201: nothing was created, and the caller is told so
    // instead of being handed a success it can misread as delivery.
    expect(notification.status).toBe(200);
    expect(await notification.json()).toMatchObject({
      delivered: false,
      inboxItem: null,
      outcome: { outcomeKind: "dismissed", reason: "recipient_muted", ref: null },
    });

    const draft = await app.request(`${BASE}/messages/om_dm/draft-reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ draft_text: "This draft is muted" }),
    });
    expect(draft.status).toBe(200);
    expect((await draft.json()).delivered).toBe(false);

    const status = await app.request(`${BASE}/sources/${sourceId}/status`, { headers: AUTH });
    expect(await status.json()).toMatchObject({
      status: { unprocessedCount: 0, mutedDeliveryCount: 2 },
    });
  });

  it("keeps Issue creation and proposal review in human hands", async () => {
    const { store } = migratedStore();
    const app = createApp(store);
    const agent = store.createAgent({
      name: "Proposer",
      provider: "codex",
      issueCreationRequiresProposal: true,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "triage" });
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

    const direct = await app.request(`${BASE}/messages/om_kept/create-issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Bypass approval" }),
    });
    expect(direct.status).toBe(403);
    expect(await direct.json()).toMatchObject({ code: "human_approval_required" });

    const proposed = await app.request(`${BASE}/messages/om_kept/propose-issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Deploy is stuck", priority: "high" }),
    });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()).proposal;
    expect(proposal).toMatchObject({
      messageId: "om_kept",
      status: "pending",
      issue: { title: "Deploy is stuck", priority: "high" },
      message: { messageId: "om_kept", chatName: "研发群" },
    });

    const listed = await app.request(`${BASE}/proposals?status=pending`, { headers: AUTH });
    expect(await listed.json()).toMatchObject({ total: 1, proposals: [{ id: proposal.id }] });

    const taskApproval = await app.request(`${BASE}/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers,
    });
    expect(taskApproval.status).toBe(403);

    const approved = await app.request(`${BASE}/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: AUTH,
    });
    expect(approved.status).toBe(201);
    const approvedBody = await approved.json();
    expect(approvedBody).toMatchObject({
      created: true,
      proposal: { status: "approved" },
      outcome: { outcomeKind: "issue_created", ref: `issue:${approvedBody.issue.id}` },
      issue: { title: "Deploy is stuck" },
    });

    // Replaying the same creation must not produce a second Issue.
    const replay = await app.request(`${BASE}/messages/om_kept/create-issue`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ title: "This retry must not create a duplicate" }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).issue.id).toBe(approvedBody.issue.id);
    expect(store.listIssues({ workspaceId: "local" })).toHaveLength(1);

    const rejected = await app.request(`${BASE}/messages/om_done/propose-issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Not worth doing" }),
    });
    const rejectedProposal = (await rejected.json()).proposal;
    const rejection = await app.request(`${BASE}/proposals/${rejectedProposal.id}/reject`, {
      method: "POST",
      headers: AUTH,
    });
    expect(rejection.status).toBe(200);
    expect((await rejection.json()).proposal).toMatchObject({ status: "rejected", resolvedBy: expect.any(String) });
  });

  it("reads the legacy query parameters a shipped client still sends", async () => {
    const { store, sourceId } = migratedStore();
    const app = createApp(store);
    const search = async (query: string): Promise<{ messages: Array<{ messageId: string }>; total: number }> => {
      const response = await app.request(`${BASE}/messages?${query}`, { headers: AUTH });
      expect([query, response.status]).toEqual([query, 200]);
      return await response.json();
    };
    const ids = (body: { messages: Array<{ messageId: string }> }) => body.messages.map((m) => m.messageId);

    // Old builds are inconsistent about these names, so both spellings answer.
    expect(ids(await search("chat_id=oc_allowed1"))).toEqual(["om_done", "om_kept"]);
    expect(ids(await search("chat=oc_direct1"))).toEqual(["om_dm"]);
    expect((await search(`source_id=${sourceId}`)).total).toBe(3);
    // `%` is text somebody typed, not a match-everything.
    expect((await search("q=%25")).total).toBe(0);
    expect(ids(await search("q=deploy"))).toEqual(["om_kept"]);
    expect((await search("since=2026-08-25T10:01:00.000Z")).total).toBe(2);

    const first = await search("limit=2&offset=0");
    const second = await search("limit=2&offset=2");
    expect(first).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });
    expect(second).toMatchObject({ total: 3, limit: 2, offset: 2, hasMore: false });
    // Newest first and no message shown twice across the page boundary.
    expect([...ids(first), ...ids(second)]).toEqual(["om_done", "om_kept", "om_dm"]);

    const conflict = await app.request(`${BASE}/messages?processed=true&unprocessed=true`, { headers: AUTH });
    expect(conflict.status).toBe(400);
  });

  it("reports nothing configured, and keeps configuration out of a task token's reach", async () => {
    const empty = createStore();
    empty.ensureLocalWorkspace();
    const none = await createApp(empty).request(`${BASE}/endpoints`, { headers: AUTH });
    // Legacy read its endpoint list from an environment variable and could show
    // a name with nothing behind it. An endpoint is a Connection now, so with
    // no Connections there is nothing left to invent.
    expect(await none.json()).toEqual({ configured: false, endpoints: [] });

    const { store, sourceId } = migratedStore();
    const app = createApp(store);
    const agent = store.createAgent({ name: "Feishu worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "process messages" });
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };

    // Reading messages is an agent's job; deciding what the workspace connects
    // to is not, and that line did not move with the refactor.
    const routes: Array<[string, string]> = [
      ["GET", `${BASE}/endpoints`],
      ["POST", `${BASE}/endpoints/local/check`],
      ["GET", `${BASE}/sources/${sourceId}/available-chats?q=team`],
      ["DELETE", `${BASE}/sources/${sourceId}`],
    ];
    for (const [method, path] of routes) {
      const response = await app.request(path, { method, headers });
      expect([method, path, response.status]).toEqual([method, path, 403]);
      expect(await response.json()).toMatchObject({ code: "human_admin_required" });
    }

    const created = await app.request(`${BASE}/sources`, {
      method: "POST",
      headers,
      body: JSON.stringify({ endpoint_name: "local", name: "X" }),
    });
    expect(created.status).toBe(403);
  });

  it("surfaces a Provider failure as a recoverable status without saying how it failed", async () => {
    const { store, sourceId } = migratedStore();
    const provider = new StubProvider();
    const app = createApp(store, provider);
    const path = `${BASE}/sources/${sourceId}/available-chats?q=team`;

    // The states the issue asks lark-cli to report clearly. Each maps to a
    // status the caller can act on: log in again, back off, retry, or wait for
    // the tool to come back.
    const cases: Array<[MessageErrorCode, number]> = [
      ["unauthenticated", 403],
      ["rate_limited", 429],
      ["timeout", 504],
      ["provider_unavailable", 503],
    ];
    for (const [code, status] of cases) {
      provider.failure = new MessageProviderError(code, "lark-cli --session /home/app/.lark/session.json failed");
      const response = await app.request(path, { headers: AUTH });
      const text = await response.text();
      expect([code, response.status]).toEqual([code, status]);
      expect(JSON.parse(text)).toEqual({ error: "Messaging provider request failed", code });
      // A Provider message can carry a command line or a credential path. Only
      // the code crosses the API boundary.
      expect(text).not.toContain("/home/app/.lark");
    }

    // 400, not the Provider's 502: a bad page size is refused before lark-cli
    // is run at all.
    provider.failure = new MessageProviderError("unreachable", "must never be reached");
    const badLimit = await app.request(`${path}&limit=nope`, { headers: AUTH });
    expect(badLimit.status).toBe(400);
  });

  it("deletes a Source with its messages, outcomes and sync cursor in one transaction", async () => {
    const { store, sourceId } = migratedStore();
    const app = createApp(store);
    store.messaging.claimSyncStream({
      sourceId,
      stream: "messages",
      owner: "test",
      leaseMs: 60_000,
      now: "2026-08-31T09:00:00.000Z",
    });
    // A second account holds its own rows, so a delete that reached too far
    // would show up here rather than passing as a clean cascade.
    store.messaging.upsertConnection({
      id: "mconn_keep",
      workspaceId: "local",
      provider: "lark_cli",
      channel: "feishu",
      name: "保留的账号",
      status: "ready",
    });
    store.messaging.upsertSource({
      id: "msrc_keep",
      workspaceId: "local",
      connectionId: "mconn_keep",
      name: "保留的来源",
      allowlist: [{ externalConversationId: "oc_keep1", addedAt: "2026-08-26T10:00:00.000Z" }],
    });
    store.messaging.ingestMessages({
      connectionId: "mconn_keep",
      sourceId: "msrc_keep",
      messages: [{
        externalMessageId: "om_keep",
        externalConversationId: "oc_keep1",
        conversationName: "Keep",
        conversationKind: "group",
        externalThreadId: null,
        externalRootId: null,
        externalParentId: null,
        sender: { externalSenderId: "ou_sender", displayName: "Wang", kind: "user", isSelf: false },
        text: "still here",
        attachments: [],
        mentions: [],
        reactions: [],
        url: null,
        sentAt: "2026-08-26T10:01:00.000Z",
        editedAt: null,
        recalled: false,
        raw: {},
      }],
    });

    const deleted = await app.request(`${BASE}/sources/${sourceId}`, { method: "DELETE", headers: AUTH });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });

    expect(store.messaging.getSource(sourceId)).toBeNull();
    // The cursor has to go with the Source: a re-added Source that inherited an
    // old watermark would silently skip everything since.
    expect(store.messaging.getSyncCursor(sourceId, "messages")).toBeNull();
    expect(rowCount("multiremi_message_messages")).toBe(1);
    expect(rowCount("multiremi_message_outcomes")).toBe(0);
    expect(store.messaging.getMessage("mconn_keep", "om_keep")).not.toBeNull();

    const repeated = await app.request(`${BASE}/sources/${sourceId}`, { method: "DELETE", headers: AUTH });
    expect(repeated.status).toBe(404);
  });
});

function rowCount(table: string): number {
  return (db!.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
