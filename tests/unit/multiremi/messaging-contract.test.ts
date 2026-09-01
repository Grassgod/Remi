import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { MessageProviderRegistry } from "@multiremi/messaging/registry.js";
import {
  MessageProviderError,
  isRetryableMessageErrorCode,
  supportsAttachments,
  supportsConversations,
  supportsPush,
  supportsSend,
  supportsSync,
} from "@multiremi/contracts/messaging.js";
import type {
  CanonicalMessage,
  MessageProvider,
  MessageProviderCapabilities,
  MessageProviderContext,
  MessageProviderHealth,
  MessageSyncPage,
  MessageSyncProvider,
  MessageSyncRequest,
} from "@multiremi/contracts/messaging.js";

const CONTRACT_PATH = new URL("../../../packages/contracts/src/messaging.ts", import.meta.url);

function capabilities(overrides: Partial<MessageProviderCapabilities> = {}): MessageProviderCapabilities {
  return {
    pull: false,
    push: false,
    searchConversations: false,
    readConversations: false,
    send: false,
    reply: false,
    attachmentDownload: false,
    attachmentUpload: false,
    mention: false,
    reaction: false,
    edit: false,
    recall: false,
    ...overrides,
  };
}

/**
 * A Provider for an invented channel, built only from the public contract.
 *
 * Its purpose is the acceptance criterion "a second channel needs no Messaging
 * Core change": it never imports a channel-specific type and the Core reaches
 * it purely through registration and capability probes.
 */
class VirtualChannelProvider implements MessageSyncProvider {
  readonly manifest = {
    provider: "virtual_test",
    channels: ["virtual_chat"] as const,
    authMethods: ["app_credential"] as const,
    capabilities: capabilities({ pull: true, edit: true, recall: true }),
    displayName: "Virtual Test Channel",
  };

  constructor(private readonly pages: readonly MessageSyncPage[]) {}

  private index = 0;

  async checkHealth(context: MessageProviderContext): Promise<MessageProviderHealth> {
    return {
      status: "ready",
      version: "1.0.0",
      externalAccountId: context.connection.externalAccountId,
      externalAccountName: context.connection.externalAccountName,
      errorCode: null,
      detail: null,
      checkedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    };
  }

  async syncMessages(_context: MessageProviderContext, _request: MessageSyncRequest): Promise<MessageSyncPage> {
    const page = this.pages[this.index] ?? { messages: [], cursor: null, done: true };
    this.index += 1;
    return page;
  }
}

function message(externalMessageId: string): CanonicalMessage {
  return {
    externalMessageId,
    externalConversationId: "vc_1",
    conversationName: "Virtual room",
    conversationKind: "group",
    externalThreadId: null,
    externalRootId: null,
    externalParentId: null,
    sender: { externalSenderId: "vu_1", displayName: "Ada", kind: "user", isSelf: false },
    text: "hello",
    attachments: [],
    mentions: [],
    reactions: [],
    url: null,
    sentAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    recalled: false,
    raw: { id: externalMessageId },
  };
}

