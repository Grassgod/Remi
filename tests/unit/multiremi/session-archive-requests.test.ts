/**
 * MUL-432 segment 2 item 2: `multiremi_session_archive_requests` and its two
 * frames (ADR 0006 Decision 8).
 *
 * The state machine moves forward only, pending → sent → acked → completed |
 * failed; a failed request is retried with a new row, and a daemon that goes
 * offline before acknowledging leaves its request at `sent` until the next
 * session is offered it again. The server half runs in the real server
 * (`startMultiremiServer`) through A's downlink snapshot and event hooks. The
 * daemon half runs against a fake protocol client. On SQLite and Postgres.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { DAEMON_MIN_CLI_VERSION, type DaemonArchiveSubject } from "@multiremi/contracts/daemon-protocol.js";
import { startMultiremiServer } from "@multiremi/api.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonParsedFrame } from "@multiremi/api/daemon-protocol/frames.js";
import { MultiremiStore } from "@multiremi/store.js";
import { SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS } from "@multiremi/store/repos/session-archive-requests-repo.js";
import { DaemonDownlinkDedupe } from "@multiremi/worker/daemon-protocol-client.js";
import {
  registerDaemonSessionArchiveRequests,
  type DaemonSessionArchiveRequestResult,
} from "@multiremi/worker/daemon-session-archive-requests.js";
import { traceBackfillBackends, type OpenedStore } from "./trace-backfill-backends.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";

const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("archivereq");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

interface World {
  opened: OpenedStore;
  store: MultiremiStore;
  runtimeId: string;
  otherRuntimeId: string;
}

async function withWorld(backend: (typeof backends)[number], body: (world: World) => Promise<void>) {
  const opened = await backend.open();
  try {
    const { store } = opened;
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ name: "Archive daemon", provider: "claude", workspaceId: "local" });
    const other = store.registerRuntime({ name: "Other daemon", provider: "claude", workspaceId: "local" });
    await body({ opened, store, runtimeId: runtime.id, otherRuntimeId: other.id });
  } finally {
    await opened.close();
  }
}

const ISSUE: DaemonArchiveSubject = { kind: "issue", id: "iss_archive_subject" };
const CHAT: DaemonArchiveSubject = { kind: "chat", id: "chs_archive_subject" };

function status(world: World, id: string, runtimeId = world.runtimeId) {
  return world.store.getSessionArchiveRequest(runtimeId, id)?.status ?? null;
}

/** Push `updated_at` back so the ack lease reads as expired at the real clock. */
function ageRequest(world: World, id: string, ms: number) {
  world.opened.db.run("UPDATE multiremi_session_archive_requests SET updated_at = ? WHERE id = ?",
    [new Date(Date.now() - ms).toISOString(), id]);
}

/**
 * One daemon session on a real server: the hello, the frames the server
 * pushes, standalone acks and uplink events.
 */
