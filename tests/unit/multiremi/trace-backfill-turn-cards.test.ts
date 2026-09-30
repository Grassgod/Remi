/**
 * MUL-432 item 8: the trace backfill writes each task's event count, tool call
 * count, `(type, tool)` histogram and model onto the `turn` card MUL-427's
 * conversation backfill created, on SQLite and Postgres, and reconciliation
 * checks them against the rows.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationLogEntry } from "@multiremi/contracts/conversation-log.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { backfillConversationLogWithinTransaction, reconcileConversationLog } from "@multiremi/store/conversation-log-backfill.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import {
  traceBackfillTurnCardDiff,
  type TraceBackfillTurnSummary,
} from "@multiremi/store/repos/trace-backfill-progress-repo.js";
import { TraceReader } from "@multiremi/trace/trace-reader.js";
import { countToolCalls, deriveTraceModel, summarizeTrace, traceTypeHistogram } from "@shared/trace-derive.js";
import { runTraceBackfill, type TraceBackfillRunOptions } from "../../../scripts/backfill-task-traces.js";
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
} from "../../../scripts/lib/task-trace-synthetic.js";
import { emptyTraceTurnSummary, TraceTurnSummaryBuilder } from "../../../scripts/lib/task-trace-turn-summary.js";
import { traceBackfillBackends, type OpenedStore, type StoreBackend } from "./trace-backfill-backends.js";

const TIMEOUT = 120_000;
const T0 = "2026-08-01T00:00:00.000Z";
const ENDED = "2026-08-10T00:00:00.000Z";
const CUTOFF = "2026-09-01T00:00:00.000Z";
const AGENT = "agt_tc";
const RUNTIME = "rt_tc";
const CARD_TASKS = ["tsk_chat_a", "tsk_chat_none", "tsk_issue_a", "tsk_issue_none", "tsk_issue_plain"];
const SUMMARY_KEYS = ["event_count", "tool_call_count", "type_histogram", "model"] as const;

const backends = await traceBackfillBackends("turncards");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function at(second: number): string {
  return new Date(Date.parse(T0) + second * 1000).toISOString();
}

function task(id: string, extra: Partial<Parameters<typeof insertSyntheticTask>[1]> = {}) {
  return {
    id, agentId: AGENT, runtimeId: RUNTIME, status: "completed", createdAt: T0, startedAt: at(1), endedAt: ENDED, ...extra,
  };
}

function meta(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** Sparse seq, a stray `tool` on a non-tool type, and three execution events of which the last lacks a provider. */
const CHAT_A_ROWS: SyntheticMessage[] = [
  { seq: 1, type: "execution", meta: meta({ provider: "claude", model: "sonnet-old" }), created_at: at(1) },
  { seq: 2, type: "thinking", content: "plan", created_at: at(2) },
  { seq: 3, type: "tool_use", tool: "Read", tool_call_id: "c1", input: meta({ path: "a" }), created_at: at(3) },
  { seq: 4, type: "tool_result", tool: "Read", tool_call_id: "c1", output: "a", status: "completed", created_at: at(4) },
  { seq: 6, type: "tool_use", tool: "Bash", tool_call_id: "c2", input: meta({ cmd: "ls" }), created_at: at(6) },
  { seq: 7, type: "tool_result", tool: "Bash", tool_call_id: "c2", output: "x", status: "completed", created_at: at(7) },
  { seq: 8, type: "text", content: "working", created_at: at(8) },
  { seq: 9, type: "text", tool: "Stray", content: "final answer", created_at: at(9) },
  { seq: 10, type: "execution", meta: meta({ provider: "claude", model: "sonnet-new" }), created_at: at(10) },
  { seq: 11, type: "execution", meta: meta({ model: "partial" }), created_at: at(11) },
];

