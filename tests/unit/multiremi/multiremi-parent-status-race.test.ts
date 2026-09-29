import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { StoreContext } from "@multiremi/store/context.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { ChildMutation, RaceOperation, RaceResult } from "./fixtures/parent-status-race-worker.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const mutations: ChildMutation[] = ["create", "attach", "reopen_done", "reopen_cancelled", "assign_done", "assign_cancelled"];

function message<T>(worker: Worker, input: unknown, phase: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`worker timeout: ${phase}`)); }, 30_000);
    const onMessage = (event: MessageEvent) => {
      if (event.data.phase === phase) { cleanup(); resolve(event.data); }
    };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message)); };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(input);
  });
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("race did not reach a database wait or completion");
    await Bun.sleep(2);
  }
}

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !adminUrl)(`MUL-471 ${dialect} parent/child serialization`, () => {
    let directory: string;
    let databaseName: string;
    let location: string;
    let database: SqlDatabase;
    let admin: Bun.SQL;
    let store: MultiremiStore;
    let parentWorker: Worker;
    let childWorker: Worker;
    let ownerId: string;
    let connectionId: string;
    let sequence = 0;
    const previousKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), "mul471-race-"));
      if (dialect === "postgres") {
        databaseName = `mul471_race_${process.pid}_${Date.now()}`;
        admin = new Bun.SQL(adminUrl!, { max: 1 });
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(adminUrl!);
        url.pathname = `/${databaseName}`;
        location = url.toString();
        database = new PostgresSyncDatabase(location);
      } else {
        location = join(directory, "race.sqlite");
        database = new Database(location);
        database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0");
      }
      store = new MultiremiStore(database);
      store.ensureLocalWorkspace();
      process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
      store.updateWorkspace("local", {
        repos: [{ id: "repo_mul471", name: "mul471", url: "git@github.com:acme/mul471.git", source: "github", default_branch: "main" }],
        settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
      });
      ownerId = store.createAgent({ name: "Race parent owner", provider: "codex" }).id;
      connectionId = store.createScmConnection({
        workspaceId: "local", name: "Race SCM", provider: "github", mode: "poll",
        accessToken: "test-only-token", repositoryIds: ["repo_mul471"],
      }).id;
      parentWorker = new Worker(new URL("./fixtures/parent-status-race-worker.ts", import.meta.url).href);
      childWorker = new Worker(new URL("./fixtures/parent-status-race-worker.ts", import.meta.url).href);
      await message(parentWorker, { type: "init", dialect, location, applicationName: `mul471-parent-${process.pid}` }, "ready");
      await message(childWorker, { type: "init", dialect, location, applicationName: `mul471-child-${process.pid}` }, "ready");
    }, 60_000);

    afterAll(async () => {
      for (const worker of [parentWorker, childWorker]) {
        if (worker) { await message(worker, { type: "close" }, "closed"); worker.terminate(); }
      }
      database?.close();
      if (admin) { await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`); await admin.end(); }
      if (directory) rmSync(directory, { recursive: true, force: true });
      if (previousKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
      else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = previousKey;
    });

    for (const rollback of [false, true]) {
      it(`old-parent re-derivation ${rollback ? "rolls back" : "commits"} with its events`, () => {
        const oldParent = store.createIssue({ title: "Old parent", status: "in_progress" });
        const newParent = store.createIssue({ title: "New parent", status: "in_progress" });
        const child = store.createIssue({ title: "Moving child", parentIssueId: oldParent.id, status: "in_progress" });
        store.createIssue({ title: "Remaining child", parentIssueId: oldParent.id, status: "in_progress" });
        store.updateIssue(oldParent.id, { status: "in_review", force: true, actorType: "member" });
        if (database instanceof PostgresSyncDatabase) database.resetTransactionDepthStats();
        const events: boolean[] = [];
        const unsubscribe = store.onWorkspaceEvent((event) => {
          if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "parent_status_derived") {
            events.push(database.inTransaction === true);
          }
        });
        const original = StoreContext.prototype.appendIssueActivity;
        StoreContext.prototype.appendIssueActivity = function (issueId, input, queue) {
          original.call(this, issueId, input, queue);
          if (rollback && issueId === oldParent.id && input.type === "parent_status_derived") {
            throw new Error("old-parent rollback injection");
          }
        };
        try {
          const move = () => store.updateIssue(child.id, { parentIssueId: newParent.id });
          if (rollback) expect(move).toThrow("old-parent rollback injection");
          else move();
        } finally {
          StoreContext.prototype.appendIssueActivity = original;
          unsubscribe();
        }
        // The child write is already durable when its post-commit hook runs.
        expect(store.getIssue(child.id)?.parentIssueId).toBe(newParent.id);
        expect(store.getIssue(oldParent.id)?.status).toBe(rollback ? "in_review" : "in_progress");
        expect(events).toEqual(rollback ? [] : [false]);
        if (database instanceof PostgresSyncDatabase) expect(database.maxTransactionDepth).toBe(1);
      });
    }

    // Re-derivation takes no parent lock before counting: a parent decision that
    // commits in between wins, and the conditional UPDATE leaves no trace.
    if (dialect === "postgres") it("old-parent re-derivation yields to a parent move committed while it counts", () => {
      const oldParent = store.createIssue({ title: "Old parent", status: "in_progress" });
      const newParent = store.createIssue({ title: "New parent", status: "in_progress" });
      const child = store.createIssue({ title: "Moving child", parentIssueId: oldParent.id, status: "in_progress" });
      store.createIssue({ title: "Remaining child", parentIssueId: oldParent.id, status: "in_progress" });
      store.updateIssue(oldParent.id, { status: "in_review", force: true, actorType: "member" });
      const other = new PostgresSyncDatabase(location);
      other.exec("SET lock_timeout = '2s'");
      const otherStore = new MultiremiStore(other);
      (database as PostgresSyncDatabase).resetTransactionDepthStats();
      const events: string[] = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "parent_status_derived") {
          events.push(event.type);
        }
      });
      let moved = false;
      const original = IssuesRepo.prototype.countOpenChildIssues;
      IssuesRepo.prototype.countOpenChildIssues = function (id) {
        const result = original.call(this, id);
        if (!moved && id === oldParent.id && new Error().stack?.includes("rederiveParentStatus")) {
          moved = true;
          otherStore.updateIssue(oldParent.id, { status: "blocked", actorType: "member" });
        }
        return result;
      };
      try {
        store.updateIssue(child.id, { parentIssueId: newParent.id });
      } finally {
        IssuesRepo.prototype.countOpenChildIssues = original;
        unsubscribe();
        other.close();
      }
      expect(moved).toBe(true);
      expect(store.getIssue(oldParent.id)?.status).toBe("blocked");
      expect(store.listIssueActivity(oldParent.id).filter((entry) => entry.type === "parent_status_derived")).toEqual([]);
      expect(events).toEqual([]);
      expect((database as PostgresSyncDatabase).maxTransactionDepth).toBe(1);
    });

    for (const path of ["api", "scm"] as const) {
      for (const mutation of mutations) {
        for (const first of ["parent", "child"] as const) {
          it(`${path}: ${mutation}, ${first} first, 20 interleavings without deadlocks`, async () => {
            const violations: string[] = [];
            let busy = 0;
            for (let round = 0; round < 20; round += 1) {
              sequence += 1;
              const parent = store.createIssue({ title: `Parent ${sequence}`, status: "in_progress", assigneeType: "agent", assigneeId: ownerId });
              const childId = mutation === "create" ? `race-child-${sequence}` : store.createIssue({
                title: `Child ${sequence}`, status: mutation === "attach" ? "in_progress" : mutation.endsWith("_done") ? "done" : "cancelled",
                parentIssueId: mutation === "attach" ? null : parent.id,
              }).id;
              store.grantParentDone(parent.id, "local");
              store.createIssueComment(parent.id, { body: "Final parent summary", authorType: "agent", authorId: ownerId });
              if (path === "scm") store.advanceScmEntitySnapshot({
                connectionId, repositoryId: "repo_mul471", entityType: "change_request", externalId: String(sequence),
                revisionAt: new Date().toISOString(), revision: `v${sequence}`, contentHash: `race-${sequence}`,
                payload: { number: sequence, title: `${parent.key} delivery`, state: "merged", source_branch: `agent/${parent.key}` },
              });
              const status = path === "scm" ? "done" : (["done", "in_review"] as const)[round % 2]!;
              const parentControl = new Int32Array(new SharedArrayBuffer(8));
              const childControl = new Int32Array(new SharedArrayBuffer(8));
              const base = { type: "run" as const, parentId: parent.id, childId, ownerId, mutation, path, status, connectionId, number: sequence };
              const firstWorker = first === "parent" ? parentWorker : childWorker;
              const secondWorker = first === "parent" ? childWorker : parentWorker;
              const firstControl = first === "parent" ? parentControl : childControl;
              const secondControl = first === "parent" ? childControl : parentControl;
              let secondFinished = false;
              let firstResult: Promise<RaceResult> | undefined;
              let secondResult: Promise<RaceResult> | undefined;
              try {
                firstResult = message<RaceResult>(firstWorker, { ...base, role: first, pause: true, control: firstControl.buffer } satisfies RaceOperation, "done");
                await until(() => Atomics.load(firstControl, 0) === 1);
                const secondRole = first === "parent" ? "child" : "parent";
                secondResult = message<RaceResult>(secondWorker, { ...base, role: secondRole, pause: false, control: secondControl.buffer } satisfies RaceOperation, "done")
                  .then((result) => { secondFinished = true; return result; });
                // A lock wait is evidence of a real concurrent attempt, not a timed sleep.
                await until(async () => secondFinished || (dialect === "postgres" && (await admin.unsafe(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
                  [`mul471-${secondRole}-${process.pid}`],
                )).length > 0));
                if (dialect === "postgres" && secondFinished) violations.push(`round ${round}: ${secondRole} passed the paused ${first} transaction`);
              } finally {
                Atomics.store(firstControl, 1, 1);
                Atomics.notify(firstControl, 1);
              }
              const [a, b] = await Promise.all([firstResult!, secondResult!]);
              for (const result of [a, b]) {
                expect(result.maxDepth).toBe(1);
                expect(result.eventsInTransaction).toBe(0);
                if (result.error?.includes("database is locked") || result.error?.includes("SQLITE_BUSY")) busy += 1;
                else if (result.error && !result.error.includes("unfinished child")) violations.push(result.error);
              }
              if (dialect === "postgres") {
                const parentResult = first === "parent" ? a : b;
                if (first === "child" && parentResult.parentStatus !== "in_progress") {
                  violations.push(`round ${round}: stale parent status ${parentResult.parentStatus}`);
                }
                expect(store.countOpenChildIssues(parent.id)).toBe(1);
              } else {
                // SQLite's database-wide writer lock rejects the contender (including
                // read-to-write promotion in the pre-fix SCM path) instead of closing stale.
                expect(store.getIssue(parent.id)?.status === status && store.countOpenChildIssues(parent.id) > 0).toBe(false);
              }
            }
            console.log(`[MUL-471 ${dialect}] ${path}/${mutation}/${first}: 20 rounds, busy=${busy}, violations=${violations.length}`);
            expect(violations).toEqual([]);
          }, 120_000);
        }
      }
    }
  });
}
