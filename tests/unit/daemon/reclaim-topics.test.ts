import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StorageSubjectRef } from "@multiremi/contracts/storage.js";
import { registryFile, topicsRoot, workDirectory } from "@daemon/agent-runtime/workspace/layout.js";
import { pruneWorktrees } from "@daemon/agent-runtime/workspace/git-ops.js";
import { upsertSubjectRecord } from "@daemon/agent-runtime/workspace/registry.js";
import {
  TOPIC_MIGRATION_INTENT,
  TOPIC_TASK_DOSSIER,
  TopicWorkspaceLifecycle,
} from "@daemon/agent-runtime/workspace/topic-lifecycle.js";
import { closeDb, getDb, setDbPath } from "@shared/db/index.js";
import * as sessions from "@shared/db/sessions.js";
import { DAY, REPO_DIR, cleanupFixtures, cloneAt, commitIn, git, issueEnded, reclaimFixture, type ReclaimFixture } from "./reclaim-fixture.js";

setDefaultTimeout(30_000);

afterEach(() => {
  closeDb();
  cleanupFixtures();
});

const issue = (n: number): StorageSubjectRef => ({ kind: "issue", id: `iss_${n}` });

function topicFixture() {
  const f = reclaimFixture();
  setDbPath(join(f.scratch, "remi.db"));
  getDb();
  const lifecycle = (overrides: { beforeSessionCommit?: () => void } = {}) => new TopicWorkspaceLifecycle({
    root: f.root,
    locker: f.locker,
    beforeSessionCommit: overrides.beforeSessionCommit,
    recordMigration: (migration) => {
      upsertSubjectRecord(f.root, {
        subject: { kind: "issue", id: migration.issue_id }, workspace_id: "local", issue_key: migration.issue_key,
      });
    },
  });
  const engine = (lifecycleInstance = lifecycle(), now = f.now) => f.engine({
    now: () => now,
    topics: { lifecycle: lifecycleInstance, workspaceId: "local" },
  });
  return { f, lifecycle, engine };
}

/** A topic workspace migrated into an Issue; its record has aged past every retention. */
async function migratedIssue(f: ReclaimFixture, lifecycle: TopicWorkspaceLifecycle, n: number) {
  const sessionKey = `chat:thread:om_${n}`;
  const topic = await lifecycle.ensureTopicWorkspace(sessionKey, `om_${n}`);
  writeFileSync(join(topic!, "notes.md"), "research\n");
  const prepared = await lifecycle.prepareMigration(topic!);
  const migrated = await lifecycle.commitMigration({
    cwd: topic!, migrationId: prepared.migration_id!, issueId: `iss_${n}`, issueKey: `MUL-${n}`,
  });
  f.subject(issue(n));
  f.server.answer(`iss_${n}`, issueEnded());
  return { sessionKey, topic: topic!, migrated };
}

function age(path: string, ageMs: number, now: number): void {
  const when = new Date(now - ageMs);
  utimesSync(path, when, when);
}

