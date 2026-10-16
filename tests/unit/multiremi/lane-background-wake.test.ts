/**
 * PR 6 §2.5, §2.6, §9: `lane.background_wake`, the doorbell.
 *
 * A parked Claude task ended. The server writes a platform `status` message
 * to the agent (wake `now`, deduplicated per task, `metadata.background_task`)
 * and the ordinary lane machine decides: a new turn (created), a pending one
 * (merged) or a running one (delivered as a steer). A repeated call answers
 * the first outcome. A closed session or a moved lane is refused with
 * `session_closed` / `lane_moved`. A created turn in a Feishu-bound Chat posts
 * proactively in the origin thread, without a receipt or an @mention, and the
 * doorbell message itself is never mirrored.
 *
 * On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { backgroundDoorbellDedupeKey, readBackgroundDoorbell } from "@shared/background-tasks.js";
import type { DaemonLaneBackgroundWakePayload } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";
import { PROVIDER_SESSION, backgroundWorld, daemonHarness, runAttempt, type BackgroundWorld } from "./background-tasks-fixture.js";

const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("bgwake");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

function wakePayload(world: BackgroundWorld, overrides: Partial<DaemonLaneBackgroundWakePayload["task"]> = {},
  lane: Partial<DaemonLaneBackgroundWakePayload> = {}): DaemonLaneBackgroundWakePayload {
  return {
    session_id: world.chatId, agent_id: world.agentId, execution_scope: "", provider_session_id: PROVIDER_SESSION,
    task: { task_id: "bash-1", name: "npm test", task_type: "shell", status: "completed", origin_attempt_id: world.attemptId,
      summary: "42 passed", duration_ms: 125_000, ...overrides },
    ...lane,
  };
}

function wake(world: BackgroundWorld, overrides: Partial<DaemonLaneBackgroundWakePayload["task"]> = {},
  lane: Partial<DaemonLaneBackgroundWakePayload> = {}) {
  return world.store.laneBackgroundWake(world.runtimeId, "local", wakePayload(world, overrides, lane));
}

function doorbells(store: MultiremiStore, chatId: string) {
  return store.listMessages(chatId, { limit: 1000 }).filter((message) => readBackgroundDoorbell(message.metadata));
}

/** A Feishu-bound Chat whose origin attempt has its `cot` card in thread `omt_bg`. */
function feishuOrigin(db: import("@multiremi/store/db/postgres.js").SqlDatabase, world: BackgroundWorld): void {
  const now = new Date().toISOString();
  db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings (id, workspace_id, app_id, agent_id, external_session_key,
    chat_session_id, chat_id, thread_id, reply_to_message_id, created_at, updated_at)
    VALUES ('fbb_bg', 'local', 'cli_bg', ?, 'oc_bg:omt_bg', ?, 'oc_bg', 'omt_bg', 'om_origin', ?, ?)`, [world.agentId, world.chatId, now, now]);
  db.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries (id, workspace_id, binding_id, task_id, chat_id, thread_id,
    reply_to_message_id, body, status, available_at, created_at, updated_at, mention_snapshot, interaction_open_id, kind)
    VALUES ('fbo_origin', 'local', 'fbb_bg', ?, 'oc_bg', 'omt_bg', 'om_origin', '', 'sent', ?, ?, ?, ?, 'ou_origin', 'cot')`,
  [world.attemptId, now, now, now, JSON.stringify({ mode: "person", openId: "ou_origin", resolvedOpenId: "ou_origin" })]);
}

