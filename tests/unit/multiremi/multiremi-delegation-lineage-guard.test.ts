/**
 * MUL-456 fix round 1: `parent_task_id` is credential-owned lineage.
 *
 * QA round 1 found that a member PAT could plant `parent_task_id` through the
 * Issue Session task route (the route stamped camelCase only, the store read
 * `camel ?? snake`), and that the planted row then satisfied D4's
 * `parent_task_id = T.id AND wake_source IS NULL` predicate — swallowing the
 * delegator's real return with `covered_by_delegate_wakeup`.
 *
 * These cases drive the real HTTP surfaces, so they cover the route + store
 * pair, not the store alone. Every assertion also checks the *effect* the
 * forgery would have had: after T ends, the return must be there.
 */
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;

/**
 * The PG fixture creates and drops a database per case; that exceeds bun's 5 s
 * default on a cold bridge, so these cases get room without slowing SQLite.
 */
const PG_TEST_TIMEOUT = 30_000;

async function withStore(backend: "sqlite" | "postgres", run: (store: MultiremiStore) => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const db = openSqliteDatabase(":memory:");
    try {
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      await run(store);
    } finally {
      db.close();
    }
    return;
  }
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  const name = `mul456f1_${process.pid}_${++sequence}`;
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  let db: PostgresSyncDatabase | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    await run(store);
  } finally {
    db?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

interface Fixture {
  app: ReturnType<typeof createMultiremiApp>;
  memberHeaders: Record<string, string>;
  leaderTokenHeaders: Record<string, string>;
  leaderRuntimeId: string;
  workerRuntimeId: string;
  leaderId: string;
  workerId: string;
  parent: MultiremiIssue;
  child: MultiremiIssue;
  leaderSessionId: string;
  /** The leader's own task — the credential that dispatched, i.e. the source. */
  sourceTask: MultiremiTask;
  /** The dispatched child-issue task QA's forgery targeted: `T`. */
  delegatedTask: MultiremiTask;
  innocentTask: MultiremiTask;
}

/** Parent (squad leader) → child on another issue → the task the leader dispatched. */
async function fixture(store: MultiremiStore, authToken?: string): Promise<Fixture> {
  const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "claude", workspaceId: "local" });
  const workerRuntime = store.registerRuntime({ name: "Worker runtime", provider: "claude", workspaceId: "local" });
  const leader = store.createAgent({
    name: "Leader", provider: "claude", runtimeId: leaderRuntime.id, visibility: "workspace",
  });
  const worker = store.createAgent({
    name: "Worker", provider: "claude", runtimeId: workerRuntime.id, visibility: "workspace",
  });
  const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [worker.id] });
  const parent = store.createIssue({
    title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id,
  });
  const child = store.createIssue({
    title: "Child", parentIssueId: parent.id, status: "in_progress", assigneeType: "agent", assigneeId: worker.id,
  });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const sourceTask = store.createTask({
    agentId: leader.id, issueId: parent.id, issueSessionId: leaderSession.id, prompt: "Coordinate.",
  });
  const app = createMultiremiApp(authToken ? { store, authToken } : { store });

  // The delegation under test: the leader's own token dispatches the worker on
  // the child issue. The resulting row is the real `T` the forgery targets.
  const dispatchToken = await store.createTaskAccessToken(sourceTask, "local");
  const dispatchResponse = await app.request("/api/multiremi/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${dispatchToken.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: worker.id, issueId: child.id, prompt: "Execute delegated work." }),
  });
  expect(dispatchResponse.status).toBe(201);
  const delegatedTask = store.getTask(((await dispatchResponse.json()) as { task: { id: string } }).task.id)!;
  expect(delegatedTask.delegatedByAgentId).toBe(leader.id);
  expect(delegatedTask.delegatedFromIssueSessionId).toBe(leaderSession.id);
  // A member PAT for the same workspace.
  const user = store.getOrCreateUser({ email: `lineage-${parent.id}@example.test`, name: "Lineage member" });
  store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: "Lineage member", role: "member" });
  const pat = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name: "member", type: "pat", purpose: "session",
  });
  // An unrelated task the caller would like the forged lineage to name.
  const innocentTask = store.createTask({ agentId: leader.id, issueId: child.id, prompt: "Innocent" });

  return {
    app,
    memberHeaders: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
    leaderTokenHeaders: { Authorization: `Bearer ${dispatchToken.token}`, "Content-Type": "application/json" },
    leaderRuntimeId: leaderRuntime.id,
    workerRuntimeId: workerRuntime.id,
    leaderId: leader.id,
    workerId: worker.id,
    parent,
    child,
    leaderSessionId: leaderSession.id,
    sourceTask,
    delegatedTask,
    innocentTask,
  };
}

