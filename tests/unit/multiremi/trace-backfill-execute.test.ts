/**
 * MUL-432 items 1–7: the `multiremi_task_messages` → trace archive backfill,
 * planned, executed and reconciled on SQLite and Postgres with real archive
 * files, then read back through the B5 trace reader.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SESSION_ARCHIVE_FORMAT_V2 } from "@multiremi/contracts/session-archive.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { TraceReader } from "@multiremi/trace/trace-reader.js";
import { TRACE_TRUNCATION_MARKER } from "@shared/trace-sanitize.js";
import {
  runTraceBackfill,
  TraceBackfillSourceChangedError,
  type TraceBackfillRunOptions,
} from "../../../scripts/backfill-task-traces.js";
import {
  buildTraceBackfillPlan,
  canonicalJson,
  classifyNonRoundtrip,
  TRACE_BACKFILL_GROUPS,
  TraceBackfillStopError,
  traceEventDigest,
} from "../../../scripts/lib/task-trace-backfill.js";
import { reconcileTraceBackfill } from "../../../scripts/lib/task-trace-reconcile.js";
import {
  insertSyntheticAgent,
  insertSyntheticChat,
  insertSyntheticIssue,
  insertSyntheticMessages,
  insertSyntheticRuntime,
  insertSyntheticTask,
  truncatedJsonText,
  type SyntheticMessage,
} from "./trace-backfill-fixtures.js";
import { buildArchiveFixture, traceFileBody } from "./session-archive-fixtures.js";
import { traceBackfillBackends, type OpenedStore, type StoreBackend } from "./trace-backfill-backends.js";

const TIMEOUT = 120_000;
const T0 = "2026-08-01T00:00:00.000Z";
const ENDED = "2026-08-10T00:00:00.000Z";
const CUTOFF = "2026-09-01T00:00:00.000Z";
const AFTER_CUTOFF = "2026-09-02T00:00:00.000Z";
const AGENT = "agt_bf";
const RUNTIME = "rt_bf";
const DAEMON = "dmn_bf";
const BIG_CONTENT = `${"large content ".repeat(22_000)}tail`;
const BIG_TRUNCATED_INPUT = truncatedJsonText(256 * 1024 + 64, "i");

const backends = await traceBackfillBackends("execute");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function at(second: number): string {
  return new Date(Date.parse(T0) + second * 1000).toISOString();
}

function rows(seqs: number[], extra: (seq: number) => Partial<SyntheticMessage> = () => ({})): SyntheticMessage[] {
  return seqs.map((seq) => ({ seq, type: "text", content: `event ${seq}`, created_at: at(seq), ...extra(seq) }));
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function count(db: SqlDatabase, table: string, where = "1 = 1", ...params: unknown[]): number {
  return Number((db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: unknown }).n);
}

/** Every column of the old table, in key order: the backfill must leave it byte-identical. */
function oldTableDigest(db: SqlDatabase): string {
  const all = db.query(
    `SELECT id, task_id, seq, type, tool, content, input, output, tool_call_id, status, meta, created_at
     FROM multiremi_task_messages ORDER BY task_id, seq`,
  ).all();
  return createHash("sha256").update(JSON.stringify(all)).digest("hex");
}

