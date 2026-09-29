/**
 * Synthetic `multiremi_task_messages` data for the MUL-432 trace backfill.
 *
 * Local only: rows are inserted with plain SQL into a store the caller owns
 * (an in-memory SQLite database, a throwaway Postgres database). The tests,
 * the local drill and the read-latency bench share these helpers so they all
 * exercise the same shapes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { SESSION_ARCHIVE_FORMAT_V1 } from "../../packages/contracts/src/session-archive.js";
import type { SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import { TRACE_TRUNCATION_MARKER } from "../../packages/shared/src/trace-sanitize.js";
import { randomInt, sampleWithoutReplacement, seededRandom, type RandomSource } from "./seeded-random.js";

export const SYNTHETIC_WORKSPACE_ID = "local";

export interface SyntheticMessage {
  seq: number;
  type: string;
  tool?: string | null;
  content?: string | null;
  input?: string | null;
  output?: string | null;
  tool_call_id?: string | null;
  status?: string | null;
  meta?: string | null;
  created_at: string;
}

export interface SyntheticTask {
  id: string;
  agentId: string;
  runtimeId?: string | null;
  issueId?: string | null;
  issueSessionId?: string | null;
  chatSessionId?: string | null;
  status: string;
  provider?: string | null;
  createdAt: string;
  startedAt?: string | null;
  /** Written to the column of the terminal status (`completed_at`, `failed_at`, `cancelled_at`). */
  endedAt?: string | null;
  workspaceId?: string;
}

export function insertSyntheticAgent(db: SqlDatabase, input: { id: string; provider: string; createdAt: string }): void {
  db.run(
    `INSERT INTO multiremi_agents (id, workspace_id, name, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.id, input.provider, input.createdAt, input.createdAt,
  );
}

export function insertSyntheticRuntime(
  db: SqlDatabase,
  input: { id: string; provider: string; daemonId: string | null; createdAt: string },
): void {
  db.run(
    `INSERT INTO multiremi_runtimes (id, workspace_id, name, provider, daemon_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.id, input.provider, input.daemonId, input.createdAt, input.createdAt,
  );
}

export function insertSyntheticIssue(
  db: SqlDatabase,
  input: { id: string; number: number; createdAt: string; lifecycleState?: "active" | "deleting" },
): void {
  db.run(
    `INSERT INTO multiremi_issues (id, workspace_id, issue_number, title, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.number, `synthetic ${input.number}`,
    input.lifecycleState ?? "active", input.createdAt, input.createdAt,
  );
}

export function insertSyntheticChat(db: SqlDatabase, input: { id: string; agentId: string; createdAt: string }): void {
  db.run(
    `INSERT INTO multiremi_chat_sessions (id, workspace_id, agent_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.id, SYNTHETIC_WORKSPACE_ID, input.agentId, input.id, input.createdAt, input.createdAt,
  );
}

export function insertSyntheticTask(db: SqlDatabase, task: SyntheticTask): void {
  const ended = task.endedAt ?? null;
  db.run(
    `INSERT INTO multiremi_tasks (
       id, workspace_id, agent_id, runtime_id, issue_id, issue_session_id, chat_session_id, status, provider,
       prompt, created_at, updated_at, dispatched_at, started_at, completed_at, failed_at, cancelled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id,
    task.workspaceId ?? SYNTHETIC_WORKSPACE_ID,
    task.agentId,
    task.runtimeId ?? null,
    task.issueId ?? null,
    task.issueSessionId ?? null,
    task.chatSessionId ?? null,
    task.status,
    task.provider ?? null,
    "synthetic",
    task.createdAt,
    ended ?? task.createdAt,
    task.startedAt ?? null,
    task.startedAt ?? null,
    task.status === "completed" ? ended : null,
    task.status === "failed" ? ended : null,
    task.status === "cancelled" ? ended : null,
  );
}

export function insertSyntheticMessages(db: SqlDatabase, taskId: string, messages: readonly SyntheticMessage[]): void {
  const insert = db.prepare(
    `INSERT INTO multiremi_task_messages (
       id, task_id, seq, type, tool, content, input, output, tool_call_id, status, meta, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const message of messages) {
      insert.run(
        `msg_${taskId}_${message.seq}`,
        taskId,
        message.seq,
        message.type,
        message.tool ?? null,
        message.content ?? null,
        message.input ?? null,
        message.output ?? null,
        message.tool_call_id ?? null,
        message.status ?? null,
        message.meta ?? null,
        message.created_at,
      );
    }
  })();
}

/**
 * Text the old write path produced for an oversized JSON column: the first
 * `bytes` characters of a JSON document, cut mid-value, plus the marker.
 */
export function truncatedJsonText(bytes: number, seed = "x"): string {
  const body = JSON.stringify({ blob: seed.repeat(Math.max(1, bytes)) });
  return `${body.slice(0, bytes)}${TRACE_TRUNCATION_MARKER}`;
}

// ───────────────────────────── corpus generator ─────────────────────────────

/**
 * Production shape of `multiremi_task_messages`, from the read-only statistics
 * in MUL-402 comment cmt_z0j166q2zbx9 (snapshot 2026-09-26T19:19Z). Only these
 * aggregates are used; no production row is read or copied.
 */
export const PRODUCTION_TRACE_SHAPE = {
  source: "MUL-402 cmt_z0j166q2zbx9, snapshot 2026-09-26T19:19Z",
  /** Tasks with rows, rows and row bytes (content+input+output+meta) per group. */
  groups: {
    chat: { tasks: 342, rows: 48_501, bytes: 42_083_178 },
    task: { tasks: 3_121, rows: 2_503_609, bytes: 485_803_493 },
    issue_without_archive: { tasks: 2_206, rows: 816_605, bytes: 621_583_036 },
    issue_with_archive: { tasks: 2_076, rows: 1_586_113, bytes: 650_444_128 },
  },
  /** Terminal tasks without any row, per subject kind. */
  noneTasks: { issue: 134, chat: 10, task: 10 },
  typeRows: {
    thinking: 2_958_677,
    text: 697_331,
    tool_use: 590_592,
    usage: 392_970,
    tool_result: 299_751,
    execution: 9_329,
    plan: 3_886,
    compaction: 705,
    steer: 184,
    question_request: 136,
    question_response: 134,
  },
  /** Total bytes per column and type, divided by that type's rows below. */
  typeBytes: {
    thinking: { content: 176_357_901, meta: 41_528 },
    text: { content: 28_226_786, meta: 424_549 },
    tool_use: { input: 483_996_106, meta: 198_656_691 },
    usage: { content: 12_655, meta: 24_073_654 },
    tool_result: { input: 19_004_269, output: 859_207_987, meta: 6_413_850 },
    execution: { meta: 542_693 },
    plan: { content: 50_518, meta: 1_532_246 },
    compaction: { content: 12_733 },
    steer: { content: 270_283, input: 22_969 },
    question_request: { content: 11_003, input: 251_133 },
    question_response: { content: 24_317, input: 35_774 },
  },
  tasksWithRows: 7_753,
  /** Per-task percentiles from the MUL-402 description (same read-only survey, 4.89M rows). */
  taskRows: { p50: 111, p90: 744, p99: 17_394 },
  taskBytes: { p50: 49_000, p90: 425_000, p99: 2_200_000 },
  tasksWithSeqGaps: 4_759,
  missingSeqs: 426_271,
  widestSpan: { rows: 1_497, head: 12_899 },
  truncatedInputRows: 187,
  truncatedOutputRows: 2_492,
  truncatedMetaRows: 0,
  nulEscapeMetaRows: 112,
  issuesWithReadyArchive: 209,
  /** Terminal statuses among task_completed/failed/cancelled session events. */
  terminal: { completed: 3_382, failed: 160, cancelled: 80 },
  toolUse: { Bash: 739_116, Read: 61_820, Edit: 39_064, Write: 18_943, Grep: 15_221, Skill: 5_316, Agent: 4_043 },
} as const;

export type SyntheticGroup = keyof typeof PRODUCTION_TRACE_SHAPE.groups;
const SYNTHETIC_GROUPS: readonly SyntheticGroup[] = ["chat", "task", "issue_without_archive", "issue_with_archive"];
type SyntheticType = keyof typeof PRODUCTION_TRACE_SHAPE.typeRows;

export interface SyntheticCorpusParams {
  seed: string;
  /** Tasks with rows, split over the four groups in production proportions. */
  tasksWithRows: number;
  /** Multiplies each group's production mean rows per task (1 = production). */
  rowScale: number;
  /**
   * Log-normal sigma of rows per task around the group mean. The default 1.87
   * gives production's mean/median of 640/111 rows (sigma² = 2 ln(mean/median)).
   */
  rowsSigma: number;
  /** Upper bound on rows per task. */
  maxRowsPerTask: number;
  /** Mean tasks per subject. Issues with an archive match production (2,076 / 209); the rest are assumptions. */
  tasksPerIssueWithArchive: number;
  tasksPerIssueWithoutArchive: number;
  tasksPerChat: number;
  /** Terminal tasks without rows; defaults to the production rate per group, at least one each. */
  noneTasks?: { issue: number; chat: number; task: number };
  /** Running tasks that already have rows (the backfill leaves them to the live path). */
  nonterminalTasksWithRows: number;
  /** Rows made regardless of scale, so every shape exists in a small corpus. */
  forced: { truncatedInput: number; truncatedOutput: number; truncatedMeta: number; nulMeta: number };
  /** Give one task a single gap as wide as production's widest (1,497 rows up to seq 12,899). */
  wideSpanTask: boolean;
  /** Every terminal task ends before this; pass it as `--old-table-stopped-at`. */
  oldTableStoppedAt: string;
}

export const SYNTHETIC_CORPUS_DEFAULTS: Omit<SyntheticCorpusParams, "seed" | "tasksWithRows" | "rowScale"> = {
  rowsSigma: 1.87,
  maxRowsPerTask: 30_000,
  tasksPerIssueWithArchive: 2_076 / 209,
  tasksPerIssueWithoutArchive: 6,
  tasksPerChat: 352 / 191,
  nonterminalTasksWithRows: 2,
  forced: { truncatedInput: 2, truncatedOutput: 2, truncatedMeta: 3, nulMeta: 2 },
  wideSpanTask: true,
  oldTableStoppedAt: "2026-09-26T19:19:00.000Z",
};

export interface SyntheticCorpusSummary {
  params: SyntheticCorpusParams;
  shape_source: string;
  subjects: Record<SyntheticGroup, number>;
  tasks: {
    with_rows: number;
    by_group: Record<SyntheticGroup, number>;
    none: { issue: number; chat: number; task: number };
    nonterminal_with_rows: number;
    runtime_missing: number;
  };
  rows: { total: number; bytes: number; by_type: Record<string, number>; by_group: Record<SyntheticGroup, number> };
  task_rows: { p50: number; p90: number; p99: number; max: number };
  task_bytes: { p50: number; p90: number; p99: number; max: number };
  sparse: { tasks_with_gaps: number; missing_seqs: number; widest_span_task: string | null };
  special: { truncated_input: number; truncated_output: number; truncated_meta: number; nul_escape_meta: number };
}

const WORDS = (
  "the a to of and in is for on with that this it as be are by from at or an file line run test code error value "
  + "return function const let type import export async await true false null undefined string number object array "
  + "bash read edit write grep git commit diff status branch merge build lint check pass fail skip trace archive "
  + "issue task chat agent runtime daemon server client request response json header trailer event seq head index "
  + "reader writer store query row column table migrate backfill reconcile verify digest sample bucket latency"
).split(" ");

/** ~1 MiB of word soup; payloads are slices of it, so they compress like text. */
export function textPool(random: RandomSource): string {
  const parts: string[] = [];
  let length = 0;
  while (length < 1024 * 1024) {
    const word = WORDS[randomInt(random, WORDS.length)]!;
    const piece = random() < 0.08 ? `${word}${randomInt(random, 10_000)}\n` : `${word} `;
    parts.push(piece);
    length += piece.length;
  }
  return parts.join("");
}

function normal(random: RandomSource): number {
  const u = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** A log-normal sample with the given mean. */
function logNormal(random: RandomSource, mean: number, sigma: number): number {
  return Math.exp(Math.log(mean) - (sigma * sigma) / 2 + sigma * normal(random));
}

function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]!;
}

