import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { ChatLinksRepo } from "@multiremi/store/repos/chat-links-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): ChatLinksRepo {
  db = new Database(":memory:");
  store = new MultiremiStore(db);
  return new ChatLinksRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("ChatLinksRepo", () => {
  it("idempotently resolves concurrent requests to one persisted chat session", async () => {
    const repo = createRepo();
    const agent = store!.createAgent({
      name: "Concierge",
      provider: "claude",
      workspaceId: "local",
      visibility: "workspace",
    });
    const input = {
      workspaceId: "local",
      source: "feishu" as const,
      externalChatId: "oc_external_chat",
      agentId: agent.id,
      creatorId: "alice",
    };

    const sessions = await Promise.all(Array.from({ length: 8 }, async () =>
      repo.getOrCreateChatSessionForExternalChat(input)
    ));

    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    expect(store!.listChatSessions("local")).toHaveLength(1);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_chat_links").get()).toEqual({ count: 1 });
    expect(repo.getChatLink("local", "feishu", "oc_external_chat")?.chatSessionId).toBe(sessions[0]!.id);
  });

  it("removes an external link when its chat session is deleted", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Concierge", provider: "claude" });
    const session = repo.getOrCreateChatSessionForExternalChat({
      workspaceId: "local",
      source: "feishu",
      externalChatId: "oc_delete_me",
      agentId: agent.id,
      creatorId: "alice",
    });

    expect(store!.deleteChatSession(session.id)).toBe(true);
    expect(repo.getChatLink("local", "feishu", "oc_delete_me")).toBeNull();
  });

  it("repairs an orphaned link when the linked session disappeared", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Concierge", provider: "claude" });
    const input = {
      workspaceId: "local",
      source: "feishu" as const,
      externalChatId: "oc_orphaned",
      agentId: agent.id,
      creatorId: "alice",
    };
    const original = repo.getOrCreateChatSessionForExternalChat(input);
    db!.run("DELETE FROM multiremi_chat_sessions WHERE id = ?", [original.id]);

    const repaired = repo.getOrCreateChatSessionForExternalChat(input);

    expect(repaired.id).not.toBe(original.id);
    expect(store!.listChatSessions("local")).toHaveLength(1);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_chat_links").get()).toEqual({ count: 1 });
    expect(repo.getChatLink("local", "feishu", "oc_orphaned")?.chatSessionId).toBe(repaired.id);
  });
});
