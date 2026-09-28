import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";

const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !pgUrl)(`MUL-467 deletion transaction (${dialect})`, () => {
    let db: SqlDatabase & { readonly inTransaction: boolean };
    let store: MultiremiStore;
    let admin: Bun.SQL | undefined;
    let reader: Bun.SQL | undefined;
    let workspaceId: string;
    let sequence = 0;
    let depth = 0;
    let maxTransactionDepth = 0;
    let tables: string[];
    const databaseName = `mul467_atomic_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

    beforeAll(async () => {
      if (dialect === "postgres") {
        admin = new Bun.SQL(pgUrl!, { max: 1 });
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(pgUrl!);
        url.pathname = `/${databaseName}`;
        db = new PostgresSyncDatabase(url.toString());
        reader = new Bun.SQL(url.toString(), { max: 1 });
      } else {
        db = new Database(":memory:");
      }
      store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      const tableRows = db.query(dialect === "postgres"
        ? "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'"
        : "SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      tables = tableRows.map(row => row.name).filter(name => /^multiremi_[a-z_]+$/.test(name)).sort();
      const transaction = db.transaction.bind(db);
      db.transaction = function trackedTransaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
        const run = transaction(fn);
        return (...args: any[]) => {
          depth += 1;
          maxTransactionDepth = Math.max(maxTransactionDepth, depth);
          try {
            return run(...args);
          } finally {
            depth -= 1;
          }
        };
      };
    });

    beforeEach(() => {
      workspaceId = store.createWorkspace({
        name: `Atomic deletion ${dialect} ${++sequence}`,
        slug: `mul467-atomic-${dialect}-${sequence}`,
      }).id;
    });

    afterAll(async () => {
      db?.close();
      await reader?.end();
      await admin?.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin?.end();
    });

    async function graph() {
      const result: Record<string, string[]> = {};
      for (const table of tables) {
        const sql = `SELECT * FROM "${table}"`;
        // PostgreSQL readback deliberately uses a different connection.
        const rows: Record<string, unknown>[] = reader ? Array.from(await reader.unsafe(sql)) : db.query(sql).all();
        result[table] = rows.map(row => JSON.stringify(row)).sort();
      }
      return result;
    }

    function fixture(cascade: boolean) {
      const daemonId = `daemon_${workspaceId}`;
      const runtime = store.registerRuntime({
        id: `rt_${workspaceId}`, name: "Delete atomically", provider: "codex", workspaceId, daemonId,
      });
      store.registerRuntime({
        id: `sibling_${workspaceId}`, name: "Sibling", provider: "claude", workspaceId, daemonId,
      });
      const agent = store.createAgent({
        name: "Deletion worker", provider: "codex", workspaceId, runtimeId: runtime.id,
      });
      const project = store.createProject({
        title: "Deletion defaults", workspaceId, defaultAssigneeType: "agent", defaultAssigneeId: agent.id,
      });
      const autopilot = store.createAutopilot({
        title: "Deletion automation", workspaceId, assigneeId: agent.id, executionMode: "run_only", status: "active",
      });
      const parent = store.createIssue({ title: "Parent", workspaceId, status: "in_progress" });
      const issue = store.createIssue({
        title: "Workspace and child status", workspaceId, projectId: project.id, parentIssueId: parent.id,
      });
      store.reportIssueWorkspace({
        issueId: issue.id, runtimeId: runtime.id, rootPath: `/work/${issue.key}`,
        branchName: `agent/${issue.key}`, status: "ready",
      });
      const tasks = cascade ? [
        store.createTask({ agentId: agent.id, runtimeId: runtime.id, issueId: issue.id, prompt: "Original running request" }),
        store.createTask({ agentId: agent.id, runtimeId: runtime.id, issueId: issue.id, prompt: "Original queued request" }),
      ] : [];
      if (cascade) {
        const completed = store.createTask({ agentId: agent.id, runtimeId: runtime.id, prompt: "Already completed" });
        db.run("UPDATE multiremi_tasks SET status = 'completed' WHERE id = ?", [completed.id]);
        db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [tasks[0]!.id]);
        db.run("UPDATE multiremi_issues SET status = 'in_progress' WHERE id = ?", [issue.id]);
      } else {
        store.archiveAgent(agent.id);
        db.run("UPDATE multiremi_projects SET default_assignee_type = 'agent', default_assignee_id = ? WHERE id = ?", [agent.id, project.id]);
        db.run("UPDATE multiremi_autopilots SET status = 'active' WHERE id = ?", [autopilot.id]);
      }
      return { runtime, agent, project, autopilot, parent, issue, tasks };
    }

    function observe() {
      const events: Array<{ type: string; inTransaction: boolean; taskId?: string; prompt?: string; status?: string }> = [];
      const unsubscribe = [
        store.onWorkspaceEvent(event => {
          if (event.workspaceId === workspaceId) events.push({ type: event.type, inTransaction: db.inTransaction });
        }),
        store.onTaskEvent(event => {
          if (event.task.workspaceId === workspaceId) events.push({
            type: event.type, inTransaction: db.inTransaction, taskId: event.task.id,
            prompt: event.task.prompt, status: event.task.status,
          });
        }),
        store.onTaskEnqueued(task => {
          if (task.workspaceId === workspaceId) events.push({ type: "task:enqueued", taskId: task.id, inTransaction: db.inTransaction });
        }),
      ];
      return { events, stop: () => unsubscribe.forEach(remove => remove()) };
    }

    function request(path: string, method: string, body?: unknown) {
      return createMultiremiApp({ store, authToken: "mul467-atomic-fixture" }).request(path, {
        method, headers: { Authorization: "Bearer mul467-atomic-fixture", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    function deleteRequest(f: ReturnType<typeof fixture>, cascade: boolean, abandon = true) {
      return cascade
        ? request(`/api/runtimes/${f.runtime.id}/archive-agents-and-delete`, "POST", {
          expected_active_agent_ids: [f.agent.id], abandon_issue_workspaces: abandon,
        })
        : request(`/api/runtimes/${f.runtime.id}?abandon_issue_workspaces=${abandon}`, "DELETE");
    }

    function assertSingleTransaction() {
      expect(maxTransactionDepth).toBe(1);
      expect(depth).toBe(0);
      expect(db.inTransaction).toBe(false);
    }

    it.each([false, true])("rolls back every table and emits nothing after a late Runtime DELETE failure (cascade=%s)", async cascade => {
      const f = fixture(cascade);
      const before = await graph();
      const observed = observe();
      const originalRun = db.run;
      let injected = false;
      db.run = function run(sql, ...params) {
        const result = originalRun.call(this, sql, ...params);
        if (sql === "DELETE FROM multiremi_runtimes WHERE id = ?") {
          injected = true;
          throw new Error("MUL-467 failure after Runtime DELETE");
        }
        return result;
      };
      maxTransactionDepth = 0;
      try {
        const response = await deleteRequest(f, cascade);
        expect(response.status).toBe(500);
      } finally {
        db.run = originalRun;
        observed.stop();
      }
      expect(injected).toBe(true);
      expect(await graph()).toEqual(before);
      expect(observed.events).toEqual([]);
      assertSingleTransaction();
    });

    it.each(["javascript", "sql"])("does not swallow a %s error after a task cancellation write", async failure => {
      const f = fixture(true);
      const before = await graph();
      const observed = observe();
      const originalRun = db.run;
      let injected = false;
      db.run = function run(sql, ...params) {
        const result = originalRun.call(this, sql, ...params);
        if (sql.includes("SET status = 'cancelled', wait_reason = NULL")) {
          injected = true;
          if (failure === "sql") originalRun.call(this, "UPDATE mul467_missing_table SET missing = 1");
          throw new Error("MUL-467 failure after task cancellation");
        }
        return result;
      };
      maxTransactionDepth = 0;
      try {
        expect((await deleteRequest(f, true)).status).toBe(500);
      } finally {
        db.run = originalRun;
        observed.stop();
      }
      expect(injected).toBe(true);
      expect(await graph()).toEqual(before);
      expect(observed.events).toEqual([]);
      assertSingleTransaction();
    });

    it.each([false, true])("publishes committed notifications and child changes in one transaction (cascade=%s)", async cascade => {
      const f = fixture(cascade);
      const observed = observe();
      const childChanges: Array<{ issueId: string; status: string; inTransaction: boolean }> = [];
      const notify = IssuesRepo.prototype.notifyChildStatusChange;
      const childHook = spyOn(IssuesRepo.prototype, "notifyChildStatusChange").mockImplementation(function (this: IssuesRepo, ...args) {
        if (args[1].workspaceId === workspaceId) childChanges.push({
          issueId: args[1].id, status: args[1].status, inTransaction: db.inTransaction,
        });
        return notify.apply(this, args);
      });
      maxTransactionDepth = 0;
      try {
        const response = await deleteRequest(f, cascade);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(cascade
          ? { status: "ok", agents_archived: 1, tasks_cancelled: 2, issue_workspaces_abandoned: 1 }
          : { status: "ok", issue_workspaces_abandoned: 1 });
      } finally {
        childHook.mockRestore();
        observed.stop();
      }
      expect(store.getRuntime(f.runtime.id)).toBeNull();
      expect(store.getAgent(f.agent.id)).toMatchObject({ runtimeId: null });
      expect(store.getAgent(f.agent.id)?.archivedAt).not.toBeNull();
      expect(store.getAutopilot(f.autopilot.id)?.status).toBe("paused");
      expect(store.getProject(f.project.id)?.defaultAssigneeId).toBeNull();
      expect(store.getIssueWorkspace(f.issue.id)).toMatchObject({ status: "cleaned", runtimeId: null });
      expect(observed.events.length).toBeGreaterThan(0);
      expect(observed.events.every(event => !event.inTransaction)).toBe(true);
      expect(observed.events.at(-1)?.type).toBe("project:updated");
      const cancelled = observed.events.filter(event => event.type === "task:cancelled");
      expect(cancelled.map(event => ({ taskId: event.taskId, prompt: event.prompt, status: event.status })).sort((a, b) => a.taskId!.localeCompare(b.taskId!)))
        .toEqual(f.tasks.map(task => ({ taskId: task.id, prompt: task.prompt, status: "cancelled" })).sort((a, b) => a.taskId.localeCompare(b.taskId)));
      if (cascade) {
        expect(observed.events.findIndex(event => event.type === "activity:created"))
          .toBeGreaterThan(observed.events.findLastIndex(event => event.type === "task:cancelled"));
        expect(childChanges).toContainEqual({ issueId: f.issue.id, status: "todo", inTransaction: false });
        expect(childChanges.every(change => !change.inTransaction)).toBe(true);
        for (const task of f.tasks) expect(store.getTask(task.id)?.status).toBe("cancelled");
      } else {
        expect(childChanges).toEqual([]);
      }
      assertSingleTransaction();
    });

    it.each(["active_issue_workspaces", "plan_changed", "daemon_last_runtime"])("leaves every table and event unchanged on %s", async blocker => {
      const f = fixture(true);
      if (blocker === "daemon_last_runtime") db.run("DELETE FROM multiremi_runtimes WHERE id = ?", [`sibling_${workspaceId}`]);
      const before = await graph();
      const observed = observe();
      maxTransactionDepth = 0;
      try {
        expect(store.archiveAgentsAndDeleteRuntime(f.runtime.id, blocker === "plan_changed" ? [] : [f.agent.id], {
          abandonIssueWorkspaces: blocker !== "active_issue_workspaces",
        }).status).toBe(blocker);
      } finally {
        observed.stop();
      }
      expect(await graph()).toEqual(before);
      expect(observed.events).toEqual([]);
      assertSingleTransaction();
    });

    it("notifies the delegating Agent after commit and preserves the cancellation report", async () => {
      const f = fixture(true);
      const leaderRuntime = store.registerRuntime({
        id: `leader_${workspaceId}`, name: "Leader Runtime", provider: "codex", workspaceId,
      });
      const leader = store.createAgent({ name: "Leader", provider: "codex", runtimeId: leaderRuntime.id, workspaceId });
      const squad = store.createSquad({ name: "Deletion squad", leaderId: leader.id, memberIds: [f.agent.id], workspaceId });
      store.updateIssue(f.parent.id, { assigneeType: "squad", assigneeId: squad.id });
      store.updateIssue(f.issue.id, { assigneeType: "agent", assigneeId: f.agent.id });
      const leaderTask = store.createTask({ agentId: leader.id, issueId: f.parent.id, prompt: "Coordinate child work" });
      expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
      store.buildTaskSessionProjection(leaderTask.id);
      store.startTask(leaderTask.id);
      const token = await store.createTaskAccessToken(store.getTask(leaderTask.id)!, "local");
      const dispatched = await createMultiremiApp({ store, authToken: "mul467-atomic-fixture" }).request("/api/multiremi/tasks", {
        method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: f.agent.id, issueId: f.issue.id, prompt: "Delegated original request" }),
      });
      expect(dispatched.status).toBe(201);
      const delegatedId = ((await dispatched.json()) as { task: { id: string } }).task.id;
      const delegated = store.getTask(delegatedId)!;
      expect(delegated.delegationId).not.toBeNull();
      store.completeTask(leaderTask.id, { output: "Task completed." });
      const observed = observe();
      maxTransactionDepth = 0;
      try {
        const response = await deleteRequest(f, true);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ tasks_cancelled: 3 });
      } finally {
        observed.stop();
      }
      const wake = store.listTasksForIssue(f.parent.id)
        .find(task => task.agentId === leader.id && task.delegationId === delegated.delegationId);
      expect(wake).toMatchObject({ status: "queued" });
      expect(wake?.prompt).toContain("was cancelled");
      expect(store.getTask(delegatedId)).toMatchObject({ status: "cancelled", prompt: "Delegated original request" });
      expect(observed.events.filter(event => event.type === "task:enqueued"))
        .toContainEqual({ type: "task:enqueued", taskId: wake!.id, inTransaction: false });
      expect(observed.events.findIndex(event => event.type === "task:enqueued" && event.taskId === wake!.id))
        .toBeLessThan(observed.events.findIndex(event => event.type === "task:cancelled" && event.taskId === delegatedId));
      expect(observed.events.every(event => !event.inTransaction)).toBe(true);
      assertSingleTransaction();
    });

    it("rejects ordinary deletion without touching the Runtime graph or internal lock rows", async () => {
      const f = fixture(false);
      const before = await graph();
      const observed = observe();
      maxTransactionDepth = 0;
      try {
        const response = await deleteRequest(f, false, false);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "runtime_has_active_issue_workspaces" });
      } finally {
        observed.stop();
      }
      expect(await graph()).toEqual(before);
      expect(observed.events).toEqual([]);
      assertSingleTransaction();
    });

    it.each([false, true])("keeps orphan abandonment atomic without nested transactions (failure=%s)", async failure => {
      const f = fixture(false);
      db.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL, status = 'runtime_offline' WHERE issue_id = ?", [f.issue.id]);
      const before = await graph();
      const observed = observe();
      const originalRun = db.run;
      let injected = false;
      db.run = function run(sql, ...params) {
        const result = originalRun.call(this, sql, ...params);
        if (failure && sql.includes("SET status = 'cleaned'")) {
          injected = true;
          throw new Error("MUL-467 failure after orphan abandonment");
        }
        return result;
      };
      maxTransactionDepth = 0;
      try {
        expect((await request(`/api/issues/${f.issue.id}/workspace/abandon`, "POST")).status).toBe(failure ? 500 : 200);
      } finally {
        db.run = originalRun;
        observed.stop();
      }
      if (failure) {
        expect(injected).toBe(true);
        expect(await graph()).toEqual(before);
      } else {
        const rows = reader
          ? await reader`SELECT status, runtime_id, cleaned_at FROM multiremi_issue_workspaces WHERE issue_id = ${f.issue.id}`
          : db.query("SELECT status, runtime_id, cleaned_at FROM multiremi_issue_workspaces WHERE issue_id = ?").all(f.issue.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "cleaned", runtime_id: null });
        expect((rows[0] as { cleaned_at: string | null }).cleaned_at).not.toBeNull();
      }
      expect(observed.events).toEqual([]);
      assertSingleTransaction();
    });
  });
}
