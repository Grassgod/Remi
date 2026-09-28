/**
 * MUL-432 synthetic data: the corpus generator shared by the tests, the local
 * drill and the read-latency bench. On SQLite and Postgres it must be
 * deterministic, hold every shape the backfill cares about at any scale, agree
 * with the backfill's dry-run counters and with plain SQL, and backfill and
 * reconcile cleanly.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";
import { runTraceBackfill } from "../../../scripts/backfill-task-traces.js";
import { TRACE_BACKFILL_GROUPS } from "../../../scripts/lib/task-trace-backfill.js";
import { reconcileTraceBackfill } from "../../../scripts/lib/task-trace-reconcile.js";
import {
  generateSyntheticCorpus,
  PRODUCTION_TRACE_SHAPE,
  SYNTHETIC_CORPUS_DEFAULTS,
  type SyntheticCorpusParams,
} from "../../../scripts/lib/task-trace-synthetic.js";
import { traceBackfillBackends, type OpenedStore } from "./trace-backfill-backends.js";

const TIMEOUT = 180_000;
const MARKER_LIKE = `%${TRACE_TRUNCATION_MARKER}`;
/** Six characters `\u0000`; `ESCAPE '!'` keeps Postgres from reading the backslash as LIKE's escape. */
const NUL_ESCAPE_LIKE = "%\\u0000%";

const backends = await traceBackfillBackends("synthetic");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function params(overrides: Partial<SyntheticCorpusParams> = {}): SyntheticCorpusParams {
  return { ...SYNTHETIC_CORPUS_DEFAULTS, seed: "m432-synthetic", tasksWithRows: 40, rowScale: 0.05, ...overrides };
}

function scalar(db: SqlDatabase, sql: string, ...values: unknown[]): number {
  return Number((db.query(sql).get(...values) as { n: unknown }).n);
}

function oldTableDigest(db: SqlDatabase): string {
  const hash = createHash("sha256");
  for (const table of ["multiremi_tasks", "multiremi_task_messages", "multiremi_issues", "multiremi_chat_sessions"]) {
    hash.update(JSON.stringify(db.query(`SELECT * FROM ${table} ORDER BY id`).all()));
  }
  return hash.digest("hex");
}

async function withStore(backend: (typeof backends)[number], body: (opened: OpenedStore) => Promise<void>) {
  const opened = await backend.open();
  try {
    await body(opened);
  } finally {
    await opened.close();
  }
}

