import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDaemonTraceReader, type DaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import { TraceReader, TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { TRACE_FILE_FORMAT } from "@multiremi/contracts/trace-file.js";
import { SessionArchiveReader } from "@multiremi/session-archive/reader.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import type { MultiremiTaskTrace } from "@multiremi/contracts/session-archive.js";
import { buildArchiveFixture, traceFileBody } from "./session-archive-fixtures.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  resetMultiremiTestEnv();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pointer(location: MultiremiTaskTrace["location"]): MultiremiTaskTrace {
  return {
    taskId: "tsk_trace", location, runtimeId: "rt_trace", archiveId: null, memberPath: null,
    dataOffset: null, compressedSize: null, uncompressedSize: null, sha256: null,
    eventCount: null, headSeq: null, closed: null, updatedAt: "2026-09-28T00:00:00Z",
  };
}

async function archiveReaderFor(events: TraceEvent[]): Promise<TraceReader> {
  const root = mkdtempSync(join(tmpdir(), "mul429-trace-budget-"));
  dirs.push(root);
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "rt_trace", name: "Trace runtime", provider: "codex", daemonId: "dmn_trace", workspaceId: "local" });
  const issue = store.createIssue({ title: "Trace budget", workspaceId: "local" });
  store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
  const body = [
    { format: TRACE_FILE_FORMAT, task_id: "tsk_trace", session_id: "ises_fixture", agent_id: "agt_fixture", provider: "codex", started_at: "2026-09-28T00:00:00Z" },
    ...events,
    { end: { status: "completed", head: events.at(-1)!.seq, event_count: events.length, ended_at: "2026-09-28T01:00:00Z" } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const fixture = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id }, traces: { tsk_trace: body } });
  const service = new SessionArchiveService(store, { root, maxBytes: 8 * 1024 * 1024, minFreeBytes: 0 });
  const archive = service.initialize({
    workspaceId: "local", subjectKind: "issue", subjectId: issue.id, issueId: issue.id,
    runtimeId: runtime.id, daemonId: "dmn_trace", sourceRevision: fixture.sourceRevision,
    sha256: fixture.sha256, sizeBytes: fixture.sizeBytes,
  }).archive;
  const claim = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
  await service.upload(runtime.id, issue.id, archive.id, claim.uploadAttempt!, new Response(fixture.bytes as BodyInit).body);
  await service.complete(runtime.id, issue.id, archive.id, claim.uploadAttempt!);
  return new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => null), archive: new SessionArchiveReader({ store, root }) });
}

