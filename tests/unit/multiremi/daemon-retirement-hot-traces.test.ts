/**
 * MUL-432 segment 2 item 3: retirement waits for the daemon's hot traces
 * (ADR 0006 Decision 8).
 *
 * A task whose trace pointer still names one of the daemon's Runtimes blocks
 * retirement as `unarchived_hot_traces`. Opening the retirement plan asks the
 * daemon to archive every such subject over `runtime.archive_sessions`, and the
 * plan shows those requests as the progress. Once the archives are ready the
 * blocker clears and retire passes. Abandoning an offline daemon gives the
 * traces up as `lost`. On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { CreateTaskInput } from "@multiremi/contracts/types.js";
import type { SessionArchiveSubjectKind } from "@multiremi/contracts/trace-file.js";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS } from "@multiremi/store/repos/session-archive-requests-repo.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { buildArchiveFixture, traceFileBody } from "./session-archive-fixtures.js";
import { traceBackfillBackends, type OpenedStore } from "./trace-backfill-backends.js";

const TIMEOUT = 60_000;
const DAEMON = "dmn_retire_hot";
const MASTER = "fixture-master";
const backends = await traceBackfillBackends("retirehot");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

async function withStore(backend: (typeof backends)[number], body: (opened: OpenedStore) => Promise<void>) {
  const opened = await backend.open();
  try {
    opened.store.ensureLocalWorkspace();
    await body(opened);
  } finally {
    await opened.close();
  }
}

function seedRuntime(store: MultiremiStore, id: string, daemonId = DAEMON) {
  const runtime = store.registerRuntime({ id, name: `Runtime ${id}`, provider: "codex", daemonId, workspaceId: "local" });
  const agent = store.createAgent({ name: `Agent ${id}`, provider: "codex", workspaceId: "local", runtimeId: runtime.id });
  return { runtime, agent };
}

/** Claim, start and finish one task on the Runtime; with events its trace stays on the daemon. */
function runTask(
  store: MultiremiStore,
  runtimeId: string,
  input: Omit<CreateTaskInput, "prompt">,
  traceEventCount = 1,
): string {
  const task = store.createTask({ workspaceId: "local", prompt: "work", ...input });
  expect(store.claimTask(runtimeId)?.id).toBe(task.id);
  store.startTask(task.id);
  store.completeTask(task.id, { output: "done", traceEventCount });
  return task.id;
}

function hotTrace(taskId: string, runtimeId: string, subjectKind: SessionArchiveSubjectKind, subjectId: string) {
  return { taskId, runtimeId, subjectKind, subjectId };
}

const byTaskId = <T extends { taskId: string }>(rows: T[]) => [...rows].sort((a, b) => a.taskId.localeCompare(b.taskId));

/** Archive one subject through the real ingest path, as the daemon does on request. */
async function archiveSubject(store: MultiremiStore, root: string, input: {
  runtimeId: string;
  subject: { kind: "issue" | "task"; id: string };
  taskIds: string[];
}) {
  const fixture = await buildArchiveFixture({
    subject: input.subject,
    traces: Object.fromEntries(input.taskIds.map((taskId) => [taskId, traceFileBody({ events: 1, taskId })])),
  });
  const service = new SessionArchiveService(store, { root, minFreeBytes: 0 });
  const archive = service.initialize({
    workspaceId: "local",
    subjectKind: input.subject.kind,
    subjectId: input.subject.id,
    ...(input.subject.kind === "issue" ? { issueId: input.subject.id } : {}),
    runtimeId: input.runtimeId,
    daemonId: DAEMON,
    sourceRevision: fixture.sourceRevision,
    sha256: fixture.sha256,
    sizeBytes: fixture.sizeBytes,
  }).archive;
  const scope = input.subject.kind === "issue" ? input.subject.id : input.subject;
  const claim = await service.claimUploadAttempt(input.runtimeId, scope, archive.id);
  await service.upload(input.runtimeId, scope, archive.id, claim.uploadAttempt!, new Response(fixture.bytes).body);
  const ready = await service.complete(input.runtimeId, scope, archive.id, claim.uploadAttempt!);
  expect(ready.status).toBe("ready");
  return { ...ready, sourceRevision: fixture.sourceRevision, sha256: fixture.sha256 };
}

