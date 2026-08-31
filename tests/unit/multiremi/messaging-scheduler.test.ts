import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type {
  CanonicalMessage,
  MessageProvider,
  MessageProviderContext,
  MessageProviderHealth,
  MessageProviderManifest,
  MessageSyncPage,
  MessageSyncProvider,
  MessageSyncRequest,
} from "@multiremi/contracts/messaging.js";
import { MessageProviderError } from "@multiremi/contracts/messaging.js";
import { MessageProviderRegistry } from "@multiremi/messaging/registry.js";
import { MessagingScheduler } from "@multiremi/messaging/scheduler.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { MessagingRepo } from "@multiremi/store/repos/messaging-repo.js";

let db: Database | null = null;

const ACTIVATED_AT = "2026-08-31T09:00:00.000Z";

function createRepo(): MessagingRepo {
  db = new Database(":memory:");
  const sqlDatabase = db as unknown as SqlDatabase;
  runMigrations(sqlDatabase);
  const repo = new MessagingRepo({ db: sqlDatabase } as Pick<StoreContext, "db">);
  repo.upsertConnection({
    id: "conn_a",
    workspaceId: "local",
    provider: "fake_provider",
    channel: "fake_channel",
    name: "Fake connection",
    status: "ready",
    config: { profile: "default" },
  });
  repo.upsertSource({
    id: "source_a",
    workspaceId: "local",
    connectionId: "conn_a",
    name: "Fake source",
    allowlist: [{ externalConversationId: "conversation_1", addedAt: ACTIVATED_AT }],
  });
  return repo;
}

function manifest(overrides: Partial<MessageProviderManifest["capabilities"]> = {}): MessageProviderManifest {
  return {
    provider: "fake_provider",
    channels: ["fake_channel"],
    authMethods: ["external_tool"],
    displayName: "Fake provider",
    capabilities: {
      pull: true,
      push: false,
      searchConversations: true,
      readConversations: true,
      send: false,
      reply: false,
      attachmentDownload: false,
      attachmentUpload: false,
      mention: true,
      reaction: false,
      edit: true,
      recall: true,
      ...overrides,
    },
  };
}

function health(overrides: Partial<MessageProviderHealth> = {}): MessageProviderHealth {
  return {
    status: "ready",
    version: "1.0.0",
    externalAccountId: "account_1",
    externalAccountName: "Tester",
    errorCode: null,
    detail: null,
    checkedAt: "2026-08-31T10:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    externalMessageId: "external_message_1",
    externalConversationId: "conversation_1",
    conversationName: "Test conversation",
    conversationKind: "group",
    externalThreadId: null,
    externalRootId: null,
    externalParentId: null,
    sender: { externalSenderId: "sender_1", displayName: "Sender", kind: "user", isSelf: false },
    text: "hello",
    attachments: [],
    mentions: [],
    reactions: [],
    url: null,
    sentAt: "2026-08-31T09:30:00.000Z",
    editedAt: null,
    recalled: false,
    raw: {},
    ...overrides,
  };
}

interface FakeProviderOptions {
  pages?: MessageSyncPage[];
  health?: MessageProviderHealth;
  capabilities?: Partial<MessageProviderManifest["capabilities"]>;
  syncError?: Error;
}

class FakeProvider implements MessageSyncProvider {
  readonly manifest: MessageProviderManifest;
  readonly requests: MessageSyncRequest[] = [];
  healthCalls = 0;
  private readonly pages: MessageSyncPage[];
  private readonly healthResult: MessageProviderHealth;
  private readonly syncError: Error | undefined;

  constructor(options: FakeProviderOptions = {}) {
    this.manifest = manifest(options.capabilities);
    this.pages = options.pages ?? [{ messages: [message()], cursor: null, done: true }];
    this.healthResult = options.health ?? health();
    this.syncError = options.syncError;
  }

  async checkHealth(_context: MessageProviderContext): Promise<MessageProviderHealth> {
    this.healthCalls += 1;
    return this.healthResult;
  }

  async syncMessages(_context: MessageProviderContext, request: MessageSyncRequest): Promise<MessageSyncPage> {
    this.requests.push(request);
    if (this.syncError) throw this.syncError;
    return this.pages[this.requests.length - 1] ?? { messages: [], cursor: null, done: true };
  }
}

