import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { IssueLockSetStaleError, IssuesRepo, IssueWorkspaceMoveError } from "@multiremi/store/repos/issues-repo.js";
import { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";
import type { RelationLockInput } from "./fixtures/postgres-relation-lock-worker.js";

interface WorkerResult {
  phase: string;
  ok: boolean;
  error?: string;
  code?: string;
  maxTransactionDepth: number;
}

type SqlParams = Array<string | number | bigint | boolean | null | Uint8Array>;
type TraceEvent = { kind: "lock" | "read" | "hint"; id: string };

const LOCK_SQL = "UPDATE multiremi_issues SET id = id WHERE id = ?";
const READ_SQL = "SELECT * FROM multiremi_issues WHERE id = ?";
// The unlocked reads that pick a lock set: PATCH, then Agent assignment.
const HINT_SQL = new Set([
  "SELECT workspace_id, parent_issue_id, status FROM multiremi_issues WHERE id = ?",
  "SELECT parent_issue_id, status FROM multiremi_issues WHERE id = ?",
]);
const STALE_MESSAGE = new IssueLockSetStaleError().message;

/** Row locks with no read in between: one `lockIssueRowsWithinTransaction` call. */
function lockBatches(events: TraceEvent[]): string[][] {
  const batches: string[][] = [];
  let previous: TraceEvent["kind"] | null = null;
  for (const event of events) {
    if (event.kind === "lock") {
      if (previous !== "lock") batches.push([]);
      batches.at(-1)!.push(event.id);
    }
    previous = event.kind;
  }
  return batches;
}

function phase(worker: Worker, wanted: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${wanted}`)); }, 30_000);
    const onMessage = ({ data }: MessageEvent<WorkerResult>) => {
      if (data.phase === "error") { cleanup(); reject(new Error(data.error)); }
      if (data.phase === wanted) { cleanup(); resolve(data); }
    };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message)); };
    function cleanup() {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

function thrown(action: () => unknown): Error & { code?: string } {
  try { action(); } catch (error) { return error as Error & { code?: string }; }
  throw new Error("Expected the action to throw");
}

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
  describe.skipIf(backend === "PostgreSQL" && !pgUrl)(`MUL-476 relation locks (${backend})`, () => {
    let db: Database | PostgresSyncDatabase;
    let store: MultiremiStore;
    let admin: Bun.SQL | undefined;
    let databaseUrl = "";
    let serial = 0;
    const databaseName = `mul476_locks_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

    beforeAll(async () => {
      if (backend === "PostgreSQL") {
        admin = new Bun.SQL(pgUrl!, { max: 1 });
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(pgUrl!);
        url.pathname = `/${databaseName}`;
        databaseUrl = url.toString();
        db = new PostgresSyncDatabase(databaseUrl);
      } else db = new Database(":memory:");
      store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
    });

    afterAll(async () => {
      db?.close();
      if (admin) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        await admin.end();
      }
    });

    function fixture(reverse = false) {
      const tag = `locks-${backend.toLowerCase()}-${++serial}`;
      const a = store.createWorkspace({ id: `wa-${tag}`, slug: `a-${tag}`, name: `A ${tag}` });
      const b = store.createWorkspace({ id: `wb-${tag}`, slug: `b-${tag}`, name: `B ${tag}` });
      const source = reverse ? b.id : a.id;
      const target = reverse ? a.id : b.id;
      const parent = store.createIssue({ id: `iss_a_${tag}`, title: "Parent", workspaceId: source });
      const child = store.createIssue({ id: `iss_z_${tag}`, title: "Unrelated child", workspaceId: source });
      const agent = store.createAgent({ name: `Agent ${tag}`, provider: "codex", workspaceId: source });
      return { tag, source, target, parent, child, agent };
    }

    /** One workspace: P in progress, C done under P, an Agent. The ids pick which row sorts first. */
    function family(parentFirst = true) {
      const tag = `family-${backend.toLowerCase()}-${++serial}`;
      const workspace = store.createWorkspace({ id: `wf-${tag}`, slug: `f-${tag}`, name: `F ${tag}` }).id;
      const [parentId, childId] = parentFirst ? [`iss_a_${tag}`, `iss_z_${tag}`] : [`iss_z_${tag}`, `iss_a_${tag}`];
      const parent = store.createIssue({ id: parentId, title: "Parent", workspaceId: workspace, status: "in_progress" });
      const child = store.createIssue({ id: childId, title: "Child", workspaceId: workspace, parentIssueId: parent.id });
      store.updateIssue(child.id, { status: "done" });
      const agent = store.createAgent({ name: `Agent ${tag}`, provider: "codex", workspaceId: workspace });
      // Sorted after `iss_a_` and before `iss_z_`.
      const extraParent = (letter: "m" | "n") => store.createIssue({
        id: `iss_${letter}_${tag}`, title: `Parent ${letter}`, workspaceId: workspace, status: "in_progress",
      });
      return { workspace, parent, child, agent, extraParent };
    }

    function reopenOrAssign(action: "reopen" | "assign", issueId: string, agentId: string) {
      if (action === "reopen") store.updateIssue(issueId, { status: "in_progress" });
      else store.assignIssue(issueId, { assigneeType: "agent", assigneeId: agentId });
    }

    function activityCount(issueId: string, type?: string): number {
      const row = type
        ? db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ? AND type = ?").get(issueId, type)
        : db.query("SELECT COUNT(*) AS n FROM multiremi_issue_activity WHERE issue_id = ?").get(issueId);
      return Number((row as { n: number | string }).n);
    }

    function taskIds(issueId: string): string[] {
      return (db.query("SELECT id FROM multiremi_tasks WHERE issue_id = ? ORDER BY id").all(issueId) as Array<{ id: string }>)
        .map((row) => row.id);
    }

    function assertNoForeignEdges() {
      expect(db.query(`SELECT child.id FROM multiremi_issues child
        JOIN multiremi_issues parent ON parent.id = child.parent_issue_id
        WHERE child.workspace_id <> parent.workspace_id`).all()).toEqual([]);
      expect(db.query(`SELECT d.id FROM multiremi_issue_dependencies d
        JOIN multiremi_issues a ON a.id = d.issue_id JOIN multiremi_issues b ON b.id = d.depends_on_issue_id
        WHERE a.workspace_id <> b.workspace_id OR d.workspace_id <> a.workspace_id`).all()).toEqual([]);
      // An active task is an edge too: its workspace writes to its Issue. Finished
      // tasks stay behind as history once the Issue may move.
      expect(db.query(`SELECT t.id FROM multiremi_tasks t JOIN multiremi_issues i ON i.id = t.issue_id
        WHERE t.workspace_id <> i.workspace_id AND t.status NOT IN ('completed', 'failed', 'cancelled')`).all()).toEqual([]);
    }

    function resetDepth() {
      if (db instanceof PostgresSyncDatabase) db.resetTransactionDepthStats();
    }

    function expectDepthOne() {
      if (db instanceof PostgresSyncDatabase) expect(db.maxTransactionDepth).toBe(1);
    }

    /** Records row locks, full-row reads and lock-set hints in order. `onHint` runs before the hint is read. */
    function trace(action: () => void, onHint?: (id: string) => void): TraceEvent[] {
      const events: TraceEvent[] = [];
      const originalRun = db.run.bind(db);
      const originalQuery = db.query.bind(db);
      const runSpy = spyOn(db, "run").mockImplementation((sql: string, params?: SqlParams) => {
        if (sql === LOCK_SQL) events.push({ kind: "lock", id: String(params?.[0]) });
        return originalRun(sql, params ?? []);
      });
      // Wrap rather than patch: bun:sqlite caches statements, so a patched
      // `get` would outlive this spy.
      const querySpy = spyOn(db, "query").mockImplementation((sql: string) => {
        const stmt = originalQuery(sql);
        const kind = sql === READ_SQL ? "read" : HINT_SQL.has(sql) ? "hint" : null;
        if (!kind) return stmt;
        return new Proxy(stmt, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            if (key !== "get") return value.bind(target);
            return (...params: unknown[]) => {
              if (kind === "hint") onHint?.(String(params[0]));
              events.push({ kind, id: String(params[0]) });
              return value.apply(target, params);
            };
          },
        });
      });
      try { action(); } finally { querySpy.mockRestore(); runSpy.mockRestore(); }
      return events;
    }

    it("S1: sequential move-before-add refuses all relation writes; add-before-move refuses the move", () => {
      const f = fixture();
      store.updateIssue(f.parent.id, { workspaceId: f.target });
      expect(() => store.createIssue({ title: "Invalid", parentIssueId: f.parent.id, workspaceId: f.source })).toThrow("another workspace");
      expect(() => store.updateIssue(f.child.id, { parentIssueId: f.parent.id })).toThrow("another workspace");
      expect(() => store.createIssueDependency(f.child.id, { dependsOnIssueId: f.parent.id })).toThrow("within a workspace");
      const other = fixture();
      store.updateIssue(other.child.id, { parentIssueId: other.parent.id });
      expect(() => store.updateIssue(other.parent.id, { workspaceId: other.target })).toThrow("Detach");
      assertNoForeignEdges();
    });

    it("S1: sequential move, assignment and task creation refuse whichever comes second", () => {
      const moved = fixture();
      store.updateIssue(moved.child.id, { workspaceId: moved.target });
      expect(thrown(() => store.assignIssue(moved.child.id, { assigneeType: "agent", assigneeId: moved.agent.id })).message)
        .toBe(`Agent not found: ${moved.agent.id}`);
      expect(thrown(() => store.createTask({ agentId: moved.agent.id, issueId: moved.child.id, workspaceId: moved.source, prompt: "Late" })).message)
        .toBe("Issue workspace does not match agent workspace");
      expect(store.getIssue(moved.child.id)?.assigneeId).toBeNull();
      expect(taskIds(moved.child.id)).toEqual([]);

      for (const first of ["assign", "task"] as const) {
        const f = fixture();
        const task = first === "assign"
          ? store.assignIssue(f.child.id, { assigneeType: "agent", assigneeId: f.agent.id }).task!
          : store.createTask({ agentId: f.agent.id, issueId: f.child.id, workspaceId: f.source, prompt: "First" });
        const error = thrown(() => store.updateIssue(f.child.id, { workspaceId: f.target }));
        expect(error).toBeInstanceOf(IssueWorkspaceMoveError);
        expect((error as IssueWorkspaceMoveError).relations.tasks).toEqual([{ id: task.id, status: "queued" }]);
        expect(store.getIssue(f.child.id)?.workspaceId).toBe(f.source);
      }
      assertNoForeignEdges();
    });

    it("PG-L8b: an Issue with an active task answers 409 with the task; unassigning unblocks the move", async () => {
      const f = fixture();
      const { task } = store.assignIssue(f.child.id, { assigneeType: "agent", assigneeId: f.agent.id });
      const error = thrown(() => store.updateIssue(f.child.id, { workspaceId: f.target })) as IssueWorkspaceMoveError;
      expect(error.code).toBe("workspace_move_blocked");
      expect(error.relations).toEqual({ parent: null, children: [], dependencies: [], tasks: [{ id: task!.id, status: "queued" }], hidden: 0 });
      const app = createMultiremiApp({ store, authToken: "mul476-locks-root", shareSecret: "mul476-locks-share" });
      const response = await app.request(`/api/multiremi/issues/${f.child.id}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer mul476-locks-root", "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: f.target }),
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe("workspace_move_blocked");
      expect(body.relations.tasks).toEqual([{ id: task!.id, status: "queued" }]);
      expect(store.getIssue(f.child.id)?.workspaceId).toBe(f.source);
      // A task in another workspace is counted, never listed.
      db.run("UPDATE multiremi_tasks SET workspace_id = ? WHERE id = ?", [f.target, task!.id]);
      const hidden = thrown(() => store.updateIssue(f.child.id, { workspaceId: f.target })) as IssueWorkspaceMoveError;
      expect(hidden.relations.tasks).toEqual([]);
      expect(hidden.relations.hidden).toBe(1);
      db.run("UPDATE multiremi_tasks SET workspace_id = ? WHERE id = ?", [f.source, task!.id]);
      // Unassigning cancels the task with the same predicate the guard reads.
      store.assignIssue(f.child.id, {});
      store.updateIssue(f.child.id, { workspaceId: f.target });
      expect(store.getIssue(f.child.id)?.workspaceId).toBe(f.target);
      assertNoForeignEdges();
    });

    it("PG-L8d (MUL-480 known residual): a move between assignment and task creation leaves a stale assignee and no task", () => {
      const f = fixture();
      const createTask = TasksRepo.prototype.createTask;
      let moved = false;
      const spy = spyOn(TasksRepo.prototype, "createTask").mockImplementation(function (this: TasksRepo, input) {
        if (!moved) { moved = true; store.updateIssue(f.child.id, { workspaceId: f.target }); }
        return createTask.call(this, input);
      });
      try {
        expect(thrown(() => store.assignIssue(f.child.id, { assigneeType: "agent", assigneeId: f.agent.id })).message)
          .toBe("Issue workspace does not match agent workspace");
      } finally { spy.mockRestore(); }
      const child = store.getIssue(f.child.id)!;
      expect(moved).toBe(true);
      expect(child.workspaceId).toBe(f.target);
      expect(child.assigneeId).toBe(f.agent.id);
      expect(child.status).toBe("todo");
      expect(taskIds(f.child.id)).toEqual([]);
    });

    for (const action of ["create", "reparent", "dependency", "reopen", "assign", "sibling-status"] as const) {
      it(`S2: ${action} locks its Issue rows once in ascending order, then re-reads them`, () => {
        const f = fixture();
        if (action === "reopen" || action === "assign" || action === "sibling-status") {
          store.updateIssue(f.child.id, { parentIssueId: f.parent.id });
          store.updateIssue(f.child.id, { status: action === "sibling-status" ? "in_progress" : "done" });
        }
        const events = trace(() => {
          if (action === "create") store.createIssue({ title: "Locked child", workspaceId: f.source,
            parentIssueId: f.parent.id, blockedBy: [f.child.key] });
          if (action === "reparent") store.updateIssue(f.child.id, { parentIssueId: f.parent.id });
          if (action === "dependency") store.createIssueDependency(f.child.id, { dependsOnIssueId: f.parent.key });
          if (action === "reopen" || action === "assign") reopenOrAssign(action, f.child.id, f.agent.id);
          // An unfinished child changing status does not touch its parent's count.
          if (action === "sibling-status") store.updateIssue(f.child.id, { status: "in_review" });
        });
        const expected = action === "sibling-status" ? [f.child.id] : [f.parent.id, f.child.id].sort();
        const batches = lockBatches(events);
        expect(batches[0]).toEqual(expected);
        if (action === "create" || action === "reparent" || action === "dependency") expect(batches).toHaveLength(1);
        const firstLock = events.findIndex((event) => event.kind === "lock");
        const batchEnd = firstLock + expected.length - 1;
        // Only the assignment's own pre-read of C precedes the batch; the parent is never read first.
        const earlyReads = events.slice(0, firstLock).filter((event) => event.kind === "read" && expected.includes(event.id));
        expect(earlyReads.map((event) => event.id)).toEqual(action === "assign" ? [f.child.id] : []);
        for (const id of action === "create" || action === "reparent" || action === "dependency" ? expected : [f.child.id]) {
          expect(events.findIndex((event, i) => i > batchEnd && event.kind === "read" && event.id === id)).toBeGreaterThan(batchEnd);
        }
      });
    }

    for (const action of ["reopen", "assign"] as const) {
      it(`S3: ${action} of a done child refuses a deleted parent and ignores a parent moved away`, () => {
        const gone = family();
        // parent_issue_id has no foreign key, so a parent row can vanish under its children.
        db.run("DELETE FROM multiremi_issues WHERE id = ?", [gone.parent.id]);
        expect(store.getIssue(gone.child.id)?.parentIssueId).toBe(gone.parent.id);
        expect(thrown(() => reopenOrAssign(action, gone.child.id, gone.agent.id)).message)
          .toBe(`Parent issue not found: ${gone.parent.id}`);
        expect(store.getIssue(gone.child.id)?.status).toBe("done");
        expect(taskIds(gone.child.id)).toEqual([]);

        const moved = family();
        const elsewhere = store.createWorkspace({ id: `wx-${moved.workspace}`, slug: `x-${moved.workspace}`, name: "Elsewhere" });
        // A legacy foreign edge from before MUL-476; the rule does not migrate it.
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [elsewhere.id, moved.parent.id]);
        reopenOrAssign(action, moved.child.id, moved.agent.id);
        expect(store.getIssue(moved.child.id)?.status).toBe(action === "reopen" ? "in_progress" : "todo");
        // Later cases assert that no foreign edge exists anywhere.
        db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [moved.workspace, moved.parent.id]);
      });
    }

    it("HTTP: a lock set stale twice answers 409 issue_relation_changed on PATCH and assign", async () => {
      const f = family();
      const app = createMultiremiApp({ store, authToken: "mul476-locks-root", shareSecret: "mul476-locks-share" });
      const request = (path: string, method: string, body: unknown) => app.request(path, {
        method,
        headers: { Authorization: "Bearer mul476-locks-root", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const update = spyOn(IssuesRepo.prototype, "updateIssueWithinTransaction").mockImplementation(() => {
        throw new IssueLockSetStaleError();
      });
      try {
        for (const prefix of ["/api/multiremi/issues", "/api/issues"]) {
          update.mockClear();
          const response = await request(`${prefix}/${f.child.id}`, "PATCH", { status: "in_progress" });
          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({ error: STALE_MESSAGE, code: "issue_relation_changed" });
          // The transaction owner retried once before giving up.
          expect(update).toHaveBeenCalledTimes(2);
        }
      } finally { update.mockRestore(); }
      const assign = spyOn(store, "assignIssue").mockImplementation(() => { throw new IssueLockSetStaleError(); });
      try {
        const response = await request(`/api/multiremi/issues/${f.child.id}/assign`, "POST",
          { assignee_type: "agent", assignee_id: f.agent.id });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: STALE_MESSAGE, code: "issue_relation_changed" });
      } finally { assign.mockRestore(); }
      expect(store.getIssue(f.child.id)?.status).toBe("done");
    });

    if (backend !== "PostgreSQL") return;

    function spawn(input: Omit<RelationLockInput, "databaseUrl">) {
      const worker = new Worker(new URL("./fixtures/postgres-relation-lock-worker.ts", import.meta.url).href);
      const ready = input.gate ? phase(worker, "ready") : Promise.resolve(null);
      const locked = phase(worker, "locked");
      const finished = Promise.all([phase(worker, "done"), phase(worker, "closed")]).then(([done]) => done);
      worker.postMessage({ ...input, databaseUrl });
      return { worker, ready, locked, finished };
    }

    /** Runs `action` while the worker holds its rows; the worker commits once `action` waits on them. */
    async function hold(input: Omit<RelationLockInput, "databaseUrl">, action: () => void) {
      const holder = spawn(input);
      try {
        await holder.locked;
        let failure: unknown;
        try { action(); } catch (error) { failure = error; }
        expect((await holder.finished).ok).toBe(true);
        if (failure) throw failure;
      }
      finally { holder.worker.terminate(); }
    }

    for (const reverse of [false, true]) {
      for (const action of ["create", "reparent", "dependency", "dependency-source"] as const) {
        it(`PG-L1 ${reverse ? "B -> A" : "A -> B"}: ${action} waits for a moving endpoint and re-reads`, async () => {
          const f = fixture(reverse);
          const before = store.listIssues({ workspaceId: f.source });
          await hold({ mode: "hold-move", role: "move", issueId: f.parent.id, otherId: f.child.id,
            sourceWorkspace: f.source, targetWorkspace: f.target }, () => {
            if (action === "create") expect(() => store.createIssue({ title: "Refused child", workspaceId: f.source, parentIssueId: f.parent.id })).toThrow("another workspace");
            if (action === "reparent") expect(() => store.updateIssue(f.child.id, { parentIssueId: f.parent.id })).toThrow("another workspace");
            if (action === "dependency") expect(() => store.createIssueDependency(f.child.id, { dependsOnIssueId: f.parent.id })).toThrow("within a workspace");
            if (action === "dependency-source") expect(() => store.createIssueDependency(f.parent.id, { dependsOnIssueId: f.child.id })).toThrow("within a workspace");
          });
          expect(store.getIssue(f.child.id)?.parentIssueId).toBeNull();
          expect(store.listIssues({ workspaceId: f.source })).toHaveLength(before.length - 1);
          const next = store.createIssue({ title: "No consumed number", workspaceId: f.source });
          expect(next.number).toBe(Math.max(...before.filter((issue) => issue.id !== f.parent.id).map((issue) => issue.number)) + 1);
          assertNoForeignEdges();
        }, 15_000);
      }

      it(`PG-L2 ${reverse ? "B -> A" : "A -> B"}: move inspects raw children after obtaining its own row lock`, async () => {
        const f = fixture(reverse);
        await hold({ mode: "hold-child", role: "create", issueId: f.parent.id, otherId: `${f.child.id}_new`,
          sourceWorkspace: f.source, targetWorkspace: f.target }, () => {
          expect(() => store.updateIssue(f.parent.id, { workspaceId: f.target })).toThrow("Detach");
        });
        expect(store.getIssue(f.parent.id)?.workspaceId).toBe(f.source);
        assertNoForeignEdges();
      }, 15_000);
    }

    it("PG-L8a: an assignment that waited on a move fails like a sequential one and writes nothing", async () => {
      const f = fixture();
      store.updateIssue(f.child.id, { status: "in_progress" });
      const before = activityCount(f.child.id, "issue_assigned");
      resetDepth();
      await hold({ mode: "hold-move", role: "move", issueId: f.child.id, otherId: f.parent.id,
        sourceWorkspace: f.source, targetWorkspace: f.target }, () => {
        expect(thrown(() => store.assignIssue(f.child.id, { assigneeType: "agent", assigneeId: f.agent.id })).message)
          .toBe(`Agent not found: ${f.agent.id}`);
      });
      const child = store.getIssue(f.child.id)!;
      expect(child.workspaceId).toBe(f.target);
      expect(child.assigneeId).toBeNull();
      expect(child.status).toBe("in_progress");
      expect(activityCount(f.child.id, "issue_assigned")).toBe(before);
      expect(taskIds(f.child.id)).toEqual([]);
      expectDepthOne();
      assertNoForeignEdges();
    }, 15_000);

    it("PG-L8c: task creation that waited on a move refuses the moved Issue", async () => {
      const f = fixture();
      await hold({ mode: "hold-move", role: "move", issueId: f.child.id, otherId: f.parent.id,
        sourceWorkspace: f.source, targetWorkspace: f.target }, () => {
        expect(thrown(() => store.createTask({ agentId: f.agent.id, issueId: f.child.id, workspaceId: f.source, prompt: "Waiting" })).message)
          .toBe("Issue workspace does not match agent workspace");
      });
      expect(store.getIssue(f.child.id)?.workspaceId).toBe(f.target);
      expect(taskIds(f.child.id)).toEqual([]);
      assertNoForeignEdges();
    }, 15_000);

    async function race(inputs: Array<Omit<RelationLockInput, "databaseUrl" | "mode" | "barrierPath">>) {
      const directory = mkdtempSync(join(tmpdir(), "mul476-relation-"));
      const barrierPath = join(directory, "go");
      const workers = inputs.map(() => new Worker(new URL("./fixtures/postgres-relation-lock-worker.ts", import.meta.url).href));
      try {
        const ready = workers.map((worker) => phase(worker, "ready"));
        const done = workers.map((worker) => Promise.all([phase(worker, "done"), phase(worker, "closed")]));
        workers.forEach((worker, i) => worker.postMessage({ ...inputs[i], databaseUrl, mode: "race", barrierPath }));
        await Promise.all(ready);
        writeFileSync(barrierPath, "go");
        const outcomes = (await Promise.all(done)).map(([result]) => result!);
        for (const outcome of outcomes) {
          expect(outcome.error ?? "").not.toMatch(/40P01|deadlock/i);
          expect(outcome.maxTransactionDepth).toBe(1);
        }
        assertNoForeignEdges();
        return outcomes;
      } finally { workers.forEach((worker) => worker.terminate()); rmSync(directory, { recursive: true, force: true }); }
    }

    for (const reverse of [false, true]) {
      for (const role of ["create", "reparent", "dependency", "dependency-source"] as const) {
        it(`PG-L3 ${reverse ? "B -> A" : "A -> B"}: move vs ${role} permits exactly one writer`, async () => {
          const f = fixture(reverse);
          const common = { sourceWorkspace: f.source, targetWorkspace: f.target };
          const results = await race([
            { ...common, role: "move", issueId: f.parent.id, otherId: f.child.id },
            { ...common, role: role === "dependency-source" ? "dependency" : role,
              issueId: role === "dependency-source" ? f.parent.id : f.child.id,
              otherId: role === "dependency-source" ? f.child.id : f.parent.id },
          ]);
          expect(results.filter((result) => result.ok)).toHaveLength(1);
          expect(results.filter((result) => !result.ok)).toHaveLength(1);
        }, 15_000);
      }
    }

    it("PG-L8c: move vs task creation permits exactly one writer (10 rounds)", async () => {
      for (let round = 0; round < 10; round++) {
        const f = fixture(round % 2 === 1);
        const common = { sourceWorkspace: f.source, targetWorkspace: f.target, ownerId: f.agent.id, otherId: f.parent.id };
        const results = await race([
          { ...common, role: "move", issueId: f.child.id },
          { ...common, role: "task", issueId: f.child.id },
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        const [move, task] = results;
        if (move!.ok) expect(task!.error).toBe("Issue workspace does not match agent workspace");
        else expect(move!.code).toBe("workspace_move_blocked");
      }
    }, 120_000);

    for (const role of ["reparent", "dependency"] as const) {
      it(`PG-L4: opposing ${role} writes reject cycles without deadlock (10 rounds)`, async () => {
        for (let round = 0; round < 10; round++) {
          const f = fixture();
          const common = { role, sourceWorkspace: f.source, targetWorkspace: f.target };
          const results = await race([
            { ...common, issueId: f.child.id, otherId: f.parent.id },
            { ...common, issueId: f.parent.id, otherId: f.child.id },
          ]);
          expect(results.filter((result) => result.ok)).toHaveLength(1);
          const rejected = results.find((result) => !result.ok)!;
          expect(rejected.code === "dependency_cycle" || rejected.error === "Circular parent issue relationship detected").toBe(true);
        }
      }, 120_000);
    }

    for (const parentFirst of [true, false]) {
      for (const [writer, reopener] of [["reparent", "reopen"], ["reparent", "assign"], ["dependency", "reopen"], ["dependency", "assign"]] as const) {
        it(`PG-L5 ${parentFirst ? "P < C" : "C < P"}: ${writer} vs ${reopener} of the done child, no deadlock (10 rounds)`, async () => {
          for (let round = 0; round < 10; round++) {
            const f = family(parentFirst);
            const common = { sourceWorkspace: f.workspace, targetWorkspace: f.workspace, ownerId: f.agent.id };
            const results = await race([
              writer === "reparent"
                ? { ...common, role: "reparent", issueId: f.child.id, otherId: f.parent.id }
                : { ...common, role: "dependency", issueId: f.parent.id, otherId: f.child.id },
              { ...common, role: reopener, issueId: f.child.id, otherId: f.parent.id },
            ]);
            const rejected = results.filter((result) => !result.ok);
            expect(rejected.length).toBeLessThanOrEqual(1);
            for (const result of rejected) expect(`${result.code ?? ""} ${result.error}`).toMatch(/dependency_cycle|unfinished|circular/i);
            expect(store.getIssue(f.child.id)?.parentIssueId).toBe(f.parent.id);
            if (!rejected.length) expect(store.countOpenChildIssues(f.parent.id)).toBe(1);
          }
        }, 120_000);
      }
    }

    for (const action of ["reopen", "assign"] as const) {
      it(`PG-L6: ${action} whose child was re-parented while it waited retries once with the new parent`, async () => {
        const f = family();
        const next = f.extraParent("m");
        const type = action === "reopen" ? "issue_updated" : "issue_assigned";
        const before = activityCount(f.child.id, type);
        resetDepth();
        let events: TraceEvent[] = [];
        await hold({ mode: "hold-reparent", role: "reparent", issueId: f.child.id, otherId: next.id,
          sourceWorkspace: f.workspace, targetWorkspace: f.workspace }, () => {
          events = trace(() => reopenOrAssign(action, f.child.id, f.agent.id));
        });
        expect(lockBatches(events).slice(0, 2)).toEqual([[f.parent.id, f.child.id], [next.id, f.child.id]]);
        const child = store.getIssue(f.child.id)!;
        expect(child.parentIssueId).toBe(next.id);
        expect(child.status).toBe(action === "reopen" ? "in_progress" : "todo");
        expect(activityCount(f.child.id, type)).toBe(before + 1);
        expectDepthOne();
        assertNoForeignEdges();
      }, 20_000);
    }

    it("PG-L7: a lock set stale twice throws issue_relation_changed and writes nothing", async () => {
      const f = family();
      const second = f.extraParent("m");
      const third = f.extraParent("n");
      const gate = new SharedArrayBuffer(8);
      const flags = new Int32Array(gate);
      const common = { role: "reparent" as const, issueId: f.child.id, sourceWorkspace: f.workspace, targetWorkspace: f.workspace };
      const later = spawn({ ...common, mode: "hold-reparent", otherId: third.id, gate });
      try {
        await later.ready;
        const before = activityCount(f.child.id);
        resetDepth();
        let hints = 0;
        let failure: Error & { code?: string } | null = null;
        await hold({ ...common, mode: "hold-reparent", otherId: second.id }, () => {
          trace(() => { failure = thrown(() => store.updateIssue(f.child.id, { status: "in_progress" })); }, (id) => {
            if (id !== f.child.id || ++hints !== 2) return;
            // The retry's hint: let the second re-parent take C before the retry locks.
            Atomics.store(flags, 0, 1);
            Atomics.notify(flags, 0);
            if (Atomics.wait(flags, 1, 0, 15_000) === "timed-out") throw new Error("second re-parent never locked");
          });
        });
        expect((await later.finished).ok).toBe(true);
        expect(hints).toBe(2);
        expect(failure).toBeInstanceOf(IssueLockSetStaleError);
        expect(failure!.code).toBe("issue_relation_changed");
        const child = store.getIssue(f.child.id)!;
        expect(child.parentIssueId).toBe(third.id);
        expect(child.status).toBe("done");
        expect(activityCount(f.child.id)).toBe(before);
        expectDepthOne();
      } finally { later.worker.terminate(); }
    }, 30_000);
  });
}
