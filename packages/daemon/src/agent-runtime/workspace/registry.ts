/**
 * Subject registry (ADR 0018): one small JSON record per Issue, Chat or task
 * that owns something on this daemon. It replaces the scattered `gc.json`
 * markers; reclaim reads only this directory and never walks the workspace tree.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  STORAGE_SUBJECT_KINDS,
  type StorageSubjectKind,
  type StorageSubjectRef,
  type SubjectSnapshot,
} from "@multiremi/contracts/storage.js";
import { registryFile, registryRoot, registrySnapshotDirectory } from "./layout.js";

export type SubjectRecordState = "active" | "reclaimed";

export interface SubjectRecordRepo {
  repo_url: string;
  /** Path of the worktree below `work/<subject>/` (`.` for the directory itself). */
  dir: string;
  branch: string | null;
}

export interface SubjectRecord {
  version: 1;
  subject: StorageSubjectRef;
  workspace_id: string;
  /** Issue key for Issue subjects; the branch of an Issue is `agent/<issue_key>`. */
  issue_key: string | null;
  /** A user-registered directory the subject runs in; never reclaimed, never written to. */
  external_work_dir: string | null;
  repos: SubjectRecordRepo[];
  state: SubjectRecordState;
  last_used_at: string;
  created_at: string;
  reclaimed_at: string | null;
  snapshot: SubjectSnapshot | null;
}

export interface SubjectRecordUpsert {
  subject: StorageSubjectRef;
  workspace_id: string;
  issue_key?: string | null;
  external_work_dir?: string | null;
  /** Replaces the recorded repositories when given; omitted keeps them. */
  repos?: SubjectRecordRepo[];
  now?: Date;
}

/**
 * Record that a subject is being used. Creates the record on first use and
 * otherwise only refreshes the fields the caller knows; `state` and `snapshot`
 * belong to reclaim and restore and are never changed here.
 */
export function upsertSubjectRecord(root: string, input: SubjectRecordUpsert): SubjectRecord {
  const now = (input.now ?? new Date()).toISOString();
  const previous = readSubjectRecord(root, input.subject);
  const record: SubjectRecord = {
    version: 1,
    subject: { kind: input.subject.kind, id: input.subject.id },
    workspace_id: input.workspace_id,
    issue_key: input.issue_key !== undefined ? input.issue_key : previous?.issue_key ?? null,
    external_work_dir: input.external_work_dir !== undefined
      ? input.external_work_dir
      : previous?.external_work_dir ?? null,
    repos: input.repos ?? previous?.repos ?? [],
    state: previous?.state ?? "active",
    last_used_at: now,
    created_at: previous?.created_at ?? now,
    reclaimed_at: previous?.reclaimed_at ?? null,
    snapshot: previous?.snapshot ?? null,
  };
  writeSubjectRecord(root, record);
  return record;
}

/**
 * Change a record that exists, from its current content. The read and the write
 * share one synchronous step, so a change made across an `await` (restore) can
 * never write back a stale copy over a concurrent `upsertSubjectRecord`.
 * Returns null when the subject has no record.
 */
export function updateSubjectRecord(
  root: string,
  subject: StorageSubjectRef,
  change: (current: SubjectRecord) => SubjectRecord,
): SubjectRecord | null {
  const current = readSubjectRecord(root, subject);
  if (!current) return null;
  const next = change(current);
  writeSubjectRecord(root, next);
  return next;
}

/** Null when the subject has no record; throws on a record that cannot be trusted. */
export function readSubjectRecord(root: string, subject: StorageSubjectRef): SubjectRecord | null {
  const path = registryFile(root, subject);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseSubjectRecord(text, path);
}

/** Every valid record; an unreadable one is reported and skipped, never fatal. */
export function listSubjectRecords(
  root: string,
  onInvalid?: (path: string, error: unknown) => void,
): SubjectRecord[] {
  const directory = registryRoot(root);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: SubjectRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    try {
      records.push(parseSubjectRecord(readFileSync(path, "utf8"), path));
    } catch (error) {
      onInvalid?.(path, error);
    }
  }
  return records;
}

/** Atomic replace: readers see the old or the new record, never a partial one. */
export function writeSubjectRecord(root: string, record: SubjectRecord): void {
  const path = registryFile(root, record.subject);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Forget a subject: its record and the snapshot files kept beside it. */
export function deleteSubjectRecord(root: string, subject: StorageSubjectRef): void {
  rmSync(registryFile(root, subject), { force: true });
  const snapshot = registrySnapshotDirectory(root, subject);
  if (existsSync(snapshot)) rmSync(snapshot, { recursive: true, force: true });
}

function parseSubjectRecord(text: string, path: string): SubjectRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Subject record is not valid JSON: ${path}`, { cause: error });
  }
  if (!isRecord(value) || value.version !== 1) throw new Error(`Subject record has an unsupported version: ${path}`);
  const subject = value.subject;
  if (!isRecord(subject) || !isSubjectKind(subject.kind) || typeof subject.id !== "string" || !subject.id) {
    throw new Error(`Subject record has an invalid subject: ${path}`);
  }
  if (value.state !== "active" && value.state !== "reclaimed") {
    throw new Error(`Subject record has an invalid state: ${path}`);
  }
  if (typeof value.workspace_id !== "string" || typeof value.last_used_at !== "string"
    || typeof value.created_at !== "string" || !Array.isArray(value.repos)) {
    throw new Error(`Subject record is incomplete: ${path}`);
  }
  for (const repo of value.repos) {
    if (!isRecord(repo) || typeof repo.repo_url !== "string" || typeof repo.dir !== "string"
      || (repo.branch !== null && typeof repo.branch !== "string")) {
      throw new Error(`Subject record has an invalid repository: ${path}`);
    }
  }
  return {
    version: 1,
    subject: { kind: subject.kind, id: subject.id },
    workspace_id: value.workspace_id,
    issue_key: typeof value.issue_key === "string" ? value.issue_key : null,
    external_work_dir: typeof value.external_work_dir === "string" ? value.external_work_dir : null,
    repos: value.repos as SubjectRecordRepo[],
    state: value.state,
    last_used_at: value.last_used_at,
    created_at: value.created_at,
    reclaimed_at: typeof value.reclaimed_at === "string" ? value.reclaimed_at : null,
    snapshot: isRecord(value.snapshot) ? value.snapshot as unknown as SubjectSnapshot : null,
  };
}

function isSubjectKind(value: unknown): value is StorageSubjectKind {
  return (STORAGE_SUBJECT_KINDS as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
