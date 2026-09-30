/**
 * MUL-432: the guards of the trace backfill that nothing else fails without —
 * the SQL `LIKE` cross-check of the truncated JSON counts, clearing a killed
 * run's staging before a `running` subject is restaged, and committing the
 * turn cards and the done mark in the transaction that makes the archive
 * ready, at transaction depth 1. On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SESSION_ARCHIVE_TRACE_SUFFIX } from "@multiremi/contracts/session-archive.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { backfillConversationLogWithinTransaction } from "@multiremi/store/conversation-log-backfill.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import type { TraceBackfillProgressRepo } from "@multiremi/store/repos/trace-backfill-progress-repo.js";
import { runTraceBackfill, type TraceBackfillRunOptions } from "../../../scripts/backfill-task-traces.js";
import { TraceBackfillStopError } from "../../../scripts/lib/task-trace-backfill.js";
import { reconcileTraceBackfill } from "../../../scripts/lib/task-trace-reconcile.js";
import {
  insertSyntheticAgent,
  insertSyntheticChat,
  insertSyntheticIssue,
  insertSyntheticMessages,
  insertSyntheticRuntime,
  insertSyntheticTask,
  truncatedJsonText,
} from "../../../scripts/lib/task-trace-synthetic.js";
import { traceBackfillBackends, type OpenedStore, type StoreBackend } from "./trace-backfill-backends.js";

const TIMEOUT = 120_000;
const T0 = "2026-08-01T00:00:00.000Z";
const ENDED = "2026-08-10T00:00:00.000Z";
const CUTOFF = "2026-09-01T00:00:00.000Z";
const AGENT = "agt_gd";
const RUNTIME = "rt_gd";
const STAGING = ".trace-backfill-staging";

const backends = await traceBackfillBackends("guards");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function at(second: number): string {
  return new Date(Date.parse(T0) + second * 1000).toISOString();
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function task(id: string, extra: Partial<Parameters<typeof insertSyntheticTask>[1]> = {}) {
  return {
    id, agentId: AGENT, runtimeId: RUNTIME, status: "completed", createdAt: T0, startedAt: at(1), endedAt: ENDED, ...extra,
  };
}

/**
 * A Chat with a traced and a `none` task, an Issue session with two traced
 * tasks and a `none` one, and a one-shot Task. One input and one meta are
 * truncated. The `turn` cards come from MUL-427's conversation backfill.
 */