describe("an ended Issue migrated from a Feishu topic", () => {
  test("a migration is known to reclaim before any execution runs in the Issue", async () => {
    const { f, lifecycle } = topicFixture();
    const topic = await lifecycle().ensureTopicWorkspace("chat:thread:om_9", "om_9");
    const service = lifecycle();
    const prepared = await service.prepareMigration(topic!);
    expect(existsSync(registryFile(f.root, issue(9)))).toBe(false);

    await service.commitMigration({ cwd: topic!, migrationId: prepared.migration_id!, issueId: "iss_9", issueKey: "MUL-9" });

    expect(JSON.parse(readFileSync(registryFile(f.root, issue(9)), "utf8"))).toMatchObject({
      subject: issue(9), workspace_id: "local", issue_key: "MUL-9", state: "active",
    });
  });

  test("returns to its topic instead of being deleted, and the topic conversation keeps working", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const service = lifecycle();
    const { sessionKey, topic, migrated } = await migratedIssue(f, service, 1);
    // Unsaved repository work travels with the directory.
    const worktree = join(migrated.path, REPO_DIR);
    git(f.bare, ["worktree", "add", "-b", "agent/topic", worktree, "origin/main"]);
    writeFileSync(join(worktree, "README.md"), "edited in the topic\n");
    f.subject(issue(1));

    const report = await engine(service, f.now).run("periodic");

    expect(existsSync(workDirectory(f.root, issue(1)))).toBe(false);
    expect(readFileSync(join(topic, "notes.md"), "utf8")).toBe("research\n");
    expect(readFileSync(join(topic, REPO_DIR, "README.md"), "utf8")).toBe("edited in the topic\n");
    expect(existsSync(join(topic, TOPIC_TASK_DOSSIER))).toBe(false);
    expect(sessions.getSession(sessionKey)?.cwd).toBe(topic);
    expect(service.isTopicWorkspaceBound(topic)).toBe(true);
    expect(await service.ensureTopicWorkspace(sessionKey, "om_1")).toBe(topic);
    // Nothing was snapshotted or freed; the record and the server learn it is reclaimed.
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(issue(1))).toMatchObject({ state: "reclaimed", snapshot: null });
    expect(f.server.reclaimed).toEqual([expect.objectContaining({
      subject: issue(1), snapshot: null, unsaved_work: false, freed_bytes: expect.any(Number),
    })]);
    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [] });
  });

  test("a dry run reports it without moving anything", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const service = lifecycle();
    const { migrated } = await migratedIssue(f, service, 1);

    const report = await engine(service).run("dry_run");

    expect(existsSync(migrated.path)).toBe(true);
    expect(report.plan).toEqual([expect.objectContaining({ subject: issue(1), action: "reclaim", bytes: null, unsaved_work: false })]);
  });

  test("stays in place while a topic workspace already exists for it", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const service = lifecycle();
    const { migrated, topic } = await migratedIssue(f, service, 1);
    mkdirSync(topic, { recursive: true });

    const report = await engine(service).run("periodic");

    expect(existsSync(migrated.path)).toBe(true);
    expect(f.record(issue(1))!.state).toBe("active");
    expect(report.errors).toEqual([{ subject_id: "iss_1", message: expect.stringContaining("topic workspace already exists") }]);
  });
});

