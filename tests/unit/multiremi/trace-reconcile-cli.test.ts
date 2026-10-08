/**
 * MUL-432 item 9: `scripts/reconcile-task-traces.ts`, the read-only check of
 * the trace backfill, as a seeded sample over every group and in full, run as
 * a separate process against SQLite and Postgres.
 */
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_ARCHIVE_FORMAT_V2 } from "@multiremi/contracts/session-archive.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { runTraceBackfill } from "../../../scripts/backfill-task-traces.js";
import { assignTraceBackfillSubjects } from "../../../scripts/lib/task-trace-backfill.js";
import {
  selectTraceReconcileSample,
  TRACE_RECONCILE_SAMPLE_QUOTAS,
  TRACE_RECONCILE_SAMPLE_SEED,
} from "../../../scripts/lib/task-trace-reconcile.js";
import {
  insertSyntheticAgent,
  insertSyntheticChat,
  insertSyntheticIssue,
  insertSyntheticMessages,
  insertSyntheticRuntime,
  insertSyntheticTask,
  type SyntheticMessage,
} from "../../../scripts/lib/task-trace-synthetic.js";
import { openReadOnlyTraceDatabase, readOnlySqlDatabase } from "../../../scripts/reconcile-task-traces.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";

const TIMEOUT = 180_000;
const T0 = "2026-08-01T00:00:00.000Z";
const ENDED = "2026-08-10T00:00:00.000Z";
const CUTOFF = "2026-09-01T00:00:00.000Z";
const SCRIPT = join(import.meta.dir, "../../../scripts/reconcile-task-traces.ts");

const backends = await traceBackfillBackends("reconcile");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function rows(taskId: string, count: number): SyntheticMessage[] {
  // Sparse on purpose: seq 1, 3, 5, ...
  return Array.from({ length: count }, (_, i) => ({
    seq: 2 * i + 1,
    type: i % 3 === 1 ? "tool_use" : "text",
    content: `${taskId} event ${i}`,
    input: i % 3 === 1 ? `{"cmd":"echo ${i}"}` : null,
    created_at: new Date(Date.parse(T0) + i * 1000).toISOString(),
  }));
}

/** 43 backfill candidates: 14 chat, 10 one-shot, 15 in Issues without an archive, 4 with one. */
function seedGroups(db: SqlDatabase): void {
  insertSyntheticAgent(db, { id: "agt_r", provider: "claude", createdAt: T0 });
  insertSyntheticRuntime(db, { id: "rt_r", provider: "claude", daemonId: "dmn_r", createdAt: T0 });
  const task = (id: string, extra: Partial<Parameters<typeof insertSyntheticTask>[1]>, rowCount: number) => {
    insertSyntheticTask(db, {
      id, agentId: "agt_r", runtimeId: "rt_r", status: "completed", createdAt: T0, startedAt: T0, endedAt: ENDED, ...extra,
    });
    if (rowCount) insertSyntheticMessages(db, id, rows(id, rowCount));
  };
  for (const chat of ["chat_r1", "chat_r2"]) {
    insertSyntheticChat(db, { id: chat, agentId: "agt_r", createdAt: T0 });
    for (let i = 0; i < 7; i++) task(`tsk_${chat}_${i}`, { chatSessionId: chat }, i === 6 ? 0 : i + 1);
  }
  for (let i = 0; i < 10; i++) task(`tsk_one_${i}`, {}, i < 8 ? i + 1 : 0);
  for (let n = 1; n <= 3; n++) {
    insertSyntheticIssue(db, { id: `iss_r${n}`, number: n, createdAt: T0 });
    for (let i = 0; i < 5; i++) task(`tsk_iss_r${n}_${i}`, { issueId: `iss_r${n}` }, i + 2);
  }
  insertSyntheticIssue(db, { id: "iss_arch", number: 9, createdAt: T0 });
  db.run(
    `INSERT INTO multiremi_session_archives (
       id, workspace_id, issue_id, subject_kind, subject_id, format, runtime_id, daemon_id, source_revision, sha256,
       size_bytes, uploaded_size_bytes, file_count, status, relative_path, metadata, attempt_count, created_at,
       updated_at, completed_at
     ) VALUES ('sar_daemon_r', 'local', 'iss_arch', 'issue', 'iss_arch', ?, 'rt_r', 'dmn_r', 'rev_r', ?, 1, 1, 0,
       'ready', 'workspaces/x/sar_daemon_r/sessions.zip', ?, 1, ?, ?, ?)`,
    SESSION_ARCHIVE_FORMAT_V2, "0".repeat(64),
    JSON.stringify({ format: SESSION_ARCHIVE_FORMAT_V2, subject: { kind: "issue", id: "iss_arch" }, files: [] }),
    T0, T0, T0,
  );
  for (let i = 0; i < 4; i++) task(`tsk_arch_${i}`, { issueId: "iss_arch" }, 3);
}

