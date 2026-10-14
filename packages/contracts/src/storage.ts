/**
 * Storage retention contract (ADR 0018).
 *
 * Issues and Chats share one retention model on the daemon: the workspace is a
 * cache that is reclaimed after the subject ends and restored from a snapshot
 * when it reopens, while records (traces, native session history) stay. This
 * module holds the wire shapes of that model: the workspace policy
 * (`settings.storage`), the per-subject snapshot, the daemon storage report and
 * the on-demand GC run request.
 */

/** What owns a daemon workspace. `task` is the fallback for executions with neither Issue nor Chat. */
export type StorageSubjectKind = "issue" | "chat" | "task";

export const STORAGE_SUBJECT_KINDS = ["issue", "chat", "task"] as const;

export interface StorageSubjectRef {
  kind: StorageSubjectKind;
  id: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Workspace setting `settings.storage`. Every key is optional on the wire (absent = default). */
export interface StorageSettings {
  /** Retention after an Issue or Chat ends before its workspace is reclaimed. */
  ttl_ms: number;
  /** Same as `ttl_ms` for Chats opened by an automation run. */
  automation_ttl_ms: number;
  /** Ended subjects allowed to keep a workspace; the least recently used are reclaimed beyond it. 0 = no cap. */
  max_retained: number;
  /** How long a daemon keeps data of a subject the server no longer knows. */
  orphan_ttl_ms: number;
  /** Largest unsaved work (changed and untracked files) a snapshot may capture. */
  snapshot_max_bytes: number;
  /** Days without activity before an active Chat is archived. 0 = never. */
  chat_idle_days: number;
}

export const STORAGE_SETTINGS_KEYS = [
  "ttl_ms",
  "automation_ttl_ms",
  "max_retained",
  "orphan_ttl_ms",
  "snapshot_max_bytes",
  "chat_idle_days",
] as const satisfies readonly (keyof StorageSettings)[];

export const STORAGE_SETTINGS_DEFAULTS: StorageSettings = {
  ttl_ms: 72 * HOUR_MS,
  automation_ttl_ms: 24 * HOUR_MS,
  max_retained: 50,
  orphan_ttl_ms: 72 * HOUR_MS,
  snapshot_max_bytes: 256 * MIB,
  chat_idle_days: 14,
};

export const STORAGE_SETTINGS_BOUNDS: Record<keyof StorageSettings, { min: number; max: number }> = {
  ttl_ms: { min: HOUR_MS, max: 365 * DAY_MS },
  automation_ttl_ms: { min: HOUR_MS, max: 365 * DAY_MS },
  max_retained: { min: 0, max: 10_000 },
  orphan_ttl_ms: { min: HOUR_MS, max: 365 * DAY_MS },
  snapshot_max_bytes: { min: MIB, max: 10 * GIB },
  chat_idle_days: { min: 0, max: 3650 },
};

const INTEGER_KEYS: ReadonlySet<keyof StorageSettings> = new Set(["max_retained", "chat_idle_days"]);

function storageSettingValid(key: keyof StorageSettings, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (INTEGER_KEYS.has(key) && !Number.isInteger(value)) return false;
  const { min, max } = STORAGE_SETTINGS_BOUNDS[key];
  return value >= min && value <= max;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge a raw `settings.storage` value with the defaults; invalid or out-of-range values fall back. */
export function resolveStorageSettings(raw: unknown): StorageSettings {
  const source = isPlainRecord(raw) ? raw : {};
  const resolved = { ...STORAGE_SETTINGS_DEFAULTS };
  for (const key of STORAGE_SETTINGS_KEYS) {
    const value = source[key];
    if (storageSettingValid(key, value)) resolved[key] = value;
  }
  return resolved;
}

/** Validate a `PUT /api/workspaces/:id/storage` body. `null` resets a key to its default. */
export function validateStorageSettingsPatch(raw: unknown): {
  patch: StorageSettingsPatch;
  errors: string[];
} {
  const patch: StorageSettingsPatch = {};
  const errors: string[] = [];
  if (!isPlainRecord(raw)) return { patch, errors: ["body must be an object"] };
  for (const [name, value] of Object.entries(raw)) {
    if (!(STORAGE_SETTINGS_KEYS as readonly string[]).includes(name)) {
      errors.push(`${name} is not a storage setting`);
      continue;
    }
    const key = name as keyof StorageSettings;
    if (value === null) {
      patch[key] = null;
    } else if (storageSettingValid(key, value)) {
      patch[key] = value;
    } else {
      const { min, max } = STORAGE_SETTINGS_BOUNDS[key];
      errors.push(`${key} must be ${INTEGER_KEYS.has(key) ? "an integer" : "a number"} between ${min} and ${max}`);
    }
  }
  return { patch, errors };
}

/** One repository's saved state when a workspace is reclaimed. */
export interface SubjectGitSnapshot {
  repo_url: string;
  /** `refs/remi/snapshots/<subject>/<n>` in the shared bare repository. */
  ref: string;
  /** Snapshot commit; equals `head` when only unpushed commits existed. */
  commit: string;
  /** Worktree HEAD when it was reclaimed. */
  head: string;
  branch: string | null;
  /**
   * Where the worktree stood: the path below `work/<subject>/` (`.` for the directory itself).
   * A worktree outside it, in a lane's work set below `env/`, is recorded by its path below the
   * workspaces root instead. Restore finds the worktree again by this alone, never by `repo_url`.
   */
  dir: string;
}

export interface SubjectSnapshot {
  created_at: string;
  git: SubjectGitSnapshot[];
  /** Changed or deleted wiki files saved beside the registry record. */
  wiki_files: number;
}

export type StorageRetainReason =
  | "running"
  | "pinned"
  | "not_ended"
  | "within_ttl"
  | "external_dir"
  | "snapshot_failed"
  | "git_check_failed"
  | "server_unreachable"
  /** A pre-ADR-0018 worktree whose unsaved work could not be snapshotted, kept below `legacy-<date>/retained/`. */
  | "legacy_retained"
  | "error";

export interface StoragePlanItem {
  subject: StorageSubjectRef;
  action: "reclaim" | "forget" | "keep";
  /** A `StorageRetainReason` for keep; `ended_ttl`, `over_cap` or `orphan` for reclaim and forget. */
  reason: string;
  /** Null from a daemon: a round measures no subject, the root's categories are in `StorageReport.bytes`. */
  bytes: number | null;
  unsaved_work: boolean;
}

export interface StorageReport {
  version: 1;
  generated_at: string;
  mode: "periodic" | "dry_run" | "run";
  root: string;
  /**
   * The latest completed disk measurement, taken outside the round (hourly or on request) and
   * cached by the daemon; null only until the first measurement has finished.
   */
  bytes: { work: number; env: number; traces: number; shared: number; legacy: number } | null;
  /** When `bytes` was measured; null while `bytes` is. */
  bytes_measured_at: string | null;
  subjects: { total: number; active: number; ended: number; reclaimed: number };
  retained: Partial<Record<StorageRetainReason, number>>;
  reclaimed_this_round: number;
  forgotten_this_round: number;
  /**
   * Approximate: the free space the workspaces filesystem gained while the round deleted workspaces (read twice,
   * nothing is walked). Other writers, space the filesystem frees later and compression make it differ from the bytes deleted.
   */
  freed_bytes: number;
  /** Always present; periodic rounds include only non-keep items. */
  plan: StoragePlanItem[];
  errors: Array<{ subject_id: string | null; message: string }>;
}

export type GcRunMode = "dry_run" | "run";

export type GcRunStatus = "pending" | "sent" | "running" | "completed" | "failed" | "timeout";

/** One `POST /api/runtimes/:id/gc-runs` request and, once finished, the report it produced. */
export interface GcRunRequest {
  id: string;
  runtime_id: string;
  daemon_id: string | null;
  mode: GcRunMode;
  status: GcRunStatus;
  requested_by: string | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  report: StorageReport | null;
}

/** `PUT /api/workspaces/:id/storage` body; `null` resets a key to its default. */
export type StorageSettingsPatch = Partial<Record<keyof StorageSettings, number | null>>;

/** `GET` and `PUT /api/workspaces/:id/storage`: `settings` is effective, `overrides` is what the workspace sets. */
export interface WorkspaceStorageResponse {
  settings: StorageSettings;
  overrides: Partial<StorageSettings>;
}

/** One daemon's row in `GET /api/workspaces/:id/storage/daemons`. */
export interface WorkspaceStorageDaemon {
  daemon_id: string;
  name: string;
  runtime_ids: string[];
  online: boolean;
  /** Latest report from this daemon; null when it never sent one. */
  report: StorageReport | null;
  reported_at: string | null;
}

export interface WorkspaceStorageDaemonsResponse {
  daemons: WorkspaceStorageDaemon[];
}

/** `POST /api/runtimes/:id/gc-runs` body. */
export interface CreateGcRunInput {
  mode: GcRunMode;
}
