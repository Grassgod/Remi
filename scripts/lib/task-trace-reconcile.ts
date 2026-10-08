/**
 * Read-only reconciliation of the task_messages trace backfill (MUL-432).
 *
 * For every checked task the archive member is read back and compared with the
 * rows it came from, in lockstep: the same seq set, the same content per line
 * (strings exactly, `input`/`meta` as canonical JSON after
 * `parseStoredTraceJson`, so a `null` source must read back as `null`), a
 * trailer whose `event_count` is the row count, and an index entry and pointer
 * that agree. `head` is the largest seq, which is not the event count when seq
 * has gaps, so the two are never compared with each other. Each task's `turn`
 * card, when it has one, must carry the event count, tool call count,
 * `(type, tool)` histogram and model its rows produce.
 *
 * The pointer is judged by its source, never by comparing heads (MUL-432 P1):
 * a backfill pointer must name the subject's latest backfill archive, and that
 * is the member compared; a daemon archive may own only a task acknowledged as
 * cross-switch, whose backfill member is still compared as a prefix backup and
 * whose card is left to the daemon.
 *
 * A daemon-owned pointer is what readers follow, so it is checked on its own
 * (MUL-432 QA round 2, M1): its archive is ready, the member it names is in
 * that archive's index exactly as the pointer records it, and
 * `TraceReader.readTrace` pages through it to the end. Its events count on the
 * daemon's seq axis, so they are never compared with the old rows.
 *
 * Nothing here writes: raw SELECTs only, no `MultiremiStore` (its constructor
 * migrates), archives opened read-only without following symlinks.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import type { MultiremiStore } from "../../packages/server/src/store/store.js";
import type { DaemonTraceReader } from "../../packages/server/src/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "../../packages/server/src/session-archive/reader.js";
import { TRACE_READ_MAX_LIMIT, TraceReader } from "../../packages/server/src/trace/trace-reader.js";
import {
  parseSessionArchiveIndex,
  SESSION_ARCHIVE_INDEX_MEMBER,
  SESSION_ARCHIVE_TRACE_SUFFIX,
  SESSION_ARCHIVE_TRACES_PREFIX,
  splitTraceMemberLines,
  type SessionArchiveIndex,
  type MultiremiTaskTrace,
  type SessionArchiveMemberIndexEntry,
} from "../../packages/contracts/src/session-archive.js";
import { checkTraceFileLines, isTraceFileTrailer } from "../../packages/contracts/src/trace-file.js";
import { readZipCentralDirectory, readZipMember, readZipMemberBody, type ZipDirectoryEntry } from "../../packages/shared/src/zip/reader.js";
import {
  assignTraceBackfillSubjects,
  canonicalJson,
  deriveTraceEnd,
  deriveTraceHeader,
  iterateTaskRows,
  TRACE_BACKFILL_GROUPS,
  TRACE_BACKFILL_METADATA_KIND,
  TRACE_EVENT_KEYS,
  traceEventDigest,
  traceEventFromRow,
  traceSubjectDigest,
  TraceTaskDigest,
  type TraceBackfillAssignedSubject,
  type TraceBackfillAssignment,
  type TraceBackfillGroup,
} from "./task-trace-backfill.js";
import { sampleWithoutReplacement, seededRandom } from "./seeded-random.js";
import { emptyTraceTurnSummary, TraceTurnSummaryBuilder } from "./task-trace-turn-summary.js";
import {
  traceBackfillTurnCardDiff,
  type TraceBackfillTurnSummary,
} from "../../packages/server/src/store/repos/trace-backfill-progress-repo.js";
import type { ConversationLogTurnMetadata } from "../../packages/contracts/src/conversation-log.js";

export type TraceReconcileMismatch =
  | "seq_set"
  | "line_digest"
  | "event_count"
  | "header"
  | "trailer"
  | "index"
  | "pointer"
  | "pointer_owned_by_daemon_unexpected"
  /** A daemon-owned pointer disagrees with its archive: not ready, member absent, fields differ. */
  | "active_pointer"
  /** `TraceReader.readTrace` cannot page through the member a daemon-owned pointer names. */
  | "active_member_unreadable"
  | "member_missing"
  | "member_unreadable"
  | "archive_missing"
  | "progress"
  | "turn_card";

export const TRACE_RECONCILE_MISMATCHES: readonly TraceReconcileMismatch[] = [
  "seq_set", "line_digest", "event_count", "header", "trailer", "index", "pointer",
  "pointer_owned_by_daemon_unexpected", "active_pointer", "active_member_unreadable",
  "member_missing", "member_unreadable", "archive_missing", "progress", "turn_card",
];

export interface TraceReconcileOptions {
  archiveRoot: string;
  /** Needed to recompute which tasks got a `none` pointer; without it `none` is not checked. */
  oldTableStoppedAt?: string | null;
  /** Check only these tasks (sample mode). Subject-level digests are then not compared. */
  taskIds?: ReadonlySet<string> | null;
  /** Check only subjects in these groups. */
  groups?: readonly TraceBackfillGroup[] | null;
  assignment?: TraceBackfillAssignment;
  batchRows?: number;
  chunkBytes?: number;
  sampleLimit?: number;
}

