import { createResponsibleTestIssue } from './helpers.js';
import { issueMessagesPath, requestMessageBody } from "./unified-test-paths.js";
/**
 * MUL-409 fix round 4 (QA round 3, blocker 3): every native and compatibility
 * route that can reach a dependency error must answer with the error contract
 * (a 4xx and a machine-readable `code`), never a bare 500.
 *
 * The round-3 report found the native `PATCH /api/multiremi/issues/:id` letting
 * `IssueDependencyError` escape. This suite walks the whole surface — status
 * writes, assignment, batch, creation and both dependency routes — through the
 * real HTTP app, so a future route that forgets the mapping fails here.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

type Store = ReturnType<typeof createStore>;

function storeWithAgent(name = "Map") {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: `rt_${name}`, name, provider: "claude", maxConcurrency: 4 });
  const agent = store.createAgent({ name, provider: "claude", runtimeId: runtime.id });
  return { store, runtime, agent };
}

/** A parked dependent, its open prerequisite, and a second independent issue. */
function parked() {
  const { store, runtime, agent } = storeWithAgent("errormap");
  const prereq = createResponsibleTestIssue(store, { title: "Prerequisite", status: "in_progress" });
  const dependent = createResponsibleTestIssue(store, {
    title: "Waiting",
    status: "backlog",
    blockedBy: [prereq.id],
    assigneeType: "agent",
    assigneeId: agent.id,
  });
  const other = createResponsibleTestIssue(store, { title: "Other", status: "in_progress" });
  return { store, runtime, agent, prereq, dependent, other };
}

interface Call { label: string; path: string; method: string; body?: unknown; headers?: Record<string, string> }