describe("synthetic corpus shape", () => {
  it("records the production statistics it follows", () => {
    const shape = PRODUCTION_TRACE_SHAPE;
    const groupRows = Object.values(shape.groups).reduce((sum, group) => sum + group.rows, 0);
    const typeRows = Object.values(shape.typeRows).reduce((sum, rows) => sum + rows, 0);
    // The two breakdowns come from separate queries over a live table; they agree to within 0.03 %.
    expect(Math.abs(groupRows - typeRows) / groupRows).toBeLessThan(0.0003);
    expect(shape.noneTasks).toEqual({ issue: 134, chat: 10, task: 10 });
    expect(shape.truncatedInputRows).toBe(187);
    expect(shape.nulEscapeMetaRows).toBe(112);
  });
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`synthetic corpus (${backend.name})`, () => {
    it("is deterministic for a seed and differs across seeds", async () => {
      const digests: string[] = [];
      const summaries: unknown[] = [];
      for (const seed of ["m432-synthetic", "m432-synthetic", "m432-other"]) {
        await withStore(backend, async (opened) => {
          summaries.push(generateSyntheticCorpus(opened.db, params({ seed })));
          digests.push(oldTableDigest(opened.db));
        });
      }
      expect(digests[1]).toBe(digests[0]);
      expect(summaries[1]).toEqual(summaries[0]);
      expect(digests[2]).not.toBe(digests[0]);
    }, TIMEOUT);

    it("holds every shape, matches SQL and the dry-run counters, then backfills and reconciles with no mismatch", async () => {
      await withStore(backend, async (opened) => {
        const db = opened.db;
        const input = params();
        const summary = generateSyntheticCorpus(db, input);
        const cutoff = input.oldTableStoppedAt;

        // Every shape exists even at this scale.
        for (const group of TRACE_BACKFILL_GROUPS) {
          expect(summary.subjects[group]).toBeGreaterThan(0);
          expect(summary.tasks.by_group[group]).toBeGreaterThan(0);
        }
        expect(summary.tasks.with_rows).toBe(40);
        expect(Object.keys(summary.rows.by_type).sort()).toEqual(Object.keys(PRODUCTION_TRACE_SHAPE.typeRows).sort());
        expect(summary.tasks.none.issue).toBeGreaterThan(0);
        expect(summary.tasks.none.chat).toBeGreaterThan(0);
        expect(summary.tasks.none.task).toBeGreaterThan(0);
        expect(summary.tasks.nonterminal_with_rows).toBe(2);
        expect(summary.special.truncated_input).toBeGreaterThanOrEqual(input.forced.truncatedInput);
        expect(summary.special.truncated_output).toBeGreaterThanOrEqual(input.forced.truncatedOutput);
        expect(summary.special.truncated_meta).toBe(input.forced.truncatedMeta);
        expect(summary.special.nul_escape_meta).toBeGreaterThanOrEqual(input.forced.nulMeta);
        expect(summary.sparse.tasks_with_gaps).toBeGreaterThan(0);
        expect(summary.sparse.widest_span_task).not.toBeNull();

        // The summary is what SQL sees.
        expect(scalar(db, "SELECT COUNT(*) AS n FROM multiremi_task_messages")).toBe(summary.rows.total);
        expect(scalar(db, "SELECT COUNT(DISTINCT task_id) AS n FROM multiremi_task_messages")).toBe(summary.tasks.with_rows);
        expect(scalar(db, "SELECT COUNT(*) AS n FROM multiremi_task_messages WHERE input LIKE ?", MARKER_LIKE))
          .toBe(summary.special.truncated_input);
        expect(scalar(db, "SELECT COUNT(*) AS n FROM multiremi_task_messages WHERE output LIKE ?", MARKER_LIKE))
          .toBe(summary.special.truncated_output);
        expect(scalar(db, "SELECT COUNT(*) AS n FROM multiremi_task_messages WHERE meta LIKE ?", MARKER_LIKE))
          .toBe(summary.special.truncated_meta);
        expect(scalar(db, "SELECT COUNT(*) AS n FROM multiremi_task_messages WHERE meta LIKE ? ESCAPE '!'", NUL_ESCAPE_LIKE))
          .toBe(summary.special.nul_escape_meta);
        const truncatedInputs = db.query("SELECT input FROM multiremi_task_messages WHERE input LIKE ?").all(MARKER_LIKE) as Array<{ input: string }>;
        for (const row of truncatedInputs) expect(Buffer.byteLength(row.input, "utf8")).toBeGreaterThan(256 * 1024);
        expect(scalar(db, `SELECT COUNT(*) AS n FROM (
            SELECT task_id FROM multiremi_task_messages GROUP BY task_id HAVING MAX(seq) > COUNT(*)
          ) t`)).toBe(summary.sparse.tasks_with_gaps);
        expect(scalar(db, "SELECT MIN(seq) AS n FROM multiremi_task_messages")).toBe(1);
        expect(scalar(
          db,
          "SELECT MAX(seq) - COUNT(*) AS n FROM multiremi_task_messages WHERE task_id = ?",
          summary.sparse.widest_span_task,
        )).toBe(PRODUCTION_TRACE_SHAPE.widestSpan.head - PRODUCTION_TRACE_SHAPE.widestSpan.rows);

        // The dry-run counts the same things.
        const dry = await runTraceBackfill({ db, execute: false, oldTableStoppedAt: cutoff, log: () => {} });
        const plan = dry.plan;
        expect(plan.stops).toEqual([]);
        expect(plan.source).toMatchObject({
          rows: summary.rows.total,
          tasks_with_rows: summary.tasks.with_rows,
          orphan_rows: 0,
          nonterminal_tasks_with_rows: 2,
          chat_missing_as_task: 0,
        });
        expect(plan.none).toMatchObject({ cutoff_evaluated: true, eligible_by_kind: summary.tasks.none });
        for (const group of TRACE_BACKFILL_GROUPS) {
          expect(plan.groups[group].subjects).toBe(summary.subjects[group]);
        }
        const tracedTasks = TRACE_BACKFILL_GROUPS.reduce((sum, group) => sum + plan.groups[group].traced_tasks, 0);
        expect(tracedTasks).toBe(summary.tasks.with_rows - summary.tasks.nonterminal_with_rows);
        expect(plan.json).toMatchObject({
          json_unparseable_input: summary.special.truncated_input,
          sql_truncated_input: summary.special.truncated_input,
          json_unparseable_meta: summary.special.truncated_meta,
          sql_truncated_meta: summary.special.truncated_meta,
          json_unparseable_unexplained: 0,
          json_nonroundtrip: 0,
        });
        expect(plan.json.meta.nul_escape_rows).toBe(summary.special.nul_escape_meta);

        // Execute, then a full reconciliation.
        const root = await mkdtemp(join(tmpdir(), "m432-syn-"));
        try {
          const service = new SessionArchiveService(opened.store, { root, minFreeBytes: 0 });
          const run = await runTraceBackfill({
            db, execute: true, oldTableStoppedAt: cutoff, store: opened.store, service, log: () => {},
          });
          for (const group of TRACE_BACKFILL_GROUPS) {
            expect(run.reconcile[group]?.ok).toBe(true);
            expect(run.execution![group].subjects).toBe(plan.groups[group].subjects);
          }
          const full = await reconcileTraceBackfill(db, { archiveRoot: root, oldTableStoppedAt: cutoff });
          expect(full).toMatchObject({
            mode: "full",
            ok: true,
            mismatch_total: 0,
            checked_tasks: tracedTasks,
            checked_none: summary.tasks.none.issue + summary.tasks.none.chat + summary.tasks.none.task,
          });

          // A truncated input reads back as null; a NUL escape in meta survives.
          const reader = new SessionArchiveReader({ store: opened.store, root });
          const truncatedRow = db.query(
            "SELECT task_id, seq FROM multiremi_task_messages WHERE input LIKE ? ORDER BY task_id, seq LIMIT 1",
          ).get(MARKER_LIKE) as { task_id: string; seq: number };
          const nulRow = db.query(
            "SELECT task_id, seq FROM multiremi_task_messages WHERE meta LIKE ? ESCAPE '!' ORDER BY task_id, seq LIMIT 1",
          ).get(NUL_ESCAPE_LIKE) as { task_id: string; seq: number };
          const event = async (row: { task_id: string; seq: number }) => {
            const pointer = opened.store.getTaskTrace(row.task_id)!;
            const member = await reader.readArchiveMember(pointer.archiveId!, {
              dataOffset: pointer.dataOffset!,
              compressedSize: pointer.compressedSize!,
              uncompressedSize: pointer.uncompressedSize ?? undefined,
              sha256: pointer.sha256 ?? undefined,
            });
            const lines = member.bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
            return lines.find((line) => line.seq === Number(row.seq)) as Record<string, unknown>;
          };
          expect((await event(truncatedRow)).input).toBeNull();
          expect(JSON.stringify((await event(nulRow)).meta)).toContain("\\u0000");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }, TIMEOUT);
  });
}
