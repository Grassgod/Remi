/**
 * MUL-432 P1: tasks that ran across the switch from `multiremi_task_messages`
 * to daemon traces. The old rows' seq is sparse and restarts on every daemon
 * run while a daemon trace counts from 1, so a pointer moves by the rules of
 * its source and never by comparing heads across sources. The backfill stops
 * on these tasks until an operator acknowledges their count, still writes
 * their member as a prefix backup and leaves their card to the daemon;
 * reconcile judges each pointer by its source. Every scenario runs on SQLite
 * and Postgres, the cross-switch ones in both orders.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiSessionArchive } from "@multiremi/contracts/types.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { reconcileUnifiedModel } from "@multiremi/store/unified-model-migration.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { TraceReader } from "@multiremi/trace/trace-reader.js";
import { getLogLevel, setLogLevel } from "@shared/logger.js";
import { readZipMemberBody } from "@shared/zip/reader.js";
import { runTraceBackfill, type TraceBackfillRunOptions } from "../../../scripts/backfill-task-traces.js";
import { TraceBackfillStopError } from "../../../scripts/lib/task-trace-backfill.js";
import { openTraceBackfillArchive, reconcileTraceBackfill } from "../../../scripts/lib/task-trace-reconcile.js";
import {
  insertFixtureMessage,
  insertSyntheticAgent,
  insertSyntheticChat,
  insertSyntheticMessages,
  insertSyntheticRuntime,
  insertSyntheticTask,
} from "./trace-backfill-fixtures.js";
import { buildArchiveFixture, traceFileBody } from "./session-archive-fixtures.js";
import { traceBackfillBackends, type OpenedStore, type StoreBackend } from "./trace-backfill-backends.js";

const TIMEOUT = 120_000;
const T0 = "2026-08-01T00:00:00.000Z";
const ENDED = "2026-08-10T00:00:00.000Z";
const CUTOFF = "2026-09-01T00:00:00.000Z";
const AFTER_CUTOFF = "2026-09-02T00:00:00.000Z";
const AGENT = "agt_cs";
const RUNTIME = "rt_cs";
const DAEMON = "dmn_cs";
const CHAT = "chat_cs";
const SUBJECT = { kind: "chat" as const, id: CHAT };

const backends = await traceBackfillBackends("crossswitch");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function at(second: number): string {
  return new Date(Date.parse(T0) + second * 1000).toISOString();
}

/** `count` distinct seqs from 1 to `head`, evenly spread: the sparse old numbering. */
function oldSeqs(count: number, head: number): number[] {
  const seqs = new Set<number>();
  for (let i = 0; i < count - 1; i++) seqs.add(1 + Math.floor((i * (head - 1)) / (count - 1)));
  seqs.add(head);
  expect(seqs.size).toBe(count);
  return [...seqs];
}

let chatSequence = 0;

/**
 * A finished chat task with old rows, claimed by the daemon (so its pointer is
 * `daemon`) and with a user message and reply linked to its canonical turn.
 * The card projects that turn's current attempt.
 */
function seedChatTask(db: SqlDatabase, taskId: string, input: { endedAt: string; seqs: readonly number[] }): void {
  insertSyntheticTask(db, {
    id: taskId, agentId: AGENT, runtimeId: RUNTIME, chatSessionId: CHAT, status: "completed",
    createdAt: T0, startedAt: at(1), endedAt: input.endedAt,
  });
  insertSyntheticMessages(db, taskId, input.seqs.map((seq) => ({
    seq, type: "text", content: `OLD row ${seq}`, created_at: at(seq),
  })));
  for (const [role, body] of [["user", `ask ${taskId}`], ["assistant", `reply ${taskId}`]] as const) {
    chatSequence++;
    insertFixtureMessage(db, { id: `chm_${taskId}_${role}`, sessionId: CHAT,
      taskId: role === "assistant" ? taskId : null, role, body, at: at(chatSequence) });
  }
}