function pickWeighted<T extends string>(random: RandomSource, weights: Readonly<Record<T, number>>, total: number): T {
  let target = random() * total;
  let last: T | undefined;
  for (const [key, weight] of Object.entries(weights) as Array<[T, number]>) {
    last = key;
    target -= weight;
    if (target < 0) return key;
  }
  return last!;
}

/** Largest-remainder split of `total` in proportion to `weights`, at least one each when possible. */
function split<T extends string>(total: number, weights: Readonly<Record<T, number>>): Record<T, number> {
  const keys = Object.keys(weights) as T[];
  const sum = keys.reduce((acc, key) => acc + weights[key], 0);
  const floor = total >= keys.length ? 1 : 0;
  const out = Object.fromEntries(keys.map((key) => [key, floor])) as Record<T, number>;
  const rest = total - floor * keys.length;
  const exact = keys.map((key) => ({ key, value: (rest * weights[key]) / sum }));
  let given = 0;
  for (const entry of exact) {
    out[entry.key] += Math.floor(entry.value);
    given += Math.floor(entry.value);
  }
  exact.sort((a, b) => (b.value % 1) - (a.value % 1));
  for (let i = 0; i < rest - given; i++) out[exact[i]!.key]++;
  return out;
}

/** Buffers rows into multi-row INSERTs; one statement per ~4 MiB or 200 rows. */
class SyntheticRowWriter {
  private pending: unknown[][] = [];
  private bytes = 0;

  constructor(private readonly db: SqlDatabase) {}

  add(taskId: string, message: SyntheticMessage, bytes: number): void {
    this.pending.push([
      `msg_${taskId}_${message.seq}`, taskId, message.seq, message.type, message.tool ?? null, message.content ?? null,
      message.input ?? null, message.output ?? null, message.tool_call_id ?? null, message.status ?? null,
      message.meta ?? null, message.created_at,
    ]);
    this.bytes += bytes;
    if (this.pending.length >= 200 || this.bytes >= 4 * 1024 * 1024) this.flush();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const values = this.pending.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    this.db.run(
      `INSERT INTO multiremi_task_messages (
         id, task_id, seq, type, tool, content, input, output, tool_call_id, status, meta, created_at
       ) VALUES ${values}`,
      ...this.pending.flat(),
    );
    this.pending = [];
    this.bytes = 0;
  }
}

function rowBytes(message: SyntheticMessage): number {
  let total = 0;
  for (const value of [message.content, message.input, message.output, message.meta]) {
    if (value != null) total += Buffer.byteLength(value, "utf8");
  }
  return total;
}

/** First day of the production window the survey covers (2026-07-11 → 2026-09-26). */
const SYNTHETIC_START = "2026-07-11T00:00:00.000Z";

