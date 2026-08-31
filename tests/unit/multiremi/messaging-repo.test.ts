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
    })).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(repo.ingestMessages({
      connectionId: "conn_a",
      sourceId: "source_a",
      messages: [message],
      ingestedAt: "2026-08-31T10:02:00.000Z",
    })).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(repo.ingestMessages({
      connectionId: "conn_b",
      sourceId: "source_b",
      messages: [message],
      ingestedAt: "2026-08-31T10:03:00.000Z",
    })).toEqual({ inserted: 1, updated: 0, unchanged: 0 });

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
    })).toEqual({ inserted: 0, updated: 1, unchanged: 0 });

    expect(repo.getMessage("conn_a", original.externalMessageId)).toMatchObject({
      text: "edited text",
      editedAt: "2026-08-31T10:06:00.000Z",
      ingestedAt: "2026-08-31T10:07:00.000Z",
      processedAt: "2026-08-31T10:05:00.000Z",
      retryCount: 2,
      lastRetryAt: "2026-08-31T10:04:00.000Z",
    });
  });
});
