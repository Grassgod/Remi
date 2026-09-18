import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.createWorkspaceMember({ id: "leader_user", userId: "leader_user", name: "Leader owner", role: "member" });
  store.createWorkspaceMember({ id: "other_user", userId: "other_user", name: "Other owner", role: "member" });
  const leader = store.createAgent({ name: "Leader", provider: "claude", ownerId: "leader_user" });
  const otherLeader = store.createAgent({ name: "Other leader", provider: "claude", ownerId: "other_user" });
  const worker = store.createAgent({ name: "Worker", provider: "claude", visibility: "workspace" });
  const otherWorker = store.createAgent({ name: "Other worker", provider: "claude", visibility: "workspace" });
  const privateWorker = store.createAgent({
    name: "Private worker",
    provider: "claude",
    ownerId: "other_user",
    visibility: "private",
  });
  const issue = store.createIssue({ title: "Continue delegated work" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const leaderTask = store.createTask({
    agentId: leader.id,
    issueId: issue.id,
    issueSessionId: session.id,
    prompt: "Coordinate.",
  });
  const delegated = store.createTask({
    agentId: worker.id,
    issueId: issue.id,
    issueSessionId: session.id,
    prompt: "Implement.",
    delegationId: "dlg_continue",
    delegatedByAgentId: leader.id,
    parentTaskId: leaderTask.id,
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  return { store, app, leader, otherLeader, worker, otherWorker, privateWorker, issue, session, leaderTask, delegated };
}

async function taskHeaders(f: ReturnType<typeof fixture>, task = f.leaderTask, owner = "leader_user") {
  const credential = await f.store.createTaskAccessToken(task, owner);
  return { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
}

describe("delegated task continuation API", () => {
  it("creates a distinct task while deriving the existing delegation lineage", async () => {
    const f = fixture();
    const response = await f.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: await taskHeaders(f),
      body: JSON.stringify({
        agentId: f.worker.id,
        prompt: "Address the review feedback.",
        continue_task_id: f.delegated.id,
        delegationId: "dlg_forged",
        delegatedByAgentId: f.otherLeader.id,
        parentTaskId: f.delegated.id,
      }),
    });

    expect(response.status).toBe(201);
    const createdId = ((await response.json()) as { task: { id: string } }).task.id;
    expect(createdId).not.toBe(f.delegated.id);
    expect(f.store.getTask(createdId)).toMatchObject({
      agentId: f.worker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      parentTaskId: f.leaderTask.id,
      delegationId: f.delegated.delegationId,
      delegatedByAgentId: f.leader.id,
      prompt: "Address the review feedback.",
    });
  });

  it("rejects missing, cross-context, mismatched and unauthorized continuation targets", async () => {
    const f = fixture();
    const headers = await taskHeaders(f);
    const request = (body: Record<string, unknown>, overrideHeaders = headers) => f.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: overrideHeaders,
      body: JSON.stringify({ agentId: f.worker.id, prompt: "Continue.", ...body }),
    });
    const expectError = async (response: Response, status: number, message: string) => {
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: string }).error).toContain(message);
    };

    await expectError(await request({ continueTaskId: "tsk_missing" }), 404, "continued task not found");
    await expectError(await request({ continueTaskId: f.delegated.id, agentId: f.otherWorker.id }), 400, "target agent");

    const direct = f.store.createTask({
      agentId: f.worker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      prompt: "Direct.",
    });
    await expectError(await request({ continueTaskId: direct.id }), 400, "not a delegated task");

    const wrongDelegator = f.store.createTask({
      agentId: f.worker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      prompt: "Other lineage.",
      delegationId: "dlg_other_leader",
      delegatedByAgentId: f.otherLeader.id,
    });
    await expectError(await request({ continueTaskId: wrongDelegator.id }), 403, "another agent");

    const sibling = f.store.createIssueSession(f.issue.id, { title: "Sibling main Session" });
    const siblingLeaderTask = f.store.createTask({
      agentId: f.leader.id,
      issueId: f.issue.id,
      issueSessionId: sibling.id,
      prompt: "Coordinate sibling.",
    });
    const siblingHeaders = await taskHeaders(f, siblingLeaderTask);
    await expectError(await request({ continueTaskId: f.delegated.id }, siblingHeaders), 400, "another Issue Session");
    await expectError(await request({ continueTaskId: f.delegated.id, issueSessionId: sibling.id }), 400, "requested Issue Session");

    const privateDelegation = f.store.createTask({
      agentId: f.privateWorker.id,
      issueId: f.issue.id,
      issueSessionId: f.session.id,
      prompt: "Private.",
      delegationId: "dlg_private",
      delegatedByAgentId: f.leader.id,
    });
    await expectError(await request({
      continueTaskId: privateDelegation.id,
      agentId: f.privateWorker.id,
    }), 403, "do not have access");

    const remoteWorkspace = f.store.createWorkspace({ id: "ws_remote", name: "Remote", slug: "remote" });
    const remoteLeader = f.store.createAgent({
      name: "Remote leader",
      provider: "claude",
      workspaceId: remoteWorkspace.id,
    });
    const remoteWorker = f.store.createAgent({
      name: "Remote worker",
      provider: "claude",
      workspaceId: remoteWorkspace.id,
    });
    const remoteIssue = f.store.createIssue({ title: "Remote issue", workspaceId: remoteWorkspace.id });
    const remoteDelegation = f.store.createTask({
      agentId: remoteWorker.id,
      issueId: remoteIssue.id,
      prompt: "Remote delegated work.",
      delegationId: "dlg_remote",
      delegatedByAgentId: remoteLeader.id,
    });
    await expectError(await request({
      continueTaskId: remoteDelegation.id,
      agentId: remoteWorker.id,
    }), 403, "another workspace");

    await expectError(await request(
      { continueTaskId: f.delegated.id },
      { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
    ), 403, "requires a task credential");
  });
});
