/**
 * Synthetic `multiremi_task_messages` data for the MUL-432 trace backfill.
 *
 * Local only: rows are inserted with plain SQL into a store the caller owns
 * (an in-memory SQLite database, a throwaway Postgres database). The tests,
 * the local drill and the read-latency bench share these helpers so they all
 * exercise the same shapes.
 */
import { SESSION_ARCHIVE_FORMAT_V1 } from "../../packages/contracts/src/session-archive.js";
import type { SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import { TRACE_TRUNCATION_MARKER } from "../../packages/shared/src/trace-sanitize.js";
import { randomInt, seededRandom, type RandomSource } from "./seeded-random.js";

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
function textPool(random: RandomSource): string {
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
  const startMs = Date.parse("2026-07-11T00:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const agents = ["agt_syn_1", "agt_syn_2", "agt_syn_3", "agt_syn_4"];
  const runtimes = [
    { id: "rt_syn_1", provider: "claude", daemonId: "dmn_syn_1" },
    { id: "rt_syn_2", provider: "claude", daemonId: "dmn_syn_2" },
    { id: "rt_syn_3", provider: "codex", daemonId: "dmn_syn_1" },
    { id: "rt_syn_4", provider: "codex", daemonId: "dmn_syn_2" },
  ];
  const created = iso(startMs - 86_400_000);
  for (const agent of agents) insertSyntheticAgent(db, { id: agent, provider: "claude", createdAt: created });
  for (const runtime of runtimes) insertSyntheticRuntime(db, { ...runtime, createdAt: created });

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
