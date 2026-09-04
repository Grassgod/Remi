// Sibling test for packages/server/src/store/repos/chat-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { ChatRepo } from "@multiremi/store/repos/chat-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): ChatRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new ChatRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("ChatRepo", () => {
  it("creates a chat session against an agent and lists it", () => {
    const repo = createRepo();
    // Agents live in another repo, reached through ctx.agents().
    const agent = store!.createAgent({ name: "Chatty", provider: "claude", workspaceId: "local" });

    const session = repo.createChatSession({ agentId: agent.id, workspaceId: "local" });
    expect(session.title).toBe("Chat with Chatty");
    expect(repo.getChatSession(session.id)?.id).toBe(session.id);
    expect(repo.listChatSessions("local").map((entry) => entry.id)).toEqual([session.id]);
    expect(() => repo.createChatSession({ agentId: "agt_nope", workspaceId: "local" })).toThrow("Agent not found: agt_nope");
  });

  it("binds and unbinds an Issue in the same workspace", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Chatty", provider: "codex", workspaceId: "local" });
    const issue = store!.createIssue({ title: "Bound work", workspaceId: "local" });
    const session = repo.createChatSession({ agentId: agent.id, workspaceId: "local" });

    expect(session.issueId).toBeNull();
    expect(repo.updateChatSession(session.id, { issueId: issue.id }).issueId).toBe(issue.id);
    expect(repo.updateChatSession(session.id, { title: "Still bound" }).issueId).toBe(issue.id);
    expect(repo.updateChatSession(session.id, { issue_id: null }).issueId).toBeNull();
  });

  it("rejects an Issue binding from another workspace", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Chatty", provider: "codex", workspaceId: "local" });
    const issue = store!.createIssue({ title: "Foreign", workspaceId: "other" });
    const session = repo.createChatSession({ agentId: agent.id, workspaceId: "local" });

    expect(() => repo.updateChatSession(session.id, { issueId: issue.id })).toThrow("Issue belongs to another workspace");
  });

  it("sends a message, spawning the task through ctx.tasks()", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Sender", provider: "claude", workspaceId: "local" });
    const session = repo.createChatSession({ agentId: agent.id, workspaceId: "local" });

    const result = repo.sendChatMessage(session.id, { body: "hello there" });
    expect(result.message.body).toBe("hello there");
    expect(result.task.chatSessionId).toBe(session.id);
    expect(result.session.latestTaskId).toBe(result.task.id);
    expect(repo.listChatMessages(session.id).map((entry) => entry.id)).toEqual([result.message.id]);
    expect(repo.getPendingChatTask(session.id)?.id).toBe(result.task.id);
    expect(repo.getChatMessage(result.message.id)?.body).toBe("hello there");
  });

  it("emits chat events on the workspace listener", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Noisy", provider: "claude", workspaceId: "local" });
    const session = repo.createChatSession({ agentId: agent.id, workspaceId: "local" });

    // The repo emits through the same StoreContext it was constructed with.
    const ctx = new StoreContext(db!, () => store!);
    const scoped = new ChatRepo(ctx);
    const seen: string[] = [];
    ctx.workspaceEventListeners.add((event) => seen.push(event.type));

    scoped.updateChatSession(session.id, { title: "Renamed" });
    scoped.markChatSessionRead(session.id);
    expect(seen).toEqual(["chat:session_updated", "chat:session_read"]);
    expect(repo.getChatSession(session.id)?.title).toBe("Renamed");
  });
});