describe("TraceReader oversized first event", () => {
  for (const source of ["daemon", "archive"] as const) {
    it(`QA B5: a legal JSON-expanded event must not masquerade as an empty trace (${source})`, async () => {
      const trace = new InMemoryTraceStore(() => "2026-09-28T00:00:00Z");
      const original = trace.append("tsk_trace", [
        { type: "text", content: "first" },
        { type: "text", content: "\u0001".repeat(180_000) },
        { type: "text", content: "last" },
      ]).events;
      expect(original[1]!.content).toHaveLength(180_000);
      const originalBytes = Buffer.byteLength(JSON.stringify(original[1]));
      expect(originalBytes).toBeGreaterThan(TRACE_READ_MAX_BYTES);
      const store = createStore();
      const reader = source === "archive" ? await archiveReaderFor(original) : new TraceReader({
        store, daemon: new InMemoryDaemonTraceReader(() => trace),
        archive: new SessionArchiveReader({ store, root: "/nonexistent" }), getPointer: () => pointer("daemon"),
      });
      for (const after of [0, 1, 2]) {
        const page = await reader.readTrace("tsk_trace", after);
        expect(page).toMatchObject({ state: "ok", source, head: 3, next_after_seq: after + 1, eof: after === 2 });
        expect(page.events.map((event) => event.seq)).toEqual([after + 1]);
        expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
        if (after === 1) {
          expect(page.events[0]).toMatchObject({ truncated: true, original_bytes: originalBytes });
          expect(page.events[0]!.content!.length).toBeLessThan(180_000);
        } else expect(page.events[0]!.content).toBe(after === 0 ? "first" : "last");
      }
      expect(original[1]!.content).toHaveLength(180_000);
    });
  }

  it.each(["content", "output", "input"] as const)("shortens %s on Unicode code-point boundaries and preserves identifiers", async (field) => {
    const text = "中文😀\u0001".repeat(200);
    const event: TraceEvent = {
      seq: 7, ts: "2026-09-28T00:00:00Z", type: "tool_result", tool: "Bash",
      tool_call_id: "call_boundary", status: "completed",
      [field]: field === "input" ? { command: text } : text,
    };
    const reader = await archiveReaderFor([event]);
    const page = await reader.readTrace("tsk_trace", 0, 200, 512);
    expect(page).toMatchObject({ state: "ok", head: 7, next_after_seq: 7, eof: true });
    const result = page.events[0]!;
    expect(result).toMatchObject({ seq: 7, type: event.type, tool: event.tool, tool_call_id: event.tool_call_id, status: event.status, truncated: true, original_bytes: Buffer.byteLength(JSON.stringify(event)) });
    const shortened = field === "input" ? result.input!.command as string : result[field]!;
    expect(shortened.length).toBeGreaterThan(0);
    expect(text.startsWith(shortened)).toBe(true);
    expect(Buffer.from(shortened, "utf8").toString("utf8")).toBe(shortened);
    expect(shortened).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(512);
  });

  it("shortens content, output and nested input in order before using the minimal identity fallback", async () => {
    const event: TraceEvent = {
      seq: 1, ts: "2026-09-28T00:00:00Z", type: "tool_result", tool: "Bash", tool_call_id: "call_order", status: "completed",
      content: "中".repeat(300), output: "😀".repeat(300), input: { nested: { command: "\u0001".repeat(300) } },
    };
    const reader = await archiveReaderFor([event]);
    const page = await reader.readTrace("tsk_trace", 0, 200, 512);
    expect(page.events[0]).toMatchObject({ content: "", output: "", truncated: true });
    expect((page.events[0]!.input!.nested as { command: string }).command.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(512);

    const minimalReader = await archiveReaderFor([{ ...event, meta: { huge: "x".repeat(2000) } }]);
    const minimal = await minimalReader.readTrace("tsk_trace", 0, 200, 256);
    expect(minimal.events[0]).toEqual({
      seq: event.seq, ts: event.ts, type: event.type, tool: event.tool,
      tool_call_id: event.tool_call_id, status: event.status, truncated: true,
      original_bytes: Buffer.byteLength(JSON.stringify({ ...event, meta: { huge: "x".repeat(2000) } })),
    });
    expect(Buffer.byteLength(JSON.stringify(minimal.events))).toBeLessThanOrEqual(256);
  });
});

describe("TraceReader states and hot routing", () => {
  it("writes a daemon pointer on claim, none for an empty terminal trace, and lost for abandon", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_pointer", name: "Pointer runtime", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Pointer agent", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const emptyTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "empty" });
    expect(store.claimTask(runtime.id)?.id).toBe(emptyTask.id);
    expect(store.getTaskTrace(emptyTask.id)).toMatchObject({ location: "daemon", runtimeId: runtime.id });
    store.startTask(emptyTask.id);
    store.completeTask(emptyTask.id, { output: "done", traceEventCount: 0 });
    expect(store.getTaskTrace(emptyTask.id)).toMatchObject({ location: "none", runtimeId: null });

    const abandoned = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "abandon" });
    expect(store.claimTask(runtime.id)?.id).toBe(abandoned.id);
    store.markTaskTraceLost(abandoned.id);
    expect(store.getTaskTrace(abandoned.id)?.location).toBe("lost");
  });

  it("reads hot events through the A-0 in-memory daemon reader", async () => {
    const store = createStore();
    const trace = new InMemoryTraceStore(() => "2026-09-28T00:00:00Z");
    trace.append("tsk_trace", [{ type: "text", content: "first" }, { type: "text", content: "second" }]);
    const reader = new TraceReader({
      store,
      daemon: new InMemoryDaemonTraceReader(() => trace),
      archive: new SessionArchiveReader({ store, root: "/nonexistent" }),
      getPointer: () => pointer("daemon"),
    });
    expect(await reader.readTrace("tsk_trace", 0, 1)).toMatchObject({
      state: "ok", source: "daemon", head: 2, eof: false, next_after_seq: 1,
    });
    const tail = await reader.readTrace("tsk_trace", 1);
    expect(tail).toMatchObject({ state: "ok", eof: true, next_after_seq: 2 });
    expect(tail.events.map((event) => event.content)).toEqual(["second"]);
  });

  it("maps unreachable, timeout and busy to retryable unreachable", async () => {
    const store = createStore();
    const cases = ["daemon_unreachable", "daemon_timeout", "daemon_busy"] as const;
    for (const code of cases) {
      const daemon: DaemonTraceReader = { read: async () => ({ ok: false, code }) };
      const reader = new TraceReader({ store, daemon, archive: new SessionArchiveReader({ store, root: "/nonexistent" }), getPointer: () => pointer("daemon") });
      expect(await reader.readTrace("tsk_trace")).toMatchObject({ state: "unreachable", source: "daemon", reason: code, retryable: true });
    }
  });

  it("rereads the pointer after trace_not_hot and returns not_found when it stays hot", async () => {
    const store = createStore();
    const fake = new InMemoryDaemonTraceReader(() => new InMemoryTraceStore());
    let reads = 0;
    const reader = new TraceReader({
      store, daemon: fake, archive: new SessionArchiveReader({ store, root: "/nonexistent" }),
      getPointer: () => { reads++; return pointer("daemon"); },
    });
    expect(await reader.readTrace("tsk_trace")).toMatchObject({ state: "not_found", reason: "trace_not_hot" });
    expect(reads).toBe(2);
  });

  it("exposes backfilling, lost, no-events and missing-pointer states", async () => {
    const store = createStore();
    const daemon = new InMemoryDaemonTraceReader(() => null);
    for (const [location, state] of [["backfilling", "backfilling"], ["lost", "lost"], ["none", "not_found"]] as const) {
      const reader = new TraceReader({ store, daemon, archive: new SessionArchiveReader({ store, root: "/nonexistent" }), getPointer: () => pointer(location) });
      expect((await reader.readTrace("tsk_trace")).state).toBe(state);
    }
    const missing = new TraceReader({ store, daemon, archive: new SessionArchiveReader({ store, root: "/nonexistent" }), getPointer: () => null });
    expect((await missing.readTrace("tsk_trace")).state).toBe("not_found");
  });

  it("keeps the runtime name on a running task with no pointer", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_missing_pointer", name: "Desktop daemon", provider: "codex", workspaceId: "local" });
    const agent = store.createAgent({ name: "Pointer gap", provider: "codex", workspaceId: "local", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "running" });
    store.claimTask(runtime.id);
    const reader = new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => null),
      archive: new SessionArchiveReader({ store, root: "/nonexistent" }), getPointer: () => null });
    expect(await reader.readTrace(task.id)).toMatchObject({
      state: "unreachable", reason: "pointer_missing", runtime_id: runtime.id, runtime_name: "Desktop daemon",
    });
  });

  it("truncates by JSON bytes without advancing past an unseen event", async () => {
    const store = createStore();
    const trace = new InMemoryTraceStore(() => "2026-09-28T00:00:00Z");
    trace.append("tsk_trace", [{ type: "text", content: "a".repeat(100) }, { type: "text", content: "b".repeat(100) }]);
    const reader = new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => trace), archive: new SessionArchiveReader({ store, root: "/nonexistent" }), getPointer: () => pointer("daemon") });
    const page = await reader.readTrace("tsk_trace", 0, 200, 250);
    expect(page.events).toHaveLength(1);
    expect(page).toMatchObject({ next_after_seq: 1, eof: false });
    expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(252);
  });
});