/** The last execution event's meta is truncated, so it is backfilled as `null` and the model comes from the one before. */
const ISSUE_A_ROWS: SyntheticMessage[] = [
  { seq: 1, type: "text", content: "looking", created_at: at(1) },
  { seq: 2, type: "tool_use", tool: "Grep", tool_call_id: "g1", input: meta({ q: "x" }), created_at: at(2) },
  { seq: 3, type: "tool_result", tool: "Grep", tool_call_id: "g1", output: "hit", status: "completed", created_at: at(3) },
  { seq: 4, type: "execution", meta: meta({ provider: "codex", model: "gpt-x" }), created_at: at(4) },
  { seq: 5, type: "execution", meta: truncatedJsonText(300, "m"), created_at: at(5) },
];

function insertIssueSession(db: SqlDatabase, id: string, issueId: string): void {
  db.run(
    `INSERT INTO multiremi_issue_sessions (id, issue_id, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
    id, issueId, T0, T0,
  );
}

function insertSessionEvent(
  db: SqlDatabase,
  input: { sessionId: string; seq: number; kind: string; taskId: string; body?: string },
): void {
  db.run(
    `INSERT INTO multiremi_session_events (id, session_id, seq, author_type, author_id, kind, body, task_id, metadata, created_at)
     VALUES (?, ?, ?, 'member', 'local', ?, ?, ?, '{}', ?)`,
    `sev_${input.sessionId}_${input.seq}`, input.sessionId, input.seq, input.kind, input.body ?? "", input.taskId, at(input.seq),
  );
}

function insertChatMessage(
  db: SqlDatabase,
  input: { chatId: string; sequence: number; role: "user" | "assistant"; body: string; taskId?: string; failureReason?: string },
): void {
  db.run(
    `INSERT INTO multiremi_chat_messages (id, chat_session_id, task_id, role, body, failure_reason, elapsed_ms, sequence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `chm_${input.chatId}_${input.sequence}`, input.chatId, input.taskId ?? null, input.role, input.body,
    input.failureReason ?? null, input.role === "assistant" ? 1234 : null, input.sequence, at(input.sequence),
  );
}

/**
 * A Chat with a traced and a `none` task, an Issue session with a traced, a
 * `none` and a model-less task, and a one-shot Task (which has no card). The
 * cards come from MUL-427's conversation backfill over the legacy rows, as
 * they do on a migrated production database.
 */
function seedWorld(db: SqlDatabase): void {
  insertSyntheticAgent(db, { id: AGENT, provider: "claude", createdAt: T0 });
  insertSyntheticRuntime(db, { id: RUNTIME, provider: "codex", daemonId: "dmn_tc", createdAt: T0 });
  insertSyntheticChat(db, { id: "chs_tc", agentId: AGENT, createdAt: T0 });
  insertSyntheticIssue(db, { id: "iss_tc", number: 1, createdAt: T0 });
  insertIssueSession(db, "ises_tc", "iss_tc");

  insertSyntheticTask(db, task("tsk_chat_a", { chatSessionId: "chs_tc" }));
  insertSyntheticMessages(db, "tsk_chat_a", CHAT_A_ROWS);
  insertSyntheticTask(db, task("tsk_chat_none", { chatSessionId: "chs_tc", status: "failed" }));
  insertChatMessage(db, { chatId: "chs_tc", sequence: 1, role: "user", body: "hi" });
  insertChatMessage(db, { chatId: "chs_tc", sequence: 2, role: "assistant", body: "final answer", taskId: "tsk_chat_a" });
  insertChatMessage(db, { chatId: "chs_tc", sequence: 3, role: "user", body: "again" });
  insertChatMessage(db, {
    chatId: "chs_tc", sequence: 4, role: "assistant", body: "", taskId: "tsk_chat_none", failureReason: "boom",
  });

  insertSyntheticTask(db, task("tsk_issue_a", { issueId: "iss_tc", issueSessionId: "ises_tc" }));
  insertSyntheticMessages(db, "tsk_issue_a", ISSUE_A_ROWS);
  insertSyntheticTask(db, task("tsk_issue_none", { issueId: "iss_tc", issueSessionId: "ises_tc", status: "cancelled" }));
  insertSyntheticTask(db, task("tsk_issue_plain", { issueId: "iss_tc", issueSessionId: "ises_tc" }));
  insertSyntheticMessages(db, "tsk_issue_plain", [{ seq: 1, type: "text", content: "only text", created_at: at(1) }]);
  insertSessionEvent(db, { sessionId: "ises_tc", seq: 1, kind: "task_assigned", taskId: "tsk_issue_a", body: "do a" });
  insertSessionEvent(db, { sessionId: "ises_tc", seq: 2, kind: "task_completed", taskId: "tsk_issue_a" });
  insertSessionEvent(db, { sessionId: "ises_tc", seq: 3, kind: "task_assigned", taskId: "tsk_issue_none", body: "do none" });
  insertSessionEvent(db, { sessionId: "ises_tc", seq: 4, kind: "task_cancelled", taskId: "tsk_issue_none" });
  insertSessionEvent(db, { sessionId: "ises_tc", seq: 5, kind: "task_assigned", taskId: "tsk_issue_plain", body: "do plain" });

  insertSyntheticTask(db, task("tsk_one", { runtimeId: null, provider: "claude" }));
  insertSyntheticMessages(db, "tsk_one", [
    { seq: 1, type: "tool_use", tool: "Bash", tool_call_id: "o1", input: meta({ cmd: "pwd" }), created_at: at(1) },
  ]);

  const report = db.transaction(() => backfillConversationLogWithinTransaction(db))();
  expect(report.mismatches).toEqual([]);
}

interface World {
  opened: OpenedStore;
  db: SqlDatabase;
  root: string;
  run(overrides?: Partial<TraceBackfillRunOptions>): ReturnType<typeof runTraceBackfill>;
}

async function withWorld(backend: StoreBackend, body: (world: World) => Promise<void>) {
  const opened = await backend.open();
  const root = await mkdtemp(join(tmpdir(), "m432-tc-"));
  try {
    seedWorld(opened.db);
    const service = new SessionArchiveService(opened.store, { root, minFreeBytes: 0 });
    await body({
      opened,
      db: opened.db,
      root,
      run: (overrides = {}) => runTraceBackfill({
        db: opened.db, execute: true, oldTableStoppedAt: CUTOFF, store: opened.store, service, log: () => {}, ...overrides,
      }),
    });
  } finally {
    await opened.close();
    await rm(root, { recursive: true, force: true });
  }
}

function card(world: World, taskId: string): ConversationLogEntry {
  const entry = world.opened.store.findTurnEntry(taskId);
  expect(entry).not.toBeNull();
  return entry!;
}

function cards(world: World): Map<string, ConversationLogEntry> {
  return new Map(CARD_TASKS.map((taskId) => [taskId, card(world, taskId)]));
}

function withoutSummary(metadata: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...metadata };
  for (const key of SUMMARY_KEYS) delete rest[key];
  return rest;
}

