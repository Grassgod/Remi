/**
 * Workspace reclaim (ADR 0018, section 4).
 *
 * One round walks the subject registry, asks the server whether each Issue,
 * Chat or task has ended, and reclaims what is past its retention: unsaved work
 * is saved to snapshot refs, the workspace is deleted, the environment is cut
 * down to native session history, and the server learns about it through
 * `gc.subject_reclaimed`. A subject the server no longer knows is forgotten; an
 * Issue that moved to another workspace is reclaimed like an ended one, and
 * never forgotten.
 *
 * The round never walks the workspaces tree. It reads `registry/`, and touches
 * `work/`, `env/` and `traces/` only below subjects the registry names, plus
 * the Feishu topic workspaces under `_topics/`. Before a tree is deleted, every
 * git repository in it is inspected the same way (`repo-inspection.ts`): unsaved
 * work in a linked worktree is saved, unsaved work in a standalone clone keeps
 * the whole subject. Every deletion goes through the anchored removal, which
 * removes the quarantined bytes without blocking the event loop, and is
 * preceded by the ownership fence.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { DaemonGcSubjectReclaimedPayload } from "@multiremi/contracts/daemon-protocol.js";
import type {
  StoragePlanItem,
  StorageReport,
  StorageRetainReason,
  StorageSettings,
  StorageSubjectRef,
  SubjectGitSnapshot,
  SubjectSnapshot,
} from "@multiremi/contracts/storage.js";
import { createLogger } from "@shared/logger.js";
import { DiskUsage, freeDiskBytes, freedBetween } from "./disk-usage.js";
import {
  cleanLaneGeneration,
  cleanSubjectEnvironment,
  generationModifiedAt,
  isKeptHistory,
  isProviderState,
  listLaneGenerations,
  removeOwnedPath,
  supersededGenerations,
  type LaneGeneration,
} from "./env-cleanup.js";
import { executionTrackerFor, type ExecutionTracker } from "./execution-tracker.js";
import { GitCheckFailedError, SnapshotFailedError, pruneWorktrees } from "./git-ops.js";
import {
  LEGACY_DIRECTORY_PREFIX,
  LEGACY_RETAINED_DIRECTORY,
  LEGACY_RETAINED_LIST,
  envDirectory,
  envRoot,
  isLaneSnapshotDir,
  legacyEntryPath,
  registrySnapshotDirectory,
  rootRelative,
  sharedReposRoot,
  taskTmpRoot,
  topicsRoot,
  traceDirectory,
  workDirectory,
  workRoot,
} from "./layout.js";
import { countRetainedWorktrees } from "./legacy-retained.js";
import type { IssueWorkspaceLifecycleLocker } from "./lifecycle-lock.js";
import { enqueueReclaimReport, flushReclaimReports } from "./reclaim-reports.js";
import {
  deleteSubjectRecord,
  listSubjectRecords,
  readSubjectRecord,
  updateSubjectRecord,
  writeSubjectRecord,
  type SubjectRecord,
} from "./registry.js";
import {
  REPOSITORY_SEARCH_DEPTH,
  inspectTree,
  sharedRepositories,
  snapshotTree,
  treeBlocker,
  treeHasUnsavedWork,
  type InspectOptions,
  type TreeInspection,
} from "./repo-inspection.js";
import { recoverOwnedDirectoryQuarantineSync, removeOwnedDirectory } from "./safe-remove.js";
import { TOPIC_MIGRATION_INTENT, readTopicMigrationIntent, readTopicTaskDossier, topicLifecycleKey } from "./topic-lifecycle.js";
import { collectWikiChanges, snapshotWiki } from "./wiki-snapshot.js";

const log = createLogger("multiremi-reclaim");

const ISSUE_ENDED_STATUSES: ReadonlySet<string> = new Set(["done", "completed", "closed", "cancelled"]);
/**
 * The server's answer for an Issue that now lives in another workspace. Only a
 * daemon that executed the Issue gets it; for this daemon's workspace the Issue
 * has ended.
 */
const ISSUE_MOVED_STATUS = "moved";
const TASK_ENDED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const CHECK_CONCURRENCY = 8;
/** After this many failed checks in a row the server counts as unreachable for the rest of the round. */
const MAX_CONSECUTIVE_UNREACHABLE = 5;
/** Entries of a work directory the daemon manages: never repositories, and not the content of one. */
const DAEMON_WORK_ENTRIES: ReadonlySet<string> = new Set(["wiki", ".multiremi"]);
/** A reclaimed subject only needs the server again to notice a hard delete. */
const RECLAIMED_RECHECK_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TASK_TMP_SUFFIX = /-[A-Za-z0-9]{6}$/;
const LEGACY_DIRECTORY = new RegExp(`^${LEGACY_DIRECTORY_PREFIX}(\\d{4})(\\d{2})(\\d{2})$`);

/** The server's answer to `gc.check_issue`, `gc.check_chat_session` or `gc.check_task`. */
export interface ReclaimCheckReply {
  /** An Issue, Chat or task status, or `moved` for an Issue that now lives in another workspace. */
  status: string;
  updated_at?: string | null;
  completed_at?: string | null;
  pinned?: boolean;
  origin?: { autopilot_id: string; run_id: string } | null;
  last_activity_at?: string | null;
}

export interface ReclaimClient {
  getIssueGcCheck(issueId: string): Promise<ReclaimCheckReply>;
  getChatSessionGcCheck(sessionId: string): Promise<ReclaimCheckReply>;
  getTaskGcCheck(taskId: string): Promise<ReclaimCheckReply>;
  reportSubjectReclaimed(payload: DaemonGcSubjectReclaimedPayload): Promise<void>;
}

export type ReclaimMode = StorageReport["mode"];

/**
 * The Feishu topic workspace lifecycle (ADR 0018, amendment A2). A topic
 * workspace migrated into an Issue returns to `_topics/` when the Issue ends,
 * interrupted migrations are finished, and unbound topic workspaces expire.
 */
