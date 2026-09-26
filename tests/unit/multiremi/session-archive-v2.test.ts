import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { createStore, resetMultiremiTestEnv, db } from "./helpers.js";
import { buildArchiveFixture } from "./session-archive-fixtures.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";

function freshDb(): Database {
  return new Database(":memory:");
}

function migrate(database: Database): void {
  runMigrations(database as unknown as SqlDatabase);
}

const dirs: string[] = [];

afterEach(() => {
  resetMultiremiTestEnv();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Session archive v2 subject migration", () => {
  it("is idempotent, preserves every row, and backfills v1 rows as Issue subjects", () => {
    const database = freshDb();
    database.exec(`
      CREATE TABLE multiremi_session_archives (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'local',
        issue_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        daemon_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        uploaded_size_bytes BIGINT NOT NULL DEFAULT 0,
        file_count INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        relative_path TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(issue_id, source_revision, sha256)
      );
      INSERT INTO multiremi_session_archives (
        id, issue_id, runtime_id, daemon_id, source_revision, sha256,
        size_bytes, status, relative_path, attempt_count, created_at, updated_at
      ) VALUES
        ('sar_ready', 'iss_a', 'rt_1', 'dmn_1', 'rev-a', '${"a".repeat(64)}',
         5, 'ready', 'a/sessions.tar.gz', 1, 'x', 'x'),
        ('sar_failed', 'iss_b', 'rt_1', 'dmn_1', 'rev-b', '${"b".repeat(64)}',
         5, 'failed', 'b/sessions.tar.gz', 2, 'x', 'x');
    `);

    migrate(database);
    const columns = database.query("PRAGMA table_info(multiremi_session_archives)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(Number(columns.find((column) => column.name === "issue_id")?.notnull)).toBe(0);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "subject_kind", "subject_id", "format",
    ]));
    const rows = database.query(
      "SELECT id, issue_id, subject_kind, subject_id, format, status FROM multiremi_session_archives ORDER BY id",
    ).all();
    expect(rows).toEqual([
      {
        id: "sar_failed",
        issue_id: "iss_b",
        subject_kind: "issue",
        subject_id: "iss_b",
        format: "multiremi.issue-sessions.v1",
        status: "failed",
      },
      {
        id: "sar_ready",
        issue_id: "iss_a",
        subject_kind: "issue",
        subject_id: "iss_a",
        format: "multiremi.issue-sessions.v1",
        status: "ready",
      },
    ]);

    // Running the migration twice more must not change the row count or values.
    migrate(database);
    migrate(database);
    expect((database.query(
      "SELECT COUNT(*) AS count FROM multiremi_session_archives",
    ).get() as { count: number }).count).toBe(2);
    expect(database.query(
      "SELECT COUNT(*) AS count FROM multiremi_session_archives WHERE subject_kind <> 'issue'",
    ).get()).toEqual({ count: 0 });
  });

  it("creates the task trace pointer table with the documented shape", () => {
    const database = freshDb();
    migrate(database);
    const columns = (database.query("PRAGMA table_info(multiremi_task_traces)").all() as Array<{
      name: string;
    }>).map((column) => column.name);
    expect(columns).toEqual([
      "task_id",
      "location",
      "runtime_id",
      "archive_id",
      "member_path",
      "data_offset",
      "compressed_size",
      "uncompressed_size",
      "sha256",
      "event_count",
      "updated_at",
    ]);
  });
});