interface World {
  opened: OpenedStore;
  db: SqlDatabase;
  root: string;
  logs: string[];
  run(overrides?: Partial<TraceBackfillRunOptions>): ReturnType<typeof runTraceBackfill>;
  /** A daemon's own upload: initialize, claim, upload and complete, as the v2 protocol does. */
  daemonUpload(traces: Record<string, string>): Promise<MultiremiSessionArchive>;
}

async function withWorld(
  backend: StoreBackend,
  seed: (db: SqlDatabase, world: Pick<World, "opened">) => void,
  body: (world: World) => Promise<void>,
): Promise<void> {
  const opened = await backend.open();
  const root = await mkdtemp(join(tmpdir(), "m432-cs-"));
  try {
    const db = opened.db;
    insertSyntheticAgent(db, { id: AGENT, provider: "claude", createdAt: T0 });
    insertSyntheticRuntime(db, { id: RUNTIME, provider: "codex", daemonId: DAEMON, createdAt: T0 });
    insertSyntheticChat(db, { id: CHAT, agentId: AGENT, createdAt: T0 });
    db.run("UPDATE multiremi_chat_sessions SET session_runtime_id = ? WHERE id = ?", RUNTIME, CHAT);
    seed(db, { opened });
    expect(reconcileUnifiedModel(db).mismatches).toEqual([]);

    const service = new SessionArchiveService(opened.store, { root, minFreeBytes: 0 });
    const logs: string[] = [];
    await body({
      opened,
      db,
      root,
      logs,
      run: (overrides = {}) => runTraceBackfill({
        db, execute: true, oldTableStoppedAt: CUTOFF, store: opened.store, service, log: (line) => logs.push(line),
        ...overrides,
      }),
      daemonUpload: async (traces) => {
        const fixture = await buildArchiveFixture({ subject: SUBJECT, traces });
        const archive = service.initialize({
          workspaceId: "local", subjectKind: SUBJECT.kind, subjectId: SUBJECT.id, runtimeId: RUNTIME, daemonId: DAEMON,
          sourceRevision: fixture.sourceRevision, sha256: fixture.sha256, sizeBytes: fixture.sizeBytes,
        }).archive;
        const claim = await service.claimUploadAttempt(RUNTIME, SUBJECT, archive.id);
        await service.upload(RUNTIME, SUBJECT, archive.id, claim.uploadAttempt!, new Response(fixture.bytes as BodyInit).body);
        return await service.complete(RUNTIME, SUBJECT, archive.id, claim.uploadAttempt!);
      },
    });
  } finally {
    await opened.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** The pointer with the writer that produced it (a NULL `source` on an archive pointer means daemon). */
function pointer(world: World, taskId: string) {
  const trace = world.opened.store.getTaskTrace(taskId);
  if (!trace) return null;
  const row = world.db.query("SELECT source FROM multiremi_task_traces WHERE task_id = ?").get(taskId) as
    { source: unknown } | null;
  return {
    location: trace.location,
    archiveId: trace.archiveId,
    headSeq: trace.headSeq,
    eventCount: trace.eventCount,
    source: row?.source == null ? null : String(row.source),
  };
}

function count(db: SqlDatabase, table: string): number {
  return Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: unknown }).n);
}

function backfillArchives(world: World): MultiremiSessionArchive[] {
  return world.opened.store.listSessionArchivesForSubject(SUBJECT.kind, SUBJECT.id)
    .filter((archive) => archive.metadata.kind === "trace_backfill");
}

/** Every event a reader gets, paged through the B5 trace reader. */
async function readAll(world: World, taskId: string): Promise<TraceEvent[]> {
  const reader = new TraceReader({
    store: world.opened.store,
    daemon: new InMemoryDaemonTraceReader(() => null),
    archive: new SessionArchiveReader({ store: world.opened.store, root: world.root }),
  });
  const events: TraceEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await reader.readTrace(taskId, after, 64);
    expect(page.state).toBe("ok");
    events.push(...page.events);
    after = page.next_after_seq;
    if (page.eof) return events;
  }
}