function insertSyntheticFleet(db: SqlDatabase, createdAt: string) {
  const agents = ["agt_syn_1", "agt_syn_2", "agt_syn_3", "agt_syn_4"];
  const runtimes = [
    { id: "rt_syn_1", provider: "claude", daemonId: "dmn_syn_1" },
    { id: "rt_syn_2", provider: "claude", daemonId: "dmn_syn_2" },
    { id: "rt_syn_3", provider: "codex", daemonId: "dmn_syn_1" },
    { id: "rt_syn_4", provider: "codex", daemonId: "dmn_syn_2" },
  ];
  for (const agent of agents) insertSyntheticAgent(db, { id: agent, provider: "claude", createdAt });
  for (const runtime of runtimes) insertSyntheticRuntime(db, { ...runtime, createdAt });
  return { agents, runtimes };
}

/**
 * Fill an empty store (after `ensureLocalWorkspace`) with a corpus shaped like
 * production: the four subject groups in production proportions, per-type row
 * mix and mean column sizes, sparse seq, truncated input/output rows, NUL
 * escapes in meta, tasks without rows and running tasks. Deterministic for a
 * given `params`. Every row type, the `forced` rows, one wide seq gap and one
 * task without rows per kind exist at any scale, so small test corpora keep
 * every shape; at larger scales the rare shapes follow production rates.
 *
 * Assumptions beyond the statistics (recorded in reports): rows per task are
 * log-normal around each group's mean; column lengths are log-normal around
 * each type's mean, scaled per group so group bytes-per-row match; payloads
 * are slices of an English-like word pool; Issues without an archive hold six
 * tasks on average; one task in a hundred has no runtime.
 */
export function generateSyntheticCorpus(db: SqlDatabase, params: SyntheticCorpusParams): SyntheticCorpusSummary {
  return db.transaction(() => generateCorpus(db, params))();
}