async function connectDaemon(store: MultiremiStore, runtimeId: string) {
  let layer: DaemonProtocolLayer | undefined;
  const server = startMultiremiServer({
    store, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port: 0, authToken: "fixture-master",
    onDaemonProtocol: (created) => { layer = created; },
  });
  const frames: Array<Record<string, any>> = [];
  let session = layer!.openSession({
    get bufferedAmount() { return 0; },
    send(text) { frames.push(JSON.parse(text)); return Buffer.byteLength(text); },
    close() {},
  }, { accessToken: null, masterToken: true });
  let seq = 0;
  const hello = async () => {
    const runtime = store.getRuntimeLite(runtimeId)!;
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
      protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: runtime.daemonId ?? "fixture-archive-requests",
      runtimes: [{ runtime_id: runtimeId, provider: runtime.provider, max_concurrency: 1, active_task_ids: [] }],
    } }));
    await layer!.drain();
  };
  await hello();
  return {
    frames,
    layer: layer!,
    /** The `runtime.archive_sessions` frames pushed so far. */
    offers: () => frames.filter((frame) => frame.t === "runtime.archive_sessions"),
    async ack(ack: number) {
      await session.handleMessage(JSON.stringify({ v: 2, t: "ack", ack, p: {} }));
      await layer!.drain();
    },
    async event(type: string, payload: Record<string, unknown>, rt: string | null = runtimeId) {
      const id = String(++seq);
      await session.handleMessage(JSON.stringify({ v: 2, t: type, seq, ...(rt ? { rt } : {}), p: payload }));
      await layer!.drain();
      const reply = frames.find((frame) => frame.t === "res" && frame.re === id);
      if (!reply) throw new Error(`No res for ${type}: ${JSON.stringify(frames)}`);
      return reply.p as Record<string, unknown>;
    },
    /** Drop the socket without acknowledging, then connect a new session. */
    async reconnect() {
      session.handleSocketClose();
      await layer!.drain();
      frames.length = 0;
      seq = 0;
      session = layer!.openSession({
        get bufferedAmount() { return 0; },
        send(text) { frames.push(JSON.parse(text)); return Buffer.byteLength(text); },
        close() {},
      }, { accessToken: null, masterToken: true });
      await hello();
    },
    async close() {
      session.handleSocketClose();
      await layer!.drain();
      server.stop(true);
    },
  };
}

