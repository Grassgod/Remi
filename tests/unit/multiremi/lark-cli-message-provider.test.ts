import { describe, expect, test } from "bun:test";
import {
  MessageProviderError,
  type MessageConnection,
  type MessageProviderContext,
  type MessageSource,
} from "@multiremi/contracts/messaging.js";
import {
  BunLarkCliRunner,
  LarkCliMessageProvider,
  mapLarkCliErrorCode,
  type LarkCliRunOptions,
  type LarkCliRunner,
} from "@multiremi/messaging/providers/lark-cli/index.js";

interface RunnerCall {
  argv: readonly string[];
  options: LarkCliRunOptions | undefined;
}

class FakeRunner implements LarkCliRunner {
  readonly calls: RunnerCall[] = [];

  constructor(private readonly results: unknown[]) {}

  async run(argv: readonly string[], options?: LarkCliRunOptions): Promise<unknown> {
    this.calls.push({ argv, options });
    if (this.results.length === 0) throw new Error("Unexpected lark-cli call");
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result;
  }
}

describe("LarkCliMessageProvider", () => {
  test("declares the implemented channel capabilities", () => {
    const provider = new LarkCliMessageProvider({ runner: new FakeRunner([]) });
    expect(provider.manifest).toMatchObject({
      provider: "lark_cli",
      channels: ["feishu"],
      authMethods: ["external_tool"],
      capabilities: {
        pull: true,
        push: false,
        searchConversations: true,
        readConversations: true,
        send: true,
        reply: true,
        attachmentDownload: true,
        attachmentUpload: false,
      },
    });
  });

  test("reads the version as text and returns only redacted auth health", async () => {
    // Both argv shapes below are the ones real lark-cli accepts: it rejects
    // `--format` on `--version` and on `auth status`, so neither may carry it.
    const runner = new FakeRunner([
      "lark-cli version 1.0.90",
      {
        appId: "cli_app",
        identities: {
          user: {
            status: "ready",
            openId: "ou_account",
            userName: "Operator",
            tokenStatus: "valid",
            expiresAt: "2026-09-01T00:18:21+08:00",
            accessToken: "must-not-leak",
            scope: "im:message search:message",
          },
        },
        identity: "user",
      },
    ]);
    const provider = providerWith(runner);

    const health = await provider.checkHealth(context());

    expect(health).toEqual({
      status: "ready",
      version: "1.0.90",
      externalAccountId: "ou_account",
      externalAccountName: "Operator",
      errorCode: null,
      detail: null,
      checkedAt: "2026-08-31T00:00:00.000Z",
    });
    expect(JSON.stringify(health)).not.toContain("must-not-leak");
    expect(JSON.stringify(health)).not.toContain("im:message");
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["--version"],
      ["auth", "status", "--json", "--verify"],
    ]);
    expect(runner.calls[0]?.options?.text).toBe(true);
  });

  test("reports an out-of-date lark-cli as incompatible", async () => {
    const oldProvider = providerWith(new FakeRunner(["lark-cli version 1.0.89"]));
    expect(await oldProvider.checkHealth(context())).toMatchObject({
      status: "incompatible",
      version: "1.0.89",
      errorCode: "provider_incompatible",
    });
  });

  test("rejects version output that is not the exact lark-cli version line", async () => {
    const noisy = providerWith(new FakeRunner(["checking for updates... 1.0.90 available"]));
    expect(await noisy.checkHealth(context())).toMatchObject({
      status: "unknown",
      version: null,
      errorCode: "malformed_response",
    });
  });

  test("separates a missing CLI, a signed-out identity, and an expired token", async () => {
    const unavailable = providerWith(new FakeRunner([
      new MessageProviderError("provider_unavailable", "secret command output"),
    ]));
    expect(await unavailable.checkHealth(context())).toMatchObject({
      status: "unavailable",
      errorCode: "provider_unavailable",
      detail: "lark-cli is not installed",
    });

    const signedOut = providerWith(new FakeRunner([
      "lark-cli version 1.2.0",
      { identities: { user: { status: "unauthorized", available: false } } },
    ]));
    expect(await signedOut.checkHealth(context())).toMatchObject({
      status: "unauthenticated",
      errorCode: "unauthenticated",
      detail: "lark-cli user identity needs authentication",
    });

    // A token that is still flagged `ready` but whose expiry has passed is the
    // routine case operators hit, and it must read as expired rather than as a
    // generic sign-in prompt.
    const expired = providerWith(new FakeRunner([
      "lark-cli version 1.2.0",
      {
        identities: {
          user: { status: "ready", tokenStatus: "valid", expiresAt: "2026-08-30T00:00:00+00:00", token: "secret" },
        },
      },
    ]));
    const health = await expired.checkHealth(context());
    expect(health).toMatchObject({
      status: "unauthenticated",
      errorCode: "unauthenticated",
      detail: "lark-cli authorization has expired; sign in again",
    });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  test("provisions an isolated profile through stdin and completes device authorization", async () => {
    const runner = new FakeRunner([
      "Profile added",
      {
        device_code: "device-secret",
        verification_url: "https://open.feishu.cn/device?code=opaque",
        user_code: "ABCD-EFGH",
        expires_in: 600,
      },
      { ok: true },
    ]);
    const provider = providerWith(runner);
    const base = context({}, null);

    const provisioned = await provider.provisionConnection(base, {
      appId: "cli_app",
      appSecret: "app-secret",
    });
    expect(provisioned).toEqual({
      config: { profile: "multiremi_connection-1", managedProfile: true },
    });
    expect(runner.calls[0]?.argv).toEqual([
      "profile", "add", "--name", "multiremi_connection-1",
      "--app-id", "cli_app", "--app-secret-stdin", "--brand", "feishu",
    ]);
    expect(runner.calls[0]?.options?.stdin).toBe("app-secret\n");
    expect(runner.calls[0]?.argv).not.toContain("app-secret");

    const configured = context(provisioned.config, null);
    const pending = await provider.beginAuthorization(configured);
    expect(pending).toMatchObject({
      status: "pending",
      verificationUrl: "https://open.feishu.cn/device?code=opaque",
      userCode: "ABCD-EFGH",
      errorCode: null,
    });
    expect(JSON.stringify(pending)).not.toContain("device-secret");

    const completed = await provider.getAuthorizationSession(configured, pending.id);
    expect(completed).toMatchObject({
      status: "ready",
      verificationUrl: null,
      userCode: null,
    });
    expect(runner.calls.slice(1).map((call) => call.argv)).toEqual([
      [
        "--profile", "multiremi_connection-1", "auth", "login",
        "--domain", "im", "--no-wait", "--json",
      ],
      [
        "--profile", "multiremi_connection-1", "auth", "login",
        "--device-code", "device-secret", "--json",
      ],
    ]);
  });

  test("rejects a non-HTTPS authorization URL", async () => {
    const provider = providerWith(new FakeRunner([{
      device_code: "device-secret",
      verification_url: "javascript:alert(1)",
      expires_in: 600,
    }]));

    await expect(provider.beginAuthorization(context({ profile: "multiremi_profile" })))
      .rejects.toMatchObject({ code: "malformed_response" });
  });

  test("binds every connection operation to its configured profile", async () => {
    const runner = new FakeRunner([
      "lark-cli version 1.0.90",
      { identities: { user: { status: "ready", tokenStatus: "valid", openId: "ou_1" } } },
    ]);
    const provider = providerWith(runner);

    await provider.checkHealth(context({ profile: "multiremi_profile" }));

    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["--version"],
      ["--profile", "multiremi_profile", "auth", "status", "--json", "--verify"],
    ]);
  });

  test("normalizes conversation search and preserves page cursors", async () => {
    const runner = new FakeRunner([{
      data: {
        items: [
          { chat_id: "oc_group", name: "Project", chat_type: "group", member_count: 8 },
          { chat_id: "oc_direct", name: "Alex", chat_type: "p2p", member_count: 2 },
        ],
        has_more: true,
        page_token: "next-page",
      },
    }]);
    const provider = providerWith(runner);

    const result = await provider.searchConversations(context(), {
      query: "roadmap; $(ignored)",
      kinds: ["group"],
      limit: 25,
      cursor: "previous-page",
    });

    expect(result).toEqual({
      conversations: [{
        externalConversationId: "oc_group",
        name: "Project",
        kind: "group",
        url: null,
        memberCount: 8,
        metadata: { chat_id: "oc_group", name: "Project", chat_type: "group", member_count: 8 },
      }],
      cursor: "next-page",
      done: false,
    });
    expect(runner.calls[0]?.argv).toEqual([
      "im",
      "+chat-search",
      "--query",
      "roadmap; $(ignored)",
      "--page-size",
      "25",
      "--page-token",
      "previous-page",
      "--format",
      "json",
    ]);
  });

  test("derives a conversation from the structured message-list result", async () => {
    const runner = new FakeRunner([{
      data: {
        items: [{ chat_id: "oc_chat", chat_name: "Chat", chat_type: "group" }],
      },
    }]);
    const provider = providerWith(runner);

    expect(await provider.getConversation(context(), "oc_chat")).toMatchObject({
      externalConversationId: "oc_chat",
      name: "Chat",
      kind: "group",
    });
    expect(runner.calls[0]?.argv).toEqual([
      "im",
      "+chat-messages-list",
      "--chat-id",
      "oc_chat",
      "--format",
      "json",
    ]);
  });

  test("rejects incomplete structured result and pagination shapes", async () => {
    const missingItems = providerWith(new FakeRunner([{ data: {} }]));
    await expect(missingItems.searchConversations(context(), {})).rejects.toMatchObject({
      code: "malformed_response",
    });

    const missingToken = providerWith(new FakeRunner([{ data: { items: [], has_more: true } }]));
    await expect(missingToken.searchConversations(context(), {})).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  test("normalizes messages, carries the page token, and skips the full activation minute", async () => {
    const runner = new FakeRunner([{
      data: {
        items: [
          messagePayload("om_before", "2026-08-31T09:17:01+08:00"),
          messagePayload("om_same_minute", "2026-08-31T09:18:59+08:00"),
          messagePayload("om_after", "2026-08-31T09:19:00+08:00"),
        ],
        has_more: true,
        page_token: "page-2",
      },
    }]);
    const provider = providerWith(runner);

    const page = await provider.syncMessages(context({ pageSize: 50 }, "ou_sender"), {
      source: source([{
        externalConversationId: "oc_chat",
        addedAt: "2026-08-31T09:18:30+08:00",
      }]),
      cursor: { pageToken: "page-1" },
      start: new Date("2026-08-31T00:00:00Z"),
      end: new Date("2026-08-31T02:00:00Z"),
    });

    expect(page.done).toBe(false);
    expect(page.cursor).toEqual({ pageToken: "page-2" });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      externalMessageId: "om_after",
      externalConversationId: "oc_chat",
      conversationName: "Project",
      conversationKind: "group",
      externalThreadId: "omt_thread",
      externalRootId: "om_root",
      externalParentId: "om_parent",
      sender: {
        externalSenderId: "ou_sender",
        displayName: "Sender",
        kind: "user",
        isSelf: true,
      },
      text: "hello",
      attachments: [{
        externalAttachmentId: "file-key",
        kind: "file",
        name: "report.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      }],
      mentions: [{
        externalUserId: "ou_mentioned",
        displayName: "Mentioned",
        isEveryone: false,
      }],
      reactions: [{ key: "THUMBSUP", count: 2, reactedBySelf: true }],
      recalled: false,
    });
    expect(page.messages[0]?.raw).toEqual(messagePayload("om_after", "2026-08-31T09:19:00+08:00"));
    expect(runner.calls[0]?.argv).toEqual([
      "im",
      "+messages-search",
      "--chat-id",
      "oc_chat",
      "--start",
      "2026-08-31T00:00:00Z",
      "--end",
      "2026-08-31T02:00:00Z",
      "--page-token",
      "page-1",
      "--page-size",
      "50",
      "--format",
      "json",
    ]);
  });

  test("reads body JSON and normalizes millisecond timestamps", async () => {
    const runner = new FakeRunner([{
      data: {
        messages: [{
          message_id: "om_body",
          chat_id: "oc_chat",
          chat_type: "p2p",
          msg_type: "text",
          create_time: "1788141600000",
          body: { content: JSON.stringify({ text: "body text" }) },
          sender: { id: "ou_sender", sender_type: "bot", is_self: true },
        }],
      },
    }]);
    const provider = providerWith(runner);

    const page = await provider.syncMessages(context(), {
      source: source([{ externalConversationId: "oc_chat", addedAt: "2026-08-31T00:00:00Z" }]),
      cursor: null,
      start: new Date("2026-08-31T00:00:00Z"),
      end: new Date("2026-09-01T00:00:00Z"),
    });

    expect(page).toMatchObject({ done: true, cursor: null });
    expect(page.messages[0]).toMatchObject({
      externalMessageId: "om_body",
      text: "body text",
      conversationKind: "direct",
      sender: { kind: "bot", isSelf: true },
    });
  });

  test("retries only retryable reads and carries structured retry options", async () => {
    const runner = new FakeRunner([
      new MessageProviderError("rate_limited", "slow down", { retryAfterMs: 7 }),
      { data: { items: [] } },
    ]);
    const sleeps: number[] = [];
    const provider = providerWith(runner, { sleep: async (milliseconds) => { sleeps.push(milliseconds); } });

    expect(await provider.searchConversations(context(), {})).toEqual({
      conversations: [],
      cursor: null,
      done: true,
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.options).toMatchObject({ timeoutMs: 5_000, kind: "read" });
    expect(sleeps).toEqual([7]);

    const authRunner = new FakeRunner([new MessageProviderError("unauthenticated")]);
    await expect(providerWith(authRunner).searchConversations(context(), {})).rejects.toMatchObject({
      code: "unauthenticated",
      retryable: false,
    });
    expect(authRunner.calls).toHaveLength(1);
  });

  test("aborts while waiting for a read retry backoff", async () => {
    const runner = new FakeRunner([
      new MessageProviderError("rate_limited", "slow down", { retryAfterMs: 60_000 }),
    ]);
    const controller = new AbortController();
    const provider = providerWith(runner, {
      sleep: async () => await new Promise<void>(() => undefined),
    });
    const pending = provider.searchConversations({ ...context(), signal: controller.signal }, {});
    queueMicrotask(() => controller.abort());

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(runner.calls).toHaveLength(1);
  });

  test("prepares sends and invokes send/reply once with argv arrays", async () => {
    const runner = new FakeRunner([
      { data: { message_id: "om_sent", chat_id: "oc_chat", create_time: "2026-08-31T01:00:00Z" } },
      { data: { message_id: "om_reply", chat_id: "oc_chat", create_time: "2026-08-31T01:01:00Z" } },
    ]);
    const provider = providerWith(runner);
    const prepared = await provider.prepareSend(context(), {
      externalConversationId: "oc_chat",
      text: "hello; $(not-a-shell)",
      replyToExternalMessageId: "om_parent",
      inThread: true,
    });

    expect(prepared).toEqual({
      draft: {
        externalConversationId: "oc_chat",
        text: "hello; $(not-a-shell)",
        replyToExternalMessageId: "om_parent",
        inThread: true,
      },
      idempotencyKey: "idempotency-key",
      warnings: [],
    });
    expect(await provider.send(context(), prepared)).toMatchObject({ externalMessageId: "om_sent" });
    expect(await provider.reply(context(), prepared)).toMatchObject({ externalMessageId: "om_reply" });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.argv).toEqual([
      "im", "+messages-send",
      "--receive-id", "oc_chat",
      "--receive-id-type", "chat_id",
      "--msg-type", "text",
      "--content", JSON.stringify({ text: "hello; $(not-a-shell)" }),
      "--uuid", "idempotency-key",
      "--format", "json",
    ]);
    expect(runner.calls[1]?.argv).toEqual([
      "im", "+messages-reply",
      "--message-id", "om_parent",
      "--msg-type", "text",
      "--content", JSON.stringify({ text: "hello; $(not-a-shell)" }),
      "--uuid", "idempotency-key",
      "--reply-in-thread", "true",
      "--format", "json",
    ]);
    expect(runner.calls.every((call) => call.options?.kind === "send")).toBe(true);
  });

  test("never retries an indeterminate send and rejects a missing receipt id", async () => {
    const unknownRunner = new FakeRunner([new MessageProviderError("timeout")]);
    const provider = providerWith(unknownRunner);
    const prepared = await provider.prepareSend(context(), {
      externalConversationId: "oc_chat",
      text: "hello",
    });
    await expect(provider.send(context(), prepared)).rejects.toMatchObject({
      code: "send_result_unknown",
      retryable: false,
    });
    expect(unknownRunner.calls).toHaveLength(1);

    const unreachableRunner = new FakeRunner([new MessageProviderError("unreachable")]);
    const unreachableProvider = providerWith(unreachableRunner);
    const unreachablePrepared = await unreachableProvider.prepareSend(context(), {
      externalConversationId: "oc_chat",
      text: "hello",
    });
    await expect(unreachableProvider.send(context(), unreachablePrepared)).rejects.toMatchObject({
      code: "send_result_unknown",
      retryable: false,
    });
    expect(unreachableRunner.calls).toHaveLength(1);

    const malformedProvider = providerWith(new FakeRunner([{ data: { ok: true } }]));
    const malformedPrepared = await malformedProvider.prepareSend(context(), {
      externalConversationId: "oc_chat",
      text: "hello",
    });
    await expect(malformedProvider.send(context(), malformedPrepared)).rejects.toMatchObject({
      code: "send_result_unknown",
      retryable: false,
    });
  });

  test("downloads structured base64 attachments and rejects upload", async () => {
    const runner = new FakeRunner([{
      data: {
        content_base64: Buffer.from("attachment").toString("base64"),
        file_name: "note.txt",
        mime_type: "text/plain",
      },
    }]);
    const provider = providerWith(runner);

    const download = await provider.downloadAttachment(context(), {
      externalMessageId: "om_message",
      externalAttachmentId: "file-key",
    });
    expect(new TextDecoder().decode(download.bytes)).toBe("attachment");
    expect(download).toMatchObject({
      externalAttachmentId: "file-key",
      name: "note.txt",
      mimeType: "text/plain",
    });
    expect(runner.calls[0]?.argv).toEqual([
      "im", "+messages-resources-download",
      "--message-id", "om_message",
      "--file-key", "file-key",
      "--format", "json",
    ]);
    await expect(provider.uploadAttachment(context(), {
      name: "upload.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array(),
    })).rejects.toMatchObject({ code: "capability_unsupported" });
  });
});