describe("Session archive random access", () => {
  it("reads a single trace member with one pread and no full-archive scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-read-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_read",
      name: "reader runtime",
      provider: "codex",
      daemonId: "dmn_read",
      workspaceId: "local",
    });
    const issue = store.createIssue({ title: "Random access", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      members: [
        // A large provider member the reader must never touch.
        {
          path: "sessions/ises_1/agt_1/1/home/history.jsonl",
          body: Buffer.alloc(4 * 1024 * 1024, 0x42),
        },
      ],
      traces: {
        tsk_one: Array.from({ length: 500 }, (_, index) => JSON.stringify({ seq: index, type: "execution" })).join("\n") + "\n",
        tsk_two: "{\"seq\":0}\n",
      },
    });
    const service = new SessionArchiveService(store, {
      root,
      maxBytes: 64 * 1024 * 1024,
      minFreeBytes: 0,
    });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_read",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    }).archive;
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, initialized.id);
    await service.upload(
      runtime.id,
      issue.id,
      initialized.id,
      claim.uploadAttempt!,
      new Response(fixture.bytes as BodyInit).body,
    );
    const ready = await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);
    expect(ready.status).toBe("ready");

    // Pointers land with the ready transition.
    const pointer = store.getTaskTrace("tsk_one")!;
    expect(pointer).toMatchObject({
      location: "archive",
      archiveId: ready.id,
      memberPath: "traces/tsk_one.jsonl",
      runtimeId: runtime.id,
    });
    expect(store.getTaskTrace("tsk_two")?.memberPath).toBe("traces/tsk_two.jsonl");

    const reader = new SessionArchiveReader({ store, root });
    const read = await reader.readArchiveMember(ready.id, {
      dataOffset: pointer.dataOffset!,
      compressedSize: pointer.compressedSize!,
      uncompressedSize: pointer.uncompressedSize!,
      sha256: pointer.sha256!,
    });
    // The read budget: compressed bytes only, no local header, no index scan.
    expect(read.bytesRead).toBe(pointer.compressedSize!);
    expect(read.bytesRead).toBeLessThanOrEqual(pointer.compressedSize! + 64 * 1024);
    expect(read.bytes.toString("utf8").split("\n").filter(Boolean)).toHaveLength(500);

    const cursor = await reader.readTraceLines(pointer, 0, 10);
    expect(cursor.lines).toHaveLength(10);
    expect(JSON.parse(cursor.lines[0]!)).toMatchObject({ seq: 0, type: "execution" });
    expect(cursor.nextCursor).toBe(10);
    expect(cursor.complete).toBe(false);
    const tail = await reader.readTraceLines(pointer, 495, 10);
    expect(tail.lines).toHaveLength(5);
    expect(tail.complete).toBe(true);
  });

  it("refuses to read an archive that is not ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-read-notready-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_read2",
      name: "reader runtime 2",
      provider: "codex",
      daemonId: "dmn_read",
      workspaceId: "local",
    });
    const issue = store.createIssue({ title: "Not ready", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_x: "{\"seq\":0}\n" },
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_read",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    }).archive;
    const reader = new SessionArchiveReader({ store, root });
    await expect(reader.readArchiveMember(initialized.id, {
      dataOffset: 0,
      compressedSize: 4,
    })).rejects.toThrow("not readable in pending state");
  });
});

describe("Session archive ingest validation", () => {
  it("marks the archive failed when index.json disagrees with the container", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-tamper-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_tamper",
      name: "tamper runtime",
      provider: "codex",
      daemonId: "dmn_tamper",
      workspaceId: "local",
    });
    const issue = store.createIssue({ title: "Tampered index", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    // Offsets in the index no longer match where the member actually sits.
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_tampered: "{\"seq\":0}\n" },
      tamperIndex(index) {
        index.members[0]!.data_offset += 7;
      },
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_tamper",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    }).archive;
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, initialized.id);
    await service.upload(
      runtime.id,
      issue.id,
      initialized.id,
      claim.uploadAttempt!,
      new Response(fixture.bytes as BodyInit).body,
    );

    await expect(service.complete(
      runtime.id,
      issue.id,
      initialized.id,
      claim.uploadAttempt!,
    )).rejects.toThrow(/data offset mismatch|size mismatch|sha256/);
    expect(store.getSessionArchive(initialized.id)).toMatchObject({ status: "failed" });
    expect(store.getSessionArchive(initialized.id)?.lastError).toMatch(/data offset|size|sha256/);
    expect(store.getTaskTrace("tsk_tampered")).toBeNull();
  });

  it("writes the trace pointers in the same transaction that marks the archive ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-transaction-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_tx",
      name: "transaction runtime",
      provider: "codex",
      daemonId: "dmn_tx",
      workspaceId: "local",
    });
    const issue = store.createIssue({ title: "Transactional pointers", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_tx: "{\"seq\":0}\n" },
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_tx",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    }).archive;
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, initialized.id);
    await service.upload(
      runtime.id,
      issue.id,
      initialized.id,
      claim.uploadAttempt!,
      new Response(fixture.bytes as BodyInit).body,
    );
    // Before completion the pointer must not exist, and the row is not ready.
    expect(store.getTaskTrace("tsk_tx")).toBeNull();
    expect(store.getSessionArchive(initialized.id)?.status).toBe("uploading");

    const ready = await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);
    expect(ready.status).toBe("ready");
    expect(store.getTaskTrace("tsk_tx")).toMatchObject({
      location: "archive",
      archiveId: ready.id,
      memberPath: "traces/tsk_tx.jsonl",
    });
  });

  it("lets a newer ready archive overwrite an older trace pointer", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-overwrite-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_overwrite",
      name: "overwrite runtime",
      provider: "codex",
      daemonId: "dmn_overwrite",
      workspaceId: "local",
    });
    const issue = store.createIssue({ title: "Overwrite pointers", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archiveIds: string[] = [];
    for (const revision of ["first", "second"] as const) {
      const fixture = await buildArchiveFixture({
        subject: { kind: "issue", id: issue.id },
        traces: { tsk_overwrite: revision === "first" ? "{\"seq\":0}\n" : "{\"seq\":0}\n{\"seq\":1}\n" },
      });
      const initialized = service.initialize({
        workspaceId: "local",
        subjectKind: "issue",
        subjectId: issue.id,
        issueId: issue.id,
        runtimeId: runtime.id,
        daemonId: "dmn_overwrite",
        sourceRevision: fixture.sourceRevision,
        sha256: fixture.sha256,
        sizeBytes: fixture.sizeBytes,
      }).archive;
      const claim = await service.claimUploadAttempt(runtime.id, issue.id, initialized.id);
      await service.upload(
        runtime.id,
        issue.id,
        initialized.id,
        claim.uploadAttempt!,
        new Response(fixture.bytes as BodyInit).body,
      );
      const ready = await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);
      archiveIds.push(ready.id);
      const pointer = store.getTaskTrace("tsk_overwrite")!;
      expect(pointer.archiveId).toBe(ready.id);
    }
    expect(archiveIds[0]).not.toBe(archiveIds[1]);
    expect(store.getTaskTrace("tsk_overwrite")?.archiveId).toBe(archiveIds[1]!);
  });
});