/** The events of the task's member in the backfill archive its backfill row names. */
async function backfillMember(world: World, taskId: string): Promise<Array<Record<string, unknown>>> {
  const row = world.opened.store.listTraceBackfillTasks(SUBJECT.kind, SUBJECT.id).find((task) => task.taskId === taskId)!;
  const archive = world.opened.store.getSessionArchive(row.archiveId)!;
  const opened = await openTraceBackfillArchive(world.root, archive.relativePath);
  try {
    const entry = opened.index.members.find((member) => member.path === `traces/${taskId}.jsonl`)!;
    const { bytes } = await readZipMemberBody(opened.handle, {
      dataOffset: entry.data_offset,
      compressedSize: entry.compressed_size,
      uncompressedSize: entry.uncompressed_size,
      sha256: entry.sha256,
    });
    return bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).slice(1, -1);
  } finally {
    await opened.handle.close();
  }
}

function cardSummary(world: World, taskId: string): Record<string, unknown> {
  const metadata = world.opened.store.findTurnEntry(taskId)!.metadata as Record<string, unknown>;
  return {
    event_count: metadata.event_count, tool_call_count: metadata.tool_call_count,
    type_histogram: metadata.type_histogram, model: metadata.model,
  };
}

const CROSS_SWITCH_CASES = [
  { name: "T1: old 158 rows up to seq 11,560 against a daemon trace of 159", rows: 158, head: 11_560 },
  { name: "T2: old 20 rows up to seq 40 against a daemon trace of 159", rows: 20, head: 40 },
];
const DAEMON_EVENTS = 159;