describe("messaging provider contract", () => {
  it("names no concrete channel anywhere in the contract", () => {
    const source = readFileSync(CONTRACT_PATH, "utf8");
    // The doc comment explains the rule by naming the values it forbids as types,
    // so the ban is enforced against code only.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line))
      .join("\n");
    for (const banned of ["feishu", "Feishu", "lark", "Lark", "wechat", "WeChat", "sidecar", "Sidecar", "personal_automation"]) {
      expect(code).not.toInclude(banned);
    }
  });

  it("registers a second channel without any Core change", () => {
    const registry = new MessageProviderRegistry();
    const provider = new VirtualChannelProvider([]);
    registry.register(provider);

    expect(registry.ids()).toEqual(["virtual_test"]);
    expect(registry.channels()).toEqual(["virtual_chat"]);
    expect(registry.forChannel("virtual_chat")).toEqual([provider]);
    expect(registry.forChannel("absent_channel")).toEqual([]);
    expect(registry.get("virtual_test")).toBe(provider);
    expect(registry.get("missing")).toBeNull();
  });

  it("rejects malformed provider and channel ids", () => {
    const registry = new MessageProviderRegistry();
    registry.register(new VirtualChannelProvider([]));
    expect(() => registry.register(new VirtualChannelProvider([]))).toThrow(/Duplicate/u);

    const badProvider = { manifest: { provider: "Bad-Id", channels: ["x"], authMethods: [], capabilities: capabilities(), displayName: "x" } } as unknown as MessageProvider;
    expect(() => new MessageProviderRegistry().register(badProvider)).toThrow(/Invalid message provider id/u);

    const noChannel = { manifest: { provider: "ok", channels: [], authMethods: [], capabilities: capabilities(), displayName: "x" } } as unknown as MessageProvider;
    expect(() => new MessageProviderRegistry().register(noChannel)).toThrow(/declares no channel/u);
  });

  it("gates optional interfaces on the manifest, not on method presence", () => {
    const provider = new VirtualChannelProvider([]);
    expect(supportsSync(provider)).toBe(true);
    expect(supportsConversations(provider)).toBe(false);
    expect(supportsPush(provider)).toBe(false);
    expect(supportsSend(provider)).toBe(false);
    expect(supportsAttachments(provider)).toBe(false);

    // A Provider that ships syncMessages but does not declare `pull` stays disabled,
    // so a half-finished capability can never be driven by the Core.
    const undeclared = new VirtualChannelProvider([]);
    (undeclared.manifest.capabilities as MessageProviderCapabilities).pull = false;
    expect(supportsSync(undeclared)).toBe(false);
  });

  it("drives an incremental pull purely through the contract", async () => {
    const provider = new VirtualChannelProvider([
      { messages: [message("m1")], cursor: { page: 2 }, done: false },
      { messages: [message("m2")], cursor: null, done: true },
    ]);
    const context = {
      connection: {
        id: "conn_1",
        workspaceId: "local",
        provider: "virtual_test",
        channel: "virtual_chat",
        name: "Virtual",
        externalAccountId: "acct_1",
        externalAccountName: "Ada",
        status: "ready" as const,
        config: {},
        lastCheckedAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const request: MessageSyncRequest = {
      source: {
        id: "src_1",
        workspaceId: "local",
        connectionId: "conn_1",
        name: "Virtual source",
        allowlist: [{ externalConversationId: "vc_1", addedAt: "2026-01-01T00:00:00.000Z" }],
        enabled: true,
        retentionDays: 90,
        pollIntervalSeconds: 15,
        unprocessedRetrySeconds: 900,
        unprocessedRetryLimit: 3,
        lastSuccessfulIngestAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        consecutiveFailures: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      cursor: null,
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-01-02T00:00:00.000Z"),
    };

    const first = await provider.syncMessages(context, request);
    expect(first.messages.map((entry) => entry.externalMessageId)).toEqual(["m1"]);
    expect(first.done).toBe(false);

    const second = await provider.syncMessages(context, { ...request, cursor: first.cursor });
    expect(second.messages.map((entry) => entry.externalMessageId)).toEqual(["m2"]);
    expect(second.done).toBe(true);
  });

  it("classifies retryable failures and never retries an unknown send result", () => {
    expect(isRetryableMessageErrorCode("rate_limited")).toBe(true);
    expect(isRetryableMessageErrorCode("timeout")).toBe(true);
    expect(isRetryableMessageErrorCode("unreachable")).toBe(true);
    expect(isRetryableMessageErrorCode("unauthenticated")).toBe(false);
    expect(isRetryableMessageErrorCode("provider_unavailable")).toBe(false);
    // A send whose outcome is unknown must never be replayed automatically:
    // retrying it is exactly how a channel ends up with a duplicate post.
    expect(isRetryableMessageErrorCode("send_result_unknown")).toBe(false);

    const throttled = new MessageProviderError("rate_limited", "slow down", { retryAfterMs: 5_000 });
    expect(throttled.retryable).toBe(true);
    expect(throttled.retryAfterMs).toBe(5_000);
    expect(throttled.name).toBe("MessageProviderError");

    const missing = new MessageProviderError("provider_unavailable");
    expect(missing.retryable).toBe(false);
    expect(missing.retryAfterMs).toBeNull();
    expect(missing.message).toContain("provider_unavailable");
  });
});