describe("MUL-400 E3 — fix round 4: dependency errors never surface as 500", () => {
  it("#2-C2: member requests force-start, agent requests downgrade and direct status remains gated", async () => {
    for (const identity of ["agent", "member session", "member direct"]) {
      const { store, agent, dependent, prereq } = parked();
      const requester = store.createAgent({name: "Other requester", provider: "claude"});
      const sourceIssue = createResponsibleTestIssue(store, {title: "Source work"});
      const source = store.createTask({agentId: requester.id, issueId: sourceIssue.id, prompt: "Request delegated work"});
      const credential = await store.createTaskAccessToken(store.getTask(source.id)!, "local");
      const app = createMultiremiApp({ store });
      const session = store.getOrCreateDefaultIssueSession(dependent.id);
      const path = identity === "member session" ? `/api/sessions/${session.id}/messages` : issueMessagesPath(store, dependent.id);
      const input = identity === "member session" ? { agent_id: agent.id, prompt: "start" }
        : { agentId: agent.id, issueId: dependent.id, prompt: "start" };
      const response = await app.request(path, {
        method: "POST", headers: { "content-type": "application/json", ...(identity === "agent" ? { Authorization: `Bearer ${credential.token}` } : {}) },
        body: JSON.stringify(requestMessageBody(store, input)),
      });
      const payload = await response.json();
      if(identity === "agent") {
        // #2: agent requests remain recorded and downgrade to next_turn.
        expect(response.status).toBe(200);expect(payload).toMatchObject({wake_applied:"next_turn",wake_reason:"dependencies_unmet"});expect(payload.turn_id).toBeUndefined();
        expect(store.getIssue(dependent.id)?.status).toBe("backlog");
        expect(store.listTasksForIssue(dependent.id)).toEqual([]);
        expect(store.listIssueActivity(dependent.id).filter(row => row.type === "dependency_force_started")).toEqual([]);
      } else {
        expect(response.status).toBe(200);
        expect(payload).toMatchObject({ wake_applied: "now", wake_reason: "human_sender" });
        const tasks = store.listTasksForIssue(dependent.id);
        expect(tasks).toHaveLength(1);
        expect(store.getIssue(dependent.id)?.status).toBe("todo");
        const audit = store.listIssueActivity(dependent.id).filter(row => row.type === "dependency_force_started");
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actorType: "member", actorId: "local" });
        expect(audit[0]!.data).toMatchObject({ source: "comment", taskId: tasks[0]!.id, unmet: [{ key: prereq.key }] });
      }
    }
    const { store, dependent, prereq } = parked();
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/issues/${dependent.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "todo" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "dependencies_unmet", unmet: [{ key: prereq.key }] });
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    expect(store.listTasksForIssue(dependent.id)).toEqual([]);
  });
  it("maps every waiting-issue entry point to 4xx with a code", async () => {
    const { store, agent, prereq, dependent, other } = parked();
    const requester = store.createAgent({name: "Other requester", provider: "claude"});
    const sourceIssue = createResponsibleTestIssue(store, {title: "Source work"});
    const source = store.createTask({agentId: requester.id, issueId: sourceIssue.id, prompt: "Request delegated work"});
    const credential = await store.createTaskAccessToken(store.getTask(source.id)!, "local");
    const app = createMultiremiApp({ store });
    const session = store.getOrCreateDefaultIssueSession(dependent.id);

    const calls: Call[] = [
      // The blocker: both PATCH routes on a waiting issue.
      { label: "native PATCH status", path: `/api/multiremi/issues/${dependent.id}`, method: "PATCH", body: { status: "todo" } },
      { label: "compat PATCH status", path: `/api/issues/${dependent.id}`, method: "PATCH", body: { status: "todo" } },
      { label: "compat PUT status", path: `/api/issues/${dependent.id}`, method: "PUT", body: { status: "todo" } },
      // Assignment does not throw, but must not dispatch or 5xx either.
      { label: "native assign", path: `/api/multiremi/issues/${dependent.id}/assign`, method: "POST", body: { assigneeType: "agent", assigneeId: agent.id } },
      { label: "rerun", path: issueMessagesPath(store, dependent.id), method: "POST", body: { agent_id: agent.id, prompt: "Continue Issue work" }, headers: { Authorization: `Bearer ${credential.token}` } },
      // Batch reports per-row skips rather than failing the whole request.
      { label: "native batch", path: "/api/multiremi/issues/batch-update", method: "POST", body: { issueIds: [dependent.id], updates: { status: "todo" } } },
      { label: "compat batch", path: "/api/issues/batch-update", method: "POST", body: { issue_ids: [dependent.id], updates: { status: "todo" } } },
      // Dependency writes: a real CYCLE (the dependent already waits on the
      // prerequisite, so making the prerequisite wait on the dependent closes a
      // loop), an unknown target, and an ancestor.
      { label: "native dependency cycle", path: `/api/multiremi/issues/${prereq.id}/dependencies`, method: "POST", body: { dependsOnIssueId: dependent.id, type: "blocked_by" } },
      { label: "compat dependency cycle", path: `/api/issues/${prereq.id}/dependencies`, method: "POST", body: { depends_on_issue_id: dependent.id, type: "blocked_by" } },
      { label: "native dependency unknown target", path: `/api/multiremi/issues/${other.id}/dependencies`, method: "POST", body: { dependsOnIssueId: "iss_does_not_exist", type: "blocked_by" } },
      { label: "compat dependency unknown target", path: `/api/issues/${other.id}/dependencies`, method: "POST", body: { depends_on_issue_id: "iss_does_not_exist", type: "blocked_by" } },
      { label: "native dependency delete unknown", path: `/api/multiremi/issues/${dependent.id}/dependencies/dep_missing`, method: "DELETE" },
      { label: "compat dependency delete unknown", path: `/api/issues/${dependent.id}/dependencies/dep_missing`, method: "DELETE" },
      // Issue creation with a rejected blocked_by.
      { label: "native create ancestor", path: "/api/multiremi/issues", method: "POST", body: { title: "child", parent_issue_id: dependent.id, blocked_by: [dependent.id] } },
      { label: "compat create ancestor", path: "/api/issues", method: "POST", body: { title: "child", parent_issue_id: dependent.id, blocked_by: [dependent.id] } },
      { label: "compat create unknown prereq", path: "/api/issues", method: "POST", body: { title: "child2", blocked_by: ["iss_does_not_exist"] } },
      // #2-C2: member requests run after the gate-refusal cases, so they do not open their gate.
      { label: "task create", path: issueMessagesPath(store, dependent.id), method: "POST", body: { agentId: agent.id, issueId: dependent.id, prompt: "start" } },
      { label: "session task create", path: `/api/sessions/${session.id}/messages`, method: "POST", body: { agent_id: agent.id, prompt: "start" } },
    ] as Call[];

    const rows: Array<{ label: string; status: number; code: string }> = [];
    for (const call of calls) {
      const response = await app.request(call.path, {
        method: call.method,
        headers: { "content-type": "application/json", ...call.headers },
        ...(call.body ? { body: JSON.stringify(call.path.endsWith("/messages") ? requestMessageBody(store, call.body as Record<string, any>) : call.body) } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if(call.label==="rerun") {expect(response.status).toBe(200);expect(payload).toMatchObject({wake_applied:"next_turn",wake_reason:"dependencies_unmet"});expect(payload.turn_id).toBeUndefined();}
      if(call.label === "task create" || call.label === "session task create") {
        expect(response.status).toBe(200);
        expect(payload).toMatchObject({ wake_applied: "now", wake_reason: "human_sender" });
        expect(payload.turn_id).toBeDefined();
      }
      rows.push({ label: call.label, status: response.status, code: payload.code ?? "" });
    }

    // Nothing may be a server fault.
    const serverErrors = rows.filter((row) => row.status >= 500);
    expect(serverErrors).toEqual([]);
    // Every 4xx in this matrix is one of the two refusal families this feature
    // owns, and each answers with its code. The two per-row 400s
    // (`*dependency unknown target`) are the older plain-string refusals the
    // dependency routes already answered that way before this feature; they are
    // asserted exactly so a change of contract shows up here.
    const refusals = rows.filter((row) => row.status >= 400);
    expect(refusals.map((row) => [row.label, row.status, row.code]).sort()).toEqual([
      ["compat PUT status", 409, "dependencies_unmet"],
      ["compat create ancestor", 409, "dependency_on_ancestor"],
      ["compat create unknown prereq", 400, ""],
      ["compat dependency cycle", 409, "dependency_cycle"],
      ["compat dependency unknown target", 400, ""],
      ["compat PATCH status", 409, "dependencies_unmet"],
      ["native PATCH status", 409, "dependencies_unmet"],
      ["native create ancestor", 409, "dependency_on_ancestor"],
      ["native dependency cycle", 409, "dependency_cycle"],
      ["native dependency unknown target", 400, ""],
    ].sort());
    // And the ones this round fixed specifically name the dependency hold.
    for (const label of ["native PATCH status", "compat PATCH status", "compat PUT status"]) {
      const row = rows.find((entry) => entry.label === label)!;
      expect({ label, status: row.status, code: row.code }).toEqual({ label, status: 409, code: "dependencies_unmet" });
    }
    expect(store.getIssue(dependent.id)?.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(1);
    const audits = store.listIssueActivity(dependent.id).filter(row => row.type === "dependency_force_started");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "member", actorId: "local" });
    expect(audits[0]!.data).toMatchObject({ source: "comment", agentId: agent.id, assigneeDispatched: true });
  });

  it("still leaves the waiting issue parked after every refusal above", async () => {
    const { store, agent, dependent } = parked();
    const app = createMultiremiApp({ store });
    for (const call of [
      { path: `/api/multiremi/issues/${dependent.id}`, method: "PATCH", body: { status: "todo" } },
      { path: `/api/issues/${dependent.id}`, method: "PATCH", body: { status: "todo" } },
      { path: "/api/multiremi/issues/batch-update", method: "POST", body: { issueIds: [dependent.id], updates: { status: "todo" } } },
      { path: "/api/issues/batch-update", method: "POST", body: { issue_ids: [dependent.id], updates: { status: "todo" } } },
    ]) {
      await app.request(call.path, {
        method: call.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call.path.endsWith("/messages") ? requestMessageBody(store, call.body as Record<string, any>) : call.body),
      });
    }
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    // Every task row, including cancelled ones.
    expect(store.listTasksForIssue(dependent.id)).toEqual([]);
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
    expect(store.listIssueActivity(dependent.id).filter((entry) => entry.type === "dependency_force_started")).toEqual([]);
    void agent;
  });
});
