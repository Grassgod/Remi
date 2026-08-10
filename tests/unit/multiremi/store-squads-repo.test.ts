// Sibling test for packages/server/src/store/repos/squads-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { SquadsRepo } from "@multiremi/store/repos/squads-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): SquadsRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new SquadsRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("SquadsRepo", () => {
  it("creates a squad and lists it in its workspace", () => {
    const repo = createRepo();
    const squad = repo.createSquad({ name: "Platform", workspaceId: "local" });

    expect(repo.getSquad(squad.id)?.name).toBe("Platform");
    expect(repo.listSquads("local").map((entry) => entry.id)).toContain(squad.id);
    expect(repo.archiveSquad(squad.id).archivedAt).toBeTruthy();
    expect(repo.listSquads("local").map((entry) => entry.id)).not.toContain(squad.id);
  });

  it("adds an agent as a squad member", () => {
    const repo = createRepo();
    const squad = repo.createSquad({ name: "Responders", workspaceId: "local" });
    const agent = store!.createAgent({ name: "Pager", provider: "claude", workspaceId: "local" });

    const member = repo.addSquadMember(squad.id, { memberType: "agent", memberId: agent.id });
    expect(member.memberId).toBe(agent.id);
    expect(repo.listSquadMembers(squad.id).map((entry) => entry.memberId)).toEqual([agent.id]);

    repo.removeSquadMember(squad.id, { memberType: "agent", memberId: agent.id });
    expect(repo.listSquadMembers(squad.id)).toEqual([]);
  });

  it("keeps exactly one leader when leadership changes", () => {
    const repo = createRepo();
    const first = store!.createAgent({ name: "First", provider: "claude", workspaceId: "local" });
    const second = store!.createAgent({ name: "Second", provider: "codex", workspaceId: "local" });
    const squad = repo.createSquad({ name: "Reviewers", workspaceId: "local", leaderId: first.id, memberIds: [second.id] });

    repo.updateSquad(squad.id, { leaderId: second.id });

    expect(repo.getSquad(squad.id)?.leaderId).toBe(second.id);
    expect(repo.listSquadMembers(squad.id).map((member) => [member.memberId, member.role])).toEqual([
      [second.id, "leader"],
      [first.id, "member"],
    ]);
    const storedLeaders = db!.query(
      "SELECT member_id FROM multiremi_squad_members WHERE squad_id = ? AND role = 'leader'",
    ).all(squad.id) as Array<{ member_id: string }>;
    expect(storedLeaders.map((row) => row.member_id)).toEqual([second.id]);
  });

  it("keeps an idempotently re-added current leader canonical", () => {
    const repo = createRepo();
    const leader = store!.createAgent({ name: "Lead", provider: "claude", workspaceId: "local" });
    const squad = repo.createSquad({ name: "Reviewers", workspaceId: "local", leaderId: leader.id });

    const member = repo.addSquadMember(squad.id, {
      memberType: "agent",
      memberId: leader.id,
      role: "member",
    });

    expect(member.role).toBe("leader");
    expect(repo.getSquad(squad.id)?.leaderId).toBe(leader.id);
  });

  it("promoting a member through its role synchronizes the squad leader", () => {
    const repo = createRepo();
    const first = store!.createAgent({ name: "First", provider: "claude", workspaceId: "local" });
    const second = store!.createAgent({ name: "Second", provider: "codex", workspaceId: "local" });
    const squad = repo.createSquad({ name: "Reviewers", workspaceId: "local", leaderId: first.id, memberIds: [second.id] });

    repo.addSquadMember(squad.id, { memberType: "agent", memberId: second.id, role: "leader" });

    expect(repo.getSquad(squad.id)?.leaderId).toBe(second.id);
    expect(repo.listSquadMembers(squad.id).filter((member) => member.role === "leader").map((member) => member.memberId)).toEqual([second.id]);
  });

  it("resolves an assignee ref across agents, members and squads", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Resolver", provider: "claude", workspaceId: "local" });
    const squad = repo.createSquad({ name: "Triage", workspaceId: "local" });

    // Cross-domain lookup: agents live in another repo, reached through ctx.agents().
    expect(repo.resolveAssigneeRef(null, agent.id, "local")).toEqual({ assigneeType: "agent", assigneeId: agent.id });
    expect(repo.resolveAssigneeRef("squad", squad.id, "local")).toEqual({ assigneeType: "squad", assigneeId: squad.id });
    expect(repo.resolveAssigneeRef(null, null)).toBeNull();
    expect(() => repo.resolveAssigneeRef("squad", "sqd_nope", "local")).toThrow("Squad not found: sqd_nope");
  });
});