export interface TraceReconcileReport {
  mode: "full" | "sample";
  groups: TraceBackfillGroup[] | "all";
  checked_subjects: number;
  checked_tasks: number;
  checked_rows: number;
  checked_none: number;
  /** Tasks whose `turn` card was compared with their rows. */
  checked_turn_cards: number;
  checked_by_group: Record<string, { tasks: number; none: number; rows: number }>;
  mismatches: Record<TraceReconcileMismatch, number>;
  mismatch_total: number;
  informational: Record<string, number>;
  samples: { mismatch: unknown[]; informational: unknown[] };
  ok: boolean;
}

/** What a trace member holds, reduced to the facts reconciliation compares. */
export interface TraceMemberFacts {
  header: Record<string, unknown> | null;
  trailer: { status?: unknown; head?: unknown; event_count?: unknown; ended_at?: unknown } | null;
  /** Event seqs in file order. */
  seqs: number[];
  /** Per-event digests in file order, same function as the source side. */
  lineDigests: string[];
  /** Digest over header, events and trailer, same function as the plan. */
  digest: string | null;
  /** Event lines whose keys are not exactly the writer's keys in its order. */
  badEventShapes: number;
  /** Whether the bytes end with a newline (no partial final line). */
  completeFinalLine: boolean;
  /** The B3 validator's verdict over the whole member. */
  check: ReturnType<typeof checkTraceFileLines>;
}

/** Parse a `traces/<task>.jsonl` member and digest it with the plan's functions. */
export function inspectTraceMember(bytes: Uint8Array, expected: { taskId: string; sessionId?: string }): TraceMemberFacts {
  const lines = splitTraceMemberLines(bytes);
  const completeFinalLine = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
  const check = checkTraceFileLines(lines, { taskId: expected.taskId, sessionId: expected.sessionId });
  const facts: TraceMemberFacts = {
    header: null,
    trailer: null,
    seqs: [],
    lineDigests: [],
    digest: null,
    badEventShapes: 0,
    completeFinalLine,
    check,
  };
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  });
  const first = parsed[0];
  if (first && typeof first === "object" && !Array.isArray(first) && !("seq" in first)) {
    facts.header = first as Record<string, unknown>;
  }
  const last = parsed.at(-1);
  const trailerIndex = parsed.length > 1 && isTraceFileTrailer(last) ? parsed.length - 1 : parsed.length;
  if (trailerIndex < parsed.length) facts.trailer = (last as { end: TraceMemberFacts["trailer"] }).end;
  const digest = facts.header ? new TraceTaskDigest(facts.header) : null;
  for (let index = facts.header ? 1 : 0; index < trailerIndex; index++) {
    const event = parsed[index];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      facts.badEventShapes++;
      continue;
    }
    const keys = Object.keys(event);
    if (keys.length !== TRACE_EVENT_KEYS.length || keys.some((key, i) => key !== TRACE_EVENT_KEYS[i])) {
      facts.badEventShapes++;
    }
    const record = event as Record<string, unknown>;
    facts.seqs.push(typeof record.seq === "number" ? record.seq : NaN);
    const lineDigest = traceEventDigest(record);
    facts.lineDigests.push(lineDigest);
    digest?.line(lineDigest);
  }
  if (digest && facts.trailer) facts.digest = digest.finish(facts.trailer as Record<string, unknown>);
  return facts;
}

interface OpenedArchive {
  handle: FileHandle;
  index: SessionArchiveIndex;
  directory: Map<string, ZipDirectoryEntry>;
}

/**
 * Open a v2 archive (a backfill's or a daemon's) read-only, refusing paths that
 * leave the root or end in a symlink.
 */
