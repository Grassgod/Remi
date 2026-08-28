import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";
import {
  TOPIC_MIGRATION_INTENT,
  TOPIC_TASK_DOSSIER,
  TopicWorkspaceLifecycle,
} from "@daemon/agent-runtime/workspace/topic-lifecycle.js";
import { runWorkspaceGcOnce, type WorkspaceGcClient } from "@daemon/agent-runtime/workspace/gc.js";
import { closeDb, getDb, setDbPath } from "@shared/db/index.js";
import * as sessions from "@shared/db/sessions.js";

let sandbox = "";
let workspaces = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "remi-topic-lifecycle-"));
  workspaces = join(sandbox, "workspaces");
  mkdirSync(workspaces);
  setDbPath(join(sandbox, "remi.db"));
  getDb();
});

afterEach(() => {
  closeDb();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe("Feishu topic workspace lifecycle", () => {
  it("moves a bound topic into an Issue and writes the task dossier", async () => {
    const lifecycle = service();
    const topic = await lifecycle.ensureTopicWorkspace("chat:thread:om_1", "om_1");
    expect(topic).toBe(join(workspaces, "_topics", "om_1"));
    writeFileSync(join(topic!, "notes.md"), "research\n");
    sessions.upsertSession("chat:thread:om_1", "acp_session_1");

    const prepared = await lifecycle.prepareMigration(topic!);
    const result = await lifecycle.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_1",
      issueKey: "MUL-201",
    });

    expect(result.path).toBe(join(workspaces, "MUL-201"));
    expect(existsSync(topic!)).toBe(false);
    expect(readFileSync(join(result.path, "notes.md"), "utf8")).toBe("research\n");
    expect(JSON.parse(readFileSync(join(result.path, TOPIC_TASK_DOSSIER), "utf8"))).toMatchObject({
      topic_binding: {
        kind: "feishu_topic_issue",
        issue_id: "iss_1",
        issue_key: "MUL-201",
        topic_id: "om_1",
        session_key: "chat:thread:om_1",
      },
    });
    expect(sessions.getSession("chat:thread:om_1")).toMatchObject({
      cwd: join(workspaces, "MUL-201"),
      session_id: "",
    });
    expect(existsSync(join(result.path, TOPIC_MIGRATION_INTENT))).toBe(false);

    expect(await lifecycle.resumeMigration({
      cwd: result.path,
      issueId: "iss_1",
      issueKey: "MUL-201",
    })).toEqual(result);
  });

  it("preserves the provider session when the same topic is ensured again", async () => {
    const lifecycle = service();
    const topic = await lifecycle.ensureTopicWorkspace("session-repeat", "om_repeat");
    sessions.upsertSession("session-repeat", "acp_session_repeat");

    expect(await lifecycle.ensureTopicWorkspace("session-repeat", "om_repeat")).toBe(topic);
    expect(sessions.getSession("session-repeat")).toMatchObject({
      cwd: topic,
      session_id: "acp_session_repeat",
    });
  });

  it("rolls an EXDEV copy migration back after a real post-move failure", async () => {
    let exdevFallbacks = 0;
    const lifecycle = service({
      renameDirectory(source, target) {
        if (!source.endsWith(".partial") && !source.includes(".partial")) {
          exdevFallbacks++;
          throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
        }
        renameSync(source, target);
      },
      beforeSessionCommit() {
        throw new Error("injected after move");
      },
    });
    const topic = await lifecycle.ensureTopicWorkspace("session-exdev", "om_exdev");
    writeFileSync(join(topic!, "artifact.txt"), "must survive\n");
    const prepared = await lifecycle.prepareMigration(topic!);

    await expect(lifecycle.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_exdev",
      issueKey: "MUL-202",
    })).rejects.toThrow("remi issue bind-topic MUL-202");

    expect(exdevFallbacks).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(workspaces, "MUL-202"))).toBe(false);
    expect(readFileSync(join(topic!, "artifact.txt"), "utf8")).toBe("must survive\n");
    expect(sessions.getSession("session-exdev")?.cwd).toBe(topic);
    expect(JSON.parse(readFileSync(join(topic!, TOPIC_MIGRATION_INTENT), "utf8"))).toMatchObject({
      state: "migrating",
      issue_id: "iss_exdev",
      issue_key: "MUL-202",
    });
  });

  it("reconciles a partial Issue residue when an EXDEV rollback cleanup also fails", async () => {
    const issueCwd = join(workspaces, "MUL-ROLLBACK");
    const failing = service({
      renameDirectory(source, target) {
        if (!source.includes(".partial")) {
          throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
        }
        renameSync(source, target);
      },
      removeDirectory(path) {
        if (path === issueCwd) {
          rmSync(join(path, "artifact.txt"), { force: true });
          throw Object.assign(new Error("injected rollback source deletion"), { code: "EACCES" });
        }
        rmSync(path, { recursive: true, force: false });
      },
      beforeSessionCommit() {
        throw new Error("injected after forward move");
      },
    });
    const topic = await failing.ensureTopicWorkspace("session-rollback", "om_rollback");
    writeFileSync(join(topic!, "artifact.txt"), "complete topic copy\n");
    const prepared = await failing.prepareMigration(topic!);

    await expect(failing.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_rollback",
      issueKey: "MUL-ROLLBACK",
    })).rejects.toThrow("remi issue bind-topic MUL-ROLLBACK");

    expect(readFileSync(join(topic!, "artifact.txt"), "utf8")).toBe("complete topic copy\n");
    expect(existsSync(issueCwd)).toBe(true);
    expect(existsSync(join(issueCwd, "artifact.txt"))).toBe(false);
    expect(sessions.getSession("session-rollback")?.cwd).toBe(topic);

    const recovered = service();
    expect(await recovered.resumeMigration({ cwd: issueCwd, issueId: "iss_rollback", issueKey: "MUL-ROLLBACK" }))
      .toMatchObject({ path: issueCwd });
    expect(readFileSync(join(issueCwd, "artifact.txt"), "utf8")).toBe("complete topic copy\n");
    expect(existsSync(topic!)).toBe(false);
    expect(sessions.getSession("session-rollback")?.cwd).toBe(issueCwd);
  });

  it("keeps the verified EXDEV target when source cleanup fails partway", async () => {
    let topicPath = "";
    let failSourceCleanup = true;
    const lifecycle = service({
      renameDirectory(source, target) {
        if (!source.includes(".partial")) {
          throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
        }
        renameSync(source, target);
      },
      removeDirectory(path) {
        if (path === topicPath && failSourceCleanup) {
          rmSync(join(path, "early.txt"), { force: true });
          throw Object.assign(new Error("injected partial source deletion"), { code: "EACCES" });
        }
        rmSync(path, { recursive: true, force: false });
      },
    });
    topicPath = (await lifecycle.ensureTopicWorkspace("session-partial-delete", "om_partial_delete"))!;
    writeFileSync(join(topicPath, "early.txt"), "early survives in target\n");
    mkdirSync(join(topicPath, "nested"));
    writeFileSync(join(topicPath, "nested", "blocked.txt"), "blocked survives\n");
    const prepared = await lifecycle.prepareMigration(topicPath);

    const result = await lifecycle.commitMigration({
      cwd: topicPath,
      migrationId: prepared.migration_id!,
      issueId: "iss_partial_delete",
      issueKey: "MUL-DELETE",
    });

    expect(readFileSync(join(result.path, "early.txt"), "utf8")).toBe("early survives in target\n");
    expect(readFileSync(join(result.path, "nested", "blocked.txt"), "utf8")).toBe("blocked survives\n");
    expect(existsSync(topicPath)).toBe(true);
    expect(existsSync(join(topicPath, "early.txt"))).toBe(false);
    expect(JSON.parse(readFileSync(join(topicPath, TOPIC_MIGRATION_INTENT), "utf8"))).toMatchObject({
      state: "source_cleanup",
      issue_key: "MUL-DELETE",
    });
    expect(sessions.getSession("session-partial-delete")?.cwd).toBe(result.path);

    failSourceCleanup = false;
    expect(await lifecycle.recoverTopicWorkspace(topicPath)).toBe(true);
    expect(existsSync(topicPath)).toBe(false);
    expect(existsSync(result.path)).toBe(true);
  });

  it("adopts a stamped topic before a fast task creates its Issue workspace", async () => {
    const locker = new IssueWorkspaceLifecycleLocker();
    const lifecycle = service({ locker });
    const topic = await lifecycle.ensureTopicWorkspace("session-fast", "om_fast");
    writeFileSync(join(topic!, "artifact.txt"), "topic wins the create race\n");
    const prepared = await lifecycle.prepareMigration(topic!);
    const releaseIssue = await locker.acquire("iss_fast");
    const committing = lifecycle.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_fast",
      issueKey: "MUL-FAST",
    });
    await waitFor(() => {
      const intent = JSON.parse(readFileSync(join(topic!, TOPIC_MIGRATION_INTENT), "utf8"));
      return intent.issue_id === "iss_fast";
    });

    expect(await lifecycle.preparePendingMigrationForIssue("iss_fast", "MUL-FAST")).toBe(true);
    releaseIssue();
    const result = await committing;

    expect(result.path).toBe(join(workspaces, "MUL-FAST"));
    expect(readFileSync(join(result.path, "artifact.txt"), "utf8")).toBe("topic wins the create race\n");
    expect(sessions.getSession("session-fast")?.cwd).toBe(result.path);
  });

  it("merges topic artifacts when a fast task already created the Issue workspace", async () => {
    const lifecycle = service();
    const topic = await lifecycle.ensureTopicWorkspace("session-reconcile", "om_reconcile");
    writeFileSync(join(topic!, "topic-only.txt"), "topic artifact\n");
    writeFileSync(join(topic!, "conflict.txt"), "topic version\n");
    const issueCwd = join(workspaces, "MUL-RACE");
    mkdirSync(join(issueCwd, ".multiremi"), { recursive: true });
    writeFileSync(join(issueCwd, ".multiremi", "task.json"), JSON.stringify({ task_id: "tsk_fast" }));
    writeFileSync(join(issueCwd, "task-only.txt"), "task artifact\n");
    writeFileSync(join(issueCwd, "conflict.txt"), "task version\n");
    const prepared = await lifecycle.prepareMigration(topic!);

    const result = await lifecycle.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_race",
      issueKey: "MUL-RACE",
    });

    expect(readFileSync(join(issueCwd, "topic-only.txt"), "utf8")).toBe("topic artifact\n");
    expect(readFileSync(join(issueCwd, "task-only.txt"), "utf8")).toBe("task artifact\n");
    expect(readFileSync(join(issueCwd, "conflict.txt"), "utf8")).toBe("task version\n");
    expect(readFileSync(join(issueCwd, ".multiremi", "topic-artifacts", prepared.migration_id!, "conflict.txt"), "utf8"))
      .toBe("topic version\n");
    expect(JSON.parse(readFileSync(join(issueCwd, TOPIC_TASK_DOSSIER), "utf8"))).toMatchObject({
      task_id: "tsk_fast",
      topic_binding: { issue_id: "iss_race", session_key: "session-reconcile" },
    });
    expect(existsSync(topic!)).toBe(false);
    expect(sessions.getSession("session-reconcile")?.cwd).toBe(issueCwd);
    expect(await lifecycle.resumeMigration({ cwd: issueCwd, issueId: "iss_race", issueKey: "MUL-RACE" }))
      .toEqual(result);
  });

  it("leaves a recoverable forward journal when the final pre-DB ownership fence fails", async () => {
    let fences = 0;
    let failAt = Number.POSITIVE_INFINITY;
    const failing = service({
      assertRootOwner() {
        fences++;
        if (fences === failAt) throw new Error("injected ownership loss");
      },
    });
    const topic = await failing.ensureTopicWorkspace("session-fence", "om_fence");
    const prepared = await failing.prepareMigration(topic!);
    failAt = fences + 4;

    await expect(failing.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_fence",
      issueKey: "MUL-FENCE",
    })).rejects.toThrow("remi issue bind-topic MUL-FENCE");

    const issueCwd = join(workspaces, "MUL-FENCE");
    expect(existsSync(topic!)).toBe(false);
    expect(existsSync(issueCwd)).toBe(true);
    expect(sessions.getSession("session-fence")?.cwd).toBe(topic);
    expect(existsSync(join(issueCwd, TOPIC_MIGRATION_INTENT))).toBe(true);

    const recovered = service();
    expect(await recovered.resumeMigration({ cwd: issueCwd, issueId: "iss_fence", issueKey: "MUL-FENCE" }))
      .toMatchObject({ path: issueCwd });
    expect(sessions.getSession("session-fence")?.cwd).toBe(issueCwd);
  });

  it("keeps the committed DB and filesystem state when post-commit work fails", async () => {
    const lifecycle = service({
      afterSessionCommit() {
        throw new Error("injected post-commit failure");
      },
    });
    const topic = await lifecycle.ensureTopicWorkspace("session-post-commit", "om_post_commit");
    const prepared = await lifecycle.prepareMigration(topic!);

    const result = await lifecycle.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_post_commit",
      issueKey: "MUL-POST",
    });

    expect(existsSync(topic!)).toBe(false);
    expect(existsSync(result.path)).toBe(true);
    expect(sessions.getSession("session-post-commit")?.cwd).toBe(result.path);
  });

  it("returns a terminal Issue through GC, protects its live topic, then collects the orphan", async () => {
    const locker = new IssueWorkspaceLifecycleLocker();
    const lifecycle = service({ locker });
    const topic = await lifecycle.ensureTopicWorkspace("session-return", "om_return");
    writeFileSync(join(topic!, "artifact.txt"), "topic state\n");
    const prepared = await lifecycle.prepareMigration(topic!);
    const migrated = await lifecycle.commitMigration({
      cwd: topic!,
      migrationId: prepared.migration_id!,
      issueId: "iss_return",
      issueKey: "MUL-203",
    });
    const options = gcOptions(lifecycle, locker);

    expect(await runWorkspaceGcOnce(options)).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(existsSync(migrated.path)).toBe(false);
    expect(readFileSync(join(topic!, "artifact.txt"), "utf8")).toBe("topic state\n");
    expect(sessions.getSession("session-return")?.cwd).toBe(topic);
    expect(existsSync(join(topic!, TOPIC_TASK_DOSSIER))).toBe(false);

    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(topic!, old, old);
    expect(await runWorkspaceGcOnce(options)).toEqual({ cleaned: 0, orphaned: 0, skipped: 1 });
    expect(existsSync(topic!)).toBe(true);

    sessions.deleteSession("session-return");
    expect(await runWorkspaceGcOnce(options)).toEqual({ cleaned: 0, orphaned: 1, skipped: 0 });
    expect(existsSync(topic!)).toBe(false);
  });

  it("allows shared project cwd values but rejects duplicate topic ownership", () => {
    sessions.upsertSession("one", "one-id");
    sessions.upsertSession("two", "two-id");
    sessions.updateSessionCwd("one", "/shared/project");
    sessions.updateSessionCwd("two", "/shared/project");
    expect(sessions.getSessionsByCwd("/shared/project")).toHaveLength(2);

    sessions.updateSessionCwd("one", "/tmp/workspaces/_topics/om_unique");
    expect(() => sessions.updateSessionCwd("two", "/tmp/workspaces/_topics/om_unique"))
      .toThrow(/UNIQUE constraint failed/);
  });
});

