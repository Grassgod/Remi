import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function exerciseDecisions(store: MultiremiStore): Promise<void> {
  store.ensureLocalWorkspace();
  const member = store.findWorkspaceMemberForUser("local", "local")!;
  const owner = store.createAgent({ name: "Decision parent owner", provider: "codex", ownerId: member.id });
  const sourceAgent = store.createAgent({ name: "Decision source owner", provider: "codex" });
  const unrelated = store.createAgent({ name: "Unrelated agent", provider: "codex" });
  const parent = store.createIssue({ title: "Decision parent", assigneeType: "agent", assigneeId: owner.id });
  const source = store.createIssue({ title: "Decision source", parentIssueId: parent.id, assigneeType: "agent", assigneeId: sourceAgent.id });
  const ownerTask = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Current parent round" });
  const sourceTask = store.createTask({ agentId: sourceAgent.id, issueId: source.id, prompt: "Current source round" });
  const foreignTask = store.createTask({ agentId: unrelated.id, issueId: parent.id, prompt: "Unrelated round" });
  store.addIssueSubscriber(parent.id, member.id);
  const [ownerToken, sourceToken, foreignToken, memberToken] = await Promise.all([
    store.createTaskAccessToken(ownerTask, "local"),
    store.createTaskAccessToken(sourceTask, "local"),
    store.createTaskAccessToken(foreignTask, "local"),
    store.createAccessToken({ name: "Decision member", type: "pat", workspaceId: "local", userId: "local" }),
  ]);
  const app = createMultiremiApp({ store, authToken: "test-master" });
  const events: string[] = [];
  const unsubscribe = store.onWorkspaceEvent((event) => events.push(event.type));
  const request = (path: string, token: string, body?: unknown) => app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const create = async (issueId: string, token: string, kind: string, title: string) => {
    const response = await request(`/api/issues/${issueId}/decisions`, token, {
      kind, title, body: `${title} context`, createdByAgentId: unrelated.id,
      sourceTaskId: foreignTask.id, ownerAgentId: unrelated.id, status: "answered",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()).decision as { id: string; status: string; issueId: string; createdByAgentId: string | null; sourceTaskId: string | null };
  };
  try {
    const first = await create(source.id, sourceToken.token, "merge", "Merge the change");
    const second = await create(source.id, sourceToken.token, "permission", "Access the resource");
    expect(first).toMatchObject({ status: "pending", issueId: parent.id, createdByAgentId: sourceAgent.id, sourceTaskId: sourceTask.id });
    expect(store.listTasksForIssue(parent.id).filter((task) => task.agentId === owner.id && task.status === "queued")).toHaveLength(1);
    const parentPrompt = store.getTask(ownerTask.id)?.prompt ?? "";
    expect(parentPrompt).toContain(first.id);
    expect(parentPrompt).toContain(second.id);
    expect(store.listInboxItems(member.id).filter((item) => item.type === "decision_requested")).toHaveLength(0);

    const answerPath = `/api/issues/${parent.id}/decisions/${first.id}/answer`;
    for (const token of [sourceToken.token, foreignToken.token]) {
      const denied = await request(answerPath, token, { answer: "spoofed", reason: "r", overturn: "o", answererType: "member", answererId: member.id });
      expect(denied.status).toBe(403);
    }
    const missingReason = await request(answerPath, ownerToken.token, { answer: "yes", answererType: "member", answererId: member.id });
    expect(missingReason.status).toBe(400);
    const ownerAnswer = await request(answerPath, ownerToken.token, {
      answer: "Merge after CI", reason: "Checks passed", overturn: "A member can reverse this if QA fails",
      answererType: "member", answererId: member.id,
    });
    expect(ownerAnswer.status, await ownerAnswer.clone().text()).toBe(200);
    expect(store.getIssueDecision(parent.id, first.id)).toMatchObject({
      status: "answered", answeredByMemberId: null, answer: { answererType: "agent", answererId: owner.id,
        answer: "Merge after CI", reason: "Checks passed", overturn: "A member can reverse this if QA fails" },
    });
    expect(store.getTask(sourceTask.id)?.prompt).toContain(`decision:${first.id}`);
    expect(store.listIssueActivity(parent.id).some((entry) => entry.type === "decision_answered" && entry.actorType === "agent")).toBe(true);
    expect(store.listIssueActivity(source.id).some((entry) => entry.type === "decision_received")).toBe(true);

    const revised = await request(answerPath, memberToken.token, {
      answer: "Hold for QA", reason: "Human review", answererType: "agent", answererId: unrelated.id,
    });
    expect(revised.status, await revised.clone().text()).toBe(200);
    const history = store.getIssueDecision(parent.id, first.id)!.history;
    expect(history.map((entry) => entry.answererType)).toEqual(["agent", "member"]);
    expect(history[1]?.answererId).toBe(member.id);
    expect(store.getIssueDecision(parent.id, first.id)?.answeredByMemberId).toBe(member.id);
    expect(store.getIssueDecision(parent.id, first.id)?.answeredAt).toBe(history[1]?.answeredAt);
    expect(store.getTask(ownerTask.id)?.prompt).toContain(`member changed your answer to decision ${first.id}`);
    expect(store.getTask(sourceTask.id)?.prompt).toContain("Hold for QA");

    const escalated = await request(`/api/issues/${parent.id}/decisions/${second.id}/escalate`, ownerToken.token, {});
    expect(escalated.status, await escalated.clone().text()).toBe(200);
    expect(store.getIssueDecision(parent.id, second.id)?.status).toBe("escalated");
    expect((await request(`/api/issues/${parent.id}/decisions/${second.id}/answer`, ownerToken.token, {
      answer: "no", reason: "r", overturn: "o",
    })).status).toBe(403);
    const prod = await create(source.id, sourceToken.token, "production_change", "Deploy to production");
    expect(prod.status).toBe("escalated");
    expect((await request(`/api/issues/${parent.id}/decisions/${prod.id}/answer`, ownerToken.token, {
      answer: "yes", reason: "r", overturn: "o",
    })).status).toBe(403);
    const items = store.listInboxItems(member.id).filter((item) => item.type === "decision_requested");
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.severity === "action")).toBe(true);
    expect(store.listIssueActivity(parent.id).some((entry) => entry.type === "decision_escalated")).toBe(true);

    const criteriaPending = await create(source.id, sourceToken.token, "criteria", "Acceptance terms");
    const questionPending = await create(source.id, sourceToken.token, "question", "Which branch");

    const parentHuman = store.createTask({ agentId: owner.id, issueId: parent.id, prompt: "Human request" });
    const human = store.createTaskHumanRequest({ taskId: parentHuman.id, kind: "question", payload: { message: "Pick a date" } });
    const list = await request(`/api/issues/${parent.id}/decisions`, memberToken.token);
    expect(list.status).toBe(200);
    const model = await list.json();
    expect(model.count).toBe(3);
    expect(model.waiting_on_human.map((entry: { id: string }) => entry.id)).toEqual([second.id, prod.id, human.id]);
    expect(model.owner_and_answered.answered[0].id).toBe(first.id);
    expect(model.owner_and_answered.pending.map((entry: { id: string }) => entry.id)).toEqual([questionPending.id, criteriaPending.id]);
    const detail = await request(`/api/issues/${parent.id}`, memberToken.token);
    expect((await detail.json()).pending_decision_count).toBe(3);
    const native = await request(`/api/multiremi/issues/${parent.id}`, memberToken.token);
    expect((await native.json()).issue.pending_decision_count).toBe(3);

    const memberAnswer = await request(`/api/issues/${parent.id}/decisions/${prod.id}/answer`, memberToken.token, {
      answer: "Approved for the maintenance window", answererType: "agent", answererId: unrelated.id,
    });
    expect(memberAnswer.status).toBe(200);
    expect(store.getIssueDecision(parent.id, prod.id)?.answer?.answererType).toBe("member");

    const noParent = store.createIssue({ title: "No parent" });
    expect((await create(noParent.id, memberToken.token, "criteria", "Define done")).status).toBe("escalated");
    const humanParent = store.createIssue({ title: "Member parent", assigneeType: "member", assigneeId: member.id });
    const humanChild = store.createIssue({ title: "Member child", parentIssueId: humanParent.id });
    expect((await create(humanChild.id, memberToken.token, "question", "Choose direction")).status).toBe("escalated");
    const squad = store.createSquad({ name: "Decision squad", leaderId: owner.id });
    const squadParent = store.createIssue({ title: "Squad parent", assigneeType: "squad", assigneeId: squad.id });
    const squadChild = store.createIssue({ title: "Squad child", parentIssueId: squadParent.id });
    expect((await create(squadChild.id, memberToken.token, "criteria", "Set acceptance")).status).toBe("pending");

    const pending = await create(source.id, sourceToken.token, "criteria", "Withdraw this");
    const withdrawn = await request(`/api/issues/${parent.id}/decisions/${pending.id}/withdraw`, sourceToken.token, {});
    expect(withdrawn.status).toBe(200);
    expect(store.getIssueDecision(parent.id, pending.id)?.status).toBe("withdrawn");
    expect(events).toContain("decision:created");
    expect(events).toContain("decision:updated");
  } finally {
    unsubscribe();
  }
}

