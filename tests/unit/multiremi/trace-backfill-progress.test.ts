/**
 * MUL-432 item 7: the per-subject progress and per-task digest tables of the
 * trace backfill, on SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { runMigrations } from "@multiremi/store/migrations.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";

const backends = await traceBackfillBackends("progress");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`trace backfill progress (${backend.name})`, () => {
    it("creates the progress table idempotently with the documented columns", async () => {
      const opened = await backend.open();
      try {
        const columns = (opened.db.query("PRAGMA table_info(multiremi_trace_backfill_progress)").all() as Array<{
          name: string;
        }>).map((column) => column.name);
        expect([...columns].sort()).toEqual([
          "archive_id", "digest", "row_count", "status", "subject_id", "subject_kind", "task_count", "updated_at",
        ]);
        opened.store.markTraceBackfillRunning({
          subjectKind: "chat", subjectId: "chs_a", taskCount: 2, rowCount: 7, digest: "d1",
        });
        // A second startup must neither fail nor touch existing progress.
        runMigrations(opened.db);
        expect(opened.store.getTraceBackfillProgress("chat", "chs_a")).toMatchObject({
          status: "running", taskCount: 2, rowCount: 7, digest: "d1", archiveId: null,
        });
      } finally {
        await opened.close();
      }
    });

    it("moves a subject between running and done and keeps the last archive while redoing", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        expect(store.getTraceBackfillProgress("issue", "iss_a")).toBeNull();
        store.markTraceBackfillRunning({
          subjectKind: "issue", subjectId: "iss_a", taskCount: 3, rowCount: 1200, digest: "d1",
        });
        opened.db.transaction(() => {
          store.markTraceBackfillDone({
            subjectKind: "issue", subjectId: "iss_a", taskCount: 3, rowCount: 1200, digest: "d1", archiveId: "sar_1",
          });
        })();
        expect(store.getTraceBackfillProgress("issue", "iss_a")).toMatchObject({
          status: "done", taskCount: 3, rowCount: 1200, digest: "d1", archiveId: "sar_1",
        });

        // The source changed: the redo claims the subject again but the old
        // archive stays recorded until the new one is ready.
        store.markTraceBackfillRunning({
          subjectKind: "issue", subjectId: "iss_a", taskCount: 3, rowCount: 1300, digest: "d2",
        });
        expect(store.getTraceBackfillProgress("issue", "iss_a")).toMatchObject({
          status: "running", rowCount: 1300, digest: "d2", archiveId: "sar_1",
        });
        opened.db.transaction(() => {
          store.markTraceBackfillDone({
            subjectKind: "issue", subjectId: "iss_a", taskCount: 3, rowCount: 1300, digest: "d2", archiveId: "sar_2",
          });
        })();

        // Row counts above 2^31 survive the BIGINT column.
        store.markTraceBackfillRunning({
          subjectKind: "task", subjectId: "tsk_big", taskCount: 1, rowCount: 3_000_000_000, digest: "d3",
        });
        store.markTraceBackfillRunning({
          subjectKind: "chat", subjectId: "chs_b", taskCount: 0, rowCount: 0, digest: "d4",
        });
        expect(store.listTraceBackfillProgress().map((row) => [row.subjectKind, row.subjectId, row.status, row.rowCount, row.archiveId]))
          .toEqual([
            ["chat", "chs_b", "running", 0, null],
            ["issue", "iss_a", "done", 1300, "sar_2"],
            ["task", "tsk_big", "running", 3_000_000_000, null],
          ]);
      } finally {
        await opened.close();
      }
    });

    it("replaces a subject's per-task digests and moves a task that changed subject", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        const columns = (opened.db.query("PRAGMA table_info(multiremi_trace_backfill_tasks)").all() as Array<{
          name: string;
        }>).map((column) => column.name);
        expect([...columns].sort()).toEqual([
          "archive_id", "digest", "head_seq", "row_count", "subject_id", "subject_kind", "task_id", "updated_at",
        ]);
        opened.db.transaction(() => {
          store.replaceTraceBackfillTasks("chat", "chs_a", "sar_1", [
            { taskId: "tsk_1", rowCount: 3, headSeq: 5, digest: "t1" },
            { taskId: "tsk_2", rowCount: 1, headSeq: 1, digest: "t2" },
          ]);
        })();
        // The redo drops tasks that no longer have rows and rewrites the rest.
        opened.db.transaction(() => {
          store.replaceTraceBackfillTasks("chat", "chs_a", "sar_2", [
            { taskId: "tsk_1", rowCount: 4, headSeq: 9, digest: "t1b" },
          ]);
        })();
        expect(store.listTraceBackfillTasks("chat", "chs_a").map((task) => [task.taskId, task.archiveId, task.rowCount, task.headSeq, task.digest]))
          .toEqual([["tsk_1", "sar_2", 4, 9, "t1b"]]);

        // A deleted Chat Session leaves the task subject-less: it is redone as a
        // one-shot Task and its digest row follows it.
        opened.db.transaction(() => {
          store.replaceTraceBackfillTasks("task", "tsk_1", "sar_3", [
            { taskId: "tsk_1", rowCount: 4, headSeq: 9, digest: "t1b" },
          ]);
        })();
        expect(store.listTraceBackfillTasks("chat", "chs_a")).toEqual([]);
        expect(store.listTraceBackfillTasks("task", "tsk_1").map((task) => task.archiveId)).toEqual(["sar_3"]);
      } finally {
        await opened.close();
      }
    });

    it("rolls a done mark back with the transaction that owns it", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        store.markTraceBackfillRunning({
          subjectKind: "task", subjectId: "tsk_a", taskCount: 1, rowCount: 5, digest: "d1",
        });
        expect(() => opened.db.transaction(() => {
          store.markTraceBackfillDone({
            subjectKind: "task", subjectId: "tsk_a", taskCount: 1, rowCount: 5, digest: "d1", archiveId: "sar_x",
          });
          store.replaceTraceBackfillTasks("task", "tsk_a", "sar_x", [
            { taskId: "tsk_a", rowCount: 5, headSeq: 5, digest: "t" },
          ]);
          throw new Error("ready insert failed");
        })()).toThrow("ready insert failed");
        expect(store.getTraceBackfillProgress("task", "tsk_a")).toMatchObject({ status: "running", archiveId: null });
        expect(store.listTraceBackfillTasks("task", "tsk_a")).toEqual([]);
      } finally {
        await opened.close();
      }
    });
  });
}