/**
 * Shapes and limits taken from a live lark-cli 1.0.90, not from the Feishu Open
 * API the Provider was first written against. Each case below passed the
 * fixtures above while producing nothing — or failing outright — in production;
 * the live-CLI suite in tests/integration is what found them, and these pin them
 * on a checkout with no Feishu credentials.
 */
describe("LarkCliMessageProvider against real lark-cli shapes", () => {
  test("clamps page sizes to what each subcommand accepts", async () => {
    // `im +messages-search` caps at 50 and rejects anything larger outright, so
    // an over-large value did not read fewer rows, it failed the whole poll.
    const syncRunner = new FakeRunner([{ data: { messages: [], has_more: false } }]);
    await providerWith(syncRunner).syncMessages(context({ pageSize: 200 }), {
      source: source([{ externalConversationId: "oc_chat", addedAt: "2026-08-31T00:00:00Z" }]),
      cursor: null,
      start: new Date("2026-08-31T00:00:00Z"),
      end: new Date("2026-08-31T02:00:00Z"),
    });
    expect(argValue(syncRunner.calls[0]?.argv, "--page-size")).toBe("50");

    // `im +chat-search` caps at 100 instead, so the two are clamped separately.
    const searchRunner = new FakeRunner([{ data: { chats: [], has_more: false } }]);
    await providerWith(searchRunner).searchConversations(context(), { query: "team", limit: 200 });
    expect(argValue(searchRunner.calls[0]?.argv, "--page-size")).toBe("100");
  });

  test("asks for a window lark-cli will accept", async () => {
    const runner = new FakeRunner([{ data: { messages: [], has_more: false } }]);
    await providerWith(runner).syncMessages(context(), {
      source: source([{ externalConversationId: "oc_chat", addedAt: "2026-08-31T00:00:00Z" }]),
      cursor: null,
      // Windows come from the clock, so a fractional second is the normal case,
      // and Feishu rejects the whole request when it sees milliseconds.
      start: new Date("2026-08-31T00:00:00.123Z"),
      end: new Date("2026-08-31T02:00:00.456Z"),
    });
    expect(argValue(runner.calls[0]?.argv, "--start")).toBe("2026-08-31T00:00:00Z");
    expect(argValue(runner.calls[0]?.argv, "--end")).toBe("2026-08-31T02:00:00Z");
  });

  test("browses by member id when the operator gave no keyword", async () => {
    // lark-cli refuses a search naming neither a keyword nor a member, and the
    // API sends no query at all when the operator just opens the picker.
    const runner = new FakeRunner([{ data: { chats: [], has_more: false } }]);
    await providerWith(runner).searchConversations(context(), {});

    expect(runner.calls[0]?.argv).not.toContain("--query");
    expect(argValue(runner.calls[0]?.argv, "--member-ids")).toBe("ou_account");
  });

  test("resolves the chat kind lark-cli reports on a search hit", async () => {
    // `im +chat-search` returns only group chats and separates plain from topic
    // ones as `chat_mode`, not the `chat_type` that messages carry.
    const runner = new FakeRunner([{
      data: {
        chats: [
          { chat_id: "oc_plain", name: "Project", chat_mode: "DEFAULT" },
          { chat_id: "oc_topic", name: "Topics", chat_mode: "THREAD" },
        ],
        has_more: false,
      },
    }]);

    const result = await providerWith(runner).searchConversations(context(), { query: "p" });
    expect(result.conversations.map((entry) => entry.kind)).toEqual(["group", "thread"]);
  });

  test("normalizes a message in the form lark-cli actually emits", async () => {
    const runner = new FakeRunner([{
      data: {
        messages: [{
          message_id: "om_real",
          chat_id: "oc_chat",
          chat_name: "Project",
          chat_type: "group",
          // Already rendered to a string, and stamped with no zone at all.
          content: "shipped the fix",
          create_time: "2026-08-31 09:19",
          update_time: "2026-08-31 09:19",
          msg_type: "text",
          deleted: false,
          reply_to: "om_parent",
          sender: { id: "ou_sender", id_type: "open_id", name: "Sender", sender_type: "user" },
          mentions: [{ id: "ou_mentioned", key: "@_user_1", name: "Mentioned" }],
          reactions: {
            counts: [{ count: "2", reaction_type: "Get" }],
            details: [{ operator: { operator_id: "cli_app", operator_type: "app" } }],
          },
        }],
        has_more: false,
      },
    }]);

    const page = await providerWith(runner).syncMessages(context(), {
      source: source([{ externalConversationId: "oc_chat", addedAt: "2026-08-31T00:00:00Z" }]),
      cursor: null,
      start: new Date("2026-08-31T00:00:00Z"),
      end: new Date("2026-08-31T23:00:00Z"),
    });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      externalMessageId: "om_real",
      externalConversationId: "oc_chat",
      conversationKind: "group",
      // The rendered string is the text. Read as JSON, as the raw Feishu shape
      // would be, it parses as nothing and every message normalized to "".
      text: "shipped the fix",
      // lark-cli is pinned to UTC by BunLarkCliRunner precisely so this zoneless
      // stamp means one instant regardless of where the server runs.
      sentAt: "2026-08-31T09:19:00.000Z",
      externalParentId: "om_parent",
      sender: { externalSenderId: "ou_sender", kind: "user", isSelf: false },
      reactions: [{ key: "Get", count: 2, reactedBySelf: false }],
    });
    // Same minute as create_time, so it is not a real edit.
    expect(page.messages[0]?.editedAt).toBeNull();
  });

  test("keeps a refreshable token healthy and a dead one not", async () => {
    // lark-cli marks an aged-out access token `needs_refresh` and mints a new one
    // on the next call, so user API calls keep working. Calling that expired
    // reported a working connection as signed out every time a token aged out.
    const refreshable = providerWith(new FakeRunner([
      "lark-cli version 1.0.90",
      {
        identities: {
          user: {
            status: "needs_refresh",
            tokenStatus: "needs_refresh",
            available: true,
            openId: "ou_account",
            userName: "Operator",
            expiresAt: "2026-08-30T00:00:00Z",
            refreshExpiresAt: "2026-09-07T00:00:00Z",
          },
        },
      },
    ]));
    expect(await refreshable.checkHealth(context())).toMatchObject({
      status: "ready",
      errorCode: null,
      externalAccountId: "ou_account",
    });

    // Once the refresh token itself is gone, only a human can fix it.
    const dead = providerWith(new FakeRunner([
      "lark-cli version 1.0.90",
      {
        identities: {
          user: {
            status: "needs_refresh",
            tokenStatus: "needs_refresh",
            available: true,
            expiresAt: "2026-08-30T00:00:00Z",
            refreshExpiresAt: "2026-08-30T12:00:00Z",
          },
        },
      },
    ]));
    expect(await dead.checkHealth(context())).toMatchObject({
      status: "unauthenticated",
      errorCode: "unauthenticated",
      detail: "lark-cli authorization has expired; sign in again",
    });
  });
});

