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
  function fixture() {
    const id = `rt_pg_offer_${++serial}`;
    store.registerRuntime({ id, name: id, daemonId: id, provider: "claude", workspaceId: "local", status: "online", maxConcurrency: 1 });
    const agent = store.createAgent({ name: id, runtimeId: id, provider: "claude", workspaceId: "local" });
    const clock = new ManualDaemonProtocolClock(Date.now());
    const layer = new DaemonProtocolLayer({ store });
    const offers = new DaemonTaskOffers({ store, layer, clock, prepare: async task => ({ id: task.id, prompt: task.prompt }) });
    const frames: Record<string, any>[] = [];
    const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return text.length; }, close() {} }, { masterToken: true, accessToken: null });
    const send = async (t: string, p: unknown, fields = {}) => { await session.handleMessage(JSON.stringify({ v: 2, t, p, ...fields })); await layer.drain(); };
    const hello = () => send("hello", { protocol: 2, daemon_id: id, cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer"],
      runtimes: [{ runtime_id: id, provider: "claude", max_concurrency: 1, active_task_ids: [] }] });
    const close = async () => { layer.closeAll(); layer.stop(); await layer.drain(); };
    return { id, clock, layer, session, offers, frames, send, hello, close,
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
  it("fails an oversized offer and continues with the next PostgreSQL queue row", async () => {
    const h = fixture();
    try {
      const huge = h.task("x".repeat(1_048_576)); const next = h.task(); await h.hello();
      expect(store.getTask(huge.id)).toMatchObject({ status: "failed", error: "task.offer exceeds the 1 MiB daemon protocol frame limit" });
      expect(h.frames.filter(frame => frame.t === "task.offer").map(frame => frame.p.id)).toEqual([next.id]);
    } finally { await h.close(); }
  });
});
