import { expect, it } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

/**
 * The only responsibility resolver: the execution owner of each level of the
 * Issue tree (the assigned Agent or the assigned team's Leader). No designated
 * human, no sender-team or team-member fallback, and no guess across a broken
 * parent chain.
 */
pendingTurnBackendTests("Issue responsibility resolver", fixture => {
  function tree(store: MultiremiStore) {
    const owner = store.createAgent({ name: "Root owner", provider: "claude" });
    const worker = store.createAgent({ name: "Child owner", provider: "claude" });
    const root = store.createIssue({ title: "Root", assigneeType: "agent", assigneeId: owner.id });
    const child = store.createIssue({ title: "Child", parentIssueId: root.id, assigneeType: "agent", assigneeId: worker.id });
    return { owner, worker, root, child };
  }

  it("derives the execution-owner chain only from the Issue tree, with no designated human", () => {
    const { store, db } = fixture();
    const f = tree(store);
    const resolved = store.resolveIssueResponsibility(f.child.id);
    expect(resolved).toMatchObject({
      issueId: f.child.id, workspaceId: "local", rootIssueId: f.root.id, unresolved: [],
      executionOwner: { type: "agent", id: f.worker.id, issueId: f.child.id },
      chain: [{ issueId: f.child.id, executionOwner: { id: f.worker.id } }, { issueId: f.root.id, executionOwner: { id: f.owner.id } }],
    });
    expect(resolved).not.toHaveProperty("reviewOwner");
    expect(resolved).not.toHaveProperty("rootHuman");
    // Comments and the deprecated column are not responsibility facts.
    store.createIssueComment(f.root.id, { body: "Ordinary context" });
    const human = store.createWorkspaceMember({ name: "Legacy root human" });
    db.run("UPDATE multiremi_issues SET responsible_member_id=? WHERE id=?", [human.id, f.root.id]);
    expect(store.resolveIssueResponsibility(f.child.id).revision).toBe(resolved.revision);
    // An execution-owner change is.
    store.updateIssue(f.child.id, { assigneeType: "agent", assigneeId: f.owner.id });
    expect(store.resolveIssueResponsibility(f.child.id).revision).not.toBe(resolved.revision);
  });

  it("records a parent cycle and a missing parent without guessing an owner past the break", () => {
    const { store, db } = fixture();
    const f = tree(store);
    db.run("UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?", [f.child.id, f.root.id]);
    const cycle = store.resolveIssueResponsibility(f.child.id);
    expect(cycle.unresolved).toContainEqual({ issueId: f.child.id, reason: "parent_cycle" });
    expect(cycle.rootIssueId).toBeNull();
    expect(cycle.executionOwner?.id).toBe(f.worker.id);
    db.run("UPDATE multiremi_issues SET parent_issue_id=NULL WHERE id=?", [f.root.id]);
    db.run("UPDATE multiremi_issues SET parent_issue_id=? WHERE id=?", ["iss_missing_parent", f.child.id]);
    const missing = store.resolveIssueResponsibility(f.child.id);
    expect(missing.unresolved).toEqual([{ issueId: "iss_missing_parent", reason: "parent_missing" }]);
    expect(missing.chain.map(node => node.issueId)).toEqual([f.child.id]);
    expect(missing.executionOwner?.id).toBe(f.worker.id);
    expect(store.resolveIssueResponsibility("iss_never_existed").unresolved).toEqual([{ issueId: "iss_never_existed", reason: "issue_missing" }]);
  });

  it("stops at a parent in another workspace", () => {
    const { store, db } = fixture();
    const f = tree(store);
    const other = store.createWorkspace({ name: "Resolver other", slug: "resolver-other" });
    db.run("UPDATE multiremi_issues SET workspace_id=? WHERE id=?", [other.id, f.root.id]);
    const resolved = store.resolveIssueResponsibility(f.child.id);
    expect(resolved.unresolved).toEqual([{ issueId: f.root.id, reason: "workspace_mismatch" }]);
    expect(resolved.chain.map(node => node.issueId)).toEqual([f.child.id]);
  });

  it("never uses a normal team member or the sender's first team when the assigned Leader is absent", () => {
    const { store, db } = fixture();
    const f = tree(store);
    const team = store.createSquad({ name: "Assigned team", leaderId: f.owner.id, memberIds: [f.worker.id] });
    store.updateIssue(f.child.id, { assigneeType: "squad", assigneeId: team.id });
    expect(store.resolveIssueResponsibility(f.child.id).executionOwner?.id).toBe(f.owner.id);
    db.run("UPDATE multiremi_squads SET leader_id=NULL WHERE id=?", [team.id]);
    const resolved = store.resolveIssueResponsibility(f.child.id);
    expect(resolved.executionOwner).toBeNull();
    expect(resolved.unresolved).toContainEqual({ issueId: f.child.id, reason: "leader_missing" });
    expect(() => store.quickCreateIssue({ prompt: "Dispatch without Leader", squadId: team.id })).toThrow("No runnable agent");
    // An owner role without an owner delivers to nobody, with the reason; no member stands in.
    const sent = store.sendMessage({ session_id: store.getOrCreateDefaultIssueSession(f.child.id).id,
      sender: { type: "platform", id: null }, to: { type: "role", ref: "issue_owner" }, message_kind: "report",
      wake_requested: "now", body_md: "Owner unavailable" });
    expect(sent.message).toMatchObject({ to_agent_id: null, to_member_id: null });
    expect(sent.message.metadata.responsibility_unresolved).toContainEqual({ issueId: f.child.id, reason: "leader_missing" });
  });

  it("reports an archived or foreign Agent as unavailable instead of executing", () => {
    const { store } = fixture();
    const f = tree(store);
    store.archiveAgent(f.worker.id);
    expect(store.resolveIssueResponsibility(f.child.id)).toMatchObject({ executionOwner: null,
      unresolved: [{ issueId: f.child.id, reason: "agent_unavailable" }] });
    store.restoreAgent(f.worker.id);
    const unassigned = store.createIssue({ title: "Unassigned", parentIssueId: f.root.id });
    expect(store.resolveIssueResponsibility(unassigned.id)).toMatchObject({ executionOwner: null,
      unresolved: [{ issueId: unassigned.id, reason: "execution_owner_missing" }],
      chain: [{ issueId: unassigned.id, executionOwner: null }, { issueId: f.root.id, executionOwner: { id: f.owner.id } }] });
  });
});