export async function openTraceBackfillArchive(root: string, relativePath: string): Promise<OpenedArchive> {
  const base = resolve(root);
  const path = resolve(base, relativePath);
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`archive path escapes the archive root: ${relativePath}`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const central = await readZipCentralDirectory(handle);
    const directory = new Map(central.entries.map((entry) => [entry.path, entry]));
    const indexEntry = directory.get(SESSION_ARCHIVE_INDEX_MEMBER);
    if (!indexEntry) throw new Error("archive has no index.json");
    const member = await readZipMember(handle, {
      localHeaderOffset: indexEntry.localHeaderOffset,
      compressedSize: indexEntry.compressedSize,
      uncompressedSize: indexEntry.uncompressedSize,
    });
    const index = parseSessionArchiveIndex(JSON.parse(member.bytes.toString("utf8")));
    if (!index) throw new Error("archive index.json does not parse");
    return { handle, index, directory };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

interface ProgressRow {
  status: string;
  digest: string;
  archive_id: string | null;
}

interface BackfillTaskRow {
  task_id: string;
  archive_id: string;
  row_count: number;
  head_seq: number;
  digest: string;
  /** Acknowledged as cross-switch when the backfill ran (`--cross-switch-ack`). */
  cross_switch: boolean;
}

interface PointerRow {
  location: string;
  /** Which writer produced an `archive` pointer; NULL on an archive pointer means daemon. */
  source: "daemon" | "trace_backfill" | null;
  archive_id: string | null;
  member_path: string | null;
  data_offset: number | null;
  compressed_size: number | null;
  uncompressed_size: number | null;
  sha256: string | null;
  event_count: number | null;
  head_seq: number | null;
  closed: boolean;
}

function readPointer(db: SqlDatabase, taskId: string): PointerRow | null {
  const raw = db.query(
    `SELECT location, source, archive_id, member_path, data_offset, compressed_size, uncompressed_size,
            sha256, event_count, head_seq, closed
     FROM multiremi_task_traces WHERE task_id = ?`,
  ).get(taskId) as Record<string, unknown> | null;
  if (!raw) return null;
  const n = (value: unknown) => (value == null ? null : Number(value));
  const location = String(raw.location);
  return {
    location,
    source: location !== "archive" ? null : raw.source === "trace_backfill" ? "trace_backfill" : "daemon",
    archive_id: raw.archive_id == null ? null : String(raw.archive_id),
    member_path: raw.member_path == null ? null : String(raw.member_path),
    data_offset: n(raw.data_offset),
    compressed_size: n(raw.compressed_size),
    uncompressed_size: n(raw.uncompressed_size),
    sha256: raw.sha256 == null ? null : String(raw.sha256),
    event_count: n(raw.event_count),
    head_seq: n(raw.head_seq),
    closed: raw.closed === true || Number(raw.closed) === 1,
  };
}

function readArchiveRow(db: SqlDatabase, archiveId: string) {
  const raw = db.query(
    `SELECT id, status, relative_path, metadata, subject_kind, subject_id, issue_id
     FROM multiremi_session_archives WHERE id = ?`,
  ).get(archiveId) as Record<string, unknown> | null;
  if (!raw) return null;
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(raw.metadata ?? "{}")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    // Treated as not a backfill archive below.
  }
  return {
    id: String(raw.id),
    status: String(raw.status),
    relativePath: String(raw.relative_path),
    metadata,
    subjectKind: String(raw.subject_kind || "issue"),
    subjectId: String(raw.subject_id || raw.issue_id || ""),
  };
}

/**
 * The default reconcile sample (MUL-432 QA round 1): 50 tasks from each of the
 * four groups, 200 in all, drawn with this seed. Both are fixed here so a
 * rerun on the same data checks the same tasks; both go in the report. A group
 * with fewer candidates than its 50 gives all of them and the shortfall is
 * drawn from the other groups (QA round 2, M2; see `selectTraceReconcileSample`).
 */
export const TRACE_RECONCILE_SAMPLE_QUOTAS: Readonly<Record<TraceBackfillGroup, number>> = {
  chat: 50,
  task: 50,
  issue_without_archive: 50,
  issue_with_archive: 50,
};
export const TRACE_RECONCILE_SAMPLE_SEED = "mul-432-reconcile-sample-v1";

export interface TraceReconcileSample {
  seed: string;
  requested: number;
  taskIds: Set<string>;
  /** Tasks drawn beyond their group's quota to make up other groups' shortfall. */
  refilled: number;
  /** Why fewer than `requested` tasks were drawn; null when the request was met. */
  note: string | null;
  by_group: Record<
    TraceBackfillGroup,
    {
      /** The group's share of the request: its configured quota, or its even split of `size`. */
      quota: number;
      candidates: number;
      sampled: number;
      /** `sampled` beyond `quota`, drawn for another group's shortfall. */
      refill: number;
      sampled_render: number;
      sampled_none: number;
    }
  >;
}

/**
 * A seeded random sample of backfilled tasks (rendered and `none`).
 *
 * Every group first takes its quota, or all its candidates when it has fewer.
 * The total shortfall is then handed out one task at a time, in the fixed
 * group order (chat, task, issue_without_archive, issue_with_archive), to the
 * groups that still have candidates, round after round, until the request is
 * met or no group has any left (QA round 2, M2). So the default request draws
 * 200 whenever there are 200 candidates, every group with candidates is
 * represented, and fewer than 200 means every candidate was taken; the report
 * then says so in `note`. With `size`, every group starts from zero and the
 * same loop hands out the whole size, which splits it evenly; its `quota` is
 * that even split. The counts depend only on the candidates, and the tasks
 * only on the counts and the seed: candidates are sorted and each group is
 * drawn in group order from one seeded generator, so the same seed over the
 * same data gives the same sample.
 */
