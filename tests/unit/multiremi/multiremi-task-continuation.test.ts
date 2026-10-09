import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody, taskRequestPath, sentTask, mutateExecutionFixture } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  const squad = store.createSquad({ name: "Delivery", leaderId: leader.id, memberIds: [worker.id, otherWorker.id] });
  const issue = createResponsibleTestIssue(store, { title: "Continue delegated work", assigneeType: "squad", assigneeId: squad.id });
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
    delegatedFromIssueSessionId:session.id,
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  return { store, app, leader, otherLeader, worker, otherWorker, privateWorker, squad, issue, session, leaderTask, delegated };
}

async function taskHeaders(f: ReturnType<typeof fixture>, task = f.leaderTask, owner = "leader_user") {
  const credential = await f.store.createTaskAccessToken(task, owner);
  return { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
}

function completeInitialDelegation(f: ReturnType<typeof fixture>) {
  const runtime = f.store.registerRuntime({
    id: "rt_task_continuation",
    name: "Task continuation",
    provider: "claude",
    maxConcurrency: 6,
    metadata: { parallel_agent_execution: 1, cli_version: "0.2.66" },
  });
  const now = new Date().toISOString();
  mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET status = 'running', runtime_id = ?, dispatched_at = ?, started_at = ? WHERE id = ?", [runtime.id, now, now, f.leaderTask.id]);
  mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET status = 'dispatched', runtime_id = ?, dispatched_at = ? WHERE id = ?", [runtime.id, now, f.delegated.id]);
  f.store.buildTaskSessionProjection(f.delegated.id);
  f.store.startTask(f.delegated.id);
  f.store.completeTask(f.delegated.id, {
    output: "Initial delegated round complete.",
    sessionId: "provider_continuation",
    workDir: "/tmp/task-continuation",
  });
  return runtime;
}

async function createContinuation(f: ReturnType<typeof fixture>, prompt: string) {
  const response = await f.app.request(taskRequestPath(f.store, { issueId:f.issue.id }), {
    method: "POST",
    headers: await taskHeaders(f),
    body: JSON.stringify(requestMessageBody(f.store, {
      agentId: f.worker.id,
      prompt,
      continueTaskId: f.delegated.id,
    })),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { turn_id: string };
  return { response: body, task: f.store.getTask(sentTask(f.store, body).id)! };
}

async function createIndependentTask(f: ReturnType<typeof fixture>, prompt: string) {
  const response = await f.app.request(taskRequestPath(f.store, { issueId: f.issue.id }), {
    method: "POST",
    headers: await taskHeaders(f),
    body: JSON.stringify(requestMessageBody(f.store, { agentId: f.worker.id, issueId: f.issue.id, prompt })),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { turn_id: string };
  return f.store.getTask(sentTask(f.store, body).id)!;
}

// #3/#7/#9: continuation is another credentialed request on the original
// conversation. Pending/running inputs merge; provenance belongs to the header.
describe("delegated conversation continuation",()=>{
  it("merges pending inputs without trusting legacy continuation or delegation fields",async()=>{
    const f=fixture();
    const response=await f.app.request(taskRequestPath(f.store,{issueId:f.issue.id}),{method:"POST",headers:await taskHeaders(f),body:JSON.stringify(requestMessageBody(f.store,{agentId:f.worker.id,prompt:"Review feedback",continue_task_id:f.delegated.id,continuedFromTaskId:"tsk_forged",delegationId:"dlg_forged",delegatedByAgentId:f.otherLeader.id,parentTaskId:f.delegated.id}))});
    expect(response.status).toBe(200);
    const result=await response.json();
    expect(sentTask(f.store,result).id).toBe(f.delegated.id);
    expect(result.message.task_id).toBe(f.store.getTurnForAttempt(f.leaderTask.id)!.id);
    expect(f.store.getTurnForAttempt(f.delegated.id)).toMatchObject({delegated_by_agent_id:f.leader.id,execution_scope:"dlg_continue"});
    expect(JSON.stringify(f.store.getTurnForAttempt(f.delegated.id))).not.toContain("dlg_forged");
  });

  it("merges a rich mention and a request in the same pending lane",async()=>{
    const f=fixture();completeInitialDelegation(f);
    const comment=f.store.createIssueComment(f.issue.id,{issueSessionId:f.session.id,authorType:"agent",authorId:f.leader.id,taskId:f.leaderTask.id,body:`Now inspect [@Worker](mention://agent/${f.worker.id})`});
    const continued=await createContinuation(f,"Continue original implementation");
    const turn=f.store.getTurnForAttempt(continued.task.id)!;
    expect(turn.execution_scope).toBe("dlg_continue");
    const pending=f.store.listTurns({workspace_id:"local",issue_id:f.issue.id,agent_id:f.worker.id,status:"pending"});
    expect(pending.map(turn=>turn.id)).toEqual([turn.id]);
    expect(f.store.getMessage(comment.id)?.metadata.execution_scope).toBe(turn.execution_scope);
    const input=f.store.buildTaskSessionProjection(continued.task.id)!.jsonl;
    expect(input).toContain("Now inspect");expect(input).toContain("Continue original implementation");
  });

  it("interrupts the current lane without creating another attempt",async()=>{
    const f=fixture(),runtime=completeInitialDelegation(f);
    const continued=await createContinuation(f,"Fix review feedback");
    expect(f.store.claimTask(runtime.id)?.id).toBe(continued.task.id);
    f.store.startTask(continued.task.id);
    const before=f.store.listTasks().length;
    const amended=await createContinuation(f,"Also test failure");
    expect(amended.task.id).toBe(continued.task.id);
    expect(f.store.listTasks()).toHaveLength(before);
    expect(f.store.getTask(continued.task.id)?.status).toBe("running");
  });

  it("reuses the same delegated lane for another explicit request",async()=>{
    const f=fixture();completeInitialDelegation(f);
    const continued=await createContinuation(f,"Continue");
    const another=await createIndependentTask(f,"Investigate separately");
    expect(another.id).toBe(continued.task.id);
    expect(another.delegationId).toBe("dlg_continue");
  });

  it("keeps the turn and delegation scope when an infrastructure retry replaces the attempt",async()=>{
    const f=fixture(),runtime=completeInitialDelegation(f);
    const continued=await createContinuation(f,"Retry safely");
    expect(f.store.claimTask(runtime.id)?.id).toBe(continued.task.id);
    f.store.startTask(continued.task.id);
    const before=f.store.getTurnForAttempt(continued.task.id)!;
    f.store.failTask(continued.task.id,{error:"offline",failureReason:"runtime_offline"});
    const retry=f.store.getTurn(before.id)!;
    expect(retry.id).toBe(before.id);expect(retry.current_attempt_id).not.toBe(continued.task.id);
    expect(retry.execution_scope).toBe(before.execution_scope);
    expect(retry.delegated_by_agent_id).toBe(f.leader.id);
  });

  it("preserves private recipient and cross-workspace authorization for continuation requests",async()=>{
    const f=fixture();
    const headers=await taskHeaders(f);
    const request=(agentId:string)=>f.app.request(taskRequestPath(f.store,{issueId:f.issue.id}),{method:"POST",headers,body:JSON.stringify(requestMessageBody(f.store,{agentId,prompt:"Continue",continueTaskId:f.delegated.id}))});
    const before=f.store.listTasks().length;
    expect((await request(f.privateWorker.id)).status).toBe(403);
    const ws=f.store.createWorkspace({name:"Remote"}),remote=f.store.createAgent({name:"Remote worker",provider:"claude",workspaceId:ws.id});
    expect((await request(remote.id)).status).toBe(400);
    expect(f.store.listTasks()).toHaveLength(before);
  });
});
