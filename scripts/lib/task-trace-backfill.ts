/**
 * Plan and render the `multiremi_task_messages` → trace archive backfill
 * (MUL-432 segment 1, items 1–6).
 *
 * Shared by `scripts/backfill-task-traces.ts`, the read-only reconciliation and
 * the synthetic bench. Everything here reads: the plan uses plain SELECTs on the
 * raw handle, so a dry run never constructs `MultiremiStore` (whose constructor
 * migrates) and never touches the archive root.
 *
 * Rows are rendered exactly as they are stored. `TraceStore.append` is not on
 * this path: its sanitize and truncate rules already ran when the row was
 * written, and running them again would rewrite the rows that were cut then.
 * String columns are copied as-is; the two JSON columns go through
 * `parseStoredTraceJson`, so text that does not parse — the rows the old write
 * path cut mid-document — becomes `null` (ADR 0006 Decision 9).
 */
import { createHash, type Hash } from "node:crypto";
import type { SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import { parseStoredTraceJson, TRACE_TRUNCATION_MARKER } from "../../packages/shared/src/trace-sanitize.js";
import {
  checkTraceFileLines,
  isTraceFileEvent,
  isTraceFileTrailer,
  TRACE_FILE_FORMAT,
  type TraceEndStatus,
  type TraceFileHeader,
  type TraceFileTrailer,
} from "../../packages/contracts/src/trace-file.js";

export const TRACE_BACKFILL_CONFIRMATION = "MUL-402";
export const TRACE_BACKFILL_METADATA_KIND = "trace_backfill";
/** Keyset batch size over `(task_id, seq)`. */
export const TRACE_BACKFILL_BATCH_ROWS = 500;
/**
 * Upper bound on one fetch. A batch of 500 rows can reach ~330 MiB (content and
 * input are capped at 256 KiB each), above the 64 MiB result buffer of the
 * Postgres bridge, so a batch is split into byte-bounded sub-ranges.
 */
export const TRACE_BACKFILL_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
/** Same as the session-archive writer's default source cap. */
export const TRACE_BACKFILL_DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const PAGE_ROWS = 2000;
const ARCHIVE_PAGE_ROWS = 200;
const DEFAULT_SAMPLE_LIMIT = 20;
const EXCERPT_CHARS = 120;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
/** Mirrors the subject check of `SessionArchiveService`. */
const SUBJECT_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;
/** Mirrors the member-name check of the session-archive writer. */
const UNSAFE_TASK_ID = /[/\\\0]/;

/** Key order of the live writer (`sanitizeStoredEvent` plus `seq`). */
export const TRACE_EVENT_KEYS = [
  "ts", "type", "tool", "content", "input", "output", "tool_call_id", "status", "meta", "seq",
] as const;

export type TraceBackfillSubjectKind = "issue" | "chat" | "task";
export type TraceBackfillGroup = "chat" | "task" | "issue_without_archive" | "issue_with_archive";
/** Chat first as the canary, then one-shot Tasks, then Issues without and with an existing archive. */
export const TRACE_BACKFILL_GROUPS: readonly TraceBackfillGroup[] = [
  "chat", "task", "issue_without_archive", "issue_with_archive",
];

export interface TraceBackfillSourceRow {
  task_id: string;
  seq: number;
  type: string;
  tool: string | null;
  content: string | null;
  input: string | null;
  output: string | null;
  tool_call_id: string | null;
  status: string | null;
  meta: string | null;
  created_at: string;
}

export interface TraceBackfillTaskInfo {
  id: string;
  workspaceId: string;
  agentId: string;
  status: string;
  taskProvider: string | null;
  runtimeId: string | null;
  issueId: string | null;
  issueSessionId: string | null;
  chatSessionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  runtimeExists: boolean;
  runtimeProvider: string | null;
  runtimeDaemonId: string | null;
  agentProvider: string | null;
  issueExists: boolean;
  issueWorkspaceId: string | null;
  issueLifecycle: string | null;
  chatExists: boolean;
  chatWorkspaceId: string | null;
  traceLocation: string | null;
  traceArchiveId: string | null;
  /** Writer of an `archive` pointer: `daemon` (NULL before MUL-432 P1) or `trace_backfill`. */
  traceSource: string | null;
  traceEventCount: number | null;
  traceHeadSeq: number | null;
}

export interface TraceBackfillPlannedTask {
  taskId: string;
  header: TraceFileHeader;
  trailer: TraceFileTrailer;
  rowCount: number;
  headSeq: number;
  /** Canonical digest of the file this task renders to; see {@link TraceTaskDigest}. */
  digest: string;
  /** Size of the rendered `.jsonl` in bytes. */
  bytes: number;
}

export interface TraceBackfillPlannedSubject {
  kind: TraceBackfillSubjectKind;
  id: string;
  group: TraceBackfillGroup;
  workspaceId: string;
  /** Recorded on the archive row and its pointers; `""` when no task of the subject has a Runtime row. */
  runtimeId: string;
  daemonId: string;
  tasks: TraceBackfillPlannedTask[];
  noneTaskIds: string[];
  /** Rendered tasks that are cross-switch (see {@link TraceBackfillPlanReport.cross_switch}). */
  crossSwitchTaskIds: string[];
  rowCount: number;
  bytes: number;
  digest: string;
}

export type TraceBackfillCrossSwitchReason =
  | "ended_at_or_after_cutoff"
  | "ended_at_unknown"
  | "daemon_archive_pointer";

export interface TraceBackfillStop {
  code: string;
  count: number;
  detail?: string;
  samples?: unknown[];
}

export type NonRoundtripCategory =
  | "whitespace"
  | "escape"
  | "key_order"
  | "number_literal"
  | "duplicate_key"
  | "other";

/** Differences that change what a reader sees; everything else only changes the spelling. */
export const NONROUNDTRIP_STOP_CATEGORIES: ReadonlySet<NonRoundtripCategory> = new Set([
  "number_literal", "duplicate_key", "other",
]);

export interface TraceBackfillJsonColumnStats {
  non_null: number;
  parseable: number;
  /** Did not parse and ends with the truncation marker: the old write path cut it. */
  unparseable_truncated: number;
  unparseable_unexplained: number;
  non_object: number;
  nonroundtrip: number;
  nonroundtrip_by_category: Record<NonRoundtripCategory, number>;
  /** Rows whose parsed value holds a NUL, stored as the six-character `\u0000` escape. */
  nul_escape_rows: number;
}

export interface TraceBackfillPlanReport {
  generated_at: string;
  dialect: string;
  old_table_stopped_at: string | null;
  params: { batch_rows: number; chunk_bytes: number; max_source_bytes: number };
  source: {
    rows: number;
    tasks: number;
    tasks_with_rows: number;
    orphan_tasks: number;
    orphan_rows: number;
    nonterminal_tasks_with_rows: number;
    nonterminal_rows: number;
    skipped: Record<"issue_missing" | "issue_deleting", { tasks: number; rows: number }>;
    chat_missing_as_task: number;
    tasks_with_existing_archive_pointer: number;
    /**
     * Rendered tasks whose pointer is `lost`. The swap rule never moves a
     * `lost` pointer, so these keep reading as lost although the archive holds
     * their rows.
     */
    tasks_with_lost_pointer: number;
  };
  groups: Record<TraceBackfillGroup, {
    subjects: number;
    traced_tasks: number;
    rows: number;
    none_tasks: number;
    bytes: number;
  }>;
  subjects: number;
  traced_tasks: number;
  traced_rows: number;
  largest_subject_bytes: number;
  archive_runtime_missing: number;
  archive_daemon_missing: number;
  header: {
    provider_from: Record<"runtime" | "task" | "agent" | "unknown", number>;
    started_at_from: Record<"started_at" | "dispatched_at" | "created_at" | "missing", number>;
    ended_at_from: Record<"status_timestamp" | "other_terminal_timestamp" | "updated_at" | "missing", number>;
  };
  none: {
    /** Whether condition 2 (ended before the old table stopped) could be evaluated. */
    cutoff_evaluated: boolean;
    eligible: number;
    eligible_by_kind: Record<TraceBackfillSubjectKind, number>;
    eligible_by_pointer: Record<string, number>;
    /** Tasks with no rows that meet conditions 1, 3, 4 and 5, whatever the cutoff. */
    eligible_ignoring_cutoff: number;
    ineligible: Record<string, number>;
  };
  /**
   * Terminal tasks with rows whose trace may also exist on a daemon: they ended
   * at or after the old table stopped (or their end is unknown), or their
   * pointer already reads a daemon's archive. The backfill still writes their
   * rows as a prefix backup, but the daemon's trace keeps or takes the pointer
   * and their `turn` cards are not rewritten. Execution stops on them unless
   * `--cross-switch-ack` equals `count`.
   */
  cross_switch: {
    /** Whether the ended-at condition could be evaluated (a cutoff was given). */
    cutoff_evaluated: boolean;
    count: number;
    /** A task counts once per reason it meets. */
    by_reason: Record<TraceBackfillCrossSwitchReason, number>;
    task_ids: string[];
    /** `--cross-switch-ack` as given; null when absent. */
    ack: number | null;
  };
  json: {
    json_unparseable_input: number;
    json_unparseable_meta: number;
    json_unparseable_unexplained: number;
    json_nonroundtrip: number;
    json_nonroundtrip_by_category: Record<NonRoundtripCategory, number>;
    json_non_object_input: number;
    json_non_object_meta: number;
    sql_truncated_input: number;
    sql_truncated_meta: number;
    input: TraceBackfillJsonColumnStats;
    meta: TraceBackfillJsonColumnStats;
    samples: {
      nonroundtrip: unknown[];
      unexplained: unknown[];
      meta_nul_escape: unknown[];
      truncated_meta: unknown[];
    };
  };
  stops: TraceBackfillStop[];
}

export interface TraceBackfillPlan {
  subjects: TraceBackfillPlannedSubject[];
  tasks: Map<string, TraceBackfillTaskInfo>;
  report: TraceBackfillPlanReport;
  stops: TraceBackfillStop[];
}

export interface TraceBackfillPlanOptions {
  /** Moment A stopped writing the old table; required before `none` pointers can be planned. */
  oldTableStoppedAt?: string | null;
  /**
   * The operator's acknowledgement of the cross-switch count. Without it the
   * plan stops on any cross-switch task; with it, only when it differs.
   */
  crossSwitchAck?: number | null;
  maxSourceBytes?: number;
  chunkBytes?: number;
  batchRows?: number;
  sampleLimit?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export class TraceBackfillStopError extends Error {
  constructor(readonly stops: readonly TraceBackfillStop[]) {
    super(`trace backfill stopped: ${stops.map((stop) => `${stop.code}=${stop.count}`).join(", ")}`);
    this.name = "TraceBackfillStopError";
  }
}

// ───────────────────────────── small helpers ─────────────────────────────

function text(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : String(value);
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function num(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function excerpt(value: string, at = 0): string {
  const start = Math.max(0, at - Math.floor(EXCERPT_CHARS / 2));
  return value.slice(start, start + EXCERPT_CHARS);
}

function pushSample(list: unknown[], limit: number, sample: unknown): void {
  if (list.length < limit) list.push(sample);
}

function bump<K extends string>(counter: Record<K, number>, key: K, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by;
}

export function isTerminalTaskStatus(status: string): status is TraceEndStatus {
  return TERMINAL_STATUSES.has(status);
}

// ───────────────────────────── canonical digests ─────────────────────────────

/**
 * JSON with sorted keys and no whitespace. Built as a string rather than by
 * re-assembling objects, so a `__proto__` key stays an ordinary key.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * One length-prefixed field. Strings are hashed as UTF-16 code units, so two
 * strings digest equal exactly when they are equal in JS — lone surrogates
 * included, which a UTF-8 encoding would collapse into U+FFFD.
 */
function putField(hash: Hash, value: unknown): void {
  if (value === undefined) { hash.update("U;"); return; }
  if (value === null) { hash.update("N;"); return; }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf16le");
    hash.update(`S${bytes.length}:`);
    hash.update(bytes);
    return;
  }
  const rendered = Buffer.from(canonicalJson(value), "utf16le");
  hash.update(`${typeof value === "number" ? "D" : "J"}${rendered.length}:`);
  hash.update(rendered);
}

function putJsonField(hash: Hash, value: unknown): void {
  if (value === undefined) { hash.update("U;"); return; }
  if (value === null) { hash.update("N;"); return; }
  const rendered = Buffer.from(canonicalJson(value), "utf16le");
  hash.update(`J${rendered.length}:`);
  hash.update(rendered);
}

/**
 * Digest of one event, identical for the source row and the line read back
 * from the archive: string fields compare exactly, `input` and `meta` compare
 * as canonical JSON (a `null` source must stay `null`).
 */
export function traceEventDigest(event: Record<string, unknown>): string {
  const hash = createHash("sha256");
  putField(hash, event.seq);
  putField(hash, event.ts);
  putField(hash, event.type);
  putField(hash, event.tool);
  putField(hash, event.content);
  putField(hash, event.output);
  putField(hash, event.tool_call_id);
  putField(hash, event.status);
  putJsonField(hash, event.input);
  putJsonField(hash, event.meta);
  return hash.digest("hex");
}

/** Streaming digest of one task's file: header fields, event digests in file order, trailer fields. */
export class TraceTaskDigest {
  private readonly hash = createHash("sha256");

  constructor(header: Record<string, unknown>) {
    for (const key of ["format", "task_id", "session_id", "agent_id", "provider", "started_at"]) {
      putField(this.hash, header[key]);
    }
  }

  line(eventDigest: string): void {
    this.hash.update(`L${eventDigest};`);
  }

  finish(end: Record<string, unknown>): string {
    for (const key of ["status", "head", "event_count", "ended_at"]) putField(this.hash, end[key]);
    return this.hash.digest("hex");
  }
}

/**
 * Digest of a subject: every rendered task by id, then the tasks that get a
 * `none` pointer, then — only when there are any — the cross-switch tasks, whose
 * `turn` cards the run leaves alone. A change in that set redoes the subject.
 */
export function traceSubjectDigest(
  kind: TraceBackfillSubjectKind,
  id: string,
  tasks: ReadonlyArray<{ taskId: string; digest: string }>,
  noneTaskIds: readonly string[],
  crossSwitchTaskIds: readonly string[] = [],
): string {
  const hash = createHash("sha256");
  putField(hash, kind);
  putField(hash, id);
  for (const task of [...tasks].sort((a, b) => compareText(a.taskId, b.taskId))) {
    putField(hash, task.taskId);
    putField(hash, task.digest);
  }
  hash.update("|none|");
  for (const taskId of [...noneTaskIds].sort(compareText)) putField(hash, taskId);
  if (crossSwitchTaskIds.length > 0) {
    hash.update("|cross_switch|");
    for (const taskId of [...crossSwitchTaskIds].sort(compareText)) putField(hash, taskId);
  }
  return hash.digest("hex");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ───────────────────────────── JSON columns ─────────────────────────────

type JsonNode =
  | { t: "o"; pairs: Array<[string, JsonNode]> }
  | { t: "a"; items: JsonNode[] }
  | { t: "s"; v: string }
  | { t: "n"; raw: string }
  | { t: "l"; raw: string };

/**
 * A small JSON reader that keeps what `JSON.parse` throws away: number
 * literals as written, key order and duplicate keys, and the source tokens
 * without whitespace. It only ever sees text `JSON.parse` already accepted.
 */
function parseJsonTree(source: string): { node: JsonNode; minified: string } {
  let at = 0;
  const out: string[] = [];
  const skip = () => {
    while (at < source.length && (source[at] === " " || source[at] === "\t" || source[at] === "\n" || source[at] === "\r")) at++;
  };
  const expect = (char: string) => {
    if (source[at] !== char) throw new Error(`expected ${char} at ${at}`);
    out.push(char);
    at++;
  };
  const readString = (): string => {
    const start = at;
    at++;
    while (at < source.length && source[at] !== "\"") at += source[at] === "\\" ? 2 : 1;
    at++;
    const raw = source.slice(start, at);
    out.push(raw);
    return JSON.parse(raw) as string;
  };
  const value = (): JsonNode => {
    skip();
    const char = source[at];
    if (char === "{") {
      expect("{");
      const pairs: Array<[string, JsonNode]> = [];
      skip();
      if (source[at] === "}") { expect("}"); return { t: "o", pairs }; }
      for (;;) {
        skip();
        const key = readString();
        skip();
        expect(":");
        pairs.push([key, value()]);
        skip();
        if (source[at] === ",") { expect(","); continue; }
        expect("}");
        return { t: "o", pairs };
      }
    }
    if (char === "[") {
      expect("[");
      const items: JsonNode[] = [];
      skip();
      if (source[at] === "]") { expect("]"); return { t: "a", items }; }
      for (;;) {
        items.push(value());
        skip();
        if (source[at] === ",") { expect(","); continue; }
        expect("]");
        return { t: "a", items };
      }
    }
    if (char === "\"") return { t: "s", v: readString() };
    const literal = /^(?:true|false|null)/.exec(source.slice(at, at + 5));
    if (literal) {
      out.push(literal[0]);
      at += literal[0].length;
      return { t: "l", raw: literal[0] };
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at, at + 1024));
    if (!number) throw new Error(`unexpected token at ${at}`);
    out.push(number[0]);
    at += number[0].length;
    return { t: "n", raw: number[0] };
  };
  const node = value();
  skip();
  if (at !== source.length) throw new Error("trailing characters");
  return { node, minified: out.join("") };
}

function someNode(node: JsonNode, test: (node: JsonNode) => boolean): boolean {
  if (test(node)) return true;
  if (node.t === "o") return node.pairs.some(([, child]) => someNode(child, test));
  if (node.t === "a") return node.items.some((child) => someNode(child, test));
  return false;
}

function sameTree(left: JsonNode, right: JsonNode, sortKeys: boolean): boolean {
  if (left.t !== right.t) return false;
  switch (left.t) {
    case "s": return left.v === (right as { v: string }).v;
    case "n":
    case "l": return left.raw === (right as { raw: string }).raw;
    case "a": {
      const items = (right as { items: JsonNode[] }).items;
      return left.items.length === items.length && left.items.every((item, i) => sameTree(item, items[i]!, sortKeys));
    }
    case "o": {
      const order = (pairs: Array<[string, JsonNode]>) =>
        sortKeys ? [...pairs].sort(([a], [b]) => compareText(a, b)) : pairs;
      const a = order(left.pairs);
      const b = order((right as { pairs: Array<[string, JsonNode]> }).pairs);
      return a.length === b.length && a.every(([key, child], i) => key === b[i]![0] && sameTree(child, b[i]![1], sortKeys));
    }
  }
}

/**
 * Why `JSON.stringify(JSON.parse(text))` differs from `text`.
 *
 * Whitespace, escape spelling and key order change only how the value is
 * written. A number literal that does not survive (`1.0`, `1e5`, `-0`, a
 * 20-digit integer), a duplicate key (the parse keeps one) or anything this
 * reader cannot explain changes the value itself, so the backfill stops.
 */
export function classifyNonRoundtrip(source: string, value: unknown): NonRoundtripCategory {
  let tree: ReturnType<typeof parseJsonTree>;
  let rendered: JsonNode;
  const stringified = JSON.stringify(value);
  try {
    tree = parseJsonTree(source);
    rendered = parseJsonTree(stringified).node;
  } catch {
    return "other";
  }
  if (someNode(tree.node, (node) => node.t === "n" && JSON.stringify(Number(node.raw)) !== node.raw)) {
    return "number_literal";
  }
  if (someNode(tree.node, (node) => node.t === "o" && new Set(node.pairs.map(([key]) => key)).size !== node.pairs.length)) {
    return "duplicate_key";
  }
  if (tree.minified === stringified) return "whitespace";
  if (sameTree(tree.node, rendered, false)) return "escape";
  if (sameTree(tree.node, rendered, true)) return "key_order";
  return "other";
}

function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0");
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsNul);
  return Object.entries(value).some(([key, child]) => key.includes("\0") || containsNul(child));
}

const JSON_NULL_TEXT = /^[ \t\n\r]*null[ \t\n\r]*$/;

function emptyCategories(): Record<NonRoundtripCategory, number> {
  return { whitespace: 0, escape: 0, key_order: 0, number_literal: 0, duplicate_key: 0, other: 0 };
}

function emptyColumnStats(): TraceBackfillJsonColumnStats {
  return {
    non_null: 0,
    parseable: 0,
    unparseable_truncated: 0,
    unparseable_unexplained: 0,
    non_object: 0,
    nonroundtrip: 0,
    nonroundtrip_by_category: emptyCategories(),
    nul_escape_rows: 0,
  };
}

interface JsonSamples {
  nonroundtrip: unknown[];
  unexplained: unknown[];
  meta_nul_escape: unknown[];
  truncated_meta: unknown[];
}

/**
 * Parse one stored JSON column the way the trace reader will, and account for it.
 * The written value is always `parseStoredTraceJson(stored)`.
 */
function analyzeJsonColumn(
  column: "input" | "meta",
  stored: string | null,
  row: { task_id: string; seq: number },
  stats: TraceBackfillJsonColumnStats,
  samples: JsonSamples,
  sampleLimit: number,
): unknown {
  const value = parseStoredTraceJson<unknown>(stored);
  if (stored == null) return value;
  stats.non_null++;
  if (value === null && !JSON_NULL_TEXT.test(stored)) {
    if (stored.endsWith(TRACE_TRUNCATION_MARKER)) {
      stats.unparseable_truncated++;
      if (column === "meta") {
        pushSample(samples.truncated_meta, sampleLimit, {
          task_id: row.task_id, seq: row.seq, bytes: Buffer.byteLength(stored, "utf8"),
        });
      }
    } else {
      stats.unparseable_unexplained++;
      pushSample(samples.unexplained, sampleLimit, {
        task_id: row.task_id, seq: row.seq, column, bytes: Buffer.byteLength(stored, "utf8"),
        head: excerpt(stored), tail: stored.slice(-40),
      });
    }
    return value;
  }
  stats.parseable++;
  if (value === null || typeof value !== "object" || Array.isArray(value)) stats.non_object++;
  const stringified = JSON.stringify(value);
  if (stringified !== stored) {
    const category = classifyNonRoundtrip(stored, value);
    stats.nonroundtrip++;
    stats.nonroundtrip_by_category[category]++;
    pushSample(samples.nonroundtrip, sampleLimit, {
      task_id: row.task_id, seq: row.seq, column, category,
      stored: excerpt(stored, firstDifference(stored, stringified)),
      rendered: excerpt(stringified, firstDifference(stored, stringified)),
    });
  }
  if (stored.includes("\\u0000") && containsNul(value)) {
    stats.nul_escape_rows++;
    if (column === "meta") {
      pushSample(samples.meta_nul_escape, sampleLimit, {
        task_id: row.task_id, seq: row.seq, excerpt: excerpt(stored, stored.indexOf("\\u0000")),
      });
    }
  }
  return value;
}

function firstDifference(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return limit;
}

// ───────────────────────────── rendering ─────────────────────────────

export interface TraceHeaderDerivation {
  header: TraceFileHeader;
  providerFrom: "runtime" | "task" | "agent" | "unknown";
  startedAtFrom: "started_at" | "dispatched_at" | "created_at" | "missing";
}

/**
 * The header a live writer would have written for this task.
 *
 * `session_id` is the Remi session the trace belongs to — the Issue session,
 * else the Chat Session, else the task itself (a one-shot task is its own
 * subject root).
 */
export function deriveTraceHeader(task: TraceBackfillTaskInfo): TraceHeaderDerivation {
  const sessionId = [task.issueSessionId, task.chatSessionId, task.id].find(nonEmpty)!;
  const provider: Array<[TraceHeaderDerivation["providerFrom"], string | null]> = [
    ["runtime", task.runtimeProvider], ["task", task.taskProvider], ["agent", task.agentProvider],
  ];
  const providerHit = provider.find(([, value]) => nonEmpty(value));
  const started: Array<[TraceHeaderDerivation["startedAtFrom"], string | null]> = [
    ["started_at", task.startedAt], ["dispatched_at", task.dispatchedAt], ["created_at", task.createdAt],
  ];
  const startedHit = started.find(([, value]) => nonEmpty(value));
  return {
    header: {
      format: TRACE_FILE_FORMAT,
      task_id: task.id,
      session_id: sessionId,
      agent_id: task.agentId,
      provider: providerHit?.[1] ?? "unknown",
      started_at: startedHit?.[1] ?? "",
    },
    providerFrom: providerHit?.[0] ?? "unknown",
    startedAtFrom: startedHit?.[0] ?? "missing",
  };
}

export interface TraceEndDerivation {
  status: TraceEndStatus;
  endedAt: string;
  endedAtFrom: "status_timestamp" | "other_terminal_timestamp" | "updated_at" | "missing";
}

/** How a terminal task ended: its status and the timestamp that status recorded. */
export function deriveTraceEnd(task: TraceBackfillTaskInfo): TraceEndDerivation | null {
  if (!isTerminalTaskStatus(task.status)) return null;
  const own = task.status === "completed" ? task.completedAt
    : task.status === "failed" ? task.failedAt
      : task.cancelledAt;
  if (nonEmpty(own)) return { status: task.status, endedAt: own, endedAtFrom: "status_timestamp" };
  const other = [task.completedAt, task.failedAt, task.cancelledAt].find(nonEmpty);
  if (other) return { status: task.status, endedAt: other, endedAtFrom: "other_terminal_timestamp" };
  if (nonEmpty(task.updatedAt)) return { status: task.status, endedAt: task.updatedAt, endedAtFrom: "updated_at" };
  return { status: task.status, endedAt: "", endedAtFrom: "missing" };
}

/** One event in the live writer's key order, from the stored row. */
export function traceEventFromRow(
  row: TraceBackfillSourceRow,
  input: unknown = parseStoredTraceJson(row.input),
  meta: unknown = parseStoredTraceJson(row.meta),
): Record<(typeof TRACE_EVENT_KEYS)[number], unknown> {
  return {
    ts: row.created_at,
    type: row.type,
    tool: row.tool,
    content: row.content,
    input,
    output: row.output,
    tool_call_id: row.tool_call_id,
    status: row.status,
    meta,
    seq: row.seq,
  };
}

export function traceHeaderLine(header: TraceFileHeader): string {
  return `${JSON.stringify(header)}\n`;
}

export function traceTrailerLine(trailer: TraceFileTrailer): string {
  return `${JSON.stringify(trailer)}\n`;
}

// ───────────────────────────── source reads ─────────────────────────────

const ROW_COLUMNS = "task_id, seq, type, tool, content, input, output, tool_call_id, status, meta, created_at";
const SIZED_COLUMNS = ["type", "tool", "content", "input", "output", "tool_call_id", "status", "meta", "created_at"];

function rowBytesExpression(db: SqlDatabase): string {
  return SIZED_COLUMNS.map((column) => db.dialect === "postgres"
    ? `COALESCE(OCTET_LENGTH(${column}), 0)`
    : `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`).join(" + ");
}

function hydrateSourceRow(raw: Record<string, unknown>): TraceBackfillSourceRow {
  return {
    task_id: String(raw.task_id),
    seq: Number(raw.seq),
    type: text(raw.type) ?? "",
    tool: text(raw.tool),
    content: text(raw.content),
    input: text(raw.input),
    output: text(raw.output),
    tool_call_id: text(raw.tool_call_id),
    status: text(raw.status),
    meta: text(raw.meta),
    created_at: text(raw.created_at) ?? "",
  };
}

/**
 * Every stored row of one task in seq order.
 *
 * Keyset batches of {@link TRACE_BACKFILL_BATCH_ROWS} over `(task_id, seq)`. A
 * batch is first probed for row sizes and then fetched in sub-ranges of at most
 * `chunkBytes`, so a batch of large rows never has to fit the Postgres bridge's
 * result buffer at once. A single row larger than `chunkBytes` is fetched alone.
 */
export function* iterateTaskRows(
  db: SqlDatabase,
  taskId: string,
  options: { batchRows?: number; chunkBytes?: number } = {},
): Generator<TraceBackfillSourceRow[]> {
  const batchRows = options.batchRows ?? TRACE_BACKFILL_BATCH_ROWS;
  const chunkBytes = options.chunkBytes ?? TRACE_BACKFILL_DEFAULT_CHUNK_BYTES;
  const sizes = rowBytesExpression(db);
  let after: number | null = null;
  for (;;) {
    const probe = (after === null
      ? db.query(
        `SELECT seq, ${sizes} AS bytes FROM multiremi_task_messages
         WHERE task_id = ? ORDER BY task_id, seq LIMIT ${batchRows}`,
      ).all(taskId)
      : db.query(
        `SELECT seq, ${sizes} AS bytes FROM multiremi_task_messages
         WHERE task_id = ? AND seq > ? ORDER BY task_id, seq LIMIT ${batchRows}`,
      ).all(taskId, after)) as Array<{ seq: unknown; bytes: unknown }>;
    if (probe.length === 0) return;
    let rangeStart = after;
    let rangeBytes = 0;
    let previous: number | null = null;
    for (const entry of probe) {
      const seq = Number(entry.seq);
      const bytes = Number(entry.bytes) || 0;
      if (rangeBytes > 0 && rangeBytes + bytes > chunkBytes) {
        yield fetchRange(db, taskId, rangeStart, previous!);
        rangeStart = previous;
        rangeBytes = 0;
      }
      rangeBytes += bytes;
      previous = seq;
    }
    yield fetchRange(db, taskId, rangeStart, previous!);
    after = previous;
    if (probe.length < batchRows) return;
  }
}

function fetchRange(db: SqlDatabase, taskId: string, after: number | null, through: number): TraceBackfillSourceRow[] {
  const rows = (after === null
    ? db.query(
      `SELECT ${ROW_COLUMNS} FROM multiremi_task_messages
       WHERE task_id = ? AND seq <= ? ORDER BY task_id, seq`,
    ).all(taskId, through)
    : db.query(
      `SELECT ${ROW_COLUMNS} FROM multiremi_task_messages
       WHERE task_id = ? AND seq > ? AND seq <= ? ORDER BY task_id, seq`,
    ).all(taskId, after, through)) as Array<Record<string, unknown>>;
  return rows.map(hydrateSourceRow);
}

function hydrateTask(raw: Record<string, unknown>): TraceBackfillTaskInfo {
  return {
    id: String(raw.id),
    workspaceId: text(raw.workspace_id) ?? "local",
    agentId: text(raw.agent_id) ?? "",
    status: text(raw.status) ?? "",
    taskProvider: text(raw.task_provider),
    runtimeId: text(raw.runtime_id),
    issueId: text(raw.issue_id),
    issueSessionId: text(raw.issue_session_id),
    chatSessionId: text(raw.chat_session_id),
    createdAt: text(raw.created_at),
    updatedAt: text(raw.updated_at),
    dispatchedAt: text(raw.dispatched_at),
    startedAt: text(raw.started_at),
    completedAt: text(raw.completed_at),
    failedAt: text(raw.failed_at),
    cancelledAt: text(raw.cancelled_at),
    runtimeExists: raw.runtime_row_id != null,
    runtimeProvider: text(raw.runtime_provider),
    runtimeDaemonId: text(raw.runtime_daemon_id),
    agentProvider: text(raw.agent_provider),
    issueExists: raw.issue_row_id != null,
    issueWorkspaceId: text(raw.issue_workspace_id),
    issueLifecycle: text(raw.issue_lifecycle),
    chatExists: raw.chat_row_id != null,
    chatWorkspaceId: text(raw.chat_workspace_id),
    traceLocation: text(raw.trace_location),
    traceArchiveId: text(raw.trace_archive_id),
    traceSource: text(raw.trace_source),
    traceEventCount: num(raw.trace_event_count),
    traceHeadSeq: num(raw.trace_head_seq),
  };
}

/** Every task with the joins the grouping and the header need, paged by id. */
export function loadTraceBackfillTasks(db: SqlDatabase): Map<string, TraceBackfillTaskInfo> {
  const tasks = new Map<string, TraceBackfillTaskInfo>();
  let after = "";
  for (;;) {
    const page = db.query(
      `SELECT t.id, t.workspace_id, t.agent_id, t.status, t.provider AS task_provider, t.runtime_id,
              t.issue_id, t.issue_session_id, t.chat_session_id,
              t.created_at, t.updated_at, t.dispatched_at, t.started_at,
              t.completed_at, t.failed_at, t.cancelled_at,
              r.id AS runtime_row_id, r.provider AS runtime_provider, r.daemon_id AS runtime_daemon_id,
              a.provider AS agent_provider,
              i.id AS issue_row_id, i.workspace_id AS issue_workspace_id, i.lifecycle_state AS issue_lifecycle,
              c.id AS chat_row_id, c.workspace_id AS chat_workspace_id,
              tt.location AS trace_location, tt.archive_id AS trace_archive_id, tt.source AS trace_source,
              tt.event_count AS trace_event_count, tt.head_seq AS trace_head_seq
       FROM multiremi_tasks t
       LEFT JOIN multiremi_runtimes r ON r.id = t.runtime_id
       LEFT JOIN multiremi_agents a ON a.id = t.agent_id
       LEFT JOIN multiremi_issues i ON i.id = t.issue_id
       LEFT JOIN multiremi_chat_sessions c ON c.id = t.chat_session_id
       LEFT JOIN multiremi_task_traces tt ON tt.task_id = t.id
       WHERE t.id > ? ORDER BY t.id LIMIT ${PAGE_ROWS}`,
    ).all(after) as Array<Record<string, unknown>>;
    for (const raw of page) tasks.set(String(raw.id), hydrateTask(raw));
    if (page.length < PAGE_ROWS) return tasks;
    after = String(page.at(-1)!.id);
  }
}

/** Row count and largest seq per task id in the old table, orphans included. */
export function loadTraceRowStats(db: SqlDatabase): Map<string, { rows: number; maxSeq: number }> {
  const stats = new Map<string, { rows: number; maxSeq: number }>();
  let after = "";
  for (;;) {
    const page = db.query(
      `SELECT task_id, COUNT(*) AS row_count, MAX(seq) AS max_seq
       FROM multiremi_task_messages WHERE task_id > ?
       GROUP BY task_id ORDER BY task_id LIMIT ${PAGE_ROWS}`,
    ).all(after) as Array<{ task_id: unknown; row_count: unknown; max_seq: unknown }>;
    for (const raw of page) stats.set(String(raw.task_id), { rows: Number(raw.row_count), maxSeq: Number(raw.max_seq) });
    if (page.length < PAGE_ROWS) return stats;
    after = String(page.at(-1)!.task_id);
  }
}

interface ArchiveFacts {
  /** Issues with a non-backfill archive that is ready or still on its way. */
  issuesWithArchive: Set<string>;
  /** Tasks that are a trace member of some ready archive, per its manifest. */
  tasksWithArchiveMember: Set<string>;
}

function loadArchiveFacts(db: SqlDatabase): ArchiveFacts {
  const facts: ArchiveFacts = { issuesWithArchive: new Set(), tasksWithArchiveMember: new Set() };
  let after = "";
  for (;;) {
    const page = db.query(
      `SELECT id, subject_kind, subject_id, issue_id, status, metadata
       FROM multiremi_session_archives WHERE id > ? ORDER BY id LIMIT ${ARCHIVE_PAGE_ROWS}`,
    ).all(after) as Array<Record<string, unknown>>;
    for (const raw of page) {
      const kind = text(raw.subject_kind) || "issue";
      const subjectId = text(raw.subject_id) || text(raw.issue_id) || "";
      const status = text(raw.status) ?? "";
      let metadata: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text(raw.metadata) ?? "{}") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch {
        // An unreadable metadata blob names no members.
      }
      const backfill = metadata.kind === TRACE_BACKFILL_METADATA_KIND;
      if (kind === "issue" && !backfill && (status === "ready" || status === "pending" || status === "uploading")) {
        facts.issuesWithArchive.add(subjectId);
      }
      if (status === "ready" && Array.isArray(metadata.files)) {
        for (const file of metadata.files as Array<{ path?: unknown }>) {
          const path = typeof file?.path === "string" ? file.path : "";
          const match = /^traces\/(.+)\.jsonl$/.exec(path);
          if (match) facts.tasksWithArchiveMember.add(match[1]!);
        }
      }
    }
    if (page.length < ARCHIVE_PAGE_ROWS) return facts;
    after = String(page.at(-1)!.id);
  }
}

