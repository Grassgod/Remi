import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { IssueResponsibilityError } from "@multiremi/store/issue-responsibility.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { createResponsibleTestIssue, testWorkspaceMember } from "./helpers.js";

/**
 * The done rule (replaces formal delivery acceptance and the parent-done grant):
 * a member closes any Issue; an Agent closes only a direct child of an Issue it
 * executes, never an Issue it executes itself and never a root. PATCH, the
 * compatibility PATCH/PUT and both batch routes share it. Guard A still applies.
 */
const previousGuard = process.env.MULTIREMI_PARENT_STATUS_GUARD;
afterEach(() => {
  if (previousGuard === undefined) delete process.env.MULTIREMI_PARENT_STATUS_GUARD;
  else process.env.MULTIREMI_PARENT_STATUS_GUARD = previousGuard;
});

function refusal(action: () => unknown): IssueResponsibilityError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(IssueResponsibilityError);
    return error as IssueResponsibilityError;
  }
  throw new Error("expected the done rule to refuse");
}

pendingTurnBackendTests("Issue done rule", fixture => {
  function family(store: MultiremiStore, label: string) {
    const parentOwner = store.createAgent({ name: `${label} parent owner`, provider: "codex" });
    const childOwner = store.createAgent({ name: `${label} child owner`, provider: "codex" });
    const outsider = store.createAgent({ name: `${label} outsider`, provider: "codex" });
    const root = createResponsibleTestIssue(store, { title: `${label} root`, status: "in_progress", assigneeType: "agent", assigneeId: parentOwner.id });
    const child = createResponsibleTestIssue(store, { title: `${label} child`, parentIssueId: root.id, status: "in_progress", assigneeType: "agent", assigneeId: childOwner.id });
    return { parentOwner, childOwner, outsider, root, child, member: testWorkspaceMember(store, root.workspaceId) };
  }

  it("lets a member close any Issue and an Agent only a direct child of an Issue it executes", () => {
    const { store } = fixture();
    const f = family(store, "Store");
    const grandchild = createResponsibleTestIssue(store, { title: "Store grandchild", parentIssueId: f.child.id, status: "in_progress" });
    const agentDone = (issueId: string, actorId: string) => () => store.updateIssue(issueId, { status: "done", actorType: "agent", actorId });

    expect(refusal(agentDone(f.root.id, f.parentOwner.id))).toMatchObject({ code: "issue_done_requires_member", status: 403 });
    expect(refusal(agentDone(f.child.id, f.childOwner.id))).toMatchObject({ code: "issue_done_requires_parent_owner", status: 403 });
    expect(refusal(agentDone(f.child.id, f.outsider.id))).toMatchObject({ code: "issue_done_requires_parent_owner", status: 403 });
    // Only the direct parent counts: the root's owner cannot close a grandchild.
    expect(refusal(agentDone(grandchild.id, f.parentOwner.id))).toMatchObject({ code: "issue_done_requires_parent_owner" });
    expect(store.getIssue(grandchild.id)?.status).toBe("in_progress");
    expect(store.updateIssue(grandchild.id, { status: "done", actorType: "agent", actorId: f.childOwner.id }).status).toBe("done");
    expect(store.updateIssue(f.child.id, { status: "done", actorType: "agent", actorId: f.parentOwner.id }).status).toBe("done");
    // Members (and unattributed server writes) close anything, roots included.
    expect(store.updateIssue(f.root.id, { status: "done", actorType: "member", actorId: f.member.id }).status).toBe("done");
    const plain = createResponsibleTestIssue(store, { title: "Unassigned root", status: "todo" });
    expect(store.updateIssue(plain.id, { status: "done" }).status).toBe("done");
  });

  it("lets the Leader of a parent's team close its direct child, and refuses an archived owner", () => {
    const { store } = fixture();
    const leader = store.createAgent({ name: "Team leader", provider: "codex" });
    const team = store.createSquad({ name: "Done rule team", leaderId: leader.id });
    const worker = store.createAgent({ name: "Team child owner", provider: "codex" });
    const root = createResponsibleTestIssue(store, { title: "Team root", status: "in_progress", assigneeType: "squad", assigneeId: team.id });
    const child = createResponsibleTestIssue(store, { title: "Team child", parentIssueId: root.id, status: "in_progress", assigneeType: "agent", assigneeId: worker.id });
    const other = createResponsibleTestIssue(store, { title: "Second team child", parentIssueId: root.id, status: "in_progress", assigneeType: "agent", assigneeId: worker.id });
    expect(store.updateIssue(child.id, { status: "done", actorType: "agent", actorId: leader.id }).status).toBe("done");
    store.archiveAgent(leader.id);
    expect(refusal(() => store.updateIssue(other.id, { status: "done", actorType: "agent", actorId: leader.id })).code).toBe("issue_done_requires_parent_owner");
  });

  it("keeps guard A after the done rule: open children hold the close, and force stays member-only", async () => {
    const { store } = fixture();
    const f = family(store, "Guard");
    createResponsibleTestIssue(store, { title: "Guard open grandchild", parentIssueId: f.child.id, status: "in_progress" });
    const held = (() => { try { store.updateIssue(f.child.id, { status: "done", actorType: "agent", actorId: f.parentOwner.id }); } catch (error) { return error as Error & { code?: string }; } })();
    expect(held?.code).toBe("issue_status_held");
    const task = store.createTask({ agentId: f.parentOwner.id, issueId: f.root.id, prompt: "Close the child" });
    const token = (await store.createTaskAccessToken(task, "local")).token;
    const app = createMultiremiApp({ store });
    const forced = await app.request(`/api/issues/${f.child.id}`, { method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ status: "done", force: true }) });
    expect(forced.status).toBe(403);
    expect(await forced.json()).toMatchObject({ code: "issue_force_requires_member" });
    expect(store.updateIssue(f.child.id, { status: "done", force: true, actorType: "member", actorId: f.member.id }).status).toBe("done");
  });

  it("applies the same rule on PATCH, the compatibility PATCH and PUT, and both batch routes", async () => {
    const { store } = fixture();
    const app = createMultiremiApp({ store });
    const routes = [
      { label: "native PATCH", request: (id: string) => ({ path: `/api/multiremi/issues/${id}`, method: "PATCH", body: { status: "done" } }) },
      { label: "compat PATCH", request: (id: string) => ({ path: `/api/issues/${id}`, method: "PATCH", body: { status: "done" } }) },
      { label: "compat PUT", request: (id: string) => ({ path: `/api/issues/${id}`, method: "PUT", body: { status: "done" } }) },
      { label: "native batch", request: (id: string) => ({ path: "/api/multiremi/issues/batch-update", method: "POST", body: { issue_ids: [id], updates: { status: "done" } } }) },
      { label: "compat batch", request: (id: string) => ({ path: "/api/issues/batch-update", method: "POST", body: { issue_ids: [id], updates: { status: "done" } } }) },
    ];
    for (const route of routes) {
      const f = family(store, route.label);
      const tokenFor = async (agentId: string, issueId: string) =>
        (await store.createTaskAccessToken(store.createTask({ agentId, issueId, prompt: `${route.label} round` }), "local")).token;
      const send = async (token: string, id: string) => {
        const { path, method, body } = route.request(id);
        const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const own = await send(await tokenFor(f.childOwner.id, f.child.id), f.child.id);
      expect(own, route.label).toMatchObject({ status: 403, body: { code: "issue_done_requires_parent_owner" } });
      const ownerToken = await tokenFor(f.parentOwner.id, f.root.id);
      const rootClose = await send(ownerToken, f.root.id);
      expect(rootClose, route.label).toMatchObject({ status: 403, body: { code: "issue_done_requires_member" } });
      expect(store.getIssue(f.child.id)?.status, route.label).not.toBe("done");
      expect((await send(ownerToken, f.child.id)).status, route.label).toBe(200);
      expect(store.getIssue(f.child.id)?.status, route.label).toBe("done");
      // The member path, unauthenticated local member, closes the root.
      const { path, method, body } = route.request(f.root.id);
      const member = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(member.status, route.label).toBe(200);
      expect(store.getIssue(f.root.id)?.status, route.label).toBe("done");
    }
  });

  it("rolls the whole batch back on one refusal instead of reporting updated: 0, with the guard switch off too", async () => {
    for (const guard of ["on", "off"] as const) {
      if (guard === "off") process.env.MULTIREMI_PARENT_STATUS_GUARD = "off";
      else delete process.env.MULTIREMI_PARENT_STATUS_GUARD;
      const { store } = fixture();
      const f = family(store, `Batch ${guard}`);
      const sibling = createResponsibleTestIssue(store, { title: `Batch ${guard} sibling`, parentIssueId: f.root.id, status: "in_progress", assigneeType: "agent", assigneeId: f.parentOwner.id });
      const app = createMultiremiApp({ store });
      const token = (await store.createTaskAccessToken(store.createTask({ agentId: f.parentOwner.id, issueId: f.root.id, prompt: "Batch round" }), "local")).token;
      for (const path of ["/api/multiremi/issues/batch-update", "/api/issues/batch-update"]) {
        // The child is closable; the sibling is the caller's own Issue.
        const response = await app.request(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ issue_ids: [f.child.id, sibling.id], updates: { status: "done" } }) });
        expect(response.status, `${guard} ${path}`).toBe(403);
        const body = await response.json() as Record<string, unknown>;
        expect(body, `${guard} ${path}`).toMatchObject({ code: "issue_done_requires_parent_owner" });
        expect(body, `${guard} ${path}`).not.toHaveProperty("updated");
        expect(store.getIssue(f.child.id)?.status, `${guard} ${path}`).toBe("in_progress");
        expect(store.getIssue(sibling.id)?.status, `${guard} ${path}`).toBe("in_progress");
      }
    }
  });

  it("checks the parent at write time: it is a process guard, so a move first is allowed and stays on the record", async () => {
    const { store } = fixture();
    const f = family(store, "Move first");
    const other = createResponsibleTestIssue(store, { title: "Move first other root", status: "in_progress", assigneeType: "agent", assigneeId: f.outsider.id });
    const app = createMultiremiApp({ store });
    const token = (await store.createTaskAccessToken(store.createTask({ agentId: f.parentOwner.id, issueId: f.root.id, prompt: "Move first round" }), "local")).token;
    const patch = async (body: Record<string, unknown>) => {
      const response = await app.request(`/api/issues/${other.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    // One request is checked against the parent the Issue has now.
    expect(await patch({ parent_issue_id: f.root.id, status: "done" })).toMatchObject({ status: 403, body: { code: "issue_done_requires_member" } });
    expect(store.getIssue(other.id)).toMatchObject({ parentIssueId: null, status: "in_progress" });
    // Moving work needs no member (ADR 0017); after the move the caller is the direct parent's owner.
    expect((await patch({ parent_issue_id: f.root.id })).status).toBe(200);
    expect((await patch({ status: "done" })).status).toBe(200);
    expect(store.getIssue(other.id)).toMatchObject({ parentIssueId: f.root.id, status: "done" });
    const updates = store.listIssueActivity(other.id).filter(entry => entry.type === "issue_updated" && (entry.data as Record<string, unknown> | null)?.actorId === f.parentOwner.id);
    expect(updates.map(entry => Object.keys((entry.data as { previous?: object }).previous ?? {}))).toEqual([["parent_issue_id"], ["status"]]);
  });

  it("refuses to create an Issue already done, on the store and over HTTP", async () => {
    const { store } = fixture();
    expect(refusal(() => store.createIssue({ title: "Born done", status: "done" }))).toMatchObject({ code: "issue_create_done_unsupported", status: 409 });
    const app = createMultiremiApp({ store });
    for (const path of ["/api/issues", "/api/multiremi/issues"]) {
      const response = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Born done", status: "done" }) });
      expect(response.status, path).toBe(409);
      expect(await response.json(), path).toMatchObject({ code: "issue_create_done_unsupported" });
    }
    expect(store.listIssues({ workspaceId: "local" }).filter(issue => issue.title === "Born done")).toEqual([]);
  });
});
