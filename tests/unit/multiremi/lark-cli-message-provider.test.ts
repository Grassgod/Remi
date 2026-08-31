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

  test("checks the structured version and returns only redacted auth health", async () => {
    const runner = new FakeRunner([
      { version: "1.0.90" },
      {
        identities: {
          user: {
            status: "ready",
            open_id: "ou_account",
            name: "Operator",
            access_token: "must-not-leak",
            scopes: ["im:message"],
          },
        },
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
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["--version", "--format", "json"],
      ["auth", "status", "--format", "json"],
    ]);
  });

  test("reports old versions and explicitly declared missing capabilities", async () => {
    const oldProvider = providerWith(new FakeRunner([{ version: "1.0.89" }]));
    expect(await oldProvider.checkHealth(context())).toMatchObject({
      status: "incompatible",
      version: "1.0.89",
      errorCode: "provider_incompatible",
    });

    const incompleteProvider = providerWith(new FakeRunner([{
      version: "1.0.90",
      capabilities: [
        "chat-search",
        "chat-messages-list",
        "messages-search",
        "messages-send",
        "messages-reply",
      ],
    }]));
    expect(await incompleteProvider.checkHealth(context())).toMatchObject({
      status: "incompatible",
      version: "1.0.90",
      errorCode: "capability_unsupported",
      detail: "lark-cli is missing required capability: messages-resources-download",
    });
  });

  test("maps missing and expired CLI identities to clear health states", async () => {
    const unavailable = providerWith(new FakeRunner([
      new MessageProviderError("provider_unavailable", "secret command output"),
    ]));
    expect(await unavailable.checkHealth(context())).toMatchObject({
      status: "unavailable",
      errorCode: "provider_unavailable",
      detail: "lark-cli is not installed",
    });

    const expired = providerWith(new FakeRunner([
      { version: "1.2.0" },
      { identities: { user: { status: "needs_refresh", token: "secret" } } },
    ]));
    const health = await expired.checkHealth(context());
    expect(health).toMatchObject({
      status: "unauthenticated",
      errorCode: "unauthenticated",
      detail: "lark-cli user identity needs authentication",
    });
    expect(JSON.stringify(health)).not.toContain("secret");
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
      "2026-08-31T00:00:00.000Z",
      "--end",
      "2026-08-31T02:00:00.000Z",
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

function context(config: Record<string, unknown> = {}, externalAccountId: string | null = null): MessageProviderContext {
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
