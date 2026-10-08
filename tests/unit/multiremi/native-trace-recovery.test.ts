import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { SessionArchiveService, type NativeTraceRecoveryIngestInput } from "@multiremi/session-archive/service.js";
import { nativeRecoveryMetadata, type NativeTraceRecoveryTask } from "@multiremi/session-archive/native-recovery.js";
import { TraceReader } from "@multiremi/trace/trace-reader.js";
import { TRACE_FILE_FORMAT } from "@multiremi/contracts/trace-file.js";
import { insertSyntheticAgent, insertSyntheticIssue, insertSyntheticRuntime, insertSyntheticTask } from "../../../scripts/lib/task-trace-synthetic.js";
import { buildArchiveFixture } from "./session-archive-fixtures.js";
import { traceBackfillBackends, type StoreBackend, type OpenedStore } from "./trace-backfill-backends.js";
import { assertNativeTraceServiceIdentity, createNativeTraceOperatorStore, runNativeTraceImport, type NativeTraceImportManifest } from "../../../scripts/import-native-task-traces.js";

const START = "2026-10-04T00:00:00.000Z";
const END = "2026-10-04T00:10:00.000Z";
const CHECKED = "2026-10-06T00:00:00.000Z";
const SERVICE_IDENTITY = { uid: process.geteuid!(), gid: process.getegid!() };
const backends = await traceBackfillBackends("native_recovery");
afterAll(async () => { for (const backend of backends) await backend.dispose(); });

interface World extends OpenedStore {
  root: string;
  service: SessionArchiveService;
  candidate: NativeTraceRecoveryTask;
  stage(overrides?: { session?: string; agent?: string; provider?: string; trailerCount?: number; extraProvider?: boolean;
    startedAt?: string; endStatus?: "completed" | "cancelled" }): Promise<NativeTraceRecoveryIngestInput>;
}

const EVENTS = [
  { seq: 1, ts: START, type: "text", content: "Reconstructed historical reply", meta: { recovery_source: "native_provider_jsonl" } },
  { seq: 2, ts: "2026-10-04T00:01:00.000Z", type: "tool_use", tool: "Bash", tool_call_id: "call_native_1", input: { command: "pwd" } },
  { seq: 3, ts: "2026-10-04T00:01:01.000Z", type: "tool_result", tool: "Bash", tool_call_id: "call_native_1", output: "/work", status: "completed" },
];

describe("native trace importer service identity", () => {
  it("requires both API ids and accepts either explicit verified ids or configured container ids", () => {
    expect(() => assertNativeTraceServiceIdentity(undefined, { uid: 0, gid: 0 }, {})).toThrow("requires the actual API service uid/gid");
    expect(() => assertNativeTraceServiceIdentity(undefined, { uid: 0, gid: 0 }, { REMI_RUNTIME_UID: "1001" })).toThrow("requires the actual API service uid/gid");
    expect(assertNativeTraceServiceIdentity({ uid: 1001, gid: 1001 }, { uid: 1001, gid: 1001 }, {})).toEqual({ uid: 1001, gid: 1001 });
    expect(assertNativeTraceServiceIdentity(undefined, { uid: 1001, gid: 1001 }, { REMI_RUNTIME_UID: "1001", REMI_RUNTIME_GID: "1001" }))
      .toEqual({ uid: 1001, gid: 1001 });
  });

  it("rejects root docker exec, wrong primary gid and a flag overriding configured service ids", () => {
    expect(() => assertNativeTraceServiceIdentity(undefined, { uid: 0, gid: 0 }, { REMI_RUNTIME_UID: "1001", REMI_RUNTIME_GID: "1001" }))
      .toThrow("docker exec --user 1001:1001");
    expect(() => assertNativeTraceServiceIdentity({ uid: 1001, gid: 1001 }, { uid: 1001, gid: 0 }, {})).toThrow("differs from API service");
    expect(() => assertNativeTraceServiceIdentity({ uid: 0, gid: 0 }, { uid: 0, gid: 0 }, { REMI_RUNTIME_UID: "1001", REMI_RUNTIME_GID: "1001" }))
      .toThrow("conflicts with REMI_RUNTIME_UID/GID");
    expect(() => assertNativeTraceServiceIdentity(undefined, { uid: 1001, gid: 1001 }, { REMI_RUNTIME_UID: "abc", REMI_RUNTIME_GID: "1001" }))
      .toThrow("numeric uid/gid");
  });
});