export interface ReclaimTopics {
  recoverTopicWorkspace(topicDir: string): Promise<boolean>;
  recoverIssueWorkspace(issueDir: string): Promise<boolean>;
  isTopicWorkspaceBound(topicDir: string): boolean;
  returnTerminalIssueToTopic(issueDir: string): Promise<boolean>;
}

export interface ReclaimEngineOptions {
  root: string;
  client: ReclaimClient;
  /** The Runtime reports are sent under; null before registration. */
  runtimeId: () => string | null;
  policyFor: (workspaceId: string) => StorageSettings;
  /** `MULTIREMI_GC_DRY_RUN`: plan every round, mutate none. */
  dryRun: boolean;
  legacyKeepDays: number;
  /** The Issue lifecycle lock, shared by every execution on this root. */
  locker: IssueWorkspaceLifecycleLocker;
  /**
   * Topic workspaces. They belong to no registry subject, so `workspaceId`
   * names the workspace whose `orphan_ttl_ms` expires the unbound ones.
   */
  topics?: { lifecycle: ReclaimTopics; workspaceId: string };
  /** The bare repository cache; defaults to `shared/repos` below the root. */
  repoCacheRoot?: string;
  /** Runs `action` while holding the shared repository's lock. */
  withRepoLock?: <T>(barePath: string, action: () => Promise<T>) => Promise<T>;
  /** Synchronous process-ownership fence, called immediately before local mutations. */
  assertRootOwner?: () => void;
  now?: () => number;
  /** Replaceable for tests; defaults to `du -sk` under `nice`. Only the background measurement sizes anything. */
  measure?: (paths: readonly string[], signal: AbortSignal) => Promise<number>;
  /** The background measurement of the whole root's disk usage; see `DiskUsage`. */
  diskUsage?: { refreshMs?: number; categoryTimeoutMs?: number };
  /** Ends a running disk measurement, e.g. when the daemon stops. */
  stopSignal?: () => AbortSignal | undefined;
}

export type SubjectProbe =
  | { kind: "known"; reply: ReclaimCheckReply }
  /** The server answered 404: the subject was hard-deleted. */
  | { kind: "gone" }
  | { kind: "unreachable" };

export type SubjectOutcome =
  | { action: "keep"; reason: StorageRetainReason }
  | { action: "reclaim"; reason: "ended_ttl" | "over_cap" }
  | { action: "forget"; reason: "orphan" };

export interface SubjectClassification {
  outcome: SubjectOutcome;
  /** The server considers the subject finished, whatever its retention says. */
  ended: boolean;
}

export interface ClassifySubjectInput {
  record: SubjectRecord;
  probe: SubjectProbe;
  running: boolean;
  policy: StorageSettings;
  now: number;
}

/**
 * The decision table of a round (ADR 0018, section 4): what to do with one
 * subject given what the server says. Pure; the cap on retained workspaces is
 * applied afterwards across subjects.
 */
export function classifySubject(input: ClassifySubjectInput): SubjectClassification {
  const { record, probe, policy, now } = input;
  const lastUsed = Date.parse(record.last_used_at);
  if (input.running) return { outcome: { action: "keep", reason: "running" }, ended: false };
  if (probe.kind === "unreachable") return { outcome: { action: "keep", reason: "server_unreachable" }, ended: false };
  if (probe.kind === "gone") {
    const orphaned = Number.isFinite(lastUsed) && now - lastUsed > policy.orphan_ttl_ms;
    return orphaned
      ? { outcome: { action: "forget", reason: "orphan" }, ended: false }
      : { outcome: { action: "keep", reason: "within_ttl" }, ended: false };
  }
  const { reply } = probe;
  const kind = record.subject.kind;
  // A moved Issue left this workspace for good, which ends it here. It is not hard-deleted, so it is
  // reclaimed after the TTL but never forgotten: its records and registry entry stay.
  const ended = kind === "issue"
    ? ISSUE_ENDED_STATUSES.has(reply.status) || reply.status === ISSUE_MOVED_STATUS
    : kind === "chat"
      ? reply.status === "archived"
      : TASK_ENDED_STATUSES.has(reply.status);
  if (kind === "chat" && reply.pinned) return { outcome: { action: "keep", reason: "pinned" }, ended };
  if (!ended) return { outcome: { action: "keep", reason: "not_ended" }, ended };
  // Use after the server ended the subject restarts the retention clock.
  const endedAt = Math.max(
    parseTime(reply.completed_at),
    parseTime(reply.updated_at),
    parseTime(reply.last_activity_at),
    Number.isFinite(lastUsed) ? lastUsed : 0,
  );
  const ttl = kind === "chat" && reply.origin ? policy.automation_ttl_ms : policy.ttl_ms;
  return now - endedAt < ttl
    ? { outcome: { action: "keep", reason: "within_ttl" }, ended }
    : { outcome: { action: "reclaim", reason: "ended_ttl" }, ended };
}

/** True when the server will never accept a request, so retrying it is pointless. */
export function isPermanentRejection(error: unknown): boolean {
  const status = httpStatus(error);
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Why a subject is kept instead of reclaimed. Its message is what the storage report shows. */
class KeepSubject extends Error {
  constructor(readonly reason: StorageRetainReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KeepSubject";
  }
}

/** Reasons that need no explanation in the report: the subject is simply in use or not due yet. */
const QUIET_KEEP_REASONS: ReadonlySet<StorageRetainReason> = new Set(["running", "within_ttl"]);

interface Candidate {
  record: SubjectRecord;
  classification: SubjectClassification;
  /** Reclaimed earlier and nothing is left to do for it this round. */
  settled: boolean;
  finalState: "active" | "reclaimed" | "forgotten";
}

/** What a reclaim or forget would delete, inspected before anything is changed. */
interface Examination {
  /** `work/<subject>`; null when there is none to delete (an external directory, a topic Issue, or one already gone). */
  work: TreeInspection | null;
  /** Every lane generation below `env/<subject>`: its private `work/`, its provider home and its plugin runtime. */
  lanes: TreeInspection[];
}

interface SubjectEffect {
  unsaved: boolean;
  /** Free space gained on the root's filesystem while the subject was reclaimed. */
  freedBytes: number;
}

const queues = new Map<string, Promise<unknown>>();

/** Rounds on one root never overlap, even across provider daemons sharing the process. */
function serializeByRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  const run = previous.then(action);
  const tail = run.catch(() => undefined);
  queues.set(root, tail);
  void tail.then(() => {
    if (queues.get(root) === tail) queues.delete(root);
  });
  return run;
}

