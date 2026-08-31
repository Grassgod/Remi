import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { CanonicalMessage } from "@multiremi/contracts/messaging.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { MessagingRepo } from "@multiremi/store/repos/messaging-repo.js";

let db: Database | null = null;

function createRepo(): MessagingRepo {
  db = new Database(":memory:");
  const sqlDatabase = db as unknown as SqlDatabase;
  runMigrations(sqlDatabase);
  return new MessagingRepo({ db: sqlDatabase } as Pick<StoreContext, "db">);
}

function addConnectionAndSource(repo: MessagingRepo, suffix: string): void {
  repo.upsertConnection({
    id: `conn_${suffix}`,
    workspaceId: "local",
    provider: "test_provider",
    channel: "test_channel",
    name: `Connection ${suffix}`,
    status: "ready",
    config: { profile: suffix },
  });
  repo.upsertSource({
    id: `source_${suffix}`,
    workspaceId: "local",
    connectionId: `conn_${suffix}`,
    name: `Source ${suffix}`,
    allowlist: [{ externalConversationId: "conversation_1", addedAt: "2026-08-31T09:00:00.000Z" }],
  });
}

function canonicalMessage(overrides: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    externalMessageId: "external_message_1",
    externalConversationId: "conversation_1",
    conversationName: "Test conversation",
    conversationKind: "group",
    externalThreadId: null,
    externalRootId: null,
    externalParentId: null,
    sender: {
      externalSenderId: "sender_1",
      displayName: "Sender",
      kind: "user",
      isSelf: false,
    },
    text: "original text",
    attachments: [],
    mentions: [],
    reactions: [],
    url: null,
    sentAt: "2026-08-31T10:00:00.000Z",
    editedAt: null,
    recalled: false,
    raw: { message_id: "external_message_1", content: "original text" },
    ...overrides,
  };
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("MessagingRepo", () => {
  it("upserts and reads channel-independent connections and sources", () => {
    const repo = createRepo();
    addConnectionAndSource(repo, "a");

    expect(repo.getConnection("conn_a")).toMatchObject({
      id: "conn_a",
      workspaceId: "local",
      provider: "test_provider",
      channel: "test_channel",
      status: "ready",
      config: { profile: "a" },
    });
    expect(repo.getSource("source_a")).toMatchObject({
      connectionId: "conn_a",
      enabled: true,
      retentionDays: 90,
      pollIntervalSeconds: 15,
      unprocessedRetrySeconds: 900,
      unprocessedRetryLimit: 3,
    });

    repo.upsertSource({
      id: "source_a",
      workspaceId: "local",
      connectionId: "conn_a",
      name: "Renamed source",
      pollIntervalSeconds: 30,
    });
    expect(repo.getSource("source_a")).toMatchObject({
      name: "Renamed source",
      pollIntervalSeconds: 30,
      allowlist: [{ externalConversationId: "conversation_1", addedAt: "2026-08-31T09:00:00.000Z" }],
    });

    addConnectionAndSource(repo, "b");
    expect(() => repo.upsertSource({
      id: "source_a",
      workspaceId: "local",
      connectionId: "conn_b",
      name: "Invalid rebound source",
    })).toThrow("Message source cannot be rebound to another connection");
    expect(repo.getSource("source_a")?.connectionId).toBe("conn_a");
  });

  it("deduplicates within a connection while allowing the same external id across connections", () => {
    const repo = createRepo();
    addConnectionAndSource(repo, "a");
    addConnectionAndSource(repo, "b");
    const message = canonicalMessage();

    expect(() => repo.ingestMessages({
      connectionId: "conn_b",
      sourceId: "source_a",
      messages: [message],
    })).toThrow("Message source does not belong to the requested connection");
    expect(repo.ingestMessages({
      connectionId: "conn_a",
      sourceId: "source_a",
      messages: [message],
      ingestedAt: "2026-08-31T10:01:00.000Z",
    })).toEqual({ inserted: 1, updated: 0, unchanged: 0, skipped: 0 });
    expect(repo.ingestMessages({
      connectionId: "conn_a",
      sourceId: "source_a",
      messages: [message],
      ingestedAt: "2026-08-31T10:02:00.000Z",
    })).toEqual({ inserted: 0, updated: 0, unchanged: 1, skipped: 0 });
    expect(repo.ingestMessages({
      connectionId: "conn_b",
      sourceId: "source_b",
      messages: [message],
      ingestedAt: "2026-08-31T10:03:00.000Z",
    })).toEqual({ inserted: 1, updated: 0, unchanged: 0, skipped: 0 });

    expect(repo.getMessage("conn_a", message.externalMessageId)?.sourceId).toBe("source_a");
    expect(repo.getMessage("conn_b", message.externalMessageId)?.sourceId).toBe("source_b");
    const count = db!.query(
      "SELECT COUNT(*) AS count FROM multiremi_message_messages WHERE external_message_id = ?",
    ).get(message.externalMessageId) as { count: number };
    expect(count.count).toBe(2);
  });

  it("updates canonical content without resetting historical processing state", () => {
    const repo = createRepo();
    addConnectionAndSource(repo, "a");
    const original = canonicalMessage();
    repo.ingestMessages({ connectionId: "conn_a", sourceId: "source_a", messages: [original] });
    repo.updateMessageProcessingState({
      connectionId: "conn_a",
      externalMessageId: original.externalMessageId,
      processedAt: "2026-08-31T10:05:00.000Z",
      retryCount: 2,
      lastRetryAt: "2026-08-31T10:04:00.000Z",
    });

    const edited = canonicalMessage({
      text: "edited text",
      editedAt: "2026-08-31T10:06:00.000Z",
      raw: { message_id: "external_message_1", content: "edited text" },
    });
    expect(repo.ingestMessages({
      connectionId: "conn_a",
      sourceId: "source_a",
      messages: [edited],
      ingestedAt: "2026-08-31T10:07:00.000Z",
    })).toEqual({ inserted: 0, updated: 1, unchanged: 0, skipped: 0 });

    expect(repo.getMessage("conn_a", original.externalMessageId)).toMatchObject({
      text: "edited text",
      editedAt: "2026-08-31T10:06:00.000Z",
      ingestedAt: "2026-08-31T10:07:00.000Z",
      processedAt: "2026-08-31T10:05:00.000Z",
      retryCount: 2,
      lastRetryAt: "2026-08-31T10:04:00.000Z",
    });
  });

  it("stores only what the allowlist consented to, whatever the Provider returns", () => {
    const repo = createRepo();
    addConnectionAndSource(repo, "a"); // conversation_1 activated 09:00:00.000Z

    const result = repo.ingestMessages({
      connectionId: "conn_a",
      sourceId: "source_a",
      messages: [
        // Never opted in — a Provider returning it must not widen storage.
        canonicalMessage({ externalMessageId: "off_list", externalConversationId: "conversation_2" }),
        // Before consent.
        canonicalMessage({ externalMessageId: "before", sentAt: "2026-08-31T08:59:00.000Z" }),
        // Inside the activation minute: excluded, because a channel that reports
        // only minute precision could place this either side of consent.
        canonicalMessage({ externalMessageId: "same_minute", sentAt: "2026-08-31T09:00:59.000Z" }),
        canonicalMessage({ externalMessageId: "after", sentAt: "2026-08-31T09:01:00.000Z" }),
      ],
    });

    expect(result).toEqual({ inserted: 1, updated: 0, unchanged: 0, skipped: 3 });
    expect(repo.getMessage("conn_a", "after")).not.toBeNull();
    for (const rejected of ["off_list", "before", "same_minute"]) {
      expect(repo.getMessage("conn_a", rejected)).toBeNull();
    }
  });

  it("leases a sync stream exclusively and only lets the holder write", () => {
    const repo = createRepo();
    addConnectionAndSource(repo, "a");
    const claim = { sourceId: "source_a", stream: "messages", now: "2026-08-31T10:00:00.000Z", leaseMs: 60_000 };

    const first = repo.claimSyncStream({ ...claim, owner: "core-1" });
    expect(first?.leaseToken).toBeTruthy();
    // A second Core instance must not be able to poll the same Source.
    expect(repo.claimSyncStream({ ...claim, owner: "core-2" })).toBeNull();

    expect(repo.updateClaimedSyncCursor({
      sourceId: "source_a",
      stream: "messages",
      leaseToken: "not-the-holder",
      watermark: "2026-08-31T10:00:00.000Z",
    })).toBeNull();

    expect(repo.updateClaimedSyncCursor({
      sourceId: "source_a",
      stream: "messages",
      leaseToken: first!.leaseToken!,
      cursor: { page: 2 },
      watermark: "2026-08-31T10:00:00.000Z",
    })).toMatchObject({ cursor: { page: 2 }, watermark: "2026-08-31T10:00:00.000Z" });

    expect(repo.releaseSyncStream("source_a", "messages", first!.leaseToken!)).toBe(true);
    // Released, so the next instance may take it — and progress survived.
    const second = repo.claimSyncStream({ ...claim, owner: "core-2" });
    expect(second?.cursor).toEqual({ page: 2 });
  });

  it("expires a stale lease so a crashed instance cannot block a Source forever", () => {
    const repo = createRepo();
    addConnectionAndSource(repo, "a");
    repo.claimSyncStream({
      sourceId: "source_a", stream: "messages", owner: "crashed", leaseMs: 60_000,
      now: "2026-08-31T10:00:00.000Z",
    });
    expect(repo.claimSyncStream({
      sourceId: "source_a", stream: "messages", owner: "healthy", leaseMs: 60_000,
      now: "2026-08-31T10:01:01.000Z",
    })?.leaseOwner).toBe("healthy");
  });
});