describe("the linked worktrees of a workspace that moves between a topic and an Issue", () => {
  /** What the daemon's prune would find stale: each worktree is registered at the place it stands now. */
  function expectHealthy(f: ReclaimFixture, worktree: string): void {
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).toContain(worktree);
    expect(git(worktree, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
  }

  test("a topic Issue that returns to its topic keeps its worktrees working through the round's prune", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const service = lifecycle();
    const { topic, migrated } = await migratedIssue(f, service, 1);
    const branch = join(migrated.path, "repo-branch");
    git(f.bare, ["worktree", "add", "-b", "agent/MUL-1", branch, "origin/main"]);
    writeFileSync(join(branch, "staged.txt"), "staged only\n");
    git(branch, ["add", "staged.txt"]);
    const detached = join(migrated.path, "repo-detached");
    git(f.bare, ["worktree", "add", "--detach", detached, "origin/main"]);
    const detachedHead = commitIn(detached, "detached-work.txt");
    writeFileSync(join(detached, "README.md"), "edited in the topic\n");
    f.subject(issue(1));

    const report = await engine(service, f.now).run("periodic");

    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [] });
    expect(existsSync(workDirectory(f.root, issue(1)))).toBe(false);
    for (const name of ["repo-branch", "repo-detached"]) expectHealthy(f, join(topic, name));
    expect(git(join(topic, "repo-detached"), ["rev-parse", "HEAD"])).toBe(detachedHead);
    expect(git(join(topic, "repo-detached"), ["status", "--porcelain=v1"])).toBe("M README.md");
    expect(git(join(topic, "repo-branch"), ["status", "--porcelain=v1"])).toBe("A  staged.txt");
    // No ref names the detached commit; only its worktree's registration keeps it from the next garbage collection.
    git(f.bare, ["gc", "--prune=now", "--quiet"]);
    git(f.bare, ["cat-file", "-e", `${detachedHead}^{commit}`]);
  });

  test("a topic workspace that migrates into an Issue keeps its worktrees working through the next prune", async () => {
    const { f, lifecycle } = topicFixture();
    const service = lifecycle();
    const topic = await service.ensureTopicWorkspace("chat:thread:om_5", "om_5");
    const worktree = join(topic!, "repo");
    git(f.bare, ["worktree", "add", "-b", "topic/om_5", worktree, "origin/main"]);
    writeFileSync(join(worktree, "wip.txt"), "wip\n");
    const prepared = await service.prepareMigration(topic!);

    const migrated = await service.commitMigration({ cwd: topic!, migrationId: prepared.migration_id!, issueId: "iss_5", issueKey: "MUL-5" });

    const moved = join(migrated.path, "repo");
    // What the end of any round does.
    await f.engine().run("periodic");
    expectHealthy(f, moved);
    expect(git(moved, ["status", "--porcelain=v1"])).toBe("?? wip.txt");
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
  });

  describe("merged into an Issue workspace that already exists", () => {
    /** An Issue whose workspace an execution created before the topic was bound, and a topic with a worktree and unsaved work. */
    async function topicWithWorktree(n: number) {
      const fixture = topicFixture();
      const { f, lifecycle } = fixture;
      const service = lifecycle();
      const issueDir = workDirectory(f.root, issue(n));
      mkdirSync(join(issueDir, "wiki"), { recursive: true });
      writeFileSync(join(issueDir, "wiki", "page.md"), "page\n");
      const topic = (await service.ensureTopicWorkspace(`chat:thread:om_${n}`, `om_${n}`))!;
      const worktree = join(topic, "repo");
      git(f.bare, ["worktree", "add", "-b", `topic/om_${n}`, worktree, "origin/main"]);
      writeFileSync(join(worktree, "wip.txt"), "wip\n");
      const prepared = await service.prepareMigration(topic);
      const commit = () => service.commitMigration({ cwd: topic, migrationId: prepared.migration_id!, issueId: `iss_${n}`, issueKey: `MUL-${n}` });
      return { ...fixture, issueDir, topic, worktree, commit };
    }

    test("a worktree of the topic keeps working through the next prune", async () => {
      const { f, topic, worktree, commit } = await topicWithWorktree(7);

      const migrated = await commit();

      const copy = join(migrated.path, "repo");
      expect(existsSync(topic)).toBe(false);
      expect(readFileSync(join(migrated.path, "wiki", "page.md"), "utf8")).toBe("page\n");
      // What the end of any round does.
      await f.engine().run("periodic");
      expectHealthy(f, copy);
      expect(git(copy, ["status", "--porcelain=v1"])).toBe("?? wip.txt");
      expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
    });

    test("a copy an interrupted merge left behind is repaired when the merge is retried", async () => {
      const { f, issueDir, worktree, commit } = await topicWithWorktree(8);
      // An earlier attempt copied the worktree and died before its repository was told where it stands now.
      cpSync(worktree, join(issueDir, "repo"), { recursive: true });
      expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(join(issueDir, "repo"));

      await commit();

      await pruneWorktrees(f.bare);
      expectHealthy(f, join(issueDir, "repo"));
      expect(git(join(issueDir, "repo"), ["status", "--porcelain=v1"])).toBe("?? wip.txt");
    });

    test("a clone of the topic and a worktree of it are copied together: the worktree names the copy of its clone", async () => {
      const { f, lifecycle } = topicFixture();
      const service = lifecycle();
      const issueDir = workDirectory(f.root, issue(10));
      mkdirSync(join(issueDir, "wiki"), { recursive: true });
      const topic = (await service.ensureTopicWorkspace("chat:thread:om_10", "om_10"))!;
      git(f.scratch, ["clone", join(f.scratch, "origin.git"), join(topic, "clone")]);
      git(join(topic, "clone"), ["worktree", "add", "-b", "feature", join(topic, "clone-wt"), "origin/main"]);
      writeFileSync(join(topic, "clone-wt", "wip.txt"), "wip\n");
      const prepared = await service.prepareMigration(topic);

      const migrated = await service.commitMigration({ cwd: topic, migrationId: prepared.migration_id!, issueId: "iss_10", issueKey: "MUL-10" });

      const copy = join(migrated.path, "clone-wt");
      expect(existsSync(topic)).toBe(false);
      // Older git would have repaired the topic's clone instead and left this worktree pointing into the topic that was just removed.
      expect(git(copy, ["rev-parse", "--git-dir"])).toBe(join(migrated.path, "clone", ".git", "worktrees", "clone-wt"));
      await pruneWorktrees(join(migrated.path, "clone", ".git"));
      expect(git(copy, ["status", "--porcelain=v1"])).toBe("?? wip.txt");
      expect(git(join(migrated.path, "clone"), ["worktree", "list", "--porcelain"])).toContain(copy);
    });

    test("a retry repairs a copy whose .git an interrupted attempt had already pointed at the copied clone", async () => {
      const { f, lifecycle } = topicFixture();
      const service = lifecycle();
      const issueDir = workDirectory(f.root, issue(13));
      mkdirSync(join(issueDir, "wiki"), { recursive: true });
      const topic = (await service.ensureTopicWorkspace("chat:thread:om_13", "om_13"))!;
      const clone = cloneAt(f, join(topic, "clone"));
      git(clone, ["worktree", "add", "-b", "feature", join(topic, "clone-wt"), "origin/main"]);
      writeFileSync(join(topic, "clone-wt", "wip.txt"), "wip\n");
      const prepared = await service.prepareMigration(topic);
      // The earlier attempt copied both, pointed the worktree at the copy of its clone, and died before the repair.
      cpSync(clone, join(issueDir, "clone"), { recursive: true });
      cpSync(join(topic, "clone-wt"), join(issueDir, "clone-wt"), { recursive: true });
      writeFileSync(join(issueDir, "clone-wt", ".git"), `gitdir: ${join(issueDir, "clone", ".git", "worktrees", "clone-wt")}\n`);

      await service.commitMigration({ cwd: topic, migrationId: prepared.migration_id!, issueId: "iss_13", issueKey: "MUL-13" });

      expect(existsSync(topic)).toBe(false);
      await pruneWorktrees(join(issueDir, "clone", ".git"));
      expect(git(join(issueDir, "clone-wt"), ["status", "--porcelain=v1"])).toBe("?? wip.txt");
      expect(git(join(issueDir, "clone"), ["worktree", "list", "--porcelain"])).toContain(join(issueDir, "clone-wt"));
    });

    test("a clone of the topic and a clone of the Issue at the same path are not merged: the topic's is kept whole among the artifacts", async () => {
      const { f, lifecycle } = topicFixture();
      const service = lifecycle();
      const issueClone = cloneAt(f, join(workDirectory(f.root, issue(11)), "clone"));
      const issueHead = git(issueClone, ["rev-parse", "HEAD"]);
      const topic = (await service.ensureTopicWorkspace("chat:thread:om_11", "om_11"))!;
      const topicClone = cloneAt(f, join(topic, "clone"));
      git(topicClone, ["checkout", "-b", "topic-wip"]);
      commitIn(topicClone, "topic.txt");
      const prepared = await service.prepareMigration(topic);

      const migrated = await service.commitMigration({ cwd: topic, migrationId: prepared.migration_id!, issueId: "iss_11", issueKey: "MUL-11" });

      // Nothing of the topic's clone is grafted onto the Issue's.
      expect(git(issueClone, ["rev-parse", "HEAD"])).toBe(issueHead);
      expect(git(issueClone, ["branch", "--list", "topic-wip"])).toBe("");
      expect(git(issueClone, ["status", "--porcelain=v1"])).toBe("");
      const artifacts = join(migrated.path, ".multiremi", "topic-artifacts");
      const kept = join(artifacts, readdirSync(artifacts)[0]!, "clone");
      expect(git(kept, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("topic-wip");
      expect(readFileSync(join(kept, "topic.txt"), "utf8")).toBe("topic.txt\n");
      // What keeps the Issue is the commit only that clone has, reported as unsaved work, not a repository nobody can open.
      f.subject(issue(11));
      f.server.answer("iss_11", issueEnded());
      const report = await f.engine().run("periodic");
      expect(report.retained).toEqual({ snapshot_failed: 1 });
      expect(report.errors).toEqual([{ subject_id: "iss_11", message: expect.stringContaining(join("topic-artifacts", readdirSync(artifacts)[0]!, "clone")) }]);
    });

    test("a clone of the topic where the Issue has a worktree is kept whole among the artifacts, the Issue's worktree untouched", async () => {
      const { f, lifecycle } = topicFixture();
      const service = lifecycle();
      const issueRepo = f.worktree(issue(12), "agent/MUL-12");
      const topic = (await service.ensureTopicWorkspace("chat:thread:om_12", "om_12"))!;
      const topicClone = cloneAt(f, join(topic, "repo"));
      commitIn(topicClone, "topic.txt");
      const prepared = await service.prepareMigration(topic);

      const migrated = await service.commitMigration({ cwd: topic, migrationId: prepared.migration_id!, issueId: "iss_12", issueKey: "MUL-12" });

      expect(git(issueRepo, ["status", "--porcelain=v1"])).toBe("");
      expect(existsSync(join(issueRepo, "topic.txt"))).toBe(false);
      const artifacts = join(migrated.path, ".multiremi", "topic-artifacts");
      const kept = join(artifacts, readdirSync(artifacts)[0]!, "repo");
      expect(git(kept, ["status", "--porcelain=v1"])).toBe("");
      expect(readFileSync(join(kept, "topic.txt"), "utf8")).toBe("topic.txt\n");
    });

    test("where the Issue has a worktree of the repository at that path, the topic's files are merged into it and its pointer is not kept", async () => {
      const { f, lifecycle } = topicFixture();
      const service = lifecycle();
      // The Issue worked on the repository before the topic was bound to it.
      const issueRepo = f.worktree(issue(9), "agent/MUL-9");
      const topic = (await service.ensureTopicWorkspace("chat:thread:om_9", "om_9"))!;
      const topicRepo = join(topic, "repo");
      git(f.bare, ["worktree", "add", "-b", "topic/om_9", topicRepo, "origin/main"]);
      writeFileSync(join(topicRepo, "wip.txt"), "unsaved topic work\n");
      writeFileSync(join(topicRepo, "README.md"), "edited in the topic\n");
      const prepared = await service.prepareMigration(topic);

      const migrated = await service.commitMigration({ cwd: topic, migrationId: prepared.migration_id!, issueId: "iss_9", issueKey: "MUL-9" });

      const artifacts = join(migrated.path, ".multiremi", "topic-artifacts");
      const [migration] = readdirSync(artifacts);
      expect(readFileSync(join(issueRepo, "wip.txt"), "utf8")).toBe("unsaved topic work\n");
      expect(readFileSync(join(artifacts, migration!, "repo", "README.md"), "utf8")).toBe("edited in the topic\n");
      // The pointer would name the topic's worktree, which the next prune drops: a repository nobody can open.
      expect(existsSync(join(artifacts, migration!, "repo", ".git"))).toBe(false);
      f.subject(issue(9));
      f.server.answer("iss_9", issueEnded());

      const report = await f.engine().run("periodic");

      expect(report.errors).toEqual([]);
      expect(report.plan).toEqual([expect.objectContaining({ action: "reclaim", unsaved_work: true })]);
      expect(existsSync(workDirectory(f.root, issue(9)))).toBe(false);
    });
  });

  test("a failed return moves the workspace back, and its worktrees work in both places", async () => {
    const { f, lifecycle } = topicFixture();
    const { migrated } = await migratedIssue(f, lifecycle(), 1);
    const failing = lifecycle({ beforeSessionCommit: () => { throw new Error("crash before the session moved"); } });
    const worktree = join(migrated.path, "repo");
    git(f.bare, ["worktree", "add", "-b", "agent/MUL-1", worktree, "origin/main"]);
    writeFileSync(join(worktree, "wip.txt"), "wip\n");

    await expect(failing.returnTerminalIssueToTopic(migrated.path)).rejects.toThrow("crash before the session moved");

    expect(existsSync(worktree)).toBe(true);
    await pruneWorktrees(f.bare);
    expectHealthy(f, worktree);
    expect(git(worktree, ["status", "--porcelain=v1"])).toBe("?? wip.txt");
  });

  test("a return interrupted right after the move is repaired by the next round, before it prunes", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const service = lifecycle();
    const { topic, migrated } = await migratedIssue(f, service, 1);
    const worktree = join(migrated.path, "repo");
    git(f.bare, ["worktree", "add", "-b", "agent/MUL-1", worktree, "origin/main"]);
    const head = commitIn(worktree, "committed.txt");
    f.subject(issue(1));
    // The process dies once the directory is renamed: the intent is journaled in it, nothing else happened.
    const crashing = new TopicWorkspaceLifecycle({
      root: f.root,
      locker: f.locker,
      renameDirectory: (source, target) => { renameSync(source, target); throw new Error("killed"); },
    });
    await expect(crashing.returnTerminalIssueToTopic(migrated.path)).rejects.toThrow("killed");
    expect(JSON.parse(readFileSync(join(topic, TOPIC_MIGRATION_INTENT), "utf8"))).toMatchObject({ state: "returning" });
    // The repository still names the old place.
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).toContain(worktree);

    await engine(service, f.now).run("periodic");

    const returned = join(topic, "repo");
    expect(existsSync(join(topic, TOPIC_MIGRATION_INTENT))).toBe(false);
    expectHealthy(f, returned);
    expect(git(returned, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("a migration interrupted right after the move is repaired when the Issue is next used", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const topic = await lifecycle().ensureTopicWorkspace("chat:thread:om_6", "om_6");
    const worktree = join(topic!, "repo");
    git(f.bare, ["worktree", "add", "-b", "topic/om_6", worktree, "origin/main"]);
    const head = commitIn(worktree, "committed.txt");
    const crashing = new TopicWorkspaceLifecycle({
      root: f.root,
      locker: f.locker,
      renameDirectory: (source, target) => { renameSync(source, target); throw new Error("killed"); },
    });
    const prepared = await crashing.prepareMigration(topic!);
    await expect(crashing.commitMigration({
      cwd: topic!, migrationId: prepared.migration_id!, issueId: "iss_6", issueKey: "MUL-6",
    })).rejects.toThrow("remi issue bind-topic MUL-6");
    const moved = join(workDirectory(f.root, issue(6)), "repo");
    expect(existsSync(moved)).toBe(true);
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).toContain(worktree);

    await engine(lifecycle()).run("periodic");

    expect(existsSync(join(workDirectory(f.root, issue(6)), TOPIC_MIGRATION_INTENT))).toBe(false);
    expectHealthy(f, moved);
    expect(git(moved, ["rev-parse", "HEAD"])).toBe(head);
  });
});