function seedWorld(db: SqlDatabase): void {
  insertSyntheticAgent(db, { id: AGENT, provider: "claude", createdAt: T0 });
  insertSyntheticRuntime(db, { id: RUNTIME, provider: "codex", daemonId: "dmn_gd", createdAt: T0 });
  insertSyntheticChat(db, { id: "chs_gd", agentId: AGENT, createdAt: T0 });
  insertSyntheticIssue(db, { id: "iss_gd", number: 1, createdAt: T0 });
  db.run(
    "INSERT INTO multiremi_issue_sessions (id, issue_id, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
    "ises_gd", "iss_gd", T0, T0,
  );

  insertSyntheticTask(db, task("tsk_chat_a", { chatSessionId: "chs_gd" }));
  insertSyntheticMessages(db, "tsk_chat_a", [
    { seq: 1, type: "execution", meta: "{\"provider\":\"claude\",\"model\":\"m1\"}", created_at: at(1) },
    { seq: 2, type: "tool_use", tool: "Write", tool_call_id: "c1", input: truncatedJsonText(400, "i"), created_at: at(2) },
    { seq: 3, type: "tool_result", tool: "Write", tool_call_id: "c1", output: "ok", status: "completed", created_at: at(3) },
    { seq: 4, type: "text", content: "done", created_at: at(4) },
  ]);
  insertSyntheticTask(db, task("tsk_chat_none", { chatSessionId: "chs_gd", status: "failed" }));
  const chatMessage = (sequence: number, role: "user" | "assistant", body: string, taskId: string | null) => db.run(
    `INSERT INTO multiremi_chat_messages (id, chat_session_id, task_id, role, body, failure_reason, elapsed_ms, sequence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `chm_gd_${sequence}`, "chs_gd", taskId, role, body, taskId === "tsk_chat_none" ? "boom" : null,
    role === "assistant" ? 1000 : null, sequence, at(sequence),
  );
  chatMessage(1, "user", "hi", null);
  chatMessage(2, "assistant", "done", "tsk_chat_a");
  chatMessage(3, "user", "again", null);
  chatMessage(4, "assistant", "", "tsk_chat_none");

  insertSyntheticTask(db, task("tsk_issue_a", { issueId: "iss_gd", issueSessionId: "ises_gd" }));
  insertSyntheticMessages(db, "tsk_issue_a", [
    { seq: 1, type: "text", content: "looking", created_at: at(1) },
    { seq: 2, type: "execution", meta: truncatedJsonText(300, "m"), created_at: at(2) },
  ]);
  insertSyntheticTask(db, task("tsk_issue_b", { issueId: "iss_gd", issueSessionId: "ises_gd" }));
  insertSyntheticMessages(db, "tsk_issue_b", [
    { seq: 1, type: "tool_use", tool: "Bash", tool_call_id: "b1", input: "{\"cmd\":\"ls\"}", created_at: at(1) },
  ]);
  insertSyntheticTask(db, task("tsk_issue_none", { issueId: "iss_gd", issueSessionId: "ises_gd", status: "cancelled" }));
  const sessionEvent = (seq: number, kind: string, taskId: string) => db.run(
    `INSERT INTO multiremi_session_events (id, session_id, seq, author_type, author_id, kind, body, task_id, metadata, created_at)
     VALUES (?, ?, ?, 'member', 'local', ?, ?, ?, '{}', ?)`,
    `sev_gd_${seq}`, "ises_gd", seq, kind, kind === "task_assigned" ? `do ${taskId}` : "", taskId, at(seq),
  );
  sessionEvent(1, "task_assigned", "tsk_issue_a");
  sessionEvent(2, "task_completed", "tsk_issue_a");
  sessionEvent(3, "task_assigned", "tsk_issue_b");
  sessionEvent(4, "task_completed", "tsk_issue_b");
  sessionEvent(5, "task_assigned", "tsk_issue_none");
  sessionEvent(6, "task_cancelled", "tsk_issue_none");

  insertSyntheticTask(db, task("tsk_one", { runtimeId: null, provider: "claude" }));
  insertSyntheticMessages(db, "tsk_one", [{ seq: 1, type: "text", content: "solo", created_at: at(1) }]);

  const report = db.transaction(() => backfillConversationLogWithinTransaction(db))();
  expect(report.mismatches).toEqual([]);
}

interface World {
  opened: OpenedStore;
  db: SqlDatabase;
  /** The archive root; `scratch` is outside it. */
  root: string;
  scratch: string;
  run(overrides?: Partial<TraceBackfillRunOptions>): ReturnType<typeof runTraceBackfill>;
}

async function withWorld(backend: StoreBackend, body: (world: World) => Promise<void>) {
  const opened = await backend.open();
  const base = await mkdtemp(join(tmpdir(), "m432-guards-"));
  const root = join(base, "archives");
  const scratch = join(base, "scratch");
  try {
    await mkdir(root);
    await mkdir(scratch);
    seedWorld(opened.db);
    const service = new SessionArchiveService(opened.store, { root, minFreeBytes: 0 });
    await body({
      opened,
      db: opened.db,
      root,
      scratch,
      run: (overrides = {}) => runTraceBackfill({
        db: opened.db, execute: true, oldTableStoppedAt: CUTOFF, store: opened.store, service, log: () => {}, ...overrides,
      }),
    });
  } finally {
    await opened.close();
    await rm(base, { recursive: true, force: true });
  }
}

const COMMITTED_TABLES: Record<string, string> = {
  multiremi_session_archives: "id",
  multiremi_task_traces: "task_id",
  multiremi_trace_backfill_tasks: "task_id",
  multiremi_conversation_log: "session_id, seq",
  multiremi_conversation_heads: "session_id",
};

/** Everything a subject commit writes, except the progress row `markRunning` claims before staging. */
async function committedState(world: World) {
  const tables = Object.fromEntries(Object.entries(COMMITTED_TABLES).map(([table, order]) => [
    table, world.db.query(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
  ]));
  const files = (await readdir(world.root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(world.root, join(entry.parentPath, entry.name)));
  return { tables, archiveFiles: files.filter((path) => !path.startsWith(STAGING)).sort() };
}

function backfillArchives(world: World, kind: "issue" | "chat" | "task", id: string) {
  return world.opened.store.listSessionArchivesForSubject(kind, id)
    .filter((archive) => archive.metadata.kind === "trace_backfill");
}

function progressRows(world: World): number {
  return Number((world.db.query("SELECT COUNT(*) AS n FROM multiremi_trace_backfill_progress").get() as { n: unknown }).n);
}

async function reconcileFull(world: World) {
  return reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
}

/**
 * `db`, except that the plan's SQL count of `<column> LIKE '%<marker>'`
 * answers one more than the table holds. Every other statement passes through.
 */
function skewTruncatedCount(db: SqlDatabase, column: "input" | "meta") {
  let hits = 0;
  const target = new RegExp(`COUNT\\(\\*\\)[\\s\\S]*\\b${column}\\s+LIKE\\s+\\?`, "i");
  const skewed = new Proxy(db, {
    get(base, property) {
      if (property === "query") {
        return (sql: string): SqlStatement => {
          const statement = base.query(sql);
          if (!target.test(sql)) return statement;
          hits++;
          return {
            get: (...params) => ({ n: Number((statement.get(...params) as { n: unknown }).n) + 1 }),
            all: (...params) => statement.all(...params),
            run: (...params) => statement.run(...params),
            values: (...params) => statement.values(...params),
          };
        };
      }
      const value = Reflect.get(base, property, base);
      return typeof value === "function" ? value.bind(base) : value;
    },
  });
  return { db: skewed, hits: () => hits };
}

type CommitStep = "fillTurnCards" | "markDone" | "replaceTasks";

/**
 * Make one step of `commitTraceBackfill` do its writes and then throw, on the
 * progress repo instance of the store the run commits through. Records whether
 * the step ran inside a transaction. Returns the undo.
 */
function failAfterWriting(world: World, step: CommitStep) {
  const repo = (world.opened.store as unknown as { traceBackfillProgress: TraceBackfillProgressRepo }).traceBackfillProgress;
  const original = repo[step] as (...args: unknown[]) => unknown;
  expect(typeof original).toBe("function");
  const inTransaction: boolean[] = [];
  (repo as unknown as Record<CommitStep, unknown>)[step] = (...args: unknown[]) => {
    inTransaction.push(Boolean(world.db.inTransaction));
    original.apply(repo, args);
    throw new Error(`injected ${step} failure`);
  };
  return {
    inTransaction,
    restore: () => {
      delete (repo as unknown as Partial<Record<CommitStep, unknown>>)[step];
    },
  };
}

/**
 * Record the deepest `transaction()` nesting of each `commitTraceBackfill`
 * call, counting every frame, outer and nested (ADR 0011: the outermost caller
 * owns the only transaction). The store's database proxy forwards
 * `transaction` to this handle on every read. On Postgres the driver's own
 * `maxTransactionDepth` is recorded too. Returns the undo.
 */
function commitDepths(world: World) {
  const target = world.db as unknown as { transaction: (fn: (...args: never[]) => unknown) => (...args: unknown[]) => unknown };
  const original = target.transaction;
  let depth = 0;
  let max = 0;
  target.transaction = (fn) => {
    const run = original.call(target, fn);
    return (...args: unknown[]) => {
      depth += 1;
      max = Math.max(max, depth);
      try {
        return run(...args);
      } finally {
        depth -= 1;
      }
    };
  };
  const pg = world.db as unknown as { maxTransactionDepth?: number; resetTransactionDepthStats?: () => void };
  const store = world.opened.store as unknown as { commitTraceBackfill: (...args: unknown[]) => unknown };
  const commit = store.commitTraceBackfill;
  const frames: number[] = [];
  const driver: number[] = [];
  store.commitTraceBackfill = (...args: unknown[]) => {
    max = 0;
    pg.resetTransactionDepthStats?.();
    try {
      return commit.apply(store, args);
    } finally {
      frames.push(max);
      if (pg.maxTransactionDepth !== undefined) driver.push(pg.maxTransactionDepth);
    }
  };
  return {
    frames,
    driver,
    restore: () => {
      delete (target as Partial<typeof target>).transaction;
      delete (store as Partial<typeof store>).commitTraceBackfill;
    },
  };
}

const COMMIT_STEPS: Array<{ step: CommitStep; name: string }> = [
  { step: "fillTurnCards", name: "the turn-card write (fillTurnCards)" },
  { step: "markDone", name: "the done mark (markDone)" },
  { step: "replaceTasks", name: "the per-task digests (replaceTasks)" },
];

for (const backend of backends) {
  describe.skipIf(!backend.available)(`trace backfill guards (${backend.name})`, () => {
    for (const column of ["input", "meta"] as const) {
      const code = `json_unparseable_${column}_mismatch`;
      it(`stops with ${code} when the SQL LIKE count of truncated ${column} disagrees, before writing anything`, async () => {
        await withWorld(backend, async (world) => {
          const before = await committedState(world);
          const skewed = skewTruncatedCount(world.db, column);
          const error = await world.run({ db: skewed.db }).catch((caught: unknown) => caught);
          expect(skewed.hits()).toBe(1);
          expect(error).toBeInstanceOf(TraceBackfillStopError);
          expect((error as TraceBackfillStopError).stops).toEqual([
            expect.objectContaining({ code, count: 1, samples: [{ counted: 1, sql: 2 }] }),
          ]);
          expect(await committedState(world)).toEqual(before);
          expect(progressRows(world)).toBe(0);
          expect(await readdir(world.root)).toEqual([]);

          // Control: the same corpus, counted as it is, does not stop and writes.
          const report = await world.run();
          expect(report.plan.stops).toEqual([]);
          expect(report.plan.json).toMatchObject({
            json_unparseable_input: 1, sql_truncated_input: 1, json_unparseable_meta: 1, sql_truncated_meta: 1,
          });
          expect(backfillArchives(world, "chat", "chs_gd")).toHaveLength(1);
          expect(backfillArchives(world, "issue", "iss_gd")).toHaveLength(1);
          expect(world.opened.store.getTaskTrace("tsk_chat_a")).toMatchObject({ location: "archive", headSeq: 4 });
        });
      }, TIMEOUT);
    }

    it("clears a killed run's staged trace files before restaging a running subject, so it resumes", async () => {
      await withWorld(backend, async (world) => {
        const { store } = world.opened;
        const stage = join(world.root, STAGING, `issue-${b64("iss_gd")}`);
        const killed = join(world.scratch, "killed-stage");
        await expect(world.run({
          hooks: {
            afterStage: async (subject) => {
              if (subject.id !== "iss_gd") return;
              // A killed process never reaches the `finally` that clears the stage.
              await cp(stage, killed, { recursive: true });
              throw new Error("simulated kill");
            },
          },
        })).rejects.toThrow("simulated kill");
        await cp(killed, stage, { recursive: true });
        const tracesDir = join(stage, "runtime", "backfill", "traces");
        for (const taskId of ["tsk_issue_a", "tsk_issue_b"]) {
          expect(existsSync(join(tracesDir, `${taskId}${SESSION_ARCHIVE_TRACE_SUFFIX}`))).toBe(true);
        }
        expect(store.getTraceBackfillProgress("issue", "iss_gd")).toMatchObject({ status: "running", archiveId: null });
        expect(store.getTaskTrace("tsk_issue_a")).toBeNull();

        const rerun = await world.run();
        expect(rerun.execution!.chat.skipped_done).toBe(1);
        expect(rerun.execution!.issue_without_archive).toMatchObject({
          subjects: 1, resumed_interrupted: 1, written: 1, archives_created: 1, pointers: 2, none_pointers: 1,
        });
        const [archive] = backfillArchives(world, "issue", "iss_gd");
        expect(store.getTraceBackfillProgress("issue", "iss_gd")).toMatchObject({ status: "done", archiveId: archive!.id });
        expect(store.getTaskTrace("tsk_issue_a")).toMatchObject({ location: "archive", archiveId: archive!.id, headSeq: 2 });
        expect(store.getTaskTrace("tsk_issue_b")).toMatchObject({ location: "archive", archiveId: archive!.id, headSeq: 1 });
        expect(store.getTaskTrace("tsk_issue_none")).toMatchObject({ location: "none" });
        expect(existsSync(stage)).toBe(false);
        expect(rerun.reconcile.issue_without_archive).toMatchObject({ ok: true, mismatch_total: 0 });
        expect((await reconcileFull(world)).ok).toBe(true);
      });
    }, TIMEOUT);

    it("commits every subject at transaction depth 1", async () => {
      await withWorld(backend, async (world) => {
        const depths = commitDepths(world);
        try {
          const report = await world.run();
          expect(report.execution!.chat).toMatchObject({ archives_created: 1 });
          expect(report.execution!.issue_without_archive).toMatchObject({ archives_created: 1 });
        } finally {
          depths.restore();
        }
        expect(depths.frames.length).toBeGreaterThanOrEqual(2);
        expect(depths.frames).toEqual(depths.frames.map(() => 1));
        if (backend.name === "postgres") expect(depths.driver).toEqual(depths.frames);
      });
    }, TIMEOUT);

    for (const { step, name } of COMMIT_STEPS) {
      it(`commits nothing of a new subject when ${name} fails inside the commitTraceBackfill transaction`, async () => {
        await withWorld(backend, async (world) => {
          const { store } = world.opened;
          // The Chat is the first commit of the run.
          const before = await committedState(world);
          const injected = failAfterWriting(world, step);
          await expect(world.run()).rejects.toThrow(`injected ${step} failure`);
          injected.restore();
          expect(backfillArchives(world, "chat", "chs_gd")).toEqual([]);
          expect(store.getTaskTrace("tsk_chat_a")).toBeNull();
          expect(store.getTaskTrace("tsk_chat_none")).toBeNull();
          expect(store.getTraceBackfillProgress("chat", "chs_gd")).toMatchObject({ status: "running", archiveId: null });
          expect(progressRows(world)).toBe(1);
          expect(await committedState(world)).toEqual(before);
          expect(injected.inTransaction).toEqual([true]);

          const resumed = await world.run();
          expect(resumed.execution!.chat).toMatchObject({
            resumed_interrupted: 1, written: 1, archives_created: 1, pointers: 1, none_pointers: 1, turn_cards_updated: 2,
          });
          const [archive] = backfillArchives(world, "chat", "chs_gd");
          expect(store.getTaskTrace("tsk_chat_a")).toMatchObject({ location: "archive", archiveId: archive!.id, headSeq: 4 });
          expect(store.getTaskTrace("tsk_chat_none")).toMatchObject({ location: "none" });
          expect(store.findTurnEntry("tsk_chat_a")!.metadata).toMatchObject({ event_count: 4, tool_call_count: 1 });
          expect(store.getTraceBackfillProgress("chat", "chs_gd")).toMatchObject({ status: "done", archiveId: archive!.id });
          expect((await reconcileFull(world)).ok).toBe(true);
        });
      }, TIMEOUT);

      it(`keeps a done subject's archive, pointers and cards when ${name} fails inside commitTraceBackfill on a redo`, async () => {
        await withWorld(backend, async (world) => {
          const { store } = world.opened;
          await world.run();
          insertSyntheticMessages(world.db, "tsk_issue_a", [
            { seq: 9, type: "tool_use", tool: "Edit", tool_call_id: "e1", input: "{\"f\":\"a\"}", created_at: at(9) },
          ]);
          const [previous] = backfillArchives(world, "issue", "iss_gd");
          const before = await committedState(world);
          const injected = failAfterWriting(world, step);
          await expect(world.run()).rejects.toThrow(`injected ${step} failure`);
          injected.restore();
          expect(backfillArchives(world, "issue", "iss_gd").map((archive) => archive.id)).toEqual([previous!.id]);
          expect(store.getTaskTrace("tsk_issue_a")).toMatchObject({ archiveId: previous!.id, headSeq: 2 });
          expect(store.findTurnEntry("tsk_issue_a")!.metadata).toMatchObject({ event_count: 2 });
          expect(store.getTraceBackfillProgress("issue", "iss_gd")).toMatchObject({
            status: "running", archiveId: previous!.id,
          });
          expect(await committedState(world)).toEqual(before);
          expect(injected.inTransaction).toEqual([true]);

          const redone = await world.run();
          expect(redone.execution!.issue_without_archive).toMatchObject({
            resumed_interrupted: 1, archives_created: 1, pointers: 2, turn_cards_updated: 1, turn_cards_unchanged: 2,
          });
          const current = store.getTaskTrace("tsk_issue_a")!;
          expect(current).toMatchObject({ location: "archive", headSeq: 9, eventCount: 3 });
          expect(current.archiveId).not.toBe(previous!.id);
          expect(store.findTurnEntry("tsk_issue_a")!.metadata).toMatchObject({ event_count: 3, tool_call_count: 1 });
          expect(store.getTraceBackfillProgress("issue", "iss_gd")).toMatchObject({
            status: "done", archiveId: current.archiveId,
          });
          expect((await reconcileFull(world)).ok).toBe(true);
        });
      }, TIMEOUT);
    }
  });
}