export class ReclaimEngine {
  private readonly root: string;
  private readonly diskUsage: DiskUsage;
  private readonly lastChecked = new Map<string, number>();
  private readonly cacheRoots: string[];
  private consecutiveUnreachable = 0;

  constructor(private readonly options: ReclaimEngineOptions) {
    this.root = resolve(options.root);
    this.cacheRoots = [...new Set([sharedReposRoot(this.root), ...(options.repoCacheRoot ? [resolve(options.repoCacheRoot)] : [])])];
    this.diskUsage = new DiskUsage({
      root: this.root,
      measure: options.measure,
      now: options.now,
      refreshMs: options.diskUsage?.refreshMs,
      categoryTimeoutMs: options.diskUsage?.categoryTimeoutMs,
      stopSignal: options.stopSignal,
      assertRootOwner: options.assertRootOwner,
    });
  }

  /** Resolves once no background disk measurement is running (shutdown and tests; a round never waits for it). */
  measurementSettled(): Promise<void> {
    return this.diskUsage.settled();
  }

  /**
   * Run one round. `periodic` rounds plan and apply; `dry_run` plans only;
   * `run` is an operator request to apply now. `MULTIREMI_GC_DRY_RUN` turns
   * every mode into a dry run.
   */
  run(mode: ReclaimMode): Promise<StorageReport> {
    return serializeByRoot(this.root, () => this.round(mode));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private fence(): void {
    this.options.assertRootOwner?.();
  }

  private async round(requested: ReclaimMode): Promise<StorageReport> {
    const mutate = requested !== "dry_run" && !this.options.dryRun;
    const mode: ReclaimMode = mutate ? requested : "dry_run";
    const startedAt = this.now();
    const tracker = executionTrackerFor(this.root);
    const errors: StorageReport["errors"] = [];
    const retained: StorageReport["retained"] = {};
    const plan: StoragePlanItem[] = [];
    let reclaimedCount = 0;
    let forgottenCount = 0;
    let freedBytes = 0;

    this.fence();
    const runtimeId = this.options.runtimeId();
    if (mutate) {
      if (!runtimeId) throw new Error("Storage reclaim requires a registered Runtime");
      this.recoverQuarantine(errors);
      await flushReclaimReports({
        root: this.root,
        runtimeId,
        send: (payload) => this.options.client.reportSubjectReclaimed(payload),
        rejected: isPermanentRejection,
        assertRootOwner: this.options.assertRootOwner,
        stillReclaimed: (payload) => {
          const record = readSubjectRecord(this.root, payload.subject);
          return record === null || (record.state === "reclaimed" && !usedSinceReclaim(record));
        },
      });
      await this.recoverTopicMigrations(errors);
    }

    const records = listSubjectRecords(this.root, (path, error) => {
      errors.push({ subject_id: null, message: `unreadable registry record ${path}: ${errorMessage(error)}` });
    });
    this.consecutiveUnreachable = 0;
    const candidates = await this.classifyAll(records, requested !== "periodic");
    this.applyRetainedCap(candidates);

    for (const candidate of candidates) {
      if (candidate.settled) continue;
      const { record } = candidate;
      const subject = record.subject;
      const { outcome } = candidate.classification;
      if (outcome.action === "keep") {
        retained[outcome.reason] = (retained[outcome.reason] ?? 0) + 1;
        plan.push(planItem(subject, outcome, false));
        continue;
      }
      let effect: SubjectEffect;
      try {
        effect = mutate ? await this.apply(candidate, runtimeId!, tracker) : await this.preview(candidate);
      } catch (error) {
        const kept: StorageRetainReason = error instanceof KeepSubject ? error.reason : "error";
        if (!(error instanceof KeepSubject)) this.failSubject(subject, error, errors);
        else if (!QUIET_KEEP_REASONS.has(error.reason)) errors.push({ subject_id: subject.id, message: error.message });
        retained[kept] = (retained[kept] ?? 0) + 1;
        plan.push(planItem(subject, { action: "keep", reason: kept }, false));
        continue;
      }
      plan.push(planItem(subject, outcome, effect.unsaved));
      if (!mutate) continue;
      if (outcome.action === "forget") {
        forgottenCount++;
        candidate.finalState = "forgotten";
      } else {
        reclaimedCount++;
        candidate.finalState = "reclaimed";
        // The work directory stays with its owner; only the environment was reclaimed.
        if (record.external_work_dir) retained.external_dir = (retained.external_dir ?? 0) + 1;
      }
      freedBytes += effect.freedBytes;
    }

    if (mutate) {
      await this.cleanSuperseded(candidates, tracker, errors);
      await this.sweepTaskTemp(candidates, tracker, errors);
      await this.removeExpiredTopics(errors);
      await this.removeExpiredLegacy(errors);
      await this.pruneSharedRepositories(errors);
    }
    const legacyRetained = this.countLegacyRetained(errors);
    if (legacyRetained > 0) retained.legacy_retained = legacyRetained;
    // The latest completed measurement, whenever it was taken; a new one starts in the background.
    const usage = this.diskUsage.latest();

    const live = candidates.filter((candidate) => candidate.finalState !== "forgotten");
    const report: StorageReport = {
      version: 1,
      generated_at: new Date(startedAt).toISOString(),
      mode,
      root: this.root,
      bytes: usage?.bytes ?? null,
      bytes_measured_at: usage?.measured_at ?? null,
      subjects: {
        total: live.length,
        reclaimed: live.filter((candidate) => candidate.finalState === "reclaimed").length,
        ended: live.filter((candidate) => candidate.finalState === "active" && candidate.classification.ended).length,
        active: live.filter((candidate) => candidate.finalState === "active" && !candidate.classification.ended).length,
      },
      retained,
      reclaimed_this_round: reclaimedCount,
      forgotten_this_round: forgottenCount,
      freed_bytes: freedBytes,
      plan: requested === "periodic" ? plan.filter((item) => item.action !== "keep") : plan,
      errors,
    };
    this.fence();
    this.diskUsage.refresh(requested !== "periodic");
    return report;
  }

  private recoverQuarantine(errors: StorageReport["errors"]): void {
    try {
      const recovery = recoverOwnedDirectoryQuarantineSync(this.root, {
        assertRootOwner: this.options.assertRootOwner,
        onError: (path, error) => errors.push({ subject_id: null, message: `quarantine entry ${path}: ${errorMessage(error)}` }),
      });
      if (recovery.recovered) log.info(`Finished ${recovery.recovered} interrupted deletion(s)`);
    } catch (error) {
      this.failSubject(null, error, errors);
    }
  }

  /**
   * One failure skips one subject, unless the daemon lost its root: re-probing
   * the monotonic ownership fence tells the two apart, and its error aborts the round.
   */
  private failSubject(subject: StorageSubjectRef | null, error: unknown, errors: StorageReport["errors"]): void {
    this.fence();
    log.warn(`Reclaim skipped ${subject?.id ?? "the root"}: ${errorMessage(error)}`);
    errors.push({ subject_id: subject?.id ?? null, message: errorMessage(error) });
  }

  private async classifyAll(records: SubjectRecord[], force: boolean): Promise<Candidate[]> {
    const tracker = executionTrackerFor(this.root);
    const now = this.now();
    const candidates: Candidate[] = new Array(records.length);
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < records.length; index = next++) {
        const record = records[index]!;
        const holdsWorkDir = this.holdsWorkDir(record);
        const running = tracker.subjectRunning(record.subject.id);
        const recentlyChecked = now - (this.lastChecked.get(record.subject.id) ?? 0) < RECLAIMED_RECHECK_MS;
        // An execution since the reclaim (a discussion, a Runtime workspace) leaves new environment behind.
        const idle = record.state === "reclaimed" && !holdsWorkDir && !usedSinceReclaim(record);
        const skipCheck = !running && idle && !force && recentlyChecked;
        const probe: SubjectProbe = running || skipCheck ? { kind: "unreachable" } : await this.probe(record);
        if (!running && !skipCheck) this.lastChecked.set(record.subject.id, now);
        const classification = classifySubject({
          record, probe, running, policy: this.options.policyFor(record.workspace_id), now,
        });
        // A reclaimed subject with nothing left on disk only matters once it was hard-deleted.
        const settled = skipCheck || (idle && classification.outcome.action !== "forget");
        candidates[index] = { record, classification, settled, finalState: record.state };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, records.length) }, worker));
    return candidates;
  }

  private async probe(record: SubjectRecord): Promise<SubjectProbe> {
    if (this.consecutiveUnreachable >= MAX_CONSECUTIVE_UNREACHABLE) return { kind: "unreachable" };
    const { kind, id } = record.subject;
    try {
      const reply = kind === "issue"
        ? await this.options.client.getIssueGcCheck(id)
        : kind === "chat"
          ? await this.options.client.getChatSessionGcCheck(id)
          : await this.options.client.getTaskGcCheck(id);
      this.consecutiveUnreachable = 0;
      return { kind: "known", reply };
    } catch (error) {
      if (httpStatus(error) === 404) {
        this.consecutiveUnreachable = 0;
        return { kind: "gone" };
      }
      this.consecutiveUnreachable++;
      log.debug(`Cannot check ${id}: ${errorMessage(error)}`);
      return { kind: "unreachable" };
    }
  }

  /**
   * Ended subjects that still hold a workspace beyond the cap are reclaimed
   * least recently used first, even inside their retention.
   */
  private applyRetainedCap(candidates: Candidate[]): void {
    const byWorkspace = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const { record, classification } = candidate;
      if (candidate.settled || !classification.ended || classification.outcome.action === "reclaim" || !this.holdsWorkDir(record)) continue;
      const group = byWorkspace.get(record.workspace_id) ?? [];
      group.push(candidate);
      byWorkspace.set(record.workspace_id, group);
    }
    for (const [workspaceId, holding] of byWorkspace) {
      const cap = this.options.policyFor(workspaceId).max_retained;
      if (cap <= 0 || holding.length <= cap) continue;
      const removable = holding
        .filter((candidate) => {
          const outcome = candidate.classification.outcome;
          return outcome.action === "keep" && outcome.reason === "within_ttl";
        })
        .sort((left, right) => Date.parse(left.record.last_used_at) - Date.parse(right.record.last_used_at));
      for (const candidate of removable.slice(0, holding.length - cap)) {
        candidate.classification = { ...candidate.classification, outcome: { action: "reclaim", reason: "over_cap" } };
      }
    }
  }

  /** What a dry run reports for a subject: the checks a real reclaim performs, without any change. */
  private async preview(candidate: Candidate): Promise<SubjectEffect> {
    const { record } = candidate;
    const policy = this.options.policyFor(record.workspace_id);
    const reclaiming = candidate.classification.outcome.action === "reclaim";
    // A topic Issue's workspace moves back to its topic whole: only its lanes are examined.
    const topic = reclaiming && this.isTopicIssue(record);
    const examination = await this.examine(record, policy, !topic);
    let unsaved = examinedTrees(examination).some(treeHasUnsavedWork);
    if (reclaiming && !topic && this.holdsWorkDir(record)) {
      try {
        const changes = collectWikiChanges(workDirectory(this.root, record.subject), policy.snapshot_max_bytes);
        unsaved ||= changes.changed.length + changes.deleted.length > 0;
      } catch (error) {
        throw toKeep(error);
      }
    }
    return { unsaved, freedBytes: 0 };
  }

  private async apply(candidate: Candidate, runtimeId: string, tracker: ExecutionTracker): Promise<SubjectEffect> {
    const subject = candidate.record.subject;
    // Never queue behind an execution: a busy subject is simply not reclaimed this round.
    const release = this.options.locker.tryAcquire(subject.id);
    if (!release) throw new KeepSubject("running", `${subject.id} is in use`);
    try {
      const current = readSubjectRecord(this.root, subject);
      if (tracker.subjectRunning(subject.id) || !current
        || current.last_used_at !== candidate.record.last_used_at || current.state !== candidate.record.state) {
        throw new KeepSubject("within_ttl", `${subject.id} was used while the round ran`);
      }
      this.fence();
      return candidate.classification.outcome.action === "forget"
        ? await this.forget(current)
        : await this.reclaim(current, runtimeId);
    } finally {
      release();
    }
  }

  /** Save unsaved work, delete the workspace, cut the environment down, tell the server. */
  private async reclaim(record: SubjectRecord, runtimeId: string): Promise<SubjectEffect> {
    const subject = record.subject;
    const policy = this.options.policyFor(record.workspace_id);
    const workDir = workDirectory(this.root, subject);
    const topic = this.isTopicIssue(record);
    // A topic Issue's workspace goes back to its topic instead; it is neither saved nor deleted here.
    const deletesWorkDir = this.holdsWorkDir(record) && !topic;
    const freeBefore = await freeDiskBytes(this.root);
    const examination = await this.examine(record, policy, !topic);
    // Everything that can keep the subject is checked before the first snapshot ref exists,
    // so a kept subject does not collect a new ref every round.
    if (deletesWorkDir) this.checkWikiFits(workDir, policy);
    if (topic) await this.returnToTopic(record);

    const saved = await this.save(subject, examination, policy);
    const earlier = unreportedSnapshot(record);
    const git = [...saved, ...carriedSnapshots(earlier, examination.work)];
    for (const entry of saved) log.info(`Saved unsaved work of ${subject.id} at ${entry.dir} as ${entry.ref}`);
    let wikiFiles = record.snapshot?.wiki_files ?? 0;
    if (deletesWorkDir) {
      try {
        wikiFiles = snapshotWiki({
          root: this.root,
          subject,
          workDir,
          maxBytes: policy.snapshot_max_bytes,
          carryPending: record.state === "reclaimed" && (record.snapshot?.wiki_files ?? 0) > 0,
          assertRootOwner: this.options.assertRootOwner,
        });
      } catch (error) {
        throw toKeep(error);
      }
    }
    const unsaved = git.length > 0 || wikiFiles > 0;
    // Without anything saved just now (an external work directory, a deletion an earlier round
    // finished, a topic) the snapshot of an earlier reclaim must survive as it is.
    const snapshot: SubjectSnapshot | null = deletesWorkDir || saved.length > 0
      ? (unsaved ? { created_at: new Date(this.now()).toISOString(), git, wiki_files: wikiFiles } : null)
      : earlier;
    // Written before anything is deleted so a crash cannot lose the pointer to the snapshot.
    this.fence();
    writeSubjectRecord(this.root, { ...record, snapshot });

    const repositories = sharedRepositories(examinedTrees(examination));
    if (deletesWorkDir) {
      this.fence();
      await removeOwnedDirectory(this.root, workDir, { assertRootOwner: this.options.assertRootOwner });
    }
    await this.pruneRepositories(repositories);
    await cleanSubjectEnvironment(subject, { root: this.root, assertRootOwner: this.options.assertRootOwner });

    this.fence();
    writeSubjectRecord(this.root, {
      ...record,
      snapshot,
      state: "reclaimed",
      reclaimed_at: new Date(this.now()).toISOString(),
    });
    const freedBytes = freedBetween(freeBefore, await freeDiskBytes(this.root));
    await this.reportReclaimed({
      runtime_id: runtimeId,
      subject,
      snapshot,
      unsaved_work: snapshot !== null && (snapshot.git.length > 0 || snapshot.wiki_files > 0),
      freed_bytes: freedBytes,
    });
    return { unsaved, freedBytes };
  }

  /** Whether `work/<subject>` is a directory this daemon owns and may delete. */
  private holdsWorkDir(record: SubjectRecord): boolean {
    return !record.external_work_dir && directoryExists(workDirectory(this.root, record.subject));
  }

  /** Whether `work/<issue>` is a Feishu topic workspace that was migrated into the Issue. */
  private isTopicIssue(record: SubjectRecord): boolean {
    return this.options.topics !== undefined && record.subject.kind === "issue" && !record.external_work_dir
      && readTopicTaskDossier(workDirectory(this.root, record.subject)) !== null;
  }

  /**
   * An ended Issue that came from a Feishu topic does not lose its workspace:
   * the directory goes back to `_topics/<topic>` with the topic conversation,
   * exactly as before the Issue existed. Nothing is deleted or snapshotted. The
   * caller holds the Issue lock; the topic lock is taken inside, in that order.
   */
  private async returnToTopic(record: SubjectRecord): Promise<void> {
    const returned = await this.options.topics!.lifecycle.returnTerminalIssueToTopic(workDirectory(this.root, record.subject));
    if (!returned) throw new Error(`${record.subject.id} has no topic to return to`);
  }

  /** Delete everything of a subject the server forgot; unsaved work stays behind as snapshot refs. */
  private async forget(record: SubjectRecord): Promise<SubjectEffect> {
    const subject = record.subject;
    const policy = this.options.policyFor(record.workspace_id);
    const workDir = workDirectory(this.root, subject);
    const freeBefore = await freeDiskBytes(this.root);
    const examination = await this.examine(record, policy, true);
    const git = await this.save(subject, examination, policy);
    for (const snapshot of git) log.info(`Forgetting ${subject.id}; its unsaved work stays at ${snapshot.ref}`);

    const repositories = sharedRepositories(examinedTrees(examination));
    const doomed = [
      ...(this.holdsWorkDir(record) ? [workDir] : []),
      ...[envDirectory(this.root, subject), traceDirectory(this.root, subject), registrySnapshotDirectory(this.root, subject)]
        .filter(directoryExists),
    ];
    for (const path of doomed) {
      this.fence();
      await removeOwnedDirectory(this.root, path, { assertRootOwner: this.options.assertRootOwner });
    }
    await this.pruneRepositories(repositories);
    this.fence();
    deleteSubjectRecord(this.root, subject);
    return { unsaved: git.length > 0, freedBytes: freedBetween(freeBefore, await freeDiskBytes(this.root)) };
  }

  /** `doomed`: what is deleted together with the tree, which decides whether a clone's remote outlives it. */
  private inspectOptions(policy: StorageSettings, doomed?: readonly string[]): InspectOptions {
    return { cacheRoots: this.cacheRoots, maxBytes: policy.snapshot_max_bytes, daemonEntries: DAEMON_WORK_ENTRIES, ...(doomed ? { doomed } : {}) };
  }

  /**
   * What a reclaim or forget would delete, inspected before anything is saved or
   * deleted: the work directory (unless it moves back to its topic) and every
   * lane generation, its provider home and plugin runtime included. A repository
   * that cannot be checked, or whose unsaved work cannot be saved (a standalone
   * clone, a snapshot beyond the limit), keeps the whole subject.
   */
  private async examine(record: SubjectRecord, policy: StorageSettings, includeWork: boolean): Promise<Examination> {
    const subject = record.subject;
    try {
      const holdsWork = includeWork && this.holdsWorkDir(record);
      const doomed = [envDirectory(this.root, subject), ...(holdsWork ? [workDirectory(this.root, subject)] : [])];
      const work = holdsWork ? await inspectTree(workDirectory(this.root, subject), this.inspectOptions(policy, doomed)) : null;
      const lanes: TreeInspection[] = [];
      for (const generation of listLaneGenerations(this.root, subject)) {
        const lane = await this.inspectLane(generation, policy, doomed);
        if (lane) lanes.push(lane);
      }
      const examination = { work, lanes };
      for (const tree of examinedTrees(examination)) {
        const blocker = treeBlocker(tree);
        if (blocker) throw new KeepSubject(blocker.reason, blocker.message);
      }
      return examination;
    } catch (error) {
      throw toKeep(error);
    }
  }

  /**
   * A lane generation as cleanup deletes it: the private `work/` (an Issue holder's cwd, or a discussion's
   * work set), the provider home and the plugin runtime. An agent can leave a repository in any of them.
   * Two things are not looked through: the native session history, which cleanup keeps, and the provider's
   * own state in its home (Codex keeps a repository of curated plugins with no remote in `.tmp/plugins`),
   * which the provider rebuilds and which was never the agent's work. The generation's own entries are
   * where the search starts counting, so `work/` is searched as deep as it always was.
   */
  private async inspectLane(generation: LaneGeneration, policy: StorageSettings, doomed: readonly string[]): Promise<TreeInspection | null> {
    if (!directoryExists(generation.path)) return null;
    return await inspectTree(generation.path, {
      ...this.inspectOptions(policy, doomed),
      daemonEntries: undefined,
      maxDepth: REPOSITORY_SEARCH_DEPTH + 1,
      skip: (directory, name) => {
        const parts = relative(generation.path, join(directory, name)).split(sep);
        return isKeptHistory(parts) || isProviderState(parts);
      },
    });
  }

  /** Throws the keep reason when the Wiki changes alone do not fit a snapshot. */
  private checkWikiFits(workDir: string, policy: StorageSettings): void {
    try {
      collectWikiChanges(workDir, policy.snapshot_max_bytes);
    } catch (error) {
      throw toKeep(error);
    }
  }

  /**
   * Save the unsaved work of every linked worktree of an examination as snapshot refs.
   * The work directory's repositories are recorded by their place below it; the lanes'
   * stand outside it, so theirs are recorded by their place below the root and no
   * restore ever mistakes them for a checkout of the subject.
   */
  private async save(subject: StorageSubjectRef, examination: Examination, policy: StorageSettings): Promise<SubjectGitSnapshot[]> {
    const options = {
      subjectRef: subject.id,
      maxBytes: policy.snapshot_max_bytes,
      now: new Date(this.now()),
      before: () => this.fence(),
    };
    try {
      const saved = examination.work
        ? await snapshotTree(examination.work, { ...options, dirOf: (repository) => repository.relative })
        : [];
      for (const lane of examination.lanes) {
        saved.push(...await snapshotTree(lane, { ...options, dirOf: (repository) => rootRelative(this.root, repository.path) }));
      }
      return saved;
    } catch (error) {
      throw toKeep(error);
    }
  }

  /** Forget the registrations of worktrees that were just deleted. */
  private async pruneRepositories(directories: Iterable<string>): Promise<void> {
    for (const directory of directories) {
      try {
        const prune = () => pruneWorktrees(directory);
        await (this.options.withRepoLock ? this.options.withRepoLock(directory, prune) : prune());
      } catch (error) {
        log.warn(`Could not prune worktrees of ${directory}: ${errorMessage(error)}`);
      }
    }
  }

  private async reportReclaimed(payload: DaemonGcSubjectReclaimedPayload): Promise<void> {
    try {
      await this.options.client.reportSubjectReclaimed(payload);
    } catch (error) {
      if (isPermanentRejection(error)) {
        log.warn(`Server rejected the reclaim report for ${payload.subject.id}: ${errorMessage(error)}`);
        return;
      }
      // The workspace is gone already; the next round sends the report again.
      enqueueReclaimReport(this.root, payload);
      log.warn(`Reclaim report for ${payload.subject.id} queued: ${errorMessage(error)}`);
    }
  }

  /**
   * Lane generations older than the newest of their lane are cleaned once they have been idle for `ttl_ms`.
   * A generation whose work set holds unsaved work that cannot be saved (a standalone clone) is kept and reported.
   */
  private async cleanSuperseded(candidates: Candidate[], tracker: ExecutionTracker, errors: StorageReport["errors"]): Promise<void> {
    for (const candidate of candidates) {
      const { record } = candidate;
      if (candidate.settled || candidate.finalState === "forgotten") continue;
      const subject = record.subject;
      if (tracker.subjectRunning(subject.id) || !directoryExists(envDirectory(this.root, subject))) continue;
      const release = this.options.locker.tryAcquire(subject.id);
      if (!release) continue;
      try {
        const policy = this.options.policyFor(record.workspace_id);
        for (const generation of supersededGenerations(this.root, subject)) {
          if (this.now() - generationModifiedAt(generation.path) <= policy.ttl_ms) continue;
          try {
            await this.cleanGeneration(subject, generation, policy);
          } catch (error) {
            if (!(error instanceof KeepSubject)) throw error;
            errors.push({ subject_id: subject.id, message: error.message });
          }
        }
      } catch (error) {
        this.failSubject(subject, error, errors);
      } finally {
        release();
      }
    }
  }

  private async cleanGeneration(subject: StorageSubjectRef, generation: LaneGeneration, policy: StorageSettings): Promise<void> {
    let lane: TreeInspection | null;
    try {
      lane = await this.inspectLane(generation, policy, [generation.path]);
      const blocker = lane && treeBlocker(lane);
      if (blocker) throw new KeepSubject(blocker.reason, blocker.message);
    } catch (error) {
      throw toKeep(error);
    }
    if (lane) {
      const saved = await this.save(subject, { work: null, lanes: [lane] }, policy);
      // The record must name the refs before the work set that held them is gone.
      if (saved.length > 0) this.recordSaved(subject, saved);
    }
    this.fence();
    const removed = await cleanLaneGeneration(generation.path, { root: this.root, assertRootOwner: this.options.assertRootOwner });
    if (removed) log.info(`Cleaned superseded generation ${generation.path}`);
  }

  /** Add snapshot entries to the subject's record, beside what an earlier reclaim saved. */
  private recordSaved(subject: StorageSubjectRef, saved: SubjectGitSnapshot[]): void {
    this.fence();
    updateSubjectRecord(this.root, subject, (current) => ({
      ...current,
      snapshot: {
        created_at: new Date(this.now()).toISOString(),
        git: [...(current.snapshot?.git ?? []), ...saved],
        wiki_files: current.snapshot?.wiki_files ?? 0,
      },
    }));
  }

  /**
   * Execution temp directories of executions that are not running are residue of a crash.
   * Every `env/<id>/tmp` is swept, also that of a subject whose registry record is missing or unreadable.
   */
  private async sweepTaskTemp(candidates: Candidate[], tracker: ExecutionTracker, errors: StorageReport["errors"]): Promise<void> {
    const forgotten = new Set(candidates.filter((candidate) => candidate.finalState === "forgotten").map((candidate) => candidate.record.subject.id));
    const subjects = new Map(candidates.map((candidate) => [candidate.record.subject.id, candidate.record.subject]));
    for (const id of listDirectories(envRoot(this.root))) {
      if (forgotten.has(id)) continue;
      const subject = subjects.get(id) ?? null;
      const parent = taskTmpRoot(this.root, { kind: "chat", id });
      try {
        if (!directoryExists(parent)) continue;
        for (const name of readdirSync(parent)) {
          if (tracker.taskRunning(name.replace(TASK_TMP_SUFFIX, ""))) continue;
          this.fence();
          await removeOwnedDirectory(this.root, join(parent, name), { assertRootOwner: this.options.assertRootOwner });
        }
      } catch (error) {
        this.failSubject(subject, error, errors);
      }
    }
  }

  /**
   * Finish the topic migrations a crash interrupted, in `_topics/` and in
   * `work/`. Each runs under the lock order of a live migration: Issue first,
   * then the topic. An Issue that is busy is left for the next round.
   */
  private async recoverTopicMigrations(errors: StorageReport["errors"]): Promise<void> {
    const topics = this.options.topics?.lifecycle;
    if (!topics) return;
    for (const name of listDirectories(topicsRoot(this.root))) {
      const topicDir = join(topicsRoot(this.root), name);
      try {
        this.fence();
        // Finishing a migration waits for its Issue's lock, which a running execution holds
        // for hours; the round must not queue behind it.
        const issueId = readTopicMigrationIntent(topicDir)?.issue_id;
        if (issueId) {
          const free = this.options.locker.tryAcquire(issueId);
          if (!free) continue;
          free();
        }
        await topics.recoverTopicWorkspace(topicDir);
      } catch (error) {
        this.failSubject(null, error, errors);
      }
    }
    for (const name of listDirectories(workRoot(this.root))) {
      const issueDir = join(workRoot(this.root), name);
      if (!existsSync(join(issueDir, TOPIC_MIGRATION_INTENT))) continue;
      const release = this.options.locker.tryAcquire(name);
      if (!release) continue;
      try {
        this.fence();
        await topics.recoverIssueWorkspace(issueDir);
      } catch (error) {
        this.failSubject(null, error, errors);
      } finally {
        release();
      }
    }
  }

  /**
   * A topic workspace that no active conversation is bound to is deleted after `orphan_ttl_ms`.
   * Its repositories are inspected like any other tree's: unsaved work in a linked worktree is saved
   * as a snapshot ref, unsaved work in a standalone clone keeps the workspace.
   */
  private async removeExpiredTopics(errors: StorageReport["errors"]): Promise<void> {
    const topics = this.options.topics;
    if (!topics) return;
    const policy = this.options.policyFor(topics.workspaceId);
    for (const name of listDirectories(topicsRoot(this.root))) {
      const topicDir = join(topicsRoot(this.root), name);
      const idle = () => this.now() - (lstatSync(topicDir, { throwIfNoEntry: false })?.mtimeMs ?? this.now()) > policy.orphan_ttl_ms;
      try {
        if (!idle()) continue;
        await this.options.locker.runExclusive(topicLifecycleKey(name), async () => {
          // A conversation may have bound the directory, or touched it, while the lock was awaited.
          if (!idle() || topics.lifecycle.isTopicWorkspaceBound(topicDir)) return;
          const tree = await inspectTree(topicDir, this.inspectOptions(policy));
          const blocker = treeBlocker(tree);
          if (blocker) throw new KeepSubject(blocker.reason, blocker.message);
          const saved = await snapshotTree(tree, {
            subjectRef: `topic/${name}`,
            maxBytes: policy.snapshot_max_bytes,
            now: new Date(this.now()),
            dirOf: (repository) => repository.relative,
            before: () => this.fence(),
          });
          for (const snapshot of saved) log.info(`Removing topic workspace ${name}; its unsaved work stays at ${snapshot.ref}`);
          this.fence();
          await removeOwnedDirectory(this.root, topicDir, { assertRootOwner: this.options.assertRootOwner });
          await this.pruneRepositories(sharedRepositories([tree]));
          log.info(`Removed unbound topic workspace ${name}`);
        });
      } catch (error) {
        if (error instanceof KeepSubject) errors.push({ subject_id: null, message: error.message });
        else this.failSubject(null, toKeep(error), errors);
      }
    }
  }

  /**
   * `legacy-<date>` directories left by the layout sweep go after `legacyKeepDays`.
   * What the sweep could not snapshot (`retained/` and its list) is the only copy
   * of unsaved work: everything beside it goes, and it stays for an operator.
   */
  private async removeExpiredLegacy(errors: StorageReport["errors"]): Promise<void> {
    try {
      for (const name of readdirSync(this.root)) {
        const match = LEGACY_DIRECTORY.exec(name);
        if (!match) continue;
        const movedOn = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (this.now() - movedOn <= this.options.legacyKeepDays * DAY_MS) continue;
        const directory = legacyEntryPath(this.root, name);
        const kept: ReadonlySet<string> = new Set([LEGACY_RETAINED_DIRECTORY, LEGACY_RETAINED_LIST]);
        // Only the anchored removal may judge anything that is not a plain directory, e.g. a link out of the root.
        const keeps = directoryExists(directory) && readdirSync(directory).some((entry) => kept.has(entry));
        if (!keeps) {
          this.fence();
          await removeOwnedDirectory(this.root, directory, { assertRootOwner: this.options.assertRootOwner });
          log.info(`Removed ${name}`);
          continue;
        }
        for (const entry of readdirSync(directory)) {
          if (kept.has(entry)) continue;
          this.fence();
          await removeOwnedPath(this.root, join(directory, entry), { assertRootOwner: this.options.assertRootOwner });
        }
        log.info(`Removed ${name} except the worktrees kept for an operator`);
      }
    } catch (error) {
      this.failSubject(null, error, errors);
    }
  }

  private async pruneSharedRepositories(errors: StorageReport["errors"]): Promise<void> {
    const reposRoot = this.options.repoCacheRoot ?? sharedReposRoot(this.root);
    try {
      const barePaths: string[] = [];
      for (const workspace of readdirSync(reposRoot, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue;
        for (const repo of readdirSync(join(reposRoot, workspace.name), { withFileTypes: true })) {
          if (repo.isDirectory() && repo.name.endsWith(".git")) barePaths.push(join(reposRoot, workspace.name, repo.name));
        }
      }
      this.fence();
      await this.pruneRepositories(barePaths);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.failSubject(null, error, errors);
    }
  }

  /** Worktrees kept below `legacy-<date>/retained/` that nobody has dealt with yet. */
  private countLegacyRetained(errors: StorageReport["errors"]): number {
    let count = 0;
    try {
      for (const name of readdirSync(this.root)) {
        if (!LEGACY_DIRECTORY.test(name)) continue;
        const directory = legacyEntryPath(this.root, name);
        try {
          count += countRetainedWorktrees(directory);
        } catch (error) {
          errors.push({ subject_id: null, message: `retained legacy worktrees of ${name}: ${errorMessage(error)}` });
        }
      }
    } catch (error) {
      this.failSubject(null, error, errors);
    }
    return count;
  }
}

