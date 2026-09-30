/**
 * MUL-465: real PG rollback/readback coverage for caller-owned steer and Agent
 * role transactions. An explicit unreachable PG URL is a failure; otherwise
 * this suite skips when the optional local PostgreSQL service is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

const explicitPgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const adminUrl = explicitPgUrl ?? "postgres://multimira:multimira@localhost:5432/postgres";
const databaseName = `multiremi_mul465_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

async function probePostgres(): Promise<boolean> {
  const admin = new Bun.SQL(adminUrl, { max: 1 });
  try {
    await admin`SELECT 1`;
    return true;
  } catch {
    if (explicitPgUrl) throw new Error("Configured MUL-465 PostgreSQL is unavailable");
    return false;
  } finally {
    await admin.end();
  }
}

const pgAvailable = await probePostgres();

describe.skipIf(!pgAvailable)("MUL-465 atomic PostgreSQL boundaries", () => {
  let admin: Bun.SQL;
  let reader: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let fixtureNumber = 0;
  let depth = 0;
  let maxDepth = 0;
  let previousEncryptionKey: string | undefined;

  beforeAll(async () => {
    admin = new Bun.SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    db = new PostgresSyncDatabase(databaseUrl.toString());
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    reader = new Bun.SQL(databaseUrl.toString(), { max: 1 });
    const originalTransaction = db.transaction.bind(db);
    db.transaction = function transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
      const run = originalTransaction(fn);
      return (...args: any[]) => {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        try {
          return run(...args);
        } finally {
          depth -= 1;
        }
      };
    };
    previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  afterAll(async () => {
    if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
    db?.close();
    await reader?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin?.end();
  });

  function freshAgent() {
    fixtureNumber += 1;
    const workspaceId = store.createWorkspace({
      name: `MUL465 ${fixtureNumber}`, slug: `mul465-${process.pid}-${fixtureNumber}`,
    }).id;
    const runtime = store.registerRuntime({
      id: `rt_mul465_${fixtureNumber}`, name: "PG boundary runtime", provider: "codex",
      workspaceId, daemonId: `mul465_${fixtureNumber}`,
    });
    const agent = store.createAgent({
      name: "PG boundary agent", provider: "codex", workspaceId, runtimeId: runtime.id,
    });
    return { workspaceId, runtime, agent };
  }

  function feishuFixture() {
    const fixture = freshAgent();
    store.heartbeatRuntime(fixture.runtime.id, { supportsFeishuBotConfig: true });
    const config = store.upsertFeishuBotConfig(fixture.workspaceId, {
      agentId: fixture.agent.id, runtimeId: fixture.runtime.id, appId: "cli_mul465",
      domain: "feishu", enabled: true, appSecretOp: "set",
      appSecret: "fixture-secret-not-a-real-credential",
    });
    const input = {
      revision: config.revision, externalSessionKey: `oc_mul465_${fixtureNumber}`,
      externalMessageId: `om_mul465_first_${fixtureNumber}`, senderOpenId: "ou_mul465_sender",
      text: "Initial message",
    };
    const first = store.submitFeishuBotMessage(fixture.workspaceId, fixture.runtime.id, input);
    return { ...fixture, first, input: {
      ...input, externalMessageId: `om_mul465_steer_${fixtureNumber}`, text: "Steer message",
    } };
  }

  it("rolls back Feishu Chat, steer and delivery writes after a later failure", async () => {
    const { workspaceId, runtime, first, input } = feishuFixture();
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent(event => events.push(event.type));
    const originalRun = db.run;
    let injected = false;
    db.run = function run(sql, ...params) {
      const result = originalRun.call(this, sql, ...params);
      if (sql.includes("INSERT INTO multiremi_feishu_bot_deliveries")) {
        injected = true;
        throw new Error("MUL-465 Feishu rollback injection");
      }
      return result;
    };
    maxDepth = 0;
    try {
      expect(() => store.submitFeishuBotMessage(workspaceId, runtime.id, input))
        .toThrow("MUL-465 Feishu rollback injection");
    } finally {
      db.run = originalRun;
      unsubscribe();
    }
    expect(injected).toBe(true);
    expect(await reader<{ body: string }[]>`SELECT body FROM multiremi_chat_messages WHERE chat_session_id = ${first.chatSessionId} ORDER BY sequence`)
      .toEqual([{ body: "Initial message" }]);
    expect(await reader`SELECT id FROM multiremi_task_steer_messages WHERE task_id = ${first.taskId}`).toHaveLength(0);
    expect(await reader<{ external_message_id: string }[]>`SELECT external_message_id FROM multiremi_feishu_bot_deliveries WHERE workspace_id = ${workspaceId} ORDER BY external_message_id`)
      .toEqual([{ external_message_id: `om_mul465_first_${fixtureNumber}` }]);
    expect(await reader<{ message_sequence: number }[]>`SELECT message_sequence FROM multiremi_chat_sessions WHERE id = ${first.chatSessionId}`)
      .toEqual([{ message_sequence: 1 }]);
    expect(events).toEqual([]);
    expect(db.inTransaction).toBe(false);
    expect(maxDepth).toBe(1);
  });

  it("commits a Feishu steer in one transaction and preserves message linkage", async () => {
    const { workspaceId, runtime, first, input } = feishuFixture();
    maxDepth = 0;
    expect(store.submitFeishuBotMessage(workspaceId, runtime.id, input))
      .toMatchObject({ taskId: first.taskId, steered: true, duplicate: false });
    const rows = await reader`SELECT s.content, c.body FROM multiremi_task_steer_messages s
      JOIN multiremi_chat_messages c ON c.id = s.source_chat_message_id WHERE s.task_id = ${first.taskId}`;
    expect(rows).toEqual([{ content: input.text, body: input.text }]);
    expect(maxDepth).toBe(1);
    expect(db.inTransaction).toBe(false);
  });

  function roundFixture() {
    const fixture = freshAgent();
    store.heartbeatRuntime(fixture.runtime.id, { supportsFeishuBotConfig: true });
    const config = store.upsertFeishuBotConfig(fixture.workspaceId, {
      agentId: fixture.agent.id, runtimeId: fixture.runtime.id, appId: "cli_mul465_round",
      domain: "feishu", enabled: true, appSecretOp: "set",
      appSecret: "fixture-secret-not-a-real-credential",
    });
    store.reportFeishuBotRuntimeStatus(fixture.workspaceId, fixture.runtime.id, {
      appliedRevision: config.revision, state: "online",
    });
    store.updateWorkspace(fixture.workspaceId, {
      settings: { issueTopics: { enabled: true, chatId: `oc_mul465_round_${fixtureNumber}` } },
    });
    const issue = store.createIssue({
      title: "PG round boundary", workspaceId: fixture.workspaceId,
      assigneeType: "agent", assigneeId: fixture.agent.id,
    });
    store.prepareFeishuIssueTopicWithinTransaction(issue);
    const outbound = store.claimFeishuBotOutbound(fixture.workspaceId, fixture.runtime.id)!;
    store.reportFeishuBotOutbound(fixture.workspaceId, fixture.runtime.id, outbound.id, {
      claimToken: outbound.claimToken, status: "sent", externalMessageId: `om_mul465_round_${fixtureNumber}`,
    });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const previous = store.createSessionTask(session.id, { agentId: fixture.agent.id, prompt: "Previous round" });
    db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [previous.id]);
    store.completeTask(previous.id, { output: "Previous round result" });
    const chat = store.listChatSessions(fixture.workspaceId)
      .find(chat => store.getFeishuIssueIdForChatSession(chat.id) === issue.id)!;
    const wake = store.getPendingChatTask(chat.id)!;
    const leader = store.createSessionTask(session.id, { agentId: fixture.agent.id, prompt: "Current round" });
    db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [leader.id]);
    return { ...fixture, issue, session, wake, leader };
  }

  it("rolls back terminal round writes when steering an existing wake task fails later", async () => {
    const { issue, wake, leader } = roundFixture();
    expect(wake.status).toBe("queued");
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent(event => events.push(event.type));
    const originalRun = db.run;
    let injected = false;
    db.run = function run(sql, ...params) {
      const result = originalRun.call(this, sql, ...params);
      if (sql.includes("INSERT INTO multiremi_feishu_bot_round_pushes")) {
        injected = true;
        throw new Error("MUL-465 round rollback injection");
      }
      return result;
    };
    maxDepth = 0;
    try {
      expect(() => store.completeTask(leader.id, { output: "Current round result" }))
        .toThrow("MUL-465 round rollback injection");
    } finally {
      db.run = originalRun;
      unsubscribe();
    }
    expect(injected).toBe(true);
    expect(await reader<{ status: string }[]>`SELECT status FROM multiremi_tasks WHERE id = ${leader.id}`)
      .toEqual([{ status: "running" }]);
    expect(await reader`SELECT id FROM multiremi_task_steer_messages WHERE task_id = ${wake.id}`).toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_feishu_bot_round_pushes WHERE leader_task_id = ${leader.id}`).toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_session_events WHERE task_id = ${leader.id} AND kind = 'task_completed'`).toHaveLength(0);
    expect(store.listIssueActivity(issue.id).filter(entry => entry.type === "task_completed"
      && (entry.data as { taskId?: string } | null)?.taskId === leader.id)).toHaveLength(0);
    expect(events.filter(type => type === "chat:message")).toHaveLength(0);
    expect(events).toEqual([]);
    expect(maxDepth).toBe(1);
    expect(db.inTransaction).toBe(false);
  });

  it("reuses a round wake task under the outer workspace lock in one transaction", () => {
    const { wake, leader, workspaceId } = roundFixture();
    const workspaceLocks: boolean[] = [];
    const events: Array<{ type: string; inTransaction: boolean; actorId: string | null | undefined; payload: Record<string, unknown> }> = [];
    const unsubscribe = store.onWorkspaceEvent(event => {
      if (event.workspaceId === workspaceId) {
        events.push({ type: event.type, inTransaction: db.inTransaction, actorId: event.actorId, payload: event.payload });
      }
    });
    const originalRun = db.run;
    db.run = function run(sql, ...params) {
      if (sql === "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?") {
        expect(params).toEqual([[workspaceId]]);
        workspaceLocks.push(db.inTransaction);
      }
      return originalRun.call(this, sql, ...params);
    };
    maxDepth = 0;
    try {
      expect(store.completeTask(leader.id, { output: "Current round result" }).status).toBe("completed");
    } finally {
      db.run = originalRun;
      unsubscribe();
    }
    expect(store.listTaskSteerMessages(wake.id)).toHaveLength(1);
    expect(workspaceLocks.length).toBeGreaterThanOrEqual(2);
    expect(workspaceLocks.every(inTransaction => inTransaction)).toBe(true);
    expect(maxDepth).toBe(1);
    const chatEvents = events.filter(event => event.type === "chat:message");
    const inputEvents = events.filter(event => event.type === "daemon:task_input");
    const activityEvents = events.filter(event => event.type === "activity:created");
    const terminalActivities = activityEvents.filter(event =>
      (event.payload.entry as { action?: string } | undefined)?.action === "task_completed");
    expect(inputEvents).toHaveLength(1);
    expect(chatEvents).toHaveLength(1);
    expect(terminalActivities).toHaveLength(1);
    expect(inputEvents[0].inTransaction).toBe(false);
    expect(chatEvents[0].inTransaction).toBe(false);
    expect(activityEvents.every(event => !event.inTransaction)).toBe(true);
    expect(chatEvents[0].actorId).toBe(store.getChatSession(wake.chatSessionId!)!.creatorId);
    expect(events.indexOf(inputEvents[0])).toBeLessThan(events.indexOf(chatEvents[0]));
    expect(events.indexOf(chatEvents[0])).toBeLessThan(events.indexOf(terminalActivities[0]));
    expect(chatEvents[0].payload).toMatchObject({
      chat_session_id: wake.chatSessionId, role: "system", task_id: null,
      content: store.listChatMessages(wake.chatSessionId!)
        .find(message => message.id === chatEvents[0].payload.message_id)!.body,
    });
  });

  const roleUpdates = [
    { name: "updateAgent", role: "maintainer", update: (id: string) => store.updateAgent(id, { role: "maintainer" }) },
    { name: "setAgentRole", role: "maintainer", update: (id: string) => store.setAgentRole(id, "maintainer") },
    { name: "setAgentSupervisor", role: "supervisor", update: (id: string) => store.setAgentSupervisor(id, true) },
  ] as const;

  async function roleFixture() {
    const fixture = freshAgent();
    const tokens = [];
    for (let index = 0; index < 2; index += 1) {
      const task = store.createTask({ agentId: fixture.agent.id, prompt: `Token task ${index}` });
      const token = await store.createAccessToken({
        name: `Task token ${index}`, type: "task", taskId: task.id,
        agentId: fixture.agent.id, workspaceId: fixture.workspaceId,
      });
      tokens.push(token.id);
    }
    return { ...fixture, tokens };
  }

  for (const operation of roleUpdates) {
    it(`rolls back ${operation.name} and all token revocations after a partial revoke`, async () => {
      const { agent, tokens } = await roleFixture();
      const originalRun = db.run;
      let injected = false;
      db.run = function run(sql, ...params) {
        const result = originalRun.call(this, sql, ...params);
        if (sql.includes("UPDATE multiremi_access_tokens SET revoked_at = COALESCE")) {
          injected = true;
          throw new Error("MUL-465 token rollback injection");
        }
        return result;
      };
      maxDepth = 0;
      try {
        expect(() => operation.update(agent.id)).toThrow("MUL-465 token rollback injection");
      } finally {
        db.run = originalRun;
      }
      expect(injected).toBe(true);
      expect(await reader<{ role: string; supervisor: number }[]>`SELECT role, supervisor FROM multiremi_agents WHERE id = ${agent.id}`)
        .toEqual([{ role: "normal", supervisor: 0 }]);
      for (const tokenId of tokens) {
        expect(await reader<{ revoked_at: string | null }[]>`SELECT revoked_at FROM multiremi_access_tokens WHERE id = ${tokenId}`)
          .toEqual([{ revoked_at: null }]);
      }
      expect(maxDepth).toBe(1);
      expect(db.inTransaction).toBe(false);
    });

    it(`commits ${operation.name} and both token revocations in one transaction`, async () => {
      const { agent, tokens } = await roleFixture();
      maxDepth = 0;
      expect(operation.update(agent.id).role).toBe(operation.role);
      for (const tokenId of tokens) {
        const rows = await reader`SELECT revoked_at FROM multiremi_access_tokens WHERE id = ${tokenId}`;
        expect(rows[0].revoked_at).not.toBeNull();
      }
      expect(maxDepth).toBe(1);
      expect(db.inTransaction).toBe(false);
    });
  }

  it("keeps workspace before session locking and wakes only after the steer transaction commits", () => {
    const { workspaceId, agent } = freshAgent();
    const issue = store.createIssue({ title: "Steer lock order", workspaceId });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Steer me" });
    const locks: string[] = [];
    const events: Array<{ type: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent(event => events.push({ type: event.type, inTransaction: db.inTransaction }));
    const originalRun = db.run;
    db.run = function run(sql, ...params) {
      if (sql === "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?") locks.push("workspace");
      if (sql === "UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?") locks.push("session");
      return originalRun.call(this, sql, ...params);
    };
    maxDepth = 0;
    try {
      db.transaction(() => {
        store.createTaskSteerMessageWithinTransaction({ taskId: task.id, kind: "steer", content: "New input" });
        expect(events).toEqual([]);
      })();
      expect(events).toEqual([{ type: "daemon:task_input", inTransaction: false }]);
      events.length = 0;
      expect(() => db.transaction(() => {
        store.createTaskSteerMessageWithinTransaction({ taskId: task.id, kind: "steer", content: "Rolled back" });
        expect(events).toEqual([]);
        throw new Error("rollback steer");
      })()).toThrow("rollback steer");
      expect(events).toEqual([]);
    } finally {
      db.run = originalRun;
      unsubscribe();
    }
    expect(locks).toEqual(["workspace", "session", "session", "workspace", "session", "session"]);
    expect(events).toEqual([]);
    expect(maxDepth).toBe(1);
    expect(store.listSessionEvents(session.id).filter(event => event.kind === "task_steer")).toHaveLength(1);
    expect(store.listTaskSteerMessages(task.id).map(message => message.content)).toEqual(["New input"]);
  });

  function organizerFixture() {
    const { workspaceId, agent: workerAgent } = freshAgent();
    const supervisorAgent = store.createAgent({
      name: "PG organizer", provider: "codex", workspaceId, role: "supervisor",
    });
    const patrol = store.createIssue({ title: "PG organizer patrol", workspaceId });
    const targetIssue = store.createIssue({ title: "PG organizer target", workspaceId, status: "in_progress" });
    const supervisorTask = store.createTask({ agentId: supervisorAgent.id, issueId: patrol.id, prompt: "Patrol" });
    const session = store.getOrCreateDefaultIssueSession(targetIssue.id);
    const targetTask = store.createSessionTask(session.id, { agentId: workerAgent.id, prompt: "Organizer target" });
    store.updateWorkspace(workspaceId, { settings: { organizer: { mode: "act" } } });
    return { workspaceId, supervisorAgent, supervisorTask, patrol, session, targetTask };
  }

  for (const action of ["steer", "force_answer"] as const) {
    it(`commits an Organizer ${action} and its audit in one transaction, publishing after COMMIT`, async () => {
      const { workspaceId, supervisorAgent, supervisorTask, patrol, session, targetTask } = organizerFixture();
      const locks: Array<{ lock: string; inTransaction: boolean }> = [];
      const events: Array<{ type: string; inTransaction: boolean }> = [];
      const unsubscribe = store.onWorkspaceEvent(event => {
        if (event.workspaceId === workspaceId) events.push({ type: event.type, inTransaction: db.inTransaction });
      });
      const originalRun = db.run;
      db.run = function run(sql, ...params) {
        if (sql === "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?") {
          locks.push({ lock: "workspace", inTransaction: db.inTransaction });
        }
        if (sql === "UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ?") {
          locks.push({ lock: "session", inTransaction: db.inTransaction });
        }
        return originalRun.call(this, sql, ...params);
      };
      maxDepth = 0;
      let result: ReturnType<MultiremiStore["performOrganizerAction"]>;
      try {
        result = store.performOrganizerAction({
          supervisorTaskId: supervisorTask.id, supervisorAgentId: supervisorAgent.id,
          targetTaskId: targetTask.id, action, reason: "PG organizer probe", content: "Organizer input",
        });
      } finally {
        db.run = originalRun;
        unsubscribe();
      }
      expect(maxDepth).toBe(1);
      expect(db.inTransaction).toBe(false);
      expect(locks.slice(0, 2).map(entry => entry.lock)).toEqual(["workspace", "session"]);
      expect(locks.every(entry => entry.inTransaction)).toBe(true);
      expect(result.message).toMatchObject({
        taskId: targetTask.id, kind: action, content: "Organizer input",
        authorType: "agent", authorId: supervisorAgent.id,
      });
      expect(await reader<{ kind: string; content: string; author_type: string; author_id: string }[]>`SELECT kind, content, author_type, author_id FROM multiremi_task_steer_messages WHERE task_id = ${targetTask.id}`)
        .toEqual([{ kind: action, content: "Organizer input", author_type: "agent", author_id: supervisorAgent.id }]);
      expect(await reader<{ action: string; target_task_id: string; report_issue_id: string }[]>`SELECT action, target_task_id, report_issue_id FROM multiremi_organizer_actions WHERE id = ${result.audit.id}`)
        .toEqual([{ action, target_task_id: targetTask.id, report_issue_id: patrol.id }]);
      expect(await reader`SELECT id FROM multiremi_issue_comments WHERE id = ${result.comment.id}`).toHaveLength(1);
      expect(await reader`SELECT id FROM multiremi_session_events WHERE session_id = ${session.id} AND kind = 'task_steer'`)
        .toHaveLength(1);
      expect(events.filter(event => event.type === "comment:created")).toHaveLength(1);
      expect(events.every(event => !event.inTransaction)).toBe(true);
    });
  }

  it("rolls back an Organizer steer, its audit and comment when the transaction fails later", async () => {
    const { workspaceId, supervisorAgent, supervisorTask, patrol, session, targetTask } = organizerFixture();
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent(event => {
      if (event.workspaceId === workspaceId) events.push(event.type);
    });
    const issues = (store as unknown as {
      issues: { notifyOrganizerAction: (...args: unknown[]) => void };
    }).issues;
    const originalNotify = issues.notifyOrganizerAction;
    let injected = false;
    issues.notifyOrganizerAction = function notifyOrganizerAction(...args: unknown[]) {
      originalNotify.apply(this, args);
      injected = true;
      throw new Error("MUL-465 Organizer rollback injection");
    };
    maxDepth = 0;
    try {
      expect(() => store.performOrganizerAction({
        supervisorTaskId: supervisorTask.id, supervisorAgentId: supervisorAgent.id,
        targetTaskId: targetTask.id, action: "steer", reason: "PG organizer rollback", content: "Organizer input",
      })).toThrow("MUL-465 Organizer rollback injection");
    } finally {
      issues.notifyOrganizerAction = originalNotify;
      unsubscribe();
    }
    expect(injected).toBe(true);
    expect(await reader`SELECT id FROM multiremi_task_steer_messages WHERE task_id = ${targetTask.id}`).toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_session_events WHERE session_id = ${session.id} AND kind = 'task_steer'`)
      .toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_organizer_actions WHERE target_task_id = ${targetTask.id}`).toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_issue_comments WHERE issue_id = ${patrol.id}`).toHaveLength(0);
    expect(events).toEqual([]);
    expect(maxDepth).toBe(1);
    expect(db.inTransaction).toBe(false);
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`rejects ${status} tasks in the caller-owned steer transaction`, () => {
      const { agent } = freshAgent();
      const task = store.createTask({ agentId: agent.id, prompt: "Terminal steer rejection" });
      db.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, task.id]);
      expect(() => db.transaction(() => store.createTaskSteerMessageWithinTransaction({
        taskId: task.id, kind: "steer", content: "Too late",
      }))()).toThrow(`Task is already ${status}`);
      expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
    });
  }
});