async function withWorld(backend: StoreBackend, run: (world: World) => Promise<void>) {
  const opened = await backend.open();
  const root = await mkdtemp(join(tmpdir(), "remi-native-recovery-"));
  try {
    const { db, store } = opened;
    insertSyntheticAgent(db, { id: "agt_recovery", provider: "codex", createdAt: START });
    insertSyntheticRuntime(db, { id: "rt_recovery", provider: "codex", daemonId: "dmn_recovery", createdAt: START });
    insertSyntheticIssue(db, { id: "iss_recovery", number: 1, createdAt: START });
    insertSyntheticTask(db, {
      id: "tsk_recovery", agentId: "agt_recovery", runtimeId: "rt_recovery", provider: "codex",
      issueId: "iss_recovery", issueSessionId: "ises_recovery", status: "completed",
      createdAt: START, startedAt: START, endedAt: END,
    });
    db.run("UPDATE multiremi_tasks SET session_id = ?, usage = ?, result = ? WHERE id = ?",
      "native_session_1", '[{"inputTokens":762200,"outputTokens":119200}]', "Original final reply", "tsk_recovery");
    db.run(`INSERT INTO multiremi_conversation_log
      (session_id, seq, id, kind, visibility, task_id, metadata, body_md, revision, created_at, updated_at)
      VALUES (?, 1, ?, 'turn', 'shown', ?, ?, ?, 7, ?, ?)`,
    "ises_recovery", "entry_recovery", "tsk_recovery",
    '{"event_count":999,"tool_call_count":72,"model":{"provider":"codex","model":"original-model"},"usage":{"input":762200}}',
    "Original card", START, END);
    store.markTraceBackfillDone({ subjectKind: "issue", subjectId: "iss_recovery", taskCount: 1, rowCount: 44, digest: "legacy-digest", archiveId: "sar_legacy" });
    store.replaceTraceBackfillTasks("issue", "iss_recovery", "sar_legacy", [{ taskId: "tsk_legacy", rowCount: 44, headSeq: 88, digest: "legacy-task-digest" }]);
    store.markTaskTraceDaemon("tsk_recovery", "rt_recovery");
    const candidate: NativeTraceRecoveryTask = {
      task: store.getNativeTraceRecoveryTaskSnapshot("tsk_recovery")!,
      expectedPointer: store.getTaskTrace("tsk_recovery")!,
      evidence: {
        sourceSha256: "a".repeat(64), sourceBytes: 34000000, nativeSessionId: "native_session_1", nativeTurnIds: ["native_turn_1"],
        taskIdentityEvidence: ["exact task_id marker at native user message line 100"],
        sourceStartLine: 100, sourceEndLine: 500, recoveredEventKinds: ["text", "tool_use", "tool_result"],
        omissions: ["Original streaming chunk boundaries are not preserved"],
        missingTrace: { checkedAt: CHECKED, reason: "trace_not_hot" },
      },
    };
    const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
    let staging = 0;
    await run({ ...opened, root, service, candidate, async stage(overrides = {}) {
      const header = {
        format: TRACE_FILE_FORMAT, task_id: "tsk_recovery", session_id: overrides.session ?? "ises_recovery",
        agent_id: overrides.agent ?? "agt_recovery", runtime_id: "rt_recovery", provider: overrides.provider ?? "codex", started_at: overrides.startedAt ?? START,
      };
      const body = [...[header], ...EVENTS, { end: { status: overrides.endStatus ?? "completed", head: 3, event_count: overrides.trailerCount ?? 3, ended_at: END } }]
        .map((row) => JSON.stringify(row)).join("\n") + "\n";
      const fixture = await buildArchiveFixture({
        subject: { kind: "issue", id: "iss_recovery" }, traces: { tsk_recovery: body },
        ...(overrides.extraProvider ? { members: [{ path: "sessions/raw/session.jsonl", body: Buffer.from("private provider data") }] } : {}),
      });
      const archivePath = join(root, `staged-${++staging}.zip`);
      await writeFile(archivePath, fixture.bytes, { mode: 0o600 });
      return {
        workspaceId: "local", subject: { kind: "issue", id: "iss_recovery" }, runtimeId: "rt_recovery", daemonId: "dmn_recovery",
        archivePath, sourceRevision: fixture.sourceRevision, sha256: fixture.sha256, sizeBytes: fixture.sizeBytes,
        fileCount: 1, algorithmVersion: "native-recovery-test-v1", tasks: [candidate],
      };
    } });
  } finally {
    await opened.close();
    await rm(root, { recursive: true, force: true });
  }
}

