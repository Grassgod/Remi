import { createResponsibleTestIssue } from './helpers.js';
import { mutateExecutionFixture, sentTask } from "./unified-test-paths.js";
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapPreUnifiedSchema } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { createStore, resetMultiremiTestEnv, db } from "./helpers.js";
import { buildArchiveFixture, traceFileBody } from "./session-archive-fixtures.js";
import { traceBackfillBackends, type OpenedStore } from "./trace-backfill-backends.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { MultiremiStore } from "@multiremi/store.js";
import { TRACE_FILE_FORMAT } from "@multiremi/contracts/trace-file.js";

function freshDb(): Database {
  return openSqliteDatabase(":memory:");
}

function migrate(database: Database): void {
  bootstrapPreUnifiedSchema(database as unknown as SqlDatabase);
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
      "subject_kind", "subject_id", "format", "retry_budget_base_attempt",
    ]));
    expect(database.query("SELECT id, retry_budget_base_attempt FROM multiremi_session_archives ORDER BY id").all())
      .toEqual([
        { id: "sar_failed", retry_budget_base_attempt: 0 },
        { id: "sar_ready", retry_budget_base_attempt: 0 },
      ]);
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

    database.run(`UPDATE multiremi_session_archives
      SET attempt_count = 3, retry_budget_base_attempt = 2,
          next_retry_at = NULL, retry_exhausted_at = NULL
      WHERE id = 'sar_failed'`);
    database.run("DELETE FROM multiremi_schema_migrations WHERE id = ?",
      ["20260826_session_archive_retry_budget"]);
    migrate(database);
    expect(database.query(
      "SELECT retry_exhausted_at, retry_budget_base_attempt FROM multiremi_session_archives WHERE id = 'sar_failed'",
    ).get()).toEqual({ retry_exhausted_at: null, retry_budget_base_attempt: 2 });
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
      "head_seq",
      "closed",
      "updated_at",
      "source",
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
    const issue = createResponsibleTestIssue(store, { title: "Random access", workspaceId: "local" });
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
        tsk_one: traceFileBody({ events: 500, taskId: "tsk_one" }),
        tsk_two: traceFileBody({ events: 1, taskId: "tsk_two" }),
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
    // The pointer carries the index's trace facts: 500 events, head 500, sealed.
    expect(pointer).toMatchObject({ headSeq: 500, closed: true, eventCount: 500 });

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
    // Header and trailer are structural lines; only the 500 events count.
    expect(read.bytes.toString("utf8").split("\n").filter(Boolean)).toHaveLength(502);

    const cursor = await reader.readTraceLines(pointer, 0, 10);
    expect(cursor.events).toHaveLength(10);
    expect(cursor.events[0]).toMatchObject({ seq: 1, type: "execution" });
    expect(cursor.nextCursor).toBe(10);
    expect(cursor.complete).toBe(false);
    const tail = await reader.readTraceLines(pointer, 495, 10);
    expect(tail.events).toHaveLength(5);
    expect(tail.complete).toBe(true);
  });

  it("applies the trace line rules: no-seq header/trailer, gaps, duplicate seq, half line", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-cursor-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_cursor",
      name: "cursor runtime",
      provider: "codex",
      daemonId: "dmn_cursor",
      workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Trace rules", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    // Header, three events with a gap where seq 3 would be, a duplicate seq 2, a
    // trailer, then a crash-truncated half line. The events are readable, but
    // B3's shared validator cannot establish that this trace is closed.
    const body = [
      JSON.stringify({
        format: TRACE_FILE_FORMAT,
        task_id: "tsk_cursor",
        session_id: "ises_1",
        agent_id: "agt_1",
        provider: "codex",
        started_at: "2026-09-27T00:00:00.000Z",
      }),
      JSON.stringify({ seq: 1, ts: "2026-09-27T00:00:01.000Z", type: "execution", content: "one" }),
      JSON.stringify({ seq: 2, ts: "2026-09-27T00:00:02.000Z", type: "execution", content: "two" }),
      JSON.stringify({ seq: 4, ts: "2026-09-27T00:00:04.000Z", type: "execution", content: "four" }),
      JSON.stringify({ seq: 2, ts: "2026-09-27T00:00:02.000Z", type: "execution", content: "duplicate two" }),
      JSON.stringify({
        end: {
          status: "completed",
          head: 4,
          event_count: 3,
          ended_at: "2026-09-27T01:00:00.000Z",
        },
      }),
    ].join("\n") + "\n" + JSON.stringify({ seq: 5, type: "execution" });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_cursor: body },
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_cursor",
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
      new Response(fixture.bytes).body,
    );
    const ready = await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);

    // `head` is the largest seq, not the count: seq 3 is missing and the half
    // line (seq 5) never made it into the file.
    const pointer = store.getTaskTrace("tsk_cursor")!;
    expect(pointer).toMatchObject({ headSeq: 4, eventCount: 3, closed: false, archiveId: ready.id });

    const reader = new SessionArchiveReader({ store, root });
    const window = await reader.readTraceLines(pointer, 0, 50);
    expect(window.events.map((event) => event.seq)).toEqual([1, 2, 4]);
    expect(window.events[1]?.content).toBe("two");
    expect(window.duplicateSeqSkipped).toBe(1);
    expect(window.head).toBe(4);
    expect(window.closed).toBe(false);
    expect(window.complete).toBe(true);

    const paged = await reader.readTraceLines(pointer, 1, 1);
    expect(paged.events.map((event) => event.seq)).toEqual([2]);
    expect(paged.nextCursor).toBe(2);
    expect(paged.complete).toBe(false);
  });

  it("takes over a pointer held by a hot or backfilling trace regardless of head", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-hot-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_hot",
      name: "hot runtime",
      provider: "codex",
      daemonId: "dmn_hot",
      workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Hot pointer", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });

    // A backfilled trace reaches head 50 while the task is still hot.
    db!.run(
      `INSERT INTO multiremi_task_traces (
         task_id, location, head_seq, event_count, closed, updated_at
       ) VALUES ('tsk_hot', 'daemon', 50, 50, 0, '2026-09-27T00:00:00.000Z')`,
    );
    expect(store.getTaskTrace("tsk_hot")).toMatchObject({ location: "daemon", headSeq: 50 });

    // An archive that only reaches head 2 still takes the pointer: a hot trace
    // has no archive bytes yet, so archive ownership is strictly better.
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_hot: traceFileBody({ events: 2, taskId: "tsk_hot" }) },
    });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_hot",
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
      new Response(fixture.bytes).body,
    );
    const ready = await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);
    expect(store.getTaskTrace("tsk_hot")).toMatchObject({
      location: "archive",
      archiveId: ready.id,
      headSeq: 2,
    });
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
    const issue = createResponsibleTestIssue(store, { title: "Not ready", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_x: traceFileBody({ events: 1 }) },
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
    const issue = createResponsibleTestIssue(store, { title: "Tampered index", workspaceId: "local" });
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
      traces: { tsk_tampered: traceFileBody({ events: 1 }) },
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
    const issue = createResponsibleTestIssue(store, { title: "Transactional pointers", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_tx: traceFileBody({ events: 1 }) },
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

  it("only replaces an archive pointer when the newer member reaches at least as far", async () => {
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
    const issue = createResponsibleTestIssue(store, { title: "Overwrite pointers", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archiveIds: string[] = [];
    // First archive reaches head 5; the second only head 2. The ruling says a
    // pointer may only move forward, so the shorter trace must not win.
    for (const events of [5, 2]) {
      const fixture = await buildArchiveFixture({
        subject: { kind: "issue", id: issue.id },
        traces: { tsk_overwrite: traceFileBody({ events, taskId: "tsk_overwrite" }) },
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
      // Both archives are ready; only the pointer obeys the swap rule.
      expect(ready.status).toBe("ready");
      expect(store.getTaskTrace("tsk_overwrite")?.archiveId).toBe(archiveIds[0]);
      expect(store.getTaskTrace("tsk_overwrite")?.headSeq).toBe(5);
    }

    // A longer member from a later archive does take the pointer over.
    const longer = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_overwrite: traceFileBody({ events: 9, taskId: "tsk_overwrite" }) },
    });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_overwrite",
      sourceRevision: longer.sourceRevision,
      sha256: longer.sha256,
      sizeBytes: longer.sizeBytes,
    }).archive;
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, initialized.id);
    await service.upload(
      runtime.id,
      issue.id,
      initialized.id,
      claim.uploadAttempt!,
      new Response(longer.bytes).body,
    );
    const ready = await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);
    expect(store.getTaskTrace("tsk_overwrite")).toMatchObject({
      archiveId: ready.id,
      headSeq: 9,
    });
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
    const issue = createResponsibleTestIssue(store, { title: "Legacy upload", workspaceId: "local" });
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
      traces: { tsk_v1: traceFileBody({ events: 1 }) },
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
      traces: { tsk_chat: traceFileBody({ events: 1 }) },
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
      traces: { [task.id]: traceFileBody({ events: 1 }) },
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

describe("Session archive QA round 1", () => {
  it("pages a sparse seq axis without losing events (afterSeq cursor)", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-sparse-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_sparse",
      name: "sparse runtime",
      provider: "codex",
      daemonId: "dmn_sparse",
      workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Sparse seq", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    // A historical trace with holes: seq 1, 10, 20. An index cursor would read
    // this as [0,1,2] and answer afterSeq=10 with an empty page.
    const body = [
      JSON.stringify({
        format: TRACE_FILE_FORMAT,
        task_id: "tsk_sparse",
        session_id: "ises_1",
        agent_id: "agt_1",
        provider: "codex",
        started_at: "2026-09-27T00:00:00.000Z",
      }),
      JSON.stringify({ seq: 1, ts: "2026-09-27T00:00:01.000Z", type: "execution", content: "one" }),
      JSON.stringify({ seq: 10, ts: "2026-09-27T00:00:10.000Z", type: "execution", content: "ten" }),
      JSON.stringify({ seq: 20, ts: "2026-09-27T00:00:20.000Z", type: "execution", content: "twenty" }),
      JSON.stringify({
        end: { status: "completed", head: 20, event_count: 3, ended_at: "2026-09-27T01:00:00.000Z" },
      }),
    ].join("\n") + "\n";
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_sparse: body },
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_sparse",
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
      new Response(fixture.bytes).body,
    );
    await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);

    const pointer = store.getTaskTrace("tsk_sparse")!;
    expect(pointer).toMatchObject({ headSeq: 20, eventCount: 3, closed: true });
    const reader = new SessionArchiveReader({ store, root });

    const first = await reader.readTraceLines(pointer, 0, 2);
    expect(first.events.map((event) => event.seq)).toEqual([1, 10]);
    expect(first.nextCursor).toBe(10);
    expect(first.complete).toBe(false);

    // The QA case: afterSeq 10 must return seq 20, not an empty page.
    const second = await reader.readTraceLines(pointer, 10, 2);
    expect(second.events.map((event) => event.seq)).toEqual([20]);
    expect(second.nextCursor).toBe(20);
    expect(second.complete).toBe(true);

    const exhausted = await reader.readTraceLines(pointer, 20, 2);
    expect(exhausted.events).toEqual([]);
    expect(exhausted.complete).toBe(true);
  });

  it("fails the archive when a provider member does not match its index digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-provider-tamper-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_ptamper",
      name: "provider tamper runtime",
      provider: "codex",
      daemonId: "dmn_ptamper",
      workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Provider tamper", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    // The provider member's bytes are swapped after the manifest digest was
    // taken, so only the per-member check can catch it.
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      members: [{ path: "sessions/ises_1/history.jsonl", body: Buffer.from("provider history\n") }],
      traces: { tsk_ptamper: traceFileBody({ events: 1, taskId: "tsk_ptamper" }) },
      tamperMemberBody: (path, body) => path.startsWith("sessions/")
        ? Buffer.from("tampered provider history\n")
        : body,
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_ptamper",
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
      new Response(fixture.bytes).body,
    );

    await expect(service.complete(
      runtime.id,
      issue.id,
      initialized.id,
      claim.uploadAttempt!,
    )).rejects.toThrow(/sha256|disagrees with the manifest/);
    const failed = store.getSessionArchive(initialized.id)!;
    expect(failed.status).toBe("failed");
    // A failed archive is not a GC barrier and leaves no trace pointer.
    expect(store.getSessionArchiveStatus(issue.id).gcReady).toBe(false);
    expect(store.getTaskTrace("tsk_ptamper")).toBeNull();
    expect(existsSync(join(root, failed.relativePath))).toBe(false);
  });

  it("fails the archive when a meta member does not match its index digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-meta-tamper-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_mtamper",
      name: "meta tamper runtime",
      provider: "codex",
      daemonId: "dmn_mtamper",
      workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Meta tamper", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    // The published index points at a size the container does not have, which
    // is what a hand-edited index looks like.
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_mtamper: traceFileBody({ events: 1, taskId: "tsk_mtamper" }) },
      tamperIndex(index) {
        const provider = index.members.find((member) => member.kind === "provider");
        if (provider) provider.compressed_size += 1;
        else index.members[0]!.uncompressed_size += 1;
      },
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_mtamper",
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
      new Response(fixture.bytes).body,
    );

    await expect(service.complete(
      runtime.id,
      issue.id,
      initialized.id,
      claim.uploadAttempt!,
    )).rejects.toThrow(/size mismatch|sha256|disagrees with the manifest/);
    expect(store.getSessionArchive(initialized.id)).toMatchObject({ status: "failed" });
    expect(store.getTaskTrace("tsk_mtamper")).toBeNull();
  });

  it("does not re-point a lost trace when an archive arrives", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-lost-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_lost",
      name: "lost runtime",
      provider: "codex",
      daemonId: "dmn_lost",
      workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Lost trace", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    // A retired daemon's trace is unrecoverable; the ruling keeps `lost` out of
    // the allowed transitions.
    db!.run(
      `INSERT INTO multiremi_task_traces (
         task_id, location, head_seq, event_count, closed, updated_at
       ) VALUES ('tsk_lost', 'lost', 99, 99, 1, '2026-09-27T00:00:00.000Z')`,
    );
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_lost: traceFileBody({ events: 3, taskId: "tsk_lost" }) },
    });
    const initialized = service.initialize({
      workspaceId: "local",
      subjectKind: "issue",
      subjectId: issue.id,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: "dmn_lost",
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
      new Response(fixture.bytes).body,
    );
    const ready = await service.complete(runtime.id, issue.id, initialized.id, claim.uploadAttempt!);

    // The archive is ready, but the lost pointer is untouched.
    expect(ready.status).toBe("ready");
    expect(store.getTaskTrace("tsk_lost")).toMatchObject({
      location: "lost",
      archiveId: null,
      headSeq: 99,
    });
  });

  it("keeps the longer pointer when a lower-head archive completes second", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-concurrent-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_concurrent",
      name: "concurrent runtime",
      provider: "codex",
      daemonId: "dmn_concurrent",
      workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Concurrent pointers", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });

    const complete = async (events: number) => {
      const fixture = await buildArchiveFixture({
        subject: { kind: "issue", id: issue.id },
        traces: { tsk_concurrent: traceFileBody({ events, taskId: "tsk_concurrent" }) },
      });
      const archive = service.initialize({
        workspaceId: "local",
        subjectKind: "issue",
        subjectId: issue.id,
        issueId: issue.id,
        runtimeId: runtime.id,
        daemonId: "dmn_concurrent",
        sourceRevision: fixture.sourceRevision,
        sha256: fixture.sha256,
        sizeBytes: fixture.sizeBytes,
      }).archive;
      const claim = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
      await service.upload(
        runtime.id,
        issue.id,
        archive.id,
        claim.uploadAttempt!,
        new Response(fixture.bytes).body,
      );
      return await service.complete(runtime.id, issue.id, archive.id, claim.uploadAttempt!);
    };

    const long = await complete(7);
    expect(store.getTaskTrace("tsk_concurrent")).toMatchObject({ archiveId: long.id, headSeq: 7 });

    // A later snapshot happens to be shorter — a daemon that hot-started mid
    // life, or a backfill that had not caught up. It becomes ready like any
    // other archive, but the pointer must not move backwards.
    const short = await complete(2);
    expect(short.status).toBe("ready");
    expect(short.id).not.toBe(long.id);
    expect(store.getTaskTrace("tsk_concurrent")).toMatchObject({
      archiveId: long.id,
      headSeq: 7,
    });
    expect(store.listSessionArchives(issue.id)).toHaveLength(2);

    // The guard is the statement's own WHERE clause, so a stale writer that
    // races a newer one cannot clobber it: the upsert reports no change.
    const refused = store.writeTaskTraceArchivePointers([{
      taskId: "tsk_concurrent",
      archiveId: short.id,
      memberPath: "traces/tsk_concurrent.jsonl",
      dataOffset: 1,
      compressedSize: 1,
      uncompressedSize: 1,
      sha256: "0".repeat(64),
      eventCount: 2,
      headSeq: 2,
      closed: true,
      runtimeId: runtime.id,
    }], "daemon");
    expect(refused).toEqual({
      written: 0,
      rejected: [{
        taskId: "tsk_concurrent",
        archiveId: short.id,
        incomingSource: "daemon",
        incomingHeadSeq: 2,
        reason: "newer_head_same_source",
        currentLocation: "archive",
        currentSource: "daemon",
        currentArchiveId: long.id,
        currentHeadSeq: 7,
      }],
    });
    expect(store.getTaskTrace("tsk_concurrent")).toMatchObject({
      archiveId: long.id,
      headSeq: 7,
    });
  });
});