/** Every event of a task, paged through the B5 trace reader from its archive member. */
async function readAllEvents(world: World, taskId: string): Promise<{ events: TraceEvent[]; head: number }> {
  const reader = new TraceReader({
    store: world.opened.store,
    daemon: new InMemoryDaemonTraceReader(() => null),
    archive: new SessionArchiveReader({ store: world.opened.store, root: world.root }),
  });
  const events: TraceEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await reader.readTrace(taskId, after, 2);
    expect(page.state).toBe("ok");
    events.push(...page.events);
    after = page.next_after_seq;
    if (page.eof) return { events, head: page.head };
  }
}

function sumCounts(report: Awaited<ReturnType<typeof runTraceBackfill>>) {
  const totals = { updated: 0, unchanged: 0, missing: 0 };
  for (const group of Object.values(report.execution!)) {
    totals.updated += group.turn_cards_updated;
    totals.unchanged += group.turn_cards_unchanged;
    totals.missing += group.turn_cards_missing;
  }
  return totals;
}

describe("turn summary builder", () => {
  it("counts exactly as the shared trace functions over the full events", () => {
    const events: TraceEvent[] = CHAT_A_ROWS.map((row) => ({
      seq: row.seq, ts: row.created_at, type: row.type, tool: row.tool ?? null, content: row.content ?? null,
      input: row.input ? JSON.parse(row.input) : null, output: row.output ?? null, tool_call_id: row.tool_call_id ?? null,
      status: row.status ?? null, meta: row.meta ? JSON.parse(row.meta) : null,
    }));
    const builder = new TraceTurnSummaryBuilder("tsk_x");
    for (const event of events) builder.add(event);
    const summary = builder.finish();
    const shared = summarizeTrace(events, 11);
    expect(summary).toEqual({
      taskId: "tsk_x",
      eventCount: shared.event_count,
      toolCallCount: shared.tool_call_count,
      typeHistogram: shared.type_histogram,
      model: deriveTraceModel(events),
    });
    expect(summary).toEqual({
      taskId: "tsk_x",
      eventCount: 10,
      toolCallCount: 2,
      typeHistogram: [
        { type: "execution", tool: null, count: 3 },
        { type: "thinking", tool: null, count: 1 },
        { type: "tool_use", tool: "Read", count: 1 },
        { type: "tool_result", tool: "Read", count: 1 },
        { type: "tool_use", tool: "Bash", count: 1 },
        { type: "tool_result", tool: "Bash", count: 1 },
        { type: "text", tool: null, count: 2 },
      ],
      model: { provider: "claude", model: "sonnet-new" },
    });
    expect(emptyTraceTurnSummary("tsk_n")).toEqual({
      taskId: "tsk_n", eventCount: 0, toolCallCount: 0, typeHistogram: [], model: null,
    });
  });

  it("names the card fields that disagree, treating an absent model as null", () => {
    const summary: TraceBackfillTurnSummary = {
      taskId: "tsk_x", eventCount: 2, toolCallCount: 1,
      typeHistogram: [{ type: "tool_use", tool: "Bash", count: 1 }, { type: "text", tool: null, count: 1 }], model: null,
    };
    expect(traceBackfillTurnCardDiff({}, summary)).toEqual(["event_count", "tool_call_count", "type_histogram"]);
    const same = {
      event_count: 2, tool_call_count: 1,
      type_histogram: [{ type: "tool_use", tool: "Bash", count: 1 }, { type: "text", tool: null, count: 1 }],
    };
    expect(traceBackfillTurnCardDiff(same, summary)).toEqual([]);
    expect(traceBackfillTurnCardDiff({ ...same, model: null }, summary)).toEqual([]);
    expect(traceBackfillTurnCardDiff({ ...same, model: { provider: "p", model: "m" } }, summary)).toEqual(["model"]);
    expect(traceBackfillTurnCardDiff(same, { ...summary, model: { provider: "p", model: "m" } })).toEqual(["model"]);
    expect(traceBackfillTurnCardDiff({ ...same, type_histogram: [...same.type_histogram].reverse() }, summary))
      .toEqual(["type_histogram"]);
    expect(traceBackfillTurnCardDiff({
      ...same, type_histogram: [{ type: "tool_use", tool: "Bash", count: 1 }, { type: "text", tool: "Stray", count: 1 }],
    }, summary)).toEqual(["type_histogram"]);
  });
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`trace backfill turn cards (${backend.name})`, () => {
    it("fills every card from its task's rows and changes nothing else on it", async () => {
      await withWorld(backend, async (world) => {
        const before = cards(world);
        for (const entry of before.values()) {
          for (const key of SUMMARY_KEYS) expect(entry.metadata).not.toHaveProperty(key);
        }
        expect(world.opened.store.findTurnEntry("tsk_one")).toBeNull();

        const report = await world.run();
        expect(sumCounts(report)).toEqual({ updated: 5, unchanged: 0, missing: 1 });
        expect(report.execution!.chat).toMatchObject({ turn_cards_updated: 2, turn_cards_missing: 0 });
        expect(report.execution!.task).toMatchObject({ turn_cards_updated: 0, turn_cards_missing: 1 });
        expect(report.execution!.issue_without_archive).toMatchObject({ turn_cards_updated: 3, turn_cards_missing: 0 });

        const after = cards(world);
        for (const taskId of CARD_TASKS) {
          const was = before.get(taskId)!;
          const now = after.get(taskId)!;
          // One update per card, and only the four summary fields differ.
          expect(now.revision).toBe(was.revision + 1);
          expect(withoutSummary(now.metadata)).toEqual(withoutSummary(was.metadata));
          expect(now.body_md).toBe(was.body_md);
        }
        // The chat reply stays as MUL-427 wrote it; an Issue turn still has none.
        expect(after.get("tsk_chat_a")!.metadata.final_reply_md).toBe("final answer");
        expect(after.get("tsk_issue_a")!.metadata).not.toHaveProperty("final_reply_md");

        for (const taskId of ["tsk_chat_a", "tsk_issue_a", "tsk_issue_plain"]) {
          const { events, head } = await readAllEvents(world, taskId);
          const shared = summarizeTrace(events, head);
          expect(after.get(taskId)!.metadata).toMatchObject({
            event_count: shared.event_count,
            tool_call_count: countToolCalls(events),
            type_histogram: traceTypeHistogram(events),
            model: deriveTraceModel(events),
          });
        }
        expect(after.get("tsk_chat_a")!.metadata).toMatchObject({
          event_count: 10,
          tool_call_count: 2,
          type_histogram: [
            { type: "execution", tool: null, count: 3 },
            { type: "thinking", tool: null, count: 1 },
            { type: "tool_use", tool: "Read", count: 1 },
            { type: "tool_result", tool: "Read", count: 1 },
            { type: "tool_use", tool: "Bash", count: 1 },
            { type: "tool_result", tool: "Bash", count: 1 },
            { type: "text", tool: null, count: 2 },
          ],
          model: { provider: "claude", model: "sonnet-new" },
        });
        expect(after.get("tsk_issue_a")!.metadata).toMatchObject({
          event_count: 5, tool_call_count: 1, model: { provider: "codex", model: "gpt-x" },
        });
        expect(after.get("tsk_issue_plain")!.metadata).toMatchObject({
          event_count: 1, tool_call_count: 0, type_histogram: [{ type: "text", tool: null, count: 1 }], model: null,
        });
        for (const taskId of ["tsk_chat_none", "tsk_issue_none"]) {
          expect(world.opened.store.getTaskTrace(taskId)).toMatchObject({ location: "none" });
          expect(after.get(taskId)!.metadata).toMatchObject({
            event_count: 0, tool_call_count: 0, type_histogram: [], model: null,
          });
        }

        expect(reconcileConversationLog(world.db).mismatches).toEqual([]);
        const full = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(full.ok).toBe(true);
        expect(full.checked_turn_cards).toBe(5);
        expect(full.informational.turn_card_missing).toBe(1);
      });
    }, TIMEOUT);

    it("leaves cards alone on a rerun and rewrites only the changed task's card on a digest redo", async () => {
      await withWorld(backend, async (world) => {
        await world.run();
        const first = cards(world);

        const rerun = await world.run();
        expect(sumCounts(rerun)).toEqual({ updated: 0, unchanged: 0, missing: 0 });
        for (const [taskId, entry] of cards(world)) expect(entry.revision).toBe(first.get(taskId)!.revision);

        insertSyntheticMessages(world.db, "tsk_issue_a", [
          { seq: 9, type: "tool_use", tool: "Edit", tool_call_id: "e1", input: meta({ f: "a" }), created_at: at(9) },
        ]);
        const redo = await world.run();
        expect(redo.execution!.issue_without_archive).toMatchObject({
          redone_digest_changed: 1, turn_cards_updated: 1, turn_cards_unchanged: 2, turn_cards_missing: 0,
        });
        const second = cards(world);
        for (const taskId of CARD_TASKS) {
          expect(second.get(taskId)!.revision).toBe(first.get(taskId)!.revision + (taskId === "tsk_issue_a" ? 1 : 0));
        }
        const { events } = await readAllEvents(world, "tsk_issue_a");
        expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 9]);
        expect(second.get("tsk_issue_a")!.metadata).toMatchObject({
          event_count: 6,
          tool_call_count: 2,
          type_histogram: traceTypeHistogram(events),
          model: { provider: "codex", model: "gpt-x" },
        });
        expect((await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF })).ok).toBe(true);
      });
    }, TIMEOUT);

    it("keeps an interrupted subject's cards untouched until the subject is redone", async () => {
      await withWorld(backend, async (world) => {
        const before = cards(world);
        await expect(world.run({
          hooks: {
            afterStage: (subject) => {
              if (subject.id === "iss_tc") throw new Error("simulated crash");
            },
          },
        })).rejects.toThrow("simulated crash");
        // The Chat group committed before the Issue group started.
        expect(card(world, "tsk_chat_a").metadata).toMatchObject({ event_count: 10 });
        for (const taskId of ["tsk_issue_a", "tsk_issue_none", "tsk_issue_plain"]) {
          expect(card(world, taskId)).toEqual(before.get(taskId)!);
        }

        const resumed = await world.run();
        expect(resumed.execution!.issue_without_archive).toMatchObject({
          resumed_interrupted: 1, turn_cards_updated: 3,
        });
        expect(card(world, "tsk_issue_a").metadata).toMatchObject({ event_count: 5, tool_call_count: 1 });
        expect(card(world, "tsk_issue_a").revision).toBe(before.get("tsk_issue_a")!.revision + 1);
        expect((await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF })).ok).toBe(true);
      });
    }, TIMEOUT);

    it("reports a card that disagrees with its rows as a turn_card mismatch", async () => {
      await withWorld(backend, async (world) => {
        await world.run();
        const tamper = (taskId: string, patch: Record<string, unknown>) => {
          const entry = card(world, taskId);
          world.db.run(
            "UPDATE multiremi_conversation_log SET metadata = ? WHERE session_id = ? AND seq = ?",
            JSON.stringify({ ...entry.metadata, ...patch }), entry.session_id, entry.seq,
          );
        };
        tamper("tsk_chat_a", { event_count: 9 });
        tamper("tsk_issue_none", { model: { provider: "claude", model: "ghost" } });
        tamper("tsk_issue_a", { type_histogram: [] });

        const full = await reconcileTraceBackfill(world.db, { archiveRoot: world.root, oldTableStoppedAt: CUTOFF });
        expect(full.ok).toBe(false);
        expect(full.mismatch_total).toBe(3);
        expect(full.mismatches.turn_card).toBe(3);
        expect(full.samples.mismatch).toEqual(expect.arrayContaining([
          expect.objectContaining({ category: "turn_card", task_id: "tsk_chat_a", fields: ["event_count"] }),
          expect.objectContaining({ category: "turn_card", task_id: "tsk_issue_none", fields: ["model"] }),
          expect.objectContaining({ category: "turn_card", task_id: "tsk_issue_a", fields: ["type_histogram"] }),
        ]));

        const sample = await reconcileTraceBackfill(world.db, {
          archiveRoot: world.root, oldTableStoppedAt: CUTOFF, taskIds: new Set(["tsk_chat_a", "tsk_issue_plain"]),
        });
        expect(sample).toMatchObject({ mode: "sample", checked_turn_cards: 2, mismatch_total: 1 });
        expect(sample.mismatches.turn_card).toBe(1);
      });
    }, TIMEOUT);
  });
}