function laneTurns(store: MultiremiStore, world: BackgroundWorld) {
  return store.listTurns({ workspace_id: "local", session_id: world.chatId });
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`lane.background_wake (${backend.name})`, () => {
    it("writes the doorbell and creates a turn for an idle lane; a repeated call answers the same outcome", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        const reply = wake(world);
        expect(reply).toMatchObject({ ok: true, outcome: "created" });
        const [message] = doorbells(opened.store, world.chatId);
        expect(message).toMatchObject({ sender_type: "platform", sender_id: null, to_agent_id: world.agentId,
          message_kind: "status", wake_requested: "now", wake_applied: "now",
          dedupe_key: backgroundDoorbellDedupeKey({ agent_id: world.agentId, execution_scope: "" }, "bash-1"),
          body_md: "后台任务已结束：npm test（已完成，用时 2 分 5 秒）\n42 passed" });
        expect(readBackgroundDoorbell(message!.metadata)).toEqual({ task_id: "bash-1", name: "npm test", task_type: "shell",
          status: "completed", origin_attempt_id: world.attemptId, origin_turn_id: world.turnId, provider_session_id: PROVIDER_SESSION });
        const turn = opened.store.getTurn(reply.turn_id)!;
        expect(turn).toMatchObject({ status: "pending", agent_id: world.agentId, current_attempt_id: reply.attempt_id });
        expect(opened.db.query("SELECT trigger_message_id FROM multiremi_turns WHERE id = ?").get(reply.turn_id))
          .toEqual({ trigger_message_id: message!.id });
        // The new attempt inherits the Chat's lane: same runtime, same provider session.
        expect(opened.store.getTask(reply.attempt_id!)).toMatchObject({ runtimeId: world.runtimeId, sessionId: PROVIDER_SESSION });

        expect(wake(world)).toEqual(reply);
        expect(doorbells(opened.store, world.chatId)).toHaveLength(1);
        expect(laneTurns(opened.store, world).filter((row) => row.status === "pending")).toHaveLength(1);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("merges into a pending turn, and two ends close together share one turn", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        const user = opened.store.sendChatMessage(world.chatId, { body: "and check the logs" }).task;
        const pendingTurn = opened.store.getTurnForAttempt(user.id)!;
        expect(wake(world)).toMatchObject({ ok: true, outcome: "merged", turn_id: pendingTurn.id, attempt_id: user.id });
        expect(wake(world, { task_id: "bash-2", name: "lint", status: "failed", summary: null, duration_ms: 4_000 }))
          .toMatchObject({ ok: true, outcome: "merged", turn_id: pendingTurn.id });
        expect(doorbells(opened.store, world.chatId).map((message) => message.body_md)).toEqual([
          "后台任务已结束：npm test（已完成，用时 2 分 5 秒）\n42 passed", "后台任务已结束：lint（失败，用时 4 秒）"]);
        expect(laneTurns(opened.store, world).filter((row) => row.status === "pending").map((row) => row.id)).toEqual([pendingTurn.id]);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("delivers to a running turn as a steer, and to a pending turn already offered", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        const first = wake(world);
        expect(first.outcome).toBe("created");
        // The doorbell turn is offered: the next end reaches it as input, not a merge.
        expect(opened.store.claimTask(world.runtimeId)?.id).toBe(first.attempt_id!);
        const taskInput: string[] = [];
        const off = opened.store.onWorkspaceEvent((event) => { if (event.type === "daemon:task_input") taskInput.push(String(event.payload.task_id)); });
        expect(wake(world, { task_id: "bash-2" })).toMatchObject({ ok: true, outcome: "delivered", turn_id: first.turn_id,
          attempt_id: first.attempt_id });
        opened.store.startTask(first.attempt_id!);
        expect(wake(world, { task_id: "bash-3" })).toMatchObject({ ok: true, outcome: "delivered", turn_id: first.turn_id });
        await Bun.sleep(0);
        off();
        expect(taskInput).toEqual([first.attempt_id!, first.attempt_id!]);
        expect(doorbells(opened.store, world.chatId)).toHaveLength(3);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("hands the doorbell's background_task, and no other metadata, to the offer input and to a steer", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        const world = backgroundWorld(store);
        const created = wake(world);
        const doorbell = { task_id: "bash-1", name: "npm test", task_type: "shell", status: "completed" as const,
          origin_attempt_id: world.attemptId, origin_turn_id: world.turnId, provider_session_id: PROVIDER_SESSION };
        const key = (taskId: string) => backgroundDoorbellDedupeKey({ agent_id: world.agentId, execution_scope: "" }, taskId);
        // A person's message merged into the doorbell turn, even one that claims a doorbell, carries only its scope.
        const member = store.findWorkspaceMemberForUser("local", "local")!;
        store.sendMessage({ session_id: world.chatId, sender: { type: "member", id: member.id },
          to: { type: "agent", ref: world.agentId }, message_kind: "request", wake_requested: "now",
          body_md: "and the logs?", metadata: { background_task: doorbell } });
        const bridge = store.getDaemonTurnBridge();
        const offer = bridge.offerInput(store.getTaskWithAgent(created.attempt_id!)!);
        const ring = offer.input_messages.find((message) => message.dedupe_key === key("bash-1"))!;
        expect(ring.metadata).toEqual({ execution_scope: "", background_task: doorbell });
        expect(readBackgroundDoorbell(ring.metadata)).toEqual(doorbell);
        const person = offer.input_messages.find((message) => message.sender_type === "member")!;
        expect(person.metadata).toEqual({ execution_scope: "" });

        // The attempt runs; the next end reaches it as a steer with its own doorbell.
        expect(store.claimTask(world.runtimeId)?.id).toBe(created.attempt_id!);
        store.startTask(created.attempt_id!);
        expect(wake(world, { task_id: "bash-2", status: "failed" }).outcome).toBe("delivered");
        const snapshot = bridge.snapshot({ runtimeId: world.runtimeId, daemonId: world.daemonId, workspaceId: "local" },
          new Set([created.attempt_id!]));
        const steer = snapshot.messages.map((entry) => entry.message).find((message) => message.dedupe_key === key("bash-2"))!;
        expect(steer.metadata).toEqual({ execution_scope: "",
          background_task: { ...doorbell, task_id: "bash-2", status: "failed" } });
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("refuses a closed session and a moved lane, writing nothing", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        const archived = backgroundWorld(store);
        store.updateChatSession(archived.chatId, { status: "archived" });
        expect(() => wake(archived)).toThrow(expect.objectContaining({ code: "session_closed" }));
        expect(doorbells(store, archived.chatId)).toEqual([]);

        const deleted = backgroundWorld(store);
        store.deleteChatSession(deleted.chatId);
        expect(() => wake(deleted)).toThrow(expect.objectContaining({ code: "session_closed" }));

        const agentGone = backgroundWorld(store);
        store.archiveAgent(agentGone.agentId);
        expect(() => wake(agentGone)).toThrow(expect.objectContaining({ code: "session_closed" }));

        const otherSession = backgroundWorld(store);
        expect(() => wake(otherSession, {}, { provider_session_id: "sess-other" }))
          .toThrow(expect.objectContaining({ code: "lane_moved" }));
        expect(doorbells(store, otherSession.chatId)).toEqual([]);

        // A cold retry replaces the lane's provider session.
        const cold = backgroundWorld(store);
        const failed = runAttempt(store, cold.runtimeId, cold.chatId, "try again");
        store.failTask(failed.id, { error: "boom", failureReason: "agent_error", sessionId: PROVIDER_SESSION });
        store.retryTurn(store.getTurnForAttempt(failed.id)!.id, true);
        expect(() => wake(cold)).toThrow(expect.objectContaining({ code: "lane_moved" }));

        // Another runtime cannot ring this lane.
        const intruder = backgroundWorld(store);
        const other = backgroundWorld(store);
        expect(() => store.laneBackgroundWake(other.runtimeId, "local", wakePayload(intruder)))
          .toThrow(expect.objectContaining({ code: "lane_moved" }));
        expect(doorbells(store, intruder.chatId)).toEqual([]);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("answers the RPC through the protocol only with the cap, and validates the frame", async () => {
      const opened = await backend.open();
      try {
        const world = backgroundWorld(opened.store);
        const harness = await daemonHarness(opened.store, world);
        try {
          expect(await harness.call("lane.background_wake", { ...wakePayload(world), task: { ...wakePayload(world).task, status: "stopped" } }))
            .toMatchObject({ ok: false, code: "invalid_report" });
          expect(await harness.call("lane.background_wake", wakePayload(world) as never, { rt: "rt_unknown" }))
            .toMatchObject({ ok: false, code: "authority_revoked" });
          const reply = await harness.call("lane.background_wake", wakePayload(world) as never);
          expect(reply).toMatchObject({ ok: true, outcome: "created" });
          expect(harness.kicks).toEqual([world.runtimeId]);
          expect(await harness.call("lane.background_wake", wakePayload(world, { task_id: "bash-x" }, { provider_session_id: "sess-other" }) as never))
            .toMatchObject({ ok: false, code: "lane_moved", retryable: false });
        } finally { harness.close(); }
        const old = await daemonHarness(opened.store, world, { welcomeCaps: [] });
        try {
          expect(await old.call("lane.background_wake", wakePayload(world, { task_id: "bash-9" }) as never))
            .toMatchObject({ ok: false, code: "invalid_report" });
          expect(doorbells(opened.store, world.chatId)).toHaveLength(1);
        } finally { old.close(); }
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("never creates a Feishu outbound delivery, mirror or @mention for the doorbell message itself", async () => {
      const opened = await backend.open();
      try {
        const { store, db } = opened;
        const world = backgroundWorld(store);
        feishuOrigin(db, world);
        // A user turn is pending: the doorbell merges, so no new turn and no card of its own.
        store.sendChatMessage(world.chatId, { body: "and then?" });
        const tables = ["multiremi_feishu_bot_outbound_deliveries", "multiremi_feishu_bot_deliveries",
          "multiremi_feishu_bot_outbound_operations"] as const;
        const counts = () => tables.map((table) => Number((db.query(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${table}`).get() as { n: number }).n));
        const before = counts();
        expect(wake(world).outcome).toBe("merged");
        expect(counts()).toEqual(before);
        const [doorbell] = doorbells(store, world.chatId);
        expect(doorbell).toMatchObject({ sender_type: "platform", message_kind: "status", to_member_id: null });
        expect(db.query(`SELECT 1 FROM multiremi_feishu_bot_outbound_deliveries WHERE body LIKE ? OR target_message_id = ?`)
          .get("%后台任务已结束%", doorbell!.id)).toBeNull();
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("posts a created turn proactively in the origin's Feishu thread; the doorbell itself is never mirrored", async () => {
      const opened = await backend.open();
      try {
        const { store, db } = opened;
        const world = backgroundWorld(store);
        feishuOrigin(db, world);
        const outbound = () => db.query(`SELECT * FROM multiremi_feishu_bot_outbound_deliveries ORDER BY created_at, id`).all() as Array<Record<string, any>>;
        const inbound = () => Number((db.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_feishu_bot_deliveries").get() as { n: number }).n);
        const inboundBefore = inbound();

        const reply = wake(world);
        expect(reply.outcome).toBe("created");
        const rows = outbound();
        expect(rows).toHaveLength(2);
        const card = rows.find((row) => row.task_id === reply.attempt_id)!;
        expect(card).toMatchObject({ binding_id: "fbb_bg", chat_id: "oc_bg", thread_id: "omt_bg", reply_to_message_id: "om_origin",
          kind: "cot", status: "pending", body: "", interaction_open_id: "ou_origin", presentation_checkpoint: null });
        // No @mention and no receipt: the card is proactive.
        expect(JSON.parse(card.mention_snapshot)).toEqual({ mode: "none", resolvedOpenId: null });
        expect(inbound()).toBe(inboundBefore);
        // The doorbell message is a platform status: no outbound row names it.
        const [doorbell] = doorbells(store, world.chatId);
        expect(rows.some((row) => [row.target_message_id, row.resume_message_id].includes(doorbell!.id))).toBe(false);

        // A merged or delivered doorbell adds no card: the turn already has one.
        expect(wake(world, { task_id: "bash-2" }).outcome).toBe("merged");
        expect(wake(world)).toEqual(reply);
        expect(outbound()).toHaveLength(2);

        // A Chat without a Feishu origin card posts nothing.
        const web = backgroundWorld(store);
        expect(wake(web).outcome).toBe("created");
        expect(outbound()).toHaveLength(2);
      } finally { await opened.close(); }
    }, TIMEOUT);
  });
}