describe("TraceReader archive path", () => {
  it("pages a B4 fixture by sparse seq and follows a trace_not_hot pointer swap", async () => {
    const root = mkdtempSync(join(tmpdir(), "mul429-trace-reader-"));
    dirs.push(root);
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_trace", name: "Trace runtime", provider: "codex", daemonId: "dmn_trace", workspaceId: "local" });
    const issue = store.createIssue({ title: "Sparse trace", workspaceId: "local" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
    const fixture = await buildArchiveFixture({
      subject: { kind: "issue", id: issue.id },
      traces: { tsk_trace: traceFileBody({ events: 4, gapAfter: 2, taskId: "tsk_trace" }) },
    });
    const service = new SessionArchiveService(store, { root, maxBytes: 8 * 1024 * 1024, minFreeBytes: 0 });
    const archive = service.initialize({
      workspaceId: "local", subjectKind: "issue", subjectId: issue.id, issueId: issue.id,
      runtimeId: runtime.id, daemonId: "dmn_trace", sourceRevision: fixture.sourceRevision,
      sha256: fixture.sha256, sizeBytes: fixture.sizeBytes,
    }).archive;
    const claim = await service.claimUploadAttempt(runtime.id, issue.id, archive.id);
    await service.upload(runtime.id, issue.id, archive.id, claim.uploadAttempt!, new Response(fixture.bytes as BodyInit).body);
    await service.complete(runtime.id, issue.id, archive.id, claim.uploadAttempt!);
    const cold = new SessionArchiveReader({ store, root });
    const reader = new TraceReader({ store, daemon: new InMemoryDaemonTraceReader(() => null), archive: cold });
    const first = await reader.readTrace("tsk_trace", 0, 2);
    expect(first.events.map((event) => event.seq)).toEqual([1, 3]);
    expect(first).toMatchObject({ state: "ok", source: "archive", next_after_seq: 3, head: 4, eof: false });
    const second = await reader.readTrace("tsk_trace", 3, 2);
    expect(second.events.map((event) => event.seq)).toEqual([4]);
    expect(second).toMatchObject({ next_after_seq: 4, eof: true });

    let reads = 0;
    const swapped = new TraceReader({
      store, daemon: new InMemoryDaemonTraceReader(() => new InMemoryTraceStore()), archive: cold,
      getPointer: () => (++reads === 1 ? pointer("daemon") : store.getTaskTrace("tsk_trace")),
    });
    expect(await swapped.readTrace("tsk_trace")).toMatchObject({ state: "ok", source: "archive" });
    expect(reads).toBe(2);
  });
});
