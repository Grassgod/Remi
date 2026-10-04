import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers } from "@multiremi/api/daemon-protocol/task-offers.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const database = `mul419_offers_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!adminUrl)("A-3 task offers on real PostgreSQL", () => {
  let admin: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let serial = 0;
  beforeAll(async () => {
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
    const url = new URL(adminUrl!); url.pathname = `/${database}`;
    db = new PostgresSyncDatabase(url.toString());
    store = new MultiremiStore(db); store.ensureLocalWorkspace();
  });
  afterAll(async () => {
    db?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });
  function fixture(prepare?: (task: { id: string; prompt: string }) => Promise<Record<string, unknown>>) {
    const id = `rt_pg_offer_${++serial}`;
    store.registerRuntime({ id, name: id, daemonId: id, provider: "claude", workspaceId: "local", status: "online", maxConcurrency: 1,
      metadata: { parallel_agent_execution: 1 } });
    const agent = store.createAgent({ name: id, runtimeId: id, provider: "claude", workspaceId: "local" });
    const clock = new ManualDaemonProtocolClock(Date.now());
    const layer = new DaemonProtocolLayer({ store });
    const offers = new DaemonTaskOffers({ store, layer, clock, prepare: prepare ?? (async task => ({ id: task.id, prompt: task.prompt })) });
    const frames: Record<string, any>[] = [];
    const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} }, { masterToken: true, accessToken: null });
    const send = async (t: string, p: unknown, fields = {}) => { await session.handleMessage(JSON.stringify({ v: 2, t, p, ...fields })); await layer.drain(); };
    const hello = () => send("hello", { protocol: 2, daemon_id: id, cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer"],
      runtimes: [{ runtime_id: id, provider: "claude", max_concurrency: 1, active_task_ids: [] }] });
    const close = async () => { layer.closeAll(); layer.stop(); await layer.drain(); };
    return { id, agentId: agent.id, clock, layer, session, offers, frames, send, hello, close,
      task: (prompt = "no-op") => store.createTask({ agentId: agent.id, prompt, maxAttempts: 1 }) };
  }
  it("migrates both timestamp columns and holds accepted dispatches until disconnect", async () => {
    const h = fixture();
    try {
      const columns = db.query("PRAGMA table_info(multiremi_tasks)").all().map(row => row.name);
      expect(columns).toContain("offered_at"); expect(columns).toContain("accepted_at");
      const task = h.task(); await h.hello();
      const offer = h.frames.find(frame => frame.t === "task.offer")!;
      await h.send("res", { ok: true }, { re: String(offer.seq), ack: offer.seq });
      expect(store.getTask(task.id)?.offeredAt).toBeString(); expect(store.getTask(task.id)?.acceptedAt).toBeString();
      db.run("UPDATE multiremi_tasks SET dispatched_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [task.id]);
      expect(store.claimTask(h.id)).toBeNull();
      h.session.handleSocketClose();
      expect(store.claimTask(h.id)?.id).toBe(task.id);
    } finally { await h.close(); }
  });
  it("requeues a rejected entity and dispatches it only after the 30s cooldown", async () => {
    const h = fixture();
    try {
      const task = h.task(); await h.hello();
      const offer = h.frames.find(frame => frame.t === "task.offer")!;
      await h.send("res", { ok: false, code: "capacity" }, { re: String(offer.seq), ack: offer.seq });
      expect(store.getTask(task.id)).toMatchObject({ status: "queued", offeredAt: null, acceptedAt: null });
      h.clock.advance(29_999); await h.layer.drain();
      expect(h.frames.filter(frame => frame.t === "task.offer")).toHaveLength(1);
      h.clock.advance(1); await h.layer.drain();
      expect(h.frames.filter(frame => frame.t === "task.offer").map(frame => frame.p.id)).toEqual([task.id, task.id]);
    } finally { await h.close(); }
  });
  it("shapes an oversized offer and then dispatches the next PostgreSQL queue row", async () => {
    const h = fixture();
    try {
      const huge = h.task("x".repeat(1_048_576)); const next = h.task(); await h.hello();
      const first = h.frames.find(frame => frame.t === "task.offer")!;
      expect(first.p.id).toBe(huge.id);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(512 * 1024);
      expect(store.getTask(huge.id)).toMatchObject({ status: "dispatched", failureReason: null });
      await h.send("res", { ok: true }, { re: String(first.seq), ack: first.seq });
      store.startTask(huge.id); store.completeTask(huge.id, { output: "done" });
      h.offers.kick(); await h.layer.drain();
      expect(h.frames.filter(frame => frame.t === "task.offer").map(frame => frame.p.id)).toEqual([huge.id, next.id]);
    } finally { await h.close(); }
  });
  it("reports irreducible PostgreSQL offers once and continues without blocking the Issue", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: task.prompt,
      repos: task.prompt === "structure" ? new Array(600_000).fill(0) : [] }));
    try {
      const issue = store.createIssue({ title: "PG structural size" });
      const huge = store.createTask({ agentId: h.agentId, issueId: issue.id, prompt: "structure", maxAttempts: 3 });
      const next = h.task(); await h.hello();
      expect(store.getTask(huge.id)).toMatchObject({ status: "failed", failureReason: "offer_too_large" });
      expect(store.getTask(huge.id)!.error).toContain("parts=repos:");
      expect(store.getIssue(issue.id)!.status).not.toBe("blocked");
      expect(h.frames.filter(frame => frame.t === "task.offer").map(frame => frame.p.id)).toEqual([next.id]);
    } finally { await h.close(); }
  });
  it("persists independent per-agent unread high-water and partial-page offsets on PostgreSQL", async () => {
    const h = fixture();
    try {
      const other = store.createAgent({ name: `Other reader ${serial}`, provider: "claude" });
      const issue = store.createIssue({ title: "PG unread state" });
      const session = store.getOrCreateDefaultIssueSession(issue.id);
      store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "x".repeat(70_000) });
      expect(store.getSessionAgentReadProgress(session.id, h.agentId)).toEqual({ seq: 0, offset: 0 });
      store.recordSessionAgentRangeRead(session.id, h.agentId, { seq: 1, offset: 0 }, { seq: 1, offset: 32_000 });
      expect(store.getSessionAgentReadProgress(session.id, h.agentId)).toEqual({ seq: 0, offset: 32_000 });
      store.recordSessionAgentRangeRead(session.id, other.id, { seq: 1, offset: 0 }, { seq: 2, offset: 0 });
      store.recordSessionAgentRangeRead(session.id, h.agentId, { seq: 1, offset: 32_000 }, { seq: 2, offset: 0 });
      expect(store.getSessionAgentReadProgress(session.id, h.agentId)).toEqual({ seq: 1, offset: 0 });
      expect(store.getSessionAgentReadProgress(session.id, other.id)).toEqual({ seq: 1, offset: 0 });
    } finally { await h.close(); }
  });
});