// ───────────────────────────── assignment ─────────────────────────────

type SubjectRef =
  | { ok: true; kind: TraceBackfillSubjectKind; id: string; workspaceId: string; chatMissing: boolean }
  | { ok: false; skip: "issue_missing" | "issue_deleting" | "workspace_mismatch" };

/**
 * The subject a task's trace belongs to. An Issue groups every task of the
 * Issue across its sessions; a task in an existing Chat Session belongs to that
 * Chat; anything else — including a task whose Chat Session row is gone — is a
 * one-shot Task subject of its own.
 */
function subjectOf(task: TraceBackfillTaskInfo): SubjectRef {
  if (task.issueId != null) {
    if (!task.issueExists) return { ok: false, skip: "issue_missing" };
    if ((task.issueLifecycle ?? "active") !== "active") return { ok: false, skip: "issue_deleting" };
    if ((task.issueWorkspaceId ?? "local") !== task.workspaceId) return { ok: false, skip: "workspace_mismatch" };
    return { ok: true, kind: "issue", id: task.issueId, workspaceId: task.workspaceId, chatMissing: false };
  }
  if (task.chatSessionId != null && task.chatExists) {
    if ((task.chatWorkspaceId ?? "local") !== task.workspaceId) return { ok: false, skip: "workspace_mismatch" };
    return { ok: true, kind: "chat", id: task.chatSessionId, workspaceId: task.workspaceId, chatMissing: false };
  }
  return { ok: true, kind: "task", id: task.id, workspaceId: task.workspaceId, chatMissing: task.chatSessionId != null };
}