function service(overrides: {
  locker?: IssueWorkspaceLifecycleLocker;
  renameDirectory?: (source: string, target: string) => void;
  removeDirectory?: (path: string) => void;
  assertRootOwner?: () => void;
  beforeSessionCommit?: () => void;
  afterSessionCommit?: () => void;
} = {}): TopicWorkspaceLifecycle {
  return new TopicWorkspaceLifecycle({
    root: workspaces,
    locker: overrides.locker ?? new IssueWorkspaceLifecycleLocker(),
    renameDirectory: overrides.renameDirectory,
    removeDirectory: overrides.removeDirectory,
    assertRootOwner: overrides.assertRootOwner,
    beforeSessionCommit: overrides.beforeSessionCommit,
    afterSessionCommit: overrides.afterSessionCommit,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

function gcOptions(lifecycle: TopicWorkspaceLifecycle, locker: IssueWorkspaceLifecycleLocker) {
  const client: WorkspaceGcClient = {
    getIssueGcCheck: async () => ({ status: "done", updated_at: "2000-01-01T00:00:00.000Z" }),
    getChatSessionGcCheck: async () => ({ status: "active" }),
    getAutopilotRunGcCheck: async () => ({ status: "running" }),
    getTaskGcCheck: async () => ({ status: "running" }),
  };
  return {
    root: workspaces,
    ttlMs: 72 * 60 * 60 * 1000,
    orphanTtlMs: 0,
    client,
    now: Date.now(),
    withIssueWorkspaceLock: (key: string, _dir: string, action: () => Promise<void>) =>
      locker.runExclusive(key, action),
    recoverTopicWorkspace: (dir: string) => lifecycle.recoverTopicWorkspace(dir),
    isTopicWorkspaceBound: (dir: string) => lifecycle.isTopicWorkspaceBound(dir),
    recoverIssueWorkspace: (dir: string) => lifecycle.recoverIssueWorkspace(dir),
    returnTerminalIssueToTopic: (dir: string) => lifecycle.returnTerminalIssueToTopic(dir),
  };
}