/**
 * The daemon on a real server: its session, the frames the server pushes, and
 * HTTP calls as the workspace admin.
 */
async function connectDaemon(store: MultiremiStore, runtimeId: string) {
  let layer: DaemonProtocolLayer | undefined;
  const server = startMultiremiServer({
    store, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port: 0, authToken: MASTER,
    onDaemonProtocol: (created) => { layer = created; },
  });
  const frames: Array<Record<string, any>> = [];
  const session = layer!.openSession({
    get bufferedAmount() { return 0; },
    send(text) { frames.push(JSON.parse(text)); return Buffer.byteLength(text); },
    close() {},
  }, { accessToken: null, masterToken: true });
  const runtime = store.getRuntimeLite(runtimeId)!;
  await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
    protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: runtime.daemonId,
    runtimes: [{ runtime_id: runtimeId, provider: runtime.provider, max_concurrency: 1, active_task_ids: [] }],
  } }));
  await layer!.drain();
  let seq = 0;
  return {
    layer: layer!,
    offers: () => frames.filter((frame) => frame.t === "runtime.archive_sessions"),
    async ack(ack: number) {
      await session.handleMessage(JSON.stringify({ v: 2, t: "ack", ack, p: {} }));
      await layer!.drain();
    },
    async event(type: string, payload: Record<string, unknown>) {
      const id = String(++seq);
      await session.handleMessage(JSON.stringify({ v: 2, t: type, seq, rt: runtimeId, p: payload }));
      await layer!.drain();
      return frames.find((frame) => frame.t === "res" && frame.re === id)?.p as Record<string, unknown>;
    },
    async http(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    async close() {
      session.handleSocketClose();
      await layer!.drain();
      server.stop(true);
    },
  };
}

const PLAN_PATH = `/api/multiremi/daemons/${DAEMON}/retirement-plan?workspace_id=local`;
const RETIRE_PATH = `/api/multiremi/daemons/${DAEMON}/retire`;