export interface TraceBackfillAssignedSubject {
  kind: TraceBackfillSubjectKind;
  id: string;
  group: TraceBackfillGroup;
  workspaceId: string;
  /** Every task of the subject, whatever it contributes. */
  members: TraceBackfillTaskInfo[];
  /** Terminal tasks with rows, by id: each becomes `traces/<task_id>.jsonl`. */
  renderTaskIds: string[];
  /** Tasks with no rows that meet all five conditions, by id. */
  noneTaskIds: string[];
  /** Rendered tasks that are cross-switch, by id. */
  crossSwitchTaskIds: string[];
  runtimeId: string;
  daemonId: string;
}

export interface TraceBackfillAssignment {
  tasks: Map<string, TraceBackfillTaskInfo>;
  rowStats: Map<string, { rows: number; maxSeq: number }>;
  /** Subjects that write something, in execution order. */
  subjects: TraceBackfillAssignedSubject[];
  /** Subject of every rendered or `none` task. */
  subjectOfTask: Map<string, TraceBackfillAssignedSubject>;
  source: TraceBackfillPlanReport["source"];
  none: TraceBackfillPlanReport["none"];
  crossSwitch: Omit<TraceBackfillPlanReport["cross_switch"], "ack">;
  archiveRuntimeMissing: number;
  archiveDaemonMissing: number;
  stops: Array<{ code: string; sample: unknown }>;
}