/** Value lark-cli would receive for `flag`, or null when it was not passed. */
function argValue(argv: readonly string[] | undefined, flag: string): string | null {
  const index = argv?.indexOf(flag) ?? -1;
  return index >= 0 ? argv?.[index + 1] ?? null : null;
}

describe("BunLarkCliRunner", () => {
  test("executes argv directly and parses JSON only", async () => {
    const runner = new BunLarkCliRunner({ executable: process.execPath, timeoutMs: 2_000 });
    expect(await runner.run(["-e", "console.log(JSON.stringify({ok:true,value:7}))"])).toEqual({
      ok: true,
      value: 7,
    });
    await expect(runner.run(["-e", "console.log('human output')"])).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  test("maps structured process errors without exposing their payload", async () => {
    const runner = new BunLarkCliRunner({ executable: process.execPath, timeoutMs: 2_000 });
    let error: unknown;
    try {
      await runner.run([
        "-e",
        "console.error(JSON.stringify({ok:false,error:{code:'token_expired',access_token:'secret'}}));process.exit(1)",
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "unauthenticated", retryable: false });
    expect(String(error)).not.toContain("secret");
  });

  test("writes sensitive input through stdin instead of argv", async () => {
    const runner = new BunLarkCliRunner({ executable: process.execPath, timeoutMs: 2_000 });
    const result = await runner.run([
      "-e",
      "let value='';for await(const chunk of Bun.stdin.stream())value+=new TextDecoder().decode(chunk);console.log(JSON.stringify({length:value.length}))",
    ], { stdin: "top-secret\n" });
    expect(result).toEqual({ length: 11 });
  });

  test("kills timed out processes and reports timeout", async () => {
    const runner = new BunLarkCliRunner({ executable: process.execPath, timeoutMs: 10 });
    await expect(runner.run(["-e", "await Bun.sleep(1000); console.log('{}')"])).rejects.toMatchObject({
      code: "timeout",
    });
  });

  test("maps structured CLI errors into the contract closed set", () => {
    expect(mapLarkCliErrorCode("token_expired")).toBe("unauthenticated");
    expect(mapLarkCliErrorCode("too_many_requests")).toBe("rate_limited");
    expect(mapLarkCliErrorCode("unknown_command")).toBe("capability_unsupported");
    expect(mapLarkCliErrorCode("anything-new", "send")).toBe("send_result_unknown");
  });
});

function providerWith(
  runner: LarkCliRunner,
  overrides: Partial<ConstructorParameters<typeof LarkCliMessageProvider>[0]> = {},
): LarkCliMessageProvider {
  return new LarkCliMessageProvider({
    runner,
    timeoutMs: 5_000,
    maxReadAttempts: 3,
    retryBaseDelayMs: 0,
    now: () => new Date("2026-08-31T00:00:00Z"),
    createIdempotencyKey: () => "idempotency-key",
    sleep: async () => undefined,
    ...overrides,
  });
}

function context(config: Record<string, unknown> = {}, externalAccountId: string | null = "ou_account"): MessageProviderContext {
  const connection: MessageConnection = {
    id: "connection-1",
    workspaceId: "workspace-1",
    provider: "lark_cli",
    channel: "feishu",
    name: "Account",
    externalAccountId,
    externalAccountName: null,
    status: "ready",
    config,
    lastCheckedAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z",
  };
  return { connection };
}

function source(allowlist: MessageSource["allowlist"]): MessageSource {
  return {
    id: "source-1",
    workspaceId: "workspace-1",
    connectionId: "connection-1",
    name: "Source",
    allowlist,
    enabled: true,
    retentionDays: 30,
    pollIntervalSeconds: 60,
    unprocessedRetrySeconds: 60,
    unprocessedRetryLimit: 3,
    lastSuccessfulIngestAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z",
  };
}

function messagePayload(messageId: string, createTime: string): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: "oc_chat",
    chat_name: "Project",
    chat_type: "group",
    thread_id: "omt_thread",
    root_id: "om_root",
    parent_id: "om_parent",
    create_time: createTime,
    update_time: "2026-08-31T09:20:00+08:00",
    text: "hello",
    message_app_link: "https://example.invalid/message",
    sender: { sender_id: "ou_sender", name: "Sender", sender_type: "user" },
    attachments: [{
      file_key: "file-key",
      type: "file",
      file_name: "report.txt",
      mime_type: "text/plain",
      size: 12,
    }],
    mentions: [{ id: "ou_mentioned", name: "Mentioned" }],
    reactions: [{ emoji_type: "THUMBSUP", count: 2, reacted_by_self: true }],
  };
}