function generateCorpus(db: SqlDatabase, params: SyntheticCorpusParams): SyntheticCorpusSummary {
  const shape = PRODUCTION_TRACE_SHAPE;
  const random = seededRandom(`corpus:${params.seed}`);
  const pool = textPool(random);
  const text = (length: number) => {
    const size = Math.max(1, Math.floor(length));
    if (size >= pool.length) return pool.repeat(Math.ceil(size / pool.length)).slice(0, size);
    const start = randomInt(random, pool.length - size);
    return pool.slice(start, start + size);
  };
  const typeTotal = Object.values(shape.typeRows).reduce((a, b) => a + b, 0);
  const toolTotal = Object.values(shape.toolUse).reduce((a, b) => a + b, 0);
  const allRows = SYNTHETIC_GROUPS.reduce((acc, group) => acc + shape.groups[group].rows, 0);
  const allBytes = SYNTHETIC_GROUPS.reduce((acc, group) => acc + shape.groups[group].bytes, 0);
  // Truncated rows are made separately at full size, so they leave the mean of the other rows.
  const truncated: Record<string, { rows: number; bytes: number }> = {
    "tool_use.input": { rows: shape.truncatedInputRows, bytes: shape.truncatedInputRows * 262_150 },
    "tool_result.output": { rows: shape.truncatedOutputRows, bytes: shape.truncatedOutputRows * 65_550 },
  };
  const meanOf = (type: SyntheticType, column: string) => {
    const cut = truncated[`${type}.${column}`] ?? { rows: 0, bytes: 0 };
    const total = (shape.typeBytes[type] as Record<string, number>)[column] ?? 0;
    return (total - cut.bytes) / (shape.typeRows[type] - cut.rows);
  };
  const rates = {
    truncatedInput: shape.truncatedInputRows / shape.typeRows.tool_use,
    truncatedOutput: shape.truncatedOutputRows / shape.typeRows.tool_result,
    nulMeta: shape.nulEscapeMetaRows / shape.typeRows.tool_use,
    gapTask: shape.tasksWithSeqGaps / shape.tasksWithRows,
  };
  const forced = { ...params.forced };
  const summary: SyntheticCorpusSummary = {
    params,
    shape_source: shape.source,
    subjects: { chat: 0, task: 0, issue_without_archive: 0, issue_with_archive: 0 },
    tasks: {
      with_rows: 0,
      by_group: { chat: 0, task: 0, issue_without_archive: 0, issue_with_archive: 0 },
      none: { issue: 0, chat: 0, task: 0 },
      nonterminal_with_rows: 0,
      runtime_missing: 0,
    },
    rows: { total: 0, bytes: 0, by_type: {}, by_group: { chat: 0, task: 0, issue_without_archive: 0, issue_with_archive: 0 } },
    task_rows: { p50: 0, p90: 0, p99: 0, max: 0 },
    task_bytes: { p50: 0, p90: 0, p99: 0, max: 0 },
    sparse: { tasks_with_gaps: 0, missing_seqs: 0, widest_span_task: null },
    special: { truncated_input: 0, truncated_output: 0, truncated_meta: 0, nul_escape_meta: 0 },
  };

  const cutoffMs = Date.parse(params.oldTableStoppedAt);
  const startMs = Date.parse(SYNTHETIC_START);
  const iso = (ms: number) => new Date(ms).toISOString();
  const { agents, runtimes } = insertSyntheticFleet(db, iso(startMs - 86_400_000));

  const writer = new SyntheticRowWriter(db);
  const taskRowCounts: number[] = [];
  const taskByteCounts: number[] = [];
  let taskCounter = 0;
  let issueCounter = 0;
  let chatCounter = 0;
  let wideSpanPending = params.wideSpanTask;
  // Every type appears at least once, in the first backfilled rows, however small the corpus.
  const pendingTypes = Object.keys(shape.typeRows) as SyntheticType[];

  const terminalStatus = () =>
    pickWeighted(random, shape.terminal, shape.terminal.completed + shape.terminal.failed + shape.terminal.cancelled);

  /** One row of `type`; `bytesFactor` scales the variable-length columns for the group. */
  const makeRow = (type: SyntheticType, seq: number, at: number, bytesFactor: number, lastCall: { id: string | null; tool: string }) => {
    const message: SyntheticMessage = { seq, type, created_at: iso(at) };
    const size = (column: string, sigma: number, cap: number) =>
      Math.min(cap, Math.max(1, logNormal(random, Math.max(1, meanOf(type, column) * bytesFactor), sigma)));
    switch (type) {
      case "thinking":
        message.content = text(size("content", 1.2, 50_000));
        if (random() < 0.0012) message.meta = JSON.stringify({ parent_tool_call_id: `call_${randomInt(random, 1e6)}` });
        break;
      case "text":
        message.content = text(size("content", 1.2, 45_000));
        if (random() < 0.0235) message.meta = JSON.stringify({ phase: random() < 0.77 ? "commentary" : "final" });
        break;
      case "tool_use": {
        const tool = pickWeighted(random, shape.toolUse, toolTotal);
        const callId = `call_${taskCounter}_${seq}`;
        lastCall.id = callId;
        lastCall.tool = tool;
        message.tool = tool;
        message.tool_call_id = callId;
        message.status = "pending";
        if (forced.truncatedInput > 0 || random() < rates.truncatedInput) {
          if (forced.truncatedInput > 0) forced.truncatedInput--;
          // The old path kept 256 KiB, backed off to a UTF-8 boundary, then added the marker.
          message.input = truncatedJsonText(256 * 1024 - randomInt(random, 15), "i");
          summary.special.truncated_input++;
        } else {
          // ~40 bytes of the mean go to the keys and the description.
          message.input = JSON.stringify({ command: text(size("input", 1.6, 200_000) - 40), description: text(24) });
        }
        const metaValue: Record<string, unknown> = { title: text(40), kind: tool === "Bash" ? "execute" : "read" };
        if (tool === "Bash") metaValue.terminal_id = `term_${randomInt(random, 1e6)}`;
        if (forced.nulMeta > 0 || random() < rates.nulMeta) {
          if (forced.nulMeta > 0) forced.nulMeta--;
          // A Bash command carrying a raw NUL: JSON.stringify writes it as \u0000.
          metaValue.title = `printf 'a\u0000b' | ${text(20)}`;
          summary.special.nul_escape_meta++;
          message.meta = JSON.stringify(metaValue);
        } else if (forced.truncatedMeta > 0) {
          forced.truncatedMeta--;
          message.meta = truncatedJsonText(64 * 1024 - randomInt(random, 15), "m");
          summary.special.truncated_meta++;
        } else {
          // ~110 bytes of the mean go to the title, kind and terminal id.
          metaValue.locations = [{ path: text(size("meta", 1.0, 20_000) - 110) }];
          message.meta = JSON.stringify(metaValue);
        }
        break;
      }
      case "tool_result":
        message.tool = lastCall.tool;
        message.tool_call_id = lastCall.id ?? `call_${taskCounter}_orphan`;
        message.status = random() < 0.95 ? "completed" : "failed";
        if (random() < 0.3) message.input = JSON.stringify({ raw: text(size("input", 1.0, 20_000) / 0.3) });
        if (forced.truncatedOutput > 0 || random() < rates.truncatedOutput) {
          if (forced.truncatedOutput > 0) forced.truncatedOutput--;
          message.output = `${text(64 * 1024 - randomInt(random, 15))}${TRACE_TRUNCATION_MARKER}`;
          summary.special.truncated_output++;
        } else {
          message.output = text(size("output", 1.8, 60_000));
        }
        message.meta = JSON.stringify({ duration_ms: randomInt(random, 100_000) });
        break;
      case "usage":
        message.meta = JSON.stringify({ size: 200_000, used: randomInt(random, 200_000) });
        break;
      case "execution":
        message.meta = JSON.stringify({ provider: "claude", model: "synthetic-model", modelName: "Synthetic", agentName: "syn" });
        break;
      case "plan":
        message.content = text(13);
        message.meta = JSON.stringify({ entries: [{ content: text(size("meta", 1.0, 20_000)), status: "pending" }] });
        break;
      case "compaction":
        message.content = text(18);
        break;
      case "steer":
      case "question_request":
      case "question_response":
        message.content = text(size("content", 1.0, 30_000));
        message.input = JSON.stringify({ text: text(size("input", 1.0, 20_000)) });
        break;
    }
    return message;
  };

  const writeTask = (
    group: SyntheticGroup,
    subject: { issueId?: string; chatSessionId?: string },
    options: { rows: number; running?: boolean },
  ) => {
    const taskId = `tsk_syn_${String(++taskCounter).padStart(6, "0")}`;
    if (group === "task") summary.subjects.task++;
    const runtime = random() < 0.01 ? null : runtimes[randomInt(random, runtimes.length)]!;
    if (!runtime) summary.tasks.runtime_missing++;
    const rows = options.rows;
    const duration = Math.max(1, rows) * 2_000;
    const begin = startMs + random() * Math.max(1, cutoffMs - startMs - duration - 60_000);
    const status = options.running ? "running" : terminalStatus();
    insertSyntheticTask(db, {
      id: taskId,
      agentId: agents[randomInt(random, agents.length)]!,
      runtimeId: runtime?.id ?? null,
      issueId: subject.issueId ?? null,
      issueSessionId: subject.issueId ? `ises_${subject.issueId}` : null,
      chatSessionId: subject.chatSessionId ?? null,
      status,
      provider: runtime ? null : "claude",
      createdAt: iso(begin - 1_000),
      startedAt: iso(begin),
      endedAt: options.running ? null : iso(begin + duration),
    });
    if (rows === 0) return;
    if (options.running) summary.tasks.nonterminal_with_rows++;
    summary.tasks.with_rows++;
    summary.tasks.by_group[group]++;
    const factor = (shape.groups[group].bytes / shape.groups[group].rows) / (allBytes / allRows);
    const wide = wideSpanPending && group === "task" && rows >= 2;
    if (wide) wideSpanPending = false;
    // The wide task has exactly its one gap; any other task with gaps has at least one, even when short.
    const gaps = !wide && random() < rates.gapTask && rows >= 2;
    const firstGapAt = gaps ? 1 + randomInt(random, rows - 1) : -1;
    const lastCall = { id: null as string | null, tool: "Bash" };
    let seq = 0;
    let bytes = 0;
    let missing = 0;
    for (let i = 0; i < rows; i++) {
      let step = 1;
      if (wide && i === rows - 1) step = shape.widestSpan.head - shape.widestSpan.rows + 1;
      else if (i === firstGapAt || (gaps && i > 0 && random() < 0.04)) step += 1 + Math.floor(-Math.log(Math.max(random(), 1e-9)) * 2.5);
      missing += step - 1;
      seq += step;
      const type = options.running ? pickWeighted(random, shape.typeRows, typeTotal)
        : pendingTypes.shift() ?? pickWeighted(random, shape.typeRows, typeTotal);
      const message = makeRow(type, seq, begin + i * 2_000, factor, lastCall);
      const size = rowBytes(message);
      bytes += size;
      summary.rows.by_type[type] = (summary.rows.by_type[type] ?? 0) + 1;
      writer.add(taskId, message, size);
    }
    if (missing > 0) {
      summary.sparse.tasks_with_gaps++;
      summary.sparse.missing_seqs += missing;
    }
    if (wide) summary.sparse.widest_span_task = taskId;
    summary.rows.total += rows;
    summary.rows.bytes += bytes;
    summary.rows.by_group[group] += rows;
    taskRowCounts.push(rows);
    taskByteCounts.push(bytes);
  };

  const rowsFor = (group: SyntheticGroup) => {
    const mean = (shape.groups[group].rows / shape.groups[group].tasks) * params.rowScale;
    return Math.max(1, Math.min(params.maxRowsPerTask, Math.round(logNormal(random, Math.max(1, mean), params.rowsSigma))));
  };
  const subjectSize = (mean: number, left: number) =>
    Math.max(1, Math.min(left, Math.round(logNormal(random, Math.max(1, mean), 0.8))));

  const perGroup = split(params.tasksWithRows, Object.fromEntries(
    SYNTHETIC_GROUPS.map((group) => [group, shape.groups[group].tasks]),
  ) as Record<SyntheticGroup, number>);
  const noneTasks = params.noneTasks ?? {
    issue: Math.max(1, Math.round(((perGroup.issue_with_archive + perGroup.issue_without_archive)
      * shape.noneTasks.issue) / (shape.groups.issue_with_archive.tasks + shape.groups.issue_without_archive.tasks))),
    chat: Math.max(1, Math.round((perGroup.chat * shape.noneTasks.chat) / shape.groups.chat.tasks)),
    task: Math.max(1, Math.round((perGroup.task * shape.noneTasks.task) / shape.groups.task.tasks)),
  };
  let runningLeft = params.nonterminalTasksWithRows;

  for (const group of SYNTHETIC_GROUPS) {
    let left = perGroup[group];
    const noneLeft = { value: group === "chat" ? noneTasks.chat : group === "task" ? noneTasks.task : 0 };
    if (group === "issue_without_archive") noneLeft.value = Math.ceil(noneTasks.issue / 2);
    if (group === "issue_with_archive") noneLeft.value = Math.floor(noneTasks.issue / 2);
    while (left > 0 || noneLeft.value > 0) {
      const subjectCreated = iso(startMs - 3_600_000);
      let subject: { issueId?: string; chatSessionId?: string } = {};
      let size = 1;
      if (group === "chat") {
        const id = `chs_syn_${String(++chatCounter).padStart(5, "0")}`;
        insertSyntheticChat(db, { id, agentId: agents[randomInt(random, agents.length)]!, createdAt: subjectCreated });
        subject = { chatSessionId: id };
        size = subjectSize(params.tasksPerChat, Math.max(1, left));
      } else if (group !== "task") {
        const number = ++issueCounter;
        const id = `iss_syn_${String(number).padStart(5, "0")}`;
        insertSyntheticIssue(db, { id, number, createdAt: subjectCreated });
        subject = { issueId: id };
        const mean = group === "issue_with_archive" ? params.tasksPerIssueWithArchive : params.tasksPerIssueWithoutArchive;
        size = subjectSize(mean, Math.max(1, left));
        if (group === "issue_with_archive") insertSyntheticDaemonArchive(db, id, subjectCreated);
      }
      // A one-shot task is a subject of its own, counted as it is written.
      if (group !== "task") summary.subjects[group]++;
      for (let i = 0; i < size && left > 0; i++, left--) {
        const running = runningLeft > 0 && group === "issue_without_archive";
        if (running) runningLeft--;
        writeTask(group, subject, { rows: rowsFor(group), running });
      }
      if (noneLeft.value > 0) {
        // A task without rows joins this subject (a one-shot task is its own subject).
        noneLeft.value--;
        writeTask(group, subject, { rows: 0 });
        if (group === "chat") summary.tasks.none.chat++;
        else if (group === "task") summary.tasks.none.task++;
        else summary.tasks.none.issue++;
      }
    }
  }
  writer.flush();
  const rowsSorted = [...taskRowCounts].sort((a, b) => a - b);
  const bytesSorted = [...taskByteCounts].sort((a, b) => a - b);
  summary.task_rows = {
    p50: nearestRank(rowsSorted, 0.5), p90: nearestRank(rowsSorted, 0.9), p99: nearestRank(rowsSorted, 0.99), max: rowsSorted.at(-1) ?? 0,
  };
  summary.task_bytes = {
    p50: nearestRank(bytesSorted, 0.5), p90: nearestRank(bytesSorted, 0.9), p99: nearestRank(bytesSorted, 0.99), max: bytesSorted.at(-1) ?? 0,
  };
  return summary;
}