describe("MUL-400 S4 decisions on SQLite", () => {
  it("covers parent ownership, identity, escalation, revision, read model, and events", async () => {
    await exerciseDecisions(createStore());
  });
});

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let pgAvailable = false;
if (pgAdminUrl) {
  try {
    const probe = new Bun.SQL(pgAdminUrl, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    pgAvailable = true;
  } catch { /* The PG suite reports a skip when this machine has no instance. */ }
}

describe.skipIf(!pgAvailable)("MUL-400 S4 decisions on PostgreSQL", () => {
  const databaseName = `mul410_decisions_${process.pid}`;
  let admin: Bun.SQL;
  let database: PostgresSyncDatabase;
  let store: MultiremiStore;
  let maxDepth = 0;

  beforeAll(async () => {
    admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const url = new URL(pgAdminUrl!);
    url.pathname = `/${databaseName}`;
    database = new PostgresSyncDatabase(url.toString());
    const original = database.transaction.bind(database);
    let depth = 0;
    (database as unknown as { transaction: unknown }).transaction = (fn: () => unknown) => {
      const run = original(fn);
      return () => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        try { return run(); } finally { depth--; }
      };
    };
    store = new MultiremiStore(database);
  });

  afterAll(async () => {
    database?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("runs the acceptance flow without nested transactions", async () => {
    await exerciseDecisions(store);
    expect(maxDepth).toBe(1);
  });
});
