/**
 * PR 6 §6: `POST /api/chat/sessions/:id/background-tasks/stop`.
 *
 * Only the Chat's creator may stop. `{task_id}` stops one running task (by its
 * bridge `task_id` or registry `id`), `{all: true}` every one. The rows take
 * the request with a pending outcome and the member who asked, the runtime's
 * downlinks are woken (`daemon:task_input`), and the creator hears
 * `chat:background_tasks`. 409 `task_not_running` when nothing matching runs,
 * 409 `runtime_offline` when its computer is offline, 400 for a body that is
 * neither.
 *
 * On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";
import { backgroundWorld, laneTask, snapshotFor } from "./background-tasks-fixture.js";

const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("bgstop");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

async function scaffold(store: MultiremiStore) {
  const user = store.getOrCreateUser({ externalId: "bg-stop-creator", name: "Creator" });
  const member = store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
  const otherUser = store.getOrCreateUser({ externalId: "bg-stop-other", name: "Other" });
  store.createWorkspaceMember({ userId: otherUser.id, name: otherUser.name, role: "admin" });
  const world = backgroundWorld(store, { creatorId: user.id });
  const pat = await store.createAccessToken({ name: "Creator", type: "pat", userId: user.id, workspaceId: "local" });
  const otherPat = await store.createAccessToken({ name: "Other", type: "pat", userId: otherUser.id, workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "bg-stop-master" });
  const stop = async (body: unknown, token = pat.token, chatId = world.chatId) => {
    const response = await app.request(`/api/chat/sessions/${chatId}/background-tasks/stop`, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { world, member, pat, otherPat, stop };
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`background-task stop route (${backend.name})`, () => {
    it("lets the creator stop one task or all, wakes the runtime and tells the creator", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        const f = await scaffold(store);
        snapshotFor(f.world, 1, [laneTask(f.world), laneTask(f.world, { task_id: "bash-2" }),
          laneTask(f.world, { task_id: "bash-3", status: "paused" })]);
        const seen: Array<{ type: string; payload: Record<string, any> }> = [];
        const off = store.onWorkspaceEvent((event) => seen.push(event));
        const one = await f.stop({ task_id: "bash-1" });
        expect(one.status).toBe(202);
        expect(one.body.rows).toHaveLength(1);
        expect(one.body.rows[0]).toMatchObject({ task_id: "bash-1", status: "running", stop_requested_at: one.body.requested_at,
          stop_requested_by: f.member.id, stop_outcome: "pending" });
        await Bun.sleep(0);
        expect(seen.filter((event) => event.type === "daemon:task_input").map((event) => event.payload))
          .toEqual([{ runtime_id: f.world.runtimeId }]);
        expect(seen.find((event) => event.type === "chat:background_tasks")?.payload).toMatchObject({ session_id: f.world.chatId, running: 3 });

        // By registry id, and then all of them (paused ones too).
        const row = store.listSessionBackgroundTasks(f.world.chatId).rows.find((entry) => entry.task_id === "bash-2")!;
        expect((await f.stop({ task_id: row.id })).body.rows.map((entry: any) => entry.task_id)).toEqual(["bash-2"]);
        const all = await f.stop({ all: true });
        expect(all.status).toBe(202);
        expect(all.body.rows.map((entry: any) => entry.task_id).sort()).toEqual(["bash-1", "bash-2", "bash-3"]);
        expect(all.body.rows.every((entry: any) => entry.stop_requested_at === all.body.requested_at)).toBe(true);
        off();
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("refuses another member, a bad body, a task that is not running and an offline computer", async () => {
      const opened = await backend.open();
      try {
        const { store, db } = opened;
        const f = await scaffold(store);
        snapshotFor(f.world, 1, [laneTask(f.world), laneTask(f.world, { task_id: "done", status: "completed",
          ended_at: "2026-10-16T01:01:00.000Z" }), laneTask(f.world, { task_id: "pinned", can_stop: false })]);
        expect((await f.stop({ task_id: "bash-1" }, f.otherPat.token)).status).toBe(403);
        expect((await f.stop({ all: true }, f.pat.token, "chat_missing")).status).toBe(404);
        for (const body of [{}, { task_id: "bash-1", all: true }, { task_id: "" }, { all: "yes" }, { task_id: 7 }]) {
          expect((await f.stop(body)).body).toMatchObject({ code: "invalid_request" });
        }
        for (const taskId of ["done", "missing", "pinned"]) {
          const refused = await f.stop({ task_id: taskId });
          expect(refused.status).toBe(409);
          expect(refused.body.code).toBe("task_not_running");
        }
        // Nothing was marked by the refusals.
        expect(store.listSessionBackgroundTasks(f.world.chatId).rows.every((row) => row.stop_requested_at === null)).toBe(true);

        db.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?",
          [new Date(Date.now() - 10 * 60_000).toISOString(), f.world.runtimeId]);
        const offline = await f.stop({ task_id: "bash-1" });
        expect(offline.status).toBe(409);
        expect(offline.body.code).toBe("runtime_offline");
        expect((await f.stop({ all: true })).body.code).toBe("runtime_offline");
        expect(store.listSessionBackgroundTasks(f.world.chatId).rows.every((row) => row.stop_requested_at === null)).toBe(true);
        // Once nothing runs there is nothing to stop.
        db.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", [new Date().toISOString(), f.world.runtimeId]);
        snapshotFor(f.world, 2, [], { state: "closed", parked_until: null });
        expect((await f.stop({ all: true })).body.code).toBe("task_not_running");
      } finally { await opened.close(); }
    }, TIMEOUT);
  });
}