/** A ready v1 archive uploaded by a daemon, so the Issue lands in the "with archive" group. */
function insertSyntheticDaemonArchive(db: SqlDatabase, issueId: string, createdAt: string): void {
  const id = `sar_syn_${issueId}`;
  db.run(
    `INSERT INTO multiremi_session_archives (
       id, workspace_id, issue_id, subject_kind, subject_id, format, runtime_id, daemon_id, source_revision, sha256,
       size_bytes, uploaded_size_bytes, file_count, status, relative_path, metadata, attempt_count, created_at,
       updated_at, completed_at
     ) VALUES (?, ?, ?, 'issue', ?, ?, 'rt_syn_1', 'dmn_syn_1', ?, ?, 1, 1, 1, 'ready', ?, ?, 1, ?, ?, ?)`,
    id, SYNTHETIC_WORKSPACE_ID, issueId, issueId, SESSION_ARCHIVE_FORMAT_V1, `rev_${id}`, "0".repeat(64),
    `workspaces/synthetic/issues/${issueId}/${id}/sessions.tar.gz`,
    JSON.stringify({ format: SESSION_ARCHIVE_FORMAT_V1 }), createdAt, createdAt, createdAt,
  );
}

// ───────────────────────────── size-tier corpus (read bench) ─────────────────────────────

/**
 * Size tiers of the archive read bench (MUL-432 QA round 1): a task's rows and
 * column bytes (content+input+output+meta, the survey's measure) at
 * production's p50, p90 and p99, from `PRODUCTION_TRACE_SHAPE`.
 */
export const TRACE_SIZE_TIERS = ["p50", "p90", "p99"] as const;
export type TraceSizeTier = (typeof TRACE_SIZE_TIERS)[number];

export const TRACE_SIZE_TIER_TARGETS: Readonly<Record<TraceSizeTier, { rows: number; bytes: number }>> = {
  p50: { rows: PRODUCTION_TRACE_SHAPE.taskRows.p50, bytes: PRODUCTION_TRACE_SHAPE.taskBytes.p50 },
  p90: { rows: PRODUCTION_TRACE_SHAPE.taskRows.p90, bytes: PRODUCTION_TRACE_SHAPE.taskBytes.p90 },
  p99: { rows: PRODUCTION_TRACE_SHAPE.taskRows.p99, bytes: PRODUCTION_TRACE_SHAPE.taskBytes.p99 },
};

export interface TieredCorpusParams {
  seed: string;
  tiers: readonly TraceSizeTier[];
  perTier: number;
  /** Extra tasks at the p50 target, in no tier, for the bench's warm-up. */
  warmupTasks: number;
  /** Rows and bytes of a task are its tier's target times 1 + U(-jitter, jitter), drawn independently. */
  jitter: number;
  oldTableStoppedAt: string;
}

export const TIERED_CORPUS_DEFAULTS: Omit<TieredCorpusParams, "seed"> = {
  tiers: TRACE_SIZE_TIERS,
  perTier: 170,
  warmupTasks: 20,
  jitter: 0.05,
  oldTableStoppedAt: SYNTHETIC_CORPUS_DEFAULTS.oldTableStoppedAt,
};

type PoolKind = "prose" | "code" | "shell";

export interface TraceTextPools {
  prose: Buffer;
  code: Buffer;
  shell: Buffer;
  /** Repository-relative source paths, for tool inputs and titles. */
  paths: string[];
  /** Identifiers from the sources, for grep patterns and edits. */
  tokens: string[];
  sources: {
    prose: { from: string; files: number; bytes: number; deflate6_ratio: number };
    code: { from: string; files: number; bytes: number; deflate6_ratio: number };
    shell: { from: string; bytes: number; deflate6_ratio: number };
  };
}

const PROSE_DIRS = ["docs", "reports"] as const;
const CODE_DIRS = ["packages/server/src", "scripts"] as const;
/** The bench's own report stays out, so a rerun does not feed on its previous output. */
const POOL_EXCLUDE = /^reports\/performance\/MUL-402-archive-trace-read-/;

function repoFiles(root: string, dirs: readonly string[], suffix: string): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir), { recursive: true }) as string[]) {
      const path = `${dir}/${entry.split("\\").join("/")}`;
      if (!path.endsWith(suffix) || POOL_EXCLUDE.test(path) || path.includes("node_modules/")) continue;
      if (statSync(join(root, path)).isFile()) out.push(path);
    }
  }
  return out.sort();
}

function deflate6Ratio(buffer: Buffer): number {
  return Number((buffer.length / deflateRawSync(buffer, { level: 6 }).length).toFixed(2));
}

function hex(random: RandomSource, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += "0123456789abcdef"[randomInt(random, 16)];
  return out;
}

/**
 * What tool results print: `cat -n` listings, `grep -n` hits, unified diffs,
 * test-runner output and pretty-printed CLI JSON with comment bodies, all
 * built from the repository's sources and docs.
 */
