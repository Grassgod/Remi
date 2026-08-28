import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as sessions from "@shared/db/sessions.js";
import type { IssueWorkspaceLifecycleLocker } from "./lifecycle-lock.js";

export const TOPIC_WORKSPACE_ROOT = "_topics";
export const TOPIC_MIGRATION_INTENT = ".migration-intent.json";
export const TOPIC_TASK_DOSSIER = join(".multiremi", "task.json");
const PREPARED_INTENT_STALE_MS = 10 * 60 * 1000;

export interface TopicMigrationIntent {
  version: 1;
  migration_id: string;
  state: "prepared" | "migrating" | "returning";
  topic_id: string;
  session_key: string;
  topic_cwd: string;
  issue_id?: string;
  issue_key?: string;
  issue_cwd?: string;
  created_at: string;
}

export interface TopicTaskDossier {
  version: 1;
  kind: "feishu_topic_issue";
  topic_id: string;
  session_key: string;
  topic_cwd: string;
  issue_id: string;
  issue_key: string;
  issue_cwd: string;
  bound_at: string;
}

export interface TopicWorkspaceLifecycleOptions {
  root: string;
  locker: IssueWorkspaceLifecycleLocker;
  assertRootOwner?: () => void;
  renameDirectory?: (source: string, target: string) => void;
  beforeSessionCommit?: () => void;
}

export interface PreparedTopicMigration {
  bound: boolean;
  migration_id?: string;
  topic_id?: string;
  session_key?: string;
  topic_cwd?: string;
  state?: TopicMigrationIntent["state"];
  issue_id?: string;
  issue_key?: string;
}

export interface CommittedTopicMigration {
  migrated: true;
  issue_id: string;
  issue_key: string;
  path: string;
  session_key: string;
  topic_id: string;
}

export class TopicWorkspaceLifecycle {
  readonly root: string;
  readonly topicsRoot: string;
  private readonly locker: IssueWorkspaceLifecycleLocker;
  private readonly assertRootOwner: () => void;
  private readonly renameDirectory: (source: string, target: string) => void;
  private readonly beforeSessionCommit?: () => void;

  constructor(options: TopicWorkspaceLifecycleOptions) {
    this.root = resolve(options.root);
    this.topicsRoot = join(this.root, TOPIC_WORKSPACE_ROOT);
    this.locker = options.locker;
    this.assertRootOwner = options.assertRootOwner ?? (() => {});
    this.renameDirectory = options.renameDirectory ?? renameSync;
    this.beforeSessionCommit = options.beforeSessionCommit;
  }

