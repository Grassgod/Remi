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
  beforeSessionCommit?: () => void;
} = {}): TopicWorkspaceLifecycle {
  return new TopicWorkspaceLifecycle({
    root: workspaces,
    locker: overrides.locker ?? new IssueWorkspaceLifecycleLocker(),
    renameDirectory: overrides.renameDirectory,
    beforeSessionCommit: overrides.beforeSessionCommit,
  });
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