function preservedRows(world: World) {
  return ["multiremi_tasks", "multiremi_conversation_log", "multiremi_trace_backfill_progress", "multiremi_trace_backfill_tasks"]
    .map((table) => world.db.query(`SELECT * FROM ${table}`).all());
}

function archiveCount(world: World) {
  return Number(world.db.query("SELECT COUNT(*) AS n FROM multiremi_session_archives").get().n);
}

function bindCancelledNativeExecution(world: World): void {
  world.db.run(`UPDATE multiremi_tasks SET status = 'cancelled', started_at = NULL, result = NULL,
    completed_at = NULL, cancelled_at = ?, dispatched_at = ? WHERE id = ?`, END, START, "tsk_recovery");
  world.candidate.task = world.store.getNativeTraceRecoveryTaskSnapshot("tsk_recovery")!;
  world.candidate.evidence.nativeExecutionBinding = {
    kind: "cancelled_without_start_ack", taskId: "tsk_recovery", providerSessionId: "native_session_1",
    nativeStartedAt: START, nativeCompletedAt: "2026-10-04T00:02:00.000Z",
    promptSha256: createHash("sha256").update("synthetic").digest("hex"),
    directTaskIdRecords: [
      { kind: "remi_context", sourceLine: 110, taskId: "tsk_recovery", providerSessionId: "native_session_1" },
      { kind: "structured_tool_result", sourceLine: 200, taskId: "tsk_recovery", providerSessionId: "native_session_1" },
      { kind: "structured_tool_result", sourceLine: 300, taskId: "tsk_recovery", providerSessionId: "native_session_1" },
    ],
  };
}