  async ensureTopicWorkspace(sessionKey: string, topicId: string): Promise<string | null> {
    const id = safeSegment(topicId, "topic id");
    const topicCwd = join(this.topicsRoot, id);
    return this.locker.runExclusive(topicLifecycleKey(id), async () => {
      this.assertRootOwner();
      const current = sessions.getSession(sessionKey);
      if (current?.cwd && current.cwd !== topicCwd) return null;
      const existed = existsSync(topicCwd);
      if (!existed) mkdirSync(topicCwd, { recursive: true, mode: 0o700 });
      try {
        const result = sessions.ensureTopicSessionBinding(sessionKey, topicCwd);
        if (!result.bound) {
          if (!existed) rmSync(topicCwd, { recursive: true, force: true });
          return null;
        }
        this.assertRootOwner();
        return topicCwd;
      } catch (error) {
        if (!existed) rmSync(topicCwd, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async prepareMigration(cwd: string): Promise<PreparedTopicMigration> {
    const topic = this.topicFromCwd(cwd);
    if (!topic) return { bound: false };
    return this.locker.runExclusive(topicLifecycleKey(topic.topicId), async () => {
      this.assertRootOwner();
      const owners = sessions.getSessionsByCwd(topic.cwd);
      if (owners.length === 0) return { bound: false };
      if (owners.length !== 1) {
        throw new Error(`Topic workspace ${topic.cwd} has ${owners.length} session owners`);
      }
      const existing = readIntent(topic.cwd);
      const intent: TopicMigrationIntent = existing ?? {
        version: 1,
        migration_id: randomUUID(),
        state: "prepared",
        topic_id: topic.topicId,
        session_key: owners[0]!.session_key,
        topic_cwd: topic.cwd,
        created_at: new Date().toISOString(),
      };
      if (!existing) writeJsonDurably(join(topic.cwd, TOPIC_MIGRATION_INTENT), intent);
      this.assertRootOwner();
      return {
        bound: true,
        migration_id: intent.migration_id,
        topic_id: intent.topic_id,
        session_key: intent.session_key,
        topic_cwd: intent.topic_cwd,
        state: intent.state,
        issue_id: intent.issue_id,
        issue_key: intent.issue_key,
      };
    });
  }

  async cancelPreparedMigration(cwd: string, migrationId: string): Promise<void> {
    const topic = this.topicFromCwd(cwd);
    if (!topic) return;
    await this.locker.runExclusive(topicLifecycleKey(topic.topicId), async () => {
      const intent = readIntent(topic.cwd);
      if (intent?.migration_id === migrationId && intent.state === "prepared") {
        removeFileDurably(join(topic.cwd, TOPIC_MIGRATION_INTENT));
      }
    });
  }

  async commitMigration(input: {
    cwd: string;
    migrationId: string;
    issueId: string;
    issueKey: string;
  }): Promise<CommittedTopicMigration> {
    const issueId = input.issueId.trim();
    if (!issueId) throw new Error("issue id is required");
    const issueKey = safeSegment(input.issueKey, "issue key");
    const topic = this.topicFromCwd(input.cwd);
    if (!topic) throw new Error(`Current directory is not a topic workspace: ${input.cwd}`);
    return this.locker.runExclusive(issueId, () =>
      this.locker.runExclusive(topicLifecycleKey(topic.topicId), async () => {
        this.assertRootOwner();
        const issueCwd = join(this.root, issueKey);
        if (!existsSync(topic.cwd) && existsSync(issueCwd)) {
          const dossier = readDossier(issueCwd);
          if (dossier?.issue_id === issueId && dossier.topic_cwd === topic.cwd) {
            return this.finishRecoveredMigration(issueCwd, dossier);
          }
        }
        const intent = readIntent(topic.cwd);
        if (!intent || intent.migration_id !== input.migrationId) {
          throw new Error(`Topic migration intent ${input.migrationId} was not found in ${topic.cwd}`);
        }
        if (
          (intent.issue_id && intent.issue_id !== issueId)
          || (intent.issue_key && intent.issue_key !== issueKey)
        ) {
          throw new Error(
            `Topic migration ${intent.migration_id} already belongs to ${intent.issue_key ?? intent.issue_id}`,
          );
        }
        if (intent.session_key !== sessions.getSessionsByCwd(topic.cwd)[0]?.session_key) {
          throw new Error(`Topic session ownership changed before migration: ${topic.cwd}`);
        }
        if (existsSync(issueCwd)) {
          const dossier = readDossier(issueCwd);
          if (dossier?.issue_id === issueId && dossier.session_key === intent.session_key) {
            return this.finishRecoveredMigration(issueCwd, dossier);
          }
          throw new Error(`Issue workspace already exists: ${issueCwd}`);
        }
        const migrating: TopicMigrationIntent = {
          ...intent,
          state: "migrating",
          issue_id: issueId,
          issue_key: issueKey,
          issue_cwd: issueCwd,
        };
        writeJsonDurably(join(topic.cwd, TOPIC_MIGRATION_INTENT), migrating);
        writeJsonDurably(join(topic.cwd, ".multiremi", "gc.json"), {
          version: 2,
          kind: "issue",
          issue_id: issueId,
          task_id: null,
        });

        let moved = false;
        try {
          moveDirectoryDurably(this.root, topic.cwd, issueCwd, this.renameDirectory);
          moved = true;
          const dossier = dossierFromIntent(migrating);
          writeDossier(issueCwd, dossier);
          this.beforeSessionCommit?.();
          sessions.moveSessionCwdAndClearId(intent.session_key, topic.cwd, issueCwd);
          try { removeFileDurably(join(issueCwd, TOPIC_MIGRATION_INTENT)); } catch {}
          this.assertRootOwner();
          return migrationResult(dossier);
        } catch (error) {
          if (moved && existsSync(issueCwd) && !existsSync(topic.cwd)) {
            moveDirectoryDurably(this.root, issueCwd, topic.cwd, this.renameDirectory);
          }
          removeDossierBinding(topic.cwd);
          rmSync(join(topic.cwd, ".multiremi", "gc.json"), { force: true });
          throw new Error(
            `Issue ${issueKey} was created, but topic migration failed. Retry with: remi issue bind-topic ${issueKey}`,
            { cause: error },
          );
        }
      }),
    );
  }

  async recoverTopicWorkspace(topicCwd: string): Promise<boolean> {
    const intent = readIntent(topicCwd);
    if (!intent) return false;
    if (intent.state === "prepared" || !intent.issue_id || !intent.issue_key) {
      const createdAt = Date.parse(intent.created_at);
      if (Number.isFinite(createdAt) && Date.now() - createdAt < PREPARED_INTENT_STALE_MS) return false;
      await this.cancelPreparedMigration(topicCwd, intent.migration_id);
      return false;
    }
    if (intent.state === "migrating") {
      await this.commitMigration({
        cwd: topicCwd,
        migrationId: intent.migration_id,
        issueId: intent.issue_id,
        issueKey: intent.issue_key,
      });
      return true;
    }
    await this.finalizeReturnedTopic(topicCwd, intent);
    return false;
  }

  async recoverIssueWorkspace(issueCwd: string): Promise<boolean> {
    const intent = readIntent(issueCwd);
    if (!intent || intent.state !== "migrating" || !intent.issue_id || !intent.issue_key) return false;
    return this.locker.runExclusive(topicLifecycleKey(intent.topic_id), async () => {
      this.assertRootOwner();
      const dossier = dossierFromIntent(intent);
      writeDossier(issueCwd, dossier);
      const row = sessions.getSession(intent.session_key);
      if (row?.cwd === intent.topic_cwd) {
        this.beforeSessionCommit?.();
        sessions.moveSessionCwdAndClearId(intent.session_key, intent.topic_cwd, issueCwd);
      } else if (row?.cwd !== issueCwd) {
        throw new Error(`Cannot recover topic migration for session ${intent.session_key}: cwd=${row?.cwd ?? "missing"}`);
      }
      removeFileDurably(join(issueCwd, TOPIC_MIGRATION_INTENT));
      this.assertRootOwner();
      return true;
    });
  }

  async resumeMigration(input: {
    cwd?: string;
    issueId: string;
    issueKey: string;
  }): Promise<CommittedTopicMigration> {
    const issueId = input.issueId.trim();
    if (!issueId) throw new Error("issue id is required");
    const issueKey = safeSegment(input.issueKey, "issue key");
    const cwd = input.cwd?.trim() ?? "";
    if (cwd && this.topicFromCwd(cwd)) {
      const prepared = await this.prepareMigration(cwd);
      if (!prepared.bound || !prepared.migration_id) {
        throw new Error(`Current directory is not bound to a Feishu topic: ${cwd}`);
      }
      return this.commitMigration({ cwd, migrationId: prepared.migration_id, issueId, issueKey });
    }

    const issueCwd = join(this.root, issueKey);
    if (!existsSync(issueCwd)) {
      throw new Error(`No pending topic migration was found for Issue ${issueKey}`);
    }
    return this.locker.runExclusive(issueId, async () => {
      this.assertRootOwner();
      const intent = readIntent(issueCwd);
      const existingDossier = readDossier(issueCwd);
      if (intent) {
        if (intent.issue_id !== issueId || intent.issue_key !== issueKey) {
          throw new Error(`Topic migration in ${issueCwd} belongs to another Issue`);
        }
        await this.recoverIssueWorkspace(issueCwd);
      } else if (!existingDossier) {
        throw new Error(`No pending topic migration was found for Issue ${issueKey}`);
      }
      const dossier = readDossier(issueCwd);
      if (!dossier || dossier.issue_id !== issueId || dossier.issue_key !== issueKey) {
        throw new Error(`Topic dossier in ${issueCwd} does not match Issue ${issueKey}`);
      }
      return this.locker.runExclusive(topicLifecycleKey(dossier.topic_id), async () => {
        this.assertRootOwner();
        return this.finishRecoveredMigration(issueCwd, dossier);
      });
    });
  }

  async returnTerminalIssueToTopic(issueCwd: string): Promise<boolean> {
    const dossier = readDossier(issueCwd);
    if (!dossier) return false;
    return this.locker.runExclusive(topicLifecycleKey(dossier.topic_id), async () => {
      this.assertRootOwner();
      const topicCwd = dossier.topic_cwd;
      if (existsSync(topicCwd)) {
        throw new Error(`Cannot return Issue ${dossier.issue_key}; topic workspace already exists: ${topicCwd}`);
      }
      const intent: TopicMigrationIntent = {
        version: 1,
        migration_id: randomUUID(),
        state: "returning",
        topic_id: dossier.topic_id,
        session_key: dossier.session_key,
        topic_cwd: topicCwd,
        issue_id: dossier.issue_id,
        issue_key: dossier.issue_key,
        issue_cwd: issueCwd,
        created_at: new Date().toISOString(),
      };
      writeJsonDurably(join(issueCwd, TOPIC_MIGRATION_INTENT), intent);
      let moved = false;
      try {
        moveDirectoryDurably(this.root, issueCwd, topicCwd, this.renameDirectory);
        moved = true;
        this.beforeSessionCommit?.();
        sessions.returnSessionToTopic(dossier.session_key, issueCwd, topicCwd);
      } catch (error) {
        if (moved && existsSync(topicCwd) && !existsSync(issueCwd)) {
          moveDirectoryDurably(this.root, topicCwd, issueCwd, this.renameDirectory);
        }
        throw error;
      }
      try { await this.finalizeReturnedTopic(topicCwd, intent); } catch {}
      this.assertRootOwner();
      return true;
    });
  }

  isTopicWorkspaceBound(topicCwd: string): boolean {
    const topic = this.topicFromCwd(topicCwd);
    if (!topic) return false;
    const owners = sessions.getSessionsByCwd(topic.cwd);
    if (owners.length > 1) throw new Error(`Topic workspace ${topic.cwd} has multiple session owners`);
    return owners.length === 1 && owners[0]!.status === "active";
  }

  private finishRecoveredMigration(issueCwd: string, dossier: TopicTaskDossier): CommittedTopicMigration {
    const row = sessions.getSession(dossier.session_key);
    if (row?.cwd === dossier.topic_cwd) {
      this.beforeSessionCommit?.();
      sessions.moveSessionCwdAndClearId(dossier.session_key, dossier.topic_cwd, issueCwd);
    } else if (row?.cwd !== issueCwd) {
      throw new Error(`Cannot resume topic migration for session ${dossier.session_key}`);
    }
    rmSync(join(issueCwd, TOPIC_MIGRATION_INTENT), { force: true });
    return migrationResult(dossier);
  }

  private async finalizeReturnedTopic(topicCwd: string, intent: TopicMigrationIntent): Promise<void> {
    const issueCwd = intent.issue_cwd;
    if (!issueCwd) throw new Error("return intent has no issue cwd");
    const row = sessions.getSession(intent.session_key);
    if (row?.cwd === issueCwd) {
      this.beforeSessionCommit?.();
      sessions.returnSessionToTopic(intent.session_key, issueCwd, topicCwd);
    }
    removeDossierBinding(topicCwd);
    removeFileDurably(join(topicCwd, ".multiremi", "gc.json"));
    removeFileDurably(join(topicCwd, TOPIC_MIGRATION_INTENT));
  }

  private topicFromCwd(cwd: string): { topicId: string; cwd: string } | null {
    const candidate = resolve(cwd);
    const rel = relative(this.topicsRoot, candidate);
    if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${separator()}`) || isAbsolute(rel)) return null;
    if (rel.includes(separator())) return null;
    const topicId = safeSegment(rel, "topic id");
    return { topicId, cwd: join(this.topicsRoot, topicId) };
  }
}

export function topicLifecycleKey(topicId: string): string {
  return `topic:${safeSegment(topicId, "topic id")}`;
}

export function readTopicTaskDossier(workspaceDir: string): TopicTaskDossier | null {
  return readDossier(workspaceDir);
}

export function moveDirectoryDurably(
  root: string,
  source: string,
  target: string,
  renameDirectory: (source: string, target: string) => void = renameSync,
): "rename" | "copy" {
  assertContained(root, source);
  assertContained(root, target);
  if (!lstatSync(source).isDirectory()) throw new Error(`Workspace source is not a directory: ${source}`);
  if (existsSync(target)) throw new Error(`Workspace target already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameDirectory(source, target);
    fsyncDirectory(dirname(source));
    if (dirname(target) !== dirname(source)) fsyncDirectory(dirname(target));
    return "rename";
  } catch (error) {
    if (!isExdev(error)) throw error;
  }

  const staging = `${target}.${process.pid}.${randomUUID()}.partial`;
  try {
    copyTreeDurably(source, staging);
    const sourceManifest = treeManifest(source);
    const stagingManifest = treeManifest(staging);
    if (sourceManifest !== stagingManifest) {
      throw new Error(`Cross-filesystem topic copy verification failed: ${source} -> ${target}`);
    }
    renameDirectory(staging, target);
    fsyncDirectory(dirname(target));
    rmSync(source, { recursive: true, force: false });
    fsyncDirectory(dirname(source));
    return "copy";
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(target) && existsSync(source)) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function dossierFromIntent(intent: TopicMigrationIntent): TopicTaskDossier {
  if (!intent.issue_id || !intent.issue_key || !intent.issue_cwd) {
    throw new Error("topic migration intent is missing Issue identity");
  }
  return {
    version: 1,
    kind: "feishu_topic_issue",
    topic_id: intent.topic_id,
    session_key: intent.session_key,
    topic_cwd: intent.topic_cwd,
    issue_id: intent.issue_id,
    issue_key: intent.issue_key,
    issue_cwd: intent.issue_cwd,
    bound_at: new Date().toISOString(),
  };
}

function migrationResult(dossier: TopicTaskDossier): CommittedTopicMigration {
  return {
    migrated: true,
    issue_id: dossier.issue_id,
    issue_key: dossier.issue_key,
    path: dossier.issue_cwd,
    session_key: dossier.session_key,
    topic_id: dossier.topic_id,
  };
}

function readIntent(workspaceDir: string): TopicMigrationIntent | null {
  const value = readJson(join(workspaceDir, TOPIC_MIGRATION_INTENT));
  if (!value) return null;
  if (
    value.version !== 1
    || typeof value.migration_id !== "string"
    || !["prepared", "migrating", "returning"].includes(String(value.state))
    || typeof value.topic_id !== "string"
    || typeof value.session_key !== "string"
    || typeof value.topic_cwd !== "string"
  ) throw new Error(`Invalid topic migration intent in ${workspaceDir}`);
  return value as unknown as TopicMigrationIntent;
}

function readDossier(workspaceDir: string): TopicTaskDossier | null {
  const value = readJson(join(workspaceDir, TOPIC_TASK_DOSSIER));
  if (!value) return null;
  // task.json is shared with the provider task context. Keep the topic binding
  // in a named child so later task-context refreshes cannot overwrite it.
  const candidate = isRecord(value.topic_binding)
    ? value.topic_binding
    : value.kind === "feishu_topic_issue"
      ? value
      : null;
  if (!candidate) return null;
  if (
    candidate.version !== 1
    || candidate.kind !== "feishu_topic_issue"
    || typeof candidate.topic_id !== "string"
    || typeof candidate.session_key !== "string"
    || typeof candidate.topic_cwd !== "string"
    || typeof candidate.issue_id !== "string"
    || typeof candidate.issue_key !== "string"
    || typeof candidate.issue_cwd !== "string"
  ) throw new Error(`Invalid topic task dossier in ${workspaceDir}`);
  return candidate as unknown as TopicTaskDossier;
}

function writeDossier(workspaceDir: string, dossier: TopicTaskDossier): void {
  const path = join(workspaceDir, TOPIC_TASK_DOSSIER);
  const existing = readJson(path) ?? {};
  writeJsonDurably(path, { ...existing, topic_binding: dossier });
}

function removeDossierBinding(workspaceDir: string): void {
  const path = join(workspaceDir, TOPIC_TASK_DOSSIER);
  const existing = readJson(path);
  if (!existing) return;
  if (existing.kind === "feishu_topic_issue") {
    removeFileDurably(path);
    return;
  }
  if (!("topic_binding" in existing)) return;
  delete existing.topic_binding;
  if (Object.keys(existing).length === 0) removeFileDurably(path);
  else writeJsonDurably(path, existing);
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function writeJsonDurably(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.partial`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function removeFileDurably(path: string): void {
  rmSync(path, { force: true });
  if (existsSync(dirname(path))) fsyncDirectory(dirname(path));
}

function copyTreeDurably(source: string, target: string): void {
  const info = lstatSync(source);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: false, mode: info.mode & 0o777 });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copyTreeDurably(join(source, entry.name), join(target, entry.name));
    }
    fsyncDirectory(target);
    return;
  }
  if (info.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported workspace entry during copy: ${source}`);
  copyFileSync(source, target);
  const fd = openSync(target, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function treeManifest(root: string): string {
  const rows: string[] = [];
  const visit = (path: string, rel: string) => {
    const info = lstatSync(path);
    if (info.isDirectory()) {
      rows.push(`d:${rel}`);
      for (const entry of readdirSync(path).sort()) visit(join(path, entry), rel ? `${rel}/${entry}` : entry);
    } else if (info.isSymbolicLink()) {
      rows.push(`l:${rel}:${readlinkSync(path)}`);
    } else if (info.isFile()) {
      rows.push(`f:${rel}:${info.size}:${hashFile(path)}`);
    } else {
      throw new Error(`Unsupported workspace entry during verification: ${path}`);
    }
  };
  visit(root, "");
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function assertContained(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${separator()}`) || isAbsolute(rel)) {
    throw new Error(`Workspace path escapes or replaces root: ${path}`);
  }
}

function safeSegment(value: string, label: string): string {
  const result = value.trim();
  if (!result || result === "." || result === ".." || basename(result) !== result || !/^[A-Za-z0-9._-]+$/.test(result)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return result;
}

function separator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function isExdev(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EXDEV");
}
