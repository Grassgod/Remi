import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STORAGE_SETTINGS_DEFAULTS, type StorageSettings, type StorageSubjectRef } from "@multiremi/contracts/storage.js";
import type { DaemonGcSubjectReclaimedPayload } from "@multiremi/contracts/daemon-protocol.js";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import {
  ReclaimEngine,
  type ReclaimCheckReply,
  type ReclaimClient,
  type ReclaimEngineOptions,
} from "@daemon/agent-runtime/workspace/reclaim.js";
import {
  upsertSubjectRecord,
  readSubjectRecord,
  writeSubjectRecord,
  type SubjectRecord,
} from "@daemon/agent-runtime/workspace/registry.js";
import {
  envDirectory,
  laneGenerationDirectory,
  sharedReposRoot,
  workDirectory,
} from "@daemon/agent-runtime/workspace/layout.js";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const REPO_URL = "https://example.test/repo.git";
/** The worktree directory `worktreeDirectoryName(REPO_URL)` gives. */
export const REPO_DIR = "repo";

const roots: string[] = [];

export function cleanupFixtures(): void {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A test that failed halfway can leave read-only trees (an intake workspace) behind.
      execFileSync("chmod", ["-R", "u+rwx", root]);
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
  }).trim();
}

/** A fake server: per-subject answers, with every call recorded. */
export class FakeServer implements ReclaimClient {
  readonly checks: string[] = [];
  readonly reclaimed: DaemonGcSubjectReclaimedPayload[] = [];
  private readonly answers = new Map<string, ReclaimCheckReply | "gone" | "down">();
  /** When set, `gc.subject_reclaimed` fails with it. */
  reportFailure: unknown = null;

  answer(subjectId: string, reply: ReclaimCheckReply | "gone" | "down"): void {
    this.answers.set(subjectId, reply);
  }

  private async check(subjectId: string): Promise<ReclaimCheckReply> {
    this.checks.push(subjectId);
    const answer = this.answers.get(subjectId) ?? "down";
    if (answer === "gone") throw Object.assign(new Error("not found"), { status: 404 });
    if (answer === "down") throw new Error("connection lost");
    return answer;
  }

  getIssueGcCheck = (id: string) => this.check(id);
  getChatSessionGcCheck = (id: string) => this.check(id);
  getTaskGcCheck = (id: string) => this.check(id);

  async reportSubjectReclaimed(payload: DaemonGcSubjectReclaimedPayload): Promise<void> {
    if (this.reportFailure) throw this.reportFailure;
    this.reclaimed.push(payload);
  }
}

export interface ReclaimFixture {
  /** The workspaces root. */
  root: string;
  /** Origin remote, the shared bare repository, and the root of scratch files. */
  scratch: string;
  bare: string;
  server: FakeServer;
  locker: IssueWorkspaceLifecycleLocker;
  policy: StorageSettings;
  now: number;
  engine(overrides?: Partial<ReclaimEngineOptions>): ReclaimEngine;
  /** Register a subject in the registry, last used `usedAgoMs` ago. */
  subject(subject: StorageSubjectRef, options?: { usedAgoMs?: number; issueKey?: string; externalWorkDir?: string; state?: "active" | "reclaimed" }): SubjectRecord;
  /** `work/<subject>/repo`, a worktree on `agent/<key>` level with origin/main. */
  worktree(subject: StorageSubjectRef, branch?: string): string;
  /** A lane generation with a provider home holding history and cache. */
  lane(subject: StorageSubjectRef, generation: number, options?: { ageMs?: number; conversation?: string }): string;
  record(subject: StorageSubjectRef): SubjectRecord | null;
}