describe("Session archive trace member authorization", () => {
  async function fencingFixture(label: string, fileDatabase = false) {
    const root = mkdtempSync(join(tmpdir(), `multiremi-archive-${label}-`));
    dirs.push(root);
    const database = fileDatabase ? openSqliteDatabase(join(root, "archive.sqlite")) : null;
    const store = database ? new MultiremiStore(database) : createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: `rt_${label}`, name: label, provider: "codex",
      daemonId: `dmn_${label}`, workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: label, workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
    const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id }, traces: {} });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archive = service.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: issue.id,
      issueId: issue.id, runtimeId: runtime.id, daemonId: runtime.daemonId!, sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256, sizeBytes: fixture.sizeBytes }).archive;
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
    await service.upload(runtime.id, issue.id, archive.id, claim.uploadAttempt!, new Response(fixture.bytes).body);
    return { root, database, store, runtime, issue, fixture, service, archive, firstAttempt: claim.uploadAttempt!,
      finalPath: join(root, archive.relativePath) };
  }

  for (const readyBeforeOldCleanup of [false, true]) {
    it(`keeps attempt B's ZIP, manifest and partial after manual retry (B ready=${readyBeforeOldCleanup})`, async () => {
      const f = await fencingFixture(`aba_${readyBeforeOldCleanup}`);
      const originalComplete = f.store.completeSessionArchiveWithTracePointers.bind(f.store);
      let rejectA = true;
      f.store.completeSessionArchiveWithTracePointers = (...args) => {
        if (rejectA) { rejectA = false; throw new Error("A ready transaction failed"); }
        return originalComplete(...args);
      };
      const internal = f.service as unknown as { cleanupFailedPromotion: (...args: unknown[]) => Promise<void>;
        syncDirectory: (path: string) => Promise<void> };
      const cleanup = internal.cleanupFailedPromotion.bind(f.service);
      let reachedA!: () => void;
      let releaseA!: () => void;
      const aPaused = new Promise<void>((resolve) => { reachedA = resolve; });
      const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
      internal.cleanupFailedPromotion = async (...args) => { reachedA(); await aGate; return cleanup(...args); };
      const oldCompletion = f.service.complete(f.runtime.id, f.issue.id, f.archive.id, f.firstAttempt);
      await aPaused;
      expect(f.store.getSessionArchive(f.archive.id)?.status).toBe("failed");
      expect((await f.service.retry(f.archive.id)).retryBudgetBaseAttempt).toBe(f.firstAttempt);
      const b = await f.service.claimUploadAttempt(f.runtime.id, f.issue.id, f.archive.id);
      expect(b.uploadAttempt).toBe(f.firstAttempt + 1);
      await f.service.upload(f.runtime.id, f.issue.id, f.archive.id, b.uploadAttempt!,
        new Response(f.fixture.bytes).body);
      // Make A's published ZIP unusable so B must rename its own partial into the shared path.
      writeFileSync(f.finalPath, Buffer.alloc(f.fixture.bytes.length));
      let releaseB = () => {};
      let bPaused: Promise<void> | null = null;
      if (!readyBeforeOldCleanup) {
        const sync = internal.syncDirectory.bind(f.service);
        let reachedB!: () => void;
        bPaused = new Promise<void>((resolve) => { reachedB = resolve; });
        const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
        internal.syncDirectory = async (path) => { reachedB(); await bGate; return sync(path); };
      }
      const bCompletion = f.service.complete(f.runtime.id, f.issue.id, f.archive.id, b.uploadAttempt!);
      if (bPaused) await bPaused;
      else await bCompletion;
      const manifestPath = join(f.root, f.archive.relativePath, "..", "manifest.json");
      const bPartial = `${f.finalPath}.${b.uploadAttempt}.partial`;
      writeFileSync(bPartial, "B partial remains attempt-owned");
      releaseA();
      await expect(oldCompletion).rejects.toThrow("A ready transaction failed");
      expect(readFileSync(f.finalPath)).toEqual(Buffer.from(f.fixture.bytes));
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({ attempt_count: b.uploadAttempt });
      expect(readFileSync(bPartial, "utf8")).toBe("B partial remains attempt-owned");
      releaseB();
      expect((await bCompletion).status).toBe("ready");
    });
  }

  it("holds the SQLite archive fence from ownership check through unlink", async () => {
    const f = await fencingFixture("sqlite_lock", true);
    const secondaryDb = openSqliteDatabase(join(f.root, "archive.sqlite"));
    secondaryDb.exec("PRAGMA busy_timeout = 0");
    const secondary = new MultiremiStore(secondaryDb);
    const originalComplete = f.store.completeSessionArchiveWithTracePointers.bind(f.store);
    f.store.completeSessionArchiveWithTracePointers = () => { throw new Error("ready failed"); };
    const internal = f.service as unknown as { onCleanupLocked: () => void };
    let checked = false;
    let lockError: unknown;
    internal.onCleanupLocked = () => {
      checked = true;
      try { secondary.retrySessionArchive(f.archive.id); } catch (error) { lockError = error; }
    };
    try {
      await expect(f.service.complete(f.runtime.id, f.issue.id, f.archive.id, f.firstAttempt))
        .rejects.toThrow("ready failed");
      expect(checked).toBe(true);
      expect(String(lockError)).toMatch(/busy|locked/i);
      f.store.completeSessionArchiveWithTracePointers = originalComplete;
      await f.service.retry(f.archive.id);
      const b = await f.service.claimUploadAttempt(f.runtime.id, f.issue.id, f.archive.id);
      await f.service.upload(f.runtime.id, f.issue.id, f.archive.id, b.uploadAttempt!, new Response(f.fixture.bytes).body);
      expect((await f.service.complete(f.runtime.id, f.issue.id, f.archive.id, b.uploadAttempt!)).status).toBe("ready");
      expect(readFileSync(f.finalPath)).toEqual(Buffer.from(f.fixture.bytes));
      expect(JSON.parse(readFileSync(join(f.root, f.archive.relativePath, "..", "manifest.json"), "utf8")))
        .toMatchObject({ attempt_count: b.uploadAttempt });
    } finally { secondaryDb.close(); f.database?.close(); }
  });

  it("rejects a stale lower attempt before it can promote over B", async () => {
    const f = await fencingFixture("stale_promotion");
    const internal = f.service as unknown as { writeManifest: (...args: unknown[]) => Promise<string> };
    const write = internal.writeManifest.bind(f.service);
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    internal.writeManifest = async (...args) => {
      const path = await write(...args);
      if (first) { first = false; reached(); await gate; }
      return path;
    };
    const stale = f.service.complete(f.runtime.id, f.issue.id, f.archive.id, f.firstAttempt);
    await paused;
    f.store.markSessionArchiveFailedAttempt(f.archive.id, f.runtime.id, f.firstAttempt, "retry");
    await f.service.retry(f.archive.id);
    const b = await f.service.claimUploadAttempt(f.runtime.id, f.issue.id, f.archive.id);
    await f.service.upload(f.runtime.id, f.issue.id, f.archive.id, b.uploadAttempt!, new Response(f.fixture.bytes).body);
    expect((await f.service.complete(f.runtime.id, f.issue.id, f.archive.id, b.uploadAttempt!)).status).toBe("ready");
    release();
    await expect(stale).rejects.toMatchObject({ code: "session_archive_attempt_conflict" });
    expect(readFileSync(f.finalPath)).toEqual(Buffer.from(f.fixture.bytes));
    expect(JSON.parse(readFileSync(join(f.root, f.archive.relativePath, "..", "manifest.json"), "utf8")))
      .toMatchObject({ attempt_count: b.uploadAttempt });
  });
  it("accepts one Issue package with multiple sessions, retry, delegation, and another provider Runtime on the same daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-issue-members-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const leader = store.createAgent({ name: "Issue leader", provider: "codex", workspaceId: "local" });
    const delegate = store.createAgent({ name: "Issue delegate", provider: "claude", workspaceId: "local" });
    const owner = store.registerRuntime({ id: "rt_issue_owner", name: "owner", provider: "codex",
      daemonId: "dmn_issue_shared", workspaceId: "local" });
    const otherProvider = store.registerRuntime({ id: "rt_issue_claude", name: "claude", provider: "claude",
      daemonId: "dmn_issue_shared", workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "Issue package", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: owner.id,
      rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
    const secondSession = store.createIssueSession(issue.id, { title: "Second session" });
    const original = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "original" });
    expect(store.claimTask(owner.id)?.id).toBe(original.id);
    store.startTask(original.id);
    store.failTask(original.id, { error: "timeout", failureReason: "timeout" });
    const retry = store.listTasks().find(task => task.parentTaskId === original.id)!;
    const sibling = store.createTask({ agentId: leader.id, issueId: issue.id,
      issueSessionId: secondSession.id, prompt: "second session" });
    const delegated = store.createTask({ agentId: delegate.id, issueId: issue.id,
      parentTaskId: original.id, delegationId: "dlg_issue_package",
      delegatedByAgentId: leader.id, prompt: "delegated" });
    for (const task of [original, retry, sibling]) {
      mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [owner.id, task.id]);
    }
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [otherProvider.id, delegated.id]);
    const tasks = [original, retry, sibling, delegated];
    const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id },
      members: [original.issueSessionId!, secondSession.id].map((sessionId) => ({
        path: `sessions/${sessionId}/history.jsonl`, body: Buffer.from("session history\n"),
      })),
      traces: Object.fromEntries(tasks.map((task) => [task.id, traceFileBody({ events: 1, taskId: task.id })])) });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archive = service.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: issue.id,
      issueId: issue.id, runtimeId: owner.id, daemonId: owner.daemonId!, sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256, sizeBytes: fixture.sizeBytes }).archive;
    const claim = await service.claimUploadAttempt(owner.id, issue.id, archive.id);
    await service.upload(owner.id, issue.id, archive.id, claim.uploadAttempt!, new Response(fixture.bytes).body);
    expect((await service.complete(owner.id, issue.id, archive.id, claim.uploadAttempt!)).status).toBe("ready");
    expect(fixture.contents.has(`sessions/${original.issueSessionId}/history.jsonl`)).toBe(true);
    expect(fixture.contents.has(`sessions/${secondSession.id}/history.jsonl`)).toBe(true);
    for (const task of tasks) expect(store.getTaskTrace(task.id)).toMatchObject({ archiveId: archive.id, headSeq: 1 });
  });

  it("cleans its promoted ZIP and manifest when the ready transaction rejects changed membership", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-late-reject-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Late reject", provider: "codex", workspaceId: "local" });
    const owner = store.registerRuntime({ id: "rt_late_owner", name: "owner", provider: "codex",
      daemonId: "dmn_late_owner", workspaceId: "local" });
    const foreign = store.registerRuntime({ id: "rt_late_foreign", name: "foreign", provider: "claude",
      daemonId: "dmn_late_foreign", workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "Late reject", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: owner.id,
      rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "trace" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [owner.id, task.id]);
    const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id },
      traces: { [task.id]: traceFileBody({ events: 1, taskId: task.id }) } });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archive = service.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: issue.id,
      issueId: issue.id, runtimeId: owner.id, daemonId: owner.daemonId!, sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256, sizeBytes: fixture.sizeBytes }).archive;
    const claim = await service.claimUploadAttempt(owner.id, issue.id, archive.id);
    await service.upload(owner.id, issue.id, archive.id, claim.uploadAttempt!, new Response(fixture.bytes).body);
    const complete = store.completeSessionArchiveWithTracePointers.bind(store);
    store.completeSessionArchiveWithTracePointers = (...args) => {
      mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [foreign.id, task.id]);
      return complete(...args);
    };
    await expect(service.complete(owner.id, issue.id, archive.id, claim.uploadAttempt!))
      .rejects.toMatchObject({ status: 422, code: "session_archive_trace_ownership_mismatch" });
    expect(store.getSessionArchive(archive.id)?.status).toBe("failed");
    expect(store.getTaskTrace(task.id)).toBeNull();
    expect(existsSync(join(root, archive.relativePath))).toBe(false);
    expect(existsSync(join(root, archive.relativePath, "..", "manifest.json"))).toBe(false);
  });

  it("cleans its promoted ZIP when writing the manifest fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-manifest-fail-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_manifest_fail", name: "owner", provider: "codex",
      daemonId: "dmn_manifest_fail", workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "Manifest failure", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
    const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id }, traces: {} });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archive = service.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: issue.id,
      issueId: issue.id, runtimeId: runtime.id, daemonId: runtime.daemonId!, sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256, sizeBytes: fixture.sizeBytes }).archive;
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
    await service.upload(runtime.id, issue.id, archive.id, claim.uploadAttempt!, new Response(fixture.bytes).body);
    const internal = service as unknown as { writeManifest: (...args: unknown[]) => Promise<void> };
    const original = internal.writeManifest.bind(service);
    internal.writeManifest = async (...args) => { await original(...args); throw new Error("manifest sync failed"); };
    await expect(service.complete(runtime.id, issue.id, archive.id, claim.uploadAttempt!))
      .rejects.toThrow("manifest sync failed");
    expect(store.getSessionArchive(archive.id)?.status).toBe("failed");
    expect(existsSync(join(root, archive.relativePath))).toBe(false);
    expect(existsSync(join(root, archive.relativePath, "..", "manifest.json"))).toBe(false);
  });

  it("preserves a newer promoted ZIP and manifest when the old ready transaction loses", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-late-fence-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_late_fence", name: "owner", provider: "codex",
      daemonId: "dmn_late_fence", workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "Late fence", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
    const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id }, traces: {} });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archive = service.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: issue.id,
      issueId: issue.id, runtimeId: runtime.id, daemonId: runtime.daemonId!, sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256, sizeBytes: fixture.sizeBytes }).archive;
    const old = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
    await service.upload(runtime.id, issue.id, archive.id, old.uploadAttempt!, new Response(fixture.bytes).body);
    let entered!: () => void;
    let release!: () => void;
    const reachedSync = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const internal = service as unknown as { syncDirectory: (path: string) => Promise<void> };
    const sync = internal.syncDirectory.bind(service);
    let first = true;
    internal.syncDirectory = async (path) => {
      if (first) { first = false; entered(); await gate; }
      return sync(path);
    };
    const stale = service.complete(runtime.id, issue.id, archive.id, old.uploadAttempt!);
    await reachedSync;
    const finalPath = join(root, archive.relativePath);
    expect(existsSync(finalPath)).toBe(true);
    expect(store.markSessionArchiveFailedAttempt(archive.id, runtime.id, old.uploadAttempt!, "retry")?.status)
      .toBe("failed");
    db!.run("UPDATE multiremi_session_archives SET next_retry_at = ? WHERE id = ?",
      ["2000-01-01T00:00:00.000Z", archive.id]);
    const newer = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
    await service.upload(runtime.id, issue.id, archive.id, newer.uploadAttempt!, new Response(fixture.bytes).body);
    writeFileSync(finalPath, Buffer.alloc(fixture.bytes.length));
    expect((await service.complete(runtime.id, issue.id, archive.id, newer.uploadAttempt!)).status).toBe("ready");
    release();
    await expect(stale).rejects.toMatchObject({ status: 409, code: "session_archive_attempt_conflict" });
    expect(store.getSessionArchive(archive.id)).toMatchObject({ status: "ready", attemptCount: newer.uploadAttempt });
    expect(readFileSync(finalPath)).toEqual(Buffer.from(fixture.bytes));
    expect(JSON.parse(readFileSync(join(root, archive.relativePath, "..", "manifest.json"), "utf8")))
      .toMatchObject({ archive_id: archive.id, attempt_count: newer.uploadAttempt });
  });

  it("leaves a newer attempt's final file intact when an older completion fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-archive-attempt-fence-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({
      id: "rt_attempt_fence", name: "attempt fence", provider: "codex",
      daemonId: "dmn_attempt_fence", workspaceId: "local",
    });
    const issue = createResponsibleTestIssue(store, { title: "Attempt fence", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_fenced: traceFileBody({ events: 1, taskId: "tsk_fenced" }) },
    });
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    const archive = service.initialize({
      workspaceId: "local", subjectKind: "issue", subjectId: issue.id, issueId: issue.id,
      runtimeId: runtime.id, daemonId: runtime.daemonId!, sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256, sizeBytes: fixture.sizeBytes,
    }).archive;
    const scope = issue.id;
    const old = await service.claimUploadAttempt(runtime.id, scope, archive.id);
    await service.upload(runtime.id, scope, archive.id, old.uploadAttempt!, new Response(fixture.bytes).body);
    let entered!: () => void;
    let release!: () => void;
    const reachedVerify = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const internal = service as unknown as { validateArchiveIngest: (...args: unknown[]) => Promise<unknown> };
    const verify = internal.validateArchiveIngest.bind(service);
    let first = true;
    internal.validateArchiveIngest = async (...args) => {
      if (first) {
        first = false;
        entered();
        await gate;
        throw new Error("old attempt rejected after replacement");
      }
      return verify(...args);
    };
    const stale = service.complete(runtime.id, scope, archive.id, old.uploadAttempt!);
    await reachedVerify;
    expect(store.markSessionArchiveFailedAttempt(archive.id, runtime.id, old.uploadAttempt!, "retry"))
      .toMatchObject({ status: "failed" });
    db!.run("UPDATE multiremi_session_archives SET next_retry_at = ? WHERE id = ?",
      ["2000-01-01T00:00:00.000Z", archive.id]);
    const newer = await service.claimUploadAttempt(runtime.id, scope, archive.id);
    await service.upload(runtime.id, scope, archive.id, newer.uploadAttempt!, new Response(fixture.bytes).body);
    expect((await service.complete(runtime.id, scope, archive.id, newer.uploadAttempt!)).status).toBe("ready");
    release();
    await expect(stale).rejects.toThrow("old attempt rejected after replacement");
    expect(store.getSessionArchive(archive.id)).toMatchObject({ status: "ready", attemptCount: newer.uploadAttempt });
    expect(readFileSync(join(root, archive.relativePath))).toEqual(Buffer.from(fixture.bytes));
  });

  for (const [reason, mismatch] of [
    ["another Runtime", "runtime"],
    ["another Chat on the same Runtime", "subject"],
    ["a missing task", "missing"],
    ["another workspace", "workspace"],
    ["a Runtime without a daemon", "nullDaemon"],
  ] as const) {
    it(`rejects the whole Chat archive when a trace names ${reason}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "multiremi-archive-member-auth-"));
      dirs.push(root);
      const store = createStore();
      store.ensureLocalWorkspace();
      const agent = store.createAgent({ name: "Member auth agent", provider: "codex", workspaceId: "local" });
      const owner = store.registerRuntime({
        id: "rt_member_owner", name: "owner", provider: "codex", daemonId: "dmn_member_owner", workspaceId: "local",
      });
      const other = store.registerRuntime({
        id: "rt_member_other", name: "other", provider: "codex", daemonId: "dmn_member_other", workspaceId: "local",
      });
      const noDaemon = store.registerRuntime({
        id: "rt_member_unbound", name: "unbound", provider: "claude", workspaceId: "local",
      });
      const chat = store.createChatSession({ agentId: agent.id, title: "Owner", workspaceId: "local" });
      const otherChat = store.createChatSession({ agentId: agent.id, title: "Other", workspaceId: "local" });
      db!.run("UPDATE multiremi_chat_sessions SET session_runtime_id = ? WHERE id IN (?, ?)",
        [owner.id, chat.id, otherChat.id]);
      const good = store.createTask({ agentId: agent.id, workspaceId: "local", chatSessionId: chat.id, prompt: "good" });
      const victim = mismatch === "missing" ? null : sentTask(store, store.sendMessage({
        session_id: mismatch === "subject" ? otherChat.id : chat.id,
        sender: { type: "member", id: "mem_local_local" }, to: { type: "agent", ref: agent.id },
        message_kind: "request", body_md: "victim", wake_requested: "now", execution_scope: "archive-victim",
      }));
      mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [owner.id, good.id]);
      if (victim) {
        mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET runtime_id = ? WHERE id = ?", [mismatch === "runtime" ? other.id : mismatch === "nullDaemon" ? noDaemon.id : owner.id, victim.id]);
        if (mismatch === "workspace") {
          const foreignWorkspace = store.createWorkspace({ name: "Foreign archive workspace", slug: "foreign-archive" });
          mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET workspace_id = ? WHERE id = ?", [foreignWorkspace.id, victim.id]);
        }
        db!.run("INSERT INTO multiremi_task_traces (task_id, location, runtime_id, updated_at) VALUES (?, 'daemon', ?, ?)",
          [victim.id, mismatch === "runtime" ? other.id : mismatch === "nullDaemon" ? noDaemon.id : owner.id,
            "2026-09-27T00:00:00.000Z"]);
      }
      const badId = victim?.id ?? "tsk_missing_member";
      const before = victim ? store.getTaskTrace(victim.id) : null;
      const fixture = await buildArchiveFixture({
        subject: { kind: "chat", id: chat.id },
        traces: {
          [good.id]: traceFileBody({ events: 1, taskId: good.id }),
          [badId]: traceFileBody({ events: 1, taskId: badId }),
        },
      });
      const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
      const archive = service.initialize({
        workspaceId: "local", subjectKind: "chat", subjectId: chat.id,
        runtimeId: owner.id, daemonId: owner.daemonId!,
        sourceRevision: fixture.sourceRevision, sha256: fixture.sha256, sizeBytes: fixture.sizeBytes,
      }).archive;
      const claim = await service.claimUploadAttempt(owner.id, { kind: "chat", id: chat.id }, archive.id);
      await service.upload(owner.id, { kind: "chat", id: chat.id }, archive.id,
        claim.uploadAttempt!, new Response(fixture.bytes).body);
      await expect(service.complete(owner.id, { kind: "chat", id: chat.id }, archive.id,
        claim.uploadAttempt!)).rejects.toMatchObject({ status: 422, code: "session_archive_trace_ownership_mismatch" });
      expect(store.getSessionArchive(archive.id)?.status).toBe("failed");
      expect(store.getTaskTrace(good.id)).toBeNull();
      expect(store.getTaskTrace(badId)).toEqual(before);
      expect(existsSync(join(root, archive.relativePath))).toBe(false);
    });
  }
});

const orphanBackends = await traceBackfillBackends("archive_orphan");
/** PostgreSQL clones a database for every case and migrates the file's template on the first one. */
const ORPHAN_CASE_TIMEOUT_MS = 30_000;

afterAll(async () => {
  for (const backend of orphanBackends) await backend.dispose();
});

for (const backend of orphanBackends) {
  describe.skipIf(!backend.available)(`Session archive orphaned final files (${backend.name})`, () => {
    type OrphanFixture = Awaited<ReturnType<typeof orphanFixture>>;

    async function orphanFixture(opened: OpenedStore, label: string) {
      const root = mkdtempSync(join(tmpdir(), `multiremi-archive-orphan-${label}-`));
      dirs.push(root);
      const { store, db: database } = opened;
      const runtime = store.registerRuntime({ id: `rt_orphan_${label}`, name: label, provider: "codex",
        daemonId: `dmn_orphan_${label}`, workspaceId: "local" });
      const issue = createResponsibleTestIssue(store, { title: label, workspaceId: "local" });
      store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id,
        rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
      const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id }, traces: {} });
      const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
      const archive = service.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: issue.id,
        issueId: issue.id, runtimeId: runtime.id, daemonId: runtime.daemonId!, sourceRevision: fixture.sourceRevision,
        sha256: fixture.sha256, sizeBytes: fixture.sizeBytes }).archive;
      const claim = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
      await service.upload(runtime.id, issue.id, archive.id, claim.uploadAttempt!, new Response(fixture.bytes).body);
      return { root, database, store, runtime, issue, fixture, service, archive, a: claim.uploadAttempt!,
        finalPath: join(root, archive.relativePath), manifestPath: join(root, archive.relativePath, "..", "manifest.json") };
    }

    /** One store per case: the sweep scans every archive row in it. */
    async function withFixture(label: string, body: (f: OrphanFixture) => Promise<void>): Promise<void> {
      const opened = await backend.open();
      try {
        await body(await orphanFixture(opened, label));
      } finally {
        await opened.close();
      }
    }

    /** Promote the attempt and stop before `ready`, as a Server that dies right there would. */
    async function promoteThenCrash(f: OrphanFixture, attempt: number): Promise<void> {
      const internal = f.service as unknown as { syncDirectory: (path: string) => Promise<void> };
      let promoted!: () => void;
      const reached = new Promise<void>((resolve) => { promoted = resolve; });
      internal.syncDirectory = () => { promoted(); return new Promise<void>(() => {}); };
      void f.service.complete(f.runtime.id, f.issue.id, f.archive.id, attempt);
      await reached;
    }

    /** Fail attempt A after promotion and retry before B4's cleanup runs, so A's pair stays behind. */
    async function retryBeforeCleanup(f: OrphanFixture): Promise<void> {
      const originalComplete = f.store.completeSessionArchiveWithTracePointers.bind(f.store);
      f.store.completeSessionArchiveWithTracePointers = () => {
        f.store.completeSessionArchiveWithTracePointers = originalComplete;
        throw new Error("A ready failed");
      };
      const internal = f.service as unknown as { cleanupFailedPromotion: (...args: unknown[]) => Promise<void> };
      const cleanup = internal.cleanupFailedPromotion.bind(f.service);
      let reachedA!: () => void;
      let releaseA!: () => void;
      const aPaused = new Promise<void>((resolve) => { reachedA = resolve; });
      const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
      internal.cleanupFailedPromotion = async (...args) => { reachedA(); await aGate; return cleanup(...args); };
      const oldCompletion = f.service.complete(f.runtime.id, f.issue.id, f.archive.id, f.a);
      await aPaused;
      await f.service.retry(f.archive.id);
      releaseA();
      await expect(oldCompletion).rejects.toThrow("A ready failed");
      internal.cleanupFailedPromotion = cleanup;
      // B4 found the row pending again, so attempt A's pair stayed.
      expect(f.store.getSessionArchive(f.archive.id)).toMatchObject({ status: "pending", attemptCount: f.a });
      expect(existsSync(f.finalPath)).toBe(true);
      expect(manifestAttempt(f.manifestPath)).toBe(f.a);
    }

    async function claimAndUpload(f: OrphanFixture): Promise<number> {
      const attempt = (await f.service.claimUploadAttempt(f.runtime.id, f.issue.id, f.archive.id)).uploadAttempt!;
      await f.service.upload(f.runtime.id, f.issue.id, f.archive.id, attempt, new Response(f.fixture.bytes).body);
      return attempt;
    }

    function manifestAttempt(path: string): unknown {
      return (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).attempt_count;
    }

    function isCandidate(f: OrphanFixture): boolean {
      return f.store.listOrphanCandidateSessionArchives().some((archive) => archive.id === f.archive.id);
    }

    for (const endedBy of ["stalled", "superseded"] as const) {
      it(`removes the pair a crash left between promotion and ready once its attempt is ${endedBy}`, async () => {
        await withFixture(`crash_${endedBy}`, async (f) => {
          await promoteThenCrash(f, f.a);
          const restarted = new SessionArchiveService(f.store, { root: f.root, minFreeBytes: 0 });
          expect(f.store.getSessionArchive(f.archive.id)).toMatchObject({ status: "uploading", attemptCount: f.a });
          expect(manifestAttempt(f.manifestPath)).toBe(f.a);
          // Still uploading: a re-sent complete of this attempt publishes exactly these files.
          expect(await restarted.sweepOrphanedArchiveFiles()).toEqual([]);
          expect(existsSync(f.finalPath)).toBe(true);
          expect(existsSync(f.manifestPath)).toBe(true);

          if (endedBy === "stalled") {
            f.store.markSessionArchiveFailedAttempt(f.archive.id, f.runtime.id, f.a, "upload stalled after 1ms");
          } else {
            restarted.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: f.issue.id, issueId: f.issue.id,
              runtimeId: f.runtime.id, daemonId: f.runtime.daemonId!, sourceRevision: "newer-snapshot",
              sha256: "e".repeat(64), sizeBytes: 1 });
          }
          expect(f.store.getSessionArchive(f.archive.id)).toMatchObject({
            status: endedBy === "stalled" ? "failed" : "superseded", attemptCount: f.a,
          });
          expect(await restarted.sweepOrphanedArchiveFiles()).toHaveLength(2);
          expect(existsSync(f.finalPath)).toBe(false);
          expect(existsSync(f.manifestPath)).toBe(false);
        });
      }, ORPHAN_CASE_TIMEOUT_MS);
    }

    it("removes the older attempt's pair that B4 skipped after a manual retry while the row is pending", async () => {
      await withFixture("retried_pending", async (f) => {
        await retryBeforeCleanup(f);
        expect(await f.service.sweepOrphanedArchiveFiles()).toHaveLength(2);
        expect(existsSync(f.finalPath)).toBe(false);
        expect(existsSync(f.manifestPath)).toBe(false);
        // The next attempt uploads and publishes as usual.
        const b = await claimAndUpload(f);
        expect((await f.service.complete(f.runtime.id, f.issue.id, f.archive.id, b)).status).toBe("ready");
        expect(readFileSync(f.finalPath)).toEqual(Buffer.from(f.fixture.bytes));
        expect(manifestAttempt(f.manifestPath)).toBe(b);
      });
    }, ORPHAN_CASE_TIMEOUT_MS);

    for (const outcome of ["stalls", "publishes"] as const) {
      it(`keeps that pair while the next attempt uploads, then ${outcome === "stalls"
        ? "removes it once the attempt stalls"
        : "leaves the pair the attempt publishes over it"}`, async () => {
        await withFixture(`retried_${outcome}`, async (f) => {
          await retryBeforeCleanup(f);
          const b = await claimAndUpload(f);
          expect(f.store.getSessionArchive(f.archive.id)).toMatchObject({ status: "uploading", attemptCount: b });
          expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
          expect(existsSync(f.finalPath)).toBe(true);
          expect(manifestAttempt(f.manifestPath)).toBe(f.a);
          expect(existsSync(`${f.finalPath}.${b}.partial`)).toBe(true);

          if (outcome === "stalls") {
            f.store.markSessionArchiveFailedAttempt(f.archive.id, f.runtime.id, b, "upload stalled after 1ms");
            expect(await f.service.sweepOrphanedArchiveFiles()).toHaveLength(2);
            expect(existsSync(f.finalPath)).toBe(false);
            expect(existsSync(f.manifestPath)).toBe(false);
            // Attempt partials stay with B4's own cleanup.
            expect(existsSync(`${f.finalPath}.${b}.partial`)).toBe(true);
          } else {
            expect((await f.service.complete(f.runtime.id, f.issue.id, f.archive.id, b)).status).toBe("ready");
            expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
            expect(readFileSync(f.finalPath)).toEqual(Buffer.from(f.fixture.bytes));
            expect(manifestAttempt(f.manifestPath)).toBe(b);
          }
        });
      }, ORPHAN_CASE_TIMEOUT_MS);
    }

    it("decides under the lock from the row as it stands, not as it was listed", async () => {
      await withFixture("relisted", async (f) => {
        await retryBeforeCleanup(f);
        const listed = f.store.listOrphanCandidateSessionArchives.bind(f.store);
        // Listed pending at attempt A; a claim bumps the raw attempt before the sweep takes the lock.
        const atRetry = listed();
        const b = (await f.service.claimUploadAttempt(f.runtime.id, f.issue.id, f.archive.id)).uploadAttempt!;
        f.store.listOrphanCandidateSessionArchives = () => atRetry;
        expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
        // Listed pending at B; its upload begins, same raw attempt, before the sweep takes the lock.
        const atClaim = listed();
        expect(atClaim.find((archive) => archive.id === f.archive.id)).toMatchObject({ status: "pending", attemptCount: b });
        await f.service.upload(f.runtime.id, f.issue.id, f.archive.id, b, new Response(f.fixture.bytes).body);
        f.store.listOrphanCandidateSessionArchives = () => atClaim;
        expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
        expect(existsSync(f.finalPath)).toBe(true);
        expect(manifestAttempt(f.manifestPath)).toBe(f.a);
        f.store.listOrphanCandidateSessionArchives = listed;
        expect(isCandidate(f)).toBe(false);
      });
    }, ORPHAN_CASE_TIMEOUT_MS);

    it("keeps the pair of an uploading row, even beside an older attempt's manifest, and of a ready archive", async () => {
      await withFixture("live", async (f) => {
        // A crash between the live attempt's two renames leaves its ZIP beside an older manifest.
        writeFileSync(f.finalPath, f.fixture.bytes);
        writeFileSync(f.manifestPath, JSON.stringify({ archive_id: f.archive.id, attempt_count: f.a - 1 }));
        expect(isCandidate(f)).toBe(false);
        expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
        expect(existsSync(f.finalPath)).toBe(true);
        expect(manifestAttempt(f.manifestPath)).toBe(f.a - 1);

        const internal = f.service as unknown as { syncDirectory: (path: string) => Promise<void> };
        const sync = internal.syncDirectory.bind(f.service);
        let reached!: () => void;
        let release!: () => void;
        const promoted = new Promise<void>((resolve) => { reached = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        internal.syncDirectory = async (path) => { reached(); await gate; return sync(path); };
        const completion = f.service.complete(f.runtime.id, f.issue.id, f.archive.id, f.a);
        await promoted;
        expect(manifestAttempt(f.manifestPath)).toBe(f.a);
        expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
        release();
        expect((await completion).status).toBe("ready");

        expect(isCandidate(f)).toBe(false);
        expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
        expect(readFileSync(f.finalPath)).toEqual(Buffer.from(f.fixture.bytes));
        expect(manifestAttempt(f.manifestPath)).toBe(f.a);
      });
    }, ORPHAN_CASE_TIMEOUT_MS);

    it("removes a failed row's pair or lone ZIP but leaves files beside another archive's or an unreadable manifest", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withFixture("manifests", async (f) => {
          f.store.markSessionArchiveFailedAttempt(f.archive.id, f.runtime.id, f.a, "failed");
          for (const [manifest, reason] of [
            [JSON.stringify({ archive_id: "sar_someone_else", attempt_count: f.a }), /manifest of another archive/],
            ["{\"archive_id\":", /unreadable manifest/],
          ] as const) {
            writeFileSync(f.finalPath, f.fixture.bytes);
            writeFileSync(f.manifestPath, manifest);
            warn.mockClear();
            expect(await f.service.sweepOrphanedArchiveFiles()).toEqual([]);
            expect(existsSync(f.finalPath)).toBe(true);
            expect(readFileSync(f.manifestPath, "utf8")).toBe(manifest);
            expect(warn.mock.calls.some(([message]) => reason.test(String(message)))).toBe(true);
          }
          writeFileSync(f.manifestPath, JSON.stringify({ archive_id: f.archive.id, attempt_count: f.a }));
          expect(await f.service.sweepOrphanedArchiveFiles()).toHaveLength(2);
          writeFileSync(f.finalPath, f.fixture.bytes);
          expect(await f.service.sweepOrphanedArchiveFiles()).toHaveLength(1);
          expect(existsSync(f.finalPath)).toBe(false);
          expect(existsSync(f.manifestPath)).toBe(false);
        });
      } finally {
        warn.mockRestore();
      }
    }, ORPHAN_CASE_TIMEOUT_MS);

    it("sweeps on its own timer until stopped", async () => {
      await withFixture("timer", async (f) => {
        f.store.markSessionArchiveFailedAttempt(f.archive.id, f.runtime.id, f.a, "failed");
        writeFileSync(f.finalPath, f.fixture.bytes);
        f.service.startOrphanedArchiveFileSweep(10);
        try {
          for (let i = 0; i < 200 && existsSync(f.finalPath); i += 1) await Bun.sleep(10);
          expect(existsSync(f.finalPath)).toBe(false);
        } finally {
          f.service.stopOrphanedArchiveFileSweep();
        }
        // Drain a pass that may still be running, then nothing sweeps any more.
        await f.service.sweepOrphanedArchiveFiles();
        writeFileSync(f.finalPath, f.fixture.bytes);
        await Bun.sleep(60);
        expect(existsSync(f.finalPath)).toBe(true);
      });
    }, ORPHAN_CASE_TIMEOUT_MS);

    it("refuses withLockedSharedPaths when the raw attempt, the Runtime or the status alone is wrong", async () => {
      await withFixture("lock_conditions", async (f) => {
        // Called on the store directly: no service fence runs first. `other` is a
        // registered Runtime that only the row's own runtime_id tells apart.
        const other = f.store.registerRuntime({ id: "rt_orphan_lock_other", name: "other", provider: "codex",
          daemonId: "dmn_orphan_lock_other", workspaceId: "local" });
        // Raw attempt 3 with a retry budget based at 2: the budget-relative attempt 1 must not pass.
        f.database.run("UPDATE multiremi_session_archives SET attempt_count = 3, retry_budget_base_attempt = 2 WHERE id = ?",
          [f.archive.id]);
        const accepted = {
          promote: ["uploading"],
          cleanup: ["failed"],
          orphan: ["pending", "failed", "superseded"],
        } as const;
        const seen: Array<{ mode: string; status: string; runtimeId: string; attempt: number; ran: boolean }> = [];
        const expected: typeof seen = [];
        for (const mode of ["promote", "cleanup", "orphan"] as const) {
          for (const status of ["pending", "uploading", "failed", "superseded", "ready"] as const) {
            f.database.run("UPDATE multiremi_session_archives SET status = ? WHERE id = ?", [status, f.archive.id]);
            const statusAccepted = (accepted[mode] as readonly string[]).includes(status);
            for (const [runtimeId, attempt] of [[f.runtime.id, 3], [f.runtime.id, 1], [f.runtime.id, 2],
              [f.runtime.id, 4], [other.id, 3]] as const) {
              let ran = false;
              const result = f.store.withLockedSessionArchiveSharedPaths(f.archive.id, runtimeId, attempt, mode, () => {
                ran = true;
                return "ran";
              });
              expect(result).toBe(ran ? "ran" : null);
              seen.push({ mode, status, runtimeId, attempt, ran });
              expected.push({ mode, status, runtimeId, attempt,
                ran: statusAccepted && runtimeId === f.runtime.id && attempt === 3 });
            }
          }
        }
        expect(seen).toEqual(expected);
        expect(seen.filter((entry) => entry.ran)).toHaveLength(5);
      });
    }, ORPHAN_CASE_TIMEOUT_MS);

    it("warns when filesystem work under the shared-path lock passes the threshold", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const thresholdMs of [5, 10_000]) {
          await withFixture(`slow_${thresholdMs}`, async (f) => {
            const internal = f.service as unknown as {
              lockedFsWarnMs: number; fileIdentitySync: (path: string) => unknown;
            };
            internal.lockedFsWarnMs = thresholdMs;
            // Only locked work stats final and partial files, so this slows promote, cleanup and orphan alike.
            const identity = internal.fileIdentitySync.bind(f.service);
            internal.fileIdentitySync = (path) => { Bun.sleepSync(30); return identity(path); };
            warn.mockClear();
            const originalComplete = f.store.completeSessionArchiveWithTracePointers.bind(f.store);
            f.store.completeSessionArchiveWithTracePointers = () => { throw new Error("ready failed"); };
            await expect(f.service.complete(f.runtime.id, f.issue.id, f.archive.id, f.a)).rejects.toThrow("ready failed");
            f.store.completeSessionArchiveWithTracePointers = originalComplete;
            writeFileSync(f.finalPath, f.fixture.bytes);
            writeFileSync(f.manifestPath, JSON.stringify({ archive_id: f.archive.id, attempt_count: f.a }));
            expect(await f.service.sweepOrphanedArchiveFiles()).toHaveLength(2);
            const slow = warn.mock.calls.map(([message]) => String(message))
              .filter((message) => message.includes("held the shared-path lock"));
            const held = (mode: string) => slow.filter((message) => new RegExp(
              `${mode} held the shared-path lock for \\d+ms of filesystem work `
              + `\\(archive ${f.archive.id}, attempt ${f.a}, threshold ${thresholdMs}ms\\)`,
            ).test(message));
            if (thresholdMs === 5) {
              expect(held("promote")).toHaveLength(1);
              expect(held("cleanup")).toHaveLength(1);
              expect(held("orphan")).toHaveLength(1);
              expect(slow).toHaveLength(3);
            } else {
              expect(slow).toEqual([]);
            }
          });
        }
      } finally {
        warn.mockRestore();
      }
    }, ORPHAN_CASE_TIMEOUT_MS);
  });
}