/** Every spawn spelling QA named, plus the nested shapes the brief called out. */
const FORGED_SPELLINGS: Array<[string, Record<string, unknown>]> = [
  ["snake", { parent_task_id: "TARGET" }],
  ["camel", { parentTaskId: "TARGET" }],
  ["both", { parentTaskId: "TARGET", parent_task_id: "TARGET" }],
  ["nested options", { options: { parent_task_id: "TARGET" } }],
  ["nested data", { data: { parentTaskId: "TARGET", parent_task_id: "TARGET" } }],
];

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-456 lineage guard (${backend})`, () => {
    it("drops every parent_task_id spelling a member PAT sends to the Session task route", async () => {
      for (const [label, forged] of FORGED_SPELLINGS) {
        await withStore(backend, async (store) => {
          const f = await fixture(store, "lineage-guard-root");
          const body = JSON.parse(JSON.stringify(forged).replaceAll("TARGET", f.delegatedTask.id)) as Record<string, unknown>;
          const response = await f.app.request(`/api/issues/${f.parent.id}/sessions/${f.leaderSessionId}/tasks`, {
            method: "POST",
            headers: f.memberHeaders,
            body: JSON.stringify({ agentId: f.leaderId, prompt: `wake ${label}`, ...body }),
          });
          expect(response.status, label).toBe(201);
          const created = store.getTask(((await response.json()) as { id: string }).id)!;
          // The credential carries no task, so the only correct value is null.
          expect(created.parentTaskId, label).toBeNull();

          // And the plant cannot swallow the real return. T ends; the report
          // lands on the leader's queued round for that session. That round is
          // the normal coalescing target (`covered_by_queued_task`), not the D4
          // manual-wakeup suppression this fix closes.
          store.cancelTask(f.delegatedTask.id);
          const covered = store.getTask(f.delegatedTask.id)?.delegationReturnTaskId;
          expect(covered, label).not.toBeNull();
          const skipped = store.listIssueActivity(f.child.id)
            .filter((activity) => activity.type === "delegation_return_skipped")
            .map((activity) => (activity.data as Record<string, unknown>).reason);
          expect(skipped, label).not.toContain("covered_by_delegate_wakeup");
          expect(skipped, label).toContain("covered_by_queued_task");
          // The report really reached the dispatcher's Session instead of being
          // dropped: the terminal transaction appended the bridge event that
          // the leader's next round projects.
          const bridge = store.listSessionEvents(f.leaderSessionId)
            .find((event) => event.kind === "delegation_report" && event.taskId === f.delegatedTask.id);
          expect(bridge, label).toBeDefined();
          expect((bridge!.metadata as Record<string, unknown>).terminal_status, label).toBe("cancelled");
        });
      }
    }, PG_TEST_TIMEOUT);

    it("keeps the token-derived lineage when a task token sends another task's id", async () => {
      for (const [label, forged] of FORGED_SPELLINGS) {
        // A terminal task revokes its own token, so each spelling gets a fresh
        // dispatch credential rather than reusing one across iterations.
        await withStore(backend, async (store) => {
          const f = await fixture(store, "lineage-guard-root");
          const body = JSON.parse(JSON.stringify(forged).replaceAll("TARGET", f.innocentTask.id)) as Record<string, unknown>;
          const response = await f.app.request(`/api/issues/${f.parent.id}/sessions/${f.leaderSessionId}/tasks`, {
            method: "POST",
            headers: f.leaderTokenHeaders,
            body: JSON.stringify({ agentId: f.leaderId, prompt: `token dispatch ${label}`, ...body }),
          });
          expect(response.status, label).toBe(201);
          const created = store.getTask(((await response.json()) as { id: string }).id)!;
          // The credential's own task wins; the body never contributes.
          expect(created.parentTaskId, label).toBe(f.sourceTask.id);
          expect(created.parentTaskId, label).not.toBe(f.innocentTask.id);
        });
      }
    }, PG_TEST_TIMEOUT);

    it("drops parent_task_id on the assign route for a member PAT", async () => {
      await withStore(backend, async (store) => {
        const f = await fixture(store, "lineage-guard-root");
        for (const [label, forged] of FORGED_SPELLINGS) {
          const body = JSON.parse(JSON.stringify(forged).replaceAll("TARGET", f.delegatedTask.id)) as Record<string, unknown>;
          const response = await f.app.request(`/api/multiremi/issues/${f.child.id}/assign`, {
            method: "POST",
            headers: f.memberHeaders,
            body: JSON.stringify({ assigneeType: "agent", assigneeId: f.workerId, prompt: `assign ${label}`, ...body }),
          });
          const payload = await response.json() as { task?: { id: string } | null; error?: string };
          expect(response.status, `${label} ${JSON.stringify(payload)}`).toBe(200);
          // The child already has this agent on the task, so the assign may
          // coalesce; the assertion that matters is that nothing new carries
          // forged lineage.
          const forgedTasks = store.listTasksForIssue(f.child.id)
            .filter((task) => task.parentTaskId === f.delegatedTask.id);
          expect(forgedTasks, label).toHaveLength(0);
        }
      });
    }, PG_TEST_TIMEOUT);

    it("drops parent_task_id on the rerun route for a member PAT", async () => {
      await withStore(backend, async (store) => {
        const f = await fixture(store, "lineage-guard-root");
        for (const [label, forged] of FORGED_SPELLINGS) {
          const body = JSON.parse(JSON.stringify(forged).replaceAll("TARGET", f.delegatedTask.id)) as Record<string, unknown>;
          const response = await f.app.request(`/api/issues/${f.parent.id}/rerun`, {
            method: "POST", headers: f.memberHeaders,
            body: JSON.stringify({ agentId: f.leaderId, prompt: `rerun ${label}`, ...body }),
          });
          expect(response.status, label).toBe(202);
          const created = store.getTask(((await response.json()) as { id: string }).id)!;
          expect(created.parentTaskId, label).toBeNull();
        }
      });
    }, PG_TEST_TIMEOUT);

    it("cannot steer the trigger-comment lineage fallback through the public task route", async () => {
      // Third door to the same field: the store falls back to
      // `triggerComment.taskId`, and a delegated run's own comment carries that
      // run's task id — which a member can read. Naming it here would otherwise
      // produce the same D4 suppression as a forged `parent_task_id`.
      await withStore(backend, async (store) => {
        const f = await fixture(store, "lineage-guard-root");
        // The comment sits on the parent issue, where the wake task is created,
        // and carries the delegated run's task id — exactly what a member would
        // read back from the run's own progress notes.
        const workerComment = store.createIssueComment(f.parent.id, {
          authorType: "agent", authorId: f.workerId, taskId: f.delegatedTask.id,
          issueSessionId: f.leaderSessionId, body: "Worker progress note",
        });
        for (const spelling of ["triggerCommentId", "trigger_comment_id"] as const) {
          const response = await f.app.request("/api/multiremi/tasks", {
            method: "POST",
            headers: f.memberHeaders,
            body: JSON.stringify({
              agentId: f.leaderId,
              issueId: f.parent.id,
              issueSessionId: f.leaderSessionId,
              prompt: `trigger-comment ${spelling}`,
              [spelling]: workerComment.id,
            }),
          });
          expect(response.status, spelling).toBe(201);
          const created = store.getTask(((await response.json()) as { task: { id: string } }).task.id)!;
          expect(created.parentTaskId, spelling).toBeNull();
          // MUL-448 made the trigger itself server-owned too. The public body
          // cannot retain the comment pointer or use its task link as lineage.
          expect(created.triggerCommentId, spelling).toBeNull();
        }
      });
    }, PG_TEST_TIMEOUT);

    it("drops parent_task_id on the Chat message routes for a member PAT", async () => {
      await withStore(backend, async (store) => {
        const f = await fixture(store, "lineage-guard-root");
        const member = store.listWorkspaceMembers("local").find((row) => row.role === "member")!;
        const chat = store.createChatSession({ agentId: f.leaderId, creatorId: member.userId ?? member.id });
        for (const [label, forged] of FORGED_SPELLINGS) {
          const body = JSON.parse(JSON.stringify(forged).replaceAll("TARGET", f.delegatedTask.id)) as Record<string, unknown>;
          for (const path of [`/api/multiremi/chats/${chat.id}/messages`, `/api/chat/sessions/${chat.id}/messages`]) {
            const response = await f.app.request(path, {
              method: "POST", headers: f.memberHeaders,
              body: JSON.stringify({ content: `chat ${label}`, ...body }),
            });
            expect(response.status, `${path} ${label}`).toBe(201);
            const payload = await response.json() as { task?: { id: string }; task_id?: string };
            const created = store.getTask(payload.task?.id ?? payload.task_id!)!;
            expect(created.parentTaskId, `${path} ${label}`).toBeNull();
          }
        }
      });
    }, PG_TEST_TIMEOUT);

    it("drops the forged comment task link that the mention dispatcher would inherit", async () => {
      await withStore(backend, async (store) => {
        const f = await fixture(store, "lineage-guard-root");
        // A comment body naming another run is lineage too: the mention
        // dispatcher reads `comment.task_id` back as `sourceTask`, and
        // `createTask` turns that into the spawned task's `parent_task_id`.
        const commentResponse = await f.app.request(`/api/issues/${f.parent.id}/sessions/${f.leaderSessionId}/messages`, {
          method: "POST",
          headers: f.memberHeaders,
          body: JSON.stringify({
            body: `[@Leader](mention://agent/${f.leaderId}) please wake`,
            task_id: f.delegatedTask.id,
            taskId: f.delegatedTask.id,
          }),
        });
        expect(commentResponse.status).toBe(201);
        const comment = store.getIssueComment(
          ((await commentResponse.json()) as { id: string }).id,
        )!;
        expect(comment.taskId).toBeNull();
        const mentioned = store.listTasksForIssue(f.parent.id)
          .filter((task) => task.triggerCommentId === comment.id);
        expect(mentioned).toHaveLength(1);
        expect(mentioned[0]!.parentTaskId).toBeNull();
      });
    }, PG_TEST_TIMEOUT);

    it("pins the anonymous compatibility behaviour of every creation route", async () => {
      // Anonymous = auth disabled (no `authToken`) or the deployment master
      // token. MUL-448 made both lineage spellings server-owned for every caller,
      // so the merge must not re-open the snake_case alias in either mode.
      for (const [mode, authToken] of [["auth-disabled", undefined], ["master-token", "lineage-guard-root"]] as const) {
        await withStore(backend, async (store) => {
          const f = await fixture(store, authToken);
          const headers: Record<string, string> = authToken
            ? { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" }
            : { "Content-Type": "application/json" };
          const snakeResponse = await f.app.request(`/api/issues/${f.parent.id}/sessions/${f.leaderSessionId}/tasks`, {
            method: "POST", headers,
            body: JSON.stringify({ agentId: f.leaderId, prompt: "anon snake", parent_task_id: f.delegatedTask.id }),
          });
          expect(snakeResponse.status, mode).toBe(201);
          const snakeTask = store.getTask(((await snakeResponse.json()) as { id: string }).id)!;
          expect(snakeTask.parentTaskId, mode).toBeNull();

          const camelResponse = await f.app.request(`/api/issues/${f.parent.id}/sessions/${f.leaderSessionId}/tasks`, {
            method: "POST", headers,
            body: JSON.stringify({ agentId: f.leaderId, prompt: "anon camel", parentTaskId: f.delegatedTask.id }),
          });
          expect(camelResponse.status, mode).toBe(201);
          const camelTask = store.getTask(((await camelResponse.json()) as { id: string }).id)!;
          expect(camelTask.parentTaskId, mode).toBeNull();

          // The public task route was already strict there — it destructured
          // both spellings before this round — so the compat modes must not
          // start honouring the alias.
          for (const [label, forged] of FORGED_SPELLINGS) {
            const body = JSON.parse(JSON.stringify(forged).replaceAll("TARGET", f.delegatedTask.id)) as Record<string, unknown>;
            const response = await f.app.request("/api/multiremi/tasks", {
              method: "POST", headers,
              body: JSON.stringify({ agentId: f.leaderId, issueId: f.parent.id, prompt: `anon ${label}`, ...body }),
            });
            expect(response.status, `${mode} ${label}`).toBe(201);
            const created = store.getTask(((await response.json()) as { task: { id: string } }).task.id)!;
            expect(created.parentTaskId, `${mode} ${label}`).toBeNull();
          }
        });
      }
    }, PG_TEST_TIMEOUT);

    it("keeps an explicit null parent authoritative in the forced-start activity", async () => {
      await withStore(backend, async (store) => {
        const f = await fixture(store, "lineage-guard-root");
        const prerequisite = store.createIssue({ title: "Open prerequisite", status: "in_progress" });
        const waiting = store.createIssue({
          title: "Waiting force target",
          status: "backlog",
          blockedBy: [prerequisite.id],
          assigneeType: "agent",
          assigneeId: f.leaderId,
        });

        // The HTTP boundary strips both body spellings and stamps camelCase null.
        // Reattach the same snake alias at the store seam to pin the lower-level
        // compatibility contract without making the public route trust the body.
        const updateIssueWithOutcome = store.updateIssueWithOutcome.bind(store);
        store.updateIssueWithOutcome = ((issueId, input, options) => updateIssueWithOutcome(issueId, {
          ...input,
          parentTaskId: null,
          parent_task_id: f.delegatedTask.id,
        }, options)) as typeof store.updateIssueWithOutcome;

        const response = await f.app.request(`/api/multiremi/issues/${waiting.id}`, {
          method: "PATCH",
          headers: f.memberHeaders,
          body: JSON.stringify({
            status: "todo",
            force: true,
            parentTaskId: null,
            parent_task_id: f.delegatedTask.id,
          }),
        });
        expect(response.status).toBe(200);
        const activity = store.listIssueActivity(waiting.id)
          .find((entry) => entry.type === "dependency_force_started");
        expect(activity).toBeDefined();
        expect(activity?.data).not.toHaveProperty("sourceTaskId");
        expect(activity?.data).not.toHaveProperty("source_task_id");
      });
    }, PG_TEST_TIMEOUT);

    it("treats an explicit null parentTaskId as authoritative inside the store", async () => {
      // The store-side half of the rule. Every public route now strips both
      // spellings, so this contract is what keeps a route that stamps an
      // explicit `parentTaskId: null` (the historical shape, and the shape any
      // future route may use) from falling back to a snake_case alias:
      // `camel ?? snake` would return the forged id, `resolveCamelOrSnakeString`
      // keeps the null. It fails if that read is reverted, independently of the
      // route strips above.
      await withStore(backend, async (store) => {
        const f = await fixture(store, "lineage-guard-root");
        const created = store.createSessionTask(f.leaderSessionId, {
          agentId: f.leaderId,
          prompt: "direct store call",
          parentTaskId: null,
          parent_task_id: f.delegatedTask.id,
        });
        expect(created.parentTaskId).toBeNull();

        // The unambiguous positive control: quoting the same id through the
        // camelCase key still works, so the assertion above is not vacuous.
        const honoured = store.createSessionTask(f.leaderSessionId, {
          agentId: f.leaderId,
          prompt: "direct store call, honoured",
          parentTaskId: f.delegatedTask.id,
        });
        expect(honoured.parentTaskId).toBe(f.delegatedTask.id);
      });
    }, PG_TEST_TIMEOUT);
  });
}