for (const backend of backends) describe(`native trace recovery (${backend.name})`, () => {
  const test = backend.available ? it : it.skip;
  test("publishes readable pages with provenance while preserving all original task/card/backfill data; replay writes no rows", async () => {
    await withWorld(backend, async (world) => {
      const before = preservedRows(world);
      const result = await world.service.ingestNativeTraceRecovery(await world.stage());
      expect(result.pointerCount).toBe(1);
      expect(result.replayed).toBe(false);
      expect(result.archive.metadata.recovery_source).toBe("native_provider_jsonl");
      expect(preservedRows(world)).toEqual(before);
      const reader = new TraceReader({
        store: world.store, daemon: new InMemoryDaemonTraceReader(() => null),
        archive: new SessionArchiveReader({ store: world.store, root: world.root }),
      });
      const first = await reader.readTrace("tsk_recovery", 0, 2);
      const second = await reader.readTrace("tsk_recovery", first.next_after_seq, 2);
      expect(first).toMatchObject({ state: "ok", source: "archive", head: 3, closed: true, eof: false });
      expect(second).toMatchObject({ state: "ok", eof: true });
      expect([...first.events, ...second.events]).toEqual(EVENTS);
      const pointer = world.store.getTaskTrace("tsk_recovery");
      const archive = world.store.getSessionArchive(result.archive.id);
      const run = spyOn(world.db, "run");
      const replay = await world.service.ingestNativeTraceRecovery(await world.stage());
      expect(run).not.toHaveBeenCalled();
      run.mockRestore();
      expect(replay).toMatchObject({ replayed: true, pointerCount: 0, archive: { id: result.archive.id } });
      expect(world.store.getTaskTrace("tsk_recovery")).toEqual(pointer);
      expect(world.store.getSessionArchive(result.archive.id)).toEqual(archive);
      expect(preservedRows(world)).toEqual(before);
      expect(archiveCount(world)).toBe(1);
    });
  }, 120000);

  for (const [name, sql, value] of [
    ["stale pointer", "UPDATE multiremi_task_traces SET updated_at = ? WHERE task_id = 'tsk_recovery'", CHECKED],
    ["active task", "UPDATE multiremi_tasks SET status = ? WHERE id = 'tsk_recovery'", "running"],
    ["changed session", "UPDATE multiremi_tasks SET session_id = ? WHERE id = 'tsk_recovery'", "other-native-session"],
    ["changed provider", "UPDATE multiremi_tasks SET provider = ? WHERE id = 'tsk_recovery'", "claude"],
    ["changed runtime", "UPDATE multiremi_runtimes SET daemon_id = ? WHERE id = 'rt_recovery'", "other-daemon"],
    ["other workspace", "UPDATE multiremi_tasks SET workspace_id = ? WHERE id = 'tsk_recovery'", "other-workspace"],
    ["lost pointer", "UPDATE multiremi_task_traces SET location = ? WHERE task_id = 'tsk_recovery'", "lost"],
    ["existing archive", "UPDATE multiremi_task_traces SET location = ? WHERE task_id = 'tsk_recovery'", "archive"],
  ] as const) test(`rejects ${name} without publishing or changing unrelated data`, async () => {
    await withWorld(backend, async (world) => {
      const input = await world.stage();
      world.db.run(sql, value);
      const before = preservedRows(world);
      const pointer = world.store.getTaskTrace("tsk_recovery");
      await expect(world.service.ingestNativeTraceRecovery(input)).rejects.toThrow("native recovery");
      expect(archiveCount(world)).toBe(0);
      expect(world.store.getTaskTrace("tsk_recovery")).toEqual(pointer);
      expect(preservedRows(world)).toEqual(before);
    });
  }, 120000);

  test("rejects mismatched member ownership, unsealed counts and raw provider files before publishing", async () => {
    await withWorld(backend, async (world) => {
      for (const options of [{ session: "ises_other" }, { agent: "agt_other" }, { provider: "claude" }, { trailerCount: 4 }, { extraProvider: true }]) {
        await expect(world.service.ingestNativeTraceRecovery(await world.stage(options))).rejects.toThrow("native recovery");
      }
      expect(archiveCount(world)).toBe(0);
      expect(world.store.getTaskTrace("tsk_recovery")).toEqual(world.candidate.expectedPointer);
    });
  }, 120000);

  test("requires identity proof and refuses a replay with altered provenance", async () => {
    await withWorld(backend, async (world) => {
      const input = await world.stage();
      await expect(world.service.ingestNativeTraceRecovery({ ...input, tasks: [{ ...world.candidate,
        evidence: { ...world.candidate.evidence, taskIdentityEvidence: [] },
      }] })).rejects.toThrow("incomplete native source proof");
      const first = await world.service.ingestNativeTraceRecovery(input);
      const replay = await world.stage();
      await expect(world.service.ingestNativeTraceRecovery({ ...replay, tasks: [{ ...world.candidate,
        evidence: { ...world.candidate.evidence, sourceSha256: "b".repeat(64) },
      }] })).rejects.toThrow("provenance");
      expect(archiveCount(world)).toBe(1);
      expect(world.store.getTaskTrace("tsk_recovery")?.archiveId).toBe(first.archive.id);
    });
  }, 120000);

  test("rejects native evidence from another provider session before publishing", async () => {
    await withWorld(backend, async (world) => {
      const input = await world.stage();
      const before = preservedRows(world);
      const originalZip = await readFile(input.archivePath);
      for (const nativeSessionId of ["another-provider-session", ""]) {
        await expect(world.service.ingestNativeTraceRecovery({ ...input, tasks: [{ ...world.candidate,
          evidence: { ...world.candidate.evidence, nativeSessionId },
        }] })).rejects.toThrow("native recovery provider session differs from task");
      }
      for (const sessionId of [null, "", "  "]) {
        expect(() => nativeRecoveryMetadata(input.algorithmVersion, [{ ...world.candidate,
          task: { ...world.candidate.task, sessionId },
        }])).toThrow("native recovery provider session differs from task");
      }
      expect(archiveCount(world)).toBe(0);
      expect(world.store.getTaskTrace("tsk_recovery")).toEqual(world.candidate.expectedPointer);
      expect(preservedRows(world)).toEqual(before);
      expect(await readFile(input.archivePath)).toEqual(originalZip);
    });
  }, 120000);

  test("rolls archive and pointers back together when the transaction fails after writing the pointer", async () => {
    await withWorld(backend, async (world) => {
      const before = preservedRows(world);
      const original = world.store.writeTaskTraceArchivePointers.bind(world.store);
      const write = spyOn(world.store, "writeTaskTraceArchivePointers").mockImplementation((pointers, source) => {
        original(pointers, source);
        throw new Error("injected transaction failure");
      });
      try {
        await expect(world.service.ingestNativeTraceRecovery(await world.stage())).rejects.toThrow("injected transaction failure");
      } finally { write.mockRestore(); }
      expect(archiveCount(world)).toBe(0);
      expect(world.store.getTaskTrace("tsk_recovery")).toEqual(world.candidate.expectedPointer);
      expect(preservedRows(world)).toEqual(before);
      const retry = await world.service.ingestNativeTraceRecovery(await world.stage());
      expect(retry.pointerCount).toBe(1);
    });
  }, 120000);

  test("operator preflight never migrates or seeds; execute keeps immutable ZIP and same-manifest replay is idempotent", async () => {
    await withWorld(backend, async (world) => {
      const input = await world.stage();
      const manifest: NativeTraceImportManifest = { schema: 1, algorithmVersion: input.algorithmVersion,
        plans: [{ ...input, taskId: "tsk_recovery", expectedEventCount: EVENTS.length,
          expectedTraceDigest: createHash("sha256").update(EVENTS.map((event) => JSON.stringify(event)).join("\n") + "\n").digest("hex") }] };
      const before = preservedRows(world);
      const originalZip = await readFile(input.archivePath);
      const run = spyOn(world.db, "run");
      createNativeTraceOperatorStore(world.db);
      const dry = await runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest });
      expect(dry.mode).toBe("dry-run");
      expect(run).not.toHaveBeenCalled();
      run.mockRestore();
      expect(archiveCount(world)).toBe(0);
      const journalPath = join(world.root, "import-journal.jsonl");
      const first = await runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest, execute: true, journalPath, serviceIdentity: SERVICE_IDENTITY });
      expect(first.results[0]!.outcome).toBe("imported");
      expect(await readFile(input.archivePath)).toEqual(originalZip);
      const replayWrites = spyOn(world.db, "run");
      const replay = await runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest, execute: true, journalPath, serviceIdentity: SERVICE_IDENTITY });
      expect(replayWrites).not.toHaveBeenCalled();
      replayWrites.mockRestore();
      expect(replay.results[0]!.outcome).toBe("replayed");
      expect(replay.results[0]!.archiveId).toBe(first.results[0]!.archiveId);
      const verified = await runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: "/missing-staging-root", manifest, verify: true, journalPath, serviceIdentity: SERVICE_IDENTITY });
      expect(verified.results[0]!.outcome).toBe("verified");
      expect(archiveCount(world)).toBe(1);
      expect(preservedRows(world)).toEqual(before);
      world.db.run("UPDATE multiremi_tasks SET usage = ? WHERE id = ?", '[{"inputTokens":1}]', "tsk_recovery");
      await expect(runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest, verify: true, journalPath, serviceIdentity: SERVICE_IDENTITY }))
        .rejects.toThrow("differs from original journal");
    });
  }, 120000);

  test("operator refuses a bad event digest and unknown task selector before opening a write journal", async () => {
    await withWorld(backend, async (world) => {
      const input = await world.stage();
      const manifest: NativeTraceImportManifest = { schema: 1, algorithmVersion: input.algorithmVersion,
        plans: [{ ...input, taskId: "tsk_recovery", expectedEventCount: 3, expectedTraceDigest: "0".repeat(64) }] };
      const journalPath = join(world.root, "not-created.jsonl");
      await expect(runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest, execute: true, journalPath, serviceIdentity: SERVICE_IDENTITY }))
        .rejects.toThrow("event digest mismatch");
      await expect(readFile(journalPath)).rejects.toThrow();
      await expect(runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest, taskIds: ["tsk_unknown"] }))
        .rejects.toThrow("selected task IDs");
      expect(archiveCount(world)).toBe(0);
    });
  }, 120000);

  test("operator identity mismatch is rejected before database reads, staging changes or journal creation", async () => {
    await withWorld(backend, async (world) => {
      const input = await world.stage();
      const manifest: NativeTraceImportManifest = { schema: 1, algorithmVersion: input.algorithmVersion,
        plans: [{ ...input, taskId: "tsk_recovery", expectedEventCount: 3,
          expectedTraceDigest: createHash("sha256").update(EVENTS.map((event) => JSON.stringify(event)).join("\n") + "\n").digest("hex") }] };
      const zip = await readFile(input.archivePath);
      const journalPath = join(world.root, "identity-rejected.jsonl");
      const query = spyOn(world.db, "query");
      const run = spyOn(world.db, "run");
      try {
        for (const mode of [{ execute: true }, { verify: true }]) {
          await expect(runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest,
            ...mode, journalPath, serviceIdentity: SERVICE_IDENTITY,
            processIdentity: () => ({ uid: SERVICE_IDENTITY.uid + 1, gid: SERVICE_IDENTITY.gid }),
          })).rejects.toThrow("differs from API service");
        }
        expect(query).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
      } finally { query.mockRestore(); run.mockRestore(); }
      await expect(readFile(journalPath)).rejects.toThrow();
      expect(await readFile(input.archivePath)).toEqual(zip);
      expect(archiveCount(world)).toBe(0);
      for (const mode of ["--execute", "--verify"]) {
        const child = Bun.spawn([process.execPath, "scripts/import-native-task-traces.ts", mode,
          `--service-uid=${SERVICE_IDENTITY.uid + 1}`, `--service-gid=${SERVICE_IDENTITY.gid}`], {
          cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
          env: { ...process.env, REMI_RUNTIME_UID: String(SERVICE_IDENTITY.uid + 1), REMI_RUNTIME_GID: String(SERVICE_IDENTITY.gid), MULTIREMI_DATABASE_URL: "" },
        });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(code).toBe(1);
        expect(stderr).toContain("differs from API service");
        expect(stderr).not.toContain("MULTIREMI_DATABASE_URL");
      }
    });
  }, 120000);

  const permissionTest = backend.available && SERVICE_IDENTITY.uid !== 0 ? it : it.skip;
  permissionTest("a separate unprivileged API-identity process can read imported owner-only archive files", async () => {
    await withWorld(backend, async (world) => {
      const input = await world.stage();
      const expectedDigest = createHash("sha256").update(EVENTS.map((event) => JSON.stringify(event)).join("\n") + "\n").digest("hex");
      const manifest: NativeTraceImportManifest = { schema: 1, algorithmVersion: input.algorithmVersion,
        plans: [{ ...input, taskId: "tsk_recovery", expectedEventCount: 3, expectedTraceDigest: expectedDigest }] };
      const imported = await runNativeTraceImport({ db: world.db, archiveRoot: world.root, stagingRoot: world.root, manifest,
        execute: true, journalPath: join(world.root, "service-identity.jsonl"), serviceIdentity: SERVICE_IDENTITY });
      const archive = world.store.getSessionArchive(imported.results[0]!.archiveId!)!;
      const specification = join(world.root, "reader-fixture.json");
      await writeFile(specification, JSON.stringify({ archive, pointer: world.store.getTaskTrace("tsk_recovery"),
        root: world.root, expectedDigest, identity: SERVICE_IDENTITY }), { mode: 0o600 });
      const child = Bun.spawn([process.execPath, "-e", `
        import { readFile, stat } from "node:fs/promises";
        import { createHash } from "node:crypto";
        import { join } from "node:path";
        import { SessionArchiveReader } from "./packages/server/src/session-archive/reader.ts";
        const data = JSON.parse(await readFile(process.argv[1], "utf8"));
        if (process.geteuid() === 0 || process.geteuid() !== data.identity.uid || process.getegid() !== data.identity.gid) throw new Error("reader is not the unprivileged API identity");
        const info = await stat(join(data.root, data.archive.relativePath));
        if (info.uid !== data.identity.uid || info.gid !== data.identity.gid || (info.mode & 0o077)) throw new Error("archive has incorrect service ownership or mode");
        const reader = new SessionArchiveReader({ root: data.root, store: { getSessionArchive: () => data.archive } });
        const page = await reader.readTraceLines(data.pointer, 0, 500);
        const digest = createHash("sha256").update(page.events.map(event => JSON.stringify(event)).join("\\n") + "\\n").digest("hex");
        if (!page.closed || page.events.length !== 3 || digest !== data.expectedDigest) throw new Error("service reader trace mismatch");
        console.log(JSON.stringify({ uid: process.geteuid(), gid: process.getegid(), events: page.events.length }));
      `, specification], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ...SERVICE_IDENTITY, events: 3 });
    });
  }, 120000);

  test("restores a uniquely bound cancelled native execution while preserving its null start, result and original statistics", async () => {
    await withWorld(backend, async (world) => {
      bindCancelledNativeExecution(world);
      // A delayed/repeated dispatch write is not the start of the native turn.
      world.db.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", "2026-10-04T00:01:30.000Z", "tsk_recovery");
      const before = preservedRows(world);
      const input = await world.stage({ endStatus: "cancelled" });
      const committed = await world.service.ingestNativeTraceRecovery(input);
      expect(committed.pointerCount).toBe(1);
      expect(preservedRows(world)).toEqual(before);
      expect(world.store.getNativeTraceRecoveryTaskSnapshot("tsk_recovery")).toMatchObject({ status: "cancelled", startedAt: null });
      const reader = new TraceReader({ store: world.store, daemon: new InMemoryDaemonTraceReader(() => null),
        archive: new SessionArchiveReader({ store: world.store, root: world.root }) });
      const first = await reader.readTrace("tsk_recovery", 0, 2);
      const last = await reader.readTrace("tsk_recovery", first.next_after_seq, 2);
      expect([...first.events, ...last.events]).toEqual(EVENTS);
      expect(last).toMatchObject({ closed: true, eof: true, source: "archive" });
      const metadata = committed.archive.metadata.recovery as { tasks: NativeTraceRecoveryTask[] };
      expect(metadata.tasks[0]!.task.startedAt).toBeNull();
      expect(metadata.tasks[0]!.evidence.nativeExecutionBinding?.kind).toBe("cancelled_without_start_ack");
    });
  }, 120000);

  test("refuses cancelled missing-start data without complete direct binding, foreign IDs or a generic failed bypass", async () => {
    await withWorld(backend, async (world) => {
      bindCancelledNativeExecution(world);
      const input = await world.stage({ endStatus: "cancelled" });
      const original = structuredClone(world.candidate);
      const cases: NativeTraceRecoveryTask[] = [
        { ...original, evidence: { ...original.evidence, nativeExecutionBinding: undefined } },
        { ...original, evidence: { ...original.evidence, nativeExecutionBinding: { ...original.evidence.nativeExecutionBinding!,
          directTaskIdRecords: original.evidence.nativeExecutionBinding!.directTaskIdRecords.map((record) => ({ ...record, taskId: "tsk_foreign" })) } } },
        { ...original, evidence: { ...original.evidence, nativeExecutionBinding: { ...original.evidence.nativeExecutionBinding!, providerSessionId: "session_foreign" } } },
        { ...original, evidence: { ...original.evidence, nativeExecutionBinding: { ...original.evidence.nativeExecutionBinding!, directTaskIdRecords: [original.evidence.nativeExecutionBinding!.directTaskIdRecords[0]!] } } },
        { ...original, task: { ...original.task, status: "failed", cancelledAt: null, failedAt: END } },
      ];
      for (const candidate of cases) await expect(world.service.ingestNativeTraceRecovery({ ...input, tasks: [candidate] })).rejects.toThrow();
      expect(archiveCount(world)).toBe(0);
    });
  }, 120000);

  test("rejects reused provider sessions, a changed prompt/result and a native interval outside cancellation bounds", async () => {
    await withWorld(backend, async (world) => {
      bindCancelledNativeExecution(world);
      const input = await world.stage({ endStatus: "cancelled" });
      insertSyntheticTask(world.db, { id: "tsk_sibling", agentId: "agt_recovery", runtimeId: "rt_recovery", provider: "codex",
        status: "completed", createdAt: START, startedAt: START, endedAt: END });
      world.db.run("UPDATE multiremi_tasks SET session_id = ? WHERE id = ?", "native_session_1", "tsk_sibling");
      await expect(world.service.ingestNativeTraceRecovery(input)).rejects.toThrow("not exclusively owned");
      world.db.run("UPDATE multiremi_tasks SET session_id = ? WHERE id = ?", "another_session", "tsk_sibling");
      world.db.run("UPDATE multiremi_tasks SET prompt = ? WHERE id = ?", "changed prompt", "tsk_recovery");
      await expect(world.service.ingestNativeTraceRecovery(await world.stage({ endStatus: "cancelled" }))).rejects.toThrow("prompt binding changed");
      world.db.run("UPDATE multiremi_tasks SET prompt = ?, result = ? WHERE id = ?", "synthetic", "existing result", "tsk_recovery");
      await expect(world.service.ingestNativeTraceRecovery(await world.stage({ endStatus: "cancelled" }))).rejects.toThrow("prompt binding changed");
      world.db.run("UPDATE multiremi_tasks SET result = NULL WHERE id = ?", "tsk_recovery");
      world.candidate.evidence.nativeExecutionBinding!.nativeStartedAt = "2026-10-03T23:59:59.000Z";
      await expect(world.service.ingestNativeTraceRecovery(await world.stage({ endStatus: "cancelled", startedAt: "2026-10-03T23:59:59.000Z" }))).rejects.toThrow("outside the cancelled task window");
      world.candidate.evidence.nativeExecutionBinding!.nativeStartedAt = START;
      world.candidate.evidence.nativeExecutionBinding!.nativeCompletedAt = "2026-10-04T00:11:00.000Z";
      await expect(world.service.ingestNativeTraceRecovery(await world.stage({ endStatus: "cancelled" }))).rejects.toThrow("outside the cancelled task window");
      expect(archiveCount(world)).toBe(0);
      expect(world.store.getTaskTrace("tsk_recovery")).toEqual(world.candidate.expectedPointer);
    });
  }, 120000);
});