export function selectTraceReconcileSample(
  assignment: TraceBackfillAssignment,
  options: { seed: string } & ({ quotas: Readonly<Record<TraceBackfillGroup, number>> } | { size: number }),
): TraceReconcileSample {
  const candidates = Object.fromEntries(TRACE_BACKFILL_GROUPS.map((group) => [group, [] as string[]])) as Record<
    TraceBackfillGroup,
    string[]
  >;
  const noneIds = new Set<string>();
  for (const subject of assignment.subjects) {
    candidates[subject.group].push(...subject.renderTaskIds, ...subject.noneTaskIds);
    for (const taskId of subject.noneTaskIds) noneIds.add(taskId);
  }
  // Sorted, so the same seed picks the same tasks whatever order the database returned.
  for (const group of TRACE_BACKFILL_GROUPS) candidates[group].sort();

  const zero = () => Object.fromEntries(TRACE_BACKFILL_GROUPS.map((group) => [group, 0])) as Record<TraceBackfillGroup, number>;
  // Each group's share of the request, before any shortfall moves.
  const share = zero();
  if ("quotas" in options) {
    for (const group of TRACE_BACKFILL_GROUPS) share[group] = options.quotas[group];
  } else {
    TRACE_BACKFILL_GROUPS.forEach((group, i) => {
      share[group] = Math.floor(options.size / TRACE_BACKFILL_GROUPS.length)
        + (i < options.size % TRACE_BACKFILL_GROUPS.length ? 1 : 0);
    });
  }
  const requested = TRACE_BACKFILL_GROUPS.reduce((sum, group) => sum + share[group], 0);
  // How many each group gives: its quota up to its candidates, then the rest of
  // the request one at a time in group order to groups that still have some.
  const take = zero();
  if ("quotas" in options) {
    for (const group of TRACE_BACKFILL_GROUPS) take[group] = Math.min(share[group], candidates[group].length);
  }
  let remaining = requested - TRACE_BACKFILL_GROUPS.reduce((sum, group) => sum + take[group], 0);
  while (remaining > 0) {
    const open = TRACE_BACKFILL_GROUPS.filter((group) => take[group] < candidates[group].length);
    if (open.length === 0) break;
    for (const group of open) {
      if (remaining === 0) break;
      take[group]++;
      remaining--;
    }
  }

  const random = seededRandom(options.seed);
  const taskIds = new Set<string>();
  const byGroup = {} as TraceReconcileSample["by_group"];
  let refilled = 0;
  for (const group of TRACE_BACKFILL_GROUPS) {
    const picked = sampleWithoutReplacement(random, candidates[group], take[group]);
    for (const taskId of picked) taskIds.add(taskId);
    const none = picked.filter((taskId) => noneIds.has(taskId)).length;
    const refill = Math.max(0, picked.length - share[group]);
    refilled += refill;
    byGroup[group] = {
      quota: share[group],
      candidates: candidates[group].length,
      sampled: picked.length,
      refill,
      sampled_render: picked.length - none,
      sampled_none: none,
    };
  }
  const note = taskIds.size < requested
    ? `all ${taskIds.size} candidates taken: the groups hold fewer than the ${requested} requested`
    : null;
  return { seed: options.seed, requested, taskIds, refilled, note, by_group: byGroup };
}

function sameSeqSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((value, i) => value === b[i]);
}

/**
 * Compare what the backfill wrote with the rows it came from.
 *
 * Full mode checks every rendered and `none` task and every subject digest.
 * Sample mode checks the given tasks only.
 */
export async function reconcileTraceBackfill(
  db: SqlDatabase,
  options: TraceReconcileOptions,
): Promise<TraceReconcileReport> {
  const sampleLimit = options.sampleLimit ?? 20;
  const assignment = options.assignment
    ?? assignTraceBackfillSubjects(db, { oldTableStoppedAt: options.oldTableStoppedAt ?? null });
  const sample = options.taskIds ?? null;
  const groupFilter = options.groups ? new Set(options.groups) : null;
  const report: TraceReconcileReport = {
    mode: sample ? "sample" : "full",
    groups: options.groups ? [...options.groups] : "all",
    checked_subjects: 0,
    checked_tasks: 0,
    checked_rows: 0,
    checked_none: 0,
    checked_turn_cards: 0,
    checked_by_group: {},
    mismatches: Object.fromEntries(TRACE_RECONCILE_MISMATCHES.map((key) => [key, 0])) as Record<TraceReconcileMismatch, number>,
    mismatch_total: 0,
    informational: {
      orphan_tasks: assignment.source.orphan_tasks,
      orphan_rows: assignment.source.orphan_rows,
      nonterminal_tasks_with_rows: assignment.source.nonterminal_tasks_with_rows,
      nonterminal_rows: assignment.source.nonterminal_rows,
      skipped_issue_missing_tasks: assignment.source.skipped.issue_missing.tasks,
      skipped_issue_missing_rows: assignment.source.skipped.issue_missing.rows,
      skipped_issue_deleting_tasks: assignment.source.skipped.issue_deleting.tasks,
      skipped_issue_deleting_rows: assignment.source.skipped.issue_deleting.rows,
      none_unchecked_without_cutoff: 0,
      none_kept_existing_location: 0,
      cross_switch_daemon_owned: 0,
      pointer_kept_lost: 0,
      turn_card_missing: 0,
      turn_card_skipped_cross_switch: 0,
    },
    samples: { mismatch: [], informational: [] },
    ok: true,
  };
  const mismatch = (category: TraceReconcileMismatch, detail: Record<string, unknown>) => {
    report.mismatches[category]++;
    report.mismatch_total++;
    if (report.samples.mismatch.length < sampleLimit) report.samples.mismatch.push({ category, ...detail });
  };
  const info = (key: string, detail: Record<string, unknown>) => {
    report.informational[key] = (report.informational[key] ?? 0) + 1;
    if (report.samples.informational.length < sampleLimit) report.samples.informational.push({ key, ...detail });
  };
  // Without the stop moment no task qualifies for `none`, so neither those
  // pointers nor the subject digests (which cover them) can be compared.
  const cutoffKnown = assignment.none.cutoff_evaluated;
  if (!cutoffKnown) report.informational.none_unchecked_without_cutoff = assignment.none.eligible_ignoring_cutoff;

  for (const subject of assignment.subjects) {
    if (groupFilter && !groupFilter.has(subject.group)) continue;
    const renderIds = sample ? subject.renderTaskIds.filter((id) => sample.has(id)) : subject.renderTaskIds;
    const noneIds = sample ? subject.noneTaskIds.filter((id) => sample.has(id)) : subject.noneTaskIds;
    if (renderIds.length === 0 && noneIds.length === 0) continue;
    report.checked_subjects++;
    const group = (report.checked_by_group[subject.group] ??= { tasks: 0, none: 0, rows: 0 });
    await reconcileSubject(db, subject, assignment, renderIds, noneIds, {
      root: options.archiveRoot,
      full: !sample && cutoffKnown,
      batchRows: options.batchRows,
      chunkBytes: options.chunkBytes,
      mismatch,
      info,
      turnCard: (checked) => {
        if (checked) report.checked_turn_cards++;
        else report.informational.turn_card_missing!++;
      },
      counted: (tasks, rows, none) => {
        report.checked_tasks += tasks;
        report.checked_rows += rows;
        report.checked_none += none;
        group.tasks += tasks;
        group.rows += rows;
        group.none += none;
      },
    });
  }
  report.ok = report.mismatch_total === 0;
  return report;
}

