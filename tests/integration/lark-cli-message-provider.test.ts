/**
 * Drives `LarkCliMessageProvider` against a real, logged-in lark-cli.
 *
 * The unit suite pins normalization against recorded fixtures, which only ever
 * proves the Provider agrees with the shapes we wrote down. This file is the
 * check that those shapes are the ones lark-cli actually emits — every mismatch
 * it now guards against (a page size the CLI rejects outright, a zoneless
 * timestamp, an already-rendered `content` string, a reaction tally nested in an
 * object) passed the unit suite while making real ingestion produce nothing.
 *
 * It reads the operator's own Feishu account and never writes: no send, no
 * reply, no upload. Message text and conversation names are treated as private
 * throughout — assertions check shape and invariants, never content, and nothing
 * read here is printed.
 *
 * Skipped, not failed, when lark-cli is missing or signed out, so a checkout
 * without Feishu credentials still runs the suite green.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type {
  MessageAllowlistEntry,
  MessageConnection,
  MessageProviderContext,
  MessageSource,
} from "@multiremi/contracts/messaging.js";
import { LarkCliMessageProvider } from "@multiremi/messaging/providers/lark-cli/provider.js";
import { BunLarkCliRunner } from "@multiremi/messaging/providers/lark-cli/runner.js";

const WINDOW_DAYS = 7;
/** Small enough that an account with any activity pages more than once. */
const PAGE_SIZE = 5;
const CLI_TIMEOUT_MS = 60_000;

/**
 * Chats the account actually saw traffic in during the window.
 *
 * Discovered rather than hard-coded: a fixed chat id would rot, and an
 * allowlist pointed at a quiet conversation would let the incremental-pull
 * assertions pass without ever pulling a message.
 */
async function discoverActiveChats(start: Date, end: Date): Promise<string[]> {
  const runner = new BunLarkCliRunner({ timeoutMs: CLI_TIMEOUT_MS });
  const payload = await runner.run([
    "im", "+messages-search",
    // Second precision, like the Provider: Feishu rejects the milliseconds
    // `toISOString()` would include.
    "--start", `${start.toISOString().slice(0, 19)}Z`,
    "--end", `${end.toISOString().slice(0, 19)}Z`,
    "--page-size", "50",
    "--format", "json",
  ]) as { data?: { messages?: { chat_id?: string }[] } };
  const ids = (payload.data?.messages ?? [])
    .map((message) => message.chat_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].slice(0, 5);
}

const windowEnd = new Date();
const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

/**
 * Probed at collection time because `it.skipIf` needs its answer before
 * `beforeAll` would run. A signed-out CLI is a skip, not a failure.
 */
const reachable = await (async (): Promise<boolean> => {
  try {
    const health = await new LarkCliMessageProvider({ timeoutMs: CLI_TIMEOUT_MS })
      .checkHealth({ connection: connectionFixture(null) });
    return health.status === "ready";
  } catch {
    return false;
  }
})();