/** A hermetic workspaces root with a shared bare repository, like the daemon's. */
export function reclaimFixture(): ReclaimFixture {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "multiremi-reclaim-")));
  roots.push(scratch);
  const root = join(scratch, "workspaces");
  mkdirSync(root, { recursive: true });
  const origin = join(scratch, "origin.git");
  const source = join(scratch, "source");
  git(scratch, ["init", "--bare", "--initial-branch=main", origin]);
  git(scratch, ["init", "--initial-branch=main", source]);
  writeFileSync(join(source, "README.md"), "initial\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "initial"]);
  git(source, ["push", origin, "main"]);
  const bare = join(sharedReposRoot(root), "local", "repo-0123456789abcdef.git");
  mkdirSync(join(sharedReposRoot(root), "local"), { recursive: true });
  git(scratch, ["clone", "--bare", origin, bare]);
  git(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  git(bare, ["fetch", "origin"]);
  git(bare, ["config", "multiremi.repository-url", REPO_URL]);

  const server = new FakeServer();
  const locker = new IssueWorkspaceLifecycleLocker();
  const now = Date.now();
  const policy: StorageSettings = { ...STORAGE_SETTINGS_DEFAULTS };

  const fixture: ReclaimFixture = {
    root, scratch, bare, server, locker, policy, now,
    engine: (overrides = {}) => new ReclaimEngine({
      root,
      client: server,
      runtimeId: () => "rt_1",
      policyFor: () => fixture.policy,
      dryRun: false,
      legacyKeepDays: 7,
      locker,
      measure: async () => 4096,
      now: () => now,
      ...overrides,
    }),
    subject(subject, options = {}) {
      upsertSubjectRecord(root, {
        subject,
        workspace_id: "local",
        issue_key: options.issueKey ?? (subject.kind === "issue" ? `MUL-${subject.id.slice(-3)}` : null),
        external_work_dir: options.externalWorkDir ?? null,
      });
      const record = readSubjectRecord(root, subject)!;
      const aged = {
        ...record,
        last_used_at: new Date(now - (options.usedAgoMs ?? 30 * DAY)).toISOString(),
        created_at: new Date(now - 60 * DAY).toISOString(),
        state: options.state ?? "active",
      };
      writeSubjectRecord(root, aged);
      return aged;
    },
    worktree(subject, branch = `agent/${subject.id}`) {
      const path = join(workDirectory(root, subject), REPO_DIR);
      mkdirSync(workDirectory(root, subject), { recursive: true });
      git(bare, ["worktree", "add", "-b", branch, path, "origin/main"]);
      return path;
    },
    lane(subject, generation, options = {}) {
      const directory = laneGenerationDirectory(root, {
        subject, conversation: options.conversation ?? subject.id, agentId: "agent_1", scope: null, generation,
      });
      mkdirSync(join(directory, "home", "projects", "-work"), { recursive: true });
      mkdirSync(join(directory, "home", "plugins", "cache"), { recursive: true });
      mkdirSync(join(directory, ".remi-runtime"), { recursive: true });
      mkdirSync(join(directory, "work"), { recursive: true });
      writeFileSync(join(directory, "home", "projects", "-work", "session.jsonl"), "{}\n");
      writeFileSync(join(directory, "home", "session_index.jsonl"), "{}\n");
      writeFileSync(join(directory, "home", "plugins", "cache", "blob"), "x".repeat(1024));
      writeFileSync(join(directory, "home", "settings.json"), "{}");
      writeFileSync(join(directory, ".remi-runtime", "state"), "x");
      if (options.ageMs !== undefined) {
        const when = new Date(now - options.ageMs);
        for (const path of [directory, join(directory, "home"), join(directory, "work"), join(directory, ".remi-runtime")]) {
          utimesSync(path, when, when);
        }
      }
      return directory;
    },
    record: (subject) => readSubjectRecord(root, subject),
  };
  return fixture;
}

export function issueEnded(updatedAgoMs = 10 * DAY): ReclaimCheckReply {
  return { status: "done", updated_at: new Date(Date.now() - updatedAgoMs).toISOString() };
}

export function envOf(f: ReclaimFixture, subject: StorageSubjectRef): string {
  return envDirectory(f.root, subject);
}

/** A clone of the origin an agent made itself: its `.git` is a directory, nothing shared backs it. */
export function cloneAt(f: ReclaimFixture, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  git(f.scratch, ["clone", join(f.scratch, "origin.git"), path]);
  return path;
}

/** A repository nobody else has: one commit and no remote, like the curated plugins Codex clones into `$CODEX_HOME/.tmp/plugins` at startup. */
export function localRepositoryAt(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--initial-branch=main"]);
  writeFileSync(join(path, "README.md"), "curated plugins\n");
  git(path, ["add", "."]);
  git(path, ["-c", "user.name=upstream", "-c", "user.email=upstream@example.test", "commit", "-m", "upstream snapshot"]);
  return path;
}

/** A worktree of the shared repository an agent added by hand. */
export function worktreeAt(f: ReclaimFixture, path: string, branch: string): string {
  mkdirSync(dirname(path), { recursive: true });
  git(f.bare, ["worktree", "add", "-b", branch, path, "origin/main"]);
  return path;
}

/** A commit in `repository` that only that repository has; `file` keeps two such commits apart. */
export function commitIn(repository: string, file = "local.txt"): string {
  writeFileSync(join(repository, file), `${file}\n`);
  git(repository, ["add", file]);
  git(repository, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", `add ${file}`]);
  return git(repository, ["rev-parse", "HEAD"]);
}

/** Make a lane generation look idle for `ageMs` again after something was added to it. */
export function ageLane(f: ReclaimFixture, lane: string, ageMs: number): void {
  const when = new Date(f.now - ageMs);
  for (const path of [lane, ...readdirSync(lane).map((name) => join(lane, name))]) utimesSync(path, when, when);
}
