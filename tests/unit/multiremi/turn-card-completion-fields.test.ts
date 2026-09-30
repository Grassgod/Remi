/**
 * MUL-432 segment 2 item 5: the live `turn` card takes the round-card fields
 * of a daemon's `task.complete` / `task.fail` frame through A's seam, wired in
 * the real server's terminal transaction. Only `trace.event_count`, `tool_call_count`,
 * `type_histogram` and `model` are written (ruling (z)); the frame's
 * `final_reply_md` is not, so the chat card keeps its assistant message and the
 * Issue card its `final_entry_id`. The card stays the one persisted at reply
 * completion (B1 deviation B). A daemon that sends no fields writes nothing and
 * fails nothing. A card write failure rolls back the terminal transition and
 * the daemon can replay the report. On SQLite and Postgres.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { DAEMON_MIN_CLI_VERSION, type DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import type { ConversationLogEntry, ConversationLogPatch } from "@multiremi/contracts/conversation-log.js";
import { startMultiremiServer } from "@multiremi/api.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { traceBackfillBackends, type OpenedStore } from "./trace-backfill-backends.js";

const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("cardfields");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

const FIELDS: DaemonTaskCompletionFields = {
  trace: {
    head: 5,
    event_count: 5,
    closed: true,
    tool_call_count: 2,
    type_histogram: [
      { type: "text", tool: null, count: 1 },
      { type: "tool_use", tool: "Bash", count: 2 },
      { type: "tool_result", tool: "Bash", count: 2 },
    ],
  },
  final_reply_md: "FRAME REPLY, not for the card",
  model: { provider: "claude", model: "claude-sonnet-5" },
};

const CARD_FIELDS = {
  event_count: 5,
  tool_call_count: 2,
  type_histogram: FIELDS.trace.type_histogram,
  model: FIELDS.model,
};

/**
 * Send one report frame through the daemon protocol layer of a real server
 * (`startMultiremiServer`), so the seam runs through the server's own wiring.
 */
async function serverReport(store: MultiremiStore, runtimeId: string, type: string, payload: Record<string, unknown>) {
  let layer: DaemonProtocolLayer | undefined;
  const server = startMultiremiServer({
    store, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port: 0, authToken: "fixture-master",
    onDaemonProtocol: (created) => { layer = created; },
  });
  try {
    const frames: Array<Record<string, any>> = [];
    const session = layer!.openSession({
      get bufferedAmount() { return 0; },
      send(text) { frames.push(JSON.parse(text)); return Buffer.byteLength(text); },
      close() {},
    }, { accessToken: null, masterToken: true });
    try {
      const runtime = store.getRuntimeLite(runtimeId)!;
      // Every task the daemon still runs, so the hello does not treat a
      // sibling as lost.
      const active = store.listTasksForRuntimeStatuses(runtimeId, ["dispatched", "running"]).map((task) => task.id);
      await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
        protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: runtime.daemonId ?? "fixture-reports",
        runtimes: [{ runtime_id: runtimeId, provider: runtime.provider, max_concurrency: 1, active_task_ids: active }],
      } }));
      await session.handleMessage(JSON.stringify({ v: 2, t: type, seq: 1, rt: runtimeId, p: payload }));
      const reply = frames.find((frame) => frame.t === "res" && frame.re === "1");
      if (!reply) throw new Error(`No res for ${type}: ${JSON.stringify(frames)}`);
      return reply.p as Record<string, unknown>;
    } finally {
      session.handleSocketClose();
    }
  } finally {
    await layer?.drain();
    server.stop(true);
  }
}

interface World {
  opened: OpenedStore;
  store: MultiremiStore;
  db: SqlDatabase;
  runtimeId: string;
  agentId: string;
}

async function withWorld(backend: (typeof backends)[number], body: (world: World) => Promise<void>) {
  const opened = await backend.open();
  try {
    const { store } = opened;
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ name: "Card daemon", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Card agent", provider: "claude", workspaceId: "local", runtimeId: runtime.id });
    await body({ opened, store, db: opened.db, runtimeId: runtime.id, agentId: agent.id });
  } finally {
    await opened.close();
  }
}

function runIssueTask(world: World, title: string, agentId = world.agentId, runtimeId = world.runtimeId) {
  const issue = world.store.createIssue({ title, workspaceId: "local" });
  const task = world.store.createTask({ agentId, workspaceId: "local", issueId: issue.id, prompt: title });
  expect(world.store.claimTask(runtimeId)?.id).toBe(task.id);
  world.store.startTask(task.id);
  return task;
}

function card(world: World, taskId: string): ConversationLogEntry {
  const entry = world.store.findTurnEntry(taskId);
  expect(entry).not.toBeNull();
  return entry!;
}

/** The four frame fields are absent from a card no daemon filled. */
function expectNoFrameFields(entry: ConversationLogEntry) {
  for (const key of Object.keys(CARD_FIELDS)) expect(entry.metadata[key] ?? null).toBeNull();
}