for (const backend of backends) {
  describe.skipIf(!backend.available)(`daemon retirement with hot traces (${backend.name})`, () => {
    it("blocks on hot traces, sends archive_sessions, and retires only after the archives are ready", async () => {
      await withStore(backend, async ({ store }) => {
        const { runtime, agent } = seedRuntime(store, "rt_retire_hot");
        const issue = store.createIssue({ title: "Hot trace issue", workspaceId: "local" });
        store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, rootPath: `/work/${issue.key}`,
          branchName: `agent/${issue.key}`, status: "ready" });
        const issueTask = runTask(store, runtime.id, { agentId: agent.id, issueId: issue.id });
        const oneOff = runTask(store, runtime.id, { agentId: agent.id });
        expect(store.getTaskTrace(issueTask)).toMatchObject({ location: "daemon", runtimeId: runtime.id });
        expect(store.getTaskTrace(oneOff)).toMatchObject({ location: "daemon", runtimeId: runtime.id });

        const before = store.getDaemonRetirementPlan("local", DAEMON);
        expect(before.canRetire).toBe(false);
        expect(before.blockingReasons).toEqual(["active_issue_workspaces", "unarchived_hot_traces"]);
        expect(byTaskId(before.unarchivedHotTraces)).toEqual(byTaskId([
          hotTrace(issueTask, runtime.id, "issue", issue.id),
          hotTrace(oneOff, runtime.id, "task", oneOff),
        ]));
        expect(before.archiveRequests).toEqual([]);

        const root = await mkdtemp(join(tmpdir(), "multiremi-retire-hot-"));
        const daemon = await connectDaemon(store, runtime.id);
        try {
          // Only opening the retirement plan asks for archives: the daemon
          // page and a retire attempt write no request.
          expect((await daemon.http("GET", `/api/daemons/${DAEMON}?workspace_id=local`)).status).toBe(200);
          const early = await daemon.http("POST", RETIRE_PATH,
            { workspace_id: "local", expected_snapshot: before.snapshot });
          expect(early.status).toBe(409);
          expect(early.body.code).toBe("daemon_retirement_blocked");
          expect(store.listLatestSessionArchiveRequests([runtime.id])).toEqual([]);
          expect(store.getRuntime(runtime.id)).not.toBeNull();

          const opened = await daemon.http("GET", PLAN_PATH);
          expect(opened.status).toBe(200);
          expect(opened.body.plan).toMatchObject({
            can_retire: false,
            blocking_reasons: ["active_issue_workspaces", "unarchived_hot_traces"],
          });
          expect(opened.body.plan.unarchived_hot_traces.map((trace: Record<string, string>) => trace.task_id).sort())
            .toEqual([issueTask, oneOff].sort());
          const requested = opened.body.plan.archive_requests as Array<Record<string, string>>;
          expect(requested.map((row) => [row.subject_kind, row.subject_id, row.runtime_id]).sort())
            .toEqual([["issue", issue.id, runtime.id], ["task", oneOff, runtime.id]]);

          await daemon.layer.drain();
          const offers = daemon.offers();
          expect(offers.map((frame) => [frame.rt, frame.p.request_id, frame.p.subjects]).sort())
            .toEqual(requested.map((row) => [runtime.id, row.id, [{ kind: row.subject_kind, id: row.subject_id }]]).sort());
          expect(store.listLatestSessionArchiveRequests([runtime.id]).map((row) => row.status)).toEqual(["sent", "sent"]);

          // Opening the plan again while the requests are open writes nothing new.
          const again = await daemon.http("GET", PLAN_PATH);
          expect((again.body.plan.archive_requests as Array<Record<string, string>>).map((row) => row.id).sort())
            .toEqual(requested.map((row) => row.id).sort());
          await daemon.layer.drain();
          expect(daemon.offers()).toHaveLength(2);

          await daemon.ack(Math.max(...offers.map((frame) => frame.seq)));
          expect(store.listLatestSessionArchiveRequests([runtime.id]).map((row) => row.status)).toEqual(["acked", "acked"]);
          // Still blocked while the daemon is archiving.
          expect(store.getDaemonRetirementPlan("local", DAEMON).blockingReasons).toContain("unarchived_hot_traces");

          const issueArchive = await archiveSubject(store, root,
            { runtimeId: runtime.id, subject: { kind: "issue", id: issue.id }, taskIds: [issueTask] });
          const taskArchive = await archiveSubject(store, root,
            { runtimeId: runtime.id, subject: { kind: "task", id: oneOff }, taskIds: [oneOff] });
          expect(store.getTaskTrace(issueTask)).toMatchObject({ location: "archive", archiveId: issueArchive.id });
          expect(store.getTaskTrace(oneOff)).toMatchObject({ location: "archive", archiveId: taskArchive.id });
          for (const [row, archive] of [[requested.find((r) => r.subject_kind === "issue")!, issueArchive],
            [requested.find((r) => r.subject_kind === "task")!, taskArchive]] as const) {
            expect(await daemon.event("runtime.archive_sessions_result",
              { request_id: row.id, status: "completed", archive_ids: [archive.id] })).toEqual({ ok: true });
          }
          expect(store.listLatestSessionArchiveRequests([runtime.id]).map((row) => row.status))
            .toEqual(["completed", "completed"]);

          const archived = store.getDaemonRetirementPlan("local", DAEMON);
          expect(archived.unarchivedHotTraces).toEqual([]);
          expect(archived.blockingReasons).toEqual(["active_issue_workspaces"]);
          // The issue workspace goes the usual way: GC cleans it once its archive is ready.
          store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id, archiveId: issueArchive.id,
            sourceRevision: issueArchive.sourceRevision, sha256: issueArchive.sha256 });

          const ready = await daemon.http("GET", PLAN_PATH);
          expect(ready.body.plan).toMatchObject({ can_retire: true, blocking_reasons: [], unarchived_hot_traces: [] });
          const retired = await daemon.http("POST", RETIRE_PATH,
            { workspace_id: "local", expected_snapshot: ready.body.plan.snapshot });
          expect(retired.status).toBe(200);
          expect(retired.body.status).toBe("retired");

          // Archive first, retire second: both archives were ready before the
          // daemon went, and the traces still read from them.
          for (const archive of [issueArchive, taskArchive]) {
            expect(archive.completedAt).not.toBeNull();
            expect(Date.parse(archive.completedAt!)).toBeLessThanOrEqual(Date.parse(retired.body.retired_at));
          }
          expect(store.getRuntime(runtime.id)).toBeNull();
          expect(store.getTaskTrace(issueTask)).toMatchObject({ location: "archive", archiveId: issueArchive.id });
          expect(store.getTaskTrace(oneOff)).toMatchObject({ location: "archive", archiveId: taskArchive.id });
        } finally {
          await daemon.close();
          await rm(root, { recursive: true, force: true });
        }
      });
    }, TIMEOUT);

    it("abandons an offline daemon's hot traces as lost", async () => {
      await withStore(backend, async ({ store }) => {
        const { runtime, agent } = seedRuntime(store, "rt_retire_hot");
        const issue = store.createIssue({ title: "Abandoned issue", workspaceId: "local" });
        store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, rootPath: `/work/${issue.key}`,
          branchName: `agent/${issue.key}`, status: "ready" });
        const issueTask = runTask(store, runtime.id, { agentId: agent.id, issueId: issue.id });
        const oneOff = runTask(store, runtime.id, { agentId: agent.id });
        const app = createMultiremiApp({ store });
        const headers = { "Content-Type": "application/json" };
        const plan = async () => (await (await app.request(PLAN_PATH, { headers })).json() as Record<string, any>).plan;
        const retire = (snapshot: string, abandon: boolean) => app.request(RETIRE_PATH, {
          method: "POST", headers,
          body: JSON.stringify({ workspace_id: "local", expected_snapshot: snapshot, abandon_issue_workspaces: abandon }),
        });

        // An online daemon can still archive, so its traces cannot be abandoned.
        const online = await plan();
        expect(online.can_abandon_issue_workspaces).toBe(false);
        expect((await retire(online.snapshot, true)).status).toBe(409);

        store.setRuntimeOffline(runtime.id);
        const offline = await plan();
        expect(offline).toMatchObject({
          can_retire: false,
          can_abandon_issue_workspaces: true,
          blocking_reasons: ["active_issue_workspaces", "unarchived_hot_traces"],
        });
        expect(offline.archive_requests.map((row: Record<string, string>) => row.status)).toEqual(["pending", "pending"]);
        const blocked = await retire(offline.snapshot, false);
        expect(blocked.status).toBe(409);
        expect((await blocked.json() as Record<string, string>).code).toBe("daemon_retirement_blocked");
        expect(store.getTaskTrace(issueTask)?.location).toBe("daemon");

        const abandoned = await retire(offline.snapshot, true);
        expect(abandoned.status).toBe(200);
        for (const taskId of [issueTask, oneOff]) {
          expect(store.getTaskTrace(taskId)).toMatchObject({ location: "lost", runtimeId: null });
        }
        expect(store.getRuntime(runtime.id)).toBeNull();
        expect(store.listLatestSessionArchiveRequests([runtime.id])).toEqual([]);
      });
    }, TIMEOUT);

    it("abandons hot traces alone when an offline daemon holds no Issue workspace", async () => {
      await withStore(backend, async ({ store }) => {
        const root = await mkdtemp(join(tmpdir(), "multiremi-retire-hot-"));
        try {
          const { runtime, agent } = seedRuntime(store, "rt_retire_hot");
          const oneOff = runTask(store, runtime.id, { agentId: agent.id });
          const archivedLater = runTask(store, runtime.id, { agentId: agent.id });
          store.setRuntimeOffline(runtime.id);
          const plan = store.getDaemonRetirementPlan("local", DAEMON);
          expect(plan.blockingReasons).toEqual(["unarchived_hot_traces"]);
          expect(plan.canAbandonIssueWorkspaces).toBe(true);
          expect(store.retireDaemon("local", DAEMON, plan.snapshot, "usr_admin", null).status).toBe("blocked");

          // An archive that lands after the plan was read changes which traces
          // the abandon gives up, so the confirmed plan is stale.
          const archive = await archiveSubject(store, root,
            { runtimeId: runtime.id, subject: { kind: "task", id: archivedLater }, taskIds: [archivedLater] });
          expect(store.retireDaemon("local", DAEMON, plan.snapshot, "usr_admin", null,
            { abandonIssueWorkspaces: true }).status).toBe("plan_changed");
          const fresh = store.getDaemonRetirementPlan("local", DAEMON);
          expect(fresh.unarchivedHotTraces.map((trace) => trace.taskId)).toEqual([oneOff]);

          const result = store.retireDaemon("local", DAEMON, fresh.snapshot, "usr_admin", null,
            { abandonIssueWorkspaces: true });
          expect(result.status).toBe("retired");
          expect(store.getTaskTrace(oneOff)).toMatchObject({ location: "lost", runtimeId: null });
          expect(store.getTaskTrace(archivedLater)).toMatchObject({ location: "archive", archiveId: archive.id });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }, TIMEOUT);

    it("lists only the finished tasks whose trace is still on one of the daemon's Runtimes", async () => {
      await withStore(backend, async ({ store }) => {
        const { runtime, agent } = seedRuntime(store, "rt_retire_hot");
        const other = seedRuntime(store, "rt_retire_other", "dmn_retire_other");
        const issue = store.createIssue({ title: "Listed issue", workspaceId: "local" });
        const chat = store.createChatSession({ agentId: agent.id, title: "Listed chat", workspaceId: "local" });
        const issueTask = runTask(store, runtime.id, { agentId: agent.id, issueId: issue.id });
        const chatTask = runTask(store, runtime.id, { agentId: agent.id, chatSessionId: chat.id });
        const oneOff = runTask(store, runtime.id, { agentId: agent.id });
        const empty = runTask(store, runtime.id, { agentId: agent.id }, 0);
        const elsewhere = runTask(store, other.runtime.id, { agentId: other.agent.id });
        const inFlight = store.createTask({ workspaceId: "local", prompt: "still going", agentId: agent.id });
        expect(store.claimTask(runtime.id)?.id).toBe(inFlight.id);
        expect(store.getTaskTrace(empty)?.location).toBe("none");
        expect(store.getTaskTrace(inFlight.id)?.location).toBe("daemon");
        expect(store.getTaskTrace(elsewhere)?.location).toBe("daemon");

        const plan = store.getDaemonRetirementPlan("local", DAEMON);
        expect(plan.blockingReasons).toEqual(["active_tasks", "unarchived_hot_traces"]);
        expect(plan.activeTasks.map((task) => task.id)).toEqual([inFlight.id]);
        expect(byTaskId(plan.unarchivedHotTraces)).toEqual(byTaskId([
          hotTrace(issueTask, runtime.id, "issue", issue.id),
          hotTrace(chatTask, runtime.id, "chat", chat.id),
          hotTrace(oneOff, runtime.id, "task", oneOff),
        ]));
        expect(store.getDaemonRetirementPlan("local", "dmn_retire_other").unarchivedHotTraces)
          .toEqual([hotTrace(elsewhere, other.runtime.id, "task", elsewhere)]);
      });
    }, TIMEOUT);

    it("requests each subject once while open, again after a failure or a lapsed lease, and wakes only Runtimes with new rows", async () => {
      await withStore(backend, async ({ store, db: database }) => {
        const first = seedRuntime(store, "rt_retire_hot_a");
        const second = seedRuntime(store, "rt_retire_hot_b");
        seedRuntime(store, "rt_retire_hot_idle");
        const other = seedRuntime(store, "rt_retire_other", "dmn_retire_other");
        const firstTask = runTask(store, first.runtime.id, { agentId: first.agent.id });
        const secondTask = runTask(store, second.runtime.id, { agentId: second.agent.id });
        runTask(store, other.runtime.id, { agentId: other.agent.id });
        const woken: string[] = [];
        const off = store.onWorkspaceEvent((event) => {
          if (event.type === "daemon:pending_changed") woken.push(String(event.payload.runtime_id));
        });
        try {
          store.requestDaemonRetirementArchives("local", DAEMON, "usr_admin");
          expect(woken.sort()).toEqual([first.runtime.id, second.runtime.id]);
          const opened = store.listLatestSessionArchiveRequests([first.runtime.id, second.runtime.id]);
          expect(opened.map((row) => [row.runtime_id, row.subject_kind, row.subject_id, row.status, row.created_by]))
            .toEqual([
              [first.runtime.id, "task", firstTask, "pending", "usr_admin"],
              [second.runtime.id, "task", secondTask, "pending", "usr_admin"],
            ]);
          expect(store.listLatestSessionArchiveRequests([other.runtime.id])).toEqual([]);
          expect(store.getDaemonRetirementPlan("local", DAEMON).archiveRequests).toEqual(opened);

          woken.length = 0;
          store.requestDaemonRetirementArchives("local", DAEMON, "usr_admin");
          expect(woken).toEqual([]);
          expect(store.listLatestSessionArchiveRequests([first.runtime.id, second.runtime.id])).toEqual(opened);

          const failed = opened[0]!;
          store.dispatchSessionArchiveRequests(first.runtime.id);
          store.acknowledgeSessionArchiveRequest(first.runtime.id, failed.id);
          expect(store.reportSessionArchiveRequestResult(first.runtime.id, failed.id, "failed")).toBe("applied");
          store.requestDaemonRetirementArchives("local", DAEMON, "usr_admin");
          expect(woken).toEqual([first.runtime.id]);
          const retried = store.listLatestSessionArchiveRequests([first.runtime.id]);
          expect(retried).toHaveLength(1);
          expect(retried[0]!.id).not.toBe(failed.id);
          expect(retried[0]!.status).toBe("pending");
          expect(store.getSessionArchiveRequest(first.runtime.id, failed.id)?.status).toBe("failed");

          // A daemon that acknowledged and then went quiet past the lease is
          // asked again.
          const stalled = opened[1]!;
          store.dispatchSessionArchiveRequests(second.runtime.id);
          store.acknowledgeSessionArchiveRequest(second.runtime.id, stalled.id);
          database.run("UPDATE multiremi_session_archive_requests SET updated_at = ? WHERE id = ?",
            [new Date(Date.now() - SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS - 60_000).toISOString(), stalled.id]);
          woken.length = 0;
          store.requestDaemonRetirementArchives("local", DAEMON, "usr_admin");
          expect(woken).toEqual([second.runtime.id]);
          expect(store.getSessionArchiveRequest(second.runtime.id, stalled.id)?.status).toBe("failed");
          const reasked = store.listLatestSessionArchiveRequests([second.runtime.id]);
          expect(reasked.map((row) => [row.subject_id, row.status])).toEqual([[secondTask, "pending"]]);
          expect(reasked[0]!.id).not.toBe(stalled.id);
        } finally {
          off();
        }
      });
    }, TIMEOUT);
  });
}
