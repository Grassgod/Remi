/**
 * ADR 0025: the agent's command catalogue on the server.
 *
 * - `turn.complete` / `task.fail` may carry `available_commands`; the terminal
 *   transaction keeps it on the attempt's agent lane
 *   (`multiremi_session_lanes.available_commands`). Absent (an older daemon),
 *   null or malformed leaves the stored one alone and never fails the report;
 *   an empty list is stored; an older attempt never overwrites a newer one.
 * - `GET /api/chat/slash-commands` answers `session`, `preview` (the requesting
 *   user's own latest Chat with the agent on the same provider and Runtime) or
 *   `none`, with the blocked and hidden commands taken out, and the same
 *   access rules as reading the Chat.
 * - The migration ships the column on a fresh schema and adds it once to an
 *   upgraded one.
 *
 * On SQLite and Postgres.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { DAEMON_MIN_CLI_VERSION, type DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import type { ChatSlashCommandsResponse, SlashCommandCatalogue } from "@multiremi/contracts/slash-commands.js";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { LANE_SLASH_COMMANDS_MIGRATION, recordLaneSlashCommandsWithinTransaction } from "@multiremi/store/slash-commands.js";
import { traceBackfillBackends } from "./trace-backfill-backends.js";
import { backgroundWorld, runAttempt, type BackgroundWorld } from "./background-tasks-fixture.js";

const TIMEOUT = 60_000;
const backends = await traceBackfillBackends("slashcmds");

afterAll(async () => {
  for (const backend of backends) await backend.dispose();
});

const FIELDS: DaemonTaskCompletionFields = {
  trace: { head: 3, event_count: 3, closed: true, tool_call_count: 0, type_histogram: [{ type: "text", tool: null, count: 1 }] },
  final_reply_md: "done",
  model: { provider: "claude", model: "claude-sonnet-5" },
  context_usage: null,
  worked_ms: null,
  process_item_count: 0,
};

const CATALOGUE: SlashCommandCatalogue = {
  provider: "claude",
  reported_at: "2026-10-20T08:00:00.000Z",
  commands: [
    { name: "compact", description: "Free up context", hint: "<instructions>", kind: "command" },
    // Blocked and hidden for Claude: stored as reported, never listed.
    { name: "model", description: "Set the AI model", hint: "<model>", kind: "command" },
    { name: "rename", description: "Rename the conversation", hint: null, kind: "command" },
    { name: "deploy-prod", description: "Deploy", hint: "[service]", kind: "skill", skill_id: "skl_deploy",
      // Keys outside the contract are dropped on the way in.
      skillDir: "/Users/someone/.claude/skills/deploy-prod" } as never,
  ],
};

function laneCatalogue(db: SqlDatabase, world: Pick<BackgroundWorld, "chatId" | "agentId">, chatId = world.chatId): Record<string, any> | null {
  const row = db.query(`SELECT available_commands FROM multiremi_session_lanes
    WHERE session_id = ? AND reader_type = 'agent' AND reader_id = ? AND execution_scope = ''`).get(chatId, world.agentId) as
    { available_commands: string | null } | null;
  return row?.available_commands ? JSON.parse(row.available_commands) : null;
}

/** One reliable report through the daemon protocol layer of a real server. */
async function serverReport(store: MultiremiStore, runtimeId: string, type: string, payload: Record<string, unknown>) {
  let layer: DaemonProtocolLayer | undefined;
  const server = startMultiremiServer({
    store, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port: 0, authToken: "slash-master",
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
      const active = store.listTasksForRuntimeStatuses(runtimeId, ["dispatched", "running"]).map((task) => task.id);
      await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: {
        protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: runtime.daemonId,
        runtimes: [{ runtime_id: runtimeId, provider: runtime.provider, max_concurrency: 4, active_task_ids: active }],
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

/** `turn.complete` for a running Chat attempt, after the offered input receipt. */
function turnComplete(store: MultiremiStore, attemptId: string, extra: Record<string, unknown>) {
  const task = store.getTaskWithAgent(attemptId)!;
  const bridge = store.getDaemonTurnBridge();
  const offer = bridge.offerInput(task);
  store.recordSessionAgentRangeRead(offer.input_messages[0]!.session_id, task.agentId,
    { seq: 1, offset: 0 }, { seq: offer.input_to_seq + 1, offset: 0 });
  expect(bridge.rpc("turn.input", { ...offer, message_ids: offer.input_messages.map((message) => message.id) },
    { runtimeId: task.runtimeId!, daemonId: store.getRuntimeLite(task.runtimeId!)!.daemonId!, workspaceId: task.workspaceId }).ok).toBe(true);
  return { ...FIELDS, ...extra, turn_id: offer.turn_id, attempt_id: attemptId, input_to_seq: offer.input_to_seq,
    reply: { body_md: "done", message_kind: "final" } };
}

async function scaffold(store: MultiremiStore) {
  const user = store.getOrCreateUser({ externalId: "slash-creator", name: "Creator" });
  store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
  const other = store.getOrCreateUser({ externalId: "slash-other", name: "Other" });
  store.createWorkspaceMember({ userId: other.id, name: other.name, role: "member" });
  const world = backgroundWorld(store, { creatorId: user.id });
  const pat = await store.createAccessToken({ name: "Creator", type: "pat", userId: user.id, workspaceId: "local" });
  const otherPat = await store.createAccessToken({ name: "Other", type: "pat", userId: other.id, workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "slash-master" });
  const menu = async (query: string, token = pat.token) => {
    const response = await app.request(`/api/chat/slash-commands?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() as ChatSlashCommandsResponse & { error?: string } };
  };
  return { world, user, other, pat, otherPat, menu };
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`chat slash-command catalogue (${backend.name})`, () => {
    it("ships the lane column on a fresh schema and adds it once to an upgraded one", async () => {
      const opened = await backend.open();
      try {
        const { db } = opened;
        const hasColumn = () => db.dialect === "postgres"
          ? Boolean(db.query(`SELECT 1 FROM information_schema.columns
            WHERE table_name = 'multiremi_session_lanes' AND column_name = 'available_commands'`).get())
          : (db.query("PRAGMA table_info(multiremi_session_lanes)").all() as Array<{ name: string }>)
            .some((column) => column.name === "available_commands");
        const migrationRows = () => Number((db.query("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM multiremi_schema_migrations WHERE id = ?")
          .get(LANE_SLASH_COMMANDS_MIGRATION) as { n: number }).n);
        expect(hasColumn()).toBe(true);
        expect(migrationRows()).toBe(1);
        // The database as a release before ADR 0025 left it.
        db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [LANE_SLASH_COMMANDS_MIGRATION]);
        db.exec("ALTER TABLE multiremi_session_lanes DROP COLUMN available_commands");
        expect(hasColumn()).toBe(false);
        new MultiremiStore(db);
        new MultiremiStore(db);
        expect(hasColumn()).toBe(true);
        expect(migrationRows()).toBe(1);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("keeps a completed turn's catalogue on its lane, and the Chat menu lists what is neither blocked nor hidden", async () => {
      const opened = await backend.open();
      try {
        const { store, db } = opened;
        const f = await scaffold(store);
        expect(laneCatalogue(db, f.world)).toBeNull();
        expect((await f.menu(`session_id=${f.world.chatId}`)).body).toEqual({ state: "none", provider: "claude", reported_at: null, commands: [] });

        const attempt = runAttempt(store, f.world.runtimeId, f.world.chatId, "what can you do?");
        expect(await serverReport(store, f.world.runtimeId, "turn.complete", turnComplete(store, attempt.id, { available_commands: CATALOGUE })))
          .toMatchObject({ ok: true });
        const stored = laneCatalogue(db, f.world)!;
        expect(stored).toMatchObject({ provider: "claude", reported_at: CATALOGUE.reported_at, runtime_id: f.world.runtimeId, attempt_id: attempt.id });
        expect(stored.commands.map((command: { name: string }) => command.name)).toEqual(["compact", "model", "rename", "deploy-prod"]);
        expect(JSON.stringify(stored)).not.toContain("/Users/someone");

        const own = await f.menu(`session_id=${f.world.chatId}`);
        expect(own.status).toBe(200);
        expect(own.body).toEqual({ state: "session", provider: "claude", reported_at: CATALOGUE.reported_at, commands: [
          { name: "compact", description: "Free up context", hint: "<instructions>", kind: "command" },
          { name: "deploy-prod", description: "Deploy", hint: "[service]", kind: "skill", skill_id: "skl_deploy" },
        ] });
        // The agent may be named as well; another agent is refused.
        expect((await f.menu(`session_id=${f.world.chatId}&agent_id=${f.world.agentId}`)).body.state).toBe("session");
        expect((await f.menu(`session_id=${f.world.chatId}&agent_id=agt_other`)).status).toBe(400);
        expect((await f.menu("")).status).toBe(400);
        expect((await f.menu("agent_id=agt_missing")).status).toBe(404);
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("leaves the stored catalogue to an older daemon's or a malformed report, stores an empty list, and never lets an older attempt win", async () => {
      const opened = await backend.open();
      try {
        const { store, db } = opened;
        const f = await scaffold(store);
        const first = runAttempt(store, f.world.runtimeId, f.world.chatId, "one");
        await serverReport(store, f.world.runtimeId, "turn.complete", turnComplete(store, first.id, { available_commands: CATALOGUE }));
        const kept = laneCatalogue(db, f.world);

        // An older daemon sends no field; a malformed one is dropped. Both reports still end the attempt.
        const second = runAttempt(store, f.world.runtimeId, f.world.chatId, "two");
        expect(await serverReport(store, f.world.runtimeId, "task.fail", { task_id: second.id, error: "boom", ...FIELDS }))
          .toMatchObject({ ok: true });
        expect(store.getTask(second.id)?.status).toBe("failed");
        expect(laneCatalogue(db, f.world)).toEqual(kept);
        const third = runAttempt(store, f.world.runtimeId, f.world.chatId, "three");
        expect(await serverReport(store, f.world.runtimeId, "task.fail", { task_id: third.id, error: "boom", ...FIELDS,
          available_commands: { provider: "claude", reported_at: "not a date", commands: [] } })).toMatchObject({ ok: true });
        expect(store.getTask(third.id)?.status).toBe("failed");
        expect(laneCatalogue(db, f.world)).toEqual(kept);

        // An agent that advertises nothing: an empty list, which is not "never reported".
        await Bun.sleep(5);
        const fourth = runAttempt(store, f.world.runtimeId, f.world.chatId, "four");
        await serverReport(store, f.world.runtimeId, "task.fail", { task_id: fourth.id, error: "boom", ...FIELDS,
          available_commands: { provider: "claude", reported_at: "2026-10-20T09:00:00.000Z", commands: [] } });
        expect(laneCatalogue(db, f.world)).toMatchObject({ attempt_id: fourth.id, commands: [] });
        expect((await f.menu(`session_id=${f.world.chatId}`)).body).toEqual({ state: "session", provider: "claude",
          reported_at: "2026-10-20T09:00:00.000Z", commands: [] });

        // A late report of an older attempt does not overwrite the newer catalogue; the same attempt may write again.
        expect(db.transaction(() => recordLaneSlashCommandsWithinTransaction(db, first.id, CATALOGUE))()).toBe(false);
        expect(laneCatalogue(db, f.world)).toMatchObject({ attempt_id: fourth.id, commands: [] });
        expect(db.transaction(() => recordLaneSlashCommandsWithinTransaction(db, fourth.id, CATALOGUE))()).toBe(true);
        expect(laneCatalogue(db, f.world)).toMatchObject({ attempt_id: fourth.id });
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("previews the requesting user's own latest Chat with the agent, on the same provider and Runtime only", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        const f = await scaffold(store);
        const attempt = runAttempt(store, f.world.runtimeId, f.world.chatId, "list your commands");
        await serverReport(store, f.world.runtimeId, "turn.complete", turnComplete(store, attempt.id, { available_commands: CATALOGUE }));

        // A Chat not created yet, and a new Chat that has not finished a turn: the creator's earlier Chat.
        const fresh = await f.menu(`agent_id=${f.world.agentId}`);
        expect(fresh.body).toMatchObject({ state: "preview", provider: "claude", reported_at: CATALOGUE.reported_at });
        expect(fresh.body.commands.map((command) => command.name)).toEqual(["compact", "deploy-prod"]);
        const second = store.createChatSession({ agentId: f.world.agentId, workspaceId: "local", creatorId: f.user.id });
        expect((await f.menu(`session_id=${second.id}`)).body.state).toBe("preview");

        // Another member never sees it: not as a preview, not through the creator's Chat.
        expect((await f.menu(`agent_id=${f.world.agentId}`, f.otherPat.token)).body)
          .toEqual({ state: "none", provider: "claude", reported_at: null, commands: [] });
        expect((await f.menu(`session_id=${f.world.chatId}`, f.otherPat.token)).status).toBe(403);

        // The agent moves to another Runtime: no preview from the old one; the Chat's own list still answers.
        const elsewhere = store.registerRuntime({ daemonId: "slash-elsewhere", name: "Elsewhere", provider: "claude", workspaceId: "local" });
        store.updateAgent(f.world.agentId, { runtimeId: elsewhere.id });
        expect((await f.menu(`agent_id=${f.world.agentId}`)).body.state).toBe("none");
        expect((await f.menu(`session_id=${f.world.chatId}`)).body.state).toBe("session");
        // Another provider: the stored Claude list answers nothing.
        const codexRuntime = store.registerRuntime({ daemonId: "slash-codex", name: "Codex host", provider: "codex", workspaceId: "local" });
        store.updateAgent(f.world.agentId, { provider: "codex", runtimeId: codexRuntime.id });
        expect((await f.menu(`session_id=${f.world.chatId}`)).body).toEqual({ state: "none", provider: "codex", reported_at: null, commands: [] });
      } finally { await opened.close(); }
    }, TIMEOUT);

    it("refuses an agent the member may not chat with", async () => {
      const opened = await backend.open();
      try {
        const { store } = opened;
        const f = await scaffold(store);
        const owner = store.getOrCreateUser({ externalId: "slash-owner", name: "Owner" });
        store.createWorkspaceMember({ userId: owner.id, name: owner.name, role: "member" });
        const secret = store.createAgent({ name: "Private agent", provider: "claude", workspaceId: "local", visibility: "private",
          ownerId: owner.id });
        expect((await f.menu(`agent_id=${secret.id}`)).status).toBe(403);
        // Its owner may ask.
        const ownerPat = await store.createAccessToken({ name: "Owner", type: "pat", userId: owner.id, workspaceId: "local" });
        expect((await f.menu(`agent_id=${secret.id}`, ownerPat.token)).body.state).toBe("none");
      } finally { await opened.close(); }
    }, TIMEOUT);
  });
}