/**
 * Why a terminal task with rows is cross-switch: its trace may continue on a
 * daemon, whose seq restarts where the old table's does not. With no cutoff the
 * ended-at conditions cannot be evaluated and only the pointer counts.
 */
function crossSwitchReasons(task: TraceBackfillTaskInfo, cutoffMs: number | null): TraceBackfillCrossSwitchReason[] {
  const reasons: TraceBackfillCrossSwitchReason[] = [];
  if (cutoffMs != null) {
    const endedMs = Date.parse(deriveTraceEnd(task)?.endedAt ?? "");
    if (!Number.isFinite(endedMs)) reasons.push("ended_at_unknown");
    else if (endedMs >= cutoffMs) reasons.push("ended_at_or_after_cutoff");
  }
  if (task.traceLocation === "archive" && (task.traceSource ?? "daemon") === "daemon") {
    reasons.push("daemon_archive_pointer");
  }
  return reasons;
}

/**
 * Decide, without reading a single message row, which subject every task goes
 * to, which tasks are rendered and which get a `none` pointer.
 */
export function assignTraceBackfillSubjects(
  db: SqlDatabase,
  options: { oldTableStoppedAt?: string | null } = {},
): TraceBackfillAssignment {
  const cutoff = options.oldTableStoppedAt ?? null;
  const cutoffMs = cutoff == null ? null : Date.parse(cutoff);
  if (cutoff != null && !Number.isFinite(cutoffMs)) throw new Error(`invalid old-table stop moment: ${cutoff}`);
  const tasks = loadTraceBackfillTasks(db);
  const rowStats = loadTraceRowStats(db);
  const archives = loadArchiveFacts(db);
  const stops: TraceBackfillAssignment["stops"] = [];
  const source: TraceBackfillPlanReport["source"] = {
    rows: 0,
    tasks: tasks.size,
    tasks_with_rows: 0,
    orphan_tasks: 0,
    orphan_rows: 0,
    nonterminal_tasks_with_rows: 0,
    nonterminal_rows: 0,
    skipped: { issue_missing: { tasks: 0, rows: 0 }, issue_deleting: { tasks: 0, rows: 0 } },
    chat_missing_as_task: 0,
    tasks_with_existing_archive_pointer: 0,
    tasks_with_lost_pointer: 0,
  };
  const none: TraceBackfillPlanReport["none"] = {
    cutoff_evaluated: cutoffMs != null,
    eligible: 0,
    eligible_by_kind: { issue: 0, chat: 0, task: 0 },
    eligible_by_pointer: {},
    eligible_ignoring_cutoff: 0,
    ineligible: {},
  };
  const crossSwitch: TraceBackfillAssignment["crossSwitch"] = {
    cutoff_evaluated: cutoffMs != null,
    count: 0,
    by_reason: { ended_at_or_after_cutoff: 0, ended_at_unknown: 0, daemon_archive_pointer: 0 },
    task_ids: [],
  };
  for (const [taskId, stats] of rowStats) {
    source.rows += stats.rows;
    source.tasks_with_rows++;
    if (!tasks.has(taskId)) {
      source.orphan_tasks++;
      source.orphan_rows += stats.rows;
    }
  }

  const byKey = new Map<string, TraceBackfillAssignedSubject>();
  const subjectOfTask = new Map<string, TraceBackfillAssignedSubject>();
  for (const task of tasks.values()) {
    const stats = rowStats.get(task.id);
    const ref = subjectOf(task);
    if (!ref.ok) {
      if (ref.skip === "workspace_mismatch") {
        stops.push({
          code: "workspace_mismatch",
          sample: { task_id: task.id, issue_id: task.issueId, chat_session_id: task.chatSessionId },
        });
      } else {
        source.skipped[ref.skip].tasks++;
        source.skipped[ref.skip].rows += stats?.rows ?? 0;
      }
      continue;
    }
    if (ref.chatMissing) source.chat_missing_as_task++;
    const key = `${ref.kind}\u0000${ref.id}`;
    let subject = byKey.get(key);
    if (!subject) {
      subject = {
        kind: ref.kind,
        id: ref.id,
        group: ref.kind === "issue"
          ? archives.issuesWithArchive.has(ref.id) ? "issue_with_archive" : "issue_without_archive"
          : ref.kind,
        workspaceId: ref.workspaceId,
        members: [],
        renderTaskIds: [],
        noneTaskIds: [],
        crossSwitchTaskIds: [],
        runtimeId: "",
        daemonId: "",
      };
      byKey.set(key, subject);
    }
    subject.members.push(task);

    if (stats) {
      if (!isTerminalTaskStatus(task.status)) {
        source.nonterminal_tasks_with_rows++;
        source.nonterminal_rows += stats.rows;
        continue;
      }
      if (task.traceLocation === "archive") source.tasks_with_existing_archive_pointer++;
      if (task.traceLocation === "lost") source.tasks_with_lost_pointer++;
      subject.renderTaskIds.push(task.id);
      subjectOfTask.set(task.id, subject);
      const crossReasons = crossSwitchReasons(task, cutoffMs);
      if (crossReasons.length > 0) {
        subject.crossSwitchTaskIds.push(task.id);
        crossSwitch.task_ids.push(task.id);
        crossSwitch.count++;
        for (const reason of crossReasons) crossSwitch.by_reason[reason]++;
      }
      continue;
    }

    // No rows: a `none` pointer only when all five conditions hold.
    const reasons: string[] = [];
    const end = deriveTraceEnd(task);
    const endedMs = end ? Date.parse(end.endedAt) : NaN;
    if (!end) reasons.push("nonterminal");
    else if (!Number.isFinite(endedMs)) reasons.push("ended_at_invalid");
    if (archives.tasksWithArchiveMember.has(task.id) || task.traceLocation === "archive") reasons.push("archive_member");
    if ((task.traceEventCount ?? 0) > 0) reasons.push("positive_event_count");
    if (reasons.length === 0) none.eligible_ignoring_cutoff++;
    if (end && Number.isFinite(endedMs)) {
      if (cutoffMs == null) reasons.push("cutoff_unset");
      else if (!(endedMs < cutoffMs)) reasons.push("ended_after_cutoff");
    }
    if (reasons.length) {
      for (const reason of reasons) bump(none.ineligible, reason);
      continue;
    }
    subject.noneTaskIds.push(task.id);
    subjectOfTask.set(task.id, subject);
    none.eligible++;
    none.eligible_by_kind[ref.kind]++;
    bump(none.eligible_by_pointer, task.traceLocation ?? "absent");
  }

  let archiveRuntimeMissing = 0;
  let archiveDaemonMissing = 0;
  const subjects: TraceBackfillAssignedSubject[] = [];
  for (const subject of byKey.values()) {
    if (subject.renderTaskIds.length === 0 && subject.noneTaskIds.length === 0) continue;
    if (!SUBJECT_ID_PATTERN.test(subject.id)) {
      stops.push({ code: "unsafe_subject_id", sample: { kind: subject.kind, id: subject.id } });
    }
    subject.renderTaskIds.sort(compareText);
    subject.noneTaskIds.sort(compareText);
    subject.crossSwitchTaskIds.sort(compareText);
    // The archive records the Runtime of the subject's most recent task that still has one.
    const runtimeTask = subject.members
      .filter((task) => task.runtimeExists && nonEmpty(task.runtimeId))
      .sort((a, b) => compareText(b.createdAt ?? "", a.createdAt ?? "") || compareText(b.id, a.id))[0];
    subject.runtimeId = runtimeTask?.runtimeId ?? "";
    subject.daemonId = runtimeTask?.runtimeDaemonId ?? "";
    if (subject.renderTaskIds.length > 0) {
      if (!runtimeTask) archiveRuntimeMissing++;
      else if (!nonEmpty(runtimeTask.runtimeDaemonId)) archiveDaemonMissing++;
    }
    subjects.push(subject);
  }
  subjects.sort((a, b) =>
    TRACE_BACKFILL_GROUPS.indexOf(a.group) - TRACE_BACKFILL_GROUPS.indexOf(b.group)
    || compareText(a.id, b.id));
  crossSwitch.task_ids.sort(compareText);
  return {
    tasks,
    rowStats,
    subjects,
    subjectOfTask,
    source,
    none,
    crossSwitch,
    archiveRuntimeMissing,
    archiveDaemonMissing,
    stops,
  };
}

