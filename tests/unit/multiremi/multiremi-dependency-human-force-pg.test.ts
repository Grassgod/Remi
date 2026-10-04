/** MUL-458 dependency force semantics on real PostgreSQL, including two-connection races. */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { signTestJwt } from "./helpers.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul458_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

function pgDatabaseUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe("SELECT 1");
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await probePostgres();
if (!pgAvailable) console.warn("[mul458-pg] Postgres unreachable; skipping MUL-458 PG checks.");

interface WorkerResult {
  phase: string;
  role: string;
  responseStatus: number | null;
  maxTransactionDepth: number;
  error?: string;
}

function workerPhase<T extends { phase?: string; error?: string }>(worker: Worker, phase: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MUL-458 race worker timed out waiting for ${phase}`));
    }, 60_000);
    const onMessage = (event: MessageEvent<T>) => {
      if (event.data.phase === "error") {
        cleanup();
        reject(new Error(event.data.error ?? "MUL-458 race worker failed"));
      } else if (event.data.phase === phase) {
        cleanup();
        resolve(event.data);
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

describe.skipIf(!pgAvailable)("MUL-458 human dependency force (PostgreSQL)", () => {
  let admin: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let counter = 0;

  beforeAll(async () => {
    admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    db?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin?.end();
  });

  async function fixture(kind: "jwt" | "pat", label: string) {
    counter += 1;
    const suffix = `${process.pid}-${counter}-${label}`;
    const user = store.getOrCreateUser({ email: `mul458-pg-${suffix}@example.test`, name: `MUL-458 PG ${label}` });
    store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: user.name, role: "member" });
    const runtime = store.registerRuntime({
      id: `rt_mul458_pg_${counter}`,
      name: `MUL-458 PG ${label}`,
      provider: "claude",
      maxConcurrency: 8,
    });
    const agent = store.createAgent({
      name: `MUL-458 PG worker ${counter}`,
      provider: "claude",
      runtimeId: runtime.id,
      visibility: "workspace",
    });
    const prerequisite = store.createIssue({ title: `PG prerequisite ${suffix}`, status: "in_progress" });
    const issue = store.createIssue({
      title: `PG waiting ${suffix}`,
      status: "backlog",
      blockedBy: [prerequisite.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const token = kind === "pat"
      ? (await store.createAccessToken({
          workspaceId: "local", userId: user.id, name: `MUL-458 PG PAT ${counter}`, type: "pat", purpose: "session",
        })).token
      : signTestJwt({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 60 });
    return {
      app: createMultiremiApp({ store, authToken: "mul458-pg-root" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      userId: user.id,
      runtime,
      agent,
      prerequisite,
      issue,
    };
  }

  const forces = (issueId: string) => store.listIssueActivity(issueId)
    .filter((entry) => entry.type === "dependency_force_started");

  it.each(["jwt", "pat"] as const)("force-starts from a %s member comment at depth 1", async (kind) => {
    const f = await fixture(kind, `comment-${kind}`);
    const emittedInsideTransaction: string[] = [];
    const stop = store.onWorkspaceEvent((event) => {
      if (db.inTransaction) emittedInsideTransaction.push(event.type);
    });
    db.resetTransactionDepthStats();
    const response = await f.app.request(`/api/issues/${f.issue.id}/comments`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ body: `PG ${kind} comment` }),
    });
    stop();
    expect(response.status).toBe(201);
    expect(db.maxTransactionDepth).toBe(1);
    expect(emittedInsideTransaction).toEqual([]);
    expect(store.getIssue(f.issue.id)?.status).toBe("todo");
    const tasks = store.listTasksForIssue(f.issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toContain("unfinished prerequisites");
    expect(forces(f.issue.id)).toHaveLength(1);
    expect(forces(f.issue.id)[0]).toMatchObject({ actorType: "member", actorId: f.userId });
    expect(forces(f.issue.id)[0]!.data).toMatchObject({ source: "comment", taskId: tasks[0]!.id });
  });

  it("covers mention, rerun, repeated comments, parent derivation and kill switch on PG", async () => {
    const ownerMention = await fixture("pat", "mention-owner");
    expect((await ownerMention.app.request(`/api/issues/${ownerMention.issue.id}/comments`, {
      method: "POST", headers: ownerMention.headers,
      body: JSON.stringify({ body: `[@Owner](mention://agent/${ownerMention.agent.id}) inspect` }),
    })).status).toBe(201);
    expect(store.listTasksForIssue(ownerMention.issue.id)[0]!.agentId).toBe(ownerMention.agent.id);
    expect(forces(ownerMention.issue.id)[0]!.data).toMatchObject({
      source: "mention", agentId: ownerMention.agent.id, assigneeDispatched: true,
    });

    const mention = await fixture("pat", "mention");
    const specialist = store.createAgent({ name: `PG specialist ${counter}`, provider: "claude", visibility: "workspace" });
    expect((await mention.app.request(`/api/issues/${mention.issue.id}/comments`, {
      method: "POST", headers: mention.headers,
      body: JSON.stringify({ body: `[@${specialist.name}](mention://agent/${specialist.id}) inspect` }),
    })).status).toBe(201);
    expect(store.listTasksForIssue(mention.issue.id)).toHaveLength(1);
    expect(store.listTasksForIssue(mention.issue.id)[0]!.agentId).toBe(specialist.id);
    expect(forces(mention.issue.id)[0]!.data).toMatchObject({
      source: "mention", agentId: specialist.id, assigneeDispatched: false,
    });

    const squadMention = await fixture("pat", "mention-squad");
    const leader = store.createAgent({ name: `PG squad leader ${counter}`, provider: "claude", visibility: "workspace" });
    const squad = store.createSquad({ name: `PG mention squad ${counter}`, leaderId: leader.id });
    store.assignIssue(squadMention.issue.id, { assigneeType: "squad", assigneeId: squad.id });
    expect((await squadMention.app.request(`/api/issues/${squadMention.issue.id}/comments`, {
      method: "POST", headers: squadMention.headers,
      body: JSON.stringify({ body: `[@${squad.name}](mention://squad/${squad.id}) inspect` }),
    })).status).toBe(201);
    expect(store.listTasksForIssue(squadMention.issue.id)[0]!.agentId).toBe(leader.id);
    expect(forces(squadMention.issue.id)[0]!.data).toMatchObject({
      source: "mention", agentId: leader.id, assigneeDispatched: true,
    });

    const rerun = await fixture("jwt", "rerun");
    const override = store.createAgent({ name: `PG override ${counter}`, provider: "claude", visibility: "workspace" });
    expect((await rerun.app.request(`/api/issues/${rerun.issue.id}/rerun`, {
      method: "POST", headers: rerun.headers, body: JSON.stringify({ agent_id: override.id }),
    })).status).toBe(202);
    expect(store.listTasksForIssue(rerun.issue.id)[0]!.agentId).toBe(override.id);
    expect(forces(rerun.issue.id)[0]!.data).toMatchObject({ source: "rerun", assigneeDispatched: false });

    const repeated = await fixture("pat", "repeated");
    for (const body of ["one", "two", "three"]) {
      expect((await repeated.app.request(`/api/issues/${repeated.issue.id}/comments`, {
        method: "POST", headers: repeated.headers, body: JSON.stringify({ body }),
      })).status).toBe(201);
    }
    expect(store.listTasksForIssue(repeated.issue.id)).toHaveLength(true ? 1 : 3);
    expect(store.listIssueActivity(repeated.issue.id).filter(activity => activity.type === "pending_turn_coalesced"))
      .toHaveLength(true ? 2 : 0);
    expect(forces(repeated.issue.id)).toHaveLength(1);

    const parentCase = await fixture("pat", "parent");
    const parent = store.createIssue({ title: `PG parent ${counter}`, status: "in_review" });
    const child = store.createIssue({
      title: `PG child ${counter}`, status: "backlog", parentIssueId: parent.id,
      blockedBy: [parentCase.prerequisite.id], assigneeType: "agent", assigneeId: parentCase.agent.id,
    });
    expect((await parentCase.app.request(`/api/issues/${child.id}/comments`, {
      method: "POST", headers: parentCase.headers, body: JSON.stringify({ body: "Start child" }),
    })).status).toBe(201);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    expect(store.listIssueActivity(parent.id).some((entry) => entry.type === "parent_status_derived")).toBe(true);

    const kill = await fixture("pat", "kill");
    const previous = process.env.MULTIREMI_DEPENDENCY_GATE;
    process.env.MULTIREMI_DEPENDENCY_GATE = "0";
    try {
      expect((await kill.app.request(`/api/issues/${kill.issue.id}/comments`, {
        method: "POST", headers: kill.headers, body: JSON.stringify({ body: "Gate disabled" }),
      })).status).toBe(201);
      expect(store.listTasksForIssue(kill.issue.id)).toHaveLength(1);
      expect(forces(kill.issue.id)).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.MULTIREMI_DEPENDENCY_GATE;
      else process.env.MULTIREMI_DEPENDENCY_GATE = previous;
    }
  });

  it("rejects task identity and strips both public force marker spellings on PG", async () => {
    const f = await fixture("pat", "identity");
    const leader = store.createAgent({ name: `PG leader ${counter}`, provider: "claude", visibility: "workspace" });
    const teammate = store.createAgent({ name: `PG teammate ${counter}`, provider: "claude", visibility: "workspace" });
    const squad = store.createSquad({ name: `PG squad ${counter}`, leaderId: leader.id, memberIds: [teammate.id] });
    const sourceIssue = store.createIssue({
      title: `PG source ${counter}`, status: "in_progress", assigneeType: "squad", assigneeId: squad.id,
    });
    const source = store.createTask({ agentId: leader.id, issueId: sourceIssue.id, prompt: "Lead" });
    store.createIssueDependency(sourceIssue.id, { dependsOnIssueId: f.prerequisite.id, type: "blocked_by" });
    store.updateIssue(sourceIssue.id, { status: "backlog" });
    const taskToken = await store.createTaskAccessToken(source, f.userId);
    const taskHeaders = { Authorization: `Bearer ${taskToken.token}`, "Content-Type": "application/json" };

    const spoofed = await f.app.request(`/api/issues/${sourceIssue.id}/comments`, {
      method: "POST", headers: taskHeaders,
      body: JSON.stringify({ body: "Pretend member", author_type: "member", author_id: f.userId }),
    });
    expect(spoofed.status).toBe(201);
    const commentId = ((await spoofed.json()) as { id: string }).id;
    expect(store.getIssueComment(commentId)).toMatchObject({ authorType: "agent", authorId: leader.id, taskId: source.id });

    const mention = await f.app.request(`/api/issues/${sourceIssue.id}/comments`, {
      method: "POST", headers: taskHeaders,
      body: JSON.stringify({ body: `[@${teammate.name}](mention://agent/${teammate.id}) help` }),
    });
    expect(mention.status).toBe(201);
    expect(store.listIssueActivity(sourceIssue.id).some((entry) =>
      entry.type === "comment_mention_skipped" && (entry.data as any)?.reason === "dependencies_unmet")).toBe(true);

    const agentRerun = await f.app.request(`/api/issues/${sourceIssue.id}/rerun`, {
      method: "POST", headers: taskHeaders, body: JSON.stringify({ agent_id: leader.id }),
    });
    expect(agentRerun.status).toBe(409);
    expect(await agentRerun.json()).toMatchObject({ code: "dependencies_unmet" });

    const agentCreate = await f.app.request("/api/multiremi/tasks", {
      method: "POST", headers: taskHeaders,
      body: JSON.stringify({ agentId: teammate.id, issueId: sourceIssue.id, prompt: "Delegate" }),
    });
    expect(agentCreate.status).toBe(409);
    expect(await agentCreate.json()).toMatchObject({ code: "dependencies_unmet" });
    expect(store.listTasksForIssue(sourceIssue.id)).toHaveLength(1);
    expect(forces(sourceIssue.id)).toHaveLength(0);

    for (const spelling of ["dependencyForce", "dependency_force"]) {
      const target = await fixture("pat", `strip-${spelling}`);
      const response = await target.app.request("/api/multiremi/tasks", {
        method: "POST", headers: target.headers,
        body: JSON.stringify({
          agentId: target.agent.id, issueId: target.issue.id, prompt: "Forged",
          [spelling]: { source: "comment", actorMemberId: target.userId },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "dependencies_unmet" });
      expect(store.listTasksForIssue(target.issue.id)).toHaveLength(0);
    }
  });

  it("keeps autopilot blocked and rolls back the transactional force path on PG", async () => {
    const f = await fixture("pat", "autopilot-rollback");
    const autopilot = store.createAutopilot({
      workspaceId: "local", title: `PG gated autopilot ${counter}`, assigneeId: f.agent.id,
      createdById: f.userId, createdByType: "member", executionMode: "trigger_issue",
    });
    const run = store.runAutopilot(autopilot.id, { triggerIssueId: f.issue.id, source: "manual" });
    expect(run).toMatchObject({ status: "skipped", failureReason: "dependencies_unmet" });

    const injected = spyOn(IssuesRepo.prototype, "recordDependencyForceStarted")
      .mockImplementation(() => { throw new Error("injected PG force audit failure"); });
    try {
      const response = await f.app.request(`/api/issues/${f.issue.id}/comments`, {
        method: "POST", headers: f.headers, body: JSON.stringify({ body: "Durable PG comment" }),
      });
      expect(response.status).toBe(400);
      expect(store.getIssue(f.issue.id)?.status).toBe("backlog");
      expect(store.listTasksForIssue(f.issue.id)).toHaveLength(0);
      expect(forces(f.issue.id)).toHaveLength(0);
      expect(store.listIssueComments(f.issue.id).some((comment) => comment.body === "Durable PG comment")).toBe(true);
    } finally {
      injected.mockRestore();
    }
  });

  async function runRace(
    issueId: string,
    prerequisiteId: string,
    agentId: string,
    roles: Array<"comment" | "rerun" | "auto">,
  ): Promise<WorkerResult[]> {
    const barrierDir = mkdtempSync(join(tmpdir(), "mul458b-two-connection-"));
    const barrierPath = join(barrierDir, "go");
    const workerUrl = new URL("./fixtures/postgres-two-connection-race-worker.ts", import.meta.url);
    const entries = roles.map((role) => {
      const worker = new Worker(workerUrl, { type: "module" });
      const ready = workerPhase(worker, "ready");
      const done = workerPhase<WorkerResult>(worker, "done");
      worker.postMessage({
        databaseUrl: pgDatabaseUrl(TEST_DB), issueId, prerequisiteId, agentId, barrierPath, role,
      });
      return { worker, ready, done };
    });
    try {
      await Promise.all(entries.map((entry) => entry.ready));
      writeFileSync(barrierPath, "go");
      return await Promise.all(entries.map((entry) => entry.done));
    } finally {
      entries.forEach((entry) => entry.worker.terminate());
      rmSync(barrierDir, { recursive: true, force: true });
    }
  }

  it("serializes concurrent human comment and rerun across two PG connections", async () => {
    const f = await fixture("pat", "race-comment-rerun");
    const results = await runRace(f.issue.id, f.prerequisite.id, f.agent.id, ["comment", "rerun"]);
    expect(results.map((result) => result.responseStatus).sort()).toEqual([201, 202]);
    expect(results.every((result) => result.maxTransactionDepth === 1)).toBe(true);
    const tasks = store.listTasksForIssue(f.issue.id);
    const merges = store.listIssueActivity(f.issue.id).filter(entry => entry.type === "pending_turn_coalesced");
    expect(merges.length).toBeLessThanOrEqual(true ? 1 : 0);
    expect(tasks).toHaveLength(2 - merges.length);
    expect(tasks.some((task) => task.status === "cancelled")).toBe(false);
    expect(forces(f.issue.id)).toHaveLength(1);
    expect(store.getIssue(f.issue.id)?.status).toBe("todo");
  });

  it("serializes concurrent human comment and automatic start across two PG connections", async () => {
    const f = await fixture("pat", "race-comment-auto");
    const results = await runRace(f.issue.id, f.prerequisite.id, f.agent.id, ["comment", "auto"]);
    expect(results.every((result) => result.responseStatus !== 409)).toBe(true);
    expect(results.every((result) => result.maxTransactionDepth === 1)).toBe(true);
    const tasks = store.listTasksForIssue(f.issue.id);
    expect(tasks.some((task) => task.status === "cancelled")).toBe(false);
    const forceCount = forces(f.issue.id).length;
    const autoCount = store.listIssueActivity(f.issue.id)
      .filter((entry) => entry.type === "dependency_auto_started").length;
    expect(forceCount + autoCount).toBe(1);
    const merges = store.listIssueActivity(f.issue.id).filter(entry => entry.type === "pending_turn_coalesced");
    expect(merges).toHaveLength(true ? autoCount : 0);
    expect(tasks).toHaveLength(1 + autoCount - merges.length);
    expect(store.getIssue(f.issue.id)?.status).toBe("todo");
  });
});
