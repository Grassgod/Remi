import { createResponsibleTestIssue } from './helpers.js';
import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
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

  it("closes pending human requests only when an outer task cancellation commits", () => {
    const { workspaceId, agent, runtime } = freshAgent();
    const task = store.createTask({ agentId: agent.id, workspaceId, runtimeId: runtime.id, prompt: "Wait" });
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { message: "Continue?" } });
    const events: Array<{ type: string; inTransaction: boolean }> = [];
    const offWorkspace = store.onWorkspaceEvent(event => {
      if (event.payload.task_id === task.id) events.push({ type: event.type, inTransaction: db.inTransaction === true });
    });
    const offTask = store.onTaskEvent(event => {
      if (event.task.id === task.id) events.push({ type: event.type, inTransaction: db.inTransaction === true });
    });
    try {
      expect(() => db.transaction(() => {
        store.cancelTask(task.id);
        expect(store.getTaskHumanRequest(request.id)?.status).toBe("cancelled");
        expect(events).toEqual([]);
        throw new Error("rollback cancellation");
      })()).toThrow("rollback cancellation");
      expect(store.getTaskHumanRequest(request.id)?.status).toBe("pending");
      expect(events).toEqual([]);
      db.transaction(() => {
        store.cancelTask(task.id);
        expect(events).toEqual([]);
      })();
      expect(store.getTaskHumanRequest(request.id)?.status).toBe("cancelled");
      expect(events.filter(event => event.type === "daemon:task_input")).toHaveLength(1);
      expect(events.every(event => !event.inTransaction)).toBe(true);
      expect(store.expireTaskHumanRequest(request.id, "cancelled")).toBeNull();
    } finally {
      offWorkspace();
      offTask();
    }
  });

  it("rolls back Feishu Chat, steer and delivery writes after a later failure", async () => {
    const { workspaceId, runtime, first, input } = feishuFixture();
    const beforeHead = store.getConversationLogHead(first.chatSessionId)!.headSeq;
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
    expect(await reader<{ body: string }[]>`SELECT body_md AS body FROM multiremi_conversation_log WHERE session_id = ${first.chatSessionId} AND kind = 'message' ORDER BY seq`)
      .toEqual([{ body: "Initial message" }]);
    expect(await reader`SELECT id FROM multiremi_task_steer_messages WHERE task_id = ${first.taskId}`).toHaveLength(0);
    expect(await reader<{ external_message_id: string }[]>`SELECT external_message_id FROM multiremi_feishu_bot_deliveries WHERE workspace_id = ${workspaceId} ORDER BY external_message_id`)
      .toEqual([{ external_message_id: `om_mul465_first_${fixtureNumber}` }]);
    expect(await reader<{ head_seq: number }[]>`SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ${first.chatSessionId}`)
      .toEqual([{ head_seq: beforeHead }]);
    expect(events).toEqual([]);
    expect(db.inTransaction).toBe(false);
    expect(maxDepth).toBe(1);
  });

  it("commits a Feishu steer in one transaction and preserves message linkage", async () => {
    const { workspaceId, runtime, first, input } = feishuFixture();
    expect(store.claimTask(runtime.id)?.id).toBe(first.taskId);
    store.startTask(first.taskId);
    const inputEvents: Array<{ inTransaction: boolean; taskId: unknown }> = [];
    const unsubscribe = store.onWorkspaceEvent(event => {
      if (event.type === "daemon:task_input" && event.payload.task_id === first.taskId) {
        inputEvents.push({ inTransaction: db.inTransaction, taskId: event.payload.task_id });
      }
    });
    maxDepth = 0;
    try {
      expect(store.submitFeishuBotMessage(workspaceId, runtime.id, input))
        .toMatchObject({ taskId: first.taskId, steered: true, duplicate: false });
    } finally { unsubscribe(); }
    expect(inputEvents).toEqual([{ inTransaction: false, taskId: first.taskId }]);
    const turnId = store.getTask(first.taskId)!.turn_id!;
    const rows = await reader`SELECT body_md, to_agent_id, metadata::jsonb->>'delivery_turn_id' AS turn_id
      FROM multiremi_conversation_log WHERE session_id = ${first.chatSessionId} AND body_md = ${input.text}`;
    expect(rows).toEqual([{ body_md: input.text, to_agent_id: store.getTask(first.taskId)!.agentId, turn_id: turnId }]);
    expect(await reader`SELECT id FROM multiremi_task_steer_messages WHERE task_id = ${first.taskId}`).toHaveLength(0);
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
    const issue = createResponsibleTestIssue(store, {
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
    runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [previous.id]);
    store.completeTask(previous.id, { output: "Previous round result" });
    const chat = store.listChatSessions(fixture.workspaceId)
      .find(chat => store.getFeishuIssueIdForChatSession(chat.id) === issue.id)!;
    const wake = store.getPendingChatTask(chat.id)!;
    const leader = store.createSessionTask(session.id, { agentId: fixture.agent.id, prompt: "Current round" });
    runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [leader.id]);
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
    expect(await reader<{ status: string }[]>`SELECT status FROM multiremi_turn_execution_records WHERE id = ${leader.id}`)
      .toEqual([{ status: "running" }]);
    expect(await reader`SELECT id FROM multiremi_task_steer_messages WHERE task_id = ${wake.id}`).toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_feishu_bot_round_pushes WHERE leader_task_id = ${leader.id}`).toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_session_events WHERE task_id = ${leader.id} AND kind = 'task_completed'`).toHaveLength(0);
    expect(store.listIssueActivity(issue.id).filter(entry => entry.type === "task_completed"
      && (entry.data as { taskId?: string } | null)?.taskId === leader.id)).toHaveLength(0);
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
    const unsubscribeLog = store.subscribeConversationLog({ onEntry(sessionId, entry) {
      if (sessionId === wake.chatSessionId && "kind" in entry && entry.kind === "message" && "author_type" in entry && entry.author_type === "system") {
        events.push({ type: "log:entry", inTransaction: db.inTransaction, actorId: null, payload: { entry } });
      }
    } });
    const priorSystemMessages = store.listChatMessagesFromLog(wake.chatSessionId!).filter(message => message.role === "system").length;
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
      unsubscribeLog();
    }
    expect(store.getPendingChatTask(wake.chatSessionId!)?.id).toBe(wake.id);
    expect(store.listTaskSteerMessages(wake.id)).toHaveLength(0);
    expect(workspaceLocks.length).toBeGreaterThanOrEqual(2);
    expect(workspaceLocks.every(inTransaction => inTransaction)).toBe(true);
    expect(maxDepth).toBe(1);
    // The queued wake consumes its inbox envelope; it no longer needs a steer kick.
    const logEvents = events.filter(event => event.type === "log:entry");
    const activityEvents = events.filter(event => event.type === "activity:created");
    const terminalActivities = activityEvents.filter(event =>
      (event.payload.entry as { action?: string } | undefined)?.action === "task_completed");
    expect(logEvents).toHaveLength(1);
    expect(terminalActivities).toHaveLength(1);
    expect(logEvents[0].inTransaction).toBe(false);
    expect(activityEvents.every(event => !event.inTransaction)).toBe(true);
    expect(store.listChatMessagesFromLog(wake.chatSessionId!).filter(message => message.role === "system")).toHaveLength(priorSystemMessages + 1);
    expect(events.indexOf(logEvents[0])).toBeLessThan(events.indexOf(terminalActivities[0]));
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
    const { workspaceId, agent, runtime } = freshAgent();
    const issue = createResponsibleTestIssue(store, { title: "Steer lock order", workspaceId });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Steer me" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const locks: string[] = [];
    const events: Array<{ type: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent(event => events.push({ type: event.type, inTransaction: db.inTransaction }));
    const originalRun = db.run;
    const originalQuery = db.query;
    // Both canonical session serialization and seq allocation must follow W.
    // Capture both attempts so rollback protects the same order as commit.
    db.run = function run(sql, ...params) {
      if (sql === "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?") locks.push("workspace");
      if (/UPDATE multiremi_issue_sessions SET updated_at\s*=\s*updated_at/.test(sql)) locks.push("session");
      return originalRun.call(this, sql, ...params);
    };
    db.query = function query(sql) {
      if (sql.includes("UPDATE multiremi_conversation_heads") && sql.includes("SET head_seq = head_seq + 1")) {
        locks.push("session");
      }
      return originalQuery.call(this, sql);
    };
    maxDepth = 0;
    try {
      db.transaction(() => {
        store.createTaskSteerMessageWithinTransaction({ taskId: task.id, kind: "steer", content: "New input" });
        expect(events).toEqual([]);
      })();
      expect(events).toEqual([{ type: "daemon:task_input", inTransaction: false }, { type: "inbox:new", inTransaction: false }]);
      events.length = 0;
      expect(() => db.transaction(() => {
        store.createTaskSteerMessageWithinTransaction({ taskId: task.id, kind: "steer", content: "Rolled back" });
        expect(events).toEqual([]);
        throw new Error("rollback steer");
      })()).toThrow("rollback steer");
      expect(events).toEqual([]);
    } finally {
      db.run = originalRun;
      db.query = originalQuery;
      unsubscribe();
    }
    expect(locks).toEqual(["workspace", "workspace", "session", "session", "workspace", "workspace", "session", "session"]);
    expect(events).toEqual([]);
    expect(maxDepth).toBe(1);
    expect(store.listMessages(session.id).filter(message => message.body_md === "New input")).toHaveLength(1);
    expect(store.listMessages(session.id).filter(message => message.body_md === "Rolled back")).toHaveLength(0);
    expect(store.listTaskSteerMessages(task.id).map(message => message.content)).toEqual(["New input"]);
  });

  it("publishes terminal human-request cancellation after commit and not after rollback", () => {
    const { workspaceId, agent, runtime } = freshAgent();
    const issue = createResponsibleTestIssue(store, { title: "Terminal request", workspaceId });
    const makePending = () => {
      const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId, prompt: "Work" });
      runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET runtime_id = ?, status = 'running' WHERE id = ?", [runtime.id, task.id]);
      const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { question: "Continue?" } });
      return { task, request };
    };
    const committed = makePending();
    const transitions: Array<{ requestId: string; type: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onHumanRequest(event => transitions.push({
      requestId: event.request.id, type: event.type, inTransaction: db.inTransaction,
    }));
    try {
      db.transaction(() => {
        store.completeTask(committed.task.id, { output: "finished" });
        expect(transitions).toEqual([]);
      })();
      expect(transitions).toEqual([{ requestId: committed.request.id, type: "cancelled", inTransaction: false }]);
      expect(store.getTaskHumanRequest(committed.request.id)?.status).toBe("cancelled");

      const rolledBack = makePending();
      transitions.length = 0;
      expect(() => db.transaction(() => {
        store.completeTask(rolledBack.task.id, { output: "not committed" });
        expect(transitions).toEqual([]);
        throw new Error("rollback terminal cancellation");
      })()).toThrow("rollback terminal cancellation");
      expect(transitions).toEqual([]);
      expect(store.getTaskHumanRequest(rolledBack.request.id)?.status).toBe("pending");
    } finally { unsubscribe(); }
  });

  function organizerFixture() {
    const { workspaceId, agent: workerAgent } = freshAgent();
    const supervisorAgent = store.createAgent({
      name: "PG organizer", provider: "codex", workspaceId, role: "supervisor",
    });
    const patrol = createResponsibleTestIssue(store, { title: "PG organizer patrol", workspaceId });
    const targetIssue = createResponsibleTestIssue(store, { title: "PG organizer target", workspaceId, status: "in_progress" });
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
        if (/UPDATE multiremi_issue_sessions SET updated_at\s*=\s*updated_at/.test(sql)) {
          expect(locks.some(entry => entry.lock === "workspace")).toBe(true);
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
      expect(locks[0]?.lock).toBe("workspace");
      expect(locks.some(entry => entry.lock === "session")).toBe(true);
      expect(locks.every(entry => entry.inTransaction)).toBe(true);
      expect(result.message).toMatchObject({
        taskId: targetTask.id, kind: action, content: "Organizer input",
        authorType: "agent", authorId: supervisorAgent.id,
      });
      const directives = await reader`SELECT message_kind, body_md, sender_type, sender_id, to_agent_id
        FROM multiremi_conversation_log WHERE session_id = ${session.id}
          AND metadata::jsonb->>'steer_target_turn_id' = ${targetTask.turn_id!}`;
      if (action === "steer") expect(directives).toEqual([{ message_kind: "request", body_md: "Organizer input",
        sender_type: "agent", sender_id: supervisorAgent.id, to_agent_id: targetTask.agentId }]);
      else {
        expect(directives).toHaveLength(0);
        expect(store.getTurn(targetTask.turn_id!)!.wrap_up_requested_at).not.toBeNull();
      }
      expect(await reader`SELECT id FROM multiremi_task_steer_messages WHERE task_id = ${targetTask.id}`).toHaveLength(0);
      expect(await reader<{ action: string; target_task_id: string; report_issue_id: string }[]>`SELECT action, target_task_id, report_issue_id FROM multiremi_organizer_actions WHERE id = ${result.audit.id}`)
        .toEqual([{ action, target_task_id: targetTask.id, report_issue_id: patrol.id }]);
      expect(await reader`SELECT id FROM multiremi_conversation_log WHERE id = ${result.comment.id}`).toHaveLength(1);
      expect(await reader`SELECT id FROM multiremi_session_events WHERE session_id = ${session.id} AND kind = 'task_steer'`)
        .toHaveLength(0);
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
    expect(await reader`SELECT id FROM multiremi_conversation_log WHERE session_id = ${session.id}
      AND body_md = 'Organizer input'`).toHaveLength(0);
    expect(await reader`SELECT id FROM multiremi_conversation_log WHERE session_id = ${store.getOrCreateDefaultIssueSession(patrol.id).id}
      AND kind = 'message' AND message_kind = 'reply'`).toHaveLength(0);
    expect(events).toEqual([]);
    expect(maxDepth).toBe(1);
    expect(db.inTransaction).toBe(false);
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`rejects ${status} tasks in the caller-owned steer transaction`, () => {
      const { agent } = freshAgent();
      const task = store.createTask({ agentId: agent.id, prompt: "Terminal steer rejection" });
      runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET status = ? WHERE id = ?", [status, task.id]);
      expect(() => db.transaction(() => store.createTaskSteerMessageWithinTransaction({
        taskId: task.id, kind: "steer", content: "Too late",
      }))()).toThrow("Steer target is terminal");
      expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
    });
  }
});