describe("Session archive v1 upload rejection", () => {
  it("refuses a v1 upload without consuming the retry budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-v1-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_v1",
      name: "v1 runtime",
      provider: "codex",
      daemonId: "dmn_v1",
      workspaceId: "local",
    });
    const issue = store.createIssue({ title: "Legacy upload", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const v1 = "f".repeat(64);
    expect(() => service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_v1",
      format: "multiremi.issue-sessions.v1",
      sourceRevision: "legacy-revision",
      sha256: v1,
      sizeBytes: 16,
    })).toThrow(/no longer accepted/);

    // Nothing was persisted, so there is no row and no attempt to exhaust.
    expect(store.listSessionArchives(issue.id)).toHaveLength(0);
    expect(store.getSessionArchiveWorkspaceUsage("local").pendingArchives).toBe(0);

    // The upgrade path still works afterwards, from a clean budget.
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_v1: "{\"seq\":0}\n" },
    });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_v1",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    }).archive;
    expect(initialized).toMatchObject({ format: "multiremi.session-archive.v2", attemptCount: 0 });
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, initialized.id);
    expect(claim.uploadAttempt).toBe(1);
  });
});

describe("Session archive subject write permissions", () => {
  it("accepts a chat subject only from the Runtime that owns its provider session", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-chat-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Chat agent", provider: "codex", workspaceId: "local" });
    const runtime = store.registerRuntime({
      id: "rt_chat",
      name: "chat runtime",
      provider: "codex",
      daemonId: "dmn_chat",
      workspaceId: "local",
    });
    const other = store.registerRuntime({
      id: "rt_chat_other",
      name: "other runtime",
      provider: "codex",
      daemonId: "dmn_chat_other",
      workspaceId: "local",
    });
    const chat = store.createChatSession({ agentId: agent.id, title: "Archived chat", workspaceId: "local" });
    // `session_runtime_id` is stamped when a task on that Runtime promotes its
    // provider session; the archive guard reads exactly this column.
    db!.run(
      "UPDATE multiremi_chat_sessions SET session_runtime_id = ? WHERE id = ?",
      [runtime.id, chat.id],
    );

    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const fixture = await buildArchiveFixture({
      subject: { kind: "chat", id: chat.id },
      traces: { tsk_chat: "{\"seq\":0}\n" },
    });
    // The owning Runtime may initialize the subject.
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "chat",
      subjectId: chat.id,
      runtimeId: runtime.id,
      daemonId: "dmn_chat",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    }).archive;
    expect(initialized).toMatchObject({ subjectKind: "chat", issueId: null });

    // A different Runtime may not touch it.
    expect(() => service.initialize({
      workspaceId: "local",
      subjectKind: "chat",
      subjectId: chat.id,
      runtimeId: other.id,
      daemonId: "dmn_chat_other",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    })).toThrow(/not writable/);
    expect(store.listSessionArchivesForSubject("chat", chat.id)).toHaveLength(1);
  });

  it("accepts a one-shot task subject only from the Runtime that ran it", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-task-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Task agent", provider: "codex", workspaceId: "local" });
    const runtime = store.registerRuntime({
      id: "rt_task",
      name: "task runtime",
      provider: "codex",
      daemonId: "dmn_task",
      workspaceId: "local",
    });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "one shot" });
    // `claimTask` is what stamps `runtime_id`, which is exactly the field the
    // Task subject's write permission checks.
    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(task.id);
    expect(store.getTask(task.id)?.runtimeId).toBe(runtime.id);

    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const fixture = await buildArchiveFixture({
      subject: { kind: "task", id: task.id },
      traces: { [task.id]: "{\"seq\":0}\n" },
    });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "task",
      subjectId: task.id,
      runtimeId: runtime.id,
      daemonId: "dmn_task",
      sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256,
      sizeBytes: fixture.sizeBytes,
    }).archive;
    expect(initialized).toMatchObject({ subjectKind: "task", issueId: null });

    // Another Runtime that never ran this task cannot write to its archive.
    const other = store.registerRuntime({
      id: "rt_task_other",
      name: "other task runtime",
      provider: "codex",
      daemonId: "dmn_task_other",
      workspaceId: "local",
    });
    expect(store.touchWritableSessionArchive(initialized.id, other.id)).toBeNull();
    expect(store.touchWritableSessionArchive(initialized.id, runtime.id)).not.toBeNull();
  });
});