function createScheduler(repo: MessagingRepo, provider: MessageProvider, leaseOwner = "core-1"): MessagingScheduler {
  return new MessagingScheduler({
    store: repo,
    registry: new MessageProviderRegistry([provider]),
    leaseOwner,
    healthIntervalMs: 0,
  });
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("MessagingScheduler", () => {
  it("pulls through the Provider and advances the watermark to the window end", async () => {
    const repo = createRepo();
    const provider = new FakeProvider();
    const scheduler = createScheduler(repo, provider);
    const now = new Date("2026-08-31T10:00:00.000Z");

    const result = await scheduler.runOnce(now);

    expect(result).toMatchObject({ attempted: 1, completed: 1, failed: 0, inserted: 1, rejected: 0 });
    expect(repo.getMessage("conn_a", "external_message_1")?.sourceId).toBe("source_a");

    const cursor = repo.getSyncCursor("source_a", "messages");
    expect(cursor?.watermark).toBe(now.toISOString());
    expect(cursor?.cursor).toBeNull();
    expect(cursor?.lastError).toBeNull();
    // The lease is handed back, so any instance may take the next cycle.
    expect(cursor?.leaseToken).toBeNull();
    expect(repo.getSource("source_a")).toMatchObject({
      lastSuccessfulIngestAt: cursor?.lastCompletedAt ?? null,
      lastErrorCode: null,
      consecutiveFailures: 0,
    });

    // First cycle starts from consent, never from the Provider's own idea of history.
    const first = provider.requests[0]!;
    expect(first.start.toISOString()).toBe("2026-08-31T08:58:00.000Z");
    expect(first.end.toISOString()).toBe(now.toISOString());
    expect(first.cursor).toBeNull();
  });

  it("resumes a paged window on its original bounds instead of restarting it", async () => {
    const repo = createRepo();
    const provider = new FakeProvider({
      pages: [
        { messages: [message({ externalMessageId: "m1" })], cursor: { page: 2 }, done: false },
        { messages: [message({ externalMessageId: "m2" })], cursor: null, done: true },
      ],
    });
    const scheduler = new MessagingScheduler({
      store: repo,
      registry: new MessageProviderRegistry([provider]),
      leaseOwner: "core-1",
      healthIntervalMs: 0,
      maxPagesPerSource: 1,
    });

    const first = await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z"));
    expect(first).toMatchObject({ attempted: 1, completed: 0, failed: 0, inserted: 1 });
    // Unfinished, so the watermark must not move.
    expect(repo.getSyncCursor("source_a", "messages")?.watermark).toBeNull();
    expect(repo.getSyncCursor("source_a", "messages")?.cursor).toMatchObject({ providerCursor: { page: 2 } });

    // A stored cursor makes the Source due again immediately.
    const second = await scheduler.runOnce(new Date("2026-08-31T10:00:01.000Z"));
    expect(second).toMatchObject({ attempted: 1, completed: 1, inserted: 1 });

    expect(provider.requests.map((request) => request.end.toISOString()))
      .toEqual(["2026-08-31T10:00:00.000Z", "2026-08-31T10:00:00.000Z"]);
    expect(provider.requests[1]?.cursor).toEqual({ page: 2 });
    expect(repo.getSyncCursor("source_a", "messages")?.watermark).toBe("2026-08-31T10:00:00.000Z");
  });

  it("re-reads an overlap on the next cycle so a late arrival is not skipped", async () => {
    const repo = createRepo();
    const provider = new FakeProvider({
      pages: [
        { messages: [], cursor: null, done: true },
        { messages: [], cursor: null, done: true },
      ],
    });
    const scheduler = createScheduler(repo, provider);

    await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z"));
    await scheduler.runOnce(new Date("2026-08-31T10:01:00.000Z"));

    expect(provider.requests[1]?.start.toISOString()).toBe("2026-08-31T09:58:00.000Z");
  });

  it("reports an unusable Connection once instead of as a stream of sync errors", async () => {
    const repo = createRepo();
    const provider = new FakeProvider({
      health: health({ status: "unauthenticated", errorCode: "unauthenticated", externalAccountId: null }),
    });
    const scheduler = createScheduler(repo, provider);

    const result = await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z"));

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 1, inserted: 0 });
    expect(provider.requests).toHaveLength(0);
    // The status lands on the Connection, which is what the UI reads.
    expect(repo.getConnection("conn_a")).toMatchObject({
      status: "unauthenticated",
      lastErrorCode: "unauthenticated",
      config: { profile: "default" },
    });
    expect(repo.getSource("source_a")?.lastErrorCode).toBe("unauthenticated");
    expect(repo.getSyncCursor("source_a", "messages")?.lastError).toBe("unauthenticated");
  });

  it("refuses to pull through a Provider whose manifest does not declare it", async () => {
    const repo = createRepo();
    const provider = new FakeProvider({ capabilities: { pull: false } });
    const scheduler = createScheduler(repo, provider);

    const result = await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z"));

    expect(result.failed).toBe(1);
    expect(provider.requests).toHaveLength(0);
    expect(repo.getSource("source_a")?.lastErrorCode).toBe("capability_unsupported");
  });

  it("keeps a failed Source retryable and backs off before trying again", async () => {
    const repo = createRepo();
    const provider = new FakeProvider({ syncError: new MessageProviderError("rate_limited", "slow down") });
    const scheduler = createScheduler(repo, provider);

    expect(await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z"))).toMatchObject({ failed: 1 });
    expect(repo.getSyncCursor("source_a", "messages")?.lastError).toBe("rate_limited");

    // Backed off: the default 15s interval is doubled after a failure.
    expect(await scheduler.runOnce(new Date("2026-08-31T10:00:20.000Z"))).toMatchObject({ attempted: 0, skipped: 1 });
    expect(await scheduler.runOnce(new Date("2026-08-31T10:01:00.000Z"))).toMatchObject({ attempted: 1 });
  });

  it("lets only one instance poll a Source, and never loses the other's work", async () => {
    const repo = createRepo();
    const slow = new FakeProvider({ pages: [{ messages: [message()], cursor: null, done: true }] });
    const fast = new FakeProvider();
    const first = createScheduler(repo, slow, "core-1");
    const second = createScheduler(repo, fast, "core-2");
    const now = new Date("2026-08-31T10:00:00.000Z");

    const [left, right] = await Promise.all([first.runOnce(now), second.runOnce(now)]);

    // Exactly one instance did the work; the other found the Source leased.
    expect([left.completed, right.completed].sort()).toEqual([0, 1]);
    expect([left.attempted, right.attempted].sort()).toEqual([0, 1]);
    expect(slow.requests.length + fast.requests.length).toBe(1);
    expect(repo.getMessage("conn_a", "external_message_1")).not.toBeNull();
  });

  it("skips a Source that is disabled or has consented to nothing", async () => {
    const repo = createRepo();
    const provider = new FakeProvider();
    const scheduler = createScheduler(repo, provider);

    repo.upsertSource({
      id: "source_a",
      workspaceId: "local",
      connectionId: "conn_a",
      name: "Fake source",
      enabled: false,
      allowlist: [{ externalConversationId: "conversation_1", addedAt: ACTIVATED_AT }],
    });
    expect(await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z")))
      .toMatchObject({ attempted: 0, skipped: 1 });

    repo.upsertSource({
      id: "source_a",
      workspaceId: "local",
      connectionId: "conn_a",
      name: "Fake source",
      enabled: true,
      allowlist: [],
    });
    expect(await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z")))
      .toMatchObject({ attempted: 0, skipped: 1 });
    expect(provider.requests).toHaveLength(0);
  });

  it("does not store what the allowlist never consented to, even if the Provider returns it", async () => {
    const repo = createRepo();
    const provider = new FakeProvider({
      pages: [{
        messages: [
          message({ externalMessageId: "allowed" }),
          message({ externalMessageId: "off_list", externalConversationId: "conversation_2" }),
        ],
        cursor: null,
        done: true,
      }],
    });
    const scheduler = createScheduler(repo, provider);

    const result = await scheduler.runOnce(new Date("2026-08-31T10:00:00.000Z"));

    expect(result).toMatchObject({ inserted: 1, rejected: 1 });
    expect(repo.getMessage("conn_a", "off_list")).toBeNull();
  });
});
