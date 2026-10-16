/**
 * PR 6 §5, §7: the session background-task registry (`multiremi_background_tasks`).
 *
 * - The migration ships the table and the attempt's `running_background_tasks`
 *   on a fresh schema, and adds both once to an upgraded one.
 * - `lane.background_tasks` snapshots: rows per task, the revision guard, the
 *   stop answer, a `closed` lane ending what still runs as `lost`, and the
 *   authority rules (the lane's own attempt on this runtime; another runtime's
 *   row untouched). Through the protocol: authorized like a report, ignored
 *   without the cap, no reply without an `id`.
 * - `hello` reconciliation: parked lanes and active attempts keep their rows,
 *   the rest stops as `daemon_restart`, a reused task id writes again.
 * - The offline sweep (`unknown`), retention (7 days, 50 ended per session).
 * - `chat:background_tasks` to the Chat's creator only, never to daemon
 *   delivery; the session read and the session list's count.
 *
 * On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { notifyBrowserWorkspaceEvent } from "@multiremi/api/realtime.js";
import { wakeDaemonWorkspaceEvent } from "@multiremi/api/daemon-protocol/workspace-wakeups.js";
import { negotiateWelcomeCaps, parseDaemonHello, parseParkedLanes } from "@multiremi/api/daemon-protocol/handshake.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";
import {
  PROVIDER_SESSION,
  backgroundWorld,
  daemonHarness,
  laneSnapshot,
  laneTask,
  runAttempt,
  snapshotFor,
} from "./background-tasks-fixture.js";

const MIGRATION = "20261018_background_tasks";
const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("bgtasks");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function hasTable(db: SqlDatabase): boolean {
  return db.dialect === "postgres"
    ? Boolean(db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'multiremi_background_tasks'").get())
    : Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multiremi_background_tasks'").get());
}

function hasAttemptColumn(db: SqlDatabase): boolean {
  if (db.dialect === "postgres") {
    return Boolean(db.query(`SELECT 1 FROM information_schema.columns
      WHERE table_name = 'multiremi_turn_attempts' AND column_name = 'running_background_tasks'`).get());
  }
  return (db.query("PRAGMA table_info(multiremi_turn_attempts)").all() as Array<{ name: string }>)
    .some((column) => column.name === "running_background_tasks");
}

function migrationRows(db: SqlDatabase): number {
  return Number((db.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_schema_migrations WHERE id = ?").get(MIGRATION) as { n: number }).n);
}

function rows(store: MultiremiStore, chatId: string) {
  return store.listSessionBackgroundTasks(chatId).rows;
}

function events(store: MultiremiStore) {
  const seen: Array<{ type: string; chatSessionId?: string; payload: Record<string, any> }> = [];
  const off = store.onWorkspaceEvent((event) => seen.push(event as typeof seen[number]));
  return { seen, off, of: (type: string) => seen.filter((event) => event.type === type) };
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`background-task registry (${backend.name})`, () => {
    it("ships the table and the attempt count in a fresh schema, and adds both once to an upgraded one", async () => {
      const opened = await backend.open();
      try {
        const { db } = opened;
        expect(hasTable(db)).toBe(true);
        expect(hasAttemptColumn(db)).toBe(true);
        expect(migrationRows(db)).toBe(1);
        // The database as a pre-PR 6 release left it.
        db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [MIGRATION]);
        db.exec("DROP TABLE multiremi_background_tasks");
        db.exec("ALTER TABLE multiremi_turn_attempts DROP COLUMN running_background_tasks");
        expect(hasTable(db)).toBe(false);
        new MultiremiStore(db);
        const reopened = new MultiremiStore(db);
        expect(hasTable(db)).toBe(true);
        expect(hasAttemptColumn(db)).toBe(true);
        expect(migrationRows(db)).toBe(1);
        const world = backgroundWorld(reopened);
        expect(snapshotFor(world, 1, [laneTask(world)])).toBe(1);
        expect(rows(reopened, world.chatId)).toHaveLength(1);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("keeps one row per task, guarded by revision, with the lane's fields and the stop answer", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        const listen = events(opened.store);
        expect(snapshotFor(world, 5, [laneTask(world), laneTask(world, { task_id: "wf-1", task_type: "workflow",
          name: "review", command: null, status: "paused", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 900 } })])).toBe(2);
        const [running, paused] = [...rows(opened.store, world.chatId)].sort((a, b) => a.task_id.localeCompare(b.task_id));
        expect(running).toMatchObject({ task_id: "bash-1", status: "running", lane_state: "parked", runtime_id: world.runtimeId,
          provider_session_id: PROVIDER_SESSION, origin_attempt_id: world.attemptId, origin_turn_id: world.turnId,
          origin_item_id: "bg:bash-1", parked_until: "2026-10-16T03:00:00.000Z", can_stop: true, output_tail: "ready on :3000\n",
          stop_requested_at: null, stop_outcome: null, ended_at: null });
        expect(paused).toMatchObject({ task_id: "wf-1", status: "paused", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 900 },
          output_unreadable: false });
        expect(opened.store.listSessionBackgroundTasks(world.chatId).running).toBe(2);
        // Same content, newer revision: no visible change, no event.
        const before = listen.of("chat:background_tasks").length;
        expect(snapshotFor(world, 6, [laneTask(world), laneTask(world, { task_id: "wf-1", task_type: "workflow",
          name: "review", command: null, status: "paused", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 900 } })])).toBe(0);
        // An older revision never overwrites.
        expect(snapshotFor(world, 4, [laneTask(world, { status: "completed", ended_at: "2026-10-16T01:05:00.000Z" })])).toBe(0);
        expect(rows(opened.store, world.chatId).find((row) => row.task_id === "bash-1")?.status).toBe("running");
        await Bun.sleep(0);
        expect(listen.of("chat:background_tasks").length).toBe(before);
        // The daemon could not read a task's output: the row says so, and the event carries it.
        expect(snapshotFor(world, 7, [laneTask(world, { output_tail: null, output_unreadable: true }), laneTask(world, { task_id: "wf-1",
          task_type: "workflow", name: "review", command: null, status: "paused", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 900 } })]))
          .toBe(1);
        expect(rows(opened.store, world.chatId).find((row) => row.task_id === "bash-1")).toMatchObject({ output_tail: null, output_unreadable: true });
        await Bun.sleep(0);
        expect(listen.of("chat:background_tasks").at(-1)!.payload.rows[0]).toMatchObject({ task_id: "bash-1", output_unreadable: true });
        // A newer one does; an end carries its time and duration.
        expect(snapshotFor(world, 8, [laneTask(world, { status: "completed", summary: "exit 0",
          ended_at: "2026-10-16T01:05:00.000Z", duration_ms: 300_000 })])).toBe(1);
        expect(rows(opened.store, world.chatId).find((row) => row.task_id === "bash-1")).toMatchObject({
          status: "completed", summary: "exit 0", ended_at: "2026-10-16T01:05:00.000Z", duration_ms: 300_000, parked_until: null });
        await Bun.sleep(0);
        const last = listen.of("chat:background_tasks").at(-1)!;
        expect(last.chatSessionId).toBe(world.chatId);
        expect(last.payload).toMatchObject({ session_id: world.chatId, chat_session_id: world.chatId, running: 1 });
        expect(last.payload.rows.map((row: any) => row.task_id)).toEqual(["bash-1"]);
        listen.off();
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("records the daemon's answer to a person's stop, and a stop Remi made", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        snapshotFor(world, 1, [laneTask(world), laneTask(world, { task_id: "bash-2" })]);
        const request = opened.store.requestBackgroundTaskStop(world.chatId, { taskId: "bash-1" }, "member-1");
        expect(request.rows).toHaveLength(1);
        expect(request.rows[0]).toMatchObject({ task_id: "bash-1", stop_requested_by: "member-1", stop_outcome: "pending" });
        // The bridge answered: the request stays the person's, the outcome is the daemon's.
        snapshotFor(world, 2, [
          laneTask(world, { status: "stopped", stop_reason: "user", ended_at: "2026-10-16T01:02:00.000Z",
            stop_request: { requested_at: request.requested_at, by: "user", outcome: "stopped" } }),
          laneTask(world, { task_id: "bash-2", status: "stopped", stop_reason: "keepalive_cap", ended_at: "2026-10-16T03:00:00.000Z",
            stop_request: { requested_at: "2026-10-16T03:00:00.000Z", by: "remi", outcome: "stopped" } }),
        ]);
        const byId = new Map(rows(opened.store, world.chatId).map((row) => [row.task_id, row]));
        expect(byId.get("bash-1")).toMatchObject({ status: "stopped", stop_reason: "user", stop_requested_at: request.requested_at,
          stop_requested_by: "member-1", stop_outcome: "stopped" });
        expect(byId.get("bash-2")).toMatchObject({ status: "stopped", stop_reason: "keepalive_cap",
          stop_requested_at: "2026-10-16T03:00:00.000Z", stop_requested_by: null, stop_outcome: "stopped" });

        // A request still pending when the task ends on its own (or the lane closes, or the
        // daemon restarts) is moot: it reads not_running, not 「正在停止…」.
        snapshotFor(world, 3, [laneTask(world, { task_id: "bash-3" }), laneTask(world, { task_id: "bash-4" }),
          laneTask(world, { task_id: "bash-5" })]);
        opened.store.requestBackgroundTaskStop(world.chatId, { all: true }, "member-1");
        snapshotFor(world, 4, [laneTask(world, { task_id: "bash-3", status: "completed", ended_at: "2026-10-16T01:03:00.000Z" }),
          laneTask(world, { task_id: "bash-4" }), laneTask(world, { task_id: "bash-5" })]);
        expect(rows(opened.store, world.chatId).find((row) => row.task_id === "bash-3")?.stop_outcome).toBe("not_running");
        expect(rows(opened.store, world.chatId).find((row) => row.task_id === "bash-4")?.stop_outcome).toBe("pending");
        snapshotFor(world, 5, [laneTask(world, { task_id: "bash-4" })], { state: "closed", parked_until: null });
        const settled = new Map(rows(opened.store, world.chatId).map((row) => [row.task_id, row]));
        expect(settled.get("bash-4")).toMatchObject({ status: "stopped", stop_reason: "lost", stop_outcome: "not_running" });
        expect(settled.get("bash-5")).toMatchObject({ status: "stopped", stop_reason: "lost", stop_outcome: "not_running" });
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("ends a closed lane's running rows as lost, listed or not", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        snapshotFor(world, 1, [laneTask(world), laneTask(world, { task_id: "bash-2" }),
          laneTask(world, { task_id: "bash-3", status: "completed", ended_at: "2026-10-16T01:01:00.000Z" })]);
        expect(snapshotFor(world, 2, [laneTask(world)], { state: "closed", parked_until: null })).toBe(2);
        const byId = new Map(rows(opened.store, world.chatId).map((row) => [row.task_id, row]));
        for (const id of ["bash-1", "bash-2"]) {
          expect(byId.get(id)).toMatchObject({ status: "stopped", stop_reason: "lost", lane_state: "closed", parked_until: null });
          expect(byId.get(id)!.ended_at).not.toBeNull();
        }
        // An ended row keeps its end.
        expect(byId.get("bash-3")).toMatchObject({ status: "completed", ended_at: "2026-10-16T01:01:00.000Z" });
        expect(opened.store.listSessionBackgroundTasks(world.chatId).running).toBe(0);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("takes tasks only from the lane's own attempts on this runtime, and never touches another runtime's row", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        const other = backgroundWorld(opened.store);
        // Another lane's attempt as the origin: refused, nothing written.
        expect(() => snapshotFor(world, 1, [laneTask(world, { origin_attempt_id: other.attemptId })]))
          .toThrow("origin attempt is not this lane's on this runtime");
        expect(rows(opened.store, world.chatId)).toEqual([]);
        // The lane's attempt, reported by another runtime: refused too.
        expect(() => opened.store.upsertLaneBackgroundSnapshot(other.runtimeId, "local",
          { ...laneSnapshot(world, 1, [laneTask(world)]), runtime_id: other.runtimeId })).toThrow();
        snapshotFor(world, 1, [laneTask(world)]);
        // A row is its runtime's: a later report for its key from elsewhere is skipped.
        expect(opened.store.upsertLaneBackgroundSnapshot(other.runtimeId, "local", { ...laneSnapshot(world, 2,
          [laneTask(world, { status: "completed", ended_at: "2026-10-16T01:09:00.000Z" })], { state: "closed" }),
        runtime_id: other.runtimeId })).toBe(0);
        expect(rows(opened.store, world.chatId)[0]).toMatchObject({ runtime_id: world.runtimeId, status: "running" });
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("stores snapshots through the protocol only with the cap, authorized, with no reply without an id", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        const capable = await daemonHarness(opened.store, world);
        try {
          expect(capable.welcome.caps).toEqual(["lane.background"]);
          expect(await capable.send("lane.background_tasks", laneSnapshot(world, 1, [laneTask(world)]) as never)).toEqual([]);
          expect(rows(opened.store, world.chatId)).toHaveLength(1);
          expect(capable.kicks).toEqual([world.runtimeId]);
          // Malformed: nothing written, the probe sees the refusal.
          expect(await capable.call("lane.background_tasks", { ...laneSnapshot(world, 2, [laneTask(world, { status: "lost" as never })]) }))
            .toMatchObject({ ok: false, code: "invalid_report" });
          expect(await capable.call("lane.background_tasks", { ...laneSnapshot(world, 2, [laneTask(world)]), runtime_id: "rt_other" }))
            .toMatchObject({ ok: false, code: "authority_revoked" });
          expect(await capable.call("lane.background_tasks", laneSnapshot(world, 3,
            Array.from({ length: 33 }, (_, index) => laneTask(world, { task_id: `t-${index}` }))) as never))
            .toMatchObject({ ok: false, code: "invalid_report" });
          expect(await capable.call("lane.background_tasks", laneSnapshot(world, 3,
            [laneTask(world, { output_unreadable: "yes" as never })]) as never)).toMatchObject({ ok: false, code: "invalid_report" });
          expect(await capable.call("lane.background_tasks", laneSnapshot(world, 4,
            [laneTask(world, { status: "completed", ended_at: "2026-10-16T01:03:00.000Z" })]) as never)).toEqual({ ok: true });
          expect(rows(opened.store, world.chatId)[0]!.status).toBe("completed");
        } finally { capable.close(); }

        // A daemon (or a server) without the cap: the frame is ignored.
        for (const options of [{ caps: ["offer" as const] }, { welcomeCaps: [] }]) {
          const old = await daemonHarness(opened.store, world, options);
          try {
            expect(old.welcome.caps).toEqual([]);
            expect(await old.call("lane.background_tasks", laneSnapshot(world, 9, [laneTask(world, { task_id: "ignored" })]) as never))
              .toBeUndefined();
            expect(rows(opened.store, world.chatId).some((row) => row.task_id === "ignored")).toBe(false);
          } finally { old.close(); }
        }
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("reconciles at hello: parked lanes and active attempts keep their rows, the rest stopped as daemon_restart", async () => {
      const opened = await backend.open();
      try {
        const parked = backgroundWorld(opened.store);
        snapshotFor(parked, 10, [laneTask(parked), laneTask(parked, { task_id: "bash-gone" })]);
        // A second lane on the same runtime, whose attempt is still running.
        const chat = opened.store.createChatSession({ agentId: parked.agentId, workspaceId: "local", creatorId: "local" });
        const active = runAttempt(opened.store, parked.runtimeId, chat.id, "run tests in the background");
        opened.store.pinTaskSession(active.id, "sess-active", "/tmp/claude-pr6d-active");
        opened.store.upsertLaneBackgroundSnapshot(parked.runtimeId, "local", { runtime_id: parked.runtimeId, session_id: chat.id,
          agent_id: parked.agentId, execution_scope: "", provider_session_id: "sess-active", revision: 11, state: "in_attempt",
          attempt_id: active.id, tasks: [laneTask(parked, { task_id: "bash-a", origin_attempt_id: active.id })] });
        // The offline sweep made one of them unknown.
        opened.db.run("UPDATE multiremi_background_tasks SET status = 'unknown' WHERE task_id = 'bash-1'");

        const harness = await daemonHarness(opened.store, parked, {
          parkedLanes: [{ session_id: parked.chatId, agent_id: parked.agentId, execution_scope: "",
            provider_session_id: PROVIDER_SESSION, task_ids: ["bash-1"] }],
          activeTaskIds: [active.id],
        });
        harness.close();
        const byId = new Map(rows(opened.store, parked.chatId).map((row) => [row.task_id, row]));
        expect(byId.get("bash-1")).toMatchObject({ status: "running", lane_state: "parked" });
        expect(byId.get("bash-gone")).toMatchObject({ status: "stopped", stop_reason: "daemon_restart", lane_state: "closed" });
        expect(rows(opened.store, chat.id)[0]).toMatchObject({ task_id: "bash-a", status: "running", lane_state: "in_attempt" });

        // A restarted daemon counts revisions from 1 again and may reuse a task id.
        expect(snapshotFor(parked, 1, [laneTask(parked, { task_id: "bash-gone", started_at: "2026-10-16T05:00:00.000Z" })])).toBe(1);
        expect(rows(opened.store, parked.chatId).find((row) => row.task_id === "bash-gone")).toMatchObject({ status: "running" });

        // A daemon without the cap keeps nothing a parked lane would own.
        const old = await daemonHarness(opened.store, parked, { caps: ["offer"], activeTaskIds: [] });
        old.close();
        expect(rows(opened.store, parked.chatId).every((row) => row.status === "stopped")).toBe(true);
        expect(rows(opened.store, chat.id)[0]).toMatchObject({ status: "stopped", stop_reason: "daemon_restart" });
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("sweeps offline runtimes to unknown and keeps ended rows 7 days, at most 50 per session", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        snapshotFor(world, 1, [laneTask(world)]);
        const now = Date.now();
        opened.db.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?",
          [new Date(now - 11 * 60_000).toISOString(), world.runtimeId]);
        expect(opened.store.sweepBackgroundTasks(now)).toEqual({ unknown: 1, deleted: 0 });
        expect(rows(opened.store, world.chatId)[0]).toMatchObject({ status: "unknown" });
        expect(opened.store.listSessionBackgroundTasks(world.chatId).running).toBe(0);
        expect(opened.store.sweepBackgroundTasks(now)).toEqual({ unknown: 0, deleted: 0 });

        // 55 ended tasks: the newest 50 stay.
        const ended = Array.from({ length: 55 }, (_, index) => laneTask(world, { task_id: `done-${String(index).padStart(2, "0")}`,
          status: "completed", ended_at: new Date(Date.UTC(2026, 9, 16, 2, index)).toISOString() }));
        for (let index = 0; index < ended.length; index += 25) snapshotFor(world, 10 + index, ended.slice(index, index + 25));
        const kept = (opened.db.query(`SELECT task_id FROM multiremi_background_tasks WHERE session_id = ?
          AND status = 'completed' ORDER BY task_id`).all(world.chatId) as Array<{ task_id: string }>).map((row) => row.task_id);
        expect(kept).toHaveLength(50);
        expect(kept[0]).toBe("done-05");
        // The read lists the alive rows and the latest 20 ended ones.
        const listed = opened.store.listSessionBackgroundTasks(world.chatId).rows;
        expect(listed).toHaveLength(21);
        expect(listed[1]!.task_id).toBe("done-54");
        // Past 7 days an ended row is deleted.
        opened.db.run("UPDATE multiremi_background_tasks SET ended_at = ? WHERE task_id = 'done-54'",
          [new Date(now - 8 * 24 * 60 * 60_000).toISOString()]);
        expect(opened.store.sweepBackgroundTasks(now).deleted).toBe(1);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("tells only the Chat's creator, never daemon delivery, and counts running tasks on the session list", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        const user = store.getOrCreateUser({ externalId: "bg-registry-creator", name: "Creator" });
        store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
        const otherUser = store.getOrCreateUser({ externalId: "bg-registry-other", name: "Other" });
        store.createWorkspaceMember({ userId: otherUser.id, name: otherUser.name, role: "admin" });
        const world = backgroundWorld(store, { creatorId: user.id });
        const listen = events(store);
        snapshotFor(world, 1, [laneTask(world), laneTask(world, { task_id: "bash-2", status: "paused" }),
          laneTask(world, { task_id: "bash-3", status: "failed", ended_at: "2026-10-16T01:01:00.000Z" })]);
        await Bun.sleep(0);
        const event = listen.of("chat:background_tasks").at(-1)!;
        listen.off();
        expect(event.payload.running).toBe(2);

        // Routed to the creator's sockets only.
        const delivered: Array<{ user: string; frame: any }> = [];
        const client = (userId: string) => ({ data: { kind: "browser", authenticated: true, userId, workspaceId: "local" },
          sendText(text: string) { delivered.push({ user: userId, frame: JSON.parse(text) }); }, close() {} });
        notifyBrowserWorkspaceEvent(new Map([["local", new Set([client(otherUser.id)]) as never]]),
          new Map([[user.id, new Set([client(user.id)]) as never], [otherUser.id, new Set([client(otherUser.id)]) as never]]),
          event as never, { store });
        expect(delivered.map((entry) => entry.user)).toEqual([user.id]);
        expect(delivered[0]!.frame).toMatchObject({ type: "chat:background_tasks", payload: { session_id: world.chatId, running: 2 } });
        // It wakes no downlink and no offer.
        let woke = 0;
        wakeDaemonWorkspaceEvent(event as never, {
          downlinks: { kick: () => { woke++; }, kickWorkspace: () => { woke++; } } as never,
          offers: { kick: () => { woke++; }, kickWorkspace: () => { woke++; } } as never,
          runtimeWorkspace: () => "local",
        });
        expect(woke).toBe(0);

        const pat = await store.createAccessToken({ name: "Creator", type: "pat", userId: user.id, workspaceId: "local" });
        const otherPat = await store.createAccessToken({ name: "Other", type: "pat", userId: otherUser.id, workspaceId: "local" });
        const app = createMultiremiApp({ store, authToken: "bg-registry-master" });
        const get = async (path: string, token = pat.token) => {
          const response = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
          return { status: response.status, body: await response.json() as any };
        };
        const list = await get("/api/chat/sessions");
        expect(list.status).toBe(200);
        expect(list.body.find((session: any) => session.id === world.chatId)).toMatchObject({ running_background_tasks: 2 });
        expect((await get(`/api/chat/sessions/${world.chatId}`)).body).toMatchObject({ running_background_tasks: 2 });
        const read = await get(`/api/chat/sessions/${world.chatId}/background-tasks`);
        expect(read.status).toBe(200);
        expect(read.body.session_id).toBe(world.chatId);
        expect(read.body.running).toBe(2);
        expect(read.body.rows.map((row: any) => row.task_id).sort()).toEqual(["bash-1", "bash-2", "bash-3"]);
        expect(Object.keys(read.body.rows[0]).sort()).toEqual(["agent_id", "can_stop", "command", "created_at", "duration_ms",
          "ended_at", "execution_scope", "id", "lane_state", "name", "origin_attempt_id", "origin_item_id", "origin_turn_id",
          "output_tail", "output_unreadable", "parked_until", "provider_session_id", "runtime_id", "session_id", "started_at", "status", "stop_outcome",
          "stop_reason", "stop_requested_at", "stop_requested_by", "summary", "task_id", "task_type", "updated_at", "usage",
          "workspace_id"]);
        // Another member cannot read it.
        expect((await get(`/api/chat/sessions/${world.chatId}/background-tasks`, otherPat.token)).status).toBe(403);
      } finally { await opened.close(); }
    }, TIMEOUT);
  });
}

describe("lane.background negotiation", () => {
  it("echoes in welcome only the hello caps this server supports", () => {
    expect(negotiateWelcomeCaps(["offer", "turn.message", "lane.background", "lane.background"])).toEqual(["lane.background"]);
    expect(negotiateWelcomeCaps(["offer", "wiki.fetch"])).toEqual([]);
    expect(negotiateWelcomeCaps(["lane.background"], [])).toEqual([]);
  });

  it("reads hello parked lanes forgivingly and keeps an absent list absent", () => {
    expect(parseParkedLanes([
      { session_id: "chat_a", agent_id: "agt_a", execution_scope: "", provider_session_id: "sess-a", task_ids: ["t1", 2, "", "t2"] },
      { session_id: "chat_b", agent_id: "agt_b", provider_session_id: "sess-b", task_ids: [] },
      "nonsense",
      { session_id: "chat_c", agent_id: "agt_c", execution_scope: "relay:x", provider_session_id: "sess-c" },
    ])).toEqual([
      { session_id: "chat_a", agent_id: "agt_a", execution_scope: "", provider_session_id: "sess-a", task_ids: ["t1", "t2"] },
      { session_id: "chat_c", agent_id: "agt_c", execution_scope: "relay:x", provider_session_id: "sess-c", task_ids: [] },
    ]);
    expect(parseParkedLanes("nope")).toEqual([]);
    const hello = parseDaemonHello({ protocol: 2, daemon_id: "dmn", cli_version: "9.9.9",
      runtimes: [{ runtime_id: "rt_a" }, { runtime_id: "rt_b", parked_lanes: [] }] });
    expect(hello.ok && hello.hello.runtimes.map((runtime) => "parked_lanes" in runtime)).toEqual([false, true]);
  });
});