for (const backend of backends) {
  describe.skipIf(!backend.available)(`trace backfill across the switch (${backend.name})`, () => {
    for (const scenario of CROSS_SWITCH_CASES) {
      for (const daemonFirst of [true, false]) {
        it(`${scenario.name}, ${daemonFirst ? "daemon" : "backfill"} first: the daemon owns it, the backfill keeps the prefix`, async () => {
          const seqs = oldSeqs(scenario.rows, scenario.head);
          await withWorld(backend, (db, { opened }) => {
            seedChatTask(db, "tsk_x", { endedAt: AFTER_CUTOFF, seqs });
            opened.store.markTaskTraceDaemon("tsk_x", RUNTIME);
          }, async (world) => {
            const card = cardSummary(world, "tsk_x");
            let daemon = daemonFirst ? await world.daemonUpload({
              tsk_x: traceFileBody({ events: DAEMON_EVENTS, taskId: "tsk_x" }),
            }) : null;
            const before = pointer(world, "tsk_x");

            // The gate: the dry run lists the task; execute stops until the count is acknowledged.
            const dry = await runTraceBackfill({ db: world.db, execute: false, oldTableStoppedAt: CUTOFF, log: () => {} });
            expect(dry.plan.cross_switch).toEqual({
              cutoff_evaluated: true,
              count: 1,
              by_reason: { ended_at_or_after_cutoff: 1, ended_at_unknown: 0, daemon_archive_pointer: daemonFirst ? 1 : 0 },
              task_ids: ["tsk_x"],
              ack: null,
            });
            expect(dry.plan.stops).toEqual([expect.objectContaining({ code: "cross_switch_tasks", count: 1 })]);
            for (const ack of [undefined, 2]) {
              const error = await world.run({ crossSwitchAck: ack }).catch((caught: unknown) => caught);
              expect(error).toBeInstanceOf(TraceBackfillStopError);
              expect((error as TraceBackfillStopError).stops.map((stop) => stop.code)).toEqual(["cross_switch_tasks"]);
            }
            expect(count(world.db, "multiremi_trace_backfill_progress")).toBe(0);
            expect(count(world.db, "multiremi_trace_backfill_tasks")).toBe(0);
            expect(backfillArchives(world)).toEqual([]);
            expect(pointer(world, "tsk_x")).toEqual(before);
            expect(cardSummary(world, "tsk_x")).toEqual(card);

            const report = await world.run({ crossSwitchAck: 1 });
            expect(report.plan.cross_switch).toMatchObject({ count: 1, ack: 1 });
            expect(report.execution!.chat).toMatchObject({
              written: 1,
              archives_created: 1,
              // Daemon first, the backfill member never replaces the daemon archive.
              pointers: daemonFirst ? 0 : 1,
              pointers_kept: daemonFirst ? { daemon_owned: 1 } : {},
              turn_cards_skipped_cross_switch: 1,
            });
            expect(report.reconcile.chat).toMatchObject({ ok: true, mismatch_total: 0 });
            if (daemonFirst) {
              expect(world.logs).toContain(`pointer kept: tsk_x stays on archive/daemon ${daemon!.id} (daemon_owned)`);
            } else {
              expect(pointer(world, "tsk_x")).toMatchObject({ location: "archive", source: "trace_backfill", headSeq: scenario.head });
              // The daemon's member replaces the backfill's whatever the heads.
              daemon = await world.daemonUpload({ tsk_x: traceFileBody({ events: DAEMON_EVENTS, taskId: "tsk_x" }) });
            }

            expect(daemon!.status).toBe("ready");
            expect(pointer(world, "tsk_x")).toEqual({
              location: "archive", archiveId: daemon!.id, headSeq: DAEMON_EVENTS, eventCount: DAEMON_EVENTS, source: "daemon",
            });
            const events = await readAll(world, "tsk_x");
            expect(events.map((event) => event.seq)).toEqual(Array.from({ length: DAEMON_EVENTS }, (_, i) => i + 1));
            expect(events.every((event) => event.type === "execution" && event.content === `event ${event.seq}`)).toBe(true);

            const member = await backfillMember(world, "tsk_x");
            expect(member.map((event) => event.seq)).toEqual(seqs);
            expect(member.map((event) => event.content)).toEqual(seqs.map((seq) => `OLD row ${seq}`));
            expect(world.opened.store.listTraceBackfillTasks(SUBJECT.kind, SUBJECT.id)).toEqual([
              expect.objectContaining({ taskId: "tsk_x", rowCount: scenario.rows, headSeq: scenario.head, crossSwitch: true }),
            ]);
            expect(cardSummary(world, "tsk_x")).toEqual(card);

            const reconciled = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
            expect(reconciled).toMatchObject({ ok: true, mismatch_total: 0, checked_tasks: 1, checked_rows: scenario.rows });
            expect(reconciled.informational).toMatchObject({
              cross_switch_daemon_owned: 1, turn_card_skipped_cross_switch: 1, pointer_kept_lost: 0,
            });
          });
        }, TIMEOUT);
      }
    }

    it("T3: a v1 task (claimed, old rows only, ended before the cutoff) is the backfill's and not cross-switch", async () => {
      const seqs = oldSeqs(20, 40);
      await withWorld(backend, (db, { opened }) => {
        seedChatTask(db, "tsk_v1", { endedAt: ENDED, seqs });
        opened.store.markTaskTraceDaemon("tsk_v1", RUNTIME);
      }, async (world) => {
        const report = await world.run();
        expect(report.plan.cross_switch).toMatchObject({ count: 0, task_ids: [] });
        expect(report.plan.stops).toEqual([]);
        expect(report.execution!.chat).toMatchObject({ pointers: 1, turn_cards_skipped_cross_switch: 0 });
        expect(pointer(world, "tsk_v1")).toMatchObject({
          location: "archive", archiveId: backfillArchives(world)[0]!.id, source: "trace_backfill", headSeq: 40, eventCount: 20,
        });
        const events = await readAll(world, "tsk_v1");
        expect(events.map((event) => event.seq)).toEqual(seqs);
        expect(events.map((event) => event.content)).toEqual(seqs.map((seq) => `OLD row ${seq}`));
        expect(cardSummary(world, "tsk_v1")).toMatchObject({ event_count: 20, tool_call_count: 0 });
        const reconciled = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(reconciled).toMatchObject({ ok: true, mismatch_total: 0, checked_turn_cards: 1 });
        expect(reconciled.informational.cross_switch_daemon_owned).toBe(0);
      });
    }, TIMEOUT);

    it("T4: within one source the head decides — a rerun moves forward, a shorter daemon upload is kept out and logged", async () => {
      await withWorld(backend, (db) => {
        seedChatTask(db, "tsk_pre", { endedAt: ENDED, seqs: [1, 2, 3, 4, 5] });
        insertSyntheticTask(db, {
          id: "tsk_live", agentId: AGENT, runtimeId: RUNTIME, chatSessionId: CHAT, status: "completed",
          createdAt: T0, startedAt: at(1), endedAt: AFTER_CUTOFF,
        });
      }, async (world) => {
        await world.run();
        const first = pointer(world, "tsk_pre")!;
        expect(first).toMatchObject({ location: "archive", source: "trace_backfill", headSeq: 5 });
        insertSyntheticMessages(world.db, "tsk_pre", [{ seq: 9, type: "text", content: "OLD row 9", created_at: at(9) }]);
        const redo = await world.run();
        expect(redo.execution!.chat).toMatchObject({ redone_digest_changed: 1, archives_created: 1, pointers: 1 });
        const second = pointer(world, "tsk_pre")!;
        expect(second).toMatchObject({ location: "archive", source: "trace_backfill", headSeq: 9, eventCount: 6 });
        expect(second.archiveId).not.toBe(first.archiveId);
        expect(world.opened.store.getSessionArchive(first.archiveId!)).toMatchObject({ status: "ready" });
        expect(world.opened.store.getTraceBackfillProgress(SUBJECT.kind, SUBJECT.id)).toMatchObject({
          status: "done", archiveId: second.archiveId,
        });
        expect((await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF })).ok).toBe(true);

        const longer = await world.daemonUpload({ tsk_live: traceFileBody({ events: DAEMON_EVENTS, taskId: "tsk_live" }) });
        const completions = spyOn(world.opened.store, "completeSessionArchiveWithTracePointers");
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        const level = getLogLevel();
        setLogLevel("INFO");
        let shorter: MultiremiSessionArchive;
        let completed: unknown[];
        let warned: unknown[][];
        try {
          shorter = await world.daemonUpload({ tsk_live: traceFileBody({ events: 100, taskId: "tsk_live" }) });
        } finally {
          completed = completions.mock.results.map((result) => result.value);
          warned = [...warn.mock.calls];
          setLogLevel(level);
          warn.mockRestore();
          completions.mockRestore();
        }
        expect(shorter.status).toBe("ready");
        expect(world.opened.store.getSessionArchive(shorter.id)).toMatchObject({ status: "ready" });
        expect(pointer(world, "tsk_live")).toEqual({
          location: "archive", archiveId: longer.id, headSeq: DAEMON_EVENTS, eventCount: DAEMON_EVENTS, source: "daemon",
        });
        const rejection = {
          taskId: "tsk_live",
          archiveId: shorter.id,
          incomingSource: "daemon",
          incomingHeadSeq: 100,
          reason: "newer_head_same_source",
          currentLocation: "archive",
          currentSource: "daemon",
          currentArchiveId: longer.id,
          currentHeadSeq: DAEMON_EVENTS,
        };
        // The reason is in the return value...
        expect(completed).toEqual([
          expect.objectContaining({ pointerCount: 0, rejectedPointers: [rejection] }),
        ]);
        // ...and in the log.
        const { archiveId: _archiveId, incomingSource: _source, ...logged } = rejection;
        expect(warned).toContainEqual([
          expect.stringContaining(`Session archive ${shorter.id} is ready; 1 trace pointer(s) kept`),
          { archiveId: shorter.id, rejectedPointers: [logged] },
        ]);
      });
    }, TIMEOUT);

    it("T5: reconcile flags a daemon owner nobody acknowledged and a pointer left at an older backfill archive", async () => {
      await withWorld(backend, (db) => {
        seedChatTask(db, "tsk_pre", { endedAt: ENDED, seqs: [1, 2, 3] });
        seedChatTask(db, "tsk_old", { endedAt: ENDED, seqs: [1, 2] });
        insertSyntheticTask(db, {
          id: "tsk_live", agentId: AGENT, runtimeId: RUNTIME, chatSessionId: CHAT, status: "completed",
          createdAt: T0, startedAt: at(1), endedAt: AFTER_CUTOFF,
        });
      }, async (world) => {
        await world.run();
        const stale = world.db.query("SELECT * FROM multiremi_task_traces WHERE task_id = ?").get("tsk_old") as
          Record<string, unknown>;
        insertSyntheticMessages(world.db, "tsk_old", [{ seq: 3, type: "text", content: "OLD row 3", created_at: at(3) }]);
        await world.run();
        expect((await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF })).ok).toBe(true);

        // tsk_pre was never listed as cross-switch; point it at a daemon archive by hand.
        const daemon = await world.daemonUpload({ tsk_live: traceFileBody({ events: 3, taskId: "tsk_live" }) });
        world.db.run(
          "UPDATE multiremi_task_traces SET archive_id = ?, source = 'daemon' WHERE task_id = ?",
          daemon.id, "tsk_pre",
        );
        // tsk_old back at the first backfill archive, exactly as that run wrote it.
        world.db.run(
          `UPDATE multiremi_task_traces SET archive_id = ?, member_path = ?, data_offset = ?, compressed_size = ?,
             uncompressed_size = ?, sha256 = ?, event_count = ?, head_seq = ?, source = 'trace_backfill'
           WHERE task_id = ?`,
          stale.archive_id, stale.member_path, stale.data_offset, stale.compressed_size,
          stale.uncompressed_size, stale.sha256, stale.event_count, stale.head_seq, "tsk_old",
        );
        const report = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(report.ok).toBe(false);
        expect(report.mismatches.pointer_owned_by_daemon_unexpected).toBe(1);
        expect(report.samples.mismatch).toContainEqual(expect.objectContaining({
          category: "pointer_owned_by_daemon_unexpected", task_id: "tsk_pre", archive_id: daemon.id,
        }));
        expect(report.samples.mismatch).toContainEqual(expect.objectContaining({
          category: "pointer",
          task_id: "tsk_old",
          reason: "backfill pointer is not at the subject's latest backfill archive",
          archive_id: stale.archive_id,
        }));
        expect(report.informational.cross_switch_daemon_owned).toBe(0);
      });
    }, TIMEOUT);

    it("QA2: acknowledged cross-switch reconciliation must reject an unreadable active pointer", async () => {
      await withWorld(backend, (db) => seedChatTask(db, "tsk_broken", { endedAt: AFTER_CUTOFF, seqs: [1, 40] }), async (world) => {
        await world.daemonUpload({ tsk_broken: traceFileBody({ events: DAEMON_EVENTS, taskId: "tsk_broken" }) });
        await world.run({ crossSwitchAck: 1 });
        const intact = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(intact).toMatchObject({ ok: true, mismatch_total: 0, checked_tasks: 1, checked_rows: 2 });
        expect(intact.informational.cross_switch_daemon_owned).toBe(1);

        // The daemon's pointer now names a digest its member cannot match: the trace API cannot read it.
        world.db.run("UPDATE multiremi_task_traces SET sha256 = ? WHERE task_id = ?", "0".repeat(64), "tsk_broken");
        const reader = new TraceReader({
          store: world.opened.store,
          daemon: new InMemoryDaemonTraceReader(() => null),
          archive: new SessionArchiveReader({ store: world.opened.store, root: world.root }),
        });
        expect(await reader.readTrace("tsk_broken")).toMatchObject({ state: "unreachable", reason: "archive_read_failed" });

        const reconciled = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(reconciled.ok).toBe(false);
        expect(reconciled.mismatches).toMatchObject({ active_pointer: 1, active_member_unreadable: 1 });
        expect(reconciled.mismatch_total).toBe(2);
        expect(reconciled.samples.mismatch).toEqual([
          expect.objectContaining({
            category: "active_pointer", task_id: "tsk_broken", reason: "pointer disagrees with the index entry: sha256",
          }),
          expect.objectContaining({
            category: "active_member_unreadable", task_id: "tsk_broken", state: "unreachable", reason: "archive_read_failed",
          }),
        ]);
        // The backfill member is still checked against the old rows as the prefix backup, and still agrees.
        expect(reconciled).toMatchObject({ checked_tasks: 1, checked_rows: 2 });
        expect(reconciled.informational.cross_switch_daemon_owned).toBe(1);
      });
    }, TIMEOUT);
  });
}