// ───────────────────────────── plan ─────────────────────────────

function scalarCount(db: SqlDatabase, sql: string, ...params: unknown[]): number {
  const row = db.query(sql).get(...params) as { n?: unknown } | null;
  return Number(row?.n ?? 0);
}

/** A rendered task: the header, digest and size the backfill will write. */
export interface TraceTaskRender {
  task: TraceBackfillPlannedTask;
  headerFrom: TraceHeaderDerivation;
  end: TraceEndDerivation;
}

/**
 * Render one task from its rows, streaming. `onLine` receives every line of the
 * file in order — header, events, trailer — each ending in `\n`; `onEvent`
 * receives each event object before it is serialized.
 */
export function renderTraceTask(
  db: SqlDatabase,
  task: TraceBackfillTaskInfo,
  options: {
    batchRows?: number;
    chunkBytes?: number;
    onLine?: (line: string) => void;
    onRow?: (row: TraceBackfillSourceRow) => { input: unknown; meta: unknown };
    onEvent?: (event: Record<(typeof TRACE_EVENT_KEYS)[number], unknown>) => void;
    onInvalidEvent?: (sample: unknown) => void;
  } = {},
): TraceTaskRender {
  const headerFrom = deriveTraceHeader(task);
  const end = deriveTraceEnd(task);
  if (!end) throw new Error(`task ${task.id} is not terminal`);
  const { header } = headerFrom;
  const digest = new TraceTaskDigest(header as unknown as Record<string, unknown>);
  const headerLine = traceHeaderLine(header);
  options.onLine?.(headerLine);
  let bytes = Buffer.byteLength(headerLine, "utf8");
  let rows = 0;
  let head = 0;
  let previousSeq = 0;
  for (const batch of iterateTaskRows(db, task.id, options)) {
    for (const row of batch) {
      rows++;
      const parsed = options.onRow?.(row);
      const event = parsed
        ? traceEventFromRow(row, parsed.input, parsed.meta)
        : traceEventFromRow(row);
      if (!isTraceFileEvent(event) || row.seq <= previousSeq) {
        options.onInvalidEvent?.({ task_id: task.id, seq: row.seq, ts: row.created_at, type: row.type });
      }
      previousSeq = Math.max(previousSeq, row.seq);
      head = Math.max(head, row.seq);
      options.onEvent?.(event);
      digest.line(traceEventDigest(event));
      const line = `${JSON.stringify(event)}\n`;
      bytes += Buffer.byteLength(line, "utf8");
      options.onLine?.(line);
    }
  }
  const trailer: TraceFileTrailer = { end: { status: end.status, head, event_count: rows, ended_at: end.endedAt } };
  const trailerLine = traceTrailerLine(trailer);
  bytes += Buffer.byteLength(trailerLine, "utf8");
  options.onLine?.(trailerLine);
  return {
    task: {
      taskId: task.id,
      header,
      trailer,
      rowCount: rows,
      headSeq: head,
      digest: digest.finish(trailer.end as unknown as Record<string, unknown>),
      bytes,
    },
    headerFrom,
    end,
  };
}