/**
 * What the record's snapshot still has to report. Entries of a lane (their place
 * is below `env/`) can never be taken back; a reclaim only reports them, once, so
 * a record that was reclaimed already has.
 */
function unreportedSnapshot(record: SubjectRecord): SubjectSnapshot | null {
  const snapshot = record.snapshot;
  if (!snapshot || record.state !== "reclaimed") return snapshot;
  const git = snapshot.git.filter((entry) => !isLaneSnapshotDir(record.subject, entry.dir));
  return git.length || snapshot.wiki_files ? { ...snapshot, git } : null;
}

/**
 * Saved work of an earlier reclaim that nobody has taken back yet (a reopened
 * Chat checks repositories out on demand) must outlive the next reclaim. What
 * stands checked out now is saved afresh instead.
 */
function carriedSnapshots(earlier: SubjectSnapshot | null, work: TreeInspection | null): SubjectGitSnapshot[] {
  const checkedOut = new Set((work?.repositories ?? []).map((repository) => repository.relative));
  return (earlier?.git ?? []).filter((entry) => !checkedOut.has(entry.dir));
}

function examinedTrees(examination: Examination): TreeInspection[] {
  return examination.work ? [examination.work, ...examination.lanes] : examination.lanes;
}

/** Map a snapshot or git check failure to the reason the subject is kept; anything else is a plain error. */
function toKeep(error: unknown): unknown {
  if (error instanceof SnapshotFailedError) return new KeepSubject("snapshot_failed", error.message, { cause: error });
  if (error instanceof GitCheckFailedError) return new KeepSubject("git_check_failed", error.message, { cause: error });
  return error;
}

/** A plan item carries no size: how much a subject occupies is not measured inside a round. */
function planItem(subject: StorageSubjectRef, outcome: SubjectOutcome, unsavedWork: boolean): StoragePlanItem {
  return { subject: { kind: subject.kind, id: subject.id }, action: outcome.action, reason: outcome.reason, bytes: null, unsaved_work: unsavedWork };
}

/** An execution used the subject after its last reclaim, so the reclaim no longer describes the disk. */
function usedSinceReclaim(record: SubjectRecord): boolean {
  return Date.parse(record.last_used_at) > Date.parse(record.reclaimed_at ?? "");
}

function listDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function directoryExists(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info?.isDirectory() === true && !info.isSymbolicLink();
}

function httpStatus(error: unknown): number | null {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
}

function parseTime(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