interface SubjectContext {
  root: string;
  full: boolean;
  batchRows?: number;
  chunkBytes?: number;
  mismatch: (category: TraceReconcileMismatch, detail: Record<string, unknown>) => void;
  info: (key: string, detail: Record<string, unknown>) => void;
  /** Count a task whose card was compared (`true`) or that has none (`false`). */
  turnCard: (checked: boolean) => void;
  counted: (tasks: number, rows: number, none: number) => void;
}

async function reconcileSubject(
  db: SqlDatabase,
  subject: TraceBackfillAssignedSubject,
  assignment: TraceBackfillAssignment,
  renderIds: readonly string[],
  noneIds: readonly string[],
  context: SubjectContext,
): Promise<void> {
  const where = { kind: subject.kind, subject_id: subject.id };
  const progressRaw = db.query(
    `SELECT status, digest, archive_id FROM multiremi_trace_backfill_progress
     WHERE subject_kind = ? AND subject_id = ?`,
  ).get(subject.kind, subject.id) as Record<string, unknown> | null;
  const progress: ProgressRow | null = progressRaw
    ? {
      status: String(progressRaw.status),
      digest: String(progressRaw.digest),
      archive_id: progressRaw.archive_id == null ? null : String(progressRaw.archive_id),
    }
    : null;
  if (!progress || progress.status !== "done") {
    context.mismatch("progress", { ...where, reason: progress ? `status ${progress.status}` : "no progress row" });
  }
  const taskRows = new Map(
    (db.query(
      `SELECT task_id, archive_id, row_count, head_seq, digest, cross_switch FROM multiremi_trace_backfill_tasks
       WHERE subject_kind = ? AND subject_id = ?`,
    ).all(subject.kind, subject.id) as Array<Record<string, unknown>>).map((raw): [string, BackfillTaskRow] => [
      String(raw.task_id),
      {
        task_id: String(raw.task_id),
        archive_id: String(raw.archive_id),
        row_count: Number(raw.row_count),
        head_seq: Number(raw.head_seq),
        digest: String(raw.digest),
        cross_switch: Number(raw.cross_switch ?? 0) !== 0,
      },
    ]),
  );
  if (context.full) {
    const expected = new Set(subject.renderTaskIds);
    const extra = [...taskRows.keys()].filter((taskId) => !expected.has(taskId));
    if (extra.length) context.mismatch("progress", { ...where, reason: "unexpected task rows", task_ids: extra.slice(0, 5) });
  }

  const archives = new Map<string, OpenedArchive | Error>();
  const openArchive = async (archiveId: string): Promise<OpenedArchive | Error> => {
    const cached = archives.get(archiveId);
    if (cached) return cached;
    const row = readArchiveRow(db, archiveId);
    let opened: OpenedArchive | Error;
    if (!row || row.status !== "ready" || row.metadata.kind !== TRACE_BACKFILL_METADATA_KIND
      || row.subjectKind !== subject.kind || row.subjectId !== subject.id) {
      opened = new Error(row ? `archive ${archiveId} is ${row.status} ${String(row.metadata.kind)}` : `archive ${archiveId} has no row`);
    } else {
      opened = await openTraceBackfillArchive(context.root, row.relativePath).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)));
    }
    archives.set(archiveId, opened);
    return opened;
  };

  const taskDigests: Array<{ taskId: string; digest: string }> = [];
  let rowsChecked = 0;
  try {
    for (const taskId of renderIds) {
      const task = assignment.tasks.get(taskId)!;
      const detail = { ...where, task_id: taskId };
      const backfillRow = taskRows.get(taskId);
      // Source side: rows in seq order, digested exactly as the plan digests them.
      const header = deriveTraceHeader(task).header;
      const end = deriveTraceEnd(task)!;
      const sourceDigest = new TraceTaskDigest(header as unknown as Record<string, unknown>);
      const sourceSeqs: number[] = [];
      const sourceLineDigests: string[] = [];
      const summary = new TraceTurnSummaryBuilder(taskId);
      for (const batch of iterateTaskRows(db, taskId, context)) {
        for (const row of batch) {
          const event = traceEventFromRow(row);
          const lineDigest = traceEventDigest(event);
          summary.add(event);
          sourceSeqs.push(row.seq);
          sourceLineDigests.push(lineDigest);
          sourceDigest.line(lineDigest);
        }
      }
      rowsChecked += sourceSeqs.length;
      const head = sourceSeqs.reduce((max, seq) => Math.max(max, seq), 0);
      const expectedEnd = { status: end.status, head, event_count: sourceSeqs.length, ended_at: end.endedAt };
      const expectedDigest = sourceDigest.finish(expectedEnd);
      taskDigests.push({ taskId, digest: expectedDigest });
      // A cross-switch task's card describes its whole run, which the daemon
      // reports; the backfill leaves it alone, so the old rows are no yardstick.
      if (backfillRow?.cross_switch) context.info("turn_card_skipped_cross_switch", detail);
      else checkTurnCard(db, summary.finish(), context, detail);
      if (!backfillRow) {
        context.mismatch("progress", { ...detail, reason: "no backfill task row" });
        continue;
      }
      if (backfillRow.digest !== expectedDigest || backfillRow.row_count !== sourceSeqs.length) {
        context.mismatch("progress", { ...detail, reason: "task digest stale" });
      }

      // Check what a reader reads: a backfill pointer is followed to the member
      // it names. A daemon-owned pointer is read the way the trace API reads it,
      // and the backfill member is still checked, as the prefix backup of a
      // cross-switch task.
      const pointer = readPointer(db, taskId);
      const backfillPointer = checkPointerOwner(pointer, backfillRow, progress, context, detail);
      if (pointer?.location === "archive" && pointer.source === "daemon") {
        await checkActivePointer(db, taskId, pointer, context, detail);
      }
      const archiveId = backfillPointer ? pointer!.archive_id! : backfillRow.archive_id;
      const archive = await openArchive(archiveId);
      if (archive instanceof Error) {
        context.mismatch("archive_missing", { ...detail, archive_id: archiveId, reason: archive.message });
        continue;
      }
      const memberPath = `${SESSION_ARCHIVE_TRACES_PREFIX}${taskId}${SESSION_ARCHIVE_TRACE_SUFFIX}`;
      const entry = archive.index.members.find((member) => member.path === memberPath);
      if (!entry) {
        context.mismatch("member_missing", { ...detail, archive_id: archiveId });
        continue;
      }
      const central = archive.directory.get(memberPath);
      if (!central || central.dataOffset !== entry.data_offset || central.compressedSize !== entry.compressed_size
        || central.uncompressedSize !== entry.uncompressed_size || central.localHeaderOffset !== entry.local_header_offset) {
        context.mismatch("index", { ...detail, reason: "index entry disagrees with the central directory" });
      }
      let bytes: Buffer;
      try {
        bytes = (await readZipMemberBody(archive.handle, {
          dataOffset: entry.data_offset,
          compressedSize: entry.compressed_size,
          uncompressedSize: entry.uncompressed_size,
          sha256: entry.sha256,
        })).bytes;
      } catch (error) {
        context.mismatch("member_unreadable", { ...detail, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const facts = inspectTraceMember(bytes, { taskId, sessionId: header.session_id });

      if (!facts.header || canonicalJson(facts.header) !== canonicalJson(header)) {
        context.mismatch("header", { ...detail, expected: header, actual: facts.header });
      }
      if (!sameSeqSet(facts.seqs, sourceSeqs)) {
        context.mismatch("seq_set", {
          ...detail, source_count: sourceSeqs.length, trace_count: facts.seqs.length,
        });
      } else {
        let bad = 0;
        let firstBadSeq: number | null = null;
        for (let i = 0; i < sourceSeqs.length; i++) {
          if (facts.seqs[i] !== sourceSeqs[i] || facts.lineDigests[i] !== sourceLineDigests[i]) {
            bad++;
            firstBadSeq ??= sourceSeqs[i]!;
          }
        }
        if (bad || facts.badEventShapes) {
          context.mismatch("line_digest", { ...detail, lines: bad, bad_shapes: facts.badEventShapes, first_seq: firstBadSeq });
        }
      }
      if (!facts.trailer) {
        context.mismatch("trailer", { ...detail, reason: "no trailer" });
      } else {
        if (facts.trailer.event_count !== sourceSeqs.length) {
          context.mismatch("event_count", { ...detail, rows: sourceSeqs.length, trailer: facts.trailer.event_count });
        }
        if (facts.trailer.head !== head || facts.trailer.status !== end.status || facts.trailer.ended_at !== end.endedAt) {
          context.mismatch("trailer", { ...detail, expected: expectedEnd, actual: facts.trailer });
        }
      }
      if (!facts.completeFinalLine || !facts.check.ok || !facts.check.value.closed) {
        context.mismatch("trailer", {
          ...detail, reason: facts.check.ok ? "not closed or partial final line" : facts.check.reason,
        });
      }
      if (entry.head !== head || entry.event_count !== sourceSeqs.length || entry.closed !== true) {
        context.mismatch("index", {
          ...detail, head, rows: sourceSeqs.length, index: { head: entry.head, event_count: entry.event_count, closed: entry.closed },
        });
      }
      if (backfillPointer) checkPointerEntry(pointer!, entry, head, sourceSeqs.length, context, detail);
    }

    for (const taskId of noneIds) {
      const pointer = readPointer(db, taskId);
      const detail = { ...where, task_id: taskId };
      checkTurnCard(db, emptyTraceTurnSummary(taskId), context, detail);
      if (pointer?.location === "none") continue;
      if (pointer?.location === "lost" || pointer?.location === "backfilling") {
        context.info("none_kept_existing_location", { ...detail, location: pointer.location });
        continue;
      }
      context.mismatch("pointer", { ...detail, expected: "none", actual: pointer?.location ?? "absent" });
    }

    if (context.full && progress) {
      const digest = traceSubjectDigest(
        subject.kind, subject.id, taskDigests, subject.noneTaskIds, subject.crossSwitchTaskIds,
      );
      if (digest !== progress.digest) context.mismatch("progress", { ...where, reason: "subject digest stale" });
    }
  } finally {
    for (const opened of archives.values()) {
      if (!(opened instanceof Error)) await opened.handle.close().catch(() => {});
    }
  }
  context.counted(renderIds.length, rowsChecked, noneIds.length);
}

/**
 * Who owns a task with rows, by the pointer's source (the swap rule never
 * compares heads across sources, so neither does this):
 * - a `trace_backfill` archive must be the subject's latest backfill archive,
 *   the one its progress row and task row name; returns `true` so the caller
 *   reads that member and compares the pointer with its index entry;
 * - a daemon archive is expected only for a task acknowledged as cross-switch;
 * - `lost` is kept as it is and counted;
 * - `missing`, `none`, `daemon` or `backfilling` means the backfill never took it.
 */
function checkPointerOwner(
  pointer: PointerRow | null,
  backfillRow: BackfillTaskRow,
  progress: ProgressRow | null,
  context: SubjectContext,
  detail: Record<string, unknown>,
): boolean {
  if (pointer?.location === "archive" && pointer.source === "trace_backfill" && pointer.archive_id) {
    if (pointer.archive_id !== progress?.archive_id || pointer.archive_id !== backfillRow.archive_id) {
      context.mismatch("pointer", {
        ...detail,
        reason: "backfill pointer is not at the subject's latest backfill archive",
        archive_id: pointer.archive_id,
        expected: progress?.archive_id ?? backfillRow.archive_id,
      });
    }
    return true;
  }
  if (pointer?.location === "archive") {
    if (backfillRow.cross_switch) {
      context.info("cross_switch_daemon_owned", { ...detail, archive_id: pointer.archive_id });
    } else {
      context.mismatch("pointer_owned_by_daemon_unexpected", { ...detail, archive_id: pointer.archive_id });
    }
    return false;
  }
  if (pointer?.location === "lost") {
    // The swap rule never moves a `lost` pointer; the rows are in the archive regardless.
    context.info("pointer_kept_lost", { ...detail, archive_id: backfillRow.archive_id });
    return false;
  }
  context.mismatch("pointer", {
    ...detail, expected: backfillRow.archive_id, location: pointer?.location ?? "absent", archive_id: pointer?.archive_id ?? null,
  });
  return false;
}

/** A backfill pointer must carry exactly its member's index entry. */
function checkPointerEntry(
  pointer: PointerRow,
  entry: SessionArchiveMemberIndexEntry,
  head: number,
  rows: number,
  context: SubjectContext,
  detail: Record<string, unknown>,
): void {
  const same = pointer.member_path === entry.path
    && pointer.data_offset === entry.data_offset
    && pointer.compressed_size === entry.compressed_size
    && pointer.uncompressed_size === entry.uncompressed_size
    && pointer.sha256 === entry.sha256
    && pointer.event_count === rows
    && pointer.head_seq === head
    && pointer.closed;
  if (!same) context.mismatch("pointer", { ...detail, reason: "pointer disagrees with the index entry" });
}

/**
 * A daemon-owned pointer is what the trace API serves for its task, so it must
 * lead somewhere readable (MUL-432 QA round 2, M1). Two verdicts, each counted
 * at most once per task:
 * - `active_pointer`: its archive row is `ready`, the member it names is in
 *   that archive's index for this task, the index entry agrees with the
 *   central directory, and the pointer carries the entry's fields exactly as
 *   ingest copies them (`buildTracePointers`);
 * - `active_member_unreadable`: `TraceReader.readTrace` — the class
 *   `GET /api/tasks/:id/trace` uses, which verifies the member's sha256 —
 *   pages from seq 0 to eof, every page `ok` from the archive.
 * The member's events are on the daemon's seq axis, so neither its heads nor
 * its lines are compared with the old rows or the backfill member.
 */
async function checkActivePointer(
  db: SqlDatabase,
  taskId: string,
  pointer: PointerRow,
  context: SubjectContext,
  detail: Record<string, unknown>,
): Promise<void> {
  const where = { ...detail, archive_id: pointer.archive_id, member_path: pointer.member_path };
  const inconsistency = await activePointerInconsistency(db, taskId, pointer, context.root);
  if (inconsistency) context.mismatch("active_pointer", { ...where, reason: inconsistency });

  // The reader sees only this pointer and the archive rows: it never reaches the
  // store's task, runtime or pointer lookups, nor the daemon, for an archive pointer.
  const archives = {
    getSessionArchive: (archiveId: string) => {
      const row = readArchiveRow(db, archiveId);
      return row ? { id: row.id, status: row.status, relativePath: row.relativePath } : null;
    },
  } as unknown as MultiremiStore;
  const noDaemon: DaemonTraceReader = {
    read: () => Promise.reject(new Error("reconcile reads archive pointers only")),
  };
  const trace: MultiremiTaskTrace = {
    taskId,
    location: "archive",
    runtimeId: null,
    archiveId: pointer.archive_id,
    memberPath: pointer.member_path,
    dataOffset: pointer.data_offset,
    compressedSize: pointer.compressed_size,
    uncompressedSize: pointer.uncompressed_size,
    sha256: pointer.sha256,
    eventCount: pointer.event_count,
    headSeq: pointer.head_seq,
    closed: pointer.closed,
    updatedAt: "",
  };
  const reader = new TraceReader({
    store: archives,
    daemon: noDaemon,
    archive: new SessionArchiveReader({ store: archives, root: resolve(context.root) }),
    getPointer: () => trace,
  });
  let after = 0;
  for (let pages = 1; ; pages++) {
    const page = await reader.readTrace(taskId, after, TRACE_READ_MAX_LIMIT);
    if (page.state !== "ok" || page.source !== "archive") {
      context.mismatch("active_member_unreadable", {
        ...where, after_seq: after, state: page.state, source: page.source, reason: page.reason ?? null,
      });
      return;
    }
    if (page.eof) return;
    if (page.next_after_seq <= after) {
      context.mismatch("active_member_unreadable", { ...where, after_seq: after, pages, reason: "no progress before eof" });
      return;
    }
    after = page.next_after_seq;
  }
}

/** Why a daemon-owned pointer disagrees with the archive it names, or null when it agrees. */
async function activePointerInconsistency(
  db: SqlDatabase,
  taskId: string,
  pointer: PointerRow,
  root: string,
): Promise<string | null> {
  if (!pointer.archive_id || !pointer.member_path) return "pointer names no archive member";
  const row = readArchiveRow(db, pointer.archive_id);
  if (!row) return "archive has no row";
  if (row.status !== "ready") return `archive is ${row.status}`;
  let archive: OpenedArchive;
  try {
    archive = await openTraceBackfillArchive(root, row.relativePath);
  } catch (error) {
    return `archive cannot be opened: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const entry = archive.index.members.find((member) => member.path === pointer.member_path);
    if (!entry) return "member is not in the archive index";
    if (entry.kind !== "trace" || entry.task_id !== taskId) return `member belongs to ${entry.task_id ?? entry.kind}`;
    const central = archive.directory.get(entry.path);
    if (!central || central.dataOffset !== entry.data_offset || central.compressedSize !== entry.compressed_size
      || central.uncompressedSize !== entry.uncompressed_size || central.localHeaderOffset !== entry.local_header_offset) {
      return "index entry disagrees with the central directory";
    }
    const fields = [
      ["data_offset", pointer.data_offset, entry.data_offset],
      ["compressed_size", pointer.compressed_size, entry.compressed_size],
      ["uncompressed_size", pointer.uncompressed_size, entry.uncompressed_size],
      ["sha256", pointer.sha256, entry.sha256],
      ["event_count", pointer.event_count, entry.event_count ?? null],
      ["head_seq", pointer.head_seq, entry.head ?? 0],
      ["closed", pointer.closed, entry.closed ?? false],
    ] as const;
    const differ = fields.filter(([, actual, expected]) => actual !== expected).map(([name]) => name);
    return differ.length ? `pointer disagrees with the index entry: ${differ.join(", ")}` : null;
  } finally {
    await archive.handle.close().catch(() => {});
  }
}

/** Compare historical trace summaries with their own attempts, never the current card. */
function checkTurnCard(
  db: SqlDatabase,
  summary: TraceBackfillTurnSummary,
  context: SubjectContext,
  detail: Record<string, unknown>,
): void {
  const raw=db.query('SELECT event_count,tool_call_count,type_histogram,model FROM multiremi_turn_attempts WHERE id=?').get(summary.taskId);
  if(!raw){context.turnCard(false);return;}
  raw.event_count = raw.event_count == null ? null : Number(raw.event_count);
  raw.tool_call_count = raw.tool_call_count == null ? null : Number(raw.tool_call_count);
  context.turnCard(true);
  const decode=(value:unknown)=>typeof value==='string'?JSON.parse(value):value;
  const card={...raw,type_histogram:decode(raw.type_histogram),model:decode(raw.model)} as ConversationLogTurnMetadata;
  const fields = traceBackfillTurnCardDiff(card, summary);
  if (fields.length === 0) return;
  context.mismatch("turn_card", {
    ...detail,
    fields,
    expected: {
      event_count: summary.eventCount,
      tool_call_count: summary.toolCallCount,
      type_histogram: summary.typeHistogram,
      model: summary.model,
    },
    actual: {
      event_count: card.event_count ?? null,
      tool_call_count: card.tool_call_count ?? null,
      type_histogram: card.type_histogram ?? null,
      model: card.model ?? null,
    },
  });
}
