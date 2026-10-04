import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiAgent, MultiremiIssue, MultiremiRuntime, MultiremiTask } from "@multiremi/contracts/types.js";
import { createLocalStore, createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { HUMAN_COMMENT_JOINS_QUEUED_ROUND } from "@multiremi/store/repos/issues-repo.js";
import { inboxReportBody, inboxReportEntry } from "./inbox-test-assertions.js";

const FEISHU_APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
let previousFeishuEncryptionKey: string | undefined;

beforeEach(() => {
  previousFeishuEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  if (previousFeishuEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousFeishuEncryptionKey;
  resetMultiremiTestEnv();
});

interface DelegationFixture {
  store: MultiremiStore;
  leaderRuntime: MultiremiRuntime;
  qaRuntime: MultiremiRuntime;
  leader: MultiremiAgent;
  qa: MultiremiAgent;
  issue: MultiremiIssue;
  leaderTask: MultiremiTask;
  childTask: MultiremiTask;
}

interface FanoutFixture {
  store: MultiremiStore;
  leaderRuntime: MultiremiRuntime;
  firstRuntime: MultiremiRuntime;
  secondRuntime: MultiremiRuntime;
  leader: MultiremiAgent;
  first: MultiremiAgent;
  second: MultiremiAgent;
  issue: MultiremiIssue;
  leaderTask: MultiremiTask;
  firstTask: MultiremiTask;
  secondTask: MultiremiTask;
  chatSessionId: string | null;
}

function createDelegationFixture(): DelegationFixture {
  const store = createStore();
  const leaderRuntime = store.registerRuntime({
    id: "rt_delegation_leader",
    name: "Leader runtime",
    provider: "claude",
    workspaceId: "local",
  });
  const qaRuntime = store.registerRuntime({
    id: "rt_delegation_qa",
    name: "QA runtime",
    provider: "claude",
    workspaceId: "local",
  });
  const leader = store.createAgent({
    name: "Leader",
    provider: "claude",
    runtimeId: leaderRuntime.id,
  });
  const qa = store.createAgent({
    name: "QA",
    provider: "claude",
    runtimeId: qaRuntime.id,
  });
  const squad = store.createSquad({
    name: "Delivery Squad",
    leaderId: leader.id,
    memberIds: [qa.id],
  });
  const issue = store.createIssue({
    title: "Delegated verification",
    assigneeType: "squad",
    assigneeId: squad.id,
  });
  const leaderTask = store.createTask({
    agentId: leader.id,
    issueId: issue.id,
    prompt: "Lead the implementation.",
  });
  expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
  store.buildTaskSessionProjection(leaderTask.id);
  store.startTask(leaderTask.id);

  store.createIssueComment(issue.id, {
    authorType: "agent",
    authorId: leader.id,
    taskId: leaderTask.id,
    body: `Please verify the change [@QA](mention://agent/${qa.id})`,
  });
  const childTask = store.listTasksForIssue(issue.id).find((task) => task.agentId === qa.id)!;
  expect(childTask).toMatchObject({
    delegatedByAgentId: leader.id,
    status: "queued",
  });
  expect(childTask.delegationId).toBeTruthy();

  store.completeTask(leaderTask.id, {
    output: "Task completed.",
    sessionId: "leader_session_1",
    workDir: "/tmp/delegation-leader",
  });
  expect(store.claimTask(qaRuntime.id)?.id).toBe(childTask.id);
  store.buildTaskSessionProjection(childTask.id);
  store.startTask(childTask.id);

  return { store, leaderRuntime, qaRuntime, leader, qa, issue, leaderTask, childTask };
}

function delegationTasks(fixture: DelegationFixture): MultiremiTask[] {
  return fixture.store.listTasksForIssue(fixture.issue.id)
    .filter((task) => task.delegationId === fixture.childTask.delegationId);
}

function createFanoutFixture(feishu = false): FanoutFixture {
  const store = feishu ? createLocalStore() : createStore();
  const leaderRuntime = store.registerRuntime({
    id: "rt_fanout_leader",
    name: "Leader runtime",
    provider: "claude",
    workspaceId: "local",
  });
  const firstRuntime = store.registerRuntime({
    id: "rt_fanout_first",
    name: "First runtime",
    provider: "claude",
    workspaceId: "local",
  });
  const secondRuntime = store.registerRuntime({
    id: "rt_fanout_second",
    name: "Second runtime",
    provider: "claude",
    workspaceId: "local",
  });
  const leader = store.createAgent({
    name: "Leader",
    provider: "claude",
    runtimeId: leaderRuntime.id,
  });
  const first = store.createAgent({
    name: "First",
    provider: "claude",
    runtimeId: firstRuntime.id,
  });
  const second = store.createAgent({
    name: "Second",
    provider: "claude",
    runtimeId: secondRuntime.id,
  });
  const squad = store.createSquad({
    name: "Fanout Squad",
    leaderId: leader.id,
    memberIds: [first.id, second.id],
  });

  let chatSessionId: string | null = null;
  if (feishu) {
    const owner = store.getCurrentUser();
    store.getOrCreateUser({
      externalId: "ou_fanout_owner",
      feishuUnionId: "on_fanout_owner",
      email: owner.email,
      name: "Fanout Owner",
    });
    store.heartbeatRuntime(leaderRuntime.id, { supportsFeishuBotConfig: true });
    const config = store.upsertFeishuBotConfig("local", {
      agentId: leader.id,
      runtimeId: leaderRuntime.id,
      appId: "cli_fanout_test",
      appSecretOp: "set",
      appSecret: FEISHU_APP_SECRET,
      domain: "feishu",
      enabled: true,
    });
    store.reportFeishuBotRuntimeStatus("local", leaderRuntime.id, {
      appliedRevision: config.revision,
      state: "online",
    });
    store.updateWorkspace("local", {
      settings: { issueTopics: { enabled: true, chatId: "oc_fanout" } },
    });
  }

  const issue = store.createIssue({
    title: "Fanout delegation",
    assigneeType: "squad",
    assigneeId: squad.id,
  });
  if (feishu) {
    expect(store.prepareFeishuIssueTopicWithinTransaction(issue)).toBe(true);
    const topic = store.claimFeishuBotOutbound("local", leaderRuntime.id)!;
    store.reportFeishuBotOutbound("local", leaderRuntime.id, topic.id, {
      claimToken: topic.claimToken,
      status: "sent",
      externalMessageId: "om_fanout_topic",
    });
    chatSessionId = `chat_issue_topic_${issue.id}`;
    expect(store.getFeishuIssueIdForChatSession(chatSessionId)).toBe(issue.id);
  }
  const leaderTask = store.createTask({
    agentId: leader.id,
    issueId: issue.id,
    prompt: "Lead the fanout.",
  });
  expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
  store.buildTaskSessionProjection(leaderTask.id);
  store.startTask(leaderTask.id);
  store.createIssueComment(issue.id, {
    authorType: "agent",
    authorId: leader.id,
    taskId: leaderTask.id,
    body: `First assignment [@First](mention://agent/${first.id})`,
  });
  store.createIssueComment(issue.id, {
    authorType: "agent",
    authorId: leader.id,
    taskId: leaderTask.id,
    body: `Second assignment [@Second](mention://agent/${second.id})`,
  });
  const childTasks = store.listTasksForIssue(issue.id).filter((task) => task.agentId !== leader.id);
  const firstTask = childTasks.find((task) => task.agentId === first.id)!;
  const secondTask = childTasks.find((task) => task.agentId === second.id)!;
  store.completeTask(leaderTask.id, { output: "Delegated both assignments." });
  expect(store.claimTask(firstRuntime.id)?.id).toBe(firstTask.id);
  store.buildTaskSessionProjection(firstTask.id);
  store.startTask(firstTask.id);
  return {
    store,
    leaderRuntime,
    firstRuntime,
    secondRuntime,
    leader,
    first,
    second,
    issue,
    leaderTask,
    firstTask,
    secondTask,
    chatSessionId,
  };
}

function leaderReturnTasks(fixture: Pick<FanoutFixture, "store" | "issue" | "leader" | "leaderTask">): MultiremiTask[] {
  return fixture.store.listTasksForIssue(fixture.issue.id).filter((task) =>
    task.id !== fixture.leaderTask.id
    && task.agentId === fixture.leader.id
    && task.delegatedByAgentId === fixture.leader.id
  );
}

function countFeishuRoundPushes(): number {
  const row = db!.query("SELECT COUNT(*) AS count FROM multiremi_feishu_bot_round_pushes").get() as {
    count: number;
  };
  return Number(row.count);
}

describe("task-level agent delegation return", () => {
  for (const commented of [false, true]) {
    it(`MUL-498 rings a bounded doorbell pointing to the ${commented ? "agent" : "automatic"} reply`, () => {
      const f = createDelegationFixture();
      try {
        const output = "长过程文字".repeat(25_000);
        const authored = commented ? f.store.createIssueComment(f.issue.id, {
          authorType: "agent", authorId: f.qa.id, taskId: f.childTask.id, body: "结论评论",
        }) : null;
        f.store.completeTask(f.childTask.id, { output });
        const returned = f.store.getTask(f.store.getTask(f.childTask.id)!.delegationReturnTaskId!)!;
        const body = inboxReportBody(f.store, returned, f.childTask.id);
        const id = body.match(/结论评论：(cmt_\w+)/)?.[1];
        expect(id).toBeDefined();
        expect(Buffer.byteLength(body)).toBeLessThan(2_048);
        expect(body).toContain("Status: completed\n");
        expect(body).toContain("QA completed a task you delegated.");
        expect(body).toContain(`remi comment list ${f.issue.id} --thread ${id}`);
        expect(f.store.getIssueComment(id!)?.body).toBe(commented ? "结论评论" : output);
        if (authored) expect(id).toBe(authored.id);
        expect(f.store.getIssue(f.issue.id)?.status).not.toBe("blocked");
        expect(f.store.claimTask(f.leaderRuntime.id)?.id).toBe(returned.id);
      } finally { resetMultiremiTestEnv(); }
    });
  }

  it("keeps completion and a task-result pointer when the automatic comment write fails", () => {
    const f = createDelegationFixture();
    const run = db!.run.bind(db!);
    const failure = spyOn(db!, "run").mockImplementation((sql: string, ...parameters: any[]) => {
      if (sql.includes("INSERT INTO multiremi_issue_comments") && parameters[0]?.[3] === "agent") {
        throw new Error("comment write unavailable");
      }
      return run(sql, ...parameters);
    });
    try {
      f.store.completeTask(f.childTask.id, { output: "final reply" });
      expect(f.store.getTask(f.childTask.id)?.status).toBe("completed");
      const returned = f.store.getTask(f.store.getTask(f.childTask.id)!.delegationReturnTaskId!)!;
      const report = inboxReportBody(f.store, returned, f.childTask.id);
      expect(report).toContain(`结论评论：无；结果见 remi task get ${f.childTask.id}`);
      expect(report).not.toMatch(/结论评论：cmt_/);
    } finally { failure.mockRestore(); resetMultiremiTestEnv(); }
  });

  it("returns every explicit continuation round once", () => {
    const fixture = createDelegationFixture();
    fixture.store.completeTask(fixture.childTask.id, {
      output: "first result",
      sessionId: "qa_session_1",
      workDir: "/tmp/delegation-qa",
    });
    const firstReturnId = fixture.store.getTask(fixture.childTask.id)!.delegationReturnTaskId!;
    expect(firstReturnId).toBeTruthy();
    const firstReturn = fixture.store.getTask(firstReturnId)!;
    const firstEntry = inboxReportEntry(fixture.store, firstReturn, fixture.childTask.id);
    expect(firstEntry.body_md).toContain("first result");
    expect(firstReturn.prompt).toBe(`读收件箱\n\n${firstReturn.issueSessionId}:${firstEntry.seq} (${firstEntry.id})`);
    expect(fixture.store.claimTask(fixture.leaderRuntime.id)?.id).toBe(firstReturnId);
    fixture.store.buildTaskSessionProjection(firstReturnId);
    fixture.store.startTask(firstReturnId);

    const continued = fixture.store.createTask({
      agentId: fixture.qa.id,
      issueId: fixture.issue.id,
      issueSessionId: fixture.childTask.issueSessionId,
      prompt: "Address the follow-up.",
      delegationId: fixture.childTask.delegationId,
      delegatedByAgentId: fixture.leader.id,
      parentTaskId: firstReturnId,
    });
    fixture.store.completeTask(firstReturnId, { output: "Continue the same delegation." });
    expect(fixture.store.claimTask(fixture.qaRuntime.id)?.id).toBe(continued.id);
    fixture.store.buildTaskSessionProjection(continued.id);
    fixture.store.startTask(continued.id);
    fixture.store.completeTask(continued.id, { output: "second result", sessionId: "qa_session_1" });

    const secondReturnId = fixture.store.getTask(continued.id)!.delegationReturnTaskId!;
    expect(secondReturnId).toBeTruthy();
    expect(secondReturnId).not.toBe(firstReturnId);
    const secondReturn = fixture.store.getTask(secondReturnId)!;
    const secondEntry = inboxReportEntry(fixture.store, secondReturn, continued.id);
    expect(secondEntry.body_md).toContain("second result");
    expect(secondReturn.prompt).toBe(`读收件箱\n\n${secondReturn.issueSessionId}:${secondEntry.seq} (${secondEntry.id})`);
    const duplicate = fixture.store.ensureDelegationWakeup({
      sourceTaskId: continued.id,
      requiredEventSeq: 1,
      terminalStatus: "completed",
      terminalBody: "second result",
    });
    expect(duplicate).toMatchObject({ created: false, covered: true });
    expect(duplicate.task?.id).toBe(secondReturnId);
  });

  it("allows human rich mentions but rejects unlinked agent delegation", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const issue = store.createIssue({ title: "Mention semantics" });

    store.createIssueComment(issue.id, {
      authorType: "member",
      body: `Human request [@QA](mention://agent/${qa.id})`,
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      body: `Unlinked agent request [@QA](mention://agent/${qa.id})`,
    });

    const tasks = store.listTasksForIssue(issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      agentId: qa.id,
      delegationId: null,
      delegatedByAgentId: null,
    });
    expect(store.listIssueActivity(issue.id)
      .find((activity) => activity.type === "comment_mention_skipped")?.data)
      .toMatchObject({ reason: "unlinked_agent_comment", agentId: qa.id });
  });

  it("derives direct-task delegation lineage from the task credential even without a squad", async () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const issue = store.createIssue({ title: "Direct delegation" });
    const leaderTask = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Lead." });
    const taskToken = await store.createTaskAccessToken(leaderTask, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const body = {
      agentId: qa.id,
      issueId: issue.id,
      prompt: "Verify the direct assignment.",
      parentTaskId: "tsk_forged",
      delegationId: "dlg_forged",
      delegatedByAgentId: qa.id,
    };

    const humanResponse = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(humanResponse.status).toBe(201);
    const humanTaskId = ((await humanResponse.json()) as { task: { id: string } }).task.id;
    expect(store.getTask(humanTaskId)).toMatchObject({
      delegationId: null,
      delegatedByAgentId: null,
    });

    const delegatedResponse = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${taskToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(delegatedResponse.status).toBe(201);
    const delegatedTaskId = ((await delegatedResponse.json()) as { task: { id: string } }).task.id;
    const delegated = store.getTask(delegatedTaskId)!;
    expect(delegated).toMatchObject({
      delegatedByAgentId: leader.id,
      issueSessionId: leaderTask.issueSessionId,
      parentTaskId: leaderTask.id,
    });
    expect(delegated.delegationId).toStartWith("dlg_");
    expect(delegated.delegationId).not.toBe("dlg_forged");
  });

  it("delegates an ordinary task-token dispatch to an agent outside the squad", async () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const outsider = store.createAgent({ name: "Outsider", provider: "claude" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [] });
    const issue = store.createIssue({ title: "Rejected direct delegation", assigneeType: "squad", assigneeId: squad.id });
    const leaderTask = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Lead." });
    const taskToken = await store.createTaskAccessToken(leaderTask, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${taskToken.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: outsider.id, issueId: issue.id, prompt: "Investigate." }),
    });
    expect(response.status).toBe(201);
    const taskId = ((await response.json()) as { task: { id: string } }).task.id;
    expect(store.getTask(taskId)).toMatchObject({ delegatedByAgentId: leader.id,
      delegatedFromIssueSessionId: leaderTask.issueSessionId });
    expect(store.getTask(taskId)!.delegationId).toBeTruthy();
    expect(store.listIssueActivity(issue.id)
      .some((activity) => activity.type === "delegation_return_skipped"
        && (activity.data as Record<string, unknown>).taskId === taskId))
      .toBeFalse();
  });

  it("lets a task-linked agent richly mention agents inside and outside the squad", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const outsider = store.createAgent({ name: "Outsider", provider: "claude" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [qa.id] });
    const issue = store.createIssue({ title: "Leader delegation", assigneeType: "squad", assigneeId: squad.id });
    const leaderTask = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Lead." });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: "I already asked @QA to verify this.",
    });
    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please help [@Outsider](mention://agent/${outsider.id})`,
    });
    expect(store.listTasksForIssue(issue.id)).toHaveLength(2);
    expect(store.listTasksForIssue(issue.id).find(task => task.agentId === outsider.id))
      .toMatchObject({ delegatedByAgentId: leader.id, delegatedFromIssueSessionId: leaderTask.issueSessionId });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please verify [@QA](mention://agent/${qa.id})`,
    });

    const tasks = store.listTasksForIssue(issue.id);
    expect(tasks).toHaveLength(3);
    const delegated = tasks.find((task) => task.agentId === qa.id)!;
    expect(delegated).toMatchObject({ agentId: qa.id, delegatedByAgentId: leader.id });
    expect(delegated.delegationId).toBeTruthy();
  });

  it("coalesces a leader's repeated rich mention into the teammate's queued task", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [qa.id] });
    const issue = store.createIssue({ title: "Duplicate delegation", assigneeType: "squad", assigneeId: squad.id });
    const leaderTask = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Lead." });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please verify [@QA](mention://agent/${qa.id})`,
    });
    // The leader's own summary re-mentions the teammate it just dispatched.
    const summary = store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Next up: already sent [@QA](mention://agent/${qa.id}) to run the acceptance pass.`,
    });

    const qaTasks = store.listTasksForIssue(issue.id).filter((task) => task.agentId === qa.id);
    expect(qaTasks).toHaveLength(1);
    expect(qaTasks[0]!.status).toBe("queued");
    expect(qaTasks[0]!.continuedFromTaskId).toBeNull();

    const coalesced = store.listIssueActivity(issue.id)
      .filter((activity) => activity.type === "pending_turn_coalesced");
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]!.data).toMatchObject({ commentId: summary.id, agentId: qa.id, taskId: qaTasks[0]!.id });
  });

  it("still queues a follow-up mention once the teammate's task left the queue", () => {
    const store = createStore();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [qa.id] });
    const issue = store.createIssue({ title: "Follow-up delegation", assigneeType: "squad", assigneeId: squad.id });
    const leaderTask = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Lead." });

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `Please verify [@QA](mention://agent/${qa.id})`,
    });
    const firstQaTask = store.listTasksForIssue(issue.id).find((task) => task.agentId === qa.id)!;
    // A dispatched task has its context frozen, so a later instruction cannot
    // ride along on it and must get its own turn.
    db!.run(
      "UPDATE multiremi_tasks SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP WHERE id = ?",
      [firstQaTask.id],
    );

    store.createIssueComment(issue.id, {
      authorType: "agent",
      authorId: leader.id,
      taskId: leaderTask.id,
      body: `One more thing [@QA](mention://agent/${qa.id}) — also check the migration.`,
    });

    expect(store.listTasksForIssue(issue.id).filter((task) => task.agentId === qa.id)).toHaveLength(2);
  });

  it("human mentions follow the Q-B constant", () => {
    const store = createStore();
    const qa = store.createAgent({ name: "QA", provider: "claude" });
    const issue = store.createIssue({ title: "Human mentions" });

    store.createIssueComment(issue.id, {
      authorType: "member",
      body: `Please look [@QA](mention://agent/${qa.id})`,
    });
    store.createIssueComment(issue.id, {
      authorType: "member",
      body: `And this too [@QA](mention://agent/${qa.id})`,
    });

    expect(store.listTasksForIssue(issue.id).filter((task) => task.agentId === qa.id))
      .toHaveLength(HUMAN_COMMENT_JOINS_QUEUED_ROUND ? 1 : 2);
    expect(store.listIssueActivity(issue.id)
      .filter((activity) => activity.type === "pending_turn_coalesced"))
      .toHaveLength(HUMAN_COMMENT_JOINS_QUEUED_ROUND ? 1 : 0);
  });

  it("coalesces a later delegation report into the leader's unfrozen queued return", () => {
    const fixture = createDelegationFixture();
    fixture.store.completeTask(fixture.childTask.id, {
      output: "First report is complete.",
      sessionId: "qa_fanout_first",
    });
    const firstReturn = delegationTasks(fixture).find((task) => task.agentId === fixture.leader.id)!;
    const secondRuntime = fixture.store.registerRuntime({
      id: "rt_later_delegate",
      name: "Later delegate runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const second = fixture.store.createAgent({
      name: "Later delegate",
      provider: "claude",
      runtimeId: secondRuntime.id,
    });
    const secondTask = fixture.store.createTask({
      agentId: second.id,
      issueId: fixture.issue.id,
      issueSessionId: fixture.childTask.issueSessionId,
      prompt: "Deliver the second report.",
      priority: 10,
      delegationId: "dlg_later_delegate",
      delegatedByAgentId: fixture.leader.id,
      parentTaskId: fixture.leaderTask.id,
    });
    expect(fixture.store.claimTask(secondRuntime.id)?.id).toBe(secondTask.id);
    fixture.store.buildTaskSessionProjection(secondTask.id);
    fixture.store.startTask(secondTask.id);
    fixture.store.completeTask(secondTask.id, {
      output: "Second report is complete.",
      sessionId: "qa_fanout_second",
    });

    const returns = fixture.store.listTasksForIssue(fixture.issue.id).filter((task) =>
      task.agentId === fixture.leader.id && task.delegatedByAgentId === fixture.leader.id
    );
    expect(returns).toHaveLength(1);
    expect(returns[0]?.id).toBe(firstReturn.id);
    expect(inboxReportBody(fixture.store, returns[0]!)).toContain("First report is complete.");
    expect(inboxReportBody(fixture.store, returns[0]!)).toContain("Second report is complete.");
    expect(fixture.store.getTask(secondTask.id)?.delegationReturnTaskId).toBe(firstReturn.id);
    expect(fixture.store.listIssueActivity(fixture.issue.id).some((activity) =>
      activity.type === "pending_turn_coalesced"
      && (activity.data as Record<string, unknown>).task_id === firstReturn.id
    )).toBeTrue();
  });

  it("creates a second return when the existing leader return was already claimed", () => {
    const fixture = createDelegationFixture();
    fixture.store.completeTask(fixture.childTask.id, {
      output: "First frozen report.",
      sessionId: "qa_claimed_first",
    });
    const firstReturn = delegationTasks(fixture).find((task) => task.agentId === fixture.leader.id)!;
    db!.run(
      "UPDATE multiremi_tasks SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP WHERE id = ?",
      [firstReturn.id],
    );
    const secondRuntime = fixture.store.registerRuntime({
      id: "rt_claimed_delegate",
      name: "Claimed boundary runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const second = fixture.store.createAgent({
      name: "Claimed boundary delegate",
      provider: "claude",
      runtimeId: secondRuntime.id,
    });
    const secondTask = fixture.store.createTask({
      agentId: second.id,
      runtimeId: secondRuntime.id,
      issueId: fixture.issue.id,
      issueSessionId: fixture.childTask.issueSessionId,
      prompt: "Deliver after the prior return froze.",
      delegationId: "dlg_claimed_delegate",
      delegatedByAgentId: fixture.leader.id,
      parentTaskId: fixture.leaderTask.id,
    });
    db!.run(
      "UPDATE multiremi_tasks SET status = 'running', dispatched_at = CURRENT_TIMESTAMP, started_at = CURRENT_TIMESTAMP WHERE id = ?",
      [secondTask.id],
    );
    fixture.store.completeTask(secondTask.id, {
      output: "Report after the frozen leader prompt.",
      sessionId: "qa_claimed_second",
    });

    const returns = fixture.store.listTasksForIssue(fixture.issue.id).filter((task) =>
      task.agentId === fixture.leader.id && task.delegatedByAgentId === fixture.leader.id
    );
    expect(returns).toHaveLength(2);
    const secondReturn = returns.find((task) => task.id !== firstReturn.id)!;
    expect(inboxReportBody(fixture.store, secondReturn)).toContain("Report after the frozen leader prompt.");
    expect(fixture.store.getTask(secondTask.id)?.delegationReturnTaskId).toBe(secondReturn.id);
  });

  it("covers reports with an unrelated queued leader task and re-drains if it is cancelled", () => {
    const fixture = createDelegationFixture();
    const queuedLeaderTask = fixture.store.createTask({
      agentId: fixture.leader.id,
      issueId: fixture.issue.id,
      issueSessionId: fixture.childTask.issueSessionId,
      prompt: "Keep this human-triggered prompt unchanged.",
    });
    fixture.store.completeTask(fixture.childTask.id, {
      output: "Report covered by another queued leader task.",
      sessionId: "qa_covered_by_queue",
    });

    expect(fixture.store.getTask(queuedLeaderTask.id)?.prompt).toBe("Keep this human-triggered prompt unchanged.");
    expect(fixture.store.getTask(fixture.childTask.id)?.delegationReturnTaskId).toBe(queuedLeaderTask.id);
    expect(fixture.store.listIssueActivity(fixture.issue.id).some((activity) =>
      activity.type === "pending_turn_coalesced"
      && (activity.data as Record<string, unknown>).task_id === queuedLeaderTask.id
    )).toBeTrue();

    fixture.store.cancelTask(queuedLeaderTask.id);
    const replacement = fixture.store.listTasksForIssue(fixture.issue.id).find((task) =>
      task.id !== queuedLeaderTask.id
      && task.agentId === fixture.leader.id
      && task.delegatedByAgentId === fixture.leader.id
    )!;
    expect(inboxReportBody(fixture.store, replacement)).toContain("Report covered by another queued leader task.");
    expect(fixture.store.getTask(fixture.childTask.id)?.delegationReturnTaskId).toBe(replacement.id);
  });

  it("queues a terminal delegation return while another teammate is still active", () => {
    const fixture = createFanoutFixture();
    fixture.store.completeTask(fixture.firstTask.id, {
      output: "First fanout report.",
      sessionId: "fanout_first_deferred",
    });

    expect(leaderReturnTasks(fixture)).toHaveLength(1);
    expect(fixture.store.getTask(fixture.firstTask.id)?.delegationReturnTaskId).toBe(leaderReturnTasks(fixture)[0]!.id);
    expect(fixture.store.listIssueActivity(fixture.issue.id).some((activity) =>
      activity.type === "delegation_return_skipped"
      && (activity.data as Record<string, unknown>).reason === "deferred_lane_busy"
    )).toBeFalse();
  });

  it("coalesces later reports into a still-queued leader return", () => {
    const fixture = createFanoutFixture();
    fixture.store.completeTask(fixture.firstTask.id, {
      output: "First aggregated report.",
      sessionId: "fanout_first_aggregated",
    });
    expect(fixture.store.claimTask(fixture.secondRuntime.id)?.id).toBe(fixture.secondTask.id);
    fixture.store.buildTaskSessionProjection(fixture.secondTask.id);
    fixture.store.startTask(fixture.secondTask.id);
    fixture.store.completeTask(fixture.secondTask.id, {
      output: "Second aggregated report.",
      sessionId: "fanout_second_aggregated",
    });

    const returns = leaderReturnTasks(fixture);
    expect(returns).toHaveLength(1);
    expect(inboxReportBody(fixture.store, returns[0]!)).toContain("First aggregated report.");
    expect(inboxReportBody(fixture.store, returns[0]!)).toContain("Second aggregated report.");
    expect(fixture.store.getTask(fixture.firstTask.id)?.delegationReturnTaskId).toBe(returns[0]?.id);
    expect(fixture.store.getTask(fixture.secondTask.id)?.delegationReturnTaskId).toBe(returns[0]?.id);
    const triggered = fixture.store.listIssueActivity(fixture.issue.id).find((activity) =>
      activity.type === "delegation_return_triggered"
    );
    expect(triggered?.data).toMatchObject({
      returnTaskId: returns[0]?.id,
      coveredSourceTaskIds: [fixture.firstTask.id],
      drained: false,
    });
  });

  it("drains failed and cancelled delegation reports without breaking the chain", () => {
    const fixture = createFanoutFixture();
    fixture.store.failTask(fixture.firstTask.id, {
      error: "First delegate failed definitively.",
      failureReason: "agent_error",
    });
    expect(leaderReturnTasks(fixture)).toHaveLength(1);
    expect(fixture.store.cancelTask(fixture.secondTask.id).status).toBe("cancelled");

    const returns = leaderReturnTasks(fixture);
    expect(returns).toHaveLength(1);
    expect(inboxReportBody(fixture.store, returns[0]!)).toContain("First delegate failed definitively.");
    expect(inboxReportBody(fixture.store, returns[0]!)).toContain("Status: failed");
    expect(inboxReportBody(fixture.store, returns[0]!)).toContain("Status: cancelled");
    expect(fixture.store.getTask(fixture.firstTask.id)?.delegationReturnTaskId).toBe(returns[0]?.id);
    expect(fixture.store.getTask(fixture.secondTask.id)?.delegationReturnTaskId).toBe(returns[0]?.id);
  });

  it("prepares one Feishu round push after a fanout is drained and reviewed", () => {
    const fixture = createFanoutFixture(true);
    fixture.store.completeTask(fixture.firstTask.id, { output: "First Feishu fanout report." });
    expect(fixture.store.claimTask(fixture.secondRuntime.id)?.id).toBe(fixture.secondTask.id);
    fixture.store.buildTaskSessionProjection(fixture.secondTask.id);
    fixture.store.startTask(fixture.secondTask.id);
    fixture.store.completeTask(fixture.secondTask.id, { output: "Second Feishu fanout report." });
    const leaderReturn = leaderReturnTasks(fixture)[0]!;
    expect(fixture.store.claimTask(fixture.leaderRuntime.id)?.id).toBe(leaderReturn.id);
    fixture.store.buildTaskSessionProjection(leaderReturn.id);
    fixture.store.startTask(leaderReturn.id);
    fixture.store.completeTask(leaderReturn.id, { output: "Reviewed the entire Feishu fanout." });

    expect(countFeishuRoundPushes()).toBe(1);
  });

  it("still prepares one Feishu round push when a no-lineage chain endpoint drains the debt", () => {
    const fixture = createFanoutFixture(true);
    db!.run(
      "UPDATE multiremi_tasks SET delegation_id = NULL, delegated_by_agent_id = NULL WHERE id = ?",
      [fixture.secondTask.id],
    );
    fixture.store.completeTask(fixture.firstTask.id, { output: "Deferred Feishu chain report." });
    expect(leaderReturnTasks(fixture)).toHaveLength(1);
    expect(fixture.store.claimTask(fixture.secondRuntime.id)?.id).toBe(fixture.secondTask.id);
    fixture.store.buildTaskSessionProjection(fixture.secondTask.id);
    fixture.store.startTask(fixture.secondTask.id);
    fixture.store.completeTask(fixture.secondTask.id, { output: "No-lineage chain endpoint complete." });
    const leaderReturn = leaderReturnTasks(fixture)[0]!;
    expect(fixture.store.claimTask(fixture.leaderRuntime.id)?.id).toBe(leaderReturn.id);
    fixture.store.buildTaskSessionProjection(leaderReturn.id);
    fixture.store.startTask(leaderReturn.id);
    fixture.store.completeTask(leaderReturn.id, { output: "Reviewed the deferred Feishu chain." });

    expect(countFeishuRoundPushes()).toBe(1);
  });

  it("returns a completed child exactly once and does not bounce after the leader finishes", () => {
    const fixture = createDelegationFixture();

    fixture.store.completeTask(fixture.childTask.id, {
      output: "QA passed; verified the permission boundary.",
      sessionId: "qa_session_1",
      workDir: "/tmp/delegation-qa",
    });

    const returned = delegationTasks(fixture);
    expect(returned).toHaveLength(2);
    const leaderReturn = returned.find((task) => task.agentId === fixture.leader.id)!;
    expect(leaderReturn).toMatchObject({
      status: "queued",
      delegatedByAgentId: fixture.leader.id,
    });
    const reportBody = inboxReportBody(fixture.store, leaderReturn);
    expect(reportBody).toContain("QA completed a task you delegated");
    expect(reportBody).toContain("QA passed; verified the permission boundary.");
    expect(reportBody).toContain("本轮所有委派都终态后再发一次轮次总结");
    expect(Buffer.byteLength(reportBody)).toBeLessThan(2_048);
    expect(reportBody).not.toContain("communicate the final outcome to the user");
    expect(leaderReturn.prompt).not.toContain("QA passed; verified the permission boundary.");
    expect(fixture.store.getIssue(fixture.issue.id)?.status).toBe("todo");

    expect(fixture.store.claimTask(fixture.leaderRuntime.id)?.id).toBe(leaderReturn.id);
    const projection = fixture.store.buildTaskSessionProjection(leaderReturn.id)!;
    expect(projection.jsonl).toContain(`\"task_id\":\"${fixture.childTask.id}\"`);
    fixture.store.startTask(leaderReturn.id);
    fixture.store.completeTask(leaderReturn.id, {
      output: "Reviewed QA's report and closed the task.",
      sessionId: "leader_session_2",
      workDir: "/tmp/delegation-leader",
    });

    expect(delegationTasks(fixture)).toHaveLength(2);
    expect(fixture.store.listIssueActivity(fixture.issue.id)
      .filter((activity) => activity.type === "delegation_return_triggered")).toHaveLength(1);
    expect(fixture.store.listIssueActivity(fixture.issue.id).some((activity) =>
      activity.type === "delegation_return_skipped"
      && (activity.data as Record<string, unknown>).reason === "no_lineage"
    )).toBeFalse();
  });

  it("returns a child rich mention immediately and coalesces repeated and terminal reports", () => {
    const fixture = createDelegationFixture();
    const report = fixture.store.createIssueComment(fixture.issue.id, {
      authorType: "agent",
      authorId: fixture.qa.id,
      taskId: fixture.childTask.id,
      body: `[@Leader](mention://agent/${fixture.leader.id}) QA found no blocker.`,
    });

    let returned = delegationTasks(fixture);
    expect(returned).toHaveLength(2);
    let leaderReturn = returned.find((task) => task.agentId === fixture.leader.id)!;
    expect(fixture.store.getConversationLogEntryById(report.id)!.body_md).toBe(report.body);
    expect(leaderReturn.triggerCommentId).toBe(report.id);

    fixture.store.createIssueComment(fixture.issue.id, {
      authorType: "agent",
      authorId: fixture.qa.id,
      taskId: fixture.childTask.id,
      body: `Still working; [@Leader](mention://agent/${fixture.leader.id}) no action needed yet.`,
    });
    expect(delegationTasks(fixture)).toHaveLength(2);
    expect(fixture.store.listIssueActivity(fixture.issue.id)
      .some((activity) => activity.type === "pending_turn_coalesced"
        && (activity.data as Record<string, unknown>).task_id === leaderReturn.id))
      .toBeTrue();

    fixture.store.completeTask(fixture.childTask.id, {
      output: "QA finished successfully.",
      sessionId: "qa_session_explicit",
      workDir: "/tmp/delegation-qa",
    });

    returned = delegationTasks(fixture);
    expect(returned).toHaveLength(2);
    leaderReturn = returned.find((task) => task.agentId === fixture.leader.id)!;
    expect(inboxReportBody(fixture.store, leaderReturn)).toContain("摘要：Still working;");
    expect(inboxReportBody(fixture.store, leaderReturn)).toContain("结论评论：cmt_");
    expect(leaderReturn.triggerCommentId).toBeNull();
    fixture.store.updateIssueComment(report.id, { body: "QA found no blocker." });
    expect(fixture.store.getTask(leaderReturn.id)?.status).toBe("queued");
    expect(fixture.store.listIssueActivity(fixture.issue.id)
      .filter((activity) => activity.type === "delegation_return_triggered")).toHaveLength(1);
  });

  it("creates a second delta return when the first leader task was dispatched before child completion", () => {
    const fixture = createDelegationFixture();
    const wakeup = fixture.store.ensureDelegationWakeup({
      sourceTaskId: fixture.childTask.id,
      requiredEventSeq: 1_000_000,
    });
    const firstReturn = wakeup.task!;
    // Freeze this return before the child finishes so later results need a new turn.
    // Model an already handed-off task defensively: once a daemon can hold the
    // old prompt, a terminal report must be delivered in a second Delta.
    db!.run(
      "UPDATE multiremi_tasks SET status = 'dispatched', dispatched_at = CURRENT_TIMESTAMP WHERE id = ?",
      [firstReturn.id],
    );
    expect(fixture.store.getTask(firstReturn.id)).toMatchObject({
      status: "dispatched",
      projectionToSeq: null,
    });

    fixture.store.completeTask(fixture.childTask.id, {
      output: "Final QA report arrived after the leader prompt froze.",
      sessionId: "qa_session_late",
      workDir: "/tmp/delegation-qa",
    });

    const leaderReturns = delegationTasks(fixture).filter((task) => task.agentId === fixture.leader.id);
    expect(leaderReturns).toHaveLength(2);
    const terminalReturn = leaderReturns.find((task) => task.id !== firstReturn.id)!;
    expect(terminalReturn).toMatchObject({ status: "queued", projectionToSeq: null });
    expect(inboxReportBody(fixture.store, terminalReturn)).toContain("Final QA report arrived after the leader prompt froze.");
  });

  it("waits for the final infrastructure retry before returning failure to the leader", () => {
    const fixture = createDelegationFixture();
    let attempt = fixture.childTask;

    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      fixture.store.failTask(attempt.id, {
        error: `runtime failed on attempt ${expectedAttempt}`,
        failureReason: "runtime_offline",
      });
      const returns = delegationTasks(fixture).filter((task) => task.agentId === fixture.leader.id);
      expect(returns).toHaveLength(expectedAttempt === 3 ? 1 : 0);
      if (expectedAttempt === 3) {
        expect(inboxReportBody(fixture.store, returns[0]!)).toContain("runtime failed on attempt 3");
        break;
      }

      attempt = delegationTasks(fixture).find((task) => task.parentTaskId === attempt.id)!;
      expect(attempt).toMatchObject({
        attempt: expectedAttempt + 1,
        delegationId: fixture.childTask.delegationId,
        delegatedByAgentId: fixture.leader.id,
      });
      expect(fixture.store.claimTask(fixture.qaRuntime.id)?.id).toBe(attempt.id);
      fixture.store.buildTaskSessionProjection(attempt.id);
      fixture.store.startTask(attempt.id);
    }
  });

  it("returns cancellation but never rolls back the child terminal transition", () => {
    const fixture = createDelegationFixture();

    expect(fixture.store.cancelTask(fixture.childTask.id).status).toBe("cancelled");
    const leaderReturn = delegationTasks(fixture).find((task) => task.agentId === fixture.leader.id)!;
    expect(leaderReturn).toMatchObject({ status: "queued" });
    expect(inboxReportBody(fixture.store, leaderReturn)).toContain("A task you delegated to QA was cancelled");
  });

  it("keeps child completion committed when the delegating agent was archived", () => {
    const fixture = createDelegationFixture();
    fixture.store.archiveAgent(fixture.leader.id);

    expect(fixture.store.completeTask(fixture.childTask.id, {
      output: "QA finished after the leader was archived.",
      sessionId: "qa_session_archived_leader",
      workDir: "/tmp/delegation-qa",
    }).status).toBe("completed");
    expect(delegationTasks(fixture).filter((task) => task.agentId === fixture.leader.id)).toHaveLength(0);
    expect(fixture.store.listIssueActivity(fixture.issue.id)
      .some((activity) => activity.type === "delegation_return_skipped"
        && (activity.data as Record<string, unknown>).reason === "delegator_unavailable"))
      .toBeTrue();
  });

  it("keeps ordinary tasks without delegation lineage out of the return audit", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Solo", provider: "claude" });
    const issue = store.createIssue({ title: "No lineage" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Work." });

    expect(store.cancelTask(task.id).status).toBe("cancelled");
    expect(store.ensureDelegationWakeup({ sourceTaskId: task.id, requiredEventSeq: 1 })).toEqual({
      task: null,
      created: false,
      covered: false,
    });
    expect(store.listIssueActivity(issue.id)
      .some((activity) => activity.type === "delegation_return_skipped"
        && (activity.data as Record<string, unknown>).reason === "no_lineage"))
      .toBeFalse();
  });

  it("audits a malformed delegation lineage instead of silently dropping it", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Solo", provider: "claude" });
    const issue = store.createIssue({ title: "Malformed lineage" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Work." });
    db!.run("UPDATE multiremi_tasks SET delegation_id = ? WHERE id = ?", ["dlg_incomplete", task.id]);

    expect(store.ensureDelegationWakeup({ sourceTaskId: task.id, requiredEventSeq: 1 })).toEqual({
      task: null,
      created: false,
      covered: false,
    });
    expect(store.listIssueActivity(issue.id)
      .some((activity) => activity.type === "delegation_return_skipped"
        && (activity.data as Record<string, unknown>).reason === "no_lineage"))
      .toBeTrue();
  });
});