function insertPointer(
  db: SqlDatabase,
  input: { taskId: string; location: string; archiveId?: string; eventCount?: number | null; headSeq?: number | null },
): void {
  db.run(
    `INSERT INTO multiremi_task_traces (task_id, location, runtime_id, archive_id, member_path, event_count, head_seq, closed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.taskId,
    input.location,
    input.location === "daemon" ? RUNTIME : null,
    input.archiveId ?? null,
    input.archiveId ? `traces/${input.taskId}.jsonl` : null,
    input.eventCount ?? null,
    input.headSeq ?? null,
    input.archiveId ? 1 : null,
    T0,
  );
}

/**
 * The daemon archive that already owns `tsk_old_a` (head 1) and `tsk_old_b`
 * (head 9). Its bytes are real and every world writes them at the row's path:
 * reconcile reads a daemon-owned pointer the way the trace API does (MUL-432
 * QA round 2, M1).
 */
const DAEMON_OLD = await buildArchiveFixture({
  subject: { kind: "issue", id: "iss_old" },
  traces: {
    tsk_old_a: traceFileBody({ events: 1, taskId: "tsk_old_a" }),
    tsk_old_b: traceFileBody({ events: 9, taskId: "tsk_old_b" }),
  },
});
const DAEMON_OLD_PATH = "workspaces/x/sar_daemon_old/sessions.zip";

/** A pointer at a member of `DAEMON_OLD`, carrying its index entry as ingest writes it. */
function insertDaemonOldPointer(db: SqlDatabase, taskId: string): void {
  const entry = DAEMON_OLD.index.members.find((member) => member.task_id === taskId)!;
  db.run(
    `INSERT INTO multiremi_task_traces (task_id, location, runtime_id, archive_id, member_path, data_offset,
       compressed_size, uncompressed_size, sha256, event_count, head_seq, closed, updated_at)
     VALUES (?, 'archive', ?, 'sar_daemon_old', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    taskId, RUNTIME, entry.path, entry.data_offset, entry.compressed_size, entry.uncompressed_size, entry.sha256,
    entry.event_count ?? null, entry.head ?? 0, entry.closed ? 1 : 0, T0,
  );
}

/** A daemon-uploaded archive row. Only `sar_daemon_old` has bytes on disk. */
function insertDaemonArchive(
  db: SqlDatabase,
  input: { id: string; kind: "issue" | "chat"; subjectId: string; traceTaskIds: string[] },
): void {
  db.run(
    `INSERT INTO multiremi_session_archives (
       id, workspace_id, issue_id, subject_kind, subject_id, format, runtime_id, daemon_id,
       source_revision, sha256, size_bytes, uploaded_size_bytes, file_count, status, relative_path,
       metadata, attempt_count, created_at, updated_at, completed_at
     ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'ready', ?, ?, 1, ?, ?, ?)`,
    input.id,
    input.kind === "issue" ? input.subjectId : null,
    input.kind,
    input.subjectId,
    SESSION_ARCHIVE_FORMAT_V2,
    RUNTIME,
    DAEMON,
    `rev_${input.id}`,
    "0".repeat(64),
    input.traceTaskIds.length,
    `workspaces/x/${input.id}/sessions.zip`,
    JSON.stringify({
      format: SESSION_ARCHIVE_FORMAT_V2,
      subject: { kind: input.kind, id: input.subjectId },
      files: input.traceTaskIds.map((taskId) => ({ path: `traces/${taskId}.jsonl`, size: 1, sha256: "0".repeat(64) })),
    }),
    T0,
    T0,
    T0,
  );
}

function seedBase(db: SqlDatabase): void {
  insertSyntheticAgent(db, { id: AGENT, provider: "claude", createdAt: T0 });
  insertSyntheticRuntime(db, { id: RUNTIME, provider: "codex", daemonId: DAEMON, createdAt: T0 });
}

function task(id: string, extra: Partial<Parameters<typeof insertSyntheticTask>[1]> = {}) {
  return {
    id,
    agentId: AGENT,
    runtimeId: RUNTIME,
    status: "completed",
    createdAt: T0,
    startedAt: at(1),
    endedAt: ENDED,
    ...extra,
  };
}

/**
 * All four subject kinds and the edges the plan has to classify: sparse seq,
 * a content row larger than the live writer would keep, a truncated input, a
 * NUL escape in meta, a task with no rows, a running task, a deleting Issue, a
 * Chat that no longer exists, a `lost` pointer and two tasks a daemon archive
 * already owns: the cross-switch tasks `WORLD_CROSS_SWITCH` acknowledges.
 */
function seedWorld(db: SqlDatabase): void {
  seedBase(db);
  insertSyntheticChat(db, { id: "chat_bf", agentId: AGENT, createdAt: T0 });
  insertSyntheticIssue(db, { id: "iss_new", number: 1, createdAt: T0 });
  insertSyntheticIssue(db, { id: "iss_old", number: 2, createdAt: T0 });
  insertSyntheticIssue(db, { id: "iss_gone", number: 3, createdAt: T0, lifecycleState: "deleting" });

  insertSyntheticTask(db, task("tsk_chat_a", { chatSessionId: "chat_bf" }));
  insertSyntheticMessages(db, "tsk_chat_a", rows([1, 2, 5]));
  insertSyntheticTask(db, task("tsk_chat_b", { chatSessionId: "chat_bf" }));

  insertSyntheticTask(db, task("tsk_one", { runtimeId: null, status: "failed", provider: "claude" }));
  insertSyntheticMessages(db, "tsk_one", rows([1, 2, 3], (seq) => (seq === 2 ? { content: BIG_CONTENT } : {})));
  insertSyntheticTask(db, task("tsk_orphan_chat", { chatSessionId: "chat_missing", status: "cancelled" }));
  insertSyntheticMessages(db, "tsk_orphan_chat", rows([2, 4]));

  insertSyntheticTask(db, task("tsk_issue_a", { issueId: "iss_new", issueSessionId: "ises_a" }));
  insertSyntheticMessages(db, "tsk_issue_a", [
    { seq: 1, type: "text", content: "hello", created_at: at(1) },
    {
      seq: 2, type: "tool_use", tool: "Bash", tool_call_id: "call_1", input: BIG_TRUNCATED_INPUT, created_at: at(2),
    },
    {
      seq: 3, type: "tool_result", tool: "Bash", tool_call_id: "call_1", output: "ok", status: "completed",
      created_at: at(3),
    },
    { seq: 4, type: "execution", meta: "{\"model\":\"m1\",\"note\":\"a\\u0000b\"}", created_at: at(4) },
  ]);
  insertSyntheticTask(db, task("tsk_issue_b", { issueId: "iss_new", issueSessionId: "ises_b", status: "cancelled" }));
  insertSyntheticMessages(db, "tsk_issue_b", rows([1]));
  insertPointer(db, { taskId: "tsk_issue_b", location: "lost" });
  insertSyntheticTask(db, task("tsk_issue_run", { issueId: "iss_new", status: "running", endedAt: null }));
  insertSyntheticMessages(db, "tsk_issue_run", rows([1]));
  insertSyntheticTask(db, task("tsk_issue_none", { issueId: "iss_new" }));

  insertDaemonArchive(db, { id: "sar_daemon_old", kind: "issue", subjectId: "iss_old", traceTaskIds: ["tsk_old_a", "tsk_old_b"] });
  insertSyntheticTask(db, task("tsk_old_a", { issueId: "iss_old" }));
  insertSyntheticMessages(db, "tsk_old_a", rows([1, 2]));
  insertDaemonOldPointer(db, "tsk_old_a");
  insertSyntheticTask(db, task("tsk_old_b", { issueId: "iss_old" }));
  insertSyntheticMessages(db, "tsk_old_b", rows([1, 2]));
  insertDaemonOldPointer(db, "tsk_old_b");

  insertSyntheticTask(db, task("tsk_gone", { issueId: "iss_gone" }));
  insertSyntheticMessages(db, "tsk_gone", rows([1]));
}

/** `tsk_old_a` and `tsk_old_b`, whose pointers are at a daemon archive. */
const WORLD_CROSS_SWITCH = 2;

interface World {
  opened: OpenedStore;
  db: SqlDatabase;
  root: string;
  service: SessionArchiveService;
  logs: string[];
  run(overrides?: Partial<TraceBackfillRunOptions>): ReturnType<typeof runTraceBackfill>;
}

async function withWorld(
  backend: StoreBackend,
  seed: (db: SqlDatabase) => void,
  body: (world: World) => Promise<void>,
  defaults: Partial<TraceBackfillRunOptions> = seed === seedWorld ? { crossSwitchAck: WORLD_CROSS_SWITCH } : {},
) {
  const opened = await backend.open();
  const root = await mkdtemp(join(tmpdir(), "m432-bf-"));
  try {
    seed(opened.db);
    if (count(opened.db, "multiremi_session_archives", "id = ?", "sar_daemon_old")) {
      await mkdir(dirname(join(root, DAEMON_OLD_PATH)), { recursive: true });
      await writeFile(join(root, DAEMON_OLD_PATH), DAEMON_OLD.bytes);
    }
    const service = new SessionArchiveService(opened.store, { root, minFreeBytes: 0 });
    const logs: string[] = [];
    const world: World = {
      opened,
      db: opened.db,
      root,
      service,
      logs,
      run: (overrides = {}) => runTraceBackfill({
        db: opened.db,
        execute: true,
        oldTableStoppedAt: CUTOFF,
        store: opened.store,
        service,
        log: (line) => logs.push(line),
        ...defaults,
        ...overrides,
      }),
    };
    await body(world);
  } finally {
    await opened.close();
    await rm(root, { recursive: true, force: true });
  }
}

function traceReader(world: World): TraceReader {
  return new TraceReader({
    store: world.opened.store,
    daemon: new InMemoryDaemonTraceReader(() => null),
    archive: new SessionArchiveReader({ store: world.opened.store, root: world.root }),
  });
}

/** The event lines of a task's member, parsed, straight from the zip. */
async function memberEvents(world: World, taskId: string): Promise<Array<Record<string, unknown>>> {
  const pointer = world.opened.store.getTaskTrace(taskId)!;
  expect(pointer.location).toBe("archive");
  const reader = new SessionArchiveReader({ store: world.opened.store, root: world.root });
  const member = await reader.readArchiveMember(pointer.archiveId!, {
    dataOffset: pointer.dataOffset!,
    compressedSize: pointer.compressedSize!,
    uncompressedSize: pointer.uncompressedSize ?? undefined,
    sha256: pointer.sha256 ?? undefined,
  });
  const lines = member.bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return lines.slice(1, -1);
}

function backfillArchives(world: World, kind: "issue" | "chat" | "task", id: string) {
  return world.opened.store.listSessionArchivesForSubject(kind, id)
    .filter((archive) => archive.metadata.kind === "trace_backfill");
}

async function listDir(path: string): Promise<string[]> {
  return existsSync(path) ? (await readdir(path)).sort() : [];
}

describe("trace backfill JSON helpers", () => {
  it("classifies why a stored JSON column does not round-trip", () => {
    const classify = (text: string) => classifyNonRoundtrip(text, JSON.parse(text));
    expect(classify("{ \"a\": 1 }")).toBe("whitespace");
    expect(classify("{\"b\":\"\\u0041\"}")).toBe("escape");
    expect(classify("{\"b\":\"\\/\"}")).toBe("escape");
    expect(classify("{\"b\":1,\"1\":2}")).toBe("key_order");
    expect(classify("{\"n\":1.0}")).toBe("number_literal");
    expect(classify("{\"n\":1e5}")).toBe("number_literal");
    expect(classify("{\"n\":-0}")).toBe("number_literal");
    expect(classify("{\"n\":12345678901234567890}")).toBe("number_literal");
    expect(classify("{\"a\":1,\"a\":2}")).toBe("duplicate_key");
  });

  it("digests input and meta as canonical JSON and every other field exactly", () => {
    const base = {
      seq: 1, ts: T0, type: "tool_use", tool: "Bash", content: null, output: null, tool_call_id: "c", status: null,
      input: { b: 1, a: [1, { d: 2, c: 3 }] }, meta: null,
    };
    expect(traceEventDigest(base)).toBe(traceEventDigest({ ...base, input: { a: [1, { c: 3, d: 2 }], b: 1 } }));
    expect(traceEventDigest(base)).not.toBe(traceEventDigest({ ...base, meta: "null" }));
    expect(traceEventDigest(base)).not.toBe(traceEventDigest({ ...base, tool: "Bash " }));
    expect(traceEventDigest(base)).not.toBe(traceEventDigest({ ...base, content: "" }));
    expect(canonicalJson(JSON.parse("{\"__proto__\":1,\"a\":2}"))).toBe("{\"__proto__\":1,\"a\":2}");
  });
});

describe("backfill CLI guards", () => {
  const script = join(import.meta.dir, "../../../scripts/backfill-task-traces.ts");
  const spawn = (...args: string[]) => Bun.spawnSync(["bun", script, ...args], {
    env: { ...process.env, HOME: join(tmpdir(), "m432-cli-guard-home"), MULTIREMI_DATABASE_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  it("refuses to execute without the confirmation or the stop moment, before opening a database", () => {
    const unconfirmed = spawn("--execute");
    expect(unconfirmed.exitCode).not.toBe(0);
    expect(unconfirmed.stderr.toString()).toContain("--execute --confirm=MUL-402");
    const noCutoff = spawn("--execute", "--confirm=MUL-402");
    expect(noCutoff.exitCode).not.toBe(0);
    expect(noCutoff.stderr.toString()).toContain("--old-table-stopped-at");
    expect(existsSync(join(tmpdir(), "m432-cli-guard-home", ".remi"))).toBe(false);
  }, TIMEOUT);
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`trace backfill execution (${backend.name})`, () => {
    it("dry-runs every group, counts what it would write and writes nothing", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        const before = oldTableDigest(world.db);
        const archivesBefore = count(world.db, "multiremi_session_archives");
        const report = await runTraceBackfill({ db: world.db, execute: false, oldTableStoppedAt: CUTOFF, log: () => {} });
        expect(report.mode).toBe("dry-run");
        expect(report.execution).toBeNull();
        const plan = report.plan;
        // The only stop is the one an operator acknowledges with --cross-switch-ack.
        expect(plan.stops).toEqual([expect.objectContaining({
          code: "cross_switch_tasks", count: 2, samples: ["tsk_old_a", "tsk_old_b"],
        })]);
        expect(plan.cross_switch).toEqual({
          cutoff_evaluated: true,
          count: 2,
          by_reason: { ended_at_or_after_cutoff: 0, ended_at_unknown: 0, daemon_archive_pointer: 2 },
          task_ids: ["tsk_old_a", "tsk_old_b"],
          ack: null,
        });
        expect(plan.groups.chat).toMatchObject({ subjects: 1, traced_tasks: 1, rows: 3, none_tasks: 1 });
        expect(plan.groups.task).toMatchObject({ subjects: 2, traced_tasks: 2, rows: 5, none_tasks: 0 });
        expect(plan.groups.issue_without_archive).toMatchObject({ subjects: 1, traced_tasks: 2, rows: 5, none_tasks: 1 });
        expect(plan.groups.issue_with_archive).toMatchObject({ subjects: 1, traced_tasks: 2, rows: 4, none_tasks: 0 });
        expect(plan.source).toMatchObject({
          nonterminal_tasks_with_rows: 1,
          nonterminal_rows: 1,
          skipped: { issue_missing: { tasks: 0, rows: 0 }, issue_deleting: { tasks: 1, rows: 1 } },
          chat_missing_as_task: 1,
          tasks_with_existing_archive_pointer: 2,
          tasks_with_lost_pointer: 1,
        });
        expect(plan.none).toMatchObject({
          cutoff_evaluated: true, eligible: 2, eligible_by_kind: { issue: 1, chat: 1, task: 0 },
        });
        expect(plan.archive_runtime_missing).toBe(1);
        expect(plan.header.provider_from).toMatchObject({ runtime: 6, task: 1 });
        expect(plan.json).toMatchObject({
          json_unparseable_input: 1,
          sql_truncated_input: 1,
          json_unparseable_meta: 0,
          sql_truncated_meta: 0,
          json_unparseable_unexplained: 0,
          json_nonroundtrip: 0,
        });
        expect(plan.json.meta.nul_escape_rows).toBe(1);
        expect(plan.json.samples.meta_nul_escape).toEqual([
          expect.objectContaining({ task_id: "tsk_issue_a", seq: 4 }),
        ]);

        expect(oldTableDigest(world.db)).toBe(before);
        expect(count(world.db, "multiremi_session_archives")).toBe(archivesBefore);
        expect(count(world.db, "multiremi_trace_backfill_progress")).toBe(0);
        // Nothing but the daemon archive the world started with.
        expect(await listDir(world.root)).toEqual(["workspaces"]);
        expect(await listDir(join(world.root, "workspaces"))).toEqual(["x"]);
      });
    }, TIMEOUT);

    it("executes chat, one-shot, Issue groups in order and reads every trace back from its archive", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        const before = oldTableDigest(world.db);
        const staged: string[] = [];
        const report = await world.run({
          hooks: { afterStage: (subject) => { staged.push(`${subject.kind}:${subject.id}`); } },
        });
        expect(staged).toEqual(["chat:chat_bf", "task:tsk_one", "task:tsk_orphan_chat", "issue:iss_new", "issue:iss_old"]);
        expect(world.logs.filter((line) => line.startsWith("execute:")).map((line) => line.split(":")[1]!.trim()))
          .toEqual([...TRACE_BACKFILL_GROUPS]);
        expect(report.execution!.chat).toMatchObject({
          subjects: 1, written: 1, archives_created: 1, pointers: 1, none_pointers: 1,
        });
        expect(report.execution!.task).toMatchObject({ subjects: 2, written: 2, archives_created: 2, pointers: 2 });
        // tsk_issue_b keeps its `lost` pointer: the swap rule never moves one.
        expect(report.execution!.issue_without_archive).toMatchObject({
          subjects: 1, written: 1, archives_created: 1, pointers: 1, none_pointers: 1,
        });
        // tsk_old_a and tsk_old_b stay on the daemon archive whatever the heads (1 and 9
        // against 2): a backfill member never replaces a daemon archive. Their members
        // are still written, as a prefix backup, and their cards are left alone.
        expect(report.execution!.issue_with_archive).toMatchObject({
          subjects: 1, archives_created: 1, pointers: 0, pointers_kept: { daemon_owned: 2 },
          turn_cards_skipped_cross_switch: 2,
        });
        expect(world.logs).toContain("pointer kept: tsk_old_a stays on archive/daemon sar_daemon_old (daemon_owned)");
        for (const group of TRACE_BACKFILL_GROUPS) {
          expect(report.reconcile[group]).toMatchObject({ ok: true, mismatch_total: 0 });
        }
        expect(report.reconcile.issue_without_archive!.informational.pointer_kept_lost).toBe(1);
        expect(report.reconcile.issue_with_archive!.informational).toMatchObject({
          cross_switch_daemon_owned: 2, turn_card_skipped_cross_switch: 2,
        });

        const { store } = world.opened;
        const [chatArchive] = backfillArchives(world, "chat", "chat_bf");
        expect(chatArchive).toMatchObject({
          status: "ready", subjectKind: "chat", subjectId: "chat_bf", runtimeId: RUNTIME, daemonId: DAEMON,
          metadata: expect.objectContaining({ kind: "trace_backfill", task_count: 1, none_count: 1, row_count: 3 }),
        });
        expect(backfillArchives(world, "task", "tsk_one")[0]).toMatchObject({ runtimeId: "", daemonId: "" });
        const archiveDir = dirname(join(world.root, chatArchive!.relativePath));
        expect(await listDir(archiveDir)).toEqual(["manifest.json", "sessions.zip"]);
        expect(await listDir(join(world.root, ".trace-backfill-staging"))).toEqual([]);

        expect(store.getTaskTrace("tsk_chat_a")).toMatchObject({
          location: "archive", archiveId: chatArchive!.id, headSeq: 5, eventCount: 3, closed: true,
        });
        expect(store.getTaskTrace("tsk_chat_b")).toMatchObject({ location: "none" });
        expect(store.getTaskTrace("tsk_issue_none")).toMatchObject({ location: "none" });
        expect(store.getTaskTrace("tsk_issue_b")).toMatchObject({ location: "lost" });
        expect(store.getTaskTrace("tsk_old_a")).toMatchObject({ location: "archive", archiveId: "sar_daemon_old", headSeq: 1 });
        expect(store.getTaskTrace("tsk_old_b")).toMatchObject({ location: "archive", archiveId: "sar_daemon_old", headSeq: 9 });
        expect(store.listTraceBackfillTasks("issue", "iss_old").map((row) => [row.taskId, row.crossSwitch])).toEqual([
          ["tsk_old_a", true], ["tsk_old_b", true],
        ]);
        expect(store.getTaskTrace("tsk_issue_run")).toBeNull();
        expect(store.getTaskTrace("tsk_gone")).toBeNull();

        const reader = traceReader(world);
        const chat = await reader.readTrace("tsk_chat_a");
        expect(chat).toMatchObject({ state: "ok", source: "archive", head: 5, closed: true, eof: true });
        expect(chat.events.map((event) => event.seq)).toEqual([1, 2, 5]);
        const issue = await reader.readTrace("tsk_issue_a");
        expect(issue.events.map((event) => [event.seq, event.type])).toEqual([
          [1, "text"], [2, "tool_use"], [3, "tool_result"], [4, "execution"],
        ]);
        expect(issue.events[1]!.input).toBeNull();
        expect(issue.events[3]!.meta).toEqual({ model: "m1", note: "a\u0000b" });
        expect(await reader.readTrace("tsk_chat_b")).toMatchObject({ state: "not_found", events: [] });

        // The stored row is copied as it is, not re-sanitized: the big content survives whole.
        const one = await memberEvents(world, "tsk_one");
        expect(one[1]!.content).toBe(BIG_CONTENT);
        expect(Object.keys(one[0]!)).toEqual([
          "ts", "type", "tool", "content", "input", "output", "tool_call_id", "status", "meta", "seq",
        ]);
        expect(one.map((event) => event.ts)).toEqual([at(1), at(2), at(3)]);

        const progress = store.listTraceBackfillProgress();
        expect(progress).toHaveLength(5);
        expect(progress.every((entry) => entry.status === "done" && entry.archiveId)).toBe(true);
        expect(oldTableDigest(world.db)).toBe(before);

        const full = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(full).toMatchObject({ mode: "full", ok: true, checked_tasks: 7, checked_rows: 17, checked_none: 2 });
      });
    }, TIMEOUT);

    it("skips subjects that are done with the same digest", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        await world.run();
        const archives = count(world.db, "multiremi_session_archives");
        const again = await world.run();
        for (const group of TRACE_BACKFILL_GROUPS) {
          const result = again.execution![group];
          expect(result.skipped_done).toBe(result.subjects);
          expect(result.archives_created + result.archives_reused).toBe(0);
        }
        expect(count(world.db, "multiremi_session_archives")).toBe(archives);
      });
    }, TIMEOUT);

    it("cleans an interrupted subject and redoes it on the next run", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        const subjectDir = join(world.root, "workspaces", b64("local"), "issues", b64("iss_new"));
        let crash = true;
        await expect(world.run({
          hooks: {
            afterStage: async (subject) => {
              if (!crash || subject.id !== "iss_new") return;
              crash = false;
              // What a run killed after moving its zip but before committing leaves behind.
              await mkdir(join(subjectDir, "sar_orphan"), { recursive: true });
              await writeFile(join(subjectDir, "sar_orphan", "sessions.zip"), "partial");
              await writeFile(join(subjectDir, "sar_orphan", ".trace-backfill-pending"), "{}\n");
              // A directory without the marker is not the backfill's to remove.
              await mkdir(join(subjectDir, "sar_foreign"), { recursive: true });
              throw new Error("simulated crash");
            },
          },
        })).rejects.toThrow("simulated crash");
        const { store } = world.opened;
        expect(store.getTraceBackfillProgress("chat", "chat_bf")).toMatchObject({ status: "done" });
        expect(store.getTraceBackfillProgress("issue", "iss_new")).toMatchObject({ status: "running", archiveId: null });
        expect(store.getTraceBackfillProgress("issue", "iss_old")).toBeNull();
        expect(backfillArchives(world, "issue", "iss_new")).toEqual([]);
        expect(store.getTaskTrace("tsk_issue_a")).toBeNull();
        // A killed process also leaves its staging directory.
        const leftover = join(world.root, ".trace-backfill-staging", `issue-${b64("iss_new")}`);
        await mkdir(join(leftover, "runtime"), { recursive: true });

        const rerun = await world.run();
        expect(rerun.execution!.chat.skipped_done).toBe(1);
        expect(rerun.execution!.task.skipped_done).toBe(2);
        expect(rerun.execution!.issue_without_archive).toMatchObject({
          resumed_interrupted: 1, orphan_archive_dirs_removed: 1, archives_created: 1, written: 1,
        });
        expect(rerun.execution!.issue_with_archive).toMatchObject({ archives_created: 1 });
        expect(existsSync(join(subjectDir, "sar_orphan"))).toBe(false);
        expect(existsSync(join(subjectDir, "sar_foreign"))).toBe(true);
        expect(existsSync(leftover)).toBe(false);
        expect(store.getTraceBackfillProgress("issue", "iss_new")).toMatchObject({ status: "done" });
        expect(store.getTaskTrace("tsk_issue_a")).toMatchObject({ location: "archive", headSeq: 4 });
        const full = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(full.ok).toBe(true);
      });
    }, TIMEOUT);

    it("stops a subject whose rows changed after planning and resumes it on the next run", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        await expect(world.run({
          hooks: {
            afterStage: (subject) => {
              if (subject.id === "chat_bf") insertSyntheticMessages(world.db, "tsk_one", rows([9]));
            },
          },
        })).rejects.toBeInstanceOf(TraceBackfillSourceChangedError);
        expect(world.opened.store.getTraceBackfillProgress("task", "tsk_one")).toMatchObject({ status: "running" });
        expect(backfillArchives(world, "task", "tsk_one")).toEqual([]);
        const rerun = await world.run();
        expect(rerun.execution!.task).toMatchObject({ resumed_interrupted: 1, archives_created: 2 });
        expect(world.opened.store.getTaskTrace("tsk_one")).toMatchObject({ headSeq: 9, eventCount: 4 });
      });
    }, TIMEOUT);

    it("redoes a subject whose digest changed: a new ready row, pointers moved, the old row kept", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        await world.run();
        const { store } = world.opened;
        const first = store.getTaskTrace("tsk_issue_a")!;
        insertSyntheticMessages(world.db, "tsk_issue_a", rows([7]));

        const redo = await world.run();
        expect(redo.execution!.issue_without_archive).toMatchObject({
          redone_digest_changed: 1, archives_created: 1, pointers: 1,
        });
        expect(redo.execution!.chat.skipped_done).toBe(1);
        expect(redo.execution!.issue_with_archive.skipped_done).toBe(1);
        const second = store.getTaskTrace("tsk_issue_a")!;
        expect(second.archiveId).not.toBe(first.archiveId);
        expect(second).toMatchObject({ location: "archive", headSeq: 7, eventCount: 5 });
        expect(store.getSessionArchive(first.archiveId!)).toMatchObject({ status: "ready" });
        expect(backfillArchives(world, "issue", "iss_new")).toHaveLength(2);
        expect(store.getTraceBackfillProgress("issue", "iss_new")).toMatchObject({
          status: "done", archiveId: second.archiveId,
        });
        const events = (await traceReader(world).readTrace("tsk_issue_a")).events;
        expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 7]);
        const full = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(full.ok).toBe(true);
      });
    }, TIMEOUT);

    it("renders the same files with tiny keyset batches and byte-bounded sub-ranges", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        const digests = (options: { batchRows?: number; chunkBytes?: number }) =>
          buildTraceBackfillPlan(world.db, { oldTableStoppedAt: CUTOFF, ...options }).subjects
            .map((subject) => `${subject.kind}:${subject.id}:${subject.digest}:${subject.bytes}`);
        expect(digests({ batchRows: 1, chunkBytes: 1 })).toEqual(digests({}));
        expect(digests({ batchRows: 2, chunkBytes: 512 })).toEqual(digests({}));
        const report = await world.run({ batchRows: 2, chunkBytes: 512 });
        expect(report.reconcile.issue_without_archive!.ok).toBe(true);
      });
    }, TIMEOUT);

    it("finds what was changed behind its back", async () => {
      await withWorld(backend, seedWorld, async (world) => {
        await world.run();
        world.db.run("UPDATE multiremi_task_messages SET content = ? WHERE task_id = ? AND seq = ?", "edited", "tsk_chat_a", 2);
        world.db.run("DELETE FROM multiremi_task_messages WHERE task_id = ? AND seq = ?", "tsk_old_a", 2);
        world.db.run("DELETE FROM multiremi_task_messages WHERE task_id = ? AND seq = ?", "tsk_one", 3);
        world.db.run("UPDATE multiremi_task_traces SET location = 'daemon' WHERE task_id = ?", "tsk_issue_none");
        const report = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(report.ok).toBe(false);
        // Each deleted row moves its task's head and count, so the trailer and index entry
        // disagree too: tsk_old_a's backfill member is checked although the daemon owns the
        // task, and tsk_one's pointer disagrees as well. Three subjects' task and subject
        // digests are stale.
        expect(report.mismatches).toEqual({
          seq_set: 2,
          line_digest: 1,
          event_count: 2,
          header: 0,
          trailer: 2,
          index: 2,
          pointer: 2,
          pointer_owned_by_daemon_unexpected: 0,
          active_pointer: 0,
          active_member_unreadable: 0,
          member_missing: 0,
          member_unreadable: 0,
          archive_missing: 0,
          progress: 6,
          turn_card: 1,
        });
        expect(report.samples.mismatch).toContainEqual(expect.objectContaining({
          category: "line_digest", task_id: "tsk_chat_a", first_seq: 2,
        }));
        expect(report.samples.mismatch).toContainEqual(expect.objectContaining({
          category: "pointer", task_id: "tsk_issue_none", expected: "none", actual: "daemon",
        }));
        expect(report.samples.mismatch).toContainEqual(expect.objectContaining({
          category: "pointer", task_id: "tsk_one", reason: "pointer disagrees with the index entry",
        }));
        // One-shot attempts now carry the summary too. Deleting its source row
        // must report the stale card as well as the original archive mismatches.
        expect(report.samples.mismatch).toContainEqual(expect.objectContaining({
          category: "turn_card", task_id: "tsk_one", fields: ["event_count", "type_histogram"],
          expected: expect.objectContaining({ event_count: 2, type_histogram: [{ type: "text", tool: null, count: 2 }] }),
          actual: expect.objectContaining({ event_count: 3, type_histogram: [{ type: "text", tool: null, count: 3 }] }),
        }));
      });
    }, TIMEOUT);

    it("writes `none` only for tasks that meet all five conditions", async () => {
      const seedNone = (db: SqlDatabase) => {
        seedBase(db);
        insertSyntheticChat(db, { id: "chat_none", agentId: AGENT, createdAt: T0 });
        const chat = (id: string, extra: Partial<Parameters<typeof insertSyntheticTask>[1]> = {}) =>
          insertSyntheticTask(db, task(id, { chatSessionId: "chat_none", ...extra }));
        chat("tsk_n_ok");
        chat("tsk_n_daemon");
        insertPointer(db, { taskId: "tsk_n_daemon", location: "daemon", eventCount: 0 });
        chat("tsk_n_null_count");
        insertPointer(db, { taskId: "tsk_n_null_count", location: "daemon", eventCount: null });
        chat("tsk_n_lost");
        insertPointer(db, { taskId: "tsk_n_lost", location: "lost" });
        chat("tsk_n_running", { status: "running", endedAt: null });
        chat("tsk_n_late", { endedAt: AFTER_CUTOFF });
        chat("tsk_n_bad_date", { endedAt: "not a date" });
        chat("tsk_n_member");
        insertDaemonArchive(db, { id: "sar_daemon_chat", kind: "chat", subjectId: "chat_none", traceTaskIds: ["tsk_n_member"] });
        chat("tsk_n_count");
        insertPointer(db, { taskId: "tsk_n_count", location: "daemon", eventCount: 3 });
        chat("tsk_n_rows");
        insertSyntheticMessages(db, "tsk_n_rows", rows([1]));
        insertSyntheticTask(db, task("tsk_solo"));
      };
      await withWorld(backend, seedNone, async (world) => {
        const unset = await runTraceBackfill({ db: world.db, execute: false, log: () => {} });
        expect(unset.plan.none).toMatchObject({ cutoff_evaluated: false, eligible: 0, eligible_ignoring_cutoff: 6 });
        await expect(world.run({ oldTableStoppedAt: null })).rejects.toThrow("old-table-stopped-at");

        const dry = await runTraceBackfill({ db: world.db, execute: false, oldTableStoppedAt: CUTOFF, log: () => {} });
        expect(dry.plan.none).toMatchObject({
          cutoff_evaluated: true,
          eligible: 5,
          eligible_by_kind: { issue: 0, chat: 4, task: 1 },
          eligible_by_pointer: { absent: 2, daemon: 2, lost: 1 },
          eligible_ignoring_cutoff: 6,
          ineligible: {
            nonterminal: 1, ended_after_cutoff: 1, ended_at_invalid: 1, archive_member: 1, positive_event_count: 1,
          },
        });

        const report = await world.run();
        expect(report.execution!.task).toMatchObject({ none_only: 1, none_pointers: 1, archives_created: 0 });
        expect(report.execution!.chat).toMatchObject({ archives_created: 1, pointers: 1, none_pointers: 4 });
        expect(report.reconcile.chat!.informational.none_kept_existing_location).toBe(1);
        const { store } = world.opened;
        const location = (taskId: string) => store.getTaskTrace(taskId)?.location ?? "absent";
        expect(Object.fromEntries([
          "tsk_n_ok", "tsk_n_daemon", "tsk_n_null_count", "tsk_n_lost", "tsk_n_running", "tsk_n_late",
          "tsk_n_bad_date", "tsk_n_member", "tsk_n_count", "tsk_n_rows", "tsk_solo",
        ].map((taskId) => [taskId, location(taskId)]))).toEqual({
          tsk_n_ok: "none",
          tsk_n_daemon: "none",
          tsk_n_null_count: "none",
          tsk_n_lost: "lost",
          tsk_n_running: "absent",
          tsk_n_late: "absent",
          tsk_n_bad_date: "absent",
          tsk_n_member: "absent",
          tsk_n_count: "daemon",
          tsk_n_rows: "archive",
          tsk_solo: "none",
        });
        expect(store.getTraceBackfillProgress("task", "tsk_solo")).toMatchObject({ status: "done", archiveId: null });
        expect(await traceReader(world).readTrace("tsk_n_ok")).toMatchObject({ state: "not_found", events: [] });
      });
    }, TIMEOUT);

    it("writes truncated JSON as null and counts it exactly as the SQL marker count", async () => {
      const seedJson = (db: SqlDatabase) => {
        seedBase(db);
        insertSyntheticTask(db, task("tsk_json"));
        insertSyntheticMessages(db, "tsk_json", [
          { seq: 1, type: "tool_use", tool: "Write", input: BIG_TRUNCATED_INPUT, created_at: at(1) },
          { seq: 2, type: "tool_use", tool: "Bash", input: truncatedJsonText(1000), created_at: at(2) },
          { seq: 3, type: "execution", meta: truncatedJsonText(200, "m"), created_at: at(3) },
          { seq: 4, type: "tool_use", tool: "Bash", input: "null", created_at: at(4) },
          { seq: 5, type: "tool_use", tool: "Bash", input: "{\"cmd\":\"ls\"}", meta: "{\"k\":\"a\\u0000b\"}", created_at: at(5) },
          { seq: 6, type: "tool_use", tool: "Bash", input: "\"just a string\"", created_at: at(6) },
          { seq: 7, type: "text", content: `words${TRACE_TRUNCATION_MARKER}`, created_at: at(7) },
        ]);
      };
      await withWorld(backend, seedJson, async (world) => {
        const report = await world.run();
        expect(report.plan.stops).toEqual([]);
        expect(report.plan.json).toMatchObject({
          json_unparseable_input: 2,
          sql_truncated_input: 2,
          json_unparseable_meta: 1,
          sql_truncated_meta: 1,
          json_unparseable_unexplained: 0,
          json_nonroundtrip: 0,
          json_non_object_input: 2,
        });
        expect(report.plan.json.samples.truncated_meta).toEqual([expect.objectContaining({ task_id: "tsk_json", seq: 3 })]);
        const events = await memberEvents(world, "tsk_json");
        expect(events.map((event) => [event.input, event.meta])).toEqual([
          [null, null],
          [null, null],
          [null, null],
          [null, null],
          [{ cmd: "ls" }, { k: "a\u0000b" }],
          ["just a string", null],
          [null, null],
        ]);
        expect(events[6]!.content).toBe(`words${TRACE_TRUNCATION_MARKER}`);
        expect(report.reconcile.task!.ok).toBe(true);
      });
    }, TIMEOUT);

    it("stops before writing anything when JSON does not parse for an unexplained reason", async () => {
      const seedBad = (db: SqlDatabase) => {
        seedBase(db);
        insertSyntheticChat(db, { id: "chat_ok", agentId: AGENT, createdAt: T0 });
        insertSyntheticTask(db, task("tsk_ok", { chatSessionId: "chat_ok" }));
        insertSyntheticMessages(db, "tsk_ok", rows([1]));
        insertSyntheticTask(db, task("tsk_bad"));
        insertSyntheticMessages(db, "tsk_bad", [
          { seq: 1, type: "tool_use", input: "{\"a\":", created_at: at(1) },
          { seq: 2, type: "execution", meta: "{\"b\":", created_at: at(2) },
        ]);
      };
      await withWorld(backend, seedBad, async (world) => {
        const dry = await runTraceBackfill({ db: world.db, execute: false, oldTableStoppedAt: CUTOFF, log: () => {} });
        expect(dry.plan.json.json_unparseable_unexplained).toBe(2);
        expect(dry.plan.stops).toEqual([
          expect.objectContaining({ code: "json_unparseable_unexplained", count: 2 }),
        ]);
        const error = await world.run().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(TraceBackfillStopError);
        expect((error as TraceBackfillStopError).stops.map((stop) => stop.code)).toEqual(["json_unparseable_unexplained"]);
        expect(count(world.db, "multiremi_trace_backfill_progress")).toBe(0);
        expect(count(world.db, "multiremi_session_archives")).toBe(0);
        expect(count(world.db, "multiremi_task_traces")).toBe(0);
        expect(await listDir(world.root)).toEqual([]);
      });
    }, TIMEOUT);

    it("counts rows whose task no longer exists and writes nothing for them", async () => {
      await withWorld(backend, seedBase, async (world) => {
        // Neither backend enforces the task foreign key (SQLite runs with it off, the
        // Postgres translation strips it), so deleted tasks can leave rows behind.
        insertSyntheticMessages(world.db, "tsk_deleted", [
          { seq: 1, type: "tool_use", input: truncatedJsonText(300), created_at: at(1) },
          { seq: 3, type: "text", content: "left behind", created_at: at(3) },
        ]);
        const report = await world.run();
        expect(report.plan.source).toMatchObject({ orphan_tasks: 1, orphan_rows: 2 });
        expect(report.plan.json).toMatchObject({ json_unparseable_input: 1, sql_truncated_input: 1 });
        expect(report.plan.subjects).toBe(0);
        expect(count(world.db, "multiremi_session_archives")).toBe(0);
        expect(count(world.db, "multiremi_task_traces")).toBe(0);
        expect(count(world.db, "multiremi_task_messages")).toBe(2);
      });
    }, TIMEOUT);

    it("records spelling-only JSON differences and continues", async () => {
      const seedSpelling = (db: SqlDatabase) => {
        seedBase(db);
        insertSyntheticTask(db, task("tsk_spelling"));
        insertSyntheticMessages(db, "tsk_spelling", [
          { seq: 1, type: "tool_use", input: "{ \"a\": 1 }", created_at: at(1) },
          { seq: 2, type: "tool_use", input: "{\"b\":\"\\u0041\"}", created_at: at(2) },
          { seq: 3, type: "tool_use", input: "{\"b\":1,\"1\":2}", created_at: at(3) },
          { seq: 4, type: "execution", meta: "{\"x\": [1, 2]}", created_at: at(4) },
        ]);
      };
      await withWorld(backend, seedSpelling, async (world) => {
        const report = await world.run();
        expect(report.plan.stops).toEqual([]);
        expect(report.plan.json.json_nonroundtrip).toBe(4);
        expect(report.plan.json.json_nonroundtrip_by_category).toMatchObject({
          whitespace: 2, escape: 1, key_order: 1, number_literal: 0, duplicate_key: 0, other: 0,
        });
        expect(report.plan.json.samples.nonroundtrip).toHaveLength(4);
        const events = await memberEvents(world, "tsk_spelling");
        expect(events.map((event) => event.input ?? event.meta)).toEqual([{ a: 1 }, { b: "A" }, { 1: 2, b: 1 }, { x: [1, 2] }]);
        expect(report.reconcile.task!.ok).toBe(true);
      });
    }, TIMEOUT);

    it("stops when a JSON column would change value: number literals and duplicate keys", async () => {
      const seedValue = (db: SqlDatabase) => {
        seedBase(db);
        insertSyntheticTask(db, task("tsk_value"));
        insertSyntheticMessages(db, "tsk_value", [
          { seq: 1, type: "tool_use", input: "{\"n\":1.0}", created_at: at(1) },
          { seq: 2, type: "tool_use", input: "{\"big\":12345678901234567890}", created_at: at(2) },
          { seq: 3, type: "execution", meta: "{\"a\":1,\"a\":2}", created_at: at(3) },
        ]);
      };
      await withWorld(backend, seedValue, async (world) => {
        const error = await world.run().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(TraceBackfillStopError);
        expect((error as TraceBackfillStopError).stops).toEqual([
          expect.objectContaining({ code: "json_nonroundtrip_duplicate_key", count: 1 }),
          expect.objectContaining({ code: "json_nonroundtrip_number_literal", count: 2 }),
        ]);
        expect(count(world.db, "multiremi_session_archives")).toBe(0);
        expect(count(world.db, "multiremi_trace_backfill_progress")).toBe(0);
      });
    }, TIMEOUT);
  });
}