/** `count` more one-event backfill candidates, one-shot unless linked to an Issue or a Chat. */
function addCandidates(
  db: SqlDatabase,
  prefix: string,
  count: number,
  link: { issueId?: string; chatSessionId?: string } = {},
): void {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}_${i}`;
    insertSyntheticTask(db, {
      id, agentId: "agt_r", runtimeId: "rt_r", ...link, status: "completed", createdAt: T0, startedAt: T0, endedAt: ENDED,
    });
    insertSyntheticMessages(db, id, rows(id, 1));
  }
}

async function backfill(store: MultiremiStore, db: SqlDatabase, root: string): Promise<void> {
  const report = await runTraceBackfill({
    db,
    execute: true,
    oldTableStoppedAt: CUTOFF,
    store,
    service: new SessionArchiveService(store, { root, minFreeBytes: 0 }),
    log: () => {},
  });
  for (const group of Object.values(report.reconcile)) expect(group.ok).toBe(true);
}

interface CliResult {
  exitCode: number;
  stdout: Record<string, any>;
  stderr: string;
}

function runCli(env: Record<string, string>, ...args: string[]): CliResult {
  const home = join(tmpdir(), "m432-reconcile-home");
  const spawned = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, HOME: home, MULTIREMI_DATABASE_URL: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = spawned.stdout.toString();
  return {
    exitCode: spawned.exitCode ?? -1,
    stdout: text.trim() ? JSON.parse(text) : {},
    stderr: spawned.stderr.toString(),
  };
}

function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("reconcile sample selection", () => {
  it("spreads a seeded sample evenly over every group and replays it from the seed", () => {
    const raw = openSqliteDatabase(":memory:");
    const db = Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const });
    try {
      new MultiremiStore(db).ensureLocalWorkspace();
      seedGroups(db);
      const assignment = assignTraceBackfillSubjects(db, { oldTableStoppedAt: CUTOFF });
      const pick = (size: number, seed: string) => selectTraceReconcileSample(assignment, { size, seed });

      const even = pick(12, "a");
      expect(even.taskIds.size).toBe(12);
      expect(Object.values(even.by_group).map((group) => group.sampled)).toEqual([3, 3, 3, 3]);
      expect(Object.values(even.by_group).map((group) => group.candidates)).toEqual([14, 10, 15, 4]);

      // What the four-task group cannot take goes to the others, one at a time in group order.
      const uneven = pick(30, "a");
      expect(uneven.taskIds.size).toBe(30);
      expect(uneven.by_group).toMatchObject({
        chat: { quota: 8, sampled: 9, refill: 1 },
        task: { quota: 8, sampled: 9, refill: 1 },
        issue_without_archive: { quota: 7, sampled: 8, refill: 1 },
        issue_with_archive: { quota: 7, sampled: 4, refill: 0 },
      });
      expect(uneven).toMatchObject({ refilled: 3, note: null });
      const whole = pick(1000, "a");
      expect(whole.taskIds.size).toBe(43);
      expect(whole.by_group.chat).toMatchObject({ sampled_render: 12, sampled_none: 2 });
      expect(whole.by_group.task).toMatchObject({ sampled_render: 8, sampled_none: 2 });

      expect([...pick(12, "a").taskIds]).toEqual([...even.taskIds]);
      expect([...pick(12, "b").taskIds].sort()).not.toEqual([...even.taskIds].sort());
    } finally {
      raw.close();
    }
  });

  it("takes fixed per-group quotas and draws a short group's shortfall from the others in group order", () => {
    expect(TRACE_RECONCILE_SAMPLE_QUOTAS).toEqual({ chat: 50, task: 50, issue_without_archive: 50, issue_with_archive: 50 });
    expect(TRACE_RECONCILE_SAMPLE_SEED).toBe("mul-432-reconcile-sample-v1");
    const raw = openSqliteDatabase(":memory:");
    const db = Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const });
    try {
      new MultiremiStore(db).ensureLocalWorkspace();
      seedGroups(db);
      const assignment = assignTraceBackfillSubjects(db, { oldTableStoppedAt: CUTOFF });
      // issue_with_archive has 4 of its 10: the other 6 come one at a time from chat, task, issue_without_archive.
      const quotas = { chat: 5, task: 3, issue_without_archive: 6, issue_with_archive: 10 };
      const fixed = selectTraceReconcileSample(assignment, { quotas, seed: TRACE_RECONCILE_SAMPLE_SEED });
      expect(fixed).toMatchObject({ requested: 24, refilled: 6, note: null });
      expect(fixed.taskIds.size).toBe(24);
      expect(fixed.by_group).toMatchObject({
        chat: { quota: 5, candidates: 14, sampled: 7, refill: 2 },
        task: { quota: 3, candidates: 10, sampled: 5, refill: 2 },
        issue_without_archive: { quota: 6, candidates: 15, sampled: 8, refill: 2 },
        issue_with_archive: { quota: 10, candidates: 4, sampled: 4, refill: 0 },
      });
      expect([...selectTraceReconcileSample(assignment, { quotas, seed: TRACE_RECONCILE_SAMPLE_SEED }).taskIds])
        .toEqual([...fixed.taskIds]);

      // 43 candidates in all, fewer than 200: every one is taken and the report says why.
      const defaults = selectTraceReconcileSample(assignment, { quotas: TRACE_RECONCILE_SAMPLE_QUOTAS, seed: TRACE_RECONCILE_SAMPLE_SEED });
      expect(defaults).toMatchObject({
        requested: 200, refilled: 0, note: "all 43 candidates taken: the groups hold fewer than the 200 requested",
      });
      expect(defaults.taskIds.size).toBe(43);
      expect(Object.values(defaults.by_group).map((group) => [group.quota, group.sampled])).toEqual([[50, 14], [50, 10], [50, 15], [50, 4]]);
    } finally {
      raw.close();
    }
  });
});

for (const backend of backends) {
  it.skipIf(!backend.available)(`QA2: 200-task default sample fills a sparse group's shortfall (${backend.name})`, async () => {
    const opened = await backend.open();
    try {
      seedGroups(opened.db);
      // chat 14, task 100, issue_without_archive 100, issue_with_archive 100.
      addCandidates(opened.db, "tsk_more_one", 90);
      addCandidates(opened.db, "tsk_more_no_archive", 85, { issueId: "iss_r1" });
      addCandidates(opened.db, "tsk_more_archive", 96, { issueId: "iss_arch" });
      const assignment = assignTraceBackfillSubjects(opened.db, { oldTableStoppedAt: CUTOFF });
      const draw = (seed: string) =>
        selectTraceReconcileSample(assignment, { quotas: TRACE_RECONCILE_SAMPLE_QUOTAS, seed });
      const sample = draw(TRACE_RECONCILE_SAMPLE_SEED);

      expect(sample.taskIds.size).toBe(200);
      expect(sample).toMatchObject({ requested: 200, refilled: 36, note: null });
      // chat's 36 short go to the other three, one at a time in group order: 12 each.
      expect(Object.entries(sample.by_group).map(([group, counts]) =>
        [group, counts.quota, counts.candidates, counts.sampled, counts.refill])).toEqual([
        ["chat", 50, 14, 14, 0],
        ["task", 50, 100, 62, 12],
        ["issue_without_archive", 50, 100, 62, 12],
        ["issue_with_archive", 50, 100, 62, 12],
      ]);
      const inGroup = (group: string) => new Set(assignment.subjects.filter((subject) => subject.group === group)
        .flatMap((subject) => [...subject.renderTaskIds, ...subject.noneTaskIds]));
      for (const group of Object.keys(sample.by_group)) {
        const members = inGroup(group);
        expect([...sample.taskIds].filter((taskId) => members.has(taskId)).length).toBe(sample.by_group[group as keyof typeof sample.by_group].sampled);
      }

      // The same seed draws the same tasks in the same order; another seed draws others.
      expect([...draw(TRACE_RECONCILE_SAMPLE_SEED).taskIds]).toEqual([...sample.taskIds]);
      expect([...draw("another seed").taskIds].sort()).not.toEqual([...sample.taskIds].sort());
    } finally {
      await opened.close();
    }
  }, TIMEOUT);

  it.skipIf(!backend.available)(`QA3: a shortfall the other groups cannot split evenly goes one at a time in group order (${backend.name})`, async () => {
    const opened = await backend.open();
    try {
      seedGroups(opened.db);
      // chat 24, task 213, issue_without_archive 151, issue_with_archive 142.
      addCandidates(opened.db, "tsk_more_chat", 10, { chatSessionId: "chat_r1" });
      addCandidates(opened.db, "tsk_more_one", 203);
      addCandidates(opened.db, "tsk_more_no_archive", 136, { issueId: "iss_r2" });
      addCandidates(opened.db, "tsk_more_archive", 138, { issueId: "iss_arch" });
      const draw = () => selectTraceReconcileSample(assignTraceBackfillSubjects(opened.db, { oldTableStoppedAt: CUTOFF }),
        { quotas: TRACE_RECONCILE_SAMPLE_QUOTAS, seed: TRACE_RECONCILE_SAMPLE_SEED });
      const sample = draw();

      expect(sample.taskIds.size).toBe(200);
      expect(sample).toMatchObject({ requested: 200, refilled: 26, note: null });
      // chat's 26 short do not split by three: 9, 9, 8 in group order.
      expect(Object.entries(sample.by_group).map(([group, counts]) =>
        [group, counts.quota, counts.candidates, counts.sampled, counts.refill])).toEqual([
        ["chat", 50, 24, 24, 0],
        ["task", 50, 213, 59, 9],
        ["issue_without_archive", 50, 151, 59, 9],
        ["issue_with_archive", 50, 142, 58, 8],
      ]);

      // The same seed over the same data, read again, draws the same tasks in the same order.
      const again = draw();
      expect([...again.taskIds]).toEqual([...sample.taskIds]);
      expect(again.by_group).toEqual(sample.by_group);
    } finally {
      await opened.close();
    }
  }, TIMEOUT);
}