/**
 * Record the seam's card writes: the patches the conversation-log write hook
 * sees for `taskId`'s card, whether each ran inside a transaction, and the
 * `transaction()` depth when each card write starts.
 */
function watchSeam(world: World) {
  const patches: Array<{ patch: ConversationLogPatch; inTransaction: boolean }> = [];
  world.store.setConversationLogListener({
    onEntry: (_session, payload) => {
      if ("target_seq" in payload) patches.push({ patch: payload, inTransaction: Boolean(world.db.inTransaction) });
    },
  });
  const target = world.db as unknown as { transaction: (fn: (...args: never[]) => unknown) => (...args: unknown[]) => unknown };
  const original = target.transaction;
  let depth = 0;
  target.transaction = (fn) => {
    const run = original.call(target, fn);
    return (...args: unknown[]) => {
      depth += 1;
      try {
        return run(...args);
      } finally {
        depth -= 1;
      }
    };
  };
  const calls: Array<{ taskId: string; fields: unknown; changed: boolean; depth: number }> = [];
  const record = world.store.recordTurnCardCompletionFieldsWithinTransaction.bind(world.store);
  const spy = spyOn(world.store, "recordTurnCardCompletionFieldsWithinTransaction").mockImplementation((taskId, fields) => {
    const changed = record(taskId, fields);
    calls.push({ taskId, fields, changed, depth });
    return changed;
  });
  return {
    patches,
    calls,
    restore() {
      spy.mockRestore();
      delete (target as Partial<typeof target>).transaction;
      world.store.setConversationLogListener(null);
    },
  };
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`live turn card fields from the terminal frame (${backend.name})`, () => {
    it("task.complete with the fields writes the four onto the Issue card and keeps final_entry_id", async () => {
      await withWorld(backend, async (world) => {
        const task = runIssueTask(world, "Card issue");
        const before = card(world, task.id);
        const seam = watchSeam(world);
        try {
          const reply = await serverReport(world.store, world.runtimeId, "task.complete",
            { task_id: task.id, output: "issue answer", ...FIELDS });
          expect(reply.ok).toBe(true);
        } finally {
          seam.restore();
        }
        expect(world.store.getTask(task.id)?.status).toBe("completed");
        const after = card(world, task.id);
        expect({ id: after.id, seq: after.seq, session: after.session_id })
          .toEqual({ id: before.id, seq: before.seq, session: before.session_id });
        expect(after.metadata).toMatchObject({ ...CARD_FIELDS, status: "completed" });
        expect(after.metadata.final_reply_md ?? null).toBeNull();
        const reply = world.store.getConversationLogEntryById(String(after.metadata.final_entry_id));
        expect(reply).toMatchObject({ task_id: task.id, body_md: "issue answer" });

        // One card write in the terminal transaction, before the reply comment.
        expect(seam.calls).toEqual([{ taskId: task.id, fields: FIELDS, changed: true, depth: 1 }]);
        const fieldPatch = seam.patches.find(({ patch }) => patch.target_seq === after.seq
          && patch.fields.metadata?.event_count === CARD_FIELDS.event_count)!;
        expect(fieldPatch.inTransaction).toBe(true);
        expect(fieldPatch.patch.fields.metadata).toMatchObject(CARD_FIELDS);

        // A replayed frame is absorbed by the terminal state and rewrites nothing.
        const replay = await serverReport(world.store, world.runtimeId, "task.complete",
          { task_id: task.id, output: "issue answer", ...FIELDS });
        expect(replay.ok).toBe(true);
        expect(card(world, task.id).revision).toBe(after.revision);
        expect(card(world, task.id).revision).toBe(after.revision);
      });
    }, TIMEOUT);

    it("task.complete with the fields writes the four onto the chat card persisted at reply completion", async () => {
      await withWorld(backend, async (world) => {
        const chat = world.store.createChatSession({ agentId: world.agentId, workspaceId: "local", creatorId: "local" });
        const sent = world.store.sendChatMessage(chat.id, { content: "hello" });
        expect(world.store.claimTask(world.runtimeId)?.id).toBe(sent.task.id);
        world.store.startTask(sent.task.id);
        expect(world.store.findTurnEntry(sent.task.id)).toBeNull();
        const seam = watchSeam(world);
        try {
          const reply = await serverReport(world.store, world.runtimeId, "task.complete",
            { task_id: sent.task.id, output: "chat answer", ...FIELDS });
          expect(reply.ok).toBe(true);
        } finally {
          seam.restore();
        }
        const message = world.store.listChatMessages(chat.id).find((row) => row.taskId === sent.task.id && row.role === "assistant")!;
        const after = card(world, sent.task.id);
        // B1 deviation B: the card is the assistant message's row, created when
        // the reply landed; the seam updated it in place.
        expect({ id: after.id, session: after.session_id }).toEqual({ id: message.id, session: chat.id });
        expect(world.store.listConversationLogEntries(chat.id).filter((row) => row.task_id === sent.task.id && row.kind === "turn"))
          .toHaveLength(1);
        expect(after.metadata).toMatchObject({ ...CARD_FIELDS, status: "completed", final_reply_md: "chat answer" });
        expect(seam.calls).toEqual([{ taskId: sent.task.id, fields: FIELDS, changed: true, depth: 1 }]);
      });
    }, TIMEOUT);

    it("task.fail with the fields writes the four onto the card", async () => {
      await withWorld(backend, async (world) => {
        const task = runIssueTask(world, "Card failure");
        const reply = await serverReport(world.store, world.runtimeId, "task.fail",
          { task_id: task.id, error: "boom", ...FIELDS });
        expect(reply.ok).toBe(true);
        expect(world.store.getTask(task.id)?.status).toBe("failed");
        const after = card(world, task.id);
        expect(after.metadata).toMatchObject({ ...CARD_FIELDS, status: "failed" });
        expect(after.metadata.final_reply_md ?? null).toBeNull();
      });
    }, TIMEOUT);

    it("completes a one-shot task without a turn card", async () => {
      await withWorld(backend, async (world) => {
        const task = world.store.createTask({ agentId: world.agentId, workspaceId: "local", prompt: "One-shot" });
        expect(world.store.claimTask(world.runtimeId)?.id).toBe(task.id);
        world.store.startTask(task.id);
        expect(world.store.findTurnEntry(task.id)).toBeNull();
        const reply = await serverReport(world.store, world.runtimeId, "task.complete",
          { task_id: task.id, output: "done", ...FIELDS });
        expect(reply).toEqual({ ok: true });
        expect(world.store.getTask(task.id)?.status).toBe("completed");
        expect(world.store.findTurnEntry(task.id)).toBeNull();
      });
    }, TIMEOUT);

    it("an old daemon without the fields writes nothing, reports no error and changes nothing else", async () => {
      await withWorld(backend, async (world) => {
        // The twin runs on its own runtime and Agent: this fixture's runtime
        // claims one task.
        const twinRuntime = world.store.registerRuntime({ name: "Twin daemon", provider: "claude", workspaceId: "local" });
        const twin = world.store.createAgent({ name: "Twin agent", provider: "claude", workspaceId: "local", runtimeId: twinRuntime.id });
        const seam = watchSeam(world);
        let old: ConversationLogEntry;
        let current: ConversationLogEntry;
        try {
          const oldTask = runIssueTask(world, "Old daemon");
          const newTask = runIssueTask(world, "New daemon", twin.id, twinRuntime.id);
          const oldReply = await serverReport(world.store, world.runtimeId, "task.complete",
            { task_id: oldTask.id, output: "old answer" });
          expect(oldReply).toEqual({ ok: true });
          expect(world.store.getTask(oldTask.id)?.status).toBe("completed");
          expect(world.store.getTaskTrace(oldTask.id)).toMatchObject({ location: "daemon", runtimeId: world.runtimeId });
          old = card(world, oldTask.id);
          expectNoFrameFields(old);
          expect(old.metadata.status).toBe("completed");
          expect(world.store.getConversationLogEntryById(String(old.metadata.final_entry_id)))
            .toMatchObject({ body_md: "old answer" });
          expect(seam.calls).toEqual([{ taskId: oldTask.id, fields: null, changed: false, depth: 1 }]);

          // The same path with the fields differs by exactly the seam's one write.
          await serverReport(world.store, twinRuntime.id, "task.complete",
            { task_id: newTask.id, output: "new answer", ...FIELDS });
          current = card(world, newTask.id);
        } finally {
          seam.restore();
        }
        expect(current.revision).toBe(old.revision + 1);
      });
    }, TIMEOUT);

    it.each(["task.complete", "task.fail"])("a failed %s card write rolls back and replays with all four fields", async (type) => {
      await withWorld(backend, async (world) => {
        const task = runIssueTask(world, "Card write failure");
        const before = card(world, task.id);
        const write = spyOn(world.store, "recordTurnCardCompletionFieldsWithinTransaction").mockImplementation(() => {
          throw new Error("injected card write failure");
        });
        try {
          const reply = await serverReport(world.store, world.runtimeId, type,
            { task_id: task.id, output: "answer", error: "failed", ...FIELDS });
          expect(reply).toMatchObject({ ok: false, code: "server_error", retryable: true });
          expect(write).toHaveBeenCalledTimes(1);
        } finally {
          write.mockRestore();
        }
        expect(world.store.getTask(task.id)?.status).toBe("running");
        expect(card(world, task.id).revision).toBe(before.revision);
        expectNoFrameFields(card(world, task.id));
        const replay = await serverReport(world.store, world.runtimeId, type,
          { task_id: task.id, output: "answer", error: "failed", ...FIELDS });
        expect(replay).toEqual({ ok: true });
        expect(world.store.getTask(task.id)?.status).toBe(type === "task.complete" ? "completed" : "failed");
        expect(card(world, task.id).metadata).toMatchObject(CARD_FIELDS);
      });
    }, TIMEOUT);
  });
}