function connectionFixture(externalAccountId: string | null): MessageConnection {
  const now = new Date().toISOString();
  return {
    id: "mconn_integration",
    workspaceId: "ws_integration",
    provider: "lark_cli",
    channel: "feishu",
    name: "integration",
    externalAccountId,
    externalAccountName: null,
    status: "ready",
    config: { pageSize: PAGE_SIZE },
    lastCheckedAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function sourceFixture(allowlist: MessageAllowlistEntry[]): MessageSource {
  const now = new Date().toISOString();
  return {
    id: "msrc_integration",
    workspaceId: "ws_integration",
    connectionId: "mconn_integration",
    name: "integration",
    allowlist,
    enabled: true,
    retentionDays: 30,
    pollIntervalSeconds: 60,
    unprocessedRetrySeconds: 300,
    unprocessedRetryLimit: 3,
    lastSuccessfulIngestAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe.skipIf(!reachable)("lark-cli message provider against the real CLI", () => {
  const provider = new LarkCliMessageProvider({ timeoutMs: CLI_TIMEOUT_MS });
  let context: MessageProviderContext;
  let activeChatIds: string[] = [];

  beforeAll(async () => {
    const health = await provider.checkHealth({ connection: connectionFixture(null) });
    context = { connection: connectionFixture(health.externalAccountId) };
    activeChatIds = await discoverActiveChats(windowStart, windowEnd);
  }, CLI_TIMEOUT_MS);

  it("reports a ready identity from the live CLI", async () => {
    const health = await provider.checkHealth(context);

    expect(health.status).toBe("ready");
    expect(health.errorCode).toBeNull();
    // A signed-in CLI names the account it is signed in as. This is also the id
    // `isSelf` is decided against, so an empty one would silently mark every
    // message as somebody else's.
    expect(health.externalAccountId).toMatch(/^ou_[0-9a-f]+$/u);
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/u);

    // The Provider refuses to run below its floor, so a live CLI that reports
    // ready is by construction at or above it. Stated as an assertion because
    // the floor and the pinned version in Dockerfile.api move independently.
    const [major = 0, minor = 0, patch = 0] = (health.version ?? "").split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(1_000_090);
  }, CLI_TIMEOUT_MS);

  it("searches conversations and pages with the cursor it returns", async () => {
    const first = await provider.searchConversations(context, { query: "", limit: PAGE_SIZE });

    expect(first.conversations.length).toBeGreaterThan(0);
    expect(first.conversations.length).toBeLessThanOrEqual(PAGE_SIZE);
    for (const conversation of first.conversations) {
      expect(conversation.externalConversationId).toMatch(/^oc_[0-9a-f]+$/u);
      // `im +chat-search` returns only group chats, and says so as `chat_mode`
      // (DEFAULT/THREAD) rather than the `chat_type` messages carry. Reading the
      // wrong field left every conversation "unknown", which is why this asserts
      // the kind was actually resolved instead of merely being present.
      expect(["group", "thread"]).toContain(conversation.kind);
    }

    if (first.cursor === null) return;
    const second = await provider.searchConversations(context, {
      query: "",
      limit: PAGE_SIZE,
      cursor: first.cursor,
    });
    const firstIds = new Set(first.conversations.map((entry) => entry.externalConversationId));
    const repeats = second.conversations.filter((entry) => firstIds.has(entry.externalConversationId));
    expect(repeats).toEqual([]);
  }, CLI_TIMEOUT_MS);

  it("pulls messages incrementally and advances rather than repeating", async () => {
    expect(activeChatIds.length).toBeGreaterThan(0);
    // A minute before the window so every message inside it clears the
    // activation watermark; the cutoff itself is exercised separately below.
    const addedAt = new Date(windowStart.getTime() - 60_000).toISOString();
    const source = sourceFixture(activeChatIds.map((externalConversationId) => ({
      externalConversationId,
      addedAt,
    })));

    // The default page size used to exceed what `im +messages-search` accepts,
    // so this call failed outright with `invalid_argument` and ingestion pulled
    // nothing at all. Reaching a page is itself the regression check.
    const first = await provider.syncMessages(context, { source, cursor: null, start: windowStart, end: windowEnd });
    expect(first.messages.length).toBeGreaterThan(0);

    const allowed = new Set(activeChatIds);
    for (const message of first.messages) {
      expect(message.externalMessageId).toMatch(/^om_[0-9a-z]+$/u);
      expect(allowed.has(message.externalConversationId)).toBe(true);

      // lark-cli prints `2026-09-01 00:44` with no zone at all. The runner pins
      // the CLI to UTC so it can be read as UTC; without both halves of that,
      // every timestamp lands hours away and drifts outside the very window it
      // was requested for.
      expect(message.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      const sentAt = Date.parse(message.sentAt);
      expect(sentAt).toBeGreaterThanOrEqual(windowStart.getTime() - 60_000);
      expect(sentAt).toBeLessThanOrEqual(windowEnd.getTime() + 60_000);

      expect(["user", "bot", "system", "unknown"]).toContain(message.sender.kind);
      expect(typeof message.text).toBe("string");
    }

    // lark-cli hands back `content` already rendered to a string. The Provider
    // was originally written for the raw Feishu shape, where it is JSON, so it
    // dropped the string on the floor and normalized every real message to "".
    expect(first.messages.some((message) => message.text.trim().length > 0)).toBe(true);

    if (first.cursor === null) {
      expect(first.done).toBe(true);
      return;
    }
    const second = await provider.syncMessages(context, {
      source,
      cursor: first.cursor,
      start: windowStart,
      end: windowEnd,
    });
    const firstIds = new Set(first.messages.map((message) => message.externalMessageId));
    const repeats = second.messages.filter((message) => firstIds.has(message.externalMessageId));
    // Composite identity would dedupe a repeat anyway, but a cursor that does
    // not move turns every poll into a rescan of the same page.
    expect(repeats).toEqual([]);
  }, CLI_TIMEOUT_MS);

  it("honours the allowlist activation watermark", async () => {
    // Consent starts when the conversation is added, so a source allowlisted
    // right now must not backfill the history that preceded it.
    const source = sourceFixture(activeChatIds.map((externalConversationId) => ({
      externalConversationId,
      addedAt: new Date().toISOString(),
    })));

    const page = await provider.syncMessages(context, { source, cursor: null, start: windowStart, end: windowEnd });
    expect(page.messages).toEqual([]);
  }, CLI_TIMEOUT_MS);

  it("reads a conversation the account can see", async () => {
    const conversation = await provider.getConversation(context, activeChatIds[0] as string);

    expect(conversation).not.toBeNull();
    expect(conversation?.externalConversationId).toBe(activeChatIds[0] as string);
  }, CLI_TIMEOUT_MS);
});