unifiedModelBackendTests("session archive request migration", fixture => {
    it("upgrades an old store without the request table twice and preserves a pending request", async () => {
        const { db } = fixture();
        db.exec("DROP TABLE multiremi_session_archive_requests");
        const upgraded = new MultiremiStore(db);
        const columns = () => db.dialect !== "postgres"
          ? (db.query("PRAGMA table_info(multiremi_session_archive_requests)").all() as Array<{ name: string }>).map(row => row.name)
          : (db.query(`SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'multiremi_session_archive_requests'
              ORDER BY ordinal_position`).all() as Array<{ column_name: string }>).map(row => row.column_name);
        const expected = ["id", "runtime_id", "subject_kind", "subject_id", "status", "created_by", "created_at", "updated_at"];
        expect(columns()).toEqual(expected);
        const runtime = upgraded.registerRuntime({ name: "Archive daemon", provider: "claude", workspaceId: "local" });
        const [request] = upgraded.requestSessionArchives(runtime.id, [ISSUE], "usr_admin");
        expect(request?.status).toBe("pending");
        const reopened = new MultiremiStore(db);
        expect(columns()).toEqual(expected);
        expect(reopened.getSessionArchiveRequest(runtime.id, request!.id)).toEqual(request!);
    }, TIMEOUT);
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`session archive request state machine (${backend.name})`, () => {

    it("moves pending → sent → acked → completed, forward only", async () => {
      await withWorld(backend, async (world) => {
        const events: string[] = [];
        const off = world.store.onWorkspaceEvent((event) => {
          if (event.type === "daemon:pending_changed") events.push(String(event.payload.runtime_id));
        });
        let request;
        try {
          [request] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
          // A second ask while the first is open reuses it and wakes nobody.
          const [again] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_other");
          expect(again!.id).toBe(request!.id);
        } finally {
          off();
        }
        expect(request).toMatchObject({ runtime_id: world.runtimeId, subject_kind: "issue", subject_id: ISSUE.id,
          status: "pending", created_by: "usr_admin" });
        expect(events).toEqual([world.runtimeId]);

        expect(world.store.dispatchSessionArchiveRequests(world.otherRuntimeId)).toEqual([]);
        expect(world.store.dispatchSessionArchiveRequests(world.runtimeId).map((row) => [row.id, row.status]))
          .toEqual([[request!.id, "sent"]]);
        expect(status(world, request!.id)).toBe("sent");

        expect(world.store.acknowledgeSessionArchiveRequest(world.otherRuntimeId, request!.id)).toBe(false);
        expect(world.store.acknowledgeSessionArchiveRequest(world.runtimeId, request!.id)).toBe(true);
        expect(world.store.acknowledgeSessionArchiveRequest(world.runtimeId, request!.id)).toBe(false);
        expect(status(world, request!.id)).toBe("acked");
        // An acked request is no longer offered.
        expect(world.store.dispatchSessionArchiveRequests(world.runtimeId)).toEqual([]);

        expect(world.store.reportSessionArchiveRequestResult(world.runtimeId, request!.id, "completed")).toBe("applied");
        expect(status(world, request!.id)).toBe("completed");
        // A terminal request absorbs replays and never moves back.
        expect(world.store.reportSessionArchiveRequestResult(world.runtimeId, request!.id, "completed"))
          .toBe("already_terminal");
        expect(world.store.reportSessionArchiveRequestResult(world.runtimeId, request!.id, "failed"))
          .toBe("already_terminal");
        expect(world.store.failSessionArchiveRequest(world.runtimeId, request!.id)).toBe(false);
        expect(world.store.acknowledgeSessionArchiveRequest(world.runtimeId, request!.id)).toBe(false);
        expect(status(world, request!.id)).toBe("completed");
        expect(world.store.reportSessionArchiveRequestResult(world.otherRuntimeId, request!.id, "completed"))
          .toBe("not_found");
        expect(world.store.reportSessionArchiveRequestResult(world.runtimeId, "sar_missing", "completed"))
          .toBe("not_found");
      });
    }, TIMEOUT);

    it("retries a failed request with a new pending row", async () => {
      await withWorld(backend, async (world) => {
        const [first] = world.store.requestSessionArchives(world.runtimeId, [ISSUE, CHAT], "usr_admin");
        world.store.dispatchSessionArchiveRequests(world.runtimeId);
        world.store.acknowledgeSessionArchiveRequest(world.runtimeId, first!.id);
        expect(world.store.reportSessionArchiveRequestResult(world.runtimeId, first!.id, "failed")).toBe("applied");

        const [retry, chat] = world.store.requestSessionArchives(world.runtimeId, [ISSUE, CHAT], "usr_admin");
        expect(retry!.id).not.toBe(first!.id);
        expect(retry!.status).toBe("pending");
        // The chat request was still open (sent), so it is reused.
        expect(chat!.status).toBe("sent");
        expect(status(world, first!.id)).toBe("failed");
        expect(world.store.listLatestSessionArchiveRequests([world.runtimeId])
          .map((row) => [row.subject_kind, row.id, row.status]))
          .toEqual([["chat", chat!.id, "sent"], ["issue", retry!.id, "pending"]]);
        expect(world.store.dispatchSessionArchiveRequests(world.runtimeId).map((row) => row.id).sort())
          .toEqual([chat!.id, retry!.id].sort());
      });
    }, TIMEOUT);

    it("orders a retry after the latest subject request even when its timestamp is in the future", async () => {
      await withWorld(backend, async (world) => {
        const [first] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        world.store.failSessionArchiveRequest(world.runtimeId, first!.id);
        const future = new Date(Date.now() + 60_000).toISOString();
        world.opened.db.run("UPDATE multiremi_session_archive_requests SET created_at = ? WHERE id = ?", [future, first!.id]);
        const [retry] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        expect(Date.parse(retry!.created_at)).toBe(Date.parse(future) + 1);
        expect(world.store.listLatestSessionArchiveRequests([world.runtimeId]))
          .toEqual([retry!]);
        expect(retry!.status).toBe("pending");
        expect(status(world, first!.id)).toBe("failed");
      });
    }, TIMEOUT);

    it("keeps a request whose daemon went offline before acknowledging at sent, with no lease", async () => {
      await withWorld(backend, async (world) => {
        const [request] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        world.store.dispatchSessionArchiveRequests(world.runtimeId);
        ageRequest(world, request!.id, 7 * 24 * 60 * 60 * 1000);
        expect(world.store.expireSessionArchiveRequests([world.runtimeId])).toBe(0);
        // Asking again reuses it rather than failing it.
        expect(world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin")[0]!.id).toBe(request!.id);
        expect(status(world, request!.id)).toBe("sent");
        // The next session is offered it again.
        expect(world.store.dispatchSessionArchiveRequests(world.runtimeId).map((row) => [row.id, row.status]))
          .toEqual([[request!.id, "sent"]]);
      });
    }, TIMEOUT);

    it("fails an acked request whose daemon never reports once the lease runs out, then retries", async () => {
      await withWorld(backend, async (world) => {
        const [request] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        world.store.dispatchSessionArchiveRequests(world.runtimeId);
        world.store.acknowledgeSessionArchiveRequest(world.runtimeId, request!.id);
        const ackedAt = Date.parse(world.store.getSessionArchiveRequest(world.runtimeId, request!.id)!.updated_at);
        expect(world.store.expireSessionArchiveRequests([world.runtimeId], ackedAt + SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS))
          .toBe(0);
        expect(status(world, request!.id)).toBe("acked");
        expect(world.store.expireSessionArchiveRequests([world.otherRuntimeId], ackedAt + SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS + 1))
          .toBe(0);
        expect(world.store.expireSessionArchiveRequests([world.runtimeId], ackedAt + SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS + 1))
          .toBe(1);
        expect(status(world, request!.id)).toBe("failed");
        // A late result is absorbed.
        expect(world.store.reportSessionArchiveRequestResult(world.runtimeId, request!.id, "completed"))
          .toBe("already_terminal");

        // Asking again runs the lease itself before reusing an open request.
        const [second] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        world.store.dispatchSessionArchiveRequests(world.runtimeId);
        world.store.acknowledgeSessionArchiveRequest(world.runtimeId, second!.id);
        ageRequest(world, second!.id, SESSION_ARCHIVE_REQUEST_ACK_LEASE_MS + 60_000);
        const [third] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        expect(third!.id).not.toBe(second!.id);
        expect(status(world, second!.id)).toBe("failed");
        expect(third!.status).toBe("pending");
      });
    }, TIMEOUT);

    it("goes with its Runtime when the Runtime is deleted", async () => {
      await withWorld(backend, async (world) => {
        const [request] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        const [kept] = world.store.requestSessionArchives(world.otherRuntimeId, [ISSUE], "usr_admin");
        expect(world.store.deleteRuntime(world.runtimeId)).toBe(true);
        expect(world.opened.db.query("SELECT id FROM multiremi_session_archive_requests ORDER BY id").all())
          .toEqual([{ id: kept!.id }]);
        expect(() => world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin"))
          .toThrow(`Runtime not found: ${world.runtimeId}`);
        expect(request!.id).not.toBe(kept!.id);
      });
    }, TIMEOUT);
  });

  describe.skipIf(!backend.available)(`session archive request frames on the server (${backend.name})`, () => {
    it("offers a request as runtime.archive_sessions and the transport ack moves it to acked", async () => {
      await withWorld(backend, async (world) => {
        const [before] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        const daemon = await connectDaemon(world.store, world.runtimeId);
        try {
          expect(daemon.offers().map((frame) => ({ rt: frame.rt, p: frame.p })))
            .toEqual([{ rt: world.runtimeId, p: { request_id: before!.id, subjects: [ISSUE] } }]);
          expect(status(world, before!.id)).toBe("sent");

          // A request written while the daemon is connected is pushed at once.
          const [live] = world.store.requestSessionArchives(world.runtimeId, [CHAT], "usr_admin");
          await daemon.layer.drain();
          expect(daemon.offers().map((frame) => frame.p.request_id)).toEqual([before!.id, live!.id]);
          expect(status(world, live!.id)).toBe("sent");

          await daemon.ack(daemon.offers()[0]!.seq);
          expect(status(world, before!.id)).toBe("acked");
          expect(status(world, live!.id)).toBe("sent");
          await daemon.ack(daemon.offers()[1]!.seq);
          expect(status(world, live!.id)).toBe("acked");

          // An acked request is not offered to the next session.
          await daemon.reconnect();
          expect(daemon.offers()).toEqual([]);
        } finally {
          await daemon.close();
        }
      });
    }, TIMEOUT);

    it("leaves a request at sent while its daemon is offline and offers it to the next session", async () => {
      await withWorld(backend, async (world) => {
        const [request] = world.store.requestSessionArchives(world.runtimeId, [ISSUE], "usr_admin");
        const daemon = await connectDaemon(world.store, world.runtimeId);
        try {
          expect(daemon.offers().map((frame) => frame.p.request_id)).toEqual([request!.id]);
          await daemon.reconnect();
          expect(status(world, request!.id)).toBe("sent");
          expect(daemon.offers().map((frame) => frame.p.request_id)).toEqual([request!.id]);
          await daemon.ack(daemon.offers()[0]!.seq);
          expect(status(world, request!.id)).toBe("acked");
        } finally {
          await daemon.close();
        }
        expect(status(world, request!.id)).toBe("acked");
      });
    }, TIMEOUT);

    it("closes the request from runtime.archive_sessions_result and refuses what it cannot apply", async () => {
      await withWorld(backend, async (world) => {
        const [done, failed] = world.store.requestSessionArchives(world.runtimeId, [ISSUE, CHAT], "usr_admin");
        const [foreign] = world.store.requestSessionArchives(world.otherRuntimeId, [ISSUE], "usr_admin");
        const daemon = await connectDaemon(world.store, world.runtimeId);
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
          await daemon.ack(daemon.offers().at(-1)!.seq);
          const result = (payload: Record<string, unknown>, rt?: string | null) =>
            daemon.event("runtime.archive_sessions_result", payload, rt);

          expect(await result({ request_id: done!.id, status: "completed", archive_ids: ["sar_x", "arc_1"] }))
            .toEqual({ ok: true });
          expect(status(world, done!.id)).toBe("completed");
          // A replayed result is absorbed.
          expect(await result({ request_id: done!.id, status: "failed", archive_ids: [], error: "late" }))
            .toEqual({ ok: true });
          expect(status(world, done!.id)).toBe("completed");

          expect(await result({ request_id: failed!.id, status: "failed", archive_ids: [], error: "x".repeat(900) }))
            .toEqual({ ok: true });
          expect(status(world, failed!.id)).toBe("failed");
          const logged = warn.mock.calls.map(([line]) => String(line))
            .filter((line) => line.includes("session_archive_request_failed")).map((line) => JSON.parse(line));
          expect(logged).toEqual([{ event: "session_archive_request_failed", runtime_id: world.runtimeId,
            request_id: failed!.id, error: "x".repeat(500) }]);

          const invalid = { ok: false, code: "invalid_report", retryable: false };
          expect(await result({ request_id: failed!.id, status: "done", archive_ids: [] })).toEqual(invalid);
          expect(await result({ request_id: failed!.id, status: "completed" })).toEqual(invalid);
          expect(await result({ request_id: failed!.id, status: "completed", archive_ids: [1] })).toEqual(invalid);
          expect(await result({ status: "completed", archive_ids: [] })).toEqual(invalid);

          const notFound = { ok: false, code: "task_not_found", retryable: false };
          expect(await result({ request_id: "sar_missing", status: "completed", archive_ids: [] })).toEqual(notFound);
          // Another Runtime's request cannot be closed from this one.
          expect(await result({ request_id: foreign!.id, status: "completed", archive_ids: [] })).toEqual(notFound);
          expect(status(world, foreign!.id, world.otherRuntimeId)).toBe("pending");
          // Nor can this session report for a Runtime it did not say hello for.
          expect(await result({ request_id: foreign!.id, status: "completed", archive_ids: [] }, world.otherRuntimeId))
            .toEqual({ ok: false, code: "authority_revoked", retryable: false });
          expect(status(world, foreign!.id, world.otherRuntimeId)).toBe("pending");
        } finally {
          warn.mockRestore();
          await daemon.close();
        }
      });
    }, TIMEOUT);
  });
}

describe("daemon handler for runtime.archive_sessions", () => {
  function fakeClient() {
    const handlers = new Map<string, (frame: DaemonParsedFrame) => void | Promise<void>>();
    const sent: string[] = [];
    return {
      sent,
      dedupe: new DaemonDownlinkDedupe(),
      registerFrameHandler(type: string, handler: (frame: DaemonParsedFrame) => void | Promise<void>) {
        handlers.set(type, handler);
      },
      send(frame: { t: string }) { sent.push(frame.t); },
      deliver(rt: string | null, payload: Record<string, unknown>) {
        return handlers.get("runtime.archive_sessions")!({ type: "runtime.archive_sessions", v: 2, seq: 1, ack: null,
          id: null, re: null, rt, ts: null, payload, raw: {} });
      },
    };
  }

  it("acknowledges, archives every subject in order and reports completed", async () => {
    const client = fakeClient();
    const steps: string[] = [];
    const reports: Array<[string, string, DaemonSessionArchiveRequestResult]> = [];
    const drain = registerDaemonSessionArchiveRequests(client, () => "rt_a",
      async (subject) => {
        steps.push(`archive ${subject.kind}:${subject.id} after ${client.sent.join(",")}`);
        return `arc_${subject.id}`;
      },
      async (rt, id, result) => { steps.push("report"); reports.push([rt, id, result]); });
    await client.deliver("rt_a", { request_id: "sar_1", subjects: [ISSUE, CHAT] });
    await drain();
    expect(steps).toEqual([`archive issue:${ISSUE.id} after ack`, `archive chat:${CHAT.id} after ack`, "report"]);
    expect(reports).toEqual([["rt_a", "sar_1",
      { status: "completed", archive_ids: [`arc_${ISSUE.id}`, `arc_${CHAT.id}`] }]]);

    // The same request again (a reconnect's replay) is not archived twice.
    await client.deliver("rt_a", { request_id: "sar_1", subjects: [ISSUE, CHAT] });
    expect(reports).toHaveLength(1);
    // Nor is a request addressed to another Runtime.
    await client.deliver("rt_b", { request_id: "sar_2", subjects: [ISSUE] });
    expect(reports).toHaveLength(1);
  });

  it("reports failed with the archives that finished and the errors of the rest", async () => {
    const client = fakeClient();
    const reports: DaemonSessionArchiveRequestResult[] = [];
    registerDaemonSessionArchiveRequests(client, () => "rt_a",
      async (subject) => {
        if (subject.kind === "chat") return null;
        if (subject.kind === "task") throw new Error("disk full");
        return "arc_issue";
      },
      async (_rt, _id, result) => { reports.push(result); });
    await client.deliver("rt_a", { request_id: "sar_1",
      subjects: [ISSUE, CHAT, { kind: "task", id: "tsk_1" }, { kind: "folder", id: "x" }] });
    await client.deliver("rt_a", { request_id: "sar_2", subjects: [] });
    expect(reports).toEqual([
      { status: "failed", archive_ids: ["arc_issue"],
        error: `chat ${CHAT.id}: no ready archive; task tsk_1: disk full; invalid subject` },
      { status: "failed", archive_ids: [], error: "request has no subjects" },
    ]);
  });

  it("releases the request for a replay when its result could not be sent", async () => {
    const client = fakeClient();
    let attempts = 0;
    const archived: string[] = [];
    registerDaemonSessionArchiveRequests(client, () => "rt_a",
      async (subject) => { archived.push(subject.id); return "arc_issue"; },
      async () => { if (++attempts === 1) throw new Error("socket closed"); });
    await expect(client.deliver("rt_a", { request_id: "sar_1", subjects: [ISSUE] })).rejects.toThrow("socket closed");
    await client.deliver("rt_a", { request_id: "sar_1", subjects: [ISSUE] });
    expect(attempts).toBe(2);
    expect(archived).toEqual([ISSUE.id, ISSUE.id]);
  });
});