/**
 * Read the whole old table and decide, per subject, what the backfill writes.
 *
 * Every row is read — orphans and rows of tasks that will not be rendered
 * included — so the JSON counters cover the same rows as the SQL cross-checks.
 */
export function buildTraceBackfillPlan(db: SqlDatabase, options: TraceBackfillPlanOptions = {}): TraceBackfillPlan {
  const log = options.log ?? (() => {});
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const chunkBytes = options.chunkBytes ?? TRACE_BACKFILL_DEFAULT_CHUNK_BYTES;
  const batchRows = options.batchRows ?? TRACE_BACKFILL_BATCH_ROWS;
  const maxSourceBytes = options.maxSourceBytes ?? TRACE_BACKFILL_DEFAULT_MAX_SOURCE_BYTES;
  const cutoff = options.oldTableStoppedAt ?? null;

  const assignment = assignTraceBackfillSubjects(db, { oldTableStoppedAt: cutoff });
  const { tasks, rowStats } = assignment;
  log(`plan: ${tasks.size} tasks, ${rowStats.size} task ids with rows, ${assignment.subjects.length} subjects`);

  const input = emptyColumnStats();
  const meta = emptyColumnStats();
  const samples: JsonSamples = { nonroundtrip: [], unexplained: [], meta_nul_escape: [], truncated_meta: [] };
  const stopSamples = new Map<string, unknown[]>();
  const stopCounts = new Map<string, number>();
  const stop = (code: string, sample?: unknown) => {
    stopCounts.set(code, (stopCounts.get(code) ?? 0) + 1);
    if (sample !== undefined) {
      const list = stopSamples.get(code) ?? [];
      pushSample(list, sampleLimit, sample);
      stopSamples.set(code, list);
    }
  };
  for (const entry of assignment.stops) stop(entry.code, entry.sample);

  const report: TraceBackfillPlanReport = {
    generated_at: (options.now?.() ?? new Date()).toISOString(),
    dialect: db.dialect ?? "unknown",
    old_table_stopped_at: cutoff,
    params: { batch_rows: batchRows, chunk_bytes: chunkBytes, max_source_bytes: maxSourceBytes },
    source: assignment.source,
    groups: Object.fromEntries(TRACE_BACKFILL_GROUPS.map((group) => [group, {
      subjects: 0, traced_tasks: 0, rows: 0, none_tasks: 0, bytes: 0,
    }])) as TraceBackfillPlanReport["groups"],
    subjects: 0,
    traced_tasks: 0,
    traced_rows: 0,
    largest_subject_bytes: 0,
    archive_runtime_missing: assignment.archiveRuntimeMissing,
    archive_daemon_missing: assignment.archiveDaemonMissing,
    header: {
      provider_from: { runtime: 0, task: 0, agent: 0, unknown: 0 },
      started_at_from: { started_at: 0, dispatched_at: 0, created_at: 0, missing: 0 },
      ended_at_from: { status_timestamp: 0, other_terminal_timestamp: 0, updated_at: 0, missing: 0 },
    },
    none: assignment.none,
    cross_switch: { ...assignment.crossSwitch, ack: options.crossSwitchAck ?? null },
    json: {
      json_unparseable_input: 0,
      json_unparseable_meta: 0,
      json_unparseable_unexplained: 0,
      json_nonroundtrip: 0,
      json_nonroundtrip_by_category: emptyCategories(),
      json_non_object_input: 0,
      json_non_object_meta: 0,
      sql_truncated_input: 0,
      sql_truncated_meta: 0,
      input,
      meta,
      samples,
    },
    stops: [],
  };

  // Every row, in task order. Orphans and rows that are not rendered still count.
  const analyze = (row: TraceBackfillSourceRow) => ({
    input: analyzeJsonColumn("input", row.input, row, input, samples, sampleLimit),
    meta: analyzeJsonColumn("meta", row.meta, row, meta, samples, sampleLimit),
  });
  const rendered = new Map<string, TraceBackfillPlannedTask>();
  let scannedRows = 0;
  for (const taskId of [...rowStats.keys()].sort(compareText)) {
    const subject = assignment.subjectOfTask.get(taskId);
    const task = tasks.get(taskId);
    if (!subject || !task) {
      for (const batch of iterateTaskRows(db, taskId, { batchRows, chunkBytes })) {
        for (const row of batch) {
          scannedRows++;
          analyze(row);
        }
      }
      continue;
    }
    if (UNSAFE_TASK_ID.test(taskId) || taskId === "." || taskId === "..") stop("unsafe_task_id", { task_id: taskId });
    const render = renderTraceTask(db, task, {
      batchRows,
      chunkBytes,
      onRow: (row) => {
        scannedRows++;
        return analyze(row);
      },
      onInvalidEvent: (sample) => stop("invalid_event", sample),
    });
    const headerCheck = checkTraceFileLines([JSON.stringify(render.task.header)], {
      taskId, sessionId: render.task.header.session_id,
    });
    if (!headerCheck.ok) stop("invalid_header", { task_id: taskId, reason: headerCheck.reason, header: render.task.header });
    if (!isTraceFileTrailer(render.task.trailer)) stop("invalid_trailer", { task_id: taskId, trailer: render.task.trailer });
    report.header.provider_from[render.headerFrom.providerFrom]++;
    report.header.started_at_from[render.headerFrom.startedAtFrom]++;
    report.header.ended_at_from[render.end.endedAtFrom]++;
    rendered.set(taskId, render.task);
  }

  // SQL cross-checks for the JSON counters and the row total.
  const marker = `%${TRACE_TRUNCATION_MARKER}`;
  report.json.sql_truncated_input = scalarCount(
    db, "SELECT COUNT(*) AS n FROM multiremi_task_messages WHERE input IS NOT NULL AND input LIKE ?", marker,
  );
  report.json.sql_truncated_meta = scalarCount(
    db, "SELECT COUNT(*) AS n FROM multiremi_task_messages WHERE meta IS NOT NULL AND meta LIKE ?", marker,
  );
  const sqlRows = scalarCount(db, "SELECT COUNT(*) AS n FROM multiremi_task_messages");
  report.json.json_unparseable_input = input.unparseable_truncated;
  report.json.json_unparseable_meta = meta.unparseable_truncated;
  report.json.json_unparseable_unexplained = input.unparseable_unexplained + meta.unparseable_unexplained;
  report.json.json_nonroundtrip = input.nonroundtrip + meta.nonroundtrip;
  for (const category of Object.keys(report.json.json_nonroundtrip_by_category) as NonRoundtripCategory[]) {
    report.json.json_nonroundtrip_by_category[category] =
      input.nonroundtrip_by_category[category] + meta.nonroundtrip_by_category[category];
  }
  report.json.json_non_object_input = input.non_object;
  report.json.json_non_object_meta = meta.non_object;

  if (report.json.json_unparseable_unexplained > 0) {
    stopCounts.set("json_unparseable_unexplained", report.json.json_unparseable_unexplained);
    stopSamples.set("json_unparseable_unexplained", samples.unexplained);
  }
  if (report.json.json_unparseable_input !== report.json.sql_truncated_input) {
    stopCounts.set("json_unparseable_input_mismatch", 1);
    stopSamples.set("json_unparseable_input_mismatch", [{
      counted: report.json.json_unparseable_input, sql: report.json.sql_truncated_input,
    }]);
  }
  if (report.json.json_unparseable_meta !== report.json.sql_truncated_meta) {
    stopCounts.set("json_unparseable_meta_mismatch", 1);
    stopSamples.set("json_unparseable_meta_mismatch", [{
      counted: report.json.json_unparseable_meta, sql: report.json.sql_truncated_meta,
    }]);
  }
  for (const category of NONROUNDTRIP_STOP_CATEGORIES) {
    const count = report.json.json_nonroundtrip_by_category[category];
    if (count > 0) {
      stopCounts.set(`json_nonroundtrip_${category}`, count);
      stopSamples.set(
        `json_nonroundtrip_${category}`,
        samples.nonroundtrip.filter((sample) => (sample as { category: string }).category === category),
      );
    }
  }
  if (sqlRows !== scannedRows || sqlRows !== report.source.rows) {
    stopCounts.set("row_count_changed_during_plan", 1);
    stopSamples.set("row_count_changed_during_plan", [{
      grouped: report.source.rows, scanned: scannedRows, sql: sqlRows,
    }]);
  }

  // Subjects in execution order.
  const subjects: TraceBackfillPlannedSubject[] = [];
  for (const assigned of assignment.subjects) {
    const plannedTasks = assigned.renderTaskIds.map((taskId) => rendered.get(taskId)!);
    const rowCount = plannedTasks.reduce((sum, task) => sum + task.rowCount, 0);
    const bytes = plannedTasks.reduce((sum, task) => sum + task.bytes, 0);
    if (bytes > maxSourceBytes) stop("subject_source_too_large", { kind: assigned.kind, id: assigned.id, bytes });
    subjects.push({
      kind: assigned.kind,
      id: assigned.id,
      group: assigned.group,
      workspaceId: assigned.workspaceId,
      runtimeId: assigned.runtimeId,
      daemonId: assigned.daemonId,
      tasks: plannedTasks,
      noneTaskIds: assigned.noneTaskIds,
      crossSwitchTaskIds: assigned.crossSwitchTaskIds,
      rowCount,
      bytes,
      digest: traceSubjectDigest(
        assigned.kind, assigned.id, plannedTasks, assigned.noneTaskIds, assigned.crossSwitchTaskIds,
      ),
    });
    const groupReport = report.groups[assigned.group];
    groupReport.subjects++;
    groupReport.traced_tasks += plannedTasks.length;
    groupReport.rows += rowCount;
    groupReport.none_tasks += assigned.noneTaskIds.length;
    groupReport.bytes += bytes;
    report.traced_tasks += plannedTasks.length;
    report.traced_rows += rowCount;
    report.largest_subject_bytes = Math.max(report.largest_subject_bytes, bytes);
  }
  report.subjects = subjects.length;

  const crossSwitch = report.cross_switch;
  if (crossSwitch.ack == null ? crossSwitch.count > 0 : crossSwitch.ack !== crossSwitch.count) {
    stopCounts.set("cross_switch_tasks", crossSwitch.count);
    stopSamples.set("cross_switch_tasks", crossSwitch.task_ids.slice(0, sampleLimit));
  }

  const stops: TraceBackfillStop[] = [...stopCounts.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([code, count]) => ({
      code,
      count,
      ...(code === "cross_switch_tasks"
        ? {
          detail: `${count} cross-switch task(s)${crossSwitch.ack == null ? "" : `, acknowledged ${crossSwitch.ack}`}; `
            + `review report.cross_switch and rerun with --cross-switch-ack=${count}`,
        }
        : {}),
      ...(stopSamples.has(code) ? { samples: stopSamples.get(code) } : {}),
    }));
  report.stops = stops;
  log(`plan: ${report.traced_tasks} traced tasks, ${report.none.eligible} none, ${stops.length} stop codes`);
  return { subjects, tasks, report, stops };
}