describe("topic workspaces under _topics", () => {
  test("an interrupted migration is finished by the next round", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const topic = await lifecycle().ensureTopicWorkspace("chat:thread:om_2", "om_2");
    writeFileSync(join(topic!, "notes.md"), "research\n");
    const failing = lifecycle({ beforeSessionCommit: () => { throw new Error("crash before the session moved"); } });
    const prepared = await failing.prepareMigration(topic!);
    await expect(failing.commitMigration({
      cwd: topic!, migrationId: prepared.migration_id!, issueId: "iss_2", issueKey: "MUL-2",
    })).rejects.toThrow("remi issue bind-topic MUL-2");
    expect(JSON.parse(readFileSync(join(topic!, TOPIC_MIGRATION_INTENT), "utf8"))).toMatchObject({ state: "migrating" });
    expect(sessions.getSession("chat:thread:om_2")?.cwd).toBe(topic);

    await engine(lifecycle()).run("periodic");

    expect(existsSync(topic!)).toBe(false);
    expect(readFileSync(join(workDirectory(f.root, issue(2)), "notes.md"), "utf8")).toBe("research\n");
    expect(sessions.getSession("chat:thread:om_2")?.cwd).toBe(workDirectory(f.root, issue(2)));
    expect(f.record(issue(2))).toMatchObject({ state: "active", issue_key: "MUL-2" });
  });

  test("an interrupted migration whose Issue is busy is left for a later round, without waiting for it", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const topic = await lifecycle().ensureTopicWorkspace("chat:thread:om_4", "om_4");
    const failing = lifecycle({ beforeSessionCommit: () => { throw new Error("crash before the session moved"); } });
    const prepared = await failing.prepareMigration(topic!);
    await expect(failing.commitMigration({
      cwd: topic!, migrationId: prepared.migration_id!, issueId: "iss_4", issueKey: "MUL-4",
    })).rejects.toThrow("remi issue bind-topic MUL-4");
    const running = await f.locker.acquireShared("iss_4");

    const report = await engine(lifecycle()).run("periodic");

    expect(report.errors).toEqual([]);
    expect(existsSync(join(topic!, TOPIC_MIGRATION_INTENT))).toBe(true);
    running();
    await engine(lifecycle()).run("periodic");
    expect(existsSync(topic!)).toBe(false);
  });

  test("an interrupted migration recorded in the Issue workspace is finished too", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const service = lifecycle();
    const { migrated, topic } = await migratedIssue(f, service, 3);
    f.server.answer("iss_3", { status: "in_progress" });
    // The session moved but the intent was never cleared.
    writeFileSync(join(migrated.path, TOPIC_MIGRATION_INTENT), JSON.stringify({
      version: 1,
      migration_id: "mig_1",
      state: "migrating",
      topic_id: "om_3",
      session_key: "chat:thread:om_3",
      topic_cwd: topic,
      issue_id: "iss_3",
      issue_key: "MUL-3",
      issue_cwd: migrated.path,
      created_at: new Date(f.now).toISOString(),
    }));

    await engine(service).run("periodic");

    expect(existsSync(join(migrated.path, TOPIC_MIGRATION_INTENT))).toBe(false);
    expect(existsSync(join(migrated.path, TOPIC_TASK_DOSSIER))).toBe(true);
  });

  test("an unbound workspace is removed after the orphan TTL, a bound one and a fresh one are kept", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const service = lifecycle();
    const bound = await service.ensureTopicWorkspace("chat:thread:om_bound", "om_bound");
    const root = topicsRoot(f.root);
    const stale = join(root, "om_stale");
    const fresh = join(root, "om_fresh");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "old.md"), "old");
    const later = f.now + f.policy.orphan_ttl_ms + DAY;
    // Everything is old except the fresh one.
    age(bound!, 2 * f.policy.orphan_ttl_ms, later);
    age(stale, 2 * f.policy.orphan_ttl_ms, later);
    age(fresh, 0, later);

    const report = await engine(service, later).run("periodic");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(bound!)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(report.errors).toEqual([]);
  });

  describe("an unbound workspace that holds repositories", () => {
    /** A stale topic workspace, old enough for every retention to have passed. */
    function staleTopic(f: ReclaimFixture, name: string) {
      const stale = join(topicsRoot(f.root), name);
      mkdirSync(stale, { recursive: true });
      return { stale, later: f.now + f.policy.orphan_ttl_ms + DAY, finish: (later: number) => age(stale, 2 * f.policy.orphan_ttl_ms, later) };
    }

    test("is removed after its linked worktree's unsaved work was saved as a ref", async () => {
      const { f, lifecycle, engine } = topicFixture();
      const { stale, later, finish } = staleTopic(f, "om_stale");
      const worktree = join(stale, REPO_DIR);
      git(f.bare, ["worktree", "add", "-b", "topic/om_stale", worktree, "origin/main"]);
      writeFileSync(join(worktree, "wip.txt"), "wip\n");
      finish(later);

      const report = await engine(lifecycle(), later).run("periodic");

      expect(existsSync(stale)).toBe(false);
      expect(report.errors).toEqual([]);
      const commit = git(f.bare, ["rev-parse", "refs/remi/snapshots/topic/om_stale/1"]);
      expect(git(f.bare, ["show", `${commit}:wip.txt`])).toBe("wip");
      expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
    });

    test("is kept, and reported, while a clone in it holds unsaved work", async () => {
      const { f, lifecycle, engine } = topicFixture();
      const { stale, later, finish } = staleTopic(f, "om_stale");
      const clone = join(stale, "clone");
      git(f.scratch, ["clone", join(f.scratch, "origin.git"), clone]);
      writeFileSync(join(clone, "wip.txt"), "wip\n");
      finish(later);

      const report = await engine(lifecycle(), later).run("periodic");

      expect(readFileSync(join(clone, "wip.txt"), "utf8")).toBe("wip\n");
      expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
      expect(report.errors).toEqual([{ subject_id: null, message: expect.stringContaining("clone is a standalone clone") }]);
    });

    test("is removed when its clones are clean", async () => {
      const { f, lifecycle, engine } = topicFixture();
      const { stale, later, finish } = staleTopic(f, "om_stale");
      git(f.scratch, ["clone", join(f.scratch, "origin.git"), join(stale, "clone")]);
      finish(later);

      const report = await engine(lifecycle(), later).run("periodic");

      expect(existsSync(stale)).toBe(false);
      expect(report.errors).toEqual([]);
    });
  });

  test("nothing under _topics is touched in a dry run", async () => {
    const { f, lifecycle, engine } = topicFixture();
    const stale = join(topicsRoot(f.root), "om_stale");
    mkdirSync(stale, { recursive: true });
    const later = f.now + f.policy.orphan_ttl_ms + DAY;
    age(stale, 2 * f.policy.orphan_ttl_ms, later);

    await engine(lifecycle(), later).run("dry_run");

    expect(existsSync(stale)).toBe(true);
  });
});
