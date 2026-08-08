// Sibling test for packages/server/src/store/repos/issue-sessions-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { IssueSessionsRepo } from "@multiremi/store/repos/issue-sessions-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): IssueSessionsRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new IssueSessionsRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("IssueSessionsRepo", () => {
  it("returns the same default session for an issue on every call", () => {
    const repo = createRepo();
    const issue = store!.createIssue({ title: "Session host", workspaceId: "local" });

    const first = repo.getOrCreateDefaultIssueSession(issue.id);
    const second = repo.getOrCreateDefaultIssueSession(issue.id);
    expect(second.id).toBe(first.id);
    expect(first.isDefault).toBe(true);
    expect(repo.listIssueSessions(issue.id).map((entry) => entry.id)).toEqual([first.id]);
    expect(() => repo.listIssueSessions("iss_nope")).toThrow("Issue not found: iss_nope");
  });

  it("appends session events with a monotonic per-session sequence", () => {
    const repo = createRepo();
    const issue = store!.createIssue({ title: "Event log", workspaceId: "local" });
    const session = repo.getOrCreateDefaultIssueSession(issue.id);

    const first = repo.appendSessionEvent(session.id, { authorType: "system", body: "one" });
    const second = repo.appendSessionEvent(session.id, { authorType: "system", body: "two" });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(repo.listSessionEvents(session.id).map((entry) => entry.body)).toEqual(["one", "two"]);
    expect(repo.listSessionEvents(session.id, { sinceSeq: 1 }).map((entry) => entry.body)).toEqual(["two"]);
  });

  it("adds an agent participant and opens its lane (cross-domain agent lookup)", () => {
    const repo = createRepo();
    const issue = store!.createIssue({ title: "Lane", workspaceId: "local" });
    const session = repo.getOrCreateDefaultIssueSession(issue.id);
    // Agents live in another repo, reached through ctx.agents().
    const agent = store!.createAgent({ name: "Laner", provider: "claude", workspaceId: "local" });

    const participant = repo.addSessionParticipant(session.id, { participantType: "agent", participantId: agent.id });
    expect(participant.participantId).toBe(agent.id);
    expect(repo.getSessionAgentLane(session.id, agent.id)?.cursorSeq).toBe(0);
    expect(() => repo.addSessionParticipant(session.id, { participantType: "agent", participantId: "agt_nope" }))
      .toThrow("Agent not found: agt_nope");

    repo.removeSessionParticipant(session.id, "agent", agent.id);
    expect(repo.listSessionParticipants(session.id)).toEqual([]);
  });
});