describe("read-only database handle", () => {
  it("refuses anything but a single SELECT before the backend sees it", () => {
    const raw = openSqliteDatabase(":memory:");
    raw.exec("CREATE TABLE t (x INTEGER)");
    const db = readOnlySqlDatabase(Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const }));
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
      expect(() => db.query("INSERT INTO t VALUES (1)")).toThrow("read-only");
      expect(() => db.query("SELECT 1; DELETE FROM t")).toThrow("read-only");
      expect(() => db.prepare("UPDATE t SET x = 1")).toThrow("read-only");
      expect(() => db.run("DELETE FROM t")).toThrow("read-only");
      expect(() => db.exec("DROP TABLE t")).toThrow("read-only");
      expect(() => db.transaction(() => 1)).toThrow("read-only");
    } finally {
      db.close();
    }
  });

  it("does not create a SQLite database that is not there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m432-ro-"));
    try {
      expect(() => openReadOnlyTraceDatabase({ sqlitePath: join(dir, "missing.db") })).toThrow();
      expect(existsSync(join(dir, "missing.db"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`reconcile CLI (${backend.name})`, () => {
    it("checks a seeded sample and the full set, writes nothing, and fails on a changed row", async () => {
      const root = await mkdtemp(join(tmpdir(), "m432-rc-"));
      const sqlitePath = join(root, "remi.db");
      let url: string | null = null;
      let close: () => Promise<void>;
      let writable: SqlDatabase;
      try {
        if (backend.name === "sqlite") {
          // A file the CLI process can open; the in-memory backend is invisible to it.
          const raw = openSqliteDatabase(sqlitePath);
          writable = Object.assign(raw as unknown as SqlDatabase, { dialect: "sqlite" as const });
          const store = new MultiremiStore(writable);
          store.ensureLocalWorkspace();
          seedGroups(writable);
          await backfill(store, writable, join(root, "archives"));
          close = async () => raw.close();
        } else {
          const opened = await backend.open();
          url = opened.url;
          writable = opened.db;
          seedGroups(writable);
          await backfill(opened.store, writable, join(root, "archives"));
          close = opened.close;
        }
        try {
          const env: Record<string, string> = url ? { MULTIREMI_DATABASE_URL: url } : {};
          const common = [`--archive-root=${join(root, "archives")}`, `--old-table-stopped-at=${CUTOFF}`];
          if (!url) common.push(`--sqlite-path=${sqlitePath}`);
          const before = url ? null : fileSha(sqlitePath);
          const archivesBefore = Number((writable.query("SELECT COUNT(*) AS n FROM multiremi_session_archives").get() as { n: unknown }).n);

          const out = join(root, "sample.json");
          const sample = runCli(env, ...common, "--sample-size=12", "--seed=m432", `--out=${out}`);
          expect(sample.stderr).not.toContain("error");
          expect(sample.exitCode).toBe(0);
          expect(sample.stdout).toMatchObject({
            dialect: backend.name,
            mode: "sample",
            ok: true,
            mismatch_total: 0,
            sample: { seed: "m432", requested: 12, tasks: 12 },
          });
          expect(Object.values(sample.stdout.sample.by_group).map((group: any) => group.sampled)).toEqual([3, 3, 3, 3]);
          expect(sample.stdout.checked_tasks + sample.stdout.checked_none).toBe(12);
          expect(Object.keys(sample.stdout.checked_by_group).sort()).toEqual([
            "chat", "issue_with_archive", "issue_without_archive", "task",
          ]);
          const written = JSON.parse(await readFile(out, "utf8"));
          expect(written.result.ok).toBe(true);
          expect(written.sample.seed).toBe("m432");

          const replay = runCli(env, ...common, "--sample-size=12", "--seed=m432");
          expect(replay.stdout.checked_by_group).toEqual(sample.stdout.checked_by_group);
          expect(replay.stdout.checked_rows).toBe(sample.stdout.checked_rows);

          // No size and no seed: the quotas and seed fixed in code, recorded in the report.
          const byDefault = runCli(env, ...common);
          expect(byDefault.exitCode).toBe(0);
          expect(byDefault.stdout.sample).toMatchObject({
            seed: TRACE_RECONCILE_SAMPLE_SEED, requested: 200, tasks: 43, refilled: 0,
            note: "all 43 candidates taken: the groups hold fewer than the 200 requested",
          });
          expect(Object.values(byDefault.stdout.sample.by_group).map((group: any) => [group.quota, group.sampled]))
            .toEqual([[50, 14], [50, 10], [50, 15], [50, 4]]);

          const full = runCli(env, ...common, "--mode=full");
          expect(full.exitCode).toBe(0);
          expect(full.stdout).toMatchObject({
            mode: "full", ok: true, checked_subjects: 16, checked_tasks: 39, checked_none: 4, sample: null,
          });

          const chatOnly = runCli(env, ...common, "--mode=full", "--groups=chat");
          expect(chatOnly.stdout).toMatchObject({ ok: true, checked_subjects: 2, checked_tasks: 12, checked_none: 2 });

          if (before) expect(fileSha(sqlitePath)).toBe(before);
          expect(Number((writable.query("SELECT COUNT(*) AS n FROM multiremi_session_archives").get() as { n: unknown }).n))
            .toBe(archivesBefore);

          writable.run(
            "UPDATE multiremi_task_messages SET content = ? WHERE task_id = ? AND seq = ?",
            "changed", "tsk_iss_r2_3", 3,
          );
          const changed = runCli(env, ...common, "--mode=full");
          expect(changed.exitCode).toBe(3);
          expect(changed.stdout.ok).toBe(false);
          expect(changed.stdout.mismatches).toMatchObject({ line_digest: 1, seq_set: 0 });
          expect(changed.stdout.mismatch_samples).toContainEqual(expect.objectContaining({
            category: "line_digest", task_id: "tsk_iss_r2_3", first_seq: 3,
          }));

          const badGroup = runCli(env, ...common, "--groups=nope");
          expect(badGroup.exitCode).not.toBe(0);
          expect(badGroup.stderr).toContain("unknown group");
        } finally {
          await close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  });
}