function shellPool(
  random: RandomSource,
  code: ReadonlyArray<{ path: string; lines: string[] }>,
  proseLines: readonly string[],
  tokens: readonly string[],
  bytes: number,
): string {
  const parts: string[] = [];
  let length = 0;
  const push = (block: string) => {
    parts.push(block);
    length += Buffer.byteLength(block, "utf8");
  };
  const file = () => code[randomInt(random, code.length)]!;
  const window = (lines: readonly string[], max: number) => {
    const count = Math.min(lines.length, 5 + randomInt(random, max));
    return { start: randomInt(random, Math.max(1, lines.length - count + 1)), count };
  };
  const paragraph = (max: number) => {
    const { start, count } = window(proseLines, max);
    return proseLines.slice(start, start + count).join("\n");
  };
  while (length < bytes) {
    const kind = random();
    if (kind < 0.3) {
      const { lines } = file();
      const { start, count } = window(lines, 200);
      const listing = lines.slice(start, start + count).map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`);
      push(`${listing.join("\n")}\n`);
    } else if (kind < 0.5) {
      const token = tokens[randomInt(random, tokens.length)]!;
      const hits: string[] = [];
      const first = randomInt(random, code.length);
      for (let k = 0; k < 60 && hits.length < 40; k++) {
        const { path, lines } = code[(first + k) % code.length]!;
        for (let i = 0; i < lines.length && hits.length < 40; i++) {
          if (lines[i]!.includes(token)) hits.push(`${path}:${i + 1}:${lines[i]}`);
        }
      }
      push(`${hits.join("\n")}\n`);
    } else if (kind < 0.65) {
      const { path, lines } = file();
      const { start, count } = window(lines, 50);
      const body = lines.slice(start, start + count).map((line) =>
        random() < 0.12 ? `-${line}\n+${line.replace(/\b([A-Za-z_]\w*)\b/, "$1Next")}` : ` ${line}`);
      push(
        `diff --git a/${path} b/${path}\nindex ${hex(random, 7)}..${hex(random, 7)} 100644\n--- a/${path}\n+++ b/${path}\n`
        + `@@ -${start + 1},${count} +${start + 1},${count} @@\n${body.join("\n")}\n`,
      );
    } else if (kind < 0.8) {
      const { path } = file();
      const count = 3 + randomInt(random, 30);
      const out = ["bun test v1.3.0", "", `tests/unit/${path.split("/").at(-1)!.replace(/\.ts$/, ".test.ts")}:`];
      for (let i = 0; i < count; i++) {
        const name = proseLines[randomInt(random, proseLines.length)]!.replace(/^[#>*\-\s|]+/, "").slice(0, 80);
        out.push(`(pass) ${tokens[randomInt(random, tokens.length)]} > ${name} [${(random() * 50).toFixed(2)}ms]`);
      }
      out.push("", ` ${count} pass`, " 0 fail", ` ${count * 3} expect() calls`, `Ran ${count} tests across 1 file. [${(random() * 5).toFixed(2)}s]`);
      push(`${out.join("\n")}\n`);
    } else {
      const items = Array.from({ length: 1 + randomInt(random, 5) }, () => ({
        id: `cmt_${hex(random, 12)}`,
        author_type: random() < 0.7 ? "agent" : "member",
        created_at: new Date(Date.parse(SYNTHETIC_START) + random() * 77 * 86_400_000).toISOString(),
        content: paragraph(12),
      }));
      push(`${JSON.stringify(items, null, 2)}\n`);
    }
  }
  return parts.join("");
}

/**
 * Text for synthetic trace payloads, taken from the repository itself instead
 * of a word list: prose from the Markdown under docs/ and reports/ (Chinese
 * and English), code from the TypeScript under packages/server/src and
 * scripts, and shell-style tool output built from both. Deterministic for a
 * given checkout and seed.
 */
export function buildTraceTextPools(repoRoot: string, seed: string, shellBytes = 4 * 1024 * 1024): TraceTextPools {
  const random = seededRandom(`pools:${seed}`);
  const proseFiles = repoFiles(repoRoot, PROSE_DIRS, ".md");
  const codeFiles = repoFiles(repoRoot, CODE_DIRS, ".ts");
  if (proseFiles.length === 0 || codeFiles.length === 0) throw new Error(`no docs or sources under ${repoRoot}`);
  const proseText = proseFiles.map((path) => readFileSync(join(repoRoot, path), "utf8")).join("\n");
  const code = codeFiles.map((path) => ({ path, lines: readFileSync(join(repoRoot, path), "utf8").split("\n") }));
  const codeText = code.map((file) => file.lines.join("\n")).join("\n");
  const identifiers = new Set<string>();
  for (const match of codeText.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g)) identifiers.add(match[0]);
  const tokens = sampleWithoutReplacement(random, [...identifiers].sort(), 2_000);
  const proseLines = proseText.split("\n").filter((line) => line.trim().length > 0);
  const prose = Buffer.from(proseText, "utf8");
  const codeBuffer = Buffer.from(codeText, "utf8");
  const shell = Buffer.from(shellPool(random, code, proseLines, tokens, shellBytes), "utf8");
  return {
    prose,
    code: codeBuffer,
    shell,
    paths: codeFiles,
    tokens,
    sources: {
      prose: { from: `${PROSE_DIRS.join(", ")} **/*.md`, files: proseFiles.length, bytes: prose.length, deflate6_ratio: deflate6Ratio(prose) },
      code: { from: `${CODE_DIRS.join(", ")} **/*.ts`, files: codeFiles.length, bytes: codeBuffer.length, deflate6_ratio: deflate6Ratio(codeBuffer) },
      shell: {
        from: "cat -n / grep -n / diff / test-run / CLI JSON built from the code and prose pools",
        bytes: shell.length,
        deflate6_ratio: deflate6Ratio(shell),
      },
    },
  };
}

/** About `bytes` bytes of `pool` starting `u` (0..1) of the way along, cut inward to whole UTF-8 characters. */
function poolSlice(pool: Buffer, u: number, bytes: number): string {
  const size = Math.min(Math.max(0, Math.floor(bytes)), pool.length);
  if (size === 0) return "";
  let start = Math.floor(u * (pool.length - size));
  let end = start + size;
  while (start < end && (pool[start]! & 0xc0) === 0x80) start++;
  let lead = end - 1;
  while (lead > start && (pool[lead]! & 0xc0) === 0x80) lead--;
  const byte = pool[lead]!;
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  if (lead + width > end) end = lead;
  return pool.toString("utf8", start, end);
}

/** The first `bytes` bytes of `value`, on a character boundary. */
function utf8Prefix(value: string, bytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.length <= bytes ? value : poolSlice(buffer, 0, bytes);
}

export interface TieredTask {
  task_id: string;
  tier: TraceSizeTier | "warmup";
  group: SyntheticGroup;
  /** Rows (the tier's jittered target, met exactly) and column bytes against their jittered target. */
  rows: number;
  target_bytes: number;
  bytes: number;
  /** Deflate level 6 of the task's column values joined by newlines. */
  payload_deflate6_bytes: number;
  head_seq: number;
  fit_passes: number;
}

export interface TieredCorpusSummary {
  params: TieredCorpusParams;
  targets: Record<TraceSizeTier, { rows: number; bytes: number }>;
  target_source: string;
  pools: TraceTextPools["sources"];
  subjects: Record<SyntheticGroup, number>;
  tasks: TieredTask[];
  rows: { total: number; bytes: number; by_type: Record<string, number> };
  sparse: { tasks_with_gaps: number; missing_seqs: number };
}

/**
 * Fill an empty store (after `ensureLocalWorkspace`) with `perTier` tasks per
 * size tier plus `warmupTasks`: each task gets its tier's row count and
 * column bytes within ±`jitter`, fixed by `seed`. Tasks are shuffled over the
 * four subject groups in production proportions (subject sizes as in
 * `generateSyntheticCorpus`); row types follow the production mix, seq gaps
 * the production rate. Column lengths start log-normal around each type's
 * production mean and are then scaled per task, in a few passes, until the
 * task's bytes are within 0.1% of its target. Payloads are slices of
 * `buildTraceTextPools`: prose for thinking/text, code for Edit/Write
 * inputs and heredocs, shell output for Bash/Read/Grep results. No row is
 * cut at the old 256 KiB / 64 KiB limits, and there are no running tasks or
 * tasks without rows: this corpus is for read latency by size, the shapes
 * corpus above covers those.
 */
export function generateTieredCorpus(db: SqlDatabase, params: TieredCorpusParams, pools: TraceTextPools): TieredCorpusSummary {
  return db.transaction(() => generateTiered(db, params, pools))();
}

interface RowSpec {
  /** Sum of the variable lengths at scale 1. */
  weight: number;
  render(scale: number): SyntheticMessage;
}

function generateTiered(db: SqlDatabase, params: TieredCorpusParams, pools: TraceTextPools): TieredCorpusSummary {
  const shape = PRODUCTION_TRACE_SHAPE;
  const random = seededRandom(`tiered:${params.seed}`);
  const typeTotal = Object.values(shape.typeRows).reduce((a, b) => a + b, 0);
  const toolTotal = Object.values(shape.toolUse).reduce((a, b) => a + b, 0);
  const meanOf = (type: SyntheticType, column: string) =>
    ((shape.typeBytes[type] as Record<string, number>)[column] ?? 0) / shape.typeRows[type];
  const gapRate = shape.tasksWithSeqGaps / shape.tasksWithRows;
  const cutoffMs = Date.parse(params.oldTableStoppedAt);
  const startMs = Date.parse(SYNTHETIC_START);
  const iso = (ms: number) => new Date(ms).toISOString();
  const { agents, runtimes } = insertSyntheticFleet(db, iso(startMs - 86_400_000));
  const summary: TieredCorpusSummary = {
    params,
    targets: { ...TRACE_SIZE_TIER_TARGETS },
    target_source: `PRODUCTION_TRACE_SHAPE.taskRows / taskBytes (${shape.source}; ADR 0006)`,
    pools: pools.sources,
    subjects: { chat: 0, task: 0, issue_without_archive: 0, issue_with_archive: 0 },
    tasks: [],
    rows: { total: 0, bytes: 0, by_type: {} },
    sparse: { tasks_with_gaps: 0, missing_seqs: 0 },
  };
  const writer = new SyntheticRowWriter(db);
  let taskCounter = 0;

  /** A row whose variable columns are pool slices, re-rendered at any scale from the same draws. */
  const rowSpec = (type: SyntheticType, seq: number, createdAt: string, call: { id: string; tool: string; path: string }): RowSpec => {
    let weight = 0;
    const piece = (kind: PoolKind, mean: number, sigma: number, cap: number) => {
      const u = random();
      const length = mean > 0 ? logNormal(random, mean, sigma) : 0;
      weight += length;
      return (scale: number) => poolSlice(pools[kind], u, Math.min(cap, length * scale));
    };
    const fixed = (kind: PoolKind, bytes: number) => poolSlice(pools[kind], random(), bytes);
    const base = { seq, type, created_at: createdAt };
    const path = pools.paths[randomInt(random, pools.paths.length)]!;
    const token = pools.tokens[randomInt(random, pools.tokens.length)]!;
    switch (type) {
      case "thinking": {
        const content = piece("prose", meanOf("thinking", "content"), 1.0, 50_000);
        const meta = random() < 0.0012 ? JSON.stringify({ parent_tool_call_id: call.id }) : null;
        return { weight, render: (s) => ({ ...base, content: content(s), meta }) };
      }
      case "text": {
        const content = piece("prose", meanOf("text", "content"), 1.2, 45_000);
        const meta = random() < 0.0235 ? JSON.stringify({ phase: random() < 0.77 ? "commentary" : "final" }) : null;
        return { weight, render: (s) => ({ ...base, content: content(s), meta }) };
      }
      case "tool_use": {
        const tool = pickWeighted(random, shape.toolUse, toolTotal);
        call.id = `call_${taskCounter}_${seq}`;
        call.tool = tool;
        call.path = path;
        const inputMean = meanOf("tool_use", "input");
        const location = { path: `/work/Remi/${path}`, line: 1 + randomInt(random, 800) };
        const head = { ...base, tool, tool_call_id: call.id, status: "pending" };
        if (tool === "Bash") {
          const heredoc = random() < 0.6;
          const commands = [
            `cd /work/Remi && bun test ${path.replace(/\.ts$/, ".test.ts")} 2>&1 | tail -40`,
            `grep -rn "${token}" ${path.split("/").slice(0, -1).join("/")} | head -30`,
            `sed -n '${location.line},${location.line + 80}p' ${path}`,
            `git diff --stat HEAD~1 -- ${path}`,
            `cd /work/Remi && bunx tsc --noEmit -p . 2>&1 | head -20`,
          ];
          const header = heredoc
            ? (random() < 0.5 ? `cat <<'EOF' | remi comment add iss_${hex(random, 12)} --content-stdin` : `cat > ${path} <<'EOF'`)
            : commands[randomInt(random, commands.length)]!;
          const body = heredoc ? piece(header.startsWith("cat >") ? "code" : "prose", inputMean / 0.6, 1.6, 200_000) : null;
          const description = fixed("prose", 20 + randomInt(random, 40));
          const titleLength = logNormal(random, Math.max(1, meanOf("tool_use", "meta") - 90), 1.0);
          weight += titleLength;
          const terminal = `term_${hex(random, 8)}`;
          return {
            weight,
            render: (s) => {
              const command = body ? `${header}\n${body(s)}\nEOF` : header;
              return {
                ...head,
                input: JSON.stringify({ command, description }),
                meta: JSON.stringify({ title: utf8Prefix(command, Math.max(40, titleLength * s)), kind: "execute", terminal_id: terminal }),
              };
            },
          };
        }
        const meta = JSON.stringify({ title: `${tool} ${path}`, kind: tool === "Edit" || tool === "Write" ? "edit" : "read", locations: [location] });
        if (tool === "Edit") {
          const old = piece("code", inputMean / 2, 1.6, 100_000);
          return {
            weight,
            render: (s) => {
              const before = old(s);
              const after = before.replace(/\b([A-Za-z_]\w*)\b/, "$1Next");
              return { ...head, input: JSON.stringify({ file_path: location.path, old_string: before, new_string: after }), meta };
            },
          };
        }
        if (tool === "Write") {
          const content = piece("code", inputMean, 1.6, 200_000);
          return { weight, render: (s) => ({ ...head, input: JSON.stringify({ file_path: location.path, content: content(s) }), meta }) };
        }
        if (tool === "Agent") {
          const prompt = piece("prose", inputMean, 1.2, 50_000);
          const description = fixed("prose", 30);
          return { weight, render: (s) => ({ ...head, input: JSON.stringify({ description, prompt: prompt(s) }), meta }) };
        }
        const input = tool === "Read"
          ? JSON.stringify({ file_path: location.path, offset: location.line, limit: 200 })
          : tool === "Grep"
            ? JSON.stringify({ pattern: token, path: location.path.split("/").slice(0, -1).join("/"), output_mode: "content", "-n": true })
            : JSON.stringify({ skill: "remi-cli", args: fixed("prose", 40) });
        return { weight, render: () => ({ ...head, input, meta }) };
      }
      case "tool_result": {
        const tool = call.tool;
        const status = random() < 0.95 ? "completed" : "failed";
        const outputMean = meanOf("tool_result", "output");
        const output = tool === "Edit" || tool === "Write"
          ? () => `The file /work/Remi/${call.path} has been updated successfully.`
          : piece(tool === "Agent" || tool === "Skill" ? "prose" : "shell", outputMean, 1.8, 64 * 1024 - 64);
        const raw = random() < 0.3 ? piece("prose", meanOf("tool_result", "input") / 0.3, 1.0, 20_000) : null;
        const meta = JSON.stringify({ duration_ms: randomInt(random, 100_000) });
        const head = { ...base, tool, tool_call_id: call.id, status };
        return {
          weight,
          render: (s) => ({ ...head, input: raw ? JSON.stringify({ raw: raw(s) }) : null, output: output(s), meta }),
        };
      }
      case "usage": {
        const meta = JSON.stringify({ size: 200_000, used: randomInt(random, 200_000), cost: { amount: Number((random() * 3).toFixed(4)), currency: "USD" } });
        return { weight: 0, render: () => ({ ...base, meta }) };
      }
      case "execution": {
        const meta = JSON.stringify({ provider: "claude", model: "synthetic-model", modelName: "Synthetic", agentName: "syn" });
        return { weight: 0, render: () => ({ ...base, meta }) };
      }
      case "plan": {
        const content = fixed("prose", 13);
        const entries = piece("prose", meanOf("plan", "meta"), 1.0, 20_000);
        return { weight, render: (s) => ({ ...base, content, meta: JSON.stringify({ entries: [{ content: entries(s), status: "pending" }] }) }) };
      }
      case "compaction": {
        const content = fixed("prose", 18);
        return { weight: 0, render: () => ({ ...base, content }) };
      }
      case "steer":
      case "question_request":
      case "question_response": {
        const content = piece("prose", meanOf(type, "content"), 1.0, 30_000);
        const input = piece("prose", meanOf(type, "input"), 1.0, 20_000);
        return { weight, render: (s) => ({ ...base, content: content(s), input: JSON.stringify({ text: input(s) }) }) };
      }
    }
  };

  const writeTask = (group: SyntheticGroup, subject: { issueId?: string; chatSessionId?: string }, tier: TraceSizeTier | "warmup") => {
    const taskId = `tsk_syn_${String(++taskCounter).padStart(6, "0")}`;
    if (group === "task") summary.subjects.task++;
    const target = TRACE_SIZE_TIER_TARGETS[tier === "warmup" ? "p50" : tier];
    const jitter = () => 1 + (random() * 2 - 1) * params.jitter;
    const rows = Math.max(1, Math.round(target.rows * jitter()));
    const bytes = Math.max(1, Math.round(target.bytes * jitter()));
    const duration = rows * 2_000;
    const begin = startMs + random() * Math.max(1, cutoffMs - startMs - duration - 60_000);
    const runtime = runtimes[randomInt(random, runtimes.length)]!;
    insertSyntheticTask(db, {
      id: taskId,
      agentId: agents[randomInt(random, agents.length)]!,
      runtimeId: runtime.id,
      issueId: subject.issueId ?? null,
      issueSessionId: subject.issueId ? `ises_${subject.issueId}` : null,
      chatSessionId: subject.chatSessionId ?? null,
      status: pickWeighted(random, shape.terminal, shape.terminal.completed + shape.terminal.failed + shape.terminal.cancelled),
      createdAt: iso(begin - 1_000),
      startedAt: iso(begin),
      endedAt: iso(begin + duration),
    });
    const gaps = rows >= 2 && random() < gapRate;
    const firstGapAt = gaps ? 1 + randomInt(random, rows - 1) : -1;
    const call = { id: `call_${taskCounter}_orphan`, tool: "Bash", path: pools.paths[0]! };
    const specs: RowSpec[] = [];
    let seq = 0;
    let missing = 0;
    for (let i = 0; i < rows; i++) {
      let step = 1;
      if (i === firstGapAt || (gaps && i > 0 && random() < 0.04)) step += 1 + Math.floor(-Math.log(Math.max(random(), 1e-9)) * 2.5);
      missing += step - 1;
      seq += step;
      specs.push(rowSpec(pickWeighted(random, shape.typeRows, typeTotal), seq, iso(begin + i * 2_000), call));
    }
    // Scale the variable lengths until the task's column bytes are within 0.1% of the target.
    const sizeAt = (scale: number) => {
      const messages = specs.map((spec) => spec.render(scale));
      return { messages, bytes: messages.reduce((acc, message) => acc + rowBytes(message), 0) };
    };
    const floor = sizeAt(0).bytes;
    const weight = specs.reduce((acc, spec) => acc + spec.weight, 0);
    let scale = weight > 0 ? Math.max(0, (bytes - floor) / weight) : 0;
    let rendered = sizeAt(scale);
    let passes = 1;
    while (passes < 8 && weight > 0 && Math.abs(rendered.bytes - bytes) > bytes * 0.001) {
      const variable = rendered.bytes - floor;
      scale = variable > 0 ? Math.max(0, (scale * (bytes - floor)) / variable) : scale * 2 + 1e-3;
      rendered = sizeAt(scale);
      passes++;
    }
    const payload: string[] = [];
    for (const message of rendered.messages) {
      summary.rows.by_type[message.type] = (summary.rows.by_type[message.type] ?? 0) + 1;
      writer.add(taskId, message, rowBytes(message));
      for (const value of [message.content, message.input, message.output, message.meta]) if (value != null) payload.push(value);
    }
    // The columns alone, without the JSONL envelope, to tell the text's own ratio from the member's.
    const payloadCompressed = deflateRawSync(Buffer.from(payload.join("\n"), "utf8"), { level: 6 }).length;
    if (missing > 0) {
      summary.sparse.tasks_with_gaps++;
      summary.sparse.missing_seqs += missing;
    }
    summary.rows.total += rows;
    summary.rows.bytes += rendered.bytes;
    summary.tasks.push({
      task_id: taskId, tier, group, rows, target_bytes: bytes, bytes: rendered.bytes, payload_deflate6_bytes: payloadCompressed,
      head_seq: seq, fit_passes: passes,
    });
  };

  const plan: Array<TraceSizeTier | "warmup"> = [];
  for (const tier of params.tiers) for (let i = 0; i < params.perTier; i++) plan.push(tier);
  for (let i = 0; i < params.warmupTasks; i++) plan.push("warmup");
  const order = sampleWithoutReplacement(random, plan, plan.length);
  const perGroup = split(order.length, Object.fromEntries(
    SYNTHETIC_GROUPS.map((group) => [group, shape.groups[group].tasks]),
  ) as Record<SyntheticGroup, number>);
  const subjectSize = (mean: number, left: number) =>
    Math.max(1, Math.min(left, Math.round(logNormal(random, Math.max(1, mean), 0.8))));
  const defaults = SYNTHETIC_CORPUS_DEFAULTS;
  let next = 0;
  let issueCounter = 0;
  let chatCounter = 0;
  for (const group of SYNTHETIC_GROUPS) {
    let left = perGroup[group];
    while (left > 0) {
      const subjectCreated = iso(startMs - 3_600_000);
      let subject: { issueId?: string; chatSessionId?: string } = {};
      let size = 1;
      if (group === "chat") {
        const id = `chs_syn_${String(++chatCounter).padStart(5, "0")}`;
        insertSyntheticChat(db, { id, agentId: agents[randomInt(random, agents.length)]!, createdAt: subjectCreated });
        subject = { chatSessionId: id };
        size = subjectSize(defaults.tasksPerChat, left);
      } else if (group !== "task") {
        const number = ++issueCounter;
        const id = `iss_syn_${String(number).padStart(5, "0")}`;
        insertSyntheticIssue(db, { id, number, createdAt: subjectCreated });
        subject = { issueId: id };
        size = subjectSize(group === "issue_with_archive" ? defaults.tasksPerIssueWithArchive : defaults.tasksPerIssueWithoutArchive, left);
        if (group === "issue_with_archive") insertSyntheticDaemonArchive(db, id, subjectCreated);
      }
      if (group !== "task") summary.subjects[group]++;
      for (let i = 0; i < size; i++, left--) writeTask(group, subject, order[next++]!);
    }
  }
  writer.flush();
  return summary;
}
